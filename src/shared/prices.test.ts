import { describe, expect, it } from "vitest";
import type { UsageGroup } from "./protocol.js";
import { estimateCost, groupCost, pricesFor } from "./prices.js";

const MILLION = 1_000_000;

function group(overrides: Partial<UsageGroup> = {}): UsageGroup {
  return {
    model: "claude-opus-5-5",
    speed: "standard",
    geo: "global",
    source: "main",
    longContext: false,
    input: 0,
    output: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    webSearches: 0,
    ...overrides,
  };
}

/** One million of each token type, so the cost is the sum of the row's prices. */
function million(model: string, overrides: Partial<UsageGroup> = {}) {
  return group({
    model,
    input: MILLION,
    output: MILLION,
    cacheWrite5m: MILLION,
    cacheWrite1h: MILLION,
    cacheRead: MILLION,
    ...overrides,
  });
}

describe("groupCost", () => {
  // input + 5m write + 1h write + read + output, per the pricing page on 2026-11-09.
  it.each([
    ["claude-fable-5-1", 10 + 12.5 + 20 + 0.25 + 50],
    ["claude-mythos-5-1", 10 + 12.5 + 20 + 0.25 + 50],
    ["claude-fable-5", 10 + 12.5 + 20 + 1 + 50],
    ["claude-mythos-5", 10 + 12.5 + 20 + 1 + 50],
    ["claude-opus-5-5", 4 + 5 + 8 + 0.2 + 20],
    ["claude-opus-5", 5 + 6.25 + 10 + 0.5 + 25],
    ["claude-opus-4-8", 5 + 6.25 + 10 + 0.5 + 25],
    ["claude-opus-4-7", 5 + 6.25 + 10 + 0.5 + 25],
    ["claude-opus-4-6", 5 + 6.25 + 10 + 0.5 + 25],
    ["claude-opus-4-5", 5 + 6.25 + 10 + 0.5 + 25],
    ["claude-opus-4-1", 15 + 18.75 + 30 + 1.5 + 75],
    ["claude-opus-4", 15 + 18.75 + 30 + 1.5 + 75],
    ["claude-sonnet-5-5", 2 + 2.5 + 4 + 0.1 + 10],
    ["claude-sonnet-5", 2 + 2.5 + 4 + 0.2 + 10],
    ["claude-sonnet-4-6", 3 + 3.75 + 6 + 0.3 + 15],
    ["claude-sonnet-4-5", 3 + 3.75 + 6 + 0.3 + 15],
    ["claude-sonnet-4", 3 + 3.75 + 6 + 0.3 + 15],
    ["claude-haiku-5-5", 0.1 + 0.125 + 0.2 + 0.01 + 0.5],
    ["claude-haiku-4-5", 1 + 1.25 + 2 + 0.1 + 5],
  ])("prices %s", (model, expected) => {
    expect(groupCost(million(model))).toBeCloseTo(expected, 10);
  });

  it("prices each token type separately", () => {
    expect(groupCost(group({ input: MILLION }))).toBeCloseTo(4);
    expect(groupCost(group({ output: MILLION }))).toBeCloseTo(20);
    expect(groupCost(group({ cacheWrite5m: MILLION }))).toBeCloseTo(5);
    expect(groupCost(group({ cacheWrite1h: MILLION }))).toBeCloseTo(8);
    expect(groupCost(group({ cacheRead: MILLION }))).toBeCloseTo(0.2);
  });

  it("matches IDs with a trailing date, and the -0 aliases", () => {
    expect(pricesFor("claude-sonnet-4-5-20250929")).toBe(
      pricesFor("claude-sonnet-4-5"),
    );
    expect(pricesFor("claude-opus-4-20250514")).toBe(
      pricesFor("claude-opus-4"),
    );
    expect(pricesFor("claude-sonnet-4-0")).toBe(pricesFor("claude-sonnet-4"));
  });

  it("doesn't guess at unknown models", () => {
    for (const model of [
      "claude-opus-6",
      "claude-opus-5-5-preview",
      "gpt-5",
      "toString",
      "__proto__",
      "claude-opus-5-5-2025",
    ]) {
      expect(pricesFor(model)).toBeUndefined();
      expect(groupCost(million(model))).toBeNull();
    }
  });

  it("prices Claude Haiku 5.5 prompts over 100,000 tokens higher", () => {
    expect(
      groupCost(million("claude-haiku-5-5", { longContext: true })),
    ).toBeCloseTo(0.5 + 0.625 + 1 + 0.05 + 2.5);
  });

  describe("fast mode", () => {
    it("uses fast prices, with each model's own cache multipliers", () => {
      // Opus 5.5: 8 input, 40 output, writes 1.25x and 2x, reads 0.05x the fast input.
      expect(
        groupCost(million("claude-opus-5-5", { speed: "fast" })),
      ).toBeCloseTo(8 + 10 + 16 + 0.4 + 40);
      // Opus 5 and 4.8: 10 input, 50 output, reads 0.1x.
      for (const model of ["claude-opus-5", "claude-opus-4-8"]) {
        expect(groupCost(million(model, { speed: "fast" }))).toBeCloseTo(
          10 + 12.5 + 20 + 1 + 50,
        );
      }
    });

    it("can't price fast mode on a model with no fast price", () => {
      expect(groupCost(million("claude-sonnet-5-5", { speed: "fast" }))).toBe(
        null,
      );
    });

    it("can't price an unknown speed", () => {
      expect(groupCost(million("claude-opus-5-5", { speed: "warp" }))).toBe(
        null,
      );
    });
  });

  describe("US-only routing", () => {
    it("adds 10 percent for Claude 4.6 and later", () => {
      const base = groupCost(million("claude-opus-4-6")) ?? 0;
      expect(groupCost(million("claude-opus-4-6", { geo: "us" }))).toBeCloseTo(
        base * 1.1,
      );
      const fast =
        groupCost(million("claude-opus-5-5", { speed: "fast" })) ?? 0;
      expect(
        groupCost(million("claude-opus-5-5", { speed: "fast", geo: "us" })),
      ).toBeCloseTo(fast * 1.1);
    });

    it("doesn't apply to earlier models", () => {
      for (const model of [
        "claude-opus-4-5",
        "claude-sonnet-4-5",
        "claude-haiku-4-5",
      ]) {
        expect(groupCost(million(model, { geo: "us" }))).toBe(
          groupCost(million(model)),
        );
      }
    });
  });

  it("adds $10 per 1,000 web searches, outside the routing multiplier", () => {
    expect(groupCost(group({ webSearches: 1000 }))).toBeCloseTo(10);
    expect(groupCost(group({ webSearches: 1000, geo: "us" }))).toBeCloseTo(10);
  });
});

describe("estimateCost", () => {
  it("adds up priced groups and names the models it leaves out", () => {
    const estimate = estimateCost([
      group({ input: MILLION }),
      group({ input: MILLION, source: "subagent" }),
      group({ model: "claude-new", input: MILLION }),
      group({ model: "claude-new", output: MILLION }),
    ]);
    expect(estimate.cost).toBeCloseTo(8);
    expect(estimate.unpriced).toEqual(["claude-new"]);
  });

  it("is zero with nothing left out for no usage", () => {
    expect(estimateCost([])).toEqual({ cost: 0, unpriced: [] });
  });
});
