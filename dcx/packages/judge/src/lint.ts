// Question lint (02 §3.3), run in Vitest and at registration. Every rule is a pure function
// returning issues; `lintQuestion` runs them all. Heuristics are deliberately simple and
// conservative: a false alarm costs a rewording, a missed compound question costs accuracy.

import { isUnpinnedModel, parseFieldPath, type QuestionDef } from "@dcx/core";
import { INTEGER_LIKE } from "./backends/systemone.js";

export type LintRuleId =
  | "no-match-option"
  | "options-described"
  | "one-judgment"
  | "no-arithmetic"
  | "literal-reader"
  | "length-caps"
  | "fields-declared"
  | "model-pinned";

export interface LintIssue {
  rule: LintRuleId;
  message: string;
  /** Question ref, when known. */
  ref?: string;
}

export interface LintOpts {
  maxInstructionChars?: number;
  minInstructionChars?: number;
  maxDescriptionChars?: number;
  maxOptions?: number;
  /** Rules waived for this call, each with a reason (kept for the audit trail). */
  waive?: Partial<Record<LintRuleId, string>>;
}

export const NO_MATCH_LABELS = ["other", "not_stated", "insufficient", "none", "unknown"];

const DEFAULTS = {
  maxInstructionChars: 600,
  minInstructionChars: 12,
  maxDescriptionChars: 400,
  maxOptions: 255,
};

/** Instruction text with `backticked` paths and "quoted" spans removed, lower-cased. */
function prose(s: string): string {
  return s
    .replace(/`[^`]*`/g, " PATH ")
    .replace(/"[^"]*"|“[^”]*”/g, " QUOTE ")
    .toLowerCase();
}
const descText = (d: unknown) =>
  typeof d === "string" ? d : d == null ? "" : JSON.stringify(d);
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

type Rule = (q: QuestionDef, o: Required<Omit<LintOpts, "waive">>) => string[];

/** 1. Choice needs an explicit no-match option (unless waived with a reason). */
export const noMatchOption: Rule = (q) => {
  if (q.qtype !== "choice" || q.noMatchWaiver?.trim()) return [];
  if (!q.noMatchLabel) return ["choice question has no noMatchLabel (e.g. other / not_stated)"];
  if (q.optionsSource === "static" && !q.options.some((o) => o.label === q.noMatchLabel)) {
    return [`noMatchLabel "${q.noMatchLabel}" is not among the options`];
  }
  return [];
};

/** 2. Options: shape by qtype, unique non-integer labels, distinguishing descriptions, and
 *  mutually exclusive by wording (no "both", "all of the above", "and/or" options). */
export const optionsDescribed: Rule = (q, o) => {
  const out: string[] = [];
  const labels = q.options.map((x) => x.label);
  if (q.qtype === "noul") {
    if (
      q.options.length > 0 &&
      (q.options.length !== 2 || !labels.includes("true") || !labels.includes("false"))
    ) {
      out.push('noul options must be empty or exactly "true" and "false"');
    }
  } else if (q.optionsSource === "static" && q.options.length < 2) {
    out.push(`${q.qtype} needs at least 2 options`);
  }
  if (q.options.length > o.maxOptions)
    out.push(`${q.options.length} options > ${o.maxOptions}`);
  if (new Set(labels.map(norm)).size !== labels.length)
    out.push("option labels are not unique");
  if (q.qtype === "choice") {
    for (const l of labels)
      if (INTEGER_LIKE.test(l)) out.push(`integer-like label "${l}" would be reordered`);
  }
  const descs = q.options.map((x) => norm(descText(x.description)));
  q.options.forEach((x, i) => {
    const d = descs[i] ?? "";
    if (!d) out.push(`option "${x.label}" has no description`);
    else if (d === norm(x.label))
      out.push(`option "${x.label}" description only restates the label`);
    if (
      /\b(both|all of the above|any of the above|and or)\b/.test(d) ||
      /^(both|all|any)$/i.test(x.label)
    ) {
      out.push(`option "${x.label}" overlaps other options (not mutually exclusive)`);
    }
  });
  if (new Set(descs.filter(Boolean)).size !== descs.filter(Boolean).length) {
    out.push("two options share a description (not mutually exclusive)");
  }
  return out;
};

const PREDICATE_START =
  /\b(and|or)\s+(is|are|was|were|does|do|did|has|have|had|can|could|will|would|should|must|may|might|whether|if|also|then|it|they|asks?|mentions?|reports?|states?|contains?|describes?|includes?|claims?|requests?|uses?|shows?|provides?|meets?|fails?)\b/;

/** 3. One judgment per question: no and/or joining two predicates, no "either … or", one "?". */
export const oneJudgment: Rule = (q) => {
  const p = prose(q.instructions);
  const out: string[] = [];
  if (/\band\/or\b/.test(p) || /\band or\b/.test(p)) out.push('"and/or" asks two things');
  const m = PREDICATE_START.exec(p);
  if (m) out.push(`"${m[0]}" joins two predicates; split into two questions`);
  if (/\beither\b.*\bor\b/.test(p)) out.push('"either … or" asks two things');
  if ((p.match(/\?/g) ?? []).length > 1) out.push("more than one question mark");
  return out;
};

const ARITH = [
  /\bhow (many|much|long|old)\b/,
  /\b(count|number of|sum|total|average|mean|median|percent(age)?|ratio)\b/,
  /\b(more|fewer|less|greater|larger|smaller|older|newer|earlier|later) than\b/,
  /\b(at least|at most|exceeds?|over|under|within)\s+\d/,
  /\b(before|after|since|until|prior to)\s+(\d{4}|\d{1,2}[/-]\d{1,2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|the date)/,
  // "rank" only as an instruction to order things ("rank the options", "ranked by date"), so a
  // question that merely mentions ranking ("text telling the screener to rank it highly") passes.
  /\b(rank|ranks|ranked|ranking)\s+(the|these|those|them|all|each|every|by|of|in order|from)\b/,
  /\b(highest|lowest|compare|calculate|compute)\b/,
  /\d\s*[-+*/×÷]\s*\d/,
  /%/,
];

/** 3b. No counting, arithmetic, date ordering or ranking: those belong in code. */
export const noArithmetic: Rule = (q) => {
  const p = prose(q.instructions);
  const hit = ARITH.find((r) => r.test(p));
  return hit
    ? [`asks for counting, arithmetic, date ordering or ranking (${hit.source}); do it in code`]
    : [];
};

/** 4. Written for a literal reader: no "etc.", no unresolved pronouns, no persona, no request
 *  for a rationale, no dependence on the question id. */
export const literalReader: Rule = (q) => {
  const p = prose(q.instructions);
  const out: string[] = [];
  if (/\b(etc|and so on|and so forth|and more)\b|\.\.\.|…/.test(p))
    out.push('open-ended list ("etc.", "…")');
  if (/^\s*(it|they|this|that|these|those|he|she)\b/.test(p))
    out.push("starts with a pronoun that has no antecedent");
  if (
    /\b(it|its|they|them|their|he|she|him|her)\b/.test(p) &&
    !/`[^`]+`/.test(q.instructions)
  ) {
    out.push("pronoun with no state path (reference the state by `path`)");
  }
  if (/\b(you are|act as|as an? (expert|assistant|reviewer))\b/.test(p))
    out.push("persona text");
  if (/\b(explain|justify|why|reasoning|rationale)\b/.test(p))
    out.push("asks for a rationale (the backend returns none)");
  if (q.id && q.instructions.includes(q.id)) out.push("instruction depends on the question id");
  return out;
};

