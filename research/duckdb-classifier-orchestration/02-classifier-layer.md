# 02: Classifier layer design (Workstream B)

_24 Sep 2026. GitHub, npm and PyPI worked; both official SDK packages were downloaded and their source read. docs.typesafe.ai was blocked. Tags: **[opened]**, **[search]** (snippet only), **unverified**. Numbers cited from `../jev-system-one/` keep that document's tag._

## 1. Summary

- **Verdict on the architecture.** Layer 2 ("JUDGE") merges two jobs, and I propose splitting it:
  - **`ask`** is backend-agnostic and cacheable. It returns raw probabilities.
  - **`decide`** calibrates, applies thresholds and picks an action, using rows in DuckDB keyed by *question content hash × backend × model version*.

  The hypothesis's cache key is too weak. "Question version" misses that probabilities depend on exact wording. The key also needs the backend's own calibration settings, and a hash of the *projected* state (only the fields sent).
- **Verdicts on the hypotheses:**

  | Hypothesis | Verdict | Why |
  |---|---|---|
  | H1 (steps are typed decisions) | Mostly supported | Filter, join, top-k, group-by and dedup reduce to Noul, Choice or Score plus SQL. Extraction and prose do not: an LLM writes them and a Noul verifies |
  | H3 (DuckDB is enough) | Supported for this layer | Calibrators, thresholds, labels and eval runs are small tables. All fits fit in under 200 lines of TypeScript (my estimate) |
  | H4 (≥80% cost cut) | No verdict from here | At personal volume Jev and a small LLM both cost cents a day, so the case rests on avoiding frontier calls |
  | H5 (no distillation breach) | Enforceable by schema | Labels record their source; the training export refuses labels from hosted backends |

- **Top three findings:**
  1. **The wire format is effectively standard, but the meaning of its fields is not.** jeff and Kev speak `POST /v1/systemone`, and Laya's Node client uses the same shape in-process. But confidence formulas differ, jeff lets Choice and Score questions influence each other, Laya silently truncates state at 512 tokens, and token counts are not comparable **[opened]**. The common layer must normalise meaning, not only shape.
  2. **A probability belongs to a phrasing on a backend, not to a judgment.** In one audit, a Noul and a two-option Choice asking the same thing differed by 0.125 on average. Removing the "unknown" option took accuracy on ambiguous items from 0.95 to 0.00, at 0.79 confidence **[opened: jev-calibration-audit]**. So the explicit "other" option is load-bearing, and thresholds cannot carry across rewordings.
  3. **Sample size sets how strict a guarantee can be.** At n=460, a 1% misroute target was infeasible, because 56% of Jev's answers were exactly 1.0 **[opened: jev-certify]**. Temperature scaling cannot separate those ties, so Jev needs isotonic or binned calibration, and about 500 labels per question.
- **Correction to doc 15.** SemIf is a Python batch scorer taking one question per row. I found no `/v1/systemone` server in its README **[opened]**. The local defaults should be:
  - **Kev** for a local server;
  - **Laya** in-process for CI and short states;
  - **SemIf** for calibration research.

## 2. Findings

### 2.1 How the real APIs differ

