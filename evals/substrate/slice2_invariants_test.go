package substrate

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/gray0128/agent-hub/internal/api"
)

type evalSlice2Run struct {
	ID              string   `json:"id"`
	ThreadID        string   `json:"thread_id"`
	RootRunID       string   `json:"root_run_id"`
	ParentRunID     *string  `json:"parent_run_id"`
	Depth           int      `json:"depth"`
	MaxDepth        int      `json:"max_depth"`
	NodeID          string   `json:"node_id"`
	Workdir         string   `json:"workdir"`
	Agent           string   `json:"agent"`
	Model           string   `json:"model"`
	Effort          string   `json:"effort"`
	Prompt          string   `json:"prompt"`
	Status          string   `json:"status"`
	PlanID          *string  `json:"plan_id"`
	PlanKey         *string  `json:"plan_key"`
	ScheduledAt     *string  `json:"scheduled_at"`
	RetryOfRunID    *string  `json:"retry_of_run_id"`
	ActorProfile    string   `json:"actor_profile"`
	BoardTopicID    *string  `json:"board_topic_id"`
	DependsOnRunIDs []string `json:"depends_on_run_ids"`
	BlockedReason   *string  `json:"blocked_reason"`
	PriorityOrder   float64  `json:"priority_order"`
	OutputPreview   string   `json:"output_preview"`
	OutputMD        string   `json:"output_md"`
	ErrorCode       string   `json:"error_code"`
	ErrorMessage    string   `json:"error_message"`
	NotifyStatus    string   `json:"notify_status"`
	LeaseExpiresAt  *string  `json:"lease_expires_at"`
	StartedAt       *string  `json:"started_at"`
	FinishedAt      *string  `json:"finished_at"`
	DurationMS      int64    `json:"duration_ms"`
	CreatedAt       string   `json:"created_at"`
	UpdatedAt       string   `json:"updated_at"`
}

type evalSlice2PlanResp struct {
	OK           bool            `json:"ok"`
	PlanID       string          `json:"plan_id"`
	Deduplicated bool            `json:"deduplicated"`
	Runs         []evalSlice2Run `json:"runs"`
}

type evalSlice2RunResp struct {
	OK           bool          `json:"ok"`
	Run          evalSlice2Run `json:"run"`
	Deduplicated bool          `json:"deduplicated"`
}

type evalSlice2RunsListResp struct {
	OK   bool            `json:"ok"`
	Runs []evalSlice2Run `json:"runs"`
}

type evalSlice2RetryResp struct {
	OK            bool          `json:"ok"`
	Run           evalSlice2Run `json:"run"`
	ReboundRunIDs []string      `json:"rebound_run_ids"`
	Deduplicated  bool          `json:"deduplicated"`
}

type evalSlice2ErrorResp struct {
	OK    bool `json:"ok"`
	Error struct {
		Code    string                 `json:"code"`
		Message string                 `json:"message"`
		Details map[string]interface{} `json:"details"`
		Next    []string               `json:"next"`
	} `json:"error"`
}

func s2DoJSONWithHeaders(t *testing.T, h *testHarness, method, reqPath, tok string, headers map[string]string, payload interface{}) (int, []byte) {
	t.Helper()
	var bodyReader *bytes.Reader
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("marshal %s %s: %v", method, reqPath, err)
		}
		bodyReader = bytes.NewReader(raw)
	} else {
		bodyReader = bytes.NewReader(nil)
	}
	var req *http.Request
	var err error
	if payload != nil {
		req, err = http.NewRequest(method, h.hubURL+reqPath, bodyReader)
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

func s2AssertError(t *testing.T, gotStatus int, raw []byte, wantStatus int, wantCode string) evalSlice2ErrorResp {
	t.Helper()
	if gotStatus != wantStatus {
		t.Fatalf("expected HTTP %d (%s), got %d: %s", wantStatus, wantCode, gotStatus, string(raw))
	}
	var env evalSlice2ErrorResp
	if err := json.Unmarshal(raw, &env); err != nil || env.OK || env.Error.Code != wantCode {
		t.Fatalf("expected error.code=%s, got decodeErr=%v body=%s", wantCode, err, string(raw))
	}
	return env
}

func s2AssertNextHints(t *testing.T, label string, hints []string, requireNonEmpty bool) {
	t.Helper()
	if requireNonEmpty && len(hints) == 0 {
		t.Fatalf("%s expected >= 1 error.next hint, got empty", label)
	}
	if len(hints) > 8 {
		t.Fatalf("%s error.next exceeded maxItems 8: got %d (%v)", label, len(hints), hints)
	}
	for i, h := range hints {
		if len(h) < 1 || len(h) > 512 {
			t.Fatalf("%s error.next[%d] length %d out of 1..512: %q", label, i, len(h), h)
		}
		if strings.ContainsAny(h, "\r\n") {
			t.Fatalf("%s error.next[%d] contains control newline: %q", label, i, h)
		}
	}
}

func s2CreateRun(t *testing.T, h *testHarness, tok string, payload map[string]interface{}, wantStatus ...int) evalSlice2Run {
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
	var env evalSlice2RunResp
	if err := json.Unmarshal(raw, &env); err != nil || !env.OK {
		t.Fatalf("decode createRun resp: %v (%s)", err, string(raw))
	}
	return env.Run
}

func s2GetRun(t *testing.T, h *testHarness, tok, runID string, full bool) evalSlice2Run {
	t.Helper()
	view := "summary"
	if full {
		view = "full"
	}
	st, raw := h.doJSON(http.MethodGet, "/api/v1/runs/"+runID+"?view="+view, tok, nil)
	if st != http.StatusOK {
		t.Fatalf("GET /api/v1/runs/%s failed (%d): %s", runID, st, string(raw))
	}
	var env evalSlice2RunResp
	if err := json.Unmarshal(raw, &env); err != nil || !env.OK {
		t.Fatalf("decode getRun %s: %v (%s)", runID, err, string(raw))
	}
	return env.Run
}

func s2WaitRunStatus(t *testing.T, h *testHarness, tok, runID, wantStatus string, timeout time.Duration) evalSlice2Run {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var last evalSlice2Run
	for {
		last = s2GetRun(t, h, tok, runID, false)
		if last.Status == wantStatus {
			return last
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for run %s status=%s (last=%s blocked=%v err=%s)",
				runID, wantStatus, last.Status, last.BlockedReason, last.ErrorCode)
		}
		time.Sleep(60 * time.Millisecond)
	}
}

func s2CreateTopic(t *testing.T, h *testHarness, tok, channel, title string) evalBoardTopic {
	t.Helper()
	st, raw := h.doJSON(http.MethodPost, "/api/v1/board/topics", tok, map[string]interface{}{
		"channel": channel,
		"title":   title,
		"status":  "todo",
	})
	if st != http.StatusCreated && st != http.StatusOK {
		t.Fatalf("create board topic (%s/%s) failed (%d): %s", channel, title, st, string(raw))
	}
	var env evalBoardTopicResp
	if err := json.Unmarshal(raw, &env); err != nil || !env.OK {
		t.Fatalf("decode createTopic: %v (%s)", err, string(raw))
	}
	return env.Topic
}

func s2DialFakeNodeWS(t *testing.T, ctx context.Context, h *testHarness, nodeTok, nonce string, workspaces []map[string]string) (*websocket.Conn, map[string]interface{}) {
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
	return conn, welcome
}

