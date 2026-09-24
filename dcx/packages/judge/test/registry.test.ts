import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fieldsKey, questionHash } from "@dcx/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  diff,
  loadQuestionFiles,
  parseQuestion,
  parseRef,
  Registry,
  readQuestions,
  toQuestionRow,
  writeQuestions,
} from "../src/registry.js";
import { crit1, QUESTIONS } from "./helpers/fakes.js";
import { memoryWarehouse } from "./helpers/warehouse.js";

const dir = mkdtempSync(join(tmpdir(), "dcx-judge-reg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("registry", () => {
  it("loads JSON files (object or array, snake_case accepted) and computes the core hash", () => {
    const { questionHash: _h, ...raw } = crit1;
    writeFileSync(join(dir, "a.json"), JSON.stringify(raw));
    writeFileSync(
      join(dir, "b.json"),
      JSON.stringify([
        {
          id: "x.flag",
          version: 1,
          qtype: "noul",
          instructions: "Is `a.b` set?",
          fields: ["a.b"],
          max_state_tokens: 100,
        },
      ]),
    );
    const defs = loadQuestionFiles(dir);
    expect(defs).toHaveLength(2);
    expect(defs[0]?.questionHash).toBe(questionHash(crit1));
    expect(defs[1]?.maxStateTokens).toBe(100);
    expect(defs[1]?.status).toBe("proposed");
    expect(() => parseQuestion({ ...raw, questionHash: "f".repeat(64) })).toThrow(
      /stated questionHash/,
    );
  });

  it("versions: identical re-add is a no-op, same version with new content fails, lineage is set", () => {
    const reg = new Registry([crit1]);
    expect(reg.add(crit1)).toBe(reg.get("screen.crit_1@1"));
    const edited = parseQuestion({
      ...crit1,
      questionHash: undefined,
      instructions: `${crit1.instructions} Answer literally.`,
    });
    expect(() => reg.add(edited)).toThrow(/bump the version/);
    const v2 = reg.add({ ...edited, version: 2 });
    expect(v2.parentHash).toBe(crit1.questionHash);
    expect(reg.latest("screen.crit_1")?.version).toBe(2);
    expect(() => reg.add({ ...crit1, version: 1, questionHash: "0".repeat(64) })).toThrow();
    expect(parseRef("screen.crit_1@2")).toEqual({ id: "screen.crit_1", version: 2 });
  });

  it("produces questions rows and round-trips them through the warehouse", async () => {
    const row = toQuestionRow(crit1);
    expect(row.fields_key).toBe(fieldsKey(crit1.fields));
    expect(row.question_hash).toBe(crit1.questionHash);
    const wh = await memoryWarehouse();
    expect(await writeQuestions(wh, QUESTIONS)).toBe(3);
    expect(await writeQuestions(wh, QUESTIONS)).toBe(0);
    const back = await readQuestions(wh, ["active"]);
    expect(back.map((d) => d.questionHash).sort()).toEqual(
      QUESTIONS.map((d) => d.questionHash).sort(),
    );
    const changed = parseQuestion({
      ...crit1,
      questionHash: undefined,
      instructions: "Changed wording for `a`?",
    });
    await expect(writeQuestions(wh, [changed])).rejects.toThrow(/bump the version/);
    await wh.close();
  });

  it("diffs two versions", () => {
    const v2 = parseQuestion({
      ...crit1,
      questionHash: undefined,
      version: 2,
      labelCompatible: true,
      options: [crit1.options[1], crit1.options[0], ...crit1.options.slice(2)],
    });
    const d = diff(crit1, v2);
    expect(d.hashChanged).toBe(true);
    expect(d.optionsReordered).toBe(true);
    expect(d.labelSetChanged).toBe(false);
    expect(d.labelsSurvive).toBe(true);
    const v3 = parseQuestion({
      ...v2,
      questionHash: undefined,
      version: 3,
      options: v2.options.slice(0, 3),
    });
    const d3 = diff(v2, v3);
    expect(d3.optionsRemoved).toEqual(["other"]);
    expect(d3.labelsSurvive).toBe(false);
    expect(diff(crit1, { ...crit1, status: "demoted" }).hashChanged).toBe(false);
  });
});
