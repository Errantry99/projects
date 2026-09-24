// Kernel test stores: @dcx/store's SQLite journal and DuckDB warehouse in a temp directory, and
// its exporter for draining the outbox.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journal, Warehouse } from "@dcx/core";
import { drainOutbox, openDuckWarehouse, openSqliteJournal } from "@dcx/store";

/** Drain the outbox into DuckDB; returns the outbox rows exported. */
export async function exportOutbox(j: Journal, wh: Warehouse): Promise<number> {
  return (await drainOutbox(j, wh)).exported;
}

export interface Stores {
  dir: string;
  journal: Journal;
  warehouse: Warehouse;
  cleanup(): Promise<void>;
}

export async function tempStores(clock: () => number = Date.now): Promise<Stores> {
  const dir = mkdtempSync(join(tmpdir(), "dcx-kernel-"));
  const journal = openSqliteJournal(join(dir, "journal.sqlite"), { now: clock });
  const warehouse = await openDuckWarehouse(join(dir, "warehouse.duckdb"));
  return {
    dir,
    journal,
    warehouse,
    async cleanup() {
      await journal.close();
      await warehouse.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
