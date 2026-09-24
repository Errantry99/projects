// dcx init | migrate | lint | questions add|list|diff | import synergy|jsonl

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { migrateDuckdb, migrateSqlite, type QuestionDef, SCHEMA_VERSION } from "@dcx/core";
import {
  importSynergy,
  importTraceJsonl,
  parseTraceJsonl,
  readSynergyFile,
  synergyRows,
} from "@dcx/importers";
import {
  diff,
  type LintIssue,
  lintModelPins,
  lintQuestion,
  loadQuestionFiles,
  readQuestions,
  writeQuestions,
} from "@dcx/judge";
import { CONFIG_FILE, type DcxConfig, defaultConfig, writeConfig } from "../config.js";
import { CliError, Context } from "../context.js";
import { loadProject } from "../project.js";
import { table } from "../table.js";

export async function cmdInit(
  ctx: Context,
  dir: string | undefined,
  o: { project?: string; fixtures?: string; force?: boolean },
): Promise<void> {
  const target = resolve(ctx.io.cwd, dir ?? ".");
  mkdirSync(target, { recursive: true });
  const file = join(target, CONFIG_FILE);
  if (existsSync(file) && !o.force) {
    ctx.out(`${file} exists; keeping it (use --force to overwrite)`);
  } else {
    const cfg: DcxConfig = defaultConfig();
    if (o.project) cfg.project = resolve(ctx.io.cwd, o.project);
    if (o.fixtures) {
      const f = resolve(ctx.io.cwd, o.fixtures);
      cfg.fixtures = {
        judge: join(f, "judge", "synthetic_exercise_depression"),
        llm: join(f, "llm"),
        synergy: join(f, "synergy-synthetic"),
      };
    }
    writeConfig(target, cfg);
    ctx.out(`wrote ${file}`);
  }
  // Migrate both stores in the new directory (a fresh context so its config is the new one).
  const sub = new Context({ ...ctx.io, cwd: target }, target);
  try {
    await sub.warehouse();
    sub.journal();
    ctx.out(
      `journal ${sub.config.paths.journal} and warehouse ${sub.config.paths.warehouse} at schema v${SCHEMA_VERSION}`,
    );
  } finally {
    await sub.close();
  }
}

export async function cmdMigrate(ctx: Context): Promise<void> {
  const j = ctx.journal();
  const wh = await ctx.warehouse();
  const js = migrateSqlite(j.db);
  const ws = await migrateDuckdb(wh.connection);
  ctx.out(
    `journal: ${js.length ? `applied v${js.join(", v")}` : "current"} · warehouse: ${
      ws.length ? `applied v${ws.join(", v")}` : "current"
    } (schema v${SCHEMA_VERSION})`,
  );
}

function expandFiles(ctx: Context, files: readonly string[]): string[] {
  return files.map((f) => resolve(ctx.io.cwd, f));
}

function printIssues(ctx: Context, issues: readonly LintIssue[]): void {
  for (const i of issues) ctx.io.err(`  ${i.ref ?? ""} [${i.rule}] ${i.message}`);
}

/** Lint question files (default: the project's questions) and the config's model pins. */
export async function cmdLint(ctx: Context, files: string[]): Promise<number> {
  const paths = files.length
    ? expandFiles(ctx, files)
    : [(await loadProject(ctx.config.paths.project)).questionsDir];
  const qs = loadQuestionFiles(paths);
  const issues = qs.flatMap((q) => lintQuestion(q));
  const pins = lintModelPins(ctx.config.config, "dcx.config.json");
  printIssues(ctx, issues);
  for (const p of pins) ctx.io.err(`  config [model-pinned] ${p}`);
  ctx.out(
    `lint: ${qs.length} questions, ${issues.length} issue(s); config pins: ${pins.length ? `${pins.length} issue(s)` : "ok"}`,
  );
  return issues.length + pins.length > 0 ? 1 : 0;
}

export async function cmdQuestionsAdd(ctx: Context, files: string[]): Promise<number> {
  if (files.length === 0)
    throw new CliError("questions add: give question JSON files or a directory");
  const qs = loadQuestionFiles(expandFiles(ctx, files));
  const issues = qs.flatMap((q) => lintQuestion(q));
  if (issues.length) {
    printIssues(ctx, issues);
    ctx.io.err(`lint failed (${issues.length} issue(s)); nothing registered`);
    return 1;
  }
  const wh = await ctx.warehouse();
  const n = await writeQuestions(wh, qs);
  ctx.out(
    `registered ${n} new of ${qs.length} questions (lint: no-match option, one judgment, no arithmetic or dates, literal reader: ok)`,
  );
  return 0;
}

