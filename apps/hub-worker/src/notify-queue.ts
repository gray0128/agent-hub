import {
  getDeliveryById,
  getNativeEventById,
  getNativeNotifyCooldownSec,
  hasRecentNonUrgentSessionDelivery,
  mapRunRow,
  parseNotifyPolicy,
  parseStringArray,
  recomputeSourceNotifyStatus,
  type RunRow
} from "./db";
import { buildPromptPreview, redactSecrets } from "./redact";
import {
  type ApiScope,
  type DeliveryNotifyQueueMessage,
  type DeliveriesSummary,
  type DeliverySourceKind,
  type Env,
  type NativeEventNotifyQueueMessage,
  type NotifyQueueMessage,
  type RunNotifyQueueMessage,
  type WebPushSubscriptionSecret
} from "./types";
import { nowIso } from "./ulid";
import {
  getVapidConfig,
  isLoopbackPushAllowed,
  sendWebPushNotification,
  type WebPushNotificationPayload
} from "./web-push";
import { decryptJsonSecret, decryptWebhookConfig } from "./webhook-crypto";

interface RunWebhookRow {
  id: string;
  thread_id: string;
  root_run_id: string;
  node_id: string;
  workdir: string;
  agent: string;
  status: string;
  prompt: string | null;
  resolved_model: string;
  resolved_effort: string;
  native_session_id: string | null;
  duration_ms: number;
  remote_control_url: string;
  summary: string;
  error_message?: string;
  output_bytes: number;
  notify_policy_json?: string;
  created_by_key_id: string | null;
  key_scope: ApiScope | null;
  key_revoked_at: string | null;
  key_webhook_ciphertext: string | null;
  node_default_key_id: string | null;
  node_key_scope: ApiScope | null;
  node_key_revoked_at: string | null;
  node_key_allowed_nodes_json: string | null;
  node_key_webhook_ciphertext: string | null;
}

interface NativeEventWebhookRow {
  id: string;
  node_id: string;
  event_id: string;
  agent: string;
  event_kind: string;
  native_session_id: string;
  workdir: string;
  title: string;
  summary: string;
  source: string;
  notify_key_id: string | null;
  created_at: string;
  node_default_key_id: string | null;
  node_key_scope: ApiScope | null;
  node_key_revoked_at: string | null;
  node_key_allowed_nodes_json: string | null;
  node_key_webhook_ciphertext: string | null;
}

interface BoardMessageWebhookRow {
  id: string;
  topic_id: string;
  channel: string;
  actor_profile: string;
  source_node: string;
  text_md: string;
  question_options_json: string;
  question_expires_at: string | null;
  created_at: string;
  topic_title: string;
  node_default_key_id: string | null;
  node_key_scope: ApiScope | null;
  node_key_revoked_at: string | null;
  node_key_allowed_nodes_json: string | null;
  node_key_webhook_ciphertext: string | null;
}

interface WebPushSubscriptionDbRow {
  id: string;
  label: string;
  endpoint_host: string;
  subscription_ciphertext: string;
  enabled: number;
  revoked_at: string | null;
}

interface ResolvedWebhookTarget {
  url: string;
  key?: string;
}

function keyAllowsNode(allowedNodesJson: string | null | undefined, nodeId: string): boolean {
  if (!allowedNodesJson) return true;
  try {
    const parsed = JSON.parse(allowedNodesJson);
    if (Array.isArray(parsed)) {
      const list = parsed.filter((x): x is string => typeof x === "string");
      return list.length === 0 || list.includes(nodeId);
    }
  } catch {
    return false;
  }
  return true;
}

