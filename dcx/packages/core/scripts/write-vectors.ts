// Regenerates dcx/conformance/jcs-vectors.json: golden vectors for JCS (RFC 8785), sha256 and
// the dcx content hashes, shared with a future Python client (07 §3 item 3, §6).
// Run: npx tsx packages/core/scripts/write-vectors.ts   (from dcx/)
// The canonical strings below are written by hand (RFC 8785 §3.2.2, §3.2.3, Appendix B plus
// ordering/escaping cases); the script refuses to write if the implementation disagrees.

import { writeFileSync } from "node:fs";
import {
  type CacheKeyParts,
  type Candidate,
  cacheKey,
  cacheKeyId,
  candidateSetHash,
  canonicalize,
  decisionPointId,
  fieldsKey,
  hashUnit,
  type Json,
  payloadHash,
  project,
  type QuestionContent,
  questionHash,
  sha256Hex,
  toolSetHash,
} from "../src/index.js";

/** [name, JSON input text, expected canonical text] */
const CANON: Array<[string, string, string]> = [
  [
    "rfc8785-3.2.2-example",
    '{\n  "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],\n  "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",\n  "literals": [null, true, false]\n}',
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"\u20ac$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
  ],
  [
    "rfc8785-3.2.3-sorting",
    '{\n  "\\u20ac": "Euro Sign",\n  "\\r": "Carriage Return",\n  "\\ufb33": "Hebrew Letter Dalet With Dagesh",\n  "1": "One",\n  "\\ud83d\\ude00": "Emoji: Grinning Face",\n  "\\u0080": "Control",\n  "\\u00f6": "Latin Small Letter O With Diaeresis"\n}',
    '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
  ],
  [
    "utf16-order-not-codepoint-order",
    '{"\\ue000": 1, "\\ud800\\udc00": 2}',
    '{"\ud800\udc00":2,"\ue000":1}',
  ],
  ["ascii-key-order", '{"b":1,"a":2,"B":3,"aa":4,"":5}', '{"":5,"B":3,"a":2,"aa":4,"b":1}'],
  [
    "nested-and-whitespace",
    ' { "z" : [ 3 , { "y" : null , "x" : [ ] } ] , "a" : { } } ',
    '{"a":{},"z":[3,{"x":[],"y":null}]}',
  ],
  ["array-order-kept", '[3, 1, 2, ["b", "a"]]', '[3,1,2,["b","a"]]'],
  [
    "numbers-misc",
    "[-0, 1.0, 1e21, 1e-7, 0.30000000000000004, 100, 1E2, -1.5e-10, 123456789012345680000]",
    "[0,1,1e+21,1e-7,0.30000000000000004,100,100,-1.5e-10,123456789012345680000]",
  ],
  [
    "string-escapes",
    '["\\u0000\\u0008\\u0009\\u000a\\u000c\\u000d\\u001f", "\\u007f", "\\u2028\\u2029", "\\/", "\u00e9\\u00e9"]',
    '["\\u0000\\b\\t\\n\\f\\r\\u001f","\u007f","\u2028\u2029","/","\u00e9\u00e9"]',
  ],
  ["scalars", '[true, false, null, "", 0]', '[true,false,null,"",0]'],
];

/** RFC 8785 Appendix B: IEEE-754 bit pattern → canonical number text. */
const NUMBERS: Array<[string, string]> = [
  ["0000000000000000", "0"],
  ["8000000000000000", "0"],
  ["0000000000000001", "5e-324"],
  ["8000000000000001", "-5e-324"],
  ["7fefffffffffffff", "1.7976931348623157e+308"],
  ["ffefffffffffffff", "-1.7976931348623157e+308"],
  ["4340000000000000", "9007199254740992"],
  ["c340000000000000", "-9007199254740992"],
  ["4430000000000000", "295147905179352830000"],
  ["44b52d02c7e14af5", "9.999999999999997e+22"],
  ["44b52d02c7e14af6", "1e+23"],
  ["44b52d02c7e14af7", "1.0000000000000001e+23"],
  ["444b1ae4d6e2ef4e", "999999999999999700000"],
  ["444b1ae4d6e2ef4f", "999999999999999900000"],
  ["444b1ae4d6e2ef50", "1e+21"],
  ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
  ["3eb0c6f7a0b5ed8d", "0.000001"],
  ["41b3de4355555553", "333333333.3333332"],
  ["41b3de4355555554", "333333333.33333325"],
  ["41b3de4355555555", "333333333.3333333"],
  ["41b3de4355555556", "333333333.3333334"],
  ["41b3de4355555557", "333333333.33333343"],
  ["becbf647612f3696", "-0.0000033333333333333333"],
  ["43143ff3c1cb0959", "1424953923781206.2"],
];
/** Must be rejected. */
const NUMBER_ERRORS = ["7ff8000000000000", "7ff0000000000000", "fff0000000000000"];
const TEXT_ERRORS: Array<[string, string]> = [
  ["lone-high-surrogate", '"\\ud800"'],
  ["lone-low-surrogate-key", '{"\\udc00": 1}'],
];

export function ieeeHexToNumber(hex: string): number {
  return Buffer.from(hex, "hex").readDoubleBE(0);
}

