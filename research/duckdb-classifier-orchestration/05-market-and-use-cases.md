# 05 · Market, prior art, positioning and first use cases

_Workstream E, 24 Sep 2026. Web access: WebSearch worked; WebFetch worked for github.com and PyPI,
and raw READMEs were read with curl. Fetches were blocked for motherduck.com, duckdb.org,
openrouter.ai, databricks.com, docs.cloud.google.com, astronomer.io and arxiv.org, and the GitHub
REST API refused this session. Tags: **[opened]** = I read the page or file; **[search]** = search
snippet only; **unverified** = neither. Star counts are from GitHub pages on 24 Sep._

## 1. Summary

- **Layers 1 and 2 are already a commodity, nine days after launch.**
  - Jev in SQL: MotherDuck `prompt_jev()` [search], at least four open DuckDB extensions
    (`prasanthj/duckdb-jev`, Apache-2.0, 1,943 rows/s live [opened]), plus `pg-jev` and
    `sqlite-jev` [opened].
  - Jev as judge: LangSmith, Langfuse, Braintrust and an Arize Phoenix PR [search].
  - We should adopt these, not compete with them.
- **Layer 4 has no complete competitor.** That is mining *untyped* agent traces for recurring
  decisions, proposing typed questions, shadowing them against the agent, and promoting them with
  human approval. The pieces exist apart:
  - learn already-typed calls: `stuntd`;
  - compare in shadow: `stuntdouble`;
  - calibrate and write a lockfile: `jevcal`;
  - compile prose rules: `jevc`;
  - rewrite a prompt as questions: OpenRouter;
  - distil SQL operators: BigQuery optimized mode, LOTUS;
  - distil traces into weights: DSPy, Distil Labs;
  - analyse traces: TensorZero Autopilot.

  Combining them in one embedded store is the wedge. It is narrow: OpenRouter, LangSmith,
  Langfuse, TensorZero or TypeSafe could close it in weeks.
- **Challenge to the architecture:** make layer 3 **optional**.
  - Discovery should import traces people already have: OTel GenAI, LangSmith/Langfuse/Phoenix
    exports, Claude Code transcripts.
  - Promoted processes should export as a **portable lockfile** that runs without our runtime.
- **Why now:** Jev labelled 100k rows in 40 s for $0.50, against about 32 min and $37.58 for
  gpt-5.6-terra (MotherDuck) [search]. Agent token bills are a 2026 headline [search].
- **Who pays:** solo builders expect everything free, and data teams already have `prompt_jev`.
  **Platform teams running agents at volume** would pay, for evidence, approvals and audit rather
  than for the runtime.
- **First two internal customers:**
  1. **Evidence Screener:** public author-labelled data (SYNERGY), an offline all-LLM baseline,
     all four layers, about a week to an H4 result.
  2. **Inbox Reflex:** live, with drift, HITL review and free labels, but its H4 margin is thin
     because drafts stay generative.

  Guardrail Sidecar is infrastructure (the trace tap), not a customer.
- **Verdicts on the hypotheses:**

  | Hypothesis | Verdict | Reasoning |
  |---|---|---|
  | **H4** | Likely true against a frontier-model agent (Evidence Screener ~85–92%, my estimate) | Borderline for Inbox Reflex (~79–85%). False against a cheap small LLM, where Jev is only 1.4–1.7× cheaper (platform doc §6). |
  | **H1** | Supported in spirit | `jevc`'s sample project: 16 of 32 agent rules decidable [opened; illustrative]. |
  | **H2** | Partly supported | LLM-labelled samples do train good proxies (BigQuery, LOTUS, stuntd). But Jev scored 62.6% on one phishing question and **95% split into five atomic questions** [search], so discovery must propose decompositions. |
  | **H5** | Achievable, but others already cross the line | stuntd's Jev-teacher mode is the banned distillation pattern [opened]. |

## 2. Findings

### 2.1 The judge-in-SQL layer is crowded

**DuckDB extensions:**
- `prasanthj/duckdb-jev` [opened]: a native C++ extension, Apache-2.0. Batches up to 1,000
  judgments per request, with per-query budgets, an LRU/TTL cache, `jev_stats()` and signed
  releases.
- `recodelabs` and `judoaseeta` [opened] copy pg-jev's API (`jev()`, `jev_prob()`,
  `jev_choice()`, `jev_score()`). pg-jev measured **100% correct at 1–20 rows per request, 92–98%
  at 40 and 77–94% at 80**. Batching changes answers, so the cache key must record the batch
  mode, or we send one record per state.
- Query.Farm `vgi-typesafe` exposes Choice, Noul and Score as `LATERAL` table functions
  [opened list entry].

