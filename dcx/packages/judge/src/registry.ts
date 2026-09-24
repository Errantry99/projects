// Question registry (02 §3.3, 07 §2): load question definitions from JSON, compute
// `questionHash` via core, version them (rows are immutable; an edit is a new version with
// `parentHash` lineage), produce `questions` rows and diff two versions.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  fieldsKey,
  type Json,
  type QuestionDef,
  type QuestionRef,
  type QuestionRow,
  questionHash,
  type SqlValue,
  type Warehouse,
} from "@dcx/core";
import { z } from "zod";

const json: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(json),
    z.record(z.string(), json),
  ]),
);

/** The on-disk question format (camelCase; snake_case keys are accepted too). */
export const QuestionFileSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  qtype: z.enum(["choice", "score", "noul"]),
  instructions: z.string(),
  options: z.array(z.object({ label: z.string().min(1), description: json })).default([]),
  noMatchLabel: z.string().nullable().optional(),
  fields: z.array(z.string()).default([]),
  optionsSource: z.enum(["static", "runtime"]).default("static"),
  noMatchWaiver: z.string().optional(),
  maxStateTokens: z.number().int().positive().default(4_000),
  dataClass: z.enum(["public", "internal", "pii", "sensitive"]).default("internal"),
  negationOf: z.string().nullable().optional(),
  labelCompatible: z.boolean().default(false),
  status: z
    .enum(["proposed", "shadow", "canary", "active", "demoted", "retired"])
    .default("proposed"),
  owner: z.string().nullable().optional(),
  appliesTo: z.string().nullable().optional(),
  parentHash: z.string().nullable().optional(),
  createdAt: z.string().optional(),
});
export type QuestionFile = z.input<typeof QuestionFileSchema>;

const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Parse one raw question object and compute its hash. A stated `questionHash` must match. */
export function parseQuestion(raw: unknown): QuestionDef {
  const obj =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [camel(k), v]))
      : raw;
  const f = QuestionFileSchema.parse(obj);
  const def = { ...f } as Omit<QuestionDef, "questionHash">;
  for (const k of Object.keys(def) as (keyof typeof def)[])
    if (def[k] === undefined) delete def[k];
  const hash = questionHash(def);
  const stated = (obj as { questionHash?: unknown }).questionHash;
  if (typeof stated === "string" && stated !== hash) {
    throw new Error(`${f.id}@${f.version}: stated questionHash ${stated} ≠ computed ${hash}`);
  }
  return { ...def, questionHash: hash };
}

/** Load question JSON files (a file holds one object or an array); directories are read
 *  non-recursively, `*.json` only, in name order. */
export function loadQuestionFiles(paths: string | readonly string[]): QuestionDef[] {
  const out: QuestionDef[] = [];
  for (const p of typeof paths === "string" ? [paths] : paths) {
    const files = statSync(p).isDirectory()
      ? readdirSync(p)
          .filter((f) => f.endsWith(".json"))
          .sort()
          .map((f) => join(p, f))
      : [p];
    for (const file of files) {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      for (const r of Array.isArray(raw) ? raw : [raw]) {
        try {
          out.push(parseQuestion(r));
        } catch (e) {
          throw new Error(`${file}: ${(e as Error).message}`, { cause: e });
        }
      }
    }
  }
  return out;
}

export const refOf = (d: Pick<QuestionDef, "id" | "version">): QuestionRef =>
  `${d.id}@${d.version}`;

/** Split `"screen.crit_1@2"`. */
export function parseRef(ref: string): { id: string; version: number } {
  const i = ref.lastIndexOf("@");
  const version = Number(ref.slice(i + 1));
  if (i <= 0 || !Number.isInteger(version) || version < 1)
    throw new Error(`bad question ref: ${ref}`);
  return { id: ref.slice(0, i), version };
}

/**
 * In-memory registry enforcing the versioning rules: re-adding an identical (id, version) is a
 * no-op; the same (id, version) with different content is an error (bump the version); a new
 * version must be higher than the latest and inherits `parentHash` from its predecessor.
 */
export class Registry {
  private readonly byRef = new Map<string, QuestionDef>();

