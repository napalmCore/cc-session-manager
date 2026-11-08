import { describe, expect, it, vi } from "vitest";
import type { SessionView } from "../shared/protocol.js";
import { toSessionView } from "./rules.js";
import { homedir } from "node:os";
import {
  COMMAND_TIMEOUT_MS,
  createStopDeleteExecutors,
  runClaude,
  watchPoller,
  type CliResult,
  type ListingWatch,
} from "./stop-delete.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

const background = (fields: Partial<SessionView> = {}): SessionView => ({
  ...toSessionView({
    id: "abcd1234",
    sessionId: SESSION_ID,
    kind: "background",
    state: "working",
    pid: 50,
  }),
  ...fields,
});
const stopped = (): SessionView => {
  const session = background({ state: "stopped", statusLabel: "stopped" });
  delete session.pid;
  return session;
};

function setup(cli: CliResult, after: SessionView[] | "polls-failing") {
  const run = vi.fn<(args: string[]) => Promise<CliResult>>(() =>
    Promise.resolve(cli),
  );
  const watch: ListingWatch = vi.fn(
    (predicate: (sessions: SessionView[]) => boolean) =>
      Promise.resolve(
        after === "polls-failing"
          ? { sawSuccess: false, met: false, sessions: [] }
          : { sawSuccess: true, met: predicate(after), sessions: after },
      ),
  );
  const executors = createStopDeleteExecutors({
    claudeAvailable: true,
    run,
    watch,
  });
  return { executors, run, watch };
}

const ok: CliResult = { kind: "exited", code: 0, stdout: "" };

describe("Stop", () => {
  it("runs claude stop with the short ID", async () => {
    const { executors, run } = setup(ok, [stopped()]);
    await executors.stop(background());
    expect(run).toHaveBeenCalledWith(["stop", "abcd1234"]);
  });

  it.each(["stopped", "done", "failed"])(
    "succeeds when the session is %s with no process",
    async (state) => {
      const after = { ...stopped(), state };
      const { executors } = setup(ok, [after]);
      expect((await executors.stop(background())).outcome).toBe("succeeded");
    },
  );

  it("doesn't count a different stopped session as success", async () => {
    const other = { ...stopped(), id: "eeee0000" };
    const { executors } = setup(ok, [background(), other]);
    expect((await executors.stop(background())).outcome).toBe("failed");
  });

  it("fails when the session is still working", async () => {
    const { executors } = setup(ok, [background()]);
    expect((await executors.stop(background())).outcome).toBe("failed");
  });

  it("fails when the session is stopped but its process is still running", async () => {
    const { executors } = setup(ok, [background({ state: "stopped" })]);
    expect((await executors.stop(background())).outcome).toBe("failed");
  });

  it("is unknown when polls are failing", async () => {
    const { executors } = setup(ok, "polls-failing");
    expect((await executors.stop(background())).outcome).toBe("unknown");
  });

  it("is unknown when the command times out", async () => {
    const { executors, watch } = setup({ kind: "timeout" }, [stopped()]);
    expect((await executors.stop(background())).outcome).toBe("unknown");
    expect(watch).not.toHaveBeenCalled();
  });

  it("judges success from the listing, not the exit code", async () => {
    const { executors } = setup({ kind: "exited", code: 1, stdout: "" }, [
      stopped(),
    ]);
    expect((await executors.stop(background())).outcome).toBe("succeeded");
  });
});

describe("Delete", () => {
  it("runs plain claude rm, never with a forcing flag", async () => {
    const { executors, run } = setup(ok, []);
    await executors.delete(background());
    expect(run).toHaveBeenCalledWith(["rm", "abcd1234"]);
  });

  it("succeeds when it exits 0 and the row goes", async () => {
    const { executors } = setup(ok, []);
    expect((await executors.delete(background())).outcome).toBe("succeeded");
  });

  it("reports a kept session in the tool's own words, without the CLI's text", async () => {
    const kept: CliResult = {
      kind: "exited",
      code: 1,
      stdout:
        "kept abcd1234 — its worktree is still at C:\\secret\\wt. Run claude rm --force-remove-worktree",
    };
    const { executors } = setup(kept, [background()]);

    const result = await executors.delete(background());

    expect(result.outcome).toBe("kept");
    expect(result.message).not.toContain("secret");
    expect(result.message).not.toContain("--force");
    expect(result.message).not.toContain("agent view");
  });

  it("fails, inviting a retry, when it can't remove the session for another reason", async () => {
    const failed: CliResult = {
      kind: "exited",
      code: 1,
      stdout: "",
      stderr:
        "couldn't remove abcd1234 — the background service may be restarting",
    };
    const { executors } = setup(failed, [background()]);
    const result = await executors.delete(background());
    expect(result.outcome).toBe("failed");
    expect(result.message).not.toContain("background service");
  });

  it("is unknown when it exits 0 but the row stays", async () => {
    const { executors } = setup(ok, [background()]);
    expect((await executors.delete(background())).outcome).toBe("unknown");
  });

  it("succeeds with a note when it exits non-zero but the row goes", async () => {
    const { executors } = setup({ kind: "exited", code: 1, stdout: "" }, []);
    const result = await executors.delete(background());
    expect(result.outcome).toBe("succeeded");
    expect(result.message).toMatch(/reported a problem/i);
  });

  it("is unknown when the command times out or polls are failing", async () => {
    expect(
      (await setup({ kind: "timeout" }, []).executors.delete(background()))
        .outcome,
    ).toBe("unknown");
    expect(
      (await setup(ok, "polls-failing").executors.delete(background())).outcome,
    ).toBe("unknown");
  });

  it("is unknown when the command couldn't start", async () => {
    const { executors } = setup({ kind: "error" }, []);
    expect((await executors.delete(background())).outcome).toBe("unknown");
  });
});

