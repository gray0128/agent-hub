package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gray0128/agent-hub/internal/api"
	"github.com/gray0128/agent-hub/internal/config"
)

type Callbacks struct {
	OnEvent func(kind string, payload map[string]interface{})
	OnState func(status, remoteControlURL, resolvedModel, resolvedEffort string)
}

type Result struct {
	Status           string
	NativeSessionID  string
	ResolvedModel    string
	ResolvedEffort   string
	RemoteControlURL string
	Summary          string
	OutputMD         string
	OutputBytes      int
	DurationMs       int64
	ErrorCode        string
	ErrorMessage     string
}

var urlRegex = regexp.MustCompile(`https?://[^\s"']+`)

func BuildCommandSpec(run api.RunRecord, agentCfg config.AgentConfig) (string, []string, string, error) {
	bin := strings.TrimSpace(agentCfg.Command)
	if bin == "" {
		bin = run.Agent
	}
	bin = config.ExpandPath(bin)
	args := make([]string, 0, len(agentCfg.Args)+16)
	args = append(args, agentCfg.Args...)

	model, effort := SplitModelAndEffort(run.Model, run.Effort)
	if model == "" && agentCfg.DefaultModel != "" {
		model, effort = SplitModelAndEffort(agentCfg.DefaultModel, effort)
	}

	nativeSession := ""
	if run.NativeSessionID != nil {
		nativeSession = strings.TrimSpace(*run.NativeSessionID)
	}

	stdinPrompt := ""
	switch run.Agent {
	case "agy":
		expandedModel, expandedEffort := ExpandAgyModel(model, effort)
		args = append(args, "--output-format", "json")
		if run.Sandbox {
			args = append(args, "--sandbox")
		} else {
			args = append(args, "--dangerously-skip-permissions")
		}
		if !hasAgyProjectFlag(agentCfg.Args) {
			if projectID := ResolveAgyProjectID(run.Workdir); projectID != "" {
				args = append(args, "--project", projectID)
			}
		}
		if expandedModel != "" {
			args = append(args, "--model", expandedModel)
		}
		if expandedEffort != "" && expandedEffort != "auto" {
			args = append(args, "--effort", expandedEffort)
		}
		if run.TimeoutSec > 0 {
			args = append(args, "--print-timeout", fmt.Sprintf("%ds", run.TimeoutSec))
		}
		if nativeSession != "" {
			args = append(args, "--conversation", nativeSession)
		}
		args = append(args, "-p="+run.Prompt)

	case "pi":
		args = append(args, "--mode", "json", "-p")
		if !run.Sandbox {
			args = append(args, "--approve")
		}
		if model != "" {
			args = append(args, "--model", model)
		}
		if effort != "" && effort != "auto" {
			args = append(args, "--thinking", effort)
		}
		if nativeSession != "" {
			args = append(args, "--session", nativeSession)
		}
		args = append(args, run.Prompt)

	case "omp":
		args = append(args, "--mode=json", "-p", "--auto-approve")
		if run.TimeoutSec > 0 {
			args = append(args, "--max-time="+strconv.Itoa(run.TimeoutSec))
		}
		if model != "" {
			args = append(args, "--model="+model)
		}
		if effort != "" && effort != "auto" {
			args = append(args, "--thinking="+effort)
		}
		if nativeSession != "" {
			args = append(args, "--resume="+nativeSession)
		}
		args = append(args, run.Prompt)

	case "codex":
		if nativeSession != "" {
			args = append(args, "exec", "resume", "--json")
			if model != "" {
				args = append(args, "-m", model)
			}
			if effort != "" && effort != "auto" && !hasCodexReasoningEffortOverride(agentCfg.Args) {
				args = append(args, "-c", fmt.Sprintf("model_reasoning_effort=%q", effort))
			}
			args = append(args, nativeSession, "-")
		} else {
			args = append(args, "exec", "--json")
			if model != "" {
				args = append(args, "-m", model)
			}
			if effort != "" && effort != "auto" && !hasCodexReasoningEffortOverride(agentCfg.Args) {
				args = append(args, "-c", fmt.Sprintf("model_reasoning_effort=%q", effort))
			}
			if run.Sandbox {
				args = append(args, "-s", "workspace-write")
			} else {
				args = append(args, "--dangerously-bypass-approvals-and-sandbox")
			}
			args = append(args, "-")
		}
		stdinPrompt = run.Prompt

	case "claude":
		args = append(args, "-p", "--output-format", "json")
		if !run.Sandbox {
			args = append(args, "--dangerously-skip-permissions")
		}
		if model != "" {
			args = append(args, "--model", model)
		}
		if nativeSession != "" {
			args = append(args, "--session-id", nativeSession)
		}
		args = append(args, run.Prompt)

	default:
		return "", nil, "", fmt.Errorf("unsupported agent %q", run.Agent)
	}

	return bin, args, stdinPrompt, nil
}

