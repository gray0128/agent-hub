//go:build windows

package daemon

import (
	"fmt"
	"os"
)

func NotifyReloadSignal(_ chan<- os.Signal) {}

func StopReloadSignal(_ chan<- os.Signal) {}

func SendReloadSignal(_ int) error {
	return fmt.Errorf("SIGHUP reload signal is unsupported on windows")
}

func IsProcessAlive(_ int) bool {
	return false
}
