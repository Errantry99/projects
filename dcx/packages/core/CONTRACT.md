# `@dcx/core` contract

The reference every other dcx package codes against. Read it instead of the spec where you can.
Spec: `research/duckdb-classifier-orchestration/07-synthesis-and-mvp.md` §2–§6 (the letters A–F
below are workstream docs 01–06). Source files: `src/types.ts`, `src/hash.ts`,
`src/calibrate.ts`, `src/policy.ts`, `src/migrate.ts` and `src/schema/{sqlite,duckdb}.sql`.

```ts
import { cacheKey, openWarehouse, type QuestionDef, type Backend } from "@dcx/core";
```

`@dcx/core` resolves through the npm workspace to `packages/core/src/index.ts`. Vitest and `tsx`
run the TS directly, and `npm run build` (`tsc -b`) emits `dist/`.

## 1. Rules from BUILD.md (all agents)

- Read BUILD.md, then spec §2–§6, then the sections your package cites, then this file.
- **Do not redefine shared types.** If core is missing something, add a minimal local type
  marked `// TODO(core): promote` and list it in your hand-back.
- Edit only the paths you own. Do not edit `packages/core`, the root `package.json` or the
  lockfile. Do not run `git` or `npm install`. If a dependency is missing, code against a local
  stub and say so. All deps listed in §9 are already installed.
- Each package needs these:
  - `src/index.ts` exports the public API;
  - a short `README.md`;
  - tests under `test/`, which pass with `npx vitest run` from the package directory;
  - `npx biome check .` and `npx tsc --noEmit -p .` pass from `dcx/`.
- Tests never need network or a paid key. Every test and the demo run on the `fixture` backend.
  Recorded fixtures are keyed by the **full cache key** (`cacheKeyId`), and a miss fails the test.
- Keep packages small. The kernel stays under ~1,800 LoC; week 1 has a budget of ~2,000 LoC in
  total, ±50%.
- Log every judge call with the **returned** model version. Reject `jev-latest` (use
  `assertPinned`). Never write a `labels` row whose source names Jev: the DDL rejects it, and
  tests assert that it does.
- Hand-back is ≤200 words and covers:
  - what you built;
  - test counts and results;
  - LoC;
  - anything missing from core;
  - deviations from the spec, and why;
  - any dependency you could not install.

## 2. Conventions

- **API types are camelCase** (for example `QuestionDef`, `RawDecision`, `Decided`).
- **`*Row` types are snake_case** and match a table's columns exactly, so a row can be appended
  without renaming.
- **Timestamps depend on where the row lives:**
  - SQLite uses INTEGER epoch milliseconds (`Date.now()`).
  - DuckDB uses TIMESTAMPTZ, carried in TS as ISO-8601 strings.
  - `trace_steps`, a DuckDB mirror of journal `steps`, keeps the journal's epoch-ms integers.
- **JSON columns:**
  - SQLite stores JSON text.
  - DuckDB uses `JSON`, and `probs` is `MAP(VARCHAR, DOUBLE)`.
  - TS carries both as `Json` values. The store package does the serialising.
- **Store ownership:**
  - Exactly one dcx process opens the DuckDB file.
  - The HITL server and other readers use SQLite only.
  - Warehouse writes go through appender/Arrow batches. No HTTP runs inside a UDF.

## 3. Enumerations

| Name | Values | Enforced in DDL |
|---|---|---|
| `Mode` (`MODES`) | `active` `shadow` `canary` `audit` | runs, steps, judge_uses, routes, trace_steps, llm_calls |
| `QType` (`QTYPES`); alias `Primitive` | `choice` `score` `noul` | questions, judgments |
| `LifecycleStatus` (`LIFECYCLE_STATUSES`) | `proposed → shadow → canary → active → demoted → retired` | questions, proposals, promotions, processes |
| `StepKind` (`STEP_KINDS`) | `sql` `rule` `retrieve` `judge` `llm` `tool` `human` `route` | steps, trace_steps |
| `LabelSource` | `human` · `behaviour` · `llm:<model>` · `rule:<id>`; never containing `jev` or `typesafe` (case-insensitive) | labels (and the SQLite outbox) |
| `SelectedBy` | `random` `exhaustive` `reviewer` `audit` `jev_disagreement` | labels |
| `CostBasis` | `provider-reported` `token-price` `gpu-amortised` `zero` | judge_calls, llm_calls |
| `DataClass` | `public` `internal` `pii` `sensitive` | questions, content |
| `ReasonCode` | `tier0_rule` `above_threshold` `abstain_band` `below_floor` `tier_disagreement` `audit_sample` `budget_exhausted` `judge_error` `model_drift` `no_threshold` `shadow` | no (free text) |
| `CalibratorMethod` | `identity` `temperature` `platt` `isotonic` `histogram` | calibrators |
| `OutputKind` | `tool_call` `structured` `choice_like` `text` | llm_calls |
| `RunStatus` / `StepStatus` | recommended only (`pending running suspended completed failed cancelled` / `running completed failed suspended skipped`) | no (kernel-owned) |
| `PackMode` | `single` (default) or `pack:<n>` once the equivalence test has passed | no |

