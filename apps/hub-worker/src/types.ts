export type NodeStatus = "online" | "offline" | "draining";
export type ApiScope = "admin" | "client" | "node";
export type AgentName = "agy" | "pi" | "omp" | "codex" | "claude";
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

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
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
  notify_status: NotifyStatus;
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
  allowUnsandboxed: boolean;
  maxDepthLimit: number;
}

export interface NotifyPolicy {
  target: NotifyTarget;
  events?: NotifyEvent[];
}

export interface NotifyQueueMessage {
  run_id: string;
  thread_id: string;
  root_run_id: string;
  node_id: string;
  workdir: string;
  agent: AgentName;
  status: RunStatus;
  target: NotifyTarget;
  attempt: number;
}

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
