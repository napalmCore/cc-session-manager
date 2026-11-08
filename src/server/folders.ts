import { stat } from "node:fs/promises";
import { sessionKeys } from "../shared/notifications.js";
import type { SessionView } from "../shared/protocol.js";

/** How long a folder check is trusted before it's repeated. */
export const FOLDER_CHECK_MS = 10_000;

const NETWORK_PATH = /^[\\/]{2}/;

export interface FolderWatchOptions {
  /** Called when a check finds that a folder's state changed, so the snapshot can be resent. */
  onChange: () => void;
  isFolder?: (path: string) => Promise<boolean>;
  now?: () => number;
  ttlMs?: number;
}

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Tracks whether finished sessions' folders still exist, so the page doesn't offer Resume for
 * one that's gone (BUG-31). Checks run in the background, at most once per folder per interval,
 * so a slow network drive can't hold up the server. Until a folder has been checked, it counts
 * as present, and the server still checks it when Resume is pressed.
 */
export function createFolderWatch(options: FolderWatchOptions) {
  const check = options.isFolder ?? isFolder;
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? FOLDER_CHECK_MS;
  const known = new Map<string, { exists: boolean; at: number }>();
  const checking = new Set<string>();

  const schedule = (folder: string) => {
    if (checking.has(folder)) return;
    checking.add(folder);
    void check(folder)
      .catch(() => false)
      .then((exists) => {
        const before = known.get(folder)?.exists ?? true;
        known.set(folder, { exists, at: now() });
        if (exists !== before) options.onChange();
      })
      .finally(() => {
        checking.delete(folder);
      });
  };

  return {
    /** The keys of finished sessions whose folder is known to be gone. */
    missing(sessions: SessionView[]): string[] {
      const candidates = sessions.filter(
        (session): session is SessionView & { cwd: string } =>
          session.kind === "interactive" &&
          session.finished &&
          session.cwd !== undefined &&
          // A network folder isn't checked, since every check would connect to that server.
          !NETWORK_PATH.test(session.cwd),
      );
      const folders = new Set(candidates.map((session) => session.cwd));
      for (const folder of known.keys()) {
        if (!folders.has(folder)) known.delete(folder);
      }
      for (const folder of folders) {
        const entry = known.get(folder);
        if (entry === undefined || now() - entry.at >= ttl) schedule(folder);
      }
      return candidates
        .filter((session) => known.get(session.cwd)?.exists === false)
        .flatMap(sessionKeys);
    },
  };
}
