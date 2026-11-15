package runner

import (
	"strings"
	"testing"

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
}
