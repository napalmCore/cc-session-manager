import type { UsageGroup } from "./protocol.js";

/** The day the prices below were read from the source (FR-24). */
export const PRICE_TABLE_DATE = "2026-11-09";
export const PRICE_SOURCE =
  "https://platform.claude.com/docs/en/about-claude/pricing";

/** US dollars per million tokens. */
interface Prices {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

interface ModelPrices extends Prices {
  /** Whether `inference_geo: "us"` adds 10 percent, which applies to Claude 4.6 and later. */
  usRouting: boolean;
  /** Cache reads as a share of the input price, which fast mode keeps. */
  readShare: number;
  fast?: { input: number; output: number };
  /** Claude Haiku 5.5 prompts over 100,000 tokens. */
  longContext?: Prices;
}

const PER_SEARCH = 10 / 1000;
const US_ROUTING = 1.1;

function row(
  input: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
  cacheRead: number,
  output: number,
  extra: Partial<ModelPrices> & { usRouting: boolean },
): ModelPrices {
  return {
    input,
    cacheWrite5m,
    cacheWrite1h,
    cacheRead,
    output,
    readShare: cacheRead / input,
    ...extra,
  };
}

const fable51 = row(10, 12.5, 20, 0.25, 50, { usRouting: true });
const fable5 = row(10, 12.5, 20, 1, 50, { usRouting: true });
const opus55 = row(4, 5, 8, 0.2, 20, {
  usRouting: true,
  fast: { input: 8, output: 40 },
});
const opus5Fast = row(5, 6.25, 10, 0.5, 25, {
  usRouting: true,
  fast: { input: 10, output: 50 },
});
const opus46 = row(5, 6.25, 10, 0.5, 25, { usRouting: true });
const opus45 = row(5, 6.25, 10, 0.5, 25, { usRouting: false });
const opus4 = row(15, 18.75, 30, 1.5, 75, { usRouting: false });
const sonnet55 = row(2, 2.5, 4, 0.1, 10, { usRouting: true });
const sonnet5 = row(2, 2.5, 4, 0.2, 10, { usRouting: true });
const sonnet46 = row(3, 3.75, 6, 0.3, 15, { usRouting: true });
const sonnet4 = row(3, 3.75, 6, 0.3, 15, { usRouting: false });
const haiku55 = row(0.1, 0.125, 0.2, 0.01, 0.5, {
  usRouting: true,
  longContext: {
    input: 0.5,
    cacheWrite5m: 0.625,
    cacheWrite1h: 1,
    cacheRead: 0.05,
    output: 2.5,
  },
});
const haiku45 = row(1, 1.25, 2, 0.1, 5, { usRouting: false });

/** API list prices from {@link PRICE_SOURCE} on {@link PRICE_TABLE_DATE}. */
const MODELS = new Map<string, ModelPrices>(
  Object.entries({
    "claude-fable-5-1": fable51,
    "claude-mythos-5-1": fable51,
    "claude-fable-5": fable5,
    "claude-mythos-5": fable5,
    "claude-opus-5-5": opus55,
    "claude-opus-5": opus5Fast,
    "claude-opus-4-8": opus5Fast,
    "claude-opus-4-7": opus46,
    "claude-opus-4-6": opus46,
    "claude-opus-4-5": opus45,
    "claude-opus-4-1": opus4,
    "claude-opus-4": opus4,
    "claude-opus-4-0": opus4,
    "claude-sonnet-5-5": sonnet55,
    "claude-sonnet-5": sonnet5,
    "claude-sonnet-4-6": sonnet46,
    "claude-sonnet-4-5": sonnet4,
    "claude-sonnet-4": sonnet4,
    "claude-sonnet-4-0": sonnet4,
    "claude-haiku-5-5": haiku55,
    "claude-haiku-4-5": haiku45,
  }),
);

/** A model ID matches exactly, or with a trailing date such as `-20250929`. */
export function pricesFor(model: string): ModelPrices | undefined {
  return MODELS.get(model) ?? MODELS.get(model.replace(/-\d{8}$/, ""));
}

/** The estimated cost of one usage group in US dollars, or null when it can't be priced. */
export function groupCost(group: UsageGroup): number | null {
  const model = pricesFor(group.model);
  if (!model) return null;

  let prices: Prices = group.longContext ? (model.longContext ?? model) : model;
  if (group.speed === "fast") {
    if (!model.fast) return null;
    const input = model.fast.input;
    prices = {
      input,
      cacheWrite5m: input * 1.25,
      cacheWrite1h: input * 2,
      cacheRead: input * model.readShare,
      output: model.fast.output,
    };
  } else if (group.speed !== "standard") {
    return null;
  }

  const tokens =
    group.input * prices.input +
    group.cacheWrite5m * prices.cacheWrite5m +
    group.cacheWrite1h * prices.cacheWrite1h +
    group.cacheRead * prices.cacheRead +
    group.output * prices.output;
  const routing = group.geo === "us" && model.usRouting ? US_ROUTING : 1;
  return (tokens / 1_000_000) * routing + group.webSearches * PER_SEARCH;
}

export interface CostEstimate {
  /** The cost of every group that could be priced. */
  cost: number;
  /** Models whose groups couldn't be priced, so the cost leaves them out. */
  unpriced: string[];
}

export function estimateCost(groups: UsageGroup[]): CostEstimate {
  let cost = 0;
  const unpriced = new Set<string>();
  for (const group of groups) {
    const value = groupCost(group);
    if (value === null) unpriced.add(group.model);
    else cost += value;
  }
  return { cost, unpriced: [...unpriced] };
}
