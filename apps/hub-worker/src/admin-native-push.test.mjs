import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { registerHooks } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { shortCircuit: true, url: "mock:cloudflare-workers" };
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !specifier.endsWith(".ts") &&
      !specifier.endsWith(".js") &&
      !specifier.endsWith(".md") &&
      !specifier.endsWith(".sh") &&
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
    if (url.startsWith("file://") && (url.endsWith(".md") || url.endsWith(".sh"))) {
      const content = fs.readFileSync(fileURLToPath(url), "utf8");
      return {
        format: "module",
        source: `export default ${JSON.stringify(content)};`,
        shortCircuit: true
      };
    }
    return nextLoad(url, context);
  }
});

const workerModule = await import("./index.ts");
const worker = workerModule.default;
const { NodeHub, buildStreamSnapshotPayload } = await import("./node-hub.ts");
const { sha256Hex } = await import("./ulid.ts");
const { toBase64Url } = await import("./webhook-crypto.ts");

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

function createSqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of migrationFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    sqlite.exec(sql);
  }

  function createStatement(sql, boundArgs = []) {
    return {
      _sql: sql,
      _args: boundArgs,
      bind(...params) {
        return createStatement(sql, params.map((p) => (p === undefined ? null : p)));
      },
      async first() {
        const stmt = sqlite.prepare(sql);
        const row = stmt.get(...boundArgs);
        return row === undefined ? null : { ...row };
      },
      async all() {
        const stmt = sqlite.prepare(sql);
        const rows = stmt.all(...boundArgs);
        return { success: true, results: rows.map((r) => ({ ...r })) };
      },
      async run() {
        const stmt = sqlite.prepare(sql);
        const info = stmt.run(...boundArgs);
        return {
          success: true,
          meta: {
            changes: Number(info.changes ?? 0),
            last_row_id: Number(info.lastInsertRowid ?? 0)
          }
        };
      }
    };
  }

  return {
    sqlite,
    prepare(sql) {
      return createStatement(sql);
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of statements) {
          out.push(await s.run());
        }
        sqlite.exec("COMMIT");
        return out;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    }
  };
}

async function generateVapidEnv() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify"
  ]);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return {
    VAPID_PUBLIC_KEY: toBase64Url(rawPub),
    VAPID_PRIVATE_JWK: JSON.stringify({
      kty: "EC",
      crv: "P-256",
      x: jwk.x,
      y: jwk.y,
      d: jwk.d
    }),
    VAPID_SUBJECT: "mailto:ops@bobocai.win"
  };
}

function createTestHarness({ vapidEnv = {}, allowLoopback = false, retentionDays } = {}) {
  const db = createSqliteD1();
  const queuedMessages = [];
  const streamSockets = [];

  const mockCtx = {
    getWebSockets(tag) {
      if (tag === "stream") {
        return streamSockets;
      }
      return [];
    }
  };

  let nodeHub;
  const env = {
    DB: db,
    HUB_PUBLIC_URL: "https://ahub.bobocai.win",
    DEFAULT_MAX_DEPTH: "1",
    LEASE_TTL_SECONDS: "90",
    WEBHOOK_ENCRYPTION_KEY: "test-encryption-secret-for-unit-suite",
    ...(allowLoopback ? { ALLOW_LOOPBACK_PUSH_FOR_TEST: "true" } : {}),
    ...(retentionDays !== undefined ? { NATIVE_EVENTS_RETENTION_DAYS: retentionDays } : {}),
    ...vapidEnv,
    NOTIFY_QUEUE: {
      async send(msg) {
        queuedMessages.push(msg);
      }
    },
    NODE_HUB: {
      idFromName() {
        return "global";
      },
      get() {
        return {
          fetch(url, init) {
            return nodeHub.fetch(new Request(url, init));
          }
        };
      }
    }
  };
  nodeHub = new NodeHub(mockCtx, env);

  const pendingWaitUntil = [];
  const execCtx = {
    waitUntil(promise) {
      pendingWaitUntil.push(Promise.resolve(promise));
    },
    passThroughOnException() {}
  };

  async function flushWaitUntil() {
    while (pendingWaitUntil.length > 0) {
      const batch = pendingWaitUntil.splice(0, pendingWaitUntil.length);
      await Promise.all(batch);
    }
  }

  function addStreamSocket(attachment) {
    const frames = [];
    streamSockets.push({
      deserializeAttachment() {
        return attachment;
      },
      send(raw) {
        frames.push(JSON.parse(raw));
      }
    });
    return frames;
  }

  async function callApi(method, reqPath, token, body) {
    const init = {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    };
    const resp = await worker.fetch(new Request(`https://ahub.bobocai.win${reqPath}`, init), env, execCtx);
    await flushWaitUntil();
    const json = await resp.json();
    return { status: resp.status, json };
  }

  return {
    db,
    env,
    execCtx,
    queuedMessages,
    addStreamSocket,
    callApi,
    flushWaitUntil
  };
}

