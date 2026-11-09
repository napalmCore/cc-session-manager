import { PRICE_TABLE_DATE } from "./prices.js";
import type { SessionUsage, SessionView, UsageGroup } from "./protocol.js";

export interface TokenTotals {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface UsageTotals extends TokenTotals {
  cost: number;
  /** Sessions with usage but a cost that couldn't be fully worked out. */
  leftOutOfCost: number;
  /** Sessions with no usage at all, such as one with no readable transcript. */
  noUsage: number;
  counting: boolean;
  sessions: number;
}

/** "9 November 2026", from the price table's date. */
export function priceDateLabel(date: string = PRICE_TABLE_DATE): string {
  const [year, month, day] = date.split("-").map(Number);
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${String(day)} ${months[(month ?? 1) - 1] ?? ""} ${String(year)}`;
}

export const ESTIMATE_NOTE = `Estimated cost at API list prices of ${priceDateLabel()}, covering tokens and web searches. Not what a Pro or Max plan costs.`;

export function tokenTotals(groups: UsageGroup[]): TokenTotals {
  const totals: TokenTotals = {
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
  };
  for (const group of groups) {
    totals.input += group.input;
    totals.output += group.output;
    totals.cacheWrite += group.cacheWrite5m + group.cacheWrite1h;
    totals.cacheRead += group.cacheRead;
  }
  return totals;
}

function allTokens(totals: TokenTotals): number {
  return totals.input + totals.output + totals.cacheWrite + totals.cacheRead;
}

/** "950", "12.3K", "1.04M", "2.6B". */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, unit] of units) {
    if (count >= size) {
      const value = count / size;
      const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
      return `${value.toFixed(digits)}${unit}`;
    }
  }
  return String(count);
}

/** "$0.42", "less than $0.01", "$1,234". */
export function formatCost(dollars: number): string {
  if (dollars === 0) return "$0.00";
  if (dollars < 0.01) return "less than $0.01";
  if (dollars >= 1000) {
    return `$${Math.round(dollars).toLocaleString("en-US")}`;
  }
  return `$${dollars.toFixed(2)}`;
}

function describeTokens(totals: TokenTotals): string {
  return [
    `${formatTokens(totals.input)} input`,
    `${formatTokens(totals.output)} output`,
    `${formatTokens(totals.cacheWrite)} cache write`,
    `${formatTokens(totals.cacheRead)} cache read`,
  ].join(", ");
}

/** The lines a session's details show about its usage (FR-23, FR-24). */
export function sessionUsageLines(usage: SessionUsage | undefined): string[] {
  if (!usage) return ["Token use unavailable"];
  const totals = tokenTotals(usage.groups);
  const counting = usage.counting ? " (still counting)" : "";
  const lines = [`Tokens: ${describeTokens(totals)}${counting}`];

  const all = allTokens(totals);
  const subagents = allTokens(
    tokenTotals(usage.groups.filter((group) => group.source === "subagent")),
  );
  if (subagents > 0 && all > 0) {
    const percent = Math.round((subagents / all) * 100);
    lines.push(
      percent < 1
        ? "Subagents: less than 1% of tokens"
        : `Subagents: ${String(percent)}% of tokens`,
    );
  }

  if (usage.unpriced.length > 0) {
    const models = usage.unpriced.join(", ");
    lines.push(
      usage.cost > 0
        ? `Estimated cost ${formatCost(usage.cost)}, leaving out ${models}`
        : `Cost unavailable for ${models}`,
    );
  } else {
    lines.push(`Estimated cost ${formatCost(usage.cost)}${counting}`);
  }
  return lines;
}

/** Totals for the sessions listed on the page (FR-25). */
export function usageTotals(sessions: SessionView[]): UsageTotals {
  const totals: UsageTotals = {
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    cost: 0,
    leftOutOfCost: 0,
    noUsage: 0,
    counting: false,
    sessions: sessions.length,
  };
  for (const session of sessions) {
    const usage = session.usage;
    if (!usage) {
      totals.noUsage += 1;
      continue;
    }
    const tokens = tokenTotals(usage.groups);
    totals.input += tokens.input;
    totals.output += tokens.output;
    totals.cacheWrite += tokens.cacheWrite;
    totals.cacheRead += tokens.cacheRead;
    totals.cost += usage.cost;
    if (usage.unpriced.length > 0) totals.leftOutOfCost += 1;
    if (usage.counting) totals.counting = true;
  }
  return totals;
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}

/** The summary bar's text: tokens, then cost, then what the totals leave out. */
export function totalsLines(totals: UsageTotals): string[] {
  const lines = [`Tokens for listed sessions: ${describeTokens(totals)}`];
  let cost = `Estimated cost ${formatCost(totals.cost)}`;
  if (totals.leftOutOfCost > 0) {
    cost += `, leaving out ${plural(totals.leftOutOfCost, "session")}`;
  }
  lines.push(cost);
  const notes: string[] = [];
  if (totals.noUsage > 0) {
    notes.push(
      `${plural(totals.noUsage, "session")} ${totals.noUsage === 1 ? "has" : "have"} no usage`,
    );
  }
  if (totals.counting) notes.push("still counting");
  if (notes.length > 0) lines.push(`${notes.join("; ")}.`);
  return lines;
}
