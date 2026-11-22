import { validateResultSchemaDefinition } from "./json-schema-subset";
import { redactSecrets } from "./redact";
import {
  type AgentName,
  type ApiScope,
  type BoardMessageKind,
  type BoardTopicStatus,
  type EffortLevel,
  HubError,
  type NativeEventAgentName,
  type NativeEventKind,
  type NativeEventNotifyStatus,
  type NodeInboundFrame,
  type NodeStatus,
  type NotifyEvent,
  type NotifyPolicy,
  type NotifyTarget,
  type PushEventFilterKey,
  type RunEventInput,
  type RunEventKind,
  type RunStatus,
  type ThreadStatus,
  type WebPushSubscriptionSecret,
  type WorkspaceEntry
} from "./types";
import { validatePushEndpointUrl, validateSubscriptionKeys } from "./web-push";
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
const NATIVE_EVENT_KINDS = new Set<NativeEventKind>(["interaction_needed", "turn_summary", "progress"]);
const NATIVE_NOTIFY_STATUSES = new Set<NativeEventNotifyStatus>([
  "none",
  "queued",
  "sent",
  "partial",
  "failed",
  "skipped"
]);
const PUSH_EVENT_FILTER_KEYS = new Set<PushEventFilterKey>([
  "run_needs_approval",
  "run_failed",
  "run_done",
  "run_cancelled",
  "native_interaction_needed",
  "native_turn_summary",
  "native_progress",
  "board_question_opened"
]);
export const DEFAULT_PUSH_EVENT_FILTER: readonly PushEventFilterKey[] = [
  "run_needs_approval",
  "run_failed",
  "native_interaction_needed",
  "board_question_opened"
];
export const DEFAULT_NODE_NOTIFY_EVENTS: readonly PushEventFilterKey[] = [
  "run_needs_approval",
  "run_failed",
  "run_done",
  "run_cancelled",
  "native_interaction_needed",
  "native_turn_summary",
  "native_progress"
];
export const VALID_PUSH_EVENT_FILTER_KEYS: ReadonlySet<PushEventFilterKey> = PUSH_EVENT_FILTER_KEYS;
export const NODE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const THREAD_ID_RE = /^thr_[A-Za-z0-9]+$/;
export const RUN_ID_RE = /^run_[A-Za-z0-9]+$/;
export const PLAN_ID_RE = /^pln_[A-Za-z0-9]+$/;
export const PLAN_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MIN_SCHEDULE_SEC = 60;
export const MAX_SCHEDULE_SEC = 604800;
const RUN_STATUSES = new Set<RunStatus>([
  "waiting",
  "queued",
  "claimed",
  "running",
  "needs_approval",
  "done",
  "failed",
  "cancelled"
]);
const RFC3339_DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i;
const KEY_ID_RE = /^key_[A-Za-z0-9]{8,64}$/;
const NATIVE_EVENT_ID_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const NATIVE_EVENT_ROW_ID_RE = /^evt_[A-Za-z0-9]+$/;
const DELIVERY_ID_RE = /^dlv_[A-Za-z0-9]+$/;
export const BOARD_CHANNEL_RE = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;
export const BOARD_PREFIX_RE = /^(\*|[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*)$/;
export const ACTOR_PROFILE_RE = /^[a-z0-9][a-z0-9._@-]{0,39}$/;
export const BOARD_TOPIC_ID_RE = /^top_[A-Za-z0-9]+$/;
export const BOARD_MESSAGE_ID_RE = /^msg_[A-Za-z0-9]+$/;
export const RUN_LABEL_KEY_RE = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
export const RUN_LABEL_VALUE_RE = /^[^\u0000-\u001f\u007f]*$/;
export const MAX_RUN_LABELS = 16;
export const MAX_RUN_LABEL_VALUE_CHARS = 128;
export const MAX_RUN_LABEL_FILTERS = 8;
const BOARD_TOPIC_STATUSES = new Set<BoardTopicStatus>([
  "todo",
  "in_progress",
  "blocked",
  "done",
  "archived"
]);
const BOARD_POSTABLE_KINDS = new Set<Exclude<BoardMessageKind, "answer">>([
  "note",
  "handoff",
  "question",
  "artifact"
]);
const utf8Encoder = new TextEncoder();

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).length;
}

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

function parseNotifyPolicyField(raw: unknown): NotifyPolicy {
  if (raw === undefined) {
    return { target: "none" };
  }
  const nObj = asRecord(raw, "notify");
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
  return { target: targetRaw as NotifyTarget, events };
}

export function parseScheduledAtIso(raw: string, nowMs = Date.now()): string {
  const m = RFC3339_DATE_TIME_RE.exec(raw);
  if (!m) {
    throw new HubError(
      400,
      "BAD_REQUEST",
      "scheduled_at must be a valid RFC 3339 UTC/offset timestamp."
    );
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new HubError(400, "BAD_REQUEST", "scheduled_at contains an invalid calendar date or time.");
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new HubError(400, "BAD_REQUEST", "scheduled_at must be a valid RFC 3339 timestamp.");
  }
  // Allow 500ms clock skew on lower bound so client `now + 60s` isn't rejected due to transport latency,
  // while strictly rejecting <= 59s offsets.
  const minMs = nowMs + (MIN_SCHEDULE_SEC * 1000 - 500);
  const maxMs = nowMs + MAX_SCHEDULE_SEC * 1000;
  if (ms < minMs || ms > maxMs) {
    throw new HubError(
      400,
      "BAD_REQUEST",
      `scheduled_at must be between +${MIN_SCHEDULE_SEC}s and +${MAX_SCHEDULE_SEC}s from now.`
    );
  }
  return new Date(ms).toISOString();
}

