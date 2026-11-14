import { lstat, open, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SessionUsage, SessionView } from "../shared/protocol.js";
import {
  claudeProjectsDirectory,
  isValidSessionId,
  TAIL_BYTES,
  type EnrichResult,
} from "./transcripts.js";

/** Sessions per History page (FR-35). */
export const HISTORY_PAGE_SIZE = 50;
/** How much of each transcript's start is read for its folder and first timestamp (U-23). */
export const HEAD_BYTES = 64 * 1024;
/** A first timestamp this far before the file was created is a fork's copied history (U-23). */
export const FORK_COPY_MS = 60_000;
/** The first tail read for the last timestamp; 256 KB only if it isn't there (review of #61). */
export const SHORT_TAIL_BYTES = 16 * 1024;
/** How long the list of transcript files is reused before it's read again. */
const LIST_CACHE_MS = 5_000;

/** One past session in History, with no name and no message text (FR-35, C-7, C-12). */
export interface HistoryEntry {
  sessionId: string;
  /** The session's folder, from its transcript; kept in memory only, never stored. */
  folder: string | null;
  startedAt: number | null;
  lastActivityAt: number | null;
  gitBranch?: string;
  model?: string;
  usage?: SessionUsage;
  /** True when Claude Code still lists the session, so it's also in the main list. */
  inList: boolean;
}

export interface HistoryPage {
  page: number;
  pages: number;
  total: number;
  sessions: HistoryEntry[];
}

interface TranscriptFile {
  sessionId: string;
  file: string;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
}

/** What History knows about one file, read once per size and modified time. */
interface Known {
  size: number;
  mtimeMs: number;
  folder: string | null;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
}

/** A transcript with messages, ready to sort and page. */
interface Indexed extends TranscriptFile {
  known: Known & { firstTimestamp: number };
}

/** Reads the transcripts given as sessions, as the usage reader does (FR-23, NFR-11). */
export type UsageReader = (sessions: SessionView[]) => Promise<EnrichResult>;

export interface HistoryOptions {
  root?: string;
  /** A transcript reader of History's own, so live sessions keep their own budget. */
  read: UsageReader;
  now?: () => number;
}

/** The whole lines of a buffer, leaving out a cut-off first or last line. */
function wholeLines(
  text: string,
  cutStart: boolean,
  cutEnd: boolean,
): string[] {
  const lines = text.split("\n");
  if (cutStart) lines.shift();
  if (cutEnd) lines.pop();
  return lines;
}

function fieldsOf(line: string): { cwd?: unknown; timestamp?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as { cwd?: unknown; timestamp?: unknown })
      : null;
  } catch {
    return null;
  }
}

function timeOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * Reads only the allowed metadata from a transcript's first 64 KB: the first `cwd`, and the
 * first timestamp. No message text is kept (C-12).
 */
export async function readHead(file: string): Promise<{
  folder: string | null;
  firstTimestamp: number | null;
}> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    let folder: string | null = null;
    let firstTimestamp: number | null = null;
    for (const line of wholeLines(text, false, bytesRead === HEAD_BYTES)) {
      if (folder !== null && firstTimestamp !== null) break;
      if (!line.includes('"cwd"') && !line.includes('"timestamp"')) continue;
      const fields = fieldsOf(line);
      if (fields === null) continue;
      if (
        folder === null &&
        typeof fields.cwd === "string" &&
        fields.cwd.length <= 4096
      ) {
        folder = fields.cwd;
      }
      firstTimestamp ??= timeOf(fields.timestamp);
    }
    return { folder, firstTimestamp };
  } finally {
    await handle.close();
  }
}

/** The last timestamp in a transcript's last bytes, and nothing else (C-12). */
export async function readLastTimestamp(
  file: string,
  size: number,
  tail: number = TAIL_BYTES,
): Promise<number | null> {
  const length = Math.min(size, tail);
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = wholeLines(text, size > length, false);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line === undefined || !line.includes('"timestamp"')) continue;
      const time = timeOf(fieldsOf(line)?.timestamp);
      if (time !== null) return time;
    }
    return null;
  } finally {
    await handle.close();
  }
}

/** The start time: the first timestamp, unless a fork copied it from older history (U-23). */
export function startTime(
  firstTimestamp: number | null,
  birthtimeMs: number,
  lastActivityAt: number | null = null,
): number | null {
  if (firstTimestamp === null) return null;
  let start = firstTimestamp;
  if (birthtimeMs > 0 && birthtimeMs - firstTimestamp > FORK_COPY_MS) {
    start = Math.round(birthtimeMs);
  }
  // A fork that ended before any new message has only copied activity, before its creation.
  return lastActivityAt !== null && start > lastActivityAt
    ? lastActivityAt
    : start;
}

/**
 * The History index (FR-35): every main transcript on disk, newest last activity first, a page
 * at a time. It reads only when asked, so History reads nothing while it's closed (NFR-15).
 * Requests take turns, because the transcript reader serves one caller at a time.
 */
