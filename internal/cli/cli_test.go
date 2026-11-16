package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/gray0128/agent-hub/internal/api"
)

func TestExtractGlobalFlagsAndFlexibleParse(t *testing.T) {
	g, rest := extractGlobalFlags([]string{"run", "--node", "macmini", "--json", "--token=tok_1", "-"})
	if !g.JSON || g.Token != "tok_1" {
		t.Fatalf("unexpected global opts: %+v", g)
	}
	if len(rest) != 4 || rest[0] != "run" || rest[3] != "-" {
		t.Fatalf("unexpected rest args: %v", rest)
	}

	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	var node string
	var syncMode bool
	fs.StringVar(&node, "node", "", "")
	fs.BoolVar(&syncMode, "sync", false, "")
	if err := parseFlagsFlexible(fs, []string{"--node", "macmini", "hello", "--sync"}, map[string]bool{"--node": true}); err != nil {
		t.Fatalf("parseFlagsFlexible failed: %v", err)
	}
	if node != "macmini" || !syncMode || fs.Arg(0) != "hello" {
		t.Fatalf("unexpected parsed flags: node=%q sync=%v args=%v", node, syncMode, fs.Args())
	}
}

func TestExitCodesMatchContract(t *testing.T) {
	if got := api.ExitCodeForRunStatus("done"); got != 0 {
		t.Fatalf("done => %d, want 0", got)
	}
	if got := api.ExitCodeForRunStatus("needs_approval"); got != 20 {
		t.Fatalf("needs_approval => %d, want 20", got)
	}
	if got := api.ExitCodeForRunStatus("failed"); got != 10 {
		t.Fatalf("failed => %d, want 10", got)
	}
	if got := api.ExitCodeForError(&api.APIError{HTTPStatus: http.StatusForbidden, Body: api.ErrorBody{Code: "DEPTH_LIMIT_EXCEEDED"}}); got != 78 {
		t.Fatalf("DEPTH_LIMIT_EXCEEDED => %d, want 78", got)
	}
	if got := api.ExitCodeForError(&api.APIError{HTTPStatus: http.StatusConflict, Body: api.ErrorBody{Code: "WORKDIR_AMBIGUOUS"}}); got != 64 {
		t.Fatalf("WORKDIR_AMBIGUOUS => %d, want 64", got)
	}
	if got := api.ExitCodeForError(errors.New("dial tcp timeout")); got != 75 {
		t.Fatalf("net err => %d, want 75", got)
	}
}

func captureExecute(t *testing.T, args []string, stdinData string) (int, string) {
	t.Helper()
	oldStdout := os.Stdout
	oldStdin := os.Stdin

	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	inR, inW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}

	os.Stdout = outW
	os.Stdin = inR
	defer func() {
		os.Stdout = oldStdout
		os.Stdin = oldStdin
	}()

	if _, err := io.WriteString(inW, stdinData); err != nil {
		t.Fatal(err)
	}
	_ = inW.Close()

	code := Execute(args, "v0.1.0")
	_ = outW.Close()
	_ = inR.Close()

	var buf bytes.Buffer
	if _, err := io.Copy(&buf, outR); err != nil {
		t.Fatal(err)
	}
	_ = outR.Close()
	return code, buf.String()
}

