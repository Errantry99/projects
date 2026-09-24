// `route` step: the cascade router (03 §3.4). tier0 compiled rule (active|canary) → tier1 judge
// (calibrated p vs the action's threshold row) → tier2 blind LLM → human. Hashed audit share on
// the record id forces tier 2; budget caps degrade to human. Writes one `routes` row with the
// reason code, the judge's `judge_uses` rows, and the tier-2 `llm_calls` row (teacher_blind,
// effect = the branch). Shadow refs (rules or questions) run effect-free and are recorded as
// tiers with reason `shadow` (judge uses with mode `shadow`). The step is journaled whole: a
// crash mid-route re-runs it. A human fallback runs as the next step (see RunCtx.route).

import {
  type Decided,
  decisionPointId,
  type Json,
  jsonHash,
  type OutboxEntry,
  type Routed,
  type RouteSpec,
  type TierResult,
  type Warehouse,
} from "@dcx/core";
import {
  gatePlan,
  isAudited,
  type Plan,
  type ThresholdView,
  tier0Answer,
  tier1Plan,
  tier2Verdict,
  toThresholdView,
  type Verdict,
  withinBudget,
} from "../router.js";
import { asJson, type StepDone, type StepEnv } from "../types.js";
import { judgeUseRows, needJudge } from "./judge.js";
import { callLlm, settleTrace } from "./llm.js";

/** Load the threshold rows a route names. A ref is a `threshold_id`, or a `policy_id` shared by
 *  one row per question: with `questionHash`, only that question's rows are read, and a policy
 *  ref resolves to its newest valid row (active status is checked by the router). */
export async function loadThresholds(
  wh: Warehouse,
  ids: readonly string[],
  questionHash?: string,
  judged: { backend?: string | undefined; modelV?: string | undefined } = {},
): Promise<Map<string, ThresholdView>> {
  const out = new Map<string, ThresholdView>();
  if (ids.length === 0) return out;
  const list = ids.map(() => "?").join(", ");
  // Narrow to the judged (question, backend, model) so a row fitted for another backend or pin
  // under the same policy cannot shadow this one.
  const where: string[] = [];
  const extra: string[] = [];
  for (const [col, v] of [
    ["question_hash", questionHash],
    ["backend", judged.backend],
    ["model_v", judged.modelV],
  ] as const) {
    if (v === undefined) continue;
    where.push(`AND ${col} = ?`);
    extra.push(v);
  }
  const rows = await wh.all(
    `SELECT threshold_id, policy_id, question_hash, backend, model_v, calibrator_id, action,
            rule, floor, status FROM thresholds
      WHERE (threshold_id IN (${list}) OR policy_id IN (${list}))
        ${where.join(" ")}
        AND valid_from <= current_timestamp
        AND (valid_to IS NULL OR valid_to > current_timestamp)
      ORDER BY status = 'active', valid_from`,
    [...ids, ...ids, ...extra],
  );
  // Ascending order: later (active, newer) rows overwrite earlier ones; an exact id wins.
  for (const r of rows) {
    const v = toThresholdView(r);
    if (ids.includes(String(r.policy_id))) out.set(String(r.policy_id), v);
  }
  for (const r of rows) {
    if (ids.includes(String(r.threshold_id)))
      out.set(String(r.threshold_id), toThresholdView(r));
  }
  return out;
}

async function budgetOk<K extends string>(
  env: StepEnv,
  spec: RouteSpec<K>,
  routeCost: number,
): Promise<boolean> {
  const b = env.deps.budget ?? {};
  const est = b.llmEstimateUsd ?? 0;
  if (!withinBudget(env.spent + routeCost, est, spec.budgetUsd ?? b.runUsd)) return false;
  if (b.dayUsd !== undefined && b.daySpentUsd) {
    return withinBudget((await b.daySpentUsd()) + routeCost, est, b.dayUsd);
  }
  return true;
}

