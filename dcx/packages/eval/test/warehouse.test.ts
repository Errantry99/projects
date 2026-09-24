import { openWarehouse, type WarehouseHandle } from "@dcx/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  armRecords,
  buildH4Report,
  calibrationPairs,
  judgeRequests,
  queryLedger,
  renderLedgerText,
  truthLabels,
  type WarehouseReader,
} from "../src/index.js";

let h: WarehouseHandle;
let wh: WarehouseReader;

const Q1 = "a".repeat(64);
const Q2 = "b".repeat(64);
const JC1 = "00000000-0000-4000-8000-000000000001";
const JC2 = "00000000-0000-4000-8000-000000000002";

beforeAll(async () => {
  h = await openWarehouse(":memory:");
  type Params = Parameters<typeof h.conn.runAndReadAll>[1];
  wh = {
    async all<T>(sql: string, params: readonly unknown[] = []) {
      const r = await h.conn.runAndReadAll(sql, params as Params);
      return r.getRowObjectsJson() as T[];
    },
  } as WarehouseReader;
  const sql = `
  -- two judge requests (one per record, both questions share the projection)
  INSERT INTO judge_calls (call_id, backend, model_v, n_questions, cost_usd, cost_basis, latency_ms, status)
  VALUES ('${JC1}', 'fixture', 'jev-1.13.0', 2, 0.0001, 'zero', 400, 'ok'),
         ('${JC2}', 'fixture', 'jev-1.13.0', 2, 0.0001, 'zero', 400, 'ok');
  INSERT INTO judgments (payload_hash, question_hash, backend, model_v, qtype, question_id, question_v, answer, p_answer, probs, call_id)
  VALUES ('pA', '${Q1}', 'fixture', 'jev-1.13.0', 'noul', 'screen.on_topic', 1, 'true', 0.9, MAP {'true': 0.9, 'false': 0.1}, '${JC1}'),
         ('pA', '${Q2}', 'fixture', 'jev-1.13.0', 'choice', 'screen.crit_1', 1, 'fails', 0.8, MAP {'fails': 0.8, 'meets': 0.2}, '${JC1}'),
         ('pB', '${Q1}', 'fixture', 'jev-1.13.0', 'noul', 'screen.on_topic', 1, 'false', 0.2, MAP {'true': 0.2, 'false': 0.8}, '${JC2}'),
         ('pB', '${Q2}', 'fixture', 'jev-1.13.0', 'choice', 'screen.crit_1', 1, 'meets', 0.6, MAP {'meets': 0.6, 'fails': 0.4}, '${JC2}');
  -- compiled runs c1 (rA), c2 (rB) make the calls; re-runs d1, d2 hit the cache
  INSERT INTO judge_uses (run_id, step_no, record_id, question_hash, payload_hash, backend, model_v, mode, cache_hit) VALUES
    ('c1', 1, 'rA', '${Q1}', 'pA', 'fixture', 'jev-1.13.0', 'active', false),
    ('c1', 1, 'rA', '${Q2}', 'pA', 'fixture', 'jev-1.13.0', 'active', false),
    ('c2', 1, 'rB', '${Q1}', 'pB', 'fixture', 'jev-1.13.0', 'active', false),
    ('c2', 1, 'rB', '${Q2}', 'pB', 'fixture', 'jev-1.13.0', 'active', false),
    ('d1', 1, 'rA', '${Q1}', 'pA', 'fixture', 'jev-1.13.0', 'active', true),
    ('d1', 1, 'rA', '${Q2}', 'pA', 'fixture', 'jev-1.13.0', 'active', true),
    ('d2', 1, 'rB', '${Q1}', 'pB', 'fixture', 'jev-1.13.0', 'active', true),
    ('d2', 1, 'rB', '${Q2}', 'pB', 'fixture', 'jev-1.13.0', 'active', true);
  INSERT INTO routes (run_id, step_no, record_id, decision_point_id, branch_taken, reason_code, mode) VALUES
    ('c1', 2, 'rA', 'dp', 'exclude', 'above_threshold', 'active'),
    ('c2', 2, 'rB', 'dp', 'include', 'abstain_band', 'active');
  INSERT INTO llm_calls (call_id, run_id, step_no, workflow, record_ids, branch_taken, cost_usd, latency_ms) VALUES
    ('b1c', 'b1', 1, 'screen-baseline', ['rA'], 'exclude', 0.005, 3000),
    ('b2c', 'b2', 1, 'screen-baseline', ['rB'], 'include', 0.005, 2000),
    ('c2c', 'c2', 3, 'screen-compiled', ['rB'], 'include', 0.005, 2500);
  INSERT INTO labels (record_id, target_kind, target_ref, label, source, split, selected_by) VALUES
    ('rA', 'route', 'screen.decision', 'exclude', 'human', 'holdout', 'exhaustive'),
    ('rB', 'route', 'screen.decision', 'include', 'human', 'holdout', 'exhaustive'),
    ('rA', 'question', '${Q1}', 'true', 'human', 'holdout', 'exhaustive'),
    ('rB', 'question', '${Q1}', 'true', 'human', 'holdout', 'exhaustive'),
    ('rA', 'question', 'screen.crit_1@1', 'fails', 'human', 'holdout', 'exhaustive'),
    ('rB', 'question', 'screen.crit_1@1', 'fails', 'human', 'holdout', 'exhaustive');
  -- an active isotonic calibrator for Q1 that halves p
  INSERT INTO calibrators (calibrator_id, question_hash, backend, model_v, method, params, status)
  VALUES ('cal1', '${Q1}', 'fixture', 'jev-1.13.0', 'isotonic', '{"knots": [[0, 0], [1, 0.5]]}', 'active');`;
  await h.conn.run(sql);
});
afterAll(() => h.close());

