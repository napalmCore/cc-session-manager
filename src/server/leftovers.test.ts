import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "../shared/protocol.js";
import type { ActionResult } from "./actions.js";
import type {
  InputOutcome,
  InputRun,
  LeftoverRecord,
} from "./leftovers-helper.js";
import {
  checkDelay,
  createLeftoverTracker,
  FIRST_CHECK_MS,
  WAIT_FOR_EXIT_MS,
} from "./leftovers.js";
import { toSessionView } from "./rules.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const session = { pid: 100, startMs: 1_000 };
const bash = {
  pid: 200,
  startMs: 1_100,
  name: "bash.exe",
  path: "C:/Git/usr/bin/bash.exe",
};
const ping = {
  pid: 300,
  startMs: 1_200,
  name: "PING.EXE",
  path: "C:/Windows/System32/PING.EXE",
};
const RECORD: LeftoverRecord = { session, entries: [bash, ping] };

const view = (): SessionView =>
  toSessionView({
    id: "abcd1234",
    sessionId: SESSION_ID,
    kind: "background",
    state: "working",
    pid: 100,
    startedAt: 1_000,
    cwd: "C:\\work",
    name: "Build",
  });
const ok = (outcome: ActionResult["outcome"] = "succeeded"): ActionResult => ({
  outcome,
  message: "Done.",
});

const checked = (
  running: { pid: number; startMs: number }[],
  children: Record<string, unknown>[] = [],
): InputOutcome => ({
  kind: "ok",
  result: { ok: true, action: "check", running, unverified: [], children },
});

