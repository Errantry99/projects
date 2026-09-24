// The H4 comparison report (07 §4.8): all-LLM baseline vs compiled, as the §4.8 text table and a
// self-contained HTML page with inline-SVG reliability diagrams and a risk–coverage curve.
// Input is plain per-record arrays; `load.ts` builds them from warehouse rows.

import {
  brier,
  ece,
  eceNoiseFloor,
  type Interval,
  median,
  type ReliabilityBin,
  type RiskCoveragePoint,
  recallCI,
  reliabilityBins,
  riskCoverage,
  selectiveAccuracyAt,
  wilson,
} from "./metrics.js";

/** Who made the final decision for a record. Coverage without LLM = rule or judge. */
export type DecidedBy = "rule" | "judge" | "llm" | "human";

/** One record's outcome in one arm. */
export interface ArmRecord {
  recordId: string;
  /** Final action / branch, e.g. include | exclude | flag | human. */
  decision: string;
  decidedBy: DecidedBy;
  llmCalls: number;
  /** Why the LLM was called (abstain | audit | …), for the breakdown; unset for baselines. */
  llmReason?: string | null;
  /** All cost for the record (LLM + judge), USD. */
  costUsd: number;
  /** The judge share of `costUsd` (for the coverage-needed note). */
  judgeCostUsd?: number;
  latencyMs: number;
}

export interface ArmInput {
  /** Column title, e.g. "all-LLM baseline" or "compiled (jev-1.13.0 + LLM fallback + 5% audit)". */
  name: string;
  records: readonly ArmRecord[];
  /** Judge requests on the first run and on a re-run; null/undefined prints "–". */
  judgeRequests?: { firstRun: number; reRun?: number } | null;
}

export interface CalibrationInput {
  title: string;
  /** Calibrated probability and outcome. */
  p: readonly number[];
  y: readonly boolean[];
  /** Raw (uncalibrated) probability, drawn for comparison when given. */
  pRaw?: readonly number[];
}

export interface H4Input {
  /** e.g. "synergy/<id>". */
  dataset: string;
  /** e.g. "holdout". */
  split: string;
  /** Flag synthetic datasets: the header then says SYNTHETIC DATA. */
  synthetic?: boolean;
  /** Ground truth by record id (e.g. author labels, source='human'). */
  truth: Readonly<Record<string, string>>;
  /** The costly class whose recall is reported (default "include"). */
  positiveLabel?: string;
  /** The decision that drops a record (default "exclude"); any other decision retains it. */
  negativeDecision?: string;
  /** Header noun for positives (default "inclusions"). */
  positiveNoun?: string;
  baseline: ArmInput;
  compiled: ArmInput;
  /** H4's saving target (default 0.8). */
  savingTarget?: number;
  /** Recall CI: Wilson (default; §4.8's [0.62, 0.98] at 10/11) or percentile bootstrap. */
  ci?: "wilson" | "bootstrap";
  /** Below either count the header says ILLUSTRATIVE (default n < 500 per 02 §3.5, or fewer
   *  than 30 positives per 04 §3.7). */
  claimMin?: { n: number; positives: number };
  calibration?: readonly CalibrationInput[];
  riskCoverage?: { title?: string; conf: readonly number[]; correct: readonly boolean[] };
  reviewBand?: ReadonlyArray<{
    recordId: string;
    question?: string;
    pCal?: number;
    reason?: string;
  }>;
  /** Seed for bootstrap and noise-floor simulation (default 7). */
  seed?: number;
}

export interface ArmSummary {
  name: string;
  n: number;
  recall: Interval;
  coverage: number;
  llmCalls: number;
  llmBreakdown: Array<[string, number]>;
  judgeRequests: { firstRun: number; reRun?: number } | null;
  costPerRecord: number;
  totalUsd: number;
  judgeUsd: number;
  p50LatencyMs: number;
}

export interface CalibrationPanel {
  title: string;
  n: number;
  bins: ReliabilityBin[];
  ece: number;
  floor: number;
  brier: number;
  rawBins?: ReliabilityBin[];
  rawEce?: number;
  /** Accuracy never decreases across populated bins. */
  monotone: boolean;
}

export interface H4Report {
  header: string;
  flags: string[];
  n: number;
  positives: number;
  baseline: ArmSummary;
  compiled: ArmSummary;
  saving: number;
  savingTarget: number;
  /** Coverage the compiled arm would need to reach the target; null when not computable. */
  coverageNeeded: number | null;
  calibration: CalibrationPanel[];
  riskCoverage: {
    title: string;
    points: RiskCoveragePoint[];
    at90: RiskCoveragePoint | null;
  } | null;
  reviewBand: NonNullable<H4Input["reviewBand"]>;
}

