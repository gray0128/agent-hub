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
const {
  validateResultSchemaDefinition,
  validateValueAgainstSchema,
  deepEqualJson
} = await import("../src/json-schema-subset.ts");
const { listRuns } = await import("../src/db.ts");

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
    WEBHOOK_ENCRYPTION_KEY: "test-encryption-secret-for-slice3-suite",
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

  async function openAdminStream(scope = "admin", keyId = null) {
    const ws = createMockWebSocket(["stream"]);
    ws.serializeAttachment({
      role: "stream",
      runId: null,
      topicId: null,
      scope,
      keyId,
      boundNodeId: null,
      allowedNodes: [],
      allowedBoardPrefixes: ["*"]
    });
    acceptedSockets.push(ws);
    return ws;
  }

  async function seedTokensAndNodes() {
    const now = new Date().toISOString();
    const adminTok = "ahub_adm_slice3_admin_token_0001";
    const nodeTok = "ahub_nod_slice3_macmini_tok_0001";
    const clientATok = "ahub_cli_slice3_client_a_tok_0001";
    const clientBTok = "ahub_cli_slice3_client_b_tok_0001";

    db.sqlite
      .prepare(
        `INSERT INTO nodes (id, display_name, os, arch, version, capabilities_json, workspaces_json, status, max_concurrency, active_runs_count, created_at, updated_at)
         VALUES ('macmini', 'MacMini', 'darwin', 'arm64', '0.2.0', '{}', ?, 'online', 4, 0, ?, ?)`
      )
      .run(JSON.stringify([{ key: "demo", path: "/workspace/demo" }]), now, now);

    const keys = [
      {
        id: "key_01ADM3",
        name: "admin-slice3",
        scope: "admin",
        boundNodeId: null,
        tok: adminTok,
        allowedNodes: "[]",
        allowedBoard: '["*"]'
      },
      {
        id: "key_01NOD3",
        name: "node-macmini",
        scope: "node",
        boundNodeId: "macmini",
        tok: nodeTok,
        allowedNodes: "[]",
        allowedBoard: "[]"
      },
      {
        id: "key_01CLIA",
        name: "client-a",
        scope: "client",
        boundNodeId: null,
        tok: clientATok,
        allowedNodes: '["macmini"]',
        allowedBoard: '["eng/*"]'
      },
      {
        id: "key_01CLIB",
        name: "client-b",
        scope: "client",
        boundNodeId: null,
        tok: clientBTok,
        allowedNodes: '["macmini"]',
        allowedBoard: '["eng/*"]'
      }
    ];

    for (const k of keys) {
      const sha = await sha256Hex(k.tok);
      db.sqlite
        .prepare(
          `INSERT INTO api_keys (id, name, scope, bound_node_id, key_prefix, key_sha256, allowed_nodes_json, allowed_board_prefixes_json, allow_unsandboxed, max_depth_limit, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 2, ?)`
        )
        .run(
          k.id,
          k.name,
          k.scope,
          k.boundNodeId,
          k.tok.slice(0, 14),
          sha,
          k.allowedNodes,
          k.allowedBoard,
          now
        );
    }

    return { adminTok, nodeTok, clientATok, clientBTok };
  }

  return {
    db,
    env,
    queueMessages,
    callApi,
    openAdminStream,
    seedTokensAndNodes
  };
}

test("migration 0010 preserves existing runs, FKs, and indexes while defaulting Slice 3 columns", () => {
  const sqlite = new DatabaseSync(":memory:");
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const pre0010 = migrationFiles.filter((f) => !f.startsWith("0010_"));
  const m0010 = migrationFiles.find((f) => f.startsWith("0010_"));
  assert.ok(m0010, "0010 migration file must exist");

  for (const file of pre0010) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
  }

  const now = "2026-11-22T12:00:00.000Z";
  sqlite
    .prepare(
      `INSERT INTO nodes (id, display_name, os, arch, version, capabilities_json, workspaces_json, status, max_concurrency, active_runs_count, created_at, updated_at)
       VALUES ('macmini', 'MacMini', 'darwin', 'arm64', '0.2.0', '{}', '[]', 'online', 4, 0, ?, ?)`
    )
    .run(now, now);
  sqlite
    .prepare(
      `INSERT INTO threads (id, title, node_id, workdir, project_key, agent, status, pinned, sort_order, created_at, updated_at)
       VALUES ('thr_01PRE10', 'pre-0010', 'macmini', '/workspace/demo', 'demo', 'codex', 'active', 0, 0, ?, ?)`
    )
    .run(now, now);
  sqlite
    .prepare(
      `INSERT INTO runs (id, thread_id, root_run_id, parent_run_id, depth, max_depth, node_id, workdir, agent, model, effort, sandbox, timeout_sec, prompt, status, priority_order, notify_policy_json, notify_status, created_at, updated_at)
       VALUES ('run_01PRE10A', 'thr_01PRE10', 'run_01PRE10A', NULL, 0, 1, 'macmini', '/workspace/demo', 'codex', '', '', 1, 900, 'hi', 'done', 100, '{"target":"none"}', 'none', ?, ?)`
    )
    .run(now, now);
  sqlite
    .prepare(
      `INSERT INTO runs (id, thread_id, root_run_id, parent_run_id, depth, max_depth, node_id, workdir, agent, model, effort, sandbox, timeout_sec, prompt, status, priority_order, notify_policy_json, notify_status, created_at, updated_at)
       VALUES ('run_01PRE10B', 'thr_01PRE10', 'run_01PRE10A', 'run_01PRE10A', 1, 1, 'macmini', '/workspace/demo', 'codex', '', '', 1, 900, 'child', 'waiting', 200, '{"target":"none"}', 'none', ?, ?)`
    )
    .run(now, now);
  sqlite
    .prepare(
      `INSERT INTO run_dependencies (run_id, depends_on_run_id, created_at) VALUES ('run_01PRE10B', 'run_01PRE10A', ?)`
    )
    .run(now);
  sqlite
    .prepare(
      `INSERT INTO run_events (run_id, seq, kind, payload_json, created_at) VALUES ('run_01PRE10A', 1, 'status', '{}', ?)`
    )
    .run(now);

  sqlite.exec(fs.readFileSync(path.join(migrationsDir, m0010), "utf8"));

  assert.equal(sqlite.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);

  const row = sqlite
    .prepare("SELECT status, labels_json, result_schema_json, result_json FROM runs WHERE id = 'run_01PRE10A'")
    .get();
  assert.equal(row.status, "done");
  assert.equal(row.labels_json, "{}");
  assert.equal(row.result_schema_json, null);
  assert.equal(row.result_json, null);

  const indexes = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runs'")
    .all()
    .map((r) => r.name);
  assert.equal(indexes.filter((n) => n.startsWith("idx_runs_")).length, 7);
  sqlite.close();
});

