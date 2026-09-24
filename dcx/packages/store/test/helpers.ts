import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRow, StepRow } from "@dcx/core";

/** A temp directory removed by the returned cleanup. */
export function tempDir(prefix: string): {
  dir: string;
  path: (f: string) => string;
  rm: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    path: (f) => join(dir, f),
    rm: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export const run = (run_id: string, extra: Partial<RunRow> = {}): RunRow => ({
  run_id,
  workflow: "screen",
  workflow_v: 1,
  mode: "active",
  status: "pending",
  created_at: 1_000,
  ...extra,
});

export const step = (
  run_id: string,
  step_no: number,
  extra: Partial<StepRow> = {},
): StepRow => ({
  run_id,
  step_no,
  kind: "judge",
  name: `s${step_no}`,
  status: "running",
  mode: "active",
  started_at: 2_000,
  ...extra,
});
