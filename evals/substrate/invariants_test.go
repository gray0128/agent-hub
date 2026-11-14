package substrate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/gray0128/agent-hub/internal/api"
	"github.com/gray0128/agent-hub/internal/config"
	"github.com/gray0128/agent-hub/internal/daemon"
	"github.com/gray0128/agent-hub/internal/selfupdate"
)

type testHarness struct {
	t            *testing.T
	rootDir      string
	tmpDir       string
	ahubBin      string
	fakeAgentBin string
	fakeLogPath  string
	hubURL       string
	adminToken   string
	configDir    string
	wranglerCmd  *exec.Cmd
	webhookCh    chan map[string]interface{}
	releaseSrv   *httptest.Server
	webhookSrv   *httptest.Server

	mu      sync.Mutex
	daemons []*exec.Cmd
}

func repoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Clean(filepath.Join(wd, "..", ".."))
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func newTestHarness(t *testing.T) *testHarness {
	t.Helper()
	root := repoRoot(t)
	tmpDir := t.TempDir()
	cfgDir := filepath.Join(tmpDir, "ahub-config")
	if err := os.MkdirAll(cfgDir, 0o700); err != nil {
		t.Fatal(err)
	}

	ahubBin := filepath.Join(root, "bin", "ahub")
	fakeBin := filepath.Join(root, "bin", "ahub-fakeagent")
	if _, err := os.Stat(ahubBin); err != nil {
		t.Fatalf("missing %s (run make build-go): %v", ahubBin, err)
	}
	if _, err := os.Stat(fakeBin); err != nil {
		t.Fatalf("missing %s (run make build-fakeagent): %v", fakeBin, err)
	}

	adminToken := "ahub_adm_test_bootstrap_admin_secret_1234"
	sum := sha256.Sum256([]byte(adminToken))
	adminSha := hex.EncodeToString(sum[:])

	webhookCh := make(chan map[string]interface{}, 16)
	webhookSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		webhookCh <- payload
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))

	// Mock release server for /dl/version.json & /dl/ahub-<os>-<arch>
	binBytes, err := os.ReadFile(ahubBin)
	if err != nil {
		t.Fatal(err)
	}
	binSum := sha256.Sum256(binBytes)
	binHex := hex.EncodeToString(binSum[:])
	assetKey := runtime.GOOS + "_" + runtime.GOARCH
	assetFile := fmt.Sprintf("ahub-%s-%s", runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		assetFile += ".exe"
	}

	var releaseSrv *httptest.Server
	releaseSrv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/version.json"):
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"version":     "9.9.9",
				"released_at": time.Now().UTC().Format(time.RFC3339),
				"assets": map[string]interface{}{
					assetKey: map[string]string{
						"url":    releaseSrv.URL + "/" + assetFile,
						"sha256": binHex,
					},
				},
			})
		case strings.HasSuffix(r.URL.Path, "/"+assetFile):
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write(binBytes)
		default:
			http.NotFound(w, r)
		}
	}))

	d1Dir := filepath.Join(tmpDir, "d1-persist")
	workerDir := filepath.Join(root, "apps", "hub-worker")

	// Apply D1 migration cleanly
	migCmd := exec.Command("pnpm", "exec", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", d1Dir)
	migCmd.Dir = workerDir
	migCmd.Env = append(os.Environ(), "CI=1")
	if out, err := migCmd.CombinedOutput(); err != nil {
		t.Fatalf("d1 migration failed: %v\n%s", err, string(out))
	}

	port := freePort(t)
	hubURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	wranglerLog := &bytes.Buffer{}
	wranglerCmd := exec.Command(
		"pnpm", "exec", "wrangler", "dev",
		"--local",
		"--port", strconv.Itoa(port),
		"--inspector-port", "0",
		"--persist-to", d1Dir,
		"--test-scheduled",
		"--show-interactive-dev-session=false",
		"--var", "BOOTSTRAP_ADMIN_TOKEN_SHA256:"+adminSha,
		"--var", "LEASE_TTL_SECONDS:3",
		"--var", "HUB_PUBLIC_URL:"+hubURL,
		"--var", "WEBHOOK_URL:"+webhookSrv.URL,
		"--var", "WEBHOOK_ENCRYPTION_KEY:eval-test-master-secret-32bytes!!",
		"--var", "RELEASE_BASE_URL:"+releaseSrv.URL,
	)
	wranglerCmd.Dir = workerDir
	wranglerCmd.Env = append(os.Environ(), "CI=1")
	wranglerCmd.Stdout = wranglerLog
	wranglerCmd.Stderr = wranglerLog
	wranglerCmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := wranglerCmd.Start(); err != nil {
		t.Fatalf("start wrangler dev failed: %v", err)
	}

	h := &testHarness{
		t:            t,
		rootDir:      root,
		tmpDir:       tmpDir,
		ahubBin:      ahubBin,
		fakeAgentBin: fakeBin,
		fakeLogPath:  filepath.Join(tmpDir, "fakeagent.jsonl"),
		hubURL:       hubURL,
		adminToken:   adminToken,
		configDir:    cfgDir,
		wranglerCmd:  wranglerCmd,
		webhookCh:    webhookCh,
		releaseSrv:   releaseSrv,
		webhookSrv:   webhookSrv,
	}

	t.Cleanup(func() {
		h.stopAllDaemons()
		if h.wranglerCmd != nil && h.wranglerCmd.Process != nil {
			_ = syscall.Kill(-h.wranglerCmd.Process.Pid, syscall.SIGKILL)
			_, _ = h.wranglerCmd.Process.Wait()
		}
		h.releaseSrv.Close()
		h.webhookSrv.Close()
	})

	// Wait until HTTP server accepts /api/v1/auth/me
	client := api.NewClient(hubURL, adminToken)
	deadline := time.Now().Add(20 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_, err := client.AuthMe(ctx)
		cancel()
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("wrangler dev did not become ready within 20s: %v\nlog:\n%s", err, wranglerLog.String())
		}
		time.Sleep(150 * time.Millisecond)
	}

	return h
}

