import { describe, expect, it } from "vitest";
import { DEFAULT_PORT } from "./constants.js";

describe("DEFAULT_PORT", () => {
  it("matches the port in decision 0008", () => {
    expect(DEFAULT_PORT).toBe(4780);
  });
});
