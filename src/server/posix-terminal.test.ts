import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  commandText,
  emulatorTarget,
  linuxTerminalArgs,
  OSASCRIPT,
  openPosixTerminal,
  shQuote,
} from "./posix-terminal.js";

const CLAUDE = "/home/me/.local/bin/claude";
const SESSION = "11111111-1111-4111-8111-111111111111";
const DISPLAY = { DISPLAY: ":0" };
const ok = () => Promise.resolve(true);

type Ending = "error" | "throw" | "running" | number;

/** A process starter whose children end as listed, in order, recording each call. */
function fakeSpawn(...endings: Ending[]) {
  const calls: { file: string; args: string[]; cwd: string | undefined }[] = [];
  const fn = vi.fn(
    (file: string, args: string[], options: { cwd?: string }) => {
      calls.push({ file, args, cwd: options.cwd });
      const ending = endings[calls.length - 1] ?? "error";
      if (ending === "throw") throw new Error("can't run");
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      setTimeout(() => {
        if (ending === "error") child.emit("error", new Error("ENOENT"));
        else if (typeof ending === "number") child.emit("exit", ending);
      }, 0);
      return child;
    },
  );
  return { spawn: fn as unknown as typeof spawn, calls };
}

/** Finds the listed programs under /usr/bin, and nothing else. */
const findOnly =
  (...names: string[]) =>
  (name: string) =>
    names.includes(name) ? `/usr/bin/${name}` : null;

describe("quoting for sh (FR-43, NFR-20)", () => {
  it("keeps every hostile character inside single quotes", () => {
    expect(shQuote("a b")).toBe("'a b'");
    expect(shQuote("it's")).toBe("'it'\\''s'");
    // Run through a real sh, each word comes back unchanged.
    const hostile = [
      "plain",
      "it's",
      'say "hi"',
      "$HOME",
      "`id`",
      "a\\b",
      "x;y",
      "x&y",
      "x|y",
      "*",
      "-n",
      "line\nbreak",
    ];
    if (process.platform === "win32") return;
    const out = execFileSync(
      "/bin/sh",
      ["-c", `printf '%s\\0' ${hostile.map(shQuote).join(" ")}`],
      { encoding: "utf8" },
    );
    expect(out.split("\0").slice(0, -1)).toEqual(hostile);
  });

  it("puts the folder first, then Claude Code and its arguments", () => {
    expect(commandText(CLAUDE, ["--resume", SESSION], "/work/it's")).toBe(
      `cd '/work/it'\\''s' && '${CLAUDE}' '--resume' '${SESSION}'`,
    );
  });
});

describe("macOS Terminal (FR-43, 0031, 0032)", () => {
  const deps = { folderOk: ok, platform: "darwin" as const };

  it("runs a fixed AppleScript with the finished command as its one argument after --", async () => {
    const { spawn, calls } = fakeSpawn(0);
    const result = await openPosixTerminal(
      CLAUDE,
      ["--resume", SESSION],
      "/Users/me/my work",
      {},
      { ...deps, spawn },
    );
    expect(result.outcome).toBe("started");
    expect(calls[0]?.file).toBe(OSASCRIPT);
    const args = calls[0]?.args ?? [];
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe(
      `cd '/Users/me/my work' && '${CLAUDE}' '--resume' '${SESSION}'`,
    );
    // Every line before -- is fixed script text.
    expect(args.slice(0, -2).filter((_, i) => i % 2 === 0)).toEqual(
      Array(6).fill("-e"),
    );
  });

  it("shows the command for a New session or Fork, which could carry a name", async () => {
    const { spawn, calls } = fakeSpawn(0);
    const result = await openPosixTerminal(
      CLAUDE,
      ["--name=x", "--"],
      "/Users/me/work",
      {},
      { ...deps, spawn },
    );
    expect(result.outcome).toBe("failed");
    expect(result.message).toContain(
      `cd '/Users/me/work' && '${CLAUDE}' '--name=x' '--'`,
    );
    expect(calls).toHaveLength(0);
  });

  it("shows the command for a folder with \\ or !, and refuses one with a control character", async () => {
    for (const folder of ["/Users/me/a\\b", "/Users/me/wow!"]) {
      const { spawn, calls } = fakeSpawn(0);
      const result = await openPosixTerminal(
        CLAUDE,
        ["attach", "abcdef12"],
        folder,
        {},
        { ...deps, spawn },
      );
      expect(result.outcome).toBe("failed");
      expect(result.message).toContain("run this in a terminal");
      expect(calls).toHaveLength(0);
    }
    const { spawn, calls } = fakeSpawn(0);
    const result = await openPosixTerminal(
      CLAUDE,
      ["attach", "abcdef12"],
      "/Users/me/a\nb",
      {},
      { ...deps, spawn },
    );
    expect(result.outcome).toBe("refused");
    expect(calls).toHaveLength(0);
  });

  it("fails with the Automation hint when osascript is refused or times out", async () => {
    for (const ending of [1, "running"] as const) {
      const { spawn } = fakeSpawn(ending);
      const result = await openPosixTerminal(
        CLAUDE,
        ["attach", "abcdef12"],
        "/Users/me/work",
        {},
        { ...deps, spawn, macWaitMs: 20 },
      );
      expect(result.outcome).toBe("failed");
      expect(result.message).toContain("Automation");
    }
  });
});

