// dcx report h4 | ledger | calibration [--html <path>]
//
// Arms are the latest batch of each workflow (run ids `<wf>@<v>:<batch>:<record_id>`, read from
// the journal). The baseline arm is restricted to the compiled arm's records, so both columns
// describe the same holdout. Two choices are made here and printed under the table:
//   - judge cost includes the cache fill: each use is charged its judgment's call cost ÷
//     n_questions even when the use itself was a cache hit (the compiled run re-uses judgments
//     `dcx judge` bought);
//   - latency is the recorded call latency (LLM calls + the slowest judge call), because a
//     fixture replay returns instantly and wall time would mean nothing.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type ArmRecord,
  armRecords,
  buildH4Report,
  type CalibrationInput,
  calibrationPairs,
  inList,
  judgeRequests,
  queryLedger,
  reliabilitySvg,
  renderH4Html,
  renderH4Text,
  renderLedgerText,
  truthLabels,
} from "@dcx/eval";
import { readQuestions } from "@dcx/judge";
import { CliError, type Context } from "../context.js";
import { loadProject, parseWorkflowRef } from "../project.js";
import { f3, table } from "../table.js";

interface Arm {
  ref: string;
  batch: string;
  runIds: string[];
  /** record id → run id */
  byRecord: Map<string, string>;
  waiting: Set<string>;
}

/** The latest batch of `ref`'s runs in the journal. */
function latestArm(ctx: Context, ref: string): Arm | null {
  const { name, version } = parseWorkflowRef(ref);
  const rows = ctx
    .journal()
    .db.prepare(
      "SELECT run_id, status, created_at FROM runs WHERE workflow = ? AND workflow_v = ? ORDER BY created_at",
    )
    .all(name, version) as { run_id: string; status: string; created_at: number }[];
  const prefix = `${name}@${version}:`;
  const batches = new Map<string, { last: number; rows: typeof rows }>();
  for (const r of rows) {
    // Forks (`<run>~fork<k>-…`, dcx replay --fork-at) are what-ifs, not part of the batch.
    if (!r.run_id.startsWith(prefix) || r.run_id.includes("~fork")) continue;
    const rest = r.run_id.slice(prefix.length);
    const i = rest.indexOf(":");
    if (i < 0) continue;
    const b = rest.slice(0, i);
    const e = batches.get(b) ?? { last: 0, rows: [] };
    e.last = Math.max(e.last, r.created_at);
    e.rows.push(r);
    batches.set(b, e);
  }
  const best = [...batches].sort((a, b) => b[1].last - a[1].last)[0];
  if (!best) return null;
  const [batch, { rows: rs }] = best;
  const byRecord = new Map(
    rs.map((r) => [r.run_id.slice(prefix.length + batch.length + 1), r.run_id]),
  );
  return {
    ref,
    batch,
    runIds: rs.map((r) => r.run_id),
    byRecord,
    waiting: new Set(
      rs.filter((r) => r.status === "waiting" || r.status === "suspended").map((r) => r.run_id),
    ),
  };
}

function restrict(arm: Arm, recordIds: ReadonlySet<string>): Arm {
  const byRecord = new Map([...arm.byRecord].filter(([rec]) => recordIds.has(rec)));
  const runIds = [...byRecord.values()];
  return {
    ...arm,
    byRecord,
    runIds,
    waiting: new Set(runIds.filter((r) => arm.waiting.has(r))),
  };
}

const JOIN_KEY = `j.payload_hash = u.payload_hash AND j.question_hash = u.question_hash
   AND j.candidate_set_hash = u.candidate_set_hash AND j.backend = u.backend
   AND j.model_v = u.model_v AND j.pack_mode = u.pack_mode AND j.sample_no = 0`;

/** Arm records with judge cost including the cache fill, recorded latency, and runs parked on
 *  a human counted as human decisions. */
async function armWithCosts(ctx: Context, arm: Arm): Promise<ArmRecord[]> {
  const wh = await ctx.warehouse();
  const recs = await armRecords(wh, arm.runIds);
  const ids = inList(arm.runIds.length);
  const judge = await wh.all<{ run_id: string; cost: number; lat: number }>(
    `SELECT u.run_id, sum(coalesce(c.cost_usd, 0) / greatest(c.n_questions, 1))::DOUBLE AS cost,
            max(coalesce(c.latency_ms, 0))::DOUBLE AS lat
     FROM (SELECT DISTINCT run_id, payload_hash, question_hash, candidate_set_hash, backend,
                  model_v, pack_mode FROM judge_uses WHERE run_id IN (${ids})) u
     JOIN judgments j ON ${JOIN_KEY} JOIN judge_calls c ON c.call_id = j.call_id
     GROUP BY u.run_id`,
    arm.runIds,
  );
  const llm = await wh.all<{ run_id: string; lat: number; cost: number }>(
    `SELECT run_id, sum(coalesce(latency_ms, 0))::DOUBLE AS lat, sum(coalesce(cost_usd, 0))::DOUBLE AS cost
     FROM llm_calls WHERE run_id IN (${ids}) GROUP BY run_id`,
    arm.runIds,
  );
  const jBy = new Map(judge.map((r) => [r.run_id, r]));
  const lBy = new Map(llm.map((r) => [r.run_id, r]));
  return recs.map((r) => {
    const runId = arm.byRecord.get(r.recordId) ?? "";
    const j = jBy.get(runId);
    const l = lBy.get(runId);
    const judgeCost = j?.cost ?? 0;
    const out: ArmRecord = {
      ...r,
      judgeCostUsd: judgeCost,
      costUsd: (l?.cost ?? 0) + judgeCost,
      latencyMs: (l?.lat ?? 0) + (j?.lat ?? 0),
    };
    if (arm.waiting.has(runId)) {
      out.decidedBy = "human";
      out.decision = "human";
    }
    return out;
  });
}

