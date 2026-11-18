package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
)

const DefaultWSDialTimeout = 20 * time.Second

type Client struct {
	BaseURL       string
	Token         string
	HTTPClient    *http.Client
	WSDialTimeout time.Duration
}

func NewClient(baseURL, token string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   token,
		HTTPClient: &http.Client{
			Timeout: 60 * time.Second,
		},
		WSDialTimeout: DefaultWSDialTimeout,
	}
}

func (c *Client) doJSON(ctx context.Context, method, path string, reqBody interface{}, respOut interface{}, extraHeaders map[string]string) (int, error) {
	var bodyReader io.Reader
	if reqBody != nil {
		encoded, err := json.Marshal(reqBody)
		if err != nil {
			return 0, err
		}
		bodyReader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, bodyReader)
	if err != nil {
		return 0, err
	}
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	for k, v := range extraHeaders {
		req.Header.Set(k, v)
	}
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return resp.StatusCode, err
	}
	if resp.StatusCode >= 400 {
		var env ErrorEnvelope
		if json.Unmarshal(raw, &env) == nil && env.Error.Code != "" {
			return resp.StatusCode, &APIError{HTTPStatus: resp.StatusCode, Body: env.Error}
		}
		return resp.StatusCode, &APIError{
			HTTPStatus: resp.StatusCode,
			Body: ErrorBody{
				Code:    fmt.Sprintf("HTTP_%d", resp.StatusCode),
				Message: strings.TrimSpace(string(raw)),
			},
		}
	}
	if respOut != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, respOut); err != nil {
			return resp.StatusCode, err
		}
	}
	return resp.StatusCode, nil
}

func (c *Client) ListNodes(ctx context.Context, onlineOnly bool) ([]NodeRecord, error) {
	var res struct {
		OK    bool         `json:"ok"`
		Nodes []NodeRecord `json:"nodes"`
	}
	if _, err := c.doJSON(ctx, http.MethodGet, "/api/v1/nodes", nil, &res, nil); err != nil {
		return nil, err
	}
	if !onlineOnly {
		return res.Nodes, nil
	}
	filtered := make([]NodeRecord, 0, len(res.Nodes))
	for _, n := range res.Nodes {
		if n.Status == "online" {
			filtered = append(filtered, n)
		}
	}
	return filtered, nil
}

func (c *Client) CreateRun(ctx context.Context, req CreateRunRequest, waitMs int) (*RunRecord, int, error) {
	path := "/api/v1/runs"
	if waitMs > 0 {
		if waitMs > 45000 {
			waitMs = 45000
		}
		path += "?wait_ms=" + strconv.Itoa(waitMs)
	}
	headers := map[string]string{}
	if req.IdempotencyKey != "" {
		headers["Idempotency-Key"] = req.IdempotencyKey
	}
	var res struct {
		OK  bool      `json:"ok"`
		Run RunRecord `json:"run"`
	}
	status, err := c.doJSON(ctx, http.MethodPost, path, req, &res, headers)
	if err != nil {
		return nil, status, err
	}
	return &res.Run, status, nil
}

func (c *Client) GetRun(ctx context.Context, runID string, full bool, tailBytes int) (*RunRecord, error) {
	q := url.Values{}
	if full {
		q.Set("view", "full")
	} else {
		q.Set("view", "summary")
		if tailBytes > 0 {
			q.Set("tail_bytes", strconv.Itoa(tailBytes))
		}
	}
	var res struct {
		OK  bool      `json:"ok"`
		Run RunRecord `json:"run"`
	}
	_, err := c.doJSON(ctx, http.MethodGet, "/api/v1/runs/"+url.PathEscape(runID)+"?"+q.Encode(), nil, &res, nil)
	if err != nil {
		return nil, err
	}
	return &res.Run, nil
}