async function seedBaseFixtures(harness) {
  const now = "2026-11-18T05:00:00.000Z";
  const adminTok = "ahub_adm_test_admin_secret_0001";
  const clientTok = "ahub_cli_test_client_secret_0001";
  const nodeTok = "ahub_nod_test_node_secret_0001";

  harness.db.sqlite
    .prepare(
      `INSERT INTO nodes (id, display_name, os, arch, version, capabilities_json, workspaces_json, status, max_concurrency, active_runs_count, created_at, updated_at)
       VALUES (?1, ?2, 'darwin', 'arm64', '0.1.6', '{}', '[]', 'online', 4, 0, ?3, ?3)`
    )
    .run("macmini", "Mac mini", now);

  const keys = [
    { id: "key_adm_1", name: "ops-admin", scope: "admin", boundNode: null, tok: adminTok, allowed: "[]" },
    { id: "key_cli_1", name: "bot-client", scope: "client", boundNode: null, tok: clientTok, allowed: '["macmini"]' },
    { id: "key_nod_1", name: "node-macmini", scope: "node", boundNode: "macmini", tok: nodeTok, allowed: "[]" }
  ];
  for (const k of keys) {
    const digest = await sha256Hex(k.tok);
    harness.db.sqlite
      .prepare(
        `INSERT INTO api_keys (id, name, scope, bound_node_id, key_prefix, key_sha256, allowed_nodes_json, allow_unsandboxed, max_depth_limit, notify_webhook_ciphertext, notify_webhook_host, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 1, '', '', ?8)`
      )
      .run(k.id, k.name, k.scope, k.boundNode, k.tok.slice(0, 14), digest, k.allowed, now);
  }

  return { adminTok, clientTok, nodeTok };
}

test("All 12 admin native-activity & web-push routes enforce strict 403 FORBIDDEN_SCOPE for client and node tokens", async () => {
  const harness = createTestHarness();
  const { adminTok, clientTok, nodeTok } = await seedBaseFixtures(harness);

  const validP256dh = toBase64Url(new Uint8Array([0x04, ...new Array(64).fill(0x33)]));
  const validAuth = toBase64Url(new Uint8Array(16).fill(0x44));

  const adminRoutes = [
    { method: "GET", path: "/api/v1/native-events" },
    { method: "GET", path: "/api/v1/native-events/evt_missing" },
    { method: "POST", path: "/api/v1/native-events/evt_missing/ack", body: { scope: "single" } },
    { method: "POST", path: "/api/v1/native-events/evt_missing/redeliver", body: {} },
    { method: "GET", path: "/api/v1/runs/run_missing/deliveries" },
    { method: "POST", path: "/api/v1/runs/run_missing/redeliver", body: {} },
    { method: "GET", path: "/api/v1/push/config" },
    { method: "GET", path: "/api/v1/push-subscriptions" },
    {
      method: "POST",
      path: "/api/v1/push-subscriptions",
      body: {
        label: "Test Device",
        subscription: {
          endpoint: "https://fcm.googleapis.com/fcm/send/sub_forbidden_check",
          keys: { p256dh: validP256dh, auth: validAuth }
        }
      }
    },
    { method: "PATCH", path: "/api/v1/push-subscriptions/wps_missing", body: { enabled: false } },
    { method: "DELETE", path: "/api/v1/push-subscriptions/wps_missing" },
    { method: "POST", path: "/api/v1/push-subscriptions/wps_missing/test", body: {} }
  ];

  for (const tokenLabel of [
    ["client", clientTok],
    ["node", nodeTok]
  ]) {
    const [scopeName, tok] = tokenLabel;
    for (const r of adminRoutes) {
      const res = await harness.callApi(r.method, r.path, tok, r.body);
      assert.equal(
        res.status,
        403,
        `${scopeName} token must receive 403 on ${r.method} ${r.path}, got ${res.status}`
      );
      assert.equal(res.json.ok, false);
      assert.equal(res.json.error.code, "FORBIDDEN_SCOPE");
    }
  }

  const pushCfg = await harness.callApi("GET", "/api/v1/push/config", adminTok);
  assert.equal(pushCfg.status, 200);
  assert.deepEqual(pushCfg.json, {
    ok: true,
    enabled: false,
    vapid_public_key: null,
    reason: "VAPID_NOT_CONFIGURED"
  });

  const subRes = await harness.callApi("POST", "/api/v1/push-subscriptions", adminTok, {
    label: "MacBook Chrome",
    subscription: {
      endpoint: "https://fcm.googleapis.com/fcm/send/sub_admin_secret_path",
      keys: { p256dh: validP256dh, auth: validAuth }
    }
  });
  assert.equal(subRes.status, 201);
  assert.equal(subRes.json.subscription.endpoint_host, "fcm.googleapis.com");
  assert.equal(subRes.json.subscription.endpoint_sha256_prefix.length, 12);
  assert.deepEqual(subRes.json.subscription.event_filter, [
    "run_needs_approval",
    "run_failed",
    "native_interaction_needed"
  ]);

  const listSubs = await harness.callApi("GET", "/api/v1/push-subscriptions", adminTok);
  assert.equal(listSubs.status, 200);
  const rawList = JSON.stringify(listSubs.json);
  assert.equal(rawList.includes("sub_admin_secret_path"), false);
  assert.equal(rawList.includes(validP256dh), false);
  assert.equal(rawList.includes(validAuth), false);
  assert.equal(rawList.includes("subscription_ciphertext"), false);
});

