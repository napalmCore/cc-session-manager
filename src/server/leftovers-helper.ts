import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { HELPER_TIMEOUT_MS } from "./end.js";

/** A program recorded before an action, identified by process ID and creation time (U-16). */
export interface ProcessEntry {
  pid: number;
  startMs: number;
  name: string;
  /** The image path, or "" when it couldn't be read, in which case it can't be ended. */
  path: string;
}

/** The programs a session had just before an action, and the session's own process. */
export interface LeftoverRecord {
  session: { pid: number; startMs: number };
  entries: ProcessEntry[];
}

export interface ProcessId {
  pid: number;
  startMs: number;
}

export interface CheckRequest {
  processes: ProcessId[];
  /** Recorded programs, such as bash wrappers, to look under for new children. */
  parents: ProcessId[];
}

export interface CheckResult {
  running: ProcessId[];
  /** Still listed, but their start time couldn't be read. */
  unverified: ProcessId[];
  children: (ProcessEntry & { parentPid: number })[];
}

export interface EndLeftoversResult {
  requested: number;
  ended: number[];
  skipped: { pid: number; reason: string }[];
}

export type InputOutcome =
  | { kind: "ok"; result: Record<string, unknown> }
  | { kind: "timeout" }
  | { kind: "error" };

export type InputRun = (
  action: "check" | "end-leftovers",
  input: unknown,
) => Promise<InputOutcome>;

const MAX_TEXT = 32_768;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return "";
  return typeof value === "string" && value.length <= MAX_TEXT ? value : null;
}

function processId(value: unknown): ProcessId | null {
  if (value === null || typeof value !== "object") return null;
  const { pid, startMs } = value as Record<string, unknown>;
  return isCount(pid) && isCount(startMs) ? { pid, startMs } : null;
}

function entry(value: unknown): ProcessEntry | null {
  const id = processId(value);
  if (!id) return null;
  const fields = value as Record<string, unknown>;
  const name = text(fields.name);
  const path = text(fields.path);
  if (name === null || path === null) return null;
  return { ...id, name, path };
}

function list<T>(value: unknown, read: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.map(read).filter((item): item is T => item !== null);
}

/** The record in a helper result, or null if it has none or it's malformed. */
export function parseRecord(value: unknown): LeftoverRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const fields = value as Record<string, unknown>;
  const session = processId(fields.session);
  if (!session || !Array.isArray(fields.entries)) return null;
  return { session, entries: list(fields.entries, entry) };
}

export function parseCheck(
  result: Record<string, unknown>,
): CheckResult | null {
  if (result.ok !== true || result.action !== "check") return null;
  return {
    running: list(result.running, processId),
    unverified: list(result.unverified, processId),
    children: list(result.children, (item) => {
      const found = entry(item);
      const parentPid = (item as Record<string, unknown> | null)?.parentPid;
      return found && isCount(parentPid) ? { ...found, parentPid } : null;
    }),
  };
}

export function parseEndLeftovers(
  result: Record<string, unknown>,
): EndLeftoversResult | null {
  if (result.ok !== true || result.action !== "end-leftovers") return null;
  const requested = result.requested;
  return {
    requested: typeof requested === "number" ? requested : 0,
    ended: Array.isArray(result.ended) ? result.ended.filter(isCount) : [],
    skipped: list(result.skipped, (item) => {
      if (item === null || typeof item !== "object") return null;
      const { pid, reason } = item as Record<string, unknown>;
      return isCount(pid) && typeof reason === "string"
        ? { pid, reason }
        : null;
    }),
  };
}

/**
 * Runs the helper's check or end-leftovers mode, with the request as JSON on standard input,
 * never as arguments (FR-27). The only argument besides the mode is the tool's process ID.
 */
export function createInputRunner(
  powershell: string,
  script: string,
  toolPid: number = process.pid,
  timeoutMs: number = HELPER_TIMEOUT_MS,
): InputRun {
  return (action, input) =>
    new Promise((resolve) => {
      const child = execFile(
        powershell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          "-Action",
          action,
          "-ToolPid",
          String(toolPid),
        ],
        { cwd: dirname(script), timeout: timeoutMs, windowsHide: true },
        (error, stdout) => {
          if (
            error !== null &&
            (error.killed === true || typeof error.signal === "string")
          ) {
            resolve({ kind: "timeout" });
            return;
          }
          const line = stdout.trim().split(/\r?\n/).at(-1) ?? "";
          try {
            const parsed: unknown = JSON.parse(line);
            if (
              parsed !== null &&
              typeof parsed === "object" &&
              !Array.isArray(parsed)
            ) {
              resolve({
                kind: "ok",
                result: parsed as Record<string, unknown>,
              });
              return;
            }
          } catch {
            // Fall through: no usable result.
          }
          resolve({ kind: "error" });
        },
      );
      child.stdin?.on("error", () => {
        // A helper that exits early closes its input; the result says what happened.
      });
      child.stdin?.end(JSON.stringify(input));
    });
}
