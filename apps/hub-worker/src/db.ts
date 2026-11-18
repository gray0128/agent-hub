import { ensureNodeAllowedForClient, ensureRunAccessible, isNodeVisibleToPrincipal } from "./auth";
import { buildPromptPreview, redactSecrets } from "./redact";
import {
  type AgentName,
  type ApiKeyRecord,
  type ApiScope,
  type AuthPrincipal,
  type EffortLevel,
  type Env,
  HubError,
  type NativeEventAgentName,
  type NativeEventKind,
  type NativeEventNotifyStatus,
  type NativeEventRecord,
  type NodeRecord,
  type NodeStatus,
  type NotifyEvent,
  type NotifyPolicy,
  type NotifyQueueMessage,
  type NotifyRouteMode,
  type NotifyStatus,
  type RunEventInput,
  type RunEventKind,
  type RunEventRecord,
  type RunRecord,
  type RunStatus,
  type ThreadRecord,
  type ThreadStatus,
  type WorkspaceEntry
} from "./types";
import { newId, nowIso, sanitizeTailPreview, truncateUtf8Bytes } from "./ulid";
import {
  type ApprovalCheckpointInput,
  type ParsedCreateRun,
  type ParsedNativeEventCreate,
  type ResolveRunInput
} from "./validation";

const MAX_OUTPUT_MD_BYTES = 900 * 1024;

interface NodeRow {
  id: string;
  display_name: string;
  os: string;
  arch: string;
  version: string;
  capabilities_json: string;
  workspaces_json: string;
  status: NodeStatus;
  max_concurrency: number;
  active_runs_count: number;
  default_notify_key_id: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
  notify_key_name?: string | null;
  notify_key_scope?: ApiScope | null;
  notify_key_revoked_at?: string | null;
  notify_key_webhook_host?: string | null;
  notify_key_has_webhook?: number | null;
  notify_key_allowed_nodes_json?: string | null;
}

interface NativeEventRow {
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
  created_at: string;
  updated_at: string;
}

interface ThreadRow {
  id: string;
  title: string;
  node_id: string;
  workdir: string;
  project_key: string;
  agent: AgentName;
  native_session_id: string | null;
  status: ThreadStatus;
  pinned: number;
  sort_order: number;
  last_run_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunRow {
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
  sandbox: number;
  timeout_sec: number;
  prompt: string;
  status: RunStatus;
  priority_order: number;
  idempotency_key: string | null;
  created_by_key_id: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  resolved_model: string;
  resolved_effort: string;
  native_session_id: string | null;
  remote_control_url: string;
  summary: string;
  output_md: string;
  output_bytes: number;
  artifact_r2_key: string;
  error_code: string;
  error_message: string;
  notify_policy_json: string;
  notify_status: NotifyStatus;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number;
  created_at: string;
  updated_at: string;
}

interface ApiKeyRow {
  id: string;
  name: string;
  scope: ApiScope;
  bound_node_id: string | null;
  key_prefix: string;
  allowed_nodes_json: string;
  allow_unsandboxed: number;
  max_depth_limit: number;
  notify_webhook_ciphertext: string;
  notify_webhook_host: string;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

function parseWorkspaces(raw: string): WorkspaceEntry[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as WorkspaceEntry[];
    }
  } catch {
    // fall through
  }
  return [];
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    // fall through
  }
  return [];
}

export function parseNotifyPolicy(raw: string): NotifyPolicy {
  try {
    const parsed = JSON.parse(raw) as NotifyPolicy;
    if (parsed && typeof parsed.target === "string") {
      return parsed;
    }
  } catch {
    // fall through
  }
  return { target: "none" };
}

function isBoundNotifyKeyValidForNode(
  nodeId: string,
  key: {
    scope: ApiScope | null | undefined;
    revoked_at: string | null | undefined;
    has_webhook: boolean;
    allowed_nodes_json: string | null | undefined;
  }
): boolean {
  if (key.scope !== "client" || key.revoked_at !== null || !key.has_webhook) {
    return false;
  }
  const allowed = parseStringArray(key.allowed_nodes_json ?? "[]");
  return allowed.length === 0 || allowed.includes(nodeId);
}