describe("availability", () => {
  it("is unavailable without claude.exe", async () => {
    const run = vi.fn();
    const executors = createStopDeleteExecutors({
      claudeAvailable: false,
      run,
      watch: vi.fn(),
    });
    expect((await executors.stop(background())).outcome).toBe("unavailable");
    expect((await executors.delete(background())).outcome).toBe("unavailable");
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a session without a short ID", async () => {
    const { executors, run } = setup(ok, []);
    const noId = background();
    delete noId.id;
    expect((await executors.stop(noId)).outcome).toBe("refused");
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    "--force-remove-worktree",
    "--discard-unpushed",
    "ABCD1234",
    "abcd123",
  ])(
    "never passes a short ID that isn't 8 hex digits, such as %s (C-8)",
    async (id) => {
      const { executors, run } = setup(ok, []);
      expect((await executors.stop(background({ id }))).outcome).toBe(
        "refused",
      );
      expect((await executors.delete(background({ id }))).outcome).toBe(
        "refused",
      );
      expect(run).not.toHaveBeenCalled();
    },
  );
});

describe("runClaude", () => {
  it("reports the exit code and output of a real program", async () => {
    const result = await runClaude(process.execPath, [
      "-e",
      "process.stdout.write('kept x'); process.exit(3)",
    ]);
    expect(result).toEqual({
      kind: "exited",
      code: 3,
      stdout: "kept x",
      stderr: "",
    });
  });

  it("runs from the home folder with the identity variables removed", async () => {
    const saved = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "1";
    try {
      const result = await runClaude(process.execPath, [
        "-e",
        "process.stdout.write(JSON.stringify({ cwd: process.cwd(), claude: process.env.CLAUDECODE ?? null }))",
      ]);
      expect(result.kind).toBe("exited");
      const seen = JSON.parse(
        result.kind === "exited" ? result.stdout : "{}",
      ) as {
        cwd: string;
        claude: string | null;
      };
      expect(seen.cwd.toLowerCase()).toBe(homedir().toLowerCase());
      expect(seen.claude).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = saved;
    }
  });

  it("uses a 15-second limit", () => {
    expect(COMMAND_TIMEOUT_MS).toBe(15_000);
  });

  it("reports a timeout", async () => {
    const result = await runClaude(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)"],
      300,
    );
    expect(result).toEqual({ kind: "timeout" });
  });

  it("reports a program that couldn't start", async () => {
    const result = await runClaude("C:\\no-such-folder\\claude.exe", [
      "stop",
      "abcd1234",
    ]);
    expect(result).toEqual({ kind: "error" });
  });
});

describe("watchPoller", () => {
  it("ignores listings from before the action, and stops once the predicate holds", async () => {
    const before = Date.now() - 1000;
    let state = {
      sessions: [] as SessionView[],
      lastSuccessAt: before,
      lastPollFailed: false,
    };
    const watch = watchPoller(() => state, 2000, 10);
    setTimeout(() => {
      state = {
        sessions: [stopped()],
        lastSuccessAt: Date.now(),
        lastPollFailed: false,
      };
    }, 50);

    const result = await watch((sessions) => sessions.length > 0);

    expect(result.sawSuccess).toBe(true);
    expect(result.met).toBe(true);
  });

  it("reports no successful poll when the listing never refreshes", async () => {
    const state = {
      sessions: [stopped()],
      lastSuccessAt: Date.now() - 1000,
      lastPollFailed: true,
    };
    const result = await watchPoller(() => state, 60, 10)(() => true);
    expect(result).toEqual({ sawSuccess: false, met: false, sessions: [] });
  });
});
