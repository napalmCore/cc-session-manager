import { describe, expect, it } from "vitest";
import { toSessionView } from "../server/rules.js";
import {
  folderName,
  initialNotifyState,
  nextEvents,
  notificationContent,
  type NotifyEvent,
  type NotifyState,
} from "./notifications.js";
import type { Session, SessionView, Snapshot } from "./protocol.js";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const view = (fields: Session, extra: Partial<SessionView> = {}) => ({
  ...toSessionView({ cwd: "C:\\repos\\alpha", ...fields }),
  lastActivityAt: NOW - 60_000,
  ...extra,
});

const ok = (
  sessions: SessionView[],
  extra: Partial<Snapshot> = {},
): Snapshot => ({
  sessions,
  error: null,
  warnings: [],
  ...extra,
});
const failed = (failedPolls: number): Snapshot => ({
  sessions: [],
  error: "Couldn't read sessions.",
  warnings: [],
  failedPolls,
});

const busy = (sessionId = "s1") =>
  view({ sessionId, kind: "interactive", status: "busy" });
const waiting = (reason?: string, sessionId = "s1") =>
  view({
    sessionId,
    kind: "interactive",
    status: "waiting",
    ...(reason === undefined ? {} : { waitingFor: reason }),
  });
const background = (state: string, id = "abcd1234") =>
  view({ id, kind: "background", state });

/** Runs snapshots through in order and returns the events from the last one. */
function run(...snapshots: Snapshot[]): NotifyEvent[] {
  let state: NotifyState = initialNotifyState;
  let events: NotifyEvent[] = [];
  for (const snapshot of snapshots) {
    const result = nextEvents(state, snapshot, NOW);
    state = result.state;
    events = result.events;
  }
  return events;
}

describe("nextEvents", () => {
  it("only sets the starting point on the first successful snapshot", () => {
    expect(run(ok([waiting("permission prompt")]))).toEqual([]);
  });

  it("notifies when a session starts needing the user, with the folder and reason", () => {
    expect(run(ok([busy()]), ok([waiting("permission prompt")]))).toEqual([
      {
        kind: "needs-you",
        keys: ["s1"],
        folder: "alpha",
        reason: "permission prompt",
      },
    ]);
  });

  it("notifies for a session that first appears already needing the user", () => {
    expect(run(ok([]), ok([waiting("plan approval")]))).toHaveLength(1);
  });

  it("notifies when the specific reason changes", () => {
    expect(
      run(
        ok([busy()]),
        ok([waiting("permission prompt")]),
        ok([waiting("plan approval")]),
      ),
    ).toHaveLength(1);
  });

  it("doesn't notify when the reason falls back to the generic label", () => {
    expect(run(ok([waiting("permission prompt")]), ok([waiting()]))).toEqual(
      [],
    );
  });

  it("doesn't notify again while a session keeps needing the user", () => {
    expect(
      run(
        ok([busy()]),
        ok([waiting("permission prompt")]),
        ok([waiting("permission prompt")]),
      ),
    ).toEqual([]);
  });

  it("notifies again when a session comes back to needing the user", () => {
    expect(
      run(
        ok([waiting("permission prompt")]),
        ok([busy()]),
        ok([waiting("permission prompt")]),
      ),
    ).toHaveLength(1);
  });

  it("ignores Stale sessions", () => {
    const stale = view(
      { id: "abcd1234", kind: "background", state: "blocked" },
      { lastActivityAt: NOW - 30 * DAY },
    );
    expect(run(ok([background("working")]), ok([stale]))).toEqual([]);
  });

  it("notifies when a background session finishes or is stopped", () => {
    expect(run(ok([background("working")]), ok([background("done")]))).toEqual([
      { kind: "finished", keys: ["abcd1234"], folder: "alpha" },
    ]);
    expect(
      run(ok([background("working")]), ok([background("stopped")])),
    ).toHaveLength(1);
  });

  it("notifies a failure only as a failure", () => {
    expect(
      run(ok([background("working")]), ok([background("failed")])),
    ).toEqual([{ kind: "failed", keys: ["abcd1234"], folder: "alpha" }]);
  });

  it("doesn't notify for a session that was already finished, or an interactive one ending", () => {
    expect(run(ok([background("done")]), ok([background("done")]))).toEqual([]);
    expect(run(ok([]), ok([background("done")]))).toEqual([]);
    const ended = view(
      { sessionId: "s1", kind: "interactive", state: "done" },
      { finished: true },
    );
    expect(run(ok([busy()]), ok([ended]))).toEqual([]);
  });

  it("doesn't notify for the user's own actions from the dashboard", () => {
    expect(
      run(
        ok([background("working")]),
        ok([background("stopped")], { ownActions: ["abcd1234"] }),
      ),
    ).toEqual([]);
    expect(
      run(
        ok([busy()]),
        ok([waiting("permission prompt")], { ownActions: ["s1"] }),
      ),
    ).toEqual([]);
  });

  it("compares with the last successful snapshot across failures", () => {
    expect(
      run(ok([busy()]), failed(1), ok([waiting("permission prompt")])),
    ).toHaveLength(1);
    expect(run(ok([busy()]), failed(1), ok([busy()]))).toEqual([]);
  });

  it("says it can't read sessions after three failed polls, once until it recovers", () => {
    expect(run(ok([]), failed(1))).toEqual([]);
    expect(run(ok([]), failed(1), failed(2))).toEqual([]);
    expect(run(ok([]), failed(1), failed(2), failed(3))).toEqual([
      { kind: "read-failure" },
    ]);
    expect(run(ok([]), failed(3), failed(4))).toEqual([]);
    expect(
      run(ok([]), failed(3), ok([]), failed(1), failed(2), failed(3)),
    ).toEqual([{ kind: "read-failure" }]);
  });

  it("doesn't say it can't read sessions before any success", () => {
    expect(run(failed(1), failed(2), failed(3))).toEqual([]);
  });
});

