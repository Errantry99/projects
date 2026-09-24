// The SQLite journal: runs, steps, tool calls, the HITL queue and the warehouse outbox.
// 07 §2 row 1 (SQLite holds the journal; DuckDB has exactly one opener), 03 §2.3 (DBOS
// operation_outputs: results persisted insert-if-absent; leases and heartbeats; in-doubt tool
// calls), 03 §3.5 (HITL resolve = step result + label + resume in one transaction).
// WAL + synchronous=NORMAL come from core's `openJournal`. better-sqlite3 is synchronous; the
// methods are async so a Postgres journal can implement the same interface later.

import { randomUUID } from "node:crypto";
import {
  type HitlRow,
  type Journal,
  type JournalOpener,
  type Json,
  type JsonObject,
  jsonHash,
  type LabelRow,
  type OutboxEntry,
  type OutboxRow,
  openJournal,
  type RunRow,
  type StepRow,
  type ToolCallRow,
  type WarehouseTable,
} from "@dcx/core";
import type Database from "better-sqlite3";

/** A replayed step or tool call does not match what the journal recorded for that step_no. */
export class JournalDivergenceError extends Error {
  override name = "JournalDivergenceError";
}

/** Warehouse tables whose primary key is a server-side `uuid()` default. The journal assigns the
 *  id when the row is enqueued, so a re-drained row hits the same key (exporter idempotency). */
const UUID_KEYED: Partial<Record<WarehouseTable, string>> = {
  labels: "label_id",
  judge_calls: "call_id",
};

/** Run statuses `lease()` may claim when the lease is absent or expired. A `waiting` (or
 *  `suspended`) run holds no lease; `resolveHuman` moves it back to `pending`. */
export const RESUMABLE_STATUSES = ["pending", "running"] as const;

export interface SqliteJournalOptions {
  readonly?: boolean;
  /** Clock for leases, claims and heartbeats (epoch ms). Tests inject a fake clock. */
  now?: () => number;
}

type Raw = Record<string, unknown>;

const enc = (v: Json | undefined): string | null =>
  v === undefined ? null : JSON.stringify(v);
const dec = (v: unknown): Json | undefined =>
  v === null || v === undefined ? undefined : (JSON.parse(v as string) as Json);

/** Copy `raw` without the given JSON columns' SQL NULLs, parsing the rest. */
function parseJsonCols<T>(raw: Raw, cols: readonly string[]): T {
  const out: Raw = { ...raw };
  for (const c of cols) {
    const v = dec(raw[c]);
    if (v === undefined) delete out[c];
    else out[c] = v;
  }
  return out as T;
}

const toStep = (r: Raw): StepRow => parseJsonCols<StepRow>(r, ["output"]);
const toHitl = (r: Raw): HitlRow =>
  parseJsonCols<HitlRow>(r, ["card", "tiers", "default_on_timeout", "resolution"]);
const toTool = (r: Raw): ToolCallRow => ({
  ...(r as unknown as ToolCallRow),
  in_doubt: !!r.in_doubt,
});
const toOutbox = (r: Raw): OutboxRow => ({
  ...(r as unknown as OutboxRow),
  row: JSON.parse(r.row as string) as JsonObject,
});

/** The default idempotency key of a tool step: hash(run_id, step_no). 03 §2.3 item 3. */
export const toolIdempotencyKey = (runId: string, stepNo: number): string =>
  jsonHash(["dcx/tool@1", runId, stepNo]);

export class SqliteJournal implements Journal {
  readonly db: Database.Database;
  private readonly now: () => number;

  constructor(db: Database.Database, opts: { now?: () => number } = {}) {
    this.db = db;
    this.now = opts.now ?? Date.now;
  }

  // -- runs ------------------------------------------------------------------------------------

  async startRun(r: RunRow): Promise<"inserted" | "exists"> {
    const info = this.db
      .prepare(
        `INSERT INTO runs (run_id, workflow, workflow_v, mode, status, input_ref, executor_id,
           lease_until, heartbeat_at, created_at, ended_at)
         VALUES (@run_id, @workflow, @workflow_v, @mode, @status, @input_ref, @executor_id,
           @lease_until, @heartbeat_at, @created_at, @ended_at)
         ON CONFLICT (run_id) DO NOTHING`,
      )
      .run({
        input_ref: null,
        executor_id: null,
        lease_until: null,
        heartbeat_at: null,
        ended_at: null,
        ...r,
      });
    return info.changes === 1 ? "inserted" : "exists";
  }

