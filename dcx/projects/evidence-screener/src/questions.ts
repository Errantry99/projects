// Loads the hand-written screening questions (doc 08 §2) from questions/*.json. A file is a
// QuestionDef without `questionHash`, which is computed here with core's questionHash (a file
// that carries one must match). `validateQuestionDef` checks the shape against QuestionDef.
import { readdirSync, readFileSync } from "node:fs";
import {
  LIFECYCLE_STATUSES,
  QTYPES,
  type QuestionDef,
  type QuestionRef,
  questionHash,
} from "@dcx/core";
import { PROJECT_ROOT } from "./criteria.js";

export const QUESTIONS_DIR = new URL("questions/", PROJECT_ROOT);
const DATA_CLASSES = ["public", "internal", "pii", "sensitive"];

/** Shape problems of a parsed question file against QuestionDef (empty when valid). */
export function validateQuestionDef(q: unknown): string[] {
  const e: string[] = [];
  if (typeof q !== "object" || q === null || Array.isArray(q)) return ["not an object"];
  const o = q as Record<string, unknown>;
  const str = (k: string) => typeof o[k] === "string" && (o[k] as string).length > 0;
  const nullableStr = (k: string) =>
    o[k] === undefined || o[k] === null || typeof o[k] === "string";
  if (!str("id")) e.push("id: non-empty string required");
  if (!Number.isInteger(o.version) || (o.version as number) < 1) e.push("version: integer ≥ 1");
  if (!QTYPES.includes(o.qtype as never)) e.push(`qtype: one of ${QTYPES.join(", ")}`);
  if (!str("instructions")) e.push("instructions: non-empty string required");
  if (!Array.isArray(o.options)) e.push("options: array required");
  else {
    o.options.forEach((opt, i) => {
      const op = opt as Record<string, unknown>;
      if (typeof op?.label !== "string" || op.label === "")
        e.push(`options[${i}].label: string`);
      if (op?.description === undefined) e.push(`options[${i}].description: required`);
      const extra = Object.keys(op ?? {}).filter((k) => k !== "label" && k !== "description");
      if (extra.length) e.push(`options[${i}]: unknown keys ${extra.join(", ")}`);
    });
    const labels = (o.options as Array<{ label?: unknown }>).map((x) => x.label);
    if (new Set(labels).size !== labels.length) e.push("options: labels must be unique");
    if (o.qtype === "noul" && labels.length && labels.join() !== "true,false") {
      e.push("options: a noul question has no options or exactly true, false");
    }
    if (o.qtype === "choice" && o.noMatchLabel && !labels.includes(o.noMatchLabel)) {
      e.push("noMatchLabel: must be one of the options");
    }
  }
  if (!nullableStr("noMatchLabel")) e.push("noMatchLabel: string or null");
  if (
    !Array.isArray(o.fields) ||
    o.fields.length === 0 ||
    o.fields.some((f) => typeof f !== "string")
  ) {
    e.push("fields: non-empty string array required");
  }
  if (o.optionsSource !== "static" && o.optionsSource !== "runtime")
    e.push("optionsSource: static | runtime");
  if (!Number.isInteger(o.maxStateTokens) || (o.maxStateTokens as number) <= 0) {
    e.push("maxStateTokens: positive integer required");
  }
  if (!DATA_CLASSES.includes(o.dataClass as string))
    e.push(`dataClass: one of ${DATA_CLASSES.join(", ")}`);
  if (typeof o.labelCompatible !== "boolean") e.push("labelCompatible: boolean required");
  if (!LIFECYCLE_STATUSES.includes(o.status as never)) e.push("status: a lifecycle status");
  for (const k of [
    "parentHash",
    "negationOf",
    "owner",
    "appliesTo",
    "noMatchWaiver",
    "createdAt",
  ]) {
    if (!nullableStr(k)) e.push(`${k}: string or null`);
  }
  if (o.questionHash !== undefined && typeof o.questionHash !== "string")
    e.push("questionHash: string");
  const known = new Set([
    "id",
    "version",
    "qtype",
    "instructions",
    "options",
    "noMatchLabel",
    "fields",
    "questionHash",
    "parentHash",
    "optionsSource",
    "noMatchWaiver",
    "maxStateTokens",
    "dataClass",
    "negationOf",
    "labelCompatible",
    "status",
    "owner",
    "appliesTo",
    "createdAt",
  ]);
  const extra = Object.keys(o).filter((k) => !known.has(k));
  if (extra.length) e.push(`unknown keys: ${extra.join(", ")}`);
  return e;
}

/** Parse one question file into a QuestionDef with its computed hash. */
export function toQuestionDef(raw: unknown, where = "question"): QuestionDef {
  const errs = validateQuestionDef(raw);
  if (errs.length) throw new Error(`${where}: ${errs.join("; ")}`);
  const q = raw as Omit<QuestionDef, "questionHash"> & { questionHash?: string };
  const h = questionHash(q);
  if (q.questionHash !== undefined && q.questionHash !== h) {
    throw new Error(`${where}: questionHash ${q.questionHash} does not match content (${h})`);
  }
  return { ...q, questionHash: h };
}

/** Display order: on_topic, crit_1..k, study_type, injection. */
const ORDER = (id: string) =>
  id.endsWith(".on_topic")
    ? "0"
    : id.includes(".crit_")
      ? `1${id}`
      : id.endsWith(".injection")
        ? "3"
        : `2${id}`;

export function loadQuestions(dir: URL = QUESTIONS_DIR): QuestionDef[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => toQuestionDef(JSON.parse(readFileSync(new URL(f, dir), "utf8")), f))
    .sort((a, b) => (ORDER(a.id) < ORDER(b.id) ? -1 : 1));
}

export function questionRefOf(q: Pick<QuestionDef, "id" | "version">): QuestionRef {
  return `${q.id}@${q.version}`;
}

export const QUESTIONS: readonly QuestionDef[] = loadQuestions();
/** Refs the compiled workflow's judge step asks, in QUESTIONS order. */
export const QUESTION_REFS: readonly QuestionRef[] = QUESTIONS.map(questionRefOf);
