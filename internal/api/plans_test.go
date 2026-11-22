package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSlice2MarshalingOmitsUnsetFieldsAndPreservesZeroValues(t *testing.T) {
	// CreateRunRequest omits unset Slice 2 fields and never emits in_sec
	rawRunReq, err := json.Marshal(CreateRunRequest{
		NodeID:  "macmini",
		Workdir: "~/workspace/demo",
		Agent:   "agy",
		Prompt:  "run task",
	})
	if err != nil {
		t.Fatalf("marshal CreateRunRequest: %v", err)
	}
	var runReqMap map[string]interface{}
	if err := json.Unmarshal(rawRunReq, &runReqMap); err != nil {
		t.Fatalf("unmarshal CreateRunRequest: %v", err)
	}
	for _, omitted := range []string{"depends_on", "scheduled_at", "board_topic_id", "actor_profile", "in_sec"} {
		if _, exists := runReqMap[omitted]; exists {
			t.Fatalf("expected %q omitted in CreateRunRequest, got %s", omitted, string(rawRunReq))
		}
	}

	// PlanNodeSpec preserves sandbox=false and priority_order=0, omits nil fields
	sbFalse := false
	prioZero := 0.0
	inSec := 120
	rawPlanNode, err := json.Marshal(PlanNodeSpec{
		Key:           "build",
		NodeID:        "macmini",
		Workdir:       "~/workspace/demo",
		Agent:         "codex",
		Sandbox:       &sbFalse,
		Prompt:        "build",
		InSec:         &inSec,
		PriorityOrder: &prioZero,
	})
	if err != nil {
		t.Fatalf("marshal PlanNodeSpec: %v", err)
	}
	var nodeMap map[string]interface{}
	if err := json.Unmarshal(rawPlanNode, &nodeMap); err != nil {
		t.Fatalf("unmarshal PlanNodeSpec: %v", err)
	}
	if v, ok := nodeMap["sandbox"].(bool); !ok || v {
		t.Fatalf("expected sandbox=false preserved, got %#v", nodeMap["sandbox"])
	}
	if v, ok := nodeMap["priority_order"].(float64); !ok || v != 0 {
		t.Fatalf("expected priority_order=0 preserved, got %#v", nodeMap["priority_order"])
	}
	if v, ok := nodeMap["in_sec"].(float64); !ok || int(v) != 120 {
		t.Fatalf("expected in_sec=120, got %#v", nodeMap["in_sec"])
	}
	if _, exists := nodeMap["scheduled_at"]; exists {
		t.Fatalf("expected scheduled_at omitted when empty, got %s", string(rawPlanNode))
	}

	// RunRecord omits unset Slice 2 pointers/slices and round-trips all 8 Slice 2 fields
	rawMinRun, err := json.Marshal(RunRecord{
		ID:        "run_min1",
		ThreadID:  "thr_min1",
		RootRunID: "run_min1",
		NodeID:    "macmini",
		Workdir:   "~/workspace/demo",
		Agent:     "agy",
		Status:    "queued",
		CreatedAt: "2026-11-22T00:00:00.000Z",
		UpdatedAt: "2026-11-22T00:00:00.000Z",
	})
	if err != nil {
		t.Fatalf("marshal minimal RunRecord: %v", err)
	}
	var minRunMap map[string]interface{}
	if err := json.Unmarshal(rawMinRun, &minRunMap); err != nil {
		t.Fatalf("unmarshal minimal RunRecord: %v", err)
	}
	for _, omitted := range []string{
		"plan_id", "plan_key", "scheduled_at", "retry_of_run_id",
		"actor_profile", "board_topic_id", "depends_on_run_ids", "blocked_reason",
	} {
		if _, exists := minRunMap[omitted]; exists {
			t.Fatalf("expected %q omitted on minimal RunRecord, got %s", omitted, string(rawMinRun))
		}
	}

	planID := "pln_01ABC"
	planKey := "deploy"
	schedAt := "2026-11-22T01:00:00.000Z"
	retryOf := "run_01OLD"
	topicID := "top_01XYZ"
	blocked := "UPSTREAM_FAILED"
	fullRec := RunRecord{
		ID:              "run_01NEW",
		ThreadID:        "thr_01NEW",
		RootRunID:       "run_01ROOT",
		NodeID:          "macmini",
		Workdir:         "~/workspace/demo",
		Agent:           "agy",
		Status:          "waiting",
		PlanID:          &planID,
		PlanKey:         &planKey,
		ScheduledAt:     &schedAt,
		RetryOfRunID:    &retryOf,
		ActorProfile:    "planner@mbp",
		BoardTopicID:    &topicID,
		DependsOnRunIDs: []string{"run_01DEP1"},
		BlockedReason:   &blocked,
		CreatedAt:       "2026-11-22T00:00:00.000Z",
		UpdatedAt:       "2026-11-22T00:00:00.000Z",
	}
	rawFull, err := json.Marshal(fullRec)
	if err != nil {
		t.Fatalf("marshal full RunRecord: %v", err)
	}
	var decoded RunRecord
	if err := json.Unmarshal(rawFull, &decoded); err != nil {
		t.Fatalf("unmarshal full RunRecord: %v", err)
	}
	if decoded.PlanID == nil || *decoded.PlanID != planID ||
		decoded.PlanKey == nil || *decoded.PlanKey != planKey ||
		decoded.ScheduledAt == nil || *decoded.ScheduledAt != schedAt ||
		decoded.RetryOfRunID == nil || *decoded.RetryOfRunID != retryOf ||
		decoded.ActorProfile != "planner@mbp" ||
		decoded.BoardTopicID == nil || *decoded.BoardTopicID != topicID ||
		len(decoded.DependsOnRunIDs) != 1 || decoded.DependsOnRunIDs[0] != "run_01DEP1" ||
		decoded.BlockedReason == nil || *decoded.BlockedReason != blocked {
		t.Fatalf("round-trip mismatch for Slice 2 RunRecord: %+v", decoded)
	}
}

