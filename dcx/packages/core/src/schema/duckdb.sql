-- dcx warehouse schema v1 (DuckDB 1.5.x). 07 §2 (consolidated tables), §4.2 (core DDL), §4.5
-- (trace contract); 01 §3.1; 02 §3.4; 03 §3.3; 04 §3.1.
-- Exactly one dcx process opens this file. Hashes are computed in TS (JCS + sha256), never here.
-- Applied by migrate.ts (`migrateDuckdb`), which records version 1 in schema_migrations.

-- ============================================================================================
-- Records, content, the question registry and projections
-- ============================================================================================

CREATE TABLE IF NOT EXISTS records (
  record_id   VARCHAR PRIMARY KEY,
  kind        VARCHAR NOT NULL,
  source      VARCHAR NOT NULL,
  state       JSON NOT NULL,
  state_hash  VARCHAR NOT NULL,              -- jsonHash(state)
  received_at TIMESTAMPTZ,
  ingested_at TIMESTAMPTZ DEFAULT current_timestamp
);

-- Exact projections sent, prompts and raw outputs (03 §3.3: content, not only hashes).
CREATE TABLE IF NOT EXISTS content (
  ref             VARCHAR PRIMARY KEY,
  body            JSON,
  pii_class       VARCHAR CHECK (pii_class IS NULL OR pii_class IN ('public','internal','pii','sensitive')),
  retention_until TIMESTAMPTZ
);

-- Rows are immutable; an edit is a new version. The cache keys on question_hash, not (id, v).
CREATE TABLE IF NOT EXISTS questions (
  question_id      VARCHAR NOT NULL,
  version          INTEGER NOT NULL,
  question_hash    VARCHAR NOT NULL,         -- hash.ts questionHash
  parent_hash      VARCHAR,
  qtype            VARCHAR NOT NULL CHECK (qtype IN ('choice','score','noul')),
  instructions     VARCHAR NOT NULL,
  options          JSON NOT NULL DEFAULT '[]', -- ordered [{label, description}]
  options_source   VARCHAR NOT NULL DEFAULT 'static' CHECK (options_source IN ('static','runtime')),
  no_match_label   VARCHAR,
  fields           VARCHAR[] NOT NULL,
  fields_key       VARCHAR NOT NULL,          -- hash.ts fieldsKey(fields); joins projections
  max_state_tokens INTEGER NOT NULL,
  data_class       VARCHAR NOT NULL DEFAULT 'internal'
                   CHECK (data_class IN ('public','internal','pii','sensitive')),
  negation_of      VARCHAR,
  label_compatible BOOLEAN NOT NULL DEFAULT false,
  status           VARCHAR NOT NULL DEFAULT 'proposed'
                   CHECK (status IN ('proposed','shadow','canary','active','demoted','retired')),
  owner            VARCHAR,
  applies_to       VARCHAR,                   -- records.kind; NULL = every kind (A §3.1)
  created_at       TIMESTAMPTZ DEFAULT current_timestamp,
  PRIMARY KEY (question_id, version)
);
CREATE INDEX IF NOT EXISTS questions_hash ON questions (question_hash);

-- TS-computed projections (project + JCS + sha256 cannot run in SQL). One row per record ×
-- distinct field list; stale when records.state_hash changes. Feeds the `asks` view.
CREATE TABLE IF NOT EXISTS projections (
  record_id    VARCHAR NOT NULL,
  fields_key   VARCHAR NOT NULL,
  state_hash   VARCHAR NOT NULL,
  payload_hash VARCHAR NOT NULL,
  payload      JSON NOT NULL,
  PRIMARY KEY (record_id, fields_key)
);
CREATE INDEX IF NOT EXISTS projections_payload ON projections (payload_hash);

-- ============================================================================================
-- Judge: calls, the judgments cache and uses (07 §2 rows 3–4, §4.2, §4.4)
-- ============================================================================================

