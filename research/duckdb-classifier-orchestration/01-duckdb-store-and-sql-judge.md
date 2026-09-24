# 01 · DuckDB as store and SQL-callable judge (Workstream A)

_24 Sep 2026. Evidence tags: **[opened]** means I read the page or package. **[search]** means a search snippet only. **[tested]** means I ran it locally on DuckDB 1.5.5 (Python) and `@duckdb/node-api` 1.5.5-r.5, with a stub judge standing in for Jev. **unverified** means none of these. No live Jev key was used._

## 1. Summary

**Verdict on H3 (DuckDB alone is enough as store, eval harness and trace warehouse at single-node scale): yes, with two changes to the hypothesis.**

1. **Keep DuckDB as the store, the eval harness and the policy layer. Do not make the SQL UDF the production judge.** Paid judge calls should run in one async worker. The worker reads its work list from SQL (an anti-join against the cache), calls the backend, and writes answers back with bulk Arrow inserts. Routing, calibration and threshold sweeps then run as plain SQL over stored answers. The scalar `judge()` UDF is still worth having, but only for notebooks and exploration. Four reasons, all tested or read at source:
   - DuckDB evaluates a UDF in `WHERE` and in `SELECT` separately, even through a subquery, so each row is billed twice [tested].
   - UDF callbacks in Node and in DuckDB-WASM are synchronous. An `async` Node UDF silently returned wrong results [tested].
   - A rollback cannot undo API charges [opened].
   - The whole database has one writer process [tested].
2. **Split the plan's `decisions` table.** It becomes an immutable, content-addressed `judgments` cache keyed by (payload hash, question-spec hash, backend, returned model version), plus a `judge_calls` table for per-request cost and latency. Jev bills per request with many questions in it, so cost belongs to calls, not to answers. `decisions` becomes a view.

H1, H2, H4 and H5 are outside this workstream. One point bears on H4: the cost of an all-Jev pipeline is dominated by request count and re-runs, not by tokens. So the cache and batching design decides the cost result more than the choice of model does.

**The three most important findings:**

- **Prior art already exists for the SQL-judge layer.** Three Jev-for-DuckDB integrations appeared within ten days of launch: `prasanthj/duckdb-jev` (native C++, batching, caching, a streaming table function), `colliber/duckdb-jev` (typed `ENUM`/`STRUCT` returns fixed at plan time) and `Query-farm/vgi-typesafe` (LATERAL table functions). MotherDuck ships a hosted `prompt_jev()` [opened; MotherDuck is search-only]. We should adopt one of these, not write a DuckDB extension.
- **Row-at-a-time is 60–70× slower than batched.** A live benchmark measured 100 Jev calls one at a time with no concurrency at ~15 s, against 0.24 s with 25 questions per request and 10-way concurrency [opened]. At the reported 1,200 requests/min, a million one-row calls takes at least ~14 h. Packing 100 rows per request brings that to ~8 min. Packing is only safe with a per-question equivalence test: one study saw 40-row batching break a ranking gate [opened].
- **Jev's outputs are not reproducible call to call.** A repeated one-row control drifted by up to 0.10 in probability. Probabilities also come back at two decimals, with heavy ties at 0.99 [opened]. The cache is what makes routing replayable, and evals need repeat samples (`sample_no`) to measure this noise floor.

## 2. Findings

### 2.1 DuckDB mechanics that matter for this job

**Versions.**
- Stable is 1.5.5 (22 Jul 2026). The 1.4.x line is LTS [opened: PyPI release list].
- v2.0 is scheduled for fall 2026. It will turn the deprecated `x -> …` lambda syntax into an error, so write `lambda x: …` now [opened: roadmap].
- Native extensions must match DuckDB's version and platform exactly [opened: duckdb-jev README]. Every DuckDB upgrade therefore means waiting for extension rebuilds.

**Types for probabilities.**
- `MAP(VARCHAR, DOUBLE)` fits option distributions whose keys differ per question. You can read `probs['billing']` directly, and `map_entries()` unnests the map for per-option calibration [tested].
- `STRUCT` suits fixed-shape returns. A UDF can return `STRUCT(answer, confidence, probs MAP)` [tested].
- `colliber/duckdb-jev` goes further and derives an `ENUM` column type from the criteria literal at plan time. A bad option set then fails when the query is planned, not on row 400,000 [opened]. Take that idea for the typed per-question views.
- The `JSON` type, `->>`, `json_extract` and `json_structure` cover raw state. `to_json` keeps key order and `json_object` does not sort keys [tested]. So a canonical hash needs a fixed field order, which the question registry supplies.

