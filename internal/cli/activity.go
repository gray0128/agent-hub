package cli

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/gray0128/agent-hub/internal/api"
	"github.com/gray0128/agent-hub/internal/redact"
)

func runActivity(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("activity", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var nodeID, agent, kind string
	var unacked bool
	var limit int

	fs.StringVar(&nodeID, "node", "", "filter by node id")
	fs.StringVar(&agent, "agent", "", "filter by agent (agy|pi|omp|codex|claude|grok)")
	fs.StringVar(&kind, "kind", "", "filter by event kind (interaction_needed|turn_summary|progress)")
	fs.BoolVar(&unacked, "unacked", false, "only unacked open interaction_needed events")
	fs.IntVar(&limit, "limit", 20, "max events (1..100)")

	valFlags := map[string]bool{
		"--node": true, "--agent": true, "--kind": true, "--limit": true,
	}
	if err := parseFlagsFlexible(fs, args, valFlags); err != nil {
		return api.ExitBadUsageOrInput
	}
	if fs.NArg() > 0 {
		return failUsage(g.JSON, "usage: ahub activity [--node <node_id>] [--agent <agent>] [--kind <interaction_needed|turn_summary|progress>] [--unacked] [--limit 20] [--json]")
	}

	nodeID = strings.TrimSpace(nodeID)
	agent = strings.ToLower(strings.TrimSpace(agent))
	kind = strings.TrimSpace(kind)

	if agent != "" && !isValidNativeEventAgent(agent) {
		return failUsage(g.JSON, fmt.Sprintf("unsupported --agent %q (expected agy|pi|omp|codex|claude|grok)", agent))
	}
	if kind != "" && !isValidNativeEventKind(kind) {
		return failUsage(g.JSON, fmt.Sprintf("unsupported --kind %q (expected interaction_needed|turn_summary|progress)", kind))
	}
	if limit < 1 || limit > 100 {
		return failUsage(g.JSON, "--limit must be between 1 and 100")
	}

	client, err := newClient(g)
	if err != nil {
		return failErr(g.JSON, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	res, err := client.ListNativeEvents(ctx, api.ListNativeEventsOptions{
		NodeID:      nodeID,
		Agent:       agent,
		EventKind:   kind,
		UnackedOnly: unacked,
		Limit:       limit,
	})
	if err != nil {
		return failErr(g.JSON, err)
	}

	for i := range res.Events {
		res.Events[i].Title = redact.Text(res.Events[i].Title)
		res.Events[i].Summary = redact.Text(res.Events[i].Summary)
	}

	if g.JSON {
		writeJSON(res)
	} else if len(res.Events) == 0 {
		fmt.Printf("No native activity events (open_interaction_count=%d)\n", res.OpenInteractionCount)
	} else {
		fmt.Printf("Open interactions: %d\n", res.OpenInteractionCount)
		for _, ev := range res.Events {
			state := "-"
			if ev.AttentionState != nil && *ev.AttentionState != "" {
				state = *ev.AttentionState
			}
			snippet := boundRunes(strings.ReplaceAll(firstNonEmpty(ev.Title, ev.Summary), "\n", " "), 80)
			fmt.Printf("%s  %-18s %-10s %-10s %-6s %-8s %s\n",
				ev.ID, ev.EventKind, state, ev.NodeID, ev.Agent, ev.NotifyStatus, snippet)
		}
	}
	return api.ExitOK
}