CREATE TABLE IF NOT EXISTS judge_calls (
  call_id       UUID PRIMARY KEY DEFAULT uuid(),
  backend       VARCHAR NOT NULL,
  model_req     VARCHAR,
  model_v       VARCHAR NOT NULL,             -- returned model, never an alias
  request_id    VARCHAR,
  n_questions   INTEGER NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      DOUBLE,                       -- summed across retries (02 §3.8)
  cost_basis    VARCHAR NOT NULL
                CHECK (cost_basis IN ('provider-reported','token-price','gpu-amortised','zero')),
  latency_ms    INTEGER,
  attempts      SMALLINT NOT NULL DEFAULT 1,
  status        VARCHAR NOT NULL,
  degraded      BOOLEAN NOT NULL DEFAULT false,
  ts            TIMESTAMPTZ DEFAULT current_timestamp,
  CHECK (NOT regexp_matches(model_v, '(^|[-:@/])latest$', 'i'))
);

-- The immutable, content-addressed cache. The primary key IS the cache key (07 §2 row 4).
CREATE TABLE IF NOT EXISTS judgments (
  payload_hash       VARCHAR NOT NULL,
  question_hash      VARCHAR NOT NULL,
  candidate_set_hash VARCHAR NOT NULL DEFAULT '',
  backend            VARCHAR NOT NULL,
  model_v            VARCHAR NOT NULL,
  pack_mode          VARCHAR NOT NULL DEFAULT 'single',
  sample_no          SMALLINT NOT NULL DEFAULT 0,  -- >0 only for eval repeat samples
  question_id        VARCHAR,
  question_v         INTEGER,
  qtype              VARCHAR NOT NULL CHECK (qtype IN ('choice','score','noul')),
  answer             VARCHAR,
  p_answer           DOUBLE,                   -- noul: P(true); choice/score: P(answer)
  score              DOUBLE,
  backend_confidence DOUBLE,                   -- logged, never thresholded
  probs              MAP(VARCHAR, DOUBLE),
  call_id            UUID,
  ts                 TIMESTAMPTZ DEFAULT current_timestamp,
  PRIMARY KEY (payload_hash, question_hash, candidate_set_hash, backend, model_v, pack_mode, sample_no),
  CHECK (NOT regexp_matches(model_v, '(^|[-:@/])latest$', 'i'))
);

-- One row per judge use, cache hit or not (live steps and the batch worker alike).
CREATE TABLE IF NOT EXISTS judge_uses (
  run_id             VARCHAR NOT NULL,
  step_no            INTEGER NOT NULL,
  record_id          VARCHAR,
  question_hash      VARCHAR NOT NULL,
  payload_hash       VARCHAR NOT NULL,
  candidate_set_hash VARCHAR NOT NULL DEFAULT '',
  backend            VARCHAR NOT NULL,
  model_v            VARCHAR NOT NULL,
  pack_mode          VARCHAR NOT NULL DEFAULT 'single',
  mode               VARCHAR NOT NULL CHECK (mode IN ('active','shadow','canary','audit')),
  cache_hit          BOOLEAN NOT NULL,
  ts                 TIMESTAMPTZ DEFAULT current_timestamp,
  PRIMARY KEY (run_id, step_no, question_hash, payload_hash, candidate_set_hash, backend)
);
CREATE INDEX IF NOT EXISTS judge_uses_run_step ON judge_uses (run_id, step_no);
CREATE INDEX IF NOT EXISTS judge_uses_key ON judge_uses (payload_hash, question_hash);

-- ============================================================================================
-- Traces (07 §4.5 trace contract; 03 §3.3)
-- ============================================================================================