func (h *testHarness) createKey(name, scope, boundNodeID string, allowedNodes []string, maxDepth int) string {
	_, tok := h.createKeyWithWebhook(name, scope, boundNodeID, allowedNodes, maxDepth, "", "")
	return tok
}

func (h *testHarness) createKeyWithWebhook(name, scope, boundNodeID string, allowedNodes []string, maxDepth int, webhookURL, webhookKey string) (string, string) {
	h.t.Helper()
	payload := map[string]interface{}{
		"name":            name,
		"scope":           scope,
		"allowed_nodes":   allowedNodes,
		"max_depth_limit": maxDepth,
	}
	if boundNodeID != "" {
		payload["bound_node_id"] = boundNodeID
	}
	if webhookURL != "" {
		payload["webhook_url"] = webhookURL
	}
	if webhookKey != "" {
		payload["webhook_key"] = webhookKey
	}
	body, _ := json.Marshal(payload)
	req, _ := http.NewRequest(http.MethodPost, h.hubURL+"/api/v1/keys", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+h.adminToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatalf("createKey error: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 201 {
		raw, _ := io.ReadAll(resp.Body)
		h.t.Fatalf("createKey status %d: %s", resp.StatusCode, string(raw))
	}
	var out struct {
		Key struct {
			ID string `json:"id"`
		} `json:"key"`
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		h.t.Fatal(err)
	}
	return out.Key.ID, out.Token
}

func (h *testHarness) makeWorkspaceDir(name string) string {
	h.t.Helper()
	dir := filepath.Join(h.tmpDir, "workspaces", name)
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		h.t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, ".git", "HEAD"), []byte("ref: refs/heads/main\n"), 0o644)
	return dir
}

func (h *testHarness) startDaemon(nodeID, nodeToken, delegationToken, projectRoot string, maxConcurrency int, extraEnv ...string) *exec.Cmd {
	h.t.Helper()
	cfgPath := filepath.Join(h.tmpDir, fmt.Sprintf("node-%s.json", nodeID))
	cfg := config.NodeConfig{
		NodeID:               nodeID,
		DisplayName:          nodeID,
		HubURL:               h.hubURL,
		Token:                nodeToken,
		DelegationToken:      delegationToken,
		MaxConcurrency:       maxConcurrency,
		HeartbeatIntervalSec: 1,
		ProjectRoots:         []string{projectRoot},
		SkipDirs:             []string{"node_modules", ".git"},
		Agents: map[string]config.AgentConfig{
			"agy":   {Enabled: true, Command: h.fakeAgentBin},
			"pi":    {Enabled: true, Command: h.fakeAgentBin},
			"omp":   {Enabled: true, Command: h.fakeAgentBin},
			"codex": {Enabled: true, Command: h.fakeAgentBin},
			"claude": {Enabled: true, Command: h.fakeAgentBin},
		},
	}
	raw, _ := json.MarshalIndent(cfg, "", "  ")
	if err := os.WriteFile(cfgPath, raw, 0o600); err != nil {
		h.t.Fatal(err)
	}

	logBuf := &bytes.Buffer{}
	cmd := exec.Command(h.ahubBin, "node", "serve", "--config", cfgPath)
	env := append(os.Environ(),
		"AHUB_CONFIG_DIR="+h.configDir,
		"AHUB_FAKEAGENT_LOG="+h.fakeLogPath,
		"AHUB_TOKEN="+nodeToken,
		"AWS_SECRET_ACCESS_KEY=aws_secret_should_be_stripped",
	)
	env = append(env, extraEnv...)
	cmd.Env = env
	cmd.Stdout = logBuf
	cmd.Stderr = logBuf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		h.t.Fatalf("startDaemon %s: %v", nodeID, err)
	}

	h.mu.Lock()
	h.daemons = append(h.daemons, cmd)
	h.mu.Unlock()

	client := api.NewClient(h.hubURL, h.adminToken)
	deadline := time.Now().Add(8 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		nodes, err := client.ListNodes(ctx, true)
		cancel()
		if err == nil {
			for _, n := range nodes {
				if n.ID == nodeID && n.Status == "online" {
					return cmd
				}
			}
		}
		if time.Now().After(deadline) {
			h.t.Fatalf("node %s did not come online within 8s; log:\n%s", nodeID, logBuf.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (h *testHarness) stopDaemon(cmd *exec.Cmd, sig syscall.Signal) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, sig)
	_, _ = cmd.Process.Wait()
}

func (h *testHarness) stopAllDaemons() {
	h.mu.Lock()
	list := append([]*exec.Cmd(nil), h.daemons...)
	h.daemons = nil
	h.mu.Unlock()
	for _, c := range list {
		if c != nil && c.Process != nil {
			_ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
			_, _ = c.Process.Wait()
		}
	}
}

func (h *testHarness) runCLI(stdin string, args ...string) (int, string, string) {
	h.t.Helper()
	cmd := exec.Command(h.ahubBin, args...)
	cmd.Env = append(os.Environ(),
		"AHUB_URL="+h.hubURL,
		"AHUB_TOKEN="+h.adminToken,
		"AHUB_CONFIG_DIR="+h.configDir,
	)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	code := 0
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			code = ee.ExitCode()
		} else {
			code = 1
		}
	}
	return code, stdout.String(), stderr.String()
}

func (h *testHarness) mustRunCLIJSON(stdin string, args ...string) api.RunRecord {
	h.t.Helper()
	fullArgs := append([]string{"--json"}, args...)
	code, stdout, stderr := h.runCLI(stdin, fullArgs...)
	if code != 0 && code != api.ExitNeedsApproval && code != api.ExitWaitTimeout {
		h.t.Fatalf("ahub %v failed (exit %d)\nstdout: %s\nstderr: %s", args, code, stdout, stderr)
	}
	var rec api.RunRecord
	if err := json.Unmarshal([]byte(stdout), &rec); err != nil {
		h.t.Fatalf("invalid JSON from ahub %v: %v\nraw: %s", args, err, stdout)
	}
	return rec
}

