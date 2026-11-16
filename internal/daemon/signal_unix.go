//go:build !windows

package daemon

import (
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
)

func processLooksLikeAhub(pid int) bool {
	out, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "command=").Output()
	if err != nil {
		// If ps fails cleanly without output, process may have exited or ps unavailable; be conservative only if ps succeeded.
		return false
	}
	cmd := strings.ToLower(strings.TrimSpace(string(out)))
	if cmd == "" {
		return false
	}
	return strings.Contains(cmd, "ahub") || strings.Contains(cmd, "ahubdaemon")
}

func NotifyReloadSignal(ch chan<- os.Signal) {
	signal.Notify(ch, syscall.SIGHUP)
}

func StopReloadSignal(ch chan<- os.Signal) {
	signal.Stop(ch)
}

func SendReloadSignal(pid int) error {
	return syscall.Kill(pid, syscall.SIGHUP)
}

func IsProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	return syscall.Kill(pid, 0) == nil
}
