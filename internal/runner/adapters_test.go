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
	if joined != "exec resume --json -m gpt-5 sess-123 -" {
		t.Fatalf("expected codex resume syntax, got %q", joined)
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
	agyJoined := strings.Join(agyArgs, " ")
	if !strings.Contains(agyJoined, "--output-format json") || !strings.Contains(agyJoined, "--model gemini-4-carbon-high") {
		t.Fatalf("unexpected agy args: %q", agyJoined)
	}
}
