import { describe, expect, it, vi } from "vitest";
import type { SessionView } from "../shared/protocol.js";
import { createEndExecutors, type HelperRun } from "./end.js";
import { toSessionView } from "./rules.js";
import type { ListingWatch } from "./stop-delete.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

const live = (): SessionView =>
  toSessionView({
    sessionId: SESSION_ID,
    kind: "interactive",
    status: "busy",
    pid: 100,
    startedAt: 5000,
    cwd: "C:\\work",
  });

function setup(
  helper: Record<string, unknown> | "timeout" | "error",
  gone: boolean | "polls-failing",
) {
  const run = vi.fn<HelperRun>(() =>
    Promise.resolve(
      helper === "timeout" || helper === "error"
        ? { kind: helper }
        : { kind: "ok" as const, result: helper },
    ),
  );
  const watch: ListingWatch = vi.fn(
    (predicate: (sessions: SessionView[]) => boolean) => {
      if (gone === "polls-failing") {
        return Promise.resolve({ sawSuccess: false, met: false, sessions: [] });
      }
      const sessions = gone ? [] : [live()];
      return Promise.resolve({
        sawSuccess: true,
        met: predicate(sessions),
        sessions,
      });
    },
  );
  const executors = createEndExecutors({ helperAvailable: true, run, watch });
  return { executors, run, watch };
}

describe("End", () => {
  it("sends Ctrl+Break through the helper with the process ID and start time", async () => {
    const { executors, run } = setup(
      { ok: true, reason: "sent", startMs: 4000 },
      true,
    );
    await executors.end(live());
    expect(run).toHaveBeenCalledWith({
      action: "break",
      pid: 100,
      startedAtMs: 5000,
    });
  });

  it("succeeds when the session leaves the listing", async () => {
    const { executors } = setup(
      { ok: true, reason: "sent", startMs: 4000 },
      true,
    );
    const result = await executors.end(live());
    expect(result.outcome).toBe("succeeded");
    expect(result.closeRecord).toBeUndefined();
  });

  it("offers Force end, with a close record, when the session is still listed", async () => {
    const { executors } = setup(
      { ok: true, reason: "sent", startMs: 4000 },
      false,
    );
    const result = await executors.end(live());
    expect(result.outcome).toBe("not-closed");
    expect(result.closeRecord).toEqual({ pid: 100, processStartMs: 4000 });
  });

  it("offers Force end straight away for a session started from Git Bash", async () => {
    const { executors, watch } = setup(
      {
        ok: false,
        reason: "unexpected-member:9",
        unexpectedImage: "bash",
        startMs: 4000,
      },
      false,
    );
    const result = await executors.end(live());
    expect(result.outcome).toBe("not-closed");
    expect(result.message).toMatch(/Git Bash/);
    expect(result.closeRecord).toEqual({ pid: 100, processStartMs: 4000 });
    expect(watch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "another program sharing the console",
      {
        ok: false,
        reason: "unexpected-member:9",
        unexpectedImage: "node",
        startMs: 4000,
      },
    ],
    [
      "a different program",
      { ok: false, reason: "wrong-image", image: "node" },
    ],
    [
      "a start time that doesn't match",
      { ok: false, reason: "start-time-mismatch", startMs: 1 },
    ],
    ["a session that has exited", { ok: false, reason: "target-exited" }],
    ["a session that isn't running", { ok: false, reason: "not-running" }],
    ["no console", { ok: false, reason: "no-console:6" }],
    ["no access", { ok: false, reason: "access-denied" }],
  ])("refuses, with no Force end, for %s", async (_label, helper) => {
    const { executors } = setup(helper, false);
    const result = await executors.end(live());
    expect(result.outcome).toBe("refused");
    expect(result.closeRecord).toBeUndefined();
  });

  it("is unavailable when PowerShell is restricted", async () => {
    const { executors } = setup(
      { ok: false, reason: "unavailable", detail: "language-mode" },
      false,
    );
    expect((await executors.end(live())).outcome).toBe("unavailable");
  });

  it("is unknown when the helper times out or polls fail", async () => {
    expect((await setup("timeout", false).executors.end(live())).outcome).toBe(
      "unknown",
    );
    expect(
      (
        await setup(
          { ok: true, reason: "sent", startMs: 4000 },
          "polls-failing",
        ).executors.end(live())
      ).outcome,
    ).toBe("unknown");
  });

  it("fails when the helper can't run", async () => {
    expect((await setup("error", false).executors.end(live())).outcome).toBe(
      "failed",
    );
  });

  it("refuses a session with no process ID or start time", async () => {
    const { executors, run } = setup(
      { ok: true, reason: "sent", startMs: 4000 },
      true,
    );
    const session = live();
    delete session.startedAt;
    expect((await executors.end(session)).outcome).toBe("refused");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("Force end", () => {
  const record = { pid: 100, processStartMs: 4000 };

  it("asks the helper to check the recorded process start time", async () => {
    const { executors, run } = setup(
      { ok: true, reason: "ended", ended: [100] },
      true,
    );
    await executors.forceEnd(live(), record);
    expect(run).toHaveBeenCalledWith({
      action: "force",
      pid: 100,
      startedAtMs: 5000,
      expectedStartMs: 4000,
    });
  });

  it("succeeds when the session leaves the listing", async () => {
    const { executors } = setup(
      { ok: true, reason: "ended", ended: [100] },
      true,
    );
    expect((await executors.forceEnd(live(), record)).outcome).toBe(
      "succeeded",
    );
  });

  it("is unknown when the session is still listed afterwards", async () => {
    const { executors } = setup(
      { ok: true, reason: "ended", ended: [100] },
      false,
    );
    expect((await executors.forceEnd(live(), record)).outcome).toBe("unknown");
  });

  it("fails when the target wasn't ended", async () => {
    const { executors } = setup(
      { ok: false, reason: "target-not-ended", ended: [] },
      false,
    );
    expect((await executors.forceEnd(live(), record)).outcome).toBe("failed");
  });

  it("refuses when the process isn't the one that got the normal close", async () => {
    const { executors } = setup(
      { ok: false, reason: "start-time-mismatch", startMs: 1 },
      false,
    );
    expect((await executors.forceEnd(live(), record)).outcome).toBe("refused");
  });

  it("refuses when the record is for a different process ID", async () => {
    const { executors, run } = setup(
      { ok: true, reason: "ended", ended: [100] },
      true,
    );
    expect(
      (await executors.forceEnd(live(), { ...record, pid: 7 })).outcome,
    ).toBe("refused");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("availability", () => {
  it("is unavailable without the helper", async () => {
    const run = vi.fn<HelperRun>();
    const executors = createEndExecutors({
      helperAvailable: false,
      run,
      watch: vi.fn(),
    });
    expect((await executors.end(live())).outcome).toBe("unavailable");
    expect(
      (await executors.forceEnd(live(), { pid: 100, processStartMs: 4000 }))
        .outcome,
    ).toBe("unavailable");
    expect(run).not.toHaveBeenCalled();
  });
});