describe("warehouse loaders", () => {
  it("builds per-record arms from llm_calls, judge_uses and routes", async () => {
    const comp = await armRecords(wh, ["c1", "c2"]);
    expect(comp).toEqual([
      {
        recordId: "rA",
        decision: "exclude",
        decidedBy: "judge",
        llmCalls: 0,
        costUsd: 0.0001,
        judgeCostUsd: 0.0001,
        latencyMs: 400,
      },
      {
        recordId: "rB",
        decision: "include",
        decidedBy: "llm",
        llmCalls: 1,
        llmReason: "abstain",
        costUsd: expect.closeTo(0.0051, 12),
        judgeCostUsd: 0.0001,
        latencyMs: 2900,
      },
    ]);
    const base = await armRecords(wh, ["b1", "b2"]);
    expect(base.map((r) => [r.recordId, r.decision, r.decidedBy, r.costUsd])).toEqual([
      ["rA", "exclude", "llm", 0.005],
      ["rB", "include", "llm", 0.005],
    ]);
    expect(await judgeRequests(wh, ["c1", "c2"])).toBe(2);
    expect(await judgeRequests(wh, ["d1", "d2"])).toBe(0);

    const truth = await truthLabels(wh, { targetRef: "screen.decision", split: "holdout" });
    expect(truth).toEqual({ rA: "exclude", rB: "include" });
    const r = buildH4Report({
      dataset: "fixture",
      split: "holdout",
      truth,
      baseline: { name: "all-LLM baseline", records: base },
      compiled: { name: "compiled", records: comp, judgeRequests: { firstRun: 2, reRun: 0 } },
    });
    expect(r.compiled.coverage).toBe(0.5);
    expect(r.compiled.recall.value).toBe(1);
    expect(r.saving).toBeCloseTo(1 - 0.0052 / 0.01, 12);
  });

  it("reads calibration pairs through the decisions view", async () => {
    // Q1 is Noul with an active calibrator halving P(true): 0.9 → 0.45, 0.2 → 0.1
    const noul = await calibrationPairs(wh, { questionHash: Q1, split: "holdout" });
    expect(noul.p.map((x) => Number(x.toFixed(9)))).toEqual([0.45, 0.1]);
    expect(noul.pRaw).toEqual([0.9, 0.2]);
    expect(noul.y).toEqual([true, true]);
    // Q2 is Choice, labels by id@v, no calibrator: p = P(answer), correct = answer matches
    const choice = await calibrationPairs(wh, { questionHash: Q2 });
    expect(choice.p).toEqual([0.8, 0.6]);
    expect(choice.y).toEqual([true, false]);
  });

  it("queries the savings ledger per run", async () => {
    const l = await queryLedger(wh, { runIds: ["c1", "c2"], baselineRunIds: ["b1", "b2"] });
    expect(l.baselineCostPerRecord).toBeCloseTo(0.005, 12);
    expect(l.rows.map((r) => [r.run_id, r.records, r.llm_calls])).toEqual([
      ["c1", 1, 0],
      ["c2", 1, 1],
    ]);
    expect(l.rows[0]?.compiled_cost_usd).toBeCloseTo(0.0001, 12);
    expect(l.rows[0]?.saving_pct).toBeCloseTo(0.98, 12);
    expect(l.total.saving_pct).toBeCloseTo(1 - 0.0052 / 0.01, 12);
    expect(renderLedgerText(l).split("\n")).toEqual([
      "run    records  baseline  compiled  saving    saving %",
      "c1     1        $0.0050   $0.0001   $0.0049   98%",
      "c2     1        $0.0050   $0.0051   -$0.0001  -2%",
      "total  2        $0.0100   $0.0052   $0.0048   48%",
    ]);
  });
});
