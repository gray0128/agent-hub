import {
  type AgentName,
  type ApiScope,
  type EffortLevel,
  HubError,
  type NativeEventAgentName,
  type NativeEventKind,
  type NodeInboundFrame,
  type NodeStatus,
  type NotifyEvent,
  type NotifyPolicy,
  type NotifyTarget,
  type RunEventInput,
  type RunEventKind,
  type RunStatus,
  type ThreadStatus,
  type WorkspaceEntry
} from "./types";
import { validateWebhookUrl } from "./webhook-crypto";

const AGENTS = new Set<AgentName>(["agy", "pi", "omp", "codex", "claude"]);
const NATIVE_EVENT_AGENTS = new Set<NativeEventAgentName>(["agy", "pi", "omp", "codex", "claude", "grok"]);
const EFFORTS = new Set<EffortLevel>(["", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "auto"]);
const CATALOG_STATUSES = new Set(["pending", "ready", "fallback"]);
const EVENT_KINDS = new Set<RunEventKind>([
  "status",
  "tool_use",
  "turn_end",
  "approval_needed",
  "stderr_warn",
  "system"
]);
const NOTIFY_TARGETS = new Set<NotifyTarget>(["none", "grok", "webhook"]);
const NOTIFY_EVENTS = new Set<NotifyEvent>(["done", "failed", "cancelled", "needs_approval"]);
const NATIVE_EVENT_KINDS = new Set<NativeEventKind>(["interaction_needed", "turn_summary"]);
const NODE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const THREAD_ID_RE = /^thr_[A-Za-z0-9]+$/;
const RUN_ID_RE = /^run_[A-Za-z0-9]+$/;
const KEY_ID_RE = /^key_[A-Za-z0-9]{8,64}$/;
const NATIVE_EVENT_ID_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

function asRecord(raw: unknown, context: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HubError(400, "BAD_REQUEST", `${context} must be a JSON object.`);
  }
  return raw as Record<string, unknown>;
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      throw new HubError(400, "BAD_REQUEST", `Unexpected field '${key}' in ${context}.`);
    }
  }
}

function asOptionalString(
  obj: Record<string, unknown>,
  key: string,
  maxLen?: number
): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    throw new HubError(400, "BAD_REQUEST", `Field '${key}' must be a string.`);
  }
  if (maxLen !== undefined && v.length > maxLen) {
    throw new HubError(400, "BAD_REQUEST", `Field '${key}' exceeds max length ${maxLen}.`);
  }
  return v;
}

function asRequiredString(
  obj: Record<string, unknown>,
  key: string,
  minLen = 1,
  maxLen?: number
): string {
  const v = asOptionalString(obj, key, maxLen);
  if (v === undefined || v.length < minLen) {
    throw new HubError(400, "BAD_REQUEST", `Field '${key}' is required (minLength=${minLen}).`);
  }
  return v;
}

function asOptionalBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") {
    throw new HubError(400, "BAD_REQUEST", `Field '${key}' must be a boolean.`);
  }
  return v;
}

function asOptionalInt(
  obj: Record<string, unknown>,
  key: string,
  min: number,
  max: number
): number | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new HubError(400, "BAD_REQUEST", `Field '${key}' must be an integer in [${min}, ${max}].`);
  }
  return v;
}

function asOptionalNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new HubError(400, "BAD_REQUEST", `Field '${key}' must be a finite number.`);
  }
  return v;
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HubError(400, "BAD_REQUEST", "Request body must be valid JSON.");
  }
}

export interface ParsedCreateRun {
  threadId?: string;
  nodeId?: string;
  workdir?: string;
  agent?: AgentName;
  model: string;
  effort: EffortLevel;
  sandbox: boolean;
  timeoutSec: number;
  prompt: string;
  title?: string;
  parentRunId?: string;
  idempotencyKey?: string;
  notify: NotifyPolicy;
}

