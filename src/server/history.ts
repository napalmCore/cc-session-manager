import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SessionUsage, SessionView } from "../shared/protocol.js";
import {
  claudeProjectsDirectory,
  isValidSessionId,
  type EnrichResult,
} from "./transcripts.js";

/** Sessions per History page (FR-35). */
export const HISTORY_PAGE_SIZE = 50;
/** How much of each transcript's start is read for its folder and first timestamp (U-23). */
export const HEAD_BYTES = 64 * 1024;
/** A first timestamp this far before the file was created is a fork's copied history (U-23). */
export const FORK_COPY_MS = 60_000;
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

interface Head {
  size: number;
  mtimeMs: number;
  folder: string | null;
  firstTimestamp: number | null;
}

/** Reads the transcripts given as sessions, as the usage reader does (FR-23, NFR-11). */
export type UsageReader = (sessions: SessionView[]) => Promise<EnrichResult>;

export interface HistoryOptions {
  root?: string;
  /** A transcript reader of History's own, so live sessions keep their own budget. */
  read: UsageReader;
  now?: () => number;
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
    // The last line may be cut off, so only whole lines are read.
    const lines = text.split("\n");
    if (bytesRead === HEAD_BYTES) lines.pop();
    for (const line of lines) {
      if (folder !== null && firstTimestamp !== null) break;
      if (!line.includes('"cwd"') && !line.includes('"timestamp"')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== "object") continue;
      const fields = parsed as { cwd?: unknown; timestamp?: unknown };
      if (
        folder === null &&
        typeof fields.cwd === "string" &&
        fields.cwd.length <= 4096
      ) {
        folder = fields.cwd;
      }
      if (firstTimestamp === null && typeof fields.timestamp === "string") {
        const time = Date.parse(fields.timestamp);
        if (Number.isFinite(time)) firstTimestamp = time;
      }
    }
    return { folder, firstTimestamp };
  } finally {
    await handle.close();
  }
}

/** The start time: the first timestamp, unless a fork copied it from older history (U-23). */
export function startTime(
  firstTimestamp: number | null,
  birthtimeMs: number,
): number | null {
  if (firstTimestamp === null) return null;
  if (birthtimeMs > 0 && birthtimeMs - firstTimestamp > FORK_COPY_MS) {
    return Math.round(birthtimeMs);
  }
  return firstTimestamp;
}

/**
 * The History index (FR-35): every main transcript on disk, newest first, a page at a time. It
 * reads only when asked, so History reads nothing while it's closed (NFR-15).
 */
export function createHistory(options: HistoryOptions) {
  const root = options.root ?? claudeProjectsDirectory();
  const now = options.now ?? Date.now;
  const heads = new Map<string, Head>();
  let listed: { at: number; files: TranscriptFile[] } | null = null;

  const listFiles = async (): Promise<TranscriptFile[]> => {
    if (listed !== null && now() - listed.at < LIST_CACHE_MS)
      return listed.files;
    const files: TranscriptFile[] = [];
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
          const stats = await stat(file);
          if (stats.size === 0) continue;
          files.push({
            sessionId,
            file,
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            birthtimeMs: stats.birthtimeMs,
          });
        } catch {
          // A file that's gone between listing and reading is left out.
        }
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    listed = { at: now(), files };
    return files;
  };

  const headOf = async (entry: TranscriptFile): Promise<Head | null> => {
    const known = heads.get(entry.file);
    if (
      known !== undefined &&
      known.size === entry.size &&
      known.mtimeMs === entry.mtimeMs
    ) {
      return known;
    }
    try {
      const read = await readHead(entry.file);
      const head = { size: entry.size, mtimeMs: entry.mtimeMs, ...read };
      heads.set(entry.file, head);
      return head;
    } catch {
      return null;
    }
  };

  return {
    /**
     * One page of History. Sessions with no timestamp, which have no messages, are left out.
     * The page's usage is read within the reader's budget, so it may still be counting.
     */
    async page(page: number, listing: SessionView[]): Promise<HistoryPage> {
      const files = await listFiles();
      const total = files.length;
      const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
      const index = Math.min(Math.max(0, Math.floor(page)), pages - 1);
      const slice = files.slice(
        index * HISTORY_PAGE_SIZE,
        (index + 1) * HISTORY_PAGE_SIZE,
      );
      const listedIds = new Set(
        listing
          .map((session) => session.sessionId)
          .filter((id) => id !== undefined),
      );

      const entries: HistoryEntry[] = [];
      for (const file of slice) {
        const head = await headOf(file);
        if (head === null || head.firstTimestamp === null) continue;
        entries.push({
          sessionId: file.sessionId,
          folder: head.folder,
          startedAt: startTime(head.firstTimestamp, file.birthtimeMs),
          lastActivityAt: Math.round(file.mtimeMs),
          inList: listedIds.has(file.sessionId),
        });
      }

      // Branch, model, last activity, and usage, through the reader's allow-list and budget.
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
          if (session.lastActivityAt !== undefined)
            entry.lastActivityAt = session.lastActivityAt;
          if (session.usage !== undefined) entry.usage = session.usage;
        });
      } catch {
        // Usage stays unknown for this page; the rest still shows.
      }

      entries.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
      return { page: index, pages, total, sessions: entries };
    },

    /** Finds a past session's folder by its ID, for Resume and Fork from History. */
    async find(sessionId: string): Promise<HistoryEntry | null> {
      if (!isValidSessionId(sessionId)) return null;
      const file = (await listFiles()).find(
        (entry) => entry.sessionId === sessionId,
      );
      if (file === undefined) return null;
      const head = await headOf(file);
      if (head === null || head.firstTimestamp === null) return null;
      return {
        sessionId,
        folder: head.folder,
        startedAt: startTime(head.firstTimestamp, file.birthtimeMs),
        lastActivityAt: Math.round(file.mtimeMs),
        inList: false,
      };
    },
  };
}

export type History = ReturnType<typeof createHistory>;
