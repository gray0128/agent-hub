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
const { claimRunsForNode } = await import("../src/db.ts");
const { sha256Hex } = await import("../src/ulid.ts");

const require = createRequire(import.meta.url);
const Ajv2020 = require(path.join(repoRoot, "node_modules/ajv/dist/2020.js"));
const addFormats = require(path.join(repoRoot, "node_modules/ajv-formats/dist/index.js"));
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
addFormats(ajv);

const planCreateSchema = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "docs/schemas/plan-create.schema.json"), "utf8")
);
const runCreateSchema = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "docs/schemas/run-create.schema.json"), "utf8")
);
const runRecordSchema = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "docs/schemas/run-record.schema.json"), "utf8")
);
const boardSchema = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "docs/schemas/board.schema.json"), "utf8")
);
const wsFramesSchema = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "docs/schemas/ws-frames.schema.json"), "utf8")
);

const validatePlanCreate = ajv.compile(planCreateSchema);
const validateRunCreate = ajv.compile(runCreateSchema);
const validateRunRecord = ajv.compile(runRecordSchema);
const validateErrorEnvelope = ajv.compile({
  $schema: boardSchema.$schema,
  $defs: boardSchema.$defs,
  $ref: "#/$defs/ErrorEnvelope"
});
const validateWsFrame = ajv.compile(wsFramesSchema);

function assertRunRecordValid(run, label = "RunRecord") {
  const ok = validateRunRecord(run);
  assert.equal(ok, true, `${label} failed schema: ${JSON.stringify(validateRunRecord.errors)}`);
}

function assertErrorEnvelopeValid(body, label = "ErrorEnvelope") {
  const ok = validateErrorEnvelope(body);
  assert.equal(ok, true, `${label} failed schema: ${JSON.stringify(validateErrorEnvelope.errors)}`);
}

function assertWsFrameValid(frame, label = "WsFrame") {
  const ok = validateWsFrame(frame);
  assert.equal(ok, true, `${label} failed schema: ${JSON.stringify(validateWsFrame.errors)}`);
}

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

function createMockWebSocket(tags = []) {
  const sent = [];
  let attachment = null;
  return {
    readyState: 1,
    _tags: tags,
    sent,
    frames() {
      return sent.map((s) => JSON.parse(s));
    },
    send(msg) {
      sent.push(String(msg));
    },
    close() {
      this.readyState = 3;
    },
    serializeAttachment(att) {
      attachment = att;
    },
    deserializeAttachment() {
      return attachment;
    }
  };
}

