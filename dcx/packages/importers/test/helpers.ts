// Test-only Warehouse over core's openWarehouse: INSERT ... ON CONFLICT per row, with JSON and
// list columns cast from JSON text. @dcx/store owns the real appender; this checks our rows
// against the DDL (types, CHECKs, H5) without depending on it.
import { openWarehouse, type SqlValue, type Warehouse, type WarehouseHandle } from "@dcx/core";

export async function testWarehouse(): Promise<Warehouse & { handle: WarehouseHandle }> {
  const handle = await openWarehouse(":memory:");
  const types = new Map<string, Map<string, string>>();
  const colTypes = async (t: string) => {
    let m = types.get(t);
    if (!m) {
      const r = await handle.conn.runAndReadAll(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1",
        [t],
      );
      m = new Map(r.getRowObjects().map((o) => [String(o.column_name), String(o.data_type)]));
      types.set(t, m);
    }
    return m;
  };
  const wh: Warehouse & { handle: WarehouseHandle } = {
    handle,
    path: ":memory:",
    async all<T>(sql: string, params: readonly SqlValue[] = []) {
      const r = await handle.conn.runAndReadAll(sql, params as never);
      return r.getRowObjectsJson() as T[];
    },
    async run(sql, params = []) {
      await handle.conn.run(sql, params as never);
    },
    async appendRows(table, rows, opts = {}) {
      const ct = await colTypes(table);
      let n = 0;
      for (const row of rows) {
        const keys = Object.keys(row).filter((k) => row[k] !== undefined);
        const vals: unknown[] = [];
        const exprs = keys.map((k, i) => {
          const v = row[k];
          const t = ct.get(k);
          if (!t) throw new Error(`${table}.${k}: no such column`);
          if ((v !== null && typeof v === "object") || (t === "JSON" && v !== null)) {
            vals.push(JSON.stringify(v));
            return `CAST($${i + 1}::JSON AS ${t})`;
          }
          vals.push(v);
          return `CAST($${i + 1} AS ${t})`;
        });
        const conflict = opts.onConflict === "ignore" ? " ON CONFLICT DO NOTHING" : "";
        const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${exprs.join(", ")})${conflict}`;
        const r = await handle.conn.run(sql, vals as never);
        n += r.rowsChanged;
      }
      return n;
    },
    async transaction(fn) {
      await handle.conn.run("BEGIN TRANSACTION");
      try {
        const out = await fn(wh);
        await handle.conn.run("COMMIT");
        return out;
      } catch (e) {
        await handle.conn.run("ROLLBACK");
        throw e;
      }
    },
    async close() {
      handle.close();
    },
  };
  return wh;
}
