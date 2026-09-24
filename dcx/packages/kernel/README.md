# @dcx/kernel

The journaled workflow kernel (spec 07 §3 decision 7, 03 §3). Every `RunCtx` step is a
journaled function in the style of DBOS `operation_outputs`:

1. On entry, look up `(run_id, step_no)`. If a result is stored, return it (replay).
2. Otherwise insert the step as `running` (insert-if-absent) and execute it.
3. Store the output with `completeStep`, together with its warehouse rows (outbox), in one
   SQLite transaction.

Step numbers are assigned synchronously in call order. `now()` and `random()` are journaled
too, as `rule` steps named `dcx.now` and `dcx.random`.

```ts
import { Kernel, replay, fork, runSpans } from "@dcx/kernel";
const k = new Kernel({ journal, warehouse, workflows: [wf], judge, llm, rules, tools, budget });
const r = await k.createRun("screen-compiled", 1, "active", input); // completed | waiting | failed
await k.resume(r.runId);          // continue after a human resolves; completed runs replay read-only
await k.recover();                // claim expired leases and resume them
await replay(k, runId);           // strict replay: identical output, no writes
await fork(k, runId, 5, { override }); // keep steps < 5, re-execute from 5
```

## Steps and the rows they write

| Step | Does | Rows (through the outbox) |
|---|---|---|
| `sql` | Runs a warehouse query and journals the rows | `trace_steps` |
| `rule` | Runs a registered pure `name@version` function | `trace_steps` |
| `judge` | Calls `JudgeService.askLive` | `judge_uses`, one per use |
| `llm` | Calls `LlmClient.complete` | `content` (the exact input and the raw text); `tool_schemas`; `llm_calls`, emitted when the **next** step completes, with `effect` and `branch_taken` filled from that step (or `{kind:"return"}` at run end) |
| `route` | tier 0 rule → tier 1 judge vs threshold rows → tier 2 blind LLM → human | `routes` with a reason code; `judge_uses`; tier-2 `llm_calls` (`teacher_blind`) |
| `tool` | Stub executor. Writes a `tool_calls` row before the call, keyed `hash(run_id, step_no)`. After a crash, idempotent tools retry and others are flagged `in_doubt` | `tool_calls` (journal) |
| `human` | Enqueues `hitl_queue`, marks the step `suspended` and the run `waiting`. The journal's `resolveHuman` completes the step; then `resume` | `hitl_queue` (journal) |
| `retrieve` | **Stub.** Returns `{candidates: [], candidateSetHash: ""}` | none |

## Router rules (`router.ts`)

- **Threshold rows.** They are read from `thresholds` after the judge answers. An action's
  `thresholdRef` is a `threshold_id` or a `policy_id` (one row per question; the judged
  question's newest valid row is used). A row applies only if it is `active` and matches the
  decision's question hash, model and calibrator; otherwise the reason is `no_threshold`.
- **Mapping answers to actions.** The rule's `label` maps an answer to an action. A null label
  means the action key is itself the answer. An answer that maps to no action goes to human
  (`no_threshold`), or to tier 2 with no candidate (`abstain_band`) when the route sets
  `onUnmapped: "llm"`. An action without a `thresholdRef` is only ever taken by tier 2.
- **Tier 1 outcomes:**
  - `p ≥ min_p` → `above_threshold`;
  - `p ≥ abstain_band[0]` (or the `floor` column) → tier 2 with `abstain_band`;
  - otherwise → human with `below_floor`.
- **Drift and errors.** Model drift → human with `model_drift`. A judge error fails open to
  tier 2 unless every threshold's `on_error` fails closed.
- **Audit.** A record is audited when `hashUnit("<decisionPoint>:<recordId>") < auditRate`.
  An audited auto decision runs tier 2 anyway, with reason `audit_sample`.
- **Budget.** A cap is hit when spend plus `llmEstimateUsd` reaches it. The caps are the
  route's `budgetUsd` (or `budget.runUsd`) and `budget.dayUsd`. Hitting one sends the record to
  human with `budget_exhausted`, and applies only when tier 2 is needed.
- **Tier 2.** The route acts if the LLM agrees, or if the LLM's action is marked
  `reversible: true` on the route's action. Otherwise → human with `tier_disagreement`.
- **Human fallback.** `fallback.human` runs as the next step (`<name>.human`), and the
  resolution (`key`, `{answer}` or `{label}`) becomes the branch (tier 3).

## Other modules

- `otel.ts` maps journal steps to plain OTel-style span objects:
  - semconv is pinned at `SEMCONV_VERSION` 1.42.0;
  - the custom span kinds are `dcx.classify` and `dcx.route`;
  - content capture is off, so spans carry hashes and refs only.
- `JudgeService` and `LlmClient` are the injection seams. `@dcx/cli`'s `WarehouseJudge` adapts
  `@dcx/judge`: it resolves the refs, calls `askLive` with `writeUses: false`, runs `decide()`
  with the active calibrator and thresholds from the warehouse, and maps the result to
  `{decided, uses, costUsd}`. `FixtureLlm` (also in the CLI) replays recorded LLM responses.

## Notes

- Run input and fork metadata are kept inline in `runs.input_ref` (core's `encodeRunInput`).
- `hitl_queue.card` is `{view, label}`.
- The `content` and `tool_schemas` rows are content-addressed, so the exporter must ignore
  duplicates.

Tests (`npx vitest run`) run on `@dcx/store`'s `SqliteJournal`, `DuckWarehouse` and
`drainOutbox` in a temp directory (`test/stores.ts`).
