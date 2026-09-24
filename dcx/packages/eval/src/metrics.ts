// Calibration and agreement metrics. 02 §3.5 (eval harness), 04 §3.6–3.7 (shadow statistics and
// sample sizes), 07 §6 (calibration tests). Pure functions over arrays; every random draw comes
// from a seeded generator so reports and tests are reproducible.

/** Seeded PRNG (mulberry32): returns a function yielding uniforms in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const at = <T>(xs: readonly T[], i: number): T => xs[i] as T;
const num = (b: boolean | number): number => (typeof b === "number" ? b : b ? 1 : 0);

function checkPairs(p: readonly number[], y: readonly (boolean | number)[]): void {
  if (p.length !== y.length) throw new Error(`length mismatch: ${p.length} vs ${y.length}`);
}

// ---------------------------------------------------------------------------------------------
// Reliability, ECE, Brier, NLL
// ---------------------------------------------------------------------------------------------

export type BinStrategy = "width" | "mass";
export interface BinOpts {
  /** Number of bins (default 5: 02 §3.5 "ECE with 5 bins at n≈200"). */
  bins?: number;
  /** `width`: equal-width on [0,1] (bin = min(⌊p·B⌋, B−1)); `mass`: equal-count after a stable
   *  sort by p (bin i holds sorted items ⌊i·n/B⌋ … ⌊(i+1)·n/B⌋−1). Default `width`. */
  strategy?: BinStrategy;
}

/** One reliability-diagram bin. `lo`/`hi` are the bin edges (width) or min/max p (mass). */
export interface ReliabilityBin {
  bin: number;
  lo: number;
  hi: number;
  n: number;
  /** Mean predicted probability. */
  conf: number;
  /** Observed frequency of y = 1. */
  acc: number;
}

/** Reliability bins (empty bins are omitted). */
export function reliabilityBins(
  p: readonly number[],
  y: readonly (boolean | number)[],
  opts: BinOpts = {},
): ReliabilityBin[] {
  checkPairs(p, y);
  const B = opts.bins ?? 5;
  const n = p.length;
  const assign = new Array<number>(n);
  if ((opts.strategy ?? "width") === "width") {
    for (let i = 0; i < n; i++) assign[i] = Math.min(Math.floor(at(p, i) * B), B - 1);
  } else {
    const order = p.map((_, i) => i).sort((a, b) => at(p, a) - at(p, b) || a - b);
    for (let b = 0; b < B; b++) {
      const end = Math.floor(((b + 1) * n) / B);
      for (let r = Math.floor((b * n) / B); r < end; r++) assign[at(order, r)] = b;
    }
  }
  const acc = Array.from({ length: B }, (_, b) => ({ b, n: 0, s: 0, c: 0, lo: 1, hi: 0 }));
  for (let i = 0; i < n; i++) {
    const a = at(acc, at(assign, i));
    const pi = at(p, i);
    a.n++;
    a.s += pi;
    a.c += num(at(y, i));
    a.lo = Math.min(a.lo, pi);
    a.hi = Math.max(a.hi, pi);
  }
  const width = (opts.strategy ?? "width") === "width";
  return acc
    .filter((a) => a.n > 0)
    .map((a) => ({
      bin: a.b,
      lo: width ? a.b / B : a.lo,
      hi: width ? (a.b + 1) / B : a.hi,
      n: a.n,
      conf: a.s / a.n,
      acc: a.c / a.n,
    }));
}

/** Expected calibration error: Σ_b (n_b / n)·|acc_b − conf_b|. */
export function ece(
  p: readonly number[],
  y: readonly (boolean | number)[],
  opts: BinOpts = {},
) {
  const n = p.length;
  if (n === 0) return 0;
  return reliabilityBins(p, y, opts).reduce(
    (s, b) => s + (b.n / n) * Math.abs(b.acc - b.conf),
    0,
  );
}

/** Brier score: mean (p − y)². */
export function brier(p: readonly number[], y: readonly (boolean | number)[]): number {
  checkPairs(p, y);
  if (p.length === 0) return 0;
  return p.reduce((s, pi, i) => s + (pi - num(at(y, i))) ** 2, 0) / p.length;
}

