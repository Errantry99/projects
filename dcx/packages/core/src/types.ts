// Shared types for every dcx package. Section references are to the research docs in
// research/duckdb-classifier-orchestration/: 07 = synthesis & MVP spec, 01 = store (A),
// 02 = classifier layer (B), 03 = orchestration (C), 04 = discovery (D), 06 = ontology (F).
//
// Conventions:
// - API types (QuestionDef, RawDecision, Decided, ...) are camelCase.
// - `*Row` types mirror a table exactly: snake_case keys equal to column names, so a row can be
//   appended without renaming. Optional keys are nullable/defaulted columns.
// - SQLite (journal) timestamps are INTEGER epoch milliseconds. DuckDB-native timestamps are
//   TIMESTAMPTZ, carried in rows as ISO-8601 strings. DuckDB mirrors of journal rows
//   (`trace_steps`) keep the journal's epoch-ms integers.
// - JSON columns carry `Json` values; the store serialises them.

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

/** Any JSON value. 02 §3.2, 03 §3.8. `undefined` is not JSON: JCS skips undefined object keys. */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
/** A JSON object. */
export type JsonObject = { [k: string]: Json };

/** Execution mode of a run, step, judge use or route. 03 §3.2, 07 §4.3, 04 §3.1. */
export type Mode = "active" | "shadow" | "canary" | "audit";
export const MODES: readonly Mode[] = ["active", "shadow", "canary", "audit"];

/** Question type (B calls it `Primitive`). 02 §3.2, 01 §3.1. */
export type QType = "choice" | "score" | "noul";
/** Alias kept for B's naming. */
export type Primitive = QType;
export const QTYPES: readonly QType[] = ["choice", "score", "noul"];

/**
 * The one lifecycle shared by questions, rules, processes and concepts (07 §2 row 14, 04 §3.1).
 * proposed → shadow → canary → active → demoted → retired. Demotion returns the artefact to
 * shadow with the LLM resuming; re-promotion needs a human.
 */
export type LifecycleStatus =
  | "proposed"
  | "shadow"
  | "canary"
  | "active"
  | "demoted"
  | "retired";
export const LIFECYCLE_STATUSES: readonly LifecycleStatus[] = [
  "proposed",
  "shadow",
  "canary",
  "active",
  "demoted",
  "retired",
];
/** Allowed transitions. Any status may be retired. 04 §3.1, 07 §4.6 stage 6. */
export const LIFECYCLE_TRANSITIONS: Readonly<
  Record<LifecycleStatus, readonly LifecycleStatus[]>
> = {
  proposed: ["shadow", "retired"],
  shadow: ["canary", "retired"],
  canary: ["active", "demoted", "retired"],
  active: ["demoted", "retired"],
  demoted: ["shadow", "retired"],
  retired: [],
};
/** Statuses whose questions are asked by the worker (`asks` view). */
export const LIVE_STATUSES: readonly LifecycleStatus[] = ["shadow", "canary", "active"];

/** The eight kernel step kinds. 07 §2 row 8, 03 §3.2. `steps.kind` CHECK enforces this set. */
export type StepKind =
  | "sql"
  | "rule"
  | "retrieve"
  | "judge"
  | "llm"
  | "tool"
  | "human"
  | "route";
export const STEP_KINDS: readonly StepKind[] = [
  "sql",
  "rule",
  "retrieve",
  "judge",
  "llm",
  "tool",
  "human",
  "route",
];

/** Recommended run statuses (no CHECK; the kernel owns the state machine). 03 §3.2.
 *  `waiting` is a run parked on a human step (the kernel's name); `suspended` is kept as a
 *  synonym. The journal's `resolveHuman` moves either back to `pending`. */
export type RunStatus =
  | "pending"
  | "running"
  | "waiting"
  | "suspended"
  | "completed"
  | "failed"
  | "cancelled";
/** Run statuses that mean "parked on a human task". */
export const WAITING_RUN_STATUSES: readonly RunStatus[] = ["waiting", "suspended"];
/** Recommended step statuses (no CHECK). */
export type StepStatus = "running" | "completed" | "failed" | "suspended" | "skipped";

/** Data class of a question's projection or stored content. 02 §3.2, 07 §7 (APP 8). */
export type DataClass = "public" | "internal" | "pii" | "sensitive";

/** How a cost was computed. 02 §3.8. */
export type CostBasis = "provider-reported" | "token-price" | "gpu-amortised" | "zero";

/**
 * `labels.source`. Never names Jev (H5, 07 §1 and §3 item 13): the DDL CHECK rejects any source
 * containing "jev" or "typesafe", case-insensitively. `llm:<model>` and `rule:<id>` are
 * templates. See `isAllowedLabelSource` in policy.ts.
 */
export type LabelSource = "human" | "behaviour" | `llm:${string}` | `rule:${string}`;

/**
 * `labels.selected_by`: who chose the record for labelling. `jev_disagreement` labels are
 * evaluation-only and excluded from `training_labels` (07 §1 H5 resolution).
 */
