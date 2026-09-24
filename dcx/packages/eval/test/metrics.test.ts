import { describe, expect, it } from "vitest";
import {
  agreement,
  bootstrapCI,
  brier,
  cohensKappa,
  confusion,
  ece,
  eceNoiseFloor,
  kappaHalfWidth,
  median,
  mulberry32,
  nForWilsonLower,
  nll,
  precisionCI,
  REFERENCE_FLOOR_SETTING,
  recallCI,
  referenceEceFloor,
  reliabilityBins,
  riskCoverage,
  selectiveAccuracyAt,
  wilson,
  zeroFailureLower,
  zeroFailureN,
} from "../src/index.js";

const P = [0.1, 0.3, 0.35, 0.9, 0.95];
const Y = [0, 1, 0, 1, 1];

describe("ECE, Brier, NLL against hand-computed values", () => {
  it("equal-width ECE", () => {
    // bins of width 0.2: b0 {0.1}: conf 0.1, acc 0 → |0.1|·1 = 0.10
    //                    b1 {0.3, 0.35}: conf 0.325, acc 0.5 → |0.175|·2 = 0.35
    //                    b4 {0.9, 0.95}: conf 0.925, acc 1 → |0.075|·2 = 0.15
    // ECE = (0.10 + 0.35 + 0.15) / 5 = 0.12
    expect(ece(P, Y)).toBeCloseTo(0.12, 12);
    const bins = reliabilityBins(P, Y);
    expect(bins.map((b) => [b.bin, b.n])).toEqual([
      [0, 1],
      [1, 2],
      [4, 2],
    ]);
    expect(bins[1]?.conf).toBeCloseTo(0.325, 12);
    expect(bins[1]?.lo).toBeCloseTo(0.2, 12);
  });

  it("equal-mass ECE", () => {
    // 5 bins over 5 items: one item per bin, so ECE = mean |p − y|
    // = (0.1 + 0.7 + 0.35 + 0.1 + 0.05) / 5 = 1.3 / 5 = 0.26
    expect(ece(P, Y, { strategy: "mass" })).toBeCloseTo(0.26, 12);
    // 2 mass bins: sorted items 0..1 | 2..4 → {0.1, 0.3}: conf 0.2, acc 0.5 → 0.3·2 = 0.6
    // {0.35, 0.9, 0.95}: conf 0.7333…, acc 0.6667 → 0.0667·3 = 0.2 → ECE = 0.8/5 = 0.16
    expect(ece(P, Y, { bins: 2, strategy: "mass" })).toBeCloseTo(0.16, 12);
  });

  it("Brier and NLL", () => {
    // (0.01 + 0.49 + 0.1225 + 0.01 + 0.0025) / 5 = 0.635 / 5 = 0.127
    expect(brier(P, Y)).toBeCloseTo(0.127, 12);
    // −(ln 0.9 + ln 0.3 + ln 0.65 + ln 0.9 + ln 0.95) / 5
    const want =
      -(Math.log(0.9) + Math.log(0.3) + Math.log(0.65) + Math.log(0.9) + Math.log(0.95)) / 5;
    expect(nll(P, Y)).toBeCloseTo(want, 12);
  });

  it("rejects mismatched lengths", () => {
    expect(() => brier([0.5], [])).toThrow(/length/);
  });
});

