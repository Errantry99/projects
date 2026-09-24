import { describe, expect, it } from "vitest";
import { assertPinned, isAllowedLabelSource, isUnpinnedModel } from "../src/index.js";

describe("policy", () => {
  it("pinning rejects aliases", () => {
    for (const m of ["jev-latest", "latest", "JEV-LATEST", "gpt:latest", "x/latest"]) {
      expect(isUnpinnedModel(m), m).toBe(true);
      expect(() => assertPinned(m)).toThrow();
    }
    for (const m of ["jev-1.13.0", "claude-x-2026", "latestish-1"]) {
      expect(isUnpinnedModel(m), m).toBe(false);
    }
    expect(() => assertPinned("")).toThrow();
  });
  it("label sources mirror the DDL CHECK", () => {
    for (const s of ["human", "behaviour", "llm:claude", "rule:x"]) {
      expect(isAllowedLabelSource(s), s).toBe(true);
    }
    for (const s of [
      "jev",
      "llm:jev",
      "llm:JEV-1.13.0",
      "rule:jev_x",
      "llm:typesafe",
      "llm:",
      "x",
    ]) {
      expect(isAllowedLabelSource(s), s).toBe(false);
    }
  });
});
