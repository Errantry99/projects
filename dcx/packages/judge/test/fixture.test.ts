import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AskOpts, cacheKeyId, jsonHash, type QuestionDef } from "@dcx/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureBackend, fixtureKey } from "../src/backends/fixture.js";
import { FixtureMissError } from "../src/errors.js";
import { parseQuestion } from "../src/registry.js";
import { crit1, oracleBackend } from "./helpers/fakes.js";

const dir = mkdtempSync(join(tmpdir(), "dcx-judge-fx-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const STATE = {
  untrusted_record: { title: "Statins in adults", abstract: "An RCT in adults." },
};
const CS = jsonHash("candidates");
const BASE: AskOpts = {
  timeoutMs: 1000,
  maxRetries: 0,
  model: "jev-1.13.0",
  candidateSetHashes: { [crit1.questionHash]: CS },
  packMode: "single",
  sampleNo: 0,
};

describe("fixture backend", () => {
  beforeAll(async () => {
    const rec = fixtureBackend({ dir, mode: "record", inner: oracleBackend() });
    await rec.ask(STATE, [crit1], BASE);
  });

  it("records one file per full cache key and replays it", async () => {
    const files = readdirSync(dir);
    const key = fixtureKey("fixture", STATE, crit1, "jev-1.13.0", BASE);
    expect(files).toEqual([`${cacheKeyId(key)}.json`]);
    const be = fixtureBackend({ dir });
    expect(be.entries()).toBe(1);
    const raw = await be.ask(STATE, [crit1], BASE);
    expect(raw.answers[0]?.questionHash).toBe(crit1.questionHash);
    expect(raw.modelVersion).toBe("jev-1.13.0");
    expect(raw.degraded).toBe(false);
  });

  it("misses loudly, naming the key", async () => {
    const be = fixtureBackend({ dir });
    const err = await be.ask({ other: 1 }, [crit1], BASE).catch((e) => e);
    expect(err).toBeInstanceOf(FixtureMissError);
    expect(err.message).toContain(err.keyId);
    expect(err.key.question_hash).toBe(crit1.questionHash);
  });

  // Cache-key completeness: changing any ONE of the seven components misses.
  const reworded: QuestionDef = parseQuestion({
    ...crit1,
    questionHash: undefined,
    instructions: `${crit1.instructions} `,
  });
  const variants: Array<
    [string, { state?: unknown; q?: QuestionDef; name?: string; opts?: Partial<AskOpts> }]
  > = [
    [
      "payload_hash",
      {
        state: {
          untrusted_record: { ...STATE.untrusted_record, abstract: "An RCT in adults!" },
        },
      },
    ],
    ["question_hash", { q: reworded }],
    [
      "candidate_set_hash",
      { opts: { candidateSetHashes: { [crit1.questionHash]: jsonHash("other") } } },
    ],
    ["backend", { name: "fixture-b" }],
    ["model_v", { opts: { model: "jev-1.13.1" } }],
    ["pack_mode", { opts: { packMode: "pack:8" } }],
    ["sample_no", { opts: { sampleNo: 1 } }],
  ];
  it.each(variants)("changing %s misses the cache", async (_col, v) => {
    const be = fixtureBackend({ dir, name: v.name ?? "fixture" });
    const q = v.q ?? crit1;
    const opts = {
      ...BASE,
      ...v.opts,
      candidateSetHashes: { [q.questionHash]: CS, ...v.opts?.candidateSetHashes },
    };
    await expect(be.ask((v.state ?? STATE) as never, [q], opts)).rejects.toBeInstanceOf(
      FixtureMissError,
    );
  });

  it("does not miss on fields outside the projection", async () => {
    const be = fixtureBackend({ dir });
    const raw = await be.ask({ ...STATE, unrelated: { x: 1 } }, [crit1], BASE);
    expect(raw.answers).toHaveLength(1);
  });
});
