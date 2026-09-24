// 07 §6 calibration test: a known miscalibrated synthetic backend, corrected by isotonic
// regression, must land within 2× its ECE noise floor (gate G5) with a monotone curve.
import { calibrate } from "@dcx/core";
import { describe, expect, it } from "vitest";
import { ece, eceNoiseFloor, mulberry32, reliabilityBins } from "../src/index.js";

// TODO(judge): reuse @dcx/judge's isotonic fitter once it lands. A minimal pool-adjacent-
// violators fit returning core's `{knots}` params (block mean x → block mean y).
function fitIsotonic(p: readonly number[], y: readonly boolean[]): Array<[number, number]> {
  const order = p.map((_, i) => i).sort((a, b) => (p[a] ?? 0) - (p[b] ?? 0));
  const blocks: Array<{ sx: number; sy: number; n: number }> = [];
  for (const i of order) {
    blocks.push({ sx: p[i] ?? 0, sy: y[i] ? 1 : 0, n: 1 });
    for (;;) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (!a || !b || a.sy / a.n < b.sy / b.n) break;
      blocks.splice(-2, 2, { sx: a.sx + b.sx, sy: a.sy + b.sy, n: a.n + b.n });
    }
  }
  return blocks.map((b) => [b.sx / b.n, b.sy / b.n]);
}

const logit = (q: number) => Math.log(q / (1 - q));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** True P(y) q ~ U(0.02, 0.98); the backend reports sigmoid(3·logit(q)): overconfident. */
function synth(n: number, seed: number) {
  const rnd = mulberry32(seed);
  const p: number[] = [];
  const y: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const q = 0.02 + 0.96 * rnd();
    p.push(sigmoid(3 * logit(q)));
    y.push(rnd() < q);
  }
  return { p, y };
}

describe("miscalibrated synthetic backend", () => {
  it("isotonic brings holdout ECE within 2× the noise floor", () => {
    const tune = synth(2000, 11);
    const hold = synth(500, 12);
    const knots = fitIsotonic(tune.p, tune.y);
    const pCal = hold.p.map((x) => calibrate("isotonic", { knots }, x) ?? x);

    const rawEce = ece(hold.p, hold.y);
    const rawFloor = eceNoiseFloor(hold.p).mean;
    const calEce = ece(pCal, hold.y);
    const calFloor = eceNoiseFloor(pCal).mean;

    expect(rawEce).toBeGreaterThan(2 * rawFloor); // miscalibrated before
    expect(calEce).toBeLessThanOrEqual(2 * calFloor); // G5 after
    const acc = reliabilityBins(pCal, hold.y).map((b) => b.acc);
    expect(acc.every((a, i) => i === 0 || a >= (acc[i - 1] ?? 0))).toBe(true);
  });
});