**Hashing and generated columns.** `sha256()` works over `to_json({...})`. A `VIRTUAL` generated column can hold the question-spec hash, so it can never drift from the wording [tested].

**Bulk writes** [tested, local SSD]:

| Insert path | Measured rate |
|---|---|
| Python `executemany` | ~870 rows/s (20k rows in 23 s) |
| Arrow table via replacement scan (`INSERT … SELECT * FROM arrow_tbl`) | ~2M rows/s (1M in 0.49 s) |
| Arrow into a `PRIMARY KEY` table | 1M in 1.46 s |
| `ON CONFLICT DO NOTHING`, all conflicts | 1M in 0.57 s |
| Single autocommitted `INSERT` | ~1.6 ms each |

Node has an appender and `appendDataChunk` [opened]. Rule: workers buffer answers and flush them as Arrow batches; never write row by row.

**Python UDFs** [tested unless noted]:
- `create_function(..., type='arrow')` receives vectors of up to 2,048 rows.
- DuckDB calls it from several worker threads at once. I/O that releases the GIL overlaps: 489 calls sleeping 20 ms each took 1.6 s rather than 9.8 s. CPU-bound Python still serialises on the GIL, and "Parallel Python UDFs" is still on the roadmap [opened].
- Native (row) mode made 100k Python calls in 18 s.
- Identical expressions in one `SELECT` are evaluated once.
- Constant arguments are folded to one call unless `side_effects=True`.
- `LIMIT 5` evaluated only 5 rows, and cheap filters ran before the UDF whichever way the predicates were written.
- **No deduplication of repeated values.** 3,000 rows holding 10 distinct values still sent 3,000 values.
- **`WHERE judge(x) > .5` combined with `SELECT judge(x)` evaluates twice.** Moving the call into a subquery still evaluates twice, because the filter is pushed down through the projection. A `MATERIALIZED` CTE evaluates once.
- The Python API has no user-defined table functions; `create_function` is scalar only. You can still batch explicitly in SQL: group rows with `list()`, call a list-in/list-out UDF once per group, then `unnest`. With 100 rows per group, 1,000 rows made 10 calls.
- The callable must be synchronous. Inside it you can run `asyncio` or a thread pool to fan out one chunk's requests.

**Node UDFs.**
- `@duckdb/node-api` supports scalar and table functions. The docs say "callbacks are always run on the JS thread, so they are serialized even when DuckDB evaluates in parallel" [opened].
- An `async` main function returned `0` instead of the value, with no error raised [tested]. **In Node, never call HTTP from a UDF.**

**Concurrency and durability** [tested/opened]:
- One read-write process holds a file lock. A second process cannot open the file, even with `read_only=True`, while the writer holds it [tested].
- Within the process, MVCC with optimistic concurrency control applies: appends never conflict, while two concurrent updates to the same row give "Conflict on update!" [tested].
- Multi-process writes need the Quack remote protocol (beta since 1.5.3, May 2026, expected to mature by v2.0) or DuckLake with a Postgres catalog (v1.0, Apr 2026) [opened].
- A write-ahead log (WAL) means commits survive `kill -9` [tested]. Auto-checkpoint happens at 16 MiB of WAL [tested].
- `VACUUM` does not reclaim space; `COPY FROM DATABASE` compacts [opened].

**Indexes** [opened]:
- Zonemaps are automatic.
- ART indexes back `PRIMARY KEY`/`UNIQUE` and help only highly selective lookups (under 0.1% of rows). They must fit in memory when built.
- An `UPDATE` on an indexed column becomes delete-then-insert, with over-eager constraint checking.
- Foreign keys have a known false-violation bug when a referenced row with a LIST or STRUCT payload is updated.
- Design consequence: immutable tables, PKs only on cache keys, no foreign keys, and inserts in time order so zonemaps prune by `ts`.

**Extensions.**
- Community extensions are built, signed and distributed centrally [opened].
- A Rust template exists on the C extension API, marked experimental; "Rust support for extensions" is on the roadmap [opened].
- A native judge extension costs a C++ build per DuckDB version and platform, plus WASM, and fixes neither the single writer nor billing inside queries. Not worth it: `prasanthj/duckdb-jev` (Apache-2.0) exists, and `jev_endpoint` can point at any Jev-wire server (jeff, openjev, SemIf) [opened].

