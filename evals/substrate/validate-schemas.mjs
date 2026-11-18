import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const rootDir = process.cwd();
const schemasDir = path.join(rootDir, "docs", "schemas");

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
addFormats(ajv);

const files = [
  "run-create.schema.json",
  "run-record.schema.json",
  "native-event.schema.json",
  "ws-frames.schema.json"
];
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
      prompt: "Inspect repo without leaking ahub_cli_[REDACTED]",
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
  },
  {
    name: "native-event valid interaction_needed partial",
    schema: "native-event.schema.json",
    valid: true,
    payload: {
      id: "evt_01JABCDEF123456789",
      node_id: "macmini",
      event_id: "claude:sess_1:Notification:9f8e7d6c5b4a",
      agent: "claude",
      event_kind: "interaction_needed",
      native_session_id: "sess_1",
      workdir: "~/workspace/demo",
      title: "Need confirmation",
      summary: "Allow running migration check?",
      source: "claude-hook",
      notify_key_id: "key_01JABCDEF123456789",
      notify_status: "partial",
      notify_error: "",
      ack_at: null,
      attention_state: "open",
      deliveries_summary: { total: 2, sent: 1, queued: 0, failed: 1 },
      created_at: "2026-11-18T05:00:00.000Z",
      updated_at: "2026-11-18T05:00:01.000Z"
    }
  },
  {
    name: "native-event valid grok progress skipped",
    schema: "native-event.schema.json",
    valid: true,
    payload: {
      id: "evt_01JABCDEF123456790",
      node_id: "mbp",
      event_id: "cli:sess_2:progress:1a2b3c4d",
      agent: "grok",
      event_kind: "progress",
      native_session_id: "sess_2",
      workdir: "~/workspace/demo",
      title: "Stage 1/3 complete",
      summary: "Unit tests passed.",
      source: "cli",
      notify_key_id: null,
      notify_status: "skipped",
      notify_error: "NODE_DEFAULT_CHANNEL_UNBOUND",
      ack_at: null,
      attention_state: null,
      created_at: "2026-11-18T05:05:00.000Z",
      updated_at: "2026-11-18T05:05:00.000Z"
    }
  },
  {
    name: "native-event invalid extra field",
    schema: "native-event.schema.json",
    valid: false,
    payload: {
      id: "evt_01JABCDEF123456791",
      node_id: "macmini",
      event_id: "claude:sess_1:Stop:11223344",
      agent: "claude",
      event_kind: "turn_summary",
      native_session_id: "sess_1",
      workdir: "~/workspace/demo",
      title: "Turn summary",
      summary: "Done.",
      source: "claude-hook",
      notify_key_id: null,
      notify_status: "sent",
      notify_error: "",
      ack_at: null,
      attention_state: null,
      created_at: "2026-11-18T05:06:00.000Z",
      updated_at: "2026-11-18T05:06:00.000Z",
      extra_field: "unexpected"
    }
  },
  {
    name: "native-event invalid attention_state pending",
    schema: "native-event.schema.json",
    valid: false,
    payload: {
      id: "evt_01JABCDEF123456792",
      node_id: "macmini",
      event_id: "claude:sess_1:Notification:22334455",
      agent: "claude",
      event_kind: "interaction_needed",
      native_session_id: "sess_1",
      workdir: "~/workspace/demo",
      title: "Need confirmation",
      summary: "Proceed?",
      source: "claude-hook",
      notify_key_id: null,
      notify_status: "queued",
      notify_error: "",
      ack_at: null,
      attention_state: "pending",
      created_at: "2026-11-18T05:07:00.000Z",
      updated_at: "2026-11-18T05:07:00.000Z"
    }
  },
  {
    name: "native-event invalid event_kind tool_use",
    schema: "native-event.schema.json",
    valid: false,
    payload: {
      id: "evt_01JABCDEF123456793",
      node_id: "macmini",
      event_id: "claude:sess_1:PostToolUse:33445566",
      agent: "claude",
      event_kind: "tool_use",
      native_session_id: "sess_1",
      workdir: "~/workspace/demo",
      title: "Tool call",
      summary: "read_file",
      source: "claude-hook",
      notify_key_id: null,
      notify_status: "none",
      notify_error: "",
      ack_at: null,
      attention_state: null,
      created_at: "2026-11-18T05:08:00.000Z",
      updated_at: "2026-11-18T05:08:00.000Z"
    }
  },
  {
    name: "run-record valid with deliveries_summary",
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
      notify_status: "sent",
      deliveries_summary: { total: 3, sent: 2, queued: 0, failed: 1 },
      created_at: "2026-11-18T05:00:00.000Z",
      updated_at: "2026-11-18T05:00:05.000Z"
    }
  },
  {
    name: "run-record invalid notify_status partial",
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
      notify_status: "partial",
      created_at: "2026-11-18T05:00:00.000Z",
      updated_at: "2026-11-18T05:00:05.000Z"
    }
  },
  {
    name: "run-record invalid negative deliveries_summary count",
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
      notify_status: "failed",
      deliveries_summary: { total: 1, sent: 0, queued: 0, failed: -1 },
      created_at: "2026-11-18T05:00:00.000Z",
      updated_at: "2026-11-18T05:00:05.000Z"
    }
  },
  {
    name: "run-record invalid extra field in deliveries_summary",
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
      notify_status: "sent",
      deliveries_summary: { total: 1, sent: 1, queued: 0, failed: 0, skipped: 0 },
      created_at: "2026-11-18T05:00:00.000Z",
      updated_at: "2026-11-18T05:00:05.000Z"
    }
  },
  {
    name: "ws-frames valid snapshot with native_events",
    schema: "ws-frames.schema.json",
    valid: true,
    payload: {
      type: "snapshot",
      nodes: [],
      threads: [],
      runs: [],
      native_events: [
        {
          id: "evt_01JABCDEF123456789",
          node_id: "macmini",
          event_id: "claude:sess_1:Notification:9f8e7d6c5b4a",
          agent: "claude",
          event_kind: "interaction_needed",
          native_session_id: "sess_1",
          workdir: "~/workspace/demo",
          title: "Need confirmation",
          summary: "Allow running migration check?",
          source: "claude-hook",
          notify_key_id: null,
          notify_status: "sent",
          notify_error: "",
          ack_at: null,
          attention_state: "open",
          deliveries_summary: { total: 1, sent: 1, queued: 0, failed: 0 },
          created_at: "2026-11-18T05:00:00.000Z",
          updated_at: "2026-11-18T05:00:01.000Z"
        }
      ],
      open_interaction_count: 1,
      ts: "2026-11-18T05:00:02.000Z"
    }
  },
  {
    name: "ws-frames invalid snapshot negative open_interaction_count",
    schema: "ws-frames.schema.json",
    valid: false,
    payload: {
      type: "snapshot",
      nodes: [],
      native_events: [],
      open_interaction_count: -1,
      ts: "2026-11-18T05:00:02.000Z"
    }
  },
  {
    name: "ws-frames valid native_event.upserted",
    schema: "ws-frames.schema.json",
    valid: true,
    payload: {
      type: "native_event.upserted",
      event: {
        id: "evt_01JABCDEF123456789",
        node_id: "macmini",
        event_id: "claude:sess_1:Notification:9f8e7d6c5b4a",
        agent: "claude",
        event_kind: "interaction_needed",
        native_session_id: "sess_1",
        workdir: "~/workspace/demo",
        title: "Need confirmation",
        summary: "Allow running migration check?",
        source: "claude-hook",
        notify_key_id: null,
        notify_status: "sent",
        notify_error: "",
        ack_at: null,
        attention_state: "open",
        created_at: "2026-11-18T05:00:00.000Z",
        updated_at: "2026-11-18T05:00:01.000Z"
      },
      open_interaction_count: 1
    }
  },
  {
    name: "ws-frames invalid native_event.upserted missing open_interaction_count",
    schema: "ws-frames.schema.json",
    valid: false,
    payload: {
      type: "native_event.upserted",
      event: {
        id: "evt_01JABCDEF123456789",
        node_id: "macmini",
        event_id: "claude:sess_1:Notification:9f8e7d6c5b4a",
        agent: "claude",
        event_kind: "interaction_needed",
        native_session_id: "sess_1",
        workdir: "~/workspace/demo",
        title: "Need confirmation",
        summary: "Allow running migration check?",
        source: "claude-hook",
        notify_key_id: null,
        notify_status: "sent",
        notify_error: "",
        ack_at: null,
        attention_state: "open",
        created_at: "2026-11-18T05:00:00.000Z",
        updated_at: "2026-11-18T05:00:01.000Z"
      }
    }
  },
  {
    name: "ws-frames valid delivery.updated",
    schema: "ws-frames.schema.json",
    valid: true,
    payload: {
      type: "delivery.updated",
      delivery: {
        id: "dlv_01JABCDEF123456789",
        source_kind: "native_event",
        source_id: "evt_01JABCDEF123456789",
        trigger_event: "interaction_needed",
        node_id: "macmini",
        channel_kind: "web_push",
        channel_id: "wps_01JABCDEF123456789",
        channel_label: "MacBook Safari",
        target_host: "web.push.apple.com",
        route_mode: "web_push",
        status: "sent",
        attempts: 1,
        http_status: 201,
        error_code: "",
        error_message: "",
        sent_at: "2026-11-18T05:00:01.000Z",
        created_at: "2026-11-18T05:00:00.000Z",
        updated_at: "2026-11-18T05:00:01.000Z"
      }
    }
  },
  {
    name: "ws-frames invalid delivery.updated unknown channel_kind",
    schema: "ws-frames.schema.json",
    valid: false,
    payload: {
      type: "delivery.updated",
      delivery: {
        id: "dlv_01JABCDEF123456789",
        source_kind: "run",
        source_id: "run_01JABCDEF123456789",
        trigger_event: "failed",
        node_id: "macmini",
        channel_kind: "email",
        channel_id: "key_01JABCDEF123456789",
        channel_label: "Alert Mail",
        target_host: "mail.example.com",
        route_mode: "key",
        status: "failed",
        attempts: 1,
        http_status: null,
        error_code: "UNSUPPORTED",
        error_message: "Unsupported channel",
        sent_at: null,
        created_at: "2026-11-18T05:00:00.000Z",
        updated_at: "2026-11-18T05:00:01.000Z"
      }
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