const STATE: Json = {
  untrusted_record: {
    title: "Aspirin for \u03b2-blocker trials",
    abstract: "We screened 1,204\u2026",
  },
  meta: { source: "synergy", year: 2019 },
  note: null,
};
const PROJECT: Array<{ name: string; state: Json; fields: string[] }> = [
  {
    name: "nested-two-fields",
    state: STATE,
    fields: ["untrusted_record.title", "untrusted_record.abstract"],
  },
  {
    name: "order-and-dupes-irrelevant",
    state: STATE,
    fields: ["untrusted_record.abstract", "untrusted_record.title", "untrusted_record.title"],
  },
  { name: "prefix-wins", state: STATE, fields: ["meta", "meta.year"] },
  {
    name: "missing-omitted-null-kept",
    state: STATE,
    fields: ["note", "missing.path", "meta.year.deeper"],
  },
  { name: "dollar-prefix", state: STATE, fields: ["$.meta.source"] },
];

const Q_ON_TOPIC: QuestionContent = {
  qtype: "noul",
  instructions: "Is `untrusted_record` about the review topic defined here?",
  options: [
    { label: "true", description: "The title or abstract studies the topic." },
    { label: "false", description: "Neither the title nor the abstract studies the topic." },
  ],
  noMatchLabel: null,
  fields: ["untrusted_record.title", "untrusted_record.abstract"],
};
const Q_CRIT: QuestionContent = {
  qtype: "choice",
  instructions: "Does the study in `untrusted_record` meet criterion 1 (randomised design)?",
  options: [
    { label: "meets", description: "The abstract states random allocation." },
    { label: "fails", description: "The abstract states a non-random design." },
    { label: "not_stated", description: "The abstract does not say how groups were formed." },
    { label: "other", description: "None of the above applies." },
  ],
  noMatchLabel: "other",
  fields: ["untrusted_record.abstract", "untrusted_record.title"],
};
const CANDIDATES: Candidate[] = [
  { id: "C0001", label: "Myocardial infarction", description: "Necrosis of heart muscle." },
  { id: "C0002", label: "Angina", description: { definition: "Chest pain", excludes: ["MI"] } },
];

const QH = questionHash(Q_CRIT);
const PH = payloadHash(STATE, Q_CRIT.fields);
const CS = candidateSetHash(CANDIDATES);
const CACHE: Array<{ name: string; parts: CacheKeyParts }> = [
  {
    name: "defaults",
    parts: { payloadHash: PH, questionHash: QH, backend: "jev", modelV: "jev-1.13.0" },
  },
  {
    name: "runtime-candidates",
    parts: {
      payloadHash: PH,
      questionHash: QH,
      candidateSetHash: CS,
      backend: "jev",
      modelV: "jev-1.13.0",
    },
  },
  {
    name: "repeat-sample",
    parts: {
      payloadHash: PH,
      questionHash: QH,
      backend: "jev",
      modelV: "jev-1.13.0",
      sampleNo: 2,
    },
  },
  {
    name: "packed-llm",
    parts: {
      payloadHash: PH,
      questionHash: QH,
      backend: "llm",
      modelV: "claude-x+3f2a1b4c5d6e",
      packMode: "pack:8",
    },
  },
];

export function buildVectors() {
  for (const [name, input, expected] of CANON) {
    const got = canonicalize(JSON.parse(input) as Json);
    if (got !== expected) throw new Error(`${name}: got ${got} expected ${expected}`);
  }
  for (const [hex, expected] of NUMBERS) {
    const got = canonicalize(ieeeHexToNumber(hex));
    if (got !== expected) throw new Error(`${hex}: got ${got} expected ${expected}`);
  }
  return {
    description:
      "dcx conformance vectors: RFC 8785 JCS, sha256 (lowercase hex of UTF-8 bytes) and dcx content hashes. Any client must reproduce every entry. Regenerate with packages/core/scripts/write-vectors.ts.",
    version: 1,
    canonicalize: CANON.map(([name, input, expected]) => ({
      name,
      input,
      expected,
      sha256: sha256Hex(expected),
    })),
    numbers: NUMBERS.map(([ieee_hex, expected]) => ({ ieee_hex, expected })),
    number_errors: NUMBER_ERRORS.map((ieee_hex) => ({ ieee_hex })),
    text_errors: TEXT_ERRORS.map(([name, input]) => ({ name, input })),
    project: PROJECT.map((p) => ({
      ...p,
      expected: canonicalize(project(p.state, p.fields)),
      payload_hash: payloadHash(p.state, p.fields),
      fields_key: fieldsKey(p.fields),
    })),
    question_hash: [Q_ON_TOPIC, Q_CRIT].map((def) => ({ def, expected: questionHash(def) })),
    candidate_set_hash: [
      { candidates: [], expected: candidateSetHash([]) },
      { candidates: CANDIDATES, expected: CS },
    ],
    cache_key: CACHE.map(({ name, parts }) => {
      const columns = cacheKey(parts);
      return { name, parts, columns, id: cacheKeyId(columns) };
    }),
    decision_point_id: [
      {
        workflow: "screen-baseline@1",
        step: "screen",
        loop: "",
        expected: decisionPointId("screen-baseline@1", "screen"),
      },
      {
        workflow: "inbox@3",
        step: "triage",
        loop: "msg",
        expected: decisionPointId("inbox@3", "triage", "msg"),
      },
    ],
    tool_set_hash: [
      {
        schemas: [
          { name: "b", type: "object" },
          { type: "object", name: "a" },
        ],
        expected: toolSetHash([
          { name: "b", type: "object" },
          { type: "object", name: "a" },
        ]),
      },
    ],
    hash_unit: ["audit:rec-1", "audit:rec-2", ""].map((input) => ({
      input,
      expected: hashUnit(input),
    })),
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const out = new URL("../../../conformance/jcs-vectors.json", import.meta.url);
  writeFileSync(out, `${JSON.stringify(buildVectors(), null, 2)}\n`);
  console.log(`wrote ${out.pathname}`);
}
