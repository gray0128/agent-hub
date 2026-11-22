package api

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
)

func (c *Client) CreatePlan(ctx context.Context, req CreatePlanRequest) (*CreatePlanResponse, error) {
	var headers map[string]string
	if req.IdempotencyKey != "" {
		headers = map[string]string{"Idempotency-Key": req.IdempotencyKey}
	}
	var res CreatePlanResponse
	if _, err := c.doJSON(ctx, http.MethodPost, "/api/v1/plans", req, &res, headers); err != nil {
		return nil, err
	}
	if res.Runs == nil {
		res.Runs = []RunRecord{}
	}
	return &res, nil
}

func (c *Client) RetryRun(ctx context.Context, runID string, req RetryRunRequest) (*RetryRunResponse, error) {
	var headers map[string]string
	if req.IdempotencyKey != "" {
		headers = map[string]string{"Idempotency-Key": req.IdempotencyKey}
	}
	path := "/api/v1/runs/" + url.PathEscape(runID) + "/retry"
	var res RetryRunResponse
	if _, err := c.doJSON(ctx, http.MethodPost, path, req, &res, headers); err != nil {
		return nil, err
	}
	if res.ReboundRunIDs == nil {
		res.ReboundRunIDs = []string{}
	}
	return &res, nil
}

func (c *Client) ListRunsWithOptions(ctx context.Context, opts ListRunsOptions) ([]RunRecord, error) {
	q := url.Values{}
	if opts.NodeID != "" {
		q.Set("node_id", opts.NodeID)
	}
	if opts.ThreadID != "" {
		q.Set("thread_id", opts.ThreadID)
	}
	if opts.Status != "" {
		q.Set("status", opts.Status)
	}
	if opts.RootRunID != "" {
		q.Set("root_run_id", opts.RootRunID)
	}
	if opts.PlanID != "" {
		q.Set("plan_id", opts.PlanID)
	}
	if opts.BoardTopicID != "" {
		q.Set("board_topic_id", opts.BoardTopicID)
	}
	if opts.Limit > 0 {
		q.Set("limit", strconv.Itoa(opts.Limit))
	}
	path := "/api/v1/runs"
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var res struct {
		OK   bool        `json:"ok"`
		Runs []RunRecord `json:"runs"`
	}
	if _, err := c.doJSON(ctx, http.MethodGet, path, nil, &res, nil); err != nil {
		return nil, err
	}
	if res.Runs == nil {
		res.Runs = []RunRecord{}
	}
	return res.Runs, nil
}
