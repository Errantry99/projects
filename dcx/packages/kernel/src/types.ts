// Kernel-local types: the injected services and the step-runner plumbing. Shared shapes
// (RunCtx, Journal, Warehouse, RouteSpec, Routed, Decided, TraceRow, ...) come from @dcx/core.

import type {
  Decided,
  Journal,
  Json,
  LifecycleStatus,
  LlmReq,
  LlmRes,
  Mode,
  Option,
  OutboxEntry,
  PackMode,
  StepRow,
  Warehouse,
  Workflow,
} from "@dcx/core";

/** One judge use, as the live judge reports it; the kernel turns it into a `judge_uses` row. */
export interface JudgeUse {
  questionHash: string;
  payloadHash: string;
  /** "" (the default) for static options. */
  candidateSetHash?: string;
  backend: string;
  /** Returned model version incl. settings digest; never an alias. */
  modelV: string;
  packMode?: PackMode;
  cacheHit: boolean;
  recordId?: string | null;
}

/** A `judge` step request (RunCtx["judge"]'s second argument). */
export interface JudgeReq {
  state: Json;
  questions: string[];
  options?: Record<string, Option[]>;
  mode?: Mode;
}

/** What one live ask() → decide() returns. */
export interface LiveJudgment {
  decided: Decided[];
  uses: JudgeUse[];
  /** Spend attributable to this use (0 on a cache hit). Counts toward budget caps. */
  costUsd: number;
}

/**
 * The live judge as the kernel sees it (B's ask() then decide(), cache-aware).
 * TODO(judge): wire to @dcx/judge's `askLive` once it lands; this is the seam the CLI adapts.
 */
export interface JudgeService {
  askLive(req: {
    state: Json;
    questions: string[];
    options?: Record<string, Option[]>;
    mode: Mode;
    recordId?: string;
  }): Promise<LiveJudgment>;
}

/** An LLM client. The kernel assigns `callId` (deterministic per run and step). */
export interface LlmClient {
  readonly provider: string;
  complete<T extends Json>(
    req: LlmReq<T>,
    o: { callId: string },
  ): Promise<Omit<LlmRes<T>, "callId">>;
}

/**
 * A registered pure rule, `name@version`. A rule with `decisionPoint` and status `active` or
 * `canary` is that route's tier 0 (it returns an action key, `{answer}`, or null to abstain).
 */
export interface RuleDef {
  ref: `${string}@${number}`;
  fn: (inputs: Json) => Json;
  status?: LifecycleStatus;
  decisionPoint?: string;
}

/** A tool executor; the stub runs when none is registered, or when the run is in shadow mode. */
export type ToolFn = (args: Json, o: { idempotencyKey: string }) => Promise<Json>;

/** Budget caps (03 §3.4). Hitting one degrades a route to human, never to the LLM. */
export interface BudgetCaps {
  /** Per-run cap (a route's `budgetUsd` overrides it for that route). */
  runUsd?: number;
  /** Per-day cap, checked against `daySpentUsd()`. */
  dayUsd?: number;
  daySpentUsd?: () => Promise<number>;
  /** Expected cost of one tier-2 call, added before comparing to the cap (default 0). */
  llmEstimateUsd?: number;
}

export interface KernelDeps {
  journal: Journal;
  warehouse: Warehouse;
  /** Registry used by `createRun` and `resume` (looked up by name and version). */
  workflows: Workflow[];
  judge?: JudgeService;
  llm?: LlmClient;
  rules?: RuleDef[];
  tools?: Record<string, ToolFn>;
  budget?: BudgetCaps;
  /** Epoch ms; bookkeeping and the source of journaled `now()`. Default Date.now. */
  clock?: () => number;
  /** Source of journaled `random()`. Default Math.random. */
  rng?: () => number;
  executorId?: string;
  leaseTtlMs?: number;
  newRunId?: () => string;
}

export interface RunResult {
  runId: string;
  status: "completed" | "waiting" | "failed";
  output?: Json;
  error?: string;
}

/** What a step's completion tells the pending `llm_calls` row (03 §3.3 effect and branch). */
export interface Effect {
  effect: Json;
  branch: string | null;
}

/** A step body's result; the runner journals it and its outbox rows in one transaction. */
export interface StepDone {
  output: Json;
  outbox?: OutboxEntry[];
  effect?: Effect;
  status?: "completed" | "suspended";
  recordId?: string | null;
  /** Process-mining activity (`kind:template_id`); defaults to `kind:name`. */
  activity?: string;
}

/** What a step body sees. */
export interface StepEnv {
  runId: string;
  stepNo: number;
  mode: Mode;
  workflow: string;
  workflowV: number;
  deps: KernelDeps;
  /** The journal row when this step is being re-executed after a crash (status running). */
  prior: StepRow | null;
  /** Run spend so far (journaled step costs), for budget caps. */
  spent: number;
  clock: () => number;
}

/** Cast a structurally-JSON value (an interface instance) to Json. JCS skips undefined keys. */
export function asJson<T = Json>(v: unknown): T {
  return v as T;
}
