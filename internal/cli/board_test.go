package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/gray0128/agent-hub/internal/api"
)

func captureExecuteFull(t *testing.T, args []string, stdinData string) (int, string, string) {
	t.Helper()
	oldStdout := os.Stdout
	oldStderr := os.Stderr
	oldStdin := os.Stdin

	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	inR, inW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}

	os.Stdout = outW
	os.Stderr = errW
	os.Stdin = inR
	defer func() {
		os.Stdout = oldStdout
		os.Stderr = oldStderr
		os.Stdin = oldStdin
	}()

	if _, err := io.WriteString(inW, stdinData); err != nil {
		t.Fatal(err)
	}
	_ = inW.Close()

	code := Execute(args, "v0.1.0")
	_ = outW.Close()
	_ = errW.Close()
	_ = inR.Close()

	var outBuf, errBuf bytes.Buffer
	if _, err := io.Copy(&outBuf, outR); err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(&errBuf, errR); err != nil {
		t.Fatal(err)
	}
	_ = outR.Close()
	_ = errR.Close()
	return code, outBuf.String(), errBuf.String()
}

func sampleHandoffSnapshot() *api.BoardHandoffSnapshot {
	return &api.BoardHandoffSnapshot{
		ID:           "msg_01HANDOFF",
		ActorProfile: "planner",
		SourceNode:   "mbp",
		TextMD:       "Initial handoff",
		Data:         map[string]interface{}{"stage": "m3"},
		CreatedAt:    "2026-11-22T00:00:00Z",
	}
}

func sampleTopic(id, channel, status string, withHandoff bool) api.BoardTopic {
	var ho *api.BoardHandoffSnapshot
	if withHandoff {
		ho = sampleHandoffSnapshot()
	}
	return api.BoardTopic{
		ID:                   id,
		Channel:              channel,
		Title:                "Topic " + id,
		ExternalRef:          "pr#42",
		Status:               status,
		PreviousStatus:       "",
		Pinned:               false,
		SortOrder:            1,
		Labels:               map[string]string{},
		CreatedByKeyID:       nil,
		LastMessageID:        "msg_01LAST",
		LastHandoffMessageID: "msg_01HANDOFF",
		LastEventCursor:      12,
		LatestHandoff:        ho,
		CreatedAt:            "2026-11-22T00:00:00Z",
		UpdatedAt:            "2026-11-22T00:01:00Z",
	}
}

func sampleMessage(id, topicID, channel, kind string, seq int) api.BoardMessage {
	return api.BoardMessage{
		ID:                id,
		TopicID:           topicID,
		Channel:           channel,
		Seq:               seq,
		Kind:              kind,
		ReplyToID:         nil,
		ActorScope:        "client",
		ActorKeyID:        nil,
		ActorProfile:      "worker-a",
		SourceNode:        "macmini",
		TextMD:            "message body",
		Data:              map[string]interface{}{},
		QuestionState:     "",
		QuestionOptions:   []string{},
		QuestionExpiresAt: nil,
		AnsweredMessageID: nil,
		AnsweredAt:        nil,
		CreatedAt:         "2026-11-22T00:01:00Z",
	}
}

