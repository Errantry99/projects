import { describe, expect, it } from "vitest";
import {
  BANNED_LICENCE,
  bannedLicences,
  installedLicences,
  type LicenceEntry,
  licenceOf,
  licenceSummary,
  lockfileLicences,
  readAllowlist,
  unknownLicences,
} from "../src/index.js";

const fmt = (es: readonly LicenceEntry[]) =>
  es.map((e) => `${e.name}@${e.version}: ${e.licence} (${e.from} ${e.path})`).join("\n");

describe("licences: no AGPL, SSPL, Elastic/ELv2 or BUSL dependency", () => {
  const allow = readAllowlist();
  const lock = lockfileLicences();
  const installed = installedLicences();

  it("reports every licence found", () => {
    expect(lock.length).toBeGreaterThan(20);
    expect(installed.length).toBeGreaterThan(20);
    const lines = licenceSummary([...lock, ...installed]).map(([l, n]) => `  ${n}\t${l}`);
    console.info(`Licences (distinct name@version per licence):\n${lines.join("\n")}`);
  });

  it("the lockfile has no banned licence outside the allowlist", () => {
    const bad = bannedLicences(lock, allow);
    expect(bad, fmt(bad)).toEqual([]);
  });

  it("no installed package.json has a banned licence outside the allowlist", () => {
    const bad = bannedLicences(installed, allow);
    expect(bad, fmt(bad)).toEqual([]);
  });

  it("every dependency names a checkable licence (no `SEE LICENSE IN`, UNLICENSED or none)", () => {
    const bad = unknownLicences([...lock, ...installed], allow);
    expect(bad, fmt(bad)).toEqual([]);
    const e = (licence: string): LicenceEntry => ({
      name: "x",
      version: "1",
      licence,
      from: "installed",
      path: "",
    });
    for (const l of ["SEE LICENSE IN LICENSE.txt", "UNLICENSED", "(none)"])
      expect(unknownLicences([e(l)]), l).toHaveLength(1);
    expect(unknownLicences([e("MIT")])).toEqual([]);
  });

  it("matches banned ids, reads every licence field shape, and honours the allowlist", () => {
    for (const l of ["AGPL-3.0-only", "SSPL-1.0", "Elastic-2.0", "ELv2", "BUSL-1.1"]) {
      expect(BANNED_LICENCE.test(l), l).toBe(true);
    }
    for (const l of ["MIT", "Apache-2.0", "MPL-2.0", "LGPL-3.0", "GPL-3.0", "ISC"]) {
      expect(BANNED_LICENCE.test(l), l).toBe(false);
    }
    expect(licenceOf({ license: { type: "MIT" } })).toBe("MIT");
    expect(licenceOf({ licenses: [{ type: "MIT" }, "Apache-2.0"] })).toBe("MIT OR Apache-2.0");
    expect(licenceOf({})).toBe("(none)");
    const e: LicenceEntry = {
      name: "x",
      version: "1.0.0",
      licence: "AGPL-3.0",
      from: "lockfile",
      path: "",
    };
    expect(bannedLicences([e])).toHaveLength(1);
    expect(
      bannedLicences([e], [{ name: "x", version: "*", reason: "notebooks only" }]),
    ).toEqual([]);
    expect(bannedLicences([e], [{ name: "x", version: "2.0.0", reason: "r" }])).toHaveLength(1);
  });
});