/** Mean negative log-likelihood, with p clamped to [1e-6, 1 − 1e-6]. */
export function nll(p: readonly number[], y: readonly (boolean | number)[]): number {
  checkPairs(p, y);
  if (p.length === 0) return 0;
  const c = (x: number) => Math.min(1 - 1e-6, Math.max(1e-6, x));
  return (
    -p.reduce((s, pi, i) => s + (num(at(y, i)) ? Math.log(c(pi)) : Math.log(1 - c(pi))), 0) /
    p.length
  );
}

// ---------------------------------------------------------------------------------------------
// ECE noise floor (02 §3.5, 04 §3.6)
// ---------------------------------------------------------------------------------------------

export interface FloorOpts extends BinOpts {
  /** Simulations (default 2,000, as in 04 §3.6). */
  sims?: number;
  /** PRNG seed (default 1). */
  seed?: number;
}
export interface NoiseFloor {
  /** Mean simulated ECE of a perfectly calibrated model: the floor. */
  mean: number;
  /** 95th percentile of the simulated ECE. */
  p95: number;
  sims: number;
  n: number;
}

function summarise(xs: number[], n: number): NoiseFloor {
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
  return {
    mean,
    p95: at(s, Math.min(s.length - 1, Math.floor(0.95 * s.length))),
    sims: xs.length,
    n,
  };
}

/**
 * The ECE noise floor for the observed predictions: labels are redrawn from Bernoulli(p̂)
 * `sims` times, so the model is perfectly calibrated by construction, and the ECE of each draw
 * is recorded. An observed ECE is only meaningful next to this floor (gate G5: ≤ 2× floor).
 */
export function eceNoiseFloor(p: readonly number[], opts: FloorOpts = {}): NoiseFloor {
  const rnd = mulberry32(opts.seed ?? 1);
  const sims = opts.sims ?? 2000;
  const out: number[] = [];
  const y = new Array<number>(p.length);
  for (let s = 0; s < sims; s++) {
    for (let i = 0; i < p.length; i++) y[i] = rnd() < at(p, i) ? 1 : 0;
    out.push(ece(p, y, opts));
  }
  return summarise(out, p.length);
}

/**
 * The reference setting behind 04 §3.6's floor table ("perfectly calibrated, high-skewed
 * model"): p̂ ~ Beta(6, 1) (mean 0.857, drawn as U^(1/6)), y ~ Bernoulli(p̂), 5 equal-width bins,
 * 2,000 simulations, both p̂ and y redrawn per simulation. It gives ≈0.058 at n=60, 0.032 at 200,
 * 0.023 at 400 and 0.019 at 600, matching the table (0.057 / 0.032 / 0.022 / 0.019).
 */
export const REFERENCE_FLOOR_SETTING = { alpha: 6, beta: 1, bins: 5, sims: 2000 } as const;

export function referenceEceFloor(n: number, opts: FloorOpts = {}): NoiseFloor {
  const rnd = mulberry32(opts.seed ?? 1);
  const sims = opts.sims ?? REFERENCE_FLOOR_SETTING.sims;
  const bins = opts.bins ?? REFERENCE_FLOOR_SETTING.bins;
  const out: number[] = [];
  const p = new Array<number>(n);
  const y = new Array<number>(n);
  for (let s = 0; s < sims; s++) {
    for (let i = 0; i < n; i++) {
      const q = rnd() ** (1 / REFERENCE_FLOOR_SETTING.alpha);
      p[i] = q;
      y[i] = rnd() < q ? 1 : 0;
    }
    out.push(ece(p, y, { bins, strategy: opts.strategy ?? "width" }));
  }
  return summarise(out, n);
}

// ---------------------------------------------------------------------------------------------
// Intervals and sample sizes (04 §3.7)
// ---------------------------------------------------------------------------------------------

export interface Interval {
  value: number;
  lo: number;
  hi: number;
}

