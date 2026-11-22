package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/gray0128/agent-hub/internal/api"
	"github.com/gray0128/agent-hub/skills"
)

func TestPlanCommandFileStdinOverridesSanitizationAndErrors(t *testing.T) {
	var seenMethod, seenPath, seenIdem string
	var seenReq api.CreatePlanRequest

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenMethod = r.Method
		seenPath = r.URL.Path
		seenIdem = r.Header.Get("Idempotency-Key")
		w.Header().Set("Content-Type", "application/json")

		var req api.CreatePlanRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode plan request: %v", err)
		}
		seenReq = req

		switch req.IdempotencyKey {
		case "idem_cycle_1234":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"ok":false,"error":{"code":"DEPENDENCY_CYCLE_DETECTED","message":"cycle detected: a -> b -> a","next":["ahub plan --help"]}}`))
			return
		case "idem_depth_1234":
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"ok":false,"error":{"code":"DEPTH_LIMIT_EXCEEDED","message":"max_depth=1 exceeded"}}`))
			return
		}

		planID := "pln_01ABC"
		planKey := "step1"
		schedAt := "2026-11-22T01:00:00.000Z"
		topicID := req.BoardTopicID
		blocked := "SCHEDULED"
		emptyStr := ""
		longTail := strings.Repeat("z", 1800)

		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":      true,
			"plan_id": planID,
			"runs": []api.RunRecord{
				{
					ID:              "run_plan_1",
					ThreadID:        "thr_plan_1",
					RootRunID:       "run_plan_1",
					NodeID:          "macmini",
					Workdir:         "/w",
					Agent:           "agy",
					Status:          "waiting",
					LeaseOwner:      "internal_lease_secret",
					Prompt:          "Deploy with token ahub_cli_secretplan999\n" + longTail,
					PlanID:          &planID,
					PlanKey:         &planKey,
					ScheduledAt:     &schedAt,
					BoardTopicID:    &topicID,
					ActorProfile:    req.ActorProfile,
					BlockedReason:   &blocked,
					RetryOfRunID:    &emptyStr,
					DependsOnRunIDs: []string{},
					CreatedAt:       "2026-11-22T00:00:00.000Z",
					UpdatedAt:       "2026-11-22T00:00:00.000Z",
				},
			},
		})
	}))
	defer srv.Close()

	planJSON := `{
  "idempotency_key": "idem_json_123456",
  "board_topic_id": "top_fromJson1",
  "nodes": [
    {
      "key": "step1",
      "node_id": "macmini",
      "workdir": "~/workspace/demo",
      "agent": "agy",
      "prompt": "do step 1",
      "in_sec": 120
    }
  ]
}`

	// 1. From stdin ('-'), injecting AHUB_RUN_ID, falling back to AHUB_PROFILE, overriding --topic & --idempotency-key
	t.Setenv("AHUB_RUN_ID", "run_parent_99")
	t.Setenv("AHUB_PROFILE", "env-planner")
	code, out, errOut := captureExecuteFull(t, []string{
		"--url", srv.URL, "--token", "tok_test", "--json",
		"plan", "--file", "-", "--topic", "top_override1", "--idempotency-key", "idem_flag_override",
	}, planJSON)
	if code != api.ExitOK {
		t.Fatalf("plan stdin exit=%d out=%s err=%s", code, out, errOut)
	}
	if seenMethod != http.MethodPost || seenPath != "/api/v1/plans" {
		t.Fatalf("unexpected method/path: %s %s", seenMethod, seenPath)
	}
	if seenIdem != "idem_flag_override" || seenReq.IdempotencyKey != "idem_flag_override" {
		t.Fatalf("expected --idempotency-key override, got header=%q body=%q", seenIdem, seenReq.IdempotencyKey)
	}
	if seenReq.ParentRunID != "run_parent_99" {
		t.Fatalf("expected AHUB_RUN_ID injected into parent_run_id, got %q", seenReq.ParentRunID)
	}
	if seenReq.BoardTopicID != "top_override1" {
		t.Fatalf("expected --topic override, got %q", seenReq.BoardTopicID)
	}
	if seenReq.ActorProfile != "env-planner" {
		t.Fatalf("expected AHUB_PROFILE fallback, got %q", seenReq.ActorProfile)
	}
	for _, secret := range []string{"ahub_cli_secretplan999", "internal_lease_secret"} {
		if strings.Contains(out, secret) {
			t.Fatalf("plan output leaked %q: %s", secret, out)
		}
	}
	var res api.CreatePlanResponse
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("invalid single JSON from plan: %v (%s)", err, out)
	}
	if res.PlanID != "pln_01ABC" || len(res.Runs) != 1 || res.Runs[0].RetryOfRunID != nil {
		t.Fatalf("unexpected plan response or empty pointer not cleared: %+v", res)
	}
	if !strings.Contains(res.Runs[0].Prompt, "ahub_cli_[REDACTED]") || !strings.Contains(res.Runs[0].Prompt, "--full") {
		t.Fatalf("expected redacted & bounded prompt, got %q", res.Runs[0].Prompt)
	}

	// 2. From file path with explicit --as overriding AHUB_PROFILE
	tmpDir := t.TempDir()
	planPath := filepath.Join(tmpDir, "plan.json")
	if err := os.WriteFile(planPath, []byte(planJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	codeFile, outFile, _ := captureExecuteFull(t, []string{
		"--url", srv.URL, "--token", "tok_test", "--json",
		"plan", "--file", planPath, "--as", "explicit-actor",
	}, "")
	if codeFile != api.ExitOK {
		t.Fatalf("plan file exit=%d out=%s", codeFile, outFile)
	}
	if seenReq.ActorProfile != "explicit-actor" || seenReq.BoardTopicID != "top_fromJson1" {
		t.Fatalf("unexpected actor/topic from file plan: %+v", seenReq)
	}

	// 3. Server error DEPENDENCY_CYCLE_DETECTED -> exit 64 & human Next: hint on stderr
	codeCycle, outCycle, errCycle := captureExecuteFull(t, []string{
		"--url", srv.URL, "--token", "tok_test",
		"plan", "--file", planPath, "--idempotency-key", "idem_cycle_1234",
	}, "")
	if codeCycle != api.ExitBadUsageOrInput {
		t.Fatalf("expected exit 64 on DEPENDENCY_CYCLE_DETECTED, got %d (out=%s err=%s)", codeCycle, outCycle, errCycle)
	}
	if !strings.Contains(errCycle, "DEPENDENCY_CYCLE_DETECTED") || !strings.Contains(errCycle, "Next: ahub plan --help") {
		t.Fatalf("expected error and Next hint on stderr, got %q", errCycle)
	}

	// 4. Server error DEPTH_LIMIT_EXCEEDED -> exit 78
	codeDepth, outDepth, _ := captureExecuteFull(t, []string{
		"--url", srv.URL, "--token", "tok_test", "--json",
		"plan", "--file", planPath, "--idempotency-key", "idem_depth_1234",
	}, "")
	if codeDepth != api.ExitPolicyDenied {
		t.Fatalf("expected exit 78 on DEPTH_LIMIT_EXCEEDED, got %d (out=%s)", codeDepth, outDepth)
	}

	// 5. Local validation failures -> exit 64
	badCases := []struct {
		name  string
		args  []string
		stdin string
	}{
		{name: "missing_file_flag", args: []string{"--json", "plan"}},
		{name: "positional_arg", args: []string{"--json", "plan", "--file", planPath, "extra"}},
		{name: "nonexistent_file", args: []string{"--json", "plan", "--file", filepath.Join(tmpDir, "missing.json")}},
		{name: "unknown_json_field", args: []string{"--json", "plan", "--file", "-"}, stdin: `{"unknown_field":1,"nodes":[{"key":"a","node_id":"m","workdir":"/w","agent":"agy","prompt":"hi"}]}`},
		{name: "trailing_json", args: []string{"--json", "plan", "--file", "-"}, stdin: planJSON + `{"extra":1}`},
		{name: "empty_nodes", args: []string{"--json", "plan", "--file", "-"}, stdin: `{"nodes":[]}`},
		{name: "scheduled_and_in_sec", args: []string{"--json", "plan", "--file", "-"}, stdin: `{"nodes":[{"key":"a","node_id":"m","workdir":"/w","agent":"agy","prompt":"hi","scheduled_at":"2026-11-22T01:00:00Z","in_sec":120}]}`},
		{name: "invalid_topic", args: []string{"--json", "plan", "--file", planPath, "--topic", "bad_topic"}},
		{name: "invalid_as", args: []string{"--json", "plan", "--file", planPath, "--as", "INVALID PROFILE"}},
		{name: "short_idempotency_key", args: []string{"--json", "plan", "--file", planPath, "--idempotency-key", "short"}},
	}
	for _, tc := range badCases {
		c, o, _ := captureExecuteFull(t, tc.args, tc.stdin)
		if c != api.ExitBadUsageOrInput {
			t.Fatalf("%s: expected exit 64, got %d (out=%s)", tc.name, c, o)
		}
	}
}

func TestRetryCommandFlagsSanitizationAndErrors(t *testing.T) {
	var seenPath, seenIdem string
	var seenBody map[string]interface{}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		seenIdem = r.Header.Get("Idempotency-Key")
		seenBody = map[string]interface{}{}
		_ = json.NewDecoder(r.Body).Decode(&seenBody)
		w.Header().Set("Content-Type", "application/json")

		switch r.URL.Path {
		case "/api/v1/runs/run_done/retry":
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"ok":false,"error":{"code":"INVALID_STATE_TRANSITION","message":"only failed or cancelled runs can be retried"}}`))
		case "/api/v1/runs/run_forbidden/retry":
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"ok":false,"error":{"code":"FORBIDDEN_SCOPE","message":"forbidden"}}`))
		default:
			retryOf := "run_fail_1"
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok": true,
				"run": api.RunRecord{
					ID:           "run_retry_new",
					ThreadID:     "thr_1",
					RootRunID:    "run_root_1",
					RetryOfRunID: &retryOf,
					NodeID:       "macmini",
					Workdir:      "/w",
					Agent:        "agy",
					Status:       "queued",
					LeaseOwner:   "lease_leak",
					Prompt:       "Retry with ahub_cli_retrysecret99",
					ActorProfile: "ops",
					CreatedAt:    "2026-11-22T00:00:00Z",
					UpdatedAt:    "2026-11-22T00:00:00Z",
				},
				"rebound_run_ids": []string{"run_down_1"},
			})
		}
	}))
	defer srv.Close()

	// 1. Successful retry with model@effort, explicit timeout, --as, --idempotency-key
	code, out, _ := captureExecuteFull(t, []string{
		"--url", srv.URL, "--token", "tok_test", "--json",
		"retry", "run_fail_1", "--model", "carbon@high", "--timeout", "10m", "--as", "ops-lead", "--idempotency-key", "idem_retry_abcdef",
	}, "")
	if code != api.ExitOK {
		t.Fatalf("retry exit=%d out=%s", code, out)
	}
	if seenPath != "/api/v1/runs/run_fail_1/retry" || seenIdem != "idem_retry_abcdef" {
		t.Fatalf("unexpected retry path=%s idem=%q", seenPath, seenIdem)
	}
	if seenBody["model"] != "carbon" || seenBody["effort"] != "high" || seenBody["actor_profile"] != "ops-lead" {
		t.Fatalf("unexpected retry request body: %+v", seenBody)
	}
	if to, ok := seenBody["timeout_sec"].(float64); !ok || int(to) != 600 {
		t.Fatalf("expected timeout_sec=600, got %#v", seenBody["timeout_sec"])
	}
	if strings.Contains(out, "ahub_cli_retrysecret99") || strings.Contains(out, "lease_leak") {
		t.Fatalf("retry leaked secret or lease_owner: %s", out)
	}
	var res api.RetryRunResponse
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("decode retry output: %v (%s)", err, out)
	}
	if res.Run.ID != "run_retry_new" || len(res.ReboundRunIDs) != 1 || res.ReboundRunIDs[0] != "run_down_1" {
		t.Fatalf("unexpected retry response: %+v", res)
	}

	// 2. Retry omitting --timeout omits timeout_sec from request body and uses AHUB_PROFILE
	t.Setenv("AHUB_PROFILE", "fallback-ops")
	code2, out2, _ := captureExecuteFull(t, []string{
		"--url", srv.URL, "--token", "tok_test", "--json",
		"retry", "run_fail_1",
	}, "")
	if code2 != api.ExitOK {
		t.Fatalf("retry without timeout exit=%d out=%s", code2, out2)
	}
	if _, hasTimeout := seenBody["timeout_sec"]; hasTimeout {
		t.Fatalf("expected timeout_sec omitted when --timeout not passed, got %+v", seenBody)
	}
	if seenBody["actor_profile"] != "fallback-ops" {
		t.Fatalf("expected AHUB_PROFILE fallback, got %+v", seenBody)
	}

	// 3. Server error exit codes
	if c, _, _ := captureExecuteFull(t, []string{"--url", srv.URL, "--token", "tok", "--json", "retry", "run_done"}, ""); c != api.ExitBadUsageOrInput {
		t.Fatalf("expected exit 64 on INVALID_STATE_TRANSITION, got %d", c)
	}
	if c, _, _ := captureExecuteFull(t, []string{"--url", srv.URL, "--token", "tok", "--json", "retry", "run_forbidden"}, ""); c != api.ExitPolicyDenied {
		t.Fatalf("expected exit 78 on FORBIDDEN_SCOPE, got %d", c)
	}

	// 4. Usage validation -> exit 64
	for _, args := range [][]string{
		{"--json", "retry"},
		{"--json", "retry", "run_1", "extra"},
		{"--json", "retry", "run_1", "--timeout", "5s"},
		{"--json", "retry", "run_1", "--timeout", "7201s"},
		{"--json", "retry", "run_1", "--effort", "invalid_effort"},
		{"--json", "retry", "run_1", "--as", "Bad Profile"},
		{"--json", "retry", "run_1", "--idempotency-key", "short"},
	} {
		if c, o, _ := captureExecuteFull(t, args, ""); c != api.ExitBadUsageOrInput {
			t.Fatalf("args %v: expected exit 64, got %d (out=%s)", args, c, o)
		}
	}
}