func ExecuteRun(
	ctx context.Context,
	run api.RunRecord,
	cfg *config.NodeConfig,
	agentCfg config.AgentConfig,
	callbacks Callbacks,
) Result {
	startedAt := time.Now()
	bin, args, stdinPrompt, err := BuildCommandSpec(run, agentCfg)
	if err != nil {
		return Result{
			Status:       "failed",
			DurationMs:   time.Since(startedAt).Milliseconds(),
			ErrorCode:    "AGENT_UNSUPPORTED",
			ErrorMessage: err.Error(),
		}
	}

	timeout := time.Duration(run.TimeoutSec) * time.Second
	if timeout <= 0 {
		timeout = 900 * time.Second
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.Command(bin, args...)
	cmd.Dir = run.Workdir
	cmd.Env = BuildSanitizedEnv(run, cfg.HubURL, cfg.DelegationToken)
	configureProcGroup(cmd)

	if stdinPrompt != "" {
		cmd.Stdin = strings.NewReader(stdinPrompt)
	}

	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		return Result{
			Status:       "failed",
			DurationMs:   time.Since(startedAt).Milliseconds(),
			ErrorCode:    "SPAWN_FAILED",
			ErrorMessage: err.Error(),
		}
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		_ = stdoutR.Close()
		_ = stdoutW.Close()
		return Result{
			Status:       "failed",
			DurationMs:   time.Since(startedAt).Milliseconds(),
			ErrorCode:    "SPAWN_FAILED",
			ErrorMessage: err.Error(),
		}
	}
	cmd.Stdout = stdoutW
	cmd.Stderr = stderrW

	if err := cmd.Start(); err != nil {
		_ = stdoutR.Close()
		_ = stdoutW.Close()
		_ = stderrR.Close()
		_ = stderrW.Close()
		return Result{
			Status:       "failed",
			DurationMs:   time.Since(startedAt).Milliseconds(),
			ErrorCode:    "SPAWN_FAILED",
			ErrorMessage: err.Error(),
		}
	}
	_ = stdoutW.Close()
	_ = stderrW.Close()

	const maxRawStdoutCaptureBytes = 64 * 1024

	var mu sync.Mutex
	var rawStdoutLines []string
	var rawStdoutBytes int
	var rawStderrLines []string
	var parsedOutputText strings.Builder
	var streamedAssistantText strings.Builder
	var sawStructuredEvent bool
	var finalSummary string
	var nativeSessionID string
	var resolvedModel string
	var resolvedEffort string
	var remoteControlURL string
	var remoteControlUnavailableReason string
	var agyStatus string
	var agyError string
	inApproval := false

	emitEvent := func(kind string, payload map[string]interface{}) {
		if callbacks.OnEvent != nil {
			callbacks.OnEvent(kind, payload)
		}
	}

	processJSONLine := func(obj map[string]interface{}) {
		evType, _ := stringField(obj, "type", "event", "kind")
		if evType != "" || hasAnyKey(obj, "status", "conversation_id", "session_id", "thread_id", "response", "result", "output", "error") {
			sawStructuredEvent = true
		}

		if sid, ok := stringField(obj, "conversation_id", "session_id", "thread_id"); ok {
			nativeSessionID = sid
		}
		if sess, ok := obj["session"].(map[string]interface{}); ok {
			if sid, ok := stringField(sess, "id"); ok {
				nativeSessionID = sid
			}
		}
		if evType == "session" {
			if sid, ok := stringField(obj, "id"); ok {
				nativeSessionID = sid
			}
		}

		updateModelAndProvider(&resolvedModel, obj)
		if re, ok := stringField(obj, "resolved_effort", "thinking", "effort"); ok {
			resolvedEffort = re
		}
		if rcu, ok := stringField(obj, "remote_control_url"); ok {
			remoteControlURL = rcu
		}
		if st, ok := stringField(obj, "status"); ok {
			agyStatus = st
		}
		if errStr := extractErrorMessage(obj["error"]); errStr != "" {
			agyError = errStr
		}
		if evType == "" || evType == "agent_end" || evType == "result" {
			if respStr, ok := stringField(obj, "response", "result", "text", "output"); ok {
				parsedOutputText.Reset()
				parsedOutputText.WriteString(respStr)
			}
		}
		if sumStr, ok := stringField(obj, "summary"); ok {
			finalSummary = sumStr
		}

		switch evType {
		case "session", "thread.started":
			payload := map[string]interface{}{"stage": "session"}
			if nativeSessionID != "" {
				payload["session_id"] = nativeSessionID
			}
			if cwd, ok := stringField(obj, "cwd"); ok {
				payload["cwd"] = cwd
			}
			if resolvedModel != "" {
				payload["resolved_model"] = resolvedModel
			}
			emitEvent("status", payload)

		case "tool_use":
			emitEvent("tool_use", obj)

		case "tool_execution_start":
			toolName, _ := stringField(obj, "toolName", "tool", "name")
			toolCallID, _ := stringField(obj, "toolCallId", "tool_call_id", "id")
			args, _ := obj["args"].(map[string]interface{})
			if args == nil {
				args, _ = obj["arguments"].(map[string]interface{})
			}
			emitEvent("tool_use", buildCompactToolUsePayload(toolName, toolCallID, args))

		case "tool_execution_end":
			if isErr, _ := obj["isError"].(bool); isErr {
				errLine := extractToolResultError(obj["result"])
				if errLine == "" {
					errLine = "tool execution failed"
					if tn, ok := stringField(obj, "toolName", "tool"); ok {
						errLine = tn + " failed"
					}
				}
				emitEvent("stderr_warn", map[string]interface{}{"line": truncateStr(errLine, 512)})
			}

		case "item.started":
			if item, ok := obj["item"].(map[string]interface{}); ok {
				if payload := buildCodexToolStartPayload(item); payload != nil {
					emitEvent("tool_use", payload)
				}
			}

		case "item.updated":
			if item, ok := obj["item"].(map[string]interface{}); ok {
				if itemType, _ := stringField(item, "type"); itemType == "agent_message" {
					if txt, ok := item["text"].(string); ok && txt != "" {
						streamedAssistantText.Reset()
						streamedAssistantText.WriteString(txt)
					}
				}
			}

		case "item.completed":
			if item, ok := obj["item"].(map[string]interface{}); ok {
				itemType, _ := stringField(item, "type")
				switch itemType {
				case "agent_message":
					if txt, ok := stringField(item, "text"); ok {
						parsedOutputText.Reset()
						parsedOutputText.WriteString(txt)
						streamedAssistantText.Reset()
					}
				case "command_execution":
					if exitCode, ok := intField(item, "exit_code"); ok && exitCode != 0 {
						line := fmt.Sprintf("command exited %d", exitCode)
						if cmd, ok := stringField(item, "command", "cmd"); ok {
							line = fmt.Sprintf("command exited %d: %s", exitCode, truncateStr(cmd, 240))
						}
						emitEvent("stderr_warn", map[string]interface{}{"line": truncateStr(line, 512)})
					}
				case "error":
					if msg, ok := stringField(item, "message", "error"); ok {
						emitEvent("stderr_warn", map[string]interface{}{"line": truncateStr(msg, 512)})
					}
				}
			}

		case "message_start":
			if msg, ok := obj["message"].(map[string]interface{}); ok {
				if role, _ := stringField(msg, "role"); role == "assistant" {
					streamedAssistantText.Reset()
				}
			}

		case "message_update":
			if ame, ok := obj["assistantMessageEvent"].(map[string]interface{}); ok {
				if deltaType, _ := stringField(ame, "type"); deltaType == "text_delta" {
					if delta, ok := ame["delta"].(string); ok && delta != "" {
						streamedAssistantText.WriteString(delta)
					}
				}
			}

		case "message_end":
			if msg, ok := obj["message"].(map[string]interface{}); ok {
				role, _ := stringField(msg, "role")
				if role == "" || role == "assistant" {
					updateModelAndProvider(&resolvedModel, msg)
					if txt, ok := extractAssistantMessageText(msg); ok {
						parsedOutputText.Reset()
						parsedOutputText.WriteString(txt)
					}
					if role == "assistant" {
						streamedAssistantText.Reset()
					}
					if sr, _ := stringField(msg, "stopReason", "stop_reason"); sr == "error" {
						if em, ok := stringField(msg, "errorMessage", "error"); ok {
							agyError = em
							emitEvent("stderr_warn", map[string]interface{}{"line": truncateStr(em, 512)})
						}
					}
				}
			}

		case "turn_end", "turn.completed":
			payload := map[string]interface{}{}
			var stopReason string
			var usage interface{}
			if msg, ok := obj["message"].(map[string]interface{}); ok {
				role, _ := stringField(msg, "role")
				if role == "" || role == "assistant" {
					updateModelAndProvider(&resolvedModel, msg)
				}
				if sr, ok := stringField(msg, "stopReason", "stop_reason"); ok {
					stopReason = sr
				}
				if u, exists := msg["usage"]; exists {
					usage = compactUsageMap(u)
				}
			}
			if usage == nil {
				if u, exists := obj["usage"]; exists {
					usage = compactUsageMap(u)
				}
			}
			if resolvedModel != "" {
				payload["resolved_model"] = resolvedModel
			}
			if stopReason != "" {
				payload["stop_reason"] = stopReason
			}
			if usage != nil {
				payload["usage"] = usage
			}
			emitEvent("turn_end", payload)

		case "compaction_start", "compaction_end", "auto_retry_start", "auto_retry_end":
			payload := map[string]interface{}{"stage": evType}
			if reason, ok := stringField(obj, "reason", "errorMessage"); ok {
				payload["reason"] = truncateStr(reason, 256)
			}
			if attempt, ok := intField(obj, "attempt"); ok {
				payload["attempt"] = attempt
			}
			emitEvent("status", payload)

		case "agent_end", "result":
			if msgs, ok := obj["messages"].([]interface{}); ok {
				if model, sr, errMsg := inspectLastAssistantMeta(msgs); model != "" || sr != "" {
					if model != "" && resolvedModel == "" {
						resolvedModel = model
					}
					if sr == "error" && errMsg != "" && agyError == "" {
						agyError = errMsg
					}
				}
				if extracted := extractLastAssistantText(msgs); extracted != "" {
					parsedOutputText.Reset()
					parsedOutputText.WriteString(extracted)
				} else if agyError != "" && parsedOutputText.Len() == 0 {
					agyStatus = "ERROR"
				}
			}
			if evType == "result" {
				if isErr, ok := obj["is_error"].(bool); ok && isErr {
					agyStatus = "ERROR"
					if agyError == "" {
						if msg, ok := stringField(obj, "result", "error"); ok {
							agyError = msg
						}
					}
				}
			}
			payload := map[string]interface{}{"stage": "agent_end"}
			if resolvedModel != "" {
				payload["resolved_model"] = resolvedModel
			}
			emitEvent("status", payload)

		case "approval_needed":
			inApproval = true
			if remoteControlURL == "" {
				remoteControlURL, remoteControlUnavailableReason = probeRemoteControlURL(ctx, agentCfg)
			}
			payload := map[string]interface{}{
				"remote_control_url":       remoteControlURL,
				"remote_control_available": remoteControlURL != "",
			}
			if remoteControlURL == "" && remoteControlUnavailableReason != "" {
				payload["reason"] = remoteControlUnavailableReason
				emitEvent("system", map[string]interface{}{
					"stage":  "remote_control_unavailable",
					"reason": remoteControlUnavailableReason,
				})
			}
			emitEvent("approval_needed", payload)
			if callbacks.OnState != nil {
				callbacks.OnState("needs_approval", remoteControlURL, resolvedModel, resolvedEffort)
			}

		case "resumed":
			if inApproval {
				inApproval = false
				emitEvent("status", map[string]interface{}{"stage": "resumed"})
				if callbacks.OnState != nil {
					callbacks.OnState("running", remoteControlURL, resolvedModel, resolvedEffort)
				}
			}

		case "status":
			emitEvent("status", obj)

		case "turn.failed", "error":
			errMsg := extractErrorMessage(obj["error"])
			if errMsg == "" {
				errMsg, _ = stringField(obj, "message", "errorMessage")
			}
			agyStatus = "ERROR"
			if errMsg != "" {
				agyError = errMsg
				emitEvent("stderr_warn", map[string]interface{}{"line": truncateStr(errMsg, 512)})
			}
		}
	}

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		_ = ReadLinesBounded(stdoutR, func(line []byte) {
			trimmed := strings.TrimSpace(string(line))
			if trimmed == "" {
				return
			}
			var obj map[string]interface{}
			mu.Lock()
			defer mu.Unlock()
			if rawStdoutBytes < maxRawStdoutCaptureBytes {
				rawStdoutLines = append(rawStdoutLines, trimmed)
				rawStdoutBytes += len(trimmed) + 1
			}
			if json.Unmarshal([]byte(trimmed), &obj) == nil && obj != nil {
				processJSONLine(obj)
			} else {
				if parsedOutputText.Len() > 0 {
					parsedOutputText.WriteByte('\n')
				}
				parsedOutputText.WriteString(trimmed)
			}
		})
	}()

	go func() {
		defer wg.Done()
		_ = ReadLinesBounded(stderrR, func(line []byte) {
			trimmed := strings.TrimSpace(string(line))
			if trimmed == "" {
				return
			}
			mu.Lock()
			rawStderrLines = append(rawStderrLines, trimmed)
			mu.Unlock()
			emitEvent("stderr_warn", map[string]interface{}{"line": truncateStr(trimmed, 1024)})
		})
	}()

	waitDone := make(chan error, 1)
	go func() {
		waitDone <- cmd.Wait()
	}()

	var waitErr error
	killedByContext := false
	select {
	case waitErr = <-waitDone:
	case <-runCtx.Done():
		killedByContext = true
		killProcessGroup(cmd, 5*time.Second)
		waitErr = <-waitDone
	}

	readersDone := make(chan struct{})
	go func() {
		wg.Wait()
		close(readersDone)
	}()
	select {
	case <-readersDone:
	case <-time.After(2 * time.Second):
		_ = stdoutR.Close()
		_ = stderrR.Close()
		<-readersDone
	}
	_ = stdoutR.Close()
	_ = stderrR.Close()
	durationMs := time.Since(startedAt).Milliseconds()

	mu.Lock()
	defer mu.Unlock()

	outputMD := parsedOutputText.String()
	if outputMD == "" && streamedAssistantText.Len() > 0 {
		outputMD = streamedAssistantText.String()
	}
	if outputMD == "" && !sawStructuredEvent && len(rawStdoutLines) > 0 {
		outputMD = strings.Join(rawStdoutLines, "\n")
	}
	if outputMD == "" && !errors.Is(ctx.Err(), context.Canceled) && len(rawStderrLines) > 0 {
		outputMD = strings.Join(rawStderrLines, "\n")
	}

	if killedByContext {
		if errors.Is(ctx.Err(), context.Canceled) {
			return Result{
				Status:           "cancelled",
				NativeSessionID:  nativeSessionID,
				ResolvedModel:    resolvedModel,
				ResolvedEffort:   resolvedEffort,
				RemoteControlURL: remoteControlURL,
				Summary:          buildSummary(outputMD, "Cancelled by user"),
				OutputMD:         outputMD,
				OutputBytes:      len(outputMD),
				DurationMs:       durationMs,
				ErrorCode:        "CANCELLED",
				ErrorMessage:     "Cancelled by hub.abort",
			}
		}
		return Result{
			Status:           "failed",
			NativeSessionID:  nativeSessionID,
			ResolvedModel:    resolvedModel,
			ResolvedEffort:   resolvedEffort,
			RemoteControlURL: remoteControlURL,
			Summary:          buildSummary(outputMD, "Execution timed out"),
			OutputMD:         outputMD,
			OutputBytes:      len(outputMD),
			DurationMs:       durationMs,
			ErrorCode:        "RUN_TIMEOUT",
			ErrorMessage:     fmt.Sprintf("Execution exceeded timeout (%ds)", run.TimeoutSec),
		}
	}

	if strings.EqualFold(agyStatus, "NEEDS_HUMAN_APPROVAL") {
		if remoteControlURL == "" {
			remoteControlURL, remoteControlUnavailableReason = probeRemoteControlURL(ctx, agentCfg)
		}
		summary := buildSummary(parsedOutputText.String(), "Waiting for human approval via remote-control")
		if remoteControlURL == "" && remoteControlUnavailableReason != "" {
			if strings.TrimSpace(parsedOutputText.String()) == "" {
				summary = fmt.Sprintf("Waiting for human approval (remote-control unavailable: %s)", remoteControlUnavailableReason)
			} else {
				summary = truncateStr(fmt.Sprintf("%s (remote-control unavailable: %s)", summary, remoteControlUnavailableReason), 280)
			}
		}
		return Result{
			Status:           "needs_approval",
			NativeSessionID:  nativeSessionID,
			ResolvedModel:    resolvedModel,
			ResolvedEffort:   resolvedEffort,
			RemoteControlURL: remoteControlURL,
			Summary:          summary,
			OutputMD:         outputMD,
			OutputBytes:      len(outputMD),
			DurationMs:       durationMs,
		}
	}

	if waitErr != nil {
		errMsg := waitErr.Error()
		if agyError != "" {
			errMsg = agyError
		} else if len(rawStderrLines) > 0 {
			errMsg = rawStderrLines[len(rawStderrLines)-1]
		}
		return Result{
			Status:           "failed",
			NativeSessionID:  nativeSessionID,
			ResolvedModel:    resolvedModel,
			ResolvedEffort:   resolvedEffort,
			RemoteControlURL: remoteControlURL,
			Summary:          buildSummary(outputMD, errMsg),
			OutputMD:         outputMD,
			OutputBytes:      len(outputMD),
			DurationMs:       durationMs,
			ErrorCode:        "AGENT_EXIT_NONZERO",
			ErrorMessage:     truncateStr(errMsg, 2000),
		}
	}

	if agyStatus != "" && strings.EqualFold(agyStatus, "ERROR") {
		return Result{
			Status:           "failed",
			NativeSessionID:  nativeSessionID,
			ResolvedModel:    resolvedModel,
			ResolvedEffort:   resolvedEffort,
			RemoteControlURL: remoteControlURL,
			Summary:          buildSummary(outputMD, agyError),
			OutputMD:         outputMD,
			OutputBytes:      len(outputMD),
			DurationMs:       durationMs,
			ErrorCode:        "AGENT_ERROR",
			ErrorMessage:     truncateStr(agyError, 2000),
		}
	}

	if finalSummary == "" {
		finalSummary = buildSummary(outputMD, "Completed")
	}

	return Result{
		Status:           "done",
		NativeSessionID:  nativeSessionID,
		ResolvedModel:    resolvedModel,
		ResolvedEffort:   resolvedEffort,
		RemoteControlURL: remoteControlURL,
		Summary:          finalSummary,
		OutputMD:         outputMD,
		OutputBytes:      len(outputMD),
		DurationMs:       durationMs,
	}
}

