# Plan: a DuckDB + classifier + agent-orchestration framework that discovers reusable processes

_Written 24 Sep 2026. This is the shared brief for a set of parallel research agents. It states the
concept, the architecture hypothesis they should challenge, and the workstreams. Findings land in
this directory as numbered documents; a synthesis document follows._

## The concept in one paragraph

Most of what LLM agents do in record-processing work (triage an email, screen a paper, gate a tool
call, route a ticket) is a sequence of typed decisions in disguise. System One models such as
TypeSafe's Jev (and the open re-implementations: Laya, Kev, SemIf, open-jev) answer typed questions
(Choice / Score / Noul) in ~100 ms for a fraction of a cent, with calibrated probabilities. The
framework proposed here puts DuckDB at the centre as the single store for state, questions,
decisions, traces, labels and thresholds; exposes classifiers as SQL-callable predicates; runs
LLM agents on top through a durable orchestrator; and, the novel part, **watches the agents' traces
to discover recurring decision points, proposes typed questions for them, shadow-tests those
questions against the agent's own behaviour, and promotes the ones that hold into cheap compiled
processes that no longer need an LLM.** The agent becomes the teacher of its own replacement, one
step at a time, and the human approves each promotion.

## Why now, and why these three parts

- **DuckDB**: embedded, columnar, JSON- and Arrow-native, runs in Python, Node and the browser
  (WASM), zero-ops. It makes "retrieve precisely in code, send only the fields the question needs"
  (the Jev design rule) a SQL statement, and it makes traces and decisions queryable with the same
  engine. Single-node scale is enough for every one of our 13 projects.
- **Classifier layer**: the platform document (§7) and document 15 already argue for a thin wrapper
  with question registry, per-decision logging, threshold config and an eval harness. This
  framework is where that wrapper lives, generalised to several backends.
- **Orchestration**: the cascade pattern (Jev decides which requests deserve a frontier model) needs
  a runtime that can mix SQL steps, judge steps, LLM steps, tool calls and human queues, with
  durable state and replay. The traces that runtime produces are the raw material for discovery.

## Architecture hypothesis (to be challenged, not assumed)

```
┌──────────────────────────────────────────────────────────────────────┐
│ 4. DISCOVER   trace mining → candidate steps → proposed typed          │
│               questions → shadow run → agreement/calibration →         │
│               promote to compiled process → drift monitor → retire     │
├──────────────────────────────────────────────────────────────────────┤
│ 3. ORCHESTRATE durable workflows: steps = sql | judge | llm | tool |   │
│               human; cascade router; HITL queue; replay from store     │
├──────────────────────────────────────────────────────────────────────┤
│ 2. JUDGE      ask(state, questions[]) → decisions; backends: Jev,      │
│               Laya, SemIf, Kev, LLM-adapter; cache by (state hash,     │
│               question version, model version); SQL UDFs              │
├──────────────────────────────────────────────────────────────────────┤
│ 1. STORE      DuckDB: records, questions, decisions, labels,           │
│   (DuckDB)    thresholds, traces, processes, runs, hitl_queue          │
└──────────────────────────────────────────────────────────────────────┘
```

Candidate core tables: `records` (id, source, state JSON, hash, ts) · `questions` (id, version,
type, instruction, options/levels JSON, owner) · `decisions` (record_id, question_id, question_v,
backend, model_v, answer, probs JSON, confidence, latency_ms, cost, ts) · `labels` (record_id,
question_id, label, labeller, ts) · `thresholds` (question_id, action, threshold, fitted_on,
metrics JSON) · `traces` (run_id, step_no, kind, input_hash, output_hash, model, tokens, cost,
latency, ts) · `processes` (id, version, spec JSON, status ∈ {candidate, shadow, active, retired},
metrics JSON) · `hitl_queue` (record_id, question_id, reason, assigned, resolved, resolution).

## Hypotheses the research should test

- H1. In record-processing agent workflows, most steps are typed decisions; the minority that need
  generation are identifiable from traces.
- H2. Traces plus a small number of LLM-labelled examples carry enough signal to propose typed
  questions automatically, and a shadow run can validate them without a human labelling everything.
