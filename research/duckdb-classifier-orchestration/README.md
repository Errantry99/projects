# DuckDB + classifier + agent orchestration with process discovery

Exploration of a framework that puts DuckDB at the centre as the store for records, questions,
decisions, traces, labels and thresholds; exposes System One classifiers (Jev and the open
re-implementations) as SQL-callable predicates; runs LLM agents on top through a durable
orchestrator; and, the novel part, mines the agents' traces to discover recurring decision
points, proposes typed questions for them, shadow-tests them, and promotes the ones that hold
into compiled processes that no longer need an LLM. Six parallel research agents each took one
workstream; a synthesis agent consolidated them into an MVP spec.

## Read in this order

1. [`07-synthesis-and-mvp.md`](07-synthesis-and-mvp.md): the verdict on the concept and on
   hypotheses H1–H5, the revised architecture, decisions taken, MVP spec, milestones, test and CI
   plan, merged constraints table, and open questions for the owner.
2. [`PLAN.md`](PLAN.md): the original concept, the architecture hypothesis the agents were asked
   to challenge, and the workstream brief.
3. The six workstream documents, for the evidence behind each decision.

## Workstreams

| # | Document | Verdict in one line |
|---|----------|---------------------|
| A | [DuckDB store and SQL-callable judge](01-duckdb-store-and-sql-judge.md) | DuckDB is enough as store, eval harness, policy layer and trace warehouse, but not as the production judge or a multi-writer hub. Paid calls go through one async batch worker into an immutable content-addressed `judgments` cache. Adopt the existing DuckDB-Jev extensions. Row-at-a-time UDF calls are 60–70× slower than batching. |
| B | [Classifier layer](02-classifier-layer.md) | Split `ask` (raw cached probabilities from any backend) from `decide` (calibration, thresholds, action). Calibration is keyed on exact question wording + backend + model version: a rewording moved a probability by 0.125 and dropping the "unknown" option collapsed accuracy. Sample size bounds how strict a threshold can be. |
| C | [Orchestration layer](03-orchestration-layer.md) | Build a thin journaled-function kernel (DBOS-style, ~1,200–1,800 LoC) with step kinds sql, rule, judge, llm, tool, human, route. Journal and HITL queue in SQLite (Postgres when hosted); DuckDB beside it. DuckDB's file lock blocks even read-only readers during a live run. LangGraph, Claude Agent SDK and Mastra become trace-emitting adapters. The trace contract for discovery is in its §3.3. |
| D | [Process discovery](04-process-discovery.md) | Buildable as DuckDB SQL plus plain statistics. Promote single decision points, not whole processes; try a SQL rule first; keep a 5% audit sample. Agreement with the LLM measures parity, not accuracy, so each promotion needs 100–150 human labels on disagreements. Legal trap: after promotion Jev's answers are the only live labels, so label-source columns and a CI test must prevent accidental distillation. |
| E | [Market and use cases](05-market-and-use-cases.md) | SQL and judge layers are already commodities (MotherDuck `prompt_jev()`, several DuckDB extensions, every tracing tool added Jev as an evaluator within a week). Only the discovery layer is open ground, and it could close within weeks. Make orchestration optional: import traces people already have, export promoted processes as lockfiles. First customers: Evidence Screener, then Inbox Reflex. |
| F | [Free text to ontology matching](06-ontology-matching.md) | Shortlist candidates in DuckDB (BM25, embeddings, fuzzy, synonyms), verify with one Choice over 20–50 candidates plus "none" and "broader", send the unsure to a human. Shortlist recall is the real limit, not the 255-option cap. Rate limits and human review cost more than tokens at scale. The "none" bucket drives ontology growth through the same lifecycle as process discovery. Adds a `retrieve` step and runtime-filled options with a candidate-set hash in the cache key. |

## Verdict

Go, narrowed. Adopt the commodity layers, build the thin kernel, and put the effort into the
discovery and promotion loop. The week-one milestone is the foundation plus a hello world on 300
records from one systematic review, comparing the all-LLM run with the compiled one and showing
that a re-run makes zero paid requests. Top blockers before starting: the text of TypeSafe's
Master Customer Agreement on training and publishing, a frontier-LLM key with the H4 baseline
model pre-registered, and the SYNERGY dataset licence. Inbox Reflex additionally needs a privacy
decision on cross-border disclosure.

## How much to trust these documents

Agents had web search and could open GitHub, raw.githubusercontent.com, npm and PyPI, but
typesafe.ai, duckdb.org, huggingface.co, arxiv.org and most vendor sites were blocked, so claims
are tagged opened, search-snippet or unverified in each document. Workstreams A and D ran their
SQL against a local DuckDB 1.5.5 with stub judges; no live Jev calls were made anywhere.