export type SelectedBy = "random" | "exhaustive" | "reviewer" | "audit" | "jev_disagreement";

/** Router reason codes. 03 §3.4. */
export type ReasonCode =
  | "tier0_rule" // an active/canary compiled process or rule decided
  | "above_threshold" // p_cal ≥ τ_action → AUTO
  | "abstain_band" // floor ≤ p_cal < τ_action → tier 2 (blind LLM)
  | "below_floor" // p_cal < floor → HUMAN
  | "tier_disagreement" // tier 2 disagreed with tier 1 on an irreversible action → HUMAN
  | "audit_sample" // hashed audit share forced tier 2
  | "budget_exhausted" // a budget cap was hit → HUMAN (never the LLM)
  | "judge_error" // judge failed: gates fail closed, routes fail open to tier 2
  | "model_drift" // returned model ≠ pin → degraded → HUMAN
  | "no_threshold" // no active, certified threshold → HUMAN / shadow only
  | "shadow"; // effect-free shadow evaluation

/**
 * Pack mode, part of the cache key. `single` = one state per request (the default, 07 §2 row
 * 19). Anything else (e.g. `pack:8`) must pass the batch-1-vs-N equivalence test first.
 */
export type PackMode = "single" | `pack:${string}`;

/** A question reference used in workflow code: `"screen.crit_1@2"` (id @ version). 07 §4.3. */
export type QuestionRef = `${string}@${number}`;

// ---------------------------------------------------------------------------------------------
// Questions, options and candidates (02 §3.2–3.3, 06 §3.5)
// ---------------------------------------------------------------------------------------------

/** One answer option. Order matters and is hashed. The description must distinguish it from its
 *  neighbours (02 §3.3 lint rule 2). For Score, options are the ordered levels (low → high). */
export interface Option {
  label: string;
  description: Json;
}

/** The part of a question the model sees; exactly what `questionHash` covers (hash.ts). */
export interface QuestionContent {
  qtype: QType;
  /** Exact instruction wording; self-contained, never depends on the question id. */
  instructions: string;
  /** Ordered options. Empty when `optionsSource = "runtime"` (bound from candidates). For
   *  Noul, either empty or exactly `true`/`false` with descriptions. */
  options: readonly Option[];
  /** Required for Choice unless waived (lint rule 1): `other`, `not_stated`, `insufficient`. */
  noMatchLabel?: string | null;
  /** JSON-path allow-list projected into the state (dot paths, see `project`). */
  fields: readonly string[];
}

/** One row of the question registry (`questions`). 02 §3.2, 07 §2. */
export interface QuestionDef extends QuestionContent {
  /** Stable id, for code only; never sent to the model. e.g. `screen.crit_1`. */
  id: string;
  /** Integer version; rows are immutable, an edit is a new version. */
  version: number;
  /** sha256 over QuestionContent (hash.ts `questionHash`). The cache and all policy rows key
   *  on this, not on (id, version). */
  questionHash: string;
  /** Hash of the version this one was derived from (lineage for D's proposals). */
  parentHash?: string | null;
  /** `static` options live in the row; `runtime` options are filled from `candidates` (F). */
  optionsSource: "static" | "runtime";
  /** Reason for waiving the no-match label (lint rule 1); only when code guarantees
   *  exhaustiveness. */
  noMatchWaiver?: string;
  /** Refuse above this many state tokens, never truncate. */
  maxStateTokens: number;
  dataClass: DataClass;
  /** questionHash (or ref) of the mirrored question, enabling the complement audit. */
  negationOf?: string | null;
  /** Owner-set: labels survive this rewording (label set unchanged). 02 §3.3. */
  labelCompatible: boolean;
  status: LifecycleStatus;
  owner?: string | null;
  /** Record kind this question applies to (`records.kind`); null = every kind. From A §3.1. */
  appliesTo?: string | null;
  createdAt?: string;
}

/** Minimal ontology reference. 06 §3.5. */
export interface OntologyRef {
  ontology: string;
  version: string;
}

/** Candidate generation spec for a `retrieve` step. 06 §3.5. Versioned with thresholds. */
export interface CandidateSpec {
  k: number;
  legs: ReadonlyArray<"bm25" | "vss" | "trigram" | "synonym">;
  fuse: "rrf";
  expandParents?: number;
}

/** One retrieved candidate, bound into a runtime-options question as an Option. 06 §3.1. */
export interface Candidate {
  /** Concept id (becomes the option label unless `label` is given). */
  id: string;
  label: string;
  description: Json;
  ontology?: OntologyRef;
  rank?: number;
  via?: ReadonlyArray<"bm25" | "vss" | "trigram" | "synonym" | "parent_expand">;
  scores?: { bm25?: number; cos?: number; jw?: number; rrf?: number };
}

// ---------------------------------------------------------------------------------------------
// Backends: ask() returns raw, cacheable answers (02 §3.1–3.2)
// ---------------------------------------------------------------------------------------------

