import { describe, expect, it, vi } from "vitest";
import type {
  FinishedSession,
  Session,
  SessionUsage,
  SessionView,
} from "../shared/protocol.js";
import { toSessionView } from "./rules.js";
import type { SessionStore } from "./store.js";
import {
  createSessionTracker,
  enrichWithFinished,
  READ_AFTER_FINISH_MS,
  RETENTION_MS,
} from "./tracker.js";

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

describe("reading finished sessions (FR-26, BUG-27)", () => {
  const usage = (input: number, counting = false): SessionUsage => ({
    groups: [
      {
        model: "claude-opus-5-5",
        speed: "standard",
        geo: "global",
        source: "main",
        longContext: false,
        input,
        output: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
        webSearches: 0,
      },
    ],
    counting,
    cost: 0,
    unpriced: [],
  });

  function reading(saved: FinishedSession[] = []) {
    let now = 50_000;
    const store: SessionStore = {
      load: () => ({ records: saved, notice: null, needsRewrite: false }),
      save: vi.fn(() => null),
    };
    const tracker = createSessionTracker({ store, now: () => now });
    // What each session's transcript holds; a missing entry can't be read.
    const transcripts = new Map<string, Partial<SessionView>>();
    const asked: string[][] = [];
    const reader = {
      enrich: vi.fn((current: SessionView[]) => {
        asked.push(current.map((session) => session.sessionId ?? ""));
        return Promise.resolve({
          sessions: current.map((session) => {
            const found = transcripts.get(session.sessionId ?? "");
            return found ? { ...session, ...found } : session;
          }),
          warnings: [],
        });
      }),
      forget: vi.fn(),
    };
    const enrich = enrichWithFinished(tracker, reader);
    return {
      store,
      reader,
      transcripts,
      asked,
      poll: async (...sessions: Session[]) => {
        const enriched = await enrich(sessions.map(toSessionView));
        return tracker.update(enriched.sessions);
      },
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  const id = interactive.sessionId ?? "";

  it("keeps reading an ended session for 30 seconds, so late lines show", async () => {
    const { poll, transcripts, advance, reader, store } = reading();
    transcripts.set(id, { model: "first", usage: usage(1) });
    await poll(interactive);
    await poll();

    transcripts.set(id, { model: "late", usage: usage(2) });
    advance(3_000);
    let { sessions } = await poll();
    expect(sessions[0]?.model).toBe("late");
    expect(sessions[0]?.usage?.groups[0]?.input).toBe(2);
    expect(vi.mocked(store.save).mock.lastCall?.[0][0]?.usage).toEqual(
      usage(2),
    );

    advance(READ_AFTER_FINISH_MS);
    transcripts.set(id, { model: "too late", usage: usage(3) });
    ({ sessions } = await poll());
    expect(sessions[0]?.model).toBe("late");
    expect(reader.forget).toHaveBeenCalledWith(id);
  });

  it("keeps reading a finished session until it's fully counted", async () => {
    const { poll, transcripts, advance, asked } = reading();
    transcripts.set(id, { usage: usage(1, true) });
    await poll(interactive);
    await poll();
    advance(READ_AFTER_FINISH_MS * 2);

    transcripts.set(id, { usage: usage(5, true) });
    await poll();
    transcripts.set(id, { usage: usage(9) });
    const { sessions } = await poll();
    expect(sessions[0]?.usage).toEqual(usage(9));

    await poll();
    expect(asked.at(-1)).toEqual([]);
  });

  it("stops trying a transcript that can't be read after the window", async () => {
    const { poll, transcripts, advance, asked } = reading();
    transcripts.set(id, { usage: usage(1, true) });
    await poll(interactive);
    await poll();
    transcripts.delete(id);
    advance(READ_AFTER_FINISH_MS);

    const { sessions } = await poll();
    expect(sessions[0]?.usage).toEqual(usage(1, true));
    await poll();
    expect(asked.at(-1)).toEqual([]);
  });

  it("stops reading a listed background session, and keeps what it read", async () => {
    const { poll, transcripts, advance, asked } = reading();
    const backgroundId = done.sessionId ?? "";
    transcripts.set(backgroundId, { model: "m", usage: usage(4) });
    await poll(done);
    advance(READ_AFTER_FINISH_MS);
    transcripts.set(backgroundId, { model: "later", usage: usage(8) });

    const { sessions } = await poll(done);
    expect(asked.at(-1)).toEqual([]);
    expect(sessions[0]?.model).toBe("m");
    expect(sessions[0]?.usage).toEqual(usage(4));
  });

  it("uses saved usage after a restart, without reading again", async () => {
    const saved: FinishedSession = {
      ...toSessionView(done),
      finishedAt: 1_000,
      model: "saved",
      usage: usage(7),
    };
    const { poll, transcripts, asked } = reading([saved]);
    transcripts.set(done.sessionId ?? "", { usage: usage(99) });

    const { sessions } = await poll(done);
    expect(asked.at(-1)).toEqual([]);
    expect(sessions[0]?.usage).toEqual(usage(7));
    expect(sessions[0]?.model).toBe("saved");
  });

  it("reads a saved session again after a restart if it was still counting", async () => {
    const saved: FinishedSession = {
      ...toSessionView(interactive),
      finished: true,
      statusLabel: "finished",
      finishedAt: 1_000,
      usage: usage(7, true),
    };
    const { poll, transcripts } = reading([saved]);
    transcripts.set(id, { usage: usage(20) });

    const { sessions } = await poll();
    expect(sessions[0]?.usage).toEqual(usage(20));
  });

  it("never tells the reader to forget a live session", async () => {
    const { poll, reader, advance } = reading();
    await poll(interactive);
    await poll();
    advance(READ_AFTER_FINISH_MS);
    await poll(interactive);
    expect(reader.forget).not.toHaveBeenCalled();
  });
});
