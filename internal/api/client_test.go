package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestListNativeEventsQueryEncodingAndDefaults(t *testing.T) {
	var capturedPath string
	var capturedQuery string
	var capturedAuth string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		capturedQuery = r.URL.RawQuery
		capturedAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("node_id") == "empty" {
			_, _ = w.Write([]byte(`{"ok":true,"events":null,"open_interaction_count":0,"next_cursor":null}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":                     true,
			"open_interaction_count": 1,
			"next_cursor": map[string]string{
				"before_ts": "2026-11-18T05:00:00.000Z",
				"before_id": "evt_01ABC",
			},
			"events": []map[string]interface{}{
				{
					"id":                "evt_01ABC",
					"node_id":           "macmini",
					"event_id":          "cli:s1:progress:1234",
					"agent":             "claude",
					"event_kind":        "progress",
					"native_session_id": "s1",
					"workdir":           "~/workspace/demo",
					"title":             "Stage 1",
					"summary":           "Tests green",
					"source":            "cli",
					"notify_key_id":     nil,
					"notify_status":     "partial",
					"notify_error":      "",
					"ack_at":            nil,
					"attention_state":   nil,
					"deliveries_summary": map[string]int{
						"total":  2,
						"sent":   1,
						"queued": 0,
						"failed": 1,
					},
					"created_at": "2026-11-18T05:00:00.000Z",
					"updated_at": "2026-11-18T05:00:01.000Z",
				},
			},
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "ahub_adm_test_tok")
	res, err := c.ListNativeEvents(context.Background(), ListNativeEventsOptions{
		NodeID:       "macmini",
		Agent:        "claude",
		EventKind:    "progress",
		NotifyStatus: "partial",
		UnackedOnly:  true,
		Query:        "green",
		Limit:        25,
		BeforeTS:     "2026-11-18T06:00:00.000Z",
		BeforeID:     "evt_02XYZ",
	})
	if err != nil {
		t.Fatalf("ListNativeEvents failed: %v", err)
	}
	if capturedPath != "/api/v1/native-events" {
		t.Fatalf("unexpected path %q", capturedPath)
	}
	if capturedAuth != "Bearer ahub_adm_test_tok" {
		t.Fatalf("unexpected auth header %q", capturedAuth)
	}
	expectedSubstrings := []string{
		"node_id=macmini",
		"agent=claude",
		"event_kind=progress",
		"notify_status=partial",
		"unacked_only=true",
		"q=green",
		"limit=25",
		"before_id=evt_02XYZ",
	}
	for _, sub := range expectedSubstrings {
		if !containsString(capturedQuery, sub) {
			t.Fatalf("expected query %q to contain %q", capturedQuery, sub)
		}
	}
	if len(res.Events) != 1 || res.Events[0].DeliveriesSummary == nil || res.Events[0].DeliveriesSummary.Failed != 1 {
		t.Fatalf("unexpected decoded events: %+v", res)
	}
	if res.NextCursor == nil || res.NextCursor.BeforeID != "evt_01ABC" {
		t.Fatalf("unexpected next_cursor: %+v", res.NextCursor)
	}

	emptyRes, err := c.ListNativeEvents(context.Background(), ListNativeEventsOptions{NodeID: "empty"})
	if err != nil {
		t.Fatalf("empty ListNativeEvents failed: %v", err)
	}
	if emptyRes.Events == nil || len(emptyRes.Events) != 0 {
		t.Fatalf("expected non-nil empty slice, got %#v", emptyRes.Events)
	}
}

func TestListNativeEventsForbiddenScopeExitCode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"ok":false,"error":{"code":"FORBIDDEN_SCOPE","message":"admin required"}}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "ahub_cli_test_tok")
	_, err := c.ListNativeEvents(context.Background(), ListNativeEventsOptions{})
	if err == nil {
		t.Fatal("expected error for 403 FORBIDDEN_SCOPE")
	}
	if code := ExitCodeForError(err); code != ExitPolicyDenied {
		t.Fatalf("expected ExitPolicyDenied (78), got %d (err=%v)", code, err)
	}
}

func containsString(s, substr string) bool {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
