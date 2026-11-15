package runner

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/gray0128/agent-hub/internal/api"
	"github.com/gray0128/agent-hub/internal/config"
)

func TestReadLinesBoundedHandlesOver128KB(t *testing.T) {
	huge := strings.Repeat("a", 256*1024)
	input := "short-1\n" + huge + "\nshort-2\n"
	var lines []string
	err := ReadLinesBounded(strings.NewReader(input), func(line []byte) {
		lines = append(lines, string(line))
	})
	if err != nil {
		t.Fatalf("ReadLinesBounded failed: %v", err)
	}
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines, got %d", len(lines))
	}
	if lines[0] != "short-1" || len(lines[1]) != 256*1024 || lines[2] != "short-2" {
		t.Fatalf("unexpected line lengths: %d, %d, %d", len(lines[0]), len(lines[1]), len(lines[2]))
	}
}

func TestBuildCommandSpecAdapters(t *testing.T) {
	sess := "sess-123"

	bin, args, stdinPrompt, err := BuildCommandSpec(api.RunRecord{
		Agent:           "codex",
		Model:           "gpt-5",
		Effort:          "high",
		Prompt:          "hello via stdin",
		NativeSessionID: &sess,
	}, config.AgentConfig{Command: "codex"})
	if err != nil {
		t.Fatalf("codex spec err: %v", err)
	}
	if bin != "codex" || stdinPrompt != "hello via stdin" {
		t.Fatalf("unexpected codex bin=%q stdin=%q", bin, stdinPrompt)
	}
	joined := strings.Join(args, " ")
	if joined != `exec resume --json -m gpt-5 -c model_reasoning_effort="high" sess-123 -` {
		t.Fatalf("expected codex resume syntax with reasoning effort, got %q", joined)
	}

	_, freshCodexArgs, _, err := BuildCommandSpec(api.RunRecord{
		Agent:   "codex",
		Model:   "gpt-5.6-sol",
		Effort:  "ultra",
		Sandbox: true,
		Prompt:  "run ultra",
	}, config.AgentConfig{Command: "codex"})
	if err != nil {
		t.Fatalf("codex fresh spec err: %v", err)
	}
	if strings.Join(freshCodexArgs, " ") != `exec --json -m gpt-5.6-sol -c model_reasoning_effort="ultra" -s workspace-write -` {
		t.Fatalf("unexpected fresh codex ultra args: %v", freshCodexArgs)
	}

	_, overrideCodexArgs, _, err := BuildCommandSpec(api.RunRecord{
		Agent:  "codex",
		Model:  "gpt-5",
		Effort: "high",
		Prompt: "override",
	}, config.AgentConfig{Command: "codex", Args: []string{"-c", "model_reasoning_effort=low"}})
	if err != nil {
		t.Fatalf("codex override spec err: %v", err)
	}
	if strings.Count(strings.Join(overrideCodexArgs, " "), "model_reasoning_effort") != 1 {
		t.Fatalf("expected agentCfg.Args override to suppress duplicate model_reasoning_effort, got %v", overrideCodexArgs)
	}

	_, autoCodexArgs, _, err := BuildCommandSpec(api.RunRecord{
		Agent:  "codex",
		Model:  "gpt-5",
		Effort: "auto",
		Prompt: "auto effort",
	}, config.AgentConfig{Command: "codex"})
	if err != nil {
		t.Fatalf("codex auto spec err: %v", err)
	}
	if strings.Contains(strings.Join(autoCodexArgs, " "), "model_reasoning_effort") {
		t.Fatalf("expected auto effort to omit -c model_reasoning_effort, got %v", autoCodexArgs)
	}

	_, agyArgs, agyStdin, err := BuildCommandSpec(api.RunRecord{
		Agent:  "agy",
		Model:  "carbon",
		Effort: "high",
		Prompt: "do task",
	}, config.AgentConfig{Command: "agy"})
	if err != nil {
		t.Fatalf("agy spec err: %v", err)
	}
	if agyStdin != "" {
		t.Fatalf("expected empty stdin for agy")
	}
	if len(agyArgs) < 3 || agyArgs[0] != "--output-format" || agyArgs[1] != "json" {
		t.Fatalf("expected agy args to start with --output-format json, got %v", agyArgs)
	}
	for _, a := range agyArgs {
		if a == "-p" {
			t.Fatalf("unexpected standalone -p flag in agy args: %v", agyArgs)
		}
	}
	agyJoined := strings.Join(agyArgs, " ")
	if !strings.Contains(agyJoined, "--model gemini-4-carbon-high") {
		t.Fatalf("unexpected agy args: %q", agyJoined)
	}
	if agyArgs[len(agyArgs)-1] != "-p=do task" {
		t.Fatalf("expected agy prompt flag -p=do task at end, got %q", agyArgs[len(agyArgs)-1])
	}

	_, dashArgs, _, err := BuildCommandSpec(api.RunRecord{
		Agent:   "agy",
		Model:   "flash",
		Effort:  "low",
		Sandbox: true,
		Prompt:  "- inspect repo",
	}, config.AgentConfig{Command: "agy"})
	if err != nil {
		t.Fatalf("agy dash prompt err: %v", err)
	}
	if !strings.Contains(strings.Join(dashArgs, " "), "--sandbox") {
		t.Fatalf("expected --sandbox in agy dash prompt args: %v", dashArgs)
	}
	if dashArgs[len(dashArgs)-1] != "-p=- inspect repo" {
		t.Fatalf("expected final arg -p=- inspect repo, got %q", dashArgs[len(dashArgs)-1])
	}

	_, orchArgs, _, err := BuildCommandSpec(api.RunRecord{
		Agent:  "agy",
		Model:  "gemini-pro-orchestrator",
		Effort: "high",
		Prompt: "plan",
	}, config.AgentConfig{Command: "agy"})
	if err != nil {
		t.Fatalf("agy orchestrator err: %v", err)
	}
	orchJoined := strings.Join(orchArgs, " ")
	if !strings.Contains(orchJoined, "--model gemini-pro-orchestrator") {
		t.Fatalf("expected orchestrator model unmodified, got %q", orchJoined)
	}
	if strings.Contains(orchJoined, "--effort") || strings.Contains(orchJoined, "-high") {
		t.Fatalf("expected orchestrator to omit suffix and --effort flag, got %q", orchJoined)
	}
}

