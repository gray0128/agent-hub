package api

import "encoding/json"

type WorkspaceEntry struct {
	Key           string `json:"key"`
	Path          string `json:"path"`
	DefaultBranch string `json:"default_branch,omitempty"`
}

type ModelCapability struct {
	ID            string   `json:"id"`
	Label         string   `json:"label"`
	Efforts       []string `json:"efforts"`
	DefaultEffort string   `json:"default_effort,omitempty"`
}

type AgentCapability struct {
	Enabled       bool              `json:"enabled"`
	Available     bool              `json:"available"`
	DefaultModel  string            `json:"default_model"`
	DefaultEffort string            `json:"default_effort,omitempty"`
	CatalogStatus string            `json:"catalog_status,omitempty"`
	Models        []ModelCapability `json:"models,omitempty"`
}

type NodeRecord struct {
	ID                       string                 `json:"id"`
	DisplayName              string                 `json:"display_name"`
	OS                       string                 `json:"os"`
	Arch                     string                 `json:"arch"`
	Version                  string                 `json:"version"`
	Capabilities             map[string]interface{} `json:"capabilities"`
	Workspaces               []WorkspaceEntry       `json:"workspaces"`
	Status                   string                 `json:"status"`
	MaxConcurrency           int                    `json:"max_concurrency"`
	ActiveRunsCount          int                    `json:"active_runs_count"`
	DefaultNotifyKeyID       *string                `json:"default_notify_key_id,omitempty"`
	DefaultNotifyKeyName     string                 `json:"default_notify_key_name,omitempty"`
	DefaultNotifyWebhookHost string                 `json:"default_notify_webhook_host,omitempty"`
	DefaultNotifyValid       *bool                  `json:"default_notify_valid,omitempty"`
	LastSeenAt               *string                `json:"last_seen_at"`
	CreatedAt                string                 `json:"created_at"`
	UpdatedAt                string                 `json:"updated_at"`
}

type DeliveriesSummary struct {
	Total  int `json:"total"`
	Sent   int `json:"sent"`
	Queued int `json:"queued"`
	Failed int `json:"failed"`
}

type NotificationDeliveryRecord struct {
	ID           string  `json:"id"`
	SourceKind   string  `json:"source_kind"`
	SourceID     string  `json:"source_id"`
	TriggerEvent string  `json:"trigger_event"`
	NodeID       string  `json:"node_id"`
	ChannelKind  string  `json:"channel_kind"`
	ChannelID    string  `json:"channel_id"`
	ChannelLabel string  `json:"channel_label"`
	TargetHost   string  `json:"target_host"`
	RouteMode    string  `json:"route_mode"`
	Status       string  `json:"status"`
	Attempts     int     `json:"attempts"`
	HTTPStatus   *int    `json:"http_status"`
	ErrorCode    string  `json:"error_code"`
	ErrorMessage string  `json:"error_message"`
	SentAt       *string `json:"sent_at"`
	CreatedAt    string  `json:"created_at"`
	UpdatedAt    string  `json:"updated_at"`
}

type NativeEventRequest struct {
	EventID         string `json:"event_id"`
	Agent           string `json:"agent"`
	EventKind       string `json:"event_kind"`
	NativeSessionID string `json:"native_session_id,omitempty"`
	Workdir         string `json:"workdir,omitempty"`
	Title           string `json:"title,omitempty"`
	Summary         string `json:"summary"`
	Source          string `json:"source,omitempty"`
}

type NativeEventRecord struct {
	ID                string             `json:"id"`
	NodeID            string             `json:"node_id"`
	EventID           string             `json:"event_id"`
	Agent             string             `json:"agent"`
	EventKind         string             `json:"event_kind"`
	NativeSessionID   string             `json:"native_session_id"`
	Workdir           string             `json:"workdir"`
	Title             string             `json:"title"`
	Summary           string             `json:"summary"`
	Source            string             `json:"source"`
	NotifyKeyID       *string            `json:"notify_key_id"`
	NotifyStatus      string             `json:"notify_status"`
	NotifyError       string             `json:"notify_error"`
	AckAt             *string            `json:"ack_at"`
	AttentionState    *string            `json:"attention_state"`
	DeliveriesSummary *DeliveriesSummary `json:"deliveries_summary,omitempty"`
	CreatedAt         string             `json:"created_at"`
	UpdatedAt         string             `json:"updated_at"`
}

type NativeEventResponse struct {
	OK           bool              `json:"ok"`
	Event        NativeEventRecord `json:"event"`
	Deduplicated bool              `json:"deduplicated"`
}