export function parseCreateRunRequest(raw: unknown): ParsedCreateRun {
  const obj = asRecord(raw, "CreateRunRequest");
  rejectUnknownKeys(
    obj,
    [
      "thread_id",
      "node_id",
      "workdir",
      "agent",
      "model",
      "effort",
      "sandbox",
      "timeout_sec",
      "prompt",
      "title",
      "parent_run_id",
      "idempotency_key",
      "notify"
    ],
    "CreateRunRequest"
  );

  const threadId = asOptionalString(obj, "thread_id");
  if (threadId !== undefined && !THREAD_ID_RE.test(threadId)) {
    throw new HubError(400, "BAD_REQUEST", "Invalid thread_id format.");
  }

  const nodeId = asOptionalString(obj, "node_id", 64);
  if (nodeId !== undefined && !NODE_ID_RE.test(nodeId)) {
    throw new HubError(400, "BAD_REQUEST", "Invalid node_id format.");
  }

  const workdir = asOptionalString(obj, "workdir", 512);
  if (workdir !== undefined && workdir.length < 1) {
    throw new HubError(400, "BAD_REQUEST", "workdir must not be empty.");
  }

  const agentRaw = asOptionalString(obj, "agent");
  let agent: AgentName | undefined;
  if (agentRaw !== undefined) {
    if (!AGENTS.has(agentRaw as AgentName)) {
      throw new HubError(400, "BAD_REQUEST", `Unsupported agent '${agentRaw}'.`);
    }
    agent = agentRaw as AgentName;
  }

  if (threadId === undefined && (!nodeId || !workdir || !agent)) {
    throw new HubError(
      400,
      "BAD_REQUEST",
      "node_id, workdir, and agent are required when thread_id is omitted."
    );
  }

  const model = asOptionalString(obj, "model", 128) ?? "";
  const effortRaw = asOptionalString(obj, "effort") ?? "";
  if (effortRaw !== "" && !EFFORTS.has(effortRaw as EffortLevel)) {
    throw new HubError(400, "BAD_REQUEST", `Unsupported effort '${effortRaw}'.`);
  }
  const effort = effortRaw as EffortLevel;
  const sandbox = asOptionalBoolean(obj, "sandbox") ?? true;
  const timeoutSec = asOptionalInt(obj, "timeout_sec", 10, 7200) ?? 900;
  const prompt = asRequiredString(obj, "prompt", 1, 200000);
  const title = asOptionalString(obj, "title", 160);

  const parentRunId = asOptionalString(obj, "parent_run_id");
  if (parentRunId !== undefined && !RUN_ID_RE.test(parentRunId)) {
    throw new HubError(400, "BAD_REQUEST", "Invalid parent_run_id format.");
  }

  const idempotencyKey = asOptionalString(obj, "idempotency_key", 128);
  if (idempotencyKey !== undefined && idempotencyKey.length < 8) {
    throw new HubError(400, "BAD_REQUEST", "idempotency_key must have length >= 8.");
  }

  let notify: NotifyPolicy = { target: "none" };
  if (obj["notify"] !== undefined) {
    const nObj = asRecord(obj["notify"], "notify");
    rejectUnknownKeys(nObj, ["target", "events"], "notify");
    const targetRaw = asOptionalString(nObj, "target") ?? "none";
    if (!NOTIFY_TARGETS.has(targetRaw as NotifyTarget)) {
      throw new HubError(400, "BAD_REQUEST", `Invalid notify target '${targetRaw}'.`);
    }
    let events: NotifyEvent[] | undefined;
    if (nObj["events"] !== undefined) {
      if (!Array.isArray(nObj["events"])) {
        throw new HubError(400, "BAD_REQUEST", "notify.events must be an array.");
      }
      const seen = new Set<NotifyEvent>();
      events = [];
      for (const item of nObj["events"]) {
        if (typeof item !== "string" || !NOTIFY_EVENTS.has(item as NotifyEvent)) {
          throw new HubError(400, "BAD_REQUEST", "Invalid event in notify.events.");
        }
        const ev = item as NotifyEvent;
        if (!seen.has(ev)) {
          seen.add(ev);
          events.push(ev);
        }
      }
    }
    notify = { target: targetRaw as NotifyTarget, events };
  }

  return {
    threadId,
    nodeId,
    workdir,
    agent,
    model,
    effort,
    sandbox,
    timeoutSec,
    prompt,
    title,
    parentRunId,
    idempotencyKey,
    notify
  };
}

export function parsePatchNodeRequest(raw: unknown): {
  displayName?: string;
  status?: NodeStatus;
  maxConcurrency?: number;
  defaultNotifyKeyId?: string | null;
} {
  const obj = asRecord(raw, "PatchNodeRequest");
  rejectUnknownKeys(
    obj,
    ["display_name", "status", "max_concurrency", "default_notify_key_id"],
    "PatchNodeRequest"
  );
  const displayName = asOptionalString(obj, "display_name", 128);
  const statusRaw = asOptionalString(obj, "status");
  let status: NodeStatus | undefined;
  if (statusRaw !== undefined) {
    if (statusRaw !== "online" && statusRaw !== "offline" && statusRaw !== "draining") {
      throw new HubError(400, "BAD_REQUEST", `Invalid node status '${statusRaw}'.`);
    }
    status = statusRaw;
  }
  const maxConcurrency = asOptionalInt(obj, "max_concurrency", 1, 16);

  let defaultNotifyKeyId: string | null | undefined;
  if (obj["default_notify_key_id"] !== undefined) {
    const rawKey = obj["default_notify_key_id"];
    if (rawKey === null) {
      defaultNotifyKeyId = null;
    } else if (typeof rawKey === "string") {
      const trimmed = rawKey.trim();
      if (trimmed === "") {
        defaultNotifyKeyId = null;
      } else {
        if (!KEY_ID_RE.test(trimmed)) {
          throw new HubError(400, "BAD_REQUEST", "Invalid default_notify_key_id format.");
        }
        defaultNotifyKeyId = trimmed;
      }
    } else {
      throw new HubError(400, "BAD_REQUEST", "Field 'default_notify_key_id' must be a string or null.");
    }
  }

  return { displayName, status, maxConcurrency, defaultNotifyKeyId };
}