**DuckDB-WASM** [opened]:
- The full engine runs in the browser.
- Persistence via `opfs://` needs an explicit `CHECKPOINT`.
- Memory is capped at 4 GB.
- It is single-threaded unless the page is cross-origin isolated.
- HTTP goes through the browser's CORS rules.
- `createScalarFunction` exists only on the synchronous bindings, not on `AsyncDuckDBConnection` [opened: package types], so there are no async fetches from SQL.
- The TypeSafe SDK blocks browsers, and the key must stay server-side (platform doc §7).
- Pattern: the browser holds a local DuckDB (labels, eval views, HITL UI). A relay does the judging, and the page inserts the answers with `insertArrowTable`.

**MotherDuck** [search]:
- `prompt()` (OpenAI models, `struct` outputs) and `prompt_jev()` (Choice/Score/Noul returning typed STRUCTs). MotherDuck's own figure for `prompt_jev()` is 100k rows in 40 s for $0.50.
- Paid plans only.
- `CREATE SHARE` gives read-only, URL-attachable snapshots, and dual execution splits a query between laptop and cloud.
- Good for sharing eval results and dashboards, but it is another US processor (APP 8), so check residency before any PII goes there.

### 2.2 Exposing the classifier in SQL

| Shape | Batching | Good for | Problems |
|---|---|---|---|
| Scalar `judge(payload, qid)` | Per 2,048-row chunk; up to 16 concurrent (colliber) or packed (prasanthj) | Notebooks, ad-hoc `SELECT` | Double evaluation in `WHERE`; `LIMIT` still pays for whole chunks; billing inside a transaction |
| Multi-question scalar `jev_eval(state, questions)` | One request per row, all questions together | The Jev fan-out pattern | Same as above |
| Streaming table function `jev_stream((SELECT id, state, questions …))` | Across chunks, bounded in-flight work | Bulk enrichment | Native only; `LIMIT` can prefetch and pay for extra rows [opened] |
| **Work list plus worker (recommended)** | Worker's choice, rate-limited, retried | Production, replay, eval | Needs one more process: the orchestrator's judge step |

**Cost and latency** (platform doc: ~$0.00002/call; latency 150–350 ms; 1,200 requests/min reported):
- The first-order cost is the number of requests and the number of re-runs, not tokens.
- Without a cache, every threshold re-fit, calibration experiment and replay re-bills the same states.

**How to batch.**
- Jev's documented batching unit is many questions against one state.
- prasanthj batches across rows by putting each row's evidence into its question's structured `instructions`, with the shared policy in `state`. Its live equivalence test found identical Choice and Noul decisions at batch sizes 1, 10, 25 and 100 [opened].
- `jev-orderby-bench` found that a different integration's 40-row batching broke the ranking gate [opened].
- Policy: default to one state per request. Allow cross-row packing per question only after an equivalence check passes.

### 2.3 "Retrieve precisely, send only needed fields" as SQL

- Store the projection as data. `questions.fields` lists the JSON paths a question may see, and a macro builds the payload in registry order [tested].
- Code does the exact work (quote stripping, date candidates, counts) in SQL or ingest code before projection, as the source report's Part 2 rules require.
- The cache key is the hash of the **projected payload**, not of the raw record. An email whose footer changes, but whose projected fields do not, stays cached.
- Questions with the same `fields` share one request (the fan-out). Questions with different projections cost separate requests. That trade-off (fewer requests versus less context rot) belongs in the registry, not in code.

## 3. Design proposal

### 3.1 Schema (DDL sketch; the full version ran [tested])

