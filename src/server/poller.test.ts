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
      startedAt: 1,
      ...fields,
    });
    const noStatus = (sessionId: string) => listing(sessionId, {});
    const FAIL = Symbol("failed poll");
    type Poll = unknown[] | typeof FAIL;

    /** The warnings in effect after each poll. */
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
        intervalMs: 10,
        onSnapshot: (snapshot) => {
          current = snapshot;
        },
      });
      poller.start();
      for (let poll = 0; poll < polls.length; poll += 1) {
        await vi.advanceTimersByTimeAsync(poll === 0 ? 0 : 10);
        results.push(current?.warnings ?? []);
      }
      poller.stop();
      return results;
    };

    it("excuses a session's first listing without a status", async () => {
      expect(await warningsPerPoll([[noStatus("a")], [listing("a")]])).toEqual([
        [],
        [],
      ]);
    });

    it("warns when that session still has no status on the next poll", async () => {
      const results = await warningsPerPoll([[noStatus("a")], [noStatus("a")]]);
      expect(results[0]).toEqual([]);
      expect(results[1]).toEqual([expect.stringContaining("status")]);
    });

    it("excuses a session that starts while the tool is already running", async () => {
      expect(
        await warningsPerPoll([
          [listing("a")],
          [listing("a"), noStatus("b")],
          [listing("a"), listing("b")],
        ]),
      ).toEqual([[], [], []]);
    });

    it("doesn't raise a false warning for sessions starting one poll apart", async () => {
      expect(
        await warningsPerPoll([
          [noStatus("a")],
          [listing("a"), noStatus("b")],
          [listing("a"), listing("b"), noStatus("c")],
          [listing("a"), listing("b"), listing("c")],
        ]),
      ).toEqual([[], [], [], []]);
    });

    it("warns at once when a known session loses its status", async () => {
      const results = await warningsPerPoll([
        [listing("a")],
        [noStatus("a")],
        [listing("a")],
      ]);
      expect(results[1]).toEqual([expect.stringContaining("status")]);
      expect(results[2]).toEqual([]);
    });

    // This is what lets a session that keeps leaving the list avoid the warning (BUG-19).
    it("treats a session absent from the last poll as new, then warns", async () => {
      const results = await warningsPerPoll([
        [listing("a")],
        [],
        [noStatus("a")],
        [noStatus("a")],
      ]);
      expect(results[2]).toEqual([]);
      expect(results[3]).toEqual([expect.stringContaining("status")]);
    });

    it("remembers known sessions across a failed poll", async () => {
      const results = await warningsPerPoll([
        [noStatus("a")],
        FAIL,
        [noStatus("a")],
      ]);
      expect(results[2]).toEqual([expect.stringContaining("status")]);
    });

    it("keeps warnings in effect through a failed poll", async () => {
      const results = await warningsPerPoll([
        [listing("a")],
        [noStatus("a")],
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