**Semantic operators and SQL LLM tooling** [opened]:
- FlockMTL/Flock (MIT, 359 stars): LLM functions only.
- BlendSQL (Apache-2.0, 169 stars): DuckDB support and constrained decoding.
- LOTUS (Apache-2.0, 1.7k stars): cascades and proxy models with statistical guarantees.
- DocETL (MIT, 4.1k stars): its optimiser "replaces subtasks with code".
- Palimpzest/Abacus (MIT, 238 stars): cost-based optimisation.
- None of them has a decision-model backend.

**Warehouses:**
- **BigQuery `AI.IF`/`AI.CLASSIFY` "optimized mode"** is the closest vendor analogue of "compile
  the LLM". It labels a sample with Gemini and trains a just-in-time proxy, reporting ~400× fewer
  tokens per million rows [search]. It works per query, not per agent step, and it is invisible:
  no registry, no promotion.
- Snowflake `AI_CLASSIFY`/`AI_FILTER` bill input and output tokens at $2.00–2.20 per AI Credit
  [search].
- Databricks Agent Bricks offers "cost- vs quality-optimized" choices and `ai_classify` [search].
- Neither Snowflake nor Databricks compiles agent traces into typed questions.

### 2.2 Evals and observability absorbed Jev within a week, but only as a judge

- **LangSmith:** "Can Jev be a better agent evaluator?" plus online evaluators, 22 Sep [search].
- **Langfuse:** "decision-model evaluators", 22 Sep; it claims 40–400× lower cost [search].
  MIT core, 35k stars, ClickHouse [opened].
- **Braintrust:** a Jev scorer, 18 Sep [search].
- **Arize Phoenix:** PR #16367 adds Jev classification evaluators. Phoenix is ELv2, 11.6k stars
  [opened].

All of these score traces after the fact. None proposes "this span is a recurring decision;
replace it". Braintrust and Laminar market cost attribution, not replacement [search]. They are
the most likely fast followers, because they already hold the traces and the Jev integration.
Humanloop is gone: Anthropic acqui-hired the team and the platform shut down on 8 Sep 2025
[search].

### 2.3 "LLM to cheaper thing" compilation: the nearest neighbours

**Jev-native (launch week):**

| Project | What it does | Why it matters to us |
|---|---|---|
| **stuntd** [opened] (Apache-2.0, 19 stars, PyPI 0.1.0) | Records typed decisions (Jev protocol, or OpenAI calls whose `response_format` is a single enum, boolean or number). Trains a head per decision site on frozen Laya, shadows to a target, serves locally with an upstream fallback, and demotes itself on drift. Reports 90% of support-triage questions answered locally at 0.99 agreement. | The **closest competitor**, but blind to untyped reasoning turns. Its Jev-teacher mode is the pattern the distillation clause bans. |
| **stuntdouble** [opened] | Shadow proxy with a swap verdict. | Its "policy agreement" (does the app's action change?) is worth copying. |
| **jevcal** [opened] | Question lint, LLM-teacher labels, thresholds fitted on a held-out split, `decisions.lock.json`, a CI drift gate, LLM question rewrites. | Claims TypeSafe restricts publishing Jev performance numbers. |
| **Janus** | Measures a cascade policy on your own data. | Found the cascade cost 47% more for the same accuracy on Web of Science. |
| **jevc** [opened] | Scans `CLAUDE.md`/skills, sorts rules into decidable, procedure and generation, and compiles decidable rules into questions plus a reducer and a "residual prompt". | **Static** discovery from prose; ours is dynamic, from traces. |

**Other Jev-native efforts:**
- `reflex` issue #5 [opened]: a proposed static `jev-audit` of LLM call sites, with a
  "shadow week".
- OpenRouter's "Prompt to questions" and its "Jev-verified cascade" cookbook (0 wrong at $0.012 on
  50 questions, against 2 wrong at $0.175 for Astra) [search].
- jev-tests #3 [opened]: plans tool routing from 200–500 coding-agent decision points; no
  results yet.

**Adjacent, compiling to weights or prompts:**
- DSPy (MIT, 38.2k stars): `BootstrapFinetune` and GEPA.
- TensorZero (Apache-2.0, 11.7k stars): paid **Autopilot** "analyzes historical LLM traces", in
  private beta [search].
- Distil Labs Agent Distillation: traces to a small language model, "cut LLM costs by 80%"
  [search].
- OpenPipe: acquired by CoreWeave [search].

**Research:** TrajectoryDB (a vision paper, Sep 2026) argues for a trajectory-native store for
"runtime optimization"; ClawTrace covers cost-aware skill distillation [search].

### 2.4 Routing and cascades are a funded category, so we should not sell a router

