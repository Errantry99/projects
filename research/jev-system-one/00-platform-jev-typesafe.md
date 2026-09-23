# Platform brief: Jev / TypeSafe AI (cross-cutting, for all 13 projects)

_Prepared 23 September 2026. Scope: the platform facts, access route, terms, fallbacks and shared engineering that every per-project document (`01`–`13`) can rely on, so they don't each re-derive them._

**How this was researched, and the limits.** Web search worked (about 11 queries). Page fetches were blocked by the sandbox proxy for `typesafe.ai`, `docs.typesafe.ai`, `dev.to`, `langchain.com`, `vercel.com`, `datacamp.com` and `explainx.ai`. Evidence is labelled by grade:

- **Primary:** the official SDK packages from npm and PyPI (types and source read) and GitHub repos read in full.
- **Search snippet:** TypeSafe's own docs or site text, seen through the search engine but not opened.
- **Secondary:** press and blog coverage, seen as snippets.

Anything with none of these behind it is marked **unverified**. The search budget ran out before the Models page, the Vercel changelog and the legal pages could be checked.

---

## 1. Summary

- **Jev is real.** TypeSafe AI came out of stealth on 15 Sep 2026 with a $40M seed led by DCVC (reported $200M valuation). The founder is Diogo Almeida (ex-OpenAI), with Erik Gafni and Sasha Sheng. Jev is a non-generative model: you send state plus typed questions (Choice / Score / Noul) and get bounded answers with probabilities.
- **The report is mostly accurate, but access is no longer waitlisted.** Since 20 Sep 2026 Jev is "available to everyone. No waitlist" (TypeSafe on X, plus secondary sources). Sign-up is at `console.typesafe.ai` with a reported **$5 free credit** (≈120M input tokens). The pricing, `jev-1.13.0`, the jaggedness page, both SDKs, the LangChain packages, the Claude Code skill, the awesome list, `jeff` and "openjev" all check out.
- **Two numbers need correcting:**
  1. **Cost per decision.** "~$0.0004 per decision" is high: an independent run measured **$0.000015–0.000023 per call** for states of a few hundred tokens.
  2. **State size.** "64k of state" may really be 64k per request, of which about 32k is state (**unverified**).
- **The eval numbers are TypeSafe's own.** Ground truth is frontier-model consensus, so they measure agreement, not accuracy.

**The top 5 things to do or obtain before building anything:**

1. **Get a console account and API key** (`console.typesafe.ai`, **unverified**), and choose direct access or a gateway. The gateways use different model IDs and request shapes.
2. **Read the MCA, Terms, Privacy Policy and DPA** (`typesafe.ai/legal/*`, not opened). Snippets show bans on offering the Services "as a standalone service" and on training a model "to imitate" Jev's output. The second constrains the NPC Director's local fallback and any distillation plan.
3. **Build the shared wrapper and eval harness first** (§7): pinned `jev-1.13.0`, per-decision logging, thresholds in config, and about 200 labelled examples per project.
4. **Keep the API key server-side.** The TS SDK blocks browsers unless `dangerouslyAllowBrowser` is set, so the extension and client apps need a proxy.
5. **Decide the Australian privacy position.** No AU region was found, and ZDR appears to be enterprise-only. Sending other people's data to the US is an APP 8 cross-border disclosure.

---

## 2. Verification of the source report's claims

