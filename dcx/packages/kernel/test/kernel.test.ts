import type { Json, LlmReq, OutboxRow, RouteSpec, TraceRow, Workflow } from "@dcx/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  fork,
  hitlId,
  Kernel,
  type KernelDeps,
  ReplayDivergence,
  replay,
  runSpans,
  SCHEMA_URL,
} from "../src/index.js";
import { counterClock, FakeJudge, FakeLlm, lcg, MODEL, qHash } from "./fakes.js";
import { exportOutbox, type Stores, tempStores } from "./stores.js";

type In = { id: string; title: string };
const Q = "screen.crit@1";
const judgeTable = (title: string) =>
  ({
    hi: { answer: "include", pCal: 0.99 },
    mid: { answer: "include", pCal: 0.8 },
    "mid-dis": { answer: "include", pCal: 0.8 },
    low: { answer: "include", pCal: 0.3 },
    drift: { answer: "include", pCal: 0.99, degraded: true },
    other: { answer: "not_stated", pCal: 0.99 },
  })[title] ?? { answer: "exclude", pCal: 0.97 };

const llmReq = (title: string): LlmReq<{ answer: "include" | "exclude" }> => ({
  template: { id: "screen", version: 1, text: "Screen this record: {{title}}" },
  slots: { title: { path: "$.untrusted_record.title", value: title } },
  model: "claude-test-1",
  recordIds: ["r"],
});

const routeSpec = (i: In, extra: Partial<RouteSpec<"include" | "exclude">> = {}) => ({
  decisionPoint: "screen.include",
  state: { title: i.title },
  question: Q,
  actions: { include: { thresholdRef: "th-inc" }, exclude: { thresholdRef: "th-exc" } },
  fallback: { llm: llmReq(i.title) },
  recordId: i.id,
  ...extra,
});

const demo: Workflow = {
  name: "demo",
  version: 1,
  async run(ctx, input) {
    const i = input as In;
    const t = ctx.now().getTime();
    const r = ctx.random();
    const rows = await ctx.sql<{ n: number }>("count", "SELECT 40 + ? AS n", [2]);
    const long = await ctx.rule<boolean>("long", "is_long@1", { title: i.title });
    const draft = await ctx.llm("draft", llmReq(i.title));
    await ctx.tool("notify", {
      tool: "email",
      args: { answer: draft.value.answer },
      idempotent: true,
    });
    const routed = await ctx.route("screen", routeSpec(i));
    return { n: rows[0]?.n ?? null, long, branch: routed.branch, reason: routed.reason, t, r };
  },
};

const router: Workflow = {
  name: "router",
  version: 1,
  async run(ctx, input) {
    const i = input as In & { human?: boolean; audit?: number; budget?: number };
    const spec = routeSpec(i, {
      ...(i.audit ? { auditRate: i.audit } : {}),
      ...(i.budget !== undefined ? { budgetUsd: i.budget } : {}),
    });
    if (i.human)
      spec.fallback = { ...spec.fallback, human: { kind: "review", card: { id: i.id } } };
    const r = await ctx.route("screen", spec);
    return r as unknown as Json;
  },
};

const review: Workflow = {
  name: "review",
  version: 1,
  async run(ctx, input) {
    const i = input as In;
    await ctx.llm("draft", llmReq(i.title));
    const res = await ctx.human<Json>("approve", {
      kind: "review",
      card: { id: i.id },
      label: {
        recordId: i.id,
        targetKind: "route",
        targetRef: "screen.include",
        selectedBy: "reviewer",
      },
    });
    const found = await ctx.retrieve("cands", {
      query: i.title,
      spec: { k: 5, legs: ["bm25"], fuse: "rrf" },
    });
    return { res, n: found.candidates.length, h: found.candidateSetHash };
  },
};

let stores: Stores[] = [];
afterEach(async () => {
  for (const s of stores) await s.cleanup();
  stores = [];
});

