# dcx

dcx is a TypeScript toolkit that turns repeated LLM decisions into typed, cached, calibrated
judgements. It has four parts:

- **a journaled kernel**: steps are `sql`, `rule`, `retrieve`, `judge`, `llm`, `tool`, `human`
  and `route`;
- **one judge worker and cache** over pinned backends (Jev, fixture, Laya, LLM);
- **read-time calibration and thresholds**, stored as data rows;
- **an offline discovery loop** that mines traces into questions and promotes them with human
  approval.

It uses two stores:

- **a SQLite journal** for runs, steps, HITL and the outbox. It has many readers.
- **a DuckDB warehouse** for records, judgments, traces, labels and policy. Exactly one process
  opens it.

The spec is `../research/duckdb-classifier-orchestration/07-synthesis-and-mvp.md`, and the build
plan is `BUILD.md` in the same directory. `dcx` is a working name, and the licence is Apache-2.0.

## Layout

```
packages/core/       shared types, JCS hashing + cache key, DDL, migrations   (CONTRACT.md)
packages/store/      SQLite journal, DuckDB warehouse, outbox exporter
packages/judge/      question registry + lint, worker, ask/decide, calibrators, backends
packages/eval/       ECE (+ noise floor), Brier, Wilson, kappa, threshold sweep, reports
packages/kernel/     RunCtx, steps, router, replay
packages/importers/  SYNERGY / JSONL / OTel importers
packages/hitl/       local review page (SQLite only)
packages/discover/   mine, characterise, propose, shadow, gate, promote
packages/cli/        the `dcx` command
projects/evidence-screener/  customer 1 workflows and questions
conformance/         golden vectors shared with other-language clients (jcs-vectors.json)
```

Downstream packages code against `@dcx/core`; start with `packages/core/CONTRACT.md`.

## Checks

Run from `dcx/` on Node ≥ 22.12, with no network or API key needed:

```sh
npm install          # once
npm run check        # biome lint + format check  (check:fix to apply)
npm run typecheck    # tsc --noEmit over every package
npm test             # vitest across all workspaces (fixture backends only)
npm run build        # tsc -b → packages/*/dist
```

A single package can be checked from its own directory with `npx vitest run` and
`npx tsc --noEmit -p .`.
