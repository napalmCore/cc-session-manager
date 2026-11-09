import { describe, expect, it } from "vitest";
import type { SessionView } from "./protocol.js";
import { groupSessions, pageTitle, STALE_AFTER_MS } from "./session-groups.js";

const NOW = 1_000_000_000_000;

function session(fields: Partial<SessionView>): SessionView {
  return {
    needsAttention: false,
    attentionReason: null,
    finished: false,
    statusLabel: "busy",
    ...fields,
  };
}

const blocked = (lastActivityAt?: number, name = "blocked") =>
  session({
    name,
    state: "blocked",
    needsAttention: true,
    attentionReason: "needs input",
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
  });

describe("groupSessions", () => {
  it("places each session in one group", () => {
    const groups = groupSessions(
      [
        blocked(NOW, "attention"),
        blocked(NOW - STALE_AFTER_MS - 1, "stale"),
        session({ name: "active" }),
        session({ name: "finished", finished: true, finishedAt: NOW }),
      ],
      NOW,
    );

    expect(groups.needsYou.map((s) => s.name)).toEqual(["attention"]);
    expect(groups.stale.map((s) => s.name)).toEqual(["stale"]);
    expect(groups.active.map((s) => s.name)).toEqual(["active"]);
    expect(groups.finished.map((s) => s.name)).toEqual(["finished"]);
  });

  it("makes a blocked session stale only after the full 7 days", () => {
    expect(STALE_AFTER_MS).toBe(7 * 24 * 60 * 60 * 1000);
    const atLimit = blocked(NOW - STALE_AFTER_MS);
    const past = blocked(NOW - STALE_AFTER_MS - 1);

    expect(groupSessions([atLimit], NOW).needsYou).toHaveLength(1);
    expect(groupSessions([past], NOW).stale).toHaveLength(1);
  });

  it("never treats a session with unknown activity as stale", () => {
    expect(groupSessions([blocked()], NOW).needsYou).toHaveLength(1);
  });

  it("never treats a live open prompt as stale", () => {
    const old = NOW - STALE_AFTER_MS * 2;
    const live = [
      session({
        status: "waiting",
        needsAttention: true,
        attentionReason: "permission prompt",
        lastActivityAt: old,
      }),
      session({
        state: "blocked",
        status: "waiting",
        needsAttention: true,
        attentionReason: "permission prompt",
        lastActivityAt: old,
      }),
    ];

    const groups = groupSessions(live, NOW);

    expect(groups.needsYou).toHaveLength(2);
    expect(groups.stale).toEqual([]);
  });

  it("does not treat an old active session as stale", () => {
    const old = session({ lastActivityAt: NOW - STALE_AFTER_MS * 2 });
    expect(groupSessions([old], NOW).active).toHaveLength(1);
  });

  it("lists sessions needing attention with the longest wait first", () => {
    const groups = groupSessions(
      [blocked(NOW - 10, "newer"), blocked(NOW - 20, "older"), blocked()],
      NOW,
    );
    expect(groups.needsYou.map((s) => s.name)).toEqual([
      "older",
      "newer",
      "blocked",
    ]);
  });

  it("lists active sessions newest start first, whatever their activity (BUG-6)", () => {
    const groups = groupSessions(
      [
        session({ name: "older", startedAt: 10, lastActivityAt: NOW - 1 }),
        session({ name: "unknown" }),
        session({ name: "b", sessionId: "b", startedAt: 20 }),
        session({ name: "a", sessionId: "a", startedAt: 20 }),
        session({ name: "moved", startedAt: 25, firstStartedAt: 5 }),
      ],
      NOW,
    );
    expect(groups.active.map((s) => s.name)).toEqual([
      "a",
      "b",
      "older",
      "moved",
      "unknown",
    ]);
  });

  it("lists finished sessions with the most recently ended first", () => {
    const groups = groupSessions(
      [
        session({ name: "older", finished: true, finishedAt: NOW - 20 }),
        session({ name: "newer", finished: true, finishedAt: NOW - 10 }),
      ],
      NOW,
    );
    expect(groups.finished.map((s) => s.name)).toEqual(["newer", "older"]);
  });
});

describe("pageTitle", () => {
  it("shows the attention count", () => {
    expect(pageTitle(2)).toBe("(2) Claude Code sessions");
  });

  it("omits the count when nothing needs attention", () => {
    expect(pageTitle(0)).toBe("Claude Code sessions");
  });
});