export function mapNodeRow(row: NodeRow): NodeRecord {
  const defaultNotifyKeyId = row.default_notify_key_id ?? null;
  const record: NodeRecord = {
    id: row.id,
    display_name: row.display_name,
    os: row.os,
    arch: row.arch,
    version: row.version,
    capabilities: parseJsonObject(row.capabilities_json),
    workspaces: parseWorkspaces(row.workspaces_json),
    status: row.status,
    max_concurrency: row.max_concurrency,
    active_runs_count: row.active_runs_count,
    default_notify_key_id: defaultNotifyKeyId,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
  if (defaultNotifyKeyId) {
    record.default_notify_key_name = row.notify_key_name ?? "";
    record.default_notify_webhook_host = row.notify_key_webhook_host ?? "";
    record.default_notify_valid = isBoundNotifyKeyValidForNode(row.id, {
      scope: row.notify_key_scope,
      revoked_at: row.notify_key_revoked_at ?? null,
      has_webhook: row.notify_key_has_webhook === 1,
      allowed_nodes_json: row.notify_key_allowed_nodes_json
    });
  }
  return record;
}

export function mapNativeEventRow(row: NativeEventRow): NativeEventRecord {
  return {
    id: row.id,
    node_id: row.node_id,
    event_id: row.event_id,
    agent: row.agent,
    event_kind: row.event_kind,
    native_session_id: row.native_session_id,
    workdir: row.workdir,
    title: row.title,
    summary: row.summary,
    source: row.source,
    notify_key_id: row.notify_key_id ?? null,
    notify_status: row.notify_status,
    notify_error: row.notify_error,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function mapThreadRow(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    title: row.title,
    node_id: row.node_id,
    workdir: row.workdir,
    project_key: row.project_key,
    agent: row.agent,
    native_session_id: row.native_session_id,
    status: row.status,
    pinned: row.pinned === 1,
    sort_order: row.sort_order,
    last_run_id: row.last_run_id,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export type RunPromptMode = "preview" | "full_redacted" | "raw" | "none";

export function sanitizeNodeForScope(node: NodeRecord, scope: ApiScope): NodeRecord {
  if (scope === "admin") {
    return node;
  }
  const copy: NodeRecord = { ...node };
  delete copy.default_notify_key_id;
  delete copy.default_notify_key_name;
  delete copy.default_notify_webhook_host;
  delete copy.default_notify_valid;
  return copy;
}

export function mapRunRow(
  row: RunRow,
  options: {
    view?: "summary" | "full" | "list";
    tailBytes?: number;
    promptMode?: RunPromptMode;
    webhookArmed?: boolean;
  } = {}
): RunRecord {
  const view = options.view ?? "summary";
  const tailBytes = options.tailBytes ?? 16384;
  const promptMode = options.promptMode ?? "preview";
  const record: RunRecord = {
    id: row.id,
    thread_id: row.thread_id,
    root_run_id: row.root_run_id,
    parent_run_id: row.parent_run_id,
    depth: row.depth,
    max_depth: row.max_depth,
    node_id: row.node_id,
    workdir: row.workdir,
    agent: row.agent,
    model: row.model,
    effort: row.effort,
    sandbox: row.sandbox === 1,
    timeout_sec: row.timeout_sec,
    status: row.status,
    priority_order: row.priority_order,
    resolved_model: row.resolved_model,
    resolved_effort: row.resolved_effort,
    native_session_id: row.native_session_id,
    remote_control_url: row.remote_control_url,
    summary: row.summary,
    output_bytes: row.output_bytes,
    error_code: row.error_code,
    error_message: row.error_message,
    notify_status: row.notify_status,
    lease_expires_at: row.lease_expires_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_ms: row.duration_ms,
    created_at: row.created_at,
    updated_at: row.updated_at
  };

  if (promptMode === "raw") {
    record.prompt = row.prompt;
  } else if (promptMode === "full_redacted") {
    record.prompt = redactSecrets(row.prompt);
  } else if (promptMode === "preview") {
    record.prompt = buildPromptPreview(row.prompt, 1200).promptPreview;
  }
  if (options.webhookArmed !== undefined) {
    record.webhook_armed = options.webhookArmed;
  }
  if (view === "full") {
    record.output_md = row.output_md;
    record.truncated = false;
  } else if (view === "summary") {
    const tail = sanitizeTailPreview(row.output_md, tailBytes);
    record.output_preview = tail.preview;
    record.truncated = tail.truncated || row.output_bytes > tail.totalBytes;
  }
  return record;
}

export function mapApiKeyRow(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    bound_node_id: row.bound_node_id,
    key_prefix: row.key_prefix,
    allowed_nodes: parseStringArray(row.allowed_nodes_json),
    allow_unsandboxed: row.allow_unsandboxed === 1,
    max_depth_limit: row.max_depth_limit,
    notify_webhook_host: row.notify_webhook_host ?? "",
    has_webhook: Boolean(row.notify_webhook_ciphertext),
    revoked_at: row.revoked_at,
    last_used_at: row.last_used_at,
    created_at: row.created_at
  };
}

function basenameOf(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || cleaned;
}

export function resolveWorkspace(
  workspaces: WorkspaceEntry[],
  input: string
): { path: string; projectKey: string } {
  const trimmed = input.trim();
  const normalized = trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;

  // 1. Exact path match
  const exactPath = workspaces.find((w) => {
    const wp = w.path.length > 1 ? w.path.replace(/\/+$/, "") : w.path;
    return wp === normalized;
  });
  if (exactPath) {
    return { path: exactPath.path, projectKey: exactPath.key };
  }

  const looksLikeAbsolute =
    normalized.startsWith("/") || normalized.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(normalized);
  if (workspaces.length === 0 && looksLikeAbsolute) {
    return { path: normalized, projectKey: basenameOf(normalized) };
  }

  // 2. Key match (may match multiple entries like cnb/demo vs github/demo)
  const keyMatches = workspaces.filter((w) => w.key === normalized);
  if (keyMatches.length === 1) {
    return { path: keyMatches[0]!.path, projectKey: keyMatches[0]!.key };
  }
  if (keyMatches.length > 1) {
    throw new HubError(
      400,
      "WORKDIR_AMBIGUOUS",
      `Multiple workspaces matched project key '${normalized}'.`,
      { candidates: keyMatches.map((m) => m.path) }
    );
  }

  // 3. Suffix / basename match
  const suffixMatches = workspaces.filter(
    (w) =>
      w.key.endsWith(`/${normalized}`) ||
      w.path.endsWith(`/${normalized}`) ||
      basenameOf(w.path) === normalized
  );
  if (suffixMatches.length === 1) {
    return { path: suffixMatches[0]!.path, projectKey: suffixMatches[0]!.key };
  }
  if (suffixMatches.length > 1) {
    throw new HubError(
      400,
      "WORKDIR_AMBIGUOUS",
      `Multiple workspaces matched '${normalized}'.`,
      { candidates: suffixMatches.map((m) => m.path) }
    );
  }

  throw new HubError(
    400,
    "WORKDIR_NOT_FOUND",
    `No workspace matched '${normalized}' on target node.`
  );
}

const NODE_SELECT_SQL = `SELECT n.*,
  k.name AS notify_key_name,
  k.scope AS notify_key_scope,
  k.revoked_at AS notify_key_revoked_at,
  k.notify_webhook_host AS notify_key_webhook_host,
  CASE WHEN k.notify_webhook_ciphertext != '' THEN 1 ELSE 0 END AS notify_key_has_webhook,
  k.allowed_nodes_json AS notify_key_allowed_nodes_json
FROM nodes n
LEFT JOIN api_keys k ON k.id = n.default_notify_key_id`;

export async function listNodes(
  db: D1Database,
  principal: AuthPrincipal
): Promise<NodeRecord[]> {
  const res = await db
    .prepare(`${NODE_SELECT_SQL} ORDER BY CASE n.status WHEN 'online' THEN 0 WHEN 'draining' THEN 1 ELSE 2 END, n.id ASC`)
    .all<NodeRow>();
  const rows = res.results ?? [];
  return rows
    .map(mapNodeRow)
    .filter((n) => isNodeVisibleToPrincipal(principal, n.id))
    .map((n) => sanitizeNodeForScope(n, principal.scope));
}

export async function listNodesBoundToNotifyKey(
  db: D1Database,
  keyId: string
): Promise<NodeRecord[]> {
  const res = await db
    .prepare(`${NODE_SELECT_SQL} WHERE n.default_notify_key_id = ?1`)
    .bind(keyId)
    .all<NodeRow>();
  return (res.results ?? []).map(mapNodeRow);
}

function makeRecalcNodeActiveRunsStmt(db: D1Database, nodeId: string, now: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE nodes
       SET active_runs_count = (
             SELECT COUNT(*) FROM runs WHERE node_id = ?1 AND status IN ('claimed', 'running', 'needs_approval')
           ),
           updated_at = ?2
       WHERE id = ?1`
    )
    .bind(nodeId, now);
}

async function assertNoDelegationCycle(
  db: D1Database,
  parentRunId: string,
  targetNodeId: string,
  targetWorkdir: string
): Promise<void> {
  const cycleHit = await db
    .prepare(
      `WITH RECURSIVE ancestors(id, parent_run_id, node_id, workdir) AS (
         SELECT id, parent_run_id, node_id, workdir FROM runs WHERE id = ?1
         UNION ALL
         SELECT r.id, r.parent_run_id, r.node_id, r.workdir
         FROM runs r JOIN ancestors a ON r.id = a.parent_run_id
       )
       SELECT id FROM ancestors WHERE node_id = ?2 AND workdir = ?3 LIMIT 1`
    )
    .bind(parentRunId, targetNodeId, targetWorkdir)
    .first<{ id: string }>();

  if (cycleHit) {
    throw new HubError(
      409,
      "DELEGATION_CYCLE_DETECTED",
      `Delegation to (${targetNodeId}, ${targetWorkdir}) forms a cycle with ancestor run '${cycleHit.id}'.`
    );
  }
}

async function ensureThreadAccessible(
  db: D1Database,
  principal: AuthPrincipal,
  thread: { id: string; node_id: string }
): Promise<void> {
  if (principal.scope === "admin") return;
  ensureNodeAllowedForClient(principal, thread.node_id);
  if (principal.keyId) {
    const owned = await db
      .prepare(`SELECT 1 AS ok FROM runs WHERE thread_id = ?1 AND created_by_key_id = ?2 LIMIT 1`)
      .bind(thread.id, principal.keyId)
      .first<{ ok: number }>();
    if (!owned) {
      throw new HubError(403, "FORBIDDEN_SCOPE", "Client key cannot access another key's thread.");
    }
  }
}

export async function getNodeById(db: D1Database, nodeId: string): Promise<NodeRecord | null> {
  const row = await db.prepare(`${NODE_SELECT_SQL} WHERE n.id = ?1`).bind(nodeId).first<NodeRow>();
  return row ? mapNodeRow(row) : null;
}

export async function patchNode(
  db: D1Database,
  nodeId: string,
  patch: {
    displayName?: string;
    status?: NodeStatus;
    maxConcurrency?: number;
    defaultNotifyKeyId?: string | null;
  }
): Promise<NodeRecord> {
  const existing = await db.prepare(`SELECT * FROM nodes WHERE id = ?1`).bind(nodeId).first<NodeRow>();
  if (!existing) {
    throw new HubError(404, "NODE_NOT_FOUND", `Node '${nodeId}' not found.`);
  }

  let nextDefaultNotifyKeyId = existing.default_notify_key_id ?? null;
  if (patch.defaultNotifyKeyId !== undefined) {
    if (patch.defaultNotifyKeyId === null) {
      nextDefaultNotifyKeyId = null;
    } else {
      const keyRow = await db
        .prepare(
          `SELECT id, scope, allowed_nodes_json, notify_webhook_ciphertext, revoked_at
           FROM api_keys WHERE id = ?1 LIMIT 1`
        )
        .bind(patch.defaultNotifyKeyId)
        .first<{
          id: string;
          scope: ApiScope;
          allowed_nodes_json: string;
          notify_webhook_ciphertext: string;
          revoked_at: string | null;
        }>();
      if (!keyRow) {
        throw new HubError(404, "NOT_FOUND", `API key '${patch.defaultNotifyKeyId}' not found.`);
      }
      if (keyRow.revoked_at !== null) {
        throw new HubError(
          409,
          "INVALID_STATE_TRANSITION",
          `API key '${patch.defaultNotifyKeyId}' is revoked and cannot be bound as node default channel.`
        );
      }
      if (keyRow.scope !== "client") {
        throw new HubError(
          400,
          "BAD_REQUEST",
          "Node default notify channel must reference a client scope API key."
        );
      }
      if (!keyRow.notify_webhook_ciphertext?.trim()) {
        throw new HubError(
          400,
          "BAD_REQUEST",
          `Client key '${patch.defaultNotifyKeyId}' has no configured Bot Webhook.`
        );
      }
      const allowed = parseStringArray(keyRow.allowed_nodes_json);
      if (allowed.length > 0 && !allowed.includes(nodeId)) {
        throw new HubError(
          400,
          "BAD_REQUEST",
          `Client key '${patch.defaultNotifyKeyId}' does not allow node '${nodeId}'.`
        );
      }
      nextDefaultNotifyKeyId = keyRow.id;
    }
  }

  const now = nowIso();
  const displayName = patch.displayName ?? existing.display_name;
  const status = patch.status ?? existing.status;
  const maxConcurrency = patch.maxConcurrency ?? existing.max_concurrency;
  await db
    .prepare(
      `UPDATE nodes
       SET display_name = ?1, status = ?2, max_concurrency = ?3, default_notify_key_id = ?4, updated_at = ?5
       WHERE id = ?6`
    )
    .bind(displayName, status, maxConcurrency, nextDefaultNotifyKeyId, now, nodeId)
    .run();
  const updated = await db.prepare(`${NODE_SELECT_SQL} WHERE n.id = ?1`).bind(nodeId).first<NodeRow>();
  return mapNodeRow(updated!);
}

export async function upsertNodeHello(
  db: D1Database,
  nodeId: string,
  hello: {
    version: string;
    os: string;
    arch: string;
    max_concurrency: number;
    capabilities: Record<string, unknown>;
    workspaces: WorkspaceEntry[];
  }
): Promise<NodeRecord> {
  const now = nowIso();
  const existing = await db.prepare(`SELECT status, display_name FROM nodes WHERE id = ?1`).bind(nodeId).first<{
    status: NodeStatus;
    display_name: string;
  }>();
  const nextStatus: NodeStatus = existing?.status === "draining" ? "draining" : "online";
  const displayName = existing?.display_name ?? nodeId;
  await db
    .prepare(
      `INSERT INTO nodes (id, display_name, os, arch, version, capabilities_json, workspaces_json, status, max_concurrency, active_runs_count, last_seen_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10, ?10)
       ON CONFLICT(id) DO UPDATE SET
         os = excluded.os,
         arch = excluded.arch,
         version = excluded.version,
         capabilities_json = excluded.capabilities_json,
         workspaces_json = excluded.workspaces_json,
         status = CASE WHEN nodes.status = 'draining' THEN 'draining' ELSE 'online' END,
         max_concurrency = excluded.max_concurrency,
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at`
    )
    .bind(
      nodeId,
      displayName,
      hello.os,
      hello.arch,
      hello.version,
      JSON.stringify(hello.capabilities),
      JSON.stringify(hello.workspaces),
      nextStatus,
      hello.max_concurrency,
      now
    )
    .run();
  const row = await db.prepare(`${NODE_SELECT_SQL} WHERE n.id = ?1`).bind(nodeId).first<NodeRow>();
  return mapNodeRow(row!);
}

export async function setNodeOffline(db: D1Database, nodeId: string): Promise<NodeRecord | null> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE nodes
       SET status = CASE WHEN status = 'draining' THEN 'draining' ELSE 'offline' END,
           updated_at = ?1
       WHERE id = ?2`
    )
    .bind(now, nodeId)
    .run();
  const row = await db.prepare(`${NODE_SELECT_SQL} WHERE n.id = ?1`).bind(nodeId).first<NodeRow>();
  return row ? mapNodeRow(row) : null;
}

export async function createRun(
  db: D1Database,
  env: Env,
  principal: AuthPrincipal,
  input: ParsedCreateRun,
  headerIdempotencyKey?: string
): Promise<{ run: RunRow; deduplicated: boolean }> {
  if (!input.sandbox && principal.scope === "client" && !principal.allowUnsandboxed) {
    throw new HubError(
      403,
      "FORBIDDEN_SCOPE",
      "Client key is not permitted to disable sandbox (--no-sandbox)."
    );
  }

  const effectiveIdemKey = input.idempotencyKey ?? headerIdempotencyKey;

  let threadRow: ThreadRow | null = null;
  let targetNodeId: string;
  let resolvedWorkdir: string;
  let projectKey: string;
  let agent: AgentName;

  if (input.threadId) {
    threadRow = await db
      .prepare(`SELECT * FROM threads WHERE id = ?1`)
      .bind(input.threadId)
      .first<ThreadRow>();
    if (!threadRow) {
      throw new HubError(404, "NOT_FOUND", `Thread '${input.threadId}' not found.`);
    }
    await ensureThreadAccessible(db, principal, threadRow);
    targetNodeId = threadRow.node_id;
    resolvedWorkdir = threadRow.workdir;
    projectKey = threadRow.project_key;
    agent = input.agent ?? threadRow.agent;
  } else {
    targetNodeId = input.nodeId!;
    agent = input.agent!;
    if (principal.scope === "client") {
      ensureNodeAllowedForClient(principal, targetNodeId);
    }
    const nodeRow = await db.prepare(`SELECT * FROM nodes WHERE id = ?1`).bind(targetNodeId).first<NodeRow>();
    if (!nodeRow) {
      throw new HubError(404, "NODE_NOT_FOUND", `Node '${targetNodeId}' not found.`);
    }
    if (nodeRow.status === "draining") {
      throw new HubError(409, "NODE_DRAINING", `Node '${targetNodeId}' is draining.`);
    }
    const resolved = resolveWorkspace(parseWorkspaces(nodeRow.workspaces_json), input.workdir!);
    resolvedWorkdir = resolved.path;
    projectKey = resolved.projectKey;
  }

  if (principal.scope === "client") {
    ensureNodeAllowedForClient(principal, targetNodeId);
  }

  // Re-check node status when thread_id was supplied
  if (input.threadId) {
    const nodeRow = await db.prepare(`SELECT status FROM nodes WHERE id = ?1`).bind(targetNodeId).first<{ status: NodeStatus }>();
    if (!nodeRow) {
      throw new HubError(404, "NODE_NOT_FOUND", `Node '${targetNodeId}' not found.`);
    }
    if (nodeRow.status === "draining") {
      throw new HubError(409, "NODE_DRAINING", `Node '${targetNodeId}' is draining.`);
    }
  }

  if (effectiveIdemKey) {
    const existing = await db
      .prepare(`SELECT * FROM runs WHERE idempotency_key = ?1 LIMIT 1`)
      .bind(effectiveIdemKey)
      .first<RunRow>();
    if (existing) {
      if (
        existing.node_id !== targetNodeId ||
        existing.workdir !== resolvedWorkdir ||
        existing.agent !== agent ||
        existing.prompt !== input.prompt
      ) {
        throw new HubError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key already used with different run parameters."
        );
      }
      return { run: existing, deduplicated: true };
    }
  }

  const defaultMaxDepth = Number.parseInt(env.DEFAULT_MAX_DEPTH || "1", 10);
  const baseMaxDepth = Number.isFinite(defaultMaxDepth) ? Math.min(Math.max(defaultMaxDepth, 0), 3) : 1;

  let runId = newId("run");
  let rootRunId = runId;
  let parentRunId: string | null = null;
  let depth = 0;
  let maxDepth = principal.scope === "client" ? Math.min(baseMaxDepth, principal.maxDepthLimit) : baseMaxDepth;

  if (input.parentRunId) {
    const parent = await db
      .prepare(`SELECT id, root_run_id, depth, max_depth, node_id, workdir FROM runs WHERE id = ?1`)
      .bind(input.parentRunId)
      .first<{
        id: string;
        root_run_id: string;
        depth: number;
        max_depth: number;
        node_id: string;
        workdir: string;
      }>();
    if (!parent) {
      throw new HubError(400, "BAD_REQUEST", `Parent run '${input.parentRunId}' not found.`);
    }
    parentRunId = parent.id;
    rootRunId = parent.root_run_id;
    depth = parent.depth + 1;
    maxDepth = principal.scope === "client" ? Math.min(parent.max_depth, principal.maxDepthLimit) : parent.max_depth;

    if (depth > maxDepth) {
      throw new HubError(
        409,
        "DEPTH_LIMIT_EXCEEDED",
        `Delegation depth ${depth} exceeds max_depth ${maxDepth}.`
      );
    }

    await assertNoDelegationCycle(db, parent.id, targetNodeId, resolvedWorkdir);
  }

  const now = nowIso();
  const statements: D1PreparedStatement[] = [];

  let threadId = threadRow?.id;
  if (!threadId) {
    threadId = newId("thr");
    const derivedTitle = input.title?.trim() || input.prompt.trim().split(/\r?\n/)[0]!.slice(0, 80);
    statements.push(
      db
        .prepare(
          `INSERT INTO threads (id, title, node_id, workdir, project_key, agent, native_session_id, status, pinned, sort_order, last_run_id, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 'active', 0, 0, ?7, ?8, ?8)`
        )
        .bind(threadId, derivedTitle, targetNodeId, resolvedWorkdir, projectKey, agent, runId, now)
    );
  } else {
    statements.push(
      db
        .prepare(`UPDATE threads SET last_run_id = ?1, updated_at = ?2 WHERE id = ?3`)
        .bind(runId, now, threadId)
    );
  }

  const priorityRow = await db
    .prepare(`SELECT COALESCE(MAX(priority_order), 0) AS max_p FROM runs WHERE node_id = ?1 AND status = 'queued'`)
    .bind(targetNodeId)
    .first<{ max_p: number }>();
  const nextPriority = (priorityRow?.max_p ?? 0) + 100;

  statements.push(
    db
      .prepare(
        `INSERT INTO runs (
           id, thread_id, root_run_id, parent_run_id, depth, max_depth,
           node_id, workdir, agent, model, effort, sandbox, timeout_sec, prompt,
           status, priority_order, idempotency_key, created_by_key_id,
           native_session_id, notify_policy_json, notify_status, created_at, updated_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6,
           ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
           'queued', ?15, ?16, ?17,
           ?18, ?19, 'none', ?20, ?20
         )`
      )
      .bind(
        runId,
        threadId,
        rootRunId,
        parentRunId,
        depth,
        maxDepth,
        targetNodeId,
        resolvedWorkdir,
        agent,
        input.model,
        input.effort,
        input.sandbox ? 1 : 0,
        input.timeoutSec,
        input.prompt,
        nextPriority,
        effectiveIdemKey ?? null,
        principal.keyId,
        threadRow?.native_session_id ?? null,
        JSON.stringify(input.notify),
        now
      )
  );

  await db.batch(statements);
  const created = await db.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(runId).first<RunRow>();
  return { run: created!, deduplicated: false };
}

export async function claimRunsForNode(
  db: D1Database,
  nodeId: string,
  connNonce: string,
  busyWorkdirs: string[],
  leaseTtlSeconds: number
): Promise<RunRow[]> {
  const node = await db
    .prepare(`SELECT status, max_concurrency FROM nodes WHERE id = ?1`)
    .bind(nodeId)
    .first<{ status: NodeStatus; max_concurrency: number }>();
  if (!node) {
    throw new HubError(404, "NODE_NOT_FOUND", `Node '${nodeId}' not found.`);
  }
  const now = nowIso();
  if (node.status === "draining") {
    await db
      .prepare(`UPDATE nodes SET last_seen_at = ?1, updated_at = ?1 WHERE id = ?2`)
      .bind(now, nodeId)
      .run();
    return [];
  }

  const candidatesRes = await db
    .prepare(
      `SELECT r.*, t.native_session_id AS thread_native_session_id
       FROM runs r
       JOIN threads t ON t.id = r.thread_id
       WHERE r.node_id = ?1 AND r.status = 'queued'
       ORDER BY r.priority_order ASC, r.created_at ASC
       LIMIT 32`
    )
    .bind(nodeId)
    .all<RunRow & { thread_native_session_id: string | null }>();

  const candidates = candidatesRes.results ?? [];
  const busySet = new Set(busyWorkdirs);
  const leaseOwner = `${nodeId}:${connNonce}`;
  const leaseExpiresAt = nowIso(leaseTtlSeconds * 1000);
  const claimed: RunRow[] = [];

  for (const cand of candidates) {
    if (claimed.length >= node.max_concurrency) break;
    if (busySet.has(cand.workdir)) continue;

    const updateRes = await db
      .prepare(
        `UPDATE runs
         SET status = 'claimed',
             lease_owner = ?1,
             lease_expires_at = ?2,
             native_session_id = COALESCE(native_session_id, ?3),
             updated_at = ?4
         WHERE id = ?5
           AND status = 'queued'
           AND NOT EXISTS (
             SELECT 1 FROM runs a
             WHERE a.node_id = runs.node_id
               AND a.workdir = runs.workdir
               AND a.status IN ('claimed', 'running', 'needs_approval')
           )
           AND (
             SELECT COUNT(*) FROM runs c
             WHERE c.node_id = runs.node_id
               AND c.status IN ('claimed', 'running', 'needs_approval')
           ) < (
             SELECT max_concurrency FROM nodes n
             WHERE n.id = runs.node_id AND n.status != 'draining'
           )`
      )
      .bind(leaseOwner, leaseExpiresAt, cand.thread_native_session_id, now, cand.id)
      .run();

    if ((updateRes.meta.changes ?? 0) === 1) {
      busySet.add(cand.workdir);
      const locked = await db.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(cand.id).first<RunRow>();
      if (locked) {
        claimed.push(locked);
      }
    }
  }

  await db
    .prepare(
      `UPDATE nodes
       SET active_runs_count = (
             SELECT COUNT(*) FROM runs WHERE node_id = ?1 AND status IN ('claimed', 'running', 'needs_approval')
           ),
           last_seen_at = ?2,
           updated_at = ?2
       WHERE id = ?1`
    )
    .bind(nodeId, now)
    .run();

  return claimed;
}

export async function renewNodePingLeases(
  db: D1Database,
  nodeId: string,
  activeRunIds: string[],
  leaseTtlSeconds: number
): Promise<void> {
  const now = nowIso();
  const nextExpiry = nowIso(leaseTtlSeconds * 1000);
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(`UPDATE nodes SET last_seen_at = ?1, updated_at = ?1 WHERE id = ?2`)
      .bind(now, nodeId)
  ];
  for (const runId of activeRunIds) {
    stmts.push(
      db
        .prepare(
          `UPDATE runs
           SET lease_expires_at = ?1, updated_at = ?2
           WHERE id = ?3 AND node_id = ?4 AND status IN ('claimed', 'running', 'needs_approval')`
        )
        .bind(nextExpiry, now, runId, nodeId)
    );
  }
  await db.batch(stmts);
}

