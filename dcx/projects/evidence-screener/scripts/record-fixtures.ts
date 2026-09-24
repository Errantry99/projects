// Writes the demo's recorded fixtures (see dcx/fixtures/README.md). Run from dcx/:
//   npx tsx projects/evidence-screener/scripts/record-fixtures.ts
// then `npx biome format --write fixtures/judge fixtures/llm`.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSynergyJsonl } from "@dcx/importers";
import { CRITERIA } from "../src/criteria.js";
import { buildDemoFixtures, FIXTURES_ROOT } from "../src/fixtures.js";
import { QUESTIONS } from "../src/questions.js";

const root = fileURLToPath(FIXTURES_ROOT);
const review = CRITERIA.review;
const sources = parseSynergyJsonl(
  readFileSync(`${root}synergy-synthetic/${review}.jsonl`, "utf8"),
);
const fx = buildDemoFixtures(review, sources, QUESTIONS, { model: CRITERIA.baseline_model });
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

const judgeDir = `${root}judge/${review}/`;
rmSync(judgeDir, { recursive: true, force: true });
mkdirSync(judgeDir, { recursive: true });
for (const [recordId, entries] of fx.judge)
  writeFileSync(`${judgeDir}${recordId}.json`, json(entries));
writeFileSync(`${root}judge/MANIFEST.json`, json(fx.manifest));

const llmDir = `${root}llm/${fx.manifest.llm_template}/`;
rmSync(llmDir, { recursive: true, force: true });
mkdirSync(llmDir, { recursive: true });
for (const f of fx.llm) writeFileSync(`${llmDir}${f.recordId}.json`, json(f));
console.log(
  `wrote ${fx.judge.size} judge files (${fx.manifest.entries} entries), ${fx.llm.length} llm files`,
);
