package daemon

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/gray0128/agent-hub/internal/config"
)

func TestPIDFileLifecycleAndReloadDrain(t *testing.T) {
	tmp := t.TempDir()
	cfgPath := filepath.Join(tmp, "node.json")

	pidPath, err := WritePIDFile(cfgPath)
	if err != nil {
		t.Fatalf("WritePIDFile: %v", err)
	}
	if pidPath != filepath.Join(tmp, "node.pid") {
		t.Fatalf("unexpected pid path %q", pidPath)
	}

	rec, err := readPIDRecord(pidPath)
	if err != nil || rec.PID <= 0 {
		t.Fatalf("readPIDRecord failed: rec=%+v err=%v", rec, err)
	}

	// ReadLiveDaemonPID ignores our own PID so self does not SIGHUP self.
	if _, live := ReadLiveDaemonPID(cfgPath); live {
		t.Fatalf("expected ReadLiveDaemonPID to ignore own pid")
	}

	// RemovePIDFile only removes when expectedPID matches.
	RemovePIDFile(cfgPath, rec.PID+999)
	if _, err := readPIDRecord(pidPath); err != nil {
		t.Fatalf("RemovePIDFile should preserve file when expectedPID mismatches")
	}
	RemovePIDFile(cfgPath, rec.PID)
	if _, err := readPIDRecord(pidPath); err == nil {
		t.Fatalf("RemovePIDFile should remove file when expectedPID matches")
	}

	// Reload drains waiting WaitGroup and returns ErrReloadRequested.
	d := New(&config.NodeConfig{
		NodeID:         "macmini",
		HubURL:         "http://127.0.0.1:1", // refuses quickly without blocking
		MaxConcurrency: 2,
	}, "ahub_nod_test", "0.0.0-test")

	d.runWaitGroup.Add(1)
	doneCh := make(chan error, 1)
	go func() {
		doneCh <- d.Run(context.Background())
	}()

	d.RequestReload()
	select {
	case err := <-doneCh:
		t.Fatalf("Run exited before in-flight work finished: %v", err)
	case <-time.After(80 * time.Millisecond):
	}

	d.runWaitGroup.Done()
	select {
	case err := <-doneCh:
		if !errors.Is(err, ErrReloadRequested) {
			t.Fatalf("expected ErrReloadRequested, got %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("Run did not return ErrReloadRequested after active run drained")
	}
}
