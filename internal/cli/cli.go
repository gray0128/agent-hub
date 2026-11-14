package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/gray0128/agent-hub/internal/api"
	"github.com/gray0128/agent-hub/internal/config"
	"github.com/gray0128/agent-hub/internal/daemon"
	"github.com/gray0128/agent-hub/internal/runner"
	"github.com/gray0128/agent-hub/internal/selfupdate"
	"github.com/gray0128/agent-hub/internal/service"
	"github.com/gray0128/agent-hub/skills"
)

type globalOpts struct {
	URL   string
	Token string
	JSON  bool
}

type stringSliceFlag []string

func (s *stringSliceFlag) String() string {
	return strings.Join(*s, ",")
}

func (s *stringSliceFlag) Set(v string) error {
	trimmed := strings.TrimSpace(v)
	if trimmed != "" {
		*s = append(*s, trimmed)
	}
	return nil
}

func Execute(args []string, version string) int {
	g, rest := extractGlobalFlags(args)
	if len(rest) == 0 {
		printRootUsage()
		return api.ExitBadUsageOrInput
	}

	sub := rest[0]
	subArgs := rest[1:]

	switch sub {
	case "-h", "--help", "help":
		printRootUsage()
		return api.ExitOK
	case "version", "--version":
		if g.JSON {
			writeJSON(map[string]string{"version": version})
		} else {
			fmt.Println(version)
		}
		return api.ExitOK
	case "auth":
		return runAuth(g, subArgs)
	case "nodes":
		return runNodes(g, subArgs)
	case "run":
		return runRun(g, subArgs)
	case "wait":
		return runWait(g, subArgs)
	case "result":
		return runResult(g, subArgs)
	case "runs":
		return runRuns(g, subArgs)
	case "threads":
		return runThreads(g, subArgs)
	case "cancel":
		return runCancel(g, subArgs)
	case "skill":
		return runSkill(g, subArgs)
	case "update":
		return runUpdate(g, subArgs, version)
	case "node":
		return runNode(g, subArgs, version)
	default:
		return failUsage(g.JSON, fmt.Sprintf("unknown subcommand %q", sub))
	}
}

func extractGlobalFlags(args []string) (globalOpts, []string) {
	var g globalOpts
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			out = append(out, args[i:]...)
			break
		}
		if a == "--json" {
			g.JSON = true
			continue
		}
		if strings.HasPrefix(a, "--url=") {
			g.URL = strings.TrimPrefix(a, "--url=")
			continue
		}
		if a == "--url" && i+1 < len(args) {
			g.URL = args[i+1]
			i++
			continue
		}
		if strings.HasPrefix(a, "--token=") {
			g.Token = strings.TrimPrefix(a, "--token=")
			continue
		}
		if a == "--token" && i+1 < len(args) {
			g.Token = args[i+1]
			i++
			continue
		}
		out = append(out, a)
	}
	return g, out
}

func parseFlagsFlexible(fs *flag.FlagSet, args []string, valueFlags map[string]bool) error {
	reordered := make([]string, 0, len(args))
	pos := make([]string, 0, 4)
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			pos = append(pos, args[i:]...)
			break
		}
		if a == "-" || !strings.HasPrefix(a, "-") {
			pos = append(pos, a)
			continue
		}
		reordered = append(reordered, a)
		if !strings.Contains(a, "=") && valueFlags[a] && i+1 < len(args) {
			reordered = append(reordered, args[i+1])
			i++
		}
	}
	reordered = append(reordered, pos...)
	return fs.Parse(reordered)
}

func newClient(g globalOpts) (*api.Client, error) {
	hubURL, token, err := config.ResolveCredentials(g.URL, g.Token)
	if err != nil {
		return nil, err
	}
	return api.NewClient(hubURL, token), nil
}

