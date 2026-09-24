import { calibrate } from "@dcx/core";
import { describe, expect, it } from "vitest";
import {
  applyCalibration,
  type CalPair,
  ece,
  eceNoiseFloor,
  fitCalibrator,
  fitIsotonic,
  fitPlatt,
  fitTemperature,
  recommendMethod,
  rng,
  writeCalibrators,
} from "../src/calibrate.js";
import { memoryWarehouse } from "./helpers/warehouse.js";

const H = "a".repeat(64);
const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** Jev-like data: 56% of answers at exactly 1.0 (2% wrong), the rest spread and overconfident. */
function jevLike(n: number, seed = 1): CalPair[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => {
    if (r() < 0.56) return { p: 1, y: r() < 0.98 ? 1 : 0 };
    const p = 0.5 + 0.49 * r();
    return { p, y: r() < p - 0.2 ? 1 : 0 };
  });
}

/** A miscalibrated logit backend: true p = sigmoid(z), reported p = sigmoid(z * 2.5). */
function overconfident(n: number, seed = 2): CalPair[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => {
    const z = (r() - 0.5) * 6;
    return { p: sigmoid(2.5 * z), y: r() < sigmoid(z) ? 1 : 0 };
  });
}

describe("isotonic (PAV)", () => {
  it("pools the mass at p = 1.0 into one block and is monotone", () => {
    const pairs = jevLike(2000);
    const { knots } = fitIsotonic(pairs);
    for (let i = 1; i < knots.length; i++) {
      expect((knots[i] as number[])[0]).toBeGreaterThanOrEqual(
        (knots[i - 1] as number[])[0] as number,
      );
      expect((knots[i] as number[])[1]).toBeGreaterThanOrEqual(
        (knots[i - 1] as number[])[1] as number,
      );
    }
    const at1 = pairs.filter((x) => x.p === 1);
    const acc1 = at1.reduce((s, x) => s + x.y, 0) / at1.length;
    expect(calibrate("isotonic", { knots }, 1)).toBeCloseTo(acc1, 3);
    expect(calibrate("isotonic", { knots }, 1)).toBeLessThan(1);
  });

  it("handles all-tied and empty inputs", () => {
    expect(fitIsotonic([])).toEqual({ knots: [] });
    const { knots } = fitIsotonic([
      { p: 1, y: 1 },
      { p: 1, y: 0 },
      { p: 1, y: 1 },
      { p: 1, y: 1 },
    ]);
    expect(knots).toEqual([[1, 0.75]]);
    expect(calibrate("isotonic", { knots }, 0.3)).toBe(0.75);
  });

  it("serialises params the DuckDB calibrate() macro reads identically", async () => {
    const pairs = jevLike(500, 3);
    const t = fitTemperature(overconfident(500));
    const pl = fitPlatt(overconfident(500, 4));
    const iso = fitIsotonic(pairs);
    const wh = await memoryWarehouse();
    for (const [method, params] of [
      ["isotonic", iso],
      ["temperature", t],
      ["platt", pl],
    ] as const) {
      for (const p of [0, 0.13, 0.5, 0.77, 0.999, 1]) {
        const [row] = await wh.all<{ v: number }>(
          "SELECT calibrate($1, CAST($2 AS JSON), $3::DOUBLE)::DOUBLE AS v",
          [method, JSON.stringify(params), p],
        );
        expect(row?.v).toBeCloseTo(calibrate(method, params, p) as number, 9);
      }
    }
    await wh.close();
  });
});

