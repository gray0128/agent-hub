import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

const { createNativeEvent, enqueueRunNotificationIfNeeded, listNodes, patchNode } = await import("./db.ts");

function createControlPlaneMockDb({ nodes = [], keys = [] } = {}) {
  const nodeMap = new Map(
    nodes.map((n) => [
      n.id,
      {
        display_name: n.id,
        os: "darwin",
        arch: "arm64",
        version: "0.1.5",
        capabilities_json: "{}",
        workspaces_json: "[]",
        status: "online",
        max_concurrency: 4,
        active_runs_count: 0,
        default_notify_key_id: null,
        last_seen_at: null,
        created_at: "2026-11-17T00:00:00.000Z",
        updated_at: "2026-11-17T00:00:00.000Z",
        ...n
      }
    ])
  );
  const keyMap = new Map(
    keys.map((k) => [
      k.id,
      {
        scope: "client",
        allowed_nodes_json: "[]",
        notify_webhook_ciphertext: "",
        notify_webhook_host: "",
        revoked_at: null,
        ...k
      }
    ])
  );
  const nativeEvents = new Map();
  const runs = new Map();

  function attachJoinedNode(n) {
    const k = n.default_notify_key_id ? keyMap.get(n.default_notify_key_id) ?? null : null;
    return {
      ...n,
      notify_key_name: k ? k.name ?? "" : null,
      notify_key_scope: k ? k.scope : null,
      notify_key_revoked_at: k ? k.revoked_at : null,
      notify_key_webhook_host: k ? k.notify_webhook_host ?? "" : null,
      notify_key_has_webhook: k && k.notify_webhook_ciphertext ? 1 : 0,
      notify_key_allowed_nodes_json: k ? k.allowed_nodes_json ?? "[]" : null
    };
  }

  return {
    nodeMap,
    keyMap,
    nativeEvents,
    runs,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...params) {
          args = params;
          return stmt;
        },
        async first() {
          if (sql.includes("FROM nodes n") && sql.includes("WHERE n.id = ?1")) {
            const n = nodeMap.get(args[0]);
            return n ? attachJoinedNode(n) : null;
          }
          if (sql.includes("FROM nodes WHERE id = ?1")) {
            return nodeMap.get(args[0]) ?? null;
          }
          if (sql.includes("FROM api_keys WHERE id = ?1")) {
            return keyMap.get(args[0]) ?? null;
          }
          if (sql.includes("FROM native_events WHERE node_id = ?1 AND event_id = ?2")) {
            for (const ev of nativeEvents.values()) {
              if (ev.node_id === args[0] && ev.event_id === args[1]) return ev;
            }
            return null;
          }
          if (sql.includes("FROM native_events WHERE id = ?1")) {
            return nativeEvents.get(args[0]) ?? null;
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM nodes n")) {
            return { results: Array.from(nodeMap.values()).map(attachJoinedNode) };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes("UPDATE nodes") && sql.includes("default_notify_key_id = ?4")) {
            const n = nodeMap.get(args[5]);
            if (n) {
              n.display_name = args[0];
              n.status = args[1];
              n.max_concurrency = args[2];
              n.default_notify_key_id = args[3];
              n.updated_at = args[4];
            }
            return { success: true, meta: { changes: n ? 1 : 0 } };
          }
          if (sql.includes("INSERT OR IGNORE INTO native_events")) {
            for (const existing of nativeEvents.values()) {
              if (existing.node_id === args[1] && existing.event_id === args[2]) {
                return { success: true, meta: { changes: 0 } };
              }
            }
            const row = {
              id: args[0],
              node_id: args[1],
              event_id: args[2],
              agent: args[3],
              event_kind: args[4],
              native_session_id: args[5],
              workdir: args[6],
              title: args[7],
              summary: args[8],
              source: args[9],
              notify_key_id: args[10],
              notify_status: args[11],
              notify_error: args[12],
              created_at: args[13],
              updated_at: args[13]
            };
            nativeEvents.set(row.id, row);
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE runs SET notify_status =")) {
            const status = sql.includes("'queued'") ? "queued" : "failed";
            runs.set(args[1], { id: args[1], notify_status: status });
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 1 } };
        }
      };
      return stmt;
    }
  };
}

