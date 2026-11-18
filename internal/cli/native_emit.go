package cli

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gray0128/agent-hub/internal/api"
	"github.com/gray0128/agent-hub/internal/config"
	"github.com/gray0128/agent-hub/internal/redact"
)

const maxAgyTranscriptLineBytes = 4 * 1024 * 1024

var nativeEmitNow = time.Now

func runNativeEmit(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("native-emit", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var fromHook, cfgPath, agentFlag, kindFlag, eventIDFlag, sessionIDFlag, workdirFlag, titleFlag, summaryFlag string
	var includeTranscriptSummary bool

	fs.StringVar(&fromHook, "from-hook", "cli", "official hook adapter: claude|codex|agy|pi|cli")
	fs.StringVar(&cfgPath, "config", "", "node.json config path")
	fs.StringVar(&agentFlag, "agent", "", "agent name (agy|pi|omp|codex|claude)")
	fs.StringVar(&kindFlag, "kind", "", "event kind (interaction_needed|turn_summary)")
	fs.StringVar(&eventIDFlag, "event-id", "", "idempotent event id")
	fs.StringVar(&sessionIDFlag, "session-id", "", "native session id")
	fs.StringVar(&workdirFlag, "dir", "", "workdir path")
	fs.StringVar(&titleFlag, "title", "", "event title")
	fs.StringVar(&summaryFlag, "summary", "", "summary text (or '-' for stdin)")
	fs.BoolVar(&includeTranscriptSummary, "include-transcript-summary", false, "opt-in reading last assistant message from hook transcriptPath")

	valFlags := map[string]bool{
		"--from-hook": true, "--config": true, "--agent": true, "--kind": true,
		"--event-id": true, "--session-id": true, "--dir": true, "--title": true, "--summary": true,
	}
	if err := parseFlagsFlexible(fs, args, valFlags); err != nil {
		return api.ExitBadUsageOrInput
	}

	// Anti-loop & anti-double-push: runs spawned by ahub node serve receive AHUB_RUN_ID / AHUB_DEPTH
	// and are notified solely by control-plane ahub_run_completed.
	if strings.TrimSpace(os.Getenv("AHUB_RUN_ID")) != "" || strings.TrimSpace(os.Getenv("AHUB_DEPTH")) != "" {
		return emitSkipped(g.JSON, "inside_ahub_run")
	}

	cfg, err := config.LoadNodeConfig(cfgPath)
	if err != nil {
		return failErr(g.JSON, err)
	}
	if cfg.NativeNotify == nil || !cfg.NativeNotify.Enabled {
		return emitSkipped(g.JSON, "native_notify_disabled")
	}

	effectiveRoots := cfg.NativeNotify.AllowedRoots
	if len(effectiveRoots) == 0 {
		effectiveRoots = cfg.ProjectRoots
	}

	var req *api.NativeEventRequest
	var skipReason string
	switch strings.ToLower(strings.TrimSpace(fromHook)) {
	case "claude":
		raw, err := readStdinBounded(1 << 20)
		if err != nil {
			return failErr(g.JSON, err)
		}
		req, skipReason, err = parseClaudeHookEvent(raw, effectiveRoots)
		if err != nil {
			return failUsage(g.JSON, err.Error())
		}
	case "codex":
		raw := ""
		if fs.NArg() > 0 {
			raw = fs.Arg(fs.NArg() - 1)
		} else {
			var err error
			raw, err = readStdinBounded(1 << 20)
			if err != nil {
				return failErr(g.JSON, err)
			}
		}
		req, skipReason, err = parseCodexNotifyEvent(raw)
		if err != nil {
			return failUsage(g.JSON, err.Error())
		}
	case "agy":
		raw, err := readStdinBounded(1 << 20)
		if err != nil {
			return failErr(g.JSON, err)
		}
		allowTranscript := includeTranscriptSummary || cfg.NativeNotify.IncludeTranscriptSummary
		req, skipReason, err = parseAgyHookEvent(raw, allowTranscript, effectiveRoots)
		if err != nil {
			return failUsage(g.JSON, err.Error())
		}
	case "pi":
		raw, err := readStdinBounded(1 << 20)
		if err != nil {
			return failErr(g.JSON, err)
		}
		req, skipReason, err = parsePiExtensionEvent(raw)
		if err != nil {
			return failUsage(g.JSON, err.Error())
		}
	case "cli", "":
		summaryText := summaryFlag
		if strings.TrimSpace(summaryText) == "-" {
			raw, err := readStdinBounded(1 << 20)
			if err != nil {
				return failErr(g.JSON, err)
			}
			summaryText = raw
		}
		if strings.TrimSpace(agentFlag) == "" || strings.TrimSpace(kindFlag) == "" || strings.TrimSpace(summaryText) == "" {
			return failUsage(g.JSON, "--agent, --kind, and --summary are required in cli mode")
		}
		req = &api.NativeEventRequest{
			EventID:         deterministicEventID("cli", sessionIDFlag, kindFlag, summaryText),
			Agent:           strings.TrimSpace(agentFlag),
			EventKind:       strings.TrimSpace(kindFlag),
			NativeSessionID: strings.TrimSpace(sessionIDFlag),
			Workdir:         strings.TrimSpace(workdirFlag),
			Title:           strings.TrimSpace(titleFlag),
			Summary:         strings.TrimSpace(summaryText),
			Source:          "cli",
		}
	default:
		return failUsage(g.JSON, fmt.Sprintf("unsupported --from-hook %q", fromHook))
	}

	if skipReason != "" {
		return emitSkipped(g.JSON, skipReason)
	}
	if req == nil {
		return emitSkipped(g.JSON, "ignored_event")
	}
	if evOverride := strings.TrimSpace(eventIDFlag); evOverride != "" {
		req.EventID = evOverride
	}

	if !isWorkdirAllowedForNativeNotify(req.Workdir, effectiveRoots) {
		return emitSkipped(g.JSON, "workdir_outside_allowed_roots")
	}

	// Pre-egress secret redaction & size bounding on node before leaving host
	req.Title = boundRunes(redact.Text(req.Title), 200)
	req.Summary = boundRunes(redact.Text(req.Summary), 4000)
	if strings.TrimSpace(req.Summary) == "" {
		return emitSkipped(g.JSON, "empty_summary")
	}

	// Strictly isolate node credentials from caller-side AHUB_URL/AHUB_TOKEN environment overrides.
	hubURL := strings.TrimRight(firstNonEmpty(g.URL, cfg.HubURL, config.DefaultHubURL), "/")
	token := strings.TrimSpace(firstNonEmpty(g.Token, cfg.Token))
	if token == "" {
		return failUsage(g.JSON, "node token missing for native-emit (set --token or node.json token)")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	res, err := api.NewClient(hubURL, token).EmitNativeEvent(ctx, cfg.NodeID, *req)
	if err != nil {
		return failErr(g.JSON, err)
	}
	if g.JSON {
		writeJSON(res)
	} else {
		fmt.Printf("Native event %s status=%s deduplicated=%v\n", res.Event.ID, res.Event.NotifyStatus, res.Deduplicated)
	}
	return api.ExitOK
}

func emitSkipped(asJSON bool, reason string) int {
	if asJSON {
		writeJSON(map[string]interface{}{
			"ok":      true,
			"skipped": reason,
		})
	} else {
		fmt.Printf("Skipped native event (%s)\n", reason)
	}
	return api.ExitOK
}

func readStdinBounded(limit int64) (string, error) {
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, limit))
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func deterministicEventID(parts ...string) string {
	h := sha256.New()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{0})
	}
	sum := hex.EncodeToString(h.Sum(nil))
	prefix := "evt"
	if len(parts) > 0 && parts[0] != "" {
		prefix = parts[0]
	}
	return fmt.Sprintf("%s_%s", prefix, sum[:20])
}