async function setup(over: Partial<KernelDeps> = {}) {
  const clock = over.clock ?? counterClock();
  const s = await tempStores(clock);
  stores.push(s);
  for (const [id, action] of [
    ["th-inc", "include"],
    ["th-exc", "exclude"],
  ]) {
    await s.warehouse.run(
      `INSERT INTO thresholds (threshold_id, policy_id, question_hash, backend, model_v, calibrator_id, action, rule, floor, status)
       VALUES (?, 'p1', ?, 'fixture', ?, 'cal-1', ?, ?, 0.5, 'active')`,
      [
        id as string,
        qHash(Q),
        MODEL,
        action as string,
        JSON.stringify({ label: null, min_p: 0.95, on_error: "fail_open" }),
      ],
    );
  }
  const judge = new FakeJudge(judgeTable);
  const llm = new FakeLlm((req) =>
    String(req.slots.title?.value).endsWith("-dis") ? "exclude" : "include",
  );
  const deps: KernelDeps = {
    journal: s.journal,
    warehouse: s.warehouse,
    workflows: [demo, router, review],
    judge,
    llm,
    rules: [
      { ref: "is_long@1", fn: (x) => String((x as { title: string }).title).length > 3 },
      {
        ref: "compiled@1",
        decisionPoint: "screen.include",
        status: "active",
        fn: (st) =>
          String((st as { title: string }).title).startsWith("rule:") ? "exclude" : null,
      },
    ],
    tools: { email: async (_a, o) => ({ sent: true, key: o.idempotencyKey }) },
    clock,
    rng: lcg(7),
    executorId: "exec-a",
    ...over,
  };
  return { s, k: new Kernel(deps), judge, llm, deps };
}

const rowsFor = (ob: OutboxRow[], table: string, runId?: string) =>
  ob
    .filter((o) => o.target_table === table && (!runId || o.row.run_id === runId))
    .map((o) => o.row);

describe("replay determinism", () => {
  it("resume and replay of a completed run change nothing and return the same output", async () => {
    const { s, k, llm } = await setup();
    const r1 = await k.createRun(
      "demo",
      1,
      "active",
      { id: "r1", title: "mid" },
      { runId: "run-1" },
    );
    expect(r1.status).toBe("completed");
    expect(r1.output).toMatchObject({
      n: 42,
      long: false,
      branch: "include",
      reason: "abstain_band",
    });
    const steps = await s.journal.listSteps("run-1");
    expect(steps.map((x) => `${x.step_no}:${x.kind}:${x.name}`)).toEqual([
      "1:rule:dcx.now",
      "2:rule:dcx.random",
      "3:sql:count",
      "4:rule:long",
      "5:llm:draft",
      "6:tool:notify",
      "7:route:screen",
    ]);
    const ob = await s.journal.pendingOutbox(1000);
    const calls = llm.calls.length;
    const r2 = await k.resume("run-1");
    expect(r2).toEqual(r1);
    expect(await replay(k, "run-1")).toEqual(r1.output);
    expect(await s.journal.listSteps("run-1")).toEqual(steps);
    expect(await s.journal.pendingOutbox(1000)).toEqual(ob);
    expect(llm.calls.length).toBe(calls);
  });

  it("two fresh runs with the same clock, RNG and inputs write identical journals", async () => {
    const a = await setup();
    const b = await setup();
    await a.k.createRun("demo", 1, "active", { id: "r1", title: "hi" }, { runId: "same" });
    await b.k.createRun("demo", 1, "active", { id: "r1", title: "hi" }, { runId: "same" });
    expect(await a.s.journal.listSteps("same")).toEqual(await b.s.journal.listSteps("same"));
    const rows = async (x: Stores) =>
      (await x.journal.pendingOutbox(1000)).map((o) => [o.target_table, o.row]);
    expect(await rows(a.s)).toEqual(await rows(b.s));
  });

  it("a workflow that calls a different step than the journal holds diverges", async () => {
    const { s, deps } = await setup();
    await new Kernel(deps).createRun(
      "demo",
      1,
      "active",
      { id: "r1", title: "hi" },
      { runId: "d" },
    );
    const changed: Workflow = {
      ...demo,
      run: async (ctx) => (await ctx.sql("other", "SELECT 1"))[0] as Json,
    };
    const k2 = new Kernel({ ...deps, journal: s.journal, workflows: [changed] });
    await expect(replay(k2, "d")).rejects.toBeInstanceOf(ReplayDivergence);
  });
});

