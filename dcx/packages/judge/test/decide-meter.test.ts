import type { CalibratorRow, PriceRow, RawAnswer, RawDecision, ThresholdRow } from "@dcx/core";
import { describe, expect, it } from "vitest";
import {
  ACTION_ESCALATE,
  ACTION_HUMAN,
  ACTION_NONE,
  decide,
  loadDecisionPolicy,
} from "../src/decide.js";
import { BudgetExceededError } from "../src/errors.js";
import { Budget, callCost, loadPrices, priceFor, sumUsage } from "../src/meter.js";
import { memoryWarehouse } from "./helpers/warehouse.js";

const Q = "b".repeat(64);
const KEY = { questionHash: Q, backend: "jev", modelVersion: "jev-1.13.0" };
const choice = (answer: string, p: number): RawAnswer => ({
  questionHash: Q,
  qtype: "choice",
  answer,
  probs: { [answer]: p, other: 1 - p },
  pAnswer: p,
});
const cal: CalibratorRow = {
  calibrator_id: "cal1",
  question_hash: Q,
  backend: "jev",
  model_v: "jev-1.13.0",
  method: "isotonic",
  params: {
    knots: [
      [0, 0],
      [1, 0.9],
    ],
  },
  status: "active",
};
const th = (over: Partial<ThresholdRow> = {}): ThresholdRow => ({
  threshold_id: "t1",
  policy_id: "p",
  question_hash: Q,
  backend: "jev",
  model_v: "jev-1.13.0",
  calibrator_id: "cal1",
  action: "exclude",
  rule: { label: "fails", min_p: 0.85, on_error: "human" },
  floor: 0.5,
  status: "active",
  ...over,
});

describe("decide", () => {
  it("a rule stored without a label applies to every answer, as the SQL view reads it", () => {
    const rule = { min_p: 0.85, on_error: "human" } as unknown as ThresholdRow["rule"];
    expect(decide({ ...KEY, answer: choice("meets", 1) }, cal, th({ rule }))).toMatchObject({
      action: "exclude",
      reason: "above_threshold",
    });
  });

  it("calibrates then applies threshold, abstain band and floor", () => {
    const hi = decide({ ...KEY, answer: choice("fails", 1) }, cal, th());
    expect(hi).toMatchObject({
      action: "exclude",
      reason: "above_threshold",
      thresholdId: "t1",
      calibratorId: "cal1",
      degraded: false,
    });
    expect(hi.pCal).toBeCloseTo(0.9);
    expect(hi.pRaw).toBe(1);
    expect(decide({ ...KEY, answer: choice("fails", 0.8) }, cal, th())).toMatchObject({
      action: ACTION_ESCALATE,
      reason: "abstain_band",
    });
    expect(decide({ ...KEY, answer: choice("fails", 0.3) }, cal, th())).toMatchObject({
      action: ACTION_HUMAN,
      reason: "below_floor",
    });
    const band = th({
      rule: { label: "fails", min_p: 0.85, abstain_band: [0.2, 0.85], on_error: "human" },
    });
    expect(decide({ ...KEY, answer: choice("fails", 0.3) }, cal, band).reason).toBe(
      "abstain_band",
    );
  });

  it("routes other answers, missing thresholds and drift to human", () => {
    expect(decide({ ...KEY, answer: choice("meets", 1) }, cal, th())).toMatchObject({
      action: ACTION_HUMAN,
      reason: "no_threshold",
    });
    expect(decide({ ...KEY, answer: choice("fails", 1) }, cal, null).reason).toBe(
      "no_threshold",
    );
    expect(
      decide({ ...KEY, answer: choice("fails", 1) }, cal, th({ calibrator_id: "other" }))
        .reason,
    ).toBe("no_threshold");
    expect(
      decide(
        { ...KEY, answer: choice("fails", 1) },
        cal,
        th({ valid_to: "2020-01-01T00:00:00Z" }),
      ).reason,
    ).toBe("no_threshold");
    expect(
      decide({ ...KEY, degraded: true, answer: choice("fails", 1) }, cal, th()),
    ).toMatchObject({ action: ACTION_HUMAN, reason: "model_drift", degraded: true });
  });

  it("applies on_error, defaulting to human", () => {
    expect(decide({ ...KEY, answer: null }, cal, null)).toMatchObject({
      action: ACTION_HUMAN,
      reason: "judge_error",
      pCal: 0,
    });
    const closed = th({ rule: { label: "fails", min_p: 0.85, on_error: "fail_closed" } });
    const open = th({ rule: { label: "fails", min_p: 0.85, on_error: "fail_open" } });
    expect(decide({ ...KEY, answer: null }, cal, closed).action).toBe(ACTION_NONE);
    expect(decide({ ...KEY, answer: null }, cal, open).action).toBe(ACTION_ESCALATE);
  });

  it("uses the max side for Noul and ignores a calibrator for another model", () => {
    const noul: RawAnswer = {
      questionHash: Q,
      qtype: "noul",
      answer: "false",
      probs: { true: 0.1, false: 0.9 },
      pAnswer: 0.1,
    };
    const d = decide(
      { ...KEY, answer: noul },
      null,
      th({ calibrator_id: null, rule: { label: "false", min_p: 0.85, on_error: "human" } }),
    );
    expect(d.pCal).toBeCloseTo(0.9);
    expect(d.action).toBe("exclude");
    const wrong = decide(
      { ...KEY, modelVersion: "jev-1.14.0", answer: choice("fails", 1) },
      cal,
      null,
    );
    expect(wrong).toMatchObject({ calibratorId: null, degraded: true, pCal: 1 });
  });

  it("loads the active policy rows from the warehouse", async () => {
    const wh = await memoryWarehouse();
    await wh.appendRows("calibrators", [cal as never]);
    await wh.appendRows("thresholds", [
      { ...th(), valid_from: "2026-01-01T00:00:00Z" } as never,
    ]);
    const pol = await loadDecisionPolicy(wh, {
      questionHash: Q,
      backend: "jev",
      modelV: "jev-1.13.0",
    });
    expect(pol.calibrator?.params).toEqual(cal.params);
    expect(pol.thresholds[0]?.rule.min_p).toBe(0.85);
    expect(
      decide({ ...KEY, answer: choice("fails", 1) }, pol.calibrator, pol.thresholds).action,
    ).toBe("exclude");
    await wh.close();
  });
});