```sql
CREATE TYPE qtype AS ENUM ('choice', 'score', 'noul');
CREATE TABLE records (record_id VARCHAR PRIMARY KEY, kind VARCHAR NOT NULL, source VARCHAR NOT NULL,
  state JSON NOT NULL, state_hash VARCHAR NOT NULL, received_at TIMESTAMPTZ,
  ingested_at TIMESTAMPTZ DEFAULT current_timestamp);
CREATE TABLE questions (question_id VARCHAR, version INTEGER, applies_to VARCHAR NOT NULL,
  qtype qtype NOT NULL, instructions VARCHAR NOT NULL, criteria JSON NOT NULL,
  fields VARCHAR[] NOT NULL,                      -- the only state fields sent
  status VARCHAR DEFAULT 'draft',                 -- draft | shadow | active | retired
  owner VARCHAR, created_at TIMESTAMPTZ DEFAULT current_timestamp,
  spec_hash VARCHAR GENERATED ALWAYS AS
    (sha256(to_json({t: qtype, i: instructions, c: criteria, f: fields}))) VIRTUAL,
  PRIMARY KEY (question_id, version));            -- rows are immutable; edits = new version
CREATE TABLE judge_calls (call_id UUID PRIMARY KEY DEFAULT uuid(), backend VARCHAR NOT NULL,
  model_req VARCHAR, model_v VARCHAR NOT NULL, request_id VARCHAR, n_questions INTEGER,
  input_tokens INTEGER, cost_usd DECIMAL(14,10), latency_ms INTEGER, attempts SMALLINT,
  status VARCHAR, run_id VARCHAR, ts TIMESTAMPTZ DEFAULT current_timestamp);
CREATE TABLE judgments (                           -- immutable, content-addressed cache
  payload_hash VARCHAR, spec_hash VARCHAR, backend VARCHAR, model_v VARCHAR,  -- returned model, never an alias
  sample_no SMALLINT DEFAULT 0,                   -- >0 only for eval repeat calls
  question_id VARCHAR, question_v INTEGER,
  answer VARCHAR, p_answer DOUBLE,                -- noul: P(true)
  score DOUBLE, confidence DOUBLE,                -- provider confidence, NULL for noul
  probs MAP(VARCHAR, DOUBLE), call_id UUID, ts TIMESTAMPTZ DEFAULT current_timestamp,
  PRIMARY KEY (payload_hash, spec_hash, backend, model_v, sample_no));
CREATE TABLE labels (record_id VARCHAR, question_id VARCHAR, label VARCHAR, labeller VARCHAR, -- person | llm:<m> | rule:<r>
  split VARCHAR, ts TIMESTAMPTZ DEFAULT current_timestamp);
CREATE TABLE calibrators (question_id VARCHAR, question_v INTEGER, backend VARCHAR, model_v VARCHAR,
  method VARCHAR, params JSON, n_fit INTEGER, ece_before DOUBLE, ece_after DOUBLE, fitted_at TIMESTAMPTZ);
CREATE TABLE thresholds (policy_id VARCHAR, policy_v INTEGER, question_id VARCHAR, question_v INTEGER,
  model_v VARCHAR, action VARCHAR, answer VARCHAR, min_p DOUBLE, abstain_lo DOUBLE,
  fitted_on VARCHAR, metrics JSON, valid_from TIMESTAMPTZ DEFAULT current_timestamp, valid_to TIMESTAMPTZ);
CREATE TABLE routes (record_id VARCHAR, policy_id VARCHAR, policy_v INTEGER, action VARCHAR,
  reasons JSON, run_id VARCHAR, ts TIMESTAMPTZ DEFAULT current_timestamp);
-- traces / runs / processes / hitl_queue as in PLAN.md; their shape is owned by workstreams C and D.

CREATE MACRO project(state, fields) AS to_json(map_from_entries(
  list_transform(fields, lambda f: {'key': f, 'value': json_extract(state, '$.' || f)})));
CREATE VIEW asks AS                                -- every (record, live question) and its cache key
SELECT r.record_id, q.question_id, q.version AS question_v, q.spec_hash,
       project(r.state, q.fields) AS payload, sha256(project(r.state, q.fields)) AS payload_hash
FROM records r JOIN questions q ON q.applies_to = r.kind AND q.status IN ('active', 'shadow');
```

**Design choices behind the schema:**
- **Cache key.** It includes `spec_hash` rather than just (id, version), so an edit that forgets to bump the version cannot serve stale answers. It includes the *returned* `model_v`, because the TypeSafe SDK defaults to the `jev-latest` alias.
- **Calibration is applied at read time.** Calibrators map raw scores through a stored temperature or isotonic map when read, so re-fitting never invalidates the cache.
- **Thresholds carry validity intervals.** Any past route can then be replayed exactly.
- **Typed views per question.** Generate views from the registry, for example `answer::ENUM('invoice', …)`, to get colliber-style typing without a native extension.

### 3.2 Judge interface

```python
def ask(state: dict, questions: dict[str, Spec], backend: Backend) -> Response: ...  # Jev wire shape (workstream B)

def judge_misses(con, backend, model):          # the production path [tested with a stub]
    misses = con.sql("""SELECT DISTINCT a.payload_hash, a.payload, a.question_id, a.question_v, a.spec_hash,
                               q.qtype, q.instructions, q.criteria
                        FROM asks a JOIN questions q ON (q.question_id, q.version) = (a.question_id, a.question_v)
                        ANTI JOIN judgments j ON (j.payload_hash, j.spec_hash, j.backend, j.model_v, j.sample_no)
                                               = (a.payload_hash, a.spec_hash, $1, $2, 0)""", params=[backend, model])
    # group by payload -> one request per state with all its questions; bounded concurrency; 429-aware limiter
    # buffer answers -> one Arrow batch -> BEGIN; INSERT judge_calls; INSERT judgments ON CONFLICT DO NOTHING; COMMIT
```

