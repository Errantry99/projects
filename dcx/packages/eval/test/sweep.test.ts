import { describe, expect, it } from "vitest";
import {
  breakEvenPrecision,
  DEFAULT_COST_MATRIX,
  DEFAULT_TAU_SEQUENCE,
  type SweepItem,
  sweepThresholds,
  thresholdFields,
} from "../src/index.js";

const rep = (n: number, p: number, correct: boolean): SweepItem[] =>
  Array.from({ length: n }, () => ({ p, correct }));

describe("threshold sweep", () => {
  it("default cost matrix: $50 wrong, $0.50 glance → break-even precision 0.99", () => {
    // 1 − 0.5 / 50 = 0.99 (02 §3.4, spec §8 Q7)
    expect(breakEvenPrecision(DEFAULT_COST_MATRIX)).toBeCloseTo(0.99, 12);
    expect(DEFAULT_TAU_SEQUENCE[0]).toBeGreaterThan(DEFAULT_TAU_SEQUENCE.at(-1) ?? 1);
  });

  it("is infeasible at small n and ships human-only", () => {
    // 120 rows, all right at p 0.995: Wilson lb 120/123.84 = 0.969 < 0.99 at every τ
    const r = sweepThresholds(rep(120, 0.995, true), { action: "auto_exclude" });
    expect(r.tau).toBeNull();
    expect(r.status).toBe("human_only");
    expect(r.points.every((p) => !p.tested)).toBe(true);
    const f = thresholdFields(r, { label: "fails" });
    expect(f.rule).toEqual({ label: "fails", min_p: 1, on_error: "human" });
    expect(f).toMatchObject({ status: "human_only", n_cal: 120, coverage: 0 });
    expect(f.alpha).toBeCloseTo(0.01, 12);
  });

  it("stops at the first failure in the fixed sequence", () => {
    // τ 0.95: 100 covered, 0 errors → lb 100/103.84 = 0.963 ≥ 0.9 pass
    // τ 0.90: 140 covered, 10 errors → precision 0.929, lb 0.873 < 0.9 fail → stop
    // τ 0.80: 540 covered, 10 errors → lb ≈ 0.966 would pass, but the sequence has stopped
    const items = [...rep(100, 0.97, true), ...rep(30, 0.92, true), ...rep(10, 0.92, false)];
    items.push(...rep(400, 0.85, true));
    const r = sweepThresholds(items, { action: "a", target: 0.9, taus: [0.95, 0.9, 0.8] });
    expect(r.points.map((p) => [p.nCovered, p.errors, p.pass])).toEqual([
      [100, 0, true],
      [140, 10, false],
      [540, 10, false],
    ]);
    expect(r.points[2]?.lowerBound).toBeGreaterThan(0.9);
    expect(r.tau).toBe(0.95);
    expect(r.lowerBound).toBeCloseTo(100 / 103.8416, 10);
    expect(r.coverage).toBeCloseTo(100 / 540, 12);
    expect(r.nCal).toBe(540);
    // certified loss = Wilson hi of 0 wrong autos in 540 incoming = 3.8416 / 543.8416
    expect(r.certifiedLoss).toBeCloseTo(3.8416 / 543.8416, 10);
    // cost per item at τ 0.95: 440 uncovered × $0.50 / 540
    expect(r.points[0]?.costPerItem).toBeCloseTo((440 * 0.5) / 540, 12);
  });

  it("skips τ that cannot pass at their n instead of failing on them", () => {
    // τ 0.99: 10 covered, lb ≤ 10/13.84 = 0.72 even with zero errors → untested
    const items = [...rep(10, 0.995, true), ...rep(100, 0.96, true)];
    const r = sweepThresholds(items, { action: "a", target: 0.9, taus: [0.99, 0.95] });
    expect(r.points.map((p) => p.tested)).toEqual([false, true]);
    expect(r.tau).toBe(0.95);
  });

  it("zero-failure bound for irreversible actions", () => {
    // 99% needs 299 zero-error rows (0.99^299 ≤ 0.05); lb = 0.05^(1/300) = 0.99006
    const taus = [0.999, 0.99];
    const ok = sweepThresholds(rep(300, 0.999, true), {
      action: "archive",
      zeroFailure: true,
      taus,
    });
    expect(ok.mode).toBe("zero_failure");
    // both τ cover the same 300 rows and pass, so the looser one is kept
    expect(ok.tau).toBe(0.99);
    expect(ok.lowerBound).toBeCloseTo(0.05 ** (1 / 300), 12);
    expect(ok.delta).toBe(0.05);
    const bad = sweepThresholds([...rep(300, 0.999, true), { p: 0.999, correct: false }], {
      action: "archive",
      zeroFailure: true,
    });
    expect(bad.status).toBe("human_only");
    const few = sweepThresholds(rep(298, 0.999, true), {
      action: "archive",
      zeroFailure: true,
    });
    expect(few.tau).toBeNull();
  });
});
