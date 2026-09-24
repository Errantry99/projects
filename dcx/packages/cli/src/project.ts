// Loads a dcx project (e.g. projects/evidence-screener): its `src/index.ts` module is scanned
// for workflows (`{name, version, run}`) and rule lists (`[{ref, fn}]`), and its `questions/`
// directory holds the question JSON files. Nothing here is specific to one project.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Json, Workflow } from "@dcx/core";
import type { RuleDef } from "@dcx/kernel";
import { CliError } from "./context.js";

export interface Project {
  dir: string;
  questionsDir: string;
  workflows: Workflow[];
  rules: RuleDef[];
  /** The project's review protocol, when it exports `CRITERIA` (review id, synthetic flag). */
  criteria: {
    review?: string;
    synthetic?: boolean;
    baseline_model?: string;
    /** `policy.audit_rate`, for the report's column title. */
    auditRate?: number;
  } | null;
}

const isWorkflow = (v: unknown): v is Workflow =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Workflow).name === "string" &&
  typeof (v as Workflow).version === "number" &&
  typeof (v as Workflow).run === "function";

const isRuleList = (v: unknown): v is RuleDef[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every(
    (r) =>
      typeof r === "object" &&
      r !== null &&
      typeof (r as RuleDef).ref === "string" &&
      typeof (r as RuleDef).fn === "function",
  );

const cache = new Map<string, Promise<Project>>();

export function loadProject(dir: string): Promise<Project> {
  let p = cache.get(dir);
  if (!p) {
    p = load(dir);
    cache.set(dir, p);
  }
  return p;
}

async function load(dir: string): Promise<Project> {
  const entry = join(dir, "src", "index.ts");
  if (!existsSync(entry)) throw new CliError(`project ${dir} has no src/index.ts`);
  const mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
  const workflows: Workflow[] = [];
  const rules: RuleDef[] = [];
  for (const v of Object.values(mod)) {
    if (isWorkflow(v) && !workflows.includes(v)) workflows.push(v);
    else if (isRuleList(v)) {
      for (const r of v) if (!rules.some((x) => x.ref === r.ref)) rules.push(r);
    }
  }
  const c = mod.CRITERIA as Record<string, Json> | undefined;
  return {
    dir,
    questionsDir: join(dir, "questions"),
    workflows,
    rules,
    criteria: c
      ? {
          ...(typeof c.review === "string" ? { review: c.review } : {}),
          ...(typeof c.synthetic === "boolean" ? { synthetic: c.synthetic } : {}),
          ...(typeof c.baseline_model === "string" ? { baseline_model: c.baseline_model } : {}),
          ...(typeof (c.policy as Record<string, Json> | undefined)?.audit_rate === "number"
            ? { auditRate: (c.policy as Record<string, number>).audit_rate }
            : {}),
        }
      : null,
  };
}

/** Parse `name@version`. */
export function parseWorkflowRef(ref: string): { name: string; version: number } {
  const i = ref.lastIndexOf("@");
  const version = Number(ref.slice(i + 1));
  if (i <= 0 || !Number.isInteger(version) || version < 1) {
    throw new CliError(
      `bad workflow ref "${ref}": expected name@version, e.g. screen-baseline@1`,
    );
  }
  return { name: ref.slice(0, i), version };
}

export function findWorkflow(p: Project, ref: string): Workflow {
  const { name, version } = parseWorkflowRef(ref);
  const wf = p.workflows.find((w) => w.name === name && w.version === version);
  if (!wf) {
    const known = p.workflows.map((w) => `${w.name}@${w.version}`).join(", ");
    throw new CliError(`workflow ${ref} not found in ${p.dir} (known: ${known || "none"})`);
  }
  return wf;
}