function createTestHarness() {
  const db = createSqliteD1();
  const acceptedSockets = [];
  const queueMessages = [];
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
    WEBHOOK_ENCRYPTION_KEY: "test-encryption-secret-for-plans-suite",
    NOTIFY_QUEUE: {
      async send(msg, opts) {
        queueMessages.push({ msg, opts });
      }
    },
    NODE_HUB: {
      idFromName() {
        return "global";
      },
      get() {
        return {
          fetch(reqOrUrl, init) {
            const req =
              reqOrUrl instanceof Request ? reqOrUrl : new Request(String(reqOrUrl), init);
            return nodeHub.fetch(req);
          }
        };
      }
    }
  };
  nodeHub = new NodeHub(mockCtx, env);

  const pendingPromises = [];
  const execCtx = {
    waitUntil(p) {
      pendingPromises.push(Promise.resolve(p));
    }
  };

  async function flush() {
    while (pendingPromises.length > 0) {
      const batch = pendingPromises.splice(0, pendingPromises.length);
      await Promise.all(batch);
    }
  }

  async function callApi(method, urlPath, token, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const resp = await worker.fetch(
      new Request(`https://ahub.bobocai.win${urlPath}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
      }),
      env,
      execCtx
    );
    await flush();
    const json = await resp.json();
    return { status: resp.status, json };
  }

  async function openAdminStream(scope = "admin", keyId = null, runId = null, topicId = null) {
    const ws = createMockWebSocket(["stream"]);
    ws.serializeAttachment({
      role: "stream",
      runId,
      topicId,
      scope,
      keyId,
      boundNodeId: null,
      allowedNodes: [],
      allowedBoardPrefixes: ["*"]
    });
    acceptedSockets.push(ws);
    return ws;
  }

  async function connectNodeSocket(nodeId, keyId = null, workspaces = [{ key: "demo", path: "/workspace/demo" }]) {
    const ws = createMockWebSocket([`node:${nodeId}`]);
    ws.serializeAttachment({
      role: "node",
      nodeId,
      keyId,
      connNonce: ""
    });
    acceptedSockets.push(ws);
    await nodeHub.webSocketMessage(
      ws,
      JSON.stringify({
        type: "node.hello",
        conn_nonce: "nonce_0123456789",
        version: "0.2.0",
        os: "darwin",
        arch: "arm64",
        max_concurrency: 4,
        capabilities: { agents: { codex: { enabled: true, available: true } } },
        workspaces
      })
    );
    return ws;
  }

  async function seedAdminAndNodes() {
    const adminTok = "ahub_adm_testtoken_0123456789abcdef";
    const adminSha = await sha256Hex(adminTok);
    const now = new Date().toISOString();
    db.sqlite
      .prepare(
        `INSERT INTO api_keys (id, name, scope, bound_node_id, key_prefix, key_sha256, allowed_nodes_json, allowed_board_prefixes_json, allow_unsandboxed, max_depth_limit, created_at)
         VALUES ('key_01ADM1', 'admin-1', 'admin', NULL, 'ahub_adm_testt', ?, '[]', '["*"]', 1, 3, ?)`
      )
      .run(adminSha, now);

    const nodeTok = "ahub_nod_macmini_0123456789abcdef";
    const nodeSha = await sha256Hex(nodeTok);
    db.sqlite
      .prepare(
        `INSERT INTO nodes (id, display_name, os, arch, version, capabilities_json, workspaces_json, status, max_concurrency, active_runs_count, created_at, updated_at)
         VALUES ('macmini', 'MacMini', 'darwin', 'arm64', '0.2.0', '{}', ?, 'online', 4, 0, ?, ?)`
      )
      .run(JSON.stringify([{ key: "demo", path: "/workspace/demo" }, { key: "other", path: "/workspace/other" }]), now, now);
    db.sqlite
      .prepare(
        `INSERT INTO nodes (id, display_name, os, arch, version, capabilities_json, workspaces_json, status, max_concurrency, active_runs_count, created_at, updated_at)
         VALUES ('mbp', 'MBP', 'darwin', 'arm64', '0.2.0', '{}', ?, 'online', 4, 0, ?, ?)`
      )
      .run(JSON.stringify([{ key: "demo", path: "/workspace/demo" }]), now, now);
    db.sqlite
      .prepare(
        `INSERT INTO api_keys (id, name, scope, bound_node_id, key_prefix, key_sha256, allowed_nodes_json, allowed_board_prefixes_json, allow_unsandboxed, max_depth_limit, created_at)
         VALUES ('key_01NOD1', 'node-macmini', 'node', 'macmini', 'ahub_nod_macmi', ?, '[]', '[]', 0, 1, ?)`
      )
      .run(nodeSha, now);

    const nodeMbpTok = "ahub_nod_mbp_0123456789abcdef";
    const nodeMbpSha = await sha256Hex(nodeMbpTok);
    db.sqlite
      .prepare(
        `INSERT INTO api_keys (id, name, scope, bound_node_id, key_prefix, key_sha256, allowed_nodes_json, allowed_board_prefixes_json, allow_unsandboxed, max_depth_limit, created_at)
         VALUES ('key_01NOD2', 'node-mbp', 'node', 'mbp', 'ahub_nod_mbp_0', ?, '[]', '[]', 0, 1, ?)`
      )
      .run(nodeMbpSha, now);

    return { adminTok, nodeTok, nodeMbpTok };
  }

  return {
    db,
    env,
    execCtx,
    nodeHub,
    queueMessages,
    callApi,
    openAdminStream,
    connectNodeSocket,
    seedAdminAndNodes,
    flush
  };
}

test("0009 migration preserves pre-existing runs, parent_run_id, run_events, board_topics, and rebuilds all 7 indexes + run_dependencies", () => {
  const sqlite = new DatabaseSync(":memory:");
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of migrationFiles) {
    if (file.startsWith("0009_")) break;
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
  }

  const now = "2026-11-22T12:00:00.000Z";
  sqlite
    .prepare(
      `INSERT INTO nodes (id, display_name, status, max_concurrency, active_runs_count, created_at, updated_at)
       VALUES ('macmini', 'MacMini', 'online', 4, 0, ?, ?)`
    )
    .run(now, now);
  sqlite
    .prepare(
      `INSERT INTO threads (id, title, node_id, workdir, project_key, agent, status, created_at, updated_at)
       VALUES ('thr_01OLD', 'Old Thread', 'macmini', '/workspace/demo', 'demo', 'codex', 'active', ?, ?)`
    )
    .run(now, now);
  sqlite
    .prepare(
      `INSERT INTO board_topics (id, channel, title, status, created_at, updated_at)
       VALUES ('top_01OLD', 'proj/demo', 'Old Topic', 'todo', ?, ?)`
    )
    .run(now, now);
  sqlite
    .prepare(
      `INSERT INTO runs (id, thread_id, root_run_id, parent_run_id, depth, max_depth, node_id, workdir, agent, prompt, status, created_at, updated_at)
       VALUES ('run_01PARENT', 'thr_01OLD', 'run_01PARENT', NULL, 0, 1, 'macmini', '/workspace/demo', 'codex', 'parent prompt', 'done', ?, ?)`
    )
    .run(now, now);
  sqlite
    .prepare(
      `INSERT INTO runs (id, thread_id, root_run_id, parent_run_id, depth, max_depth, node_id, workdir, agent, prompt, status, created_at, updated_at)
       VALUES ('run_01CHILD', 'thr_01OLD', 'run_01PARENT', 'run_01PARENT', 1, 1, 'macmini', '/workspace/demo', 'codex', 'child prompt', 'queued', ?, ?)`
    )
    .run(now, now);
  sqlite
    .prepare(
      `INSERT INTO run_events (run_id, seq, kind, payload_json, created_at)
       VALUES ('run_01PARENT', 1, 'status', '{"status":"done"}', ?),
              ('run_01CHILD', 1, 'system', '{"note":"created"}', ?)`
    )
    .run(now, now);

  sqlite.exec(fs.readFileSync(path.join(migrationsDir, "0009_waiting_dag_and_schedule.sql"), "utf8"));

  const fkEnabled = sqlite.prepare("PRAGMA foreign_keys").get();
  assert.equal(fkEnabled.foreign_keys, 1);
  const fkCheck = sqlite.prepare("PRAGMA foreign_key_check").all();
  assert.deepEqual(fkCheck, []);

  const runs = sqlite.prepare("SELECT id, parent_run_id, actor_profile, plan_id FROM runs ORDER BY id ASC").all();
  assert.equal(runs.length, 2);
  assert.equal(runs[0].id, "run_01CHILD");
  assert.equal(runs[0].parent_run_id, "run_01PARENT");
  assert.equal(runs[0].actor_profile, "");
  assert.equal(runs[0].plan_id, null);

  const events = sqlite.prepare("SELECT run_id, seq, kind FROM run_events ORDER BY run_id ASC").all();
  assert.equal(events.length, 2);

  const indexes = sqlite
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runs'")
    .all();
  const idxMap = new Map(indexes.map((r) => [r.name, r.sql ?? ""]));
  for (const expected of [
    "idx_runs_node_status_priority",
    "idx_runs_thread_created",
    "idx_runs_root",
    "idx_runs_active_lease",
    "idx_runs_waiting_schedule",
    "idx_runs_plan",
    "idx_runs_board_topic"
  ]) {
    assert.equal(idxMap.has(expected), true, `Missing runs index ${expected}`);
  }
  assert.equal(idxMap.get("idx_runs_active_lease").includes("needs_approval"), true);

  const depIndexes = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'run_dependencies'")
    .all()
    .map((r) => r.name);
  assert.equal(depIndexes.includes("idx_run_dependencies_dep"), true);

  assert.throws(() => {
    sqlite
      .prepare(
        "INSERT INTO run_dependencies (run_id, depends_on_run_id, created_at) VALUES ('run_01CHILD', 'run_01CHILD', ?)"
      )
      .run(now);
  });
});

test("POST /api/v1/plans validates cycles, quotas, bounds, permissions, idempotency, and wakes only queued roots", async () => {
  const h = createTestHarness();
  const { adminTok, nodeTok } = await h.seedAdminAndNodes();
  const nodeWs = await h.connectNodeSocket("macmini", "key_01NOD1");
  const adminWs = await h.openAdminStream("admin");

  const topicRes = await h.callApi("POST", "/api/v1/board/topics", adminTok, {
    channel: "proj/demo",
    title: "Plan Topic"
  });
  assert.equal(topicRes.status, 201);
  const topicId = topicRes.json.topic.id;

  // Client key restricted to macmini and proj/demo
  const cliRes = await h.callApi("POST", "/api/v1/keys", adminTok, {
    name: "cli-plan",
    scope: "client",
    allowed_nodes: ["macmini"],
    allowed_board_prefixes: ["proj/demo"]
  });
  assert.equal(cliRes.status, 201);
  const cliTok = cliRes.json.token;

  // Node scope forbidden
  const nodePlan = await h.callApi("POST", "/api/v1/plans", nodeTok, {
    nodes: [{ key: "a", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "hi" }]
  });
  assert.equal(nodePlan.status, 403);
  assertErrorEnvelopeValid(nodePlan.json);

  // Cycle detection: 2-node & 3-node cycle -> 400 DEPENDENCY_CYCLE_DETECTED, zero DB writes
  const cycleRes = await h.callApi("POST", "/api/v1/plans", adminTok, {
    nodes: [
      { key: "a", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "A", depends_on: ["c"] },
      { key: "b", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "B", depends_on: ["a"] },
      { key: "c", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "C", depends_on: ["b"] }
    ]
  });
  assert.equal(cycleRes.status, 400);
  assert.equal(cycleRes.json.error.code, "DEPENDENCY_CYCLE_DETECTED");
  assertErrorEnvelopeValid(cycleRes.json);
  assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS cnt FROM runs").get().cnt, 0);

  // Self cycle
  const selfCycle = await h.callApi("POST", "/api/v1/plans", adminTok, {
    nodes: [{ key: "a", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "A", depends_on: ["a"] }]
  });
  assert.equal(selfCycle.status, 400);
  assert.equal(selfCycle.json.error.code, "DEPENDENCY_CYCLE_DETECTED");

  // Unknown key dependency -> 400 BAD_REQUEST
  const unknownDep = await h.callApi("POST", "/api/v1/plans", adminTok, {
    nodes: [{ key: "a", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "A", depends_on: ["missing_key"] }]
  });
  assert.equal(unknownDep.status, 400);
  assert.equal(unknownDep.json.error.code, "BAD_REQUEST");

  // Quotas: 21 nodes -> 400; 11 deps -> 400; > 60 edges -> 400
  const nodes21 = Array.from({ length: 21 }, (_, idx) => ({
    key: `n${idx}`,
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: `task ${idx}`
  }));
  assert.equal((await h.callApi("POST", "/api/v1/plans", adminTok, { nodes: nodes21 })).status, 400);

  const manyNodes = Array.from({ length: 12 }, (_, idx) => ({
    key: `m${idx}`,
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: `m ${idx}`,
    depends_on: idx === 11 ? Array.from({ length: 11 }, (__, j) => `m${j}`) : []
  }));
  assert.equal((await h.callApi("POST", "/api/v1/plans", adminTok, { nodes: manyNodes })).status, 400);

  const denseNodes = Array.from({ length: 15 }, (_, idx) => ({
    key: `d${idx}`,
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: `d ${idx}`,
    depends_on: idx >= 7 ? ["d0", "d1", "d2", "d3", "d4", "d5", "d6"] : [] // 8*7=56 -> with 9 >=6 => 9*7=63 > 60
  }));
  // Make 9 nodes depend on 7 => 63 edges > 60
  denseNodes[6].depends_on = ["d0", "d1", "d2", "d3", "d4", "d5"];
  denseNodes[5].depends_on = ["d0", "d1", "d2", "d3", "d4"];
  assert.equal((await h.callApi("POST", "/api/v1/plans", adminTok, { nodes: denseNodes })).status, 400);

  // Schedule bounds & mutual exclusion
  assert.equal(
    (
      await h.callApi("POST", "/api/v1/plans", adminTok, {
        nodes: [{ key: "a", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "A", in_sec: 59 }]
      })
    ).status,
    400
  );
  assert.equal(
    (
      await h.callApi("POST", "/api/v1/plans", adminTok, {
        nodes: [{ key: "a", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "A", in_sec: 604801 }]
      })
    ).status,
    400
  );
  assert.equal(
    (
      await h.callApi("POST", "/api/v1/plans", adminTok, {
        nodes: [
          {
            key: "a",
            node_id: "macmini",
            workdir: "demo",
            agent: "codex",
            prompt: "A",
            scheduled_at: new Date(Date.now() + 59_000).toISOString()
          }
        ]
      })
    ).status,
    400
  );
  assert.equal(
    (
      await h.callApi("POST", "/api/v1/plans", adminTok, {
        nodes: [
          {
            key: "a",
            node_id: "macmini",
            workdir: "demo",
            agent: "codex",
            prompt: "A",
            in_sec: 120,
            scheduled_at: new Date(Date.now() + 120_000).toISOString()
          }
        ]
      })
    ).status,
    400
  );

  // Client board prefix check & disallowed node check
  const forbiddenTopicRes = await h.callApi("POST", "/api/v1/board/topics", adminTok, {
    channel: "ops/secret",
    title: "Ops Topic"
  });
  const forbiddenBoardPlan = await h.callApi("POST", "/api/v1/plans", cliTok, {
    board_topic_id: forbiddenTopicRes.json.topic.id,
    nodes: [{ key: "a", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "A" }]
  });
  assert.equal(forbiddenBoardPlan.status, 403);
  assert.equal(forbiddenBoardPlan.json.error.code, "FORBIDDEN_SCOPE");

  const forbiddenNodePlan = await h.callApi("POST", "/api/v1/plans", cliTok, {
    nodes: [{ key: "a", node_id: "mbp", workdir: "demo", agent: "codex", prompt: "A" }]
  });
  assert.equal(forbiddenNodePlan.status, 403);

  // Happy path DAG with client key + in_sec + secret in prompt (must be redacted in response & WS)
  const planPayload = {
    idempotency_key: "plan_idem_0001",
    board_topic_id: topicId,
    actor_profile: "orchestrator",
    nodes: [
      {
        key: "leaf",
        node_id: "macmini",
        workdir: "demo",
        agent: "codex",
        prompt: "step leaf with token sk-live-secret987654321",
        depends_on: ["mid"]
      },
      {
        key: "root-a",
        node_id: "macmini",
        workdir: "demo",
        agent: "codex",
        prompt: "step root-a"
      },
      {
        key: "mid",
        node_id: "macmini",
        workdir: "demo",
        agent: "codex",
        prompt: "step mid",
        depends_on: ["root-a", "root-b"],
        in_sec: 120
      },
      {
        key: "root-b",
        node_id: "macmini",
        workdir: "demo",
        agent: "codex",
        prompt: "step root-b"
      }
    ]
  };
  assert.equal(validatePlanCreate(planPayload), true);

  const wakeCountBefore = nodeWs.frames().filter((f) => f.type === "hub.wake").length;
  const created = await h.callApi("POST", "/api/v1/plans", cliTok, planPayload);
  assert.equal(created.status, 201);
  assert.equal(created.json.ok, true);
  assert.match(created.json.plan_id, /^pln_[A-Za-z0-9]+$/);
  assert.equal(created.json.runs.length, 4);

  const byKey = new Map(created.json.runs.map((r) => [r.plan_key, r]));
  for (const r of created.json.runs) {
    assertRunRecordValid(r, `plan run ${r.plan_key}`);
  }
  assert.equal(byKey.get("root-a").status, "queued");
  assert.equal(byKey.get("root-a").blocked_reason, null);
  assert.equal(byKey.get("root-b").status, "queued");
  assert.equal(byKey.get("mid").status, "waiting");
  assert.equal(byKey.get("mid").blocked_reason, "DEPENDENCY_PENDING");
  assert.ok(byKey.get("mid").scheduled_at);
  assert.equal(byKey.get("leaf").status, "waiting");
  assert.equal(byKey.get("leaf").blocked_reason, "DEPENDENCY_PENDING");
  assert.equal(byKey.get("leaf").prompt.includes("sk-live-secret987654321"), false);

  // Coalesced wake: only 1 hub.wake sent for macmini (only queued roots, never waiting)
  const wakesAfter = nodeWs.frames().filter((f) => f.type === "hub.wake").slice(wakeCountBefore);
  assert.equal(wakesAfter.length, 1);
  assertWsFrameValid(wakesAfter[0], "hub.wake");

  // Validate broadcasted run.updated frames
  const runUpdatedFrames = adminWs.frames().filter((f) => f.type === "run.updated");
  assert.equal(runUpdatedFrames.length, 4);
  for (const frame of runUpdatedFrames) {
    assertWsFrameValid(frame, "plan run.updated");
  }

  // Idempotent replay with same in_sec returns 200 deduplicated: true
  const replay = await h.callApi("POST", "/api/v1/plans", cliTok, planPayload);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.deduplicated, true);
  assert.equal(replay.json.plan_id, created.json.plan_id);
  assert.deepEqual(
    replay.json.runs.map((r) => r.id),
    created.json.runs.map((r) => r.id)
  );

  // Conflict when in_sec or prompt changes on same idempotency_key
  const conflict = await h.callApi("POST", "/api/v1/plans", cliTok, {
    ...planPayload,
    nodes: planPayload.nodes.map((n) => (n.key === "mid" ? { ...n, in_sec: 300 } : n))
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, "IDEMPOTENCY_CONFLICT");

  // Depth limit & delegation cycle checks on POST /api/v1/plans with parent_run_id
  const parentRunId = byKey.get("root-a").id;
  const cycleDelegation = await h.callApi("POST", "/api/v1/plans", adminTok, {
    parent_run_id: parentRunId,
    nodes: [{ key: "sub", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "loop" }]
  });
  assert.equal(cycleDelegation.status, 409);
  assert.equal(cycleDelegation.json.error.code, "DELEGATION_CYCLE_DETECTED");

  const validSubPlan = await h.callApi("POST", "/api/v1/plans", adminTok, {
    parent_run_id: parentRunId,
    nodes: [{ key: "sub", node_id: "mbp", workdir: "demo", agent: "codex", prompt: "child" }]
  });
  assert.equal(validSubPlan.status, 201);
  const subRunId = validSubPlan.json.runs[0].id;
  const depthExceeded = await h.callApi("POST", "/api/v1/plans", adminTok, {
    parent_run_id: subRunId,
    nodes: [{ key: "sub2", node_id: "macmini", workdir: "other", agent: "codex", prompt: "too deep" }]
  });
  assert.equal(depthExceeded.status, 409);
  assert.equal(depthExceeded.json.error.code, "DEPTH_LIMIT_EXCEEDED");
});

test("POST /api/v1/runs Slice 2 fields, waiting immediate 202, zero-claim/zero-pending, diamond CAS wake, Cron schedule wake, and blocked_reason precedence", async () => {
  const h = createTestHarness();
  const { adminTok, nodeTok, nodeMbpTok } = await h.seedAdminAndNodes();
  const macWs = await h.connectNodeSocket("macmini", "key_01NOD1", [
    { key: "demo", path: "/workspace/demo" },
    { key: "other", path: "/workspace/other" }
  ]);
  const mbpWs = await h.connectNodeSocket("mbp", "key_01NOD2");
  const adminWs = await h.openAdminStream("admin");

  const topicRes = await h.callApi("POST", "/api/v1/board/topics", adminTok, {
    channel: "proj/demo",
    title: "Single Runs Topic"
  });
  const topicId = topicRes.json.topic.id;

  // Create two queued root runs A (macmini) and B (mbp)
  const runARes = await h.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "Run A"
  });
  assert.equal(runARes.status, 202);
  const runA = runARes.json.run;
  assertRunRecordValid(runA);

  const runBRes = await h.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "mbp",
    workdir: "demo",
    agent: "codex",
    prompt: "Run B"
  });
  const runB = runBRes.json.run;

  // Create waiting diamond child C on mbp with depends_on [A, B], plus scheduled_at on macmini? Keep C unscheduled so it wakes when A & B finish.
  const wakeBeforeC = mbpWs.frames().filter((f) => f.type === "hub.wake").length;
  const cReq = {
    node_id: "mbp",
    workdir: "other-wait",
    agent: "codex",
    prompt: "Run C",
    depends_on: [runA.id, runB.id],
    board_topic_id: topicId,
    actor_profile: "planner@macmini"
  };
  // Update mbp workspaces in DB or use "demo"
  cReq.workdir = "demo";
  assert.equal(validateRunCreate(cReq), true);

  const startMs = Date.now();
  const runCRes = await h.callApi("POST", "/api/v1/runs?wait_ms=30000", adminTok, cReq);
  const elapsedMs = Date.now() - startMs;
  assert.equal(runCRes.status, 202);
  assert.ok(elapsedMs < 2000, `waiting POST /runs should return immediately without wait_ms, took ${elapsedMs}ms`);
  const runC = runCRes.json.run;
  assert.equal(runC.status, "waiting");
  assert.equal(runC.blocked_reason, "DEPENDENCY_PENDING");
  assert.deepEqual(runC.depends_on_run_ids, [runA.id, runB.id]);
  assert.equal(runC.board_topic_id, topicId);
  assert.equal(runC.actor_profile, "planner@macmini");
  assertRunRecordValid(runC);

  // Zero hub.wake for waiting run C
  assert.equal(mbpWs.frames().filter((f) => f.type === "hub.wake").length, wakeBeforeC);

  // Scheduled run D on macmini (future +120s with +08:00 timezone offset, depends on C)
  const futureOffsetDate = new Date(Date.now() + 120_000 + 8 * 3600_000)
    .toISOString()
    .replace("Z", "+08:00");
  const runDRes = await h.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "other",
    agent: "codex",
    prompt: "Run D scheduled",
    depends_on: [runC.id],
    scheduled_at: futureOffsetDate
  });
  assert.equal(runDRes.status, 202);
  const runD = runDRes.json.run;
  assert.equal(runD.status, "waiting");
  assert.equal(runD.blocked_reason, "DEPENDENCY_PENDING");
  assert.equal(runD.scheduled_at.endsWith("Z"), true);

  // Scheduled-only run S on macmini (no deps, future) -> blocked_reason === 'SCHEDULED'
  const runSRes = await h.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "other",
    agent: "codex",
    prompt: "Run S scheduled only",
    scheduled_at: new Date(Date.now() + 120_000).toISOString()
  });
  assert.equal(runSRes.status, 202);
  assert.equal(runSRes.json.run.status, "waiting");
  assert.equal(runSRes.json.run.blocked_reason, "SCHEDULED");

  // GET /api/v1/runs?status=waiting & ?board_topic_id=
  const waitingList = await h.callApi("GET", "/api/v1/runs?status=waiting", adminTok);
  assert.equal(waitingList.status, 200);
  assert.equal(waitingList.json.runs.length, 3);
  const topicRuns = await h.callApi("GET", `/api/v1/runs?board_topic_id=${topicId}`, adminTok);
  assert.equal(topicRuns.json.runs.length, 1);
  assert.equal(topicRuns.json.runs[0].id, runC.id);

  // Claim A and B, leave only waiting runs on macmini, and check node.hello has_pending_runs === false!
  const claimA = await h.callApi("POST", "/api/v1/nodes/macmini/claim", nodeTok, {
    conn_nonce: "nonce_mac_1"
  });
  assert.equal(claimA.status, 200);
  assert.equal(claimA.json.claimed_runs.length, 1);
  assert.equal(claimA.json.claimed_runs[0].id, runA.id);

  // Second claim on macmini (D & S are waiting) claims 0 runs!
  const claimEmpty = await h.callApi("POST", "/api/v1/nodes/macmini/claim", nodeTok, {
    conn_nonce: "nonce_mac_1"
  });
  assert.equal(claimEmpty.json.claimed_runs.length, 0);

  // Re-hello on macmini with only waiting runs -> has_pending_runs: false
  const framesBeforeHello = macWs.frames().length;
  await h.nodeHub.webSocketMessage(
    macWs,
    JSON.stringify({
      type: "node.hello",
      conn_nonce: "nonce_mac_2",
      version: "0.2.0",
      os: "darwin",
      arch: "arm64",
      max_concurrency: 4,
      capabilities: {},
      workspaces: [{ key: "demo", path: "/workspace/demo" }, { key: "other", path: "/workspace/other" }]
    })
  );
  const welcomeFrame = macWs.frames().slice(framesBeforeHello).find((f) => f.type === "hub.welcome");
  assert.equal(welcomeFrame.has_pending_runs, false);

  // Claim B on mbp
  const claimB = await h.callApi("POST", "/api/v1/nodes/mbp/claim", nodeMbpTok, {
    conn_nonce: "nonce_mbp_1"
  });
  assert.equal(claimB.json.claimed_runs.length, 1);

  // Complete A and B concurrently -> C wakes exactly once!
  const wakesBeforeComplete = mbpWs.frames().filter((f) => f.type === "hub.wake").length;
  const [compA, compB] = await Promise.all([
    h.callApi("POST", `/api/v1/runs/${runA.id}/complete`, nodeTok, {
      lease_owner: "macmini:nonce_mac_1",
      status: "done",
      summary: "A done",
      output_md: "ok A"
    }),
    h.callApi("POST", `/api/v1/runs/${runB.id}/complete`, nodeMbpTok, {
      lease_owner: "mbp:nonce_mbp_1",
      status: "done",
      summary: "B done",
      output_md: "ok B"
    })
  ]);
  assert.equal(compA.status, 200);
  assert.equal(compB.status, 200);

  const cAfter = await h.callApi("GET", `/api/v1/runs/${runC.id}`, adminTok);
  assert.equal(cAfter.json.run.status, "queued");
  assert.equal(cAfter.json.run.blocked_reason, null);
  // Single dependencies_satisfied event on C
  const cWakeEvents = h.db.sqlite
    .prepare("SELECT * FROM run_events WHERE run_id = ? AND kind = 'status'")
    .all(runC.id);
  assert.equal(cWakeEvents.length, 1);
  // 1 hub.wake sent to mbp for C
  assert.equal(mbpWs.frames().filter((f) => f.type === "hub.wake").length, wakesBeforeComplete + 1);

  // New run depending on already-done run A starts queued immediately
  const immediateRes = await h.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "Immediate after done A",
    depends_on: [runA.id]
  });
  assert.equal(immediateRes.status, 202);
  assert.equal(immediateRes.json.run.status, "queued");
  assert.deepEqual(immediateRes.json.run.depends_on_run_ids, [runA.id]);

  // Complete C -> D has all deps done but future scheduled_at, so D stays waiting with blocked_reason = 'SCHEDULED'!
  const claimC = await h.callApi("POST", "/api/v1/nodes/mbp/claim", nodeMbpTok, {
    conn_nonce: "nonce_mbp_2"
  });
  assert.equal(claimC.json.claimed_runs[0].id, runC.id);
  await h.callApi("POST", `/api/v1/runs/${runC.id}/complete`, nodeMbpTok, {
    lease_owner: "mbp:nonce_mbp_2",
    status: "done",
    summary: "C done",
    output_md: "ok C"
  });
  const dAfterC = await h.callApi("GET", `/api/v1/runs/${runD.id}`, adminTok);
  assert.equal(dAfterC.json.run.status, "waiting");
  assert.equal(dAfterC.json.run.blocked_reason, "SCHEDULED");

  // Simulate scheduled_at due for D and S, run Cron scheduled() -> both wake to queued with coalesced hub.wake!
  const pastIso = new Date(Date.now() - 5000).toISOString();
  h.db.sqlite.prepare("UPDATE runs SET scheduled_at = ? WHERE id IN (?, ?)").run(pastIso, runD.id, runSRes.json.run.id);
  const macWakesBeforeCron = macWs.frames().filter((f) => f.type === "hub.wake").length;
  await worker.scheduled({}, h.env, h.execCtx);
  await h.flush();
  const dAfterCron = await h.callApi("GET", `/api/v1/runs/${runD.id}`, adminTok);
  const sAfterCron = await h.callApi("GET", `/api/v1/runs/${runSRes.json.run.id}`, adminTok);
  assert.equal(dAfterCron.json.run.status, "queued");
  assert.equal(sAfterCron.json.run.status, "queued");
  // Coalesced: 1 hub.wake for macmini
  assert.equal(macWs.frames().filter((f) => f.type === "hub.wake").length, macWakesBeforeCron + 1);

  // Verify blocked_reason 4-way precedence: UPSTREAM_FAILED > UPSTREAM_CANCELLED > DEPENDENCY_PENDING > SCHEDULED
  const uPend = (
    await h.callApi("POST", "/api/v1/runs", adminTok, {
      node_id: "mbp",
      workdir: "demo",
      agent: "codex",
      prompt: "uPend"
    })
  ).json.run;
  const uCancel = (
    await h.callApi("POST", "/api/v1/runs", adminTok, {
      node_id: "mbp",
      workdir: "demo",
      agent: "codex",
      prompt: "uCancel"
    })
  ).json.run;
  const uFail = (
    await h.callApi("POST", "/api/v1/runs", adminTok, {
      node_id: "mbp",
      workdir: "demo",
      agent: "codex",
      prompt: "uFail"
    })
  ).json.run;
  const precChild = (
    await h.callApi("POST", "/api/v1/runs", adminTok, {
      node_id: "macmini",
      workdir: "demo",
      agent: "codex",
      prompt: "precChild",
      depends_on: [uPend.id, uCancel.id, uFail.id],
      scheduled_at: new Date(Date.now() + 300_000).toISOString()
    })
  ).json.run;
  assert.equal(precChild.blocked_reason, "DEPENDENCY_PENDING");

  await h.callApi("POST", `/api/v1/runs/${uCancel.id}/cancel`, adminTok, {});
  const afterCancel = await h.callApi("GET", `/api/v1/runs/${precChild.id}`, adminTok);
  assert.equal(afterCancel.json.run.blocked_reason, "UPSTREAM_CANCELLED");

  // Fail uFail -> UPSTREAM_FAILED overrides UPSTREAM_CANCELLED
  h.db.sqlite.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(uFail.id);
  const afterFail = await h.callApi("GET", `/api/v1/runs/${precChild.id}`, adminTok);
  assert.equal(afterFail.json.run.blocked_reason, "UPSTREAM_FAILED");

  // Validate all emitted WS frames in adminWs
  for (const frame of adminWs.frames()) {
    assertWsFrameValid(frame, `adminWs ${frame.type}`);
  }
});

test("PATCH on waiting, cancel on waiting + cascade, and POST /api/v1/runs/:id/retry preserves terminal immutability and rebinds waiting edges", async () => {
  const h = createTestHarness();
  const { adminTok, nodeTok, nodeMbpTok } = await h.seedAdminAndNodes();
  const macWs = await h.connectNodeSocket("macmini", "key_01NOD1", [
    { key: "demo", path: "/workspace/demo" },
    { key: "other", path: "/workspace/other" }
  ]);
  const mbpWs = await h.connectNodeSocket("mbp", "key_01NOD2");

  // Plan: A -> B -> C (waiting chain)
  const planRes = await h.callApi("POST", "/api/v1/plans", adminTok, {
    nodes: [
      { key: "a", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "Step A" },
      { key: "b", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "Step B", depends_on: ["a"] },
      { key: "c", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "Step C", depends_on: ["b"] }
    ]
  });
  const [runA, runB, runC] = planRes.json.runs;

  // PATCH on waiting run B (reassign to mbp, update model/effort/priority_order) -> stays waiting, zero hub.wake!
  const mbpWakesBeforePatch = mbpWs.frames().filter((f) => f.type === "hub.wake").length;
  const patchB = await h.callApi("PATCH", `/api/v1/runs/${runB.id}`, adminTok, {
    node_id: "mbp",
    workdir: "demo",
    model: "o3",
    effort: "high",
    priority_order: 42
  });
  assert.equal(patchB.status, 200);
  assert.equal(patchB.json.run.status, "waiting");
  assert.equal(patchB.json.run.node_id, "mbp");
  assert.equal(patchB.json.run.model, "o3");
  assert.equal(patchB.json.run.priority_order, 42);
  assert.equal(mbpWs.frames().filter((f) => f.type === "hub.wake").length, mbpWakesBeforePatch);

  // Retry non-terminal run B -> 409 INVALID_STATE_TRANSITION
  const badRetry = await h.callApi("POST", `/api/v1/runs/${runB.id}/retry`, adminTok, {});
  assert.equal(badRetry.status, 409);
  assert.equal(badRetry.json.error.code, "INVALID_STATE_TRANSITION");

  // Claim and complete A -> wakes B on mbp!
  await h.callApi("POST", "/api/v1/nodes/macmini/claim", nodeTok, { conn_nonce: "nonce_mac_1" });
  await h.callApi("POST", `/api/v1/runs/${runA.id}/complete`, nodeTok, {
    lease_owner: "macmini:nonce_mac_1",
    status: "done",
    summary: "A ok",
    output_md: "A out"
  });

  // Claim B on mbp and fail it
  const claimB = await h.callApi("POST", "/api/v1/nodes/mbp/claim", nodeMbpTok, { conn_nonce: "nonce_mbp_2" });
  assert.equal(claimB.json.claimed_runs[0].id, runB.id);
  await h.callApi("POST", `/api/v1/runs/${runB.id}/complete`, nodeMbpTok, {
    lease_owner: "mbp:nonce_mbp_2",
    status: "failed",
    summary: "B failed",
    output_md: "",
    error_code: "TEST_FAIL",
    error_message: "boom"
  });

  // C is still waiting with UPSTREAM_FAILED
  const cBlocked = await h.callApi("GET", `/api/v1/runs/${runC.id}`, adminTok);
  assert.equal(cBlocked.json.run.status, "waiting");
  assert.equal(cBlocked.json.run.blocked_reason, "UPSTREAM_FAILED");

  // Retry B -> creates B2 (queued, since A is done), preserves B as failed & B->A intact, rebinds C->B2!
  const retryRes = await h.callApi(
    "POST",
    `/api/v1/runs/${runB.id}/retry`,
    adminTok,
    { model: "gpt-5", effort: "medium", actor_profile: "retrier" },
    { "Idempotency-Key": "retry_idem_0001" }
  );
  assert.equal(retryRes.status, 201);
  assert.deepEqual(retryRes.json.rebound_run_ids, [runC.id]);
  const runB2 = retryRes.json.run;
  assertRunRecordValid(runB2);
  assert.equal(runB2.status, "queued");
  assert.equal(runB2.retry_of_run_id, runB.id);
  assert.equal(runB2.model, "gpt-5");
  assert.equal(runB2.actor_profile, "retrier");
  assert.deepEqual(runB2.depends_on_run_ids, [runA.id]);

  // Verify original B remained immutable (status='failed', upstream dep still A)
  const bAfterRetry = await h.callApi("GET", `/api/v1/runs/${runB.id}`, adminTok);
  assert.equal(bAfterRetry.json.run.status, "failed");
  assert.deepEqual(bAfterRetry.json.run.depends_on_run_ids, [runA.id]);

  // Verify C now depends on B2 with blocked_reason = DEPENDENCY_PENDING
  const cAfterRetry = await h.callApi("GET", `/api/v1/runs/${runC.id}`, adminTok);
  assert.deepEqual(cAfterRetry.json.run.depends_on_run_ids, [runB2.id]);
  assert.equal(cAfterRetry.json.run.blocked_reason, "DEPENDENCY_PENDING");

  // Idempotent retry replay & conflict
  const retryReplay = await h.callApi(
    "POST",
    `/api/v1/runs/${runB.id}/retry`,
    adminTok,
    { model: "gpt-5", effort: "medium", actor_profile: "retrier" },
    { "Idempotency-Key": "retry_idem_0001" }
  );
  assert.equal(retryReplay.status, 200);
  assert.equal(retryReplay.json.deduplicated, true);
  assert.equal(retryReplay.json.run.id, runB2.id);

  const retryConflict = await h.callApi(
    "POST",
    `/api/v1/runs/${runB.id}/retry`,
    adminTok,
    { model: "different-model" },
    { "Idempotency-Key": "retry_idem_0001" }
  );
  assert.equal(retryConflict.status, 409);
  assert.equal(retryConflict.json.error.code, "IDEMPOTENCY_CONFLICT");

  // Complete B2 -> wakes C!
  const claimB2 = await h.callApi("POST", "/api/v1/nodes/mbp/claim", nodeMbpTok, { conn_nonce: "nonce_mbp_3" });
  assert.equal(claimB2.json.claimed_runs[0].id, runB2.id);
  await h.callApi("POST", `/api/v1/runs/${runB2.id}/complete`, nodeMbpTok, {
    lease_owner: "mbp:nonce_mbp_3",
    status: "done",
    summary: "B2 ok",
    output_md: "B2 out"
  });
  const cAwake = await h.callApi("GET", `/api/v1/runs/${runC.id}`, adminTok);
  assert.equal(cAwake.json.run.status, "queued");

  // Cascade cancel across waiting DAG: X (queued) -> Y (waiting) -> Z (waiting)
  const cascadePlan = await h.callApi("POST", "/api/v1/plans", adminTok, {
    nodes: [
      { key: "x", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "X" },
      { key: "y", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "Y", depends_on: ["x"] },
      { key: "z", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "Z", depends_on: ["y"] }
    ]
  });
  const [runX, runY, runZ] = cascadePlan.json.runs;
  const abortsBefore = macWs.frames().filter((f) => f.type === "hub.abort").length;
  const cancelCascade = await h.callApi("POST", `/api/v1/runs/${runX.id}/cancel`, adminTok, {
    cascade: true,
    reason: "abort dag"
  });
  assert.equal(cancelCascade.status, 200);
  assert.equal(cancelCascade.json.cancelled_runs.length, 3);
  for (const r of cancelCascade.json.cancelled_runs) {
    assert.equal(r.status, "cancelled");
  }
  assert.equal((await h.callApi("GET", `/api/v1/runs/${runZ.id}`, adminTok)).json.run.status, "cancelled");
  // Zero hub.abort for queued/waiting runs
  assert.equal(macWs.frames().filter((f) => f.type === "hub.abort").length, abortsBefore);
});

test("Terminal board_topic_id auto-handoff fires on complete, resolve, cancel, and reapExpiredLeases with zero push and deleted-topic resilience", async () => {
  const h = createTestHarness();
  const { adminTok, nodeTok } = await h.seedAdminAndNodes();
  const adminWs = await h.openAdminStream("admin");

  const topicRes = await h.callApi("POST", "/api/v1/board/topics", adminTok, {
    channel: "proj/demo",
    title: "Handoff Bridge Topic",
    status: "in_progress"
  });
  const topicId = topicRes.json.topic.id;

  // 1. /complete with secret in summary -> redacted handoff, 0 notifications
  const rComplete = (
    await h.callApi("POST", "/api/v1/runs", adminTok, {
      node_id: "macmini",
      workdir: "demo",
      agent: "codex",
      prompt: "complete handoff",
      board_topic_id: topicId,
      actor_profile: "worker-a"
    })
  ).json.run;
  await h.callApi("POST", "/api/v1/nodes/macmini/claim", nodeTok, { conn_nonce: "nonce_c1_00" });
  const compRes = await h.callApi("POST", `/api/v1/runs/${rComplete.id}/complete`, nodeTok, {
    lease_owner: "macmini:nonce_c1_00",
    status: "done",
    summary: "Finished with Bearer secret_token_abcdef1234567890",
    output_md: "done"
  });
  assert.equal(compRes.status, 200);

  // 2. /resolve (needs_approval -> done)
  const rResolve = (
    await h.callApi("POST", "/api/v1/runs", adminTok, {
      node_id: "macmini",
      workdir: "demo",
      agent: "codex",
      prompt: "resolve handoff",
      board_topic_id: topicId
    })
  ).json.run;
  await h.callApi("POST", "/api/v1/nodes/macmini/claim", nodeTok, { conn_nonce: "nonce_c2_00" });
  await h.callApi("POST", `/api/v1/runs/${rResolve.id}/approval`, nodeTok, {
    lease_owner: "macmini:nonce_c2_00",
    remote_control_url: "https://ahub.bobocai.win/rc/1",
    summary: "needs approval"
  });
  const resResolve = await h.callApi("POST", `/api/v1/runs/${rResolve.id}/resolve`, adminTok, {
    summary: "approved!"
  });
  assert.equal(resResolve.status, 200);

  // 3. /cancel (waiting -> cancelled)
  const rCancel = (
    await h.callApi("POST", "/api/v1/runs", adminTok, {
      node_id: "macmini",
      workdir: "demo",
      agent: "codex",
      prompt: "cancel handoff",
      board_topic_id: topicId,
      scheduled_at: new Date(Date.now() + 120_000).toISOString()
    })
  ).json.run;
  assert.equal(rCancel.status, "waiting");
  const resCancel = await h.callApi("POST", `/api/v1/runs/${rCancel.id}/cancel`, adminTok, {});
  assert.equal(resCancel.status, 200);

  // 4. Cron reapExpiredLeases (claimed/running expired -> failed)
  const rReap = (
    await h.callApi("POST", "/api/v1/runs", adminTok, {
      node_id: "macmini",
      workdir: "demo",
      agent: "codex",
      prompt: "reap handoff",
      board_topic_id: topicId
    })
  ).json.run;
  await h.callApi("POST", "/api/v1/nodes/macmini/claim", nodeTok, { conn_nonce: "nonce_c4_00" });
  h.db.sqlite
    .prepare("UPDATE runs SET lease_expires_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 60_000).toISOString(), rReap.id);
  await worker.scheduled({}, h.env, h.execCtx);
  await h.flush();

  // Verify 4 handoff messages posted to topic, topic status unchanged ('in_progress'), secrets redacted, zero notification_deliveries / NOTIFY_QUEUE
  const boardRes = await h.callApi("GET", `/api/v1/board/topics/${topicId}/messages`, adminTok);
  assert.equal(boardRes.status, 200);
  assert.equal(boardRes.json.topic.status, "in_progress");
  assert.equal(boardRes.json.messages.length, 4);
  for (const m of boardRes.json.messages) {
    assert.equal(m.kind, "handoff");
    assert.equal(m.text_md.includes("secret_token_abcdef1234567890"), false);
  }
  assert.equal(boardRes.json.messages[0].data.run_id, rComplete.id);
  assert.equal(boardRes.json.messages[1].data.run_id, rResolve.id);
  assert.equal(boardRes.json.messages[2].data.run_id, rCancel.id);
  assert.equal(boardRes.json.messages[3].data.run_id, rReap.id);

  assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS cnt FROM notification_deliveries").get().cnt, 0);
  assert.equal(h.queueMessages.length, 0);

  const boardCreatedFrames = adminWs.frames().filter((f) => f.type === "board.message_created");
  assert.equal(boardCreatedFrames.length, 4);
  for (const frame of boardCreatedFrames) {
    assertWsFrameValid(frame, "board.message_created");
  }

  // 5. Deleted board_topic_id resilience: run still completes cleanly!
  const tempTopicId = (
    await h.callApi("POST", "/api/v1/board/topics", adminTok, {
      channel: "proj/demo",
      title: "Temp Topic"
    })
  ).json.topic.id;
  const rDeletedTopic = (
    await h.callApi("POST", "/api/v1/runs", adminTok, {
      node_id: "macmini",
      workdir: "demo",
      agent: "codex",
      prompt: "deleted topic run",
      board_topic_id: tempTopicId
    })
  ).json.run;
  await h.callApi("POST", "/api/v1/nodes/macmini/claim", nodeTok, { conn_nonce: "nonce_c5_00" });
  h.db.sqlite.prepare("DELETE FROM board_topics WHERE id = ?").run(tempTopicId);
  const compDeleted = await h.callApi("POST", `/api/v1/runs/${rDeletedTopic.id}/complete`, nodeTok, {
    lease_owner: "macmini:nonce_c5_00",
    status: "done",
    summary: "done after topic delete",
    output_md: "ok"
  });
  assert.equal(compDeleted.status, 200);
  assert.equal(compDeleted.json.run.status, "done");
});

test("Cron wakeDueWaitingRuns wakes ready due scheduled run behind >100 blocked scheduled runs", async () => {
  const h = createTestHarness();
  const { adminTok } = await h.seedAdminAndNodes();
  const macWs = await h.connectNodeSocket("macmini", "key_01NOD1");

  const baseNowMs = Date.now();
  const nowIso = new Date(baseNowMs).toISOString();
  const blockerThreadId = "thr_01BLOCKER000000000000001";
  const blockerRunId = "run_01BLOCKER000000000000001";
  h.db.sqlite
    .prepare(
      `INSERT INTO threads (id, title, node_id, workdir, project_key, agent, status, last_run_id, created_at, updated_at)
       VALUES (?, 'blocker', 'macmini', '/workspace/demo', 'demo', 'codex', 'active', ?, ?, ?)`
    )
    .run(blockerThreadId, blockerRunId, nowIso, nowIso);
  h.db.sqlite
    .prepare(
      `INSERT INTO runs (
         id, thread_id, root_run_id, parent_run_id, depth, max_depth,
         node_id, workdir, agent, model, effort, sandbox, timeout_sec, prompt,
         status, priority_order, notify_policy_json, notify_status, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, 0, 1, 'macmini', '/workspace/demo', 'codex', '', '', 1, 900, 'failed blocker', 'failed', 100, '{}', 'none', ?, ?)`
    )
    .run(blockerRunId, blockerThreadId, blockerRunId, nowIso, nowIso);

  const blockedDueAt = new Date(baseNowMs - 60_000).toISOString();
  for (let i = 0; i < 105; i++) {
    const suffix = String(i).padStart(4, "0");
    const thrId = `thr_01STARVE00000000000${suffix}`;
    const runId = `run_01STARVE00000000000${suffix}`;
    h.db.sqlite
      .prepare(
        `INSERT INTO threads (id, title, node_id, workdir, project_key, agent, status, last_run_id, created_at, updated_at)
         VALUES (?, ?, 'macmini', '/workspace/demo', 'demo', 'codex', 'active', ?, ?, ?)`
      )
      .run(thrId, `blocked-${i}`, runId, nowIso, nowIso);
    h.db.sqlite
      .prepare(
        `INSERT INTO runs (
           id, thread_id, root_run_id, parent_run_id, depth, max_depth,
           node_id, workdir, agent, model, effort, sandbox, timeout_sec, prompt,
           status, priority_order, notify_policy_json, notify_status, scheduled_at, created_at, updated_at
         ) VALUES (?, ?, ?, NULL, 0, 1, 'macmini', '/workspace/demo', 'codex', '', '', 1, 900, 'blocked scheduled', 'waiting', 100, '{}', 'none', ?, ?, ?)`
      )
      .run(runId, thrId, runId, blockedDueAt, nowIso, nowIso);
    h.db.sqlite
      .prepare(`INSERT INTO run_dependencies (run_id, depends_on_run_id, created_at) VALUES (?, ?, ?)`)
      .run(runId, blockerRunId, nowIso);
  }

  // Create a dependency-free scheduled run with a later scheduled_at than the 105 blocked runs
  const readyCreate = await h.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "ready scheduled run",
    scheduled_at: new Date(baseNowMs + 90_000).toISOString()
  });
  assert.equal(readyCreate.status, 202);
  const readyRunId = readyCreate.json.run.id;
  assert.equal(readyCreate.json.run.status, "waiting");
  assert.equal(readyCreate.json.run.blocked_reason, "SCHEDULED");

  // Make readyRun due, still strictly after all 105 blocked runs
  const readyDueAt = new Date(baseNowMs - 10_000).toISOString();
  h.db.sqlite.prepare("UPDATE runs SET scheduled_at = ? WHERE id = ?").run(readyDueAt, readyRunId);

  const wakesBefore = macWs.frames().filter((f) => f.type === "hub.wake").length;
  await worker.scheduled({}, h.env, h.execCtx);
  await h.flush();

  const readyAfter = await h.callApi("GET", `/api/v1/runs/${readyRunId}`, adminTok);
  assert.equal(readyAfter.status, 200);
  assert.equal(readyAfter.json.run.status, "queued");
  assert.equal(readyAfter.json.run.blocked_reason, null);
  assertRunRecordValid(readyAfter.json.run, "woken ready run");

  const blockedStillWaiting = h.db.sqlite
    .prepare("SELECT COUNT(*) AS cnt FROM runs WHERE id LIKE 'run_01STARVE%' AND status = 'waiting'")
    .get().cnt;
  assert.equal(blockedStillWaiting, 105);
  assert.equal(macWs.frames().filter((f) => f.type === "hub.wake").length, wakesBefore + 1);
});

test("POST /api/v1/plans and POST /api/v1/runs idempotency replays succeed after retryRun rebinds edges (including chained retries), while conflicts still 409", async () => {
  const h = createTestHarness();
  const { adminTok, nodeTok } = await h.seedAdminAndNodes();

  // 1. Plan idempotency replay after single and chained retryRun on upstream node 'a'
  const planPayload = {
    idempotency_key: "plan_retry_replay_0001",
    nodes: [
      { key: "a", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "Upstream A" },
      { key: "b", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "Downstream B", depends_on: ["a"] }
    ]
  };
  const createdPlan = await h.callApi("POST", "/api/v1/plans", adminTok, planPayload);
  assert.equal(createdPlan.status, 201);
  const runA1 = createdPlan.json.runs.find((r) => r.plan_key === "a");
  const runB1 = createdPlan.json.runs.find((r) => r.plan_key === "b");
  assert.equal(runA1.status, "queued");
  assert.equal(runB1.status, "waiting");

  // Claim and fail A1 -> retry A1 into A2 -> claim and fail A2 -> retry A2 into A3
  await h.callApi("POST", "/api/v1/nodes/macmini/claim", nodeTok, { conn_nonce: "nonce_r1_00" });
  await h.callApi("POST", `/api/v1/runs/${runA1.id}/complete`, nodeTok, {
    lease_owner: "macmini:nonce_r1_00",
    status: "failed",
    summary: "A1 failed",
    output_md: "",
    error_code: "FAIL_1",
    error_message: "boom 1"
  });
  const retryA1 = await h.callApi("POST", `/api/v1/runs/${runA1.id}/retry`, adminTok, {});
  assert.equal(retryA1.status, 201);
  assert.deepEqual(retryA1.json.rebound_run_ids, [runB1.id]);
  const runA2 = retryA1.json.run;

  // Replay after 1 hop retry (A1 -> A2)
  const planReplay1 = await h.callApi("POST", "/api/v1/plans", adminTok, planPayload);
  assert.equal(planReplay1.status, 200);
  assert.equal(planReplay1.json.deduplicated, true);
  assert.equal(planReplay1.json.plan_id, createdPlan.json.plan_id);
  assert.equal(planReplay1.json.runs.length, 2);
  assert.deepEqual(
    planReplay1.json.runs.map((r) => r.id),
    [runA1.id, runB1.id]
  );
  for (const r of planReplay1.json.runs) {
    assertRunRecordValid(r, "plan replay 1-hop");
  }
  assert.deepEqual(planReplay1.json.runs[1].depends_on_run_ids, [runA2.id]);

  // Chained retry A2 -> A3
  await h.callApi("POST", "/api/v1/nodes/macmini/claim", nodeTok, { conn_nonce: "nonce_r2_00" });
  await h.callApi("POST", `/api/v1/runs/${runA2.id}/complete`, nodeTok, {
    lease_owner: "macmini:nonce_r2_00",
    status: "failed",
    summary: "A2 failed",
    output_md: "",
    error_code: "FAIL_2",
    error_message: "boom 2"
  });
  const retryA2 = await h.callApi("POST", `/api/v1/runs/${runA2.id}/retry`, adminTok, {});
  assert.equal(retryA2.status, 201);
  assert.deepEqual(retryA2.json.rebound_run_ids, [runB1.id]);
  const runA3 = retryA2.json.run;

  // Replay after 2-hop chained retry (A1 -> A2 -> A3)
  const planReplay2 = await h.callApi("POST", "/api/v1/plans", adminTok, planPayload);
  assert.equal(planReplay2.status, 200);
  assert.equal(planReplay2.json.deduplicated, true);
  assert.equal(planReplay2.json.runs.length, 2);
  assert.deepEqual(planReplay2.json.runs[1].depends_on_run_ids, [runA3.id]);

  // Changed replay payload still returns 409 IDEMPOTENCY_CONFLICT
  const planConflict = await h.callApi("POST", "/api/v1/plans", adminTok, {
    ...planPayload,
    nodes: [
      { key: "a", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "Upstream A" },
      { key: "b", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "Modified prompt", depends_on: ["a"] }
    ]
  });
  assert.equal(planConflict.status, 409);
  assert.equal(planConflict.json.error.code, "IDEMPOTENCY_CONFLICT");

  // 2. Single-run POST /api/v1/runs idempotency replay after retryRun rebounds depends_on edge
  const upRun = (
    await h.callApi("POST", "/api/v1/runs", adminTok, {
      node_id: "macmini",
      workdir: "other",
      agent: "codex",
      prompt: "Single upstream"
    })
  ).json.run;
  const singleWaitReq = {
    idempotency_key: "single_run_retry_idem_0001",
    node_id: "macmini",
    workdir: "other",
    agent: "codex",
    prompt: "Waiting child",
    depends_on: [upRun.id]
  };
  const createdWait = await h.callApi("POST", "/api/v1/runs", adminTok, singleWaitReq);
  assert.equal(createdWait.status, 202);
  assert.equal(createdWait.json.run.status, "waiting");

  // Claim & fail upRun (note: runA3 is also queued on macmini, claim returns both or ordered)
  const claimAll = await h.callApi("POST", "/api/v1/nodes/macmini/claim", nodeTok, { conn_nonce: "nonce_r3_00" });
  const claimedUp = claimAll.json.claimed_runs.find((r) => r.id === upRun.id);
  assert.ok(claimedUp);
  await h.callApi("POST", `/api/v1/runs/${upRun.id}/complete`, nodeTok, {
    lease_owner: "macmini:nonce_r3_00",
    status: "failed",
    summary: "Single upstream failed",
    output_md: "",
    error_code: "FAIL_UP",
    error_message: "boom up"
  });
  const retryUp = await h.callApi("POST", `/api/v1/runs/${upRun.id}/retry`, adminTok, {});
  assert.equal(retryUp.status, 201);
  assert.deepEqual(retryUp.json.rebound_run_ids, [createdWait.json.run.id]);
  const upRun2 = retryUp.json.run;

  const singleReplay = await h.callApi("POST", "/api/v1/runs", adminTok, singleWaitReq);
  assert.equal(singleReplay.status, 202);
  assert.equal(singleReplay.json.run.id, createdWait.json.run.id);
  assert.deepEqual(singleReplay.json.run.depends_on_run_ids, [upRun2.id]);
  assertRunRecordValid(singleReplay.json.run, "single run replay after retry");

  const singleConflict = await h.callApi("POST", "/api/v1/runs", adminTok, {
    ...singleWaitReq,
    prompt: "Different prompt"
  });
  assert.equal(singleConflict.status, 409);
  assert.equal(singleConflict.json.error.code, "IDEMPOTENCY_CONFLICT");
});

test("Cross-key client idempotency replay is blocked with 403 FORBIDDEN_SCOPE and redeliverSourceDeliveries hydrates Slice 2 fields", async () => {
  const h = createTestHarness();
  const { adminTok } = await h.seedAdminAndNodes();

  const cliARes = await h.callApi("POST", "/api/v1/keys", adminTok, {
    name: "cli-a",
    scope: "client",
    allowed_nodes: ["macmini"]
  });
  const cliBRes = await h.callApi("POST", "/api/v1/keys", adminTok, {
    name: "cli-b",
    scope: "client",
    allowed_nodes: ["macmini"]
  });
  const cliATok = cliARes.json.token;
  const cliBTok = cliBRes.json.token;

  // Client A creates a plan with idempotency_key -> Client B using the same key gets 403 FORBIDDEN_SCOPE
  const planBody = {
    idempotency_key: "cross_key_plan_idem_01",
    nodes: [{ key: "a", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "Secret task A" }]
  };
  const createdPlan = await h.callApi("POST", "/api/v1/plans", cliATok, planBody);
  assert.equal(createdPlan.status, 201);

  const crossPlan = await h.callApi("POST", "/api/v1/plans", cliBTok, planBody);
  assert.equal(crossPlan.status, 403);
  assert.equal(crossPlan.json.error.code, "FORBIDDEN_SCOPE");

  // Client A creates a run with idempotency_key -> Client B using the same key gets 403 FORBIDDEN_SCOPE
  const runBody = {
    idempotency_key: "cross_key_run_idem_01",
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "Secret run A"
  };
  const createdRun = await h.callApi("POST", "/api/v1/runs", cliATok, runBody);
  assert.equal(createdRun.status, 202);

  const crossRun = await h.callApi("POST", "/api/v1/runs", cliBTok, runBody);
  assert.equal(crossRun.status, 403);
  assert.equal(crossRun.json.error.code, "FORBIDDEN_SCOPE");

  // redeliverSourceDeliveries hydrates depends_on_run_ids and blocked_reason on RunRecord
  const upRun = (
    await h.callApi("POST", "/api/v1/runs", adminTok, {
      node_id: "macmini",
      workdir: "demo",
      agent: "codex",
      prompt: "upstream for redeliver"
    })
  ).json.run;
  const depChild = (
    await h.callApi("POST", "/api/v1/runs", adminTok, {
      node_id: "macmini",
      workdir: "demo",
      agent: "codex",
      prompt: "child for redeliver",
      depends_on: [upRun.id]
    })
  ).json.run;
  await h.callApi("POST", `/api/v1/runs/${depChild.id}/cancel`, adminTok, {});
  const redeliverRes = await h.callApi("POST", `/api/v1/runs/${depChild.id}/redeliver`, adminTok, {});
  assert.equal(redeliverRes.status, 200);
  assertRunRecordValid(redeliverRes.json.run, "redeliver run");
  assert.deepEqual(redeliverRes.json.run.depends_on_run_ids, [upRun.id]);
  assert.equal(redeliverRes.json.run.blocked_reason, null);
});

test("T5-01: cross-tenant parent_run_id is rejected with 403 FORBIDDEN_SCOPE on /runs and /plans while admin->delegation_token on allowed node succeeds", async () => {
  const h = createTestHarness();
  const { adminTok } = await h.seedAdminAndNodes();

  const cliARes = await h.callApi("POST", "/api/v1/keys", adminTok, {
    name: "t501-cli-a",
    scope: "client",
    allowed_nodes: ["macmini"]
  });
  const cliBRes = await h.callApi("POST", "/api/v1/keys", adminTok, {
    name: "t501-cli-b",
    scope: "client",
    allowed_nodes: ["mbp"]
  });
  const cliBMacRes = await h.callApi("POST", "/api/v1/keys", adminTok, {
    name: "t501-cli-b-mac",
    scope: "client",
    allowed_nodes: ["macmini", "mbp"]
  });
  const cliATok = cliARes.json.token;
  const cliBTok = cliBRes.json.token;
  const cliBMacTok = cliBMacRes.json.token;

  const adminRoot = (
    await h.callApi("POST", "/api/v1/runs", adminTok, {
      node_id: "macmini",
      workdir: "demo",
      agent: "codex",
      prompt: "Admin root run"
    })
  ).json.run;
  const cliARoot = (
    await h.callApi("POST", "/api/v1/runs", cliATok, {
      node_id: "macmini",
      workdir: "demo",
      agent: "codex",
      prompt: "Client A root run"
    })
  ).json.run;
  // Create a depth=1 child on mbp under adminRoot so we also verify 403 takes precedence over 409 DEPTH_LIMIT_EXCEEDED for macmini-only clients
  const adminDepth1 = (
    await h.callApi("POST", "/api/v1/runs", adminTok, {
      node_id: "mbp",
      workdir: "demo",
      agent: "codex",
      parent_run_id: adminRoot.id,
      prompt: "Admin depth 1 child"
    })
  ).json.run;
  assert.equal(adminDepth1.depth, 1);

  // 1. Client B (mbp-only) cannot attach to Client A or Admin parent_run_id on macmini
  // 2. Client A (macmini-only) cannot attach to Admin depth=1 parent_run_id on mbp (403 before 409)
  // 3. Rival Client B (even allowed on macmini) cannot attach to Client A parent_run_id on macmini
  for (const [tok, parentId, targetNode] of [
    [cliBTok, cliARoot.id, "mbp"],
    [cliBTok, adminRoot.id, "mbp"],
    [cliATok, adminDepth1.id, "macmini"],
    [cliBMacTok, cliARoot.id, "macmini"]
  ]) {
    const runAttach = await h.callApi("POST", "/api/v1/runs", tok, {
      node_id: targetNode,
      workdir: "demo",
      agent: "codex",
      parent_run_id: parentId,
      prompt: "Unauthorized attach run"
    });
    assert.equal(runAttach.status, 403);
    assert.equal(runAttach.json.error.code, "FORBIDDEN_SCOPE");

    const planAttach = await h.callApi("POST", "/api/v1/plans", tok, {
      parent_run_id: parentId,
      nodes: [
        {
          key: "child",
          node_id: targetNode,
          workdir: "demo",
          agent: "codex",
          prompt: "Unauthorized attach plan"
        }
      ]
    });
    assert.equal(planAttach.status, 403);
    assert.equal(planAttach.json.error.code, "FORBIDDEN_SCOPE");
  }

  // 4. Legitimate delegation_token (client allowed on macmini & mbp) CAN delegate from adminRoot on macmini to mbp
  const delRun = await h.callApi("POST", "/api/v1/runs", cliBMacTok, {
    node_id: "mbp",
    workdir: "demo",
    agent: "codex",
    parent_run_id: adminRoot.id,
    prompt: "Legit delegation from adminRoot via delegation_token"
  });
  assert.equal(delRun.status, 202);
  assert.equal(delRun.json.run.root_run_id, adminRoot.id);
  assert.equal(delRun.json.run.depth, 1);

  const delPlan = await h.callApi("POST", "/api/v1/plans", cliBMacTok, {
    parent_run_id: adminRoot.id,
    nodes: [
      {
        key: "step1",
        node_id: "mbp",
        workdir: "demo",
        agent: "codex",
        prompt: "Legit plan delegation from adminRoot"
      }
    ]
  });
  assert.equal(delPlan.status, 201);
  assert.equal(delPlan.json.runs[0].root_run_id, adminRoot.id);

  // Verify zero lineage pollution on cliARoot (and adminRoot only contains legit children)
  const adminTree = await h.callApi("GET", `/api/v1/runs?root_run_id=${adminRoot.id}`, adminTok);
  assert.equal(adminTree.status, 200);
  assert.equal(adminTree.json.runs.length, 4);

  const cliATree = await h.callApi("GET", `/api/v1/runs?root_run_id=${cliARoot.id}`, adminTok);
  assert.equal(cliATree.status, 200);
  assert.equal(cliATree.json.runs.length, 1);
});

test("T5-02: cancelRun queued->claimed TOCTOU race still dispatches hub.abort and resets nodes.active_runs_count", async () => {
  const h = createTestHarness();
  const { adminTok } = await h.seedAdminAndNodes();
  const nodeWs = await h.connectNodeSocket("macmini");

  const run = (
    await h.callApi("POST", "/api/v1/runs", adminTok, {
      node_id: "macmini",
      workdir: "demo",
      agent: "codex",
      prompt: "Race cancel target"
    })
  ).json.run;
  assert.equal(run.status, "queued");

  // Interleave claimRunsForNode right before cancelRun executes its first conditional UPDATE
  const origPrepare = h.db.prepare.bind(h.db);
  let injectedClaim = false;
  h.db.prepare = (sql) => {
    const stmt = origPrepare(sql);
    if (!injectedClaim && typeof sql === "string" && sql.includes("SET status = 'cancelled'")) {
      return {
        bind(...params) {
          const bound = stmt.bind(...params);
          return {
            first: bound.first.bind(bound),
            all: bound.all.bind(bound),
            async run() {
              if (!injectedClaim) {
                injectedClaim = true;
                const claimed = await claimRunsForNode(h.db, "macmini", "race_nonce_01", [], 60);
                assert.equal(claimed.length, 1);
                assert.equal(claimed[0].id, run.id);
              }
              return bound.run();
            }
          };
        }
      };
    }
    return stmt;
  };

  const cancelRes = await h.callApi("POST", `/api/v1/runs/${run.id}/cancel`, adminTok, {
    reason: "race cancel"
  });
  h.db.prepare = origPrepare;

  assert.equal(injectedClaim, true);
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.json.cancelled_runs[0].status, "cancelled");

  const abortFrames = nodeWs.frames().filter((f) => f.type === "hub.abort" && f.run_id === run.id);
  assert.equal(abortFrames.length, 1, "expected hub.abort frame after queued->claimed race");

  const nodeRow = h.db.sqlite.prepare("SELECT active_runs_count FROM nodes WHERE id = 'macmini'").get();
  assert.equal(nodeRow.active_runs_count, 0, "expected active_runs_count reset to 0 after cancel");
});

test("T5-03: createRun Idempotency-Key detects conflicts on all run parameters and isolates namespace from plan:/retry:", async () => {
  const h = createTestHarness();
  const { adminTok, nodeTok } = await h.seedAdminAndNodes();

  const baseReq = {
    idempotency_key: "t503_idem_run_0001",
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    model: "sonnet",
    effort: "medium",
    sandbox: true,
    timeout_sec: 300,
    notify: { target: "none" },
    prompt: "Base idempotent run"
  };

  const created = await h.callApi("POST", "/api/v1/runs", adminTok, baseReq);
  assert.equal(created.status, 202);
  const baseRun = created.json.run;

  // Exact replay deduplicates
  const replay = await h.callApi("POST", "/api/v1/runs", adminTok, baseReq);
  assert.equal(replay.status, 202);
  assert.equal(replay.json.run.id, baseRun.id);

  // Changing model, effort, sandbox, timeout_sec, notify, parent_run_id, or thread_id must 409 IDEMPOTENCY_CONFLICT
  const parentRun = (
    await h.callApi("POST", "/api/v1/runs", adminTok, {
      node_id: "mbp",
      workdir: "demo",
      agent: "codex",
      prompt: "Parent for T5-03"
    })
  ).json.run;
  const otherRun = (
    await h.callApi("POST", "/api/v1/runs", adminTok, {
      node_id: "macmini",
      workdir: "other",
      agent: "codex",
      prompt: "Other thread seed"
    })
  ).json.run;

  const conflictMutations = [
    { ...baseReq, model: "opus" },
    { ...baseReq, effort: "high" },
    { ...baseReq, sandbox: false },
    { ...baseReq, timeout_sec: 600 },
    { ...baseReq, notify: { target: "grok" } },
    { ...baseReq, parent_run_id: parentRun.id },
    {
      idempotency_key: baseReq.idempotency_key,
      thread_id: otherRun.thread_id,
      prompt: baseReq.prompt,
      model: baseReq.model,
      effort: baseReq.effort,
      sandbox: baseReq.sandbox,
      timeout_sec: baseReq.timeout_sec,
      notify: baseReq.notify
    }
  ];
  for (const mutated of conflictMutations) {
    const res = await h.callApi("POST", "/api/v1/runs", adminTok, mutated);
    assert.equal(res.status, 409, `expected 409 for mutation ${JSON.stringify(mutated)}`);
    assert.equal(res.json.error.code, "IDEMPOTENCY_CONFLICT");
  }

  // Namespace isolation from plan: and retry: prefixes
  const planRes = await h.callApi("POST", "/api/v1/plans", adminTok, {
    idempotency_key: "ns_shared_key_01",
    nodes: [{ key: "p1", node_id: "macmini", workdir: "demo", agent: "codex", prompt: "Plan step" }]
  });
  assert.equal(planRes.status, 201);

  const runWithPlanPrefix = await h.callApi("POST", "/api/v1/runs", adminTok, {
    idempotency_key: "plan:ns_shared_key_01",
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "Run with plan: prefix key"
  });
  assert.equal(runWithPlanPrefix.status, 202);
  assert.notEqual(runWithPlanPrefix.json.run.id, planRes.json.runs[0].id);

  // Also fail parentRun and retry with idempotency_key, then submit /runs with retry: prefix
  await h.callApi("POST", "/api/v1/nodes/mbp/claim", nodeTok, { conn_nonce: "nonce_mbp_t503" }).catch(() => {});
  h.db.sqlite.prepare("UPDATE runs SET status = 'failed', finished_at = ? WHERE id = ?").run(new Date().toISOString(), parentRun.id);
  const retryRes = await h.callApi("POST", `/api/v1/runs/${parentRun.id}/retry`, adminTok, {
    idempotency_key: "ns_shared_key_01"
  });
  assert.equal(retryRes.status, 201);

  const runWithRetryPrefix = await h.callApi("POST", "/api/v1/runs", adminTok, {
    idempotency_key: "retry:ns_shared_key_01",
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "Run with retry: prefix key"
  });
  assert.equal(runWithRetryPrefix.status, 202);
  assert.notEqual(runWithRetryPrefix.json.run.id, retryRes.json.run.id);
});

test("Finding 1: symmetric secret redaction on summary, output_md/output_preview, remote_control_url across /complete, /approval, /resolve, GET /runs/:id, WS, and ahub_run_completed webhook", async () => {
  const h = createTestHarness();
  const { adminTok, nodeTok } = await h.seedAdminAndNodes();
  const ws = await h.openAdminStream();

  const webhookPayloads = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      webhookPayloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));

  try {
    const addr = srv.address();
    const hookUrl = `http://127.0.0.1:${addr.port}/hook`;
    const keyRes = await h.callApi("POST", "/api/v1/keys", adminTok, {
      name: "bot-redact-test",
      scope: "client",
      allowed_nodes: ["macmini"],
      webhook_url: hookUrl,
      webhook_key: "wh_test_key"
    });
    assert.equal(keyRes.status, 201);
    const clientTok = keyRes.json.token;

    // 1. /complete flow + outbound ahub_run_completed webhook
    const summarySecretA = "sk-proj-COMPLETESECRET123456";
    const summarySecretB = "ahub_adm_COMPLETETOKEN999999";
    const outputSecretA = "ghp_OUTPUTSECRET1234567890ab";
    const outputSecretB = "ahub_cli_OUTPUTTOKEN888888";

    const createRes = await h.callApi("POST", "/api/v1/runs", clientTok, {
      node_id: "macmini",
      workdir: "demo",
      agent: "codex",
      notify: { target: "webhook", events: ["done"] },
      prompt: "Run redaction complete test"
    });
    assert.equal(createRes.status, 202);
    const run1Id = createRes.json.run.id;

    const claim1 = await h.callApi("POST", "/api/v1/nodes/macmini/claim", nodeTok, {
      conn_nonce: "nonce_red_1"
    });
    assert.equal(claim1.status, 200);
    assert.equal(claim1.json.claimed_runs[0].id, run1Id);

    const completeRes = await h.callApi("POST", `/api/v1/runs/${run1Id}/complete`, nodeTok, {
      lease_owner: "macmini:nonce_red_1",
      status: "done",
      resolved_model: "gpt-5.4",
      resolved_effort: "high",
      summary: `done with ${summarySecretA} and ${summarySecretB}`,
      output_md: `full md with ${outputSecretA} and ${outputSecretB}`,
      output_bytes: 128,
      duration_ms: 42
    });
    assert.equal(completeRes.status, 200);

    const getSum = await h.callApi("GET", `/api/v1/runs/${run1Id}?view=summary`, adminTok);
    const getFull = await h.callApi("GET", `/api/v1/runs/${run1Id}?view=full`, adminTok);
    const dbRow = h.db.sqlite.prepare("SELECT summary, output_md FROM runs WHERE id = ?").get(run1Id);

    for (const [label, text] of [
      ["completeResp.summary", completeRes.json.run.summary],
      ["completeResp.output_preview", completeRes.json.run.output_preview],
      ["getSum.summary", getSum.json.run.summary],
      ["getSum.output_preview", getSum.json.run.output_preview],
      ["getFull.summary", getFull.json.run.summary],
      ["getFull.output_md", getFull.json.run.output_md],
      ["dbRow.summary", dbRow.summary],
      ["dbRow.output_md", dbRow.output_md]
    ]) {
      for (const sec of [summarySecretA, summarySecretB, outputSecretA, outputSecretB]) {
        assert.equal(text.includes(sec), false, `${label} leaked ${sec}: ${text}`);
      }
    }
    assert.equal(getFull.json.run.summary.includes("[REDACTED]"), true);
    assert.equal(getFull.json.run.summary.includes("ahub_adm_[REDACTED]"), true);
    assert.equal(getFull.json.run.output_md.includes("[REDACTED]"), true);
    assert.equal(getFull.json.run.output_md.includes("ahub_cli_[REDACTED]"), true);

    const wsFramesRaw = JSON.stringify(ws.frames());
    for (const sec of [summarySecretA, summarySecretB, outputSecretA, outputSecretB]) {
      assert.equal(wsFramesRaw.includes(sec), false, `WS broadcast leaked ${sec}`);
    }

    // Drain NOTIFY_QUEUE via worker.queue and inspect outbound ahub_run_completed payload
    assert.equal(h.queueMessages.length > 0, true);
    const batch = {
      messages: h.queueMessages.splice(0).map((q) => ({
        body: q.msg,
        attempts: 1,
        ack() {},
        retry() {}
      }))
    };
    await workerModule.default.queue(batch, h.env, h.execCtx);
    assert.equal(webhookPayloads.length, 1);
    assert.equal(webhookPayloads[0].event, "ahub_run_completed");
    assert.equal(webhookPayloads[0].summary.includes(summarySecretA), false);
    assert.equal(webhookPayloads[0].summary.includes(summarySecretB), false);
    assert.equal(webhookPayloads[0].summary.includes("[REDACTED]"), true);

    // 2. /approval + /resolve redaction + benign soft_approval URL preservation
    const apprRcSecret = "https://user:pass123@example.com/rc?token=rc_secret_999";
    const apprSummarySec = "sk-proj-APPRSECRET123456";
    const apprMdSec = "ahub_adm_APPRSECRET999999";
    const resvSummarySec = "sk-proj-RESVSECRET123456";

    const create2 = await h.callApi("POST", "/api/v1/runs", adminTok, {
      node_id: "macmini",
      workdir: "demo",
      agent: "agy",
      prompt: "Run approval redaction test"
    });
    assert.equal(create2.status, 202);
    const run2Id = create2.json.run.id;

    const claim2 = await h.callApi("POST", "/api/v1/nodes/macmini/claim", nodeTok, {
      conn_nonce: "nonce_red_2"
    });
    assert.equal(claim2.status, 200);
    const lease2 = "macmini:nonce_red_2";

    const apprRes = await h.callApi("POST", `/api/v1/runs/${run2Id}/approval`, nodeTok, {
      lease_owner: lease2,
      remote_control_url: apprRcSecret,
      summary: `paused ${apprSummarySec}`,
      output_md: `paused md ${apprMdSec}`,
      output_bytes: 64,
      duration_ms: 15
    });
    assert.equal(apprRes.status, 200);
    assert.equal(apprRes.json.run.remote_control_url, "https://[REDACTED]@example.com/rc?token=[REDACTED]");
    assert.equal(apprRes.json.run.summary.includes(apprSummarySec), false);
    assert.equal(apprRes.json.run.output_preview.includes(apprMdSec), false);

    // Benign remote_control_url like V06_SoftApprovalLifecycle must stay intact
    const apprBenign = await h.callApi("POST", `/api/v1/runs/${run2Id}/approval`, nodeTok, {
      lease_owner: lease2,
      remote_control_url: "https://claude.ai/code/session_01FAKE",
      summary: "still waiting"
    });
    assert.equal(apprBenign.status, 200);
    assert.equal(apprBenign.json.run.remote_control_url, "https://claude.ai/code/session_01FAKE");

    const resvRes = await h.callApi("POST", `/api/v1/runs/${run2Id}/resolve`, adminTok, {
      summary: `resolved ${resvSummarySec}`
    });
    assert.equal(resvRes.status, 200);
    assert.equal(resvRes.json.run.summary.includes(resvSummarySec), false);
    assert.equal(resvRes.json.run.summary.includes("[REDACTED]"), true);
    const dbRow2 = h.db.sqlite.prepare("SELECT summary, output_md, remote_control_url FROM runs WHERE id = ?").get(run2Id);
    assert.equal(dbRow2.summary.includes(resvSummarySec), false);
    assert.equal(dbRow2.output_md.includes(apprMdSec), false);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("Finding 2: createPlan Idempotency-Key detects conflicts on nodes[].priority_order and nodes[].title", async () => {
  const h = createTestHarness();
  const { adminTok } = await h.seedAdminAndNodes();

  const basePlan = {
    idempotency_key: "plan_idem_prio_title_01",
    nodes: [
      {
        key: "step_a",
        node_id: "macmini",
        workdir: "demo",
        agent: "codex",
        title: "Title A",
        priority_order: 1,
        prompt: "Execute plan step A"
      }
    ]
  };

  const created = await h.callApi("POST", "/api/v1/plans", adminTok, basePlan);
  assert.equal(created.status, 201);
  const replay = await h.callApi("POST", "/api/v1/plans", adminTok, basePlan);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.deduplicated, true);

  for (const mutated of [
    { ...basePlan, nodes: [{ ...basePlan.nodes[0], title: "Title B" }] },
    { ...basePlan, nodes: [{ key: "step_a", node_id: "macmini", workdir: "demo", agent: "codex", priority_order: 1, prompt: "Execute plan step A" }] },
    { ...basePlan, nodes: [{ ...basePlan.nodes[0], priority_order: 9 }] },
    { ...basePlan, nodes: [{ ...basePlan.nodes[0], priority_order: 0 }] }
  ]) {
    const res = await h.callApi("POST", "/api/v1/plans", adminTok, mutated);
    assert.equal(res.status, 409, `expected 409 for ${JSON.stringify(mutated)}`);
    assert.equal(res.json.error.code, "IDEMPOTENCY_CONFLICT");
  }

  // Plan created with default priority_order & derived title: exact replay succeeds, overrides conflict
  const defaultPlan = {
    idempotency_key: "plan_idem_prio_title_02",
    nodes: [
      {
        key: "step_b",
        node_id: "macmini",
        workdir: "demo",
        agent: "codex",
        prompt: "Derived title from prompt"
      }
    ]
  };
  const created2 = await h.callApi("POST", "/api/v1/plans", adminTok, defaultPlan);
  assert.equal(created2.status, 201);
  const replay2 = await h.callApi("POST", "/api/v1/plans", adminTok, defaultPlan);
  assert.equal(replay2.status, 200);
  assert.equal(replay2.json.deduplicated, true);

  const conflictTitle2 = await h.callApi("POST", "/api/v1/plans", adminTok, {
    ...defaultPlan,
    nodes: [{ ...defaultPlan.nodes[0], title: "Explicit Override" }]
  });
  assert.equal(conflictTitle2.status, 409);
  assert.equal(conflictTitle2.json.error.code, "IDEMPOTENCY_CONFLICT");

  const conflictPrio2 = await h.callApi("POST", "/api/v1/plans", adminTok, {
    ...defaultPlan,
    nodes: [{ ...defaultPlan.nodes[0], priority_order: 9 }]
  });
  assert.equal(conflictPrio2.status, 409);
  assert.equal(conflictPrio2.json.error.code, "IDEMPOTENCY_CONFLICT");
});

test("threads.title redacts secrets across POST /runs, GET /threads, /ws/stream snapshot, PATCH /threads/:id, and POST /threads/:id/fork", async () => {
  const h = createTestHarness();
  const { adminTok } = await h.seedAdminAndNodes();

  const promptSecret = "sk-proj-thread_prompt_line1_secret_9876543210";
  const longPadding = "a".repeat(65);
  const tailSecret = "sk-proj-tail_boundary_secret_1234567890abcd";
  const patchSecret = "xoxb-" + "123456789012-1234567890123-PatchThreadSecret";
  const forkSecret = "ghp_ForkThreadExplicitSecret1234567890ab";
  const legacySecret = "ahub_adm_LegacyThreadRowSecret999999";

  // 1. Prompt-derived title with line-1 secret (no explicit title)
  const createRes = await h.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: `Check token=${promptSecret} please\nsecond line`
  });
  assert.equal(createRes.status, 202);
  const thrId = createRes.json.run.thread_id;

  // 2. Long line-1 secret crossing the 80-char boundary must be redacted BEFORE .slice(0, 80)
  const boundaryRes = await h.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "other",
    agent: "codex",
    prompt: `${longPadding} ${tailSecret}\nline2`
  });
  assert.equal(boundaryRes.status, 202);
  const boundaryThrId = boundaryRes.json.run.thread_id;

  // 3. Legacy unredacted row in DB must still be masked on read / snapshot via mapThreadRow
  const now = new Date().toISOString();
  h.db.sqlite
    .prepare(
      `INSERT INTO threads (id, title, node_id, workdir, project_key, agent, native_session_id, status, pinned, sort_order, last_run_id, created_at, updated_at)
       VALUES ('thr_01LEGACY', ?, 'macmini', '/workspace/demo', 'demo', 'codex', NULL, 'active', 0, 0, NULL, ?, ?)`
    )
    .run(`Legacy ${legacySecret}`, now, now);

  const listRes = await h.callApi("GET", "/api/v1/threads", adminTok);
  assert.equal(listRes.status, 200);
  const thr1 = listRes.json.threads.find((t) => t.id === thrId);
  const thrBoundary = listRes.json.threads.find((t) => t.id === boundaryThrId);
  const thrLegacy = listRes.json.threads.find((t) => t.id === "thr_01LEGACY");
  assert.ok(thr1 && thrBoundary && thrLegacy);
  assert.equal(thr1.title, "Check token=[REDACTED] please");
  assert.equal(thrBoundary.title.includes("sk-proj"), false, `boundary slice leaked secret prefix: ${thrBoundary.title}`);
  assert.equal(thrBoundary.title.includes("[RED"), true);
  assert.equal(thrLegacy.title, "Legacy ahub_adm_[REDACTED]");

  const dbRow1 = h.db.sqlite.prepare("SELECT title FROM threads WHERE id = ?").get(thrId);
  assert.equal(dbRow1.title.includes(promptSecret), false);
  assert.equal(dbRow1.title, "Check token=[REDACTED] please");

  // /ws/stream snapshot.threads must also mask all thread titles
  const snapshot = await buildStreamSnapshotPayload(
    h.db,
    { kind: "api_key", scope: "admin", keyId: "key_01ADM1", allowedNodes: [], allowedBoardPrefixes: ["*"] },
    null,
    null
  );
  const snapRaw = JSON.stringify(snapshot.threads);
  for (const s of [promptSecret, tailSecret, legacySecret]) {
    assert.equal(snapRaw.includes(s), false, `snapshot.threads leaked ${s}`);
  }

  // 4. Fork inherits redacted title (not raw secret) and redacts explicit fork title
  const forkAuto = await h.callApi("POST", `/api/v1/threads/${thrId}/fork`, adminTok, {
    node_id: "mbp",
    workdir: "demo"
  });
  assert.equal(forkAuto.status, 202);
  assert.equal(forkAuto.json.thread.title, "Check token=[REDACTED] please (fork)");
  const forkAutoDb = h.db.sqlite.prepare("SELECT title FROM threads WHERE id = ?").get(forkAuto.json.thread.id);
  assert.equal(forkAutoDb.title, "Check token=[REDACTED] please (fork)");

  const forkExplicit = await h.callApi("POST", `/api/v1/threads/${thrId}/fork`, adminTok, {
    node_id: "mbp",
    workdir: "demo",
    title: `Forked ${forkSecret}`
  });
  assert.equal(forkExplicit.status, 202);
  assert.equal(forkExplicit.json.thread.title, "Forked [REDACTED]");

  // 5. PATCH /api/v1/threads/:id redacts persisted title and returned ThreadRecord
  const patchRes = await h.callApi("PATCH", `/api/v1/threads/${thrId}`, adminTok, {
    title: `Patched ${patchSecret}`
  });
  assert.equal(patchRes.status, 200);
  assert.equal(patchRes.json.thread.title, "Patched [REDACTED]");
  const dbPatched = h.db.sqlite.prepare("SELECT title FROM threads WHERE id = ?").get(thrId);
  assert.equal(dbPatched.title, "Patched [REDACTED]");

  const snapshotAfter = await buildStreamSnapshotPayload(
    h.db,
    { kind: "api_key", scope: "admin", keyId: "key_01ADM1", allowedNodes: [], allowedBoardPrefixes: ["*"] },
    null,
    null
  );
  const snapAfterRaw = JSON.stringify(snapshotAfter.threads);
  for (const s of [promptSecret, patchSecret, forkSecret, legacySecret]) {
    assert.equal(snapAfterRaw.includes(s), false, `snapshot.threads after patch/fork leaked ${s}`);
  }
});