test("patchNode validates node-bound default Bot channel and supports clean unbinding", async () => {
  const db = createControlPlaneMockDb({
    nodes: [{ id: "macmini" }, { id: "mbp" }],
    keys: [
      {
        id: "key_valid_macmini",
        name: "bot-macmini",
        scope: "client",
        allowed_nodes_json: '["macmini"]',
        notify_webhook_ciphertext: "v1:iv:ct",
        notify_webhook_host: "hooks.x.ai"
      },
      {
        id: "key_no_webhook",
        name: "bot-no-hook",
        scope: "client",
        notify_webhook_ciphertext: ""
      },
      {
        id: "key_revoked",
        name: "bot-revoked",
        scope: "client",
        notify_webhook_ciphertext: "v1:iv:ct",
        revoked_at: "2026-11-16T00:00:00.000Z"
      }
    ]
  });

  await assert.rejects(() => patchNode(db, "mbp", { defaultNotifyKeyId: "key_valid_macmini" }), /does not allow node/);
  await assert.rejects(() => patchNode(db, "macmini", { defaultNotifyKeyId: "key_no_webhook" }), /no configured Bot Webhook/);
  await assert.rejects(() => patchNode(db, "macmini", { defaultNotifyKeyId: "key_revoked" }), /revoked/);

  const bound = await patchNode(db, "macmini", { defaultNotifyKeyId: "key_valid_macmini" });
  assert.equal(bound.default_notify_key_id, "key_valid_macmini");
  assert.equal(bound.default_notify_key_name, "bot-macmini");
  assert.equal(bound.default_notify_webhook_host, "hooks.x.ai");
  assert.equal(bound.default_notify_valid, true);

  const unbound = await patchNode(db, "macmini", { defaultNotifyKeyId: null });
  assert.equal(unbound.default_notify_key_id, null);
  assert.equal(unbound.default_notify_valid, undefined);
});

test("createNativeEvent deduplicates by (node_id, event_id), redacts secrets, skips unbound, and fails closed when revoked", async () => {
  const queued = [];
  const env = {
    GROK_WEBHOOK_URL: "https://global.example.com/must-not-be-used",
    NOTIFY_QUEUE: {
      async send(msg) {
        queued.push(msg);
      }
    }
  };
  const db = createControlPlaneMockDb({
    nodes: [
      { id: "macmini", default_notify_key_id: "key_bot_1" },
      { id: "mbp", default_notify_key_id: null }
    ],
    keys: [
      {
        id: "key_bot_1",
        name: "bot-1",
        scope: "client",
        allowed_nodes_json: '["macmini"]',
        notify_webhook_ciphertext: "v1:iv:ct",
        notify_webhook_host: "hooks.x.ai"
      }
    ]
  });

  // 1. Valid bound node -> queues once, redacts summary, second call deduplicates
  const first = await createNativeEvent(db, env, "macmini", {
    eventId: "claude:sess_1:Notification:abcdef",
    agent: "claude",
    eventKind: "interaction_needed",
    nativeSessionId: "sess_1",
    workdir: "/workspace/demo",
    title: "Need confirmation token=raw_title_secret",
    summary: "Approve command using ahub_cli_rawtoken12345",
    source: "claude-hook"
  });
  assert.equal(first.deduplicated, false);
  assert.equal(first.event.notify_status, "queued");
  assert.equal(first.event.title.includes("raw_title_secret"), false);
  assert.equal(first.event.summary.includes("rawtoken12345"), false);
  assert.equal(first.event.summary.includes("ahub_cli_[REDACTED]"), true);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, "native_event");

  const dup = await createNativeEvent(db, env, "macmini", {
    eventId: "claude:sess_1:Notification:abcdef",
    agent: "claude",
    eventKind: "interaction_needed",
    nativeSessionId: "sess_1",
    workdir: "/workspace/demo",
    title: "Need confirmation",
    summary: "Duplicate payload",
    source: "claude-hook"
  });
  assert.equal(dup.deduplicated, true);
  assert.equal(dup.event.id, first.event.id);
  assert.equal(queued.length, 1);

  // 2. Unbound node -> skipped without global fallback
  const unbound = await createNativeEvent(db, env, "mbp", {
    eventId: "codex:t1:turn1:turn_summary",
    agent: "codex",
    eventKind: "turn_summary",
    nativeSessionId: "t1",
    workdir: "/workspace/app",
    title: "",
    summary: "Done",
    source: "codex-notify"
  });
  assert.equal(unbound.event.notify_status, "skipped");
  assert.equal(unbound.event.notify_error, "NODE_DEFAULT_CHANNEL_UNBOUND");
  assert.equal(queued.length, 1);

  // 3. Revoked bound key -> fails closed without enqueueing or global fallback
  db.keyMap.get("key_bot_1").revoked_at = "2026-11-17T10:00:00.000Z";
  const revoked = await createNativeEvent(db, env, "macmini", {
    eventId: "claude:sess_1:Stop:fedcba987654",
    agent: "claude",
    eventKind: "turn_summary",
    nativeSessionId: "sess_1",
    workdir: "/workspace/demo",
    title: "",
    summary: "Finished",
    source: "claude-hook"
  });
  assert.equal(revoked.event.notify_status, "failed");
  assert.equal(revoked.event.notify_error, "DEFAULT_CHANNEL_INVALID_OR_REVOKED");
  assert.equal(queued.length, 1);
});

