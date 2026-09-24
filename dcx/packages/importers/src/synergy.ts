// SYNERGY importer (07 §4.8): one systematic review → `records`, `content` and `labels` rows.
// Reads the SYNERGY CSV (openalex_id, doi, title, abstract, label_included) or a JSONL of
// `SynergyRecord`s (the synthetic fixture). Author labels load as source='human',
// selected_by='exhaustive', with a stratified, hash-seeded 60/40 tune/holdout split.

import { readFileSync } from "node:fs";
import {
  type ContentRow,
  hashUnit,
  isAllowedLabelSource,
  type Json,
  jsonHash,
  type LabelRow,
  type RecordRow,
  type SqlValue,
  type Warehouse,
} from "@dcx/core";
import { z } from "zod";
import type { SynergyRecord } from "./synthetic-synergy.js";

/** The screening decision's label target: one label per record, `include` | `exclude`. */
export const SCREEN_LABEL_TARGET = { kind: "decision", ref: "screen.include" } as const;
/** Record kind written to `records.kind`; the screening questions apply to it. */
export const SYNERGY_RECORD_KIND = "abstract";

export interface SynergyImportOpts {
  review: string;
  /** Marks rows as synthetic (`records.source = synergy-synthetic:<review>`). */
  synthetic?: boolean;
  /** Keep all inclusions plus a seeded sample of exclusions, `sample` records in total. */
  sample?: number;
  /** Seed for the sample and the split (07 §4.8: 7). */
  seed?: number;
  /** Share of each stratum assigned to `tune` (default 0.6); the rest is `holdout`. */
  tuneShare?: number;
  /** Also emit per-question labels from synthetic truth (default true when truth exists). */
  questionLabels?: boolean;
  /** Version used in per-question label refs (`screen.crit_1@1`). */
  questionVersion?: number;
  /** `records.received_at` (ISO-8601); default null. */
  receivedAt?: string | null;
}

export interface ImportedRows {
  records: RecordRow[];
  content: ContentRow[];
  labels: LabelRow[];
}

export class SynergyImportError extends Error {
  override name = "SynergyImportError";
}

const synergyRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  abstract: z.string().nullable().optional(),
  label_included: z.union([z.literal(0), z.literal(1)]),
  doi: z.string().nullable().optional(),
  synthetic: z
    .object({
      category: z.string(),
      truth: z.record(z.string(), z.string()),
      ambiguous: z.array(z.string()),
    })
    .optional(),
});

function checkRecord(raw: unknown, where: string): SynergyRecord {
  const r = synergyRecordSchema.safeParse(raw);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new SynergyImportError(`${where}: ${msg.join("; ")}`);
  }
  const { abstract, doi, synthetic, ...rest } = r.data;
  return {
    ...rest,
    abstract: abstract ?? "",
    doi: doi ?? null,
    ...(synthetic ? { synthetic } : {}),
  };
}

/** Parse a JSONL of SynergyRecords (blank lines skipped). */
export function parseSynergyJsonl(text: string): SynergyRecord[] {
  const out: SynergyRecord[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch (e) {
      throw new SynergyImportError(`line ${i + 1}: invalid JSON (${(e as Error).message})`);
    }
    out.push(checkRecord(v, `line ${i + 1}`));
  });
  return out;
}

