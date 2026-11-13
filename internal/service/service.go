package service

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/gray0128/agent-hub/internal/config"
)

const (
	LaunchdLabel = "win.bobocai.ahub.node"
	SystemdUnit  = "ahub-node.service"
)

func ServiceFilePath(targetDir string) (string, error) {
	if strings.TrimSpace(targetDir) != "" {
		dir := config.ExpandPath(targetDir)
		if runtime.GOOS == "darwin" {
			return filepath.Join(dir, LaunchdLabel+".plist"), nil
		}
		return filepath.Join(dir, SystemdUnit), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "LaunchAgents", LaunchdLabel+".plist"), nil
	}
	return filepath.Join(home, ".config", "systemd", "user", SystemdUnit), nil
}

func RenderLaunchdPlist(binPath, cfgPath, logDir string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
    <string>node</string>
    <string>serve</string>
    <string>--config</string>
    <string>%s</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>%s</string>
  <key>StandardErrorPath</key>
  <string>%s</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>%s</string>
  </dict>
</dict>
</plist>
`, LaunchdLabel, xmlEscape(binPath), xmlEscape(cfgPath),
		xmlEscape(filepath.Join(logDir, "ahub-node.stdout.log")),
		xmlEscape(filepath.Join(logDir, "ahub-node.stderr.log")),
		xmlEscape(os.Getenv("PATH")))
}

func RenderSystemdUnit(binPath, cfgPath string) string {
	return fmt.Sprintf(`[Unit]
Description=agent-hub Node Daemon (ahub node serve)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%s node serve --config %s
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`, binPath, cfgPath)
}

func Install(binPath, cfgPath, targetDir string, activate bool) (string, error) {
	if binPath == "" {
		exe, err := os.Executable()
		if err != nil {
			return "", err
		}
		binPath = exe
	}
	if cfgPath == "" {
		var err error
		cfgPath, err = config.DefaultNodeConfigPath()
		if err != nil {
			return "", err
		}
	} else {
		cfgPath = config.ExpandPath(cfgPath)
	}

	destPath, err := ServiceFilePath(targetDir)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return "", err
	}

	var content string
	if runtime.GOOS == "darwin" {
		logDir := filepath.Join(filepath.Dir(cfgPath), "logs")
		if targetDir != "" {
			logDir = filepath.Join(config.ExpandPath(targetDir), "logs")
		}
		_ = os.MkdirAll(logDir, 0o755)
		content = RenderLaunchdPlist(binPath, cfgPath, logDir)
	} else {
		content = RenderSystemdUnit(binPath, cfgPath)
	}

	if err := os.WriteFile(destPath, []byte(content), 0o644); err != nil {
		return "", err
	}

	if activate {
		if runtime.GOOS == "darwin" {
			uid := fmt.Sprintf("gui/%d", os.Getuid())
			_ = exec.Command("launchctl", "bootout", uid, destPath).Run()
			if out, err := exec.Command("launchctl", "bootstrap", uid, destPath).CombinedOutput(); err != nil {
				return destPath, fmt.Errorf("launchctl bootstrap failed: %w (%s)", err, strings.TrimSpace(string(out)))
			}
		} else if runtime.GOOS == "linux" {
			_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
			if out, err := exec.Command("systemctl", "--user", "enable", "--now", SystemdUnit).CombinedOutput(); err != nil {
				return destPath, fmt.Errorf("systemctl enable failed: %w (%s)", err, strings.TrimSpace(string(out)))
			}
		}
	}

	return destPath, nil
}

func Uninstall(targetDir string, deactivate bool) (string, error) {
	destPath, err := ServiceFilePath(targetDir)
	if err != nil {
		return "", err
	}
	if deactivate {
		if runtime.GOOS == "darwin" {
			uid := fmt.Sprintf("gui/%d", os.Getuid())
			_ = exec.Command("launchctl", "bootout", uid, destPath).Run()
		} else if runtime.GOOS == "linux" {
			_ = exec.Command("systemctl", "--user", "disable", "--now", SystemdUnit).Run()
		}
	}
	if err := os.Remove(destPath); err != nil && !os.IsNotExist(err) {
		return destPath, err
	}
	return destPath, nil
}

func xmlEscape(s string) string {
	r := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		"\"", "&quot;",
		"'", "&apos;",
	)
	return r.Replace(s)
}
