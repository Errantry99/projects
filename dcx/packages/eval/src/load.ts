// Build report inputs from warehouse rows (judge_uses ⨝ judgments ⨝ judge_calls, llm_calls,
// routes, trace_steps, labels, and the `decisions` view). Read-only: every function takes only
// `all()`, so a @dcx/store Warehouse or a thin wrapper over a raw DuckDB connection works.

import type { Warehouse } from "@dcx/core";
import type { ArmRecord, CalibrationInput, DecidedBy } from "./report.js";

/** The read side of a Warehouse. */
export type WarehouseReader = Pick<Warehouse, "all">;

/** `$k, $k+1, …` placeholders for an IN list. */
export function inList(n: number, from = 1): string {
  if (n === 0) return "NULL";
  return Array.from({ length: n }, (_, i) => `$${from + i}`).join(", ");
}

const toNum = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const toStr = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

const JOIN_KEY = `j.payload_hash = u.payload_hash AND j.question_hash = u.question_hash
   AND j.candidate_set_hash = u.candidate_set_hash AND j.backend = u.backend
   AND j.model_v = u.model_v AND j.pack_mode = u.pack_mode AND j.sample_no = 0`;

/**
 * One `ArmRecord` per (run, record) over `runIds`:
 * - decision: `routes.branch_taken`, else the last LLM call's `branch_taken` or
 *   `normalised_answer`;
 * - decidedBy: human if branched to human, rule for `tier0_rule`, judge for
 *   `above_threshold` / `audit_sample`, else llm; with no route, llm if an LLM was called;
 * - llmReason (routed records only): `audit` for audit samples, `abstain` for the abstain band,
 *   otherwise the reason code;
 * - cost: LLM `cost_usd` plus judge cost per non-cached use (call cost ÷ n_questions);
 * - latency: `trace_steps` wall clock (max ended − min started) when present, else the sum of
 *   LLM latencies plus the slowest non-cached judge request.
 */
export async function armRecords(wh: WarehouseReader, runIds: readonly string[]) {
  const ids = inList(runIds.length);
  const rows = await wh.all(
    `WITH llm AS (
       SELECT run_id, record_ids[1] AS record_id, count(*)::DOUBLE AS n,
              sum(coalesce(cost_usd, 0))::DOUBLE AS cost, sum(coalesce(latency_ms, 0))::DOUBLE AS lat,
              arg_max(coalesce(branch_taken, normalised_answer), coalesce(step_no, 0)) AS branch
       FROM llm_calls WHERE run_id IN (${ids}) GROUP BY ALL),
     ju AS (
       SELECT u.run_id, u.record_id,
              sum(CASE WHEN u.cache_hit THEN 0
                       ELSE coalesce(c.cost_usd, 0) / greatest(c.n_questions, 1) END)::DOUBLE AS cost,
              max(CASE WHEN u.cache_hit THEN 0 ELSE coalesce(c.latency_ms, 0) END)::DOUBLE AS lat
       FROM judge_uses u
       LEFT JOIN judgments j ON ${JOIN_KEY}
       LEFT JOIN judge_calls c ON c.call_id = j.call_id
       WHERE u.run_id IN (${ids}) GROUP BY ALL),
     rt AS (
       SELECT run_id, record_id, arg_max(branch_taken, step_no) AS branch,
              arg_max(reason_code, step_no) AS reason,
              bool_or(reason_code = 'audit_sample'
                      OR coalesce(CAST(tiers AS VARCHAR), '') LIKE '%"audit_sample"%') AS audited
       FROM routes WHERE run_id IN (${ids}) GROUP BY ALL),
     ts AS (
       SELECT run_id, record_id, (max(ended_at) - min(started_at))::DOUBLE AS wall
       FROM trace_steps WHERE run_id IN (${ids}) AND started_at IS NOT NULL AND ended_at IS NOT NULL
       GROUP BY ALL),
     keys AS (
       SELECT run_id, record_id FROM llm UNION SELECT run_id, record_id FROM ju
       UNION SELECT run_id, record_id FROM rt)
     SELECT k.run_id, k.record_id, coalesce(rt.branch, llm.branch) AS decision,
            rt.reason, rt.audited, rt.branch IS NOT NULL AS routed,
            coalesce(llm.n, 0) AS llm_n, coalesce(llm.cost, 0) AS llm_cost,
            coalesce(ju.cost, 0) AS judge_cost,
            coalesce(ts.wall, coalesce(llm.lat, 0) + coalesce(ju.lat, 0)) AS latency
     FROM keys k
     LEFT JOIN llm USING (run_id, record_id) LEFT JOIN ju USING (run_id, record_id)
     LEFT JOIN rt USING (run_id, record_id)
     LEFT JOIN ts ON ts.run_id = k.run_id AND ts.record_id IS NOT DISTINCT FROM k.record_id
     ORDER BY k.record_id, k.run_id`,
    runIds,
  );
  return rows.map((r): ArmRecord => {
    const decision = toStr(r.decision);
    const reason = r.reason === null || r.reason === undefined ? null : String(r.reason);
    const routed = Boolean(r.routed);
    const audited = Boolean(r.audited);
    const llmCalls = toNum(r.llm_n);
    let decidedBy: DecidedBy;
    if (!routed) decidedBy = llmCalls > 0 ? "llm" : "judge";
    else if (decision === "human") decidedBy = "human";
    else if (reason === "tier0_rule") decidedBy = "rule";
    else if (reason === "above_threshold" || reason === "audit_sample") decidedBy = "judge";
    else decidedBy = "llm";
    const judgeCostUsd = toNum(r.judge_cost);
    const rec: ArmRecord = {
      recordId: toStr(r.record_id),
      decision,
      decidedBy,
      llmCalls,
      costUsd: toNum(r.llm_cost) + judgeCostUsd,
      judgeCostUsd,
      latencyMs: toNum(r.latency),
    };
    if (routed && llmCalls > 0) {
      rec.llmReason = audited ? "audit" : reason === "abstain_band" ? "abstain" : reason;
    }
    return rec;
  });
}

