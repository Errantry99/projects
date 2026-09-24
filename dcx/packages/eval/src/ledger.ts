// The savings ledger (05 §3.3): per run, what the all-LLM baseline would have cost, what the
// compiled run cost, and the saving. Compiled costs come from core's `savings_ledger` view
// (LLM spend + judge spend per non-cached use); the baseline is records × the baseline's
// measured cost per record.

import { inList, type WarehouseReader } from "./load.js";

/** One row of core's `savings_ledger` view plus a record count. */
// TODO(core): promote (core exports no row type for the savings_ledger view).
export interface SavingsLedgerViewRow {
  run_id: string;
  workflow?: string | null;
  records: number;
  llm_calls: number;
  llm_cost_usd: number;
  judge_uses: number;
  judge_cache_hits: number;
  judge_cost_usd: number;
  total_cost_usd: number;
  coverage_without_llm?: number | null;
}

export interface LedgerRow {
  run_id: string;
  workflow: string | null;
  records: number;
  baseline_cost_usd: number;
  compiled_cost_usd: number;
  saving_usd: number;
  /** 1 − compiled / baseline; null when the baseline cost is 0. */
  saving_pct: number | null;
  llm_calls: number;
  judge_uses: number;
  judge_cache_hits: number;
  coverage_without_llm: number | null;
}

export interface Ledger {
  baselineCostPerRecord: number;
  rows: LedgerRow[];
  total: Omit<LedgerRow, "run_id" | "workflow" | "coverage_without_llm">;
}

/** Baseline cost per record from baseline runs' ledger rows (Σ cost ÷ Σ records). */
export function baselinePerRecord(rows: readonly SavingsLedgerViewRow[]): number {
  const recs = rows.reduce((s, r) => s + r.records, 0);
  return recs ? rows.reduce((s, r) => s + r.total_cost_usd, 0) / recs : 0;
}

const savingPct = (base: number, comp: number) => (base > 0 ? 1 - comp / base : null);

/** Build the ledger from arrays. */
export function buildLedger(
  rows: readonly SavingsLedgerViewRow[],
  opts: { baselineCostPerRecord: number },
): Ledger {
  const c = opts.baselineCostPerRecord;
  const out = rows.map((r): LedgerRow => {
    const base = r.records * c;
    return {
      run_id: r.run_id,
      workflow: r.workflow ?? null,
      records: r.records,
      baseline_cost_usd: base,
      compiled_cost_usd: r.total_cost_usd,
      saving_usd: base - r.total_cost_usd,
      saving_pct: savingPct(base, r.total_cost_usd),
      llm_calls: r.llm_calls,
      judge_uses: r.judge_uses,
      judge_cache_hits: r.judge_cache_hits,
      coverage_without_llm: r.coverage_without_llm ?? null,
    };
  });
  const sum = (k: "records" | "baseline_cost_usd" | "compiled_cost_usd" | "llm_calls") =>
    out.reduce((s, r) => s + r[k], 0);
  const base = sum("baseline_cost_usd");
  const comp = sum("compiled_cost_usd");
  return {
    baselineCostPerRecord: c,
    rows: out,
    total: {
      records: sum("records"),
      baseline_cost_usd: base,
      compiled_cost_usd: comp,
      saving_usd: base - comp,
      saving_pct: savingPct(base, comp),
      llm_calls: sum("llm_calls"),
      judge_uses: out.reduce((s, r) => s + r.judge_uses, 0),
      judge_cache_hits: out.reduce((s, r) => s + r.judge_cache_hits, 0),
    },
  };
}

/** `savings_ledger` rows for these runs, with records counted over llm_calls, judge_uses and
 *  routes. */
export async function ledgerViewRows(
  wh: WarehouseReader,
  runIds: readonly string[],
): Promise<SavingsLedgerViewRow[]> {
  const ids = inList(runIds.length);
  const rows = await wh.all(
    `WITH recs AS (
       SELECT run_id, count(DISTINCT record_id)::DOUBLE AS records FROM (
         SELECT run_id, unnest(record_ids) AS record_id FROM llm_calls WHERE run_id IN (${ids})
         UNION ALL SELECT run_id, record_id FROM judge_uses WHERE run_id IN (${ids})
         UNION ALL SELECT run_id, record_id FROM routes WHERE run_id IN (${ids}))
       GROUP BY run_id)
     SELECT s.run_id, s.workflow, coalesce(recs.records, 0) AS records,
            s.llm_calls::DOUBLE AS llm_calls, s.llm_cost_usd::DOUBLE AS llm_cost_usd,
            s.judge_uses::DOUBLE AS judge_uses, s.judge_cache_hits::DOUBLE AS judge_cache_hits,
            s.judge_cost_usd::DOUBLE AS judge_cost_usd, s.total_cost_usd::DOUBLE AS total_cost_usd,
            s.coverage_without_llm::DOUBLE AS coverage_without_llm
     FROM savings_ledger s LEFT JOIN recs USING (run_id)
     WHERE s.run_id IN (${ids}) ORDER BY s.run_id`,
    runIds,
  );
  return rows.map((r) => ({
    run_id: String(r.run_id),
    workflow: r.workflow === null || r.workflow === undefined ? null : String(r.workflow),
    records: Number(r.records),
    llm_calls: Number(r.llm_calls),
    llm_cost_usd: Number(r.llm_cost_usd),
    judge_uses: Number(r.judge_uses),
    judge_cache_hits: Number(r.judge_cache_hits),
    judge_cost_usd: Number(r.judge_cost_usd),
    total_cost_usd: Number(r.total_cost_usd),
    coverage_without_llm:
      r.coverage_without_llm === null || r.coverage_without_llm === undefined
        ? null
        : Number(r.coverage_without_llm),
  }));
}

/** The ledger as a warehouse query: compiled `runIds`, priced against the baseline runs (or an
 *  explicit baseline cost per record). */
export async function queryLedger(
  wh: WarehouseReader,
  opts: {
    runIds: readonly string[];
    baselineRunIds?: readonly string[];
    baselineCostPerRecord?: number;
  },
): Promise<Ledger> {
  const c =
    opts.baselineCostPerRecord ??
    baselinePerRecord(await ledgerViewRows(wh, opts.baselineRunIds ?? []));
  return buildLedger(await ledgerViewRows(wh, opts.runIds), { baselineCostPerRecord: c });
}

const usd = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(4)}`;

/** A plain-text ledger table. */
export function renderLedgerText(l: Ledger): string {
  const head = ["run", "records", "baseline", "compiled", "saving", "saving %"];
  const fmt = (
    r: Pick<
      LedgerRow,
      "records" | "baseline_cost_usd" | "compiled_cost_usd" | "saving_usd" | "saving_pct"
    >,
  ) => [
    String(r.records),
    usd(r.baseline_cost_usd),
    usd(r.compiled_cost_usd),
    usd(r.saving_usd),
    r.saving_pct === null ? "–" : `${Math.round(r.saving_pct * 100)}%`,
  ];
  const body = [head, ...l.rows.map((r) => [r.run_id, ...fmt(r)]), ["total", ...fmt(l.total)]];
  const w = head.map((_, i) => Math.max(...body.map((row) => (row[i] ?? "").length)));
  return body
    .map((row) =>
      row
        .map((c, i) => c.padEnd((w[i] ?? 0) + 2))
        .join("")
        .trimEnd(),
    )
    .join("\n");
}
