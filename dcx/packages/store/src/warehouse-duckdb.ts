// The DuckDB warehouse over @duckdb/node-api. 07 §2 row 1: exactly one dcx process opens the
// file. 01 §2.1 [tested]: one read-write process holds a file lock and a second process cannot
// open the file even read-only; inside one process nothing stops a second instance on the same
// file, so a module-level registry enforces the single opener here. Bulk writes (01 §2.1,
// §3): executemany ran at ~870 rows/s and a single autocommitted INSERT costs ~1.6 ms, while
// batch paths run at ~1–2M rows/s. `appendRows` therefore appends into a TEMP staging table with
// the DuckDB appender and moves the batch with one `INSERT … SELECT` (casting JSON/MAP/LIST
// columns), optionally `ON CONFLICT DO NOTHING`.

import { resolve } from "node:path";
import {
  type AppendRow as CoreAppendRow,
  type Json,
  openWarehouse,
  type SqlValue,
  type Warehouse,
  type WarehouseHandle,
  type WarehouseOpener,
  type WarehouseTable,
} from "@dcx/core";
import {
  type DuckDBConnection,
  type DuckDBType,
  DuckDBTypeId,
  type DuckDBValue,
  listValue,
  timestampTZValue,
} from "@duckdb/node-api";

/** A row for `appendRows` (core's `AppendRow`, re-exported for existing importers). */
export type AppendRow = CoreAppendRow;

/** `Warehouse` with the wider `appendRows`; what `DuckWarehouse` and its transactions offer. */
export interface WideWarehouse extends Warehouse {
  appendRows(
    table: WarehouseTable,
    rows: readonly AppendRow[],
    opts?: { onConflict?: "error" | "ignore" },
  ): Promise<number>;
  transaction<T>(fn: (wh: WideWarehouse) => Promise<T>): Promise<T>;
}

/** Thrown when a second opener asks for a warehouse file that is already open. */
export class WarehouseLockedError extends Error {
  override name = "WarehouseLockedError";
}

const OPEN = new Map<string, { readOnly: boolean; since: string }>();

const isMemory = (path: string) => path === ":memory:" || path.startsWith(":memory:");
const registryKey = (path: string) => (isMemory(path) ? null : resolve(path));

const lockMessage = (path: string, detail: string) =>
  `DuckDB warehouse ${path} is already open ${detail}. Exactly one dcx process may open the ` +
  "warehouse (07 §2 row 1): DuckDB holds a file lock, and a second process cannot open the " +
  "file even read-only (01 §2.1, 03 §2.3 [tested]). Readers such as the HITL server use the " +
  "SQLite journal; run warehouse queries through the process that owns this handle.";

/** Paths currently open in this process (for diagnostics and tests). */
export function openWarehousePaths(): string[] {
  return [...OPEN.keys()];
}

interface ColumnInfo {
  name: string;
  type: string;
  /** How a staged VARCHAR becomes the column value. */
  kind: "varchar" | "json" | "via_json" | "cast";
}

interface TableInfo {
  columns: Map<string, ColumnInfo>;
  hasKey: boolean;
}

function classify(type: string): ColumnInfo["kind"] {
  if (type === "VARCHAR") return "varchar";
  if (type === "JSON") return "json";
  if (type.startsWith("MAP(") || type.startsWith("STRUCT(") || type.endsWith("]"))
    return "via_json";
  return "cast";
}

const jsonReplacer = (_k: string, v: unknown) => {
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  return v;
};
const toJsonText = (v: unknown) => JSON.stringify(v, jsonReplacer);

/** Encode one value for the VARCHAR staging column of a column of `kind`. */
function stage(v: SqlValue, kind: ColumnInfo["kind"]): string {
  if (kind === "json" || kind === "via_json") return toJsonText(v);
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return v.toISOString();
  return toJsonText(v);
}

const q = (ident: string) => `"${ident.replaceAll('"', '""')}"`;

/** Bind a SqlValue as a DuckDB parameter. Dates bind as TIMESTAMPTZ, arrays as LISTs and plain
 *  objects as JSON text. */
function toParam(v: SqlValue): DuckDBValue {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Date) return timestampTZValue(BigInt(v.getTime()) * 1000n);
  if (Array.isArray(v)) return listValue(v.map(toParam));
  return toJsonText(v);
}

/** Convert a result value to the TS shape the contract uses: JSON columns parsed, MAPs as
 *  objects, BIGINTs as numbers when safe, timestamps as ISO-8601 strings. */