test("zero-eval json-schema-subset enforces creation bounds, rejects forbidden keywords, and validates edge cases", () => {
  const srcText = fs.readFileSync(
    path.resolve(hereDir, "../src/json-schema-subset.ts"),
    "utf8"
  );
  assert.equal(/\beval\s*\(|\bnew\s+Function\b/.test(srcText), false);

  assert.throws(() => validateResultSchemaDefinition(null), (e) => e.status === 400);
  assert.throws(() => validateResultSchemaDefinition([]), (e) => e.status === 400);
  assert.throws(() => validateResultSchemaDefinition("string"), (e) => e.status === 400);

  // > 16 KB serialized UTF-8 rejected; <= 16 KB accepted
  const bigDesc = "a".repeat(16384);
  assert.throws(
    () => validateResultSchemaDefinition({ type: "object", description: bigDesc }),
    (e) => e.status === 400 && e.code === "BAD_REQUEST"
  );
  const okAtLimit = validateResultSchemaDefinition({
    type: "object",
    description: "a".repeat(16340)
  });
  assert.equal(okAtLimit.type, "object");

  // Depth 16 passes, depth 17 fails
  const buildNested = (depth) => {
    let cur = { type: "string" };
    for (let i = 0; i < depth; i++) {
      cur = { type: "object", properties: { child: cur } };
    }
    return cur;
  };
  assert.doesNotThrow(() => validateResultSchemaDefinition(buildNested(16)));
  assert.throws(
    () => validateResultSchemaDefinition(buildNested(17)),
    (e) => e.status === 400
  );

  // Node count 256 passes, 257 fails
  const buildWide = (propCount) => {
    const properties = {};
    for (let i = 0; i < propCount; i++) {
      properties[`p${i}`] = { type: "integer" };
    }
    return { type: "object", properties };
  };
  assert.doesNotThrow(() => validateResultSchemaDefinition(buildWide(255))); // 1 root + 255 = 256
  assert.throws(
    () => validateResultSchemaDefinition(buildWide(256)), // 1 + 256 = 257
    (e) => e.status === 400
  );

  // Pattern length <= 256 & valid RegExp
  assert.doesNotThrow(() =>
    validateResultSchemaDefinition({ type: "string", pattern: "a".repeat(256) })
  );
  assert.throws(
    () => validateResultSchemaDefinition({ type: "string", pattern: "a".repeat(257) }),
    (e) => e.status === 400
  );
  assert.throws(
    () => validateResultSchemaDefinition({ type: "string", pattern: "[unclosed" }),
    (e) => e.status === 400
  );

  // T5-04: Reject ReDoS / catastrophic backtracking patterns with 400 BAD_REQUEST
  const redosPatterns = [
    "^(a+)+$",
    "^([a-z]+)*$",
    "^(?:a+)+$",
    "^(a|a)+$",
    "^(a|ab)+$",
    "^(\\w|\\d)+$",
    "^(a*)+$",
    "^(a?)+$",
    "^((?:[a-z]+:)+)+$",
    "^(?:[a-z]+_?)+$",
    "^(?:.*foo)+$",
    "^a+a+b$",
    "^.*.*.*!$",
    "^.*a.*b.*$",
    "^([a-z]+-[a-z]+)+$",
    "^(?:[a-z]+-[a-z]*)+$",
    "^([a-z]*-[a-z]*)+$",
    "^(\\d+\\.\\d*)+$",
    "^(a[a-z]+)+$",
    "^(?:[a-z]+a)+$",
    "^([a-z]+a)+$",
    "^(?:[a-z]?/[a-z]+)+$",
    "^(?:[a-z]+/[a-z]?)+$",
    "^(/[a-z]+a[a-z]+)+$",
    "^(/(?:a|ab)[a-z]+)+$",
    "^(?:-[a-z]+|[a-z])+$",
    "^(?:a|[a-z]+-)+$",
    // T5-04c-1: group-wrapped and {1}-wrapped concatenation bypasses
    "^(.*)a(.*)b(.*)$",
    "^(a+)(a+)b$",
    "^([a-z]+)(.*)(.*)(.*)!$",
    "^([a-z]+){12}!$",
    `^${"([a-z]+)".repeat(12)}!$`,
    `^${"([a-z]+){1}".repeat(8)}!$`,
    "^((?:a+){1})([a-z]+)$",
    // T5-04c-2: chained bounded variable quantifiers & nullable-interleaved bypasses
    `^${"[a-z]?".repeat(35)}!$`,
    `^${"[a-z]?".repeat(4)}!$`,
    `^${"[a-z]{0,3}".repeat(20)}!$`,
    `^${"[a-z]{0,3}".repeat(3)}!$`,
    `^${"[a-z]?0?".repeat(4)}!$`,
    "^(?:[a-z]?0?){8}$",
    "^[a-z]{0,16}[a-z]?$",
    "^(?:a+){0,1}(?:a+){0,1}!$",
    `^${"(?:a|aa)".repeat(35)}!$`,
    // T5-04d-1: nested {0,1} variable-quantifier metrics bypasses
    `^${"(?:(?:a?a?a?)?(?:a?a?a?)?(?:a?a?a?)?)?".repeat(3)}!$`,
    "^(?:(?:(?:a?a?)?(?:a?a?)?)?(?:(?:a?a?)?(?:a?a?)?)?)(?:(?:(?:a?a?)?(?:a?a?)?)?(?:(?:a?a?)?(?:a?a?)?)?)$",
    "^(?:a?a?a?a?)?$",
    "^(?:a?a?)?(?:a?a?)?!$",
    "^(?:(?:a|)(?:a|)(?:a|))?(?:(?:a|)(?:a|)(?:a|))?!$",
    "^(?:[a-z]{0,3}[a-z]{0,3})?$",
    // T5-04d-2: {0,1}-wrapped unbounded quantifiers & unanchored 2-unbounded O(n^3)
    "^(?:.*)?a(?:.*)?b(?:.*)?!$",
    "^(.*)a(?:.*)?b(.*)!$",
    "^[a-z]+b(?:[a-z]+)?c[a-z]+!$",
    "(?:.*)?a(?:.*)?b(?:.*)?!",
    "^(?:[a-z]+)?b(?:[a-z]+)?c(?:[a-z]+)?!$",
    "^(?:[a-z]+|0){0,1}b(?:[a-z]+|0){0,1}c(?:[a-z]+|0){0,1}!$",
    ".*a.*!$",
    "[a-z]+a[a-z]+$",
    "^a|.*b.*!$",
    "^.*x(?:.*y.*!)?$"
  ];
  for (const pat of redosPatterns) {
    assert.throws(
      () => validateResultSchemaDefinition({ type: "string", pattern: pat }),
      (e) => e.status === 400 && e.code === "BAD_REQUEST",
      `expected ReDoS rejection for pattern ${pat}`
    );
  }

  // T5-04: Preserve valid practical patterns (including delimited segments, escaped parens, char classes)
  const safePatterns = [
    "^[a-z0-9][a-z0-9._/-]{0,63}$",
    "^[a-z0-9][a-z0-9_-]*(?:/[a-z0-9][a-z0-9_-]*)*$",
    "(?:/[a-z0-9][a-z0-9_-]*)*",
    "^([a-z0-9]+\\.)+[a-z]{2,}$",
    "^[a-z]+-[a-z]+-[a-z]+$",
    "^[0-9]+(\\.[0-9]+)*$",
    "^(?:/[a-z]+(?:-[a-z]+)?)+$",
    "^(?:ok|fail|skip)+$",
    "^(?:v1|v2)+$",
    "^v?\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$",
    "^([a+])+$",
    "^\\(a\\+\\)\\+$",
    "^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$",
    "^\\d?\\d$",
    "^\\d+(?:\\.\\d+)?$",
    "^\\d{1,10}(?:\\.\\d{1,10})?$",
    "^[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}$",
    "^(?:0[a-z]?){10}$",
    "^(.*)a(.*)!$",
    "hello.*world",
    "^\\d{4}-\\d{2}-\\d{2}[Tt]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:[Zz]|[+-]\\d{2}:\\d{2})$",
    "^https?://[A-Za-z0-9.-]+(?::\\d+)?(?:/[^\\s]*)?$",
    "^[a-z]+(?:_[a-z0-9]+)*$",
    "^(?:[a-z0-9]+-)*[a-z0-9]+$"
  ];
  for (const pat of safePatterns) {
    assert.doesNotThrow(
      () => validateResultSchemaDefinition({ type: "string", pattern: pat }),
      `expected safe pattern to be accepted: ${pat}`
    );
  }

  // Forbidden and unknown keywords
  const forbiddenKeywords = [
    ["$ref", "#/$defs/A"],
    ["$defs", { A: { type: "string" } }],
    ["definitions", { A: { type: "string" } }],
    ["$dynamicRef", "#meta"],
    ["$anchor", "root"],
    ["patternProperties", { "^x-": { type: "string" } }],
    ["propertyNames", { pattern: "^[a-z]+$" }],
    ["unevaluatedProperties", false],
    ["unevaluatedItems", false],
    ["if", { properties: { a: { const: 1 } } }],
    ["then", { required: ["b"] }],
    ["else", { required: ["c"] }],
    ["not", { type: "null" }],
    ["contains", { type: "string" }],
    ["prefixItems", [{ type: "string" }]],
    ["dependentRequired", { a: ["b"] }],
    ["dependentSchemas", { a: { required: ["b"] } }],
    ["x_unknown_kw", true]
  ];
  for (const [kw, val] of forbiddenKeywords) {
    assert.throws(
      () => validateResultSchemaDefinition({ type: "object", [kw]: val }),
      (e) => e.status === 400 && e.code === "BAD_REQUEST",
      `expected 400 for forbidden keyword ${kw}`
    );
  }

  // Malformed keyword types / bounds
  assert.throws(() => validateResultSchemaDefinition({ type: [] }), (e) => e.status === 400);
  assert.throws(
    () => validateResultSchemaDefinition({ type: ["string", "string"] }),
    (e) => e.status === 400
  );
  assert.throws(
    () => validateResultSchemaDefinition({ type: "number", multipleOf: 0 }),
    (e) => e.status === 400
  );
  assert.throws(
    () => validateResultSchemaDefinition({ type: "number", multipleOf: -1 }),
    (e) => e.status === 400
  );
  assert.throws(
    () => validateResultSchemaDefinition({ type: "string", format: "ipv4" }),
    (e) => e.status === 400
  );
  assert.throws(
    () => validateResultSchemaDefinition({ type: "object", required: ["a", "a"] }),
    (e) => e.status === 400
  );

  // Runtime validation semantics
  const richSchema = validateResultSchemaDefinition({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["id", "count", "ratio", "tag", "tags", "created_at", "birth", "email", "homepage", "choice"],
    properties: {
      id: { type: "string", format: "uuid" },
      count: { type: "integer", minimum: 1, maximum: 10 },
      ratio: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1, multipleOf: 0.1 },
      tag: { type: "string", minLength: 2, maxLength: 3, pattern: "^[\\p{Emoji}a-z]+$" },
      tags: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        uniqueItems: true,
        items: { type: ["string", "object"] }
      },
      created_at: { type: "string", format: "date-time" },
      birth: { type: "string", format: "date" },
      email: { type: "string", format: "email" },
      homepage: { type: "string", format: "uri" },
      choice: {
        oneOf: [
          { type: "object", required: ["a"], properties: { a: { const: 1 } } },
          { type: "object", required: ["b"], properties: { b: { type: "string" } } }
        ]
      }
    }
  });

  const validValue = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    count: 5,
    ratio: 0.3, // IEEE-754 float trap: 0.3 % 0.1 !== 0 in raw JS
    tag: "😀a", // 2 Unicode code points (3 UTF-16 code units)
    tags: [{ b: 2, a: 1 }, "ok"],
    created_at: "2026-11-22T12:30:00.123Z",
    birth: "2024-02-29", // valid leap year
    email: "dev.team+1@example.co.uk",
    homepage: "https://ahub.bobocai.win/docs",
    choice: { a: 1 }
  };
  assert.equal(validateValueAgainstSchema(richSchema, validValue).valid, true);

  // Float multipleOf failure
  assert.equal(validateValueAgainstSchema(richSchema, { ...validValue, ratio: 0.35 }).valid, false);
  // Integer rejects 5.5
  assert.equal(validateValueAgainstSchema(richSchema, { ...validValue, count: 5.5 }).valid, false);
  // Unicode code-point minLength/maxLength
  assert.equal(validateValueAgainstSchema(richSchema, { ...validValue, tag: "😀" }).valid, false);
  assert.equal(
    validateValueAgainstSchema(richSchema, { ...validValue, tag: "😀😀😀😀" }).valid,
    false
  );
  // uniqueItems deep key-order equality
  assert.equal(
    validateValueAgainstSchema(richSchema, {
      ...validValue,
      tags: [{ a: 1, b: 2 }, { b: 2, a: 1 }]
    }).valid,
    false
  );
  // Invalid calendar date (Feb 30 / non-leap Feb 29)
  assert.equal(
    validateValueAgainstSchema(richSchema, { ...validValue, birth: "2023-02-29" }).valid,
    false
  );
  assert.equal(
    validateValueAgainstSchema(richSchema, { ...validValue, birth: "2024-02-30" }).valid,
    false
  );
  // URI format accepts file:/// and opaque URIs with '://' while rejecting invalid/empty-host authority URIs
  for (const validUri of [
    "file:///tmp/result.json",
    "FILE:///tmp/result.json",
    "urn:foo://bar",
    "mailto:user@example.com?next=http://example.com"
  ]) {
    assert.equal(
      validateValueAgainstSchema(richSchema, { ...validValue, homepage: validUri }).valid,
      true,
      `expected valid URI: ${validUri}`
    );
  }
  for (const invalidUri of [
    "https://",
    "http://",
    "foo://",
    "custom:///path",
    "http://a.com/with space",
    "://missing-scheme",
    "not-a-uri",
    "https://example.com\n"
  ]) {
    assert.equal(
      validateValueAgainstSchema(richSchema, { ...validValue, homepage: invalidUri }).valid,
      false,
      `expected invalid URI: ${invalidUri}`
    );
  }
  // oneOf rejects matching both branches
  assert.equal(
    validateValueAgainstSchema(richSchema, { ...validValue, choice: { a: 1, b: "x" } }).valid,
    false
  );

  // Prototype-key safety (toString / constructor must not satisfy required or properties)
  const protoSchema = validateResultSchemaDefinition({
    type: "object",
    required: ["toString", "constructor"],
    additionalProperties: false,
    properties: {
      ok: { type: "string" }
    }
  });
  const protoProbe = validateValueAgainstSchema(protoSchema, { ok: "yes" });
  assert.equal(protoProbe.valid, false);
  assert.equal(protoProbe.errors.some((e) => e.includes("toString")), true);

  // deepEqualJson iterative check
  assert.equal(deepEqualJson({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }), true);
  assert.equal(deepEqualJson({ a: -0 }, { a: 0 }), true);
  assert.equal(deepEqualJson({ a: 1 }, { a: "1" }), false);
});

