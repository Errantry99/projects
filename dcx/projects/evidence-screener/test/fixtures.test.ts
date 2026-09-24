import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cacheKey, cacheKeyId, payloadHash, sha256Hex } from "@dcx/core";
import { parseSynergyJsonl, synergyRows } from "@dcx/importers";
import { fixtureBackend, readFixtures } from "@dcx/judge";
import { describe, expect, it } from "vitest";
import {
  buildDemoFixtures,
  CRITERIA,
  FIXTURE_MODEL_V,
  FIXTURES_ROOT,
  type JudgeFixtureEntry,
  type LlmFixture,
  QUESTIONS,
  SCREEN_TEMPLATE,
} from "../src/index.js";

const root = fileURLToPath(FIXTURES_ROOT);
const review = CRITERIA.review;
const sources = parseSynergyJsonl(
  readFileSync(`${root}synergy-synthetic/${review}.jsonl`, "utf8"),
);
const rows = synergyRows(sources, { review, synthetic: true });
const judgeDir = `${root}judge/${review}/`;
const llmDir = `${root}llm/screen.baseline@1/`;
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

describe("recorded judge fixtures", () => {
  const store = readFixtures(judgeDir);

  it("has an entry for every record × question, keyed by the full cache key", () => {
    expect(store.size).toBe(rows.records.length * QUESTIONS.length);
    for (const rec of rows.records) {
      for (const q of QUESTIONS) {
        const key = cacheKey({
          payloadHash: payloadHash(rec.state, q.fields),
          questionHash: q.questionHash,
          backend: "fixture",
          modelV: FIXTURE_MODEL_V,
        });
        const e = store.get(cacheKeyId(key)) as JudgeFixtureEntry | undefined;
        expect(e, `${rec.record_id} ${q.id}`).toBeDefined();
        expect(e?.key).toEqual(key);
        expect(e?.modelVersion).toBe("jev-1.13.0");
        expect(e?.answer.questionHash).toBe(q.questionHash);
      }
    }
  });

  it("matches the builder byte-for-byte in content (regenerate after any question edit)", () => {
    const fx = buildDemoFixtures(review, sources, QUESTIONS, {
      model: CRITERIA.baseline_model,
    });
    for (const [id, entries] of fx.judge)
      expect(readJson(`${judgeDir}${id}.json`)).toEqual(entries);
    expect(readJson(`${root}judge/MANIFEST.json`)).toEqual(fx.manifest);
    for (const f of fx.llm) expect(readJson(`${llmDir}${f.recordId}.json`)).toEqual(f);
  });

  it("replays through the judge package's fixture backend", async () => {
    const be = fixtureBackend({ dir: judgeDir, model: FIXTURE_MODEL_V });
    const rec = rows.records[0];
    const raw = await be.ask(rec?.state ?? null, QUESTIONS, {
      timeoutMs: 1000,
      maxRetries: 0,
      model: FIXTURE_MODEL_V,
    });
    expect(raw.answers).toHaveLength(QUESTIONS.length);
    expect(raw.modelVersion).toBe("jev-1.13.0");
    expect(raw.degraded).toBe(false);
  });

  it("is consistent with the labels, with a 10–15% ambiguous band", () => {
    const byRecord = new Map<string, JudgeFixtureEntry[]>();
    for (const f of readdirSync(judgeDir)) {
      byRecord.set(f.replace(/\.json$/, ""), readJson<JudgeFixtureEntry[]>(`${judgeDir}${f}`));
    }
    const inc = new Set(
      rows.labels.filter((l) => l.label === "include").map((l) => l.record_id),
    );
    let incMeets = 0;
    let incCrit = 0;
    let excSignal = 0;
    let ambiguous = 0;
    for (const [id, es] of byRecord) {
      const crit = es.filter((e) => e.questionRef.includes(".crit_"));
      if (inc.has(id)) {
        incCrit += crit.length;
        incMeets += crit.filter((e) => e.answer.answer === "meets").length;
      } else if (
        crit.some((e) => e.answer.answer === "fails") ||
        es.some(
          (e) => e.questionRef.startsWith("screen.on_topic") && e.answer.answer === "false",
        )
      ) {
        excSignal++;
      }
      if (es.some((e) => Math.max(...Object.values(e.answer.probs)) <= 0.8)) ambiguous++;
      for (const e of es) {
        const s = Object.values(e.answer.probs).reduce((a, b) => a + b, 0);
        expect(s).toBeCloseTo(1, 6);
      }
    }
    expect(incMeets / incCrit).toBeGreaterThan(0.8);
    expect(excSignal / (byRecord.size - inc.size)).toBeGreaterThan(0.85);
    expect(ambiguous / byRecord.size).toBeGreaterThanOrEqual(0.1);
    expect(ambiguous / byRecord.size).toBeLessThanOrEqual(0.15);
  });
});

describe("recorded baseline LLM fixtures", () => {
  it("has one response per record for the pinned template, with plausible recall", () => {
    const files = readdirSync(llmDir);
    expect(files).toHaveLength(rows.records.length);
    const inc = new Set(
      rows.labels.filter((l) => l.label === "include").map((l) => l.record_id),
    );
    let tp = 0;
    for (const f of files) {
      const fx = readJson<LlmFixture>(`${llmDir}${f}`);
      expect(fx.request.template_text_sha256).toBe(sha256Hex(SCREEN_TEMPLATE.text));
      expect(fx.response.modelReturned).toBe(CRITERIA.baseline_model);
      if (inc.has(fx.recordId) && fx.response.value.answer !== "exclude") tp++;
    }
    expect(tp / inc.size).toBeGreaterThan(0.85);
    expect(tp / inc.size).toBeLessThan(1);
  });
});
