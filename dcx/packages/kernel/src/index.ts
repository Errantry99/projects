// @dcx/kernel: journaled RunCtx kernel, cascade router, replay/fork and OTel span mapping.
export * from "./otel.js";
export { fork, replay } from "./replay.js";
export * from "./router.js";
export {
  Ctx,
  decodeMeta,
  encodeMeta,
  Kernel,
  LeaseError,
  ReplayDivergence,
  type RunMeta,
  StepFailed,
  Suspended,
} from "./runctx.js";
export { hitlId } from "./steps/human.js";
export { llmCallId, renderTemplate, templateHash } from "./steps/llm.js";
export { loadThresholds } from "./steps/route.js";
export { toJson } from "./steps/sql.js";
export { InDoubtError, idempotencyKey } from "./steps/tool.js";
export * from "./types.js";

import type { Journal, Json, Mode, Warehouse } from "@dcx/core";
import { Kernel } from "./runctx.js";
import type { KernelDeps, RunResult } from "./types.js";

/** Convenience: build a kernel and start one run (see `Kernel.createRun`). */
export function createRun(
  journal: Journal,
  warehouse: Warehouse,
  workflow: string,
  version: number,
  mode: Mode,
  input: Json,
  deps: Omit<KernelDeps, "journal" | "warehouse">,
): Promise<RunResult> {
  return new Kernel({ ...deps, journal, warehouse }).createRun(workflow, version, mode, input);
}
