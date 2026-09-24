// Test fakes: a clean question set and a deterministic in-memory "oracle" backend whose
// answers are recorded into fixtures by the fixture backend's record mode.

import {
  type Backend,
  hashUnit,
  jsonHash,
  type QuestionDef,
  type RawDecision,
} from "@dcx/core";
import { FIXTURE_CAPS } from "../../src/backends/fixture.js";
import { parseQuestion } from "../../src/registry.js";

export const FIELDS = ["untrusted_record.title", "untrusted_record.abstract"];

export const onTopic = parseQuestion({
  id: "screen.on_topic",
  version: 1,
  qtype: "noul",
  instructions: "The record in `untrusted_record` is mainly about statin therapy for adults.",
  options: [
    {
      label: "true",
      description: "The main subject of the record is statin therapy for adults.",
    },
    {
      label: "false",
      description: "Statin therapy is absent from the record, or only mentioned in passing.",
    },
  ],
  fields: FIELDS,
  maxStateTokens: 2000,
  status: "active",
});

export const crit1 = parseQuestion({
  id: "screen.crit_1",
  version: 1,
  qtype: "choice",
  instructions:
    "Does `untrusted_record.abstract` state that the study population is adults with high cholesterol?",
  options: [
    {
      label: "meets",
      description: "The record explicitly states the population is such adults.",
    },
    { label: "fails", description: "The record explicitly states a different population." },
    {
      label: "not_stated",
      description: "The record does not say which population was studied.",
    },
    { label: "other", description: "None of the listed situations applies to the record." },
  ],
  noMatchLabel: "other",
  fields: FIELDS,
  maxStateTokens: 2000,
  status: "active",
});

export const studyType = parseQuestion({
  id: "screen.study_type",
  version: 1,
  qtype: "choice",
  instructions: "Which study design does `untrusted_record.abstract` describe?",
  options: [
    { label: "rct", description: "A randomised controlled trial with a comparison arm." },
    { label: "observational", description: "A cohort, case-control or cross-sectional study." },
    { label: "review", description: "A systematic review or meta-analysis of other studies." },
    { label: "other", description: "A design not listed here, or no design is described." },
  ],
  noMatchLabel: "other",
  fields: ["untrusted_record.abstract"],
  maxStateTokens: 2000,
  status: "active",
});

export const QUESTIONS: QuestionDef[] = [onTopic, crit1, studyType];

/** Deterministic answers from hashUnit(payload, question). Counts calls. */
export function oracleBackend(
  o: { name?: string; returns?: string } = {},
): Backend & { calls: number } {
  const be = {
    name: o.name ?? "oracle",
    calls: 0,
    caps: () => FIXTURE_CAPS,
    countTokens: (s: unknown) => Math.ceil(JSON.stringify(s).length / 3),
    async ask(state, qs, opts): Promise<RawDecision> {
      be.calls++;
      const answers = qs.map((q) => {
        const u = hashUnit(`${jsonHash(state)}:${q.questionHash}`);
        if (q.qtype === "noul") {
          const p = Math.round(u * 100) / 100;
          return {
            questionHash: q.questionHash,
            qtype: q.qtype,
            answer: p >= 0.5 ? "true" : "false",
            probs: { true: p, false: 1 - p },
            pAnswer: p,
          };
        }
        const labels = q.options.map((x) => x.label);
        const pick = labels[Math.floor(u * labels.length)] as string;
        const probs = Object.fromEntries(
          labels.map((l) => [l, l === pick ? 0.7 : 0.3 / (labels.length - 1)]),
        );
        return {
          questionHash: q.questionHash,
          qtype: q.qtype,
          answer: pick,
          probs,
          pAnswer: 0.7,
          backendConfidence: 0.6,
        };
      });
      return {
        backend: be.name,
        modelVersion: o.returns ?? (opts.model as string),
        modelRequested: opts.model as string,
        requestId: `req-${be.calls}`,
        answers,
        usage: { inputTokens: 400, outputTokens: 0, basis: "token-price" },
        latencyMs: 5,
        retries: 0,
        cacheHit: false,
      };
    },
  } satisfies Backend & { calls: number };
  return be;
}

export function records(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const state = {
      untrusted_record: {
        title: `Statins and outcomes, study ${i % Math.ceil(n / 2)}`,
        abstract: `Abstract ${i % Math.ceil(n / 2)}: adults with high cholesterol were followed.`,
      },
      meta: { seq: i },
    };
    return {
      record_id: `r${i}`,
      kind: "paper",
      source: "test",
      state,
      state_hash: jsonHash(state),
    };
  });
}
