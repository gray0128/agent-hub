package daemon

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type PIDRecord struct {
	PID        int    `json:"pid"`
	ConfigPath string `json:"config_path,omitempty"`
	StartedAt  string `json:"started_at,omitempty"`
}

func PIDFilePath(cfgPath string) string {
	dir := filepath.Dir(strings.TrimSpace(cfgPath))
	if dir == "" || dir == "." {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".config", "ahub")
	}
	return filepath.Join(dir, "node.pid")
}

func WritePIDFile(cfgPath string) (string, error) {
	path := PIDFilePath(cfgPath)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	rec := PIDRecord{
		PID:        os.Getpid(),
		ConfigPath: cfgPath,
		StartedAt:  time.Now().UTC().Format(time.RFC3339),
	}
	data, err := json.Marshal(rec)
	if err != nil {
		return "", err
	}
	tmp := fmt.Sprintf("%s.tmp.%d", path, os.Getpid())
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return path, nil
}

func RemovePIDFile(cfgPath string, expectedPID int) {
	path := PIDFilePath(cfgPath)
	rec, err := readPIDRecord(path)
	if err != nil || rec.PID != expectedPID {
		return
	}
	_ = os.Remove(path)
}

func ReadLiveDaemonPID(cfgPath string) (PIDRecord, bool) {
	path := PIDFilePath(cfgPath)
	rec, err := readPIDRecord(path)
	if err != nil || rec.PID <= 0 || rec.PID == os.Getpid() {
		return PIDRecord{}, false
	}
	if !IsProcessAlive(rec.PID) {
		return PIDRecord{}, false
	}
	if !looksLikeAhubProcess(rec.PID) {
		return PIDRecord{}, false
	}
	return rec, true
}

func readPIDRecord(path string) (PIDRecord, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return PIDRecord{}, err
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return PIDRecord{}, fmt.Errorf("empty pid file")
	}
	if strings.HasPrefix(trimmed, "{") {
		var rec PIDRecord
		if err := json.Unmarshal([]byte(trimmed), &rec); err != nil {
			return PIDRecord{}, err
		}
		return rec, nil
	}
	pid, err := strconv.Atoi(trimmed)
	if err != nil {
		return PIDRecord{}, err
	}
	return PIDRecord{PID: pid}, nil
}

func looksLikeAhubProcess(pid int) bool {
	return processLooksLikeAhub(pid)
}
