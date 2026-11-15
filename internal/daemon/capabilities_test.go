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
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/gray0128/agent-hub/internal/api"
	"github.com/gray0128/agent-hub/internal/config"
)

func TestParseAgyModelsOutput(t *testing.T) {
	raw := `Fetching available models...
gemini-4-carbon-low	Gemini 4 Carbon (Low)
gemini-4-carbon-medium	Gemini 4 Carbon (Medium)
gemini-4-carbon-high	Gemini 4 Carbon (High)
gemini-4-hydrogen-xhigh	Gemini 4 Hydrogen (XHigh)
gpt-oss-120b-medium	GPT-OSS 120B (Medium)
gemini-pro-orchestrator	Gemini Pro Orchestrator
`
	models := parseAgyModelsOutput(raw)
	if len(models) != 4 {
		t.Fatalf("expected 4 grouped models, got %d: %+v", len(models), models)
	}
	if models[0].ID != "gemini-4-carbon" || models[0].Label != "Gemini 4 Carbon" || models[0].DefaultEffort != "high" {
		t.Fatalf("unexpected first model: %+v", models[0])
	}
	if strings.Join(models[0].Efforts, ",") != "low,medium,high" {
		t.Fatalf("unexpected carbon efforts: %v", models[0].Efforts)
	}
	if models[3].ID != "gemini-pro-orchestrator" || models[3].Efforts == nil || len(models[3].Efforts) != 0 {
		t.Fatalf("expected orchestrator with non-nil empty efforts slice, got %+v", models[3])
	}

	encoded, err := json.Marshal(models[3])
	if err != nil {
		t.Fatalf("marshal orchestrator: %v", err)
	}
	if !strings.Contains(string(encoded), `"efforts":[]`) {
		t.Fatalf("expected non-null efforts JSON array, got %s", string(encoded))
	}
}

func TestParseOmpAndPiModels(t *testing.T) {
	ompRaw := []byte(`{"models":[
		{"provider":"anthropic","id":"claude-sonnet-4-5","selector":"anthropic/claude-sonnet-4-5","name":"Claude Sonnet 4.5","reasoning":true,"thinking":["off","low","high","xhigh"]},
		{"provider":"openai","id":"gpt-4o-mini","selector":"openai/gpt-4o-mini","name":"GPT-4o Mini","reasoning":false,"thinking":[]}
	]}`)
	ompModels := parseOmpModelsJSON(ompRaw)
	if len(ompModels) != 2 {
		t.Fatalf("expected 2 omp models, got %d", len(ompModels))
	}
	if ompModels[0].ID != "anthropic/claude-sonnet-4-5" || strings.Join(ompModels[0].Efforts, ",") != "off,low,high,xhigh" {
		t.Fatalf("unexpected first omp model: %+v", ompModels[0])
	}
	if ompModels[1].Efforts == nil || len(ompModels[1].Efforts) != 0 {
		t.Fatalf("expected non-nil empty efforts for non-reasoning omp model, got %+v", ompModels[1])
	}

	piRaw := `provider   model               context   max-out   thinking   images
openai     gpt-5.4             200K      64K       yes        yes
anthropic  claude-haiku-4-5    200K      16K       no         no
`
	piModels := parsePiListModelsOutput(piRaw)
	if len(piModels) != 2 {
		t.Fatalf("expected 2 pi models, got %d", len(piModels))
	}
	if piModels[0].ID != "openai/gpt-5.4" || !sliceContains(piModels[0].Efforts, "xhigh") {
		t.Fatalf("unexpected first pi model: %+v", piModels[0])
	}
	if piModels[1].ID != "anthropic/claude-haiku-4-5" || piModels[1].Efforts == nil || len(piModels[1].Efforts) != 0 {
		t.Fatalf("expected non-thinking pi model with empty efforts, got %+v", piModels[1])
	}
}

func TestLoadCodexModelsFromTempHome(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("CODEX_HOME", tmpDir)

	tomlContent := `
model = "gpt-5.6-sol"
model_reasoning_effort = "ultra"
api_key = "should-not-read"

[model_providers.custom]
base_url = "https://private.example.invalid"
`
	if err := os.WriteFile(filepath.Join(tmpDir, "config.toml"), []byte(tomlContent), 0o600); err != nil {
		t.Fatalf("write config.toml: %v", err)
	}

	cacheJSON := `{
  "models": [
    {
      "slug": "gpt-5.6-sol",
      "display_name": "GPT-5.6 Sol",
      "visibility": "list",
      "default_reasoning_level": "medium",
      "supported_reasoning_levels": [{"effort":"low"},{"effort":"high"},{"effort":"ultra"}]
    },
    {
      "slug": "internal-hidden",
      "display_name": "Hidden",
      "visibility": "hide",
      "default_reasoning_level": "low",
      "supported_reasoning_levels": [{"effort":"low"}]
    }
  ]
}`
	if err := os.WriteFile(filepath.Join(tmpDir, "models_cache.json"), []byte(cacheJSON), 0o600); err != nil {
		t.Fatalf("write models_cache.json: %v", err)
	}

	models, cfgModel, cfgEffort, ok := loadCodexModels(config.AgentConfig{Enabled: true})
	if !ok {
		t.Fatalf("expected loadCodexModels ok=true")
	}
	if cfgModel != "gpt-5.6-sol" || cfgEffort != "ultra" {
		t.Fatalf("unexpected codex defaults: model=%q effort=%q", cfgModel, cfgEffort)
	}
	if len(models) != 1 || models[0].ID != "gpt-5.6-sol" || !sliceContains(models[0].Efforts, "ultra") {
		t.Fatalf("expected visibility=hide filtered and ultra preserved, got %+v", models)
	}
}

