export type NodeStatus = "online" | "offline" | "draining";
export type ApiScope = "admin" | "client" | "node";
export type AgentName = "agy" | "pi" | "omp" | "codex" | "claude";
export type NativeEventAgentName = AgentName | "grok";
export type EffortLevel = "" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "auto";
export type ThreadStatus = "active" | "archived";
export type RunStatus =
  | "queued"
  | "claimed"
  | "running"
  | "needs_approval"
  | "done"
  | "failed"
  | "cancelled";
export type RunEventKind =
  | "status"
  | "tool_use"
  | "turn_end"
  | "approval_needed"
  | "stderr_warn"
  | "system";
export type NotifyTarget = "none" | "grok" | "webhook";
export type NotifyEvent = "done" | "failed" | "cancelled" | "needs_approval";
export type NotifyStatus = "none" | "queued" | "sent" | "failed";
export type NativeEventKind = "interaction_needed" | "turn_summary" | "progress";
export type NativeEventNotifyStatus = "none" | "queued" | "sent" | "partial" | "failed" | "skipped";
export type NotifyRouteMode = "key" | "node_default" | "web_push" | "global_legacy";
export type AttentionState = "open" | "acked" | "superseded" | "stale";
export type DeliverySourceKind = "run" | "native_event" | "board_message";
export type DeliveryChannelKind = "bot_webhook" | "web_push" | "legacy_webhook";
export type DeliveryStatus = "queued" | "sent" | "failed" | "skipped";
export type DeliveryTriggerEvent =
  | "needs_approval"
  | "done"
  | "failed"
  | "cancelled"
  | "interaction_needed"
  | "turn_summary"
  | "progress"
  | "question_opened";
export type PushEventFilterKey =
  | "run_needs_approval"
  | "run_failed"
  | "run_done"
  | "run_cancelled"
  | "native_interaction_needed"
  | "native_turn_summary"
  | "native_progress"
  | "board_question_opened";

export type BoardTopicStatus = "todo" | "in_progress" | "blocked" | "done" | "archived";
export type BoardPreviousStatus = "" | "todo" | "in_progress";
export type BoardMessageKind = "note" | "handoff" | "question" | "answer" | "artifact";
export type BoardQuestionState = "" | "open" | "answered" | "expired" | "cancelled";
export type BoardEventType =
  | "topic.created"
  | "topic.updated"
  | "message.posted"
  | "question.opened"
  | "question.answered"
  | "question.expired"
  | "question.cancelled";

export type ErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN_SCOPE"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "NODE_NOT_FOUND"
  | "NODE_DRAINING"
  | "WORKDIR_NOT_FOUND"
  | "WORKDIR_AMBIGUOUS"
  | "DEPTH_LIMIT_EXCEEDED"
  | "DELEGATION_CYCLE_DETECTED"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_STATE_TRANSITION"
  | "LEASE_CONFLICT"
  | "NODE_LEASE_EXPIRED"
  | "INTERNAL_ERROR";

export class HubError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  readonly next?: string[];

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    next?: string[]
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.next = next;
  }
}

export interface WorkspaceEntry {
  key: string;
  path: string;
  default_branch?: string;
}

