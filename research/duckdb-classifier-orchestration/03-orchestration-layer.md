# 03: Orchestration layer (Workstream C)

_Workstream C, 24 Sep 2026. Web search worked. duckdb.org, typesafe.ai and most blogs were blocked. GitHub, npm and PyPI worked, so packages and repos were read directly. Tags: **[opened]** means I read the page or source, **[search]** means a snippet only, and **unverified** means neither. **[measured]** marks my own test (DuckDB 1.5.5, SQLite 3.45, Python clients, 4-vCPU sandbox, one run each), so treat those numbers as order-of-magnitude only._

## 1. Summary

**Recommendation.** Build a thin kernel of about 1,200–1,800 LoC (estimate). It is a journaled-function runtime in the style of DBOS, with seven step kinds: `sql`, `rule`, `judge`, `llm`, `tool`, `human` and `route`. Keep the journal and HITL queue in **SQLite**, or Postgres when hosted. Put **DuckDB** beside it as the analytical, trace and eval store. Do not adopt LangGraph or a workflow server as the base. Treat LangGraph, the Claude Agent SDK and Mastra as **adapters**: each inserts judge and route steps and emits the same trace rows, so Workstream D can mine agents we did not write.

**Change to the hypothesis.** Split layer 1 in two:

- an **operational store** (SQLite or Postgres) for runs, the step journal, leases and the HITL queue;
- an **analytical store** (DuckDB) for decisions, traces, labels, thresholds and processes.

DuckDB-only is acceptable in one case: a single process with no separate reader, such as a batch CLI job. Mastra made the same split in shipped code. Its DuckDB store is "only observability domain available", and workflow snapshots stay in LibSQL **[opened]**.

| Hypothesis | Verdict from this layer |
|---|---|
| H3 | **Refuted for the workflow event store; supported for traces and evals.** While a writer holds a DuckDB file, a second process cannot open it, even read-only **[measured]**. Speed is not the problem, since Jev's 1,200 req/min is only ~20/s. The lock is: the HITL UI, a CLI and a notebook must all read during live runs. Multi-writer DuckDB needs Quack (beta) or DuckLake with a Postgres catalog **[opened]**. |
| H4 | The saving happens only in the `route` step. Its per-tier cost logging is what H4 gets measured on. |
| H5 | Every output carries provenance (`label_source`, `is_jev_output`), so "never train on Jev outputs" is enforced by query, not by convention. |
| H1, H2 | Not testable here. The trace contract (§3.3) is what makes them testable. |

**The three key findings.**

1. **The Jev–LangGraph glue is alpha, with a hard-coded threshold and an unpinned model.**
   - `AutoModeMiddleware` blocks at a module constant, `_PROBABILITY_THRESHOLD = 0.5`. It builds its own `TypeSafeClassifier()`, which defaults to `jev-latest`, and it omits the payload from traces **[opened]**.
   - The JS package ships no middleware **[opened]**.
   - Nothing in it records a decision that D can mine.
2. **LangGraph's persistence is a resume mechanism, not a trace.**
   - Checkpoints are msgpack BLOBs of the whole state per super-step **[opened]**.
   - The DuckDB checkpointer was abandoned in January 2025 **[opened]**.
   - Checkpoints do not supervise crashed runs **[search]**.
3. **OTel GenAI covers LLM, tool, agent and workflow spans, but not classifiers or cost** **[opened]**. Judge and route spans need a small custom namespace, and the store, not the tracing backend, must be the system of record.

## 2. Findings

### 2.1 How `langchain-typesafe` plugs Jev into LangGraph (source read)

**`TypeSafeClassifier`** is a LangChain `Runnable` over `httpx2`.

- It posts to `/v1/systemone` and keeps `x-typesafe-request-id`.
- Its defaults are `jev-latest` and a 30 s timeout.
- It tags LangSmith runs with `ls_model_type: "chat"` **[opened]**, so every Jev call counts as a chat-model call in LangSmith analytics.

**`AutoModeMiddleware`** runs in `wrap_tool_call`.

- **State sent:** the last 30 messages, plus `tool_call {id, name, args}` and the tool description.
- **Decision:** one Noul, `is_risky`. At p ≥ 0.5 it returns an error `ToolMessage`.
- **Errors:** they propagate, so it fails closed.
- **Configuration:** the threshold is not a constructor parameter. The code on master matches the release **[opened]**.

