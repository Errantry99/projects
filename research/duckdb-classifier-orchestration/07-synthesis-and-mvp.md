# 07 · Synthesis and MVP spec

_Synthesis, 24 Sep 2026, from PLAN.md, docs 01–06 (workstreams A–F) and `../jev-system-one/` (README, 00, 08, 16). No new web research; evidence tags (**[opened]**, **[search]**, **[tested]**, **unverified**) are the cited document's. `dcx` is E's placeholder name._

## 1. Verdict on the concept and on H1–H5

**Overall: go, with a narrower scope.** Layers 1–2 are commodity parts: four DuckDB–Jev extensions, MotherDuck `prompt_jev()`, and Jev evaluators in LangSmith, Langfuse, Braintrust and Phoenix (A §4, E §2.1–2.2). Layer 4 has no complete competitor. That layer mines *untyped* agent traces into typed questions, shadows them and promotes them with human approval. `stuntd` learns only calls that are already typed, and `jevc` compiles prose statically (E §2.3). Five vendors could close the gap in weeks (E), so we build a thin TypeScript toolkit around adopted parts and ship the discovery loop and promotion ledger first. At personal scale the value is latency, calibration and audit; dollar savings matter only at platform-team volume (E §3.2, README).

**H1: supported for record-processing; report it by cost as well as by count.**
- B reduces filter, join, top-k, group-by and dedup to Choice/Score/Noul plus SQL.
- F finds ontology mapping "the most typed decision there is".
- In `jevc`'s sample, 16 of 32 rules were decidable (E).
- D's caution: in one tool-using case the LLM was avoided on only 2 of 22 steps. In D's Inbox example, triage is 86% of LLM calls but only ~55% of cost (illustrative).
- **Resolution:** a project passes H1 only if D's §3.11 metric shows ≥60% of calls, with the cost share reported beside it. Weeks 2–3 measure both customers.

**H2: half true.**
- Proposal works from 20–50 examples per branch (D §3.5). It must include decompositions: one phishing question scored 62.6%, and five atomic questions scored 95% [search, E].
- Validation without humans fails, because agreement with the LLM measures parity, not accuracy (D §3.6).
- The label counts disagree (D ~100–150 targeted, B ≥500, F 300–1,000) because they serve different gates:
  - ~150 targeted labels promote a *reversible* action on D's G2 and G4;
  - ~600 covered rows with zero errors are needed for an *irreversible* action at 99.5% precision (D §3.7);
  - ~500 random labels are needed before claiming calibration or comparing backends (B §3.5).
- **The settling experiment is weeks 4–6.** Discovery runs on Evidence Screener traces without seeing doc 08's hand-written questions, and we report the share of decision points that pass the gate within three versions.

**H3: refuted for the workflow journal, supported for everything else.**
- A and C agree that the file lock is the problem. A second process cannot open the file, even read-only, while a writer holds it [tested A, measured C]. The HITL page, the CLI and notebooks all need to read during runs.
- SQLite is 10–200× faster on journal-shaped access [measured C].
- D and F support DuckDB's warehouse role:
  - D: mining and gate queries are about 10 lines of SQL each;
  - F: the ontologies fit, but FTS must be rebuilt, HNSW persistence is experimental and `vss_join` is brute force.
- A had flagged the single writer as "open for C", so this is not a real disagreement. **Resolution:** a SQLite journal beside a DuckDB warehouse (§2).
- Still owed: D's benchmark of mining under 10 s at 1M trace rows (weeks 4–6).

**H4: plausible against a frontier baseline, false against a cheap one, and unmeasured.**
- Estimates for Evidence Screener: 85–92% (E).
- Estimates for Inbox Reflex: 79–85% (E), against D's ~78% on triage and ~43% for the whole agent.
- The Inbox gap comes from different assumptions. E prices drafts at $0.01 on 10% of mail; D puts drafts at 45% of spend. Inbox v0's 30-day `llm_calls` table settles it in one query.
- **D's formula sets the bar:** saving ≈ 1 − (c_judge/c_LLM + (1 − coverage) + audit). At a 5% audit and c_judge/c_LLM ≈ 0.01, **H4 needs coverage ≥ 0.86**.
- Against a small LLM, Jev is only 1.4–1.7× cheaper (00 §6). So a frontier baseline is pre-registered, and a cheap baseline is reported too (E §3.5).
- The claim is made on Evidence Screener's screening step (independent author labels; summaries identical in both arms). Inbox is the second data point, with and without drafting.

**H5: enforceable in the schema, with one grey zone.**
- B, C, D and F agree:
  - `labels.source` never takes a Jev value;
  - a `training_labels` view excludes Jev;
  - CI fails any trainer that reads Jev rows.
- D's trap: after promotion, only Jev answers most records, so the 5% LLM audit is the only clean label stream. E notes that `stuntd`'s Jev-teacher mode is exactly the banned pattern.
- **The tension:** D's G4 sends Jev–LLM *disagreements* to humans, so Jev selects what gets labelled. D and doc 16 both call this grey.
- **Resolution:**
  - labels carry `selected_by`;
  - Jev-selected labels serve evaluation only until the MCA is read;
  - customer 1 avoids the issue, because SYNERGY labels every record.
- The publication conflict (E §5) is handled the same way: publish local-backend numbers first.

## 2. The architecture as revised

