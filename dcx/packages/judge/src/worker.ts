// The judge worker (07 §3 item 5, §4.4; 01 §3.2). One async batch worker over a SQL work list:
// `asks` ANTI JOIN `judgments` on the full cache key (with the pin as model_v), grouped by
// payload hash so one state fans out to all its questions in one request; a 429-aware rate
// limiter; a budget pre-flight that refuses (never truncates); a model-drift flag; and a flush
// buffer that writes `judge_calls` + `judgments` in one transaction, ON CONFLICT DO NOTHING.
// A second drain makes zero requests. `askLive` is the kernel's micro-batch path.

import { randomUUID } from "node:crypto";
import {
  assertPinned,
  type Backend,
  type CacheKeyColumns,
  type CostBasis,
  cacheKey,
  type Json,
  type JudgeCallRow,
  type JudgeUseRow,
  type JudgmentRow,
  jsonHash,
  LIVE_STATUSES,
  type Mode,
  type PackMode,
  type PriceRow,
  project,
  type QuestionDef,
  type RawAnswer,
  type RawDecision,
  type SqlValue,
  type Warehouse,
} from "@dcx/core";
import { defaultSleep } from "./backends/systemone.js";
import { BudgetExceededError, JudgeError, RateLimitedError } from "./errors.js";
import { Budget, callCost, loadPrices, priceFor, tokenCost } from "./meter.js";
import { readQuestions, setQuestionStatus } from "./registry.js";
import { modelVFor } from "./types.js";

type Row = Record<string, SqlValue>;
const asRows = <T>(rows: readonly T[]) => rows as unknown as Row[];

// ---------------------------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------------------------

/** Spaces request starts at 60 000 / rpm ms and pauses everyone after a 429 (Retry-After, else
 *  exponential backoff from 1 s to 60 s, reset on success). */
export class RateLimiter {
  private next = 0;
  private pausedUntil = 0;
  private backoffMs = 0;
  constructor(
    private readonly rpm: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly backoff = { initialMs: 1_000, maxMs: 60_000 },
  ) {}

  async acquire(): Promise<void> {
    for (;;) {
      const t = this.now();
      const at = Math.max(this.next, this.pausedUntil);
      if (t >= at) {
        this.next = t + (Number.isFinite(this.rpm) && this.rpm > 0 ? 60_000 / this.rpm : 0);
        return;
      }
      await this.sleep(at - t);
    }
  }

  /** Record a 429; returns the pause applied. */
  on429(retryAfterMs?: number): number {
    this.backoffMs = this.backoffMs
      ? Math.min(this.backoffMs * 2, this.backoff.maxMs)
      : this.backoff.initialMs;
    const wait = retryAfterMs ?? this.backoffMs;
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    return wait;
  }

