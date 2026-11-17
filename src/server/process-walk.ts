import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { posix } from "node:path";

/**
 * Finds the Claude Code session that started the tool on macOS and Linux (FR-45, 0032), by
 * following its parent processes up to, but not including, process 1. Windows keeps reading the
 * variables Claude Code sets.
 */

/** What the walk learns about one process. */
export interface ProcessInfo {
  parent: number;
  /** When it started, in milliseconds since 1970, to the second. */
  startMs: number;
  /** Its program's path, where it can be read. */
  program: string | null;
  /** Its arguments, as given. */
  args: string[];
}

export type WalkResult =
  | { kind: "found"; pid: number; startMs: number }
  | { kind: "none" }
  | { kind: "failed" };

/**
 * Linux reports start times in clock ticks since boot. The kernel always shows them to programs
 * as USER_HZ, which is 100 on every architecture Node runs on, whatever the kernel's own rate.
 */
const LINUX_TICKS_PER_SECOND = 100;
const PS = "/bin/ps";
const PS_TIMEOUT_MS = 5_000;
/** A walk never goes deeper than this, so a loop in what's read can't hang it. */
const MAX_DEPTH = 64;

/** Whether a process is Claude Code's: its own program, a ClaudeCode.app host, or Node running its CLI. */
export function isClaudeProcess(info: ProcessInfo): boolean {
  const program = info.program ?? info.args[0] ?? "";
  if (posix.basename(program) === "claude") return true;
  if (program.includes("/ClaudeCode.app/")) return true;
  if (/\/claude\/versions\/[^/]+$/.test(program)) return true;
  // Some Linux systems install Node as nodejs.
  const isNode = (path: string) => /^node(js)?$/.test(posix.basename(path));
  const runsNode = isNode(program) || isNode(info.args[0] ?? "");
  return (
    runsNode &&
    info.args.some((arg) => arg.endsWith("@anthropic-ai/claude-code/cli.js"))
  );
}

/** Parses `/proc/<pid>/stat` after its last `)`, since a process name can hold one. */
export function parseLinuxStat(
  text: string,
  bootMs: number,
): { parent: number; startMs: number } | null {
  const fields = text
    .slice(text.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/);
  // After the name: state is field 3 of the line, the parent 4, the start time 22.
  const parent = Number(fields[1]);
  const ticks = Number(fields[19]);
  if (!Number.isInteger(parent) || !Number.isFinite(ticks)) return null;
  return {
    parent,
    startMs: bootMs + Math.round((ticks / LINUX_TICKS_PER_SECOND) * 1000),
  };
}

/** Reads a process on Linux through `/proc`, or null if its `stat` can't be read. */
export async function readLinuxProcess(
  pid: number,
  bootMs: number,
): Promise<ProcessInfo | null> {
  let stat: { parent: number; startMs: number } | null;
  try {
    stat = parseLinuxStat(
      await readFile(`/proc/${String(pid)}/stat`, "utf8"),
      bootMs,
    );
  } catch {
    return null;
  }
  if (stat === null) return null;
  let args: string[] = [];
  try {
    args = (await readFile(`/proc/${String(pid)}/cmdline`, "utf8"))
      .split("\0")
      .filter((arg) => arg !== "");
  } catch {
    // Its arguments can't be read; the program may still be.
  }
  let program: string | null;
  try {
    // Someone else's process, such as sshd or sudo, can't be read; its arguments stand in.
    program = await readlink(`/proc/${String(pid)}/exe`);
  } catch {
    program = null;
  }
  return { ...stat, program, args };
}

/** When Linux booted, from `/proc/stat`'s btime, in milliseconds since 1970. */
export async function linuxBootMs(): Promise<number | null> {
  try {
    const match = /^btime (\d+)$/m.exec(await readFile("/proc/stat", "utf8"));
    return match?.[1] === undefined ? null : Number(match[1]) * 1000;
  } catch {
    return null;
  }
}

/** Runs `ps` for one field of one process, as text, or null. */
function psField(pid: number, field: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      PS,
      ["-ww", "-o", `${field}=`, "-p", String(pid)],
      {
        timeout: PS_TIMEOUT_MS,
        env: { LC_ALL: "C", TZ: "UTC0", PATH: "/usr/bin:/bin" },
      },
      (error, stdout) => {
        resolve(error === null ? stdout.replace(/\n$/, "") : null);
      },
    );
  });
}

/** Reads a process on macOS through `ps`, one field at a time, so a space can't shift them. */
export async function readMacProcess(pid: number): Promise<ProcessInfo | null> {
  const [parent, lstart, comm, args] = await Promise.all([
    psField(pid, "ppid"),
    psField(pid, "lstart"),
    psField(pid, "comm"),
    psField(pid, "args"),
  ]);
  if (parent === null || lstart === null) return null;
  const parentPid = Number(parent.trim());
  const startMs = Date.parse(`${lstart.trim()} UTC`);
  if (!Number.isInteger(parentPid) || Number.isNaN(startMs)) return null;
  return {
    parent: parentPid,
    startMs,
    program: comm === null || comm.trim() === "" ? null : comm.trim(),
    // The arguments as ps shows them; only used to spot Node running Claude Code's CLI.
    args: (args ?? "").trim().split(/\s+/),
  };
}

/** Follows parent processes from `start` until a Claude Code process, or process 1. */
export async function walkToClaude(
  read: (pid: number) => Promise<ProcessInfo | null>,
  start: number = process.ppid,
): Promise<WalkResult> {
  let pid = start;
  for (let depth = 0; depth < MAX_DEPTH && pid > 1; depth += 1) {
    const info = await read(pid);
    if (info === null) return { kind: "failed" };
    if (isClaudeProcess(info)) {
      return { kind: "found", pid, startMs: info.startMs };
    }
    if (info.parent === pid) return { kind: "failed" };
    pid = info.parent;
  }
  return pid <= 1 ? { kind: "none" } : { kind: "failed" };
}

/** The walk on this system: `/proc` on Linux, `ps` on macOS. */
export async function walkFromHere(
  platform: NodeJS.Platform = process.platform,
): Promise<WalkResult> {
  if (platform === "darwin") return walkToClaude(readMacProcess);
  const boot = await linuxBootMs();
  if (boot === null) return { kind: "failed" };
  return walkToClaude((pid) => readLinuxProcess(pid, boot));
}