**Lifecycle transitions** (`LIFECYCLE_TRANSITIONS`):

- `proposed → shadow`
- `shadow → canary`
- `canary → active | demoted`
- `active → demoted`
- `demoted → shadow`: the LLM resumes, and re-promotion needs a human.
- Any status can move to `retired`.

`LIVE_STATUSES = shadow, canary, active` are the statuses the worker asks about.

## 4. Types (`src/types.ts`)

**Primitives:** `Json`, `JsonObject`, `QuestionRef` (`"screen.crit_1@2"`), `SqlValue`.

**Questions** (B §3.2–3.3):
- `Option {label, description}`: the options are ordered. For Score they are the levels, low to high.
- `QuestionContent`: exactly what `questionHash` covers, which is what the model sees. Its fields
  are `qtype`, `instructions` (string), `options`, `noMatchLabel` and `fields`.
- `QuestionDef` extends `QuestionContent` with these fields:
  - `id`, `version`, `questionHash`, `parentHash`;
  - `optionsSource` (`static` | `runtime`);
  - `noMatchWaiver`, `maxStateTokens` (refuse above it, never truncate), `dataClass`;
  - `negationOf`, `labelCompatible`, `status`, `owner`;
  - `appliesTo` (the `records.kind`, or null for every kind), `createdAt`.
- Noul options are either empty or exactly `true` and `false`.
- Runtime-options questions carry `options: []`. Callers bind the candidates into a copy of the
  def before `ask()`.

**Candidates** (F §3.5): `OntologyRef {ontology, version}`,
`CandidateSpec {k, legs, fuse:"rrf", expandParents?}`, and
`Candidate {id, label, description, ontology?, rank?, via?, scores?}`.

**Backends** (B §3.2):
- `RawAnswer` has these fields:
  - `questionHash`, `qtype`, `answer` (B calls it `pick`), `probs`, `score?`, `backendConfidence?`;
  - `pAnswer`, which is **P("true") for Noul and P(answer) for Choice/Score**.
- `RawDecision` has these fields:
  - `backend`;
  - `modelVersion`: the returned model plus a settings digest, and never an alias;
  - `modelRequested?`, `requestId?`, `answers`;
  - `usage {inputTokens?, outputTokens?, costUsd?, basis}`;
  - `latencyMs`, `retries` (each retry is billed), `cacheHit`, `degraded?`.
- `BackendCaps`: `primitives` (a Set), `maxOptions`, `maxQuestions`, `maxStateTokens`,
  `isolatesQuestions`, `dataResidency`.
- `AskOpts`: `timeoutMs`, `maxRetries`, `signal?`, `model?` (the pin), `candidateSetHashes?`,
  `packMode?`, `sampleNo?`. The fixture backend uses the last three to rebuild the full cache
  key.
- `Backend`: `name`, `caps()`, `countTokens(state)`, `ask(state, qs, opts)`.

**Decide** (B §3.4, 07 §4.3):
- `Decided` has these fields:
  - `questionHash`, `answer`, `probs`;
  - `pCal`: the calibrated probability of the chosen answer (for Noul, the max side);
  - `action`, `thresholdId`, `calibratorId`, `cacheHit`, `degraded`;
  - optional `questionRef`, `qtype`, `pRaw`, `reason`, `backend`, `modelVersion`.
- `CalibratorParams`: `{}` | `{T}` | `{a,b}` | `{knots:[[x,y],…]}`.
- `ThresholdRule {label|null, min_p, abstain_band?, on_error}` and
  `CostMatrix {wrong_auto, human_review, llm_call, llm_error_rate}`. These are snake_case because
  they are stored as JSON.