func TestRunSlice2FlagsAndWaitingBehavior(t *testing.T) {
	var seenCreateReq api.CreateRunRequest
	var seenWaitMs string
	var wsDialed atomic.Int32
	var wsMode atomic.Value
	wsMode.Store("transition")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/runs":
			seenWaitMs = r.URL.Query().Get("wait_ms")
			_ = json.NewDecoder(r.Body).Decode(&seenCreateReq)
			blocked := "DEPENDENCY_PENDING"
			if seenCreateReq.ScheduledAt != "" && len(seenCreateReq.DependsOn) == 0 {
				blocked = "SCHEDULED"
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok": true,
				"run": api.RunRecord{
					ID:              "run_wait_s2",
					ThreadID:        "thr_s2",
					RootRunID:       "run_wait_s2",
					NodeID:          seenCreateReq.NodeID,
					Workdir:         seenCreateReq.Workdir,
					Agent:           seenCreateReq.Agent,
					Status:          "waiting",
					LeaseOwner:      "secret_lease",
					Prompt:          "Task with ahub_cli_runsecret88",
					ScheduledAt:     strPtrIfNonEmpty(seenCreateReq.ScheduledAt),
					BoardTopicID:    strPtrIfNonEmpty(seenCreateReq.BoardTopicID),
					ActorProfile:    seenCreateReq.ActorProfile,
					DependsOnRunIDs: seenCreateReq.DependsOn,
					BlockedReason:   &blocked,
					CreatedAt:       "2026-11-22T00:00:00.000Z",
					UpdatedAt:       "2026-11-22T00:00:00.000Z",
				},
			})
		case r.URL.Path == "/ws/stream":
			wsDialed.Add(1)
			c, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer c.CloseNow()
			mode, _ := wsMode.Load().(string)
			sched := "2026-11-22T01:00:00.000Z"
			blocked := "SCHEDULED"
			snap, _ := json.Marshal(map[string]interface{}{
				"type": "snapshot",
				"runs": []api.RunRecord{{
					ID:            "run_wait_s2",
					Status:        "waiting",
					BlockedReason: &blocked,
					ScheduledAt:   &sched,
				}},
			})
			_ = c.Write(context.Background(), websocket.MessageText, snap)
			// Duplicate waiting frame to verify stderr hint deduplication
			_ = c.Write(context.Background(), websocket.MessageText, snap)

			if mode == "transition" {
				queued, _ := json.Marshal(map[string]interface{}{
					"type": "run.updated",
					"run":  api.RunRecord{ID: "run_wait_s2", Status: "queued"},
				})
				_ = c.Write(context.Background(), websocket.MessageText, queued)
				doneFrame, _ := json.Marshal(map[string]interface{}{
					"type": "run.updated",
					"run":  api.RunRecord{ID: "run_wait_s2", Status: "done", Summary: "finished"},
				})
				_ = c.Write(context.Background(), websocket.MessageText, doneFrame)
			} else {
				<-r.Context().Done()
			}
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/runs/run_wait_s2":
			w.Header().Set("Content-Type", "application/json")
			mode, _ := wsMode.Load().(string)
			if mode == "transition" {
				_ = json.NewEncoder(w).Encode(map[string]interface{}{
					"ok": true,
					"run": api.RunRecord{
						ID:        "run_wait_s2",
						ThreadID:  "thr_s2",
						RootRunID: "run_wait_s2",
						NodeID:    "macmini",
						Workdir:   "/w",
						Agent:     "agy",
						Status:    "done",
						Summary:   "finished after waiting",
					},
				})
			} else {
				blocked := "SCHEDULED"
				_ = json.NewEncoder(w).Encode(map[string]interface{}{
					"ok": true,
					"run": api.RunRecord{
						ID:            "run_wait_s2",
						ThreadID:      "thr_s2",
						RootRunID:     "run_wait_s2",
						NodeID:        "macmini",
						Workdir:       "/w",
						Agent:         "agy",
						Status:        "waiting",
						BlockedReason: &blocked,
					},
				})
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	// 1. --after (repeatable & CSV + dedup), --in 1m (floor buffer >= +60s), --topic, --as, no --wait -> exit 0 immediately without WS dial
	before := time.Now().UTC()
	code, out, errOut := captureExecuteFull(t, []string{
		"--url", srv.URL, "--token", "tok_test", "--json",
		"run", "-n", "macmini", "-d", "/w", "-a", "agy",
		"--after", "run_a,run_b", "--after", "run_b", "--after", "run_c",
		"--in", "1m", "--topic", "top_123", "--as", "coord-bot",
		"hello ahub_cli_runsecret88",
	}, "")
	if code != api.ExitOK {
		t.Fatalf("waiting run without --wait exit=%d out=%s err=%s", code, out, errOut)
	}
	if wsDialed.Load() != 0 {
		t.Fatalf("expected 0 WS dials when waiting without --wait, got %d", wsDialed.Load())
	}
	if seenWaitMs != "" && seenWaitMs != "0" {
		t.Fatalf("expected wait_ms=0/omitted when waiting without --wait, got %q", seenWaitMs)
	}
	if len(seenCreateReq.DependsOn) != 3 || seenCreateReq.DependsOn[0] != "run_a" || seenCreateReq.DependsOn[2] != "run_c" {
		t.Fatalf("expected deduplicated depends_on, got %v", seenCreateReq.DependsOn)
	}
	if seenCreateReq.BoardTopicID != "top_123" || seenCreateReq.ActorProfile != "coord-bot" {
		t.Fatalf("unexpected topic/actor: %+v", seenCreateReq)
	}
	schedTS, err := time.Parse("2006-01-02T15:04:05.000Z", seenCreateReq.ScheduledAt)
	if err != nil {
		t.Fatalf("invalid scheduled_at %q: %v", seenCreateReq.ScheduledAt, err)
	}
	if schedTS.Sub(before) < 60*time.Second || schedTS.Sub(before) > 65*time.Second {
		t.Fatalf("expected --in 1m scheduled_at ~62s in future, got delta=%s", schedTS.Sub(before))
	}
	if strings.Contains(out, "ahub_cli_runsecret88") || strings.Contains(out, "secret_lease") {
		t.Fatalf("waiting run output leaked secret: %s", out)
	}

	// Verify 7d boundary produces <= now + 7d
	d7, err := parseDelayDuration("7d")
	if err != nil || d7 != 7*24*time.Hour {
		t.Fatalf("parseDelayDuration(7d) = %v, %v", d7, err)
	}
	s7 := computeScheduledAt(d7)
	t7, err := time.Parse("2006-01-02T15:04:05.000Z", s7)
	if err != nil {
		t.Fatalf("invalid 7d timestamp %q: %v", s7, err)
	}
	if time.Until(t7) > 7*24*time.Hour {
		t.Fatalf("7d timestamp exceeded +7d bound: %s", s7)
	}

	// 2. Explicit --wait 3s waits through waiting -> queued -> done -> exit 0, emits deduplicated stderr hint, stdout pure JSON
	wsMode.Store("transition")
	codeWaitOK, outWaitOK, errWaitOK := captureExecuteFull(t, []string{
		"--url", srv.URL, "--token", "tok_test", "--json",
		"run", "-n", "macmini", "-d", "/w", "-a", "agy",
		"--in", "2d12h", "--wait", "3s", "hello",
	}, "")
	if codeWaitOK != api.ExitOK {
		t.Fatalf("run --in --wait transition exit=%d out=%s err=%s", codeWaitOK, outWaitOK, errWaitOK)
	}
	if wsDialed.Load() == 0 {
		t.Fatalf("expected WS dial when --wait explicitly set")
	}
	if cnt := strings.Count(errWaitOK, "[ahub wait] run run_wait_s2 waiting"); cnt != 1 {
		t.Fatalf("expected exactly 1 deduplicated waiting hint on stderr, got %d: %q", cnt, errWaitOK)
	}
	var doneRec api.RunRecord
	if err := json.Unmarshal([]byte(outWaitOK), &doneRec); err != nil || doneRec.Status != "done" {
		t.Fatalf("expected single pure JSON done record on stdout, err=%v out=%s", err, outWaitOK)
	}

	// 3. Explicit --wait 0s on waiting run -> exit 24
	codeWaitZero, _, _ := captureExecuteFull(t, []string{
		"--url", srv.URL, "--token", "tok_test", "--json",
		"run", "-n", "macmini", "-d", "/w", "-a", "agy",
		"--after", "run_a", "--wait", "0s", "hello",
	}, "")
	if codeWaitZero != api.ExitWaitTimeout {
		t.Fatalf("expected exit 24 on --wait 0s for waiting run, got %d", codeWaitZero)
	}

	// 4. Explicit --wait 200ms timeout while still waiting -> exit 24
	wsMode.Store("stay_waiting")
	codeWaitTO, outWaitTO, errWaitTO := captureExecuteFull(t, []string{
		"--url", srv.URL, "--token", "tok_test", "--json",
		"run", "-n", "macmini", "-d", "/w", "-a", "agy",
		"--after", "run_a", "--wait", "200ms", "hello",
	}, "")
	if codeWaitTO != api.ExitWaitTimeout {
		t.Fatalf("expected exit 24 on waiting wait timeout, got %d (out=%s err=%s)", codeWaitTO, outWaitTO, errWaitTO)
	}

	// 5. Validation errors -> exit 64
	badRunCases := [][]string{
		{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--in", "30s", "hello"},
		{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--in", "8d", "hello"},
		{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--in", "-5m", "hello"},
		{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--in", "abc", "hello"},
		{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--after", "", "hello"},
		{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--after", "bad_id", "hello"},
		{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--after", "run_1,run_2,run_3,run_4,run_5,run_6,run_7,run_8,run_9,run_10,run_11", "hello"},
		{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--topic", "invalid", "hello"},
		{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--as", "Bad Actor", "hello"},
	}
	for _, args := range badRunCases {
		if c, o, _ := captureExecuteFull(t, args, ""); c != api.ExitBadUsageOrInput {
			t.Fatalf("args %v: expected exit 64, got %d (out=%s)", args, c, o)
		}
	}
}

func TestWaitWaitingTimeoutAndRunsFiltersAndSkillBudget(t *testing.T) {
	var seenRunsQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/ws/stream":
			c, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer c.CloseNow()
			blocked := "UPSTREAM_FAILED"
			frame, _ := json.Marshal(map[string]interface{}{
				"type": "snapshot",
				"runs": []api.RunRecord{{
					ID:            "run_wait_only",
					Status:        "waiting",
					BlockedReason: &blocked,
				}},
			})
			_ = c.Write(context.Background(), websocket.MessageText, frame)
			<-r.Context().Done()
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/runs/run_wait_only":
			blocked := "UPSTREAM_FAILED"
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok": true,
				"run": api.RunRecord{
					ID:            "run_wait_only",
					ThreadID:      "thr_1",
					RootRunID:     "run_1",
					NodeID:        "macmini",
					Workdir:       "/w",
					Agent:         "agy",
					Status:        "waiting",
					BlockedReason: &blocked,
				},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/runs":
			seenRunsQuery = r.URL.RawQuery
			planID := "pln_1"
			blocked := "DEPENDENCY_PENDING"
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok": true,
				"runs": []api.RunRecord{{
					ID:            "run_w1",
					ThreadID:      "thr_1",
					RootRunID:     "run_w1",
					NodeID:        "macmini",
					Workdir:       "/w",
					Agent:         "agy",
					Status:        "waiting",
					PlanID:        &planID,
					BlockedReason: &blocked,
				}},
			})
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/runs/run_w1/cancel":
			empty := ""
			planID := "pln_1"
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok": true,
				"cancelled_runs": []api.RunRecord{{
					ID:            "run_w1",
					ThreadID:      "thr_1",
					RootRunID:     "run_w1",
					NodeID:        "macmini",
					Workdir:       "/w",
					Agent:         "agy",
					Status:        "cancelled",
					LeaseOwner:    "should_clear",
					PlanID:        &planID,
					BlockedReason: &empty,
				}},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	// 1. ahub wait timeout while waiting -> exit 24 + stderr UPSTREAM_FAILED hint
	codeW, outW, errW := captureExecuteFull(t, []string{
		"--url", srv.URL, "--token", "tok_test", "--json",
		"wait", "run_wait_only", "--timeout", "200ms",
	}, "")
	if codeW != api.ExitWaitTimeout {
		t.Fatalf("expected exit 24 on ahub wait timeout in waiting, got %d (out=%s err=%s)", codeW, outW, errW)
	}
	if !strings.Contains(errW, "UPSTREAM_FAILED") {
		t.Fatalf("expected UPSTREAM_FAILED hint on stderr, got %q", errW)
	}

	// 2. ahub runs --status waiting --plan pln_1 --topic top_1
	codeR, outR, _ := captureExecuteFull(t, []string{
		"--url", srv.URL, "--token", "tok_test", "--json",
		"runs", "--status", "waiting", "--plan", "pln_1", "--topic", "top_1",
	}, "")
	if codeR != api.ExitOK {
		t.Fatalf("runs exit=%d out=%s", codeR, outR)
	}
	for _, want := range []string{"status=waiting", "plan_id=pln_1", "board_topic_id=top_1"} {
		if !strings.Contains(seenRunsQuery, want) {
			t.Fatalf("expected runs query %q to contain %q", seenRunsQuery, want)
		}
	}

	// Invalid ahub runs filters -> exit 64
	for _, args := range [][]string{
		{"--json", "runs", "--status", "bogus"},
		{"--json", "runs", "--plan", "bad"},
		{"--json", "runs", "--topic", "bad"},
	} {
		if c, _, _ := captureExecuteFull(t, args, ""); c != api.ExitBadUsageOrInput {
			t.Fatalf("args %v: expected exit 64, got %d", args, c)
		}
	}

	// 3. ahub cancel --cascade normalizes empty pointers and preserves Slice 2 fields
	codeC, outC, _ := captureExecuteFull(t, []string{
		"--url", srv.URL, "--token", "tok_test", "--json",
		"cancel", "run_w1", "--cascade",
	}, "")
	if codeC != api.ExitOK {
		t.Fatalf("cancel --cascade exit=%d out=%s", codeC, outC)
	}
	if strings.Contains(outC, "should_clear") || strings.Contains(outC, `"blocked_reason":""`) {
		t.Fatalf("cancel did not sanitize lease_owner/empty blocked_reason: %s", outC)
	}
	if !strings.Contains(outC, `"plan_id":"pln_1"`) {
		t.Fatalf("expected plan_id preserved in cancel output, got %s", outC)
	}

	// 4. sanitizeRunRecord direct check for empty-string pointers
	empty := ""
	san := sanitizeRunRecord(api.RunRecord{
		ID:            "run_s",
		LeaseOwner:    "secret_lease",
		ParentRunID:   &empty,
		PlanID:        &empty,
		PlanKey:       &empty,
		ScheduledAt:   &empty,
		RetryOfRunID:  &empty,
		BoardTopicID:  &empty,
		BlockedReason: &empty,
	}, false)
	if san.LeaseOwner != "" || san.ParentRunID != nil || san.PlanID != nil || san.PlanKey != nil ||
		san.ScheduledAt != nil || san.RetryOfRunID != nil || san.BoardTopicID != nil || san.BlockedReason != nil {
		t.Fatalf("sanitizeRunRecord did not clear empty pointers: %+v", san)
	}

	// 5. Embedded SKILL.md byte budget & Slice 2 coverage guard
	if len(skills.AhubSkillMD) > 4500 {
		t.Fatalf("skills/ahub/SKILL.md exceeds 4500 bytes: got %d", len(skills.AhubSkillMD))
	}
	for _, required := range []string{
		"ahub plan", "ahub retry", "--after", "--in", "--topic", "--as",
		"DEPENDENCY_CYCLE_DETECTED", "INVALID_STATE_TRANSITION", "ahub board ask", "ahub native-emit",
	} {
		if !strings.Contains(skills.AhubSkillMD, required) {
			t.Fatalf("skills/ahub/SKILL.md missing required token %q", required)
		}
	}
}

func strPtrIfNonEmpty(s string) *string {
	if s == "" {
		return nil
	}
	cp := s
	return &cp
}
