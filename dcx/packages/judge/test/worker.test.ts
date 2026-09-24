import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend, Warehouse } from "@dcx/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureBackend } from "../src/backends/fixture.js";
import { fitCalibrator, loadCalibrationPairs } from "../src/calibrate.js";
import { RateLimitedError } from "../src/errors.js";
import { parseQuestion, readQuestions, writeQuestions } from "../src/registry.js";
import { askLive, drain } from "../src/worker.js";
import { crit1, onTopic, oracleBackend, QUESTIONS, records } from "./helpers/fakes.js";
import { memoryWarehouse } from "./helpers/warehouse.js";

const dir = mkdtempSync(join(tmpdir(), "dcx-judge-worker-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const PIN = "jev-1.13.0";
const N = 10; // 10 records, 5 distinct payloads per field set

async function seeded(): Promise<Warehouse> {
  const wh = await memoryWarehouse();
  await wh.appendRows("records", records(N) as never);
  await writeQuestions(wh, QUESTIONS);
  return wh;
}
const count = async (wh: Warehouse, sql: string) =>
  Number((await wh.all<{ n: number }>(`SELECT (${sql})::INTEGER AS n`))[0]?.n);
const clock = () => {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
};

describe("drain", () => {
  beforeAll(async () => {
    // Record fixtures once from the deterministic oracle.
    const wh = await seeded();
    const rec = fixtureBackend({ dir, mode: "record", inner: oracleBackend() });
    const s = await drain(wh, rec, { pin: PIN, rpm: Number.POSITIVE_INFINITY });
    expect(s.requests).toBe(N);
    await wh.close();
  });

  it("asks each payload once with all its questions, then a second drain makes zero requests", async () => {
    const wh = await seeded();
    const be = fixtureBackend({ dir });
    const first = await drain(wh, be, { pin: PIN, ...clock() });
    expect(first.groups).toBe(N); // 5 title+abstract payloads (2 questions) + 5 abstract payloads (1)
    expect(first.requests).toBe(N);
    expect(first.judgments).toBe(15);
    expect(first.projections).toBe(2 * N);
    expect(first.errors).toEqual([]);
    expect(
      await count(
        wh,
        "SELECT count(*) FROM judge_calls WHERE model_v = 'jev-1.13.0' AND model_req = 'jev-1.13.0'",
      ),
    ).toBe(N);
    expect(await count(wh, "SELECT max(n_questions) FROM judge_calls")).toBe(2);
    const second = await drain(wh, be, { pin: PIN, ...clock() });
    expect(second).toMatchObject({ groups: 0, requests: 0, judgments: 0, projections: 0 });
    // A new record whose payload is already cached costs nothing either.
    const [extra] = records(N + 2).slice(N, N + 1);
    await wh.appendRows("records", [{ ...extra, record_id: "dup" } as never]);
    expect((await drain(wh, be, { pin: PIN })).requests).toBe(0);
    await wh.close();
  });

  it("joins judgments to training_labels only (H5) for calibration pairs", async () => {
    const wh = await seeded();
    await drain(wh, fixtureBackend({ dir }), { pin: PIN, ...clock() });
    const label = (record_id: string, label: string, source: string) => ({
      record_id,
      target_kind: "question",
      target_ref: `${crit1.id}@${crit1.version}`,
      label,
      source,
      selected_by: "exhaustive",
    });
    await wh.appendRows("labels", [
      label("r0", "meets", "human"),
      label("r1", "fails", "human"),
    ] as never);
    await expect(
      wh.appendRows("labels", [label("r2", "meets", "llm:jev-1.13.0")] as never),
    ).rejects.toThrow();
    const pairs = await loadCalibrationPairs(wh, {
      questionHash: crit1.questionHash,
      backend: "fixture",
      modelV: PIN,
    });
    expect(pairs).toHaveLength(2);
    const row = fitCalibrator(pairs, {
      questionHash: crit1.questionHash,
      backend: "fixture",
      modelV: PIN,
      method: "isotonic",
    });
    expect(row.n_fit).toBe(2);
    await wh.close();
  });

  it("flags model drift, marks the call degraded, demotes the question and stops", async () => {
    const wh = await seeded();
    const s = await drain(wh, oracleBackend({ returns: "jev-1.14.0" }), {
      pin: PIN,
      concurrency: 1,
      ...clock(),
    });
    expect(s.requests).toBe(1);
    expect(s.drift[0]).toMatchObject({ pin: PIN, returned: "jev-1.14.0" });
    // The drain stops; the asks it did not send are reported, not dropped silently (15 asks).
    expect(s.skipped).toBe(15 - (s.drift[0]?.questionHashes.length ?? 0));
    expect(
      await count(
        wh,
        "SELECT count(*) FROM judge_calls WHERE degraded AND model_v = 'jev-1.14.0'",
      ),
    ).toBe(1);
    const demoted = await readQuestions(wh, ["demoted"]);
    expect(demoted.map((d) => d.questionHash).sort()).toEqual(
      [...(s.drift[0]?.questionHashes ?? [])].sort(),
    );
    await wh.close();
  });

  it("refuses over budget without truncating, and refuses oversized states", async () => {
    const wh = await seeded();
    await wh.appendRows("prices", [
      {
        backend: "oracle",
        model: PIN,
        input_per_m: 1000,
        output_per_m: 0,
        effective_from: "2026-01-01T00:00:00Z",
      },
    ] as never);
    const oracle = oracleBackend();
    const s = await drain(wh, oracle, { pin: PIN, budgetUsd: 1.5, concurrency: 1, ...clock() });
    // Each call bills 400 tokens ($0.40) while the pre-flight estimates less: spend overshoots
    // the cap by at most one call's estimate error, then dispatch stops.
    expect(s.requests).toBeLessThan(N);
    expect(s.refused.some((r) => r.reason === "budget")).toBe(true);
    const refusedAsks = s.refused.reduce((n, r) => n + r.questionHashes.length, 0);
    expect(s.skipped).toBeGreaterThan(0);
    expect(s.judgments + refusedAsks + s.skipped).toBe(15);
    expect(s.costUsd).toBeLessThanOrEqual(1.5 + 0.4);
    await expect(drain(wh, oracle, { pin: PIN, budgetUsd: 1, prices: [] })).rejects.toThrow(
      /no price/,
    );

    const wh2 = await memoryWarehouse();
    await wh2.appendRows("records", records(2) as never);
    const tiny = parseQuestion({
      ...onTopic,
      questionHash: undefined,
      id: "t.tiny",
      maxStateTokens: 5,
    });
    await writeQuestions(wh2, [tiny]);
    const s2 = await drain(wh2, oracle, { pin: PIN, ...clock() });
    expect(s2.requests).toBe(0);
    expect(s2.refused.map((r) => r.reason)).toEqual(["state_too_large"]);
    await wh.close();
    await wh2.close();
  });

  it("backs off on 429 and re-queues the group", async () => {
    const wh = await seeded();
    const inner = oracleBackend();
    let hits = 0;
    const flaky: Backend = {
      ...inner,
      name: "oracle",
      ask: async (s, q, o) => {
        if (hits++ % 3 === 0) throw new RateLimitedError("429", 2_000);
        return inner.ask(s, q, o);
      },
    };
    const c = clock();
    const s = await drain(wh, flaky, { pin: PIN, concurrency: 2, rpm: 600, ...c });
    expect(s.rateLimited).toBeGreaterThan(0);
    expect(s.requests).toBe(N);
    expect(c.now()).toBeGreaterThanOrEqual(2_000);
    expect((await drain(wh, flaky, { pin: PIN, ...clock() })).requests).toBe(0);
    await wh.close();
  });
});

describe("askLive", () => {
  it("writes judge_uses with cache_hit on every use and reuses the cache", async () => {
    const wh = await seeded();
    const be = fixtureBackend({ dir });
    const [r0] = records(N);
    const ask = {
      runId: "run1",
      stepNo: 3,
      mode: "active" as const,
      recordId: "r0",
      state: r0?.state as never,
      questions: [onTopic, crit1],
    };
    const first = await askLive(wh, be, [ask], { pin: PIN });
    expect(first.results[0]?.map((r) => r.cacheHit)).toEqual([false, false]);
    expect(first.calls).toHaveLength(1);
    const second = await askLive(wh, be, [{ ...ask, stepNo: 4 }], { pin: PIN });
    expect(second.results[0]?.map((r) => r.cacheHit)).toEqual([true, true]);
    expect(second.calls).toHaveLength(0);
    expect(second.results[0]?.[0]?.answer).toMatchObject(first.results[0]?.[0]?.answer ?? {});
    const uses = await wh.all<{ step_no: number; cache_hit: boolean }>(
      "SELECT step_no, cache_hit FROM judge_uses ORDER BY step_no, question_hash",
    );
    expect(uses.map((u) => [u.step_no, u.cache_hit])).toEqual([
      [3, false],
      [3, false],
      [4, true],
      [4, true],
    ]);
    expect(await count(wh, "SELECT count(*) FROM decisions WHERE run_id = 'run1'")).toBe(4);
    // A judge failure still records the use; decide() then applies on_error.
    const failing = await askLive(
      wh,
      be,
      [{ ...ask, stepNo: 5, state: { untrusted_record: { title: "new", abstract: "new" } } }],
      { pin: PIN },
    );
    expect(failing.results[0]?.[0]?.answer).toBeNull();
    expect(failing.results[0]?.[0]?.error?.code).toBe("fixture_miss");
    expect(
      await count(wh, "SELECT count(*) FROM judge_uses WHERE step_no = 5 AND NOT cache_hit"),
    ).toBe(2);
    await wh.close();
  });
});
