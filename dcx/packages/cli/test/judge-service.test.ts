import type { Backend, Json, QuestionDef, RawDecision } from "@dcx/core";
import { candidateSetHash } from "@dcx/core";
import { FIXTURE_CAPS, parseQuestion, writeQuestions } from "@dcx/judge";
import { openDuckWarehouse } from "@dcx/store";
import { describe, expect, it } from "vitest";
import { WarehouseJudge } from "../src/judge-service.js";

/** Answers the first bound option; counts requests. */
function firstOption(): Backend & { asks: number } {
  const be = {
    name: "fake",
    asks: 0,
    caps: () => FIXTURE_CAPS,
    countTokens: () => 1,
    async ask(_s: Json, qs: readonly QuestionDef[]): Promise<RawDecision> {
      be.asks++;
      return {
        backend: "fake",
        modelVersion: "fake-1",
        answers: qs.map((q) => ({
          questionHash: q.questionHash,
          qtype: q.qtype,
          answer: q.options[0]?.label ?? "",
          probs: { [q.options[0]?.label ?? ""]: 1 },
          pAnswer: 1,
        })),
        usage: { inputTokens: 1000, basis: "token-price" },
        latencyMs: 0,
        retries: 0,
        cacheHit: false,
      };
    },
  };
  return be;
}

describe("WarehouseJudge", () => {
  it("keys bound runtime options by candidate_set_hash, so another candidate set misses", async () => {
    const wh = await openDuckWarehouse(":memory:");
    const q = parseQuestion({
      id: "t.pick",
      version: 1,
      qtype: "choice",
      instructions: "Which concept does the record describe?",
      optionsSource: "runtime",
      fields: ["text"],
      status: "active",
    });
    await writeQuestions(wh, [q]);
    const be = firstOption();
    const judge = new WarehouseJudge(wh, be, { pin: "fake-1" });
    const setA = [
      { label: "a", description: null },
      { label: "b", description: null },
    ];
    const setB = [
      { label: "c", description: null },
      { label: "d", description: null },
    ];
    const ask = (options: typeof setA) =>
      judge.askLive({
        state: { text: "x" },
        questions: ["t.pick@1"],
        options: { "t.pick@1": options },
        mode: "active",
      });
    const a = await ask(setA);
    expect(a.uses[0]?.candidateSetHash).toBe(candidateSetHash(setA as never));
    expect((await ask(setA)).uses[0]?.cacheHit).toBe(true);
    const b = await ask(setB);
    expect(b.uses[0]).toMatchObject({ cacheHit: false });
    expect(b.decided[0]?.answer).toBe("c");
    expect(be.asks).toBe(2);
    await wh.close();
  });

  it("prices token-billed live misses from the prices table, as the batch worker does", async () => {
    const wh = await openDuckWarehouse(":memory:");
    await writeQuestions(wh, [
      parseQuestion({
        id: "t.on",
        version: 1,
        qtype: "noul",
        instructions: "Is the record on topic?",
        fields: ["text"],
        status: "active",
      }),
    ]);
    await wh.appendRows("prices", [
      {
        backend: "fake",
        model: "fake-1",
        input_per_m: 2,
        effective_from: "2026-01-01T00:00:00Z",
      },
    ]);
    const judge = new WarehouseJudge(wh, firstOption(), { pin: "fake-1" });
    const r = await judge.askLive({
      state: { text: "x" },
      questions: ["t.on@1"],
      mode: "active",
    });
    expect(r.costUsd).toBeCloseTo(0.002, 12);
    await wh.close();
  });
});
