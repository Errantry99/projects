// Cache-key shape (07 §2 row 4; CONTRACT.md §6). Reads the documented component list from
// CONTRACT.md so the test can compare it with what `@dcx/core` exports.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DCX_ROOT } from "./files.js";

/** Column names from the cache-key table in `packages/core/CONTRACT.md`, in table order. */
export function contractCacheKeyColumns(root = DCX_ROOT): string[] {
  const md = readFileSync(join(root, "packages/core/CONTRACT.md"), "utf8");
  const start = md.search(/^##\s+.*cache key/im);
  if (start < 0) throw new Error("CONTRACT.md has no cache-key section");
  const rest = md.slice(start);
  const next = rest.slice(2).search(/^##\s/m);
  const section = next < 0 ? rest : rest.slice(0, next + 2);
  const cols: string[] = [];
  for (const m of section.matchAll(/^\|\s*\d+\s*\|\s*`([a-z_]+)`\s*\|/gm))
    cols.push(m[1] as string);
  return cols;
}