async function resolveNodeDefaultWebhook(
  label: string,
  nodeId: string,
  expectedKeyId: string | null,
  nodeDefaultKeyId: string | null,
  keyScope: ApiScope | null,
  keyRevokedAt: string | null,
  keyAllowedNodesJson: string | null,
  keyCiphertext: string | null,
  env: Env
): Promise<ResolvedWebhookTarget | null> {
  if (!nodeDefaultKeyId) {
    console.warn(`[notify] fail-closed for ${label}: node=${nodeId} default notify channel is unbound`);
    return null;
  }
  if (expectedKeyId && expectedKeyId !== nodeDefaultKeyId) {
    console.warn(`[notify] fail-closed for ${label}: node=${nodeId} bound channel changed`);
    return null;
  }
  if (keyScope !== "client" || keyRevokedAt !== null) {
    console.warn(`[notify] fail-closed for ${label}: bound channel key is revoked or non-client`);
    return null;
  }
  if (!keyAllowsNode(keyAllowedNodesJson, nodeId)) {
    console.warn(`[notify] fail-closed for ${label}: bound channel key no longer allows node=${nodeId}`);
    return null;
  }
  const ciphertext = keyCiphertext?.trim() ?? "";
  if (!ciphertext) {
    console.warn(`[notify] fail-closed for ${label}: bound channel key has no webhook`);
    return null;
  }
  try {
    return await decryptWebhookConfig(env.WEBHOOK_ENCRYPTION_KEY ?? "", ciphertext);
  } catch (err) {
    console.warn(
      `[notify] fail-closed decrypting node-bound webhook for ${label}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}

function resolveGlobalLegacyWebhook(target: "grok" | "webhook", env: Env): ResolvedWebhookTarget | null {
  const fallbackUrl =
    target === "grok"
      ? env.GROK_WEBHOOK_URL?.trim()
      : (env.WEBHOOK_URL?.trim() || env.GROK_WEBHOOK_URL?.trim());
  if (!fallbackUrl) {
    return null;
  }
  const fallbackKey =
    target === "grok"
      ? env.GROK_WEBHOOK_KEY?.trim()
      : (env.WEBHOOK_KEY?.trim() || env.GROK_WEBHOOK_KEY?.trim());
  return {
    url: fallbackUrl,
    ...(fallbackKey ? { key: fallbackKey } : {})
  };
}

async function resolveRunWebhookTarget(
  row: RunWebhookRow,
  body: RunNotifyQueueMessage,
  env: Env
): Promise<ResolvedWebhookTarget | null> {
  const isClientKey = Boolean(row.created_by_key_id) && row.key_scope !== "admin";
  const routeMode =
    body.route_mode ??
    (isClientKey ? "key" : row.node_default_key_id ? "node_default" : "global_legacy");

  if (routeMode === "node_default") {
    return resolveNodeDefaultWebhook(
      `run=${row.id}`,
      row.node_id,
      null,
      row.node_default_key_id ?? null,
      row.node_key_scope ?? null,
      row.node_key_revoked_at ?? null,
      row.node_key_allowed_nodes_json ?? null,
      row.node_key_webhook_ciphertext ?? null,
      env
    );
  }

  if (row.created_by_key_id && row.key_revoked_at !== null) {
    console.warn(`[notify] skipping webhook for run=${row.id}: issuing key is revoked`);
    return null;
  }

  if (routeMode === "key") {
    const ciphertext = row.key_webhook_ciphertext?.trim() ?? "";
    if (ciphertext) {
      try {
        return await decryptWebhookConfig(env.WEBHOOK_ENCRYPTION_KEY ?? "", ciphertext);
      } catch (err) {
        console.warn(
          `[notify] fail-closed decrypting per-key webhook for run=${row.id}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return null;
      }
    }
    if (row.created_by_key_id) {
      return null;
    }
  }

  return resolveGlobalLegacyWebhook(body.target === "grok" ? "grok" : "webhook", env);
}

async function deliverWebhookPost(
  resolved: ResolvedWebhookTarget,
  payload: unknown
): Promise<{ ok: boolean; httpStatus: number | null; errorMessage: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (resolved.key) {
    headers["Authorization"] = `Bearer ${resolved.key}`;
  }
  try {
    const resp = await fetch(resolved.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    if (resp.ok) {
      await resp.body?.cancel().catch(() => undefined);
      return { ok: true, httpStatus: resp.status, errorMessage: "" };
    }
    const text = await resp.text().catch(() => "");
    return {
      ok: false,
      httpStatus: resp.status,
      errorMessage: text.trim().slice(0, 300) || `Webhook returned HTTP ${resp.status}.`
    };
  } catch (err) {
    return {
      ok: false,
      httpStatus: null,
      errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300)
    };
  }
}

function buildRunWebhookPayload(row: RunWebhookRow, env: Env): Record<string, unknown> {
  const { promptPreview, promptTruncated } = buildPromptPreview(row.prompt ?? "", 1200);
  return {
    event: "ahub_run_completed",
    hub_url: env.HUB_PUBLIC_URL || "https://ahub.bobocai.win",
    run_id: row.id,
    thread_id: row.thread_id,
    root_run_id: row.root_run_id,
    node_id: row.node_id,
    workdir: row.workdir,
    agent: row.agent,
    status: row.status,
    resolved_model: row.resolved_model,
    resolved_effort: row.resolved_effort,
    native_session_id: row.native_session_id ?? "",
    duration_ms: row.duration_ms,
    remote_control_url: row.remote_control_url,
    prompt_preview: promptPreview,
    prompt_truncated: promptTruncated,
    summary: row.summary,
    output_bytes: row.output_bytes,
    fetch_full_cmd: `ahub result ${row.id} --full --json`
  };
}

