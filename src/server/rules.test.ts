import { describe, expect, it } from "vitest";
import { toSessionView } from "./rules.js";

describe("toSessionView attention", () => {
  it("flags a waiting session and uses its reason", () => {
    const view = toSessionView({
      kind: "interactive",
      status: "waiting",
      waitingFor: "permission prompt",
    });
    expect(view.needsAttention).toBe(true);
    expect(view.attentionReason).toBe("permission prompt");
  });

  it("flags a blocked session with a generic reason when none is given", () => {
    const view = toSessionView({ kind: "background", state: "blocked" });
    expect(view.needsAttention).toBe(true);
    expect(view.attentionReason).toBe("needs input");
  });

  it.each([
    [{ kind: "interactive", status: "busy" }],
    [{ kind: "interactive", status: "idle" }],
    [{ kind: "background", state: "working" }],
    [{ kind: "background", state: "done" }],
    [{ kind: "background", state: "failed" }],
    [{}],
  ])("does not flag %j", (session) => {
    const view = toSessionView(session);
    expect(view.needsAttention).toBe(false);
    expect(view.attentionReason).toBeNull();
  });
});

describe("toSessionView lifecycle", () => {
  it.each(["done", "failed", "stopped"])(
    "treats a background session in state %s as finished",
    (state) => {
      expect(toSessionView({ kind: "background", state }).finished).toBe(true);
    },
  );

  it.each([
    [{ kind: "background", state: "working" }],
    [{ kind: "background", state: "blocked" }],
    [{ kind: "interactive", status: "idle" }],
  ])("treats %j as active", (session) => {
    expect(toSessionView(session).finished).toBe(false);
  });

  it("treats a done session with an open prompt as needing attention, not finished", () => {
    const view = toSessionView({
      kind: "background",
      state: "done",
      status: "waiting",
    });
    expect(view.needsAttention).toBe(true);
    expect(view.finished).toBe(false);
  });
});

describe("toSessionView status label", () => {
  it("prefers state, then status, then unknown", () => {
    expect(
      toSessionView({ state: "working", status: "busy" }).statusLabel,
    ).toBe("working");
    expect(toSessionView({ status: "idle" }).statusLabel).toBe("idle");
    expect(toSessionView({}).statusLabel).toBe("unknown");
  });

  it("keeps the source session fields", () => {
    const view = toSessionView({ cwd: "C:/work", name: "demo" });
    expect(view.cwd).toBe("C:/work");
    expect(view.name).toBe("demo");
  });
});
