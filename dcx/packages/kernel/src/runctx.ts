// The journaled run context (03 §2.3, §3.2; 07 §3 decision 7). Every step is a journaled
// function, DBOS `operation_outputs` style: on entry look up (run_id, step_no); if a result is
// stored, return it (replay); else execute and store it with insert-if-absent, together with
// its warehouse rows (outbox) in one journal transaction. Step numbers are assigned in call
// order, synchronously, so they are deterministic per run.

import { randomUUID } from "node:crypto";
import {
  type Candidate,
  type CandidateSpec,
  type Decided,
  decodeRunInput,
  encodeRunInput,
  type HitlTask,
  type Json,
  type JsonObject,
  jsonHash,
  type LlmReq,
  type LlmRes,
  type Mode,
  type OntologyRef,
  type OutboxEntry,
  type Routed,
  type RouteSpec,
  type RunCtx,
  type RunRow,
  type StepKind,
  type StepRow,
  type Workflow,
} from "@dcx/core";
import { humanTier } from "./router.js";
import { execHuman } from "./steps/human.js";
import { execJudge, judgeView } from "./steps/judge.js";
import { execLlm, settleTrace } from "./steps/llm.js";
import { execRetrieve } from "./steps/retrieve.js";
import { execRoute } from "./steps/route.js";
import { execRule } from "./steps/rule.js";
import { execSql } from "./steps/sql.js";
import { execTool, idempotencyKey } from "./steps/tool.js";
import {
  asJson,
  type Effect,
  type JudgeReq,
  type KernelDeps,
  type RunResult,
  type StepDone,
  type StepEnv,
} from "./types.js";

/** Thrown by `human` to unwind the workflow; the run becomes `waiting`. Do not catch it. */
export class Suspended extends Error {
  constructor(
    readonly runId: string,
    readonly stepNo: number,
  ) {
    super(`run ${runId} waiting on step ${stepNo}`);
    this.name = "Suspended";
  }
}

/** The workflow called a different step than the journal holds, or (strict replay) a step
 *  that was never journaled. */
export class ReplayDivergence extends Error {
  override name = "ReplayDivergence";
}

/** Another executor holds the run's lease, or ours was lost. */
export class LeaseError extends Error {
  override name = "LeaseError";
}

/** A journaled step failure, replayed. */
export class StepFailed extends Error {
  override name = "StepFailed";
}

/** Run metadata kept in `runs.input_ref` with core's inline convention (`inline:<JCS>`, see
 *  `encodeRunInput`): the journal has no input column. */
export interface RunMeta {
  input: Json;
  forkOf?: string;
  /** Steps below this number were copied from `forkOf` (their traces were already emitted). */
  forkAt?: number;
}

export function encodeMeta(m: RunMeta): string {
  return encodeRunInput(asJson(m));
}

export function decodeMeta(ref: string | null | undefined): RunMeta {
  return (decodeRunInput(ref) as RunMeta | null) ?? { input: null };
}

/** `now()` and `random()` are journaled as `rule` steps with these names (no clock kind in the
 *  steps CHECK). TODO(core): promote a dedicated kind if the set is ever widened. */
const SYNC_NAMES = { now: "dcx.now", random: "dcx.random" } as const;

export class Kernel {
  readonly executorId: string;
  readonly clock: () => number;
  readonly ttl: number;

  constructor(readonly deps: KernelDeps) {
    this.executorId = deps.executorId ?? `exec-${randomUUID()}`;
    this.clock = deps.clock ?? Date.now;
    this.ttl = deps.leaseTtlMs ?? 30_000;
  }

  workflow(name: string, version: number): Workflow {
    const wf = this.deps.workflows.find((w) => w.name === name && w.version === version);
    if (!wf) throw new Error(`workflow ${name}@${version} is not registered`);
    return wf;
  }

  /** Start a run and execute it until it completes, waits on a human, or fails. Starting an
   *  existing run id resumes it. */
  async createRun(
    workflow: string,
    version: number,
    mode: Mode,
    input: Json,
    opts: { runId?: string; meta?: Omit<RunMeta, "input"> } = {},
  ): Promise<RunResult> {
    this.workflow(workflow, version);
    const runId = opts.runId ?? this.deps.newRunId?.() ?? randomUUID();
    await this.deps.journal.startRun({
      run_id: runId,
      workflow,
      workflow_v: version,
      mode,
      status: "pending",
      input_ref: encodeMeta({ input, ...opts.meta }),
      created_at: this.clock(),
    });
    return this.resume(runId);
  }

