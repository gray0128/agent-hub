package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/gray0128/agent-hub/internal/api"
	"github.com/gray0128/agent-hub/internal/config"
)

func writeTempNodeConfig(t *testing.T, cfg config.NodeConfig) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "node.json")
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestNativeEmitSkipsInsideAhubRunAndWhenDisabled(t *testing.T) {
	t.Setenv("AHUB_RUN_ID", "run_parent_123")
	t.Setenv("AHUB_DEPTH", "1")
	code, out := captureExecute(t, []string{"--json", "native-emit", "--from-hook", "claude"}, `{"hook_event_name":"Stop"}`)
	if code != 0 || !strings.Contains(out, "inside_ahub_run") {
		t.Fatalf("expected inside_ahub_run skip, got code=%d out=%s", code, out)
	}

	t.Setenv("AHUB_RUN_ID", "")
	t.Setenv("AHUB_DEPTH", "")
	cfgPath := writeTempNodeConfig(t, config.NodeConfig{
		NodeID: "macmini",
		HubURL: "http://127.0.0.1:9",
		Token:  "ahub_nod_test",
	})
	code2, out2 := captureExecute(t, []string{"--json", "native-emit", "--config", cfgPath, "--from-hook", "claude"}, `{"hook_event_name":"Stop","last_assistant_message":"hi"}`)
	if code2 != 0 || !strings.Contains(out2, "native_notify_disabled") {
		t.Fatalf("expected native_notify_disabled skip, got code=%d out=%s", code2, out2)
	}
}