func (c *Client) EmitNativeEvent(ctx context.Context, nodeID string, req NativeEventRequest) (*NativeEventResponse, error) {
	var res NativeEventResponse
	path := "/api/v1/nodes/" + url.PathEscape(nodeID) + "/native-events"
	if _, err := c.doJSON(ctx, http.MethodPost, path, req, &res, nil); err != nil {
		return nil, err
	}
	return &res, nil
}

func (c *Client) ListNativeEvents(ctx context.Context, opts ListNativeEventsOptions) (*ListNativeEventsResponse, error) {
	q := url.Values{}
	if opts.NodeID != "" {
		q.Set("node_id", opts.NodeID)
	}
	if opts.Agent != "" {
		q.Set("agent", opts.Agent)
	}
	if opts.EventKind != "" {
		q.Set("event_kind", opts.EventKind)
	}
	if opts.NotifyStatus != "" {
		q.Set("notify_status", opts.NotifyStatus)
	}
	if opts.UnackedOnly {
		q.Set("unacked_only", "true")
	}
	if opts.Query != "" {
		q.Set("q", opts.Query)
	}
	if opts.Limit > 0 {
		q.Set("limit", strconv.Itoa(opts.Limit))
	}
	if opts.BeforeTS != "" {
		q.Set("before_ts", opts.BeforeTS)
	}
	if opts.BeforeID != "" {
		q.Set("before_id", opts.BeforeID)
	}
	path := "/api/v1/native-events"
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var res ListNativeEventsResponse
	if _, err := c.doJSON(ctx, http.MethodGet, path, nil, &res, nil); err != nil {
		return nil, err
	}
	if res.Events == nil {
		res.Events = []NativeEventRecord{}
	}
	return &res, nil
}

