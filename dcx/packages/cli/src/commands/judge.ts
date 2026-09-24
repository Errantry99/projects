// dcx judge --backend <b> --pin <model> · dcx fit <set> --split tune · dcx eval <set> --split holdout

import {
  type CalibratorMethod,
  type CalibratorRow,
  calibrateAnswer,
  jsonHash,
  LIVE_STATUSES,
  type QuestionDef,
  type ThresholdRow,
} from "@dcx/core";
import { brier, ece, eceNoiseFloor, type SweepItem, sweepThresholds, wilson } from "@dcx/eval";
import {
  type CalPair,
  drain,
  fitCalibrator,
  loadCalibrationPairs,
  loadDecisionPolicy,
  readQuestions,
  recommendMethod,
  refreshProjections,
  WORKLIST_SQL,
  writeCalibrators,
} from "@dcx/judge";
import { checkPin, makeBackend } from "../backends.js";
import { CliError, type Context } from "../context.js";
import { judgeModelV } from "../judge-service.js";
import { f3, table } from "../table.js";

export interface JudgeOpts {
  backend?: string;
  pin?: string;
  budget?: string;
  concurrency?: string;
  rpm?: string;
  url?: string;
  name?: string;
}

export async function cmdJudge(ctx: Context, o: JudgeOpts): Promise<number> {
  const cfg = ctx.config.config;
  const backendName = o.backend ?? cfg.judge.backend;
  const pin = checkPin(o.pin ?? cfg.judge.pin);
  const wire = o.url || o.name ? { url: o.url, name: o.name } : cfg.judge.wire;
  const be = makeBackend({
    backend: backendName,
    pin,
    env: ctx.io.env,
    fixtureDir: ctx.config.paths.judgeFixtures,
    ...(wire
      ? {
          wire: {
            ...(wire.url ? { url: wire.url } : {}),
            ...(wire.name ? { name: wire.name } : {}),
          },
        }
      : {}),
  });
  const wh = await ctx.warehouse();
  const modelV = judgeModelV(be, pin);
  await refreshProjections(wh);
  const [tot] = await wh.all<{ n: number }>(
    "SELECT count(DISTINCT payload_hash)::INTEGER AS n FROM asks WHERE payload_hash IS NOT NULL",
  );
  const [miss] = await wh.all<{ n: number }>(
    `SELECT count(DISTINCT payload_hash)::INTEGER AS n FROM (${WORKLIST_SQL})`,
    [be.name, modelV],
  );
  const total = tot?.n ?? 0;
  const cached = total - (miss?.n ?? 0);
  const stats = await drain(wh, be, {
    pin,
    concurrency: o.concurrency ? Number(o.concurrency) : 4,
    // Recorded fixtures have no rate limit; live backends default to 600 requests a minute.
    rpm: o.rpm ? Number(o.rpm) : backendName === "fixture" ? Number.POSITIVE_INFINITY : 600,
    ...(o.budget ? { budgetUsd: Number(o.budget) } : {}),
  });
  ctx.out(`${stats.requests} requests: ${cached}/${total} payloads cached`);
  ctx.out(
    `  backend ${be.name} · pin ${pin} · ${stats.judgments} judgments written · $${stats.costUsd.toFixed(4)} · ${stats.retries} retries`,
  );
  for (const d of stats.drift) {
    ctx.io.err(`  model drift: pinned ${d.pin}, returned ${d.returned}; questions demoted`);
  }
  if (stats.refused.length)
    ctx.io.err(`  refused ${stats.refused.length} (state too large, caps or budget)`);
  if (stats.skipped)
    ctx.io.err(`  stopped early: ${stats.skipped} asks not sent (still on the work list)`);
  for (const e of stats.errors.slice(0, 5)) ctx.io.err(`  error ${e.code}: ${e.message}`);
  return stats.errors.length || stats.drift.length ? 1 : 0;
}