test("enqueueRunNotificationIfNeeded routes Web/CLI root runs via node default channel, skips depth>0 and unbound nodes, and avoids double-push", async () => {
  const queued = [];
  const env = {
    GROK_WEBHOOK_URL: "https://global.example.com/must-not-bypass",
    NOTIFY_QUEUE: {
      async send(msg) {
        queued.push(msg);
      }
    }
  };
  const db = createControlPlaneMockDb({
    nodes: [
      { id: "macmini", default_notify_key_id: "key_bot_1" },
      { id: "mbp", default_notify_key_id: null }
    ],
    keys: [
      {
        id: "key_bot_1",
        name: "bot-1",
        scope: "client",
        notify_webhook_ciphertext: "v1:iv:ct",
        notify_webhook_host: "hooks.x.ai"
      },
      {
        id: "key_bot_2",
        name: "bot-2",
        scope: "client",
        notify_webhook_ciphertext: "v1:iv:ct",
        notify_webhook_host: "hooks.x.ai"
      },
      {
        id: "key_admin_1",
        name: "ops-admin",
        scope: "admin",
        notify_webhook_ciphertext: ""
      }
    ]
  });

  const baseRun = {
    id: "run_web_1",
    thread_id: "thr_1",
    root_run_id: "run_web_1",
    parent_run_id: null,
    depth: 0,
    node_id: "macmini",
    workdir: "/workspace/demo",
    agent: "agy",
    status: "done",
    created_by_key_id: null,
    notify_policy_json: JSON.stringify({ target: "none" })
  };

  // Root Web run with target="none" -> uses node_default
  const sentRoot = await enqueueRunNotificationIfNeeded(db, env, baseRun, "done");
  assert.equal(sentRoot, true);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].route_mode, "node_default");
  assert.equal(queued[0].target, "grok");

  // Client key run with target="none" -> MUST NOT leak to node_default
  const sentClientNoNotify = await enqueueRunNotificationIfNeeded(
    db,
    env,
    { ...baseRun, id: "run_client_silent_1", created_by_key_id: "key_bot_2" },
    "done"
  );
  assert.equal(sentClientNoNotify, false);
  assert.equal(queued.length, 1);

  // Admin key run with target="none" on bound node -> uses node_default
  const sentAdminNoNotify = await enqueueRunNotificationIfNeeded(
    db,
    env,
    { ...baseRun, id: "run_admin_default_1", created_by_key_id: "key_admin_1" },
    "done"
  );
  assert.equal(sentAdminNoNotify, true);
  assert.equal(queued.length, 2);
  assert.equal(queued[1].route_mode, "node_default");
  assert.equal(queued[1].target, "grok");

  // Admin key run with explicit target="grok" -> node_default when bound, global_legacy when unbound
  const sentAdminBoundExplicit = await enqueueRunNotificationIfNeeded(
    db,
    env,
    {
      ...baseRun,
      id: "run_admin_explicit_bound",
      created_by_key_id: "key_admin_1",
      notify_policy_json: JSON.stringify({ target: "grok" })
    },
    "done"
  );
  assert.equal(sentAdminBoundExplicit, true);
  assert.equal(queued.length, 3);
  assert.equal(queued[2].route_mode, "node_default");

  const sentAdminUnboundExplicit = await enqueueRunNotificationIfNeeded(
    db,
    env,
    {
      ...baseRun,
      id: "run_admin_explicit_unbound",
      node_id: "mbp",
      created_by_key_id: "key_admin_1",
      notify_policy_json: JSON.stringify({ target: "grok" })
    },
    "done"
  );
  assert.equal(sentAdminUnboundExplicit, true);
  assert.equal(queued.length, 4);
  assert.equal(queued[3].route_mode, "global_legacy");

  // Child run (depth=1) with target="none" -> skipped (no child notification storm)
  const sentChild = await enqueueRunNotificationIfNeeded(
    db,
    env,
    { ...baseRun, id: "run_child_1", depth: 1 },
    "done"
  );
  assert.equal(sentChild, false);
  assert.equal(queued.length, 4);

  // Unbound node with target="none" -> skipped
  const sentUnbound = await enqueueRunNotificationIfNeeded(
    db,
    env,
    { ...baseRun, id: "run_unbound_1", node_id: "mbp" },
    "done"
  );
  assert.equal(sentUnbound, false);
  assert.equal(queued.length, 4);

  // Grok Bot key run with explicit --notify grok -> routes by key only (no node_default double push)
  const sentBot = await enqueueRunNotificationIfNeeded(
    db,
    env,
    {
      ...baseRun,
      id: "run_bot_1",
      created_by_key_id: "key_bot_2",
      notify_policy_json: JSON.stringify({ target: "grok" })
    },
    "done"
  );
  assert.equal(sentBot, true);
  assert.equal(queued.length, 5);
  assert.equal(queued[4].route_mode, "key");
});