test("labels validation, secret redaction, ahub.* reservation, ?label=k=v filtering, and client scope isolation", async () => {
  const h = createTestHarness();
  const { adminTok, clientATok, clientBTok } = await h.seedTokensAndNodes();

  // Reject > 16 labels
  const tooMany = {};
  for (let i = 0; i < 17; i++) tooMany[`k${i}`] = "v";
  const r17 = await h.callApi("POST", "/api/v1/runs", clientATok, {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "test 17 labels",
    labels: tooMany
  });
  assert.equal(r17.status, 400);
  assert.equal(r17.json.error.code, "BAD_REQUEST");
  assertErrorEnvelopeValid(r17.json);

  // Reject ahub.* caller-supplied label on /runs and /plans
  const rAhub = await h.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "test ahub prefix",
    labels: { "ahub.internal": "1" }
  });
  assert.equal(rAhub.status, 400);
  assert.equal(rAhub.json.error.code, "BAD_REQUEST");

  const pAhub = await h.callApi("POST", "/api/v1/plans", adminTok, {
    nodes: [
      {
        key: "step1",
        node_id: "macmini",
        workdir: "demo",
        agent: "codex",
        prompt: "plan ahub label",
        labels: { "ahub.plan": "x" }
      }
    ]
  });
  assert.equal(pAhub.status, 400);
  assert.equal(pAhub.json.error.code, "BAD_REQUEST");

  // Reject control chars & > 128 code points in label value
  const rCtrl = await h.callApi("POST", "/api/v1/runs", clientATok, {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "ctrl char",
    labels: { env: "prod\nline2" }
  });
  assert.equal(rCtrl.status, 400);

  const rLong = await h.callApi("POST", "/api/v1/runs", clientATok, {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "long val",
    labels: { env: "a".repeat(129) }
  });
  assert.equal(rLong.status, 400);

  // Secret inside label value is redacted before persistence
  const createPayload = {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "create labeled run",
    labels: {
      "team.name": "core-infra",
      "expr": "a=b=c",
      "note": "tok=ahub_cli_secret987654"
    }
  };
  assert.equal(validateRunCreate(createPayload), true);
  const createdA = await h.callApi("POST", "/api/v1/runs", clientATok, createPayload);
  assert.equal(createdA.status, 202);
  assertRunRecordValid(createdA.json.run);
  assert.equal(createdA.json.run.labels["team.name"], "core-infra");
  assert.equal(createdA.json.run.labels.expr, "a=b=c");
  assert.equal(createdA.json.run.labels.note, "tok=ahub_cli_[REDACTED]");
  assert.equal(JSON.stringify(createdA.json.run).includes("secret987654"), false);

  // Client B creates another run with different label
  const createdB = await h.callApi("POST", "/api/v1/runs", clientBTok, {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "client B run",
    labels: { "team.name": "core-infra", owner: "b" }
  });
  assert.equal(createdB.status, 202);

  // Query by dotted key & '=' in value with AND semantics
  const listA = await h.callApi(
    "GET",
    "/api/v1/runs?label=team.name%3Dcore-infra&label=expr%3Da%3Db%3Dc",
    clientATok
  );
  assert.equal(listA.status, 200);
  assert.equal(listA.json.runs.length, 1);
  assert.equal(listA.json.runs[0].id, createdA.json.run.id);

  // Client isolation: Client A only sees its own run, NOT Client B's, even when querying shared label
  const listAIsolated = await h.callApi(
    "GET",
    "/api/v1/runs?label=team.name%3Dcore-infra",
    clientATok
  );
  assert.equal(listAIsolated.status, 200);
  assert.equal(listAIsolated.json.runs.length, 1);
  assert.equal(listAIsolated.json.runs[0].id, createdA.json.run.id);

  // Fail-closed client scope if keyId is null
  const nullKeyClientRuns = await listRuns(
    h.env.DB,
    {
      kind: "api_key",
      keyId: null,
      scope: "client",
      boundNodeId: null,
      allowedNodes: ["macmini"],
      allowedBoardPrefixes: [],
      allowUnsandboxed: false,
      maxDepthLimit: 1
    },
    { labels: [{ key: "team.name", value: "core-infra" }], limit: 50 }
  );
  assert.equal(nullKeyClientRuns.length, 0);

  // Allow querying ahub.* labels (seeded by control plane in DB)
  h.db.sqlite
    .prepare(`UPDATE runs SET labels_json = ? WHERE id = ?`)
    .run(JSON.stringify({ "ahub.sys": "v1", "team.name": "core-infra" }), createdB.json.run.id);
  const listAdminAhub = await h.callApi("GET", "/api/v1/runs?label=ahub.sys%3Dv1", adminTok);
  assert.equal(listAdminAhub.status, 200);
  assert.equal(listAdminAhub.json.runs.length, 1);
  assert.equal(listAdminAhub.json.runs[0].id, createdB.json.run.id);
  assertRunRecordValid(listAdminAhub.json.runs[0]);

  // Reject malformed ?label= queries (missing '=', invalid key, > 8 filters)
  assert.equal((await h.callApi("GET", "/api/v1/runs?label=noequals", adminTok)).status, 400);
  assert.equal((await h.callApi("GET", "/api/v1/runs?label=BadKey%3D1", adminTok)).status, 400);
  const nineFilters = Array.from({ length: 9 }, (_, i) => `label=k${i}%3Dv${i}`).join("&");
  assert.equal((await h.callApi("GET", `/api/v1/runs?${nineFilters}`, adminTok)).status, 400);
});

