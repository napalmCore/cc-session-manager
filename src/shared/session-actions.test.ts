import { describe, expect, it } from "vitest";
import { toSessionView } from "../server/rules.js";
import type { Session } from "./protocol.js";
import {
  actionContext,
  actionKey,
  availableActions,
  readReply,
  sessionLabel,
  type ActionContext,
} from "./session-actions.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const view = (fields: Session) =>
  toSessionView({ cwd: "C:\\repos\\alpha", ...fields });
const open: ActionContext = { blocked: null, protectedKeys: new Set() };

const background = (state = "working") =>
  view({ id: "abcd1234", sessionId: SESSION_ID, kind: "background", state });
const live = (pid?: number) =>
  view({
    sessionId: SESSION_ID,
    kind: "interactive",
    status: "busy",
    ...(pid === undefined ? {} : { pid }),
  });
const ended = () =>
  ({
    ...view({ sessionId: SESSION_ID, kind: "interactive", status: "idle" }),
    finished: true,
  }) as const;

describe("availableActions", () => {
  it("offers Open, Stop, and Delete for a background session", () => {
    expect(availableActions(background(), open)).toEqual([
      "open",
      "stop",
      "delete",
    ]);
    expect(availableActions(background("done"), open)).toEqual([
      "open",
      "stop",
      "delete",
    ]);
  });

  it("offers only End for a live interactive session with a process ID, and no Open (FR-20)", () => {
    expect(availableActions(live(4321), open)).toEqual(["end"]);
    expect(availableActions(live(), open)).toEqual([]);
    expect(availableActions({ ...live(4321), id: "abcd1234" }, open)).toEqual([
      "end",
    ]);
  });

  it("offers Resume for a finished interactive session", () => {
    expect(availableActions(ended(), open)).toEqual(["resume"]);
  });

  it("offers nothing for a session with neither ID", () => {
    expect(
      availableActions(view({ kind: "background", state: "working" }), open),
    ).toEqual([]);
  });

  it("leaves out Stop, Delete, and End when actions are turned off for every session", () => {
    const blocked: ActionContext = {
      blocked: "Off.",
      protectedKeys: new Set(),
    };
    expect(availableActions(background(), blocked)).toEqual(["open"]);
    expect(availableActions(live(4321), blocked)).toEqual([]);
    expect(availableActions(ended(), blocked)).toEqual(["resume"]);
  });

  it("leaves them out for a session that started the tool, by either of its IDs (FR-22)", () => {
    const bySession: ActionContext = {
      blocked: null,
      protectedKeys: new Set([SESSION_ID]),
    };
    expect(availableActions(live(4321), bySession)).toEqual([]);
    expect(availableActions(background(), bySession)).toEqual(["open"]);
    const byShortId: ActionContext = {
      blocked: null,
      protectedKeys: new Set(["abcd1234"]),
    };
    expect(availableActions(background(), byShortId)).toEqual(["open"]);
  });
});

describe("actionContext", () => {
  it("reads the snapshot's blocked reason and protected sessions", () => {
    const context = actionContext({
      sessions: [],
      error: null,
      warnings: [],
      actionsBlocked: "Off.",
      protectedSessions: [SESSION_ID],
    });
    expect(context.blocked).toBe("Off.");
    expect(context.protectedKeys.has(SESSION_ID)).toBe(true);
    expect(actionContext(null)).toEqual({
      blocked: null,
      protectedKeys: new Set(),
    });
  });
});

describe("actionKey", () => {
  it("uses the short id, or else the session ID", () => {
    expect(actionKey(background())).toBe("abcd1234");
    expect(actionKey(live(1))).toBe(SESSION_ID);
    expect(actionKey(view({ kind: "background" }))).toBeUndefined();
  });

  it("doesn't send a malformed short id", () => {
    expect(actionKey(view({ id: "not-an-id", sessionId: SESSION_ID }))).toBe(
      SESSION_ID,
    );
  });
});

describe("sessionLabel (FR-19)", () => {
  const time = (value: number) => `T${String(value)}`;

  it("names a session by its name, with its folder", () => {
    expect(sessionLabel(view({ name: "fix login" }), time)).toBe(
      '"fix login" in alpha',
    );
  });

  it("names an unnamed session by folder, kind, and start time", () => {
    expect(
      sessionLabel(
        view({ kind: "background", startedAt: 5, id: "abcd1234" }),
        time,
      ),
    ).toBe("Unnamed background session in alpha, started T5");
    expect(sessionLabel(view({ name: "" }), time)).toBe(
      "Unnamed session in alpha, start time unknown",
    );
  });
});

describe("readReply", () => {
  it("passes the route's outcome and message through", () => {
    expect(readReply({ outcome: "kept", message: "Kept." })).toEqual({
      outcome: "kept",
      message: "Kept.",
    });
  });

  it.each([
    ["nothing", null],
    ["an unknown outcome", { outcome: "exploded", message: "x" }],
    ["an empty message", { outcome: "succeeded", message: "" }],
    ["a message that isn't text", { outcome: "succeeded", message: 1 }],
  ])("treats %s as unknown (FR-18)", (_label, body) => {
    expect(readReply(body).outcome).toBe("unknown");
  });
});
