package daemon

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/gray0128/agent-hub/internal/api"
	"github.com/gray0128/agent-hub/internal/config"
	"github.com/gray0128/agent-hub/internal/redact"
	"github.com/gray0128/agent-hub/internal/runner"
)

const (
	ExitReload                  = 42
	defaultHandshakeTimeout     = 15 * time.Second
	defaultPingTimeout          = 10 * time.Second
	defaultWorkspaceScanTimeout = 5 * time.Second
)

var ErrReloadRequested = errors.New("daemon reload requested")

type Daemon struct {
	cfg     *config.NodeConfig
	client  *api.Client
	version string

	handshakeTimeout     time.Duration
	pingIntervalOverride time.Duration
	pingTimeout          time.Duration
	workspaceScanTimeout time.Duration
	workspaceScanFn      func(roots, skipDirs []string) []api.WorkspaceEntry
	catalogProbeTimeout  time.Duration
	catalogCacheTTL      time.Duration

	mu                  sync.Mutex
	activeDirs          map[string]struct{}
	activeRuns          map[string]context.CancelFunc
	conn                *websocket.Conn
	connNonce           string
	cachedWorkspaces    []api.WorkspaceEntry
	cachedWorkspacesSeq uint64
	scanInFlight        bool
	cachedAgentCaps     map[string]api.AgentCapability
	cachedCapsAt        time.Time
	capRefreshInFlight  bool
	draining            bool
	reloadCh            chan struct{}
	claimMu             sync.Mutex
	batcher             *EventBatcher
	runWaitGroup        sync.WaitGroup
}

func New(cfg *config.NodeConfig, token, version string) *Daemon {
	if token == "" {
		token = cfg.Token
	}
	d := &Daemon{
		cfg:                  cfg,
		client:               api.NewClient(cfg.HubURL, token),
		version:              version,
		handshakeTimeout:     defaultHandshakeTimeout,
		pingTimeout:          defaultPingTimeout,
		workspaceScanTimeout: defaultWorkspaceScanTimeout,
		workspaceScanFn:      ScanWorkspaces,
		catalogProbeTimeout:  defaultCatalogProbeTimeout,
		catalogCacheTTL:      defaultCatalogCacheTTL,
		activeDirs:           make(map[string]struct{}),
		activeRuns:           make(map[string]context.CancelFunc),
		cachedAgentCaps:      make(map[string]api.AgentCapability),
		reloadCh:             make(chan struct{}),
	}
	d.batcher = NewEventBatcher(250*time.Millisecond, 100, d.sendEventBatch)
	return d
}

func (d *Daemon) RequestReload() {
	d.mu.Lock()
	if !d.draining {
		d.draining = true
		close(d.reloadCh)
		fmt.Fprintf(os.Stderr, "[ahub node] reload requested (SIGHUP): draining %d active run(s) before exit(%d)\n", len(d.activeRuns), ExitReload)
	}
	d.mu.Unlock()
}

func (d *Daemon) isDraining() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.draining
}

