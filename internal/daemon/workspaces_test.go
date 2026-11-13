package daemon

import (
	"os"
	"path/filepath"
	"testing"
)

func TestScanWorkspacesDiscoversGitAndSkipsIgnored(t *testing.T) {
	root := t.TempDir()
	projA := filepath.Join(root, "alpha")
	if err := os.MkdirAll(filepath.Join(projA, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projA, ".git", "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	ignored := filepath.Join(root, "node_modules")
	if err := os.MkdirAll(filepath.Join(ignored, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}

	nestedRoot := filepath.Join(root, "org")
	nestedProj := filepath.Join(nestedRoot, "alpha")
	if err := os.MkdirAll(filepath.Join(nestedProj, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}

	entries := ScanWorkspaces([]string{root}, []string{"node_modules"})
	if len(entries) != 2 {
		t.Fatalf("expected 2 workspaces, got %d (%+v)", len(entries), entries)
	}
	keys := map[string]bool{}
	for _, e := range entries {
		keys[e.Key] = true
		if e.Key == "alpha" && e.DefaultBranch != "main" {
			t.Fatalf("expected main branch for %+v", e)
		}
	}
	if len(keys) != 2 {
		t.Fatalf("expected disambiguated keys when basename collides, got %+v", entries)
	}
}