/** One question's raw answer from a backend. 02 §3.2 (`pick` there is `answer` here). */
export interface RawAnswer {
  questionHash: string;
  qtype: QType;
  /** Chosen label. Noul: "true" | "false". */
  answer: string;
  /** Per-label distribution. Noul as {"true": p, "false": 1 - p}. */
  probs: Record<string, number>;
  /** Noul: P("true"). Choice/Score: P(answer). This is `judgments.p_answer`. 01 §3.1. */
  pAnswer: number;
  /** Score only: expected level index or backend score. */
  score?: number | null;
  /** Backend's own confidence; logged, never thresholded. */
  backendConfidence?: number | null;
}

/** One backend request's result (one state, n questions). 02 §3.2. */
export interface RawDecision {
  backend: string;
  /** The *returned* model version plus a backend-settings digest; never an alias. This is
   *  `model_v` in the cache key. `jev-latest` is rejected. */
  modelVersion: string;
  /** What was requested (the pin), for drift detection. */
  modelRequested?: string;
  requestId?: string | null;
  answers: RawAnswer[];
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    basis: CostBasis;
  };
  latencyMs: number;
  /** Retries after the first attempt; each retry is billed (02 §3.8). */
  retries: number;
  cacheHit: boolean;
  /** True when modelVersion ≠ pin or the backend fell back; routes degrade to human. */
  degraded?: boolean;
}

/** What a backend supports. 02 §3.2. */
export interface BackendCaps {
  primitives: ReadonlySet<QType>;
  maxOptions: number;
  maxQuestions: number;
  maxStateTokens: number;
  /** True when questions in one request cannot see each other. */
  isolatesQuestions: boolean;
  dataResidency: "local" | "offshore";
}

/** Options for one ask() call. 02 §3.2, 07 §4.4. */
export interface AskOpts {
  timeoutMs: number;
  maxRetries: number;
  signal?: AbortSignal;
  /** The pinned model to request (e.g. `jev-1.13.0`). */
  model?: string;
  /** Cache-key components the backend cannot derive from (state, qs); the fixture backend
   *  uses them to look up recordings by the full key. Keyed by questionHash. */
  candidateSetHashes?: Readonly<Record<string, string>>;
  packMode?: PackMode;
  sampleNo?: number;
}

/**
 * A judge backend (Jev, fixture, Laya, Kev/tev-local via wire, LLM). 07 §4.3, 02 §3.2.
 * Runtime options must already be bound into each QuestionDef's `options`.
 */
export interface Backend {
  readonly name: string;
  caps(): BackendCaps;
  /** Pre-flight for caps and budgets (refuse, never truncate). */
  countTokens(state: Json): number;
  ask(state: Json, qs: readonly QuestionDef[], o: AskOpts): Promise<RawDecision>;
  /** The `model_v` a pin produces. Backends that append a settings digest (wire, llm) return
   *  `modelVersionWithSettings(pin, settings)`, so the worker's anti-join uses the `model_v`
   *  the judgments rows will carry. Absent → the pin itself. */
  modelVFor?(pin: string): string;
}

// ---------------------------------------------------------------------------------------------
// decide(): read-time calibration + thresholds (02 §3.4, 07 §4.3)
// ---------------------------------------------------------------------------------------------

/** One question's decision after calibration and thresholds. 07 §4.3. */
export interface Decided {
  questionHash: string;
  questionRef?: QuestionRef;
  qtype?: QType;
  answer: string;
  probs: Record<string, number>;
  /** Raw p_answer from the judgment. */
  pRaw?: number;
  /** Calibrated probability of the chosen answer (Noul: max side, 03 §3.4). */
  pCal: number;
  /** Action whose threshold fired, or "" / "human" when none did. */
  action: string;
  reason?: ReasonCode;
  thresholdId: string | null;
  calibratorId: string | null;
  backend?: string;
  modelVersion?: string;
  cacheHit: boolean;
  degraded: boolean;
}

/** Calibrator parameters by method. 02 §3.4. Exact semantics in calibrate.ts / CONTRACT.md. */
export type CalibratorMethod = "identity" | "temperature" | "platt" | "isotonic" | "histogram";
export type CalibratorParams =
  | Record<string, never> // identity
  | { T: number } // temperature
  | { a: number; b: number } // platt: sigmoid(a·logit(p) + b)
  | { knots: Array<[number, number]> }; // isotonic / histogram: x-ascending breakpoints

/** `thresholds.rule`. 02 §3.4. The abstain band is [floor, min_p); `abstain_band[0]`, when
 *  present, overrides the `floor` column. */
export interface ThresholdRule {
  /** Only this answer triggers the action; null = any answer. */
  label: string | null;
  min_p: number;
  abstain_band?: [number, number];
  on_error: "human" | "fail_closed" | "fail_open";
}