export interface ParsedNativeEventCreate {
  eventId: string;
  agent: NativeEventAgentName;
  eventKind: NativeEventKind;
  nativeSessionId: string;
  workdir: string;
  title: string;
  summary: string;
  source: string;
}

export function parseNativeEventCreateRequest(raw: unknown): ParsedNativeEventCreate {
  const obj = asRecord(raw, "NativeEventCreateRequest");
  rejectUnknownKeys(
    obj,
    ["event_id", "agent", "event_kind", "native_session_id", "workdir", "title", "summary", "source"],
    "NativeEventCreateRequest"
  );
  const eventId = asRequiredString(obj, "event_id", 8, 128).trim();
  if (!NATIVE_EVENT_ID_RE.test(eventId)) {
    throw new HubError(400, "BAD_REQUEST", "Invalid event_id format.");
  }
  const agentRaw = asRequiredString(obj, "agent");
  if (!NATIVE_EVENT_AGENTS.has(agentRaw as NativeEventAgentName)) {
    throw new HubError(400, "BAD_REQUEST", `Unsupported agent '${agentRaw}'.`);
  }
  const kindRaw = asRequiredString(obj, "event_kind");
  if (!NATIVE_EVENT_KINDS.has(kindRaw as NativeEventKind)) {
    throw new HubError(400, "BAD_REQUEST", `Invalid event_kind '${kindRaw}'.`);
  }
  const nativeSessionId = asOptionalString(obj, "native_session_id", 256) ?? "";
  const workdir = asOptionalString(obj, "workdir", 1024) ?? "";
  const title = asOptionalString(obj, "title", 200) ?? "";
  const summary = asRequiredString(obj, "summary", 1, 4000);
  const source = asOptionalString(obj, "source", 64) ?? "cli";
  return {
    eventId,
    agent: agentRaw as NativeEventAgentName,
    eventKind: kindRaw as NativeEventKind,
    nativeSessionId,
    workdir,
    title,
    summary,
    source
  };
}

export function parseClaimRequest(raw: unknown): {
  connNonce: string;
  busyWorkdirs: string[];
} {
  const obj = asRecord(raw, "ClaimRequest");
  rejectUnknownKeys(obj, ["conn_nonce", "busy_workdirs"], "ClaimRequest");
  const connNonce = asRequiredString(obj, "conn_nonce", 8, 128);
  const busyWorkdirs: string[] = [];
  if (obj["busy_workdirs"] !== undefined) {
    if (!Array.isArray(obj["busy_workdirs"])) {
      throw new HubError(400, "BAD_REQUEST", "busy_workdirs must be an array.");
    }
    for (const item of obj["busy_workdirs"]) {
      if (typeof item !== "string") {
        throw new HubError(400, "BAD_REQUEST", "busy_workdirs items must be strings.");
      }
      busyWorkdirs.push(item);
    }
  }
  return { connNonce, busyWorkdirs };
}

export function parseHeartbeatRequest(raw: unknown): { leaseOwner: string } {
  const obj = asRecord(raw, "HeartbeatRequest");
  rejectUnknownKeys(obj, ["lease_owner"], "HeartbeatRequest");
  return { leaseOwner: asRequiredString(obj, "lease_owner", 4, 256) };
}

export interface ApprovalCheckpointInput {
  leaseOwner: string;
  remoteControlUrl: string;
  nativeSessionId?: string;
  resolvedModel: string;
  resolvedEffort: string;
  summary: string;
  outputMd: string;
  outputBytes: number;
  durationMs: number;
}