describe("trace contract", () => {
  it("an llm step's row gets effect and branch_taken from the next step, and fits llm_calls", async () => {
    const { s, k } = await setup();
    await k.createRun("demo", 1, "active", { id: "r1", title: "mid" }, { runId: "t1" });
    const ob = await s.journal.pendingOutbox(1000);
    const [draft, tier2] = rowsFor(ob, "llm_calls") as unknown as TraceRow[];
    expect(draft).toMatchObject({
      step_no: 5,
      workflow: "demo",
      workflow_v: 1,
      template_id: "screen",
      model_requested: "claude-test-1",
      model_returned: "claude-test-1-20260901",
      output_kind: "choice_like",
      normalised_answer: "include",
      branch_taken: "email",
      label_source: "llm:claude-test-1-20260901",
      is_jev_output: false,
      cost_basis: "token-price",
    });
    expect(draft?.effect).toMatchObject({ kind: "tool", tool: "email" });
    for (const col of [
      "template_hash",
      "rendered_hash",
      "input_hash",
      "input_projection_ref",
      "decision_point_id",
      "raw_ref",
    ] as const) {
      expect(draft?.[col]).toMatch(/^(sha256:)?[0-9a-f]{64}$/);
    }
    expect(draft?.slots?.title?.path).toBe("$.untrusted_record.title");
    expect(tier2).toMatchObject({
      step_no: 7,
      teacher_blind: true,
      branch_taken: "include",
      effect: { kind: "route", branch: "include" },
    });
    await exportOutbox(s.journal, s.warehouse);
    const got = await s.warehouse.all(
      "SELECT step_no, branch_taken, effect FROM llm_calls ORDER BY step_no",
    );
    expect(got.map((r) => [r.step_no, r.branch_taken])).toEqual([
      [5, "email"],
      [7, "include"],
    ]);
    expect(await s.warehouse.all("SELECT count(*)::INT AS n FROM trace_steps")).toEqual([
      { n: 5 },
    ]); // now()/random() are journal-only
  });

  it("an llm step before a human step, and one ending the run, are settled", async () => {
    const { s, k } = await setup();
    await k.createRun("review", 1, "active", { id: "r9", title: "mid" }, { runId: "h0" });
    const [row] = rowsFor(await s.journal.pendingOutbox(1000), "llm_calls");
    expect(row).toMatchObject({ branch_taken: "human", effect: { kind: "human" } });
    const tail: Workflow = {
      name: "tail",
      version: 1,
      run: async (ctx) => (await ctx.llm("x", llmReq("a"))).normalisedAnswer ?? null,
    };
    const k2 = new Kernel({ ...k.deps, workflows: [tail] });
    await k2.createRun("tail", 1, "active", null, { runId: "tail-1" });
    const [t] = rowsFor(await s.journal.pendingOutbox(1000), "llm_calls", "tail-1");
    expect(t).toMatchObject({
      branch_taken: "include",
      effect: { kind: "return", output: "include" },
    });
  });
});

describe("fork at step k", () => {
  it("keeps steps < k, re-executes from k and writes only downstream rows", async () => {
    const { s, k, llm } = await setup();
    await k.createRun("demo", 1, "active", { id: "r1", title: "mid" }, { runId: "src" });
    const before = llm.calls.length;
    const res = await fork(k, "src", 5, { runId: "f5" });
    expect(res.status).toBe("completed");
    expect(llm.calls.length).toBe(before + 2); // draft + tier 2 re-executed
    const src = await s.journal.listSteps("src");
    const fk = await s.journal.listSteps("f5");
    expect(fk.filter((x) => x.step_no < 5).map((x) => x.output)).toEqual(
      src.filter((x) => x.step_no < 5).map((x) => x.output),
    );
    const mine = (await s.journal.pendingOutbox(1000)).filter((o) => o.row.run_id === "f5");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((o) => Number(o.row.step_no) >= 5)).toBe(true);
    await exportOutbox(s.journal, s.warehouse); // no duplicate keys against the source run
  });

  it("an override for step k replaces its output and runs on", async () => {
    const { s, k } = await setup();
    await k.createRun("demo", 1, "active", { id: "r1", title: "hi" }, { runId: "src2" });
    const r = await fork(k, "src2", 4, { runId: "f4", override: true });
    expect(r.output).toMatchObject({ long: true });
    const mine = (await s.journal.pendingOutbox(1000)).filter((o) => o.row.run_id === "f4");
    expect(Math.min(...mine.map((o) => Number(o.row.step_no)))).toBe(5);
  });
});