| Claim (as stated in the report) | Verified? | What you found | Source URL |
|---|---|---|---|
| Company: TypeSafe AI, San Francisco, out of stealth 15 Sep 2026 | yes (SF: could not check) | Widely reported | https://finance.yahoo.com/technology/ai/articles/typesafe-ai-emerges-stealth-40m-190000776.html ; https://www.finsmes.com/2026/09/typesafe-ai-raises-40m-in-seed-funding.html |
| Founder Diogo Almeida, co-creator of RLHF / InstructGPT | yes | Co-founders Erik Gafni, Sasha Sheng | https://techstartups.com/2026/09/16/typesafe-ai-an-ai-startup-founded-by-chatgpt-co-inventor-emerges-from-stealth-with-40m-to-build-ai-thats-100x-faster-and-cheaper/ |
| $40M seed led by DCVC | yes | Several outlets; Forbes: $200M valuation | https://fundraiseinsider.com/blog/dcvc-leads-40m-seed-for-machine-native-ai-lab-typesafe/ ; https://www.forbes.com/sites/the-prompt/2026/09/15/this-200-million-startup-wants-to-fix-ais-overconfidence-problem/ |
| Launch date 15 Sep 2026 (early access) | yes | "Released in early access on September 15, 2026" | https://www.datacamp.com/blog/system-one-models-jev (snippet) |
| Three primitives: Choice / Score / Noul | yes (primary) | Defined in SDK types | npm `@typesafe-ai/sdk` 0.6.0 (`dist/index.d.mts`) |
| Choice: up to 255 options | partly | No SDK limit; openjev raises its cap to support "a 255-option choice", implying Jev's cap. Not seen on TypeSafe pages | https://github.com/razorback16/openjev |
| Score: 2–10 levels, can land between levels | partly | SDK: "at least two" levels; score "may fall between" levels. Max 10 not seen | SDK types |
| Noul: yes/no probability 0–1 | yes (primary) | Confirmed; Noul has no separate confidence | SDK types; https://github.com/typesafe-ai/skills |
| 64k-token state limit, text only | partly | Third-party: "64k tokens per request (32k for state plus the longest question)". Exact figure **unverified** | https://www.llmreference.com/model/jev (snippet); https://docs.typesafe.ai/model-jaggedness/jev-1.13 (snippet) |
| Latency 70–500 ms, most ~100 ms | partly | Independent: direct p50 313 ms / p90 423 ms, much of it network (~199 ms TCP handshake); jeff's author measured 129 ms p50. ~100 ms only near the servers | https://github.com/WallerChen/jev-measured ; https://github.com/logan-markewich/jeff |
| Price $0.042 / M input, output free | yes | Docs: "$0.042 per 1M input … $0.00 per 1M output"; oddly labelled "Jev-1.12 pricing" | https://docs.typesafe.ai/models (snippet) |
| ~$0.0004 per decision | partly (misleading) | Measured $0.0000153–0.0000226 per call (364–539 tokens); $0.0004 ≈ 9.5k tokens | https://github.com/WallerChen/jev-measured |
| Rate limits: 250k tokens/s, 1,200 req/min, move without notice | partly | Docs confirm tokens/s and req/min limits, 429, "can change without notice". The numbers were not seen | https://typesafe.ai/ and docs (snippet) |
| Model version jev-1.13 / pin jev-1.13.0 | yes | Quickstart response is `jev-1.13.0`; docs advise pinning. SDK default `jev-latest`; OpenRouter `typesafe/jev-1.13` | https://docs.typesafe.ai/model-jaggedness/jev-1.13 (snippet); https://github.com/AbdelStark/awesome-typesafe-jev ; SDK `ENV` |
| Schema errors 0% by construction | yes (by design) | Response types are closed unions | SDK types |
| Eval: 67.8%, tied with GPT-5.6 Terra / Claude Sonnet 5; below GPT-5.6 Sol 74.1% and Opus 5 73.1%; ~1/200th cost | partly | 67.8 / 74.1 / 73.1 and Terra tie confirmed; Sonnet 5 tie not seen. Four workflows: security, agent traces, invoices, customer service | https://www.datacamp.com/blog/typesafe-jev-vs-gpt-6-astra (snippet); https://evals.typesafe.ai/customer_service (listed) |
| Ground truth = consensus of GPT-6 Astra and Claude Fable 5.1 | yes (secondary) | "the reference answer is the average of two other frontier models, Astra and Fable 5.1, at high thinking" | https://dev.to/gabrielanhaia/jev-beat-gpt-luna-by-1-point-gpt-6-and-claude-wrote-the-answer-key-314k (snippet) |
| RLCD (Reinforcement Learning for Calibrated Decisions) | partly | Described by secondary sources ("0.8 should be right about 80% of the time"). TypeSafe's own description not opened. Independent audits are mixed | https://www.sanity.io/glossary/rlcd-reinforcement-learning-for-calibrated-decisions (snippet); https://github.com/jujumilk3/jev-calibration-audit |
| "Jaggedness" page for jev-1.13 | yes | Exists: literal reading, counting, numeric-vs-semantic, bounded context. Dates / context-rot / adversarial items not seen | https://docs.typesafe.ai/model-jaggedness/jev-1.13 |
| Python and TS SDKs | yes (primary) | TS `@typesafe-ai/sdk` 0.6.0 (MIT, Node ≥20, published 15 Sep). Python `typesafe-sdk` 0.7.1 (Python ≥3.10), plus a `typesafe-ai` redirect shim | https://registry.npmjs.org/@typesafe-ai/sdk ; https://pypi.org/project/typesafe-sdk/ |
| "One endpoint" | yes (primary) | `POST /v1/systemone`, plus `GET /v1/models` | SDK source |
| Vercel AI Gateway listing | partly | Community index cites a Vercel changelog: `typesafe-ai/jev` via AI SDK's experimental `evaluate`. Not opened. Cloudflare, Netlify and OpenRouter also listed | https://github.com/AbdelStark/awesome-typesafe-jev |
| LangChain integration | yes (primary) | npm `@langchain/typesafe` 0.0.1 (18 Sep) and PyPI `langchain-typesafe` 0.0.1a3 (alpha), both MIT | registry.npmjs.org; pypi.org |
| LangChain model-router middleware | could not check | LangChain blog exists but was blocked | https://www.langchain.com/blog/building-a-harness-with-jev (not opened) |
| Claude Code skill | yes (primary) | Official `typesafe-ai/skills` (MIT) Claude Code plugin | https://github.com/typesafe-ai/skills |
| awesome-typesafe index | yes | `AbdelStark/awesome-typesafe-jev` (≈487 stars, unaffiliated) | https://github.com/AbdelStark/awesome-typesafe-jev |
| jeff / GliFormer self-hosted drop-in | yes (primary) | `logan-markewich/jeff`, MIT, GLiFormer 400M; SDK-compatible, less accurate (§6) | https://github.com/logan-markewich/jeff |
| openjev (open logits-based re-implementation) | yes, but ambiguous | Five or more projects share the name. The "logits" match is `ekzhang/openjev-sglang`; the most-starred is `razorback16/openjev` | https://github.com/ekzhang/openjev-sglang ; https://github.com/razorback16/openjev |
| "Access is still waitlisted" | **no (outdated)** | Waitlist removed 20 Sep 2026; $5 free credit (secondary) | https://x.com/typesafeai/status/2101786156572823624 (listed); https://cryptobriefing.com/typesafe-jev-ai-public-access/ (snippet) |
| Week-one anecdotes (1,018 papers for $0.08; flight booked 7.1 s / $0.004; 12x/10x batching; $6.5k vs $30k per million tickets) | could not check | **unverified** | n/a |
| "Pricing may move; cannot show it isn't subsidised" | n/a (opinion) | Docs: limits shift "while large GPU deals land" | docs snippet |

