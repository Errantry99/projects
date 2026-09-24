// Fixture backend: replays recorded answers keyed by the FULL cache key (`cacheKeyId`), so a
// change to any key component misses and the test fails loudly (07 §6). `record` mode calls
// another backend and writes one `<cacheKeyId>.json` per answer.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AskOpts,
  type Backend,
  type BackendCaps,
  type CacheKeyColumns,
  cacheKey,
  cacheKeyId,
  type Json,
  payloadHash,
  type QuestionDef,
  type RawAnswer,
  type RawDecision,
} from "@dcx/core";
import { FixtureMissError } from "../errors.js";
import { type JudgeBackend, modelVFor } from "../types.js";
import { estimateTokens } from "./systemone.js";

/** One recorded answer (a fixture file holds one entry or an array of them). */
export interface FixtureEntry {
  keyId: string;
  key: CacheKeyColumns;
  answer: RawAnswer;
  /** The model version the recorded call actually returned (may differ from key.model_v:
   *  that is how a drift fixture is written). */
  modelVersion: string;
  usage?: RawDecision["usage"];
  requestId?: string | null;
  recordedAt?: string;
}

export interface FixtureBackendOpts {
  /** Directory of `*.json` fixture files. */
  dir: string;
  /** Cache-key backend name (default `fixture`); set `jev` to replay Jev recordings as Jev. */
  name?: string;
  /** Model used when AskOpts.model is absent. */
  model?: string;
  mode?: "replay" | "record";
  /** Required in record mode: the backend whose answers are recorded. */
  inner?: Backend;
  caps?: Partial<BackendCaps>;
}

export const FIXTURE_CAPS: BackendCaps = {
  primitives: new Set(["choice", "score", "noul"]),
  maxOptions: 255,
  maxQuestions: 64,
  maxStateTokens: 32_000,
  isolatesQuestions: true,
  dataResidency: "local",
};

/** Read every fixture entry under `dir` (missing dir → empty). */
export function readFixtures(dir: string): Map<string, FixtureEntry> {
  const out = new Map<string, FixtureEntry>();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of files.sort()) {
    const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as
      | FixtureEntry
      | FixtureEntry[];
    for (const e of Array.isArray(parsed) ? parsed : [parsed]) out.set(e.keyId, e);
  }
  return out;
}

/** The cache key the fixture backend looks up for (state, q, opts). */
export function fixtureKey(
  name: string,
  state: Json,
  q: QuestionDef,
  modelV: string,
  o: Pick<AskOpts, "candidateSetHashes" | "packMode" | "sampleNo">,
): CacheKeyColumns {
  return cacheKey({
    payloadHash: payloadHash(state, q.fields),
    questionHash: q.questionHash,
    candidateSetHash: o.candidateSetHashes?.[q.questionHash] ?? "",
    backend: name,
    modelV,
    packMode: o.packMode ?? "single",
    sampleNo: o.sampleNo ?? 0,
  });
}

export function fixtureBackend(o: FixtureBackendOpts): JudgeBackend & { entries(): number } {
  const name = o.name ?? "fixture";
  const mode = o.mode ?? "replay";
  if (mode === "record" && !o.inner)
    throw new Error("fixture record mode needs an inner backend");
  const caps: BackendCaps = { ...(o.inner?.caps() ?? FIXTURE_CAPS), ...o.caps };
  const store = readFixtures(o.dir);

  return {
    name,
    caps: () => caps,
    countTokens: (state: Json) => o.inner?.countTokens(state) ?? estimateTokens(state),
    modelVFor: (pin: string) => (o.inner ? modelVFor(o.inner, pin) : pin),
    entries: () => store.size,
    async ask(state, qs, opts): Promise<RawDecision> {
      const pin = opts.model ?? o.model;
      if (!pin) throw new Error("fixture backend needs a model (AskOpts.model or opts.model)");
      const modelV = o.inner ? modelVFor(o.inner, pin) : pin;
      const keys = qs.map((q) => fixtureKey(name, state, q, modelV, opts));
      if (mode === "record") {
        const raw = await (o.inner as Backend).ask(state, qs, opts);
        mkdirSync(o.dir, { recursive: true });
        raw.answers.forEach((answer, i) => {
          const key = keys[i] as CacheKeyColumns;
          const entry: FixtureEntry = {
            keyId: cacheKeyId(key),
            key,
            answer,
            modelVersion: raw.modelVersion,
            usage: raw.usage,
            requestId: raw.requestId ?? null,
            recordedAt: new Date().toISOString(),
          };
          store.set(entry.keyId, entry);
          writeFileSync(
            join(o.dir, `${entry.keyId}.json`),
            `${JSON.stringify(entry, null, 2)}\n`,
          );
        });
        return raw;
      }
      const hits = keys.map((key) => {
        const id = cacheKeyId(key);
        const e = store.get(id);
        if (!e) throw new FixtureMissError(key, id);
        return e;
      });
      const returned = hits[0]?.modelVersion ?? modelV;
      // Replays the recorded call's usage (so metering matches the recording); none → zero.
      const usage: RawDecision["usage"] = hits[0]?.usage ?? { basis: "zero" };
      return {
        backend: name,
        modelVersion: returned,
        modelRequested: pin,
        requestId: hits[0]?.requestId ?? null,
        answers: hits.map((e) => e.answer),
        usage,
        latencyMs: 0,
        retries: 0,
        cacheHit: false,
        degraded: returned !== modelV,
      };
    },
  };
}