type localAuthHealthSnapshot struct {
	Status       string `json:"status"`
	CircuitState string `json:"circuit_state"`
	RemainingSec int64  `json:"remaining_seconds"`
	ZombieUnauth bool   `json:"zombie_unauthenticated_detected"`
}

func ensureRemoteControlURL(ctx context.Context, agentCfg config.AgentConfig) string {
	url, _ := probeRemoteControlURL(ctx, agentCfg)
	return url
}

// probeRemoteControlURL inspects local auth-health snapshot and `agy remote-control status` in read-only mode.
// It never invokes `agy remote-control start`, preventing LaunchAgent plist overwrites.
func probeRemoteControlURL(ctx context.Context, agentCfg config.AgentConfig) (string, string) {
	return probeRemoteControlURLWithHealthPath(ctx, agentCfg, "")
}

func probeRemoteControlURLWithHealthPath(ctx context.Context, agentCfg config.AgentConfig, healthOverride string) (string, string) {
	if reason := checkLocalAuthHealthSnapshot(healthOverride); reason != "" {
		return "", reason
	}
	bin := strings.TrimSpace(agentCfg.Command)
	if bin == "" {
		bin = "agy"
	}
	bin = config.ExpandPath(bin)
	checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(checkCtx, bin, "remote-control", "status").CombinedOutput()
	text := strings.TrimSpace(string(out))
	if err != nil {
		if errors.Is(checkCtx.Err(), context.DeadlineExceeded) {
			return "", "status_probe_timeout"
		}
		return "", "daemon_not_running"
	}
	lower := strings.ToLower(text)
	if strings.Contains(lower, "not running") || strings.Contains(lower, "stopped") || strings.Contains(lower, "not signed in") {
		return "", "daemon_not_running"
	}
	if match := urlRegex.FindString(text); match != "" {
		cleaned := strings.TrimRight(match, ").,:;]>")
		if cleaned != "" {
			return cleaned, ""
		}
	}
	return "", "url_not_reported"
}