// I-12 (F2 + P-01): waiting zero resource isolation, claim skip, node.hello has_pending_runs,
// diamond DAG CAS wake, /resolve wake, blocked_reason precedence, and PATCH policy on waiting.
func TestInvariant_Slice2_WaitingAndDAGLifecycle(t *testing.T) {
	h := newTestHarness(t)

	macRoot := filepath.Join(h.tmpDir, "workspaces", "s2-mac-root")
	dir1 := h.makeWorkspaceDir(filepath.Join("s2-mac-root", "proj-dir1"))
	dir2 := h.makeWorkspaceDir(filepath.Join("s2-mac-root", "proj-dir2"))

	macTok := h.createKey("s2-macmini", "node", "macmini", []string{"macmini"}, 0)
	probeTok := h.createKey("s2-wait-probe", "node", "wait-probe", []string{"wait-probe"}, 0)
	h.startDaemon("macmini", macTok, "", macRoot, 2)

	probeDir := filepath.Join(h.tmpDir, "workspaces", "s2-probe-root", "proj-p")
	probeWS := []map[string]string{{"key": "proj-p", "path": probeDir}}

	// 1. Register wait-probe via /ws/node with 0 pending runs
	wsCtx, wsCancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer wsCancel()
	probeConn, welcome0 := s2DialFakeNodeWS(t, wsCtx, h, probeTok, "nonce_wait_probe_01", probeWS)
	if welcome0["has_pending_runs"] != false {
		t.Fatalf("expected initial has_pending_runs=false, got %+v", welcome0)
	}

	// Create scheduled waiting run on wait-probe -> must return 202 immediately, zero hub.wake
	futureAt := time.Now().UTC().Add(300 * time.Second).Format(time.RFC3339Nano)
	wProbe := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":      "wait-probe",
		"workdir":      probeDir,
		"agent":        "agy",
		"scheduled_at": futureAt,
		"prompt":       "scheduled probe run",
	}, http.StatusAccepted)
	if wProbe.Status != "waiting" || wProbe.BlockedReason == nil || *wProbe.BlockedReason != "SCHEDULED" {
		t.Fatalf("expected waiting/SCHEDULED run, got status=%s blocked=%v", wProbe.Status, wProbe.BlockedReason)
	}
	if wProbe.LeaseExpiresAt != nil {
		t.Fatalf("waiting run must have nil lease_expires_at, got %v", *wProbe.LeaseExpiresAt)
	}

	// PATCH on waiting run succeeds (200) and sends ZERO hub.wake frames
	stPatchWait, rawPatchWait := h.doJSON(http.MethodPatch, "/api/v1/runs/"+wProbe.ID, h.adminToken, map[string]interface{}{
		"priority_order": 42,
		"model":          "gemini-4-carbon-high",
	})
	if stPatchWait != http.StatusOK {
		t.Fatalf("PATCH waiting run failed (%d): %s", stPatchWait, string(rawPatchWait))
	}
	var patchedWaitEnv evalSlice2RunResp
	_ = json.Unmarshal(rawPatchWait, &patchedWaitEnv)
	if patchedWaitEnv.Run.Status != "waiting" || patchedWaitEnv.Run.PriorityOrder != 42 {
		t.Fatalf("expected patched run to remain waiting with priority_order=42, got %+v", patchedWaitEnv.Run)
	}

	// Ensure zero hub.wake reached wait-probe
	wakeCheckCtx, wakeCheckCancel := context.WithTimeout(wsCtx, 350*time.Millisecond)
	_, strayRaw, strayErr := probeConn.Read(wakeCheckCtx)
	wakeCheckCancel()
	if strayErr == nil {
		t.Fatalf("expected 0 hub.wake frames on /ws/node for waiting create/patch, got: %s", string(strayRaw))
	}
	_ = probeConn.Close(websocket.StatusNormalClosure, "reconnect check")

	// Reconnect wait-probe: hub.welcome.has_pending_runs MUST STILL BE false when only waiting runs exist
	probeConn2, welcomeWaitingOnly := s2DialFakeNodeWS(t, wsCtx, h, probeTok, "nonce_wait_probe_02", probeWS)
	if welcomeWaitingOnly["has_pending_runs"] != false {
		t.Fatalf("expected has_pending_runs=false when only waiting runs exist, got %+v", welcomeWaitingOnly)
	}

	// POST /claim on wait-probe MUST skip waiting runs
	stClaim, rawClaim := h.doJSON(http.MethodPost, "/api/v1/nodes/wait-probe/claim", probeTok, map[string]interface{}{
		"conn_nonce": "nonce_wait_probe_02",
	})
	if stClaim != http.StatusOK {
		t.Fatalf("claim on wait-probe failed (%d): %s", stClaim, string(rawClaim))
	}
	var claimResp struct {
		OK          bool            `json:"ok"`
		ClaimedRuns []evalSlice2Run `json:"claimed_runs"`
	}
	if err := json.Unmarshal(rawClaim, &claimResp); err != nil {
		t.Fatalf("decode claimResp: %v (%s)", err, string(rawClaim))
	}
	if len(claimResp.ClaimedRuns) != 0 {
		t.Fatalf("I-12 violated: claim picked up waiting run: %+v", claimResp.ClaimedRuns)
	}

	// reap-leases must NEVER reap waiting runs
	stReap, rawReap := h.doJSON(http.MethodPost, "/api/v1/admin/reap-leases", h.adminToken, nil)
	if stReap != http.StatusOK {
		t.Fatalf("reap-leases failed (%d): %s", stReap, string(rawReap))
	}
	if got := s2GetRun(t, h, h.adminToken, wProbe.ID, false); got.Status != "waiting" {
		t.Fatalf("reapExpiredLeases mutated waiting run to %s", got.Status)
	}

	// Verify D1 resource invariants for waiting runs
	if cnt := h.queryD1Count("SELECT COUNT(*) FROM runs WHERE status = 'waiting' AND (lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL);"); cnt != 0 {
		t.Fatalf("I-12 violated: %d waiting runs hold lease_owner/lease_expires_at", cnt)
	}
	if activeCnt := h.queryD1Count("SELECT active_runs_count FROM nodes WHERE id = 'wait-probe';"); activeCnt != 0 {
		t.Fatalf("I-12 violated: wait-probe active_runs_count=%d with only waiting run", activeCnt)
	}

	// Adding a real queued run on wait-probe flips has_pending_runs=true on reconnect & sends hub.wake
	qProbe := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "wait-probe",
		"workdir": probeDir,
		"agent":   "agy",
		"prompt":  "queued probe run",
	})
	if qProbe.Status != "queued" {
		t.Fatalf("expected queued status, got %s", qProbe.Status)
	}
	_ = probeConn2.Close(websocket.StatusNormalClosure, "recheck pending")
	probeConn3, welcomeWithQueued := s2DialFakeNodeWS(t, wsCtx, h, probeTok, "nonce_wait_probe_03", probeWS)
	if welcomeWithQueued["has_pending_runs"] != true {
		t.Fatalf("expected has_pending_runs=true with queued run, got %+v", welcomeWithQueued)
	}
	_ = probeConn3.Close(websocket.StatusNormalClosure, "done probe")

	// 2. P-01: 10 waiting runs on dir1 do NOT block queued run on dir1; A -> B, C on dir1 serialize while D on dir2 runs concurrently
	blocker := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini",
		"workdir": dir2,
		"agent":   "agy",
		"prompt":  `{"directives":[{"op":"sleep","ms":1600}]}`,
	})
	for i := 0; i < 10; i++ {
		w := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
			"node_id":    "macmini",
			"workdir":    dir1,
			"agent":      "agy",
			"depends_on": []string{blocker.ID},
			"prompt":     fmt.Sprintf(`{"directives":[{"op":"sleep","ms":10}],"tag":"w-%d"}`, i),
		}, http.StatusAccepted)
		if w.Status != "waiting" {
			t.Fatalf("expected waiting run %d, got %s", i, w.Status)
		}
	}
	// Queued run on dir1 MUST NOT be blocked by the 10 waiting runs on dir1
	fastOnDir1 := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini",
		"workdir": dir1,
		"agent":   "agy",
		"prompt":  `{"directives":[{"op":"sleep","ms":30}]}`,
	})
	fastDone := s2WaitRunStatus(t, h, h.adminToken, fastOnDir1.ID, "done", 8*time.Second)
	if fastDone.Status != "done" {
		t.Fatalf("expected queued run on dir1 to finish despite 10 waiting runs, got %+v", fastDone)
	}
	_ = s2WaitRunStatus(t, h, h.adminToken, blocker.ID, "done", 10*time.Second)
	// Drain the 10 woken runs before P-01 span check
	drainDeadline := time.Now().Add(15 * time.Second)
	for {
		rem := h.queryD1Count(fmt.Sprintf("SELECT COUNT(*) FROM runs WHERE node_id = 'macmini' AND workdir = '%s' AND status IN ('waiting','queued','claimed','running');", dir1))
		if rem == 0 {
			break
		}
		if time.Now().After(drainDeadline) {
			t.Fatalf("timed out draining %d runs on %s", rem, dir1)
		}
		time.Sleep(80 * time.Millisecond)
	}

	// P-01: A -> B, A -> C on dir1 + D on dir2
	pA := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini",
		"workdir": dir1,
		"agent":   "agy",
		"prompt":  `{"directives":[{"op":"sleep","ms":150}]}`,
	})
	pB := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":    "macmini",
		"workdir":    dir1,
		"agent":      "agy",
		"depends_on": []string{pA.ID},
		"prompt":     `{"directives":[{"op":"sleep","ms":200}]}`,
	}, http.StatusAccepted)
	pC := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":    "macmini",
		"workdir":    dir1,
		"agent":      "agy",
		"depends_on": []string{pA.ID},
		"prompt":     `{"directives":[{"op":"sleep","ms":200}]}`,
	}, http.StatusAccepted)
	pD := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini",
		"workdir": dir2,
		"agent":   "agy",
		"prompt":  `{"directives":[{"op":"sleep","ms":220}]}`,
	})

	pBDone := s2WaitRunStatus(t, h, h.adminToken, pB.ID, "done", 12*time.Second)
	pCDone := s2WaitRunStatus(t, h, h.adminToken, pC.ID, "done", 12*time.Second)
	_ = s2WaitRunStatus(t, h, h.adminToken, pD.ID, "done", 12*time.Second)

	if pBDone.StartedAt != nil && pBDone.FinishedAt != nil && pCDone.StartedAt != nil && pCDone.FinishedAt != nil {
		bStart, _ := time.Parse(time.RFC3339Nano, *pBDone.StartedAt)
		bEnd, _ := time.Parse(time.RFC3339Nano, *pBDone.FinishedAt)
		cStart, _ := time.Parse(time.RFC3339Nano, *pCDone.StartedAt)
		cEnd, _ := time.Parse(time.RFC3339Nano, *pCDone.FinishedAt)
		if bStart.Before(cEnd) && cStart.Before(bEnd) {
			t.Fatalf("P-01 workdir mutex violated for B and C on dir1: [%s..%s] vs [%s..%s]", bStart, bEnd, cStart, cEnd)
		}
	}

	// 3. Diamond DAG A -> B, C -> D CAS Gate (D must NOT wake when only B is done and C is still running)
	dA := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini",
		"workdir": dir1,
		"agent":   "agy",
		"prompt":  `{"directives":[{"op":"sleep","ms":40}]}`,
	})
	dB := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":    "macmini",
		"workdir":    dir1,
		"agent":      "agy",
		"depends_on": []string{dA.ID},
		"prompt":     `{"directives":[{"op":"sleep","ms":60}]}`,
	}, http.StatusAccepted)
	dC := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":    "macmini",
		"workdir":    dir2,
		"agent":      "agy",
		"depends_on": []string{dA.ID},
		"prompt":     `{"directives":[{"op":"sleep","ms":900}]}`,
	}, http.StatusAccepted)
	dD := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":    "macmini",
		"workdir":    dir1,
		"agent":      "agy",
		"depends_on": []string{dB.ID, dC.ID},
		"prompt":     `{"directives":[{"op":"sleep","ms":30}]}`,
	}, http.StatusAccepted)

	_ = s2WaitRunStatus(t, h, h.adminToken, dB.ID, "done", 10*time.Second)
	curC := s2GetRun(t, h, h.adminToken, dC.ID, false)
	if curC.Status != "done" {
		midD := s2GetRun(t, h, h.adminToken, dD.ID, false)
		if midD.Status != "waiting" || midD.BlockedReason == nil || *midD.BlockedReason != "DEPENDENCY_PENDING" {
			t.Fatalf("MG-3 diamond gate violated! D woke before C finished: dC=%s dD=%+v", curC.Status, midD)
		}
	}
	_ = s2WaitRunStatus(t, h, h.adminToken, dC.ID, "done", 12*time.Second)
	_ = s2WaitRunStatus(t, h, h.adminToken, dD.ID, "done", 12*time.Second)

	// Already-done depends_on creates run directly in queued -> done
	postDone := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":    "macmini",
		"workdir":    dir1,
		"agent":      "agy",
		"depends_on": []string{dD.ID},
		"prompt":     `{"directives":[{"op":"sleep","ms":20}]}`,
	})
	if postDone.Status == "waiting" {
		t.Fatalf("expected run with already-done dependency to start queued, got waiting")
	}
	doneRef := s2WaitRunStatus(t, h, h.adminToken, postDone.ID, "done", 10*time.Second)

	// Upstream /resolve (needs_approval -> done) wakes downstream waiting run
	appRun := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini",
		"workdir": dir1,
		"agent":   "agy",
		"prompt":  `{"session_id":"sess_s2_resolve","directives":[{"op":"exit_approval","url":"https://ahub.bobocai.win/rc/s2resolve","message":"Approve to wake downstream"}]}`,
	})
	appWait := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":    "macmini",
		"workdir":    dir2,
		"agent":      "agy",
		"depends_on": []string{appRun.ID},
		"prompt":     `{"directives":[{"op":"sleep","ms":20}]}`,
	}, http.StatusAccepted)
	_ = s2WaitRunStatus(t, h, h.adminToken, appRun.ID, "needs_approval", 10*time.Second)
	stRes, rawRes := h.doJSON(http.MethodPost, "/api/v1/runs/"+appRun.ID+"/resolve", h.adminToken, map[string]string{
		"summary": "approved for downstream wake",
	})
	if stRes != http.StatusOK {
		t.Fatalf("resolve failed (%d): %s", stRes, string(rawRes))
	}
	_ = s2WaitRunStatus(t, h, h.adminToken, appWait.ID, "done", 10*time.Second)

	// 4. blocked_reason precedence: UPSTREAM_FAILED > UPSTREAM_CANCELLED > DEPENDENCY_PENDING > SCHEDULED
	failedUp := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini",
		"workdir": dir1,
		"agent":   "agy",
		"prompt":  `{"directives":[{"op":"exit","code":1,"message":"intentional fail"}]}`,
	})
	_ = s2WaitRunStatus(t, h, h.adminToken, failedUp.ID, "failed", 10*time.Second)

	cancelUp := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":      "macmini",
		"workdir":      dir1,
		"agent":        "agy",
		"scheduled_at": futureAt,
		"prompt":       "to be cancelled",
	}, http.StatusAccepted)
	stCan, rawCan := h.doJSON(http.MethodPost, "/api/v1/runs/"+cancelUp.ID+"/cancel", h.adminToken, map[string]interface{}{"cascade": false})
	if stCan != http.StatusOK {
		t.Fatalf("cancel waiting run failed (%d): %s", stCan, string(rawCan))
	}

	precFailed := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":      "macmini",
		"workdir":      dir1,
		"agent":        "agy",
		"depends_on":   []string{failedUp.ID, cancelUp.ID},
		"scheduled_at": futureAt,
		"prompt":       "precedence failed",
	}, http.StatusAccepted)
	if precFailed.BlockedReason == nil || *precFailed.BlockedReason != "UPSTREAM_FAILED" {
		t.Fatalf("expected blocked_reason=UPSTREAM_FAILED precedence over UPSTREAM_CANCELLED/SCHEDULED, got %v", precFailed.BlockedReason)
	}

	precCancelled := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":      "macmini",
		"workdir":      dir1,
		"agent":        "agy",
		"depends_on":   []string{cancelUp.ID, doneRef.ID},
		"scheduled_at": futureAt,
		"prompt":       "precedence cancelled",
	}, http.StatusAccepted)
	if precCancelled.BlockedReason == nil || *precCancelled.BlockedReason != "UPSTREAM_CANCELLED" {
		t.Fatalf("expected blocked_reason=UPSTREAM_CANCELLED precedence over SCHEDULED, got %v", precCancelled.BlockedReason)
	}

	// PATCH on terminal run -> 409 INVALID_STATE_TRANSITION
	stPatchTerm, rawPatchTerm := h.doJSON(http.MethodPatch, "/api/v1/runs/"+doneRef.ID, h.adminToken, map[string]interface{}{
		"priority_order": 99,
	})
	s2AssertError(t, stPatchTerm, rawPatchTerm, http.StatusConflict, "INVALID_STATE_TRANSITION")
}