function setup(answers: InputOutcome[] = []) {
  const queue = [...answers];
  const run = vi.fn<InputRun>(() =>
    Promise.resolve(queue.shift() ?? checked([])),
  );
  const onChange = vi.fn();
  const tracker = createLeftoverTracker({ run, onChange });
  return { tracker, run, onChange };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("checking (FR-27)", () => {
  it("backs off: every 10 s for a minute, every 30 s to 10 minutes, then every 60 s", () => {
    expect(checkDelay(0)).toBe(10_000);
    expect(checkDelay(59_000)).toBe(10_000);
    expect(checkDelay(60_000)).toBe(30_000);
    expect(checkDelay(WAIT_FOR_EXIT_MS - 1)).toBe(30_000);
    expect(checkDelay(WAIT_FOR_EXIT_MS)).toBe(60_000);
  });

  it("first checks 5 seconds after the action, for the session and every entry", async () => {
    const { tracker, run } = setup([checked([session, bash, ping])]);
    tracker.hold(view(), "stop", RECORD, ok());
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledWith("check", {
      processes: [
        session,
        { pid: 200, startMs: 1_100 },
        { pid: 300, startMs: 1_200 },
      ],
      // Only wrappers are looked under, so the process table is read only while one runs.
      parents: [{ pid: 200, startMs: 1_100 }],
    });
    tracker.stop();
  });

  it("offers nothing while the session's own process still runs", async () => {
    const { tracker } = setup([checked([session, bash, ping])]);
    tracker.hold(view(), "stop", RECORD, ok());
    await tracker.check();
    expect(tracker.offers()).toEqual([]);
    expect(tracker.find("abcd1234")?.sessionGone).toBe(false);
    tracker.stop();
  });

  it("offers the programs that still run once the session has gone", async () => {
    const { tracker, onChange } = setup([checked([ping])]);
    tracker.hold(view(), "stop", RECORD, ok());
    await tracker.check();
    expect(tracker.offers()).toEqual([
      {
        key: "abcd1234",
        keys: ["abcd1234", SESSION_ID],
        deleted: false,
        session: view(),
        programs: [{ pid: 300, name: "PING.EXE" }],
        count: 1,
      },
    ]);
    expect(onChange).toHaveBeenCalled();
    tracker.stop();
  });

  it("adds new children of a recorded wrapper that still runs", async () => {
    const child = {
      pid: 400,
      startMs: 1_300,
      name: "node.exe",
      path: "C:/n/node.exe",
      parentPid: 200,
    };
    const stranger = { ...child, pid: 401, parentPid: 999 };
    const { tracker } = setup([checked([bash], [child, stranger])]);
    tracker.hold(view(), "stop", RECORD, ok());
    await tracker.check();
    expect(tracker.offers()[0]?.programs).toEqual([
      { pid: 200, name: "bash.exe" },
      { pid: 400, name: "node.exe" },
    ]);
    tracker.stop();
  });

  it("drops the record when no entry runs", async () => {
    const { tracker } = setup([checked([])]);
    tracker.hold(view(), "stop", RECORD, ok());
    await tracker.check();
    expect(tracker.find("abcd1234")).toBeUndefined();
    tracker.stop();
  });

  it("drops the record if the session still runs 10 minutes after the action", async () => {
    const { tracker } = setup([
      checked([session, ping]),
      checked([session, ping]),
    ]);
    tracker.hold(view(), "end", RECORD, ok("not-closed"));
    await tracker.check();
    expect(tracker.find(SESSION_ID)).toBeDefined();
    vi.setSystemTime(10_000 + WAIT_FOR_EXIT_MS + 1);
    await tracker.check();
    expect(tracker.find(SESSION_ID)).toBeUndefined();
    tracker.stop();
  });

  it("keeps the record when a check fails", async () => {
    const { tracker } = setup([{ kind: "timeout" }]);
    tracker.hold(view(), "stop", RECORD, ok());
    await tracker.check();
    expect(tracker.find("abcd1234")?.sessionGone).toBe(false);
    tracker.stop();
  });

  it("holds nothing for a record with no programs", () => {
    const { tracker } = setup();
    tracker.hold(view(), "stop", { session, entries: [] }, ok());
    expect(tracker.find("abcd1234")).toBeUndefined();
  });
});

describe("the Deleted row (0020)", () => {
  it("carries a Stop's record over to a later Delete, marked deleted", async () => {
    const { tracker } = setup([checked([ping])]);
    tracker.hold(view(), "stop", RECORD, ok());
    await tracker.check();
    const stopped = { ...view(), state: "stopped" };
    delete stopped.pid;
    tracker.hold(stopped, "delete", undefined, ok());
    expect(tracker.offers()[0]).toMatchObject({
      deleted: true,
      session: stopped,
    });
    tracker.stop();
  });

  it("isn't marked deleted when the Delete didn't succeed", async () => {
    const { tracker } = setup([checked([ping])]);
    tracker.hold(view(), "stop", RECORD, ok());
    await tracker.check();
    tracker.hold(view(), "delete", undefined, ok("kept"));
    expect(tracker.offers()[0]?.deleted).toBe(false);
    tracker.stop();
  });

  it("marks a running session's own Delete record as deleted", async () => {
    const { tracker } = setup([checked([ping])]);
    tracker.hold(view(), "delete", RECORD, ok());
    await tracker.check();
    expect(tracker.offers()[0]?.deleted).toBe(true);
    tracker.stop();
  });
});

describe("ending leftover programs", () => {
  it("refuses while the session's own process still runs", async () => {
    const { tracker, run } = setup([checked([session, ping])]);
    tracker.hold(view(), "stop", RECORD, ok());
    const result = await tracker.end("abcd1234");
    expect(result.outcome).toBe("refused");
    expect(run).toHaveBeenCalledTimes(1);
    tracker.stop();
  });

  it("checks again, then ends the programs that still run, naming any it couldn't", async () => {
    const { tracker, run, onChange } = setup([
      checked([bash, ping]),
      checked([bash, ping]),
      {
        kind: "ok",
        result: {
          ok: true,
          action: "end-leftovers",
          requested: 2,
          ended: [300],
          skipped: [{ pid: 200, reason: "access-denied" }],
        },
      },
    ]);
    tracker.hold(view(), "stop", RECORD, ok());
    await tracker.check();
    onChange.mockClear();
    const result = await tracker.end(SESSION_ID);
    expect(run).toHaveBeenLastCalledWith("end-leftovers", {
      entries: [
        { pid: 200, startMs: 1_100, path: bash.path },
        { pid: 300, startMs: 1_200, path: ping.path },
      ],
    });
    expect(result).toEqual({
      outcome: "failed",
      message:
        "Ended 1 of 2 programs. Not ended: bash.exe (process 200): the tool isn't allowed to end it.",
    });
    expect(tracker.offers()[0]?.programs).toEqual([
      { pid: 200, name: "bash.exe" },
    ]);
    expect(onChange).toHaveBeenCalled();
    tracker.stop();
  });

  it("succeeds and drops the record when every program is ended", async () => {
    const { tracker } = setup([
      checked([ping]),
      checked([ping]),
      {
        kind: "ok",
        result: {
          ok: true,
          action: "end-leftovers",
          requested: 1,
          ended: [300],
          skipped: [],
        },
      },
    ]);
    tracker.hold(view(), "stop", RECORD, ok());
    await tracker.check();
    expect(await tracker.end("abcd1234")).toEqual({
      outcome: "succeeded",
      message: "Ended 1 of 1 program.",
    });
    expect(tracker.find("abcd1234")).toBeUndefined();
  });

  it("is unknown when the helper times out, and keeps the record", async () => {
    const { tracker } = setup([
      checked([ping]),
      checked([ping]),
      { kind: "timeout" },
    ]);
    tracker.hold(view(), "stop", RECORD, ok());
    await tracker.check();
    expect((await tracker.end("abcd1234")).outcome).toBe("unknown");
    expect(tracker.find("abcd1234")).toBeDefined();
    tracker.stop();
  });

  it("is unavailable without the helper", async () => {
    const tracker = createLeftoverTracker({ run: null, onChange: vi.fn() });
    tracker.hold(view(), "stop", RECORD, ok());
    expect((await tracker.end("abcd1234")).outcome).toBe("unavailable");
    tracker.stop();
  });
});
