package api

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
)

func normalizeBoardTopic(t *BoardTopic) {
	if t == nil {
		return
	}
	if t.Labels == nil {
		t.Labels = map[string]string{}
	}
	if t.LatestHandoff != nil && t.LatestHandoff.Data == nil {
		t.LatestHandoff.Data = map[string]interface{}{}
	}
}

func normalizeBoardMessage(m *BoardMessage) {
	if m == nil {
		return
	}
	if m.Data == nil {
		m.Data = map[string]interface{}{}
	}
	if m.QuestionOptions == nil {
		m.QuestionOptions = []string{}
	}
}

func (c *Client) ListBoardChannels(ctx context.Context) (*BoardChannelsResponse, error) {
	var res BoardChannelsResponse
	if _, err := c.doJSON(ctx, http.MethodGet, "/api/v1/board/channels", nil, &res, nil); err != nil {
		return nil, err
	}
	if res.Channels == nil {
		res.Channels = []BoardChannelSummary{}
	}
	return &res, nil
}

func (c *Client) ListBoardTopics(ctx context.Context, opts ListBoardTopicsOptions) (*BoardTopicsResponse, error) {
	q := url.Values{}
	if opts.Channel != "" {
		q.Set("channel", opts.Channel)
	}
	if opts.ExternalRef != "" {
		q.Set("external_ref", opts.ExternalRef)
	}
	if opts.Status != "" {
		q.Set("status", opts.Status)
	}
	if opts.HasOpenQuestion != nil {
		q.Set("has_open_question", strconv.FormatBool(*opts.HasOpenQuestion))
	}
	if opts.Query != "" {
		q.Set("q", opts.Query)
	}
	if opts.Sort != "" {
		q.Set("sort", opts.Sort)
	}
	if opts.Limit > 0 {
		q.Set("limit", strconv.Itoa(opts.Limit))
	}
	path := "/api/v1/board/topics"
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var res BoardTopicsResponse
	if _, err := c.doJSON(ctx, http.MethodGet, path, nil, &res, nil); err != nil {
		return nil, err
	}
	if res.Topics == nil {
		res.Topics = []BoardTopic{}
	}
	for i := range res.Topics {
		normalizeBoardTopic(&res.Topics[i])
	}
	return &res, nil
}

func (c *Client) CreateBoardTopic(ctx context.Context, req CreateBoardTopicRequest) (*BoardTopicResponse, error) {
	var res BoardTopicResponse
	if _, err := c.doJSON(ctx, http.MethodPost, "/api/v1/board/topics", req, &res, nil); err != nil {
		return nil, err
	}
	normalizeBoardTopic(&res.Topic)
	return &res, nil
}

func (c *Client) GetBoardTopicMessages(ctx context.Context, topicID string, afterSeq int64, limit int) (*BoardMessagesResponse, error) {
	q := url.Values{}
	if afterSeq > 0 {
		q.Set("after_seq", strconv.FormatInt(afterSeq, 10))
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	path := "/api/v1/board/topics/" + url.PathEscape(topicID) + "/messages"
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var res BoardMessagesResponse
	if _, err := c.doJSON(ctx, http.MethodGet, path, nil, &res, nil); err != nil {
		return nil, err
	}
	normalizeBoardTopic(&res.Topic)
	if res.Messages == nil {
		res.Messages = []BoardMessage{}
	}
	for i := range res.Messages {
		normalizeBoardMessage(&res.Messages[i])
	}
	return &res, nil
}

func (c *Client) CreateBoardMessage(ctx context.Context, topicID string, req CreateBoardMessageRequest) (*BoardMessagePostResponse, error) {
	var headers map[string]string
	if req.IdempotencyKey != "" {
		headers = map[string]string{"Idempotency-Key": req.IdempotencyKey}
	}
	path := "/api/v1/board/topics/" + url.PathEscape(topicID) + "/messages"
	var res BoardMessagePostResponse
	if _, err := c.doJSON(ctx, http.MethodPost, path, req, &res, headers); err != nil {
		return nil, err
	}
	normalizeBoardTopic(&res.Topic)
	normalizeBoardMessage(&res.Message)
	return &res, nil
}

func (c *Client) ListBoardEvents(ctx context.Context, opts ListBoardEventsOptions) (*BoardEventsResponse, error) {
	q := url.Values{}
	if opts.Channel != "" {
		q.Set("channel", opts.Channel)
	}
	if opts.TopicID != "" {
		q.Set("topic_id", opts.TopicID)
	}
	if opts.AfterCursor > 0 {
		q.Set("after_cursor", strconv.FormatInt(opts.AfterCursor, 10))
	}
	if opts.Limit > 0 {
		q.Set("limit", strconv.Itoa(opts.Limit))
	}
	path := "/api/v1/board/events"
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var res BoardEventsResponse
	if _, err := c.doJSON(ctx, http.MethodGet, path, nil, &res, nil); err != nil {
		return nil, err
	}
	if res.Events == nil {
		res.Events = []BoardEvent{}
	}
	return &res, nil
}
