// Pinning (07 §3 item 9, §6; 02 §3.4 "lint bans jev-latest"). The alias `jev-latest` may appear
// only in rejection logic: never in a config, fixture, script or default.

import {
  DCX_ROOT,
  isCommentLine,
  isTestPath,
  readText,
  type Violation,
  walk,
} from "./files.js";

const ALIAS = /jev-latest/i;
/** `jev-latest` as a string literal (a value, as opposed to a regex or comment). */
const STRING_LITERAL = /(["'`])[^"'`\n]*jev-latest[^"'`\n]*\1/i;
/** A line that is itself rejection logic: a regex literal, a pin check or an explicit marker. */
const REJECTION_LINE =
  /\/[^/\n]*jev-latest[^/\n]*\/[gimsuy]*|assertPinned|isUnpinnedModel|policy:\s*rejects-alias/i;
/** A test file that asserts rejection somewhere (so its `jev-latest` inputs are deliberate). */
const ASSERTS_REJECTION = /\.toThrow|\.rejects|\blint\w*\(|toHaveLength\(\s*[1-9]/;
/** A JSON/shell fixture whose path says it is a deliberate rejection case. */
const REJECTION_FIXTURE = /(^|\/)(test|tests)\/.*(reject|invalid|bad)/i;

/** Scan one file (`rel` is relative to `dcx/`). */
export function scanPinning(rel: string, src: string): Violation[] {
  if (!ALIAS.test(src)) return [];
  const test = isTestPath(rel);
  if (rel.endsWith(".ts") && test && ASSERTS_REJECTION.test(src)) return [];
  if (!rel.endsWith(".ts") && REJECTION_FIXTURE.test(rel)) return [];
  const out: Violation[] = [];
  src.split("\n").forEach((text, i) => {
    if (!ALIAS.test(text)) return;
    let reason: string | null = null;
    if (rel.endsWith(".json")) reason = "`jev-latest` in a config or fixture";
    else if (rel.endsWith(".sh")) {
      if (!isCommentLine(text)) reason = "`jev-latest` in a script";
    } else if (
      !isCommentLine(text) &&
      !REJECTION_LINE.test(text) &&
      STRING_LITERAL.test(text)
    ) {
      reason = test
        ? "`jev-latest` in a test that never asserts rejection"
        : "`jev-latest` used as a value (default or config) outside rejection logic";
    }
    if (reason) out.push({ file: rel, line: i + 1, text, reason });
  });
  return out;
}

/** Scan every `.ts`, `.json` and `.sh` under `dcx/` (not node_modules, dist, the lockfile or
 *  this package). */
export function scanWorkspacePinning(root = DCX_ROOT): {
  scanned: number;
  violations: Violation[];
} {
  const files = walk(root, (n) => /\.(ts|json|sh)$/.test(n) && n !== "package-lock.json");
  const violations = files.flatMap((f) => scanPinning(f.rel, readText(f.abs)));
  return { scanned: files.length, violations };
}
