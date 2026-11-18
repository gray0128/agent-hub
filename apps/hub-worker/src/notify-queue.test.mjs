import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Resolve bundler-style extensionless TS imports for Node ESM test execution
registerHooks({
  resolve(specifier, context, nextResolve) {
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
  }
});

const { processNotifyBatch } = await import("./notify-queue.ts");
const { encryptWebhookConfig, decryptWebhookConfig } = await import("./webhook-crypto.ts");

function createMockDb(initialRuns, initialKeys = [], initialNodes = [], initialNativeEvents = []) {
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
    initialNativeEvents.map((e) => [e.id, { notify_key_id: null, notify_error: "", ...e }])
  );
  return {
    runs,
    keys,
    nodes,
    nativeEvents,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...params) {
          args = params;
          return stmt;
        },
        async first() {
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
          return null;
        },
        async run() {
          if (sql.includes("UPDATE native_events")) {
            const isFailed = sql.includes("notify_status = 'failed'");
            const id = args[1];
            const ev = nativeEvents.get(id);
            if (ev) {
              ev.notify_status = isFailed ? "failed" : "sent";
              ev.notify_error = isFailed ? "CHANNEL_UNBOUND_OR_REVOKED" : "";
              ev.updated_at = args[0];
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
