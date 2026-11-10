import { describe, expect, it, vi } from "vitest";
import type { SessionView } from "../shared/protocol.js";
import {
  createActionTracker,
  FORCE_END_WINDOW_MS,
  FRESHNESS_MS,
  NOT_RECORDED,
  OWN_ACTION_MS,
  type ActionExecutors,
  type ActionResult,
  type LeftoverHooks,
  type ListingState,
} from "./actions.js";
import type { LeftoverRecord } from "./leftovers-helper.js";
import { toSessionView } from "./rules.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const NOW = 1_000_000;

const background = (fields: Partial<SessionView> = {}): SessionView => ({
  ...toSessionView({
    id: "abcd1234",
    sessionId: SESSION_ID,
    kind: "background",
    state: "working",
    cwd: "C:\\work",
  }),
  ...fields,
});
const interactive = (fields: Partial<SessionView> = {}): SessionView => ({
  ...toSessionView({
    sessionId: SESSION_ID,
    kind: "interactive",
    status: "busy",
    pid: 100,
    cwd: "C:\\work",
  }),
  ...fields,
});
const finishedInteractive = (): SessionView => ({
  ...toSessionView({
    sessionId: SESSION_ID,
    kind: "interactive",
    cwd: "C:\\work",
  }),
  finished: true,
  statusLabel: "finished",
  finishedAt: NOW - 1000,
});