CREATE TABLE IF NOT EXISTS llm_calls (
  call_id              VARCHAR PRIMARY KEY,
  ts                   TIMESTAMPTZ DEFAULT current_timestamp,
  source               VARCHAR NOT NULL DEFAULT 'kernel',   -- kernel | import:*
  mode                 VARCHAR CHECK (mode IS NULL OR mode IN ('active','shadow','canary','audit')),
  -- Identity
  run_id               VARCHAR NOT NULL,
  step_no              INTEGER,
  workflow             VARCHAR,
  workflow_v           INTEGER,
  record_ids           VARCHAR[],
  decision_point_id    VARCHAR,
  -- Prompt
  system_hash          VARCHAR,
  template_id          VARCHAR,
  template_v           INTEGER,
  template_hash        VARCHAR,                  -- static text, slots emptied
  slots                JSON,                     -- name -> {path, field_hash}
  rendered_hash        VARCHAR,
  -- Input
  input_projection_ref VARCHAR,                  -- -> content.ref
  input_hash           VARCHAR,                  -- JCS sha256
  -- Tools
  tool_set_hash        VARCHAR,
  -- Model
  provider             VARCHAR,
  model_requested      VARCHAR,
  model_returned       VARCHAR,
  temperature          DOUBLE,
  reasoning_level      VARCHAR,
  seed                 BIGINT,
  -- Output
  output_kind          VARCHAR CHECK (output_kind IS NULL
                         OR output_kind IN ('tool_call','structured','choice_like','text')),
  parsed               JSON,
  normalised_answer    VARCHAR,
  alternatives         JSON,
  raw_ref              VARCHAR,
  -- Effect (filled by the kernel when the downstream step completes)
  effect               JSON,
  branch_taken         VARCHAR,
  -- Cost
  input_tokens         INTEGER,
  output_tokens        INTEGER,
  cache_tokens         INTEGER,
  reasoning_tokens     INTEGER,
  cost_usd             DOUBLE,
  cost_basis           VARCHAR CHECK (cost_basis IS NULL
                         OR cost_basis IN ('provider-reported','token-price','gpu-amortised','zero')),
  latency_ms           INTEGER,
  retries              INTEGER,
  -- Provenance
  label_source         VARCHAR,
  is_jev_output        BOOLEAN NOT NULL DEFAULT false,
  teacher_blind        BOOLEAN
);
CREATE INDEX IF NOT EXISTS llm_calls_run_step ON llm_calls (run_id, step_no);
CREATE INDEX IF NOT EXISTS llm_calls_dp ON llm_calls (decision_point_id);

-- Mirror of journal `steps` (epoch-ms integers kept) plus mining columns.
CREATE TABLE IF NOT EXISTS trace_steps (
  run_id          VARCHAR NOT NULL,
  step_no         INTEGER NOT NULL,
  parent_step_no  INTEGER,
  kind            VARCHAR NOT NULL
                  CHECK (kind IN ('sql','rule','retrieve','judge','llm','tool','human','route')),
  name            VARCHAR NOT NULL,
  status          VARCHAR NOT NULL,
  attempt         INTEGER NOT NULL DEFAULT 1,
  mode            VARCHAR NOT NULL CHECK (mode IN ('active','shadow','canary','audit')),
  input_ref       VARCHAR,
  output          JSON,
  error           VARCHAR,
  idempotency_key VARCHAR,
  started_at      BIGINT,
  ended_at        BIGINT,
  record_id       VARCHAR,
  activity        VARCHAR NOT NULL,              -- kind:template_id
  source          VARCHAR NOT NULL DEFAULT 'kernel',
  PRIMARY KEY (run_id, step_no)
);
CREATE INDEX IF NOT EXISTS trace_steps_record ON trace_steps (record_id);

CREATE TABLE IF NOT EXISTS tool_schemas (
  hash   VARCHAR PRIMARY KEY,
  name   VARCHAR NOT NULL,
  schema JSON NOT NULL
);

CREATE TABLE IF NOT EXISTS routes (
  run_id            VARCHAR NOT NULL,
  step_no           INTEGER NOT NULL,
  record_id         VARCHAR,
  decision_point_id VARCHAR NOT NULL,
  tiers             JSON,
  branch_taken      VARCHAR NOT NULL,
  reason_code       VARCHAR NOT NULL,
  threshold_id      VARCHAR,
  cost_usd          DOUBLE,
  mode              VARCHAR NOT NULL CHECK (mode IN ('active','shadow','canary','audit')),
  ts                TIMESTAMPTZ DEFAULT current_timestamp,
  PRIMARY KEY (run_id, step_no)
);
CREATE INDEX IF NOT EXISTS routes_dp ON routes (decision_point_id);

-- ============================================================================================
-- Labels (H5), calibrators, thresholds, prices
-- ============================================================================================