func TestNativeEmitClaudeCodexAgyPiAdaptersRedactAndRespectScope(t *testing.T) {
	var received []api.NativeEventRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/nodes/macmini/native-events" {
			http.NotFound(w, r)
			return
		}
		var req api.NativeEventRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatal(err)
		}
		received = append(received, req)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(api.NativeEventResponse{
			OK: true,
			Event: api.NativeEventRecord{
				ID:           "evt_01TEST",
				NodeID:       "macmini",
				EventID:      req.EventID,
				NotifyStatus: "queued",
			},
		})
	}))
	defer srv.Close()

	allowedRoot := filepath.Join(t.TempDir(), "workspace")
	if err := os.MkdirAll(filepath.Join(allowedRoot, "demo"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfgPath := writeTempNodeConfig(t, config.NodeConfig{
		NodeID: "macmini",
		HubURL: srv.URL,
		Token:  "ahub_nod_test_token",
		NativeNotify: &config.NativeNotifyConfig{
			Enabled:      true,
			AllowedRoots: []string{allowedRoot},
		},
	})

	t.Setenv("AHUB_RUN_ID", "")
	t.Setenv("AHUB_DEPTH", "")

	// 1. Claude Notification hook -> interaction_needed + redacted before leaving node
	claudeNotif := `{"session_id":"sess_c1","cwd":` + jsonQuote(filepath.Join(allowedRoot, "demo")) + `,"hook_event_name":"Notification","notification_type":"permission_prompt","title":"Need approval","message":"Confirm run with token ahub_cli_secret777"}`
	code1, out1 := captureExecute(t, []string{"--json", "native-emit", "--config", cfgPath, "--from-hook", "claude"}, claudeNotif)
	if code1 != 0 {
		t.Fatalf("claude Notification failed: code=%d out=%s", code1, out1)
	}

	// 2. Claude Stop hook with stop_hook_active=true -> skipped (anti-loop)
	claudeLoop := `{"session_id":"sess_c1","cwd":` + jsonQuote(filepath.Join(allowedRoot, "demo")) + `,"hook_event_name":"Stop","stop_hook_active":true,"last_assistant_message":"loop"}`
	codeLoop, outLoop := captureExecute(t, []string{"--json", "native-emit", "--config", cfgPath, "--from-hook", "claude"}, claudeLoop)
	if codeLoop != 0 || !strings.Contains(outLoop, "stop_hook_active") {
		t.Fatalf("expected stop_hook_active skip, got code=%d out=%s", codeLoop, outLoop)
	}

	// 3. Workdir outside allowed_roots -> skipped without sending to hub
	outside := `{"session_id":"sess_c2","cwd":"/etc","hook_event_name":"Stop","last_assistant_message":"outside"}`
	codeOut, outOut := captureExecute(t, []string{"--json", "native-emit", "--config", cfgPath, "--from-hook", "claude"}, outside)
	if codeOut != 0 || !strings.Contains(outOut, "workdir_outside_allowed_roots") {
		t.Fatalf("expected workdir_outside_allowed_roots skip, got code=%d out=%s", codeOut, outOut)
	}

	// 4. Codex notify hook via trailing arg
	codexPayload := `{"type":"agent-turn-complete","thread-id":"thr_x1","turn-id":"turn_9","cwd":` + jsonQuote(filepath.Join(allowedRoot, "demo")) + `,"input-messages":["Check build"],"last-assistant-message":"All tests passed"}`
	codeCodex, outCodex := captureExecute(t, []string{"--json", "native-emit", "--config", cfgPath, "--from-hook", "codex", codexPayload}, "")
	if codeCodex != 0 {
		t.Fatalf("codex notify failed: code=%d out=%s", codeCodex, outCodex)
	}

	// 5. Agy Stop hook (default without reading transcriptPath)
	agyPayload := `{"conversationId":"conv_a1","executionNum":2,"terminationReason":"NO_TOOL_CALL","lastUserInput":"Fix bug password=secretpw","cwd":` + jsonQuote(filepath.Join(allowedRoot, "demo")) + `,"hookEventName":"Stop"}`
	codeAgy, outAgy := captureExecute(t, []string{"--json", "native-emit", "--config", cfgPath, "--from-hook", "agy"}, agyPayload)
	if codeAgy != 0 {
		t.Fatalf("agy stop failed: code=%d out=%s", codeAgy, outAgy)
	}

	// 6. Pi extension event
	piPayload := `{"session_id":"pi_1","turn_id":"t_3","cwd":` + jsonQuote(filepath.Join(allowedRoot, "demo")) + `,"event_kind":"turn_summary","summary":"Pi finished refactor"}`
	codePi, outPi := captureExecute(t, []string{"--json", "native-emit", "--config", cfgPath, "--from-hook", "pi"}, piPayload)
	if codePi != 0 {
		t.Fatalf("pi hook failed: code=%d out=%s", codePi, outPi)
	}

	if len(received) != 4 {
		t.Fatalf("expected 4 emitted native events, got %d: %+v", len(received), received)
	}
	if received[0].EventKind != "interaction_needed" || strings.Contains(received[0].Summary, "secret777") || !strings.Contains(received[0].Summary, "ahub_cli_[REDACTED]") {
		t.Fatalf("unexpected claude redacted event: %+v", received[0])
	}
	if received[1].Agent != "codex" || received[1].EventKind != "turn_summary" {
		t.Fatalf("unexpected codex event: %+v", received[1])
	}
	if received[2].Agent != "agy" || strings.Contains(received[2].Title, "secretpw") || strings.Contains(received[2].Summary, "secretpw") {
		t.Fatalf("unexpected or unredacted agy event: %+v", received[2])
	}
	if received[3].Agent != "pi" || received[3].Summary != "Pi finished refactor" {
		t.Fatalf("unexpected pi event: %+v", received[3])
	}
}

func jsonQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func TestNativeEmitIgnoresEnvPoisoningAndUsesNodeTokenOnly(t *testing.T) {
	var seenAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(api.NativeEventResponse{
			OK: true,
			Event: api.NativeEventRecord{
				ID:           "evt_node_auth",
				NodeID:       "macmini",
				NotifyStatus: "queued",
			},
		})
	}))
	defer srv.Close()

	allowedRoot := filepath.Join(t.TempDir(), "workspace")
	demoDir := filepath.Join(allowedRoot, "demo")
	if err := os.MkdirAll(demoDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cfgPath := writeTempNodeConfig(t, config.NodeConfig{
		NodeID: "macmini",
		HubURL: srv.URL,
		Token:  "ahub_nod_real_secret_token",
		NativeNotify: &config.NativeNotifyConfig{
			Enabled:      true,
			AllowedRoots: []string{allowedRoot},
		},
	})

	t.Setenv("AHUB_RUN_ID", "")
	t.Setenv("AHUB_DEPTH", "")
	t.Setenv("AHUB_TOKEN", "ahub_cli_poisoned_must_be_ignored")
	t.Setenv("AHUB_URL", "http://127.0.0.1:1")

	code, out := captureExecute(t, []string{
		"--json", "native-emit",
		"--config", cfgPath,
		"--from-hook", "claude",
	}, `{"session_id":"sess_env","cwd":`+jsonQuote(demoDir)+`,"hook_event_name":"Stop","last_assistant_message":"ok"}`)
	if code != 0 {
		t.Fatalf("native-emit failed with poisoned env: code=%d out=%s", code, out)
	}
	if seenAuth != "Bearer ahub_nod_real_secret_token" {
		t.Fatalf("expected node token auth Bearer ahub_nod_real_secret_token, got %q", seenAuth)
	}
}