**`ModelRouterMiddleware`** asks one Choice in `before_agent`. It stores the `ChoiceAnswer` in agent state, then swaps the model in `wrap_model_call` **[opened]**.

**Open upstream work.**

| Item | What it is |
|---|---|
| #40694 | Ordering bypass |
| #40726 | No classifier injection |
| PR #40556 | Rewrite onto an injected `TypeSafeClient`; routing fails open, tool risk fails closed |

All three are open **[opened]**. The fail-open/fail-closed split in #40556 is right, and we adopt it as each step kind's `on_error` default.

**What is worth keeping.** Using the middleware as our base would still need:

- per-action thresholds from B's table;
- an injectable backend;
- a pinned model;
- a trace row per decision;
- re-judging when the request hash changes (the #40694 fix).

Each is a change around the classifier, not a use of the middleware. What we keep is the **hook points** (`wrap_tool_call`, `wrap_model_call`, `before_agent`), which is where our adapter attaches.

### 2.2 LangGraph: the right host for existing agents, the wrong kernel

**Python and JS are at parity.** Both have:

- `durability: "sync" | "async" | "exit"`;
- `interrupt()`;
- state history (`get_state_history`, `update_state`);
- SQLite and Postgres savers.

Current versions are `langgraph` 1.2.12 and `@langchain/langgraph` 1.4.17 **[opened]**.

**Time travel only sees what the checkpoint captured.** The prompt, the tool schema the model saw and the branch it caused are not fields. They exist only if the graph put them in channel state.

**Durability needs a supervisor.** A run lives in one process, so something else must detect a crash and re-enter the graph **[search: Diagrid]**. That supervisor is LangGraph Platform, or Temporal's LangGraph plugin, which is Python-only and in Public Preview **[search]**.

**The weight is misplaced.**

- A 1,000-record judge batch writes 1,000 full-state snapshots that D cannot query.
- D's compiled processes (doc 04 §3.10) are small DAGs of `sql`, `rule`, `judge` and `llm` nodes. They do not need a Pregel runtime.

### 2.3 What "durable execution over DuckDB" would require

The DBOS schema is a good reference: `workflow_status` plus `operation_outputs(workflow_uuid, function_id, function_name, output, error, child_workflow_id)` **[opened]**. Any journal needs:

1. **Deterministic step identity.** `(run_id, step_no)` in call order. The step name is stored so a replay that diverges is detected.
2. **Results persisted before return,** insert-if-absent. In DuckDB, `ON CONFLICT DO NOTHING` works, and a duplicate key raises `ConstraintException` **[measured]**.
3. **Idempotent side effects.**
   - A `tool` step gets `idempotency_key = hash(run_id, step_no)`, and a `started` row is written first so in-doubt calls are visible.
   - The result is exactly-once only if the external API honours the key. Otherwise it is at-least-once, and flagged as such.
4. **Journaled `now()`, `random()` and `uuid()`.**
5. **Leases and recovery.** Each run records `executor_id` and a heartbeat. `PENDING` runs whose lease has expired are reclaimed.
6. **Versioning.** Recovery replays only on the same workflow version; anything else forks.
7. **Durable waits.** `human` and `sleep` hold no process.
8. **A single writer.**
   - DuckDB's file lock is stricter than "one writer": **a second process failed to open the file even with `read_only=True` [measured]**.
   - Within one process, appends never conflict. Concurrent updates to the same row raise a conflict error and are retried **[opened: DuckDB docs]**.

**Measured** (2,000 rows of ~400-byte JSON):

| Operation | DuckDB 1.5.5 | SQLite WAL |
|---|---|---|
| One commit per step | 525/s | 6,000/s (`synchronous=full`); 34,500/s (`normal`) |
| One transaction, row-at-a-time binding | 959/s | not tested |
| Replay lookup (all steps of one run) | 780/s | 145,700/s |
| Second process opens while the writer is live | **fails (read-write and read-only)** | succeeds |

DuckDB is a correct journal: it is ACID with a WAL, and fast enough at Jev's rate limit. But it forces every reader into the orchestrator process, and it is 10–200× slower on OLTP-shaped access. SQLite has neither problem, and DuckDB reads SQLite through its `sqlite` extension. I could not test that, because `extensions.duckdb.org` returned 403 **[measured]**, so CI must bundle extensions. Mastra's DuckDB store documents a "Conflicting lock is held" failure on dev hot-reload **[opened]**.

**Is there a SQLite DBOS?**

| Library | SQLite support |
|---|---|
| DBOS Python | Yes: `SQLiteSystemDatabase`, with `IMMEDIATE` transactions and a 30 s busy timeout, as the zero-config default **[opened]** |
| DBOS Go | Yes **[search]** |
| DBOS TypeScript 5.0.2 | No; Postgres-only **[opened]** |
| `reflow-ts` and `iterativeflow` (small TS libraries) | Yes **[opened READMEs]**; maturity unknown |

Nothing targets DuckDB **[search]**.

### 2.4 Observability conventions, September 2026

The GenAI conventions moved to `semantic-conventions-genai` in v1.42.0 (12 Jun 2026) and are still "Development" **[search]**. What they define **[opened]**:

**Spans**

- `invoke_workflow {gen_ai.workflow.name}`.
- `chat` inference spans, which carry:
  - provider, request and response model;
  - token usage, including cache and reasoning;
  - `gen_ai.prompt.name` and `gen_ai.prompt.version`;
  - opt-in content: `gen_ai.tool.definitions`, `system_instructions` and `input`/`output.messages`;
  - `conversation.id`.
- `execute_tool` (`tool.name`, `tool.call.id`, `tool.call.arguments`/`result`, `tool.type`).
- `plan`.

**Events and content**

- A `gen_ai.evaluation.result` event with `evaluation.name`, `score.value`, `score.label` and `explanation`.
- A documented pattern for **storing content externally and putting references on spans**, which lets our store keep PII out of vendor backends.

**What is missing:** a classifier operation name and any cost attribute.

**Churn is real.** Content moved to the events-based `gen_ai.client.inference.operation.details`, and Langfuse showed null input and output for such spans until issue #12657 was closed **[opened]**.

**Backends:**

- **Langfuse** ingests OTLP over HTTP at `/api/public/otel` (no gRPC) and maps `gen_ai.*` spans to generations **[search]**.
- **LangSmith** accepts OTel **[search, dated]**.
- **Phoenix** uses OpenInference, whose span kinds include GUARDRAIL and EVALUATOR, plus `llm.prompt_template.version` and `tool.json_schema` **[opened]**.

Emitting both `gen_ai.*` and `openinference.span.kind` is cheap.

### 2.5 The Claude Agent SDK and Mastra

**Claude Agent SDK** (TS 0.3.281) **[opened]**. It is an agent executor and trace source, not a workflow engine. What it offers:

- 33 hook events, including `PreToolUse` and `PermissionRequest`, and a `canUseTool` callback;
- `resume`, `forkSession` and `rewindFiles`;
- `total_cost_usd`;
- a `SessionStore` that mirrors transcript entries about every 100 ms and treats `uuid` as an idempotency key.

`PreToolUse` is our judge insertion point, and a `SessionStore` adapter is our trace sink.

**Mastra** (1.69.0) **[search / opened]** is the most complete TS "adopt" candidate, but wider than we need.

- Workflows suspend and resume, with snapshots stored in LibSQL.
- DuckDB is used only for observability and vectors.

## 3. Design proposal

### 3.1 Shape and modes

```
workflow code ──ctx.step()──▶ KERNEL: journal · step runner · router · HITL · exporter
                                │ SQLite/Postgres: runs, steps, hitl_queue, leases, content
                                ▼ append on step completion (or ATTACH)
                             DuckDB: traces, decisions, labels, thresholds, processes ◀── B, D
adapters: LangGraph middleware / guard node · Agent SDK hooks + SessionStore · Mastra step
```

| Mode | Setup | When |
|---|---|---|
| **Embedded** (default) | One process, SQLite, and a local HITL page served by that process | All 13 projects |
| **Hosted** | Postgres, several workers, leases | When a project goes multi-user |
| **Batch-only** | DuckDB as the sole store | Allowed when there is no UI reader |

### 3.2 Step types and the rows they write

**Every step** writes one `steps` row: `run_id, step_no, parent_step_no, kind, name, status, attempt, input_ref, output_ref, error, started_at, ended_at, idempotency_key, mode`. `mode` is one of `active`, `shadow`, `canary` or `audit`, per doc 04.

**Each kind** then adds a detail row:

| Kind | Does | Detail row | On replay | `on_error` |
|---|---|---|---|---|
| `sql` | Projection or lookup in DuckDB | `query_hash`, `params_hash`, `row_count`, `result_hash` | Returns the journal value | fail |
| `rule` | Pure predicate or table lookup | `rule_id@v`, `inputs_hash`, `output` | Re-executes (pure) | fail |
| `judge` | B's `ask()` then `decide()` | One `decisions` row per question (B's schema plus `run_id`, `step_no`, `mode`) | Journal value, or B's cache | gate: fail closed; route: open to the next tier |
| `llm` | Generative or structured call | An `llm_calls` row (§3.3) | Journal value; never re-calls | retry, then fail |
| `tool` | Side effect or external read | `tool_calls`: `tool_schema_hash`, `args_canonical`, `args_hash`, `result_ref`, `effect_class`, `in_doubt` | Journal value; `in_doubt` rows go to an operator | retry only if idempotent |
| `human` | Enqueue, suspend, resume | A `hitl_queue` row, and a `labels` row on resolution | The resolution | default action on timeout |
| `route` | Cascade router (§3.4) | `routes`: `decision_point_id`, per-tier answer, p and cost, `branch_taken`, `reason_code`, `threshold_id` | Journal value | per tier |