function fromDuck(v: unknown, t: DuckDBType | undefined): unknown {
  if (v === null || v === undefined) return null;
  if (t?.alias === "JSON" && typeof v === "string") return JSON.parse(v);
  if (t?.typeId === DuckDBTypeId.MAP && Array.isArray(v)) {
    const out: Record<string, unknown> = {};
    for (const e of v as { key: unknown; value: unknown }[]) {
      out[String(e.key)] = fromDuck(e.value, t.valueType);
    }
    return out;
  }
  if (Array.isArray(v)) {
    const inner =
      t?.typeId === DuckDBTypeId.LIST || t?.typeId === DuckDBTypeId.ARRAY
        ? t.valueType
        : undefined;
    return v.map((x) => fromDuck(x, inner));
  }
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = fromDuck(x, undefined);
    return out;
  }
  return v;
}

let stageSeq = 0;

class DuckWarehouseImpl {
  private readonly tables = new Map<string, TableInfo>();
  constructor(readonly conn: DuckDBConnection) {}

  async all<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    const reader = await this.conn.runAndReadAll(sql, params.map(toParam));
    const names = reader.columnNames();
    const types = reader.columnTypes();
    return reader.getRowObjectsJS().map((r) => {
      const o: Record<string, unknown> = {};
      names.forEach((n, i) => {
        o[n] = fromDuck(r[n], types[i]);
      });
      return o as T;
    });
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<void> {
    await this.conn.run(sql, params.map(toParam));
  }

