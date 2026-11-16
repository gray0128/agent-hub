package daemon

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestReloadSentinelLifecycle(t *testing.T) {
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "node.json")

	wantPath := filepath.Join(tmpDir, "node.reload")
	if got := ReloadFilePath(cfgPath); got != wantPath {
		t.Fatalf("expected ReloadFilePath=%q, got %q", wantPath, got)
	}

	if err := WriteReloadSentinel(cfgPath); err != nil {
		t.Fatalf("WriteReloadSentinel failed: %v", err)
	}
	if _, err := os.Stat(wantPath); err != nil {
		t.Fatalf("expected sentinel file %q to exist: %v", wantPath, err)
	}

	ClearReloadSentinel(cfgPath)
	if _, err := os.Stat(wantPath); !os.IsNotExist(err) {
		t.Fatalf("expected ClearReloadSentinel to remove %q", wantPath)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	triggered := make(chan struct{}, 1)
	go WatchReloadSentinel(ctx, cfgPath, 15*time.Millisecond, func() {
		select {
		case triggered <- struct{}{}:
		default:
		}
	})

	if err := WriteReloadSentinel(cfgPath); err != nil {
		t.Fatalf("WriteReloadSentinel failed: %v", err)
	}

	select {
	case <-triggered:
	case <-time.After(1 * time.Second):
		t.Fatal("timed out waiting for WatchReloadSentinel callback")
	}

	if _, err := os.Stat(wantPath); !os.IsNotExist(err) {
		t.Fatalf("expected WatchReloadSentinel to delete sentinel after trigger")
	}
}

func TestParseWindowsTasklistCSV(t *testing.T) {
	cases := []struct {
		name string
		out  string
		pid  int
		want bool
	}{
		{
			name: "ahub.exe matching pid",
			out:  "\"ahub.exe\",\"4321\",\"Console\",\"1\",\"18,400 K\"\r\n",
			pid:  4321,
			want: true,
		},
		{
			name: "ahub-shim.exe case-insensitive match",
			out:  "\"Ahub-Shim.EXE\",\"990\",\"Console\",\"1\",\"12,000 K\"\n",
			pid:  990,
			want: true,
		},
		{
			name: "unrelated process with same pid",
			out:  "\"notepad.exe\",\"4321\",\"Console\",\"1\",\"9,000 K\"\r\n",
			pid:  4321,
			want: false,
		},
		{
			name: "mismatched pid",
			out:  "\"ahub.exe\",\"4322\",\"Console\",\"1\",\"18,400 K\"\r\n",
			pid:  4321,
			want: false,
		},
		{
			name: "info no tasks running",
			out:  "INFO: No tasks are running which match the specified criteria.\r\n",
			pid:  4321,
			want: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ParseWindowsTasklistCSV(tc.out, tc.pid); got != tc.want {
				t.Fatalf("ParseWindowsTasklistCSV(%q, %d) = %v, want %v", tc.out, tc.pid, got, tc.want)
			}
		})
	}
}