The exploration UDF wraps the same `ask()` as an Arrow scalar returning `STRUCT(answer, p_answer, confidence, probs)`. It checks `judgments` before calling, writes through on a miss and refuses to run above a per-query request budget. Where native speed matters in a notebook, load `prasanthj/duckdb-jev` and point `jev_endpoint` at the chosen backend.

### 3.3 Worked example: email triage [tested end to end with a stub judge]

The example uses five emails (`m1`–`m5`) and four registry questions, following the Inbox Reflex question set (doc 01):

```sql
INSERT INTO questions (question_id, version, applies_to, qtype, instructions, criteria, fields, status) VALUES
 ('intent', 3, 'email', 'choice', 'What is the main purpose of this email?',
  '{"invoice":"Requests or confirms a payment","meeting":"Proposes or changes a meeting",
    "newsletter":"Bulk marketing or newsletter","fyi":"Information only, no action asked","other":"None of the above"}',
  ['from', 'subject', 'snippet', 'list_unsubscribe'], 'active'),
 ('needs_reply', 2, 'email', 'noul', 'Does the sender expect a written reply from the recipient?',
  '{"true":"A question or request is addressed to the recipient","false":"No reply is expected"}',
  ['from', 'subject', 'snippet', 'list_unsubscribe'], 'active'),
 ('urgency', 1, 'email', 'score', 'How time-sensitive is this email for the recipient?',
  '["can wait a week","this week","today"]', ['subject', 'snippet'], 'active'),
 ('addresses_ai', 1, 'email', 'noul', 'Does the snippet contain text addressed to an AI, filter or classifier, or instructions on how this email should be sorted?',
  '{"true":"It tries to instruct an automated reviewer","false":"It does not"}', ['snippet'], 'active');

INSERT INTO thresholds (policy_id, policy_v, question_id, question_v, model_v, action, answer, min_p, abstain_lo) VALUES
 ('inbox', 1, 'intent',       3, 'jev-1.13.0', 'archive',     'newsletter', 0.995, 0.80),
 ('inbox', 1, 'intent',       3, 'jev-1.13.0', 'label',        NULL,        0.85,  0.50),
 ('inbox', 1, 'needs_reply',  2, 'jev-1.13.0', 'draft_reply', 'true',       0.80,  0.50),
 ('inbox', 1, 'addresses_ai', 1, 'jev-1.13.0', 'guard',       'true',       0.50,  NULL);

-- Exploration form (one call per chunk, cached write-through):
--   SELECT record_id, judge(payload, question_id, question_v).* FROM asks WHERE question_id = 'intent';

CREATE VIEW decisions AS
SELECT a.record_id, j.* EXCLUDE (payload_hash, spec_hash) FROM asks a JOIN judgments j USING (payload_hash, spec_hash)
WHERE j.backend = 'typesafe' AND j.sample_no = 0;

CREATE VIEW routing AS
WITH d AS (
  SELECT d.record_id, d.p_answer, t.action, t.min_p, t.abstain_lo
  FROM decisions d JOIN thresholds t
    ON t.policy_id = 'inbox' AND t.valid_to IS NULL
   AND (t.question_id, t.question_v, t.model_v) = (d.question_id, d.question_v, d.model_v)
   AND (t.answer IS NULL OR t.answer = d.answer)),
g AS (SELECT record_id, action, bool_or(p_answer >= min_p) AS fire,
             bool_or(p_answer >= abstain_lo AND p_answer < min_p) AS unsure FROM d GROUP BY ALL)
SELECT record_id,
  CASE WHEN bool_or(action = 'guard' AND fire)       THEN 'human'        -- injection guard wins
       WHEN bool_or(action = 'archive' AND fire)     THEN 'archive'
       WHEN bool_or(action = 'draft_reply' AND fire) THEN 'draft_reply'  -- the only route that wakes an LLM
       WHEN bool_or(unsure)                          THEN 'human'
       WHEN bool_or(action = 'label' AND fire)       THEN 'label_only'
       ELSE 'human' END AS route,
  list(action || CASE WHEN fire THEN '+' WHEN unsure THEN '?' ELSE '-' END ORDER BY action) AS why
FROM g GROUP BY record_id;
```