type NativeEventsCursor struct {
	BeforeTS string `json:"before_ts"`
	BeforeID string `json:"before_id"`
}

type ListNativeEventsOptions struct {
	NodeID       string
	Agent        string
	EventKind    string
	NotifyStatus string
	UnackedOnly  bool
	Query        string
	Limit        int
	BeforeTS     string
	BeforeID     string
}

type ListNativeEventsResponse struct {
	OK                   bool                `json:"ok"`
	Events               []NativeEventRecord `json:"events"`
	OpenInteractionCount int                 `json:"open_interaction_count"`
	NextCursor           *NativeEventsCursor `json:"next_cursor"`
}

type ThreadRecord struct {
	ID              string  `json:"id"`
	Title           string  `json:"title"`
	NodeID          string  `json:"node_id"`
	Workdir         string  `json:"workdir"`
	ProjectKey      string  `json:"project_key"`
	Agent           string  `json:"agent"`
	NativeSessionID *string `json:"native_session_id"`
	Status          string  `json:"status"`
	Pinned          bool    `json:"pinned"`
	SortOrder       float64 `json:"sort_order"`
	LastRunID       *string `json:"last_run_id"`
	CreatedAt       string  `json:"created_at"`
	UpdatedAt       string  `json:"updated_at"`
}

type RunRecord struct {
	ID                string             `json:"id"`
	ThreadID          string             `json:"thread_id"`
	RootRunID         string             `json:"root_run_id"`
	ParentRunID       *string            `json:"parent_run_id,omitempty"`
	Depth             int                `json:"depth"`
	MaxDepth          int                `json:"max_depth"`
	NodeID            string             `json:"node_id"`
	Workdir           string             `json:"workdir"`
	Agent             string             `json:"agent"`
	Model             string             `json:"model,omitempty"`
	Effort            string             `json:"effort,omitempty"`
	Sandbox           bool               `json:"sandbox"`
	TimeoutSec        int                `json:"timeout_sec"`
	Prompt            string             `json:"prompt,omitempty"`
	Status            string             `json:"status"`
	PlanID            *string            `json:"plan_id,omitempty"`
	PlanKey           *string            `json:"plan_key,omitempty"`
	ScheduledAt       *string            `json:"scheduled_at,omitempty"`
	RetryOfRunID      *string            `json:"retry_of_run_id,omitempty"`
	ActorProfile      string             `json:"actor_profile,omitempty"`
	BoardTopicID      *string            `json:"board_topic_id,omitempty"`
	DependsOnRunIDs   []string           `json:"depends_on_run_ids,omitempty"`
	BlockedReason     *string            `json:"blocked_reason,omitempty"`
	Labels            map[string]string  `json:"labels,omitempty"`
	ResultSchema      json.RawMessage    `json:"result_schema,omitempty"`
	Result            json.RawMessage    `json:"result,omitempty"`
	PriorityOrder     float64            `json:"priority_order,omitempty"`
	LeaseOwner        string             `json:"lease_owner,omitempty"`
	ResolvedModel     string             `json:"resolved_model,omitempty"`
	ResolvedEffort    string             `json:"resolved_effort,omitempty"`
	NativeSessionID   *string            `json:"native_session_id,omitempty"`
	RemoteControlURL  string             `json:"remote_control_url,omitempty"`
	Summary           string             `json:"summary,omitempty"`
	OutputPreview     string             `json:"output_preview,omitempty"`
	OutputMD          string             `json:"output_md,omitempty"`
	OutputBytes       int                `json:"output_bytes,omitempty"`
	Truncated         *bool              `json:"truncated,omitempty"`
	WebhookArmed      *bool              `json:"webhook_armed,omitempty"`
	ErrorCode         string             `json:"error_code,omitempty"`
	ErrorMessage      string             `json:"error_message,omitempty"`
	NotifyStatus      string             `json:"notify_status,omitempty"`
	DeliveriesSummary *DeliveriesSummary `json:"deliveries_summary,omitempty"`
	LeaseExpiresAt    *string            `json:"lease_expires_at,omitempty"`
	StartedAt         *string            `json:"started_at,omitempty"`
	FinishedAt        *string            `json:"finished_at,omitempty"`
	DurationMs        int64              `json:"duration_ms,omitempty"`
	CreatedAt         string             `json:"created_at"`
	UpdatedAt         string             `json:"updated_at"`
}

type NotifyConfig struct {
	Target string   `json:"target"`
	Events []string `json:"events,omitempty"`
}