test("POST /api/v1/push-subscriptions enforces SSRF allowlist and /test handles 201, 410 auto-revoke, and missing VAPID", async (t) => {
  const requests = [];
  let gatewayStatus = 201;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, bytes: Buffer.concat(chunks).length });
      res.writeHead(gatewayStatus, { "Content-Type": "text/plain" });
      res.end(gatewayStatus === 410 ? "Gone" : "Created");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const uaKp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const validP256dh = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", uaKp.publicKey)));
  const validAuth = toBase64Url(new Uint8Array(16).fill(0x66));

  // Without ALLOW_LOOPBACK_PUSH_FOR_TEST: loopback & private/arbitrary hosts rejected with 400
  const prodHarness = createTestHarness({ allowLoopback: false });
  const { adminTok: prodAdmin } = await seedBaseFixtures(prodHarness);

  for (const badEndpoint of [
    `http://127.0.0.1:${port}/push`,
    `http://localhost:${port}/push`,
    "https://10.0.0.1/push",
    "https://169.254.169.254/latest/meta-data",
    "https://evil.example/push",
    "https://fcm.googleapis.com.evil.com/fcm/send/x",
    "https://user:pass@fcm.googleapis.com/fcm/send/x"
  ]) {
    const bad = await prodHarness.callApi("POST", "/api/v1/push-subscriptions", prodAdmin, {
      label: "Bad",
      subscription: {
        endpoint: badEndpoint,
        keys: { p256dh: validP256dh, auth: validAuth }
      }
    });
    assert.equal(bad.status, 400, `Expected 400 for SSRF probe ${badEndpoint}, got ${bad.status}`);
  }
  const emptyList = await prodHarness.callApi("GET", "/api/v1/push-subscriptions", prodAdmin);
  assert.equal(emptyList.json.subscriptions.length, 0);

  // Without VAPID, /test returns 400
  const vendorCreate = await prodHarness.callApi("POST", "/api/v1/push-subscriptions", prodAdmin, {
    label: "Vendor Sub",
    subscription: {
      endpoint: "https://fcm.googleapis.com/fcm/send/vendor_1",
      keys: { p256dh: validP256dh, auth: validAuth }
    }
  });
  assert.equal(vendorCreate.status, 201);
  const noVapidTest = await prodHarness.callApi(
    "POST",
    `/api/v1/push-subscriptions/${vendorCreate.json.subscription.id}/test`,
    prodAdmin,
    {}
  );
  assert.equal(noVapidTest.status, 400);

  // With ALLOW_LOOPBACK_PUSH_FOR_TEST + VAPID: loopback succeeds, evil still rejected, /test sends real HTTP Push
  const vapidEnv = await generateVapidEnv();
  const testHarness = createTestHarness({ vapidEnv, allowLoopback: true });
  const { adminTok } = await seedBaseFixtures(testHarness);

  const cfgRes = await testHarness.callApi("GET", "/api/v1/push/config", adminTok);
  assert.equal(cfgRes.status, 200);
  assert.equal(cfgRes.json.enabled, true);
  assert.equal(cfgRes.json.vapid_public_key, vapidEnv.VAPID_PUBLIC_KEY);

  const evilLoop = await testHarness.callApi("POST", "/api/v1/push-subscriptions", adminTok, {
    label: "Evil",
    subscription: {
      endpoint: "https://evil.example/push",
      keys: { p256dh: validP256dh, auth: validAuth }
    }
  });
  assert.equal(evilLoop.status, 400);

  const loopCreate = await testHarness.callApi("POST", "/api/v1/push-subscriptions", adminTok, {
    label: "Local Push Browser",
    subscription: {
      endpoint: `http://127.0.0.1:${port}/push/sub_loop_1`,
      keys: { p256dh: validP256dh, auth: validAuth }
    },
    node_filter: ["macmini"]
  });
  assert.equal(loopCreate.status, 201);
  const subId = loopCreate.json.subscription.id;

  const testOk = await testHarness.callApi("POST", `/api/v1/push-subscriptions/${subId}/test`, adminTok, {});
  assert.equal(testOk.status, 200);
  assert.equal(testOk.json.delivered, true);
  assert.equal(testOk.json.http_status, 201);
  assert.ok(testOk.json.subscription.last_sent_at);
  assert.equal(requests.length, 1);

  const patched = await testHarness.callApi("PATCH", `/api/v1/push-subscriptions/${subId}`, adminTok, {
    label: "Renamed Browser",
    event_filter: ["native_interaction_needed", "native_progress"]
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.subscription.label, "Renamed Browser");
  assert.deepEqual(patched.json.subscription.event_filter, ["native_interaction_needed", "native_progress"]);

  // 410 Gone auto-revokes subscription
  gatewayStatus = 410;
  const testGone = await testHarness.callApi("POST", `/api/v1/push-subscriptions/${subId}/test`, adminTok, {});
  assert.equal(testGone.status, 200);
  assert.equal(testGone.json.delivered, false);
  assert.equal(testGone.json.http_status, 410);
  assert.equal(testGone.json.error_code, "SUBSCRIPTION_EXPIRED");
  assert.ok(testGone.json.subscription.revoked_at);
  assert.equal(testGone.json.subscription.enabled, false);

  const patchRevoked = await testHarness.callApi("PATCH", `/api/v1/push-subscriptions/${subId}`, adminTok, {
    enabled: true
  });
  assert.equal(patchRevoked.status, 409);

  // Re-POST same endpoint revives and clears revoked_at (status 200)
  const revived = await testHarness.callApi("POST", "/api/v1/push-subscriptions", adminTok, {
    label: "Revived Browser",
    subscription: {
      endpoint: `http://127.0.0.1:${port}/push/sub_loop_1`,
      keys: { p256dh: validP256dh, auth: validAuth }
    }
  });
  assert.equal(revived.status, 200);
  assert.equal(revived.json.subscription.id, subId);
  assert.equal(revived.json.subscription.revoked_at, null);
  assert.equal(revived.json.subscription.enabled, true);

  // DELETE revokes idempotently
  const delRes = await testHarness.callApi("DELETE", `/api/v1/push-subscriptions/${subId}`, adminTok);
  assert.equal(delRes.status, 200);
  assert.ok(delRes.json.revoked_at);
});