// I-13 (F1 + F3 + P-08): POST /api/v1/plans, quotas (20/60/10), Kahn cycles, idempotency,
// max_depth=1 multi-step compatibility vs depth=2, client scope/board prefix, cancel cascade, and Slice 1a error.next.
func TestInvariant_Slice2_PlansValidationScopeAndCancel(t *testing.T) {
	h := newTestHarness(t)

	macRoot := filepath.Join(h.tmpDir, "workspaces", "s2p-mac-root")
	macAlpha := h.makeWorkspaceDir(filepath.Join("s2p-mac-root", "proj-alpha"))
	_ = h.makeWorkspaceDir(filepath.Join("s2p-mac-root", "cnb", "demo"))
	_ = h.makeWorkspaceDir(filepath.Join("s2p-mac-root", "github", "demo"))

	mbpRoot := filepath.Join(h.tmpDir, "workspaces", "s2p-mbp-root")
	mbpDir := h.makeWorkspaceDir(filepath.Join("s2p-mbp-root", "proj-mbp"))

	macTok := h.createKey("s2p-mac-node", "node", "macmini", []string{"macmini"}, 0)
	mbpTok := h.createKey("s2p-mbp-node", "node", "mbp", []string{"mbp"}, 0)
	cancelProbeTok := h.createKey("s2p-cancel-probe", "node", "cancel-probe", []string{"cancel-probe"}, 0)

	h.startDaemon("macmini", macTok, "", macRoot, 2)
	h.startDaemon("mbp", mbpTok, "", mbpRoot, 2)

	_, clientTok := h.mustCreateKeyWithPrefixes("s2p-client", "client", []string{"macmini"}, []string{"proj/demo"}, true)

	topDemo := s2CreateTopic(t, h, h.adminToken, "proj/demo", "Slice 2 Plan Demo Topic")
	topOps := s2CreateTopic(t, h, h.adminToken, "ops/prod", "Restricted Ops Topic")

	// 1. 2-node cross-node plan + idempotency + board_topic_id + actor_profile + filters
	planPayload := map[string]interface{}{
		"idempotency_key": "plan-idem-cross-001",
		"board_topic_id":  topDemo.ID,
		"actor_profile":   "codex-orchestrator",
		"nodes": []map[string]interface{}{
			{
				"key":     "step-a",
				"node_id": "macmini",
				"workdir": macAlpha,
				"agent":   "agy",
				"prompt":  `{"directives":[{"op":"sleep","ms":80}]}`,
			},
			{
				"key":        "step-b",
				"node_id":    "mbp",
				"workdir":    mbpDir,
				"agent":      "pi",
				"depends_on": []string{"step-a"},
				"prompt":     `{"directives":[{"op":"sleep","ms":30}]}`,
			},
		},
	}
	stPlan, rawPlan := h.doJSON(http.MethodPost, "/api/v1/plans", h.adminToken, planPayload)
	if stPlan != http.StatusCreated {
		t.Fatalf("POST /api/v1/plans expected 201, got %d: %s", stPlan, string(rawPlan))
	}
	var planResp evalSlice2PlanResp
	if err := json.Unmarshal(rawPlan, &planResp); err != nil || !planResp.OK || !strings.HasPrefix(planResp.PlanID, "pln_") || len(planResp.Runs) != 2 {
		t.Fatalf("unexpected plan response: err=%v body=%s", err, string(rawPlan))
	}
	byKey := map[string]evalSlice2Run{}
	for _, r := range planResp.Runs {
		if r.PlanKey != nil {
			byKey[*r.PlanKey] = r
		}
		if r.PlanID == nil || *r.PlanID != planResp.PlanID {
			t.Fatalf("run missing plan_id %s: %+v", planResp.PlanID, r)
		}
		if r.BoardTopicID == nil || *r.BoardTopicID != topDemo.ID || r.ActorProfile != "codex-orchestrator" {
			t.Fatalf("run missing board_topic_id/actor_profile propagation: %+v", r)
		}
	}
	if byKey["step-b"].Status != "waiting" || len(byKey["step-b"].DependsOnRunIDs) != 1 || byKey["step-b"].DependsOnRunIDs[0] != byKey["step-a"].ID {
		t.Fatalf("expected step-b waiting on step-a (%s), got %+v", byKey["step-a"].ID, byKey["step-b"])
	}

	// Idempotency hit -> 200 deduplicated: true
	stDedup, rawDedup := h.doJSON(http.MethodPost, "/api/v1/plans", h.adminToken, planPayload)
	if stDedup != http.StatusOK {
		t.Fatalf("idempotent plan replay expected 200, got %d: %s", stDedup, string(rawDedup))
	}
	var dedupResp evalSlice2PlanResp
	if err := json.Unmarshal(rawDedup, &dedupResp); err != nil || !dedupResp.Deduplicated || dedupResp.PlanID != planResp.PlanID {
		t.Fatalf("expected deduplicated=true & same plan_id=%s, got %s", planResp.PlanID, string(rawDedup))
	}

	// Idempotency payload mismatch -> 409 IDEMPOTENCY_CONFLICT
	conflictPayload := map[string]interface{}{
		"idempotency_key": "plan-idem-cross-001",
		"nodes": []map[string]interface{}{
			{
				"key":     "step-a",
				"node_id": "macmini",
				"workdir": macAlpha,
				"agent":   "agy",
				"prompt":  "mutated prompt",
			},
		},
	}
	stConf, rawConf := h.doJSON(http.MethodPost, "/api/v1/plans", h.adminToken, conflictPayload)
	s2AssertError(t, stConf, rawConf, http.StatusConflict, "IDEMPOTENCY_CONFLICT")

	_ = s2WaitRunStatus(t, h, h.adminToken, byKey["step-b"].ID, "done", 15*time.Second)

	// GET /api/v1/runs?plan_id=...&board_topic_id=...
	stList, rawList := h.doJSON(http.MethodGet, "/api/v1/runs?plan_id="+planResp.PlanID+"&board_topic_id="+topDemo.ID, h.adminToken, nil)
	if stList != http.StatusOK {
		t.Fatalf("GET /runs?plan_id failed (%d): %s", stList, string(rawList))
	}
	var listResp evalSlice2RunsListResp
	if err := json.Unmarshal(rawList, &listResp); err != nil || len(listResp.Runs) != 2 {
		t.Fatalf("expected 2 runs for plan_id=%s, got %s", planResp.PlanID, string(rawList))
	}

	// 2. Quotas (20 nodes, 60 edges, 10 deps pass vs 21/61/11 fail) & Kahn Cycle Detection
	buildMaxBoundaryPlan := func(nodeCount, maxTotalEdges int) map[string]interface{} {
		nodes := make([]map[string]interface{}, 0, nodeCount)
		edges := 0
		for i := 0; i < nodeCount; i++ {
			deps := []string{}
			for j := i - 1; j >= 0 && len(deps) < 10 && edges < maxTotalEdges; j-- {
				deps = append(deps, fmt.Sprintf("n-%d", j))
				edges++
			}
			spec := map[string]interface{}{
				"key":     fmt.Sprintf("n-%d", i),
				"node_id": "macmini",
				"workdir": macAlpha,
				"agent":   "agy",
				"in_sec":  300,
				"prompt":  fmt.Sprintf("node %d", i),
			}
			if len(deps) > 0 {
				spec["depends_on"] = deps
			}
			nodes = append(nodes, spec)
		}
		return map[string]interface{}{"nodes": nodes}
	}

	stMaxOK, rawMaxOK := h.doJSON(http.MethodPost, "/api/v1/plans", h.adminToken, buildMaxBoundaryPlan(20, 60))
	if stMaxOK != http.StatusCreated {
		t.Fatalf("20-node / 60-edge / 10-dep boundary plan failed (%d): %s", stMaxOK, string(rawMaxOK))
	}
	var maxOKResp evalSlice2PlanResp
	_ = json.Unmarshal(rawMaxOK, &maxOKResp)
	for _, r := range maxOKResp.Runs {
		_, _ = h.doJSON(http.MethodPost, "/api/v1/runs/"+r.ID+"/cancel", h.adminToken, map[string]interface{}{"cascade": false})
	}

	beforeRuns := h.queryD1Count("SELECT COUNT(*) FROM runs;")
	beforeDeps := h.queryD1Count("SELECT COUNT(*) FROM run_dependencies;")

	// 0 nodes -> 400 BAD_REQUEST
	st0, raw0 := h.doJSON(http.MethodPost, "/api/v1/plans", h.adminToken, map[string]interface{}{"nodes": []interface{}{}})
	s2AssertError(t, st0, raw0, http.StatusBadRequest, "BAD_REQUEST")

	// 21 nodes -> 400 BAD_REQUEST
	st21, raw21 := h.doJSON(http.MethodPost, "/api/v1/plans", h.adminToken, buildMaxBoundaryPlan(21, 20))
	s2AssertError(t, st21, raw21, http.StatusBadRequest, "BAD_REQUEST")

	// 61 edges across 20 nodes -> 400 BAD_REQUEST
	st61, raw61 := h.doJSON(http.MethodPost, "/api/v1/plans", h.adminToken, buildMaxBoundaryPlan(20, 61))
	s2AssertError(t, st61, raw61, http.StatusBadRequest, "BAD_REQUEST")

	// 11 depends_on on one node -> 400 BAD_REQUEST
	elevenDepsNodes := make([]map[string]interface{}, 0, 12)
	elevenDeps := make([]string, 0, 11)
	for i := 0; i < 11; i++ {
		k := fmt.Sprintf("u-%d", i)
		elevenDeps = append(elevenDeps, k)
		elevenDepsNodes = append(elevenDepsNodes, map[string]interface{}{
			"key": k, "node_id": "macmini", "workdir": macAlpha, "agent": "agy", "prompt": "u",
		})
	}
	elevenDepsNodes = append(elevenDepsNodes, map[string]interface{}{
		"key": "sink", "node_id": "macmini", "workdir": macAlpha, "agent": "agy", "depends_on": elevenDeps, "prompt": "sink",
	})
	st11, raw11 := h.doJSON(http.MethodPost, "/api/v1/plans", h.adminToken, map[string]interface{}{"nodes": elevenDepsNodes})
	s2AssertError(t, st11, raw11, http.StatusBadRequest, "BAD_REQUEST")

	// Kahn cycle tests: A->A, A->B->A, A->B->C->A -> 400 DEPENDENCY_CYCLE_DETECTED
	cyclePlans := []map[string]interface{}{
		{
			"nodes": []map[string]interface{}{
				{"key": "a", "node_id": "macmini", "workdir": macAlpha, "agent": "agy", "depends_on": []string{"a"}, "prompt": "self"},
			},
		},
		{
			"nodes": []map[string]interface{}{
				{"key": "a", "node_id": "macmini", "workdir": macAlpha, "agent": "agy", "depends_on": []string{"b"}, "prompt": "a"},
				{"key": "b", "node_id": "macmini", "workdir": macAlpha, "agent": "agy", "depends_on": []string{"a"}, "prompt": "b"},
			},
		},
		{
			"nodes": []map[string]interface{}{
				{"key": "a", "node_id": "macmini", "workdir": macAlpha, "agent": "agy", "depends_on": []string{"c"}, "prompt": "a"},
				{"key": "b", "node_id": "macmini", "workdir": macAlpha, "agent": "agy", "depends_on": []string{"a"}, "prompt": "b"},
				{"key": "c", "node_id": "macmini", "workdir": macAlpha, "agent": "agy", "depends_on": []string{"b"}, "prompt": "c"},
			},
		},
	}
	for _, cp := range cyclePlans {
		stCyc, rawCyc := h.doJSON(http.MethodPost, "/api/v1/plans", h.adminToken, cp)
		s2AssertError(t, stCyc, rawCyc, http.StatusBadRequest, "DEPENDENCY_CYCLE_DETECTED")
	}

	// Verify 0 rows persisted from all invalid/cyclic plans
	if afterRuns := h.queryD1Count("SELECT COUNT(*) FROM runs;"); afterRuns != beforeRuns {
		t.Fatalf("invalid/cyclic plans leaked %d runs rows into D1", afterRuns-beforeRuns)
	}
	if afterDeps := h.queryD1Count("SELECT COUNT(*) FROM run_dependencies;"); afterDeps != beforeDeps {
		t.Fatalf("invalid/cyclic plans leaked %d run_dependencies rows into D1", afterDeps-beforeDeps)
	}

	// 3. max_depth = 1 multi-step plan compatibility vs depth=2 rejection + client scope (P-08)
	parentRun := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "mbp",
		"workdir": mbpDir,
		"agent":   "pi",
		"prompt":  `{"directives":[{"op":"sleep","ms":30}]}`,
	})
	_ = s2WaitRunStatus(t, h, h.adminToken, parentRun.ID, "done", 10*time.Second)

	// Depth 0 parent submitting a 2-step plan on macmini succeeds at depth=1
	stSubPlan, rawSubPlan := h.doJSON(http.MethodPost, "/api/v1/plans", clientTok, map[string]interface{}{
		"parent_run_id":  parentRun.ID,
		"board_topic_id": topDemo.ID,
		"nodes": []map[string]interface{}{
			{"key": "c1", "node_id": "macmini", "workdir": macAlpha, "agent": "agy", "in_sec": 300, "prompt": "d1"},
			{"key": "c2", "node_id": "macmini", "workdir": macAlpha, "agent": "agy", "depends_on": []string{"c1"}, "prompt": "d2"},
		},
	})
	if stSubPlan != http.StatusCreated {
		t.Fatalf("expected depth=1 2-step plan under depth=0 parent to succeed (201), got %d: %s", stSubPlan, string(rawSubPlan))
	}
	var subPlanResp evalSlice2PlanResp
	_ = json.Unmarshal(rawSubPlan, &subPlanResp)
	for _, r := range subPlanResp.Runs {
		if r.Depth != 1 {
			t.Fatalf("expected child plan run depth=1, got %d (%+v)", r.Depth, r)
		}
	}

	// Depth 1 parent submitting a plan -> 409 DEPTH_LIMIT_EXCEEDED
	stDeep, rawDeep := h.doJSON(http.MethodPost, "/api/v1/plans", clientTok, map[string]interface{}{
		"parent_run_id": subPlanResp.Runs[0].ID,
		"nodes": []map[string]interface{}{
			{"key": "too-deep", "node_id": "macmini", "workdir": macAlpha, "agent": "agy", "prompt": "depth 2"},
		},
	})
	s2AssertError(t, stDeep, rawDeep, http.StatusConflict, "DEPTH_LIMIT_EXCEEDED")

	// Delegation cycle in plan -> 409 DELEGATION_CYCLE_DETECTED
	stDelCyc, rawDelCyc := h.doJSON(http.MethodPost, "/api/v1/plans", h.adminToken, map[string]interface{}{
		"parent_run_id": parentRun.ID,
		"nodes": []map[string]interface{}{
			{"key": "loop", "node_id": "mbp", "workdir": mbpDir, "agent": "pi", "prompt": "same (mbp, mbpDir)"},
		},
	})
	s2AssertError(t, stDelCyc, rawDelCyc, http.StatusConflict, "DELEGATION_CYCLE_DETECTED")

	// Clean up c1/c2 waiting runs
	for _, r := range subPlanResp.Runs {
		_, _ = h.doJSON(http.MethodPost, "/api/v1/runs/"+r.ID+"/cancel", h.adminToken, map[string]interface{}{"cascade": false})
	}

	// P-08: client allowed_nodes & allowed_board_prefixes fail-closed + zero leak
	runsBeforeScope := h.queryD1Count("SELECT COUNT(*) FROM runs;")
	stBadNode, rawBadNode := h.doJSON(http.MethodPost, "/api/v1/plans", clientTok, map[string]interface{}{
		"nodes": []map[string]interface{}{
			{"key": "bad-n", "node_id": "mbp", "workdir": mbpDir, "agent": "pi", "prompt": "forbidden node"},
		},
	})
	errBadNode := s2AssertError(t, stBadNode, rawBadNode, http.StatusForbidden, "FORBIDDEN_SCOPE")
	s2AssertNextHints(t, "P-08 badNode", errBadNode.Error.Next, false)
	for _, hStr := range errBadNode.Error.Next {
		if strings.Contains(hStr, "mbp") {
			t.Fatalf("403 error.next leaked unauthorized node name: %v", errBadNode.Error.Next)
		}
	}

	stBadTopic, rawBadTopic := h.doJSON(http.MethodPost, "/api/v1/plans", clientTok, map[string]interface{}{
		"board_topic_id": topOps.ID,
		"nodes": []map[string]interface{}{
			{"key": "bad-t", "node_id": "macmini", "workdir": macAlpha, "agent": "agy", "prompt": "forbidden topic"},
		},
	})
	errBadTopic := s2AssertError(t, stBadTopic, rawBadTopic, http.StatusForbidden, "FORBIDDEN_SCOPE")
	s2AssertNextHints(t, "P-08 badTopic", errBadTopic.Error.Next, true)
	for _, hStr := range errBadTopic.Error.Next {
		if strings.Contains(hStr, "ops/prod") || strings.Contains(hStr, topOps.ID) {
			t.Fatalf("403 error.next leaked unauthorized channel/topic: %v", errBadTopic.Error.Next)
		}
	}
	if runsAfterScope := h.queryD1Count("SELECT COUNT(*) FROM runs;"); runsAfterScope != runsBeforeScope {
		t.Fatalf("forbidden plan persisted %d runs", runsAfterScope-runsBeforeScope)
	}

	// 4. cancel on waiting (0 hub.abort frames) + cascade: false vs cascade: true
	wsCtx, wsCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer wsCancel()
	cancelDir := filepath.Join(h.tmpDir, "workspaces", "s2p-cancel-root", "proj-c")
	cancelWS := []map[string]string{{"key": "proj-c", "path": cancelDir}}
	cConn, _ := s2DialFakeNodeWS(t, wsCtx, h, cancelProbeTok, "nonce_cancel_probe_01", cancelWS)
	defer cConn.Close(websocket.StatusNormalClosure, "done")

	abortCh := make(chan string, 16)
	go func() {
		for {
			_, msg, err := cConn.Read(wsCtx)
			if err != nil {
				return
			}
			var f map[string]interface{}
			if json.Unmarshal(msg, &f) == nil && f["type"] == "hub.abort" {
				abortCh <- string(msg)
			}
		}
	}()

	futureAt := time.Now().UTC().Add(600 * time.Second).Format(time.RFC3339Nano)
	// Case A: cascade=false leaves downstream waiting with UPSTREAM_CANCELLED
	c1 := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "cancel-probe", "workdir": cancelDir, "agent": "agy", "scheduled_at": futureAt, "prompt": "c1",
	}, http.StatusAccepted)
	c2 := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "cancel-probe", "workdir": cancelDir, "agent": "agy", "depends_on": []string{c1.ID}, "prompt": "c2",
	}, http.StatusAccepted)
	stC1, rawC1 := h.doJSON(http.MethodPost, "/api/v1/runs/"+c1.ID+"/cancel", h.adminToken, map[string]interface{}{"cascade": false})
	if stC1 != http.StatusOK {
		t.Fatalf("cancel c1 failed (%d): %s", stC1, string(rawC1))
	}
	if gotC1 := s2GetRun(t, h, h.adminToken, c1.ID, false); gotC1.Status != "cancelled" {
		t.Fatalf("expected c1 cancelled, got %s", gotC1.Status)
	}
	gotC2 := s2GetRun(t, h, h.adminToken, c2.ID, false)
	if gotC2.Status != "waiting" || gotC2.BlockedReason == nil || *gotC2.BlockedReason != "UPSTREAM_CANCELLED" {
		t.Fatalf("expected c2 waiting/UPSTREAM_CANCELLED after non-cascade cancel, got status=%s blocked=%v", gotC2.Status, gotC2.BlockedReason)
	}

	// Case B: cascade=true cancels entire waiting DAG chain
	k1 := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "cancel-probe", "workdir": cancelDir, "agent": "agy", "scheduled_at": futureAt, "prompt": "k1",
	}, http.StatusAccepted)
	k2 := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "cancel-probe", "workdir": cancelDir, "agent": "agy", "depends_on": []string{k1.ID}, "prompt": "k2",
	}, http.StatusAccepted)
	k3 := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "cancel-probe", "workdir": cancelDir, "agent": "agy", "depends_on": []string{k2.ID}, "prompt": "k3",
	}, http.StatusAccepted)
	stK1, rawK1 := h.doJSON(http.MethodPost, "/api/v1/runs/"+k1.ID+"/cancel", h.adminToken, map[string]interface{}{"cascade": true})
	if stK1 != http.StatusOK {
		t.Fatalf("cascade cancel k1 failed (%d): %s", stK1, string(rawK1))
	}
	for _, id := range []string{k1.ID, k2.ID, k3.ID} {
		if r := s2GetRun(t, h, h.adminToken, id, false); r.Status != "cancelled" {
			t.Fatalf("expected cascade cancel to cancel %s, got %s", id, r.Status)
		}
	}
	select {
	case ab := <-abortCh:
		t.Fatalf("cancelling waiting runs must send 0 hub.abort frames, got: %s", ab)
	case <-time.After(300 * time.Millisecond):
	}

	// 5. Slice 1a error.next audit verification (MG-1)
	// 5a. Board IDEMPOTENCY_CONFLICT -> exact "--topic <id>" hint
	idemKey := "board-idem-audit-1"
	stM1, rawM1 := h.doJSON(http.MethodPost, "/api/v1/board/topics/"+topDemo.ID+"/messages", h.adminToken, map[string]interface{}{
		"kind":            "note",
		"text_md":         "first body",
		"idempotency_key": idemKey,
	})
	if stM1 != http.StatusCreated {
		t.Fatalf("board post note failed (%d): %s", stM1, string(rawM1))
	}
	var msg1Resp evalBoardPostMsgResp
	_ = json.Unmarshal(rawM1, &msg1Resp)

	stM2, rawM2 := h.doJSON(http.MethodPost, "/api/v1/board/topics/"+topDemo.ID+"/messages", h.adminToken, map[string]interface{}{
		"kind":            "note",
		"text_md":         "conflicting body",
		"idempotency_key": idemKey,
	})
	errBoardIdem := s2AssertError(t, stM2, rawM2, http.StatusConflict, "IDEMPOTENCY_CONFLICT")
	s2AssertNextHints(t, "board IDEMPOTENCY_CONFLICT", errBoardIdem.Error.Next, true)
	wantTopicNext := fmt.Sprintf("ahub board read --topic %s --json", topDemo.ID)
	if len(errBoardIdem.Error.Next) == 0 || errBoardIdem.Error.Next[0] != wantTopicNext {
		t.Fatalf("MG-1 board error.next mismatch: got %v, want first=%q", errBoardIdem.Error.Next, wantTopicNext)
	}

	// 5b. Board INVALID_STATE_TRANSITION (/answer on non-question) -> "--topic <id>"
	stAnsBad, rawAnsBad := h.doJSON(http.MethodPost, "/api/v1/board/messages/"+msg1Resp.Message.ID+"/answer", h.adminToken, map[string]interface{}{
		"answer_text": "not a question",
	})
	errAnsBad := s2AssertError(t, stAnsBad, rawAnsBad, http.StatusConflict, "INVALID_STATE_TRANSITION")
	s2AssertNextHints(t, "board INVALID_STATE_TRANSITION", errAnsBad.Error.Next, true)
	if len(errAnsBad.Error.Next) == 0 || errAnsBad.Error.Next[0] != wantTopicNext {
		t.Fatalf("board INVALID_STATE_TRANSITION error.next mismatch: got %v, want first=%q", errAnsBad.Error.Next, wantTopicNext)
	}

	// 5c. WORKDIR_AMBIGUOUS -> ["ahub nodes --online --json"] + no secret leak
	stAmb, rawAmb := h.doJSON(http.MethodPost, "/api/v1/runs?wait_ms=0", h.adminToken, map[string]interface{}{
		"node_id": "macmini",
		"workdir": "demo",
		"agent":   "agy",
		"prompt":  "secret ghp_ShouldNeverAppearInNextHint123456",
	})
	errAmb := s2AssertError(t, stAmb, rawAmb, http.StatusBadRequest, "WORKDIR_AMBIGUOUS")
	s2AssertNextHints(t, "WORKDIR_AMBIGUOUS", errAmb.Error.Next, true)
	if len(errAmb.Error.Next) != 1 || errAmb.Error.Next[0] != "ahub nodes --online --json" {
		t.Fatalf("WORKDIR_AMBIGUOUS error.next mismatch: got %v", errAmb.Error.Next)
	}

	// 5d. NODE_NOT_FOUND -> ["ahub nodes --json"] + no secret leak (runs & plans)
	stNNF, rawNNF := h.doJSON(http.MethodPost, "/api/v1/runs?wait_ms=0", h.adminToken, map[string]interface{}{
		"node_id": "nonexistent-node-99",
		"workdir": "/workspace/demo",
		"agent":   "agy",
		"prompt":  "secret sk-proj-ShouldNeverLeak999",
	})
	errNNF := s2AssertError(t, stNNF, rawNNF, http.StatusNotFound, "NODE_NOT_FOUND")
	s2AssertNextHints(t, "run NODE_NOT_FOUND", errNNF.Error.Next, true)
	if len(errNNF.Error.Next) != 1 || errNNF.Error.Next[0] != "ahub nodes --json" {
		t.Fatalf("NODE_NOT_FOUND error.next mismatch: got %v", errNNF.Error.Next)
	}
	stPlanNNF, rawPlanNNF := h.doJSON(http.MethodPost, "/api/v1/plans", h.adminToken, map[string]interface{}{
		"nodes": []map[string]interface{}{
			{"key": "s1", "node_id": "nonexistent-node-99", "workdir": "/workspace/demo", "agent": "agy", "prompt": "secret"},
		},
	})
	errPlanNNF := s2AssertError(t, stPlanNNF, rawPlanNNF, http.StatusNotFound, "NODE_NOT_FOUND")
	s2AssertNextHints(t, "plan NODE_NOT_FOUND", errPlanNNF.Error.Next, true)
	if len(errPlanNNF.Error.Next) != 1 || errPlanNNF.Error.Next[0] != "ahub nodes --json" {
		t.Fatalf("plan NODE_NOT_FOUND error.next mismatch: got %v", errPlanNNF.Error.Next)
	}

	// 5e. F1 Tier 2 #1: positional top_<ULID> without --topic must exit 64
	badReadCode, _, _ := h.runCLI("", "board", "read", topDemo.ID, "--json")
	if badReadCode != api.ExitBadUsageOrInput {
		t.Fatalf("F1 Tier 2 #1 expected exit 64 for positional %s without --topic, got %d", topDemo.ID, badReadCode)
	}

	// 6. F7 Tier 1 #5: ahub run --in 2m --topic <topID> --wait 2s --notify grok --json on waiting run -> exit 0 & webhook_armed=true
	waitNotifyCode, waitNotifyOut, waitNotifyErr := h.runCLI(
		"",
		"run", "-n", "macmini", "-d", macAlpha, "-a", "agy",
		"--in", "2m", "--topic", topDemo.ID, "--wait", "2s", "--notify", "grok", "--json",
		"scheduled notify waiting test",
	)
	if waitNotifyCode != api.ExitOK {
		t.Fatalf("F7 Tier 1 #5 expected exit 0 for --wait --notify on waiting run, got %d\nstdout: %s\nstderr: %s", waitNotifyCode, waitNotifyOut, waitNotifyErr)
	}
	var waitNotifyRec api.RunRecord
	if err := json.Unmarshal([]byte(waitNotifyOut), &waitNotifyRec); err != nil {
		t.Fatalf("F7 Tier 1 #5 expected single valid JSON RunRecord on stdout, err=%v out=%s", err, waitNotifyOut)
	}
	if waitNotifyRec.Status != "waiting" ||
		waitNotifyRec.WebhookArmed == nil || !*waitNotifyRec.WebhookArmed ||
		waitNotifyRec.BoardTopicID == nil || *waitNotifyRec.BoardTopicID != topDemo.ID ||
		waitNotifyRec.ScheduledAt == nil || *waitNotifyRec.ScheduledAt == "" {
		t.Fatalf("F7 Tier 1 #5 unexpected RunRecord: %+v (raw=%s)", waitNotifyRec, waitNotifyOut)
	}
	_, _ = h.doJSON(http.MethodPost, "/api/v1/runs/"+waitNotifyRec.ID+"/cancel", h.adminToken, map[string]interface{}{"cascade": false})
}