**Kernel** (07 §4.3, C §3.8):
- `RunCtx` has `runId` and `mode`, and one method per step kind: `sql`, `rule`, `retrieve`,
  `judge`, `llm`, `tool`, `human`, `route`. It also has `now()` and `random()`, which are
  journaled.
- `Workflow {name, version, run(ctx, input)}`.
- `LlmReq {template{id,version,text}, slots{name→{path,value}}, system?, tools?, schema?, model,
  decisionPoint?, temperature?, reasoningLevel?, seed?, recordIds?, teacherBlind?}`.
- `LlmRes {value, text?, outputKind, normalisedAnswer?, alternatives?, modelReturned, usage,
  costUsd, costBasis, latencyMs, retries, callId}`.
- `HitlTask`: `kind` (`review` | `promotion`), `card`, `decisionPointId?`, `questionRef?`,
  `tiers?`, `reasonCode?`, `priority?`, `deadline?` (epoch ms), `defaultOnTimeout?`, and
  `label?`. When `label` is set, resolving the task writes a `source='human'` label.
- `RouteSpec<K>`: `decisionPoint`, `state`, `question`, `actions{K→{thresholdRef}}`,
  `fallback{llm?, human?}`, `shadow?`, `auditRate?`, `budgetUsd?`, `recordId?`.
- `Routed<K>`: `branch` (a `K` or `"human"`), `reason`, `tiers`, `costUsd`, `audited?`.
- `TierResult`: `tier` (0 to 3), `kind`, `answer`, `p`, `costUsd`, `reason?`, `thresholdId?`.
- `ToolSchema {name, description?, inputSchema}`; `JsonSchema`, which is opaque.

**Journal** (SQLite; C §3.8). All methods are async, so a Postgres journal can be added later.
- Runs: `startRun`, `getRun`, `updateRun`, `lease(executorId, ttlMs)`, `heartbeat`.
- Steps:
  - `getStep`, `listSteps`, `putStep`, where `putStep` is insert-if-absent and returns
    `"inserted" | "exists"`;
  - `completeStep(runId, stepNo, patch, outbox?)`, which updates the step and enqueues its
    warehouse rows in one transaction.
- Tool calls: `putToolCall`, `updateToolCall`.
- HITL:
  - `enqueueHuman`, `listHuman`, `claimHuman`;
  - `resolveHuman(id, res, label)`, which in one transaction resolves the row, writes the human
    step's output, enqueues the label into the outbox and makes the run resumable.
- Outbox: `enqueueOutbox`, `pendingOutbox`, `markExported`.
- `close`.

**Rows:** `RunRow`, `StepRow`, `ToolCallRow`, `HitlRow`, `OutboxRow` and `OutboxEntry`. Only
`OutboxEntry` has no table of its own: it is a `{target_table, row}` pair.

**Warehouse** (DuckDB):
- `Warehouse`:
  - `path`, `all(sql, params)`, `run(sql, params)`;
  - `appendRows(table, rows, {onConflict: "error" | "ignore"})`, where `ignore` means
    ON CONFLICT DO NOTHING, used for the judgments cache;
  - `transaction(fn)`, `close()`.
- The opener types are `WarehouseOpener` and `JournalOpener`. `@dcx/store` implements them.
- Table-name unions: `WarehouseTable`, `JournalTable`.

**Warehouse rows:**
- `RecordRow`, `ContentRow`, `QuestionRow`, `ProjectionRow`;
- `JudgeCallRow`, `CacheKeyColumns`, `JudgmentRow` (which extends `CacheKeyColumns`), `JudgeUseRow`;
- `TraceRow`, also exported as `LlmCallRow`: the `llm_calls` trace contract;
- `TraceStepRow`, `ToolSchemaRow`, `RouteRow`, `LabelRow`, `CalibratorRow`, `ThresholdRow`,
  `PriceRow`;
- `DecisionPointRow`, `ProposalRow`, `PromotionRow`, `ProcessRow`.

## 5. Hashing rules (`src/hash.ts`)

All hashes are **lowercase hex sha256 of the UTF-8 bytes of RFC 8785 (JCS) canonical JSON**. They
are computed in TS, never in SQL, so that TS and Python agree. Golden vectors are in
`dcx/conformance/jcs-vectors.json`, which Python has independently verified. Regenerate the file
with `npx tsx packages/core/scripts/write-vectors.ts`; a test fails if it drifts.