/** `thresholds.cost_matrix`. 02 §3.4. */
export interface CostMatrix {
  wrong_auto: number;
  human_review: number;
  llm_call: number;
  llm_error_rate: number;
}

// ---------------------------------------------------------------------------------------------
// Kernel (07 §4.3, 03 §3.8)
// ---------------------------------------------------------------------------------------------

/** A JSON Schema document (kept opaque). */
export type JsonSchema<_T = unknown> = JsonObject;

/** A tool schema offered to an LLM; hashed into `tool_set_hash`. 03 §3.3. */
export interface ToolSchema {
  name: string;
  description?: string;
  inputSchema: JsonObject;
}

/** A generative or structured LLM call. Writes one `llm_calls` row. 03 §3.8, 07 §4.5. */
export interface LlmReq<T = Json> {
  /** Static template; `template_hash` is computed with slots emptied. */
  template: { id: string; version: number; text: string };
  /** Slot provenance for D: name → JSON path into the record and the value used. */
  slots: Record<string, { path: string; value: Json }>;
  system?: string;
  tools?: ToolSchema[];
  schema?: JsonSchema<T>;
  model: string;
  decisionPoint?: string;
  temperature?: number;
  reasoningLevel?: string;
  seed?: number;
  recordIds?: string[];
  /** True for the router's tier 2: the LLM never sees the judge's answer. */
  teacherBlind?: boolean;
}

/** An LLM call's result. */
export interface LlmRes<T = Json> {
  value: T;
  text?: string;
  outputKind: "tool_call" | "structured" | "choice_like" | "text";
  normalisedAnswer?: string | null;
  alternatives?: Json;
  modelReturned: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheTokens?: number;
    reasoningTokens?: number;
  };
  costUsd: number;
  costBasis: CostBasis;
  latencyMs: number;
  retries: number;
  /** `llm_calls.call_id` of the journaled row. */
  callId: string;
}

/** A human task: enqueues a `hitl_queue` row and suspends the run durably. 03 §3.5. */
export interface HitlTask {
  kind: "review" | "promotion";
  /** Rendered by code (Jev gives no rationale): projected state, tiers, reason, action. */
  card: Json;
  decisionPointId?: string;
  questionRef?: string;
  tiers?: TierResult[];
  reasonCode?: ReasonCode;
  priority?: number;
  /** Epoch ms. */
  deadline?: number;
  defaultOnTimeout?: Json;
  /** When set, resolving the task also writes a `labels` row (source 'human'). */
  label?: { recordId: string; targetKind: string; targetRef: string; selectedBy: SelectedBy };
}

/** One router tier's outcome. 03 §3.4. */
export interface TierResult {
  tier: 0 | 1 | 2 | 3;
  kind: "rule" | "judge" | "llm" | "human";
  answer: string | null;
  p: number | null;
  costUsd: number;
  reason?: ReasonCode;
  thresholdId?: string | null;
}

/** One action a route may take. 07 §4.3, 03 §3.4. */
export interface RouteAction {
  /** A `thresholds.threshold_id`, or a `thresholds.policy_id` shared by one row per question
   *  (the router picks the row for the judged question). Absent: tier 1 never auto-takes this
   *  action, but tier 2 (the LLM) may. */
  thresholdRef?: string;
  /** Tier 2 may take this action even when it disagrees with tier 1's candidate. */
  reversible?: boolean;
}

/** A `route` step: cascade router over tiers. 07 §4.3, 03 §3.4. */
export interface RouteSpec<K extends string> {
  decisionPoint: string;
  state: Json;
  /** Question ref, e.g. `"inbox.category@3"`. */
  question: string;
  /** τ, band, floor and on_error live in the threshold row, never in code. Keys are the
   *  branches the route can take; not every branch needs a threshold. */
  actions: Partial<Record<K, RouteAction>>;
  /** Tier 1 when the judge's answer maps to no action: `human` (default; reason no_threshold)
   *  or `llm` (tier 2 decides with no candidate; reason abstain_band). */
  onUnmapped?: "human" | "llm";
  fallback: { llm?: LlmReq<{ answer: K }>; human?: HitlTask };
  /** Candidate processes/questions evaluated effect-free (mode shadow). */
  shadow?: string[];
  /** Hashed audit share on record id (e.g. 0.05). */
  auditRate?: number;
  budgetUsd?: number;
  recordId?: string;
}

/** A route's outcome. 03 §3.8. */
export interface Routed<K extends string> {
  branch: K | "human";
  reason: ReasonCode;
  tiers: TierResult[];
  costUsd: number;
  audited?: boolean;
}