  constructor(defs: readonly QuestionDef[] = []) {
    for (const d of [...defs].sort((a, b) => a.version - b.version)) this.add(d);
  }

  add(def: QuestionDef): QuestionDef {
    const ref = refOf(def);
    const have = this.byRef.get(ref);
    if (have) {
      if (have.questionHash !== def.questionHash) {
        throw new Error(`${ref} already registered with different content; bump the version`);
      }
      return have;
    }
    const prev = this.latest(def.id);
    if (prev && def.version < prev.version) {
      throw new Error(`${ref}: version must be above the latest (${prev.version})`);
    }
    const stored =
      prev && def.parentHash == null && prev.questionHash !== def.questionHash
        ? { ...def, parentHash: prev.questionHash }
        : def;
    this.byRef.set(ref, stored);
    return stored;
  }

  get(ref: string): QuestionDef {
    const d = this.byRef.get(ref);
    if (!d) throw new Error(`unknown question ${ref}`);
    return d;
  }

  latest(id: string): QuestionDef | undefined {
    let best: QuestionDef | undefined;
    for (const d of this.byRef.values())
      if (d.id === id && (!best || d.version > best.version)) best = d;
    return best;
  }

  byHash(hash: string): QuestionDef | undefined {
    for (const d of this.byRef.values()) if (d.questionHash === hash) return d;
    return undefined;
  }

  all(): QuestionDef[] {
    return [...this.byRef.values()].sort(
      (a, b) => a.id.localeCompare(b.id) || a.version - b.version,
    );
  }

  rows(): QuestionRow[] {
    return this.all().map(toQuestionRow);
  }
}

/** The `questions` row for a def (snake_case, `fields_key` filled). */
export function toQuestionRow(d: QuestionDef): QuestionRow {
  const row: QuestionRow = {
    question_id: d.id,
    version: d.version,
    question_hash: d.questionHash,
    parent_hash: d.parentHash ?? null,
    qtype: d.qtype,
    instructions: d.instructions,
    options: d.options.map((o) => ({ label: o.label, description: o.description })),
    options_source: d.optionsSource,
    no_match_label: d.noMatchLabel ?? null,
    fields: [...d.fields],
    fields_key: fieldsKey(d.fields),
    max_state_tokens: d.maxStateTokens,
    data_class: d.dataClass,
    negation_of: d.negationOf ?? null,
    label_compatible: d.labelCompatible,
    status: d.status,
    owner: d.owner ?? null,
    applies_to: d.appliesTo ?? null,
  };
  if (d.createdAt) row.created_at = d.createdAt;
  return row;
}

/** A def from a `questions` row (options/fields may arrive as JSON text). */
export function fromQuestionRow(r: Record<string, unknown>): QuestionDef {
  const parse = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));
  const def = parseQuestion({
    id: r.question_id,
    version: Number(r.version),
    qtype: r.qtype,
    instructions: r.instructions,
    options: parse(r.options) ?? [],
    noMatchLabel: r.no_match_label ?? null,
    fields: parse(r.fields) ?? [],
    optionsSource: r.options_source ?? "static",
    maxStateTokens: Number(r.max_state_tokens),
    dataClass: r.data_class ?? "internal",
    negationOf: r.negation_of ?? null,
    labelCompatible: Boolean(r.label_compatible),
    status: r.status,
    owner: r.owner ?? null,
    appliesTo: r.applies_to ?? null,
    parentHash: r.parent_hash ?? null,
  });
  if (r.question_hash && r.question_hash !== def.questionHash) {
    throw new Error(
      `${def.id}@${def.version}: stored question_hash does not match its content`,
    );
  }
  return def;
}

const Q_COLS = `question_id, version, question_hash, parent_hash, qtype, instructions,
  options::VARCHAR AS options, options_source, no_match_label, to_json(fields)::VARCHAR AS fields,
  max_state_tokens, data_class, negation_of, label_compatible, status, owner, applies_to`;