func writeFakeAgyScript(t *testing.T, dir string, sentinelPath string, modePath string) string {
	t.Helper()
	scriptPath := filepath.Join(dir, "fake-agy")
	script := `#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "remote-control" && "${2:-}" == "start" ]]; then
  echo "start_invoked" > "` + sentinelPath + `"
  exit 99
fi
mode="$(cat "` + modePath + `" 2>/dev/null || echo "running")"
if [[ "${1:-}" == "remote-control" && "${2:-}" == "status" ]]; then
  case "$mode" in
    running)
      printf 'Daemon state = running\nDaemon pid = 4442\nInstance name: macmini (find it at https://antigravity.google.com)\n'
      exit 0
      ;;
    not_running_with_url)
      printf 'Daemon state = not running\nInstance name: macmini (find it at https://antigravity.google.com)\n'
      exit 0
      ;;
    exit_err)
      echo "not signed in" >&2
      exit 1
      ;;
    no_url)
      printf 'Daemon state = running\nDaemon pid = 4442\n'
      exit 0
      ;;
  esac
fi
printf '{"type":"approval_needed"}\n'
printf '{"status":"NEEDS_HUMAN_APPROVAL"}\n'
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake-agy failed: %v", err)
	}
	return scriptPath
}

func TestProbeRemoteControlURLNeverCallsStart(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script test skipped on windows")
	}
	tmpDir := t.TempDir()
	sentinel := filepath.Join(tmpDir, "start-called.sentinel")
	modeFile := filepath.Join(tmpDir, "mode.txt")
	healthFile := filepath.Join(tmpDir, "auth-health.json")
	fakeBin := writeFakeAgyScript(t, tmpDir, sentinel, modeFile)
	agentCfg := config.AgentConfig{Command: fakeBin}
	ctx := context.Background()

	// 1. Healthy running daemon strips trailing ')' from URL
	if err := os.WriteFile(modeFile, []byte("running"), 0o600); err != nil {
		t.Fatal(err)
	}
	url, reason := probeRemoteControlURLWithHealthPath(ctx, agentCfg, healthFile)
	if url != "https://antigravity.google.com" || reason != "" {
		t.Fatalf("expected clean URL and empty reason, got url=%q reason=%q", url, reason)
	}

	// 2. 'not running' output containing static '(find it at https://...)' must NOT return stale URL or call start
	if err := os.WriteFile(modeFile, []byte("not_running_with_url"), 0o600); err != nil {
		t.Fatal(err)
	}
	url, reason = probeRemoteControlURLWithHealthPath(ctx, agentCfg, healthFile)
	if url != "" || reason != "daemon_not_running" {
		t.Fatalf("expected empty URL and daemon_not_running, got url=%q reason=%q", url, reason)
	}

	// 3. Non-zero exit from status must NOT call start
	if err := os.WriteFile(modeFile, []byte("exit_err"), 0o600); err != nil {
		t.Fatal(err)
	}
	url, reason = probeRemoteControlURLWithHealthPath(ctx, agentCfg, healthFile)
	if url != "" || reason != "daemon_not_running" {
		t.Fatalf("expected daemon_not_running on non-zero exit, got url=%q reason=%q", url, reason)
	}

	// 4. Circuit breaker OPEN short-circuits before invoking status/start
	if err := os.WriteFile(modeFile, []byte("running"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(healthFile, []byte(`{"status":"unhealthy","circuit_state":"OPEN","remaining_seconds":3600}`), 0o600); err != nil {
		t.Fatal(err)
	}
	url, reason = probeRemoteControlURLWithHealthPath(ctx, agentCfg, healthFile)
	if url != "" || reason != "auth_circuit_open" {
		t.Fatalf("expected auth_circuit_open, got url=%q reason=%q", url, reason)
	}

	// 5. Expired token snapshot short-circuits
	if err := os.WriteFile(healthFile, []byte(`{"status":"expired","circuit_state":"CLOSED","remaining_seconds":-120}`), 0o600); err != nil {
		t.Fatal(err)
	}
	url, reason = probeRemoteControlURLWithHealthPath(ctx, agentCfg, healthFile)
	if url != "" || reason != "oauth_token_expired" {
		t.Fatalf("expected oauth_token_expired, got url=%q reason=%q", url, reason)
	}

	// 6. Zombie unauthenticated daemon snapshot short-circuits
	if err := os.WriteFile(healthFile, []byte(`{"status":"degraded","circuit_state":"CLOSED","remaining_seconds":3000,"zombie_unauthenticated_detected":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	url, reason = probeRemoteControlURLWithHealthPath(ctx, agentCfg, healthFile)
	if url != "" || reason != "daemon_auth_lost" {
		t.Fatalf("expected daemon_auth_lost, got url=%q reason=%q", url, reason)
	}

	if _, err := os.Stat(sentinel); !os.IsNotExist(err) {
		t.Fatalf("CRITICAL: agy remote-control start was invoked (sentinel exists)")
	}
}

func TestExecuteRunApprovalNeededReadOnlyDegradation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script test skipped on windows")
	}
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)
	sentinel := filepath.Join(tmpDir, "start-called.sentinel")
	modeFile := filepath.Join(tmpDir, "mode.txt")
	if err := os.WriteFile(modeFile, []byte("not_running_with_url"), 0o600); err != nil {
		t.Fatal(err)
	}
	fakeBin := writeFakeAgyScript(t, tmpDir, sentinel, modeFile)

	var events []struct {
		kind    string
		payload map[string]interface{}
	}
	res := ExecuteRun(
		context.Background(),
		api.RunRecord{
			ID:         "run_test123",
			Agent:      "agy",
			Workdir:    tmpDir,
			Prompt:     "test approval",
			TimeoutSec: 15,
		},
		&config.NodeConfig{HubURL: "https://ahub.bobocai.win"},
		config.AgentConfig{Command: fakeBin},
		Callbacks{
			OnEvent: func(kind string, payload map[string]interface{}) {
				events = append(events, struct {
					kind    string
					payload map[string]interface{}
				}{kind: kind, payload: payload})
			},
		},
	)

	if res.Status != "needs_approval" {
		t.Fatalf("expected status needs_approval, got %q (err=%s)", res.Status, res.ErrorMessage)
	}
	if res.RemoteControlURL != "" {
		t.Fatalf("expected empty RemoteControlURL when daemon not running, got %q", res.RemoteControlURL)
	}
	if !strings.Contains(res.Summary, "remote-control unavailable: daemon_not_running") {
		t.Fatalf("expected diagnostic summary, got %q", res.Summary)
	}
	foundSystem := false
	foundApproval := false
	for _, ev := range events {
		if ev.kind == "system" && ev.payload["stage"] == "remote_control_unavailable" && ev.payload["reason"] == "daemon_not_running" {
			foundSystem = true
		}
		if ev.kind == "approval_needed" && ev.payload["remote_control_available"] == false && ev.payload["reason"] == "daemon_not_running" {
			foundApproval = true
		}
	}
	if !foundSystem || !foundApproval {
		t.Fatalf("expected both system and approval_needed degradation events, got %+v", events)
	}
	if _, err := os.Stat(sentinel); !os.IsNotExist(err) {
		t.Fatalf("CRITICAL: ExecuteRun invoked remote-control start")
	}
}
