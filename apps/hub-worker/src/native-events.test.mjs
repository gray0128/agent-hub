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

const {
  computeAggregateNotifyStatus,
  computeAttentionState,
  createNativeEvent,
  enqueueRunNotificationIfNeeded,
  getRunById,
  listNodes,
  listRuns,
  patchNode
} = await import("./db.ts");

function createControlPlaneMockDb({
  nodes = [],
  keys = [],
  webPushSubscriptions = [],
  runs: initialRuns = []
} = {}) {
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
  const runs = new Map(initialRuns.map((r) => [r.id, { ...r }]));
  const webPushMap = new Map(
    webPushSubscriptions.map((s) => [
      s.id,
      {
        endpoint_host: "fcm.googleapis.com",
        node_filter_json: "[]",
        event_filter_json: '["run_needs_approval","run_failed","native_interaction_needed"]',
        enabled: 1,
        revoked_at: null,
        created_at: "2026-11-18T00:00:00.000Z",
        ...s
      }
    ])
  );
  const notificationDeliveries = new Map();

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
    webPushMap,
    notificationDeliveries,
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
          if (sql.includes("FROM notification_deliveries WHERE id = ?1")) {
            return notificationDeliveries.get(args[0]) ?? null;
          }
          if (sql.includes("SELECT 1 AS cooldown_hit") && sql.includes("FROM notification_deliveries")) {
            const [channelKind, channelId, cutoffIso, nodeId, agent, sessionId] = args;
            for (const d of notificationDeliveries.values()) {
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
            const [nodeId, agent, sessionId, createdAt, id] = args;
            for (const ev of nativeEvents.values()) {
              if (
                ev.node_id === nodeId &&
                ev.agent === agent &&
                ev.native_session_id === sessionId &&
                (ev.created_at > createdAt || (ev.created_at === createdAt && ev.id > id))
              ) {
                return { hit: 1 };
              }
            }
            return null;
          }
          if (sql.includes("SELECT notify_status FROM runs WHERE id = ?1")) {
            const r = runs.get(args[0]);
            return r ? { notify_status: r.notify_status ?? "none" } : null;
          }
          if (sql.includes("SELECT * FROM runs WHERE id = ?1")) {
            return runs.get(args[0]) ?? null;
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM nodes n")) {
            return { results: Array.from(nodeMap.values()).map(attachJoinedNode) };
          }
          if (sql.includes("FROM web_push_subscriptions")) {
            return {
              results: Array.from(webPushMap.values()).filter(
                (s) => s.enabled === 1 && s.revoked_at === null
              )
            };
          }
          if (sql.includes("FROM notification_deliveries") && sql.includes("GROUP BY source_id")) {
            const sourceKind = args[0];
            const idSet = new Set(args.slice(1));
            const grouped = new Map();
            for (const d of notificationDeliveries.values()) {
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
              results: Array.from(notificationDeliveries.values()).filter(
                (d) => d.source_kind === args[0] && d.source_id === args[1]
              )
            };
          }
          if (sql.includes("SELECT d.id, d.source_id") && sql.includes("FROM notification_deliveries d")) {
            const [nodeId, agent, sessionId, createdAt, id] = args;
            const results = [];
            for (const d of notificationDeliveries.values()) {
              if (
                d.source_kind !== "native_event" ||
                d.status !== "queued" ||
                (d.trigger_event !== "turn_summary" && d.trigger_event !== "progress")
              ) {
                continue;
              }
              const ev = nativeEvents.get(d.source_id);
              if (
                ev &&
                ev.node_id === nodeId &&
                ev.agent === agent &&
                ev.native_session_id === sessionId &&
                (ev.created_at < createdAt || (ev.created_at === createdAt && ev.id < id))
              ) {
                results.push({ id: d.id, source_id: d.source_id });
              }
            }
            return { results };
          }
          if (sql.includes("FROM runs")) {
            return { results: Array.from(runs.values()) };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes("UPDATE nodes") && sql.includes("default_notify_events_json = ?5")) {
            const n = nodeMap.get(args[6]);
            if (n) {
              n.display_name = args[0];
              n.status = args[1];
              n.max_concurrency = args[2];
              n.default_notify_key_id = args[3];
              n.default_notify_events_json = args[4];
              n.updated_at = args[5];
            }
            return { success: true, meta: { changes: n ? 1 : 0 } };
          }
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
              ack_at: null,
              created_at: args[13],
              updated_at: args[13]
            };
            nativeEvents.set(row.id, row);
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("INSERT OR IGNORE INTO notification_deliveries")) {
            const isRun = sql.includes("'run'");
            const sourceKind = isRun ? "run" : "native_event";
            const isCustomStatus = args.length === 13;
            const [
              id,
              sourceId,
              triggerEvent,
              nodeId,
              channelKind,
              channelId,
              channelLabel,
              targetHost,
              routeMode
            ] = args;
            const status = isCustomStatus ? args[9] : "queued";
            const errorCode = isCustomStatus ? args[10] : "";
            const errorMessage = isCustomStatus ? args[11] : "";
            const now = isCustomStatus ? args[12] : args[9];
            for (const existing of notificationDeliveries.values()) {
              if (
                existing.source_kind === sourceKind &&
                existing.source_id === sourceId &&
                existing.trigger_event === triggerEvent &&
                existing.channel_kind === channelKind &&
                existing.channel_id === channelId
              ) {
                return { success: true, meta: { changes: 0 } };
              }
            }
            const row = {
              id,
              source_kind: sourceKind,
              source_id: sourceId,
              trigger_event: triggerEvent,
              node_id: nodeId,
              channel_kind: channelKind,
              channel_id: channelId,
              channel_label: channelLabel,
              target_host: targetHost,
              route_mode: routeMode,
              status,
              attempts: 0,
              http_status: null,
              error_code: errorCode,
              error_message: errorMessage,
              sent_at: null,
              created_at: now,
              updated_at: now
            };
            notificationDeliveries.set(id, row);
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE notification_deliveries") && sql.includes("SET status = 'skipped'")) {
            const d = notificationDeliveries.get(args[1]);
            if (d && d.status === "queued") {
              d.status = "skipped";
              d.error_code = "SUPERSEDED_BY_NEWER_TURN";
              d.error_message = "Superseded by newer event in the same session during quiet window";
              d.updated_at = args[0];
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (sql.includes("UPDATE native_events") && sql.includes("SET notify_status = ?1")) {
            const ev = nativeEvents.get(args[3]);
            if (ev) {
              ev.notify_status = args[0];
              ev.notify_error = args[1];
              ev.updated_at = args[2];
            }
            return { success: true, meta: { changes: ev ? 1 : 0 } };
          }
          if (sql.includes("UPDATE runs SET notify_status = 'failed'")) {
            const existing = runs.get(args[1]) ?? { id: args[1] };
            existing.notify_status = "failed";
            existing.updated_at = args[0];
            runs.set(args[1], existing);
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE runs SET notify_status = ?1")) {
            const existing = runs.get(args[2]) ?? { id: args[2] };
            existing.notify_status = args[0];
            existing.updated_at = args[1];
            runs.set(args[2], existing);
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

test("createNativeEvent deduplicates by (node_id, event_id), redacts secrets, fans out deliveries, and fails closed when revoked", async () => {
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

  // 1. Valid bound node -> creates delivery & queues once, redacts summary, second call deduplicates
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
  assert.equal(first.event.ack_at, null);
  assert.equal(first.event.attention_state, "open");
  assert.deepEqual(first.event.deliveries_summary, { total: 1, sent: 0, queued: 1, failed: 0 });
  assert.equal(first.event.title.includes("raw_title_secret"), false);
  assert.equal(first.event.summary.includes("rawtoken12345"), false);
  assert.equal(first.event.summary.includes("ahub_cli_[REDACTED]"), true);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, "delivery");
  const dlv0 = db.notificationDeliveries.get(queued[0].delivery_id);
  assert.equal(dlv0.source_kind, "native_event");
  assert.equal(dlv0.source_id, first.event.id);
  assert.equal(dlv0.channel_kind, "bot_webhook");
  assert.equal(dlv0.route_mode, "node_default");

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

  const grokEv = await createNativeEvent(db, env, "macmini", {
    eventId: "grok:sess_g1:Stop:1234567890",
    agent: "grok",
    eventKind: "turn_summary",
    nativeSessionId: "sess_g1",
    workdir: "/workspace/demo",
    title: "Grok 会话总结",
    summary: "Completed task cleanly",
    source: "grok-hook"
  });
  assert.equal(grokEv.deduplicated, false);
  assert.equal(grokEv.event.agent, "grok");
  assert.equal(grokEv.event.attention_state, null);
  assert.equal(grokEv.event.notify_status, "queued");
  assert.equal(queued.length, 2);
  assert.equal(queued[1].kind, "delivery");

  const grokDup = await createNativeEvent(db, env, "macmini", {
    eventId: "grok:sess_g1:Stop:1234567890",
    agent: "grok",
    eventKind: "turn_summary",
    nativeSessionId: "sess_g1",
    workdir: "/workspace/demo",
    title: "Grok 会话总结",
    summary: "Completed task cleanly",
    source: "grok-hook"
  });
  assert.equal(grokDup.deduplicated, true);
  assert.equal(grokDup.event.id, grokEv.event.id);
  assert.equal(queued.length, 2);

  // 2. Unbound node without Web Push -> skipped without global fallback
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
  assert.equal(queued.length, 2);

  // 3. Revoked bound key without Web Push -> fails closed without enqueueing or global fallback
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
  assert.equal(queued.length, 2);
});

test("createNativeEvent delivers to Web Push when node has no default Bot channel", async () => {
  const queued = [];
  const env = {
    NOTIFY_QUEUE: {
      async send(msg) {
        queued.push(msg);
      }
    }
  };
  const db = createControlPlaneMockDb({
    nodes: [{ id: "mbp", default_notify_key_id: null }],
    webPushSubscriptions: [
      {
        id: "wps_01MBP",
        label: "MacBook Chrome",
        endpoint_host: "fcm.googleapis.com",
        node_filter_json: '["mbp"]',
        event_filter_json: '["native_interaction_needed"]',
        enabled: 1
      },
      {
        id: "wps_02OTHER",
        label: "MacMini Safari",
        endpoint_host: "web.push.apple.com",
        node_filter_json: '["macmini"]',
        event_filter_json: '["native_interaction_needed"]',
        enabled: 1
      }
    ]
  });

  const res = await createNativeEvent(db, env, "mbp", {
    eventId: "claude:sess_wp:Notification:11112222",
    agent: "claude",
    eventKind: "interaction_needed",
    nativeSessionId: "sess_wp",
    workdir: "/workspace/demo",
    title: "Confirm push",
    summary: "Allow push?",
    source: "claude-hook"
  });
  assert.equal(res.event.notify_status, "queued");
  assert.equal(res.event.notify_error, "");
  assert.deepEqual(res.event.deliveries_summary, { total: 1, sent: 0, queued: 1, failed: 0 });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, "delivery");
  const dlv = db.notificationDeliveries.get(queued[0].delivery_id);
  assert.equal(dlv.channel_kind, "web_push");
  assert.equal(dlv.channel_id, "wps_01MBP");
  assert.equal(dlv.route_mode, "web_push");
});

test("enqueueRunNotificationIfNeeded routes Web/CLI root runs, enforces client depth=0 and depth>=1 Web Push boundaries", async () => {
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
  assert.equal(queued[0].kind, "delivery");
  assert.equal(db.notificationDeliveries.get(queued[0].delivery_id).route_mode, "node_default");
  assert.equal(db.notificationDeliveries.get(queued[0].delivery_id).channel_kind, "bot_webhook");

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
  assert.equal(db.notificationDeliveries.get(queued[1].delivery_id).route_mode, "node_default");

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
  assert.equal(db.notificationDeliveries.get(queued[2].delivery_id).route_mode, "node_default");

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
  assert.equal(db.notificationDeliveries.get(queued[3].delivery_id).route_mode, "global_legacy");
  assert.equal(db.notificationDeliveries.get(queued[3].delivery_id).channel_kind, "legacy_webhook");

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
  assert.equal(db.notificationDeliveries.get(queued[4].delivery_id).route_mode, "key");

  // Now add an active admin Web Push subscription listening to all run events
  db.webPushMap.set("wps_admin_1", {
    id: "wps_admin_1",
    label: "Admin Browser",
    endpoint_host: "fcm.googleapis.com",
    node_filter_json: "[]",
    event_filter_json: '["run_needs_approval","run_failed","run_done","run_cancelled"]',
    enabled: 1,
    revoked_at: null,
    created_at: "2026-11-18T00:00:00.000Z"
  });

  // client depth=0 target="none": done & cancelled MUST stay silent on Web Push; needs_approval & failed notify Web Push
  assert.equal(
    await enqueueRunNotificationIfNeeded(
      db,
      env,
      { ...baseRun, id: "run_cli_done", created_by_key_id: "key_bot_2", status: "done" },
      "done"
    ),
    false
  );
  assert.equal(
    await enqueueRunNotificationIfNeeded(
      db,
      env,
      { ...baseRun, id: "run_cli_cancel", created_by_key_id: "key_bot_2", status: "cancelled" },
      "cancelled"
    ),
    false
  );
  assert.equal(queued.length, 5);

  assert.equal(
    await enqueueRunNotificationIfNeeded(
      db,
      env,
      { ...baseRun, id: "run_cli_approval", created_by_key_id: "key_bot_2", status: "needs_approval" },
      "needs_approval"
    ),
    true
  );
  assert.equal(queued.length, 6);
  assert.equal(db.notificationDeliveries.get(queued[5].delivery_id).channel_kind, "web_push");
  assert.equal(db.notificationDeliveries.get(queued[5].delivery_id).trigger_event, "needs_approval");

  assert.equal(
    await enqueueRunNotificationIfNeeded(
      db,
      env,
      { ...baseRun, id: "run_cli_failed", created_by_key_id: "key_bot_2", status: "failed" },
      "failed"
    ),
    true
  );
  assert.equal(queued.length, 7);
  assert.equal(db.notificationDeliveries.get(queued[6].delivery_id).channel_kind, "web_push");
  assert.equal(db.notificationDeliveries.get(queued[6].delivery_id).trigger_event, "failed");

  // depth >= 1 (even admin or client with failed/needs_approval) MUST remain silent on Web Push & never hit node_default
  assert.equal(
    await enqueueRunNotificationIfNeeded(
      db,
      env,
      { ...baseRun, id: "run_depth1_admin", depth: 1, created_by_key_id: "key_admin_1", status: "failed" },
      "failed"
    ),
    false
  );
  assert.equal(
    await enqueueRunNotificationIfNeeded(
      db,
      env,
      {
        ...baseRun,
        id: "run_depth1_admin_grok",
        depth: 1,
        created_by_key_id: "key_admin_1",
        status: "failed",
        notify_policy_json: JSON.stringify({ target: "grok" })
      },
      "failed"
    ),
    true
  );
  assert.equal(queued.length, 8);
  assert.equal(db.notificationDeliveries.get(queued[7].delivery_id).route_mode, "global_legacy");
});

test("computeAttentionState handles acked, same-ms ULID supersession, empty session, stale, and open", () => {
  const nowMs = Date.parse("2026-11-18T12:00:00.000Z");

  // Non-interaction -> null
  assert.equal(
    computeAttentionState(
      {
        id: "evt_01A",
        node_id: "macmini",
        agent: "claude",
        event_kind: "turn_summary",
        native_session_id: "sess_1",
        ack_at: null,
        created_at: "2026-11-18T11:00:00.000Z"
      },
      [],
      nowMs
    ),
    null
  );

  // acked beats superseded
  assert.equal(
    computeAttentionState(
      {
        id: "evt_01A",
        node_id: "macmini",
        agent: "claude",
        event_kind: "interaction_needed",
        native_session_id: "sess_1",
        ack_at: "2026-11-18T11:30:00.000Z",
        created_at: "2026-11-18T11:00:00.000Z"
      },
      [
        {
          id: "evt_01B",
          node_id: "macmini",
          agent: "claude",
          native_session_id: "sess_1",
          created_at: "2026-11-18T11:00:00.000Z"
        }
      ],
      nowMs
    ),
    "acked"
  );

  // Same-millisecond tie-break using monotonic ULID id
  assert.equal(
    computeAttentionState(
      {
        id: "evt_01AAA",
        node_id: "macmini",
        agent: "claude",
        event_kind: "interaction_needed",
        native_session_id: "sess_1",
        ack_at: null,
        created_at: "2026-11-18T11:00:00.000Z"
      },
      [
        {
          id: "evt_01AAB",
          node_id: "macmini",
          agent: "claude",
          native_session_id: "sess_1",
          created_at: "2026-11-18T11:00:00.000Z"
        }
      ],
      nowMs
    ),
    "superseded"
  );

  // Empty native_session_id is never auto-superseded
  assert.equal(
    computeAttentionState(
      {
        id: "evt_01AAA",
        node_id: "macmini",
        agent: "claude",
        event_kind: "interaction_needed",
        native_session_id: "",
        ack_at: null,
        created_at: "2026-11-18T11:00:00.000Z"
      },
      [
        {
          id: "evt_01AAB",
          node_id: "macmini",
          agent: "claude",
          native_session_id: "",
          created_at: "2026-11-18T11:05:00.000Z"
        }
      ],
      nowMs
    ),
    "open"
  );

  // Stale (> 24h) vs Open (<= 24h)
  assert.equal(
    computeAttentionState(
      {
        id: "evt_01OLD",
        node_id: "macmini",
        agent: "claude",
        event_kind: "interaction_needed",
        native_session_id: "sess_old",
        ack_at: null,
        created_at: "2026-11-17T11:59:59.999Z"
      },
      [],
      nowMs
    ),
    "stale"
  );
  assert.equal(
    computeAttentionState(
      {
        id: "evt_01FRESH",
        node_id: "macmini",
        agent: "claude",
        event_kind: "interaction_needed",
        native_session_id: "sess_fresh",
        ack_at: null,
        created_at: "2026-11-17T12:00:00.000Z"
      },
      [],
      nowMs
    ),
    "open"
  );
});

test("computeAggregateNotifyStatus preserves Run schema compatibility and attaches deliveries_summary", async () => {
  assert.equal(
    computeAggregateNotifyStatus("native_event", [], { nodeDefaultNotifyKeyId: null }).notifyStatus,
    "skipped"
  );
  assert.equal(
    computeAggregateNotifyStatus("native_event", [], {
      nodeDefaultNotifyKeyId: "key_1",
      nodeDefaultNotifyValid: false
    }).notifyStatus,
    "failed"
  );
  assert.equal(
    computeAggregateNotifyStatus("native_event", [{ status: "sent" }, { status: "queued" }]).notifyStatus,
    "queued"
  );
  const partialNative = computeAggregateNotifyStatus("native_event", [
    { status: "sent" },
    { status: "failed", error_code: "PUSH_UPSTREAM_TIMEOUT" }
  ]);
  assert.equal(partialNative.notifyStatus, "partial");
  assert.deepEqual(partialNative.deliveriesSummary, { total: 2, sent: 1, queued: 0, failed: 1 });

  const mixedRun = computeAggregateNotifyStatus("run", [
    { status: "sent" },
    { status: "failed", error_code: "PUSH_UPSTREAM_TIMEOUT" }
  ]);
  assert.equal(mixedRun.notifyStatus, "sent");
  assert.deepEqual(mixedRun.deliveriesSummary, { total: 2, sent: 1, queued: 0, failed: 1 });

  const db = createControlPlaneMockDb({
    runs: [
      {
        id: "run_sum_1",
        thread_id: "thr_1",
        root_run_id: "run_sum_1",
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
        prompt: "hello",
        status: "done",
        priority_order: 100,
        resolved_model: "",
        resolved_effort: "",
        native_session_id: null,
        remote_control_url: "",
        summary: "ok",
        output_md: "ok",
        output_bytes: 2,
        error_code: "",
        error_message: "",
        notify_status: "sent",
        lease_expires_at: null,
        started_at: null,
        finished_at: null,
        duration_ms: 10,
        created_at: "2026-11-18T00:00:00.000Z",
        updated_at: "2026-11-18T00:00:00.000Z"
      }
    ]
  });
  db.notificationDeliveries.set("dlv_1", {
    id: "dlv_1",
    source_kind: "run",
    source_id: "run_sum_1",
    status: "sent"
  });
  db.notificationDeliveries.set("dlv_2", {
    id: "dlv_2",
    source_kind: "run",
    source_id: "run_sum_1",
    status: "failed"
  });

  const adminPrincipal = {
    kind: "api_key",
    scope: "admin",
    keyId: "key_admin",
    boundNodeId: null,
    allowedNodes: [],
    allowUnsandboxed: true,
    maxDepthLimit: 2
  };
  const single = await getRunById(db, adminPrincipal, "run_sum_1", "summary", 16384);
  assert.deepEqual(single.deliveries_summary, { total: 2, sent: 1, queued: 0, failed: 1 });
  const listed = await listRuns(db, adminPrincipal, { limit: 10 });
  assert.deepEqual(listed[0].deliveries_summary, { total: 2, sent: 1, queued: 0, failed: 1 });
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

test("createNativeEvent progress routes to native_progress push and supersedes prior interaction_needed", async () => {
  const queued = [];
  const env = {
    NOTIFY_QUEUE: {
      async send(msg) {
        queued.push(msg);
      }
    }
  };
  const db = createControlPlaneMockDb({
    nodes: [{ id: "macmini", default_notify_key_id: null }],
    webPushSubscriptions: [
      {
        id: "wps_01PROG",
        label: "Progress Push",
        endpoint_host: "fcm.googleapis.com",
        node_filter_json: '["macmini"]',
        event_filter_json: '["native_progress"]',
        enabled: 1
      }
    ]
  });

  const first = await createNativeEvent(db, env, "macmini", {
    eventId: "claude:sess_prog:Notification:11112222",
    agent: "claude",
    eventKind: "interaction_needed",
    nativeSessionId: "sess_prog",
    workdir: "~/workspace/demo",
    title: "Need confirmation",
    summary: "Proceed?",
    source: "claude-hook"
  });
  assert.equal(first.event.attention_state, "open");
  assert.equal(queued.length, 0);

  await new Promise((resolve) => setTimeout(resolve, 3));

  const prog = await createNativeEvent(db, env, "macmini", {
    eventId: "cli:sess_prog:progress:33334444",
    agent: "claude",
    eventKind: "progress",
    nativeSessionId: "sess_prog",
    workdir: "~/workspace/demo",
    title: "Stage 2/3",
    summary: "Unit suite green",
    source: "cli"
  });
  assert.equal(prog.event.event_kind, "progress");
  assert.equal(prog.event.attention_state, null);
  assert.equal(prog.event.notify_status, "queued");
  assert.equal(queued.length, 1);

  const firstRow = db.nativeEvents.get(first.event.id);
  const progRow = db.nativeEvents.get(prog.event.id);
  assert.equal(
    computeAttentionState(firstRow, [firstRow, progRow]),
    "superseded"
  );
  assert.deepEqual(
    computeAggregateNotifyStatus("native_event", [], {
      nodeDefaultNotifyKeyId: "key_1",
      nodeDefaultNotifyValid: true
    }),
    {
      notifyStatus: "skipped",
      notifyError: "NO_MATCHING_CHANNELS",
      deliveriesSummary: { total: 0, sent: 0, queued: 0, failed: 0 }
    }
  );
});
