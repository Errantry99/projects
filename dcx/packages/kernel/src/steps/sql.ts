// `sql` step: a projection or lookup in the DuckDB warehouse; the result is journaled, so a
// replay returns it without touching the warehouse (03 §3.2).

import type { Json, SqlValue } from "@dcx/core";
import type { StepDone, StepEnv } from "../types.js";

/** Make driver values JSON: bigint → number (or string when unsafe), Date → ISO string. */
export function toJson(v: unknown): Json {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(v)
      : v.toString();
  }
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(toJson);
  if (typeof v === "object") {
    const o: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v)) o[k] = toJson(x);
    return o;
  }
  return v as Json;
}

export async function execSql(env: StepEnv, query: string, params: Json[]): Promise<StepDone> {
  const rows = await env.deps.warehouse.all(query, params as SqlValue[]);
  return { output: rows.map(toJson) };
}
