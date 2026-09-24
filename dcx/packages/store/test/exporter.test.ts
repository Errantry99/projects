import type { OutboxEntry } from "@dcx/core";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DuckWarehouse,
  drainOutbox,
  OUTBOX_LEDGER_TABLE,
  openDuckWarehouse,
  openSqliteJournal,
  outboxUuid,
  type SqliteJournal,
} from "../src/index.js";
import { run, step, tempDir } from "./helpers.js";

const tmp = tempDir("dcx-export-");
afterAll(() => tmp.rm());

let j: SqliteJournal;
let wh: DuckWarehouse;
let n = 0;
beforeEach(async () => {
  j = openSqliteJournal(tmp.path(`j${++n}.sqlite`));
  wh = await openDuckWarehouse(":memory:");
});
afterEach(async () => {
  await j.close();
  await wh.close();
});

const H = "a".repeat(64);
const stepRows = (stepNo: number): OutboxEntry[] => [
  {
    target_table: "trace_steps",
    row: {
      run_id: "r1",
      step_no: stepNo,
      kind: "judge",
      name: `s${stepNo}`,
      status: "completed",
      mode: "active",
      started_at: 1,
      ended_at: 2,
      activity: "judge:screen",
      source: "kernel",
    },
  },
  {
    target_table: "judge_uses",
    row: {
      run_id: "r1",
      step_no: stepNo,
      question_hash: H,
      payload_hash: H,
      candidate_set_hash: "",
      backend: "fixture",
      model_v: "fixture-1",
      mode: "active",
      cache_hit: false,
    },
  },
  {
    target_table: "routes",
    row: {
      run_id: "r1",
      step_no: stepNo,
      decision_point_id: "dp1",
      tiers: [{ tier: 1, kind: "judge", answer: "include", p: 0.93, costUsd: 0 }],
      branch_taken: "include",
      reason_code: "above_threshold",
      mode: "active",
    },
  },
  { target_table: "llm_calls", row: { call_id: `c${stepNo}`, run_id: "r1", step_no: stepNo } },
];

async function counts() {
  const out: Record<string, number> = {};
  for (const t of [
    "trace_steps",
    "judge_uses",
    "routes",
    "llm_calls",
    "labels",
    "promotions",
  ]) {
    const [r] = await wh.all<{ n: number }>(`SELECT count(*) AS n FROM ${t}`);
    out[t] = r?.n ?? -1;
  }
  return out;
}

describe("drainOutbox", () => {
  it("moves step rows written with completeStep into their tables, in batches", async () => {
    await j.startRun(run("r1"));
    for (let s = 1; s <= 5; s++) {
      await j.putStep(step("r1", s));
      await j.completeStep("r1", s, { status: "completed", output: s }, stepRows(s));
    }
    const res = await drainOutbox(j, wh, { batchSize: 7, now: () => 99 });
    expect(res).toMatchObject({ exported: 20, inserted: 20, alreadyApplied: 0, batches: 3 });
    expect(res.byTable).toEqual({ trace_steps: 5, judge_uses: 5, routes: 5, llm_calls: 5 });
    expect(await counts()).toMatchObject({
      trace_steps: 5,
      judge_uses: 5,
      routes: 5,
      llm_calls: 5,
    });
    expect(await j.pendingOutbox(100)).toEqual([]);
    const [r] = await wh.all<{ tiers: unknown }>("SELECT tiers FROM routes WHERE step_no = 1");
    expect(r?.tiers).toEqual([
      { tier: 1, kind: "judge", answer: "include", p: 0.93, costUsd: 0 },
    ]);
  });

  it("is idempotent: a crash before markExported re-drains without duplicates", async () => {
    await j.enqueueOutbox([
      ...stepRows(1),
      {
        target_table: "labels",
        row: {
          record_id: "x",
          target_kind: "question",
          target_ref: "q",
          label: "include",
          source: "human",
        },
      },
      // promotions has no primary key: only the seq ledger prevents a duplicate.
      {
        target_table: "promotions",
        row: {
          proposal_id: "p1",
          from_status: "shadow",
          to_status: "canary",
          decision: "approve",
        },
      },
    ]);
    const first = await drainOutbox(j, wh);
    expect(first.inserted).toBe(6);
    const before = await counts();
    // Simulate the crash window: DuckDB committed, the journal never recorded the export.
    j.db.prepare("UPDATE outbox SET exported_at = NULL").run();
    const second = await drainOutbox(j, wh);
    expect(second).toMatchObject({ exported: 6, inserted: 0, alreadyApplied: 6 });
    expect(await counts()).toEqual(before);
    expect(before).toMatchObject({ labels: 1, promotions: 1 });
    // A third run with nothing pending is a no-op.
    expect(await drainOutbox(j, wh)).toMatchObject({ exported: 0, batches: 0 });
    const [l] = await wh.all<{ n: number }>(`SELECT count(*) AS n FROM ${OUTBOX_LEDGER_TABLE}`);
    expect(l?.n).toBe(6);
  });

  it("natural keys also dedupe a row enqueued twice", async () => {
    await j.enqueueOutbox(stepRows(1));
    await j.enqueueOutbox(stepRows(1));
    const res = await drainOutbox(j, wh);
    expect(res).toMatchObject({ exported: 8, inserted: 4 });
    expect(await counts()).toMatchObject({
      trace_steps: 1,
      judge_uses: 1,
      routes: 1,
      llm_calls: 1,
    });
  });

  it("a bad row fails the batch atomically and leaves it pending", async () => {
    await j.enqueueOutbox([
      ...stepRows(1),
      { target_table: "routes", row: { run_id: "r1", step_no: 2, mode: "bogus" } },
    ]);
    await expect(drainOutbox(j, wh)).rejects.toThrow(
      /drainOutbox: routes rows .*Constraint Error/,
    );
    expect(await counts()).toMatchObject({ trace_steps: 0, judge_uses: 0, llm_calls: 0 });
    expect(await j.pendingOutbox(100)).toHaveLength(5);
  });

  it("derives a stable uuid from the seq when a label arrives without an id", () => {
    expect(outboxUuid(7)).toBe(outboxUuid(7));
    expect(outboxUuid(7)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
