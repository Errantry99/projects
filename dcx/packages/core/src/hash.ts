// RFC 8785 JSON Canonicalization Scheme (JCS) plus the dcx content hashes. 07 §2 rows 4–5,
// 03 §3.3 and §3.8: hashes are computed in TS (never in SQL) so TS and Python hash identically.
// Golden vectors: test/hash.test.ts and dcx/conformance/jcs-vectors.json.

import { createHash } from "node:crypto";
import { assertPinned } from "./policy.js";
import type {
  CacheKeyColumns,
  Candidate,
  Json,
  JsonObject,
  PackMode,
  QuestionContent,
} from "./types.js";

/** Thrown for input JCS cannot represent (NaN, ±Infinity, lone surrogates, non-JSON values). */
export class CanonicalizationError extends Error {
  override name = "CanonicalizationError";
}

function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function serializeString(s: string): string {
  if (!isWellFormed(s)) throw new CanonicalizationError("string contains a lone surrogate");
  // ECMAScript JSON.stringify string escaping is exactly RFC 8785 §3.2.2.2.
  return JSON.stringify(s);
}

function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) throw new CanonicalizationError(`non-finite number: ${n}`);
  // ECMAScript Number-to-String is RFC 8785 §3.2.2.3; -0 serialises as "0".
  return JSON.stringify(n);
}

/** UTF-16 code-unit comparison (RFC 8785 §3.2.3). JS string `<` already compares code units. */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function serialize(v: unknown, out: string[]): void {
  if (v === null) {
    out.push("null");
    return;
  }
  switch (typeof v) {
    case "boolean":
      out.push(v ? "true" : "false");
      return;
    case "number":
      out.push(serializeNumber(v));
      return;
    case "string":
      out.push(serializeString(v));
      return;
    case "object":
      break;
    default:
      throw new CanonicalizationError(`not a JSON value: ${typeof v}`);
  }
  if (Array.isArray(v)) {
    out.push("[");
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out.push(",");
      const item: unknown = v[i];
      if (item === undefined) throw new CanonicalizationError("undefined in array");
      serialize(item, out);
    }
    out.push("]");
    return;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalizationError(`not a plain object: ${proto?.constructor?.name ?? "?"}`);
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort(compareKeys);
  out.push("{");
  keys.forEach((k, i) => {
    if (i > 0) out.push(",");
    out.push(serializeString(k), ":");
    serialize(obj[k], out);
  });
  out.push("}");
}

/**
 * RFC 8785 canonical JSON text. Object keys sorted by UTF-16 code units; numbers in ECMAScript
 * shortest round-trip form; no whitespace. Object keys whose value is `undefined` are skipped
 * (as JSON.stringify does); `undefined` in arrays, NaN, ±Infinity, lone surrogates, BigInt and
 * non-plain objects throw CanonicalizationError.
 */
export function canonicalize(value: Json): string {
  const out: string[] = [];
  serialize(value, out);
  return out.join("");
}
/** Alias of `canonicalize`. */
export const jcs = canonicalize;

/** Lowercase hex sha256 of the UTF-8 bytes of a string (or of raw bytes). */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** sha256Hex(canonicalize(value)). Used for `records.state_hash`, `input_hash`, args hashes. */
export function jsonHash(value: Json): string {
  return sha256Hex(canonicalize(value));
}

// ---------------------------------------------------------------------------------------------
// Projection and payload hash (07 §2 row 4 "projected payload hash"; 02 §3.2 `fields`)
// ---------------------------------------------------------------------------------------------

/** Split a field path: dot-separated object keys, optional leading `$.`. */
export function parseFieldPath(path: string): string[] {
  const p = path.startsWith("$.") ? path.slice(2) : path;
  if (p === "") throw new Error(`empty field path: ${JSON.stringify(path)}`);
  const segs = p.split(".");
  if (segs.some((s) => s === "")) throw new Error(`bad field path: ${JSON.stringify(path)}`);
  return segs;
}