export function parseRunLabels(raw: unknown, fieldName = "labels"): Record<string, string> {
  const obj = asRecord(raw, fieldName);
  const entries = Object.entries(obj);
  if (entries.length > MAX_RUN_LABELS) {
    throw new HubError(
      400,
      "BAD_REQUEST",
      `Field '${fieldName}' exceeds maxProperties ${MAX_RUN_LABELS}.`
    );
  }
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    const kLen = codePointLength(k);
    if (kLen < 1 || kLen > 64 || !RUN_LABEL_KEY_RE.test(k)) {
      throw new HubError(
        400,
        "BAD_REQUEST",
        `Invalid label key '${k}' in '${fieldName}': must match ^[a-z0-9][a-z0-9._/-]{0,63}$.`
      );
    }
    if (k.startsWith("ahub.")) {
      throw new HubError(
        400,
        "BAD_REQUEST",
        `Label key '${k}' uses reserved 'ahub.' prefix.`
      );
    }
    if (typeof v !== "string") {
      throw new HubError(400, "BAD_REQUEST", `Label '${k}' value must be a string.`);
    }
    if (!RUN_LABEL_VALUE_RE.test(v)) {
      throw new HubError(
        400,
        "BAD_REQUEST",
        `Label '${k}' value contains forbidden control characters.`
      );
    }
    if (codePointLength(v) > MAX_RUN_LABEL_VALUE_CHARS) {
      throw new HubError(
        400,
        "BAD_REQUEST",
        `Label '${k}' value exceeds max length ${MAX_RUN_LABEL_VALUE_CHARS}.`
      );
    }
    const clean = redactSecrets(v);
    if (codePointLength(clean) > MAX_RUN_LABEL_VALUE_CHARS) {
      throw new HubError(
        400,
        "BAD_REQUEST",
        `Label '${k}' value exceeds max length ${MAX_RUN_LABEL_VALUE_CHARS} after redaction.`
      );
    }
    Object.defineProperty(out, k, {
      value: clean,
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  return out;
}

export function parseRunLabelFilters(
  rawFilters: string[]
): Array<{ key: string; value: string }> {
  if (rawFilters.length > MAX_RUN_LABEL_FILTERS) {
    throw new HubError(
      400,
      "BAD_REQUEST",
      `Query 'label' exceeds max filter count ${MAX_RUN_LABEL_FILTERS}.`
    );
  }
  const out: Array<{ key: string; value: string }> = [];
  for (const raw of rawFilters) {
    const eqIdx = raw.indexOf("=");
    if (eqIdx <= 0) {
      throw new HubError(
        400,
        "BAD_REQUEST",
        "Query 'label' filter must use 'key=value' format."
      );
    }
    const key = raw.slice(0, eqIdx);
    const value = raw.slice(eqIdx + 1);
    const kLen = codePointLength(key);
    if (kLen < 1 || kLen > 64 || !RUN_LABEL_KEY_RE.test(key)) {
      throw new HubError(
        400,
        "BAD_REQUEST",
        `Invalid label filter key '${key}': must match ^[a-z0-9][a-z0-9._/-]{0,63}$.`
      );
    }
    if (!RUN_LABEL_VALUE_RE.test(value) || codePointLength(value) > MAX_RUN_LABEL_VALUE_CHARS) {
      throw new HubError(
        400,
        "BAD_REQUEST",
        `Invalid label filter value for '${key}'.`
      );
    }
    out.push({ key, value });
  }
  return out;
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
  dependsOn?: string[];
  scheduledAt?: string;
  boardTopicId?: string;
  actorProfile?: string;
  labels?: Record<string, string>;
  resultSchema?: Record<string, unknown>;
  notify: NotifyPolicy;
}

export function parseCreateRunRequest(raw: unknown, nowMs = Date.now()): ParsedCreateRun {
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
      "depends_on",
      "scheduled_at",
      "board_topic_id",
      "actor_profile",
      "labels",
      "result_schema",
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

  let dependsOn: string[] | undefined;
  if (obj["depends_on"] !== undefined) {
    if (!Array.isArray(obj["depends_on"])) {
      throw new HubError(400, "BAD_REQUEST", "depends_on must be an array.");
    }
    if (obj["depends_on"].length > 10) {
      throw new HubError(400, "BAD_REQUEST", "depends_on exceeds maxItems 10.");
    }
    const seen = new Set<string>();
    dependsOn = [];
    for (const item of obj["depends_on"]) {
      if (typeof item !== "string" || !RUN_ID_RE.test(item)) {
        throw new HubError(400, "BAD_REQUEST", "depends_on items must be valid run_... IDs.");
      }
      if (seen.has(item)) {
        throw new HubError(400, "BAD_REQUEST", `Duplicate run ID '${item}' in depends_on.`);
      }
      seen.add(item);
      dependsOn.push(item);
    }
  }

  const scheduledAtRaw = asOptionalString(obj, "scheduled_at", 64);
  const scheduledAt =
    scheduledAtRaw !== undefined ? parseScheduledAtIso(scheduledAtRaw, nowMs) : undefined;

  const boardTopicId = asOptionalString(obj, "board_topic_id", 64);
  if (boardTopicId !== undefined && !BOARD_TOPIC_ID_RE.test(boardTopicId)) {
    throw new HubError(400, "BAD_REQUEST", "Invalid board_topic_id format.");
  }

  const actorProfile = asOptionalString(obj, "actor_profile", 40);
  if (
    actorProfile !== undefined &&
    (codePointLength(actorProfile) < 1 ||
      codePointLength(actorProfile) > 40 ||
      !ACTOR_PROFILE_RE.test(actorProfile))
  ) {
    throw new HubError(400, "BAD_REQUEST", "Invalid actor_profile format.");
  }

  const labels = obj["labels"] !== undefined ? parseRunLabels(obj["labels"]) : undefined;
  const resultSchema =
    obj["result_schema"] !== undefined
      ? validateResultSchemaDefinition(obj["result_schema"])
      : undefined;

  const notify = parseNotifyPolicyField(obj["notify"]);

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
    dependsOn,
    scheduledAt,
    boardTopicId,
    actorProfile,
    labels,
    resultSchema,
    notify
  };
}

export interface ParsedPlanNodeSpec {
  key: string;
  nodeId: string;
  workdir: string;
  agent: AgentName;
  model: string;
  effort: EffortLevel;
  sandbox: boolean;
  timeoutSec: number;
  prompt: string;
  title?: string;
  dependsOn: string[];
  scheduledAt?: string;
  inSec?: number;
  priorityOrder?: number;
  labels: Record<string, string>;
  resultSchema?: Record<string, unknown>;
  notify: NotifyPolicy;
}

export interface ParsedCreatePlan {
  idempotencyKey?: string;
  boardTopicId?: string;
  actorProfile: string;
  parentRunId?: string;
  nodes: ParsedPlanNodeSpec[];
}

export function parseCreatePlanRequest(raw: unknown, nowMs = Date.now()): ParsedCreatePlan {
  const obj = asRecord(raw, "CreatePlanRequest");
  rejectUnknownKeys(
    obj,
    ["idempotency_key", "board_topic_id", "actor_profile", "parent_run_id", "nodes"],
    "CreatePlanRequest"
  );

  const idempotencyKey = asOptionalString(obj, "idempotency_key", 128);
  if (idempotencyKey !== undefined && idempotencyKey.length < 8) {
    throw new HubError(400, "BAD_REQUEST", "idempotency_key must have length >= 8.");
  }

  const boardTopicId = asOptionalString(obj, "board_topic_id", 64);
  if (boardTopicId !== undefined && !BOARD_TOPIC_ID_RE.test(boardTopicId)) {
    throw new HubError(400, "BAD_REQUEST", "Invalid board_topic_id format.");
  }

  const actorProfileRaw = asOptionalString(obj, "actor_profile", 40);
  if (
    actorProfileRaw !== undefined &&
    (codePointLength(actorProfileRaw) < 1 ||
      codePointLength(actorProfileRaw) > 40 ||
      !ACTOR_PROFILE_RE.test(actorProfileRaw))
  ) {
    throw new HubError(400, "BAD_REQUEST", "Invalid actor_profile format.");
  }
  const actorProfile = actorProfileRaw ?? "";

  const parentRunId = asOptionalString(obj, "parent_run_id");
  if (parentRunId !== undefined && !RUN_ID_RE.test(parentRunId)) {
    throw new HubError(400, "BAD_REQUEST", "Invalid parent_run_id format.");
  }

  const rawNodes = obj["nodes"];
  if (!Array.isArray(rawNodes) || rawNodes.length < 1 || rawNodes.length > 20) {
    throw new HubError(400, "BAD_REQUEST", "nodes must be an array of 1..20 plan node specs.");
  }

  const seenKeys = new Set<string>();
  const nodes: ParsedPlanNodeSpec[] = [];
  let totalEdges = 0;

  for (let i = 0; i < rawNodes.length; i++) {
    const ctxLabel = `nodes[${i}]`;
    const nObj = asRecord(rawNodes[i], ctxLabel);
    rejectUnknownKeys(
      nObj,
      [
        "key",
        "node_id",
        "workdir",
        "agent",
        "model",
        "effort",
        "sandbox",
        "timeout_sec",
        "prompt",
        "title",
        "depends_on",
        "scheduled_at",
        "in_sec",
        "priority_order",
        "labels",
        "result_schema",
        "notify"
      ],
      ctxLabel
    );

    const key = asRequiredString(nObj, "key", 1, 64);
    if (!PLAN_KEY_RE.test(key)) {
      throw new HubError(400, "BAD_REQUEST", `Invalid plan node key '${key}' in ${ctxLabel}.`);
    }
    if (seenKeys.has(key)) {
      throw new HubError(400, "BAD_REQUEST", `Duplicate plan node key '${key}'.`);
    }
    seenKeys.add(key);

    const nodeId = asRequiredString(nObj, "node_id", 1, 64);
    if (!NODE_ID_RE.test(nodeId)) {
      throw new HubError(400, "BAD_REQUEST", `Invalid node_id '${nodeId}' in ${ctxLabel}.`);
    }

    const workdir = asRequiredString(nObj, "workdir", 1, 512);
    const agentRaw = asRequiredString(nObj, "agent", 1);
    if (!AGENTS.has(agentRaw as AgentName)) {
      throw new HubError(400, "BAD_REQUEST", `Unsupported agent '${agentRaw}' in ${ctxLabel}.`);
    }
    const agent = agentRaw as AgentName;

    const model = asOptionalString(nObj, "model", 128) ?? "";
    const effortRaw = asOptionalString(nObj, "effort") ?? "";
    if (effortRaw !== "" && !EFFORTS.has(effortRaw as EffortLevel)) {
      throw new HubError(400, "BAD_REQUEST", `Unsupported effort '${effortRaw}' in ${ctxLabel}.`);
    }
    const effort = effortRaw as EffortLevel;
    const sandbox = asOptionalBoolean(nObj, "sandbox") ?? true;
    const timeoutSec = asOptionalInt(nObj, "timeout_sec", 10, 7200) ?? 900;
    const prompt = asRequiredString(nObj, "prompt", 1, 200000);
    const title = asOptionalString(nObj, "title", 160);

    const dependsOn: string[] = [];
    if (nObj["depends_on"] !== undefined) {
      if (!Array.isArray(nObj["depends_on"])) {
        throw new HubError(400, "BAD_REQUEST", `${ctxLabel}.depends_on must be an array.`);
      }
      if (nObj["depends_on"].length > 10) {
        throw new HubError(400, "BAD_REQUEST", `${ctxLabel}.depends_on exceeds maxItems 10.`);
      }
      const seenDeps = new Set<string>();
      for (const dep of nObj["depends_on"]) {
        if (typeof dep !== "string" || (!PLAN_KEY_RE.test(dep) && !RUN_ID_RE.test(dep))) {
          throw new HubError(
            400,
            "BAD_REQUEST",
            `Invalid dependency '${String(dep)}' in ${ctxLabel}.depends_on.`
          );
        }
        if (seenDeps.has(dep)) {
          throw new HubError(
            400,
            "BAD_REQUEST",
            `Duplicate dependency '${dep}' in ${ctxLabel}.depends_on.`
          );
        }
        seenDeps.add(dep);
        dependsOn.push(dep);
      }
      totalEdges += dependsOn.length;
      if (totalEdges > 60) {
        throw new HubError(400, "BAD_REQUEST", "Total dependency edges across plan nodes exceeds 60.");
      }
    }

    if (nObj["scheduled_at"] !== undefined && nObj["in_sec"] !== undefined) {
      throw new HubError(
        400,
        "BAD_REQUEST",
        `${ctxLabel} cannot specify both scheduled_at and in_sec.`
      );
    }

    const scheduledAtRaw = asOptionalString(nObj, "scheduled_at", 64);
    const inSec = asOptionalInt(nObj, "in_sec", MIN_SCHEDULE_SEC, MAX_SCHEDULE_SEC);
    let scheduledAt: string | undefined;
    if (scheduledAtRaw !== undefined) {
      scheduledAt = parseScheduledAtIso(scheduledAtRaw, nowMs);
    } else if (inSec !== undefined) {
      scheduledAt = new Date(nowMs + inSec * 1000).toISOString();
    }

    const priorityOrder = asOptionalNumber(nObj, "priority_order");
    const labels =
      nObj["labels"] !== undefined ? parseRunLabels(nObj["labels"], `${ctxLabel}.labels`) : {};
    const resultSchema =
      nObj["result_schema"] !== undefined
        ? validateResultSchemaDefinition(nObj["result_schema"])
        : undefined;
    const notify = parseNotifyPolicyField(nObj["notify"]);

    nodes.push({
      key,
      nodeId,
      workdir,
      agent,
      model,
      effort,
      sandbox,
      timeoutSec,
      prompt,
      title,
      dependsOn,
      scheduledAt,
      inSec,
      priorityOrder,
      labels,
      resultSchema,
      notify
    });
  }

  return {
    idempotencyKey,
    boardTopicId,
    actorProfile,
    parentRunId,
    nodes
  };
}

export interface ParsedRetryRun {
  idempotencyKey?: string;
  model?: string;
  effort?: EffortLevel;
  timeoutSec?: number;
  actorProfile?: string;
}

export function parseRetryRunRequest(raw: unknown): ParsedRetryRun {
  if (raw === undefined || raw === null) {
    return {};
  }
  const obj = asRecord(raw, "RetryRunRequest");
  rejectUnknownKeys(
    obj,
    ["idempotency_key", "model", "effort", "timeout_sec", "actor_profile"],
    "RetryRunRequest"
  );

  const idempotencyKey = asOptionalString(obj, "idempotency_key", 128);
  if (idempotencyKey !== undefined && idempotencyKey.length < 8) {
    throw new HubError(400, "BAD_REQUEST", "idempotency_key must have length >= 8.");
  }

  const model = asOptionalString(obj, "model", 128);
  const effortRaw = asOptionalString(obj, "effort");
  let effort: EffortLevel | undefined;
  if (effortRaw !== undefined) {
    if (!EFFORTS.has(effortRaw as EffortLevel)) {
      throw new HubError(400, "BAD_REQUEST", `Unsupported effort '${effortRaw}'.`);
    }
    effort = effortRaw as EffortLevel;
  }
  const timeoutSec = asOptionalInt(obj, "timeout_sec", 10, 7200);
  const actorProfile = asOptionalString(obj, "actor_profile", 40);
  if (
    actorProfile !== undefined &&
    (codePointLength(actorProfile) < 1 ||
      codePointLength(actorProfile) > 40 ||
      !ACTOR_PROFILE_RE.test(actorProfile))
  ) {
    throw new HubError(400, "BAD_REQUEST", "Invalid actor_profile format.");
  }

  return {
    idempotencyKey,
    model,
    effort,
    timeoutSec,
    actorProfile
  };
}

export function parseListRunsQuery(searchParams: URLSearchParams): {
  nodeId?: string;
  threadId?: string;
  status?: RunStatus;
  rootRunId?: string;
  planId?: string;
  boardTopicId?: string;
  labels?: Array<{ key: string; value: string }>;
  limit: number;
} {
  const nodeId = searchParams.get("node_id")?.trim() || undefined;
  const threadId = searchParams.get("thread_id")?.trim() || undefined;
  const statusRaw = searchParams.get("status")?.trim() || undefined;
  let status: RunStatus | undefined;
  if (statusRaw !== undefined) {
    if (!RUN_STATUSES.has(statusRaw as RunStatus)) {
      throw new HubError(400, "BAD_REQUEST", `Invalid run status '${statusRaw}'.`);
    }
    status = statusRaw as RunStatus;
  }
  const rootRunId = searchParams.get("root_run_id")?.trim() || undefined;
  const planId = searchParams.get("plan_id")?.trim() || undefined;
  if (planId !== undefined && !PLAN_ID_RE.test(planId)) {
    throw new HubError(400, "BAD_REQUEST", "Invalid plan_id format.");
  }
  const boardTopicId = searchParams.get("board_topic_id")?.trim() || undefined;
  if (boardTopicId !== undefined && !BOARD_TOPIC_ID_RE.test(boardTopicId)) {
    throw new HubError(400, "BAD_REQUEST", "Invalid board_topic_id format.");
  }
  const labels = parseRunLabelFilters(searchParams.getAll("label"));
  const limitRaw = searchParams.get("limit")?.trim();
  let limit = 50;
  if (limitRaw !== undefined && limitRaw !== "") {
    if (!/^-?\d+$/.test(limitRaw)) {
      throw new HubError(400, "BAD_REQUEST", "Query 'limit' must be an integer.");
    }
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isSafeInteger(parsed)) {
      throw new HubError(400, "BAD_REQUEST", "Query 'limit' must be a finite integer.");
    }
    limit = Math.min(Math.max(parsed, 1), 200);
  }
  return {
    nodeId,
    threadId,
    status,
    rootRunId,
    planId,
    boardTopicId,
    ...(labels.length > 0 ? { labels } : {}),
    limit
  };
}

