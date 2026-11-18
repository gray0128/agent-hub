PRAGMA foreign_keys = ON;

ALTER TABLE nodes
  ADD COLUMN default_notify_events_json TEXT NOT NULL
  DEFAULT '["run_needs_approval","run_failed","run_done","run_cancelled","native_interaction_needed","native_turn_summary","native_progress"]';

CREATE INDEX IF NOT EXISTS idx_deliveries_channel_sent
  ON notification_deliveries (source_kind, channel_kind, channel_id, sent_at DESC)
  WHERE status = 'sent';