describe("route step", () => {
  const cases: [string, string, string, number][] = [
    ["hi", "include", "above_threshold", 0],
    ["mid", "include", "abstain_band", 1],
    ["mid-dis", "human", "tier_disagreement", 1],
    ["low", "human", "below_floor", 0],
    ["drift", "human", "model_drift", 0],
    ["other", "human", "no_threshold", 0],
    ["err", "include", "judge_error", 1],
    ["rule:x", "exclude", "tier0_rule", 0],
  ];
  it.each(cases)("%s → %s (%s)", async (title, branch, reason, llmCalls) => {
    const { s, k, llm } = await setup();
    const r = await k.createRun(
      "router",
      1,
      "active",
      { id: `id-${title}`, title },
      { runId: `r-${title}` },
    );
    expect(r.output).toMatchObject({ branch, reason });
    expect(llm.calls.length).toBe(llmCalls);
    await exportOutbox(s.journal, s.warehouse);
    const [row] = await s.warehouse.all(
      "SELECT branch_taken, reason_code, mode, decision_point_id FROM routes",
    );
    expect(row).toMatchObject({ branch_taken: branch, reason_code: reason, mode: "active" });
  });

  it("audit sampling is hashed on the record id and forces tier 2", async () => {
    const { k, llm } = await setup();
    const { isAudited } = await import("../src/router.js");
    const hit = Array.from({ length: 500 }, (_, i) => `rec-${i}`).find((id) =>
      isAudited("screen.include", id, 0.05),
    ) as string;
    const miss = Array.from({ length: 500 }, (_, i) => `rec-${i}`).find(
      (id) => !isAudited("screen.include", id, 0.05),
    ) as string;
    const a = await k.createRun(
      "router",
      1,
      "active",
      { id: hit, title: "hi", audit: 0.05 },
      { runId: "a1" },
    );
    expect(a.output).toMatchObject({
      branch: "include",
      reason: "audit_sample",
      audited: true,
    });
    expect(llm.calls.length).toBe(1);
    const b = await k.createRun(
      "router",
      1,
      "active",
      { id: miss, title: "hi", audit: 0.05 },
      { runId: "a2" },
    );
    expect(b.output).toMatchObject({ reason: "above_threshold", audited: false });
    expect(llm.calls.length).toBe(1);
  });

  it("budget caps degrade to human, never to the LLM", async () => {
    const { k, llm } = await setup();
    const r = await k.createRun(
      "router",
      1,
      "active",
      { id: "b1", title: "mid", budget: 0 },
      { runId: "b1" },
    );
    expect(r.output).toMatchObject({ branch: "human", reason: "budget_exhausted" });
    const day = await setup({ budget: { dayUsd: 1, daySpentUsd: async () => 1.2 } });
    const d = await day.k.createRun(
      "router",
      1,
      "active",
      { id: "b2", title: "mid" },
      { runId: "b2" },
    );
    expect(d.output).toMatchObject({ branch: "human", reason: "budget_exhausted" });
    const ok = await day.k.createRun(
      "router",
      1,
      "active",
      { id: "b3", title: "hi" },
      { runId: "b3" },
    );
    expect(ok.output).toMatchObject({ branch: "include" }); // confident: no LLM needed
    expect(llm.calls.length + day.llm.calls.length).toBe(0);
  });

  it("a human fallback suspends and its resolution becomes the branch (tier 3)", async () => {
    const { s, k } = await setup();
    const w = await k.createRun(
      "router",
      1,
      "active",
      { id: "h1", title: "low", human: true },
      { runId: "rh" },
    );
    expect(w.status).toBe("waiting");
    const [task] = await s.journal.listHuman({ unresolvedOnly: true });
    expect(task).toMatchObject({ run_id: "rh", step_no: 2, reason_code: "below_floor" });
    await s.journal.resolveHuman(
      task?.id as string,
      { resolution: { answer: "exclude" }, resolver: "owner", at: 1 },
      null,
    );
    const r = await k.resume("rh");
    expect(r.output).toMatchObject({ branch: "exclude", reason: "below_floor" });
    expect((r.output as { tiers: { tier: number }[] }).tiers.at(-1)).toMatchObject({
      tier: 3,
      kind: "human",
      answer: "exclude",
    });
  });
});