- Martian has raised $32M in total [search]. Not Diamond has repositioned towards
  coding-agent routing [search].
- Jev-native routers: JevRouter (MIT; 44% vs 24% position-wise tool-call hits against DeepSeek
  V4.1 Flash on 10 Toolathlon tasks) [opened]; `jev-router` (126 stars in two days) [search].
- The honest counter-evidence: `scarif-labs`' dependency auto-merge study found AUROC 0.851 in
  distribution, but the tuned threshold failed out of distribution (50% precision, 15 unsafe merges
  in 185 cases) [opened list entry]. Promotion needs drift gates, not a one-off calibration.

### 2.5 Demand signals

- **Builders:** 274+ Jev repos [search]; 42 guardrail repos in 8 days (doc 03); at least eight
  Gmail-triage repos (doc 01).
- **Cost pain** [search]: "The token bill comes due" (TechCrunch, Jun 2026); a 1,278-point HN
  post about a $6,531 agent AWS bill; Claude Code enterprise use averaging $13 per developer per
  active day.
- **DuckDB appetite:** a DuckDB-Jev extension called "game-changing for data analysis" on X, and a
  MotherDuck webinar on `prompt_jev` [search]. The download metrics were blocked.
- **Semantic operators:** mostly academic traction (2026 VLDB, SIGMOD and CIDR papers), with
  DocETL the most adopted.
- **Reading:** strong builder activity and real cost pain, but no evidence yet that anyone pays
  for trace-to-classifier compilation on its own. Vendors that monetise it bundle it (TensorZero,
  Distil Labs, BigQuery).

## 3. Design proposal for this layer (product, positioning, go-to-market)

### 3.1 Positioning statement

> **Your agent is already making the same decision thousands of times. We find those decisions
> in its traces, write them as typed questions, prove in shadow that they match the agent, and
> hand you a compiled process with a savings ledger for a human to approve.**

The framework does not replace the orchestrator, the observability tool or the SQL function. It
reads their exhaust.

**What we would have that neighbours lack:**
1. Discovery over **untyped** steps: a reasoning turn that ends in a tool choice, a routing
   sentence, a "looks fine, continue".
2. **Typed questions** as the compiled artefact, which are readable, diffable and portable,
   instead of opaque weights. This also keeps H5 clean.
3. **Agent-agreement shadowing** plus stuntdouble-style *policy* agreement.
4. A **promotion lifecycle** (candidate → shadow → active → retired) with human approval and a
   drift-driven demotion rule.
5. All of it in **one DuckDB file** you can query, diff, email or put on MotherDuck.

### 3.2 Users and willingness to pay

| Segment | Example | Job | Expects free | Would pay for | Realistic price anchor |
|---|---|---|---|---|---|
| Solo builder | James; launch-week hackers | "Cut my agent's bill, and make it fast and explainable" | Everything local: CLI, DuckDB store, backends, discovery with their own LLM key | Little: perhaps a hosted HITL page | $0 (like jevcal, stuntd, jevals) |
| Data team | DuckDB/MotherDuck analysts, dbt users | Classify or filter tables cheaply | SQL predicates (already free or bundled) | Question registry with versioned thresholds; eval sets shared across a team | MotherDuck already bundles `prompt_jev`; Langfuse Core $29/mo, LangSmith Plus $39/seat [search] |
| Platform team | Teams running production agents at 10⁵–10⁷ steps/day | Show finance a ≥50% cut without a quality regression; audit for risk | The runtime | Hosted discovery on their traces; approval workflow with roles; savings ledger; drift alerts; SSO/audit | Braintrust Pro $249/mo; Temporal Cloud $50 per million actions [search]; an enterprise "share of verified savings" model is plausible but **unverified** demand |

At personal scale the dollar saving is tiny. Inbox Reflex's all-LLM triage would cost roughly
$18/month (4,500 emails × ~$0.004, my estimate). The solo wedge is **latency, calibration and
audit**; the dollar wedge only appears at platform-team volume. This matches the README's finding
that "cost is rarely the wedge at personal scale".

### 3.3 Product surfaces (what the OSS core exposes)

```
dcx import  --from otel|langsmith|langfuse|phoenix|claude-code|jsonl  traces/   # layer 1 fill; no orchestrator needed
dcx discover --min-volume 200 --rank cost          # candidate decision sites, ranked by volume × $ × latency
dcx propose  SITE --llm <key> --decompose          # typed questions (+ atomic splits + reducer in code)
dcx shadow   PROC --against agent,labels --days 7  # agreement, policy agreement, ECE, coverage@target
dcx promote  PROC --approve                        # writes processes.status=active + lockfile + report
dcx monitor                                        # drift → demote; weekly savings ledger
dcx export   PROC --lockfile                       # run anywhere: SQL (duckdb-jev), Python, TS
```