func TestInvariantSuite(t *testing.T) {
	h := newTestHarness(t)

	wsRootMac := filepath.Join(h.tmpDir, "workspaces", "mac-root")
	alphaDir := h.makeWorkspaceDir(filepath.Join("mac-root", "proj-alpha"))
	betaDir := h.makeWorkspaceDir(filepath.Join("mac-root", "proj-beta"))

	wsRootMbp := filepath.Join(h.tmpDir, "workspaces", "mbp-root")
	mbpDir := h.makeWorkspaceDir(filepath.Join("mbp-root", "proj-mbp"))

	macTok := h.createKey("macmini-node", "node", "macmini", []string{"macmini"}, 0)
	mbpTok := h.createKey("mbp-node", "node", "mbp", []string{"mbp"}, 0)
	ephTok := h.createKey("ephemeral-node-key", "node", "ephemeral-node", []string{"ephemeral-node"}, 0)
	delTok := h.createKey("macmini-delegator", "client", "", []string{"mbp", "macmini"}, 1)

	h.startDaemon("macmini", macTok, delTok, wsRootMac, 2)

	// Wait helper via API
	client := api.NewClient(h.hubURL, h.adminToken)

	t.Run("I1_V02_WorkdirMutexAndConcurrency", func(t *testing.T) {
		var wg sync.WaitGroup
		results := make([]api.RunRecord, 4)
		// 3 runs serialize on proj-alpha + 1 run executes concurrently on proj-beta
		prompts := []struct {
			idx     int
			workdir string
		}{
			{0, alphaDir},
			{1, alphaDir},
			{2, alphaDir},
			{3, betaDir},
		}
		for _, p := range prompts {
			wg.Add(1)
			go func(idx int, dir string) {
				defer wg.Done()
				payload := `{"directives":[{"op":"sleep","ms":180}]}`
				rec := h.mustRunCLIJSON(payload, "run", "--node", "macmini", "--dir", dir, "--agent", "agy", "--wait", "20s", "-")
				results[idx] = rec
			}(p.idx, p.workdir)
		}
		wg.Wait()

		// Check zero active window overlap across alpha runs 0..2
		type span struct{ start, end time.Time }
		var alphaSpans []span
		for i := 0; i < 3; i++ {
			if results[i].Status != "done" || results[i].StartedAt == nil || results[i].FinishedAt == nil {
				t.Fatalf("alpha run %d incomplete: %+v", i, results[i])
			}
			st, _ := time.Parse(time.RFC3339Nano, *results[i].StartedAt)
			fn, _ := time.Parse(time.RFC3339Nano, *results[i].FinishedAt)
			alphaSpans = append(alphaSpans, span{st, fn})
		}
		for i := 0; i < len(alphaSpans); i++ {
			for j := i + 1; j < len(alphaSpans); j++ {
				if alphaSpans[i].start.Before(alphaSpans[j].end) && alphaSpans[j].start.Before(alphaSpans[i].end) {
					t.Fatalf("I-1 workdir mutex violated! overlapping spans on proj-alpha: [%s..%s] vs [%s..%s]",
						alphaSpans[i].start, alphaSpans[i].end, alphaSpans[j].start, alphaSpans[j].end)
				}
			}
		}
		if results[3].Status != "done" {
			t.Fatalf("proj-beta run failed: %+v", results[3])
		}
	})

	t.Run("I2_V01_ThreadAffinityAndFork", func(t *testing.T) {
		r1 := h.mustRunCLIJSON(`{"session_id":"sess_affinity_abc","directives":[{"op":"sleep","ms":20}]}`,
			"run", "--node", "macmini", "--dir", "proj-alpha", "--agent", "agy", "--wait", "15s", "-")
		if r1.NativeSessionID == nil || *r1.NativeSessionID != "sess_affinity_abc" {
			t.Fatalf("expected round 1 native_session_id=sess_affinity_abc, got %v", r1.NativeSessionID)
		}

		// Round 2 on same thread via --thread
		r2 := h.mustRunCLIJSON("round two follow-up", "run", "--thread", r1.ThreadID, "--wait", "15s", "-")
		if r2.Status != "done" || !strings.Contains(r2.OutputPreview, "passed_session=sess_affinity_abc") {
			t.Fatalf("expected round 2 to receive passed_session=sess_affinity_abc, got status=%s preview=%q", r2.Status, r2.OutputPreview)
		}

		// Fork thread via HTTP API
		forkBody, _ := json.Marshal(map[string]string{
			"node_id": "macmini",
			"workdir": alphaDir,
			"title":   "forked branch",
		})
		req, _ := http.NewRequest(http.MethodPost, h.hubURL+"/api/v1/threads/"+r1.ThreadID+"/fork", bytes.NewReader(forkBody))
		req.Header.Set("Authorization", "Bearer "+h.adminToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 202 && resp.StatusCode != 201 {
			t.Fatalf("fork status %d", resp.StatusCode)
		}
		var forkResp struct {
			Thread api.ThreadRecord `json:"thread"`
			Run    api.RunRecord    `json:"run"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&forkResp); err != nil {
			t.Fatal(err)
		}
		if forkResp.Thread.ID == "" || forkResp.Thread.ID == r1.ThreadID {
			t.Fatalf("expected new forked thread id, got %+v", forkResp.Thread)
		}
		forkedRun := h.mustRunCLIJSON("", "wait", forkResp.Run.ID, "--timeout", "10s")
		if forkedRun.Status != "done" {
			t.Fatalf("forked seed run failed: %+v", forkedRun)
		}
	})

	t.Run("I6_EnvSanitizationOnNoDelegationDaemon", func(t *testing.T) {
		// macmini-no-del daemon without DelegationToken strips AHUB_TOKEN completely
		noDelRoot := filepath.Join(h.tmpDir, "workspaces", "nodel-root")
		noDelProj := h.makeWorkspaceDir(filepath.Join("nodel-root", "proj-clean"))
		noDelTok := h.createKey("nodel-key", "node", "nodel-node", []string{"nodel-node"}, 0)
		noDelCmd := h.startDaemon("nodel-node", noDelTok, "", noDelRoot, 1)
		defer h.stopDaemon(noDelCmd, syscall.SIGKILL)

		rec := h.mustRunCLIJSON(`{"directives":[{"op":"dump_env","keys":["AHUB_TOKEN","AWS_SECRET_ACCESS_KEY","AHUB_RUN_ID","AHUB_THREAD_ID","AHUB_ROOT_RUN_ID","AHUB_DEPTH"]}]}`,
			"run", "--node", "nodel-node", "--dir", noDelProj, "--agent", "agy", "--wait", "15s", "-")
		if !strings.Contains(rec.OutputPreview, `"AHUB_TOKEN":"__MISSING__"`) {
			t.Fatalf("I-6 violated: expected AHUB_TOKEN stripped, got %s", rec.OutputPreview)
		}
		if !strings.Contains(rec.OutputPreview, `"AWS_SECRET_ACCESS_KEY":"__MISSING__"`) {
			t.Fatalf("I-6 violated: expected AWS_SECRET_ACCESS_KEY stripped, got %s", rec.OutputPreview)
		}
		if !strings.Contains(rec.OutputPreview, `"AHUB_RUN_ID":"`+rec.ID+`"`) || !strings.Contains(rec.OutputPreview, `"AHUB_DEPTH":"0"`) {
			t.Fatalf("I-6 lineage vars missing in output: %s", rec.OutputPreview)
		}
	})

	t.Run("V03_OfflineQueueing_And_I3_V04_Delegation", func(t *testing.T) {
		// Connect mbp briefly to register its workspaces, then take it offline
		mbpCmd := h.startDaemon("mbp", mbpTok, delTok, wsRootMbp, 2)
		h.stopDaemon(mbpCmd, syscall.SIGTERM)

		// Verify offline status & queue run while offline
		queuedRec := h.mustRunCLIJSON(`{"directives":[{"op":"sleep","ms":30}]}`,
			"run", "--node", "mbp", "--dir", mbpDir, "--agent", "agy", "--wait", "0s", "-")
		if queuedRec.Status != "queued" {
			t.Fatalf("expected queued status while mbp offline, got %s", queuedRec.Status)
		}

		// Start mbp -> mandatory startup claim picks up queuedRec
		h.startDaemon("mbp", mbpTok, delTok, wsRootMbp, 2)
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		deadline := time.Now().Add(10 * time.Second)
		for {
			r, err := client.GetRun(ctx, queuedRec.ID, false, 4096)
			if err == nil && r.Status == "done" {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("offline queued run %s was not claimed/finished by mbp startup: %+v", queuedRec.ID, r)
			}
			time.Sleep(100 * time.Millisecond)
		}

		// I-3 Depth limit: macmini (depth=0) -> mbp (depth=1) succeeds; depth=1 -> depth=2 returns exit 78 / DEPTH_LIMIT_EXCEEDED
		parentPrompt := fmt.Sprintf(`{"directives":[{"op":"recurse_run","ahub_bin":%q,"target_node":"mbp","workdir":%q}]}`, h.ahubBin, mbpDir)
		parentRec := h.mustRunCLIJSON(parentPrompt, "run", "--node", "macmini", "--dir", alphaDir, "--agent", "agy", "--wait", "20s", "-")
		if !strings.Contains(parentRec.OutputPreview, `"child_exit_code":0`) {
			t.Fatalf("expected depth 0->1 cross-node delegation to succeed, got %s", parentRec.OutputPreview)
		}

		// Now try delegating with AHUB_RUN_ID pointing to that depth=1 child run -> must return 403 DEPTH_LIMIT_EXCEEDED (exit 78)
		runsList, err := client.ListRuns(ctx, "", "", 10)
		if err != nil {
			t.Fatal(err)
		}
		var childRunID string
		for _, r := range runsList {
			if r.ParentRunID != nil && *r.ParentRunID == parentRec.ID && r.Depth == 1 {
				childRunID = r.ID
				break
			}
		}
		if childRunID == "" {
			t.Fatalf("could not find depth=1 child run of %s", parentRec.ID)
		}

		cmdDepth := exec.Command(h.ahubBin, "--json", "run", "--node", "macmini", "--dir", betaDir, "--agent", "agy", "should fail depth=2")
		cmdDepth.Env = append(os.Environ(), "AHUB_URL="+h.hubURL, "AHUB_TOKEN="+delTok, "AHUB_CONFIG_DIR="+h.configDir, "AHUB_RUN_ID="+childRunID)
		outDepth, errDepth := cmdDepth.CombinedOutput()
		var eeDepth *exec.ExitError
		if !errors.As(errDepth, &eeDepth) || eeDepth.ExitCode() != api.ExitPolicyDenied || !strings.Contains(string(outDepth), "DEPTH_LIMIT_EXCEEDED") {
			t.Fatalf("expected exit 78 DEPTH_LIMIT_EXCEEDED, got err=%v out=%s", errDepth, string(outDepth))
		}

		// Cycle check: delegating from parentRunID targeting SAME (node_id=macmini, workdir=alphaDir) returns 409 DELEGATION_CYCLE_DETECTED (exit 78)
		cmdCycle := exec.Command(h.ahubBin, "--json", "run", "--node", "macmini", "--dir", alphaDir, "--agent", "agy", "should fail cycle")
		cmdCycle.Env = append(os.Environ(), "AHUB_URL="+h.hubURL, "AHUB_TOKEN="+delTok, "AHUB_CONFIG_DIR="+h.configDir, "AHUB_RUN_ID="+parentRec.ID)
		outCycle, errCycle := cmdCycle.CombinedOutput()
		var eeCycle *exec.ExitError
		if !errors.As(errCycle, &eeCycle) || eeCycle.ExitCode() != api.ExitPolicyDenied || !strings.Contains(string(outCycle), "DELEGATION_CYCLE_DETECTED") {
			t.Fatalf("expected exit 78 DELEGATION_CYCLE_DETECTED, got err=%v out=%s", errCycle, string(outCycle))
		}
	})

	t.Run("V06_SoftApprovalLifecycle", func(t *testing.T) {
		prompt := `{"directives":[{"op":"soft_approval","url":"https://claude.ai/code/session_01FAKE","hold_ms":450,"then":"resume"}]}`
		created := h.mustRunCLIJSON(prompt, "run", "--node", "macmini", "--dir", alphaDir, "--agent", "agy", "--wait", "0s", "-")
		code, stdout, stderr := h.runCLI("", "--json", "wait", created.ID, "--timeout", "10s")
		if code != api.ExitNeedsApproval {
			t.Fatalf("expected ahub wait exit 20 on soft_approval, got %d stdout=%s stderr=%s", code, stdout, stderr)
		}
		var paused api.RunRecord
		if err := json.Unmarshal([]byte(stdout), &paused); err != nil {
			t.Fatal(err)
		}
		if paused.Status != "needs_approval" || paused.RemoteControlURL != "https://claude.ai/code/session_01FAKE" {
			t.Fatalf("unexpected paused state: %+v", paused)
		}

		// Wait past approval hold window so run resumes to running -> done, then confirm ahub wait returns 0
		time.Sleep(550 * time.Millisecond)
		code2, stdout2, stderr2 := h.runCLI("", "--json", "wait", created.ID, "--timeout", "10s")
		if code2 != 0 {
			t.Fatalf("expected resumed wait exit 0, got %d stdout=%s stderr=%s", code2, stdout2, stderr2)
		}
		var finished api.RunRecord
		_ = json.Unmarshal([]byte(stdout2), &finished)
		if finished.Status != "done" {
			t.Fatalf("expected resumed run status done, got %s", finished.Status)
		}
	})

	t.Run("I4_EventMonotonicityAndBigOutput", func(t *testing.T) {
		prompt := `{"directives":[{"op":"emit_ndjson","count":75,"interval_ms":1,"kind":"tool_use"},{"op":"corrupt_stdout","bytes":131072},{"op":"big_output","bytes":131072}]}`
		rec := h.mustRunCLIJSON(prompt, "run", "--node", "macmini", "--dir", betaDir, "--agent", "agy", "--wait", "20s", "-")
		if rec.Status != "done" || rec.OutputBytes < 131072 || len(rec.Summary) > 4096 || rec.Truncated == nil || !*rec.Truncated {
			t.Fatalf("unexpected big_output summary metadata: status=%s bytes=%d summaryLen=%d truncated=%v", rec.Status, rec.OutputBytes, len(rec.Summary), rec.Truncated)
		}

		fullRec := h.mustRunCLIJSON("", "result", rec.ID, "--full")
		if len(fullRec.OutputMD) < 131072 {
			t.Fatalf("expected full output >= 131072 bytes, got %d", len(fullRec.OutputMD))
		}

		req, _ := http.NewRequest(http.MethodGet, h.hubURL+"/api/v1/runs/"+rec.ID+"/events?after_seq=0&limit=200", nil)
		req.Header.Set("Authorization", "Bearer "+h.adminToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var evResp struct {
			Events []struct {
				Seq int `json:"seq"`
			} `json:"events"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&evResp)
		if len(evResp.Events) < 75 {
			t.Fatalf("expected >= 75 persisted events, got %d", len(evResp.Events))
		}
		for i, ev := range evResp.Events {
			if ev.Seq != i+1 {
				t.Fatalf("I-4 seq gap/duplicate at index %d: got seq=%d want %d", i, ev.Seq, i+1)
			}
		}

		// Reconnect replay after_seq=50
		req2, _ := http.NewRequest(http.MethodGet, h.hubURL+"/api/v1/runs/"+rec.ID+"/events?after_seq=50&limit=200", nil)
		req2.Header.Set("Authorization", "Bearer "+h.adminToken)
		resp2, err := http.DefaultClient.Do(req2)
		if err != nil {
			t.Fatal(err)
		}
		defer resp2.Body.Close()
		var evResp2 struct {
			Events []struct {
				Seq int `json:"seq"`
			} `json:"events"`
		}
		_ = json.NewDecoder(resp2.Body).Decode(&evResp2)
		if len(evResp2.Events) != len(evResp.Events)-50 || evResp2.Events[0].Seq != 51 {
			t.Fatalf("unexpected replay after_seq=50: len=%d firstSeq=%d", len(evResp2.Events), evResp2.Events[0].Seq)
		}
	})

	t.Run("I5_ProcessGroupCancelKillsGrandchild", func(t *testing.T) {
		pidFile := filepath.Join(h.tmpDir, "grandchild.pid")
		prompt := fmt.Sprintf(`{"directives":[{"op":"spawn_grandchild","cmd":["sleep","60"],"pid_file":%q},{"op":"sleep","ms":20000}]}`, pidFile)
		rec := h.mustRunCLIJSON(prompt, "run", "--node", "macmini", "--dir", alphaDir, "--agent", "agy", "--wait", "0s", "-")

		// Wait until pidFile exists
		var gcPid int
		deadline := time.Now().Add(8 * time.Second)
		for {
			raw, err := os.ReadFile(pidFile)
			if err == nil {
				gcPid, _ = strconv.Atoi(strings.TrimSpace(string(raw)))
				if gcPid > 0 {
					break
				}
			}
			if time.Now().After(deadline) {
				t.Fatalf("grandchild pid file did not appear for run %s", rec.ID)
			}
			time.Sleep(50 * time.Millisecond)
		}

		// Cancel run via CLI
		code, stdout, stderr := h.runCLI("", "--json", "cancel", rec.ID)
		if code != 0 {
			t.Fatalf("ahub cancel failed (%d): %s %s", code, stdout, stderr)
		}

		// Verify run cancelled & grandchild process dead within 2s
		deadDeadline := time.Now().Add(2 * time.Second)
		for {
			err := syscall.Kill(gcPid, 0)
			if errors.Is(err, syscall.ESRCH) {
				break
			}
			if time.Now().After(deadDeadline) {
				_ = syscall.Kill(gcPid, syscall.SIGKILL)
				t.Fatalf("I-5 violated: grandchild PID %d still alive 2s after cancel", gcPid)
			}
			time.Sleep(50 * time.Millisecond)
		}
	})

	t.Run("I7_V05_LeaseExpireAndReap", func(t *testing.T) {
		ephRoot := filepath.Join(h.tmpDir, "workspaces", "eph-root")
		ephDir := h.makeWorkspaceDir(filepath.Join("eph-root", "proj-eph"))
		ephCmd := h.startDaemon("ephemeral-node", ephTok, "", ephRoot, 1)

		rec := h.mustRunCLIJSON(`{"directives":[{"op":"sleep","ms":20000}]}`,
			"run", "--node", "ephemeral-node", "--dir", ephDir, "--agent", "agy", "--wait", "0s", "-")

		// Wait until running
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		deadline := time.Now().Add(6 * time.Second)
		for {
			r, err := client.GetRun(ctx, rec.ID, false, 1024)
			if err == nil && (r.Status == "running" || r.Status == "claimed") {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("run did not enter active state: %+v", r)
			}
			time.Sleep(50 * time.Millisecond)
		}

		// SIGKILL daemon to simulate node crash, wait > 3s (LEASE_TTL_SECONDS=3), then trigger reap
		h.stopDaemon(ephCmd, syscall.SIGKILL)
		time.Sleep(3500 * time.Millisecond)

		req, _ := http.NewRequest(http.MethodPost, h.hubURL+"/api/v1/admin/reap-leases", nil)
		req.Header.Set("Authorization", "Bearer "+h.adminToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()

		reaped, err := client.GetRun(ctx, rec.ID, false, 1024)
		if err != nil {
			t.Fatal(err)
		}
		if reaped.Status != "failed" || reaped.ErrorCode != "NODE_LEASE_EXPIRED" {
			t.Fatalf("expected failed NODE_LEASE_EXPIRED after reap, got status=%s code=%s", reaped.Status, reaped.ErrorCode)
		}

		// Bring ephemeral-node back up and verify workdir is unlocked and accepts next run
		ephCmd2 := h.startDaemon("ephemeral-node", ephTok, "", ephRoot, 1)
		defer h.stopDaemon(ephCmd2, syscall.SIGKILL)
		next := h.mustRunCLIJSON(`{"directives":[{"op":"sleep","ms":20}]}`,
			"run", "--node", "ephemeral-node", "--dir", ephDir, "--agent", "agy", "--wait", "15s", "-")
		if next.Status != "done" {
			t.Fatalf("expected workdir unlocked after reap, got %+v", next)
		}
	})

	t.Run("Slice4_Install_Update_Service_Webhook", func(t *testing.T) {
		// 1. GET /dl/install.sh
		resp, err := http.Get(h.hubURL + "/dl/install.sh")
		if err != nil {
			t.Fatal(err)
		}
		shBytes, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || !strings.Contains(string(shBytes), h.hubURL) {
			t.Fatalf("unexpected /dl/install.sh response (%d): %s", resp.StatusCode, string(shBytes))
		}
		shCheck := exec.Command("sh", "-n")
		shCheck.Stdin = bytes.NewReader(shBytes)
		if out, err := shCheck.CombinedOutput(); err != nil {
			t.Fatalf("install.sh syntax error: %v\n%s", err, string(out))
		}

		// 2. Atomic selfupdate against /dl/version.json + SHA-256
		tempBin := filepath.Join(h.tmpDir, "ahub-update-target")
		if err := os.WriteFile(tempBin, []byte("old-binary-placeholder"), 0o755); err != nil {
			t.Fatal(err)
		}
		updRes, err := selfupdate.CheckAndApply(context.Background(), client, "0.0.1", false, tempBin)
		if err != nil {
			t.Fatalf("selfupdate failed: %v", err)
		}
		if !updRes.Updated || updRes.LatestVersion != "9.9.9" {
			t.Fatalf("unexpected selfupdate result: %+v", updRes)
		}

		// 3. Service install --target-dir <tmp> & darwin AhubDaemon.app freeze-once idempotency
		svcDir := filepath.Join(h.tmpDir, "launch-agents")
		code, stdout, stderr := h.runCLI("", "--json", "node", "service", "install", "--bin", h.ahubBin, "--target-dir", svcDir)
		if code != 0 {
			t.Fatalf("service install failed (%d): %s %s", code, stdout, stderr)
		}
		if runtime.GOOS == "darwin" {
			var svcRes map[string]interface{}
			if err := json.Unmarshal([]byte(stdout), &svcRes); err != nil {
				t.Fatalf("invalid service install json: %v (%s)", err, stdout)
			}
			cdhash1, _ := svcRes["daemon_app_cdhash"].(string)
			appPath, _ := svcRes["daemon_app_path"].(string)
			if appPath == "" || cdhash1 == "" || svcRes["daemon_app_signed"] != true {
				t.Fatalf("expected signed AhubDaemon.app with cdhash on darwin: %+v", svcRes)
			}
			if out, err := exec.Command("/usr/bin/codesign", "--verify", "--deep", "--strict", appPath).CombinedOutput(); err != nil {
				t.Fatalf("codesign verify failed: %v\n%s", err, string(out))
			}
			code2, stdout2, stderr2 := h.runCLI("", "--json", "node", "service", "install", "--bin", h.ahubBin, "--target-dir", svcDir)
			if code2 != 0 {
				t.Fatalf("second service install failed (%d): %s %s", code2, stdout2, stderr2)
			}
			var svcRes2 map[string]interface{}
			if err := json.Unmarshal([]byte(stdout2), &svcRes2); err != nil {
				t.Fatal(err)
			}
			if svcRes2["daemon_app_cdhash"] != cdhash1 {
				t.Fatalf("AhubDaemon.app CDHash drifted across idempotent install: %q vs %q", cdhash1, svcRes2["daemon_app_cdhash"])
			}
		}

		// 4. Queues webhook notification delivery on --notify webhook
		rec := h.mustRunCLIJSON(`{"directives":[{"op":"sleep","ms":30}]}`,
			"run", "--node", "macmini", "--dir", alphaDir, "--agent", "agy", "--notify", "webhook", "--wait", "0s", "-")
		if rec.WebhookArmed == nil || !*rec.WebhookArmed {
			t.Fatalf("expected webhook_armed=true when --notify webhook")
		}
		select {
		case hookPayload := <-h.webhookCh:
			if hookPayload["event"] != "ahub_run_completed" || hookPayload["run_id"] != rec.ID {
				t.Fatalf("unexpected webhook payload: %+v", hookPayload)
			}
		case <-time.After(8 * time.Second):
			t.Fatalf("did not receive local Queue webhook callback within 8s")
		}
		// Verify D1 notify_status == sent
		deadline := time.Now().Add(3 * time.Second)
		for {
			r, err := client.GetRun(context.Background(), rec.ID, false, 1024)
			if err == nil && r.NotifyStatus == "sent" {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("expected notify_status=sent, got %+v", r)
			}
			time.Sleep(100 * time.Millisecond)
		}

		// 5. N independent Grok Bots (1:1 / N:1 / M:N) + PATCH /api/v1/keys/:id + fail-closed isolation
		type botHit struct {
			Auth    string
			Payload map[string]interface{}
		}
		botAlphaCh := make(chan botHit, 8)
		botBetaCh := make(chan botHit, 8)
		makeBotServer := func(ch chan botHit) *httptest.Server {
			return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]interface{}
				_ = json.NewDecoder(r.Body).Decode(&body)
				ch <- botHit{Auth: r.Header.Get("Authorization"), Payload: body}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"ok":true}`))
			}))
		}
		botAlphaSrv := makeBotServer(botAlphaCh)
		defer botAlphaSrv.Close()
		botBetaSrv := makeBotServer(botBetaCh)
		defer botBetaSrv.Close()

		botAlphaKeyID, botAlphaTok := h.createKeyWithWebhook("grok-bot-alpha", "client", "", []string{"macmini"}, 1, botAlphaSrv.URL+"/hook", "sec_alpha_1")
		_, botBetaTok := h.createKeyWithWebhook("grok-bot-beta", "client", "", []string{"mbp"}, 1, botBetaSrv.URL+"/hook", "sec_beta_2")

		// Enforce allowed_nodes isolation: bot-alpha cannot dispatch to mbp
		forbCode, _, forbErr := h.runCLI(`{"directives":[{"op":"sleep","ms":10}]}`,
			"--token", botAlphaTok, "--json", "run", "--node", "mbp", "--dir", mbpDir, "--agent", "agy", "-")
		if forbCode != api.ExitPolicyDenied {
			t.Fatalf("expected ExitPolicyDenied (78) for bot-alpha targeting mbp, got %d (%s)", forbCode, forbErr)
		}

		alphaRun := h.mustRunCLIJSON(`{"directives":[{"op":"sleep","ms":20}]}`,
			"--token", botAlphaTok, "run", "--node", "macmini", "--dir", alphaDir, "--agent", "agy", "--notify", "grok", "--wait", "0s", "-")
		betaRun := h.mustRunCLIJSON(`{"directives":[{"op":"sleep","ms":20}]}`,
			"--token", botBetaTok, "run", "--node", "mbp", "--dir", mbpDir, "--agent", "agy", "--notify", "grok", "--wait", "0s", "-")

		select {
		case hit := <-botAlphaCh:
			if hit.Auth != "Bearer sec_alpha_1" || hit.Payload["run_id"] != alphaRun.ID {
				t.Fatalf("unexpected bot-alpha hit: %+v", hit)
			}
		case <-time.After(8 * time.Second):
			t.Fatalf("bot-alpha webhook not delivered within 8s")
		}
		select {
		case hit := <-botBetaCh:
			if hit.Auth != "Bearer sec_beta_2" || hit.Payload["run_id"] != betaRun.ID {
				t.Fatalf("unexpected bot-beta hit: %+v", hit)
			}
		case <-time.After(8 * time.Second):
			t.Fatalf("bot-beta webhook not delivered within 8s")
		}
		// Assert zero cross-talk onto global webhookSrv
		select {
		case stray := <-h.webhookCh:
			t.Fatalf("multi-bot webhook leaked onto global webhook: %+v", stray)
		case <-time.After(150 * time.Millisecond):
		}

		// PATCH /api/v1/keys/:id upgrades bot-alpha to manage ["macmini", "mbp"] and rotates webhook secret
		patchBody, _ := json.Marshal(map[string]interface{}{
			"allowed_nodes": []string{"macmini", "mbp"},
			"webhook_url":   botAlphaSrv.URL + "/v2",
			"webhook_key":   "sec_alpha_v2",
		})
		patchReq, _ := http.NewRequest(http.MethodPatch, h.hubURL+"/api/v1/keys/"+botAlphaKeyID, bytes.NewReader(patchBody))
		patchReq.Header.Set("Authorization", "Bearer "+h.adminToken)
		patchReq.Header.Set("Content-Type", "application/json")
		patchResp, err := http.DefaultClient.Do(patchReq)
		if err != nil {
			t.Fatal(err)
		}
		patchRaw, _ := io.ReadAll(patchResp.Body)
		patchResp.Body.Close()
		if patchResp.StatusCode != 200 {
			t.Fatalf("PATCH /api/v1/keys failed (%d): %s", patchResp.StatusCode, string(patchRaw))
		}

		alphaMbpRun := h.mustRunCLIJSON(`{"directives":[{"op":"sleep","ms":20}]}`,
			"--token", botAlphaTok, "run", "--node", "mbp", "--dir", mbpDir, "--agent", "agy", "--notify", "grok", "--wait", "0s", "-")
		select {
		case hit := <-botAlphaCh:
			if hit.Auth != "Bearer sec_alpha_v2" || hit.Payload["run_id"] != alphaMbpRun.ID {
				t.Fatalf("unexpected rotated bot-alpha hit: %+v", hit)
			}
		case <-time.After(8 * time.Second):
			t.Fatalf("rotated bot-alpha webhook not delivered within 8s")
		}

		// 6. node shim + SIGHUP graceful drain & reload while run is in-flight (Unix)
		if runtime.GOOS != "windows" {
			shimTok := h.createKey("shim-node-key", "node", "shim-node", []string{"shim-node"}, 0)
			shimRoot := filepath.Join(h.tmpDir, "workspaces", "shim-root")
			shimProj := h.makeWorkspaceDir(filepath.Join("shim-root", "proj-shim"))
			shimCfgDir := filepath.Join(h.tmpDir, "shim-cfg")
			if err := os.MkdirAll(shimCfgDir, 0o700); err != nil {
				t.Fatal(err)
			}
			shimCfgPath := filepath.Join(shimCfgDir, "node.json")
			shimCfg := config.NodeConfig{
				NodeID:               "shim-node",
				DisplayName:          "shim-node",
				HubURL:               h.hubURL,
				Token:                shimTok,
				MaxConcurrency:       1,
				HeartbeatIntervalSec: 1,
				ProjectRoots:         []string{shimRoot},
				SkipDirs:             []string{"node_modules", ".git"},
				Agents: map[string]config.AgentConfig{
					"agy": {Enabled: true, Command: h.fakeAgentBin},
				},
			}
			shimRaw, _ := json.MarshalIndent(shimCfg, "", "  ")
			if err := os.WriteFile(shimCfgPath, shimRaw, 0o600); err != nil {
				t.Fatal(err)
			}

			shimLogs := &bytes.Buffer{}
			shimCmd := exec.Command(h.ahubBin, "node", "shim", "--bin", h.ahubBin, "--config", shimCfgPath)
			shimCmd.Env = append(os.Environ(),
				"AHUB_CONFIG_DIR="+shimCfgDir,
				"AHUB_FAKEAGENT_LOG="+h.fakeLogPath,
			)
			shimCmd.Stdout = shimLogs
			shimCmd.Stderr = shimLogs
			shimCmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
			if err := shimCmd.Start(); err != nil {
				t.Fatalf("start node shim failed: %v", err)
			}
			defer func() {
				if shimCmd.Process != nil {
					_ = syscall.Kill(-shimCmd.Process.Pid, syscall.SIGKILL)
					_, _ = shimCmd.Process.Wait()
				}
			}()

			var oldRec daemon.PIDRecord
			pidDeadline := time.Now().Add(8 * time.Second)
			for {
				if rec, live := daemon.ReadLiveDaemonPID(shimCfgPath); live {
					nodes, _ := client.ListNodes(context.Background(), true)
					for _, n := range nodes {
						if n.ID == "shim-node" && n.Status == "online" {
							oldRec = rec
							break
						}
					}
					if oldRec.PID > 0 {
						break
					}
				}
				if time.Now().After(pidDeadline) {
					t.Fatalf("shim-node did not write live node.pid and come online; logs:\n%s", shimLogs.String())
				}
				time.Sleep(100 * time.Millisecond)
			}

			inFlight := h.mustRunCLIJSON(`{"directives":[{"op":"sleep","ms":450}]}`,
				"run", "--node", "shim-node", "--dir", shimProj, "--agent", "agy", "--wait", "0s", "-")
			runStartDeadline := time.Now().Add(5 * time.Second)
			for {
				cur, err := client.GetRun(context.Background(), inFlight.ID, false, 1024)
				if err == nil && (cur.Status == "claimed" || cur.Status == "running") {
					break
				}
				if time.Now().After(runStartDeadline) {
					t.Fatalf("in-flight run did not get claimed before SIGHUP: %+v", cur)
				}
				time.Sleep(40 * time.Millisecond)
			}

			if err := daemon.SendReloadSignal(oldRec.PID); err != nil {
				t.Fatalf("SendReloadSignal(%d): %v", oldRec.PID, err)
			}

			// In-flight run MUST still drain and complete done cleanly before exit(42)
			doneDeadline := time.Now().Add(8 * time.Second)
			for {
				cur, err := client.GetRun(context.Background(), inFlight.ID, false, 1024)
				if err == nil && cur.Status == "done" {
					break
				}
				if time.Now().After(doneDeadline) {
					t.Fatalf("in-flight run failed to complete during SIGHUP drain: %+v; logs:\n%s", cur, shimLogs.String())
				}
				time.Sleep(80 * time.Millisecond)
			}

			// node shim must spawn a NEW child ahub node serve PID cleanly
			respawnDeadline := time.Now().Add(8 * time.Second)
			for {
				if rec, live := daemon.ReadLiveDaemonPID(shimCfgPath); live && rec.PID != oldRec.PID {
					nodes, _ := client.ListNodes(context.Background(), true)
					online := false
					for _, n := range nodes {
						if n.ID == "shim-node" && n.Status == "online" {
							online = true
							break
						}
					}
					if online {
						break
					}
				}
				if time.Now().After(respawnDeadline) {
					t.Fatalf("node shim did not respawn a new child PID (old=%d); logs:\n%s", oldRec.PID, shimLogs.String())
				}
				time.Sleep(100 * time.Millisecond)
			}
		}
	})
}