**`canonicalize(v)`** (alias `jcs`):
- Object keys are sorted by **UTF-16 code units**, not code points.
- Numbers use the ECMAScript shortest round-trip form: `-0` becomes `0`, and `1e21` becomes `1e+21`.
- Strings are escaped as `JSON.stringify` does. Non-ASCII characters, including U+2028, stay literal.
- There is no whitespace.
- These inputs throw `CanonicalizationError`: NaN, ±Infinity, lone surrogates, `undefined`
  inside arrays, BigInt, and non-plain objects such as a Date.
- Object keys whose value is `undefined` are skipped.

**Other hash helpers:**
- `sha256Hex(s)` hashes a string; `jsonHash(v)` is `sha256Hex(canonicalize(v))`. Use `jsonHash`
  for `records.state_hash`, `llm_calls.input_hash`, tool args hashes, and content refs if you
  like.
- `project(state, fields)` builds the exact state a backend receives. See its rules below.
- `payloadHash(state, fields)` = `jsonHash(project(state, fields))`.
- `fieldsKey(fields)` = JCS of the sorted, de-duplicated field list. It is the join key between
  `questions.fields_key` and `projections.fields_key`.

**How `project(state, fields)` works:**
- Paths are dot-separated object keys, with an optional leading `$.`. They cannot index arrays.
- The nesting is kept: `project({a:{b:1,c:2}}, ["a.b"])` returns `{a:{b:1}}`.
- A missing path, or one that meets a non-object before its end, is omitted. An explicit
  `null` is kept.
- If one field is a prefix of another, the shorter path wins and the whole subtree is kept.
- Field order and duplicates do not matter.

**`questionHash(def)`** = `jsonHash({scheme:"dcx/question@1", qtype, instructions,
options:[{label, description}] (in order), no_match_label, fields (sorted and deduped)})`:
- It does **not** cover id, version, status, owner, max_state_tokens, data_class, negation_of or
  applies_to.
- Any change to what it covers produces a new hash. Calibrators and thresholds keyed on the old
  hash then no longer apply.

**`candidateSetHash(cands)`**:
- It is `""` when there are no candidates, which is the case for static options and matches the
  DDL default.
- Otherwise it is `jsonHash({scheme:"dcx/candidates@1", candidates:[{id,label,description}]})`,
  which is sensitive to the order of the candidates.

**Trace-contract helpers:**
- `decisionPointId(workflow, stepName, loopKey = "")`.
- `toolSetHash(schemas)`: jsonHash each schema, sort the hashes, then hash the result.
- `modelVersionWithSettings(returned, settings?)` returns `returned`, or `returned+<12 hex>`
  when there are settings. LLM backends put the template hash and the effort level here.
- `hashUnit(s)` returns a value in [0, 1): the first 13 hex digits of sha256, divided by 2^52.
  The audit sample is `hashUnit("<salt>:" + recordId) < auditRate`.

Hashed documents carry `HASH_SCHEMES` tags (`dcx/question@1`, …), so that a future change of
rules cannot collide with today's hashes.

## 6. The cache key (07 §2 row 4)

There are seven components, which are also the `judgments` primary key, in this order
(`CACHE_KEY_COLUMNS`):

| # | Column | Meaning |
|---|---|---|
| 1 | `payload_hash` | `payloadHash(state, def.fields)`, the projected payload |
| 2 | `question_hash` | `questionHash(def)` |
| 3 | `candidate_set_hash` | `candidateSetHash(bound candidates)`; `""` for static options |
| 4 | `backend` | backend name (`jev`, `fixture`, `laya`, `llm`, …) |
| 5 | `model_v` | the **returned** model version including a settings digest; never an alias |
| 6 | `pack_mode` | `single` (default) or `pack:<n>` |
| 7 | `sample_no` | `0` in production; `>0` only for eval repeat samples, which `decisions` excludes |

- `cacheKey(parts)` validates the parts and returns `CacheKeyColumns`, filling the defaults `""`,
  `single` and `0`. It throws on non-hex hashes, an empty backend, `*-latest`, or a negative or
  non-integer `sample_no`.
- `cacheKeyId(cols)` = `jsonHash(["dcx/cache@1", …the seven values in order])`. It is the single
  string id that recorded fixtures are keyed by.
- **Before a call, the worklist uses the pin as `model_v`.** The worker's anti-join then finds
  the rows for the pin. If the returned model differs from the pin, the call is flagged as
  drift: it is marked `degraded` and routed to human, and the question is demoted.
- The test "changing any component misses the cache" lives in `test/hash.test.ts`.

## 7. Calibration semantics (`src/calibrate.ts` = DuckDB macros)

