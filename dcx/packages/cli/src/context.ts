// Per-invocation context: config, output streams and the two stores. The DuckDB warehouse is
// opened at most once per process, through @dcx/store (whose registry refuses a second opener),
// and the journal's pending outbox is drained into it on open and again before close (07 §4.2:
// "the next dcx process to open DuckDB drains the outbox").

import type { DuckWarehouse, SqliteJournal } from "@dcx/store";
import {
  type DrainResult,
  drainOutbox,
  openDuckWarehouse,
  openSqliteJournal,
} from "@dcx/store";
import { type LoadedConfig, loadConfig } from "./config.js";

export interface Io {
  out(line: string): void;
  err(line: string): void;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** A user-facing error: printed without a stack, exit code 1. */
export class CliError extends Error {
  override name = "CliError";
}

export class Context {
  private wh: DuckWarehouse | null = null;
  private j: SqliteJournal | null = null;
  private cfg: LoadedConfig | null = null;
  lastDrain: DrainResult | null = null;

  constructor(
    readonly io: Io,
    private readonly dirOverride?: string,
  ) {}

  get config(): LoadedConfig {
    this.cfg ??= loadConfig(
      this.io.cwd,
      this.dirOverride ? { ...this.io.env, DCX_DIR: this.dirOverride } : this.io.env,
    );
    return this.cfg;
  }

  out(line = ""): void {
    this.io.out(line);
  }

  journal(): SqliteJournal {
    this.j ??= openSqliteJournal(this.config.paths.journal);
    return this.j;
  }

  /** The warehouse, opened once for this process; the outbox is drained on first open. */
  async warehouse(): Promise<DuckWarehouse> {
    if (!this.wh) {
      this.wh = await openDuckWarehouse(this.config.paths.warehouse);
      this.lastDrain = await drainOutbox(this.journal(), this.wh);
    }
    return this.wh;
  }

  /** Drain the journal outbox into the warehouse now. */
  async drain(): Promise<DrainResult> {
    const wh = await this.warehouse();
    this.lastDrain = await drainOutbox(this.journal(), wh);
    return this.lastDrain;
  }

  async close(): Promise<void> {
    if (this.wh) {
      await drainOutbox(this.journal(), this.wh);
      await this.wh.close();
      this.wh = null;
    }
    if (this.j) {
      await this.j.close();
      this.j = null;
    }
  }
}