/** The per-run context workflow code calls. Every method is one journaled step. 07 §4.3. */
export interface RunCtx {
  readonly runId: string;
  readonly mode: Mode;
  sql<T = Json>(name: string, query: string, params?: Json[]): Promise<T[]>;
  rule<T extends Json>(name: string, ref: `${string}@${number}`, inputs: Json): Promise<T>;
  retrieve(
    name: string,
    req: { ontology?: OntologyRef; query: string; spec: CandidateSpec },
  ): Promise<{ candidates: Candidate[]; candidateSetHash: string }>;
  judge(
    name: string,
    req: {
      state: Json;
      questions: string[];
      options?: Record<string, Option[]>;
      mode?: Mode;
      /** Fills `judge_uses.record_id` (and the step's trace record). */
      recordId?: string;
    },
  ): Promise<Decided[]>;
  llm<T extends Json>(name: string, req: LlmReq<T>): Promise<LlmRes<T>>;
  tool<T extends Json>(
    name: string,
    c: { tool: string; args: Json; idempotent: boolean },
  ): Promise<T>;
  human<T extends Json>(name: string, task: HitlTask): Promise<T>;
  route<K extends string>(name: string, spec: RouteSpec<K>): Promise<Routed<K>>;
  /** Journaled: replay returns the recorded value. */
  now(): Date;
  /** Journaled: replay returns the recorded value. */
  random(): number;
}

/** A workflow definition. 03 §3.8. */
export interface Workflow<I extends Json = Json, O extends Json = Json> {
  name: string;
  version: number;
  run(ctx: RunCtx, input: I): Promise<O>;
}

// ---------------------------------------------------------------------------------------------
// Journal rows (SQLite) and interface. 07 §2, §4.2; 03 §3.8
// ---------------------------------------------------------------------------------------------

/** `runs`. */
export interface RunRow {
  run_id: string;
  workflow: string;
  workflow_v: number;
  mode: Mode;
  status: RunStatus | string;
  /** Where the run's input lives. Convention (`RUN_INPUT_INLINE`): `inline:<JCS>` holds the
   *  input (and kernel run metadata) inline; any other value is a `content.ref`. See
   *  `encodeRunInput` / `decodeRunInput` in hash.ts. */
  input_ref?: string | null;
  executor_id?: string | null;
  lease_until?: number | null;
  heartbeat_at?: number | null;
  created_at: number;
  ended_at?: number | null;
}

/** `steps`. Insert-if-absent on (run_id, step_no). `output` is JSON text in SQLite. */
export interface StepRow {
  run_id: string;
  step_no: number;
  parent_step_no?: number | null;
  kind: StepKind;
  name: string;
  status: StepStatus | string;
  attempt?: number;
  mode: Mode;
  input_ref?: string | null;
  output?: Json;
  error?: string | null;
  idempotency_key?: string | null;
  started_at?: number | null;
  ended_at?: number | null;
}

/** `tool_calls`. 03 §3.2. */
export interface ToolCallRow {
  run_id: string;
  step_no: number;
  tool: string;
  tool_schema_hash?: string | null;
  /** JCS of the args. */
  args_canonical: string;
  args_hash: string;
  /** e.g. read | idempotent_write | write | irreversible. */
  effect_class?: string | null;
  idempotency_key?: string | null;
  in_doubt?: boolean;
  result_ref?: string | null;
}

/** `hitl_queue`. 07 §2, 03 §3.5. */
export interface HitlRow {
  id: string;
  kind: "review" | "promotion";
  run_id?: string | null;
  step_no?: number | null;
  decision_point_id?: string | null;
  question_ref?: string | null;
  card: Json;
  tiers?: Json;
  reason_code?: ReasonCode | string | null;
  priority?: number;
  deadline?: number | null;
  default_on_timeout?: Json;
  claimed_by?: string | null;
  claimed_until?: number | null;
  resolved_at?: number | null;
  resolution?: Json;
  resolver?: string | null;
  notes?: string | null;
  created_at: number;
}

/** `outbox`: rows bound for a DuckDB table, drained by the exporter. `row` is a JSON object
 *  whose keys are that table's columns. */
export interface OutboxRow {
  seq: number;
  target_table: WarehouseTable;
  row: JsonObject;
  created_at: number;
  exported_at?: number | null;
}

/** An outbox entry to write in the same SQLite transaction as a step. */
export interface OutboxEntry {
  target_table: WarehouseTable;
  row: JsonObject;
}

/** SQLite journal table names. */
export type JournalTable = "runs" | "steps" | "tool_calls" | "hitl_queue" | "outbox";

/**
 * The journal (SQLite now; Postgres when hosted). 03 §3.8. Many readers; the HITL server
 * uses only this, never DuckDB. Compound methods are one transaction each.
 */