function summariseArm(arm: ArmInput, input: H4Input): ArmSummary {
  const pos = input.positiveLabel ?? "include";
  const neg = input.negativeDecision ?? "exclude";
  const recs = arm.records;
  const n = recs.length;
  const pt = recs
    .filter((r) => input.truth[r.recordId] !== undefined)
    .map((r) => ({ pred: r.decision !== neg, truth: input.truth[r.recordId] === pos }));
  const positives = pt.filter((x) => x.truth);
  const recall =
    input.ci === "bootstrap"
      ? recallCI(pt, { seed: input.seed ?? 7 })
      : wilson(positives.filter((x) => x.pred).length, positives.length);
  const byReason = new Map<string, number>();
  for (const r of recs) {
    if (r.llmReason && r.llmCalls > 0) {
      byReason.set(r.llmReason, (byReason.get(r.llmReason) ?? 0) + r.llmCalls);
    }
  }
  const totalUsd = recs.reduce((s, r) => s + r.costUsd, 0);
  return {
    name: arm.name,
    n,
    recall,
    coverage: n
      ? recs.filter((r) => r.decidedBy === "rule" || r.decidedBy === "judge").length / n
      : 0,
    llmCalls: recs.reduce((s, r) => s + r.llmCalls, 0),
    llmBreakdown: [...byReason].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    judgeRequests: arm.judgeRequests ?? null,
    costPerRecord: n ? totalUsd / n : 0,
    totalUsd,
    judgeUsd: recs.reduce((s, r) => s + (r.judgeCostUsd ?? 0), 0),
    p50LatencyMs: median(recs.map((r) => r.latencyMs)),
  };
}

function panel(c: CalibrationInput, seed: number): CalibrationPanel {
  const bins = reliabilityBins(c.p, c.y);
  const out: CalibrationPanel = {
    title: c.title,
    n: c.p.length,
    bins,
    ece: ece(c.p, c.y),
    floor: eceNoiseFloor(c.p, { seed }).mean,
    brier: brier(c.p, c.y),
    monotone: bins.every((b, i) => i === 0 || b.acc >= (bins[i - 1]?.acc ?? 0) - 1e-12),
  };
  if (c.pRaw) {
    out.rawBins = reliabilityBins(c.pRaw, c.y);
    out.rawEce = ece(c.pRaw, c.y);
  }
  return out;
}

/** Compute the H4 comparison. */
export function buildH4Report(input: H4Input): H4Report {
  const baseline = summariseArm(input.baseline, input);
  const compiled = summariseArm(input.compiled, input);
  const ids = input.compiled.records.map((r) => r.recordId);
  const labelled = ids.filter((id) => input.truth[id] !== undefined);
  const n = labelled.length;
  const positives = labelled.filter(
    (id) => input.truth[id] === (input.positiveLabel ?? "include"),
  ).length;
  const min = input.claimMin ?? { n: 500, positives: 30 };
  const flags: string[] = [];
  if (input.synthetic) flags.push("SYNTHETIC DATA");
  if (n < min.n || positives < min.positives) flags.push("ILLUSTRATIVE, too small for a claim");
  const noun = input.positiveNoun ?? "inclusions";
  const header = [
    "H4 report",
    input.dataset,
    `${input.split} n=${n} (${positives} ${noun})`,
    ...flags,
  ].join(" · ");
  const target = input.savingTarget ?? 0.8;
  const saving = baseline.totalUsd > 0 ? 1 - compiled.totalUsd / baseline.totalUsd : 0;
  // cost/record = c_judge + (1 − coverage + audit)·c_LLM (04 §3.11); solve for coverage.
  const cn = compiled.n;
  const llmUsd = compiled.totalUsd - compiled.judgeUsd;
  const cLlm = compiled.llmCalls ? llmUsd / compiled.llmCalls : 0;
  const nonDeciding = input.compiled.records
    .filter((r) => r.decidedBy !== "llm")
    .reduce((s, r) => s + r.llmCalls, 0);
  const coverageNeeded =
    cn && cLlm > 0
      ? 1 +
        nonDeciding / cn -
        ((1 - target) * baseline.costPerRecord - compiled.judgeUsd / cn) / cLlm
      : null;
  const seed = input.seed ?? 7;
  const rc = input.riskCoverage;
  return {
    header,
    flags,
    n,
    positives,
    baseline,
    compiled,
    saving,
    savingTarget: target,
    coverageNeeded,
    calibration: (input.calibration ?? []).map((c) => panel(c, seed)),
    riskCoverage: rc
      ? {
          title: rc.title ?? "risk–coverage",
          points: riskCoverage(rc.conf, rc.correct),
          at90: selectiveAccuracyAt(rc.conf, rc.correct, 0.9),
        }
      : null,
    reviewBand: input.reviewBand ?? [],
  };
}