TS `calibrate(method, params, p)` and SQL `calibrate(method, params, p)` agree to 1e-9, and a
test checks it.

| Method | Params | Maps p to |
|---|---|---|
| `identity` or NULL | `{}` | p |
| `temperature` | `{T}` | sigmoid(logit(p) / T) |
| `platt` | `{a, b}` | sigmoid(a·logit(p) + b) |
| `isotonic` / `histogram` | `{knots:[[x,y],…]}` with x ascending | piecewise-linear interpolation, clamped to the end values |

- `logit` clamps p to [1e-6, 1−1e-6] (`CALIBRATION_EPS`). A null p returns null.
- In `isotonic` and `histogram`, a repeated x is a step, and the right-hand value wins. Empty
  knots mean identity.
- **Isotonic runs fully in SQL** as a macro over the JSON knot list; no TS step is needed.
  Fitting is in `@dcx/judge`.
- `calibrateProbs(method, params, probs, answer, p)`, which is SQL `calibrate_probs`, is used for
  Choice and Score. With `temperature` and at least 2 probs it uses the multiclass form
  p_answer^(1/T) / Σ p_k^(1/T), which never changes the argmax. Otherwise it applies `calibrate`
  to the chosen probability.
- `calibrateAnswer(qtype, …)` returns `{pCal, pCalAnswer}`:
  - Noul calibrates P(true) with `calibrate`, and `pCalAnswer` is the calibrated probability of
    the chosen side.
  - Choice and Score use `calibrateProbs`.
- The recommended method by backend (07 §3 item 6):
  - isotonic or histogram for Jev, because 56% of its answers are exactly 1.0;
  - temperature for logit backends;
  - Platt for Noul.

## 8. Tables and views (`src/schema/*.sql`, schema version 1)

**SQLite journal:** `runs`, `steps`, `tool_calls`, `hitl_queue`, `outbox`, `schema_migrations`.
- `steps` has PK (run_id, step_no); use insert-if-absent. It has a `kind` CHECK and a `mode`
  CHECK.
- `tool_calls` has PK (run_id, step_no).
- `hitl_queue` has `kind` CHECK (`review`, `promotion`) and an added `created_at` column.
- The `outbox` CHECK rejects any `target_table='labels'` row whose `$.source` breaks the H5 rule,
  which is defence in depth.

**DuckDB warehouse** (the ✓ tables of 07 §2, plus discovery tables that are already created):

| Table | Key and notes |
|---|---|
| `records` | PK record_id |
| `content` | PK ref |
| `questions` | PK (question_id, version); index on question_hash; `fields_key`; `applies_to` |
| `projections` | PK (record_id, fields_key) |
| `judge_calls` | PK call_id UUID; pin CHECK on model_v |
| `judgments` | PK = the cache key; pin CHECK; `qtype` |
| `judge_uses` | PK (run_id, step_no, question_hash, payload_hash, candidate_set_hash, backend); index on (run_id, step_no); `pack_mode` |
| `llm_calls` | PK call_id; the §4.5 trace contract plus `source`, `mode`, `ts`; index on (run_id, step_no) |
| `trace_steps` | PK (run_id, step_no) |
| `tool_schemas` | PK hash |
| `routes` | PK (run_id, step_no) |
| `labels` | PK label_id UUID; `source` CHECK (H5); `selected_by` CHECK |
| `calibrators` | PK calibrator_id; `candidate_spec`; method and status CHECKs |
| `thresholds` | PK threshold_id; `candidate_spec`; `floor DEFAULT 0.5` |
| `prices` | PK (backend, model, effective_from) |
| `decision_points` | discovery (weeks 4–6) |
| `proposals` | status CHECK = lifecycle |
| `promotions` | discovery (weeks 4–6) |
| `processes` | PK (process_id, version) |
| `schema_migrations` | migration bookkeeping |

**Views:**
- **`training_labels`**: labels where `source IN ('human','behaviour')` and `selected_by` is not
  `jev_disagreement`. It is the only stream a trainer may read (H5).
- **`decisions`**: `judge_uses ⨝ judgments` on the six key columns with `sample_no = 0`, left
  joined to the `active` calibrator for (question_hash, backend, model_v). It adds `p_cal`, the
  calibrated p_answer (for Noul, P(true)), and `p_cal_answer`, the chosen side, which the router
  uses. There must be at most one active calibrator per key.
