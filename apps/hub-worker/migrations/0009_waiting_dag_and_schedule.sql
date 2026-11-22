PRAGMA foreign_keys = OFF;
PRAGMA defer_foreign_keys = ON;

-- 1. 暂存并卸除依赖 runs(id) ON DELETE CASCADE 的 run_events，防止删表级联清空
CREATE TABLE run_events_backup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO run_events_backup (id, run_id, seq, kind, payload_json, created_at)
SELECT id, run_id, seq, kind, payload_json, created_at
FROM run_events;

DROP TABLE run_events;

-- 2. 按 Slice 2 8 态与扩展列重建 runs 表
CREATE TABLE runs_v2 (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  root_run_id TEXT NOT NULL,
  parent_run_id TEXT REFERENCES runs_v2(id),
  depth INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0),
  max_depth INTEGER NOT NULL DEFAULT 1 CHECK (max_depth >= 0 AND max_depth <= 3),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  workdir TEXT NOT NULL,
  agent TEXT NOT NULL CHECK (agent IN ('agy', 'pi', 'omp', 'codex', 'claude')),
  model TEXT NOT NULL DEFAULT '',
  effort TEXT NOT NULL DEFAULT '',
  sandbox INTEGER NOT NULL DEFAULT 1 CHECK (sandbox IN (0, 1)),
  timeout_sec INTEGER NOT NULL DEFAULT 900 CHECK (timeout_sec >= 10 AND timeout_sec <= 7200),
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('waiting', 'queued', 'claimed', 'running', 'needs_approval', 'done', 'failed', 'cancelled')),
  priority_order REAL NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,
  created_by_key_id TEXT REFERENCES api_keys(id),
  lease_owner TEXT,
  lease_expires_at TEXT,
  resolved_model TEXT NOT NULL DEFAULT '',
  resolved_effort TEXT NOT NULL DEFAULT '',
  native_session_id TEXT,
  remote_control_url TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  output_md TEXT NOT NULL DEFAULT '',
  output_bytes INTEGER NOT NULL DEFAULT 0 CHECK (output_bytes >= 0),
  artifact_r2_key TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  notify_policy_json TEXT NOT NULL DEFAULT '{}',
  notify_status TEXT NOT NULL DEFAULT 'none'
    CHECK (notify_status IN ('none', 'queued', 'sent', 'failed')),
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  plan_id TEXT,
  plan_key TEXT,
  scheduled_at TEXT,
  retry_of_run_id TEXT REFERENCES runs_v2(id) ON DELETE SET NULL,
  actor_profile TEXT NOT NULL DEFAULT '',
  board_topic_id TEXT REFERENCES board_topics(id) ON DELETE SET NULL
);

INSERT INTO runs_v2 (
  id, thread_id, root_run_id, parent_run_id, depth, max_depth,
  node_id, workdir, agent, model, effort, sandbox, timeout_sec,
  prompt, status, priority_order, idempotency_key, created_by_key_id,
  lease_owner, lease_expires_at, resolved_model, resolved_effort,
  native_session_id, remote_control_url, summary, output_md, output_bytes,
  artifact_r2_key, error_code, error_message, notify_policy_json, notify_status,
  started_at, finished_at, duration_ms, created_at, updated_at,
  plan_id, plan_key, scheduled_at, retry_of_run_id, actor_profile, board_topic_id
)
SELECT
  id, thread_id, root_run_id, parent_run_id, depth, max_depth,
  node_id, workdir, agent, model, effort, sandbox, timeout_sec,
  prompt, status, priority_order, idempotency_key, created_by_key_id,
  lease_owner, lease_expires_at, resolved_model, resolved_effort,
  native_session_id, remote_control_url, summary, output_md, output_bytes,
  artifact_r2_key, error_code, error_message, notify_policy_json, notify_status,
  started_at, finished_at, duration_ms, created_at, updated_at,
  NULL, NULL, NULL, NULL, '', NULL
FROM runs;

DROP TABLE runs;
ALTER TABLE runs_v2 RENAME TO runs;

-- 3. 恢复 run_events 并重建外键约束
CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  kind TEXT NOT NULL
    CHECK (kind IN ('status', 'tool_use', 'turn_end', 'approval_needed', 'stderr_warn', 'system')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, seq)
);

INSERT INTO run_events (id, run_id, seq, kind, payload_json, created_at)
SELECT id, run_id, seq, kind, payload_json, created_at
FROM run_events_backup;

DROP TABLE run_events_backup;

-- 4. 完整重建 runs 既有 4 个索引 + 新增 Slice 2 调度/计划/协同索引
CREATE INDEX IF NOT EXISTS idx_runs_node_status_priority
  ON runs (node_id, status, priority_order ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_runs_thread_created
  ON runs (thread_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_runs_root
  ON runs (root_run_id);

CREATE INDEX IF NOT EXISTS idx_runs_active_lease
  ON runs (status, lease_expires_at)
  WHERE status IN ('claimed', 'running', 'needs_approval');

CREATE INDEX IF NOT EXISTS idx_runs_waiting_schedule
  ON runs (scheduled_at ASC)
  WHERE status = 'waiting' AND scheduled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_runs_plan
  ON runs (plan_id)
  WHERE plan_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_runs_board_topic
  ON runs (board_topic_id)
  WHERE board_topic_id IS NOT NULL;

-- 5. 新增有向无环依赖边表 run_dependencies
CREATE TABLE IF NOT EXISTS run_dependencies (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  depends_on_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, depends_on_run_id),
  CHECK (run_id != depends_on_run_id)
);

CREATE INDEX IF NOT EXISTS idx_run_dependencies_dep
  ON run_dependencies (depends_on_run_id, run_id);

PRAGMA foreign_keys = ON;
