import { assertPinned } from "@dcx/core";
import { describe, expect, it } from "vitest";
import { formatViolations, scanPinning, scanWorkspacePinning } from "../src/index.js";

const ALIAS = ["jev", "latest"].join("-");

describe("pinning: the jev alias appears only in rejection logic", () => {
  it("no config, fixture, script or default under dcx/ names the alias", () => {
    const { scanned, violations } = scanWorkspacePinning();
    expect(scanned).toBeGreaterThan(20);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it("core still rejects the alias", () => {
    expect(() => assertPinned(ALIAS)).toThrow(/alias/);
    expect(() => assertPinned("jev-1.13.0")).not.toThrow();
  });

  it("flags JSON, shell and TS defaults but not regexes, pin checks or comments", () => {
    expect(scanPinning("fixtures/q.json", `{"model": "${ALIAS}"}`)).toHaveLength(1);
    expect(scanPinning("projects/p/run.sh", `MODEL=${ALIAS} tsx run.ts`)).toHaveLength(1);
    expect(scanPinning("projects/p/run.sh", `# never use ${ALIAS}`)).toEqual([]);
    expect(
      scanPinning("packages/x/src/cfg.ts", `export const MODEL = "${ALIAS}";`),
    ).toHaveLength(1);
    expect(
      scanPinning("packages/x/src/lint.ts", `if (/\\b${ALIAS}\\b/i.test(v)) bad();`),
    ).toEqual([]);
    expect(scanPinning("packages/x/src/a.ts", `assertPinned("${ALIAS}");`)).toEqual([]);
    expect(scanPinning("packages/x/src/a.ts", `/** rejects \`${ALIAS}\` */`)).toEqual([]);
    expect(
      scanPinning("packages/x/test/a.test.ts", `run({ model: "${ALIAS}" });`),
    ).toHaveLength(1);
    const asserting = `expect(() => f("${ALIAS}")).toThrow();`;
    expect(scanPinning("packages/x/test/a.test.ts", asserting)).toEqual([]);
    expect(scanPinning("packages/x/test/fixtures/rejected-pin.json", `"${ALIAS}"`)).toEqual([]);
  });
});