### 3.3 The trace contract (what D mines)

D asks for template id and hash, slot provenance, raw and parsed output, model, effect and `record_id` (doc 04 §3.2). Concretely, one `llm_calls` row per LLM decision holds the following.

**Identity**

- `run_id`, `step_no`, `workflow@version`, `record_ids[]`.
- `decision_point_id` = hash(workflow, step name, loop key). For foreign agents, it is hash(agent, `template_hash`, `tool_set_hash`, position), and D may re-cluster.

**Prompt**

- `system_hash`.
- `template_id@version` and `template_hash`, computed over the static text with the slots left empty. This is what groups the same decision across records.
- `slots`: name → (JSON path, `field_hash`).
- `rendered_hash`.

**Input**

- `input_projection_ref`: the exact JSON sent, in a content table with `pii_class` and `retention_until`.
- `input_hash`, over RFC 8785 canonical JSON, so that TS and Python hash identically.

**Tools**

- `tool_set_hash`, over the sorted canonical JSON Schemas. Each schema is stored once in `tool_schemas(hash, name, schema)`.

**Model**

- `provider`, `model_requested`, `model_returned`, `temperature`, `reasoning_level`, `seed`.

**Output**

- `output_kind` ∈ {`tool_call`, `structured`, `choice_like`, `text`}.
- `parsed`: the tool and canonical args, or the validated JSON.
- `normalised_answer`: a categorical key such as a tool name or enum value.
- `alternatives`: logprobs or per-label probabilities, if any.
- `raw_ref`.
- Messages are stored in the OTel role/parts schema.

