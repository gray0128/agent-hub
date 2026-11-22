package daemon

import (
	"context"
	"encoding/json"
	"io"
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

func TestDaemonCompletePayloadStructuredResult(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script test skipped on windows")
	}

	cases := []struct {
		name           string
		scriptBody     string
		wantStatus     string
		wantHasResult  bool
		wantResultJSON string
		wantHasResErr  bool
	}{
		{
			name: "done_with_valid_json",
			scriptBody: `printf '{"summary":"ok","count":3}' > "$AHUB_RESULT_FILE"
printf '{"type":"result","result":"done"}\n'`,
			wantStatus:     "done",
			wantHasResult:  true,
			wantResultJSON: `{"summary":"ok","count":3}`,
			wantHasResErr:  false,
		},
		{
			name: "done_with_explicit_null",
			scriptBody: `printf 'null' > "$AHUB_RESULT_FILE"
printf '{"type":"result","result":"done"}\n'`,
			wantStatus:     "done",
			wantHasResult:  true,
			wantResultJSON: `null`,
			wantHasResErr:  false,
		},
		{
			name:          "done_without_result_file",
			scriptBody:    `printf '{"type":"result","result":"done"}\n'`,
			wantStatus:    "done",
			wantHasResult: false,
			wantHasResErr: false,
		},
		{
			name: "done_with_malformed_result_file",
			scriptBody: `printf '{bad json' > "$AHUB_RESULT_FILE"
printf '{"type":"result","result":"done"}\n'`,
			wantStatus:    "done",
			wantHasResult: false,
			wantHasResErr: true,
		},
		{
			name: "failed_ignores_result_file",
			scriptBody: `printf '{"ignored":true}' > "$AHUB_RESULT_FILE"
exit 1`,
			wantStatus:    "failed",
			wantHasResult: false,
			wantHasResErr: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tmpDir := t.TempDir()
			workdir := filepath.Join(tmpDir, "repo")
			if err := os.MkdirAll(workdir, 0o755); err != nil {
				t.Fatal(err)
			}
			bin := filepath.Join(tmpDir, "fake-claude.sh")
			rfCapture := filepath.Join(tmpDir, "rfpath.txt")
			script := "#!/usr/bin/env bash\n" +
				`printf '%s' "$AHUB_RESULT_FILE" > "` + rfCapture + `"` + "\n" +
				tc.scriptBody + "\n"
			if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
				t.Fatal(err)
			}

			var mu sync.Mutex
			var rawBodies []string
			completed := make(chan struct{}, 1)

			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch {
				case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/heartbeat"):
					_ = json.NewEncoder(w).Encode(api.HeartbeatResponse{OK: true, Status: "running"})
				case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/complete"):
					b, err := io.ReadAll(r.Body)
					if err != nil {
						t.Fatal(err)
					}
					mu.Lock()
					rawBodies = append(rawBodies, string(b))
					mu.Unlock()
					select {
					case completed <- struct{}{}:
					default:
					}
					_ = json.NewEncoder(w).Encode(map[string]interface{}{
						"ok":  true,
						"run": api.RunRecord{ID: "run_res_1", Status: tc.wantStatus},
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
				HeartbeatIntervalSec: 30,
				Agents: map[string]config.AgentConfig{
					"claude": {Enabled: true, Command: bin},
				},
			}
			d := New(cfg, "node_tok", "0.2.0")
			defer d.batcher.Close()

			parentCtx, cancelParent := context.WithCancel(context.Background())
			defer cancelParent()

			d.trySpawnRun(parentCtx, api.RunRecord{
				ID:         "run_res_1",
				ThreadID:   "thr_res_1",
				RootRunID:  "run_res_1",
				NodeID:     "macmini",
				Agent:      "claude",
				Workdir:    workdir,
				Prompt:     "test",
				TimeoutSec: 30,
				LeaseOwner: "macmini:n1",
			})

			select {
			case <-completed:
			case <-time.After(5 * time.Second):
				t.Fatalf("timed out waiting for /complete")
			}
			d.runWaitGroup.Wait()

			mu.Lock()
			defer mu.Unlock()
			if len(rawBodies) != 1 {
				t.Fatalf("expected 1 /complete request, got %d", len(rawBodies))
			}

			var rawMap map[string]json.RawMessage
			if err := json.Unmarshal([]byte(rawBodies[0]), &rawMap); err != nil {
				t.Fatalf("unmarshal /complete body: %v (%s)", err, rawBodies[0])
			}
			if string(rawMap["status"]) != `"`+tc.wantStatus+`"` {
				t.Fatalf("status = %s, want %q", string(rawMap["status"]), tc.wantStatus)
			}

			resRaw, hasResult := rawMap["result"]
			if hasResult != tc.wantHasResult {
				t.Fatalf("hasResult=%v, want %v (body=%s)", hasResult, tc.wantHasResult, rawBodies[0])
			}
			if tc.wantHasResult && string(resRaw) != tc.wantResultJSON {
				t.Fatalf("result = %s, want %s", string(resRaw), tc.wantResultJSON)
			}

			resErrRaw, hasResErr := rawMap["result_error"]
			if hasResErr != tc.wantHasResErr {
				t.Fatalf("hasResErr=%v (%s), want %v (body=%s)", hasResErr, string(resErrRaw), tc.wantHasResErr, rawBodies[0])
			}

			rfBytes, err := os.ReadFile(rfCapture)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(filepath.Dir(string(rfBytes))); !os.IsNotExist(err) {
				t.Fatalf("expected temp dir cleaned up after daemon run")
			}
		})
	}
}
