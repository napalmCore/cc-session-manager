import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionView } from "../shared/protocol.js";
import type { ActionResult, CloseRecord } from "./actions.js";
import type { ListingWatch } from "./stop-delete.js";

/** The helper's own limit, and how long End waits for the session to leave the listing. */
export const HELPER_TIMEOUT_MS = 10_000;
export const CLOSE_WAIT_MS = 5_000;

export interface HelperArgs {
  action: "inspect" | "break" | "force";
  pid: number;
  startedAtMs: number;
  expectedStartMs?: number;
}

export type HelperOutcome =
  | { kind: "ok"; result: Record<string, unknown> }
  | { kind: "timeout" }
  | { kind: "error" };

export type HelperRun = (args: HelperArgs) => Promise<HelperOutcome>;

export interface EndOptions {
  helperAvailable: boolean;
  run: HelperRun;
  /** Watches the listing for up to CLOSE_WAIT_MS after a signal. */
  watch: ListingWatch;
  /** A listing taken now, or null if it couldn't be read. Confirms a "still running" result. */
  confirmListing: () => Promise<SessionView[] | null>;
}

/** The helper script, shipped in the repository's assets folder. */
export function helperScriptPath(): string {
  return fileURLToPath(
    new URL("../../assets/process-helper.ps1", import.meta.url),
  );
}

/** Runs the helper with numbers-only arguments, from its own folder, with no shell. */
export function createHelperRunner(
  powershell: string,
  script: string,
): HelperRun {
  return (args) =>
    new Promise((resolve) => {
      const argv = [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Action",
        args.action,
        "-TargetPid",
        String(args.pid),
        "-StartedAtMs",
        String(args.startedAtMs),
      ];
      if (args.expectedStartMs !== undefined) {
        argv.push("-ExpectedStartMs", String(args.expectedStartMs));
      }
      execFile(
        powershell,
        argv,
        { cwd: dirname(script), timeout: HELPER_TIMEOUT_MS, windowsHide: true },
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
    });
}

export function helperAvailable(
  powershell: string | null,
  script: string,
): boolean {
  return powershell !== null && existsSync(script);
}

const REFUSALS: Record<string, string> = {
  "unexpected-member":
    "Another program shares this session's terminal, so it can't be ended safely from here.",
  "wrong-image": "That process isn't a Claude Code session anymore.",
  "start-time-mismatch": "That process isn't the same session anymore.",
  "target-exited": "The session has already ended.",
  "not-running": "The session has already ended.",
  "no-console": "This session has no terminal the tool can reach.",
  "access-denied": "The tool isn't allowed to end that process.",
};
const HELPER_FAILURES = new Set(["send-failed", "member-list-failed"]);
const GIT_BASH_IMAGES = new Set(["bash", "sh"]);

function reasonCode(result: Record<string, unknown>): string {
  return typeof result.reason === "string"
    ? (result.reason.split(":")[0] ?? "")
    : "";
}

function refusal(code: string): ActionResult {
  return {
    outcome: "refused",
    message: REFUSALS[code] ?? "The session couldn't be ended.",
  };
}

const unknown: ActionResult = {
  outcome: "unknown",
  message: "Couldn't confirm the result. Check the session list.",
};
const unavailable: ActionResult = {
  outcome: "unavailable",
  message:
    "Ending sessions needs Windows PowerShell, which isn't available here.",
};

export function createEndExecutors(options: EndOptions) {
  const goneFrom = (session: SessionView) => (sessions: SessionView[]) =>
    !sessions.some(
      (s) =>
        s.sessionId === session.sessionId &&
        s.pid === session.pid &&
        !s.finished,
    );

  return {
    async end(session: SessionView): Promise<ActionResult> {
      if (!options.helperAvailable) return unavailable;
      const { pid, startedAt } = session;
      if (pid === undefined || startedAt === undefined) {
        return {
          outcome: "refused",
          message: "That session can't be ended from here.",
        };
      }

      const helper = await options.run({
        action: "break",
        pid,
        startedAtMs: startedAt,
      });
      if (helper.kind === "timeout") return unknown;
      if (helper.kind === "error") {
        return {
          outcome: "failed",
          message: "The tool's helper couldn't run.",
        };
      }
      const { result } = helper;
      const code = reasonCode(result);
      const startMs =
        typeof result.startMs === "number" ? result.startMs : undefined;

      if (code === "unavailable") return unavailable;
      // Git Bash hides its shell from the safety check, so there's no reliable normal close, and
      // Force end is offered straight away (decision 0015).
      if (
        code === "unexpected-member" &&
        typeof result.unexpectedImage === "string" &&
        GIT_BASH_IMAGES.has(result.unexpectedImage.toLowerCase()) &&
        startMs !== undefined
      ) {
        return {
          outcome: "not-closed",
          message:
            "This session was started from Git Bash, so it can't be closed normally from here. Use its own terminal, or Force end it.",
          closeRecord: { pid, processStartMs: startMs },
        };
      }
      if (HELPER_FAILURES.has(code)) {
        return { outcome: "failed", message: "The session couldn't be ended." };
      }
      if (result.ok !== true || code !== "sent") return refusal(code);
      // The break was sent, but without the start time there's no safe Force end.
      if (startMs === undefined) return unknown;

      const isGone = goneFrom(session);
      const watched = await options.watch(isGone);
      if (!watched.sawSuccess) return unknown;
      const ended: ActionResult = {
        outcome: "succeeded",
        message: "Ended. The conversation is kept.",
      };
      if (watched.met) return ended;
      // The last poll the watch saw may predate the close, so check once more with a listing
      // taken now, before saying the session is still running.
      const confirmed = await options.confirmListing();
      if (confirmed === null) return unknown;
      if (isGone(confirmed)) return ended;
      return {
        outcome: "not-closed",
        message:
          "The session is still running. You can Force end it, which may lose work in progress.",
        closeRecord: { pid, processStartMs: startMs },
      };
    },

    async forceEnd(
      session: SessionView,
      record: CloseRecord,
    ): Promise<ActionResult> {
      if (!options.helperAvailable) return unavailable;
      const { pid, startedAt } = session;
      if (
        pid === undefined ||
        startedAt === undefined ||
        pid !== record.pid ||
        !Number.isInteger(record.processStartMs) ||
        record.processStartMs <= 0
      ) {
        return {
          outcome: "refused",
          message: "That process isn't the same session anymore.",
        };
      }

      const helper = await options.run({
        action: "force",
        pid,
        startedAtMs: startedAt,
        expectedStartMs: record.processStartMs,
      });
      if (helper.kind === "timeout") return unknown;
      if (helper.kind === "error") {
        return {
          outcome: "failed",
          message: "The tool's helper couldn't run.",
        };
      }
      const code = reasonCode(helper.result);
      if (code === "unavailable") return unavailable;
      if (code === "target-not-ended") {
        return { outcome: "failed", message: "The session couldn't be ended." };
      }
      if (helper.result.ok !== true || code !== "ended") return refusal(code);

      const watched = await options.watch(goneFrom(session));
      if (watched.sawSuccess && watched.met) {
        return {
          outcome: "succeeded",
          message:
            "Force ended, with the programs it started that were still running under it.",
        };
      }
      return unknown;
    },
  };
}