/** Minimal RFC 4180 CSV reader (quoted fields, doubled quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/** Parse the SYNERGY CSV that `python -m synergy_dataset get` writes. */
export function parseSynergyCsv(text: string): SynergyRecord[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const col = (name: string) => header.indexOf(name);
  const idCol = col("openalex_id") >= 0 ? col("openalex_id") : col("id");
  for (const [n, c] of [
    ["openalex_id|id", idCol],
    ["title", col("title")],
    ["label_included", col("label_included")],
  ] as const) {
    if (c < 0) throw new SynergyImportError(`CSV header is missing column ${n}`);
  }
  return rows.map((r, i) =>
    checkRecord(
      {
        id: (r[idCol] ?? "").replace(/^https:\/\/openalex\.org\//, ""),
        title: r[col("title")] ?? "",
        abstract: col("abstract") >= 0 ? (r[col("abstract")] ?? "") : "",
        label_included: Number(r[col("label_included")]),
        doi: col("doi") >= 0 ? r[col("doi")] || null : null,
      },
      `CSV row ${i + 2}`,
    ),
  );
}

/** Read a SYNERGY CSV or JSONL file (chosen by extension). */
export function readSynergyFile(path: string): SynergyRecord[] {
  const text = readFileSync(path, "utf8");
  return path.endsWith(".csv") ? parseSynergyCsv(text) : parseSynergyJsonl(text);
}

/** A deterministic RFC 4122-shaped id (version nibble 5) from a hash of `parts`. */
export function stableUuid(parts: Json): string {
  const h = jsonHash(parts);
  const v = ((Number.parseInt(h[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function synergyRecordId(review: string, id: string): string {
  return `${review}.${id}`;
}

/** All inclusions plus a seeded sample of exclusions (07 §4.8). */
export function sampleRecords(
  records: readonly SynergyRecord[],
  n: number,
  seed: number,
): SynergyRecord[] {
  if (n >= records.length) return [...records];
  const inc = records.filter((r) => r.label_included === 1);
  if (inc.length > n) throw new SynergyImportError(`sample ${n} < ${inc.length} inclusions`);
  const exc = records
    .filter((r) => r.label_included === 0)
    .map((r) => ({ r, u: hashUnit(`sample:${seed}:${r.id}`) }))
    .sort((a, b) => a.u - b.u)
    .slice(0, n - inc.length)
    .map((x) => x.r);
  const keep = new Set([...inc, ...exc]);
  return records.filter((r) => keep.has(r));
}

/** Stratified split by label: in each stratum the lowest-hash `tuneShare` go to `tune`. */
export function stratifiedSplit(
  records: readonly SynergyRecord[],
  seed: number,
  tuneShare: number,
): Map<string, "tune" | "holdout"> {
  const out = new Map<string, "tune" | "holdout">();
  for (const lab of [0, 1]) {
    const s = records
      .filter((r) => r.label_included === lab)
      .map((r) => ({ id: r.id, u: hashUnit(`split:${seed}:${r.id}`) }))
      .sort((a, b) => a.u - b.u || (a.id < b.id ? -1 : 1));
    const k = Math.round(s.length * tuneShare);
    s.forEach((x, i) => {
      out.set(x.id, i < k ? "tune" : "holdout");
    });
  }
  return out;
}

/** Build the warehouse rows for one review. Pure; see `importSynergy` to write them. */
export function synergyRows(
  input: readonly SynergyRecord[],
  opts: SynergyImportOpts,
): ImportedRows {
  const seed = opts.seed ?? 7;
  const seen = new Set<string>();
  for (const r of input) {
    if (seen.has(r.id)) throw new SynergyImportError(`duplicate record id ${r.id}`);
    seen.add(r.id);
  }
  const records = opts.sample ? sampleRecords(input, opts.sample, seed) : [...input];
  const split = stratifiedSplit(records, seed, opts.tuneShare ?? 0.6);
  const source = `${opts.synthetic ? "synergy-synthetic" : "synergy"}:${opts.review}`;
  const labeller = opts.synthetic
    ? `synthetic:generator-seed${seed}`
    : "synergy:review-authors";
  const qv = opts.questionVersion ?? 1;
  const out: ImportedRows = { records: [], content: [], labels: [] };
  const label = (recordId: string, kind: string, ref: string, value: string, sp: string) => {
    const row: LabelRow = {
      label_id: stableUuid(["dcx/label@1", recordId, kind, ref, "human"]),
      record_id: recordId,
      target_kind: kind,
      target_ref: ref,
      label: value,
      source: "human",
      labeller,
      split: sp,
      selected_by: "exhaustive",
      teacher_blind: null,
    };
    if (!isAllowedLabelSource(row.source)) throw new SynergyImportError("H5: bad label source");
    out.labels.push(row);
  };
  for (const r of records) {
    const recordId = synergyRecordId(opts.review, r.id);
    const state = { untrusted_record: { title: r.title, abstract: r.abstract } };
    const sp = split.get(r.id) ?? "holdout";
    out.records.push({
      record_id: recordId,
      kind: SYNERGY_RECORD_KIND,
      source,
      state,
      state_hash: jsonHash(state),
      received_at: opts.receivedAt ?? null,
    });
    out.content.push({
      ref: `import:${source}/${r.id}`,
      body: r as unknown as Json,
      pii_class: "public",
      retention_until: null,
    });
    const t = SCREEN_LABEL_TARGET;
    label(recordId, t.kind, t.ref, r.label_included === 1 ? "include" : "exclude", sp);
    if (r.synthetic && opts.questionLabels !== false) {
      for (const [qid, value] of Object.entries(r.synthetic.truth)) {
        label(recordId, "question", `${qid}@${qv}`, value, sp);
      }
    }
  }
  return out;
}

/** Rows typed as interfaces carry no index signature; the warehouse takes plain records. */
export function asSqlRows<T extends object>(
  rows: readonly T[],
): Record<string, SqlValue | undefined>[] {
  return rows as unknown as Record<string, SqlValue | undefined>[];
}

/** Write the rows in one transaction; re-importing is a no-op (ON CONFLICT DO NOTHING). */
export async function importSynergy(
  wh: Warehouse,
  rows: ImportedRows,
): Promise<{ records: number; content: number; labels: number }> {
  return wh.transaction(async (tx) => ({
    records: await tx.appendRows("records", asSqlRows(rows.records), { onConflict: "ignore" }),
    content: await tx.appendRows("content", asSqlRows(rows.content), { onConflict: "ignore" }),
    labels: await tx.appendRows("labels", asSqlRows(rows.labels), { onConflict: "ignore" }),
  }));
}