test("Native activity query, ack (single & session), redeliver, and /ws/stream snapshot + broadcast isolation", async () => {
  const harness = createTestHarness();
  const { adminTok, nodeTok } = await seedBaseFixtures(harness);

  const adminGlobalFrames = harness.addStreamSocket({
    role: "stream",
    runId: null,
    scope: "admin",
    keyId: "key_adm_1",
    boundNodeId: null,
    allowedNodes: []
  });
  const adminRunFrames = harness.addStreamSocket({
    role: "stream",
    runId: "run_only_1",
    scope: "admin",
    keyId: "key_adm_1",
    boundNodeId: null,
    allowedNodes: []
  });
  const clientRunFrames = harness.addStreamSocket({
    role: "stream",
    runId: "run_only_1",
    scope: "client",
    keyId: "key_cli_1",
    boundNodeId: null,
    allowedNodes: ["macmini"]
  });

  // Seed 2 interaction_needed in sess_A, followed by progress in sess_A (via node ingest -> tests broadcast too!)
  const e1 = await harness.callApi("POST", "/api/v1/nodes/macmini/native-events", nodeTok, {
    event_id: "evt_sessA_1_abcdefgh",
    agent: "claude",
    event_kind: "interaction_needed",
    native_session_id: "sess_A",
    workdir: "~/workspace/demo",
    title: "Confirm 1",
    summary: "First prompt",
    source: "claude-hook"
  });
  assert.equal(e1.status, 200);
  assert.equal(adminGlobalFrames.some((f) => f.type === "native_event.upserted" && f.event.id === e1.json.event.id), true);
  assert.equal(adminRunFrames.length, 0);
  assert.equal(clientRunFrames.length, 0);

  // Duplicate event_id must NOT re-broadcast
  const frameCountBeforeDup = adminGlobalFrames.length;
  const e1Dup = await harness.callApi("POST", "/api/v1/nodes/macmini/native-events", nodeTok, {
    event_id: "evt_sessA_1_abcdefgh",
    agent: "claude",
    event_kind: "interaction_needed",
    native_session_id: "sess_A",
    workdir: "~/workspace/demo",
    title: "Confirm 1",
    summary: "First prompt",
    source: "claude-hook"
  });
  assert.equal(e1Dup.status, 200);
  assert.equal(e1Dup.json.deduplicated, true);
  assert.equal(adminGlobalFrames.length, frameCountBeforeDup);

  // Subsequent progress in sess_A supersedes e1
  const e2 = await harness.callApi("POST", "/api/v1/nodes/macmini/native-events", nodeTok, {
    event_id: "evt_sessA_2_prog1234",
    agent: "claude",
    event_kind: "progress",
    native_session_id: "sess_A",
    workdir: "~/workspace/demo",
    title: "Stage 2",
    summary: "Moving forward",
    source: "cli"
  });
  assert.equal(e2.status, 200);
  assert.equal(e2.json.event.event_kind, "progress");
  assert.equal(e2.json.event.attention_state, null);

  // Seed sess_B (2 unacked interaction_needed in same session -> older superseded, newer open), plus empty session & stale (>24h)
  const nowMs = Date.now();
  const staleIso = new Date(nowMs - 26 * 3600 * 1000).toISOString();
  const t1 = new Date(nowMs - 5000).toISOString();
  const t2 = new Date(nowMs - 4000).toISOString();
  const t3 = new Date(nowMs - 3000).toISOString();
  const insertEvt = harness.db.sqlite.prepare(
    `INSERT INTO native_events (id, node_id, event_id, agent, event_kind, native_session_id, workdir, title, summary, source, notify_key_id, notify_status, notify_error, ack_at, created_at, updated_at)
     VALUES (?1, 'macmini', ?2, 'claude', 'interaction_needed', ?3, '~/workspace/demo', ?4, ?5, 'claude-hook', NULL, 'skipped', '', NULL, ?6, ?6)`
  );
  insertEvt.run("evt_01SESSB1", "cli:sessB:1", "sess_B", "SessB Old", "Old B", t1);
  insertEvt.run("evt_01SESSB2", "cli:sessB:2", "sess_B", "SessB New", "New B", t2);
  insertEvt.run("evt_01EMPTY1", "cli:empty:1", "", "Empty Sess", "No session id", t3);
  insertEvt.run("evt_01STALE1", "cli:stale:1", "sess_stale", "Stale", "Old >24h", staleIso);

  const listAll = await harness.callApi("GET", "/api/v1/native-events?limit=10", adminTok);
  assert.equal(listAll.status, 200);
  assert.equal(listAll.json.open_interaction_count, 2); // evt_01SESSB2 and evt_01EMPTY1
  const byId = new Map(listAll.json.events.map((e) => [e.id, e]));
  assert.equal(byId.get(e1.json.event.id).attention_state, "superseded");
  assert.equal(byId.get("evt_01SESSB1").attention_state, "superseded");
  assert.equal(byId.get("evt_01SESSB2").attention_state, "open");
  assert.equal(byId.get("evt_01EMPTY1").attention_state, "open");
  assert.equal(byId.get("evt_01STALE1").attention_state, "stale");

  const listUnacked = await harness.callApi("GET", "/api/v1/native-events?unacked_only=true", adminTok);
  assert.equal(listUnacked.status, 200);
  assert.deepEqual(
    listUnacked.json.events.map((e) => e.id).sort(),
    ["evt_01EMPTY1", "evt_01SESSB2"]
  );

  // Cursor pagination check
  const page1 = await harness.callApi("GET", "/api/v1/native-events?limit=2", adminTok);
  assert.equal(page1.json.events.length, 2);
  assert.ok(page1.json.next_cursor);
  const page2 = await harness.callApi(
    "GET",
    `/api/v1/native-events?limit=2&before_ts=${encodeURIComponent(page1.json.next_cursor.before_ts)}&before_id=${encodeURIComponent(page1.json.next_cursor.before_id)}`,
    adminTok
  );
  assert.equal(page2.json.events.length, 2);
  assert.notEqual(page2.json.events[0].id, page1.json.events[1].id);

  // Build /ws/stream snapshots & verify strict admin global gating
  const adminGlobalSnap = await buildStreamSnapshotPayload(
    harness.env.DB,
    { kind: "api_key", keyId: "key_adm_1", scope: "admin", boundNodeId: null, allowedNodes: [], allowUnsandboxed: true, maxDepthLimit: 3 },
    null
  );
  assert.ok(Array.isArray(adminGlobalSnap.native_events));
  assert.equal(adminGlobalSnap.open_interaction_count, 2);

  const adminRunSnap = await buildStreamSnapshotPayload(
    harness.env.DB,
    { kind: "api_key", keyId: "key_adm_1", scope: "admin", boundNodeId: null, allowedNodes: [], allowUnsandboxed: true, maxDepthLimit: 3 },
    "run_only_1"
  );
  assert.equal("native_events" in adminRunSnap, false);
  assert.equal("open_interaction_count" in adminRunSnap, false);

  const clientRunSnap = await buildStreamSnapshotPayload(
    harness.env.DB,
    { kind: "api_key", keyId: "key_cli_1", scope: "client", boundNodeId: null, allowedNodes: ["macmini"], allowUnsandboxed: true, maxDepthLimit: 1 },
    "run_only_1"
  );
  assert.equal("native_events" in clientRunSnap, false);
  assert.equal("open_interaction_count" in clientRunSnap, false);

  // Ack single on evt_01EMPTY1 -> idempotent on second call
  const ackSingle = await harness.callApi("POST", "/api/v1/native-events/evt_01EMPTY1/ack", adminTok, {
    scope: "single"
  });
  assert.equal(ackSingle.status, 200);
  assert.equal(ackSingle.json.acked_count, 1);
  assert.equal(ackSingle.json.open_interaction_count, 1);
  assert.equal(ackSingle.json.event.attention_state, "acked");

  const ackRepeat = await harness.callApi("POST", "/api/v1/native-events/evt_01EMPTY1/ack", adminTok);
  assert.equal(ackRepeat.status, 200);
  assert.equal(ackRepeat.json.acked_count, 0);

  // Ack session on evt_01SESSB2 -> acks both evt_01SESSB1 & evt_01SESSB2
  const ackSession = await harness.callApi("POST", "/api/v1/native-events/evt_01SESSB2/ack", adminTok, {
    scope: "session"
  });
  assert.equal(ackSession.status, 200);
  assert.equal(ackSession.json.acked_count, 2);
  assert.equal(ackSession.json.open_interaction_count, 0);

  // Seed deliveries on native event & run to test GET /deliveries and POST /redeliver
  const dlvNow = new Date().toISOString();
  harness.db.sqlite
    .prepare(
      `INSERT INTO notification_deliveries (id, source_kind, source_id, trigger_event, node_id, channel_kind, channel_id, channel_label, target_host, route_mode, status, attempts, http_status, error_code, error_message, sent_at, created_at, updated_at)
       VALUES
       ('dlv_01NE1', 'native_event', ?1, 'progress', 'macmini', 'bot_webhook', 'key_cli_1', 'bot-1', 'hooks.x.ai', 'node_default', 'sent', 1, 200, '', '', ?2, ?2, ?2),
       ('dlv_01NE2', 'native_event', ?1, 'progress', 'macmini', 'web_push', 'wps_1', 'Browser', 'fcm.googleapis.com', 'web_push', 'failed', 5, 503, 'PUSH_UPSTREAM_TIMEOUT', '503', NULL, ?2, ?2)`
    )
    .run(e2.json.event.id, dlvNow);

  const detailRes = await harness.callApi("GET", `/api/v1/native-events/${e2.json.event.id}`, adminTok);
  assert.equal(detailRes.status, 200);
  assert.equal(detailRes.json.deliveries.length, 2);

  // Mismatched delivery_id -> 404
  const badRedeliver = await harness.callApi("POST", `/api/v1/native-events/${e2.json.event.id}/redeliver`, adminTok, {
    delivery_id: "dlv_01NOTMINE"
  });
  assert.equal(badRedeliver.status, 404);

  // Redeliver failed channels on native event -> only dlv_01NE2 requeued
  harness.queuedMessages.length = 0;
  const neRedeliver = await harness.callApi("POST", `/api/v1/native-events/${e2.json.event.id}/redeliver`, adminTok, {});
  assert.equal(neRedeliver.status, 200);
  assert.equal(neRedeliver.json.requeued_count, 1);
  assert.equal(neRedeliver.json.event.notify_status, "queued");
  assert.deepEqual(harness.queuedMessages, [{ kind: "delivery", delivery_id: "dlv_01NE2" }]);
  assert.equal(
    adminGlobalFrames.some((f) => f.type === "delivery.updated" && f.delivery.id === "dlv_01NE2" && f.delivery.status === "queued"),
    true
  );

  // Seed thread + run + deliveries and test GET /runs/:id/deliveries & POST /runs/:id/redeliver
  harness.db.sqlite
    .prepare(
      `INSERT INTO threads (id, title, node_id, workdir, project_key, agent, status, pinned, sort_order, created_at, updated_at)
       VALUES ('thr_01RUN1', 'T1', 'macmini', '/workspace/demo', 'demo', 'agy', 'active', 0, 0, ?1, ?1)`
    )
    .run(dlvNow);
  harness.db.sqlite
    .prepare(
      `INSERT INTO runs (id, thread_id, root_run_id, depth, max_depth, node_id, workdir, agent, status, prompt, notify_status, created_at, updated_at)
       VALUES ('run_01RUN1', 'thr_01RUN1', 'run_01RUN1', 0, 1, 'macmini', '/workspace/demo', 'agy', 'failed', 'Run check', 'failed', ?1, ?1)`
    )
    .run(dlvNow);
  harness.db.sqlite
    .prepare(
      `INSERT INTO notification_deliveries (id, source_kind, source_id, trigger_event, node_id, channel_kind, channel_id, channel_label, target_host, route_mode, status, attempts, http_status, error_code, error_message, sent_at, created_at, updated_at)
       VALUES ('dlv_01RUN1', 'run', 'run_01RUN1', 'failed', 'macmini', 'web_push', 'wps_1', 'Browser', 'fcm.googleapis.com', 'web_push', 'failed', 5, 500, 'PUSH_UPSTREAM_TIMEOUT', '500', NULL, ?1, ?1)`
    )
    .run(dlvNow);

  const runDlv = await harness.callApi("GET", "/api/v1/runs/run_01RUN1/deliveries", adminTok);
  assert.equal(runDlv.status, 200);
  assert.equal(runDlv.json.deliveries.length, 1);

  harness.queuedMessages.length = 0;
  const runRedeliver = await harness.callApi("POST", "/api/v1/runs/run_01RUN1/redeliver", adminTok, {
    delivery_id: "dlv_01RUN1"
  });
  assert.equal(runRedeliver.status, 200);
  assert.equal(runRedeliver.json.requeued_count, 1);
  assert.equal(runRedeliver.json.run.notify_status, "queued");
  assert.deepEqual(harness.queuedMessages, [{ kind: "delivery", delivery_id: "dlv_01RUN1" }]);
});

