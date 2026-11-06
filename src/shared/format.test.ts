import { describe, expect, it } from "vitest";
import { formatDuration } from "./format.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatDuration", () => {
  it.each([
    [0, "under 1m"],
    [59 * SECOND, "under 1m"],
    [MINUTE, "1m"],
    [59 * MINUTE, "59m"],
    [HOUR, "1h 0m"],
    [2 * HOUR + 5 * MINUTE, "2h 5m"],
    [DAY, "1d 0h"],
    [3 * DAY + 4 * HOUR + 30 * MINUTE, "3d 4h"],
  ])("formats %d ms as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it("treats a negative duration from clock differences as zero", () => {
    expect(formatDuration(-5000)).toBe("under 1m");
  });
});
