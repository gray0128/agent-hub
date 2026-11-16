package runner

import (
	"context"
	"encoding/json"
	"fmt"
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

func TestReadLinesBoundedHandlesOver128KB(t *testing.T) {
	huge := strings.Repeat("a", 256*1024)
	input := "short-1\n" + huge + "\nshort-2\n"
	var lines []string
	err := ReadLinesBounded(strings.NewReader(input), func(line []byte) {
		lines = append(lines, string(line))
	})
	if err != nil {
		t.Fatalf("ReadLinesBounded failed: %v", err)
	}
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines, got %d", len(lines))
	}
	if lines[0] != "short-1" || len(lines[1]) != 256*1024 || lines[2] != "short-2" {
		t.Fatalf("unexpected line lengths: %d, %d, %d", len(lines[0]), len(lines[1]), len(lines[2]))
	}
}

func TestBuildCommandSpecAdapters(t *testing.T) {
	sess := "sess-123"

	bin, args, stdinPrompt, err := BuildCommandSpec(api.RunRecord{
		Agent:           "codex",
		Model:           "gpt-5",
		Effort:          "high",
		Prompt:          "hello via stdin",
		NativeSessionID: &sess,
	}, config.AgentConfig{Command: "codex"})
	if err != nil {
		t.Fatalf("codex spec err: %v", err)
	}
	if bin != "codex" || stdinPrompt != "hello via stdin" {
		t.Fatalf("unexpected codex bin=%q stdin=%q", bin, stdinPrompt)
	}
	joined := strings.Join(args, " ")
	if joined != `exec resume --json -m gpt-5 -c model_reasoning_effort="high" sess-123 -` {
		t.Fatalf("expected codex resume syntax with reasoning effort, got %q", joined)
	}

	_, freshCodexArgs, _, err := BuildCommandSpec(api.RunRecord{
		Agent:   "codex",
		Model:   "gpt-5.6-sol",
		Effort:  "ultra",
		Sandbox: true,
		Prompt:  "run ultra",
	}, config.AgentConfig{Command: "codex"})
	if err != nil {
		t.Fatalf("codex fresh spec err: %v", err)
	}
	if strings.Join(freshCodexArgs, " ") != `exec --json -m gpt-5.6-sol -c model_reasoning_effort="ultra" -s workspace-write -` {
		t.Fatalf("unexpected fresh codex ultra args: %v", freshCodexArgs)
	}

	_, overrideCodexArgs, _, err := BuildCommandSpec(api.RunRecord{
		Agent:  "codex",
		Model:  "gpt-5",
		Effort: "high",
		Prompt: "override",
	}, config.AgentConfig{Command: "codex", Args: []string{"-c", "model_reasoning_effort=low"}})
	if err != nil {
		t.Fatalf("codex override spec err: %v", err)
	}
	if strings.Count(strings.Join(overrideCodexArgs, " "), "model_reasoning_effort") != 1 {
		t.Fatalf("expected agentCfg.Args override to suppress duplicate model_reasoning_effort, got %v", overrideCodexArgs)
	}

	_, autoCodexArgs, _, err := BuildCommandSpec(api.RunRecord{
		Agent:  "codex",
		Model:  "gpt-5",
		Effort: "auto",
		Prompt: "auto effort",
	}, config.AgentConfig{Command: "codex"})
	if err != nil {
		t.Fatalf("codex auto spec err: %v", err)
	}
	if strings.Contains(strings.Join(autoCodexArgs, " "), "model_reasoning_effort") {
		t.Fatalf("expected auto effort to omit -c model_reasoning_effort, got %v", autoCodexArgs)
	}

	_, agyArgs, agyStdin, err := BuildCommandSpec(api.RunRecord{
		Agent:  "agy",
		Model:  "carbon",
		Effort: "high",
		Prompt: "do task",
	}, config.AgentConfig{Command: "agy"})
	if err != nil {
		t.Fatalf("agy spec err: %v", err)
	}
	if agyStdin != "" {
		t.Fatalf("expected empty stdin for agy")
	}
	if len(agyArgs) < 3 || agyArgs[0] != "--output-format" || agyArgs[1] != "json" {
		t.Fatalf("expected agy args to start with --output-format json, got %v", agyArgs)
	}
	for _, a := range agyArgs {
		if a == "-p" {
			t.Fatalf("unexpected standalone -p flag in agy args: %v", agyArgs)
		}
	}
	agyJoined := strings.Join(agyArgs, " ")
	if !strings.Contains(agyJoined, "--model gemini-4-carbon-high") {
		t.Fatalf("unexpected agy args: %q", agyJoined)
	}
	if agyArgs[len(agyArgs)-1] != "-p=do task" {
		t.Fatalf("expected agy prompt flag -p=do task at end, got %q", agyArgs[len(agyArgs)-1])
	}

	_, dashArgs, _, err := BuildCommandSpec(api.RunRecord{
		Agent:   "agy",
		Model:   "flash",
		Effort:  "low",
		Sandbox: true,
		Prompt:  "- inspect repo",
	}, config.AgentConfig{Command: "agy"})
	if err != nil {
		t.Fatalf("agy dash prompt err: %v", err)
	}
	if !strings.Contains(strings.Join(dashArgs, " "), "--sandbox") {
		t.Fatalf("expected --sandbox in agy dash prompt args: %v", dashArgs)
	}
	if dashArgs[len(dashArgs)-1] != "-p=- inspect repo" {
		t.Fatalf("expected final arg -p=- inspect repo, got %q", dashArgs[len(dashArgs)-1])
	}

	_, orchArgs, _, err := BuildCommandSpec(api.RunRecord{
		Agent:  "agy",
		Model:  "gemini-pro-orchestrator",
		Effort: "high",
		Prompt: "plan",
	}, config.AgentConfig{Command: "agy"})
	if err != nil {
		t.Fatalf("agy orchestrator err: %v", err)
	}
	orchJoined := strings.Join(orchArgs, " ")
	if !strings.Contains(orchJoined, "--model gemini-pro-orchestrator") {
		t.Fatalf("expected orchestrator model unmodified, got %q", orchJoined)
	}
	if strings.Contains(orchJoined, "--effort") || strings.Contains(orchJoined, "-high") {
		t.Fatalf("expected orchestrator to omit suffix and --effort flag, got %q", orchJoined)
	}

	_, defaultAgyArgs, _, err := BuildCommandSpec(api.RunRecord{
		Agent:  "agy",
		Prompt: "default model task",
	}, config.AgentConfig{Command: "agy"})
	if err != nil {
		t.Fatalf("agy default model err: %v", err)
	}
	defaultAgyJoined := strings.Join(defaultAgyArgs, " ")
	if !strings.Contains(defaultAgyJoined, "--model gemini-4-hydrogen-high") {
		t.Fatalf("expected default agy model gemini-4-hydrogen-high, got %q", defaultAgyJoined)
	}

	_, xhighAgyArgs, _, err := BuildCommandSpec(api.RunRecord{
		Agent:  "agy",
		Effort: "xhigh",
		Prompt: "xhigh model task",
	}, config.AgentConfig{Command: "agy"})
	if err != nil {
		t.Fatalf("agy xhigh default model err: %v", err)
	}
	xhighAgyJoined := strings.Join(xhighAgyArgs, " ")
	if !strings.Contains(xhighAgyJoined, "--model gemini-4-hydrogen-xhigh --effort xhigh") {
		t.Fatalf("expected agy xhigh default expansion, got %q", xhighAgyJoined)
	}
}

