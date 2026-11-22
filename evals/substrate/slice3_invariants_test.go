package substrate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/gray0128/agent-hub/internal/api"
)

type evalSlice3Run struct {
	ID              string                 `json:"id"`
	ThreadID        string                 `json:"thread_id"`
	RootRunID       string                 `json:"root_run_id"`
	ParentRunID     *string                `json:"parent_run_id"`
	Depth           int                    `json:"depth"`
	MaxDepth        int                    `json:"max_depth"`
	NodeID          string                 `json:"node_id"`
	Workdir         string                 `json:"workdir"`
	Agent           string                 `json:"agent"`
	Prompt          string                 `json:"prompt"`
	Status          string                 `json:"status"`
	PlanID          *string                `json:"plan_id"`
	PlanKey         *string                `json:"plan_key"`
	RetryOfRunID    *string                `json:"retry_of_run_id"`
	ActorProfile    string                 `json:"actor_profile"`
	BoardTopicID    *string                `json:"board_topic_id"`
	DependsOnRunIDs []string               `json:"depends_on_run_ids"`
	BlockedReason   *string                `json:"blocked_reason"`
	Labels           map[string]string      `json:"labels"`
	ResultSchema     map[string]interface{} `json:"result_schema"`
	Result           json.RawMessage        `json:"result"`
	RemoteControlURL string                 `json:"remote_control_url"`
	Summary          string                 `json:"summary"`
	OutputPreview    string                 `json:"output_preview"`
	OutputMD         string                 `json:"output_md"`
	OutputBytes     int64                  `json:"output_bytes"`
	ErrorCode       string                 `json:"error_code"`
	ErrorMessage    string                 `json:"error_message"`
	CreatedAt       string                 `json:"created_at"`
	UpdatedAt       string                 `json:"updated_at"`
}

type evalSlice3RunResp struct {
	OK           bool          `json:"ok"`
	Run          evalSlice3Run `json:"run"`
	Deduplicated bool          `json:"deduplicated"`
}

type evalSlice3RunsListResp struct {
	OK   bool            `json:"ok"`
	Runs []evalSlice3Run `json:"runs"`
}

type evalSlice3PlanResp struct {
	OK           bool            `json:"ok"`
	PlanID       string          `json:"plan_id"`
	Deduplicated bool            `json:"deduplicated"`
	Runs         []evalSlice3Run `json:"runs"`
}

type evalSlice3RetryResp struct {
	OK            bool          `json:"ok"`
	Run           evalSlice3Run `json:"run"`
	ReboundRunIDs []string      `json:"rebound_run_ids"`
	Deduplicated  bool          `json:"deduplicated"`
}

type evalSlice3ClaimResp struct {
	OK          bool            `json:"ok"`
	ClaimedRuns []evalSlice3Run `json:"claimed_runs"`
}

type evalSlice3ErrorResp struct {
	OK    bool `json:"ok"`
	Error struct {
		Code    string                 `json:"code"`
		Message string                 `json:"message"`
		Details map[string]interface{} `json:"details"`
		Next    []string               `json:"next"`
	} `json:"error"`
}

type evalSlice3ResultDataResp struct {
	OK           bool            `json:"ok"`
	RunID        string          `json:"run_id"`
	Status       string          `json:"status"`
	Result       json.RawMessage `json:"result"`
	ErrorCode    string          `json:"error_code"`
	ErrorMessage string          `json:"error_message"`
}

type evalSlice3BoardTopic struct {
	ID      string `json:"id"`
	Channel string `json:"channel"`
	Title   string `json:"title"`
}

type evalSlice3BoardTopicResp struct {
	OK    bool                 `json:"ok"`
	Topic evalSlice3BoardTopic `json:"topic"`
}

type evalSlice3BoardMessage struct {
	ID           string                 `json:"id"`
	Kind         string                 `json:"kind"`
	ActorProfile string                 `json:"actor_profile"`
	SourceNode   string                 `json:"source_node"`
	TextMD       string                 `json:"text_md"`
	Data         map[string]interface{} `json:"data"`
}

type evalSlice3BoardMessagesResp struct {
	OK       bool                     `json:"ok"`
	Topic    evalSlice3BoardTopic     `json:"topic"`
	Messages []evalSlice3BoardMessage `json:"messages"`
}

func s3DoJSONWithHeaders(t *testing.T, h *testHarness, method, reqPath, tok string, headers map[string]string, payload interface{}) (int, []byte) {
	t.Helper()
	var req *http.Request
	var err error
	if payload != nil {
		raw, mErr := json.Marshal(payload)
		if mErr != nil {
			t.Fatalf("marshal %s %s: %v", method, reqPath, mErr)
		}
		req, err = http.NewRequest(method, h.hubURL+reqPath, bytes.NewReader(raw))
	} else {
		req, err = http.NewRequest(method, h.hubURL+reqPath, nil)
	}
	if err != nil {
		t.Fatalf("new request %s %s: %v", method, reqPath, err)
	}
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request %s %s: %v", method, reqPath, err)
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(resp.Body); err != nil {
		t.Fatalf("read response %s %s: %v", method, reqPath, err)
	}
	return resp.StatusCode, buf.Bytes()
}

func s3AssertError(t *testing.T, gotStatus int, raw []byte, wantStatus int, wantCode string) evalSlice3ErrorResp {
	t.Helper()
	if gotStatus != wantStatus {
		t.Fatalf("expected HTTP %d (%s), got %d: %s", wantStatus, wantCode, gotStatus, string(raw))
	}
	var env evalSlice3ErrorResp
	if err := json.Unmarshal(raw, &env); err != nil || env.OK || env.Error.Code != wantCode {
		t.Fatalf("expected error.code=%s, got decodeErr=%v body=%s", wantCode, err, string(raw))
	}
	return env
}

func s3CreateRun(t *testing.T, h *testHarness, tok string, payload map[string]interface{}, wantStatus ...int) evalSlice3Run {
	t.Helper()
	st, raw := h.doJSON(http.MethodPost, "/api/v1/runs?wait_ms=0", tok, payload)
	if len(wantStatus) > 0 {
		matched := false
		for _, ws := range wantStatus {
			if st == ws {
				matched = true
				break
			}
		}
		if !matched {
			t.Fatalf("POST /api/v1/runs expected status %v, got %d: %s", wantStatus, st, string(raw))
		}
	} else if st != http.StatusOK && st != http.StatusCreated && st != http.StatusAccepted {
		t.Fatalf("POST /api/v1/runs failed (%d): %s", st, string(raw))
	}
	var env evalSlice3RunResp
	if err := json.Unmarshal(raw, &env); err != nil || !env.OK {
		t.Fatalf("decode createRun resp: %v (%s)", err, string(raw))
	}
	return env.Run
}

func s3GetRun(t *testing.T, h *testHarness, tok, runID string, full bool) evalSlice3Run {
	t.Helper()
	view := "summary"
	if full {
		view = "full"
	}
	st, raw := h.doJSON(http.MethodGet, "/api/v1/runs/"+runID+"?view="+view, tok, nil)
	if st != http.StatusOK {
		t.Fatalf("GET /api/v1/runs/%s failed (%d): %s", runID, st, string(raw))
	}
	var env evalSlice3RunResp
	if err := json.Unmarshal(raw, &env); err != nil || !env.OK {
		t.Fatalf("decode getRun %s: %v (%s)", runID, err, string(raw))
	}
	return env.Run
}

func s3WaitRunStatus(t *testing.T, h *testHarness, tok, runID, wantStatus string, timeout time.Duration) evalSlice3Run {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var last evalSlice3Run
	for {
		last = s3GetRun(t, h, tok, runID, false)
		if last.Status == wantStatus {
			return last
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for run %s status=%s (last=%s blocked=%v err=%s msg=%s)",
				runID, wantStatus, last.Status, last.BlockedReason, last.ErrorCode, last.ErrorMessage)
		}
		time.Sleep(60 * time.Millisecond)
	}
}

func s3CreateTopic(t *testing.T, h *testHarness, tok, channel, title string) evalSlice3BoardTopic {
	t.Helper()
	st, raw := h.doJSON(http.MethodPost, "/api/v1/board/topics", tok, map[string]interface{}{
		"channel": channel,
		"title":   title,
		"status":  "todo",
	})
	if st != http.StatusCreated && st != http.StatusOK {
		t.Fatalf("create board topic (%s/%s) failed (%d): %s", channel, title, st, string(raw))
	}
	var env evalSlice3BoardTopicResp
	if err := json.Unmarshal(raw, &env); err != nil || !env.OK {
		t.Fatalf("decode createTopic: %v (%s)", err, string(raw))
	}
	return env.Topic
}

func s3DialFakeNodeWS(t *testing.T, ctx context.Context, h *testHarness, nodeTok, nonce string, workspaces []map[string]string) *websocket.Conn {
	t.Helper()
	if workspaces == nil {
		workspaces = []map[string]string{}
	}
	conn, err := api.NewClient(h.hubURL, nodeTok).DialWebSocket(ctx, "/ws/node")
	if err != nil {
		t.Fatalf("dial /ws/node failed: %v", err)
	}
	hello, _ := json.Marshal(map[string]interface{}{
		"type":            "node.hello",
		"conn_nonce":      nonce,
		"version":         "0.2.0-test",
		"os":              "darwin",
		"arch":            "arm64",
		"max_concurrency": 2,
		"capabilities": map[string]interface{}{
			"agents": map[string]interface{}{
				"agy": map[string]interface{}{"enabled": true, "available": true},
			},
		},
		"workspaces": workspaces,
	})
	if err := conn.Write(ctx, websocket.MessageText, hello); err != nil {
		_ = conn.Close(websocket.StatusNormalClosure, "write failed")
		t.Fatalf("write node.hello failed: %v", err)
	}
	_, raw, err := conn.Read(ctx)
	if err != nil {
		_ = conn.Close(websocket.StatusNormalClosure, "read failed")
		t.Fatalf("read hub.welcome failed: %v", err)
	}
	var welcome map[string]interface{}
	if err := json.Unmarshal(raw, &welcome); err != nil || welcome["type"] != "hub.welcome" {
		_ = conn.Close(websocket.StatusNormalClosure, "bad welcome")
		t.Fatalf("expected hub.welcome frame, got %v (%s)", err, string(raw))
	}
	return conn
}

func s3IsNullJSON(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) == 0 || string(trimmed) == "null"
}