// I-14 (F4 + F5 + P-02 + P-04): POST /api/v1/runs/:id/retry terminal immutability,
// atomic rebinding of waiting downstream edges only, non-terminal/draining/scope rejections,
// concurrent retry safety, scheduled_at [+60s,+7d] + Cron wake, and P-04 schedule vs lease reap.
func TestInvariant_Slice2_RetryImmutabilityAndScheduleWake(t *testing.T) {
	h := newTestHarness(t)

	macRoot := filepath.Join(h.tmpDir, "workspaces", "s2r-mac-root")
	macDir := h.makeWorkspaceDir(filepath.Join("s2r-mac-root", "proj-r"))
	ephRoot := filepath.Join(h.tmpDir, "workspaces", "s2r-eph-root")
	ephDir := h.makeWorkspaceDir(filepath.Join("s2r-eph-root", "proj-e"))
	drainRoot := filepath.Join(h.tmpDir, "workspaces", "s2r-drain-root")
	drainDir := h.makeWorkspaceDir(filepath.Join("s2r-drain-root", "proj-d"))

	macTok := h.createKey("s2r-mac", "node", "macmini", []string{"macmini"}, 0)
	ephTok := h.createKey("s2r-eph", "node", "eph-retry-node", []string{"eph-retry-node"}, 0)
	drainTok := h.createKey("s2r-drain", "node", "drain-retry-node", []string{"drain-retry-node"}, 0)

	clientATok := h.createKey("s2r-client-a", "client", "", []string{"macmini", "eph-retry-node"}, 1)
	clientBTok := h.createKey("s2r-client-b", "client", "", []string{"macmini", "eph-retry-node"}, 1)

	h.startDaemon("macmini", macTok, "", macRoot, 2)
	ephCmd := h.startDaemon("eph-retry-node", ephTok, "", ephRoot, 1)
	drainCmd := h.startDaemon("drain-retry-node", drainTok, "", drainRoot, 1)
	defer h.stopDaemon(drainCmd, syscall.SIGKILL)

	// 1. Produce failed run A via daemon crash + reap-leases (so A's prompt succeeds when retried after daemon restart)
	runA := s2CreateRun(t, h, clientATok, map[string]interface{}{
		"node_id": "eph-retry-node",
		"workdir": ephDir,
		"agent":   "agy",
		"prompt":  `{"directives":[{"op":"sleep","ms":180}]}`,
	})
	// Wait until claimed/running before killing daemon
	deadlineStart := time.Now().Add(8 * time.Second)
	for {
		cur := s2GetRun(t, h, h.adminToken, runA.ID, false)
		if cur.Status == "claimed" || cur.Status == "running" {
			break
		}
		if time.Now().After(deadlineStart) {
			t.Fatalf("runA did not enter claimed/running: %+v", cur)
		}
		time.Sleep(40 * time.Millisecond)
	}
	h.stopDaemon(ephCmd, syscall.SIGKILL)
	time.Sleep(3500 * time.Millisecond)

	stReap, rawReap := h.doJSON(http.MethodPost, "/api/v1/admin/reap-leases", h.adminToken, nil)
	if stReap != http.StatusOK {
		t.Fatalf("reap-leases failed (%d): %s", stReap, string(rawReap))
	}
	failedA := s2WaitRunStatus(t, h, h.adminToken, runA.ID, "failed", 5*time.Second)
	if failedA.ErrorCode != "NODE_LEASE_EXPIRED" {
		t.Fatalf("expected NODE_LEASE_EXPIRED on A, got %+v", failedA)
	}

	// Create waiting downstream B and terminal cancelled downstream C depending on A
	runB := s2CreateRun(t, h, clientATok, map[string]interface{}{
		"node_id":    "macmini",
		"workdir":    macDir,
		"agent":      "agy",
		"depends_on": []string{failedA.ID},
		"prompt":     `{"directives":[{"op":"sleep","ms":30}]}`,
	}, http.StatusAccepted)
	if runB.BlockedReason == nil || *runB.BlockedReason != "UPSTREAM_FAILED" {
		t.Fatalf("expected B blocked_reason=UPSTREAM_FAILED, got %v", runB.BlockedReason)
	}

	runC := s2CreateRun(t, h, clientATok, map[string]interface{}{
		"node_id":    "macmini",
		"workdir":    macDir,
		"agent":      "agy",
		"depends_on": []string{failedA.ID},
		"prompt":     `{"directives":[{"op":"sleep","ms":30}]}`,
	}, http.StatusAccepted)
	stCancelC, _ := h.doJSON(http.MethodPost, "/api/v1/runs/"+runC.ID+"/cancel", clientATok, map[string]interface{}{"cascade": false})
	if stCancelC != http.StatusOK {
		t.Fatalf("cancel C failed (%d)", stCancelC)
	}

	// Snapshot A's D1 row before retry
	snapABefore := h.execD1SQL(fmt.Sprintf("SELECT status || '|' || COALESCE(finished_at,'') || '|' || error_code || '|' || output_md || '|' || updated_at FROM runs WHERE id = '%s';", failedA.ID))

	// Restart eph-retry-node so A2 can execute
	ephCmd2 := h.startDaemon("eph-retry-node", ephTok, "", ephRoot, 1)
	defer h.stopDaemon(ephCmd2, syscall.SIGKILL)

	// Cross-client retry must fail 403 FORBIDDEN_SCOPE
	stCross, rawCross := h.doJSON(http.MethodPost, "/api/v1/runs/"+failedA.ID+"/retry", clientBTok, map[string]interface{}{})
	s2AssertError(t, stCross, rawCross, http.StatusForbidden, "FORBIDDEN_SCOPE")

	// Retry A as clientATok with idempotency_key
	stRetry, rawRetry := h.doJSON(http.MethodPost, "/api/v1/runs/"+failedA.ID+"/retry", clientATok, map[string]interface{}{
		"idempotency_key": "retry-idem-a-0001",
		"actor_profile":   "retry-bot",
	})
	if stRetry != http.StatusCreated {
		t.Fatalf("POST /runs/%s/retry expected 201, got %d: %s", failedA.ID, stRetry, string(rawRetry))
	}
	var retryResp evalSlice2RetryResp
	if err := json.Unmarshal(rawRetry, &retryResp); err != nil || !retryResp.OK || retryResp.Run.RetryOfRunID == nil || *retryResp.Run.RetryOfRunID != failedA.ID {
		t.Fatalf("unexpected retry response: err=%v body=%s", err, string(rawRetry))
	}
	// Verify rebound_run_ids includes B and excludes terminal cancelled C
	reboundB := false
	for _, rid := range retryResp.ReboundRunIDs {
		if rid == runB.ID {
			reboundB = true
		}
		if rid == runC.ID {
			t.Fatalf("retry must NOT rebind already-terminal cancelled downstream C (%s)", runC.ID)
		}
	}
	if !reboundB {
		t.Fatalf("expected rebound_run_ids to include B (%s), got %v", runB.ID, retryResp.ReboundRunIDs)
	}

	// Idempotent retry replay -> 200 deduplicated: true
	stRetryDup, rawRetryDup := s2DoJSONWithHeaders(t, h, http.MethodPost, "/api/v1/runs/"+failedA.ID+"/retry", clientATok, map[string]string{
		"Idempotency-Key": "retry-idem-a-0001",
	}, map[string]interface{}{
		"idempotency_key": "retry-idem-a-0001",
		"actor_profile":   "retry-bot",
	})
	if stRetryDup != http.StatusOK {
		t.Fatalf("idempotent retry replay expected 200, got %d: %s", stRetryDup, string(rawRetryDup))
	}
	var retryDupResp evalSlice2RetryResp
	if err := json.Unmarshal(rawRetryDup, &retryDupResp); err != nil || !retryDupResp.Deduplicated || retryDupResp.Run.ID != retryResp.Run.ID {
		t.Fatalf("expected deduplicated retry with same run.id=%s, got %s", retryResp.Run.ID, string(rawRetryDup))
	}

	// Verify A's D1 row is 100% immutable
	snapAAfter := h.execD1SQL(fmt.Sprintf("SELECT status || '|' || COALESCE(finished_at,'') || '|' || error_code || '|' || output_md || '|' || updated_at FROM runs WHERE id = '%s';", failedA.ID))
	if snapABefore != snapAAfter {
		t.Fatalf("MG-4 terminal immutability violated for A!\nbefore: %q\nafter:  %q", snapABefore, snapAAfter)
	}

	// Verify D1 run_dependencies edge for B now points ONLY to A2, while C still points to A
	if cntOld := h.queryD1Count(fmt.Sprintf("SELECT COUNT(*) FROM run_dependencies WHERE run_id = '%s' AND depends_on_run_id = '%s';", runB.ID, failedA.ID)); cntOld != 0 {
		t.Fatalf("MG-4 edge rebind violated: B still depends on old failed A")
	}
	if cntNew := h.queryD1Count(fmt.Sprintf("SELECT COUNT(*) FROM run_dependencies WHERE run_id = '%s' AND depends_on_run_id = '%s';", runB.ID, retryResp.Run.ID)); cntNew != 1 {
		t.Fatalf("MG-4 edge rebind violated: B missing dependency on A2 (%d)", cntNew)
	}
	if cntC := h.queryD1Count(fmt.Sprintf("SELECT COUNT(*) FROM run_dependencies WHERE run_id = '%s' AND depends_on_run_id = '%s';", runC.ID, failedA.ID)); cntC != 1 {
		t.Fatalf("terminal C dependency edge should remain unchanged on A, got count=%d", cntC)
	}

	// Wait for A2 -> done and B -> done
	_ = s2WaitRunStatus(t, h, h.adminToken, retryResp.Run.ID, "done", 12*time.Second)
	_ = s2WaitRunStatus(t, h, h.adminToken, runB.ID, "done", 12*time.Second)

	// Retry on done run -> 409 INVALID_STATE_TRANSITION
	stDoneRetry, rawDoneRetry := h.doJSON(http.MethodPost, "/api/v1/runs/"+runB.ID+"/retry", h.adminToken, map[string]interface{}{})
	s2AssertError(t, stDoneRetry, rawDoneRetry, http.StatusConflict, "INVALID_STATE_TRANSITION")

	// 2. Retry of cancelled run whose own upstream is still waiting -> replacement starts in waiting!
	futureAt := time.Now().UTC().Add(600 * time.Second).Format(time.RFC3339Nano)
	upSched := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini", "workdir": macDir, "agent": "agy", "scheduled_at": futureAt, "prompt": `{"directives":[{"op":"sleep","ms":20}]}`,
	}, http.StatusAccepted)
	childWait := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini", "workdir": macDir, "agent": "agy", "depends_on": []string{upSched.ID}, "prompt": `{"directives":[{"op":"sleep","ms":20}]}`,
	}, http.StatusAccepted)
	// Retry while waiting -> 409 INVALID_STATE_TRANSITION
	stWaitRetry, rawWaitRetry := h.doJSON(http.MethodPost, "/api/v1/runs/"+childWait.ID+"/retry", h.adminToken, map[string]interface{}{})
	s2AssertError(t, stWaitRetry, rawWaitRetry, http.StatusConflict, "INVALID_STATE_TRANSITION")

	// Cancel childWait -> retry childWait -> new replacement starts in waiting (DEPENDENCY_PENDING on upSched)
	_, _ = h.doJSON(http.MethodPost, "/api/v1/runs/"+childWait.ID+"/cancel", h.adminToken, map[string]interface{}{"cascade": false})
	stCanRetry, rawCanRetry := h.doJSON(http.MethodPost, "/api/v1/runs/"+childWait.ID+"/retry", h.adminToken, map[string]interface{}{})
	if stCanRetry != http.StatusCreated {
		t.Fatalf("retry cancelled run failed (%d): %s", stCanRetry, string(rawCanRetry))
	}
	var canRetryResp evalSlice2RetryResp
	_ = json.Unmarshal(rawCanRetry, &canRetryResp)
	if canRetryResp.Run.Status != "waiting" || canRetryResp.Run.BlockedReason == nil || *canRetryResp.Run.BlockedReason != "DEPENDENCY_PENDING" {
		t.Fatalf("expected retried child of unmet upstream to start waiting/DEPENDENCY_PENDING, got status=%s blocked=%v", canRetryResp.Run.Status, canRetryResp.Run.BlockedReason)
	}
	_, _ = h.doJSON(http.MethodPost, "/api/v1/runs/"+upSched.ID+"/cancel", h.adminToken, map[string]interface{}{"cascade": true})

	// 3. NODE_DRAINING 409 on retry + concurrent retry safety
	drainFail := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "drain-retry-node", "workdir": drainDir, "agent": "agy", "prompt": `{"directives":[{"op":"exit","code":1,"message":"fail before drain"}]}`,
	})
	_ = s2WaitRunStatus(t, h, h.adminToken, drainFail.ID, "failed", 10*time.Second)

	// Attach a waiting downstream to test concurrent retry edge safety while node is online
	concDown := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini", "workdir": macDir, "agent": "agy", "depends_on": []string{drainFail.ID}, "prompt": `{"directives":[{"op":"sleep","ms":10}]}`,
	}, http.StatusAccepted)
	var concWG sync.WaitGroup
	concStatuses := make(chan int, 4)
	for i := 0; i < 4; i++ {
		concWG.Add(1)
		go func() {
			defer concWG.Done()
			st, _ := h.doJSON(http.MethodPost, "/api/v1/runs/"+drainFail.ID+"/retry", h.adminToken, map[string]interface{}{})
			concStatuses <- st
		}()
	}
	concWG.Wait()
	close(concStatuses)
	for st := range concStatuses {
		if st >= 500 {
			t.Fatalf("concurrent retry produced 5xx status %d", st)
		}
	}
	if depEdges := h.queryD1Count(fmt.Sprintf("SELECT COUNT(*) FROM run_dependencies WHERE run_id = '%s';", concDown.ID)); depEdges != 1 {
		t.Fatalf("concurrent retry corrupted run_dependencies count for %s: got %d", concDown.ID, depEdges)
	}
	_, _ = h.doJSON(http.MethodPost, "/api/v1/runs/"+concDown.ID+"/cancel", h.adminToken, map[string]interface{}{"cascade": false})

	stPatchDrain, _ := h.doJSON(http.MethodPatch, "/api/v1/nodes/drain-retry-node", h.adminToken, map[string]interface{}{"status": "draining"})
	if stPatchDrain != http.StatusOK {
		t.Fatalf("failed to set drain-retry-node draining (%d)", stPatchDrain)
	}
	stDrainRetry, rawDrainRetry := h.doJSON(http.MethodPost, "/api/v1/runs/"+drainFail.ID+"/retry", h.adminToken, map[string]interface{}{})
	s2AssertError(t, stDrainRetry, rawDrainRetry, http.StatusConflict, "NODE_DRAINING")
	_, _ = h.doJSON(http.MethodPatch, "/api/v1/nodes/drain-retry-node", h.adminToken, map[string]interface{}{"status": "online"})

	// 4. P-02: A (failed) -> B (waiting) -> C (waiting); retry A -> A2; cancel A2 --cascade leaves A untouched & cancels B, C
	p2A := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini", "workdir": macDir, "agent": "agy", "prompt": `{"directives":[{"op":"exit","code":1,"message":"p2 fail"}]}`,
	})
	_ = s2WaitRunStatus(t, h, h.adminToken, p2A.ID, "failed", 10*time.Second)
	p2B := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini", "workdir": macDir, "agent": "agy", "depends_on": []string{p2A.ID}, "prompt": `{"directives":[{"op":"sleep","ms":500}]}`,
	}, http.StatusAccepted)
	p2C := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini", "workdir": macDir, "agent": "agy", "depends_on": []string{p2B.ID}, "prompt": `{"directives":[{"op":"sleep","ms":10}]}`,
	}, http.StatusAccepted)

	stP2Retry, rawP2Retry := h.doJSON(http.MethodPost, "/api/v1/runs/"+p2A.ID+"/retry", h.adminToken, map[string]interface{}{})
	if stP2Retry != http.StatusCreated {
		t.Fatalf("p2 retry A failed (%d): %s", stP2Retry, string(rawP2Retry))
	}
	var p2RetryResp evalSlice2RetryResp
	_ = json.Unmarshal(rawP2Retry, &p2RetryResp)

	stP2Cancel, rawP2Cancel := h.doJSON(http.MethodPost, "/api/v1/runs/"+p2RetryResp.Run.ID+"/cancel", h.adminToken, map[string]interface{}{"cascade": true})
	if stP2Cancel != http.StatusOK {
		t.Fatalf("p2 cascade cancel A2 failed (%d): %s", stP2Cancel, string(rawP2Cancel))
	}
	if gotP2A := s2GetRun(t, h, h.adminToken, p2A.ID, false); gotP2A.Status != "failed" {
		t.Fatalf("P-02 original failed A must remain untouched, got %s", gotP2A.Status)
	}
	if gotP2B := s2GetRun(t, h, h.adminToken, p2B.ID, false); gotP2B.Status != "cancelled" {
		t.Fatalf("P-02 expected B cancelled via cascade on A2, got %s", gotP2B.Status)
	}
	if gotP2C := s2GetRun(t, h, h.adminToken, p2C.ID, false); gotP2C.Status != "cancelled" {
		t.Fatalf("P-02 expected C cancelled via cascade on A2, got %s", gotP2C.Status)
	}

	// 5. scheduled_at [+60s, +7d] window validation + deterministic Cron wake + P-04
	now := time.Now().UTC()
	for _, badAt := range []string{
		now.Add(-60 * time.Second).Format(time.RFC3339Nano),
		now.Add(45 * time.Second).Format(time.RFC3339Nano),
		now.Add((7*86400 + 60) * time.Second).Format(time.RFC3339Nano),
	} {
		stBadSched, rawBadSched := h.doJSON(http.MethodPost, "/api/v1/runs?wait_ms=0", h.adminToken, map[string]interface{}{
			"node_id": "macmini", "workdir": macDir, "agent": "agy", "scheduled_at": badAt, "prompt": "out of window",
		})
		s2AssertError(t, stBadSched, rawBadSched, http.StatusBadRequest, "BAD_REQUEST")
	}

	// Max valid boundary (+7d - 30s) accepted as waiting/SCHEDULED (then cancelled)
	farOK := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini", "workdir": macDir, "agent": "agy",
		"scheduled_at": now.Add((7*86400 - 30) * time.Second).Format(time.RFC3339Nano),
		"prompt":       "7d boundary ok",
	}, http.StatusAccepted)
	if farOK.Status != "waiting" || farOK.BlockedReason == nil || *farOK.BlockedReason != "SCHEDULED" {
		t.Fatalf("expected far boundary waiting/SCHEDULED, got %+v", farOK)
	}
	_, _ = h.doJSON(http.MethodPost, "/api/v1/runs/"+farOK.ID+"/cancel", h.adminToken, map[string]interface{}{"cascade": false})

	// Combined depends_on + scheduled_at: upstream finishes early -> stays waiting (SCHEDULED) until Cron wakes
	fastUp := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini", "workdir": macDir, "agent": "agy", "prompt": `{"directives":[{"op":"sleep","ms":30}]}`,
	})
	comboSched := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":      "macmini",
		"workdir":      macDir,
		"agent":        "agy",
		"depends_on":   []string{fastUp.ID},
		"scheduled_at": now.Add(180 * time.Second).Format(time.RFC3339Nano),
		"prompt":       `{"directives":[{"op":"sleep","ms":20}]}`,
	}, http.StatusAccepted)
	_ = s2WaitRunStatus(t, h, h.adminToken, fastUp.ID, "done", 10*time.Second)

	afterUp := s2GetRun(t, h, h.adminToken, comboSched.ID, false)
	if afterUp.Status != "waiting" || afterUp.BlockedReason == nil || *afterUp.BlockedReason != "SCHEDULED" {
		t.Fatalf("expected comboSched to remain waiting/SCHEDULED after upstream done, got status=%s blocked=%v", afterUp.Status, afterUp.BlockedReason)
	}

	// Backdate comboSched.scheduled_at and invoke /cdn-cgi/handler/scheduled -> wakes & finishes done
	h.execD1SQL(fmt.Sprintf("UPDATE runs SET scheduled_at = '2020-01-01T00:00:00.000Z' WHERE id = '%s';", comboSched.ID))
	schedResp, err := http.Get(h.hubURL + "/cdn-cgi/handler/scheduled")
	if err != nil {
		t.Fatalf("GET /cdn-cgi/handler/scheduled failed: %v", err)
	}
	_ = schedResp.Body.Close()
	if schedResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from /cdn-cgi/handler/scheduled, got %d", schedResp.StatusCode)
	}
	_ = s2WaitRunStatus(t, h, h.adminToken, comboSched.ID, "done", 12*time.Second)

	// P-04: schedule + Cron Lease Reap -> reaped A keeps B in waiting (UPSTREAM_FAILED) even after scheduled_at elapses
	p4A := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "eph-retry-node", "workdir": ephDir, "agent": "agy", "prompt": `{"directives":[{"op":"sleep","ms":20000}]}`,
	})
	deadlineP4 := time.Now().Add(8 * time.Second)
	for {
		cur := s2GetRun(t, h, h.adminToken, p4A.ID, false)
		if cur.Status == "claimed" || cur.Status == "running" {
			break
		}
		if time.Now().After(deadlineP4) {
			t.Fatalf("p4A did not start running: %+v", cur)
		}
		time.Sleep(40 * time.Millisecond)
	}
	p4B := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":      "macmini",
		"workdir":      macDir,
		"agent":        "agy",
		"depends_on":   []string{p4A.ID},
		"scheduled_at": time.Now().UTC().Add(120 * time.Second).Format(time.RFC3339Nano),
		"prompt":       `{"directives":[{"op":"sleep","ms":20}]}`,
	}, http.StatusAccepted)

	h.stopDaemon(ephCmd2, syscall.SIGKILL)
	time.Sleep(3500 * time.Millisecond)
	h.execD1SQL(fmt.Sprintf("UPDATE runs SET scheduled_at = '2020-01-01T00:00:00.000Z' WHERE id = '%s';", p4B.ID))

	schedResp2, err := http.Get(h.hubURL + "/cdn-cgi/handler/scheduled")
	if err != nil {
		t.Fatalf("GET /cdn-cgi/handler/scheduled (P-04) failed: %v", err)
	}
	_ = schedResp2.Body.Close()
	if schedResp2.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from scheduled handler (P-04), got %d", schedResp2.StatusCode)
	}

	_ = s2WaitRunStatus(t, h, h.adminToken, p4A.ID, "failed", 6*time.Second)
	p4BAfter := s2GetRun(t, h, h.adminToken, p4B.ID, false)
	if p4BAfter.Status != "waiting" || p4BAfter.BlockedReason == nil || *p4BAfter.BlockedReason != "UPSTREAM_FAILED" {
		t.Fatalf("P-04 violated: expected p4B to stay waiting/UPSTREAM_FAILED after Cron reap + elapsed schedule, got status=%s blocked=%v",
			p4BAfter.Status, p4BAfter.BlockedReason)
	}
}

