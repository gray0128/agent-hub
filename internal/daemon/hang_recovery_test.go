package daemon

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/gray0128/agent-hub/internal/api"
	"github.com/gray0128/agent-hub/internal/config"
)

func TestDialWebSocketTimeoutOnStalledHandshake(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	stopCh := make(chan struct{})
	defer close(stopCh)

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				<-stopCh
			}(conn)
		}
	}()

	client := api.NewClient("http://"+ln.Addr().String(), "ahub_nod_test")
	client.WSDialTimeout = 120 * time.Millisecond

	start := time.Now()
	wsConn, err := client.DialWebSocket(context.Background(), "/ws/node")
	elapsed := time.Since(start)
	if wsConn != nil {
		_ = wsConn.CloseNow()
		t.Fatalf("expected DialWebSocket to fail on stalled server, got open connection")
	}
	if err == nil {
		t.Fatalf("expected DialWebSocket timeout error, got nil")
	}
	if elapsed >= time.Second {
		t.Fatalf("expected DialWebSocket timeout under 1s, took %s", elapsed)
	}
}

func TestHandshakeTimeoutAndDeadPeerPingReconnect(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()

	var connCount atomic.Int32
	pingObservedCh := make(chan struct{}, 1)
	testDone := make(chan struct{})
	var closeOnce sync.Once
	defer closeOnce.Do(func() { close(testDone) })

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/claim") {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"claimed_runs":[]}`))
			return
		}
		if r.URL.Path != "/ws/node" {
			http.NotFound(w, r)
			return
		}

		attempt := connCount.Add(1)
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}

		// Read initial node.hello frame.
		if _, _, err := c.Read(r.Context()); err != nil {
			_ = c.CloseNow()
			return
		}

		switch attempt {
		case 1:
			// Stall after receiving node.hello without sending hub.welcome.
			<-testDone
			_ = c.CloseNow()
		case 2:
			// Send hub.welcome, then stop reading so Ping frames never receive Pong.
			welcome, _ := json.Marshal(map[string]interface{}{
				"type":                  "hub.welcome",
				"heartbeat_interval_ms": 25000,
				"has_pending_runs":      false,
			})
			if err := c.Write(r.Context(), websocket.MessageText, welcome); err != nil {
				_ = c.CloseNow()
				return
			}
			<-testDone
			_ = c.CloseNow()
		default:
			welcome, _ := json.Marshal(map[string]interface{}{
				"type":                  "hub.welcome",
				"heartbeat_interval_ms": 25000,
				"has_pending_runs":      false,
			})
			if err := c.Write(r.Context(), websocket.MessageText, welcome); err != nil {
				_ = c.CloseNow()
				return
			}
			defer c.CloseNow()
			for {
				_, data, err := c.Read(r.Context())
				if err != nil {
					return
				}
				var frame struct {
					Type string `json:"type"`
				}
				if json.Unmarshal(data, &frame) == nil && frame.Type == "node.ping" {
					select {
					case pingObservedCh <- struct{}{}:
					default:
					}
				}
			}
		}
	}))
	defer srv.Close()

	d := New(&config.NodeConfig{
		NodeID:         "macmini",
		HubURL:         srv.URL,
		MaxConcurrency: 2,
	}, "ahub_nod_test", "0.0.0-test")
	d.handshakeTimeout = 120 * time.Millisecond
	d.pingIntervalOverride = 80 * time.Millisecond
	d.pingTimeout = 120 * time.Millisecond
	d.workspaceScanTimeout = 200 * time.Millisecond
	d.workspaceScanFn = func(roots, skipDirs []string) []api.WorkspaceEntry {
		return []api.WorkspaceEntry{}
	}

	runCtx, cancelRun := context.WithCancel(ctx)
	runErrCh := make(chan error, 1)
	go func() {
		runErrCh <- d.Run(runCtx)
	}()

	select {
	case <-pingObservedCh:
	case <-ctx.Done():
		cancelRun()
		t.Fatalf("timed out waiting for reconnect after handshake timeout and dead-peer ping (attempts=%d)", connCount.Load())
	}

	if got := connCount.Load(); got < 3 {
		cancelRun()
		t.Fatalf("expected at least 3 connection attempts, got %d", got)
	}

	cancelRun()
	closeOnce.Do(func() { close(testDone) })

	select {
	case err := <-runErrCh:
		if err != nil {
			t.Fatalf("expected clean exit on context cancel, got %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("Daemon.Run did not exit after cancel")
	}
}

func TestBlockedWorkspaceScanComesOnlineAndRefreshesWhenUnblocked(t *testing.T) {
	type helloMsg struct {
		ConnNonce  string               `json:"conn_nonce"`
		Workspaces []api.WorkspaceEntry `json:"workspaces"`
	}

	helloCh := make(chan helloMsg, 4)
	var wsConns atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/claim") {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"claimed_runs":[]}`))
			return
		}
		if r.URL.Path != "/ws/node" {
			http.NotFound(w, r)
			return
		}

		wsConns.Add(1)
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()

		sentWelcome := false
		for {
			_, data, err := c.Read(r.Context())
			if err != nil {
				return
			}
			var raw struct {
				Type       string               `json:"type"`
				ConnNonce  string               `json:"conn_nonce"`
				Workspaces []api.WorkspaceEntry `json:"workspaces"`
			}
			if json.Unmarshal(data, &raw) != nil {
				continue
			}
			if raw.Type == "node.hello" {
				helloCh <- helloMsg{
					ConnNonce:  raw.ConnNonce,
					Workspaces: raw.Workspaces,
				}
				if !sentWelcome {
					sentWelcome = true
					welcome, _ := json.Marshal(map[string]interface{}{
						"type":                  "hub.welcome",
						"heartbeat_interval_ms": 25000,
						"has_pending_runs":      false,
					})
					if err := c.Write(r.Context(), websocket.MessageText, welcome); err != nil {
						return
					}
				}
			}
		}
	}))
	defer srv.Close()

	unblockCh := make(chan struct{})
	var unblockOnce sync.Once
	defer unblockOnce.Do(func() { close(unblockCh) })

	var scanCalls atomic.Int32
	d := New(&config.NodeConfig{
		NodeID:         "macmini",
		HubURL:         srv.URL,
		MaxConcurrency: 2,
	}, "ahub_nod_test", "0.0.0-test")
	d.workspaceScanTimeout = 100 * time.Millisecond
	d.handshakeTimeout = time.Second
	d.workspaceScanFn = func(roots, skipDirs []string) []api.WorkspaceEntry {
		scanCalls.Add(1)
		<-unblockCh
		return []api.WorkspaceEntry{
			{Key: "demo", Path: "/workspace/demo", DefaultBranch: "main"},
		}
	}

	runCtx, cancelRun := context.WithCancel(context.Background())
	defer cancelRun()
	runErrCh := make(chan error, 1)
	go func() {
		runErrCh <- d.Run(runCtx)
	}()

	var first helloMsg
	select {
	case first = <-helloCh:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for initial node.hello despite blocked workspace scan")
	}
	if len(first.Workspaces) != 0 {
		t.Fatalf("expected 0 cached workspaces on initial timeout hello, got %+v", first.Workspaces)
	}

	// Repeated bounded scans while blocked must reuse the single in-flight goroutine.
	wsAgain, _, fresh := d.scanWorkspacesBounded(context.Background())
	if fresh || len(wsAgain) != 0 {
		t.Fatalf("expected in-flight fallback without fresh result, got fresh=%v ws=%+v", fresh, wsAgain)
	}
	if got := scanCalls.Load(); got != 1 {
		t.Fatalf("expected single-flight scanCalls == 1, got %d", got)
	}

	unblockOnce.Do(func() { close(unblockCh) })

	var refreshed helloMsg
	select {
	case refreshed = <-helloCh:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for refreshed node.hello after scan unblocked")
	}
	if refreshed.ConnNonce != first.ConnNonce {
		t.Fatalf("expected refresh on same connection nonce %q, got %q", first.ConnNonce, refreshed.ConnNonce)
	}
	if len(refreshed.Workspaces) != 1 || refreshed.Workspaces[0].Key != "demo" {
		t.Fatalf("expected refreshed workspace 'demo', got %+v", refreshed.Workspaces)
	}
	if got := wsConns.Load(); got != 1 {
		t.Fatalf("expected 1 WebSocket connection throughout, got %d", got)
	}

	cancelRun()
	select {
	case err := <-runErrCh:
		if err != nil {
			t.Fatalf("expected nil on context cancel, got %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("Daemon.Run did not exit after cancel")
	}
}
