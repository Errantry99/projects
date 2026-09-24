// Recorded-fixture builders for the hello-world demo (07 §4.8, §6 "PR tier: fixture"). The
// synthetic review has no real Jev or LLM responses, so plausible ones are generated from each
// record's synthetic truth, deterministically (a PRNG seeded by record and question):
//   - judge: one FixtureEntry (packages/judge/src/backends/fixture.ts) per record × question,
//     keyed by the full cache key; model_v jev-1.13.0; two-decimal probabilities, about half
//     of the clear answers exactly 1.0 (as Jev returns); ~12% of records carry an ambiguous
//     question with p in 0.5–0.8, a third of those answered wrongly; 0.5% clear-case errors.
//   - llm: one screening response per record for screen.baseline@1, keyed by record id, in the
//     kernel LlmClient's `Omit<LlmRes, "callId">` shape.
// See dcx/fixtures/README.md for the file formats.

import {
  type CacheKeyColumns,
  cacheKey,
  cacheKeyId,
  type LlmRes,
  payloadHash,
  type QuestionDef,
  type RawAnswer,
  type RawDecision,
  type RecordRow,
  sha256Hex,
} from "@dcx/core";
import { mulberry32, type SynergyRecord, synergyRows } from "@dcx/importers";
import { SCREEN_TEMPLATE, type ScreenAnswer } from "../workflows/baseline.js";
import { questionRefOf } from "./questions.js";

export const FIXTURE_MODEL_V = "jev-1.13.0";
export const FIXTURE_BACKEND = "fixture";
export const FIXTURE_RECORDED_AT = "2026-09-24T00:00:00.000Z";
/** Jev list price used for the fixture usage (doc 08 §4: $0.042 per million input tokens). */
const JEV_USD_PER_INPUT_TOKEN = 0.042e-6;

/** A judge fixture entry: the judge package's FixtureEntry plus provenance for humans. */
export interface JudgeFixtureEntry {
  keyId: string;
  key: CacheKeyColumns;
  answer: RawAnswer;
  modelVersion: string;
  usage: RawDecision["usage"];
  requestId: string;
  recordedAt: string;
  recordId: string;
  questionRef: string;
  synthetic: true;
}

