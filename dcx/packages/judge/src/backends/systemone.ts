// The Jev wire format (`POST /v1/systemone`), shared by the jev (SDK) and wire (fetch)
// backends: request building, response mapping to RawAnswer, the retry loop and the token
// estimate. Shape verified against @typesafe-ai/sdk 0.6.0 `dist/index.d.mts`:
//   request  {model, state, questions: {<name>: {type:"choice", instructions, criteria:{label: desc}}
//                                              | {type:"score", instructions, criteria:[desc0, desc1, ...]}
//                                              | {type:"noul", instructions, criteria?:{true, false}|null}}}
//   response {model, answers: {<name>: {type:"choice", choice, confidence, probabilities:{label:p}}
//                                     | {type:"score", score, confidence, legend, probabilities:{"0":p,...}}
//                                     | {type:"noul", noul}}, usage: {input_tokens, output_tokens}}
// Question names are neutral (`q0`, `q1`, ...) and never carry meaning (02 §2.1 fact 2).

import {
  assertPinned,
  type CostBasis,
  canonicalize,
  type Json,
  type QuestionDef,
  type RawAnswer,
  type RawDecision,
} from "@dcx/core";
import {
  AbortedError,
  BackendProtocolError,
  JudgeError,
  RateLimitedError,
  StateTooLargeError,
} from "../errors.js";
import { sumUsage, type Usage } from "../meter.js";

type Entry = Json;
export type WireQuestion =
  | { type: "choice"; instructions: Entry; criteria: Record<string, Entry> }
  | { type: "score"; instructions: Entry; criteria: Entry[] }
  | { type: "noul"; instructions: Entry; criteria: { true: Entry; false: Entry } | null };

export interface WireRequest {
  model: string;
  state: Json;
  questions: Record<string, WireQuestion>;
}

/** Integer-like labels would be reordered by JS object key order (02 §2.1 fact 1). */
export const INTEGER_LIKE = /^(0|[1-9]\d*)$/;

function toWireQuestion(q: QuestionDef): WireQuestion {
  if (q.qtype === "noul") {
    const t = q.options.find((o) => o.label === "true");
    const f = q.options.find((o) => o.label === "false");
    return {
      type: "noul",
      instructions: q.instructions,
      criteria: t && f ? { true: t.description, false: f.description } : null,
    };
  }
  if (q.options.length < 2) throw new BackendProtocolError(`${q.id}: needs ≥2 options`);
  if (q.qtype === "score") {
    return {
      type: "score",
      instructions: q.instructions,
      criteria: q.options.map((o) => o.description),
    };
  }
  const criteria: Record<string, Entry> = {};
  for (const o of q.options) {
    if (INTEGER_LIKE.test(o.label)) {
      throw new BackendProtocolError(
        `${q.id}: integer-like label "${o.label}" would be reordered`,
      );
    }
    criteria[o.label] = o.description;
  }
  return { type: "choice", instructions: q.instructions, criteria };
}

/** Build the request body. `keys[i]` is the wire name of `qs[i]`. */
export function buildRequest(
  state: Json,
  qs: readonly QuestionDef[],
  model: string,
): { body: WireRequest; keys: string[] } {
  if (qs.length === 0) throw new BackendProtocolError("at least one question is required");
  const keys = qs.map((_, i) => `q${i}`);
  const questions: Record<string, WireQuestion> = {};
  qs.forEach((q, i) => {
    questions[keys[i] as string] = toWireQuestion(q);
  });
  return { body: { model, state, questions }, keys };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new BackendProtocolError(`${what}: not a number`);
  return v;
};

function argmax(probs: Record<string, number>): string {
  let best = "";
  let bp = Number.NEGATIVE_INFINITY;
  for (const [k, p] of Object.entries(probs)) {
    if (p > bp) {
      best = k;
      bp = p;
    }
  }
  return best;
}

/** Map one wire answer to a RawAnswer (answer, per-label probs, P(answer) / P(true)). */
export function mapAnswer(q: QuestionDef, a: unknown): RawAnswer {
  if (!isObj(a) || a.type !== q.qtype) {
    throw new BackendProtocolError(`${q.id}: expected a ${q.qtype} answer`);
  }
  const base = { questionHash: q.questionHash, qtype: q.qtype };
  if (q.qtype === "noul") {
    const p = num(a.noul, `${q.id}.noul`);
    return {
      ...base,
      answer: p >= 0.5 ? "true" : "false",
      probs: { true: p, false: 1 - p },
      pAnswer: p,
    };
  }
  if (!isObj(a.probabilities)) throw new BackendProtocolError(`${q.id}: no probabilities`);
  const probs: Record<string, number> = {};
  const labels = q.options.map((o) => o.label);
  for (const [k, v] of Object.entries(a.probabilities)) {
    // Score probabilities are keyed by level index; map back to the level labels.
    const label = q.qtype === "score" ? labels[Number(k)] : k;
    if (label === undefined || !labels.includes(label)) {
      throw new BackendProtocolError(`${q.id}: unknown label "${k}"`);
    }
    probs[label] = num(v, `${q.id}.probabilities.${k}`);
  }
  const confidence = typeof a.confidence === "number" ? a.confidence : null;
  if (q.qtype === "choice") {
    const answer = String(a.choice);
    if (!labels.includes(answer))
      throw new BackendProtocolError(`${q.id}: unknown choice "${answer}"`);
    return {
      ...base,
      answer,
      probs,
      pAnswer: probs[answer] ?? confidence ?? 0,
      backendConfidence: confidence,
    };
  }
  const answer = argmax(probs);
  return {
    ...base,
    answer,
    probs,
    pAnswer: probs[answer] ?? 0,
    score: typeof a.score === "number" ? a.score : null,
    backendConfidence: confidence,
  };
}