test("/claim, /complete redact-before-size/schema, RESULT_SCHEMA_MISMATCH preservation, Board handoff, notifications, and DAG downstream", async () => {
  const h = createTestHarness();
  const { adminTok, nodeTok } = await h.seedTokensAndNodes();
  const ws = await h.openAdminStream("admin", null);

  // Create Board topic to verify automatic terminal handoff on RESULT_SCHEMA_MISMATCH
  const topicRes = await h.callApi("POST", "/api/v1/board/topics", adminTok, {
    channel: "eng/backend",
    title: "Structured result handoff test"
  });
  assert.equal(topicRes.status, 201);
  const topicId = topicRes.json.topic.id;

  const resultSchema = {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "token_echo"],
    properties: {
      verdict: { type: "string", enum: ["ok", "fail"] },
      token_echo: { type: "string", maxLength: 32 }
    }
  };

  // Create parent run with result_schema and notify enabled + board_topic_id
  const runReq = {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "emit structured json",
    board_topic_id: topicId,
    labels: { stage: "verify" },
    result_schema: resultSchema,
    notify: { target: "webhook", events: ["done", "failed"] }
  };
  assert.equal(validateRunCreate(runReq), true);
  const createRes = await h.callApi("POST", "/api/v1/runs", adminTok, runReq);
  assert.equal(createRes.status, 202);
  const runId = createRes.json.run.id;
  assertRunRecordValid(createRes.json.run);
  assert.deepEqual(createRes.json.run.result_schema, resultSchema);
  assert.equal(createRes.json.run.result, null);

  // Downstream waiting run depending on runId
  const childRes = await h.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "downstream step",
    depends_on: [runId]
  });
  assert.equal(childRes.status, 202);
  assert.equal(childRes.json.run.status, "waiting");
  const childId = childRes.json.run.id;

  // Claim returns labels and result_schema
  const claimRes = await h.callApi("POST", "/api/v1/nodes/macmini/claim", nodeTok, {
    conn_nonce: "nonce_slice3_0001",
    busy_workdirs: []
  });
  assert.equal(claimRes.status, 200);
  assert.equal(claimRes.json.claimed_runs.length, 1);
  const claimed = claimRes.json.claimed_runs[0];
  assert.equal(claimed.id, runId);
  assertRunRecordValid(claimed, "ClaimedRunRecord");
  assert.deepEqual(claimed.labels, { stage: "verify" });
  assert.deepEqual(claimed.result_schema, resultSchema);

  // Case 1: Schema validation failure -> RESULT_SCHEMA_MISMATCH (HTTP 200), output_md/etc. preserved,
  // Board handoff posted, 'failed' notification queued (NOT 'done'), downstream remains waiting (UPSTREAM_FAILED)
  const completeMismatch = await h.callApi("POST", `/api/v1/runs/${runId}/complete`, nodeTok, {
    lease_owner: "macmini:nonce_slice3_0001",
    status: "done",
    native_session_id: "ns_12345",
    resolved_model: "gpt-5.4",
    resolved_effort: "high",
    summary: "Summary preserved",
    output_md: "Full markdown output preserved even on schema mismatch.",
    output_bytes: 55,
    duration_ms: 4321,
    result: { verdict: "invalid_enum", token_echo: "ok" }
  });
  assert.equal(completeMismatch.status, 200);
  const mismatchRun = completeMismatch.json.run;
  assertRunRecordValid(mismatchRun, "MismatchRunRecord");
  assert.equal(mismatchRun.status, "failed");
  assert.equal(mismatchRun.error_code, "RESULT_SCHEMA_MISMATCH");
  assert.equal(mismatchRun.result, null);
  assert.equal(mismatchRun.summary, "Summary preserved");
  assert.equal(mismatchRun.output_bytes, 55);
  assert.equal(mismatchRun.duration_ms, 4321);
  assert.equal(mismatchRun.native_session_id, "ns_12345");
  assert.equal(mismatchRun.resolved_model, "gpt-5.4");
  assert.equal(mismatchRun.resolved_effort, "high");

  const fullMismatch = await h.callApi("GET", `/api/v1/runs/${runId}?view=full`, adminTok);
  assert.equal(fullMismatch.status, 200);
  assertRunRecordValid(fullMismatch.json.run);
  assert.equal(
    fullMismatch.json.run.output_md,
    "Full markdown output preserved even on schema mismatch."
  );

  // Downstream stays waiting with UPSTREAM_FAILED
  const childAfter = await h.callApi("GET", `/api/v1/runs/${childId}`, adminTok);
  assert.equal(childAfter.json.run.status, "waiting");
  assert.equal(childAfter.json.run.blocked_reason, "UPSTREAM_FAILED");

  // Board handoff message includes error_code = RESULT_SCHEMA_MISMATCH
  const msgsRes = await h.callApi("GET", `/api/v1/board/topics/${topicId}/messages`, adminTok);
  assert.equal(msgsRes.status, 200);
  assert.equal(msgsRes.json.messages.length, 1);
  assert.equal(msgsRes.json.messages[0].kind, "handoff");
  assert.equal(msgsRes.json.messages[0].data.error_code, "RESULT_SCHEMA_MISMATCH");

  // Notification delivery was recorded for 'failed', NOT 'done'
  const dlvRow = h.db.sqlite
    .prepare(`SELECT trigger_event FROM notification_deliveries WHERE source_kind = 'run' AND source_id = ?`)
    .get(runId);
  assert.equal(dlvRow?.trigger_event, "failed");

  // Validate all broadcasted WS frames against ws-frames.schema.json
  for (const frame of ws.frames()) {
    assertWsFrameValid(frame, `WS frame ${frame.type}`);
  }

  // Case 2: Redact-before-size-and-schema check!
  // Secret shrinks from >64KB raw to <=64KB redacted, AND secret inside token_echo is redacted before maxLength: 32
  const bigSecretPayload = `sk-${"A".repeat(70000)}`;
  const shrinkSchema = {
    type: "object",
    required: ["verdict", "token_echo"],
    properties: {
      verdict: { type: "string", enum: ["ok"] },
      token_echo: { type: "string", maxLength: 25 }
    }
  };
  const r2 = await h.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "redact before size",
    result_schema: shrinkSchema
  });
  assert.equal(r2.status, 202);
  const c2 = await h.callApi("POST", "/api/v1/nodes/macmini/claim", nodeTok, {
    conn_nonce: "nonce_slice3_0002",
    busy_workdirs: []
  });
  assert.equal(c2.json.claimed_runs[0].id, r2.json.run.id);

  const done2 = await h.callApi("POST", `/api/v1/runs/${r2.json.run.id}/complete`, nodeTok, {
    lease_owner: "macmini:nonce_slice3_0002",
    status: "done",
    summary: "ok",
    output_md: "ok",
    output_bytes: 2,
    duration_ms: 100,
    result: {
      verdict: "ok",
      token_echo: bigSecretPayload // > 64KB raw, becomes "[REDACTED]" (10 chars <= 25 & <= 64KB)
    }
  });
  assert.equal(done2.status, 200);
  assert.equal(done2.json.run.status, "done");
  assert.deepEqual(done2.json.run.result, { verdict: "ok", token_echo: "[REDACTED]" });
  assert.equal(JSON.stringify(done2.json.run).includes("sk-AAA"), false);
  assertRunRecordValid(done2.json.run);

  // Case 2b: Secret expanding on redaction ("token": "ab" -> "[REDACTED]") fails maxLength schema check
  const expandSchema = {
    type: "object",
    required: ["token"],
    properties: {
      token: { type: "string", maxLength: 5 }
    }
  };
  const r2b = await h.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "redact expand before schema",
    result_schema: expandSchema
  });
  await h.callApi("POST", "/api/v1/nodes/macmini/claim", nodeTok, {
    conn_nonce: "nonce_slice3_0002b",
    busy_workdirs: []
  });
  const done2b = await h.callApi("POST", `/api/v1/runs/${r2b.json.run.id}/complete`, nodeTok, {
    lease_owner: "macmini:nonce_slice3_0002b",
    status: "done",
    summary: "expand",
    output_md: "expand md",
    output_bytes: 9,
    duration_ms: 40,
    result: { token: "ab" }
  });
  assert.equal(done2b.status, 200);
  assert.equal(done2b.json.run.status, "failed");
  assert.equal(done2b.json.run.error_code, "RESULT_SCHEMA_MISMATCH");
  assert.equal(done2b.json.run.result, null);

  // Case 3: Missing result, result_error (with secret), and oversized redacted result all settle as RESULT_SCHEMA_MISMATCH
  for (const [label, bodyExtras] of [
    ["missing-result", {}],
    ["explicit-null", { result: null }],
    ["result-error", { result_error: "failed reading ahub_cli_leaksecret123" }],
    ["oversize-after-redact", { result: { verdict: "ok", token_echo: "a", extra: "x".repeat(66000) } }]
  ]) {
    const rCase = await h.callApi("POST", "/api/v1/runs", adminTok, {
      node_id: "macmini",
      workdir: "demo",
      agent: "codex",
      prompt: label,
      result_schema: resultSchema
    });
    await h.callApi("POST", "/api/v1/nodes/macmini/claim", nodeTok, {
      conn_nonce: `nonce_${label}`,
      busy_workdirs: []
    });
    const comp = await h.callApi("POST", `/api/v1/runs/${rCase.json.run.id}/complete`, nodeTok, {
      lease_owner: `macmini:nonce_${label}`,
      status: "done",
      summary: "preserved",
      output_md: "preserved md",
      output_bytes: 12,
      duration_ms: 50,
      ...bodyExtras
    });
    assert.equal(comp.status, 200, `${label} must settle HTTP 200`);
    assert.equal(comp.json.run.status, "failed", `${label} must settle failed`);
    assert.equal(comp.json.run.error_code, "RESULT_SCHEMA_MISMATCH", `${label} error_code`);
    assert.equal(comp.json.run.result, null, `${label} result must be null`);
    assert.equal(JSON.stringify(comp.json.run).includes("leaksecret123"), false);
  }

  // Case 4: Schemaless run never gets RESULT_SCHEMA_MISMATCH; preserves falsy JSON primitives and ignores >64KB/error
  const schemalessFalsy = await h.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "schemaless falsy"
  });
  await h.callApi("POST", "/api/v1/nodes/macmini/claim", nodeTok, {
    conn_nonce: "nonce_falsy",
    busy_workdirs: []
  });
  const falsyDone = await h.callApi(
    "POST",
    `/api/v1/runs/${schemalessFalsy.json.run.id}/complete`,
    nodeTok,
    {
      lease_owner: "macmini:nonce_falsy",
      status: "done",
      summary: "ok",
      output_md: "ok",
      output_bytes: 2,
      duration_ms: 10,
      result: false
    }
  );
  assert.equal(falsyDone.status, 200);
  assert.equal(falsyDone.json.run.status, "done");
  assert.equal(falsyDone.json.run.result, false);
  assertRunRecordValid(falsyDone.json.run);

  const schemalessOver = await h.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "schemaless oversize"
  });
  await h.callApi("POST", "/api/v1/nodes/macmini/claim", nodeTok, {
    conn_nonce: "nonce_schemaless_over",
    busy_workdirs: []
  });
  const overDone = await h.callApi(
    "POST",
    `/api/v1/runs/${schemalessOver.json.run.id}/complete`,
    nodeTok,
    {
      lease_owner: "macmini:nonce_schemaless_over",
      status: "done",
      summary: "ok",
      output_md: "ok",
      output_bytes: 2,
      duration_ms: 10,
      result: { big: "z".repeat(66000) }
    }
  );
  assert.equal(overDone.status, 200);
  assert.equal(overDone.json.run.status, "done");
  assert.equal(overDone.json.run.error_code, "");
  assert.equal(overDone.json.run.result, null);

  // Case 5: Non-done run with result_schema never overwritten to RESULT_SCHEMA_MISMATCH
  const failedRun = await h.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "non-done run",
    result_schema: resultSchema
  });
  await h.callApi("POST", "/api/v1/nodes/macmini/claim", nodeTok, {
    conn_nonce: "nonce_nondone",
    busy_workdirs: []
  });
  const failedDone = await h.callApi(
    "POST",
    `/api/v1/runs/${failedRun.json.run.id}/complete`,
    nodeTok,
    {
      lease_owner: "macmini:nonce_nondone",
      status: "failed",
      summary: "process crashed",
      output_md: "err",
      output_bytes: 3,
      duration_ms: 10,
      error_code: "RUNNER_EXIT_NONZERO",
      error_message: "exit 1",
      result: { verdict: "ok", token_echo: "ignored" }
    }
  );
  assert.equal(failedDone.status, 200);
  assert.equal(failedDone.json.run.status, "failed");
  assert.equal(failedDone.json.run.error_code, "RUNNER_EXIT_NONZERO");
  assert.equal(failedDone.json.run.result, null);

  // Case 6: Concurrent cancel before complete returns 409 and preserves cancelled run
  const raceRun = await h.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "cancel race",
    result_schema: resultSchema
  });
  await h.callApi("POST", "/api/v1/nodes/macmini/claim", nodeTok, {
    conn_nonce: "nonce_race",
    busy_workdirs: []
  });
  await h.callApi("POST", `/api/v1/runs/${raceRun.json.run.id}/cancel`, adminTok, {
    reason: "user cancel"
  });
  const lateComplete = await h.callApi(
    "POST",
    `/api/v1/runs/${raceRun.json.run.id}/complete`,
    nodeTok,
    {
      lease_owner: "macmini:nonce_race",
      status: "done",
      summary: "late",
      output_md: "late",
      output_bytes: 4,
      duration_ms: 10,
      result: { verdict: "ok", token_echo: "1" }
    }
  );
  assert.equal(lateComplete.status, 409);
  assert.equal(lateComplete.json.error.code, "INVALID_STATE_TRANSITION");
});