/** Read question defs from the warehouse, optionally only some statuses. */
export async function readQuestions(
  wh: Warehouse,
  statuses?: readonly string[],
): Promise<QuestionDef[]> {
  if (statuses && statuses.length === 0) return [];
  const where = statuses
    ? `WHERE status IN (${statuses.map((_, i) => `$${i + 1}`).join(", ")})`
    : "";
  const rows = await wh.all<Record<string, unknown>>(
    `SELECT ${Q_COLS} FROM questions ${where} ORDER BY question_id, version`,
    statuses ? [...statuses] : [],
  );
  return rows.map(fromQuestionRow);
}

/** Insert question rows. Existing identical (id, version) rows are skipped; an existing row
 *  with a different hash is an error (rows are immutable). Returns rows written. */
export async function writeQuestions(
  wh: Warehouse,
  defs: readonly QuestionDef[],
): Promise<number> {
  const reg = new Registry(await readQuestions(wh));
  const fresh: QuestionDef[] = [];
  for (const d of defs) {
    const before = reg.all().length;
    const stored = reg.add(d);
    if (reg.all().length > before) fresh.push(stored);
  }
  if (fresh.length === 0) return 0;
  return wh.appendRows(
    "questions",
    fresh.map((d) => toQuestionRow(d) as unknown as Record<string, SqlValue>),
    {
      onConflict: "ignore",
    },
  );
}

/** Move a question to a new lifecycle status (the only mutable column). */
export async function setQuestionStatus(
  wh: Warehouse,
  where: { questionHash: string } | { ref: string },
  status: QuestionDef["status"],
): Promise<void> {
  if ("questionHash" in where) {
    await wh.run("UPDATE questions SET status = $1 WHERE question_hash = $2", [
      status,
      where.questionHash,
    ]);
  } else {
    const { id, version } = parseRef(where.ref);
    await wh.run("UPDATE questions SET status = $1 WHERE question_id = $2 AND version = $3", [
      status,
      id,
      version,
    ]);
  }
}

export interface QuestionChange {
  field: string;
  from: Json;
  to: Json;
}

export interface QuestionDiff {
  from: QuestionRef;
  to: QuestionRef;
  /** The content hash changed → calibrators and thresholds keyed on the old hash no longer apply. */
  hashChanged: boolean;
  changes: QuestionChange[];
  optionsAdded: string[];
  optionsRemoved: string[];
  optionsReordered: boolean;
  labelSetChanged: boolean;
  /** Labels carry over only with an unchanged label set and an owner-set `labelCompatible`. */
  labelsSurvive: boolean;
}

const DIFF_FIELDS = [
  "qtype",
  "instructions",
  "noMatchLabel",
  "fields",
  "optionsSource",
  "maxStateTokens",
  "dataClass",
  "negationOf",
  "status",
  "owner",
  "appliesTo",
  "labelCompatible",
] as const;

/** What changed between two versions of a question. */
export function diff(a: QuestionDef, b: QuestionDef): QuestionDiff {
  const changes: QuestionChange[] = [];
  for (const f of DIFF_FIELDS) {
    const x = (a[f] ?? null) as Json;
    const y = (b[f] ?? null) as Json;
    if (JSON.stringify(x) !== JSON.stringify(y)) changes.push({ field: f, from: x, to: y });
  }
  const la = a.options.map((o) => o.label);
  const lb = b.options.map((o) => o.label);
  for (const o of b.options) {
    const old = a.options.find((p) => p.label === o.label);
    if (old && JSON.stringify(old.description) !== JSON.stringify(o.description)) {
      changes.push({
        field: `options.${o.label}.description`,
        from: old.description,
        to: o.description,
      });
    }
  }
  const optionsAdded = lb.filter((l) => !la.includes(l));
  const optionsRemoved = la.filter((l) => !lb.includes(l));
  const labelSetChanged = optionsAdded.length > 0 || optionsRemoved.length > 0;
  const common = la.filter((l) => lb.includes(l));
  const optionsReordered =
    common.join("\u0000") !== lb.filter((l) => la.includes(l)).join("\u0000");
  if (labelSetChanged || optionsReordered) changes.push({ field: "options", from: la, to: lb });
  return {
    from: refOf(a),
    to: refOf(b),
    hashChanged: a.questionHash !== b.questionHash,
    changes,
    optionsAdded,
    optionsRemoved,
    optionsReordered,
    labelSetChanged,
    labelsSurvive: !labelSetChanged && b.labelCompatible,
  };
}