func TestNativeEmitAllowedRootsFallbackAndFailClosed(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(api.NativeEventResponse{
			OK: true,
			Event: api.NativeEventRecord{
				ID:           "evt_root_ok",
				NodeID:       "macmini",
				NotifyStatus: "queued",
			},
		})
	}))
	defer srv.Close()

	projectRoot := filepath.Join(t.TempDir(), "projects")
	allowedDir := filepath.Join(projectRoot, "app")
	if err := os.MkdirAll(allowedDir, 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("AHUB_RUN_ID", "")
	t.Setenv("AHUB_DEPTH", "")

	// Empty allowed_roots + empty project_roots -> fail closed
	emptyCfg := writeTempNodeConfig(t, config.NodeConfig{
		NodeID: "macmini",
		HubURL: srv.URL,
		Token:  "ahub_nod_test",
		NativeNotify: &config.NativeNotifyConfig{
			Enabled: true,
		},
	})
	codeClosed, outClosed := captureExecute(t, []string{
		"--json", "native-emit", "--config", emptyCfg, "--from-hook", "claude",
	}, `{"session_id":"s1","cwd":`+jsonQuote(allowedDir)+`,"hook_event_name":"Stop","last_assistant_message":"hi"}`)
	if codeClosed != 0 || !strings.Contains(outClosed, "workdir_outside_allowed_roots") || hits != 0 {
		t.Fatalf("expected fail-closed skip when both roots empty, got code=%d out=%s hits=%d", codeClosed, outClosed, hits)
	}

	// Empty allowed_roots falls back to project_roots
	fallbackCfg := writeTempNodeConfig(t, config.NodeConfig{
		NodeID:       "macmini",
		HubURL:       srv.URL,
		Token:        "ahub_nod_test",
		ProjectRoots: []string{projectRoot},
		NativeNotify: &config.NativeNotifyConfig{
			Enabled: true,
		},
	})
	codeOK, outOK := captureExecute(t, []string{
		"--json", "native-emit", "--config", fallbackCfg, "--from-hook", "claude",
	}, `{"session_id":"s1","cwd":`+jsonQuote(allowedDir)+`,"hook_event_name":"Stop","last_assistant_message":"hi"}`)
	if codeOK != 0 || hits != 1 {
		t.Fatalf("expected project_roots fallback to emit event, got code=%d out=%s hits=%d", codeOK, outOK, hits)
	}
}

