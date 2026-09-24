# Build coordination brief (execution of `07-synthesis-and-mvp.md`, week-1 milestone)

_24 Sep 2026. Read this before writing code. The spec is `07-synthesis-and-mvp.md` §2–§6; the
evidence is in `01`–`06`. Where this brief and the spec disagree, this brief wins (it records the
decisions taken at build time)._

## Decisions taken at build time

1. **Location.** The code lives in this repository at `/home/user/projects/dcx/` as a
   self-contained npm workspace (spec §8 Q2 defaulted to a sibling repo; this session can only
   push here). Nothing under the repo's top-level `src/` is touched.
2. **Toolchain (verified in this sandbox).** Node 22.22, npm 10.9, TypeScript strict ESM,
   `@duckdb/node-api` 1.5.x (DuckDB 1.5.5), `better-sqlite3` (SQLite 3.53), Vitest, Biome
   (reuse the repo's `biome.json` rules), `tsx` for running TS, `commander` for the CLI.
3. **Working name** `dcx`; licence Apache-2.0 (spec §8 Q11).
4. **Phase 0 installs every dependency.** Later agents must not run `npm install`; if a
   dependency is missing, say so in the hand-back and code against a local stub.
5. **Fixture backend first.** No paid key exists in this sandbox. Every test and the hello-world
   demo must run on the `fixture` backend. The Jev backend is implemented against the SDK's
   documented request/response shape and tested with recorded fixtures only.
6. **SYNERGY data.** Try `pip install synergy-dataset` and the dataset download; if the download
   is blocked, generate a deterministic synthetic review (300 records, seed 7, realistic titles
   and abstracts, ~10% inclusions) under `dcx/fixtures/synergy-synthetic/` and label it clearly
   as synthetic so the H4 report prints "SYNTHETIC DATA" in its header.

## Package ownership (one agent per row; touch only your paths)

| Phase | Package / paths | Agent owns |
|---|---|---|
| 0 | `dcx/` root files, `dcx/packages/core/**` | workspace scaffold, deps, `core`: `types.ts`, `hash.ts` (JCS + sha256), `schema/{sqlite.sql,duckdb.sql}`, `migrate.ts`, `CONTRACT.md`, tests |
| 1 | `dcx/packages/store/**` | SQLite journal, DuckDB warehouse (single opener, appender/Arrow batch writes), outbox exporter, tests |
| 1 | `dcx/packages/judge/**` | question registry + lint, judge worker (`drain`), `ask`/`decide` split, calibrators (isotonic, temperature, Platt), meter, backends `fixture`, `jev`, `llm`, `wire`; tests |
| 1 | `dcx/packages/eval/**` | metrics (ECE + noise floor, Brier, Wilson, κ), threshold sweep, calibration report (HTML + text), tests |
| 1 | `dcx/packages/kernel/**` | `RunCtx` with steps `sql`, `rule`, `judge`, `llm`, `route` (+ stubs for `tool`, `human`, `retrieve`), journaled `now()`/`random()`, router tiers + audit sampling, replay; tests |
| 1 | `dcx/packages/importers/**`, `dcx/projects/evidence-screener/**`, `dcx/fixtures/**` | SYNERGY (or synthetic) importer, JSONL importer, the hand-written question JSONs from doc 08, the baseline and compiled workflow definitions, recorded fixture responses |
| 2 | `dcx/packages/cli/**`, `dcx/README.md` | CLI commands `init migrate lint questions import run judge fit eval report`, wiring all packages, the hello-world script |
| 2 | `dcx/.github/**` (or repo `.github/workflows/dcx.yml`), `dcx/packages/*/policy-tests` | CI workflow (check, typecheck, test on fixtures), H5 guard test, licence check (no AGPL/ELv2), `jev-latest` rejection |

## Rules for every coding agent

- Read `BUILD.md`, then `07-synthesis-and-mvp.md` §2–§6, then the workstream sections your
  package cites, then `dcx/packages/core/CONTRACT.md` (phases 1–2). Code against `core`'s types;
  do not redefine shared types locally. If `core` is missing something you need, add a minimal
  local type, mark it `// TODO(core): promote`, and list it in your hand-back.
- Only edit paths you own. Do not edit `core` (phase 1–2), `package.json` at the root, or the
  lockfile. Do not run `git`. Do not run `npm install`.
- Every package: `index.ts` exports the public API; `README.md` (short) says what it does and
  how to use it; tests under `test/` run with `npx vitest run` from the package directory and
  pass; `npx biome check .` and `npx tsc --noEmit -p .` pass from `dcx/`.
- Tests never need network or a paid key. Recorded fixtures are keyed by the full cache key.
- Keep the kernel under ~1,800 LoC and each package small; the spec's LoC budget for week 1 is
  ~2,000 in total across packages, ±50%.
- Log every judge call with the returned model version; reject `jev-latest`; never write to
  `labels` with a source that names Jev (the DDL CHECK enforces it; tests assert it).
- Hand-back (≤200 words): what you built, test counts and results, LoC, anything missing from
  `core`, any deviation from the spec and why, and any dependency you needed but could not
  install.