function isObject(v: Json | undefined): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Project a state onto a field allow-list, keeping the nesting: `project({a:{b:1,c:2},d:3},
 * ["a.b"])` → `{a:{b:1}}`. Rules: paths traverse objects only (no array indexing); a missing
 * path, or one that meets a non-object before its end, is omitted (explicit `null` is kept);
 * when one field is a prefix of another, the shorter one wins (whole subtree). The result is
 * exactly what a backend receives as its state.
 */
export function project(state: Json, fields: readonly string[]): JsonObject {
  const paths = [...new Set(fields)].map(parseFieldPath).sort((a, b) => a.length - b.length);
  const out: JsonObject = {};
  const taken = new Set<string>();
  outer: for (const segs of paths) {
    for (let i = 1; i < segs.length; i++) {
      if (taken.has(segs.slice(0, i).join("."))) continue outer;
    }
    let cur: Json | undefined = state;
    for (const s of segs) {
      if (!isObject(cur) || !Object.hasOwn(cur, s)) {
        cur = undefined;
        break;
      }
      cur = cur[s];
    }
    if (cur === undefined) continue;
    let dst = out;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i] as string;
      const next = dst[s];
      if (isObject(next)) {
        dst = next;
      } else {
        const created: JsonObject = {};
        dst[s] = created;
        dst = created;
      }
    }
    dst[segs[segs.length - 1] as string] = cur;
    taken.add(segs.join("."));
  }
  return out;
}

/** sha256(JCS(project(state, fields))): the `payload_hash` cache-key component. */
export function payloadHash(state: Json, fields: readonly string[]): string {
  return jsonHash(project(state, fields));
}

/** JCS of the sorted, de-duplicated field list: `questions.fields_key` / `projections`. */
export function fieldsKey(fields: readonly string[]): string {
  return canonicalize([...new Set(fields)].sort());
}

// ---------------------------------------------------------------------------------------------
// Question, candidate-set and cache-key hashes
// ---------------------------------------------------------------------------------------------

/** Scheme tags inside hashed documents, so a future change of rules cannot collide. */
export const HASH_SCHEMES = {
  question: "dcx/question@1",
  candidates: "dcx/candidates@1",
  cacheKey: "dcx/cache@1",
  decisionPoint: "dcx/dp@1",
  toolSet: "dcx/toolset@1",
} as const;

/** The exact document `questionHash` hashes (exported for conformance tests). */
export function questionHashDoc(def: QuestionContent): JsonObject {
  return {
    scheme: HASH_SCHEMES.question,
    qtype: def.qtype,
    instructions: def.instructions,
    options: def.options.map((o) => ({ label: o.label, description: o.description ?? null })),
    no_match_label: def.noMatchLabel ?? null,
    fields: [...new Set(def.fields)].sort(),
  };
}

/**
 * sha256 over everything the model sees: qtype, exact instruction wording, ordered options with
 * descriptions, no-match label and the (sorted, de-duplicated) field list. Id, version, status,
 * owner, token cap and data class are NOT hashed. Any change → new hash → calibrators and
 * thresholds keyed on the old hash no longer apply. 02 §3.3, 07 §2 row 4.
 */
export function questionHash(def: QuestionContent): string {
  return jsonHash(questionHashDoc(def));
}

/**
 * Hash of the ordered runtime candidate set bound into a question's options (06 §1 amendment 2).
 * Returns "" (the DDL default) for no candidates, i.e. static options. Covers id, label and
 * description in order — order is part of what the model sees.
 */
export function candidateSetHash(candidates: readonly Candidate[] | null | undefined): string {
  if (!candidates || candidates.length === 0) return "";
  return jsonHash({
    scheme: HASH_SCHEMES.candidates,
    candidates: candidates.map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description ?? null,
    })),
  });
}

/** Inputs to `cacheKey`; defaults: candidateSetHash "", packMode "single", sampleNo 0. */
export interface CacheKeyParts {
  payloadHash: string;
  questionHash: string;
  candidateSetHash?: string;
  backend: string;
  /** The *returned* model version incl. settings digest (never an alias like jev-latest). */
  modelV: string;
  packMode?: PackMode;
  sampleNo?: number;
}

