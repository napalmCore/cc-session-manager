import { spawn } from "node:child_process";
import type { SessionView } from "../shared/protocol.js";
import type { ActionResult } from "./actions.js";
import {
  planOpen,
  sessionLaunchEnv,
  type LaunchPlan,
  type OpenTarget,
  type Programs,
} from "./programs.js";

/** A second Open or Resume of the same session within this time is ignored (FR-14). */
export const REPEAT_WINDOW_MS = 10_000;

export interface OpenOptions {
  programs: Programs;
  launch?: (plan: LaunchPlan, env: NodeJS.ProcessEnv) => Promise<void>;
  folderExists: (folder: string) => boolean;
  transcriptExists: (sessionId: string) => Promise<boolean>;
  homeFolder: string;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
}

/** Starts the planned terminal, detached from the tool, and resolves once it has started. */
export function launchDetached(
  plan: LaunchPlan,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.file, plan.args, {
      cwd: plan.cwd,
      env,
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

const started: ActionResult = {
  outcome: "started",
  message:
    "Terminal started. If the session can't open, the terminal says why.",
};

export function createOpenExecutors(options: OpenOptions) {
  const launch = options.launch ?? launchDetached;
  const now = options.now ?? Date.now;
  const env = sessionLaunchEnv(options.environment ?? process.env);
  const recent = new Map<string, number>();

  const start = async (
    key: string,
    target: OpenTarget,
    cwd: string,
  ): Promise<ActionResult> => {
    if (options.programs.claude === null) {
      return {
        outcome: "unavailable",
        message: "Claude Code's program wasn't found.",
      };
    }
    if (options.programs.wt === null && options.programs.conhost === null) {
      return {
        outcome: "unavailable",
        message: "No terminal program was found.",
      };
    }
    const last = recent.get(key);
    if (last !== undefined && now() - last <= REPEAT_WINDOW_MS) {
      return {
        outcome: "refused",
        message: "A terminal for this session was just started.",
      };
    }
    let plan: LaunchPlan;
    try {
      plan = planOpen(options.programs, target, cwd);
    } catch {
      return { outcome: "refused", message: "That session can't be opened." };
    }
    recent.set(key, now());
    try {
      await launch(plan, env);
      return started;
    } catch {
      recent.delete(key);
      return {
        outcome: "failed",
        message: "The terminal couldn't be started.",
      };
    }
  };

  return {
    open(session: SessionView): Promise<ActionResult> {
      if (session.id === undefined) {
        return Promise.resolve({
          outcome: "refused",
          message: "That session can't be opened.",
        });
      }
      // attach works from any folder, so a missing folder falls back to the home folder.
      const cwd =
        session.cwd !== undefined && options.folderExists(session.cwd)
          ? session.cwd
          : options.homeFolder;
      // Keyed by the short id, which is stable while a sessionId can appear between polls.
      return start(session.id, { mode: "attach", id: session.id }, cwd);
    },

    async resume(session: SessionView): Promise<ActionResult> {
      const { sessionId, cwd } = session;
      if (sessionId === undefined) {
        return {
          outcome: "refused",
          message: "That session can't be resumed.",
        };
      }
      // A resumed session works in the folder it's started in, so it must be the original.
      if (cwd === undefined || !options.folderExists(cwd)) {
        return {
          outcome: "refused",
          message: "The session's folder no longer exists.",
        };
      }
      if (!(await options.transcriptExists(sessionId))) {
        return {
          outcome: "refused",
          message: "That session has no saved conversation to resume.",
        };
      }
      return start(sessionId, { mode: "resume", sessionId }, cwd);
    },
  };
}
