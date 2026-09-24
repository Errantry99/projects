import { SCHEMA_VERSION } from "@dcx/core";
import { describe, expect, it } from "vitest";
import * as mod from "../src/index.js";

describe("@dcx/eval", () => {
  it("loads and resolves @dcx/core", () => {
    expect(typeof mod).toBe("object");
    expect(SCHEMA_VERSION).toBe(1);
  });
});
