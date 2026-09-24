import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  importTraceJsonl,
  JsonlImportError,
  parseTraceJsonl,
  traceClass,
} from "../src/index.js";
import { testWarehouse } from "./helpers.js";

const H = "a".repeat(64);
const line = (o: object) => JSON.stringify(o);
const GOOD = [
  line({
    call_id: "c1",
    run_id: "run-1",
    step_no: 2,
    ts: "2026-09-24T01:00:00.000Z",
    workflow: "screen-baseline",
    workflow_v: 1,
    record_ids: ["rec-1"],
    template_id: "screen.baseline",
    template_v: 1,
    input_hash: H,
    model_requested: "frontier-llm@2026-09-01",
    model_returned: "frontier-llm@2026-09-01",
    output_kind: "structured",
    parsed: { answer: "include" },
    normalised_answer: "include",
    effect: { decision: "include" },
    branch_taken: "include",
    input_tokens: 1500,
    output_tokens: 20,
    cost_usd: 0.0032,
    cost_basis: "token-price",
    latency_ms: 2500,
    retries: 0,
  }),
  "",
  line({ call_id: "c2", run_id: "run-1", template_id: "screen.baseline", parsed: "free text" }),
  line({ call_id: "c3", run_id: "run-2", source: "import:langsmith", effect: null }),
].join("\n");

describe("parseTraceJsonl", () => {
  it("fills what the source carries and classes rows without effect as open", () => {
    const imp = parseTraceJsonl(GOOD);
    expect(imp.stats).toEqual({ rows: 3, open: 2, effect: 1, runs: 2 });
    const [a, b, c] = imp.llm_calls;
    expect(a?.source).toBe("import:jsonl");
    expect(b?.step_no).toBe(3); // assigned after the run's highest explicit step
    expect(c?.step_no).toBe(0);
    expect(c?.source).toBe("import:langsmith");
    expect(traceClass(a ?? { effect: null })).toBe("effect");
    const s = imp.trace_steps;
    expect(s.map((x) => [x.run_id, x.step_no, x.kind, x.activity])).toEqual([
      ["run-1", 2, "llm", "llm:screen.baseline"],
      ["run-1", 3, "llm", "llm:screen.baseline"],
      ["run-2", 0, "llm", "llm:unknown"],
    ]);
    expect(s[0]?.record_id).toBe("rec-1");
    expect(s[0]?.started_at).toBe(Date.parse("2026-09-24T01:00:00.000Z") - 2500);
    expect((s[1]?.output as { class?: string } | undefined)?.class).toBe("open");
    expect("ts" in (b ?? {})).toBe(false); // absent stays absent (DDL default applies)
  });

  it("reports every problem with its line number", () => {
    const bad = [
      "{not json",
      line({ call_id: "c1", run_id: "r", step_no: 1 }),
      line({ call_id: "c1", run_id: "r2", cost_basis: "guess" }),
      line({ call_id: "c1", run_id: "r3", surprise: true }),
      line({ run_id: "r", input_hash: "XYZ" }),
      line({ call_id: "c9", run_id: "r", step_no: 1 }),
    ].join("\n");
    let err: unknown;
    try {
      parseTraceJsonl(bad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JsonlImportError);
    const p = (err as JsonlImportError).problems.join("\n");
    expect(p).toMatch(/line 1: invalid JSON/);
    expect(p).toMatch(/line 3: cost_basis/);
    expect(p).toMatch(/line 4: .*surprise/);
    expect(p).toMatch(/line 5: call_id/);
    expect(p).toMatch(/line 5: input_hash: expected lowercase sha256 hex/);
    expect(p).not.toMatch(/line 3: duplicate/); // invalid rows are not identity-checked
    expect(p).toMatch(/line 6: duplicate \(run_id, step_no\) \(first on line 2\)/);
    expect(() =>
      parseTraceJsonl(
        `${line({ call_id: "c1", run_id: "r" })}\n${line({ call_id: "c1", run_id: "s" })}`,
      ),
    ).toThrow(/line 2: duplicate call_id \(first on line 1\)/);
  });
});

describe("importTraceJsonl against the DuckDB DDL", () => {
  let wh: Awaited<ReturnType<typeof testWarehouse>>;
  beforeAll(async () => {
    wh = await testWarehouse();
  });
  afterAll(async () => wh.close());

  it("writes llm_calls and trace_steps; re-import is a no-op", async () => {
    const imp = parseTraceJsonl(GOOD);
    expect(await importTraceJsonl(wh, imp)).toEqual({ llm_calls: 3, trace_steps: 3 });
    expect(await importTraceJsonl(wh, imp)).toEqual({ llm_calls: 0, trace_steps: 0 });
    const r = await wh.all<{ n: number }>(
      "SELECT count(*)::INT AS n FROM llm_calls c JOIN trace_steps s USING (run_id, step_no) WHERE c.effect IS NULL",
    );
    expect(r[0]?.n).toBe(2);
  });
});