function buildNativeEventWebhookPayload(row: NativeEventWebhookRow, env: Env): Record<string, unknown> {
  return {
    event: "ahub_native_event",
    hub_url: env.HUB_PUBLIC_URL || "https://ahub.bobocai.win",
    native_event_id: row.id,
    event_id: row.event_id,
    node_id: row.node_id,
    agent: row.agent,
    event_kind: row.event_kind,
    native_session_id: row.native_session_id,
    workdir: row.workdir,
    title: redactSecrets(row.title),
    summary: redactSecrets(row.summary),
    source: row.source,
    action_required: "notify_user_only",
    created_at: row.created_at
  };
}

function buildBoardQuestionWebhookPayload(row: BoardMessageWebhookRow, env: Env): Record<string, unknown> {
  return {
    event: "ahub_board_question",
    hub_url: env.HUB_PUBLIC_URL || "https://ahub.bobocai.win",
    topic_id: row.topic_id,
    topic_title: redactSecrets(row.topic_title),
    channel: row.channel,
    message_id: row.id,
    actor_profile: row.actor_profile,
    source_node: row.source_node,
    text_md: redactSecrets(row.text_md),
    question_options: parseStringArray(row.question_options_json).map((opt) => redactSecrets(opt)),
    question_expires_at: row.question_expires_at,
    action_required: "answer_board_question",
    created_at: row.created_at
  };
}