-- H5: source never names Jev/TypeSafe (07 §1, §3 item 13). Stricter than §4.2's sketch: the ban
-- applies to every prefix, so 'rule:jev_x' is rejected too.
CREATE TABLE IF NOT EXISTS labels (
  label_id      UUID PRIMARY KEY DEFAULT uuid(),
  record_id     VARCHAR NOT NULL,
  target_kind   VARCHAR NOT NULL,
  target_ref    VARCHAR NOT NULL,
  label         VARCHAR NOT NULL,
  source        VARCHAR NOT NULL CHECK (
                  source NOT ILIKE '%jev%' AND source NOT ILIKE '%typesafe%' AND (
                    source = 'human' OR source = 'behaviour'
                    OR (starts_with(source, 'llm:') AND length(source) > 4)
                    OR (starts_with(source, 'rule:') AND length(source) > 5))),
  labeller      VARCHAR,
  split         VARCHAR,
  selected_by   VARCHAR CHECK (selected_by IS NULL OR selected_by IN
                  ('random','exhaustive','reviewer','audit','jev_disagreement')),
  teacher_blind BOOLEAN,
  ts            TIMESTAMPTZ DEFAULT current_timestamp
);
CREATE INDEX IF NOT EXISTS labels_record ON labels (record_id, target_ref);

CREATE TABLE IF NOT EXISTS calibrators (
  calibrator_id VARCHAR PRIMARY KEY,
  question_hash VARCHAR NOT NULL,
  backend       VARCHAR NOT NULL,
  model_v       VARCHAR NOT NULL,
  candidate_spec VARCHAR NOT NULL DEFAULT '',
  method        VARCHAR NOT NULL
                CHECK (method IN ('identity','temperature','platt','isotonic','histogram')),
  params        JSON NOT NULL DEFAULT '{}',     -- {} | {T} | {a,b} | {knots:[[x,y],...]}
  n_fit         INTEGER,
  ece           DOUBLE,
  ece_floor     DOUBLE,
  brier         DOUBLE,
  status        VARCHAR NOT NULL DEFAULT 'candidate'
                CHECK (status IN ('candidate','active','stale','retired')),
  fitted_at     TIMESTAMPTZ DEFAULT current_timestamp
);
CREATE INDEX IF NOT EXISTS calibrators_key ON calibrators (question_hash, backend, model_v);

CREATE TABLE IF NOT EXISTS thresholds (
  threshold_id   VARCHAR PRIMARY KEY,
  policy_id      VARCHAR NOT NULL,
  question_hash  VARCHAR NOT NULL,
  backend        VARCHAR NOT NULL,
  model_v        VARCHAR NOT NULL,
  candidate_spec VARCHAR NOT NULL DEFAULT '',
  calibrator_id  VARCHAR,
  action         VARCHAR NOT NULL,
  rule           JSON NOT NULL,                 -- {label, min_p, abstain_band?, on_error}
  floor          DOUBLE NOT NULL DEFAULT 0.5,   -- the 0.5 floor is a column default, not code
  cost_matrix    JSON,                          -- {wrong_auto, human_review, llm_call, llm_error_rate}
  alpha          DOUBLE,
  delta          DOUBLE,
  certified_loss DOUBLE,
  coverage       DOUBLE,
  n_cal          INTEGER,
  valid_from     TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  valid_to       TIMESTAMPTZ,
  status         VARCHAR NOT NULL DEFAULT 'candidate'
                 CHECK (status IN ('candidate','active','stale','human_only','retired'))
);
CREATE INDEX IF NOT EXISTS thresholds_key ON thresholds (question_hash, backend, model_v);

CREATE TABLE IF NOT EXISTS prices (
  backend        VARCHAR NOT NULL,
  model          VARCHAR NOT NULL,
  input_per_m    DOUBLE NOT NULL,
  output_per_m   DOUBLE NOT NULL DEFAULT 0,
  effective_from TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (backend, model, effective_from)
);

-- ============================================================================================
-- Discovery and lifecycle (weeks 4–6; created now so the lifecycle is one schema). 04 §3, 07 §4.6
-- ============================================================================================

CREATE TABLE IF NOT EXISTS decision_points (
  dp_id          VARCHAR PRIMARY KEY,
  template_fp    VARCHAR,
  tool_set_hash  VARCHAR,
  branch_def     JSON,
  n              BIGINT,
  k              INTEGER,
  entropy        DOUBLE,
  med_out_tokens DOUBLE,
  cost_share     DOUBLE,
  class          VARCHAR CHECK (class IS NULL OR class IN ('rule','question','generation','open'))
);