export function parseApprovalCheckpointRequest(raw: unknown): ApprovalCheckpointInput {
  const obj = asRecord(raw, "ApprovalCheckpointRequest");
  rejectUnknownKeys(
    obj,
    [
      "lease_owner",
      "remote_control_url",
      "native_session_id",
      "resolved_model",
      "resolved_effort",
      "summary",
      "output_md",
      "output_bytes",
      "duration_ms"
    ],
    "ApprovalCheckpointRequest"
  );
  const leaseOwner = asRequiredString(obj, "lease_owner", 1, 256);
  const remoteControlUrl = asOptionalString(obj, "remote_control_url", 2048) ?? "";
  const nativeSessionId = asOptionalString(obj, "native_session_id", 256);
  const resolvedModel = asOptionalString(obj, "resolved_model", 256) ?? "";
  const resolvedEffort = asOptionalString(obj, "resolved_effort", 64) ?? "";
  const summary = asOptionalString(obj, "summary", 16384) ?? "";
  const outputMd = asOptionalString(obj, "output_md") ?? "";
  const outputBytes =
    asOptionalInt(obj, "output_bytes", 0, 100_000_000) ??
    new TextEncoder().encode(outputMd).length;
  const durationMs = asOptionalInt(obj, "duration_ms", 0, 86_400_000) ?? 0;
  return {
    leaseOwner,
    remoteControlUrl,
    nativeSessionId,
    resolvedModel,
    resolvedEffort,
    summary,
    outputMd,
    outputBytes,
    durationMs
  };
}

export interface ResolveRunInput {
  summary?: string;
}

export function parseResolveRunRequest(raw: unknown): ResolveRunInput {
  if (raw === undefined || raw === null) {
    return {};
  }
  const obj = asRecord(raw, "ResolveRunRequest");
  rejectUnknownKeys(obj, ["summary"], "ResolveRunRequest");
  const summary = asOptionalString(obj, "summary", 4096);
  return { summary };
}

export function parseCompleteRequest(raw: unknown): {
  leaseOwner: string;
  status: "done" | "failed" | "cancelled";
  nativeSessionId?: string;
  resolvedModel: string;
  resolvedEffort: string;
  summary: string;
  outputMd: string;
  outputBytes: number;
  durationMs: number;
  errorCode: string;
  errorMessage: string;
} {
  const obj = asRecord(raw, "CompleteRunRequest");
  rejectUnknownKeys(
    obj,
    [
      "lease_owner",
      "status",
      "native_session_id",
      "resolved_model",
      "resolved_effort",
      "summary",
      "output_md",
      "output_bytes",
      "duration_ms",
      "error_code",
      "error_message"
    ],
    "CompleteRunRequest"
  );
  const leaseOwner = asRequiredString(obj, "lease_owner", 4, 256);
  const statusRaw = asRequiredString(obj, "status");
  if (statusRaw !== "done" && statusRaw !== "failed" && statusRaw !== "cancelled") {
    throw new HubError(400, "BAD_REQUEST", `Invalid completion status '${statusRaw}'.`);
  }
  const nativeSessionId = asOptionalString(obj, "native_session_id", 256);
  const resolvedModel = asOptionalString(obj, "resolved_model", 256) ?? "";
  const resolvedEffort = asOptionalString(obj, "resolved_effort", 64) ?? "";
  const summary = asOptionalString(obj, "summary", 8192) ?? "";
  const outputMd = asOptionalString(obj, "output_md") ?? "";
  const outputBytes =
    asOptionalInt(obj, "output_bytes", 0, 100_000_000) ??
    new TextEncoder().encode(outputMd).length;
  const durationMs = asOptionalInt(obj, "duration_ms", 0, 86_400_000) ?? 0;
  const errorCode = asOptionalString(obj, "error_code", 128) ?? "";
  const errorMessage = asOptionalString(obj, "error_message", 4096) ?? "";
  return {
    leaseOwner,
    status: statusRaw,
    nativeSessionId,
    resolvedModel,
    resolvedEffort,
    summary,
    outputMd,
    outputBytes,
    durationMs,
    errorCode,
    errorMessage
  };
}

export function parsePatchThreadRequest(raw: unknown): {
  title?: string;
  status?: ThreadStatus;
  pinned?: boolean;
  sortOrder?: number;
} {
  const obj = asRecord(raw, "PatchThreadRequest");
  rejectUnknownKeys(obj, ["title", "status", "pinned", "sort_order"], "PatchThreadRequest");
  const title = asOptionalString(obj, "title", 160);
  const statusRaw = asOptionalString(obj, "status");
  let status: ThreadStatus | undefined;
  if (statusRaw !== undefined) {
    if (statusRaw !== "active" && statusRaw !== "archived") {
      throw new HubError(400, "BAD_REQUEST", `Invalid thread status '${statusRaw}'.`);
    }
    status = statusRaw;
  }
  const pinned = asOptionalBoolean(obj, "pinned");
  const sortOrder = asOptionalNumber(obj, "sort_order");
  return { title, status, pinned, sortOrder };
}

