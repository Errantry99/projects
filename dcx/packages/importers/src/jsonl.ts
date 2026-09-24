// JSONL trace importer (07 §4.5, 04 §3): one TraceRow-shaped JSON object per line →
// `llm_calls` rows plus a mirrored `trace_steps` row each. Fills what the source carries; a row
// without `effect` is classed `open` (discovery cannot define its branch by effect).
// Validation is strict: unknown keys, wrong types and duplicate ids are reported with line
// numbers, and nothing is written unless the whole file parses.

import { readFileSync } from "node:fs";
import { type Json, MODES, type TraceRow, type TraceStepRow, type Warehouse } from "@dcx/core";
import { z } from "zod";
import { asSqlRows } from "./synergy.js";

export class JsonlImportError extends Error {
  override name = "JsonlImportError";
  constructor(readonly problems: readonly string[]) {
    super(
      `JSONL import failed with ${problems.length} problem(s):\n  ${problems.slice(0, 20).join("\n  ")}`,
    );
  }
}

const hex = z.string().regex(/^[0-9a-f]{64}$/, "expected lowercase sha256 hex");
const int = z.number().int();
const nn = <T extends z.ZodType>(t: T) => t.nullable().optional();

/** The TraceRow contract as a strict schema (types.ts `TraceRow`). */
export const traceRowSchema = z.strictObject({
  call_id: z.string().min(1),
  ts: z.iso.datetime({ offset: true }).optional(),
  source: z
    .string()
    .regex(/^(kernel|import:[\w.-]+)$/, "expected 'kernel' or 'import:<name>'")
    .optional(),
  mode: nn(z.enum(MODES as [string, ...string[]])),
  run_id: z.string().min(1),
  step_no: nn(int.nonnegative()),
  workflow: nn(z.string()),
  workflow_v: nn(int),
  record_ids: z.array(z.string()).optional(),
  decision_point_id: nn(z.string()),
  system_hash: nn(hex),
  template_id: nn(z.string()),
  template_v: nn(int),
  template_hash: nn(hex),
  slots: nn(z.record(z.string(), z.strictObject({ path: z.string(), field_hash: hex }))),
  rendered_hash: nn(hex),
  input_projection_ref: nn(z.string()),
  input_hash: nn(hex),
  tool_set_hash: nn(hex),
  provider: nn(z.string()),
  model_requested: nn(z.string()),
  model_returned: nn(z.string()),
  temperature: nn(z.number()),
  reasoning_level: nn(z.string()),
  seed: nn(int),
  output_kind: nn(z.enum(["tool_call", "structured", "choice_like", "text"])),
  parsed: z.json().optional(),
  normalised_answer: nn(z.string()),
  alternatives: z.json().optional(),
  raw_ref: nn(z.string()),
  effect: z.json().optional(),
  branch_taken: nn(z.string()),
  input_tokens: nn(int.nonnegative()),
  output_tokens: nn(int.nonnegative()),
  cache_tokens: nn(int.nonnegative()),
  reasoning_tokens: nn(int.nonnegative()),
  cost_usd: nn(z.number().nonnegative()),
  cost_basis: nn(z.enum(["provider-reported", "token-price", "gpu-amortised", "zero"])),
  latency_ms: nn(int.nonnegative()),
  retries: nn(int.nonnegative()),
  label_source: nn(z.string()),
  is_jev_output: z.boolean().optional(),
  teacher_blind: nn(z.boolean()),
});

/** `effect` when the downstream step's effect was recorded, else `open`. */
export type TraceClass = "effect" | "open";

export function traceClass(row: Pick<TraceRow, "effect">): TraceClass {
  return row.effect === undefined || row.effect === null ? "open" : "effect";
}

export interface JsonlImport {
  llm_calls: TraceRow[];
  trace_steps: TraceStepRow[];
  stats: { rows: number; open: number; effect: number; runs: number };
}

export interface JsonlOpts {
  /** `source` for rows that carry none (default `import:jsonl`). */
  source?: string;
}

function dropUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** Parse and validate TraceRow JSONL. Throws JsonlImportError listing every problem. */
export function parseTraceJsonl(text: string, opts: JsonlOpts = {}): JsonlImport {
  const source = opts.source ?? "import:jsonl";
  const problems: string[] = [];
  const rows: Array<{ line: number; row: TraceRow }> = [];
  text.split("\n").forEach((raw, i) => {
    const line = i + 1;
    if (raw.trim() === "") return;
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch (e) {
      problems.push(`line ${line}: invalid JSON (${(e as Error).message})`);
      return;
    }
    const r = traceRowSchema.safeParse(v);
    if (!r.success) {
      for (const iss of r.error.issues) {
        problems.push(`line ${line}: ${iss.path.join(".") || "(root)"}: ${iss.message}`);
      }
      return;
    }
    rows.push({ line, row: dropUndefined({ source, ...r.data }) as TraceRow });
  });

  // Identity checks: unique call_id; unique (run_id, step_no); missing step_no is assigned
  // in file order after the run's highest explicit step.
  const calls = new Map<string, number>();
  const steps = new Map<string, number>();
  const maxStep = new Map<string, number>();
  for (const { line, row } of rows) {
    const prev = calls.get(row.call_id);
    if (prev !== undefined)
      problems.push(`line ${line}: duplicate call_id (first on line ${prev})`);
    calls.set(row.call_id, line);
    if (row.step_no != null) {
      const k = `${row.run_id}\u0000${row.step_no}`;
      const p = steps.get(k);
      if (p !== undefined) {
        problems.push(`line ${line}: duplicate (run_id, step_no) (first on line ${p})`);
      }
      steps.set(k, line);
      maxStep.set(row.run_id, Math.max(maxStep.get(row.run_id) ?? -1, row.step_no));
    }
  }
  if (problems.length > 0) throw new JsonlImportError(problems);

  const out: JsonlImport = {
    llm_calls: [],
    trace_steps: [],
    stats: { rows: 0, open: 0, effect: 0, runs: 0 },
  };
  for (const { row } of rows) {
    const stepNo = row.step_no ?? (maxStep.get(row.run_id) ?? -1) + 1;
    maxStep.set(row.run_id, Math.max(maxStep.get(row.run_id) ?? -1, stepNo));
    const call: TraceRow = { ...row, step_no: stepNo };
    const cls = traceClass(call);
    const endedAt = call.ts ? Date.parse(call.ts) : null;
    const output: Json = {
      class: cls,
      parsed: call.parsed ?? null,
      normalised_answer: call.normalised_answer ?? null,
      effect: call.effect ?? null,
      branch_taken: call.branch_taken ?? null,
    };
    out.llm_calls.push(call);
    out.trace_steps.push({
      run_id: call.run_id,
      step_no: stepNo,
      parent_step_no: null,
      kind: "llm",
      name: call.template_id ?? call.decision_point_id ?? "llm",
      status: "completed",
      attempt: 1 + (call.retries ?? 0),
      mode: (call.mode ?? "active") as TraceStepRow["mode"],
      input_ref: call.input_projection_ref ?? null,
      output,
      error: null,
      idempotency_key: null,
      started_at:
        endedAt !== null && call.latency_ms != null ? endedAt - call.latency_ms : null,
      ended_at: endedAt,
      record_id: call.record_ids?.[0] ?? null,
      activity: `llm:${call.template_id ?? "unknown"}`,
      source: call.source ?? source,
    });
    out.stats[cls]++;
  }
  out.stats.rows = rows.length;
  out.stats.runs = new Set(rows.map((r) => r.row.run_id)).size;
  return out;
}

export function readTraceJsonl(path: string, opts?: JsonlOpts): JsonlImport {
  return parseTraceJsonl(readFileSync(path, "utf8"), opts);
}

/** Write both tables in one transaction; re-importing the same file is a no-op. */
export async function importTraceJsonl(
  wh: Warehouse,
  imp: JsonlImport,
): Promise<{ llm_calls: number; trace_steps: number }> {
  return wh.transaction(async (tx) => ({
    llm_calls: await tx.appendRows("llm_calls", asSqlRows(imp.llm_calls), {
      onConflict: "ignore",
    }),
    trace_steps: await tx.appendRows("trace_steps", asSqlRows(imp.trace_steps), {
      onConflict: "ignore",
    }),
  }));
}
