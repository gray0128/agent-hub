package runner

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gray0128/agent-hub/internal/api"
	"github.com/gray0128/agent-hub/internal/config"
)

func TestExecuteRunResultFileEnvIsolationAndCleanup(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script test skipped on windows")
	}
	t.Setenv("AHUB_TOKEN", "ahub_adm_must_not_leak")
	t.Setenv("AHUB_RESULT_FILE", "/tmp/parent-result-must-be-ignored.json")

	tmpDir := t.TempDir()
	workdir := filepath.Join(tmpDir, "repo")
	if err := os.MkdirAll(workdir, 0o755); err != nil {
		t.Fatal(err)
	}
	captureFile := filepath.Join(tmpDir, "observed.txt")
	bin := filepath.Join(tmpDir, "fake-claude.sh")
	script := `#!/usr/bin/env bash
set -euo pipefail
RF="${AHUB_RESULT_FILE:-}"
TOK="${AHUB_TOKEN:-}"
PRE_EXISTS="no"
if [[ -e "$RF" ]]; then
  PRE_EXISTS="yes"
fi
DIR_MODE="$(stat -f '%Lp' "$(dirname "$RF")" 2>/dev/null || stat -c '%a' "$(dirname "$RF")")"
printf 'RF=%s\nTOK=%s\nPRE=%s\nMODE=%s\n' "$RF" "$TOK" "$PRE_EXISTS" "$DIR_MODE" > "` + captureFile + `"
printf '{"ok":true,"count":9007199254740993}\n' > "$RF"
printf '{"type":"result","session_id":"sess_rf_1","result":"completed"}\n'
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	res := ExecuteRun(context.Background(), api.RunRecord{
		ID:         "run_rf_1",
		ThreadID:   "thr_rf_1",
		RootRunID:  "run_rf_1",
		Agent:      "claude",
		Workdir:    workdir,
		Prompt:     "produce result",
		TimeoutSec: 30,
	}, &config.NodeConfig{HubURL: "https://ahub.bobocai.win"}, config.AgentConfig{Enabled: true, Command: bin}, Callbacks{})

	if res.Status != "done" || res.ResultError != "" {
		t.Fatalf("expected done with no ResultError, got status=%q err=%q resErr=%q", res.Status, res.ErrorMessage, res.ResultError)
	}
	if string(res.StructuredResult) != `{"ok":true,"count":9007199254740993}` {
		t.Fatalf("unexpected StructuredResult: %s", string(res.StructuredResult))
	}

	rawObs, err := os.ReadFile(captureFile)
	if err != nil {
		t.Fatal(err)
	}
	obs := string(rawObs)
	var observedRF string
	for _, line := range strings.Split(strings.TrimSpace(obs), "\n") {
		if strings.HasPrefix(line, "RF=") {
			observedRF = strings.TrimPrefix(line, "RF=")
		}
		if line == "TOK=ahub_adm_must_not_leak" {
			t.Fatalf("AHUB_TOKEN leaked into child env: %s", obs)
		}
	}
	if observedRF == "" || observedRF == "/tmp/parent-result-must-be-ignored.json" || !strings.Contains(observedRF, "ahub-result-") {
		t.Fatalf("unexpected AHUB_RESULT_FILE: %q (obs=%s)", observedRF, obs)
	}
	if !strings.Contains(obs, "PRE=no") {
		t.Fatalf("result.json must not be pre-created before child runs: %s", obs)
	}
	if !strings.Contains(obs, "MODE=700") {
		t.Fatalf("expected 0700 temp dir mode, got: %s", obs)
	}
	if _, err := os.Stat(filepath.Dir(observedRF)); !os.IsNotExist(err) {
		t.Fatalf("expected temp dir %s to be deleted after ExecuteRun, stat err=%v", filepath.Dir(observedRF), err)
	}
}

func TestExecuteRunResultFileValidAndInvalidPayloads(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script test skipped on windows")
	}

	maxValid := `"` + strings.Repeat("a", MaxResultFileBytes-2) + `"`
	if len(maxValid) != MaxResultFileBytes {
		t.Fatalf("expected maxValid=%d bytes, got %d", MaxResultFileBytes, len(maxValid))
	}
	overSize := `"` + strings.Repeat("a", MaxResultFileBytes-1) + `"`

	cases := []struct {
		name           string
		setupCmd       string
		wantStructured string
		wantResErrSub  string
	}{
		{
			name:           "absent_file",
			setupCmd:       `:`,
			wantStructured: "",
			wantResErrSub:  "",
		},
		{
			name:           "valid_null",
			setupCmd:       `printf 'null\n' > "$AHUB_RESULT_FILE"`,
			wantStructured: "null",
		},
		{
			name:           "valid_array_pretty",
			setupCmd:       "printf '[ 1 , \"two\" , false ]\n' > \"$AHUB_RESULT_FILE\"",
			wantStructured: `[1,"two",false]`,
		},
		{
			name:           "exact_65536_bytes",
			setupCmd:       `python3 -c 'import os,sys; open(os.environ["AHUB_RESULT_FILE"],"wb").write(b"\"" + b"a"*65534 + b"\"")'`,
			wantStructured: maxValid,
		},
		{
			name:          "oversize_65537_bytes",
			setupCmd:      `python3 -c 'import os; open(os.environ["AHUB_RESULT_FILE"],"wb").write(b"\"" + b"a"*65535 + b"\"")'`,
			wantResErrSub: "exceeds 65536 bytes",
		},
		{
			name:          "empty_file",
			setupCmd:      `: > "$AHUB_RESULT_FILE"`,
			wantResErrSub: "empty",
		},
		{
			name:          "whitespace_only",
			setupCmd:      `printf '   \n\t  ' > "$AHUB_RESULT_FILE"`,
			wantResErrSub: "empty",
		},
		{
			name:          "malformed_json",
			setupCmd:      `printf '{"bad":' > "$AHUB_RESULT_FILE"`,
			wantResErrSub: "invalid JSON",
		},
		{
			name:          "trailing_garbage",
			setupCmd:      `printf '{"a":1} extra' > "$AHUB_RESULT_FILE"`,
			wantResErrSub: "invalid JSON",
		},
		{
			name:          "concatenated_json",
			setupCmd:      `printf '{"a":1}{"b":2}' > "$AHUB_RESULT_FILE"`,
			wantResErrSub: "invalid JSON",
		},
		{
			name:          "invalid_utf8",
			setupCmd:      `printf '"\xff\xfe"' > "$AHUB_RESULT_FILE"`,
			wantResErrSub: "invalid UTF-8",
		},
		{
			name:          "symlink_rejected",
			setupCmd:      `echo '{"ok":true}' > "$AHUB_RESULT_FILE.target" && ln -s "$AHUB_RESULT_FILE.target" "$AHUB_RESULT_FILE"`,
			wantResErrSub: "symlink",
		},
		{
			name:          "directory_rejected",
			setupCmd:      `mkdir "$AHUB_RESULT_FILE"`,
			wantResErrSub: "directory",
		},
	}
	_ = overSize

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tmpDir := t.TempDir()
			workdir := filepath.Join(tmpDir, "repo")
			if err := os.MkdirAll(workdir, 0o755); err != nil {
				t.Fatal(err)
			}
			rfCapture := filepath.Join(tmpDir, "rfpath.txt")
			bin := filepath.Join(tmpDir, "fake-agent.sh")
			script := "#!/usr/bin/env bash\nset -euo pipefail\n" +
				`printf '%s' "$AHUB_RESULT_FILE" > "` + rfCapture + `"` + "\n" +
				tc.setupCmd + "\n" +
				`printf '{"type":"result","result":"ok"}\n'` + "\n"
			if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
				t.Fatal(err)
			}

			res := ExecuteRun(context.Background(), api.RunRecord{
				ID:         "run_rf_" + tc.name,
				ThreadID:   "thr_rf",
				RootRunID:  "run_rf_" + tc.name,
				Agent:      "claude",
				Workdir:    workdir,
				Prompt:     "test",
				TimeoutSec: 30,
			}, &config.NodeConfig{}, config.AgentConfig{Enabled: true, Command: bin}, Callbacks{})

			if res.Status != "done" {
				t.Fatalf("expected status done, got %q (%s)", res.Status, res.ErrorMessage)
			}
			if string(res.StructuredResult) != tc.wantStructured {
				t.Fatalf("StructuredResult = %q, want %q", string(res.StructuredResult), tc.wantStructured)
			}
			if tc.wantResErrSub == "" {
				if res.ResultError != "" {
					t.Fatalf("expected empty ResultError, got %q", res.ResultError)
				}
			} else if !strings.Contains(res.ResultError, tc.wantResErrSub) {
				t.Fatalf("expected ResultError containing %q, got %q", tc.wantResErrSub, res.ResultError)
			}

			rfBytes, err := os.ReadFile(rfCapture)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(filepath.Dir(string(rfBytes))); !os.IsNotExist(err) {
				t.Fatalf("expected temp dir cleaned up after %s", tc.name)
			}
		})
	}
}

func TestExecuteRunResultFileIgnoredAndCleanedOnNonDoneOutcomes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script test skipped on windows")
	}

	t.Run("nonzero_exit", func(t *testing.T) {
		tmpDir := t.TempDir()
		workdir := filepath.Join(tmpDir, "repo")
		_ = os.MkdirAll(workdir, 0o755)
		rfCapture := filepath.Join(tmpDir, "rfpath.txt")
		bin := filepath.Join(tmpDir, "fail.sh")
		script := "#!/usr/bin/env bash\n" +
			`printf '%s' "$AHUB_RESULT_FILE" > "` + rfCapture + `"` + "\n" +
			`printf '{"ignored":true}' > "$AHUB_RESULT_FILE"` + "\n" +
			"exit 2\n"
		_ = os.WriteFile(bin, []byte(script), 0o755)

		res := ExecuteRun(context.Background(), api.RunRecord{
			ID: "run_fail", ThreadID: "thr", RootRunID: "run_fail",
			Agent: "claude", Workdir: workdir, Prompt: "fail", TimeoutSec: 15,
		}, &config.NodeConfig{}, config.AgentConfig{Enabled: true, Command: bin}, Callbacks{})

		if res.Status != "failed" || res.ErrorCode != "AGENT_EXIT_NONZERO" {
			t.Fatalf("expected AGENT_EXIT_NONZERO, got %+v", res)
		}
		if res.StructuredResult != nil || res.ResultError != "" {
			t.Fatalf("expected StructuredResult & ResultError omitted on non-done, got %+v", res)
		}
		rfBytes, _ := os.ReadFile(rfCapture)
		if _, err := os.Stat(filepath.Dir(string(rfBytes))); !os.IsNotExist(err) {
			t.Fatalf("expected temp dir cleaned on non-zero exit")
		}
	})

	t.Run("needs_approval", func(t *testing.T) {
		tmpDir := t.TempDir()
		workdir := filepath.Join(tmpDir, "repo")
		_ = os.MkdirAll(workdir, 0o755)
		rfCapture := filepath.Join(tmpDir, "rfpath.txt")
		bin := filepath.Join(tmpDir, "agy-approval.sh")
		script := "#!/usr/bin/env bash\n" +
			`if [[ "${1:-}" == "remote-control" ]]; then exit 1; fi` + "\n" +
			`printf '%s' "$AHUB_RESULT_FILE" > "` + rfCapture + `"` + "\n" +
			`printf '{"ignored":true}' > "$AHUB_RESULT_FILE"` + "\n" +
			`printf '{"status":"NEEDS_HUMAN_APPROVAL","remote_control_url":"https://ahub.bobocai.win/rc/1"}\n'` + "\n"
		_ = os.WriteFile(bin, []byte(script), 0o755)

		res := ExecuteRun(context.Background(), api.RunRecord{
			ID: "run_app", ThreadID: "thr", RootRunID: "run_app",
			Agent: "agy", Workdir: workdir, Prompt: "approve", TimeoutSec: 15,
		}, &config.NodeConfig{}, config.AgentConfig{Enabled: true, Command: bin}, Callbacks{})

		if res.Status != "needs_approval" {
			t.Fatalf("expected needs_approval, got %+v", res)
		}
		if res.StructuredResult != nil || res.ResultError != "" {
			t.Fatalf("expected no structured result on needs_approval, got %+v", res)
		}
		rfBytes, _ := os.ReadFile(rfCapture)
		if _, err := os.Stat(filepath.Dir(string(rfBytes))); !os.IsNotExist(err) {
			t.Fatalf("expected temp dir cleaned on needs_approval")
		}
	})

	t.Run("hub_abort_cancelled", func(t *testing.T) {
		tmpDir := t.TempDir()
		workdir := filepath.Join(tmpDir, "repo")
		_ = os.MkdirAll(workdir, 0o755)
		rfCapture := filepath.Join(tmpDir, "rfpath.txt")
		wroteSignal := filepath.Join(tmpDir, "wrote.flag")
		bin := filepath.Join(tmpDir, "slow.sh")
		script := "#!/usr/bin/env bash\n" +
			`printf '%s' "$AHUB_RESULT_FILE" > "` + rfCapture + `"` + "\n" +
			`printf '{"ignored":true}' > "$AHUB_RESULT_FILE"` + "\n" +
			`touch "` + wroteSignal + `"` + "\n" +
			"sleep 30\n"
		_ = os.WriteFile(bin, []byte(script), 0o755)

		ctx, cancel := context.WithCancel(context.Background())
		go func() {
			deadline := time.Now().Add(3 * time.Second)
			for time.Now().Before(deadline) {
				if _, err := os.Stat(wroteSignal); err == nil {
					cancel()
					return
				}
				time.Sleep(20 * time.Millisecond)
			}
			cancel()
		}()

		res := ExecuteRun(ctx, api.RunRecord{
			ID: "run_abort", ThreadID: "thr", RootRunID: "run_abort",
			Agent: "claude", Workdir: workdir, Prompt: "slow", TimeoutSec: 30,
		}, &config.NodeConfig{}, config.AgentConfig{Enabled: true, Command: bin}, Callbacks{})

		if res.Status != "cancelled" || res.ErrorCode != "CANCELLED" {
			t.Fatalf("expected CANCELLED, got %+v", res)
		}
		if res.StructuredResult != nil || res.ResultError != "" {
			t.Fatalf("expected no structured result on CANCELLED, got %+v", res)
		}
		rfBytes, _ := os.ReadFile(rfCapture)
		if _, err := os.Stat(filepath.Dir(string(rfBytes))); !os.IsNotExist(err) {
			t.Fatalf("expected temp dir cleaned on CANCELLED")
		}
	})

	t.Run("timeout", func(t *testing.T) {
		tmpDir := t.TempDir()
		workdir := filepath.Join(tmpDir, "repo")
		_ = os.MkdirAll(workdir, 0o755)
		rfCapture := filepath.Join(tmpDir, "rfpath.txt")
		bin := filepath.Join(tmpDir, "timeout.sh")
		script := "#!/usr/bin/env bash\n" +
			`printf '%s' "$AHUB_RESULT_FILE" > "` + rfCapture + `"` + "\n" +
			`printf '{"ignored":true}' > "$AHUB_RESULT_FILE"` + "\n" +
			"sleep 10\n"
		_ = os.WriteFile(bin, []byte(script), 0o755)

		res := ExecuteRun(context.Background(), api.RunRecord{
			ID: "run_to", ThreadID: "thr", RootRunID: "run_to",
			Agent: "claude", Workdir: workdir, Prompt: "timeout", TimeoutSec: 1,
		}, &config.NodeConfig{}, config.AgentConfig{Enabled: true, Command: bin}, Callbacks{})

		if res.Status != "failed" || res.ErrorCode != "RUN_TIMEOUT" {
			t.Fatalf("expected RUN_TIMEOUT, got %+v", res)
		}
		if res.StructuredResult != nil || res.ResultError != "" {
			t.Fatalf("expected no structured result on RUN_TIMEOUT, got %+v", res)
		}
		rfBytes, _ := os.ReadFile(rfCapture)
		if _, err := os.Stat(filepath.Dir(string(rfBytes))); !os.IsNotExist(err) {
			t.Fatalf("expected temp dir cleaned on RUN_TIMEOUT")
		}
	})
}

func TestReadResultFileRejectsInvalidJSONValue(t *testing.T) {
	p := filepath.Join(t.TempDir(), "result.json")
	if err := os.WriteFile(p, []byte(`{"x":`), 0o600); err != nil {
		t.Fatal(err)
	}
	res, errStr := readResultFile(p)
	if res != nil || !strings.Contains(errStr, "invalid JSON") {
		t.Fatalf("expected invalid JSON error, got res=%v err=%q", res, errStr)
	}
	if err := os.WriteFile(p, []byte(`{"x":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	res2, errStr2 := readResultFile(p)
	if errStr2 != "" || !json.Valid(res2) || string(res2) != `{"x":1}` {
		t.Fatalf("expected valid JSON object, got res=%s err=%q", string(res2), errStr2)
	}
}