export interface LlmFixture {
  recordId: string;
  request: {
    template_id: string;
    template_v: number;
    template_text_sha256: string;
    model: string;
  };
  response: Omit<LlmRes<{ answer: ScreenAnswer }>, "callId">;
  synthetic: true;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function rngFor(...parts: string[]): () => number {
  return mulberry32(
    Number.parseInt(sha256Hex(`dcx-fixture:${parts.join(":")}`).slice(0, 8), 16),
  );
}

const RUNNER_UP: Record<string, string> = {
  meets: "not_stated",
  not_stated: "meets",
  fails: "not_stated",
  true: "false",
  false: "true",
  randomised_trial: "observational_study",
  observational_study: "randomised_trial",
  systematic_review_or_meta_analysis: "narrative_review",
  narrative_review: "systematic_review_or_meta_analysis",
  commentary_or_editorial: "narrative_review",
};

/** A plausible answer distribution for `truth`. */
export function fixtureAnswer(
  q: QuestionDef,
  truth: string,
  ambiguous: boolean,
  r: () => number,
): RawAnswer {
  const labels = q.qtype === "noul" ? ["true", "false"] : q.options.map((o) => o.label);
  const runnerUp = RUNNER_UP[truth] ?? (q.noMatchLabel as string);
  let answer = truth;
  let pTop: number;
  if (ambiguous) {
    pTop = 0.5 + r() * 0.3;
    if (r() < 1 / 3) answer = runnerUp;
  } else if (r() < 0.005) {
    answer = runnerUp;
    pTop = 0.55 + r() * 0.25;
  } else {
    pTop = r() < 0.5 ? 1 : 0.86 + r() * 0.13;
  }
  pTop = round2(pTop);
  const second = answer === truth ? runnerUp : truth;
  const others = labels.filter((l) => l !== answer && l !== second);
  const probs: Record<string, number> = {};
  const rest = 1 - pTop;
  probs[second] = round2(others.length ? rest * 0.75 : rest);
  for (const l of others) probs[l] = round2((rest - (probs[second] ?? 0)) / others.length);
  const sumOthers = Object.values(probs).reduce((s, x) => s + x, 0);
  probs[answer] = round2(1 - sumOthers);
  const ordered = Object.fromEntries(labels.map((l) => [l, probs[l] ?? 0]));
  if (q.qtype === "noul") {
    const pTrue = ordered.true ?? 0;
    return {
      questionHash: q.questionHash,
      qtype: "noul",
      answer: pTrue >= 0.5 ? "true" : "false",
      probs: ordered,
      pAnswer: pTrue,
      backendConfidence: null,
    };
  }
  return {
    questionHash: q.questionHash,
    qtype: q.qtype,
    answer,
    probs: ordered,
    pAnswer: ordered[answer] ?? 0,
    backendConfidence: ordered[answer] ?? 0,
  };
}

/** Rough request size: projected state chars / 4 plus ~60 tokens per question. */
function requestTokens(state: unknown, nQuestions: number): number {
  return Math.ceil(JSON.stringify(state).length / 4) + 60 * nQuestions;
}

/** Judge fixture entries for one record (one per question, same request). */
export function judgeFixturesFor(
  rec: RecordRow,
  src: SynergyRecord,
  qs: readonly QuestionDef[],
  opts: { backend?: string; modelV?: string } = {},
): JudgeFixtureEntry[] {
  const truth = src.synthetic?.truth;
  if (!truth) throw new Error(`${rec.record_id}: no synthetic truth to derive fixtures from`);
  const inputTokens = requestTokens(rec.state, qs.length);
  const usage: RawDecision["usage"] = {
    inputTokens,
    outputTokens: 0,
    costUsd: Number((inputTokens * JEV_USD_PER_INPUT_TOKEN).toPrecision(6)),
    basis: "token-price",
  };
  return qs.map((q) => {
    const t = truth[q.id];
    if (t === undefined) throw new Error(`${rec.record_id}: no truth for ${q.id}`);
    const key = cacheKey({
      payloadHash: payloadHash(rec.state, q.fields),
      questionHash: q.questionHash,
      backend: opts.backend ?? FIXTURE_BACKEND,
      modelV: opts.modelV ?? FIXTURE_MODEL_V,
    });
    const answer = fixtureAnswer(
      q,
      t,
      src.synthetic?.ambiguous.includes(q.id) ?? false,
      rngFor(key.payload_hash, q.id), // identical payloads get identical answers, as a cache would
    );
    return {
      keyId: cacheKeyId(key),
      key,
      answer,
      modelVersion: opts.modelV ?? FIXTURE_MODEL_V,
      usage,
      requestId: `fx-${key.payload_hash.slice(0, 16)}`,
      recordedAt: FIXTURE_RECORDED_AT,
      recordId: rec.record_id,
      questionRef: questionRefOf(q),
      synthetic: true,
    };
  });
}

/** How a frontier baseline plausibly screens each category (include, flag; rest exclude). */
const BASELINE_RATES: Record<string, [number, number]> = {
  include: [0.84, 0.06],
  off_topic_exercise: [0.02, 0.02],
  off_topic_other_tx_depression: [0.02, 0.03],
  off_topic_other: [0.005, 0.01],
  fails_population: [0.08, 0.08],
  fails_condition: [0.06, 0.08],
  fails_intervention: [0.1, 0.1],
  fails_design: [0.06, 0.06],
  review: [0.1, 0.05],
  design_not_stated: [0.25, 0.25],
};

/** The baseline LLM's recorded screening response for one record. */
export function llmFixtureFor(rec: RecordRow, src: SynergyRecord, model: string): LlmFixture {
  const r = rngFor("llm", rec.record_id);
  const cat = src.synthetic?.category ?? "include";
  let [pInc, pFlag] = BASELINE_RATES[cat] ?? [0.1, 0.1];
  // Some injected instructions work on the all-LLM arm (doc 08 §2 adversarial state).
  if (src.synthetic?.truth["screen.injection"] === "true") [pInc, pFlag] = [0.3, 0.2];
  const u = r();
  const answer: ScreenAnswer = u < pInc ? "include" : u < pInc + pFlag ? "flag" : "exclude";
  const text = JSON.stringify({ answer });
  const promptChars =
    SCREEN_TEMPLATE.text.length + src.title.length + src.abstract.length + 400;
  const inputTokens = Math.ceil(promptChars / 4) + 900; // system prompt and criteria framing
  const outputTokens = 120 + Math.floor(r() * 180); // reasoning summary + JSON
  return {
    recordId: rec.record_id,
    request: {
      template_id: SCREEN_TEMPLATE.id,
      template_v: SCREEN_TEMPLATE.version,
      template_text_sha256: sha256Hex(SCREEN_TEMPLATE.text),
      model,
    },
    response: {
      value: { answer },
      text,
      outputKind: "structured",
      normalisedAnswer: answer,
      modelReturned: model,
      usage: { inputTokens, outputTokens },
      // Illustrative frontier price: $2/M input, $10/M output (05 §3.5, unverified).
      costUsd: Number(((inputTokens * 2 + outputTokens * 10) / 1e6).toPrecision(6)),
      costBasis: "token-price",
      latencyMs: 2200 + Math.floor(r() * 1800),
      retries: 0,
    },
    synthetic: true,
  };
}

/** dcx/fixtures/ */
export const FIXTURES_ROOT = new URL("../../../fixtures/", import.meta.url);

export interface DemoFixtures {
  records: RecordRow[];
  sources: SynergyRecord[];
  judge: Map<string, JudgeFixtureEntry[]>;
  llm: LlmFixture[];
  manifest: Record<string, unknown>;
}

/** Everything the demo replays, from the synthetic review JSONL and the question files. */
export function buildDemoFixtures(
  review: string,
  sources: readonly SynergyRecord[],
  qs: readonly QuestionDef[],
  opts: { model: string; backend?: string; modelV?: string },
): DemoFixtures {
  const rows = synergyRows(sources, { review, synthetic: true, seed: 7 });
  const judge = new Map<string, JudgeFixtureEntry[]>();
  const llm: LlmFixture[] = [];
  rows.records.forEach((rec, i) => {
    const src = sources[i] as SynergyRecord;
    judge.set(rec.record_id, judgeFixturesFor(rec, src, qs, opts));
    llm.push(llmFixtureFor(rec, src, opts.model));
  });
  const all = [...judge.values()].flat();
  return {
    records: rows.records,
    sources: [...sources],
    judge,
    llm,
    manifest: {
      synthetic: true,
      banner: "SYNTHETIC DATA",
      review,
      backend: opts.backend ?? FIXTURE_BACKEND,
      model_v: opts.modelV ?? FIXTURE_MODEL_V,
      records: rows.records.length,
      entries: all.length,
      questions: qs.map((q) => ({ ref: questionRefOf(q), question_hash: q.questionHash })),
      ambiguous_records: [...judge.values()].filter((es) =>
        es.some((e) => Math.max(...Object.values(e.answer.probs)) <= 0.8),
      ).length,
      llm_template: `${SCREEN_TEMPLATE.id}@${SCREEN_TEMPLATE.version}`,
      llm_model: opts.model,
      generator: "projects/evidence-screener/src/fixtures.ts",
    },
  };
}