---

## 3. Access & onboarding

**How to get a key today** (secondary sources; confirm on the console):

1. **Direct.** Sign up at `console.typesafe.ai`, create a key and set `TYPESAFE_API_KEY`. There has been no waitlist since 20 Sep, and the reported credit is $5 (≈120M tokens). Sign-up requirements (card, phone, organisation) are **unverified**.
2. **OpenRouter.** A separate decisions API (`/api/alpha/decisions`) with model `typesafe/jev-1.13` and OpenRouter's own request shape. One test measured p50 734 ms via OpenRouter against 313 ms direct, though other runs were closer.
3. **Vercel AI Gateway.** The AI SDK's experimental `evaluate` with `typesafe-ai/jev`.
4. **Cloudflare Workers AI** (`typesafe/jev`) and **Netlify AI Gateway**. Both are listed in the community index; **unverified**.
5. **Codiv** (not Jev). Hosts the open openjev on the same wire API and advertises 100M free tokens with no card. Good for dev and CI.

**Other access questions:**

- **Playground.** Not confirmed from any source I could open (**unverified**); it is likely in the console.
- **Enterprise.** Higher limits and ZDR via `sales@typesafe.ai`.
- **Commercial use.** The MCA frames a commercial relationship, subject to the standalone-service and distillation bans. Free-tier restrictions are **unverified**.

---

## 4. API surface, as documented

The primary source is the official TS SDK 0.6.0 type declarations and source, cross-checked against `jeff`'s compatible server and the docs snippets.

**Endpoints.** Base URL is `https://api.typesafe.ai`, and authentication is `Authorization: Bearer <key>`.

- `POST /v1/systemone` evaluates questions against a state.
- `GET /v1/models` returns `{ models: [{ name, description, release_date }] }` for the account.

**Request body.**

```json
{
  "model": "jev-1.13.0",
  "state": "text" | { "any": "json" } | [ ... ] | null,
  "questions": {
    "<id>": { "type": "choice", "instructions": "...", "criteria": { "billing": "Payments and refunds", "other": "None of the above" } },
    "<id>": { "type": "score",  "instructions": "...", "criteria": ["cosmetic", "degraded", "blocking"] },
    "<id>": { "type": "noul",   "instructions": "...", "criteria": { "true": "optional yes description", "false": "optional no description" } }
  }
}
```

