import { type Env, type NotifyQueueMessage } from "./types";
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
  resolved_model: string;
  resolved_effort: string;
  native_session_id: string | null;
  duration_ms: number;
  remote_control_url: string;
  summary: string;
  output_bytes: number;
  created_by_key_id: string | null;
  key_revoked_at: string | null;
  key_webhook_ciphertext: string | null;
}

interface ResolvedWebhookTarget {
  url: string;
  key?: string;
}

async function resolveWebhookTarget(
  row: RunWebhookRow,
  target: NotifyQueueMessage["target"],
  env: Env
): Promise<ResolvedWebhookTarget | null> {
  if (row.created_by_key_id && row.key_revoked_at !== null) {
    console.warn(`[notify] skipping webhook for run=${row.id}: issuing key is revoked`);
    return null;
  }

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

export async function processNotifyBatch(
  batch: MessageBatch<NotifyQueueMessage>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body;
    const row = await env.DB.prepare(
      `SELECT r.id, r.thread_id, r.root_run_id, r.node_id, r.workdir, r.agent, r.status,
              r.resolved_model, r.resolved_effort, r.native_session_id, r.duration_ms,
              r.remote_control_url, r.summary, r.output_bytes, r.created_by_key_id,
              k.revoked_at AS key_revoked_at,
              k.notify_webhook_ciphertext AS key_webhook_ciphertext
       FROM runs r
       LEFT JOIN api_keys k ON k.id = r.created_by_key_id
       WHERE r.id = ?1
       LIMIT 1`
    )
      .bind(body.run_id)
      .first<RunWebhookRow>();

    if (!row) {
      message.ack();
      continue;
    }

    const resolved = await resolveWebhookTarget(row, body.target, env);
    if (!resolved) {
      await env.DB.prepare(`UPDATE runs SET notify_status = 'failed', updated_at = ?1 WHERE id = ?2`)
        .bind(nowIso(), body.run_id)
        .run();
      message.ack();
      continue;
    }
    const webhookUrl = resolved.url;
    const webhookKey = resolved.key;

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
      summary: row.summary,
      output_bytes: row.output_bytes,
      fetch_full_cmd: `ahub result ${row.id} --full --json`
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (webhookKey) {
      headers["Authorization"] = `Bearer ${webhookKey}`;
    }

    try {
      const resp = await fetch(webhookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      if (!resp.ok) {
        if (message.attempts >= 5) {
          await env.DB.prepare(`UPDATE runs SET notify_status = 'failed', updated_at = ?1 WHERE id = ?2`)
            .bind(nowIso(), body.run_id)
            .run();
          message.ack();
        } else {
          message.retry({ delaySeconds: Math.min(30, 2 ** message.attempts) });
        }
        continue;
      }

      await env.DB.prepare(`UPDATE runs SET notify_status = 'sent', updated_at = ?1 WHERE id = ?2`)
        .bind(nowIso(), body.run_id)
        .run();
      message.ack();
    } catch {
      if (message.attempts >= 5) {
        await env.DB.prepare(`UPDATE runs SET notify_status = 'failed', updated_at = ?1 WHERE id = ?2`)
          .bind(nowIso(), body.run_id)
          .run();
        message.ack();
      } else {
        message.retry({ delaySeconds: Math.min(30, 2 ** message.attempts) });
      }
    }
  }
}