func TestCreatePlanSuccessDeduplicatedAndErrors(t *testing.T) {
	var seenMethod, seenPath, seenIdem string
	var seenBody CreatePlanRequest

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenMethod = r.Method
		seenPath = r.URL.Path
		seenIdem = r.Header.Get("Idempotency-Key")
		w.Header().Set("Content-Type", "application/json")

		if err := json.NewDecoder(r.Body).Decode(&seenBody); err != nil {
			t.Fatalf("decode plan body: %v", err)
		}

		switch seenBody.IdempotencyKey {
		case "idem_plan_created":
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"ok":true,"plan_id":"pln_01A","runs":null}`))
		case "idem_plan_dedup":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true,"plan_id":"pln_01A","deduplicated":true,"runs":[{"id":"run_1","thread_id":"thr_1","root_run_id":"run_1","node_id":"macmini","workdir":"/w","agent":"agy","status":"queued","created_at":"2026-11-22T00:00:00Z","updated_at":"2026-11-22T00:00:00Z"}]}`))
		case "idem_plan_cycle":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"ok":false,"error":{"code":"DEPENDENCY_CYCLE_DETECTED","message":"cycle in plan","next":["ahub plan --help"]}}`))
		case "idem_plan_depth":
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"ok":false,"error":{"code":"DEPTH_LIMIT_EXCEEDED","message":"max_depth=1"}}`))
		case "idem_plan_drain":
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"ok":false,"error":{"code":"NODE_DRAINING","message":"node draining"}}`))
		default:
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"ok":false,"error":{"code":"IDEMPOTENCY_CONFLICT","message":"payload mismatch"}}`))
		}
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "ahub_cli_test")
	ctx := context.Background()

	// 201 created with nil runs normalized to empty slice & header forwarded
	res1, err := c.CreatePlan(ctx, CreatePlanRequest{
		IdempotencyKey: "idem_plan_created",
		BoardTopicID:   "top_1",
		ActorProfile:   "planner",
		ParentRunID:    "run_parent1",
		Nodes: []PlanNodeSpec{{
			Key: "a", NodeID: "macmini", Workdir: "/w", Agent: "agy", Prompt: "go",
		}},
	})
	if err != nil {
		t.Fatalf("CreatePlan 201 failed: %v", err)
	}
	if seenMethod != http.MethodPost || seenPath != "/api/v1/plans" || seenIdem != "idem_plan_created" {
		t.Fatalf("unexpected request metadata: method=%s path=%s idem=%q", seenMethod, seenPath, seenIdem)
	}
	if res1.PlanID != "pln_01A" || res1.Deduplicated != nil || res1.Runs == nil || len(res1.Runs) != 0 {
		t.Fatalf("unexpected 201 CreatePlanResponse: %+v", res1)
	}

	// 200 deduplicated
	res2, err := c.CreatePlan(ctx, CreatePlanRequest{
		IdempotencyKey: "idem_plan_dedup",
		Nodes:          []PlanNodeSpec{{Key: "a", NodeID: "macmini", Workdir: "/w", Agent: "agy", Prompt: "go"}},
	})
	if err != nil {
		t.Fatalf("CreatePlan 200 dedup failed: %v", err)
	}
	if res2.Deduplicated == nil || !*res2.Deduplicated || len(res2.Runs) != 1 {
		t.Fatalf("expected deduplicated=true and 1 run, got %+v", res2)
	}

	// Error exit code checks
	cases := []struct {
		key      string
		wantExit int
		wantCode string
	}{
		{key: "idem_plan_cycle", wantExit: ExitBadUsageOrInput, wantCode: "DEPENDENCY_CYCLE_DETECTED"},
		{key: "idem_plan_depth", wantExit: ExitPolicyDenied, wantCode: "DEPTH_LIMIT_EXCEEDED"},
		{key: "idem_plan_drain", wantExit: ExitNetworkTemp, wantCode: "NODE_DRAINING"},
		{key: "idem_plan_conflict", wantExit: ExitBadUsageOrInput, wantCode: "IDEMPOTENCY_CONFLICT"},
	}
	for _, tc := range cases {
		_, err := c.CreatePlan(ctx, CreatePlanRequest{
			IdempotencyKey: tc.key,
			Nodes:          []PlanNodeSpec{{Key: "a", NodeID: "macmini", Workdir: "/w", Agent: "agy", Prompt: "go"}},
		})
		if err == nil {
			t.Fatalf("expected error for %s", tc.key)
		}
		var apiErr *APIError
		if !errors.As(err, &apiErr) || apiErr.Body.Code != tc.wantCode {
			t.Fatalf("for %s got err=%v, want code %s", tc.key, err, tc.wantCode)
		}
		if got := ExitCodeForError(err); got != tc.wantExit {
			t.Fatalf("for %s got exit %d, want %d", tc.key, got, tc.wantExit)
		}
	}

	// Synthetic DEPENDENCY_CYCLE_DETECTED without HTTPStatus maps to 64
	if got := ExitCodeForError(&APIError{Body: ErrorBody{Code: "DEPENDENCY_CYCLE_DETECTED"}}); got != ExitBadUsageOrInput {
		t.Fatalf("synthetic DEPENDENCY_CYCLE_DETECTED exit=%d, want 64", got)
	}
}