func TestNativeEmitChecksWorkdirBeforeOpeningTranscriptAndStreamsPastOversizedLine(t *testing.T) {
	tmpDir := t.TempDir()
	allowedRoot := filepath.Join(tmpDir, "allowed")
	outsideDir := filepath.Join(tmpDir, "outside")
	if err := os.MkdirAll(allowedRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outsideDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// 1. Disallowed workdir must skip before opening transcriptPath (proven via blocking FIFO on POSIX)
	if runtime.GOOS != "windows" {
		fifoPath := filepath.Join(tmpDir, "trap.fifo")
		if err := syscall.Mkfifo(fifoPath, 0o600); err != nil {
			t.Fatal(err)
		}
		doneCh := make(chan string, 1)
		go func() {
			raw := `{"conversationId":"conv_1","executionNum":1,"terminationReason":"NO_TOOL_CALL","cwd":` + jsonQuote(outsideDir) + `,"transcriptPath":` + jsonQuote(fifoPath) + `,"hookEventName":"Stop"}`
			_, skip, err := parseAgyHookEvent(raw, true, []string{allowedRoot})
			if err != nil {
				doneCh <- "err:" + err.Error()
				return
			}
			doneCh <- skip
		}()
		select {
		case skip := <-doneCh:
			if skip != "workdir_outside_allowed_roots" {
				t.Fatalf("expected workdir_outside_allowed_roots, got %q", skip)
			}
		case <-time.After(500 * time.Millisecond):
			t.Fatalf("parseAgyHookEvent opened transcriptPath before checking workdir allowlist")
		}
	}

	// 2. Streaming transcript reader skips a >4MB (5MB) middle JSONL line and extracts subsequent PLANNER_RESPONSE
	transcriptPath := filepath.Join(tmpDir, "transcript.jsonl")
	f, err := os.Create(transcriptPath)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString(`{"step_index":1,"type":"PLANNER_RESPONSE","content":"earlier response"}` + "\n")
	_, _ = f.WriteString(`{"step_index":2,"type":"TOOL_OUTPUT","content":"` + strings.Repeat("Z", 5*1024*1024) + `"}` + "\n")
	_, _ = f.WriteString(`{"step_index":3,"type":"PLANNER_RESPONSE","content":"final streamed answer"}` + "\n")
	_ = f.Close()

	gotContent, gotStep, gotLines := readLastAssistantFromAgyTranscript(transcriptPath)
	if gotContent != "final streamed answer" || gotStep != 3 || gotLines != 3 {
		t.Fatalf("unexpected streaming transcript parse: content=%q step=%d lines=%d", gotContent, gotStep, gotLines)
	}
}

func TestNativeEmitEventIDDisambiguationAndOverride(t *testing.T) {
	tmpDir := t.TempDir()
	allowedRoot := filepath.Join(tmpDir, "ws")
	if err := os.MkdirAll(allowedRoot, 0o755); err != nil {
		t.Fatal(err)
	}

	origNow := nativeEmitNow
	defer func() { nativeEmitNow = origNow }()

	fixedTime := time.Unix(1700000010, 0)
	nativeEmitNow = func() time.Time { return fixedTime }

	notifJSON := `{"session_id":"sess_repeat","cwd":` + jsonQuote(allowedRoot) + `,"hook_event_name":"Notification","notification_type":"permission_prompt","message":"Approve step"}`
	req1, skip1, err := parseClaudeHookEvent(notifJSON, []string{allowedRoot})
	if err != nil || skip1 != "" {
		t.Fatalf("req1 failed: skip=%q err=%v", skip1, err)
	}
	reqSameBucket, _, err := parseClaudeHookEvent(notifJSON, []string{allowedRoot})
	if err != nil {
		t.Fatal(err)
	}
	if req1.EventID != reqSameBucket.EventID {
		t.Fatalf("expected same 15s bucket to deduplicate, got %q != %q", req1.EventID, reqSameBucket.EventID)
	}

	// Next 15s bucket yields distinct event_id
	fixedTime = fixedTime.Add(20 * time.Second)
	reqNextBucket, _, err := parseClaudeHookEvent(notifJSON, []string{allowedRoot})
	if err != nil {
		t.Fatal(err)
	}
	if req1.EventID == reqNextBucket.EventID {
		t.Fatalf("expected distinct event_id across 15s buckets, got %q", req1.EventID)
	}

	// Agy Stop with executionNum=0 uses time bucket when transcript absent
	agyStop := `{"conversationId":"conv_zero","executionNum":0,"terminationReason":"NO_TOOL_CALL","lastUserInput":"hello","cwd":` + jsonQuote(allowedRoot) + `,"hookEventName":"Stop"}`
	agy1, _, err := parseAgyHookEvent(agyStop, false, []string{allowedRoot})
	if err != nil {
		t.Fatal(err)
	}
	fixedTime = fixedTime.Add(20 * time.Second)
	agy2, _, err := parseAgyHookEvent(agyStop, false, []string{allowedRoot})
	if err != nil {
		t.Fatal(err)
	}
	if agy1.EventID == agy2.EventID {
		t.Fatalf("expected distinct agy event_id across buckets when executionNum=0, got %q", agy1.EventID)
	}

	// --event-id overrides deterministic id even in --from-hook claude mode
	var capturedID string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req api.NativeEventRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatal(err)
		}
		capturedID = req.EventID
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(api.NativeEventResponse{
			OK:    true,
			Event: api.NativeEventRecord{ID: "evt_override", EventID: req.EventID, NotifyStatus: "queued"},
		})
	}))
	defer srv.Close()

	cfgPath := writeTempNodeConfig(t, config.NodeConfig{
		NodeID:       "macmini",
		HubURL:       srv.URL,
		Token:        "ahub_nod_override",
		NativeNotify: &config.NativeNotifyConfig{Enabled: true, AllowedRoots: []string{allowedRoot}},
	})
	t.Setenv("AHUB_RUN_ID", "")
	t.Setenv("AHUB_DEPTH", "")
	t.Setenv("AHUB_TOKEN", "")
	t.Setenv("AHUB_URL", "")

	code, out := captureExecute(t, []string{
		"--json", "native-emit", "--config", cfgPath, "--from-hook", "claude", "--event-id", "custom_evt_123",
	}, notifJSON)
	if code != 0 || capturedID != "custom_evt_123" {
		t.Fatalf("expected --event-id override custom_evt_123, got code=%d id=%q out=%s", code, capturedID, out)
	}
}