  /** Continue a run from its journal. A completed run is replayed read-only (same output, no
   *  writes). Recovery runs only on the recorded workflow version (anything else must fork). */
  async resume(runId: string): Promise<RunResult> {
    const run = await this.deps.journal.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.status === "completed") return this.execute(run, true);
    const now = this.clock();
    if (
      run.executor_id &&
      run.executor_id !== this.executorId &&
      (run.lease_until ?? 0) > now
    ) {
      throw new LeaseError(`run ${runId} is leased by ${run.executor_id}`);
    }
    await this.deps.journal.updateRun(runId, {
      status: "running",
      executor_id: this.executorId,
      lease_until: now + this.ttl,
    });
    return this.execute(run, false);
  }

  /** Claim runs whose lease expired and resume each (crash recovery). */
  async recover(): Promise<RunResult[]> {
    const ids = await this.deps.journal.lease(this.executorId, this.ttl);
    const out: RunResult[] = [];
    for (const id of ids) out.push(await this.resume(id));
    return out;
  }

  /** Run the workflow body against the journal. `readOnly` = strict replay: nothing is
   *  executed or written, and a step missing from the journal is a divergence. */
  async execute(run: RunRow, readOnly: boolean): Promise<RunResult> {
    const wf = this.workflow(run.workflow, run.workflow_v);
    const meta = decodeMeta(run.input_ref);
    const ctx = new Ctx(
      this,
      run,
      meta,
      await this.deps.journal.listSteps(run.run_id),
      readOnly,
    );
    const j = this.deps.journal;
    try {
      const output = await wf.run(ctx, meta.input);
      await ctx.drain();
      if (ctx.suspendedAt !== null) throw new Suspended(run.run_id, ctx.suspendedAt);
      if (!readOnly) {
        const tail = ctx.settle({ effect: { kind: "return", output }, branch: str(output) });
        if (tail.length) await j.enqueueOutbox(tail);
        await j.updateRun(run.run_id, {
          status: "completed",
          ended_at: this.clock(),
          lease_until: null,
        });
      }
      return { runId: run.run_id, status: "completed", output };
    } catch (e) {
      await ctx.drain().catch(() => undefined);
      if (e instanceof Suspended || ctx.suspendedAt !== null) {
        if (!readOnly) {
          await j.updateRun(run.run_id, { status: "waiting", lease_until: null });
          // resolveHuman re-queues only runs already `waiting`: a task resolved between its
          // enqueue and this update would strand the run, so re-check the parked step.
          const at = ctx.suspendedAt;
          const s = at === null ? null : await j.getStep(run.run_id, at);
          if (s?.status === "completed") return this.resume(run.run_id);
        }
        return { runId: run.run_id, status: "waiting" };
      }
      if (readOnly || e instanceof LeaseError) throw e;
      await j.updateRun(run.run_id, { status: "failed", ended_at: this.clock() });
      return { runId: run.run_id, status: "failed", error: String(e) };
    }
  }
}

function str(v: Json): string | null {
  return typeof v === "string" ? v : null;
}

/** Per-step cost as journaled (for budget caps; re-accumulated on replay). */
function costOf(kind: StepKind, out: Json): number {
  const o = out as { costUsd?: number; res?: { costUsd?: number } } | null;
  if (!o || typeof o !== "object") return 0;
  return (kind === "llm" ? o.res?.costUsd : o.costUsd) ?? 0;
}

export class Ctx implements RunCtx {
  readonly runId: string;
  readonly mode: Mode;
  suspendedAt: number | null = null;
  private next = 1;
  private spent = 0;
  private pending: { stepNo: number; trace: JsonObject } | null = null;
  private writes: Promise<unknown>[] = [];
  private readonly byNo: Map<number, StepRow>;
  private leaseAt: number;

  constructor(
    private readonly k: Kernel,
    private readonly run: RunRow,
    private readonly meta: RunMeta,
    steps: StepRow[],
    private readonly readOnly: boolean,
  ) {
    this.runId = run.run_id;
    this.mode = run.mode;
    this.byNo = new Map(steps.map((s) => [s.step_no, s]));
    this.leaseAt = k.clock();
  }

  // --- the eight step kinds -----------------------------------------------------------------