  async getRun(runId: string): Promise<RunRow | null> {
    return (
      (this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as RunRow) ?? null
    );
  }

  async updateRun(
    runId: string,
    patch: Partial<Pick<RunRow, "status" | "ended_at" | "executor_id" | "lease_until">>,
  ): Promise<void> {
    const keys = Object.keys(patch).filter((k) =>
      ["status", "ended_at", "executor_id", "lease_until"].includes(k),
    );
    if (keys.length === 0) return;
    const set = keys.map((k) => `${k} = @${k}`).join(", ");
    this.db
      .prepare(`UPDATE runs SET ${set} WHERE run_id = @run_id`)
      .run({ ...patch, run_id: runId });
  }

  /** Atomically claim every resumable run whose lease is absent or expired. */
  async lease(executorId: string, ttlMs: number): Promise<string[]> {
    const now = this.now();
    const claim = this.db.transaction(() => {
      const ids = (
        this.db
          .prepare(
            `SELECT run_id FROM runs
             WHERE status IN (${RESUMABLE_STATUSES.map((s) => `'${s}'`).join(",")})
               AND (lease_until IS NULL OR lease_until < ?)
             ORDER BY created_at, run_id`,
          )
          .all(now) as { run_id: string }[]
      ).map((r) => r.run_id);
      const upd = this.db.prepare(
        "UPDATE runs SET executor_id = ?, lease_until = ?, heartbeat_at = ? WHERE run_id = ?",
      );
      for (const id of ids) upd.run(executorId, now + ttlMs, now, id);
      return ids;
    });
    return claim.immediate();
  }

  /** Renew a lease. False when another executor has taken the run over (the caller must stop). */
  async heartbeat(runId: string, executorId: string, ttlMs: number): Promise<boolean> {
    const now = this.now();
    const info = this.db
      .prepare(
        `UPDATE runs SET lease_until = ?, heartbeat_at = ?
         WHERE run_id = ? AND executor_id = ?`,
      )
      .run(now + ttlMs, now, runId, executorId);
    return info.changes === 1;
  }

  // -- steps -----------------------------------------------------------------------------------

  async getStep(runId: string, stepNo: number): Promise<StepRow | null> {
    const r = this.db
      .prepare("SELECT * FROM steps WHERE run_id = ? AND step_no = ?")
      .get(runId, stepNo) as Raw | undefined;
    return r ? toStep(r) : null;
  }

  async listSteps(runId: string): Promise<StepRow[]> {
    const rows = this.db
      .prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY step_no")
      .all(runId) as Raw[];
    return rows.map(toStep);
  }

  /** Insert-if-absent on (run_id, step_no). A second write never overwrites; a replay whose
   *  kind or name differs from the recorded step throws JournalDivergenceError. */
  async putStep(s: StepRow): Promise<"inserted" | "exists"> {
    return (await this.putStepReturning(s)).status;
  }

  /** `putStep` that also returns the stored row: on "exists" it is the recorded step, whose
   *  `output` the kernel returns instead of re-executing (DBOS operation_outputs). */
  async putStepReturning(
    s: StepRow,
  ): Promise<{ status: "inserted" | "exists"; step: StepRow }> {
    const info = this.db
      .prepare(
        `INSERT INTO steps (run_id, step_no, parent_step_no, kind, name, status, attempt, mode,
           input_ref, output, error, idempotency_key, started_at, ended_at)
         VALUES (@run_id, @step_no, @parent_step_no, @kind, @name, @status, @attempt, @mode,
           @input_ref, @output, @error, @idempotency_key, @started_at, @ended_at)
         ON CONFLICT (run_id, step_no) DO NOTHING`,
      )
      .run({
        parent_step_no: null,
        attempt: 1,
        input_ref: null,
        error: null,
        idempotency_key: null,
        started_at: null,
        ended_at: null,
        ...s,
        output: enc(s.output),
      });
    const step = (await this.getStep(s.run_id, s.step_no)) as StepRow;
    if (info.changes === 1) return { status: "inserted", step };
    if (step.kind !== s.kind || step.name !== s.name) {
      throw new JournalDivergenceError(
        `run ${s.run_id} step ${s.step_no}: journal has ${step.kind} "${step.name}", replay ` +
          `asked for ${s.kind} "${s.name}"; recovery replays only an identical step sequence`,
      );
    }
    return { status: "exists", step };
  }

