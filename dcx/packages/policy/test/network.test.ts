import { describe, expect, it } from "vitest";
import {
  formatViolations,
  NETWORK_MOCK_MARKER,
  scanNetwork,
  scanWorkspaceNetwork,
} from "../src/index.js";

const FETCH = ["fet", "ch("].join("");

describe("no network in tests", () => {
  const { scanned, violations } = scanWorkspaceNetwork();

  it("the judge backend tests are scanned and clean", () => {
    const judge = scanned.filter((f) => f.startsWith("packages/judge/test/"));
    expect(judge.some((f) => /backends/.test(f))).toBe(true);
    const bad = violations.filter((v) => v.file.startsWith("packages/judge/"));
    expect(bad, formatViolations(bad)).toEqual([]);
  });

  it("no test under dcx/packages or dcx/projects reaches the network unmocked", () => {
    expect(scanned.length).toBeGreaterThan(10);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it("detects imports and global calls, and honours the marker", () => {
    const f = "packages/x/test/a.test.ts";
    expect(scanNetwork(f, 'import fetch from "node-fetch";')).toHaveLength(1);
    expect(scanNetwork(f, 'import { request } from "undici";')).toHaveLength(1);
    expect(scanNetwork(f, 'import type { X } from "undici-types";')).toEqual([]);
    expect(scanNetwork(f, `const r = await ${FETCH}"https://x");`)).toHaveLength(1);
    expect(scanNetwork(f, `await globalThis.${FETCH}url);`)).toHaveLength(1);
    expect(scanNetwork(f, `await client.${FETCH}url);`)).toEqual([]);
    expect(scanNetwork(f, `${NETWORK_MOCK_MARKER}\nawait ${FETCH}url);`)).toEqual([]);
  });
});
