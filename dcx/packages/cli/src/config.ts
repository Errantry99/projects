// `dcx.config.json`: where the stores live, which project and fixtures to use, the default
// judge backend and pin, and the threshold policies `dcx fit` writes. Relative paths resolve
// against the config file's directory. Environment variables override the file:
//   DCX_DIR (the directory holding dcx.config.json), DCX_JOURNAL, DCX_WAREHOUSE,
//   DCX_PROJECT, DCX_FIXTURES (a fixtures root laid out like dcx/fixtures), DCX_JUDGE_PIN.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_FILE = "dcx.config.json";

/** A threshold policy: one `thresholds` row per question, sharing `policy_id`. */
export interface PolicyConfig {
  /** e.g. `screen.auto_exclude@1`; the route's `thresholdRef`. */
  policy_id: string;
  /** The route action the threshold gates, e.g. `exclude`. */
  action: string;
  /** The pre-registered τ floor; a sweep may only raise it. */
  min_p: number;
  /** Abstain-band floor (the `thresholds.floor` column); omitted → the column default. */
  floor?: number;
  /** Question ref → the answer that triggers the action for that question. */
  labels: Record<string, string>;
}

export interface DcxConfig {
  journal: string;
  warehouse: string;
  /** Project directory: `src/index.ts` exports workflows and rules; `questions/` holds JSON. */
  project: string;
  fixtures: {
    /** Judge fixture directory (FixtureEntry files keyed by the full cache key). */
    judge: string;
    /** LLM fixture root: `<template_id>@<v>/<record_id>.json`. */
    llm: string;
    /** SYNERGY (or synthetic) review files: `<review>.jsonl` or `.csv`. */
    synergy: string;
  };
  judge: { backend: string; pin: string; wire?: { name?: string; url?: string } };
  llm: { backend: "fixture" };
  /** `labels.target_ref` of the decision truth labels (e.g. author screening labels). */
  truthRef: string;
  report: { baseline: string; compiled: string };
  policies: PolicyConfig[];
  out: string;
}

/** The dcx workspace root (`dcx/`), found from this file. */
export const DCX_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The demo defaults: the evidence-screener project over the synthetic review's fixtures. */
export function defaultConfig(root = DCX_ROOT): DcxConfig {
  const review = "synthetic_exercise_depression";
  return {
    journal: "dcx.sqlite",
    warehouse: "dcx.duckdb",
    project: join(root, "projects/evidence-screener"),
    fixtures: {
      judge: join(root, "fixtures/judge", review),
      llm: join(root, "fixtures/llm"),
      synergy: join(root, "fixtures/synergy-synthetic"),
    },
    judge: { backend: "fixture", pin: "jev-1.13.0" },
    llm: { backend: "fixture" },
    truthRef: "screen.include",
    report: { baseline: "screen-baseline@1", compiled: "screen-compiled@1" },
    policies: [
      {
        policy_id: "screen.auto_exclude@1",
        action: "exclude",
        min_p: 0.99,
        labels: {
          "screen.on_topic@1": "false",
          "screen.crit_1@1": "fails",
          "screen.crit_2@1": "fails",
          "screen.crit_3@1": "fails",
          "screen.crit_4@1": "fails",
        },
      },
    ],
    out: "out",
  };
}

export interface LoadedConfig {
  /** Directory holding the config file (the dcx "home" for this project). */
  dir: string;
  /** Absolute path of the config file, or null when running on defaults. */
  file: string | null;
  config: DcxConfig;
  /** Absolute paths. */
  paths: {
    journal: string;
    warehouse: string;
    project: string;
    judgeFixtures: string;
    llmFixtures: string;
    synergy: string;
    out: string;
  };
}

/** Find `dcx.config.json` in `start` or its parents. */
export function findConfigDir(start: string): string | null {
  let d = resolve(start);
  for (;;) {
    if (existsSync(join(d, CONFIG_FILE))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

const abs = (base: string, p: string) => (isAbsolute(p) ? p : resolve(base, p));

/** Load the config for `cwd` (or `DCX_DIR`), applying env overrides. */
export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = {}): LoadedConfig {
  const dir = env.DCX_DIR ? resolve(cwd, env.DCX_DIR) : (findConfigDir(cwd) ?? resolve(cwd));
  const file = join(dir, CONFIG_FILE);
  const has = existsSync(file);
  const base = defaultConfig();
  const raw = has ? (JSON.parse(readFileSync(file, "utf8")) as Partial<DcxConfig>) : {};
  const config: DcxConfig = {
    ...base,
    ...raw,
    fixtures: { ...base.fixtures, ...raw.fixtures },
    judge: { ...base.judge, ...raw.judge },
    report: { ...base.report, ...raw.report },
  };
  if (env.DCX_FIXTURES) {
    const f = resolve(cwd, env.DCX_FIXTURES);
    config.fixtures = {
      judge: join(f, "judge", "synthetic_exercise_depression"),
      llm: join(f, "llm"),
      synergy: join(f, "synergy-synthetic"),
    };
  }
  if (env.DCX_JUDGE_PIN) config.judge = { ...config.judge, pin: env.DCX_JUDGE_PIN };
  return {
    dir,
    file: has ? file : null,
    config,
    paths: {
      journal: env.DCX_JOURNAL ? resolve(cwd, env.DCX_JOURNAL) : abs(dir, config.journal),
      warehouse: env.DCX_WAREHOUSE
        ? resolve(cwd, env.DCX_WAREHOUSE)
        : abs(dir, config.warehouse),
      project: env.DCX_PROJECT ? resolve(cwd, env.DCX_PROJECT) : abs(dir, config.project),
      judgeFixtures: abs(dir, config.fixtures.judge),
      llmFixtures: abs(dir, config.fixtures.llm),
      synergy: abs(dir, config.fixtures.synergy),
      out: abs(dir, config.out),
    },
  };
}

/** Write a config file (pretty JSON). */
export function writeConfig(dir: string, config: DcxConfig): string {
  const file = join(dir, CONFIG_FILE);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}
