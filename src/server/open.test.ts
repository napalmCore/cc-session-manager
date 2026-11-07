import { describe, expect, it, vi } from "vitest";
import type { SessionView } from "../shared/protocol.js";
import { join } from "node:path";
import {
  createOpenExecutors,
  launchDetached,
  REPEAT_WINDOW_MS,
} from "./open.js";
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
      PATH: "C:\\bin",
      CLAUDECODE: "1",
      CLAUDE_CONFIG_DIR: "D:\\c",
    },
    now: () => now,
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
    expect(env).toEqual({ PATH: "C:\\bin", CLAUDE_CONFIG_DIR: "D:\\c" });
  });

  it("uses the home folder when the session's folder no longer exists", async () => {
    const { executors, launch } = setup({ folderExists: () => false });
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
