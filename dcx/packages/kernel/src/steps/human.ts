// `human` step: enqueue a HITL task and suspend durably (03 §3.5). The step is journaled as
// `suspended` and the run becomes `waiting`; the journal's resolveHuman writes the step's
// output (the resolution) and the label in one transaction, after which `resume` continues
// and this step replays the resolution. `hitl_queue.card` holds `{view, label}`: the rendered
// card plus the label spec the resolver writes (TODO(core): promote a label-spec column).

import type { HitlTask } from "@dcx/core";
import { jsonHash } from "@dcx/core";
import { asJson, type StepDone, type StepEnv } from "../types.js";

export function hitlId(runId: string, stepNo: number): string {
  return jsonHash(["dcx/hitl@1", runId, stepNo]).slice(0, 32);
}

export async function execHuman(env: StepEnv, task: HitlTask): Promise<StepDone> {
  const j = env.deps.journal;
  const id = hitlId(env.runId, env.stepNo);
  const exists = env.prior !== null && (await j.listHuman()).some((h) => h.id === id);
  if (!exists) {
    await j.enqueueHuman({
      id,
      kind: task.kind,
      run_id: env.runId,
      step_no: env.stepNo,
      decision_point_id: task.decisionPointId ?? null,
      question_ref: task.questionRef ?? null,
      card: asJson({ view: task.card, label: task.label ?? null }),
      tiers: asJson(task.tiers ?? null),
      reason_code: task.reasonCode ?? null,
      priority: task.priority ?? 0,
      deadline: task.deadline ?? null,
      default_on_timeout: task.defaultOnTimeout ?? null,
      created_at: env.clock(),
    });
  }
  return {
    output: null,
    status: "suspended",
    effect: {
      effect: { kind: "human", task: task.kind, reason: task.reasonCode ?? null },
      branch: "human",
    },
  };
}