export interface NodeRecord {
  id: string;
  display_name: string;
  os: string;
  arch: string;
  version: string;
  capabilities: Record<string, unknown>;
  workspaces: WorkspaceEntry[];
  status: NodeStatus;
  max_concurrency: number;
  active_runs_count: number;
  default_notify_key_id?: string | null;
  default_notify_key_name?: string;
  default_notify_webhook_host?: string;
  default_notify_valid?: boolean;
  default_notify_events?: PushEventFilterKey[];
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliveriesSummary {
  total: number;
  sent: number;
  queued: number;
  failed: number;
}

export interface NotificationDeliveryRecord {
  id: string;
  source_kind: DeliverySourceKind;
  source_id: string;
  trigger_event: DeliveryTriggerEvent;
  node_id: string;
  channel_kind: DeliveryChannelKind;
  channel_id: string;
  channel_label: string;
  target_host: string;
  route_mode: NotifyRouteMode;
  status: DeliveryStatus;
  attempts: number;
  http_status: number | null;
  error_code: string;
  error_message: string;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebPushSubscriptionRecord {
  id: string;
  label: string;
  endpoint_host: string;
  endpoint_sha256_prefix: string;
  node_filter: string[];
  event_filter: PushEventFilterKey[];
  enabled: boolean;
  failure_count: number;
  last_sent_at: string | null;
  last_error_code: string;
  last_error_message: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebPushSubscriptionSecret {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PushConfigRecord {
  enabled: boolean;
  vapid_public_key: string | null;
  reason?: "VAPID_NOT_CONFIGURED";
}

export interface NativeEventRecord {
  id: string;
  node_id: string;
  event_id: string;
  agent: NativeEventAgentName;
  event_kind: NativeEventKind;
  native_session_id: string;
  workdir: string;
  title: string;
  summary: string;
  source: string;
  notify_key_id: string | null;
  notify_status: NativeEventNotifyStatus;
  notify_error: string;
  ack_at: string | null;
  attention_state: AttentionState | null;
  deliveries_summary?: DeliveriesSummary;
  created_at: string;
  updated_at: string;
}

export type NativeEventView = NativeEventRecord;

export interface ThreadRecord {
  id: string;
  title: string;
  node_id: string;
  workdir: string;
  project_key: string;
  agent: AgentName;
  native_session_id: string | null;
  status: ThreadStatus;
  pinned: boolean;
  sort_order: number;
  last_run_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunRecord {
  id: string;
  thread_id: string;
  root_run_id: string;
  parent_run_id: string | null;
  depth: number;
  max_depth: number;
  node_id: string;
  workdir: string;
  agent: AgentName;
  model: string;
  effort: EffortLevel;
  sandbox: boolean;
  timeout_sec: number;
  prompt?: string;
  status: RunStatus;
  priority_order: number;
  resolved_model: string;
  resolved_effort: string;
  native_session_id: string | null;
  remote_control_url: string;
  summary: string;
  output_preview?: string;
  output_md?: string;
  output_bytes: number;
  truncated?: boolean;
  webhook_armed?: boolean;
  error_code: string;
  error_message: string;
  notify_status: NotifyStatus;
  deliveries_summary?: DeliveriesSummary;
  lease_expires_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number;
  created_at: string;
  updated_at: string;
}

export interface RunEventRecord {
  id?: number;
  run_id: string;
  seq: number;
  kind: RunEventKind;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  scope: ApiScope;
  bound_node_id: string | null;
  key_prefix: string;
  allowed_nodes: string[];
  allowed_board_prefixes: string[];
  allow_unsandboxed: boolean;
  max_depth_limit: number;
  notify_webhook_host: string;
  has_webhook: boolean;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface AuthPrincipal {
  kind: "access_jwt" | "bootstrap_admin" | "api_key";
  keyId: string | null;
  scope: ApiScope;
  boundNodeId: string | null;
  allowedNodes: string[];
  allowedBoardPrefixes: string[];
  allowUnsandboxed: boolean;
  maxDepthLimit: number;
}

export interface BoardHandoffSnapshot {
  id: string;
  actor_profile: string;
  source_node: string;
  text_md: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface BoardChannelSummary {
  channel: string;
  active_topic_count: number;
  open_question_count: number;
  total_topic_count?: number;
  updated_at?: string | null;
}

export interface BoardTopic {
  id: string;
  channel: string;
  title: string;
  external_ref: string;
  status: BoardTopicStatus;
  previous_status: BoardPreviousStatus;
  pinned: boolean;
  sort_order: number;
  labels: Record<string, string>;
  created_by_key_id: string | null;
  last_message_id: string;
  last_handoff_message_id: string;
  last_event_cursor: number;
  open_question_count?: number;
  message_count?: number;
  latest_handoff?: BoardHandoffSnapshot | null;
  created_at: string;
  updated_at: string;
}

export interface BoardMessage {
  id: string;
  topic_id: string;
  channel: string;
  seq: number;
  kind: BoardMessageKind;
  reply_to_id: string | null;
  actor_scope: "admin" | "client";
  actor_key_id: string | null;
  actor_profile: string;
  source_node: string;
  text_md: string;
  data: Record<string, unknown>;
  question_state: BoardQuestionState;
  question_options: string[];
  question_expires_at: string | null;
  answered_message_id: string | null;
  answered_at: string | null;
  deliveries_summary?: DeliveriesSummary;
  created_at: string;
}

export interface BoardEvent {
  cursor: number;
  channel: string;
  topic_id: string;
  message_id: string | null;
  event_type: BoardEventType;
  actor_profile: string;
  created_at: string;
}

export interface NotifyPolicy {
  target: NotifyTarget;
  events?: NotifyEvent[];
}

export interface RunNotifyQueueMessage {
  kind?: "run";
  run_id: string;
  thread_id: string;
  root_run_id: string;
  node_id: string;
  workdir: string;
  agent: AgentName;
  status: RunStatus;
  target: NotifyTarget;
  route_mode?: NotifyRouteMode;
  attempt: number;
}

export interface NativeEventNotifyQueueMessage {
  kind: "native_event";
  native_event_id: string;
  node_id: string;
  attempt: number;
}

export interface DeliveryNotifyQueueMessage {
  kind: "delivery";
  delivery_id: string;
  bypass_coalesce?: boolean;
}

export type NotifyQueueMessage =
  | DeliveryNotifyQueueMessage
  | RunNotifyQueueMessage
  | NativeEventNotifyQueueMessage;

export interface Env {
  ASSETS?: Fetcher;
  DB: D1Database;
  NODE_HUB: DurableObjectNamespace;
  NOTIFY_QUEUE: Queue<NotifyQueueMessage>;
  HUB_PUBLIC_URL: string;
  DEFAULT_MAX_DEPTH: string;
  LEASE_TTL_SECONDS: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  BOOTSTRAP_ADMIN_TOKEN_SHA256?: string;
  GROK_WEBHOOK_URL?: string;
  GROK_WEBHOOK_KEY?: string;
  WEBHOOK_URL?: string;
  WEBHOOK_KEY?: string;
  WEBHOOK_ENCRYPTION_KEY?: string;
  RELEASE_BASE_URL?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_JWK?: string;
  VAPID_SUBJECT?: string;
  NATIVE_EVENTS_RETENTION_DAYS?: string;
  BOARD_EVENTS_RETENTION_DAYS?: string;
  NATIVE_NOTIFY_QUIET_SEC?: string;
  NATIVE_NOTIFY_COOLDOWN_SEC?: string;
  ALLOW_LOOPBACK_PUSH_FOR_TEST?: string;
}

export interface NodeHelloFrame {
  type: "node.hello";
  conn_nonce: string;
  version: string;
  os: string;
  arch: string;
  max_concurrency: number;
  capabilities: Record<string, unknown>;
  workspaces: WorkspaceEntry[];
}

export interface NodePingFrame {
  type: "node.ping";
  active_run_ids: string[];
  ts: string;
}

export interface RunEventInput {
  seq: number;
  kind: RunEventKind;
  payload: Record<string, unknown>;
  ts: string;
}

export interface RunEventFrame extends RunEventInput {
  type: "run.event";
  run_id: string;
}

export interface RunEventsBatchFrame {
  type: "run.events";
  run_id: string;
  events: RunEventInput[];
}

export interface RunStateFrame {
  type: "run.state";
  run_id: string;
  lease_owner: string;
  status: "running" | "needs_approval" | "done" | "failed" | "cancelled";
  remote_control_url?: string;
  resolved_model?: string;
  resolved_effort?: string;
  ts: string;
}

export type NodeInboundFrame =
  | NodeHelloFrame
  | NodePingFrame
  | RunEventFrame
  | RunEventsBatchFrame
  | RunStateFrame;
