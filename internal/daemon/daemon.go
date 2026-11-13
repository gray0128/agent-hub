package daemon

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/gray0128/agent-hub/internal/api"
	"github.com/gray0128/agent-hub/internal/config"
	"github.com/gray0128/agent-hub/internal/runner"
)

type Daemon struct {
	cfg     *config.NodeConfig
	client  *api.Client
	version string

	mu           sync.Mutex
	activeDirs   map[string]struct{}
	activeRuns   map[string]context.CancelFunc
	conn         *websocket.Conn
	connNonce    string
	claimMu      sync.Mutex
	batcher      *EventBatcher
	runWaitGroup sync.WaitGroup
}

func New(cfg *config.NodeConfig, token, version string) *Daemon {
	if token == "" {
		token = cfg.Token
	}
	d := &Daemon{
		cfg:        cfg,
		client:     api.NewClient(cfg.HubURL, token),
		version:    version,
		activeDirs: make(map[string]struct{}),
		activeRuns: make(map[string]context.CancelFunc),
	}
	d.batcher = NewEventBatcher(250*time.Millisecond, 100, d.sendEventBatch)
	return d
}

func (d *Daemon) Run(ctx context.Context) error {
	defer d.batcher.Close()
	backoff := time.Second

	for {
		if ctx.Err() != nil {
			d.runWaitGroup.Wait()
			return nil
		}

		err := d.connectAndServe(ctx)
		if ctx.Err() != nil {
			d.runWaitGroup.Wait()
			return nil
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "[ahub node] disconnected: %v\n", err)
		}

		jitterMs := randomInt(500)
		wait := backoff + time.Duration(jitterMs)*time.Millisecond
		select {
		case <-ctx.Done():
			d.runWaitGroup.Wait()
			return nil
		case <-time.After(wait):
		}
		backoff *= 2
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}

func (d *Daemon) connectAndServe(ctx context.Context) error {
	conn, err := d.client.DialWebSocket(ctx, "/ws/node")
	if err != nil {
		return err
	}
	defer conn.Close(websocket.StatusNormalClosure, "closing")

	nonce := newNonce()
	d.mu.Lock()
	d.conn = conn
	d.connNonce = nonce
	d.mu.Unlock()

	defer func() {
		d.mu.Lock()
		if d.conn == conn {
			d.conn = nil
		}
		d.mu.Unlock()
	}()

	workspaces := ScanWorkspaces(d.cfg.ProjectRoots, d.cfg.SkipDirs)
	caps := d.probeCapabilities()
	hello := map[string]interface{}{
		"type":            "node.hello",
		"conn_nonce":      nonce,
		"version":         d.version,
		"os":              runtime.GOOS,
		"arch":            runtime.GOARCH,
		"max_concurrency": d.cfg.MaxConcurrency,
		"capabilities":    caps,
		"workspaces":      workspaces,
	}
	if err := d.writeJSON(ctx, conn, hello); err != nil {
		return err
	}

	// Read hub.welcome
	_, rawWelcome, err := conn.Read(ctx)
	if err != nil {
		return err
	}
	var welcome struct {
		Type              string `json:"type"`
		HeartbeatInterval int    `json:"heartbeat_interval_ms"`
		HasPendingRuns    bool   `json:"has_pending_runs"`
	}
	if err := json.Unmarshal(rawWelcome, &welcome); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "[ahub node] connected as %s (workspaces=%d, pending=%v)\n", d.cfg.NodeID, len(workspaces), welcome.HasPendingRuns)

	// Mandatory claim scan immediately after node.hello handshake
	go d.claimAndSpawn(ctx, nonce)

	pingInterval := 25 * time.Second
	if welcome.HeartbeatInterval >= 5000 {
		pingInterval = time.Duration(welcome.HeartbeatInterval) * time.Millisecond
	}

	pingCtx, cancelPing := context.WithCancel(ctx)
	defer cancelPing()

	go func() {
		ticker := time.NewTicker(pingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-pingCtx.Done():
				return
			case <-ticker.C:
				activeIDs := d.activeRunIDs()
				_ = d.writeJSON(pingCtx, conn, map[string]interface{}{
					"type":           "node.ping",
					"active_run_ids": activeIDs,
					"ts":             time.Now().UTC().Format(time.RFC3339Nano),
				})
			}
		}
	}()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var frame struct {
			Type   string `json:"type"`
			Reason string `json:"reason"`
			RunID  string `json:"run_id"`
		}
		if json.Unmarshal(data, &frame) != nil {
			continue
		}
		switch frame.Type {
		case "hub.wake":
			go d.claimAndSpawn(ctx, nonce)
		case "hub.abort":
			d.abortRun(frame.RunID)
		}
	}
}

