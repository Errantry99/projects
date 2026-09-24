-- dcx journal schema v1 (SQLite, WAL, synchronous=NORMAL). 07 §2 and §4.2; 03 §3.2, §3.5.
-- Timestamps are INTEGER epoch milliseconds. JSON columns hold JSON text.
-- Applied by migrate.ts (`migrateSqlite`), which records version 1 in schema_migrations.

CREATE TABLE IF NOT EXISTS runs (
  run_id       TEXT PRIMARY KEY,
  workflow     TEXT NOT NULL,
  workflow_v   INTEGER NOT NULL,
  mode         TEXT NOT NULL DEFAULT 'active' CHECK (mode IN ('active','shadow','canary','audit')),
  status       TEXT NOT NULL,
  input_ref    TEXT,
  executor_id  TEXT,
  lease_until  INTEGER,
  heartbeat_at INTEGER,
  created_at   INTEGER NOT NULL,
  ended_at     INTEGER
);
CREATE INDEX IF NOT EXISTS runs_status_lease ON runs (status, lease_until);

-- Insert-if-absent on (run_id, step_no): the durable-execution journal (DBOS operation_outputs).
CREATE TABLE IF NOT EXISTS steps (
  run_id          TEXT NOT NULL,
  step_no         INTEGER NOT NULL,
  parent_step_no  INTEGER,
  kind            TEXT NOT NULL
                  CHECK (kind IN ('sql','rule','retrieve','judge','llm','tool','human','route')),
  name            TEXT NOT NULL,
  status          TEXT NOT NULL,
  attempt         INTEGER NOT NULL DEFAULT 1,
  mode            TEXT NOT NULL CHECK (mode IN ('active','shadow','canary','audit')),
  input_ref       TEXT,
  output          TEXT,
  error           TEXT,
  idempotency_key TEXT,
  started_at      INTEGER,
  ended_at        INTEGER,
  PRIMARY KEY (run_id, step_no)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  run_id           TEXT NOT NULL,
  step_no          INTEGER NOT NULL,
  tool             TEXT NOT NULL,
  tool_schema_hash TEXT,
  args_canonical   TEXT NOT NULL,
  args_hash        TEXT NOT NULL,
  effect_class     TEXT,
  idempotency_key  TEXT,
  in_doubt         INTEGER NOT NULL DEFAULT 0 CHECK (in_doubt IN (0, 1)),
  result_ref       TEXT,
  PRIMARY KEY (run_id, step_no)
);
CREATE INDEX IF NOT EXISTS tool_calls_idem ON tool_calls (idempotency_key);

CREATE TABLE IF NOT EXISTS hitl_queue (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('review','promotion')),
  run_id             TEXT,
  step_no            INTEGER,
  decision_point_id  TEXT,
  question_ref       TEXT,
  card               TEXT NOT NULL,
  tiers              TEXT,
  reason_code        TEXT,
  priority           INTEGER NOT NULL DEFAULT 0,
  deadline           INTEGER,
  default_on_timeout TEXT,
  claimed_by         TEXT,
  claimed_until      INTEGER,
  resolved_at        INTEGER,
  resolution         TEXT,
  resolver           TEXT,
  notes              TEXT,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hitl_open ON hitl_queue (resolved_at, priority DESC, deadline);
CREATE INDEX IF NOT EXISTS hitl_run_step ON hitl_queue (run_id, step_no);

-- Rows bound for DuckDB tables; the exporter drains them (exported_at). H5 defence in depth:
-- a label row whose source names Jev/TypeSafe cannot even enter the outbox.
CREATE TABLE IF NOT EXISTS outbox (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_table TEXT NOT NULL,
  row          TEXT NOT NULL CHECK (json_valid(row)),
  created_at   INTEGER NOT NULL,
  exported_at  INTEGER,
  CHECK (target_table <> 'labels' OR (
    json_extract(row, '$.source') IS NOT NULL
    AND lower(json_extract(row, '$.source')) NOT LIKE '%jev%'
    AND lower(json_extract(row, '$.source')) NOT LIKE '%typesafe%'
    AND (json_extract(row, '$.source') IN ('human', 'behaviour')
         OR (substr(json_extract(row, '$.source'), 1, 4) = 'llm:'
             AND length(json_extract(row, '$.source')) > 4)
         OR (substr(json_extract(row, '$.source'), 1, 5) = 'rule:'
             AND length(json_extract(row, '$.source')) > 5))))
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (exported_at, seq);
