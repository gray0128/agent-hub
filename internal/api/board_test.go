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

func TestCreateBoardMessageRequestOmitsUnsetOptionalFields(t *testing.T) {
	raw, err := json.Marshal(CreateBoardMessageRequest{
		Kind:   "note",
		TextMD: "hello board",
	})
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	for _, omitted := range []string{
		"actor_profile",
		"source_node",
		"data",
		"topic_status",
		"question_options",
		"question_expires_sec",
		"idempotency_key",
	} {
		if _, exists := decoded[omitted]; exists {
			t.Fatalf("expected %q omitted when unset, got JSON: %s", omitted, string(raw))
		}
	}
}

func TestBoardClientEndpointsNilSliceNormalizationAndHeaders(t *testing.T) {
	var seenMethod string
	var seenPath string
	var seenQuery string
	var seenIdemKey string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenMethod = r.Method
		seenPath = r.URL.Path
		seenQuery = r.URL.RawQuery
		seenIdemKey = r.Header.Get("Idempotency-Key")
		w.Header().Set("Content-Type", "application/json")

		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/board/channels":
			_, _ = w.Write([]byte(`{"ok":true,"channels":null}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/board/topics":
			_, _ = w.Write([]byte(`{"ok":true,"topics":null}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/board/topics":
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"ok":true,"created":true,"topic":{"id":"top_1","channel":"proj/demo","title":"T1","external_ref":"pr#1","status":"todo","previous_status":"","pinned":false,"sort_order":1,"labels":null,"created_by_key_id":null,"last_message_id":"","last_handoff_message_id":"","last_event_cursor":0,"created_at":"2026-11-22T00:00:00Z","updated_at":"2026-11-22T00:00:00Z"}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/board/topics/top_1/messages":
			_, _ = w.Write([]byte(`{"ok":true,"topic":{"id":"top_1","channel":"proj/demo","title":"T1","external_ref":"","status":"todo","previous_status":"","pinned":false,"sort_order":1,"labels":{},"created_by_key_id":null,"last_message_id":"","last_handoff_message_id":"","last_event_cursor":0,"created_at":"2026-11-22T00:00:00Z","updated_at":"2026-11-22T00:00:00Z"},"messages":null,"cursor":4}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/board/topics/top_1/messages":
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"ok":true,"topic":{"id":"top_1","channel":"proj/demo","title":"T1","external_ref":"","status":"todo","previous_status":"","pinned":false,"sort_order":1,"labels":{},"created_by_key_id":null,"last_message_id":"msg_1","last_handoff_message_id":"","last_event_cursor":5,"created_at":"2026-11-22T00:00:00Z","updated_at":"2026-11-22T00:00:00Z"},"message":{"id":"msg_1","topic_id":"top_1","channel":"proj/demo","seq":1,"kind":"note","reply_to_id":null,"actor_scope":"client","actor_key_id":"key_1","actor_profile":"worker-1","source_node":"macmini","text_md":"hi","data":null,"question_state":"","question_options":null,"question_expires_at":null,"answered_message_id":null,"answered_at":null,"created_at":"2026-11-22T00:00:00Z"},"cursor":5}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/board/events":
			_, _ = w.Write([]byte(`{"ok":true,"events":null,"next_cursor":9}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "ahub_cli_test")
	ctx := context.Background()

	chRes, err := c.ListBoardChannels(ctx)
	if err != nil || chRes.Channels == nil || len(chRes.Channels) != 0 {
		t.Fatalf("ListBoardChannels failed: res=%+v err=%v", chRes, err)
	}

	hasOpen := true
	topListRes, err := c.ListBoardTopics(ctx, ListBoardTopicsOptions{
		Channel:         "proj/demo",
		ExternalRef:     "pr#1",
		Status:          "todo",
		HasOpenQuestion: &hasOpen,
		Limit:           20,
	})
	if err != nil || topListRes.Topics == nil {
		t.Fatalf("ListBoardTopics failed: res=%+v err=%v", topListRes, err)
	}
	for _, want := range []string{"channel=proj%2Fdemo", "external_ref=pr%231", "status=todo", "has_open_question=true", "limit=20"} {
		if !strings.Contains(seenQuery, want) {
			t.Fatalf("expected query %q to contain %q", seenQuery, want)
		}
	}

	topRes, err := c.CreateBoardTopic(ctx, CreateBoardTopicRequest{Channel: "proj/demo", Title: "T1", Upsert: true})
	if err != nil || topRes.Topic.Labels == nil {
		t.Fatalf("CreateBoardTopic failed: res=%+v err=%v", topRes, err)
	}

	msgsRes, err := c.GetBoardTopicMessages(ctx, "top_1", 3, 25)
	if err != nil || msgsRes.Messages == nil || seenQuery != "after_seq=3&limit=25" {
		t.Fatalf("GetBoardTopicMessages failed: res=%+v query=%q err=%v", msgsRes, seenQuery, err)
	}

	postRes, err := c.CreateBoardMessage(ctx, "top_1", CreateBoardMessageRequest{
		Kind:           "note",
		TextMD:         "hi",
		ActorProfile:   "worker-1",
		SourceNode:     "macmini",
		IdempotencyKey: "idem_key_12345678",
	})
	if err != nil || seenMethod != http.MethodPost || seenPath != "/api/v1/board/topics/top_1/messages" {
		t.Fatalf("CreateBoardMessage failed: err=%v method=%s path=%s", err, seenMethod, seenPath)
	}
	if seenIdemKey != "idem_key_12345678" || postRes.Message.Data == nil || postRes.Message.QuestionOptions == nil {
		t.Fatalf("expected Idempotency-Key and normalized slices/maps, got key=%q msg=%+v", seenIdemKey, postRes.Message)
	}

	evRes, err := c.ListBoardEvents(ctx, ListBoardEventsOptions{Channel: "proj/demo", AfterCursor: 5, Limit: 10})
	if err != nil || evRes.Events == nil || evRes.NextCursor != 9 {
		t.Fatalf("ListBoardEvents failed: res=%+v err=%v", evRes, err)
	}
	if !strings.Contains(seenQuery, "after_cursor=5") || !strings.Contains(seenQuery, "limit=10") {
		t.Fatalf("unexpected ListBoardEvents query %q", seenQuery)
	}
}

func TestDialWebSocketPropagatesHTTPErrorEnvelopeAndNext(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"ok":false,"error":{"code":"FORBIDDEN_SCOPE","message":"channel prefix denied","next":["ahub board read --json"]}}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "ahub_cli_test")
	_, err := c.DialWebSocket(context.Background(), "/ws/stream?topic_id=top_1")
	if err == nil {
		t.Fatal("expected error on 403 WS rejection")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected *APIError, got %T: %v", err, err)
	}
	if apiErr.HTTPStatus != http.StatusForbidden || apiErr.Body.Code != "FORBIDDEN_SCOPE" {
		t.Fatalf("unexpected APIError: %+v", apiErr)
	}
	if len(apiErr.Body.Next) != 1 || apiErr.Body.Next[0] != "ahub board read --json" {
		t.Fatalf("expected error.next propagated, got %+v", apiErr.Body.Next)
	}
	if code := ExitCodeForError(err); code != ExitPolicyDenied {
		t.Fatalf("expected ExitPolicyDenied (78), got %d", code)
	}
}
