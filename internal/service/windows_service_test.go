package service

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestWindowsServicePathsAndRunnerScript(t *testing.T) {
	home := filepath.Join("C:", "Users", "demo")
	gotDefault, err := ServiceFilePathForOS("windows", home, "")
	if err != nil {
		t.Fatalf("ServiceFilePathForOS default windows failed: %v", err)
	}
	wantDefault := filepath.Join(home, ".config", "ahub", WindowsRunner)
	if gotDefault != wantDefault {
		t.Fatalf("expected default windows path %q, got %q", wantDefault, gotDefault)
	}

	targetDir := filepath.Join("C:", "ahub-svc")
	gotTarget, err := ServiceFilePathForOS("windows", home, targetDir)
	if err != nil {
		t.Fatalf("ServiceFilePathForOS target windows failed: %v", err)
	}
	wantTarget := filepath.Join(targetDir, WindowsRunner)
	if gotTarget != wantTarget {
		t.Fatalf("expected target windows path %q, got %q", wantTarget, gotTarget)
	}

	script := RenderWindowsRunnerScript(
		`C:\Users\demo\.config\ahub\ahub-shim.exe`,
		`C:\bin\ahub.exe`,
		`C:\Users\demo\.config\ahub\node.json`,
		`C:\Users\demo\.config\ahub\logs\ahub-node.log`,
	)
	for _, needle := range []string{
		"@echo off",
		"node shim --bin",
		`ahub-shim.exe`,
		`C:\bin\ahub.exe`,
		`node.json`,
		`ahub-node.log`,
	} {
		if !strings.Contains(script, needle) {
			t.Fatalf("expected windows runner script to contain %q, got:\n%s", needle, script)
		}
	}
}