/** 5. Length caps on instructions and option descriptions. */
export const lengthCaps: Rule = (q, o) => {
  const out: string[] = [];
  const n = q.instructions.trim().length;
  if (n < o.minInstructionChars)
    out.push(`instruction is ${n} chars (< ${o.minInstructionChars})`);
  if (n > o.maxInstructionChars)
    out.push(`instruction is ${n} chars (> ${o.maxInstructionChars})`);
  for (const x of q.options) {
    const d = descText(x.description).length;
    if (d > o.maxDescriptionChars)
      out.push(`option "${x.label}" description is ${d} chars (> ${o.maxDescriptionChars})`);
  }
  return out;
};

/** 6. A field allow-list (the projection) and a token cap are declared. */
export const fieldsDeclared: Rule = (q) => {
  const out: string[] = [];
  if (q.fields.length === 0) out.push("no `fields` projection declared");
  for (const f of q.fields) {
    try {
      parseFieldPath(f);
      if (/[*[\]]/.test(f)) out.push(`field "${f}" uses a wildcard or index`);
    } catch (e) {
      out.push((e as Error).message);
    }
  }
  if (!(q.maxStateTokens > 0)) out.push("maxStateTokens must be positive");
  return out;
};

/** 7. `jev-latest` (any unpinned alias) is rejected anywhere a model is named. Works on the raw
 *  JSON (config, question file, workflow options), not only on a QuestionDef. */
export function lintModelPins(raw: unknown, path = "$"): string[] {
  const out: string[] = [];
  const visit = (v: unknown, p: string, key: string) => {
    if (typeof v === "string") {
      if (/\bjev-latest\b/i.test(v) || (/model|pin/i.test(key) && isUnpinnedModel(v))) {
        out.push(`${p}: unpinned model "${v}"; pin a version (e.g. jev-1.13.0)`);
      }
    } else if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) visit(x, `${p}[${i}]`, key);
    } else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) visit(x, `${p}.${k}`, k);
  };
  visit(raw, path, "");
  return out;
}

const RULES: Array<[LintRuleId, Rule]> = [
  ["no-match-option", noMatchOption],
  ["options-described", optionsDescribed],
  ["one-judgment", oneJudgment],
  ["no-arithmetic", noArithmetic],
  ["literal-reader", literalReader],
  ["length-caps", lengthCaps],
  ["fields-declared", fieldsDeclared],
  ["model-pinned", (q) => lintModelPins(q)],
];

/** Run every rule on one question. An empty result means it passes. */
export function lintQuestion(q: QuestionDef, opts: LintOpts = {}): LintIssue[] {
  const o = { ...DEFAULTS, ...opts };
  const ref = `${q.id}@${q.version}`;
  const out: LintIssue[] = [];
  for (const [rule, fn] of RULES) {
    if (opts.waive?.[rule]) continue;
    for (const message of fn(q, o)) out.push({ rule, message, ref });
  }
  return out;
}

/** Lint many; throws with every issue when any fails (registration gate). */
export function assertLintClean(qs: readonly QuestionDef[], opts: LintOpts = {}): void {
  const issues = qs.flatMap((q) => lintQuestion(q, opts));
  if (issues.length > 0) {
    throw new Error(
      `lint failed:\n${issues.map((i) => `  ${i.ref} [${i.rule}] ${i.message}`).join("\n")}`,
    );
  }
}
