// Read-time calibration: the reference TS implementation of the DuckDB `calibrate` /
// `calibrate_probs` macros (schema/duckdb.sql). The two must agree to 1e-9; core's tests check
// it. Fitting lives in @dcx/judge; this file only applies a fitted row. 02 §3.4, 07 §3 item 6.

import type { CalibratorMethod, CalibratorParams, QType } from "./types.js";

/** Clamp used before logit, so p = 0 or 1 stays finite. */
export const CALIBRATION_EPS = 1e-6;

const clamp01 = (p: number) => Math.min(1 - CALIBRATION_EPS, Math.max(CALIBRATION_EPS, p));
const logit = (p: number) => {
  const q = clamp01(p);
  return Math.log(q / (1 - q));
};
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** Piecewise-linear interpolation over x-ascending knots, clamped to the end values. On a step
 *  (repeated x) the right-hand value wins. Empty knots → identity. */
export function interpolateKnots(knots: ReadonlyArray<readonly [number, number]>, p: number) {
  const n = knots.length;
  if (n === 0) return p;
  const first = knots[0] as readonly [number, number];
  const last = knots[n - 1] as readonly [number, number];
  if (p <= first[0]) return first[1];
  if (p >= last[0]) return last[1];
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = knots[i] as readonly [number, number];
    const [x1, y1] = knots[i + 1] as readonly [number, number];
    if (x0 <= p && p < x1) return y0 + ((y1 - y0) * (p - x0)) / (x1 - x0);
  }
  return p;
}

function num(params: CalibratorParams, key: string): number {
  const v = (params as Record<string, unknown>)[key];
  if (typeof v !== "number") throw new Error(`calibrator params missing number "${key}"`);
  return v;
}

/**
 * `calibrate(method, params, p)`: maps one probability.
 * - identity / null method: p
 * - temperature {T}: sigmoid(logit(p) / T)             (binary form; see calibrateProbs)
 * - platt {a, b}:    sigmoid(a · logit(p) + b)
 * - isotonic | histogram {knots}: interpolateKnots(knots, p)
 * logit clamps p to [1e-6, 1 − 1e-6]. Null p → null.
 */
export function calibrate(
  method: CalibratorMethod | null | undefined,
  params: CalibratorParams | null | undefined,
  p: number | null,
): number | null {
  if (p === null || Number.isNaN(p)) return null;
  if (!method || method === "identity") return p;
  const ps = params ?? {};
  switch (method) {
    case "temperature":
      return sigmoid(logit(p) / num(ps, "T"));
    case "platt":
      return sigmoid(num(ps, "a") * logit(p) + num(ps, "b"));
    case "isotonic":
    case "histogram": {
      const knots = (ps as { knots?: Array<[number, number]> }).knots ?? [];
      return interpolateKnots(knots, p);
    }
    default:
      throw new Error(`unknown calibrator method: ${String(method)}`);
  }
}

/**
 * `calibrate_probs(method, params, probs, answer, p)`: for Choice/Score. Temperature with ≥2
 * probs uses the multiclass form p_answer^(1/T) / Σ_k p_k^(1/T) (= softmax(log p / T)); every
 * other case falls back to `calibrate(method, params, p)` on the chosen probability.
 */
export function calibrateProbs(
  method: CalibratorMethod | null | undefined,
  params: CalibratorParams | null | undefined,
  probs: Readonly<Record<string, number>> | null | undefined,
  answer: string,
  p: number | null,
): number | null {
  if (method === "temperature" && probs && Object.keys(probs).length >= 2) {
    const pa = probs[answer] ?? p;
    if (pa === null || pa === undefined) return null;
    const inv = 1 / num(params ?? {}, "T");
    const z = Object.values(probs).reduce((s, x) => s + x ** inv, 0);
    return z > 0 ? pa ** inv / z : null;
  }
  return calibrate(method, params, p);
}

/**
 * The decisions view's full rule: Noul calibrates P(true) with `calibrate`; Choice/Score use
 * `calibrateProbs`. Returns both the calibrated p_answer (`pCal`, Noul: P(true)) and the
 * calibrated probability of the chosen answer (`pCalAnswer`, Noul: max side) the router uses.
 */
export function calibrateAnswer(
  qtype: QType,
  method: CalibratorMethod | null | undefined,
  params: CalibratorParams | null | undefined,
  answer: string,
  pAnswer: number | null,
  probs?: Readonly<Record<string, number>> | null,
): { pCal: number | null; pCalAnswer: number | null } {
  if (qtype === "noul") {
    const pCal = calibrate(method, params, pAnswer);
    const pCalAnswer = pCal === null ? null : answer === "true" ? pCal : 1 - pCal;
    return { pCal, pCalAnswer };
  }
  const pCal = calibrateProbs(method, params, probs, answer, pAnswer);
  return { pCal, pCalAnswer: pCal };
}