export function parseForkThreadRequest(raw: unknown): {
  nodeId: string;
  workdir: string;
  agent?: AgentName;
  title?: string;
} {
  const obj = asRecord(raw, "ForkThreadRequest");
  rejectUnknownKeys(obj, ["node_id", "workdir", "agent", "title"], "ForkThreadRequest");
  const nodeId = asRequiredString(obj, "node_id", 1, 64);
  if (!NODE_ID_RE.test(nodeId)) {
    throw new HubError(400, "BAD_REQUEST", "Invalid node_id format.");
  }
  const workdir = asRequiredString(obj, "workdir", 1, 512);
  const agentRaw = asOptionalString(obj, "agent");
  let agent: AgentName | undefined;
  if (agentRaw !== undefined) {
    if (!AGENTS.has(agentRaw as AgentName)) {
      throw new HubError(400, "BAD_REQUEST", `Unsupported agent '${agentRaw}'.`);
    }
    agent = agentRaw as AgentName;
  }
  const title = asOptionalString(obj, "title", 160);
  return { nodeId, workdir, agent, title };
}

export function parsePatchRunRequest(raw: unknown): {
  nodeId?: string;
  workdir?: string;
  model?: string;
  effort?: EffortLevel;
  priorityOrder?: number;
} {
  const obj = asRecord(raw, "PatchRunRequest");
  rejectUnknownKeys(obj, ["node_id", "workdir", "model", "effort", "priority_order"], "PatchRunRequest");
  const nodeId = asOptionalString(obj, "node_id", 64);
  if (nodeId !== undefined && !NODE_ID_RE.test(nodeId)) {
    throw new HubError(400, "BAD_REQUEST", "Invalid node_id format.");
  }
  const workdir = asOptionalString(obj, "workdir", 512);
  const model = asOptionalString(obj, "model", 128);
  const effortRaw = asOptionalString(obj, "effort");
  let effort: EffortLevel | undefined;
  if (effortRaw !== undefined) {
    if (!EFFORTS.has(effortRaw as EffortLevel)) {
      throw new HubError(400, "BAD_REQUEST", `Invalid effort '${effortRaw}'.`);
    }
    effort = effortRaw as EffortLevel;
  }
  const priorityOrder = asOptionalNumber(obj, "priority_order");
  return { nodeId, workdir, model, effort, priorityOrder };
}

export function parseReorderRunsRequest(raw: unknown): {
  nodeId: string;
  orderedRunIds: string[];
} {
  const obj = asRecord(raw, "ReorderRunsRequest");
  rejectUnknownKeys(obj, ["node_id", "ordered_run_ids"], "ReorderRunsRequest");
  const nodeId = asRequiredString(obj, "node_id", 1, 64);
  if (!Array.isArray(obj["ordered_run_ids"])) {
    throw new HubError(400, "BAD_REQUEST", "ordered_run_ids must be an array.");
  }
  const orderedRunIds: string[] = [];
  for (const id of obj["ordered_run_ids"]) {
    if (typeof id !== "string" || !RUN_ID_RE.test(id)) {
      throw new HubError(400, "BAD_REQUEST", "ordered_run_ids must contain valid run IDs.");
    }
    orderedRunIds.push(id);
  }
  return { nodeId, orderedRunIds };
}

export function parseCancelRunRequest(raw: unknown): {
  cascade: boolean;
  reason: string;
} {
  if (raw === undefined || raw === null) {
    return { cascade: false, reason: "Cancelled by user" };
  }
  const obj = asRecord(raw, "CancelRunRequest");
  rejectUnknownKeys(obj, ["cascade", "reason"], "CancelRunRequest");
  return {
    cascade: asOptionalBoolean(obj, "cascade") ?? false,
    reason: asOptionalString(obj, "reason", 512) ?? "Cancelled by user"
  };
}

