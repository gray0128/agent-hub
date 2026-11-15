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

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return Result{
			Status:       "failed",
			DurationMs:   time.Since(startedAt).Milliseconds(),
			ErrorCode:    "SPAWN_FAILED",
			ErrorMessage: err.Error(),
		}
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return Result{
			Status:       "failed",
			DurationMs:   time.Since(startedAt).Milliseconds(),
			ErrorCode:    "SPAWN_FAILED",
			ErrorMessage: err.Error(),
		}
	}

	if err := cmd.Start(); err != nil {
		return Result{
			Status:       "failed",
			DurationMs:   time.Since(startedAt).Milliseconds(),
			ErrorCode:    "SPAWN_FAILED",
			ErrorMessage: err.Error(),
		}
	}

	var mu sync.Mutex
	var rawStdoutLines []string
	var rawStderrLines []string
	var parsedOutputText strings.Builder
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
		if sid, ok := stringField(obj, "conversation_id", "session_id", "thread_id"); ok {
			nativeSessionID = sid
		}
		if sess, ok := obj["session"].(map[string]interface{}); ok {
			if sid, ok := stringField(sess, "id"); ok {
				nativeSessionID = sid
			}
		}
		if rm, ok := stringField(obj, "resolved_model", "model"); ok {
			resolvedModel = rm
		}
		if re, ok := stringField(obj, "resolved_effort", "thinking", "effort"); ok {
			resolvedEffort = re
		}
		if prov, ok := stringField(obj, "provider"); ok && resolvedModel != "" && !strings.Contains(resolvedModel, "/") {
			resolvedModel = prov + "/" + resolvedModel
		}
		if rcu, ok := stringField(obj, "remote_control_url"); ok {
			remoteControlURL = rcu
		}
		if st, ok := stringField(obj, "status"); ok {
			agyStatus = st
		}
		if errStr, ok := stringField(obj, "error"); ok {
			agyError = errStr
		}
		if respStr, ok := stringField(obj, "response", "result", "text", "output"); ok {
			parsedOutputText.Reset()
			parsedOutputText.WriteString(respStr)
		}
		if sumStr, ok := stringField(obj, "summary"); ok {
			finalSummary = sumStr
		}

		evType, _ := stringField(obj, "type", "event", "kind")
		switch evType {
		case "session":
			emitEvent("status", obj)
		case "tool_use":
			emitEvent("tool_use", obj)
		case "turn_end":
			if msg, ok := obj["message"].(map[string]interface{}); ok {
				if m, ok := stringField(msg, "model"); ok {
					resolvedModel = m
				}
				if p, ok := stringField(msg, "provider"); ok && resolvedModel != "" && !strings.Contains(resolvedModel, "/") {
					resolvedModel = p + "/" + resolvedModel
				}
			}
			emitEvent("turn_end", obj)
		case "agent_end":
			if msg, ok := stringField(obj, "text", "output", "response"); ok {
				parsedOutputText.Reset()
				parsedOutputText.WriteString(msg)
			}
			if msgs, ok := obj["messages"].([]interface{}); ok {
				if extracted := extractLastAssistantText(msgs); extracted != "" {
					parsedOutputText.Reset()
					parsedOutputText.WriteString(extracted)
				}
			}
			emitEvent("status", map[string]interface{}{"stage": "agent_end"})
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
		default:
			if evType != "" {
				emitEvent("status", obj)
			}
		}
	}

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		_ = ReadLinesBounded(stdoutPipe, func(line []byte) {
			trimmed := strings.TrimSpace(string(line))
			if trimmed == "" {
				return
			}
			var obj map[string]interface{}
			mu.Lock()
			defer mu.Unlock()
			rawStdoutLines = append(rawStdoutLines, trimmed)
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
		_ = ReadLinesBounded(stderrPipe, func(line []byte) {
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

	wg.Wait()
	durationMs := time.Since(startedAt).Milliseconds()

	mu.Lock()
	defer mu.Unlock()

	outputMD := parsedOutputText.String()
	if outputMD == "" && len(rawStdoutLines) > 0 {
		outputMD = strings.Join(rawStdoutLines, "\n")
	}
	if outputMD == "" && len(rawStderrLines) > 0 {
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

func extractLastAssistantText(msgs []interface{}) string {
	for i := len(msgs) - 1; i >= 0; i-- {
		m, ok := msgs[i].(map[string]interface{})
		if !ok {
			continue
		}
		if text, ok := stringField(m, "text", "content"); ok {
			return text
		}
		if parts, ok := m["content"].([]interface{}); ok {
			var sb strings.Builder
			for _, p := range parts {
				if pm, ok := p.(map[string]interface{}); ok {
					if t, ok := stringField(pm, "text"); ok {
						sb.WriteString(t)
					}
				}
			}
			if sb.Len() > 0 {
				return sb.String()
			}
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

