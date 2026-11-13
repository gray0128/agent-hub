package service

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestRenderLaunchdPlistAndSystemdUnit(t *testing.T) {
	dir := t.TempDir()
	plist := RenderLaunchdPlist("/usr/local/bin/ahub", "/tmp/node.json", dir)
	if !strings.Contains(plist, LaunchdLabel) || !strings.Contains(plist, "<key>KeepAlive</key>") {
		t.Fatalf("unexpected plist: %s", plist)
	}
	plistPath := filepath.Join(dir, LaunchdLabel+".plist")
	if err := os.WriteFile(plistPath, []byte(plist), 0o644); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "darwin" {
		if plutil, err := exec.LookPath("plutil"); err == nil {
			out, err := exec.Command(plutil, "-lint", plistPath).CombinedOutput()
			if err != nil {
				t.Fatalf("plutil -lint failed: %v\n%s", err, string(out))
			}
		}
	}

	unit := RenderSystemdUnit("/usr/local/bin/ahub", "/tmp/node.json")
	if !strings.Contains(unit, "ExecStart=/usr/local/bin/ahub node serve --config /tmp/node.json") {
		t.Fatalf("unexpected systemd unit: %s", unit)
	}
}
