import { CACHE_KEY_COLUMNS, cacheKey, cacheKeyId } from "@dcx/core";
import { describe, expect, it } from "vitest";
import { contractCacheKeyColumns } from "../src/index.js";

const hex = (c: string) => c.repeat(64);

describe("cache key has exactly the seven CONTRACT.md components", () => {
  const documented = contractCacheKeyColumns();

  it("CONTRACT.md lists seven components", () => {
    expect(documented).toHaveLength(7);
    expect(new Set(documented).size).toBe(7);
  });

  it("CACHE_KEY_COLUMNS matches CONTRACT.md, in order", () => {
    expect([...CACHE_KEY_COLUMNS]).toEqual(documented);
  });

  it("cacheKey() returns exactly those columns, and each one changes cacheKeyId", () => {
    const k = cacheKey({
      payloadHash: hex("a"),
      questionHash: hex("b"),
      backend: "fixture",
      modelV: "fx-1",
    });
    expect(Object.keys(k).sort()).toEqual([...documented].sort());
    const id = cacheKeyId(k);
    const alt: Record<string, string | number> = {
      payload_hash: hex("c"),
      question_hash: hex("d"),
      candidate_set_hash: hex("e"),
      backend: "jev",
      model_v: "fx-2",
      pack_mode: "pack:4",
      sample_no: 1,
    };
    for (const col of documented) {
      expect(cacheKeyId({ ...k, [col]: alt[col] } as typeof k), col).not.toBe(id);
    }
  });
});