export async function heartbeatRun(
  db: D1Database,
  runId: string,
  nodeId: string,
  leaseOwner: string,
  leaseTtlSeconds: number
): Promise<{ status: RunStatus; shouldAbort: boolean; leaseExpiresAt: string | null }> {
  const now = nowIso();
  const nextExpiry = nowIso(leaseTtlSeconds * 1000);
  const res = await db
    .prepare(
      `UPDATE runs
       SET lease_expires_at = ?1, updated_at = ?2
       WHERE id = ?3 AND node_id = ?4 AND lease_owner = ?5 AND status IN ('claimed', 'running', 'needs_approval')`
    )
    .bind(nextExpiry, now, runId, nodeId, leaseOwner)
    .run();

  const row = await db
    .prepare(`SELECT status, lease_expires_at FROM runs WHERE id = ?1 AND node_id = ?2`)
    .bind(runId, nodeId)
    .first<{ status: RunStatus; lease_expires_at: string | null }>();
  if (!row) {
    throw new HubError(404, "NOT_FOUND", `Run '${runId}' not found.`);
  }
  if ((res.meta.changes ?? 0) === 0) {
    return {
      status: row.status,
      shouldAbort: row.status === "cancelled" || row.status === "failed",
      leaseExpiresAt: row.lease_expires_at
    };
  }
  return {
    status: row.status,
    shouldAbort: false,
    leaseExpiresAt: row.lease_expires_at
  };
}

