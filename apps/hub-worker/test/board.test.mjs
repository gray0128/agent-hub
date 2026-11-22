import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createRequire, registerHooks } from "node:module";
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

const hereDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(hereDir, "../../..");
const migrationsDir = path.resolve(hereDir, "../migrations");

const workerModule = await import("../src/index.ts");
const worker = workerModule.default;
const { NodeHub, buildStreamSnapshotPayload } = await import("../src/node-hub.ts");
const {
  expireOpenBoardQuestions,
  pruneExpiredBoardEvents
} = await import("../src/board.ts");
const { sha256Hex } = await import("../src/ulid.ts");
const { encryptWebhookConfig, toBase64Url } = await import("../src/webhook-crypto.ts");

const require = createRequire(import.meta.url);
const Ajv2020 = require(path.join(repoRoot, "node_modules/ajv/dist/2020.js"));
const addFormats = require(path.join(repoRoot, "node_modules/ajv-formats/dist/index.js"));
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
addFormats(ajv);
const boardSchema = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "docs/schemas/board.schema.json"), "utf8")
);
const wsFramesSchema = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "docs/schemas/ws-frames.schema.json"), "utf8")
);
const validateBoardRoot = ajv.compile(boardSchema);
const validateWsFrame = ajv.compile(wsFramesSchema);

function assertMatchesBoardSchema(payload, label) {
  const ok = validateBoardRoot(payload);
  assert.equal(
    ok,
    true,
    `${label} failed board.schema.json: ${ajv.errorsText(validateBoardRoot.errors)}`
  );
}

function assertMatchesWsSchema(payload, label) {
  const ok = validateWsFrame(payload);
  assert.equal(
    ok,
    true,
    `${label} failed ws-frames.schema.json: ${ajv.errorsText(validateWsFrame.errors)}`
  );
}