func TestRetryRunListRunsWithOptionsAndCancelRequest(t *testing.T) {
	var seenRetryPath, seenRetryIdem string
	var seenRetryBody map[string]interface{}
	var seenListQuery string
	var seenCancelBody map[string]interface{}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/retry"):
			seenRetryPath = r.URL.Path
			seenRetryIdem = r.Header.Get("Idempotency-Key")
			_ = json.NewDecoder(r.Body).Decode(&seenRetryBody)
			if strings.Contains(r.URL.Path, "run_done") {
				w.WriteHeader(http.StatusConflict)
				_, _ = w.Write([]byte(`{"ok":false,"error":{"code":"INVALID_STATE_TRANSITION","message":"cannot retry done run"}}`))
				return
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"ok":true,"run":{"id":"run_retry_2","thread_id":"thr_1","root_run_id":"run_1","retry_of_run_id":"run_failed_1","node_id":"macmini","workdir":"/w","agent":"agy","status":"queued","created_at":"2026-11-22T00:00:00Z","updated_at":"2026-11-22T00:00:00Z"},"rebound_run_ids":null}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/runs":
			seenListQuery = r.URL.RawQuery
			_, _ = w.Write([]byte(`{"ok":true,"runs":null}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/runs/run_wait_1/cancel":
			_ = json.NewDecoder(r.Body).Decode(&seenCancelBody)
			_, _ = w.Write([]byte(`{"ok":true,"cancelled_runs":[{"id":"run_wait_1","thread_id":"thr_1","root_run_id":"run_1","node_id":"macmini","workdir":"/w","agent":"agy","status":"cancelled","created_at":"2026-11-22T00:00:00Z","updated_at":"2026-11-22T00:00:00Z"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "ahub_cli_test")
	ctx := context.Background()

	// Retry omitting timeout_sec and normalizing nil rebound_run_ids
	retryRes, err := c.RetryRun(ctx, "run_failed_1", RetryRunRequest{
		IdempotencyKey: "idem_retry_1234",
		Model:          "carbon",
		Effort:         "high",
		ActorProfile:   "ops",
	})
	if err != nil {
		t.Fatalf("RetryRun failed: %v", err)
	}
	if seenRetryPath != "/api/v1/runs/run_failed_1/retry" || seenRetryIdem != "idem_retry_1234" {
		t.Fatalf("unexpected retry path=%s idem=%q", seenRetryPath, seenRetryIdem)
	}
	if _, hasTimeout := seenRetryBody["timeout_sec"]; hasTimeout {
		t.Fatalf("expected timeout_sec omitted when 0, got %+v", seenRetryBody)
	}
	if retryRes.ReboundRunIDs == nil || len(retryRes.ReboundRunIDs) != 0 {
		t.Fatalf("expected non-nil empty rebound_run_ids, got %#v", retryRes.ReboundRunIDs)
	}
	if retryRes.Run.RetryOfRunID == nil || *retryRes.Run.RetryOfRunID != "run_failed_1" {
		t.Fatalf("expected retry_of_run_id preserved, got %+v", retryRes.Run.RetryOfRunID)
	}

	// Retry invalid state -> exit 64
	_, err = c.RetryRun(ctx, "run_done", RetryRunRequest{})
	if ExitCodeForError(err) != ExitBadUsageOrInput {
		t.Fatalf("expected ExitBadUsageOrInput (64) on INVALID_STATE_TRANSITION, got %d (%v)", ExitCodeForError(err), err)
	}

	// ListRunsWithOptions & backward-compatible ListRuns
	runs, err := c.ListRunsWithOptions(ctx, ListRunsOptions{
		NodeID:       "macmini",
		ThreadID:     "thr_1",
		Status:       "waiting",
		RootRunID:    "run_root",
		PlanID:       "pln_1",
		BoardTopicID: "top_1",
		Limit:        15,
	})
	if err != nil || runs == nil || len(runs) != 0 {
		t.Fatalf("ListRunsWithOptions failed: runs=%#v err=%v", runs, err)
	}
	for _, want := range []string{
		"node_id=macmini", "thread_id=thr_1", "status=waiting",
		"root_run_id=run_root", "plan_id=pln_1", "board_topic_id=top_1", "limit=15",
	} {
		if !strings.Contains(seenListQuery, want) {
			t.Fatalf("expected query %q to contain %q", seenListQuery, want)
		}
	}

	legacyRuns, err := c.ListRuns(ctx, "mbp", "queued", 5)
	if err != nil || legacyRuns == nil {
		t.Fatalf("legacy ListRuns failed: %v", err)
	}
	if !strings.Contains(seenListQuery, "node_id=mbp") || !strings.Contains(seenListQuery, "status=queued") || !strings.Contains(seenListQuery, "limit=5") {
		t.Fatalf("unexpected legacy ListRuns query %q", seenListQuery)
	}

	// CancelRun sends cascade + reason
	cancelled, err := c.CancelRun(ctx, "run_wait_1", true, "stop downstream")
	if err != nil || len(cancelled) != 1 {
		t.Fatalf("CancelRun failed: cancelled=%+v err=%v", cancelled, err)
	}
	if seenCancelBody["cascade"] != true || seenCancelBody["reason"] != "stop downstream" {
		t.Fatalf("unexpected CancelRun body: %+v", seenCancelBody)
	}
}

func TestSlice3MarshalingAndLabelQueryEncoding(t *testing.T) {
	// 1. CreateRunRequest & PlanNodeSpec omit unset Slice 3 fields and preserve empty schema `{}`
	rawOmit, err := json.Marshal(CreateRunRequest{
		NodeID:  "macmini",
		Workdir: "~/workspace/demo",
		Agent:   "agy",
		Prompt:  "hi",
	})
	if err != nil {
		t.Fatalf("marshal CreateRunRequest: %v", err)
	}
	var omitMap map[string]interface{}
	if err := json.Unmarshal(rawOmit, &omitMap); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"labels", "result_schema"} {
		if _, exists := omitMap[k]; exists {
			t.Fatalf("expected %q omitted when unset, got %s", k, string(rawOmit))
		}
	}

	rawEmptySchema, err := json.Marshal(CreateRunRequest{
		NodeID:       "macmini",
		Workdir:      "~/workspace/demo",
		Agent:        "agy",
		Prompt:       "hi",
		Labels:       map[string]string{"env": "prod", "empty": ""},
		ResultSchema: json.RawMessage("{}"),
	})
	if err != nil {
		t.Fatalf("marshal CreateRunRequest with {}: %v", err)
	}
	if !strings.Contains(string(rawEmptySchema), `"result_schema":{}`) {
		t.Fatalf("expected result_schema:{} preserved, got %s", string(rawEmptySchema))
	}

	rawNode, err := json.Marshal(PlanNodeSpec{
		Key:          "step1",
		NodeID:       "macmini",
		Workdir:      "/w",
		Agent:        "codex",
		Prompt:       "go",
		Labels:       map[string]string{"stage": "build"},
		ResultSchema: json.RawMessage("{}"),
	})
	if err != nil {
		t.Fatalf("marshal PlanNodeSpec: %v", err)
	}
	if !strings.Contains(string(rawNode), `"result_schema":{}`) || !strings.Contains(string(rawNode), `"stage":"build"`) {
		t.Fatalf("expected PlanNodeSpec labels & result_schema:{}, got %s", string(rawNode))
	}

	// 2. RunRecord omits unset Slice 3 fields and preserves primitives, null, and >2^53 integers
	rawMin, err := json.Marshal(RunRecord{
		ID:        "run_s3_min",
		ThreadID:  "thr_s3",
		RootRunID: "run_s3_min",
		NodeID:    "macmini",
		Workdir:   "/w",
		Agent:     "agy",
		Status:    "done",
		CreatedAt: "2026-11-22T00:00:00Z",
		UpdatedAt: "2026-11-22T00:00:00Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	var minMap map[string]interface{}
	_ = json.Unmarshal(rawMin, &minMap)
	for _, k := range []string{"labels", "result_schema", "result"} {
		if _, exists := minMap[k]; exists {
			t.Fatalf("expected %q omitted on minimal RunRecord, got %s", k, string(rawMin))
		}
	}

	for _, rawVal := range []string{
		`false`,
		`0`,
		`""`,
		`[]`,
		`{}`,
		`null`,
		`{"big":9007199254740993}`,
	} {
		rec := RunRecord{
			ID:           "run_s3_val",
			ThreadID:     "thr_s3",
			RootRunID:    "run_s3_val",
			NodeID:       "macmini",
			Workdir:      "/w",
			Agent:        "agy",
			Status:       "done",
			Labels:       map[string]string{"env": "prod"},
			ResultSchema: json.RawMessage(`{"type":["object","array","string","number","boolean","null"]}`),
			Result:       json.RawMessage(rawVal),
			CreatedAt:    "2026-11-22T00:00:00Z",
			UpdatedAt:    "2026-11-22T00:00:00Z",
		}
		b, err := json.Marshal(rec)
		if err != nil {
			t.Fatalf("marshal RunRecord with result %s: %v", rawVal, err)
		}
		var roundTrip RunRecord
		if err := json.Unmarshal(b, &roundTrip); err != nil {
			t.Fatalf("unmarshal RunRecord with result %s: %v", rawVal, err)
		}
		if string(roundTrip.Result) != rawVal {
			t.Fatalf("RunRecord.Result round-trip mismatch: got %s, want %s", string(roundTrip.Result), rawVal)
		}
	}

	// 3. CompleteRunRequest omits nil Result / empty ResultError, preserves explicit null Result
	compOmit, err := json.Marshal(CompleteRunRequest{
		LeaseOwner: "macmini:n1",
		Status:     "done",
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(compOmit), `"result"`) || strings.Contains(string(compOmit), `"result_error"`) {
		t.Fatalf("expected result & result_error omitted when unset, got %s", string(compOmit))
	}

	compNull, err := json.Marshal(CompleteRunRequest{
		LeaseOwner: "macmini:n1",
		Status:     "done",
		Result:     json.RawMessage("null"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(compNull), `"result":null`) || strings.Contains(string(compNull), `"result_error"`) {
		t.Fatalf("expected explicit result:null without result_error, got %s", string(compNull))
	}

	compErr, err := json.Marshal(CompleteRunRequest{
		LeaseOwner:  "macmini:n1",
		Status:      "done",
		ResultError: "AHUB_RESULT_FILE invalid JSON",
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(compErr), `"result":`) || !strings.Contains(string(compErr), `"result_error":"AHUB_RESULT_FILE invalid JSON"`) {
		t.Fatalf("expected result_error without result, got %s", string(compErr))
	}

	// 4. BuildListRunsQuery & ListRunsWithOptions repeatable label=k=v encoding
	q := BuildListRunsQuery(ListRunsOptions{
		Status: "done",
		Labels: []string{"env=prod", "ahub.plan=pln_1", "k=a=b"},
	})
	gotLabels := q["label"]
	if len(gotLabels) != 3 || gotLabels[0] != "env=prod" || gotLabels[1] != "ahub.plan=pln_1" || gotLabels[2] != "k=a=b" {
		t.Fatalf("unexpected BuildListRunsQuery labels: %#v", gotLabels)
	}
	encoded := q.Encode()
	if !strings.Contains(encoded, "label=env%3Dprod&label=ahub.plan%3Dpln_1&label=k%3Da%3Db") {
		t.Fatalf("unexpected encoded query: %q", encoded)
	}

	var seenQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"runs":[]}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "ahub_cli_test")
	if _, err := c.ListRunsWithOptions(context.Background(), ListRunsOptions{
		Labels: []string{"env=prod", "ahub.plan=pln_1", "k=a=b"},
	}); err != nil {
		t.Fatalf("ListRunsWithOptions failed: %v", err)
	}
	if !strings.Contains(seenQuery, "label=env%3Dprod&label=ahub.plan%3Dpln_1&label=k%3Da%3Db") {
		t.Fatalf("server received unexpected query: %q", seenQuery)
	}
}
