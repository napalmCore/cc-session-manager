import type { LaunchPlan, Programs } from "./programs.js";
import { isValidSessionId } from "./transcripts.js";

/** What a Start or Fork asks Claude Code to do (FR-32, FR-33). */
export interface ClaudeLaunch {
  kind: "background" | "interactive";
  /** Set for a fork: the session to continue in a new session. */
  forkOf?: string;
  name?: string;
  /** The starting prompt, for a background session only. */
  prompt?: string;
}

/**
 * The arguments for `claude`, with every option before `--`, so a prompt or name that starts
 * with `-` is never read as an option (C-15). Only `--bg`, `-n`, `--resume`, and
 * `--fork-session` are ever passed, and a fork always has `--fork-session`.
 */
export function claudeArguments(launch: ClaudeLaunch): string[] {
  const args: string[] = [];
  if (launch.forkOf !== undefined) {
    if (!isValidSessionId(launch.forkOf)) throw new Error("Invalid session ID");
    args.push("--resume", launch.forkOf, "--fork-session");
  }
  if (launch.kind === "background") args.push("--bg");
  if (launch.name !== undefined && launch.name !== "") {
    args.push("-n", launch.name);
  }
  args.push("--");
  if (launch.kind === "background") {
    if (launch.prompt === undefined || launch.prompt.trim() === "") {
      throw new Error("A background session needs a prompt");
    }
    args.push(launch.prompt);
  } else if (launch.prompt !== undefined && launch.prompt !== "") {
    throw new Error("An interactive session takes no prompt");
  }
  return args;
}

/** The MSVCRT escape of an argument's inside, as if it's wrapped in quotes. */
function msvcrtInner(value: string): string {
  let out = "";
  let backslashes = 0;
  for (const ch of value) {
    if (ch === "\\") {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      out += "\\".repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  return out + "\\".repeat(backslashes * 2);
}

/**
 * Escapes one argument for Windows Terminal, which re-reads its command line: it splits on `;`
 * and wraps an argument in quotes only when it has a space, without escaping quotes inside. So
 * the inside is MSVCRT-escaped, trailing backslashes stay doubled only when there's a space, and
 * `;` becomes `\;`. `%NAME%` and tabs can't be passed this way, so names refuse `%` and control
 * characters (0025). Proven with real sessions in design (U-24).
 */
export function windowsTerminalArgument(value: string): string {
  const inner = msvcrtInner(value);
  const escaped = value.includes(" ")
    ? inner
    : inner.replace(/(\\+)$/, (run) => run.slice(run.length / 2));
  return escaped.replace(/;/g, "\\;");
}

/**
 * A new terminal running `claude` with these arguments, in `cwd`, which is only ever the
 * process's working folder, never command text (NFR-7). Windows Terminal is preferred; without
 * it, `conhost.exe` opens a console window and runs `claude` directly, with no shell (0025).
 */
export function planTerminal(
  programs: Programs,
  args: string[],
  cwd: string,
): LaunchPlan {
  if (programs.claude === null) throw new Error("claude.exe wasn't found");
  if (programs.wt !== null) {
    return {
      file: programs.wt,
      args: [
        "-w",
        "new",
        "-d",
        ".",
        "--",
        programs.claude,
        ...args.map(windowsTerminalArgument),
      ],
      cwd,
      windowsVerbatimArguments: false,
    };
  }
  if (programs.conhost !== null) {
    return {
      file: programs.conhost,
      args: [programs.claude, ...args],
      cwd,
      windowsVerbatimArguments: false,
    };
  }
  throw new Error("No terminal program was found");
}

/** A background session: `claude` itself, with no shell and no terminal (FR-32). */
export function planBackground(
  programs: Programs,
  args: string[],
  cwd: string,
): LaunchPlan {
  if (programs.claude === null) throw new Error("claude.exe wasn't found");
  return { file: programs.claude, args, cwd, windowsVerbatimArguments: false };
}