export async function execRoute<K extends string>(
  env: StepEnv,
  spec: RouteSpec<K>,
): Promise<StepDone> {
  const keys = Object.keys(spec.actions) as K[];
  const dp = decisionPointId(env.workflow, spec.decisionPoint);
  const recordKey = spec.recordId ?? jsonHash(spec.state);
  const tiers: TierResult[] = [];
  const outbox: OutboxEntry[] = [];
  let cost = 0;
  const judge = async (question: string, mode: typeof env.mode): Promise<Decided | null> => {
    try {
      const lj = await needJudge(env).askLive({
        state: spec.state,
        questions: [question],
        mode,
        ...(spec.recordId ? { recordId: spec.recordId } : {}),
      });
      cost += lj.costUsd;
      const seen = new Set(outbox.map((o) => `${o.row.question_hash}|${o.row.payload_hash}`));
      for (const r of judgeUseRows(env, lj.uses, mode)) {
        if (!seen.has(`${r.row.question_hash}|${r.row.payload_hash}`)) outbox.push(r);
      }
      return lj.decided[0] ?? null;
    } catch {
      return null;
    }
  };

  // Shadow candidates: effect-free, recorded, never decide.
  for (const ref of spec.shadow ?? []) {
    const rule = env.deps.rules?.find((r) => r.ref === ref);
    if (rule) {
      tiers.push({
        tier: 0,
        kind: "rule",
        answer: tier0Answer(rule.fn(spec.state), keys),
        p: null,
        costUsd: 0,
        reason: "shadow",
      });
    } else {
      const d = await judge(ref, "shadow");
      tiers.push({
        tier: 1,
        kind: "judge",
        answer: d?.answer ?? null,
        p: d?.pCal ?? null,
        costUsd: 0,
        reason: "shadow",
      });
    }
  }

  // Tier 0: a promoted rule for this decision point.
  let plan: Plan<K> | null = null;
  const t0 = env.deps.rules?.find(
    (r) =>
      r.decisionPoint === spec.decisionPoint &&
      (r.status === "active" || r.status === "canary"),
  );
  if (t0) {
    const a = tier0Answer(t0.fn(spec.state), keys);
    tiers.push({
      tier: 0,
      kind: "rule",
      answer: a,
      p: null,
      costUsd: 0,
      ...(a ? { reason: "tier0_rule" as const } : {}),
    });
    if (a !== null) plan = { next: "act", branch: a, reason: "tier0_rule", thresholdId: null };
  }

  // Tier 1: the judge against the threshold rows (looked up for the judged question).
  if (plan === null) {
    const before = cost;
    const d = await judge(spec.question, env.mode);
    const refOf = (k: K) => spec.actions[k]?.thresholdRef;
    const refs = keys.map(refOf).filter((r): r is string => r !== undefined);
    const th = await loadThresholds(env.deps.warehouse, refs, d?.questionHash, {
      backend: d?.backend,
      modelV: d?.modelVersion,
    });
    const byKey: Partial<Record<K, ThresholdView>> = {};
    for (const k of keys) {
      const ref = refOf(k);
      const t = ref === undefined ? undefined : th.get(ref);
      if (t) byKey[k] = t;
    }
    plan = tier1Plan(d, keys, byKey, spec.onUnmapped ? { onUnmapped: spec.onUnmapped } : {});
    tiers.push({
      tier: 1,
      kind: "judge",
      answer: d?.answer ?? null,
      p: d?.pCal ?? null,
      costUsd: cost - before,
      reason: plan.reason,
      thresholdId: plan.thresholdId,
    });
  }

  const audited = isAudited(spec.decisionPoint, recordKey, spec.auditRate ?? 0);
  plan = gatePlan(plan, {
    audited,
    hasLlm: spec.fallback.llm !== undefined && env.deps.llm !== undefined,
    budgetOk: await budgetOk(env, spec, cost),
  });

  // Tier 2: the blind LLM.
  let verdict: Verdict<K>;
  if (plan.next === "llm" && spec.fallback.llm) {
    const req = { ...spec.fallback.llm, teacherBlind: true, decisionPoint: spec.decisionPoint };
    const { res, trace, outbox: rows } = await callLlm(env, spec.decisionPoint, req, "tier2");
    const v = res.value as { answer?: Json } | null;
    const answer = res.normalisedAnswer ?? (typeof v?.answer === "string" ? v.answer : null);
    cost += res.costUsd;
    tiers.push({
      tier: 2,
      kind: "llm",
      answer,
      p: null,
      costUsd: res.costUsd,
      reason: plan.reason,
    });
    const reversible = (k: K) => spec.actions[k]?.reversible === true;
    verdict = tier2Verdict(plan, answer, keys, reversible);
    outbox.push(
      ...rows,
      settleTrace(trace, {
        effect: { kind: "route", decision_point: spec.decisionPoint, branch: verdict.branch },
        branch: verdict.branch,
      }),
    );
  } else {
    verdict =
      plan.next === "act"
        ? { branch: plan.branch, reason: plan.reason }
        : { branch: "human", reason: plan.reason };
  }

  const routed: Routed<K> & { decisionPointId: string; thresholdId: string | null } = {
    branch: verdict.branch,
    reason: verdict.reason,
    tiers,
    costUsd: cost,
    audited,
    decisionPointId: dp,
    thresholdId: plan.thresholdId,
  };
  outbox.push({
    target_table: "routes",
    row: asJson({
      run_id: env.runId,
      step_no: env.stepNo,
      record_id: spec.recordId ?? null,
      decision_point_id: dp,
      tiers,
      branch_taken: verdict.branch,
      reason_code: verdict.reason,
      threshold_id: plan.thresholdId,
      cost_usd: cost,
      mode: env.mode,
    }),
  });
  return {
    output: asJson(routed),
    outbox,
    recordId: spec.recordId ?? null,
    effect: {
      effect: { kind: "route", decision_point: spec.decisionPoint, branch: verdict.branch },
      branch: verdict.branch,
    },
  };
}