function setup(options: {
  listing: SessionView[];
  fresh?: SessionView[];
  state?: Partial<ListingState>;
  executors?: ActionExecutors;
  leftovers?: LeftoverHooks;
  isProtected?: (session: SessionView) => boolean | string;
}) {
  let now = NOW;
  const executors: ActionExecutors = options.executors ?? {
    open: vi.fn(() =>
      Promise.resolve({
        outcome: "started" as const,
        message: "Terminal started.",
      }),
    ),
    resume: vi.fn(() =>
      Promise.resolve({
        outcome: "started" as const,
        message: "Terminal started.",
      }),
    ),
    stop: vi.fn(() =>
      Promise.resolve({ outcome: "succeeded" as const, message: "Stopped." }),
    ),
    delete: vi.fn(() =>
      Promise.resolve({ outcome: "succeeded" as const, message: "Deleted." }),
    ),
    end: vi.fn(() =>
      Promise.resolve({
        outcome: "not-closed" as const,
        message: "Still running.",
        closeRecord: { pid: 100, processStartMs: 5 },
      }),
    ),
    forceEnd: vi.fn(() =>
      Promise.resolve({ outcome: "succeeded" as const, message: "Ended." }),
    ),
  };
  const fresh = vi.fn(() => Promise.resolve(options.fresh ?? options.listing));
  const tracker = createActionTracker({
    listing: () => ({
      sessions: options.listing,
      lastSuccessAt: now - 1000,
      lastPollFailed: false,
      ...options.state,
    }),
    freshListing: fresh,
    executors,
    isProtected: options.isProtected ?? (() => false),
    ...(options.leftovers === undefined
      ? {}
      : { leftovers: options.leftovers }),
    now: () => now,
  });
  return {
    tracker,
    executors,
    fresh,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("validation", () => {
  it.each([
    ["an unknown action", { action: "format", key: "abcd1234" }],
    ["a key that isn't an ID", { action: "stop", key: "abcd123;" }],
    ["a path as a key", { action: "resume", key: "../../x" }],
  ])("refuses %s", async (_label, request) => {
    const { tracker } = setup({ listing: [background()] });
    const result = await tracker.handle(request as never);
    expect(result.outcome).toBe("refused");
  });

  it("refuses a session that isn't in the listing", async () => {
    const { tracker, executors } = setup({ listing: [] });
    const result = await tracker.handle({ action: "stop", key: "abcd1234" });
    expect(result.outcome).toBe("refused");
    expect(executors.stop).not.toHaveBeenCalled();
  });

  it("is unavailable when no executor exists for the action", async () => {
    const { tracker } = setup({ listing: [background()], executors: {} });
    const result = await tracker.handle({ action: "stop", key: "abcd1234" });
    expect(result.outcome).toBe("unavailable");
  });
});

describe("freshness (C-9)", () => {
  it.each(["stop", "delete"] as const)(
    "blocks %s after a failed poll",
    async (action) => {
      const { tracker, executors } = setup({
        listing: [background()],
        state: { lastPollFailed: true },
      });
      expect((await tracker.handle({ action, key: "abcd1234" })).outcome).toBe(
        "refused",
      );
      expect(executors[action]).not.toHaveBeenCalled();
    },
  );

  it("blocks a destructive action on a listing older than the limit", async () => {
    const { tracker, executors } = setup({
      listing: [background()],
      state: { lastSuccessAt: NOW - FRESHNESS_MS - 1 },
    });
    expect(
      (await tracker.handle({ action: "stop", key: "abcd1234" })).outcome,
    ).toBe("refused");
    expect(executors.stop).not.toHaveBeenCalled();
  });

  it("still allows Open on a stale listing", async () => {
    const { tracker, executors } = setup({
      listing: [background()],
      state: { lastPollFailed: true },
    });
    expect(
      (await tracker.handle({ action: "open", key: "abcd1234" })).outcome,
    ).toBe("started");
    expect(executors.open).toHaveBeenCalled();
  });
});

describe("recheck against a fresh listing", () => {
  it("allows a status change that still permits the action", async () => {
    const { tracker, executors } = setup({
      listing: [interactive({ status: "busy" })],
      fresh: [interactive({ status: "idle" })],
    });
    await tracker.handle({ action: "end", key: SESSION_ID });
    expect(executors.end).toHaveBeenCalled();
  });

  it.each([
    ["the process changed", interactive({ pid: 999 })],
    ["the kind changed", background()],
  ])("refuses when %s", async (_label, freshSession) => {
    const { tracker, executors } = setup({
      listing: [interactive()],
      fresh: [freshSession],
    });
    expect(
      (await tracker.handle({ action: "end", key: SESSION_ID })).outcome,
    ).toBe("refused");
    expect(executors.end).not.toHaveBeenCalled();
  });

  it("refuses when the session has gone", async () => {
    const { tracker, executors } = setup({
      listing: [background()],
      fresh: [],
    });
    expect(
      (await tracker.handle({ action: "stop", key: "abcd1234" })).outcome,
    ).toBe("refused");
    expect(executors.stop).not.toHaveBeenCalled();
  });

  it("refuses End for an interactive session without a process", async () => {
    const noPid = interactive();
    delete noPid.pid;
    const { tracker } = setup({ listing: [noPid] });
    expect(
      (await tracker.handle({ action: "end", key: SESSION_ID })).outcome,
    ).toBe("refused");
  });

  it("refuses Stop on an interactive session", async () => {
    const { tracker } = setup({ listing: [interactive()] });
    expect(
      (await tracker.handle({ action: "stop", key: SESSION_ID })).outcome,
    ).toBe("refused");
  });

  it("treats the server's recheck as unknown when the fresh listing fails", async () => {
    const { tracker, fresh, executors } = setup({ listing: [background()] });
    fresh.mockRejectedValueOnce(new Error("failed"));
    expect(
      (await tracker.handle({ action: "stop", key: "abcd1234" })).outcome,
    ).toBe("unknown");
    expect(executors.stop).not.toHaveBeenCalled();
  });
});

describe("Resume", () => {
  it("resumes a finished interactive session that isn't live", async () => {
    const { tracker, executors } = setup({
      listing: [finishedInteractive()],
      fresh: [],
    });
    expect(
      (await tracker.handle({ action: "resume", key: SESSION_ID })).outcome,
    ).toBe("started");
    expect(executors.resume).toHaveBeenCalled();
  });

  it("refuses when the session is live again", async () => {
    const { tracker, executors } = setup({
      listing: [finishedInteractive()],
      fresh: [interactive()],
    });
    expect(
      (await tracker.handle({ action: "resume", key: SESSION_ID })).outcome,
    ).toBe("refused");
    expect(executors.resume).not.toHaveBeenCalled();
  });

  it("refuses a session that isn't a finished interactive one", async () => {
    const { tracker } = setup({ listing: [interactive()] });
    expect(
      (await tracker.handle({ action: "resume", key: SESSION_ID })).outcome,
    ).toBe("refused");
  });
});

describe("one action per session (NFR-10)", () => {
  it("refuses a second action while one is running", async () => {
    let release: () => void = () => undefined;
    const slow = vi.fn(
      () =>
        new Promise<{ outcome: "succeeded"; message: string }>((resolve) => {
          release = () => {
            resolve({ outcome: "succeeded", message: "Stopped." });
          };
        }),
    );
    const { tracker } = setup({
      listing: [background()],
      executors: { stop: slow, delete: slow },
    });

    const first = tracker.handle({ action: "stop", key: "abcd1234" });
    await vi.waitFor(() => {
      expect(slow).toHaveBeenCalledTimes(1);
    });
    // Settle within 200 ms either way, so a regression fails here rather than by timing out.
    const second = await Promise.race([
      tracker.handle({ action: "delete", key: SESSION_ID }),
      new Promise<{ outcome: string }>((resolve) =>
        setTimeout(() => {
          resolve({ outcome: "still-running" });
        }, 200),
      ),
    ]);
    expect(second.outcome).toBe("refused");

    release();
    expect((await first).outcome).toBe("succeeded");
  });

  it("allows the next action once the first finishes", async () => {
    const { tracker, executors } = setup({ listing: [background()] });
    await tracker.handle({ action: "stop", key: "abcd1234" });
    await tracker.handle({ action: "stop", key: "abcd1234" });
    expect(executors.stop).toHaveBeenCalledTimes(2);
  });

  it("releases the lock when an executor throws, and reports unknown", async () => {
    const failing = vi.fn(() => Promise.reject(new Error("boom")));
    const { tracker } = setup({
      listing: [background()],
      executors: { stop: failing },
    });
    expect(
      (await tracker.handle({ action: "stop", key: "abcd1234" })).outcome,
    ).toBe("unknown");
    expect(
      (await tracker.handle({ action: "stop", key: "abcd1234" })).outcome,
    ).toBe("unknown");
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe("Force end precondition (NFR-10)", () => {
  it("refuses Force end without a normal close first", async () => {
    const { tracker, executors } = setup({ listing: [interactive()] });
    expect(
      (await tracker.handle({ action: "forceEnd", key: SESSION_ID })).outcome,
    ).toBe("refused");
    expect(executors.forceEnd).not.toHaveBeenCalled();
  });

  it("allows Force end after a normal close of the same process", async () => {
    const { tracker, executors } = setup({ listing: [interactive()] });
    await tracker.handle({ action: "end", key: SESSION_ID });
    expect(
      (await tracker.handle({ action: "forceEnd", key: SESSION_ID })).outcome,
    ).toBe("succeeded");
    expect(executors.forceEnd).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID }),
      { pid: 100, processStartMs: 5 },
    );
  });

  it("refuses Force end once the window has passed", async () => {
    const { tracker, advance } = setup({ listing: [interactive()] });
    await tracker.handle({ action: "end", key: SESSION_ID });
    advance(FORCE_END_WINDOW_MS + 1);
    expect(
      (await tracker.handle({ action: "forceEnd", key: SESSION_ID })).outcome,
    ).toBe("refused");
  });

  it("refuses Force end when the process has changed since the normal close", async () => {
    const listing = [interactive()];
    const { tracker } = setup({ listing });
    await tracker.handle({ action: "end", key: SESSION_ID });
    listing[0] = interactive({ pid: 555 });
    expect(
      (await tracker.handle({ action: "forceEnd", key: SESSION_ID })).outcome,
    ).toBe("refused");
  });

  it("uses each normal close only once", async () => {
    const { tracker } = setup({ listing: [interactive()] });
    await tracker.handle({ action: "end", key: SESSION_ID });
    await tracker.handle({ action: "forceEnd", key: SESSION_ID });
    expect(
      (await tracker.handle({ action: "forceEnd", key: SESSION_ID })).outcome,
    ).toBe("refused");
  });
});

describe("gaps found in review", () => {
  it("locks a session under one key even when its session ID appears later", async () => {
    let release: () => void = () => undefined;
    const slow = vi.fn(
      () =>
        new Promise<{ outcome: "succeeded"; message: string }>((resolve) => {
          release = () => {
            resolve({ outcome: "succeeded", message: "Stopped." });
          };
        }),
    );
    const withoutSessionId = background();
    delete withoutSessionId.sessionId;
    const listing = [withoutSessionId];
    const { tracker } = setup({
      listing,
      executors: { stop: slow, delete: slow },
    });

    const first = tracker.handle({ action: "stop", key: "abcd1234" });
    await vi.waitFor(() => {
      expect(slow).toHaveBeenCalledTimes(1);
    });
    listing[0] = background();
    // Settle within 200 ms either way, so a regression fails here rather than by timing out.
    const second = await Promise.race([
      tracker.handle({ action: "delete", key: SESSION_ID }),
      new Promise<{ outcome: string }>((resolve) =>
        setTimeout(() => {
          resolve({ outcome: "still-running" });
        }, 200),
      ),
    ]);
    expect(second.outcome).toBe("refused");

    release();
    await first;
  });

  it("refuses when only the listed session is protected", async () => {
    const stop = vi.fn(() =>
      Promise.resolve({ outcome: "succeeded" as const, message: "" }),
    );
    let calls = 0;
    const freshListing = vi.fn(() => Promise.resolve([background()]));
    const tracker = createActionTracker({
      listing: () => ({
        sessions: [background()],
        lastSuccessAt: NOW,
        lastPollFailed: false,
      }),
      freshListing,
      executors: { stop },
      // Only the first check, on the listed session, sees it as protected.
      isProtected: () => {
        calls += 1;
        return calls === 1;
      },
      now: () => NOW,
    });
    expect(
      (await tracker.handle({ action: "stop", key: "abcd1234" })).outcome,
    ).toBe("refused");
    expect(stop).not.toHaveBeenCalled();
    // The listed check refuses before any fresh listing is taken.
    expect(freshListing).not.toHaveBeenCalled();
  });

  it("refuses when only the fresh session is protected", async () => {
    const stop = vi.fn(() =>
      Promise.resolve({ outcome: "succeeded" as const, message: "" }),
    );
    const tracker = createActionTracker({
      listing: () => ({
        sessions: [background()],
        lastSuccessAt: NOW,
        lastPollFailed: false,
      }),
      freshListing: () => Promise.resolve([background()]),
      executors: { stop },
      isProtected: (() => {
        let calls = 0;
        return () => {
          calls += 1;
          return calls > 1;
        };
      })(),
      now: () => NOW,
    });
    expect(
      (await tracker.handle({ action: "stop", key: "abcd1234" })).outcome,
    ).toBe("refused");
    expect(stop).not.toHaveBeenCalled();
  });

  it("refuses when the fresh row has the same short ID but a different session", async () => {
    const { tracker, executors } = setup({
      listing: [background()],
      fresh: [background({ sessionId: OTHER_ID })],
    });
    expect(
      (await tracker.handle({ action: "stop", key: "abcd1234" })).outcome,
    ).toBe("refused");
    expect(executors.stop).not.toHaveBeenCalled();
  });

  it("refuses End when the fresh listing shows the session finished", async () => {
    const { tracker, executors } = setup({
      listing: [interactive()],
      fresh: [interactive({ finished: true })],
    });
    expect(
      (await tracker.handle({ action: "end", key: SESSION_ID })).outcome,
    ).toBe("refused");
    expect(executors.end).not.toHaveBeenCalled();
  });

  it("refuses End on a session already finished in the listing", async () => {
    const { tracker, executors } = setup({
      listing: [interactive({ finished: true })],
    });
    expect(
      (await tracker.handle({ action: "end", key: SESSION_ID })).outcome,
    ).toBe("refused");
    expect(executors.end).not.toHaveBeenCalled();
  });

  it("refuses Resume of an interactive session that hasn't finished", async () => {
    const { tracker, executors } = setup({
      listing: [interactive()],
      fresh: [],
    });
    expect(
      (await tracker.handle({ action: "resume", key: SESSION_ID })).outcome,
    ).toBe("refused");
    expect(executors.resume).not.toHaveBeenCalled();
  });
});

describe("protection and own-action markers", () => {
  it("refuses Stop, Delete, and End on a protected session, but still allows Open", async () => {
    const executors: ActionExecutors = {
      open: vi.fn(() =>
        Promise.resolve({ outcome: "started" as const, message: "" }),
      ),
      stop: vi.fn(() =>
        Promise.resolve({ outcome: "succeeded" as const, message: "" }),
      ),
    };
    const tracker = createActionTracker({
      listing: () => ({
        sessions: [background()],
        lastSuccessAt: NOW,
        lastPollFailed: false,
      }),
      freshListing: () => Promise.resolve([background()]),
      executors,
      isProtected: (session) => session.sessionId === SESSION_ID,
      now: () => NOW,
    });
    expect(
      (await tracker.handle({ action: "stop", key: "abcd1234" })).outcome,
    ).toBe("refused");
    expect(executors.stop).not.toHaveBeenCalled();
    expect(
      (await tracker.handle({ action: "open", key: "abcd1234" })).outcome,
    ).toBe("started");
  });

  it("refuses with the protection's own message, such as actions being turned off", async () => {
    const stop = vi.fn(() =>
      Promise.resolve({ outcome: "succeeded" as const, message: "" }),
    );
    const tracker = createActionTracker({
      listing: () => ({
        sessions: [background()],
        lastSuccessAt: NOW,
        lastPollFailed: false,
      }),
      freshListing: () => Promise.resolve([background()]),
      executors: { stop },
      isProtected: () => "Actions are turned off.",
      now: () => NOW,
    });
    const result = await tracker.handle({ action: "stop", key: "abcd1234" });
    expect(result).toEqual({
      outcome: "refused",
      message: "Actions are turned off.",
    });
    expect(stop).not.toHaveBeenCalled();
  });

  it("marks a session after the user's own Stop, Delete, or End, for 30 seconds", async () => {
    const { tracker, advance } = setup({ listing: [background()] });
    await tracker.handle({ action: "stop", key: "abcd1234" });
    expect(tracker.ownActionSessions()).toEqual([SESSION_ID]);

    advance(OWN_ACTION_MS + 1);
    expect(tracker.ownActionSessions()).toEqual([]);
  });

  it("doesn't mark a session for Open", async () => {
    const { tracker } = setup({
      listing: [background({ sessionId: OTHER_ID })],
    });
    await tracker.handle({ action: "open", key: "abcd1234" });
    expect(tracker.ownActionSessions()).toEqual([]);
  });
});

const RECORD: LeftoverRecord = {
  session: { pid: 100, startMs: 5 },
  entries: [{ pid: 300, startMs: 6, name: "ping.exe", path: "C:/x/ping.exe" }],
};

function hooks(fields: Partial<LeftoverHooks> = {}) {
  return {
    record: vi.fn<LeftoverHooks["record"]>(() => Promise.resolve(RECORD)),
    hold: vi.fn<LeftoverHooks["hold"]>(),
    find: vi.fn<LeftoverHooks["find"]>(() => undefined),
    end: vi.fn<LeftoverHooks["end"]>(() =>
      Promise.resolve({
        outcome: "succeeded" as const,
        message: "Ended 1 of 1 program.",
      }),
    ),
    ...fields,
  };
}

describe("leftover programs (FR-27)", () => {
  it("records before Stop, after the fresh recheck, and holds the record with the result", async () => {
    const order: string[] = [];
    const leftovers = hooks({
      record: vi.fn(() => {
        order.push("record");
        return Promise.resolve(RECORD);
      }),
    });
    const running = background({ pid: 100, startedAt: 5 });
    const { tracker, fresh } = setup({
      listing: [running],
      leftovers,
      executors: {
        stop: vi.fn(() => {
          order.push("stop");
          return Promise.resolve({
            outcome: "succeeded" as const,
            message: "Stopped.",
          });
        }),
      },
    });
    const result = await tracker.handle({ action: "stop", key: "abcd1234" });
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["record", "stop"]);
    expect(result).toEqual({ outcome: "succeeded", message: "Stopped." });
    expect(leftovers.hold).toHaveBeenCalledWith(running, "stop", RECORD, {
      outcome: "succeeded",
      message: "Stopped.",
    });
  });

  it("goes ahead when recording fails, and says the programs can't be checked", async () => {
    const leftovers = hooks({ record: vi.fn(() => Promise.resolve(null)) });
    const { tracker } = setup({
      listing: [background({ pid: 100, startedAt: 5 })],
      leftovers,
    });
    const result = await tracker.handle({ action: "delete", key: "abcd1234" });
    expect(result).toEqual({
      outcome: "succeeded",
      message: `Deleted. ${NOT_RECORDED}`,
    });
  });

  it("treats a recording that throws as failed, and still acts", async () => {
    const leftovers = hooks({
      record: vi.fn(() => Promise.reject(new Error())),
    });
    const { tracker, executors } = setup({
      listing: [background({ pid: 100, startedAt: 5 })],
      leftovers,
    });
    const result = await tracker.handle({ action: "stop", key: "abcd1234" });
    expect(executors.stop).toHaveBeenCalledTimes(1);
    expect(result.message).toContain(NOT_RECORDED);
  });

  it("says nothing more for a Delete with no process to record", async () => {
    const leftovers = hooks({
      record: vi.fn(() => Promise.resolve(undefined)),
    });
    const { tracker } = setup({
      listing: [background({ state: "stopped" })],
      leftovers,
    });
    const result = await tracker.handle({ action: "delete", key: "abcd1234" });
    expect(result).toEqual({ outcome: "succeeded", message: "Deleted." });
    expect(leftovers.hold).toHaveBeenCalledWith(
      expect.objectContaining({ id: "abcd1234" }),
      "delete",
      undefined,
      { outcome: "succeeded", message: "Deleted." },
    );
  });

  it("holds End's own record, and never sends it to the page (NFR-13)", async () => {
    const leftovers = hooks();
    const { tracker } = setup({
      listing: [interactive({ startedAt: 5 })],
      leftovers,
      executors: {
        end: vi.fn(() =>
          Promise.resolve({
            outcome: "succeeded" as const,
            message: "Ended.",
            leftovers: RECORD,
          }),
        ),
      },
    });
    const result = await tracker.handle({ action: "end", key: SESSION_ID });
    expect(result).toEqual({ outcome: "succeeded", message: "Ended." });
    expect(leftovers.record).not.toHaveBeenCalled();
    expect(leftovers.hold).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID }),
      "end",
      RECORD,
      expect.objectContaining({ outcome: "succeeded" }),
    );
  });

  it("says nothing more when an earlier record, such as End's, still covers the session", async () => {
    const leftovers = hooks({
      find: vi.fn(() => ({ view: interactive(), sessionGone: false })),
    });
    const { tracker } = setup({
      listing: [interactive({ startedAt: 5 })],
      leftovers,
      executors: {
        end: vi.fn(() =>
          Promise.resolve({
            outcome: "unknown" as const,
            message: "Couldn't confirm.",
            leftovers: null,
          }),
        ),
      },
    });
    const result = await tracker.handle({ action: "end", key: SESSION_ID });
    expect(result.message).toBe("Couldn't confirm.");
  });

  it("says the programs can't be checked when End's helper run times out", async () => {
    const { tracker } = setup({
      listing: [interactive({ startedAt: 5 })],
      leftovers: hooks(),
      executors: {
        end: vi.fn(() =>
          Promise.resolve({
            outcome: "unknown" as const,
            message: "Couldn't confirm.",
            leftovers: null,
          }),
        ),
      },
    });
    const result = await tracker.handle({ action: "end", key: SESSION_ID });
    expect(result.message).toBe(`Couldn't confirm. ${NOT_RECORDED}`);
  });

  it("refuses when the fresh listing shows a different session under the same short ID", async () => {
    const leftovers = hooks({
      find: vi.fn(() => ({
        view: background({ state: "stopped" }),
        sessionGone: true,
      })),
    });
    const { tracker } = setup({
      listing: [],
      fresh: [background({ state: "stopped", sessionId: OTHER_ID })],
      leftovers,
    });
    const result = await tracker.handle({
      action: "endLeftovers",
      key: "abcd1234",
    });
    expect(result.outcome).toBe("refused");
    expect(leftovers.end).not.toHaveBeenCalled();
  });

  it("holds the session's lock, so Stop waits for End leftover programs", async () => {
    let release: () => void = () => undefined;
    const leftovers = hooks({
      find: vi.fn(() => ({
        view: background({ state: "stopped" }),
        sessionGone: true,
      })),
      end: vi.fn(
        () =>
          new Promise<ActionResult>((resolve) => {
            release = () => {
              resolve({ outcome: "succeeded", message: "Ended." });
            };
          }),
      ),
    });
    const { tracker } = setup({
      listing: [background({ state: "stopped" })],
      leftovers,
    });
    const first = tracker.handle({ action: "endLeftovers", key: "abcd1234" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stop = await tracker.handle({ action: "stop", key: "abcd1234" });
    expect(stop).toEqual({
      outcome: "refused",
      message: "Another action on this session is still running.",
    });
    release();
    await first;
  });

  it("doesn't mention recording when the action was refused before it", async () => {
    const leftovers = hooks();
    const { tracker } = setup({
      listing: [interactive({ startedAt: 5 })],
      leftovers,
      executors: {
        end: vi.fn(() =>
          Promise.resolve({
            outcome: "refused" as const,
            message: "Not the same session.",
            leftovers: null,
          }),
        ),
      },
    });
    const result = await tracker.handle({ action: "end", key: SESSION_ID });
    expect(result).toEqual({
      outcome: "refused",
      message: "Not the same session.",
    });
  });

  describe("endLeftovers", () => {
    const gone = { view: finishedInteractive(), sessionGone: true };

    it("refuses when no record is held", async () => {
      const { tracker } = setup({ listing: [], leftovers: hooks() });
      const result = await tracker.handle({
        action: "endLeftovers",
        key: SESSION_ID,
      });
      expect(result.outcome).toBe("refused");
    });

    it("ends the recorded programs of a session that's no longer listed, after a fresh listing", async () => {
      const leftovers = hooks({ find: vi.fn(() => gone) });
      const { tracker, fresh } = setup({ listing: [], leftovers });
      const result = await tracker.handle({
        action: "endLeftovers",
        key: SESSION_ID,
      });
      expect(fresh).toHaveBeenCalledTimes(1);
      expect(leftovers.end).toHaveBeenCalledWith(SESSION_ID);
      expect(result).toEqual({
        outcome: "succeeded",
        message: "Ended 1 of 1 program.",
      });
    });

    it("refuses while the session's own process still runs", async () => {
      const leftovers = hooks({
        find: vi.fn(() => ({ ...gone, sessionGone: false })),
      });
      const { tracker } = setup({ listing: [], leftovers });
      const result = await tracker.handle({
        action: "endLeftovers",
        key: SESSION_ID,
      });
      expect(result.outcome).toBe("refused");
      expect(leftovers.end).not.toHaveBeenCalled();
    });

    it("refuses while the listing shows the session with a process ID", async () => {
      const leftovers = hooks({ find: vi.fn(() => gone) });
      const { tracker } = setup({
        listing: [interactive()],
        leftovers,
      });
      const result = await tracker.handle({
        action: "endLeftovers",
        key: SESSION_ID,
      });
      expect(result.outcome).toBe("refused");
      expect(leftovers.end).not.toHaveBeenCalled();
    });

    it("refuses when the fresh listing shows the session running again", async () => {
      const leftovers = hooks({ find: vi.fn(() => gone) });
      const { tracker } = setup({
        listing: [],
        fresh: [interactive()],
        leftovers,
      });
      const result = await tracker.handle({
        action: "endLeftovers",
        key: SESSION_ID,
      });
      expect(result.outcome).toBe("refused");
      expect(leftovers.end).not.toHaveBeenCalled();
    });

    it("refuses on a stale listing (C-9)", async () => {
      const leftovers = hooks({ find: vi.fn(() => gone) });
      const { tracker } = setup({
        listing: [],
        state: { lastPollFailed: true },
        leftovers,
      });
      const result = await tracker.handle({
        action: "endLeftovers",
        key: SESSION_ID,
      });
      expect(result.outcome).toBe("refused");
    });

    it("refuses for a protected session (FR-22)", async () => {
      const leftovers = hooks({ find: vi.fn(() => gone) });
      const { tracker } = setup({
        listing: [],
        leftovers,
        isProtected: () => true,
      });
      const result = await tracker.handle({
        action: "endLeftovers",
        key: SESSION_ID,
      });
      expect(result.outcome).toBe("refused");
      expect(leftovers.end).not.toHaveBeenCalled();
    });

    it("refuses while another action runs on the session (NFR-10)", async () => {
      let release: () => void = () => undefined;
      const leftovers = hooks({
        find: vi.fn(() => gone),
        end: vi.fn(
          () =>
            new Promise<ActionResult>((resolve) => {
              release = () => {
                resolve({ outcome: "succeeded", message: "Ended." });
              };
            }),
        ),
      });
      const { tracker } = setup({ listing: [], leftovers });
      const first = tracker.handle({ action: "endLeftovers", key: SESSION_ID });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const second = await tracker.handle({
        action: "endLeftovers",
        key: SESSION_ID,
      });
      expect(second.outcome).toBe("refused");
      release();
      expect((await first).outcome).toBe("succeeded");
    });
  });
});
