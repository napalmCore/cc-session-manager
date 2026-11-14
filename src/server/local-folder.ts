import { execFile } from "node:child_process";
import { realpath } from "node:fs";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { hasControl } from "./text-checks.js";

// The native version resolves `subst` drives, junctions, and links; the JavaScript one doesn't.
const realpathNative = promisify(realpath.native);

/** An absolute path on a drive letter, such as `C:\work`. */
const DRIVE_PATH = /^[A-Za-z]:\\/;
/** How long a drive's type is remembered, so a folder picker stays quick. */
export const DRIVE_TYPE_CACHE_MS = 30_000;
/** A cold Windows PowerShell can take several seconds to start, as on CI. */
export const DRIVE_TYPE_TIMEOUT_MS = 15_000;

/** Reads a drive letter's type, such as "Fixed" or "Network", or null if it can't be read. */
export type DriveTypeReader = (letter: string) => Promise<string | null>;

/**
 * Reads a drive's type through Windows PowerShell, which the tool already uses (0025). The
 * letter is checked first and is the only thing in the command.
 */
export function powershellDriveType(
  powershell: string | null,
): DriveTypeReader {
  return (letter) =>
    new Promise((resolve) => {
      if (powershell === null || !/^[A-Za-z]$/.test(letter)) {
        resolve(null);
        return;
      }
      execFile(
        powershell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `[System.IO.DriveInfo]::new('${letter.toUpperCase()}').DriveType`,
        ],
        { timeout: DRIVE_TYPE_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => {
          const type = stdout.trim();
          resolve(error === null && /^[A-Za-z]+$/.test(type) ? type : null);
        },
      );
    });
}

/** Remembers each drive's type for a while, and never remembers a failed read. */
export function cachedDriveType(
  read: DriveTypeReader,
  now: () => number = Date.now,
): DriveTypeReader {
  const cache = new Map<string, { type: string; at: number }>();
  // A read still running is shared, so many checks at once start one read per drive.
  const running = new Map<string, Promise<string | null>>();
  return async (letter) => {
    const key = letter.toUpperCase();
    const hit = cache.get(key);
    if (hit !== undefined && now() - hit.at < DRIVE_TYPE_CACHE_MS)
      return hit.type;
    const shared = running.get(key);
    if (shared !== undefined) return shared;
    const reading = read(key)
      .then((type) => {
        if (type !== null) cache.set(key, { type, at: now() });
        return type;
      })
      .finally(() => {
        running.delete(key);
      });
    running.set(key, reading);
    return reading;
  };
}

export type FolderCheck =
  { ok: true; folder: string } | { ok: false; message: string };

const NOT_LOCAL =
  "That folder isn't a local folder. Network shares, mapped network drives, and links to them can't be used.";

async function isLocalDrive(
  path: string,
  driveType: DriveTypeReader,
): Promise<"local" | "not-local" | "unknown"> {
  const letter = path[0];
  if (letter === undefined) return "not-local";
  const type = await driveType(letter);
  // A drive whose type can't be read is refused too, with its own message.
  if (type === null) return "unknown";
  return type !== "Network" && type !== "NoRootDirectory"
    ? "local"
    : "not-local";
}

const UNKNOWN_DRIVE =
  "Couldn't check that folder's drive, so it can't be used right now. Try again.";

function driveRefusal(
  kind: "local" | "not-local" | "unknown",
): FolderCheck | null {
  if (kind === "local") return null;
  return {
    ok: false,
    message: kind === "unknown" ? UNKNOWN_DRIVE : NOT_LOCAL,
  };
}

/**
 * Decides whether a folder may be used to start a session (FR-32, NFR-14): an existing local
 * absolute folder, after resolving `subst` drives, junctions, and links, on a drive that isn't a
 * network drive. Network shares, device paths, and relative paths are refused (0025).
 */
export async function checkLocalFolder(
  folder: string,
  driveType: DriveTypeReader,
): Promise<FolderCheck> {
  if (folder.length === 0 || folder.length > 1024) {
    return { ok: false, message: "Choose a folder." };
  }
  // Control characters, a device path, a share, or anything but an absolute drive path.
  if (hasControl(folder) || !DRIVE_PATH.test(folder)) {
    return {
      ok: false,
      message: "Use a full folder path on a local drive, such as C:\\work.",
    };
  }
  const before = driveRefusal(await isLocalDrive(folder, driveType));
  if (before !== null) return before;
  let resolved: string;
  try {
    resolved = await realpathNative(folder);
  } catch {
    return { ok: false, message: "That folder doesn't exist." };
  }
  if (!DRIVE_PATH.test(resolved)) return { ok: false, message: NOT_LOCAL };
  const after = driveRefusal(await isLocalDrive(resolved, driveType));
  if (after !== null) return after;
  try {
    if (!(await stat(resolved)).isDirectory()) {
      return { ok: false, message: "That path isn't a folder." };
    }
  } catch {
    return { ok: false, message: "That folder doesn't exist." };
  }
  return { ok: true, folder: resolved };
}