The artefact that sells is the **promotion report**, one per process:
- the decision site and a sample of the agent spans;
- the proposed questions and reducer;
- shadow agreement with the agent, policy agreement, accuracy against any human labels, ECE and
  coverage at the target;
- cost and latency before and after, computed from the `traces` and `decisions` tables;
- the approver and timestamp.

The ledger is one SQL view:

```sql
CREATE VIEW savings_ledger AS
SELECT p.id, p.version,
       sum(t.cost)  FILTER (WHERE t.kind = 'llm'   AND t.site = p.site) AS cost_before,
       sum(d.cost)  FILTER (WHERE d.process_id = p.id)                  AS cost_after,
       1 - cost_after / nullif(cost_before, 0)                          AS saving_pct,
       avg(s.agree) AS shadow_agreement, avg(s.policy_agree) AS policy_agreement
FROM processes p
LEFT JOIN traces t ON t.site = p.site
LEFT JOIN decisions d ON d.process_id = p.id
LEFT JOIN shadow_results s ON s.process_id = p.id
GROUP BY ALL;
```

(Illustrative: `site` and `shadow_results` extend the PLAN schema. Workstreams A and D own the
exact tables.)

### 3.4 Open-source strategy

- **Apache-2.0 core.**
  - Compatible with LOTUS, TensorZero, stuntd and prasanthj/duckdb-jev, so their code can be
    vendored or linked.
  - Carries a patent grant, which platform teams' legal reviews look for.
  - Phoenix (ELv2) can be a sink but must not be embedded.
- **Free (OSS) contents:** schema, `ask()` with backends (Jev, Laya/Kev/SemIf via base URL, an
  LLM adapter), trace importers, discovery, proposal, shadow, promotion, lockfile export, the
  CLI report as static HTML, and CI replay against a free local backend.
- **Paid candidates, in order of plausibility:**
  1. **Hosted HITL review and approval UI:** multi-user queues, roles, approval audit trail.
     Clear value for teams, low marginal cost.
  2. **Hosted discovery:** runs proposal and shadow over large trace volumes with managed LLM
     spend. Customers bring their own Jev key, because TypeSafe's terms reportedly bar offering
     the Services "as a standalone service" (platform doc §5).
  3. **MotherDuck-backed sharing:** a shared question registry, decision ledger and eval sets
     across a team, using MotherDuck shares, with `prompt_jev` as a hosted backend. This is
     better as a partnership than as our own hosting.
  4. **Drift monitoring and alerting** as a service.
- **Not paid:** the runtime, SQL functions, backends. Those are commodities (§2.1).
- **Distribution:** PyPI package; entries on the awesome-Jev radars; a DuckDB community extension
  only if we need SQL surface beyond an adopted extension; a Claude Code skill (`dcx discover`
  over `~/.claude` transcripts is the most viral demo); a launch post with the Evidence Screener
  H4 report. Check the benchmark-publication clause first (§5).

### 3.5 First internal customers: ranking

Scoring, 0–3 per column:
- **L1–L4:** how much the project exercises each layer.
- **Base:** whether a natural all-LLM agent baseline exists whose traces contain undeclared
  decisions.
- **H4:** days to a measured cost and accuracy comparison against independent labels.

Figures come from each one-pager's §1 and §4. H4 cost cuts are my estimates, assuming a
frontier-model baseline at ~$2 per million input tokens (a GPT-5.6 Terra / Sonnet 5 snippet
[search]) with output priced **unverified**. The cuts would be much smaller against a cheap
model.