func TestNativeEmitGrokOmpIdlePromptAndAgyRefinements(t *testing.T) {
	var received []api.NativeEventRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req api.NativeEventRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatal(err)
		}
		received = append(received, req)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(api.NativeEventResponse{
			OK:    true,
			Event: api.NativeEventRecord{ID: "evt_refinement", EventID: req.EventID, NotifyStatus: "queued"},
		})
	}))
	defer srv.Close()

	tmpDir := t.TempDir()
	allowedRoot := filepath.Join(tmpDir, "workspace")
	demoDir := filepath.Join(allowedRoot, "demo")
	if err := os.MkdirAll(demoDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cfgPath := writeTempNodeConfig(t, config.NodeConfig{
		NodeID: "macmini",
		HubURL: srv.URL,
		Token:  "ahub_nod_test_token",
		NativeNotify: &config.NativeNotifyConfig{
			Enabled:                  true,
			AllowedRoots:             []string{allowedRoot},
			IncludeTranscriptSummary: true,
		},
	})

	t.Setenv("AHUB_RUN_ID", "")
	t.Setenv("AHUB_DEPTH", "")
	t.Setenv("AHUB_TOKEN", "")
	t.Setenv("AHUB_URL", "")

	// 1. Claude idle_prompt -> skipped
	claudeIdle := `{"session_id":"sess_c_idle","cwd":` + jsonQuote(demoDir) + `,"hook_event_name":"Notification","notification_type":"idle_prompt","message":"Waiting for your next prompt"}`
	code, out := captureExecute(t, []string{"--json", "native-emit", "--config", cfgPath, "--from-hook", "claude"}, claudeIdle)
	if code != 0 || !strings.Contains(out, "idle_prompt") {
		t.Fatalf("expected claude idle_prompt skip, got code=%d out=%s", code, out)
	}

	// 2. Grok idle_prompt -> skipped
	grokIdle := `{"session_id":"sess_g1","cwd":` + jsonQuote(demoDir) + `,"hook_event_name":"Notification","notification_type":"idle_prompt","message":"Waiting for input"}`
	code, out = captureExecute(t, []string{"--json", "native-emit", "--config", cfgPath, "--from-hook", "grok"}, grokIdle)
	if code != 0 || !strings.Contains(out, "idle_prompt") {
		t.Fatalf("expected grok idle_prompt skip, got code=%d out=%s", code, out)
	}

	// 3. Grok stopHookActive (camelCase) -> skipped
	grokLoop := `{"sessionId":"sess_g1","workspaceRoot":` + jsonQuote(demoDir) + `,"hookEventName":"stop","stopHookActive":true,"lastAssistantMessage":"loop"}`
	code, out = captureExecute(t, []string{"--json", "native-emit", "--config", cfgPath, "--from-hook", "grok"}, grokLoop)
	if code != 0 || !strings.Contains(out, "stop_hook_active") {
		t.Fatalf("expected grok stop_hook_active skip, got code=%d out=%s", code, out)
	}

	// 4. Grok camelCase Stop + snake_case Notification (permission_prompt) -> emitted
	grokStop := `{"sessionId":"sess_g2","workspaceRoot":` + jsonQuote(demoDir) + `,"hookEventName":"stop","promptId":"p_42","lastAssistantMessage":"Grok completed refactor with token ahub_cli_secret999"}`
	code, out = captureExecute(t, []string{"--json", "native-emit", "--config", cfgPath, "--from-hook", "grok"}, grokStop)
	if code != 0 {
		t.Fatalf("grok stop failed: code=%d out=%s", code, out)
	}
	grokPerm := `{"session_id":"sess_g2","cwd":` + jsonQuote(demoDir) + `,"hook_event_name":"Notification","notification_type":"permission_prompt","prompt_id":"p_43","title":"Approval Needed","message":"Allow bash command"}`
	code, out = captureExecute(t, []string{"--json", "native-emit", "--config", cfgPath, "--from-hook", "grok"}, grokPerm)
	if code != 0 {
		t.Fatalf("grok permission notification failed: code=%d out=%s", code, out)
	}

	// 5. --from-hook omp -> emits agent=omp source=omp-ext
	ompEvt := `{"session_id":"omp_1","turn_id":"t_1","cwd":` + jsonQuote(demoDir) + `,"event_kind":"turn_summary","summary":"OMP turn finished"}`
	code, out = captureExecute(t, []string{"--json", "native-emit", "--config", cfgPath, "--from-hook", "omp"}, ompEvt)
	if code != 0 {
		t.Fatalf("omp hook failed: code=%d out=%s", code, out)
	}

	// 6. Agy fullyIdle=false -> skipped
	agyNotIdle := `{"conversationId":"conv_busy","executionNum":1,"fullyIdle":false,"terminationReason":"NO_TOOL_CALL","cwd":` + jsonQuote(demoDir) + `,"hookEventName":"Stop"}`
	code, out = captureExecute(t, []string{"--json", "native-emit", "--config", cfgPath, "--from-hook", "agy"}, agyNotIdle)
	if code != 0 || !strings.Contains(out, "not_fully_idle") {
		t.Fatalf("expected agy not_fully_idle skip, got code=%d out=%s", code, out)
	}

	// 7. Agy exit_plan_mode -> skipped
	exitPlanTranscript := filepath.Join(tmpDir, "exit-plan.jsonl")
	_ = os.WriteFile(exitPlanTranscript, []byte(
		`{"step_index":1,"type":"PLANNER_RESPONSE","content":"Drafting plan","tool_calls":[{"name":"exit_plan_mode","args":{"plan":"step 1"}}]}`+"\n",
	), 0o600)
	agyExitPlan := `{"conversationId":"conv_plan","executionNum":2,"fullyIdle":true,"terminationReason":"TERMINAL_STEP_TYPE","cwd":` + jsonQuote(demoDir) + `,"transcriptPath":` + jsonQuote(exitPlanTranscript) + `,"hookEventName":"Stop"}`
	code, out = captureExecute(t, []string{"--json", "native-emit", "--config", cfgPath, "--from-hook", "agy"}, agyExitPlan)
	if code != 0 || !strings.Contains(out, "exit_plan_mode_handoff") {
		t.Fatalf("expected agy exit_plan_mode_handoff skip, got code=%d out=%s", code, out)
	}

	// 8. Agy ask_question -> emits interaction_needed with extracted question text
	askTranscript := filepath.Join(tmpDir, "ask-question.jsonl")
	_ = os.WriteFile(askTranscript, []byte(
		`{"step_index":1,"type":"PLANNER_RESPONSE","content":"Need clarification before editing.","tool_calls":[{"name":"ask_question","args":{"questions":[{"question":"Which environment?"},{"question":"Run deploy?"}]}}]}`+"\n",
	), 0o600)
	agyAsk := `{"conversationId":"conv_ask","executionNum":3,"fullyIdle":true,"terminationReason":"TERMINAL_STEP_TYPE","cwd":` + jsonQuote(demoDir) + `,"transcriptPath":` + jsonQuote(askTranscript) + `,"hookEventName":"Stop"}`
	code, out = captureExecute(t, []string{"--json", "native-emit", "--config", cfgPath, "--from-hook", "agy"}, agyAsk)
	if code != 0 {
		t.Fatalf("agy ask_question failed: code=%d out=%s", code, out)
	}

	if len(received) != 4 {
		t.Fatalf("expected 4 emitted events, got %d: %+v", len(received), received)
	}
	if received[0].Agent != "grok" || received[0].EventKind != "turn_summary" || received[0].Source != "grok-hook" || strings.Contains(received[0].Summary, "secret999") {
		t.Fatalf("unexpected grok stop event: %+v", received[0])
	}
	if received[1].Agent != "grok" || received[1].EventKind != "interaction_needed" || received[1].Source != "grok-hook" || received[1].Summary != "Allow bash command" {
		t.Fatalf("unexpected grok notification event: %+v", received[1])
	}
	if received[2].Agent != "omp" || received[2].Source != "omp-ext" || received[2].Title != "OMP 会话总结" {
		t.Fatalf("unexpected omp event: %+v", received[2])
	}
	if received[3].Agent != "agy" || received[3].EventKind != "interaction_needed" || received[3].Title != "Antigravity 等待回答" || !strings.Contains(received[3].Summary, "Which environment?") || !strings.Contains(received[3].Summary, "Need clarification before editing.") {
		t.Fatalf("unexpected agy ask_question event: %+v", received[3])
	}
}

