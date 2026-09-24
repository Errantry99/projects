# @dcx-projects/evidence-screener

Customer 1 (doc 08, 07 §4.8): screening one SYNERGY-style review. The review in this repo is
**synthetic** (see `../../fixtures/README.md`).

- `criteria.json`: the trusted protocol. It holds the topic, four criteria (population,
  condition, intervention, design) and the inclusion rule. It also holds the reducer and router
  policy (`exclude_min_p` 0.99, `injection_max_p` 0.2, `audit_rate` 0.05, the threshold ref) and
  the pinned baseline model.
- `questions/*.json`: the doc 08 §2 questions, in the judge registry's on-disk format (a
  `QuestionDef` without `questionHash`):
  - `on_topic` (Noul);
  - `crit_1..4` (Choice: `meets` / `fails` / `not_stated` / `other`);
  - `study_type` (Choice with `other`);
  - `injection` (Noul).

  They all have `fields: ["untrusted_record.title", "untrusted_record.abstract"]` and
  `maxStateTokens` 800, and they pass `@dcx/judge`'s lint. `loadQuestions()` returns them with
  their hashes, and `QUESTION_REFS` lists their refs.
- `workflows/baseline.ts`: `screen-baseline@1`, an `llm` step (include / exclude / flag) followed
  by the `screen.effect@1` rule.
- `workflows/compiled.ts`: `screen-compiled@1`.
  1. A `judge` step asks all seven questions.
  2. The `screen.reduce@1` rule auto-excludes only on a calibrated `fails` or off-topic answer at
     ≥ 0.99, and sends an injection hit to a human.
  3. A `route` step applies the certified threshold to the question the reducer names. The
     abstain band goes to the blind LLM, and 5% of records get a hashed audit.
  4. The `screen.effect@1` rule records the effect.

  `SCREEN_RULES` is in the kernel's `RuleDef` shape.
- `src/fixtures.ts` + `scripts/record-fixtures.ts`: build the recorded judge and LLM fixtures.
