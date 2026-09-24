// `judge` step: the injected live judge's ask() → decide(); one `judge_uses` row per use,
// cache hit or not, through the outbox (07 §4.4). A judge error fails the step (gates fail
// closed); the route step handles its own judge errors (routes fail open to tier 2).

import { assertPinned, type Decided, type Json, type Mode, type OutboxEntry } from "@dcx/core";
import {
  asJson,
  type JudgeReq,
  type JudgeService,
  type JudgeUse,
  type StepDone,
  type StepEnv,
} from "../types.js";

export function needJudge(env: StepEnv): JudgeService {
  if (!env.deps.judge) throw new Error("no JudgeService configured");
  return env.deps.judge;
}

export function judgeUseRows(
  env: StepEnv,
  uses: readonly JudgeUse[],
  mode: Mode,
): OutboxEntry[] {
  return uses.map((u) => {
    assertPinned(u.modelV);
    return {
      target_table: "judge_uses",
      row: {
        run_id: env.runId,
        step_no: env.stepNo,
        record_id: u.recordId ?? null,
        question_hash: u.questionHash,
        payload_hash: u.payloadHash,
        candidate_set_hash: u.candidateSetHash ?? "",
        backend: u.backend,
        model_v: u.modelV,
        pack_mode: u.packMode ?? "single",
        mode,
        cache_hit: u.cacheHit,
      },
    };
  });
}

export async function execJudge(env: StepEnv, req: JudgeReq): Promise<StepDone> {
  const mode = req.mode ?? env.mode;
  const lj = await needJudge(env).askLive({
    state: req.state,
    questions: req.questions,
    ...(req.options ? { options: req.options } : {}),
    mode,
  });
  return {
    output: asJson({ decided: lj.decided, costUsd: lj.costUsd }),
    outbox: judgeUseRows(env, lj.uses, mode),
    effect: {
      effect: { kind: "judge", answers: lj.decided.map((d) => d.answer) },
      branch: lj.decided.length === 1 ? (lj.decided[0]?.answer ?? null) : null,
    },
  };
}

export function judgeView(out: Json): Decided[] {
  return (out as unknown as { decided: Decided[] }).decided;
}