describe("Linux terminals (FR-43, 0032)", () => {
  const base = { folderOk: ok, platform: "linux" as const, settleMs: 20 };

  it("passes the folder and the program's arguments as separate words", () => {
    const args = ["--resume", SESSION];
    expect(linuxTerminalArgs("gnome-terminal", CLAUDE, args, "/w")).toEqual([
      "--wait",
      "--working-directory=/w",
      "--",
      CLAUDE,
      ...args,
    ]);
    expect(linuxTerminalArgs("konsole", CLAUDE, args, "/w")).toEqual([
      "--nofork",
      "--workdir",
      "/w",
      "-e",
      CLAUDE,
      ...args,
    ]);
    // Konsole may expand $ in --workdir, so such a folder is only the working folder.
    expect(linuxTerminalArgs("konsole", CLAUDE, args, "/w/$x")).toEqual([
      "--nofork",
      "-e",
      CLAUDE,
      ...args,
    ]);
    expect(linuxTerminalArgs("xterm", CLAUDE, args, "/w")).toEqual([
      "-e",
      CLAUDE,
      ...args,
    ]);
  });

  it("follows x-terminal-emulator to a listed terminal, and skips an unlisted one", () => {
    expect(emulatorTarget("/usr/bin/gnome-terminal.wrapper")).toBe(
      "gnome-terminal",
    );
    expect(emulatorTarget("/usr/bin/konsole")).toBe("konsole");
    expect(emulatorTarget("/usr/bin/tilix")).toBeNull();
    expect(emulatorTarget("/usr/bin/kitty")).toBeNull();
  });

  it("starts the terminal x-terminal-emulator leads to first, in the session's folder", async () => {
    const { spawn, calls } = fakeSpawn("running");
    const result = await openPosixTerminal(
      CLAUDE,
      ["attach", "abcdef12"],
      "/home/me/w",
      {},
      {
        ...base,
        spawn,
        toolEnv: DISPLAY,
        find: findOnly("x-terminal-emulator", "gnome-terminal", "xterm"),
        realpath: () => "/usr/bin/xterm",
      },
    );
    expect(result.outcome).toBe("started");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("/usr/bin/xterm");
    expect(calls[0]?.cwd).toBe("/home/me/w");
  });

  it("tries the next terminal only when one can't be started", async () => {
    const { spawn, calls } = fakeSpawn("error", "throw", "running");
    const result = await openPosixTerminal(
      CLAUDE,
      ["attach", "abcdef12"],
      "/home/me/w",
      {},
      {
        ...base,
        spawn,
        toolEnv: DISPLAY,
        find: findOnly("gnome-terminal", "konsole", "xterm"),
      },
    );
    expect(result.outcome).toBe("started");
    expect(calls.map((call) => call.file)).toEqual([
      "/usr/bin/gnome-terminal",
      "/usr/bin/konsole",
      "/usr/bin/xterm",
    ]);
  });

  it("stops after a terminal that started and exited at once, showing the command", async () => {
    for (const code of [0, 1]) {
      const { spawn, calls } = fakeSpawn(code, "running");
      const result = await openPosixTerminal(
        CLAUDE,
        ["attach", "abcdef12"],
        "/home/me/w",
        {},
        {
          ...base,
          spawn,
          toolEnv: DISPLAY,
          find: findOnly("gnome-terminal", "xterm"),
        },
      );
      expect(result.outcome).toBe("failed");
      expect(result.message).toContain(
        `cd '/home/me/w' && '${CLAUDE}' 'attach' 'abcdef12'`,
      );
      expect(calls).toHaveLength(1);
    }
  });

  it("shows the command with no display, or no terminal, and starts nothing", async () => {
    const none = fakeSpawn("running");
    const noDisplay = await openPosixTerminal(
      CLAUDE,
      ["attach", "abcdef12"],
      "/home/me/w",
      {},
      { ...base, spawn: none.spawn, toolEnv: {}, find: findOnly("xterm") },
    );
    expect(noDisplay.outcome).toBe("failed");
    expect(noDisplay.message).toContain("no display");
    expect(none.calls).toHaveLength(0);

    const noTerminal = await openPosixTerminal(
      CLAUDE,
      ["attach", "abcdef12"],
      "/home/me/w",
      {},
      { ...base, spawn: none.spawn, toolEnv: DISPLAY, find: () => null },
    );
    expect(noTerminal.outcome).toBe("failed");
    expect(noTerminal.message).toContain("No terminal program");
    expect(none.calls).toHaveLength(0);
  });

  it("checks the folder again just before, and starts nothing if it's gone", async () => {
    const { spawn, calls } = fakeSpawn("running");
    const result = await openPosixTerminal(
      CLAUDE,
      ["attach", "abcdef12"],
      "/home/me/w",
      {},
      {
        ...base,
        spawn,
        toolEnv: DISPLAY,
        find: findOnly("xterm"),
        folderOk: () => Promise.resolve(false),
      },
    );
    expect(result.outcome).toBe("refused");
    expect(calls).toHaveLength(0);
  });
});