func checkLocalAuthHealthSnapshot(overridePath string) string {
	healthPath := overridePath
	if healthPath == "" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return ""
		}
		healthPath = filepath.Join(home, ".gemini", "antigravity-cli", "auth-health.json")
	}
	raw, err := os.ReadFile(healthPath)
	if err != nil {
		return ""
	}
	var snap localAuthHealthSnapshot
	if json.Unmarshal(raw, &snap) != nil {
		return ""
	}
	if strings.EqualFold(snap.CircuitState, "OPEN") {
		return "auth_circuit_open"
	}
	if snap.Status == "expired" || snap.RemainingSec < -60 {
		return "oauth_token_expired"
	}
	if snap.ZombieUnauth {
		return "daemon_auth_lost"
	}
	return ""
}

func hasAnyKey(obj map[string]interface{}, keys ...string) bool {
	for _, k := range keys {
		if _, exists := obj[k]; exists {
			return true
		}
	}
	return false
}

func updateModelAndProvider(resolvedModel *string, m map[string]interface{}) {
	if rm, ok := stringField(m, "resolved_model", "model"); ok {
		*resolvedModel = rm
	}
	if prov, ok := stringField(m, "provider"); ok && *resolvedModel != "" && !strings.Contains(*resolvedModel, "/") {
		*resolvedModel = prov + "/" + *resolvedModel
	}
}