const shortHash = (h: string) => h.slice(0, 12);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function cmdQuestionsList(ctx: Context): Promise<void> {
  const qs = await readQuestions(await ctx.warehouse());
  ctx.out(
    table(
      ["question", "qtype", "status", "options", "hash"],
      qs.map((q) => [
        `${q.id}@${q.version}`,
        q.qtype,
        q.status,
        clip(q.options.map((o) => o.label).join("/") || "true/false", 40),
        shortHash(q.questionHash),
      ]),
    ),
  );
}

async function resolveQuestion(ctx: Context, ref: string): Promise<QuestionDef> {
  const p = resolve(ctx.io.cwd, ref);
  if (existsSync(p) && statSync(p).isFile()) {
    const [q] = loadQuestionFiles(p);
    if (!q) throw new CliError(`${ref}: no question in file`);
    return q;
  }
  const q = (await readQuestions(await ctx.warehouse())).find(
    (d) => `${d.id}@${d.version}` === ref,
  );
  if (!q) throw new CliError(`unknown question ${ref} (a registered id@version or a file)`);
  return q;
}

export async function cmdQuestionsDiff(ctx: Context, a: string, b: string): Promise<void> {
  const d = diff(await resolveQuestion(ctx, a), await resolveQuestion(ctx, b));
  ctx.out(`${d.from} → ${d.to}: hash ${d.hashChanged ? "changed" : "unchanged"}`);
  for (const c of d.changes) {
    ctx.out(`  ${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`);
  }
  if (d.hashChanged) {
    ctx.out("  calibrators and thresholds keyed on the old hash no longer apply");
  }
  ctx.out(`  labels survive: ${d.labelsSurvive ? "yes" : "no"}`);
}

export async function cmdImportSynergy(
  ctx: Context,
  o: { review?: string; file?: string; sample?: string; seed?: string },
): Promise<void> {
  const project = await loadProject(ctx.config.paths.project).catch(() => null);
  const review = o.review ?? project?.criteria?.review;
  if (!review && !o.file) throw new CliError("import synergy: give --review <id> or --file");
  let file = o.file ? resolve(ctx.io.cwd, o.file) : "";
  if (!file) {
    const base = join(ctx.config.paths.synergy, review as string);
    file = [`${base}.jsonl`, `${base}.csv`].find((f) => existsSync(f)) ?? "";
    if (!file)
      throw new CliError(
        `no SYNERGY file for review ${review} under ${ctx.config.paths.synergy}`,
      );
  }
  const records = readSynergyFile(file);
  const meta = join(ctx.config.paths.synergy, "META.json");
  const synthetic =
    records.some((r) => r.synthetic !== undefined) ||
    (existsSync(meta) &&
      (JSON.parse(readFileSync(meta, "utf8")) as { synthetic?: boolean }).synthetic === true);
  const rows = synergyRows(records, {
    review: review ?? "review",
    synthetic,
    ...(o.sample ? { sample: Number(o.sample) } : {}),
    seed: o.seed ? Number(o.seed) : 7,
  });
  const n = await importSynergy(await ctx.warehouse(), rows);
  const inc = rows.labels.filter((l) => l.target_kind === "decision" && l.label === "include");
  const tune = rows.labels.filter((l) => l.target_kind === "decision" && l.split === "tune");
  ctx.out(
    `imported ${rows.records.length} records of ${review} (${inc.length} inclusions; ${tune.length} tune / ${rows.records.length - tune.length} holdout)${synthetic ? " · SYNTHETIC DATA" : ""}`,
  );
  ctx.out(
    `  new rows: records ${n.records}, content ${n.content}, labels ${n.labels} (source 'human', selected_by 'exhaustive')`,
  );
}

export async function cmdImportJsonl(ctx: Context, file: string): Promise<void> {
  const text = readFileSync(resolve(ctx.io.cwd, file), "utf8");
  const imp = parseTraceJsonl(text);
  const n = await importTraceJsonl(await ctx.warehouse(), imp);
  ctx.out(
    `imported ${imp.llm_calls.length} traces: llm_calls ${n.llm_calls}, trace_steps ${n.trace_steps}`,
  );
}
