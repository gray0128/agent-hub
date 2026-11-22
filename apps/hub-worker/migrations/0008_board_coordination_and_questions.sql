PRAGMA foreign_keys = ON;

-- 1. 扩展 api_keys：支持 client Key 按频道前缀做 Fail-Closed 协同板授权（默认空数组表示拒绝访问协同板）
ALTER TABLE api_keys
  ADD COLUMN allowed_board_prefixes_json TEXT NOT NULL DEFAULT '[]';

-- 2. 跨机共享协同主题表（5 态生命周期 + 排序键）
CREATE TABLE IF NOT EXISTS board_topics (
  id TEXT PRIMARY KEY,                              -- top_<ulid>
  channel TEXT NOT NULL,                            -- 路径式频道，如 proj/demo、ops/fleet（^[a-z0-9][a-z0-9_-]*(/[a-z0-9][a-z0-9_-]*)*$，1..64 字符）
  title TEXT NOT NULL,
  external_ref TEXT NOT NULL DEFAULT '',            -- 可选外部工单锚点，如 cnb:org/demo#123
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo', 'in_progress', 'blocked', 'done', 'archived')),
  previous_status TEXT NOT NULL DEFAULT ''
    CHECK (previous_status IN ('', 'todo', 'in_progress')),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  sort_order REAL NOT NULL DEFAULT 0,               -- 供 Slice 1a /reorder 与 Slice 1b 看板拖拽排序（IEEE 754 中点插值）
  labels_json TEXT NOT NULL DEFAULT '{}',
  created_by_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  last_message_id TEXT NOT NULL DEFAULT '',
  last_handoff_message_id TEXT NOT NULL DEFAULT '', -- 指向最新一条 handoff 消息，供右栏交接快照零扫描读取
  last_event_cursor INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_board_topics_channel_ref
  ON board_topics (channel, external_ref)
  WHERE external_ref != '';

CREATE INDEX IF NOT EXISTS idx_board_topics_channel_status_order
  ON board_topics (channel, status, pinned DESC, sort_order ASC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_board_topics_recent
  ON board_topics (updated_at DESC)
  WHERE status != 'archived';

-- 3. 协同消息与双向问答表
CREATE TABLE IF NOT EXISTS board_messages (
  id TEXT PRIMARY KEY,                              -- msg_<ulid>
  topic_id TEXT NOT NULL REFERENCES board_topics(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('note', 'handoff', 'question', 'answer', 'artifact')),
  reply_to_id TEXT REFERENCES board_messages(id) ON DELETE SET NULL,
  actor_scope TEXT NOT NULL CHECK (actor_scope IN ('admin', 'client')),
  actor_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  actor_profile TEXT NOT NULL DEFAULT '',           -- 如 codex-reviewer、agy-worker（^[a-z0-9][a-z0-9._@-]{0,39}$）
  source_node TEXT NOT NULL DEFAULT '',             -- 可选来源节点短名，如 macmini / mbp / linux-dev
  text_md TEXT NOT NULL DEFAULT '',                 -- 经双端对称脱敏，<= 8192 字符
  data_json TEXT NOT NULL DEFAULT '{}',             -- 结构化交接或选项元数据，经脱敏，<= 32768 UTF-8 字节
  idempotency_key TEXT UNIQUE,
  question_state TEXT NOT NULL DEFAULT ''
    CHECK (question_state IN ('', 'open', 'answered', 'expired', 'cancelled')),
  question_options_json TEXT NOT NULL DEFAULT '[]', -- 建议选项字符串数组，<= 8 项
  question_expires_at TEXT,                         -- 默认创建后 24h（允许 10m..72h），由 Cron 巡检过期
  answered_message_id TEXT REFERENCES board_messages(id) ON DELETE SET NULL,
  answered_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (topic_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_board_messages_topic_seq
  ON board_messages (topic_id, seq ASC);

CREATE INDEX IF NOT EXISTS idx_board_messages_open_questions
  ON board_messages (question_state, question_expires_at)
  WHERE kind = 'question' AND question_state = 'open';

-- 4. 单调有序协同事件日志（提供 cursor 续读与 WS 断线防漏回放）
CREATE TABLE IF NOT EXISTS board_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  topic_id TEXT NOT NULL REFERENCES board_topics(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES board_messages(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'topic.created', 'topic.updated', 'message.posted',
    'question.opened', 'question.answered', 'question.expired', 'question.cancelled'
  )),
  actor_profile TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_board_events_channel_cursor
  ON board_events (channel, cursor ASC);

CREATE INDEX IF NOT EXISTS idx_board_events_topic_cursor
  ON board_events (topic_id, cursor ASC);

-- 5. 重建 notification_deliveries：扩展 source_kind 支持 'board_message'，并显式重建 0006 + 0007 全部 3 个索引
CREATE TABLE notification_deliveries_v2 (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('run', 'native_event', 'board_message')),
  source_id TEXT NOT NULL,                          -- run_<ulid> / evt_<ulid> / msg_<ulid>
  trigger_event TEXT NOT NULL,                      -- 新增 'question_opened'
  node_id TEXT NOT NULL,                            -- board_message 无节点时写入 'board'（source_node || 'board'）
  channel_kind TEXT NOT NULL CHECK (channel_kind IN ('bot_webhook', 'web_push', 'legacy_webhook')),
  channel_id TEXT NOT NULL,
  channel_label TEXT NOT NULL,
  target_host TEXT NOT NULL,
  route_mode TEXT NOT NULL DEFAULT 'node_default'
    CHECK (route_mode IN ('key', 'node_default', 'web_push', 'global_legacy')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  http_status INTEGER,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_kind, source_id, trigger_event, channel_kind, channel_id)
);

INSERT INTO notification_deliveries_v2 (
  id, source_kind, source_id, trigger_event, node_id, channel_kind, channel_id,
  channel_label, target_host, route_mode, status, attempts, http_status,
  error_code, error_message, sent_at, created_at, updated_at
)
SELECT
  id, source_kind, source_id, trigger_event, node_id, channel_kind, channel_id,
  channel_label, target_host, route_mode, status, attempts, http_status,
  error_code, error_message, sent_at, created_at, updated_at
FROM notification_deliveries;

DROP TABLE notification_deliveries;
ALTER TABLE notification_deliveries_v2 RENAME TO notification_deliveries;

CREATE INDEX IF NOT EXISTS idx_deliveries_source
  ON notification_deliveries (source_kind, source_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_deliveries_status_updated
  ON notification_deliveries (status, updated_at DESC)
  WHERE status IN ('queued', 'failed');

CREATE INDEX IF NOT EXISTS idx_deliveries_channel_sent
  ON notification_deliveries (source_kind, channel_kind, channel_id, sent_at DESC)
  WHERE status = 'sent';

-- 6. 升级存量默认 Web Push 订阅过滤规则：仅对仍持有 0006 精确默认值的行追加 "board_question_opened"，保留用户自定义配置
UPDATE web_push_subscriptions
SET event_filter_json = '["run_needs_approval","run_failed","native_interaction_needed","board_question_opened"]'
WHERE event_filter_json = '["run_needs_approval","run_failed","native_interaction_needed"]';
