// `tool` step: STUB executor with the durable parts done. The idempotency key is
// hash(run_id, step_no); a `tool_calls` row is written before the call so an in-doubt call is
// visible. A step found `running` on resume was interrupted mid-call: idempotent tools retry
// with the same key, others are flagged in_doubt and fail for an operator (03 §2.3). With no
// registered executor, or in shadow mode (effect-free), it returns a stub result.

import { canonicalize, type Json, jsonHash, sha256Hex } from "@dcx/core";
import type { StepDone, StepEnv } from "../types.js";

export function idempotencyKey(runId: string, stepNo: number): string {
  return jsonHash(["dcx/idem@1", runId, stepNo]);
}

export class InDoubtError extends Error {
  override name = "InDoubtError";
}

export async function execTool(
  env: StepEnv,
  c: { tool: string; args: Json; idempotent: boolean },
): Promise<StepDone> {
  const j = env.deps.journal;
  const key = idempotencyKey(env.runId, env.stepNo);
  const argsCanonical = canonicalize(c.args);
  const argsHash = sha256Hex(argsCanonical);
  if (env.prior) {
    if (!c.idempotent) {
      await j.updateToolCall(env.runId, env.stepNo, { in_doubt: true });
      throw new InDoubtError(`tool ${c.tool} at step ${env.stepNo} is in doubt`);
    }
  } else {
    await j.putToolCall({
      run_id: env.runId,
      step_no: env.stepNo,
      tool: c.tool,
      args_canonical: argsCanonical,
      args_hash: argsHash,
      effect_class: c.idempotent ? "idempotent_write" : "write",
      idempotency_key: key,
      in_doubt: false,
    });
  }
  const fn = env.deps.tools?.[c.tool];
  const output: Json =
    fn && env.mode !== "shadow"
      ? await fn(c.args, { idempotencyKey: key })
      : { stub: true, tool: c.tool, idempotencyKey: key };
  return {
    output,
    effect: { effect: { kind: "tool", tool: c.tool, args_hash: argsHash }, branch: c.tool },
    activity: `tool:${c.tool}`,
  };
}