func runAuth(g globalOpts, args []string) int {
	if len(args) == 0 || args[0] != "login" {
		return failUsage(g.JSON, "usage: ahub auth login --url <url> --token <token>")
	}
	fs := flag.NewFlagSet("auth login", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var urlFlag, tokenFlag string
	fs.StringVar(&urlFlag, "url", "", "hub url")
	fs.StringVar(&tokenFlag, "token", "", "api token")
	if err := parseFlagsFlexible(fs, args[1:], map[string]bool{"--url": true, "--token": true}); err != nil {
		return api.ExitBadUsageOrInput
	}
	hubURL := firstNonEmpty(urlFlag, g.URL, os.Getenv("AHUB_URL"), config.DefaultHubURL)
	token := firstNonEmpty(tokenFlag, g.Token, os.Getenv("AHUB_TOKEN"))
	if token == "" {
		return failUsage(g.JSON, "--token is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client := api.NewClient(hubURL, token)
	me, err := client.AuthMe(ctx)
	if err != nil {
		return failErr(g.JSON, err)
	}
	if err := config.SaveCredentials(hubURL, token); err != nil {
		return failErr(g.JSON, err)
	}
	if g.JSON {
		writeJSON(map[string]interface{}{"ok": true, "url": hubURL, "principal": me["principal"]})
	} else {
		fmt.Printf("Authenticated against %s\n", hubURL)
	}
	return api.ExitOK
}

func runNodes(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("nodes", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var online bool
	fs.BoolVar(&online, "online", false, "only online nodes")
	if err := parseFlagsFlexible(fs, args, map[string]bool{}); err != nil {
		return api.ExitBadUsageOrInput
	}
	client, err := newClient(g)
	if err != nil {
		return failErr(g.JSON, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	nodes, err := client.ListNodes(ctx, online)
	if err != nil {
		return failErr(g.JSON, err)
	}
	if g.JSON {
		writeJSON(map[string]interface{}{"ok": true, "nodes": nodes})
	} else {
		for _, n := range nodes {
			fmt.Printf("%-14s %-8s %d/%d  workspaces=%d\n", n.ID, n.Status, n.ActiveRunsCount, n.MaxConcurrency, len(n.Workspaces))
		}
	}
	return api.ExitOK
}

func runRun(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var nodeID, dir, agent, modelFlag, effortFlag, threadID, notifyTarget, idemKey, title string
	var noSandbox bool
	var timeoutDur, waitDur time.Duration

	fs.StringVar(&nodeID, "n", "", "node id")
	fs.StringVar(&nodeID, "node", "", "node id")
	fs.StringVar(&dir, "d", "", "workdir or project key")
	fs.StringVar(&dir, "dir", "", "workdir or project key")
	fs.StringVar(&agent, "a", "", "agent")
	fs.StringVar(&agent, "agent", "", "agent")
	fs.StringVar(&modelFlag, "m", "", "model or model@effort")
	fs.StringVar(&modelFlag, "model", "", "model or model@effort")
	fs.StringVar(&effortFlag, "effort", "", "effort level")
	fs.StringVar(&threadID, "thread", "", "existing thread id")
	fs.StringVar(&title, "title", "", "thread title")
	fs.StringVar(&notifyTarget, "notify", "", "notify target (grok|webhook)")
	fs.StringVar(&idemKey, "idempotency-key", "", "idempotency key")
	fs.BoolVar(&noSandbox, "no-sandbox", false, "disable sandbox")
	fs.DurationVar(&timeoutDur, "timeout", 15*time.Minute, "run timeout")
	fs.DurationVar(&waitDur, "wait", 45*time.Second, "wait timeout")

	valFlags := map[string]bool{
		"-n": true, "--node": true, "-d": true, "--dir": true,
		"-a": true, "--agent": true, "-m": true, "--model": true,
		"--effort": true, "--thread": true, "--title": true,
		"--notify": true, "--idempotency-key": true,
		"--timeout": true, "--wait": true,
	}
	if err := parseFlagsFlexible(fs, args, valFlags); err != nil {
		return api.ExitBadUsageOrInput
	}

	pos := fs.Args()
	if len(pos) == 0 {
		return failUsage(g.JSON, "prompt argument or '-' (stdin) is required")
	}
	var prompt string
	if pos[0] == "-" {
		raw, err := io.ReadAll(os.Stdin)
		if err != nil {
			return failErr(g.JSON, err)
		}
		prompt = string(raw)
	} else {
		prompt = strings.Join(pos, " ")
	}
	if strings.TrimSpace(prompt) == "" {
		return failUsage(g.JSON, "prompt cannot be empty")
	}

	if threadID == "" && (nodeID == "" || dir == "" || agent == "") {
		return failUsage(g.JSON, "-n <node>, -d <dir>, and -a <agent> are required unless --thread is specified")
	}

	model, effort := runner.SplitModelAndEffort(modelFlag, effortFlag)
	sandbox := !noSandbox
	timeoutSec := int(timeoutDur.Seconds())
	if timeoutSec < 10 {
		timeoutSec = 10
	}
	if timeoutSec > 7200 {
		timeoutSec = 7200
	}

	req := api.CreateRunRequest{
		ThreadID:       threadID,
		NodeID:         nodeID,
		Workdir:        dir,
		Agent:          agent,
		Model:          model,
		Effort:         effort,
		Sandbox:        &sandbox,
		TimeoutSec:     timeoutSec,
		Prompt:         prompt,
		Title:          title,
		ParentRunID:    strings.TrimSpace(os.Getenv("AHUB_RUN_ID")),
		IdempotencyKey: idemKey,
	}
	if notifyTarget != "" {
		req.Notify = &api.NotifyConfig{Target: notifyTarget}
	}

	client, err := newClient(g)
	if err != nil {
		return failErr(g.JSON, err)
	}

	started := time.Now()
	httpWaitMs := int(waitDur.Milliseconds())
	if httpWaitMs > 45000 {
		httpWaitMs = 45000
	}
	if httpWaitMs < 0 {
		httpWaitMs = 0
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(httpWaitMs)*time.Millisecond+20*time.Second)
	defer cancel()

	run, _, err := client.CreateRun(ctx, req, httpWaitMs)
	if err != nil {
		return failErr(g.JSON, err)
	}

	if isWaitStopState(run.Status) {
		outputRunResult(g.JSON, run)
		return api.ExitCodeForRunStatus(run.Status)
	}

	if notifyTarget != "" && notifyTarget != "none" {
		armed := true
		run.WebhookArmed = &armed
		outputRunResult(g.JSON, run)
		return api.ExitOK
	}

	remaining := waitDur - time.Since(started)
	if waitDur > 0 && remaining > 0 {
		waitedRun, err := waitViaStream(client, run.ID, remaining)
		if err == nil && waitedRun != nil {
			run = waitedRun
		}
	}

	outputRunResult(g.JSON, run)
	if isWaitStopState(run.Status) {
		return api.ExitCodeForRunStatus(run.Status)
	}
	return api.ExitWaitTimeout
}

func runWait(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("wait", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var timeoutDur time.Duration
	fs.DurationVar(&timeoutDur, "timeout", 15*time.Minute, "wait timeout")
	if err := parseFlagsFlexible(fs, args, map[string]bool{"--timeout": true}); err != nil {
		return api.ExitBadUsageOrInput
	}
	if fs.NArg() < 1 {
		return failUsage(g.JSON, "usage: ahub wait <run_id> [--timeout 15m] [--json]")
	}
	runID := fs.Arg(0)

	client, err := newClient(g)
	if err != nil {
		return failErr(g.JSON, err)
	}

	run, err := waitViaStream(client, runID, timeoutDur)
	if err != nil {
		return failErr(g.JSON, err)
	}
	outputRunResult(g.JSON, run)
	if isWaitStopState(run.Status) {
		return api.ExitCodeForRunStatus(run.Status)
	}
	return api.ExitWaitTimeout
}

func waitViaStream(client *api.Client, runID string, timeout time.Duration) (*api.RunRecord, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	var latest *api.RunRecord
	for {
		if ctx.Err() != nil {
			break
		}
		conn, err := client.DialWebSocket(ctx, "/ws/stream?run_id="+runID)
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			// Fallback check via GET in case run already finished
			if r, getErr := client.GetRun(ctx, runID, false, 16384); getErr == nil {
				latest = r
				if isWaitStopState(r.Status) {
					return r, nil
				}
			}
			select {
			case <-ctx.Done():
				return latest, nil
			case <-time.After(500 * time.Millisecond):
				continue
			}
		}

		for {
			_, data, readErr := conn.Read(ctx)
			if readErr != nil {
				_ = conn.CloseNow()
				break
			}
			var envelope struct {
				Type string          `json:"type"`
				Runs []api.RunRecord `json:"runs"`
				Run  *api.RunRecord  `json:"run"`
			}
			if json.Unmarshal(data, &envelope) != nil {
				continue
			}
			switch envelope.Type {
			case "snapshot":
				for i := range envelope.Runs {
					if envelope.Runs[i].ID == runID {
						cp := envelope.Runs[i]
						latest = &cp
						if isWaitStopState(cp.Status) {
							_ = conn.CloseNow()
							if cp.Status == "needs_approval" {
								return latest, nil
							}
							if fullR, gErr := client.GetRun(context.Background(), runID, false, 16384); gErr == nil {
								return fullR, nil
							}
							return latest, nil
						}
					}
				}
			case "run.updated":
				if envelope.Run != nil && envelope.Run.ID == runID {
					latest = envelope.Run
					if isWaitStopState(latest.Status) {
						_ = conn.CloseNow()
						if latest.Status == "needs_approval" {
							return latest, nil
						}
						if fullR, gErr := client.GetRun(context.Background(), runID, false, 16384); gErr == nil {
							return fullR, nil
						}
						return latest, nil
					}
				}
			}
		}
	}

	// Final fetch on timeout
	fetchCtx, fetchCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer fetchCancel()
	if r, err := client.GetRun(fetchCtx, runID, false, 16384); err == nil {
		return r, nil
	}
	return latest, nil
}

func runResult(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("result", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var full bool
	var tail int
	fs.BoolVar(&full, "full", false, "return full output_md")
	fs.IntVar(&tail, "tail", 16384, "tail bytes for summary preview")
	if err := parseFlagsFlexible(fs, args, map[string]bool{"--tail": true}); err != nil {
		return api.ExitBadUsageOrInput
	}
	if fs.NArg() < 1 {
		return failUsage(g.JSON, "usage: ahub result <run_id> [--full] [--tail 16384] [--json]")
	}
	runID := fs.Arg(0)

	client, err := newClient(g)
	if err != nil {
		return failErr(g.JSON, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	run, err := client.GetRun(ctx, runID, full, tail)
	if err != nil {
		return failErr(g.JSON, err)
	}
	outputRunResult(g.JSON, run)
	if isWaitStopState(run.Status) {
		return api.ExitCodeForRunStatus(run.Status)
	}
	return api.ExitOK
}

func runRuns(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("runs", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var nodeID, status string
	var limit int
	fs.StringVar(&nodeID, "node", "", "filter by node id")
	fs.StringVar(&status, "status", "", "filter by status")
	fs.IntVar(&limit, "limit", 20, "limit")
	if err := parseFlagsFlexible(fs, args, map[string]bool{"--node": true, "--status": true, "--limit": true}); err != nil {
		return api.ExitBadUsageOrInput
	}
	client, err := newClient(g)
	if err != nil {
		return failErr(g.JSON, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	runs, err := client.ListRuns(ctx, nodeID, status, limit)
	if err != nil {
		return failErr(g.JSON, err)
	}
	if g.JSON {
		writeJSON(map[string]interface{}{"ok": true, "runs": runs})
	} else {
		for _, r := range runs {
			fmt.Printf("%s  %-14s %-10s %-6s %s\n", r.ID, r.Status, r.NodeID, r.Agent, r.Summary)
		}
	}
	return api.ExitOK
}

func runThreads(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("threads", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var nodeID, keyword string
	var limit int
	fs.StringVar(&nodeID, "node", "", "filter by node")
	fs.StringVar(&keyword, "q", "", "keyword search")
	fs.IntVar(&limit, "limit", 50, "limit")
	if err := parseFlagsFlexible(fs, args, map[string]bool{"--node": true, "--q": true, "--limit": true}); err != nil {
		return api.ExitBadUsageOrInput
	}
	client, err := newClient(g)
	if err != nil {
		return failErr(g.JSON, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	threads, err := client.ListThreads(ctx, nodeID, keyword, limit)
	if err != nil {
		return failErr(g.JSON, err)
	}
	if g.JSON {
		writeJSON(map[string]interface{}{"ok": true, "threads": threads})
	} else {
		for _, t := range threads {
			fmt.Printf("%s  %-10s %-6s %-16s %s\n", t.ID, t.NodeID, t.Agent, t.ProjectKey, t.Title)
		}
	}
	return api.ExitOK
}

func runCancel(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("cancel", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var cascade bool
	var reason string
	fs.BoolVar(&cascade, "cascade", false, "cascade cancel entire root_run_id tree")
	fs.StringVar(&reason, "reason", "Cancelled by user", "cancel reason")
	if err := parseFlagsFlexible(fs, args, map[string]bool{"--reason": true}); err != nil {
		return api.ExitBadUsageOrInput
	}
	if fs.NArg() < 1 {
		return failUsage(g.JSON, "usage: ahub cancel <run_id> [--cascade] [--reason <text>] [--json]")
	}
	runID := fs.Arg(0)

	client, err := newClient(g)
	if err != nil {
		return failErr(g.JSON, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cancelled, err := client.CancelRun(ctx, runID, cascade, reason)
	if err != nil {
		return failErr(g.JSON, err)
	}
	if g.JSON {
		writeJSON(map[string]interface{}{"ok": true, "cancelled_runs": cancelled})
	} else {
		for _, r := range cancelled {
			fmt.Printf("Cancelled %s (%s)\n", r.ID, r.Status)
		}
	}
	return api.ExitOK
}

func runSkill(g globalOpts, args []string) int {
	if len(args) == 0 {
		return failUsage(g.JSON, "usage: ahub skill print | install [--dir <path>]")
	}
	switch args[0] {
	case "print":
		fmt.Print(skills.AhubSkillMD)
		return api.ExitOK
	case "install":
		fs := flag.NewFlagSet("skill install", flag.ContinueOnError)
		fs.SetOutput(os.Stderr)
		var dir string
		fs.StringVar(&dir, "dir", "", "target skill directory")
		if err := parseFlagsFlexible(fs, args[1:], map[string]bool{"--dir": true}); err != nil {
			return api.ExitBadUsageOrInput
		}
		if dir == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return failErr(g.JSON, err)
			}
			dir = filepath.Join(home, ".agents", "skills", "ahub")
		} else {
			dir = config.ExpandPath(dir)
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return failErr(g.JSON, err)
		}
		dest := filepath.Join(dir, "SKILL.md")
		if err := os.WriteFile(dest, []byte(skills.AhubSkillMD), 0o644); err != nil {
			return failErr(g.JSON, err)
		}
		if g.JSON {
			writeJSON(map[string]interface{}{"ok": true, "path": dest})
		} else {
			fmt.Printf("Installed skill to %s\n", dest)
		}
		return api.ExitOK
	default:
		return failUsage(g.JSON, "usage: ahub skill print | install [--dir <path>]")
	}
}

func runUpdate(g globalOpts, args []string, version string) int {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var checkOnly bool
	var target string
	var noRestart bool
	fs.BoolVar(&checkOnly, "check", false, "check only")
	fs.StringVar(&target, "target", "", "override binary path")
	fs.BoolVar(&noRestart, "no-restart", false, "skip automatic daemon reload after updating")
	if err := parseFlagsFlexible(fs, args, map[string]bool{"--target": true}); err != nil {
		return api.ExitBadUsageOrInput
	}
	client, err := newClient(g)
	if err != nil {
		return failErr(g.JSON, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	res, err := selfupdate.CheckAndApply(ctx, client, version, checkOnly, target)
	if err != nil {
		return failErr(g.JSON, err)
	}
	if res.Updated {
		if noRestart {
			res.ReloadMode = "skipped_no_restart"
		} else if strings.TrimSpace(target) != "" {
			res.ReloadMode = "skipped_target_override"
		} else {
			restarted, mode := service.RefreshAndReloadAfterUpdate()
			res.DaemonRestarted = restarted
			res.ReloadMode = mode
		}
		if runtime.GOOS == "darwin" {
			info := service.InspectDarwinDaemonApp("")
			if info.Exists {
				res.DaemonAppPath = info.AppPath
			}
		}
	}
	if g.JSON {
		writeJSON(res)
	} else {
		fmt.Printf("current=%s latest=%s updated=%v daemon_restarted=%v reload_mode=%s\n",
			res.CurrentVersion, res.LatestVersion, res.Updated, res.DaemonRestarted, res.ReloadMode)
	}
	return api.ExitOK
}

func runNode(g globalOpts, args []string, version string) int {
	if len(args) == 0 {
		return failUsage(g.JSON, "usage: ahub node init|status|serve|shim|service ...")
	}
	switch args[0] {
	case "init":
		return runNodeInit(g, args[1:])
	case "status":
		return runNodeStatus(g, args[1:])
	case "serve":
		fs := flag.NewFlagSet("node serve", flag.ContinueOnError)
		fs.SetOutput(os.Stderr)
		var cfgPath string
		fs.StringVar(&cfgPath, "config", "", "node.json config path")
		if err := parseFlagsFlexible(fs, args[1:], map[string]bool{"--config": true}); err != nil {
			return api.ExitBadUsageOrInput
		}
		cfg, err := config.LoadNodeConfig(cfgPath)
		if err != nil {
			return failErr(g.JSON, err)
		}
		_, cfgResolved, _, _ := config.LoadNodeConfigRaw(cfgPath)
		if g.URL != "" {
			cfg.HubURL = strings.TrimRight(g.URL, "/")
		} else if envURL := strings.TrimSpace(os.Getenv("AHUB_URL")); envURL != "" {
			cfg.HubURL = strings.TrimRight(envURL, "/")
		}
		_, resolvedToken, _ := config.ResolveCredentials(g.URL, g.Token)
		if resolvedToken == "" {
			resolvedToken = cfg.Token
		}
		if resolvedToken == "" {
			return failUsage(g.JSON, "node token missing (set AHUB_TOKEN, --token, or node.json token)")
		}

		if _, err := daemon.WritePIDFile(cfgResolved); err != nil {
			fmt.Fprintf(os.Stderr, "[ahub node] warning: write pid file failed: %v\n", err)
		} else {
			defer daemon.RemovePIDFile(cfgResolved, os.Getpid())
		}

		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer stop()

		d := daemon.New(cfg, resolvedToken, version)
		reloadCh := make(chan os.Signal, 1)
		daemon.NotifyReloadSignal(reloadCh)
		defer daemon.StopReloadSignal(reloadCh)
		go func() {
			select {
			case <-reloadCh:
				d.RequestReload()
			case <-ctx.Done():
			}
		}()

		if err := d.Run(ctx); err != nil {
			if errors.Is(err, daemon.ErrReloadRequested) {
				return daemon.ExitReload
			}
			return failErr(g.JSON, err)
		}
		return api.ExitOK

	case "shim":
		fs := flag.NewFlagSet("node shim", flag.ContinueOnError)
		fs.SetOutput(os.Stderr)
		var binPath, cfgPath string
		var selfTest bool
		fs.StringVar(&binPath, "bin", "", "target ahub executable path")
		fs.StringVar(&cfgPath, "config", "", "node.json config path")
		fs.BoolVar(&selfTest, "self-test", false, "verify shim executable invocation and exit")
		if err := parseFlagsFlexible(fs, args[1:], map[string]bool{"--bin": true, "--config": true}); err != nil {
			return api.ExitBadUsageOrInput
		}
		if strings.TrimSpace(cfgPath) == "" {
			if defCfg, err := config.DefaultNodeConfigPath(); err == nil {
				cfgPath = defCfg
			}
		} else {
			cfgPath = config.ExpandPath(cfgPath)
		}
		if strings.TrimSpace(binPath) != "" {
			binPath = config.ExpandPath(binPath)
		}
		if selfTest {
			if binPath != "" {
				if _, err := os.Stat(binPath); err != nil {
					return failErr(g.JSON, err)
				}
			}
			if g.JSON {
				writeJSON(map[string]interface{}{
					"ok":          true,
					"shim":        true,
					"pid":         os.Getpid(),
					"bin_path":    binPath,
					"config_path": cfgPath,
				})
			} else {
				fmt.Printf("shim ok pid=%d bin=%s config=%s\n", os.Getpid(), binPath, cfgPath)
			}
			return api.ExitOK
		}
		return service.RunShim(binPath, cfgPath)

	case "service":
		if len(args) < 2 {
			return failUsage(g.JSON, "usage: ahub node service install|uninstall|status [--config <path>] [--target-dir <dir>] [--bin <path>] [--recreate-app] [--activate]")
		}
		sub := args[1]
		fs := flag.NewFlagSet("node service", flag.ContinueOnError)
		fs.SetOutput(os.Stderr)
		var cfgPath, targetDir, binPath string
		var activate, recreateApp bool
		fs.StringVar(&cfgPath, "config", "", "node.json path")
		fs.StringVar(&targetDir, "target-dir", "", "override destination directory")
		fs.StringVar(&binPath, "bin", "", "override ahub binary path")
		fs.BoolVar(&activate, "activate", false, "register with launchctl/systemctl")
		fs.BoolVar(&recreateApp, "recreate-app", false, "force rebuild & re-sign macOS AhubDaemon.app wrapper")
		if err := parseFlagsFlexible(fs, args[2:], map[string]bool{"--config": true, "--target-dir": true, "--bin": true}); err != nil {
			return api.ExitBadUsageOrInput
		}

		switch sub {
		case "install":
			res, err := service.InstallWithOptions(service.InstallOptions{
				BinPath:     binPath,
				ConfigPath:  cfgPath,
				TargetDir:   targetDir,
				Activate:    activate,
				RecreateApp: recreateApp,
			})
			if err != nil {
				return failErr(g.JSON, err)
			}
			if g.JSON {
				payload := map[string]interface{}{"ok": true, "path": res.ServicePath}
				if res.DaemonApp.AppPath != "" {
					payload["daemon_app_path"] = res.DaemonApp.AppPath
					payload["daemon_app_signed"] = res.DaemonApp.Signed
					payload["daemon_app_cdhash"] = res.DaemonApp.CDHash
				}
				writeJSON(payload)
			} else {
				fmt.Printf("Service unit written to %s\n", res.ServicePath)
				if res.DaemonApp.AppPath != "" {
					fmt.Printf("Darwin TCC wrapper: %s (signed=%v cdhash=%s)\n",
						res.DaemonApp.AppPath, res.DaemonApp.Signed, res.DaemonApp.CDHash)
				}
			}
			return api.ExitOK
		case "uninstall":
			dest, err := service.Uninstall(targetDir, activate)
			if err != nil {
				return failErr(g.JSON, err)
			}
			if g.JSON {
				writeJSON(map[string]interface{}{"ok": true, "removed": dest})
			} else {
				fmt.Printf("Service unit removed: %s\n", dest)
			}
			return api.ExitOK
		case "status":
			dest, err := service.ServiceFilePath(targetDir)
			if err != nil {
				return failErr(g.JSON, err)
			}
			_, statErr := os.Stat(dest)
			installed := statErr == nil
			if g.JSON {
				writeJSON(map[string]interface{}{"ok": true, "path": dest, "installed": installed})
			} else {
				fmt.Printf("path=%s installed=%v\n", dest, installed)
			}
			return api.ExitOK
		default:
			return failUsage(g.JSON, "usage: ahub node service install|uninstall|status")
		}

	default:
		return failUsage(g.JSON, "usage: ahub node init|status|serve|service")
	}
}

func runNodeInit(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("node init", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var idFlag, nameFlag, urlFlag, tokenFlag, cfgPath string
	var tokenStdin, force bool
	var maxConcFlag int
	var roots stringSliceFlag

	fs.StringVar(&idFlag, "id", "", "node id")
	fs.StringVar(&nameFlag, "name", "", "display name")
	fs.StringVar(&urlFlag, "url", "", "hub url")
	fs.StringVar(&tokenFlag, "token", "", "node api token")
	fs.BoolVar(&tokenStdin, "token-stdin", false, "read node token from stdin")
	fs.Var(&roots, "root", "project root directory (repeatable)")
	fs.IntVar(&maxConcFlag, "max-concurrency", 0, "max concurrent runs")
	fs.StringVar(&cfgPath, "config", "", "node.json config path")
	fs.BoolVar(&force, "force", false, "overwrite existing node.json fields")

	valFlags := map[string]bool{
		"--id": true, "--name": true, "--url": true, "--token": true,
		"--root": true, "--max-concurrency": true, "--config": true,
	}
	if err := parseFlagsFlexible(fs, args, valFlags); err != nil {
		return api.ExitBadUsageOrInput
	}

	if tokenStdin {
		raw, err := io.ReadAll(os.Stdin)
		if err != nil {
			return failErr(g.JSON, err)
		}
		stdinTok := strings.TrimSpace(string(raw))
		if stdinTok == "" {
			return failUsage(g.JSON, "token read from stdin is empty")
		}
		tokenFlag = stdinTok
	}

	loaded, _, existed, loadErr := config.LoadNodeConfigRaw(cfgPath)
	if !force && loadErr != nil {
		return failErr(g.JSON, loadErr)
	}
	var existing config.NodeConfig
	if !force && loaded != nil {
		existing = *loaded
	}

	nodeID := firstNonEmpty(idFlag, existing.NodeID, config.DefaultNodeID())
	displayName := firstNonEmpty(nameFlag, existing.DisplayName, nodeID)
	hubURL := strings.TrimRight(firstNonEmpty(urlFlag, g.URL, os.Getenv("AHUB_URL"), existing.HubURL, config.DefaultHubURL), "/")
	token := firstNonEmpty(tokenFlag, g.Token, existing.Token)

	maxConc := maxConcFlag
	if maxConc <= 0 {
		maxConc = existing.MaxConcurrency
	}
	if maxConc <= 0 {
		maxConc = 4
	}

	projectRoots := []string(roots)
	if len(projectRoots) == 0 {
		projectRoots = existing.ProjectRoots
	}
	if len(projectRoots) == 0 {
		projectRoots = config.DetectProjectRoots()
	}

	skipDirs := existing.SkipDirs
	if len(skipDirs) == 0 {
		skipDirs = []string{"Library", "Applications", "node_modules"}
	}

	remoteControlName := firstNonEmpty(existing.RemoteControlName, nodeID)
	agents := config.DetectAgents(existing.Agents, exec.LookPath)

	cfg := &config.NodeConfig{
		NodeID:               nodeID,
		DisplayName:          displayName,
		HubURL:               hubURL,
		Token:                token,
		DelegationToken:      existing.DelegationToken,
		MaxConcurrency:       maxConc,
		HeartbeatIntervalSec: existing.HeartbeatIntervalSec,
		ProjectRoots:         projectRoots,
		SkipDirs:             skipDirs,
		RemoteControlName:    remoteControlName,
		Agents:               agents,
	}

	savedPath, err := config.SaveNodeConfig(cfgPath, cfg)
	if err != nil {
		return failErr(g.JSON, err)
	}

	hasToken := strings.TrimSpace(cfg.Token) != ""
	enabledAgents := config.EnabledAgentNames(cfg.Agents)
	if g.JSON {
		writeJSON(map[string]interface{}{
			"ok":              true,
			"config_path":     savedPath,
			"created":         !existed,
			"node_id":         cfg.NodeID,
			"display_name":    cfg.DisplayName,
			"hub_url":         cfg.HubURL,
			"max_concurrency": cfg.MaxConcurrency,
			"project_roots":   cfg.ProjectRoots,
			"enabled_agents":  enabledAgents,
			"has_token":       hasToken,
		})
	} else {
		fmt.Printf("Node config written to %s (node_id=%s, has_token=%v, agents=%s)\n",
			savedPath, cfg.NodeID, hasToken, strings.Join(enabledAgents, ","))
	}
	return api.ExitOK
}

func runNodeStatus(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("node status", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var cfgPath, targetDir string
	fs.StringVar(&cfgPath, "config", "", "node.json config path")
	fs.StringVar(&targetDir, "target-dir", "", "override service directory")
	if err := parseFlagsFlexible(fs, args, map[string]bool{"--config": true, "--target-dir": true}); err != nil {
		return api.ExitBadUsageOrInput
	}

	cfg, cfgResolved, cfgExists, loadErr := config.LoadNodeConfigRaw(cfgPath)
	if cfgExists && loadErr != nil {
		return failErr(g.JSON, loadErr)
	}
	svcPath, err := service.ServiceFilePath(targetDir)
	if err != nil {
		return failErr(g.JSON, err)
	}
	_, statErr := os.Stat(svcPath)
	svcInstalled := statErr == nil

	resolvedURL, credTok, _ := config.ResolveCredentials(g.URL, g.Token)
	nodeID := ""
	hubURL := resolvedURL
	projectRoots := []string{}
	enabledAgents := []string{}
	hasToken := strings.TrimSpace(credTok) != ""

	if cfg != nil {
		nodeID = cfg.NodeID
		if cfg.HubURL != "" {
			hubURL = cfg.HubURL
		}
		if len(cfg.ProjectRoots) > 0 {
			projectRoots = cfg.ProjectRoots
		}
		enabledAgents = config.EnabledAgentNames(cfg.Agents)
		if strings.TrimSpace(cfg.Token) != "" {
			hasToken = true
		}
	}

	liveRec, daemonRunning := daemon.ReadLiveDaemonPID(cfgResolved)
	appInfo := service.InspectDarwinDaemonApp(targetDir)

	if g.JSON {
		payload := map[string]interface{}{
			"ok":                true,
			"config_path":       cfgResolved,
			"config_exists":     cfgExists,
			"node_id":           nodeID,
			"hub_url":           hubURL,
			"project_roots":     projectRoots,
			"enabled_agents":    enabledAgents,
			"has_token":         hasToken,
			"service_path":      svcPath,
			"service_installed": svcInstalled,
			"daemon_running":    daemonRunning,
			"daemon_pid":        liveRec.PID,
		}
		if runtime.GOOS == "darwin" {
			payload["daemon_app_path"] = appInfo.AppPath
			payload["daemon_app_exists"] = appInfo.Exists
			payload["daemon_app_signed"] = appInfo.Signed
			payload["daemon_app_cdhash"] = appInfo.CDHash
		}
		writeJSON(payload)
	} else {
		fmt.Printf("config=%s exists=%v node_id=%s has_token=%v service=%s installed=%v daemon_running=%v daemon_pid=%d\n",
			cfgResolved, cfgExists, nodeID, hasToken, svcPath, svcInstalled, daemonRunning, liveRec.PID)
	}
	return api.ExitOK
}

func isWaitStopState(status string) bool {
	return status == "done" || status == "failed" || status == "cancelled" || status == "needs_approval"
}

func outputRunResult(asJSON bool, run *api.RunRecord) {
	if run == nil {
		return
	}
	if asJSON {
		// Strip internal fields not listed in docs/schemas/run-record.schema.json (additionalProperties: false)
		sanitized := *run
		sanitized.Prompt = ""
		sanitized.LeaseOwner = ""
		writeJSON(sanitized)
		return
	}
	fmt.Printf("Run %s [%s] node=%s agent=%s duration=%dms\n", run.ID, run.Status, run.NodeID, run.Agent, run.DurationMs)
	if run.RemoteControlURL != "" {
		fmt.Printf("Approval URL: %s\n", run.RemoteControlURL)
	}
	if run.Summary != "" {
		fmt.Printf("Summary: %s\n", run.Summary)
	}
	if run.OutputMD != "" {
		fmt.Println(run.OutputMD)
	} else if run.OutputPreview != "" {
		fmt.Println(run.OutputPreview)
	}
	if run.ErrorCode != "" {
		fmt.Fprintf(os.Stderr, "Error [%s]: %s\n", run.ErrorCode, run.ErrorMessage)
	}
}

func failUsage(asJSON bool, msg string) int {
	if asJSON {
		writeJSON(api.ErrorEnvelope{
			OK: false,
			Error: api.ErrorBody{
				Code:    "BAD_REQUEST",
				Message: msg,
			},
		})
	} else {
		fmt.Fprintln(os.Stderr, msg)
	}
	return api.ExitBadUsageOrInput
}

func failErr(asJSON bool, err error) int {
	code := api.ExitCodeForError(err)
	if asJSON {
		var apiErr *api.APIError
		if errors.As(err, &apiErr) {
			writeJSON(api.ErrorEnvelope{OK: false, Error: apiErr.Body})
		} else {
			writeJSON(api.ErrorEnvelope{
				OK: false,
				Error: api.ErrorBody{
					Code:    "CLIENT_ERROR",
					Message: err.Error(),
				},
			})
		}
	} else {
		fmt.Fprintln(os.Stderr, err.Error())
	}
	return code
}

func writeJSON(v interface{}) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func printRootUsage() {
	fmt.Fprintln(os.Stderr, `ahub - agent-hub CLI and node daemon

Usage:
  ahub [--url <url>] [--token <token>] [--json] <command> [args]

Commands:
  auth login      Validate and save credentials (0600)
  nodes           List registered nodes and workspaces
  run             Create and dispatch a run (pass '-' to read prompt from stdin)
  wait            Wait for a run over WebSocket until terminal or needs_approval
  result          Fetch run summary or --full output
  runs            List recent runs
  threads         List threads
  cancel          Cancel a run (or entire tree with --cascade)
  skill           Print or install embedded SKILL.md
  update          Check or apply atomic self-update (auto-reloads daemon unless --no-restart)
  node init       Idempotently create or update node.json (supports --token-stdin)
  node status     Inspect redacted node config, daemon PID, and service/app status
  node serve      Run node daemon over outbound WebSocket
  node shim       Supervise target ahub binary for TCC wrapper (macOS AhubDaemon.app)
  node service    Install/uninstall/status for LaunchAgent or systemd --user`)
}