describe("meter", () => {
  const prices: PriceRow[] = [
    {
      backend: "jev",
      model: "jev-1.13.0",
      input_per_m: 0.05,
      output_per_m: 0,
      effective_from: "2026-01-01T00:00:00Z",
    },
    {
      backend: "jev",
      model: "jev-1.13.0",
      input_per_m: 0.042,
      output_per_m: 0,
      effective_from: "2026-06-01T00:00:00Z",
    },
  ];
  const raw = (over: Partial<RawDecision> = {}): RawDecision => ({
    backend: "jev",
    modelVersion: "jev-1.13.0",
    answers: [],
    usage: { inputTokens: 1_000_000, basis: "token-price" },
    latencyMs: 1,
    retries: 0,
    cacheHit: false,
    ...over,
  });

  it("prices by effective date and strips a settings digest", () => {
    expect(priceFor(prices, "jev", "jev-1.13.0", new Date("2026-03-01"))?.input_per_m).toBe(
      0.05,
    );
    expect(
      priceFor(prices, "jev", "jev-1.13.0+abcdef012345", new Date("2026-09-01"))?.input_per_m,
    ).toBe(0.042);
    expect(priceFor(prices, "jev", "jev-1.13.0", new Date("2025-01-01"))).toBeNull();
  });

  it("sums cost across retries and zeroes cache hits", () => {
    const attempts = sumUsage([
      { inputTokens: 400 },
      { inputTokens: 400 },
      { inputTokens: 400, outputTokens: 2 },
    ]);
    expect(attempts).toEqual({ inputTokens: 1200, outputTokens: 2 });
    expect(
      callCost(raw({ usage: { ...attempts, basis: "token-price" } }), prices).costUsd,
    ).toBeCloseTo((1200 * 0.042) / 1e6, 12);
    expect(callCost(raw({ cacheHit: true }), prices)).toEqual({ costUsd: 0, basis: "zero" });
    expect(
      callCost(raw({ usage: { costUsd: 0.01, basis: "provider-reported" } }), prices),
    ).toEqual({ costUsd: 0.01, basis: "provider-reported" });
  });

  it("refuses a call over the budget cap", () => {
    const b = new Budget(0.1);
    const r1 = b.preflight(0.06);
    expect(() => b.preflight(0.06)).toThrow(BudgetExceededError);
    b.commit(r1, 0.02);
    expect(b.spentUsd).toBeCloseTo(0.02);
    expect(() => b.preflight(0.06)).not.toThrow();
  });

  it("reads prices from the warehouse", async () => {
    const wh = await memoryWarehouse();
    await wh.appendRows("prices", prices as never);
    const back = await loadPrices(wh);
    expect(back).toHaveLength(2);
    expect(priceFor(back, "jev", "jev-1.13.0")?.input_per_m).toBe(0.042);
    await wh.close();
  });
});
