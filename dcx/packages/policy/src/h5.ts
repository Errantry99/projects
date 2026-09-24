// H5 guard (07 §1 H5, §3 item 13, §6 "Policy tests"). Code that produces training data may read
// labels only through the `training_labels` view: never the judge's own outputs (`judgments`,
// `judge_uses`, the `decisions` / `decision_actions` views) and never raw `labels`, which can
// hold LLM and `jev_disagreement` rows.

import { DCX_ROOT, type FoundFile, readText, type Violation, walk } from "./files.js";

/** Tables and views a training code path may not read. */
export const H5_FORBIDDEN_SOURCES = [
  "judgments",
  "judge_uses",
  "decisions",
  "decision_actions",
  "labels",
] as const;

/** Exported function names that mark a file as a training code path. */
export const TRAINING_FN_NAME = /train|export.*training/i;

const names = H5_FORBIDDEN_SOURCES.join("|");
/** SQL read: `FROM x` / `JOIN x`, optionally db- or schema-qualified or double-quoted. `\s+`
 *  spans line breaks, so `FROM\n  judgments` in a template literal is caught. */
const SQL_READ = new RegExp(
  `\\b(?:from|join)\\s+(?:"?[A-Za-z_]\\w*"?\\.){0,2}"?(${names})"?(?![\\w.])`,
  "gi",
);
/** A bare quoted table name passed to a helper, e.g. `readTable("judgments")`. */
const QUOTED_NAME = new RegExp(`\\(\\s*["'\`](${names})["'\`]`, "g");

/** Blank out whole-line comments, keeping line numbers: `//` and `--` lines, and block comments
 *  opened at a line start (to their `*\/`). A line that merely starts with `*` is only a comment
 *  inside such a block, so `SELECT\n  * FROM judgments` in a template literal is still read. */
export function stripComments(src: string): string {
  let inBlock = false;
  return src
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (inBlock) {
        if (t.includes("*/")) inBlock = false;
        return "";
      }
      if (t.startsWith("//") || t.startsWith("--")) return "";
      if (t.startsWith("/*")) {
        inBlock = !t.slice(2).includes("*/");
        return "";
      }
      return line;
    })
    .join("\n");
}

/** Names of functions a TS source exports (`export function f`, `export const f =`, …). */
export function exportedFunctionNames(src: string): string[] {
  const out: string[] = [];
  const re =
    /export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>))/g;
  for (const m of src.matchAll(re)) out.push((m[1] ?? m[2]) as string);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of (m[1] ?? "").split(",")) {
      const alias = part
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (alias) out.push(alias);
    }
  }
  return out;
}

/** Why a file is a training code path, or `null` when it is not one. */
export function trainingReason(rel: string, src: string): string | null {
  if (/(^|\/)train(ing)?\//.test(rel)) return "under a train/ or training/ directory";
  const fn = exportedFunctionNames(src).find((n) => TRAINING_FN_NAME.test(n));
  if (fn) return `exports ${fn}()`;
  if (/--training\b/.test(src)) return "implements an `--training` option";
  return null;
}

/** Scan one source. Returns violations only when the file is a training code path. */
export function scanH5(rel: string, src: string): Violation[] {
  const why = trainingReason(rel, src);
  if (!why) return [];
  const out: Violation[] = [];
  const text = stripComments(src);
  const lines = src.split("\n");
  const seen = new Set<number>();
  for (const re of [SQL_READ, QUOTED_NAME]) {
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split("\n").length;
      if (seen.has(line)) continue;
      seen.add(line);
      out.push({
        file: rel,
        line,
        text: lines[line - 1] ?? "",
        reason: `training path (${why}) reads \`${m[1]}\`; read \`training_labels\` instead`,
      });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Every TS/JS source and SQL file under `dcx/packages` and `dcx/projects`. */
export function h5Files(root = DCX_ROOT): FoundFile[] {
  const ts = (n: string) => /\.(?:[cm]?[tj]s|sql)$/.test(n) && !/\.d\.[cm]?ts$/.test(n);
  return [...walk(`${root}/packages`, ts), ...walk(`${root}/projects`, ts)];
}

/** Scan the workspace. Returns the files that are training paths and all violations. */
export function scanWorkspaceH5(root = DCX_ROOT): {
  scanned: number;
  trainingFiles: string[];
  violations: Violation[];
} {
  const files = h5Files(root);
  const trainingFiles: string[] = [];
  const violations: Violation[] = [];
  for (const f of files) {
    const src = readText(f.abs);
    if (trainingReason(f.rel, src)) trainingFiles.push(f.rel);
    violations.push(...scanH5(f.rel, src));
  }
  return { scanned: files.length, trainingFiles, violations };
}
