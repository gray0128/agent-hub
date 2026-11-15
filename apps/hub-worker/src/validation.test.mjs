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

const { parseCreateRunRequest, parseNodeWsFrame, parsePatchRunRequest } = await import("./validation.ts");

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
          default_model: "gemini-3.8-flash-high",
          default_effort: "high",
          catalog_status: "ready",
          models: [
            {
              id: "gemini-3.8-flash",
              label: "Gemini 3.8 Flash",
              efforts: ["low", "medium", "high"],
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