/**
 * The seven cache-key components (07 §2 row 4), as `judgments` columns. Validates them: hashes
 * are 64-char hex, backend non-empty, model pinned (not `*-latest`), sample_no a non-negative
 * integer.
 */
export function cacheKey(parts: CacheKeyParts): CacheKeyColumns {
  const hex = /^[0-9a-f]{64}$/;
  if (!hex.test(parts.payloadHash)) throw new Error("cacheKey: payloadHash must be sha256 hex");
  if (!hex.test(parts.questionHash))
    throw new Error("cacheKey: questionHash must be sha256 hex");
  const cs = parts.candidateSetHash ?? "";
  if (cs !== "" && !hex.test(cs))
    throw new Error("cacheKey: candidateSetHash must be '' or hex");
  if (!parts.backend) throw new Error("cacheKey: backend is required");
  assertPinned(parts.modelV);
  const sampleNo = parts.sampleNo ?? 0;
  if (!Number.isInteger(sampleNo) || sampleNo < 0) throw new Error("cacheKey: bad sampleNo");
  return {
    payload_hash: parts.payloadHash,
    question_hash: parts.questionHash,
    candidate_set_hash: cs,
    backend: parts.backend,
    model_v: parts.modelV,
    pack_mode: parts.packMode ?? "single",
    sample_no: sampleNo,
  };
}

/** A single string id for a cache key: sha256 of the JCS array of the seven components in
 *  column order. Recorded fixtures are keyed by this. */
export function cacheKeyId(k: CacheKeyColumns): string {
  return jsonHash([
    HASH_SCHEMES.cacheKey,
    k.payload_hash,
    k.question_hash,
    k.candidate_set_hash,
    k.backend,
    k.model_v,
    k.pack_mode,
    k.sample_no,
  ]);
}

/** The cache-key column names, in order, for SQL builders. */
export const CACHE_KEY_COLUMNS = [
  "payload_hash",
  "question_hash",
  "candidate_set_hash",
  "backend",
  "model_v",
  "pack_mode",
  "sample_no",
] as const satisfies readonly (keyof CacheKeyColumns)[];

// ---------------------------------------------------------------------------------------------
// Trace-contract helpers (03 §3.3)
// ---------------------------------------------------------------------------------------------

/** `decision_point_id` = hash(workflow, step name, loop key). 03 §3.3. */
export function decisionPointId(
  workflow: string,
  stepName: string,
  loopKey: string = "",
): string {
  return jsonHash({
    scheme: HASH_SCHEMES.decisionPoint,
    workflow,
    step: stepName,
    loop: loopKey,
  });
}

/** `tool_set_hash`: each schema hashed with jsonHash, hashes sorted, then hashed. 03 §3.3. */
export function toolSetHash(schemas: readonly Json[]): string {
  return jsonHash({ scheme: HASH_SCHEMES.toolSet, schemas: schemas.map(jsonHash).sort() });
}

/**
 * Model version with a backend-settings digest: `returned` alone when there are no settings,
 * else `returned+<first 12 hex of jsonHash(settings)>`. For LLM backends the settings include
 * the prompt-template hash and effort (02 §3.2).
 */
export function modelVersionWithSettings(
  returned: string,
  settings?: JsonObject | null,
): string {
  if (!settings || Object.keys(settings).length === 0) return returned;
  return `${returned}+${jsonHash(settings).slice(0, 12)}`;
}

/**
 * A deterministic number in [0, 1) from a string: first 13 hex digits (52 bits) of sha256 / 2^52.
 * The router's hashed audit share uses `hashUnit(salt + ":" + recordId) < auditRate` (03 §3.4).
 */
export function hashUnit(s: string): number {
  return Number.parseInt(sha256Hex(s).slice(0, 13), 16) / 2 ** 52;
}