async function arms(ctx: Context, o: { baseline?: string; compiled?: string; split?: string }) {
  const cfg = ctx.config.config;
  const compiledRef = o.compiled ?? cfg.report.compiled;
  const baselineRef = o.baseline ?? cfg.report.baseline;
  let compiled = latestArm(ctx, compiledRef);
  let baseline = latestArm(ctx, baselineRef);
  if (!compiled) throw new CliError(`no runs of ${compiledRef} yet (dcx run ${compiledRef})`);
  if (!baseline) throw new CliError(`no runs of ${baselineRef} yet (dcx run ${baselineRef})`);
  const wh = await ctx.warehouse();
  let keep = new Set(compiled.byRecord.keys());
  if (o.split) {
    const rows = await wh.all<{ record_id: string }>(
      "SELECT DISTINCT record_id FROM labels WHERE split = $1",
      [o.split],
    );
    const inSplit = new Set(rows.map((r) => r.record_id));
    keep = new Set([...keep].filter((r) => inSplit.has(r)));
  }
  compiled = restrict(compiled, keep);
  baseline = restrict(baseline, keep);
  return { compiled, baseline };
}

async function datasetOf(ctx: Context, recordIds: readonly string[]) {
  const wh = await ctx.warehouse();
  const [r] = await wh.all<{ source: string | null }>(
    `SELECT any_value(source) AS source FROM records WHERE record_id IN (${inList(recordIds.length)})`,
    recordIds,
  );
  const src = r?.source ?? "";
  const i = src.indexOf(":");
  const kind = i < 0 ? src : src.slice(0, i);
  const review = i < 0 ? "" : src.slice(i + 1);
  return {
    dataset: `${kind.replace(/-synthetic$/, "")}/${review}`,
    synthetic: kind.endsWith("synthetic"),
  };
}