function createSqliteD1({ upToMigration } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of migrationFiles) {
    if (upToMigration && file > upToMigration) break;
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

function createTestHarness({
  vapidEnv = {},
  allowLoopback = false,
  boardRetentionDays
} = {}) {
  const db = createSqliteD1();
  const queuedMessages = [];
  const acceptedSockets = [];

  const mockCtx = {
    acceptWebSocket(ws, tags = []) {
      ws._tags = tags;
      acceptedSockets.push(ws);
    },
    getWebSockets(tag) {
      if (!tag) return acceptedSockets;
      return acceptedSockets.filter((ws) => (ws._tags ?? []).includes(tag));
    }
  };

  let nodeHub;
  const env = {
    DB: db,
    HUB_PUBLIC_URL: "https://ahub.bobocai.win",
    DEFAULT_MAX_DEPTH: "1",
    LEASE_TTL_SECONDS: "90",
    WEBHOOK_ENCRYPTION_KEY: "test-encryption-secret-for-board-suite",
    ...(allowLoopback ? { ALLOW_LOOPBACK_PUSH_FOR_TEST: "true" } : {}),
    ...(boardRetentionDays !== undefined ? { BOARD_EVENTS_RETENTION_DAYS: boardRetentionDays } : {}),
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

  function addStreamSocket(attachment, extraTags = []) {
    const frames = [];
    const ws = {
      _tags: ["stream", ...extraTags],
      _attachment: attachment,
      deserializeAttachment() {
        return this._attachment;
      },
      serializeAttachment(nextAtt) {
        this._attachment = nextAtt;
      },
      send(raw) {
        frames.push(JSON.parse(raw));
      }
    };
    acceptedSockets.push(ws);
    return frames;
  }

  async function callApi(method, reqPath, token, body, extraHeaders = {}) {
    const init = {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...extraHeaders
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    };
    const resp = await worker.fetch(new Request(`https://ahub.bobocai.win${reqPath}`, init), env, execCtx);
    await flushWaitUntil();
    const json = await resp.json();
    return { status: resp.status, json };
  }

  async function openWsStream(reqPath, token) {
    const OrigWebSocketPair = globalThis.WebSocketPair;
    const OrigResponse = globalThis.Response;

    class MockWebSocket {
      constructor() {
        this._frames = [];
        this._attachment = null;
        this._tags = [];
      }
      serializeAttachment(att) {
        this._attachment = att;
      }
      deserializeAttachment() {
        return this._attachment;
      }
      send(raw) {
        this._frames.push(JSON.parse(raw));
      }
      close() {}
    }

    globalThis.WebSocketPair = function WebSocketPair() {
      const client = new MockWebSocket();
      const server = new MockWebSocket();
      this[0] = client;
      this[1] = server;
      client._peer = server;
      return { 0: client, 1: server };
    };
    globalThis.Response = class MockResponse extends OrigResponse {
      constructor(body, init) {
        if (init && init.status === 101) {
          return {
            status: 101,
            webSocket: init.webSocket,
            headers: new Headers(init.headers)
          };
        }
        super(body, init);
      }
    };

    try {
      const resp = await worker.fetch(
        new Request(`https://ahub.bobocai.win${reqPath}`, {
          headers: {
            Upgrade: "websocket",
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          }
        }),
        env,
        execCtx
      );
      await flushWaitUntil();
      if (resp.status !== 101) {
        const json = await resp.json();
        return { status: resp.status, json, frames: [] };
      }
      const serverWs = resp.webSocket._peer;
      return { status: 101, frames: serverWs._frames, serverWs };
    } finally {
      globalThis.WebSocketPair = OrigWebSocketPair;
      globalThis.Response = OrigResponse;
    }
  }

  async function drainQueue() {
    let processed = 0;
    while (queuedMessages.length > 0) {
      const msg = queuedMessages.shift();
      await worker.queue(
        {
          messages: [
            {
              body: msg,
              attempts: 1,
              ack() {},
              retry() {}
            }
          ]
        },
        env
      );
      processed++;
    }
    return processed;
  }

  return {
    db,
    env,
    execCtx,
    nodeHub,
    queuedMessages,
    addStreamSocket,
    callApi,
    openWsStream,
    drainQueue,
    flushWaitUntil
  };
}

async function seedBaseFixtures(harness) {
  const now = "2026-11-22T03:00:00.000Z";
  const adminTok = "ahub_adm_board_admin_secret_0001";
  const clientNoneTok = "ahub_cli_board_none_secret_0001";
  const clientProjATok = "ahub_cli_board_proja_secret_0001";
  const clientStarTok = "ahub_cli_board_star_secret_0001";
  const nodeTok = "ahub_nod_board_node_secret_0001";

  harness.db.sqlite
    .prepare(
      `INSERT INTO nodes (id, display_name, os, arch, version, capabilities_json, workspaces_json, status, max_concurrency, active_runs_count, created_at, updated_at)
       VALUES ('macmini', 'Mac mini', 'darwin', 'arm64', '0.1.9', '{}', '[]', 'online', 4, 0, ?1, ?1)`
    )
    .run(now);

  const keys = [
    {
      id: "key_admB1",
      name: "ops-admin",
      scope: "admin",
      boundNode: null,
      tok: adminTok,
      allowedNodes: "[]",
      prefixes: '["*"]'
    },
    {
      id: "key_cliNone1",
      name: "client-no-board",
      scope: "client",
      boundNode: null,
      tok: clientNoneTok,
      allowedNodes: '["macmini"]',
      prefixes: "[]"
    },
    {
      id: "key_cliProjA1",
      name: "client-proja",
      scope: "client",
      boundNode: null,
      tok: clientProjATok,
      allowedNodes: '["macmini"]',
      prefixes: '["proj/a","ops_1"]'
    },
    {
      id: "key_cliStar1",
      name: "client-star",
      scope: "client",
      boundNode: null,
      tok: clientStarTok,
      allowedNodes: '["macmini"]',
      prefixes: '["*"]'
    },
    {
      id: "key_nodB1",
      name: "node-macmini",
      scope: "node",
      boundNode: "macmini",
      tok: nodeTok,
      allowedNodes: "[]",
      prefixes: "[]"
    }
  ];

  for (const k of keys) {
    const digest = await sha256Hex(k.tok);
    harness.db.sqlite
      .prepare(
        `INSERT INTO api_keys (
           id, name, scope, bound_node_id, key_prefix, key_sha256,
           allowed_nodes_json, allowed_board_prefixes_json,
           allow_unsandboxed, max_depth_limit, notify_webhook_ciphertext, notify_webhook_host, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, 1, '', '', ?9)`
      )
      .run(
        k.id,
        k.name,
        k.scope,
        k.boundNode,
        k.tok.slice(0, 14),
        digest,
        k.allowedNodes,
        k.prefixes,
        now
      );
  }

  return { adminTok, clientNoneTok, clientProjATok, clientStarTok, nodeTok };
}

test("0008 migration preserves all 3 notification_deliveries indexes and upgrades only 0006 default web_push_subscriptions", () => {
  const db = createSqliteD1({ upToMigration: "0007_node_default_notify_events.sql" });
  const now = "2026-11-22T01:00:00.000Z";

  // Seed one 0006 default subscription and one user-customized subscription
  db.sqlite
    .prepare(
      `INSERT INTO web_push_subscriptions (
         id, label, endpoint_sha256, endpoint_host, subscription_ciphertext,
         node_filter_json, event_filter_json, enabled, failure_count, created_at, updated_at
       ) VALUES
       ('wps_default_0006', 'Default Browser', 'sha_def', 'fcm.googleapis.com', 'ct', '[]', '["run_needs_approval","run_failed","native_interaction_needed"]', 1, 0, ?1, ?1),
       ('wps_custom_0006', 'Custom Browser', 'sha_cus', 'fcm.googleapis.com', 'ct', '[]', '["run_failed"]', 1, 0, ?1, ?1)`
    )
    .run(now);

  const sql0008 = fs.readFileSync(
    path.join(migrationsDir, "0008_board_coordination_and_questions.sql"),
    "utf8"
  );
  db.sqlite.exec(sql0008);

  const fkRow = db.sqlite.prepare(`PRAGMA foreign_keys`).get();
  assert.equal(fkRow.foreign_keys, 1);

  const indexRows = db.sqlite.prepare(`PRAGMA index_list('notification_deliveries')`).all();
  const indexNames = indexRows.map((r) => r.name);
  assert.equal(indexNames.includes("idx_deliveries_source"), true);
  assert.equal(indexNames.includes("idx_deliveries_status_updated"), true);
  assert.equal(indexNames.includes("idx_deliveries_channel_sent"), true);

  const defaultSub = db.sqlite
    .prepare(`SELECT event_filter_json FROM web_push_subscriptions WHERE id = 'wps_default_0006'`)
    .get();
  assert.deepEqual(JSON.parse(defaultSub.event_filter_json), [
    "run_needs_approval",
    "run_failed",
    "native_interaction_needed",
    "board_question_opened"
  ]);

  const customSub = db.sqlite
    .prepare(`SELECT event_filter_json FROM web_push_subscriptions WHERE id = 'wps_custom_0006'`)
    .get();
  assert.deepEqual(JSON.parse(customSub.event_filter_json), ["run_failed"]);
});

test("Board auth enforces node 403, client Fail-Closed segment-boundary prefix auth, and key CRUD validation", async () => {
  const harness = createTestHarness();
  const { adminTok, clientNoneTok, clientProjATok, clientStarTok, nodeTok } =
    await seedBaseFixtures(harness);

  // Seed topics in proj/a, proj/a/sub, proj/ab, ops_1, opsX1
  for (const [ch, title] of [
    ["proj/a", "Proj A"],
    ["proj/a/sub", "Proj A Sub"],
    ["proj/ab", "Proj AB"],
    ["ops_1", "Ops 1"],
    ["opsx1", "Ops x1"]
  ]) {
    const res = await harness.callApi("POST", "/api/v1/board/topics", adminTok, {
      channel: ch,
      title
    });
    assert.equal(res.status, 201);
    assertMatchesBoardSchema(res.json, `POST /board/topics ${ch}`);
  }
  const topicsRes = await harness.callApi("GET", "/api/v1/board/topics", adminTok);
  assert.equal(topicsRes.status, 200);
  const byChannel = new Map(topicsRes.json.topics.map((t) => [t.channel, t]));
  const topicProjA = byChannel.get("proj/a");
  const topicProjAB = byChannel.get("proj/ab");
  const topicOpsX1 = byChannel.get("opsx1");

  // Open a question on proj/a for answer auth test
  const qRes = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicProjA.id}/messages`,
    adminTok,
    { kind: "question", text_md: "Proceed with release?" }
  );
  assert.equal(qRes.status, 201);
  const qId = qRes.json.message.id;

  // 1. node Scope returns 403 FORBIDDEN_SCOPE on all 9 board routes + /ws/stream
  const boardRoutes = [
    { method: "GET", path: "/api/v1/board/channels" },
    { method: "GET", path: "/api/v1/board/topics" },
    { method: "POST", path: "/api/v1/board/topics", body: { channel: "proj/a", title: "X" } },
    { method: "PATCH", path: `/api/v1/board/topics/${topicProjA.id}`, body: { pinned: true } },
    {
      method: "POST",
      path: "/api/v1/board/topics/reorder",
      body: { channel: "proj/a", status: "todo", ordered_topic_ids: [topicProjA.id] }
    },
    { method: "GET", path: `/api/v1/board/topics/${topicProjA.id}/messages` },
    {
      method: "POST",
      path: `/api/v1/board/topics/${topicProjA.id}/messages`,
      body: { kind: "note", text_md: "hi" }
    },
    {
      method: "POST",
      path: `/api/v1/board/messages/${qId}/answer`,
      body: { answer_text: "yes" }
    },
    { method: "GET", path: "/api/v1/board/events" }
  ];
  for (const r of boardRoutes) {
    const res = await harness.callApi(r.method, r.path, nodeTok, r.body);
    assert.equal(res.status, 403, `node must get 403 on ${r.method} ${r.path}`);
    assert.equal(res.json.error.code, "FORBIDDEN_SCOPE");
    assertMatchesBoardSchema(res.json, `node 403 ${r.method} ${r.path}`);
  }
  const nodeWs = await harness.openWsStream(`/ws/stream?topic_id=${topicProjA.id}`, nodeTok);
  assert.equal(nodeWs.status, 403);
  assert.equal(nodeWs.json.error.code, "FORBIDDEN_SCOPE");

  // 2. client with allowed_board_prefixes=[] fails closed with 403 even on list routes and non-existent :id routes
  for (const p of [
    "/api/v1/board/channels",
    "/api/v1/board/topics",
    "/api/v1/board/events",
    "/api/v1/board/events?topic_id=top_01NONEXISTENT0000000000",
    `/api/v1/board/topics/${topicProjA.id}/messages`,
    "/api/v1/board/topics/top_01NONEXISTENT0000000000/messages"
  ]) {
    const res = await harness.callApi("GET", p, clientNoneTok);
    assert.equal(res.status, 403, `empty prefix client must get 403 on GET ${p}`);
    assert.equal(res.json.error.code, "FORBIDDEN_SCOPE");
  }
  const emptyPatchNonexistent = await harness.callApi(
    "PATCH",
    "/api/v1/board/topics/top_01NONEXISTENT0000000000",
    clientNoneTok,
    { pinned: true }
  );
  assert.equal(emptyPatchNonexistent.status, 403);
  assert.equal(emptyPatchNonexistent.json.error.code, "FORBIDDEN_SCOPE");

  const emptyPostNonexistent = await harness.callApi(
    "POST",
    "/api/v1/board/topics/top_01NONEXISTENT0000000000/messages",
    clientNoneTok,
    { kind: "note", text_md: "probe" }
  );
  assert.equal(emptyPostNonexistent.status, 403);
  assert.equal(emptyPostNonexistent.json.error.code, "FORBIDDEN_SCOPE");

  const emptyPrefixWs = await harness.openWsStream(
    `/ws/stream?topic_id=${topicProjA.id}`,
    clientNoneTok
  );
  assert.equal(emptyPrefixWs.status, 403);
  const emptyPrefixWsNonexistent = await harness.openWsStream(
    "/ws/stream?topic_id=top_01NONEXISTENT0000000000",
    clientNoneTok
  );
  assert.equal(emptyPrefixWsNonexistent.status, 403);
  assert.equal(emptyPrefixWsNonexistent.json.error.code, "FORBIDDEN_SCOPE");

  // 3. Segment-boundary matching: ["proj/a", "ops_1"] allows proj/a, proj/a/sub, ops_1; rejects proj/ab, opsX1
  const allowedChannels = await harness.callApi("GET", "/api/v1/board/channels", clientProjATok);
  assert.equal(allowedChannels.status, 200);
  assertMatchesBoardSchema(allowedChannels.json, "GET /board/channels clientProjA");
  assert.deepEqual(
    allowedChannels.json.channels.map((c) => c.channel).sort(),
    ["ops_1", "proj/a", "proj/a/sub"]
  );

  const allowedTopics = await harness.callApi("GET", "/api/v1/board/topics", clientProjATok);
  assert.equal(allowedTopics.status, 200);
  assert.deepEqual(
    allowedTopics.json.topics.map((t) => t.channel).sort(),
    ["ops_1", "proj/a", "proj/a/sub"]
  );

  const allowedEvents = await harness.callApi("GET", "/api/v1/board/events", clientProjATok);
  assert.equal(allowedEvents.status, 200);
  assert.equal(
    allowedEvents.json.events.every((e) => ["ops_1", "proj/a", "proj/a/sub"].includes(e.channel)),
    true
  );

  // proj/ab must be rejected with 403 and safe error.next hints
  const forbiddenAB = await harness.callApi(
    "GET",
    "/api/v1/board/topics?channel=proj/ab",
    clientProjATok
  );
  assert.equal(forbiddenAB.status, 403);
  assert.equal(forbiddenAB.json.error.code, "FORBIDDEN_SCOPE");
  assert.deepEqual(forbiddenAB.json.error.next, [
    "ahub board read proj/a --json",
    "ahub board read ops_1 --json"
  ]);
  assertMatchesBoardSchema(forbiddenAB.json, "403 with error.next");

  const forbiddenOpsX1 = await harness.callApi(
    "GET",
    `/api/v1/board/topics/${topicOpsX1.id}/messages`,
    clientProjATok
  );
  assert.equal(forbiddenOpsX1.status, 403);

  const forbiddenMsgAB = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicProjAB.id}/messages`,
    clientProjATok,
    { kind: "note", text_md: "should be blocked" }
  );
  assert.equal(forbiddenMsgAB.status, 403);

  // 4. Even client with ["*"] CANNOT answer a question
  const clientAnswer = await harness.callApi(
    "POST",
    `/api/v1/board/messages/${qId}/answer`,
    clientStarTok,
    { answer_text: "I am a client" }
  );
  assert.equal(clientAnswer.status, 403);
  assert.equal(clientAnswer.json.error.code, "FORBIDDEN_SCOPE");

  // 5. Key CRUD: allowed_board_prefixes validation & GET /auth/me strict shape
  const badKeyPrefix = await harness.callApi("POST", "/api/v1/keys", adminTok, {
    name: "bad-prefix-key",
    scope: "client",
    allowed_board_prefixes: ["Proj/Bad"]
  });
  assert.equal(badKeyPrefix.status, 400);

  const nonClientPrefix = await harness.callApi("POST", "/api/v1/keys", adminTok, {
    name: "admin-with-prefix",
    scope: "admin",
    allowed_board_prefixes: ["proj/a"]
  });
  assert.equal(nonClientPrefix.status, 400);

  const createdKey = await harness.callApi("POST", "/api/v1/keys", adminTok, {
    name: "good-board-client",
    scope: "client",
    allowed_board_prefixes: ["proj/demo", "proj/demo", "ops/fleet"]
  });
  assert.equal(createdKey.status, 201);
  assert.deepEqual(createdKey.json.key.allowed_board_prefixes, ["proj/demo", "ops/fleet"]);

  const patchedKey = await harness.callApi(
    "PATCH",
    `/api/v1/keys/${createdKey.json.key.id}`,
    adminTok,
    { allowed_board_prefixes: ["*"] }
  );
  assert.equal(patchedKey.status, 200);
  assert.deepEqual(patchedKey.json.key.allowed_board_prefixes, ["*"]);

  const createdAdminKey = await harness.callApi("POST", "/api/v1/keys", adminTok, {
    name: "extra-board-admin",
    scope: "admin"
  });
  assert.equal(createdAdminKey.status, 201);
  assert.deepEqual(createdAdminKey.json.key.allowed_board_prefixes, []);

  const authMeAdmin = await harness.callApi("GET", "/api/v1/auth/me", adminTok);
  assert.equal(authMeAdmin.status, 200);
  assert.deepEqual(authMeAdmin.json.principal.allowed_board_prefixes, ["*"]);

  const authMeCreatedAdmin = await harness.callApi("GET", "/api/v1/auth/me", createdAdminKey.json.token);
  assert.equal(authMeCreatedAdmin.status, 200);
  assert.deepEqual(authMeCreatedAdmin.json.principal.allowed_board_prefixes, ["*"]);

  const authMe = await harness.callApi("GET", "/api/v1/auth/me", clientProjATok);
  assert.equal(authMe.status, 200);
  assert.deepEqual(Object.keys(authMe.json.principal).sort(), [
    "allow_unsandboxed",
    "allowed_board_prefixes",
    "allowed_nodes",
    "bound_node_id",
    "kind",
    "max_depth_limit",
    "scope"
  ]);
  assert.deepEqual(authMe.json.principal.allowed_board_prefixes, ["proj/a", "ops_1"]);

  const authMeClientNone = await harness.callApi("GET", "/api/v1/auth/me", clientNoneTok);
  assert.equal(authMeClientNone.status, 200);
  assert.deepEqual(authMeClientNone.json.principal.allowed_board_prefixes, []);

  const authMeNode = await harness.callApi("GET", "/api/v1/auth/me", nodeTok);
  assert.equal(authMeNode.status, 200);
  assert.deepEqual(authMeNode.json.principal.allowed_board_prefixes, []);
});