- H3. DuckDB alone is a sufficient and good store for this at single-node scale, including as the
  eval harness and the trace warehouse.
- H4. On at least one of our 13 projects, the compiled process cuts cost by ≥80% at equal or
  better task accuracy versus the all-LLM agent.
- H5. The discovery loop can be built without breaching TypeSafe's distillation clause (we design
  questions from LLM traces; we never train a model on Jev's outputs; using Jev's outputs as
  features for a classical model is what TypeSafe's own cookbook does).

## Workstreams (one agent each)

| # | Workstream | Output file | Key questions |
|---|-----------|-------------|---------------|
| A | DuckDB as store and SQL-callable judge | `01-duckdb-store-and-sql-judge.md` | Schema; JSON/Arrow/UDF/extension mechanics; calling a classifier from SQL (scalar and table functions, vectorised batching, async); caching; DuckDB-WASM; MotherDuck; prior art (FlockMTL, LOTUS, DocETL, Palimpzest, BlendSQL, semantic operators); limits. |
| B | Classifier layer design | `02-classifier-layer.md` | Backend-agnostic `ask()` interface; question registry and versioning; calibration and thresholds as data; eval harness; adversarial-state defenses; cost metering; mapping semantic operators (filter, join, top-k, group) onto Choice/Score/Noul; where the open models fit. |
| C | Orchestration layer | `03-orchestration-layer.md` | Build vs adopt (LangGraph, Temporal, DBOS, Inngest, Restate, Prefect/Dagster, Mastra, Claude Agent SDK); durable execution over DuckDB; step types; cascade router; HITL queue; replay; observability (OTel GenAI conventions); what traces must contain for discovery. |
| D | Dynamic discovery of reusable processes | `04-process-discovery.md` | Trace mining (process mining, DFGs, PM4Py); agent skill/procedure discovery literature (Voyager, Agent Workflow Memory, SkillWeaver, procedural memory); proposing typed questions from LLM decision points; shadow validation; promotion/demotion policy; drift; metrics; the TypeSafe clause. |
| E | Market, prior art, positioning, first use cases | `05-market-and-use-cases.md` | Who is building this (DSPy, LOTUS, DocETL, Palimpzest, FlockMTL, Databricks, Snowflake Cortex, MotherDuck AI, DBOS, Temporal, LangSmith); the wedge; which of our 13 projects is the first internal customer; what a user would pay for; open-source strategy. |
| S | Synthesis and MVP spec (after A–E) | `06-synthesis-and-mvp.md` | Consolidated architecture; decisions taken; repo layout; language choice; milestones with LoC; hello-world demo; test and CI plan using a free local backend; the constraints checklist merged across A–E. |

## Rules for the research agents

- Read this plan, then `../jev-system-one/README.md`, `../jev-system-one/00-platform-jev-typesafe.md`
  (§1, §4, §7) and `../jev-system-one/15-small-models-as-system-one-classifiers.md` before searching.
  Skim the 13 one-pagers in `../jev-system-one/00-source-report.md` Part 5 for concrete use cases.
- Today is 24 Sep 2026. Jev launched 15 Sep 2026. Verify with WebSearch / WebFetch. In this
  sandbox github.com, raw.githubusercontent.com, npm and PyPI are reachable; typesafe.ai,
  huggingface.co, dev.to and most blogs are blocked. Tag claims **[opened]**, **[search]** or
  **unverified**. Never invent URLs, numbers or names.
- Challenge the architecture hypothesis. If a layer should be merged, dropped or replaced, say so.
- Deliverable: one markdown file at the path above, 2,500–4,500 words, with sections:
  1 Summary (with a verdict on the hypotheses your workstream can speak to) · 2 Findings ·
  3 Design proposal for your layer (interfaces, data model, code sketch where useful) ·
  4 Prior art and alternatives (table) · 5 Constraints & prerequisites (table: Item | Type |
  Why needed | How to get it | Blocking? | Status) · 6 Risks & open questions · 7 Sources.
- Do not modify other files, do not run git, do not create extra files. Finish with a ≤150-word
  summary: verdict, the three most important findings, and whether web access worked.