**Effect and branch**

- `effect` (the next tool call with its argument class, or the label or route chosen) and `branch_taken`.
- The kernel fills both when the downstream step completes, because it runs that step.

**Cost**

- Tokens (input, output, cache, reasoning), `cost_usd`, `cost_basis`, `latency_ms`, `retries`.

**Provenance**

- `label_source` ∈ {`human`, `llm:<model>`, `rule`, `jev`}.
- `is_jev_output`.
- `teacher_blind`.

**What each part enables.**

| Fields | What D gets |
|---|---|
| `template_hash` × `tool_set_hash` | Candidate decision points |
| Cardinality of `normalised_answer` or `effect` | The output space: ≤255 values suggests Choice; 2 suggests Noul |
| `branch_taken` | Tells decisions apart from generations |
| `input_projection_ref` + `slots` | Replay of a candidate question over history without re-running the workflow |
| Cost fields | G8 and H4, computed in SQL |

**Why content, not only hashes:** hashes alone would make shadow validation impossible.

### 3.4 The cascade router as a first-class step

```
route(dp, state, q) ─▶ tier0: compiled process / rule (status active|canary)
                    ─▶ tier1: judge → calibrated p (B's decide())
                         p ≥ τ_action            → AUTO              reason=above_threshold
                         floor ≤ p < τ_action    → tier2 LLM (blind) reason=abstain_band
                         p < floor (default 0.5) → HUMAN             reason=below_floor
                    ─▶ tier2: agrees with judge, or action reversible → act; else HUMAN  reason=tier_disagreement
                    shadow: candidate processes run effect-free, rows written with mode=shadow
```

