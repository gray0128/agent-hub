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
const boardSchema = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "docs/schemas/board.schema.json"), "utf8")
);
const validateErrorEnvelope = ajv.compile({
  $schema: boardSchema.$schema,
  $defs: boardSchema.$defs,
  $ref: "#/$defs/ErrorEnvelope"
});

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

function createTestHarness() {
  const db = createSqliteD1();
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
    WEBHOOK_ENCRYPTION_KEY: "test-encryption-secret-for-runs-error-next",
    NOTIFY_QUEUE: {
      async send() {}
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

  async function callApi(method, reqPath, token, body) {
    const resp = await worker.fetch(
      new Request(`https://ahub.bobocai.win${reqPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {})
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      }),
      env,
      execCtx
    );
    while (pendingWaitUntil.length > 0) {
      const batch = pendingWaitUntil.splice(0, pendingWaitUntil.length);
      await Promise.all(batch);
    }
    const json = await resp.json();
    return { status: resp.status, json };
  }

  return { db, callApi };
}

async function seedAdminAndNode(harness) {
  const now = "2026-11-22T00:00:00.000Z";
  const adminTok = "ahub_adm_error_next_test";
  await harness.db
    .prepare(
      `INSERT INTO api_keys (
         id, name, scope, bound_node_id, key_prefix, key_sha256,
         allowed_nodes_json, allowed_board_prefixes_json,
         allow_unsandboxed, max_depth_limit, notify_webhook_ciphertext, notify_webhook_host, created_at
       ) VALUES (?1, ?2, 'admin', NULL, 'ahub_adm_err', ?3, '[]', '["*"]', 1, 3, '', '', ?4)`
    )
    .bind("key_adm_err", "admin", await sha256Hex(adminTok), now)
    .run();

  const workspaces = JSON.stringify([
    { key: "github/demo", path: "/workspace/github/demo" },
    { key: "cnb/demo", path: "/workspace/cnb/demo" },
    { key: "dupkey", path: "/workspace/dup-a" },
    { key: "dupkey", path: "/workspace/dup-b" }
  ]);
  await harness.db
    .prepare(
      `INSERT INTO nodes (id, display_name, os, arch, version, capabilities_json, workspaces_json, status, max_concurrency, active_runs_count, last_seen_at, created_at, updated_at)
       VALUES ('macmini', 'macmini', 'darwin', 'arm64', '0.1.8', '{}', ?1, 'online', 2, 0, ?2, ?2, ?2)`
    )
    .bind(workspaces, now)
    .run();

  return { adminTok };
}

test("POST /api/v1/runs error envelopes include safe error.next hints", async () => {
  const harness = createTestHarness();
  const { adminTok } = await seedAdminAndNode(harness);

  // Key match ambiguity -> WORKDIR_AMBIGUOUS
  const keyAmb = await harness.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "dupkey",
    agent: "agy",
    prompt: "Inspect repo"
  });
  assert.equal(keyAmb.status, 400);
  assert.equal(keyAmb.json.error.code, "WORKDIR_AMBIGUOUS");
  assert.deepEqual(keyAmb.json.error.details.candidates, ["/workspace/dup-a", "/workspace/dup-b"]);
  assert.deepEqual(keyAmb.json.error.next, ["ahub nodes --online --json"]);
  assert.equal(validateErrorEnvelope(keyAmb.json), true, ajv.errorsText(validateErrorEnvelope.errors));

  // Suffix/basename match ambiguity -> WORKDIR_AMBIGUOUS
  const suffixAmb = await harness.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "demo",
    agent: "agy",
    prompt: "Inspect repo"
  });
  assert.equal(suffixAmb.status, 400);
  assert.equal(suffixAmb.json.error.code, "WORKDIR_AMBIGUOUS");
  assert.deepEqual(suffixAmb.json.error.details.candidates, [
    "/workspace/github/demo",
    "/workspace/cnb/demo"
  ]);
  assert.deepEqual(suffixAmb.json.error.next, ["ahub nodes --online --json"]);
  assert.equal(
    validateErrorEnvelope(suffixAmb.json),
    true,
    ajv.errorsText(validateErrorEnvelope.errors)
  );

  // Unknown workdir -> WORKDIR_NOT_FOUND
  const missingWorkdir = await harness.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "nonexistent-project",
    agent: "agy",
    prompt: "Inspect repo"
  });
  assert.equal(missingWorkdir.status, 400);
  assert.equal(missingWorkdir.json.error.code, "WORKDIR_NOT_FOUND");
  assert.deepEqual(missingWorkdir.json.error.next, ["ahub nodes --json"]);
  assert.equal(
    validateErrorEnvelope(missingWorkdir.json),
    true,
    ajv.errorsText(validateErrorEnvelope.errors)
  );

  // Unknown node -> NODE_NOT_FOUND
  const missingNode = await harness.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "missing-node",
    workdir: "github/demo",
    agent: "agy",
    prompt: "Inspect repo"
  });
  assert.equal(missingNode.status, 404);
  assert.equal(missingNode.json.error.code, "NODE_NOT_FOUND");
  assert.deepEqual(missingNode.json.error.next, ["ahub nodes --json"]);
  assert.equal(
    validateErrorEnvelope(missingNode.json),
    true,
    ajv.errorsText(validateErrorEnvelope.errors)
  );
});

test("PATCH /api/v1/nodes/:id and PATCH /api/v1/runs/:id NODE_NOT_FOUND include error.next", async () => {
  const harness = createTestHarness();
  const { adminTok } = await seedAdminAndNode(harness);

  const patchNodeRes = await harness.callApi("PATCH", "/api/v1/nodes/unknown-node", adminTok, {
    display_name: "New Name"
  });
  assert.equal(patchNodeRes.status, 404);
  assert.equal(patchNodeRes.json.error.code, "NODE_NOT_FOUND");
  assert.deepEqual(patchNodeRes.json.error.next, ["ahub nodes --json"]);
  assert.equal(
    validateErrorEnvelope(patchNodeRes.json),
    true,
    ajv.errorsText(validateErrorEnvelope.errors)
  );

  const createRes = await harness.callApi("POST", "/api/v1/runs", adminTok, {
    node_id: "macmini",
    workdir: "github/demo",
    agent: "agy",
    prompt: "Run queued task"
  });
  assert.equal(createRes.status, 202);

  const patchRunRes = await harness.callApi(
    "PATCH",
    `/api/v1/runs/${createRes.json.run.id}`,
    adminTok,
    { node_id: "unknown-node" }
  );
  assert.equal(patchRunRes.status, 404);
  assert.equal(patchRunRes.json.error.code, "NODE_NOT_FOUND");
  assert.deepEqual(patchRunRes.json.error.next, ["ahub nodes --json"]);
  assert.equal(
    validateErrorEnvelope(patchRunRes.json),
    true,
    ajv.errorsText(validateErrorEnvelope.errors)
  );
});
