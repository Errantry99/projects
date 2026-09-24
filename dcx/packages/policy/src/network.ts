// No network in tests (BUILD.md, CONTRACT.md §1: "Tests never need network or a paid key").
// A test file may not import `node-fetch` / `undici` or call `fetch(` unless it carries the
// marker comment `// network: mocked`, which says the call goes to a stub.

import {
  DCX_ROOT,
  isCommentLine,
  isTestPath,
  readText,
  type Violation,
  walk,
} from "./files.js";

/** The marker that allows a test file to mention `fetch`. */
export const NETWORK_MOCK_MARKER = "// network: mocked";

const IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["'](node-fetch|undici)(?:\/[^"']*)?["']/;
/** A global `fetch(` call, not a method such as `client.fetch(`. `globalThis.fetch(` counts. */
const CALL = /(?:^|[^\w$.])fetch\s*\(/;
const GLOBAL_PREFIX = /\b(?:globalThis|window|global)\.(?=fetch\b)/g;

/** Scan one test file. */
export function scanNetwork(rel: string, src: string): Violation[] {
  if (src.includes(NETWORK_MOCK_MARKER)) return [];
  const out: Violation[] = [];
  src.split("\n").forEach((text, i) => {
    if (isCommentLine(text)) return;
    const imp = IMPORT.exec(text);
    if (imp) out.push({ file: rel, line: i + 1, text, reason: `imports ${imp[1]}` });
    else if (CALL.test(text.replace(GLOBAL_PREFIX, "")))
      out.push({ file: rel, line: i + 1, text, reason: "calls fetch()" });
  });
  return out.map((v) => ({ ...v, reason: `${v.reason} without \`${NETWORK_MOCK_MARKER}\`` }));
}

/** Every test `.ts` under `dcx/packages` and `dcx/projects`. */
export function testFiles(root = DCX_ROOT) {
  const ts = (n: string) => n.endsWith(".ts");
  return [...walk(`${root}/packages`, ts), ...walk(`${root}/projects`, ts)].filter((f) =>
    isTestPath(f.rel),
  );
}

/** Scan all test files. */
export function scanWorkspaceNetwork(root = DCX_ROOT): {
  scanned: string[];
  violations: Violation[];
} {
  const files = testFiles(root);
  return {
    scanned: files.map((f) => f.rel),
    violations: files.flatMap((f) => scanNetwork(f.rel, readText(f.abs))),
  };
}
