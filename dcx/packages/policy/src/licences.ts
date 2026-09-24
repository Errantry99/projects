// Licences (07 §3 item 14; 05 §3.4). dcx is Apache-2.0, so no dependency may be AGPL, SSPL,
// Elastic (ELv2) or BUSL. Checks both the lockfile and what is actually installed, and honours
// an explicit allowlist (`licence-allowlist.json`, empty by default).

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DCX_ROOT, toRel } from "./files.js";

/** Licence identifiers dcx may not depend on. Matches SPDX ids and free-text variants. */
export const BANNED_LICENCE = /\b(A-?GPL|SSPL|Elastic|ELv2|BUSL|Business Source)/i;

/** One dependency with its licence, from the lockfile or from an installed package.json. */
export interface LicenceEntry {
  name: string;
  version: string;
  licence: string;
  from: "lockfile" | "installed";
  path: string;
}

/** An allowlist entry: a banned-licence dependency accepted on purpose, with a reason. */
export interface AllowlistEntry {
  name: string;
  /** Exact version, or `*` for any. */
  version: string;
  reason: string;
}

/** Normalise the `license` / `licenses` fields of a package.json or lockfile entry. */
export function licenceOf(pkg: Record<string, unknown>): string {
  const one = pkg.license ?? pkg.licence;
  if (typeof one === "string") return one;
  if (one && typeof one === "object" && "type" in one) return String(one.type);
  const many = pkg.licenses;
  if (Array.isArray(many) && many.length > 0) {
    return many
      .map((l) => (typeof l === "string" ? l : String((l as { type?: unknown }).type)))
      .join(" OR ");
  }
  return "(none)";
}

/** Entries from `package-lock.json` (v2/v3 `packages` map). Workspace links are skipped. */
export function lockfileLicences(root = DCX_ROOT): LicenceEntry[] {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
    packages?: Record<string, Record<string, unknown>>;
  };
  const out: LicenceEntry[] = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === "" || entry.link === true) continue;
    const name =
      typeof entry.name === "string" ? entry.name : path.split("node_modules/").pop();
    out.push({
      name: name ?? path,
      version: String(entry.version ?? ""),
      licence: licenceOf(entry),
      from: "lockfile",
      path,
    });
  }
  return out;
}

/** Every package.json under every `node_modules` in the workspace (root, per-package, nested),
 *  including `@scope/*`. Symlinks (workspace links) are not followed. */
export function installedLicences(root = DCX_ROOT): LicenceEntry[] {
  const out: LicenceEntry[] = [];
  const isDir = (p: string) => existsSync(p) && lstatSync(p).isDirectory();
  const readPkg = (dir: string) => {
    const file = join(dir, "package.json");
    if (!existsSync(file)) return;
    const pkg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    out.push({
      name: String(pkg.name ?? toRel(dir)),
      version: String(pkg.version ?? ""),
      licence: licenceOf(pkg),
      from: "installed",
      path: toRel(dir),
    });
    scanModules(join(dir, "node_modules"));
  };
  const scanModules = (nm: string) => {
    if (!isDir(nm)) return;
    for (const name of readdirSync(nm).sort()) {
      if (name.startsWith(".")) continue;
      const dir = join(nm, name);
      if (!isDir(dir)) continue; // symlink or file
      if (name.startsWith("@")) {
        for (const sub of readdirSync(dir).sort()) {
          if (isDir(join(dir, sub))) readPkg(join(dir, sub));
        }
      } else readPkg(dir);
    }
  };
  scanModules(join(root, "node_modules"));
  for (const group of ["packages", "projects"]) {
    const base = join(root, group);
    if (!isDir(base)) continue;
    for (const p of readdirSync(base).sort()) scanModules(join(base, p, "node_modules"));
  }
  return out;
}

/** Read `licence-allowlist.json` from this package (an array of `AllowlistEntry`). */
export function readAllowlist(
  file = new URL("../licence-allowlist.json", import.meta.url),
): AllowlistEntry[] {
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error("licence-allowlist.json must be a JSON array");
  for (const e of raw as Partial<AllowlistEntry>[]) {
    if (!e.name || !e.version || !e.reason) {
      throw new Error(`allowlist entry needs name, version and reason: ${JSON.stringify(e)}`);
    }
  }
  return raw as AllowlistEntry[];
}

/** Entries with a banned licence that the allowlist does not cover. */
export function bannedLicences(
  entries: readonly LicenceEntry[],
  allow: readonly AllowlistEntry[] = [],
): LicenceEntry[] {
  return entries.filter(
    (e) =>
      BANNED_LICENCE.test(e.licence) &&
      !allow.some((a) => a.name === e.name && (a.version === "*" || a.version === e.version)),
  );
}

/** Count of distinct packages per licence string, sorted by count then name. */
export function licenceSummary(entries: readonly LicenceEntry[]): [string, number][] {
  const seen = new Map<string, Set<string>>();
  for (const e of entries) {
    const s = seen.get(e.licence) ?? new Set<string>();
    s.add(`${e.name}@${e.version}`);
    seen.set(e.licence, s);
  }
  return [...seen]
    .map(([l, s]) => [l, s.size] as [string, number])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