func (d *Daemon) Run(ctx context.Context) error {
	defer d.batcher.Close()
	backoff := time.Second
	serveCtx, cancelServe := context.WithCancel(ctx)
	defer cancelServe()

	go func() {
		select {
		case <-d.reloadCh:
			d.runWaitGroup.Wait()
			cancelServe()
		case <-serveCtx.Done():
		}
	}()

	for {
		if ctx.Err() != nil {
			d.runWaitGroup.Wait()
			return nil
		}
		if d.isDraining() {
			d.runWaitGroup.Wait()
			return ErrReloadRequested
		}

		err := d.connectAndServe(serveCtx)
		if ctx.Err() != nil {
			d.runWaitGroup.Wait()
			return nil
		}
		if d.isDraining() {
			d.runWaitGroup.Wait()
			return ErrReloadRequested
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
		case <-d.reloadCh:
			d.runWaitGroup.Wait()
			return ErrReloadRequested
		case <-time.After(wait):
		}
		backoff *= 2
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}

func cloneWorkspaces(in []api.WorkspaceEntry) []api.WorkspaceEntry {
	if len(in) == 0 {
		return []api.WorkspaceEntry{}
	}
	out := make([]api.WorkspaceEntry, len(in))
	copy(out, in)
	return out
}

func (d *Daemon) buildHelloFrame(nonce string, caps map[string]interface{}, workspaces []api.WorkspaceEntry) map[string]interface{} {
	if workspaces == nil {
		workspaces = []api.WorkspaceEntry{}
	}
	return map[string]interface{}{
		"type":            "node.hello",
		"conn_nonce":      nonce,
		"version":         d.version,
		"os":              runtime.GOOS,
		"arch":            runtime.GOARCH,
		"max_concurrency": d.cfg.MaxConcurrency,
		"capabilities":    caps,
		"workspaces":      workspaces,
	}
}

func (d *Daemon) sendHelloRefresh(conn *websocket.Conn, nonce string, workspaces []api.WorkspaceEntry) {
	if conn == nil || nonce == "" {
		return
	}
	hello := d.buildHelloFrame(nonce, d.probeCapabilities(), workspaces)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := d.writeJSON(ctx, conn, hello); err != nil {
		fmt.Fprintf(os.Stderr, "[ahub node] failed to send refreshed node.hello: %v\n", err)
	}
}

func (d *Daemon) scanWorkspacesBounded(ctx context.Context) ([]api.WorkspaceEntry, uint64, bool) {
	scanTimeout := d.workspaceScanTimeout
	if scanTimeout <= 0 {
		scanTimeout = defaultWorkspaceScanTimeout
	}

	d.mu.Lock()
	if d.scanInFlight {
		cached := cloneWorkspaces(d.cachedWorkspaces)
		seq := d.cachedWorkspacesSeq
		d.mu.Unlock()
		return cached, seq, false
	}
	d.scanInFlight = true
	roots := append([]string(nil), d.cfg.ProjectRoots...)
	skipDirs := append([]string(nil), d.cfg.SkipDirs...)
	scanFn := d.workspaceScanFn
	if scanFn == nil {
		scanFn = ScanWorkspaces
	}
	d.mu.Unlock()

	scanState := &struct {
		timedOut bool
	}{}
	doneCh := make(chan []api.WorkspaceEntry, 1)

	go func() {
		ws := scanFn(roots, skipDirs)
		if ws == nil {
			ws = []api.WorkspaceEntry{}
		}
		d.mu.Lock()
		d.cachedWorkspaces = cloneWorkspaces(ws)
		d.cachedWorkspacesSeq++
		d.scanInFlight = false
		late := scanState.timedOut && !d.draining && d.conn != nil && d.connNonce != ""
		conn := d.conn
		nonce := d.connNonce
		d.mu.Unlock()

		doneCh <- cloneWorkspaces(ws)
		if late {
			fmt.Fprintf(os.Stderr, "[ahub node] delayed workspace scan finished (workspaces=%d); refreshing node.hello\n", len(ws))
			d.sendHelloRefresh(conn, nonce, ws)
		}
	}()

	timer := time.NewTimer(scanTimeout)
	defer timer.Stop()

	select {
	case ws := <-doneCh:
		d.mu.Lock()
		seq := d.cachedWorkspacesSeq
		d.mu.Unlock()
		return ws, seq, true
	case <-ctx.Done():
		d.mu.Lock()
		scanState.timedOut = true
		cached := cloneWorkspaces(d.cachedWorkspaces)
		seq := d.cachedWorkspacesSeq
		d.mu.Unlock()
		return cached, seq, false
	case <-timer.C:
		d.mu.Lock()
		scanState.timedOut = true
		fallback := cloneWorkspaces(d.cachedWorkspaces)
		seq := d.cachedWorkspacesSeq
		d.mu.Unlock()
		fmt.Fprintf(
			os.Stderr,
			"[ahub node] warning: workspace scan timed out after %s (check disk or macOS TCC permissions for project_roots); proceeding with %d cached workspace(s)\n",
			scanTimeout,
			len(fallback),
		)
		return fallback, seq, false
	}
}

func (d *Daemon) connectAndServe(ctx context.Context) error {
	workspaces, scanSeq, freshScan := d.scanWorkspacesBounded(ctx)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	caps := d.probeCapabilities()

	conn, err := d.client.DialWebSocket(ctx, "/ws/node")
	if err != nil {
		return err
	}
	defer conn.Close(websocket.StatusNormalClosure, "closing")

	nonce := newNonce()
	handshakeTimeout := d.handshakeTimeout
	if handshakeTimeout <= 0 {
		handshakeTimeout = defaultHandshakeTimeout
	}
	hello := d.buildHelloFrame(nonce, caps, workspaces)
	hsCtx, cancelHS := context.WithTimeout(ctx, handshakeTimeout)
	if err := d.writeJSON(hsCtx, conn, hello); err != nil {
		cancelHS()
		_ = conn.CloseNow()
		return fmt.Errorf("send node.hello: %w", err)
	}

	_, rawWelcome, err := conn.Read(hsCtx)
	cancelHS()
	if err != nil {
		_ = conn.CloseNow()
		return fmt.Errorf("read hub.welcome: %w", err)
	}
	var welcome struct {
		Type              string `json:"type"`
		HeartbeatInterval int    `json:"heartbeat_interval_ms"`
		HasPendingRuns    bool   `json:"has_pending_runs"`
	}
	if err := json.Unmarshal(rawWelcome, &welcome); err != nil {
		_ = conn.CloseNow()
		return err
	}
	if welcome.Type != "hub.welcome" {
		_ = conn.CloseNow()
		return fmt.Errorf("unexpected handshake frame type %q", welcome.Type)
	}

	var lateWs []api.WorkspaceEntry
	d.mu.Lock()
	d.conn = conn
	d.connNonce = nonce
	if !freshScan && d.cachedWorkspacesSeq != scanSeq {
		lateWs = cloneWorkspaces(d.cachedWorkspaces)
	}
	d.mu.Unlock()

	defer func() {
		d.mu.Lock()
		if d.conn == conn {
			d.conn = nil
			d.connNonce = ""
		}
		d.mu.Unlock()
	}()

	if lateWs != nil {
		d.sendHelloRefresh(conn, nonce, lateWs)
		workspaces = lateWs
	}

	fmt.Fprintf(os.Stderr, "[ahub node] connected as %s (workspaces=%d, pending=%v)\n", d.cfg.NodeID, len(workspaces), welcome.HasPendingRuns)

	// Mandatory claim scan immediately after node.hello handshake
	go d.claimAndSpawn(ctx, nonce)

	pingInterval := 25 * time.Second
	if welcome.HeartbeatInterval >= 5000 {
		pingInterval = time.Duration(welcome.HeartbeatInterval) * time.Millisecond
	}
	if d.pingIntervalOverride > 0 {
		pingInterval = d.pingIntervalOverride
	}
	pingTimeout := d.pingTimeout
	if pingTimeout <= 0 {
		pingTimeout = defaultPingTimeout
	}

	sessionCtx, cancelSession := context.WithCancel(ctx)
	defer cancelSession()
	go d.refreshModelCatalogsAsync(sessionCtx)
	pingErrCh := make(chan error, 1)

	go func() {
		ticker := time.NewTicker(pingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-sessionCtx.Done():
				return
			case <-ticker.C:
				hbCtx, cancelHB := context.WithTimeout(sessionCtx, pingTimeout)
				err := conn.Ping(hbCtx)
				if err == nil {
					activeIDs := d.activeRunIDs()
					err = d.writeJSON(hbCtx, conn, map[string]interface{}{
						"type":           "node.ping",
						"active_run_ids": activeIDs,
						"ts":             time.Now().UTC().Format(time.RFC3339Nano),
					})
				}
				cancelHB()
				if err != nil {
					select {
					case pingErrCh <- fmt.Errorf("heartbeat failed: %w", err):
					default:
					}
					_ = conn.CloseNow()
					cancelSession()
					return
				}
			}
		}
	}()

	for {
		_, data, err := conn.Read(sessionCtx)
		if err != nil {
			select {
			case pingErr := <-pingErrCh:
				return pingErr
			default:
				return err
			}
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
	if d.isDraining() {
		return
	}
	d.claimMu.Lock()
	defer d.claimMu.Unlock()
	if d.isDraining() {
		return
	}

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
	if d.draining {
		d.mu.Unlock()
		return
	}
	if _, exists := d.activeDirs[cleanDir]; exists || len(d.activeRuns) >= d.cfg.MaxConcurrency {
		d.mu.Unlock()
		return
	}
	runCtx, cancel := context.WithCancel(parentCtx)
	d.activeDirs[cleanDir] = struct{}{}
	d.activeRuns[run.ID] = cancel
	d.runWaitGroup.Add(1)
	d.mu.Unlock()

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
	runStartedAt := time.Now()
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
				if err == nil && (resp.ShouldAbort || resp.Status == "done" || resp.Status == "cancelled" || resp.Status == "failed") {
					d.abortRun(run.ID)
					return
				}
				var apiErr *api.APIError
				if errors.As(err, &apiErr) && (apiErr.HTTPStatus == 404 || apiErr.HTTPStatus == 409) {
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
			d.batcher.Add(run.ID, kind, redact.Map(payload))
		},
		OnState: func(status, remoteControlURL, resolvedModel, resolvedEffort string) {
			d.sendRunState(run.ID, leaseOwner, status, remoteControlURL, resolvedModel, resolvedEffort)
		},
	})
	d.batcher.FlushRun(run.ID)

	if res.Status == "needs_approval" {
		if !d.checkpointNeedsApproval(runCtx, run.ID, leaseOwner, res) {
			return
		}
		totalBudget := time.Duration(run.TimeoutSec) * time.Second
		if totalBudget <= 0 {
			totalBudget = 3600 * time.Second
		}
		remaining := totalBudget - time.Since(runStartedAt)
		if remaining <= 0 {
			d.finishRun(parentCtx, run.ID, leaseOwner, buildApprovalTimeoutResult(res, time.Since(runStartedAt), run.TimeoutSec))
			return
		}
		timer := time.NewTimer(remaining)
		defer timer.Stop()
		select {
		case <-runCtx.Done():
			// Hub already transitioned the run (resolve/cancel) or daemon is shutting down; keep checkpointed/settled state intact.
			return
		case <-timer.C:
			d.finishRun(parentCtx, run.ID, leaseOwner, buildApprovalTimeoutResult(res, time.Since(runStartedAt), run.TimeoutSec))
			return
		}
	}

	d.finishRun(parentCtx, run.ID, leaseOwner, res)
}

