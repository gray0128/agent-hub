package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coder/websocket"

	"github.com/gray0128/agent-hub/internal/api"
)

func TestResolveCommandJSONAndStdin(t *testing.T) {
	var seenSummary string
	var seenPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		var body api.ResolveRunRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode resolve body: %v", err)
		}
		seenSummary = body.Summary
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"run": api.RunRecord{
				ID:      "run_res_1",
				Status:  "done",
				Summary: body.Summary,
			},
		})
	}))
	defer srv.Close()

	code, out := captureExecute(t, []string{
		"--url", srv.URL,
		"--token", "tok_test",
		"--json",
		"resolve", "run_res_1", "--summary", "-",
	}, "approved in remote-control UI\n")
	if code != api.ExitOK {
		t.Fatalf("expected ExitOK (0), got %d (out=%s)", code, out)
	}
	if seenPath != "/api/v1/runs/run_res_1/resolve" {
		t.Fatalf("unexpected request path %q", seenPath)
	}
	if seenSummary != "approved in remote-control UI" {
		t.Fatalf("expected trimmed stdin summary, got %q", seenSummary)
	}
	var parsed struct {
		OK  bool          `json:"ok"`
		Run api.RunRecord `json:"run"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("expected single valid JSON object on stdout, got error %v: %s", err, out)
	}
	if !parsed.OK || parsed.Run.Status != "done" {
		t.Fatalf("unexpected resolve output: %+v", parsed)
	}
}

func TestRunWaitPropagatesStage2AuthErrorInsteadOfTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/runs":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok": true,
				"run": api.RunRecord{
					ID:     "run_auth_err",
					NodeID: "macmini",
					Status: "queued",
				},
			})
		case r.URL.Path == "/ws/stream":
			w.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok": false,
				"error": map[string]interface{}{
					"code":    "FORBIDDEN_SCOPE",
					"message": "node scope denied",
				},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/runs/run_auth_err":
			w.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok": false,
				"error": map[string]interface{}{
					"code":    "FORBIDDEN_SCOPE",
					"message": "node scope denied",
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	code, out := captureExecute(t, []string{
		"--url", srv.URL,
		"--token", "tok_test",
		"--json",
		"run", "-n", "macmini", "-d", "/tmp/demo", "-a", "agy", "--wait", "2s", "hello",
	}, "")
	if code != api.ExitPolicyDenied {
		t.Fatalf("expected ExitPolicyDenied (%d) instead of ExitWaitTimeout, got %d (out=%s)", api.ExitPolicyDenied, code, out)
	}
	if !strings.Contains(out, "FORBIDDEN_SCOPE") {
		t.Fatalf("expected FORBIDDEN_SCOPE in output, got %s", out)
	}
}

func TestRunWaitNeedsApprovalFetchesOutputPreview(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/runs":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok": true,
				"run": api.RunRecord{
					ID:     "run_wait_app",
					NodeID: "macmini",
					Status: "queued",
				},
			})
		case r.URL.Path == "/ws/stream":
			c, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer c.CloseNow()
			frame, _ := json.Marshal(map[string]interface{}{
				"type": "run.updated",
				"run": api.RunRecord{
					ID:               "run_wait_app",
					NodeID:           "macmini",
					Status:           "needs_approval",
					RemoteControlURL: "https://ahub.bobocai.win/rc/wait",
				},
			})
			_ = c.Write(context.Background(), websocket.MessageText, frame)
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/runs/run_wait_app":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok": true,
				"run": api.RunRecord{
					ID:               "run_wait_app",
					NodeID:           "macmini",
					Status:           "needs_approval",
					RemoteControlURL: "https://ahub.bobocai.win/rc/wait",
					Summary:          "Approval needed before git push",
					OutputPreview:    "Full checkpointed approval details",
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	code, out := captureExecute(t, []string{
		"--url", srv.URL,
		"--token", "tok_test",
		"--json",
		"run", "-n", "macmini", "-d", "/tmp/demo", "-a", "agy", "--wait", "3s", "hello",
	}, "")
	if code != api.ExitNeedsApproval {
		t.Fatalf("expected ExitNeedsApproval (%d), got %d (out=%s)", api.ExitNeedsApproval, code, out)
	}
	var parsed api.RunRecord
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("decode run output JSON: %v (%s)", err, out)
	}
	if parsed.OutputPreview != "Full checkpointed approval details" {
		t.Fatalf("expected output_preview fetched on needs_approval, got %q", parsed.OutputPreview)
	}
	if parsed.RemoteControlURL != "https://ahub.bobocai.win/rc/wait" {
		t.Fatalf("expected remote_control_url preserved, got %q", parsed.RemoteControlURL)
	}
}
