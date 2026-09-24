import type { Decided } from "@dcx/core";
import { describe, expect, it } from "vitest";
import {
  gatePlan,
  humanTier,
  isAudited,
  type ThresholdView,
  tier0Answer,
  tier1Plan,
  tier2Verdict,
  toThresholdView,
  withinBudget,
} from "../src/router.js";

type K = "include" | "exclude";
const keys: K[] = ["include", "exclude"];
const th = (over: Partial<ThresholdView> = {}): ThresholdView => ({
  thresholdId: "t1",
  questionHash: "q",
  backend: "fixture",
  modelV: "jev-1.13.0",
  calibratorId: "c",
  action: "include",
  label: null,
  minP: 0.95,
  bandLo: 0.5,
  onError: "fail_open",
  status: "active",
  ...over,
});
const dec = (answer: string, pCal: number, over: Partial<Decided> = {}): Decided => ({
  questionHash: "q",
  answer,
  probs: {},
  pCal,
  action: "",
  thresholdId: null,
  calibratorId: "c",
  backend: "fixture",
  modelVersion: "jev-1.13.0",
  cacheHit: false,
  degraded: false,
  ...over,
});
const both = { include: th(), exclude: th({ thresholdId: "t2", action: "exclude" }) };

describe("tier1Plan", () => {
  it("auto above τ, tier 2 in the abstain band, human below the floor", () => {
    expect(tier1Plan(dec("include", 0.97), keys, both)).toEqual({
      next: "act",
      branch: "include",
      reason: "above_threshold",
      thresholdId: "t1",
    });
    expect(tier1Plan(dec("exclude", 0.7), keys, both)).toMatchObject({
      next: "llm",
      candidate: "exclude",
      reason: "abstain_band",
      thresholdId: "t2",
    });
    expect(tier1Plan(dec("include", 0.4), keys, both)).toMatchObject({
      next: "human",
      reason: "below_floor",
    });
    expect(tier1Plan(dec("include", 0.95), keys, both).next).toBe("act"); // τ is inclusive
    expect(tier1Plan(dec("include", 0.5), keys, both).next).toBe("llm"); // floor is inclusive
  });
  it("drift, missing or mismatched thresholds and unmapped answers go to human", () => {
    expect(tier1Plan(dec("include", 0.99, { degraded: true }), keys, both).reason).toBe(
      "model_drift",
    );
    expect(tier1Plan(dec("include", 0.99), keys, { exclude: both.exclude }).reason).toBe(
      "no_threshold",
    );
    expect(tier1Plan(dec("other", 0.99), keys, both).reason).toBe("no_threshold");
    for (const bad of [
      { questionHash: "q2" },
      { modelV: "jev-1.14.0" },
      { calibratorId: null },
      { status: "candidate" },
    ]) {
      expect(tier1Plan(dec("include", 0.99), keys, { ...both, include: th(bad) }).reason).toBe(
        "no_threshold",
      );
    }
  });
  it("an unmapped answer escalates to tier 2 only when the route opts in", () => {
    const t = { exclude: th({ label: "fails", thresholdId: "tx" }) };
    expect(tier1Plan(dec("meets", 0.99), keys, t).reason).toBe("no_threshold");
    expect(tier1Plan(dec("meets", 0.99), keys, t, { onUnmapped: "llm" })).toEqual({
      next: "llm",
      candidate: null,
      reason: "abstain_band",
      thresholdId: null,
    });
    expect(tier1Plan(dec("fails", 0.99), keys, t, { onUnmapped: "llm" }).next).toBe("act");
  });
  it("a threshold label maps a judge answer to an action", () => {
    const t = { exclude: th({ label: "fails", thresholdId: "tx" }) };
    expect(tier1Plan(dec("fails", 0.99), keys, t)).toMatchObject({
      next: "act",
      branch: "exclude",
    });
  });
  it("judge errors fail open to tier 2 unless every threshold fails closed", () => {
    expect(tier1Plan(null, keys, both)).toMatchObject({
      next: "llm",
      candidate: null,
      reason: "judge_error",
    });
    const closed = {
      include: th({ onError: "human" }),
      exclude: th({ onError: "fail_closed" }),
    };
    expect(tier1Plan(null, keys, closed)).toMatchObject({
      next: "human",
      reason: "judge_error",
    });
    expect(tier1Plan(dec("include", Number.NaN), keys, both).reason).toBe("judge_error");
  });
});