func writeFakeAgyScript(t *testing.T, dir string, sentinelPath string, modePath string) string {
	t.Helper()
	scriptPath := filepath.Join(dir, "fake-agy")
	script := `#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "remote-control" && "${2:-}" == "start" ]]; then
  echo "start_invoked" > "` + sentinelPath + `"
  exit 99
fi
mode="$(cat "` + modePath + `" 2>/dev/null || echo "running")"
if [[ "${1:-}" == "remote-control" && "${2:-}" == "status" ]]; then
  case "$mode" in
    running)
      printf 'Daemon state = running\nDaemon pid = 4442\nInstance name: macmini (find it at https://antigravity.google.com)\n'
      exit 0
      ;;
    not_running_with_url)
      printf 'Daemon state = not running\nInstance name: macmini (find it at https://antigravity.google.com)\n'
      exit 0
      ;;
    exit_err)
      echo "not signed in" >&2
      exit 1
      ;;
    no_url)
      printf 'Daemon state = running\nDaemon pid = 4442\n'
      exit 0
      ;;
  esac
fi
printf '{"type":"approval_needed"}\n'
printf '{"status":"NEEDS_HUMAN_APPROVAL"}\n'
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake-agy failed: %v", err)
	}
	return scriptPath
}

func TestProbeRemoteControlURLNeverCallsStart(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script test skipped on windows")
	}
	tmpDir := t.TempDir()
	sentinel := filepath.Join(tmpDir, "start-called.sentinel")
	modeFile := filepath.Join(tmpDir, "mode.txt")
	healthFile := filepath.Join(tmpDir, "auth-health.json")
	fakeBin := writeFakeAgyScript(t, tmpDir, sentinel, modeFile)
	agentCfg := config.AgentConfig{Command: fakeBin}
	ctx := context.Background()

	// 1. Healthy running daemon strips trailing ')' from URL
	if err := os.WriteFile(modeFile, []byte("running"), 0o600); err != nil {
		t.Fatal(err)
	}
	url, reason := probeRemoteControlURLWithHealthPath(ctx, agentCfg, healthFile)
	if url != "https://antigravity.google.com" || reason != "" {
		t.Fatalf("expected clean URL and empty reason, got url=%q reason=%q", url, reason)
	}

	// 2. 'not running' output containing static '(find it at https://...)' must NOT return stale URL or call start
	if err := os.WriteFile(modeFile, []byte("not_running_with_url"), 0o600); err != nil {
		t.Fatal(err)
	}
	url, reason = probeRemoteControlURLWithHealthPath(ctx, agentCfg, healthFile)
	if url != "" || reason != "daemon_not_running" {
		t.Fatalf("expected empty URL and daemon_not_running, got url=%q reason=%q", url, reason)
	}

	// 3. Non-zero exit from status must NOT call start
	if err := os.WriteFile(modeFile, []byte("exit_err"), 0o600); err != nil {
		t.Fatal(err)
	}
	url, reason = probeRemoteControlURLWithHealthPath(ctx, agentCfg, healthFile)
	if url != "" || reason != "daemon_not_running" {
		t.Fatalf("expected daemon_not_running on non-zero exit, got url=%q reason=%q", url, reason)
	}

	// 4. Circuit breaker OPEN short-circuits before invoking status/start
	if err := os.WriteFile(modeFile, []byte("running"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(healthFile, []byte(`{"status":"unhealthy","circuit_state":"OPEN","remaining_seconds":3600}`), 0o600); err != nil {
		t.Fatal(err)
	}
	url, reason = probeRemoteControlURLWithHealthPath(ctx, agentCfg, healthFile)
	if url != "" || reason != "auth_circuit_open" {
		t.Fatalf("expected auth_circuit_open, got url=%q reason=%q", url, reason)
	}

	// 5. Expired token snapshot short-circuits
	if err := os.WriteFile(healthFile, []byte(`{"status":"expired","circuit_state":"CLOSED","remaining_seconds":-120}`), 0o600); err != nil {
		t.Fatal(err)
	}
	url, reason = probeRemoteControlURLWithHealthPath(ctx, agentCfg, healthFile)
	if url != "" || reason != "oauth_token_expired" {
		t.Fatalf("expected oauth_token_expired, got url=%q reason=%q", url, reason)
	}

	// 6. Zombie unauthenticated daemon snapshot short-circuits
	if err := os.WriteFile(healthFile, []byte(`{"status":"degraded","circuit_state":"CLOSED","remaining_seconds":3000,"zombie_unauthenticated_detected":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	url, reason = probeRemoteControlURLWithHealthPath(ctx, agentCfg, healthFile)
	if url != "" || reason != "daemon_auth_lost" {
		t.Fatalf("expected daemon_auth_lost, got url=%q reason=%q", url, reason)
	}

	if _, err := os.Stat(sentinel); !os.IsNotExist(err) {
		t.Fatalf("CRITICAL: agy remote-control start was invoked (sentinel exists)")
	}
}

func TestExecuteRunApprovalNeededReadOnlyDegradation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script test skipped on windows")
	}
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)
	sentinel := filepath.Join(tmpDir, "start-called.sentinel")
	modeFile := filepath.Join(tmpDir, "mode.txt")
	if err := os.WriteFile(modeFile, []byte("not_running_with_url"), 0o600); err != nil {
		t.Fatal(err)
	}
	fakeBin := writeFakeAgyScript(t, tmpDir, sentinel, modeFile)

	var events []struct {
		kind    string
		payload map[string]interface{}
	}
	res := ExecuteRun(
		context.Background(),
		api.RunRecord{
			ID:         "run_test123",
			Agent:      "agy",
			Workdir:    tmpDir,
			Prompt:     "test approval",
			TimeoutSec: 15,
		},
		&config.NodeConfig{HubURL: "https://ahub.bobocai.win"},
		config.AgentConfig{Command: fakeBin},
		Callbacks{
			OnEvent: func(kind string, payload map[string]interface{}) {
				events = append(events, struct {
					kind    string
					payload map[string]interface{}
				}{kind: kind, payload: payload})
			},
		},
	)

	if res.Status != "needs_approval" {
		t.Fatalf("expected status needs_approval, got %q (err=%s)", res.Status, res.ErrorMessage)
	}
	if res.RemoteControlURL != "" {
		t.Fatalf("expected empty RemoteControlURL when daemon not running, got %q", res.RemoteControlURL)
	}
	if !strings.Contains(res.Summary, "remote-control unavailable: daemon_not_running") {
		t.Fatalf("expected diagnostic summary, got %q", res.Summary)
	}
	foundSystem := false
	foundApproval := false
	for _, ev := range events {
		if ev.kind == "system" && ev.payload["stage"] == "remote_control_unavailable" && ev.payload["reason"] == "daemon_not_running" {
			foundSystem = true
		}
		if ev.kind == "approval_needed" && ev.payload["remote_control_available"] == false && ev.payload["reason"] == "daemon_not_running" {
			foundApproval = true
		}
	}
	if !foundSystem || !foundApproval {
		t.Fatalf("expected both system and approval_needed degradation events, got %+v", events)
	}
	if _, err := os.Stat(sentinel); !os.IsNotExist(err) {
		t.Fatalf("CRITICAL: ExecuteRun invoked remote-control start")
	}
}

