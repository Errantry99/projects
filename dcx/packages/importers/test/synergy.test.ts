import { readFileSync } from "node:fs";
import { jsonHash } from "@dcx/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateSyntheticReview,
  importSynergy,
  includedByRule,
  parseSynergyCsv,
  parseSynergyJsonl,
  SCREEN_LABEL_TARGET,
  SYNTHETIC_REVIEW,
  SynergyImportError,
  sampleRecords,
  stableUuid,
  synergyRows,
  syntheticMeta,
} from "../src/index.js";
import { testWarehouse } from "./helpers.js";

const FIXTURE = new URL(
  `../../../fixtures/synergy-synthetic/${SYNTHETIC_REVIEW.review}.jsonl`,
  import.meta.url,
);
const META = new URL("../../../fixtures/synergy-synthetic/META.json", import.meta.url);

describe("synthetic SYNERGY generator", () => {
  const recs = generateSyntheticReview();

  it("is deterministic and matches the committed fixture", () => {
    expect(generateSyntheticReview()).toEqual(recs);
    expect(parseSynergyJsonl(readFileSync(FIXTURE, "utf8"))).toEqual(recs);
    expect(JSON.parse(readFileSync(META, "utf8"))).toEqual(syntheticMeta(recs));
  });

  it("has 300 records, 10% inclusions, and labels consistent with the stated rule", () => {
    expect(recs).toHaveLength(300);
    expect(recs.filter((r) => r.label_included === 1)).toHaveLength(30);
    for (const r of recs) {
      expect(includedByRule(r.synthetic?.truth ?? {})).toBe(r.label_included === 1);
      expect(r.abstract.length).toBeLessThanOrEqual(2000);
    }
    expect(new Set(recs.map((r) => r.title)).size).toBeGreaterThan(200);
    // No duplicate payloads: identical title + abstract would share every judge cache key.
    expect(new Set(recs.map((r) => `${r.title}\u0000${r.abstract}`)).size).toBe(recs.length);
    const inj = recs.filter((r) => r.synthetic?.truth["screen.injection"] === "true");
    expect(inj.length).toBeGreaterThanOrEqual(3);
    const amb = recs.filter((r) => (r.synthetic?.ambiguous.length ?? 0) > 0).length;
    expect(amb / recs.length).toBeGreaterThan(0.08);
    expect(amb / recs.length).toBeLessThan(0.18);
  });

  it("is labelled synthetic in META.json", () => {
    const meta = JSON.parse(readFileSync(META, "utf8"));
    expect(meta.synthetic).toBe(true);
    expect(meta.banner).toBe("SYNTHETIC DATA");
  });
});

