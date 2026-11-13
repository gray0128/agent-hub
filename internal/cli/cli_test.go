package cli

import (
	"errors"
	"flag"
	"net/http"
	"testing"

	"github.com/gray0128/agent-hub/internal/api"
)

func TestExtractGlobalFlagsAndFlexibleParse(t *testing.T) {
	g, rest := extractGlobalFlags([]string{"run", "--node", "macmini", "--json", "--token=tok_1", "-"})
	if !g.JSON || g.Token != "tok_1" {
		t.Fatalf("unexpected global opts: %+v", g)
	}
	if len(rest) != 4 || rest[0] != "run" || rest[3] != "-" {
		t.Fatalf("unexpected rest args: %v", rest)
	}

	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	var node string
	var syncMode bool
	fs.StringVar(&node, "node", "", "")
	fs.BoolVar(&syncMode, "sync", false, "")
	if err := parseFlagsFlexible(fs, []string{"--node", "macmini", "hello", "--sync"}, map[string]bool{"--node": true}); err != nil {
		t.Fatalf("parseFlagsFlexible failed: %v", err)
	}
	if node != "macmini" || !syncMode || fs.Arg(0) != "hello" {
		t.Fatalf("unexpected parsed flags: node=%q sync=%v args=%v", node, syncMode, fs.Args())
	}
}

func TestExitCodesMatchContract(t *testing.T) {
	if got := api.ExitCodeForRunStatus("done"); got != 0 {
		t.Fatalf("done => %d, want 0", got)
	}
	if got := api.ExitCodeForRunStatus("needs_approval"); got != 20 {
		t.Fatalf("needs_approval => %d, want 20", got)
	}
	if got := api.ExitCodeForRunStatus("failed"); got != 10 {
		t.Fatalf("failed => %d, want 10", got)
	}
	if got := api.ExitCodeForError(&api.APIError{HTTPStatus: http.StatusForbidden, Body: api.ErrorBody{Code: "DEPTH_LIMIT_EXCEEDED"}}); got != 78 {
		t.Fatalf("DEPTH_LIMIT_EXCEEDED => %d, want 78", got)
	}
	if got := api.ExitCodeForError(&api.APIError{HTTPStatus: http.StatusConflict, Body: api.ErrorBody{Code: "WORKDIR_AMBIGUOUS"}}); got != 64 {
		t.Fatalf("WORKDIR_AMBIGUOUS => %d, want 64", got)
	}
	if got := api.ExitCodeForError(errors.New("dial tcp timeout")); got != 75 {
		t.Fatalf("net err => %d, want 75", got)
	}
}