// Real programs, on macOS and Linux only (C-22).
describe.runIf(process.platform !== "win32")("real terminals (C-22)", () => {
  const folder = mkdtempSync(join(tmpdir(), "ccsm-terminal-"));
  const bin = mkdtempSync(join(tmpdir(), "ccsm-terminal-bin-"));
  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });
  const plant = (dir: string, name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };

  it("never runs a terminal planted in the session's folder or found through a relative PATH entry", async () => {
    const marker = join(folder, "ran");
    plant(folder, "xterm", `touch '${marker}'`);
    plant(folder, "x-terminal-emulator", `touch '${marker}'`);
    const result = await openPosixTerminal(
      CLAUDE,
      ["attach", "abcdef12"],
      folder,
      { PATH: ".::bin" },
      {
        folderOk: ok,
        platform: "linux",
        toolEnv: DISPLAY,
        settleMs: 200,
      },
    );
    expect(result.outcome).toBe("failed");
    expect(existsSync(marker)).toBe(false);
  });

  it("reports a real terminal still running as started, and one that exits as failed", async () => {
    plant(bin, "xterm", "sleep 1");
    const running = await openPosixTerminal(
      CLAUDE,
      ["attach", "abcdef12"],
      folder,
      { PATH: bin },
      {
        folderOk: ok,
        platform: "linux",
        toolEnv: DISPLAY,
        settleMs: 300,
      },
    );
    expect(running.outcome).toBe("started");

    plant(bin, "xterm", "exit 0");
    const exited = await openPosixTerminal(
      CLAUDE,
      ["attach", "abcdef12"],
      folder,
      { PATH: bin },
      {
        folderOk: ok,
        platform: "linux",
        toolEnv: DISPLAY,
        settleMs: 2_000,
      },
    );
    expect(exited.outcome).toBe("failed");
  });
});