export async function applyRunStateFrame(
  db: D1Database,
  nodeId: string,
  runId: string,
  leaseOwner: string,
  targetStatus: "running" | "needs_approval" | "done" | "failed" | "cancelled",
  extra: {
    remoteControlUrl?: string;
    resolvedModel?: string;
    resolvedEffort?: string;
    leaseTtlSeconds: number;
  }
): Promise<RunRow | null> {
  const now = nowIso();
  const nextExpiry = nowIso(extra.leaseTtlSeconds * 1000);

  if (targetStatus === "running") {
    const res = await db
      .prepare(
        `UPDATE runs
         SET status = 'running',
             started_at = COALESCE(started_at, ?1),
             lease_expires_at = ?2,
             resolved_model = COALESCE(NULLIF(?3, ''), resolved_model),
             resolved_effort = COALESCE(NULLIF(?4, ''), resolved_effort),
             updated_at = ?1
         WHERE id = ?5 AND node_id = ?6 AND lease_owner = ?7 AND status IN ('claimed', 'needs_approval')`
      )
      .bind(
        now,
        nextExpiry,
        extra.resolvedModel ?? "",
        extra.resolvedEffort ?? "",
        runId,
        nodeId,
        leaseOwner
      )
      .run();
    if ((res.meta.changes ?? 0) === 0) return null;
  } else if (targetStatus === "needs_approval") {
    const res = await db
      .prepare(
        `UPDATE runs
         SET status = 'needs_approval',
             remote_control_url = COALESCE(NULLIF(?1, ''), remote_control_url),
             lease_expires_at = ?2,
             updated_at = ?3
         WHERE id = ?4 AND node_id = ?5 AND lease_owner = ?6 AND status IN ('claimed', 'running')`
      )
      .bind(extra.remoteControlUrl ?? "", nextExpiry, now, runId, nodeId, leaseOwner)
      .run();
    if ((res.meta.changes ?? 0) === 0) return null;
  } else {
    return null;
  }

  return db.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(runId).first<RunRow>();
}

