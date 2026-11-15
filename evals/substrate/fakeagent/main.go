package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

type directive struct {
	Op       string   `json:"op"`
	Ms       int      `json:"ms,omitempty"`
	HoldMs   int      `json:"hold_ms,omitempty"`
	Count    int      `json:"count,omitempty"`
	Interval int      `json:"interval_ms,omitempty"`
	Kind     string   `json:"kind,omitempty"`
	Cmd      []string `json:"cmd,omitempty"`
	PIDFile  string   `json:"pid_file,omitempty"`
	Keys     []string `json:"keys,omitempty"`
	URL      string   `json:"url,omitempty"`
	Then     string   `json:"then,omitempty"`
	Bytes    int      `json:"bytes,omitempty"`
	Code     int      `json:"code,omitempty"`
	Message  string   `json:"message,omitempty"`
	AhubBin  string   `json:"ahub_bin,omitempty"`
	Node     string   `json:"target_node,omitempty"`
	Workdir  string   `json:"workdir,omitempty"`
	Line     string   `json:"line,omitempty"`
}

type scriptPayload struct {
	SessionID  string      `json:"session_id,omitempty"`
	Summary    string      `json:"summary,omitempty"`
	Response   string      `json:"response,omitempty"`
	Directives []directive `json:"directives"`
}

func maybeHandleCatalogQuery(args []string) bool {
	hasModels := false
	hasJSON := false
	hasListModels := false
	for _, a := range args {
		switch a {
		case "models":
			hasModels = true
		case "--json":
			hasJSON = true
		case "--list-models":
			hasListModels = true
		}
	}
	if hasListModels {
		fmt.Println("provider   model               context   max-out   thinking   images")
		fmt.Println("openai     gpt-5.4             200K      64K       yes        yes")
		fmt.Println("anthropic  claude-haiku-4-5    200K      16K       no         no")
		return true
	}
	if hasModels && hasJSON {
		fmt.Println(`{"models":[{"provider":"anthropic","id":"claude-sonnet-4-5","selector":"anthropic/claude-sonnet-4-5","name":"Claude Sonnet 4.5","reasoning":true,"thinking":["off","minimal","low","medium","high","xhigh"]},{"provider":"openai","id":"gpt-5.4","selector":"openai/gpt-5.4","name":"GPT-5.4","reasoning":true,"thinking":["low","medium","high"]}]}`)
		return true
	}
	if hasModels {
		fmt.Println("Fetching available models...")
		fmt.Println("gemini-4-carbon-low\tGemini 4 Carbon (Low)")
		fmt.Println("gemini-4-carbon-medium\tGemini 4 Carbon (Medium)")
		fmt.Println("gemini-4-carbon-high\tGemini 4 Carbon (High)")
		fmt.Println("gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)")
		fmt.Println("gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)")
		fmt.Println("gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)")
		fmt.Println("gemini-3.8-flash-low\tGemini 3.8 Flash (Low)")
		fmt.Println("gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)")
		fmt.Println("gemini-3.8-flash-high\tGemini 3.8 Flash (High)")
		fmt.Println("gemini-pro-orchestrator\tGemini Pro Orchestrator")
		return true
	}
	return false
}

