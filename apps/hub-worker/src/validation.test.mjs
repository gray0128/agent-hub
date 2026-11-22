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
  parseAckNativeEventRequest,
  parseApprovalCheckpointRequest,
  parseCreatePushSubscriptionRequest,
  parseCreateRunRequest,
  parseIncludeRevokedQuery,
  parseListNativeEventsQuery,
  parseNativeEventCreateRequest,
  parseNodeWsFrame,
  parsePatchNodeRequest,
  parsePatchPushSubscriptionRequest,
  parsePatchRunRequest,
  parseRedeliverRequest,
  parseResolveRunRequest
} = await import("./validation.ts");

test("parseCreateRunRequest and parsePatchRunRequest accept ultra and auto effort levels", () => {
  const created = parseCreateRunRequest({
    node_id: "macmini",
    workdir: "demo",
    agent: "codex",
    model: "gpt-5.6-sol",
    effort: "ultra",
    prompt: "Check repo"
  });
  assert.equal(created.effort, "ultra");

  const patched = parsePatchRunRequest({ effort: "auto" });
  assert.equal(patched.effort, "auto");

  assert.throws(
    () =>
      parseCreateRunRequest({
        node_id: "macmini",
        workdir: "demo",
        agent: "codex",
        effort: "turbo",
        prompt: "Check repo"
      }),
    /Unsupported effort 'turbo'/
  );
});

test("parseNodeWsFrame validates structured node.hello capabilities and rejects invalid model catalogs", () => {
  const hello = parseNodeWsFrame({
    type: "node.hello",
    conn_nonce: "nonce-12345678",
    version: "0.2.0",
    os: "darwin",
    arch: "arm64",
    max_concurrency: 4,
    capabilities: {
      agents: {
        agy: {
          enabled: true,
          available: true,
          default_model: "gemini-4-hydrogen",
          default_effort: "high",
          catalog_status: "ready",
          models: [
            {
              id: "gemini-4-hydrogen",
              label: "Gemini 4 Hydrogen",
              efforts: ["low", "medium", "high", "xhigh"],
              default_effort: "high"
            },
            {
              id: "gemini-pro-orchestrator",
              label: "Orchestrator (Carbon)",
              efforts: []
            }
          ]
        }
      },
      aliases: { carbon: "gemini-4-carbon-high" }
    },
    workspaces: []
  });
  assert.equal(hello.type, "node.hello");

  assert.throws(
    () =>
      parseNodeWsFrame({
        type: "node.hello",
        conn_nonce: "nonce-12345678",
        capabilities: {
          agents: {
            codex: {
              enabled: true,
              available: true,
              catalog_status: "ready",
              models: [
                {
                  id: "gpt-5.6-sol",
                  label: "GPT-5.6-Sol",
                  efforts: ["ultra", "invalid_tier"]
                }
              ]
            }
          }
        },
        workspaces: []
      }),
    /Invalid effort 'invalid_tier'/
  );

  assert.throws(
    () =>
      parseNodeWsFrame({
        type: "node.hello",
        conn_nonce: "nonce-12345678",
        capabilities: {
          agents: {
            codex: {
              models: [{ id: "gpt-5", label: "GPT-5" }]
            }
          }
        },
        workspaces: []
      }),
    /efforts must be an array/
  );
});

test("parseApprovalCheckpointRequest and parseResolveRunRequest validate payloads cleanly", () => {
  const cp = parseApprovalCheckpointRequest({
    lease_owner: "macmini:nonce-1234",
    remote_control_url: "https://ahub.bobocai.win/rc/abc",
    native_session_id: "conv_123",
    resolved_model: "gemini-4-carbon-high",
    resolved_effort: "high",
    summary: "Waiting for approval",
    output_md: "Partial markdown",
    duration_ms: 1200
  });
  assert.equal(cp.leaseOwner, "macmini:nonce-1234");
  assert.equal(cp.outputBytes, Buffer.byteLength("Partial markdown"));
  assert.throws(
    () => parseApprovalCheckpointRequest({ lease_owner: "", summary: "missing" }),
    /lease_owner/
  );

  assert.deepEqual(parseResolveRunRequest(undefined), {});
  assert.deepEqual(parseResolveRunRequest({ summary: "Approved remotely" }), {
    summary: "Approved remotely"
  });
  assert.throws(() => parseResolveRunRequest({ unknown: true }), /Unexpected field/);
});