func boundRunes(s string, maxRunes int) string {
	trimmed := strings.TrimSpace(s)
	if maxRunes <= 0 {
		return trimmed
	}
	r := []rune(trimmed)
	if len(r) <= maxRunes {
		return trimmed
	}
	return string(r[:maxRunes])
}

func isWorkdirAllowedForNativeNotify(workdir string, allowedRoots []string) bool {
	if len(allowedRoots) == 0 {
		return false
	}
	cleanDir := strings.TrimSpace(workdir)
	if cleanDir == "" {
		return false
	}
	cleanDir = filepath.Clean(config.ExpandPath(cleanDir))
	for _, root := range allowedRoots {
		expanded := filepath.Clean(config.ExpandPath(root))
		if expanded == "" || expanded == "." {
			continue
		}
		if expanded == string(filepath.Separator) {
			if filepath.IsAbs(cleanDir) {
				return true
			}
			continue
		}
		if cleanDir == expanded || strings.HasPrefix(cleanDir, expanded+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func countRegularFileLinesBounded(p string, maxBytes int64) int {
	expanded := config.ExpandPath(p)
	if expanded == "" {
		return 0
	}
	f, err := os.Open(expanded)
	if err != nil {
		return 0
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Size() > maxBytes {
		return 0
	}
	buf := make([]byte, 32*1024)
	lines := 0
	endsWithNewline := true
	hasData := false
	for {
		n, err := f.Read(buf)
		if n > 0 {
			hasData = true
			for _, b := range buf[:n] {
				if b == '\n' {
					lines++
				}
			}
			endsWithNewline = buf[n-1] == '\n'
		}
		if err != nil {
			break
		}
	}
	if hasData && !endsWithNewline {
		lines++
	}
	return lines
}

func parseClaudeHookEvent(raw string, effectiveRoots []string) (*api.NativeEventRequest, string, error) {
	var payload struct {
		SessionID            string `json:"session_id"`
		CWD                  string `json:"cwd"`
		HookEventName        string `json:"hook_event_name"`
		StopHookActive       bool   `json:"stop_hook_active"`
		LastAssistantMessage string `json:"last_assistant_message"`
		NotificationType     string `json:"notification_type"`
		Message              string `json:"message"`
		Title                string `json:"title"`
		TranscriptPath       string `json:"transcript_path"`
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return nil, "", fmt.Errorf("invalid claude hook json: %w", err)
	}
	if payload.StopHookActive {
		return nil, "stop_hook_active", nil
	}
	if payload.HookEventName != "Notification" && payload.HookEventName != "Stop" {
		return nil, "unsupported_claude_hook_event", nil
	}
	if !isWorkdirAllowedForNativeNotify(payload.CWD, effectiveRoots) {
		return nil, "workdir_outside_allowed_roots", nil
	}

	turnMarker := ""
	if strings.TrimSpace(payload.TranscriptPath) != "" {
		if lines := countRegularFileLinesBounded(payload.TranscriptPath, 32<<20); lines > 0 {
			turnMarker = fmt.Sprintf("lines:%d", lines)
		}
	}
	if turnMarker == "" {
		turnMarker = fmt.Sprintf("tb:%d", nativeEmitNow().Unix()/15)
	}

	switch payload.HookEventName {
	case "Notification":
		summary := firstNonEmpty(payload.Message, payload.Title, payload.NotificationType)
		if summary == "" {
			return nil, "empty_notification", nil
		}
		return &api.NativeEventRequest{
			EventID:         deterministicEventID("claude", payload.SessionID, "Notification", payload.NotificationType, turnMarker, summary),
			Agent:           "claude",
			EventKind:       "interaction_needed",
			NativeSessionID: strings.TrimSpace(payload.SessionID),
			Workdir:         strings.TrimSpace(payload.CWD),
			Title:           firstNonEmpty(payload.Title, "Claude 需要确认"),
			Summary:         summary,
			Source:          "claude-hook",
		}, "", nil
	case "Stop":
		summary := strings.TrimSpace(payload.LastAssistantMessage)
		if summary == "" {
			return nil, "empty_stop_message", nil
		}
		return &api.NativeEventRequest{
			EventID:         deterministicEventID("claude", payload.SessionID, "Stop", turnMarker, summary),
			Agent:           "claude",
			EventKind:       "turn_summary",
			NativeSessionID: strings.TrimSpace(payload.SessionID),
			Workdir:         strings.TrimSpace(payload.CWD),
			Title:           "Claude 会话总结",
			Summary:         summary,
			Source:          "claude-hook",
		}, "", nil
	default:
		return nil, "unsupported_claude_hook_event", nil
	}
}

func parseCodexNotifyEvent(raw string) (*api.NativeEventRequest, string, error) {
	var payload struct {
		Type                 string   `json:"type"`
		ThreadID             string   `json:"thread-id"`
		TurnID               string   `json:"turn-id"`
		CWD                  string   `json:"cwd"`
		LastAssistantMessage string   `json:"last-assistant-message"`
		InputMessages        []string `json:"input-messages"`
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return nil, "", fmt.Errorf("invalid codex notify json: %w", err)
	}
	if payload.Type != "agent-turn-complete" {
		return nil, "unsupported_codex_event", nil
	}
	summary := strings.TrimSpace(payload.LastAssistantMessage)
	if summary == "" {
		return nil, "empty_codex_message", nil
	}
	title := "Codex 回合总结"
	if len(payload.InputMessages) > 0 && strings.TrimSpace(payload.InputMessages[0]) != "" {
		title = boundRunes(payload.InputMessages[0], 120)
	}
	return &api.NativeEventRequest{
		EventID:         deterministicEventID("codex", payload.ThreadID, payload.TurnID, summary),
		Agent:           "codex",
		EventKind:       "turn_summary",
		NativeSessionID: strings.TrimSpace(payload.ThreadID),
		Workdir:         strings.TrimSpace(payload.CWD),
		Title:           title,
		Summary:         summary,
		Source:          "codex-notify",
	}, "", nil
}

func parseAgyHookEvent(raw string, allowTranscript bool, effectiveRoots []string) (*api.NativeEventRequest, string, error) {
	var payload struct {
		ConversationID    string   `json:"conversationId"`
		ExecutionNum      int      `json:"executionNum"`
		TerminationReason string   `json:"terminationReason"`
		Error             string   `json:"error"`
		LastUserInput     string   `json:"lastUserInput"`
		CWD               string   `json:"cwd"`
		WorkspacePaths    []string `json:"workspacePaths"`
		TranscriptPath    string   `json:"transcriptPath"`
		HookEventName     string   `json:"hookEventName"`
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return nil, "", fmt.Errorf("invalid agy hook json: %w", err)
	}
	if payload.HookEventName != "" && payload.HookEventName != "Stop" {
		return nil, "unsupported_agy_hook_event", nil
	}
	if payload.TerminationReason == "USER_CANCELED" {
		return nil, "user_canceled", nil
	}
	workdir := strings.TrimSpace(payload.CWD)
	if workdir == "" && len(payload.WorkspacePaths) > 0 {
		workdir = strings.TrimSpace(payload.WorkspacePaths[0])
	}
	if !isWorkdirAllowedForNativeNotify(workdir, effectiveRoots) {
		return nil, "workdir_outside_allowed_roots", nil
	}

	summary := ""
	lastStep := 0
	lineCount := 0
	if allowTranscript && strings.TrimSpace(payload.TranscriptPath) != "" {
		summary, lastStep, lineCount = readLastAssistantFromAgyTranscript(payload.TranscriptPath)
	}
	if summary == "" {
		reason := firstNonEmpty(payload.TerminationReason, "STOP")
		if strings.TrimSpace(payload.Error) != "" {
			summary = fmt.Sprintf("Antigravity 会话结束（%s）：%s", reason, strings.TrimSpace(payload.Error))
		} else {
			summary = fmt.Sprintf("Antigravity 会话结束（%s）", reason)
		}
		if strings.TrimSpace(payload.LastUserInput) != "" {
			summary += "\n用户指令：" + boundRunes(payload.LastUserInput, 200)
		}
	}

	var eventID string
	if payload.ExecutionNum > 0 {
		eventID = deterministicEventID("agy", payload.ConversationID, fmt.Sprintf("%d", payload.ExecutionNum), payload.TerminationReason)
	} else {
		turnMarker := fmt.Sprintf("tb:%d", nativeEmitNow().Unix()/15)
		if lastStep > 0 || lineCount > 0 {
			turnMarker = fmt.Sprintf("step:%d:lines:%d", lastStep, lineCount)
		}
		eventID = deterministicEventID("agy", payload.ConversationID, turnMarker, payload.TerminationReason, payload.LastUserInput)
	}

	return &api.NativeEventRequest{
		EventID:         eventID,
		Agent:           "agy",
		EventKind:       "turn_summary",
		NativeSessionID: strings.TrimSpace(payload.ConversationID),
		Workdir:         workdir,
		Title:           firstNonEmpty(boundRunes(payload.LastUserInput, 120), "Antigravity 会话结束"),
		Summary:         summary,
		Source:          "agy-hook",
	}, "", nil
}

func readLastAssistantFromAgyTranscript(transcriptPath string) (string, int, int) {
	expanded := config.ExpandPath(transcriptPath)
	if expanded == "" {
		return "", 0, 0
	}
	f, err := os.Open(expanded)
	if err != nil {
		return "", 0, 0
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return "", 0, 0
	}

	reader := bufio.NewReaderSize(f, 64*1024)
	lastContent := ""
	lastStep := 0
	lineCount := 0
	var lineBuf []byte
	oversized := false

	for {
		frag, err := reader.ReadSlice('\n')
		if err == bufio.ErrBufferFull {
			if !oversized {
				if len(lineBuf)+len(frag) > maxAgyTranscriptLineBytes {
					oversized = true
					lineBuf = lineBuf[:0]
				} else {
					lineBuf = append(lineBuf, frag...)
				}
			}
			continue
		}

		if err != nil && err != io.EOF {
			break
		}

		if len(frag) > 0 || len(lineBuf) > 0 {
			lineCount++
			if !oversized && len(lineBuf)+len(frag) <= maxAgyTranscriptLineBytes {
				line := frag
				if len(lineBuf) > 0 {
					line = append(lineBuf, frag...)
				}
				var row struct {
					StepIndex int    `json:"step_index"`
					Type      string `json:"type"`
					Content   string `json:"content"`
				}
				if json.Unmarshal(line, &row) == nil {
					if row.Type == "PLANNER_RESPONSE" && strings.TrimSpace(row.Content) != "" {
						lastContent = strings.TrimSpace(row.Content)
						lastStep = row.StepIndex
					}
				}
			}
		}
		lineBuf = lineBuf[:0]
		oversized = false
		if err == io.EOF {
			break
		}
	}
	return lastContent, lastStep, lineCount
}

func parsePiExtensionEvent(raw string) (*api.NativeEventRequest, string, error) {
	var payload struct {
		SessionID string `json:"session_id"`
		TurnID    string `json:"turn_id"`
		CWD       string `json:"cwd"`
		EventKind string `json:"event_kind"`
		Title     string `json:"title"`
		Summary   string `json:"summary"`
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return nil, "", fmt.Errorf("invalid pi hook json: %w", err)
	}
	summary := strings.TrimSpace(payload.Summary)
	if summary == "" {
		return nil, "empty_pi_summary", nil
	}
	kind := firstNonEmpty(payload.EventKind, "turn_summary")
	if kind != "turn_summary" && kind != "interaction_needed" {
		return nil, "unsupported_pi_event_kind", nil
	}
	return &api.NativeEventRequest{
		EventID:         deterministicEventID("pi", payload.SessionID, payload.TurnID, kind, summary),
		Agent:           "pi",
		EventKind:       kind,
		NativeSessionID: strings.TrimSpace(payload.SessionID),
		Workdir:         strings.TrimSpace(payload.CWD),
		Title:           firstNonEmpty(payload.Title, "Pi 会话总结"),
		Summary:         summary,
		Source:          "pi-ext",
	}, "", nil
}