func TestLoadClaudeModelsRedactsSecrets(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", tmpDir)

	settingsJSON := `{
  "model": "claude-opus-4-6",
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-ant-secret-must-not-leak",
    "ANTHROPIC_API_KEY": "sk-api-secret-must-not-leak",
    "ANTHROPIC_BASE_URL": "https://secret-proxy.example.invalid",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6"
  }
}`
	if err := os.WriteFile(filepath.Join(tmpDir, "settings.json"), []byte(settingsJSON), 0o600); err != nil {
		t.Fatalf("write settings.json: %v", err)
	}

	models, defModel, ok := loadClaudeModels(config.AgentConfig{Enabled: true})
	if !ok || defModel != "claude-opus-4-6" || len(models) != 2 {
		t.Fatalf("unexpected claude parse: ok=%v defModel=%q models=%+v", ok, defModel, models)
	}

	encoded, err := json.Marshal(models)
	if err != nil {
		t.Fatalf("marshal claude models: %v", err)
	}
	s := string(encoded)
	if strings.Contains(s, "sk-ant-secret") || strings.Contains(s, "sk-api-secret") || strings.Contains(s, "secret-proxy.example.invalid") {
		t.Fatalf("secret leaked into serialized capabilities: %s", s)
	}
}

func TestNonBlockingHandshakeAndBoundedCapabilityRefresh(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell sleep probe test runs on unix")
	}

	tmpDir := t.TempDir()
	slowScript := filepath.Join(tmpDir, "slow-agy.sh")
	if err := os.WriteFile(slowScript, []byte("#!/bin/sh\nsleep 5\n"), 0o755); err != nil {
		t.Fatalf("write slow script: %v", err)
	}

	helloFrames := make(chan map[string]interface{}, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/claim") {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"claimed_runs":[]}`))
			return
		}
		if r.URL.Path != "/ws/node" {
			http.NotFound(w, r)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()

		for {
			_, raw, err := c.Read(r.Context())
			if err != nil {
				return
			}
			var frame map[string]interface{}
			if json.Unmarshal(raw, &frame) != nil {
				continue
			}
			if frame["type"] == "node.hello" {
				helloFrames <- frame
				welcome, _ := json.Marshal(map[string]interface{}{
					"type":                  "hub.welcome",
					"node_id":               "macmini",
					"heartbeat_interval_ms": 25000,
					"has_pending_runs":      false,
				})
				_ = c.Write(r.Context(), websocket.MessageText, welcome)
			}
		}
	}))
	defer srv.Close()

	cfg := &config.NodeConfig{
		NodeID:         "macmini",
		DisplayName:    "macmini",
		HubURL:         srv.URL,
		Token:          "ahub_nod_test",
		MaxConcurrency: 1,
		ProjectRoots:   []string{tmpDir},
		Agents: map[string]config.AgentConfig{
			"agy": {Enabled: true, Command: slowScript, DefaultModel: "carbon"},
		},
	}
	d := New(cfg, cfg.Token, "test-ver")
	d.catalogProbeTimeout = 150 * time.Millisecond
	d.workspaceScanFn = func(roots, skipDirs []string) []api.WorkspaceEntry {
		return []api.WorkspaceEntry{}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	go func() {
		_ = d.connectAndServe(ctx)
	}()

	start := time.Now()
	var first, second map[string]interface{}
	select {
	case first = <-helloFrames:
		if elapsed := time.Since(start); elapsed > 600*time.Millisecond {
			t.Fatalf("expected non-blocking initial handshake under 600ms, took %s", elapsed)
		}
	case <-time.After(1 * time.Second):
		t.Fatalf("timed out waiting for initial node.hello")
	}

	firstAgents := first["capabilities"].(map[string]interface{})["agents"].(map[string]interface{})
	firstAgy := firstAgents["agy"].(map[string]interface{})
	if firstAgy["catalog_status"] != "pending" {
		t.Fatalf("expected initial catalog_status=pending, got %v", firstAgy["catalog_status"])
	}

	select {
	case second = <-helloFrames:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for bounded refreshed node.hello after CLI timeout")
	}

	secondAgents := second["capabilities"].(map[string]interface{})["agents"].(map[string]interface{})
	secondAgy := secondAgents["agy"].(map[string]interface{})
	if secondAgy["catalog_status"] != "fallback" {
		t.Fatalf("expected fallback catalog_status after timed-out CLI probe, got %v", secondAgy["catalog_status"])
	}
}