export function createHistory(options: HistoryOptions) {
  const root = options.root ?? claudeProjectsDirectory();
  const now = options.now ?? Date.now;
  const known = new Map<string, Known>();
  let listed: { at: number; files: TranscriptFile[] } | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const listFiles = async (): Promise<TranscriptFile[]> => {
    if (listed !== null && now() - listed.at < LIST_CACHE_MS)
      return listed.files;
    const bySession = new Map<string, TranscriptFile>();
    let projects: string[];
    try {
      projects = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      projects = [];
    }
    for (const project of projects) {
      let names: string[];
      try {
        names = (await readdir(join(root, project), { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const name of names) {
        const sessionId = basename(name, ".jsonl");
        if (!isValidSessionId(sessionId)) continue;
        const file = join(root, project, name);
        try {
          // lstat, so a link is never followed out of the projects folder.
          const stats = await lstat(file);
          if (!stats.isFile() || stats.size === 0) continue;
          const entry = {
            sessionId,
            file,
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            birthtimeMs: stats.birthtimeMs,
          };
          // The same session in two project folders shows once, from its newer file.
          const other = bySession.get(sessionId);
          if (other === undefined || other.mtimeMs < entry.mtimeMs) {
            bySession.set(sessionId, entry);
          }
        } catch {
          // A file that's gone between listing and reading is left out.
        }
      }
    }
    const files = [...bySession.values()];
    // What's known about deleted transcripts is dropped.
    const present = new Set(files.map((file) => file.file));
    for (const file of known.keys()) if (!present.has(file)) known.delete(file);
    listed = { at: now(), files };
    return files;
  };

  const knownOf = async (entry: TranscriptFile): Promise<Known | null> => {
    const hit = known.get(entry.file);
    if (
      hit !== undefined &&
      hit.size === entry.size &&
      hit.mtimeMs === entry.mtimeMs
    ) {
      return hit;
    }
    try {
      const head = await readHead(entry.file);
      const lastTimestamp =
        head.firstTimestamp === null
          ? null
          : ((await readLastTimestamp(
              entry.file,
              entry.size,
              SHORT_TAIL_BYTES,
            )) ??
            (entry.size > SHORT_TAIL_BYTES
              ? await readLastTimestamp(entry.file, entry.size)
              : null));
      const fresh = {
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        ...head,
        lastTimestamp,
      };
      known.set(entry.file, fresh);
      return fresh;
    } catch {
      return null;
    }
  };

  /** Every transcript with messages, newest last activity first. */
  const index = async (): Promise<Indexed[]> => {
    const files = await listFiles();
    const indexed: Indexed[] = [];
    for (const file of files) {
      const info = await knownOf(file);
      if (info === null || info.firstTimestamp === null) continue;
      indexed.push({
        ...file,
        known: { ...info, firstTimestamp: info.firstTimestamp },
      });
    }
    const activity = (entry: Indexed) =>
      entry.known.lastTimestamp ?? entry.mtimeMs;
    // Ties go to the file changed most recently.
    indexed.sort((a, b) => activity(b) - activity(a) || b.mtimeMs - a.mtimeMs);
    return indexed;
  };

  const entryOf = (file: Indexed, listedIds: Set<string>): HistoryEntry => {
    const lastActivityAt = file.known.lastTimestamp ?? Math.round(file.mtimeMs);
    return {
      sessionId: file.sessionId,
      folder: file.known.folder,
      startedAt: startTime(
        file.known.firstTimestamp,
        file.birthtimeMs,
        lastActivityAt,
      ),
      lastActivityAt,
      inList: listedIds.has(file.sessionId),
    };
  };

  return {
    /**
     * One page of History. Transcripts with no timestamp, which have no messages, are left out
     * and not counted. The page's usage is read within the reader's budget, so it may still be
     * counting.
     */
    page(page: number, listing: SessionView[]): Promise<HistoryPage> {
      return inTurn(async () => {
        const all = await index();
        const total = all.length;
        const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
        const at = Math.min(Math.max(0, Math.floor(page)), pages - 1);
        const slice = all.slice(
          at * HISTORY_PAGE_SIZE,
          (at + 1) * HISTORY_PAGE_SIZE,
        );
        const listedIds = new Set(
          listing
            .map((session) => session.sessionId)
            .filter((id) => id !== undefined),
        );
        const entries = slice.map((file) => entryOf(file, listedIds));

        // Branch, model, and usage, through the reader's allow-list and budget.
        const views = entries.map(
          (entry) =>
            ({
              sessionId: entry.sessionId,
              needsAttention: false,
              attentionReason: null,
              finished: true,
              statusLabel: "finished",
            }) satisfies SessionView,
        );
        try {
          const { sessions } = await options.read(views);
          sessions.forEach((session, i) => {
            const entry = entries[i];
            if (entry === undefined || session.sessionId !== entry.sessionId)
              return;
            if (session.gitBranch !== undefined)
              entry.gitBranch = session.gitBranch;
            if (session.model !== undefined) entry.model = session.model;
            if (session.usage !== undefined) entry.usage = session.usage;
          });
        } catch {
          // Usage stays unknown for this page; the rest still shows.
        }
        return { page: at, pages, total, sessions: entries };
      });
    },

    /** Every main transcript, newest changed first, for search (FR-36). */
    async files(): Promise<{ sessionId: string; file: string }[]> {
      const files = await listFiles();
      return [...files]
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .map(({ sessionId, file }) => ({ sessionId, file }));
    },

    /** Finds a past session's folder by its ID, for Resume and Fork from History. */
    find(sessionId: string): Promise<HistoryEntry | null> {
      return inTurn(async () => {
        if (!isValidSessionId(sessionId)) return null;
        const file = (await listFiles()).find(
          (entry) => entry.sessionId === sessionId,
        );
        if (file === undefined) return null;
        const info = await knownOf(file);
        if (info === null || info.firstTimestamp === null) return null;
        return entryOf(
          { ...file, known: { ...info, firstTimestamp: info.firstTimestamp } },
          new Set(),
        );
      });
    },
  };
}

export type History = ReturnType<typeof createHistory>;
