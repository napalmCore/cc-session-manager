import { execFile } from "node:child_process";
import { homedir } from "node:os";
import type { SessionView } from "../shared/protocol.js";
import type { ActionResult } from "./actions.js";
import type { ListingState } from "./actions.js";
import { sessionLaunchEnv } from "./programs.js";

/** Both commands, and the listing watch afterwards, have this limit (FR-15, FR-16). */
export const COMMAND_TIMEOUT_MS = 15_000;
export const WATCH_MS = 15_000;

export type CliResult =
  | { kind: "exited"; code: number; stdout: string; stderr?: string }
  | { kind: "timeout" }
  | { kind: "error" };

/** Waits until a successful poll after the action satisfies the predicate, or the time runs out. */
export type ListingWatch = (
  predicate: (sessions: SessionView[]) => boolean,
) => Promise<{ sawSuccess: boolean; met: boolean; sessions: SessionView[] }>;

export interface StopDeleteOptions {
  claudeAvailable: boolean;
  run: (args: string[]) => Promise<CliResult>;
  watch: ListingWatch;
}

const FINISHED_STATES = new Set(["stopped", "done", "failed"]);
// The CLI prints "kept <id> — ..." when it keeps a session to protect its worktree. Matching
// its wording means a change there only turns "Kept" into "Failed", never into success.
const KEPT = /^kept\s/im;

const unknown: ActionResult = {
  outcome: "unknown",
  message: "Couldn't confirm the result. Check the session list.",
};

/** Runs claude.exe directly, with no shell, from the home folder (C-11). */
export function runClaude(
  claudeExe: string,
  args: string[],
  timeoutMs: number = COMMAND_TIMEOUT_MS,
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      claudeExe,
      args,
      {
        cwd: homedir(),
        env: sessionLaunchEnv(process.env),
        timeout: timeoutMs,
        maxBuffer: 1_000_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ kind: "exited", code: 0, stdout, stderr });
        } else if (error.killed === true || typeof error.signal === "string") {
          resolve({ kind: "timeout" });
        } else if (typeof error.code === "number") {
          resolve({ kind: "exited", code: error.code, stdout, stderr });
        } else {
          resolve({ kind: "error" });
        }
      },
    );
  });
}

/** Watches the poller's listing, which refreshes every few seconds. */
export function watchPoller(
  state: () => ListingState,
  timeoutMs: number = WATCH_MS,
  intervalMs = 500,
): ListingWatch {
  return async (predicate) => {
    const startedAt = Date.now();
    let sawSuccess = false;
    let sessions: SessionView[] = [];
    while (Date.now() - startedAt <= timeoutMs) {
      const current = state();
      if (current.lastSuccessAt !== null && current.lastSuccessAt > startedAt) {
        sawSuccess = true;
        sessions = current.sessions;
        if (predicate(sessions)) return { sawSuccess, met: true, sessions };
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return { sawSuccess, met: false, sessions };
  };
}

export function createStopDeleteExecutors(options: StopDeleteOptions) {
  const unavailable: ActionResult = {
    outcome: "unavailable",
    message: "Claude Code's program wasn't found.",
  };

  return {
    async stop(session: SessionView): Promise<ActionResult> {
      if (!options.claudeAvailable) return unavailable;
      const id = session.id;
      if (id === undefined)
        return {
          outcome: "refused",
          message: "That session can't be stopped.",
        };

      const cli = await options.run(["stop", id]);
      if (cli.kind !== "exited") return unknown;
      // claude stop exits 0 even when nothing changed, so the listing decides.
      const watched = await options.watch((sessions) =>
        sessions.some(
          (s) =>
            s.id === id &&
            s.state !== undefined &&
            FINISHED_STATES.has(s.state) &&
            s.pid === undefined,
        ),
      );
      if (!watched.sawSuccess) return unknown;
      return watched.met
        ? {
            outcome: "succeeded",
            message: "Stopped. The conversation is kept.",
          }
        : { outcome: "failed", message: "The session didn't stop. Try again." };
    },

    async delete(session: SessionView): Promise<ActionResult> {
      if (!options.claudeAvailable) return unavailable;
      const id = session.id;
      if (id === undefined)
        return {
          outcome: "refused",
          message: "That session can't be deleted.",
        };

      // Plain rm only: never --discard-unpushed or --force-remove-worktree (C-8).
      const cli = await options.run(["rm", id]);
      if (cli.kind !== "exited") return unknown;
      const watched = await options.watch(
        (sessions) => !sessions.some((s) => s.id === id),
      );
      if (!watched.sawSuccess) return unknown;

      if (watched.met) {
        return cli.code === 0
          ? { outcome: "succeeded", message: "Deleted." }
          : {
              outcome: "succeeded",
              message:
                "Deleted, though Claude Code reported a problem while doing it.",
            };
      }
      if (cli.code === 0) return unknown;
      if (KEPT.test(cli.stdout)) {
        return {
          outcome: "kept",
          message:
            "Claude Code kept this session to protect its work, such as uncommitted changes, or because another session is using its folder. Save or close that work, then finish in the CLI.",
        };
      }
      return {
        outcome: "failed",
        message: "The session couldn't be deleted. Try again later.",
      };
    },
  };
}
