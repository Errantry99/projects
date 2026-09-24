import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { JudgmentRow } from "@dcx/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DuckWarehouse,
  openDuckWarehouse,
  openWarehousePaths,
  WarehouseLockedError,
} from "../src/index.js";
import { tempDir } from "./helpers.js";

const tmp = tempDir("dcx-wh-");
afterAll(() => tmp.rm());

const H = (i: number) => i.toString(16).padStart(64, "0");
const judgment = (i: number): JudgmentRow => ({
  payload_hash: H(i),
  question_hash: H(1),
  candidate_set_hash: "",
  backend: "fixture",
  model_v: "fixture-1",
  pack_mode: "single",
  sample_no: 0,
  question_id: "screen.crit_1",
  question_v: 1,
  qtype: "choice",
  answer: "include",
  p_answer: 0.9,
  probs: { include: 0.9, exclude: 0.1 },
  call_id: "00000000-0000-4000-8000-000000000001",
});

describe("warehouse over :memory:", () => {
  let wh: DuckWarehouse;
  beforeAll(async () => {
    wh = await openDuckWarehouse(":memory:");
  });
  afterAll(() => wh.close());

  it("is migrated and several :memory: opens are independent", async () => {
    const other = await openDuckWarehouse(":memory:");
    await other.run("CREATE TABLE only_here (x INTEGER)");
    const t = await wh.all<{ n: number }>(
      "SELECT count(*) AS n FROM duckdb_tables() WHERE table_name = 'only_here'",
    );
    expect(t[0]?.n).toBe(0);
    await other.close();
    const v = await wh.all<{ version: number }>("SELECT version FROM schema_migrations");
    expect(v).toEqual([{ version: 1 }]);
  });

  it("appendRows round-trips JSON, MAP, LIST, BOOLEAN and defaults", async () => {
    expect(await wh.appendRows("judgments", [judgment(1)])).toBe(1);
    const [j] = await wh.all<Record<string, unknown>>(
      "SELECT probs, p_answer, sample_no, ts FROM judgments WHERE payload_hash = $1",
      [H(1)],
    );
    expect(j?.probs).toEqual({ include: 0.9, exclude: 0.1 });
    expect(j?.sample_no).toBe(0);
    expect(typeof j?.ts).toBe("string"); // TIMESTAMPTZ default → ISO string
    await wh.appendRows("llm_calls", [
      {
        call_id: "c1",
        run_id: "r1",
        record_ids: ["a", "b"],
        slots: { title: { path: "$.title", field_hash: "h" } },
        parsed: "just a string",
        is_jev_output: true,
        seed: 42n,
      },
    ]);
    const [c] = await wh.all<Record<string, unknown>>(
      "SELECT record_ids, slots, parsed, is_jev_output, seed, source FROM llm_calls",
    );
    expect(c).toEqual({
      record_ids: ["a", "b"],
      slots: { title: { path: "$.title", field_hash: "h" } },
      parsed: "just a string",
      is_jev_output: true,
      seed: 42,
      source: "kernel",
    });
  });

  it("onConflict: ignore skips existing keys; error rejects them", async () => {
    await expect(wh.appendRows("judgments", [judgment(1)])).rejects.toThrow(/[Cc]onstraint/);
    expect(
      await wh.appendRows("judgments", [judgment(1), judgment(2)], { onConflict: "ignore" }),
    ).toBe(1);
    await expect(wh.appendRows("judgments", [{ nope: 1 }])).rejects.toThrow(/no column nope/);
  });

  it("the labels CHECK rejects a Jev source (H5)", async () => {
    const base = { record_id: "r", target_kind: "question", target_ref: "q", label: "x" };
    await expect(wh.appendRows("labels", [{ ...base, source: "llm:jev-2" }])).rejects.toThrow(
      /CHECK/i,
    );
    expect(await wh.appendRows("labels", [{ ...base, source: "human" }])).toBe(1);
  });

  it("transaction commits or rolls back appends and statements together", async () => {
    await expect(
      wh.transaction(async (tx) => {
        await tx.appendRows("judgments", [judgment(10)]);
        await tx.run("INSERT INTO content (ref, body) VALUES ('c:1', '{}')");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await wh.all("SELECT * FROM judgments WHERE payload_hash = $1", [H(10)])).toEqual(
      [],
    );
    expect(await wh.all("SELECT * FROM content")).toEqual([]);
    const n = await wh.transaction(async (tx) => tx.appendRows("judgments", [judgment(11)]));
    expect(n).toBe(1);
  });

  it("serialises concurrent callers on the one connection", async () => {
    const results = await Promise.all([
      wh.transaction(async (tx) => {
        await tx.appendRows("judgments", [judgment(20)]);
        await new Promise((r) => setTimeout(r, 20));
        return tx.all<{ n: number }>(
          "SELECT count(*) AS n FROM judgments WHERE payload_hash = $1",
          [H(20)],
        );
      }),
      wh.all<{ n: number }>("SELECT 1 AS n"),
    ]);
    expect(results[0][0]?.n).toBe(1);
  });

  it("binds Date and array parameters", async () => {
    const [r] = await wh.all<{ d: string; l: number }>(
      "SELECT $1::TIMESTAMPTZ AS d, len($2::VARCHAR[]) AS l",
      [new Date("2026-01-02T03:04:05.000Z"), ["a", "b", "c"]],
    );
    expect(r).toEqual({ d: "2026-01-02T03:04:05.000Z", l: 3 });
  });
});

describe("appender throughput", () => {
  it("batch-inserts 10,000 rows well under a second", async () => {
    const wh = await openDuckWarehouse(tmp.path("throughput.duckdb"));
    try {
      const rows = Array.from({ length: 10_000 }, (_, i) => judgment(100_000 + i));
      const t0 = performance.now();
      const n = await wh.appendRows("judgments", rows);
      const ms = performance.now() - t0;
      expect(n).toBe(10_000);
      expect(ms).toBeLessThan(1_000);
      const [c] = await wh.all<{ n: number }>("SELECT count(*) AS n FROM judgments");
      expect(c?.n).toBe(10_000);
      console.log(`appendRows: 10,000 judgments in ${ms.toFixed(0)} ms`);
    } finally {
      await wh.close();
    }
  });
});

describe("single opener", () => {
  it("a second open of the same file in this process throws, citing the file lock", async () => {
    const file = tmp.path("single.duckdb");
    const wh = await openDuckWarehouse(file);
    await expect(openDuckWarehouse(file)).rejects.toThrow(WarehouseLockedError);
    await expect(openDuckWarehouse(file, { readOnly: true })).rejects.toThrow(
      /Exactly one dcx process.*even read-only \(01 §2\.1/s,
    );
    expect(openWarehousePaths()).toContain(file);
    await wh.close();
    expect(openWarehousePaths()).not.toContain(file);
    const again = await openDuckWarehouse(file, { readOnly: true });
    await again.close();
  });

  it("another process cannot open the file while this process holds it", async () => {
    const file = tmp.path("xproc.duckdb");
    const wh = await openDuckWarehouse(file);
    try {
      const code = `import { DuckDBInstance } from "@duckdb/node-api";
        try { await DuckDBInstance.create(process.env.DCX_FILE, { access_mode: "READ_ONLY" });
              console.log("OPENED"); }
        catch (e) { console.log("LOCKED " + e.message); }`;
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, DCX_FILE: file },
        encoding: "utf8",
      });
      expect(r.stdout).toMatch(/^LOCKED .*lock/i);
    } finally {
      await wh.close();
    }
  });
});