func TestBoardPostStdinDataPreRedactionAndCompactJSON(t *testing.T) {
	var capturedTopicBody map[string]interface{}
	var capturedMsgBody map[string]interface{}
	var capturedIdemHeader string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/board/topics":
			capturedTopicBody = nil
			if err := json.NewDecoder(r.Body).Decode(&capturedTopicBody); err != nil {
				t.Fatalf("decode topic body: %v", err)
			}
			_ = json.NewEncoder(w).Encode(api.BoardTopicResponse{
				OK:    true,
				Topic: sampleTopic("top_01POST", "proj/demo", "in_progress", true),
			})
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/board/topics/top_01POST/messages":
			capturedMsgBody = nil
			capturedIdemHeader = r.Header.Get("Idempotency-Key")
			if err := json.NewDecoder(r.Body).Decode(&capturedMsgBody); err != nil {
				t.Fatalf("decode msg body: %v", err)
			}
			msg := sampleMessage("msg_01POST", "top_01POST", "proj/demo", "handoff", 2)
			msg.TextMD = capturedMsgBody["text_md"].(string)
			msg.Data = capturedMsgBody["data"].(map[string]interface{})
			_ = json.NewEncoder(w).Encode(api.BoardMessagePostResponse{
				OK:      true,
				Topic:   sampleTopic("top_01POST", "proj/demo", "in_progress", true),
				Message: msg,
				Cursor:  15,
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	tmpDir := t.TempDir()
	dataFile := filepath.Join(tmpDir, "meta.json")
	if err := os.WriteFile(dataFile, []byte(`{"api_key":"raw_secret_key_99","nested":{"token":"ahub_cli_leak9999"},"safe":"$ENV_REF","has_token":"true","count":42}`), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("AHUB_CONFIG_DIR", tmpDir)
	t.Setenv("AHUB_URL", srv.URL)
	t.Setenv("AHUB_TOKEN", "ahub_cli_caller_tok")
	t.Setenv("AHUB_PROFILE", "env-should-lose")

	stdinPayload := "Line 1: Authorization: Bearer raw_bearer_secret_88\nLine 2: keep $AHUB_TOKEN\n"
	code, out, errOut := captureExecuteFull(t, []string{
		"--json", "board", "post", "proj/demo",
		"--ref", "pr#42",
		"--title", "Deploy key=ahub_cli_title_secret_123",
		"--kind", "handoff",
		"--status", "in_progress",
		"--as", "worker-1@macmini",
		"--node", "macmini",
		"--data", "@" + dataFile,
		"--idempotency-key", "idem_post_12345678",
		"-",
	}, stdinPayload)
	if code != api.ExitOK {
		t.Fatalf("expected ExitOK, got %d stdout=%s stderr=%s", code, out, errOut)
	}

	trimmed := strings.TrimSpace(out)
	if strings.Contains(trimmed, "\n") {
		t.Fatalf("expected single-line JSON on stdout, got:\n%s", out)
	}
	for _, secret := range []string{"raw_secret_key_99", "leak9999", "raw_bearer_secret_88", "title_secret_123"} {
		if strings.Contains(trimmed, secret) {
			t.Fatalf("secret %q leaked in stdout: %s", secret, trimmed)
		}
		if b, _ := json.Marshal(capturedMsgBody); strings.Contains(string(b), secret) {
			t.Fatalf("secret %q sent unredacted in HTTP request: %s", secret, string(b))
		}
		if b, _ := json.Marshal(capturedTopicBody); strings.Contains(string(b), secret) {
			t.Fatalf("secret %q sent unredacted in topic title: %s", secret, string(b))
		}
	}
	if !strings.Contains(trimmed, "$AHUB_TOKEN") || !strings.Contains(trimmed, "$ENV_REF") {
		t.Fatalf("expected placeholders preserved, got: %s", trimmed)
	}
	if capturedTopicBody["upsert"] != true || capturedTopicBody["external_ref"] != "pr#42" {
		t.Fatalf("expected upsert=true and external_ref=pr#42, got %+v", capturedTopicBody)
	}
	if capturedMsgBody["actor_profile"] != "worker-1@macmini" || capturedMsgBody["source_node"] != "macmini" || capturedMsgBody["topic_status"] != "in_progress" {
		t.Fatalf("unexpected message body: %+v", capturedMsgBody)
	}
	if capturedIdemHeader != "idem_post_12345678" {
		t.Fatalf("expected Idempotency-Key header, got %q", capturedIdemHeader)
	}

	var decoded map[string]interface{}
	if err := json.Unmarshal([]byte(trimmed), &decoded); err != nil {
		t.Fatalf("invalid json stdout: %v", err)
	}
	topicMap := decoded["topic"].(map[string]interface{})
	if _, hasHandoff := topicMap["latest_handoff"]; hasHandoff {
		t.Fatalf("expected post --json to omit topic.latest_handoff, got: %s", trimmed)
	}

	// Verify --data - also works when text is passed as positional arg, and unset --as/--node omit fields.
	t.Setenv("AHUB_PROFILE", "")
	code2, out2, errOut2 := captureExecuteFull(t, []string{
		"--json", "board", "post", "proj/demo",
		"--data", "-",
		"inline note text",
	}, `{"secret":"inline_stdin_secret","step":1}`)
	if code2 != api.ExitOK {
		t.Fatalf("expected ExitOK with --data -, got %d out=%s err=%s", code2, out2, errOut2)
	}
	if _, hasProfile := capturedMsgBody["actor_profile"]; hasProfile {
		t.Fatalf("expected unset actor_profile omitted from request JSON, got %+v", capturedMsgBody)
	}
	if _, hasNode := capturedMsgBody["source_node"]; hasNode {
		t.Fatalf("expected unset source_node omitted from request JSON, got %+v", capturedMsgBody)
	}
	if strings.Contains(out2, "inline_stdin_secret") {
		t.Fatalf("expected --data - secret redacted, got %s", out2)
	}
}

func TestBoardReadAllModesPreservesLatestHandoffAndActorAttribution(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/board/channels":
			_ = json.NewEncoder(w).Encode(api.BoardChannelsResponse{
				OK: true,
				Channels: []api.BoardChannelSummary{
					{Channel: "proj/demo", ActiveTopicCount: 2, OpenQuestionCount: 1},
				},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/board/topics":
			top := sampleTopic("top_01READ", "proj/demo", "blocked", true)
			_ = json.NewEncoder(w).Encode(api.BoardTopicsResponse{
				OK:     true,
				Topics: []api.BoardTopic{top},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/board/topics/top_01READ/messages":
			msg := sampleMessage("msg_01READ", "top_01READ", "proj/demo", "handoff", 1)
			msg.ActorScope = "admin"
			msg.ActorProfile = "reviewer-x"
			msg.SourceNode = "mbp"
			_ = json.NewEncoder(w).Encode(api.BoardMessagesResponse{
				OK:       true,
				Topic:    sampleTopic("top_01READ", "proj/demo", "blocked", true),
				Messages: []api.BoardMessage{msg},
				Cursor:   12,
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/board/events":
			msgID := "msg_01READ"
			_ = json.NewEncoder(w).Encode(api.BoardEventsResponse{
				OK: true,
				Events: []api.BoardEvent{
					{Cursor: 11, Channel: "proj/demo", TopicID: "top_01READ", MessageID: &msgID, EventType: "message.posted", ActorProfile: "worker-a", CreatedAt: "2026-11-22T00:01:00Z"},
				},
				NextCursor: 11,
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	t.Setenv("AHUB_CONFIG_DIR", t.TempDir())
	t.Setenv("AHUB_URL", srv.URL)
	t.Setenv("AHUB_TOKEN", "ahub_cli_caller_tok")

	// Mode 1: channels
	code1, out1, _ := captureExecuteFull(t, []string{"--json", "board", "read"}, "")
	if code1 != api.ExitOK || !strings.Contains(out1, `"channels"`) {
		t.Fatalf("read channels failed: code=%d out=%s", code1, out1)
	}

	// Mode 2: topics in channel
	code2, out2, _ := captureExecuteFull(t, []string{"--json", "board", "read", "proj/demo", "--status", "blocked"}, "")
	if code2 != api.ExitOK || !strings.Contains(out2, `"latest_handoff"`) {
		t.Fatalf("read topics failed or dropped latest_handoff: code=%d out=%s", code2, out2)
	}

	// Mode 3: messages by --ref (preserves latest_handoff + actor_scope/actor_profile/source_node)
	code3, out3, _ := captureExecuteFull(t, []string{"--json", "board", "read", "proj/demo", "--ref", "pr#42"}, "")
	if code3 != api.ExitOK {
		t.Fatalf("read --ref failed: code=%d out=%s", code3, out3)
	}
	var msgsOut api.BoardMessagesResponse
	if err := json.Unmarshal([]byte(strings.TrimSpace(out3)), &msgsOut); err != nil {
		t.Fatalf("decode read --ref json: %v", err)
	}
	if msgsOut.Topic.LatestHandoff == nil || msgsOut.Topic.LatestHandoff.ID != "msg_01HANDOFF" {
		t.Fatalf("expected latest_handoff preserved on read --json, got %+v", msgsOut.Topic.LatestHandoff)
	}
	if len(msgsOut.Messages) != 1 || msgsOut.Messages[0].ActorScope != "admin" || msgsOut.Messages[0].ActorProfile != "reviewer-x" || msgsOut.Messages[0].SourceNode != "mbp" {
		t.Fatalf("expected full actor attribution preserved, got %+v", msgsOut.Messages)
	}

	// Mode 4: --after events
	code4, out4, _ := captureExecuteFull(t, []string{"--json", "board", "read", "proj/demo", "--after", "10", "--limit", "20"}, "")
	if code4 != api.ExitOK || !strings.Contains(out4, `"next_cursor":11`) {
		t.Fatalf("read --after events failed: code=%d out=%s", code4, out4)
	}
}

func TestBoardAskTimeoutExit24NoCancelAndErrorNext(t *testing.T) {
	var cancelOrPatchCalled atomic.Int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch || r.Method == http.MethodDelete || strings.Contains(r.URL.Path, "cancel") {
			cancelOrPatchCalled.Add(1)
			http.Error(w, "unexpected cancel/patch", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/board/topics":
			_ = json.NewEncoder(w).Encode(api.BoardTopicResponse{
				OK:    true,
				Topic: sampleTopic("top_01ASK", "proj/demo", "todo", true),
			})
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/board/topics/top_01ASK/messages":
			msg := sampleMessage("msg_01Q", "top_01ASK", "proj/demo", "question", 1)
			msg.QuestionState = "open"
			msg.QuestionOptions = []string{"opt-a", "opt-b"}
			_ = json.NewEncoder(w).Encode(api.BoardMessagePostResponse{
				OK:      true,
				Topic:   sampleTopic("top_01ASK", "proj/demo", "blocked", true),
				Message: msg,
				Cursor:  20,
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/board/topics/top_01ASK/messages":
			msg := sampleMessage("msg_01Q", "top_01ASK", "proj/demo", "question", 1)
			msg.QuestionState = "open"
			_ = json.NewEncoder(w).Encode(api.BoardMessagesResponse{
				OK:       true,
				Topic:    sampleTopic("top_01ASK", "proj/demo", "blocked", true),
				Messages: []api.BoardMessage{msg},
				Cursor:   20,
			})
		case r.URL.Path == "/ws/stream":
			c, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer c.CloseNow()
			snap, _ := json.Marshal(map[string]interface{}{
				"type":  "snapshot",
				"nodes": []interface{}{},
				"topic": sampleTopic("top_01ASK", "proj/demo", "blocked", true),
				"ts":    "2026-11-22T00:01:00Z",
			})
			_ = c.Write(context.Background(), websocket.MessageText, snap)
			<-r.Context().Done()
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	t.Setenv("AHUB_CONFIG_DIR", t.TempDir())
	t.Setenv("AHUB_URL", srv.URL)
	t.Setenv("AHUB_TOKEN", "ahub_cli_caller_tok")

	code, out, _ := captureExecuteFull(t, []string{
		"--json", "board", "ask", "proj/demo",
		"--option", "opt-a",
		"--option", "opt-b",
		"--wait", "150ms",
		"Which option?",
	}, "")
	if code != api.ExitWaitTimeout {
		t.Fatalf("expected ExitWaitTimeout (24), got %d out=%s", code, out)
	}
	if cancelOrPatchCalled.Load() != 0 {
		t.Fatalf("expected ZERO cancel/patch requests on timeout, got %d", cancelOrPatchCalled.Load())
	}
	var res api.BoardWaitTimeoutResult
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &res); err != nil {
		t.Fatalf("decode timeout json: %v (%s)", err, out)
	}
	if !res.TimedOut || res.TopicID != "top_01ASK" || res.MessageID != "msg_01Q" || res.Cursor != 20 || res.QuestionState != "open" {
		t.Fatalf("unexpected timeout JSON: %+v", res)
	}
	if res.Topic != nil && res.Topic.LatestHandoff != nil {
		t.Fatalf("expected wait timeout JSON to omit topic.latest_handoff")
	}
}

func TestBoardWaitWSDisconnectReconnectAfterCursorRecoversMidDisconnectAnswer(t *testing.T) {
	origDelay := boardWSReconnectDelay
	boardWSReconnectDelay = 20 * time.Millisecond
	defer func() { boardWSReconnectDelay = origDelay }()

	var seenAfterCursors []string
	var wsAttempt atomic.Int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/board/topics/top_01REC/messages":
			w.Header().Set("Content-Type", "application/json")
			q := sampleMessage("msg_01QREC", "top_01REC", "proj/demo", "question", 1)
			q.QuestionState = "open"
			_ = json.NewEncoder(w).Encode(api.BoardMessagesResponse{
				OK:       true,
				Topic:    sampleTopic("top_01REC", "proj/demo", "blocked", true),
				Messages: []api.BoardMessage{q},
				Cursor:   10,
			})
		case "/ws/stream":
			attempt := wsAttempt.Add(1)
			seenAfterCursors = append(seenAfterCursors, r.URL.Query().Get("after_cursor"))
			c, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer c.CloseNow()

			if attempt == 1 {
				// Server sends snapshot whose topic.last_event_cursor is ALREADY higher (15),
				// then drops connection before sending any board.* event frame.
				// Client MUST NOT advance highestCursor from snapshot.
				snapTop := sampleTopic("top_01REC", "proj/demo", "blocked", true)
				snapTop.LastEventCursor = 15
				snap, _ := json.Marshal(map[string]interface{}{
					"type":  "snapshot",
					"nodes": []interface{}{},
					"topic": snapTop,
					"ts":    "2026-11-22T00:02:00Z",
				})
				_ = c.Write(context.Background(), websocket.MessageText, snap)
				_ = c.Close(websocket.StatusGoingAway, "simulate drop")
				return
			}

			// Second connection must reconnect with after_cursor=10 (NOT 15) and receive replayed answer.
			q := sampleMessage("msg_01QREC", "top_01REC", "proj/demo", "question", 1)
			q.QuestionState = "answered"
			ansID := "msg_01AREC"
			q.AnsweredMessageID = &ansID
			a := sampleMessage("msg_01AREC", "top_01REC", "proj/demo", "answer", 2)
			a.ActorScope = "admin"
			a.TextMD = "Proceed with option A"
			topDone := sampleTopic("top_01REC", "proj/demo", "in_progress", true)
			topDone.LastEventCursor = 15
			frame, _ := json.Marshal(map[string]interface{}{
				"type":     "board.question_answered",
				"question": q,
				"answer":   a,
				"topic":    topDone,
				"cursor":   15,
			})
			_ = c.Write(context.Background(), websocket.MessageText, frame)
			<-r.Context().Done()
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	t.Setenv("AHUB_CONFIG_DIR", t.TempDir())
	t.Setenv("AHUB_URL", srv.URL)
	t.Setenv("AHUB_TOKEN", "ahub_cli_caller_tok")

	code, out, errOut := captureExecuteFull(t, []string{
		"--json", "board", "wait", "proj/demo",
		"--topic", "top_01REC",
		"--message", "msg_01QREC",
		"--timeout", "3s",
	}, "")
	if code != api.ExitOK {
		t.Fatalf("expected ExitOK after reconnect, got %d out=%s err=%s", code, out, errOut)
	}
	if len(seenAfterCursors) < 2 || seenAfterCursors[0] != "10" || seenAfterCursors[1] != "10" {
		t.Fatalf("expected reconnect to preserve after_cursor=10 (never snapshot cursor 15), got %v", seenAfterCursors)
	}
	if !strings.Contains(errOut, "reconnecting after cursor 10") {
		t.Fatalf("expected reconnect diagnostic on stderr, got %q", errOut)
	}
	var ansResp api.AnswerBoardQuestionResponse
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &ansResp); err != nil {
		t.Fatalf("invalid answer JSON: %v (%s)", err, out)
	}
	if ansResp.Answer.ID != "msg_01AREC" || ansResp.Topic.LatestHandoff != nil {
		t.Fatalf("unexpected answer response (latest_handoff must be omitted): %+v", ansResp)
	}
}

func TestBoardCredentialIsolationNeverReadsNodeJSONAndErrorNextRendering(t *testing.T) {
	var seenAuthHeaders []string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuthHeaders = append(seenAuthHeaders, r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/ws/stream" || r.URL.Path == "/api/v1/board/channels" {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"ok":false,"error":{"code":"FORBIDDEN_SCOPE","message":"board prefix not authorized","next":["ahub board read proj/public --json","ahub auth status --verify"]}}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	cfgDir := t.TempDir()
	// Populate ONLY node.json with ahub_nod_* secret; NO credentials file and NO AHUB_TOKEN.
	nodeCfg := `{"node_id":"macmini","hub_url":"` + srv.URL + `","token":"ahub_nod_forbidden_daemon_secret_999"}`
	if err := os.WriteFile(filepath.Join(cfgDir, "node.json"), []byte(nodeCfg), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("AHUB_CONFIG_DIR", cfgDir)
	t.Setenv("AHUB_URL", srv.URL)
	t.Setenv("AHUB_TOKEN", "")

	codeISO, outISO, errISO := captureExecuteFull(t, []string{"--json", "board", "read"}, "")
	if codeISO != api.ExitPolicyDenied {
		t.Fatalf("expected ExitPolicyDenied (78), got %d out=%s err=%s", codeISO, outISO, errISO)
	}
	if len(seenAuthHeaders) != 0 {
		t.Fatalf("SECURITY VIOLATION: ahub board contacted server without caller credentials (seen=%v)", seenAuthHeaders)
	}
	var unauthEnv api.ErrorEnvelope
	if err := json.Unmarshal([]byte(strings.TrimSpace(outISO)), &unauthEnv); err != nil {
		t.Fatalf("decode UNAUTHORIZED ErrorEnvelope: %v (%s)", err, outISO)
	}
	if unauthEnv.Error.Code != "UNAUTHORIZED" || len(unauthEnv.Error.Next) == 0 {
		t.Fatalf("expected UNAUTHORIZED with error.next, got %+v", unauthEnv.Error)
	}

	// Verify server error.next in --json ErrorEnvelope when a limited caller token hits 403
	t.Setenv("AHUB_TOKEN", "ahub_cli_limited")
	code403, out403, err403 := captureExecuteFull(t, []string{"--json", "board", "read"}, "")
	if code403 != api.ExitPolicyDenied {
		t.Fatalf("expected ExitPolicyDenied (78) on 403, got %d out=%s err=%s", code403, out403, err403)
	}
	var env api.ErrorEnvelope
	if err := json.Unmarshal([]byte(strings.TrimSpace(out403)), &env); err != nil {
		t.Fatalf("decode ErrorEnvelope: %v (%s)", err, out403)
	}
	if len(env.Error.Next) != 2 || env.Error.Next[0] != "ahub board read proj/public --json" {
		t.Fatalf("expected error.next in ErrorEnvelope, got %+v", env.Error.Next)
	}

	// Verify error.next rendered as Next: on stderr in human mode (including WS 403 rejection)
	codeWS, outWS, errWS := captureExecuteFull(t, []string{"board", "wait", "--topic", "top_01WS", "--after", "5"}, "")
	if codeWS != api.ExitPolicyDenied {
		t.Fatalf("expected ExitPolicyDenied (78) on WS 403, got %d out=%s err=%s", codeWS, outWS, errWS)
	}
	if strings.TrimSpace(outWS) != "" {
		t.Fatalf("expected empty stdout in human error mode, got %q", outWS)
	}
	if !strings.Contains(errWS, "Next: ahub board read proj/public --json") || !strings.Contains(errWS, "Next: ahub auth status --verify") {
		t.Fatalf("expected Next: lines on stderr, got:\n%s", errWS)
	}
}

func TestBoardAskAnsweredOverWSAndPreRedactsOptions(t *testing.T) {
	var capturedMsgReq map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/board/topics":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(api.BoardTopicResponse{
				OK:    true,
				Topic: sampleTopic("top_01ASKOK", "proj/demo", "todo", true),
			})
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/board/topics/top_01ASKOK/messages":
			capturedMsgReq = nil
			_ = json.NewDecoder(r.Body).Decode(&capturedMsgReq)
			w.Header().Set("Content-Type", "application/json")
			q := sampleMessage("msg_01QOK", "top_01ASKOK", "proj/demo", "question", 1)
			q.QuestionState = "open"
			_ = json.NewEncoder(w).Encode(api.BoardMessagePostResponse{
				OK:      true,
				Topic:   sampleTopic("top_01ASKOK", "proj/demo", "blocked", true),
				Message: q,
				Cursor:  30,
			})
		case r.URL.Path == "/ws/stream":
			c, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer c.CloseNow()
			q := sampleMessage("msg_01QOK", "top_01ASKOK", "proj/demo", "question", 1)
			q.QuestionState = "answered"
			ansID := "msg_01AOK"
			q.AnsweredMessageID = &ansID
			a := sampleMessage("msg_01AOK", "top_01ASKOK", "proj/demo", "answer", 2)
			a.ActorScope = "admin"
			a.TextMD = "Approved with opt-1"
			frame, _ := json.Marshal(map[string]interface{}{
				"type":     "board.question_answered",
				"question": q,
				"answer":   a,
				"topic":    sampleTopic("top_01ASKOK", "proj/demo", "todo", true),
				"cursor":   31,
			})
			_ = c.Write(context.Background(), websocket.MessageText, frame)
			<-r.Context().Done()
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	t.Setenv("AHUB_CONFIG_DIR", t.TempDir())
	t.Setenv("AHUB_URL", srv.URL)
	t.Setenv("AHUB_TOKEN", "ahub_cli_caller_tok")

	code, out, errOut := captureExecuteFull(t, []string{
		"--json", "board", "ask", "proj/demo",
		"--option", "use token=opt_secret_1",
		"--expires", "1h",
		"--wait", "3s",
		"-",
	}, "Proceed with ahub_cli_qsecret_99?\n")
	if code != api.ExitOK {
		t.Fatalf("expected ExitOK, got %d out=%s err=%s", code, out, errOut)
	}
	if rawReq, _ := json.Marshal(capturedMsgReq); strings.Contains(string(rawReq), "opt_secret_1") || strings.Contains(string(rawReq), "qsecret_99") {
		t.Fatalf("expected question text and options pre-redacted before POST, got: %s", string(rawReq))
	}
	var ansResp api.AnswerBoardQuestionResponse
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &ansResp); err != nil {
		t.Fatalf("decode ask answer JSON: %v (%s)", err, out)
	}
	if ansResp.Answer.TextMD != "Approved with opt-1" || ansResp.Topic.LatestHandoff != nil {
		t.Fatalf("unexpected ask answer response: %+v", ansResp)
	}
}

func TestBoardValidationErrorsExit64(t *testing.T) {
	t.Setenv("AHUB_CONFIG_DIR", t.TempDir())
	t.Setenv("AHUB_TOKEN", "ahub_cli_test")

	tmpDir := t.TempDir()
	bigDataFile := filepath.Join(tmpDir, "big.json")
	if err := os.WriteFile(bigDataFile, []byte(`{"blob":"`+strings.Repeat("a", 33000)+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	cases := [][]string{
		{"board"},
		{"board", "unknown"},
		{"board", "post", "BadChannel", "hello"},
		{"board", "post", "proj//demo", "hello"},
		{"board", "post", "proj/demo", "--kind", "answer", "hello"},
		{"board", "post", "proj/demo", "--as", "InvalidProfile!", "hello"},
		{"board", "post", "proj/demo", "--node", "Bad Node!", "hello"},
		{"board", "post", "proj/demo", "--data", `["not","an","object"]`, "hello"},
		{"board", "post", "proj/demo", "--data", "@" + bigDataFile, "hello"},
		{"board", "post", "proj/demo", "--topic", "top_1", "--ref", "pr#1", "hello"},
		{"board", "post", "proj/demo", "--data", "-", "-"},
		{"board", "read", "--topic", "top_1", "--ref", "pr#1"},
		{"board", "ask", "proj/demo", "--expires", "5m", "too short"},
		{"board", "ask", "proj/demo", "--expires", "80h", "too long"},
		{"board", "ask", "proj/demo", "--wait", "5m", "--no-wait", "conflict"},
		{"board", "ask", "proj/demo", "--option", "1", "--option", "2", "--option", "3", "--option", "4", "--option", "5", "--option", "6", "--option", "7", "--option", "8", "--option", "9", "too many options"},
		{"board", "wait"},
		{"board", "wait", "--topic", "top_1", "--timeout", "0s"},
	}

	for _, args := range cases {
		code, _, _ := captureExecuteFull(t, args, "{}")
		if code != api.ExitBadUsageOrInput {
			t.Fatalf("expected exit 64 for %v, got %d", args, code)
		}
	}

	// Invalid AHUB_PROFILE env var also returns exit 64
	t.Setenv("AHUB_PROFILE", "BadEnvProfile!")
	codeEnv, _, _ := captureExecuteFull(t, []string{"board", "post", "proj/demo", "hello"}, "")
	if codeEnv != api.ExitBadUsageOrInput {
		t.Fatalf("expected exit 64 for invalid AHUB_PROFILE, got %d", codeEnv)
	}
}

func TestBoardWaitPaginatesBeyond50And200Messages(t *testing.T) {
	var seenQueries []string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/board/topics/top_01PAGE/messages" {
			http.NotFound(w, r)
			return
		}
		seenQueries = append(seenQueries, r.URL.RawQuery)
		afterSeq, _ := strconv.Atoi(r.URL.Query().Get("after_seq"))
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if limit != boardMessagesPageLimit {
			http.Error(w, fmt.Sprintf("expected limit=%d, got %d", boardMessagesPageLimit, limit), http.StatusBadRequest)
			return
		}

		all := make([]api.BoardMessage, 0, 205)
		for seq := 1; seq <= 203; seq++ {
			all = append(all, sampleMessage(fmt.Sprintf("msg_%03d", seq), "top_01PAGE", "proj/demo", "note", seq))
		}
		q := sampleMessage("msg_204", "top_01PAGE", "proj/demo", "question", 204)
		q.QuestionState = "answered"
		ansID := "msg_205"
		q.AnsweredMessageID = &ansID
		a := sampleMessage("msg_205", "top_01PAGE", "proj/demo", "answer", 205)
		a.ActorScope = "admin"
		a.TextMD = "Paginated answer ok"
		all = append(all, q, a)

		var page []api.BoardMessage
		for _, m := range all {
			if m.Seq > afterSeq {
				page = append(page, m)
				if len(page) == limit {
					break
				}
			}
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(api.BoardMessagesResponse{
			OK:       true,
			Topic:    sampleTopic("top_01PAGE", "proj/demo", "todo", false),
			Messages: page,
			Cursor:   300,
		})
	}))
	defer srv.Close()

	t.Setenv("AHUB_CONFIG_DIR", t.TempDir())
	t.Setenv("AHUB_URL", srv.URL)
	t.Setenv("AHUB_TOKEN", "ahub_cli_caller_tok")

	code, out, errOut := captureExecuteFull(t, []string{
		"--json", "board", "wait", "--topic", "top_01PAGE", "--message", "msg_204", "--timeout", "1s",
	}, "")
	if code != api.ExitOK {
		t.Fatalf("expected ExitOK finding paginated answer, got %d out=%s err=%s", code, out, errOut)
	}
	if len(seenQueries) != 2 {
		t.Fatalf("expected 2 paginated requests, got %d (%v)", len(seenQueries), seenQueries)
	}
	if !strings.Contains(seenQueries[1], "after_seq=200") {
		t.Fatalf("expected second page query to advance after_seq=200, got %q", seenQueries[1])
	}
	var ansResp api.AnswerBoardQuestionResponse
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &ansResp); err != nil {
		t.Fatalf("decode paginated answer JSON: %v (%s)", err, out)
	}
	if ansResp.Answer.ID != "msg_205" || ansResp.Answer.TextMD != "Paginated answer ok" {
		t.Fatalf("unexpected answer payload: %+v", ansResp)
	}
}

func intPtr(v int) *int {
	return &v
}

func TestBoardWaitWakesImmediatelyOnWSExpiredOrCancelled(t *testing.T) {
	for _, state := range []string{"expired", "cancelled"} {
		for _, withMsgFlag := range []bool{true, false} {
			name := fmt.Sprintf("state=%s/withMessage=%v", state, withMsgFlag)
			t.Run(name, func(t *testing.T) {
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					switch r.URL.Path {
					case "/api/v1/board/topics/top_01EXPWS/messages":
						w.Header().Set("Content-Type", "application/json")
						q := sampleMessage("msg_01QEXP", "top_01EXPWS", "proj/demo", "question", 1)
						q.QuestionState = "open"
						top := sampleTopic("top_01EXPWS", "proj/demo", "blocked", false)
						top.OpenQuestionCount = intPtr(1)
						_ = json.NewEncoder(w).Encode(api.BoardMessagesResponse{
							OK:       true,
							Topic:    top,
							Messages: []api.BoardMessage{q},
							Cursor:   5,
						})
					case "/ws/stream":
						c, err := websocket.Accept(w, r, nil)
						if err != nil {
							return
						}
						defer c.CloseNow()

						snapTop := sampleTopic("top_01EXPWS", "proj/demo", "blocked", false)
						snapTop.OpenQuestionCount = intPtr(1)
						snap, _ := json.Marshal(map[string]interface{}{
							"type":  "snapshot",
							"nodes": []interface{}{},
							"topic": snapTop,
							"ts":    "2026-11-22T00:00:00Z",
						})
						_ = c.Write(context.Background(), websocket.MessageText, snap)

						time.Sleep(40 * time.Millisecond)
						closedTop := sampleTopic("top_01EXPWS", "proj/demo", "todo", false)
						closedTop.OpenQuestionCount = intPtr(0)
						closedMsg := sampleMessage("msg_01QEXP", "top_01EXPWS", "proj/demo", "question", 1)
						closedMsg.QuestionState = state
						frame, _ := json.Marshal(map[string]interface{}{
							"type":    "board.message_created",
							"message": closedMsg,
							"topic":   closedTop,
							"cursor":  6,
						})
						_ = c.Write(context.Background(), websocket.MessageText, frame)
						<-r.Context().Done()
					default:
						http.NotFound(w, r)
					}
				}))
				defer srv.Close()

				t.Setenv("AHUB_CONFIG_DIR", t.TempDir())
				t.Setenv("AHUB_URL", srv.URL)
				t.Setenv("AHUB_TOKEN", "ahub_cli_caller_tok")

				args := []string{"--json", "board", "wait", "proj/demo", "--topic", "top_01EXPWS", "--timeout", "3s"}
				if withMsgFlag {
					args = append(args, "--message", "msg_01QEXP")
				}
				start := time.Now()
				code, out, errOut := captureExecuteFull(t, args, "")
				elapsed := time.Since(start)

				if code != api.ExitBadUsageOrInput {
					t.Fatalf("expected ExitBadUsageOrInput (64), got %d elapsed=%v out=%s err=%s", code, elapsed, out, errOut)
				}
				if elapsed >= 500*time.Millisecond {
					t.Fatalf("expected fast wake (<500ms) on WS %s frame, took %v", state, elapsed)
				}
				var env api.ErrorEnvelope
				if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &env); err != nil {
					t.Fatalf("decode error JSON: %v (%s)", err, out)
				}
				if env.OK || env.Error.Code != "INVALID_STATE_TRANSITION" || !strings.Contains(env.Error.Message, state) {
					t.Fatalf("expected INVALID_STATE_TRANSITION for %s, got %+v", state, env)
				}
			})
		}
	}
}

func TestBoardWaitFailsFastOnAlreadyExpiredQuestionWithoutMessageFlag(t *testing.T) {
	for _, withAfter := range []bool{false, true} {
		name := fmt.Sprintf("withAfter=%v", withAfter)
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/v1/board/topics/top_01ALREADY/messages":
					w.Header().Set("Content-Type", "application/json")
					q := sampleMessage("msg_01ALR", "top_01ALREADY", "proj/demo", "question", 1)
					q.QuestionState = "expired"
					top := sampleTopic("top_01ALREADY", "proj/demo", "todo", false)
					top.OpenQuestionCount = intPtr(0)
					_ = json.NewEncoder(w).Encode(api.BoardMessagesResponse{
						OK:       true,
						Topic:    top,
						Messages: []api.BoardMessage{q},
						Cursor:   8,
					})
				case "/ws/stream":
					c, err := websocket.Accept(w, r, nil)
					if err != nil {
						return
					}
					defer c.CloseNow()
					snapTop := sampleTopic("top_01ALREADY", "proj/demo", "todo", false)
					snapTop.OpenQuestionCount = intPtr(0)
					snap, _ := json.Marshal(map[string]interface{}{
						"type":  "snapshot",
						"nodes": []interface{}{},
						"topic": snapTop,
						"ts":    "2026-11-22T00:00:00Z",
					})
					_ = c.Write(context.Background(), websocket.MessageText, snap)
					<-r.Context().Done()
				default:
					http.NotFound(w, r)
				}
			}))
			defer srv.Close()

			t.Setenv("AHUB_CONFIG_DIR", t.TempDir())
			t.Setenv("AHUB_URL", srv.URL)
			t.Setenv("AHUB_TOKEN", "ahub_cli_caller_tok")

			args := []string{"--json", "board", "wait", "proj/demo", "--topic", "top_01ALREADY", "--timeout", "2s"}
			if withAfter {
				args = append(args, "--after", "8")
			}
			start := time.Now()
			code, out, errOut := captureExecuteFull(t, args, "")
			elapsed := time.Since(start)

			if code != api.ExitBadUsageOrInput {
				t.Fatalf("expected ExitBadUsageOrInput (64), never exit 24; got %d elapsed=%v out=%s err=%s", code, elapsed, out, errOut)
			}
			if elapsed >= 500*time.Millisecond {
				t.Fatalf("expected fail-fast (<500ms), took %v", elapsed)
			}
			var env api.ErrorEnvelope
			if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &env); err != nil {
				t.Fatalf("decode error JSON: %v (%s)", err, out)
			}
			if env.OK || env.Error.Code != "INVALID_STATE_TRANSITION" || !strings.Contains(env.Error.Message, "expired") {
				t.Fatalf("expected INVALID_STATE_TRANSITION expired error, got %+v", env)
			}
		})
	}
}

