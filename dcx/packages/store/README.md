# @dcx/store

The two stores behind dcx (07 §2 row 1) and the exporter between them.

- **`SqliteJournal`** (`openSqliteJournal(path, {readonly?, now?})`, or `openJournalStore`):
  the `Journal` from `@dcx/core` over better-sqlite3, WAL with `synchronous=NORMAL`. Many
  readers can open it while the kernel writes; the HITL server uses only this.
  - `startRun`/`putStep`/`putToolCall` are insert-if-absent. `putStepReturning` gives back the
    stored step, so a replay returns the recorded output (DBOS `operation_outputs`). A replay
    whose kind, name, tool or args hash differs throws `JournalDivergenceError`.
  - `lease(executor, ttl)` claims `pending`/`running` runs whose lease is absent or expired;
    `heartbeat` renews it and returns false once another executor has taken over.
  - A tool call is `in_doubt` from `putToolCall` until `updateToolCall` records the result.
    `listInDoubtToolCalls` is the operator's queue. The default idempotency key is
    `toolIdempotencyKey(run_id, step_no)`.
  - `completeStep` writes the result and its outbox rows in one transaction, and does nothing
    if the step is already completed. `resolveHuman` resolves the task, completes the human
    step, enqueues the label and moves a `waiting` (or `suspended`) run to
    `pending`, all in one transaction.
  - Warehouse-bound rows (labels, trace_steps, routes, judge_uses, llm_calls, ...) only ever
    enter the outbox. `label_id`/`call_id` are assigned when a row is enqueued.
- **`DuckWarehouse`** (`openDuckWarehouse(path, {readOnly?})`, or `openWarehouseStore`): the
  `Warehouse` over `@duckdb/node-api`.
  - A second open of the same file in this process throws `WarehouseLockedError`, because
    DuckDB's lock only stops other processes (01 §2.1). `:memory:` is exempt.
  - `appendRows` uses the DuckDB appender into a TEMP staging table plus one `INSERT … SELECT`,
    optionally `ON CONFLICT DO NOTHING`. It handles JSON, MAP, LIST and defaults, and writes
    10,000 rows in about 0.25 s.
  - Calls on the connection are serialised. Inside `transaction(fn)`, use only the `wh` that
    `fn` receives.
  - `all` returns JSON columns parsed, MAPs as objects, BIGINTs as numbers and timestamps as
    ISO strings.
- **`drainOutbox(journal, warehouse, {batchSize?})`**: moves pending outbox rows into their
  tables. Each batch's appends, plus its seqs in the `dcx_outbox_applied` ledger, are one
  DuckDB transaction, so a re-drain after a crash adds nothing. Natural keys dedupe as well:
  within a batch `llm_calls` keep the last row per `call_id` (the settled trace), and
  `content` / `tool_schemas` duplicates are dropped; across batches ON CONFLICT DO NOTHING.
  JSON columns take scalar strings (a raw LLM text body) as JSON strings.

```ts
import { drainOutbox, openDuckWarehouse, openSqliteJournal } from "@dcx/store";
const journal = openSqliteJournal("dcx.sqlite");
const wh = await openDuckWarehouse("dcx.duckdb");
await drainOutbox(journal, wh);
```

Tests: `npx vitest run` (they cover WAL readers, insert-if-absent steps, leases, HITL
atomicity, drain idempotency, appender throughput and the single-opener guard).
