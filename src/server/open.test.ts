import { describe, expect, it, vi } from "vitest";
import type { SessionView } from "../shared/protocol.js";
import { join } from "node:path";
import {
  createOpenExecutors,
  launchDetached,
  REPEAT_WINDOW_MS,
} from "./open.js";
import type { openPosixTerminal } from "./posix-terminal.js";
import type { LaunchPlan, Programs } from "./programs.js";
import { toSessionView } from "./rules.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const programs: Programs = {
  claude: "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
  wt: "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe",
  cmd: "C:\\Windows\\System32\\cmd.exe",
  powershell: null,
};

const background = (): SessionView =>
  toSessionView({
    id: "abcd1234",
    sessionId: SESSION_ID,
    kind: "background",
    state: "done",
    cwd: "C:\\work",
  });
const finishedInteractive = (): SessionView => ({
  ...toSessionView({
    sessionId: SESSION_ID,
    kind: "interactive",
    cwd: "C:\\work",
  }),
  finished: true,
  statusLabel: "finished",
});

function setup(
  overrides: Partial<Parameters<typeof createOpenExecutors>[0]> = {},
) {
  let now = 1_000_000;
  const launch = vi.fn<
    (plan: LaunchPlan, env: NodeJS.ProcessEnv) => Promise<void>
  >(() => Promise.resolve());
  const executors = createOpenExecutors({
    programs,
    launch,
    folderExists: () => true,
    transcriptExists: () => Promise.resolve(true),
    homeFolder: "C:\\Users\\u",
    environment: {
      PATH: "/usr/local/bin",
      CLAUDECODE: "1",
      CLAUDE_CONFIG_DIR: "D:\\c",
    },
    now: () => now,
    // The Windows terminal; macOS and Linux are tested with a stand-in below.
    platform: "win32",
    ...overrides,
  });
  return {
    executors,
    launch,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("Open", () => {
  it("attaches in a new terminal in the session's folder, with identity variables removed", async () => {
    const { executors, launch } = setup();

    const result = await executors.open(background());

    expect(result.outcome).toBe("started");
    const [plan, env] = launch.mock.calls[0] ?? [];
    expect(plan?.file).toBe(programs.wt);
    expect(plan?.args.slice(-2)).toEqual(["attach", "abcd1234"]);
    expect(plan?.cwd).toBe("C:\\work");
    expect(env).toEqual({ PATH: "/usr/local/bin", CLAUDE_CONFIG_DIR: "D:\\c" });
  });

  it("uses the home folder when the session's folder no longer exists", async () => {
    const { executors, launch } = setup({ folderExists: () => false });
    await executors.open(background());
    expect(launch.mock.calls[0]?.[0].cwd).toBe("C:\\Users\\u");
  });

  it("waits for a folder check that answers later, as macOS and Linux do (FR-44)", async () => {
    const { executors, launch } = setup({
      folderExists: () => Promise.resolve(false),
    });
    await executors.open(background());
    expect(launch.mock.calls[0]?.[0].cwd).toBe("C:\\Users\\u");
  });

  it("ignores a repeated click for the same session within the window", async () => {
    const { executors, launch, advance } = setup();
    await executors.open(background());

    const second = await executors.open(background());
    expect(second.outcome).toBe("refused");
    expect(launch).toHaveBeenCalledTimes(1);

    advance(REPEAT_WINDOW_MS + 1);
    expect((await executors.open(background())).outcome).toBe("started");
  });

  it("is unavailable without claude.exe", async () => {
    const { executors, launch } = setup({
      programs: { ...programs, claude: null },
    });
    expect((await executors.open(background())).outcome).toBe("unavailable");
    expect(launch).not.toHaveBeenCalled();
  });

  it("is unavailable without any terminal program", async () => {
    const { executors } = setup({
      programs: { ...programs, wt: null, cmd: null },
    });
    expect((await executors.open(background())).outcome).toBe("unavailable");
  });

  it("reports a failed launch without raw details", async () => {
    const launch = vi.fn(() =>
      Promise.reject(new Error("spawn C:\\secret ENOENT")),
    );
    const { executors } = setup({ launch });
    const result = await executors.open(background());
    expect(result.outcome).toBe("failed");
    expect(result.message).not.toContain("secret");
  });

  it("allows a retry straight after a failed launch", async () => {
    const launch = vi
      .fn<(plan: LaunchPlan, env: NodeJS.ProcessEnv) => Promise<void>>()
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValue();
    const { executors } = setup({ launch });
    await executors.open(background());
    expect((await executors.open(background())).outcome).toBe("started");
  });
});

describe("Resume", () => {
  it("resumes a finished session in its own folder", async () => {
    const { executors, launch } = setup();

    const result = await executors.resume(finishedInteractive());

    expect(result.outcome).toBe("started");
    const plan = launch.mock.calls[0]?.[0];
    expect(plan?.args.slice(-2)).toEqual(["--resume", SESSION_ID]);
    expect(plan?.cwd).toBe("C:\\work");
  });

  it("refuses when the session has no transcript to resume", async () => {
    const { executors, launch } = setup({
      transcriptExists: () => Promise.resolve(false),
    });
    expect((await executors.resume(finishedInteractive())).outcome).toBe(
      "refused",
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it("refuses when the session's folder no longer exists", async () => {
    const { executors, launch } = setup({ folderExists: () => false });
    expect((await executors.resume(finishedInteractive())).outcome).toBe(
      "refused",
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it("ignores a repeated Resume of the same session within the window", async () => {
    const { executors, launch } = setup();
    await executors.resume(finishedInteractive());
    expect((await executors.resume(finishedInteractive())).outcome).toBe(
      "refused",
    );
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

describe("launchDetached", () => {
  it("resolves once a real program has started", async () => {
    await expect(
      launchDetached(
        {
          file: process.execPath,
          args: ["-e", "0"],
          cwd: process.cwd(),
          windowsVerbatimArguments: false,
        },
        process.env,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects when the program doesn't exist", async () => {
    await expect(
      launchDetached(
        {
          file: join(process.cwd(), "no-such-program.exe"),
          args: [],
          cwd: process.cwd(),
          windowsVerbatimArguments: false,
        },
        process.env,
      ),
    ).rejects.toThrow();
  });
});

describe("Open and Resume on macOS and Linux (FR-43)", () => {
  const posix = (folderOk: boolean) => {
    const posixTerminal = vi.fn<typeof openPosixTerminal>(() =>
      Promise.resolve({ outcome: "started", message: "ok" }),
    );
    const launch = vi.fn(() => Promise.resolve());
    const executors = createOpenExecutors({
      programs: {
        ...programs,
        claude: "/usr/local/bin/claude",
        wt: null,
        cmd: null,
      },
      launch,
      folderExists: () => folderOk,
      transcriptExists: () => Promise.resolve(true),
      homeFolder: "/home/me",
      environment: { PATH: "/usr/bin:.", CLAUDECODE: "1", DISPLAY: ":0" },
      platform: "linux",
      posixTerminal,
    });
    return { executors, posixTerminal, launch };
  };
  const row = (): SessionView =>
    toSessionView({
      id: "abcd1234",
      sessionId: SESSION_ID,
      kind: "background",
      state: "done",
      cwd: "/home/me/work",
    });

  it("opens with only the checked ID, in the session's folder, with a cleaned environment", async () => {
    const { executors, posixTerminal, launch } = posix(true);
    expect((await executors.open(row())).outcome).toBe("started");
    const [claude, args, folder, env] = posixTerminal.mock.calls[0] ?? [];
    expect([claude, args, folder]).toEqual([
      "/usr/local/bin/claude",
      ["attach", "abcd1234"],
      "/home/me/work",
    ]);
    expect(env?.PATH).toBe("/usr/bin");
    expect(env?.CLAUDECODE).toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
  });

  it("opens in the home folder when the session's folder can't be used, and won't resume there", async () => {
    const { executors, posixTerminal } = posix(false);
    await executors.open(row());
    expect(posixTerminal.mock.calls[0]?.[2]).toBe("/home/me");
    expect((await executors.resume(row())).outcome).toBe("refused");
    expect(posixTerminal).toHaveBeenCalledTimes(1);
  });

  it("resumes by session ID, and ignores a second Resume straight after", async () => {
    const { executors, posixTerminal } = posix(true);
    await executors.resume(row());
    expect(posixTerminal.mock.calls[0]?.[1]).toEqual(["--resume", SESSION_ID]);
    expect((await executors.resume(row())).outcome).toBe("refused");
    expect(posixTerminal).toHaveBeenCalledTimes(1);
  });
});