func extractErrorMessage(raw interface{}) string {
	switch v := raw.(type) {
	case string:
		return strings.TrimSpace(v)
	case map[string]interface{}:
		if msg, ok := stringField(v, "message", "error", "detail"); ok {
			return msg
		}
	}
	return ""
}

func extractToolResultError(raw interface{}) string {
	switch v := raw.(type) {
	case string:
		return strings.TrimSpace(v)
	case map[string]interface{}:
		if msg, ok := stringField(v, "error", "message", "text"); ok {
			return msg
		}
		if parts, ok := v["content"].([]interface{}); ok {
			for _, p := range parts {
				if pm, ok := p.(map[string]interface{}); ok {
					if t, ok := stringField(pm, "text"); ok {
						return t
					}
				}
			}
		}
	}
	return ""
}

func buildCompactToolUsePayload(toolName, toolCallID string, args map[string]interface{}) map[string]interface{} {
	tool := strings.TrimSpace(toolName)
	if tool == "" {
		tool = "tool"
	}
	payload := map[string]interface{}{
		"tool": tool,
	}
	if id := strings.TrimSpace(toolCallID); id != "" {
		payload["tool_call_id"] = id
	}
	if len(args) > 0 {
		if cmd, ok := stringField(args, "command", "cmd"); ok {
			payload["command"] = truncateStr(cmd, 512)
		} else if p, ok := stringField(args, "path", "file_path", "filePath", "TargetFile", "Path"); ok {
			payload["path"] = truncateStr(p, 512)
		} else if f, ok := stringField(args, "file"); ok {
			payload["file"] = truncateStr(f, 512)
		} else if s, ok := stringField(args, "query", "url", "pattern", "prompt", "description", "toolSummary"); ok {
			payload["summary"] = truncateStr(s, 512)
		} else if b, err := json.Marshal(args); err == nil {
			raw := strings.TrimSpace(string(b))
			if raw != "" && raw != "{}" {
				payload["summary"] = truncateStr(raw, 256)
			}
		}
	}
	return payload
}