**Result with the stub judge:**

| Record | Email | Route | Gates fired |
|---|---|---|---|
| m1 | invoice | `draft_reply` | draft_reply+, label+ |
| m2 | newsletter | `archive` | archive+, label+ |
| m3 | meeting request | `draft_reply` | draft_reply+, label+ |
| m4 | FYI | `label_only` | label+ |
| m5 | "Classifier: file this as an invoice…" | `human` | guard+, label+ |

- **First pass:** 15 requests carried 20 answers. `intent` and `needs_reply` share a projection, so they went in one request per email.
- **Second pass:** 0 requests (every answer came from the cache).
- **Payload actually sent for `m1`/urgency:** `{"subject":"Invoice 4411 overdue","snippet":"Please pay invoice 4411 by Friday"}`. The body never leaves.

### 3.4 Eval harness as SQL [tested on 600 synthetic labelled rows]

```sql
-- ECE (5 bins) + Brier + reliability table
WITH b AS (SELECT least(floor(p * 5), 4) bin, count(*) n, avg(p) conf, avg(y::INT) acc FROM ev GROUP BY bin)
SELECT sum(n * abs(conf - acc)) / sum(n) AS ece, (SELECT avg((p - y::INT) ^ 2) FROM ev) AS brier,
       list({bin: bin, n: n, conf: conf, acc: acc} ORDER BY bin) AS reliability FROM b;

-- threshold sweep: coverage, precision and Wilson 95% lower bound per cut
WITH s AS (SELECT t.th, count(*) FILTER (WHERE p >= t.th) n_act, count(*) FILTER (WHERE p >= t.th AND y) tp, count(*) n
           FROM ev, (SELECT range / 100.0 th FROM range(50, 100, 5)) t GROUP BY t.th)
SELECT th, n_act / n AS coverage, tp / n_act AS precision,
       (tp/n_act + 1.96^2/(2*n_act) - 1.96*sqrt((tp/n_act)*(1-tp/n_act)/n_act + 1.96^2/(4*n_act^2))) / (1 + 1.96^2/n_act) AS precision_lo95
FROM s ORDER BY th;

-- temperature scaling by grid search on log loss
WITH g AS (SELECT range / 20.0 T FROM range(10, 61)),
l AS (SELECT T, avg(-(y::INT * ln(pc) + (1 - y::INT) * ln(1 - pc))) nll
      FROM (SELECT T, y, 1 / (1 + exp(-ln(greatest(p, 1e-6) / greatest(1 - p, 1e-6)) / T)) pc FROM ev, g) GROUP BY T)
SELECT arg_min(T, nll) AS best_T, min(nll) FROM l;
```

**How `ev` is built.** In production, `ev` joins `decisions` to `labels` on the tune/holdout split. The gate is "`precision_lo95` at `min_p` ≥ target on holdout" (platform doc §7). Repeat-sample rows (`sample_no > 0`) give each question's noise floor: do not tune thresholds finer than that floor, or finer than the two-decimal granularity Jev returns.

## 4. Prior art and alternatives