  async tableInfo(table: string): Promise<TableInfo> {
    const hit = this.tables.get(table);
    if (hit) return hit;
    const cols = await this.all<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM duckdb_columns()
       WHERE table_name = $1 AND schema_name = 'main' AND database_name = current_database()
       ORDER BY column_index`,
      [table],
    );
    if (cols.length === 0) throw new Error(`appendRows: unknown warehouse table ${table}`);
    const keys = await this.all<{ n: number }>(
      `SELECT count(*) AS n FROM duckdb_constraints()
       WHERE table_name = $1 AND schema_name = 'main' AND database_name = current_database()
         AND constraint_type IN ('PRIMARY KEY', 'UNIQUE')`,
      [table],
    );
    const info: TableInfo = {
      columns: new Map(
        cols.map((c) => [
          c.column_name,
          { name: c.column_name, type: c.data_type, kind: classify(c.data_type) },
        ]),
      ),
      hasKey: (keys[0]?.n ?? 0) > 0,
    };
    this.tables.set(table, info);
    return info;
  }

  async appendRows(
    table: WarehouseTable,
    input: readonly AppendRow[],
    opts: { onConflict?: "error" | "ignore" } = {},
  ): Promise<number> {
    const rows = input as readonly Record<string, SqlValue | undefined>[];
    if (rows.length === 0) return 0;
    const info = await this.tableInfo(table);
    // Rows are grouped by their set of defined keys: an omitted (undefined) column takes the
    // table default, an explicit null stays NULL.
    const groups = new Map<string, Record<string, SqlValue | undefined>[]>();
    for (const r of rows) {
      const cols = Object.keys(r).filter((k) => r[k] !== undefined);
      for (const c of cols) {
        if (!info.columns.has(c)) throw new Error(`appendRows: ${table} has no column ${c}`);
      }
      const sig = cols.sort().join("\u0000");
      const g = groups.get(sig);
      if (g) g.push(r);
      else groups.set(sig, [r]);
    }
    let written = 0;
    for (const [sig, group] of groups) {
      const cols =
        sig === "" ? [] : sig.split("\u0000").map((c) => info.columns.get(c) as ColumnInfo);
      written += await this.appendGroup(table, info, cols, group, opts.onConflict ?? "error");
    }
    return written;
  }

  private async appendGroup(
    table: string,
    info: TableInfo,
    cols: ColumnInfo[],
    rows: readonly Record<string, SqlValue | undefined>[],
    onConflict: "error" | "ignore",
  ): Promise<number> {
    const conflict = onConflict === "ignore" && info.hasKey ? " ON CONFLICT DO NOTHING" : "";
    if (cols.length === 0) {
      let n = 0;
      for (const _ of rows) {
        const r = await this.conn.run(`INSERT INTO ${q(table)} DEFAULT VALUES${conflict}`);
        n += Number(r.rowsChanged);
      }
      return n;
    }
    const stageName = `__dcx_stage_${++stageSeq}`;
    await this.conn.run(
      `CREATE TEMP TABLE ${q(stageName)} (${cols.map((c) => `${q(c.name)} VARCHAR`).join(", ")})`,
    );
    try {
      const app = await this.conn.createAppender(stageName, "main", "temp");
      try {
        for (const r of rows) {
          for (const c of cols) {
            const v = r[c.name] as SqlValue;
            if (v === null) app.appendNull();
            else app.appendVarchar(stage(v, c.kind));
          }
          app.endRow();
        }
        app.flushSync();
      } finally {
        app.closeSync();
      }
      const select = cols
        .map((c) => {
          const col = q(c.name);
          if (c.kind === "varchar") return col;
          if (c.kind === "json") return `CAST(${col} AS JSON)`;
          if (c.kind === "via_json") return `CAST(CAST(${col} AS JSON) AS ${c.type})`;
          return `CAST(${col} AS ${c.type})`;
        })
        .join(", ");
      const res = await this.conn.run(
        `INSERT INTO ${q(table)} (${cols.map((c) => q(c.name)).join(", ")})
         SELECT ${select} FROM temp.main.${q(stageName)}${conflict}`,
      );
      return Number(res.rowsChanged);
    } finally {
      // Inside a failed transaction the DROP itself fails; the ROLLBACK removes the table then,
      // and the original error must surface rather than "transaction is aborted".
      await this.conn
        .run(`DROP TABLE IF EXISTS temp.main.${q(stageName)}`)
        .catch(() => undefined);
    }
  }
}

/** A `Warehouse` over one DuckDB connection. Calls are serialised (one connection, one
 *  transaction at a time); `transaction(fn)` holds the connection for the whole of `fn`. */
export class DuckWarehouse implements WideWarehouse {
  readonly path: string;
  readonly readOnly: boolean;
  private readonly impl: DuckWarehouseImpl;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly handle: WarehouseHandle,
    private readonly key: string | null,
    readOnly: boolean,
  ) {
    this.path = handle.path;
    this.readOnly = readOnly;
    this.impl = new DuckWarehouseImpl(handle.conn);
  }

  /** The raw connection, for code that needs the node-api directly (e.g. Arrow scans). */
  get connection(): DuckDBConnection {
    return this.handle.conn;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`warehouse ${this.path} is closed`));
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  all<T = Record<string, Json>>(sql: string, params?: readonly SqlValue[]): Promise<T[]> {
    return this.exclusive(() => this.impl.all<T>(sql, params));
  }

  run(sql: string, params?: readonly SqlValue[]): Promise<void> {
    return this.exclusive(() => this.impl.run(sql, params));
  }

  /** Accepts core's `*Row` interfaces directly (they lack an index signature). */
  appendRows(
    table: WarehouseTable,
    rows: readonly AppendRow[],
    opts?: { onConflict?: "error" | "ignore" },
  ): Promise<number> {
    return this.exclusive(() => this.impl.appendRows(table, rows, opts));
  }

  transaction<T>(fn: (wh: WideWarehouse) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const impl = this.impl;
      const inner: WideWarehouse = {
        path: this.path,
        all: (sql, params) => impl.all(sql, params),
        run: (sql, params) => impl.run(sql, params),
        appendRows: (table, rows, opts) => impl.appendRows(table, rows, opts),
        transaction: (f) => f(inner),
        close: () => Promise.reject(new Error("close() inside a transaction")),
      };
      await impl.run("BEGIN TRANSACTION");
      try {
        const out = await fn(inner);
        await impl.run("COMMIT");
        return out;
      } catch (e) {
        await impl.run("ROLLBACK");
        throw e;
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.exclusive(async () => undefined);
    this.closed = true;
    this.handle.close();
    if (this.key) OPEN.delete(this.key);
  }
}

/** Open (creating and migrating) the warehouse. A second open of the same file in this process
 *  throws `WarehouseLockedError`; so does a file another process holds. `:memory:` is exempt:
 *  every in-memory open is a separate database. */
export async function openDuckWarehouse(
  path: string,
  opts: { readOnly?: boolean } = {},
): Promise<DuckWarehouse> {
  const key = registryKey(path);
  const readOnly = opts.readOnly ?? false;
  if (key) {
    const held = OPEN.get(key);
    if (held) {
      throw new WarehouseLockedError(
        lockMessage(
          path,
          `in this process (${held.readOnly ? "read-only" : "read-write"}, since ${held.since})`,
        ),
      );
    }
    OPEN.set(key, { readOnly, since: new Date().toISOString() });
  }
  try {
    const handle = await openWarehouse(path, { readOnly });
    return new DuckWarehouse(handle, key, readOnly);
  } catch (e) {
    if (key) OPEN.delete(key);
    const msg = (e as Error).message ?? String(e);
    if (/lock/i.test(msg)) {
      throw new WarehouseLockedError(`${lockMessage(path, "by another process")} (${msg})`);
    }
    throw e;
  }
}

/** The `WarehouseOpener` core expects. */
export const openWarehouseStore: WarehouseOpener = (path, opts) =>
  openDuckWarehouse(path, opts);
