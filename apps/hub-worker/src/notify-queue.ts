import { type Env, type NotifyQueueMessage } from "./types";
import { nowIso } from "./ulid";

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
}

export async function processNotifyBatch(
  batch: MessageBatch<NotifyQueueMessage>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body;
    const webhookUrl =
      body.target === "grok"
        ? env.GROK_WEBHOOK_URL?.trim()
        : (env.WEBHOOK_URL?.trim() || env.GROK_WEBHOOK_URL?.trim());
    const webhookKey =
      body.target === "grok"
        ? env.GROK_WEBHOOK_KEY?.trim()
        : (env.WEBHOOK_KEY?.trim() || env.GROK_WEBHOOK_KEY?.trim());

    if (!webhookUrl) {
      await env.DB.prepare(`UPDATE runs SET notify_status = 'failed', updated_at = ?1 WHERE id = ?2`)
        .bind(nowIso(), body.run_id)
        .run();
      message.ack();
      continue;
    }

    const row = await env.DB.prepare(
      `SELECT id, thread_id, root_run_id, node_id, workdir, agent, status,
              resolved_model, resolved_effort, native_session_id, duration_ms,
              remote_control_url, summary, output_bytes
       FROM runs WHERE id = ?1 LIMIT 1`
    )
      .bind(body.run_id)
      .first<RunWebhookRow>();

    if (!row) {
      message.ack();
      continue;
    }

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
