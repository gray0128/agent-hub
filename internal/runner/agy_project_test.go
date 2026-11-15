package runner

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/gray0128/agent-hub/internal/api"
	"github.com/gray0128/agent-hub/internal/config"
)

func writeSyntheticProjectFile(t *testing.T, projectsDir, filename string, payload map[string]interface{}) {
	t.Helper()
	if err := os.MkdirAll(projectsDir, 0o755); err != nil {
		t.Fatalf("mkdir projectsDir: %v", err)
	}
	raw, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		t.Fatalf("marshal project: %v", err)
	}
	if err := os.WriteFile(filepath.Join(projectsDir, filename), raw, 0o644); err != nil {
		t.Fatalf("write project file %s: %v", filename, err)
	}
}

func testFileURI(localPath string) string {
	slashed := filepath.ToSlash(localPath)
	if !strings.HasPrefix(slashed, "/") {
		slashed = "/" + slashed
	}
	return (&url.URL{Scheme: "file", Path: slashed}).String()
}

func TestResolveAgyProjectIDMatches(t *testing.T) {
	base := t.TempDir()
	wsGit := filepath.Join(base, "repo-git")
	wsFolder := filepath.Join(base, "repo-folder")
	wsEncoded := filepath.Join(base, "space dir", "中文项目")
	wsOuter := filepath.Join(base, "outer")
	wsInner := filepath.Join(wsOuter, "inner")
	wsInnerSub := filepath.Join(wsInner, "pkg", "sub")
	wsOuterSub := filepath.Join(wsOuter, "other-pkg")

	for _, dir := range []string{wsGit, wsFolder, wsEncoded, wsInnerSub, wsOuterSub} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}

	projectsDir := filepath.Join(base, "projects")
	gitID := "11111111-1111-1111-1111-111111111111"
	folderID := "22222222-2222-2222-2222-222222222222"
	encodedID := "33333333-3333-3333-3333-333333333333"
	outerID := "44444444-4444-4444-4444-444444444444"
	innerID := "55555555-5555-5555-5555-555555555555"
	rootID := "66666666-6666-6666-6666-666666666666"

	writeSyntheticProjectFile(t, projectsDir, gitID+".json", map[string]interface{}{
		"id":              gitID,
		"name":            "repo-git",
		"isWorkspaceOnly": false,
		"projectResources": map[string]interface{}{
			"resources": []map[string]interface{}{
				{"gitFolder": map[string]interface{}{"folderUri": testFileURI(wsGit), "defaultBranch": "main"}},
			},
		},
	})
	writeSyntheticProjectFile(t, projectsDir, folderID+".json", map[string]interface{}{
		"id":              folderID,
		"name":            "repo-folder",
		"isWorkspaceOnly": false,
		"projectResources": map[string]interface{}{
			"resources": []map[string]interface{}{
				{"folderUri": testFileURI(wsFolder)},
			},
		},
	})
	writeSyntheticProjectFile(t, projectsDir, encodedID+".json", map[string]interface{}{
		"id":              encodedID,
		"name":            "encoded",
		"isWorkspaceOnly": false,
		"projectResources": map[string]interface{}{
			"resources": []map[string]interface{}{
				{"folderUri": testFileURI(wsEncoded)},
			},
		},
	})
	writeSyntheticProjectFile(t, projectsDir, outerID+".json", map[string]interface{}{
		"id":              outerID,
		"name":            "outer",
		"isWorkspaceOnly": false,
		"projectResources": map[string]interface{}{
			"resources": []map[string]interface{}{
				{"folderUri": testFileURI(wsOuter)},
			},
		},
	})
	writeSyntheticProjectFile(t, projectsDir, innerID+".json", map[string]interface{}{
		"id":              innerID,
		"name":            "inner",
		"isWorkspaceOnly": false,
		"projectResources": map[string]interface{}{
			"resources": []map[string]interface{}{
				{"gitFolder": map[string]interface{}{"folderUri": testFileURI(wsInner)}},
			},
		},
	})
	writeSyntheticProjectFile(t, projectsDir, rootID+".json", map[string]interface{}{
		"id":              rootID,
		"name":            "root-should-never-match",
		"isWorkspaceOnly": false,
		"projectResources": map[string]interface{}{
			"resources": []map[string]interface{}{
				{"folderUri": "file:///"},
			},
		},
	})

	if got := resolveAgyProjectIDFromDir(wsGit, projectsDir); got != gitID {
		t.Fatalf("gitFolder exact match: got %q, want %q", got, gitID)
	}
	if got := resolveAgyProjectIDFromDir(wsFolder, projectsDir); got != folderID {
		t.Fatalf("folderUri exact match: got %q, want %q", got, folderID)
	}
	if got := resolveAgyProjectIDFromDir(wsEncoded, projectsDir); got != encodedID {
		t.Fatalf("percent-encoded folderUri match: got %q, want %q", got, encodedID)
	}
	if got := resolveAgyProjectIDFromDir(wsOuterSub, projectsDir); got != outerID {
		t.Fatalf("outer ancestor match: got %q, want %q", got, outerID)
	}
	if got := resolveAgyProjectIDFromDir(wsInnerSub, projectsDir); got != innerID {
		t.Fatalf("deeper nested ancestor match: got %q, want %q", got, innerID)
	}

	unmatched := filepath.Join(base, "unmatched")
	if err := os.MkdirAll(unmatched, 0o755); err != nil {
		t.Fatalf("mkdir unmatched: %v", err)
	}
	if got := resolveAgyProjectIDFromDir(unmatched, projectsDir); got != "" {
		t.Fatalf("expected empty project ID for unmatched dir (root file:/// must not match), got %q", got)
	}
}