describe("a background row whose sessionId appears between polls", () => {
  const SESSION = "33333333-3333-4333-8333-333333333333";
  const row = (state: string, withSessionId: boolean, waitingFor?: string) =>
    view({
      id: "abcd1234",
      ...(withSessionId ? { sessionId: SESSION } : {}),
      kind: "background",
      state,
      ...(waitingFor === undefined ? {} : { status: "waiting", waitingFor }),
    });

  it("doesn't notify again while it keeps needing the user", () => {
    expect(
      run(
        ok([row("working", false)]),
        ok([row("blocked", false, "permission prompt")]),
        ok([row("blocked", true, "permission prompt")]),
      ),
    ).toEqual([]);
  });

  it("still notifies when it finishes", () => {
    expect(run(ok([row("working", false)]), ok([row("done", true)]))).toEqual([
      { kind: "finished", keys: ["abcd1234", SESSION], folder: "alpha" },
    ]);
  });

  it("still notifies when it fails", () => {
    expect(run(ok([row("working", false)]), ok([row("failed", true)]))).toEqual(
      [{ kind: "failed", keys: ["abcd1234", SESSION], folder: "alpha" }],
    );
  });
});

describe("notificationContent", () => {
  it("shows the folder and reason, never a session name", () => {
    const content = notificationContent(
      [
        {
          kind: "needs-you",
          keys: ["s1"],
          folder: "alpha",
          reason: "permission prompt",
        },
      ],
      7,
    );
    expect(content).toEqual({
      title: "Claude Code session",
      body: "alpha: permission prompt",
      tag: "cc-session-manager-7",
      keys: ["s1"],
    });
  });

  it("combines the events in one snapshot", () => {
    const content = notificationContent(
      [
        { kind: "finished", keys: ["a"], folder: "alpha" },
        { kind: "failed", keys: ["b"], folder: "beta" },
      ],
      8,
    );
    expect(content?.title).toBe("2 Claude Code session updates");
    expect(content?.body).toBe("alpha: finished\nbeta: failed");
    expect(content?.keys).toEqual(["a", "b"]);
  });

  it("says only that sessions can't be read, and highlights nothing", () => {
    const content = notificationContent([{ kind: "read-failure" }], 9);
    expect(content?.title).toBe("Can't read sessions");
    expect(content?.keys).toEqual([]);
  });

  it("includes the server's run, so a restarted server doesn't reuse a tag", () => {
    expect(
      notificationContent([{ kind: "read-failure" }], 3, "a1b2c3d4")?.tag,
    ).toBe("cc-session-manager-a1b2c3d4-3");
  });

  it("is null with no events", () => {
    expect(notificationContent([], 1)).toBeNull();
  });
});

describe("folderName", () => {
  it.each([
    ["C:\\repos\\alpha", "alpha"],
    ["C:\\repos\\alpha\\", "alpha"],
    ["/home/me/beta", "beta"],
    [undefined, "Unknown project"],
    ["", "Unknown project"],
  ])("names %s as %s", (cwd, name) => {
    expect(folderName(cwd)).toBe(name);
  });
});