test("Board REST upsert, reorder, idempotency, symmetric redaction, capacity caps, CAS answer race, and state interlock", async () => {
  const harness = createTestHarness();
  const { adminTok, clientProjATok } = await seedBaseFixtures(harness);

  // 1. Upsert on (channel, external_ref)
  const createRes = await harness.callApi("POST", "/api/v1/board/topics", clientProjATok, {
    channel: "proj/a",
    title: "Deploy with secret sk-live-1234567890abcdef",
    external_ref: "cnb:org/demo#42",
    status: "todo",
    labels: { token_hint: "ahub_cli_secret123456" },
    upsert: true
  });
  assert.equal(createRes.status, 201);
  assert.equal(createRes.json.created, true);
  assert.equal(createRes.json.topic.title.includes("sk-live-"), false);
  assert.equal(createRes.json.topic.title.includes("[REDACTED]"), true);
  assert.equal(createRes.json.topic.labels.token_hint, "ahub_cli_[REDACTED]");
  assertMatchesBoardSchema(createRes.json, "POST /board/topics created");
  const topicId = createRes.json.topic.id;

  const upsertHit = await harness.callApi("POST", "/api/v1/board/topics", clientProjATok, {
    channel: "proj/a",
    title: "Should not overwrite",
    external_ref: "cnb:org/demo#42",
    upsert: true
  });
  assert.equal(upsertHit.status, 200);
  assert.equal(upsertHit.json.created, false);
  assert.equal(upsertHit.json.topic.id, topicId);
  assert.equal(upsertHit.json.topic.title, createRes.json.topic.title);

  const conflictNoUpsert = await harness.callApi("POST", "/api/v1/board/topics", clientProjATok, {
    channel: "proj/a",
    title: "Duplicate",
    external_ref: "cnb:org/demo#42",
    upsert: false
  });
  assert.equal(conflictNoUpsert.status, 409);
  assert.equal(conflictNoUpsert.json.error.code, "INVALID_STATE_TRANSITION");
  assert.deepEqual(conflictNoUpsert.json.error.next, [
    "ahub board read proj/a --ref cnb:org/demo#42 --json"
  ]);

  // 2. Validation bounds: reject kind=answer, text_md > 8192, data > 32KB, options > 8, bad actor_profile
  const badKind = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicId}/messages`,
    adminTok,
    { kind: "answer", text_md: "no" }
  );
  assert.equal(badKind.status, 400);

  const ok8192Emoji = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicId}/messages`,
    clientProjATok,
    { kind: "note", text_md: "😀".repeat(8192) }
  );
  assert.equal(ok8192Emoji.status, 201);

  const tooLongText = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicId}/messages`,
    clientProjATok,
    { kind: "note", text_md: "a".repeat(8193) }
  );
  assert.equal(tooLongText.status, 400);

  const tooBigData = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicId}/messages`,
    clientProjATok,
    { kind: "handoff", text_md: "big", data: { blob: "x".repeat(32770) } }
  );
  assert.equal(tooBigData.status, 400);

  const tooManyOptions = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicId}/messages`,
    clientProjATok,
    {
      kind: "question",
      text_md: "Too many?",
      question_options: ["1", "2", "3", "4", "5", "6", "7", "8", "9"]
    }
  );
  assert.equal(tooManyOptions.status, 400);

  const badProfile = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicId}/messages`,
    clientProjATok,
    { kind: "note", text_md: "hi", actor_profile: "INVALID PROFILE!" }
  );
  assert.equal(badProfile.status, 400);

  // 3. Handoff snapshot hydration + recursive redaction + idempotency
  const handoffRes = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicId}/messages`,
    clientProjATok,
    {
      kind: "handoff",
      text_md: "Use $SAFE_ENV and ignore ahub_adm_rawsecret9999",
      data: {
        branch: "feat/board",
        nested: [{ secret: "ghp_1234567890abcdefghij" }]
      },
      actor_profile: "codex@mbp",
      source_node: "macmini",
      topic_status: "in_progress",
      idempotency_key: "idem-handoff-0001"
    }
  );
  assert.equal(handoffRes.status, 201);
  assert.equal(handoffRes.json.deduplicated, false);
  assert.equal(handoffRes.json.topic.status, "in_progress");
  assert.equal(handoffRes.json.topic.latest_handoff.id, handoffRes.json.message.id);
  assert.equal(handoffRes.json.message.text_md.includes("$SAFE_ENV"), true);
  assert.equal(handoffRes.json.message.text_md.includes("ahub_adm_rawsecret9999"), false);
  assert.equal(handoffRes.json.message.data.nested[0].secret, "[REDACTED]");
  assertMatchesBoardSchema(handoffRes.json, "POST handoff");

  // Retry identical idempotency key -> 200 deduplicated: true
  const idemRetry = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicId}/messages`,
    clientProjATok,
    {
      kind: "handoff",
      text_md: "Use $SAFE_ENV and ignore ahub_adm_rawsecret9999",
      data: {
        branch: "feat/board",
        nested: [{ secret: "ghp_1234567890abcdefghij" }]
      },
      idempotency_key: "idem-handoff-0001"
    }
  );
  assert.equal(idemRetry.status, 200);
  assert.equal(idemRetry.json.deduplicated, true);
  assert.equal(idemRetry.json.message.id, handoffRes.json.message.id);

  // Different payload with same key -> 409 IDEMPOTENCY_CONFLICT
  const idemConflict = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicId}/messages`,
    clientProjATok,
    {
      kind: "handoff",
      text_md: "Changed text",
      idempotency_key: "idem-handoff-0001"
    }
  );
  assert.equal(idemConflict.status, 409);
  assert.equal(idemConflict.json.error.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(idemConflict.json.error.next.includes(`ahub board read --topic ${topicId} --json`), true);

  // 4. Question interlock: in_progress -> blocked (previous_status='in_progress'), 2nd question keeps previous_status
  const q1Res = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicId}/messages`,
    clientProjATok,
    {
      kind: "question",
      text_md: "Question 1 with key sk-proj-secret1234567890",
      question_options: ["Yes with ahub_cli_abcdef1234", "No"],
      actor_profile: "agy@macmini",
      source_node: "macmini"
    }
  );
  assert.equal(q1Res.status, 201);
  assert.equal(q1Res.json.topic.status, "blocked");
  assert.equal(q1Res.json.topic.previous_status, "in_progress");
  assert.equal(q1Res.json.message.question_state, "open");
  assert.equal(q1Res.json.message.text_md.includes("sk-proj-secret"), false);
  assert.equal(q1Res.json.message.question_options[0], "Yes with ahub_cli_[REDACTED]");

  const q2Res = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicId}/messages`,
    clientProjATok,
    { kind: "question", text_md: "Question 2?" }
  );
  assert.equal(q2Res.status, 201);
  assert.equal(q2Res.json.topic.status, "blocked");
  assert.equal(q2Res.json.topic.previous_status, "in_progress");
  assert.equal(q2Res.json.topic.open_question_count, 2);

  // 5. Concurrent CAS race on q1: only 1 admin wins, loser gets 409; topic stays blocked because q2 is still open
  const [ansA, ansB] = await Promise.all([
    harness.callApi("POST", `/api/v1/board/messages/${q1Res.json.message.id}/answer`, adminTok, {
      selected_option: "No",
      actor_profile: "admin-1"
    }),
    harness.callApi("POST", `/api/v1/board/messages/${q1Res.json.message.id}/answer`, adminTok, {
      answer_text: "Second caller",
      actor_profile: "admin-2"
    })
  ]);
  const statuses = [ansA.status, ansB.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const winner = ansA.status === 200 ? ansA : ansB;
  const loser = ansA.status === 409 ? ansA : ansB;
  assert.equal(loser.json.error.code, "INVALID_STATE_TRANSITION");
  assert.equal(loser.json.error.next.includes(`ahub board read --topic ${topicId} --json`), true);
  assertMatchesBoardSchema(winner.json, "POST /answer winner");
  assert.equal(winner.json.topic.status, "blocked");
  assert.equal(winner.json.topic.previous_status, "in_progress");
  assert.equal(winner.json.question.answered_message_id, winner.json.answer.id);

  // Answering q2 restores topic to 'in_progress' and clears previous_status
  const ansQ2 = await harness.callApi(
    "POST",
    `/api/v1/board/messages/${q2Res.json.message.id}/answer`,
    adminTok,
    {
      answer_text: "Done, also hide xai-1234567890abcdef",
      actor_profile: "admin-web"
    }
  );
  assert.equal(ansQ2.status, 200);
  assert.equal(ansQ2.json.topic.status, "in_progress");
  assert.equal(ansQ2.json.topic.previous_status, "");
  assert.equal(ansQ2.json.answer.text_md.includes("xai-"), false);
  assertMatchesBoardSchema(ansQ2.json, "POST /answer q2");

  // 6. Asking on a 'done' topic transitions to 'blocked' with previous_status='', and answering restores 'in_progress'
  const patchDone = await harness.callApi("PATCH", `/api/v1/board/topics/${topicId}`, adminTok, {
    status: "done"
  });
  assert.equal(patchDone.status, 200);
  assert.equal(patchDone.json.topic.status, "done");
  assert.equal(patchDone.json.topic.previous_status, "");

  const qOnDone = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicId}/messages`,
    adminTok,
    { kind: "question", text_md: "Reopen?" }
  );
  assert.equal(qOnDone.status, 201);
  assert.equal(qOnDone.json.topic.status, "blocked");
  assert.equal(qOnDone.json.topic.previous_status, "");

  const ansOnDone = await harness.callApi(
    "POST",
    `/api/v1/board/messages/${qOnDone.json.message.id}/answer`,
    adminTok,
    { answer_text: "Yes" }
  );
  assert.equal(ansOnDone.status, 200);
  assert.equal(ansOnDone.json.topic.status, "in_progress");

  // 7. Reorder topics
  const t2 = await harness.callApi("POST", "/api/v1/board/topics", clientProjATok, {
    channel: "proj/a",
    title: "Topic 2"
  });
  const tOtherChannel = await harness.callApi("POST", "/api/v1/board/topics", adminTok, {
    channel: "proj/b",
    title: "Topic B"
  });
  const badReorder = await harness.callApi("POST", "/api/v1/board/topics/reorder", adminTok, {
    channel: "proj/a",
    status: "in_progress",
    ordered_topic_ids: [topicId, tOtherChannel.json.topic.id]
  });
  assert.equal(badReorder.status, 409);

  const goodReorder = await harness.callApi("POST", "/api/v1/board/topics/reorder", clientProjATok, {
    channel: "proj/a",
    status: "in_progress",
    ordered_topic_ids: [t2.json.topic.id, topicId]
  });
  assert.equal(goodReorder.status, 200);
  assertMatchesBoardSchema(goodReorder.json, "POST /board/topics/reorder");
  assert.deepEqual(
    goodReorder.json.topics.map((t) => [t.id, t.sort_order]),
    [
      [t2.json.topic.id, 100],
      [topicId, 200]
    ]
  );

  // 8. GET messages & events match schemas
  const msgsRes = await harness.callApi(
    "GET",
    `/api/v1/board/topics/${topicId}/messages?after_seq=0&limit=50`,
    clientProjATok
  );
  assert.equal(msgsRes.status, 200);
  assertMatchesBoardSchema(msgsRes.json, "GET /board/topics/:id/messages");

  const evsRes = await harness.callApi(
    "GET",
    `/api/v1/board/events?topic_id=${topicId}&after_cursor=0&limit=100`,
    clientProjATok
  );
  assert.equal(evsRes.status, 200);
  assertMatchesBoardSchema(evsRes.json, "GET /board/events");
});

