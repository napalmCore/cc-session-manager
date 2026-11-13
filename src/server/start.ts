import { execFile } from "node:child_process";
import type { SessionView } from "../shared/protocol.js";
import type { ActionResult } from "./actions.js";
import { claudeArguments, planBackground, planTerminal } from "./launch.js";
import { checkLocalFolder, type DriveTypeReader } from "./local-folder.js";
import { hasControl, hasRawControl } from "./text-checks.js";
import {
  type LaunchPlan,
  type Programs,
  sessionLaunchEnv,
} from "./programs.js";
import type { ListingWatch } from "./stop-delete.js";

/** Limits from NFR-14. */
export const MAX_PROMPT = 8000;
export const MAX_NAME = 100;
/** A background start's own time limit, and how long a new session is watched for a failure. */
export const BACKGROUND_TIMEOUT_MS = 30_000;
export const FAILURE_WATCH_MS = 10_000;

export interface StartRequest {
  action: "start";
  folder: string;
  kind: "background" | "interactive";
  name?: string | undefined;
  prompt?: string | undefined;
}

const refused = (message: string): ActionResult => ({
  outcome: "refused",
  message,
});

/** Checks a name and prompt by NFR-14. Returns a refusal message, or null if they're fine. */
export function checkStartText(
  kind: StartRequest["kind"],
  name: string | undefined,
  prompt: string | undefined,
): string | null {
  if (name !== undefined && name !== "") {
    if (name.trim() === "") return "A name can't be only spaces.";
    if (name.length > MAX_NAME) {
      return `A name can be at most ${String(MAX_NAME)} characters.`;
    }
    if (hasControl(name)) return "A name can't contain control characters.";
    if (name.includes("%")) return "A name can't contain %.";
  }
  if (kind === "background") {
    if (prompt === undefined || prompt.trim() === "") {
      return "A background session needs a prompt.";
    }
    if (prompt.length > MAX_PROMPT) {
      return `A prompt can be at most ${String(MAX_PROMPT)} characters.`;
    }
    if (hasRawControl(prompt, "\n\r\t")) {
      return "A prompt can't contain control characters other than line breaks and tabs.";
    }
  } else if (prompt !== undefined && prompt !== "") {
    return "An interactive session starts without a prompt; type it in its terminal.";
  }
  return null;
}

export type BackgroundRun =
  | { kind: "exited"; code: number; stdout: string; stderr: string }
  | { kind: "timeout" }
  | { kind: "error" };

/** Runs `claude` for a background start, with no shell (C-15). */
export function runBackground(
  plan: LaunchPlan,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<BackgroundRun> {
  return new Promise((resolve) => {
    execFile(
      plan.file,
      plan.args,
      {
        cwd: plan.cwd,
        env: sessionLaunchEnv(environment),
        timeout: BACKGROUND_TIMEOUT_MS,
        maxBuffer: 100_000,
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

/**
 * Claude Code's refusal, in the tool's own words (FR-18, 0025). Its text is only matched here,
 * never shown, logged, or kept.
 */
export function refusalMessage(stderr: string): string {
  if (/workspace not trusted/i.test(stderr)) {
    return "Claude Code doesn't trust this folder yet. Run `claude` there once and accept its prompt.";
  }
  if (/not (logged|signed) in|\/login|credential|authenticat/i.test(stderr)) {
    return "Claude Code isn't signed in. Run `claude` and sign in first.";
  }
  if (
    /no such file or directory|ENOENT|directory does not exist/i.test(stderr)
  ) {
    return "Claude Code couldn't find that folder.";
  }
  if (/outdated|update|restart/i.test(stderr)) {
    return "Claude Code's background service needs updating. Restart Claude Code and try again.";
  }
  return "Claude Code refused to start the session.";
}

const BACKGROUNDED = /^backgrounded\s+·\s+([0-9a-f]{8})\b/;

export interface StartOptions {
  programs: Programs;
  driveType: DriveTypeReader;
  launch: (plan: LaunchPlan, env: NodeJS.ProcessEnv) => Promise<void>;
  run?: (
    plan: LaunchPlan,
    environment: NodeJS.ProcessEnv,
  ) => Promise<BackgroundRun>;
  /** Watches the listing after a background start, for up to FAILURE_WATCH_MS. */
  watch: ListingWatch;
  environment?: NodeJS.ProcessEnv;
}

/**
 * Starts a session the user asked for (FR-32). The folder, name, and prompt are checked here, on
 * the server (NFR-14), and are never logged or kept (C-18).
 */
export function createStartExecutor(options: StartOptions) {
  const run = options.run ?? runBackground;
  return async (request: StartRequest): Promise<ActionResult> => {
    const { programs } = options;
    if (programs.claude === null) {
      return {
        outcome: "unavailable",
        message: "Claude Code's program wasn't found.",
      };
    }
    const problem = checkStartText(request.kind, request.name, request.prompt);
    if (problem !== null) return refused(problem);
    const folder = await checkLocalFolder(request.folder, options.driveType);
    if (!folder.ok) return refused(folder.message);

    let args: string[];
    try {
      args = claudeArguments({
        kind: request.kind,
        ...(request.name ? { name: request.name } : {}),
        ...(request.kind === "background"
          ? { prompt: request.prompt ?? "" }
          : {}),
      });
    } catch {
      return refused("That session can't be started.");
    }

    if (request.kind === "interactive") {
      let plan: LaunchPlan;
      try {
        plan = planTerminal(programs, args, folder.folder);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "A name needs Windows Terminal"
        ) {
          return refused(
            "A name needs Windows Terminal, which isn't installed. Start the session without a name.",
          );
        }
        return {
          outcome: "unavailable",
          message: "No terminal program was found.",
        };
      }
      try {
        await options.launch(
          plan,
          sessionLaunchEnv(options.environment ?? process.env),
        );
      } catch {
        return {
          outcome: "failed",
          message: "The terminal couldn't be started.",
        };
      }
      return {
        outcome: "started",
        message:
          "Terminal started. If Claude Code asks whether to trust the folder, answer it there.",
      };
    }

    const result = await run(
      planBackground(programs, args, folder.folder),
      options.environment ?? process.env,
    );
    if (result.kind === "timeout") {
      return {
        outcome: "unknown",
        message: "Claude Code didn't answer in time. Check the session list.",
      };
    }
    if (result.kind === "error") {
      return { outcome: "failed", message: "Claude Code couldn't be run." };
    }
    if (result.code !== 0) return refused(refusalMessage(result.stderr));
    const id = BACKGROUNDED.exec(result.stdout.trimStart())?.[1];
    if (id === undefined) {
      return {
        outcome: "unknown",
        message:
          "Couldn't confirm the session started. Check the session list.",
      };
    }
    // Some failures only show a few seconds later, as a failed session (0025).
    const watched = await options.watch((sessions: SessionView[]) =>
      sessions.some(
        (session) => session.id === id && session.state === "failed",
      ),
    );
    if (watched.met) {
      return {
        outcome: "failed",
        message:
          "Claude Code started the session, but it failed straight away.",
      };
    }
    return { outcome: "succeeded", message: "Started in the background." };
  };
}