/** Calibration inputs per question used by the compiled arm (decisions ⨝ question labels). */
async function calibrationInputs(ctx: Context, runIds: readonly string[], split?: string) {
  const wh = await ctx.warehouse();
  const used = await wh.all<{ question_hash: string }>(
    `SELECT DISTINCT question_hash FROM judge_uses WHERE run_id IN (${inList(runIds.length)})`,
    runIds,
  );
  const defs = new Map((await readQuestions(wh)).map((d) => [d.questionHash, d]));
  const out: Array<CalibrationInput & { noul: boolean }> = [];
  for (const u of used) {
    const d = defs.get(u.question_hash);
    const c = await calibrationPairs(wh, {
      questionHash: u.question_hash,
      ...(split ? { split } : {}),
      title: d ? `${d.id}@${d.version}` : u.question_hash.slice(0, 12),
    });
    if (c.p.length) out.push({ ...c, noul: d?.qtype === "noul" });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

export interface ReportOpts {
  html?: string;
  split?: string;
  baseline?: string;
  compiled?: string;
  runs?: boolean;
}

function writeHtml(ctx: Context, path: string, html: string): string {
  const p = resolve(ctx.io.cwd, path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, html);
  return p;
}

export async function cmdReportH4(ctx: Context, o: ReportOpts): Promise<number> {
  const cfg = ctx.config.config;
  const { compiled, baseline } = await arms(ctx, o);
  const wh = await ctx.warehouse();
  const [compiledRecs, baselineRecs] = [
    await armWithCosts(ctx, compiled),
    await armWithCosts(ctx, baseline),
  ];
  const recordIds = [...compiled.byRecord.keys()];
  const truth = await truthLabels(wh, { targetRef: cfg.truthRef });
  const { dataset, synthetic } = await datasetOf(ctx, recordIds);
  const [fill] = await wh.all<{ n: number }>(
    `SELECT count(DISTINCT j.call_id)::INTEGER AS n FROM judge_uses u JOIN judgments j ON ${JOIN_KEY}
     WHERE u.run_id IN (${inList(compiled.runIds.length)})`,
    compiled.runIds,
  );
  const reRun = await judgeRequests(wh, compiled.runIds);
  const calibration = await calibrationInputs(ctx, compiled.runIds, o.split);
  const conf: number[] = [];
  const correct: boolean[] = [];
  for (const c of calibration) {
    c.p.forEach((p, i) => {
      const y = c.y[i] ?? false;
      const noul = c.noul;
      conf.push(noul ? Math.max(p, 1 - p) : p);
      correct.push(noul ? p >= 0.5 === y : y);
    });
  }
  const project = await loadProject(ctx.config.paths.project).catch(() => null);
  const audit = project?.criteria?.auditRate;
  const hitl = await ctx.journal().listHuman({ unresolvedOnly: true });
  const waitingIds = new Set(compiled.waiting);
  const reviewBand = hitl
    .filter((h) => h.run_id && waitingIds.has(h.run_id))
    .map((h) => {
      const view = (h.card as { view?: { record_id?: string; reason?: string } } | null)?.view;
      return {
        recordId: view?.record_id ?? String(h.run_id),
        reason: [view?.reason, h.reason_code].filter(Boolean).join(" / "),
      };
    });
  const report = buildH4Report({
    dataset,
    split: o.split ?? "holdout",
    synthetic,
    truth,
    baseline: { name: "all-LLM baseline", records: baselineRecs, judgeRequests: null },
    compiled: {
      name: `compiled (${cfg.judge.pin} + LLM fallback${audit ? ` + ${Math.round(audit * 100)}% audit` : ""})`,
      records: compiledRecs,
      judgeRequests: { firstRun: fill?.n ?? 0, reRun },
    },
    calibration,
    riskCoverage: { title: "risk–coverage (calibrated judge answers, pooled)", conf, correct },
    reviewBand,
  });
  ctx.out(renderH4Text(report));
  ctx.out("");
  ctx.out(
    `arms: ${baseline.ref} batch ${baseline.batch} · ${compiled.ref} batch ${compiled.batch} · ${reviewBand.length} records in the review band`,
  );
  ctx.out(
    "notes: judge cost includes the cache fill; latency is recorded call latency (fixture replay); re-run = judge requests made by the compiled run itself",
  );
  if (o.html) ctx.out(`wrote ${writeHtml(ctx, o.html, renderH4Html(report))}`);
  return 0;
}

export async function cmdReportLedger(ctx: Context, o: ReportOpts): Promise<number> {
  const { compiled, baseline } = await arms(ctx, o);
  const l = await queryLedger(await ctx.warehouse(), {
    runIds: compiled.runIds,
    baselineRunIds: baseline.runIds,
  });
  ctx.out(
    `savings ledger · ${compiled.ref} vs ${baseline.ref} · baseline $${l.baselineCostPerRecord.toFixed(4)} / record`,
  );
  ctx.out(renderLedgerText(o.runs ? l : { ...l, rows: [] }));
  const cov = l.rows.filter((r) => r.coverage_without_llm !== null);
  if (cov.length) {
    const mean = cov.reduce((s, r) => s + (r.coverage_without_llm ?? 0), 0) / cov.length;
    ctx.out(
      `coverage without LLM (routes auto-decided): ${Math.round(mean * 100)}% of ${cov.length} routed runs`,
    );
  }
  return 0;
}

export async function cmdReportCalibration(ctx: Context, o: ReportOpts): Promise<number> {
  const { compiled } = await arms(ctx, o);
  const calibration = await calibrationInputs(ctx, compiled.runIds, o.split);
  const r = buildH4Report({
    dataset: "",
    split: o.split ?? "holdout",
    truth: {},
    baseline: { name: "", records: [] },
    compiled: { name: "", records: [] },
    calibration,
  });
  ctx.out(
    table(
      ["question", "n", "ECE", "floor", "ECE/floor", "Brier", "raw ECE", "monotone"],
      r.calibration.map((p) => [
        p.title,
        String(p.n),
        f3(p.ece),
        f3(p.floor),
        p.floor > 0 ? (p.ece / p.floor).toFixed(1) : "–",
        f3(p.brier),
        f3(p.rawEce),
        p.monotone ? "yes" : "no",
      ]),
    ),
  );
  if (o.html) {
    const cards = r.calibration
      .map(
        (p) =>
          `<div><h3>${p.title}</h3>${reliabilitySvg(p)}<p>n=${p.n} · ECE ${f3(p.ece)} vs floor ${f3(p.floor)}</p></div>`,
      )
      .join("");
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Calibration report</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:960px;padding:24px 16px}div{display:inline-block;margin:8px}svg{max-width:100%;height:auto;font-size:10px}svg .frame{fill:none;stroke:#ccc}svg .diag{stroke:#999;stroke-dasharray:4 3}svg polyline{fill:none;stroke-width:1.5}svg polyline.cal{stroke:#2563eb}svg polyline.raw{stroke:#a1a1aa}svg circle.cal{fill:#2563eb}svg circle.raw{fill:#a1a1aa}</style></head><body><h1>Calibration report</h1>${cards}</body></html>\n`;
    ctx.out(`wrote ${writeHtml(ctx, o.html, html)}`);
  }
  return 0;
}