  /** Finish a step and enqueue its warehouse rows in one transaction. A step that is already
   *  `completed` keeps its stored output and enqueues nothing (safe to repeat on replay). */
  async completeStep(
    runId: string,
    stepNo: number,
    patch: Pick<StepRow, "status"> & Partial<Pick<StepRow, "output" | "error" | "ended_at">>,
    outbox: readonly OutboxEntry[] = [],
  ): Promise<void> {
    this.db.transaction(() => {
      const cur = this.db
        .prepare("SELECT status FROM steps WHERE run_id = ? AND step_no = ?")
        .get(runId, stepNo) as { status: string } | undefined;
      if (!cur) throw new Error(`completeStep: no step ${runId}#${stepNo} (putStep first)`);
      if (cur.status === "completed") return;
      this.db
        .prepare(
          `UPDATE steps SET status = @status,
             output = COALESCE(@output, output), error = COALESCE(@error, error),
             ended_at = COALESCE(@ended_at, ended_at)
           WHERE run_id = @run_id AND step_no = @step_no`,
        )
        .run({
          status: patch.status,
          output: enc(patch.output),
          error: patch.error ?? null,
          ended_at: patch.ended_at ?? null,
          run_id: runId,
          step_no: stepNo,
        });
      this.insertOutbox(outbox);
    })();
  }

  // -- tool calls ------------------------------------------------------------------------------

  /** Write the tool call's `started` row before calling the tool (03 §2.3 item 3). The row is
   *  `in_doubt` until `updateToolCall` records the result, so a crash mid-call leaves a visible
   *  in-doubt row for an operator. `idempotency_key` defaults to hash(run_id, step_no). */
  async putToolCall(t: ToolCallRow): Promise<"inserted" | "exists"> {
    const info = this.db
      .prepare(
        `INSERT INTO tool_calls (run_id, step_no, tool, tool_schema_hash, args_canonical,
           args_hash, effect_class, idempotency_key, in_doubt, result_ref)
         VALUES (@run_id, @step_no, @tool, @tool_schema_hash, @args_canonical, @args_hash,
           @effect_class, @idempotency_key, @in_doubt, @result_ref)
         ON CONFLICT (run_id, step_no) DO NOTHING`,
      )
      .run({
        tool_schema_hash: null,
        effect_class: null,
        result_ref: null,
        ...t,
        idempotency_key: t.idempotency_key ?? toolIdempotencyKey(t.run_id, t.step_no),
        in_doubt: t.in_doubt === false ? 0 : 1,
      });
    if (info.changes === 1) return "inserted";
    const cur = (await this.getToolCall(t.run_id, t.step_no)) as ToolCallRow;
    if (cur.tool !== t.tool || cur.args_hash !== t.args_hash) {
      throw new JournalDivergenceError(
        `run ${t.run_id} step ${t.step_no}: tool call ${cur.tool}(${cur.args_hash}) recorded, ` +
          `replay asked for ${t.tool}(${t.args_hash})`,
      );
    }
    return "exists";
  }

  async getToolCall(runId: string, stepNo: number): Promise<ToolCallRow | null> {
    const r = this.db
      .prepare("SELECT * FROM tool_calls WHERE run_id = ? AND step_no = ?")
      .get(runId, stepNo) as Raw | undefined;
    return r ? toTool(r) : null;
  }

