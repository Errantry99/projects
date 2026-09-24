// File walking shared by the scanners. Paths are resolved from this file, never from the cwd, so
// the policies give the same answer from `dcx/` (workspace run) and from `packages/policy`.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the `dcx/` workspace root. */
export const DCX_ROOT = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");

/** Directories no scanner descends into. */
export const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

/** This package's own directory, relative to `DCX_ROOT`. The scanners exclude it, because its
 *  sources and tests quote the very patterns they look for. */
export const SELF_DIR = "packages/policy";

/** A file found by `walk`: absolute path plus the path relative to `DCX_ROOT`, `/`-separated. */
export interface FoundFile {
  abs: string;
  rel: string;
}

/** Recursively list files under `dir` (absolute) whose name passes `keep`. Does not follow
 *  symlinks (the `@dcx/*` workspace links would loop) and skips `SKIP_DIRS` and `SELF_DIR`. */
export function walk(dir: string, keep: (name: string) => boolean): FoundFile[] {
  const out: FoundFile[] = [];
  const visit = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const abs = join(d, name);
      const rel = toRel(abs);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name) || rel === SELF_DIR) continue;
        visit(abs);
      } else if (st.isFile() && keep(name)) {
        out.push({ abs, rel });
      }
    }
  };
  visit(dir);
  return out;
}

/** `abs` relative to `DCX_ROOT`, with `/` separators. */
export function toRel(abs: string): string {
  return relative(DCX_ROOT, abs).split(sep).join("/");
}

/** Read a file as UTF-8. */
export function readText(abs: string): string {
  return readFileSync(abs, "utf8");
}

/** True when a path (relative, `/`-separated) is a test file: under a `test/` or `tests/`
 *  directory, or named `*.test.ts` / `*.spec.ts`. */
export function isTestPath(rel: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(rel) || /\.(test|spec)\.[cm]?ts$/.test(rel);
}

/** True for a line that is only a comment (`//`, `/*`, ` * `, `#` in shell). */
export function isCommentLine(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*|#)/.test(line);
}

/** A policy violation: where it is and why. */
export interface Violation {
  file: string;
  line: number;
  text: string;
  reason: string;
}

/** One line per violation, for assertion messages. */
export function formatViolations(vs: readonly Violation[]): string {
  return vs.map((v) => `${v.file}:${v.line}: ${v.reason}\n    ${v.text.trim()}`).join("\n");
}