/** Wilson score interval for k successes in n trials (z = 1.96 → 95% two-sided). n = 0 gives
 *  the vacuous interval [0, 1]. */
export function wilson(k: number, n: number, z = 1.96): Interval {
  if (n <= 0) return { value: Number.NaN, lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d;
  const m = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return { value: p, lo: Math.max(0, c - m), hi: Math.min(1, c + m) };
}

/** Smallest n at which an observed rate `pObs` has a Wilson lower bound ≥ `target` (04 §3.7:
 *  ≈260 covered rows at 97.5% and ≈415 at 97% for a 95% bar). Infinity if pObs ≤ target. */
export function nForWilsonLower(pObs: number, target: number, z = 1.96, max = 1e6): number {
  if (pObs <= target) return Number.POSITIVE_INFINITY;
  for (let n = 1; n <= max; n++) if (wilson(pObs * n, n, z).lo >= target) return n;
  return Number.POSITIVE_INFINITY;
}

/** Rows with zero failures needed so that precision ≥ `target` with one-sided confidence
 *  1 − delta (exact binomial, target^n ≤ delta): 598 at 99.5%, 299 at 99%, 149 at 98%. */
export function zeroFailureN(target: number, delta = 0.05): number {
  return Math.ceil(Math.log(delta) / Math.log(target) - 1e-12);
}

/** Clopper–Pearson one-sided lower bound on precision after n successes and zero failures. */
export function zeroFailureLower(n: number, delta = 0.05): number {
  return n <= 0 ? 0 : delta ** (1 / n);
}

// ---------------------------------------------------------------------------------------------
// Agreement (04 §3.6 parity and ceiling)
// ---------------------------------------------------------------------------------------------

/** Raw agreement of two label arrays. */
export function agreement(a: readonly string[], b: readonly string[]): number {
  if (a.length !== b.length) throw new Error("length mismatch");
  if (a.length === 0) return Number.NaN;
  return a.reduce((s, x, i) => s + (x === b[i] ? 1 : 0), 0) / a.length;
}

/** Confusion counts: table[rowLabel][colLabel]. */
export function confusion(
  a: readonly string[],
  b: readonly string[],
): Record<string, Record<string, number>> {
  const t: Record<string, Record<string, number>> = {};
  a.forEach((x, i) => {
    const row = t[x] ?? {};
    t[x] = row;
    const yb = at(b, i);
    row[yb] = (row[yb] ?? 0) + 1;
  });
  return t;
}

export interface Kappa {
  kappa: number;
  po: number;
  pe: number;
  n: number;
}

/** Cohen's κ = (p_o − p_e) / (1 − p_e). When p_e = 1 (both raters use one label) κ is 1 if they
 *  agree everywhere, else 0. */
export function cohensKappa(a: readonly string[], b: readonly string[]): Kappa {
  if (a.length !== b.length) throw new Error("length mismatch");
  const n = a.length;
  if (n === 0) return { kappa: Number.NaN, po: Number.NaN, pe: Number.NaN, n };
  const ma = new Map<string, number>();
  const mb = new Map<string, number>();
  let agree = 0;
  a.forEach((x, i) => {
    const yb = at(b, i);
    if (x === yb) agree++;
    ma.set(x, (ma.get(x) ?? 0) + 1);
    mb.set(yb, (mb.get(yb) ?? 0) + 1);
  });
  const po = agree / n;
  let pe = 0;
  for (const [k, c] of ma) pe += (c / n) * ((mb.get(k) ?? 0) / n);
  const kappa = pe >= 1 ? (po >= 1 ? 1 : 0) : (po - pe) / (1 - pe);
  return { kappa, po, pe, n };
}

/** Large-sample 95% half-width of κ: z·√(p_o(1−p_o)/n)/(1−p_e). 04 §3.7: n=200, p_o 0.92,
 *  p_e 0.5 → ±0.075. */
export function kappaHalfWidth(po: number, pe: number, n: number, z = 1.96): number {
  return (z * Math.sqrt((po * (1 - po)) / n)) / (1 - pe);
}

// ---------------------------------------------------------------------------------------------
// Bootstrap CIs (percentile, record-level resampling)
// ---------------------------------------------------------------------------------------------

export interface BootOpts {
  /** Resamples (default 2,000). */
  B?: number;
  /** PRNG seed (default 7). */
  seed?: number;
  /** Two-sided level: 0.05 → 95% (default). */
  alpha?: number;
}

/** Percentile bootstrap CI of `stat` over records. Resamples whose stat is NaN are dropped. */
export function bootstrapCI<T>(
  data: readonly T[],
  stat: (xs: readonly T[]) => number,
  opts: BootOpts = {},
): Interval {
  const value = stat(data);
  const n = data.length;
  if (n === 0) return { value, lo: Number.NaN, hi: Number.NaN };
  const rnd = mulberry32(opts.seed ?? 7);
  const B = opts.B ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const out: number[] = [];
  const buf = new Array<T>(n);
  for (let b = 0; b < B; b++) {
    for (let i = 0; i < n; i++) buf[i] = at(data, Math.floor(rnd() * n));
    const s = stat(buf);
    if (!Number.isNaN(s)) out.push(s);
  }
  out.sort((x, y) => x - y);
  const q = (f: number) =>
    at(out, Math.min(out.length - 1, Math.max(0, Math.floor(f * out.length))));
  return { value, lo: q(alpha / 2), hi: q(1 - alpha / 2) };
}

/** One prediction against its truth for recall / precision on a positive class. */
export interface PredTruth {
  pred: boolean;
  truth: boolean;
}
export const recallOf = (xs: readonly PredTruth[]): number => {
  const pos = xs.filter((x) => x.truth);
  return pos.length ? pos.filter((x) => x.pred).length / pos.length : Number.NaN;
};
export const precisionOf = (xs: readonly PredTruth[]): number => {
  const pp = xs.filter((x) => x.pred);
  return pp.length ? pp.filter((x) => x.truth).length / pp.length : Number.NaN;
};
export const recallCI = (xs: readonly PredTruth[], o: BootOpts = {}) =>
  bootstrapCI(xs, recallOf, o);
export const precisionCI = (xs: readonly PredTruth[], o: BootOpts = {}) =>
  bootstrapCI(xs, precisionOf, o);

// ---------------------------------------------------------------------------------------------
// Selective prediction (02 §3.5 risk–coverage)
// ---------------------------------------------------------------------------------------------

export interface RiskCoveragePoint {
  /** Accept everything with confidence ≥ threshold. */
  threshold: number;
  n: number;
  coverage: number;
  /** 1 − selective accuracy. */
  risk: number;
  selectiveAccuracy: number;
}

/** Risk–coverage curve: one point per distinct confidence, from the most confident down. */
export function riskCoverage(
  conf: readonly number[],
  correct: readonly (boolean | number)[],
): RiskCoveragePoint[] {
  checkPairs(conf, correct);
  const order = conf.map((_, i) => i).sort((a, b) => at(conf, b) - at(conf, a) || a - b);
  const pts: RiskCoveragePoint[] = [];
  let ok = 0;
  order.forEach((idx, r) => {
    ok += num(at(correct, idx));
    const next = order[r + 1];
    if (next !== undefined && at(conf, next) === at(conf, idx)) return; // keep ties together
    const k = r + 1;
    pts.push({
      threshold: at(conf, idx),
      n: k,
      coverage: k / conf.length,
      risk: 1 - ok / k,
      selectiveAccuracy: ok / k,
    });
  });
  return pts;
}

/** Selective accuracy at a target coverage: the first curve point whose coverage ≥ target
 *  (ties at the cut are kept together, so the achieved coverage can exceed the target). */
export function selectiveAccuracyAt(
  conf: readonly number[],
  correct: readonly (boolean | number)[],
  coverage: number,
): RiskCoveragePoint | null {
  return riskCoverage(conf, correct).find((pt) => pt.coverage >= coverage - 1e-12) ?? null;
}

/** Median (p50) of a numeric array; NaN when empty. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? at(s, m) : (at(s, m - 1) + at(s, m)) / 2;
}