test("listNodes exposes default_notify metadata only for admin principals", async () => {
  const db = createControlPlaneMockDb({
    nodes: [
      { id: "macmini", default_notify_key_id: "key_bot_1" },
      { id: "mbp", default_notify_key_id: null }
    ],
    keys: [
      {
        id: "key_bot_1",
        name: "bot-1",
        scope: "client",
        notify_webhook_ciphertext: "v1:iv:ct",
        notify_webhook_host: "hooks.x.ai"
      }
    ]
  });

  const adminNodes = await listNodes(db, {
    kind: "api_key",
    scope: "admin",
    keyId: "key_admin_1",
    boundNodeId: null,
    allowedNodes: [],
    allowUnsandboxed: true,
    maxDepthLimit: 2
  });
  const macAdmin = adminNodes.find((n) => n.id === "macmini");
  assert.equal(macAdmin.default_notify_key_id, "key_bot_1");
  assert.equal(macAdmin.default_notify_key_name, "bot-1");
  assert.equal(macAdmin.default_notify_webhook_host, "hooks.x.ai");
  assert.equal(macAdmin.default_notify_valid, true);

  const clientNodes = await listNodes(db, {
    kind: "api_key",
    scope: "client",
    keyId: "key_bot_1",
    boundNodeId: null,
    allowedNodes: [],
    allowUnsandboxed: false,
    maxDepthLimit: 1
  });
  const macClient = clientNodes.find((n) => n.id === "macmini");
  assert.equal(macClient.default_notify_key_id, undefined);
  assert.equal(macClient.default_notify_key_name, undefined);
  assert.equal(macClient.default_notify_webhook_host, undefined);
  assert.equal(macClient.default_notify_valid, undefined);
});
