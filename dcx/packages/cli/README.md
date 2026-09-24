# @dcx/cli

The `dcx` command (spec 07 §4.7). It wires the packages together: the kernel runs on
`@dcx/store`'s SQLite journal and DuckDB warehouse, the judge step goes through
`WarehouseJudge` (below), and LLM steps replay recorded fixtures.

```sh
npx dcx --help                 # from dcx/ (bin: packages/cli/bin/dcx.js, run through tsx)
npm run dcx -- --help          # the same without the bin link
```

| Command | Does |
|---|---|
| `init [dir]` | writes `dcx.config.json` (defaults: evidence-screener project, `dcx/fixtures`) and migrates both stores |
| `migrate` | applies pending migrations to the journal and the warehouse |
| `lint [files…]` | question lint (02 §3.3) plus unpinned models anywhere in the config |
| `questions add\|list\|diff` | lint and register question JSON; list the registry; diff two versions |
| `import synergy\|jsonl` | a SYNERGY review (or the synthetic stand-in) with author labels; TraceRow JSONL |
| `run <workflow@v>` | one kernel run per record (`--split`, `--records`, `--limit`, `--mode`, `--model`) |
| `judge --backend <b> --pin <m>` | drains the judge work list and prints `N requests: k/n payloads cached` |
| `fit <set> --split tune` | isotonic (Jev-shaped) or the recommended calibrator per question, then one threshold row per question for each config policy |
| `eval <set> --split holdout` | ECE vs its noise floor, Brier, accuracy and threshold precision on the split |
| `report h4\|ledger\|calibration [--html p]` | the §4.8 table (and HTML), the savings ledger, reliability per question |
| `replay <run> [--fork-at k]` | strict replay from the journal, or a fork from step k |

**Stores.** Each process opens DuckDB at most once (`Context.warehouse()`, through
`openDuckWarehouse`), drains the journal outbox into it on open and again before exit.

**Backends.** Backends are `fixture` (recorded answers keyed by the full cache key), `jev`, `wire`
and `laya` (not in this build). Every pin goes through `assertPinned`, so `jev-latest` is refused.
`--backend jev` also refuses to start without `TYPESAFE_API_KEY`.

**Seams closed here.**

- `WarehouseJudge` implements the kernel's `JudgeService`. It resolves question refs from the
  registry, calls `@dcx/judge`'s `askLive` with `writeUses: false`, and runs `decide()` with
  the active calibrator and thresholds for each (question_hash, backend, model_v). The kernel
  journals the uses.
- `FixtureLlm` implements the kernel's `LlmClient`. It serves
  `fixtures/llm/<template>@<v>/<record>.json` only when the template hash and the model match.

**Config.** `dcx.config.json` holds the store paths, the project, the fixture directories, the
default judge backend and pin, and the threshold policies `fit` writes. It is found in the cwd,
in a parent directory, or at `-C <dir>`. `DCX_DIR`, `DCX_JOURNAL`, `DCX_WAREHOUSE`, `DCX_PROJECT`,
`DCX_FIXTURES` and `DCX_JUDGE_PIN` override it.

**Tests.** `npx vitest run`. `test/hello-world.test.ts` runs the whole §4.8 sequence in a temp
directory and asserts these points:

- the second judge pass makes 0 requests;
- every `judge_calls` row carries `jev-1.13.0`;
- the H4 table prints, headed SYNTHETIC DATA, with numeric coverage and saving;
- `training_labels` holds no Jev-sourced rows;
- the unpinned alias and a missing key are refused;
- replay is identical.