export function parseCreateKeyRequest(raw: unknown): {
  name: string;
  scope: ApiScope;
  boundNodeId?: string;
  allowedNodes: string[];
  allowUnsandboxed: boolean;
  maxDepthLimit: number;
  webhookUrl?: string;
  webhookKey?: string;
} {
  const obj = asRecord(raw, "CreateKeyRequest");
  rejectUnknownKeys(
    obj,
    [
      "name",
      "scope",
      "bound_node_id",
      "allowed_nodes",
      "allow_unsandboxed",
      "max_depth_limit",
      "webhook_url",
      "webhook_key"
    ],
    "CreateKeyRequest"
  );
  const name = asRequiredString(obj, "name", 1, 128);
  const scopeRaw = asRequiredString(obj, "scope");
  if (scopeRaw !== "admin" && scopeRaw !== "client" && scopeRaw !== "node") {
    throw new HubError(400, "BAD_REQUEST", `Invalid scope '${scopeRaw}'.`);
  }
  const scope = scopeRaw as ApiScope;
  const boundNodeId = asOptionalString(obj, "bound_node_id", 64);
  if (boundNodeId !== undefined && !NODE_ID_RE.test(boundNodeId)) {
    throw new HubError(400, "BAD_REQUEST", "Invalid bound_node_id.");
  }
  if (scope === "node" && !boundNodeId) {
    throw new HubError(400, "BAD_REQUEST", "bound_node_id is required for node scope keys.");
  }
  const allowedNodes: string[] = [];
  if (obj["allowed_nodes"] !== undefined) {
    if (!Array.isArray(obj["allowed_nodes"])) {
      throw new HubError(400, "BAD_REQUEST", "allowed_nodes must be an array.");
    }
    const seen = new Set<string>();
    for (const item of obj["allowed_nodes"]) {
      if (typeof item !== "string" || !NODE_ID_RE.test(item)) {
        throw new HubError(400, "BAD_REQUEST", "Invalid node ID in allowed_nodes.");
      }
      if (!seen.has(item)) {
        seen.add(item);
        allowedNodes.push(item);
      }
    }
  }
  const allowUnsandboxed = asOptionalBoolean(obj, "allow_unsandboxed") ?? false;
  const maxDepthLimit = asOptionalInt(obj, "max_depth_limit", 0, 3) ?? 1;

  const webhookUrlRaw = asOptionalString(obj, "webhook_url", 2048)?.trim();
  const webhookKeyRaw = asOptionalString(obj, "webhook_key", 2048)?.trim();
  if ((webhookUrlRaw || webhookKeyRaw) && scope !== "client") {
    throw new HubError(400, "BAD_REQUEST", "webhook_url and webhook_key are only allowed for client scope keys.");
  }
  if (webhookKeyRaw && !webhookUrlRaw) {
    throw new HubError(400, "BAD_REQUEST", "webhook_key requires webhook_url.");
  }
  let webhookUrl: string | undefined;
  if (webhookUrlRaw) {
    try {
      webhookUrl = validateWebhookUrl(webhookUrlRaw).toString();
    } catch (err) {
      throw new HubError(400, "BAD_REQUEST", err instanceof Error ? err.message : "Invalid webhook_url.");
    }
  }

  return {
    name,
    scope,
    boundNodeId,
    allowedNodes,
    allowUnsandboxed,
    maxDepthLimit,
    webhookUrl,
    webhookKey: webhookKeyRaw || undefined
  };
}

export interface PatchKeyInput {
  boundNodeId?: string | null;
  allowedNodes?: string[];
  allowUnsandboxed?: boolean;
  maxDepthLimit?: number;
  webhookUrl?: string;
  webhookKey?: string;
  clearWebhook?: boolean;
}

export function parsePatchKeyRequest(raw: unknown): PatchKeyInput {
  const obj = asRecord(raw, "PatchKeyRequest");
  rejectUnknownKeys(
    obj,
    [
      "bound_node_id",
      "allowed_nodes",
      "allow_unsandboxed",
      "max_depth_limit",
      "webhook_url",
      "webhook_key",
      "clear_webhook"
    ],
    "PatchKeyRequest"
  );
  if (Object.keys(obj).length === 0) {
    throw new HubError(400, "BAD_REQUEST", "PatchKeyRequest must specify at least one field.");
  }

  const out: PatchKeyInput = {};
  if (obj["bound_node_id"] !== undefined) {
    const val = obj["bound_node_id"];
    if (val === null || val === "") {
      out.boundNodeId = null;
    } else if (typeof val === "string" && val.length <= 64 && NODE_ID_RE.test(val)) {
      out.boundNodeId = val;
    } else {
      throw new HubError(400, "BAD_REQUEST", "Invalid bound_node_id.");
    }
  }

  if (obj["allowed_nodes"] !== undefined) {
    if (!Array.isArray(obj["allowed_nodes"])) {
      throw new HubError(400, "BAD_REQUEST", "allowed_nodes must be an array.");
    }
    const allowed: string[] = [];
    const seen = new Set<string>();
    for (const item of obj["allowed_nodes"]) {
      if (typeof item !== "string" || !NODE_ID_RE.test(item)) {
        throw new HubError(400, "BAD_REQUEST", "Invalid node ID in allowed_nodes.");
      }
      if (!seen.has(item)) {
        seen.add(item);
        allowed.push(item);
      }
    }
    out.allowedNodes = allowed;
  }

  const allowUnsandboxed = asOptionalBoolean(obj, "allow_unsandboxed");
  if (allowUnsandboxed !== undefined) {
    out.allowUnsandboxed = allowUnsandboxed;
  }
  const maxDepthLimit = asOptionalInt(obj, "max_depth_limit", 0, 3);
  if (maxDepthLimit !== undefined) {
    out.maxDepthLimit = maxDepthLimit;
  }
  const clearWebhook = asOptionalBoolean(obj, "clear_webhook");
  if (clearWebhook !== undefined) {
    out.clearWebhook = clearWebhook;
  }

  const webhookUrlRaw = asOptionalString(obj, "webhook_url", 2048);
  const webhookKeyRaw = asOptionalString(obj, "webhook_key", 2048);
  if (clearWebhook === true && (webhookUrlRaw !== undefined || webhookKeyRaw !== undefined)) {
    throw new HubError(400, "BAD_REQUEST", "clear_webhook cannot be combined with webhook_url or webhook_key.");
  }
  if (webhookUrlRaw !== undefined) {
    try {
      out.webhookUrl = validateWebhookUrl(webhookUrlRaw).toString();
    } catch (err) {
      throw new HubError(400, "BAD_REQUEST", err instanceof Error ? err.message : "Invalid webhook_url.");
    }
  }
  if (webhookKeyRaw !== undefined) {
    out.webhookKey = webhookKeyRaw.trim();
  }

  return out;
}