func TestNodeInitAndStatusRedactedIdempotent(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("AHUB_CONFIG_DIR", tmpDir)
	t.Setenv("AHUB_TOKEN", "")
	t.Setenv("AHUB_URL", "")

	cfgPath := filepath.Join(tmpDir, "node.json")
	svcDir := filepath.Join(tmpDir, "svc")
	const secretTok = "ahub_nod_unit_test_secret_987654"

	code, out := captureExecute(t, []string{
		"--json", "node", "init",
		"--id", "macmini",
		"--url", "https://ahub.bobocai.win",
		"--root", "~/workspace",
		"--config", cfgPath,
		"--token-stdin",
	}, secretTok+"\n")
	if code != 0 {
		t.Fatalf("node init exit=%d out=%s", code, out)
	}
	if strings.Contains(out, secretTok) {
		t.Fatalf("node init leaked raw token in stdout: %s", out)
	}

	var initRes map[string]interface{}
	if err := json.Unmarshal([]byte(out), &initRes); err != nil {
		t.Fatalf("invalid json from node init: %v (%s)", err, out)
	}
	if initRes["ok"] != true || initRes["created"] != true || initRes["has_token"] != true || initRes["node_id"] != "macmini" {
		t.Fatalf("unexpected node init payload: %+v", initRes)
	}

	if runtime.GOOS != "windows" {
		info, err := os.Stat(cfgPath)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("expected 0600 node.json perms, got %o", info.Mode().Perm())
		}
	}

	// Idempotent second run without --token preserves existing token and sets created=false
	code2, out2 := captureExecute(t, []string{
		"--json", "node", "init",
		"--config", cfgPath,
	}, "")
	if code2 != 0 {
		t.Fatalf("second node init exit=%d out=%s", code2, out2)
	}
	if strings.Contains(out2, secretTok) {
		t.Fatalf("second node init leaked raw token: %s", out2)
	}
	var initRes2 map[string]interface{}
	if err := json.Unmarshal([]byte(out2), &initRes2); err != nil {
		t.Fatalf("invalid json from second node init: %v", err)
	}
	if initRes2["created"] != false || initRes2["has_token"] != true {
		t.Fatalf("expected created=false & preserved has_token=true, got %+v", initRes2)
	}

	code3, out3 := captureExecute(t, []string{
		"--json", "node", "status",
		"--config", cfgPath,
		"--target-dir", svcDir,
	}, "")
	if code3 != 0 {
		t.Fatalf("node status exit=%d out=%s", code3, out3)
	}
	if strings.Contains(out3, secretTok) {
		t.Fatalf("node status leaked raw token: %s", out3)
	}
	var statusRes map[string]interface{}
	if err := json.Unmarshal([]byte(out3), &statusRes); err != nil {
		t.Fatalf("invalid json from node status: %v", err)
	}
	if statusRes["config_exists"] != true || statusRes["has_token"] != true || statusRes["service_installed"] != false {
		t.Fatalf("unexpected status before service install: %+v", statusRes)
	}

	code4, out4 := captureExecute(t, []string{
		"--json", "node", "service", "install",
		"--config", cfgPath,
		"--target-dir", svcDir,
		"--bin", "/usr/local/bin/ahub",
	}, "")
	if code4 != 0 {
		t.Fatalf("node service install exit=%d out=%s", code4, out4)
	}

	code5, out5 := captureExecute(t, []string{
		"--json", "node", "status",
		"--config", cfgPath,
		"--target-dir", svcDir,
	}, "")
	if code5 != 0 {
		t.Fatalf("node status after install exit=%d out=%s", code5, out5)
	}
	var statusRes2 map[string]interface{}
	if err := json.Unmarshal([]byte(out5), &statusRes2); err != nil {
		t.Fatalf("invalid json from second node status: %v", err)
	}
	if statusRes2["service_installed"] != true {
		t.Fatalf("expected service_installed=true, got %+v", statusRes2)
	}
	if runtime.GOOS == "darwin" {
		if statusRes2["daemon_app_signed"] != true || statusRes2["daemon_app_exists"] != true {
			t.Fatalf("expected signed AhubDaemon.app in node status on darwin, got %+v", statusRes2)
		}
	}

	code6, out6 := captureExecute(t, []string{
		"--json", "node", "shim", "--self-test", "--config", cfgPath,
	}, "")
	if code6 != 0 {
		t.Fatalf("node shim --self-test exit=%d out=%s", code6, out6)
	}
	var shimRes map[string]interface{}
	if err := json.Unmarshal([]byte(out6), &shimRes); err != nil {
		t.Fatalf("invalid json from node shim --self-test: %v (%s)", err, out6)
	}
	if shimRes["ok"] != true || shimRes["shim"] != true {
		t.Fatalf("unexpected shim self-test payload: %+v", shimRes)
	}
}

