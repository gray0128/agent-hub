//go:build !windows

package service

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gray0128/agent-hub/internal/config"
	"github.com/gray0128/agent-hub/internal/daemon"
)

// RunShim supervises `<binPath> node serve --config <cfgPath>` so the signed AhubDaemon.app stays the stable TCC parent across binary updates.
func RunShim(binPath, cfgPath string) int {
	binPath = config.ExpandPath(binPath)
	if strings.TrimSpace(binPath) == "" {
		fmt.Fprintln(os.Stderr, "[ahub shim] --bin is required")
		return 2
	}
	if strings.TrimSpace(cfgPath) != "" {
		cfgPath = config.ExpandPath(cfgPath)
	}

	sigCh := make(chan os.Signal, 4)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(sigCh)

	backoff := time.Second
	for {
		args := []string{"node", "serve"}
		if cfgPath != "" {
			args = append(args, "--config", cfgPath)
		}

		cmd := exec.Command(binPath, args...)
		cmd.Stdin = os.Stdin
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr

		startedAt := time.Now()
		if err := cmd.Start(); err != nil {
			fmt.Fprintf(os.Stderr, "[ahub shim] start %s failed: %v\n", binPath, err)
			select {
			case sig := <-sigCh:
				if sig == syscall.SIGINT || sig == syscall.SIGTERM {
					return 0
				}
			case <-time.After(backoff):
			}
			backoff = nextBackoff(backoff)
			continue
		}

		waitCh := make(chan error, 1)
		go func() {
			waitCh <- cmd.Wait()
		}()

		var waitErr error
		stopping := false
		for {
			select {
			case waitErr = <-waitCh:
				goto childExited
			case sig := <-sigCh:
				if sig == syscall.SIGHUP {
					if cmd.Process != nil {
						_ = cmd.Process.Signal(syscall.SIGHUP)
					}
					continue
				}
				stopping = true
				if cmd.Process != nil {
					_ = cmd.Process.Signal(syscall.SIGTERM)
				}
				select {
				case waitErr = <-waitCh:
					goto childExited
				case <-time.After(10 * time.Second):
					if cmd.Process != nil {
						_ = cmd.Process.Kill()
					}
					waitErr = <-waitCh
					goto childExited
				}
			}
		}

	childExited:
		if stopping {
			return 0
		}

		exitCode := 0
		if waitErr != nil {
			var exitErr *exec.ExitError
			if errors.As(waitErr, &exitErr) {
				exitCode = exitErr.ExitCode()
			} else {
				exitCode = 1
			}
		}

		if exitCode == daemon.ExitReload {
			fmt.Fprintf(os.Stderr, "[ahub shim] child requested reload (exit=%d); restarting updated %s\n", exitCode, binPath)
			backoff = time.Second
			select {
			case sig := <-sigCh:
				if sig == syscall.SIGINT || sig == syscall.SIGTERM {
					return 0
				}
			case <-time.After(200 * time.Millisecond):
			}
			continue
		}

		if time.Since(startedAt) >= 30*time.Second {
			backoff = time.Second
		}
		fmt.Fprintf(os.Stderr, "[ahub shim] child exited (code=%d err=%v); restarting in %s\n", exitCode, waitErr, backoff)
		select {
		case sig := <-sigCh:
			if sig == syscall.SIGINT || sig == syscall.SIGTERM {
				return 0
			}
		case <-time.After(backoff):
		}
		backoff = nextBackoff(backoff)
	}
}

func nextBackoff(cur time.Duration) time.Duration {
	cur *= 2
	if cur > 15*time.Second {
		return 15 * time.Second
	}
	return cur
}
