// Calibrator fitting (02 §3.4, 07 §3 item 6): isotonic (PAV, robust to mass at p = 1.0),
// temperature and Platt from (p_raw, label) pairs. Params are serialised exactly as core's
// `calibrate()` TS function and SQL macro read them: {} | {T} | {a,b} | {knots:[[x,y],...]}.
// Each fitted row carries ECE with its Bernoulli noise floor and the Brier score.

import {
  type CalibratorMethod,
  type CalibratorParams,
  type CalibratorRow,
  calibrateProbs,
  jsonHash,
  type QType,
  type SqlValue,
  type Warehouse,
} from "@dcx/core";

/** One calibration example: the raw probability and whether it came true. For Noul, p is
 *  P(true) and y is "label is true"; for Choice/Score, p is P(answer) and y is "answer is
 *  correct". `probs`/`answer` enable the multiclass temperature form. */
export interface CalPair {
  p: number;
  y: 0 | 1;
  probs?: Record<string, number>;
  answer?: string;
}

const EPS = 1e-6;
const clamp = (p: number) => Math.min(1 - EPS, Math.max(EPS, p));
const logit = (p: number) => Math.log(clamp(p) / (1 - clamp(p)));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** Apply fitted params (the same semantics as core's calibrateProbs / calibrate). */
export function applyCalibration(
  method: CalibratorMethod,
  params: CalibratorParams,
  x: CalPair,
): number {
  return calibrateProbs(method, params, x.probs, x.answer ?? "", x.p) ?? x.p;
}

// ---------------------------------------------------------------------------------------------
// Isotonic (pool-adjacent-violators)
// ---------------------------------------------------------------------------------------------

/**
 * Isotonic regression by PAV. Ties in p are pooled into one block before PAV (so the 56% of Jev
 * answers at exactly 1.0 become one weighted block, never an arbitrary split), then adjacent
 * violators are merged. Knots sit at each block's min and max x; runs of equal y are collapsed
 * to their end points. Empty input → identity ({knots: []}).
 */
export function fitIsotonic(pairs: readonly CalPair[]): { knots: Array<[number, number]> } {
  if (pairs.length === 0) return { knots: [] };
  const sorted = [...pairs].sort((a, b) => a.p - b.p);
  type Block = { lo: number; hi: number; sum: number; w: number };
  const blocks: Block[] = [];
  for (const x of sorted) {
    const last = blocks[blocks.length - 1];
    if (last && last.hi === x.p) {
      last.sum += x.y;
      last.w += 1;
    } else blocks.push({ lo: x.p, hi: x.p, sum: x.y, w: 1 });
  }
  const stack: Block[] = [];
  for (const b of blocks) {
    stack.push({ ...b });
    while (stack.length > 1) {
      const top = stack[stack.length - 1] as Block;
      const prev = stack[stack.length - 2] as Block;
      if (prev.sum / prev.w <= top.sum / top.w) break;
      stack.splice(-2, 2, {
        lo: prev.lo,
        hi: top.hi,
        sum: prev.sum + top.sum,
        w: prev.w + top.w,
      });
    }
  }
  const pts: Array<[number, number]> = [];
  for (const b of stack) {
    const y = b.sum / b.w;
    pts.push([b.lo, y]);
    if (b.hi !== b.lo) pts.push([b.hi, y]);
  }
  // Collapse interior points of equal-y runs (interpolation is unchanged).
  const knots = pts.filter((pt, i) => {
    const a = pts[i - 1];
    const c = pts[i + 1];
    return !(a && c && a[1] === pt[1] && c[1] === pt[1]);
  });
  return { knots };
}

// ---------------------------------------------------------------------------------------------
// Temperature and Platt
// ---------------------------------------------------------------------------------------------

function logLoss(ps: readonly number[], pairs: readonly CalPair[]): number {
  let s = 0;
  pairs.forEach((x, i) => {
    const p = clamp(ps[i] ?? x.p);
    s -= x.y ? Math.log(p) : Math.log(1 - p);
  });
  return s / Math.max(1, pairs.length);
}

/** One scalar T minimising log loss of the calibrated chosen probability (multiclass form when
 *  pairs carry ≥2 probs, as core's calibrateProbs applies it). Golden-section on log T. */
export function fitTemperature(
  pairs: readonly CalPair[],
  range: [number, number] = [0.05, 20],
): { T: number } {
  if (pairs.length === 0) return { T: 1 };
  const f = (lt: number) => {
    const params = { T: Math.exp(lt) };
    return logLoss(
      pairs.map((x) => applyCalibration("temperature", params, x)),
      pairs,
    );
  };
  let a = Math.log(range[0]);
  let b = Math.log(range[1]);
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < 80; i++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - g * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + g * (b - a);
      fd = f(d);
    }
  }
  return { T: Math.exp((a + b) / 2) };
}