type CreateRunRequest struct {
	ThreadID       string            `json:"thread_id,omitempty"`
	NodeID         string            `json:"node_id,omitempty"`
	Workdir        string            `json:"workdir,omitempty"`
	Agent          string            `json:"agent,omitempty"`
	Model          string            `json:"model,omitempty"`
	Effort         string            `json:"effort,omitempty"`
	Sandbox        *bool             `json:"sandbox,omitempty"`
	TimeoutSec     int               `json:"timeout_sec,omitempty"`
	Prompt         string            `json:"prompt"`
	Title          string            `json:"title,omitempty"`
	ParentRunID    string            `json:"parent_run_id,omitempty"`
	IdempotencyKey string            `json:"idempotency_key,omitempty"`
	DependsOn      []string          `json:"depends_on,omitempty"`
	ScheduledAt    string            `json:"scheduled_at,omitempty"`
	BoardTopicID   string            `json:"board_topic_id,omitempty"`
	ActorProfile   string            `json:"actor_profile,omitempty"`
	Labels         map[string]string `json:"labels,omitempty"`
	ResultSchema   json.RawMessage   `json:"result_schema,omitempty"`
	Notify         *NotifyConfig     `json:"notify,omitempty"`
}

type CancelRunRequest struct {
	Cascade bool   `json:"cascade"`
	Reason  string `json:"reason,omitempty"`
}

type ListRunsOptions struct {
	NodeID       string
	ThreadID     string
	Status       string
	RootRunID    string
	PlanID       string
	BoardTopicID string
	Labels       []string
	Limit        int
}

type PlanNodeSpec struct {
	Key           string            `json:"key"`
	NodeID        string            `json:"node_id"`
	Workdir       string            `json:"workdir"`
	Agent         string            `json:"agent"`
	Model         string            `json:"model,omitempty"`
	Effort        string            `json:"effort,omitempty"`
	Sandbox       *bool             `json:"sandbox,omitempty"`
	TimeoutSec    int               `json:"timeout_sec,omitempty"`
	Prompt        string            `json:"prompt"`
	Title         string            `json:"title,omitempty"`
	DependsOn     []string          `json:"depends_on,omitempty"`
	ScheduledAt   string            `json:"scheduled_at,omitempty"`
	InSec         *int              `json:"in_sec,omitempty"`
	PriorityOrder *float64          `json:"priority_order,omitempty"`
	Labels        map[string]string `json:"labels,omitempty"`
	ResultSchema  json.RawMessage   `json:"result_schema,omitempty"`
	Notify        *NotifyConfig     `json:"notify,omitempty"`
}

type CreatePlanRequest struct {
	IdempotencyKey string         `json:"idempotency_key,omitempty"`
	BoardTopicID   string         `json:"board_topic_id,omitempty"`
	ActorProfile   string         `json:"actor_profile,omitempty"`
	ParentRunID    string         `json:"parent_run_id,omitempty"`
	Nodes          []PlanNodeSpec `json:"nodes"`
}

type CreatePlanResponse struct {
	OK           bool        `json:"ok"`
	PlanID       string      `json:"plan_id"`
	Deduplicated *bool       `json:"deduplicated,omitempty"`
	Runs         []RunRecord `json:"runs"`
}

type RetryRunRequest struct {
	IdempotencyKey string `json:"idempotency_key,omitempty"`
	Model          string `json:"model,omitempty"`
	Effort         string `json:"effort,omitempty"`
	TimeoutSec     int    `json:"timeout_sec,omitempty"`
	ActorProfile   string `json:"actor_profile,omitempty"`
}

type RetryRunResponse struct {
	OK            bool      `json:"ok"`
	Run           RunRecord `json:"run"`
	ReboundRunIDs []string  `json:"rebound_run_ids"`
	Deduplicated  *bool     `json:"deduplicated,omitempty"`
}

type ClaimRequest struct {
	ConnNonce    string   `json:"conn_nonce"`
	BusyWorkdirs []string `json:"busy_workdirs,omitempty"`
}

type HeartbeatResponse struct {
	OK             bool    `json:"ok"`
	Status         string  `json:"status"`
	ShouldAbort    bool    `json:"should_abort"`
	LeaseExpiresAt *string `json:"lease_expires_at"`
}

type CompleteRunRequest struct {
	LeaseOwner      string          `json:"lease_owner"`
	Status          string          `json:"status"`
	NativeSessionID string          `json:"native_session_id,omitempty"`
	ResolvedModel   string          `json:"resolved_model,omitempty"`
	ResolvedEffort  string          `json:"resolved_effort,omitempty"`
	Summary         string          `json:"summary"`
	OutputMD        string          `json:"output_md"`
	OutputBytes     int             `json:"output_bytes"`
	DurationMs      int64           `json:"duration_ms"`
	ErrorCode       string          `json:"error_code,omitempty"`
	ErrorMessage    string          `json:"error_message,omitempty"`
	Result          json.RawMessage `json:"result,omitempty"`
	ResultError     string          `json:"result_error,omitempty"`
}

