import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const rootDir = process.cwd();
const schemasDir = path.join(rootDir, "docs", "schemas");

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
addFormats(ajv);

const files = ["run-create.schema.json", "run-record.schema.json", "ws-frames.schema.json"];
const validators = {};

for (const file of files) {
  const fullPath = path.join(schemasDir, file);
  const schema = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  validators[file] = ajv.compile(schema);
}

const cases = [
  {
    name: "run-create valid new thread",
    schema: "run-create.schema.json",
    valid: true,
    payload: {
      node_id: "macmini",
      workdir: "demo",
      agent: "agy",
      model: "carbon",
      effort: "high",
      prompt: "Inspect repo",
      notify: { target: "grok", events: ["done", "failed"] }
    }
  },
  {
    name: "run-create valid thread follow-up",
    schema: "run-create.schema.json",
    valid: true,
    payload: {
      thread_id: "thr_01JABCDEF123456789",
      prompt: "Continue"
    }
  },
  {
    name: "run-create invalid missing node_id without thread_id",
    schema: "run-create.schema.json",
    valid: false,
    payload: {
      workdir: "demo",
      agent: "agy",
      prompt: "Missing node"
    }
  },
  {
    name: "run-record valid envelope",
    schema: "run-record.schema.json",
    valid: true,
    payload: {
      id: "run_01JABCDEF123456789",
      thread_id: "thr_01JABCDEF123456789",
      root_run_id: "run_01JABCDEF123456789",
      parent_run_id: null,
      depth: 0,
      max_depth: 1,
      node_id: "macmini",
      workdir: "/workspace/demo",
      agent: "agy",
      status: "done",
      output_bytes: 120,
      truncated: false,
      webhook_armed: false,
      created_at: "2026-11-13T05:00:00.000Z",
      updated_at: "2026-11-13T05:00:05.000Z"
    }
  },
  {
    name: "run-record invalid unknown field",
    schema: "run-record.schema.json",
    valid: false,
    payload: {
      id: "run_01JABCDEF123456789",
      thread_id: "thr_01JABCDEF123456789",
      root_run_id: "run_01JABCDEF123456789",
      depth: 0,
      max_depth: 1,
      node_id: "macmini",
      workdir: "/workspace/demo",
      agent: "agy",
      status: "done",
      created_at: "2026-11-13T05:00:00.000Z",
      updated_at: "2026-11-13T05:00:05.000Z",
      extra_field: true
    }
  },
  {
    name: "ws-frames valid run.events batch",
    schema: "ws-frames.schema.json",
    valid: true,
    payload: {
      type: "run.events",
      run_id: "run_01JABCDEF123456789",
      events: [
        {
          seq: 1,
          kind: "tool_use",
          payload: { tool: "bash" },
          ts: "2026-11-13T05:00:01.000Z"
        }
      ]
    }
  },
  {
    name: "ws-frames valid snapshot with threads",
    schema: "ws-frames.schema.json",
    valid: true,
    payload: {
      type: "snapshot",
      nodes: [],
      threads: [],
      runs: [],
      ts: "2026-11-13T05:00:01.000Z"
    }
  },
  {
    name: "run-create valid with ultra effort",
    schema: "run-create.schema.json",
    valid: true,
    payload: {
      node_id: "macmini",
      workdir: "demo",
      agent: "codex",
      model: "gpt-5.6-sol",
      effort: "ultra",
      prompt: "Run deep analysis"
    }
  },
  {
    name: "ws-frames valid node.hello with capabilities catalog",
    schema: "ws-frames.schema.json",
    valid: true,
    payload: {
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
        }
      },
      workspaces: []
    }
  },
  {
    name: "ws-frames invalid node.hello unknown model effort",
    schema: "ws-frames.schema.json",
    valid: false,
    payload: {
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
            catalog_status: "ready",
            models: [
              {
                id: "gemini-4-carbon",
                label: "Gemini 4 Carbon",
                efforts: ["turbo"]
              }
            ]
          }
        }
      },
      workspaces: []
    }
  },
  {
    name: "ws-frames invalid empty run.events",
    schema: "ws-frames.schema.json",
    valid: false,
    payload: {
      type: "run.events",
      run_id: "run_01JABCDEF123456789",
      events: []
    }
  }
];

let failures = 0;
for (const c of cases) {
  const validate = validators[c.schema];
  const ok = validate(c.payload);
  if (ok !== c.valid) {
    failures++;
    console.error(`FAIL [${c.name}]: expected valid=${c.valid}, got ${ok}`, validate.errors);
  }
}

if (failures > 0) {
  process.exit(1);
}

console.log(`SCHEMA_VALIDATION_PASSED (${files.length} schemas, ${cases.length} cases)`);