describe("human, tool and retrieve steps", () => {
  it("human suspends durably (run waiting) and resume continues after resolution", async () => {
    const { s, k } = await setup();
    const w = await k.createRun(
      "review",
      1,
      "active",
      { id: "r7", title: "mid" },
      { runId: "hu" },
    );
    expect(w.status).toBe("waiting");
    expect((await s.journal.getRun("hu"))?.status).toBe("waiting");
    expect((await k.resume("hu")).status).toBe("waiting"); // still unresolved: no new task
    const tasks = await s.journal.listHuman();
    expect(tasks.map((t) => t.id)).toEqual([hitlId("hu", 2)]);
    expect(tasks[0]?.card).toMatchObject({
      view: { id: "r7" },
      label: { targetRef: "screen.include" },
    });
    await s.journal.resolveHuman(
      tasks[0]?.id as string,
      { resolution: { answer: "include" }, resolver: "owner", at: 5 },
      {
        record_id: "r7",
        target_kind: "route",
        target_ref: "screen.include",
        label: "include",
        source: "human",
        selected_by: "reviewer",
      },
    );
    const done = await k.resume("hu");
    expect(done).toMatchObject({
      status: "completed",
      output: { res: { answer: "include" }, n: 0, h: "" },
    });
    await exportOutbox(s.journal, s.warehouse);
    expect(await s.warehouse.all("SELECT source, label FROM training_labels")).toEqual([
      { source: "human", label: "include" },
    ]);
  });

  it("an interrupted non-idempotent tool is flagged in doubt; an idempotent one retries with its key", async () => {
    for (const idempotent of [false, true]) {
      const clock = counterClock();
      let t0 = 0;
      const shift = () => clock() + t0;
      let calledOnce: () => void = () => undefined;
      const called = new Promise<void>((r) => {
        calledOnce = r;
      });
      const keys: string[] = [];
      const wf: Workflow = {
        name: "t",
        version: 1,
        run: async (ctx) => ctx.tool("pay", { tool: "pay", args: { amt: 5 }, idempotent }),
      };
      const { s, deps } = await setup({ workflows: [wf], clock: shift });
      const hang = new Kernel({
        ...deps,
        tools: {
          pay: async (_a, o) => {
            keys.push(o.idempotencyKey);
            calledOnce();
            return new Promise<Json>(() => undefined);
          },
        },
      });
      void hang.createRun("t", 1, "active", null, { runId: "tool-run" });
      await called;
      t0 = 60_000; // the first executor's lease expires
      const k2 = new Kernel({
        ...deps,
        executorId: "exec-b",
        tools: {
          pay: async (_a, o) => {
            keys.push(o.idempotencyKey);
            return { ok: true };
          },
        },
      });
      const [res] = await k2.recover();
      if (idempotent) {
        expect(res).toMatchObject({ status: "completed", output: { ok: true } });
        expect(keys[0]).toBe(keys[1]);
      } else {
        expect(res?.status).toBe("failed");
        expect(keys.length).toBe(1);
      }
      const steps = await s.journal.listSteps("tool-run");
      expect(steps[0]).toMatchObject({
        kind: "tool",
        status: idempotent ? "completed" : "failed",
      });
    }
  });
});

