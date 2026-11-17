import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "../shared/protocol.js";
import { createActionTracker } from "./actions.js";
import {
  cachedDriveType,
  checkLocalFolder,
  type DriveTypeReader,
} from "./local-folder.js";
import type { LaunchPlan, Programs } from "./programs.js";
import {
  type BackgroundRun,
  checkStartText,
  createStartExecutor,
  MAX_NAME,
  MAX_PROMPT,
  refusalMessage,
  type StartRequest,
} from "./start.js";
import { hasControl } from "./text-checks.js";
import type { ListingWatch } from "./stop-delete.js";

const programs: Programs = {
  claude: "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
  wt: "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe",
  cmd: "C:\\Windows\\System32\\cmd.exe",
  powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
};
const fixed: DriveTypeReader = () => Promise.resolve("Fixed");
const HOSTILE =
  '--dangerously-skip-permissions "q" ; a;b %PATH% ^ & | !\r\n\tend\\';

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccsm-start-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("folder checks (NFR-14, 0025)", () => {
  it("accepts an existing local folder, resolved", async () => {
    const result = await checkLocalFolder(root, fixed);
    expect(result.ok).toBe(true);
  });

  it.each([
    ["a network share", "\\\\server\\share\\work"],
    ["a device path", "\\\\?\\C:\\work"],
    ["a device namespace path", "\\\\.\\C:\\work"],
    ["a relative path", "work\\here"],
    ["a drive-relative path", "C:work"],
    ["an empty path", ""],
  ])("refuses %s", async (_label, folder) => {
    expect((await checkLocalFolder(folder, fixed)).ok).toBe(false);
  });

  it("refuses control characters", async () => {
    expect((await checkLocalFolder(`${root}\nx`, fixed)).ok).toBe(false);
  });

  // Windows drive types; macOS and Linux use the mount table (posix-folders tests).
  it.runIf(process.platform === "win32")(
    "refuses a network drive, and a drive whose type can't be read",
    async () => {
      const network = await checkLocalFolder(root, () =>
        Promise.resolve("Network"),
      );
      expect(network).toMatchObject({ ok: false });
      expect(network.ok ? "" : network.message).toMatch(/isn't a local folder/);
      const unread = await checkLocalFolder(root, () => Promise.resolve(null));
      expect(unread).toMatchObject({ ok: false });
      // A drive that couldn't be checked, as when PowerShell is slow, isn't called a network one.
      expect(unread.ok ? "" : unread.message).toMatch(/Couldn't check/);
    },
  );

  it("refuses a missing folder and a file", async () => {
    expect((await checkLocalFolder(join(root, "missing"), fixed)).ok).toBe(
      false,
    );
    const file = join(root, "file.txt");
    writeFileSync(file, "x");
    expect((await checkLocalFolder(file, fixed)).ok).toBe(false);
  });

  // Windows drive types; macOS and Linux use the mount table (posix-folders tests).
  it.runIf(process.platform === "win32")(
    "checks the drive of the resolved path too",
    async () => {
      const inner = join(root, "inner");
      mkdirSync(inner);
      const seen: string[] = [];
      await checkLocalFolder(inner, (letter) => {
        seen.push(letter);
        return Promise.resolve("Fixed");
      });
      expect(seen).toHaveLength(2);
    },
  );

  it("remembers a drive's type for a while, but not a failed read", async () => {
    let time = 0;
    const read = vi.fn<DriveTypeReader>((letter) =>
      Promise.resolve(letter === "Z" ? null : "Fixed"),
    );
    const cached = cachedDriveType(read, () => time);
    await cached("c");
    await cached("C");
    expect(read).toHaveBeenCalledTimes(1);
    await cached("Z");
    await cached("Z");
    expect(read).toHaveBeenCalledTimes(3);
    time += 31_000;
    await cached("C");
    expect(read).toHaveBeenCalledTimes(4);
  });
});

describe("name and prompt checks (NFR-14)", () => {
  it.each([
    ["background", "ok", "do it", null],
    [
      "background",
      undefined,
      undefined,
      "A background session needs a prompt.",
    ],
    ["background", undefined, "   ", "A background session needs a prompt."],
    [
      "background",
      undefined,
      "x".repeat(MAX_PROMPT + 1),
      `A prompt can be at most ${String(MAX_PROMPT)} characters.`,
    ],
    [
      "background",
      undefined,
      "a\u0000b",
      "A prompt can't contain control characters other than line breaks and tabs.",
    ],
    ["background", "50%", "go", "A name can't contain %."],
    ["interactive", "x $HOME", undefined, "A name can't contain $."],
    ["background", "a\tb", "go", "A name can't contain control characters."],
    [
      "background",
      "x".repeat(MAX_NAME + 1),
      "go",
      `A name can be at most ${String(MAX_NAME)} characters.`,
    ],
    ["interactive", "  ", undefined, "A name can't be only spaces."],
    [
      "interactive",
      undefined,
      "hello",
      "An interactive session starts without a prompt; type it in its terminal.",
    ],
    ["interactive", "-n x", undefined, null],
  ] as const)("%s, name %j, prompt %j", (kind, name, prompt, expected) => {
    expect(checkStartText(kind, name, prompt)).toBe(expected);
  });

  it("allows line breaks and tabs in a prompt, and an 8,000-character prompt", () => {
    expect(checkStartText("background", undefined, HOSTILE)).toBeNull();
    expect(
      checkStartText("background", undefined, "x".repeat(MAX_PROMPT)),
    ).toBeNull();
    expect(hasControl("a\tb", "\t")).toBe(false);
    expect(hasControl("a\u007fb")).toBe(true);
  });
});

describe("refusals in the tool's own words (FR-18, 0025)", () => {
  it.each([
    [
      "Workspace not trusted. Run `claude` in C:\\x once and accept the trust prompt, then retry.",
      /doesn't trust this folder/,
    ],
    ["Error: ENOENT: no such file or directory", /couldn't find that folder/],
    ["Not logged in. Please run /login", /isn't signed in/],
    ["The background service is outdated", /needs updating/],
    [
      "something secret-ish the user typed",
      /^Claude Code refused to start the session\.$/,
    ],
  ])("maps %j", (stderr, expected) => {
    const message = refusalMessage(stderr);
    expect(message).toMatch(expected);
    expect(message).not.toContain("secret");
    expect(message).not.toContain("C:\\x");
  });
});

function executor(
  run: (plan: LaunchPlan) => Promise<BackgroundRun>,
  options: { failed?: boolean; programs?: Programs } = {},
) {
  const launch = vi.fn<
    (plan: LaunchPlan, env: NodeJS.ProcessEnv) => Promise<void>
  >(() => Promise.resolve());
  const watch = vi.fn<ListingWatch>((predicate) => {
    const sessions = [
      { id: "abcd1234", state: options.failed ? "failed" : "working" },
    ] as SessionView[];
    return Promise.resolve({
      sawSuccess: true,
      met: predicate(sessions),
      sessions,
    });
  });
  const runSpy = vi.fn(run);
  const start = createStartExecutor({
    programs: options.programs ?? programs,
    driveType: fixed,
    launch,
    run: runSpy,
    watch,
    environment: { CLAUDECODE: "1", PATH: "x" },
  });
  return { start, launch, watch, run: runSpy };
}

const exited = (
  code: number,
  stdout: string,
  stderr = "",
): Promise<BackgroundRun> =>
  Promise.resolve({ kind: "exited", code, stdout, stderr });

describe("Start (FR-32)", () => {
  const background = (fields: Partial<StartRequest> = {}): StartRequest => ({
    action: "start",
    folder: root,
    kind: "background",
    prompt: HOSTILE,
    ...fields,
  });

  it("starts a background session, with options before --, and says so", async () => {
    const { start, run, watch } = executor(() =>
      exited(0, "backgrounded · abcd1234 · name\n  claude agents …\n"),
    );
    const result = await start(background({ name: "-n x" }));
    expect(result).toEqual({
      outcome: "succeeded",
      message: "Started in the background.",
    });
    const plan = run.mock.calls[0]?.[0];
    expect(plan?.file).toBe(programs.claude);
    expect(plan?.args).toEqual(["--bg", "--name=-n x", "--", HOSTILE]);
    expect(watch).toHaveBeenCalledTimes(1);
    // The prompt is never in the result (C-18).
    expect(JSON.stringify(result)).not.toContain("PATH");
  });

  it("says a session that failed straight away failed", async () => {
    const { start } = executor(() => exited(0, "backgrounded · abcd1234\n"), {
      failed: true,
    });
    expect(await start(background())).toEqual({
      outcome: "failed",
      message: "Claude Code started the session, but it failed straight away.",
    });
  });

  it("maps a refusal, and never shows Claude Code's own text", async () => {
    const { start, watch } = executor(() =>
      exited(
        1,
        "",
        "Workspace not trusted. Run `claude` in C:\\secret once and accept the trust prompt, then retry.",
      ),
    );
    const result = await start(background());
    expect(result.outcome).toBe("refused");
    expect(result.message).toMatch(/doesn't trust this folder/);
    expect(result.message).not.toContain("secret");
    expect(watch).not.toHaveBeenCalled();
  });

  it("is unknown on a timeout, or with no backgrounded line", async () => {
    expect(
      (
        await executor(() => Promise.resolve({ kind: "timeout" })).start(
          background(),
        )
      ).outcome,
    ).toBe("unknown");
    expect(
      (await executor(() => exited(0, "something else\n")).start(background()))
        .outcome,
    ).toBe("unknown");
  });

  it("refuses bad input before running anything", async () => {
    const { start, run } = executor(() =>
      exited(0, "backgrounded · abcd1234\n"),
    );
    expect((await start(background({ prompt: "" }))).outcome).toBe("refused");
    expect((await start(background({ name: "100%" }))).outcome).toBe("refused");
    expect(
      (await start(background({ folder: "\\\\server\\share" }))).outcome,
    ).toBe("refused");
    expect(run).not.toHaveBeenCalled();
  });

  it("opens an interactive session in a new terminal, with the folder only as its working folder", async () => {
    const { start, launch } = executor(() => exited(0, ""));
    const result = await start({
      action: "start",
      folder: root,
      kind: "interactive",
      name: "a;b c",
    });
    expect(result.outcome).toBe("started");
    const [plan, env] = launch.mock.calls[0] ?? [];
    expect(plan?.file).toBe(programs.wt);
    expect(plan?.args.slice(-2)).toEqual(["--name=a\\;b c", "--"]);
    expect(plan?.args.join(" ")).not.toContain(root);
    // The new session doesn't inherit the tool's own session identity.
    expect(env?.CLAUDECODE).toBeUndefined();
  });

  it("refuses a name without Windows Terminal, but starts without one", async () => {
    const { start, launch } = executor(() => exited(0, ""), {
      programs: { ...programs, wt: null },
    });
    const named = await start({
      action: "start",
      folder: root,
      kind: "interactive",
      name: "plain",
    });
    expect(named.outcome).toBe("refused");
    expect(named.message).toMatch(/needs Windows Terminal/);
    expect(launch).not.toHaveBeenCalled();
    const plain = await start({
      action: "start",
      folder: root,
      kind: "interactive",
    });
    expect(plain.outcome).toBe("started");
    expect(launch.mock.calls[0]?.[0].file).toBe(programs.cmd);
  });
});

describe("one Start at a time (NFR-14)", () => {
  it("refuses a second Start while one runs, and allows the next afterwards", async () => {
    let release: () => void = () => undefined;
    const start = vi.fn(
      () =>
        new Promise<{ outcome: "succeeded"; message: string }>((resolve) => {
          release = () => {
            resolve({ outcome: "succeeded", message: "ok" });
          };
        }),
    );
    const tracker = createActionTracker({
      listing: () => ({
        sessions: [],
        lastSuccessAt: Date.now(),
        lastPollFailed: false,
      }),
      freshListing: () => Promise.resolve([]),
      executors: {},
      isProtected: () => false,
      start,
    });
    const request: StartRequest = {
      action: "start",
      folder: root,
      kind: "background",
      prompt: "go",
    };
    const first = tracker.handle(request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await tracker.handle(request)).outcome).toBe("refused");
    release();
    expect((await first).outcome).toBe("succeeded");
    expect(start).toHaveBeenCalledTimes(1);
    const next = tracker.handle(request);
    release();
    expect((await next).outcome).toBe("succeeded");
  });
});

describe.runIf(process.platform === "win32")("the real drive-type read", () => {
  it("reads C: as a fixed drive, and refuses a bad letter without running anything", async () => {
    const { powershellDriveType } = await import("./local-folder.js");
    const { resolvePrograms } = await import("./programs.js");
    const read = powershellDriveType(resolvePrograms().powershell);
    expect(await read("C")).toBe("Fixed");
    expect(await read("C;calc")).toBeNull();
    expect(await read("1")).toBeNull();
  }, 15_000);
});

describe("text checks (NFR-14)", () => {
  it.each([
    ["a C1 control", "a\u0085b"],
    ["a right-to-left override", "safe\u202Etxt.exe"],
    ["a zero-width space", "a\u200Bb"],
    ["a line separator", "a\u2028b"],
    ["a soft hyphen", "a\u00ADb"],
    ["a byte-order mark", "\uFEFFname"],
    ["an isolate", "a\u2066b"],
  ])("refuses %s in a name", (_label, name) => {
    expect(hasControl(name)).toBe(true);
    expect(checkStartText("interactive", name, undefined)).toBe(
      "A name can't contain control characters.",
    );
  });

  it("allows ordinary text, including accents, CJK, and zero-width joiners", () => {
    expect(hasControl("\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645")).toBe(
      false,
    );
    expect(hasControl("\u{1F469}\u200D\u{1F4BB}")).toBe(false);
    expect(hasControl("Café 日本 – work")).toBe(false);
  });

  it("lets a prompt keep formatting marks pasted from a web page, but not control characters", () => {
    expect(
      checkStartText(
        "background",
        undefined,
        "soft\u00ADhyphen\u2028line \u202Etext",
      ),
    ).toBeNull();
    expect(checkStartText("background", undefined, "a\u0085b")).not.toBeNull();
  });

  it("checks sign-in before a missing folder", () => {
    expect(
      refusalMessage("Not logged in · Please run /login (file not found)"),
    ).toMatch(/isn't signed in/);
  });
});

describe("prompts, names, and Claude Code's text are never logged (C-18)", () => {
  it("writes nothing with them to the console or standard output", async () => {
    const SECRET = "SECRET-PROMPT-7731";
    const NAME = "SECRET-NAME-7731";
    const written: string[] = [];
    const spies = [
      vi
        .spyOn(console, "log")
        .mockImplementation((...args) => written.push(args.join(" "))),
      vi
        .spyOn(console, "error")
        .mockImplementation((...args) => written.push(args.join(" "))),
      vi
        .spyOn(console, "warn")
        .mockImplementation((...args) => written.push(args.join(" "))),
      vi
        .spyOn(console, "info")
        .mockImplementation((...args) => written.push(args.join(" "))),
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      }),
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      }),
    ];
    try {
      for (const run of [
        () => exited(0, "backgrounded · abcd1234\n"),
        () => exited(1, "", `refused because of ${SECRET}`),
        () => Promise.resolve({ kind: "timeout" } as const),
        () => Promise.resolve({ kind: "error" } as const),
      ]) {
        const { start } = executor(run);
        const result = await start({
          action: "start",
          folder: root,
          kind: "background",
          name: NAME,
          prompt: SECRET,
        });
        expect(JSON.stringify(result)).not.toContain("SECRET");
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(written.join("\n")).not.toContain("SECRET");
  });
});

describe("an interactive start logs no name either (C-18)", () => {
  it("writes nothing with the name, with or without Windows Terminal", async () => {
    const written: string[] = [];
    const spies = [
      vi
        .spyOn(console, "log")
        .mockImplementation((...args) => written.push(args.join(" "))),
      vi
        .spyOn(console, "error")
        .mockImplementation((...args) => written.push(args.join(" "))),
      vi
        .spyOn(console, "warn")
        .mockImplementation((...args) => written.push(args.join(" "))),
      vi
        .spyOn(console, "info")
        .mockImplementation((...args) => written.push(args.join(" "))),
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      }),
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      }),
    ];
    try {
      for (const programsUsed of [programs, { ...programs, wt: null }]) {
        const { start } = executor(() => exited(0, ""), {
          programs: programsUsed,
        });
        const result = await start({
          action: "start",
          folder: root,
          kind: "interactive",
          name: "SECRET-NAME-7731",
        });
        expect(JSON.stringify(result)).not.toContain("SECRET");
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(written.join("\n")).not.toContain("SECRET");
  });
});

describe("drive types read at once (review of #64)", () => {
  it("reads a drive once for many checks at the same time, and again after a failed read", async () => {
    let reads = 0;
    let answer: string | null = "Fixed";
    const reader = cachedDriveType(async () => {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return answer;
    });
    const types = await Promise.all(
      Array.from({ length: 50 }, () => reader("c")),
    );
    expect(reads).toBe(1);
    expect(new Set(types)).toEqual(new Set(["Fixed"]));

    answer = null;
    const other = cachedDriveType(async () => {
      reads += 1;
      await Promise.resolve();
      return answer;
    });
    await Promise.all([other("d"), other("d")]);
    expect(reads).toBe(2);
    await other("d");
    expect(reads).toBe(3);
  });
});