func buildCodexToolStartPayload(item map[string]interface{}) map[string]interface{} {
	itemType, _ := stringField(item, "type")
	itemID, _ := stringField(item, "id")
	switch itemType {
	case "command_execution":
		cmd, _ := stringField(item, "command", "cmd")
		return buildCompactToolUsePayload("bash", itemID, map[string]interface{}{"command": cmd})
	case "mcp_tool_call":
		tool, _ := stringField(item, "tool", "name")
		if server, ok := stringField(item, "server"); ok && tool != "" {
			tool = server + "." + tool
		} else if tool == "" {
			tool = "mcp_tool"
		}
		args, _ := item["arguments"].(map[string]interface{})
		return buildCompactToolUsePayload(tool, itemID, args)
	case "file_change":
		args := map[string]interface{}{}
		if p, ok := stringField(item, "path", "file"); ok {
			args["path"] = p
		} else if changes, ok := item["changes"].([]interface{}); ok && len(changes) > 0 {
			if first, ok := changes[0].(map[string]interface{}); ok {
				if p, ok := stringField(first, "path", "file"); ok {
					if len(changes) > 1 {
						args["summary"] = fmt.Sprintf("%s (+%d files)", p, len(changes)-1)
					} else {
						args["path"] = p
					}
				}
			}
		}
		return buildCompactToolUsePayload("file_change", itemID, args)
	case "web_search":
		q, _ := stringField(item, "query")
		return buildCompactToolUsePayload("web_search", itemID, map[string]interface{}{"query": q})
	default:
		return nil
	}
}