  /** Tool calls started but never confirmed: the operator's queue after a crash. */
  async listInDoubtToolCalls(runId?: string): Promise<ToolCallRow[]> {
    const rows = (
      runId === undefined
        ? this.db
            .prepare("SELECT * FROM tool_calls WHERE in_doubt = 1 ORDER BY run_id, step_no")
            .all()
        : this.db
            .prepare(
              "SELECT * FROM tool_calls WHERE in_doubt = 1 AND run_id = ? ORDER BY step_no",
            )
            .all(runId)
    ) as Raw[];
    return rows.map(toTool);
  }

  async updateToolCall(
    runId: string,
    stepNo: number,
    patch: Partial<Pick<ToolCallRow, "in_doubt" | "result_ref">>,
  ): Promise<void> {
    const sets: string[] = [];
    const p: Raw = { run_id: runId, step_no: stepNo };
    if (patch.in_doubt !== undefined) {
      sets.push("in_doubt = @in_doubt");
      p.in_doubt = patch.in_doubt ? 1 : 0;
    }
    if (patch.result_ref !== undefined) {
      sets.push("result_ref = @result_ref");
      p.result_ref = patch.result_ref;
    }
    if (sets.length === 0) return;
    const info = this.db
      .prepare(
        `UPDATE tool_calls SET ${sets.join(", ")} WHERE run_id = @run_id AND step_no = @step_no`,
      )
      .run(p);
    if (info.changes !== 1) throw new Error(`updateToolCall: no tool call ${runId}#${stepNo}`);
  }

  // -- HITL ------------------------------------------------------------------------------------

  /** Enqueue a human task. Re-enqueueing the same id (a replay) is a no-op. */
  async enqueueHuman(t: HitlRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO hitl_queue (id, kind, run_id, step_no, decision_point_id, question_ref, card,
           tiers, reason_code, priority, deadline, default_on_timeout, claimed_by, claimed_until,
           resolved_at, resolution, resolver, notes, created_at)
         VALUES (@id, @kind, @run_id, @step_no, @decision_point_id, @question_ref, @card, @tiers,
           @reason_code, @priority, @deadline, @default_on_timeout, @claimed_by, @claimed_until,
           @resolved_at, @resolution, @resolver, @notes, @created_at)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run({
        run_id: null,
        step_no: null,
        decision_point_id: null,
        question_ref: null,
        reason_code: null,
        priority: 0,
        deadline: null,
        claimed_by: null,
        claimed_until: null,
        resolved_at: null,
        resolver: null,
        notes: null,
        ...t,
        card: enc(t.card),
        tiers: enc(t.tiers),
        default_on_timeout: enc(t.default_on_timeout),
        resolution: enc(t.resolution),
      });
  }

  /** Tasks by priority (high first), then deadline, then age. */
  async listHuman(
    filter: { kind?: HitlRow["kind"]; unresolvedOnly?: boolean } = {},
  ): Promise<HitlRow[]> {
    const where: string[] = [];
    const p: Raw = {};
    if (filter.kind) {
      where.push("kind = @kind");
      p.kind = filter.kind;
    }
    if (filter.unresolvedOnly) where.push("resolved_at IS NULL");
    const rows = this.db
      .prepare(
        `SELECT * FROM hitl_queue ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY priority DESC, deadline IS NULL, deadline, created_at, id`,
      )
      .all(p) as Raw[];
    return rows.map(toHitl);
  }

  async getHuman(id: string): Promise<HitlRow | null> {
    const r = this.db.prepare("SELECT * FROM hitl_queue WHERE id = ?").get(id) as
      | Raw
      | undefined;
    return r ? toHitl(r) : null;
  }

  /** Claim an open task for `ttlMs`. False if resolved or claimed by someone else and live. */
  async claimHuman(id: string, claimer: string, ttlMs: number): Promise<boolean> {
    const now = this.now();
    const info = this.db
      .prepare(
        `UPDATE hitl_queue SET claimed_by = ?, claimed_until = ?
         WHERE id = ? AND resolved_at IS NULL
           AND (claimed_by IS NULL OR claimed_until IS NULL OR claimed_until < ? OR claimed_by = ?)`,
      )
      .run(claimer, now + ttlMs, id, now, claimer);
    return info.changes === 1;
  }