// ---------------------------------------------------------------------------------------------
// Text (the exact §4.8 layout)
// ---------------------------------------------------------------------------------------------

const pct = (x: number) => `${Math.round(x * 100)}%`;
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "–");
const secs = (ms: number) =>
  Number.isFinite(ms)
    ? `${ms >= 1000 ? (ms / 1000).toFixed(1) : (ms / 1000).toFixed(2)} s`
    : "–";
const pad = (s: string, w: number) => (s.length >= w ? `${s}  ` : s.padEnd(w));

function cells(a: ArmSummary) {
  const br = a.llmBreakdown.map(([k, v]) => `${v} ${k}`).join(" + ");
  const jr = a.judgeRequests;
  return {
    recall: `${f2(a.recall.value)} [${f2(a.recall.lo)}, ${f2(a.recall.hi)}]`,
    coverage: pct(a.coverage),
    llm: br ? `${a.llmCalls}  (${br})` : `${a.llmCalls}`,
    judge: jr
      ? `${jr.firstRun} (first run)${jr.reRun === undefined ? "" : ` · ${jr.reRun} (re-run)`}`
      : "–",
    perRecord: `$${a.costPerRecord.toFixed(4)}`,
    total: `$${a.totalUsd.toFixed(2)}`,
    latency: secs(a.p50LatencyMs),
  };
}

/** The saving note after the total, e.g. "saving 78%  (H4 needs ≥80% → coverage ≥0.86)". */
export function savingNote(r: H4Report): string {
  const s = `saving ${pct(r.saving)}`;
  const t = pct(r.savingTarget);
  if (r.saving >= r.savingTarget) return `${s}  (H4 ≥${t} met)`;
  const need = r.coverageNeeded;
  return need === null || need > 1
    ? `${s}  (H4 needs ≥${t})`
    : `${s}  (H4 needs ≥${t} → coverage ≥${need.toFixed(2)})`;
}

