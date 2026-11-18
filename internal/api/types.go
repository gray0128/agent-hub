package api

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
	ID               string  `json:"id"`
	ThreadID         string  `json:"thread_id"`
	RootRunID        string  `json:"root_run_id"`
	ParentRunID      *string `json:"parent_run_id,omitempty"`
	Depth            int     `json:"depth"`
	MaxDepth         int     `json:"max_depth"`
	NodeID           string  `json:"node_id"`
	Workdir          string  `json:"workdir"`
	Agent            string  `json:"agent"`
	Model            string  `json:"model,omitempty"`
	Effort           string  `json:"effort,omitempty"`
	Sandbox          bool    `json:"sandbox"`
	TimeoutSec       int     `json:"timeout_sec"`
	Prompt           string  `json:"prompt,omitempty"`
	Status           string  `json:"status"`
	PriorityOrder    float64 `json:"priority_order,omitempty"`
	LeaseOwner       string  `json:"lease_owner,omitempty"`
	ResolvedModel    string  `json:"resolved_model,omitempty"`
	ResolvedEffort   string  `json:"resolved_effort,omitempty"`
	NativeSessionID  *string `json:"native_session_id,omitempty"`
	RemoteControlURL string  `json:"remote_control_url,omitempty"`
	Summary          string  `json:"summary,omitempty"`
	OutputPreview    string  `json:"output_preview,omitempty"`
	OutputMD         string  `json:"output_md,omitempty"`
	OutputBytes      int     `json:"output_bytes,omitempty"`
	Truncated        *bool   `json:"truncated,omitempty"`
	WebhookArmed     *bool   `json:"webhook_armed,omitempty"`
	ErrorCode         string             `json:"error_code,omitempty"`
	ErrorMessage      string             `json:"error_message,omitempty"`
	NotifyStatus      string             `json:"notify_status,omitempty"`
	DeliveriesSummary *DeliveriesSummary `json:"deliveries_summary,omitempty"`
	LeaseExpiresAt    *string            `json:"lease_expires_at,omitempty"`
	StartedAt        *string `json:"started_at,omitempty"`
	FinishedAt       *string `json:"finished_at,omitempty"`
	DurationMs       int64   `json:"duration_ms,omitempty"`
	CreatedAt        string  `json:"created_at"`
	UpdatedAt        string  `json:"updated_at"`
}

type NotifyConfig struct {
	Target string   `json:"target"`
	Events []string `json:"events,omitempty"`
}

type CreateRunRequest struct {
	ThreadID       string        `json:"thread_id,omitempty"`
	NodeID         string        `json:"node_id,omitempty"`
	Workdir        string        `json:"workdir,omitempty"`
	Agent          string        `json:"agent,omitempty"`
	Model          string        `json:"model,omitempty"`
	Effort         string        `json:"effort,omitempty"`
	Sandbox        *bool         `json:"sandbox,omitempty"`
	TimeoutSec     int           `json:"timeout_sec,omitempty"`
	Prompt         string        `json:"prompt"`
	Title          string        `json:"title,omitempty"`
	ParentRunID    string        `json:"parent_run_id,omitempty"`
	IdempotencyKey string        `json:"idempotency_key,omitempty"`
	Notify         *NotifyConfig `json:"notify,omitempty"`
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
	LeaseOwner       string `json:"lease_owner"`
	Status           string `json:"status"`
	NativeSessionID  string `json:"native_session_id,omitempty"`
	ResolvedModel    string `json:"resolved_model,omitempty"`
	ResolvedEffort   string `json:"resolved_effort,omitempty"`
	Summary          string `json:"summary"`
	OutputMD         string `json:"output_md"`
	OutputBytes      int    `json:"output_bytes"`
	DurationMs       int64  `json:"duration_ms"`
	ErrorCode        string `json:"error_code,omitempty"`
	ErrorMessage     string `json:"error_message,omitempty"`
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
}

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