| System | Shape | What it got right | Take / avoid |
|---|---|---|---|
| **Flock** (ex-FlockMTL; DuckDB community ext. v0.8.1, MIT; VLDB 2025) [opened] | `llm_complete/filter/embedding/reduce/rerank` scalar and aggregate functions | Models and prompts as versioned catalog resources (`CREATE MODEL/PROMPT`); `max_batch_size` (default 16) with automatic halving on context overflow; `rate_limit`, `usage_limit`; metrics; WASM build | Take: resources as data, budgets. Avoid: packing tuples into one prompt for Jev |
| **prasanthj/duckdb-jev** (C++, Apache-2.0) [opened] | Scalars, `jev_eval`, `jev_stream` table function | Chunk dedup, in-flight coalescing, bounded concurrency, per-query budgets, live equivalence test, Parquet cache pattern | Adopt for exploration; cache is in-memory only; no WASM |
| **colliber/duckdb-jev** (MIT) [opened] | `jev_choice` → `ENUM`, `jev_ask` → `STRUCT` | Types fixed at plan time; warns that `WHERE` plus `SELECT` bills twice | Take the typing idea |
| **Query-farm/vgi-typesafe** [opened] | LATERAL table functions over Arrow worker processes | Out-of-process isolation; "judge once, split on confidence" | Alternative to a native extension |
| **dbt_jev / jevql / datafusion-jev** [opened; datafusion search] | Macros; client-side `jev()` over plain SQL | Keep the DB ordinary | Confirms the worker pattern |
| **LOTUS** (arXiv 2407.11418) [opened README] | Semantic operators (map, filter, join, top-k) in a dataframe | Optimizer with model cascades and proxies; accuracy-guaranteed approximations | Cascade thresholds with guarantees (workstream B) |
| **DocETL** (VLDB 2025; MOAR VLDB 2026) [opened] | Declarative pipelines | Agentic rewrites that "replace subtasks with code wherever possible" | Same spirit as discovery (workstream D) |
| **Palimpzest / Abacus** (arXiv 2405.14696, 2505.14661) [opened] | Declarative AI analytics | Cost-based optimizer picking a model per operator from samples | Backend choice as a planned decision |
| **BlendSQL** (arXiv 2509.20208) [opened] | LLM "ingredients" inside SQL; DuckDB backend | Uses the host DBMS's optimizer; minimises calls via the AST; early exit on `LIMIT`; type-constrained outputs | The same "cheap filters first" idea as our work list |
| **Evaporate** (VLDB 17) [opened] | LLM synthesises extraction code over data lakes | Compiling LLM behaviour into code | Direct precedent for "compiled processes" |
| **pgai Vectorizer** [opened] | Postgres config plus stateless workers | Model calls run in workers outside the transaction, kept in sync declaratively | The pattern recommended here |
| **Snowflake Cortex AISQL** (`AI_FILTER/CLASSIFY/AGG`) [search] | Warehouse-native AI functions | AI-aware optimizer: predicate reordering, model cascades (proxy then strong model), semantic join rewritten as classification (15–70×) | Cascade and join-as-classification rewrites |
| **BigQuery `AI.IF` / `AI.GENERATE_BOOL`** [search] | Gemini-backed SQL functions | Planner evaluates non-AI filters first and pulls AI calls out of joins; documented "model distillation" route to cut cost | Validates the compile-to-cheaper step |
| **MotherDuck `prompt()` / `prompt_jev()`** [search] | Hosted DuckDB functions | Zero-ops, typed STRUCT returns, shares | Paid; US processor |

## 5. Constraints & prerequisites

| Item | Type | Why needed | How to get it | Blocking? | Status |
|---|---|---|---|---|---|
| DuckDB 1.5.x pinned; plan for v2.0 (fall 2026) | platform | Extension ABI, lambda syntax change | Pin in lockfile; CI on 1.5.5 and 2.0-dev | no | known [opened] |
| One process owns the DB file | architecture | Second process cannot open it, even read-only [tested] | Orchestrator is the only writer; UI/readers go through it, or use Quack (beta) or DuckLake+Postgres | yes, for multi-process designs | decision needed |
| Judge worker outside SQL (Python or Node) | architecture | Node/WASM UDFs are sync; `async` UDF returned wrong results [tested] | Build in workstream B/C | yes | proposed |
| Jev key server-side; relay for browser | platform | SDK blocks browsers; WASM UDFs are sync | Relay endpoint | yes, for WASM | known |
| Cross-row packing equivalence test per question | eval | Batching changed ranking results in one study [opened] | Batch 1 vs N on eval set; compare with a noise control | yes, before packing | open |
| Repeat-sample budget in evals | eval | ±0.10 run-to-run drift [opened] | `sample_no` 1..k on holdout | no | open |
| Rate limit (1,200/min reported) vs request count | platform limit | Row-at-a-time 1M rows ≈ 14 h minimum | Batch plus cache; read 429 headers | no | unverified numbers |
| `prasanthj/duckdb-jev` binary per version/platform | dependency | Optional exploration path | GitHub Releases; unsigned, needs `allow_unsigned_extensions` | no | known [opened] |
| Browser limits: OPFS needs `CHECKPOINT`, 4 GB cap | platform limit | Browser-only projects (Attention Firewall) | Keep history server-side | no | known [opened] |
| Backups and compaction | ops | Single-file DB; `VACUUM` does not reclaim space | Nightly `EXPORT DATABASE`/`COPY FROM DATABASE`; Parquet snapshots | no | known |

## 6. Risks & open questions

