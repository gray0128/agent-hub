package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gray0128/agent-hub/internal/api"
	"github.com/gray0128/agent-hub/internal/config"
	"github.com/gray0128/agent-hub/internal/runner"
)

const (
	planMaxBytes      = 5 << 20
	planMaxNodes      = 20
	planMaxNodeDeps   = 10
	planMaxTotalEdges = 60
	delayMin          = 1 * time.Minute
	delayMax          = 7 * 24 * time.Hour
	delaySkewBuffer   = 2 * time.Second
)

var (
	planIDRe       = regexp.MustCompile(`^pln_[A-Za-z0-9]+$`)
	boardTopicIDRe = regexp.MustCompile(`^top_[A-Za-z0-9]+$`)
	runIDStrictRe  = regexp.MustCompile(`^run_[A-Za-z0-9]+$`)
)

func runPlan(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("plan", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var fileFlag, topicFlag, idemFlag, asFlag string
	fs.StringVar(&fileFlag, "file", "", "plan JSON file path or '-' for stdin")
	fs.StringVar(&topicFlag, "topic", "", "board topic id override (top_...)")
	fs.StringVar(&idemFlag, "idempotency-key", "", "idempotency key (8..128 chars)")
	fs.StringVar(&asFlag, "as", "", "actor profile attribution")

	valFlags := boardValueFlags("--file", "--topic", "--idempotency-key", "--as")
	if err := parseFlagsFlexible(fs, args, valFlags); err != nil {
		return api.ExitBadUsageOrInput
	}
	if fs.NArg() > 0 {
		return failUsage(g.JSON, "usage: ahub plan --file <path|-> [--topic <top_id>] [--idempotency-key <k>] [--as <profile>] [--json]")
	}
	trimmedFile := strings.TrimSpace(fileFlag)
	if trimmedFile == "" {
		return failUsage(g.JSON, "--file <path|-> is required")
	}

	var topicSet, idemSet, asSet bool
	fs.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "topic":
			topicSet = true
		case "idempotency-key":
			idemSet = true
		case "as":
			asSet = true
		}
	})

	var raw []byte
	var readErr error
	if trimmedFile == "-" {
		raw, readErr = io.ReadAll(io.LimitReader(os.Stdin, planMaxBytes+1))
		if readErr != nil {
			return failUsage(g.JSON, fmt.Sprintf("read plan from stdin: %v", readErr))
		}
		if len(raw) > planMaxBytes {
			return failUsage(g.JSON, fmt.Sprintf("plan JSON exceeds %d bytes", planMaxBytes))
		}
	} else {
		raw, readErr = os.ReadFile(config.ExpandPath(trimmedFile))
		if readErr != nil {
			return failUsage(g.JSON, fmt.Sprintf("read plan file: %v", readErr))
		}
		if len(raw) > planMaxBytes {
			return failUsage(g.JSON, fmt.Sprintf("plan JSON exceeds %d bytes", planMaxBytes))
		}
	}

	var req api.CreatePlanRequest
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		return failUsage(g.JSON, fmt.Sprintf("invalid plan JSON: %v", err))
	}
	var trailing interface{}
	if err := dec.Decode(&trailing); err != io.EOF {
		return failUsage(g.JSON, "plan JSON must contain a single JSON object")
	}

	if len(req.Nodes) == 0 || len(req.Nodes) > planMaxNodes {
		return failUsage(g.JSON, fmt.Sprintf("plan nodes must contain 1..%d entries (got %d)", planMaxNodes, len(req.Nodes)))
	}

	totalEdges := 0
	for _, n := range req.Nodes {
		if len(n.DependsOn) > planMaxNodeDeps {
			return failUsage(g.JSON, fmt.Sprintf("plan node %q exceeds max %d depends_on entries", n.Key, planMaxNodeDeps))
		}
		totalEdges += len(n.DependsOn)
		if strings.TrimSpace(n.ScheduledAt) != "" && n.InSec != nil {
			return failUsage(g.JSON, fmt.Sprintf("plan node %q cannot specify both scheduled_at and in_sec", n.Key))
		}
		if n.InSec != nil && (*n.InSec < 60 || *n.InSec > 604800) {
			return failUsage(g.JSON, fmt.Sprintf("plan node %q in_sec must be between 60 and 604800", n.Key))
		}
	}
	if totalEdges > planMaxTotalEdges {
		return failUsage(g.JSON, fmt.Sprintf("plan exceeds max %d total dependency edges (got %d)", planMaxTotalEdges, totalEdges))
	}

	if envParent := strings.TrimSpace(os.Getenv("AHUB_RUN_ID")); envParent != "" {
		req.ParentRunID = envParent
	}

	if topicSet {
		req.BoardTopicID = strings.TrimSpace(topicFlag)
	} else {
		req.BoardTopicID = strings.TrimSpace(req.BoardTopicID)
	}
	if err := validateBoardTopicID(req.BoardTopicID); err != nil {
		return failUsage(g.JSON, err.Error())
	}

	if idemSet {
		req.IdempotencyKey = strings.TrimSpace(idemFlag)
	} else {
		req.IdempotencyKey = strings.TrimSpace(req.IdempotencyKey)
	}
	validatedIdem, err := validateIdempotencyKey(req.IdempotencyKey)
	if err != nil {
		return failUsage(g.JSON, err.Error())
	}
	req.IdempotencyKey = validatedIdem

	if asSet {
		profile, err := resolveActorProfile(asFlag)
		if err != nil {
			return failUsage(g.JSON, err.Error())
		}
		req.ActorProfile = profile
	} else if strings.TrimSpace(req.ActorProfile) != "" {
		trimmed := strings.TrimSpace(req.ActorProfile)
		if !actorProfileRe.MatchString(trimmed) {
			return failUsage(g.JSON, fmt.Sprintf("invalid actor_profile %q (must match ^[a-z0-9][a-z0-9._@-]{0,39}$)", trimmed))
		}
		req.ActorProfile = trimmed
	} else {
		profile, err := resolveActorProfile("")
		if err != nil {
			return failUsage(g.JSON, err.Error())
		}
		req.ActorProfile = profile
	}

	client, err := newClient(g)
	if err != nil {
		return failErr(g.JSON, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	res, err := client.CreatePlan(ctx, req)
	if err != nil {
		return failErr(g.JSON, err)
	}
	for i := range res.Runs {
		res.Runs[i] = sanitizeRunRecord(res.Runs[i], false)
	}

	if g.JSON {
		writeJSON(res)
	} else {
		dedupSuffix := ""
		if res.Deduplicated != nil && *res.Deduplicated {
			dedupSuffix = " deduplicated=true"
		}
		fmt.Printf("Plan %s (runs=%d%s)\n", res.PlanID, len(res.Runs), dedupSuffix)
		for _, r := range res.Runs {
			key := ""
			if r.PlanKey != nil {
				key = *r.PlanKey
			}
			fmt.Printf("  %s  %-14s %-10s %-10s %s\n", r.ID, key, r.Status, r.NodeID, r.Agent)
		}
	}
	return api.ExitOK
}

func runRetry(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("retry", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var modelFlag, effortFlag, asFlag, idemFlag string
	var timeoutDur time.Duration
	fs.StringVar(&modelFlag, "m", "", "model or model@effort")
	fs.StringVar(&modelFlag, "model", "", "model or model@effort")
	fs.StringVar(&effortFlag, "effort", "", "effort level")
	fs.DurationVar(&timeoutDur, "timeout", 0, "run timeout (10s..7200s)")
	fs.StringVar(&asFlag, "as", "", "actor profile attribution")
	fs.StringVar(&idemFlag, "idempotency-key", "", "idempotency key (8..128 chars)")

	valFlags := boardValueFlags("--model", "--effort", "--timeout", "--as", "--idempotency-key")
	valFlags["-m"] = true
	if err := parseFlagsFlexible(fs, args, valFlags); err != nil {
		return api.ExitBadUsageOrInput
	}
	if fs.NArg() != 1 || strings.TrimSpace(fs.Arg(0)) == "" {
		return failUsage(g.JSON, "usage: ahub retry <run_id> [--model <m@e>] [--effort <e>] [--timeout <dur>] [--as <profile>] [--idempotency-key <k>] [--json]")
	}
	runID := strings.TrimSpace(fs.Arg(0))

	var timeoutSet bool
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "timeout" {
			timeoutSet = true
		}
	})

	timeoutSec := 0
	if timeoutSet {
		if timeoutDur < 10*time.Second || timeoutDur > 7200*time.Second {
			return failUsage(g.JSON, "--timeout must be between 10s and 7200s")
		}
		timeoutSec = int(timeoutDur.Seconds())
	}

	model, effort := runner.SplitModelAndEffort(modelFlag, effortFlag)
	if !isValidEffort(effort) {
		return failUsage(g.JSON, fmt.Sprintf("invalid --effort %q (expected off|minimal|low|medium|high|xhigh|max|ultra|auto)", effort))
	}

	actorProfile, err := resolveActorProfile(asFlag)
	if err != nil {
		return failUsage(g.JSON, err.Error())
	}
	idemKey, err := validateIdempotencyKey(idemFlag)
	if err != nil {
		return failUsage(g.JSON, err.Error())
	}

	client, err := newClient(g)
	if err != nil {
		return failErr(g.JSON, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	res, err := client.RetryRun(ctx, runID, api.RetryRunRequest{
		IdempotencyKey: idemKey,
		Model:          model,
		Effort:         effort,
		TimeoutSec:     timeoutSec,
		ActorProfile:   actorProfile,
	})
	if err != nil {
		return failErr(g.JSON, err)
	}
	res.Run = sanitizeRunRecord(res.Run, false)
	if res.ReboundRunIDs == nil {
		res.ReboundRunIDs = []string{}
	}

	if g.JSON {
		writeJSON(res)
	} else {
		fmt.Printf("Retried %s -> %s [%s] rebound=%d\n", runID, res.Run.ID, res.Run.Status, len(res.ReboundRunIDs))
	}
	return api.ExitOK
}

func validateBoardTopicID(raw string) error {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	if !boardTopicIDRe.MatchString(trimmed) {
		return fmt.Errorf("invalid --topic %q (must match ^top_[A-Za-z0-9]+$)", trimmed)
	}
	return nil
}

func validatePlanID(raw string) error {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	if !planIDRe.MatchString(trimmed) {
		return fmt.Errorf("invalid --plan %q (must match ^pln_[A-Za-z0-9]+$)", trimmed)
	}
	return nil
}

func isValidRunStatus(status string) bool {
	switch status {
	case "waiting", "queued", "claimed", "running", "needs_approval", "done", "failed", "cancelled":
		return true
	default:
		return false
	}
}

func isValidEffort(effort string) bool {
	switch effort {
	case "", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "auto":
		return true
	default:
		return false
	}
}

func parseAfterRunIDs(rawFlags []string) ([]string, error) {
	if len(rawFlags) == 0 {
		return nil, nil
	}
	seen := make(map[string]bool, len(rawFlags))
	out := make([]string, 0, len(rawFlags))
	for _, entry := range rawFlags {
		parts := strings.Split(entry, ",")
		for _, part := range parts {
			id := strings.TrimSpace(part)
			if id == "" {
				return nil, errors.New("--after contains an empty run_id")
			}
			if !runIDStrictRe.MatchString(id) {
				return nil, fmt.Errorf("invalid --after run_id %q (must match ^run_[A-Za-z0-9]+$)", id)
			}
			if !seen[id] {
				seen[id] = true
				out = append(out, id)
				if len(out) > planMaxNodeDeps {
					return nil, fmt.Errorf("--after accepts at most %d unique run IDs", planMaxNodeDeps)
				}
			}
		}
	}
	return out, nil
}

func parseDelayDuration(raw string) (time.Duration, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return 0, errors.New("--in duration cannot be empty")
	}
	if strings.HasPrefix(s, "-") || strings.HasPrefix(s, "+") {
		return 0, fmt.Errorf("invalid --in duration %q (must be a positive duration in 1m..7d)", raw)
	}
	// Expand '<num>d' day segments into hours so time.ParseDuration handles mixed specs like 1d12h.
	var normalized strings.Builder
	i := 0
	for i < len(s) {
		numStart := i
		dotSeen := false
		for i < len(s) && ((s[i] >= '0' && s[i] <= '9') || (s[i] == '.' && !dotSeen)) {
			if s[i] == '.' {
				dotSeen = true
			}
			i++
		}
		if i == numStart {
			return 0, fmt.Errorf("invalid --in duration %q", raw)
		}
		numStr := s[numStart:i]
		unitStart := i
		for i < len(s) && (s[i] < '0' || s[i] > '9') && s[i] != '.' {
			i++
		}
		unit := s[unitStart:i]
		if unit == "" {
			return 0, fmt.Errorf("missing unit in --in duration %q", raw)
		}
		if unit == "d" {
			days, err := strconv.ParseFloat(numStr, 64)
			if err != nil || days <= 0 {
				return 0, fmt.Errorf("invalid --in duration %q", raw)
			}
			hours := days * 24
			normalized.WriteString(strconv.FormatFloat(hours, 'f', -1, 64))
			normalized.WriteByte('h')
		} else {
			normalized.WriteString(numStr)
			normalized.WriteString(unit)
		}
	}
	dur, err := time.ParseDuration(normalized.String())
	if err != nil {
		return 0, fmt.Errorf("invalid --in duration %q: %w", raw, err)
	}
	if dur < delayMin || dur > delayMax {
		return 0, fmt.Errorf("--in duration %q must be between 1m and 7d", raw)
	}
	return dur, nil
}

func computeScheduledAt(dur time.Duration) string {
	effective := dur
	if effective < 62*time.Second {
		effective += delaySkewBuffer
	}
	if effective > delayMax-delaySkewBuffer {
		effective -= delaySkewBuffer
	}
	return time.Now().UTC().Add(effective).Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}