- **`decision_actions`**: `decisions ⨝` the active thresholds that were valid at the use's `ts`
  and that name the same calibrator. It returns one row per (use, action) with an `outcome`:
  - `above_threshold` when `p_cal_answer ≥ min_p`;
  - `abstain_band` when p is at or above `band_lo`, where `band_lo` is `rule.abstain_band[0]`
    or else the `floor` column;
  - `below_floor` otherwise;
  - `not_applicable` when the rule's label is not the answer;
  - `error` when there is no p.
- **`asks`**: records × questions that are live (shadow, canary or active), use static options
  and match `applies_to`. It includes the cache-key columns. **`payload_hash` comes from
  `projections`**, which TS fills. A NULL means the projection is missing or stale: compute
  `project` and `payloadHash`, upsert the `projections` row, and then run the worker's
  anti-join, `asks ANTI JOIN judgments ON the key with backend=$1, model_v=$pin`.
  Runtime-options questions are not listed; they go through retrieve and judge steps.
- **`savings_ledger`** (a placeholder): per `run_id`, it reports `llm_calls` and their cost,
  judge uses and cache hits, and judge cost. Judge cost is the call cost ÷ n_questions per
  non-cached use. It also reports total cost, route counts and `coverage_without_llm`. The
  report joins `runs` from SQLite to compare workflows before and after.

**Macros:** `calibrate`, `calibrate_probs`, `dcx_interp`, `dcx_logit`, `dcx_sigmoid`,
`dcx_clamp01`.

**Opening the stores** (`src/migrate.ts`):
- `openJournal(path)` returns a better-sqlite3 `Database`, migrated, with WAL,
  synchronous=NORMAL, busy_timeout 5000 and foreign keys on.
- `openWarehouse(path, {readOnly?})` returns a `WarehouseHandle {path, instance, conn, close()}`
  and migrates unless the handle is read-only.
- `migrateSqlite(db)` and `migrateDuckdb(conn)` are idempotent. Each migration runs in one
  transaction, and they return the versions applied (`[]` when the store is current).
- `schemaSql(store)` and `migrations(store)` expose the DDL. `SCHEMA_VERSION` is 1.

## 9. Policy helpers and installed dependencies

**Policy helpers:**
- `assertPinned(model)` and `isUnpinnedModel(model)` catch `latest`, `*-latest`, `*:latest`,
  `*@latest` and `*/latest`.
- `isAllowedLabelSource(s)` mirrors the DDL rule. `TRAINING_LABEL_SOURCES` and
  `BANNED_LABEL_SOURCE_SUBSTRINGS` are exported alongside it.

**Installed dependencies** (hoisted at `dcx/node_modules`):

| Kind | Packages |
|---|---|
| Runtime | `@duckdb/node-api` 1.5.5-r.5 (DuckDB v1.5.5); `better-sqlite3` 13 (SQLite 3.53); `@typesafe-ai/sdk` 0.6.0 (`TypeSafeClient`, `choice(...)`, `client.systemOne({state, questions})`); `zod` 4; `commander` 15 |
| Development | `typescript` 7, `vitest` 5, `@biomejs/biome` 2.5, `tsx`, `@types/node` 22, `@types/better-sqlite3` |

Each placeholder `package.json` already declares the workspace and external dependencies it is
expected to need.

## 10. Where core differs from the spec, and why

- **Columns added** beyond the §2 lists:
  - `questions.fields_key` and `questions.applies_to`, plus the `projections` table. `asks` needs
    TS-computed payload hashes, and "applies to kind" comes from A §3.1.
  - `judgments.qtype`, so that Noul's P(true) can be turned into the chosen side in SQL.
  - `judge_uses.pack_mode`, so that the `decisions` join matches the full key.
  - `judge_calls.output_tokens`, for LLM backends.
  - `llm_calls.call_id`, `ts`, `source` and `mode`.
  - `thresholds.floor` (DEFAULT 0.5) and `candidate_spec` on calibrators and thresholds.
  - `hitl_queue.created_at`.
- **The H5 CHECK is stricter than §4.2's sketch.** The Jev/TypeSafe ban applies to every prefix,
  so `rule:jev_x` is rejected, and `llm:` alone is rejected.
- **`decision_actions` is a separate view.** A question can carry several actions, which would
  multiply the rows of `decisions`.
- **Not in core yet:**
  - the `shadow_pairs` view (D, weeks 4–6);
  - the ontology tables (F, later);
  - `TraceRow.schema.json` for `conformance/`;
  - the `template_hash` slot syntax, which the kernel defines.