func s3AssertNoResultTempDirs(t *testing.T, resultTmp, label string) {
	t.Helper()
	entries, err := os.ReadDir(resultTmp)
	if err != nil {
		t.Fatalf("%s: read resultTmp %s failed: %v", label, resultTmp, err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "ahub-result-") {
			t.Fatalf("MG-6 violated (%s): leftover temp dir/file %q in %s", label, e.Name(), resultTmp)
		}
	}
}

func s3WaitNoResultTempDirs(t *testing.T, resultTmp, label string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		entries, err := os.ReadDir(resultTmp)
		if err != nil {
			t.Fatalf("%s: read resultTmp %s failed: %v", label, resultTmp, err)
		}
		found := false
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), "ahub-result-") {
				found = true
				break
			}
		}
		if !found {
			return
		}
		if time.Now().After(deadline) {
			s3AssertNoResultTempDirs(t, resultTmp, label)
			return
		}
		time.Sleep(40 * time.Millisecond)
	}
}

func s3BuildNestedObjectSchema(nestedLevels int) map[string]interface{} {
	cur := map[string]interface{}{"type": "string"}
	for i := nestedLevels; i >= 1; i-- {
		cur = map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				fmt.Sprintf("n%d", i): cur,
			},
		}
	}
	return cur
}

func s3BuildWideSchema(propCount int) map[string]interface{} {
	props := make(map[string]interface{}, propCount)
	for i := 0; i < propCount; i++ {
		props[fmt.Sprintf("p%d", i)] = map[string]interface{}{"type": "string"}
	}
	return map[string]interface{}{
		"type":       "object",
		"properties": props,
	}
}

func s3BuildSizedSchema(targetBytes int) map[string]interface{} {
	base := map[string]interface{}{
		"type":        "object",
		"description": "",
		"properties": map[string]interface{}{
			"ok": map[string]interface{}{"type": "boolean"},
		},
	}
	raw, _ := json.Marshal(base)
	padLen := targetBytes - len(raw)
	if padLen < 0 {
		padLen = 0
	}
	base["description"] = strings.Repeat("a", padLen)
	return base
}