func TestBoardWaitWakesOnTopicUpdatedZeroOpenAndIgnoresOtherQuestionExpiry(t *testing.T) {
	t.Run("topic_updated_zero_open_resolves_expired_fast", func(t *testing.T) {
		var expired atomic.Bool
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/v1/board/topics/top_01TOPUPD/messages":
				w.Header().Set("Content-Type", "application/json")
				q := sampleMessage("msg_01TU", "top_01TOPUPD", "proj/demo", "question", 1)
				top := sampleTopic("top_01TOPUPD", "proj/demo", "blocked", false)
				if expired.Load() {
					q.QuestionState = "expired"
					top.Status = "todo"
					top.OpenQuestionCount = intPtr(0)
				} else {
					q.QuestionState = "open"
					top.OpenQuestionCount = intPtr(1)
				}
				_ = json.NewEncoder(w).Encode(api.BoardMessagesResponse{
					OK:       true,
					Topic:    top,
					Messages: []api.BoardMessage{q},
					Cursor:   10,
				})
			case "/ws/stream":
				c, err := websocket.Accept(w, r, nil)
				if err != nil {
					return
				}
				defer c.CloseNow()
				snapTop := sampleTopic("top_01TOPUPD", "proj/demo", "blocked", false)
				snapTop.OpenQuestionCount = intPtr(1)
				snap, _ := json.Marshal(map[string]interface{}{
					"type":  "snapshot",
					"nodes": []interface{}{},
					"topic": snapTop,
					"ts":    "2026-11-22T00:00:00Z",
				})
				_ = c.Write(context.Background(), websocket.MessageText, snap)

				time.Sleep(40 * time.Millisecond)
				expired.Store(true)
				updTop := sampleTopic("top_01TOPUPD", "proj/demo", "todo", false)
				updTop.OpenQuestionCount = intPtr(0)
				frame, _ := json.Marshal(map[string]interface{}{
					"type":   "board.topic_updated",
					"topic":  updTop,
					"cursor": 11,
				})
				_ = c.Write(context.Background(), websocket.MessageText, frame)
				<-r.Context().Done()
			default:
				http.NotFound(w, r)
			}
		}))
		defer srv.Close()

		t.Setenv("AHUB_CONFIG_DIR", t.TempDir())
		t.Setenv("AHUB_URL", srv.URL)
		t.Setenv("AHUB_TOKEN", "ahub_cli_caller_tok")

		start := time.Now()
		code, out, errOut := captureExecuteFull(t, []string{
			"--json", "board", "wait", "proj/demo", "--topic", "top_01TOPUPD", "--timeout", "3s",
		}, "")
		elapsed := time.Since(start)
		if code != api.ExitBadUsageOrInput || elapsed >= 500*time.Millisecond {
			t.Fatalf("expected fast exit 64, got code=%d elapsed=%v out=%s err=%s", code, elapsed, out, errOut)
		}
	})

	t.Run("other_question_expiry_does_not_abort_open_target_question", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/v1/board/topics/top_01MULTI/messages":
				w.Header().Set("Content-Type", "application/json")
				q1 := sampleMessage("msg_Q1", "top_01MULTI", "proj/demo", "question", 1)
				q1.QuestionState = "open"
				q2 := sampleMessage("msg_Q2", "top_01MULTI", "proj/demo", "question", 2)
				q2.QuestionState = "open"
				top := sampleTopic("top_01MULTI", "proj/demo", "blocked", false)
				top.OpenQuestionCount = intPtr(2)
				_ = json.NewEncoder(w).Encode(api.BoardMessagesResponse{
					OK:       true,
					Topic:    top,
					Messages: []api.BoardMessage{q1, q2},
					Cursor:   10,
				})
			case "/ws/stream":
				c, err := websocket.Accept(w, r, nil)
				if err != nil {
					return
				}
				defer c.CloseNow()
				snapTop := sampleTopic("top_01MULTI", "proj/demo", "blocked", false)
				snapTop.OpenQuestionCount = intPtr(2)
				snap, _ := json.Marshal(map[string]interface{}{
					"type":  "snapshot",
					"nodes": []interface{}{},
					"topic": snapTop,
					"ts":    "2026-11-22T00:00:00Z",
				})
				_ = c.Write(context.Background(), websocket.MessageText, snap)

				// Expire q2 while q1 stays open (open_question_count=1)
				otherExp := sampleMessage("msg_Q2", "top_01MULTI", "proj/demo", "question", 2)
				otherExp.QuestionState = "expired"
				stillOpenTop := sampleTopic("top_01MULTI", "proj/demo", "blocked", false)
				stillOpenTop.OpenQuestionCount = intPtr(1)
				expFrame, _ := json.Marshal(map[string]interface{}{
					"type":    "board.message_created",
					"message": otherExp,
					"topic":   stillOpenTop,
					"cursor":  11,
				})
				_ = c.Write(context.Background(), websocket.MessageText, expFrame)

				// Then answer q1
				time.Sleep(40 * time.Millisecond)
				q1Done := sampleMessage("msg_Q1", "top_01MULTI", "proj/demo", "question", 1)
				q1Done.QuestionState = "answered"
				ansID := "msg_A1"
				q1Done.AnsweredMessageID = &ansID
				a1 := sampleMessage("msg_A1", "top_01MULTI", "proj/demo", "answer", 3)
				a1.ActorScope = "admin"
				a1.TextMD = "Q1 answered"
				doneTop := sampleTopic("top_01MULTI", "proj/demo", "todo", false)
				doneTop.OpenQuestionCount = intPtr(0)
				ansFrame, _ := json.Marshal(map[string]interface{}{
					"type":     "board.question_answered",
					"question": q1Done,
					"answer":   a1,
					"topic":    doneTop,
					"cursor":   12,
				})
				_ = c.Write(context.Background(), websocket.MessageText, ansFrame)
				<-r.Context().Done()
			default:
				http.NotFound(w, r)
			}
		}))
		defer srv.Close()

		t.Setenv("AHUB_CONFIG_DIR", t.TempDir())
		t.Setenv("AHUB_URL", srv.URL)
		t.Setenv("AHUB_TOKEN", "ahub_cli_caller_tok")

		code, out, errOut := captureExecuteFull(t, []string{
			"--json", "board", "wait", "proj/demo", "--topic", "top_01MULTI", "--message", "msg_Q1", "--timeout", "2s",
		}, "")
		if code != api.ExitOK {
			t.Fatalf("expected ExitOK when unrelated q2 expired and q1 answered, got %d out=%s err=%s", code, out, errOut)
		}
		var ansResp api.AnswerBoardQuestionResponse
		if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &ansResp); err != nil {
			t.Fatalf("decode answer JSON: %v (%s)", err, out)
		}
		if ansResp.Answer.ID != "msg_A1" {
			t.Fatalf("unexpected answer: %+v", ansResp)
		}
	})
}

