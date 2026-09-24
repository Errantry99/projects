import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildVectors, ieeeHexToNumber } from "../scripts/write-vectors.js";
import {
  type CacheKeyParts,
  CanonicalizationError,
  cacheKey,
  cacheKeyId,
  candidateSetHash,
  canonicalize,
  decisionPointId,
  fieldsKey,
  hashUnit,
  type Json,
  modelVersionWithSettings,
  payloadHash,
  project,
  type QuestionContent,
  questionHash,
  sha256Hex,
  toolSetHash,
} from "../src/index.js";

const vectors = JSON.parse(
  readFileSync(new URL("../../../conformance/jcs-vectors.json", import.meta.url), "utf8"),
);

describe("RFC 8785 golden vectors (conformance/jcs-vectors.json)", () => {
  it("the file is current (regenerate with scripts/write-vectors.ts)", () => {
    expect(JSON.parse(JSON.stringify(buildVectors()))).toEqual(vectors);
  });

  for (const v of vectors.canonicalize) {
    it(`canonicalize: ${v.name}`, () => {
      const got = canonicalize(JSON.parse(v.input) as Json);
      expect(got).toBe(v.expected);
      expect(sha256Hex(got)).toBe(v.sha256);
    });
  }

  it("Appendix B numbers", () => {
    for (const { ieee_hex, expected } of vectors.numbers) {
      expect(canonicalize(ieeeHexToNumber(ieee_hex)), ieee_hex).toBe(expected);
    }
  });

  it("rejects NaN, ±Infinity and lone surrogates", () => {
    for (const { ieee_hex } of vectors.number_errors) {
      expect(() => canonicalize(ieeeHexToNumber(ieee_hex))).toThrow(CanonicalizationError);
    }
    for (const { input } of vectors.text_errors) {
      expect(() => canonicalize(JSON.parse(input) as Json)).toThrow(CanonicalizationError);
    }
  });

  it("dcx hashes match the recorded values", () => {
    for (const p of vectors.project) {
      expect(canonicalize(project(p.state, p.fields)), p.name).toBe(p.expected);
      expect(payloadHash(p.state, p.fields)).toBe(p.payload_hash);
      expect(fieldsKey(p.fields)).toBe(p.fields_key);
    }
    for (const q of vectors.question_hash) expect(questionHash(q.def)).toBe(q.expected);
    for (const c of vectors.candidate_set_hash) {
      expect(candidateSetHash(c.candidates)).toBe(c.expected);
    }
    for (const c of vectors.cache_key) {
      expect(cacheKey(c.parts)).toEqual(c.columns);
      expect(cacheKeyId(c.columns)).toBe(c.id);
    }
    for (const d of vectors.decision_point_id) {
      expect(decisionPointId(d.workflow, d.step, d.loop)).toBe(d.expected);
    }
    for (const t of vectors.tool_set_hash) expect(toolSetHash(t.schemas)).toBe(t.expected);
    for (const h of vectors.hash_unit) expect(hashUnit(h.input)).toBe(h.expected);
  });
});

describe("canonicalize edge cases", () => {
  it("skips undefined object members, rejects undefined in arrays and non-plain objects", () => {
    expect(canonicalize({ a: 1, b: undefined } as unknown as Json)).toBe('{"a":1}');
    expect(() => canonicalize([undefined] as unknown as Json)).toThrow(CanonicalizationError);
    expect(() => canonicalize(new Date(0) as unknown as Json)).toThrow(CanonicalizationError);
    expect(() => canonicalize(1n as unknown as Json)).toThrow(CanonicalizationError);
  });
  it("sha256Hex is lowercase hex over UTF-8", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("€")).toBe(sha256Hex(new Uint8Array([0xe2, 0x82, 0xac])));
  });
});

describe("project", () => {
  const state = { a: { b: 1, c: 2 }, d: [1, 2], e: null, f: "x" } as Json;
  it("keeps nesting, omits missing, keeps explicit null", () => {
    expect(project(state, ["a.b", "e", "zz", "f.g"])).toEqual({ a: { b: 1 }, e: null });
  });
  it("does not index arrays; prefix wins", () => {
    expect(project(state, ["d.0"])).toEqual({});
    expect(project(state, ["a.b", "a"])).toEqual({ a: { b: 1, c: 2 } });
  });
  it("rejects malformed paths", () => {
    expect(() => project(state, [""])).toThrow();
    expect(() => project(state, ["a..b"])).toThrow();
  });
  it("payload hash ignores unprojected fields and field order", () => {
    const s2 = { ...(state as object), f: "changed" } as Json;
    expect(payloadHash(state, ["a.b"])).toBe(payloadHash(s2, ["a.b"]));
    expect(payloadHash(state, ["a.b", "e"])).toBe(payloadHash(state, ["e", "a.b"]));
    expect(payloadHash(state, ["f"])).not.toBe(payloadHash(s2, ["f"]));
  });
});