**What "p" means.** For Noul, p is max(p, 1 − p); for Choice, it is the calibrated probability of the chosen option.

**The 0.5 floor.** From the source report, it is a column default in B's `thresholds` row, never a code constant (unlike AutoMode's). It means "coin flip on the chosen side" only after calibration, so until B certifies a threshold the router runs in `human` or `shadow` mode.

**Blind teacher.** The LLM tier never sees the judge's answer. That keeps D's agreement statistics honest (`teacher_blind = true`).

**Audit sample.** A hash of `record_id` picks D's permanent audit share (for example 5%). Those records run tier 2 even when tier 1 is confident. This is the only label stream after promotion.

**Budget.** Per-run and per-day caps; when a cap is hit, the router degrades to human, not to the LLM.

**Errors.** A judge error fails closed for gates and fails open to tier 2 for routing.

### 3.5 HITL queue and UI needs

**The table:** `hitl_queue(id, run_id, step_no, decision_point_id, question_ref, state_ref, tiers JSON, reason_code, priority, deadline, default_on_timeout, claimed_by, claimed_until, resolved_at, resolution JSON, resolver, notes)`.

**Resolving a task does three things in one transaction:**

1. writes the `human` step's result;
2. writes a `labels` row (`labeller_kind = 'human'`, `trainable = true`);
3. emits the resume event.

The queue is therefore B's and D's gold-label factory.

**UI needs.** The MVP is a local page served by the kernel; Telegram or Slack cards come later.

- Priority and deadline ordering, with a claim lease.
- Cards rendered by code (Jev gives no rationale), showing:
  - the exact projected state;
  - each tier's answer with calibrated p;
  - the reason code and proposed action.
- Approve, Edit or Reject, with keyboard shortcuts. An edit re-hashes the arguments and re-judges them, which is the #40694 lesson.
- **Batch resolution per decision point.** It is the cheapest way to buy D's 100–150 disagreement labels per question.
- Timeout defaults, audit history, and authorisation once there is more than one user.
- A `kind = 'promotion'` view for D's promotion cards.

### 3.6 Replay and time travel

| Mode | Mechanism | Used by |
|---|---|---|
| Recovery | Same version; journaled steps return stored outputs | Crash restart |
| Fork at step k | Copy steps before k, override k, run on (precedents: DBOS `fork_workflow` **[opened]**, LangGraph `update_state`) | Debugging, "what if I had approved?" |
| Counterfactual decision replay | Re-ask a candidate question over stored projections, then re-run only downstream `rule`/`sql` nodes | D's gate G6; B's re-decide after a refit |
| Timeline | `steps` by `step_no`, with a diff per step | HITL UI |

### 3.7 Span mapping

| Step | Span / `gen_ai.operation.name` | Standard attributes | Custom `jk.*` | OpenInference |
|---|---|---|---|---|
| run | `invoke_workflow {name}` | `workflow.name`; `conversation.id` = run_id | `workflow.version`, `record_ids` | CHAIN |
| llm | `chat {model}` | provider, models, usage, `prompt.name`/`version`, finish reasons | `template_hash`, `tool_set_hash`, `decision_point`, `effect`, `cost_usd`, `content_ref` | LLM |
| judge | `classify {backend}` (custom) | provider, models, `usage.input_tokens`; one `gen_ai.evaluation.result` event per question (name = question id, value = p_cal, label = answer) | `question_hash`, `p_raw`, `p_cal`, `threshold_id`, `action`, `cache_hit` | GUARDRAIL or EVALUATOR |
| route | `route {decision_point}` (custom) | — | `branch`, `reason`, `tiers`, `cost_usd` | CHAIN |
| tool | `execute_tool {tool}` | `tool.name`, `tool.call.id`, `tool.type` | `args_hash`, `idempotency_key` | TOOL |
| sql | DB semconv (`db.system.name=duckdb`) | query hashed | `result_hash` | CHAIN |
| human | Short `enqueue` span, linked to its resume span | — | `wait_ms`, `resolver_kind` | CHAIN |