test("parsePatchNodeRequest and parseNativeEventCreateRequest validate default_notify_key_id and native events", () => {
  assert.deepEqual(parsePatchNodeRequest({ default_notify_key_id: "key_01ABCDEF1234" }), {
    displayName: undefined,
    status: undefined,
    maxConcurrency: undefined,
    defaultNotifyKeyId: "key_01ABCDEF1234"
  });
  assert.deepEqual(parsePatchNodeRequest({ default_notify_key_id: "" }), {
    displayName: undefined,
    status: undefined,
    maxConcurrency: undefined,
    defaultNotifyKeyId: null
  });
  assert.throws(() => parsePatchNodeRequest({ default_notify_key_id: "bad_id" }), /default_notify_key_id/);

  const ev = parseNativeEventCreateRequest({
    event_id: "claude:sess_1:Stop:abcdef123456",
    agent: "claude",
    event_kind: "interaction_needed",
    native_session_id: "sess_1",
    workdir: "~/workspace/demo",
    title: "Permission required",
    summary: "Claude needs confirmation",
    source: "claude-hook"
  });
  assert.equal(ev.agent, "claude");
  assert.equal(ev.eventKind, "interaction_needed");
  assert.throws(
    () => parseNativeEventCreateRequest({ event_id: "bad", agent: "claude", event_kind: "turn_summary", summary: "x" }),
    /event_id/
  );
  assert.throws(
    () =>
      parseNativeEventCreateRequest({
        event_id: "evt_valid_1234",
        agent: "claude",
        event_kind: "other",
        summary: "x"
      }),
    /event_kind/
  );

  const grokEv = parseNativeEventCreateRequest({
    event_id: "grok_1234567890abcdef",
    agent: "grok",
    event_kind: "turn_summary",
    native_session_id: "grok_sess_1",
    workdir: "~/workspace/demo",
    title: "Grok 会话总结",
    summary: "Finished Grok turn",
    source: "grok-hook"
  });
  assert.equal(grokEv.agent, "grok");
  assert.equal(grokEv.source, "grok-hook");

  assert.throws(
    () =>
      parseCreateRunRequest({
        node_id: "macmini",
        workdir: "demo",
        agent: "grok",
        prompt: "Must fail for Run creation"
      }),
    /Unsupported agent/
  );

  const progressEv = parseNativeEventCreateRequest({
    event_id: "cli:sess_1:progress:1234abcd",
    agent: "claude",
    event_kind: "progress",
    native_session_id: "sess_1",
    workdir: "~/workspace/demo",
    title: "Stage 1/3",
    summary: "Schema check passed",
    source: "cli"
  });
  assert.equal(progressEv.eventKind, "progress");
});

