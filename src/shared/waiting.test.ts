import { describe, expect, it } from "vitest";
import { waitingLabel } from "./waiting.js";

describe("waiting labels (FR-38)", () => {
  it("names permission prompts and questions, and anything else plainly", () => {
    expect(waitingLabel("permission prompt")).toBe(
      "Waiting on a permission prompt",
    );
    expect(waitingLabel("input needed")).toBe("Waiting on your answer");
    for (const other of [
      "sandbox request",
      "worker request",
      "dialog open",
      "something new",
      "needs input",
      null,
      undefined,
    ]) {
      expect(waitingLabel(other)).toBe("Needs you in Claude Code");
    }
  });
});
