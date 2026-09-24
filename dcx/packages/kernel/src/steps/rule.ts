// `rule` step: a registered pure function `name@version` over inputs; the output is journaled.

import type { Json } from "@dcx/core";
import type { RuleDef, StepDone, StepEnv } from "../types.js";

export function findRule(rules: readonly RuleDef[] | undefined, ref: string): RuleDef {
  const r = rules?.find((x) => x.ref === ref);
  if (!r) throw new Error(`rule ${ref} is not registered`);
  return r;
}

export async function execRule(env: StepEnv, ref: string, inputs: Json): Promise<StepDone> {
  const output = findRule(env.deps.rules, ref).fn(inputs);
  return {
    output,
    effect: {
      effect: { kind: "rule", ref, output },
      branch: typeof output === "string" ? output : null,
    },
    activity: `rule:${ref}`,
  };
}
