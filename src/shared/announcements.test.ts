import { describe, expect, it } from "vitest";
import { attentionKeys, newAttentionMessage } from "./announcements.js";
import type { SessionView } from "./protocol.js";

function session(
  sessionId: string,
  name: string | undefined,
  attentionReason = "needs input",
): SessionView {
  return {
    sessionId,
    ...(name === undefined ? {} : { name }),
    needsAttention: true,
    attentionReason,
    finished: false,
    statusLabel: "blocked",
  };
}

describe("newAttentionMessage", () => {
  it("is empty when nothing new needs attention", () => {
    const current = [session("a", "one")];
    expect(newAttentionMessage(attentionKeys(current), current)).toBe("");
    expect(newAttentionMessage(new Set(), [])).toBe("");
  });

  it("names a new session and its reason", () => {
    expect(
      newAttentionMessage(new Set(), [
        session("a", "api-refactor", "permission prompt"),
      ]),
    ).toBe("api-refactor: Waiting on a permission prompt.");
  });

  it("announces a second session with no ID and no name separately (BUG-14)", () => {
    const anonymous = (cwd: string): SessionView => ({
      cwd,
      kind: "interactive",
      startedAt: 1,
      needsAttention: true,
      attentionReason: "needs input",
      finished: false,
      statusLabel: "waiting",
    });
    const first = [anonymous("C:/one")];
    const both = [...first, anonymous("C:/two")];

    expect(newAttentionMessage(attentionKeys(first), both)).toBe(
      "A session: Needs you in Claude Code.",
    );
  });

  it("uses a generic name when a session has none", () => {
    expect(newAttentionMessage(new Set(), [session("a", undefined)])).toBe(
      "A session: Needs you in Claude Code.",
    );
  });

  it("only announces sessions that are new", () => {
    const existing = session("a", "one");
    const previous = attentionKeys([existing]);

    expect(newAttentionMessage(previous, [existing, session("b", "two")])).toBe(
      "two: Needs you in Claude Code.",
    );
  });

  it("announces all new sessions together", () => {
    expect(
      newAttentionMessage(new Set(), [
        session("a", "one"),
        session("b", "two", "input needed"),
      ]),
    ).toBe("one: Needs you in Claude Code. two: Waiting on your answer.");
  });

  it("announces a repeated ID only once", () => {
    expect(
      newAttentionMessage(new Set(), [
        session("a", "one"),
        session("a", "one"),
      ]),
    ).toBe("one: Needs you in Claude Code.");
  });

  it("gives the same keys whatever order sessions are in", () => {
    const one = session("a", "one");
    const two = session("b", "two");
    expect([...attentionKeys([one, two])]).toEqual([
      ...attentionKeys([two, one]),
    ]);
  });

  it("announces again when an existing session's reason changes", () => {
    const previous = attentionKeys([session("a", "one", "permission prompt")]);

    expect(
      newAttentionMessage(previous, [session("a", "one", "input needed")]),
    ).toBe("one: Waiting on your answer.");
  });
});
