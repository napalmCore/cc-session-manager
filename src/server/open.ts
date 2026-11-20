import { spawn } from "node:child_process";
import type { SessionView } from "../shared/protocol.js";
import type { ActionResult } from "./actions.js";
import { openPosixTerminal } from "./posix-terminal.js";
import {
  openArguments,
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
  folderExists: (folder: string) => boolean | Promise<boolean>;
  transcriptExists: (sessionId: string) => Promise<boolean>;
  homeFolder: string;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  platform?: NodeJS.Platform;
  /** The macOS and Linux terminal (FR-43); a stand-in in tests. */
  posixTerminal?: typeof openPosixTerminal;
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
  const platform = options.platform ?? process.platform;
  const env = sessionLaunchEnv(options.environment ?? process.env, platform);
  const posixTerminal = options.posixTerminal ?? openPosixTerminal;
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
    if (platform !== "win32") {
      const claude = options.programs.claude;
      const last = recent.get(key);
      if (last !== undefined && now() - last <= REPEAT_WINDOW_MS) {
        return {
          outcome: "refused",
          message: "A terminal for this session was just started.",
        };
      }
      let args: string[];
      try {
        args = openArguments(target);
      } catch {
        return { outcome: "refused", message: "That session can't be opened." };
      }
      recent.set(key, now());
      const result = await posixTerminal(claude, args, cwd, env, {
        folderOk: async (folder) => await options.folderExists(folder),
        platform,
        toolEnv: options.environment ?? process.env,
      });
      if (result.outcome !== "started") recent.delete(key);
      return result;
    }
    if (options.programs.wt === null && options.programs.cmd === null) {
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
    async open(session: SessionView): Promise<ActionResult> {
      if (session.id === undefined) {
        return {
          outcome: "refused",
          message: "That session can't be opened.",
        };
      }
      // attach works from any folder, so a missing folder, or one that isn't local, falls back
      // to the home folder.
      const cwd =
        session.cwd !== undefined && (await options.folderExists(session.cwd))
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
      if (cwd === undefined || !(await options.folderExists(cwd))) {
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
