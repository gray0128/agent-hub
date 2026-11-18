-- Allow 'grok' in native_events.agent CHECK constraint (D1-safe table rebuild)
CREATE TABLE native_events_new (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  agent TEXT NOT NULL CHECK (agent IN ('agy', 'pi', 'omp', 'codex', 'claude', 'grok')),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('interaction_needed', 'turn_summary')),
  native_session_id TEXT NOT NULL DEFAULT '',
  workdir TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  notify_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  notify_status TEXT NOT NULL DEFAULT 'none'
    CHECK (notify_status IN ('none', 'queued', 'sent', 'failed', 'skipped')),
  notify_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (node_id, event_id)
);

INSERT INTO native_events_new (
  id,
  node_id,
  event_id,
  agent,
  event_kind,
  native_session_id,
  workdir,
  title,
  summary,
  source,
  notify_key_id,
  notify_status,
  notify_error,
  created_at,
  updated_at
)
SELECT
  id,
  node_id,
  event_id,
  agent,
  event_kind,
  native_session_id,
  workdir,
  title,
  summary,
  source,
  notify_key_id,
  notify_status,
  notify_error,
  created_at,
  updated_at
FROM native_events;

DROP TABLE native_events;

ALTER TABLE native_events_new RENAME TO native_events;

CREATE INDEX IF NOT EXISTS idx_native_events_node_created
  ON native_events (node_id, created_at DESC);
