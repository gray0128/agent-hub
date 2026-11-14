package service

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/gray0128/agent-hub/internal/config"
	"github.com/gray0128/agent-hub/internal/daemon"
)

const (
	LaunchdLabel = "win.bobocai.ahub.node"
	SystemdUnit  = "ahub-node.service"
)

type InstallOptions struct {
	BinPath     string
	ConfigPath  string
	TargetDir   string
	Activate    bool
	RecreateApp bool
}

type InstallResult struct {
	ServicePath string              `json:"path"`
	DaemonApp   DarwinDaemonAppInfo `json:"daemon_app,omitempty"`
}

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
	return RenderLaunchdPlistForShim("", binPath, cfgPath, logDir)
}

func RenderLaunchdPlistForShim(appExePath, binPath, cfgPath, logDir string) string {
	envPath := buildLaunchdPath(binPath, os.Getenv("PATH"))
	progArgsXML := fmt.Sprintf(`    <string>%s</string>
    <string>node</string>
    <string>serve</string>
    <string>--config</string>
    <string>%s</string>`, xmlEscape(binPath), xmlEscape(cfgPath))
	if strings.TrimSpace(appExePath) != "" {
		progArgsXML = fmt.Sprintf(`    <string>%s</string>
    <string>node</string>
    <string>shim</string>
    <string>--bin</string>
    <string>%s</string>
    <string>--config</string>
    <string>%s</string>`, xmlEscape(appExePath), xmlEscape(binPath), xmlEscape(cfgPath))
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>%s</string>
  <key>ProgramArguments</key>
  <array>
%s
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
`, LaunchdLabel, progArgsXML,
		xmlEscape(filepath.Join(logDir, "ahub-node.stdout.log")),
		xmlEscape(filepath.Join(logDir, "ahub-node.stderr.log")),
		xmlEscape(envPath))
}

func buildLaunchdPath(binPath, currentPath string) string {
	seen := make(map[string]struct{})
	var result []string
	appendUnique := func(dir string) {
		dir = strings.TrimSpace(dir)
		if dir == "" || dir == "." {
			return
		}
		clean := filepath.Clean(dir)
		if _, ok := seen[clean]; ok {
			return
		}
		seen[clean] = struct{}{}
		result = append(result, clean)
	}

	if strings.TrimSpace(binPath) != "" {
		appendUnique(filepath.Dir(binPath))
	}
	for _, p := range filepath.SplitList(currentPath) {
		appendUnique(p)
	}
	if runtime.GOOS == "darwin" {
		appendUnique("/opt/homebrew/bin")
		appendUnique("/usr/local/bin")
	}
	return strings.Join(result, string(os.PathListSeparator))
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
	res, err := InstallWithOptions(InstallOptions{
		BinPath:    binPath,
		ConfigPath: cfgPath,
		TargetDir:  targetDir,
		Activate:   activate,
	})
	return res.ServicePath, err
}

func InstallWithOptions(opts InstallOptions) (InstallResult, error) {
	binPath := strings.TrimSpace(opts.BinPath)
	if binPath == "" {
		exe, err := os.Executable()
		if err != nil {
			return InstallResult{}, err
		}
		binPath = exe
	} else {
		binPath = config.ExpandPath(binPath)
	}

	cfgPath := strings.TrimSpace(opts.ConfigPath)
	if cfgPath == "" {
		var err error
		cfgPath, err = config.DefaultNodeConfigPath()
		if err != nil {
			return InstallResult{}, err
		}
	} else {
		cfgPath = config.ExpandPath(cfgPath)
	}

	destPath, err := ServiceFilePath(opts.TargetDir)
	if err != nil {
		return InstallResult{}, err
	}
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return InstallResult{}, err
	}

	res := InstallResult{ServicePath: destPath}
	var content string
	if runtime.GOOS == "darwin" {
		logDir := filepath.Join(filepath.Dir(cfgPath), "logs")
		if opts.TargetDir != "" {
			logDir = filepath.Join(config.ExpandPath(opts.TargetDir), "logs")
		}
		_ = os.MkdirAll(logDir, 0o755)

		appInfo, err := EnsureDarwinDaemonApp(binPath, opts.TargetDir, opts.RecreateApp)
		if err != nil {
			return res, err
		}
		res.DaemonApp = appInfo
		content = RenderLaunchdPlistForShim(appInfo.ExecutablePath, binPath, cfgPath, logDir)
	} else {
		content = RenderSystemdUnit(binPath, cfgPath)
	}

	if err := os.WriteFile(destPath, []byte(content), 0o644); err != nil {
		return res, err
	}

	if opts.Activate {
		if runtime.GOOS == "darwin" {
			uid := fmt.Sprintf("gui/%d", os.Getuid())
			_ = exec.Command("launchctl", "bootout", uid, destPath).Run()
			if out, err := exec.Command("launchctl", "bootstrap", uid, destPath).CombinedOutput(); err != nil {
				return res, fmt.Errorf("launchctl bootstrap failed: %w (%s)", err, strings.TrimSpace(string(out)))
			}
		} else if runtime.GOOS == "linux" {
			_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
			if out, err := exec.Command("systemctl", "--user", "enable", "--now", SystemdUnit).CombinedOutput(); err != nil {
				return res, fmt.Errorf("systemctl enable failed: %w (%s)", err, strings.TrimSpace(string(out)))
			}
			if out, err := exec.Command("systemctl", "--user", "restart", SystemdUnit).CombinedOutput(); err != nil {
				return res, fmt.Errorf("systemctl restart failed: %w (%s)", err, strings.TrimSpace(string(out)))
			}
		}
	}

	return res, nil
}

// RefreshAndReloadAfterUpdate triggers a graceful reload of an active node daemon after self-update.
func RefreshAndReloadAfterUpdate() (bool, string) {
	cfgPath, err := config.DefaultNodeConfigPath()
	if err == nil {
		if rec, live := daemon.ReadLiveDaemonPID(cfgPath); live {
			if err := daemon.SendReloadSignal(rec.PID); err == nil {
				return true, "sighup_drain"
			}
		}
	}

	// Never hard-kickstart the parent launchd/systemd unit while running inside an active remote task.
	if strings.TrimSpace(os.Getenv("AHUB_RUN_ID")) != "" {
		return false, "skipped_inside_run"
	}

	switch runtime.GOOS {
	case "darwin":
		svcPath, err := ServiceFilePath("")
		if err != nil {
			return false, "none"
		}
		if _, err := os.Stat(svcPath); err != nil {
			return false, "not_installed"
		}
		target := fmt.Sprintf("gui/%d/%s", os.Getuid(), LaunchdLabel)
		if err := exec.Command("launchctl", "print", target).Run(); err != nil {
			return false, "not_running"
		}
		if err := exec.Command("launchctl", "kickstart", "-k", target).Run(); err == nil {
			return true, "launchctl_kickstart"
		}
		return false, "kickstart_failed"
	case "linux":
		svcPath, err := ServiceFilePath("")
		if err != nil {
			return false, "none"
		}
		if _, err := os.Stat(svcPath); err != nil {
			return false, "not_installed"
		}
		if err := exec.Command("systemctl", "--user", "is-active", "--quiet", SystemdUnit).Run(); err != nil {
			return false, "not_running"
		}
		if err := exec.Command("systemctl", "--user", "restart", SystemdUnit).Run(); err == nil {
			return true, "systemd_restart"
		}
		return false, "systemd_restart_failed"
	case "windows":
		return false, "manual_restart_required"
	default:
		return false, "none"
	}
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