describe("review fixes", () => {
  it("a failed step replayed on resume does not settle the earlier llm row a second time", async () => {
    let crash = true;
    const wf: Workflow = {
      name: "fail-then-go",
      version: 1,
      async run(ctx) {
        await ctx.llm("draft", llmReq("a"));
        try {
          await ctx.tool("boom", { tool: "boom", args: {}, idempotent: true });
        } catch {
          // the workflow tolerates the failed tool
        }
        if (crash) throw new Error("process died");
        return ctx.rule<boolean>("long", "is_long@1", { title: "abcd" });
      },
    };
    const { s, deps } = await setup({ workflows: [wf] });
    const k = new Kernel({
      ...deps,
      tools: {
        boom: async () => {
          throw new Error("tool down");
        },
      },
    });
    expect((await k.createRun("fail-then-go", 1, "active", null, { runId: "ff" })).status).toBe(
      "failed",
    );
    crash = false;
    expect((await k.resume("ff")).status).toBe("completed");
    const rows = rowsFor(await s.journal.pendingOutbox(1000), "llm_calls", "ff");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ effect: { kind: "tool", error: "tool down" } });
  });

  it("a policy ref resolves to the judged backend's row, not a newer row for another backend", async () => {
    const { s, deps } = await setup();
    for (const [id, backend, ago] of [
      ["pol-fixture", "fixture", "1 hour"],
      ["pol-other", "other", "1 minute"],
    ] as const) {
      await s.warehouse.run(
        `INSERT INTO thresholds (threshold_id, policy_id, question_hash, backend, model_v, calibrator_id, action, rule, status, valid_from)
         VALUES (?, 'pol', ?, ?, ?, 'cal-1', 'include', ?, 'active', current_timestamp - INTERVAL '${ago}')`,
        [id, qHash(Q), backend, MODEL, JSON.stringify({ label: null, min_p: 0.95 })],
      );
    }
    const wf: Workflow = {
      name: "pol",
      version: 1,
      run: async (ctx) =>
        (await ctx.route("screen", {
          ...routeSpec({ id: "p", title: "hi" }),
          actions: { include: { thresholdRef: "pol" }, exclude: {} },
        })) as unknown as Json,
    };
    const k = new Kernel({ ...deps, workflows: [wf] });
    const r = await k.createRun("pol", 1, "active", null, { runId: "pol-1" });
    expect(r.output).toMatchObject({ branch: "include", reason: "above_threshold" });
  });

  it("a human task resolved before the run is marked waiting still resumes the run", async () => {
    const { s, deps } = await setup();
    const j = s.journal;
    const journal = Object.create(j) as typeof j;
    // The HITL server resolves the task the moment it is enqueued (before the kernel parks).
    journal.enqueueHuman = async (t) => {
      await j.enqueueHuman(t);
      await j.resolveHuman(
        t.id,
        { resolution: { answer: "include" }, resolver: "fast", at: 1 },
        null,
      );
    };
    const k = new Kernel({ ...deps, journal });
    const r = await k.createRun(
      "review",
      1,
      "active",
      { id: "r8", title: "mid" },
      { runId: "race" },
    );
    expect(r).toMatchObject({ status: "completed", output: { res: { answer: "include" } } });
    expect((await j.getRun("race"))?.status).toBe("completed");
  });
});

describe("otel mapping", () => {
  it("maps steps to spans with the pinned semconv, custom kinds and no content", async () => {
    const { s, k } = await setup();
    await k.createRun(
      "demo",
      1,
      "active",
      { id: "r1", title: "secret-title" },
      { runId: "o1" },
    );
    const judged: Workflow = {
      name: "j",
      version: 1,
      run: async (ctx) =>
        (await ctx.judge("ask", { state: { title: "hi" }, questions: [Q] }))[0]?.answer ?? null,
    };
    await new Kernel({ ...k.deps, workflows: [judged] }).createRun("j", 1, "active", null, {
      runId: "o2",
    });
    const run = await s.journal.getRun("o1");
    const spans = run ? runSpans(run, await s.journal.listSteps("o1")) : [];
    expect(spans[0]).toMatchObject({
      name: "invoke_workflow demo",
      parentSpanId: null,
      schemaUrl: SCHEMA_URL,
    });
    expect(SCHEMA_URL).toContain("1.42.0");
    const byName = Object.fromEntries(spans.map((x) => [x.name, x]));
    expect(byName["chat claude-test-1"]?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "fake",
      "openinference.span.kind": "LLM",
    });
    expect(byName["route screen"]?.attributes).toMatchObject({
      "dcx.span.kind": "dcx.route",
      "dcx.branch": "exclude",
    });
    expect(byName["execute_tool notify"]?.attributes["gen_ai.tool.call.id"]).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(spans.some((x) => x.name.includes("dcx.now"))).toBe(false);
    expect(JSON.stringify(spans)).not.toContain("secret-title");
    const run2 = await s.journal.getRun("o2");
    const js = run2 ? runSpans(run2, await s.journal.listSteps("o2")) : [];
    expect(js[1]).toMatchObject({
      name: "classify fixture",
      attributes: { "dcx.span.kind": "dcx.classify" },
    });
    expect(js[1]?.events[0]).toMatchObject({
      name: "gen_ai.evaluation.result",
      attributes: { "gen_ai.evaluation.score.label": "include" },
    });
    await exportOutbox(s.journal, s.warehouse);
    expect(
      await s.warehouse.all(
        "SELECT run_id, mode, cache_hit FROM judge_uses WHERE run_id = 'o2'",
      ),
    ).toEqual([{ run_id: "o2", mode: "active", cache_hit: false }]);
  });
});