// I-16 (F9 + P-07): Run labels validation (<=16 pairs, ahub.* reserved on create, regex/control-char bounds,
// secret redaction, Idempotency-Key conflict, retry copy, /claim & WS propagation, ?label=k=v filtering via json_each,
// repeatable AND up to 8 vs 9, and client scope isolation).
func TestInvariant_Slice3_LabelsValidationAndFiltering(t *testing.T) {
	h := newTestHarness(t)

	macRoot := filepath.Join(h.tmpDir, "workspaces", "s3l-mac-root")
	macDir := h.makeWorkspaceDir(filepath.Join("s3l-mac-root", "proj-labels"))

	macTok := h.createKey("s3l-mac", "node", "macmini", []string{"macmini"}, 0)
	claimProbeTok := h.createKey("s3l-claim-probe", "node", "claim-probe", []string{"claim-probe"}, 0)
	clientATok := h.createKey("s3l-client-a", "client", "", []string{"macmini"}, 1)
	clientBTok := h.createKey("s3l-client-b", "client", "", []string{"macmini"}, 1)

	h.startDaemon("macmini", macTok, "", macRoot, 2)

	// Subscribe to admin /ws/stream to verify run.updated carries Slice 3 labels
	wsCtx, wsCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer wsCancel()
	streamConn, err := api.NewClient(h.hubURL, h.adminToken).DialWebSocket(wsCtx, "/ws/stream")
	if err != nil {
		t.Fatalf("dial /ws/stream failed: %v", err)
	}
	defer streamConn.Close(websocket.StatusNormalClosure, "done")
	if _, _, err := streamConn.Read(wsCtx); err != nil {
		t.Fatalf("read initial /ws/stream snapshot failed: %v", err)
	}

	var wsMu sync.Mutex
	wsRunsByID := map[string]evalSlice3Run{}
	go func() {
		for {
			_, msg, rErr := streamConn.Read(wsCtx)
			if rErr != nil {
				return
			}
			var frame struct {
				Type string        `json:"type"`
				Run  evalSlice3Run `json:"run"`
			}
			if json.Unmarshal(msg, &frame) == nil && frame.Type == "run.updated" && frame.Run.ID != "" {
				wsMu.Lock()
				wsRunsByID[frame.Run.ID] = frame.Run
				wsMu.Unlock()
			}
		}
	}()

	// 1. Verify /claim returns labels & result_schema on claimed_runs[]
	probeDir := filepath.Join(h.tmpDir, "workspaces", "s3l-probe-root", "proj-cp")
	probeWS := []map[string]string{{"key": "proj-cp", "path": probeDir}}
	probeConn := s3DialFakeNodeWS(t, wsCtx, h, claimProbeTok, "nonce_claim_probe_s3", probeWS)
	defer probeConn.Close(websocket.StatusNormalClosure, "done")

	claimSeedRun := s3CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "claim-probe",
		"workdir": probeDir,
		"agent":   "agy",
		"labels":  map[string]string{"env": "claim", "svc.tier": "gold"},
		"result_schema": map[string]interface{}{
			"type":       "object",
			"required":   []string{"ok"},
			"properties": map[string]interface{}{"ok": map[string]interface{}{"type": "boolean"}},
		},
		"prompt": "claim probe payload",
	})
	stClaim, rawClaim := h.doJSON(http.MethodPost, "/api/v1/nodes/claim-probe/claim", claimProbeTok, map[string]interface{}{
		"conn_nonce": "nonce_claim_probe_s3",
	})
	if stClaim != http.StatusOK {
		t.Fatalf("POST /claim failed (%d): %s", stClaim, string(rawClaim))
	}
	var claimResp evalSlice3ClaimResp
	if err := json.Unmarshal(rawClaim, &claimResp); err != nil || len(claimResp.ClaimedRuns) != 1 {
		t.Fatalf("expected 1 claimed run, got err=%v body=%s", err, string(rawClaim))
	}
	claimed := claimResp.ClaimedRuns[0]
	if claimed.ID != claimSeedRun.ID || claimed.Labels["env"] != "claim" || claimed.Labels["svc.tier"] != "gold" || claimed.ResultSchema == nil {
		t.Fatalf("claimed_runs[0] missing labels or result_schema: %+v", claimed)
	}
	_, _ = h.doJSON(http.MethodPost, "/api/v1/runs/"+claimSeedRun.ID+"/cancel", h.adminToken, map[string]interface{}{"cascade": false})

	// 2. 16-label boundary on POST /api/v1/runs + WS run.updated propagation + GET /runs/:id
	labels16 := map[string]string{
		"env":        "staging",
		"svc.tier":   "gold",
		"team/owner": "core",
		"expr":       "a=b",
	}
	for i := 4; i < 16; i++ {
		labels16[fmt.Sprintf("k_%d", i)] = fmt.Sprintf("v-%d", i)
	}
	if len(labels16) != 16 {
		t.Fatalf("test bug: expected 16 labels, got %d", len(labels16))
	}
	r16 := s3CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini",
		"workdir": macDir,
		"agent":   "agy",
		"labels":  labels16,
		"prompt":  `{"directives":[{"op":"sleep","ms":20}]}`,
	})
	if len(r16.Labels) != 16 || r16.Labels["svc.tier"] != "gold" || r16.Labels["expr"] != "a=b" {
		t.Fatalf("16-label create response mismatch: %+v", r16.Labels)
	}
	r16Done := s3WaitRunStatus(t, h, h.adminToken, r16.ID, "done", 12*time.Second)
	if len(r16Done.Labels) != 16 || r16Done.Labels["team/owner"] != "core" {
		t.Fatalf("GET /runs/:id lost 16 labels: %+v", r16Done.Labels)
	}
	wsDeadline := time.Now().Add(5 * time.Second)
	for {
		wsMu.Lock()
		wsRun, ok := wsRunsByID[r16.ID]
		wsMu.Unlock()
		if ok && len(wsRun.Labels) == 16 && wsRun.Labels["expr"] == "a=b" {
			break
		}
		if time.Now().After(wsDeadline) {
			t.Fatalf("WS run.updated missing 16 labels for %s (last=%+v)", r16.ID, wsRun.Labels)
		}
		time.Sleep(50 * time.Millisecond)
	}

	// 3. POST /api/v1/plans with node-level labels + Idempotency-Key conflict on labels
	planIdemKey := "s3-plan-labels-idem-01"
	planBase := map[string]interface{}{
		"idempotency_key": planIdemKey,
		"nodes": []map[string]interface{}{
			{
				"key":     "n1",
				"node_id": "macmini",
				"workdir": macDir,
				"agent":   "agy",
				"labels":  map[string]string{"svc.tier": "gold", "stage": "build"},
				"prompt":  `{"directives":[{"op":"sleep","ms":20}]}`,
			},
		},
	}
	stP1, rawP1 := h.doJSON(http.MethodPost, "/api/v1/plans", h.adminToken, planBase)
	if stP1 != http.StatusCreated {
		t.Fatalf("POST /plans with labels expected 201, got %d: %s", stP1, string(rawP1))
	}
	var p1Resp evalSlice3PlanResp
	if err := json.Unmarshal(rawP1, &p1Resp); err != nil || len(p1Resp.Runs) != 1 {
		t.Fatalf("decode plan resp: %v (%s)", err, string(rawP1))
	}
	if p1Resp.Runs[0].Labels["svc.tier"] != "gold" || p1Resp.Runs[0].Labels["stage"] != "build" {
		t.Fatalf("plan node labels not propagated to created run: %+v", p1Resp.Runs[0].Labels)
	}
	_ = s3WaitRunStatus(t, h, h.adminToken, p1Resp.Runs[0].ID, "done", 12*time.Second)

	// Idempotent plan replay with same labels -> 200 deduplicated: true
	stP1Dup, rawP1Dup := h.doJSON(http.MethodPost, "/api/v1/plans", h.adminToken, planBase)
	if stP1Dup != http.StatusOK {
		t.Fatalf("idempotent plan replay expected 200, got %d: %s", stP1Dup, string(rawP1Dup))
	}
	var p1DupResp evalSlice3PlanResp
	if err := json.Unmarshal(rawP1Dup, &p1DupResp); err != nil || !p1DupResp.Deduplicated || p1DupResp.PlanID != p1Resp.PlanID {
		t.Fatalf("expected deduplicated plan replay, got %s", string(rawP1Dup))
	}

	// Idempotency conflict when plan node labels differ -> 409 IDEMPOTENCY_CONFLICT
	planConflict := map[string]interface{}{
		"idempotency_key": planIdemKey,
		"nodes": []map[string]interface{}{
			{
				"key":     "n1",
				"node_id": "macmini",
				"workdir": macDir,
				"agent":   "agy",
				"labels":  map[string]string{"svc.tier": "silver", "stage": "build"},
				"prompt":  `{"directives":[{"op":"sleep","ms":20}]}`,
			},
		},
	}
	stP1Conf, rawP1Conf := h.doJSON(http.MethodPost, "/api/v1/plans", h.adminToken, planConflict)
	s3AssertError(t, stP1Conf, rawP1Conf, http.StatusConflict, "IDEMPOTENCY_CONFLICT")

	// Idempotency conflict on /runs when labels differ -> 409 IDEMPOTENCY_CONFLICT
	runIdemKey := "s3-run-labels-idem-01"
	runBase := map[string]interface{}{
		"idempotency_key": runIdemKey,
		"node_id":         "macmini",
		"workdir":         macDir,
		"agent":           "agy",
		"labels":          map[string]string{"env": "staging", "tag": "alpha"},
		"prompt":          `{"directives":[{"op":"sleep","ms":15}]}`,
	}
	rIdem := s3CreateRun(t, h, h.adminToken, runBase)
	_ = s3WaitRunStatus(t, h, h.adminToken, rIdem.ID, "done", 12*time.Second)

	stRIdemDup, rawRIdemDup := h.doJSON(http.MethodPost, "/api/v1/runs?wait_ms=0", h.adminToken, runBase)
	if stRIdemDup != http.StatusOK && stRIdemDup != http.StatusAccepted {
		t.Fatalf("idempotent run replay expected 200 or 202, got %d: %s", stRIdemDup, string(rawRIdemDup))
	}
	var rIdemDup evalSlice3RunResp
	if err := json.Unmarshal(rawRIdemDup, &rIdemDup); err != nil || !rIdemDup.OK || rIdemDup.Run.ID != rIdem.ID {
		t.Fatalf("idempotent run replay expected same run %s, got err=%v body=%s", rIdem.ID, err, string(rawRIdemDup))
	}
	runConflict := map[string]interface{}{
		"idempotency_key": runIdemKey,
		"node_id":         "macmini",
		"workdir":         macDir,
		"agent":           "agy",
		"labels":          map[string]string{"env": "staging", "tag": "beta"},
		"prompt":          `{"directives":[{"op":"sleep","ms":15}]}`,
	}
	stRConf, rawRConf := h.doJSON(http.MethodPost, "/api/v1/runs?wait_ms=0", h.adminToken, runConflict)
	s3AssertError(t, stRConf, rawRConf, http.StatusConflict, "IDEMPOTENCY_CONFLICT")

	// 4. Negative / Quota / ahub.* reserved / Redaction checks
	labels17 := map[string]string{}
	for i := 0; i < 17; i++ {
		labels17[fmt.Sprintf("k-%d", i)] = "v"
	}
	badRunLabelCases := []struct {
		name   string
		labels map[string]string
	}{
		{"17_labels", labels17},
		{"reserved_ahub_plan_id", map[string]string{"ahub.plan_id": "pln_spoof"}},
		{"reserved_ahub_source", map[string]string{"ahub.source": "caller"}},
		{"uppercase_key", map[string]string{"BadKey": "val"}},
		{"empty_key", map[string]string{"": "val"}},
		{"65char_key", map[string]string{strings.Repeat("k", 65): "val"}},
		{"leading_dash_key", map[string]string{"-bad": "val"}},
		{"129char_value", map[string]string{"env": strings.Repeat("x", 129)}},
		{"newline_value", map[string]string{"env": "bad\nval"}},
		{"del_char_value", map[string]string{"env": "bad\x7fval"}},
	}
	for _, tc := range badRunLabelCases {
		st, raw := h.doJSON(http.MethodPost, "/api/v1/runs?wait_ms=0", h.adminToken, map[string]interface{}{
			"node_id": "macmini",
			"workdir": macDir,
			"agent":   "agy",
			"labels":  tc.labels,
			"prompt":  "should fail label validation",
		})
		s3AssertError(t, st, raw, http.StatusBadRequest, "BAD_REQUEST")
	}

	// Also reject 17 labels & ahub.* on POST /api/v1/plans (MG-6)
	for _, badPlanLabels := range []map[string]string{
		labels17,
		{"ahub.plan_id": "pln_spoof"},
		{"BadKey": "val"},
	} {
		st, raw := h.doJSON(http.MethodPost, "/api/v1/plans", h.adminToken, map[string]interface{}{
			"nodes": []map[string]interface{}{
				{
					"key":     "bad",
					"node_id": "macmini",
					"workdir": macDir,
					"agent":   "agy",
					"labels":  badPlanLabels,
					"prompt":  "bad plan labels",
				},
			},
		})
		s3AssertError(t, st, raw, http.StatusBadRequest, "BAD_REQUEST")
	}

	// Secret redaction in label values (30+-char tokens)
	secretSk := "sk-proj-LabelSecret1234567890abcdef"
	secretGh := "ghp_LabelSecret1234567890abcdef"
	secLabelRun := s3CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini",
		"workdir": macDir,
		"agent":   "agy",
		"labels": map[string]string{
			"note": secretSk,
			"gh":   secretGh,
		},
		"prompt": `{"directives":[{"op":"sleep","ms":15}]}`,
	})
	_ = s3WaitRunStatus(t, h, h.adminToken, secLabelRun.ID, "done", 12*time.Second)
	secLoaded := s3GetRun(t, h, h.adminToken, secLabelRun.ID, false)
	if strings.Contains(secLoaded.Labels["note"], secretSk) || !strings.Contains(secLoaded.Labels["note"], "[REDACTED]") {
		t.Fatalf("label note secret not redacted: %+v", secLoaded.Labels)
	}
	if strings.Contains(secLoaded.Labels["gh"], secretGh) || !strings.Contains(secLoaded.Labels["gh"], "[REDACTED]") {
		t.Fatalf("label gh secret not redacted: %+v", secLoaded.Labels)
	}

	// 5. Retry copies labels_json and clears result
	failLabeled := s3CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini",
		"workdir": macDir,
		"agent":   "agy",
		"labels":  map[string]string{"env": "retry-test", "svc.tier": "silver"},
		"prompt":  `{"directives":[{"op":"exit","code":1,"message":"fail for label retry"}]}`,
	})
	_ = s3WaitRunStatus(t, h, h.adminToken, failLabeled.ID, "failed", 12*time.Second)
	stRet, rawRet := h.doJSON(http.MethodPost, "/api/v1/runs/"+failLabeled.ID+"/retry", h.adminToken, map[string]interface{}{})
	if stRet != http.StatusCreated {
		t.Fatalf("retry failed (%d): %s", stRet, string(rawRet))
	}
	var retResp evalSlice3RetryResp
	if err := json.Unmarshal(rawRet, &retResp); err != nil || !retResp.OK {
		t.Fatalf("decode retry resp: %v (%s)", err, string(rawRet))
	}
	if retResp.Run.Labels["env"] != "retry-test" || retResp.Run.Labels["svc.tier"] != "silver" || !s3IsNullJSON(retResp.Run.Result) {
		t.Fatalf("retry did not copy labels or clear result: %+v", retResp.Run)
	}
	_ = s3WaitRunStatus(t, h, h.adminToken, retResp.Run.ID, "failed", 12*time.Second)

	// 6. ?label=k=v filtering (json_each dot-key, '=' in value, repeatable AND up to 8 vs 9, ahub.* query allowed)
	// Dot key svc.tier=gold should match r16 and p1Resp.Runs[0], not failLabeled
	stDot, rawDot := h.doJSON(http.MethodGet, "/api/v1/runs?label=svc.tier=gold&limit=50", h.adminToken, nil)
	if stDot != http.StatusOK {
		t.Fatalf("GET /runs?label=svc.tier=gold failed (%d): %s", stDot, string(rawDot))
	}
	var dotResp evalSlice3RunsListResp
	if err := json.Unmarshal(rawDot, &dotResp); err != nil {
		t.Fatalf("decode dot label list: %v (%s)", err, string(rawDot))
	}
	seenR16, seenPlanRun := false, false
	for _, r := range dotResp.Runs {
		if r.Labels["svc.tier"] != "gold" {
			t.Fatalf("?label=svc.tier=gold returned non-matching run %s: %+v", r.ID, r.Labels)
		}
		if r.ID == r16.ID {
			seenR16 = true
		}
		if r.ID == p1Resp.Runs[0].ID {
			seenPlanRun = true
		}
	}
	if !seenR16 || !seenPlanRun {
		t.Fatalf("?label=svc.tier=gold missing expected runs (seenR16=%v seenPlanRun=%v)", seenR16, seenPlanRun)
	}

	// Value containing '=' (expr=a=b)
	stEq, rawEq := h.doJSON(http.MethodGet, "/api/v1/runs?label=expr=a=b&limit=50", h.adminToken, nil)
	if stEq != http.StatusOK {
		t.Fatalf("GET /runs?label=expr=a=b failed (%d): %s", stEq, string(rawEq))
	}
	var eqResp evalSlice3RunsListResp
	_ = json.Unmarshal(rawEq, &eqResp)
	if len(eqResp.Runs) != 1 || eqResp.Runs[0].ID != r16.ID {
		t.Fatalf("expected strictly r16 for ?label=expr=a=b, got %+v", eqResp.Runs)
	}

	// Repeatable AND: env=staging AND team/owner=core -> matches r16, excludes rIdem (env=staging, tag=alpha)
	stAnd, rawAnd := h.doJSON(http.MethodGet, "/api/v1/runs?label=env=staging&label=team/owner=core&limit=50", h.adminToken, nil)
	if stAnd != http.StatusOK {
		t.Fatalf("GET repeatable AND label failed (%d): %s", stAnd, string(rawAnd))
	}
	var andResp evalSlice3RunsListResp
	_ = json.Unmarshal(rawAnd, &andResp)
	if len(andResp.Runs) != 1 || andResp.Runs[0].ID != r16.ID {
		t.Fatalf("expected strictly r16 for repeatable AND label query, got %+v", andResp.Runs)
	}

	// 8 ?label= filters boundary passes; 9 ?label= filters returns 400 BAD_REQUEST
	eightQ := strings.Repeat("label=env=staging&", 8)
	st8, raw8 := h.doJSON(http.MethodGet, "/api/v1/runs?"+strings.TrimSuffix(eightQ, "&"), h.adminToken, nil)
	if st8 != http.StatusOK {
		t.Fatalf("8 ?label= params boundary expected 200, got %d: %s", st8, string(raw8))
	}
	nineQ := strings.Repeat("label=env=staging&", 9)
	st9, raw9 := h.doJSON(http.MethodGet, "/api/v1/runs?"+strings.TrimSuffix(nineQ, "&"), h.adminToken, nil)
	s3AssertError(t, st9, raw9, http.StatusBadRequest, "BAD_REQUEST")

	// Querying ahub.* keys via ?label= is explicitly allowed (200)
	stAhubQ, rawAhubQ := h.doJSON(http.MethodGet, "/api/v1/runs?label=ahub.plan_id=pln_none", h.adminToken, nil)
	if stAhubQ != http.StatusOK {
		t.Fatalf("?label=ahub.plan_id=... should be allowed (200), got %d: %s", stAhubQ, string(rawAhubQ))
	}
	var ahubQResp evalSlice3RunsListResp
	if err := json.Unmarshal(rawAhubQ, &ahubQResp); err != nil || len(ahubQResp.Runs) != 0 {
		t.Fatalf("expected 0 runs for ?label=ahub.plan_id=pln_none, got err=%v body=%s", err, string(rawAhubQ))
	}

	// Invalid ?label= query parameters -> 400 BAD_REQUEST
	for _, badQ := range []string{
		"/api/v1/runs?label=missingeq",
		"/api/v1/runs?label=BadKey=1",
		"/api/v1/runs?label=k=bad%0Aval",
	} {
		stBadQ, rawBadQ := h.doJSON(http.MethodGet, badQ, h.adminToken, nil)
		s3AssertError(t, stBadQ, rawBadQ, http.StatusBadRequest, "BAD_REQUEST")
	}

	// 7. P-07: clientA rejected 400 on ahub.*; clientB ?label=env=staging sees zero clientA runs
	stCliAhub, rawCliAhub := h.doJSON(http.MethodPost, "/api/v1/runs?wait_ms=0", clientATok, map[string]interface{}{
		"node_id": "macmini",
		"workdir": macDir,
		"agent":   "agy",
		"labels":  map[string]string{"ahub.spoof": "1"},
		"prompt":  "client ahub.* forbidden",
	})
	s3AssertError(t, stCliAhub, rawCliAhub, http.StatusBadRequest, "BAD_REQUEST")

	cliARun := s3CreateRun(t, h, clientATok, map[string]interface{}{
		"node_id": "macmini",
		"workdir": macDir,
		"agent":   "agy",
		"labels":  map[string]string{"env": "staging", "owner": "client-a"},
		"prompt":  `{"directives":[{"op":"sleep","ms":15}]}`,
	})
	cliBRun := s3CreateRun(t, h, clientBTok, map[string]interface{}{
		"node_id": "macmini",
		"workdir": macDir,
		"agent":   "agy",
		"labels":  map[string]string{"env": "staging", "owner": "client-b"},
		"prompt":  `{"directives":[{"op":"sleep","ms":15}]}`,
	})
	_ = s3WaitRunStatus(t, h, h.adminToken, cliARun.ID, "done", 12*time.Second)
	_ = s3WaitRunStatus(t, h, h.adminToken, cliBRun.ID, "done", 12*time.Second)

	stCliBList, rawCliBList := h.doJSON(http.MethodGet, "/api/v1/runs?label=env=staging&limit=50", clientBTok, nil)
	if stCliBList != http.StatusOK {
		t.Fatalf("clientB GET /runs?label=env=staging failed (%d): %s", stCliBList, string(rawCliBList))
	}
	var cliBList evalSlice3RunsListResp
	if err := json.Unmarshal(rawCliBList, &cliBList); err != nil {
		t.Fatalf("decode clientB list: %v (%s)", err, string(rawCliBList))
	}
	sawCliB := false
	for _, r := range cliBList.Runs {
		if r.ID == cliARun.ID || r.ID == r16.ID {
			t.Fatalf("P-07 violated: clientB ?label=env=staging leaked foreign run %s (%+v)", r.ID, r.Labels)
		}
		if r.ID == cliBRun.ID {
			sawCliB = true
		}
	}
	if !sawCliB {
		t.Fatalf("P-07 clientB missing own labeled run %s in %s", cliBRun.ID, string(rawCliBList))
	}

	// 8. CLI smoke: ahub run --label, ahub runs --label, ahub run --label ahub.x=1 (exit 64)
	cliCode, cliOut, cliErr := h.runCLI(
		`{"directives":[{"op":"sleep","ms":15}]}`,
		"run", "-n", "macmini", "-d", macDir, "-a", "agy",
		"--label", "env=cli", "--label", "tier=t1",
		"--wait", "15s", "--json", "-",
	)
	if cliCode != api.ExitOK {
		t.Fatalf("ahub run --label failed (exit %d)\nstdout: %s\nstderr: %s", cliCode, cliOut, cliErr)
	}
	var cliRunRec evalSlice3Run
	if err := json.Unmarshal([]byte(cliOut), &cliRunRec); err != nil {
		t.Fatalf("ahub run --label --json invalid JSON: %v\nraw: %s", err, cliOut)
	}
	if cliRunRec.Labels["env"] != "cli" || cliRunRec.Labels["tier"] != "t1" {
		t.Fatalf("ahub run --label did not persist labels: %+v", cliRunRec.Labels)
	}

	runsCode, runsOut, runsErr := h.runCLI("", "runs", "--label", "env=cli", "--label", "tier=t1", "--json")
	if runsCode != api.ExitOK {
		t.Fatalf("ahub runs --label failed (exit %d)\nstdout: %s\nstderr: %s", runsCode, runsOut, runsErr)
	}
	var cliRunsEnv evalSlice3RunsListResp
	if err := json.Unmarshal([]byte(runsOut), &cliRunsEnv); err != nil || !cliRunsEnv.OK || len(cliRunsEnv.Runs) != 1 || cliRunsEnv.Runs[0].ID != cliRunRec.ID {
		t.Fatalf("ahub runs --label --json unexpected output: err=%v out=%s", err, runsOut)
	}

	badCLICode, _, _ := h.runCLI("", "run", "-n", "macmini", "-d", macDir, "-a", "agy", "--label", "ahub.x=1", "--json", "bad")
	if badCLICode != api.ExitBadUsageOrInput {
		t.Fatalf("expected exit 64 for ahub run --label ahub.x=1, got %d", badCLICode)
	}
	badRunsCLICode, _, _ := h.runCLI("", "runs", "--label", "missingeq", "--json")
	if badRunsCLICode != api.ExitBadUsageOrInput {
		t.Fatalf("expected exit 64 for ahub runs --label missingeq, got %d", badRunsCLICode)
	}
}