describe("gatePlan", () => {
  const act = {
    next: "act",
    branch: "include",
    reason: "above_threshold",
    thresholdId: "t1",
  } as const;
  const llm = {
    next: "llm",
    candidate: "include",
    reason: "abstain_band",
    thresholdId: "t1",
  } as const;
  it("audit forces tier 2 on confident decisions, only when affordable", () => {
    expect(gatePlan<K>(act, { audited: true, hasLlm: true, budgetOk: true })).toMatchObject({
      next: "llm",
      candidate: "include",
      reason: "audit_sample",
    });
    expect(gatePlan<K>(act, { audited: true, hasLlm: true, budgetOk: false })).toEqual(act);
    expect(gatePlan<K>(act, { audited: false, hasLlm: true, budgetOk: true })).toEqual(act);
  });
  it("a needed tier 2 degrades to human without an LLM or over budget", () => {
    expect(gatePlan<K>(llm, { audited: false, hasLlm: false, budgetOk: true })).toMatchObject({
      next: "human",
      reason: "abstain_band",
    });
    expect(gatePlan<K>(llm, { audited: false, hasLlm: true, budgetOk: false })).toMatchObject({
      next: "human",
      reason: "budget_exhausted",
    });
  });
});

describe("tier2Verdict", () => {
  const p = { candidate: "include" as K, reason: "abstain_band" as const };
  it("agreement acts; disagreement goes to human unless reversible", () => {
    expect(tier2Verdict<K>(p, "include", keys, () => false)).toEqual({
      branch: "include",
      reason: "abstain_band",
    });
    expect(tier2Verdict<K>(p, "exclude", keys, () => false)).toEqual({
      branch: "human",
      reason: "tier_disagreement",
    });
    expect(tier2Verdict<K>(p, "exclude", keys, (k) => k === "exclude")).toEqual({
      branch: "exclude",
      reason: "abstain_band",
    });
    expect(tier2Verdict<K>(p, "maybe", keys, () => true)).toEqual({
      branch: "human",
      reason: "tier_disagreement",
    });
  });
  it("with no tier-1 candidate (judge error) the LLM answer acts", () => {
    expect(
      tier2Verdict<K>({ candidate: null, reason: "judge_error" }, "exclude", keys, () => false),
    ).toEqual({ branch: "exclude", reason: "judge_error" });
    expect(
      tier2Verdict<K>({ candidate: null, reason: "judge_error" }, null, keys, () => false),
    ).toEqual({ branch: "human", reason: "judge_error" });
  });
});

describe("audit sampling, budgets, tier 0, tier 3, threshold rows", () => {
  it("isAudited is deterministic and close to the rate", () => {
    const ids = Array.from({ length: 20_000 }, (_, i) => `rec-${i}`);
    const a = ids.filter((id) => isAudited("screen.include", id, 0.05));
    expect(ids.filter((id) => isAudited("screen.include", id, 0.05))).toEqual(a);
    expect(a.length / ids.length).toBeGreaterThan(0.045);
    expect(a.length / ids.length).toBeLessThan(0.055);
    expect(isAudited("screen.include", "rec-1", 0)).toBe(false);
    const other = ids.filter((id) => isAudited("other.dp", id, 0.05));
    expect(other).not.toEqual(a); // the salt is the decision point
  });
  it("withinBudget: the cap is hit when spend plus the estimate reaches it", () => {
    expect(withinBudget(0, 0, undefined)).toBe(true);
    expect(withinBudget(0.004, 0.005, 0.01)).toBe(true);
    expect(withinBudget(0.005, 0.005, 0.01)).toBe(false);
    expect(withinBudget(0, 0, 0)).toBe(false);
  });
  it("tier0Answer and humanTier accept keys, {answer} and {label}", () => {
    expect(tier0Answer("exclude", keys)).toBe("exclude");
    expect(tier0Answer({ answer: "include" }, keys)).toBe("include");
    expect(tier0Answer(null, keys)).toBeNull();
    expect(tier0Answer("maybe", keys)).toBeNull();
    expect(humanTier(keys, { answer: "exclude" }).branch).toBe("exclude");
    expect(humanTier(keys, { label: "include" }).tier).toMatchObject({
      tier: 3,
      kind: "human",
    });
    expect(humanTier(keys, { approved: true }).branch).toBe("human");
  });
  it("toThresholdView reads JSON text, the band and the floor column", () => {
    const v = toThresholdView({
      threshold_id: "t",
      question_hash: "q",
      backend: "b",
      model_v: "m",
      calibrator_id: null,
      action: "include",
      rule: JSON.stringify({ label: "meets", min_p: 0.9, on_error: "human" }),
      floor: 0.6,
      status: "active",
    });
    expect(v).toMatchObject({
      label: "meets",
      minP: 0.9,
      bandLo: 0.6,
      onError: "human",
      calibratorId: null,
    });
    const w = toThresholdView({
      threshold_id: "t",
      rule: { min_p: 0.9, abstain_band: [0.7, 0.9] },
      floor: 0.5,
    });
    expect(w.bandLo).toBe(0.7);
  });
});
