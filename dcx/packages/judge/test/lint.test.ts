import type { QuestionDef } from "@dcx/core";
import { describe, expect, it } from "vitest";
import { assertLintClean, type LintRuleId, lintModelPins, lintQuestion } from "../src/lint.js";
import { parseQuestion } from "../src/registry.js";
import { crit1, onTopic, QUESTIONS, studyType } from "./helpers/fakes.js";

const edit = (q: QuestionDef, patch: Record<string, unknown>) =>
  parseQuestion({ ...q, questionHash: undefined, ...patch });
const rules = (q: QuestionDef) => new Set(lintQuestion(q).map((i) => i.rule));

describe("lint", () => {
  it("passes the clean fixtures", () => {
    for (const q of QUESTIONS) expect(lintQuestion(q)).toEqual([]);
    expect(() => assertLintClean(QUESTIONS)).not.toThrow();
  });

  // One failing fixture per rule.
  const failing: Array<[LintRuleId, QuestionDef]> = [
    ["no-match-option", edit(crit1, { noMatchLabel: null })],
    [
      "options-described",
      edit(studyType, {
        options: [
          { label: "rct", description: "rct" },
          { label: "both", description: "Both a trial and a review." },
          { label: "other", description: "Anything else." },
        ],
      }),
    ],
    [
      "one-judgment",
      edit(crit1, {
        instructions:
          "Does `untrusted_record.abstract` report adults and does it report a placebo arm?",
      }),
    ],
    [
      "no-arithmetic",
      edit(crit1, {
        instructions: "How many patients does `untrusted_record.abstract` report?",
      }),
    ],
    [
      "no-arithmetic",
      edit(crit1, {
        instructions: "Was the study in `untrusted_record` published before 2015?",
      }),
    ],
    [
      "literal-reader",
      edit(crit1, { instructions: "Does it mention statins, fibrates, etc.?" }),
    ],
    [
      "length-caps",
      edit(crit1, {
        instructions: `Does \`untrusted_record.abstract\` state ${"x".repeat(700)}?`,
      }),
    ],
    ["fields-declared", edit(onTopic, { fields: [] })],
    ["model-pinned", edit(onTopic, { owner: "model jev-latest" })],
  ];
  it.each(failing)("rule %s fails its fixture", (rule, q) => {
    expect(rules(q)).toContain(rule);
    expect(() => assertLintClean([q])).toThrow(rule);
  });

  it("flags integer-like choice labels and bad noul options", () => {
    const q = edit(crit1, {
      options: [
        { label: "1", description: "one thing" },
        { label: "other", description: "anything else" },
      ],
    });
    expect(lintQuestion(q).some((i) => i.message.includes("integer-like"))).toBe(true);
    const n = edit(onTopic, { options: [{ label: "yes", description: "a yes answer" }] });
    expect(rules(n)).toContain("options-described");
  });

  it("allows a reasoned no-match waiver and per-call waivers", () => {
    expect(
      rules(
        edit(crit1, { noMatchLabel: null, noMatchWaiver: "labels are exhaustive by code" }),
      ),
    ).not.toContain("no-match-option");
    const q = edit(crit1, { fields: [] });
    expect(lintQuestion(q, { waive: { "fields-declared": "test" } })).toEqual([]);
  });

  it("rejects jev-latest anywhere a model is named in raw config", () => {
    expect(lintModelPins({ judge: { pin: "jev-latest" } })).toHaveLength(1);
    expect(lintModelPins({ backends: [{ model: "claude:latest" }] })).toHaveLength(1);
    expect(lintModelPins({ judge: { pin: "jev-1.13.0" }, note: "latest results" })).toEqual([]);
  });
});
