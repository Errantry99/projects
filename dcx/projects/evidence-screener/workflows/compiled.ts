// screen-compiled@1 (07 §4.8): judge every screening question in one request, reduce with a
// rule that auto-excludes only on a calibrated `fails` or off-topic answer at ≥ exclude_min_p
// (0.99, from criteria.json), then route: above the certified threshold → exclude; abstain
// band → the blind LLM (same prompt as the baseline, never shown the judge's answers); a 5%
// hashed audit re-asks the LLM; below the floor → human. An injection hit forces human review.
// A judge answer that points at no exclusion (e.g. `meets`) escalates to the blind LLM.
import type { Decided, HitlTask, Json, RunCtx, Workflow } from "@dcx/core";
import { CRITERIA, type ScreenCriteria } from "../src/criteria.js";
import { QUESTION_REFS } from "../src/questions.js";
import {
  normaliseAnswer,
  type ScreenAnswer,
  type ScreenInput,
  type ScreenOutput,
  screenEffect,
  screenLlmReq,
} from "./baseline.js";

export type Reduced = {
  verdict: "exclude" | "route" | "human";
  reason: string;
  /** The question the verdict rests on; the route applies its certified threshold. */
  question: string;
  p: number;
};

type DecidedLite = Pick<Decided, "answer" | "pCal"> & { questionRef?: string };

/**
 * Rule `screen.reduce@1`. Inputs: `{decided: Decided[], refs: string[], policy}`; `refs[i]` names
 * `decided[i]` when the judge did not set `questionRef`. Pure and deterministic.
 */
export function screenReduce(inputs: Json): Json {
  const { decided, refs, policy } = inputs as unknown as {
    decided: DecidedLite[];
    refs: string[];
    policy: ScreenCriteria["policy"];
  };
  const qs = decided.map((d, i) => ({ ...d, ref: d.questionRef ?? refs[i] ?? "" }));
  const byId = (suffix: string) => qs.find((q) => q.ref.split("@")[0]?.endsWith(suffix));
  const out = (verdict: Reduced["verdict"], reason: string, question: string, p: number) =>
    ({ verdict, reason, question, p }) satisfies Reduced as Json;

  const inj = byId(".injection");
  if (inj) {
    const pTrue = inj.answer === "true" ? inj.pCal : 1 - inj.pCal;
    if (pTrue >= policy.injection_max_p) return out("human", "injection", inj.ref, pTrue);
  }
  const fails = qs
    .filter((q) => /\.crit_\d+$/.test(q.ref.split("@")[0] ?? "") && q.answer === "fails")
    .sort((a, b) => b.pCal - a.pCal);
  const top = fails[0];
  if (top && top.pCal >= policy.exclude_min_p)
    return out("exclude", "criterion_fails", top.ref, top.pCal);
  const topic = byId(".on_topic");
  if (topic && topic.answer === "false" && topic.pCal >= policy.exclude_min_p) {
    return out("exclude", "off_topic", topic.ref, topic.pCal);
  }
  if (top) return out("route", "criterion_fails_uncertain", top.ref, top.pCal);
  if (topic && topic.answer === "false")
    return out("route", "off_topic_uncertain", topic.ref, topic.pCal);
  // Nothing points to exclusion: route on the weakest criterion (never auto-include).
  const weakest = qs
    .filter((q) => /\.crit_\d+$/.test(q.ref.split("@")[0] ?? ""))
    .sort(
      (a, b) => (a.answer === "meets" ? a.pCal : 0) - (b.answer === "meets" ? b.pCal : 0),
    )[0];
  const w = weakest ?? topic ?? qs[0];
  return out("route", "no_exclusion_signal", w?.ref ?? "", w?.pCal ?? 0);
}

function reviewTask(input: ScreenInput, reduced: Reduced, decided: Decided[]): HitlTask {
  return {
    kind: "review",
    card: {
      record_id: input.record_id,
      state: input.state,
      reason: reduced.reason,
      answers: decided.map((d, i) => ({
        question: d.questionRef ?? QUESTION_REFS[i] ?? "",
        answer: d.answer,
        p_cal: d.pCal,
      })),
    },
    decisionPointId: "screen-compiled.route",
    reasonCode: reduced.reason === "injection" ? "below_floor" : "no_threshold",
    label: {
      recordId: input.record_id,
      targetKind: "decision",
      targetRef: "screen.include",
      selectedBy: "reviewer",
    },
  };
}

export const screenCompiled: Workflow<ScreenInput, ScreenOutput> = {
  name: "screen-compiled",
  version: 1,
  async run(ctx: RunCtx, input: ScreenInput): Promise<ScreenOutput> {
    const policy = CRITERIA.policy;
    const decided = await ctx.judge("judge_all", {
      state: input.state,
      questions: [...QUESTION_REFS],
      recordId: input.record_id,
    });
    const reduced = (await ctx.rule("reduce", "screen.reduce@1", {
      decided: decided as unknown as Json,
      refs: [...QUESTION_REFS],
      policy,
    })) as Reduced;

    let out: ScreenOutput;
    if (reduced.verdict === "human") {
      const h = await ctx.human<{ decision: ScreenAnswer }>(
        "review",
        reviewTask(input, reduced, decided),
      );
      out = {
        record_id: input.record_id,
        decision: normaliseAnswer(h.decision),
        decided_by: "human",
        reason: reduced.reason,
      };
    } else {
      const routed = await ctx.route<ScreenAnswer>("route", {
        decisionPoint: "screen-compiled.route",
        state: input.state,
        question: reduced.question,
        // Only `exclude` is gated by a certified threshold (a policy ref: one row per
        // question). The blind LLM may include or flag (both reversible: full-text review
        // follows), and decides when the judge's answer points at no exclusion.
        actions: {
          exclude: { thresholdRef: policy.exclude_threshold_ref },
          include: { reversible: true },
          flag: { reversible: true },
        },
        onUnmapped: "llm",
        fallback: {
          llm: screenLlmReq(input, {
            decisionPoint: "screen-compiled.route",
            teacherBlind: true,
          }),
        },
        auditRate: policy.audit_rate,
        recordId: input.record_id,
      });
      if (routed.branch === "human") {
        const h = await ctx.human<{ decision: ScreenAnswer }>(
          "review",
          reviewTask(input, reduced, decided),
        );
        out = {
          record_id: input.record_id,
          decision: normaliseAnswer(h.decision),
          decided_by: "human",
          reason: routed.reason,
        };
      } else {
        const last = routed.tiers[routed.tiers.length - 1];
        out = {
          record_id: input.record_id,
          decision: routed.branch,
          decided_by: last?.kind === "llm" ? "llm" : "judge",
          reason: routed.reason,
        };
      }
    }
    await ctx.rule("record_effect", "screen.effect@1", out);
    return out;
  },
};

/** The rules both workflows reference, in the kernel's `RuleDef` shape ({ref, fn}). */
export const SCREEN_RULES: ReadonlyArray<{
  ref: `${string}@${number}`;
  fn: (inputs: Json) => Json;
}> = [
  { ref: "screen.effect@1", fn: screenEffect },
  { ref: "screen.reduce@1", fn: screenReduce },
];
