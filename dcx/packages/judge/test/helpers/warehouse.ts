// A minimal in-memory Warehouse over core's openWarehouse, for tests only (@dcx/store is built
// in parallel). Complex values are bound as JSON text and CAST to the column's type.

import { openWarehouse, type SqlValue, type Warehouse, type WarehouseTable } from "@dcx/core";

type Conn = Awaited<ReturnType<typeof openWarehouse>>["conn"];

const bind = (v: SqlValue): unknown =>
  v === null || typeof v !== "object" || v instanceof Date ? v : JSON.stringify(v);

export async function memoryWarehouse(): Promise<Warehouse & { conn: Conn }> {
  const h = await openWarehouse(":memory:");
  const types = new Map<string, Map<string, string>>();
  let depth = 0;
  const colTypes = async (table: string) => {
    let m = types.get(table);
    if (!m) {
      const r = await h.conn.runAndReadAll(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1",
        [table],
      );
      m = new Map(
        r.getRowObjectsJson().map((x) => [String(x.column_name), String(x.data_type)]),
      );
      types.set(table, m);
    }
    return m;
  };
  const wh: Warehouse & { conn: Conn } = {
    path: ":memory:",
    conn: h.conn,
    async all<T>(sql: string, params: readonly SqlValue[] = []) {
      const r = await h.conn.runAndReadAll(sql, params.map(bind) as never);
      return r.getRowObjectsJson() as T[];
    },
    async run(sql: string, params: readonly SqlValue[] = []) {
      await h.conn.run(sql, params.map(bind) as never);
    },
    async appendRows(table: WarehouseTable, rows, opts = {}) {
      const t = await colTypes(table);
      let n = 0;
      for (const row of rows) {
        const cols = Object.keys(row).filter((k) => row[k] !== undefined);
        const vals = cols.map((c, i) => {
          const ty = t.get(c) ?? "VARCHAR";
          const v = row[c] as SqlValue;
          if (v !== null && typeof v === "object" && !(v instanceof Date)) {
            return ty === "JSON"
              ? `CAST($${i + 1} AS JSON)`
              : `CAST(CAST($${i + 1} AS JSON) AS ${ty})`;
          }
          return `CAST($${i + 1} AS ${ty})`;
        });
        const conflict = opts.onConflict === "ignore" ? " ON CONFLICT DO NOTHING" : "";
        const r = await h.conn.run(
          `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${vals.join(", ")})${conflict}`,
          cols.map((c) => bind(row[c] as SqlValue)) as never,
        );
        n += Number(r.rowsChanged);
      }
      return n;
    },
    async transaction(fn) {
      if (depth > 0) return fn(wh);
      depth++;
      await h.conn.run("BEGIN TRANSACTION");
      try {
        const out = await fn(wh);
        await h.conn.run("COMMIT");
        return out;
      } catch (e) {
        await h.conn.run("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    },
    async close() {
      h.close();
    },
  };
  return wh;
}