func TestNativeEmitCLIProgressAndTitleDisambiguation(t *testing.T) {
	var received []api.NativeEventRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req api.NativeEventRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatal(err)
		}
		received = append(received, req)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(api.NativeEventResponse{
			OK: true,
			Event: api.NativeEventRecord{
				ID:           "evt_01PROG",
				NodeID:       "macmini",
				EventID:      req.EventID,
				Agent:        req.Agent,
				EventKind:    req.EventKind,
				NotifyStatus: "queued",
			},
		})
	}))
	defer srv.Close()

	tmpDir := t.TempDir()
	projectRoot := filepath.Join(tmpDir, "workspace")
	demoDir := filepath.Join(projectRoot, "demo")
	if err := os.MkdirAll(demoDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Empty AllowedRoots falls back to ProjectRoots
	cfgPath := writeTempNodeConfig(t, config.NodeConfig{
		NodeID:       "macmini",
		HubURL:       srv.URL,
		Token:        "ahub_nod_real_token",
		ProjectRoots: []string{projectRoot},
		NativeNotify: &config.NativeNotifyConfig{
			Enabled: true,
		},
	})

	t.Setenv("AHUB_RUN_ID", "")
	t.Setenv("AHUB_DEPTH", "")
	t.Setenv("AHUB_TOKEN", "ahub_cli_poisoned_token")
	t.Setenv("AHUB_URL", "http://127.0.0.1:1")

	// 1. --kind progress with --summary - (stdin) & distinct --title produces distinct EventIDs
	code1, out1 := captureExecute(t, []string{
		"--json", "native-emit",
		"--config", cfgPath,
		"--agent", "codex",
		"--kind", "progress",
		"--session-id", "sess_p1",
		"--dir", demoDir,
		"--title", "Stage 1/3 token=title_secret_1",
		"--summary", "-",
	}, "Completed unit tests with ahub_cli_secret_summary")
	if code1 != 0 {
		t.Fatalf("stage 1 progress emit failed: code=%d out=%s", code1, out1)
	}

	code2, out2 := captureExecute(t, []string{
		"--json", "native-emit",
		"--config", cfgPath,
		"--agent", "codex",
		"--kind", "progress",
		"--session-id", "sess_p1",
		"--dir", demoDir,
		"--title", "Stage 2/3",
		"--summary", "-",
	}, "Completed unit tests with ahub_cli_secret_summary")
	if code2 != 0 {
		t.Fatalf("stage 2 progress emit failed: code=%d out=%s", code2, out2)
	}

	// 2. Omitting --title keeps exact 4-part deterministicEventID
	code3, out3 := captureExecute(t, []string{
		"--json", "native-emit",
		"--config", cfgPath,
		"--agent", "codex",
		"--kind", "progress",
		"--session-id", "sess_p1",
		"--dir", demoDir,
		"--summary", "No title progress",
	}, "")
	if code3 != 0 {
		t.Fatalf("no-title progress emit failed: code=%d out=%s", code3, out3)
	}

	if len(received) != 3 {
		t.Fatalf("expected 3 received requests, got %d", len(received))
	}
	if received[0].EventKind != "progress" || received[0].Source != "cli" {
		t.Fatalf("unexpected progress req: %+v", received[0])
	}
	if strings.Contains(received[0].Title, "title_secret_1") || strings.Contains(received[0].Summary, "secret_summary") {
		t.Fatalf("expected pre-egress redaction, got %+v", received[0])
	}
	if received[0].EventID == received[1].EventID {
		t.Fatalf("expected distinct EventIDs for distinct --title values, both got %q", received[0].EventID)
	}
	expectedNoTitleID := deterministicEventID("cli", "sess_p1", "progress", "No title progress")
	if received[2].EventID != expectedNoTitleID {
		t.Fatalf("expected 4-part EventID %q when --title omitted, got %q", expectedNoTitleID, received[2].EventID)
	}

	// 3. Invalid --kind rejected with ExitBadUsageOrInput (64)
	codeBadKind, _ := captureExecute(t, []string{
		"--json", "native-emit",
		"--config", cfgPath,
		"--agent", "claude",
		"--kind", "post_tool_use",
		"--dir", demoDir,
		"--summary", "Should fail",
	}, "")
	if codeBadKind != api.ExitBadUsageOrInput {
		t.Fatalf("expected ExitBadUsageOrInput (64) for invalid --kind, got %d", codeBadKind)
	}

	// 4. AHUB_RUN_ID skip still applies to --kind progress
	t.Setenv("AHUB_RUN_ID", "run_parent_999")
	codeSkip, outSkip := captureExecute(t, []string{
		"--json", "native-emit",
		"--config", cfgPath,
		"--agent", "codex",
		"--kind", "progress",
		"--dir", demoDir,
		"--summary", "Should skip",
	}, "")
	if codeSkip != 0 || !strings.Contains(outSkip, "inside_ahub_run") {
		t.Fatalf("expected inside_ahub_run skip for progress, got code=%d out=%s", codeSkip, outSkip)
	}
}