test("scheduled Cron prunes expired native_events and notification_deliveries while preserving fresh native_events, threads, and runs", async () => {
  const harness = createTestHarness({ retentionDays: "30" });
  await seedBaseFixtures(harness);

  const nowMs = Date.now();
  const iso31d = new Date(nowMs - 31 * 86_400_000).toISOString();
  const iso29d = new Date(nowMs - 29 * 86_400_000).toISOString();
  const iso35d = new Date(nowMs - 35 * 86_400_000).toISOString();
  const iso10d = new Date(nowMs - 10 * 86_400_000).toISOString();

  const insEv = harness.db.sqlite.prepare(
    `INSERT INTO native_events (id, node_id, event_id, agent, event_kind, native_session_id, workdir, title, summary, source, notify_status, notify_error, created_at, updated_at)
     VALUES (?1, 'macmini', ?2, 'claude', 'turn_summary', 's1', '~/workspace/demo', 'T', 'S', 'cli', 'sent', '', ?3, ?3)`
  );
  insEv.run("evt_01OLD31", "ev:old31", iso31d);
  insEv.run("evt_01FRESH29", "ev:fresh29", iso29d);
  insEv.run("evt_01FRESH10", "ev:fresh10", iso10d);

  harness.db.sqlite
    .prepare(
      `INSERT INTO threads (id, title, node_id, workdir, project_key, agent, status, pinned, sort_order, created_at, updated_at)
       VALUES ('thr_01OLD35', 'Old Thread', 'macmini', '/workspace/demo', 'demo', 'agy', 'active', 0, 0, ?1, ?1)`
    )
    .run(iso35d);
  harness.db.sqlite
    .prepare(
      `INSERT INTO runs (id, thread_id, root_run_id, depth, max_depth, node_id, workdir, agent, status, prompt, notify_status, created_at, updated_at)
       VALUES ('run_01OLD35', 'thr_01OLD35', 'run_01OLD35', 0, 1, 'macmini', '/workspace/demo', 'agy', 'done', 'Keep me', 'sent', ?1, ?1)`
    )
    .run(iso35d);

  const insDlv = harness.db.sqlite.prepare(
    `INSERT INTO notification_deliveries (id, source_kind, source_id, trigger_event, node_id, channel_kind, channel_id, channel_label, target_host, route_mode, status, attempts, error_code, error_message, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'macmini', 'web_push', 'wps_1', 'Browser', 'fcm.googleapis.com', 'web_push', 'sent', 1, '', '', ?5, ?5)`
  );
  // Linked to expired native_event (even if redelivered recently, deleted with parent native_event)
  insDlv.run("dlv_01OLDNE", "native_event", "evt_01OLD31", "turn_summary", iso10d);
  // Fresh native_event delivery -> kept
  insDlv.run("dlv_01FRESHNE", "native_event", "evt_01FRESH29", "turn_summary", iso29d);
  // Old 35d delivery -> pruned by 30d delivery retention, while run_01OLD35 & thr_01OLD35 stay untouched
  insDlv.run("dlv_01OLDRUN", "run", "run_01OLD35", "failed", iso35d);
  // Recent 10d delivery on old run -> kept
  insDlv.run("dlv_01FRESHRUN", "run", "run_01OLD35", "done", iso10d);

  await worker.scheduled({}, harness.env, harness.execCtx);
  await harness.flushWaitUntil();

  const evIds = harness.db.sqlite.prepare("SELECT id FROM native_events ORDER BY id").all().map((r) => r.id);
  assert.deepEqual(evIds, ["evt_01FRESH10", "evt_01FRESH29"]);

  const dlvIds = harness.db.sqlite.prepare("SELECT id FROM notification_deliveries ORDER BY id").all().map((r) => r.id);
  assert.deepEqual(dlvIds, ["dlv_01FRESHNE", "dlv_01FRESHRUN"]);

  const runRow = harness.db.sqlite.prepare("SELECT id FROM runs WHERE id = 'run_01OLD35'").get();
  const thrRow = harness.db.sqlite.prepare("SELECT id FROM threads WHERE id = 'thr_01OLD35'").get();
  assert.ok(runRow, "runs must NEVER be deleted by native retention cron");
  assert.ok(thrRow, "threads must NEVER be deleted by native retention cron");

  // Custom retention (7 days) prunes 29d event while keeping 10d? Wait: 10d > 7d so 10d is ALSO pruned!
  await worker.scheduled({}, { ...harness.env, NATIVE_EVENTS_RETENTION_DAYS: "7" }, harness.execCtx);
  await harness.flushWaitUntil();
  const remainingAfter7d = harness.db.sqlite.prepare("SELECT id FROM native_events").all();
  assert.equal(remainingAfter7d.length, 0);
});