| Backend | Transport | Limits | Probabilities / confidence | Isolation | Notable |
|---|---|---|---|---|---|
| **Jev**, TS SDK 0.6.0 **[opened]** | HTTPS `POST /v1/systemone`, `GET /v1/models` | State ~32k tokens (**unverified**); 255 options (partly verified) | Confidence formula not public; Noul gives a probability only | Holds (0.4% flips, adversarial bundle) **[opened: audit]** | Response `model` is the served version; SDK defaults to `jev-latest`; 2 retries, 10 s timeout, no idempotency; unknown request fields forwarded; browsers blocked |
| **Jev**, Python 0.7.1 **[opened]** | Same; sync and async clients | Same | Same | Same | `state` non-null (TS allows `null`); Score `min_length=1` (TS demands 2); unknown answer types dropped; `extra_body` |
| **OpenRouter** **[opened: PHP SDK]** | `/api/alpha/decisions`, `typesafe/jev-1.13` | Same | Same | Same | Returns cost per call; doc 00 and the PHP SDK disagree on the body shape |
| **jeff** (GLiFormer 400M) **[opened]** | Jev wire; Python server | 64 questions, 64 labels, 20k state chars | Sigmoids at temperature 3.2; confidence `(p_max−1/n)/(1−1/n)` | **Choice and Score share a pass** unless `JEFF_ISOLATE=all` | AG News 75.5% vs Jev 90.5%; ~$2.6 vs ~$15.6 per 1M requests; token counts not comparable |
| **Kev** (Qwen3.5 0.8/4/9B + LoRA) **[opened]** | Jev wire; Python; CUDA/MLX; Modal | 255 options; 8,192 tokens served, 384 trained; one request at a time | Temperature ~2.1–2.4 per checkpoint; margin confidence, "not a measured accuracy rate" | Exact | `/permute`, `/separate`, `latency_ms`; Kev-9B 0.822 vs Jev 0.857 on new sources |
| **Laya** Node 0.1.2 **[opened]** | **In-process** ONNX; 1.7 GB weights | **State silently truncated to 512 tokens**; <~20 options | Calibration values in bundle | One pass | ~140 ms for 3 questions on Apple CPU |
| **SemIf** **[opened]** | Python JSONL CLI | One question per row | "Uncalibrated"; temperature per workload (WANLI ECE 0.208 → 0.069) | Rows independent | Prompt SHA-256 and model revision per row; no server |
| **System One Adapter** (official) **[opened]** | Python; OpenAI, Anthropic, Gemini | Provider | Verbalised `probabilities` or `discrete` | Model-dependent | Usage summed across retries; replayable attempt log |

Three facts matter for a common wire format:

1. **Criteria order.** Choice criteria travel as a JSON object, and JavaScript sorts integer-like keys first **[opened: jev-does-not-play-dice]**. Store an ordered array; lint out integer-like labels.
2. **Question IDs are not sent to the model**, so each question must carry its full meaning **[opened: typesafe-ai/skills]**.
3. **Confidence is not comparable across backends.** Threshold on calibrated option probability; log backend confidence only as a diagnostic.

### 2.2 What independent audits establish (jev-1.13.0)

- **Abstention lives in the option list.** On KoBBQ with "unknown" offered: accuracy 0.950, ECE 0.023 against a 0.024 noise floor. Without it: accuracy 0.000, the stereotype picked 79% of the time, confidence 0.79 **[opened: jev-calibration-audit]**.
- **Phrasing matters.** P(claim) + P(not claim) ranged from 0.71 to 1.42. Noul and two-option Choice differed by 0.125 on average. Option order moved probabilities by only 0.005 (0 flips in 400). Sixteen bundled questions cost 14 ms more than one. Fifty identical requests gave 15 distinct answer sets **[opened: same]**.
- **No evidence, high probability.** A fair die got 82.9% on the chosen face against 19.0% accuracy **[opened: jev-does-not-play-dice]**.
- **Coarse outputs.** 56.4% of answers were exactly 1.0, with 1.86% of them wrong. A scope gate missed its target by 3.3× when out-of-scope traffic rose from 13% to 43% **[opened: jev-certify]**.
- **Injection depends on framing.** One attack in 1,056 flipped Jev. But a one-line instruction took one task from 96.5% to 26.5%, and authority framing moved 3 of 30 dangerous commands. Text that "reads as evidence about the judged item" works **[opened: robustness list]**.
- **Publishing may be restricted.** jevcal says TypeSafe's agreement restricts publishing Jev performance numbers **[opened; clause unverified]**.

### 2.3 Semantic-operator prior art

