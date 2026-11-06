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
    ).toBe("api-refactor needs you: permission prompt.");
  });

  it("uses a generic name when a session has none", () => {
    expect(newAttentionMessage(new Set(), [session("a", undefined)])).toBe(
      "A session needs you: needs input.",
    );
  });

  it("only announces sessions that are new", () => {
    const existing = session("a", "one");
    const previous = attentionKeys([existing]);

    expect(newAttentionMessage(previous, [existing, session("b", "two")])).toBe(
      "two needs you: needs input.",
    );
  });

  it("announces all new sessions together", () => {
    expect(
      newAttentionMessage(new Set(), [
        session("a", "one"),
        session("b", "two", "input needed"),
      ]),
    ).toBe("one needs you: needs input. two needs you: input needed.");
  });

  it("announces a repeated ID only once", () => {
    expect(
      newAttentionMessage(new Set(), [
        session("a", "one"),
        session("a", "one"),
      ]),
    ).toBe("one needs you: needs input.");
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
    ).toBe("one needs you: input needed.");
  });
});
