PRAGMA foreign_keys = ON;

-- 1. 重建 native_events：扩展 event_kind 支持 'progress'，新增人工确认时间 ack_at 与多通道聚合状态 'partial'
CREATE TABLE native_events_v2 (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  agent TEXT NOT NULL CHECK (agent IN ('agy', 'pi', 'omp', 'codex', 'claude', 'grok')),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('interaction_needed', 'turn_summary', 'progress')),
  native_session_id TEXT NOT NULL DEFAULT '',
  workdir TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  notify_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  notify_status TEXT NOT NULL DEFAULT 'none'
    CHECK (notify_status IN ('none', 'queued', 'sent', 'partial', 'failed', 'skipped')),
  notify_error TEXT NOT NULL DEFAULT '',
  ack_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (node_id, event_id)
);

INSERT INTO native_events_v2 (
  id, node_id, event_id, agent, event_kind, native_session_id, workdir,
  title, summary, source, notify_key_id, notify_status, notify_error,
  ack_at, created_at, updated_at
)
SELECT
  id, node_id, event_id, agent, event_kind, native_session_id, workdir,
  title, summary, source, notify_key_id, notify_status, notify_error,
  NULL, created_at, updated_at
FROM native_events;

DROP TABLE native_events;
ALTER TABLE native_events_v2 RENAME TO native_events;

CREATE INDEX IF NOT EXISTS idx_native_events_created
  ON native_events (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_native_events_node_created
  ON native_events (node_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_native_events_session
  ON native_events (node_id, agent, native_session_id, created_at DESC)
  WHERE native_session_id != '';

-- 2. 浏览器 Web Push 订阅注册表（仅限 admin 作用域管理，端点与 ECDH 密钥经 AES-256-GCM 密文落库）
CREATE TABLE IF NOT EXISTS web_push_subscriptions (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  endpoint_sha256 TEXT NOT NULL UNIQUE,
  endpoint_host TEXT NOT NULL,
  subscription_ciphertext TEXT NOT NULL,
  node_filter_json TEXT NOT NULL DEFAULT '[]',
  event_filter_json TEXT NOT NULL DEFAULT '["run_needs_approval","run_failed","native_interaction_needed"]',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_sent_at TEXT,
  last_error_code TEXT NOT NULL DEFAULT '',
  last_error_message TEXT NOT NULL DEFAULT '',
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_web_push_active
  ON web_push_subscriptions (enabled)
  WHERE revoked_at IS NULL AND enabled = 1;

-- 3. 统一多渠道通知投递明细账本（覆盖受控 Run 与原生活动 NativeEvent）
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('run', 'native_event')),
  source_id TEXT NOT NULL,
  trigger_event TEXT NOT NULL,
  node_id TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_deliveries_source
  ON notification_deliveries (source_kind, source_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_deliveries_status_updated
  ON notification_deliveries (status, updated_at DESC)
  WHERE status IN ('queued', 'failed');
