import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPoller } from "./poller.js";
import type { SessionView, Snapshot } from "../shared/protocol.js";

describe("createPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never runs two polls at the same time", async () => {
    let finish: (output: string) => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const poller = createPoller({ run, intervalMs: 10, onSnapshot: vi.fn() });

    poller.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);

    finish("[]");
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it("records a successful poll's start time, not its finish time", async () => {
    let finish: (output: string) => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const poller = createPoller({ run, intervalMs: 10, onSnapshot: vi.fn() });

    const before = Date.now();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    finish("[]");
    await vi.advanceTimersByTimeAsync(0);

    const { lastSuccessAt } = poller.state();
    expect(lastSuccessAt).not.toBeNull();
    expect(lastSuccessAt ?? 0).toBeLessThan(before + 5000);
    poller.stop();
  });

  it("counts failed polls in a row, and resets the count on success", async () => {
    const snapshots: Snapshot[] = [];
    const run = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("[]")
      .mockRejectedValueOnce(new Error("x"))
      .mockRejectedValueOnce(new Error("x"))
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValue("[]");
    const poller = createPoller({
      run,
      intervalMs: 10,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(45);
    poller.stop();
    expect(snapshots.map((snapshot) => snapshot.failedPolls)).toEqual([
      undefined,
      1,
      2,
      3,
      undefined,
    ]);
  });

  it("keeps the last good sessions and hides failure details", async () => {
    const snapshots: Snapshot[] = [];
    const good = JSON.stringify([
      { cwd: "C:/a", kind: "background", startedAt: 1, state: "working" },
    ]);
    const run = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce(good)
      .mockRejectedValue(new Error("secret-bearing failure detail"));
    const poller = createPoller({
      run,
      intervalMs: 10,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(10);
    poller.stop();

    const last = snapshots.at(-1);
    expect(last?.sessions).toHaveLength(1);
    expect(last?.error).toBeTruthy();
    expect(last?.error).not.toContain("secret-bearing");
  });

  it("clears the error once polling recovers", async () => {
    const snapshots: Snapshot[] = [];
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValue("[]");
    const poller = createPoller({
      run,
      intervalMs: 10,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(10);
    poller.stop();

    expect(snapshots.at(-1)?.error).toBeNull();
  });

  it("applies session rules and passes on parsing warnings", async () => {
    const snapshots: Snapshot[] = [];
    const poller = createPoller({
      run: () =>
        Promise.resolve(
          JSON.stringify([{ kind: "background", state: "blocked" }]),
        ),
      intervalMs: 10,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(10);
    poller.stop();

    expect(snapshots[0]?.sessions[0]?.needsAttention).toBe(true);
    expect(snapshots.at(-1)?.warnings).not.toHaveLength(0);
  });

  it("merges tracked sessions and warnings into the snapshot", async () => {
    const snapshots: Snapshot[] = [];
    const poller = createPoller({
      run: () => Promise.resolve("[]"),
      intervalMs: 10,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      track: () => ({
        sessions: [
          {
            needsAttention: false,
            attentionReason: null,
            finished: true,
            statusLabel: "finished",
          },
        ],
        warnings: ["store problem"],
      }),
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();

    expect(snapshots[0]?.sessions).toHaveLength(1);
    expect(snapshots[0]?.warnings).toEqual(["store problem"]);
  });

  it("adds metadata before tracking, so finished sessions keep it", async () => {
    const seenByTracker: SessionView[][] = [];
    const snapshots: Snapshot[] = [];
    const poller = createPoller({
      run: () => Promise.resolve(JSON.stringify([{ kind: "interactive" }])),
      intervalMs: 10,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      enrich: (current) =>
        Promise.resolve({
          sessions: current.map((session) => ({ ...session, model: "m" })),
          warnings: ["format warning"],
        }),
      track: (current) => {
        seenByTracker.push(current);
        return { sessions: current, warnings: [] };
      },
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();

    expect(seenByTracker[0]?.[0]?.model).toBe("m");
    expect(snapshots[0]?.warnings).toContain("format warning");
  });

  it("does not track sessions when a poll fails", async () => {
    const track = vi.fn(() => ({ sessions: [], warnings: [] }));
    const poller = createPoller({
      run: () => Promise.reject(new Error("failed")),
      intervalMs: 10,
      onSnapshot: vi.fn(),
      track,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(30);
    poller.stop();

    expect(track).not.toHaveBeenCalled();
  });

  describe("parsing warnings", () => {
    const listing = (
      sessionId: string,
      fields: Record<string, unknown> = { status: "busy" },
    ) => ({
      sessionId,
      cwd: "C:/a",
      kind: "interactive",
      startedAt: Date.now(),
      ...fields,
    });
    const noStatus = (sessionId: string, fields = {}) =>
      listing(sessionId, fields);
    const old = { startedAt: 1, status: "busy" };
    const oldNoStatus = { startedAt: 1 };
    const FAIL = Symbol("failed poll");
    type Poll = unknown[] | typeof FAIL;
    const INTERVAL = 3_000;

    /** The warnings in effect after each poll, with polls 3 seconds apart. */
    const warningsPerPoll = async (polls: Poll[]) => {
      let current: Snapshot | undefined;
      const results: string[][] = [];
      let index = 0;
      const poller = createPoller({
        run: () => {
          const poll = polls[index];
          index += 1;
          return poll === FAIL
            ? Promise.reject(new Error("failed"))
            : Promise.resolve(JSON.stringify(poll ?? []));
        },
        intervalMs: INTERVAL,
        onSnapshot: (snapshot) => {
          current = snapshot;
        },
      });
      poller.start();
      for (let poll = 0; poll < polls.length; poll += 1) {
        await vi.advanceTimersByTimeAsync(poll === 0 ? 0 : INTERVAL);
        results.push(current?.warnings ?? []);
      }
      poller.stop();
      return results;
    };

    it("excuses a new session's missing status for up to 10 seconds", async () => {
      const entry = noStatus("a");
      const results = await warningsPerPoll(
        [entry, entry, entry, entry, entry].map((e) => [e]),
      );
      expect(results.slice(0, 4)).toEqual([[], [], [], []]);
      expect(results[4]).toEqual([expect.stringContaining("status")]);
    });

    it("shows a new session with no status as starting, then unknown", async () => {
      const entry = noStatus("a");
      const labels: string[] = [];
      let index = 0;
      const poller = createPoller({
        run: () => {
          index += 1;
          return Promise.resolve(JSON.stringify([entry]));
        },
        intervalMs: INTERVAL,
        onSnapshot: (snapshot) => {
          labels[index - 1] = snapshot.sessions[0]?.statusLabel ?? "";
        },
      });
      poller.start();
      for (let poll = 0; poll < 5; poll += 1) {
        await vi.advanceTimersByTimeAsync(poll === 0 ? 0 : INTERVAL);
      }
      poller.stop();
      expect(labels[0]).toBe("starting");
      expect(labels.at(-1)).toBe("unknown");
    });

    it("warns at once for a session already running when the tool started", async () => {
      expect(await warningsPerPoll([[listing("a", oldNoStatus)]])).toEqual([
        [expect.stringContaining("status")],
      ]);
    });

    it("doesn't raise a false warning for sessions starting one poll apart", async () => {
      const a = noStatus("a");
      const results = await warningsPerPoll([
        [a],
        [listing("a"), noStatus("b")],
        [listing("a"), listing("b"), noStatus("c")],
      ]);
      expect(results).toEqual([[], [], []]);
    });

    it("warns at once when a known session loses its status", async () => {
      const results = await warningsPerPoll([
        [listing("a", old)],
        [listing("a", oldNoStatus)],
        [listing("a", old)],
      ]);
      expect(results[1]).toEqual([expect.stringContaining("status")]);
      expect(results[2]).toEqual([]);
    });

    // The start-time bound alone makes these two pass; session-memory tests the memory itself.
    it("doesn't excuse a session again after it leaves the list and comes back", async () => {
      const entry = noStatus("a");
      const results = await warningsPerPoll([[entry], [], [], [], [entry]]);
      expect(results[4]).toEqual([expect.stringContaining("status")]);
    });

    it("doesn't excuse a session again when it gains an ID", async () => {
      const startedAt = Date.now();
      const first = { pid: 7, cwd: "C:/a", kind: "interactive", startedAt };
      const results = await warningsPerPoll([
        [first],
        [first],
        [first],
        [first],
        [{ ...first, sessionId: "a" }],
      ]);
      expect(results[0]).toEqual([]);
      expect(results[4]).toEqual([expect.stringContaining("status")]);
    });

    it("keeps warnings in effect through a failed poll", async () => {
      const results = await warningsPerPoll([
        [listing("a", old)],
        [listing("a", oldNoStatus)],
        FAIL,
      ]);
      expect(results[2]).toEqual([expect.stringContaining("status")]);
    });

    it.each([
      ["a non-object entry", ["oops"]],
      ["an unknown status value", [listing("a", { status: "asking" })]],
      ["a wrongly typed field", [listing("a", { startedAt: "soon" })]],
      [
        "another missing field",
        [{ sessionId: "a", kind: "interactive", status: "busy" }],
      ],
      [
        "a session with no identity",
        [{ cwd: "C:/a", kind: "interactive", startedAt: 1 }],
      ],
    ])("warns at once about %s", async (_label, poll) => {
      const [first] = await warningsPerPoll([poll]);
      expect(first).not.toHaveLength(0);
    });

    it("passes store and transcript warnings on immediately", async () => {
      const snapshots: Snapshot[] = [];
      const poller = createPoller({
        run: () => Promise.resolve("[]"),
        intervalMs: 10,
        onSnapshot: (snapshot) => snapshots.push(snapshot),
        enrich: (sessions) =>
          Promise.resolve({ sessions, warnings: ["transcript problem"] }),
        track: (sessions) => ({ sessions, warnings: ["store problem"] }),
      });
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      poller.stop();

      expect(snapshots[0]?.warnings).toEqual([
        "transcript problem",
        "store problem",
      ]);
    });
  });

  it("reports the latest listing and its freshness", async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            cwd: "C:/a",
            kind: "background",
            startedAt: 1,
            state: "working",
            id: "abcd1234",
          },
        ]),
      )
      .mockRejectedValue(new Error("failed"));
    const poller = createPoller({ run, intervalMs: 10, onSnapshot: vi.fn() });
    expect(poller.state()).toEqual({
      sessions: [],
      lastSuccessAt: null,
      lastPollFailed: false,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    const afterSuccess = poller.state();
    expect(afterSuccess.sessions).toHaveLength(1);
    expect(afterSuccess.lastSuccessAt).not.toBeNull();
    expect(afterSuccess.lastPollFailed).toBe(false);

    await vi.advanceTimersByTimeAsync(10);
    poller.stop();
    const afterFailure = poller.state();
    expect(afterFailure.lastPollFailed).toBe(true);
    expect(afterFailure.lastSuccessAt).toBe(afterSuccess.lastSuccessAt);
    expect(afterFailure.sessions).toHaveLength(1);
  });

  it("only reports a snapshot when something changed", async () => {
    const onSnapshot = vi.fn();
    const poller = createPoller({
      run: () => Promise.resolve("[]"),
      intervalMs: 10,
      onSnapshot,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(50);
    poller.stop();

    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });
});