/** Live questions in a question set (`screen` → `screen.*`). */
async function questionSet(ctx: Context, set: string): Promise<QuestionDef[]> {
  const qs = (await readQuestions(await ctx.warehouse(), LIVE_STATUSES)).filter(
    (q) => q.id === set || q.id.startsWith(`${set}.`),
  );
  if (qs.length === 0) throw new CliError(`no live questions in set "${set}"`);
  return qs;
}

const refOf = (q: Pick<QuestionDef, "id" | "version">) => `${q.id}@${q.version}`;

/** The calibrated probability of a pair's chosen answer. */
function pCalOf(q: QuestionDef, c: CalibratorRow | null, x: CalPair): number {
  const r = calibrateAnswer(q.qtype, c?.method, c?.params, x.answer ?? "", x.p, x.probs);
  return r.pCalAnswer ?? 0;
}

/** Sweep items for an action that fires on answer `label`: pairs whose answer is `label`. */
function actionItems(
  q: QuestionDef,
  c: CalibratorRow | null,
  pairs: readonly CalPair[],
  label: string,
): SweepItem[] {
  return pairs
    .filter((x) => x.answer === label)
    .map((x) => ({
      p: pCalOf(q, c, x),
      correct: q.qtype === "noul" ? (x.y === 1 ? "true" : "false") === label : x.y === 1,
    }));
}

export interface FitOpts {
  split?: string;
  backend?: string;
  pin?: string;
  method?: string;
}

export async function cmdFit(ctx: Context, set: string, o: FitOpts): Promise<number> {
  const cfg = ctx.config.config;
  const split = o.split ?? "tune";
  const backend = o.backend ?? cfg.judge.backend;
  const pin = checkPin(o.pin ?? cfg.judge.pin);
  const wh = await ctx.warehouse();
  const qs = await questionSet(ctx, set);
  const rows: string[][] = [];
  const cals = new Map<string, CalibratorRow>();
  for (const q of qs) {
    const pairs = await loadCalibrationPairs(wh, {
      questionHash: q.questionHash,
      backend,
      modelV: pin,
      split,
    });
    if (pairs.length < 10) {
      rows.push([refOf(q), "–", String(pairs.length), "–", "–", "too few labelled judgments"]);
      continue;
    }
    // Jev-shaped outputs (mass at 1.0) get isotonic whatever backend replays them (07 §3 item 6).
    const method = (o.method ??
      (pin.startsWith("jev-")
        ? "isotonic"
        : recommendMethod(backend, q.qtype, pairs.length))) as CalibratorMethod;
    const cal = fitCalibrator(pairs, {
      questionHash: q.questionHash,
      backend,
      modelV: pin,
      method,
    });
    await writeCalibrators(wh, [cal], { activate: true });
    cals.set(q.questionHash, { ...cal, status: "active" });
    rows.push([
      refOf(q),
      method,
      String(pairs.length),
      f3(cal.ece),
      f3(cal.ece_floor),
      cal.calibrator_id,
    ]);
  }
  ctx.out(`calibrators on split ${split} (${backend}/${pin}):`);
  ctx.out(table(["question", "method", "n", "ECE", "floor", "calibrator"], rows));

  const th: string[][] = [];
  for (const pol of cfg.policies) {
    for (const [ref, label] of Object.entries(pol.labels)) {
      const q = qs.find((x) => refOf(x) === ref);
      if (!q) continue;
      const cal = cals.get(q.questionHash) ?? null;
      const pairs = await loadCalibrationPairs(wh, {
        questionHash: q.questionHash,
        backend,
        modelV: pin,
        split,
      });
      const sweep = sweepThresholds(actionItems(q, cal, pairs, label), { action: pol.action });
      const certified = sweep.tau !== null;
      const minP = certified ? Math.max(sweep.tau as number, pol.min_p) : pol.min_p;
      const id = `thr_${jsonHash({ policy: pol.policy_id, q: q.questionHash, backend, pin, cal: cal?.calibrator_id ?? null, minP }).slice(0, 20)}`;
      const row: ThresholdRow = {
        threshold_id: id,
        policy_id: pol.policy_id,
        question_hash: q.questionHash,
        backend,
        model_v: pin,
        calibrator_id: cal?.calibrator_id ?? null,
        action: pol.action,
        rule: { label, min_p: minP, on_error: "fail_open" },
        ...(pol.floor === undefined ? {} : { floor: pol.floor }),
        cost_matrix: sweep.costMatrix,
        alpha: sweep.alpha,
        delta: sweep.delta,
        certified_loss: sweep.certifiedLoss,
        coverage: sweep.coverage,
        n_cal: sweep.nCal,
        status: "active",
      };
      await wh.transaction(async (tx) => {
        await tx.run(
          `UPDATE thresholds SET status = 'stale', valid_to = current_timestamp
           WHERE policy_id = $1 AND question_hash = $2 AND backend = $3 AND model_v = $4
             AND status = 'active' AND threshold_id <> $5`,
          [pol.policy_id, q.questionHash, backend, pin, id],
        );
        await tx.appendRows("thresholds", [row], { onConflict: "ignore" });
        await tx.run(
          "UPDATE thresholds SET status = 'active', valid_to = NULL WHERE threshold_id = $1",
          [id],
        );
      });
      th.push([
        pol.policy_id,
        ref,
        `${pol.action} on ${label}`,
        minP.toFixed(3),
        String(sweep.nCal),
        certified
          ? `certified (lower bound ${f3(sweep.lowerBound)})`
          : `policy τ; not certifiable at n=${sweep.nCal}`,
      ]);
    }
  }
  if (th.length) {
    ctx.out("thresholds (active):");
    ctx.out(table(["policy", "question", "action", "min_p", "n", "status"], th));
  }
  return 0;
}