type ApprovalCheckpointRequest struct {
	LeaseOwner       string `json:"lease_owner"`
	RemoteControlURL string `json:"remote_control_url,omitempty"`
	NativeSessionID  string `json:"native_session_id,omitempty"`
	ResolvedModel    string `json:"resolved_model,omitempty"`
	ResolvedEffort   string `json:"resolved_effort,omitempty"`
	Summary          string `json:"summary,omitempty"`
	OutputMD         string `json:"output_md,omitempty"`
	OutputBytes      int    `json:"output_bytes,omitempty"`
	DurationMs       int64  `json:"duration_ms,omitempty"`
}

type ResolveRunRequest struct {
	Summary string `json:"summary,omitempty"`
}

type VersionAsset struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}

type VersionManifest struct {
	Version    string                  `json:"version"`
	ReleasedAt string                  `json:"released_at"`
	Assets     map[string]VersionAsset `json:"assets"`
}

type ErrorBody struct {
	Code    string                 `json:"code"`
	Message string                 `json:"message"`
	Details map[string]interface{} `json:"details,omitempty"`
	Next    []string               `json:"next,omitempty"`
}

type ErrorDetail = ErrorBody

type APIError struct {
	HTTPStatus int
	Body       ErrorBody
}

func (e *APIError) Error() string {
	if e.Body.Code != "" {
		return e.Body.Code + ": " + e.Body.Message
	}
	return e.Body.Message
}

type ErrorEnvelope struct {
	OK    bool      `json:"ok"`
	Error ErrorBody `json:"error"`
}

type RunEventItem struct {
	Seq     int                    `json:"seq"`
	Kind    string                 `json:"kind"`
	Payload map[string]interface{} `json:"payload"`
	TS      string                 `json:"ts"`
}

type BoardHandoffSnapshot struct {
	ID           string                 `json:"id"`
	ActorProfile string                 `json:"actor_profile"`
	SourceNode   string                 `json:"source_node"`
	TextMD       string                 `json:"text_md"`
	Data         map[string]interface{} `json:"data"`
	CreatedAt    string                 `json:"created_at"`
}

type BoardChannelSummary struct {
	Channel           string  `json:"channel"`
	ActiveTopicCount  int     `json:"active_topic_count"`
	OpenQuestionCount int     `json:"open_question_count"`
	TotalTopicCount   *int    `json:"total_topic_count,omitempty"`
	UpdatedAt         *string `json:"updated_at,omitempty"`
}

type BoardTopic struct {
	ID                   string                `json:"id"`
	Channel              string                `json:"channel"`
	Title                string                `json:"title"`
	ExternalRef          string                `json:"external_ref"`
	Status               string                `json:"status"`
	PreviousStatus       string                `json:"previous_status"`
	Pinned               bool                  `json:"pinned"`
	SortOrder            float64               `json:"sort_order"`
	Labels               map[string]string     `json:"labels"`
	CreatedByKeyID       *string               `json:"created_by_key_id"`
	LastMessageID        string                `json:"last_message_id"`
	LastHandoffMessageID string                `json:"last_handoff_message_id"`
	LastEventCursor      int64                 `json:"last_event_cursor"`
	OpenQuestionCount    *int                  `json:"open_question_count,omitempty"`
	MessageCount         *int                  `json:"message_count,omitempty"`
	LatestHandoff        *BoardHandoffSnapshot `json:"latest_handoff,omitempty"`
	CreatedAt            string                `json:"created_at"`
	UpdatedAt            string                `json:"updated_at"`
}

type BoardMessage struct {
	ID                string                 `json:"id"`
	TopicID           string                 `json:"topic_id"`
	Channel           string                 `json:"channel"`
	Seq               int                    `json:"seq"`
	Kind              string                 `json:"kind"`
	ReplyToID         *string                `json:"reply_to_id"`
	ActorScope        string                 `json:"actor_scope"`
	ActorKeyID        *string                `json:"actor_key_id"`
	ActorProfile      string                 `json:"actor_profile"`
	SourceNode        string                 `json:"source_node"`
	TextMD            string                 `json:"text_md"`
	Data              map[string]interface{} `json:"data"`
	QuestionState     string                 `json:"question_state"`
	QuestionOptions   []string               `json:"question_options"`
	QuestionExpiresAt *string                `json:"question_expires_at"`
	AnsweredMessageID *string                `json:"answered_message_id"`
	AnsweredAt        *string                `json:"answered_at"`
	DeliveriesSummary *DeliveriesSummary     `json:"deliveries_summary,omitempty"`
	CreatedAt         string                 `json:"created_at"`
}

