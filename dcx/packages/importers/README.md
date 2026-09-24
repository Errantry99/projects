# @dcx/importers

Dataset and trace importers. Each one builds typed warehouse rows (pure functions) and writes
them in one transaction through core's `Warehouse.appendRows` (`onConflict: "ignore"`, so
re-importing is a no-op).

- **SYNERGY** (`synergy.ts`): `readSynergyFile(path)` reads the SYNERGY CSV or a JSONL of
  `SynergyRecord`s. `synergyRows(records, {review, synthetic?, sample?, seed?})` builds:
  - `records`: `kind = "abstract"`, with state `{untrusted_record: {title, abstract}}` and
    `state_hash = jsonHash(state)`;
  - `content`: the raw source record;
  - `labels`: one screening label per record (`target_kind = "decision"`,
    `target_ref = "screen.include"`, `include` | `exclude`), with `source = 'human'`,
    `selected_by = 'exhaustive'` and a hash-seeded, stratified 60/40 `tune`/`holdout` split.
    Synthetic data also gets per-question truth labels (`target_kind = "question"`,
    `target_ref = "screen.crit_1@1"`).
  - `importSynergy(wh, rows)` writes them.
- **Synthetic SYNERGY** (`synthetic-synergy.ts`): `generateSyntheticReview()` is seed 7, 300
  records, 30 inclusions, labels derived from per-question truth by the stated inclusion rule.
  It is used because the real download is blocked here. See `fixtures/README.md`.
- **JSONL traces** (`jsonl.ts`): `parseTraceJsonl(text)` validates TraceRow lines strictly and
  reports every problem with its line number. It fills `llm_calls` plus a mirrored `trace_steps`
  row (`kind = 'llm'`, `activity = llm:<template_id>`). Missing `step_no` values are assigned per
  run. Rows without `effect` are classed `open` (`trace_steps.output.class`). Write them with
  `importTraceJsonl(wh, imp)`.

Tests: `npx vitest run` (they check the rows against the DuckDB DDL, including the H5 CHECK).
