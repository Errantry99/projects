# dcx fixtures

Recorded inputs and responses for the hello-world demo (07 §4.8) and the PR-tier CI (07 §6). No
test needs network or a paid key. **Everything here is SYNTHETIC DATA.** The real SYNERGY
download was blocked by the sandbox's egress proxy (see `synergy-synthetic/META.json`), so the
review, its labels and every "recorded" response are generated deterministically.

| Path | What | Written by |
|---|---|---|
| `synergy-synthetic/<review>.jsonl` | 300 records, 30 inclusions, seed 7 | `npx tsx packages/importers/scripts/gen-synthetic.ts` |
| `synergy-synthetic/META.json` | `"synthetic": true`, the criteria, the SYNERGY attempt | same |
| `judge/<review>/<record_id>.json` | judge answers, keyed by the full cache key | `npx tsx projects/evidence-screener/scripts/record-fixtures.ts` |
| `judge/MANIFEST.json` | backend, model_v, question hashes, counts | same |
| `llm/<template_id>@<v>/<record_id>.json` | baseline LLM responses, keyed by record id | same |

After regenerating, run `npx biome format --write fixtures`. Tests compare parsed JSON with the
generators, so any edit to a question's wording, options or fields fails them until you regenerate.

## `synergy-synthetic/<review>.jsonl`

One `SynergyRecord` per line (`packages/importers/src/synthetic-synergy.ts`): `id`, `title`,
`abstract`, `label_included` (0 or 1), `doi`, and `synthetic: {category, truth, ambiguous}`.
`truth` maps each question id (`screen.crit_1`, ...) to its true answer, and `label_included`
follows from the truth through the review's stated inclusion rule. The real SYNERGY CSV
(`openalex_id, doi, title, abstract, label_included`) imports through the same importer.

## `judge/<review>/<record_id>.json`: judge fixtures

This is the format `@dcx/judge`'s fixture backend reads (`packages/judge/src/backends/fixture.ts`,
`readFixtures`). Each file holds a JSON **array** of `FixtureEntry` objects, one per question for
that record. The backend indexes entries by `keyId`, so file names are only for people.

```jsonc
{
  "keyId": "<cacheKeyId(key)>",          // the lookup key: sha256 of the seven components
  "key": {                               // CacheKeyColumns, exactly as core's cacheKey() builds them
    "payload_hash": "<payloadHash(state, q.fields)>",
    "question_hash": "<questionHash(q)>",
    "candidate_set_hash": "",
    "backend": "fixture",
    "model_v": "jev-1.13.0",
    "pack_mode": "single",
    "sample_no": 0
  },
  "answer": { /* RawAnswer: questionHash, qtype, answer, probs, pAnswer, backendConfidence */ },
  "modelVersion": "jev-1.13.0",          // the returned model; a different value is a drift fixture
  "usage": { "inputTokens": 704, "outputTokens": 0, "costUsd": 0.0000296, "basis": "token-price" },
  "requestId": "fx-<payload hash prefix>",
  "recordedAt": "2026-09-24T00:00:00.000Z",
  "recordId": "synthetic_exercise_depression.r0001",   // provenance only
  "questionRef": "screen.on_topic@1",                  // provenance only
  "synthetic": true
}
```

- The state is `{untrusted_record: {title, abstract}}`. All seven questions share its projection,
  so one record is one request. `usage` is per request and is repeated on each entry.
- The key's backend is `fixture`, which is the fixture backend's default `name`. To replay these
  entries as `jev`, regenerate them with `buildDemoFixtures(..., { backend: "jev" })`.
- Probabilities are two-decimal and sum to 1. About half of the clear answers are exactly 1.0,
  as Jev's are. About 15% of records (44 of 300) have one answer with p ≤ 0.8: the generator's
  ambiguous cases, which are wrong a third of the time, plus 0.5% clear-case errors. Inclusions
  are mostly `meets`. Every exclusion has a `fails` or off-topic signal, except the
  `design_not_stated` ones. Answers are seeded by payload hash, so identical payloads get
  identical answers, as they would from a cache.

## `llm/screen.baseline@1/<record_id>.json`: baseline LLM responses

The key is `req.recordIds[0]`. The compiled arm's blind tier-2 fallback uses the same template
and schema, so these files serve it too.

```jsonc
{
  "recordId": "synthetic_exercise_depression.r0001",
  "request": { "template_id": "screen.baseline", "template_v": 1,
               "template_text_sha256": "<sha256Hex(template.text)>", "model": "frontier-llm@2026-09-01" },
  "response": {                          // Omit<LlmRes, "callId">: what a kernel LlmClient returns
    "value": { "answer": "include" }, "text": "{\"answer\":\"include\"}", "outputKind": "structured",
    "normalisedAnswer": "include", "modelReturned": "frontier-llm@2026-09-01",
    "usage": { "inputTokens": 1385, "outputTokens": 284 }, "costUsd": 0.00561,
    "costBasis": "token-price", "latencyMs": 2367, "retries": 0
  },
  "synthetic": true
}
```

A fixture LLM client should refuse to serve a response when `template_text_sha256` or `model`
differs from the request. Baseline behaviour: recall 26/30 (4 inclusions are flagged, 4 are
excluded), 17 false inclusions and 14 flags among the 270 exclusions. Some injected
instructions succeed against this all-LLM arm. Costs use an illustrative $2 / $10 per million
input / output tokens.
