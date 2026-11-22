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
  "board.schema.json",
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
  },
  {
    name: "board valid BoardChannelSummary (def + oneOf)",
    schema: "board.schema.json",
    def: "BoardChannelSummary",
    valid: true,
    payload: {
      channel: "proj/demo",
      active_topic_count: 3,
      open_question_count: 1,
      total_topic_count: 4,
      updated_at: "2026-11-22T03:00:00.000Z"
    }
  },
  {
    name: "board valid BoardTopic (root oneOf)",
    schema: "board.schema.json",
    valid: true,
    payload: {
      id: "top_01JABCDEF123456789",
      channel: "proj/demo",
      title: "Fix RFC-0001 Slice 1a contracts",
      external_ref: "cnb:org/demo#123",
      status: "blocked",
      previous_status: "in_progress",
      pinned: true,
      sort_order: 100.5,
      labels: { area: "api", priority: "p0" },
      created_by_key_id: "key_01JABCDEF123456789",
      last_message_id: "msg_01JABCDEF123456789",
      last_handoff_message_id: "",
      last_event_cursor: 42,
      open_question_count: 1,
      message_count: 2,
      latest_handoff: null,
      created_at: "2026-11-22T03:00:00.000Z",
      updated_at: "2026-11-22T03:05:00.000Z"
    }
  },
  {
    name: "board invalid BoardTopic previous_status blocked",
    schema: "board.schema.json",
    def: "BoardTopic",
    valid: false,
    payload: {
      id: "top_01JABCDEF123456789",
      channel: "proj/demo",
      title: "Bad previous_status",
      external_ref: "",
      status: "blocked",
      previous_status: "blocked",
      pinned: false,
      sort_order: 0,
      labels: {},
      created_by_key_id: null,
      last_message_id: "",
      last_handoff_message_id: "",
      last_event_cursor: 0,
      created_at: "2026-11-22T03:00:00.000Z",
      updated_at: "2026-11-22T03:00:00.000Z"
    }
  },
  {
    name: "board valid BoardMessage question (root oneOf)",
    schema: "board.schema.json",
    valid: true,
    payload: {
      id: "msg_01JABCDEF123456789",
      topic_id: "top_01JABCDEF123456789",
      channel: "proj/demo",
      seq: 2,
      kind: "question",
      reply_to_id: null,
      actor_scope: "client",
      actor_key_id: "key_01JABCDEF123456789",
      actor_profile: "agy-worker@linux-dev",
      source_node: "linux-dev",
      text_md: "Proceed with Option A or Option B?",
      data: { branch: "feat/slice-1a" },
      question_state: "open",
      question_options: ["Option A", "Option B"],
      question_expires_at: "2026-11-23T03:05:00.000Z",
      answered_message_id: null,
      answered_at: null,
      deliveries_summary: { total: 1, sent: 1, queued: 0, failed: 0 },
      created_at: "2026-11-22T03:05:00.000Z"
    }
  },
  {
    name: "board valid BoardEvent (root oneOf)",
    schema: "board.schema.json",
    valid: true,
    payload: {
      cursor: 42,
      channel: "proj/demo",
      topic_id: "top_01JABCDEF123456789",
      message_id: null,
      event_type: "topic.created",
      actor_profile: "",
      created_at: "2026-11-22T03:00:00.000Z"
    }
  },
  {
    name: "board valid CreateBoardTopicRequest (root oneOf)",
    schema: "board.schema.json",
    valid: true,
    payload: {
      channel: "proj/demo",
      title: "Issue #123",
      external_ref: "cnb:org/demo#123",
      upsert: true
    }
  },
  {
    name: "board invalid CreateBoardTopicRequest uppercase channel",
    schema: "board.schema.json",
    def: "CreateBoardTopicRequest",
    valid: false,
    payload: {
      channel: "Proj/Bad",
      title: "Invalid channel"
    }
  },
  {
    name: "board invalid CreateBoardTopicRequest empty segment channel",
    schema: "board.schema.json",
    def: "CreateBoardTopicRequest",
    valid: false,
    payload: {
      channel: "proj//bad",
      title: "Empty segment channel"
    }
  },
  {
    name: "board invalid CreateBoardTopicRequest trailing slash channel",
    schema: "board.schema.json",
    def: "CreateBoardTopicRequest",
    valid: false,
    payload: {
      channel: "proj/",
      title: "Trailing slash channel"
    }
  },
  {
    name: "board invalid CreateBoardTopicRequest leading slash channel",
    schema: "board.schema.json",
    def: "CreateBoardTopicRequest",
    valid: false,
    payload: {
      channel: "/proj",
      title: "Leading slash channel"
    }
  },
  {
    name: "board invalid CreateBoardTopicRequest > 64 char channel",
    schema: "board.schema.json",
    def: "CreateBoardTopicRequest",
    valid: false,
    payload: {
      channel: "a".repeat(65),
      title: "Too long channel"
    }
  },
  {
    name: "board valid PatchBoardTopicRequest (root oneOf)",
    schema: "board.schema.json",
    valid: true,
    payload: {
      status: "done",
      pinned: false
    }
  },
  {
    name: "board invalid PatchBoardTopicRequest empty object",
    schema: "board.schema.json",
    def: "PatchBoardTopicRequest",
    valid: false,
    payload: {}
  },
  {
    name: "board valid ReorderBoardTopicsRequest (root oneOf)",
    schema: "board.schema.json",
    valid: true,
    payload: {
      channel: "proj/demo",
      status: "in_progress",
      ordered_topic_ids: ["top_01JABCDEF123456789", "top_01JABCDEF123456790"]
    }
  },
  {
    name: "board invalid ReorderBoardTopicsRequest duplicate topic ids",
    schema: "board.schema.json",
    def: "ReorderBoardTopicsRequest",
    valid: false,
    payload: {
      channel: "proj/demo",
      status: "in_progress",
      ordered_topic_ids: ["top_01JABCDEF123456789", "top_01JABCDEF123456789"]
    }
  },
  {
    name: "board valid CreateBoardMessageRequest handoff (root oneOf)",
    schema: "board.schema.json",
    valid: true,
    payload: {
      kind: "handoff",
      text_md: "Ready for verification on linux-dev.",
      data: { branch: "feat/123", commit_sha: "a1b2c3d" },
      actor_profile: "codex-reviewer",
      source_node: "mbp",
      topic_status: "in_progress",
      idempotency_key: "idem-board-handoff-01"
    }
  },
  {
    name: "board valid CreateBoardMessageRequest question with options & expires_sec",
    schema: "board.schema.json",
    def: "CreateBoardMessageRequest",
    valid: true,
    payload: {
      kind: "question",
      text_md: "Pick release strategy?",
      question_options: ["Canary first", "Full rollout"],
      question_expires_sec: 86400
    }
  },
  {
    name: "board invalid CreateBoardMessageRequest kind answer",
    schema: "board.schema.json",
    def: "CreateBoardMessageRequest",
    valid: false,
    payload: {
      kind: "answer",
      text_md: "Should only be created via /answer"
    }
  },
  {
    name: "board invalid CreateBoardMessageRequest text_md > 8192",
    schema: "board.schema.json",
    def: "CreateBoardMessageRequest",
    valid: false,
    payload: {
      kind: "note",
      text_md: "a".repeat(8193)
    }
  },
  {
    name: "board invalid CreateBoardMessageRequest > 8 question_options",
    schema: "board.schema.json",
    def: "CreateBoardMessageRequest",
    valid: false,
    payload: {
      kind: "question",
      text_md: "Too many options",
      question_options: ["1", "2", "3", "4", "5", "6", "7", "8", "9"]
    }
  },
  {
    name: "board invalid CreateBoardMessageRequest bad actor_profile",
    schema: "board.schema.json",
    def: "CreateBoardMessageRequest",
    valid: false,
    payload: {
      kind: "note",
      text_md: "Hello",
      actor_profile: "INVALID!"
    }
  },
  {
    name: "board valid AnswerBoardQuestionRequest option-only (root oneOf)",
    schema: "board.schema.json",
    valid: true,
    payload: {
      selected_option: "Option A",
      actor_profile: "admin-web"
    }
  },
  {
    name: "board invalid AnswerBoardQuestionRequest empty object",
    schema: "board.schema.json",
    def: "AnswerBoardQuestionRequest",
    valid: false,
    payload: {}
  },
  {
    name: "board valid BoardTopicResponse (root oneOf)",
    schema: "board.schema.json",
    valid: true,
    payload: {
      ok: true,
      created: true,
      topic: {
        id: "top_01JABCDEF123456789",
        channel: "proj/demo",
        title: "Demo topic",
        external_ref: "",
        status: "todo",
        previous_status: "",
        pinned: false,
        sort_order: 0,
        labels: {},
        created_by_key_id: null,
        last_message_id: "",
        last_handoff_message_id: "",
        last_event_cursor: 1,
        created_at: "2026-11-22T03:00:00.000Z",
        updated_at: "2026-11-22T03:00:00.000Z"
      }
    }
  },
  {
    name: "board valid BoardMessagePostResponse (root oneOf)",
    schema: "board.schema.json",
    valid: true,
    payload: {
      ok: true,
      cursor: 2,
      deduplicated: false,
      topic: {
        id: "top_01JABCDEF123456789",
        channel: "proj/demo",
        title: "Demo topic",
        external_ref: "",
        status: "in_progress",
        previous_status: "",
        pinned: false,
        sort_order: 0,
        labels: {},
        created_by_key_id: null,
        last_message_id: "msg_01JABCDEF123456789",
        last_handoff_message_id: "",
        last_event_cursor: 2,
        created_at: "2026-11-22T03:00:00.000Z",
        updated_at: "2026-11-22T03:01:00.000Z"
      },
      message: {
        id: "msg_01JABCDEF123456789",
        topic_id: "top_01JABCDEF123456789",
        channel: "proj/demo",
        seq: 1,
        kind: "note",
        reply_to_id: null,
        actor_scope: "admin",
        actor_key_id: null,
        actor_profile: "",
        source_node: "",
        text_md: "Started work.",
        data: {},
        question_state: "",
        question_options: [],
        question_expires_at: null,
        answered_message_id: null,
        answered_at: null,
        created_at: "2026-11-22T03:01:00.000Z"
      }
    }
  },
  {
    name: "board valid AnswerBoardQuestionResponse (root oneOf)",
    schema: "board.schema.json",
    valid: true,
    payload: {
      ok: true,
      cursor: 5,
      topic: {
        id: "top_01JABCDEF123456789",
        channel: "proj/demo",
        title: "Demo topic",
        external_ref: "",
        status: "in_progress",
        previous_status: "",
        pinned: false,
        sort_order: 0,
        labels: {},
        created_by_key_id: null,
        last_message_id: "msg_01JABCDEF123456791",
        last_handoff_message_id: "",
        last_event_cursor: 5,
        created_at: "2026-11-22T03:00:00.000Z",
        updated_at: "2026-11-22T03:06:00.000Z"
      },
      question: {
        id: "msg_01JABCDEF123456790",
        topic_id: "top_01JABCDEF123456789",
        channel: "proj/demo",
        seq: 2,
        kind: "question",
        reply_to_id: null,
        actor_scope: "client",
        actor_key_id: "key_01JABCDEF123456789",
        actor_profile: "agy@linux-dev",
        source_node: "linux-dev",
        text_md: "Proceed?",
        data: {},
        question_state: "answered",
        question_options: ["Yes", "No"],
        question_expires_at: "2026-11-23T03:05:00.000Z",
        answered_message_id: "msg_01JABCDEF123456791",
        answered_at: "2026-11-22T03:06:00.000Z",
        created_at: "2026-11-22T03:05:00.000Z"
      },
      answer: {
        id: "msg_01JABCDEF123456791",
        topic_id: "top_01JABCDEF123456789",
        channel: "proj/demo",
        seq: 3,
        kind: "answer",
        reply_to_id: "msg_01JABCDEF123456790",
        actor_scope: "admin",
        actor_key_id: null,
        actor_profile: "admin-web",
        source_node: "",
        text_md: "Yes",
        data: { selected_option: "Yes" },
        question_state: "",
        question_options: [],
        question_expires_at: null,
        answered_message_id: null,
        answered_at: null,
        created_at: "2026-11-22T03:06:00.000Z"
      }
    }
  },
  {
    name: "board valid BoardChannelsResponse (root oneOf)",
    schema: "board.schema.json",
    valid: true,
    payload: {
      ok: true,
      channels: [
        {
          channel: "proj/demo",
          active_topic_count: 3,
          open_question_count: 1
        }
      ]
    }
  },
  {
    name: "board valid BoardTopicsResponse (root oneOf)",
    schema: "board.schema.json",
    valid: true,
    payload: {
      ok: true,
      topics: [
        {
          id: "top_01JABCDEF123456789",
          channel: "proj/demo",
          title: "Demo topic",
          external_ref: "",
          status: "todo",
          previous_status: "",
          pinned: false,
          sort_order: 0,
          labels: {},
          created_by_key_id: null,
          last_message_id: "",
          last_handoff_message_id: "",
          last_event_cursor: 1,
          created_at: "2026-11-22T03:00:00.000Z",
          updated_at: "2026-11-22T03:00:00.000Z"
        }
      ]
    }
  },
  {
    name: "board valid BoardMessagesResponse (root oneOf)",
    schema: "board.schema.json",
    valid: true,
    payload: {
      ok: true,
      cursor: 1,
      topic: {
        id: "top_01JABCDEF123456789",
        channel: "proj/demo",
        title: "Demo topic",
        external_ref: "",
        status: "todo",
        previous_status: "",
        pinned: false,
        sort_order: 0,
        labels: {},
        created_by_key_id: null,
        last_message_id: "",
        last_handoff_message_id: "",
        last_event_cursor: 1,
        created_at: "2026-11-22T03:00:00.000Z",
        updated_at: "2026-11-22T03:00:00.000Z"
      },
      messages: []
    }
  },
  {
    name: "board valid BoardEventsResponse (root oneOf)",
    schema: "board.schema.json",
    valid: true,
    payload: {
      ok: true,
      next_cursor: 42,
      events: [
        {
          cursor: 42,
          channel: "proj/demo",
          topic_id: "top_01JABCDEF123456789",
          message_id: null,
          event_type: "topic.created",
          actor_profile: "",
          created_at: "2026-11-22T03:00:00.000Z"
        }
      ]
    }
  },
  {
    name: "board valid ErrorEnvelope with next hints (root oneOf)",
    schema: "board.schema.json",
    valid: true,
    payload: {
      ok: false,
      error: {
        code: "FORBIDDEN_SCOPE",
        message: "Client key cannot access channel 'ops/prod'.",
        next: ["ahub board read proj/demo --json"]
      }
    }
  },
  {
    name: "board invalid ErrorEnvelope unknown code",
    schema: "board.schema.json",
    def: "ErrorEnvelope",
    valid: false,
    payload: {
      ok: false,
      error: {
        code: "UNKNOWN_CODE",
        message: "Bad code"
      }
    }
  },
  {
    name: "ws-frames valid snapshot with open_board_question_count and topic",
    schema: "ws-frames.schema.json",
    valid: true,
    payload: {
      type: "snapshot",
      nodes: [],
      open_board_question_count: 2,
      topic: {
        id: "top_01JABCDEF123456789",
        channel: "proj/demo",
        title: "Topic stream snapshot",
        external_ref: "",
        status: "blocked",
        previous_status: "in_progress",
        pinned: false,
        sort_order: 0,
        labels: {},
        created_by_key_id: null,
        last_message_id: "",
        last_handoff_message_id: "",
        last_event_cursor: 1,
        created_at: "2026-11-22T03:00:00.000Z",
        updated_at: "2026-11-22T03:00:00.000Z"
      },
      ts: "2026-11-22T03:00:00.000Z"
    }
  },
  {
    name: "ws-frames invalid snapshot negative open_board_question_count",
    schema: "ws-frames.schema.json",
    valid: false,
    payload: {
      type: "snapshot",
      nodes: [],
      open_board_question_count: -1,
      ts: "2026-11-22T03:00:00.000Z"
    }
  },
  {
    name: "ws-frames valid board.topic_updated",
    schema: "ws-frames.schema.json",
    valid: true,
    payload: {
      type: "board.topic_updated",
      cursor: 10,
      open_board_question_count: 1,
      topic: {
        id: "top_01JABCDEF123456789",
        channel: "proj/demo",
        title: "Demo topic",
        external_ref: "cnb:org/demo#123",
        status: "blocked",
        previous_status: "in_progress",
        pinned: false,
        sort_order: 0,
        labels: {},
        created_by_key_id: null,
        last_message_id: "msg_01JABCDEF123456789",
        last_handoff_message_id: "",
        last_event_cursor: 10,
        created_at: "2026-11-22T03:00:00.000Z",
        updated_at: "2026-11-22T03:05:00.000Z"
      }
    }
  },
  {
    name: "ws-frames invalid board.topic_updated trailing slash channel",
    schema: "ws-frames.schema.json",
    valid: false,
    payload: {
      type: "board.topic_updated",
      cursor: 10,
      topic: {
        id: "top_01JABCDEF123456789",
        channel: "proj/",
        title: "Bad trailing slash",
        external_ref: "",
        status: "todo",
        previous_status: "",
        pinned: false,
        sort_order: 0,
        labels: {},
        created_by_key_id: null,
        last_message_id: "",
        last_handoff_message_id: "",
        last_event_cursor: 10,
        created_at: "2026-11-22T03:00:00.000Z",
        updated_at: "2026-11-22T03:05:00.000Z"
      }
    }
  },
  {
    name: "ws-frames valid board.message_created",
    schema: "ws-frames.schema.json",
    valid: true,
    payload: {
      type: "board.message_created",
      cursor: 11,
      message: {
        id: "msg_01JABCDEF123456789",
        topic_id: "top_01JABCDEF123456789",
        channel: "proj/demo",
        seq: 1,
        kind: "handoff",
        reply_to_id: null,
        actor_scope: "client",
        actor_key_id: "key_01JABCDEF123456789",
        actor_profile: "codex@mbp",
        source_node: "mbp",
        text_md: "Handoff note",
        data: { branch: "main" },
        question_state: "",
        question_options: [],
        question_expires_at: null,
        answered_message_id: null,
        answered_at: null,
        created_at: "2026-11-22T03:05:00.000Z"
      }
    }
  },
  {
    name: "ws-frames valid board.question_answered",
    schema: "ws-frames.schema.json",
    valid: true,
    payload: {
      type: "board.question_answered",
      cursor: 12,
      open_board_question_count: 0,
      question: {
        id: "msg_01JABCDEF123456790",
        topic_id: "top_01JABCDEF123456789",
        channel: "proj/demo",
        seq: 2,
        kind: "question",
        reply_to_id: null,
        actor_scope: "client",
        actor_key_id: "key_01JABCDEF123456789",
        actor_profile: "agy@linux-dev",
        source_node: "linux-dev",
        text_md: "Proceed?",
        data: {},
        question_state: "answered",
        question_options: ["Yes", "No"],
        question_expires_at: "2026-11-23T03:05:00.000Z",
        answered_message_id: "msg_01JABCDEF123456791",
        answered_at: "2026-11-22T03:06:00.000Z",
        created_at: "2026-11-22T03:05:00.000Z"
      },
      answer: {
        id: "msg_01JABCDEF123456791",
        topic_id: "top_01JABCDEF123456789",
        channel: "proj/demo",
        seq: 3,
        kind: "answer",
        reply_to_id: "msg_01JABCDEF123456790",
        actor_scope: "admin",
        actor_key_id: null,
        actor_profile: "admin-web",
        source_node: "",
        text_md: "Yes",
        data: {},
        question_state: "",
        question_options: [],
        question_expires_at: null,
        answered_message_id: null,
        answered_at: null,
        created_at: "2026-11-22T03:06:00.000Z"
      }
    }
  },
  {
    name: "ws-frames invalid board.question_answered cursor 0",
    schema: "ws-frames.schema.json",
    valid: false,
    payload: {
      type: "board.question_answered",
      cursor: 0,
      question: {
        id: "msg_01JABCDEF123456790",
        topic_id: "top_01JABCDEF123456789",
        channel: "proj/demo",
        seq: 2,
        kind: "question",
        reply_to_id: null,
        actor_scope: "client",
        actor_key_id: null,
        actor_profile: "",
        source_node: "",
        text_md: "Proceed?",
        data: {},
        question_state: "answered",
        question_options: [],
        question_expires_at: null,
        answered_message_id: null,
        answered_at: null,
        created_at: "2026-11-22T03:05:00.000Z"
      },
      answer: {
        id: "msg_01JABCDEF123456791",
        topic_id: "top_01JABCDEF123456789",
        channel: "proj/demo",
        seq: 3,
        kind: "answer",
        reply_to_id: "msg_01JABCDEF123456790",
        actor_scope: "admin",
        actor_key_id: null,
        actor_profile: "",
        source_node: "",
        text_md: "Yes",
        data: {},
        question_state: "",
        question_options: [],
        question_expires_at: null,
        answered_message_id: null,
        answered_at: null,
        created_at: "2026-11-22T03:06:00.000Z"
      }
    }
  },
  {
    name: "ws-frames valid delivery.updated board_message",
    schema: "ws-frames.schema.json",
    valid: true,
    payload: {
      type: "delivery.updated",
      delivery: {
        id: "dlv_01JABCDEF123456789",
        source_kind: "board_message",
        source_id: "msg_01JABCDEF123456789",
        trigger_event: "question_opened",
        node_id: "board",
        channel_kind: "web_push",
        channel_id: "wps_01JABCDEF123456789",
        channel_label: "iPhone PWA",
        target_host: "web.push.apple.com",
        route_mode: "web_push",
        status: "sent",
        attempts: 1,
        http_status: 201,
        error_code: "",
        error_message: "",
        sent_at: "2026-11-22T03:05:01.000Z",
        created_at: "2026-11-22T03:05:00.000Z",
        updated_at: "2026-11-22T03:05:01.000Z"
      }
    }
  },
  {
    name: "ws-frames invalid delivery.updated board_message empty node_id",
    schema: "ws-frames.schema.json",
    valid: false,
    payload: {
      type: "delivery.updated",
      delivery: {
        id: "dlv_01JABCDEF123456789",
        source_kind: "board_message",
        source_id: "msg_01JABCDEF123456789",
        trigger_event: "question_opened",
        node_id: "",
        channel_kind: "web_push",
        channel_id: "wps_01JABCDEF123456789",
        channel_label: "iPhone PWA",
        target_host: "web.push.apple.com",
        route_mode: "web_push",
        status: "queued",
        attempts: 0,
        http_status: null,
        error_code: "",
        error_message: "",
        sent_at: null,
        created_at: "2026-11-22T03:05:00.000Z",
        updated_at: "2026-11-22T03:05:00.000Z"
      }
    }
  }
];

let failures = 0;
for (const c of cases) {
  const validate = c.def
    ? ajv.getSchema(`https://ahub.bobocai.win/schemas/${c.schema}#/$defs/${c.def}`)
    : validators[c.schema];
  if (!validate) {
    failures++;
    console.error(`FAIL [${c.name}]: schema not found (${c.schema}${c.def ? `#/$defs/${c.def}` : ""})`);
    continue;
  }
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