function parseWorkspaceList(raw: unknown): WorkspaceEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error("workspaces must be an array");
  }
  const out: WorkspaceEntry[] = [];
  for (const item of raw) {
    const obj = asRecord(item, "workspace");
    const key = asRequiredString(obj, "key", 1, 128);
    const path = asRequiredString(obj, "path", 1, 512);
    const defaultBranch = asOptionalString(obj, "default_branch", 128);
    out.push({ key, path, default_branch: defaultBranch });
  }
  return out;
}

function parseEventInput(raw: unknown): RunEventInput {
  const obj = asRecord(raw, "event");
  const seq = asOptionalInt(obj, "seq", 1, Number.MAX_SAFE_INTEGER);
  if (seq === undefined) {
    throw new HubError(400, "BAD_REQUEST", "event.seq must be >= 1");
  }
  const kindRaw = asRequiredString(obj, "kind");
  if (!EVENT_KINDS.has(kindRaw as RunEventKind)) {
    throw new HubError(400, "BAD_REQUEST", `Invalid event kind '${kindRaw}'`);
  }
  const payload = asRecord(obj["payload"], "event.payload");
  const ts = asRequiredString(obj, "ts", 10, 64);
  return { seq, kind: kindRaw as RunEventKind, payload, ts };
}

function parseNodeCapabilities(raw: unknown): Record<string, unknown> {
  const obj = asRecord(raw, "capabilities");
  if (obj["agents"] !== undefined) {
    const agentsObj = asRecord(obj["agents"], "capabilities.agents");
    for (const [agentName, rawAgentCap] of Object.entries(agentsObj)) {
      const cap = asRecord(rawAgentCap, `capabilities.agents.${agentName}`);
      asOptionalBoolean(cap, "enabled");
      asOptionalBoolean(cap, "available");
      asOptionalString(cap, "default_model", 128);
      const defaultEffort = asOptionalString(cap, "default_effort", 32);
      if (defaultEffort !== undefined && !EFFORTS.has(defaultEffort as EffortLevel)) {
        throw new HubError(400, "BAD_REQUEST", `Unsupported default_effort '${defaultEffort}' in capabilities.agents.${agentName}.`);
      }
      const catalogStatus = asOptionalString(cap, "catalog_status", 32);
      if (catalogStatus !== undefined && !CATALOG_STATUSES.has(catalogStatus)) {
        throw new HubError(400, "BAD_REQUEST", `Unsupported catalog_status '${catalogStatus}' in capabilities.agents.${agentName}.`);
      }
      if (cap["models"] !== undefined) {
        if (!Array.isArray(cap["models"])) {
          throw new HubError(400, "BAD_REQUEST", `capabilities.agents.${agentName}.models must be an array.`);
        }
        if (cap["models"].length > 500) {
          throw new HubError(400, "BAD_REQUEST", `capabilities.agents.${agentName}.models exceeds max length 500.`);
        }
        for (let i = 0; i < cap["models"].length; i++) {
          const item = asRecord(cap["models"][i], `capabilities.agents.${agentName}.models[${i}]`);
          rejectUnknownKeys(
            item,
            ["id", "label", "efforts", "default_effort"],
            `capabilities.agents.${agentName}.models[${i}]`
          );
          asRequiredString(item, "id", 1, 128);
          asRequiredString(item, "label", 0, 160);
          if (!Array.isArray(item["efforts"])) {
            throw new HubError(400, "BAD_REQUEST", `capabilities.agents.${agentName}.models[${i}].efforts must be an array.`);
          }
          for (const eff of item["efforts"]) {
            if (typeof eff !== "string" || eff === "" || !EFFORTS.has(eff as EffortLevel)) {
              throw new HubError(400, "BAD_REQUEST", `Invalid effort '${String(eff)}' in capabilities.agents.${agentName}.models[${i}].efforts.`);
            }
          }
          const modelDefaultEffort = asOptionalString(item, "default_effort", 32);
          if (modelDefaultEffort !== undefined && !EFFORTS.has(modelDefaultEffort as EffortLevel)) {
            throw new HubError(400, "BAD_REQUEST", `Invalid default_effort '${modelDefaultEffort}' in capabilities.agents.${agentName}.models[${i}].`);
          }
        }
      }
    }
  }
  if (obj["aliases"] !== undefined) {
    const aliasesObj = asRecord(obj["aliases"], "capabilities.aliases");
    for (const [alias, target] of Object.entries(aliasesObj)) {
      if (typeof target !== "string" || target.length > 128) {
        throw new HubError(400, "BAD_REQUEST", `capabilities.aliases.${alias} must be a string <= 128 chars.`);
      }
    }
  }
  return obj;
}