test("Push Boundary: ONLY kind=question enqueues NOTIFY_QUEUE, source_node='' avoids 'board' node_filter trap, and Web Push + Bot Webhook deliver", async (t) => {
  const pushRequests = [];
  const webhookRequests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/push-all" || req.url === "/push-board-filter") {
        pushRequests.push({
          url: req.url,
          urgency: req.headers["urgency"],
          bytes: Buffer.concat(chunks).length
        });
        res.writeHead(201, { "Content-Type": "text/plain" });
        res.end("Created");
        return;
      }
      if (req.url === "/bot-webhook") {
        webhookRequests.push({
          auth: req.headers["authorization"],
          body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const vapidEnv = await generateVapidEnv();
  const harness = createTestHarness({ vapidEnv, allowLoopback: true });
  const { adminTok } = await seedBaseFixtures(harness);

  // Create Web Push subscriptions:
  // 1) node_filter: [] (matches all, including source_node = "")
  // 2) node_filter: ["board"] (MUST NOT match source_node = ""!)
  const kp1 = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const kp2 = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const authBytes = toBase64Url(new Uint8Array(16).fill(0x55));

  const subAll = await harness.callApi("POST", "/api/v1/push-subscriptions", adminTok, {
    label: "All Nodes Push",
    subscription: {
      endpoint: `http://127.0.0.1:${port}/push-all`,
      keys: {
        p256dh: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", kp1.publicKey))),
        auth: authBytes
      }
    },
    node_filter: []
  });
  assert.equal(subAll.status, 201);

  const subBoardTrap = await harness.callApi("POST", "/api/v1/push-subscriptions", adminTok, {
    label: "Literal Board Node Filter",
    subscription: {
      endpoint: `http://127.0.0.1:${port}/push-board-filter`,
      keys: {
        p256dh: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", kp2.publicKey))),
        auth: authBytes
      }
    },
    node_filter: ["board"],
    event_filter: ["board_question_opened"]
  });
  assert.equal(subBoardTrap.status, 201);

  // Bind a client Bot Webhook to macmini (default 7-item events WITHOUT board_question_opened)
  const enc = await encryptWebhookConfig(harness.env.WEBHOOK_ENCRYPTION_KEY, {
    url: `http://127.0.0.1:${port}/bot-webhook`,
    key: "bot-secret-key"
  });
  harness.db.sqlite
    .prepare(
      `UPDATE api_keys SET notify_webhook_ciphertext = ?1, notify_webhook_host = '127.0.0.1' WHERE id = 'key_cliStar1'`
    )
    .run(enc.ciphertext);
  const patchMac = await harness.callApi("PATCH", "/api/v1/nodes/macmini", adminTok, {
    default_notify_key_id: "key_cliStar1"
  });
  assert.equal(patchMac.status, 200);

  const topicRes = await harness.callApi("POST", "/api/v1/board/topics", adminTok, {
    channel: "proj/demo",
    title: "Push Boundary Check"
  });
  const topicId = topicRes.json.topic.id;

  // 1. note, handoff, artifact MUST produce ZERO notification_deliveries and ZERO NOTIFY_QUEUE messages
  for (const kind of ["note", "handoff", "artifact"]) {
    const r = await harness.callApi("POST", `/api/v1/board/topics/${topicId}/messages`, adminTok, {
      kind,
      text_md: `Message kind ${kind}`,
      source_node: "macmini"
    });
    assert.equal(r.status, 201);
  }
  assert.equal(harness.queuedMessages.length, 0);
  const dlvCountBefore = harness.db.sqlite
    .prepare(`SELECT COUNT(*) AS cnt FROM notification_deliveries`)
    .get().cnt;
  assert.equal(dlvCountBefore, 0);

  // 2. question with source_node = "" -> matches subAll ONLY (NOT subBoardTrap), node_id='board' in DB
  const qNoNode = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicId}/messages`,
    adminTok,
    {
      kind: "question",
      text_md: "No node question with secret sk-live-9876543210abcdef"
    }
  );
  assert.equal(qNoNode.status, 201);
  assert.equal(harness.queuedMessages.length, 1);

  const dlvRow = harness.db.sqlite
    .prepare(`SELECT * FROM notification_deliveries WHERE source_id = ?1`)
    .get(qNoNode.json.message.id);
  assert.equal(dlvRow.source_kind, "board_message");
  assert.equal(dlvRow.trigger_event, "question_opened");
  assert.equal(dlvRow.node_id, "board");
  assert.equal(dlvRow.channel_id, subAll.json.subscription.id);

  await harness.drainQueue();
  assert.equal(pushRequests.length, 1);
  assert.equal(pushRequests[0].url, "/push-all");
  assert.equal(pushRequests[0].urgency, "high");
  assert.equal(webhookRequests.length, 0);

  // 3. question with source_node = "macmini" BEFORE enabling board_question_opened on macmini -> Web Push only
  const qMacDefault = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicId}/messages`,
    adminTok,
    {
      kind: "question",
      text_md: "Macmini question without opt-in",
      source_node: "macmini"
    }
  );
  assert.equal(qMacDefault.status, 201);
  await harness.drainQueue();
  assert.equal(pushRequests.length, 2);
  assert.equal(webhookRequests.length, 0);

  // 4. Enable board_question_opened on macmini -> triggers BOTH Web Push and Bot Webhook
  const enableBotBoard = await harness.callApi("PATCH", "/api/v1/nodes/macmini", adminTok, {
    default_notify_events: ["native_interaction_needed", "board_question_opened"]
  });
  assert.equal(enableBotBoard.status, 200);

  const qMacOptIn = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicId}/messages`,
    adminTok,
    {
      kind: "question",
      text_md: "Macmini opted-in question with ahub_cli_secret9999",
      actor_profile: "agy-worker",
      source_node: "macmini"
    }
  );
  assert.equal(qMacOptIn.status, 201);
  await harness.drainQueue();
  assert.equal(pushRequests.length, 3);
  assert.equal(webhookRequests.length, 1);
  assert.equal(webhookRequests[0].auth, "Bearer bot-secret-key");
  assert.equal(webhookRequests[0].body.event, "ahub_board_question");
  assert.equal(webhookRequests[0].body.message_id, qMacOptIn.json.message.id);
  assert.equal(webhookRequests[0].body.text_md.includes("ahub_cli_secret9999"), false);
});

test("NodeHub /ws/stream supports topic_id after_cursor replay, strict isolation, and global admin open_board_question_count", async () => {
  const harness = createTestHarness();
  const { adminTok, clientProjATok } = await seedBaseFixtures(harness);

  // Create two topics in proj/a and one run for run_id stream isolation check
  const t1Res = await harness.callApi("POST", "/api/v1/board/topics", adminTok, {
    channel: "proj/a",
    title: "Topic 1"
  });
  const t2Res = await harness.callApi("POST", "/api/v1/board/topics", adminTok, {
    channel: "proj/a",
    title: "Topic 2"
  });
  const t1Id = t1Res.json.topic.id;
  const t2Id = t2Res.json.topic.id;
  const cursorAfterCreate = t1Res.json.topic.last_event_cursor;

  // Post a question and answer it while client is "disconnected"
  const qRes = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${t1Id}/messages`,
    clientProjATok,
    { kind: "question", text_md: "Need approval?" }
  );
  const ansRes = await harness.callApi(
    "POST",
    `/api/v1/board/messages/${qRes.json.message.id}/answer`,
    adminTok,
    { answer_text: "Approved" }
  );
  assert.equal(ansRes.status, 200);

  // Reject combining run_id and topic_id
  const badCombine = await harness.openWsStream(
    `/ws/stream?run_id=run_123&topic_id=${t1Id}`,
    adminTok
  );
  assert.equal(badCombine.status, 400);

  // 1. Reconnect topic_id stream with after_cursor -> snapshot + missed frames in order, zero open_board_question_count
  const wsTopic = await harness.openWsStream(
    `/ws/stream?topic_id=${t1Id}&after_cursor=${cursorAfterCreate}`,
    clientProjATok
  );
  assert.equal(wsTopic.status, 101);
  assert.equal(wsTopic.frames.length, 3);
  assert.equal(wsTopic.frames[0].type, "snapshot");
  assert.equal("open_board_question_count" in wsTopic.frames[0], false);
  assert.equal("native_events" in wsTopic.frames[0], false);
  assert.equal("open_interaction_count" in wsTopic.frames[0], false);
  assert.deepEqual(wsTopic.frames[0].nodes, []);
  assert.equal(wsTopic.frames[0].topic.id, t1Id);

  assert.equal(wsTopic.frames[1].type, "board.message_created");
  assert.equal(wsTopic.frames[1].message.id, qRes.json.message.id);
  assert.equal("open_board_question_count" in wsTopic.frames[1], false);

  assert.equal(wsTopic.frames[2].type, "board.question_answered");
  assert.equal(wsTopic.frames[2].question.id, qRes.json.message.id);
  assert.equal(wsTopic.frames[2].answer.id, ansRes.json.answer.id);
  assert.equal("open_board_question_count" in wsTopic.frames[2], false);

  for (const frame of wsTopic.frames) {
    assertMatchesWsSchema(frame, `topic replay frame ${frame.type}`);
  }

  // 2. Live broadcast isolation: global admin vs topic_1 vs run_1
  const globalAdminFrames = harness.addStreamSocket({
    role: "stream",
    runId: null,
    topicId: null,
    scope: "admin",
    keyId: "key_admB1",
    boundNodeId: null,
    allowedNodes: []
  });
  const runFrames = harness.addStreamSocket(
    {
      role: "stream",
      runId: "run_isolated_1",
      topicId: null,
      scope: "client",
      keyId: "key_cliProjA1",
      boundNodeId: null,
      allowedNodes: ["macmini"]
    },
    ["run:run_isolated_1"]
  );
  const topic1Frames = wsTopic.frames;
  topic1Frames.length = 0; // clear replay frames

  // Broadcast to t2 (must appear on globalAdmin, NOT on topic1Frames or runFrames)
  await harness.callApi("POST", `/api/v1/board/topics/${t2Id}/messages`, clientProjATok, {
    kind: "question",
    text_md: "Topic 2 question"
  });
  // Broadcast node status (must appear on globalAdmin, NOT on topic1Frames)
  await harness.callApi("PATCH", "/api/v1/nodes/macmini", adminTok, {
    display_name: "Mac mini Updated"
  });
  // Broadcast to t1 (must appear on BOTH globalAdmin with open_board_question_count AND topic1Frames WITHOUT open_board_question_count)
  await harness.callApi("POST", `/api/v1/board/topics/${t1Id}/messages`, clientProjATok, {
    kind: "note",
    text_md: "Topic 1 live note"
  });

  assert.equal(
    globalAdminFrames.some((f) => f.type === "board.message_created" && f.message.topic_id === t2Id),
    true
  );
  assert.equal(
    globalAdminFrames.some(
      (f) =>
        f.type === "board.message_created" &&
        f.message.topic_id === t1Id &&
        f.open_board_question_count === 1
    ),
    true
  );

  assert.equal(runFrames.some((f) => f.type.startsWith("board.")), false);
  assert.equal(topic1Frames.length, 1);
  assert.equal(topic1Frames[0].type, "board.message_created");
  assert.equal(topic1Frames[0].message.topic_id, t1Id);
  assert.equal("open_board_question_count" in topic1Frames[0], false);
  assert.equal(
    topic1Frames.some((f) => f.type === "node.status"),
    false
  );

  // 3. buildStreamSnapshotPayload for global admin includes open_board_question_count
  const adminSnap = await buildStreamSnapshotPayload(
    harness.db,
    {
      kind: "api_key",
      keyId: "key_admB1",
      scope: "admin",
      boundNodeId: null,
      allowedNodes: [],
      allowedBoardPrefixes: ["*"],
      allowUnsandboxed: true,
      maxDepthLimit: 3
    },
    null,
    null
  );
  assert.equal(adminSnap.open_board_question_count, 1);
  assertMatchesWsSchema(adminSnap, "global admin snapshot");
});