  sql<T = Json>(name: string, query: string, params: Json[] = []): Promise<T[]> {
    return this.step("sql", name, { query, params }, (e) => execSql(e, query, params));
  }

  rule<T extends Json>(name: string, ref: `${string}@${number}`, inputs: Json): Promise<T> {
    return this.step("rule", name, { ref, inputs }, (e) => execRule(e, ref, inputs));
  }

  retrieve(
    name: string,
    req: { ontology?: OntologyRef; query: string; spec: CandidateSpec },
  ): Promise<{ candidates: Candidate[]; candidateSetHash: string }> {
    return this.step("retrieve", name, asJson(req), async () => execRetrieve());
  }

  async judge(name: string, req: JudgeReq): Promise<Decided[]> {
    return judgeView(
      await this.step<Json>("judge", name, asJson(req), (e) => execJudge(e, req)),
    );
  }

  async llm<T extends Json>(name: string, req: LlmReq<T>): Promise<LlmRes<T>> {
    const out = await this.step<{ res: LlmRes<T> }>("llm", name, asJson(req), (e) =>
      execLlm(e, name, req),
    );
    return out.res;
  }

  tool<T extends Json>(name: string, c: { tool: string; args: Json; idempotent: boolean }) {
    return this.step<T>("tool", name, c, (e) => execTool(e, c), {
      idempotencyKey: idempotencyKey(this.runId, this.next),
    });
  }

  human<T extends Json>(name: string, task: HitlTask): Promise<T> {
    return this.step<T>("human", name, asJson(task), (e) => execHuman(e, task));
  }

  async route<K extends string>(name: string, spec: RouteSpec<K>): Promise<Routed<K>> {
    const routed = await this.step<Routed<K> & { decisionPointId: string }>(
      "route",
      name,
      asJson(spec),
      (e) => execRoute(e, spec),
    );
    if (routed.branch !== "human" || !spec.fallback.human) return routed;
    const res = await this.human<Json>(`${name}.human`, {
      ...spec.fallback.human,
      decisionPointId: routed.decisionPointId,
      tiers: routed.tiers,
      reasonCode: routed.reason,
    });
    const h = humanTier(Object.keys(spec.actions) as K[], res);
    return { ...routed, branch: h.branch, tiers: [...routed.tiers, h.tier] };
  }

  now(): Date {
    return new Date(this.syncStep("now", () => this.k.clock()));
  }

  random(): number {
    return this.syncStep("random", this.k.deps.rng ?? Math.random);
  }

  // --- the journaled-function runner --------------------------------------------------------

  private syncStep(which: keyof typeof SYNC_NAMES, gen: () => number): number {
    const stepNo = this.next++;
    const name = SYNC_NAMES[which];
    const prior = this.byNo.get(stepNo);
    if (prior) {
      this.check(prior, "rule", name, null);
      return prior.output as number;
    }
    if (this.readOnly) throw new ReplayDivergence(`step ${stepNo} (${name}) not in journal`);
    const v = gen();
    const at = this.k.clock();
    const w = this.k.deps.journal
      .putStep({
        run_id: this.runId,
        step_no: stepNo,
        kind: "rule",
        name,
        status: "completed",
        mode: this.mode,
        output: v,
        started_at: at,
        ended_at: at,
      })
      .then((r) => {
        if (r === "exists") throw new ReplayDivergence(`step ${stepNo} raced another writer`);
      });
    w.catch(() => undefined); // surfaced by drain()
    this.writes.push(w);
    return v;
  }

  /** Await journaled `now()`/`random()` writes; the next side effect waits on them. */
  async drain(): Promise<void> {
    const w = this.writes;
    this.writes = [];
    await Promise.all(w);
  }

  private check(prior: StepRow, kind: StepKind, name: string, inputRef: string | null): void {
    if (prior.kind !== kind || prior.name !== name) {
      throw new ReplayDivergence(
        `step ${prior.step_no}: journal has ${prior.kind} "${prior.name}", workflow called ${kind} "${name}"`,
      );
    }
    if (inputRef !== null && prior.input_ref && prior.input_ref !== inputRef) {
      throw new ReplayDivergence(`step ${prior.step_no} "${name}": inputs changed`);
    }
  }