CREATE TABLE IF NOT EXISTS proposals (
  proposal_id   VARCHAR PRIMARY KEY,
  artefact_kind VARCHAR NOT NULL CHECK (artefact_kind IN ('question','rule','process','concept')),
  artefact_ref  VARCHAR NOT NULL,
  parent_ref    VARCHAR,
  dp_id         VARCHAR,
  status        VARCHAR NOT NULL
                CHECK (status IN ('proposed','shadow','canary','active','demoted','retired')),
  evidence      JSON,
  gate_results  JSON,
  created_at    TIMESTAMPTZ DEFAULT current_timestamp,
  status_at     TIMESTAMPTZ DEFAULT current_timestamp
);

CREATE TABLE IF NOT EXISTS promotions (
  proposal_id VARCHAR NOT NULL,
  from_status VARCHAR NOT NULL
              CHECK (from_status IN ('proposed','shadow','canary','active','demoted','retired')),
  to_status   VARCHAR NOT NULL
              CHECK (to_status IN ('proposed','shadow','canary','active','demoted','retired')),
  card_hash   VARCHAR,
  approver    VARCHAR,
  decision    VARCHAR NOT NULL,
  reason      VARCHAR,
  ts          TIMESTAMPTZ DEFAULT current_timestamp
);
CREATE INDEX IF NOT EXISTS promotions_proposal ON promotions (proposal_id);

CREATE TABLE IF NOT EXISTS processes (
  process_id    VARCHAR NOT NULL,
  version       INTEGER NOT NULL,
  spec          JSON NOT NULL,                  -- DAG with per-node status
  derived_from  VARCHAR,
  lockfile_hash VARCHAR,
  status        VARCHAR NOT NULL
                CHECK (status IN ('proposed','shadow','canary','active','demoted','retired')),
  PRIMARY KEY (process_id, version)
);

-- ============================================================================================
-- Calibration macros. calibrate.ts is the TS reference; the two agree to 1e-9 (core tests).
-- ============================================================================================

CREATE OR REPLACE MACRO dcx_clamp01(p) AS greatest(1e-6, least(1 - 1e-6, p));
CREATE OR REPLACE MACRO dcx_logit(p) AS ln(dcx_clamp01(p) / (1 - dcx_clamp01(p)));
CREATE OR REPLACE MACRO dcx_sigmoid(z) AS 1 / (1 + exp(-z));
-- Piecewise-linear over x-ascending knots k = [[x,y],...]; clamped to the end values; on a
-- step (repeated x) the right-hand value wins; empty knots = identity.
CREATE OR REPLACE MACRO dcx_interp_typed(k, p) AS CASE
  WHEN len(k) = 0 THEN p
  WHEN p <= k[1][1] THEN k[1][2]
  WHEN p >= k[len(k)][1] THEN k[len(k)][2]
  ELSE (list_transform(
          list_filter(range(1, len(k)), lambda i: k[i][1] <= p AND p < k[i + 1][1]),
          lambda i: k[i][2] + (k[i + 1][2] - k[i][2]) * (p - k[i][1]) / (k[i + 1][1] - k[i][1])
        ))[1]
  END;
-- The typed coalesce stops a constant NULL knot list folding into an untyped literal, which
-- would make the lambdas fail to bind (DuckDB 1.5.5).
CREATE OR REPLACE MACRO dcx_interp(k, p) AS
  dcx_interp_typed(coalesce(CAST(k AS DOUBLE[][]), CAST([] AS DOUBLE[][])), CAST(p AS DOUBLE));
-- calibrate(method, params, p): identity | temperature {T}: sigmoid(logit(p)/T) |
-- platt {a,b}: sigmoid(a*logit(p)+b) | isotonic/histogram {knots}: dcx_interp.
CREATE OR REPLACE MACRO calibrate(method, params, p) AS CASE
  WHEN p IS NULL THEN NULL
  WHEN method IS NULL OR method = 'identity' THEN p
  WHEN method = 'temperature' THEN dcx_sigmoid(dcx_logit(p) / json_extract_string(params, '$.T')::DOUBLE)
  WHEN method = 'platt'
    THEN dcx_sigmoid(json_extract_string(params, '$.a')::DOUBLE * dcx_logit(p) + json_extract_string(params, '$.b')::DOUBLE)
  WHEN method IN ('isotonic', 'histogram')
    THEN dcx_interp(CAST(json_extract(params, '$.knots') AS DOUBLE[][]), p)
  ELSE NULL
  END;
