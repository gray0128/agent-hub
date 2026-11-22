import assert from "node:assert/strict";
import fs from "node:fs";
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
const { NodeHub } = await import("../src/node-hub.ts");
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
