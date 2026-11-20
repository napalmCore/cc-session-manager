import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasDisplay } from "./posix-terminal.js";
import { findPosixProgram, sessionLaunchEnv } from "./programs.js";

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
  /**
   * On macOS and Linux, the private data folder the redirect file goes in, so the link's token is
   * never in a program's arguments, which other users there can read (M1).
   */
  redirectFolder?: string;
  /** How long the link works, after which its redirect file is deleted. */
  lifetimeMs?: number;
}

const REDIRECT_FILE = /^signin-[0-9a-f]{32}\.html$/;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Writes a page that sends the browser on to the link, readable only by the user (0600), and
 * deletes older ones, whose links have expired. Returns its path.
 */
export function writeRedirectFile(
  folder: string,
  url: string,
  now: number = Date.now(),
  maxAgeMs = 2 * 60_000,
): string {
  try {
    for (const name of readdirSync(folder)) {
      if (!REDIRECT_FILE.test(name)) continue;
      const path = join(folder, name);
      try {
        if (now - statSync(path).mtimeMs > maxAgeMs) unlinkSync(path);
      } catch {
        // Gone already.
      }
    }
  } catch {
    // The folder can't be listed; writing below still says if it's usable.
  }
  const path = join(folder, `signin-${randomBytes(16).toString("hex")}.html`);
  const link = escapeHtml(url);
  const page = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${link}"><title>cc-session-manager</title><p><a href="${link}">Open the dashboard</a></p>
`;
  // wx: never follows or reuses an existing file; 0600: only the user can read it.
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, page);
  } finally {
    closeSync(fd);
  }
  return path;
}

/**
 * Starts the browser detached, because Windows ends a process's attached children, and what
 * they start, when it exits. It settles once the command has finished, so a start that exits
 * straight after still reports a failure. On Windows, only if no browser opens is the link
 * printed, with how long it works, after `beforePrint` has set that limit (FR-29). On macOS and
 * Linux, the browser is given a private redirect file instead of the link, and the link is
 * always printed, since a confined browser may not be able to read that file (M1).
 */
export function openBrowser(
  url: string,
  options: OpenBrowserOptions,
): Promise<void> {
  const spawn = options.spawn ?? nodeSpawn;
  const log = options.log ?? ((line: string) => console.log(line));
  const platform = options.platform ?? process.platform;
  const posix = platform !== "win32";
  return new Promise((resolve) => {
    let settled = false;
    const finish = (failed: boolean) => {
      if (settled) return;
      settled = true;
      if (failed) {
        options.beforePrint?.();
        log(`Could not open a browser. Open this link: ${url}`);
        log(options.note);
      } else if (posix) {
        options.beforePrint?.();
        log(
          `If the dashboard didn't open in your browser, open this link: ${url}`,
        );
        log(options.note);
      }
      resolve();
    };
    const env = options.env ?? process.env;
    // On macOS and Linux, other users can read a program's arguments, so the browser gets a
    // private file that leads to the link, never the link itself (M1).
    let target = url;
    if (posix) {
      if (options.redirectFolder === undefined) {
        finish(true);
        return;
      }
      try {
        target = writeRedirectFile(options.redirectFolder, url);
      } catch {
        finish(true);
        return;
      }
      const written = target;
      setTimeout(
        () => {
          try {
            unlinkSync(written);
          } catch {
            // Gone already.
          }
        },
        options.lifetimeMs ?? 2 * 60_000,
      ).unref();
    }
    const [command, args] = browserCommand(target, platform);
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
        // On macOS and Linux, the same cleaned environment as other launched programs (I3).
        ...(posix ? { env: sessionLaunchEnv(env, platform) } : {}),
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