-- calibrate_probs: Choice/Score. Temperature with >=2 probs = p_answer^(1/T) / sum_k p_k^(1/T)
-- (softmax(log p / T)); otherwise calibrate() on the chosen probability.
CREATE OR REPLACE MACRO calibrate_probs(method, params, probs, answer, p) AS CASE
  WHEN method = 'temperature' AND probs IS NOT NULL AND cardinality(probs) >= 2
    THEN pow(coalesce(map_extract_value(probs, answer), p), 1 / json_extract_string(params, '$.T')::DOUBLE)
         / nullif(list_sum(list_transform(map_values(probs),
             lambda x: pow(x, 1 / json_extract_string(params, '$.T')::DOUBLE))), 0)
  ELSE calibrate(method, params, p)
  END;

-- ============================================================================================
-- Views
-- ============================================================================================

-- H5: the only label stream any trainer may read (07 §4.2). CI fails trainers that bypass it.
CREATE OR REPLACE VIEW training_labels AS
  SELECT * FROM labels
  WHERE source IN ('human', 'behaviour') AND coalesce(selected_by, '') <> 'jev_disagreement';

-- Every judge use with its cached answer and read-time calibration (07 §4.2). Repeat samples
-- (sample_no > 0) are excluded. p_cal is the calibrated p_answer (noul: P(true));
-- p_cal_answer is the calibrated probability of the chosen answer (noul: max side, 03 §3.4).
-- Invariant: at most one 'active' calibrator per (question_hash, backend, model_v).
CREATE OR REPLACE VIEW decisions AS
WITH base AS (
  SELECT u.run_id, u.step_no, u.record_id, u.question_hash, u.payload_hash,
         u.candidate_set_hash, u.backend, u.model_v, u.pack_mode, u.mode, u.cache_hit, u.ts,
         j.question_id, j.question_v, j.qtype, j.answer, j.probs, j.p_answer, j.score,
         j.backend_confidence, j.call_id,
         c.calibrator_id, c.method AS calibrator_method,
         CASE WHEN j.qtype = 'noul' THEN calibrate(c.method, c.params, j.p_answer)
              ELSE calibrate_probs(c.method, c.params, j.probs, j.answer, j.p_answer)
         END AS p_cal
  FROM judge_uses u
  JOIN judgments j
    ON j.payload_hash = u.payload_hash AND j.question_hash = u.question_hash
   AND j.candidate_set_hash = u.candidate_set_hash AND j.backend = u.backend
   AND j.model_v = u.model_v AND j.pack_mode = u.pack_mode AND j.sample_no = 0
  LEFT JOIN calibrators c
    ON c.question_hash = u.question_hash AND c.backend = u.backend
   AND c.model_v = u.model_v AND c.status = 'active'
)
SELECT *,
       CASE WHEN qtype = 'noul' AND answer <> 'true' THEN 1 - p_cal ELSE p_cal END AS p_cal_answer
FROM base;

