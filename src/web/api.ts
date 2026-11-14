import type { SessionUsage } from "../shared/protocol.js";
import {
  readReply,
  UNREACHABLE,
  type ActionReply,
} from "../shared/session-actions.js";
import { readPageKey } from "./pageKey.js";

/** Posts to the dashboard's own server with the page key, never cached (NFR-6). */
export async function postJson(
  url: string,
  body?: unknown,
): Promise<{ status: number; data: unknown } | null> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        "X-CCSM-Key": readPageKey() ?? "",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: "same-origin",
      cache: "no-store",
    });
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      // Read as a reply with no details.
    }
    return { status: response.status, data };
  } catch {
    return null;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Sends an action and reads its reply, along with the reply's own fields. */
export async function postAction(
  body: Record<string, unknown>,
): Promise<{ reply: ActionReply; data: Record<string, unknown> }> {
  const answer = await postJson("/api/actions", body);
  if (answer === null) return { reply: UNREACHABLE, data: {} };
  return {
    reply: readReply(answer.data),
    data: isObject(answer.data) ? answer.data : {},
  };
}

export type SessionKind = "background" | "interactive";

/** One past session in History (FR-35). */
export interface HistoryEntryView {
  sessionId: string;
  folder: string | null;
  startedAt: number | null;
  lastActivityAt: number | null;
  gitBranch?: string;
  model?: string;
  usage?: SessionUsage;
  inList: boolean;
  /** False when the folder is gone or not local, so Resume and Fork aren't offered. */
  folderUsable: boolean;
}

export interface HistoryPageView {
  page: number;
  pages: number;
  total: number;
  sessions: HistoryEntryView[];
}

export function readHistoryPage(data: unknown): HistoryPageView | null {
  if (!isObject(data) || !Array.isArray(data.sessions)) return null;
  const page = numberOrNull(data.page);
  const pages = numberOrNull(data.pages);
  const total = numberOrNull(data.total);
  if (page === null || pages === null || total === null) return null;
  const sessions = data.sessions.flatMap((entry): HistoryEntryView[] => {
    if (!isObject(entry) || typeof entry.sessionId !== "string") return [];
    return [
      {
        sessionId: entry.sessionId,
        folder: stringOrNull(entry.folder),
        startedAt: numberOrNull(entry.startedAt),
        lastActivityAt: numberOrNull(entry.lastActivityAt),
        ...(typeof entry.gitBranch === "string"
          ? { gitBranch: entry.gitBranch }
          : {}),
        ...(typeof entry.model === "string" ? { model: entry.model } : {}),
        ...(isObject(entry.usage)
          ? { usage: entry.usage as unknown as SessionUsage }
          : {}),
        inList: entry.inList === true,
        // Unknown counts as usable: the server still checks the folder and refuses if it's gone.
        folderUsable: entry.folderUsable !== false,
      },
    ];
  });
  return { page, pages, total, sessions };
}

export interface FolderListingView {
  folder: string | null;
  folders: string[];
  truncated: boolean;
  drives: string[];
}

export function readFolderListing(
  data: Record<string, unknown>,
): FolderListingView {
  const names = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  return {
    folder: stringOrNull(data.folder),
    folders: names(data.folders),
    truncated: data.truncated === true,
    drives: names(data.drives),
  };
}

/** One session's matches (FR-36). */
export interface SearchHitView {
  sessionId: string;
  count: number;
  snippets: string[];
  folder: string | null;
  lastActivityAt: number | null;
  /** Unknown when History had no details for it. */
  inList: boolean | null;
  folderUsable: boolean;
}

export type SearchStatusView =
  | { status: "running"; filesDone: number; filesTotal: number }
  | {
      status: "done";
      filesDone: number;
      filesTotal: number;
      stopped: boolean;
      sessions: SearchHitView[];
    }
  | { status: "gone" };

export function readSearchStatus(data: unknown): SearchStatusView {
  if (!isObject(data)) return { status: "gone" };
  const filesDone = numberOrNull(data.filesDone) ?? 0;
  const filesTotal = numberOrNull(data.filesTotal) ?? 0;
  if (data.status === "running") {
    return { status: "running", filesDone, filesTotal };
  }
  if (data.status !== "done" || !Array.isArray(data.sessions)) {
    return { status: "gone" };
  }
  const sessions = data.sessions.flatMap((hit): SearchHitView[] => {
    if (!isObject(hit) || typeof hit.sessionId !== "string") return [];
    return [
      {
        sessionId: hit.sessionId,
        count: numberOrNull(hit.count) ?? 0,
        snippets: Array.isArray(hit.snippets)
          ? hit.snippets.filter(
              (snippet): snippet is string => typeof snippet === "string",
            )
          : [],
        folder: stringOrNull(hit.folder),
        lastActivityAt: numberOrNull(hit.lastActivityAt),
        inList: typeof hit.inList === "boolean" ? hit.inList : null,
        folderUsable: hit.folderUsable !== false,
      },
    ];
  });
  return {
    status: "done",
    filesDone,
    filesTotal,
    stopped: data.stopped === true,
    sessions,
  };
}
