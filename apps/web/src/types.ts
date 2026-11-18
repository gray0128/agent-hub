export type AgentName = "agy" | "pi" | "omp" | "codex" | "claude";
export type NativeEventAgentName = AgentName | "grok";
export type NativeEventKind = "interaction_needed" | "turn_summary" | "progress";
export type NativeEventNotifyStatus = "none" | "queued" | "sent" | "partial" | "failed" | "skipped";
export type AttentionState = "open" | "acked" | "superseded" | "stale";
export type DeliverySourceKind = "run" | "native_event";
export type DeliveryChannelKind = "bot_webhook" | "web_push" | "legacy_webhook";
export type DeliveryStatus = "queued" | "sent" | "failed" | "skipped";
export type NotifyRouteMode = "key" | "node_default" | "web_push" | "global_legacy";
export type DeliveryTriggerEvent =
  | "needs_approval"
  | "done"
  | "failed"
  | "cancelled"
  | "interaction_needed"
  | "turn_summary"
  | "progress";
export type PushEventFilterKey =
  | "run_needs_approval"
  | "run_failed"
  | "run_done"
  | "run_cancelled"
  | "native_interaction_needed"
  | "native_turn_summary"
  | "native_progress";

export interface DeliveriesSummary {
  total: number;
  sent: number;
  queued: number;
  failed: number;
}

export interface NativeEventView {
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

export interface PushConfigRecord {
  enabled: boolean;
  vapid_public_key: string | null;
  reason?: "VAPID_NOT_CONFIGURED";
}

export interface PushSubscriptionTestResponse {
  ok: true;
  delivered: boolean;
  http_status: number | null;
  error_code: string;
  error_message: string;
  subscription: WebPushSubscriptionRecord;
}
export type EffortLevel =
  | ""
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"
  | "auto";
export type NodeStatus = "online" | "offline" | "draining";
export type ThreadStatus = "active" | "archived";
export type RunStatus =
  | "queued"
  | "claimed"
  | "running"
  | "needs_approval"
  | "done"
  | "failed"
  | "cancelled";

export interface WorkspaceEntry {
  key: string;
  path: string;
  default_branch?: string;
}

export interface ModelCapability {
  id: string;
  label: string;
  efforts: EffortLevel[];
  default_effort?: EffortLevel;
}

export interface AgentCapability {
  enabled?: boolean;
  available?: boolean;
  default_model?: string;
  default_effort?: EffortLevel;
  catalog_status?: "pending" | "ready" | "fallback";
  models?: ModelCapability[];
}

export interface NodeCapabilities {
  agents?: Record<string, AgentCapability>;
  aliases?: Record<string, string>;
}

export interface NodeRecord {
  id: string;
  display_name: string;
  os: string;
  arch: string;
  version: string;
  capabilities: NodeCapabilities;
  workspaces: WorkspaceEntry[];
  status: NodeStatus;
  max_concurrency: number;
  active_runs_count: number;
  default_notify_key_id?: string | null;
  default_notify_key_name?: string;
  default_notify_webhook_host?: string;
  default_notify_valid?: boolean;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

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
  notify_status: "none" | "queued" | "sent" | "failed";
  deliveries_summary?: DeliveriesSummary;
  lease_expires_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number;
  created_at: string;
  updated_at: string;
}

export interface RunEventItem {
  seq: number;
  kind: "status" | "tool_use" | "turn_end" | "approval_needed" | "stderr_warn" | "system";
  payload: Record<string, unknown>;
  ts?: string;
  created_at?: string;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  key_prefix: string;
  scope: "admin" | "client" | "node";
  bound_node_id: string | null;
  allowed_nodes: string[];
  allow_unsandboxed: boolean;
  max_depth_limit: number;
  notify_webhook_host: string;
  has_webhook: boolean;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface CreateRunPayload {
  thread_id?: string;
  node_id?: string;
  workdir?: string;
  agent?: AgentName;
  model?: string;
  effort?: EffortLevel;
  sandbox?: boolean;
  prompt: string;
  title?: string;
  notify?: { target: "none" | "grok" | "webhook" };
}

export type StreamFrame =
  | {
      type: "snapshot";
      nodes: NodeRecord[];
      threads?: ThreadRecord[];
      runs: RunRecord[];
      native_events?: NativeEventView[];
      open_interaction_count?: number;
      ts: string;
    }
  | {
      type: "node.status";
      node: NodeRecord;
    }
  | {
      type: "run.updated";
      run: RunRecord;
    }
  | {
      type: "run.event";
      run_id: string;
      seq: number;
      kind: RunEventItem["kind"];
      payload: Record<string, unknown>;
      ts: string;
    }
  | {
      type: "run.events";
      run_id: string;
      events: RunEventItem[];
    }
  | {
      type: "native_event.upserted";
      event: NativeEventView;
      open_interaction_count: number;
    }
  | {
      type: "delivery.updated";
      delivery: NotificationDeliveryRecord;
    };
