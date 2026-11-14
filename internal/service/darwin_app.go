package service

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/gray0128/agent-hub/internal/config"
)

const (
	DarwinDaemonAppName  = "AhubDaemon.app"
	DarwinDaemonBundleID = "win.bobocai.ahub.daemon"
	DarwinDaemonExecName = "AhubDaemon"
)

type DarwinDaemonAppInfo struct {
	AppPath        string `json:"app_path,omitempty"`
	ExecutablePath string `json:"executable_path,omitempty"`
	Exists         bool   `json:"exists"`
	Signed         bool   `json:"signed"`
	Identifier     string `json:"identifier,omitempty"`
	CDHash         string `json:"cdhash,omitempty"`
}

func DarwinDaemonAppDir(targetDir string) (string, error) {
	if override := strings.TrimSpace(os.Getenv("AHUB_APP_DIR")); override != "" {
		return config.ExpandPath(override), nil
	}
	if strings.TrimSpace(targetDir) != "" {
		return filepath.Join(config.ExpandPath(targetDir), DarwinDaemonAppName), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Applications", DarwinDaemonAppName), nil
}

func DarwinDaemonExecutablePath(appDir string) string {
	return filepath.Join(appDir, "Contents", "MacOS", DarwinDaemonExecName)
}

func InspectDarwinDaemonApp(targetDir string) DarwinDaemonAppInfo {
	if runtime.GOOS != "darwin" {
		return DarwinDaemonAppInfo{}
	}
	appDir, err := DarwinDaemonAppDir(targetDir)
	if err != nil {
		return DarwinDaemonAppInfo{}
	}
	exePath := DarwinDaemonExecutablePath(appDir)
	plistPath := filepath.Join(appDir, "Contents", "Info.plist")

	exeInfo, errExe := os.Stat(exePath)
	plistInfo, errPlist := os.Stat(plistPath)
	exists := errExe == nil && !exeInfo.IsDir() && exeInfo.Size() > 0 && errPlist == nil && !plistInfo.IsDir()

	info := DarwinDaemonAppInfo{
		AppPath:        appDir,
		ExecutablePath: exePath,
		Exists:         exists,
	}
	if !exists {
		return info
	}

	codesignBin := findCodesignBin()
	if codesignBin == "" {
		return info
	}
	if err := exec.Command(codesignBin, "--verify", "--deep", "--strict", appDir).Run(); err == nil {
		info.Signed = true
	}
	out, _ := exec.Command(codesignBin, "-dvvv", appDir).CombinedOutput()
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Identifier=") {
			info.Identifier = strings.TrimPrefix(line, "Identifier=")
		} else if strings.HasPrefix(line, "CDHash=") {
			info.CDHash = strings.TrimPrefix(line, "CDHash=")
		}
	}
	return info
}

// EnsureDarwinDaemonApp freezes a signed .app wrapper once so macOS Full Disk Access TCC grants survive ahub self-updates.
func EnsureDarwinDaemonApp(sourceBin, targetDir string, recreate bool) (DarwinDaemonAppInfo, error) {
	if runtime.GOOS != "darwin" {
		return DarwinDaemonAppInfo{}, nil
	}
	existing := InspectDarwinDaemonApp(targetDir)
	if !recreate && existing.Exists && existing.Signed && existing.Identifier == DarwinDaemonBundleID {
		return existing, nil
	}

	appDir, err := DarwinDaemonAppDir(targetDir)
	if err != nil {
		return DarwinDaemonAppInfo{}, err
	}
	src := strings.TrimSpace(sourceBin)
	if src != "" {
		src = config.ExpandPath(src)
	}
	if src == "" || !isRegularFile(src) {
		exe, err := os.Executable()
		if err != nil {
			return DarwinDaemonAppInfo{}, fmt.Errorf("resolve executable for AhubDaemon.app: %w", err)
		}
		src = exe
	}

	contentsDir := filepath.Join(appDir, "Contents")
	macOSDir := filepath.Join(contentsDir, "MacOS")
	if err := os.MkdirAll(macOSDir, 0o755); err != nil {
		return DarwinDaemonAppInfo{}, err
	}

	exePath := DarwinDaemonExecutablePath(appDir)
	if err := copyFileAtomic(src, exePath, 0o755); err != nil {
		return DarwinDaemonAppInfo{}, fmt.Errorf("copy AhubDaemon binary: %w", err)
	}

	plistPath := filepath.Join(contentsDir, "Info.plist")
	plist := renderDarwinAppInfoPlist()
	if err := os.WriteFile(plistPath, []byte(plist), 0o644); err != nil {
		return DarwinDaemonAppInfo{}, fmt.Errorf("write AhubDaemon Info.plist: %w", err)
	}

	if xattrBin, err := exec.LookPath("xattr"); err == nil {
		_ = exec.Command(xattrBin, "-cr", appDir).Run()
	}

	codesignBin := findCodesignBin()
	if codesignBin == "" {
		return DarwinDaemonAppInfo{}, fmt.Errorf("codesign not found on macOS")
	}
	if out, err := exec.Command(
		codesignBin,
		"--identifier", DarwinDaemonBundleID,
		"--force",
		"--deep",
		"--sign", "-",
		appDir,
	).CombinedOutput(); err != nil {
		return DarwinDaemonAppInfo{}, fmt.Errorf("codesign AhubDaemon.app failed: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	if out, err := exec.Command(codesignBin, "--verify", "--deep", "--strict", appDir).CombinedOutput(); err != nil {
		return DarwinDaemonAppInfo{}, fmt.Errorf("codesign verify failed: %w (%s)", err, strings.TrimSpace(string(out)))
	}

	return InspectDarwinDaemonApp(targetDir), nil
}

func renderDarwinAppInfoPlist() string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>%s</string>
  <key>CFBundleName</key>
  <string>%s</string>
  <key>CFBundleDisplayName</key>
  <string>%s</string>
  <key>CFBundleExecutable</key>
  <string>%s</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSBackgroundOnly</key>
  <true/>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`, DarwinDaemonBundleID, DarwinDaemonExecName, DarwinDaemonExecName, DarwinDaemonExecName)
}

func findCodesignBin() string {
	if isRegularFile("/usr/bin/codesign") {
		return "/usr/bin/codesign"
	}
	p, _ := exec.LookPath("codesign")
	return p
}

func isRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func copyFileAtomic(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	tmp, err := os.CreateTemp(filepath.Dir(dst), ".ahub-app-bin-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()

	if _, err := io.Copy(tmp, in); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpPath, mode); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, dst); err != nil {
		return err
	}
	cleanup = false
	return nil
}
