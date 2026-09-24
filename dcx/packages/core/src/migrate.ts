// Idempotent migrations for both stores plus thin openers. 07 §3 item 4 (two stores), §4.2.
// `openJournal` / `openWarehouse` return raw driver handles; @dcx/store wraps them into the
// `Journal` / `Warehouse` interfaces. Nothing else in dcx should open the files directly.

import { existsSync, readFileSync } from "node:fs";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import Database from "better-sqlite3";

export type Store = "sqlite" | "duckdb";

/** A schema migration. Version 1 is the full schema file; later versions append. */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Current schema version of both stores. */
export const SCHEMA_VERSION = 1;

/** Read a bundled schema file (`src/schema/<store>.sql`; also found next to a built dist). */
export function schemaSql(store: Store): string {
  for (const rel of [`./schema/${store}.sql`, `../src/schema/${store}.sql`]) {
    const url = new URL(rel, import.meta.url);
    if (existsSync(url)) return readFileSync(url, "utf8");
  }
  throw new Error(`schema file for ${store} not found`);
}

/** The ordered migrations for a store. */
export function migrations(store: Store): Migration[] {
  return [{ version: 1, name: "initial", sql: schemaSql(store) }];
}

// ---------------------------------------------------------------------------------------------
// SQLite journal
// ---------------------------------------------------------------------------------------------

/** Apply pending migrations in one transaction each. Returns the versions applied (empty when
 *  already current). Safe to call on every open. */
export function migrateSqlite(db: Database.Database): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  const done = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  const applied: number[] = [];
  for (const m of migrations("sqlite")) {
    if (done.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(m.version, m.name, Date.now());
    })();
    applied.push(m.version);
  }
  return applied;
}

/** Open (creating if needed) and migrate the SQLite journal: WAL, synchronous=NORMAL,
 *  busy_timeout 5 s, foreign keys on. Many readers may open it concurrently. */
export function openJournal(
  path: string,
  opts: { readonly?: boolean } = {},
): Database.Database {
  const db = new Database(path, { readonly: opts.readonly ?? false });
  db.pragma("busy_timeout = 5000");
  if (!opts.readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    migrateSqlite(db);
  }
  return db;
}

// ---------------------------------------------------------------------------------------------
// DuckDB warehouse
// ---------------------------------------------------------------------------------------------

/** Apply pending migrations, each in one transaction. Returns the versions applied. */
export async function migrateDuckdb(conn: DuckDBConnection): Promise<number[]> {
  await conn.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name VARCHAR NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp)`);
  const reader = await conn.runAndReadAll("SELECT version FROM schema_migrations");
  const done = new Set(reader.getRowObjectsJson().map((r) => Number(r.version)));
  const applied: number[] = [];
  for (const m of migrations("duckdb")) {
    if (done.has(m.version)) continue;
    await conn.run("BEGIN TRANSACTION");
    try {
      await conn.run(m.sql);
      await conn.run("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
        m.version,
        m.name,
      ]);
      await conn.run("COMMIT");
    } catch (e) {
      await conn.run("ROLLBACK");
      throw e;
    }
    applied.push(m.version);
  }
  return applied;
}

/** A raw warehouse handle. Exactly one dcx process may hold it (DuckDB's file lock). */
export interface WarehouseHandle {
  readonly path: string;
  readonly instance: DuckDBInstance;
  readonly conn: DuckDBConnection;
  close(): void;
}

/** Open (creating if needed) and migrate the DuckDB warehouse. `readOnly` skips migration. */
export async function openWarehouse(
  path: string,
  opts: { readOnly?: boolean } = {},
): Promise<WarehouseHandle> {
  const instance = await DuckDBInstance.create(
    path,
    opts.readOnly ? { access_mode: "READ_ONLY" } : {},
  );
  const conn = await instance.connect();
  if (!opts.readOnly) await migrateDuckdb(conn);
  return {
    path,
    instance,
    conn,
    close() {
      conn.closeSync();
      instance.closeSync();
    },
  };
}