export async function appendRunEvents(
  db: D1Database,
  nodeId: string,
  runId: string,
  events: RunEventInput[]
): Promise<boolean> {
  const ownerRow = await db
    .prepare(`SELECT id FROM runs WHERE id = ?1 AND node_id = ?2`)
    .bind(runId, nodeId)
    .first<{ id: string }>();
  if (!ownerRow || events.length === 0) {
    return false;
  }
  const stmts = events.map((ev) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO run_events (run_id, seq, kind, payload_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`
      )
      .bind(runId, ev.seq, ev.kind, JSON.stringify(ev.payload), ev.ts)
  );
  await db.batch(stmts);
  return true;
}

function shouldNotifyOnEvent(policy: NotifyPolicy, event: NotifyEvent): boolean {
  if (policy.target === "none") return false;
  if (!policy.events || policy.events.length === 0) return true;
  return policy.events.includes(event);
}

export async function enqueueRunNotificationIfNeeded(
  db: D1Database,
  env: Env,
  run: RunRow,
  event: NotifyEvent
): Promise<boolean> {
  const policy = parseNotifyPolicy(run.notify_policy_json);
  let target = policy.target;
  let routeMode: NotifyRouteMode = "key";

  let isAdminOrHuman = true;
  if (run.created_by_key_id) {
    const keyRow = await db
      .prepare(`SELECT scope FROM api_keys WHERE id = ?1 LIMIT 1`)
      .bind(run.created_by_key_id)
      .first<{ scope: ApiScope }>();
    isAdminOrHuman = keyRow?.scope === "admin";
  }

  if (target === "none") {
    if (run.depth !== 0 || !isAdminOrHuman) {
      return false;
    }
    const node = await getNodeById(db, run.node_id);
    if (!node?.default_notify_key_id) {
      return false;
    }
    if (!node.default_notify_valid) {
      await db
        .prepare(`UPDATE runs SET notify_status = 'failed', updated_at = ?1 WHERE id = ?2`)
        .bind(nowIso(), run.id)
        .run();
      return false;
    }
    target = "grok";
    routeMode = "node_default";
  } else {
    if (!shouldNotifyOnEvent(policy, event)) {
      return false;
    }
    if (!isAdminOrHuman) {
      routeMode = "key";
    } else {
      const node = await getNodeById(db, run.node_id);
      routeMode = node?.default_notify_key_id ? "node_default" : "global_legacy";
    }
  }

  const msg: NotifyQueueMessage = {
    kind: "run",
    run_id: run.id,
    thread_id: run.thread_id,
    root_run_id: run.root_run_id,
    node_id: run.node_id,
    workdir: run.workdir,
    agent: run.agent,
    status: run.status,
    target,
    route_mode: routeMode,
    attempt: 1
  };
  await env.NOTIFY_QUEUE.send(msg);
  await db
    .prepare(`UPDATE runs SET notify_status = 'queued', updated_at = ?1 WHERE id = ?2`)
    .bind(nowIso(), run.id)
    .run();
  return true;
}

export async function createNativeEvent(
  db: D1Database,
  env: Env,
  nodeId: string,
  input: ParsedNativeEventCreate
): Promise<{ event: NativeEventRecord; deduplicated: boolean }> {
  const existing = await db
    .prepare(`SELECT * FROM native_events WHERE node_id = ?1 AND event_id = ?2 LIMIT 1`)
    .bind(nodeId, input.eventId)
    .first<NativeEventRow>();
  if (existing) {
    return { event: mapNativeEventRow(existing), deduplicated: true };
  }

  const node = await getNodeById(db, nodeId);
  if (!node) {
    throw new HubError(404, "NODE_NOT_FOUND", `Node '${nodeId}' not found.`);
  }

  const sanitizedTitle = redactSecrets(input.title).slice(0, 200);
  const sanitizedSummary = redactSecrets(input.summary).slice(0, 4000);
  const id = newId("evt");
  const now = nowIso();

  let notifyKeyId: string | null = node.default_notify_key_id ?? null;
  let notifyStatus: NativeEventNotifyStatus = "skipped";
  let notifyError = "";

  if (!notifyKeyId) {
    notifyStatus = "skipped";
    notifyError = "NODE_DEFAULT_CHANNEL_UNBOUND";
  } else if (!node.default_notify_valid) {
    notifyStatus = "failed";
    notifyError = "DEFAULT_CHANNEL_INVALID_OR_REVOKED";
  } else {
    notifyStatus = "queued";
  }

  const insertRes = await db
    .prepare(
      `INSERT OR IGNORE INTO native_events (
         id, node_id, event_id, agent, event_kind, native_session_id, workdir,
         title, summary, source, notify_key_id, notify_status, notify_error, created_at, updated_at
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5, ?6, ?7,
         ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14
       )`
    )
    .bind(
      id,
      nodeId,
      input.eventId,
      input.agent,
      input.eventKind,
      input.nativeSessionId,
      input.workdir,
      sanitizedTitle,
      sanitizedSummary,
      input.source,
      notifyKeyId,
      notifyStatus,
      notifyError,
      now
    )
    .run();

  if ((insertRes.meta.changes ?? 0) === 0) {
    const raced = await db
      .prepare(`SELECT * FROM native_events WHERE node_id = ?1 AND event_id = ?2 LIMIT 1`)
      .bind(nodeId, input.eventId)
      .first<NativeEventRow>();
    if (raced) {
      return { event: mapNativeEventRow(raced), deduplicated: true };
    }
  }

  if (notifyStatus === "queued") {
    await env.NOTIFY_QUEUE.send({
      kind: "native_event",
      native_event_id: id,
      node_id: nodeId,
      attempt: 1
    });
  }

  const created = await db
    .prepare(`SELECT * FROM native_events WHERE id = ?1 LIMIT 1`)
    .bind(id)
    .first<NativeEventRow>();
  return { event: mapNativeEventRow(created!), deduplicated: false };
}

export async function completeRun(
  db: D1Database,
  env: Env,
  runId: string,
  nodeId: string,
  input: {
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
  }
): Promise<RunRow> {
  const now = nowIso();
  const truncatedOut = truncateUtf8Bytes(input.outputMd, MAX_OUTPUT_MD_BYTES);
  const storedBytes = Math.max(input.outputBytes, truncatedOut.originalBytes);
  const res = await db
    .prepare(
      `UPDATE runs
       SET status = ?1,
           lease_owner = NULL,
           lease_expires_at = NULL,
           native_session_id = COALESCE(NULLIF(?2, ''), native_session_id),
           resolved_model = COALESCE(NULLIF(?3, ''), resolved_model),
           resolved_effort = COALESCE(NULLIF(?4, ''), resolved_effort),
           summary = ?5,
           output_md = ?6,
           output_bytes = ?7,
           duration_ms = ?8,
           error_code = ?9,
           error_message = ?10,
           started_at = COALESCE(started_at, ?11),
           finished_at = ?11,
           updated_at = ?11
       WHERE id = ?12
         AND node_id = ?13
         AND lease_owner = ?14
         AND status IN ('claimed', 'running', 'needs_approval')`
    )
    .bind(
      input.status,
      input.nativeSessionId ?? "",
      input.resolvedModel,
      input.resolvedEffort,
      input.summary,
      truncatedOut.value,
      storedBytes,
      input.durationMs,
      input.errorCode,
      input.errorMessage,
      now,
      runId,
      nodeId,
      input.leaseOwner
    )
    .run();

  if ((res.meta.changes ?? 0) === 0) {
    const existing = await db.prepare(`SELECT status, node_id FROM runs WHERE id = ?1`).bind(runId).first<{
      status: RunStatus;
      node_id: string;
    }>();
    if (!existing) {
      throw new HubError(404, "NOT_FOUND", `Run '${runId}' not found.`);
    }
    if (existing.node_id !== nodeId) {
      throw new HubError(403, "FORBIDDEN_SCOPE", "Node key cannot complete another node's run.");
    }
    throw new HubError(
      409,
      "INVALID_STATE_TRANSITION",
      `Run '${runId}' cannot transition from '${existing.status}' to '${input.status}' with provided lease.`
    );
  }

  const updated = await db.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(runId).first<RunRow>();
  if (!updated) {
    throw new HubError(404, "NOT_FOUND", `Run '${runId}' not found after update.`);
  }

  const postStmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE threads
         SET native_session_id = COALESCE(NULLIF(?1, ''), native_session_id),
             last_run_id = ?2,
             updated_at = ?3
         WHERE id = ?4`
      )
      .bind(input.nativeSessionId ?? "", runId, now, updated.thread_id),
    db
      .prepare(
        `UPDATE nodes
         SET active_runs_count = (
               SELECT COUNT(*) FROM runs WHERE node_id = ?1 AND status IN ('claimed', 'running', 'needs_approval')
             ),
             updated_at = ?2
         WHERE id = ?1`
      )
      .bind(nodeId, now)
  ];
  await db.batch(postStmts);

  await enqueueRunNotificationIfNeeded(db, env, updated, input.status);
  return (await db.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(runId).first<RunRow>())!;
}

export async function checkpointRunApproval(
  db: D1Database,
  env: Env,
  principal: AuthPrincipal,
  runId: string,
  leaseTtlSeconds: number,
  input: ApprovalCheckpointInput
): Promise<RunRow> {
  if (principal.scope !== "node" || !principal.boundNodeId) {
    throw new HubError(403, "FORBIDDEN_SCOPE", "Only node keys may checkpoint run approvals.");
  }

  const existing = await db.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(runId).first<RunRow>();
  if (!existing) {
    throw new HubError(404, "NOT_FOUND", `Run '${runId}' not found.`);
  }
  if (existing.node_id !== principal.boundNodeId) {
    throw new HubError(403, "FORBIDDEN_SCOPE", "Node key cannot checkpoint another node's run.");
  }
  if (existing.status === "done" || existing.status === "failed" || existing.status === "cancelled") {
    throw new HubError(
      409,
      "INVALID_STATE_TRANSITION",
      `Run '${runId}' is already terminal ('${existing.status}').`
    );
  }
  if (existing.lease_owner !== input.leaseOwner) {
    throw new HubError(
      409,
      "LEASE_CONFLICT",
      `Lease owner mismatch while checkpointing approval for '${runId}'.`
    );
  }

  const now = nowIso();
  const nextExpiry = nowIso(leaseTtlSeconds * 1000);
  const truncatedOut = truncateUtf8Bytes(input.outputMd, MAX_OUTPUT_MD_BYTES);
  const storedBytes = input.outputMd ? Math.max(input.outputBytes, truncatedOut.originalBytes) : input.outputBytes;
  const firstTransition = existing.status !== "needs_approval";

  const res = await db
    .prepare(
      `UPDATE runs
       SET status = 'needs_approval',
           lease_expires_at = ?1,
           remote_control_url = COALESCE(NULLIF(?2, ''), remote_control_url),
           native_session_id = COALESCE(NULLIF(?3, ''), native_session_id),
           resolved_model = COALESCE(NULLIF(?4, ''), resolved_model),
           resolved_effort = COALESCE(NULLIF(?5, ''), resolved_effort),
           summary = CASE WHEN ?6 != '' THEN ?6 ELSE summary END,
           output_md = CASE WHEN ?7 != '' THEN ?7 ELSE output_md END,
           output_bytes = CASE WHEN ?8 > 0 THEN ?8 ELSE output_bytes END,
           duration_ms = CASE WHEN ?9 > 0 THEN ?9 ELSE duration_ms END,
           started_at = COALESCE(started_at, ?10),
           updated_at = ?10
       WHERE id = ?11
         AND node_id = ?12
         AND lease_owner = ?13
         AND status IN ('claimed', 'running', 'needs_approval')`
    )
    .bind(
      nextExpiry,
      input.remoteControlUrl,
      input.nativeSessionId ?? "",
      input.resolvedModel,
      input.resolvedEffort,
      input.summary,
      truncatedOut.value,
      storedBytes,
      input.durationMs,
      now,
      runId,
      principal.boundNodeId,
      input.leaseOwner
    )
    .run();

  if ((res.meta.changes ?? 0) === 0) {
    const fresh = await db.prepare(`SELECT status, lease_owner FROM runs WHERE id = ?1`).bind(runId).first<{
      status: RunStatus;
      lease_owner: string | null;
    }>();
    if (!fresh) {
      throw new HubError(404, "NOT_FOUND", `Run '${runId}' not found.`);
    }
    if (fresh.status === "done" || fresh.status === "failed" || fresh.status === "cancelled") {
      throw new HubError(409, "INVALID_STATE_TRANSITION", `Run '${runId}' transitioned to '${fresh.status}'.`);
    }
    throw new HubError(409, "LEASE_CONFLICT", `Lease owner conflict while checkpointing '${runId}'.`);
  }

  const updated = (await db.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(runId).first<RunRow>())!;
  await db.batch([
    db
      .prepare(
        `UPDATE threads
         SET native_session_id = COALESCE(NULLIF(?1, ''), native_session_id),
             last_run_id = ?2,
             updated_at = ?3
         WHERE id = ?4`
      )
      .bind(input.nativeSessionId ?? "", runId, now, updated.thread_id),
    makeRecalcNodeActiveRunsStmt(db, principal.boundNodeId, now)
  ]);

  if (firstTransition) {
    await enqueueRunNotificationIfNeeded(db, env, updated, "needs_approval");
  }
  return (await db.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(runId).first<RunRow>())!;
}