| Project | L1 | L2 | L3 | L4 | Base | H4 speed | Total | Est. cut vs all-LLM agent | Main blocker |
|---|---|---|---|---|---|---|---|---|---|
| **Evidence Screener (08)** | 3 | 3 | 3 (retrieval tool, SQL filters, judge, Stage-2 re-ask, LLM summary, review queue) | 3 (an LLM screener's reasoning maps directly to per-criterion decisions) | 3 | 3 (SYNERGY: 26 reviews, author labels, offline, ~1 week) | **18** | ~85–92%: Jev ≈$0.00005/record vs ≥$0.003 of LLM input; survivor summaries are the same in both arms | Jev weak on specialised domains; recall ≥0.95 gate |
| **Inbox Reflex (01)** | 3 | 3 | 3 (Gmail tool, rules, drafts LLM, Review queue) | 3 (triage agent traces; un-archive and label moves are free labels) | 3 | 2 (600 labels ≈3–4 h, 7-day shadow; ~2–3 weeks) | **17** | ~79–85%: drafts ($0.01 × 10%) stay generative in both arms | Own GCP project and OAuth; own mail to a US processor |
| Opportunity Matcher (04) | 3 | 3 | 1 (cron pipeline, almost no LLM) | 2 (dimensions are known up front) | 2 | 2 (300 items ≈10 h labelling; source fragility) | 13 | ~95%, but ≈$26/mo absolute | Data access (no Seek/LinkedIn API) |
| Tessera Answer Judge (11) | 2 | 3 | 2 (CAS pre-check, tutor LLM, review) | 2 (tutor traces and "other" clustering could propose misconceptions) | 2 | 0 (Tessera facts and children's data unresolved) | 11 | ~95%+ | Owner decisions; Children's Online Privacy Code |
| Guardrail Sidecar (03) | 2 | 3 | 3 (HITL `interrupt()`) | 1 (questions declared up front) | 1 | 1 (adds cost; only wins against an LLM-judge guardrail: $125 vs $5,880 per million, self-reported) | 11 | n/a as a customer | Crowded; it is infrastructure |
| Community Moderator (05) | 2 | 3 | 2 | 1 (taxonomy fixed; no LLM agent to learn from) | 0 (free OpenAI moderation is the real baseline) | 1 (≥1,000 labels; auto-promotion barred on safety classes) | 9 | ≈0 against a free moderation API | Minors, self-harm; mod-time cost dominates |

**Pick: Evidence Screener first, Inbox Reflex second.**
- **Evidence Screener** is the H4 proof harness:
  - independent labels, so "equal or better accuracy" is not circular (doc 08 bans Jev labels);
  - a public dataset, so the H4 report can be published and reproduced in CI with a local
    backend;
  - an easy baseline agent (a frontier LLM screening each abstract with reasoning), whose traces
    carry one decision per criterion.
- **Inbox Reflex** is the live customer: streaming drift, HITL, labels from user actions, and a
  residual generative step, which tests whether discovery correctly *keeps* the LLM for drafts.
- **Guardrail Sidecar** ships inside the framework as the trace tap and judge-in-loop hook for
  James's LangGraph pipelines. It feeds discovery but is not a customer.

**H4 protocol (for synthesis):**
1. Freeze the baseline agent: model, prompt, tools.
2. Record its traces into DuckDB.
3. Run discovery, proposal and shadow on the tune split.
4. Report, on the holdout: task accuracy (Evidence Screener: recall and WSS@95; Inbox:
   archive precision and needs-reply recall), total cost from `traces` + `decisions`, and p50
   latency, with bootstrap CIs.
5. H4 passes only if the cost cut is ≥80% and the accuracy CI is not below the baseline's.

### 3.6 Ideas the framework would make trivial (not in the 13)

1. **Permission-prompt autopilot for Claude Code:** mine transcripts for tool calls the user
   always approves, and propose Noul gates plus allow rules. Existing hooks (`jev-skill-router`,
   `jev-guard`) show demand.
2. **Coding-agent tool and skill routing** compiled from one's own successful sessions (the
   jev-tests #3 design, done automatically).
3. **Support-ticket cascade:** dropped by the source report as well trodden, but it becomes a
   one-afternoon demo.
4. **CI failure triage:** flaky vs real vs infrastructure, and which owner, from historical CI
   logs in DuckDB.
5. **Bank-CSV transaction categorisation** in DuckDB, with a HITL queue for low-confidence rows.
6. **Semantic dbt tests** (`jev_prob(...) > τ` as a data-quality assertion), and entity-resolution
   match checks (Astronomer's campaign-finance example [search]).
7. **OTel log and alert triage** over DuckDB (a `jevlogs` analogue), skipping expensive analysis
   for low-value traces.
8. **Survey and interview free-text coding** for qualitative research, with double-labelled
   calibration.
9. **GitHub issue labelling and PR-review routing** for own repos (with the scarif-labs
   out-of-distribution caution).
10. **Policy Desk** (doc 16): returns and warranty eligibility, with facts computed in code.
11. **Agent context pruning:** which tool outputs the next step needs (`pi-jev-context`,
    `fast-jev-compaction`), discovered per tool.

## 4. Prior art and alternatives

| Name | What it does | Closeness | What it lacks that we would have | Licence | Pricing |
|---|---|---|---|---|---|
| stuntd | Typed calls → per-site heads; shadow, serve, demote | **High** (L2+L4, typed only) | Untyped discovery; question artefacts; approval; a Jev-safe teacher | Apache-2.0 | Free |
| stuntdouble, jevcal, Janus | Shadow, calibrate, cascade lockfile | Medium (L2 eval) | Trace discovery; lifecycle | MIT / various | Free |
| jevc, reflex `jev-audit` | Static compile or audit of prose and call sites | Medium (static L4) | Trace mining; shadow against the agent | Not checked | Free |
| OpenRouter Prompt→questions, cascade cookbook | Prompt → Jev questions; draft-verify-escalate | Medium; **dangerous follower** | Trace mining; local store; approval | n/a | Usage |
| TensorZero + Autopilot | Gateway, ClickHouse, SFT/GEPA/DICL; trace-analysing AI engineer | Medium–high | Typed-question output; embedded store | Apache-2.0; Autopilot paid | Private beta |
| Distil Labs, OpenPipe | Traces/logs → small fine-tuned model | Medium | Readable typed artefacts; agent shadow | Proprietary | Not public |
| DSPy | Optimisers incl. BootstrapFinetune, GEPA | Medium | Cross-stack trace import; store; promotion | MIT | Free |
| LOTUS, DocETL, Palimpzest | Semantic operators with cost optimisers | Medium (L2 batch) | Agent traces; Jev; lifecycle | Apache-2.0 / MIT / MIT | Free |
| FlockMTL, BlendSQL | LLM calls inside DuckDB SQL | Low (L2) | Decision backends; discovery | MIT / Apache-2.0 | Free |
| duckdb-jev ×3, vgi-typesafe, pg-jev, sqlite-jev | Jev as SQL functions | **Adopt** (L2) | Everything above L2 | Apache-2.0 (prasanthj) | Free |
| MotherDuck `prompt_jev()` | Hosted Jev in SQL | L2; **partner** | Discovery, HITL | Proprietary | Paid plans; $1 per AI Unit, input only [search] |
| BigQuery optimized mode | LLM-labelled sample → JIT proxy | Medium (hidden L4) | Agents; transparency; portability | Proprietary | Per call, preview [search] |
| Snowflake Cortex, Databricks AI Functions / Agent Bricks | Warehouse LLM functions; agent platform | Low–medium | Typed compilation of agent steps | Proprietary | $2.00–2.20 per credit / not checked |
| DBOS | In-process durable workflows (SQLite default) | L3 candidate | n/a (adopt) | MIT | OSS; Cloud paid |
| Temporal | Durable execution; OpenAI Agents SDK integration GA | L3 alternative (heavier) | n/a | MIT | $50 per million actions [search] |
| LangSmith, Langfuse, Braintrust, Phoenix | Traces + Jev evaluators | Trace source; **fast followers** | Replacement proposals; promotion | Proprietary / MIT core / proprietary / ELv2 | $39/seat; $29/mo; $249/mo; $50/mo [search] |
| Humanloop | Former eval platform | Defunct (Sep 2025) | n/a | n/a | n/a |
| Martian, Not Diamond, JevRouter, jev-router | Model and tool routers | Low (a sub-case) | Discovery, lifecycle | Proprietary / MIT | Various |

## 5. Constraints & prerequisites

| Item | Type | Why needed | How to get it | Blocking? | Status |
|---|---|---|---|---|---|
| TypeSafe terms: "standalone service" ban | legal-ToS | Decides whether hosted discovery can call Jev for customers | Read `typesafe.ai/legal/mca`; design the paid tier as BYO key | yes (paid tier only) | unverified (snippet) |
| TypeSafe distillation clause | legal-ToS | Excludes stuntd-style "learn from Jev's answers"; teachers must be LLM traces, open models or humans | Same pages; state it in the README | yes | unverified (snippet) |
| Benchmark-publication restriction (jevcal's claim) vs "only §2.3 restrictions" (another snippet) | legal-ToS | Can we publish the H4 report with Jev numbers? | Read the MCA; ask TypeSafe; publish local-backend numbers first | yes (for publishing) | open question (conflicting sources) |
| SYNERGY dataset licence and download | data | Evidence Screener H4 labels | github.com/asreview/synergy-dataset | yes (customer 1) | unverified licence |
| Frontier-LLM API key and budget for the baseline agent | API key | H4 needs an all-LLM baseline; ~3,000 records × ~$0.005 ≈ $15 per run (my estimate) | Owner | yes | open |
| Owner decision: which baseline model defines H4 | decision | H4 is false against a cheap LLM and true against a frontier one; must be fixed before measuring | Owner, in synthesis | yes | open |
| Gmail OAuth on own GCP project; ~600 hand labels | account / data | Inbox Reflex (customer 2) | Doc 01 §5 | yes (customer 2) | known |
| Trace formats: OTel GenAI semconv (Development status), LangSmith/Langfuse export APIs, Claude Code transcript format | platform limit | "Bring your traces" importers | Pin a semconv version; one importer per source | no (start with JSONL + OTel) | known / moving |
| Existing DuckDB-Jev extension to adopt; behaviour when batching | skill / decision | Avoid rebuilding L2; accuracy drops above 20 rows per request | prasanthj (Apache-2.0) or a Python UDF; one record per state | no | known [opened] |
| Licence hygiene: Apache-2.0 core; no ELv2 (Phoenix) embedding | legal | OSS strategy | Dependency licence check in CI | no | known |
| Jev rate limit (1,200 req/min, reported) | platform limit | Shadow runs replay large trace sets | Local backend for bulk shadow; Jev only for the final holdout | no | unverified numbers |
| MotherDuck account (sharing tier, `prompt_jev`) | account | Paid-tier experiment | motherduck.com; paid plan | no | known [search] |
| Name and brand check (`dcx` is a placeholder) | decision | Packaging, PyPI | Owner | no | open |

## 6. Risks & open questions

| Risk | Kind | Mitigation |
|---|---|---|
| **Incumbents close the gap.** LangSmith/Langfuse add "suggest a Jev replacement for this span"; OpenRouter joins Prompt→questions with its traffic; TensorZero Autopilot adds typed outputs; TypeSafe ships a cookbook. | market | Move fast on the Evidence Screener report; make importers for their exports, so we complement them; keep the lockfile portable; be ready to upstream. |
| **Naive question proposal fails:** 62.6% with one question vs 95% with five atomic questions plus fitted weights [search]. | technical | Discovery proposes decompositions plus a reducer in code (jevc's pattern); a weight fit needs roughly 1,000 labels, so budget for it. |
| **H4 depends on the baseline chosen:** true against frontier models, false against cheap LLMs (1.4–1.7×). | method | Pre-register the baseline; report cost against both a frontier and a cheap baseline. |
| **Absolute savings are trivial at personal scale.** | market | Sell latency, calibration and audit to solo builders; the dollar case goes to platform teams. |
| **Out-of-distribution threshold failure** (scarif-labs). | technical | Drift monitor with automatic demotion (stuntd's behaviour) and periodic re-shadowing. |
| **Hype decays; Jev pricing may rise.** | market | Stay backend-agnostic; the value is discovery and the lifecycle. |
| **Legal ambiguity** on publishing numbers and hosted use. | legal | Resolve before any public launch (§5). |
| **Open:** will platform teams hand over traces to a hosted discovery service, or insist on self-hosting? | open question | Treat self-hosted as the default, and the hosted tier as optional. |

## 7. Sources

**Opened (read directly)**
- https://raw.githubusercontent.com/prasanthj/duckdb-jev/main/README.md and https://github.com/prasanthj/duckdb-jev: native extension, live throughput, Apache-2.0, 3 stars.
- https://raw.githubusercontent.com/recodelabs/duckdb-jev/main/README.md: API; per-row cache; batching affects answers.
- https://raw.githubusercontent.com/judoaseeta/duckdb-jev/main/README.md: pg-jev port; accuracy by batch size (20/40/80 rows).
- https://raw.githubusercontent.com/BillionsBobby/JevRouter/main/README.md: router contract; Toolathlon numbers.
- https://raw.githubusercontent.com/bladedevoff/stuntd/main/README.md and https://github.com/bladedevoff/stuntd: learning proxy; per-site heads; Jev-teacher mode; 19 stars.
- https://raw.githubusercontent.com/ReallyArtificial/stuntdouble/main/README.md: shadow, swap verdict, policy agreement.
- https://raw.githubusercontent.com/doronp/jevc/main/README.md: prose-to-program compiler; `scan` (decidable / procedure / generation).
- https://raw.githubusercontent.com/abhixhek/jevcal/main/README.md: calibration lockfile; claim about restrictions on publishing numbers.
- https://raw.githubusercontent.com/AbdelStark/awesome-typesafe-jev/main/README.md, https://raw.githubusercontent.com/logicrw/awesome-jev-projects/main/README.md, https://raw.githubusercontent.com/yibie/awesome-jev/main/README.md, https://raw.githubusercontent.com/Anil-matcha/awesome-jev-by-typesafe/main/README.md: ecosystem entries (vgi-typesafe, sqlite-jev, jevql, Janus, Beacon, scarif-labs, HN thread size).
- https://github.com/kaustav1996/reflex/issues/5: `jev-audit` skill proposal.
- https://github.com/Rajeev-SG/jev-tests/issues/3: design of the trace-based tool-routing test.
- https://github.com/lotus-data/lotus ; https://github.com/ucbepic/docetl ; https://github.com/mitdbg/palimpzest ; https://github.com/parkervg/blendsql ; https://github.com/dais-polymtl/flock ; https://github.com/stanfordnlp/dspy ; https://github.com/tensorzero/tensorzero ; https://github.com/openlayer-ai/jevals ; https://github.com/Arize-ai/phoenix ; https://github.com/langfuse/langfuse: stars, licences, features.
- LICENSE files (raw) for dbos-transact-py, temporal, lotus, docetl, dspy, tensorzero, flock, palimpzest; PyPI JSON for stuntd, lotus-ai, dspy, docetl, dbos, janus-decide: versions.

**Search snippets only**
- https://motherduck.com/blog/motherduck-supports-jev/ ; https://motherduck.com/docs/sql-reference/motherduck-sql-reference/ai-functions/prompt-jev/: `prompt_jev`, 100k-row benchmark, input-only metering.
- https://cloud.google.com/blog/products/data-analytics/more-than-100x-faster-and-cheaper-llm-powered-sql-queries-with-proxy-models ; https://docs.cloud.google.com/bigquery/docs/optimize-ai-functions: optimized mode and proxy distillation.
- https://docs.snowflake.com/en/user-guide/snowflake-cortex/aisql-cost ; https://www.finout.io/blog/snowflake-cortex-pricing: Cortex billing.
- https://www.databricks.com/blog/agent-bricks-dais-2026: Agent Bricks at DAIS 2026.
- https://www.langchain.com/blog/jev-agent-evals-langsmith ; https://langfuse.com/blog/2026-09-22-running-evals-with-jev ; https://www.braintrust.dev/blog/evaluate-agent-responses-with-jev ; https://github.com/Arize-ai/phoenix/pull/16367: Jev-as-judge integrations.
- https://aibizhub.io/articles/llm-observability-pricing-braintrust-vs-phoenix-vs-langfuse-2026/ ; https://www.morphllm.com/llm-observability-tools: observability pricing.
- https://openrouter.ai/labs/jev/compile ; https://openrouter.ai/docs/cookbook/evaluate-and-optimize/jev-verified-cascade: Prompt→questions; cascade numbers.
- https://www.tensorzero.com/blog/automated-ai-engineer/ ; https://www.crunchbase.com/organization/tensorzero: Autopilot; seed round.
- https://www.distillabs.ai/blog/distil-labs-launches-agent-distillation-with-dlthub/: trace-to-SLM product.
- https://sacra.com/c/openpipe/: CoreWeave acquisition.
- https://news.ycombinator.com/item?id=44592216 ; https://humanloop.com/: Humanloop sunset.
- https://www.bestaiweb.ai/openrouter-martian-and-not-diamond-the-2026-llm-router-race-and-where-agent-cost-optimization-is-heading/ ; https://pitchbook.com/profiles/company/527089-51: router funding.
- https://temporal.io/change-log/open-ai-agents-sdk-integration-pp ; https://startupik.com/temporal-cloud-cost-ai-agent-startup-2026/: Temporal pricing and GA.
- https://docs.dbos.dev/python/tutorials/database-connection: DBOS with SQLite by default.
- https://news.ycombinator.com/item?id=49717558 ; https://simonwillison.net/2026/Sep/21/jev/: launch-thread size and themes.
- https://techcrunch.com/2026/06/05/the-token-bill-comes-due-inside-the-industry-scramble-to-manage-ais-runaway-costs/ ; https://bex.co/blog/2026/09/11/aws-agent-bill-deploy-time-guardrails: agent cost pain.
- https://www.beri.net/article/typesafe-jev-typed-decision-model-calibration-decomposition-shadow-eval ; https://xenospectrum.com/en/jev-typesafe-bert-classifier-decomposition/: 62.6% → 95% decomposition.
- https://query.farm/blog/a-where-clause-for-taste/: DuckDB + Jev over HN stories.
- https://www.astronomer.io/blog/what-jev-will-do-to-data-engineering/: entity resolution; "the three hundred judgments".
- https://arxiv.org/abs/2609.07782 (TrajectoryDB) ; https://arxiv.org/html/2604.23853v2 (ClawTrace) ; https://arxiv.org/abs/2608.06677 (SemBaker): research context.
- https://wunderlandmedia.com/typesafe-ai-jev-terms-of-service-gdpr: "only §2.3 restrictions" (conflicts with jevcal).
- https://www.cloudzero.com/blog/llm-api-pricing-comparison/: frontier input price ($2/M) used in the estimates.

**Internal:** `../jev-system-one/` README, 00-platform (§1, §4–§7), 00-source-report, 15, 16, and the Summary
and Implementation-plan sections of 01, 03, 04, 05, 08 and 11.
