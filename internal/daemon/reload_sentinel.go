package daemon

import (
	"context"
	"encoding/csv"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// ReloadFilePath returns the sentinel file path used when requesting a daemon reload without OS signals.
func ReloadFilePath(cfgPath string) string {
	pidPath := PIDFilePath(cfgPath)
	return filepath.Join(filepath.Dir(pidPath), "node.reload")
}

// ClearReloadSentinel removes any leftover reload sentinel file before watching starts.
func ClearReloadSentinel(cfgPath string) {
	_ = os.Remove(ReloadFilePath(cfgPath))
}

// WriteReloadSentinel atomically creates the reload sentinel file adjacent to the daemon PID file.
func WriteReloadSentinel(cfgPath string) error {
	path := ReloadFilePath(cfgPath)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "node.reload.*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	payload := []byte(time.Now().UTC().Format(time.RFC3339Nano) + "\n")
	if _, err := tmp.Write(payload); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

// WatchReloadSentinel polls for the reload sentinel and triggers onReload once when present.
func WatchReloadSentinel(ctx context.Context, cfgPath string, pollInterval time.Duration, onReload func()) {
	if pollInterval <= 0 {
		pollInterval = time.Second
	}
	path := ReloadFilePath(cfgPath)
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := os.Stat(path); err == nil {
				_ = os.Remove(path)
				if onReload != nil {
					onReload()
				}
				return
			}
		}
	}
}

// RequestDaemonReload signals a live daemon to drain and restart using OS signals on Unix or a reload sentinel on Windows.
func RequestDaemonReload(cfgPath string) (bool, string) {
	rec, ok := ReadLiveDaemonPID(cfgPath)
	if !ok || rec.PID <= 0 {
		return false, "daemon_not_running"
	}
	if runtime.GOOS == "windows" {
		if err := WriteReloadSentinel(cfgPath); err != nil {
			return false, "sentinel_write_failed"
		}
		return true, "sentinel_drain"
	}
	if err := SendReloadSignal(rec.PID); err != nil {
		return false, "sighup_failed"
	}
	return true, "sighup_drain"
}

func windowsTasklistImageForPID(out string, pid int) (string, bool) {
	if pid <= 0 {
		return "", false
	}
	targetPID := strconv.Itoa(pid)
	r := csv.NewReader(strings.NewReader(strings.ReplaceAll(out, "\r\n", "\n")))
	r.FieldsPerRecord = -1
	rows, err := r.ReadAll()
	if err != nil {
		return "", false
	}
	for _, row := range rows {
		if len(row) < 2 {
			continue
		}
		rowPID := strings.TrimSpace(row[1])
		if rowPID == targetPID {
			return strings.TrimSpace(row[0]), true
		}
	}
	return "", false
}

// ParseWindowsTasklistCSV parses `tasklist /FI "PID eq <pid>" /FO CSV /NH` output and reports whether the PID belongs to ahub.
func ParseWindowsTasklistCSV(out string, pid int) bool {
	imageName, ok := windowsTasklistImageForPID(out, pid)
	if !ok {
		return false
	}
	lower := strings.ToLower(imageName)
	return strings.Contains(lower, "ahub") || strings.Contains(lower, "ahubdaemon")
}