describe("temperature and Platt", () => {
  it("temperature recovers an overconfident backend", () => {
    const { T } = fitTemperature(overconfident(4000));
    expect(T).toBeGreaterThan(2.1);
    expect(T).toBeLessThan(2.9);
  });

  it("multiclass temperature never changes the argmax", () => {
    const pairs: CalPair[] = Array.from({ length: 200 }, (_, i) => ({
      p: 0.9,
      y: (i % 3 === 0 ? 0 : 1) as 0 | 1,
      probs: { a: 0.9, b: 0.07, c: 0.03 },
      answer: "a",
    }));
    const { T } = fitTemperature(pairs);
    const pa = applyCalibration("temperature", { T }, pairs[0] as CalPair);
    const pb = applyCalibration(
      "temperature",
      { T },
      { ...(pairs[0] as CalPair), answer: "b", p: 0.07 },
    );
    expect(pa).toBeGreaterThan(pb);
    expect(pa).toBeCloseTo(2 / 3, 1);
  });

  it("Platt recovers a known sigmoid(a·logit + b)", () => {
    const r = rng(9);
    const pairs: CalPair[] = Array.from({ length: 5000 }, () => {
      const p = 0.02 + 0.96 * r();
      return { p, y: r() < sigmoid(0.5 * logit(p) - 0.4) ? 1 : 0 };
    });
    const { a, b } = fitPlatt(pairs);
    expect(a).toBeCloseTo(0.5, 1);
    expect(b).toBeCloseTo(-0.4, 1);
  });

  it("Platt stays finite and optimal with mass at p = 1.0 (Jev-shaped data)", () => {
    const ps = [0.1, 0.2, 0.2, 0.5, 0.9, 1, 1, 1, 1, 0.3, 0.7];
    const pairs: CalPair[] = ps.map((p, i) => ({ p, y: (i % 3 === 0 ? 1 : 0) as 0 | 1 }));
    const { a, b } = fitPlatt(pairs);
    expect(Math.abs(a)).toBeLessThan(10);
    expect(Math.abs(b)).toBeLessThan(10);
    const nPos = pairs.filter((x) => x.y).length;
    const tp = (nPos + 1) / (nPos + 2);
    const tn = 1 / (pairs.length - nPos + 2);
    const loss = (x: number, y: number) =>
      pairs.reduce((s, q) => {
        const zq = logit(Math.min(1 - 1e-6, Math.max(1e-6, q.p))); // the fit's clamped logit
        const pr = Math.min(1 - 1e-15, Math.max(1e-15, sigmoid(x * zq + y)));
        const t = q.y ? tp : tn;
        return s - t * Math.log(pr) - (1 - t) * Math.log(1 - pr);
      }, 0);
    let best = Number.POSITIVE_INFINITY;
    for (let x = -3; x <= 3; x += 0.05)
      for (let y = -3; y <= 3; y += 0.05) best = Math.min(best, loss(x, y));
    expect(loss(a, b)).toBeLessThanOrEqual(best + 1e-9);
  });
});

describe("ECE, noise floor and calibrator rows", () => {
  it("noise floor at n = 200 is a few points and shrinks with n", () => {
    const r = rng(11);
    const ps = Array.from({ length: 200 }, () => r());
    const floor = eceNoiseFloor(ps, { bins: 5, sims: 400 });
    expect(floor).toBeGreaterThan(0.02);
    expect(floor).toBeLessThan(0.07);
    const big = Array.from({ length: 5000 }, () => r());
    expect(eceNoiseFloor(big, { bins: 5, sims: 100 })).toBeLessThan(floor / 3);
    // Jev-like mass at 1.0 lowers the floor.
    expect(
      eceNoiseFloor(
        ps.map((p, i) => (i % 2 ? 1 : p)),
        { bins: 5, sims: 400 },
      ),
    ).toBeLessThan(floor);
    expect(ece([1, 1, 0, 0], [1, 1, 0, 0])).toBe(0);
  });

  it("corrects a miscalibrated backend to ≤ 2× the floor on held-out data", () => {
    const fit = overconfident(3000, 5);
    const hold = overconfident(1000, 6);
    const raw = ece(
      hold.map((x) => x.p),
      hold.map((x) => x.y),
    );
    const row = fitCalibrator(fit, {
      questionHash: H,
      backend: "kev",
      modelV: "kev-4b",
      method: "temperature",
      evalPairs: hold,
    });
    expect(raw).toBeGreaterThan(2 * (row.ece_floor as number));
    expect(row.ece as number).toBeLessThanOrEqual(2 * (row.ece_floor as number));
    expect(row).toMatchObject({
      method: "temperature",
      n_fit: 3000,
      status: "candidate",
      candidate_spec: "",
    });
  });

  it("recommends isotonic for Jev, Platt for Noul, temperature otherwise", () => {
    expect(recommendMethod("jev", "choice", 200)).toBe("isotonic");
    expect(recommendMethod("kev", "noul", 200)).toBe("platt");
    expect(recommendMethod("kev", "choice", 200)).toBe("temperature");
  });

  it("writes rows with a single active calibrator per key", async () => {
    const wh = await memoryWarehouse();
    const a = fitCalibrator(jevLike(300), {
      questionHash: H,
      backend: "jev",
      modelV: "jev-1.13.0",
      method: "isotonic",
    });
    const b = fitCalibrator(jevLike(300, 8), {
      questionHash: H,
      backend: "jev",
      modelV: "jev-1.13.0",
      method: "isotonic",
    });
    await writeCalibrators(wh, [a], { activate: true });
    await writeCalibrators(wh, [b], { activate: true });
    const rows = await wh.all<{ calibrator_id: string; status: string }>(
      "SELECT calibrator_id, status FROM calibrators ORDER BY status",
    );
    expect(rows).toEqual([
      { calibrator_id: b.calibrator_id, status: "active" },
      { calibrator_id: a.calibrator_id, status: "stale" },
    ]);
    await wh.close();
  });
});