type capturedEvent struct {
	kind    string
	payload map[string]interface{}
}

func TestExecuteRunPiStreamingFiltersNoiseAndMapsTools(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script test skipped on windows")
	}
	tmpDir := t.TempDir()
	ndjsonPath := filepath.Join(tmpDir, "pi-stream.jsonl")

	marshalLine := func(v interface{}) string {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}

	var lines []string
	lines = append(lines, marshalLine(map[string]interface{}{
		"type":      "session",
		"version":   3,
		"id":        "01a1da3b-test-uuid",
		"cwd":       tmpDir,
		"timestamp": "2026-11-15T10:00:00Z",
	}))
	lines = append(lines, `{"type":"agent_start"}`, `{"type":"turn_start"}`)
	lines = append(lines, marshalLine(map[string]interface{}{
		"type": "message_start",
		"message": map[string]interface{}{
			"role":    "assistant",
			"content": []interface{}{},
		},
	}))
	for i := 0; i < 150; i++ {
		deltaType := "thinking_delta"
		delta := fmt.Sprintf("thought-%d ", i)
		if i >= 120 {
			deltaType = "toolcall_delta"
			delta = fmt.Sprintf("arg-%d", i)
		}
		lines = append(lines, marshalLine(map[string]interface{}{
			"type": "message_update",
			"assistantMessageEvent": map[string]interface{}{
				"type":  deltaType,
				"delta": delta,
			},
		}))
	}
	lines = append(lines, marshalLine(map[string]interface{}{
		"type": "message_end",
		"message": map[string]interface{}{
			"role":     "assistant",
			"provider": "openai-codex",
			"model":    "gpt-5.4",
			"content": []interface{}{
				map[string]interface{}{"type": "thinking", "thinking": "internal thought"},
				map[string]interface{}{"type": "toolCall", "id": "call_1", "name": "bash"},
			},
		},
	}))
	lines = append(lines, marshalLine(map[string]interface{}{
		"type":       "tool_execution_start",
		"toolCallId": "call_1",
		"toolName":   "bash",
		"args":       map[string]interface{}{"command": "git status --short"},
	}))
	for i := 0; i < 20; i++ {
		lines = append(lines, marshalLine(map[string]interface{}{
			"type":       "tool_execution_update",
			"toolCallId": "call_1",
			"toolName":   "bash",
			"partialResult": map[string]interface{}{
				"content": []interface{}{map[string]interface{}{"type": "text", "text": fmt.Sprintf("line %d", i)}},
			},
		}))
	}
	lines = append(lines, marshalLine(map[string]interface{}{
		"type":       "tool_execution_end",
		"toolCallId": "call_1",
		"toolName":   "bash",
		"isError":    false,
		"result":     strings.Repeat("stdout ", 2000),
	}))
	lines = append(lines, marshalLine(map[string]interface{}{
		"type": "turn_end",
		"message": map[string]interface{}{
			"role":       "assistant",
			"provider":   "openai-codex",
			"model":      "gpt-5.4",
			"stopReason": "toolUse",
			"usage":      map[string]interface{}{"input": 100, "output": 20},
		},
		"toolResults": []interface{}{strings.Repeat("huge-tool-result-", 3000)},
	}))

	// Turn 2 streams actual assistant markdown answer
	lines = append(lines, `{"type":"turn_start"}`)
	lines = append(lines, marshalLine(map[string]interface{}{
		"type":    "message_start",
		"message": map[string]interface{}{"role": "assistant", "content": []interface{}{}},
	}))
	lines = append(lines,
		marshalLine(map[string]interface{}{"type": "message_update", "assistantMessageEvent": map[string]interface{}{"type": "text_delta", "delta": "Hello **world**"}}),
		marshalLine(map[string]interface{}{"type": "message_update", "assistantMessageEvent": map[string]interface{}{"type": "text_delta", "delta": "\nDone."}}),
	)
	assistantMsg2 := map[string]interface{}{
		"role":       "assistant",
		"provider":   "openai-codex",
		"model":      "gpt-5.4",
		"stopReason": "stop",
		"content": []interface{}{
			map[string]interface{}{"type": "thinking", "thinking": "secret reasoning"},
			map[string]interface{}{"type": "text", "text": "Hello **world**\nDone."},
		},
	}
	lines = append(lines, marshalLine(map[string]interface{}{"type": "message_end", "message": assistantMsg2}))
	lines = append(lines, marshalLine(map[string]interface{}{"type": "turn_end", "message": assistantMsg2, "toolResults": []interface{}{}}))
	lines = append(lines, marshalLine(map[string]interface{}{
		"type": "agent_end",
		"messages": []interface{}{
			map[string]interface{}{"role": "user", "content": []interface{}{map[string]interface{}{"type": "text", "text": "user prompt"}}},
			assistantMsg2,
			map[string]interface{}{"role": "toolResult", "content": []interface{}{map[string]interface{}{"type": "text", "text": "tool stdout should not leak"}}},
		},
	}))

	if err := os.WriteFile(ndjsonPath, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	fakePi := filepath.Join(tmpDir, "fake-pi")
	script := "#!/usr/bin/env bash\ncat \"" + ndjsonPath + "\"\n"
	if err := os.WriteFile(fakePi, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var events []capturedEvent
	res := ExecuteRun(
		context.Background(),
		api.RunRecord{ID: "run_pi_1", Agent: "pi", Workdir: tmpDir, Prompt: "inspect", TimeoutSec: 15},
		&config.NodeConfig{HubURL: "https://ahub.bobocai.win"},
		config.AgentConfig{Command: fakePi},
		Callbacks{
			OnEvent: func(kind string, payload map[string]interface{}) {
				mu.Lock()
				events = append(events, capturedEvent{kind: kind, payload: payload})
				mu.Unlock()
			},
		},
	)

	if res.Status != "done" {
		t.Fatalf("expected status done, got %q (err=%s)", res.Status, res.ErrorMessage)
	}
	if res.NativeSessionID != "01a1da3b-test-uuid" {
		t.Fatalf("expected session.id extracted as 01a1da3b-test-uuid, got %q", res.NativeSessionID)
	}
	if res.ResolvedModel != "openai-codex/gpt-5.4" {
		t.Fatalf("expected ResolvedModel=openai-codex/gpt-5.4, got %q", res.ResolvedModel)
	}
	if res.OutputMD != "Hello **world**\nDone." {
		t.Fatalf("expected clean assistant OutputMD, got %q", res.OutputMD)
	}
	if len(events) > 6 {
		t.Fatalf("expected streaming noise filtered (<=6 events), got %d events: %+v", len(events), events)
	}

	var sawToolUse, sawTurnEnd bool
	for _, ev := range events {
		if rawType, _ := ev.payload["type"].(string); rawType == "message_update" || rawType == "tool_execution_update" || rawType == "turn_start" || rawType == "agent_start" {
			t.Fatalf("unexpected unfiltered streaming event %q: %+v", rawType, ev.payload)
		}
		if ev.kind == "tool_use" {
			sawToolUse = true
			if ev.payload["tool"] != "bash" || ev.payload["command"] != "git status --short" || ev.payload["tool_call_id"] != "call_1" {
				t.Fatalf("unexpected compact tool_use payload: %+v", ev.payload)
			}
		}
		if ev.kind == "turn_end" {
			sawTurnEnd = true
			if _, exists := ev.payload["toolResults"]; exists {
				t.Fatalf("expected turn_end toolResults stripped: %+v", ev.payload)
			}
			if _, exists := ev.payload["message"]; exists {
				t.Fatalf("expected turn_end message body stripped: %+v", ev.payload)
			}
		}
	}
	if !sawToolUse || !sawTurnEnd {
		t.Fatalf("expected both tool_use and turn_end events, got %+v", events)
	}
}

func TestExecuteRunPiCancelledMidStreamDoesNotDumpNDJSON(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script test skipped on windows")
	}

	t.Run("cancelled_during_thinking_has_empty_output", func(t *testing.T) {
		tmpDir := t.TempDir()
		fakePi := filepath.Join(tmpDir, "fake-pi")
		script := `#!/usr/bin/env bash
printf '{"type":"session","version":3,"id":"sess-cancel-1","cwd":"/tmp"}\n'
printf '{"type":"agent_start"}\n'
for i in $(seq 1 30); do
  printf '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"thinking step %d"}}\n' "$i"
done
printf '{"type":"tool_execution_start","toolCallId":"call_hold","toolName":"bash","args":{"command":"sleep 10"}}\n'
sleep 10
`
		if err := os.WriteFile(fakePi, []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}

		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		readyToCancel := make(chan struct{}, 1)
		resCh := make(chan Result, 1)
		go func() {
			resCh <- ExecuteRun(
				ctx,
				api.RunRecord{ID: "run_cancel_think", Agent: "pi", Workdir: tmpDir, Prompt: "hi", TimeoutSec: 15},
				&config.NodeConfig{HubURL: "https://ahub.bobocai.win"},
				config.AgentConfig{Command: fakePi},
				Callbacks{
					OnEvent: func(kind string, payload map[string]interface{}) {
						if kind == "tool_use" {
							select {
							case readyToCancel <- struct{}{}:
							default:
							}
						}
					},
				},
			)
		}()

		select {
		case <-readyToCancel:
			cancel()
		case <-time.After(5 * time.Second):
			t.Fatal("timed out waiting for fake-pi events")
		}

		res := <-resCh
		if res.Status != "cancelled" {
			t.Fatalf("expected status cancelled, got %q (err=%s)", res.Status, res.ErrorMessage)
		}
		if res.NativeSessionID != "sess-cancel-1" {
			t.Fatalf("expected NativeSessionID=sess-cancel-1, got %q", res.NativeSessionID)
		}
		if res.OutputMD != "" {
			t.Fatalf("expected empty OutputMD when cancelled without assistant text (must not dump NDJSON), got %q", res.OutputMD)
		}
		if res.Summary != "Cancelled by user" {
			t.Fatalf("expected summary 'Cancelled by user', got %q", res.Summary)
		}
	})

	t.Run("cancelled_mid_text_delta_preserves_streamed_text", func(t *testing.T) {
		tmpDir := t.TempDir()
		fakePi := filepath.Join(tmpDir, "fake-pi")
		script := `#!/usr/bin/env bash
printf '{"type":"session","version":3,"id":"sess-cancel-2","cwd":"/tmp"}\n'
printf '{"type":"message_start","message":{"role":"assistant","content":[]}}\n'
printf '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Partial "}}\n'
printf '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"answer"}}\n'
printf '{"type":"tool_execution_start","toolCallId":"call_hold","toolName":"bash","args":{"command":"sleep 10"}}\n'
sleep 10
`
		if err := os.WriteFile(fakePi, []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}

		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		readyToCancel := make(chan struct{}, 1)
		resCh := make(chan Result, 1)
		go func() {
			resCh <- ExecuteRun(
				ctx,
				api.RunRecord{ID: "run_cancel_text", Agent: "pi", Workdir: tmpDir, Prompt: "hi", TimeoutSec: 15},
				&config.NodeConfig{HubURL: "https://ahub.bobocai.win"},
				config.AgentConfig{Command: fakePi},
				Callbacks{
					OnEvent: func(kind string, payload map[string]interface{}) {
						if kind == "tool_use" {
							select {
							case readyToCancel <- struct{}{}:
							default:
							}
						}
					},
				},
			)
		}()

		select {
		case <-readyToCancel:
			cancel()
		case <-time.After(5 * time.Second):
			t.Fatal("timed out waiting for fake-pi events")
		}

		res := <-resCh
		if res.Status != "cancelled" {
			t.Fatalf("expected status cancelled, got %q", res.Status)
		}
		if res.OutputMD != "Partial answer" {
			t.Fatalf("expected streamed partial text 'Partial answer', got %q", res.OutputMD)
		}
	})
}

