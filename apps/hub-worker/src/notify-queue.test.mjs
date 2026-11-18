import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Resolve bundler-style extensionless TS imports and mock cloudflare:workers for Node ESM test execution
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { shortCircuit: true, url: "mock:cloudflare-workers" };
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !specifier.endsWith(".ts") &&
      !specifier.endsWith(".js") &&
      context.parentURL?.startsWith("file://")
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const candidate = path.resolve(parentDir, `${specifier}.ts`);
      if (fs.existsSync(candidate)) {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:cloudflare-workers") {
      return {
        shortCircuit: true,
        format: "module",
        source: "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }"
      };
    }
    return nextLoad(url, context);
  }
});

const { processNotifyBatch } = await import("./notify-queue.ts");
const { encryptJsonSecret, encryptWebhookConfig, decryptWebhookConfig, toBase64Url } = await import(
  "./webhook-crypto.ts"
);
const { NodeHub } = await import("./node-hub.ts");

function createMockDb(
  initialRuns,
  initialKeys = [],
  initialNodes = [],
  initialNativeEvents = [],
  initialDeliveries = [],
  initialWebPush = []
) {
  const runList = Array.isArray(initialRuns) ? initialRuns : [initialRuns];
  const runs = new Map(runList.map((r) => [r.id, { created_by_key_id: null, ...r }]));
  const keys = new Map(
    initialKeys.map((k) => [
      k.id,
      { scope: "client", allowed_nodes_json: "[]", revoked_at: null, notify_webhook_ciphertext: "", ...k }
    ])
  );
  const nodes = new Map(initialNodes.map((n) => [n.id, { default_notify_key_id: null, ...n }]));
  const nativeEvents = new Map(
    initialNativeEvents.map((e) => [e.id, { notify_key_id: null, notify_error: "", ack_at: null, ...e }])
  );
  const deliveries = new Map(initialDeliveries.map((d) => [d.id, { ...d }]));
  const webPush = new Map(
    initialWebPush.map((s) => [
      s.id,
      {
        enabled: 1,
        failure_count: 0,
        last_sent_at: null,
        last_error_code: "",
        last_error_message: "",
        revoked_at: null,
        ...s
      }
    ])
  );

  return {
    runs,
    keys,
    nodes,
    nativeEvents,
    deliveries,
    webPush,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...params) {
          args = params;
          return stmt;
        },
        async first() {
          if (sql.includes("FROM notification_deliveries WHERE id = ?1")) {
            return deliveries.get(args[0]) ?? null;
          }
          if (sql.includes("FROM web_push_subscriptions") && sql.includes("WHERE id = ?1")) {
            return webPush.get(args[0]) ?? null;
          }
          if (sql.includes("FROM runs r") && sql.includes("WHERE r.id = ?1")) {
            const r = runs.get(args[0]);
            if (!r) return null;
            const k = r.created_by_key_id ? keys.get(r.created_by_key_id) ?? null : null;
            const n = nodes.get(r.node_id) ?? null;
            const nk = n?.default_notify_key_id ? keys.get(n.default_notify_key_id) ?? null : null;
            return {
              ...r,
              key_scope: k ? k.scope ?? null : null,
              key_revoked_at: k ? k.revoked_at ?? null : null,
              key_webhook_ciphertext: k ? k.notify_webhook_ciphertext ?? "" : null,
              node_default_key_id: n ? n.default_notify_key_id ?? null : null,
              node_key_scope: nk ? nk.scope ?? null : null,
              node_key_revoked_at: nk ? nk.revoked_at ?? null : null,
              node_key_allowed_nodes_json: nk ? nk.allowed_nodes_json ?? "[]" : null,
              node_key_webhook_ciphertext: nk ? nk.notify_webhook_ciphertext ?? "" : null
            };
          }
          if (sql.includes("FROM runs WHERE id = ?1")) {
            const r = runs.get(args[0]);
            if (!r) return null;
            if (sql.includes("SELECT notify_status")) {
              return { notify_status: r.notify_status ?? "none" };
            }
            return r;
          }
          if (sql.includes("FROM native_events e") && sql.includes("WHERE e.id = ?1")) {
            const e = nativeEvents.get(args[0]);
            if (!e) return null;
            const n = nodes.get(e.node_id) ?? null;
            const nk = n?.default_notify_key_id ? keys.get(n.default_notify_key_id) ?? null : null;
            return {
              ...e,
              node_default_key_id: n ? n.default_notify_key_id ?? null : null,
              node_key_scope: nk ? nk.scope ?? null : null,
              node_key_revoked_at: nk ? nk.revoked_at ?? null : null,
              node_key_allowed_nodes_json: nk ? nk.allowed_nodes_json ?? "[]" : null,
              node_key_webhook_ciphertext: nk ? nk.notify_webhook_ciphertext ?? "" : null
            };
          }
          if (sql.includes("FROM native_events") && sql.includes("WHERE id = ?1")) {
            return nativeEvents.get(args[0]) ?? null;
          }
          if (sql.includes("SELECT COUNT(*) AS cnt") && sql.includes("FROM native_events e")) {
            let cnt = 0;
            const cutoff = args[0];
            for (const ev of nativeEvents.values()) {
              if (ev.event_kind === "interaction_needed" && ev.ack_at === null && ev.created_at >= cutoff) {
                cnt += 1;
              }
            }
            return { cnt };
          }
          if (sql.includes("SELECT id AS newer_id") && sql.includes("FROM native_events")) {
            const [nodeId, agent, sessionId, createdAt, id] = args;
            for (const ev of nativeEvents.values()) {
              if (
                ev.node_id === nodeId &&
                ev.agent === agent &&
                ev.native_session_id === sessionId &&
                (ev.created_at > createdAt || (ev.created_at === createdAt && ev.id > id))
              ) {
                return { newer_id: ev.id };
              }
            }
            return null;
          }
          if (sql.includes("SELECT 1 AS cooldown_hit") && sql.includes("FROM notification_deliveries")) {
            const [channelKind, channelId, cutoffIso, nodeId, agent, sessionId] = args;
            for (const d of deliveries.values()) {
              if (
                d.source_kind !== "native_event" ||
                d.status !== "sent" ||
                (d.trigger_event !== "turn_summary" && d.trigger_event !== "progress") ||
                d.channel_kind !== channelKind ||
                d.channel_id !== channelId ||
                !d.sent_at ||
                d.sent_at < cutoffIso
              ) {
                continue;
              }
              const ev = nativeEvents.get(d.source_id);
              if (ev && ev.node_id === nodeId && ev.agent === agent && ev.native_session_id === sessionId) {
                return { cooldown_hit: 1 };
              }
            }
            return null;
          }
          if (sql.includes("SELECT 1 AS hit") && sql.includes("FROM native_events")) {
            return null;
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM notification_deliveries") && sql.includes("GROUP BY source_id")) {
            const sourceKind = args[0];
            const idSet = new Set(args.slice(1));
            const grouped = new Map();
            for (const d of deliveries.values()) {
              if (d.source_kind !== sourceKind || !idSet.has(d.source_id)) continue;
              const cur = grouped.get(d.source_id) ?? {
                source_id: d.source_id,
                total: 0,
                sent: 0,
                queued: 0,
                failed: 0
              };
              cur.total += 1;
              if (d.status === "sent") cur.sent += 1;
              else if (d.status === "queued") cur.queued += 1;
              else if (d.status === "failed") cur.failed += 1;
              grouped.set(d.source_id, cur);
            }
            return { results: Array.from(grouped.values()) };
          }
          if (
            sql.includes("FROM notification_deliveries") &&
            sql.includes("WHERE source_kind = ?1 AND source_id = ?2")
          ) {
            return {
              results: Array.from(deliveries.values()).filter(
                (d) => d.source_kind === args[0] && d.source_id === args[1]
              )
            };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes("UPDATE notification_deliveries")) {
            if (sql.includes("SET status = 'sent'")) {
              const d = deliveries.get(args[3]);
              if (d) {
                d.status = "sent";
                d.attempts = args[0];
                d.http_status = args[1];
                d.error_code = "";
                d.error_message = "";
                d.sent_at = args[2];
                d.updated_at = args[2];
              }
            } else if (sql.includes("SET status = 'failed'")) {
              const d = deliveries.get(args[5]);
              if (d) {
                d.status = "failed";
                d.attempts = args[0];
                d.http_status = args[1];
                d.error_code = args[2];
                d.error_message = args[3];
                d.updated_at = args[4];
              }
            } else if (sql.includes("SET status = 'skipped'")) {
              const d = deliveries.get(args[3]);
              if (d) {
                d.status = "skipped";
                d.error_code = args[0];
                d.error_message = args[1];
                d.updated_at = args[2];
              }
            } else {
              const d = deliveries.get(args[4]);
              if (d) {
                d.attempts = args[0];
                d.http_status = args[1];
                if (sql.includes("'WEBHOOK_DELIVERY_FAILED'")) {
                  d.error_code = "WEBHOOK_DELIVERY_FAILED";
                  d.error_message = args[2];
                  d.updated_at = args[3];
                } else {
                  d.error_code = "PUSH_UPSTREAM_TIMEOUT";
                  d.error_message = args[2];
                  d.updated_at = args[3];
                }
              }
            }
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE web_push_subscriptions")) {
            if (sql.includes("SET failure_count = 0")) {
              const s = webPush.get(args[1]);
              if (s) {
                s.failure_count = 0;
                s.last_sent_at = args[0];
                s.last_error_code = "";
                s.last_error_message = "";
                s.updated_at = args[0];
              }
            } else if (sql.includes("SET revoked_at = COALESCE")) {
              const s = webPush.get(args[2]);
              if (s) {
                s.revoked_at = s.revoked_at ?? args[0];
                s.enabled = 0;
                s.last_error_code = "SUBSCRIPTION_EXPIRED";
                s.last_error_message = args[1];
                s.updated_at = args[0];
              }
            } else if (sql.includes("failure_count = failure_count + 1")) {
              if (sql.includes("last_error_code = 'PUSH_UPSTREAM_TIMEOUT'")) {
                const s = webPush.get(args[2]);
                if (s) {
                  s.failure_count += 1;
                  s.last_error_code = "PUSH_UPSTREAM_TIMEOUT";
                  s.last_error_message = args[0];
                  s.updated_at = args[1];
                }
              } else {
                const s = webPush.get(args[3]);
                if (s) {
                  s.failure_count += 1;
                  s.last_error_code = args[0];
                  s.last_error_message = args[1];
                  s.updated_at = args[2];
                }
              }
            }
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE native_events")) {
            if (sql.includes("SET notify_status = ?1")) {
              const ev = nativeEvents.get(args[3]);
              if (ev) {
                ev.notify_status = args[0];
                ev.notify_error = args[1];
                ev.updated_at = args[2];
              }
            } else {
              const isFailed = sql.includes("notify_status = 'failed'");
              const ev = nativeEvents.get(args[1]);
              if (ev) {
                ev.notify_status = isFailed ? "failed" : "sent";
                ev.notify_error = isFailed ? "CHANNEL_UNBOUND_OR_REVOKED" : "";
                ev.updated_at = args[0];
              }
            }
          } else if (sql.includes("UPDATE runs SET notify_status = ?1")) {
            const r = runs.get(args[2]);
            if (r) {
              r.notify_status = args[0];
              r.updated_at = args[1];
            }
          } else if (sql.includes("SET notify_status = 'failed'")) {
            const r = runs.get(args[1]);
            if (r) {
              r.notify_status = "failed";
              r.updated_at = args[0];
            }
          } else if (sql.includes("SET notify_status = 'sent'")) {
            const r = runs.get(args[1]);
            if (r) {
              r.notify_status = "sent";
              r.updated_at = args[0];
            }
          }
          return { success: true, meta: { changes: 1 } };
        }
      };
      return stmt;
    }
  };
}

