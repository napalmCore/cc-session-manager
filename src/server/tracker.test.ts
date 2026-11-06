import { describe, expect, it, vi } from "vitest";
import type { Session } from "../shared/protocol.js";
import { toSessionView } from "./rules.js";
import type { SessionStore } from "./store.js";
import { createSessionTracker, RETENTION_MS } from "./tracker.js";

const interactive: Session = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  pid: 100,
  kind: "interactive",
  cwd: "C:/work",
  startedAt: 1000,
  status: "busy",
  name: "demo",
};
const working: Session = {
  id: "bg1",
  sessionId: "22222222-2222-4222-8222-222222222222",
  kind: "background",
  cwd: "C:/work",
  startedAt: 1000,
  state: "working",
};
const done: Session = { ...working, state: "done" };

function setup(saved: Parameters<SessionStore["save"]>[0] = []) {
  let now = 50_000;
  const store: SessionStore = {
    load: () => ({ records: saved, notice: null, needsRewrite: false }),
    save: vi.fn(() => null),
  };
  const tracker = createSessionTracker({ store, now: () => now });
  return {
    store,
    update: (...sessions: Session[]) =>
      tracker.update(sessions.map(toSessionView)),
    advance: (ms: number) => {
      now += ms;
    },
    time: () => now,
  };
}

describe("interactive sessions", () => {
  it("lists a session as finished once it disappears", () => {
    const { update, time } = setup();
    update(interactive);

    const { sessions } = update();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.finished).toBe(true);
    expect(sessions[0]?.finishedAt).toBe(time());
    expect(sessions[0]?.name).toBe("demo");
  });

  it("clears live details from a finished session", () => {
    const { update } = setup();
    update({ ...interactive, status: "waiting", waitingFor: "input needed" });

    const [session] = update().sessions;

    expect(session?.needsAttention).toBe(false);
    expect(session?.attentionReason).toBeNull();
    expect(session?.status).toBeUndefined();
    expect(session?.waitingFor).toBeUndefined();
    expect(session?.pid).toBeUndefined();
    expect(session?.statusLabel).toBe("finished");
  });

  it("finishes a session with no pid while another listed session also has none", () => {
    const { update } = setup();
    const noPid: Session = { ...interactive };
    delete noPid.pid;
    update(noPid, working);

    const { sessions } = update(working);

    expect(sessions.map((session) => session.finished).sort()).toEqual([
      false,
      true,
    ]);
  });

  it("does not list sessions it never saw running", () => {
    expect(setup().update().sessions).toEqual([]);
  });

  it("removes a finished session after 24 hours", () => {
    const { update, advance } = setup();
    update(interactive);
    update();

    advance(RETENTION_MS - 1);
    expect(update().sessions).toHaveLength(1);

    advance(1);
    expect(update().sessions).toEqual([]);
  });

  it("shows a resumed session as live again", () => {
    const { update } = setup();
    update(interactive);
    update();

    const { sessions } = update(interactive);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.finished).toBe(false);
  });

  it("does not finish a session whose process continues under a new session ID", () => {
    const { update } = setup();
    update(interactive);

    const { sessions } = update({
      ...interactive,
      sessionId: "33333333-3333-4333-8333-333333333333",
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.finished).toBe(false);
  });

  it("does not finish a session that moved to the background", () => {
    const { update } = setup();
    update(interactive);

    const { sessions } = update({
      ...working,
      sessionId: interactive.sessionId as string,
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.finished).toBe(false);
  });
});

describe("background sessions", () => {
  it("records when a finished state was first seen, and keeps that time", () => {
    const { update, advance, time } = setup();
    const first = time();
    update(done);

    advance(5000);
    const { sessions } = update(done);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.finishedAt).toBe(first);
  });

  it("hides a session after 24 hours even though the CLI keeps listing it", () => {
    const { update, advance } = setup();
    update(done);

    advance(RETENTION_MS);
    expect(update(done).sessions).toEqual([]);

    advance(RETENTION_MS);
    expect(update(done).sessions).toEqual([]);
  });

  it("forgets a hidden session once the CLI stops listing it", () => {
    const { update, advance, store } = setup();
    update(done);
    advance(RETENTION_MS);
    update(done);

    update();

    expect(store.save).toHaveBeenLastCalledWith([]);
  });

  it("removes a finished session the user deleted", () => {
    const { update } = setup();
    update(done);
    expect(update().sessions).toEqual([]);
  });

  it("does not list a running session that disappears as finished", () => {
    const { update } = setup();
    update(working);
    expect(update().sessions).toEqual([]);
  });

  it("restarts the clock when a session finishes again", () => {
    const { update, advance, time } = setup();
    update(done);
    advance(1000);
    update(working);
    advance(1000);

    const { sessions } = update(done);

    expect(sessions[0]?.finishedAt).toBe(time());
  });
});

describe("persistence", () => {
  it("shows saved sessions after a restart, keeping their end time", () => {
    const { update } = setup([
      {
        ...toSessionView(interactive),
        finished: true,
        statusLabel: "finished",
        finishedAt: 40_000,
      },
    ]);

    const { sessions } = update();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.finishedAt).toBe(40_000);
  });

  it("saves only when something changed", () => {
    const { update, store } = setup();
    update(interactive);
    update(interactive);
    expect(store.save).not.toHaveBeenCalled();

    update();
    update();
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it("does not save running sessions", () => {
    const { update, store } = setup();
    update(interactive, working);
    expect(store.save).not.toHaveBeenCalled();
  });

  it("reports a store problem and keeps working", () => {
    const store: SessionStore = {
      load: () => ({
        records: [],
        notice: "load notice",
        needsRewrite: false,
      }),
      save: () => "save problem",
    };
    const tracker = createSessionTracker({ store, now: () => 1 });

    tracker.update([toSessionView(done)]);
    const result = tracker.update([toSessionView(done)]);

    expect(result.sessions).toHaveLength(1);
    expect(result.warnings).toEqual(["load notice", "save problem"]);
  });
});

describe("sessions without an identity", () => {
  it("still shows them while they are listed", () => {
    const { update } = setup();
    expect(update({ kind: "interactive" }).sessions).toHaveLength(1);
    expect(update().sessions).toEqual([]);
  });
});