test("M3 admin query, ack, redeliver, and push-subscription parsers enforce contracts", () => {
  const q = parseListNativeEventsQuery(
    new URLSearchParams("node_id=macmini&agent=claude&event_kind=progress&notify_status=partial&unacked_only=true&limit=250&q=deploy")
  );
  assert.equal(q.nodeId, "macmini");
  assert.equal(q.agent, "claude");
  assert.equal(q.eventKind, "progress");
  assert.equal(q.notifyStatus, "partial");
  assert.equal(q.unackedOnly, true);
  assert.equal(q.limit, 100);
  assert.equal(q.q, "deploy");

  assert.throws(
    () => parseListNativeEventsQuery(new URLSearchParams("before_id=evt_01ABC")),
    /requires 'before_ts'/
  );
  assert.throws(
    () => parseListNativeEventsQuery(new URLSearchParams("unacked_only=maybe")),
    /unacked_only/
  );
  assert.throws(
    () => parseListNativeEventsQuery(new URLSearchParams("limit=abc")),
    /limit/
  );

  assert.deepEqual(parseAckNativeEventRequest(undefined), { scope: "single" });
  assert.deepEqual(parseAckNativeEventRequest({ scope: "session" }), { scope: "session" });
  assert.throws(() => parseAckNativeEventRequest({ scope: "all" }), /scope/);

  assert.deepEqual(parseRedeliverRequest(undefined), {});
  assert.deepEqual(parseRedeliverRequest({ delivery_id: "dlv_01ABCDEF" }), { deliveryId: "dlv_01ABCDEF" });
  assert.throws(() => parseRedeliverRequest({ delivery_id: "bad_id" }), /delivery_id/);

  assert.equal(parseIncludeRevokedQuery(new URLSearchParams("")), false);
  assert.equal(parseIncludeRevokedQuery(new URLSearchParams("include_revoked=true")), true);
  assert.throws(() => parseIncludeRevokedQuery(new URLSearchParams("include_revoked=1")), /include_revoked/);

  const validP256dh = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0x11)]).toString("base64url");
  const validAuth = Buffer.alloc(16, 0x22).toString("base64url");
  const sub = parseCreatePushSubscriptionRequest(
    {
      label: "MacBook Chrome",
      subscription: {
        endpoint: "https://fcm.googleapis.com/fcm/send/sub123",
        keys: { p256dh: validP256dh, auth: validAuth }
      },
      node_filter: ["macmini", "macmini", "mbp"]
    },
    false
  );
  assert.equal(sub.endpointHost, "fcm.googleapis.com");
  assert.deepEqual(sub.nodeFilter, ["macmini", "mbp"]);
  assert.deepEqual(sub.eventFilter, [
    "run_needs_approval",
    "run_failed",
    "native_interaction_needed",
    "board_question_opened"
  ]);

  assert.throws(
    () =>
      parseCreatePushSubscriptionRequest(
        {
          label: "Loopback Blocked",
          subscription: {
            endpoint: "http://127.0.0.1:8080/push",
            keys: { p256dh: validP256dh, auth: validAuth }
          }
        },
        false
      ),
    /https/
  );
  assert.throws(
    () =>
      parseCreatePushSubscriptionRequest(
        {
          label: "Bad Filter",
          subscription: {
            endpoint: "https://fcm.googleapis.com/fcm/send/sub123",
            keys: { p256dh: validP256dh, auth: validAuth }
          },
          event_filter: ["unknown_event"]
        },
        false
      ),
    /Invalid event filter key/
  );

  assert.throws(() => parsePatchPushSubscriptionRequest({}), /at least one field/);
  const patchedSub = parsePatchPushSubscriptionRequest({
    enabled: false,
    event_filter: ["native_interaction_needed", "native_progress"]
  });
  assert.equal(patchedSub.enabled, false);
  assert.deepEqual(patchedSub.eventFilter, ["native_interaction_needed", "native_progress"]);
});

test("parsePatchNodeRequest validates default_notify_events", () => {
  const emptyEvents = parsePatchNodeRequest({ default_notify_events: [] });
  assert.deepEqual(emptyEvents.defaultNotifyEvents, []);

  const subset = parsePatchNodeRequest({
    default_notify_events: ["native_interaction_needed", "run_failed", "native_interaction_needed"]
  });
  assert.deepEqual(subset.defaultNotifyEvents, ["native_interaction_needed", "run_failed"]);

  const withoutEvents = parsePatchNodeRequest({ display_name: "Node A" });
  assert.equal("defaultNotifyEvents" in withoutEvents, false);

  assert.throws(
    () => parsePatchNodeRequest({ default_notify_events: ["not_an_event"] }),
    /Invalid event filter key/
  );
  assert.throws(
    () => parsePatchNodeRequest({ default_notify_events: "native_turn_summary" }),
    /must be an array/
  );
});
