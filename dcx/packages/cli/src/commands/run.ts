// dcx run <workflow@v> [--mode] [--split] [--records] [--model] · dcx replay <run> [--fork-at k]
//
// One kernel run per record. Run ids are `<workflow>@<v>:<batch>:<record_id>`, so a report can
// pick the latest batch of each workflow from the journal. The kernel journals to the SQLite
// journal (@dcx/store) and its warehouse rows go through the outbox, which is drained into
// DuckDB before the command exits.

import { assertPinned, type Json, MODES, type Mode } from "@dcx/core";
import { fork, Kernel, replay } from "@dcx/kernel";
import { makeBackend } from "../backends.js";
import { CliError, type Context } from "../context.js";
import { WarehouseJudge } from "../judge-service.js";
import { FixtureLlm } from "../llm-fixture.js";
import { findWorkflow, loadProject } from "../project.js";

export interface KernelOpts {
  backend?: string;
  pin?: string;
}

/** A kernel over the real stores, with the project's workflows and rules, the warehouse judge
 *  and the fixture LLM. */
export async function buildKernel(
  ctx: Context,
  o: KernelOpts = {},
): Promise<{ kernel: Kernel; judge: WarehouseJudge; llm: FixtureLlm }> {
  const cfg = ctx.config;
  const project = await loadProject(cfg.paths.project);
  const warehouse = await ctx.warehouse();
  const pin = o.pin ?? cfg.config.judge.pin;
  const backend = makeBackend({
    backend: o.backend ?? cfg.config.judge.backend,
    pin,
    env: ctx.io.env,
    fixtureDir: cfg.paths.judgeFixtures,
    ...(cfg.config.judge.wire ? { wire: cfg.config.judge.wire } : {}),
  });
  if (cfg.config.llm.backend !== "fixture") {
    throw new CliError(
      `llm backend "${cfg.config.llm.backend}" is not available; use "fixture"`,
    );
  }
  const judge = new WarehouseJudge(warehouse, backend, { pin });
  const llm = new FixtureLlm(cfg.paths.llmFixtures);
  const kernel = new Kernel({
    journal: ctx.journal(),
    warehouse,
    workflows: project.workflows,
    rules: project.rules,
    judge,
    llm,
  });
  return { kernel, judge, llm };
}

export interface RunOpts extends KernelOpts {
  mode?: string;
  split?: string;
  records?: string;
  model?: string;
  limit?: string;
  batch?: string;
}

export async function cmdRun(ctx: Context, ref: string, o: RunOpts): Promise<number> {
  const mode = (o.mode ?? "active") as Mode;
  if (!MODES.includes(mode)) throw new CliError(`--mode must be one of ${MODES.join(", ")}`);
  if (o.model) assertPinned(o.model);
  const project = await loadProject(ctx.config.paths.project);
  const wf = findWorkflow(project, ref);
  const wh = await ctx.warehouse();
  const ids =
    o.records
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  const where: string[] = [];
  const params: string[] = [];
  if (o.split) {
    params.push(o.split);
    where.push(
      `EXISTS (SELECT 1 FROM labels l WHERE l.record_id = r.record_id AND l.split = $${params.length})`,
    );
  }
  if (ids.length) {
    where.push(`r.record_id IN (${ids.map((_, i) => `$${params.length + i + 1}`).join(", ")})`);
    params.push(...ids);
  }
  const recs = await wh.all<{ record_id: string; state: Json }>(
    `SELECT r.record_id, r.state FROM records r ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY r.record_id ${o.limit ? `LIMIT ${Number(o.limit)}` : ""}`,
    params,
  );
  if (recs.length === 0) throw new CliError("run: no records match (did you `dcx import`?)");
  const { kernel, judge, llm } = await buildKernel(ctx, o);
  const batch = o.batch ?? `b${Date.now().toString(36)}`;
  const counts = { completed: 0, waiting: 0, failed: 0 };
  const failures: string[] = [];
  for (const r of recs) {
    const input: Json = {
      record_id: r.record_id,
      state: r.state,
      ...(o.model ? { model: o.model } : {}),
    };
    const res = await kernel.createRun(wf.name, wf.version, mode, input, {
      runId: `${wf.name}@${wf.version}:${batch}:${r.record_id}`,
    });
    counts[res.status]++;
    if (res.status === "failed") failures.push(`${res.runId}: ${res.error}`);
  }
  const drained = await ctx.drain();
  ctx.out(
    `${wf.name}@${wf.version} batch ${batch}: ${recs.length} runs · completed ${counts.completed} · waiting on review ${counts.waiting} · failed ${counts.failed}`,
  );
  ctx.out(
    `  LLM calls ${llm.calls} (fixture) · judge requests ${judge.requests} · ${drained.inserted} warehouse rows exported`,
  );
  for (const f of failures.slice(0, 5)) ctx.io.err(`  failed ${f}`);
  return counts.failed > 0 ? 1 : 0;
}

export async function cmdReplay(
  ctx: Context,
  runId: string,
  o: KernelOpts & { forkAt?: string },
): Promise<number> {
  const j = ctx.journal();
  const run = await j.getRun(runId);
  if (!run) throw new CliError(`run ${runId} not found in ${ctx.config.paths.journal}`);
  const { kernel } = await buildKernel(ctx, o);
  if (o.forkAt !== undefined) {
    const at = Number(o.forkAt);
    if (!Number.isInteger(at) || at < 1)
      throw new CliError("--fork-at must be a step number ≥ 1");
    const res = await fork(kernel, runId, at);
    await ctx.drain();
    ctx.out(`forked ${runId} at step ${at} → ${res.runId} (${res.status})`);
    if (res.output !== undefined) ctx.out(JSON.stringify(res.output));
    return res.status === "failed" ? 1 : 0;
  }
  const steps = await j.listSteps(runId);
  const out = await replay(kernel, runId);
  ctx.out(
    `replayed ${runId}: ${steps.length} journaled steps, identical output, nothing written`,
  );
  ctx.out(JSON.stringify(out));
  return 0;
}