```
 trace sources                         OFFLINE DISCOVERY JOB  (dcx discover / propose / shadow / gate)
 kernel runs ─────┐                    mine DFG → characterise (rule | question | generation | open)
 Agent SDK hooks ─┤                    → LLM drafts question → lint → shadow stats → G1–G8
 LangGraph mw ────┤                    → promotion card (human) → canary → active → drift → demoted
 OTel / LangSmith │                         ▲ reads                         │ writes proposals
 / Langfuse import┘                         │                               ▼
        │          ┌──────── DuckDB warehouse (exactly one dcx process opens it) ─────────┐
        └────────▶ │ records content questions judgments judge_calls judge_uses llm_calls │
      importers    │ trace_steps routes labels calibrators thresholds prices              │
                   │ decision_points proposals promotions processes [+ F ontology tables] │
                   │ views: asks · decisions · shadow_pairs · training_labels · ledger    │
                   └──────▲ exporter drains outbox ─────────────────▲ judge worker appends┘
 ┌─ KERNEL (TypeScript, embedded) ───────────┐                      │
 │ ctx.sql rule retrieve judge llm tool      │── judge ─▶ JUDGE WORKER: cache anti-join →
 │     human route; now()/random() journaled │           limiter → backends: Jev (pinned) |
 │ route: tier0 rule/compiled → tier1 judge  │           fixture | Laya | Kev/tev-local | LLM
 │  (decide = calibrator+threshold rows) →   │◀─ decide(): read-time calibration, thresholds
 │  tier2 blind LLM → human; audit 5%        │
 └──────┬────────────────────────────────────┘
        ▼ SQLite journal (many readers): runs · steps · tool_calls · hitl_queue · outbox
        ▲ local HITL page: resolve → step result + label + resume in one SQLite txn
 dcx export → *.lock.json (question defs + calibrators + thresholds + pin + DAG), runs without the kernel
```

**What the workstreams changed in PLAN's hypothesis**

| # | PLAN hypothesis | Revised | Forced by |
|---|---|---|---|
| 1 | DuckDB is the single store | SQLite (Postgres when hosted) holds the journal, HITL, tool calls and outbox. DuckDB is the warehouse, with exactly one opener. The HITL server never opens DuckDB | A §2.1, C §2.3 |
| 2 | Classifiers as SQL UDFs | One async batch worker over a SQL work list. The UDF is for notebooks only: `WHERE` evaluates it twice, async Node UDFs return wrong values, and a rollback cannot refund a charge | A [tested] |
| 3 | `decisions` table | `judgments` cache, `judge_calls` and `judge_uses`; `decisions` is a view | A, C |
| 4 | Cache key (state, question version, model version) | Projected payload hash, question hash, candidate-set hash, backend, *returned* model including settings, pack mode, sample number | A, B, E, F |
| 5 | Hashes computed in SQL | JCS canonical JSON plus sha256, computed in TS | A §6, C |
| 6 | One JUDGE layer | `ask` returns raw, cached answers; `decide` calibrates at read time and applies thresholds | B |
| 7 | Thresholds per question | Rows keyed on question hash × backend × model (plus candidate spec), with a cost matrix, a certificate and a validity interval. The 0.5 floor is a column default, not a constant in code | A, B, C |
| 8 | Adopt a durable orchestrator | A journaled kernel of ~1,500 LoC, with eight step kinds: sql, rule, retrieve, judge, llm, tool, human, route | C, F |
| 9 | Cascade left implicit | A `route` step: tiers, a blind LLM teacher, a hashed 5% audit, and budget caps that degrade to human | C, D |
| 10 | Orchestrator required | Optional. Import from OTel, LangSmith, Langfuse or JSONL; LangGraph, the Agent SDK and Mastra are trace-emitting adapters | E, C |
| 11 | Discovery runs at runtime | An offline job; the runtime needs only shadow, canary and audit modes | D |
| 12 | Promote processes | Promote decision points. A process is a DAG whose nodes each carry a status; try a SQL rule first | D |
| 13 | A compiled process needs no LLM | It keeps an LLM for the abstain band and the 5% audit | D |
| 14 | Four statuses | One lifecycle, `proposed → shadow → canary → active → demoted → retired`, shared by questions, rules, processes and concepts | D, F |
| 15 | `labels(labeller)` | `source` never Jev, plus `selected_by` and `teacher_blind`; a `training_labels` view; a CI guard | B, C, D, F |
| 16 | `traces` table | The `llm_calls` trace contract, plus a pinned OTel mapping with custom `classify` and `route` spans | C, D |
| 17 | Fixed Choice options | Options filled at runtime from `candidates`; a `retrieve` step | F |
| 18 | Build every layer | Adopt the SDK, duckdb-jev, Laya and evaluator integrations; export promoted processes as lockfiles | A, E |
| 19 | Many rows per request | One state per request unless an equivalence test passes | A, E |

**Consolidated tables** (S = SQLite, D = DuckDB; ✓ = in the MVP)