test("Idempotency-Key for /runs and /plans includes labels & result_schema, and /retry inherits them", async () => {
  const h = createTestHarness();
  const { adminTok, nodeTok } = await h.seedTokensAndNodes();

  const schemaA = {
    type: "object",
    required: ["ok", "score"],
    properties: {
      ok: { type: "boolean" },
      score: { type: "integer", minimum: 0 }
    }
  };
  const schemaAReordered = {
    properties: {
      score: { minimum: 0, type: "integer" },
      ok: { type: "boolean" }
    },
    required: ["ok", "score"],
    type: "object"
  };

  // Single run idempotency: same payload with reordered keys deduplicates; diff labels/schema -> 409
  const runIdemKey = "idem_slice3_run_0001";
  const r1 = await h.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "idem run",
    idempotency_key: runIdemKey,
    labels: { a: "1", b: "2" },
    result_schema: schemaA
  });
  assert.equal(r1.status, 202);

  const r1Replay = await h.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "idem run",
    idempotency_key: runIdemKey,
    labels: { b: "2", a: "1" },
    result_schema: schemaAReordered
  });
  assert.equal(r1Replay.status, 202);
  assert.equal(r1Replay.json.run.id, r1.json.run.id);

  const r1DiffLabel = await h.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "idem run",
    idempotency_key: runIdemKey,
    labels: { a: "1", b: "changed" },
    result_schema: schemaA
  });
  assert.equal(r1DiffLabel.status, 409);
  assert.equal(r1DiffLabel.json.error.code, "IDEMPOTENCY_CONFLICT");

  const r1DiffSchema = await h.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    prompt: "idem run",
    idempotency_key: runIdemKey,
    labels: { a: "1", b: "2" },
    result_schema: { type: "object" }
  });
  assert.equal(r1DiffSchema.status, 409);
  assert.equal(r1DiffSchema.json.error.code, "IDEMPOTENCY_CONFLICT");

  // Plan idempotency with labels & result_schema
  const planIdemKey = "idem_slice3_plan_0001";
  const planPayload = {
    idempotency_key: planIdemKey,
    nodes: [
      {
        key: "build",
        node_id: "macmini",
        workdir: "demo",
        agent: "codex",
        prompt: "build step",
        labels: { phase: "build", tier: "p0" },
        result_schema: schemaA
      }
    ]
  };
  assert.equal(validatePlanCreate(planPayload), true);
  const p1 = await h.callApi("POST", "/api/v1/plans", adminTok, planPayload);
  assert.equal(p1.status, 201);
  assertRunRecordValid(p1.json.runs[0]);

  const p1Replay = await h.callApi("POST", "/api/v1/plans", adminTok, {
    idempotency_key: planIdemKey,
    nodes: [
      {
        key: "build",
        node_id: "macmini",
        workdir: "demo",
        agent: "codex",
        prompt: "build step",
        labels: { tier: "p0", phase: "build" },
        result_schema: schemaAReordered
      }
    ]
  });
  assert.equal(p1Replay.status, 200);
  assert.equal(p1Replay.json.deduplicated, true);

  const p1Conflict = await h.callApi("POST", "/api/v1/plans", adminTok, {
    idempotency_key: planIdemKey,
    nodes: [
      {
        key: "build",
        node_id: "macmini",
        workdir: "demo",
        agent: "codex",
        prompt: "build step",
        labels: { phase: "build", tier: "p1" },
        result_schema: schemaA
      }
    ]
  });
  assert.equal(p1Conflict.status, 409);
  assert.equal(p1Conflict.json.error.code, "IDEMPOTENCY_CONFLICT");

  // Complete r1 with mismatch, then /retry inherits labels & result_schema and resets result = null
  await h.callApi("POST", "/api/v1/nodes/macmini/claim", nodeTok, {
    conn_nonce: "nonce_retry_1",
    busy_workdirs: []
  });
  // Fail r1 via RESULT_SCHEMA_MISMATCH
  const failR1 = await h.callApi("POST", `/api/v1/runs/${r1.json.run.id}/complete`, nodeTok, {
    lease_owner: "macmini:nonce_retry_1",
    status: "done",
    summary: "bad result",
    output_md: "output",
    output_bytes: 6,
    duration_ms: 20,
    result: { ok: "not-bool" }
  });
  assert.equal(failR1.status, 200);
  assert.equal(failR1.json.run.status, "failed");
  assert.equal(failR1.json.run.error_code, "RESULT_SCHEMA_MISMATCH");

  const retried = await h.callApi("POST", `/api/v1/runs/${r1.json.run.id}/retry`, adminTok, {});
  assert.equal(retried.status, 201);
  assertRunRecordValid(retried.json.run);
  assert.equal(retried.json.run.retry_of_run_id, r1.json.run.id);
  assert.deepEqual(retried.json.run.labels, { a: "1", b: "2" });
  assert.deepEqual(retried.json.run.result_schema, schemaA);
  assert.equal(retried.json.run.result, null);
});
