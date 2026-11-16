package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gray0128/agent-hub/internal/api"
	"github.com/gray0128/agent-hub/internal/config"
)

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func writeFakeAgyApprovalBinary(t *testing.T, dir string) string {
	t.Helper()
	bin := filepath.Join(dir, "fake-agy.sh")
	script := `#!/usr/bin/env bash
printf '{"type":"session","session_id":"sess_approval_123"}\n'
printf '{"status":"NEEDS_HUMAN_APPROVAL","remote_control_url":"https://ahub.bobocai.win/rc/123","response":"Paused pending human approval"}\n'
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin
}

func TestDaemonNeedsApprovalCheckpointAndResolveAbort(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script test skipped on windows")
	}

	tmpDir := t.TempDir()
	fakeBin := writeFakeAgyApprovalBinary(t, tmpDir)
	workdir := filepath.Join(tmpDir, "repo")
	if err := os.MkdirAll(workdir, 0o755); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var approvalReqs []api.ApprovalCheckpointRequest
	var completeReqs []api.CompleteRunRequest
	checkpointed := make(chan struct{}, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/approval"):
			var body api.ApprovalCheckpointRequest
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode /approval: %v", err)
			}
			mu.Lock()
			approvalReqs = append(approvalReqs, body)
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok": true,
				"run": api.RunRecord{
					ID:               "run_app_1",
					Status:           "needs_approval",
					NativeSessionID:  strPtr(body.NativeSessionID),
					RemoteControlURL: body.RemoteControlURL,
				},
			})
			select {
			case checkpointed <- struct{}{}:
			default:
			}
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/heartbeat"):
			_ = json.NewEncoder(w).Encode(api.HeartbeatResponse{
				OK:     true,
				Status: "needs_approval",
			})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/complete"):
			var body api.CompleteRunRequest
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			completeReqs = append(completeReqs, body)
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok":  true,
				"run": api.RunRecord{ID: "run_app_1", Status: body.Status},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	cfg := &config.NodeConfig{
		NodeID:               "macmini",
		HubURL:               srv.URL,
		MaxConcurrency:       2,
		HeartbeatIntervalSec: 2,
		Agents: map[string]config.AgentConfig{
			"agy": {Enabled: true, Command: fakeBin},
		},
	}
	d := New(cfg, "node_tok", "0.1.0")
	defer d.batcher.Close()

	parentCtx, cancelParent := context.WithCancel(context.Background())
	defer cancelParent()

	d.trySpawnRun(parentCtx, api.RunRecord{
		ID:         "run_app_1",
		NodeID:     "macmini",
		Agent:      "agy",
		Workdir:    workdir,
		Prompt:     "deploy to staging",
		TimeoutSec: 60,
		LeaseOwner: "macmini:nonce1",
	})

	select {
	case <-checkpointed:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for POST /runs/:id/approval checkpoint")
	}

	if busy := d.busyWorkdirs(); len(busy) != 1 || busy[0] != filepath.Clean(workdir) {
		t.Fatalf("expected workdir lock held while parked in needs_approval, got %v", busy)
	}

	// Simulate hub.abort triggered by POST /runs/:id/resolve
	d.abortRun("run_app_1")
	d.runWaitGroup.Wait()

	if busy := d.busyWorkdirs(); len(busy) != 0 {
		t.Fatalf("expected workdir lock released after abortRun, got %v", busy)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(approvalReqs) != 1 {
		t.Fatalf("expected 1 approval checkpoint request, got %d", len(approvalReqs))
	}
	if approvalReqs[0].NativeSessionID != "sess_approval_123" || approvalReqs[0].RemoteControlURL != "https://ahub.bobocai.win/rc/123" {
		t.Fatalf("unexpected approval checkpoint payload: %+v", approvalReqs[0])
	}
	if approvalReqs[0].OutputMD != "Paused pending human approval" {
		t.Fatalf("expected output_md preserved on checkpoint, got %q", approvalReqs[0].OutputMD)
	}
	if len(completeReqs) != 0 {
		t.Fatalf("expected zero /complete requests when settled externally via /resolve, got %+v", completeReqs)
	}
}

func TestDaemonNeedsApprovalTimeoutCompletesWithApprovalTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script test skipped on windows")
	}

	tmpDir := t.TempDir()
	fakeBin := writeFakeAgyApprovalBinary(t, tmpDir)
	workdir := filepath.Join(tmpDir, "repo")
	if err := os.MkdirAll(workdir, 0o755); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var completeReqs []api.CompleteRunRequest
	completed := make(chan struct{}, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/approval"):
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok":  true,
				"run": api.RunRecord{ID: "run_app_timeout", Status: "needs_approval"},
			})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/heartbeat"):
			_ = json.NewEncoder(w).Encode(api.HeartbeatResponse{
				OK:     true,
				Status: "needs_approval",
			})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/complete"):
			var body api.CompleteRunRequest
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode /complete: %v", err)
			}
			mu.Lock()
			completeReqs = append(completeReqs, body)
			mu.Unlock()
			select {
			case completed <- struct{}{}:
			default:
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok":  true,
				"run": api.RunRecord{ID: "run_app_timeout", Status: body.Status},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	cfg := &config.NodeConfig{
		NodeID:               "macmini",
		HubURL:               srv.URL,
		MaxConcurrency:       2,
		HeartbeatIntervalSec: 2,
		Agents: map[string]config.AgentConfig{
			"agy": {Enabled: true, Command: fakeBin},
		},
	}
	d := New(cfg, "node_tok", "0.1.0")
	defer d.batcher.Close()

	parentCtx, cancelParent := context.WithCancel(context.Background())
	defer cancelParent()

	d.trySpawnRun(parentCtx, api.RunRecord{
		ID:         "run_app_timeout",
		NodeID:     "macmini",
		Agent:      "agy",
		Workdir:    workdir,
		Prompt:     "deploy to prod",
		TimeoutSec: 1,
		LeaseOwner: "macmini:nonce2",
	})

	select {
	case <-completed:
	case <-time.After(4 * time.Second):
		t.Fatal("timed out waiting for APPROVAL_TIMEOUT /complete call")
	}
	d.runWaitGroup.Wait()

	mu.Lock()
	defer mu.Unlock()
	if len(completeReqs) != 1 {
		t.Fatalf("expected 1 /complete request, got %d", len(completeReqs))
	}
	req := completeReqs[0]
	if req.Status != "failed" || req.ErrorCode != "APPROVAL_TIMEOUT" {
		t.Fatalf("expected failed APPROVAL_TIMEOUT, got status=%q code=%q", req.Status, req.ErrorCode)
	}
	if req.NativeSessionID != "sess_approval_123" || req.OutputMD != "Paused pending human approval" {
		t.Fatalf("expected checkpointed metadata preserved on timeout complete, got %+v", req)
	}
}