**Content policy.** Content attributes are off by default. Spans carry refs to the store instead.

**Change isolation.** Pin one semconv version in a single mapping module, so convention churn touches only that module.

### 3.8 Minimal interface sketch (TypeScript)

```ts
type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type Mode = "active" | "shadow" | "canary" | "audit";

export interface Workflow<I extends Json, O extends Json> {
  name: string; version: number; run(ctx: RunCtx, input: I): Promise<O>;
}
export interface RunCtx {
  readonly runId: string;
  sql<T = Json>(name: string, query: string, params?: Json[]): Promise<T[]>;
  rule<T extends Json>(name: string, ruleRef: string, inputs: Json): Promise<T>;
  judge(name: string, req: { state: Json; questions: string[]; mode?: Mode }): Promise<Decided[]>; // B's decide()
  llm<T extends Json>(name: string, req: LlmReq<T>): Promise<LlmRes<T>>;
  tool<T extends Json>(name: string, call: { tool: string; args: Json; idempotent: boolean }): Promise<T>;
  human<T extends Json>(name: string, task: HitlTask): Promise<T>;           // suspends durably
  route<K extends string>(name: string, spec: RouteSpec<K>): Promise<Routed<K>>;
  now(): Date; random(): number;                                              // journaled
}
export interface LlmReq<T> {
  template: { id: string; version: number; text: string };                    // → template_hash
  slots: Record<string, { path: string; value: Json }>;                       // provenance for D
  tools?: ToolSchema[]; schema?: JsonSchema<T>; model: string; decisionPoint?: string;
}
export interface RouteSpec<K extends string> {
  decisionPoint: string; state: Json; question: string;                       // "inbox.category@3"
  actions: Record<K, { thresholdRef: string }>;                               // τ, band, floor, on_error as data
  fallback: { llm?: LlmReq<{ answer: K }>; human?: HitlTask };
  shadow?: string[]; auditRate?: number; budgetUsd?: number;
}
export interface Routed<K> { branch: K | "human"; reason: ReasonCode; tiers: TierResult[]; costUsd: number }

export interface Journal {                                                    // SQLite | Postgres | DuckDB (batch)
  startRun(r: RunStart): Promise<void>;
  getStep(runId: string, stepNo: number): Promise<StepRecord | null>;
  putStep(s: StepRecord): Promise<"inserted" | "exists">;                     // insert-if-absent
  lease(executorId: string, ttlMs: number): Promise<string[]>;
  enqueueHuman(t: HitlRow): Promise<void>;
  resolveHuman(id: string, res: Json, label: LabelRow): Promise<void>;        // one transaction
}
export interface TraceSink { emit(rows: TraceRow[]): Promise<void> }          // DuckDB append + OTel
```

**Adapters reuse `judge`, `route` and `TraceSink`:**

- **LangGraph:** an `AgentMiddleware` using `wrap_tool_call` (gate), `wrap_model_call` (trace and route) and `after_model` (effect capture), plus a guard node for raw `StateGraph`s.
- **Claude Agent SDK:** a `PreToolUse` hook, plus a `SessionStore` that writes `llm_calls`.

**Python parity.** Ship the contract as data:

- the DDL;
- a JSON Schema for `TraceRow`;
- JCS canonicalisation;
- a conformance suite of golden journals that both kernels must replay identically. LangGraph's `checkpoint-conformance` package is the precedent **[opened]**.

**Options for the Python kernel.**

- Port `RunCtx`, at similar LoC.
- Wrap **DBOS Python on SQLite** and write our tables inside DBOS steps. This means maintaining less code, but TS semantics are no longer identical.

**Either way, build the Python LangGraph adapter first.** The existing agents are Python LangGraph (docs 01 and 03 in `jev-system-one`), and D needs their traces before any compiled process exists.

## 4. Prior art and alternatives