| Table | Store | Columns |
|---|---|---|
| `runs` ✓ | S | run_id, workflow, workflow_v, mode, status, input_ref, executor_id, lease_until, heartbeat_at, created_at, ended_at |
| `steps` ✓ | S | run_id, step_no, parent_step_no, kind, name, status, attempt, mode, input_ref, output, error, idempotency_key, started_at, ended_at |
| `tool_calls` ✓ | S | run_id, step_no, tool, tool_schema_hash, args_canonical, args_hash, effect_class, idempotency_key, in_doubt, result_ref |
| `hitl_queue` ✓ | S | id, kind (review / promotion), run_id, step_no, decision_point_id, question_ref, card, tiers, reason_code, priority, deadline, default_on_timeout, claimed_by, claimed_until, resolved_at, resolution, resolver, notes |
| `outbox` ✓ | S | seq, target_table, row, created_at, exported_at |
| `records` ✓ | D | record_id, kind, source, state, state_hash, received_at, ingested_at |
| `content` ✓ | D | ref, body, pii_class, retention_until |
| `questions` ✓ | D | question_id, version, question_hash, parent_hash, qtype, instructions, options (ordered), options_source (static / runtime), no_match_label, fields[], max_state_tokens, data_class, negation_of, label_compatible, status, owner, created_at |
| `judge_calls` ✓ | D | call_id, backend, model_req, model_v, request_id, n_questions, input_tokens, cost_usd, cost_basis, latency_ms, attempts, status, degraded, ts |
| `judgments` ✓ | D | the cache key (row 4) plus question_id, question_v, answer, p_answer, score, backend_confidence, probs MAP, call_id, ts |
| `judge_uses` ✓ | D | run_id, step_no, record_id, question_hash, payload_hash, candidate_set_hash, backend, model_v, mode, cache_hit, ts |
| `llm_calls` ✓ | D | the trace contract (§4.5) |
| `trace_steps` ✓ | D | a mirror of `steps` plus record_id, activity (kind:template_id), source (kernel / import:*) |
| `tool_schemas` ✓ | D | hash, name, schema |
| `routes` ✓ | D | run_id, step_no, record_id, decision_point_id, tiers, branch_taken, reason_code, threshold_id, cost_usd, mode |
| `labels` ✓ | D | label_id, record_id, target_kind, target_ref, label, source, labeller, split, selected_by, teacher_blind, ts |
| `calibrators` ✓ | D | calibrator_id, question_hash, backend, model_v, candidate_spec, method, params, n_fit, ece, ece_floor, brier, status, fitted_at |
| `thresholds` ✓ | D | threshold_id, policy_id, question_hash, backend, model_v, calibrator_id, action, rule (label, min_p, abstain band, on_error), cost_matrix, alpha, delta, certified_loss, coverage, n_cal, valid_from, valid_to, status |
| `prices` ✓ | D | backend, model, input_per_m, output_per_m, effective_from |
| `decision_points` | D | dp_id, template_fp, tool_set_hash, branch_def, n, k, entropy, med_out_tokens, cost_share, class |
| `proposals` | D | proposal_id, artefact_kind (question / rule / process / concept), artefact_ref, parent_ref, dp_id, status, evidence, gate_results, created_at, status_at |
| `promotions` | D | proposal_id, from_status, to_status, card_hash, approver, decision, reason, ts |
| `processes` | D | process_id, version, spec (DAG with node status), derived_from, lockfile_hash, status |
| `ontologies`, `concepts`, `concept_terms`, `mentions`, `candidates`, `mappings`, `concept_maps` | D | as in F §3.1 (later) |

