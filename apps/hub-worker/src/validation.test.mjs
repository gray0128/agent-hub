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
  parseApprovalCheckpointRequest,
  parseCreateRunRequest,
  parseNativeEventCreateRequest,
  parseNodeWsFrame,
  parsePatchNodeRequest,
  parsePatchRunRequest,
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
});