func (d *Daemon) claimAndSpawn(ctx context.Context, nonce string) {
	d.claimMu.Lock()
	defer d.claimMu.Unlock()

	busy := d.busyWorkdirs()
	if len(busy) >= d.cfg.MaxConcurrency {
		return
	}

	claimCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	claimed, err := d.client.ClaimRuns(claimCtx, d.cfg.NodeID, api.ClaimRequest{
		ConnNonce:    nonce,
		BusyWorkdirs: busy,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "[ahub node] claim failed: %v\n", err)
		return
	}
	for _, run := range claimed {
		d.trySpawnRun(ctx, run)
	}
}

func (d *Daemon) trySpawnRun(parentCtx context.Context, run api.RunRecord) {
	cleanDir := filepath.Clean(run.Workdir)

	d.mu.Lock()
	if _, exists := d.activeDirs[cleanDir]; exists || len(d.activeRuns) >= d.cfg.MaxConcurrency {
		d.mu.Unlock()
		return
	}
	runCtx, cancel := context.WithCancel(parentCtx)
	d.activeDirs[cleanDir] = struct{}{}
	d.activeRuns[run.ID] = cancel
	d.mu.Unlock()

	d.runWaitGroup.Add(1)
	go func() {
		defer d.runWaitGroup.Done()
		defer func() {
			cancel()
			d.mu.Lock()
			delete(d.activeDirs, cleanDir)
			delete(d.activeRuns, run.ID)
			d.mu.Unlock()
			d.batcher.FlushRun(run.ID)
			// After freeing a directory lock / concurrency slot, immediately probe for queued runs
			d.mu.Lock()
			nonce := d.connNonce
			d.mu.Unlock()
			if nonce != "" && parentCtx.Err() == nil {
				go d.claimAndSpawn(parentCtx, nonce)
			}
		}()

		d.executeClaimedRun(runCtx, parentCtx, run)
	}()
}

func (d *Daemon) executeClaimedRun(runCtx, parentCtx context.Context, run api.RunRecord) {
	leaseOwner := run.LeaseOwner
	if leaseOwner == "" {
		d.mu.Lock()
		leaseOwner = d.cfg.NodeID + ":" + d.connNonce
		d.mu.Unlock()
	}

	d.sendRunState(run.ID, leaseOwner, "running", "", "", "")

	hbInterval := time.Duration(d.cfg.HeartbeatIntervalSec) * time.Second
	if hbInterval < 2*time.Second {
		hbInterval = 30 * time.Second
	}
	hbCtx, cancelHB := context.WithCancel(runCtx)
	defer cancelHB()

	go func() {
		ticker := time.NewTicker(hbInterval)
		defer ticker.Stop()
		for {
			select {
			case <-hbCtx.Done():
				return
			case <-ticker.C:
				reqCtx, cancelReq := context.WithTimeout(parentCtx, 8*time.Second)
				resp, err := d.client.HeartbeatRun(reqCtx, run.ID, leaseOwner)
				cancelReq()
				if err == nil && resp.ShouldAbort {
					d.abortRun(run.ID)
					return
				}
			}
		}
	}()

	agentCfg, ok := d.cfg.Agents[run.Agent]
	if !ok || !agentCfg.Enabled {
		d.finishRun(parentCtx, run.ID, leaseOwner, runner.Result{
			Status:       "failed",
			ErrorCode:    "AGENT_DISABLED",
			ErrorMessage: fmt.Sprintf("Agent %q is not enabled on node %q", run.Agent, d.cfg.NodeID),
		})
		return
	}

	res := runner.ExecuteRun(runCtx, run, d.cfg, agentCfg, runner.Callbacks{
		OnEvent: func(kind string, payload map[string]interface{}) {
			d.batcher.Add(run.ID, kind, payload)
		},
		OnState: func(status, remoteControlURL, resolvedModel, resolvedEffort string) {
			d.sendRunState(run.ID, leaseOwner, status, remoteControlURL, resolvedModel, resolvedEffort)
		},
	})
	d.batcher.FlushRun(run.ID)

	if res.Status == "needs_approval" {
		d.sendRunState(run.ID, leaseOwner, "needs_approval", res.RemoteControlURL, res.ResolvedModel, res.ResolvedEffort)
		return
	}

	d.finishRun(parentCtx, run.ID, leaseOwner, res)
}