describe("synergyRows", () => {
  const recs = generateSyntheticReview();
  const rows = synergyRows(recs, { review: SYNTHETIC_REVIEW.review, synthetic: true, seed: 7 });

  it("projects state to {untrusted_record: {title, abstract}} and hashes it", () => {
    const r = rows.records[0];
    expect(Object.keys(r?.state as object)).toEqual(["untrusted_record"]);
    const ur = (r?.state as { untrusted_record?: object } | undefined)?.untrusted_record ?? {};
    expect(Object.keys(ur)).toEqual(["title", "abstract"]);
    expect(r?.state_hash).toBe(jsonHash(r?.state ?? null));
    expect(r?.source).toBe("synergy-synthetic:synthetic_exercise_depression");
    expect(rows.content).toHaveLength(300);
  });

  it("writes human, exhaustive labels with a stratified 60/40 split", () => {
    const dec = rows.labels.filter((l) => l.target_ref === SCREEN_LABEL_TARGET.ref);
    expect(dec).toHaveLength(300);
    for (const l of rows.labels) {
      expect(l.source).toBe("human");
      expect(l.selected_by).toBe("exhaustive");
    }
    const count = (label: string, split: string) =>
      dec.filter((l) => l.label === label && l.split === split).length;
    expect(count("include", "tune")).toBe(18);
    expect(count("include", "holdout")).toBe(12);
    expect(count("exclude", "tune")).toBe(162);
    expect(count("exclude", "holdout")).toBe(108);
    // Per-question synthetic truth labels share the record's split.
    const q = rows.labels.filter((l) => l.target_kind === "question");
    expect(q).toHaveLength(300 * 7);
    const splitOf = new Map(dec.map((l) => [l.record_id, l.split]));
    for (const l of q) expect(l.split).toBe(splitOf.get(l.record_id));
    expect(new Set(rows.labels.map((l) => l.label_id)).size).toBe(rows.labels.length);
  });

  it("samples all inclusions plus seeded exclusions", () => {
    const s = sampleRecords(recs, 100, 7);
    expect(s).toHaveLength(100);
    expect(s.filter((r) => r.label_included === 1)).toHaveLength(30);
    expect(sampleRecords(recs, 100, 7)).toEqual(s);
    expect(() => sampleRecords(recs, 10, 7)).toThrow(SynergyImportError);
  });

  it("rejects duplicate ids and malformed lines with the line number", () => {
    expect(() => synergyRows([recs[0], recs[0]] as never, { review: "x" })).toThrow(
      /duplicate/,
    );
    expect(() => parseSynergyJsonl('{"id":"a","title":"t","label_included":2}')).toThrow(
      /line 1: label_included/,
    );
    expect(() => parseSynergyJsonl("{nope")).toThrow(/line 1: invalid JSON/);
  });

  it("reads the real SYNERGY CSV shape", () => {
    const csv =
      'openalex_id,doi,title,abstract,label_included\r\nhttps://openalex.org/W1,,"A, quoted ""title""",Some abstract,1\r\nhttps://openalex.org/W2,10.1/x,T2,,0\r\n';
    const r = parseSynergyCsv(csv);
    expect(r).toEqual([
      {
        id: "W1",
        title: 'A, quoted "title"',
        abstract: "Some abstract",
        label_included: 1,
        doi: null,
      },
      { id: "W2", title: "T2", abstract: "", label_included: 0, doi: "10.1/x" },
    ]);
    const rows2 = synergyRows(r, { review: "Donners_2021" });
    expect(rows2.records[0]?.record_id).toBe("Donners_2021.W1");
    expect(rows2.records[0]?.source).toBe("synergy:Donners_2021");
    expect(rows2.labels).toHaveLength(2);
    expect(() => parseSynergyCsv("title\nx\n")).toThrow(/missing column/);
  });

  it("makes RFC 4122-shaped stable ids", () => {
    expect(stableUuid(["a"])).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(stableUuid(["a"])).toBe(stableUuid(["a"]));
  });
});

describe("importSynergy against the DuckDB DDL", () => {
  let wh: Awaited<ReturnType<typeof testWarehouse>>;
  beforeAll(async () => {
    wh = await testWarehouse();
  });
  afterAll(async () => wh.close());

  it("writes records, content and labels, and re-import is a no-op", async () => {
    const rows = synergyRows(generateSyntheticReview().slice(0, 20), {
      review: SYNTHETIC_REVIEW.review,
      synthetic: true,
    });
    const n = await importSynergy(wh, rows);
    expect(n).toEqual({ records: 20, content: 20, labels: 20 * 8 });
    expect(await importSynergy(wh, rows)).toEqual({ records: 0, content: 0, labels: 0 });
    const t = await wh.all<{ n: number }>(
      "SELECT count(*)::INT AS n FROM training_labels WHERE target_kind = 'decision'",
    );
    expect(t[0]?.n).toBe(20);
    const s = await wh.all<{ t: string }>(
      "SELECT json_extract_string(state, '$.untrusted_record.title') AS t FROM records LIMIT 1",
    );
    expect(typeof s[0]?.t).toBe("string");
  });

  it("the DDL rejects a label whose source names Jev (H5)", async () => {
    const rows = synergyRows(generateSyntheticReview().slice(20, 21), { review: "h5" });
    const bad = { ...rows, records: [], content: [] };
    bad.labels = bad.labels.map((l) => ({ ...l, source: "llm:jev-1.13.0" as never }));
    await expect(importSynergy(wh, bad)).rejects.toThrow(/CHECK|constraint/i);
  });
});