/** Map a whole response body. Every asked question must be answered. */
export function mapResponse(
  data: unknown,
  qs: readonly QuestionDef[],
  keys: readonly string[],
): { model: string; answers: RawAnswer[]; usage: Usage } {
  if (!isObj(data) || typeof data.model !== "string" || !isObj(data.answers)) {
    throw new BackendProtocolError("response is missing model or answers");
  }
  const answers = data.answers;
  const out = qs.map((q, i) => {
    const k = keys[i] as string;
    if (!(k in answers)) throw new BackendProtocolError(`no answer for ${q.id} (${k})`);
    return mapAnswer(q, answers[k]);
  });
  const u = isObj(data.usage) ? data.usage : {};
  const usage: Usage = {};
  if (typeof u.input_tokens === "number") usage.inputTokens = u.input_tokens;
  if (typeof u.output_tokens === "number") usage.outputTokens = u.output_tokens;
  return { model: data.model, answers: out, usage };
}

/**
 * Token estimate for pre-flight (caps and budgets) when the backend exposes no tokenizer: the
 * SDK 0.6.0 reports usage only after a call. We use ⌈JCS length / 3⌉, deliberately above the
 * usual ~4 chars/token so a refusal errs on the safe side. Billing uses the returned usage.
 */
export function estimateTokens(state: Json): number {
  return Math.ceil(canonicalize(state).length / 3);
}

export interface RetryOpts {
  maxRetries: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
}

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Our own retry loop (the SDK's is disabled so every attempt is counted): retries retryable
 * JudgeErrors with exponential backoff, honouring Retry-After on 429. `billedRetries` counts
 * failed attempts that may have been billed (transient: timeouts and 5xx); a 429 is not billed.
 */
export async function withRetries<T>(
  fn: (attempt: number) => Promise<T>,
  o: RetryOpts,
): Promise<{ value: T; retries: number; billedRetries: number }> {
  const sleep = o.sleep ?? defaultSleep;
  let billed = 0;
  for (let attempt = 0; ; attempt++) {
    if (o.signal?.aborted) throw new AbortedError();
    try {
      return { value: await fn(attempt), retries: attempt, billedRetries: billed };
    } catch (e) {
      if (!(e instanceof JudgeError)) throw e;
      const err = e;
      err.attempts = attempt + 1;
      if (!err.retryable || attempt >= o.maxRetries) throw err;
      if (err.code === "transient") billed++;
      const backoff = Math.min(
        (o.backoffInitialMs ?? 500) * 2 ** attempt,
        o.backoffMaxMs ?? 5_000,
      );
      await sleep(
        err instanceof RateLimitedError && err.retryAfterMs ? err.retryAfterMs : backoff,
      );
    }
  }
}

/** Refuse a state over the backend cap (never truncate). Returns the estimate. */
export function checkStateCap(state: Json, maxStateTokens: number): number {
  const tokens = estimateTokens(state);
  if (tokens > maxStateTokens) {
    throw new StateTooLargeError(
      `state ~${tokens} tokens > ${maxStateTokens}`,
      tokens,
      maxStateTokens,
    );
  }
  return tokens;
}

/** Assemble the RawDecision both SystemOne backends return. Failed-but-billed attempts are
 *  assumed to have consumed the same tokens as the successful one (summed, 02 §3.8). */
export function toRawDecision(p: {
  backend: string;
  requested: string;
  mapped: ReturnType<typeof mapResponse>;
  modelVersion: string;
  requestId: string | null | undefined;
  retries: number;
  billedRetries: number;
  basis: CostBasis;
  latencyMs: number;
}): RawDecision {
  assertPinned(p.mapped.model);
  const billed = 1 + p.billedRetries;
  const usage: RawDecision["usage"] = { basis: p.basis };
  const u = sumUsage(Array.from({ length: billed }, () => p.mapped.usage));
  if (u.inputTokens !== undefined) usage.inputTokens = u.inputTokens;
  if (u.outputTokens !== undefined) usage.outputTokens = u.outputTokens;
  return {
    backend: p.backend,
    modelVersion: p.modelVersion,
    modelRequested: p.requested,
    requestId: p.requestId ?? null,
    answers: p.mapped.answers,
    usage,
    latencyMs: p.latencyMs,
    retries: p.retries,
    cacheHit: false,
    degraded: p.mapped.model !== p.requested,
  };
}
