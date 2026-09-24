# dcx

dcx is a TypeScript toolkit that turns repeated LLM decisions into typed, cached, calibrated
judgements. A workflow runs on a journaled kernel. Each step (`sql`, `rule`, `judge`, `llm`,
`route`, …) is recorded, so a run can be replayed or forked. A decision the LLM made each time
becomes a set of closed questions, answered by a pinned judge backend (Jev, or recorded
fixtures) and cached under a seven-part content key. Calibrators and thresholds are data rows
fitted on labelled splits. The router auto-acts only above a certified threshold, and sends the
abstain band to a blind LLM and the rest to a human.

It uses two stores. The **SQLite journal** holds runs, steps, the HITL queue and an outbox, and
many readers can open it. The **DuckDB warehouse** holds records, judgments, traces, labels and
policy, and exactly one process opens it. Training reads labels only through `training_labels`,
and no label may name Jev (H5). The spec is
`../research/duckdb-classifier-orchestration/07-synthesis-and-mvp.md`, and the build brief is
`BUILD.md` beside it. `dcx` is a working name, and the licence is Apache-2.0.

## Layout

```
packages/core/       shared types, JCS hashing + cache key, DDL, migrations   (CONTRACT.md)
packages/store/      SQLite journal, DuckDB warehouse, outbox exporter
packages/judge/      question registry + lint, worker, ask/decide, calibrators, backends
packages/eval/       ECE (+ noise floor), Brier, Wilson, kappa, threshold sweep, H4 report
packages/kernel/     RunCtx, steps, router, replay
packages/importers/  SYNERGY / JSONL importers (+ the synthetic review generator)
packages/cli/        the `dcx` command; the kernel↔judge and fixture-LLM seams
packages/policy/     policy tests: H5 guard, pinning, licences, no network, cache key
packages/hitl/       local review page (SQLite only)             — placeholder, week 2
packages/discover/   mine, characterise, propose, shadow, gate    — placeholder, weeks 4–6
projects/evidence-screener/  customer 1: questions, criteria, baseline + compiled workflows
fixtures/            the synthetic review and recorded judge / LLM responses (fixtures/README.md)
conformance/         golden JCS vectors shared with other-language clients
scripts/hello-world.sh       the §4.8 demo
```

Downstream packages code against `@dcx/core`; start with `packages/core/CONTRACT.md`.

## Checks and the demo

These run from `dcx/` on Node ≥ 22.12, with no network and no API key:

```sh
npm install          # once
npm run check        # biome lint + format check  (check:fix to apply)
npm run typecheck    # tsc --noEmit over every package
npm test             # vitest across all workspaces (fixture backends only)
npm run demo         # scripts/hello-world.sh: the §4.8 sequence in a temp directory
npx dcx --help       # the CLI (or: npm run dcx -- --help)
```

`npm run demo` runs the §4.8 sequence exactly:

1. `init`, `import synergy` (300 records, seed 7) and `questions add`;
2. `run screen-baseline@1`;
3. `judge --backend fixture --pin jev-1.13.0`, twice (the second prints
   `0 requests: 300/300 payloads cached`);
4. `fit screen --split tune`;
5. `run screen-compiled@1 --split holdout`;
6. `report h4 --html out/report.html`.

Its output today:

```
H4 report · synergy/synthetic_exercise_depression · holdout n=120 (12 inclusions) · SYNTHETIC DATA · ILLUSTRATIVE, too small for a claim
                    all-LLM baseline      compiled (jev-1.13.0 + LLM fallback + 5% audit)
recall              0.92 [0.65, 0.99]     0.92 [0.65, 0.99]
coverage w/o LLM    0%                    77%
LLM calls           120                   30  (24 abstain + 6 audit)
judge requests      –                     120 (first run) · 0 (re-run)
cost / record       $0.0047               $0.0012
total               $0.56                 $0.15          saving 74%  (H4 needs ≥80% → coverage ≥0.86)
p50 latency         3.0 s                 0.00 s
```

**Fixture-only caveat.** Every number above comes from **synthetic data** and **recorded
fixtures**. The SYNERGY download was blocked in the build sandbox. The review, its labels, the
"Jev" answers and the LLM responses are generated deterministically (see `fixtures/README.md`).
Costs use illustrative prices. Latency is the recorded call latency: the fixture judge records
0 ms, so the compiled p50 reads 0.00 s. The table shows that the pipeline works. It is not
evidence for H4.

`--backend jev` is implemented against the SDK's documented request and response shape and
is tested only with mocks. It refuses `jev-latest`, and it refuses to start without
`TYPESAFE_API_KEY`.

## Status against the week-1 exit criteria (spec §5)

| Exit criterion | Status |
|---|---|
| §4.8 runs end to end | **Met on the fixture backend** (`npm run demo`; `packages/cli/test/hello-world.test.ts` runs the same sequence). No live Jev or LLM run has happened: no key. |
| A second judge pass makes 0 requests | **Met**: `0 requests: 300/300 payloads cached`, asserted in the test. The compiled run also makes 0 judge requests. |
| The PR CI suite passes on fixtures with no key | **Met locally**: `npm run check`, `npm run typecheck` and `npm test` are green. The workflow is in the repo's `.github/workflows/dcx.yml` and has not run here. |
| The H5 guard test is green | **Met**: `packages/policy` (h5, pinning); the demo test asserts that `training_labels` has no Jev-sourced rows. |
| The pinned model appears in every `judge_calls` row | **Met**: all 300 rows carry `model_v = model_req = jev-1.13.0`, asserted. |

**Week-1 scope.** These are in:

- core, the journal, the warehouse and the exporter;
- the registry and lint, and the worker;
- the `fixture`, `jev`, `wire` and `llm` backends;
- `decide` with isotonic and temperature calibration;
- eval metrics and the sweep;
- the minimal kernel;
- the CLI (`init`, `migrate`, `lint`, `questions`, `import`, `run`, `judge`, `fit`, `eval`,
  `report`, `replay`).

**Known gaps.**

- **Thresholds are not certified.** At n = 180 tune records the Wilson sweep cannot certify
  τ = 0.99, so `fit` uses the pre-registered policy τ (`criteria.json`) and says
  "not certifiable" for each threshold.
- **The saving is below target.** It is 74%, under H4's 80% bar, on synthetic data.
- **Four holdout records wait on human review.** They are injection hits and below-floor
  cases, and the demo does not resolve them. They count as retained for recall, and as neither
  judge nor LLM for coverage.
- **Not built yet:**
  - the `laya` backend;
  - a live LLM client (LLM steps replay fixtures);
  - `dcx review`, `discover`, `monitor` and `export` (weeks 2–6).