func TestAuthLoginTokenStdinIsolationAndRedactedStatus(t *testing.T) {
	const alphaTok = "ahub_cli_alpha_secret_token_1111"
	const betaTok = "ahub_cli_beta_secret_token_2222"
	const envTok = "ahub_cli_env_override_secret_3333"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/auth/me" {
			http.NotFound(w, r)
			return
		}
		auth := r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		switch auth {
		case "Bearer " + alphaTok:
			_, _ = w.Write([]byte(`{"ok":true,"principal":{"kind":"api_key","scope":"client","allowed_nodes":["macmini"]}}`))
		case "Bearer " + betaTok:
			_, _ = w.Write([]byte(`{"ok":true,"principal":{"kind":"api_key","scope":"client","allowed_nodes":["mbp"]}}`))
		case "Bearer " + envTok:
			_, _ = w.Write([]byte(`{"ok":true,"principal":{"kind":"api_key","scope":"client","allowed_nodes":[]}}`))
		default:
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"ok":false,"error":{"code":"UNAUTHORIZED","message":"Invalid token"}}`))
		}
	}))
	defer srv.Close()

	baseDir := t.TempDir()
	botAlphaDir := filepath.Join(baseDir, "bot-alpha")
	botBetaDir := filepath.Join(baseDir, "bot-beta")

	t.Setenv("AHUB_CONFIG_DIR", botAlphaDir)
	t.Setenv("AHUB_TOKEN", "")
	t.Setenv("AHUB_URL", "")

	// Mutually exclusive --token and --token-stdin returns ExitBadUsageOrInput (64)
	conflictCode, _ := captureExecute(t, []string{
		"--json", "auth", "login", "--url", srv.URL, "--token", alphaTok, "--token-stdin",
	}, alphaTok+"\n")
	if conflictCode != api.ExitBadUsageOrInput {
		t.Fatalf("expected ExitBadUsageOrInput on conflicting flags, got %d", conflictCode)
	}

	// Empty stdin with --token-stdin returns ExitBadUsageOrInput (64)
	emptyCode, _ := captureExecute(t, []string{
		"--json", "auth", "login", "--url", srv.URL, "--token-stdin",
	}, "   \n")
	if emptyCode != api.ExitBadUsageOrInput {
		t.Fatalf("expected ExitBadUsageOrInput on empty stdin, got %d", emptyCode)
	}

	// Valid --token-stdin writes 0600 credentials under botAlphaDir without leaking secret
	code, out := captureExecute(t, []string{
		"--json", "auth", "login", "--url", srv.URL, "--token-stdin",
	}, alphaTok+"\n")
	if code != 0 {
		t.Fatalf("auth login alpha exit=%d out=%s", code, out)
	}
	if strings.Contains(out, alphaTok) {
		t.Fatalf("auth login leaked plaintext token in stdout: %s", out)
	}
	var loginRes map[string]interface{}
	if err := json.Unmarshal([]byte(out), &loginRes); err != nil {
		t.Fatalf("invalid auth login json: %v (%s)", err, out)
	}
	expectedAlphaCreds := filepath.Join(botAlphaDir, "credentials")
	if loginRes["ok"] != true || loginRes["credentials_path"] != expectedAlphaCreds {
		t.Fatalf("unexpected auth login payload: %+v", loginRes)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(expectedAlphaCreds)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("expected 0600 credentials perms, got %o", info.Mode().Perm())
		}
	}

	// Second bot uses isolated AHUB_CONFIG_DIR without clobbering botAlphaDir
	t.Setenv("AHUB_CONFIG_DIR", botBetaDir)
	codeBeta, outBeta := captureExecute(t, []string{
		"--json", "auth", "login", "--url", srv.URL, "--token-stdin",
	}, betaTok+"\n")
	if codeBeta != 0 {
		t.Fatalf("auth login beta exit=%d out=%s", codeBeta, outBeta)
	}
	if strings.Contains(outBeta, betaTok) {
		t.Fatalf("auth login beta leaked plaintext token: %s", outBeta)
	}

	alphaRaw, err := os.ReadFile(expectedAlphaCreds)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(alphaRaw), alphaTok) || strings.Contains(string(alphaRaw), betaTok) {
		t.Fatalf("expected botAlphaDir credentials to remain intact after botBetaDir login")
	}

	// Verify redacted auth status + --verify from isolated file
	t.Setenv("AHUB_CONFIG_DIR", botAlphaDir)
	codeStatus, outStatus := captureExecute(t, []string{"--json", "auth", "status", "--verify"}, "")
	if codeStatus != 0 {
		t.Fatalf("auth status --verify exit=%d out=%s", codeStatus, outStatus)
	}
	if strings.Contains(outStatus, alphaTok) {
		t.Fatalf("auth status leaked plaintext token in stdout: %s", outStatus)
	}
	var statusRes map[string]interface{}
	if err := json.Unmarshal([]byte(outStatus), &statusRes); err != nil {
		t.Fatalf("invalid auth status json: %v (%s)", err, outStatus)
	}
	if statusRes["ok"] != true ||
		statusRes["has_token"] != true ||
		statusRes["token_source"] != "file" ||
		statusRes["credentials_exists"] != true ||
		statusRes["verified"] != true ||
		statusRes["credentials_path"] != expectedAlphaCreds {
		t.Fatalf("unexpected auth status payload: %+v", statusRes)
	}

	// Verify AHUB_TOKEN env override takes precedence cleanly without leaking
	t.Setenv("AHUB_TOKEN", envTok)
	codeEnv, outEnv := captureExecute(t, []string{"--json", "auth", "status", "--verify"}, "")
	if codeEnv != 0 {
		t.Fatalf("auth status env exit=%d out=%s", codeEnv, outEnv)
	}
	if strings.Contains(outEnv, envTok) || strings.Contains(outEnv, alphaTok) {
		t.Fatalf("auth status leaked env/file token: %s", outEnv)
	}
	var envRes map[string]interface{}
	if err := json.Unmarshal([]byte(outEnv), &envRes); err != nil {
		t.Fatalf("invalid auth status env json: %v (%s)", err, outEnv)
	}
	if envRes["token_source"] != "env" || envRes["verified"] != true {
		t.Fatalf("expected token_source=env and verified=true, got %+v", envRes)
	}
}
