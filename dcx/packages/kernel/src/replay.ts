// Replay and time travel (03 §3.6). `replay` re-runs a run's workflow strictly from its journal:
// nothing executes and nothing is written, so it returns identical outputs or throws
// ReplayDivergence. `fork` copies steps < k into a new run and re-executes from k (optionally
// with an override for step k: "what if I had approved?"); only the new run's steps ≥ k write
// warehouse rows. Recovery (same version, crash restart) is `Kernel.resume`.

import type { Json } from "@dcx/core";
import { decodeMeta, type Kernel } from "./runctx.js";
import type { RunResult } from "./types.js";

/** Strict replay from the journal; returns the workflow output. A waiting run throws. */
export async function replay(k: Kernel, runId: string): Promise<Json> {
  const run = await k.deps.journal.getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const r = await k.execute(run, true);
  if (r.status !== "completed") throw new Error(`run ${runId} is ${r.status}, not replayable`);
  return r.output ?? null;
}

/** Fork run `runId` at step `at`: keep steps < at, re-execute from at. */
export async function fork(
  k: Kernel,
  runId: string,
  at: number,
  opts: { override?: Json; runId?: string } = {},
): Promise<RunResult> {
  const j = k.deps.journal;
  const src = await j.getRun(runId);
  if (!src) throw new Error(`run ${runId} not found`);
  const newId = opts.runId ?? `${runId}~fork${at}-${k.clock().toString(36)}`;
  const steps = await j.listSteps(runId);
  let forkAt = at;
  for (const s of steps) {
    if (s.step_no < at) await j.putStep({ ...s, run_id: newId });
  }
  if (opts.override !== undefined) {
    const s = steps.find((x) => x.step_no === at);
    if (!s) throw new Error(`run ${runId} has no step ${at} to override`);
    await j.putStep({
      ...s,
      run_id: newId,
      status: "completed",
      output: opts.override,
      error: null,
    });
    forkAt = at + 1;
  }
  return k.createRun(src.workflow, src.workflow_v, src.mode, decodeMeta(src.input_ref).input, {
    runId: newId,
    meta: { forkOf: runId, forkAt },
  });
}