/** Platt scaling sigmoid(a·logit(p) + b) by Newton's method on Platt's smoothed targets
 *  (y+ = (N+ + 1)/(N+ + 2), y- = 1/(N- + 2)), which keeps separable data finite. Each Newton
 *  step is backtracked until the loss decreases (Lin, Lin & Weng 2007): with mass at p = 1.0
 *  (Jev) the Hessian is nearly singular and a full step diverges. */
export function fitPlatt(pairs: readonly CalPair[]): { a: number; b: number } {
  if (pairs.length === 0) return { a: 1, b: 0 };
  const nPos = pairs.filter((x) => x.y === 1).length;
  const nNeg = pairs.length - nPos;
  const tPos = (nPos + 1) / (nPos + 2);
  const tNeg = 1 / (nNeg + 2);
  const z = pairs.map((x) => logit(x.p));
  const t = pairs.map((x) => (x.y ? tPos : tNeg));
  // Cross-entropy against the smoothed targets, in a numerically stable form.
  const loss = (a: number, b: number) =>
    z.reduce((s, zi, i) => {
      const f = a * zi + b;
      const ti = t[i] as number;
      return (
        s +
        (f >= 0 ? (1 - ti) * f + Math.log1p(Math.exp(-f)) : -ti * f + Math.log1p(Math.exp(f)))
      );
    }, 0);
  let a = 1;
  let b = 0;
  let cur = loss(a, b);
  for (let it = 0; it < 100; it++) {
    let ga = 0;
    let gb = 0;
    let haa = 1e-12;
    let hab = 0;
    let hbb = 1e-12;
    z.forEach((zi, i) => {
      const p = sigmoid(a * zi + b);
      const r = p - (t[i] as number);
      const w = p * (1 - p);
      ga += r * zi;
      gb += r;
      haa += w * zi * zi;
      hab += w * zi;
      hbb += w;
    });
    if (Math.abs(ga) + Math.abs(gb) < 1e-10) break;
    const det = haa * hbb - hab * hab;
    if (Math.abs(det) < 1e-24) break;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    let step = 1;
    let next = loss(a - da, b - db);
    // Armijo condition on the Newton direction; halve the step until it holds.
    while (next > cur - 1e-4 * step * (ga * da + gb * db) && step > 1e-10) {
      step /= 2;
      next = loss(a - step * da, b - step * db);
    }
    if (step <= 1e-10) break;
    a -= step * da;
    b -= step * db;
    const moved = step * (Math.abs(da) + Math.abs(db));
    cur = next;
    if (moved < 1e-10) break;
  }
  return { a, b };
}

// ---------------------------------------------------------------------------------------------
// Metrics: ECE, its Bernoulli noise floor, Brier
// ---------------------------------------------------------------------------------------------

/** Expected calibration error with equal-width bins (p = 1.0 falls in the last bin). */
export function ece(ps: readonly number[], ys: readonly number[], bins = 5): number {
  const n = ps.length;
  if (n === 0) return 0;
  const sp = new Array<number>(bins).fill(0);
  const sy = new Array<number>(bins).fill(0);
  const c = new Array<number>(bins).fill(0);
  ps.forEach((p, i) => {
    const k = Math.min(bins - 1, Math.max(0, Math.floor(p * bins)));
    sp[k] = (sp[k] ?? 0) + p;
    sy[k] = (sy[k] ?? 0) + (ys[i] ?? 0);
    c[k] = (c[k] ?? 0) + 1;
  });
  let e = 0;
  for (let k = 0; k < bins; k++) {
    const ck = c[k] ?? 0;
    if (ck > 0) e += Math.abs((sy[k] ?? 0) - (sp[k] ?? 0)) / n;
  }
  return e;
}

export function brier(ps: readonly number[], ys: readonly number[]): number {
  if (ps.length === 0) return 0;
  return ps.reduce((s, p, i) => s + (p - (ys[i] ?? 0)) ** 2, 0) / ps.length;
}

/** Deterministic PRNG (mulberry32) so noise floors are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The ECE a perfectly calibrated model would show at this n and p distribution: mean ECE of
 *  labels drawn from Bernoulli(p). It depends on n and the p distribution (07 §6 quotes 0.032
 *  at n = 200); always report ECE next to it. */
export function eceNoiseFloor(
  ps: readonly number[],
  o: { bins?: number; sims?: number; seed?: number } = {},
): number {
  if (ps.length === 0) return 0;
  const r = rng(o.seed ?? 7);
  const sims = o.sims ?? 200;
  let s = 0;
  for (let i = 0; i < sims; i++)
    s += ece(
      ps,
      ps.map((p) => (r() < p ? 1 : 0)),
      o.bins ?? 5,
    );
  return s / sims;
}

// ---------------------------------------------------------------------------------------------
// Fitting a calibrator row
// ---------------------------------------------------------------------------------------------

/** Method by backend and question type (07 §3 item 6): isotonic for Jev (mass at 1.0) and for
 *  large n; Platt for Noul; temperature for logit backends. */
