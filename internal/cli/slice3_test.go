package cli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gray0128/agent-hub/internal/api"
)

func TestRunSlice3LabelsAndResultSchemaValidationAndDispatch(t *testing.T) {
	var seenReq api.CreateRunRequest

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/runs" {
			http.NotFound(w, r)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&seenReq); err != nil {
			t.Fatalf("decode CreateRunRequest: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"run": api.RunRecord{
				ID:           "run_s3_1",
				ThreadID:     "thr_s3_1",
				RootRunID:    "run_s3_1",
				NodeID:       seenReq.NodeID,
				Workdir:      seenReq.Workdir,
				Agent:        seenReq.Agent,
				Status:       "done",
				LeaseOwner:   "secret_lease",
				Labels:       map[string]string{"env": "prod", "leak": "ahub_cli_lblsecret123"},
				ResultSchema: seenReq.ResultSchema,
				Result:       json.RawMessage(`{"api_key":"sk-proj-secret123456","count":9007199254740993,"note":"$HOME <TAG>"}`),
				CreatedAt:    "2026-11-22T00:00:00Z",
				UpdatedAt:    "2026-11-22T00:00:00Z",
			},
		})
	}))
	defer srv.Close()

	// 1. Repeatable --label (including '=', empty value, bare 'ahub=ok', trailing flags after prompt) + inline --result-schema '{}'
	code, out, errOut := captureExecuteFull(t, []string{
		"--url", srv.URL, "--token", "tok_test", "--json",
		"run", "-n", "macmini", "-d", "/w", "-a", "agy",
		"summarize", "--label", "env=prod", "--label", "eq=a=b", "--label", "empty=", "--label", "ahub=ok",
		"--result-schema", " {} ",
	}, "")
	if code != api.ExitOK {
		t.Fatalf("run with labels and {} schema failed: exit=%d out=%s err=%s", code, out, errOut)
	}
	if seenReq.Labels["env"] != "prod" || seenReq.Labels["eq"] != "a=b" || seenReq.Labels["empty"] != "" || seenReq.Labels["ahub"] != "ok" {
		t.Fatalf("unexpected labels sent: %+v", seenReq.Labels)
	}
	if string(seenReq.ResultSchema) != "{}" {
		t.Fatalf("expected compact result_schema '{}', got %s", string(seenReq.ResultSchema))
	}
	for _, secret := range []string{"ahub_cli_lblsecret123", "sk-proj-secret123456", "secret_lease"} {
		if strings.Contains(out, secret) {
			t.Fatalf("run output leaked %q: %s", secret, out)
		}
	}
	if !strings.Contains(out, `"count":9007199254740993`) || !strings.Contains(out, `"$HOME <TAG>"`) {
		t.Fatalf("expected large int & unescaped <TAG> in sanitized output: %s", out)
	}

	// 2. --result-schema @file and '-' stdin with prompt argument
	tmpDir := t.TempDir()
	schemaPath := filepath.Join(tmpDir, "schema.json")
	if err := os.WriteFile(schemaPath, []byte("{\n  \"type\": \"object\",\n  \"required\": [\"ok\"]\n}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	codeFile, outFile, _ := captureExecuteFull(t, []string{
		"--url", srv.URL, "--token", "tok_test", "--json",
		"run", "-n", "macmini", "-d", "/w", "-a", "agy",
		"--result-schema", "@" + schemaPath, "prompt from arg",
	}, "")
	if codeFile != api.ExitOK {
		t.Fatalf("run --result-schema @file failed: exit=%d out=%s", codeFile, outFile)
	}
	if !strings.Contains(string(seenReq.ResultSchema), `"required":["ok"]`) {
		t.Fatalf("unexpected compact schema from @file: %s", string(seenReq.ResultSchema))
	}

	codeStdin, outStdin, _ := captureExecuteFull(t, []string{
		"--url", srv.URL, "--token", "tok_test", "--json",
		"run", "-n", "macmini", "-d", "/w", "-a", "agy",
		"--result-schema", "-", "prompt from arg",
	}, `{"type":"array"}`+"\n")
	if codeStdin == api.ExitBadUsageOrInput {
		t.Fatalf("array schema is still a JSON object; unexpected usage error: %s", outStdin)
	}
	if codeStdin != api.ExitOK || string(seenReq.ResultSchema) != `{"type":"array"}` {
		t.Fatalf("run --result-schema - failed: exit=%d schema=%s out=%s", codeStdin, string(seenReq.ResultSchema), outStdin)
	}

	// 3. Exact 16 labels & exact 16384-byte schema pass
	args16 := []string{"--url", srv.URL, "--token", "tok_test", "--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy"}
	for i := 1; i <= 16; i++ {
		args16 = append(args16, "--label", fmt.Sprintf("k%02d=v%02d", i, i))
	}
	exactPrefix := `{"type":"object","description":"`
	exactSuffix := `"}`
	exact16KB := exactPrefix + strings.Repeat("a", resultSchemaMaxBytes-len(exactPrefix)-len(exactSuffix)) + exactSuffix
	if len(exact16KB) != resultSchemaMaxBytes {
		t.Fatalf("exact16KB len=%d, want %d", len(exact16KB), resultSchemaMaxBytes)
	}
	args16 = append(args16, "--result-schema", exact16KB, "hello")
	if c, o, e := captureExecuteFull(t, args16, ""); c != api.ExitOK {
		t.Fatalf("exact 16 labels + 16384B schema failed: exit=%d out=%s err=%s", c, o, e)
	}

	// 4. Local validation failures -> exit 64
	over16KB := exactPrefix + strings.Repeat("a", resultSchemaMaxBytes-len(exactPrefix)-len(exactSuffix)+1) + exactSuffix
	args17 := []string{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy"}
	for i := 1; i <= 17; i++ {
		args17 = append(args17, "--label", fmt.Sprintf("k%02d=v", i))
	}
	args17 = append(args17, "hello")

	badCases := []struct {
		name  string
		args  []string
		stdin string
	}{
		{name: "double_stdin_collision", args: []string{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--result-schema", "-", "-"}, stdin: `{"type":"object"}`},
		{name: "empty_result_schema_flag", args: []string{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--result-schema", "", "hello"}},
		{name: "schema_null", args: []string{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--result-schema", "null", "hello"}},
		{name: "schema_array", args: []string{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--result-schema", "[]", "hello"}},
		{name: "schema_trailing_json", args: []string{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--result-schema", `{}{}`, "hello"}},
		{name: "schema_missing_file", args: []string{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--result-schema", "@", "hello"}},
		{name: "schema_oversize_16385", args: []string{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--result-schema", over16KB, "hello"}},
		{name: "label_reserved_ahub_prefix", args: []string{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--label", "ahub.plan=p1", "hello"}},
		{name: "label_empty", args: []string{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--label", "", "hello"}},
		{name: "label_missing_equals", args: []string{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--label", "envprod", "hello"}},
		{name: "label_uppercase_key", args: []string{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--label", "Env=prod", "hello"}},
		{name: "label_control_char_value", args: []string{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--label", "env=a\nb", "hello"}},
		{name: "label_over_128_runes", args: []string{"--json", "run", "-n", "macmini", "-d", "/w", "-a", "agy", "--label", "env=" + strings.Repeat("x", 129), "hello"}},
		{name: "label_over_16", args: args17},
	}
	for _, tc := range badCases {
		c, o, _ := captureExecuteFull(t, tc.args, tc.stdin)
		if c != api.ExitBadUsageOrInput {
			t.Fatalf("%s: expected exit 64, got %d (out=%s)", tc.name, c, o)
		}
	}
}

func TestPlanSlice3LabelsAndResultSchemaValidation(t *testing.T) {
	var seenPlan api.CreatePlanRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&seenPlan); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":      true,
			"plan_id": "pln_s3_1",
			"runs":    []api.RunRecord{},
		})
	}))
	defer srv.Close()

	validPlan := `{
  "nodes": [
    {
      "key": "step1",
      "node_id": "macmini",
      "workdir": "~/workspace/demo",
      "agent": "agy",
      "prompt": "go",
      "labels": {"env": "prod", "team": "core"},
      "result_schema": {}
    }
  ]
}`
	c, o, e := captureExecuteFull(t, []string{
		"--url", srv.URL, "--token", "tok", "--json", "plan", "--file", "-",
	}, validPlan)
	if c != api.ExitOK {
		t.Fatalf("valid Slice 3 plan failed: exit=%d out=%s err=%s", c, o, e)
	}
	if len(seenPlan.Nodes) != 1 || seenPlan.Nodes[0].Labels["env"] != "prod" || string(seenPlan.Nodes[0].ResultSchema) != "{}" {
		t.Fatalf("unexpected plan node payload: %+v", seenPlan.Nodes)
	}

	over16KB := `{"type":"object","description":"` + strings.Repeat("a", resultSchemaMaxBytes) + `"}`
	badPlans := []struct {
		name string
		body string
	}{
		{
			name: "ahub_prefix_label",
			body: `{"nodes":[{"key":"a","node_id":"m","workdir":"/w","agent":"agy","prompt":"go","labels":{"ahub.foo":"bar"}}]}`,
		},
		{
			name: "result_schema_null",
			body: `{"nodes":[{"key":"a","node_id":"m","workdir":"/w","agent":"agy","prompt":"go","result_schema":null}]}`,
		},
		{
			name: "result_schema_array",
			body: `{"nodes":[{"key":"a","node_id":"m","workdir":"/w","agent":"agy","prompt":"go","result_schema":[]}]}`,
		},
		{
			name: "result_schema_oversize",
			body: `{"nodes":[{"key":"a","node_id":"m","workdir":"/w","agent":"agy","prompt":"go","result_schema":` + over16KB + `}]}`,
		},
	}
	for _, tc := range badPlans {
		code, out, _ := captureExecuteFull(t, []string{"--json", "plan", "--file", "-"}, tc.body)
		if code != api.ExitBadUsageOrInput {
			t.Fatalf("%s: expected exit 64, got %d (out=%s)", tc.name, code, out)
		}
	}
}

func TestRunsLabelFilterAndResultDataModes(t *testing.T) {
	var seenQueries []string
	runsMap := map[string]api.RunRecord{
		"run_done_obj": {
			ID:        "run_done_obj",
			ThreadID:  "thr_1",
			RootRunID: "run_done_obj",
			NodeID:    "macmini",
			Workdir:   "/w",
			Agent:     "agy",
			Status:    "done",
			Labels:    map[string]string{"env": "prod"},
			Result:    json.RawMessage(`{"token":"ahub_cli_secretinside123","count":9007199254740993,"expr":"$VAR <X>"}`),
		},
		"run_done_false": {
			ID:        "run_done_false",
			ThreadID:  "thr_1",
			RootRunID: "run_done_false",
			NodeID:    "macmini",
			Workdir:   "/w",
			Agent:     "agy",
			Status:    "done",
			Result:    json.RawMessage(`false`),
		},
		"run_done_absent": {
			ID:        "run_done_absent",
			ThreadID:  "thr_1",
			RootRunID: "run_done_absent",
			NodeID:    "macmini",
			Workdir:   "/w",
			Agent:     "agy",
			Status:    "done",
		},
		"run_schema_mismatch": {
			ID:           "run_schema_mismatch",
			ThreadID:     "thr_1",
			RootRunID:    "run_schema_mismatch",
			NodeID:       "macmini",
			Workdir:      "/w",
			Agent:        "agy",
			Status:       "failed",
			ErrorCode:    "RESULT_SCHEMA_MISMATCH",
			ErrorMessage: "schema failed with token ahub_cli_leakerr99",
			OutputMD:     "preserved agent markdown output",
		},
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/v1/runs" {
			seenQueries = append(seenQueries, r.URL.RawQuery)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "runs": []api.RunRecord{}})
			return
		}
		id := strings.TrimPrefix(r.URL.Path, "/api/v1/runs/")
		if rec, ok := runsMap[id]; ok {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "run": rec})
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	// 1. ahub runs --label (allows ahub.*, up to 8 filters)
	args8 := []string{"--url", srv.URL, "--token", "tok", "--json", "runs", "--label", "ahub.plan=pln_1", "--label", "env=prod"}
	for i := 3; i <= 8; i++ {
		args8 = append(args8, "--label", fmt.Sprintf("f%d=v", i))
	}
	c, o, e := captureExecuteFull(t, args8, "")
	if c != api.ExitOK || len(seenQueries) != 1 {
		t.Fatalf("runs --label (8 filters) failed: exit=%d out=%s err=%s", c, o, e)
	}
	if !strings.Contains(seenQueries[0], "label=ahub.plan%3Dpln_1&label=env%3Dprod") {
		t.Fatalf("unexpected query: %q", seenQueries[0])
	}

	// >8 filters or malformed filter -> exit 64
	args9 := append(append([]string(nil), args8...), "--label", "f9=v")
	for _, bad := range [][]string{
		args9,
		{"--json", "runs", "--label", ""},
		{"--json", "runs", "--label", "noequals"},
		{"--json", "runs", "--label", "BadKey=1"},
	} {
		if code, _, _ := captureExecuteFull(t, bad, ""); code != api.ExitBadUsageOrInput {
			t.Fatalf("expected exit 64 for %v, got %d", bad, code)
		}
	}

	// 2. ahub result --data --json on object (redacted, exact large int, unescaped <X>)
	cObj, outObj, _ := captureExecuteFull(t, []string{"--url", srv.URL, "--token", "tok", "--json", "result", "run_done_obj", "--data"}, "")
	if cObj != api.ExitOK {
		t.Fatalf("result --data --json obj exit=%d out=%s", cObj, outObj)
	}
	if strings.Contains(outObj, "secretinside123") {
		t.Fatalf("result --data leaked secret: %s", outObj)
	}
	var envObj struct {
		OK     bool            `json:"ok"`
		RunID  string          `json:"run_id"`
		Status string          `json:"status"`
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal([]byte(outObj), &envObj); err != nil {
		t.Fatalf("invalid json from result --data --json: %v (%s)", err, outObj)
	}
	if !envObj.OK || envObj.RunID != "run_done_obj" || envObj.Status != "done" || !strings.Contains(string(envObj.Result), "9007199254740993") || !strings.Contains(string(envObj.Result), "$VAR <X>") {
		t.Fatalf("unexpected result --data --json payload: %+v (%s)", envObj, string(envObj.Result))
	}

	// 3. ahub result --data --json preserves boolean false and maps absent result to null
	cFalse, outFalse, _ := captureExecuteFull(t, []string{"--url", srv.URL, "--token", "tok", "--json", "result", "run_done_false", "--data"}, "")
	if cFalse != api.ExitOK || !strings.Contains(outFalse, `"result":false`) {
		t.Fatalf("expected result:false, exit=%d out=%s", cFalse, outFalse)
	}
	cAbs, outAbs, _ := captureExecuteFull(t, []string{"--url", srv.URL, "--token", "tok", "--json", "result", "run_done_absent", "--data"}, "")
	if cAbs != api.ExitOK || !strings.Contains(outAbs, `"result":null`) {
		t.Fatalf("expected result:null, exit=%d out=%s", cAbs, outAbs)
	}

	// 4. ahub result --data (human mode) pretty-prints JSON or prints null
	cHuman, outHuman, _ := captureExecuteFull(t, []string{"--url", srv.URL, "--token", "tok", "result", "run_done_obj", "--data"}, "")
	if cHuman != api.ExitOK || !strings.Contains(outHuman, "\n  \"count\": 9007199254740993") {
		t.Fatalf("expected pretty-printed JSON in human --data mode, exit=%d out=%q", cHuman, outHuman)
	}
	cHumanNull, outHumanNull, _ := captureExecuteFull(t, []string{"--url", srv.URL, "--token", "tok", "result", "run_done_absent", "--data"}, "")
	if cHumanNull != api.ExitOK || strings.TrimSpace(outHumanNull) != "null" {
		t.Fatalf("expected 'null' in human --data mode, exit=%d out=%q", cHumanNull, outHumanNull)
	}

	// 5. RESULT_SCHEMA_MISMATCH preserves exit 10 and redacts error_message
	cMis, outMis, _ := captureExecuteFull(t, []string{"--url", srv.URL, "--token", "tok", "--json", "result", "run_schema_mismatch", "--data"}, "")
	if cMis != api.ExitRunFailed {
		t.Fatalf("expected exit 10 on RESULT_SCHEMA_MISMATCH, got %d (out=%s)", cMis, outMis)
	}
	if strings.Contains(outMis, "leakerr99") || !strings.Contains(outMis, `"error_code":"RESULT_SCHEMA_MISMATCH"`) || !strings.Contains(outMis, `"result":null`) {
		t.Fatalf("unexpected RESULT_SCHEMA_MISMATCH --data --json output: %s", outMis)
	}

	cMisHuman, outMisHuman, errMisHuman := captureExecuteFull(t, []string{"--url", srv.URL, "--token", "tok", "result", "run_schema_mismatch", "--data"}, "")
	if cMisHuman != api.ExitRunFailed || strings.TrimSpace(outMisHuman) != "null" {
		t.Fatalf("expected exit 10 and stdout null, got exit=%d out=%q", cMisHuman, outMisHuman)
	}
	if !strings.Contains(errMisHuman, "RESULT_SCHEMA_MISMATCH") || strings.Contains(errMisHuman, "leakerr99") {
		t.Fatalf("expected redacted error on stderr, got %q", errMisHuman)
	}
}