-- decisions × active thresholds valid at the use's time, one row per (use, action). outcome:
-- above_threshold (act) | abstain_band (tier 2) | below_floor (human) | not_applicable (the
-- rule's label differs from the answer) | error (no probability). The threshold must name the
-- calibrator the decision used.
CREATE OR REPLACE VIEW decision_actions AS
WITH t AS (
  SELECT *, json_extract_string(rule, '$.label') AS rule_label, json_extract_string(rule, '$.min_p')::DOUBLE AS min_p,
         coalesce(json_extract_string(rule, '$.abstain_band[0]')::DOUBLE, floor) AS band_lo,
         json_extract_string(rule, '$.on_error') AS on_error
  FROM thresholds WHERE status = 'active'
)
SELECT d.*, t.threshold_id, t.policy_id, t.action, t.rule_label, t.min_p, t.band_lo,
       t.on_error,
       CASE WHEN d.p_cal_answer IS NULL THEN 'error'
            WHEN t.rule_label IS NOT NULL AND d.answer <> t.rule_label THEN 'not_applicable'
            WHEN d.p_cal_answer >= t.min_p THEN 'above_threshold'
            WHEN d.p_cal_answer >= t.band_lo THEN 'abstain_band'
            ELSE 'below_floor' END AS outcome
FROM decisions d
JOIN t ON t.question_hash = d.question_hash AND t.backend = d.backend AND t.model_v = d.model_v
      AND t.calibrator_id IS NOT DISTINCT FROM d.calibrator_id
      AND t.valid_from <= coalesce(d.ts, current_timestamp)
      AND (t.valid_to IS NULL OR coalesce(d.ts, current_timestamp) < t.valid_to);

-- Every record × live static-options question, with its cache-key columns (01 §3.1).
-- payload_hash comes from `projections`, which TS fills: rows with payload_hash IS NULL (or a
-- stale projection) need `project` + `payloadHash` computed and upserted before the worker's
-- anti-join. Runtime-options questions are asked by retrieve + judge steps, not listed here.
CREATE OR REPLACE VIEW asks AS
SELECT r.record_id, r.kind AS record_kind, r.state_hash,
       q.question_id, q.version AS question_v, q.question_hash, q.qtype,
       q.status AS question_status, q.fields, q.fields_key, q.max_state_tokens,
       p.payload_hash, p.payload,
       '' AS candidate_set_hash, 'single' AS pack_mode, 0::SMALLINT AS sample_no
FROM records r
JOIN questions q
  ON q.status IN ('shadow', 'canary', 'active') AND q.options_source = 'static'
 AND (q.applies_to IS NULL OR q.applies_to = r.kind)
LEFT JOIN projections p
  ON p.record_id = r.record_id AND p.fields_key = q.fields_key AND p.state_hash = r.state_hash;

-- Per-run cost ledger (E §3.3), a placeholder until processes are promoted: LLM spend from
-- llm_calls, judge spend attributed per non-cached use as call cost / n_questions, and route
-- coverage. Before/after comparison by workflow is done in the report (runs live in SQLite).
CREATE OR REPLACE VIEW savings_ledger AS
WITH llm AS (
  SELECT run_id, any_value(workflow) AS workflow, any_value(workflow_v) AS workflow_v,
         count(*) AS llm_calls, coalesce(sum(cost_usd), 0) AS llm_cost_usd
  FROM llm_calls GROUP BY run_id
), jud AS (
  SELECT u.run_id, count(*) AS judge_uses,
         count(*) FILTER (WHERE u.cache_hit) AS judge_cache_hits,
         coalesce(sum(c.cost_usd / greatest(c.n_questions, 1)) FILTER (WHERE NOT u.cache_hit), 0)
           AS judge_cost_usd
  FROM judge_uses u
  LEFT JOIN judgments j
    ON j.payload_hash = u.payload_hash AND j.question_hash = u.question_hash
   AND j.candidate_set_hash = u.candidate_set_hash AND j.backend = u.backend
   AND j.model_v = u.model_v AND j.pack_mode = u.pack_mode AND j.sample_no = 0
  LEFT JOIN judge_calls c ON c.call_id = j.call_id
  GROUP BY u.run_id
), rt AS (
  SELECT run_id, count(*) AS routes,
         count(*) FILTER (WHERE reason_code IN ('above_threshold', 'tier0_rule')) AS routes_auto,
         count(*) FILTER (WHERE branch_taken = 'human') AS routes_human
  FROM routes GROUP BY run_id
)
SELECT coalesce(llm.run_id, jud.run_id, rt.run_id) AS run_id,
       llm.workflow, llm.workflow_v,
       coalesce(llm.llm_calls, 0) AS llm_calls,
       coalesce(llm.llm_cost_usd, 0) AS llm_cost_usd,
       coalesce(jud.judge_uses, 0) AS judge_uses,
       coalesce(jud.judge_cache_hits, 0) AS judge_cache_hits,
       coalesce(jud.judge_cost_usd, 0) AS judge_cost_usd,
       coalesce(llm.llm_cost_usd, 0) + coalesce(jud.judge_cost_usd, 0) AS total_cost_usd,
       coalesce(rt.routes, 0) AS routes,
       coalesce(rt.routes_auto, 0) AS routes_auto,
       coalesce(rt.routes_human, 0) AS routes_human,
       rt.routes_auto / nullif(rt.routes, 0) AS coverage_without_llm
FROM llm
FULL JOIN jud ON jud.run_id = llm.run_id
FULL JOIN rt ON rt.run_id = coalesce(llm.run_id, jud.run_id);
