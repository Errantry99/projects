import { readdirSync, readFileSync } from "node:fs";
import type { QuestionDef } from "@dcx/core";
import { SYNTHETIC_REVIEW } from "@dcx/importers";
import { lintModelPins, lintQuestion, loadQuestionFiles } from "@dcx/judge";
import { describe, expect, it } from "vitest";
import {
  CRITERIA,
  QUESTION_REFS,
  QUESTIONS,
  QUESTIONS_DIR,
  toQuestionDef,
  validateQuestionDef,
} from "../src/index.js";

const FIELDS = ["untrusted_record.title", "untrusted_record.abstract"];
const files = readdirSync(QUESTIONS_DIR).filter((f) => f.endsWith(".json"));

describe("question files", () => {
  it.each(files)("%s has the QuestionDef shape", (f) => {
    const raw = JSON.parse(readFileSync(new URL(f, QUESTIONS_DIR), "utf8"));
    expect(validateQuestionDef(raw)).toEqual([]);
    const def: QuestionDef = toQuestionDef(raw, f);
    expect(def.questionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(def.fields).toEqual(FIELDS);
    expect(def.maxStateTokens).toBeGreaterThan(0);
    expect(def.optionsSource).toBe("static");
    expect(def.instructions).toContain("`untrusted_record`");
  });

  it("covers doc 08's hello-world set in order", () => {
    expect(QUESTION_REFS).toEqual([
      "screen.on_topic@1",
      "screen.crit_1@1",
      "screen.crit_2@1",
      "screen.crit_3@1",
      "screen.crit_4@1",
      "screen.study_type@1",
      "screen.injection@1",
    ]);
  });

  it("uses meets / fails / not_stated / other for every criterion, from criteria.json", () => {
    for (const c of CRITERIA.criteria) {
      const q = QUESTIONS.find((x) => x.id === `screen.${c.id}`);
      expect(q?.qtype).toBe("choice");
      expect(q?.options.map((o) => o.label)).toEqual(["meets", "fails", "not_stated", "other"]);
      expect(q?.noMatchLabel).toBe("other");
      expect(q?.instructions).toBe(
        `Does the \`untrusted_record\` state that it meets this criterion: ${c.text}?`,
      );
    }
    const onTopic = QUESTIONS.find((x) => x.id === "screen.on_topic");
    expect(onTopic?.qtype).toBe("noul");
    expect(onTopic?.instructions).toContain(CRITERIA.topic);
    const st = QUESTIONS.find((x) => x.id === "screen.study_type");
    expect(st?.options.map((o) => o.label)).toContain("other");
    expect(st?.noMatchLabel).toBe("other");
    expect(QUESTIONS.find((x) => x.id === "screen.injection")?.qtype).toBe("noul");
  });

  it("passes the judge lint (02 §3.3) and hashes identically in the judge registry", () => {
    for (const q of QUESTIONS) expect(lintQuestion(q)).toEqual([]);
    const theirs = loadQuestionFiles(QUESTIONS_DIR.pathname);
    expect(new Map(theirs.map((q) => [q.id, q.questionHash]))).toEqual(
      new Map(QUESTIONS.map((q) => [q.id, q.questionHash])),
    );
  });

  it("rejects malformed definitions with clear messages", () => {
    expect(validateQuestionDef({ id: "x", qtype: "pick" })).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^qtype/),
        expect.stringMatching(/^fields/),
      ]),
    );
    const raw = JSON.parse(readFileSync(new URL("crit_1.json", QUESTIONS_DIR), "utf8"));
    expect(() => toQuestionDef({ ...raw, questionHash: "0".repeat(64) })).toThrow(
      /does not match/,
    );
    expect(() => toQuestionDef({ ...raw, surprise: 1 })).toThrow(/unknown keys: surprise/);
  });
});

describe("criteria.json", () => {
  it("matches the synthetic review's stated protocol and pins its model", () => {
    expect(CRITERIA.review).toBe(SYNTHETIC_REVIEW.review);
    expect(CRITERIA.topic).toBe(SYNTHETIC_REVIEW.topic);
    expect(CRITERIA.criteria).toEqual(SYNTHETIC_REVIEW.criteria);
    expect(CRITERIA.inclusion_rule).toBe(SYNTHETIC_REVIEW.inclusion_rule);
    expect(CRITERIA.synthetic).toBe(true);
    expect(CRITERIA.policy.exclude_min_p).toBe(0.99);
    expect(CRITERIA.policy.audit_rate).toBe(0.05);
    expect(lintModelPins(CRITERIA)).toEqual([]);
  });
});