- **LOTUS cascades.** In `sem_filter` and `sem_join`, a proxy scores every item, and sampled thresholds sort each item into accept, reject or ask-the-oracle. Targets are set as `recall_target`, `precision_target` and `failure_probability` **[opened]**. `sem_topk` ranks with an LLM comparator using quick, heap or naive methods.
- **The SDE (structured-data extraction) cascade** is TypeSafe's extraction pattern:
  1. a small model extracts the fields;
  2. a per-field Noul asks "absent?", "lifted from unrelated text?" and "format invalid?";
  3. only failed fields escalate to a reasoning model.

  **[search: docs.typesafe.ai/cookbooks/sde_cascade; opened: learn-ukrainian issue #8205, Anil-matcha list]**
- **Ranking needs care.** In jev-orderby-bench, 53 rows tied at 0.99, and packing 40 rows into one state broke a passing gate **[opened: awesome list]**.
- **SQL integrations already exist** (Workstream A): duckdb-jev, vgi-typesafe, pg-jev, jevql, mysql-ailike.

## 3. Design proposal

### 3.1 Split the layer: `ask` (raw) and `decide` (policy)

```
record ──SQL projection──▶ state ─▶ ask(backend) ─▶ RawDecision (cached) ─▶ decide(policy rows) ─▶ Action
                                     ▲ registry: question row (content hash)          ▲ calibrators, thresholds
```

- `ask` is a pure function of (projected state, question content, backend, model version, backend settings), so its output is cacheable and replayable.
- `decide` is cheap and re-runnable. Refitting a calibrator re-decides history without any model call, which lets Workstream D shadow-test policies over old traces for free.

### 3.2 Canonical types (TypeScript)

```ts
export type Primitive = "noul" | "choice" | "score";
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface QuestionDef {             // one row of `questions`
  id: string; version: number;             // for code only; never sent to the model
  contentHash: string;                     // sha256(primitive, instructions, options, fields, renderV)
  primitive: Primitive;
  instructions: Json;                      // self-contained
  options: ReadonlyArray<{ label: string; description: Json }>; // ordered
  noMatchLabel?: string;                   // required for Choice unless waived
  fields: readonly string[];               // JSON-path allow-list projected into state
  maxStateTokens: number;                  // refuse above this, never truncate
  dataClass: "public" | "internal" | "pii" | "sensitive";
  negationOf?: string;                     // enables the complement audit
  status: "draft" | "shadow" | "active" | "retired";
}

export interface RawAnswer {
  questionHash: string; primitive: Primitive;
  probs: Record<string, number>;           // Noul as {"true": p, "false": 1 - p}
  pick: string; backendConfidence?: number; // logged, never thresholded
}

export interface RawDecision {
  backend: string; modelVersion: string;   // served version + backend-settings digest
  requestId?: string; answers: RawAnswer[];
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number;
           basis: "provider-reported" | "token-price" | "gpu-amortised" | "zero" };
  latencyMs: number; retries: number; cacheHit: boolean;
}

export interface BackendCaps {
  primitives: ReadonlySet<Primitive>; maxOptions: number; maxQuestions: number;
  maxStateTokens: number; isolatesQuestions: boolean; dataResidency: "local" | "offshore";
}

export interface Backend {
  readonly name: string;
  caps(): BackendCaps;
  countTokens(state: Json): number;        // pre-flight for caps and budgets
  ask(state: Json, qs: readonly QuestionDef[],
      opts: { timeoutMs: number; maxRetries: number; signal?: AbortSignal }): Promise<RawDecision>;
}
```

Adapters:

- **Jev, Kev and jeff** share one `WireBackend` over `@typesafe-ai/sdk` with a different `baseURL`, but each reports its own `caps()`.
- **Laya** calls `laya.systemOne` in-process. It must count tokens *before* the call and refuse anything over 512.
- **LLM** turns each question into a strict JSON-schema field holding a per-label distribution. `modelVersion` includes the prompt-template hash and effort setting.
- **Fixture** replays recorded decisions by cache key, for Vitest.

### 3.3 Question registry, versioning and hygiene

**Versioning.**

- `contentHash` covers everything the model sees: instructions, ordered options, projected fields and the renderer version.
- Any change to the hash invalidates calibrators and thresholds.
- Labels survive a rewording only if the label set is unchanged and the owner marks the change `label_compatible`.
- `parent_hash` records lineage, so Workstream D's proposals can move from `draft` to `shadow` to `active` traceably.

**Lint rules**, run in Vitest and enforced at registration:

1. **Explicit "other".** Every Choice needs a no-match label (`other`, `not_stated` or `insufficient`). A waiver needs a stated reason and is allowed only when code guarantees the label set is exhaustive.
2. **Options.**
   - No integer-like labels.
   - Every label is unique.
   - Every option has a description that distinguishes it from its neighbours. Such descriptions added about 5 points, while restating the label name added nothing (doc 15).
3. **One judgment per question.**
   - Flag "and/or" joining two predicates.
   - Flag counting, arithmetic, date comparison and ranking. Those belong in code.
4. **Written for a literal reader.**
   - Spell out negation and scope ("explicitly asks", "in the latest message only").
   - Define terms.
   - Name speculative premises.
   - Reference state by backticked path (`ticket.body`).
   - No persona text, no request for a rationale, and nothing addressed to the model inside state.
   - The instruction must not depend on the question id.
   - Instruction language does not matter; content language does **[opened: audit]**.
5. **Score levels** describe concrete, self-standing situations.
6. **Every question** gets a field allow-list, a token cap and, where a mirror exists, `negationOf`.

### 3.4 Calibration and thresholds as data

**Tables** (they add to PLAN's candidate schema):

```sql
CREATE TABLE calibrators (
  id VARCHAR PRIMARY KEY, question_hash VARCHAR, backend VARCHAR, model_version VARCHAR,
  method VARCHAR,            -- 'identity' | 'temperature' | 'platt' | 'isotonic' | 'histogram'
  params JSON,               -- {T} | {a,b} | {knots:[[x,y],...]}
  n_fit INTEGER, fit_window JSON, ece DOUBLE, ece_floor DOUBLE, brier DOUBLE,
  status VARCHAR,            -- 'candidate' | 'active' | 'stale'
  created_at TIMESTAMP);
CREATE TABLE thresholds (
  id VARCHAR PRIMARY KEY, question_hash VARCHAR, backend VARCHAR, model_version VARCHAR,
  calibrator_id VARCHAR, action VARCHAR,
  rule JSON,                 -- {label, min_p, abstain_band:[lo,hi], on_error:'human'|'fail_closed'|'fail_open'}
  cost_matrix JSON,          -- {wrong_auto, human_review, llm_call, llm_error_rate}
  alpha DOUBLE, delta DOUBLE, certified_loss DOUBLE, coverage DOUBLE, n_cal INTEGER,
  status VARCHAR, fitted_at TIMESTAMP);
```

`decisions` gains `question_hash`, `state_proj_hash`, `probs_raw`, `probs_cal`, `calibrator_id`, `threshold_id`, `action`, `cache_hit`, `retries`, `cost_usd` and `cost_basis`. `labels` gains `labeller_kind` (`human` | `llm:<model>` | `rule`) and `trainable BOOLEAN`.

**Which fit to use.** Fit per (question hash, backend, model version), chosen by n and backend:

| Method | Use it when | Notes |
|---|---|---|
| **Temperature** (one scalar T, fitted by NLL) | Default for Choice and Score from logit-based backends (Kev, SemIf, LLM probabilities) | Never changes the argmax. SemIf's fitted T ranged 1.23–2.50 by workload **[opened]** |
| **Platt** (a, b) | Noul | Two-parameter recalibration removed 96% of error in one audit (doc 15, via the robustness list) |
| **Isotonic or histogram binning on the chosen probability** | Jev, and whenever n ≥ ~1,000 | Jev returns exact 1.0 on most items, so temperature cannot split ties. Isotonic took ECE 0.117 → 0.008 on 8,801 rows (doc 15) |
| **Per-level temperature on Score**, thresholded on P(level ≥ k) | Score | Treat Score as ordinal; the expected score hides bimodal distributions |

Backends already apply their own temperatures (jeff 3.2, Kev 2.1–2.4, Laya's bundle). Record those settings in `model_version` and fit on top of them.

**Thresholds scaled to the cost of error.** Each action has a cost matrix:

- **Auto-act** when calibrated p ≥ 1 − C_human / C_wrong. For example, a wrong auto-archive costs $50 and a human glance costs $0.50, so auto-act needs p ≥ 0.99.
- **Escalate to an LLM** in the band where C_llm + e_llm·C_wrong beats both auto-acting and human review.
- **Send to a human** below that band.

That cost-optimal point is then *certified* on held-out data with conformal risk control: loss per incoming item ≤ α, with failure probability δ **[opened: jev-certify method]**. The row stores α, δ, `certified_loss` and coverage. If the certificate is infeasible at the current n (jev-certify's 1% case), the action ships in human-review mode only. Prevalence is a first-class input, so monitor the "other" rate and the out-of-scope rate, and re-certify when either moves.

**Re-fit on model change.**

1. Pin versions; lint bans `jev-latest`.
2. If `response.model` differs from the pin, alert and drop the decision to human review.
3. A new version marks its calibrators and thresholds `stale` and triggers a shadow run on the frozen eval set.
4. Refit, gate, and promote only on the owner's approval. Old decisions stay replayable through `calibrator_id`.

### 3.5 Eval harness

**Sizes.**

- 50 double-labelled rows test the question itself: if labellers disagree above ~10%, rewrite it.
- About 200 rows for a first threshold.
- **≥500 per question** before comparing backends or claiming calibration.
- Splits are group-disjoint (by thread or customer), as in SemIf and Kev.

**Metrics.**

- Accuracy, Brier, NLL and a confusion matrix.
- ECE with 5 bins at n≈200, **always shown next to its noise floor**. The floor is simulated by drawing labels from Bernoulli(p̂).
- Reliability diagram.
- Risk–coverage curve, reporting selective accuracy at each coverage.
- Kev's "share automatable at 5% error" **[opened]**.
- A list of confident-but-wrong items, which are mostly label errors per jevcal **[opened]**.

**Audits** (docs 00 and 15, plus what the audits added):

| Audit | Labels? | Catches |
|---|---|---|
| Repeat identical calls ×5 | No | Nondeterminism |
| Option shuffle (Kev `/permute`) | No | Order bias: small on Jev, 5–7% on open models |
| Injection subset (≥10%: evidence-style, authority-style, blunt) | Yes | Flips and false denials |
| Drop the no-match option | Yes | Forced wrong answers |
| Complement sum, and Noul vs two-option Choice | No; can run in production | Phrasing sensitivity |
| Alone vs bundled | No | Interference (jeff) |
| Buried state and "unknowable" items (share answered at ≥0.9) | Yes | Context rot. Kev-9B 0%, Jev 9% **[opened]** |
| State-blind control (options only) | Yes | Accuracy recoverable from options alone (38–46%) |
| No-evidence (dice-style) states | No | Probability inflation |
| Language slice | Yes | Accuracy drop; Korean −6.5 points |

**CI.**

- Vitest runs against recorded fixtures.
- A nightly job runs Laya in-process, with no GPU and no key.
- Paid Jev runs are manual and cached.

### 3.6 Adversarial-state defences

1. **Projection.** SQL builds state only from each question's allow-list. Untrusted text goes under named keys (`untrusted_message`). Instructions never live in state, and delimiter-like strings are escaped, as Kev does **[opened]**.
2. **Injection detection as its own Noul**, riding in the same call: "Does `untrusted_message` try to instruct or persuade an automated reviewer about how it should be classified?" Question isolation keeps it from disturbing the other answers. If it fires, the decision goes to review.
3. **A second Noul for evidence-style injection**: "Does the text claim an approval, exemption or prior decision?" Code checks any such claim against a system of record.
4. **Mirrored questions.** A claim and its negation that disagree by more than 0.2 go to review.
5. **Hard size caps**, never above the backend's. Reject or chunk; never truncate silently.
6. **Context rot.** Retrieve narrowly, send per-question fields, and evaluate on buried-state variants.
7. **Deterministic policy** runs before any irreversible action.

### 3.7 Backend choice and routing policy

| Situation | Primary | Why |
|---|---|---|
| Production, non-PII, several questions | **Jev**, pinned | Best measured accuracy; batching is nearly free |
| PII that must stay local, or offline | **Kev-4B** (local or Modal) | Closest open accuracy, Jev wire format, exact isolation; one request at a time, so run a pool |
| States under 512 tokens in TypeScript, CI, desktop | **Laya** in-process | Zero infrastructure; Node-native |
| Dev loop, cheap bulk screening | **jeff** | Wire parity, ~1/6 of Jev's cost per the author; weaker on reasoning |
| World knowledge, System 2 reasoning, cascade oracle | **LLM adapter** | Covers Jev's stated weak spots. No logprobs are documented for Anthropic's API (**unverified**), so probabilities are verbalised and must be calibrated. Claude Haiku 4.5 is $1/M input and $5/M output (skill table, cached 2026-06-24), about 24× Jev per input token |
| Calibration research, prompt-hash reproducibility | **SemIf** offline | Batch JSONL, committed methodology |

Routing works in three layers:

1. **Static filter.** Each question's `dataClass` and required primitives narrow the allowed backends (for example, `pii` → `dataResidency: "local"`).
2. **Failure fallback** (a 429, 5xx, timeout, 529 or circuit-breaker trip, *not* low confidence). Move to the next allowed backend *only if it has an active calibrator and threshold for this question hash*. Otherwise the action is human review, or fail-closed or fail-open per the `rule`.
3. **Cascade escalation** (low confidence) is a separate path. The abstain band goes to the LLM oracle or a human, as LOTUS's proxy-and-oracle cascade does.

Real-time callers use `maxRetries: 0` and a 0.8–1.5 s timeout. Fallback decisions carry `degraded=true`.

### 3.8 Cost metering

`cost_usd` is stored per decision, with `cost_basis`:

| Basis | Backends | How it is computed |
|---|---|---|
| `provider-reported` | OpenRouter | The response carries the cost |
| `token-price` | Jev, LLM | Input tokens × price (plus output tokens for LLMs), from a `prices` table with effective dates. Jev: $0.042/M input, $0 output **[search, doc 00]**, measured at $0.000015–0.000023 per call **[opened: jev-measured, doc 00]** |
| `gpu-amortised` | Kev, jeff | GPU $/h × latency ÷ concurrency. Kev's table gives $0.80–3.95/h GPUs at 20–200 ms per request **[opened]** |
| `zero` | Laya, cache hits | Marginal cost only |

Rules:

- **Retries.** The SDK has no idempotency, so each retry is billed. Sum across attempts, as the adapter's `input_tokens_total` does.
- **Budget pre-flight.** Use `countTokens` against per-project daily caps before the call.
- **Report mean tokens per call.** Never compare token counts across backends; jeff says its counts are not comparable **[opened]**.
- **Cost per correct automated decision** (total cost ÷ items auto-decided correctly) is the number H4 needs.

### 3.9 Semantic operators onto the primitives

| Operator | Mapping | Notes |
|---|---|---|
| `sem_filter(p)` | One Noul per row; SQL `WHERE p_cal ≥ t` | Cascade: accept above t_hi, reject below t_lo, send the middle to an LLM oracle with LOTUS-style recall and precision targets |
| `sem_join(L,R,p)` | **Blocking in SQL** (equality keys, full-text search, embedding top-k) produces candidate pairs; then a Noul per pair on state `{left, right}` | For 1:N "which one", use a Choice over the blocked candidates plus `none`: ≤20 options on Laya, 64 on jeff, 255 on Jev/Kev. Never judge the full cross product |
| `sem_topk(k)` | A Score per item, **one item per state**, `ORDER BY` in SQL; tie-break the top m (m≈3k) with pairwise Choice in a quickselect or heap | Packing many items into one state broke ranking gates (§2.3). On open models, run each pair in both orders and average |
| `sem_group_by` | Stage 1: an LLM or embedding clustering proposes cluster labels, which become a **question version**. Stage 2: a Choice over the labels plus `other` | A rising `other` rate is the drift signal to re-cluster, with a new question hash |
| `sem_dedup` | Blocking plus a Noul per pair ("same underlying event?") | Transitive closure in SQL |
| `sem_agg` | Not a primitive | Code aggregates the decisions; an LLM writes any prose |
| `sem_extract` / `sem_map` | **Not Jev** (it does not generate) | Either (a) "select instead of generate": code enumerates candidate spans and a Choice picks one or `not_stated`; or (b) the SDE cascade: an LLM extracts, a Noul per field verifies, and failed fields escalate |

### 3.10 Where Python is unavoidable

These need Python:

- running the Kev, jeff, SemIf and openjev servers;
- fine-tuning (Kev, open-jev);
- Laya ONNX re-export;
- the official LLM adapter, unless we port it (about 300 lines; my estimate).

Everything else is TypeScript: the registry, lint, adapters, fits, conformal thresholds, metrics, and DuckDB through its Node bindings. Python only ever sits behind `/v1/systemone`, or runs as a JSONL batch job that writes into DuckDB.

## 4. Prior art and alternatives

| Project | What it is | Use for us | Differs from this design |
|---|---|---|---|
| Official SDKs and system-one-adapter-python | Jev clients; LLM behind the Jev interface | Base of the adapters | No calibration, thresholds or registry; adapter is Python only |
| jevcal | Per-question threshold at a target accuracy; lockfile; CI re-check | Closest to our `thresholds` table | Python and YAML; no conformal certificate |
| jev-certify | Conformal risk control, prediction-powered audits | Certificate and audit method | Research code, one dataset |
| Janus | Jev → LLM cascade thresholds | Cascade pricing | Parameters did not transfer between datasets |
| jev-calibration-audit, Kev benchmark | Invariance audits; automatable share, unknowable items | Audit list and metrics | One version or one model |
| LOTUS | Semantic operators with proxy/oracle cascades | Operator semantics | LLM-only, pandas |
| Second Thought | Captures Laya/Jev decisions, measures calibration, routes to review | Closest overall product | Python; its Laya result is a 24-ticket run |
| duckdb-jev, vgi-typesafe, pg-jev, jevql | SQL predicates over Jev | Workstream A | One backend, no calibration layer |

## 5. Constraints & prerequisites

| Item | Type | Why needed | How to get it | Blocking? | Status |
|---|---|---|---|---|---|
| TypeSafe key; pinned `jev-1.13.0`; deprecation policy | API key | Thresholds are tied to a version | console.typesafe.ai | Yes, for Jev | Key unverified; pinning verified |
| AUP: distillation, standalone service, publishing benchmarks | legal-ToS | H5; whether our eval numbers may be published | Read `typesafe.ai/legal/*` (blocked here) | Yes, before training or publishing | Unverified |
| Kev weights plus a GPU (L4 to H100) or Modal | hardware | Local backend for PII | Hugging Face, Modal | No | Known |
| Laya bundle (1.7 GB), pinned `revision` | data | CI backend | First-run download | No | Known |
| Labelled sets: 50 double-labelled; 200 to start; ≥500 per question to compare | data | Every threshold | Owner labels real traffic; LLM for pre-labels only | Yes | Open |
| Cost matrix per action | decision | Threshold formula | Owner, per project | Yes, for auto-actions | Open |
| Which data classes may go offshore | decision / legal | Static routing filter | Owner, plus APP 8 review | Yes, for PII | Open |
| Anthropic logprobs | platform limit | LLM probability quality | API docs | No | Unverified |
| OpenRouter request shape | platform | Gateway adapter | One test call | No | Conflicting sources |
| Package location, not channel's `src/` | decision | Repo hygiene (doc 00 §7) | Owner | No | Open |

## 6. Risks & open questions

| Risk | Mitigation |
|---|---|
| **Calibration does not transfer** across rewordings, versions, prevalence or language | Key everything on the content hash; run the complement audit in production; monitor prevalence; re-certify on drift |
| **Coarse probabilities.** Jev's mass at exactly 1.0 caps how strict a guarantee can be | Strictest actions go to human review. Ask TypeSafe whether unrounded probabilities are available |
| **Silent truncation on local backends** (Laya's 512 tokens; Kev trained on 384) | Hard caps in adapters; buried-state evals |
| **LLM-teacher labels contaminate ground truth** | `labeller_kind`; human spot-checks; prediction-powered audits |
| **Caching hides nondeterminism** | Repeat-call audits; record variance with each calibrator |
| **A fallback backend has its own error profile** | It never auto-acts without its own fitted threshold (§3.7) |

Open questions:

- Does TypeSafe's clause cover *evaluating* students with Jev, or publishing comparisons?
- Is Kev's single-request server enough, or do we need a batching server?
- Can proposed questions from Workstream D reuse labels across `label_compatible` rewordings without biasing thresholds?

## 7. Sources

Opened (primary):

- **TypeSafe official:**
  - https://registry.npmjs.org/@typesafe-ai/sdk (the 0.6.0 tarball: types, source, README);
  - https://pypi.org/pypi/typesafe-sdk/json (the 0.7.1 wheel: wire schemas, clients, retry);
  - https://raw.githubusercontent.com/typesafe-ai/system-one-adapter-python/HEAD/README.md;
  - https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md.
- **Backends:**
  - https://raw.githubusercontent.com/logan-markewich/jeff/main/README.md;
  - https://raw.githubusercontent.com/receptron/laya/main/README.md and https://registry.npmjs.org/@receptron/laya;
  - https://raw.githubusercontent.com/jaredpalmer/kev/main/README.md;
  - https://raw.githubusercontent.com/TheoLeeCJ/SemIf/HEAD/README.md, plus `docs/CALIBRATION.md` and `docs/METHOD.md`.
- **Audits and tools:**
  - https://raw.githubusercontent.com/jujumilk3/jev-calibration-audit/HEAD/FINDINGS.md;
  - https://raw.githubusercontent.com/nikkoxgonzales/jev-certify/HEAD/results/REPORT.md;
  - https://raw.githubusercontent.com/KantaHayashiAI/jev-does-not-play-dice/HEAD/README.md;
  - https://raw.githubusercontent.com/abhixhek/jevcal/HEAD/README.md;
  - https://raw.githubusercontent.com/Fox-Islam/typesafe-sdk-php/HEAD/README.md (OpenRouter path and cost field).
- **Indexes:**
  - https://raw.githubusercontent.com/AbdelStark/awesome-typesafe-jev/main/README.md;
  - https://raw.githubusercontent.com/Anil-matcha/awesome-jev-by-typesafe/HEAD/README.md;
  - https://raw.githubusercontent.com/Yifan-Lan/awesome-jev-robustness/HEAD/README.md.
- **Semantic operators and the SDE cascade:**
  - https://raw.githubusercontent.com/lotus-data/lotus/HEAD/README.md, plus `docs/sem_topk.rst`, `sem_join.rst`, `sem_filter.rst` and `approximation_cascades.rst`;
  - https://github.com/learn-ukrainian/learn-ukrainian.github.io/issues/8205 (SDE cascade stages).
- **Other:** the bundled Claude API skill (price table cached 2026-06-24; no logprobs documented).

Search snippet only: https://docs.typesafe.ai/cookbooks/sde_cascade.

Blocked: docs.typesafe.ai, systemonemodels.org.

Earlier documents used: `../jev-system-one/00-platform-jev-typesafe.md`, `15-small-models-as-system-one-classifiers.md`, `00-source-report.md` (Part 2).