export async function resolveRunApproval(
  db: D1Database,
  env: Env,
  principal: AuthPrincipal,
  runId: string,
  input: ResolveRunInput
): Promise<{ run: RunRow; alreadyTerminal: boolean }> {
  if (principal.scope !== "admin" && principal.scope !== "client") {
    throw new HubError(403, "FORBIDDEN_SCOPE", "Node keys cannot resolve approvals.");
  }
  const existing = await db.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(runId).first<RunRow>();
  if (!existing) {
    throw new HubError(404, "NOT_FOUND", `Run '${runId}' not found.`);
  }
  ensureRunAccessible(principal, existing);

  if (existing.status === "done") {
    return { run: existing, alreadyTerminal: true };
  }
  if (existing.status !== "needs_approval") {
    throw new HubError(
      409,
      "INVALID_STATE_TRANSITION",
      `Run '${runId}' is '${existing.status}' and can only be resolved from 'needs_approval'.`
    );
  }

  const now = nowIso();
  const nextSummary = input.summary?.trim()
    ? input.summary.trim()
    : existing.summary || "远控审批已完成并放行";

  const res = await db
    .prepare(
      `UPDATE runs
       SET status = 'done',
           lease_owner = NULL,
           lease_expires_at = NULL,
           summary = ?1,
           finished_at = ?2,
           updated_at = ?2
       WHERE id = ?3 AND status = 'needs_approval'`
    )
    .bind(nextSummary, now, runId)
    .run();

  if ((res.meta.changes ?? 0) === 0) {
    const fresh = await db.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(runId).first<RunRow>();
    if (!fresh) {
      throw new HubError(404, "NOT_FOUND", `Run '${runId}' not found.`);
    }
    if (fresh.status === "done") {
      return { run: fresh, alreadyTerminal: true };
    }
    throw new HubError(
      409,
      "INVALID_STATE_TRANSITION",
      `Run '${runId}' transitioned to '${fresh.status}' before resolution.`
    );
  }

  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO run_events (run_id, seq, kind, payload_json, created_at)
         VALUES (?1, COALESCE((SELECT MAX(seq) FROM run_events WHERE run_id = ?1), 0) + 1, 'status', ?2, ?3)`
      )
      .bind(runId, JSON.stringify({ status: "done", reason: "approval_resolved" }), now),
    makeRecalcNodeActiveRunsStmt(db, existing.node_id, now)
  ]);

  const updated = (await db.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(runId).first<RunRow>())!;
  await enqueueRunNotificationIfNeeded(db, env, updated, "done");
  const finalRow = (await db.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(runId).first<RunRow>())!;
  return { run: finalRow, alreadyTerminal: false };
}

export async function cancelRun(
  db: D1Database,
  env: Env,
  principal: AuthPrincipal,
  runId: string,
  options: { cascade: boolean; reason: string }
): Promise<{ cancelledRuns: RunRow[]; abortTargets: Array<{ nodeId: string; runId: string }> }> {
  const target = await db.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(runId).first<RunRow>();
  if (!target) {
    throw new HubError(404, "NOT_FOUND", `Run '${runId}' not found.`);
  }
  ensureRunAccessible(principal, target);

  const candidatesRes = options.cascade
    ? await db
        .prepare(`SELECT * FROM runs WHERE root_run_id = ?1 ORDER BY depth ASC, created_at ASC`)
        .bind(target.root_run_id)
        .all<RunRow>()
    : { results: [target] };

  const candidates = candidatesRes.results ?? [];
  const now = nowIso();
  const cancelledRuns: RunRow[] = [];
  const abortTargets: Array<{ nodeId: string; runId: string }> = [];
  const affectedNodes = new Set<string>();

  for (const r of candidates) {
    if (r.status === "done" || r.status === "failed" || r.status === "cancelled") {
      continue;
    }
    const wasActive = r.status === "claimed" || r.status === "running" || r.status === "needs_approval";
    const res = await db
      .prepare(
        `UPDATE runs
         SET status = 'cancelled',
             lease_owner = NULL,
             lease_expires_at = NULL,
             finished_at = ?1,
             updated_at = ?1,
             error_code = 'CANCELLED',
             error_message = ?2
         WHERE id = ?3 AND status IN ('queued', 'claimed', 'running', 'needs_approval')`
      )
      .bind(now, options.reason, r.id)
      .run();

    if ((res.meta.changes ?? 0) === 1) {
      affectedNodes.add(r.node_id);
      if (wasActive) {
        abortTargets.push({ nodeId: r.node_id, runId: r.id });
      }
      const fresh = await db.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(r.id).first<RunRow>();
      if (fresh) {
        await enqueueRunNotificationIfNeeded(db, env, fresh, "cancelled");
        const finalRow = await db.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(r.id).first<RunRow>();
        if (finalRow) cancelledRuns.push(finalRow);
      }
    }
  }

  if (affectedNodes.size > 0) {
    const stmts = Array.from(affectedNodes).map((nid) =>
      db
        .prepare(
          `UPDATE nodes
           SET active_runs_count = (
                 SELECT COUNT(*) FROM runs WHERE node_id = ?1 AND status IN ('claimed', 'running', 'needs_approval')
               ),
               updated_at = ?2
           WHERE id = ?1`
        )
        .bind(nid, now)
    );
    await db.batch(stmts);
  }

  if (cancelledRuns.length === 0) {
    cancelledRuns.push(target);
  }

  return { cancelledRuns, abortTargets };
}

export async function patchQueuedRun(
  db: D1Database,
  principal: AuthPrincipal,
  runId: string,
  patch: {
    nodeId?: string;
    workdir?: string;
    model?: string;
    effort?: EffortLevel;
    priorityOrder?: number;
  }
): Promise<RunRow> {
  const existing = await db.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(runId).first<RunRow>();
  if (!existing) {
    throw new HubError(404, "NOT_FOUND", `Run '${runId}' not found.`);
  }
  ensureRunAccessible(principal, existing);
  if (existing.status !== "queued") {
    throw new HubError(
      409,
      "INVALID_STATE_TRANSITION",
      `Run '${runId}' is '${existing.status}' and can only be modified while 'queued'.`
    );
  }

  const nextNodeId = patch.nodeId ?? existing.node_id;
  let nextWorkdir = patch.workdir ?? existing.workdir;
  let nextProjectKey: string | null = null;
  let threadChanged = false;

  if (patch.nodeId !== undefined || patch.workdir !== undefined) {
    if (principal.scope === "client") {
      ensureNodeAllowedForClient(principal, nextNodeId);
    }
    const node = await db.prepare(`SELECT * FROM nodes WHERE id = ?1`).bind(nextNodeId).first<NodeRow>();
    if (!node) {
      throw new HubError(404, "NODE_NOT_FOUND", `Node '${nextNodeId}' not found.`);
    }
    if (node.status === "draining") {
      throw new HubError(409, "NODE_DRAINING", `Node '${nextNodeId}' is draining.`);
    }
    const threadRow = await db
      .prepare(`SELECT * FROM threads WHERE id = ?1`)
      .bind(existing.thread_id)
      .first<ThreadRow>();
    const workspaces = parseWorkspaces(node.workspaces_json);
    const lookupKey = patch.workdir ?? threadRow?.project_key ?? basenameOf(existing.workdir);
    const resolved = resolveWorkspace(workspaces, lookupKey);
    nextWorkdir = resolved.path;
    nextProjectKey = resolved.projectKey;
    threadChanged = nextNodeId !== existing.node_id || nextWorkdir !== existing.workdir;

    if (threadChanged) {
      const countRow = await db
        .prepare(`SELECT COUNT(*) AS cnt FROM runs WHERE thread_id = ?1`)
        .bind(existing.thread_id)
        .first<{ cnt: number }>();
      if ((threadRow && threadRow.native_session_id !== null) || (countRow?.cnt ?? 0) > 1) {
        throw new HubError(
          409,
          "INVALID_STATE_TRANSITION",
          "Cannot reassign node or workdir of an established thread; fork the thread instead."
        );
      }
      if (existing.parent_run_id) {
        await assertNoDelegationCycle(db, existing.parent_run_id, nextNodeId, nextWorkdir);
      }
    }
  }

  const now = nowIso();
  const res = await db
    .prepare(
      `UPDATE runs
       SET node_id = ?1,
           workdir = ?2,
           model = ?3,
           effort = ?4,
           priority_order = ?5,
           updated_at = ?6
       WHERE id = ?7 AND status = 'queued'`
    )
    .bind(
      nextNodeId,
      nextWorkdir,
      patch.model ?? existing.model,
      patch.effort ?? existing.effort,
      patch.priorityOrder ?? existing.priority_order,
      now,
      runId
    )
    .run();

  if ((res.meta.changes ?? 0) === 0) {
    throw new HubError(
      409,
      "INVALID_STATE_TRANSITION",
      `Run '${runId}' left 'queued' state during update.`
    );
  }
  if (threadChanged && nextProjectKey !== null) {
    await db
      .prepare(
        `UPDATE threads
         SET node_id = ?1, workdir = ?2, project_key = ?3, updated_at = ?4
         WHERE id = ?5`
      )
      .bind(nextNodeId, nextWorkdir, nextProjectKey, now, existing.thread_id)
      .run();
  }
  return (await db.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(runId).first<RunRow>())!;
}

export async function reorderQueuedRuns(
  db: D1Database,
  principal: AuthPrincipal,
  nodeId: string,
  orderedRunIds: string[]
): Promise<RunRow[]> {
  if (principal.scope === "client") {
    ensureNodeAllowedForClient(principal, nodeId);
  }
  if (orderedRunIds.length === 0) {
    return [];
  }

  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < orderedRunIds.length; i++) {
    const rid = orderedRunIds[i]!;
    const score = (i + 1) * 100;
    if (principal.scope === "client") {
      stmts.push(
        db
          .prepare(
            `UPDATE runs SET priority_order = ?1, updated_at = ?2
             WHERE id = ?3 AND node_id = ?4 AND status = 'queued' AND created_by_key_id = ?5`
          )
          .bind(score, now, rid, nodeId, principal.keyId)
      );
    } else {
      stmts.push(
        db
          .prepare(
            `UPDATE runs SET priority_order = ?1, updated_at = ?2
             WHERE id = ?3 AND node_id = ?4 AND status = 'queued'`
          )
          .bind(score, now, rid, nodeId)
      );
    }
  }
  const results = await db.batch(stmts);
  for (let i = 0; i < results.length; i++) {
    if ((results[i]?.meta.changes ?? 0) === 0) {
      throw new HubError(
        409,
        "INVALID_STATE_TRANSITION",
        `Run '${orderedRunIds[i]}' is no longer queued on '${nodeId}' or not owned by key.`
      );
    }
  }

  if (principal.scope === "client" && principal.keyId) {
    const rowsRes = await db
      .prepare(
        `SELECT * FROM runs
         WHERE node_id = ?1 AND status = 'queued' AND created_by_key_id = ?2
         ORDER BY priority_order ASC, created_at ASC`
      )
      .bind(nodeId, principal.keyId)
      .all<RunRow>();
    return rowsRes.results ?? [];
  }

  const rowsRes = await db
    .prepare(
      `SELECT * FROM runs WHERE node_id = ?1 AND status = 'queued' ORDER BY priority_order ASC, created_at ASC`
    )
    .bind(nodeId)
    .all<RunRow>();
  return rowsRes.results ?? [];
}

export async function listThreads(
  db: D1Database,
  principal: AuthPrincipal,
  filters: { nodeId?: string; status?: ThreadStatus; q?: string; limit: number }
): Promise<ThreadRecord[]> {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (filters.nodeId) {
    binds.push(filters.nodeId);
    where.push(`node_id = ?${binds.length}`);
  }
  if (filters.status) {
    binds.push(filters.status);
    where.push(`status = ?${binds.length}`);
  }
  if (filters.q) {
    binds.push(`%${filters.q}%`);
    const p = `?${binds.length}`;
    where.push(`(title LIKE ${p} OR project_key LIKE ${p} OR workdir LIKE ${p})`);
  }
  if (principal.scope === "client" && principal.keyId) {
    binds.push(principal.keyId);
    where.push(
      `EXISTS (SELECT 1 FROM runs r WHERE r.thread_id = threads.id AND r.created_by_key_id = ?${binds.length})`
    );
  }

  binds.push(filters.limit);
  const sql = `SELECT * FROM threads ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY pinned DESC, sort_order ASC, updated_at DESC
               LIMIT ?${binds.length}`;
  const res = await db.prepare(sql).bind(...binds).all<ThreadRow>();
  const rows = res.results ?? [];
  return rows.map(mapThreadRow).filter((t) => isNodeVisibleToPrincipal(principal, t.node_id));
}

export async function patchThread(
  db: D1Database,
  principal: AuthPrincipal,
  threadId: string,
  patch: { title?: string; status?: ThreadStatus; pinned?: boolean; sortOrder?: number }
): Promise<ThreadRecord> {
  const existing = await db.prepare(`SELECT * FROM threads WHERE id = ?1`).bind(threadId).first<ThreadRow>();
  if (!existing) {
    throw new HubError(404, "NOT_FOUND", `Thread '${threadId}' not found.`);
  }
  await ensureThreadAccessible(db, principal, existing);

  const now = nowIso();
  await db
    .prepare(
      `UPDATE threads
       SET title = ?1, status = ?2, pinned = ?3, sort_order = ?4, updated_at = ?5
       WHERE id = ?6`
    )
    .bind(
      patch.title ?? existing.title,
      patch.status ?? existing.status,
      patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : existing.pinned,
      patch.sortOrder ?? existing.sort_order,
      now,
      threadId
    )
    .run();

  const updated = await db.prepare(`SELECT * FROM threads WHERE id = ?1`).bind(threadId).first<ThreadRow>();
  return mapThreadRow(updated!);
}

export async function forkThread(
  db: D1Database,
  env: Env,
  principal: AuthPrincipal,
  threadId: string,
  input: { nodeId: string; workdir: string; agent?: AgentName; title?: string }
): Promise<{ thread: ThreadRecord; seedRun: RunRow }> {
  const source = await db.prepare(`SELECT * FROM threads WHERE id = ?1`).bind(threadId).first<ThreadRow>();
  if (!source) {
    throw new HubError(404, "NOT_FOUND", `Thread '${threadId}' not found.`);
  }
  await ensureThreadAccessible(db, principal, source);
  const latestRun = await db
    .prepare(`SELECT summary, output_md, prompt FROM runs WHERE thread_id = ?1 ORDER BY created_at DESC LIMIT 1`)
    .bind(threadId)
    .first<{ summary: string; output_md: string; prompt: string }>();

  const contextExcerpt = latestRun?.summary?.trim()
    ? latestRun.summary.trim()
    : (latestRun?.output_md?.slice(0, 1200) || latestRun?.prompt || "");

  const forkPrompt = contextExcerpt
    ? `Forked from thread ${source.id} (${source.node_id}:${source.workdir}).\n\nPrevious context summary:\n${contextExcerpt}\n\nPlease inspect this workspace and confirm readiness to continue.`
    : `Forked from thread ${source.id}. Please inspect this workspace and summarize current status.`;

  const created = await createRun(db, env, principal, {
    nodeId: input.nodeId,
    workdir: input.workdir,
    agent: input.agent ?? source.agent,
    model: "",
    effort: "",
    sandbox: true,
    timeoutSec: 900,
    prompt: forkPrompt,
    title: input.title ?? `${source.title} (fork)`,
    notify: { target: "none" }
  });

  const forkedThread = await db
    .prepare(`SELECT * FROM threads WHERE id = ?1`)
    .bind(created.run.thread_id)
    .first<ThreadRow>();

  return { thread: mapThreadRow(forkedThread!), seedRun: created.run };
}

export async function listRuns(
  db: D1Database,
  principal: AuthPrincipal,
  filters: {
    nodeId?: string;
    threadId?: string;
    status?: RunStatus;
    rootRunId?: string;
    limit: number;
  }
): Promise<RunRecord[]> {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (filters.nodeId) {
    binds.push(filters.nodeId);
    where.push(`node_id = ?${binds.length}`);
  }
  if (filters.threadId) {
    binds.push(filters.threadId);
    where.push(`thread_id = ?${binds.length}`);
  }
  if (filters.status) {
    binds.push(filters.status);
    where.push(`status = ?${binds.length}`);
  }
  if (filters.rootRunId) {
    binds.push(filters.rootRunId);
    where.push(`root_run_id = ?${binds.length}`);
  }
  if (principal.scope === "client" && principal.keyId) {
    binds.push(principal.keyId);
    where.push(`created_by_key_id = ?${binds.length}`);
  }

  binds.push(filters.limit);
  const sql = `SELECT * FROM runs ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY created_at DESC
               LIMIT ?${binds.length}`;
  const res = await db.prepare(sql).bind(...binds).all<RunRow>();
  return (res.results ?? [])
    .filter((r) => isNodeVisibleToPrincipal(principal, r.node_id))
    .map((r) => mapRunRow(r, { view: "list", promptMode: "preview" }));
}

export async function getRunById(
  db: D1Database,
  principal: AuthPrincipal,
  runId: string,
  view: "summary" | "full",
  tailBytes: number
): Promise<RunRecord> {
  const row = await db.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(runId).first<RunRow>();
  if (!row) {
    throw new HubError(404, "NOT_FOUND", `Run '${runId}' not found.`);
  }
  ensureRunAccessible(principal, row);
  return mapRunRow(row, {
    view,
    tailBytes,
    promptMode: view === "full" ? "full_redacted" : "preview"
  });
}

export async function listRunEvents(
  db: D1Database,
  principal: AuthPrincipal,
  runId: string,
  afterSeq: number,
  limit: number
): Promise<{ events: RunEventRecord[]; nextSeq: number }> {
  const runRow = await db
    .prepare(`SELECT id, node_id, created_by_key_id FROM runs WHERE id = ?1`)
    .bind(runId)
    .first<{ id: string; node_id: string; created_by_key_id: string | null }>();
  if (!runRow) {
    throw new HubError(404, "NOT_FOUND", `Run '${runId}' not found.`);
  }
  ensureRunAccessible(principal, runRow);

  const res = await db
    .prepare(
      `SELECT id, run_id, seq, kind, payload_json, created_at
       FROM run_events
       WHERE run_id = ?1 AND seq > ?2
       ORDER BY seq ASC
       LIMIT ?3`
    )
    .bind(runId, afterSeq, limit)
    .all<{
      id: number;
      run_id: string;
      seq: number;
      kind: RunEventKind;
      payload_json: string;
      created_at: string;
    }>();

  const rows = res.results ?? [];
  const events: RunEventRecord[] = rows.map((r) => ({
    id: r.id,
    run_id: r.run_id,
    seq: r.seq,
    kind: r.kind,
    payload: parseJsonObject(r.payload_json),
    created_at: r.created_at
  }));
  const nextSeq = events.length > 0 ? events[events.length - 1]!.seq : afterSeq;
  return { events, nextSeq };
}

export async function listApiKeys(
  db: D1Database,
  filters: { scope?: ApiScope; includeRevoked: boolean }
): Promise<ApiKeyRecord[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filters.scope) {
    binds.push(filters.scope);
    where.push(`scope = ?${binds.length}`);
  }
  if (!filters.includeRevoked) {
    where.push(`revoked_at IS NULL`);
  }
  const sql = `SELECT id, name, scope, bound_node_id, key_prefix, allowed_nodes_json, allow_unsandboxed, max_depth_limit, notify_webhook_ciphertext, notify_webhook_host, revoked_at, last_used_at, created_at
               FROM api_keys
               ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY created_at DESC`;
  const res = await db.prepare(sql).bind(...binds).all<ApiKeyRow>();
  return (res.results ?? []).map(mapApiKeyRow);
}

export async function getApiKeyRawById(db: D1Database, keyId: string): Promise<ApiKeyRow | null> {
  return db
    .prepare(
      `SELECT id, name, scope, bound_node_id, key_prefix, allowed_nodes_json, allow_unsandboxed, max_depth_limit, notify_webhook_ciphertext, notify_webhook_host, revoked_at, last_used_at, created_at
       FROM api_keys
       WHERE id = ?1
       LIMIT 1`
    )
    .bind(keyId)
    .first<ApiKeyRow>();
}

async function ensureNodePlaceholder(db: D1Database, nodeId: string, now: string): Promise<void> {
  // Ensure node placeholder row exists so foreign key constraints never fail when binding a key before first connect
  await db
    .prepare(
      `INSERT INTO nodes (id, display_name, status, max_concurrency, active_runs_count, created_at, updated_at)
       VALUES (?1, ?1, 'offline', 4, 0, ?2, ?2)
       ON CONFLICT(id) DO NOTHING`
    )
    .bind(nodeId, now)
    .run();
}

export async function createApiKey(
  db: D1Database,
  input: {
    name: string;
    scope: ApiScope;
    boundNodeId?: string;
    allowedNodes: string[];
    allowUnsandboxed: boolean;
    maxDepthLimit: number;
    notifyWebhookCiphertext?: string;
    notifyWebhookHost?: string;
    token: string;
    tokenSha256: string;
  }
): Promise<ApiKeyRecord> {
  const now = nowIso();
  const keyId = newId("key");
  const keyPrefix = input.token.slice(0, 14);

  if (input.boundNodeId) {
    await ensureNodePlaceholder(db, input.boundNodeId, now);
  }

  await db
    .prepare(
      `INSERT INTO api_keys (id, name, scope, bound_node_id, key_prefix, key_sha256, allowed_nodes_json, allow_unsandboxed, max_depth_limit, notify_webhook_ciphertext, notify_webhook_host, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
    )
    .bind(
      keyId,
      input.name,
      input.scope,
      input.boundNodeId ?? null,
      keyPrefix,
      input.tokenSha256,
      JSON.stringify(input.allowedNodes),
      input.allowUnsandboxed ? 1 : 0,
      input.maxDepthLimit,
      input.notifyWebhookCiphertext ?? "",
      input.notifyWebhookHost ?? "",
      now
    )
    .run();

  const row = await getApiKeyRawById(db, keyId);
  return mapApiKeyRow(row!);
}