  /** Close the pending llm_calls row with this step's effect (03 §3.3: filled by the kernel when
   *  the downstream step completes). */
  settle(e: Effect): OutboxEntry[] {
    const p = this.pending;
    this.pending = null;
    return p ? [settleTrace(p.trace, e)] : [];
  }

  private replayed(s: StepRow): void {
    this.spent += costOf(s.kind, s.output ?? null);
    if (s.kind === "llm" && s.step_no >= (this.meta.forkAt ?? 0)) {
      this.pending = { stepNo: s.step_no, trace: (s.output as { trace: JsonObject }).trace };
    } else {
      this.pending = null; // this step settled the earlier llm row when it first ran
    }
  }

  private async step<T>(
    kind: StepKind,
    name: string,
    input: Json,
    exec: (env: StepEnv) => Promise<StepDone>,
    opts: { idempotencyKey?: string } = {},
  ): Promise<T> {
    const stepNo = this.next++;
    const j = this.k.deps.journal;
    await this.drain();
    const inputRef = jsonHash(input);
    let prior = await j.getStep(this.runId, stepNo);
    if (!prior && !this.readOnly) {
      await this.guardLease();
      const started = {
        run_id: this.runId,
        step_no: stepNo,
        kind,
        name,
        status: "running",
        mode: this.mode,
        input_ref: inputRef,
        idempotency_key: opts.idempotencyKey ?? null,
        started_at: this.k.clock(),
      } satisfies StepRow;
      if ((await j.putStep(started)) === "exists") prior = await j.getStep(this.runId, stepNo);
    }
    if (prior) {
      this.check(prior, kind, name, inputRef);
      if (prior.status === "completed") {
        this.replayed(prior);
        return prior.output as T;
      }
      if (prior.status === "failed") {
        // When it first ran, this failure settled the pending llm_calls row (see below).
        this.pending = null;
        throw new StepFailed(prior.error ?? `step ${stepNo} failed`);
      }
      if (prior.status === "suspended") {
        this.pending = null;
        this.suspendedAt = stepNo;
        throw new Suspended(this.runId, stepNo);
      }
    }
    if (this.readOnly) throw new ReplayDivergence(`step ${stepNo} (${kind} "${name}") not run`);
    const env: StepEnv = {
      runId: this.runId,
      stepNo,
      mode: this.mode,
      workflow: this.run.workflow,
      workflowV: this.run.workflow_v,
      deps: this.k.deps,
      prior: prior?.status === "running" ? prior : null,
      spent: this.spent,
      clock: this.k.clock,
    };
    let done: StepDone;
    try {
      done = await exec(env);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const tail = this.settle({ effect: { kind, name, error: msg }, branch: null });
      await j.completeStep(
        this.runId,
        stepNo,
        { status: "failed", error: msg, ended_at: this.k.clock() },
        tail,
      );
      throw err;
    }
    const status = done.status ?? "completed";
    const endedAt = this.k.clock();
    const outbox: OutboxEntry[] = [
      ...(done.outbox ?? []),
      ...this.settle(done.effect ?? { effect: { kind, name }, branch: null }),
      {
        target_table: "trace_steps",
        row: {
          run_id: this.runId,
          step_no: stepNo,
          kind,
          name,
          status,
          attempt: 1,
          mode: this.mode,
          input_ref: inputRef,
          output: done.output,
          idempotency_key: opts.idempotencyKey ?? null,
          started_at: prior?.started_at ?? env.clock(),
          ended_at: endedAt,
          record_id: done.recordId ?? null,
          activity: done.activity ?? `${kind}:${name}`,
          source: "kernel",
        },
      },
    ];
    await j.completeStep(
      this.runId,
      stepNo,
      { status, output: done.output, ended_at: endedAt },
      outbox,
    );
    this.spent += costOf(kind, done.output);
    if (kind === "llm") {
      this.pending = { stepNo, trace: (done.output as { trace: JsonObject }).trace };
    }
    if (status === "suspended") {
      this.suspendedAt = stepNo;
      throw new Suspended(this.runId, stepNo);
    }
    return done.output as T;
  }

  private async guardLease(): Promise<void> {
    const now = this.k.clock();
    if (now - this.leaseAt < this.k.ttl / 2) return;
    const ok = await this.k.deps.journal.heartbeat(this.runId, this.k.executorId, this.k.ttl);
    if (!ok) throw new LeaseError(`lease on run ${this.runId} lost`);
    this.leaseAt = now;
  }
}
