package daemon

import (
	"sync"
	"time"

	"github.com/gray0128/agent-hub/internal/api"
)

type BatchSendFunc func(runID string, events []api.RunEventItem)

type EventBatcher struct {
	mu       sync.Mutex
	seqByRun map[string]int
	bufByRun map[string][]api.RunEventItem
	send     BatchSendFunc
	interval time.Duration
	maxBatch int
	stopCh   chan struct{}
	doneCh   chan struct{}
}

func NewEventBatcher(interval time.Duration, maxBatch int, send BatchSendFunc) *EventBatcher {
	if interval <= 0 {
		interval = 250 * time.Millisecond
	}
	if maxBatch <= 0 {
		maxBatch = 100
	}
	b := &EventBatcher{
		seqByRun: make(map[string]int),
		bufByRun: make(map[string][]api.RunEventItem),
		send:     send,
		interval: interval,
		maxBatch: maxBatch,
		stopCh:   make(chan struct{}),
		doneCh:   make(chan struct{}),
	}
	go b.loop()
	return b
}

func (b *EventBatcher) loop() {
	defer close(b.doneCh)
	ticker := time.NewTicker(b.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			b.FlushAll()
		case <-b.stopCh:
			b.FlushAll()
			return
		}
	}
}

func (b *EventBatcher) Add(runID, kind string, payload map[string]interface{}) {
	b.mu.Lock()
	b.seqByRun[runID]++
	seq := b.seqByRun[runID]
	item := api.RunEventItem{
		Seq:     seq,
		Kind:    kind,
		Payload: payload,
		TS:      time.Now().UTC().Format(time.RFC3339Nano),
	}
	b.bufByRun[runID] = append(b.bufByRun[runID], item)

	immediate := kind == "status" || kind == "approval_needed" || len(b.bufByRun[runID]) >= b.maxBatch
	var toSend []api.RunEventItem
	if immediate {
		toSend = b.bufByRun[runID]
		delete(b.bufByRun, runID)
	}
	b.mu.Unlock()

	if len(toSend) > 0 && b.send != nil {
		b.send(runID, toSend)
	}
}

func (b *EventBatcher) FlushRun(runID string) {
	b.mu.Lock()
	items := b.bufByRun[runID]
	delete(b.bufByRun, runID)
	delete(b.seqByRun, runID)
	b.mu.Unlock()
	if len(items) > 0 && b.send != nil {
		b.send(runID, items)
	}
}

func (b *EventBatcher) FlushAll() {
	b.mu.Lock()
	if len(b.bufByRun) == 0 {
		b.mu.Unlock()
		return
	}
	pending := b.bufByRun
	b.bufByRun = make(map[string][]api.RunEventItem)
	b.mu.Unlock()

	if b.send == nil {
		return
	}
	for runID, items := range pending {
		if len(items) > 0 {
			b.send(runID, items)
		}
	}
}

func (b *EventBatcher) Close() {
	close(b.stopCh)
	<-b.doneCh
}
