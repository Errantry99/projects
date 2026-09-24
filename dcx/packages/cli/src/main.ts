// The `dcx` command (07 §4.7). `main(argv)` builds a commander program over one `Context`
// (config + stores, the warehouse opened at most once), runs the command and closes the stores.
// Tests call `runCli(argv, io)` in-process.

import { Command, CommanderError } from "commander";
import { cmdEval, cmdFit, cmdJudge } from "./commands/judge.js";
import { cmdReportCalibration, cmdReportH4, cmdReportLedger } from "./commands/report.js";
import { cmdReplay, cmdRun } from "./commands/run.js";
import {
  cmdImportJsonl,
  cmdImportSynergy,
  cmdInit,
  cmdLint,
  cmdMigrate,
  cmdQuestionsAdd,
  cmdQuestionsDiff,
  cmdQuestionsList,
} from "./commands/setup.js";
import { CliError, Context, type Io } from "./context.js";

export function buildProgram(
  io: Io,
  onCode: (code: number) => void,
): { program: Command; close: () => Promise<void> } {
  const program = new Command("dcx");
  let ctx: Context | null = null;
  const context = () => {
    ctx ??= new Context(io, program.opts<{ dir?: string }>().dir);
    return ctx;
  };
  const act =
    <A extends unknown[]>(fn: (c: Context, ...a: A) => Promise<unknown>) =>
    async (...a: A) => {
      const code = await fn(context(), ...a);
      if (typeof code === "number") onCode(code);
    };

  program
    .description("dcx: typed, cached, calibrated judgements over a journaled kernel")
    .option("-C, --dir <dir>", "directory holding dcx.config.json (default: cwd or a parent)")
    .configureOutput({
      writeOut: (s) => io.out(s.replace(/\n$/, "")),
      writeErr: (s) => io.err(s.replace(/\n$/, "")),
    })
    .exitOverride()
    .showHelpAfterError();

  program
    .command("init [dir]")
    .description("create dcx.config.json and migrate both stores")
    .option("--project <dir>", "project directory (default: projects/evidence-screener)")
    .option("--fixtures <dir>", "fixtures root (default: dcx/fixtures)")
    .option("--force", "overwrite an existing config")
    .action(act((c, dir: string | undefined, o) => cmdInit(c, dir, o)));

  program
    .command("migrate")
    .description("apply pending schema migrations to the journal and warehouse")
    .action(act((c) => cmdMigrate(c)));

  program
    .command("lint [files...]")
    .description("lint question files (default: the project's) and the config's model pins")
    .action(act((c, files: string[]) => cmdLint(c, files)));

  const questions = program.command("questions").description("the question registry");
  questions
    .command("add <files...>")
    .description("lint and register question JSON files")
    .action(act((c, files: string[]) => cmdQuestionsAdd(c, files)));
  questions
    .command("list")
    .description("list registered questions")
    .action(act((c) => cmdQuestionsList(c)));
  questions
    .command("diff <a> <b>")
    .description("diff two question versions (id@version or files)")
    .action(act((c, a: string, b: string) => cmdQuestionsDiff(c, a, b)));

  const imp = program.command("import").description("import records or traces");
  imp
    .command("synergy")
    .description("import a SYNERGY review (or the synthetic stand-in) with author labels")
    .option("--review <id>", "review id (default: the project's)")
    .option(
      "--file <path>",
      "SYNERGY CSV or JSONL (default: <fixtures>/synergy-synthetic/<review>)",
    )
    .option("--sample <n>", "all inclusions plus sampled exclusions, n in total")
    .option("--seed <n>", "sample and split seed", "7")
    .action(act((c, o) => cmdImportSynergy(c, o)));
  imp
    .command("jsonl <file>")
    .description("import TraceRow JSONL into llm_calls and trace_steps")
    .action(act((c, file: string) => cmdImportJsonl(c, file)));

  const kernelOpts = (cmd: Command) =>
    cmd
      .option("--backend <name>", "judge backend: fixture | jev | wire | laya")
      .option("--pin <model>", "pinned judge model, e.g. jev-1.13.0");

  kernelOpts(
    program
      .command("run <workflow>")
      .description("run workflow@version once per record")
      .option("--mode <mode>", "active | shadow | canary | audit", "active")
      .option("--split <split>", "only records labelled in this split (tune | holdout)")
      .option("--records <ids>", "comma-separated record ids")
      .option("--limit <n>", "at most n records")
      .option("--model <model>", "LLM model for the workflow's llm steps")
      .option("--batch <id>", "batch id (default: a timestamp)"),
  ).action(act((c, wf: string, o) => cmdRun(c, wf, o)));

  kernelOpts(
    program
      .command("judge")
      .description("drain the judge work list: every live question × record not yet cached")
      .option("--budget <usd>", "refuse calls beyond this spend")
      .option("--concurrency <n>", "parallel requests", "4")
      .option("--rpm <n>", "requests per minute (fixture: unlimited)")
      .option("--url <url>", "wire backend server root")
      .option("--name <name>", "wire backend cache-key name (kev, jeff, tev-local)"),
  ).action(act((c, o) => cmdJudge(c, o)));

  kernelOpts(
    program
      .command("fit <questionSet>")
      .description("fit calibrators and thresholds for a question set on a label split")
      .option("--split <split>", "label split to fit on", "tune")
      .option("--method <method>", "identity | temperature | platt | isotonic | histogram"),
  ).action(act((c, set: string, o) => cmdFit(c, set, o)));

  kernelOpts(
    program
      .command("eval <questionSet>")
      .description("evaluate active calibrators and thresholds on a split")
      .option("--split <split>", "label split", "holdout"),
  ).action(act((c, set: string, o) => cmdEval(c, set, o)));

  const report = program.command("report").description("reports");
  const reportOpts = (cmd: Command) =>
    cmd
      .option("--html <path>", "also write a self-contained HTML page")
      .option("--split <split>", "restrict to records in this split")
      .option("--baseline <workflow>", "baseline workflow@version")
      .option("--compiled <workflow>", "compiled workflow@version");
  reportOpts(report.command("h4").description("the H4 comparison table (07 §4.8)")).action(
    act((c, o) => cmdReportH4(c, o)),
  );
  reportOpts(report.command("ledger").description("the savings ledger"))
    .option("--runs", "one row per run")
    .action(act((c, o) => cmdReportLedger(c, o)));
  reportOpts(report.command("calibration").description("reliability per question")).action(
    act((c, o) => cmdReportCalibration(c, o)),
  );

  kernelOpts(
    program
      .command("replay <run>")
      .description("replay a run from its journal, or fork it at step k")
      .option("--fork-at <k>", "keep steps < k, re-execute from k"),
  ).action(act((c, run: string, o) => cmdReplay(c, run, o)));

  const close = async () => {
    const c = ctx;
    ctx = null;
    if (c) await c.close();
  };
  return { program, close };
}

/** Run the CLI in-process. Returns the exit code; never calls process.exit. */
export async function runCli(argv: readonly string[], io: Io): Promise<number> {
  let code = 0;
  const { program, close } = buildProgram(io, (c) => {
    code = c;
  });
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (e) {
    if (e instanceof CommanderError) {
      code = e.exitCode === 0 || e.code === "commander.helpDisplayed" ? 0 : e.exitCode || 1;
    } else {
      io.err(e instanceof CliError ? `dcx: ${e.message}` : `dcx: ${(e as Error).stack ?? e}`);
      code = 1;
    }
  } finally {
    await close();
  }
  return code;
}

export function main(argv: readonly string[]): Promise<number> {
  return runCli(argv, {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    cwd: process.cwd(),
    env: process.env,
  });
}
