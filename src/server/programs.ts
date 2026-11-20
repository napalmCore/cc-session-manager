import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { planTerminal } from "./launch.js";
import { hasRawControl } from "./text-checks.js";
import { isValidSessionId } from "./transcripts.js";

/**
 * Absolute paths to the programs the tool starts (C-11). None is ever looked up in a
 * session's folder, so a program planted there can't run.
 */
export interface Programs {
  claude: string | null;
  wt: string | null;
  cmd: string | null;
  powershell: string | null;
}

/** Variables a running session sets. A `claude` that inherits them isn't listed. */
// Includes the list Claude Code 2.1.319 itself removes before starting a child session.
export const SESSION_IDENTITY_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_JOB_DIR",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_HOST_WORKTREE",
  "CLAUDE_CODE_HOST_WORKTREE_FENCE",
  "CLAUDE_CODE_CHROME_MCP_ORG_DENIED",
  "CLAUDE_CODE_EVAL_INTERVIEW_SESSION",
] as const;
const SESSION_IDENTITY_PREFIXES = ["CLAUDE_CODE_MESSAGING_", "CLAUDE_BG_"];

const SHORT_ID = /^[0-9a-f]{8}$/;
const ABSOLUTE_WINDOWS_PATH = /^(?:[A-Za-z]:\\|\\\\)/;
const NPM_CLAUDE_EXE = [
  "node_modules",
  "@anthropic-ai",
  "claude-code",
  "bin",
  "claude.exe",
];

function exists(path: string): boolean {
  try {
    // lstat, because an app execution alias such as wt.exe can't be read by stat.
    return !lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readVariable(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const key = Object.keys(env).find(
    (k) => k.toLowerCase() === name.toLowerCase(),
  );
  return key === undefined ? undefined : env[key];
}

/** Windows Terminal treats `;` and `%` specially, and a quote would break the command text. */
export function isSafeProgramPath(path: string): boolean {
  return ABSOLUTE_WINDOWS_PATH.test(path) && !/[;%"]/.test(path);
}

/** A program path on macOS or Linux: absolute, with no control characters (C-22). */
export function isSafePosixProgramPath(path: string): boolean {
  return path.startsWith("/") && !hasRawControl(path);
}

/**
 * The PATH entries that can be trusted on macOS and Linux: absolute ones only. An empty,
 * relative, or `.` entry means the current folder, which may be a session's folder (C-22).
 */
export function cleanPosixPath(path: string | undefined): string {
  return (path ?? "")
    .split(":")
    .filter((entry) => isSafePosixProgramPath(entry))
    .join(":");
}

function isExecutableFile(path: string): boolean {
  try {
    // stat follows links, as the native installer's `claude` is one.
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `claude` on macOS and Linux: the first executable file of that name on the cleaned PATH. */
export function findPosixClaude(env: NodeJS.ProcessEnv): string | null {
  return findPosixProgram("claude", env);
}

/** A program on macOS and Linux: the first executable file of that name on the cleaned PATH. */
export function findPosixProgram(
  name: string,
  env: NodeJS.ProcessEnv,
): string | null {
  for (const entry of cleanPosixPath(env.PATH).split(":")) {
    if (entry === "") continue;
    const candidate = posix.join(entry, name);
    if (isExecutableFile(candidate)) {
      return isSafePosixProgramPath(candidate) ? candidate : null;
    }
  }
  return null;
}

export function findClaude(env: NodeJS.ProcessEnv): string | null {
  const entries = (readVariable(env, "PATH") ?? "").split(";");
  for (const entry of entries) {
    if (!ABSOLUTE_WINDOWS_PATH.test(entry)) continue;
    const candidates = exists(join(entry, "claude.cmd"))
      ? [join(entry, ...NPM_CLAUDE_EXE), join(entry, "claude.exe")]
      : [join(entry, "claude.exe")];
    for (const candidate of candidates) {
      if (exists(candidate))
        return isSafeProgramPath(candidate) ? candidate : null;
    }
  }
  return null;
}

function systemProgram(
  env: NodeJS.ProcessEnv,
  ...parts: string[]
): string | null {
  const root = readVariable(env, "SystemRoot");
  if (root === undefined || !isSafeProgramPath(`${root}\\x`)) return null;
  const path = join(root, "System32", ...parts);
  return exists(path) ? path : null;
}

export function resolvePrograms(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Programs {
  // macOS and Linux: Windows Terminal, cmd, and PowerShell don't apply (FR-40).
  if (platform !== "win32") {
    return {
      claude: findPosixClaude(env),
      wt: null,
      cmd: null,
      powershell: null,
    };
  }
  const localAppData = readVariable(env, "LOCALAPPDATA");
  const wt =
    localAppData === undefined
      ? null
      : join(localAppData, "Microsoft", "WindowsApps", "wt.exe");
  return {
    claude: findClaude(env),
    wt: wt !== null && isSafeProgramPath(wt) && exists(wt) ? wt : null,
    cmd: systemProgram(env, "cmd.exe"),
    powershell: systemProgram(
      env,
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
  };
}

export function sessionLaunchEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const identity = new Set<string>(SESSION_IDENTITY_VARIABLES);
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !identity.has(key.toUpperCase()) &&
        !SESSION_IDENTITY_PREFIXES.some((prefix) =>
          key.toUpperCase().startsWith(prefix),
        ),
    ),
  );
  // On macOS and Linux, the launched program's own PATH is cleaned too, so an older npm
  // install's `#!/usr/bin/env node` can't find a `node` planted in the session's folder (C-22).
  if (platform !== "win32" && cleaned.PATH !== undefined) {
    const path = cleanPosixPath(cleaned.PATH);
    // An empty PATH would mean the current folder to execvp, so it's left out instead.
    if (path === "") delete cleaned.PATH;
    else cleaned.PATH = path;
  }
  return cleaned;
}

export type OpenTarget =
  { mode: "attach"; id: string } | { mode: "resume"; sessionId: string };

export interface LaunchPlan {
  file: string;
  args: string[];
  /** The session's folder, passed as the process's working directory, never in command text. */
  cwd: string;
  windowsVerbatimArguments: boolean;
}

/** Builds the fixed command for Open (FR-14). Throws if an ID is malformed or claude is missing. */
export function planOpen(
  programs: Programs,
  target: OpenTarget,
  cwd: string,
): LaunchPlan {
  if (programs.claude === null) throw new Error("claude.exe wasn't found");
  return planTerminal(programs, openArguments(target), cwd);
}

/** The fixed arguments for Open and Resume (FR-14). Throws if an ID is malformed. */
export function openArguments(target: OpenTarget): string[] {
  if (target.mode === "attach") {
    if (!SHORT_ID.test(target.id)) throw new Error("Invalid session ID");
    return ["attach", target.id];
  }
  if (!isValidSessionId(target.sessionId))
    throw new Error("Invalid session ID");
  return ["--resume", target.sessionId];
}