export async function patchApiKey(
  db: D1Database,
  keyId: string,
  patch: {
    boundNodeId?: string | null;
    allowedNodes?: string[];
    allowUnsandboxed?: boolean;
    maxDepthLimit?: number;
    notifyWebhookCiphertext?: string;
    notifyWebhookHost?: string;
  }
): Promise<ApiKeyRecord> {
  const now = nowIso();
  if (patch.boundNodeId) {
    await ensureNodePlaceholder(db, patch.boundNodeId, now);
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.boundNodeId !== undefined) {
    binds.push(patch.boundNodeId);
    sets.push(`bound_node_id = ?${binds.length}`);
  }
  if (patch.allowedNodes !== undefined) {
    binds.push(JSON.stringify(patch.allowedNodes));
    sets.push(`allowed_nodes_json = ?${binds.length}`);
  }
  if (patch.allowUnsandboxed !== undefined) {
    binds.push(patch.allowUnsandboxed ? 1 : 0);
    sets.push(`allow_unsandboxed = ?${binds.length}`);
  }
  if (patch.maxDepthLimit !== undefined) {
    binds.push(patch.maxDepthLimit);
    sets.push(`max_depth_limit = ?${binds.length}`);
  }
  if (patch.notifyWebhookCiphertext !== undefined) {
    binds.push(patch.notifyWebhookCiphertext);
    sets.push(`notify_webhook_ciphertext = ?${binds.length}`);
  }
  if (patch.notifyWebhookHost !== undefined) {
    binds.push(patch.notifyWebhookHost);
    sets.push(`notify_webhook_host = ?${binds.length}`);
  }

  if (sets.length > 0) {
    binds.push(keyId);
    await db
      .prepare(`UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?${binds.length} AND revoked_at IS NULL`)
      .bind(...binds)
      .run();
  }

  const row = await getApiKeyRawById(db, keyId);
  if (!row) {
    throw new HubError(404, "NOT_FOUND", `API key '${keyId}' not found.`);
  }
  return mapApiKeyRow(row);
}