// I-17 (F10 + P-05 + P-06 + P-09): result_schema <=16KB & zero-eval subset bounds, AHUB_RESULT_FILE
// injection without AHUB_TOKEN leak, secret redaction before size/schema check, temp cleanup across
// normal/exit:1/hub.abort, RESULT_SCHEMA_MISMATCH preserving output_md & output_bytes across
// mismatch/malformed/>64KB/missing, non-done preservation, P-05 retry recovery, P-06 grandchild abort,
// P-09 actor_profile redacted handoff, and ahub result --data --json exit 0/10/64.
func TestInvariant_Slice3_StructuredResultLifecycle(t *testing.T) {
	h := newTestHarness(t)

	macRoot := filepath.Join(h.tmpDir, "workspaces", "s3r-mac-root")
	macDir := h.makeWorkspaceDir(filepath.Join("s3r-mac-root", "proj-results"))
	resultTmp := filepath.Join(h.tmpDir, "runner-tmp")
	if err := os.MkdirAll(resultTmp, 0o755); err != nil {
		t.Fatal(err)
	}

	macTok := h.createKey("s3r-mac", "node", "macmini", []string{"macmini"}, 0)
	h.startDaemon("macmini", macTok, "", macRoot, 2, "TMPDIR="+resultTmp)

	topS3 := s3CreateTopic(t, h, h.adminToken, "proj/demo", "Slice 3 Structured Handoff Topic")

	// 1. result_schema creation bounds (<=16384 B, depth, nodes, pattern, forbidden keywords) & Idempotency-Key
	schema16K := s3BuildSizedSchema(16384)
	if raw16K, _ := json.Marshal(schema16K); len(raw16K) != 16384 {
		t.Fatalf("test setup error: expected 16384B schema, got %d", len(raw16K))
	}
	ok16KRun := s3CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":       "macmini",
		"workdir":       macDir,
		"agent":         "agy",
		"result_schema": schema16K,
		"prompt":        `{"directives":[{"op":"write_result_file","result":{"ok":true}}]}`,
	})
	_ = s3WaitRunStatus(t, h, h.adminToken, ok16KRun.ID, "done", 12*time.Second)

	schema16KOver := s3BuildSizedSchema(16385)
	if rawOver, _ := json.Marshal(schema16KOver); len(rawOver) != 16385 {
		t.Fatalf("test setup error: expected 16385B schema, got %d", len(rawOver))
	}
	stOverRun, rawOverRun := h.doJSON(http.MethodPost, "/api/v1/runs?wait_ms=0", h.adminToken, map[string]interface{}{
		"node_id":       "macmini",
		"workdir":       macDir,
		"agent":         "agy",
		"result_schema": schema16KOver,
		"prompt":        "oversize schema",
	})
	s3AssertError(t, stOverRun, rawOverRun, http.StatusBadRequest, "BAD_REQUEST")

	stOverPlan, rawOverPlan := h.doJSON(http.MethodPost, "/api/v1/plans", h.adminToken, map[string]interface{}{
		"nodes": []map[string]interface{}{
			{
				"key":           "over",
				"node_id":       "macmini",
				"workdir":       macDir,
				"agent":         "agy",
				"result_schema": schema16KOver,
				"prompt":        "oversize schema in plan",
			},
		},
	})
	s3AssertError(t, stOverPlan, rawOverPlan, http.StatusBadRequest, "BAD_REQUEST")

	// Depth <= 16 & nodes <= 256 boundary checks pass
	depthOKRun := s3CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":       "macmini",
		"workdir":       macDir,
		"agent":         "agy",
		"result_schema": s3BuildNestedObjectSchema(14),
		"prompt":        `{"directives":[{"op":"write_result_file","result":{}}]}`,
	})
	_ = s3WaitRunStatus(t, h, h.adminToken, depthOKRun.ID, "done", 12*time.Second)

	wideOKRun := s3CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":       "macmini",
		"workdir":       macDir,
		"agent":         "agy",
		"result_schema": s3BuildWideSchema(255),
		"prompt":        `{"directives":[{"op":"write_result_file","result":{}}]}`,
	})
	_ = s3WaitRunStatus(t, h, h.adminToken, wideOKRun.ID, "done", 12*time.Second)

	// Disallowed keywords, depth > 16, nodes > 256, pattern > 256, invalid regex -> 400 BAD_REQUEST
	invalidSchemas := []struct {
		name   string
		schema interface{}
	}{
		{"non_object_array", []string{"bad"}},
		{"non_object_string", "object"},
		{"ref_forbidden", map[string]interface{}{"$ref": "#/$defs/A"}},
		{"defs_forbidden", map[string]interface{}{"type": "object", "$defs": map[string]interface{}{"A": map[string]interface{}{"type": "string"}}}},
		{"if_forbidden", map[string]interface{}{"type": "object", "if": map[string]interface{}{"type": "object"}}},
		{"not_forbidden", map[string]interface{}{"not": map[string]interface{}{"type": "string"}}},
		{"patternProperties_forbidden", map[string]interface{}{"type": "object", "patternProperties": map[string]interface{}{"^x_": map[string]interface{}{"type": "string"}}}},
		{"unknown_keyword", map[string]interface{}{"type": "object", "x_unknown_kw": true}},
		{"depth_gt_16", s3BuildNestedObjectSchema(17)},
		{"nodes_gt_256", s3BuildWideSchema(260)},
		{"pattern_gt_256", map[string]interface{}{"type": "string", "pattern": strings.Repeat("a", 257)}},
		{"invalid_regex_pattern", map[string]interface{}{"type": "string", "pattern": "["}},
		{"redos_nested_plus", map[string]interface{}{"type": "string", "pattern": "^(a+)+$"}},
		{"redos_nested_star", map[string]interface{}{"type": "string", "pattern": "^([a-z]+)*$"}},
		{"redos_overlapping_alt", map[string]interface{}{"type": "string", "pattern": "^(a|a)+$"}},
		{"redos_wrap_around_plus", map[string]interface{}{"type": "string", "pattern": "^([a-z]+-[a-z]+)+$"}},
		{"redos_wrap_around_star_right", map[string]interface{}{"type": "string", "pattern": "^(?:[a-z]+-[a-z]*)+$"}},
		{"redos_wrap_around_star_both", map[string]interface{}{"type": "string", "pattern": "^([a-z]*-[a-z]*)+$"}},
		{"redos_wrap_around_digits", map[string]interface{}{"type": "string", "pattern": `^(\d+\.\d*)+$`}},
		{"redos_wrap_around_leading_char", map[string]interface{}{"type": "string", "pattern": "^(a[a-z]+)+$"}},
		{"redos_wrap_around_trailing_char", map[string]interface{}{"type": "string", "pattern": "^([a-z]+a)+$"}},
		{"redos_concat_grouped_dots", map[string]interface{}{"type": "string", "pattern": "^(.*)a(.*)b(.*)$"}},
		{"redos_concat_grouped_plus", map[string]interface{}{"type": "string", "pattern": "^(a+)(a+)b$"}},
		{"redos_concat_grouped_mixed", map[string]interface{}{"type": "string", "pattern": "^([a-z]+)(.*)(.*)(.*)!$"}},
		{"redos_concat_grouped_repeat12", map[string]interface{}{"type": "string", "pattern": "^" + strings.Repeat("([a-z]+)", 12) + "!$"}},
		{"redos_concat_grouped_quant12", map[string]interface{}{"type": "string", "pattern": "^([a-z]+){12}!$"}},
		{"redos_concat_one_iter_repeat8", map[string]interface{}{"type": "string", "pattern": "^" + strings.Repeat("([a-z]+){1}", 8) + "!$"}},
		{"redos_concat_opt_chain35", map[string]interface{}{"type": "string", "pattern": "^" + strings.Repeat("[a-z]?", 35) + "!$"}},
		{"redos_concat_bounded_chain20", map[string]interface{}{"type": "string", "pattern": "^" + strings.Repeat("[a-z]{0,3}", 20) + "!$"}},
		{"redos_concat_nullable_interleaved", map[string]interface{}{"type": "string", "pattern": "^" + strings.Repeat("[a-z]?0?", 4) + "!$"}},
		{"redos_concat_nullable_group_loop", map[string]interface{}{"type": "string", "pattern": "^(?:[a-z]?0?){8}$"}},
		{"redos_nested_opt_27", map[string]interface{}{"type": "string", "pattern": "^" + strings.Repeat("(?:(?:a?a?a?)?(?:a?a?a?)?(?:a?a?a?)?)?", 3) + "!$"}},
		{"redos_nested_opt_binary_32", map[string]interface{}{"type": "string", "pattern": "^(?:(?:(?:a?a?)?(?:a?a?)?)?(?:(?:a?a?)?(?:a?a?)?)?)(?:(?:(?:a?a?)?(?:a?a?)?)?(?:(?:a?a?)?(?:a?a?)?)?)$"}},
		{"redos_opt_wrapped_unbounded_anchored", map[string]interface{}{"type": "string", "pattern": "^(?:.*)?a(?:.*)?b(?:.*)?!$"}},
		{"redos_mixed_raw_opt_unbounded", map[string]interface{}{"type": "string", "pattern": "^(.*)a(?:.*)?b(.*)!$"}},
		{"redos_mixed_raw_opt_az", map[string]interface{}{"type": "string", "pattern": "^[a-z]+b(?:[a-z]+)?c[a-z]+!$"}},
		{"redos_opt_wrapped_unbounded_unanchored", map[string]interface{}{"type": "string", "pattern": "(?:.*)?a(?:.*)?b(?:.*)?!"}},
		{"redos_opt_wrapped_az_anchored", map[string]interface{}{"type": "string", "pattern": "^(?:[a-z]+)?b(?:[a-z]+)?c(?:[a-z]+)?!$"}},
		{"redos_opt_wrapped_alt_0_1", map[string]interface{}{"type": "string", "pattern": "^(?:[a-z]+|0){0,1}b(?:[a-z]+|0){0,1}c(?:[a-z]+|0){0,1}!$"}},
		{"redos_unanchored_2_dot", map[string]interface{}{"type": "string", "pattern": ".*a.*!$"}},
	}
	for _, tc := range invalidSchemas {
		st, raw := h.doJSON(http.MethodPost, "/api/v1/runs?wait_ms=0", h.adminToken, map[string]interface{}{
			"node_id":       "macmini",
			"workdir":       macDir,
			"agent":         "agy",
			"result_schema": tc.schema,
			"prompt":        "invalid schema " + tc.name,
		})
		s3AssertError(t, st, raw, http.StatusBadRequest, "BAD_REQUEST")
	}

	// T5-04b / T5-04c / T5-04d: Valid boundary-delimited & practical patterns continue to pass creation and runtime validation
	delimOKRun := s3CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini",
		"workdir": macDir,
		"agent":   "agy",
		"result_schema": map[string]interface{}{
			"type":                 "object",
			"required":             []string{"version", "path", "domain", "short_num", "semver", "email", "slug", "anchored2", "greeting"},
			"additionalProperties": false,
			"properties": map[string]interface{}{
				"version":   map[string]interface{}{"type": "string", "pattern": `^[0-9]+(\.[0-9]+)*$`},
				"path":      map[string]interface{}{"type": "string", "pattern": `(?:/[a-z0-9][a-z0-9_-]*)*`},
				"domain":    map[string]interface{}{"type": "string", "pattern": `^([a-z0-9]+\.)+[a-z]{2,}$`},
				"short_num": map[string]interface{}{"type": "string", "pattern": `^\d?\d$`},
				"semver":    map[string]interface{}{"type": "string", "pattern": `^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`},
				"email":     map[string]interface{}{"type": "string", "pattern": `^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$`},
				"slug":      map[string]interface{}{"type": "string", "pattern": `^[a-z0-9][a-z0-9_-]*(?:/[a-z0-9][a-z0-9_-]*)*$`},
				"anchored2": map[string]interface{}{"type": "string", "pattern": `^(.*)a(.*)!$`},
				"greeting":  map[string]interface{}{"type": "string", "pattern": `hello.*world`},
			},
		},
		"prompt": `{"directives":[{"op":"write_result_file","result":{"version":"1.2.3","path":"/api/v1/runs","domain":"ahub.bobocai.win","short_num":"42","semver":"v1.2.3-rc.1","email":"dev@example.com","slug":"org/repo-1","anchored2":"fooabar!","greeting":"hello big world"}}]}`,
	})
	_ = s3WaitRunStatus(t, h, h.adminToken, delimOKRun.ID, "done", 12*time.Second)

	// T5-04: ReDoS pattern also rejected on POST /api/v1/plans -> 400 BAD_REQUEST
	stPlanRedos, rawPlanRedos := h.doJSON(http.MethodPost, "/api/v1/plans", h.adminToken, map[string]interface{}{
		"nodes": []map[string]interface{}{
			{
				"key":           "redos-node",
				"node_id":       "macmini",
				"workdir":       macDir,
				"agent":         "agy",
				"result_schema": map[string]interface{}{"type": "string", "pattern": "^(a+)+$"},
				"prompt":        "redos plan node",
			},
		},
	})
	s3AssertError(t, stPlanRedos, rawPlanRedos, http.StatusBadRequest, "BAD_REQUEST")

	// Idempotency-Key with result_schema on /runs and /plans
	schemaIdemA := map[string]interface{}{
		"type":                 "object",
		"required":             []string{"ok"},
		"additionalProperties": false,
		"properties":           map[string]interface{}{"ok": map[string]interface{}{"type": "boolean"}},
	}
	schemaIdemB := map[string]interface{}{
		"type":                 "object",
		"required":             []string{"count"},
		"additionalProperties": false,
		"properties":           map[string]interface{}{"count": map[string]interface{}{"type": "integer"}},
	}
	stPIdem, rawPIdem := h.doJSON(http.MethodPost, "/api/v1/plans", h.adminToken, map[string]interface{}{
		"idempotency_key": "s3-plan-schema-idem-01",
		"nodes": []map[string]interface{}{
			{
				"key": "s1", "node_id": "macmini", "workdir": macDir, "agent": "agy",
				"result_schema": schemaIdemA,
				"prompt":        `{"directives":[{"op":"write_result_file","result":{"ok":true}}]}`,
			},
		},
	})
	if stPIdem != http.StatusCreated {
		t.Fatalf("plan with result_schema failed (%d): %s", stPIdem, string(rawPIdem))
	}
	var pIdemResp evalSlice3PlanResp
	_ = json.Unmarshal(rawPIdem, &pIdemResp)
	_ = s3WaitRunStatus(t, h, h.adminToken, pIdemResp.Runs[0].ID, "done", 12*time.Second)

	stPIdemConf, rawPIdemConf := h.doJSON(http.MethodPost, "/api/v1/plans", h.adminToken, map[string]interface{}{
		"idempotency_key": "s3-plan-schema-idem-01",
		"nodes": []map[string]interface{}{
			{
				"key": "s1", "node_id": "macmini", "workdir": macDir, "agent": "agy",
				"result_schema": schemaIdemB,
				"prompt":        `{"directives":[{"op":"write_result_file","result":{"ok":true}}]}`,
			},
		},
	})
	s3AssertError(t, stPIdemConf, rawPIdemConf, http.StatusConflict, "IDEMPOTENCY_CONFLICT")

	rSchemaIdem := s3CreateRun(t, h, h.adminToken, map[string]interface{}{
		"idempotency_key": "s3-run-schema-idem-01",
		"node_id":         "macmini",
		"workdir":         macDir,
		"agent":           "agy",
		"result_schema":   schemaIdemA,
		"prompt":          `{"directives":[{"op":"write_result_file","result":{"ok":true}}]}`,
	})
	_ = s3WaitRunStatus(t, h, h.adminToken, rSchemaIdem.ID, "done", 12*time.Second)

	stRSchemaConf, rawRSchemaConf := h.doJSON(http.MethodPost, "/api/v1/runs?wait_ms=0", h.adminToken, map[string]interface{}{
		"idempotency_key": "s3-run-schema-idem-01",
		"node_id":         "macmini",
		"workdir":         macDir,
		"agent":           "agy",
		"result_schema":   schemaIdemB,
		"prompt":          `{"directives":[{"op":"write_result_file","result":{"ok":true}}]}`,
	})
	s3AssertError(t, stRSchemaConf, rawRSchemaConf, http.StatusConflict, "IDEMPOTENCY_CONFLICT")

	// 2. Happy path + Redaction + AHUB_TOKEN isolation + Temp cleanup + P-09 (actor_profile & Board handoff)
	resultSecret := "ghp_ResultSecret1234567890abcdef"
	summarySecret := "sk-proj-SummarySecret1234567890abcdef"
	okSchema := map[string]interface{}{
		"type":                 "object",
		"required":             []string{"ok", "payload"},
		"additionalProperties": false,
		"properties": map[string]interface{}{
			"ok":      map[string]interface{}{"type": "boolean"},
			"payload": map[string]interface{}{"type": "string"},
		},
	}
	happyPromptObj := map[string]interface{}{
		"summary": "S3_SUMMARY_SECRET=" + summarySecret,
		"directives": []map[string]interface{}{
			{"op": "dump_env", "keys": []string{"AHUB_TOKEN", "AHUB_RESULT_FILE"}},
			{"op": "write_result_file", "result": map[string]interface{}{"ok": true, "payload": resultSecret}},
		},
	}
	happyPromptRaw, _ := json.Marshal(happyPromptObj)
	happyRun := s3CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":        "macmini",
		"workdir":        macDir,
		"agent":          "agy",
		"board_topic_id": topS3.ID,
		"actor_profile":  "codex-reviewer",
		"labels":         map[string]string{"suite": "s3-ok"},
		"result_schema":  okSchema,
		"notify":         map[string]string{"target": "none"},
		"prompt":         string(happyPromptRaw),
	})
	happyDone := s3WaitRunStatus(t, h, h.adminToken, happyRun.ID, "done", 12*time.Second)
	happyFull := s3GetRun(t, h, h.adminToken, happyRun.ID, true)
	if strings.Contains(happyDone.Summary, summarySecret) || !strings.Contains(happyDone.Summary, "[REDACTED]") {
		t.Fatalf("Finding 1 violated: summary secret not redacted in GET /runs/:id?view=summary: %q", happyDone.Summary)
	}
	if strings.Contains(happyFull.Summary, summarySecret) || !strings.Contains(happyFull.Summary, "[REDACTED]") {
		t.Fatalf("Finding 1 violated: summary secret not redacted in GET /runs/:id?view=full: %q", happyFull.Summary)
	}
	if !strings.Contains(happyFull.OutputMD, `"AHUB_TOKEN":"__MISSING__"`) {
		t.Fatalf("I-17 violated: AHUB_TOKEN leaked into child env: %s", happyFull.OutputMD)
	}
	if !strings.Contains(happyFull.OutputMD, `"AHUB_RESULT_FILE":"`+resultTmp) {
		t.Fatalf("I-17 violated: AHUB_RESULT_FILE not injected under %s: %s", resultTmp, happyFull.OutputMD)
	}
	if strings.Contains(string(happyDone.Result), resultSecret) || !strings.Contains(string(happyDone.Result), "[REDACTED]") {
		t.Fatalf("I-17 violated: result secret not redacted in RunRecord: %s", string(happyDone.Result))
	}
	s3AssertNoResultTempDirs(t, resultTmp, "happy-path")

	// ahub result <id> --data --json -> exit 0, single valid JSON object, zero raw secrets
	resDataCode, resDataOut, resDataErr := h.runCLI("", "result", happyRun.ID, "--data", "--json")
	if resDataCode != api.ExitOK {
		t.Fatalf("ahub result --data --json failed (exit %d)\nstdout: %s\nstderr: %s", resDataCode, resDataOut, resDataErr)
	}
	if strings.Contains(resDataOut, resultSecret) || strings.Contains(resDataOut, summarySecret) {
		t.Fatalf("ahub result --data --json leaked raw secret: %s", resDataOut)
	}
	var resDataEnv evalSlice3ResultDataResp
	if err := json.Unmarshal([]byte(resDataOut), &resDataEnv); err != nil || !resDataEnv.OK || resDataEnv.RunID != happyRun.ID || resDataEnv.Status != "done" || !strings.Contains(string(resDataEnv.Result), "[REDACTED]") {
		t.Fatalf("unexpected ahub result --data --json envelope: err=%v out=%s", err, resDataOut)
	}

	// Finding 1 E2E regression: end-to-end redaction on summary, output_md, output_preview, and remote_control_url
	// across daemon /complete & /approval, D1 GET /runs/:id?view=full, and `ahub result --full --json`.
	outputSecret := "ghp_OutputMdSecret1234567890abcdef"
	redPromptObj := map[string]interface{}{
		"summary":  "E2E_SUMMARY_SEC=" + summarySecret,
		"response": "E2E_OUTPUT_MD_SEC=" + outputSecret + " and ahub_adm_E2E_OUTPUT_999999",
		"directives": []map[string]interface{}{
			{"op": "sleep", "ms": 5},
		},
	}
	redPromptRaw, _ := json.Marshal(redPromptObj)
	redRun := s3CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini",
		"workdir": macDir,
		"agent":   "agy",
		"notify":  map[string]string{"target": "none"},
		"prompt":  string(redPromptRaw),
	})
	redDone := s3WaitRunStatus(t, h, h.adminToken, redRun.ID, "done", 12*time.Second)
	redFull := s3GetRun(t, h, h.adminToken, redRun.ID, true)
	for _, forbidden := range []string{summarySecret, outputSecret, "ahub_adm_E2E_OUTPUT_999999"} {
		if strings.Contains(redDone.Summary, forbidden) || strings.Contains(redDone.OutputPreview, forbidden) {
			t.Fatalf("Finding 1 violated: GET /runs/:id?view=summary leaked %q: summary=%q preview=%q", forbidden, redDone.Summary, redDone.OutputPreview)
		}
		if strings.Contains(redFull.Summary, forbidden) || strings.Contains(redFull.OutputMD, forbidden) {
			t.Fatalf("Finding 1 violated: GET /runs/:id?view=full leaked %q: summary=%q output_md=%q", forbidden, redFull.Summary, redFull.OutputMD)
		}
	}
	if !strings.Contains(redFull.Summary, "[REDACTED]") || !strings.Contains(redFull.OutputMD, "[REDACTED]") || !strings.Contains(redFull.OutputMD, "ahub_adm_[REDACTED]") {
		t.Fatalf("Finding 1 violated: expected redacted markers in summary/output_md: summary=%q output_md=%q", redFull.Summary, redFull.OutputMD)
	}
	cliFullCode, cliFullOut, cliFullErr := h.runCLI("", "result", redRun.ID, "--full", "--json")
	if cliFullCode != api.ExitOK {
		t.Fatalf("ahub result --full --json failed (exit %d)\nstdout: %s\nstderr: %s", cliFullCode, cliFullOut, cliFullErr)
	}
	for _, forbidden := range []string{summarySecret, outputSecret, "ahub_adm_E2E_OUTPUT_999999"} {
		if strings.Contains(cliFullOut, forbidden) {
			t.Fatalf("Finding 1 violated: ahub result --full --json leaked %q: %s", forbidden, cliFullOut)
		}
	}
	var cliFullRun evalSlice3Run
	if err := json.Unmarshal([]byte(cliFullOut), &cliFullRun); err != nil || !strings.Contains(cliFullRun.Summary, "[REDACTED]") || !strings.Contains(cliFullRun.OutputMD, "[REDACTED]") {
		t.Fatalf("unexpected ahub result --full --json payload: err=%v out=%s", err, cliFullOut)
	}

	// Approval checkpoint with credentialed remote_control_url & secret response
	apprMsgSecret := "sk-proj-ApprMsgSecret1234567890"
	apprPromptRaw, _ := json.Marshal(map[string]interface{}{
		"directives": []map[string]interface{}{
			{
				"op":      "exit_approval",
				"url":     "https://user:pass123@example.com/rc?token=rc_secret_999",
				"message": "Approval required: " + apprMsgSecret,
			},
		},
	})
	apprRun := s3CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini",
		"workdir": macDir,
		"agent":   "agy",
		"notify":  map[string]string{"target": "none"},
		"prompt":  string(apprPromptRaw),
	})
	apprPaused := s3WaitRunStatus(t, h, h.adminToken, apprRun.ID, "needs_approval", 12*time.Second)
	if apprPaused.RemoteControlURL != "https://[REDACTED]@example.com/rc?token=[REDACTED]" {
		t.Fatalf("Finding 1 violated: remote_control_url not redacted on /approval: %q", apprPaused.RemoteControlURL)
	}
	if strings.Contains(apprPaused.Summary, apprMsgSecret) || strings.Contains(apprPaused.OutputPreview, apprMsgSecret) {
		t.Fatalf("Finding 1 violated: approval summary/preview leaked secret: summary=%q preview=%q", apprPaused.Summary, apprPaused.OutputPreview)
	}
	cliApprCode, cliApprOut, cliApprErr := h.runCLI("", "result", apprRun.ID, "--json")
	if cliApprCode != api.ExitNeedsApproval {
		t.Fatalf("ahub result on needs_approval expected exit %d, got %d\nstdout: %s\nstderr: %s", api.ExitNeedsApproval, cliApprCode, cliApprOut, cliApprErr)
	}
	for _, forbidden := range []string{"pass123", "rc_secret_999", apprMsgSecret} {
		if strings.Contains(cliApprOut, forbidden) {
			t.Fatalf("Finding 1 violated: ahub result on needs_approval leaked %q: %s", forbidden, cliApprOut)
		}
	}
	_, _ = h.doJSON(http.MethodPost, "/api/v1/runs/"+apprRun.ID+"/resolve", h.adminToken, map[string]interface{}{
		"summary": "Resolved " + apprMsgSecret,
	})
	apprResolved := s3WaitRunStatus(t, h, h.adminToken, apprRun.ID, "done", 8*time.Second)
	if strings.Contains(apprResolved.Summary, apprMsgSecret) || !strings.Contains(apprResolved.Summary, "[REDACTED]") {
		t.Fatalf("Finding 1 violated: /resolve summary not redacted: %q", apprResolved.Summary)
	}

	// P-09: Board handoff message preserves actor_profile & source_node and redacts secrets
	stMsgs, rawMsgs := h.doJSON(http.MethodGet, "/api/v1/board/topics/"+topS3.ID+"/messages?limit=20", h.adminToken, nil)
	if stMsgs != http.StatusOK {
		t.Fatalf("GET board topic messages failed (%d): %s", stMsgs, string(rawMsgs))
	}
	if strings.Contains(string(rawMsgs), resultSecret) || strings.Contains(string(rawMsgs), summarySecret) {
		t.Fatalf("P-09 violated: unredacted secret in board handoff messages: %s", string(rawMsgs))
	}
	var msgsEnv evalSlice3BoardMessagesResp
	if err := json.Unmarshal(rawMsgs, &msgsEnv); err != nil {
		t.Fatalf("decode board messages: %v (%s)", err, string(rawMsgs))
	}
	foundP09 := false
	for _, m := range msgsEnv.Messages {
		if m.Kind == "handoff" {
			if rid, _ := m.Data["run_id"].(string); rid == happyRun.ID {
				foundP09 = true
				if m.ActorProfile != "codex-reviewer" || m.SourceNode != "macmini" {
					t.Fatalf("P-09 handoff attribution mismatch: actor_profile=%q source_node=%q", m.ActorProfile, m.SourceNode)
				}
			}
		}
	}
	if !foundP09 {
		t.Fatalf("P-09 missing board handoff message for %s: %s", happyRun.ID, string(rawMsgs))
	}

	// Schemaless runs: with write_result_file -> stores result; without write_result_file -> done + null result
	freeWithFile := s3CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini",
		"workdir": macDir,
		"agent":   "agy",
		"prompt":  `{"directives":[{"op":"write_result_file","result":{"freeform":42}}]}`,
	})
	freeDone := s3WaitRunStatus(t, h, h.adminToken, freeWithFile.ID, "done", 12*time.Second)
	if !strings.Contains(string(freeDone.Result), `"freeform":42`) {
		t.Fatalf("schemaless run with write_result_file should store result, got %s", string(freeDone.Result))
	}

	freeNoFile := s3CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini",
		"workdir": macDir,
		"agent":   "agy",
		"prompt":  `{"directives":[{"op":"sleep","ms":15}]}`,
	})
	freeNoDone := s3WaitRunStatus(t, h, h.adminToken, freeNoFile.ID, "done", 12*time.Second)
	if !s3IsNullJSON(freeNoDone.Result) {
		t.Fatalf("schemaless run without write_result_file should have null result, got %s", string(freeNoDone.Result))
	}
	s3AssertNoResultTempDirs(t, resultTmp, "schemaless")

	// 3. RESULT_SCHEMA_MISMATCH matrix preserving output_md & output_bytes (MG-6)
	strictBoolSchema := map[string]interface{}{
		"type":                 "object",
		"required":             []string{"ok"},
		"additionalProperties": false,
		"properties":           map[string]interface{}{"ok": map[string]interface{}{"type": "boolean"}},
	}
	mismatchCases := []struct {
		name      string
		promptObj map[string]interface{}
		marker    string
	}{
		{
			name: "schema_mismatch",
			promptObj: map[string]interface{}{
				"response":   "PRESERVED_MD_MISMATCH",
				"directives": []map[string]interface{}{{"op": "write_result_file", "result": map[string]interface{}{"ok": "wrong"}}},
			},
			marker: "PRESERVED_MD_MISMATCH",
		},
		{
			name: "malformed_json",
			promptObj: map[string]interface{}{
				"response":   "PRESERVED_MD_MALFORMED",
				"directives": []map[string]interface{}{{"op": "write_result_file", "raw_content": "{broken"}},
			},
			marker: "PRESERVED_MD_MALFORMED",
		},
		{
			name: "oversize_gt_64kb",
			promptObj: map[string]interface{}{
				"response":   "PRESERVED_MD_OVERSIZE",
				"directives": []map[string]interface{}{{"op": "write_result_file", "oversize_bytes": 65537}},
			},
			marker: "PRESERVED_MD_OVERSIZE",
		},
		{
			name: "missing_result_file",
			promptObj: map[string]interface{}{
				"response":   "PRESERVED_MD_MISSING",
				"directives": []map[string]interface{}{{"op": "sleep", "ms": 15}},
			},
			marker: "PRESERVED_MD_MISSING",
		},
	}

	for _, mc := range mismatchCases {
		pBytes, _ := json.Marshal(mc.promptObj)
		mr := s3CreateRun(t, h, h.adminToken, map[string]interface{}{
			"node_id":       "macmini",
			"workdir":       macDir,
			"agent":         "agy",
			"result_schema": strictBoolSchema,
			"prompt":        string(pBytes),
		})
		mFailed := s3WaitRunStatus(t, h, h.adminToken, mr.ID, "failed", 12*time.Second)
		if mFailed.ErrorCode != "RESULT_SCHEMA_MISMATCH" {
			t.Fatalf("%s: expected error_code=RESULT_SCHEMA_MISMATCH, got %q (%s)", mc.name, mFailed.ErrorCode, mFailed.ErrorMessage)
		}
		if !s3IsNullJSON(mFailed.Result) {
			t.Fatalf("%s: expected null result on RESULT_SCHEMA_MISMATCH, got %s", mc.name, string(mFailed.Result))
		}
		mFull := s3GetRun(t, h, h.adminToken, mr.ID, true)
		if !strings.Contains(mFull.OutputMD, mc.marker) || mFull.OutputBytes <= 0 {
			t.Fatalf("MG-6 violated (%s): output_md or output_bytes dropped! bytes=%d md=%q", mc.name, mFull.OutputBytes, mFull.OutputMD)
		}

		// ahub result <id> --data --json -> exit 10
		dCode, dOut, dErr := h.runCLI("", "result", mr.ID, "--data", "--json")
		if dCode != api.ExitRunFailed {
			t.Fatalf("%s: expected ahub result --data --json exit 10, got %d\nstdout=%s\nstderr=%s", mc.name, dCode, dOut, dErr)
		}
		var dEnv evalSlice3ResultDataResp
		if err := json.Unmarshal([]byte(dOut), &dEnv); err != nil || dEnv.ErrorCode != "RESULT_SCHEMA_MISMATCH" || !s3IsNullJSON(dEnv.Result) {
			t.Fatalf("%s: unexpected ahub result --data --json output: err=%v out=%s", mc.name, err, dOut)
		}

		// ahub result <id> --full --json -> exit 10 + preserved output_md
		fCode, fOut, fErr := h.runCLI("", "result", mr.ID, "--full", "--json")
		if fCode != api.ExitRunFailed {
			t.Fatalf("%s: expected ahub result --full --json exit 10, got %d\nstdout=%s\nstderr=%s", mc.name, fCode, fOut, fErr)
		}
		var fRec evalSlice3Run
		if err := json.Unmarshal([]byte(fOut), &fRec); err != nil || !strings.Contains(fRec.OutputMD, mc.marker) {
			t.Fatalf("%s: ahub result --full --json missing preserved output_md: err=%v out=%s", mc.name, err, fOut)
		}
		s3AssertNoResultTempDirs(t, resultTmp, mc.name)
	}

	// 4. Non-done preservation: exit:1 with result_schema stays AGENT_EXIT_NONZERO (not RESULT_SCHEMA_MISMATCH)
	nonZeroPrompt, _ := json.Marshal(map[string]interface{}{
		"directives": []map[string]interface{}{
			{"op": "write_result_file", "result": map[string]interface{}{"ok": true}},
			{"op": "exit", "code": 1, "message": "nonzero exit preserves error_code"},
		},
	})
	nzRun := s3CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":       "macmini",
		"workdir":       macDir,
		"agent":         "agy",
		"result_schema": strictBoolSchema,
		"prompt":        string(nonZeroPrompt),
	})
	nzFailed := s3WaitRunStatus(t, h, h.adminToken, nzRun.ID, "failed", 12*time.Second)
	if nzFailed.ErrorCode == "RESULT_SCHEMA_MISMATCH" || !s3IsNullJSON(nzFailed.Result) {
		t.Fatalf("non-done exit:1 must NOT become RESULT_SCHEMA_MISMATCH or persist result: err=%q res=%s", nzFailed.ErrorCode, string(nzFailed.Result))
	}
	s3AssertNoResultTempDirs(t, resultTmp, "exit-nonzero")

	// 5. P-05: retry + RESULT_SCHEMA_MISMATCH -> A fails preserving output_md (B waiting UPSTREAM_FAILED),
	// retry A creates A2 copying labels & result_schema, writes alt_result -> A2 done & B done
	markerFile := filepath.Join(h.tmpDir, "p05-retry.marker")
	p05Prompt, _ := json.Marshal(map[string]interface{}{
		"response": "P05_OUTPUT_PRESERVED",
		"directives": []map[string]interface{}{
			{
				"op":          "write_result_file",
				"marker_file": markerFile,
				"result":      map[string]interface{}{"ok": "bad"},
				"alt_result":  map[string]interface{}{"ok": true},
			},
		},
	})
	p05A := s3CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":       "macmini",
		"workdir":       macDir,
		"agent":         "agy",
		"labels":        map[string]string{"flow": "p05"},
		"result_schema": strictBoolSchema,
		"prompt":        string(p05Prompt),
	})
	p05B := s3CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":    "macmini",
		"workdir":    macDir,
		"agent":      "agy",
		"depends_on": []string{p05A.ID},
		"prompt":     `{"directives":[{"op":"sleep","ms":15}]}`,
	}, http.StatusAccepted)

	p05AFailed := s3WaitRunStatus(t, h, h.adminToken, p05A.ID, "failed", 12*time.Second)
	if p05AFailed.ErrorCode != "RESULT_SCHEMA_MISMATCH" {
		t.Fatalf("P-05 expected A RESULT_SCHEMA_MISMATCH, got %+v", p05AFailed)
	}
	p05AFull := s3GetRun(t, h, h.adminToken, p05A.ID, true)
	if !strings.Contains(p05AFull.OutputMD, "P05_OUTPUT_PRESERVED") {
		t.Fatalf("P-05 expected A output_md preserved, got %q", p05AFull.OutputMD)
	}
	p05BWait := s3GetRun(t, h, h.adminToken, p05B.ID, false)
	if p05BWait.Status != "waiting" || p05BWait.BlockedReason == nil || *p05BWait.BlockedReason != "UPSTREAM_FAILED" {
		t.Fatalf("P-05 expected B waiting/UPSTREAM_FAILED, got status=%s blocked=%v", p05BWait.Status, p05BWait.BlockedReason)
	}

	stP05Ret, rawP05Ret := h.doJSON(http.MethodPost, "/api/v1/runs/"+p05A.ID+"/retry", h.adminToken, map[string]interface{}{})
	if stP05Ret != http.StatusCreated {
		t.Fatalf("P-05 retry A failed (%d): %s", stP05Ret, string(rawP05Ret))
	}
	var p05RetResp evalSlice3RetryResp
	if err := json.Unmarshal(rawP05Ret, &p05RetResp); err != nil || !p05RetResp.OK {
		t.Fatalf("P-05 decode retry resp: %v (%s)", err, string(rawP05Ret))
	}
	if p05RetResp.Run.RetryOfRunID == nil || *p05RetResp.Run.RetryOfRunID != p05A.ID ||
		p05RetResp.Run.Labels["flow"] != "p05" || p05RetResp.Run.ResultSchema == nil || !s3IsNullJSON(p05RetResp.Run.Result) {
		t.Fatalf("P-05 retry did not copy labels/result_schema or reset result: %+v", p05RetResp.Run)
	}
	reboundB := false
	for _, rid := range p05RetResp.ReboundRunIDs {
		if rid == p05B.ID {
			reboundB = true
		}
	}
	if !reboundB {
		t.Fatalf("P-05 expected rebound_run_ids to include B (%s), got %v", p05B.ID, p05RetResp.ReboundRunIDs)
	}

	p05A2Done := s3WaitRunStatus(t, h, h.adminToken, p05RetResp.Run.ID, "done", 12*time.Second)
	if !strings.Contains(string(p05A2Done.Result), `"ok":true`) {
		t.Fatalf("P-05 expected A2 result ok=true, got %s", string(p05A2Done.Result))
	}
	_ = s3WaitRunStatus(t, h, h.adminToken, p05B.ID, "done", 12*time.Second)
	s3AssertNoResultTempDirs(t, resultTmp, "P-05")

	// 6. P-06: AHUB_RESULT_FILE + spawn_grandchild + hub.abort -> -pgid killed <=6s,
	// result.json observed in-flight then cleaned up, status=cancelled (not RESULT_SCHEMA_MISMATCH)
	pidFile := filepath.Join(h.tmpDir, "p06-grandchild.pid")
	p06Prompt, _ := json.Marshal(map[string]interface{}{
		"directives": []map[string]interface{}{
			{"op": "write_result_file", "result": map[string]interface{}{"partial": true}},
			{"op": "spawn_grandchild", "cmd": []string{"sleep", "60"}, "pid_file": pidFile},
			{"op": "sleep", "ms": 20000},
		},
	})
	p06Run := s3CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":       "macmini",
		"workdir":       macDir,
		"agent":         "agy",
		"result_schema": strictBoolSchema,
		"prompt":        string(p06Prompt),
	})

	var gcPid int
	pidDeadline := time.Now().Add(8 * time.Second)
	for {
		rawPID, pErr := os.ReadFile(pidFile)
		if pErr == nil {
			gcPid, _ = strconv.Atoi(strings.TrimSpace(string(rawPID)))
			if gcPid > 0 {
				break
			}
		}
		if time.Now().After(pidDeadline) {
			t.Fatalf("P-06 grandchild pid file did not appear for %s", p06Run.ID)
		}
		time.Sleep(40 * time.Millisecond)
	}
	inFlightFiles, gErr := filepath.Glob(filepath.Join(resultTmp, "ahub-result-*", "result.json"))
	if gErr != nil || len(inFlightFiles) != 1 {
		t.Fatalf("P-06 expected 1 in-flight AHUB_RESULT_FILE under %s, got %v (err=%v)", resultTmp, inFlightFiles, gErr)
	}

	stCanP06, rawCanP06 := h.doJSON(http.MethodPost, "/api/v1/runs/"+p06Run.ID+"/cancel", h.adminToken, map[string]interface{}{"cascade": false})
	if stCanP06 != http.StatusOK {
		t.Fatalf("P-06 cancel failed (%d): %s", stCanP06, string(rawCanP06))
	}
	p06Cancelled := s3WaitRunStatus(t, h, h.adminToken, p06Run.ID, "cancelled", 8*time.Second)
	if p06Cancelled.ErrorCode == "RESULT_SCHEMA_MISMATCH" || !s3IsNullJSON(p06Cancelled.Result) {
		t.Fatalf("P-06 cancelled run must not settle as RESULT_SCHEMA_MISMATCH or store result: err=%q res=%s", p06Cancelled.ErrorCode, string(p06Cancelled.Result))
	}

	deadDeadline := time.Now().Add(6 * time.Second)
	for {
		kErr := syscall.Kill(gcPid, 0)
		if errors.Is(kErr, syscall.ESRCH) {
			break
		}
		if time.Now().After(deadDeadline) {
			_ = syscall.Kill(gcPid, syscall.SIGKILL)
			t.Fatalf("P-06 violated: grandchild PID %d still alive 6s after hub.abort", gcPid)
		}
		time.Sleep(50 * time.Millisecond)
	}
	s3WaitNoResultTempDirs(t, resultTmp, "P-06-abort", 2*time.Second)

	// 7. CLI --result-schema flag tests (@file, double '-' stdin collision -> exit 64, non-object -> exit 64, >16KB -> exit 64)
	schemaFile := filepath.Join(h.tmpDir, "cli-schema.json")
	if err := os.WriteFile(schemaFile, []byte(`{"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cliOKCode, cliOKOut, cliOKErr := h.runCLI(
		`{"directives":[{"op":"write_result_file","result":{"ok":true}}]}`,
		"run", "-n", "macmini", "-d", macDir, "-a", "agy",
		"--result-schema", "@"+schemaFile, "--wait", "15s", "--json", "-",
	)
	if cliOKCode != api.ExitOK {
		t.Fatalf("ahub run --result-schema @file failed (exit %d)\nstdout: %s\nstderr: %s", cliOKCode, cliOKOut, cliOKErr)
	}
	var cliOKRun evalSlice3Run
	if err := json.Unmarshal([]byte(cliOKOut), &cliOKRun); err != nil || cliOKRun.Status != "done" || !strings.Contains(string(cliOKRun.Result), `"ok":true`) {
		t.Fatalf("unexpected ahub run --result-schema @file output: err=%v out=%s", err, cliOKOut)
	}

	// Double '-' stdin collision -> exit 64
	dblDashCode, _, _ := h.runCLI(`{}`, "run", "-n", "macmini", "-d", macDir, "-a", "agy", "--result-schema", "-", "--json", "-")
	if dblDashCode != api.ExitBadUsageOrInput {
		t.Fatalf("expected exit 64 for double '-' stdin collision, got %d", dblDashCode)
	}

	// Non-object --result-schema -> exit 64
	badSchemaArgCode, _, _ := h.runCLI("", "run", "-n", "macmini", "-d", macDir, "-a", "agy", "--result-schema", "[]", "--json", "bad")
	if badSchemaArgCode != api.ExitBadUsageOrInput {
		t.Fatalf("expected exit 64 for non-object --result-schema, got %d", badSchemaArgCode)
	}

	// Oversize >16KB --result-schema @file -> exit 64
	overSchemaFile := filepath.Join(h.tmpDir, "cli-schema-over.json")
	rawOverBytes, _ := json.Marshal(schema16KOver)
	if err := os.WriteFile(overSchemaFile, rawOverBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	overSchemaCode, _, _ := h.runCLI("", "run", "-n", "macmini", "-d", macDir, "-a", "agy", "--result-schema", "@"+overSchemaFile, "--json", "bad")
	if overSchemaCode != api.ExitBadUsageOrInput {
		t.Fatalf("expected exit 64 for >16KB --result-schema, got %d", overSchemaCode)
	}
}