/** Judge requests made by these runs: distinct non-cached calls behind their judge uses. */
export async function judgeRequests(wh: WarehouseReader, runIds: readonly string[]) {
  const rows = await wh.all(
    `SELECT count(DISTINCT j.call_id)::DOUBLE AS n FROM judge_uses u JOIN judgments j ON ${JOIN_KEY}
     WHERE NOT u.cache_hit AND u.run_id IN (${inList(runIds.length)})`,
    runIds,
  );
  return toNum(rows[0]?.n);
}

/** Latest label per record for a target (`labels.target_ref`), optionally one split. */
export async function truthLabels(
  wh: WarehouseReader,
  opts: { targetRef: string; split?: string; source?: string },
): Promise<Record<string, string>> {
  const params: string[] = [opts.targetRef];
  let where = "target_ref = $1";
  if (opts.split !== undefined) {
    params.push(opts.split);
    where += ` AND split = $${params.length}`;
  }
  if (opts.source !== undefined) {
    params.push(opts.source);
    where += ` AND source = $${params.length}`;
  }
  const rows = await wh.all(
    `SELECT record_id, arg_max(label, ts) AS label FROM labels WHERE ${where} GROUP BY record_id`,
    params,
  );
  return Object.fromEntries(rows.map((r) => [toStr(r.record_id), toStr(r.label)]));
}

/**
 * Calibration pairs for one question from `decisions` ⨝ `labels` (target_ref = the question
 * hash or `id@v`), latest use per record. Noul: (p_cal = P(true), label = "true"); Choice and
 * Score: (p_cal_answer, answer = label). `pRaw` is the uncalibrated counterpart.
 */
export async function calibrationPairs(
  wh: WarehouseReader,
  opts: { questionHash: string; split?: string; title?: string },
): Promise<CalibrationInput> {
  const params: string[] = [opts.questionHash];
  let split = "";
  if (opts.split !== undefined) {
    params.push(opts.split);
    split = " AND l.split = $2";
  }
  const rows = await wh.all(
    `SELECT d.record_id, arg_max(d.qtype, d.ts) AS qtype, arg_max(d.answer, d.ts) AS answer,
            arg_max(d.p_answer, d.ts)::DOUBLE AS p_raw, arg_max(d.p_cal, d.ts)::DOUBLE AS p_cal,
            arg_max(d.p_cal_answer, d.ts)::DOUBLE AS p_cal_answer, arg_max(l.label, l.ts) AS label
     FROM decisions d JOIN labels l ON l.record_id = d.record_id
      AND l.target_ref IN (d.question_hash, d.question_id || '@' || d.question_v)${split}
     WHERE d.question_hash = $1 AND d.p_answer IS NOT NULL
     GROUP BY d.record_id ORDER BY d.record_id`,
    params,
  );
  const p: number[] = [];
  const y: boolean[] = [];
  const pRaw: number[] = [];
  for (const r of rows) {
    const raw = toNum(r.p_raw);
    if (r.qtype === "noul") {
      p.push(r.p_cal === null ? raw : toNum(r.p_cal));
      pRaw.push(raw);
      y.push(r.label === "true");
    } else {
      p.push(r.p_cal_answer === null ? raw : toNum(r.p_cal_answer));
      pRaw.push(raw);
      y.push(r.answer === r.label);
    }
  }
  return { title: opts.title ?? opts.questionHash.slice(0, 12), p, y, pRaw };
}