export async function revokeApiKey(
  db: D1Database,
  keyId: string
): Promise<{ revokedAt: string; scope: ApiScope; boundNodeId: string | null }> {
  const row = await db
    .prepare(`SELECT id, scope, bound_node_id, revoked_at FROM api_keys WHERE id = ?1`)
    .bind(keyId)
    .first<{ id: string; scope: ApiScope; bound_node_id: string | null; revoked_at: string | null }>();
  if (!row) {
    throw new HubError(404, "NOT_FOUND", `API key '${keyId}' not found.`);
  }
  const now = row.revoked_at ?? nowIso();
  if (!row.revoked_at) {
    await db.prepare(`UPDATE api_keys SET revoked_at = ?1 WHERE id = ?2`).bind(now, keyId).run();
  }
  return { revokedAt: now, scope: row.scope, boundNodeId: row.bound_node_id };
}

export async function reapExpiredLeases(db: D1Database, env: Env): Promise<RunRow[]> {
  const now = nowIso();
  const expiredRes = await db
    .prepare(
      `SELECT * FROM runs
       WHERE status IN ('claimed', 'running', 'needs_approval')
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at < ?1`
    )
    .bind(now)
    .all<RunRow>();

  const expired = expiredRes.results ?? [];
  const reaped: RunRow[] = [];
  const affectedNodes = new Set<string>();

  for (const r of expired) {
    const res = await db
      .prepare(
        `UPDATE runs
         SET status = 'failed',
             lease_owner = NULL,
             lease_expires_at = NULL,
             finished_at = ?1,
             updated_at = ?1,
             error_code = 'NODE_LEASE_EXPIRED',
             error_message = 'Node lease expired without heartbeat'
         WHERE id = ?2 AND status IN ('claimed', 'running', 'needs_approval') AND lease_expires_at < ?1`
      )
      .bind(now, r.id)
      .run();

    if ((res.meta.changes ?? 0) === 1) {
      affectedNodes.add(r.node_id);
      const updated = await db.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(r.id).first<RunRow>();
      if (updated) {
        await enqueueRunNotificationIfNeeded(db, env, updated, "failed");
        const finalRow = await db.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(r.id).first<RunRow>();
        if (finalRow) reaped.push(finalRow);
      }
    }
  }

  if (affectedNodes.size > 0) {
    const stmts = Array.from(affectedNodes).map((nid) =>
      db
        .prepare(
          `UPDATE nodes
           SET active_runs_count = (
                 SELECT COUNT(*) FROM runs WHERE node_id = ?1 AND status IN ('claimed', 'running', 'needs_approval')
               ),
               updated_at = ?2
           WHERE id = ?1`
        )
        .bind(nid, now)
    );
    await db.batch(stmts);
  }

  return reaped;
}
