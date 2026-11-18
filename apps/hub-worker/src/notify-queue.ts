import { buildPromptPreview, redactSecrets } from "./redact";
import {
  type ApiScope,
  type Env,
  type NativeEventNotifyQueueMessage,
  type NotifyQueueMessage,
  type RunNotifyQueueMessage
} from "./types";
import { nowIso } from "./ulid";
import { decryptWebhookConfig } from "./webhook-crypto";

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
  output_bytes: number;
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

  const fallbackUrl =
    body.target === "grok"
      ? env.GROK_WEBHOOK_URL?.trim()
      : (env.WEBHOOK_URL?.trim() || env.GROK_WEBHOOK_URL?.trim());
  if (!fallbackUrl) {
    return null;
  }
  const fallbackKey =
    body.target === "grok"
      ? env.GROK_WEBHOOK_KEY?.trim()
      : (env.WEBHOOK_KEY?.trim() || env.GROK_WEBHOOK_KEY?.trim());
  return {
    url: fallbackUrl,
    ...(fallbackKey ? { key: fallbackKey } : {})
  };
}

async function deliverWebhookPost(
  resolved: ResolvedWebhookTarget,
  payload: unknown
): Promise<"ok" | "retry_or_fail"> {
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
    return resp.ok ? "ok" : "retry_or_fail";
  } catch {
    return "retry_or_fail";
  }
}

async function processRunNotifyMessage(
  message: Message<NotifyQueueMessage>,
  body: RunNotifyQueueMessage,
  env: Env
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT r.id, r.thread_id, r.root_run_id, r.node_id, r.workdir, r.agent, r.status,
            r.prompt, r.resolved_model, r.resolved_effort, r.native_session_id, r.duration_ms,
            r.remote_control_url, r.summary, r.output_bytes, r.created_by_key_id,
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
    .bind(body.run_id)
    .first<RunWebhookRow>();

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

  const { promptPreview, promptTruncated } = buildPromptPreview(row.prompt ?? "", 1200);
  const payload = {
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

  const outcome = await deliverWebhookPost(resolved, payload);
  if (outcome === "ok") {
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
  const row = await env.DB.prepare(
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
    .bind(body.native_event_id)
    .first<NativeEventWebhookRow>();

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

  const payload = {
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

  const outcome = await deliverWebhookPost(resolved, payload);
  if (outcome === "ok") {
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
    if (body.kind === "native_event") {
      await processNativeEventNotifyMessage(message, body, env);
    } else {
      await processRunNotifyMessage(message, body, env);
    }
  }
}
