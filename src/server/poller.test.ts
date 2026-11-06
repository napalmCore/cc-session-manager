import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPoller } from "./poller.js";
import type { Snapshot } from "../shared/protocol.js";

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
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();

    expect(snapshots[0]?.sessions[0]?.needsAttention).toBe(true);
    expect(snapshots[0]?.warnings).not.toHaveLength(0);
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
