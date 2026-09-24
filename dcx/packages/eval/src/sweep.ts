// Threshold sweep per action with a pre-registered, fixed τ sequence (04 §3.6 "selective
// accuracy": strict → loose, keep the loosest τ that passes before the first failure, the
// Learn-then-Test fixed-sequence idea), a cost matrix (02 §3.4) and the zero-failure bound for
// irreversible actions (04 §3.7). The result maps onto a `thresholds` row.

import type { CostMatrix, ThresholdRow, ThresholdRule } from "@dcx/core";
import { wilson, zeroFailureLower, zeroFailureN } from "./metrics.js";

/** Spec §8 Q7 default: $50 for a wrong action, $0.50 for a human glance → τ ≈ 0.99. The LLM
 *  cost is 07 §6's c_LLM ≈ $0.005; its error rate (5%) is a placeholder, and at these costs the
 *  LLM band never beats human review (0.005 + 0.05·50 > 0.5), so "everything else goes to
 *  review". */
export const DEFAULT_COST_MATRIX: CostMatrix = {
  wrong_auto: 50,
  human_review: 0.5,
  llm_call: 0.005,
  llm_error_rate: 0.05,
};

/** The pre-registered τ sequence, strict → loose. Fixed so a sweep cannot cherry-pick. */
export const DEFAULT_TAU_SEQUENCE: readonly number[] = [
  0.999, 0.998, 0.995, 0.99, 0.985, 0.98, 0.975, 0.97, 0.96, 0.95, 0.94, 0.93, 0.92, 0.91, 0.9,
  0.875, 0.85, 0.825, 0.8, 0.775, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5,
];

/** Break-even precision for auto-acting: act iff (1 − precision)·C_wrong ≤ C_human, i.e.
 *  precision ≥ 1 − C_human / C_wrong (02 §3.4). */
export const breakEvenPrecision = (cm: CostMatrix): number =>
  1 - cm.human_review / cm.wrong_auto;

/** One calibration item for an action: the calibrated probability the action is right, and
 *  whether it was (against labels). */
export interface SweepItem {
  p: number;
  correct: boolean;
}

export interface SweepOpts {
  action: string;
  costMatrix?: CostMatrix;
  /** Precision target on the covered set; default breakEvenPrecision(costMatrix). */
  target?: number;
  taus?: readonly number[];
  /** Irreversible actions: require zero errors on ≥ zeroFailureN(target, delta) covered rows. */
  zeroFailure?: boolean;
  /** Wilson z (default 1.96: a one-sided 97.5% lower bound). */
  z?: number;
  /** One-sided failure probability for the zero-failure bound (default 0.05, rule of three). */
  zeroFailureDelta?: number;
}

export interface SweepPoint {
  tau: number;
  nCovered: number;
  errors: number;
  coverage: number;
  precision: number;
  /** Wilson lower bound of precision (or the zero-failure bound when `zeroFailure`). */
  lowerBound: number;
  /** False when even zero errors could not pass at this n: skipped, not a failure. */
  tested: boolean;
  pass: boolean;
  /** Empirical cost per incoming item: (errors·C_wrong + uncovered·C_human) / n. */
  costPerItem: number;
}

export interface SweepResult {
  action: string;
  target: number;
  costMatrix: CostMatrix;
  mode: "wilson" | "zero_failure";
  points: SweepPoint[];
  /** Loosest τ passing before the first failure; null → infeasible at this n (human only). */
  tau: number | null;
  lowerBound: number | null;
  coverage: number;
  /** Upper bound on P(auto-acted ∧ wrong) per incoming item at τ (Wilson hi). */
  certifiedLoss: number | null;
  nCal: number;
  /** α = 1 − target (allowed error share on the covered set); δ = one-sided failure prob. */
  alpha: number;
  delta: number;
  status: "candidate" | "human_only";
}

/** Sweep a fixed τ sequence for one action. */
export function sweepThresholds(items: readonly SweepItem[], opts: SweepOpts): SweepResult {
  const cm = opts.costMatrix ?? DEFAULT_COST_MATRIX;
  const target = opts.target ?? breakEvenPrecision(cm);
  const z = opts.z ?? 1.96;
  const zfDelta = opts.zeroFailureDelta ?? 0.05;
  const zf = opts.zeroFailure ?? false;
  const n = items.length;
  const points: SweepPoint[] = [];
  let chosen: SweepPoint | null = null;
  let stopped = false;
  for (const tau of opts.taus ?? DEFAULT_TAU_SEQUENCE) {
    const cov = items.filter((it) => it.p >= tau);
    const nCovered = cov.length;
    const errors = cov.filter((it) => !it.correct).length;
    const lowerBound = zf
      ? errors === 0
        ? zeroFailureLower(nCovered, zfDelta)
        : 0
      : wilson(nCovered - errors, nCovered, z).lo;
    const tested = zf
      ? nCovered >= zeroFailureN(target, zfDelta)
      : wilson(nCovered, nCovered, z).lo >= target;
    const pass = !stopped && tested && lowerBound >= target;
    const pt: SweepPoint = {
      tau,
      nCovered,
      errors,
      coverage: n ? nCovered / n : 0,
      precision: nCovered ? (nCovered - errors) / nCovered : Number.NaN,
      lowerBound,
      tested,
      pass,
      costPerItem: n ? (errors * cm.wrong_auto + (n - nCovered) * cm.human_review) / n : 0,
    };
    points.push(pt);
    if (tested && !stopped) {
      if (pass) chosen = pt;
      else stopped = true;
    }
  }
  return {
    action: opts.action,
    target,
    costMatrix: cm,
    mode: zf ? "zero_failure" : "wilson",
    points,
    tau: chosen?.tau ?? null,
    lowerBound: chosen?.lowerBound ?? null,
    coverage: chosen?.coverage ?? 0,
    certifiedLoss: chosen ? wilson(chosen.errors, n, z).hi : null,
    nCal: n,
    alpha: 1 - target,
    delta: zf ? zfDelta : 0.025,
    status: chosen ? "candidate" : "human_only",
  };
}

/** The `thresholds` columns a sweep determines. The caller adds ids, keys and validity. An
 *  infeasible sweep gives status `human_only` and `min_p` 1 (never auto-act). */
export function thresholdFields(
  r: SweepResult,
  opts: { label?: string | null; onError?: ThresholdRule["on_error"] } = {},
): Pick<
  ThresholdRow,
  | "action"
  | "rule"
  | "cost_matrix"
  | "alpha"
  | "delta"
  | "certified_loss"
  | "coverage"
  | "n_cal"
  | "status"
> {
  return {
    action: r.action,
    rule: { label: opts.label ?? null, min_p: r.tau ?? 1, on_error: opts.onError ?? "human" },
    cost_matrix: r.costMatrix,
    alpha: r.alpha,
    delta: r.delta,
    certified_loss: r.certifiedLoss,
    coverage: r.coverage,
    n_cal: r.nCal,
    status: r.status,
  };
}
