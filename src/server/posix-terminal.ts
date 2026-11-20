import { spawn as nodeSpawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { posix } from "node:path";
import type { ActionResult } from "./actions.js";
import { findPosixProgram } from "./programs.js";
import { hasRawControl } from "./text-checks.js";

/**
 * Terminals on macOS and Linux (FR-43, 0032). macOS runs Open and Resume in Terminal through a
 * fixed AppleScript; Linux tries the listed terminals in order. When none can be used, the
 * action shows the exact command, quoted for `sh`, as a failed result.
 */

export const OSASCRIPT = "/usr/bin/osascript";
/** How long macOS gets to open the window, including a first Automation prompt. */
export const MAC_WAIT_MS = 120_000;
/** On Linux, a terminal still running after this has started; one that exited has failed. */
export const LINUX_SETTLE_MS = 2_000;

/** The fixed AppleScript: its one argument is the finished command, typed into Terminal. */
const APPLESCRIPT = [
  "on run argv",
  'tell application "Terminal"',
  "activate",
  "do script (item 1 of argv)",
  "end tell",
  "end run",
];

/** Quotes one word for `sh` with single quotes, so nothing inside it is read. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The command a user can run themselves: the folder first, then Claude Code and its arguments. */
export function commandText(
  claude: string,
  args: string[],
  folder: string,
): string {
  return `cd ${shQuote(folder)} && ${[claude, ...args].map(shQuote).join(" ")}`;
}

/** Whether there's a display a Linux terminal or browser can use (FR-42, FR-43). */
export function hasDisplay(env: NodeJS.ProcessEnv): boolean {
  return (
    (env.DISPLAY !== undefined && env.DISPLAY !== "") ||
    (env.WAYLAND_DISPLAY !== undefined && env.WAYLAND_DISPLAY !== "")
  );
}

/** Whether these arguments are only an attach or a resume of a checked session ID. */
function idsOnly(args: string[]): boolean {
  return (
    args.length === 2 &&
    ((args[0] === "attach" && /^[0-9a-f]{8}$/.test(args[1] ?? "")) ||
      (args[0] === "--resume" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          args[1] ?? "",
        )))
  );
}

export type LinuxTerminal = "gnome-terminal" | "konsole" | "xterm";
const LINUX_TERMINALS: LinuxTerminal[] = ["gnome-terminal", "konsole", "xterm"];
/** What `x-terminal-emulator` may lead to, by the name of the program it resolves to. */
const EMULATOR_TARGETS: Record<string, LinuxTerminal> = {
  "gnome-terminal": "gnome-terminal",
  "gnome-terminal.wrapper": "gnome-terminal",
  "gnome-terminal.real": "gnome-terminal",
  konsole: "konsole",
  xterm: "xterm",
};

/** The arguments for one Linux terminal, with the program and its arguments as separate words. */
export function linuxTerminalArgs(
  terminal: LinuxTerminal,
  claude: string,
  args: string[],
  folder: string,
): string[] {
  switch (terminal) {
    case "gnome-terminal":
      return ["--wait", `--working-directory=${folder}`, "--", claude, ...args];
    case "konsole":
      // --nofork, so it doesn't hand the window to a running Konsole and exit at once. Konsole
      // may expand $ in --workdir, so such a folder is only the working folder (0032).
      return folder.includes("$")
        ? ["--nofork", "-e", claude, ...args]
        : ["--nofork", "--workdir", folder, "-e", claude, ...args];
    case "xterm":
      return ["-e", claude, ...args];
  }
}

/** Where `x-terminal-emulator` leads, if it's a listed terminal, or null to skip it. */
export function emulatorTarget(resolved: string): LinuxTerminal | null {
  return EMULATOR_TARGETS[posix.basename(resolved)] ?? null;
}

