// Minimal Journal / Warehouse over core's openers, for kernel tests only.
// TODO(store): replace with @dcx/store's SQLite journal, DuckDB warehouse and exporter.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HitlRow,
  type Journal,
  type Json,
  type OutboxEntry,
  type OutboxRow,
  openJournal,
  openWarehouse,
  type RunRow,
  type SqlValue,
  type StepRow,
  type Warehouse,
  type WarehouseTable,
} from "@dcx/core";
import type { DuckDBValue } from "@duckdb/node-api";

type Row = Record<string, unknown>;
const J = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const P = (v: unknown) => (typeof v === "string" ? (JSON.parse(v) as Json) : null);

export function sqliteJournal(path: string, now: () => number = Date.now): Journal {
  const db = openJournal(path);
  const outbox = (entries: readonly OutboxEntry[]) =>
    entries.map(
      (e) =>
        db
          .prepare("INSERT INTO outbox (target_table, row, created_at) VALUES (?, ?, ?)")
          .run(e.target_table, JSON.stringify(e.row), now()).lastInsertRowid as number,
    );
  const step = (r: Row | undefined): StepRow | null =>
    r ? ({ ...r, output: P(r.output) } as unknown as StepRow) : null;
  const hitl = (r: Row): HitlRow =>
    ({
      ...r,
      card: P(r.card),
      tiers: P(r.tiers),
      resolution: P(r.resolution),
      default_on_timeout: P(r.default_on_timeout),
    }) as unknown as HitlRow;
  const set = (table: string, where: string, patch: Row, args: unknown[]) => {
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
    if (!keys.length) return 0;
    const vals = keys.map((k) => (typeof patch[k] === "boolean" ? Number(patch[k]) : patch[k]));
    return db
      .prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE ${where}`)
      .run(...vals, ...args).changes;
  };
  return {
    async startRun(r: RunRow) {
      const c = db
        .prepare(
          "INSERT OR IGNORE INTO runs (run_id, workflow, workflow_v, mode, status, input_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          r.run_id,
          r.workflow,
          r.workflow_v,
          r.mode,
          r.status,
          r.input_ref ?? null,
          r.created_at,
        ).changes;
      return c ? "inserted" : "exists";
    },
    async getRun(id) {
      return (
        (db.prepare("SELECT * FROM runs WHERE run_id = ?").get(id) as RunRow | undefined) ??
        null
      );
    },
    async updateRun(id, patch) {
      set("runs", "run_id = ?", patch, [id]);
    },
    async lease(exec, ttl) {
      const t = now();
      const rows = db
        .prepare(
          "UPDATE runs SET executor_id = ?, lease_until = ? WHERE status IN ('pending','running') AND (lease_until IS NULL OR lease_until < ?) RETURNING run_id",
        )
        .all(exec, t + ttl, t) as { run_id: string }[];
      return rows.map((r) => r.run_id);
    },
    async heartbeat(id, exec, ttl) {
      const t = now();
      return (
        set(
          "runs",
          "run_id = ? AND executor_id = ?",
          { lease_until: t + ttl, heartbeat_at: t },
          [id, exec],
        ) > 0
      );
    },
    async getStep(id, n) {
      return step(
        db.prepare("SELECT * FROM steps WHERE run_id = ? AND step_no = ?").get(id, n) as
          | Row
          | undefined,
      );
    },
    async listSteps(id) {
      return (
        db.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY step_no").all(id) as Row[]
      ).map((r) => step(r) as StepRow);
    },
    async putStep(s) {
      const c = db
        .prepare(
          `INSERT OR IGNORE INTO steps (run_id, step_no, parent_step_no, kind, name, status, attempt, mode, input_ref, output, error, idempotency_key, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          s.run_id,
          s.step_no,
          s.parent_step_no ?? null,
          s.kind,
          s.name,
          s.status,
          s.attempt ?? 1,
          s.mode,
          s.input_ref ?? null,
          J(s.output),
          s.error ?? null,
          s.idempotency_key ?? null,
          s.started_at ?? null,
          s.ended_at ?? null,
        ).changes;
      return c ? "inserted" : "exists";
    },
    async completeStep(id, n, patch, entries = []) {
      db.transaction(() => {
        set(
          "steps",
          "run_id = ? AND step_no = ?",
          { ...patch, output: patch.output === undefined ? undefined : J(patch.output) },
          [id, n],
        );
        outbox(entries);
      })();
    },
    async putToolCall(t) {
      const c = db
        .prepare(
          "INSERT OR IGNORE INTO tool_calls (run_id, step_no, tool, tool_schema_hash, args_canonical, args_hash, effect_class, idempotency_key, in_doubt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          t.run_id,
          t.step_no,
          t.tool,
          t.tool_schema_hash ?? null,
          t.args_canonical,
          t.args_hash,
          t.effect_class ?? null,
          t.idempotency_key ?? null,
          t.in_doubt ? 1 : 0,
        ).changes;
      return c ? "inserted" : "exists";
    },
    async updateToolCall(id, n, patch) {
      set("tool_calls", "run_id = ? AND step_no = ?", patch, [id, n]);
    },
    async enqueueHuman(t) {
      db.prepare(
        `INSERT INTO hitl_queue (id, kind, run_id, step_no, decision_point_id, question_ref, card, tiers, reason_code, priority, deadline, default_on_timeout, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        t.id,
        t.kind,
        t.run_id ?? null,
        t.step_no ?? null,
        t.decision_point_id ?? null,
        t.question_ref ?? null,
        J(t.card),
        J(t.tiers),
        t.reason_code ?? null,
        t.priority ?? 0,
        t.deadline ?? null,
        J(t.default_on_timeout),
        t.created_at,
      );
    },
    async listHuman(f = {}) {
      const rows = db
        .prepare("SELECT * FROM hitl_queue ORDER BY priority DESC, created_at")
        .all() as Row[];
      return rows
        .map(hitl)
        .filter(
          (h) => (!f.kind || h.kind === f.kind) && (!f.unresolvedOnly || h.resolved_at == null),
        );
    },
    async claimHuman(id, who, ttl) {
      const t = now();
      return (
        set(
          "hitl_queue",
          "id = ? AND (claimed_until IS NULL OR claimed_until < ?)",
          { claimed_by: who, claimed_until: t + ttl },
          [id, t],
        ) > 0
      );
    },
    async resolveHuman(id, res, label) {
      db.transaction(() => {
        const h = db
          .prepare("SELECT run_id, step_no FROM hitl_queue WHERE id = ?")
          .get(id) as Row;
        set(
          "hitl_queue",
          "id = ?",
          {
            resolved_at: res.at,
            resolution: J(res.resolution),
            resolver: res.resolver,
            notes: res.notes,
          },
          [id],
        );
        set(
          "steps",
          "run_id = ? AND step_no = ?",
          { status: "completed", output: J(res.resolution), ended_at: res.at },
          [h.run_id, h.step_no],
        );
        if (label)
          outbox([{ target_table: "labels", row: label as unknown as Record<string, Json> }]);
        set("runs", "run_id = ?", { status: "pending" }, [h.run_id]);
      })();
    },
    async enqueueOutbox(entries) {
      return db.transaction(() => outbox(entries))();
    },
    async pendingOutbox(limit) {
      const rows = db
        .prepare("SELECT * FROM outbox WHERE exported_at IS NULL ORDER BY seq LIMIT ?")
        .all(limit) as Row[];
      return rows.map((r) => ({ ...r, row: P(r.row) }) as unknown as OutboxRow);
    },
    async markExported(seqs, at) {
      for (const s of seqs)
        db.prepare("UPDATE outbox SET exported_at = ? WHERE seq = ?").run(at, s);
    },
    async close() {
      db.close();
    },
  };
}

export async function duckWarehouse(path: string): Promise<Warehouse> {
  const h = await openWarehouse(path);
  const types = new Map<string, Map<string, string>>();
  const colTypes = async (t: string) => {
    let m = types.get(t);
    if (!m) {
      const r = await h.conn.runAndReadAll(`DESCRIBE ${t}`);
      m = new Map(
        r.getRowObjectsJson().map((x) => [String(x.column_name), String(x.column_type)]),
      );
      types.set(t, m);
    }
    return m;
  };
  const wh: Warehouse = {
    path,
    async all(sql, params = []) {
      const r = await h.conn.runAndReadAll(sql, params as DuckDBValue[]);
      return r.getRowObjectsJson() as never[];
    },
    async run(sql, params = []) {
      await h.conn.run(sql, params as DuckDBValue[]);
    },
    async appendRows(table, rows, opts = {}) {
      const ct = await colTypes(table);
      for (const row of rows) {
        const cols = Object.keys(row).filter((k) => row[k] !== undefined && ct.has(k));
        const vals: SqlValue[] = [];
        const ph = cols.map((c) => {
          const v = row[c] as SqlValue;
          const t = ct.get(c) as string;
          if (v !== null && (typeof v === "object" || t === "JSON")) {
            vals.push(JSON.stringify(v));
            return `CAST(?::JSON AS ${t})`;
          }
          vals.push(v);
          return "?";
        });
        const conflict = opts.onConflict === "ignore" ? " ON CONFLICT DO NOTHING" : "";
        await h.conn.run(
          `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${ph.join(", ")})${conflict}`,
          vals as DuckDBValue[],
        );
      }
      return rows.length;
    },
    async transaction(fn) {
      return fn(wh);
    },
    async close() {
      h.close();
    },
  };
  return wh;
}

/** Drain the outbox into DuckDB (content-addressed tables ignore duplicates). */
export async function exportOutbox(j: Journal, wh: Warehouse): Promise<number> {
  const rows = await j.pendingOutbox(10_000);
  const dedupe = new Set<WarehouseTable>(["content", "tool_schemas"]);
  for (const r of rows) {
    await wh.appendRows(r.target_table, [r.row as Record<string, SqlValue>], {
      onConflict: dedupe.has(r.target_table) ? "ignore" : "error",
    });
  }
  await j.markExported(
    rows.map((r) => r.seq),
    Date.now(),
  );
  return rows.length;
}

export interface Stores {
  dir: string;
  journal: Journal;
  warehouse: Warehouse;
  cleanup(): Promise<void>;
}

export async function tempStores(clock: () => number = Date.now): Promise<Stores> {
  const dir = mkdtempSync(join(tmpdir(), "dcx-kernel-"));
  const journal = sqliteJournal(join(dir, "journal.sqlite"), clock);
  const warehouse = await duckWarehouse(join(dir, "warehouse.duckdb"));
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
