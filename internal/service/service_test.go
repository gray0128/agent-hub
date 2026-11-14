package service

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
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

	shimPlist := RenderLaunchdPlistForShim("/tmp/AhubDaemon.app/Contents/MacOS/AhubDaemon", "/usr/local/bin/ahub", "/tmp/node.json", dir)
	if !strings.Contains(shimPlist, "<string>shim</string>") || !strings.Contains(shimPlist, "<string>/tmp/AhubDaemon.app/Contents/MacOS/AhubDaemon</string>") {
		t.Fatalf("unexpected shim plist: %s", shimPlist)
	}
	shimPlistPath := filepath.Join(dir, LaunchdLabel+".shim.plist")
	if err := os.WriteFile(shimPlistPath, []byte(shimPlist), 0o644); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "darwin" {
		if plutil, err := exec.LookPath("plutil"); err == nil {
			out, err := exec.Command(plutil, "-lint", shimPlistPath).CombinedOutput()
			if err != nil {
				t.Fatalf("shim plutil -lint failed: %v\n%s", err, string(out))
			}
		}
	}

	unit := RenderSystemdUnit("/usr/local/bin/ahub", "/tmp/node.json")
	if !strings.Contains(unit, "ExecStart=/usr/local/bin/ahub node serve --config /tmp/node.json") {
		t.Fatalf("unexpected systemd unit: %s", unit)
	}

	if runtime.GOOS == "darwin" {
		gotPath := buildLaunchdPath("/Users/demo/.local/bin/ahub", "/usr/bin:/bin:/usr/bin")
		if !strings.Contains(gotPath, "/opt/homebrew/bin") || !strings.Contains(gotPath, "/usr/local/bin") {
			t.Fatalf("expected homebrew and local bin dirs in launchd PATH, got %q", gotPath)
		}
		if strings.Count(gotPath, "/usr/bin") != 1 {
			t.Fatalf("expected deduplicated /usr/bin in launchd PATH, got %q", gotPath)
		}
	}
}

func TestDarwinDaemonAppFreezeOnceIdempotency(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("darwin-only AhubDaemon.app codesign test")
	}

	tmp := t.TempDir()
	svcDir := filepath.Join(tmp, "svc")
	t.Setenv("AHUB_APP_DIR", "")

	srcBin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}

	info1, err := EnsureDarwinDaemonApp(srcBin, svcDir, false)
	if err != nil {
		t.Fatalf("EnsureDarwinDaemonApp initial failed: %v", err)
	}
	if !info1.Exists || !info1.Signed || info1.Identifier != DarwinDaemonBundleID || info1.CDHash == "" {
		t.Fatalf("unexpected initial DarwinDaemonAppInfo: %+v", info1)
	}
	stat1, err := os.Stat(info1.ExecutablePath)
	if err != nil {
		t.Fatal(err)
	}

	// Second call without recreate MUST be a no-op preserving CDHash and mtime
	time.Sleep(25 * time.Millisecond)
	info2, err := EnsureDarwinDaemonApp(srcBin, svcDir, false)
	if err != nil {
		t.Fatalf("EnsureDarwinDaemonApp second failed: %v", err)
	}
	if info2.CDHash != info1.CDHash {
		t.Fatalf("CDHash changed without --recreate-app: %q -> %q", info1.CDHash, info2.CDHash)
	}
	stat2, err := os.Stat(info2.ExecutablePath)
	if err != nil {
		t.Fatal(err)
	}
	if !stat2.ModTime().Equal(stat1.ModTime()) {
		t.Fatalf("AhubDaemon binary rewritten without recreate: mtime %v -> %v", stat1.ModTime(), stat2.ModTime())
	}

	// Explicit recreate re-signs and updates executable mtime
	time.Sleep(25 * time.Millisecond)
	info3, err := EnsureDarwinDaemonApp(srcBin, svcDir, true)
	if err != nil {
		t.Fatalf("EnsureDarwinDaemonApp recreate failed: %v", err)
	}
	if !info3.Signed || info3.Identifier != DarwinDaemonBundleID {
		t.Fatalf("recreated app lost signature: %+v", info3)
	}
	stat3, err := os.Stat(info3.ExecutablePath)
	if err != nil {
		t.Fatal(err)
	}
	if !stat3.ModTime().After(stat1.ModTime()) {
		t.Fatalf("expected recreate=true to rewrite binary mtime: before=%v after=%v", stat1.ModTime(), stat3.ModTime())
	}
}