  onSuccess(): void {
    this.backoffMs = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Flush buffer
// ---------------------------------------------------------------------------------------------

/** Buffers call and judgment rows; each flush is one transaction (calls, then judgments with
 *  ON CONFLICT DO NOTHING). Flushes are serialised. */
export class FlushBuffer {
  private calls: JudgeCallRow[] = [];
  private judgments: JudgmentRow[] = [];
  private chain: Promise<void> = Promise.resolve();
  written = 0;
  constructor(
    private readonly wh: Warehouse,
    private readonly every = 1_000,
  ) {}

  add(call: JudgeCallRow, judgments: readonly JudgmentRow[]): Promise<void> {
    this.calls.push(call);
    this.judgments.push(...judgments);
    return this.judgments.length >= this.every ? this.flush() : Promise.resolve();
  }

  flush(): Promise<void> {
    const calls = this.calls.splice(0);
    const js = this.judgments.splice(0);
    if (calls.length === 0 && js.length === 0) return this.chain;
    this.chain = this.chain.then(() =>
      this.wh.transaction(async (tx) => {
        if (calls.length) await tx.appendRows("judge_calls", asRows(calls));
        if (js.length)
          this.written += await tx.appendRows("judgments", asRows(js), {
            onConflict: "ignore",
          });
      }),
    );
    return this.chain;
  }
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

export function callRow(
  raw: RawDecision | null,
  p: {
    backend: string;
    pin: string;
    modelV: string;
    nQuestions: number;
    cost: { costUsd: number | null; basis: CostBasis };
    attempts?: number;
    status?: string;
  },
): JudgeCallRow {
  return {
    call_id: randomUUID(),
    backend: p.backend,
    model_req: p.pin,
    model_v: raw?.modelVersion ?? p.modelV,
    request_id: raw?.requestId ?? null,
    n_questions: p.nQuestions,
    input_tokens: raw?.usage.inputTokens ?? null,
    output_tokens: raw?.usage.outputTokens ?? null,
    cost_usd: p.cost.costUsd,
    cost_basis: p.cost.basis,
    latency_ms: raw ? Math.round(raw.latencyMs) : null,
    attempts: p.attempts ?? (raw ? raw.retries + 1 : 1),
    status: p.status ?? "ok",
    degraded: raw ? raw.modelVersion !== p.modelV || Boolean(raw.degraded) : false,
  };
}

/** Cost of a failed call is unknown (null); billed attempts still show in `attempts`. */
const ERROR_COST = { costUsd: null, basis: "token-price" } as const;

export function judgmentRow(
  key: CacheKeyColumns,
  q: Pick<QuestionDef, "id" | "version" | "qtype">,
  a: RawAnswer,
  callId: string,
): JudgmentRow {
  return {
    ...key,
    question_id: q.id,
    question_v: q.version,
    qtype: q.qtype,
    answer: a.answer,
    p_answer: a.pAnswer,
    score: a.score ?? null,
    backend_confidence: a.backendConfidence ?? null,
    probs: a.probs,
    call_id: callId,
  };
}

function checkAnswers(raw: RawDecision, qs: readonly QuestionDef[]): void {
  if (
    raw.answers.length !== qs.length ||
    raw.answers.some((a, i) => a.questionHash !== qs[i]?.questionHash)
  ) {
    throw new JudgeError("protocol", "backend answers do not match the questions asked", false);
  }
}

// ---------------------------------------------------------------------------------------------
// Projections and the work list
// ---------------------------------------------------------------------------------------------

/** Fill missing or stale `projections` rows for every live question (JCS + sha256 in TS).
 *  Returns rows written. */
export async function refreshProjections(wh: Warehouse): Promise<number> {
  await wh.run(
    `DELETE FROM projections WHERE EXISTS (SELECT 1 FROM records r
       WHERE r.record_id = projections.record_id AND r.state_hash <> projections.state_hash)`,
  );
  const rows = await wh.all<{
    record_id: string;
    fields_key: string;
    state_hash: string;
    state: string;
  }>(
    `SELECT DISTINCT a.record_id, a.fields_key, a.state_hash, r.state::VARCHAR AS state
     FROM asks a JOIN records r ON r.record_id = a.record_id
     WHERE a.payload_hash IS NULL`,
  );
  if (rows.length === 0) return 0;
  const out = rows.map((r) => {
    const payload = project(JSON.parse(r.state) as Json, JSON.parse(r.fields_key) as string[]);
    return {
      record_id: r.record_id,
      fields_key: r.fields_key,
      state_hash: r.state_hash,
      payload_hash: jsonHash(payload),
      payload,
    };
  });
  return wh.appendRows("projections", asRows(out), { onConflict: "ignore" });
}

/** The miss list: `asks` ANTI JOIN `judgments` on the seven key columns, backend = $1 and
 *  model_v = $2 (the pin, as model_v). */
export const WORKLIST_SQL = `
SELECT DISTINCT a.payload_hash, a.payload::VARCHAR AS payload, a.question_hash
FROM asks a
ANTI JOIN judgments j
  ON j.payload_hash = a.payload_hash AND j.question_hash = a.question_hash
 AND j.candidate_set_hash = a.candidate_set_hash AND j.pack_mode = a.pack_mode
 AND j.sample_no = a.sample_no AND j.backend = $1 AND j.model_v = $2
WHERE a.payload_hash IS NOT NULL
ORDER BY a.payload_hash, a.question_hash`;

export interface WorkGroup {
  payloadHash: string;
  payload: Json;
  questions: QuestionDef[];
}

/** Build the work list, grouped by payload hash (one state per request). */
export async function worklist(
  wh: Warehouse,
  backend: string,
  modelV: string,
  defs: readonly QuestionDef[],
): Promise<WorkGroup[]> {
  const byHash = new Map(defs.map((d) => [d.questionHash, d]));
  const rows = await wh.all<{ payload_hash: string; payload: string; question_hash: string }>(
    WORKLIST_SQL,
    [backend, modelV],
  );
  const groups = new Map<string, WorkGroup>();
  for (const r of rows) {
    const q = byHash.get(r.question_hash);
    if (!q) continue;
    let g = groups.get(r.payload_hash);
    if (!g) {
      g = {
        payloadHash: r.payload_hash,
        payload: JSON.parse(r.payload) as Json,
        questions: [],
      };
      groups.set(r.payload_hash, g);
    }
    if (!g.questions.some((x) => x.questionHash === q.questionHash)) g.questions.push(q);
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------------------------------------
// drain
// ---------------------------------------------------------------------------------------------

export interface DrainOpts {
  /** The pinned model to request (e.g. `jev-1.13.0`). */
  pin: string;
  /** Question defs to ask (default: every live question in the warehouse). */
  questions?: readonly QuestionDef[];
  concurrency?: number;
  rpm?: number;
  /** Cap on this drain's spend; a call that would exceed it is refused and dispatch stops. */
  budgetUsd?: number;
  budget?: Budget;
  prices?: readonly PriceRow[];
  timeoutMs?: number;
  maxRetries?: number;
  flushEvery?: number;
  /** Stop after this many requests. */
  maxRequests?: number;
  /** Demote the questions of a drifted call (default true). */
  demoteOnDrift?: boolean;
  max429Requeues?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DrainStats {
  groups: number;
  requests: number;
  judgments: number;
  projections: number;
  retries: number;
  rateLimited: number;
  costUsd: number;
  refused: Array<{
    payloadHash: string;
    questionHashes: string[];
    reason: "state_too_large" | "budget" | "caps";
  }>;
  errors: Array<{ payloadHash: string; code: string; message: string }>;
  drift: Array<{ pin: string; returned: string; questionHashes: string[] }>;
}

export async function drain(wh: Warehouse, be: Backend, o: DrainOpts): Promise<DrainStats> {
  const pinV = modelVFor(be, o.pin);
  assertPinned(pinV);
  const stats: DrainStats = {
    groups: 0,
    requests: 0,
    judgments: 0,
    projections: 0,
    retries: 0,
    rateLimited: 0,
    costUsd: 0,
    refused: [],
    errors: [],
    drift: [],
  };
  const prices = o.prices ?? (await loadPrices(wh));
  const price = priceFor(prices, be.name, pinV);
  if (o.budgetUsd !== undefined && !price) {
    throw new Error(`no price for ${be.name}/${pinV}: cannot enforce a budget`);
  }
  const budget = o.budget ?? new Budget(o.budgetUsd);
  const defs = o.questions ?? (await readQuestions(wh, LIVE_STATUSES));
  stats.projections = await refreshProjections(wh);
  const queue = await worklist(wh, be.name, pinV, defs);
  stats.groups = queue.length;
  const caps = be.caps();
  const limiter = new RateLimiter(o.rpm ?? 600, o.now, o.sleep);
  const buf = new FlushBuffer(wh, o.flushEvery ?? 1_000);
  const requeues = new Map<string, number>();
  const demote = new Set<string>();
  let stop = false;
  let dispatched = 0;

  const handle = async (g: WorkGroup) => {
    const tokens = be.countTokens(g.payload);
    const ok: QuestionDef[] = [];
    for (const q of g.questions) {
      if (!caps.primitives.has(q.qtype) || q.options.length > caps.maxOptions) {
        stats.refused.push({
          payloadHash: g.payloadHash,
          questionHashes: [q.questionHash],
          reason: "caps",
        });
      } else if (tokens > Math.min(q.maxStateTokens, caps.maxStateTokens)) {
        stats.refused.push({
          payloadHash: g.payloadHash,
          questionHashes: [q.questionHash],
          reason: "state_too_large",
        });
      } else ok.push(q);
    }
    for (let i = 0; i < ok.length; i += caps.maxQuestions) {
      const chunk = ok.slice(i, i + caps.maxQuestions);
      if (stop || (o.maxRequests !== undefined && dispatched >= o.maxRequests)) return;
      let reservation: number;
      try {
        reservation = budget.preflight(price ? tokenCost(tokens, 0, price) : 0);
      } catch (e) {
        if (!(e instanceof BudgetExceededError)) throw e;
        stats.refused.push({
          payloadHash: g.payloadHash,
          questionHashes: ok.slice(i).map((q) => q.questionHash),
          reason: "budget",
        });
        stop = true;
        return;
      }
      dispatched++;
      await limiter.acquire();
      let raw: RawDecision;
      try {
        raw = await be.ask(g.payload, chunk, {
          timeoutMs: o.timeoutMs ?? 10_000,
          maxRetries: o.maxRetries ?? 2,
          model: o.pin,
        });
        checkAnswers(raw, chunk);
      } catch (e) {
        if (
          e instanceof RateLimitedError &&
          (requeues.get(g.payloadHash) ?? 0) < (o.max429Requeues ?? 5)
        ) {
          budget.commit(reservation, 0);
          dispatched--;
          stats.rateLimited++;
          limiter.on429(e.retryAfterMs);
          requeues.set(g.payloadHash, (requeues.get(g.payloadHash) ?? 0) + 1);
          queue.push({ ...g, questions: ok.slice(i) });
          return;
        }
        if (!(e instanceof JudgeError)) throw e;
        budget.commit(reservation, null);
        stats.errors.push({ payloadHash: g.payloadHash, code: e.code, message: e.message });
        await buf.add(
          callRow(null, {
            backend: be.name,
            pin: o.pin,
            modelV: pinV,
            nQuestions: chunk.length,
            cost: ERROR_COST,
            attempts: e.attempts,
            status: "error",
          }),
          [],
        );
        continue;
      }
      limiter.onSuccess();
      stats.requests++;
      stats.retries += raw.retries;
      const cost = callCost(raw, prices);
      budget.commit(reservation, cost.costUsd);
      stats.costUsd += cost.costUsd ?? 0;
      const call = callRow(raw, {
        backend: be.name,
        pin: o.pin,
        modelV: pinV,
        nQuestions: chunk.length,
        cost,
      });
      if (call.degraded) {
        stop = true;
        stats.drift.push({
          pin: pinV,
          returned: raw.modelVersion,
          questionHashes: chunk.map((q) => q.questionHash),
        });
        for (const q of chunk) demote.add(q.questionHash);
      }
      const js = chunk.map((q, k) =>
        judgmentRow(
          cacheKey({
            payloadHash: g.payloadHash,
            questionHash: q.questionHash,
            backend: be.name,
            modelV: raw.modelVersion,
          }),
          q,
          raw.answers[k] as RawAnswer,
          call.call_id,
        ),
      );
      await buf.add(call, js);
    }
  };

  const worker = async () => {
    while (!stop) {
      const g = queue.shift();
      if (!g) return;
      await handle(g);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 4) }, worker));
  await buf.flush();
  stats.judgments = buf.written;
  if (o.demoteOnDrift ?? true) {
    for (const h of demote) await setQuestionStatus(wh, { questionHash: h }, "demoted");
  }
  return stats;
}

// ---------------------------------------------------------------------------------------------
// askLive: the kernel's micro-batch path
// ---------------------------------------------------------------------------------------------

export interface LiveAsk {
  runId: string;
  stepNo: number;
  mode: Mode;
  recordId?: string | null;
  /** The full state; each question's `fields` projection is applied here. */
  state: Json;
  /** Questions with runtime options already bound. */
  questions: readonly QuestionDef[];
  /** questionHash → candidateSetHash for runtime-options questions. */
  candidateSetHashes?: Readonly<Record<string, string>>;
}

export interface LiveOpts {
  pin: string;
  /** Real-time defaults (02 §3.7): no retries, 1.5 s timeout. */
  timeoutMs?: number;
  maxRetries?: number;
  packMode?: PackMode;
  budget?: Budget;
  prices?: readonly PriceRow[];
  /** false → return the judge_uses rows for the caller's outbox instead of writing them. */
  writeUses?: boolean;
  demoteOnDrift?: boolean;
}

export interface LiveAnswer {
  question: QuestionDef;
  key: CacheKeyColumns;
  /** null when the judge failed (decide() then applies on_error). */
  answer: RawAnswer | null;
  cacheHit: boolean;
  degraded: boolean;
  modelVersion: string;
  error?: JudgeError;
}

export interface LiveResult {
  results: LiveAnswer[][];
  uses: JudgeUseRow[];
  calls: JudgeCallRow[];
}

const k3 = (ph: string, qh: string, cs: string) => `${ph}|${qh}|${cs}`;

export async function askLive(
  wh: Warehouse,
  be: Backend,
  asks: readonly LiveAsk[],
  o: LiveOpts,
): Promise<LiveResult> {
  const pinV = modelVFor(be, o.pin);
  const packMode = o.packMode ?? "single";
  const planned = asks.map((a) =>
    a.questions.map((q) => {
      const payload = project(a.state, q.fields);
      const key = cacheKey({
        payloadHash: jsonHash(payload),
        questionHash: q.questionHash,
        candidateSetHash: a.candidateSetHashes?.[q.questionHash] ?? "",
        backend: be.name,
        modelV: pinV,
        packMode,
      });
      return { q, payload, key };
    }),
  );
  const phs = [...new Set(planned.flat().map((p) => p.key.payload_hash))];
  const cached = new Map<string, RawAnswer>();
  if (phs.length > 0) {
    const rows = await wh.all<Record<string, unknown>>(
      `SELECT payload_hash, question_hash, candidate_set_hash, qtype, answer, p_answer::DOUBLE AS p_answer,
              score::DOUBLE AS score, backend_confidence::DOUBLE AS backend_confidence,
              to_json(probs)::VARCHAR AS probs
       FROM judgments WHERE backend = $1 AND model_v = $2 AND pack_mode = $3 AND sample_no = 0
         AND payload_hash IN (${phs.map((_, i) => `$${i + 4}`).join(", ")})`,
      [be.name, pinV, packMode, ...phs],
    );
    for (const r of rows) {
      const a: RawAnswer = {
        questionHash: String(r.question_hash),
        qtype: r.qtype as RawAnswer["qtype"],
        answer: String(r.answer),
        probs: r.probs ? (JSON.parse(String(r.probs)) as Record<string, number>) : {},
        pAnswer: Number(r.p_answer),
        score: r.score === null ? null : Number(r.score),
        backendConfidence: r.backend_confidence === null ? null : Number(r.backend_confidence),
      };
      cached.set(k3(String(r.payload_hash), a.questionHash, String(r.candidate_set_hash)), a);
    }
  }

  const results: LiveAnswer[][] = planned.map((items) =>
    items.map(({ q, key }) => {
      const hit = cached.get(k3(key.payload_hash, key.question_hash, key.candidate_set_hash));
      return {
        question: q,
        key,
        answer: hit ?? null,
        cacheHit: Boolean(hit),
        degraded: false,
        modelVersion: pinV,
      };
    }),
  );

  const calls: JudgeCallRow[] = [];
  const judgments: JudgmentRow[] = [];
  const prices = o.prices ?? [];
  const demote = new Set<string>();
  await Promise.all(
    asks.map(async (a, ai) => {
      const misses = new Map<string, number[]>();
      (results[ai] as LiveAnswer[]).forEach((r, qi) => {
        if (r.cacheHit) return;
        const list = misses.get(r.key.payload_hash) ?? [];
        list.push(qi);
        misses.set(r.key.payload_hash, list);
      });
      for (const idx of misses.values()) {
        const items = idx.map((qi) => (results[ai] as LiveAnswer[])[qi] as LiveAnswer);
        const qs = items.map((r) => r.question);
        const payload = (planned[ai] as { payload: Json }[])[idx[0] as number]?.payload as Json;
        let reservation = 0;
        try {
          if (o.budget) {
            const price = priceFor(prices, be.name, pinV);
            reservation = o.budget.preflight(
              price ? tokenCost(be.countTokens(payload), 0, price) : 0,
            );
          }
          const raw = await be.ask(payload, qs, {
            timeoutMs: o.timeoutMs ?? 1_500,
            maxRetries: o.maxRetries ?? 0,
            model: o.pin,
            packMode,
            ...(a.candidateSetHashes ? { candidateSetHashes: a.candidateSetHashes } : {}),
          });
          checkAnswers(raw, qs);
          const cost = callCost(raw, prices);
          o.budget?.commit(reservation, cost.costUsd);
          const call = callRow(raw, {
            backend: be.name,
            pin: o.pin,
            modelV: pinV,
            nQuestions: qs.length,
            cost,
          });
          calls.push(call);
          items.forEach((r, k) => {
            r.answer = raw.answers[k] as RawAnswer;
            r.modelVersion = raw.modelVersion;
            r.degraded = Boolean(call.degraded);
            r.key = { ...r.key, model_v: raw.modelVersion };
            if (r.degraded) demote.add(r.question.questionHash);
            judgments.push(judgmentRow(r.key, r.question, r.answer, call.call_id));
          });
        } catch (e) {
          if (!(e instanceof JudgeError)) throw e;
          if (o.budget && !(e instanceof BudgetExceededError))
            o.budget.commit(reservation, null);
          for (const r of items) r.error = e;
          if (!(e instanceof BudgetExceededError)) {
            calls.push(
              callRow(null, {
                backend: be.name,
                pin: o.pin,
                modelV: pinV,
                nQuestions: qs.length,
                cost: ERROR_COST,
                attempts: e.attempts,
                status: "error",
              }),
            );
          }
        }
      }
    }),
  );

  const uses: JudgeUseRow[] = asks.flatMap((a, ai) =>
    (results[ai] as LiveAnswer[]).map((r) => ({
      run_id: a.runId,
      step_no: a.stepNo,
      record_id: a.recordId ?? null,
      question_hash: r.key.question_hash,
      payload_hash: r.key.payload_hash,
      candidate_set_hash: r.key.candidate_set_hash,
      backend: r.key.backend,
      model_v: r.key.model_v,
      pack_mode: r.key.pack_mode,
      mode: a.mode,
      cache_hit: r.cacheHit,
    })),
  );
  await wh.transaction(async (tx) => {
    if (calls.length) await tx.appendRows("judge_calls", asRows(calls));
    if (judgments.length)
      await tx.appendRows("judgments", asRows(judgments), { onConflict: "ignore" });
    if (o.writeUses ?? true)
      await tx.appendRows("judge_uses", asRows(uses), { onConflict: "ignore" });
  });
  if (o.demoteOnDrift ?? true) {
    for (const h of demote) await setQuestionStatus(wh, { questionHash: h }, "demoted");
  }
  return { results, uses, calls };
}