`instructions` and each criterion can be a string, a JSON object or array, or `null`. `questions` must not be empty. Score criteria are an ordered list of at least two levels, indexed from 0.

**Response body.**

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "<choice id>": { "type": "choice", "choice": "billing", "confidence": 0.93, "probabilities": { "billing": 0.95, "other": 0.05 } },
    "<score id>":  { "type": "score", "score": 1.4, "confidence": 0.7, "legend": { "0": "...", "1": "..." }, "probabilities": { "0": 0.1, "1": 0.4, "2": 0.5 } },
    "<noul id>":   { "type": "noul", "noul": 0.82 }
  },
  "usage": { "input_tokens": 412, "output_tokens": 0 }
}
```

The numbers above are illustrative. The `model` field in the response reports the versioned ID that actually answered, even when the request used an alias.

**Batching.** Put many questions against one state in a single call; this is the documented fan-out pattern. The SDK has no multi-state batch endpoint. Packing many items into one state changes results: in one ordering study, batching 40 rows broke a passing ranking gate (yodablocks/jev-orderby-bench, cited in the awesome list).

**SDK install.**
- TS: `npm install @typesafe-ai/sdk` (Node ≥20).
- Python: `uv add typesafe-sdk` (Python ≥3.10).
- LangChain: `@langchain/typesafe` / `langchain-typesafe` (alpha).
- Beware the unrelated PyPI `jev` and npm `jev` packages.

**Versioning and pinning.** The SDK defaults to the moving alias `jev-latest`. The docs say to pin the versioned ID, so always send `model: "jev-1.13.0"` and log `response.model`. Gateway IDs differ.

**Errors.** The HTTP status maps to an SDK class:

| Status | SDK class |
|---|---|
| 400 | `BadRequestError` |
| 401 | `AuthenticationError` |
| 403 | `PermissionDeniedError` |
| 404 | `NotFoundError` |
| 422 | `UnprocessableEntityError` (validation) |
| 429 | `RateLimitError` (carries `retryAfterMs`) |
| 5xx | `InternalServerError` |

Transport failures raise `APIConnectionError`, with `APITimeoutError` as a subclass; a caller's abort raises `APIUserAbortError`. Every response carries an `x-typesafe-request-id` header, which should go into your logs.

**Timeouts and retries (SDK defaults).**
- 10 s timeout per attempt, with no overall budget.
- 2 retries, backoff 500 ms → 5 s with 25% jitter.
- Retries 408, 429, 5xx, connection errors and timeouts; honours `Retry-After` up to 60 s.
- A "100 ms" call can therefore take tens of seconds. Real-time projects (NPC, Home Intent, Live Meeting) should set `maxRetries: 0` and a short timeout, and fall back in code.

**Other behaviour.**
- **Idempotency:** the SDK has none (I searched the source). Calls are read-only, so a retry only costs a second charge.
- **Logging:** `logLevel: "debug"` logs request and response bodies unredacted, so keep it off wherever state contains PII.
- **Browsers:** blocked unless `dangerouslyAllowBrowser` is set.
- **Determinism:** not documented (**unverified**). The independent jev-calibration-audit tests option-order and question-interference effects. Include repeat calls and option shuffles in every eval.

---

## 5. Terms of service, data handling and licensing

The legal pages exist at `typesafe.ai/legal/terms`, `/legal/mca`, `/legal/privacy-policy`, `/legal/data-processing` and `docs.typesafe.ai/legal`. **I could not open any of them.** The points below come from search snippets of TypeSafe's own text; confirm them all before relying on them.

- **Training on customer data.** "TypeSafe will not include Customer Data in a dataset used to train any … models without Customer's prior consent". The Privacy Policy similarly says TypeSafe won't train on prompts or input.
- **Retention.** Zero data retention is offered for **enterprise** customers, so default-tier retention is **unverified** and presumably non-zero. The Privacy Policy says TypeSafe collects "prompts, data, instructions, and other input".
- **Roles.** The DPA makes the customer the controller and TypeSafe the processor for personal data. That puts Privacy Act and GDPR obligations to end users on the owner.
- **Acceptable use (seen):** no making the Services "available as a standalone service"; no using Output to "perform model distillation, train a model to imitate the output of the Services, or develop a similar service". Consequences:
  - the Guardrail Sidecar must not be a thin resale proxy;
  - the NPC Director's offline fallback must not be trained on Jev labels;
  - publishing a Jev-compatible server built from Jev outputs is off-limits.
- **Prohibited domains** (minors, safety-critical, surveillance, legal/medical): **could not check**. The docs stress that code owns the action. This matters most for the Moderator, Alarm Triage, Backcountry and Lease projects.
- **Regions:** **unverified**. No Australian endpoint was seen, and the evidence points to US hosting. My estimate is ~150–200 ms of round trip from Australia before any model time, so expect about 300–500 ms per call rather than 100 ms.
- **Australia:** sending other people's personal information offshore is an APP 8 cross-border disclosure. You generally stay accountable for how the recipient handles it and should disclose it in your privacy notice. Sensitive data (health, self-harm) raises the bar. This is general guidance, not legal advice.
- **Discontinuation:** notice and deprecation terms **could not check**. Assume short notice and keep the base URL swappable, with a tested open fallback.
- **Licences of the tooling:** SDKs MIT; skills MIT; LangChain packages MIT; jeff MIT; razorback16/openjev Apache-2.0 (DiffusionGemma weights Apache-2.0).

---

## 6. Fallbacks and alternatives

All of the options below speak the Jev wire API (`POST /v1/systemone`), so the official SDK works against them by changing `TYPESAFE_BASE_URL` / `baseURL`. The models, their calibration and their token counts are **not** Jev's.

| Option | Model / licence | Hardware | How close to Jev | Notes |
|---|---|---|---|---|
| **jeff** (logan-markewich/jeff) | GLiFormer-large 400M; MIT | CUDA / Apple MPS / CPU (ONNX int8). Modal L4 recommended; ~50 req/s per container | Same wire format and error codes (adds 529 for a full queue). Default limits: 64 questions, 64 labels, 20k chars of state. Choice and Score questions share an encoder pass and can influence each other | Author's own benchmarks: AG News 75.5% vs Jev 90.5%; JevBench 66.9 (#9) vs 75.3 (#2); hard tier 38% vs 74%. Good for dev and CI; weaker on reasoning-heavy items |
| **openjev** (razorback16) | DiffusionGemma 26B-A4B (NVFP4); Apache-2.0 | NVIDIA ≥24 GB (Docker image) or Apple silicon ~16 GB free (MLX); ~18 GB weights | Same API; accepts `jev-latest`. Adds an OpenAI-compatible chat endpoint. Also accepts **images** (Jev doesn't) | Hosted free tier at Codiv (100M tokens). The authors say to evaluate quality yourself |
| **openjev-sglang** (ekzhang) | Qwen3.6-35B-A3B NVFP4, prefill-only logits | One B200 per container on Modal | Same API; this is the "logits-based" re-implementation the report describes | Expensive hardware; scales to zero after 5 min idle, so cold starts |
| **Laya** (receptron/laya) | Independent Jev-compatible model; MIT client | Local ONNX Runtime; ~1.7 GB of weights | Choice / Score / Noul in one call | Node-native, which suits TS projects |
| **Luce** (scienthoon/luce) | Recipe: LoRA plus a decision head on Qwen3-4B-Base | 12 GB GPU | Train your own per-task decision model | An LLM teacher writes the data. Don't use Jev as the teacher (see §5) |

Stars and details are as of 23 Sep, from the repos' READMEs (primary), plus the awesome-list entries for Laya and Luce. None has independent calibration evidence comparable to Jev's claims.

**Roll your own: an LLM with structured outputs.** Send the same state with a JSON schema of enum or boolean fields, and read first-token logprobs where the provider exposes them.
- **What you lose:** calibration (verbalised confidence is poor, and some APIs, including Anthropic's as of my training data, expose no logprobs; **verify**) and latency.
- **Independent single-question measurement** via OpenRouter (https://github.com/WallerChen/jev-measured):

| Model | Median latency | Mean cost per call | Cost vs Jev |
|---|---|---|---|
| Jev | 352 ms | $0.0000188 | 1.0x |
| mistral-small-3.2-24b | 1,343 ms | $0.0000255 | 1.4x |
| gemini-2.5-flash-lite | 877 ms | $0.0000323 | 1.7x |
| gpt-5-nano | 7,504 ms | $0.0003434 | 18.3x |

- **Estimates (mine):**
  - Against small models, Jev's edge is small for one question and grows with fan-out.
  - Against reasoning-grade frontier models (typically 1–10 s per call), "~1/200th the cost" is plausible.
  - Keep a cheap-LLM adapter behind the wrapper as a degraded mode, and route more cases to humans when it is active.

---

## 7. Shared engineering foundation

**Stack.**
- **Recommendation:** TypeScript on Node 22 with `@typesafe-ai/sdk`, Vitest and Biome, matching the repo's toolchain.
- **Placement:** the existing repo is **"channel"**, an offline single-file writing app. Put the kit in a separate package (for example `packages/jev-kit`) or a sibling repo that reuses `biome.json` and the Vitest config, not in channel's `src/`.
- **Python:** use `typesafe-sdk` only where a project is inherently Python (the LangGraph sidecar). Keep logs and eval data as JSONL so both languages share them.

**Modules (≈600–900 LoC, estimate).**

1. **`schema.ts`.** Question sets as versioned data: id, `schemaVersion`, primitive, instructions and criteria.
   - Lint in tests: every Choice has `other` / `not_stated`; one judgment per question; no counting, arithmetic or date ordering; no request for a rationale.
   - Hash each question set and log the hash, so thresholds are tied to exact wording.
2. **`client.ts`.** A wrapper over `TypeSafeClient`.
   - The model is pinned (`jev-1.13.0`), and `baseURL` switches between TypeSafe, jeff, openjev and Codiv by environment.
   - Two presets: realtime (`maxRetries: 0`, 0.8–1.5 s timeout, AbortSignal) and batch (SDK defaults).
   - A shared 429-aware limiter, and a server-side key proxy for extension and client apps.
3. **`log.ts`.** One JSONL record per call:
   - **Context:** timestamp, project, `x-typesafe-request-id`, requested and returned model, provider, question-set hash, state hash (plus redacted state where privacy allows).
   - **Outcome:** per-question answer, probabilities and confidence; threshold-config version; action (auto / confirm / human / fallback); latency and retries; input tokens and cost.
   - **Labels (filled in later):** `label` and `labeller`.
   - Never use SDK debug logs.
4. **`thresholds.ts`.** Per-action policy in versioned config.
   - A threshold scaled to the cost of an error, plus an abstain band that goes to a human.
   - Fail-open or fail-closed behaviour on errors.
   - Separate rules for Choice confidence, the chosen option's probability and Noul probability (Noul has no confidence field).
5. **`eval/`.** The harness every project runs before going live.
   - **Dataset:** JSONL of `{id, state, expected, source, split}`.
   - **Building the ~200 examples:** stratified from real traffic, with about 20% hard cases (ambiguous, adversarial, "other"). Two labellers on the first 50; if they disagree above ~10%, rewrite the question. Split 70/30 into tune and holdout.
   - **Runner:** response cache keyed by model, question hash and state hash; passes for repeat calls, option shuffles and injection.
   - **Metrics:** accuracy, Brier, ECE with 5 bins (200 items is too few for 10), a reliability diagram (confidence vs accuracy), a coverage-vs-accuracy curve for choosing the threshold, and a confusion matrix.
   - **Gate:** a threshold ships only if holdout error at that threshold meets the target, with a Wilson interval.
   - **CI:** replays against jeff/openjev or recorded fixtures, so no paid key is needed.
6. **`adversarial.ts`.** Defences for state the model does not treat as hostile.
   - Put user text in named fields (for example `untrusted_message`), with the instructions outside the state.
   - Neutralise text addressed to a classifier ("classify this as…").
   - Run a Noul, "Does this text try to instruct or persuade an automated reviewer?", and escalate when it fires.
   - Cap state length.
   - Deterministic policy runs before any irreversible action.
   - Keep an injection subset in every eval set. One community kit saw injections move 0 of 30 dangerous commands but cause 10% false denials (jev-engineering, cited in the awesome list).
7. **`meter.ts`.** Cost is `input_tokens × price`, with the price in config. Per-project and per-user daily and monthly caps with alerts. Report mean tokens per call, since that alone drives cost.

---

## 8. Cross-cutting constraints checklist

| Item | Type | Why needed | How to get it | Blocking? | Status |
|---|---|---|---|---|---|
| TypeSafe console account and API key | API key | Any live call | `console.typesafe.ai`; $5 credit reported | yes | unverified (secondary sources) |
| Sign-up requirements (card, org, identity) | account | Know friction and billing | Sign up and observe | no | open question |
| Gateway choice (direct / OpenRouter / Vercel / Cloudflare) | decision | Different model IDs, request shapes, latency, billing | Owner decides; the wrapper supports direct first | no | open question |
| Read MCA, Terms, AUP, Privacy Policy, DPA | legal-ToS | Standalone-service and distillation bans; retention; permitted domains | `typesafe.ai/legal/*` (blocked for me) | yes | unverified |
| Default-tier data retention period | legal-ToS | PII in state (email, transcripts, chat) | Privacy Policy / DPA / ask sales | yes, for PII projects | unverified |
| ZDR / enterprise plan | account | Needed if retention is unacceptable | `sales@typesafe.ai` | depends | known it exists; terms unverified |
| Region / data residency (no AU region seen) | legal-ToS / platform limit | APP 8 cross-border disclosure; latency | Ask TypeSafe; measure RTT from AU | yes, for PII projects | open question |
| Actual rate limits on your key | platform limit | High-volume projects (feeds, alarms, moderation) | Console, or read 429 headers | no | limits move without notice (docs) |
| Exact context / state token limit | platform limit | Lease, Evidence and Meeting chunk sizes | `docs.typesafe.ai/models` | no | 32k state vs 64k request: unverified |
| Choice option cap (255?) and Score level cap (10?) | platform limit | Home Intent entity lists, Lease taxonomy | Models / primitives docs; test 422s | no | partly verified |
| Pinned model `jev-1.13.0` and its deprecation policy | decision / platform | Threshold validity over time | Docs; log `response.model` | no | pinning verified; deprecation policy unverified |
| Server-side key proxy for client apps | platform limit | SDK blocks browsers; key exposure | Build in the wrapper | yes, for extension / client projects | known |
| Latency budget from Australia | hardware / platform | Real-time projects | Measure p50/p95 from the owner's location | no (yes for the NPC/voice MVP) | open question |
| Labelled eval set (~200 per project) | data | Thresholds are meaningless otherwise | Owner labels from own traffic; two labellers on 50 | yes | open question |
| Self-hosted fallback (jeff on Modal, or openjev on ≥24 GB GPU / 16 GB Mac) | hardware | Dev, CI, outage, offline | Modal account, or local GPU / Apple silicon | no | known |
| Rule against training fallbacks on Jev outputs | legal-ToS | AUP distillation clause | Use an open teacher or human labels | yes, for NPC offline mode | unverified clause text |
| Privacy notice and consent for third-party data | legal-ToS | Privacy Act / GDPR; the owner is controller | Draft per project | yes, before public launch | open question |
| Safety-critical and minors positions | decision / legal | Moderator, Alarm, Backcountry, Home locks | Owner policy: advisory-only and human-in-loop | yes, for those projects | open question |
| Budget caps and billing alerts | account | Pricing may move; runaway loops | Console, plus `meter.ts` | no | open question |
| Shared wrapper / eval-harness repo location | decision | Reuse across the 13 projects | Owner picks a monorepo package or separate repo | no | open question |

---

## 9. Open questions for the owner

1. **Direct TypeSafe or a gateway?** Direct gives the exact contract, the exact pin and the lowest latency; a gateway consolidates billing. Recommendation: direct.
2. **Which personal data may go offshore, and who owns it?** Your own inbox is a lower bar than other people's Discord messages, meetings or leases. Does anything need ZDR or an enterprise agreement?
3. **Hard latency targets from Australia** for NPC (2–10 Hz), voice and live meetings? Measure before committing.
4. **Commercial intent.** Will any project, especially the Guardrail Sidecar, become a paid product? If so, get TypeSafe's written view on the "standalone service" clause.
5. **Fallback policy per project** when Jev is down: fail open, fail closed, human, or local model? Is running a self-hosted fallback worth the ops cost?
6. **Labelling.** Who labels about 200 examples per project, and from what data?
7. **Where the shared kit lives,** and are Python projects first-class?
8. **Upgrade discipline.** Will you re-run every eval before moving off `jev-1.13.0`?
9. **Safety- and minor-adjacent projects** (Moderator, Alarm, Backcountry): advisory-only by policy?

---

## 10. Sources

**Opened directly (primary):**
- https://registry.npmjs.org/@typesafe-ai/sdk. Official TS SDK metadata and README; the 0.6.0 tarball's `dist/index.d.mts` and `index.mjs` gave the API shape, defaults, errors and headers.
- https://registry.npmjs.org/@langchain%2ftypesafe. LangChain.js integration 0.0.1, 18 Sep 2026.
- https://registry.npmjs.org/jev, https://registry.npmjs.org/typesafe. Unrelated same-name packages (supply-chain note).
- https://pypi.org/pypi/typesafe-sdk/json. Official Python SDK 0.7.1, install and quickstart, docs and repo links.
- https://pypi.org/pypi/typesafe-ai/json. Redirect shim to `typesafe-sdk`.
- https://pypi.org/pypi/langchain-typesafe/json. LangChain Python integration 0.0.1a3.
- https://pypi.org/pypi/jev/json, https://pypi.org/pypi/openjev/json, https://pypi.org/pypi/gliformer/json. Third-party packages and name collisions.
- https://raw.githubusercontent.com/typesafe-ai/skills/main/README.md and `.../skills/typesafe-ai/SKILL.md`. Official Claude Code skill: install and doc map.
- https://raw.githubusercontent.com/typesafe-ai/typesafe-sdk-python/main/README.md. Python SDK repo README.
- https://raw.githubusercontent.com/AbdelStark/awesome-typesafe-jev/main/README.md. Community index: access routes (Vercel, OpenRouter, Cloudflare, Netlify), independent studies, alternatives.
- https://raw.githubusercontent.com/logan-markewich/jeff/main/README.md. jeff: API compatibility, limits, hardware, benchmarks vs Jev.
- https://raw.githubusercontent.com/razorback16/openjev/main/README.md. openjev: DiffusionGemma, hardware, licence, Codiv hosting, 255-option note.
- https://raw.githubusercontent.com/ekzhang/openjev-sglang/main/README.md. Prefill-only logits re-implementation on Qwen / SGLang / B200.
- https://raw.githubusercontent.com/WallerChen/jev-measured/main/README.md. Independent cost-per-call, latency (direct vs OpenRouter) and small-LLM comparison.
- GitHub repository search (GitHub MCP) for "openjev", "awesome-typesafe jev" and "jeff GliFormer". Repo list, star counts and creation dates.

**Seen only as search-result snippets (not opened):**
- https://typesafe.ai/blog/introducing-system-one-models-and-jev. Launch post (blocked).
- https://docs.typesafe.ai/models. Pricing $0.042/M input, $0 output; rate-limit wording.
- https://docs.typesafe.ai/model-jaggedness/jev-1.13. Jaggedness list; alias vs pinning guidance.
- https://docs.typesafe.ai/api. Endpoint, Bearer auth, response structure.
- https://typesafe.ai/legal/mca, https://typesafe.ai/legal/terms, https://typesafe.ai/legal/privacy-policy, https://typesafe.ai/legal/data-processing, https://docs.typesafe.ai/legal. No-training, ZDR-enterprise, controller/processor and AUP snippets.
- https://finance.yahoo.com/technology/ai/articles/typesafe-ai-emerges-stealth-40m-190000776.html. Stealth exit and $40M.
- https://techstartups.com/2026/09/16/typesafe-ai-an-ai-startup-founded-by-chatgpt-co-inventor-emerges-from-stealth-with-40m-to-build-ai-thats-100x-faster-and-cheaper/. Founders.
- https://www.forbes.com/sites/the-prompt/2026/09/15/this-200-million-startup-wants-to-fix-ais-overconfidence-problem/. $200M valuation.
- https://fundraiseinsider.com/blog/dcvc-leads-40m-seed-for-machine-native-ai-lab-typesafe/. DCVC lead.
- https://www.datacamp.com/blog/system-one-models-jev. Early-access launch date; headline claims.
- https://www.datacamp.com/blog/typesafe-jev-vs-gpt-6-astra. Eval figures 67.8 / 74.1 / 73.1; four workflows.
- https://dev.to/gabrielanhaia/jev-beat-gpt-luna-by-1-point-gpt-6-and-claude-wrote-the-answer-key-314k. Ground truth is frontier-model consensus.
- https://www.llmreference.com/model/jev. 64k per request / 32k state; GA date 20 Sep.
- https://www.sanity.io/glossary/rlcd-reinforcement-learning-for-calibrated-decisions. RLCD description.
- https://x.com/typesafeai/status/2101786156572823624. "Jev is now available to everyone. No waitlist."
- https://cryptobriefing.com/typesafe-jev-ai-public-access/. Waitlist removed 20 Sep; console sign-up with $5 credit.
- https://www.explainx.ai/blog/jev-general-availability-no-waitlist-2026. "$5 Free Credit" headline (fetch blocked).
- https://vercel.com/i/what-is-jev. Vercel explainer page exists (fetch blocked).
- https://www.langchain.com/blog/building-a-harness-with-jev. LangChain blog exists (fetch blocked; middleware claim unverified).

**Attempted and blocked by the sandbox egress proxy:** typesafe.ai, docs.typesafe.ai, dev.to, langchain.com, vercel.com, datacamp.com, explainx.ai.
