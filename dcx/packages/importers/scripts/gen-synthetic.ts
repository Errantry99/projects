// Writes the synthetic SYNERGY review under dcx/fixtures/synergy-synthetic/ (BUILD.md
// decision 6). Run from dcx/: npx tsx packages/importers/scripts/gen-synthetic.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  generateSyntheticReview,
  SYNTHETIC_REVIEW,
  syntheticMeta,
} from "../src/synthetic-synergy.js";

const dir = fileURLToPath(new URL("../../../fixtures/synergy-synthetic/", import.meta.url));
mkdirSync(dir, { recursive: true });
const records = generateSyntheticReview();
writeFileSync(
  `${dir}${SYNTHETIC_REVIEW.review}.jsonl`,
  `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
);
writeFileSync(`${dir}META.json`, `${JSON.stringify(syntheticMeta(records), null, 2)}\n`);
console.log(`wrote ${records.length} records to ${dir}`);
