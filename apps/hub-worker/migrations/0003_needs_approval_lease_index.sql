-- Include needs_approval in active lease index so Cron reapExpiredLeases uses index scan without orphans
DROP INDEX IF EXISTS idx_runs_active_lease;

CREATE INDEX IF NOT EXISTS idx_runs_active_lease
  ON runs (status, lease_expires_at)
  WHERE status IN ('claimed', 'running', 'needs_approval');
