package runner

import (
	"strings"
	"testing"

	"github.com/gray0128/agent-hub/internal/api"
)

func TestBuildSanitizedEnvStripsSecretsAndInjectsLineage(t *testing.T) {
	t.Setenv("AHUB_TOKEN", "ahub_adm_supersecret_should_never_leak")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "secret-aws-key")
	t.Setenv("XDG_CONFIG_HOME", "/tmp/xdg-cfg")

	run := api.RunRecord{
		ID:        "run_01JTEST",
		ThreadID:  "thr_01JTEST",
		RootRunID: "run_01JROOT",
		Depth:     1,
	}

	env := BuildSanitizedEnv(run, "http://127.0.0.1:8787", "")
	kv := make(map[string]string, len(env))
	for _, item := range env {
		idx := strings.IndexByte(item, '=')
		if idx > 0 {
			kv[item[:idx]] = item[idx+1:]
		}
	}

	if _, ok := kv["AHUB_TOKEN"]; ok {
		t.Fatalf("expected AHUB_TOKEN to be stripped when delegationToken is empty")
	}
	if _, ok := kv["AWS_SECRET_ACCESS_KEY"]; ok {
		t.Fatalf("expected AWS_SECRET_ACCESS_KEY to be stripped")
	}
	if kv["XDG_CONFIG_HOME"] != "/tmp/xdg-cfg" {
		t.Fatalf("expected XDG_CONFIG_HOME preserved, got %q", kv["XDG_CONFIG_HOME"])
	}
	if kv["AHUB_RUN_ID"] != run.ID || kv["AHUB_THREAD_ID"] != run.ThreadID || kv["AHUB_ROOT_RUN_ID"] != run.RootRunID || kv["AHUB_DEPTH"] != "1" {
		t.Fatalf("lineage vars mismatch: %+v", kv)
	}

	envWithDelegation := BuildSanitizedEnv(run, "http://127.0.0.1:8787", "ahub_del_ephemeral")
	kv2 := make(map[string]string, len(envWithDelegation))
	for _, item := range envWithDelegation {
		idx := strings.IndexByte(item, '=')
		if idx > 0 {
			kv2[item[:idx]] = item[idx+1:]
		}
	}
	if kv2["AHUB_TOKEN"] != "ahub_del_ephemeral" || kv2["AHUB_URL"] != "http://127.0.0.1:8787" {
		t.Fatalf("expected ephemeral delegation token & URL, got %+v", kv2)
	}
}
