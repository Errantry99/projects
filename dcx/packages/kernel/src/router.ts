// The cascade router's tier logic and reason codes as pure functions (03 §3.4, 07 §4.3).
// tier0 compiled rule → tier1 judge (calibrated p vs the threshold row) → tier2 blind LLM →
// human. τ, band, floor and on_error are data (threshold rows), never code constants.

import { type Decided, hashUnit, type Json, type ReasonCode, type TierResult } from "@dcx/core";

/** A `thresholds` row as the router needs it. */
export interface ThresholdView {
  thresholdId: string;
  questionHash: string;
  backend: string;
  modelV: string;
  calibratorId: string | null;
  action: string;
  /** Only this answer triggers the action; null = the action key itself is the answer. */
  label: string | null;
  minP: number;
  /** `rule.abstain_band[0]`, else the `floor` column. */
  bandLo: number;
  onError: "human" | "fail_closed" | "fail_open";
  status: string;
}

/** What to do after tiers 0/1. `candidate` is the branch tier 2 is checked against. */
export type Plan<K extends string> =
  | { next: "act"; branch: K; reason: ReasonCode; thresholdId: string | null }
  | { next: "llm"; candidate: K | null; reason: ReasonCode; thresholdId: string | null }
  | { next: "human"; reason: ReasonCode; thresholdId: string | null };

/** A route's final branch and reason. */
export interface Verdict<K extends string> {
  branch: K | "human";
  reason: ReasonCode;
}

/** Parse a `thresholds` row (JSON columns may arrive as text). */
export function toThresholdView(row: Record<string, Json>): ThresholdView {
  const rule = (typeof row.rule === "string" ? JSON.parse(row.rule) : row.rule) as {
    label?: string | null;
    min_p: number;
    abstain_band?: [number, number];
    on_error?: ThresholdView["onError"];
  };
  const floor = typeof row.floor === "number" ? row.floor : Number(row.floor ?? rule.min_p);
  return {
    thresholdId: String(row.threshold_id),
    questionHash: String(row.question_hash),
    backend: String(row.backend),
    modelV: String(row.model_v),
    calibratorId: row.calibrator_id == null ? null : String(row.calibrator_id),
    action: String(row.action),
    label: rule.label ?? null,
    minP: Number(rule.min_p),
    bandLo: rule.abstain_band?.[0] ?? floor,
    onError: rule.on_error ?? "fail_open",
    status: String(row.status),
  };
}

/** Hashed audit share: deterministic in (salt, record id). 03 §3.4, CONTRACT §5 `hashUnit`. */
export function isAudited(salt: string, recordId: string, rate: number): boolean {
  return rate > 0 && hashUnit(`${salt}:${recordId}`) < rate;
}

/** A tier-0 rule's output as an action key, or null when it abstains. */
export function tier0Answer<K extends string>(out: Json, keys: readonly K[]): K | null {
  const a =
    typeof out === "string"
      ? out
      : out && typeof out === "object" && !Array.isArray(out) && typeof out.answer === "string"
        ? out.answer
        : null;
  return a !== null && (keys as readonly string[]).includes(a) ? (a as K) : null;
}

/** Does this threshold row apply to this decision (same question hash, model, calibrator)? */
export function thresholdApplies(t: ThresholdView | undefined, d: Decided): t is ThresholdView {
  return (
    t !== undefined &&
    t.status === "active" &&
    t.questionHash === d.questionHash &&
    (d.modelVersion === undefined || t.modelV === d.modelVersion) &&
    (d.backend === undefined || t.backend === d.backend) &&
    t.calibratorId === d.calibratorId
  );
}

/**
 * Tier 1: the judge's calibrated p against the threshold of the action its answer maps to.
 * `d === null` is a judge error: routes fail open to tier 2 unless every threshold says
 * otherwise. Drift → human. No applicable threshold → human (no_threshold). An answer that maps
 * to no action → human, or tier 2 with no candidate when `onUnmapped` is `llm`.
 */
