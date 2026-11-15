import { describe, expect, it } from "vitest";
import { toSessionView } from "../server/rules.js";
import type { LeftoverOffer, Session, SessionView } from "./protocol.js";
import {
  canFork,
  canSend,
  actionContext,
  actionKey,
  availableActions,
  canEndLeftovers,
  leftoverOffer,
  programLines,
  readReply,
  sessionLabel,
  unlistedOffers,
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

  it("doesn't offer Resume once the session's folder has gone (BUG-31)", () => {
    expect(
      availableActions(ended(), {
        ...open,
        missingFolderKeys: new Set([SESSION_ID]),
      }),
    ).toEqual([]);
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
      missingFolderKeys: new Set(),
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

describe("leftover programs (FR-27)", () => {
  const offer = (keys: string[], count = 1): LeftoverOffer => ({
    key: keys[0] ?? "",
    keys,
    deleted: false,
    session: background(),
    programs: Array.from({ length: Math.min(count, 50) }, (_, index) => ({
      pid: 100 + index,
      name: index === 1 ? "" : `p${String(index)}.exe`,
    })),
    count,
  });

  it("matches an offer to its row by any of the session's keys", () => {
    const byId = offer(["abcd1234"]);
    const bySessionId = offer([SESSION_ID]);
    expect(leftoverOffer(background(), [byId])).toBe(byId);
    expect(leftoverOffer(background(), [bySessionId])).toBe(bySessionId);
    expect(leftoverOffer(live(1), [byId])).toBeUndefined();
  });

  it("finds offers whose session is no longer listed", () => {
    const listed = offer(["abcd1234"]);
    const gone = offer(["dead0001"]);
    expect(unlistedOffers([background()], [listed, gone])).toEqual([gone]);
  });

  it("lists programs by name and process ID, up to the limit, then how many more", () => {
    expect(programLines(offer(["a"], 12), 10)).toEqual([
      "p0.exe, process 100",
      "Unknown program, process 101",
      "p2.exe, process 102",
      "p3.exe, process 103",
      "p4.exe, process 104",
      "p5.exe, process 105",
      "p6.exe, process 106",
      "p7.exe, process 107",
      "p8.exe, process 108",
      "p9.exe, process 109",
      "and 2 more",
    ]);
    // More run than the server sent.
    expect(programLines(offer(["a"], 60), 50).at(-1)).toBe("and 10 more");
    expect(programLines(offer(["a"], 1), 10)).toEqual(["p0.exe, process 100"]);
  });

  it("offers ending them only when actions are allowed and the session isn't protected", () => {
    expect(canEndLeftovers(background(), open)).toBe(true);
    expect(
      canEndLeftovers(background(), { ...open, blocked: "Turned off." }),
    ).toBe(false);
    expect(
      canEndLeftovers(background(), {
        blocked: null,
        protectedKeys: new Set([SESSION_ID]),
      }),
    ).toBe(false);
  });
});

describe("Fork on the list (FR-33)", () => {
  const view = (fields: Partial<SessionView>): SessionView => ({
    needsAttention: false,
    attentionReason: null,
    finished: false,
    statusLabel: "busy",
    ...fields,
  });
  const ID = "11111111-1111-4111-8111-111111111111";

  it("needs a session ID, works on protected sessions, and not where the folder has gone", () => {
    const context = actionContext({
      sessions: [],
      error: null,
      warnings: [],
      protectedSessions: [ID],
      actionsBlocked: "Actions are turned off.",
    });
    expect(canFork(view({ sessionId: ID }), context)).toBe(true);
    expect(canFork(view({ id: "abcd1234" }), context)).toBe(false);
    const gone = actionContext({
      sessions: [],
      error: null,
      warnings: [],
      missingFolders: [ID],
    });
    expect(canFork(view({ sessionId: ID, finished: true }), gone)).toBe(false);
  });
});

describe("Send on the list (FR-37)", () => {
  const ID = "11111111-1111-4111-8111-111111111111";
  const parked = (fields: Partial<Session> = {}) =>
    toSessionView({
      id: "cafe0001",
      sessionId: ID,
      kind: "background",
      state: "done",
      cwd: "C:\\work",
      ...fields,
    });
  const context = (fields: Partial<Parameters<typeof actionContext>[0]> = {}) =>
    actionContext({ sessions: [], error: null, warnings: [], ...fields });

  it("is offered on a background session with no process, unless actions are off, it's protected, or its folder has gone", () => {
    expect(canSend(parked(), context())).toBe(true);
    expect(canSend(parked({ state: "failed" }), context())).toBe(true);
    expect(canSend(parked({ pid: 3 }), context())).toBe(false);
    expect(
      canSend(parked(), context({ actionsBlocked: "Actions are turned off." })),
    ).toBe(false);
    expect(canSend(parked(), context({ protectedSessions: [ID] }))).toBe(false);
    expect(canSend(parked(), context({ missingFolders: [ID] }))).toBe(false);
  });
});
