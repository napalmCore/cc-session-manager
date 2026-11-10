import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLEAR_MS, createAnnouncer, MIN_SHOWN_MS } from "./announcer.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const shown: string[] = [];
  const announcer = createAnnouncer((text) => shown.push(text));
  return { shown, announcer };
}

describe("announcements (BUG-16)", () => {
  it("announces two updates 50 ms apart", () => {
    const { shown, announcer } = setup();
    announcer.announce("First.");
    vi.advanceTimersByTime(50);
    announcer.announce("Second.");
    vi.advanceTimersByTime(CLEAR_MS);
    expect(shown.filter((text) => text !== "")).toEqual(["First. Second."]);
  });

  it("keeps each announcement for at least a second before the next replaces it", () => {
    const { shown, announcer } = setup();
    announcer.announce("First.");
    vi.advanceTimersByTime(CLEAR_MS);
    expect(shown.at(-1)).toBe("First.");
    announcer.announce("Second.");
    vi.advanceTimersByTime(MIN_SHOWN_MS - 1);
    expect(shown.at(-1)).toBe("First.");
    vi.advanceTimersByTime(1 + CLEAR_MS);
    expect(shown.filter((text) => text !== "")).toEqual(["First.", "Second."]);
  });

  it("clears the region before each one, so the same text is read again", () => {
    const { shown, announcer } = setup();
    announcer.announce("Same.");
    vi.advanceTimersByTime(MIN_SHOWN_MS + CLEAR_MS);
    announcer.announce("Same.");
    vi.advanceTimersByTime(CLEAR_MS);
    expect(shown).toEqual(["", "Same.", "", "Same."]);
  });

  it("an empty message never cuts a shown or queued one short, but clears it after its second", () => {
    const { shown, announcer } = setup();
    announcer.announce("Kept.");
    announcer.announce("");
    vi.advanceTimersByTime(CLEAR_MS);
    announcer.announce("");
    expect(shown.at(-1)).toBe("Kept.");
    vi.advanceTimersByTime(MIN_SHOWN_MS - 1);
    expect(shown.at(-1)).toBe("Kept.");
    vi.advanceTimersByTime(1);
    expect(shown.at(-1)).toBe("");
  });

  it("a waiting clear gives way to a new message", () => {
    const { shown, announcer } = setup();
    announcer.announce("First.");
    vi.advanceTimersByTime(CLEAR_MS);
    announcer.announce("");
    announcer.announce("Second.");
    vi.advanceTimersByTime(MIN_SHOWN_MS + CLEAR_MS);
    expect(shown.filter((text) => text !== "")).toEqual(["First.", "Second."]);
    expect(shown.at(-1)).toBe("Second.");
  });
});