| Option | Model | Store / infra | HITL | Replay | Langs | Verdict |
|---|---|---|---|---|---|---|
| **LangGraph** 1.2.12 / JS 1.4.17 **[opened]** | Pregel; checkpoint per super-step | SQLite or Postgres; DuckDB saver abandoned | `interrupt()` | History and fork; opaque blobs | Py, TS | **Adapter target, not base** |
| **Temporal** Py 1.33 / TS 1.24 **[opened]** | Event-history replay; deterministic code | Server; dev server on SQLite; 50 MB history cap **[search]** | Signals | Full replay and reset | Py, TS and more | Later, if a project goes multi-tenant |
| **DBOS** Py 3.0.0 / TS 5.0.2 **[opened]** | Library; step outputs as rows | Postgres; **SQLite in Py and Go only** | `recv`/`send` | `fork_workflow`; queryable | Py, TS, Go | **Adopt if the kernel is Python**; copy its schema in TS |
| **Inngest** TS 4.21 | Event-driven step functions | Server; self-host on SQLite by default **[search]** | `waitForEvent` | Step memo | TS, Py, Go | No, for embedded use |
| **Restate** TS 1.17.2 / Py 1.0.5 | Per-invocation journal | Single Rust binary with an embedded log **[search]** | Awakeables | Journal | TS, Py and more | Watch |
| **Prefect** 3.8.6 | Tasks with transactions and caching **[search]** | Server + DB | unverified | Cache rerun | Py | No; too coarse per record (unverified) |
| **Dagster** 1.13.24 | Asset graph | Instance DB | Limited | Re-materialise | Py | Optional scheduler for D's mining |
| **Mastra** 1.69.0 | TS workflows and agents | LibSQL; DuckDB for observability **[opened]** | Suspend/resume | Snapshots | TS | Adapter; reference design |
| **Claude Agent SDK** **[opened]** | Agent harness | JSONL plus `SessionStore` | `canUseTool`, hooks | `resume`, `forkSession` | TS, Py | Adapter |
| **Windmill** | Scripts-and-flows platform | Postgres **[search]** | Approval steps **[search]** | Job history | Many | No; a platform; licence unverified |
| **reflow-ts / iterativeflow** **[opened]** | Durable TS functions | SQLite / pluggable | Events / signals | Memo replay | TS | Read, don't depend |
| **Plain code** | Loop plus a log | Any | Manual | None | Any | The kernel is this plus a journal |

## 5. Constraints & prerequisites

| Item | Type | Why needed | How to get it | Blocking? | Status |
|---|---|---|---|---|---|
| Kernel language | decision | Decides between adopting DBOS and building our own. The platform doc says TS; the agents are Python | Synthesis | yes | open |
| SQLite as the operational store | decision | DuckDB's lock blocks UI and CLI readers | Accept §2.3 | yes | proposed |
| Access to James's LangGraph pipelines | data | Needed for the first adapter and D's first traces | Audit the repos | yes (for D) | open |
| Calibrated thresholds and floor per action (B) | engineering | Required before any AUTO route | B's harness; run in shadow until then | for AUTO | open |
| Pinned Jev; `jev-latest` banned | platform limit | `langchain-typesafe` defaults to `jev-latest` | Config lint | yes | known |
| Privacy position on storing projections and prompts (APP 8) | legal | D needs content, not only hashes | Owner decision; encryption plus TTL | yes (for D) | open |
| DuckDB extensions bundled in CI | platform limit | `extensions.duckdb.org` returned 403 | Build them into the image | no | known |
| Provenance columns | legal / design | H5 | Schema, enforced in D's queries | yes | proposed |
| OTel backend | decision | Visibility only | Try Phoenix locally | no | open |
| HITL surface | decision | It carries the label stream | Owner | no | open |
| Quack / DuckDB 2.0 | platform limit | Could later allow DuckDB-only | Re-test on release | no | watch |

## 6. Risks & open questions

**Risks.**

- **Framework creep.** Cap the kernel at about 1,800 LoC and adapt other frameworks rather than competing with them.
- **Non-deterministic workflow code.** Lint for `Date.now()` and `Math.random()`, and detect step-name mismatches on replay.
- **OTel churn.** Keep one mapping module; the store remains authoritative.
- **PII and trace volume.** Use content-addressed dedup, TTLs and redaction by `pii_class`.
- **The floor before calibration.** Stay in shadow or human mode until B certifies thresholds.
- **Label contamination.** A non-blind teacher would inflate D's agreement statistics.
- **Blind spots in ReAct loops.** The implicit decision is "which tool next", so the adapter must log `tool_set_hash` and `effect` on every model turn.