func (d *Daemon) checkpointNeedsApproval(runCtx context.Context, runID, leaseOwner string, res runner.Result) bool {
	for attempt := 0; attempt < 5; attempt++ {
		if runCtx.Err() != nil {
			return false
		}
		reqCtx, cancel := context.WithTimeout(runCtx, 8*time.Second)
		_, err := d.client.CheckpointApproval(reqCtx, runID, api.ApprovalCheckpointRequest{
			LeaseOwner:       leaseOwner,
			RemoteControlURL: redact.Text(res.RemoteControlURL),
			NativeSessionID:  res.NativeSessionID,
			ResolvedModel:    res.ResolvedModel,
			ResolvedEffort:   res.ResolvedEffort,
			Summary:          redact.Text(res.Summary),
			OutputMD:         redact.Text(res.OutputMD),
			OutputBytes:      res.OutputBytes,
			DurationMs:       res.DurationMs,
		})
		cancel()
		if err == nil {
			return true
		}
		var apiErr *api.APIError
		if errors.As(err, &apiErr) && (apiErr.HTTPStatus == 400 || apiErr.HTTPStatus == 404 || apiErr.HTTPStatus == 409) {
			fmt.Fprintf(os.Stderr, "[ahub node] checkpoint approval %s stopped (%d): %v\n", runID, apiErr.HTTPStatus, err)
			return false
		}
		fmt.Fprintf(os.Stderr, "[ahub node] checkpoint approval %s retry %d/5: %v\n", runID, attempt+1, err)
		backoff := time.Duration(attempt+1) * 500 * time.Millisecond
		select {
		case <-runCtx.Done():
			return false
		case <-time.After(backoff):
		}
	}
	return false
}

