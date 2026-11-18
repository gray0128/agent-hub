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
	var fromHook, cfgPath, agentFlag, kindFlag, eventIDFlag, sessionIDFlag, workdirFlag, titleFlag, summaryFlag, sourceFlag string
	var includeTranscriptSummary bool

	fs.StringVar(&fromHook, "from-hook", "cli", "official hook adapter: claude|codex|agy|pi|omp|grok|cli")
	fs.StringVar(&cfgPath, "config", "", "node.json config path")
	fs.StringVar(&agentFlag, "agent", "", "agent name (agy|pi|omp|codex|claude|grok)")
	fs.StringVar(&kindFlag, "kind", "", "event kind (interaction_needed|turn_summary)")
	fs.StringVar(&eventIDFlag, "event-id", "", "idempotent event id")
	fs.StringVar(&sessionIDFlag, "session-id", "", "native session id")
	fs.StringVar(&workdirFlag, "dir", "", "workdir path")
	fs.StringVar(&titleFlag, "title", "", "event title")
	fs.StringVar(&summaryFlag, "summary", "", "summary text (or '-' for stdin)")
	fs.StringVar(&sourceFlag, "source", "", "event source label (default cli or adapter source)")
	fs.BoolVar(&includeTranscriptSummary, "include-transcript-summary", false, "opt-in reading last assistant message from hook transcriptPath")

	valFlags := map[string]bool{
		"--from-hook": true, "--config": true, "--agent": true, "--kind": true,
		"--event-id": true, "--session-id": true, "--dir": true, "--title": true,
		"--summary": true, "--source": true,
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
	case "pi", "omp":
		raw, err := readStdinBounded(1 << 20)
		if err != nil {
			return failErr(g.JSON, err)
		}
		defaultAgent := "pi"
		if strings.EqualFold(strings.TrimSpace(fromHook), "omp") {
			defaultAgent = "omp"
		}
		req, skipReason, err = parsePiExtensionEvent(raw, defaultAgent)
		if err != nil {
			return failUsage(g.JSON, err.Error())
		}
	case "grok":
		raw, err := readStdinBounded(1 << 20)
		if err != nil {
			return failErr(g.JSON, err)
		}
		req, skipReason, err = parseGrokHookEvent(raw, effectiveRoots)
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
			Source:          firstNonEmpty(sourceFlag, "cli"),
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
	if srcOverride := strings.TrimSpace(sourceFlag); srcOverride != "" {
		req.Source = srcOverride
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

	turnMarker := computeHookTurnMarker("", payload.TranscriptPath)

	switch payload.HookEventName {
	case "Notification":
		if strings.EqualFold(strings.TrimSpace(payload.NotificationType), "idle_prompt") {
			return nil, "idle_prompt", nil
		}
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

func computeHookTurnMarker(promptID, transcriptPath string) string {
	if trimmedID := strings.TrimSpace(promptID); trimmedID != "" {
		return "pid:" + trimmedID
	}
	if strings.TrimSpace(transcriptPath) != "" {
		if lines := countRegularFileLinesBounded(transcriptPath, 32<<20); lines > 0 {
			return fmt.Sprintf("lines:%d", lines)
		}
	}
	return fmt.Sprintf("tb:%d", nativeEmitNow().Unix()/15)
}

func parseGrokHookEvent(raw string, effectiveRoots []string) (*api.NativeEventRequest, string, error) {
	var payload struct {
		SessionID                 string `json:"session_id"`
		SessionIDCamel            string `json:"sessionId"`
		CWD                       string `json:"cwd"`
		WorkspaceRoot             string `json:"workspaceRoot"`
		HookEventName             string `json:"hook_event_name"`
		HookEventNameCamel        string `json:"hookEventName"`
		StopHookActive            bool   `json:"stop_hook_active"`
		StopHookActiveCamel       bool   `json:"stopHookActive"`
		LastAssistantMessage      string `json:"last_assistant_message"`
		LastAssistantMessageCamel string `json:"lastAssistantMessage"`
		NotificationType          string `json:"notification_type"`
		NotificationTypeCamel     string `json:"notificationType"`
		Message                   string `json:"message"`
		Title                     string `json:"title"`
		PromptID                  string `json:"prompt_id"`
		PromptIDCamel             string `json:"promptId"`
		TranscriptPath            string `json:"transcript_path"`
		TranscriptPathCamel       string `json:"transcriptPath"`
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return nil, "", fmt.Errorf("invalid grok hook json: %w", err)
	}
	if payload.StopHookActive || payload.StopHookActiveCamel {
		return nil, "stop_hook_active", nil
	}
	eventName := strings.ToLower(strings.TrimSpace(firstNonEmpty(payload.HookEventName, payload.HookEventNameCamel)))
	if eventName != "notification" && eventName != "stop" {
		return nil, "unsupported_grok_hook_event", nil
	}
	workdir := firstNonEmpty(payload.CWD, payload.WorkspaceRoot)
	if !isWorkdirAllowedForNativeNotify(workdir, effectiveRoots) {
		return nil, "workdir_outside_allowed_roots", nil
	}

	sessionID := firstNonEmpty(payload.SessionID, payload.SessionIDCamel)
	promptID := firstNonEmpty(payload.PromptID, payload.PromptIDCamel)
	transcriptPath := firstNonEmpty(payload.TranscriptPath, payload.TranscriptPathCamel)
	turnMarker := computeHookTurnMarker(promptID, transcriptPath)

	switch eventName {
	case "notification":
		notifType := firstNonEmpty(payload.NotificationType, payload.NotificationTypeCamel)
		if strings.EqualFold(notifType, "idle_prompt") {
			return nil, "idle_prompt", nil
		}
		summary := firstNonEmpty(payload.Message, payload.Title, notifType)
		if summary == "" {
			return nil, "empty_notification", nil
		}
		return &api.NativeEventRequest{
			EventID:         deterministicEventID("grok", sessionID, "Notification", notifType, turnMarker, summary),
			Agent:           "grok",
			EventKind:       "interaction_needed",
			NativeSessionID: sessionID,
			Workdir:         workdir,
			Title:           firstNonEmpty(payload.Title, "Grok 需要确认"),
			Summary:         summary,
			Source:          "grok-hook",
		}, "", nil
	case "stop":
		summary := firstNonEmpty(payload.LastAssistantMessage, payload.LastAssistantMessageCamel)
		if summary == "" {
			return nil, "empty_stop_message", nil
		}
		return &api.NativeEventRequest{
			EventID:         deterministicEventID("grok", sessionID, "Stop", turnMarker, summary),
			Agent:           "grok",
			EventKind:       "turn_summary",
			NativeSessionID: sessionID,
			Workdir:         workdir,
			Title:           "Grok 会话总结",
			Summary:         summary,
			Source:          "grok-hook",
		}, "", nil
	default:
		return nil, "unsupported_grok_hook_event", nil
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

type agyTranscriptTail struct {
	lastContent     string
	lastStep        int
	lineCount       int
	finalStep       int
	finalContent    string
	hasExitPlanMode bool
	hasAskQuestion  bool
	askQuestions    []string
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
		FullyIdle         *bool    `json:"fullyIdle"`
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
	if payload.FullyIdle != nil && !*payload.FullyIdle {
		return nil, "not_fully_idle", nil
	}
	workdir := strings.TrimSpace(payload.CWD)
	if workdir == "" && len(payload.WorkspacePaths) > 0 {
		workdir = strings.TrimSpace(payload.WorkspacePaths[0])
	}
	if !isWorkdirAllowedForNativeNotify(workdir, effectiveRoots) {
		return nil, "workdir_outside_allowed_roots", nil
	}

	eventKind := "turn_summary"
	title := firstNonEmpty(boundRunes(payload.LastUserInput, 120), "Antigravity 会话结束")
	summary := ""
	lastStep := 0
	lineCount := 0
	if allowTranscript && strings.TrimSpace(payload.TranscriptPath) != "" {
		tail := readAgyTranscriptTail(payload.TranscriptPath)
		lineCount = tail.lineCount
		if tail.hasExitPlanMode {
			return nil, "exit_plan_mode_handoff", nil
		}
		if tail.hasAskQuestion {
			eventKind = "interaction_needed"
			title = "Antigravity 等待回答"
			qText := ""
			if len(tail.askQuestions) == 1 {
				qText = tail.askQuestions[0]
			} else if len(tail.askQuestions) > 1 {
				var b strings.Builder
				for i, q := range tail.askQuestions {
					if i > 0 {
						b.WriteByte('\n')
					}
					fmt.Fprintf(&b, "%d. %s", i+1, q)
				}
				qText = b.String()
			}
			if tail.finalContent != "" && qText != "" {
				summary = tail.finalContent + "\n\n" + qText
			} else {
				summary = firstNonEmpty(qText, tail.finalContent, "Antigravity 等待回答")
			}
			lastStep = tail.finalStep
		} else {
			summary = tail.lastContent
			lastStep = tail.lastStep
		}
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
		eventID = deterministicEventID("agy", payload.ConversationID, fmt.Sprintf("%d", payload.ExecutionNum), eventKind, payload.TerminationReason)
	} else {
		turnMarker := fmt.Sprintf("tb:%d", nativeEmitNow().Unix()/15)
		if lastStep > 0 || lineCount > 0 {
			turnMarker = fmt.Sprintf("step:%d:lines:%d", lastStep, lineCount)
		}
		eventID = deterministicEventID("agy", payload.ConversationID, turnMarker, eventKind, payload.TerminationReason, payload.LastUserInput)
	}

	return &api.NativeEventRequest{
		EventID:         eventID,
		Agent:           "agy",
		EventKind:       eventKind,
		NativeSessionID: strings.TrimSpace(payload.ConversationID),
		Workdir:         workdir,
		Title:           title,
		Summary:         summary,
		Source:          "agy-hook",
	}, "", nil
}

func readLastAssistantFromAgyTranscript(transcriptPath string) (string, int, int) {
	tail := readAgyTranscriptTail(transcriptPath)
	return tail.lastContent, tail.lastStep, tail.lineCount
}

func readAgyTranscriptTail(transcriptPath string) agyTranscriptTail {
	var tail agyTranscriptTail
	expanded := config.ExpandPath(transcriptPath)
	if expanded == "" {
		return tail
	}
	f, err := os.Open(expanded)
	if err != nil {
		return tail
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return tail
	}

	reader := bufio.NewReaderSize(f, 64*1024)
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
			tail.lineCount++
			if !oversized && len(lineBuf)+len(frag) <= maxAgyTranscriptLineBytes {
				line := frag
				if len(lineBuf) > 0 {
					line = append(lineBuf, frag...)
				}
				var row struct {
					StepIndex int    `json:"step_index"`
					Type      string `json:"type"`
					Content   string `json:"content"`
					ToolCalls []struct {
						Name string          `json:"name"`
						Args json.RawMessage `json:"args"`
					} `json:"tool_calls"`
				}
				if json.Unmarshal(line, &row) == nil && row.Type == "PLANNER_RESPONSE" {
					content := strings.TrimSpace(row.Content)
					if content != "" {
						tail.lastContent = content
						tail.lastStep = row.StepIndex
					}
					tail.finalStep = row.StepIndex
					tail.finalContent = content
					tail.hasExitPlanMode = false
					tail.hasAskQuestion = false
					tail.askQuestions = nil
					for _, tc := range row.ToolCalls {
						switch tc.Name {
						case "exit_plan_mode":
							tail.hasExitPlanMode = true
						case "ask_question":
							tail.hasAskQuestion = true
							var args struct {
								Questions []struct {
									Question string `json:"question"`
								} `json:"questions"`
							}
							if len(tc.Args) > 0 && json.Unmarshal(tc.Args, &args) == nil {
								for _, q := range args.Questions {
									if qs := strings.TrimSpace(q.Question); qs != "" {
										tail.askQuestions = append(tail.askQuestions, qs)
									}
								}
							}
						}
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
	return tail
}

func parsePiExtensionEvent(raw, defaultAgent string) (*api.NativeEventRequest, string, error) {
	var payload struct {
		Agent     string `json:"agent"`
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
	agent := strings.ToLower(strings.TrimSpace(firstNonEmpty(payload.Agent, defaultAgent, "pi")))
	if agent != "pi" && agent != "omp" {
		return nil, "unsupported_pi_agent", nil
	}
	summary := strings.TrimSpace(payload.Summary)
	if summary == "" {
		return nil, "empty_pi_summary", nil
	}
	kind := firstNonEmpty(payload.EventKind, "turn_summary")
	if kind != "turn_summary" && kind != "interaction_needed" {
		return nil, "unsupported_pi_event_kind", nil
	}
	defaultTitle := "Pi 会话总结"
	if agent == "omp" {
		if kind == "interaction_needed" {
			defaultTitle = "OMP 需要确认"
		} else {
			defaultTitle = "OMP 会话总结"
		}
	} else if kind == "interaction_needed" {
		defaultTitle = "Pi 需要确认"
	}
	return &api.NativeEventRequest{
		EventID:         deterministicEventID(agent, payload.SessionID, payload.TurnID, kind, summary),
		Agent:           agent,
		EventKind:       kind,
		NativeSessionID: strings.TrimSpace(payload.SessionID),
		Workdir:         strings.TrimSpace(payload.CWD),
		Title:           firstNonEmpty(payload.Title, defaultTitle),
		Summary:         summary,
		Source:          agent + "-ext",
	}, "", nil
}