export function parsePatchNodeRequest(raw: unknown): {
  displayName?: string;
  status?: NodeStatus;
  maxConcurrency?: number;
  defaultNotifyKeyId?: string | null;
  defaultNotifyEvents?: PushEventFilterKey[];
} {
  const obj = asRecord(raw, "PatchNodeRequest");
  rejectUnknownKeys(
    obj,
    ["display_name", "status", "max_concurrency", "default_notify_key_id", "default_notify_events"],
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

  let defaultNotifyEvents: PushEventFilterKey[] | undefined;
  if (obj["default_notify_events"] !== undefined) {
    defaultNotifyEvents = parseEventFilter(obj["default_notify_events"]);
  }

  return {
    displayName,
    status,
    maxConcurrency,
    defaultNotifyKeyId,
    ...(defaultNotifyEvents !== undefined ? { defaultNotifyEvents } : {})
  };
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
  hasResult: boolean;
  result?: unknown;
  resultError: string;
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
      "error_message",
      "result",
      "result_error"
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
  const hasResult = Object.prototype.hasOwnProperty.call(obj, "result") && obj["result"] !== undefined;
  const result = hasResult ? obj["result"] : undefined;
  const resultError = asOptionalString(obj, "result_error", 4096) ?? "";
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
    errorMessage,
    hasResult,
    result,
    resultError
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

function parseAllowedBoardPrefixes(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new HubError(400, "BAD_REQUEST", "allowed_board_prefixes must be an array.");
  }
  if (raw.length > 100) {
    throw new HubError(400, "BAD_REQUEST", "allowed_board_prefixes exceeds max length 100.");
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      codePointLength(item) > 64 ||
      !BOARD_PREFIX_RE.test(item)
    ) {
      throw new HubError(400, "BAD_REQUEST", "Invalid channel prefix in allowed_board_prefixes.");
    }
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

export function parseCreateKeyRequest(raw: unknown): {
  name: string;
  scope: ApiScope;
  boundNodeId?: string;
  allowedNodes: string[];
  allowedBoardPrefixes: string[];
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
      "allowed_board_prefixes",
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
  const allowedBoardPrefixes =
    obj["allowed_board_prefixes"] !== undefined
      ? parseAllowedBoardPrefixes(obj["allowed_board_prefixes"])
      : [];
  if (allowedBoardPrefixes.length > 0 && scope !== "client") {
    throw new HubError(
      400,
      "BAD_REQUEST",
      "allowed_board_prefixes is only supported for client scope keys."
    );
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
    allowedBoardPrefixes,
    allowUnsandboxed,
    maxDepthLimit,
    webhookUrl,
    webhookKey: webhookKeyRaw || undefined
  };
}

export interface PatchKeyInput {
  boundNodeId?: string | null;
  allowedNodes?: string[];
  allowedBoardPrefixes?: string[];
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
      "allowed_board_prefixes",
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

  if (obj["allowed_board_prefixes"] !== undefined) {
    out.allowedBoardPrefixes = parseAllowedBoardPrefixes(obj["allowed_board_prefixes"]);
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
        status: statusRaw as Exclude<RunStatus, "waiting" | "queued" | "claimed">,
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

export interface ParsedListNativeEventsQuery {
  nodeId?: string;
  agent?: NativeEventAgentName;
  eventKind?: NativeEventKind;
  notifyStatus?: NativeEventNotifyStatus;
  unackedOnly: boolean;
  q?: string;
  limit: number;
  beforeTs?: string;
  beforeId?: string;
}

export function parseListNativeEventsQuery(searchParams: URLSearchParams): ParsedListNativeEventsQuery {
  const nodeId = searchParams.get("node_id")?.trim() || undefined;
  if (nodeId !== undefined && !NODE_ID_RE.test(nodeId)) {
    throw new HubError(400, "BAD_REQUEST", "Invalid node_id format.");
  }

  const agentRaw = searchParams.get("agent")?.trim() || undefined;
  let agent: NativeEventAgentName | undefined;
  if (agentRaw !== undefined) {
    if (!NATIVE_EVENT_AGENTS.has(agentRaw as NativeEventAgentName)) {
      throw new HubError(400, "BAD_REQUEST", `Unsupported agent '${agentRaw}'.`);
    }
    agent = agentRaw as NativeEventAgentName;
  }

  const kindRaw = searchParams.get("event_kind")?.trim() || undefined;
  let eventKind: NativeEventKind | undefined;
  if (kindRaw !== undefined) {
    if (!NATIVE_EVENT_KINDS.has(kindRaw as NativeEventKind)) {
      throw new HubError(400, "BAD_REQUEST", `Invalid event_kind '${kindRaw}'.`);
    }
    eventKind = kindRaw as NativeEventKind;
  }

  const statusRaw = searchParams.get("notify_status")?.trim() || undefined;
  let notifyStatus: NativeEventNotifyStatus | undefined;
  if (statusRaw !== undefined) {
    if (!NATIVE_NOTIFY_STATUSES.has(statusRaw as NativeEventNotifyStatus)) {
      throw new HubError(400, "BAD_REQUEST", `Invalid notify_status '${statusRaw}'.`);
    }
    notifyStatus = statusRaw as NativeEventNotifyStatus;
  }

  const unackedRaw = searchParams.get("unacked_only")?.trim();
  let unackedOnly = false;
  if (unackedRaw !== undefined && unackedRaw !== "") {
    if (unackedRaw === "true") {
      unackedOnly = true;
    } else if (unackedRaw === "false") {
      unackedOnly = false;
    } else {
      throw new HubError(400, "BAD_REQUEST", "Query 'unacked_only' must be 'true' or 'false'.");
    }
  }

  const qTrimmed = searchParams.get("q")?.trim();
  if (qTrimmed && qTrimmed.length > 256) {
    throw new HubError(400, "BAD_REQUEST", "Query 'q' exceeds max length 256.");
  }
  const q = qTrimmed || undefined;

  const limitRaw = searchParams.get("limit")?.trim();
  let limit = 50;
  if (limitRaw !== undefined && limitRaw !== "") {
    if (!/^-?\d+$/.test(limitRaw)) {
      throw new HubError(400, "BAD_REQUEST", "Query 'limit' must be an integer.");
    }
    const parsedLimit = Number.parseInt(limitRaw, 10);
    if (!Number.isSafeInteger(parsedLimit)) {
      throw new HubError(400, "BAD_REQUEST", "Query 'limit' must be a finite integer.");
    }
    limit = Math.min(Math.max(parsedLimit, 1), 100);
  }

  const beforeTs = searchParams.get("before_ts")?.trim() || undefined;
  if (beforeTs !== undefined) {
    if (beforeTs.length > 64 || Number.isNaN(Date.parse(beforeTs))) {
      throw new HubError(400, "BAD_REQUEST", "Query 'before_ts' must be a valid RFC 3339 timestamp.");
    }
  }

  const beforeId = searchParams.get("before_id")?.trim() || undefined;
  if (beforeId !== undefined) {
    if (!beforeTs) {
      throw new HubError(400, "BAD_REQUEST", "Query 'before_id' requires 'before_ts'.");
    }
    if (!NATIVE_EVENT_ROW_ID_RE.test(beforeId)) {
      throw new HubError(400, "BAD_REQUEST", "Invalid before_id format.");
    }
  }

  return {
    nodeId,
    agent,
    eventKind,
    notifyStatus,
    unackedOnly,
    q,
    limit,
    beforeTs,
    beforeId
  };
}

export function parseAckNativeEventRequest(raw: unknown): { scope: "single" | "session" } {
  if (raw === undefined || raw === null) {
    return { scope: "single" };
  }
  const obj = asRecord(raw, "AckNativeEventRequest");
  rejectUnknownKeys(obj, ["scope"], "AckNativeEventRequest");
  const scopeRaw = asOptionalString(obj, "scope");
  if (scopeRaw === undefined) {
    return { scope: "single" };
  }
  if (scopeRaw !== "single" && scopeRaw !== "session") {
    throw new HubError(400, "BAD_REQUEST", `Invalid ack scope '${scopeRaw}' (expected 'single' or 'session').`);
  }
  return { scope: scopeRaw };
}

export function parseRedeliverRequest(raw: unknown): { deliveryId?: string } {
  if (raw === undefined || raw === null) {
    return {};
  }
  const obj = asRecord(raw, "RedeliverRequest");
  rejectUnknownKeys(obj, ["delivery_id"], "RedeliverRequest");
  const deliveryId = asOptionalString(obj, "delivery_id", 128);
  if (deliveryId !== undefined) {
    const trimmed = deliveryId.trim();
    if (!DELIVERY_ID_RE.test(trimmed)) {
      throw new HubError(400, "BAD_REQUEST", "Invalid delivery_id format.");
    }
    return { deliveryId: trimmed };
  }
  return {};
}

export function parseIncludeRevokedQuery(searchParams: URLSearchParams): boolean {
  const raw = searchParams.get("include_revoked")?.trim();
  if (raw === undefined || raw === "") {
    return false;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new HubError(400, "BAD_REQUEST", "Query 'include_revoked' must be 'true' or 'false'.");
}

function parseNodeFilter(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new HubError(400, "BAD_REQUEST", "node_filter must be an array.");
  }
  if (raw.length > 100) {
    throw new HubError(400, "BAD_REQUEST", "node_filter exceeds max length 100.");
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || !NODE_ID_RE.test(item)) {
      throw new HubError(400, "BAD_REQUEST", "Invalid node ID in node_filter.");
    }
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function parseEventFilter(raw: unknown): PushEventFilterKey[] {
  if (!Array.isArray(raw)) {
    throw new HubError(400, "BAD_REQUEST", "event_filter must be an array.");
  }
  if (raw.length > 32) {
    throw new HubError(400, "BAD_REQUEST", "event_filter exceeds max length 32.");
  }
  const out: PushEventFilterKey[] = [];
  const seen = new Set<PushEventFilterKey>();
  for (const item of raw) {
    if (typeof item !== "string" || !PUSH_EVENT_FILTER_KEYS.has(item as PushEventFilterKey)) {
      throw new HubError(400, "BAD_REQUEST", `Invalid event filter key '${String(item)}'.`);
    }
    const key = item as PushEventFilterKey;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

export interface ParsedCreatePushSubscription {
  label: string;
  subscription: WebPushSubscriptionSecret;
  endpointHost: string;
  nodeFilter: string[];
  eventFilter: PushEventFilterKey[];
}

export function parseCreatePushSubscriptionRequest(
  raw: unknown,
  allowLoopbackForTest: boolean
): ParsedCreatePushSubscription {
  const obj = asRecord(raw, "CreatePushSubscriptionRequest");
  rejectUnknownKeys(
    obj,
    ["label", "subscription", "node_filter", "event_filter"],
    "CreatePushSubscriptionRequest"
  );
  const label = asRequiredString(obj, "label", 1, 128).trim();
  if (!label) {
    throw new HubError(400, "BAD_REQUEST", "Field 'label' must not be empty.");
  }

  const subObj = asRecord(obj["subscription"], "subscription");
  rejectUnknownKeys(subObj, ["endpoint", "keys"], "subscription");
  const endpointRaw = asRequiredString(subObj, "endpoint", 1, 2048);

  const keysObj = asRecord(subObj["keys"], "subscription.keys");
  rejectUnknownKeys(keysObj, ["p256dh", "auth"], "subscription.keys");
  const p256dh = asRequiredString(keysObj, "p256dh", 1, 256).trim();
  const auth = asRequiredString(keysObj, "auth", 1, 128).trim();

  let parsedUrl: URL;
  try {
    parsedUrl = validatePushEndpointUrl(endpointRaw, allowLoopbackForTest);
    validateSubscriptionKeys({ p256dh, auth });
  } catch (err) {
    throw new HubError(400, "BAD_REQUEST", err instanceof Error ? err.message : "Invalid push subscription.");
  }

  const nodeFilter = obj["node_filter"] !== undefined ? parseNodeFilter(obj["node_filter"]) : [];
  const eventFilter =
    obj["event_filter"] !== undefined
      ? parseEventFilter(obj["event_filter"])
      : [...DEFAULT_PUSH_EVENT_FILTER];

  return {
    label,
    subscription: {
      endpoint: parsedUrl.toString(),
      keys: { p256dh, auth }
    },
    endpointHost: parsedUrl.host,
    nodeFilter,
    eventFilter
  };
}

export interface ParsedPatchPushSubscription {
  label?: string;
  enabled?: boolean;
  nodeFilter?: string[];
  eventFilter?: PushEventFilterKey[];
}

export function parsePatchPushSubscriptionRequest(raw: unknown): ParsedPatchPushSubscription {
  const obj = asRecord(raw, "PatchPushSubscriptionRequest");
  rejectUnknownKeys(
    obj,
    ["label", "enabled", "node_filter", "event_filter"],
    "PatchPushSubscriptionRequest"
  );
  if (Object.keys(obj).length === 0) {
    throw new HubError(400, "BAD_REQUEST", "PatchPushSubscriptionRequest must specify at least one field.");
  }

  const out: ParsedPatchPushSubscription = {};
  if (obj["label"] !== undefined) {
    const label = asRequiredString(obj, "label", 1, 128).trim();
    if (!label) {
      throw new HubError(400, "BAD_REQUEST", "Field 'label' must not be empty.");
    }
    out.label = label;
  }
  const enabled = asOptionalBoolean(obj, "enabled");
  if (enabled !== undefined) {
    out.enabled = enabled;
  }
  if (obj["node_filter"] !== undefined) {
    out.nodeFilter = parseNodeFilter(obj["node_filter"]);
  }
  if (obj["event_filter"] !== undefined) {
    out.eventFilter = parseEventFilter(obj["event_filter"]);
  }
  return out;
}

function assertBoardChannelFormat(channel: string, fieldName = "channel"): string {
  if (codePointLength(channel) < 1 || codePointLength(channel) > 64 || !BOARD_CHANNEL_RE.test(channel)) {
    throw new HubError(
      400,
      "BAD_REQUEST",
      `Invalid ${fieldName} '${channel}': must match ^[a-z0-9][a-z0-9_-]*(/[a-z0-9][a-z0-9_-]*)*$ (1..64 chars).`
    );
  }
  return channel;
}

function parseBoardLabels(raw: unknown, fieldName = "labels"): Record<string, string> {
  const obj = asRecord(raw, fieldName);
  const entries = Object.entries(obj);
  if (entries.length > 16) {
    throw new HubError(400, "BAD_REQUEST", `Field '${fieldName}' exceeds maxProperties 16.`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    const kLen = codePointLength(k);
    if (kLen < 1 || kLen > 64) {
      throw new HubError(400, "BAD_REQUEST", `Label key '${k}' must have 1..64 characters.`);
    }
    if (typeof v !== "string") {
      throw new HubError(400, "BAD_REQUEST", `Label '${k}' value must be a string.`);
    }
    if (codePointLength(v) > 128) {
      throw new HubError(400, "BAD_REQUEST", `Label '${k}' value exceeds max length 128.`);
    }
    out[k] = v;
  }
  return out;
}

function parseBoardTopicStatusValue(raw: string, fieldName = "status"): BoardTopicStatus {
  if (!BOARD_TOPIC_STATUSES.has(raw as BoardTopicStatus)) {
    throw new HubError(400, "BAD_REQUEST", `Invalid ${fieldName} '${raw}'.`);
  }
  return raw as BoardTopicStatus;
}

export interface ParsedCreateBoardTopic {
  channel: string;
  title: string;
  externalRef: string;
  status: BoardTopicStatus;
  pinned: boolean;
  labels: Record<string, string>;
  upsert: boolean;
}

export function parseCreateBoardTopicRequest(raw: unknown): ParsedCreateBoardTopic {
  const obj = asRecord(raw, "CreateBoardTopicRequest");
  rejectUnknownKeys(
    obj,
    ["channel", "title", "external_ref", "status", "pinned", "labels", "upsert"],
    "CreateBoardTopicRequest"
  );
  const channel = assertBoardChannelFormat(asRequiredString(obj, "channel", 1));
  const title = asRequiredString(obj, "title", 1);
  if (codePointLength(title) < 1 || codePointLength(title) > 200) {
    throw new HubError(400, "BAD_REQUEST", "Field 'title' must have 1..200 characters.");
  }
  const externalRef = asOptionalString(obj, "external_ref") ?? "";
  if (codePointLength(externalRef) > 200) {
    throw new HubError(400, "BAD_REQUEST", "Field 'external_ref' exceeds max length 200.");
  }
  const statusRaw = asOptionalString(obj, "status");
  const status = statusRaw !== undefined ? parseBoardTopicStatusValue(statusRaw, "status") : "todo";
  const pinned = asOptionalBoolean(obj, "pinned") ?? false;
  const labels = obj["labels"] !== undefined ? parseBoardLabels(obj["labels"]) : {};
  const upsert = asOptionalBoolean(obj, "upsert") ?? false;
  return {
    channel,
    title,
    externalRef,
    status,
    pinned,
    labels,
    upsert
  };
}

export interface ParsedPatchBoardTopic {
  title?: string;
  status?: BoardTopicStatus;
  pinned?: boolean;
  sortOrder?: number;
  labels?: Record<string, string>;
}

export function parsePatchBoardTopicRequest(raw: unknown): ParsedPatchBoardTopic {
  const obj = asRecord(raw, "PatchBoardTopicRequest");
  rejectUnknownKeys(
    obj,
    ["title", "status", "pinned", "sort_order", "labels"],
    "PatchBoardTopicRequest"
  );
  if (Object.keys(obj).length === 0) {
    throw new HubError(400, "BAD_REQUEST", "PatchBoardTopicRequest must specify at least one field.");
  }
  const out: ParsedPatchBoardTopic = {};
  if (obj["title"] !== undefined) {
    const title = asRequiredString(obj, "title", 1);
    if (codePointLength(title) < 1 || codePointLength(title) > 200) {
      throw new HubError(400, "BAD_REQUEST", "Field 'title' must have 1..200 characters.");
    }
    out.title = title;
  }
  const statusRaw = asOptionalString(obj, "status");
  if (statusRaw !== undefined) {
    out.status = parseBoardTopicStatusValue(statusRaw, "status");
  }
  const pinned = asOptionalBoolean(obj, "pinned");
  if (pinned !== undefined) {
    out.pinned = pinned;
  }
  const sortOrder = asOptionalNumber(obj, "sort_order");
  if (sortOrder !== undefined) {
    out.sortOrder = sortOrder;
  }
  if (obj["labels"] !== undefined) {
    out.labels = parseBoardLabels(obj["labels"]);
  }
  return out;
}

export interface ParsedReorderBoardTopics {
  channel: string;
  status: BoardTopicStatus;
  orderedTopicIds: string[];
}

export function parseReorderBoardTopicsRequest(raw: unknown): ParsedReorderBoardTopics {
  const obj = asRecord(raw, "ReorderBoardTopicsRequest");
  rejectUnknownKeys(
    obj,
    ["channel", "status", "ordered_topic_ids"],
    "ReorderBoardTopicsRequest"
  );
  const channel = assertBoardChannelFormat(asRequiredString(obj, "channel", 1));
  const status = parseBoardTopicStatusValue(asRequiredString(obj, "status", 1), "status");
  const rawIds = obj["ordered_topic_ids"];
  if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > 500) {
    throw new HubError(400, "BAD_REQUEST", "ordered_topic_ids must be an array of 1..500 topic IDs.");
  }
  const seen = new Set<string>();
  const orderedTopicIds: string[] = [];
  for (const item of rawIds) {
    if (typeof item !== "string" || !BOARD_TOPIC_ID_RE.test(item)) {
      throw new HubError(400, "BAD_REQUEST", "ordered_topic_ids must contain valid topic IDs.");
    }
    if (seen.has(item)) {
      throw new HubError(400, "BAD_REQUEST", `Duplicate topic_id '${item}' in ordered_topic_ids.`);
    }
    seen.add(item);
    orderedTopicIds.push(item);
  }
  return { channel, status, orderedTopicIds };
}

export interface ParsedCreateBoardMessage {
  kind: Exclude<BoardMessageKind, "answer">;
  textMd: string;
  data: Record<string, unknown>;
  actorProfile: string;
  sourceNode: string;
  topicStatus?: BoardTopicStatus;
  questionOptions: string[];
  questionExpiresSec: number;
  idempotencyKey?: string;
}

export function parseCreateBoardMessageRequest(raw: unknown): ParsedCreateBoardMessage {
  const obj = asRecord(raw, "CreateBoardMessageRequest");
  rejectUnknownKeys(
    obj,
    [
      "kind",
      "text_md",
      "data",
      "actor_profile",
      "source_node",
      "topic_status",
      "question_options",
      "question_expires_sec",
      "idempotency_key"
    ],
    "CreateBoardMessageRequest"
  );
  const kindRaw = asRequiredString(obj, "kind", 1);
  if (!BOARD_POSTABLE_KINDS.has(kindRaw as Exclude<BoardMessageKind, "answer">)) {
    throw new HubError(
      400,
      "BAD_REQUEST",
      `Invalid message kind '${kindRaw}' (expected note, handoff, question, or artifact).`
    );
  }
  const kind = kindRaw as Exclude<BoardMessageKind, "answer">;
  const textMd = asRequiredString(obj, "text_md", 1);
  if (codePointLength(textMd) > 8192) {
    throw new HubError(400, "BAD_REQUEST", "Field 'text_md' exceeds max length 8192 characters.");
  }

  let data: Record<string, unknown> = {};
  if (obj["data"] !== undefined) {
    data = asRecord(obj["data"], "data");
    if (utf8ByteLength(JSON.stringify(data)) > 32768) {
      throw new HubError(400, "BAD_REQUEST", "Field 'data' exceeds max size 32768 UTF-8 bytes.");
    }
  }

  const actorProfileRaw = asOptionalString(obj, "actor_profile");
  if (
    actorProfileRaw !== undefined &&
    (codePointLength(actorProfileRaw) < 1 ||
      codePointLength(actorProfileRaw) > 40 ||
      !ACTOR_PROFILE_RE.test(actorProfileRaw))
  ) {
    throw new HubError(400, "BAD_REQUEST", "Invalid actor_profile format.");
  }
  const actorProfile = actorProfileRaw ?? "";

  const sourceNodeRaw = asOptionalString(obj, "source_node");
  if (
    sourceNodeRaw !== undefined &&
    (codePointLength(sourceNodeRaw) < 1 ||
      codePointLength(sourceNodeRaw) > 64 ||
      !NODE_ID_RE.test(sourceNodeRaw))
  ) {
    throw new HubError(400, "BAD_REQUEST", "Invalid source_node format.");
  }
  const sourceNode = sourceNodeRaw ?? "";

  const topicStatusRaw = asOptionalString(obj, "topic_status");
  const topicStatus =
    topicStatusRaw !== undefined ? parseBoardTopicStatusValue(topicStatusRaw, "topic_status") : undefined;

  const questionOptions: string[] = [];
  if (obj["question_options"] !== undefined) {
    if (!Array.isArray(obj["question_options"])) {
      throw new HubError(400, "BAD_REQUEST", "question_options must be an array.");
    }
    if (obj["question_options"].length > 8) {
      throw new HubError(400, "BAD_REQUEST", "question_options exceeds maxItems 8.");
    }
    for (const item of obj["question_options"]) {
      if (typeof item !== "string") {
        throw new HubError(400, "BAD_REQUEST", "question_options items must be strings.");
      }
      const len = codePointLength(item);
      if (len < 1 || len > 200) {
        throw new HubError(400, "BAD_REQUEST", "Each question_options item must have 1..200 characters.");
      }
      questionOptions.push(item);
    }
  }

  const questionExpiresSec = asOptionalInt(obj, "question_expires_sec", 600, 259200) ?? 86400;

  const idempotencyKey = asOptionalString(obj, "idempotency_key");
  if (
    idempotencyKey !== undefined &&
    (codePointLength(idempotencyKey) < 8 || codePointLength(idempotencyKey) > 128)
  ) {
    throw new HubError(400, "BAD_REQUEST", "idempotency_key must have length 8..128.");
  }

  return {
    kind,
    textMd,
    data,
    actorProfile,
    sourceNode,
    topicStatus,
    questionOptions,
    questionExpiresSec,
    idempotencyKey
  };
}

export interface ParsedAnswerBoardQuestion {
  selectedOption?: string;
  answerText?: string;
  actorProfile: string;
}

export function parseAnswerBoardQuestionRequest(raw: unknown): ParsedAnswerBoardQuestion {
  const obj = asRecord(raw, "AnswerBoardQuestionRequest");
  rejectUnknownKeys(
    obj,
    ["selected_option", "answer_text", "actor_profile"],
    "AnswerBoardQuestionRequest"
  );
  const selectedOption = asOptionalString(obj, "selected_option");
  if (selectedOption !== undefined) {
    const len = codePointLength(selectedOption);
    if (len < 1 || len > 200) {
      throw new HubError(400, "BAD_REQUEST", "Field 'selected_option' must have 1..200 characters.");
    }
  }
  const answerText = asOptionalString(obj, "answer_text");
  if (answerText !== undefined) {
    const len = codePointLength(answerText);
    if (len < 1 || len > 8192) {
      throw new HubError(400, "BAD_REQUEST", "Field 'answer_text' must have 1..8192 characters.");
    }
  }
  if (selectedOption === undefined && answerText === undefined) {
    throw new HubError(
      400,
      "BAD_REQUEST",
      "AnswerBoardQuestionRequest requires 'selected_option' or 'answer_text'."
    );
  }
  const actorProfileRaw = asOptionalString(obj, "actor_profile");
  if (
    actorProfileRaw !== undefined &&
    (codePointLength(actorProfileRaw) < 1 ||
      codePointLength(actorProfileRaw) > 40 ||
      !ACTOR_PROFILE_RE.test(actorProfileRaw))
  ) {
    throw new HubError(400, "BAD_REQUEST", "Invalid actor_profile format.");
  }
  const actorProfile = actorProfileRaw ?? "";
  return {
    selectedOption,
    answerText,
    actorProfile
  };
}

export interface ParsedListBoardTopicsQuery {
  channel?: string;
  externalRef?: string;
  status?: BoardTopicStatus;
  hasOpenQuestion?: boolean;
  q?: string;
  sort: "recent" | "order";
  limit: number;
}

export function parseListBoardTopicsQuery(searchParams: URLSearchParams): ParsedListBoardTopicsQuery {
  const channelRaw = searchParams.get("channel")?.trim();
  const channel = channelRaw ? assertBoardChannelFormat(channelRaw, "channel") : undefined;

  const externalRefRaw = searchParams.get("external_ref")?.trim();
  if (externalRefRaw && codePointLength(externalRefRaw) > 200) {
    throw new HubError(400, "BAD_REQUEST", "Query 'external_ref' exceeds max length 200.");
  }
  const externalRef = externalRefRaw || undefined;

  const statusRaw = searchParams.get("status")?.trim();
  const status = statusRaw ? parseBoardTopicStatusValue(statusRaw, "status") : undefined;

  const hasOpenRaw = searchParams.get("has_open_question")?.trim();
  let hasOpenQuestion: boolean | undefined;
  if (hasOpenRaw !== undefined && hasOpenRaw !== "") {
    if (hasOpenRaw === "true") hasOpenQuestion = true;
    else if (hasOpenRaw === "false") hasOpenQuestion = false;
    else throw new HubError(400, "BAD_REQUEST", "Query 'has_open_question' must be 'true' or 'false'.");
  }

  const qRaw = searchParams.get("q")?.trim();
  if (qRaw && qRaw.length > 256) {
    throw new HubError(400, "BAD_REQUEST", "Query 'q' exceeds max length 256.");
  }
  const q = qRaw || undefined;

  const sortRaw = searchParams.get("sort")?.trim() || "recent";
  if (sortRaw !== "recent" && sortRaw !== "order") {
    throw new HubError(400, "BAD_REQUEST", "Query 'sort' must be 'recent' or 'order'.");
  }

  const limitRaw = searchParams.get("limit")?.trim();
  let limit = 50;
  if (limitRaw !== undefined && limitRaw !== "") {
    if (!/^-?\d+$/.test(limitRaw)) {
      throw new HubError(400, "BAD_REQUEST", "Query 'limit' must be an integer.");
    }
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isSafeInteger(parsed)) {
      throw new HubError(400, "BAD_REQUEST", "Query 'limit' must be a finite integer.");
    }
    limit = Math.min(Math.max(parsed, 1), 200);
  }

  return {
    channel,
    externalRef,
    status,
    hasOpenQuestion,
    q,
    sort: sortRaw,
    limit
  };
}

export function parseListBoardMessagesQuery(searchParams: URLSearchParams): {
  afterSeq: number;
  limit: number;
} {
  const afterSeqRaw = searchParams.get("after_seq")?.trim();
  let afterSeq = 0;
  if (afterSeqRaw !== undefined && afterSeqRaw !== "") {
    if (!/^\d+$/.test(afterSeqRaw)) {
      throw new HubError(400, "BAD_REQUEST", "Query 'after_seq' must be a non-negative integer.");
    }
    const parsed = Number.parseInt(afterSeqRaw, 10);
    if (!Number.isSafeInteger(parsed)) {
      throw new HubError(400, "BAD_REQUEST", "Query 'after_seq' must be a finite integer.");
    }
    afterSeq = parsed;
  }

  const limitRaw = searchParams.get("limit")?.trim();
  let limit = 50;
  if (limitRaw !== undefined && limitRaw !== "") {
    if (!/^-?\d+$/.test(limitRaw)) {
      throw new HubError(400, "BAD_REQUEST", "Query 'limit' must be an integer.");
    }
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isSafeInteger(parsed)) {
      throw new HubError(400, "BAD_REQUEST", "Query 'limit' must be a finite integer.");
    }
    limit = Math.min(Math.max(parsed, 1), 200);
  }

  return { afterSeq, limit };
}

export function parseListBoardEventsQuery(searchParams: URLSearchParams): {
  channel?: string;
  topicId?: string;
  afterCursor: number;
  limit: number;
} {
  const channelRaw = searchParams.get("channel")?.trim();
  const channel = channelRaw ? assertBoardChannelFormat(channelRaw, "channel") : undefined;

  const topicIdRaw = searchParams.get("topic_id")?.trim();
  let topicId: string | undefined;
  if (topicIdRaw) {
    if (!BOARD_TOPIC_ID_RE.test(topicIdRaw)) {
      throw new HubError(400, "BAD_REQUEST", "Invalid topic_id format.");
    }
    topicId = topicIdRaw;
  }

  const afterCursorRaw = searchParams.get("after_cursor")?.trim();
  let afterCursor = 0;
  if (afterCursorRaw !== undefined && afterCursorRaw !== "") {
    if (!/^\d+$/.test(afterCursorRaw)) {
      throw new HubError(400, "BAD_REQUEST", "Query 'after_cursor' must be a non-negative integer.");
    }
    const parsed = Number.parseInt(afterCursorRaw, 10);
    if (!Number.isSafeInteger(parsed)) {
      throw new HubError(400, "BAD_REQUEST", "Query 'after_cursor' must be a finite integer.");
    }
    afterCursor = parsed;
  }

  const limitRaw = searchParams.get("limit")?.trim();
  let limit = 100;
  if (limitRaw !== undefined && limitRaw !== "") {
    if (!/^-?\d+$/.test(limitRaw)) {
      throw new HubError(400, "BAD_REQUEST", "Query 'limit' must be an integer.");
    }
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isSafeInteger(parsed)) {
      throw new HubError(400, "BAD_REQUEST", "Query 'limit' must be a finite integer.");
    }
    limit = Math.min(Math.max(parsed, 1), 200);
  }

  return { channel, topicId, afterCursor, limit };
}
