//go:build !windows

package daemon

import (
	"os"
	"os/signal"
	"syscall"
)

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
