import type { DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CalibratorMethod,
  type CalibratorParams,
  calibrate,
  calibrateProbs,
  interpolateKnots,
  openWarehouse,
  type WarehouseHandle,
} from "../src/index.js";

let wh: WarehouseHandle;
let conn: DuckDBConnection;
beforeAll(async () => {
  wh = await openWarehouse(":memory:");
  conn = wh.conn;
});
afterAll(() => wh.close());

async function sqlCalibrate(m: CalibratorMethod | null, params: CalibratorParams, p: number) {
  const r = await conn.runAndReadAll("SELECT calibrate($1, $2::JSON, $3::DOUBLE) AS v", [
    m,
    JSON.stringify(params),
    p,
  ]);
  return r.getRowObjectsJson()[0]?.v as number | null;
}

const PS = [0, 1e-9, 0.01, 0.2, 0.5, 0.5000001, 0.73, 0.99, 0.999999, 1];
const CASES: Array<[CalibratorMethod | null, CalibratorParams]> = [
  [null, {}],
  ["identity", {}],
  ["temperature", { T: 1.7 }],
  ["temperature", { T: 0.6 }],
  ["platt", { a: 1.3, b: -0.4 }],
  [
    "isotonic",
    {
      knots: [
        [0, 0.02],
        [0.4, 0.1],
        [0.4, 0.3],
        [0.9, 0.7],
        [1, 0.97],
      ],
    },
  ],
  ["histogram", { knots: [] }],
];

describe("TS calibrate() matches the DuckDB macro", () => {
  for (const [m, params] of CASES) {
    it(`${m ?? "null"} ${JSON.stringify(params)}`, async () => {
      for (const p of PS) {
        const ts = calibrate(m, params, p);
        const sql = await sqlCalibrate(m, params, p);
        expect(sql, `p=${p}`).not.toBeNull();
        expect(Math.abs((sql as number) - (ts as number)), `p=${p}`).toBeLessThan(1e-9);
      }
    });
  }

  it("multiclass temperature matches calibrate_probs", async () => {
    const probs = { a: 0.7, b: 0.2, c: 0.1 };
    for (const ans of ["a", "b", "c"]) {
      const ts = calibrateProbs("temperature", { T: 2 }, probs, ans, probs[ans as "a"]);
      const r = await conn.runAndReadAll(
        `SELECT calibrate_probs('temperature', '{"T":2}'::JSON, MAP {'a': 0.7, 'b': 0.2, 'c': 0.1}, $1, NULL) AS v`,
        [ans],
      );
      expect(r.getRowObjectsJson()[0]?.v as number).toBeCloseTo(ts as number, 12);
    }
    // Temperature never changes the argmax.
    const pa = calibrateProbs("temperature", { T: 3 }, probs, "a", 0.7) as number;
    const pb = calibrateProbs("temperature", { T: 3 }, probs, "b", 0.2) as number;
    expect(pa).toBeGreaterThan(pb);
  });
});

describe("interpolateKnots", () => {
  const k: Array<[number, number]> = [
    [0.2, 0.1],
    [0.6, 0.5],
    [0.6, 0.8],
    [1, 1],
  ];
  it("clamps, interpolates, and takes the right-hand value on a step", () => {
    expect(interpolateKnots(k, 0)).toBe(0.1);
    expect(interpolateKnots(k, 0.4)).toBeCloseTo(0.3, 12);
    expect(interpolateKnots(k, 0.6)).toBe(0.8);
    expect(interpolateKnots(k, 1)).toBe(1);
    expect(interpolateKnots([], 0.42)).toBe(0.42);
  });
  it("null p stays null", () => {
    expect(calibrate("platt", { a: 1, b: 0 }, null)).toBeNull();
  });
});