test("processNotifyBatch retries HTTP 500 across attempts 1..4 and marks notify_status='failed' at attempt 5", async (t) => {
  let hits = 0;
  let lastAuthHeader = "";
  const server = http.createServer((req, res) => {
    hits += 1;
    lastAuthHeader = req.headers.authorization ?? "";
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const port = server.address().port;
  const mockDb = createMockDb({
    id: "run_01RETRY",
    thread_id: "thr_01RETRY",
    root_run_id: "run_01RETRY",
    node_id: "macmini",
    workdir: "/tmp/demo",
    agent: "agy",
    status: "done",
    resolved_model: "carbon",
    resolved_effort: "high",
    native_session_id: "sess_1",
    duration_ms: 120,
    remote_control_url: "",
    summary: "ok",
    output_bytes: 2,
    notify_status: "queued"
  });

  const env = {
    DB: mockDb,
    WEBHOOK_URL: `http://127.0.0.1:${port}/hook`,
    WEBHOOK_KEY: "whsec_test_123",
    HUB_PUBLIC_URL: "https://ahub.bobocai.win"
  };

  for (let attempt = 1; attempt <= 4; attempt++) {
    let acked = false;
    let retriedDelay = null;
    await processNotifyBatch(
      {
        messages: [
          {
            attempts: attempt,
            body: {
              run_id: "run_01RETRY",
              event: "done",
              target: "webhook"
            },
            ack() {
              acked = true;
            },
            retry(opts) {
              retriedDelay = opts?.delaySeconds ?? 0;
            }
          }
        ]
      },
      env
    );
    assert.equal(acked, false, `attempt ${attempt} must retry rather than ack`);
    assert.equal(retriedDelay, Math.min(30, 2 ** attempt));
    assert.equal(mockDb.runs.get("run_01RETRY").notify_status, "queued");
  }

  let finalAcked = false;
  let finalRetried = false;
  await processNotifyBatch(
    {
      messages: [
        {
          attempts: 5,
          body: {
            run_id: "run_01RETRY",
            event: "done",
            target: "webhook"
          },
          ack() {
            finalAcked = true;
          },
          retry() {
            finalRetried = true;
          }
        }
      ]
    },
    env
  );

  assert.equal(hits, 5);
  assert.equal(lastAuthHeader, "Bearer whsec_test_123");
  assert.equal(finalAcked, true, "attempt 5 must ack cleanly for DLQ state");
  assert.equal(finalRetried, false);
  assert.equal(mockDb.runs.get("run_01RETRY").notify_status, "failed");
});

test("processNotifyBatch marks notify_status='sent' on HTTP 200 and acks once", async (t) => {
  let hits = 0;
  let receivedPayload = null;
  const server = http.createServer((req, res) => {
    hits += 1;
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      receivedPayload = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const port = server.address().port;
  const mockDb = createMockDb({
    id: "run_01SENT",
    thread_id: "thr_01SENT",
    root_run_id: "run_01SENT",
    node_id: "mbp",
    workdir: "/tmp/demo",
    agent: "pi",
    status: "done",
    resolved_model: "gpt-5",
    resolved_effort: "medium",
    native_session_id: "sess_2",
    prompt: "Check repo using token ahub_cli_leak123456 and password=secret_pw",
    duration_ms: 85,
    remote_control_url: "",
    summary: "done",
    output_bytes: 42,
    notify_status: "queued"
  });

  let acked = false;
  await processNotifyBatch(
    {
      messages: [
        {
          attempts: 1,
          body: { run_id: "run_01SENT", event: "done", target: "grok" },
          ack() {
            acked = true;
          },
          retry() {
            assert.fail("HTTP 200 should not retry");
          }
        }
      ]
    },
    {
      DB: mockDb,
      GROK_WEBHOOK_URL: `http://127.0.0.1:${port}/grok`,
      HUB_PUBLIC_URL: "https://ahub.bobocai.win"
    }
  );

  assert.equal(hits, 1);
  assert.equal(acked, true);
  assert.equal(mockDb.runs.get("run_01SENT").notify_status, "sent");
  assert.equal(receivedPayload.fetch_full_cmd, "ahub result run_01SENT --full --json");
  assert.equal(receivedPayload.prompt_truncated, false);
  assert.equal(receivedPayload.prompt_preview.includes("leak123456"), false);
  assert.equal(receivedPayload.prompt_preview.includes("secret_pw"), false);
  assert.equal(receivedPayload.prompt_preview.includes("ahub_cli_[REDACTED]"), true);
});

test("encryptWebhookConfig roundtrips URL/key and rejects non-local plain http", async () => {
  const enc = await encryptWebhookConfig("test-master-secret-32-bytes-key!!", {
    url: "https://hooks.example.com/bot/alpha",
    key: "secret_alpha"
  });
  assert.equal(enc.host, "hooks.example.com");
  assert.ok(enc.ciphertext.startsWith("v1:"));
  assert.equal(enc.ciphertext.includes("secret_alpha"), false);
  assert.equal(enc.ciphertext.includes("hooks.example.com"), false);

  const dec = await decryptWebhookConfig("test-master-secret-32-bytes-key!!", enc.ciphertext);
  assert.deepEqual(dec, {
    url: "https://hooks.example.com/bot/alpha",
    key: "secret_alpha"
  });

  await assert.rejects(
    () => decryptWebhookConfig("wrong-secret", enc.ciphertext),
    /OperationError|Unsupported|Malformed|decrypt/i
  );
  await assert.rejects(
    () =>
      encryptWebhookConfig("test-master-secret-32-bytes-key!!", {
        url: "http://hooks.example.com/insecure"
      }),
    /https/i
  );
});

test("processNotifyBatch isolates per-key bot webhooks without cross-talk", async (t) => {
  const hitsA = [];
  const hitsB = [];
  const hitsGlobal = [];
  const makeServer = (sink) =>
    http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        sink.push({
          auth: req.headers.authorization ?? "",
          payload: JSON.parse(body)
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });

  const serverA = makeServer(hitsA);
  const serverB = makeServer(hitsB);
  const serverG = makeServer(hitsGlobal);
  await Promise.all([
    new Promise((r) => serverA.listen(0, "127.0.0.1", r)),
    new Promise((r) => serverB.listen(0, "127.0.0.1", r)),
    new Promise((r) => serverG.listen(0, "127.0.0.1", r))
  ]);
  t.after(() => {
    serverA.close();
    serverB.close();
    serverG.close();
  });

  const masterSecret = "multi-bot-master-encryption-secret";
  const encA = await encryptWebhookConfig(masterSecret, {
    url: `http://127.0.0.1:${serverA.address().port}/bot-a`,
    key: "token_bot_a"
  });
  const encB = await encryptWebhookConfig(masterSecret, {
    url: `http://127.0.0.1:${serverB.address().port}/bot-b`,
    key: "token_bot_b"
  });

  const baseRun = {
    thread_id: "thr_01MULTI",
    root_run_id: "run_01BOTA",
    workdir: "/tmp/demo",
    agent: "agy",
    status: "done",
    resolved_model: "carbon",
    resolved_effort: "high",
    native_session_id: "sess_m",
    duration_ms: 42,
    remote_control_url: "",
    summary: "done",
    output_bytes: 12,
    notify_status: "queued"
  };

  const mockDb = createMockDb(
    [
      { ...baseRun, id: "run_01BOTA", node_id: "macmini", created_by_key_id: "key_botA" },
      { ...baseRun, id: "run_01BOTB", node_id: "mbp", created_by_key_id: "key_botB" }
    ],
    [
      { id: "key_botA", revoked_at: null, notify_webhook_ciphertext: encA.ciphertext },
      { id: "key_botB", revoked_at: null, notify_webhook_ciphertext: encB.ciphertext }
    ]
  );

  const acked = [];
  await processNotifyBatch(
    {
      messages: [
        {
          attempts: 1,
          body: { run_id: "run_01BOTA", event: "done", target: "grok" },
          ack: () => acked.push("run_01BOTA"),
          retry: () => assert.fail("unexpected retry A")
        },
        {
          attempts: 1,
          body: { run_id: "run_01BOTB", event: "done", target: "grok" },
          ack: () => acked.push("run_01BOTB"),
          retry: () => assert.fail("unexpected retry B")
        }
      ]
    },
    {
      DB: mockDb,
      WEBHOOK_ENCRYPTION_KEY: masterSecret,
      GROK_WEBHOOK_URL: `http://127.0.0.1:${serverG.address().port}/global-should-not-fire`,
      GROK_WEBHOOK_KEY: "global_token",
      HUB_PUBLIC_URL: "https://ahub.bobocai.win"
    }
  );

  assert.deepEqual(acked, ["run_01BOTA", "run_01BOTB"]);
  assert.equal(hitsGlobal.length, 0);
  assert.equal(hitsA.length, 1);
  assert.equal(hitsA[0].auth, "Bearer token_bot_a");
  assert.equal(hitsA[0].payload.run_id, "run_01BOTA");
  assert.equal(hitsB.length, 1);
  assert.equal(hitsB[0].auth, "Bearer token_bot_b");
  assert.equal(hitsB[0].payload.run_id, "run_01BOTB");
  assert.equal(mockDb.runs.get("run_01BOTA").notify_status, "sent");
  assert.equal(mockDb.runs.get("run_01BOTB").notify_status, "sent");
});

test("processNotifyBatch fails closed when issuing key is revoked or decryption fails", async (t) => {
  let globalHits = 0;
  const globalServer = http.createServer((req, res) => {
    globalHits += 1;
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise((r) => globalServer.listen(0, "127.0.0.1", r));
  t.after(() => globalServer.close());

  const encValid = await encryptWebhookConfig("correct-secret", {
    url: `http://127.0.0.1:${globalServer.address().port}/bot`,
    key: "k"
  });

  const mockDb = createMockDb(
    [
      {
        id: "run_01REVOKED",
        thread_id: "thr_1",
        root_run_id: "run_01REVOKED",
        node_id: "macmini",
        workdir: "/tmp/demo",
        agent: "agy",
        status: "done",
        resolved_model: "",
        resolved_effort: "",
        native_session_id: null,
        duration_ms: 10,
        remote_control_url: "",
        summary: "ok",
        output_bytes: 2,
        notify_status: "queued",
        created_by_key_id: "key_revoked"
      },
      {
        id: "run_01BADKEY",
        thread_id: "thr_2",
        root_run_id: "run_01BADKEY",
        node_id: "mbp",
        workdir: "/tmp/demo",
        agent: "agy",
        status: "done",
        resolved_model: "",
        resolved_effort: "",
        native_session_id: null,
        duration_ms: 10,
        remote_control_url: "",
        summary: "ok",
        output_bytes: 2,
        notify_status: "queued",
        created_by_key_id: "key_bad_cipher"
      }
    ],
    [
      {
        id: "key_revoked",
        revoked_at: "2026-11-14T10:00:00Z",
        notify_webhook_ciphertext: encValid.ciphertext
      },
      {
        id: "key_bad_cipher",
        revoked_at: null,
        notify_webhook_ciphertext: encValid.ciphertext
      }
    ]
  );

  const acked = [];
  await processNotifyBatch(
    {
      messages: [
        {
          attempts: 1,
          body: { run_id: "run_01REVOKED", event: "done", target: "grok" },
          ack: () => acked.push("run_01REVOKED"),
          retry: () => assert.fail("revoked key should fail closed immediately")
        },
        {
          attempts: 1,
          body: { run_id: "run_01BADKEY", event: "done", target: "grok" },
          ack: () => acked.push("run_01BADKEY"),
          retry: () => assert.fail("decrypt error should fail closed immediately")
        }
      ]
    },
    {
      DB: mockDb,
      WEBHOOK_ENCRYPTION_KEY: "wrong-secret-must-not-fallback",
      GROK_WEBHOOK_URL: `http://127.0.0.1:${globalServer.address().port}/global-fallback`,
      HUB_PUBLIC_URL: "https://ahub.bobocai.win"
    }
  );

  assert.equal(globalHits, 0);
  assert.deepEqual(acked, ["run_01REVOKED", "run_01BADKEY"]);
  assert.equal(mockDb.runs.get("run_01REVOKED").notify_status, "failed");
  assert.equal(mockDb.runs.get("run_01BADKEY").notify_status, "failed");
});

test("processNotifyBatch delivers ahub_native_event via node-bound Bot webhook with redaction and fails closed when unbound", async (t) => {
  const botHits = [];
  const globalHits = [];
  const makeServer = (sink) =>
    http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        sink.push({ auth: req.headers.authorization ?? "", payload: JSON.parse(body) });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });

  const botSrv = makeServer(botHits);
  const globalSrv = makeServer(globalHits);
  await Promise.all([
    new Promise((r) => botSrv.listen(0, "127.0.0.1", r)),
    new Promise((r) => globalSrv.listen(0, "127.0.0.1", r))
  ]);
  t.after(() => {
    botSrv.close();
    globalSrv.close();
  });

  const secret = "node-default-webhook-master-secret";
  const encNodeBot = await encryptWebhookConfig(secret, {
    url: `http://127.0.0.1:${botSrv.address().port}/macmini-bot`,
    key: "macmini_bot_bearer"
  });

  const mockDb = createMockDb(
    [],
    [
      {
        id: "key_node_bot",
        scope: "client",
        allowed_nodes_json: '["macmini"]',
        revoked_at: null,
        notify_webhook_ciphertext: encNodeBot.ciphertext
      }
    ],
    [
      { id: "macmini", default_notify_key_id: "key_node_bot" },
      { id: "mbp", default_notify_key_id: null }
    ],
    [
      {
        id: "evt_01VALID",
        node_id: "macmini",
        event_id: "claude:sess1:Notification:1122",
        agent: "claude",
        event_kind: "interaction_needed",
        native_session_id: "sess1",
        workdir: "/workspace/demo",
        title: "Need user input",
        summary: "Please confirm deployment with token ahub_cli_leaksecret99",
        source: "claude-hook",
        notify_key_id: "key_node_bot",
        notify_status: "queued",
        created_at: "2026-11-17T12:00:00.000Z"
      },
      {
        id: "evt_02UNBOUND",
        node_id: "mbp",
        event_id: "codex:t1:turn1:turn_summary",
        agent: "codex",
        event_kind: "turn_summary",
        native_session_id: "t1",
        workdir: "/workspace/app",
        title: "Turn summary",
        summary: "Finished checks",
        source: "codex-notify",
        notify_key_id: "key_node_bot",
        notify_status: "queued",
        created_at: "2026-11-17T12:01:00.000Z"
      }
    ]
  );

  const acked = [];
  await processNotifyBatch(
    {
      messages: [
        {
          attempts: 1,
          body: { kind: "native_event", native_event_id: "evt_01VALID", node_id: "macmini", attempt: 1 },
          ack: () => acked.push("evt_01VALID"),
          retry: () => assert.fail("unexpected retry for valid native event")
        },
        {
          attempts: 1,
          body: { kind: "native_event", native_event_id: "evt_02UNBOUND", node_id: "mbp", attempt: 1 },
          ack: () => acked.push("evt_02UNBOUND"),
          retry: () => assert.fail("unbound node channel must fail closed immediately")
        }
      ]
    },
    {
      DB: mockDb,
      WEBHOOK_ENCRYPTION_KEY: secret,
      GROK_WEBHOOK_URL: `http://127.0.0.1:${globalSrv.address().port}/global-must-not-fire`,
      GROK_WEBHOOK_KEY: "global_key",
      HUB_PUBLIC_URL: "https://ahub.bobocai.win"
    }
  );

  assert.deepEqual(acked, ["evt_01VALID", "evt_02UNBOUND"]);
  assert.equal(globalHits.length, 0);
  assert.equal(botHits.length, 1);
  assert.equal(botHits[0].auth, "Bearer macmini_bot_bearer");
  assert.equal(botHits[0].payload.event, "ahub_native_event");
  assert.equal(botHits[0].payload.action_required, "notify_user_only");
  assert.equal(botHits[0].payload.summary.includes("leaksecret99"), false);
  assert.equal(botHits[0].payload.summary.includes("ahub_cli_[REDACTED]"), true);
  assert.equal(mockDb.nativeEvents.get("evt_01VALID").notify_status, "sent");
  assert.equal(mockDb.nativeEvents.get("evt_02UNBOUND").notify_status, "failed");
});

test("processNotifyBatch routes admin-key runs via node_default when bound or global_legacy when unbound", async (t) => {
  const botHits = [];
  const globalHits = [];
  const makeServer = (sink) =>
    http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        sink.push({ auth: req.headers.authorization ?? "", payload: JSON.parse(body) });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });

  const botSrv = makeServer(botHits);
  const globalSrv = makeServer(globalHits);
  await Promise.all([
    new Promise((r) => botSrv.listen(0, "127.0.0.1", r)),
    new Promise((r) => globalSrv.listen(0, "127.0.0.1", r))
  ]);
  t.after(() => {
    botSrv.close();
    globalSrv.close();
  });

  const secret = "admin-route-master-secret";
  const encNodeBot = await encryptWebhookConfig(secret, {
    url: `http://127.0.0.1:${botSrv.address().port}/macmini-bot`,
    key: "macmini_bot_bearer"
  });

  const baseRun = {
    thread_id: "thr_adm_1",
    workdir: "/workspace/demo",
    agent: "agy",
    status: "done",
    resolved_model: "",
    resolved_effort: "",
    native_session_id: null,
    duration_ms: 15,
    remote_control_url: "",
    summary: "ok",
    output_bytes: 2,
    notify_status: "queued",
    created_by_key_id: "key_admin_1"
  };

  const mockDb = createMockDb(
    [
      { ...baseRun, id: "run_adm_bound", root_run_id: "run_adm_bound", node_id: "macmini" },
      { ...baseRun, id: "run_adm_unbound", root_run_id: "run_adm_unbound", node_id: "mbp" }
    ],
    [
      {
        id: "key_admin_1",
        scope: "admin",
        revoked_at: null,
        notify_webhook_ciphertext: ""
      },
      {
        id: "key_node_bot",
        scope: "client",
        allowed_nodes_json: '["macmini"]',
        revoked_at: null,
        notify_webhook_ciphertext: encNodeBot.ciphertext
      }
    ],
    [
      { id: "macmini", default_notify_key_id: "key_node_bot" },
      { id: "mbp", default_notify_key_id: null }
    ]
  );

  const acked = [];
  await processNotifyBatch(
    {
      messages: [
        {
          attempts: 1,
          body: { run_id: "run_adm_bound", event: "done", target: "grok", route_mode: "node_default" },
          ack: () => acked.push("run_adm_bound"),
          retry: () => assert.fail("unexpected retry for admin bound run")
        },
        {
          attempts: 1,
          body: { run_id: "run_adm_unbound", event: "done", target: "grok", route_mode: "global_legacy" },
          ack: () => acked.push("run_adm_unbound"),
          retry: () => assert.fail("unexpected retry for admin unbound run")
        }
      ]
    },
    {
      DB: mockDb,
      WEBHOOK_ENCRYPTION_KEY: secret,
      GROK_WEBHOOK_URL: `http://127.0.0.1:${globalSrv.address().port}/global-grok`,
      GROK_WEBHOOK_KEY: "global_grok_bearer",
      HUB_PUBLIC_URL: "https://ahub.bobocai.win"
    }
  );

  assert.deepEqual(acked, ["run_adm_bound", "run_adm_unbound"]);
  assert.equal(botHits.length, 1);
  assert.equal(botHits[0].payload.run_id, "run_adm_bound");
  assert.equal(botHits[0].auth, "Bearer macmini_bot_bearer");
  assert.equal(globalHits.length, 1);
  assert.equal(globalHits[0].payload.run_id, "run_adm_unbound");
  assert.equal(globalHits[0].auth, "Bearer global_grok_bearer");
  assert.equal(mockDb.runs.get("run_adm_bound").notify_status, "sent");
  assert.equal(mockDb.runs.get("run_adm_unbound").notify_status, "sent");
});

async function makeVapidAndPushFixture(secret, endpointUrl) {
  const vapidPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const vapidJwk = await crypto.subtle.exportKey("jwk", vapidPair.privateKey);
  const vapidPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", vapidPair.publicKey));
  const uaPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const uaPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", uaPair.publicKey));
  const authBytes = crypto.getRandomValues(new Uint8Array(16));
  const subCiphertext = await encryptJsonSecret(secret, {
    endpoint: endpointUrl,
    keys: {
      p256dh: toBase64Url(uaPubRaw),
      auth: toBase64Url(authBytes)
    }
  });
  return {
    vapidEnv: {
      VAPID_PUBLIC_KEY: toBase64Url(vapidPubRaw),
      VAPID_PRIVATE_JWK: JSON.stringify(vapidJwk),
      VAPID_SUBJECT: "mailto:admin@bobocai.win",
      ALLOW_LOOPBACK_PUSH_FOR_TEST: "true"
    },
    subCiphertext
  };
}

test("per-delivery isolation: 503 retry on Web Push never re-triggers succeeded Bot Webhook and yields partial status", async (t) => {
  let botHits = 0;
  let pushHits = 0;
  const botServer = http.createServer((req, res) => {
    botHits += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const pushServer = http.createServer((req, res) => {
    pushHits += 1;
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("upstream unavailable");
  });
  await Promise.all([
    new Promise((r) => botServer.listen(0, "127.0.0.1", r)),
    new Promise((r) => pushServer.listen(0, "127.0.0.1", r))
  ]);
  t.after(() => {
    botServer.close();
    pushServer.close();
  });

  const secret = "multi-channel-ledger-secret";
  const encBot = await encryptWebhookConfig(secret, {
    url: `http://127.0.0.1:${botServer.address().port}/bot`,
    key: "bot_tok"
  });
  const pushFix = await makeVapidAndPushFixture(
    secret,
    `http://127.0.0.1:${pushServer.address().port}/push/dev1`
  );

  const mockDb = createMockDb(
    [],
    [
      {
        id: "key_bot_1",
        scope: "client",
        allowed_nodes_json: '["macmini"]',
        revoked_at: null,
        notify_webhook_ciphertext: encBot.ciphertext
      }
    ],
    [{ id: "macmini", default_notify_key_id: "key_bot_1" }],
    [
      {
        id: "evt_01PARTIAL",
        node_id: "macmini",
        event_id: "claude:s1:Notification:1111",
        agent: "claude",
        event_kind: "interaction_needed",
        native_session_id: "s1",
        workdir: "/workspace/demo",
        title: "Need approval",
        summary: "Please check",
        source: "claude-hook",
        notify_key_id: "key_bot_1",
        notify_status: "queued",
        created_at: "2026-11-18T08:00:00.000Z"
      }
    ],
    [
      {
        id: "dlv_bot_1",
        source_kind: "native_event",
        source_id: "evt_01PARTIAL",
        trigger_event: "interaction_needed",
        node_id: "macmini",
        channel_kind: "bot_webhook",
        channel_id: "key_bot_1",
        channel_label: "bot-1",
        target_host: "127.0.0.1",
        route_mode: "node_default",
        status: "queued",
        attempts: 0,
        http_status: null,
        error_code: "",
        error_message: "",
        sent_at: null,
        created_at: "2026-11-18T08:00:00.000Z",
        updated_at: "2026-11-18T08:00:00.000Z"
      },
      {
        id: "dlv_push_1",
        source_kind: "native_event",
        source_id: "evt_01PARTIAL",
        trigger_event: "interaction_needed",
        node_id: "macmini",
        channel_kind: "web_push",
        channel_id: "wps_1",
        channel_label: "Chrome",
        target_host: "127.0.0.1",
        route_mode: "web_push",
        status: "queued",
        attempts: 0,
        http_status: null,
        error_code: "",
        error_message: "",
        sent_at: null,
        created_at: "2026-11-18T08:00:00.000Z",
        updated_at: "2026-11-18T08:00:00.000Z"
      }
    ],
    [
      {
        id: "wps_1",
        label: "Chrome",
        endpoint_host: "127.0.0.1",
        subscription_ciphertext: pushFix.subCiphertext
      }
    ]
  );

  const env = {
    DB: mockDb,
    WEBHOOK_ENCRYPTION_KEY: secret,
    HUB_PUBLIC_URL: "https://ahub.bobocai.win",
    ...pushFix.vapidEnv
  };

  let botAcked = false;
  let pushRetried = false;
  await processNotifyBatch(
    {
      messages: [
        {
          attempts: 1,
          body: { kind: "delivery", delivery_id: "dlv_bot_1" },
          ack: () => {
            botAcked = true;
          },
          retry: () => assert.fail("bot delivery succeeded and must not retry")
        },
        {
          attempts: 1,
          body: { kind: "delivery", delivery_id: "dlv_push_1" },
          ack: () => assert.fail("push 503 attempt 1 must retry"),
          retry: () => {
            pushRetried = true;
          }
        }
      ]
    },
    env
  );

  assert.equal(botAcked, true);
  assert.equal(pushRetried, true);
  assert.equal(botHits, 1);
  assert.equal(pushHits, 1);
  assert.equal(mockDb.deliveries.get("dlv_bot_1").status, "sent");
  assert.equal(mockDb.deliveries.get("dlv_push_1").status, "queued");
  assert.equal(mockDb.nativeEvents.get("evt_01PARTIAL").notify_status, "queued");

  // Retry only dlv_push_1 through attempt 5 -> botHits MUST stay 1!
  for (let attempt = 2; attempt <= 5; attempt++) {
    let acked = false;
    let retried = false;
    await processNotifyBatch(
      {
        messages: [
          {
            attempts: attempt,
            body: { kind: "delivery", delivery_id: "dlv_push_1" },
            ack: () => {
              acked = true;
            },
            retry: () => {
              retried = true;
            }
          }
        ]
      },
      env
    );
    if (attempt < 5) {
      assert.equal(retried, true);
      assert.equal(acked, false);
    } else {
      assert.equal(acked, true);
      assert.equal(retried, false);
    }
  }

  assert.equal(botHits, 1, "Bot Webhook MUST NOT be re-triggered while Web Push retries");
  assert.equal(pushHits, 5);
  assert.equal(mockDb.deliveries.get("dlv_push_1").status, "failed");
  assert.equal(mockDb.deliveries.get("dlv_push_1").error_code, "PUSH_UPSTREAM_TIMEOUT");
  assert.equal(mockDb.webPush.get("wps_1").failure_count, 1);
  assert.equal(mockDb.nativeEvents.get("evt_01PARTIAL").notify_status, "partial");
});

test("Web Push 410 auto-revokes subscription without retry and 403 fails without retry or revoke", async (t) => {
  let replyStatus = 410;
  const server = http.createServer((req, res) => {
    res.writeHead(replyStatus, { "Content-Type": "text/plain" });
    res.end(`http-${replyStatus}`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());

  const secret = "push-status-secret";
  const pushFix = await makeVapidAndPushFixture(
    secret,
    `http://127.0.0.1:${server.address().port}/push/s1`
  );

  const mockDb = createMockDb(
    [],
    [],
    [{ id: "macmini" }],
    [
      {
        id: "evt_01EXPIRED",
        node_id: "macmini",
        event_id: "claude:s1:Notification:2222",
        agent: "claude",
        event_kind: "interaction_needed",
        native_session_id: "s1",
        workdir: "/workspace/demo",
        title: "Expired test",
        summary: "Test",
        source: "claude-hook",
        notify_status: "queued",
        created_at: "2026-11-18T08:00:00.000Z"
      },
      {
        id: "evt_01REJECT",
        node_id: "macmini",
        event_id: "claude:s1:Notification:3333",
        agent: "claude",
        event_kind: "interaction_needed",
        native_session_id: "s1",
        workdir: "/workspace/demo",
        title: "Reject test",
        summary: "Test",
        source: "claude-hook",
        notify_status: "queued",
        created_at: "2026-11-18T08:01:00.000Z"
      }
    ],
    [
      {
        id: "dlv_410",
        source_kind: "native_event",
        source_id: "evt_01EXPIRED",
        trigger_event: "interaction_needed",
        node_id: "macmini",
        channel_kind: "web_push",
        channel_id: "wps_410",
        channel_label: "Safari",
        target_host: "127.0.0.1",
        route_mode: "web_push",
        status: "queued",
        attempts: 0,
        http_status: null,
        error_code: "",
        error_message: "",
        sent_at: null,
        created_at: "2026-11-18T08:00:00.000Z",
        updated_at: "2026-11-18T08:00:00.000Z"
      },
      {
        id: "dlv_403",
        source_kind: "native_event",
        source_id: "evt_01REJECT",
        trigger_event: "interaction_needed",
        node_id: "macmini",
        channel_kind: "web_push",
        channel_id: "wps_403",
        channel_label: "Firefox",
        target_host: "127.0.0.1",
        route_mode: "web_push",
        status: "queued",
        attempts: 0,
        http_status: null,
        error_code: "",
        error_message: "",
        sent_at: null,
        created_at: "2026-11-18T08:01:00.000Z",
        updated_at: "2026-11-18T08:01:00.000Z"
      }
    ],
    [
      {
        id: "wps_410",
        label: "Safari",
        endpoint_host: "127.0.0.1",
        subscription_ciphertext: pushFix.subCiphertext
      },
      {
        id: "wps_403",
        label: "Firefox",
        endpoint_host: "127.0.0.1",
        subscription_ciphertext: pushFix.subCiphertext
      }
    ]
  );

  const env = {
    DB: mockDb,
    WEBHOOK_ENCRYPTION_KEY: secret,
    HUB_PUBLIC_URL: "https://ahub.bobocai.win",
    ...pushFix.vapidEnv
  };

  let ack410 = false;
  replyStatus = 410;
  await processNotifyBatch(
    {
      messages: [
        {
          attempts: 1,
          body: { kind: "delivery", delivery_id: "dlv_410" },
          ack: () => {
            ack410 = true;
          },
          retry: () => assert.fail("410 must not retry")
        }
      ]
    },
    env
  );
  assert.equal(ack410, true);
  assert.equal(mockDb.deliveries.get("dlv_410").status, "failed");
  assert.equal(mockDb.deliveries.get("dlv_410").http_status, 410);
  assert.equal(mockDb.deliveries.get("dlv_410").error_code, "SUBSCRIPTION_EXPIRED");
  assert.equal(mockDb.webPush.get("wps_410").enabled, 0);
  assert.ok(mockDb.webPush.get("wps_410").revoked_at);

  let ack403 = false;
  replyStatus = 403;
  await processNotifyBatch(
    {
      messages: [
        {
          attempts: 1,
          body: { kind: "delivery", delivery_id: "dlv_403" },
          ack: () => {
            ack403 = true;
          },
          retry: () => assert.fail("403 must not retry")
        }
      ]
    },
    env
  );
  assert.equal(ack403, true);
  assert.equal(mockDb.deliveries.get("dlv_403").status, "failed");
  assert.equal(mockDb.deliveries.get("dlv_403").http_status, 403);
  assert.equal(mockDb.deliveries.get("dlv_403").error_code, "PUSH_REJECTED_403");
  assert.equal(mockDb.webPush.get("wps_403").enabled, 1);
  assert.equal(mockDb.webPush.get("wps_403").revoked_at, null);
  assert.equal(mockDb.webPush.get("wps_403").failure_count, 1);
});

test("NodeHub broadcasts delivery.updated, run.updated, and native_event.upserted with strict global admin isolation", async (t) => {
  const pushServer = http.createServer((req, res) => {
    res.writeHead(201);
    res.end("created");
  });
  await new Promise((r) => pushServer.listen(0, "127.0.0.1", r));
  t.after(() => pushServer.close());

  const secret = "do-broadcast-secret";
  const pushFix = await makeVapidAndPushFixture(
    secret,
    `http://127.0.0.1:${pushServer.address().port}/push/do`
  );

  const mockDb = createMockDb(
    [
      {
        id: "run_do_1",
        thread_id: "thr_do_1",
        root_run_id: "run_do_1",
        parent_run_id: null,
        depth: 0,
        max_depth: 1,
        node_id: "macmini",
        workdir: "/workspace/demo",
        agent: "agy",
        model: "",
        effort: "",
        sandbox: 1,
        timeout_sec: 900,
        prompt: "run prompt",
        status: "done",
        priority_order: 100,
        resolved_model: "",
        resolved_effort: "",
        native_session_id: null,
        remote_control_url: "",
        summary: "done",
        output_md: "done",
        output_bytes: 4,
        error_code: "",
        error_message: "",
        notify_policy_json: "{}",
        notify_status: "queued",
        lease_expires_at: null,
        started_at: null,
        finished_at: null,
        duration_ms: 10,
        created_at: "2026-11-18T08:00:00.000Z",
        updated_at: "2026-11-18T08:00:00.000Z"
      }
    ],
    [],
    [{ id: "macmini" }],
    [
      {
        id: "evt_do_1",
        node_id: "macmini",
        event_id: "claude:s1:Notification:do1",
        agent: "claude",
        event_kind: "interaction_needed",
        native_session_id: "s1",
        workdir: "/workspace/demo",
        title: "Need input",
        summary: "Confirm action",
        source: "claude-hook",
        notify_key_id: null,
        notify_status: "queued",
        ack_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    ],
    [
      {
        id: "dlv_run_do",
        source_kind: "run",
        source_id: "run_do_1",
        trigger_event: "done",
        node_id: "macmini",
        channel_kind: "web_push",
        channel_id: "wps_do",
        channel_label: "Admin Browser",
        target_host: "127.0.0.1",
        route_mode: "web_push",
        status: "queued",
        attempts: 0,
        http_status: null,
        error_code: "",
        error_message: "",
        sent_at: null,
        created_at: "2026-11-18T08:00:00.000Z",
        updated_at: "2026-11-18T08:00:00.000Z"
      },
      {
        id: "dlv_evt_do",
        source_kind: "native_event",
        source_id: "evt_do_1",
        trigger_event: "interaction_needed",
        node_id: "macmini",
        channel_kind: "web_push",
        channel_id: "wps_do",
        channel_label: "Admin Browser",
        target_host: "127.0.0.1",
        route_mode: "web_push",
        status: "queued",
        attempts: 0,
        http_status: null,
        error_code: "",
        error_message: "",
        sent_at: null,
        created_at: "2026-11-18T08:00:00.000Z",
        updated_at: "2026-11-18T08:00:00.000Z"
      }
    ],
    [
      {
        id: "wps_do",
        label: "Admin Browser",
        endpoint_host: "127.0.0.1",
        subscription_ciphertext: pushFix.subCiphertext
      }
    ]
  );

  function makeStreamSocket(attachment) {
    const frames = [];
    return {
      frames,
      deserializeAttachment() {
        return attachment;
      },
      send(raw) {
        frames.push(JSON.parse(raw));
      }
    };
  }

  const wsAdminGlobal = makeStreamSocket({
    role: "stream",
    runId: null,
    scope: "admin",
    keyId: "key_adm",
    boundNodeId: null,
    allowedNodes: []
  });
  const wsAdminSingleRun = makeStreamSocket({
    role: "stream",
    runId: "run_do_1",
    scope: "admin",
    keyId: "key_adm",
    boundNodeId: null,
    allowedNodes: []
  });
  const wsClientSingleRun = makeStreamSocket({
    role: "stream",
    runId: "run_do_1",
    scope: "client",
    keyId: "key_cli",
    boundNodeId: null,
    allowedNodes: []
  });
  const wsClientGlobalDefense = makeStreamSocket({
    role: "stream",
    runId: null,
    scope: "client",
    keyId: "key_cli",
    boundNodeId: null,
    allowedNodes: []
  });

  const mockCtx = {
    getWebSockets(tag) {
      return tag === "stream"
        ? [wsAdminGlobal, wsAdminSingleRun, wsClientSingleRun, wsClientGlobalDefense]
        : [];
    }
  };
  const doEnv = { DB: mockDb, LEASE_TTL_SECONDS: "90" };
  const nodeHub = new NodeHub(mockCtx, doEnv);

  const env = {
    DB: mockDb,
    WEBHOOK_ENCRYPTION_KEY: secret,
    HUB_PUBLIC_URL: "https://ahub.bobocai.win",
    ...pushFix.vapidEnv,
    NODE_HUB: {
      idFromName(name) {
        return name;
      },
      get() {
        return {
          fetch: (url, init) => nodeHub.fetch(new Request(url, init))
        };
      }
    }
  };

  await processNotifyBatch(
    {
      messages: [
        {
          attempts: 1,
          body: { kind: "delivery", delivery_id: "dlv_run_do" },
          ack() {},
          retry() {
            assert.fail("unexpected retry for run delivery");
          }
        },
        {
          attempts: 1,
          body: { kind: "delivery", delivery_id: "dlv_evt_do" },
          ack() {},
          retry() {
            assert.fail("unexpected retry for event delivery");
          }
        }
      ]
    },
    env
  );

  // Admin global stream receives delivery.updated, run.updated (with deliveries_summary), and native_event.upserted
  const adminTypes = wsAdminGlobal.frames.map((f) => f.type);
  assert.equal(adminTypes.filter((x) => x === "delivery.updated").length, 2);
  const runUpdatedFrame = wsAdminGlobal.frames.find((f) => f.type === "run.updated");
  assert.ok(runUpdatedFrame);
  assert.deepEqual(runUpdatedFrame.run.deliveries_summary, { total: 1, sent: 1, queued: 0, failed: 0 });
  const nativeFrame = wsAdminGlobal.frames.find((f) => f.type === "native_event.upserted");
  assert.ok(nativeFrame);
  assert.equal(nativeFrame.event.id, "evt_do_1");
  assert.equal(nativeFrame.open_interaction_count, 1);

  // Single-run streams receive ONLY run.updated — never delivery.updated or native_event.upserted
  assert.deepEqual(
    wsAdminSingleRun.frames.map((f) => f.type),
    ["run.updated"]
  );
  assert.deepEqual(
    wsClientSingleRun.frames.map((f) => f.type),
    ["run.updated"]
  );

  // Client global defense-in-depth never receives delivery.updated or native_event.upserted
  assert.equal(
    wsClientGlobalDefense.frames.some((f) => f.type === "delivery.updated" || f.type === "native_event.upserted"),
    false
  );
});

test("processNotifyBatch skips non-urgent native deliveries on SUPERSEDED_BY_NEWER_TURN or SESSION_COOLDOWN_ACTIVE unless bypass_coalesce is true", async () => {
  const recentIso = new Date(Date.now() - 10_000).toISOString();
  const t1 = new Date(Date.now() - 5000).toISOString();
  const t2 = new Date(Date.now() - 3000).toISOString();

  const mockDb = createMockDb(
    [],
    [],
    [{ id: "macmini", default_notify_key_id: "key_bot_1" }],
    [
      {
        id: "evt_turn_1",
        node_id: "macmini",
        event_id: "agy:sess_q:1",
        agent: "agy",
        event_kind: "turn_summary",
        native_session_id: "sess_q",
        workdir: "/workspace/demo",
        title: "Turn 1",
        summary: "First",
        source: "agy-hook",
        notify_key_id: "key_bot_1",
        notify_status: "queued",
        notify_error: "",
        ack_at: null,
        created_at: t1,
        updated_at: t1
      },
      {
        id: "evt_turn_2",
        node_id: "macmini",
        event_id: "agy:sess_q:2",
        agent: "agy",
        event_kind: "progress",
        native_session_id: "sess_q",
        workdir: "/workspace/demo",
        title: "Turn 2",
        summary: "Second",
        source: "agy-hook",
        notify_key_id: "key_bot_1",
        notify_status: "queued",
        notify_error: "",
        ack_at: null,
        created_at: t2,
        updated_at: t2
      },
      {
        id: "evt_cool_prev",
        node_id: "macmini",
        event_id: "claude:sess_c:1",
        agent: "claude",
        event_kind: "turn_summary",
        native_session_id: "sess_c",
        workdir: "/workspace/demo",
        title: "Prev",
        summary: "Delivered earlier",
        source: "claude-hook",
        notify_key_id: "key_bot_1",
        notify_status: "sent",
        notify_error: "",
        ack_at: null,
        created_at: t1,
        updated_at: t1
      },
      {
        id: "evt_cool_next",
        node_id: "macmini",
        event_id: "claude:sess_c:2",
        agent: "claude",
        event_kind: "turn_summary",
        native_session_id: "sess_c",
        workdir: "/workspace/demo",
        title: "Next",
        summary: "Hits cooldown",
        source: "claude-hook",
        notify_key_id: "key_bot_1",
        notify_status: "queued",
        notify_error: "",
        ack_at: null,
        created_at: t2,
        updated_at: t2
      }
    ],
    [
      {
        id: "dlv_turn_1",
        source_kind: "native_event",
        source_id: "evt_turn_1",
        trigger_event: "turn_summary",
        node_id: "macmini",
        channel_kind: "bot_webhook",
        channel_id: "key_bot_1",
        channel_label: "bot-1",
        target_host: "hooks.example.com",
        route_mode: "node_default",
        status: "queued",
        attempts: 0,
        http_status: null,
        error_code: "",
        error_message: "",
        sent_at: null,
        created_at: t1,
        updated_at: t1
      },
      {
        id: "dlv_cool_prev",
        source_kind: "native_event",
        source_id: "evt_cool_prev",
        trigger_event: "turn_summary",
        node_id: "macmini",
        channel_kind: "bot_webhook",
        channel_id: "key_bot_1",
        channel_label: "bot-1",
        target_host: "hooks.example.com",
        route_mode: "node_default",
        status: "sent",
        attempts: 1,
        http_status: 200,
        error_code: "",
        error_message: "",
        sent_at: recentIso,
        created_at: t1,
        updated_at: recentIso
      },
      {
        id: "dlv_cool_next",
        source_kind: "native_event",
        source_id: "evt_cool_next",
        trigger_event: "turn_summary",
        node_id: "macmini",
        channel_kind: "bot_webhook",
        channel_id: "key_bot_1",
        channel_label: "bot-1",
        target_host: "hooks.example.com",
        route_mode: "node_default",
        status: "queued",
        attempts: 0,
        http_status: null,
        error_code: "",
        error_message: "",
        sent_at: null,
        created_at: t2,
        updated_at: t2
      },
      {
        id: "dlv_bypass",
        source_kind: "native_event",
        source_id: "evt_turn_1",
        trigger_event: "turn_summary",
        node_id: "macmini",
        channel_kind: "bot_webhook",
        channel_id: "key_bot_1",
        channel_label: "bot-1",
        target_host: "hooks.example.com",
        route_mode: "node_default",
        status: "queued",
        attempts: 0,
        http_status: null,
        error_code: "",
        error_message: "",
        sent_at: null,
        created_at: t1,
        updated_at: t1
      }
    ]
  );

  const env = {
    DB: mockDb,
    WEBHOOK_ENCRYPTION_KEY: "test-encryption-secret-for-unit-suite",
    HUB_PUBLIC_URL: "https://ahub.bobocai.win",
    NATIVE_NOTIFY_COOLDOWN_SEC: "300",
    NODE_HUB: {
      idFromName: () => "global",
      get: () => ({ fetch: async () => new Response("ok") })
    }
  };

  let ackSuperseded = false;
  let ackCooldown = false;
  let ackBypass = false;

  await processNotifyBatch(
    {
      messages: [
        {
          attempts: 1,
          body: { kind: "delivery", delivery_id: "dlv_turn_1" },
          ack() {
            ackSuperseded = true;
          },
          retry() {
            assert.fail("superseded delivery must ack without retry");
          }
        },
        {
          attempts: 1,
          body: { kind: "delivery", delivery_id: "dlv_cool_next" },
          ack() {
            ackCooldown = true;
          },
          retry() {
            assert.fail("cooldown-skipped delivery must ack without retry");
          }
        },
        {
          attempts: 1,
          body: { kind: "delivery", delivery_id: "dlv_bypass", bypass_coalesce: true },
          ack() {
            ackBypass = true;
          },
          retry() {
            assert.fail("bypassed fail-closed delivery must ack without retry");
          }
        }
      ]
    },
    env
  );

  assert.equal(ackSuperseded, true);
  assert.equal(ackCooldown, true);
  assert.equal(ackBypass, true);

  assert.equal(mockDb.deliveries.get("dlv_turn_1").status, "skipped");
  assert.equal(mockDb.deliveries.get("dlv_turn_1").error_code, "SUPERSEDED_BY_NEWER_TURN");

  assert.equal(mockDb.deliveries.get("dlv_cool_next").status, "skipped");
  assert.equal(mockDb.deliveries.get("dlv_cool_next").error_code, "SESSION_COOLDOWN_ACTIVE");

  // bypass_coalesce skips supersede check & proceeds into webhook resolution
  assert.notEqual(mockDb.deliveries.get("dlv_bypass").status, "skipped");
  assert.equal(mockDb.deliveries.get("dlv_bypass").error_code, "CHANNEL_UNBOUND_OR_REVOKED");
});