export interface Journal {
  // runs
  startRun(r: RunRow): Promise<"inserted" | "exists">;
  getRun(runId: string): Promise<RunRow | null>;
  updateRun(
    runId: string,
    patch: Partial<Pick<RunRow, "status" | "ended_at" | "executor_id" | "lease_until">>,
  ): Promise<void>;
  /** Claim runs whose lease has expired (or that are unleased and resumable). */
  lease(executorId: string, ttlMs: number): Promise<string[]>;
  heartbeat(runId: string, executorId: string, ttlMs: number): Promise<boolean>;
  // steps
  getStep(runId: string, stepNo: number): Promise<StepRow | null>;
  listSteps(runId: string): Promise<StepRow[]>;
  /** Insert-if-absent. */
  putStep(s: StepRow): Promise<"inserted" | "exists">;
  /** Finish a step and enqueue its warehouse rows (llm_calls, judge_uses, routes, ...) in one
   *  transaction. */
  completeStep(
    runId: string,
    stepNo: number,
    patch: Pick<StepRow, "status"> & Partial<Pick<StepRow, "output" | "error" | "ended_at">>,
    outbox?: readonly OutboxEntry[],
  ): Promise<void>;
  // tool calls
  putToolCall(t: ToolCallRow): Promise<"inserted" | "exists">;
  updateToolCall(
    runId: string,
    stepNo: number,
    patch: Partial<Pick<ToolCallRow, "in_doubt" | "result_ref">>,
  ): Promise<void>;
  // HITL
  enqueueHuman(t: HitlRow): Promise<void>;
  listHuman(filter?: { kind?: HitlRow["kind"]; unresolvedOnly?: boolean }): Promise<HitlRow[]>;
  claimHuman(id: string, claimer: string, ttlMs: number): Promise<boolean>;
  /** One transaction: resolve the task, write the human step's result, enqueue the label row
   *  (outbox → labels) and mark the run resumable. 07 §4.2, 03 §3.5. */
  resolveHuman(
    id: string,
    res: { resolution: Json; resolver: string; notes?: string; at: number },
    label: LabelRow | null,
  ): Promise<void>;
  // outbox
  enqueueOutbox(entries: readonly OutboxEntry[]): Promise<number[]>;
  pendingOutbox(limit: number): Promise<OutboxRow[]>;
  markExported(seqs: readonly number[], at: number): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Warehouse (DuckDB). 07 §2, §3 item 4
// ---------------------------------------------------------------------------------------------

/** DuckDB warehouse table names (07 §2 plus `projections`, see CONTRACT.md). */
export type WarehouseTable =
  | "records"
  | "content"
  | "questions"
  | "projections"
  | "judge_calls"
  | "judgments"
  | "judge_uses"
  | "llm_calls"
  | "trace_steps"
  | "tool_schemas"
  | "routes"
  | "labels"
  | "calibrators"
  | "thresholds"
  | "prices"
  | "decision_points"
  | "proposals"
  | "promotions"
  | "processes";

/** A row for `appendRows`: keys are column names, values `SqlValue | undefined`. `object` so
 *  interface rows (`JudgmentRow`, ...) pass without a cast (they have no index signature). */
export type AppendRow = object;

/** A value bindable as a SQL parameter or appended into a column. */
export type SqlValue =
  | string
  | number
  | boolean
  | null
  | bigint
  | Date
  | readonly SqlValue[]
  | { [k: string]: SqlValue };

/**
 * The DuckDB warehouse. Exactly one dcx process opens it (07 §2 row 1); writes go through
 * appendRows (appender / Arrow batches), never HTTP inside a UDF.
 */
export interface Warehouse {
  readonly path: string;
  all<T = Record<string, Json>>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  run(sql: string, params?: readonly SqlValue[]): Promise<void>;
  /** Batch-append rows (keys = column names). `onConflict: "ignore"` = ON CONFLICT DO NOTHING
   *  (the judgments cache). Returns rows written. */
  appendRows(
    table: WarehouseTable,
    rows: readonly AppendRow[],
    opts?: { onConflict?: "error" | "ignore" },
  ): Promise<number>;
  transaction<T>(fn: (wh: Warehouse) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Opens (and migrates) a Warehouse; implemented by @dcx/store over core's `openWarehouse`. */
export type WarehouseOpener = (
  path: string,
  opts?: { readOnly?: boolean },
) => Promise<Warehouse>;
/** Opens (and migrates) a Journal; implemented by @dcx/store over core's `openJournal`. */
export type JournalOpener = (path: string) => Promise<Journal>;

// ---------------------------------------------------------------------------------------------
// Warehouse rows (DuckDB). Columns per 07 §2 and §4.2
// ---------------------------------------------------------------------------------------------

/** `records`. */
export interface RecordRow {
  record_id: string;
  kind: string;
  source: string;
  state: Json;
  /** jsonHash(state). */
  state_hash: string;
  received_at?: string | null;
  ingested_at?: string;
}

/** `content`: exact projections sent, prompts, raw outputs. 03 §3.3. */
export interface ContentRow {
  ref: string;
  body: Json;
  pii_class?: DataClass | null;
  retention_until?: string | null;
}

/** `questions` (the registry row form of QuestionDef). */
export interface QuestionRow {
  question_id: string;
  version: number;
  question_hash: string;
  parent_hash?: string | null;
  qtype: QType;
  instructions: string;
  options: Option[];
  options_source: "static" | "runtime";
  no_match_label?: string | null;
  fields: string[];
  /** fieldsKey(fields): joins to projections. */
  fields_key: string;
  max_state_tokens: number;
  data_class: DataClass;
  negation_of?: string | null;
  label_compatible?: boolean;
  status: LifecycleStatus;
  owner?: string | null;
  applies_to?: string | null;
  created_at?: string;
}

/** `projections`: TS-computed projected payloads (JCS + sha256 cannot run in SQL). */
export interface ProjectionRow {
  record_id: string;
  fields_key: string;
  state_hash: string;
  payload_hash: string;
  payload: JsonObject;
}

/** `judge_calls`: one row per backend request (retries summed). 07 §2. */
export interface JudgeCallRow {
  call_id: string;
  backend: string;
  model_req?: string | null;
  /** Returned model version; never an alias. */
  model_v: string;
  request_id?: string | null;
  n_questions: number;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: number | null;
  cost_basis: CostBasis;
  latency_ms?: number | null;
  attempts: number;
  status: "ok" | "error" | "refused" | "timeout" | string;
  degraded?: boolean;
  ts?: string;
}

/** The seven cache-key columns. 07 §2 row 4. See hash.ts `cacheKey`. */
export interface CacheKeyColumns {
  payload_hash: string;
  question_hash: string;
  /** "" for static options. */
  candidate_set_hash: string;
  backend: string;
  /** Returned model incl. settings digest. */
  model_v: string;
  pack_mode: PackMode;
  /** 0 for production; >0 only for eval repeat samples (excluded from `decisions`). */
  sample_no: number;
}

/** `judgments`: the immutable, content-addressed cache. 07 §4.2. */
export interface JudgmentRow extends CacheKeyColumns {
  question_id: string;
  question_v: number;
  qtype: QType;
  answer: string;
  /** Noul: P(true). Choice/Score: P(answer). */
  p_answer: number;
  score?: number | null;
  backend_confidence?: number | null;
  probs: Record<string, number>;
  call_id: string;
  ts?: string;
}

/** `judge_uses`: one row per judge use, cache hit or not. 07 §2, §4.4. */
export interface JudgeUseRow {
  run_id: string;
  step_no: number;
  record_id?: string | null;
  question_hash: string;
  payload_hash: string;
  candidate_set_hash: string;
  backend: string;
  model_v: string;
  pack_mode?: PackMode;
  mode: Mode;
  cache_hit: boolean;
  ts?: string;
}

/** Output kind of an LLM call. 03 §3.3. */
export type OutputKind = "tool_call" | "structured" | "choice_like" | "text";

/**
 * `llm_calls`: the trace contract, one row per LLM decision. 07 §4.5, 03 §3.3. Importers fill
 * what their source carries; rows with no `effect` are classed `open` by discovery.
 */
export interface TraceRow {
  call_id: string;
  ts?: string;
  /** kernel | import:otel | import:jsonl | import:langsmith ... */
  source?: string;
  mode?: Mode | null;
  // Identity
  run_id: string;
  step_no?: number | null;
  workflow?: string | null;
  workflow_v?: number | null;
  record_ids?: string[];
  /** hash(workflow, step name, loop key) — see hash.ts decisionPointId. */
  decision_point_id?: string | null;
  // Prompt
  system_hash?: string | null;
  template_id?: string | null;
  template_v?: number | null;
  /** Over the static template text with slots emptied. */
  template_hash?: string | null;
  /** name → {path, field_hash}. */
  slots?: Record<string, { path: string; field_hash: string }> | null;
  rendered_hash?: string | null;
  // Input
  /** → content.ref holding the exact JSON sent. */
  input_projection_ref?: string | null;
  /** jsonHash of the input (JCS). */
  input_hash?: string | null;
  // Tools
  /** toolSetHash over the sorted canonical schemas. */
  tool_set_hash?: string | null;
  // Model
  provider?: string | null;
  model_requested?: string | null;
  model_returned?: string | null;
  temperature?: number | null;
  reasoning_level?: string | null;
  seed?: number | null;
  // Output
  output_kind?: OutputKind | null;
  parsed?: Json;
  normalised_answer?: string | null;
  alternatives?: Json;
  raw_ref?: string | null;
  // Effect (filled by the kernel when the downstream step completes)
  effect?: Json;
  branch_taken?: string | null;
  // Cost
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_tokens?: number | null;
  reasoning_tokens?: number | null;
  cost_usd?: number | null;
  cost_basis?: CostBasis | null;
  latency_ms?: number | null;
  retries?: number | null;
  // Provenance
  /** human | llm:<model> | rule | jev (here "jev" is allowed: it describes the trace, not a
   *  training label). */
  label_source?: string | null;
  is_jev_output?: boolean;
  teacher_blind?: boolean | null;
}
/** Alias: the `llm_calls` row. */
export type LlmCallRow = TraceRow;

/** `trace_steps`: a mirror of journal `steps` plus mining columns. 07 §2. */
export interface TraceStepRow extends Omit<StepRow, "output"> {
  output?: Json;
  record_id?: string | null;
  /** kind:template_id, the process-mining activity. */
  activity: string;
  /** kernel | import:* */
  source: string;
}

/** `tool_schemas`. */
export interface ToolSchemaRow {
  hash: string;
  name: string;
  schema: Json;
}

/** `routes`: one row per route step. 03 §3.2, 07 §2. */
export interface RouteRow {
  run_id: string;
  step_no: number;
  record_id?: string | null;
  decision_point_id: string;
  tiers: TierResult[] | Json;
  branch_taken: string;
  reason_code: ReasonCode | string;
  threshold_id?: string | null;
  cost_usd?: number | null;
  mode: Mode;
  ts?: string;
}

/** `labels`. `source` never names Jev (DDL CHECK). 07 §4.2. */
export interface LabelRow {
  label_id?: string;
  record_id: string;
  /** e.g. question | route | mapping | process. */
  target_kind: string;
  /** e.g. question hash or `id@v`. */
  target_ref: string;
  label: string;
  source: LabelSource;
  labeller?: string | null;
  /** tune | holdout | dev | ... */
  split?: string | null;
  selected_by?: SelectedBy | null;
  teacher_blind?: boolean | null;
  ts?: string;
}

/** `calibrators`. 07 §2, 02 §3.4. At most one `active` row per (question_hash, backend,
 *  model_v, candidate_spec). */
export interface CalibratorRow {
  calibrator_id: string;
  question_hash: string;
  backend: string;
  model_v: string;
  candidate_spec?: string;
  method: CalibratorMethod;
  params: CalibratorParams;
  n_fit?: number | null;
  ece?: number | null;
  ece_floor?: number | null;
  brier?: number | null;
  status: "candidate" | "active" | "stale" | "retired";
  fitted_at?: string;
}

/** `thresholds`. 07 §2 row 7, 02 §3.4. */
export interface ThresholdRow {
  threshold_id: string;
  policy_id: string;
  question_hash: string;
  backend: string;
  model_v: string;
  candidate_spec?: string;
  calibrator_id?: string | null;
  action: string;
  rule: ThresholdRule;
  /** Below this calibrated p → human. Column default 0.5, never a code constant. */
  floor?: number;
  cost_matrix?: CostMatrix | null;
  alpha?: number | null;
  delta?: number | null;
  certified_loss?: number | null;
  coverage?: number | null;
  n_cal?: number | null;
  valid_from?: string;
  valid_to?: string | null;
  status: "candidate" | "active" | "stale" | "human_only" | "retired";
}

/** One row of the `savings_ledger` view (per run). 05 §3.3, CONTRACT §8. */
export interface SavingsLedgerRow {
  run_id: string;
  workflow: string | null;
  workflow_v: number | null;
  llm_calls: number;
  llm_cost_usd: number;
  judge_uses: number;
  judge_cache_hits: number;
  judge_cost_usd: number;
  total_cost_usd: number;
  routes: number;
  routes_auto: number;
  routes_human: number;
  /** routes_auto / routes; null when the run had no route. */
  coverage_without_llm: number | null;
}

/** `dcx_outbox_applied`: the exporter's exactly-once ledger (one row per drained outbox seq). */
export interface OutboxAppliedRow {
  seq: number;
  target_table: WarehouseTable;
  applied_at?: string;
}

/** `prices`. 02 §3.8. */
export interface PriceRow {
  backend: string;
  model: string;
  input_per_m: number;
  output_per_m: number;
  effective_from: string;
}

/** `decision_points` (discovery, weeks 4–6). 04 §3.1. */
export interface DecisionPointRow {
  dp_id: string;
  template_fp?: string | null;
  tool_set_hash?: string | null;
  branch_def?: Json;
  n?: number | null;
  k?: number | null;
  entropy?: number | null;
  med_out_tokens?: number | null;
  cost_share?: number | null;
  class?: "rule" | "question" | "generation" | "open" | null;
}

/** `proposals`. 07 §4.2. */
export interface ProposalRow {
  proposal_id: string;
  artefact_kind: "question" | "rule" | "process" | "concept";
  artefact_ref: string;
  parent_ref?: string | null;
  dp_id?: string | null;
  status: LifecycleStatus;
  evidence?: Json;
  gate_results?: Json;
  created_at?: string;
  status_at?: string;
}

/** `promotions`: the approval ledger. 07 §2. */
export interface PromotionRow {
  proposal_id: string;
  from_status: LifecycleStatus;
  to_status: LifecycleStatus;
  card_hash?: string | null;
  approver?: string | null;
  decision: "approve" | "reject" | "auto_demote" | string;
  reason?: string | null;
  ts?: string;
}

/** `processes`: a DAG whose nodes each carry a status. 07 §2 row 12. */
export interface ProcessRow {
  process_id: string;
  version: number;
  spec: Json;
  derived_from?: string | null;
  lockfile_hash?: string | null;
  status: LifecycleStatus;
}
