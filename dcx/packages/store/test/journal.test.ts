import type { LabelRow } from "@dcx/core";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JournalDivergenceError,
  openSqliteJournal,
  type SqliteJournal,
  toolIdempotencyKey,
} from "../src/index.js";
import { run, step, tempDir } from "./helpers.js";

const tmp = tempDir("dcx-journal-");
afterAll(() => tmp.rm());

let clock = 10_000;
let n = 0;
let j: SqliteJournal;
let file: string;
beforeEach(() => {
  clock = 10_000;
  file = tmp.path(`j${++n}.sqlite`);
  j = openSqliteJournal(file, { now: () => clock });
});
afterEach(() => j.close());

describe("WAL and concurrent readers", () => {
  it("uses WAL with synchronous=NORMAL", () => {
    expect(j.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(j.db.pragma("synchronous", { simple: true })).toBe(1); // NORMAL
  });

  it("a second connection reads while the writer holds an open transaction", async () => {
    await j.startRun(run("r-committed"));
    const reader = openSqliteJournal(file, { readonly: true });
    try {
      j.db.prepare("BEGIN IMMEDIATE").run();
      j.db
        .prepare(
          "INSERT INTO runs (run_id, workflow, workflow_v, mode, status, created_at) VALUES (?,?,?,?,?,?)",
        )
        .run("r-uncommitted", "screen", 1, "active", "pending", 1);
      // The reader is not blocked and sees the last committed snapshot only.
      expect((await reader.getRun("r-committed"))?.status).toBe("pending");
      expect(await reader.getRun("r-uncommitted")).toBeNull();
      expect(await reader.listHuman()).toEqual([]);
      j.db.prepare("COMMIT").run();
      expect((await reader.getRun("r-uncommitted"))?.run_id).toBe("r-uncommitted");
    } finally {
      if (j.db.inTransaction) j.db.prepare("ROLLBACK").run();
      await reader.close();
    }
  });
});

describe("runs and leases", () => {
  it("startRun is insert-if-absent", async () => {
    expect(await j.startRun(run("r1"))).toBe("inserted");
    expect(await j.startRun(run("r1", { status: "failed" }))).toBe("exists");
    expect((await j.getRun("r1"))?.status).toBe("pending");
    await j.updateRun("r1", { status: "completed", ended_at: 5 });
    expect(await j.getRun("r1")).toMatchObject({ status: "completed", ended_at: 5 });
    expect(await j.getRun("nope")).toBeNull();
  });

  it("an expired lease is reclaimed; the old executor's heartbeat then fails", async () => {
    await j.startRun(run("r1"));
    await j.startRun(run("r2", { status: "suspended" }));
    await j.startRun(run("r3", { status: "completed" }));
    expect(await j.lease("A", 1_000)).toEqual(["r1"]);
    expect(await j.getRun("r1")).toMatchObject({
      executor_id: "A",
      lease_until: 11_000,
      heartbeat_at: 10_000,
    });

    clock = 10_500;
    expect(await j.lease("B", 1_000)).toEqual([]); // still held by A
    expect(await j.heartbeat("r1", "A", 1_000)).toBe(true);
    expect((await j.getRun("r1"))?.lease_until).toBe(11_500);

    clock = 12_000; // A stopped heartbeating
    expect(await j.lease("B", 1_000)).toEqual(["r1"]);
    expect((await j.getRun("r1"))?.executor_id).toBe("B");
    expect(await j.heartbeat("r1", "A", 1_000)).toBe(false);
    expect(await j.heartbeat("r1", "B", 1_000)).toBe(true);
  });
});

describe("steps: insert-if-absent (DBOS operation_outputs)", () => {
  it("a second write of the same step_no returns the stored output", async () => {
    await j.startRun(run("r1"));
    const first = await j.putStepReturning(
      step("r1", 1, { status: "completed", output: { a: 1 } }),
    );
    expect(first.status).toBe("inserted");
    const second = await j.putStepReturning(
      step("r1", 1, { status: "completed", output: { a: 999 } }),
    );
    expect(second.status).toBe("exists");
    expect(second.step.output).toEqual({ a: 1 });
    expect(await j.putStep(step("r1", 1, { output: "other" }))).toBe("exists");
    expect((await j.getStep("r1", 1))?.output).toEqual({ a: 1 });
  });

  it("detects a diverging replay", async () => {
    await j.putStep(step("r1", 1));
    await expect(j.putStep(step("r1", 1, { name: "different" }))).rejects.toThrow(
      JournalDivergenceError,
    );
    await expect(j.putStep(step("r1", 1, { kind: "llm" }))).rejects.toThrow(/replay/);
  });

  it("completeStep writes the result and its outbox rows once", async () => {
    await j.putStep(step("r1", 1));
    const outbox = [
      {
        target_table: "judge_uses" as const,
        row: { run_id: "r1", step_no: 1, question_hash: "q", payload_hash: "p" },
      },
    ];
    await j.completeStep("r1", 1, { status: "completed", output: [1, 2], ended_at: 3 }, outbox);
    await j.completeStep("r1", 1, { status: "completed", output: "again" }, outbox);
    expect(await j.getStep("r1", 1)).toMatchObject({ status: "completed", output: [1, 2] });
    expect(await j.pendingOutbox(10)).toHaveLength(1);
    await expect(j.completeStep("r1", 9, { status: "completed" })).rejects.toThrow(/putStep/);
    const steps = await j.listSteps("r1");
    expect(steps.map((s) => s.step_no)).toEqual([1]);
  });

  it("a null output round-trips as null, an absent one is omitted", async () => {
    await j.putStep(step("r1", 1, { output: null }));
    await j.putStep(step("r1", 2));
    expect((await j.getStep("r1", 1))?.output).toBeNull();
    expect(await j.getStep("r1", 2)).not.toHaveProperty("output");
  });
});

describe("tool calls", () => {
  const call = {
    run_id: "r1",
    step_no: 3,
    tool: "send_email",
    args_canonical: '{"to":"a"}',
    args_hash: "h1",
    effect_class: "write",
  };

  it("a started call is in doubt until its result is recorded", async () => {
    expect(await j.putToolCall(call)).toBe("inserted");
    const started = await j.getToolCall("r1", 3);
    expect(started).toMatchObject({
      in_doubt: true,
      idempotency_key: toolIdempotencyKey("r1", 3),
    });
    expect(await j.listInDoubtToolCalls()).toHaveLength(1);
    // Replay after a crash: the row exists and is still in doubt, so the kernel must not
    // blindly re-send a non-idempotent write.
    expect(await j.putToolCall(call)).toBe("exists");
    await j.updateToolCall("r1", 3, { in_doubt: false, result_ref: "content:abc" });
    expect(await j.getToolCall("r1", 3)).toMatchObject({
      in_doubt: false,
      result_ref: "content:abc",
    });
    expect(await j.listInDoubtToolCalls("r1")).toEqual([]);
  });

  it("rejects a replay with different args", async () => {
    await j.putToolCall(call);
    await expect(j.putToolCall({ ...call, args_hash: "h2" })).rejects.toThrow(
      JournalDivergenceError,
    );
    await expect(j.updateToolCall("r1", 99, { in_doubt: false })).rejects.toThrow(
      /no tool call/,
    );
  });
});

describe("HITL", () => {
  const label: LabelRow = {
    record_id: "rec1",
    target_kind: "question",
    target_ref: "qh1",
    label: "include",
    source: "human",
    selected_by: "reviewer",
  };

  async function suspended() {
    await j.startRun(run("r1", { status: "suspended", executor_id: "A", lease_until: 99_999 }));
    await j.putStep(step("r1", 4, { kind: "human", status: "suspended" }));
    await j.enqueueHuman({
      id: "t1",
      kind: "review",
      run_id: "r1",
      step_no: 4,
      card: { title: "x" },
      priority: 1,
      created_at: 1,
    });
  }

  it("lists by priority and claims with a lease", async () => {
    await suspended();
    await j.enqueueHuman({ id: "t0", kind: "promotion", card: {}, priority: 5, created_at: 2 });
    await j.enqueueHuman({ id: "t0", kind: "promotion", card: {}, priority: 0, created_at: 3 });
    expect((await j.listHuman()).map((t) => t.id)).toEqual(["t0", "t1"]);
    expect((await j.listHuman({ kind: "review" }))[0]?.card).toEqual({ title: "x" });
    expect(await j.claimHuman("t1", "alice", 1_000)).toBe(true);
    expect(await j.claimHuman("t1", "bob", 1_000)).toBe(false);
    clock += 2_000;
    expect(await j.claimHuman("t1", "bob", 1_000)).toBe(true);
  });

  it("resolve writes task, step output, label outbox row and resume in one transaction", async () => {
    await suspended();
    await j.resolveHuman(
      "t1",
      { resolution: { answer: "include" }, resolver: "alice", at: 50 },
      label,
    );
    const task = await j.getHuman("t1");
    expect(task).toMatchObject({
      resolved_at: 50,
      resolver: "alice",
      resolution: { answer: "include" },
    });
    expect(await j.getStep("r1", 4)).toMatchObject({
      status: "completed",
      output: { answer: "include" },
      ended_at: 50,
    });
    expect(await j.getRun("r1")).toMatchObject({
      status: "pending",
      executor_id: null,
      lease_until: null,
    });
    const [o] = await j.pendingOutbox(10);
    expect(o?.target_table).toBe("labels");
    expect(o?.row).toMatchObject({ source: "human", label: "include" });
    expect(typeof o?.row.label_id).toBe("string"); // stable id for idempotent export
    expect(await j.listHuman({ unresolvedOnly: true })).toEqual([]);
    expect(await j.lease("B", 1_000)).toEqual(["r1"]); // resumable
    await expect(
      j.resolveHuman("t1", { resolution: 1, resolver: "bob", at: 60 }, null),
    ).rejects.toThrow(/already resolved/);
  });

  it("a failing label rolls the whole resolve back (H5 outbox CHECK)", async () => {
    await suspended();
    const bad = { ...label, source: "llm:jev-1" } as unknown as LabelRow;
    await expect(
      j.resolveHuman("t1", { resolution: "include", resolver: "alice", at: 50 }, bad),
    ).rejects.toThrow(/CHECK constraint/);
    expect((await j.getHuman("t1"))?.resolved_at).toBeNull();
    expect((await j.getStep("r1", 4))?.status).toBe("suspended");
    expect((await j.getRun("r1"))?.status).toBe("suspended");
    expect(await j.pendingOutbox(10)).toEqual([]);
  });
});

describe("outbox", () => {
  it("enqueues, lists pending in seq order and marks exported", async () => {
    const seqs = await j.enqueueOutbox([
      { target_table: "routes", row: { run_id: "r", step_no: 1 } },
      { target_table: "labels", row: { ...({} as object), source: "rule:kw", label: "x" } },
      { target_table: "llm_calls", row: { call_id: "c1", run_id: "r" } },
    ]);
    expect(seqs).toHaveLength(3);
    expect((await j.pendingOutbox(2)).map((o) => o.seq)).toEqual(seqs.slice(0, 2));
    await j.markExported([seqs[0] as number, seqs[2] as number], 77);
    const pending = await j.pendingOutbox(10);
    expect(pending.map((o) => o.seq)).toEqual([seqs[1]]);
    expect(pending[0]?.row.label_id).toBeTypeOf("string");
  });

  it("the outbox refuses a label whose source names Jev", async () => {
    await expect(
      j.enqueueOutbox([{ target_table: "labels", row: { source: "jev", label: "x" } }]),
    ).rejects.toThrow(/CHECK/);
  });
});
