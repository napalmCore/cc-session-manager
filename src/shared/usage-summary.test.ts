import { describe, expect, it } from "vitest";
import type { SessionUsage, SessionView, UsageGroup } from "./protocol.js";
import {
  ESTIMATE_NOTE,
  formatCost,
  formatTokens,
  priceDateLabel,
  sessionUsageLines,
  totalsLines,
  usageTotals,
} from "./usage-summary.js";

function group(overrides: Partial<UsageGroup> = {}): UsageGroup {
  return {
    model: "claude-opus-5-5",
    speed: "standard",
    geo: "global",
    source: "main",
    longContext: false,
    input: 100,
    output: 200,
    cacheWrite5m: 300,
    cacheWrite1h: 400,
    cacheRead: 1000,
    webSearches: 0,
    ...overrides,
  };
}

function usage(overrides: Partial<SessionUsage> = {}): SessionUsage {
  return {
    groups: [group()],
    counting: false,
    cost: 1.5,
    unpriced: [],
    ...overrides,
  };
}

function session(value?: SessionUsage): SessionView {
  const view: SessionView = {
    needsAttention: false,
    attentionReason: null,
    finished: false,
    statusLabel: "working",
  };
  if (value) view.usage = value;
  return view;
}

describe("formatting", () => {
  it.each([
    [0, "0"],
    [950, "950"],
    [1000, "1.00K"],
    [12_345, "12.3K"],
    [123_456, "123K"],
    [1_043_430, "1.04M"],
    [260_774_567, "261M"],
    [2_600_000_000, "2.60B"],
    [99_999, "100K"],
    [999_499, "999K"],
    [999_500, "1.00M"],
    [999_999, "1.00M"],
    [99_950_000, "100M"],
    [9_999, "10.0K"],
  ])("shows %d tokens as %s", (count, text) => {
    expect(formatTokens(count)).toBe(text);
  });

  it.each([
    [0, "$0.00"],
    [0.004, "less than $0.01"],
    [0.42, "$0.42"],
    [12.345, "$12.35"],
    [1234.4, "$1,234"],
    [999.996, "$1,000"],
    [999.99, "$999.99"],
  ])("shows $%d as %s", (dollars, text) => {
    expect(formatCost(dollars)).toBe(text);
  });

  it("names the price table's date and what the estimate isn't", () => {
    expect(priceDateLabel("2026-11-09")).toBe("9 November 2026");
    expect(ESTIMATE_NOTE).toContain("9 November 2026");
    expect(ESTIMATE_NOTE).toContain("Not what a Pro or Max plan costs");
  });
});

describe("sessionUsageLines", () => {
  it("shows tokens by type and the estimated cost", () => {
    expect(sessionUsageLines(usage())).toEqual([
      "Tokens: 100 input, 200 output, 700 cache write, 1.00K cache read",
      "Estimated cost $1.50",
    ]);
  });

  it("shows the subagents' share of tokens", () => {
    const lines = sessionUsageLines(
      usage({ groups: [group(), group({ source: "subagent" })] }),
    );
    expect(lines).toContain("Subagents: 50% of tokens");
  });

  it("says less than 1% for a tiny subagent share", () => {
    const lines = sessionUsageLines(
      usage({
        groups: [
          group({ cacheRead: 10_000_000 }),
          group({ source: "subagent", cacheRead: 0 }),
        ],
      }),
    );
    expect(lines).toContain("Subagents: less than 1% of tokens");
  });

  it("says when it's still counting", () => {
    const lines = sessionUsageLines(usage({ counting: true }));
    expect(lines[0]).toMatch(/\(still counting\)$/);
    expect(lines[1]).toMatch(/\(still counting\)$/);
  });

  it("shows tokens but no cost for an unknown model", () => {
    expect(
      sessionUsageLines(
        usage({
          groups: [group({ model: "claude-new" })],
          cost: 0,
          unpriced: ["claude-new"],
        }),
      )[1],
    ).toBe("Cost unavailable for claude-new");
  });

  it("treats a $0 priced part as priced, and says when it's still counting", () => {
    const lines = sessionUsageLines(
      usage({
        groups: [
          group({
            input: 0,
            output: 0,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
            cacheRead: 0,
          }),
          group({ model: "claude-new" }),
        ],
        cost: 0,
        unpriced: ["claude-new"],
        counting: true,
      }),
    );
    expect(lines.at(-1)).toBe(
      "Estimated cost $0.00, leaving out claude-new (still counting)",
    );
    expect(
      sessionUsageLines(
        usage({
          groups: [group({ model: "claude-new" })],
          cost: 0,
          unpriced: ["claude-new"],
          counting: true,
        }),
      ).at(-1),
    ).toBe("Cost unavailable for claude-new (still counting)");
  });

  it("says more than 99% when the main transcript has a few tokens", () => {
    const lines = sessionUsageLines(
      usage({
        groups: [
          group({
            input: 1,
            output: 0,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
            cacheRead: 0,
          }),
          group({ source: "subagent", cacheRead: 10_000_000 }),
        ],
      }),
    );
    expect(lines).toContain("Subagents: more than 99% of tokens");
  });

  it("names a model a partly priced cost leaves out", () => {
    expect(
      sessionUsageLines(usage({ cost: 2, unpriced: ["claude-new"] }))[1],
    ).toBe("Estimated cost $2.00, leaving out claude-new");
  });

  it("says when there's no usage", () => {
    expect(sessionUsageLines(undefined)).toEqual(["Token use unavailable"]);
  });
});

describe("usage totals", () => {
  it("adds up listed sessions", () => {
    const totals = usageTotals([session(usage()), session(usage({ cost: 2 }))]);
    expect(totals).toMatchObject({
      input: 200,
      output: 400,
      cacheWrite: 1400,
      cacheRead: 2000,
      cost: 3.5,
      leftOutOfCost: 0,
      noUsage: 0,
      counting: false,
    });
    expect(totalsLines(totals)).toEqual([
      "Tokens for listed sessions: 200 input, 400 output, 1.40K cache write, 2.00K cache read",
      "Estimated cost $3.50",
    ]);
  });

  it("adds tokens for unpriced models but leaves their sessions out of the cost", () => {
    const totals = usageTotals([
      session(usage()),
      session(usage({ cost: 0, unpriced: ["claude-new"] })),
    ]);
    expect(totals.input).toBe(200);
    expect(totalsLines(totals)[1]).toBe(
      "Estimated cost $1.50, leaving out 1 session",
    );
  });

  it("says how many sessions have no usage, and when it's still counting", () => {
    const totals = usageTotals([
      session(),
      session(),
      session(usage({ counting: true })),
    ]);
    expect(totalsLines(totals)[2]).toBe(
      "2 sessions have no usage; still counting.",
    );
    expect(totalsLines(usageTotals([session()]))[2]).toBe(
      "1 session has no usage.",
    );
  });
});
