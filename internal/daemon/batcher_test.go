package daemon

import (
	"sync"
	"testing"
	"time"

	"github.com/gray0128/agent-hub/internal/api"
)

func TestEventBatcherCoalescesRapidStatusBursts(t *testing.T) {
	var (
		mu      sync.Mutex
		batches [][]api.RunEventItem
	)
	batcher := NewEventBatcher(80*time.Millisecond, 100, func(runID string, events []api.RunEventItem) {
		mu.Lock()
		defer mu.Unlock()
		cp := make([]api.RunEventItem, len(events))
		copy(cp, events)
		batches = append(batches, cp)
	})
	defer batcher.Close()

	batcher.Add("run_1", "status", map[string]interface{}{"stage": "session"})

	mu.Lock()
	initialBatches := len(batches)
	var firstSeq int
	if initialBatches == 1 && len(batches[0]) == 1 {
		firstSeq = batches[0][0].Seq
	}
	mu.Unlock()
	if initialBatches != 1 || firstSeq != 1 {
		t.Fatalf("expected leading-edge immediate status flush (1 batch, seq=1), got batches=%d firstSeq=%d", initialBatches, firstSeq)
	}

	for i := 0; i < 25; i++ {
		batcher.Add("run_1", "status", map[string]interface{}{"i": i})
	}

	mu.Lock()
	midBatches := len(batches)
	mu.Unlock()
	if midBatches != 1 {
		t.Fatalf("expected rapid burst status events within interval to buffer, got %d batches", midBatches)
	}

	deadline := time.Now().Add(500 * time.Millisecond)
	for {
		mu.Lock()
		total := 0
		for _, b := range batches {
			total += len(b)
		}
		batchCount := len(batches)
		mu.Unlock()
		if total == 26 {
			if batchCount != 2 {
				t.Fatalf("expected 25 burst events to coalesce into 1 tick batch (2 total batches), got %d", batchCount)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for coalesced status flush: total=%d batches=%d", total, batchCount)
		}
		time.Sleep(15 * time.Millisecond)
	}

	mu.Lock()
	defer mu.Unlock()
	seq := 1
	for _, b := range batches {
		for _, item := range b {
			if item.Seq != seq {
				t.Fatalf("expected contiguous seq=%d, got %d", seq, item.Seq)
			}
			seq++
		}
	}
}

func TestEventBatcherApprovalNeededAlwaysFlushesImmediately(t *testing.T) {
	var (
		mu      sync.Mutex
		batches [][]api.RunEventItem
	)
	batcher := NewEventBatcher(5*time.Second, 100, func(runID string, events []api.RunEventItem) {
		mu.Lock()
		defer mu.Unlock()
		cp := make([]api.RunEventItem, len(events))
		copy(cp, events)
		batches = append(batches, cp)
	})
	defer batcher.Close()

	batcher.Add("run_1", "status", map[string]interface{}{"stage": "session"})
	batcher.Add("run_1", "approval_needed", map[string]interface{}{"remote_control_available": true})

	mu.Lock()
	defer mu.Unlock()
	if len(batches) != 2 {
		t.Fatalf("expected approval_needed to flush immediately after status, got %d batches", len(batches))
	}
	if batches[1][0].Kind != "approval_needed" || batches[1][0].Seq != 2 {
		t.Fatalf("unexpected second batch item: %+v", batches[1][0])
	}
}