test("POST /api/v1/plans redacts prompt-derived and explicit secret titles and aligns idempotency replay", async () => {
  const h = createTestHarness();
  const { adminTok } = await h.seedAdminAndNodes();

  const promptSecret = "ahub_adm_PlanPromptDerivedThreadSecret1234";
  const explicitSecret = "sk-proj-PlanExplicitThreadSecret1234567890";

  const planBody = {
    idempotency_key: "plan_threads_title_secret_01",
    nodes: [
      {
        key: "step_prompt",
        node_id: "macmini",
        workdir: "demo",
        agent: "codex",
        prompt: `Run with ${promptSecret}\nsecond line`
      },
      {
        key: "step_explicit",
        node_id: "mbp",
        workdir: "demo",
        agent: "codex",
        title: `Title ${explicitSecret}`,
        prompt: "Normal prompt"
      }
    ]
  };

  const created = await h.callApi("POST", "/api/v1/plans", adminTok, planBody);
  assert.equal(created.status, 201);

  const threadsRes = await h.callApi("GET", "/api/v1/threads", adminTok);
  assert.equal(threadsRes.status, 200);
  const promptThr = threadsRes.json.threads.find((t) => t.id === created.json.runs[0].thread_id);
  const explicitThr = threadsRes.json.threads.find((t) => t.id === created.json.runs[1].thread_id);
  assert.equal(promptThr.title, "Run with ahub_adm_[REDACTED]");
  assert.equal(explicitThr.title, "Title [REDACTED]");

  const dbTitles = h.db.sqlite
    .prepare("SELECT id, title FROM threads WHERE id IN (?, ?)")
    .all(promptThr.id, explicitThr.id);
  for (const row of dbTitles) {
    assert.equal(row.title.includes(promptSecret), false);
    assert.equal(row.title.includes(explicitSecret), false);
  }

  // Exact replay with secrets in prompt and explicit title must return 200 deduplicated: true
  const replay = await h.callApi("POST", "/api/v1/plans", adminTok, planBody);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.deduplicated, true);
  assert.equal(replay.json.plan_id, created.json.plan_id);

  // Mutated title must still 409 IDEMPOTENCY_CONFLICT
  const conflict = await h.callApi("POST", "/api/v1/plans", adminTok, {
    ...planBody,
    nodes: [
      planBody.nodes[0],
      { ...planBody.nodes[1], title: "Title Different" }
    ]
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, "IDEMPOTENCY_CONFLICT");
});
