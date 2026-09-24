import { isAllowedLabelSource, openWarehouse, type WarehouseHandle } from "@dcx/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  exportedFunctionNames,
  formatViolations,
  scanH5,
  scanWorkspaceH5,
  trainingReason,
} from "../src/index.js";

describe("H5 guard: training code reads only training_labels", () => {
  it("no training code path in dcx/packages or dcx/projects reads judgments/decisions/labels", () => {
    const { scanned, trainingFiles, violations } = scanWorkspaceH5();
    expect(scanned).toBeGreaterThan(20);
    if (trainingFiles.length > 0)
      console.info(`H5 training paths: ${trainingFiles.join(", ")}`);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it("classifies training paths by directory, exported name and --training", () => {
    expect(trainingReason("packages/x/src/train/fit.ts", "")).toMatch(/train\//);
    expect(trainingReason("a.ts", "export async function trainModel() {}")).toMatch(
      /trainModel/,
    );
    expect(trainingReason("a.ts", "export const exportForTraining = () => 1;")).toMatch(
      /export/,
    );
    expect(trainingReason("a.ts", 'cmd.option("--training")')).toMatch(/--training/);
    expect(trainingReason("a.ts", "export function judge() {}")).toBeNull();
    expect(trainingReason("a.ts", "function trainLocal() {}")).toBeNull();
    expect(exportedFunctionNames("export { a, b as trainB };")).toEqual(["a", "trainB"]);
  });

  it("flags each forbidden read with file and line, and allows training_labels", () => {
    const src = [
      "export function trainIt(conn) {",
      '  conn.run("SELECT * FROM training_labels");',
      '  conn.run("SELECT * FROM judgments");',
      "  conn.run(`SELECT d.* FROM records r JOIN decisions d USING (record_id)`);",
      "  conn.run('select label from main.labels');",
      '  readTable("judge_uses");',
      "  // FROM judgments in a comment is fine",
      "}",
    ].join("\n");
    const v = scanH5("packages/x/src/fit.ts", src);
    expect(v.map((x) => x.line)).toEqual([3, 4, 5, 6]);
    expect(v[0]?.file).toBe("packages/x/src/fit.ts");
    expect(v[0]?.reason).toMatch(/judgments.*training_labels/);
    expect(scanH5("packages/x/src/other.ts", "SELECT * FROM judgments")).toEqual([]);
  });
});

describe("H5 in the DDL: labels.source CHECK and training_labels", () => {
  let wh: WarehouseHandle;
  beforeAll(async () => {
    wh = await openWarehouse(":memory:");
  });
  afterAll(() => wh?.close());

  let n = 0;
  const insert = (source: string, selectedBy: string | null = null) =>
    wh.conn.run(
      "INSERT INTO labels (record_id, target_kind, target_ref, label, source, selected_by) VALUES ($1, 'question', 'q1', 'include', $2, $3)",
      [`r${++n}`, source, selectedBy],
    );

  it.each(["jev", "llm:jev", "llm:jev-1.13.0", "JEV"])("rejects source %j", async (source) => {
    expect(isAllowedLabelSource(source)).toBe(false);
    await expect(insert(source)).rejects.toThrow(/CHECK/i);
  });

  it.each(["human", "behaviour", "llm:claude", "rule:x"])(
    "accepts source %j",
    async (source) => {
      expect(isAllowedLabelSource(source)).toBe(true);
      await insert(source);
      const r = await wh.conn.runAndReadAll(
        "SELECT count(*)::INTEGER AS n FROM labels WHERE source = $1",
        [source],
      );
      expect(r.getRowObjectsJson()).toEqual([{ n: 1 }]);
    },
  );

  it("training_labels keeps human/behaviour and drops jev_disagreement and llm rows", async () => {
    await wh.conn.run("DELETE FROM labels");
    await insert("human", "random");
    await insert("human", "jev_disagreement");
    await insert("behaviour", null);
    await insert("llm:claude", "random");
    const r = await wh.conn.runAndReadAll(
      "SELECT source, selected_by FROM training_labels ORDER BY source, selected_by",
    );
    const rows = r.getRowObjectsJson();
    expect(rows).toEqual([
      { source: "behaviour", selected_by: null },
      { source: "human", selected_by: "random" },
    ]);
    const all = await wh.conn.runAndReadAll("SELECT count(*)::INTEGER AS n FROM labels");
    expect(all.getRowObjectsJson()).toEqual([{ n: 4 }]);
  });
});
