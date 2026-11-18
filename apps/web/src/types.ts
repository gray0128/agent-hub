export type AgentName = "agy" | "pi" | "omp" | "codex" | "claude";
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
    };
