# @dcx/eval

Metrics, the threshold sweep, the H4 report and the savings ledger for dcx (spec 07 §4.8, §6;
docs 02 §3.4–3.5, 04 §3.6–3.7, 05 §3.3).

```ts
import { ece, eceNoiseFloor, sweepThresholds, buildH4Report, renderH4Text } from "@dcx/eval";
```

- **`metrics.ts`**: ECE with equal-width or equal-mass bins, reliability bins, Brier, NLL, the
  ECE noise floor (labels redrawn from Bernoulli(p̂), seeded), Wilson intervals, Cohen's κ and
  its half-width, zero-failure sample sizes (598 / 299 / 149), seeded bootstrap CIs for recall
  and precision, the risk–coverage curve and selective accuracy at a coverage.
  `referenceEceFloor(n)` is 04 §3.6's reference setting: p̂ ~ Beta(6,1), 5 equal-width bins,
  2,000 simulations, which gives 0.057 / 0.031 / 0.023 / 0.019 at n = 60 / 200 / 400 / 600.
- **`sweep.ts`**: `sweepThresholds(items, {action, costMatrix?, taus?, zeroFailure?})` walks the
  fixed τ sequence strict → loose and keeps the loosest τ that passes before the first failure.
  A τ passes when the Wilson lower bound of precision on the covered rows reaches
  1 − C_human/C_wrong (0.99 for the default $50 / $0.50). A τ whose n cannot pass even with
  zero errors is skipped rather than failed. With `zeroFailure`, a τ passes only with zero
  errors on at least `zeroFailureN(target)` rows. If nothing passes, the status is `human_only`.
  `thresholdFields(result)` gives the `thresholds` columns.
- **`report.ts`**: `buildH4Report` takes per-record arm arrays and truth labels.
  `renderH4Text` prints the §4.8 table exactly. `renderH4Html` writes one self-contained page
  with inline-SVG reliability diagrams (ECE next to its floor), the risk–coverage curve and the
  review-band records. The header adds `SYNTHETIC DATA` and
  `ILLUSTRATIVE, too small for a claim` (n < 500 or fewer than 30 positives). Recall CIs are
  Wilson by default, with `ci: "bootstrap"` as an option.
- **`load.ts`**: builds report inputs from the warehouse. `armRecords`, `judgeRequests`,
  `truthLabels` and `calibrationPairs` read `llm_calls`, `judge_uses` ⨝ `judgments` ⨝
  `judge_calls`, `routes`, `trace_steps`, `labels` and `decisions`. They need only
  `Warehouse.all`.
- **`ledger.ts`**: `queryLedger(wh, {runIds, baselineRunIds})` builds the savings ledger over
  core's `savings_ledger` view. Each run gets a baseline cost (records × the baseline's cost
  per record), its compiled cost and the saving. `buildLedger` does the same from arrays.

Tests: `npx vitest run` (hand-computed metrics, κ/Wilson goldens, floor reproduction, isotonic
correction to ≤ 2× floor, the §4.8 snapshot, DuckDB `:memory:` loaders).