describe("questionHash", () => {
  const q: QuestionContent = {
    qtype: "choice",
    instructions: "Which?",
    options: [
      { label: "x", description: "X case" },
      { label: "other", description: "None" },
    ],
    noMatchLabel: "other",
    fields: ["a", "b"],
  };
  const h = questionHash(q);
  it("changes with every model-visible component", () => {
    const variants: QuestionContent[] = [
      { ...q, qtype: "score" },
      { ...q, instructions: "Which? " },
      { ...q, options: [...q.options].reverse() },
      { ...q, options: [{ label: "x", description: "X case!" }, q.options[1] as never] },
      { ...q, noMatchLabel: null },
      { ...q, fields: ["a"] },
    ];
    for (const v of variants) expect(questionHash(v)).not.toBe(h);
  });
  it("ignores field order, id, version and status", () => {
    expect(questionHash({ ...q, fields: ["b", "a", "a"] })).toBe(h);
    const def = { ...q, id: "x", version: 9, status: "active" } as QuestionContent;
    expect(questionHash(def)).toBe(h);
  });
});

describe("cache key", () => {
  const base: Required<CacheKeyParts> = {
    payloadHash: sha256Hex("p"),
    questionHash: sha256Hex("q"),
    candidateSetHash: "",
    backend: "jev",
    modelV: "jev-1.13.0",
    packMode: "single",
    sampleNo: 0,
  };
  it("defaults to '', single, 0", () => {
    const { candidateSetHash: _c, packMode: _p, sampleNo: _s, ...min } = base;
    expect(cacheKeyId(cacheKey(min))).toBe(cacheKeyId(cacheKey(base)));
  });
  it("completeness: changing any of the seven components misses the cache", () => {
    const id = cacheKeyId(cacheKey(base));
    const changes: Partial<CacheKeyParts>[] = [
      { payloadHash: sha256Hex("p2") },
      { questionHash: sha256Hex("q2") },
      { candidateSetHash: sha256Hex("c") },
      { backend: "laya" },
      { modelV: "jev-1.13.1" },
      { packMode: "pack:8" },
      { sampleNo: 1 },
    ];
    const ids = new Set([id]);
    for (const c of changes) ids.add(cacheKeyId(cacheKey({ ...base, ...c })));
    expect(ids.size).toBe(changes.length + 1);
  });
  it("rejects unpinned models and malformed parts", () => {
    expect(() => cacheKey({ ...base, modelV: "jev-latest" })).toThrow(/pin/);
    expect(() => cacheKey({ ...base, modelV: "latest" })).toThrow(/pin/);
    expect(() => cacheKey({ ...base, payloadHash: "abc" })).toThrow();
    expect(() => cacheKey({ ...base, sampleNo: -1 })).toThrow();
    expect(() => cacheKey({ ...base, backend: "" })).toThrow();
  });
});

describe("helpers", () => {
  it("candidateSetHash is '' for no candidates and order-sensitive otherwise", () => {
    expect(candidateSetHash([])).toBe("");
    expect(candidateSetHash(undefined)).toBe("");
    const a = { id: "1", label: "A", description: "a" };
    const b = { id: "2", label: "B", description: "b" };
    expect(candidateSetHash([a, b])).not.toBe(candidateSetHash([b, a]));
  });
  it("toolSetHash is order-insensitive; key order inside a schema is irrelevant", () => {
    expect(toolSetHash([{ a: 1 }, { b: 2 }])).toBe(toolSetHash([{ b: 2 }, { a: 1 }]));
  });
  it("modelVersionWithSettings appends a digest only when settings exist", () => {
    expect(modelVersionWithSettings("m-1")).toBe("m-1");
    expect(modelVersionWithSettings("m-1", {})).toBe("m-1");
    expect(modelVersionWithSettings("m-1", { effort: "low" })).toMatch(/^m-1\+[0-9a-f]{12}$/);
  });
  it("hashUnit is in [0, 1) and roughly uniform", () => {
    let below = 0;
    for (let i = 0; i < 2000; i++) {
      const u = hashUnit(`audit:${i}`);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      if (u < 0.05) below++;
    }
    expect(below).toBeGreaterThan(60);
    expect(below).toBeLessThan(140);
  });
});