func buildApprovalTimeoutResult(res runner.Result, totalElapsed time.Duration, timeoutSec int) runner.Result {
	durMs := totalElapsed.Milliseconds()
	if durMs < res.DurationMs {
		durMs = res.DurationMs
	}
	if timeoutSec <= 0 {
		timeoutSec = 3600
	}
	return runner.Result{
		Status:           "failed",
		NativeSessionID:  res.NativeSessionID,
		ResolvedModel:    res.ResolvedModel,
		ResolvedEffort:   res.ResolvedEffort,
		RemoteControlURL: res.RemoteControlURL,
		Summary:          res.Summary,
		OutputMD:         res.OutputMD,
		OutputBytes:      res.OutputBytes,
		DurationMs:       durMs,
		ErrorCode:        "APPROVAL_TIMEOUT",
		ErrorMessage:     fmt.Sprintf("Human approval exceeded timeout (%ds)", timeoutSec),
	}
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

	req := api.CompleteRunRequest{
		LeaseOwner:      leaseOwner,
		Status:          res.Status,
		NativeSessionID: res.NativeSessionID,
		ResolvedModel:   res.ResolvedModel,
		ResolvedEffort:  res.ResolvedEffort,
		Summary:         redact.Text(res.Summary),
		OutputMD:        redact.Text(res.OutputMD),
		OutputBytes:     res.OutputBytes,
		DurationMs:      res.DurationMs,
		ErrorCode:       res.ErrorCode,
		ErrorMessage:    redact.Text(res.ErrorMessage),
	}
	if res.Status == "done" {
		req.Result = res.StructuredResult
		req.ResultError = redact.Text(res.ResultError)
	}

	_, err := d.client.CompleteRun(finishCtx, runID, req)
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
		frame["remote_control_url"] = redact.Text(remoteURL)
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
