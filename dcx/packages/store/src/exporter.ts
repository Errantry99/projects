// The outbox exporter: moves journal outbox rows into their DuckDB tables. 07 §2 row 1 and
// §4.2: the kernel and the HITL server write warehouse-bound rows (labels, trace_steps, routes,
// judge_uses, llm_calls, ...) to the SQLite outbox in the same transaction as the step; the one
// process that owns DuckDB drains it.
//
// Exactly-once into DuckDB: each batch is appended and its seqs recorded in the warehouse table
// `dcx_outbox_applied` in one DuckDB transaction, and seqs already recorded are skipped. A crash
// between that commit and `markExported` therefore re-drains nothing twice, even for tables with
// no primary key (promotions). Appends also use ON CONFLICT DO NOTHING on each table's natural
// key as a second guard.

import {
  type Journal,
  type JsonObject,
  type OutboxRow,
  type SqlValue,
  sha256Hex,
  type Warehouse,
  type WarehouseTable,
} from "@dcx/core";

/** The exporter's ledger table in the warehouse (created by core's duckdb.sql; the DDL below
 *  is kept for warehouses migrated before the table was promoted). */
export const OUTBOX_LEDGER_TABLE = "dcx_outbox_applied";

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${OUTBOX_LEDGER_TABLE} (
  seq          BIGINT PRIMARY KEY,
  target_table VARCHAR NOT NULL,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT current_timestamp)`;

/** uuid-defaulted keys; a row that reached the outbox without one gets an id derived from its
 *  seq, so a re-drain produces the same key. */
const UUID_KEYED: Partial<Record<WarehouseTable, string>> = {
  labels: "label_id",
  judge_calls: "call_id",
};

/** A deterministic UUID (version nibble 8) from an outbox seq. */
export function outboxUuid(seq: number): string {
  const h = sha256Hex(`dcx/outbox@1:${seq}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function prepare(o: OutboxRow): Record<string, SqlValue | undefined> {
  const key = UUID_KEYED[o.target_table];
  const row: JsonObject =
    key && o.row[key] == null ? { ...o.row, [key]: outboxUuid(o.seq) } : o.row;
  return row as Record<string, SqlValue>;
}

/** Single-column natural keys deduped inside a batch, keeping the LAST row (the most settled:
 *  a trace re-emitted with its effect filled). Across batches ON CONFLICT DO NOTHING keeps the
 *  first. `content` and `tool_schemas` are content-addressed, so any copy is the same row. */
const BATCH_KEY: Partial<Record<WarehouseTable, string>> = {
  llm_calls: "call_id",
  content: "ref",
  tool_schemas: "hash",
};

export function dedupeBatch(
  table: WarehouseTable,
  rows: readonly Record<string, SqlValue | undefined>[],
): Record<string, SqlValue | undefined>[] {
  const key = BATCH_KEY[table];
  if (!key) return [...rows];
  const byKey = new Map<unknown, Record<string, SqlValue | undefined>>();
  const loose: Record<string, SqlValue | undefined>[] = [];
  for (const r of rows) {
    const k = r[key];
    if (k === null || k === undefined) loose.push(r);
    else {
      byKey.delete(k);
      byKey.set(k, r);
    }
  }
  return [...byKey.values(), ...loose];
}

export interface DrainResult {
  /** Outbox rows marked exported by this drain. */
  exported: number;
  /** Rows newly inserted into warehouse tables (skipped duplicates excluded). */
  inserted: number;
  /** Outbox rows skipped because the ledger already held their seq. */
  alreadyApplied: number;
  batches: number;
  byTable: Partial<Record<WarehouseTable, number>>;
}

/** Drain every pending outbox row into the warehouse in batches of `batchSize`. */
export async function drainOutbox(
  journal: Journal,
  warehouse: Warehouse,
  opts: { batchSize?: number; now?: () => number } = {},
): Promise<DrainResult> {
  const batchSize = opts.batchSize ?? 5000;
  const now = opts.now ?? Date.now;
  const out: DrainResult = {
    exported: 0,
    inserted: 0,
    alreadyApplied: 0,
    batches: 0,
    byTable: {},
  };
  await warehouse.run(LEDGER_DDL);
  for (;;) {
    const batch = await journal.pendingOutbox(batchSize);
    if (batch.length === 0) break;
    const seqs = batch.map((o) => o.seq);
    await warehouse.transaction(async (wh) => {
      const done = new Set(
        (
          await wh.all<{ seq: number }>(
            `SELECT seq FROM ${OUTBOX_LEDGER_TABLE} WHERE seq IN (SELECT unnest($1::BIGINT[]))`,
            [seqs],
          )
        ).map((r) => Number(r.seq)),
      );
      const fresh = batch.filter((o) => !done.has(o.seq));
      out.alreadyApplied += batch.length - fresh.length;
      const byTable = new Map<WarehouseTable, OutboxRow[]>();
      for (const o of fresh) {
        const g = byTable.get(o.target_table);
        if (g) g.push(o);
        else byTable.set(o.target_table, [o]);
      }
      for (const [table, rows] of byTable) {
        try {
          const n = await wh.appendRows(table, dedupeBatch(table, rows.map(prepare)), {
            onConflict: "ignore",
          });
          out.inserted += n;
          out.byTable[table] = (out.byTable[table] ?? 0) + n;
        } catch (e) {
          const range = `${rows[0]?.seq}..${rows[rows.length - 1]?.seq}`;
          throw new Error(
            `drainOutbox: ${table} rows (seq ${range}): ${(e as Error).message}`,
            {
              cause: e,
            },
          );
        }
      }
      if (fresh.length > 0) {
        await wh.run(
          `INSERT INTO ${OUTBOX_LEDGER_TABLE} (seq, target_table)
           SELECT unnest($1::BIGINT[]), unnest($2::VARCHAR[])`,
          [fresh.map((o) => o.seq), fresh.map((o) => o.target_table)],
        );
      }
    });
    await journal.markExported(seqs, now());
    out.exported += batch.length;
    out.batches += 1;
    if (batch.length < batchSize) break;
  }
  return out;
}
