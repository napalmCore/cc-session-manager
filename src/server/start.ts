import { execFile } from "node:child_process";
import type { SessionView } from "../shared/protocol.js";
import type { ActionResult } from "./actions.js";
import {
  claudeArguments,
  planBackground,
  planTerminal,
  sendArguments,
} from "./launch.js";
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
  /** Claude Code printed more than the tool reads, so it ran, but its answer is unknown. */
  | { kind: "overflow" }
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
        } else if (
          (error as { code?: unknown }).code ===
          "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        ) {
          resolve({ kind: "overflow" });
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
export function refusalMessage(
  output: string,
  fallback = "Claude Code refused to start the session.",
): string {
  // Claude Code refuses in one line; only that is matched, never anything it might repeat.
  const stderr =
    output
      .split(/\r?\n/)
      .find((line) => line.trim() !== "")
      ?.trim() ?? "";
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
  return fallback;
}

/** A message's own checks, in a message's words: a starting prompt's limits (NFR-17). */
export function checkMessageText(message: string): string | null {
  if (message.trim() === "") return "Type a message to send.";
  if (message.length > MAX_PROMPT) {
    return `A message can be at most ${String(MAX_PROMPT)} characters.`;
  }
  if (hasRawControl(message, "\n\r\t")) {
    return "A message can't contain control characters other than line breaks and tabs.";
  }
  return null;
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

/** A Fork request (FR-33): the page names only a session; the server finds its folder. */
export interface ForkRequest {
  action: "fork";
  key: string;
  kind: "background" | "interactive";
  name?: string | undefined;
  prompt?: string | undefined;
}

/** A Send request (FR-37): the page names only the session. */
export interface SendRequest {
  action: "send";
  key: string;
  message: string;
}

/** The session a message goes to, from a fresh listing on the server. */
export interface SendTarget {
  shortId: string;
  sessionId: string;
  folder: string;
  /** Its state before the send, so an old failure isn't taken for a new one. */
  state: string;
}

/** Claude Code says this when it brought a session back with its saved options. */
const woke = (shortId: string) =>
  `note: woke session ${shortId} with its saved options`;

/** Where a fork runs: the session's own ID and folder, from the server's own data. */
export interface ForkTarget {
  sessionId: string;
  folder: string;
}

/**
 * Starts and forks sessions the user asked for (FR-32, FR-33). The folder, name, and prompt are
 * checked here, on the server (NFR-14), and are never logged or kept (C-18).
 */
export function createLauncher(options: StartOptions) {
  const run = options.run ?? runBackground;
  const { programs } = options;

  /** Runs `claude` with these arguments, in a new terminal or in the background. */
  const launch = async (
    kind: StartRequest["kind"],
    args: string[],
    folder: string,
    what: "session" | "fork",
  ): Promise<ActionResult> => {
    if (kind === "interactive") {
      let plan: LaunchPlan;
      try {
        plan = planTerminal(programs, args, folder);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "A name needs Windows Terminal"
        ) {
          return refused(
            `A name needs Windows Terminal, which isn't installed. Start the ${what} without a name.`,
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
      planBackground(programs, args, folder),
      options.environment ?? process.env,
    );
    if (result.kind === "timeout") {
      return {
        outcome: "unknown",
        message: "Claude Code didn't answer in time. Check the session list.",
      };
    }
    if (result.kind === "overflow") {
      return {
        outcome: "unknown",
        message: "Couldn't read Claude Code's answer. Check the session list.",
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
    return {
      outcome: "succeeded",
      message:
        what === "fork"
          ? "Forked in the background."
          : "Started in the background.",
    };
  };

  /** The checked arguments, or a refusal. */
  const prepare = (
    kind: StartRequest["kind"],
    name: string | undefined,
    prompt: string | undefined,
    forkOf?: string,
  ): string[] | ActionResult => {
    const problem = checkStartText(kind, name, prompt);
    if (problem !== null) return refused(problem);
    try {
      return claudeArguments({
        kind,
        ...(forkOf !== undefined ? { forkOf } : {}),
        ...(name ? { name } : {}),
        ...(kind === "background" ? { prompt: prompt ?? "" } : {}),
      });
    } catch {
      return refused("That session can't be started.");
    }
  };

  const unavailable: ActionResult = {
    outcome: "unavailable",
    message: "Claude Code's program wasn't found.",
  };

  return {
    /**
     * Sends a message to a background session that isn't running (FR-37), as its next turn.
     * The message is never logged, kept, or repeated in the result (C-21).
     */
    async send(
      request: SendRequest,
      target: SendTarget,
    ): Promise<ActionResult> {
      if (programs.claude === null) return unavailable;
      const problem = checkMessageText(request.message);
      if (problem !== null) return refused(problem);
      const folder = await checkLocalFolder(target.folder, options.driveType);
      if (!folder.ok) {
        return refused(`The session's folder can't be used: ${folder.message}`);
      }
      let args: string[];
      try {
        args = sendArguments(target.sessionId, request.message);
      } catch {
        return refused("That session can't take a message.");
      }
      const result = await run(
        planBackground(programs, args, target.folder),
        options.environment ?? process.env,
      );
      if (result.kind === "timeout") {
        return {
          outcome: "unknown",
          message:
            "Claude Code didn't answer in time, so the message may have been sent. Check the session.",
        };
      }
      if (result.kind === "overflow") {
        return {
          outcome: "unknown",
          message:
            "Couldn't read Claude Code's answer, so the message may have been sent. Check the session.",
        };
      }
      if (result.kind === "error") {
        return { outcome: "failed", message: "Claude Code couldn't be run." };
      }
      if (result.code !== 0) {
        return refused(
          refusalMessage(result.stderr, "Claude Code refused the message."),
        );
      }
      const id = BACKGROUNDED.exec(result.stdout.trimStart())?.[1];
      if (id === undefined) {
        return {
          outcome: "unknown",
          message: "Couldn't confirm the message was sent. Check the session.",
        };
      }
      if (id !== target.shortId) {
        // The session began running in the meantime, so Claude Code started a copy (0028).
        return {
          outcome: "started",
          message: `Claude Code started a new session, ${id}, with your message, because this one was running.`,
          newSessionId: id,
        };
      }
      // A session that was already failed counts as failing again only after it has run.
      let ran = target.state !== "failed";
      const watched = await options.watch((sessions: SessionView[]) =>
        sessions.some((session) => {
          if (session.id !== id) return false;
          if (session.pid !== undefined || session.state !== "failed") {
            ran = true;
            return false;
          }
          return ran;
        }),
      );
      if (watched.met) {
        return {
          outcome: "failed",
          message:
            "Claude Code took the message, but the session failed straight away.",
        };
      }
      const restored = result.stderr
        .split(/\r?\n/)
        .some((line) => line.startsWith(woke(target.shortId)));
      return {
        outcome: "succeeded",
        message: restored
          ? "Message sent. The session is running again."
          : "Message sent. The session is running again. Claude Code didn't say it restored the session's saved options.",
      };
    },

    async start(request: StartRequest): Promise<ActionResult> {
      if (programs.claude === null) return unavailable;
      const problem = checkStartText(
        request.kind,
        request.name,
        request.prompt,
      );
      if (problem !== null) return refused(problem);
      const folder = await checkLocalFolder(request.folder, options.driveType);
      if (!folder.ok) return refused(folder.message);
      const args = prepare(request.kind, request.name, request.prompt);
      if (!Array.isArray(args)) return args;
      return launch(request.kind, args, folder.folder, "session");
    },

    /**
     * Forks a session into a new one (FR-33). `--fork-session` is always passed, so the original
     * is never continued or changed. The target comes from the server's own data.
     */
    async fork(
      request: ForkRequest,
      target: ForkTarget,
    ): Promise<ActionResult> {
      if (programs.claude === null) return unavailable;
      const problem = checkStartText(
        request.kind,
        request.name,
        request.prompt,
      );
      if (problem !== null) return refused(problem);
      const folder = await checkLocalFolder(target.folder, options.driveType);
      if (!folder.ok) {
        return refused(`The session's folder can't be used: ${folder.message}`);
      }
      const args = prepare(
        request.kind,
        request.name,
        request.prompt,
        target.sessionId,
      );
      if (!Array.isArray(args)) return args;
      // Checked through its resolved path, but run in the folder the session recorded, so Claude
      // Code finds the conversation where it saved it.
      return launch(request.kind, args, target.folder, "fork");
    },
  };
}

/** Starts a session the user asked for (FR-32). */
export function createStartExecutor(options: StartOptions) {
  const launcher = createLauncher(options);
  return (request: StartRequest) => launcher.start(request);
}