type BoardEvent struct {
	Cursor       int64   `json:"cursor"`
	Channel      string  `json:"channel"`
	TopicID      string  `json:"topic_id"`
	MessageID    *string `json:"message_id"`
	EventType    string  `json:"event_type"`
	ActorProfile string  `json:"actor_profile"`
	CreatedAt    string  `json:"created_at"`
}

type CreateBoardTopicRequest struct {
	Channel     string            `json:"channel"`
	Title       string            `json:"title"`
	ExternalRef string            `json:"external_ref,omitempty"`
	Status      string            `json:"status,omitempty"`
	Pinned      *bool             `json:"pinned,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
	Upsert      bool              `json:"upsert,omitempty"`
}

type PatchBoardTopicRequest struct {
	Title     string            `json:"title,omitempty"`
	Status    string            `json:"status,omitempty"`
	Pinned    *bool             `json:"pinned,omitempty"`
	SortOrder *float64          `json:"sort_order,omitempty"`
	Labels    map[string]string `json:"labels,omitempty"`
}

type ReorderBoardTopicsRequest struct {
	Channel         string   `json:"channel"`
	Status          string   `json:"status"`
	OrderedTopicIDs []string `json:"ordered_topic_ids"`
}

type CreateBoardMessageRequest struct {
	Kind               string                 `json:"kind"`
	TextMD             string                 `json:"text_md"`
	Data               map[string]interface{} `json:"data,omitempty"`
	ActorProfile       string                 `json:"actor_profile,omitempty"`
	SourceNode         string                 `json:"source_node,omitempty"`
	TopicStatus        string                 `json:"topic_status,omitempty"`
	QuestionOptions    []string               `json:"question_options,omitempty"`
	QuestionExpiresSec int                    `json:"question_expires_sec,omitempty"`
	IdempotencyKey     string                 `json:"idempotency_key,omitempty"`
}

type AnswerBoardQuestionRequest struct {
	SelectedOption string `json:"selected_option,omitempty"`
	AnswerText     string `json:"answer_text,omitempty"`
	ActorProfile   string `json:"actor_profile,omitempty"`
}

type ListBoardTopicsOptions struct {
	Channel         string
	ExternalRef     string
	Status          string
	HasOpenQuestion *bool
	Query           string
	Sort            string
	Limit           int
}

type ListBoardEventsOptions struct {
	Channel     string
	TopicID     string
	AfterCursor int64
	Limit       int
}

type BoardChannelsResponse struct {
	OK       bool                  `json:"ok"`
	Channels []BoardChannelSummary `json:"channels"`
}

type BoardTopicsResponse struct {
	OK     bool         `json:"ok"`
	Topics []BoardTopic `json:"topics"`
}

type BoardTopicResponse struct {
	OK      bool       `json:"ok"`
	Topic   BoardTopic `json:"topic"`
	Created *bool      `json:"created,omitempty"`
}

type BoardMessagesResponse struct {
	OK       bool           `json:"ok"`
	Topic    BoardTopic     `json:"topic"`
	Messages []BoardMessage `json:"messages"`
	Cursor   int64          `json:"cursor"`
}

type BoardMessagePostResponse struct {
	OK           bool         `json:"ok"`
	Topic        BoardTopic   `json:"topic"`
	Message      BoardMessage `json:"message"`
	Cursor       int64        `json:"cursor"`
	Deduplicated *bool        `json:"deduplicated,omitempty"`
}

type AnswerBoardQuestionResponse struct {
	OK       bool         `json:"ok"`
	Topic    BoardTopic   `json:"topic"`
	Question BoardMessage `json:"question"`
	Answer   BoardMessage `json:"answer"`
	Cursor   int64        `json:"cursor"`
}

type BoardEventsResponse struct {
	OK         bool         `json:"ok"`
	Events     []BoardEvent `json:"events"`
	NextCursor int64        `json:"next_cursor"`
}

type BoardWaitTimeoutResult struct {
	OK            bool        `json:"ok"`
	TimedOut      bool        `json:"timed_out"`
	Channel       string      `json:"channel,omitempty"`
	TopicID       string      `json:"topic_id"`
	MessageID     string      `json:"message_id,omitempty"`
	Cursor        int64       `json:"cursor"`
	QuestionState string      `json:"question_state"`
	Topic         *BoardTopic `json:"topic,omitempty"`
	Next          []string    `json:"next,omitempty"`
}