// I-15 (F6 + P-03): Terminal Run Auto-Handoff to board_topic_id across done/failed/cancelled/reaped,
// secret redaction, actor_profile & source_node preservation, /ws/stream board.message_created,
// 0 notification_deliveries / 0 push hits, and survival on deleted board_topic_id.
func TestInvariant_Slice2_TerminalBoardAutoHandoff(t *testing.T) {
	h := newTestHarness(t)

	macRoot := filepath.Join(h.tmpDir, "workspaces", "s2h-mac-root")
	macDir := h.makeWorkspaceDir(filepath.Join("s2h-mac-root", "proj-h"))
	ephRoot := filepath.Join(h.tmpDir, "workspaces", "s2h-eph-root")
	ephDir := h.makeWorkspaceDir(filepath.Join("s2h-eph-root", "proj-he"))

	macTok := h.createKey("s2h-mac", "node", "macmini", []string{"macmini"}, 0)
	ephTok := h.createKey("s2h-eph", "node", "eph-handoff-node", []string{"eph-handoff-node"}, 0)

	h.startDaemon("macmini", macTok, "", macRoot, 2)
	ephCmd := h.startDaemon("eph-handoff-node", ephTok, "", ephRoot, 1)

	// Register a Web Push subscription listening for board_question_opened so MG-5 would hit pushCh immediately
	uaPriv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	uaAuth := make([]byte, 16)
	_, _ = rand.Read(uaAuth)
	stSub, rawSub := h.doJSON(http.MethodPost, "/api/v1/push-subscriptions", h.adminToken, map[string]interface{}{
		"label": "i15-zero-push-probe",
		"subscription": map[string]interface{}{
			"endpoint": h.pushSrv.URL + "/push/i15",
			"keys": map[string]string{
				"p256dh": base64.RawURLEncoding.EncodeToString(uaPriv.PublicKey().Bytes()),
				"auth":   base64.RawURLEncoding.EncodeToString(uaAuth),
			},
		},
		"node_filter":  []string{},
		"event_filter": []string{"board_question_opened"},
	})
	if stSub != http.StatusCreated && stSub != http.StatusOK {
		t.Fatalf("push subscription failed (%d): %s", stSub, string(rawSub))
	}
	for len(h.pushCh) > 0 {
		<-h.pushCh
	}

	topHandoff := s2CreateTopic(t, h, h.adminToken, "proj/demo", "Auto Handoff Topic")
	topPlan := s2CreateTopic(t, h, h.adminToken, "proj/demo", "Plan Auto Handoff Topic")
	topDeletedFK := s2CreateTopic(t, h, h.adminToken, "proj/demo", "Deleted FK Topic")
	topDeletedDangling := s2CreateTopic(t, h, h.adminToken, "proj/demo", "Deleted Dangling Topic")

	// Subscribe to /ws/stream?topic_id=<topHandoff.ID>
	wsCtx, wsCancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer wsCancel()
	wsConn, err := api.NewClient(h.hubURL, h.adminToken).DialWebSocket(wsCtx, "/ws/stream?topic_id="+topHandoff.ID)
	if err != nil {
		t.Fatalf("dial /ws/stream?topic_id failed: %v", err)
	}
	defer wsConn.Close(websocket.StatusNormalClosure, "done")
	// Consume initial snapshot
	_, _, err = wsConn.Read(wsCtx)
	if err != nil {
		t.Fatalf("read topic stream snapshot failed: %v", err)
	}

	var wsMu sync.Mutex
	wsHandoffRunIDs := map[string]bool{}
	go func() {
		for {
			_, raw, readErr := wsConn.Read(wsCtx)
			if readErr != nil {
				return
			}
			var frame struct {
				Type    string `json:"type"`
				Message struct {
					Kind string                 `json:"kind"`
					Data map[string]interface{} `json:"data"`
				} `json:"message"`
			}
			if json.Unmarshal(raw, &frame) == nil && frame.Type == "board.message_created" && frame.Message.Kind == "handoff" {
				if rid, ok := frame.Message.Data["run_id"].(string); ok && rid != "" {
					wsMu.Lock()
					wsHandoffRunIDs[rid] = true
					wsMu.Unlock()
				}
			}
		}
	}()

	// 1. Run without board_topic_id creates 0 board messages
	noBoardRun := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id": "macmini", "workdir": macDir, "agent": "agy",
		"prompt": `{"directives":[{"op":"sleep","ms":20}]}`,
		"notify": map[string]string{"target": "none"},
	})
	_ = s2WaitRunStatus(t, h, h.adminToken, noBoardRun.ID, "done", 10*time.Second)
	if cnt := h.queryD1Count(fmt.Sprintf("SELECT COUNT(*) FROM board_messages WHERE data_json LIKE '%%%s%%';", noBoardRun.ID)); cnt != 0 {
		t.Fatalf("run without board_topic_id created %d board messages", cnt)
	}

	// 2. Done run with secret in response + actor_profile
	secretDone := "sk-proj-AutoHandoffSecret9876543210"
	doneRun := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":        "macmini",
		"workdir":        macDir,
		"agent":          "agy",
		"board_topic_id": topHandoff.ID,
		"actor_profile":  "codex-reviewer",
		"notify":         map[string]string{"target": "none"},
		"prompt":         fmt.Sprintf(`{"summary":"Done with token=%s","response":"Body %s","directives":[{"op":"sleep","ms":20}]}`, secretDone, secretDone),
	})
	_ = s2WaitRunStatus(t, h, h.adminToken, doneRun.ID, "done", 10*time.Second)

	// 3. Failed run with secret in stderr/error
	secretFail := "ghp_AutoHandoffSecretFail1234567890"
	failRun := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":        "macmini",
		"workdir":        macDir,
		"agent":          "agy",
		"board_topic_id": topHandoff.ID,
		"actor_profile":  "pi-verifier",
		"notify":         map[string]string{"target": "none"},
		"prompt":         fmt.Sprintf(`{"directives":[{"op":"exit","code":1,"message":"Failed token=%s"}]}`, secretFail),
	})
	_ = s2WaitRunStatus(t, h, h.adminToken, failRun.ID, "failed", 10*time.Second)

	// 4. Cancelled waiting run
	cancelRun := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":        "macmini",
		"workdir":        macDir,
		"agent":          "agy",
		"board_topic_id": topHandoff.ID,
		"scheduled_at":   time.Now().UTC().Add(300 * time.Second).Format(time.RFC3339Nano),
		"notify":         map[string]string{"target": "none"},
		"prompt":         "will cancel",
	}, http.StatusAccepted)
	stCan, rawCan := h.doJSON(http.MethodPost, "/api/v1/runs/"+cancelRun.ID+"/cancel", h.adminToken, map[string]interface{}{"cascade": false})
	if stCan != http.StatusOK {
		t.Fatalf("cancel failed (%d): %s", stCan, string(rawCan))
	}

	// 5. Cron-reaped (NODE_LEASE_EXPIRED) run
	reapRun := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":        "eph-handoff-node",
		"workdir":        ephDir,
		"agent":          "agy",
		"board_topic_id": topHandoff.ID,
		"actor_profile":  "eph-worker",
		"notify":         map[string]string{"target": "none"},
		"prompt":         `{"directives":[{"op":"sleep","ms":20000}]}`,
	})
	reapStartDeadline := time.Now().Add(8 * time.Second)
	for {
		cur := s2GetRun(t, h, h.adminToken, reapRun.ID, false)
		if cur.Status == "claimed" || cur.Status == "running" {
			break
		}
		if time.Now().After(reapStartDeadline) {
			t.Fatalf("reapRun did not start: %+v", cur)
		}
		time.Sleep(40 * time.Millisecond)
	}
	h.stopDaemon(ephCmd, syscall.SIGKILL)
	time.Sleep(3500 * time.Millisecond)
	_, _ = h.doJSON(http.MethodPost, "/api/v1/admin/reap-leases", h.adminToken, nil)
	_ = s2WaitRunStatus(t, h, h.adminToken, reapRun.ID, "failed", 6*time.Second)

	// 6. Resolve needs_approval run -> done auto-handoff
	resRun := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":        "macmini",
		"workdir":        macDir,
		"agent":          "agy",
		"board_topic_id": topHandoff.ID,
		"notify":         map[string]string{"target": "none"},
		"prompt":         `{"session_id":"sess_i15_resolve","directives":[{"op":"exit_approval","url":"https://ahub.bobocai.win/rc/i15","message":"Approve handoff"}]}`,
	})
	_ = s2WaitRunStatus(t, h, h.adminToken, resRun.ID, "needs_approval", 10*time.Second)
	stRes, rawRes := h.doJSON(http.MethodPost, "/api/v1/runs/"+resRun.ID+"/resolve", h.adminToken, map[string]string{"summary": "approved"})
	if stRes != http.StatusOK {
		t.Fatalf("resolve failed (%d): %s", stRes, string(rawRes))
	}

	// Verify all 5 auto-handoffs in topHandoff
	stMsgs, rawMsgs := h.doJSON(http.MethodGet, "/api/v1/board/topics/"+topHandoff.ID+"/messages?limit=50", h.adminToken, nil)
	if stMsgs != http.StatusOK {
		t.Fatalf("GET messages failed (%d): %s", stMsgs, string(rawMsgs))
	}
	if strings.Contains(string(rawMsgs), secretDone) || strings.Contains(string(rawMsgs), secretFail) {
		t.Fatalf("auto-handoff leaked unredacted secret into board messages: %s", string(rawMsgs))
	}
	var msgsResp evalBoardMessagesResp
	if err := json.Unmarshal(rawMsgs, &msgsResp); err != nil {
		t.Fatalf("decode board messages: %v", err)
	}
	byRunID := map[string]evalBoardMessage{}
	handoffCounts := map[string]int{}
	for _, m := range msgsResp.Messages {
		if m.Kind == "handoff" {
			if rid, ok := m.Data["run_id"].(string); ok {
				byRunID[rid] = m
				handoffCounts[rid]++
			}
		}
	}
	expectedRuns := []struct {
		id           string
		status       string
		sourceNode   string
		actorProfile string
		errorCode    string
	}{
		{doneRun.ID, "done", "macmini", "codex-reviewer", ""},
		{failRun.ID, "failed", "macmini", "pi-verifier", ""},
		{cancelRun.ID, "cancelled", "macmini", "", ""},
		{reapRun.ID, "failed", "eph-handoff-node", "eph-worker", "NODE_LEASE_EXPIRED"},
		{resRun.ID, "done", "macmini", "", ""},
	}
	for _, exp := range expectedRuns {
		m, ok := byRunID[exp.id]
		if !ok {
			t.Fatalf("missing auto-handoff board message for run %s (%s)", exp.id, exp.status)
		}
		if handoffCounts[exp.id] != 1 {
			t.Fatalf("expected strictly 1 deduplicated auto-handoff for run %s, got %d", exp.id, handoffCounts[exp.id])
		}
		if m.SourceNode != exp.sourceNode {
			t.Fatalf("handoff for %s expected source_node=%q, got %q", exp.id, exp.sourceNode, m.SourceNode)
		}
		if exp.actorProfile != "" && m.ActorProfile != exp.actorProfile {
			t.Fatalf("handoff for %s expected actor_profile=%q, got %q", exp.id, exp.actorProfile, m.ActorProfile)
		}
		if gotSt, _ := m.Data["status"].(string); gotSt != exp.status {
			t.Fatalf("handoff for %s expected data.status=%q, got %q", exp.id, exp.status, gotSt)
		}
		if exp.errorCode != "" {
			if gotErr, _ := m.Data["error_code"].(string); gotErr != exp.errorCode {
				t.Fatalf("handoff for %s expected data.error_code=%q, got %q", exp.id, exp.errorCode, gotErr)
			}
		}
	}

	// Verify WS board.message_created arrived for all 5
	wsDeadline := time.Now().Add(6 * time.Second)
	for {
		wsMu.Lock()
		allSeen := true
		for _, exp := range expectedRuns {
			if !wsHandoffRunIDs[exp.id] {
				allSeen = false
				break
			}
		}
		wsMu.Unlock()
		if allSeen {
			break
		}
		if time.Now().After(wsDeadline) {
			wsMu.Lock()
			t.Fatalf("WS board.message_created missing auto-handoffs: seen=%v", wsHandoffRunIDs)
			wsMu.Unlock()
		}
		time.Sleep(60 * time.Millisecond)
	}

	// 7. P-03: POST /api/v1/plans with board_topic_id -> done + failed auto-handoff with 0 notification_deliveries
	stPlan, rawPlan := h.doJSON(http.MethodPost, "/api/v1/plans", h.adminToken, map[string]interface{}{
		"board_topic_id": topPlan.ID,
		"actor_profile":  "plan-handoff-bot",
		"nodes": []map[string]interface{}{
			{
				"key": "p-done", "node_id": "macmini", "workdir": macDir, "agent": "agy",
				"notify": map[string]string{"target": "none"},
				"prompt": `{"directives":[{"op":"sleep","ms":20}]}`,
			},
			{
				"key": "p-fail", "node_id": "macmini", "workdir": macDir, "agent": "agy",
				"depends_on": []string{"p-done"},
				"notify":     map[string]string{"target": "none"},
				"prompt":     `{"directives":[{"op":"exit","code":1,"message":"plan step fail"}]}`,
			},
		},
	})
	if stPlan != http.StatusCreated {
		t.Fatalf("P-03 plan create failed (%d): %s", stPlan, string(rawPlan))
	}
	var p3Plan evalSlice2PlanResp
	_ = json.Unmarshal(rawPlan, &p3Plan)
	for _, r := range p3Plan.Runs {
		if r.PlanKey != nil && *r.PlanKey == "p-done" {
			_ = s2WaitRunStatus(t, h, h.adminToken, r.ID, "done", 10*time.Second)
		} else {
			_ = s2WaitRunStatus(t, h, h.adminToken, r.ID, "failed", 10*time.Second)
		}
	}
	stPlanMsgs, rawPlanMsgs := h.doJSON(http.MethodGet, "/api/v1/board/topics/"+topPlan.ID+"/messages?limit=20", h.adminToken, nil)
	if stPlanMsgs != http.StatusOK {
		t.Fatalf("GET plan topic messages failed (%d): %s", stPlanMsgs, string(rawPlanMsgs))
	}
	var planMsgs evalBoardMessagesResp
	_ = json.Unmarshal(rawPlanMsgs, &planMsgs)
	if len(planMsgs.Messages) < 2 {
		t.Fatalf("P-03 expected 2 auto-handoffs for plan topic, got %d (%s)", len(planMsgs.Messages), string(rawPlanMsgs))
	}
	for _, m := range planMsgs.Messages {
		if m.Kind != "handoff" || m.Data["plan_id"] != p3Plan.PlanID {
			t.Fatalf("P-03 unexpected handoff message payload: %+v", m)
		}
	}

	// Assert 0 notification_deliveries rows & 0 Web Push hits for ALL board_message auto-handoffs (MG-5)
	if dlvCnt := h.queryD1Count("SELECT COUNT(*) FROM notification_deliveries WHERE source_kind = 'board_message';"); dlvCnt != 0 {
		t.Fatalf("MG-5 violated: auto-handoff created %d notification_deliveries rows", dlvCnt)
	}
	select {
	case hit := <-h.pushCh:
		t.Fatalf("MG-5 violated: auto-handoff triggered Web Push: %+v", hit)
	case <-time.After(400 * time.Millisecond):
	}

	// 8. Deleted board_topic_id (FK ON DELETE SET NULL & dangling topic_id) MUST NOT block terminal Run persistence
	delFKRun := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":        "macmini",
		"workdir":        macDir,
		"agent":          "agy",
		"board_topic_id": topDeletedFK.ID,
		"scheduled_at":   time.Now().UTC().Add(300 * time.Second).Format(time.RFC3339Nano),
		"prompt":         `{"directives":[{"op":"sleep","ms":20}]}`,
	}, http.StatusAccepted)
	h.execD1SQL(fmt.Sprintf("PRAGMA foreign_keys = ON; DELETE FROM board_topics WHERE id = '%s';", topDeletedFK.ID))
	h.execD1SQL(fmt.Sprintf("UPDATE runs SET scheduled_at = '2020-01-01T00:00:00.000Z' WHERE id = '%s';", delFKRun.ID))
	schedFKResp, err := http.Get(h.hubURL + "/cdn-cgi/handler/scheduled")
	if err != nil {
		t.Fatalf("GET /cdn-cgi/handler/scheduled (deleted FK) failed: %v", err)
	}
	_ = schedFKResp.Body.Close()
	if schedFKResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from scheduled handler (deleted FK), got %d", schedFKResp.StatusCode)
	}
	doneFK := s2WaitRunStatus(t, h, h.adminToken, delFKRun.ID, "done", 12*time.Second)
	if doneFK.BoardTopicID != nil {
		t.Fatalf("expected ON DELETE SET NULL to clear board_topic_id, got %v", *doneFK.BoardTopicID)
	}

	delDanglingRun := s2CreateRun(t, h, h.adminToken, map[string]interface{}{
		"node_id":        "macmini",
		"workdir":        macDir,
		"agent":          "agy",
		"board_topic_id": topDeletedDangling.ID,
		"scheduled_at":   time.Now().UTC().Add(300 * time.Second).Format(time.RFC3339Nano),
		"prompt":         `{"directives":[{"op":"sleep","ms":20}]}`,
	}, http.StatusAccepted)
	// Delete without FK cascade so run still references missing board_topic_id when completing
	h.execD1SQL(fmt.Sprintf("PRAGMA foreign_keys = OFF; DELETE FROM board_topics WHERE id = '%s';", topDeletedDangling.ID))
	h.execD1SQL(fmt.Sprintf("UPDATE runs SET scheduled_at = '2020-01-01T00:00:00.000Z' WHERE id = '%s';", delDanglingRun.ID))
	schedDanglingResp, err := http.Get(h.hubURL + "/cdn-cgi/handler/scheduled")
	if err != nil {
		t.Fatalf("GET /cdn-cgi/handler/scheduled (dangling topic) failed: %v", err)
	}
	_ = schedDanglingResp.Body.Close()
	if schedDanglingResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from scheduled handler (dangling topic), got %d", schedDanglingResp.StatusCode)
	}
	_ = s2WaitRunStatus(t, h, h.adminToken, delDanglingRun.ID, "done", 12*time.Second)
}