- **Accidental spend from SQL.** A scalar UDF in a filter, a `LIMIT` over whole chunks or a re-run of a view all bill again. Mitigation: exploration UDFs check the cache first and carry a per-query request budget; production calls only from the work list.
- **Hash stability.** `to_json` formatting could change across DuckDB versions, which would silently invalidate the cache. Pin a serializer version in `judgments`, or compute hashes in the worker with a canonical JSON library. **Open:** does DuckDB guarantee `to_json` output stability? unverified.
- **Probability granularity.** Jev returns two-decimal probabilities with ties at 0.99 [opened]. `ORDER BY p` needs a deterministic tiebreak, and threshold sweeps have coarse steps.
- **Single writer as a bottleneck.** This matters if C adopts an orchestrator (Temporal, DBOS) that wants its own Postgres. In that case DuckDB becomes the analytical copy and ingests the orchestrator's events. H3 still holds for eval and traces, but not for durable execution state. **Open question for C.**
- **High-rate traces.** At ~1.6 ms per autocommitted row [tested], OTel spans need a buffered Arrow/Parquet exporter.
- **HITL queue.** No LISTEN/NOTIFY and no row-level security: polling and app-level access control, fine for one owner.
- **Where DuckDB stops being enough:**
  - multiple writer processes or hosts;
  - multi-tenant access control;
  - more than 4 GB in the browser;
  - push notifications;
  - live dashboards shared across machines (MotherDuck or Quack then);
  - durable workflow state with exactly-once semantics under concurrency.
- **Terms.** Storing Jev outputs as features and caching them is fine under the cookbook reading (H5). Exporting `judgments` as training data for a student model is not. Tag each judgment's `backend`, and block exports of `backend = 'typesafe'` rows into any training pipeline.

## 7. Sources

**Opened:**
- DuckDB docs source (raw.githubusercontent.com/duckdb/duckdb-web/main/): `docs/current/sql/indexes.md`, `connect/concurrency.md`, `quack/overview.md`, `clients/python/function.md`, `clients/wasm/{overview,extensions,instantiation,deploying_duckdb_wasm,troubleshoot}.md`, `extensions/overview.md`, `configuration/overview.md`, `sql/statements/checkpoint.md`, `operations_manual/footprint_of_duckdb/reclaiming_space.md`, `roadmap.md`, `_posts/2026-07-31-asynchronous-io.md`
- https://pypi.org/pypi/duckdb/json (release dates)
- https://registry.npmjs.org/@duckdb/node-api (README: UDFs, table functions, appender)
- `@duckdb/duckdb-wasm` 1.33.1-dev57.0 package type declarations (npm)
- https://raw.githubusercontent.com/duckdb/extension-template-rs/main/README.md
- https://github.com/dais-polymtl/flock (README, `docs/performance.mdx`, `docs/resource-management/{models,prompts}.mdx`)
- https://raw.githubusercontent.com/duckdb/community-extensions/main/extensions/flock/description.yml
- https://github.com/prasanthj/duckdb-jev (README, `docs/design.md`, `docs/live-results.md`)
- https://github.com/colliber/duckdb-jev
- https://github.com/Query-farm/vgi-typesafe
- https://github.com/kylemclaren/jevql
- https://github.com/smithclay/dbt_jev
- https://github.com/yodablocks/jev-orderby-bench
- https://github.com/lotus-data/lotus
- https://github.com/ucbepic/docetl
- https://github.com/mitdbg/palimpzest
- https://github.com/parkervg/blendsql
- https://github.com/HazyResearch/evaporate
- https://github.com/timescale/pgai
- https://github.com/AbdelStark/awesome-typesafe-jev

**Search snippets only (motherduck.com and snowflake.com blocked):**
- https://motherduck.com/docs/sql-reference/motherduck-sql-reference/ai-functions/prompt-jev/
- https://motherduck.com/blog/motherduck-supports-jev/
- https://motherduck.com/docs/sql-reference/motherduck-sql-reference/ai-functions/prompt/
- https://motherduck.com/docs/key-tasks/sharing-data/sharing-overview/
- https://docs.snowflake.com/en/release-notes/2025/other/2025-09-23-ai-filter-optimization
- https://www.snowflake.com/en/engineering-blog/cortex-aisql-query-optimization/
- https://arxiv.org/pdf/2511.07663
- https://cloud.google.com/bigquery/docs/reference/standard-sql/bigqueryml-syntax-ai-if
- https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/bigqueryml-syntax-ai-generate-bool
- https://docs.cloud.google.com/bigquery/docs/optimize-ai-functions
- https://github.com/hotdata-dev/datafusion-jev

**Tested locally:** DuckDB 1.5.5, PyArrow 25 and `@duckdb/node-api` 1.5.5-r.5 in a scratch venv. No live Jev calls were made.
