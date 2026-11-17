import { execFile } from "node:child_process";
import { z } from "zod";
import type { SessionView } from "../shared/protocol.js";
import { isValidSessionId } from "./transcripts.js";

/** A Claude Code session that started the tool, or handed over to it (FR-22). */
export interface Identity {
  sessionId?: string;
  pid?: number;
  /** When that process started, so a reused process ID isn't mistaken for it. */
  pidStartMs?: number;
  /**
   * True when that start time was read to the whole second, rounded down, as the macOS and Linux
   * walk reads it, so it can be up to a second early (FR-45, 0032).
   */
  startToSecond?: boolean;
  /** True when the start came from inside a Claude Code session, even with no IDs. */
  insideClaude: boolean;
}

export const identitySchema = z
  .object({
    sessionId: z
      .string()
      .max(64)
      .refine((value) => isValidSessionId(value))
      .optional(),
    pid: z.number().int().positive().max(0xffffffff).optional(),
    pidStartMs: z.number().int().positive().optional(),
    startToSecond: z.boolean().optional(),
    insideClaude: z.boolean(),
  })
  .strict();

/** A handed-over identity, with absent values left out. */
export function toIdentity(parsed: z.infer<typeof identitySchema>): Identity {
  const identity: Identity = { insideClaude: parsed.insideClaude };
  if (parsed.sessionId !== undefined) identity.sessionId = parsed.sessionId;
  if (parsed.pid !== undefined) identity.pid = parsed.pid;
  if (parsed.pidStartMs !== undefined) identity.pidStartMs = parsed.pidStartMs;
  if (parsed.startToSecond !== undefined) {
    identity.startToSecond = parsed.startToSecond;
  }
  return identity;
}

// The listed start time comes from the CLI a moment after its process starts, so it may be a
// little later than the process's own start time.
const LISTED_BEFORE_MS = 1_000;
const LISTED_AFTER_MS = 5_000;
// A start time read to the second can be up to a second early, so the listed one may be a
// second later still: 6 seconds in all, as the design says (0032).
const ROUNDED_START_MS = 1_000;
const LOOKUP_TIMEOUT_MS = 10_000;

export const PROTECTED_MESSAGE =
  "This session started the dashboard, so it can't be changed from here.";
export const UNKNOWN_MESSAGE =
  "The dashboard was started, or started again, from a Claude Code session it can't find in the list, so Stop, Delete, End, and Send are turned off to keep that session safe. To use them, stop the dashboard with Ctrl+C in its terminal, then start it from a normal terminal.";

function flag(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0";
}

/** Reads the variables Claude Code sets for the programs it starts. Never throws. */
export function readIdentity(env: NodeJS.ProcessEnv): Identity {
  const identity: Identity = {
    insideClaude:
      flag(env.CLAUDECODE) ||
      flag(env.CLAUDE_CODE_CHILD_SESSION) ||
      env.CLAUDE_CODE_SESSION_ID !== undefined ||
      env.CLAUDE_PID !== undefined,
  };
  const sessionId = env.CLAUDE_CODE_SESSION_ID;
  if (sessionId !== undefined && isValidSessionId(sessionId)) {
    identity.sessionId = sessionId;
  }
  const pid = env.CLAUDE_PID;
  if (pid !== undefined && /^[1-9][0-9]{0,9}$/.test(pid)) {
    const value = Number(pid);
    if (value <= 0xffffffff) identity.pid = value;
  }
  return identity;
}

/** A process's start time, in milliseconds since 1970, or null if it can't be read. */
export function processStartMs(
  powershell: string | null,
  pid: number,
): Promise<number | null> {
  if (powershell === null || !Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve(null);
  }
  const command = `[DateTimeOffset]::new((Get-Process -Id ${String(pid)} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`;
  return new Promise((resolve) => {
    execFile(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        const value = Number(stdout.trim());
        resolve(
          error === null && Number.isInteger(value) && value > 0 ? value : null,
        );
      },
    );
  });
}

function matches(identity: Identity, session: SessionView): boolean {
  if (
    identity.sessionId !== undefined &&
    session.sessionId === identity.sessionId
  ) {
    return true;
  }
  if (identity.pid === undefined || session.pid !== identity.pid) return false;
  // Without both start times, protect anyway: blocking a reused process ID is the safe mistake.
  if (identity.pidStartMs === undefined || session.startedAt === undefined) {
    return true;
  }
  return (
    session.startedAt >= identity.pidStartMs - LISTED_BEFORE_MS &&
    session.startedAt <=
      identity.pidStartMs +
        LISTED_AFTER_MS +
        (identity.startToSecond === true ? ROUNDED_START_MS : 0)
  );
}

export function createProtection(initial: Identity[] = []) {
  const identities: { identity: Identity; seen: boolean }[] = [];
  const add = (identity: Identity) => {
    if (!identity.insideClaude) return;
    identities.push({ identity, seen: false });
  };
  for (const identity of initial) add(identity);

  return {
    add,
    /**
     * Called with each live listing, so a protected session counts as found once it's listed.
     * Returns true when that changes the blocked reason, so the caller can publish it.
     */
    observe(sessions: SessionView[]): boolean {
      const before = identities.some((entry) => !entry.seen);
      for (const entry of identities) {
        if (sessions.some((session) => matches(entry.identity, session))) {
          entry.seen = true;
        }
      }
      return identities.some((entry) => !entry.seen) !== before;
    },
    /**
     * Why actions are turned off for every session, or null. A start from inside Claude Code
     * whose session has never been listed could be any of them.
     */
    blockedReason(): string | null {
      return identities.some((entry) => !entry.seen) ? UNKNOWN_MESSAGE : null;
    },
    /** A refusal message for Stop, Delete, and End on this session, or false. */
    isProtected(session: SessionView): string | false {
      if (identities.some((entry) => matches(entry.identity, session))) {
        return PROTECTED_MESSAGE;
      }
      return identities.some((entry) => !entry.seen) ? UNKNOWN_MESSAGE : false;
    },
  };
}