export async function cmdEval(ctx: Context, set: string, o: FitOpts): Promise<number> {
  const cfg = ctx.config.config;
  const split = o.split ?? "holdout";
  const backend = o.backend ?? cfg.judge.backend;
  const pin = checkPin(o.pin ?? cfg.judge.pin);
  const wh = await ctx.warehouse();
  const rows: string[][] = [];
  for (const q of await questionSet(ctx, set)) {
    const { calibrator, thresholds } = await loadDecisionPolicy(wh, {
      questionHash: q.questionHash,
      backend,
      modelV: pin,
    });
    const pairs = await loadCalibrationPairs(wh, {
      questionHash: q.questionHash,
      backend,
      modelV: pin,
      split,
    });
    if (pairs.length === 0) {
      rows.push([refOf(q), "0", "–", "–", "–", "–", "–"]);
      continue;
    }
    // Noul: calibrated P(true) against y; Choice/Score: calibrated p(answer) against correctness.
    const ps = pairs.map((x) =>
      q.qtype === "noul"
        ? (calibrateAnswer("noul", calibrator?.method, calibrator?.params, "true", x.p).pCal ??
          x.p)
        : pCalOf(q, calibrator, x),
    );
    const ys = pairs.map((x) => x.y === 1);
    const acc =
      q.qtype === "noul"
        ? pairs.filter((x, i) => (ps[i] as number) >= 0.5 === (x.y === 1)).length
        : pairs.filter((x) => x.y === 1).length;
    const th = thresholds[0];
    let gate = "–";
    if (th) {
      const items = actionItems(q, calibrator, pairs, th.rule.label ?? "").filter(
        (x) => x.p >= th.rule.min_p,
      );
      const ok = items.filter((x) => x.correct).length;
      const w = wilson(ok, items.length);
      gate = `${items.length} auto, precision ${items.length ? f3(ok / items.length) : "–"} [${f3(w.lo)}, ${f3(w.hi)}]`;
    }
    rows.push([
      refOf(q),
      String(pairs.length),
      f3(acc / pairs.length),
      f3(ece(ps, ys)),
      f3(eceNoiseFloor(ps).mean),
      f3(brier(ps, ys)),
      gate,
    ]);
  }
  ctx.out(`eval on split ${split} (${backend}/${pin}, active calibrators and thresholds):`);
  ctx.out(
    table(["question", "n", "accuracy", "ECE", "floor", "Brier", "threshold on holdout"], rows),
  );
  return 0;
}