func main() {
	args := os.Args[1:]
	if maybeHandleCatalogQuery(args) {
		return
	}
	prompt := ""
	readStdin := false
	hasPromptFlag := false
	passedSession := ""
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "-" {
			readStdin = true
		} else if strings.HasPrefix(a, "-p=") {
			prompt = strings.TrimPrefix(a, "-p=")
			hasPromptFlag = true
		} else if (a == "--conversation" || a == "--session" || a == "--session-id") && i+1 < len(args) {
			passedSession = args[i+1]
		} else if strings.HasPrefix(a, "--resume=") {
			passedSession = strings.TrimPrefix(a, "--resume=")
		} else if i > 0 && args[i-1] == "resume" {
			passedSession = a
		}
	}
	if readStdin {
		raw, _ := io.ReadAll(os.Stdin)
		prompt = strings.TrimSpace(string(raw))
	} else if !hasPromptFlag && len(args) > 0 {
		prompt = args[len(args)-1]
	}

	if logPath := os.Getenv("AHUB_FAKEAGENT_LOG"); logPath != "" {
		rec, _ := json.Marshal(map[string]interface{}{
			"args":           args,
			"passed_session": passedSession,
			"cwd":            mustGetwd(),
		})
		f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err == nil {
			_, _ = f.Write(append(rec, '\n'))
			_ = f.Close()
		}
	}

	sessionID := passedSession
	if sessionID == "" {
		sessionID = fmt.Sprintf("sess_%d", time.Now().UnixNano())
	}

	var script scriptPayload
	if strings.HasPrefix(strings.TrimSpace(prompt), "{") {
		_ = json.Unmarshal([]byte(prompt), &script)
	}
	if script.SessionID != "" {
		sessionID = script.SessionID
	}

	// Emit initial session line so ahub extracts native_session_id & resolved_model
	writeJSONLine(map[string]interface{}{
		"type":            "session",
		"session_id":      sessionID,
		"resolved_model":  "fake/ahub-fakeagent-v1",
		"resolved_effort": "high",
	})

	if len(script.Directives) == 0 {
		msg := "fakeagent completed"
		if prompt != "" {
			msg = fmt.Sprintf("fakeagent completed (passed_session=%s): %s", passedSession, prompt)
		}
		writeJSONLine(map[string]interface{}{
			"type":       "agent_end",
			"session_id": sessionID,
			"summary":    "fakeagent summary",
			"response":   msg,
		})
		return
	}

	var responseParts []string
	summary := script.Summary
	if summary == "" {
		summary = "fakeagent scripted run completed"
	}

	for _, d := range script.Directives {
		switch d.Op {
		case "sleep":
			if d.Ms > 0 {
				time.Sleep(time.Duration(d.Ms) * time.Millisecond)
			}
		case "emit_ndjson":
			count := d.Count
			if count <= 0 {
				count = 1
			}
			kind := d.Kind
			if kind == "" {
				kind = "tool_use"
			}
			for i := 1; i <= count; i++ {
				writeJSONLine(map[string]interface{}{
					"type":  kind,
					"index": i,
					"tool":  "fake_tool",
					"text":  fmt.Sprintf("chunk %d/%d", i, count),
				})
				if d.Interval > 0 {
					time.Sleep(time.Duration(d.Interval) * time.Millisecond)
				}
			}
		case "emit_line":
			fmt.Println(d.Line)
		case "spawn_grandchild":
			if len(d.Cmd) > 0 {
				c := exec.Command(d.Cmd[0], d.Cmd[1:]...)
				if err := c.Start(); err != nil {
					fmt.Fprintf(os.Stderr, "spawn_grandchild error: %v\n", err)
					os.Exit(1)
				}
				if d.PIDFile != "" {
					_ = os.WriteFile(d.PIDFile, []byte(fmt.Sprintf("%d\n", c.Process.Pid)), 0o644)
				}
			}
		case "dump_env":
			dumped := map[string]string{}
			for _, k := range d.Keys {
				if v, ok := os.LookupEnv(k); ok {
					dumped[k] = v
				} else {
					dumped[k] = "__MISSING__"
				}
			}
			raw, _ := json.Marshal(dumped)
			responseParts = append(responseParts, string(raw))
		case "soft_approval":
			url := d.URL
			if url == "" {
				url = "https://claude.ai/code/session_01FAKE"
			}
			writeJSONLine(map[string]interface{}{
				"type":               "approval_needed",
				"session_id":         sessionID,
				"remote_control_url": url,
			})
			hold := d.HoldMs
			if hold <= 0 {
				hold = 200
			}
			time.Sleep(time.Duration(hold) * time.Millisecond)
			if d.Then == "" || d.Then == "resume" {
				writeJSONLine(map[string]interface{}{
					"type":       "resumed",
					"session_id": sessionID,
				})
			}
		case "recurse_run":
			ahubBin := d.AhubBin
			if ahubBin == "" {
				ahubBin = "ahub"
			}
			c := exec.Command(ahubBin, "--json", "run", "--node", d.Node, "--dir", d.Workdir, "--agent", "agy", "nested child test")
			out, err := c.CombinedOutput()
			exitCode := 0
			if err != nil {
				if ee, ok := err.(*exec.ExitError); ok {
					exitCode = ee.ExitCode()
				} else {
					exitCode = 1
				}
			}
			resObj, _ := json.Marshal(map[string]interface{}{
				"child_exit_code": exitCode,
				"child_output":    strings.TrimSpace(string(out)),
			})
			responseParts = append(responseParts, string(resObj))
		case "corrupt_stdout":
			n := d.Bytes
			if n <= 0 {
				n = 131072
			}
			fmt.Println("RAW_NON_JSON_" + strings.Repeat("X", n))
		case "big_output":
			n := d.Bytes
			if n <= 0 {
				n = 131072
			}
			responseParts = append(responseParts, strings.Repeat("B", n))
		case "exit":
			code := d.Code
			if code == 0 {
				code = 1
			}
			msg := d.Message
			if msg == "" {
				msg = "fakeagent exited with non-zero code"
			}
			fmt.Fprintln(os.Stderr, msg)
			os.Exit(code)
		}
	}

	finalResp := script.Response
	if len(responseParts) > 0 {
		finalResp = strings.Join(responseParts, "\n")
	}
	if finalResp == "" {
		finalResp = fmt.Sprintf("scripted ok (session=%s)", sessionID)
	}

	writeJSONLine(map[string]interface{}{
		"type":       "agent_end",
		"session_id": sessionID,
		"summary":    summary,
		"response":   finalResp,
	})
}

func writeJSONLine(v interface{}) {
	b, _ := json.Marshal(v)
	fmt.Println(string(b))
}

func mustGetwd() string {
	wd, err := os.Getwd()
	if err != nil {
		return ""
	}
	return wd
}