func TestResolveAgyProjectIDIgnoresDefaultCLIProjectAndRanksTieBreakers(t *testing.T) {
	base := t.TempDir()
	ws := filepath.Join(base, "demo")
	wsPolicy := filepath.Join(base, "demo-policy")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatalf("mkdir ws: %v", err)
	}
	if err := os.MkdirAll(wsPolicy, 0o755); err != nil {
		t.Fatalf("mkdir wsPolicy: %v", err)
	}

	projectsDir := filepath.Join(base, "projects")
	writeSyntheticProjectFile(t, projectsDir, "default-cli-project.json", map[string]interface{}{
		"id":   "default-cli-project",
		"name": "CLI Project",
		"projectResources": map[string]interface{}{
			"resources": []map[string]interface{}{
				{"folderUri": testFileURI(ws)},
			},
		},
	})
	writeSyntheticProjectFile(t, projectsDir, "alias-default.json", map[string]interface{}{
		"id":   "default-cli-project",
		"name": "CLI Project Copy",
		"projectResources": map[string]interface{}{
			"resources": []map[string]interface{}{
				{"folderUri": testFileURI(ws)},
			},
		},
	})

	wsOnlyID := "11111111-1111-1111-1111-111111111111"
	fullID := "99999999-9999-9999-9999-999999999999"
	writeSyntheticProjectFile(t, projectsDir, wsOnlyID+".json", map[string]interface{}{
		"id":              wsOnlyID,
		"name":            "ws-only",
		"isWorkspaceOnly": true,
		"projectResources": map[string]interface{}{
			"resources": []map[string]interface{}{
				{"folderUri": testFileURI(ws)},
			},
		},
	})
	writeSyntheticProjectFile(t, projectsDir, fullID+".json", map[string]interface{}{
		"id":              fullID,
		"name":            "full-project",
		"isWorkspaceOnly": false,
		"projectResources": map[string]interface{}{
			"resources": []map[string]interface{}{
				{"folderUri": testFileURI(ws)},
			},
		},
	})

	if got := resolveAgyProjectIDFromDir(ws, projectsDir); got != fullID {
		t.Fatalf("expected !isWorkspaceOnly project %q to beat workspaceOnly %q and default-cli-project, got %q", fullID, wsOnlyID, got)
	}

	noPolicyID := "11111111-aaaa-1111-1111-111111111111"
	withPolicyID := "99999999-bbbb-9999-9999-999999999999"
	writeSyntheticProjectFile(t, projectsDir, noPolicyID+".json", map[string]interface{}{
		"id":              noPolicyID,
		"name":            "empty-policy",
		"isWorkspaceOnly": false,
		"settings":        map[string]interface{}{},
		"projectResources": map[string]interface{}{
			"resources": []map[string]interface{}{
				{"folderUri": testFileURI(wsPolicy)},
			},
		},
	})
	writeSyntheticProjectFile(t, projectsDir, withPolicyID+".json", map[string]interface{}{
		"id":               withPolicyID,
		"name":             "with-policy",
		"isWorkspaceOnly":  false,
		"permissionGrants": map[string]interface{}{"allow": []string{"command(go test)"}},
		"projectResources": map[string]interface{}{
			"resources": []map[string]interface{}{
				{"folderUri": testFileURI(wsPolicy)},
			},
		},
	})

	if got := resolveAgyProjectIDFromDir(wsPolicy, projectsDir); got != withPolicyID {
		t.Fatalf("expected policy project %q to beat empty policy %q, got %q", withPolicyID, noPolicyID, got)
	}
}