func compactUsageMap(raw interface{}) map[string]interface{} {
	m, ok := raw.(map[string]interface{})
	if !ok {
		return nil
	}
	out := map[string]interface{}{}
	for k, v := range m {
		switch n := v.(type) {
		case float64, int, int64:
			out[k] = n
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func intField(obj map[string]interface{}, keys ...string) (int, bool) {
	for _, k := range keys {
		raw, exists := obj[k]
		if !exists {
			continue
		}
		switch v := raw.(type) {
		case float64:
			return int(v), true
		case int:
			return v, true
		case int64:
			return int(v), true
		}
	}
	return 0, false
}

func stringField(obj map[string]interface{}, keys ...string) (string, bool) {
	for _, k := range keys {
		if raw, exists := obj[k]; exists {
			if s, ok := raw.(string); ok && strings.TrimSpace(s) != "" {
				return s, true
			}
		}
	}
	return "", false
}

func inspectLastAssistantMeta(msgs []interface{}) (model string, stopReason string, errMsg string) {
	for i := len(msgs) - 1; i >= 0; i-- {
		m, ok := msgs[i].(map[string]interface{})
		if !ok {
			continue
		}
		if role, hasRole := m["role"].(string); hasRole && strings.TrimSpace(role) != "" && role != "assistant" {
			continue
		}
		updateModelAndProvider(&model, m)
		stopReason, _ = stringField(m, "stopReason", "stop_reason")
		errMsg, _ = stringField(m, "errorMessage", "error")
		return model, stopReason, errMsg
	}
	return "", "", ""
}

func extractAssistantMessageText(m map[string]interface{}) (string, bool) {
	if role, hasRole := m["role"].(string); hasRole && strings.TrimSpace(role) != "" && role != "assistant" {
		return "", false
	}
	if text, ok := stringField(m, "text", "content"); ok {
		return text, true
	}
	if parts, ok := m["content"].([]interface{}); ok {
		var sb strings.Builder
		for _, p := range parts {
			pm, ok := p.(map[string]interface{})
			if !ok {
				continue
			}
			partType, _ := stringField(pm, "type")
			if partType != "" && partType != "text" {
				continue
			}
			if t, ok := pm["text"].(string); ok {
				sb.WriteString(t)
			}
		}
		if strings.TrimSpace(sb.String()) != "" {
			return sb.String(), true
		}
	}
	return "", false
}

func extractLastAssistantText(msgs []interface{}) string {
	for i := len(msgs) - 1; i >= 0; i-- {
		m, ok := msgs[i].(map[string]interface{})
		if !ok {
			continue
		}
		if txt, ok := extractAssistantMessageText(m); ok {
			return txt
		}
	}
	return ""
}

func buildSummary(outputMD, fallback string) string {
	trimmed := strings.TrimSpace(outputMD)
	if trimmed == "" {
		return truncateStr(fallback, 280)
	}
	lines := strings.Split(trimmed, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line != "" {
			return truncateStr(line, 280)
		}
	}
	return truncateStr(trimmed, 280)
}

func truncateStr(s string, maxChars int) string {
	r := []rune(s)
	if len(r) <= maxChars {
		return s
	}
	return string(r[:maxChars]) + "..."
}

func hasCodexReasoningEffortOverride(args []string) bool {
	for i := 0; i < len(args); i++ {
		arg := strings.TrimSpace(args[i])
		if arg == "-c" || arg == "--config" {
			if i+1 < len(args) && strings.HasPrefix(strings.TrimSpace(args[i+1]), "model_reasoning_effort") {
				return true
			}
			i++
			continue
		}
		if strings.HasPrefix(arg, "--config=") {
			val := strings.TrimSpace(strings.TrimPrefix(arg, "--config="))
			if strings.HasPrefix(val, "model_reasoning_effort") {
				return true
			}
		}
	}
	return false
}

// RunCommandOutputBounded executes bin in an isolated process group and returns stdout within timeout.
func RunCommandOutputBounded(ctx context.Context, timeout time.Duration, env []string, bin string, args ...string) ([]byte, error) {
	if timeout <= 0 {
		timeout = 4 * time.Second
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.Command(bin, args...)
	if len(env) > 0 {
		cmd.Env = env
	}
	configureProcGroup(cmd)

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	waitDone := make(chan error, 1)
	go func() {
		waitDone <- cmd.Wait()
	}()

	var waitErr error
	select {
	case waitErr = <-waitDone:
	case <-runCtx.Done():
		killProcessGroup(cmd, 2*time.Second)
		select {
		case waitErr = <-waitDone:
		case <-time.After(3 * time.Second):
			return nil, runCtx.Err()
		}
		if err := runCtx.Err(); err != nil {
			return nil, err
		}
	}

	if waitErr != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg != "" {
			return stdout.Bytes(), fmt.Errorf("%w: %s", waitErr, msg)
		}
		return stdout.Bytes(), waitErr
	}
	return stdout.Bytes(), nil
}

