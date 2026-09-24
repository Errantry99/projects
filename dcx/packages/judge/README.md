# @dcx/judge

The judge layer: question registry and lint, the batch worker, the `ask`/`decide` split,
calibrator fitting, metering and four backends. Spec: `07-synthesis-and-mvp.md` §3 items 5, 6
and 9 and §4.4; `02-classifier-layer.md` §3.

```ts
import { drain, fixtureBackend, jevBackend, loadQuestionFiles, lintQuestion, writeQuestions } from "@dcx/judge";

const qs = loadQuestionFiles("projects/evidence-screener/questions");
for (const q of qs) if (lintQuestion(q).length) throw new Error(q.id);
await writeQuestions(wh, qs);
const be = jevBackend({ model: "jev-1.13.0", apiKey: process.env.TYPESAFE_API_KEY });
const stats = await drain(wh, be, { pin: "jev-1.13.0", budgetUsd: 1 }); // a second drain: 0 requests
```

| Module | What it does |
|---|---|
| `registry.ts` | Parses question JSON (camelCase or snake_case), computes `questionHash` via core, enforces versioning (immutable rows, `parentHash` lineage), writes `questions` rows, `diff(a, b)` |
| `lint.ts` | The 02 §3.3 rules as pure functions: no-match option, options described and mutually exclusive, one judgment, no arithmetic/date/ranking, literal reader (no "etc.", pronouns resolved by a backticked state path, no persona or rationale), length caps, `fields` declared, `jev-latest` rejected anywhere a model is named |
| `worker.ts` | `drain(wh, backend, opts)`: fills `projections`, `asks` ANTI JOIN `judgments` (pin as `model_v`), one request per payload, 429-aware limiter, budget pre-flight (refuse, never truncate), drift → degraded + demote + stop, flush buffer (`judge_calls` + `judgments` in one txn, ON CONFLICT DO NOTHING). `askLive(...)` for the kernel: cache lookup, misses asked, `judge_uses` written for every use with `cache_hit` (or returned for an outbox with `writeUses: false`) |
| `decide.ts` | `decide(raw, calibrator, threshold)` → `Decided` (calibrated `pCal`, action, abstain band, `on_error` default `human`, drift → human). `loadDecisionPolicy` reads the active rows |
| `calibrate.ts` | Isotonic (PAV; ties pooled first, so mass at 1.0 is one block), temperature (multiclass form), Platt; ECE, Bernoulli noise floor, Brier; `calibrators` rows; pairs from `training_labels` only |
| `meter.ts` | `prices` lookup by effective date, cost summed across billed attempts, `Budget` caps |
| `backends/` | `fixture` (replay by full `cacheKeyId`; a miss throws `FixtureMissError`; `record` mode), `jev` (SDK), `wire` (jeff/Kev/tev-local over fetch), `llm` (caller's `complete(messages, schema)`), sharing `systemone.ts` |

**Notes.**

- `jev` disables the SDK's retries and runs its own loop, so attempts are counted. A 429 is not
  billed. A timeout or 5xx retry is assumed billed at the successful attempt's tokens.
- `countTokens` is ⌈JCS length / 3⌉, because SDK 0.6.0 exposes no tokenizer. The estimate is
  deliberately high. Billing uses the returned `usage`.
- `wire` and `llm` digest their settings into `modelVersion`. `Backend.modelVFor(pin)` (now in
  core) gives the `model_v` the worker anti-joins on.
- Lint's ranking check fires only on an instruction to order things ("rank the …", "ranked
  by …"), not on a mention of ranking (an injection asking to be ranked highly).
- LLM probabilities are `discrete` unless the client returns them. They are never calibrated
  (`calibrated: false`, `backendConfidence: null`).
- Actions from `decide` are a threshold's own action, `escalate` (abstain band or fail-open),
  `human`, or `""` (fail-closed).

Tests: `npx vitest run` (fixture-backed, no network; an in-memory DuckDB via core's opener).
