// The week-1 exit test (07 §4.8, §5): the hello-world sequence runs end to end in a temp
// directory on the fixture backend, with no network and no key.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDuckWarehouse } from "@dcx/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DCX_ROOT, runCli } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "dcx-hello-"));
const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" }; // no TYPESAFE_API_KEY
const logs: Record<string, string> = {};

async function dcx(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    cwd: dir,
    env,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function step(name: string, ...argv: string[]): Promise<string> {
  const r = await dcx(...argv);
  logs[name] = r.out;
  if (r.code !== 0)
    throw new Error(`dcx ${argv.join(" ")} exited ${r.code}:\n${r.out}\n${r.err}`);
  return r.out;
}

const questionFiles = [
  "on_topic",
  "crit_1",
  "crit_2",
  "crit_3",
  "crit_4",
  "study_type",
  "injection",
].map((q) => join(DCX_ROOT, "projects/evidence-screener/questions", `${q}.json`));

beforeAll(async () => {
  await step("init", "init", dir);
  await step(
    "import",
    "import",
    "synergy",
    "--review",
    "synthetic_exercise_depression",
    "--sample",
    "300",
    "--seed",
    "7",
  );
  await step("questions", "questions", "add", ...questionFiles);
  await step("baseline", "run", "screen-baseline@1", "--model", "frontier-llm@2026-09-01");
  await step("judge1", "judge", "--backend", "fixture", "--pin", "jev-1.13.0");
  await step("judge2", "judge", "--backend", "fixture", "--pin", "jev-1.13.0");
  await step("fit", "fit", "screen", "--split", "tune");
  await step("compiled", "run", "screen-compiled@1", "--split", "holdout");
  await step("report", "report", "h4", "--html", "out/report.html");
}, 180_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("hello world (07 §4.8)", () => {
  it("imports 300 synthetic records and registers the seven lint-clean questions", () => {
    expect(logs.import).toMatch(/imported 300 records .*30 inclusions.*SYNTHETIC DATA/);
    expect(logs.questions).toMatch(/registered 7 new of 7 questions/);
    expect(logs.baseline).toMatch(/300 runs · completed 300/);
  });

  it("the first judge pass asks every payload once; the second makes zero requests", () => {
    expect(logs.judge1).toMatch(/^300 requests: 0\/300 payloads cached/);
    expect(logs.judge2).toMatch(/^0 requests: 300\/300 payloads cached/);
  });

  it("prints the H4 table with numeric coverage and saving, headed SYNTHETIC DATA", () => {
    const r = logs.report ?? "";
    expect(r).toMatch(/^H4 report · synergy\/synthetic_exercise_depression · holdout n=120/);
    expect(r.split("\n")[0]).toContain("SYNTHETIC DATA");
    for (const row of ["recall", "coverage w/o LLM", "LLM calls", "judge requests", "total"]) {
      expect(r).toMatch(new RegExp(`^${row}\\s`, "m"));
    }
    const cov = /^coverage w\/o LLM\s+(\d+)%\s+(\d+)%/m.exec(r);
    expect(cov).not.toBeNull();
    expect(Number(cov?.[1])).toBe(0);
    expect(Number(cov?.[2])).toBeGreaterThan(50);
    const saving = /saving (-?\d+)%/.exec(r);
    expect(saving).not.toBeNull();
    expect(Number.isFinite(Number(saving?.[1]))).toBe(true);
    expect(r).toMatch(/120 \(first run\) · 0 \(re-run\)/);
    const html = join(dir, "out/report.html");
    expect(existsSync(html)).toBe(true);
    expect(readFileSync(html, "utf8")).toContain("SYNTHETIC DATA");
  });

  it("logs the pin on every judge call and keeps Jev out of training labels (H5)", async () => {
    const wh = await openDuckWarehouse(join(dir, "dcx.duckdb"));
    try {
      const calls = await wh.all<{ model_v: string; model_req: string; n: number }>(
        "SELECT model_v, model_req, count(*)::INTEGER AS n FROM judge_calls GROUP BY ALL",
      );
      expect(calls).toEqual([{ model_v: "jev-1.13.0", model_req: "jev-1.13.0", n: 300 }]);
      const [tl] = await wh.all<{ n: number; jev: number }>(
        `SELECT count(*)::INTEGER AS n,
                count(*) FILTER (WHERE source ILIKE '%jev%' OR source ILIKE '%typesafe%'
                                 OR selected_by = 'jev_disagreement')::INTEGER AS jev
         FROM training_labels`,
      );
      expect(tl?.n).toBeGreaterThan(0);
      expect(tl?.jev).toBe(0);
      const [uses] = await wh.all<{ n: number; hits: number; norec: number }>(
        `SELECT count(*)::INTEGER AS n, count(*) FILTER (WHERE cache_hit)::INTEGER AS hits,
                count(*) FILTER (WHERE record_id IS NULL)::INTEGER AS norec FROM judge_uses`,
      );
      expect(uses?.n).toBeGreaterThan(0);
      expect(uses?.hits).toBe(uses?.n); // the compiled run re-used the cache
      expect(uses?.norec).toBe(0);
    } finally {
      await wh.close();
    }
  });

  it("refuses the unpinned alias, and Jev without a key, before anything is sent", async () => {
    const latest = await dcx("judge", "--backend", "jev", "--pin", "jev-latest"); // policy: rejects-alias
    expect(latest.code).toBe(1);
    expect(latest.err).toMatch(/refusing unpinned model "jev-latest"/);
    const nokey = await dcx("judge", "--backend", "jev", "--pin", "jev-1.13.0");
    expect(nokey.code).toBe(1);
    expect(nokey.err).toMatch(/needs an API key: set TYPESAFE_API_KEY/);
  });

  it("replays a journaled run to the identical output", async () => {
    const wh = await openDuckWarehouse(join(dir, "dcx.duckdb"));
    const [row] = await wh.all<{ run_id: string; normalised_answer: string }>(
      "SELECT run_id, normalised_answer FROM llm_calls WHERE workflow = 'screen-baseline' ORDER BY run_id LIMIT 1",
    );
    await wh.close();
    const r = await dcx("replay", String(row?.run_id));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/identical output, nothing written/);
    expect(r.out).toContain(`"decision":"${row?.normalised_answer}"`);
  });

  it("reports the ledger and lints clean", async () => {
    const ledger = await dcx("report", "ledger");
    expect(ledger.code).toBe(0);
    expect(ledger.out).toMatch(/^total\s+120\s/m);
    const lint = await dcx("lint");
    expect(lint.code).toBe(0);
    expect(lint.out).toMatch(/7 questions, 0 issue\(s\)/);
  });
});
