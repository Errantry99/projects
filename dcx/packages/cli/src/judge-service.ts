// The seam between the kernel and the judge (07 §4.3 `judge(...)`: ask() → decide()). The
// kernel's `JudgeService.askLive` takes question refs and wants `Decided[]` plus the judge uses
// it journals; @dcx/judge's `askLive` takes QuestionDefs and returns raw answers. This adapter:
//   1. resolves refs (`screen.crit_1@1`) to QuestionDefs from the warehouse registry;
//   2. calls judge's `askLive` with `writeUses: false` (the kernel writes `judge_uses` through
//      the journal outbox, in the same transaction as the step);
//   3. runs `decide()` with the active calibrator and thresholds for each
//      (question_hash, backend, model_v), read from the warehouse (cached per process);
//   4. maps the result to the kernel's `{decided, uses, costUsd}`.

import type {
  Backend,
  CalibratorRow,
  Decided,
  Json,
  Mode,
  Option,
  QuestionDef,
  QuestionRef,
  ThresholdRow,
  Warehouse,
} from "@dcx/core";
import { askLive, decide, loadDecisionPolicy, modelVFor, readQuestions } from "@dcx/judge";
import type { JudgeService, JudgeUse, LiveJudgment } from "@dcx/kernel";

export interface WarehouseJudgeOpts {
  /** The pinned model, e.g. `jev-1.13.0`. */
  pin: string;
  /** Real-time defaults (02 §3.7) apply when omitted. */
  timeoutMs?: number;
  maxRetries?: number;
}

type Policy = { calibrator: CalibratorRow | null; thresholds: ThresholdRow[] };

export class WarehouseJudge implements JudgeService {
  private defs: Map<string, QuestionDef> | null = null;
  private readonly policies = new Map<string, Promise<Policy>>();
  /** Backend requests made (cache misses asked), for reporting. */
  requests = 0;

  constructor(
    private readonly wh: Warehouse,
    private readonly backend: Backend,
    private readonly o: WarehouseJudgeOpts,
  ) {}

  private async resolve(refs: readonly string[]): Promise<QuestionDef[]> {
    if (!this.defs) {
      this.defs = new Map(
        (await readQuestions(this.wh)).map((d) => [`${d.id}@${d.version}`, d]),
      );
    }
    return refs.map((r) => {
      const d = this.defs?.get(r);
      if (!d) throw new Error(`judge: unknown question ${r} (run \`dcx questions add\`)`);
      return d;
    });
  }

  private policy(questionHash: string, modelV: string): Promise<Policy> {
    const key = `${questionHash}|${modelV}`;
    let p = this.policies.get(key);
    if (!p) {
      p = loadDecisionPolicy(this.wh, { questionHash, backend: this.backend.name, modelV });
      this.policies.set(key, p);
    }
    return p;
  }

  async askLive(req: {
    state: Json;
    questions: string[];
    options?: Record<string, Option[]>;
    mode: Mode;
    recordId?: string;
  }): Promise<LiveJudgment> {
    const defs = (await this.resolve(req.questions)).map((d) => {
      const bound = req.options?.[`${d.id}@${d.version}`];
      return bound ? { ...d, options: bound } : d;
    });
    const live = await askLive(
      this.wh,
      this.backend,
      [
        {
          runId: "",
          stepNo: 0,
          mode: req.mode,
          recordId: req.recordId ?? null,
          state: req.state,
          questions: defs,
        },
      ],
      {
        pin: this.o.pin,
        writeUses: false,
        ...(this.o.timeoutMs === undefined ? {} : { timeoutMs: this.o.timeoutMs }),
        ...(this.o.maxRetries === undefined ? {} : { maxRetries: this.o.maxRetries }),
      },
    );
    this.requests += live.calls.length;
    const results = live.results[0] ?? [];
    const decided: Decided[] = [];
    for (const r of results) {
      const pol = await this.policy(r.question.questionHash, r.modelVersion);
      decided.push(
        decide(
          {
            answer: r.answer,
            questionHash: r.question.questionHash,
            questionRef: `${r.question.id}@${r.question.version}` as QuestionRef,
            backend: this.backend.name,
            modelVersion: r.modelVersion,
            cacheHit: r.cacheHit,
            degraded: r.degraded,
          },
          pol.calibrator,
          pol.thresholds,
        ),
      );
    }
    const uses: JudgeUse[] = live.uses.map((u) => ({
      questionHash: u.question_hash,
      payloadHash: u.payload_hash,
      candidateSetHash: u.candidate_set_hash,
      backend: u.backend,
      modelV: u.model_v,
      packMode: u.pack_mode ?? "single",
      cacheHit: u.cache_hit,
      recordId: req.recordId ?? null,
    }));
    const costUsd = live.calls.reduce((s, c) => s + (c.cost_usd ?? 0), 0);
    return { decided, uses, costUsd };
  }
}

/** The `model_v` this judge writes for its pin. */
export function judgeModelV(backend: Backend, pin: string): string {
  return modelVFor(backend, pin);
}