async function doBroadcast(env: Env, path: string, payload: unknown): Promise<void> {
  if (!env.NODE_HUB) return;
  try {
    const id = env.NODE_HUB.idFromName("global");
    const stub = env.NODE_HUB.get(id);
    await stub.fetch(`https://node-hub${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.warn(`[notify] DO broadcast ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function broadcastDeliveryAndParent(
  env: Env,
  deliveryId: string,
  sourceKind: DeliverySourceKind,
  sourceId: string,
  deliveriesSummary?: DeliveriesSummary
): Promise<void> {
  if (!env.NODE_HUB) return;
  const freshDelivery = await getDeliveryById(env.DB, deliveryId);
  if (freshDelivery) {
    await doBroadcast(env, "/internal/broadcast-delivery", { delivery: freshDelivery });
  }
  if (!deliveriesSummary) return;

  if (sourceKind === "run") {
    const freshRun = await env.DB.prepare(`SELECT * FROM runs WHERE id = ?1 LIMIT 1`)
      .bind(sourceId)
      .first<RunRow>();
    if (freshRun) {
      await doBroadcast(env, "/internal/broadcast-run", {
        run: mapRunRow(freshRun, {
          view: "summary",
          tailBytes: 16384,
          promptMode: "preview",
          deliveriesSummary
        })
      });
    }
    return;
  }

  if (sourceKind === "native_event") {
    const freshEvent = await getNativeEventById(env.DB, sourceId);
    if (freshEvent) {
      await doBroadcast(env, "/internal/broadcast-native-event", { event: freshEvent });
    }
  }
}

async function loadRunWebhookRow(db: D1Database, runId: string): Promise<RunWebhookRow | null> {
  return db
    .prepare(
      `SELECT r.id, r.thread_id, r.root_run_id, r.node_id, r.workdir, r.agent, r.status,
              r.prompt, r.resolved_model, r.resolved_effort, r.native_session_id, r.duration_ms,
              r.remote_control_url, r.summary, r.error_message, r.output_bytes, r.notify_policy_json,
              r.created_by_key_id,
              k.scope AS key_scope,
              k.revoked_at AS key_revoked_at,
              k.notify_webhook_ciphertext AS key_webhook_ciphertext,
              n.default_notify_key_id AS node_default_key_id,
              nk.scope AS node_key_scope,
              nk.revoked_at AS node_key_revoked_at,
              nk.allowed_nodes_json AS node_key_allowed_nodes_json,
              nk.notify_webhook_ciphertext AS node_key_webhook_ciphertext
       FROM runs r
       LEFT JOIN api_keys k ON k.id = r.created_by_key_id
       LEFT JOIN nodes n ON n.id = r.node_id
       LEFT JOIN api_keys nk ON nk.id = n.default_notify_key_id
       WHERE r.id = ?1
       LIMIT 1`
    )
    .bind(runId)
    .first<RunWebhookRow>();
}

async function loadNativeEventWebhookRow(
  db: D1Database,
  nativeEventId: string
): Promise<NativeEventWebhookRow | null> {
  return db
    .prepare(
      `SELECT e.id, e.node_id, e.event_id, e.agent, e.event_kind, e.native_session_id,
              e.workdir, e.title, e.summary, e.source, e.notify_key_id, e.created_at,
              n.default_notify_key_id AS node_default_key_id,
              nk.scope AS node_key_scope,
              nk.revoked_at AS node_key_revoked_at,
              nk.allowed_nodes_json AS node_key_allowed_nodes_json,
              nk.notify_webhook_ciphertext AS node_key_webhook_ciphertext
       FROM native_events e
       LEFT JOIN nodes n ON n.id = e.node_id
       LEFT JOIN api_keys nk ON nk.id = n.default_notify_key_id
       WHERE e.id = ?1
       LIMIT 1`
    )
    .bind(nativeEventId)
    .first<NativeEventWebhookRow>();
}

async function loadBoardMessageWebhookRow(
  db: D1Database,
  messageId: string
): Promise<BoardMessageWebhookRow | null> {
  return db
    .prepare(
      `SELECT m.id, m.topic_id, m.channel, m.actor_profile, m.source_node, m.text_md,
              m.question_options_json, m.question_expires_at, m.created_at,
              t.title AS topic_title,
              n.default_notify_key_id AS node_default_key_id,
              nk.scope AS node_key_scope,
              nk.revoked_at AS node_key_revoked_at,
              nk.allowed_nodes_json AS node_key_allowed_nodes_json,
              nk.notify_webhook_ciphertext AS node_key_webhook_ciphertext
       FROM board_messages m
       JOIN board_topics t ON t.id = m.topic_id
       LEFT JOIN nodes n ON n.id = m.source_node
       LEFT JOIN api_keys nk ON nk.id = n.default_notify_key_id
       WHERE m.id = ?1
       LIMIT 1`
    )
    .bind(messageId)
    .first<BoardMessageWebhookRow>();
}

async function markDeliveryFailedAndAck(
  message: Message<NotifyQueueMessage>,
  env: Env,
  delivery: { id: string; source_kind: DeliverySourceKind; source_id: string },
  attempts: number,
  httpStatus: number | null,
  errorCode: string,
  errorMessage: string
): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE notification_deliveries
     SET status = 'failed', attempts = ?1, http_status = ?2, error_code = ?3, error_message = ?4, updated_at = ?5
     WHERE id = ?6`
  )
    .bind(attempts, httpStatus, errorCode, errorMessage.slice(0, 300), now, delivery.id)
    .run();
  const agg = await recomputeSourceNotifyStatus(env.DB, delivery.source_kind, delivery.source_id);
  await broadcastDeliveryAndParent(env, delivery.id, delivery.source_kind, delivery.source_id, agg.deliveriesSummary);
  message.ack();
}

async function processDeliveryWebhook(
  message: Message<NotifyQueueMessage>,
  delivery: {
    id: string;
    source_kind: DeliverySourceKind;
    source_id: string;
    route_mode: string;
    channel_id: string;
    attempts: number;
  },
  env: Env
): Promise<void> {
  const nextAttempts = delivery.attempts + 1;
  let resolved: ResolvedWebhookTarget | null = null;
  let payload: Record<string, unknown> | null = null;

  if (delivery.source_kind === "run") {
    const row = await loadRunWebhookRow(env.DB, delivery.source_id);
    if (!row) {
      message.ack();
      return;
    }
    if (delivery.route_mode === "key") {
      if (row.created_by_key_id === delivery.channel_id && row.key_revoked_at === null) {
        const ciphertext = row.key_webhook_ciphertext?.trim() ?? "";
        if (ciphertext) {
          try {
            resolved = await decryptWebhookConfig(env.WEBHOOK_ENCRYPTION_KEY ?? "", ciphertext);
          } catch {
            resolved = null;
          }
        }
      }
    } else if (delivery.route_mode === "node_default") {
      resolved = await resolveNodeDefaultWebhook(
        `run=${row.id}`,
        row.node_id,
        delivery.channel_id,
        row.node_default_key_id ?? null,
        row.node_key_scope ?? null,
        row.node_key_revoked_at ?? null,
        row.node_key_allowed_nodes_json ?? null,
        row.node_key_webhook_ciphertext ?? null,
        env
      );
    } else if (delivery.route_mode === "global_legacy") {
      const policy = parseNotifyPolicy(row.notify_policy_json ?? "{}");
      const target = policy.target === "webhook" ? "webhook" : "grok";
      resolved = resolveGlobalLegacyWebhook(target, env);
    }
    payload = buildRunWebhookPayload(row, env);
  } else if (delivery.source_kind === "board_message") {
    const row = await loadBoardMessageWebhookRow(env.DB, delivery.source_id);
    if (!row) {
      message.ack();
      return;
    }
    if (row.source_node) {
      resolved = await resolveNodeDefaultWebhook(
        `board_message=${row.id}`,
        row.source_node,
        delivery.channel_id,
        row.node_default_key_id ?? null,
        row.node_key_scope ?? null,
        row.node_key_revoked_at ?? null,
        row.node_key_allowed_nodes_json ?? null,
        row.node_key_webhook_ciphertext ?? null,
        env
      );
    }
    payload = buildBoardQuestionWebhookPayload(row, env);
  } else {
    const row = await loadNativeEventWebhookRow(env.DB, delivery.source_id);
    if (!row) {
      message.ack();
      return;
    }
    resolved = await resolveNodeDefaultWebhook(
      `native_event=${row.id}`,
      row.node_id,
      delivery.channel_id,
      row.node_default_key_id ?? null,
      row.node_key_scope ?? null,
      row.node_key_revoked_at ?? null,
      row.node_key_allowed_nodes_json ?? null,
      row.node_key_webhook_ciphertext ?? null,
      env
    );
    payload = buildNativeEventWebhookPayload(row, env);
  }

  if (!resolved) {
    await markDeliveryFailedAndAck(
      message,
      env,
      delivery,
      nextAttempts,
      null,
      "CHANNEL_UNBOUND_OR_REVOKED",
      "Webhook channel is unbound, revoked, or cannot be decrypted."
    );
    return;
  }

  const result = await deliverWebhookPost(resolved, payload);
  const now = nowIso();
  if (result.ok) {
    await env.DB.prepare(
      `UPDATE notification_deliveries
       SET status = 'sent', attempts = ?1, http_status = ?2, error_code = '', error_message = '', sent_at = ?3, updated_at = ?3
       WHERE id = ?4`
    )
      .bind(nextAttempts, result.httpStatus, now, delivery.id)
      .run();
    const agg = await recomputeSourceNotifyStatus(env.DB, delivery.source_kind, delivery.source_id);
    await broadcastDeliveryAndParent(env, delivery.id, delivery.source_kind, delivery.source_id, agg.deliveriesSummary);
    message.ack();
    return;
  }

  if (message.attempts >= 5) {
    await markDeliveryFailedAndAck(
      message,
      env,
      delivery,
      nextAttempts,
      result.httpStatus,
      "WEBHOOK_DELIVERY_FAILED",
      result.errorMessage
    );
    return;
  }

  await env.DB.prepare(
    `UPDATE notification_deliveries
     SET attempts = ?1, http_status = ?2, error_code = 'WEBHOOK_DELIVERY_FAILED', error_message = ?3, updated_at = ?4
     WHERE id = ?5`
  )
    .bind(nextAttempts, result.httpStatus, result.errorMessage.slice(0, 300), now, delivery.id)
    .run();
  await broadcastDeliveryAndParent(env, delivery.id, delivery.source_kind, delivery.source_id);
  message.retry({ delaySeconds: Math.min(30, 2 ** message.attempts) });
}

async function processDeliveryWebPush(
  message: Message<NotifyQueueMessage>,
  delivery: {
    id: string;
    source_kind: DeliverySourceKind;
    source_id: string;
    trigger_event: string;
    channel_id: string;
    attempts: number;
  },
  env: Env
): Promise<void> {
  const nextAttempts = delivery.attempts + 1;
  const sub = await env.DB.prepare(
    `SELECT id, label, endpoint_host, subscription_ciphertext, enabled, revoked_at
     FROM web_push_subscriptions
     WHERE id = ?1
     LIMIT 1`
  )
    .bind(delivery.channel_id)
    .first<WebPushSubscriptionDbRow>();

  if (!sub || sub.revoked_at !== null || sub.enabled !== 1) {
    const code = sub?.revoked_at !== null && sub ? "SUBSCRIPTION_EXPIRED" : "CHANNEL_UNBOUND_OR_REVOKED";
    await markDeliveryFailedAndAck(
      message,
      env,
      delivery,
      nextAttempts,
      null,
      code,
      "Web Push subscription is missing, disabled, or revoked."
    );
    return;
  }

  const vapidState = getVapidConfig(env);
  if (!vapidState.enabled) {
    await markDeliveryFailedAndAck(
      message,
      env,
      delivery,
      nextAttempts,
      null,
      "VAPID_NOT_CONFIGURED",
      "VAPID keys are not configured on Worker."
    );
    return;
  }

  let secretSub: WebPushSubscriptionSecret;
  try {
    secretSub = await decryptJsonSecret<WebPushSubscriptionSecret>(
      env.WEBHOOK_ENCRYPTION_KEY ?? "",
      sub.subscription_ciphertext
    );
  } catch (err) {
    await markDeliveryFailedAndAck(
      message,
      env,
      delivery,
      nextAttempts,
      null,
      "CHANNEL_UNBOUND_OR_REVOKED",
      err instanceof Error ? err.message : "Failed to decrypt Web Push subscription."
    );
    return;
  }

  let pushPayload: WebPushNotificationPayload;
  const now = nowIso();
  if (delivery.source_kind === "native_event") {
    const ev = await env.DB.prepare(
      `SELECT id, node_id, agent, event_kind, native_session_id, workdir, title, summary, created_at
       FROM native_events
       WHERE id = ?1
       LIMIT 1`
    )
      .bind(delivery.source_id)
      .first<{
        id: string;
        node_id: string;
        agent: string;
        event_kind: string;
        native_session_id: string;
        workdir: string;
        title: string;
        summary: string;
        created_at: string;
      }>();
    if (!ev) {
      message.ack();
      return;
    }
    const urgent = ev.event_kind === "interaction_needed";
    const fallbackTitle =
      ev.event_kind === "interaction_needed"
        ? "需要人工确认"
        : ev.event_kind === "progress"
          ? "阶段进展"
          : "回合完成";
    const cleanTitle = redactSecrets(ev.title).trim();
    const title = `[${ev.node_id} · ${ev.agent}] ${cleanTitle || fallbackTitle}`;
    const cleanSummary = redactSecrets(ev.summary).trim();
    const bodyText = ev.workdir
      ? `${ev.workdir}: ${cleanSummary || cleanTitle || fallbackTitle}`
      : cleanSummary || title;
    const sessionKey = ev.native_session_id
      ? `${ev.node_id}:${ev.agent}:${ev.native_session_id}`
      : `${ev.node_id}:${ev.agent}:${ev.workdir}`;
    pushPayload = {
      v: 1,
      kind: "native_event",
      id: ev.id,
      tag: `ahub-native-${ev.id}`,
      urgent,
      title,
      body: bodyText,
      target_url: `/?pane=native&session=${encodeURIComponent(sessionKey)}&event=${encodeURIComponent(ev.id)}`,
      ts: ev.created_at
    };
  } else if (delivery.source_kind === "board_message") {
    const msg = await env.DB.prepare(
      `SELECT m.id, m.topic_id, m.channel, m.actor_profile, m.source_node, m.text_md, m.created_at,
              t.title AS topic_title
       FROM board_messages m
       JOIN board_topics t ON t.id = m.topic_id
       WHERE m.id = ?1
       LIMIT 1`
    )
      .bind(delivery.source_id)
      .first<{
        id: string;
        topic_id: string;
        channel: string;
        actor_profile: string;
        source_node: string;
        text_md: string;
        created_at: string;
        topic_title: string;
      }>();
    if (!msg) {
      message.ack();
      return;
    }
    const actorBase = msg.actor_profile || msg.source_node || "agent";
    const actorDisplay =
      msg.source_node && !actorBase.includes("@") ? `${actorBase}@${msg.source_node}` : actorBase;
    const title = `[${msg.channel}] ${actorDisplay} 请求确认`;
    const bodyText = redactSecrets(msg.text_md).trim() || redactSecrets(msg.topic_title);
    pushPayload = {
      v: 1,
      kind: "board_message",
      id: msg.id,
      tag: `ahub-board-${msg.id}`,
      urgent: true,
      title,
      body: bodyText,
      target_url: `/?workspace=inbox&source=board&id=${encodeURIComponent(msg.id)}`,
      ts: msg.created_at
    };
  } else {
    const run = await env.DB.prepare(`SELECT * FROM runs WHERE id = ?1 LIMIT 1`)
      .bind(delivery.source_id)
      .first<RunRow>();
    if (!run) {
      message.ack();
      return;
    }
    const trigger = delivery.trigger_event;
    const urgent = trigger === "needs_approval" || trigger === "failed";
    const labelMap: Record<string, string> = {
      needs_approval: "需要人工审批",
      failed: "任务执行失败",
      done: "任务已完成",
      cancelled: "任务已取消"
    };
    const statusLabel = labelMap[trigger] ?? run.status;
    const title = `[${run.node_id} · ${run.agent}] ${statusLabel}`;
    const rawBody =
      run.summary.trim() ||
      run.error_message.trim() ||
      buildPromptPreview(run.prompt ?? "", 200).promptPreview ||
      run.workdir;
    pushPayload = {
      v: 1,
      kind: "run",
      id: run.id,
      tag: `ahub-run-${run.id}`,
      urgent,
      title,
      body: redactSecrets(rawBody),
      target_url: `/?run=${encodeURIComponent(run.id)}`,
      ts: now
    };
  }

  const pushResult = await sendWebPushNotification({
    subscription: secretSub,
    payload: pushPayload,
    vapid: vapidState.config,
    urgency: pushPayload.urgent ? "high" : "normal",
    ttlSeconds: 86400,
    allowLoopbackForTest: isLoopbackPushAllowed(env)
  });

  const finishedNow = nowIso();
  if (pushResult.outcome === "sent") {
    await env.DB.prepare(
      `UPDATE web_push_subscriptions
       SET failure_count = 0, last_sent_at = ?1, last_error_code = '', last_error_message = '', updated_at = ?1
       WHERE id = ?2`
    )
      .bind(finishedNow, sub.id)
      .run();
    await env.DB.prepare(
      `UPDATE notification_deliveries
       SET status = 'sent', attempts = ?1, http_status = ?2, error_code = '', error_message = '', sent_at = ?3, updated_at = ?3
       WHERE id = ?4`
    )
      .bind(nextAttempts, pushResult.httpStatus, finishedNow, delivery.id)
      .run();
    const agg = await recomputeSourceNotifyStatus(env.DB, delivery.source_kind, delivery.source_id);
    await broadcastDeliveryAndParent(env, delivery.id, delivery.source_kind, delivery.source_id, agg.deliveriesSummary);
    message.ack();
    return;
  }

  if (pushResult.outcome === "expired") {
    await env.DB.prepare(
      `UPDATE web_push_subscriptions
       SET revoked_at = COALESCE(revoked_at, ?1), enabled = 0, last_error_code = 'SUBSCRIPTION_EXPIRED', last_error_message = ?2, updated_at = ?1
       WHERE id = ?3`
    )
      .bind(finishedNow, pushResult.errorMessage.slice(0, 300), sub.id)
      .run();
    await markDeliveryFailedAndAck(
      message,
      env,
      delivery,
      nextAttempts,
      pushResult.httpStatus,
      "SUBSCRIPTION_EXPIRED",
      pushResult.errorMessage
    );
    return;
  }

  if (pushResult.outcome === "rejected") {
    await env.DB.prepare(
      `UPDATE web_push_subscriptions
       SET failure_count = failure_count + 1, last_error_code = ?1, last_error_message = ?2, updated_at = ?3
       WHERE id = ?4`
    )
      .bind(pushResult.errorCode, pushResult.errorMessage.slice(0, 300), finishedNow, sub.id)
      .run();
    await markDeliveryFailedAndAck(
      message,
      env,
      delivery,
      nextAttempts,
      pushResult.httpStatus,
      pushResult.errorCode,
      pushResult.errorMessage
    );
    return;
  }

  // outcome === "retry"
  if (message.attempts >= 5) {
    await env.DB.prepare(
      `UPDATE web_push_subscriptions
       SET failure_count = failure_count + 1, last_error_code = 'PUSH_UPSTREAM_TIMEOUT', last_error_message = ?1, updated_at = ?2
       WHERE id = ?3`
    )
      .bind(pushResult.errorMessage.slice(0, 300), finishedNow, sub.id)
      .run();
    await markDeliveryFailedAndAck(
      message,
      env,
      delivery,
      nextAttempts,
      pushResult.httpStatus,
      "PUSH_UPSTREAM_TIMEOUT",
      pushResult.errorMessage
    );
    return;
  }

  await env.DB.prepare(
    `UPDATE notification_deliveries
     SET attempts = ?1, http_status = ?2, error_code = 'PUSH_UPSTREAM_TIMEOUT', error_message = ?3, updated_at = ?4
     WHERE id = ?5`
  )
    .bind(nextAttempts, pushResult.httpStatus, pushResult.errorMessage.slice(0, 300), finishedNow, delivery.id)
    .run();
  await broadcastDeliveryAndParent(env, delivery.id, delivery.source_kind, delivery.source_id);
  message.retry({ delaySeconds: Math.min(30, 2 ** message.attempts) });
}

async function markDeliverySkippedAndAck(
  message: Message<NotifyQueueMessage>,
  env: Env,
  delivery: { id: string; source_kind: DeliverySourceKind; source_id: string },
  errorCode: string,
  errorMessage: string
): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE notification_deliveries
     SET status = 'skipped', error_code = ?1, error_message = ?2, updated_at = ?3
     WHERE id = ?4`
  )
    .bind(errorCode, errorMessage.slice(0, 300), now, delivery.id)
    .run();
  const agg = await recomputeSourceNotifyStatus(env.DB, delivery.source_kind, delivery.source_id);
  await broadcastDeliveryAndParent(env, delivery.id, delivery.source_kind, delivery.source_id, agg.deliveriesSummary);
  message.ack();
}

async function processDeliveryMessage(
  message: Message<NotifyQueueMessage>,
  body: DeliveryNotifyQueueMessage,
  env: Env
): Promise<void> {
  const delivery = await getDeliveryById(env.DB, body.delivery_id);
  if (!delivery || delivery.status === "sent" || delivery.status === "skipped") {
    message.ack();
    return;
  }

  if (
    !body.bypass_coalesce &&
    delivery.source_kind === "native_event" &&
    (delivery.trigger_event === "turn_summary" || delivery.trigger_event === "progress")
  ) {
    const ev = await getNativeEventById(env.DB, delivery.source_id);
    if (!ev) {
      message.ack();
      return;
    }
    if (ev.native_session_id !== "") {
      const newerEv = await env.DB.prepare(
        `SELECT id AS newer_id
         FROM native_events
         WHERE node_id = ?1
           AND agent = ?2
           AND native_session_id = ?3
           AND (created_at > ?4 OR (created_at = ?4 AND id > ?5))
         LIMIT 1`
      )
        .bind(ev.node_id, ev.agent, ev.native_session_id, ev.created_at, ev.id)
        .first<{ newer_id: string }>();
      if (newerEv) {
        await markDeliverySkippedAndAck(
          message,
          env,
          delivery,
          "SUPERSEDED_BY_NEWER_TURN",
          "Superseded by newer event in the same session"
        );
        return;
      }

      const cooldownSec = getNativeNotifyCooldownSec(env);
      if (cooldownSec > 0) {
        const cutoffIso = new Date(Date.now() - cooldownSec * 1000).toISOString();
        const hitCooldown = await hasRecentNonUrgentSessionDelivery(
          env.DB,
          ev.node_id,
          ev.agent,
          ev.native_session_id,
          delivery.channel_kind,
          delivery.channel_id,
          cutoffIso
        );
        if (hitCooldown) {
          await markDeliverySkippedAndAck(
            message,
            env,
            delivery,
            "SESSION_COOLDOWN_ACTIVE",
            "Skipped: session cooldown window active"
          );
          return;
        }
      }
    }
  }

  if (delivery.channel_kind === "web_push") {
    await processDeliveryWebPush(message, delivery, env);
    return;
  }

  await processDeliveryWebhook(message, delivery, env);
}

async function processRunNotifyMessage(
  message: Message<NotifyQueueMessage>,
  body: RunNotifyQueueMessage,
  env: Env
): Promise<void> {
  const row = await loadRunWebhookRow(env.DB, body.run_id);
  if (!row) {
    message.ack();
    return;
  }

  const resolved = await resolveRunWebhookTarget(row, body, env);
  if (!resolved) {
    await env.DB.prepare(`UPDATE runs SET notify_status = 'failed', updated_at = ?1 WHERE id = ?2`)
      .bind(nowIso(), body.run_id)
      .run();
    message.ack();
    return;
  }

  const payload = buildRunWebhookPayload(row, env);
  const outcome = await deliverWebhookPost(resolved, payload);
  if (outcome.ok) {
    await env.DB.prepare(`UPDATE runs SET notify_status = 'sent', updated_at = ?1 WHERE id = ?2`)
      .bind(nowIso(), body.run_id)
      .run();
    message.ack();
    return;
  }
  if (message.attempts >= 5) {
    await env.DB.prepare(`UPDATE runs SET notify_status = 'failed', updated_at = ?1 WHERE id = ?2`)
      .bind(nowIso(), body.run_id)
      .run();
    message.ack();
  } else {
    message.retry({ delaySeconds: Math.min(30, 2 ** message.attempts) });
  }
}

async function processNativeEventNotifyMessage(
  message: Message<NotifyQueueMessage>,
  body: NativeEventNotifyQueueMessage,
  env: Env
): Promise<void> {
  const row = await loadNativeEventWebhookRow(env.DB, body.native_event_id);
  if (!row) {
    message.ack();
    return;
  }

  const resolved = await resolveNodeDefaultWebhook(
    `native_event=${row.id}`,
    row.node_id,
    row.notify_key_id ?? null,
    row.node_default_key_id ?? null,
    row.node_key_scope ?? null,
    row.node_key_revoked_at ?? null,
    row.node_key_allowed_nodes_json ?? null,
    row.node_key_webhook_ciphertext ?? null,
    env
  );
  if (!resolved) {
    await env.DB.prepare(
      `UPDATE native_events
       SET notify_status = 'failed', notify_error = 'CHANNEL_UNBOUND_OR_REVOKED', updated_at = ?1
       WHERE id = ?2`
    )
      .bind(nowIso(), body.native_event_id)
      .run();
    message.ack();
    return;
  }

  const payload = buildNativeEventWebhookPayload(row, env);
  const outcome = await deliverWebhookPost(resolved, payload);
  if (outcome.ok) {
    await env.DB.prepare(
      `UPDATE native_events SET notify_status = 'sent', notify_error = '', updated_at = ?1 WHERE id = ?2`
    )
      .bind(nowIso(), body.native_event_id)
      .run();
    message.ack();
    return;
  }
  if (message.attempts >= 5) {
    await env.DB.prepare(
      `UPDATE native_events
       SET notify_status = 'failed', notify_error = 'WEBHOOK_DELIVERY_FAILED', updated_at = ?1
       WHERE id = ?2`
    )
      .bind(nowIso(), body.native_event_id)
      .run();
    message.ack();
  } else {
    message.retry({ delaySeconds: Math.min(30, 2 ** message.attempts) });
  }
}

export async function processNotifyBatch(
  batch: MessageBatch<NotifyQueueMessage>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body;
    if (body.kind === "delivery") {
      await processDeliveryMessage(message, body, env);
    } else if (body.kind === "native_event") {
      await processNativeEventNotifyMessage(message, body, env);
    } else {
      await processRunNotifyMessage(message, body, env);
    }
  }
}