export function recommendMethod(backend: string, qtype: QType, n: number): CalibratorMethod {
  if (backend === "jev" || n >= 1_000) return "isotonic";
  if (qtype === "noul") return "platt";
  return "temperature";
}

export function fitParams(
  method: CalibratorMethod,
  pairs: readonly CalPair[],
): CalibratorParams {
  switch (method) {
    case "identity":
      return {};
    case "temperature":
      return fitTemperature(pairs);
    case "platt":
      return fitPlatt(pairs);
    case "isotonic":
    case "histogram":
      return fitIsotonic(pairs);
  }
}

export interface FitOpts {
  questionHash: string;
  backend: string;
  modelV: string;
  method: CalibratorMethod;
  candidateSpec?: string;
  /** Pairs for ECE/Brier; defaults to the fit pairs (optimistic). */
  evalPairs?: readonly CalPair[];
  bins?: number;
  status?: CalibratorRow["status"];
}

/** Fit a calibrator and produce its `calibrators` row (id is a content hash, so refitting the
 *  same data is idempotent). */
export function fitCalibrator(pairs: readonly CalPair[], o: FitOpts): CalibratorRow {
  const params = fitParams(o.method, pairs);
  const ev = o.evalPairs ?? pairs;
  const ps = ev.map((x) => applyCalibration(o.method, params, x));
  const ys = ev.map((x) => x.y);
  const bins = o.bins ?? 5;
  const key = { q: o.questionHash, b: o.backend, m: o.modelV, cs: o.candidateSpec ?? "" };
  return {
    calibrator_id: `cal_${jsonHash({ ...key, method: o.method, params, n: pairs.length }).slice(0, 20)}`,
    question_hash: o.questionHash,
    backend: o.backend,
    model_v: o.modelV,
    candidate_spec: o.candidateSpec ?? "",
    method: o.method,
    params,
    n_fit: pairs.length,
    ece: ece(ps, ys, bins),
    ece_floor: eceNoiseFloor(ps, { bins }),
    brier: brier(ps, ys),
    status: o.status ?? "candidate",
  };
}

/** Write calibrator rows. With `activate`, each row becomes the only active calibrator for its
 *  (question_hash, backend, model_v, candidate_spec): the previous active one goes stale. */
export async function writeCalibrators(
  wh: Warehouse,
  rows: readonly CalibratorRow[],
  o: { activate?: boolean } = {},
): Promise<void> {
  await wh.transaction(async (tx) => {
    for (const r of rows) {
      if (o.activate) {
        await tx.run(
          `UPDATE calibrators SET status = 'stale' WHERE status = 'active' AND question_hash = $1
             AND backend = $2 AND model_v = $3 AND candidate_spec = $4 AND calibrator_id <> $5`,
          [r.question_hash, r.backend, r.model_v, r.candidate_spec ?? "", r.calibrator_id],
        );
      }
    }
    const out = rows.map((r) => ({ ...r, status: o.activate ? "active" : r.status }));
    await tx.appendRows("calibrators", out as unknown as Record<string, SqlValue>[], {
      onConflict: "ignore",
    });
    if (o.activate) {
      for (const r of rows) {
        await tx.run("UPDATE calibrators SET status = 'active' WHERE calibrator_id = $1", [
          r.calibrator_id,
        ]);
      }
    }
  });
}

/**
 * (p_raw, label) pairs for one (question, backend, model) from `judgments` joined to
 * `training_labels` through `projections` (H5: never raw `labels`). `target_ref` may be the
 * question hash or `id@version`.
 */
export async function loadCalibrationPairs(
  wh: Warehouse,
  k: { questionHash: string; backend: string; modelV: string; split?: string },
): Promise<CalPair[]> {
  const rows = await wh.all<Record<string, unknown>>(
    `SELECT DISTINCT p.record_id, j.qtype, j.answer, j.p_answer::DOUBLE AS p_answer,
            to_json(j.probs)::VARCHAR AS probs, l.label
     FROM judgments j
     JOIN questions q ON q.question_hash = j.question_hash
     JOIN projections p ON p.payload_hash = j.payload_hash AND p.fields_key = q.fields_key
     JOIN training_labels l ON l.record_id = p.record_id
       AND (l.target_ref = j.question_hash OR l.target_ref = q.question_id || '@' || q.version)
     WHERE j.question_hash = $1 AND j.backend = $2 AND j.model_v = $3 AND j.sample_no = 0
       AND ($4 = '' OR l.split = $4)`,
    [k.questionHash, k.backend, k.modelV, k.split ?? ""],
  );
  return rows.map((r) => {
    const probs = r.probs ? (JSON.parse(String(r.probs)) as Record<string, number>) : undefined;
    const noul = r.qtype === "noul";
    const pair: CalPair = {
      p: Number(r.p_answer),
      y: (noul ? String(r.label) === "true" : String(r.label) === String(r.answer)) ? 1 : 0,
      answer: String(r.answer),
    };
    if (probs && !noul) pair.probs = probs;
    return pair;
  });
}