export interface TerminalDeps {
  spawn?: typeof nodeSpawn;
  find?: (name: string, env: NodeJS.ProcessEnv) => string | null;
  realpath?: (path: string) => string;
  /** Checks the folder again just before a terminal starts. */
  folderOk: (folder: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
  /** The environment the tool itself was started with, for the display check. */
  toolEnv?: NodeJS.ProcessEnv;
  /** Shorter waits, for tests. */
  macWaitMs?: number;
  settleMs?: number;
}

const startedResult: ActionResult = {
  outcome: "started",
  message:
    "Terminal started. If Claude Code asks whether to trust the folder, answer it there.",
};

function showCommand(reason: string, command: string): ActionResult {
  return {
    outcome: "failed",
    message: `${reason} No session was started. To start it yourself, run this in a terminal: ${command}`,
  };
}

/** Runs one program and settles on how it ended, or `"running"` after `settleMs`. */
function runAndWatch(
  spawn: typeof nodeSpawn,
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  settleMs: number,
): Promise<"unstartable" | "running" | { code: number | null }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env,
        detached: true,
        stdio: "ignore",
      });
    } catch {
      resolve("unstartable");
      return;
    }
    let done = false;
    const finish = (
      value: "unstartable" | "running" | { code: number | null },
    ) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.unref();
      finish("running");
    }, settleMs);
    child.once("error", () => {
      finish("unstartable");
    });
    child.once("exit", (code) => {
      finish({ code });
    });
  });
}

/**
 * Opens `claude` with these arguments in a new terminal in `folder` on macOS or Linux. The
 * arguments were built by `claudeArguments` or are an attach or resume of a checked ID.
 */
export async function openPosixTerminal(
  claude: string,
  args: string[],
  folder: string,
  env: NodeJS.ProcessEnv,
  deps: TerminalDeps,
): Promise<ActionResult> {
  const spawn = deps.spawn ?? nodeSpawn;
  const platform = deps.platform ?? process.platform;
  const command = commandText(claude, args, folder);
  if (hasRawControl(folder) || hasRawControl(claude)) {
    return {
      outcome: "refused",
      message:
        "This folder's name has control characters, so it can't be opened safely. Open a terminal in it yourself.",
    };
  }

  if (platform === "darwin") {
    // A name would pass through Terminal's shell, so only IDs go through osascript (0031).
    if (!idsOnly(args)) {
      return showCommand(
        "On macOS, a new terminal session isn't opened for you.",
        command,
      );
    }
    // fish breaks on \ and tcsh on ! inside single quotes, so those show the command (0032).
    if (/[\\!]/.test(folder) || /[\\!]/.test(claude)) {
      return showCommand(
        "This folder's name can't be passed to Terminal safely.",
        command,
      );
    }
    if (!(await deps.folderOk(folder))) {
      return {
        outcome: "refused",
        message: "The session's folder can't be used.",
      };
    }
    const result = await runAndWatch(
      spawn,
      OSASCRIPT,
      [...APPLESCRIPT.flatMap((line) => ["-e", line]), "--", command],
      folder,
      env,
      deps.macWaitMs ?? MAC_WAIT_MS,
    );
    if (typeof result === "object" && result.code === 0) return startedResult;
    return showCommand(
      "Terminal didn't open. If macOS asked, allow Automation for the program the dashboard runs in, in System Settings, Privacy and Security, then try again.",
      command,
    );
  }

  // Linux.
  if (!hasDisplay(deps.toolEnv ?? env)) {
    return showCommand("There's no display to open a terminal on.", command);
  }
  const find = deps.find ?? findPosixProgram;
  const realpath = deps.realpath ?? ((path: string) => realpathSync(path));
  const order: LinuxTerminal[] = [];
  const emulator = find("x-terminal-emulator", env);
  if (emulator !== null) {
    let target: LinuxTerminal | null;
    try {
      target = emulatorTarget(realpath(emulator));
    } catch {
      target = null;
    }
    // One that leads to an unlisted terminal is skipped: some exit at once even when they open
    // a window (0032).
    if (target !== null) order.push(target);
  }
  for (const terminal of LINUX_TERMINALS) {
    if (!order.includes(terminal)) order.push(terminal);
  }

  for (const terminal of order) {
    const program = find(terminal, env);
    if (program === null) continue;
    // Konsole expands $NAME in every -e argument, so it's skipped if Claude Code's path or any
    // argument has a $. Names already refuse $ (0032); this keeps it so if that ever changes.
    if (
      terminal === "konsole" &&
      [claude, ...args].some((word) => word.includes("$"))
    ) {
      continue;
    }
    if (!(await deps.folderOk(folder))) {
      return {
        outcome: "refused",
        message: "The session's folder can't be used.",
      };
    }
    const result = await runAndWatch(
      spawn,
      program,
      linuxTerminalArgs(terminal, claude, args, folder),
      folder,
      env,
      deps.settleMs ?? LINUX_SETTLE_MS,
    );
    if (result === "unstartable") continue;
    if (result === "running") return startedResult;
    // It started and exited at once: stop here, so at most one window opens (0032).
    return showCommand("The terminal closed straight away.", command);
  }
  return showCommand("No terminal program could be started.", command);
}