test("Cron expireOpenBoardQuestions restores topic status and pruneExpiredBoardEvents deletes old events without deleting topics/messages", async () => {
  const harness = createTestHarness({ boardRetentionDays: "90" });
  const { adminTok } = await seedBaseFixtures(harness);

  const topicRes = await harness.callApi("POST", "/api/v1/board/topics", adminTok, {
    channel: "proj/cron",
    title: "Cron Expiry Topic",
    status: "todo"
  });
  const topicId = topicRes.json.topic.id;

  const qRes = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicId}/messages`,
    adminTok,
    {
      kind: "question",
      text_md: "Will expire",
      question_expires_sec: 600
    }
  );
  const qId = qRes.json.message.id;

  // Move question_expires_at and an old board_event into the past
  const pastExpireIso = new Date(Date.now() - 60_000).toISOString();
  const oldEventIso = new Date(Date.now() - 95 * 86_400_000).toISOString();
  harness.db.sqlite
    .prepare(`UPDATE board_messages SET question_expires_at = ?1 WHERE id = ?2`)
    .run(pastExpireIso, qId);
  harness.db.sqlite
    .prepare(`UPDATE board_events SET created_at = ?1 WHERE topic_id = ?2 AND event_type = 'topic.created'`)
    .run(oldEventIso, topicId);

  const globalAdminFrames = harness.addStreamSocket({
    role: "stream",
    runId: null,
    topicId: null,
    scope: "admin",
    keyId: "key_admB1",
    boundNodeId: null,
    allowedNodes: []
  });

  await worker.scheduled({}, harness.env, harness.execCtx);
  await harness.flushWaitUntil();

  // Expired question transitioned to 'expired' and topic restored to 'todo'
  const msgsAfter = await harness.callApi(
    "GET",
    `/api/v1/board/topics/${topicId}/messages`,
    adminTok
  );
  assert.equal(msgsAfter.json.topic.status, "todo");
  assert.equal(msgsAfter.json.topic.previous_status, "");
  assert.equal(msgsAfter.json.messages[0].question_state, "expired");
  assert.equal(
    globalAdminFrames.some((f) => f.type === "board.topic_updated" && f.topic.status === "todo"),
    true
  );

  // Old (>90d) board_event pruned; fresh events, topic, and message permanently preserved
  const evAfter = await harness.callApi(
    "GET",
    `/api/v1/board/events?topic_id=${topicId}`,
    adminTok
  );
  assert.deepEqual(
    evAfter.json.events.map((e) => e.event_type),
    ["question.opened", "question.expired"]
  );
  assert.equal(msgsAfter.json.messages.length, 1);

  // Direct helper unit check
  const pruneAgain = await pruneExpiredBoardEvents(harness.db, 90, 500);
  assert.equal(pruneAgain.deletedEvents, 0);
  const expAgain = await expireOpenBoardQuestions(harness.db);
  assert.equal(expAgain.length, 0);
});

test("Board regression: deep data redaction, key-context redaction, secret external_ref 409 error.next, and explicit empty actor_profile/source_node", async () => {
  const harness = createTestHarness();
  const { adminTok, clientProjATok } = await seedBaseFixtures(harness);

  const topicRes = await harness.callApi("POST", "/api/v1/board/topics", clientProjATok, {
    channel: "proj/a",
    title: "Redaction & Validation Hardening"
  });
  assert.equal(topicRes.status, 201);
  const topicId = topicRes.json.topic.id;

  // 1. 35-level nested object & 34-level nested array containing sk-live-... must be redacted
  let deepObj = { secret: "sk-live-deepsecret1234567890" };
  for (let i = 0; i < 35; i++) {
    deepObj = { nested: deepObj };
  }
  let deepArr = ["sk-live-arraysecret1234567890"];
  for (let i = 0; i < 34; i++) {
    deepArr = [deepArr];
  }
  const deepPost = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicId}/messages`,
    clientProjATok,
    {
      kind: "note",
      text_md: "Deep redaction test",
      data: { deepObj, deepArr }
    }
  );
  assert.equal(deepPost.status, 201);
  assert.equal(JSON.stringify(deepPost.json.message.data).includes("sk-live-"), false);
  const deepRow = harness.db.sqlite
    .prepare(`SELECT data_json FROM board_messages WHERE id = ?1`)
    .get(deepPost.json.message.id);
  assert.equal(deepRow.data_json.includes("sk-live-"), false);

  // 2. Key-context secret redaction in data while preserving $VAR placeholders
  const keyContextPost = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicId}/messages`,
    clientProjATok,
    {
      kind: "note",
      text_md: "Key context redaction",
      data: {
        api_key: "plain_secret_987654321",
        safe_api_key: "$SAFE_API_KEY",
        nested: {
          token: "my_plain_token_12345",
          placeholder_token: "${SAFE_TOKEN}"
        }
      }
    }
  );
  assert.equal(keyContextPost.status, 201);
  assert.equal(keyContextPost.json.message.data.api_key, "[REDACTED]");
  assert.equal(keyContextPost.json.message.data.safe_api_key, "$SAFE_API_KEY");
  assert.equal(keyContextPost.json.message.data.nested.token, "[REDACTED]");
  assert.equal(keyContextPost.json.message.data.nested.placeholder_token, "${SAFE_TOKEN}");
  const keyContextRow = harness.db.sqlite
    .prepare(`SELECT data_json FROM board_messages WHERE id = ?1`)
    .get(keyContextPost.json.message.id);
  assert.equal(keyContextRow.data_json.includes("plain_secret_987654321"), false);
  assert.equal(keyContextRow.data_json.includes("my_plain_token_12345"), false);

  // 3. Duplicate secret-like external_ref with upsert: false does NOT leak secret in error.next or error.message
  const secretRefTopic = await harness.callApi("POST", "/api/v1/board/topics", clientProjATok, {
    channel: "proj/a",
    title: "Secret External Ref",
    external_ref: "sk-live-secretref1234567890",
    upsert: false
  });
  assert.equal(secretRefTopic.status, 201);

  const secretRefConflict = await harness.callApi("POST", "/api/v1/board/topics", clientProjATok, {
    channel: "proj/a",
    title: "Duplicate Secret External Ref",
    external_ref: "sk-live-secretref1234567890",
    upsert: false
  });
  assert.equal(secretRefConflict.status, 409);
  assert.equal(secretRefConflict.json.error.code, "INVALID_STATE_TRANSITION");
  assert.equal(JSON.stringify(secretRefConflict.json).includes("sk-live-"), false);
  assert.deepEqual(secretRefConflict.json.error.next, ["ahub board read proj/a --json"]);
  assertMatchesBoardSchema(secretRefConflict.json, "409 secret external_ref");

  // 4. Explicit empty string actor_profile / source_node rejected with 400 BAD_REQUEST
  const emptyProfilePost = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicId}/messages`,
    clientProjATok,
    { kind: "note", text_md: "empty profile", actor_profile: "" }
  );
  assert.equal(emptyProfilePost.status, 400);
  assert.equal(emptyProfilePost.json.error.code, "BAD_REQUEST");

  const emptyNodePost = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicId}/messages`,
    clientProjATok,
    { kind: "note", text_md: "empty source_node", source_node: "" }
  );
  assert.equal(emptyNodePost.status, 400);
  assert.equal(emptyNodePost.json.error.code, "BAD_REQUEST");

  const qForAnswer = await harness.callApi(
    "POST",
    `/api/v1/board/topics/${topicId}/messages`,
    clientProjATok,
    { kind: "question", text_md: "Question for empty actor_profile answer check" }
  );
  assert.equal(qForAnswer.status, 201);

  const emptyProfileAnswer = await harness.callApi(
    "POST",
    `/api/v1/board/messages/${qForAnswer.json.message.id}/answer`,
    adminTok,
    { answer_text: "Approved", actor_profile: "" }
  );
  assert.equal(emptyProfileAnswer.status, 400);
  assert.equal(emptyProfileAnswer.json.error.code, "BAD_REQUEST");
});

test("Board CAS answer rejects TOCTOU race even when both callers pass pre-check", async () => {
  const harness = createTestHarness();
  const { adminTok, clientProjATok } = await seedBaseFixtures(harness);

  const topicRes = await harness.callApi("POST", "/api/v1/board/topics", clientProjATok, {
    channel: "proj/a",
    title: "CAS TOCTOU Barrier Topic"
  });
  assert.equal(topicRes.status, 201);
  const topicId = topicRes.json.topic.id;

  const qRes = await harness.callApi("POST", `/api/v1/board/topics/${topicId}/messages`, clientProjATok, {
    kind: "question",
    text_md: "Should TOCTOU barrier hold?",
    question_options: ["Yes", "No"]
  });
  assert.equal(qRes.status, 201);
  const qId = qRes.json.message.id;

  // Force both concurrent answerBoardQuestion callers to pass the initial SELECT pre-check
  // while question_state is still 'open', so only the atomic SQL CAS guard enforces uniqueness.
  const origPrepare = harness.db.prepare.bind(harness.db);
  let preCheckWaiters = [];
  let intercepted = 0;
  harness.db.prepare = (sql) => {
    const stmt = origPrepare(sql);
    if (!sql.includes("SELECT * FROM board_messages WHERE id = ?1")) {
      return stmt;
    }
    const origBind = stmt.bind.bind(stmt);
    return {
      ...stmt,
      bind(...params) {
        const bound = origBind(...params);
        if (params[0] !== qId) return bound;
        return {
          ...bound,
          async first() {
            const row = await bound.first();
            intercepted += 1;
            if (intercepted <= 2) {
              await new Promise((resolve) => {
                preCheckWaiters.push(resolve);
                if (preCheckWaiters.length === 2) {
                  for (const wake of preCheckWaiters) wake();
                  preCheckWaiters = [];
                }
              });
            }
            return row;
          }
        };
      }
    };
  };

  const [resA, resB] = await Promise.all([
    harness.callApi("POST", `/api/v1/board/messages/${qId}/answer`, adminTok, {
      selected_option: "Yes",
      actor_profile: "admin-race-1"
    }),
    harness.callApi("POST", `/api/v1/board/messages/${qId}/answer`, adminTok, {
      selected_option: "No",
      actor_profile: "admin-race-2"
    })
  ]);

  assert.deepEqual([resA.status, resB.status].sort(), [200, 409]);
  const loser = resA.status === 409 ? resA : resB;
  assert.equal(loser.json.error.code, "INVALID_STATE_TRANSITION");
  assert.equal(loser.json.error.next.includes(`ahub board read --topic ${topicId} --json`), true);

  const tl = await harness.callApi("GET", `/api/v1/board/topics/${topicId}/messages`, adminTok);
  assert.equal(tl.status, 200);
  const answerRows = tl.json.messages.filter((m) => m.kind === "answer" && m.reply_to_id === qId);
  assert.equal(answerRows.length, 1);
});

test("Malformed % URI path segments return 400 BAD_REQUEST instead of 500 URIError", async () => {
  const harness = createTestHarness();
  const { adminTok } = await seedBaseFixtures(harness);

  const malformedProbes = [
    ["GET", "/api/v1/board/topics/%E0%A4%A/messages", undefined],
    ["POST", "/api/v1/board/topics/%E0%A4%A/messages", { kind: "note", text_md: "bad uri" }],
    ["PATCH", "/api/v1/board/topics/%E0%A4%A", { status: "done" }],
    ["POST", "/api/v1/board/messages/%E0%A4%A/answer", { answer_text: "bad uri" }],
    ["PATCH", "/api/v1/keys/%E0%A4%A", { allowed_board_prefixes: ["proj/a"] }],
    ["GET", "/api/v1/runs/%E0%A4%A", undefined]
  ];

  for (const [method, path, body] of malformedProbes) {
    const res = await harness.callApi(method, path, adminTok, body);
    assert.equal(res.status, 400, `expected 400 for ${method} ${path}, got ${res.status}: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error.code, "BAD_REQUEST");
  }
});
