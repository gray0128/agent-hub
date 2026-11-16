//go:build windows

package daemon

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"time"
)

func NotifyReloadSignal(_ chan<- os.Signal) {}

func StopReloadSignal(_ chan<- os.Signal) {}

func SendReloadSignal(_ int) error {
	return fmt.Errorf("SIGHUP reload signal is unsupported on windows; use reload sentinel")
}

func runTasklistForPID(pid int) (string, error) {
	if pid <= 0 {
		return "", fmt.Errorf("invalid pid %d", pid)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tasklist", "/FI", "PID eq "+strconv.Itoa(pid), "/FO", "CSV", "/NH").Output()
	return string(out), err
}

func IsProcessAlive(pid int) bool {
	out, err := runTasklistForPID(pid)
	if err != nil {
		return false
	}
	_, ok := windowsTasklistImageForPID(out, pid)
	return ok
}

func processLooksLikeAhub(pid int) bool {
	out, err := runTasklistForPID(pid)
	if err != nil {
		return false
	}
	return ParseWindowsTasklistCSV(out, pid)
}