func (c *Client) ListRuns(ctx context.Context, nodeID, status string, limit int) ([]RunRecord, error) {
	q := url.Values{}
	if nodeID != "" {
		q.Set("node_id", nodeID)
	}
	if status != "" {
		q.Set("status", status)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	var res struct {
		OK   bool        `json:"ok"`
		Runs []RunRecord `json:"runs"`
	}
	_, err := c.doJSON(ctx, http.MethodGet, "/api/v1/runs?"+q.Encode(), nil, &res, nil)
	if err != nil {
		return nil, err
	}
	return res.Runs, nil
}

func (c *Client) ListThreads(ctx context.Context, nodeID, keyword string, limit int) ([]ThreadRecord, error) {
	q := url.Values{}
	if nodeID != "" {
		q.Set("node_id", nodeID)
	}
	if keyword != "" {
		q.Set("q", keyword)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	var res struct {
		OK      bool           `json:"ok"`
		Threads []ThreadRecord `json:"threads"`
	}
	_, err := c.doJSON(ctx, http.MethodGet, "/api/v1/threads?"+q.Encode(), nil, &res, nil)
	if err != nil {
		return nil, err
	}
	return res.Threads, nil
}

func (c *Client) CancelRun(ctx context.Context, runID string, cascade bool, reason string) ([]RunRecord, error) {
	var res struct {
		OK            bool        `json:"ok"`
		CancelledRuns []RunRecord `json:"cancelled_runs"`
	}
	body := map[string]interface{}{
		"cascade": cascade,
		"reason":  reason,
	}
	_, err := c.doJSON(ctx, http.MethodPost, "/api/v1/runs/"+url.PathEscape(runID)+"/cancel", body, &res, nil)
	if err != nil {
		return nil, err
	}
	return res.CancelledRuns, nil
}

func (c *Client) ClaimRuns(ctx context.Context, nodeID string, req ClaimRequest) ([]RunRecord, error) {
	var res struct {
		OK          bool        `json:"ok"`
		ClaimedRuns []RunRecord `json:"claimed_runs"`
	}
	_, err := c.doJSON(ctx, http.MethodPost, "/api/v1/nodes/"+url.PathEscape(nodeID)+"/claim", req, &res, nil)
	if err != nil {
		return nil, err
	}
	return res.ClaimedRuns, nil
}

func (c *Client) HeartbeatRun(ctx context.Context, runID, leaseOwner string) (*HeartbeatResponse, error) {
	var res HeartbeatResponse
	_, err := c.doJSON(ctx, http.MethodPost, "/api/v1/runs/"+url.PathEscape(runID)+"/heartbeat", map[string]string{
		"lease_owner": leaseOwner,
	}, &res, nil)
	if err != nil {
		return nil, err
	}
	return &res, nil
}

func (c *Client) CompleteRun(ctx context.Context, runID string, req CompleteRunRequest) (*RunRecord, error) {
	var res struct {
		OK  bool      `json:"ok"`
		Run RunRecord `json:"run"`
	}
	_, err := c.doJSON(ctx, http.MethodPost, "/api/v1/runs/"+url.PathEscape(runID)+"/complete", req, &res, nil)
	if err != nil {
		return nil, err
	}
	return &res.Run, nil
}

func (c *Client) CheckpointApproval(ctx context.Context, runID string, req ApprovalCheckpointRequest) (*RunRecord, error) {
	var res struct {
		OK  bool      `json:"ok"`
		Run RunRecord `json:"run"`
	}
	_, err := c.doJSON(ctx, http.MethodPost, "/api/v1/runs/"+url.PathEscape(runID)+"/approval", req, &res, nil)
	if err != nil {
		return nil, err
	}
	return &res.Run, nil
}

func (c *Client) ResolveRun(ctx context.Context, runID, summary string) (*RunRecord, error) {
	var res struct {
		OK  bool      `json:"ok"`
		Run RunRecord `json:"run"`
	}
	req := ResolveRunRequest{Summary: summary}
	_, err := c.doJSON(ctx, http.MethodPost, "/api/v1/runs/"+url.PathEscape(runID)+"/resolve", req, &res, nil)
	if err != nil {
		return nil, err
	}
	return &res.Run, nil
}

func (c *Client) GetVersionManifest(ctx context.Context) (*VersionManifest, error) {
	var res VersionManifest
	_, err := c.doJSON(ctx, http.MethodGet, "/dl/version.json", nil, &res, nil)
	if err != nil {
		return nil, err
	}
	return &res, nil
}

func (c *Client) AuthMe(ctx context.Context) (map[string]interface{}, error) {
	var res map[string]interface{}
	_, err := c.doJSON(ctx, http.MethodGet, "/api/v1/auth/me", nil, &res, nil)
	if err != nil {
		return nil, err
	}
	return res, nil
}

func (c *Client) wsURL(path string) (string, error) {
	u, err := url.Parse(c.BaseURL)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	}
	p := path
	q := ""
	if idx := strings.IndexByte(path, '?'); idx >= 0 {
		p = path[:idx]
		q = path[idx+1:]
	}
	u.Path = strings.TrimRight(u.Path, "/") + p
	u.RawQuery = q
	return u.String(), nil
}

func (c *Client) DialWebSocket(ctx context.Context, path string) (*websocket.Conn, error) {
	wsEndpoint, err := c.wsURL(path)
	if err != nil {
		return nil, err
	}
	headers := http.Header{}
	if c.Token != "" {
		headers.Set("Authorization", "Bearer "+c.Token)
	}
	dialTimeout := c.WSDialTimeout
	if dialTimeout <= 0 {
		dialTimeout = DefaultWSDialTimeout
	}
	dialClient := &http.Client{
		Timeout: dialTimeout,
	}
	if c.HTTPClient != nil && c.HTTPClient.Transport != nil {
		dialClient.Transport = c.HTTPClient.Transport
	}
	conn, _, err := websocket.Dial(ctx, wsEndpoint, &websocket.DialOptions{
		HTTPClient: dialClient,
		HTTPHeader: headers,
	})
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(4 << 20)
	return conn, nil
}