**Open questions.**

- Does D need the full rendered prompt, or only the template, slots and projection?
- In hosted mode, should DuckDB read a Postgres journal directly, or through DuckLake?
- Should D's `processes.spec` run in a kernel interpreter or be compiled to code? I lean towards the interpreter, because it is easier to shadow and version.

## 7. Sources

**Opened**

- `langchain-typesafe` 0.0.1a3 wheel (`auto_mode.py`, `model_router.py`, `classifier.py`): https://pypi.org/project/langchain-typesafe/
- `@langchain/typesafe` 0.0.1: https://registry.npmjs.org/@langchain/typesafe
- LangChain issues and PR: https://github.com/langchain-ai/langchain/issues/40694 ; https://github.com/langchain-ai/langchain/issues/40726 ; https://github.com/langchain-ai/langchain/pull/40556
- AutoMode on master: https://raw.githubusercontent.com/langchain-ai/langchain/master/libs/partners/typesafe/langchain_typesafe/experimental/middleware/auto_mode.py
- LangGraph repo (`types.py`, `pregel/main.py`, `checkpoint-sqlite`, `checkpoint-conformance`): https://github.com/langchain-ai/langgraph
- `@langchain/langgraph` 1.4.17 type declarations; https://pypi.org/project/langgraph-checkpoint-duckdb/
- DBOS Python (README, `_sys_db_sqlite.py`, `_migration.py`): https://github.com/dbos-inc/dbos-transact-py
- DBOS TypeScript: https://github.com/dbos-inc/dbos-transact-ts
- DuckDB docs source (`connect/concurrency.md`, `quack/overview.md`): https://raw.githubusercontent.com/duckdb/duckdb-web/refs/heads/main/docs/current/
- OTel GenAI conventions (`gen-ai-spans.md`, `gen-ai-agent-spans.md`, `gen-ai-events.md`, registry): https://github.com/open-telemetry/semantic-conventions-genai
- Langfuse issue: https://github.com/langfuse/langfuse/issues/12657
- PyPI `openinference-semantic-conventions` 0.1.38
- npm `@anthropic-ai/claude-agent-sdk` 0.3.281 (`sdk.d.ts`)
- npm `@mastra/duckdb` 1.10.0
- SQLite durable-execution libraries: https://github.com/danfry1/reflow-ts ; https://github.com/ahmedrowaihi/iterativeflow
- PyPI and npm registry version checks (§4)

**Search snippets**

- Diagrid on checkpoints vs durable execution: https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short-for-production-agent-workflows
- Temporal LangGraph plugin: https://temporal.io/blog/temporal-langgraph-plugin-durable-execution
- Temporal CLI server: https://docs.temporal.io/cli/server
- Temporal history limits: https://community.temporal.io/t/increase-event-history-size-and-event-history-length/13027
- DBOS Go configuration: https://docs.dbos.dev/golang/reference/configuration
- Inngest self-hosting: https://www.inngest.com/docs/self-hosting
- Restate architecture: https://docs.restate.dev/references/architecture
- Prefect transactions: https://docs-3.prefect.io/v3/develop/transactions
- Mastra suspend and resume: https://mastra.ai/en/docs/workflows/suspend-and-resume
- Mastra storage: https://mastra.ai/docs/storage
- Windmill approval steps: https://www.windmill.dev/docs/flows/flow_approval
- Langfuse OpenTelemetry: https://langfuse.com/integrations/native/opentelemetry
- LangSmith OpenTelemetry: https://www.langchain.com/blog/opentelemetry-langsmith
- OpenTelemetry GenAI observability: https://opentelemetry.io/blog/2026/genai-observability/
- Morling on a SQLite durable execution engine: https://www.morling.dev/blog/building-durable-execution-engine-with-sqlite/

**Internal**

- `../jev-system-one/00-platform-jev-typesafe.md` §4 and §7; `03-guardrail-sidecar.md`; `00-source-report.md` Part 1.
- `02-classifier-layer.md`; `04-process-discovery.md`.