export function tier1Plan<K extends string>(
  d: Decided | null,
  keys: readonly K[],
  th: Partial<Record<K, ThresholdView>>,
  opts: { onUnmapped?: "human" | "llm" } = {},
): Plan<K> {
  if (d === null || !Number.isFinite(d.pCal)) {
    const modes = keys.map((k) => th[k]?.onError).filter((m) => m !== undefined);
    const closed = modes.length > 0 && modes.every((m) => m !== "fail_open");
    return closed
      ? { next: "human", reason: "judge_error", thresholdId: null }
      : { next: "llm", candidate: null, reason: "judge_error", thresholdId: null };
  }
  if (d.degraded) return { next: "human", reason: "model_drift", thresholdId: null };
  const k = keys.find((key) => (th[key]?.label ?? key) === d.answer);
  if (k === undefined && opts.onUnmapped === "llm") {
    // The answer points at no gated action: tier 1 abstains and tier 2 decides.
    return { next: "llm", candidate: null, reason: "abstain_band", thresholdId: null };
  }
  const t = k === undefined ? undefined : th[k];
  if (k === undefined || !thresholdApplies(t, d)) {
    return { next: "human", reason: "no_threshold", thresholdId: null };
  }
  if (d.pCal >= t.minP) {
    return { next: "act", branch: k, reason: "above_threshold", thresholdId: t.thresholdId };
  }
  if (d.pCal >= t.bandLo) {
    return { next: "llm", candidate: k, reason: "abstain_band", thresholdId: t.thresholdId };
  }
  return { next: "human", reason: "below_floor", thresholdId: t.thresholdId };
}

/** Apply the audit share and the budget: an audited auto decision still runs tier 2; a needed
 *  tier 2 with no LLM, or over budget, goes to human (never the LLM). */
export function gatePlan<K extends string>(
  p: Plan<K>,
  f: { audited: boolean; hasLlm: boolean; budgetOk: boolean },
): Plan<K> {
  if (p.next === "act") {
    return f.audited && f.hasLlm && f.budgetOk
      ? { next: "llm", candidate: p.branch, reason: "audit_sample", thresholdId: p.thresholdId }
      : p;
  }
  if (p.next === "llm" && !f.hasLlm) return { ...p, next: "human" };
  if (p.next === "llm" && !f.budgetOk) {
    return { next: "human", reason: "budget_exhausted", thresholdId: p.thresholdId };
  }
  return p;
}

/** Tier 2: act when the blind LLM agrees with the candidate, or its action is reversible (or
 *  there was no candidate); otherwise human with tier_disagreement. */
export function tier2Verdict<K extends string>(
  p: { candidate: K | null; reason: ReasonCode },
  llmAnswer: string | null,
  keys: readonly K[],
  reversible: (k: K) => boolean,
): Verdict<K> {
  if (llmAnswer === null || !(keys as readonly string[]).includes(llmAnswer)) {
    return { branch: "human", reason: p.candidate === null ? p.reason : "tier_disagreement" };
  }
  const a = llmAnswer as K;
  if (p.candidate === null || a === p.candidate || reversible(a)) {
    return { branch: a, reason: p.reason };
  }
  return { branch: "human", reason: "tier_disagreement" };
}

/** A cap is hit when spend so far plus the expected call reaches it. */
export function withinBudget(
  spent: number,
  estimate: number,
  cap: number | undefined,
): boolean {
  return cap === undefined || spent + estimate < cap;
}

/** Fold a human resolution into a route's outcome (tier 3). A resolution is an action key,
 *  `{answer}` or `{label}`; anything else leaves the branch "human". */
export function humanTier<K extends string>(
  keys: readonly K[],
  resolution: Json,
): { branch: K | "human"; tier: TierResult } {
  const r = resolution as { answer?: Json; label?: Json } | string | null;
  const a =
    typeof r === "string"
      ? r
      : r && typeof r === "object"
        ? typeof r.answer === "string"
          ? r.answer
          : typeof r.label === "string"
            ? r.label
            : null
        : null;
  const branch = a !== null && (keys as readonly string[]).includes(a) ? (a as K) : "human";
  return { branch, tier: { tier: 3, kind: "human", answer: a, p: null, costUsd: 0 } };
}