describe("Wilson and sample-size bounds (04 §3.7)", () => {
  it("10/11 gives §4.8's [0.62, 0.98]", () => {
    // p = 0.9091, z² = 3.8416, d = 1 + 3.8416/11 = 1.34924
    // centre = (0.90909 + 3.8416/22) / d = 0.80320
    // margin = 1.96·√(0.082645/11 + 3.8416/484) / d = 0.18057 → [0.6226, 0.9838]
    const w = wilson(10, 11);
    expect(w.lo).toBeCloseTo(0.6226, 4);
    expect(w.hi).toBeCloseTo(0.9838, 4);
  });
  it("04 §3.12: 502/515 has lower bound 0.957", () => {
    expect(wilson(502, 515).lo).toBeCloseTo(0.957, 3);
  });
  it("edge cases", () => {
    expect(wilson(0, 0)).toMatchObject({ lo: 0, hi: 1 });
    expect(wilson(0, 10).lo).toBe(0);
    expect(wilson(10, 10).hi).toBe(1);
    // all-success lower bound = n / (n + z²): 10 / 13.8416
    expect(wilson(10, 10).lo).toBeCloseTo(10 / 13.8416, 10);
  });
  it("zero-failure counts: 598 at 99.5%, 299 at 99%, 149 at 98%", () => {
    expect(zeroFailureN(0.995)).toBe(598);
    expect(zeroFailureN(0.99)).toBe(299);
    expect(zeroFailureN(0.98)).toBe(149);
    expect(zeroFailureLower(598)).toBeGreaterThanOrEqual(0.995);
    expect(zeroFailureLower(597)).toBeLessThan(0.995);
  });
  it("nForWilsonLower is the first n whose lower bound clears the target", () => {
    for (const pObs of [0.975, 0.97]) {
      const n = nForWilsonLower(pObs, 0.95);
      expect(wilson(pObs * n, n).lo).toBeGreaterThanOrEqual(0.95);
      expect(wilson(pObs * (n - 1), n - 1).lo).toBeLessThan(0.95);
    }
    // Wilson 95% gives 292 and 457 (doc 04 quotes ≈260 and ≈415, which do not reproduce).
    expect(nForWilsonLower(0.975, 0.95)).toBe(292);
    expect(nForWilsonLower(0.97, 0.95)).toBe(457);
    expect(nForWilsonLower(0.9, 0.95)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("Cohen's κ golden cases", () => {
  const fromTable = (t: number[][]) => {
    const a: string[] = [];
    const b: string[] = [];
    t.forEach((row, i) => {
      row.forEach((c, j) => {
        for (let k = 0; k < c; k++) {
          a.push(`c${i}`);
          b.push(`c${j}`);
        }
      });
    });
    return [a, b] as const;
  };
  it("[[20,5],[10,15]]: p_o 0.7, p_e 0.5 → κ 0.4", () => {
    // p_e = (25/50)(30/50) + (25/50)(20/50) = 0.3 + 0.2 = 0.5
    const [a, b] = fromTable([
      [20, 5],
      [10, 15],
    ]);
    const k = cohensKappa(a, b);
    expect(k.po).toBeCloseTo(0.7, 12);
    expect(k.pe).toBeCloseTo(0.5, 12);
    expect(k.kappa).toBeCloseTo(0.4, 12);
  });
  it("[[45,15],[25,15]]: p_o 0.6, p_e 0.54 → κ 0.1304", () => {
    // row marginals 60/40, column marginals 70/30: p_e = 0.6·0.7 + 0.4·0.3 = 0.54
    const [a, b] = fromTable([
      [45, 15],
      [25, 15],
    ]);
    expect(cohensKappa(a, b).kappa).toBeCloseTo(0.06 / 0.46, 12);
  });
  it("3 classes and degenerate cases", () => {
    // [[5,1,0],[0,4,1],[1,0,8]]: n 20, p_o 17/20 = 0.85
    // rows 6,5,9; cols 6,5,9 → p_e = (36+25+81)/400 = 0.355 → κ = 0.495/0.645
    const [a, b] = fromTable([
      [5, 1, 0],
      [0, 4, 1],
      [1, 0, 8],
    ]);
    expect(cohensKappa(a, b).kappa).toBeCloseTo(0.495 / 0.645, 12);
    expect(cohensKappa(["x", "x"], ["x", "x"]).kappa).toBe(1);
    expect(cohensKappa(["x", "y"], ["y", "x"]).kappa).toBeCloseTo(-1, 12);
    expect(agreement(a, b)).toBeCloseTo(0.85, 12);
    expect(confusion(["a", "a", "b"], ["a", "b", "b"])).toEqual({
      a: { a: 1, b: 1 },
      b: { b: 1 },
    });
  });
  it("κ precision: n=200, p_o 0.92, p_e 0.5 → ±0.075; n=400 → ±0.053 (04 §3.7)", () => {
    // 1.96·√(0.92·0.08/200)/0.5 = 1.96·0.019183/0.5 = 0.0752
    expect(kappaHalfWidth(0.92, 0.5, 200)).toBeCloseTo(0.075, 3);
    expect(kappaHalfWidth(0.92, 0.5, 400)).toBeCloseTo(0.053, 3);
  });
});

describe("ECE noise floor", () => {
  it(`reproduces 04 §3.6's table (p̂ ~ Beta(${REFERENCE_FLOOR_SETTING.alpha},1), 5 bins, 2,000 sims)`, () => {
    expect(Math.abs(referenceEceFloor(200).mean - 0.032)).toBeLessThan(0.0015);
    expect(Math.abs(referenceEceFloor(60).mean - 0.057)).toBeLessThan(0.002);
    expect(Math.abs(referenceEceFloor(400).mean - 0.022)).toBeLessThan(0.0015);
    expect(Math.abs(referenceEceFloor(600).mean - 0.019)).toBeLessThan(0.0015);
  });
  it("observed-p floor is seeded, shrinks with n and has p95 above the mean", () => {
    const rnd = mulberry32(3);
    const p = Array.from({ length: 400 }, () => rnd() ** (1 / 6));
    const a = eceNoiseFloor(p, { sims: 500 });
    expect(eceNoiseFloor(p, { sims: 500 })).toEqual(a);
    expect(a.p95).toBeGreaterThan(a.mean);
    expect(eceNoiseFloor(p.slice(0, 100), { sims: 500 }).mean).toBeGreaterThan(a.mean);
  });
});

describe("bootstrap CIs", () => {
  const xs = Array.from({ length: 40 }, (_, i) => ({ pred: i % 5 !== 0, truth: i % 2 === 0 }));
  it("is deterministic under a fixed seed and brackets the estimate", () => {
    const r = recallCI(xs);
    expect(recallCI(xs)).toEqual(r);
    // truth rows: even i (20); pred false when i % 10 === 0 (4 of them) → recall 16/20
    expect(r.value).toBeCloseTo(0.8, 12);
    expect(r.lo).toBeLessThanOrEqual(0.8);
    expect(r.hi).toBeGreaterThanOrEqual(0.8);
    expect(recallCI(xs, { seed: 99 })).not.toEqual(r);
    // precision: pred true on 32 rows, 16 of them even → 0.5
    expect(precisionCI(xs).value).toBeCloseTo(0.5, 12);
  });
  it("all-correct data gives a degenerate [1, 1]", () => {
    expect(bootstrapCI([1, 1, 1], (d) => d.reduce((s, x) => s + x, 0) / d.length)).toEqual({
      value: 1,
      lo: 1,
      hi: 1,
    });
  });
});

describe("risk–coverage and selective accuracy", () => {
  it("hand-computed curve", () => {
    // sorted by confidence: 0.9 ✓, 0.8 ✓, 0.7 ✗, 0.6 ✓
    const pts = riskCoverage([0.6, 0.9, 0.7, 0.8], [1, 1, 0, 1]);
    expect(pts.map((p) => [p.coverage, p.selectiveAccuracy])).toEqual([
      [0.25, 1],
      [0.5, 1],
      [0.75, 2 / 3],
      [1, 0.75],
    ]);
    expect(
      selectiveAccuracyAt([0.6, 0.9, 0.7, 0.8], [1, 1, 0, 1], 0.6)?.selectiveAccuracy,
    ).toBe(2 / 3);
  });
  it("keeps ties together", () => {
    const pts = riskCoverage([0.9, 0.9, 0.5], [1, 0, 1]);
    expect(pts.map((p) => p.n)).toEqual([2, 3]);
  });
  it("median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});