func (d *Daemon) finishRun(parentCtx context.Context, runID, leaseOwner string, res runner.Result) {
	finishCtx := parentCtx
	if finishCtx.Err() != nil {
		var cancel context.CancelFunc
		finishCtx, cancel = context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
	} else {
		var cancel context.CancelFunc
		finishCtx, cancel = context.WithTimeout(parentCtx, 15*time.Second)
		defer cancel()
	}

	_, err := d.client.CompleteRun(finishCtx, runID, api.CompleteRunRequest{
		LeaseOwner:      leaseOwner,
		Status:          res.Status,
		NativeSessionID: res.NativeSessionID,
		ResolvedModel:   res.ResolvedModel,
		ResolvedEffort:  res.ResolvedEffort,
		Summary:         res.Summary,
		OutputMD:        res.OutputMD,
		OutputBytes:     res.OutputBytes,
		DurationMs:      res.DurationMs,
		ErrorCode:       res.ErrorCode,
		ErrorMessage:    res.ErrorMessage,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "[ahub node] complete %s error: %v\n", runID, err)
	}
}

func (d *Daemon) abortRun(runID string) {
	d.mu.Lock()
	cancel, ok := d.activeRuns[runID]
	d.mu.Unlock()
	if ok && cancel != nil {
		cancel()
	}
}

func (d *Daemon) sendEventBatch(runID string, events []api.RunEventItem) {
	d.mu.Lock()
	conn := d.conn
	d.mu.Unlock()
	if conn == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = d.writeJSON(ctx, conn, map[string]interface{}{
		"type":   "run.events",
		"run_id": runID,
		"events": events,
	})
}

func (d *Daemon) sendRunState(runID, leaseOwner, status, remoteURL, resolvedModel, resolvedEffort string) {
	d.mu.Lock()
	conn := d.conn
	d.mu.Unlock()
	if conn == nil {
		return
	}
	frame := map[string]interface{}{
		"type":        "run.state",
		"run_id":      runID,
		"lease_owner": leaseOwner,
		"status":      status,
		"ts":          time.Now().UTC().Format(time.RFC3339Nano),
	}
	if remoteURL != "" {
		frame["remote_control_url"] = remoteURL
	}
	if resolvedModel != "" {
		frame["resolved_model"] = resolvedModel
	}
	if resolvedEffort != "" {
		frame["resolved_effort"] = resolvedEffort
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = d.writeJSON(ctx, conn, frame)
}

func (d *Daemon) writeJSON(ctx context.Context, conn *websocket.Conn, payload interface{}) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, encoded)
}

func (d *Daemon) busyWorkdirs() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]string, 0, len(d.activeDirs))
	for dir := range d.activeDirs {
		out = append(out, dir)
	}
	return out
}

func (d *Daemon) activeRunIDs() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]string, 0, len(d.activeRuns))
	for id := range d.activeRuns {
		out = append(out, id)
	}
	return out
}

func (d *Daemon) probeCapabilities() map[string]interface{} {
	agents := make(map[string]interface{})
	for name, cfg := range d.cfg.Agents {
		cmd := cfg.Command
		if cmd == "" {
			cmd = name
		}
		expanded := config.ExpandPath(cmd)
		_, lookupErr := exec.LookPath(expanded)
		agents[name] = map[string]interface{}{
			"enabled":       cfg.Enabled,
			"available":     lookupErr == nil,
			"default_model": cfg.DefaultModel,
		}
	}
	return map[string]interface{}{
		"agents": agents,
		"aliases": map[string]string{
			"carbon":   "gemini-4-carbon-high",
			"argon":    "gemini-4-argon-high",
			"hydrogen": "gemini-4-hydrogen-high",
			"flash":    "gemini-3.8-flash-high",
			"opus":     "claude-opus-5-5-high",
			"sonnet":   "claude-sonnet-5-5-high",
		},
	}
}

func newNonce() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func randomInt(max int64) int64 {
	if max <= 0 {
		return 0
	}
	n, err := rand.Int(rand.Reader, big.NewInt(max))
	if err != nil {
		return 0
	}
	return n.Int64()
}