func TestExecuteRunCodexJSONStream(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script test skipped on windows")
	}
	tmpDir := t.TempDir()
	fakeCodex := filepath.Join(tmpDir, "fake-codex")
	var lines []string
	marshalLine := func(v interface{}) string {
		b, _ := json.Marshal(v)
		return string(b)
	}
	lines = append(lines, marshalLine(map[string]interface{}{"type": "thread.started", "thread_id": "019c-codex"}))
	lines = append(lines, `{"type":"turn.started"}`)
	lines = append(lines, marshalLine(map[string]interface{}{
		"type": "item.started",
		"item": map[string]interface{}{
			"id":      "item_1",
			"type":    "command_execution",
			"command": "go test ./...",
		},
	}))
	for i := 0; i < 20; i++ {
		lines = append(lines, marshalLine(map[string]interface{}{
			"type": "item.updated",
			"item": map[string]interface{}{
				"id":                "item_1",
				"type":              "command_execution",
				"aggregated_output": fmt.Sprintf("chunk %d", i),
			},
		}))
	}
	lines = append(lines, marshalLine(map[string]interface{}{
		"type": "item.completed",
		"item": map[string]interface{}{
			"id":   "item_2",
			"type": "agent_message",
			"text": "All tests pass.",
		},
	}))
	lines = append(lines, marshalLine(map[string]interface{}{
		"type":  "turn.completed",
		"usage": map[string]interface{}{"input_tokens": 50, "output_tokens": 10},
	}))

	ndjsonPath := filepath.Join(tmpDir, "codex.jsonl")
	if err := os.WriteFile(ndjsonPath, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	script := "#!/usr/bin/env bash\ncat >/dev/null\ncat \"" + ndjsonPath + "\"\n"
	if err := os.WriteFile(fakeCodex, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var events []capturedEvent
	res := ExecuteRun(
		context.Background(),
		api.RunRecord{ID: "run_codex_1", Agent: "codex", Workdir: tmpDir, Prompt: "test", TimeoutSec: 15},
		&config.NodeConfig{HubURL: "https://ahub.bobocai.win"},
		config.AgentConfig{Command: fakeCodex},
		Callbacks{
			OnEvent: func(kind string, payload map[string]interface{}) {
				mu.Lock()
				events = append(events, capturedEvent{kind: kind, payload: payload})
				mu.Unlock()
			},
		},
	)

	if res.Status != "done" {
		t.Fatalf("expected status done, got %q (err=%s)", res.Status, res.ErrorMessage)
	}
	if res.NativeSessionID != "019c-codex" {
		t.Fatalf("expected NativeSessionID=019c-codex, got %q", res.NativeSessionID)
	}
	if res.OutputMD != "All tests pass." {
		t.Fatalf("expected OutputMD 'All tests pass.', got %q", res.OutputMD)
	}
	if len(events) != 3 {
		t.Fatalf("expected exactly 3 events (session, tool_use, turn_end), got %d: %+v", len(events), events)
	}
	if events[1].kind != "tool_use" || events[1].payload["tool"] != "bash" || events[1].payload["command"] != "go test ./..." {
		t.Fatalf("unexpected codex tool_use event: %+v", events[1])
	}
}

func TestBuildCommandSpecClaudeEffort(t *testing.T) {
	cases := []struct {
		name         string
		effort       string
		cfgArgs      []string
		wantContains []string
		wantAbsent   []string
	}{
		{
			name:         "passes explicit high effort",
			effort:       "high",
			wantContains: []string{"--effort", "high"},
		},
		{
			name:         "passes max effort",
			effort:       "max",
			wantContains: []string{"--effort", "max"},
		},
		{
			name:       "omits auto effort",
			effort:     "auto",
			wantAbsent: []string{"--effort"},
		},
		{
			name:       "omits off effort",
			effort:     "off",
			wantAbsent: []string{"--effort"},
		},
		{
			name:       "omits empty effort",
			effort:     "",
			wantAbsent: []string{"--effort"},
		},
		{
			name:         "respects explicit --effort override in config args",
			effort:       "high",
			cfgArgs:      []string{"--effort", "low"},
			wantContains: []string{"--effort", "low"},
			wantAbsent:   []string{"high"},
		},
		{
			name:         "respects --effort= override in config args",
			effort:       "high",
			cfgArgs:      []string{"--effort=medium"},
			wantContains: []string{"--effort=medium"},
			wantAbsent:   []string{"high"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			run := api.RunRecord{
				ID:      "run_claude_effort",
				Agent:   "claude",
				Model:   "sonnet",
				Effort:  tc.effort,
				Sandbox: true,
				Prompt:  "hello",
			}
			agentCfg := config.AgentConfig{
				Enabled: true,
				Command: "claude",
				Args:    tc.cfgArgs,
			}
			spec, args, _, err := BuildCommandSpec(run, agentCfg)
			if err != nil {
				t.Fatalf("BuildCommandSpec failed: %v (bin=%s)", err, spec)
			}
			joined := " " + strings.Join(args, " ") + " "
			for _, want := range tc.wantContains {
				if !strings.Contains(joined, " "+want+" ") {
					t.Fatalf("expected %q in args %v", want, args)
				}
			}
			for _, absent := range tc.wantAbsent {
				if strings.Contains(joined, " "+absent+" ") {
					t.Fatalf("did not expect %q in args %v", absent, args)
				}
			}
		})
	}
}