func TestResolveAgyProjectIDSymlinkMatch(t *testing.T) {
	base := t.TempDir()
	realDir := filepath.Join(base, "real-workspace")
	linkDir := filepath.Join(base, "link-workspace")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatalf("mkdir realDir: %v", err)
	}
	if err := os.Symlink(realDir, linkDir); err != nil {
		t.Skipf("symlink unsupported in environment: %v", err)
	}

	projectsDir := filepath.Join(base, "projects")
	projID := "77777777-7777-7777-7777-777777777777"
	writeSyntheticProjectFile(t, projectsDir, projID+".json", map[string]interface{}{
		"id":              projID,
		"name":            "symlinked",
		"isWorkspaceOnly": false,
		"projectResources": map[string]interface{}{
			"resources": []map[string]interface{}{
				{"folderUri": testFileURI(realDir)},
			},
		},
	})

	if got := resolveAgyProjectIDFromDir(linkDir, projectsDir); got != projID {
		t.Fatalf("symlinked workdir -> real project URI: got %q, want %q", got, projID)
	}
}

func TestBuildCommandSpecAgyProjectInjection(t *testing.T) {
	fakeHome := t.TempDir()
	t.Setenv("HOME", fakeHome)
	t.Setenv("USERPROFILE", fakeHome)

	matchedDir := filepath.Join(fakeHome, "workspace", "demo")
	unmatchedDir := filepath.Join(fakeHome, "workspace", "other")
	for _, dir := range []string{matchedDir, unmatchedDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}

	projID := "88888888-8888-8888-8888-888888888888"
	projectsDir := filepath.Join(fakeHome, ".gemini", "config", "projects")
	writeSyntheticProjectFile(t, projectsDir, projID+".json", map[string]interface{}{
		"id":              projID,
		"name":            "demo",
		"isWorkspaceOnly": false,
		"projectResources": map[string]interface{}{
			"resources": []map[string]interface{}{
				{"gitFolder": map[string]interface{}{"folderUri": testFileURI(matchedDir), "defaultBranch": "main"}},
			},
		},
	})

	_, args, _, err := BuildCommandSpec(api.RunRecord{
		Agent:   "agy",
		Workdir: matchedDir,
		Sandbox: true,
		Prompt:  "inspect",
	}, config.AgentConfig{Command: "agy"})
	if err != nil {
		t.Fatalf("BuildCommandSpec matched error: %v", err)
	}
	idx := slices.Index(args, "--project")
	if idx == -1 || idx+1 >= len(args) || args[idx+1] != projID {
		t.Fatalf("expected --project %s in args, got %v", projID, args)
	}

	_, unmatchedArgs, _, err := BuildCommandSpec(api.RunRecord{
		Agent:   "agy",
		Workdir: unmatchedDir,
		Prompt:  "inspect",
	}, config.AgentConfig{Command: "agy"})
	if err != nil {
		t.Fatalf("BuildCommandSpec unmatched error: %v", err)
	}
	if slices.Contains(unmatchedArgs, "--project") {
		t.Fatalf("did not expect --project for unmatched workdir, got %v", unmatchedArgs)
	}

	for _, override := range [][]string{
		{"--project", "custom-proj"},
		{"--project=custom-proj"},
		{"--new-project"},
	} {
		_, overrideArgs, _, err := BuildCommandSpec(api.RunRecord{
			Agent:   "agy",
			Workdir: matchedDir,
			Prompt:  "inspect",
		}, config.AgentConfig{Command: "agy", Args: override})
		if err != nil {
			t.Fatalf("BuildCommandSpec override %v error: %v", override, err)
		}
		count := 0
		for _, a := range overrideArgs {
			if a == "--project" || strings.HasPrefix(a, "--project=") || a == "--new-project" || strings.HasPrefix(a, "--new-project=") {
				count++
			}
		}
		if count != 1 {
			t.Fatalf("expected exactly 1 project flag when agentCfg.Args=%v, got %v", override, overrideArgs)
		}
	}
}