Views: `asks` (every record × live question, with its cache key; A), `decisions` (`judge_uses` ⨝ `judgments` ⨝ calibrator ⨝ threshold, which gives p_cal, action and mode; D's `decisions.mode` lives here), `shadow_pairs` (D), `training_labels` (H5), `savings_ledger` (E §3.3).

## 3. Decisions taken

1. **TypeScript on Node 22** for the kernel, judge layer, eval, discovery and CLI, with Vitest and Biome as in the repo. Nothing in A–F forces Python in these layers (B §3.10, 00 §7).
2. **Python only where it cannot be avoided:**
   - local model servers (Kev, tev-local) and SemIf batch jobs;
   - tev1 fine-tuning;
   - embedding models for F (bge-m3, SapBERT);
   - PM4Py in offline notebooks only, because it is AGPL;
   - later, a thin LangGraph middleware that writes TraceRow JSONL.

   Python sits behind `/v1/systemone` or writes files, and never touches the journal (B §3.10, D §2.1, C §3.8).
3. **Language parity by contract.** The contract is the DDL, a TraceRow JSON Schema, JCS hashing and golden journals that any client must replay identically (C §3.8).
4. **Two stores.** SQLite (WAL) is the journal. DuckDB 1.5.x via `@duckdb/node-api` is the warehouse, written by appender or Arrow batches, with no HTTP inside UDFs. A later hosted mode uses Postgres plus DuckLake (A §2.1, C §2.3).
5. **One judge worker and cache** for all paid calls; `decisions` is a view (A §3.2).
6. **`ask` and `decide` split** (B §3.4). Calibration method by backend:
   - isotonic or binned for Jev (56% of its answers are exactly 1.0);
   - temperature for logit backends;
   - Platt for Noul.
7. **Build the kernel** (C §1).
   - Cap it at 1,800 LoC and copy DBOS's `operation_outputs` design.
   - Do not adopt LangGraph (checkpoints are opaque blobs), Temporal (a server) or DBOS TS (Postgres only).
8. **Adapters.** The Claude Agent SDK adapter comes first, because it is TypeScript (a `PreToolUse` hook plus a `SessionStore`). LangGraph follows once the owner's pipelines are accessible; Mastra later. Until then, OTel and JSONL import cover foreign traces (C §2.5, E §3.3).
9. **Backends** (B's correction to doc 15; 00 §9):
   - Jev, direct and pinned to `jev-1.13.0`;
   - fixture;
   - Laya, in-process, for nightly CI;
   - an LLM adapter for the baseline, fallback and drafting;
   - Kev or tev-local for PII, later.

   SemIf is a batch scorer, not a server.
10. **First customers** (E §3.5, D §3.12, 16 §5):
    - Evidence Screener proves H4: its labels are independent, its data is public and it runs offline.
    - Inbox Reflex is the live customer: drift, HITL, behavioural labels and a generative step that must stay an LLM.
    - Guardrail Sidecar is the trace tap, not a customer.
11. **Adopt, build, skip** (A §2.1, E §2.4).
    - **Adopt:** `@typesafe-ai/sdk`; `prasanthj/duckdb-jev` in notebooks only; Laya; ideas from jevcal (lockfile), stuntdouble (policy agreement), jev-certify (conformal thresholds) and LOTUS (cascade targets); Langfuse or Phoenix as optional OTel sinks.
    - **Build:** the registry and lint, worker, kernel, router, discovery, lifecycle, importers and lockfile export.
    - **Do not build:** a DuckDB extension, a router product, an eval UI or a workflow server.
12. **Pre-registered H4 protocol:** frozen baseline, holdout, bootstrap CIs, and both a frontier and a cheap baseline (E §3.5).
13. **H5 is enforced in the schema.** A CHECK constraint on `labels.source`, the `training_labels` view, a CI test, and `selected_by` (§1).
14. **Licence Apache-2.0.** CI rejects AGPL and ELv2 dependencies (E §3.4).
15. **OTel.** One mapping module with a pinned semconv version. Content is off; the store is the system of record (C §3.7).

## 4. MVP spec

**Scope.** Prove H4 on Evidence Screener's screening decision over SYNERGY: 6 reviews, all inclusions plus ~10× sampled exclusions, ≈3,000 records (doc 08). Also start Inbox Reflex v0 trace capture, so D's 2,000 records exist by week 6. **Out of scope:** summaries, Stage-2 full text, ontology tables, hosted mode, the Python adapter.

### 4.1 Repo layout

This is a sibling repo (default; see §8) that reuses the repo's `biome.json` and Vitest config.

```
dcx/  package.json (workspaces) · tsconfig.base.json · biome.json · vitest.workspace.ts
  packages/core/      hash.ts (JCS+sha256) · types.ts · schema/{sqlite.sql,duckdb.sql,migrate.ts}
  packages/store/     journal-sqlite.ts · warehouse-duckdb.ts · exporter.ts (outbox → DuckDB)
  packages/judge/     registry.ts · lint.ts · worker.ts · decide.ts · calibrate.ts · meter.ts ·
                      backends/{jev.ts, wire.ts (Kev/jeff/tev-local), laya.ts, llm.ts, fixture.ts}
  packages/kernel/    runctx.ts · steps/{sql,rule,retrieve,judge,llm,tool,human,route}.ts ·
                      router.ts · replay.ts · otel.ts
  packages/eval/      metrics.ts (ECE+floor, Brier, Wilson, κ) · sweep.ts · audits.ts · report-html.ts
  packages/discover/  mine.ts · characterise.ts · tree.ts · propose.ts · shadow.ts · gate.ts ·
                      card.ts · drift.ts · lockfile.ts
  packages/importers/ jsonl.ts · otel.ts   (later: langsmith.ts, langfuse.ts, claude-code.ts)
  packages/hitl/      server.ts · page.html
  packages/cli/       index.ts · commands/*.ts
  projects/evidence-screener/  workflows/baseline.ts · workflows/compiled.ts · questions/*.json · rules/
  projects/inbox-reflex/       workflows/v0.ts · questions/
  fixtures/  recorded responses keyed by cache key     conformance/  golden journals, TraceRow.schema.json
  python/    (later) dcx_langgraph/ · servers/ · notebooks/ (PM4Py)
```

### 4.2 Data model DDL (core tables; the rest follow the §2 columns)

```sql
-- SQLite (journal; WAL, synchronous=NORMAL)
CREATE TABLE runs (run_id TEXT PRIMARY KEY, workflow TEXT NOT NULL, workflow_v INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'active', status TEXT NOT NULL, input_ref TEXT, executor_id TEXT,
  lease_until INTEGER, heartbeat_at INTEGER, created_at INTEGER NOT NULL, ended_at INTEGER);
CREATE TABLE steps (run_id TEXT NOT NULL, step_no INTEGER NOT NULL, parent_step_no INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('sql','rule','retrieve','judge','llm','tool','human','route')),
  name TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, mode TEXT NOT NULL,
  input_ref TEXT, output TEXT, error TEXT, idempotency_key TEXT,
  started_at INTEGER, ended_at INTEGER, PRIMARY KEY (run_id, step_no));      -- insert-if-absent
CREATE TABLE outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, target_table TEXT NOT NULL,
  row TEXT NOT NULL, created_at INTEGER NOT NULL, exported_at INTEGER);
-- hitl_queue, tool_calls: columns as §2

-- DuckDB (warehouse)
CREATE TABLE judgments (payload_hash VARCHAR, question_hash VARCHAR, candidate_set_hash VARCHAR DEFAULT '',
  backend VARCHAR, model_v VARCHAR, pack_mode VARCHAR DEFAULT 'single', sample_no SMALLINT DEFAULT 0,
  question_id VARCHAR, question_v INTEGER, answer VARCHAR, p_answer DOUBLE, score DOUBLE,
  backend_confidence DOUBLE, probs MAP(VARCHAR, DOUBLE), call_id UUID, ts TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (payload_hash, question_hash, candidate_set_hash, backend, model_v, pack_mode, sample_no));
CREATE TABLE judge_uses (run_id VARCHAR, step_no INTEGER, record_id VARCHAR, question_hash VARCHAR,
  payload_hash VARCHAR, candidate_set_hash VARCHAR, backend VARCHAR, model_v VARCHAR,
  mode VARCHAR CHECK (mode IN ('active','shadow','canary','audit')), cache_hit BOOLEAN, ts TIMESTAMPTZ);
CREATE TABLE labels (label_id UUID DEFAULT uuid(), record_id VARCHAR, target_kind VARCHAR, target_ref VARCHAR,
  label VARCHAR, source VARCHAR CHECK (source = 'human' OR source = 'behaviour'
    OR (source LIKE 'llm:%' AND source NOT ILIKE '%jev%') OR source LIKE 'rule:%'),
  labeller VARCHAR, split VARCHAR, selected_by VARCHAR, -- random | exhaustive | reviewer | jev_disagreement
  teacher_blind BOOLEAN, ts TIMESTAMPTZ DEFAULT now());
CREATE TABLE proposals (proposal_id VARCHAR PRIMARY KEY, artefact_kind VARCHAR, artefact_ref VARCHAR,
  parent_ref VARCHAR, dp_id VARCHAR, status VARCHAR CHECK (status IN
  ('proposed','shadow','canary','active','demoted','retired')), evidence JSON, gate_results JSON,
  created_at TIMESTAMPTZ, status_at TIMESTAMPTZ);
CREATE VIEW training_labels AS SELECT * FROM labels
  WHERE source IN ('human','behaviour') AND coalesce(selected_by, '') <> 'jev_disagreement';
CREATE VIEW decisions AS
  SELECT u.*, j.answer, j.probs, j.p_answer, calibrate(c.method, c.params, j.p_answer) AS p_cal,
         c.calibrator_id                      -- calibrate(): SQL macro over the method's params
  FROM judge_uses u
  JOIN judgments j USING (payload_hash, question_hash, candidate_set_hash, backend, model_v)
  LEFT JOIN calibrators c ON (c.question_hash, c.backend, c.model_v, c.status)
                           = (u.question_hash, u.backend, u.model_v, 'active')
  WHERE j.sample_no = 0;
```

The HITL server resolves a task in one SQLite transaction: the step result, an outbox label row and the resume (C §3.5). The next `dcx` process to open DuckDB drains the outbox.

### 4.3 Kernel interface (merges C §3.8, B §3.2 and F §3.5)

```ts
export type Mode = "active" | "shadow" | "canary" | "audit";
export interface RunCtx {
  readonly runId: string; readonly mode: Mode;
  sql<T = Json>(name: string, query: string, params?: Json[]): Promise<T[]>;
  rule<T extends Json>(name: string, ref: `${string}@${number}`, inputs: Json): Promise<T>;
  retrieve(name: string, req: { ontology?: OntologyRef; query: string; spec: CandidateSpec }):
    Promise<{ candidates: Candidate[]; candidateSetHash: string }>;
  judge(name: string, req: { state: Json; questions: string[];            // "screen.crit_1@2"
    options?: Record<string, Option[]>; mode?: Mode }): Promise<Decided[]>;  // ask() → decide()
  llm<T extends Json>(name: string, req: LlmReq<T>): Promise<LlmRes<T>>;   // writes llm_calls
  tool<T extends Json>(name: string, c: { tool: string; args: Json; idempotent: boolean }): Promise<T>;
  human<T extends Json>(name: string, task: HitlTask): Promise<T>;          // durable suspend
  route<K extends string>(name: string, spec: RouteSpec<K>): Promise<Routed<K>>;
  now(): Date; random(): number;                                            // journaled
}
export interface Backend {
  readonly name: string; caps(): BackendCaps; countTokens(state: Json): number;
  ask(state: Json, qs: readonly QuestionDef[], o: AskOpts): Promise<RawDecision>;
}
export interface Decided { questionHash: string; answer: string; probs: Record<string, number>;
  pCal: number; action: string; thresholdId: string | null; calibratorId: string | null;
  cacheHit: boolean; degraded: boolean }
export interface RouteSpec<K extends string> { decisionPoint: string; state: Json; question: string;
  actions: Record<K, { thresholdRef: string }>; fallback: { llm?: LlmReq<{ answer: K }>; human?: HitlTask };
  shadow?: string[]; auditRate?: number; budgetUsd?: number }
```

`QuestionDef`, `RawDecision`, `BackendCaps`, `LlmReq` and `Journal` are as in B §3.2 and C §3.8.

### 4.4 Judge worker

```ts
export async function drain(wh: Warehouse, be: Backend, o: DrainOpts): Promise<DrainStats> {
  const work = await wh.all(WORKLIST_SQL, [be.name, o.pin]);  // asks ANTI JOIN judgments (A §3.2)
  const groups = groupBy(work, (w) => w.payload_hash);          // one state/request; questions fan out
  const buf = new FlushBuffer(wh, 1_000);                       // one txn: judge_calls + judgments
  await pool(groups, o.concurrency, rateLimiter(o.rpm, { on429: "backoff" }), async (g) => {
    meter.preflight(be.countTokens(g.payload), o.budgetUsd);   // refuse over cap; never truncate
    const raw = await be.ask(g.payload, g.questions, { timeoutMs: 10_000, maxRetries: 2 });
    if (raw.modelVersion !== o.pin) buf.flagDrift(raw);         // → degraded, human route, demote
    await buf.add(callRow(raw), raw.answers.map((a) => judgmentRow(g, a, raw)));
  });
  return buf.close();                                           // ON CONFLICT DO NOTHING
}
```

Live `judge` steps use the same code on a micro-batch queue and write `judge_uses` whether or not the cache hits. Cost is summed across retries, because the SDK has no idempotency (B §3.8).

### 4.5 Trace contract (C §3.3): `llm_calls` columns

- **Identity:** run_id, step_no, workflow@v, record_ids[], decision_point_id.
- **Prompt:** system_hash, template_id@v, template_hash (slots emptied), slots (name → path, field_hash), rendered_hash.
- **Input:** input_projection_ref → `content`, input_hash (JCS).
- **Tools:** tool_set_hash.
- **Model:** provider, model_requested, model_returned, temperature, reasoning_level, seed.
- **Output:** output_kind, parsed, normalised_answer, alternatives, raw_ref.
- **Effect:** effect and branch_taken, filled by the kernel when the downstream step completes.
- **Cost:** tokens (in, out, cache, reasoning), cost_usd, cost_basis, latency_ms, retries.
- **Provenance:** label_source, is_jev_output, teacher_blind.

Importers fill what their source carries; traces with no `effect` are classed `open`.

### 4.6 Discovery job (D §3)

| Stage | Does | Output |
|---|---|---|
| 1 Mine | DFG and variants by record; decision points = LLM activity with out-degree ≥2 or ≤255 distinct parsed outputs | `decision_points` |
| 2 Characterise | Branch defined by effect (under 2% merged into `other`); depth ≤3 tree on code features, ≥99% on holdout → `rule`; closed branch set with ≤~30 output tokens → `question`; long verbatim text → `generation`; k>255 → `open` | class, proposed type |
| 3 Propose | LLM drafts from template and 20–50 masked examples per branch; proposes decompositions plus a reducer (E); lint; dev run on 100–200 rows; up to 3 confusion-driven rewrites; projection ablation; freeze | `proposals(status=proposed)` |
| 4 Shadow | Judge runs beside the LLM; parity, ceiling κ(LLM, LLM′), human labels on disagreements (≤80) plus 50 agreements, ECE against floor, τ sweep (fixed sequence), counterfactual replay | `shadow_pairs` |
| 5 Gate | G1 volume n_min = max(300, 30k) and ≥14 days (customer 1: whole holdout); G2 κ ≥ ceiling − 0.05 and ≥ 0.8; G3 Wilson lower bound ≥ target, zero-failure bound if irreversible; G4 judge's right-share on disagreements ≥ LLM's − 10 points; G5 ECE ≤ 2× floor; G6 replay non-inferior; G7 shuffle flips < 5%, self-agreement ≥ 0.95, injection Δp within bound; G8 savings > 0 after audit | card in `hitl_queue(kind=promotion)` |
| 6 Promote / monitor | Approval → canary (10–50%, 1 week) → active; CUSUM on audit disagreement, PSI > 0.25, coverage drop > 10 points, model version ≠ pin, correction rate ×2 → demoted (LLM resumes) | `promotions`, `processes` |

Stopping rules: one futility check at n=100. After three failed versions the point is marked `keep-LLM` and re-mined after 90 days.

### 4.7 CLI

```
dcx init | migrate | lint                       dcx questions add|diff|list
dcx import synergy|jsonl|otel <src>             dcx run <workflow@v> [--mode shadow] [--records …]
dcx judge --backend jev --pin jev-1.13.0        dcx fit <question-set> --split tune
dcx eval <question-set> --split holdout         dcx review   (local HITL page; SQLite only)
dcx discover | propose <dp> | shadow <proposal> | gate <proposal> | promote|demote <proposal>
dcx monitor                                     dcx replay <run> [--fork-at k]
dcx report h4|ledger|calibration [--html]       dcx export <process> --lockfile
```

### 4.8 Hello-world demo (week 1 exit)

- **Data:** one SYNERGY review, 300 records (all inclusions plus sampled exclusions, seed 7). Author labels load as `labels(source='human', selected_by='exhaustive')`. Split 60/40 tune/holdout, stratified.
- **Questions:** written by hand from doc 08:
  - `on_topic` (Noul);
  - `crit_1…crit_k` (Choice: `meets` / `fails` / `not_stated` / `other`);
  - `study_type` (Choice);
  - `injection` (Noul).

  The state is `{untrusted_record: {title, abstract}}`. All questions share that projection, so each record costs one request.
- **Baseline:** workflow `screen-baseline@1`. A frontier LLM reads the criteria and abstract and calls `include`, `exclude` or `flag`, and the kernel records the effect.
- **Compiled:** workflow `screen-compiled@1` uses `judge`, then a rule reducer (auto-exclude only on a calibrated `fails` or `off_topic` at ≥0.99), then `route` (abstain band → blind LLM; 5% audit).

```
$ dcx init demo && dcx import synergy --review <id> --sample 300 --seed 7
$ dcx questions add projects/evidence-screener/questions/*.json    # lint: other, 1 judgment, no dates
$ dcx run screen-baseline@1 --model $BASELINE && dcx judge --backend jev --pin jev-1.13.0
$ dcx judge --backend jev --pin jev-1.13.0     # → "0 requests: 300/300 payloads cached"
$ dcx fit screen --split tune && dcx run screen-compiled@1 --split holdout && dcx report h4
H4 report · synergy/<id> · holdout n=120 (11 inclusions) · ILLUSTRATIVE, too small for a claim
                    all-LLM baseline      compiled (jev-1.13.0 + LLM fallback + 5% audit)
recall              0.91 [0.62, 0.98]     0.91 [0.62, 0.98]
coverage w/o LLM    0%                    84%
LLM calls           120                   25  (19 abstain + 6 audit)
judge requests      –                     120 (first run) · 0 (re-run)
cost / record       $0.0050               $0.0011
total               $0.60                 $0.13          saving 78%  (H4 needs ≥80% → coverage ≥0.86)
p50 latency         3.1 s                 0.45 s
```

- **What the user sees:** that table; `report.html` with reliability diagrams, ECE against its noise floor, and the risk–coverage curve; and a list of review-band records. From week 2, `dcx review` shows these as cards (projected state, each question's p_cal, reason code, keyboard approve/reject).
- **Costs are illustrative:** c_LLM ≈ $0.005 per record (E §5), judge ≈ $0.00005 (E §3.5).

## 5. Milestones

| Phase | Scope | Exit criteria | LoC (±50%) | Tests |
|---|---|---|---|---|
| **Week 1: foundation and hello world** | core (JCS, DDL, migrations); SQLite journal; DuckDB warehouse and exporter; registry and lint; worker; backends jev, fixture, llm; `decide` with isotonic and temperature; eval metrics and sweep; minimal kernel (`sql`, `rule`, `judge`, `llm`, `route`); CLI `init/import/questions/run/judge/fit/eval/report` | §4.8 runs end to end; a second judge pass makes 0 requests; the PR CI suite passes on fixtures with no key; the H5 guard test is green; the pinned model appears in every `judge_calls` row | ~2,000 | H3 (store + eval), H4 dry run |
| **Weeks 2–3: first customer, shadow mode** | Full kernel (`tool`, `human`, `retrieve` stub, leases, replay and fork, audit sampling, budget caps); HITL page; complete trace contract; OTel mapping; Laya backend and nightly CI; Evidence Screener on 6 reviews (~3,000 records) with baseline and hand-written compiled arms; H4 report with bootstrap CIs; **Inbox Reflex v0** (all-LLM, labels only) starts recording traces | Holdout recall CI not below the baseline's; saving computed from `judge_calls` + `llm_calls`; H1 decision share reported by count and cost; Inbox logging ≥50 records a day | +1,800 | **H4** (hand-compiled), H1 |
| **Weeks 4–6: discovery loop and first promotion** | importers (JSONL, OTel); mine, characterise, tree, propose, shadow, gate, card; `proposals` and `promotions`; canary; drift monitors; lockfile export; 1M-row mining benchmark | Discovery, blind to doc 08's questions, proposes questions for the screening decision point that pass G1–G8; one approved promotion to canary; lockfile replays identically; Inbox `inbox.category` in shadow; mining queries under 10 s at 1M rows | +2,200 | **H2**, H4 (discovered), H3 benchmark, H5 at promotion |
| **Later** | Inbox H4 after ≥2,000 records; Claude Agent SDK adapter and a Claude Code transcript importer (E's permission-autopilot demo); Python LangGraph adapter; LangSmith and Langfuse importers; tev-local or Kev backend for PII (doc 16 top pick); F's ontology tables and matcher (Opportunity Matcher on OSCA/ESCO); question dedup by same/related/different; lockfile runner; Postgres hosted mode | Own eval each | +3,000–5,000 | H1/H4, second project |

## 6. Test, CI and cost plan

**Unit tests (Vitest):**
- JCS hash golden vectors, shared with the Python conformance set;
- the lint rules (B §3.3), with one failing fixture per rule;
- router tiers and reason codes;
- ECE, Brier, Wilson and κ against hand-computed values;
- isotonic fitting on data tied at 1.0;
- cache-key completeness: changing any key component must miss the cache.

**Replay tests.** Golden journals in `conformance/` replay to identical outputs; fork-at-k writes only downstream rows; A's worked example reproduces (15 requests, then 0).

**Calibration tests.**
- Simulated Bernoulli(p̂) noise floors must match D's table (0.032 at n=200).
- A known miscalibrated synthetic backend must be corrected to ≤2× the floor.
- Repeat-sample rows must be excluded from `decisions`.

**Policy tests.**
- **H5:** the CI test fails if any file under `train/` or any `export --training` path reads `judgments` or `decisions` without going through `training_labels`.
- **Licences:** no AGPL or ELv2 in the dependency tree.
- **Pinning:** `jev-latest` is rejected.

**CI backends. No paid key is ever needed.**

| Tier | Backend | Runs |
|---|---|---|
| PR | `fixture`: recorded Jev and LLM responses keyed by the full cache key; a miss fails the test | every push |
| Nightly | Laya in-process (Node, pinned bundle revision; refuses states over 512 tokens) on 200 SYNERGY rows | nightly, no GPU |
| Optional | tev-local or Kev behind `/v1/systemone` (doc 16 §5), once weights and licence are verified | on a GPU machine |
| Manual | Jev, cached; results written back as new fixtures | on demand |

The CI image bundles the `fts` and `vss` extensions (`extensions.duckdb.org` returned 403, C). The matrix is DuckDB 1.5.5 plus 2.0-dev once it ships (A).

**Cost model** (own arithmetic on E's and D's estimates): c_LLM ≈ $0.005 per decision (frontier), c_judge ≈ $0.00005, coverage 0.88 and a 5% audit, so the LLM share is 0.17.

| Level | Volume | All-LLM | Compiled (judge + LLM share) | Dominant cost / limit |
|---|---|---|---|---|
| Dev / CI | fixtures, Laya | $0 | $0 | none |
| Personal (MVP) | ~15k decisions/mo (Inbox 4.5k + Screener 10k), plus three H4 runs of ~3,000 records | ~$75/mo; ~$15 per H4 baseline run (E) | ~$13/mo; ~$0.15 of Jev per run | Owner labelling time; absolute savings trivial, as E and the README say |
| Team | 100k/mo (F's S2) | ~$500/mo | ~$90/mo | Human review: 10% at 30 s ≈ 83 h/mo (F §2.3) |
| Platform | 1M/day | ~$150k/mo | ~$27k/mo | Rate limit: ~700 req/min live, plus shadow and repeat audits, nears 1,200/min (A); needs enterprise limits or a Kev GPU pool; hosted Postgres journal |

Against a cheap-LLM baseline H4 is expected to fail (00 §6), which is why the baseline is pre-registered.

## 7. Constraints & prerequisites, merged

| Item | Type | Why needed | How to get it | Blocking? | Status | Source doc |
|---|---|---|---|---|---|---|
| TypeSafe key; `jev-1.13.0` pinned; `jev-latest` banned | API key | Jev runs; thresholds depend on the version | console.typesafe.ai; lint | Yes (not for CI) | Pin verified | 00, B, C |
| MCA/AUP: distillation, "facilitate", evaluation use, Jev-selected labels, publishing, standalone service | legal-ToS | H5, the H4 report, a hosted tier | Read typesafe.ai/legal; ask TypeSafe | Yes, for training, publishing or hosting | Snippets conflict | 00, A, B, D, E, F, 16 |
| Frontier LLM key and budget; baseline pre-registered | key / decision | H4 baseline (~$15 per run); drafting | Owner | Yes | Open | E |
| SYNERGY dataset and licence | data | Customer 1 labels | `pip install synergy-dataset` | Yes | Licence unverified | E, 08 |
| Trace contract with `effect`; shadow, canary and audit modes | engineering | Without an effect there is no output space | Weeks 2–3 | Yes, for discovery | Specified | C, D |
| Provenance columns, `training_labels`, CI guard | legal / design | H5 | Week 1 | Yes | Specified | B, C, D, F |
| Labels: 50 double-labelled; ~150 per promotion; ~600 zero-error rows if irreversible; ≥500 to compare backends | data | Gates G3–G4; calibration claims | SYNERGY; owner; behaviour | Yes, for AUTO | Open | B, D, F, 00 |
| Reviewer time (~1–2 h per card) and a cost matrix per action | people / decision | Approval; threshold formula | Owner | Yes, for promotion and AUTO | Open | B, D |
| Offshore data classes (APP 8) for Jev, the drafting LLM, stored projections and clinical text | legal | Inbox PII; replay content | Redaction, TTL, local backend | Yes, for Inbox and clinical | Open | 00, B, C, D, F |
| Gmail OAuth on own GCP project; ≥2,000 v0 records (~30 days) | account / data | Customer 2; Inbox H4 | Doc 01 §5; start v0 in week 2 | Yes, for customer 2 | Open | E, D, 01 |
| Owner's LangGraph pipelines | data | Python adapter | Repo access | Adapter only | Open | C |
| Equivalence test before packing rows | eval | Batching changes answers | Batch 1 vs N | Before packing | Single-state default | A, E |
| Package location and name | decision | Repo hygiene | Owner | No | Default in §8 | B, 00, E |
| DuckDB 1.5.x pin and 2.0 syntax; extensions bundled in CI | platform | ABI; extensions.duckdb.org returned 403 | Lockfile; CI image | No | Known | A, C |
| Rate limit 1,200 req/min | platform limit | Backfills; platform tier | Cache, local backend, enterprise limits | No | Unverified | A, E, F |
| Laya bundle; Kev or tev-local weights, licence, GPU | data / hardware | Nightly CI; PII backend | Download; HF; Modal | No | Kev/tev-local unverified | B, 16 |
| Anthropic logprobs; OpenRouter request shape | platform | LLM adapter | Docs; one test call | No | Unverified | B |
| OTel semconv (Development status); optional sink | platform | Visibility | Pin a version | No | Moving | C, E |
| PM4Py (AGPL), Phoenix (ELv2), unsigned duckdb-jev binaries | licence / dependency | Embedding forbidden; notebooks only | SQL instead; sink only; allow unsigned | No | Known | A, D, E |
| Ontology licences (SNOMED CT-AU, ICD-10-AM); embedding model; FTS and HNSW rebuilds | licence / technical | F's later projects | NCTS, IHACPA; local bge-m3 | Clinical only | Partly unverified | F |
| LLM provider terms on training; WASM and MotherDuck limits | legal / platform | Surrogate path; browser and sharing tiers | Terms pages; not in the MVP | No | Snippet / known | A, D, E |

## 8. Open questions for the owner

| # | Question | Default if unanswered |
|---|---|---|
| 1 | Kernel and CLI in TypeScript? | Yes: TS on Node 22; Python only as in §3.2 |
| 2 | Where does the code live? | A sibling repo `dcx/` that reuses channel's Biome and Vitest config; nothing in channel's `src/` |
| 3 | Which baseline model defines H4? | The frontier model your agents use today; also report a cheap model |
| 4 | Customer order? | Evidence Screener, then Inbox Reflex |
| 5 | Does Inbox H4 include drafting? | Report triage-only (the claim) and whole-agent side by side |
| 6 | May your own email go to TypeSafe (US) and the drafting LLM? | Projected fields to Jev; masked examples to the LLM; no one else's data offshore |
| 7 | Cost matrix for auto-exclude and auto-archive? | $50 for a wrong action, $0.50 for a glance → τ ≈ 0.99; everything else goes to review |
| 8 | Publish H4 numbers? | Local-backend numbers only, until the MCA is read |
| 9 | May Jev-selected disagreement labels ever train anything? | No; evaluation only |
| 10 | Buy GPU time for tev-local or Kev? | Not before week 6 |
| 11 | Licence and name? | Apache-2.0; keep `dcx` as a working name |
| 12 | Weekly reviewer budget? | 2 h, on disagreement batches and cards |
| 13 | Hosted or paid tier ambitions? | None in the MVP; bring-your-own key if ever |

## 9. Sources

**Research documents, all in this directory:**
- `PLAN.md`
- `01-duckdb-store-and-sql-judge.md` (A)
- `02-classifier-layer.md` (B)
- `03-orchestration-layer.md` (C)
- `04-process-discovery.md` (D)
- `05-market-and-use-cases.md` (E)
- `06-ontology-matching.md` (F)

**From `../jev-system-one/`:**
- `README.md`
- `00-platform-jev-typesafe.md` (§1, §5–§9)
- `08-evidence-screener.md` (questions, SYNERGY)
- `16-tev1-review-and-ideas.md` (§1, §4 ideas 1–4, §5, §6)

**Repo files:** `../../package.json` and `../../biome.json` (toolchain).

No URLs were opened; external claims are cited through the documents above.
