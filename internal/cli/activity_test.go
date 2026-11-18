package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gray0128/agent-hub/internal/api"
)

func TestActivityJSONAndFilterParams(t *testing.T) {
	var capturedQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/native-events" {
			http.NotFound(w, r)
			return
		}
		capturedQuery = r.URL.RawQuery
		state := "open"
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(api.ListNativeEventsResponse{
			OK:                   true,
			OpenInteractionCount: 1,
			Events: []api.NativeEventRecord{
				{
					ID:              "evt_01ACT1",
					NodeID:          "macmini",
					EventID:         "claude:sess_1:Notification:1122",
					Agent:           "claude",
					EventKind:       "interaction_needed",
					NativeSessionID: "sess_1",
					Workdir:         "~/workspace/demo",
					Title:           "Confirm token=secret_val_1",
					Summary:         "Proceed with ahub_cli_leak123?",
					Source:          "claude-hook",
					NotifyStatus:    "sent",
					AttentionState:  &state,
					CreatedAt:       "2026-11-18T05:00:00.000Z",
					UpdatedAt:       "2026-11-18T05:00:00.000Z",
				},
			},
			NextCursor: nil,
		})
	}))
	defer srv.Close()

	t.Setenv("AHUB_CONFIG_DIR", t.TempDir())
	t.Setenv("AHUB_URL", srv.URL)
	t.Setenv("AHUB_TOKEN", "ahub_adm_test_token")

	code, out := captureExecute(t, []string{
		"--json", "activity",
		"--node", "macmini",
		"--agent", "claude",
		"--kind", "interaction_needed",
		"--unacked",
		"--limit", "10",
	}, "")
	if code != api.ExitOK {
		t.Fatalf("expected ExitOK, got %d out=%s", code, out)
	}
	trimmed := strings.TrimSpace(out)
	if strings.Contains(trimmed, "\n") {
		t.Fatalf("expected single-line JSON object on stdout, got:\n%s", out)
	}
	var parsed api.ListNativeEventsResponse
	if err := json.Unmarshal([]byte(trimmed), &parsed); err != nil {
		t.Fatalf("stdout is not valid JSON object: %v (%s)", err, out)
	}
	if !parsed.OK || parsed.OpenInteractionCount != 1 || len(parsed.Events) != 1 {
		t.Fatalf("unexpected activity response: %+v", parsed)
	}
	if strings.Contains(trimmed, "secret_val_1") || strings.Contains(trimmed, "ahub_cli_leak123") {
		t.Fatalf("expected secrets redacted in activity output: %s", trimmed)
	}
	for _, want := range []string{"node_id=macmini", "agent=claude", "event_kind=interaction_needed", "unacked_only=true", "limit=10"} {
		if !strings.Contains(capturedQuery, want) {
			t.Fatalf("expected query %q to contain %q", capturedQuery, want)
		}
	}
}

func TestActivityForbiddenScopeReturns78AndBadUsageReturns64(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"ok":false,"error":{"code":"FORBIDDEN_SCOPE","message":"Scope 'client' is not permitted for this operation."}}`))
	}))
	defer srv.Close()

	t.Setenv("AHUB_CONFIG_DIR", t.TempDir())
	t.Setenv("AHUB_URL", srv.URL)
	t.Setenv("AHUB_TOKEN", "ahub_cli_client_tok")

	// JSON mode -> exit 78 + single ErrorEnvelope JSON on stdout
	codeJSON, outJSON := captureExecute(t, []string{"--json", "activity"}, "")
	if codeJSON != api.ExitPolicyDenied {
		t.Fatalf("expected exit 78, got %d out=%s", codeJSON, outJSON)
	}
	var env api.ErrorEnvelope
	if err := json.Unmarshal([]byte(strings.TrimSpace(outJSON)), &env); err != nil {
		t.Fatalf("expected valid ErrorEnvelope JSON, got %v (%s)", err, outJSON)
	}
	if env.OK || env.Error.Code != "FORBIDDEN_SCOPE" {
		t.Fatalf("unexpected ErrorEnvelope: %+v", env)
	}

	// Human mode -> exit 78 + empty stdout
	codeHuman, outHuman := captureExecute(t, []string{"activity"}, "")
	if codeHuman != api.ExitPolicyDenied {
		t.Fatalf("expected exit 78 in human mode, got %d", codeHuman)
	}
	if strings.TrimSpace(outHuman) != "" {
		t.Fatalf("expected empty stdout on error in human mode, got %q", outHuman)
	}

	// Validation errors -> exit 64
	for _, args := range [][]string{
		{"--json", "activity", "--kind", "tool_use"},
		{"--json", "activity", "--agent", "unknown"},
		{"--json", "activity", "--limit", "0"},
		{"--json", "activity", "--limit", "101"},
		{"--json", "activity", "extra_arg"},
	} {
		code, _ := captureExecute(t, args, "")
		if code != api.ExitBadUsageOrInput {
			t.Fatalf("expected exit 64 for %v, got %d", args, code)
		}
	}
}