func TestBoardWaitAfterReplayTracksLatestOpenQuestionAndOptionalTopic(t *testing.T) {
	t.Run("case_d2_after_replay_expired_then_open_reports_open_question_on_timeout", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/v1/board/topics/top_D2/messages":
				w.Header().Set("Content-Type", "application/json")
				qOld := sampleMessage("msg_Q_OLD", "top_D2", "proj/demo", "question", 1)
				qOld.QuestionState = "expired"
				qNew := sampleMessage("msg_Q_NEW", "top_D2", "proj/demo", "question", 2)
				qNew.QuestionState = "open"
				top := sampleTopic("top_D2", "proj/demo", "blocked", false)
				top.OpenQuestionCount = intPtr(1)
				_ = json.NewEncoder(w).Encode(api.BoardMessagesResponse{
					OK:       true,
					Topic:    top,
					Messages: []api.BoardMessage{qOld, qNew},
					Cursor:   5,
				})
			case "/ws/stream":
				c, err := websocket.Accept(w, r, nil)
				if err != nil {
					return
				}
				defer c.CloseNow()

				top := sampleTopic("top_D2", "proj/demo", "blocked", false)
				top.OpenQuestionCount = intPtr(1)

				snap, _ := json.Marshal(map[string]interface{}{
					"type":  "snapshot",
					"nodes": []interface{}{},
					"topic": top,
					"ts":    "2026-11-22T00:00:00Z",
				})
				_ = c.Write(context.Background(), websocket.MessageText, snap)

				qOld := sampleMessage("msg_Q_OLD", "top_D2", "proj/demo", "question", 1)
				qOld.QuestionState = "expired"
				fOld, _ := json.Marshal(map[string]interface{}{
					"type":    "board.message_created",
					"message": qOld,
					"topic":   top,
					"cursor":  3,
				})
				_ = c.Write(context.Background(), websocket.MessageText, fOld)

				qNew := sampleMessage("msg_Q_NEW", "top_D2", "proj/demo", "question", 2)
				qNew.QuestionState = "open"
				fNew, _ := json.Marshal(map[string]interface{}{
					"type":    "board.message_created",
					"message": qNew,
					"topic":   top,
					"cursor":  4,
				})
				_ = c.Write(context.Background(), websocket.MessageText, fNew)

				<-r.Context().Done()
			default:
				http.NotFound(w, r)
			}
		}))
		defer srv.Close()

		t.Setenv("AHUB_CONFIG_DIR", t.TempDir())
		t.Setenv("AHUB_URL", srv.URL)
		t.Setenv("AHUB_TOKEN", "ahub_cli_caller_tok")

		code, out, errOut := captureExecuteFull(t, []string{
			"--json", "board", "wait", "proj/demo", "--topic", "top_D2", "--after", "0", "--timeout", "200ms",
		}, "")
		if code != api.ExitWaitTimeout {
			t.Fatalf("expected ExitWaitTimeout (24), got %d out=%s err=%s", code, out, errOut)
		}
		var res api.BoardWaitTimeoutResult
		if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &res); err != nil {
			t.Fatalf("decode timeout JSON: %v (%s)", err, out)
		}
		if res.MessageID != "msg_Q_NEW" || res.QuestionState != "open" || !res.TimedOut {
			t.Fatalf("expected MessageID=msg_Q_NEW open on timeout, got %+v", res)
		}
	})

	t.Run("case_d3_optional_topic_omitted_on_expired_message_verifies_open_question_and_keeps_waiting", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/v1/board/topics/top_D3/messages":
				w.Header().Set("Content-Type", "application/json")
				qOld := sampleMessage("msg_Q_OLD", "top_D3", "proj/demo", "question", 1)
				qOld.QuestionState = "expired"
				qNew := sampleMessage("msg_Q_NEW", "top_D3", "proj/demo", "question", 2)
				qNew.QuestionState = "open"
				top := sampleTopic("top_D3", "proj/demo", "blocked", false)
				top.OpenQuestionCount = intPtr(1)
				_ = json.NewEncoder(w).Encode(api.BoardMessagesResponse{
					OK:       true,
					Topic:    top,
					Messages: []api.BoardMessage{qOld, qNew},
					Cursor:   5,
				})
			case "/ws/stream":
				c, err := websocket.Accept(w, r, nil)
				if err != nil {
					return
				}
				defer c.CloseNow()

				top := sampleTopic("top_D3", "proj/demo", "blocked", false)
				top.OpenQuestionCount = intPtr(1)
				snap, _ := json.Marshal(map[string]interface{}{
					"type":  "snapshot",
					"nodes": []interface{}{},
					"topic": top,
					"ts":    "2026-11-22T00:00:00Z",
				})
				_ = c.Write(context.Background(), websocket.MessageText, snap)

				// Schema-valid board.message_created omitting optional "topic"
				qOld := sampleMessage("msg_Q_OLD", "top_D3", "proj/demo", "question", 1)
				qOld.QuestionState = "expired"
				fOld, _ := json.Marshal(map[string]interface{}{
					"type":    "board.message_created",
					"message": qOld,
					"cursor":  3,
				})
				_ = c.Write(context.Background(), websocket.MessageText, fOld)

				qNew := sampleMessage("msg_Q_NEW", "top_D3", "proj/demo", "question", 2)
				qNew.QuestionState = "open"
				fNew, _ := json.Marshal(map[string]interface{}{
					"type":    "board.message_created",
					"message": qNew,
					"cursor":  4,
				})
				_ = c.Write(context.Background(), websocket.MessageText, fNew)

				<-r.Context().Done()
			default:
				http.NotFound(w, r)
			}
		}))
		defer srv.Close()

		t.Setenv("AHUB_CONFIG_DIR", t.TempDir())
		t.Setenv("AHUB_URL", srv.URL)
		t.Setenv("AHUB_TOKEN", "ahub_cli_caller_tok")

		code, out, errOut := captureExecuteFull(t, []string{
			"--json", "board", "wait", "proj/demo", "--topic", "top_D3", "--after", "0", "--timeout", "200ms",
		}, "")
		if code != api.ExitWaitTimeout {
			t.Fatalf("expected ExitWaitTimeout (24) instead of premature 64 when msg_Q_NEW is open, got %d out=%s err=%s", code, out, errOut)
		}
		var res api.BoardWaitTimeoutResult
		if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &res); err != nil {
			t.Fatalf("decode timeout JSON: %v (%s)", err, out)
		}
		if res.MessageID != "msg_Q_NEW" || res.QuestionState != "open" || !res.TimedOut {
			t.Fatalf("expected MessageID=msg_Q_NEW open on timeout, got %+v", res)
		}
	})

	t.Run("case_d3_optional_topic_omitted_aborts_when_no_open_question_remains", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/v1/board/topics/top_D3_CLOSED/messages":
				w.Header().Set("Content-Type", "application/json")
				qOld := sampleMessage("msg_Q_ONLY", "top_D3_CLOSED", "proj/demo", "question", 1)
				qOld.QuestionState = "expired"
				top := sampleTopic("top_D3_CLOSED", "proj/demo", "todo", false)
				top.OpenQuestionCount = intPtr(0)
				_ = json.NewEncoder(w).Encode(api.BoardMessagesResponse{
					OK:       true,
					Topic:    top,
					Messages: []api.BoardMessage{qOld},
					Cursor:   5,
				})
			case "/ws/stream":
				c, err := websocket.Accept(w, r, nil)
				if err != nil {
					return
				}
				defer c.CloseNow()

				qOld := sampleMessage("msg_Q_ONLY", "top_D3_CLOSED", "proj/demo", "question", 1)
				qOld.QuestionState = "expired"
				fOld, _ := json.Marshal(map[string]interface{}{
					"type":    "board.message_created",
					"message": qOld,
					"cursor":  3,
				})
				_ = c.Write(context.Background(), websocket.MessageText, fOld)
				<-r.Context().Done()
			default:
				http.NotFound(w, r)
			}
		}))
		defer srv.Close()

		t.Setenv("AHUB_CONFIG_DIR", t.TempDir())
		t.Setenv("AHUB_URL", srv.URL)
		t.Setenv("AHUB_TOKEN", "ahub_cli_caller_tok")

		code, out, errOut := captureExecuteFull(t, []string{
			"--json", "board", "wait", "proj/demo", "--topic", "top_D3_CLOSED", "--after", "0", "--timeout", "2s",
		}, "")
		if code != api.ExitBadUsageOrInput {
			t.Fatalf("expected ExitBadUsageOrInput (64) when no open question remains, got %d out=%s err=%s", code, out, errOut)
		}
		var env api.ErrorEnvelope
		if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &env); err != nil {
			t.Fatalf("decode error JSON: %v (%s)", err, out)
		}
		if env.OK || env.Error.Code != "INVALID_STATE_TRANSITION" || !strings.Contains(env.Error.Message, "msg_Q_ONLY") {
			t.Fatalf("expected INVALID_STATE_TRANSITION for msg_Q_ONLY, got %+v", env)
		}
	})
}