/** Render the §4.8 text table. */
export function renderH4Text(r: H4Report): string {
  const b = cells(r.baseline);
  const c = cells(r.compiled);
  const row = (label: string, x: string, y: string) =>
    `${pad(label, 20)}${pad(x, 22)}${y}`.trimEnd();
  return [
    r.header,
    row("", r.baseline.name, r.compiled.name),
    row("recall", b.recall, c.recall),
    row("coverage w/o LLM", b.coverage, c.coverage),
    row("LLM calls", b.llm, c.llm),
    row("judge requests", b.judge, c.judge),
    row("cost / record", b.perRecord, c.perRecord),
    row("total", b.total, `${pad(c.total, 15)}${savingNote(r)}`),
    row("p50 latency", b.latency, c.latency),
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// HTML (self-contained: inline CSS and SVG, no external assets)
// ---------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const r3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "–");

const W = 280;
const M = 36;
const P = W - 2 * M;
const sx = (v: number) => (M + v * P).toFixed(1);
const sy = (v: number) => (W - M - v * P).toFixed(1);

function axes(xLabel: string, yLabel: string): string {
  const ticks = [0, 0.5, 1]
    .map(
      (t) =>
        `<text x="${sx(t)}" y="${W - M + 14}" text-anchor="middle">${t}</text>` +
        `<text x="${M - 6}" y="${sy(t)}" text-anchor="end" dy="4">${t}</text>`,
    )
    .join("");
  return (
    `<rect x="${M}" y="${M}" width="${P}" height="${P}" class="frame"/>${ticks}` +
    `<text x="${W / 2}" y="${W - 4}" text-anchor="middle">${esc(xLabel)}</text>` +
    `<text x="12" y="${W / 2}" text-anchor="middle" transform="rotate(-90 12 ${W / 2})">${esc(yLabel)}</text>`
  );
}

function binMarks(bins: readonly ReliabilityBin[], cls: string): string {
  const maxN = Math.max(1, ...bins.map((b) => b.n));
  const line = bins.map((b) => `${sx(b.conf)},${sy(b.acc)}`).join(" ");
  const dots = bins
    .map(
      (b) =>
        `<circle class="${cls}" cx="${sx(b.conf)}" cy="${sy(b.acc)}" r="${(2.5 + 4 * Math.sqrt(b.n / maxN)).toFixed(1)}"><title>bin ${b.bin}: n=${b.n}, conf ${r3(b.conf)}, acc ${r3(b.acc)}</title></circle>`,
    )
    .join("");
  return `<polyline class="${cls}" points="${line}"/>${dots}`;
}

/** Inline-SVG reliability diagram (5 equal-width bins; marker area ∝ bin count). */
export function reliabilitySvg(p: CalibrationPanel): string {
  const raw = p.rawBins ? binMarks(p.rawBins, "raw") : "";
  return (
    `<svg viewBox="0 0 ${W} ${W}" width="${W}" height="${W}" role="img" aria-label="${esc(p.title)} reliability diagram">` +
    `${axes("mean predicted p", "observed frequency")}` +
    `<line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(1)}" y2="${sy(1)}" class="diag"/>` +
    `${raw}${binMarks(p.bins, "cal")}</svg>`
  );
}

/** Inline-SVG risk–coverage curve. */
export function riskCoverageSvg(points: readonly RiskCoveragePoint[]): string {
  const maxRisk = Math.max(0.05, ...points.map((q) => q.risk));
  const line = points.map((q) => `${sx(q.coverage)},${sy(q.risk / maxRisk)}`).join(" ");
  return (
    `<svg viewBox="0 0 ${W} ${W}" width="${W}" height="${W}" role="img" aria-label="risk–coverage curve">` +
    `${axes("coverage", `risk (max ${maxRisk.toFixed(2)})`)}` +
    `<polyline class="cal" points="${line}"/></svg>`
  );
}

const CSS = `:root{--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;--cal:#2563eb;--raw:#a1a1aa;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--fg:#f5f5f7;--muted:#a1a1a6;--line:#3a3a3c;--cal:#60a5fa;--raw:#71717a;--warn:#fbbf24}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:960px;padding:24px 16px}
h1{font-size:20px}h2{font-size:16px;margin-top:32px}.flag{color:var(--warn);font-weight:600}
pre{overflow-x:auto;border:1px solid var(--line);padding:12px;border-radius:6px;font-size:13px}
table{border-collapse:collapse;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:4px 10px;text-align:left}
.grid{display:flex;flex-wrap:wrap;gap:24px}.card{max-width:100%}.muted{color:var(--muted)}
svg{max-width:100%;height:auto;font-size:10px;fill:var(--muted)}
svg .frame{fill:none;stroke:var(--line)}svg .diag{stroke:var(--muted);stroke-dasharray:4 3}
svg polyline{fill:none;stroke-width:1.5}svg polyline.cal{stroke:var(--cal)}svg polyline.raw{stroke:var(--raw)}
svg circle.cal{fill:var(--cal)}svg circle.raw{fill:var(--raw)}`;

/** Render a self-contained HTML report (inline CSS and SVG, no scripts or external assets). */
export function renderH4Html(r: H4Report): string {
  const flags = r.flags.map((f) => `<span class="flag">${esc(f)}</span>`).join(" · ");
  const cal = r.calibration
    .map(
      (p) =>
        `<div class="card"><h3>${esc(p.title)}</h3>${reliabilitySvg(p)}<p>n=${p.n} · ECE ${r3(p.ece)} vs noise floor ${r3(p.floor)} (${(p.ece / p.floor).toFixed(1)}×, gate ≤2×) · Brier ${r3(p.brier)}${p.rawEce === undefined ? "" : ` · raw ECE ${r3(p.rawEce)}`}${p.monotone ? "" : ' · <span class="flag">not monotone</span>'}</p></div>`,
    )
    .join("");
  const rc = r.riskCoverage;
  const rcHtml = rc
    ? `<h2>${esc(rc.title)}</h2>${riskCoverageSvg(rc.points)}${rc.at90 ? `<p>Selective accuracy ${r3(rc.at90.selectiveAccuracy)} at coverage ${r3(rc.at90.coverage)} (n=${rc.at90.n}).</p>` : ""}`
    : "";
  const band = r.reviewBand.length
    ? `<h2>Review-band records (${r.reviewBand.length})</h2><table><tr><th>record</th><th>question</th><th>p_cal</th><th>reason</th></tr>${r.reviewBand
        .map(
          (x) =>
            `<tr><td>${esc(x.recordId)}</td><td>${esc(x.question ?? "")}</td><td>${x.pCal === undefined ? "" : r3(x.pCal)}</td><td>${esc(x.reason ?? "")}</td></tr>`,
        )
        .join("")}</table>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>H4 report</title><style>${CSS}</style></head><body>
<h1>H4 report · ${esc(r.header.split(" · ").slice(1, 3).join(" · "))}</h1>
<p>${flags || '<span class="muted">no flags</span>'}</p>
<pre>${esc(renderH4Text(r))}</pre>
${cal ? `<h2>Reliability (calibrated; grey = raw)</h2><div class="grid">${cal}</div>` : ""}
${rcHtml}
${band}
</body></html>
`;
}
