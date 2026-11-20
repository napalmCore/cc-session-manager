import { spawn as nodeSpawn } from "node:child_process";
import { homedir } from "node:os";
import { hasDisplay } from "./posix-terminal.js";
import { findPosixProgram } from "./programs.js";

/** Printed under a first start's link when no browser opened (FR-29, BUG-8). */
export const PRINTED_LINK_NOTE =
  "This link works once, for 2 minutes. Restart cc-session-manager for a new one.";
/** Printed under a second start's handover link when no browser opened. */
export const HANDOVER_LINK_NOTE =
  "This link works once, for 60 seconds. Run cc-session-manager again for a new one.";

export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): [string, string[]] {
  if (platform === "win32")
    return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  if (platform === "darwin") return ["open", [url]];
  return ["xdg-open", [url]];
}

export interface OpenBrowserOptions {
  /** Says how long the link works, printed under it. */
  note: string;
  /** Runs just before the link is printed, to start its time limit. */
  beforePrint?: () => void;
  spawn?: typeof nodeSpawn;
  log?: (line: string) => void;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  find?: (name: string, env: NodeJS.ProcessEnv) => string | null;
}

/**
 * Starts the browser detached, because Windows ends a process's attached children, and what
 * they start, when it exits. It settles once the command has finished, so a start that exits
 * straight after still reports a failure. Only if no browser opens is the link printed, with
 * how long it works, after `beforePrint` has set that limit (FR-29).
 */
export function openBrowser(
  url: string,
  options: OpenBrowserOptions,
): Promise<void> {
  const spawn = options.spawn ?? nodeSpawn;
  const log = options.log ?? ((line: string) => console.log(line));
  const platform = options.platform ?? process.platform;
  const [command, args] = browserCommand(url, platform);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (failed: boolean) => {
      if (settled) return;
      settled = true;
      if (failed) {
        options.beforePrint?.();
        log(`Could not open a browser. Open this link: ${url}`);
        log(options.note);
      }
      resolve();
    };
    const env = options.env ?? process.env;
    // On Linux with no display, no browser can open, so the link is printed (FR-42).
    if (platform === "linux" && !hasDisplay(env)) {
      finish(true);
      return;
    }
    // On macOS and Linux, open or xdg-open is found on the cleaned PATH, never by a bare name,
    // so nothing in a relative PATH entry can run (C-22).
    const file =
      platform === "win32"
        ? command
        : (options.find ?? findPosixProgram)(command, env);
    if (file === null) {
      finish(true);
      return;
    }
    try {
      const child = spawn(file, args, {
        cwd: homedir(),
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", () => {
        finish(true);
      });
      child.once("exit", (code) => {
        finish(code !== 0);
      });
    } catch {
      finish(true);
    }
  });
}