export function parseNodeWsFrame(raw: unknown): NodeInboundFrame {
  const obj = asRecord(raw, "WebSocketFrame");
  const type = asRequiredString(obj, "type");
  switch (type) {
    case "node.hello": {
      rejectUnknownKeys(
        obj,
        ["type", "conn_nonce", "version", "os", "arch", "max_concurrency", "capabilities", "workspaces"],
        "node.hello"
      );
      return {
        type: "node.hello",
        conn_nonce: asRequiredString(obj, "conn_nonce", 8, 128),
        version: asOptionalString(obj, "version", 64) ?? "",
        os: asOptionalString(obj, "os", 32) ?? "",
        arch: asOptionalString(obj, "arch", 32) ?? "",
        max_concurrency: asOptionalInt(obj, "max_concurrency", 1, 16) ?? 4,
        capabilities: parseNodeCapabilities(obj["capabilities"]),
        workspaces: parseWorkspaceList(obj["workspaces"])
      };
    }
    case "node.ping": {
      rejectUnknownKeys(obj, ["type", "active_run_ids", "ts"], "node.ping");
      if (!Array.isArray(obj["active_run_ids"])) {
        throw new HubError(400, "BAD_REQUEST", "active_run_ids must be an array");
      }
      const activeRunIds: string[] = [];
      for (const id of obj["active_run_ids"]) {
        if (typeof id !== "string") {
          throw new HubError(400, "BAD_REQUEST", "active_run_ids items must be strings");
        }
        activeRunIds.push(id);
      }
      return {
        type: "node.ping",
        active_run_ids: activeRunIds,
        ts: asRequiredString(obj, "ts", 10, 64)
      };
    }
    case "run.event": {
      rejectUnknownKeys(obj, ["type", "run_id", "seq", "kind", "payload", "ts"], "run.event");
      const runId = asRequiredString(obj, "run_id");
      if (!RUN_ID_RE.test(runId)) {
        throw new HubError(400, "BAD_REQUEST", "Invalid run_id");
      }
      const ev = parseEventInput(obj);
      return {
        type: "run.event",
        run_id: runId,
        ...ev
      };
    }
    case "run.events": {
      rejectUnknownKeys(obj, ["type", "run_id", "events"], "run.events");
      const runId = asRequiredString(obj, "run_id");
      if (!RUN_ID_RE.test(runId)) {
        throw new HubError(400, "BAD_REQUEST", "Invalid run_id");
      }
      if (!Array.isArray(obj["events"]) || obj["events"].length === 0 || obj["events"].length > 200) {
        throw new HubError(400, "BAD_REQUEST", "events must have 1..200 items");
      }
      return {
        type: "run.events",
        run_id: runId,
        events: obj["events"].map(parseEventInput)
      };
    }
    case "run.state": {
      rejectUnknownKeys(
        obj,
        ["type", "run_id", "lease_owner", "status", "remote_control_url", "resolved_model", "resolved_effort", "ts"],
        "run.state"
      );
      const runId = asRequiredString(obj, "run_id");
      if (!RUN_ID_RE.test(runId)) {
        throw new HubError(400, "BAD_REQUEST", "Invalid run_id");
      }
      const statusRaw = asRequiredString(obj, "status");
      if (
        statusRaw !== "running" &&
        statusRaw !== "needs_approval" &&
        statusRaw !== "done" &&
        statusRaw !== "failed" &&
        statusRaw !== "cancelled"
      ) {
        throw new HubError(400, "BAD_REQUEST", `Invalid run.state status '${statusRaw}'`);
      }
      return {
        type: "run.state",
        run_id: runId,
        lease_owner: asRequiredString(obj, "lease_owner", 4, 256),
        status: statusRaw as Exclude<RunStatus, "queued" | "claimed">,
        remote_control_url: asOptionalString(obj, "remote_control_url", 1024),
        resolved_model: asOptionalString(obj, "resolved_model", 256),
        resolved_effort: asOptionalString(obj, "resolved_effort", 64),
        ts: asRequiredString(obj, "ts", 10, 64)
      };
    }
    default:
      throw new HubError(400, "BAD_REQUEST", `Unsupported frame type '${type}'`);
  }
}