  /** One transaction (07 §4.2, 03 §3.5): resolve the task, write the human step's output,
   *  enqueue the label (outbox → labels) and move a `suspended` run back to `pending` with its
   *  lease cleared. Any failure (e.g. a label whose source names Jev) rolls all of it back. */
  async resolveHuman(
    id: string,
    res: { resolution: Json; resolver: string; notes?: string; at: number },
    label: LabelRow | null,
  ): Promise<void> {
    this.db.transaction(() => {
      const task = this.db
        .prepare("SELECT run_id, step_no, resolved_at FROM hitl_queue WHERE id = ?")
        .get(id) as {
        run_id: string | null;
        step_no: number | null;
        resolved_at: number | null;
      };
      if (!task) throw new Error(`resolveHuman: no task ${id}`);
      if (task.resolved_at !== null)
        throw new Error(`resolveHuman: task ${id} already resolved`);
      this.db
        .prepare(
          `UPDATE hitl_queue SET resolved_at = ?, resolution = ?, resolver = ?, notes = ?
           WHERE id = ?`,
        )
        .run(res.at, enc(res.resolution), res.resolver, res.notes ?? null, id);
      if (task.run_id !== null && task.step_no !== null) {
        const info = this.db
          .prepare(
            `UPDATE steps SET status = 'completed', output = ?, ended_at = ?
             WHERE run_id = ? AND step_no = ?`,
          )
          .run(enc(res.resolution), res.at, task.run_id, task.step_no);
        if (info.changes !== 1) {
          throw new Error(
            `resolveHuman: task ${id} names step ${task.run_id}#${task.step_no}, absent`,
          );
        }
        this.db
          .prepare(
            `UPDATE runs SET status = 'pending', executor_id = NULL, lease_until = NULL
             WHERE run_id = ? AND status IN ('suspended', 'waiting')`,
          )
          .run(task.run_id);
      }
      if (label)
        this.insertOutbox([{ target_table: "labels", row: label as unknown as JsonObject }]);
    })();
  }

  // -- outbox ----------------------------------------------------------------------------------

  async enqueueOutbox(entries: readonly OutboxEntry[]): Promise<number[]> {
    return this.db.transaction(() => this.insertOutbox(entries))();
  }

  async pendingOutbox(limit: number): Promise<OutboxRow[]> {
    const rows = this.db
      .prepare("SELECT * FROM outbox WHERE exported_at IS NULL ORDER BY seq LIMIT ?")
      .all(limit) as Raw[];
    return rows.map(toOutbox);
  }

  async markExported(seqs: readonly number[], at: number): Promise<void> {
    if (seqs.length === 0) return;
    this.db
      .prepare(
        `UPDATE outbox SET exported_at = ?
         WHERE exported_at IS NULL AND seq IN (SELECT value FROM json_each(?))`,
      )
      .run(at, JSON.stringify(seqs));
  }

  async close(): Promise<void> {
    if (this.db.open) this.db.close();
  }

  /** Must run inside a transaction. Assigns uuid primary keys the warehouse would default. */
  private insertOutbox(entries: readonly OutboxEntry[]): number[] {
    const ins = this.db.prepare(
      "INSERT INTO outbox (target_table, row, created_at) VALUES (?, ?, ?)",
    );
    const now = this.now();
    return entries.map((e) => {
      const key = UUID_KEYED[e.target_table];
      const row = key && e.row[key] == null ? { ...e.row, [key]: randomUUID() } : e.row;
      return Number(ins.run(e.target_table, JSON.stringify(row), now).lastInsertRowid);
    });
  }
}

/** Open (creating and migrating) a SQLite journal in WAL mode with synchronous=NORMAL.
 *  `readonly` gives a reader connection (e.g. the HITL server or a report): WAL lets it read
 *  while the kernel holds a write transaction. */
export function openSqliteJournal(
  path: string,
  opts: SqliteJournalOptions = {},
): SqliteJournal {
  const db = openJournal(path, { readonly: opts.readonly ?? false });
  return new SqliteJournal(db, opts.now ? { now: opts.now } : {});
}

/** The `JournalOpener` core expects. */
export const openJournalStore: JournalOpener = async (path) => openSqliteJournal(path);
