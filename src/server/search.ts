import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";

/** Query length after trimming (0025). */
export const MIN_QUERY = 2;
export const MAX_QUERY = 200;
/** Snippets per session, their length, and how many sessions get them (FR-36). */
export const SNIPPETS_PER_SESSION = 3;
export const SNIPPET_LENGTH = 160;
export const SESSIONS_WITH_SNIPPETS = 100;
/** A search stops after this long with what it has (NFR-15). */
export const SEARCH_TIME_MS = 30_000;
/** Results are kept this long after they're ready, unless fetched or cancelled sooner (C-16). */
export const RESULTS_KEPT_MS = 60_000;
/** A single transcript line longer than this is skipped, so memory and work stay bounded. */
export const MAX_LINE_CHARS = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

/** A main transcript to search, newest first. */
export interface SearchFile {
  sessionId: string;
  file: string;
}

export interface SearchHit {
  sessionId: string;
  count: number;
  snippets: string[];
  /** From History, for the sessions with snippets: where and when, and whether it's listed. */
  folder?: string | null;
  lastActivityAt?: number | null;
  inList?: boolean;
  folderUsable?: boolean;
}

/** What History knows about a session, shown beside its matches. */
export interface SearchDetails {
  folder: string | null;
  lastActivityAt: number | null;
  inList: boolean;
  folderUsable?: boolean;
}

export type SearchStatus =
  | { status: "running"; filesDone: number; filesTotal: number }
  | {
      status: "done";
      filesDone: number;
      filesTotal: number;
      /** True when the 30-second limit stopped it before every file was read. */
      stopped: boolean;
      sessions: SearchHit[];
    }
  | { status: "gone" };

type Fields = Record<string, unknown>;

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    block !== null &&
    typeof block === "object" &&
    (block as Fields).type === "text" &&
    typeof (block as Fields).text === "string"
      ? [(block as Fields).text as string]
      : [],
  );
}

/**
 * The prompt or reply text in one transcript line, by U-22's allow-list: a prompt the user
 * typed or sent, or Claude's visible reply. Everything else is left out: thinking, tool calls
 * and results, inserted messages, compaction summaries, synthetic replies, and subagents.
 */
export function visibleText(fields: Fields): string[] {
  if (
    fields.isSidechain === true ||
    fields.isMeta === true ||
    fields.isCompactSummary === true ||
    fields.toolUseResult !== undefined
  ) {
    return [];
  }
  const message = fields.message;
  if (message === null || typeof message !== "object") return [];
  const { content, model } = message as Fields;
  if (fields.type === "user") {
    const origin = fields.origin as Fields | undefined;
    const human =
      (origin !== undefined && origin !== null && origin.kind === "human") ||
      fields.promptSource === "sdk";
    return human ? textBlocks(content) : [];
  }
  if (fields.type === "assistant") {
    if (model === "<synthetic>" || fields.isApiErrorMessage === true) return [];
    return Array.isArray(content) ? textBlocks(content) : [];
  }
  return [];
}

/**
 * Lowercases one character at a time, the same way findMatches folds the text. Lowercasing a
 * whole string turns a word-final "Σ" into "ς", which the text's "σ" wouldn't match.
 */
export function foldCase(text: string): string {
  return Array.from(text, (ch) => ch.toLowerCase()).join("");
}

/**
 * Every place the needle appears in the text, case-insensitively, as positions and lengths in
 * the original text. Lowercasing one character can change its length, as "İ" does, so matching
 * runs on a lowercased copy that keeps where each of its characters came from.
 */
export function findMatches(
  text: string,
  needle: string,
): { at: number; length: number }[] {
  return matchText(text, needle, Number.POSITIVE_INFINITY).matches;
}

/**
 * How many times the needle appears, and the positions of the first `keep` of them. Only those
 * positions are kept, and a position map is built only when lowercasing changes a character's
 * length, so a long message costs little more than its lowercased copy.
 */
export function matchText(
  text: string,
  needle: string,
  keep: number,
): { count: number; matches: { at: number; length: number }[] } {
  let lower: string;
  let from: Int32Array | null = null;
  // Plain ASCII text lowercases one for one.
  if (!/[^\t\n\r\x20-\x7e]/.test(text)) {
    lower = text.toLowerCase();
  } else {
    lower = "";
    let sameLength = true;
    for (const ch of text) {
      const folded = ch.toLowerCase();
      if (folded.length !== ch.length) sameLength = false;
      lower += folded;
    }
    if (!sameLength) {
      // Where each character of the lowercased copy came from in the original.
      from = new Int32Array(lower.length + 1);
      let index = 0;
      let at = 0;
      for (const ch of text) {
        const folded = ch.toLowerCase();
        for (let i = 0; i < folded.length; i += 1) from[at + i] = index;
        at += folded.length;
        index += ch.length;
      }
      from[lower.length] = text.length;
    }
  }
  const matches: { at: number; length: number }[] = [];
  let count = 0;
  let at = lower.indexOf(needle);
  while (at !== -1) {
    count += 1;
    if (matches.length < keep) {
      if (from === null) {
        matches.push({ at, length: needle.length });
      } else {
        const start = from[at] ?? 0;
        const end = from[at + needle.length] ?? text.length;
        matches.push({ at: start, length: Math.max(1, end - start) });
      }
    }
    at = lower.indexOf(needle, at + Math.max(1, needle.length));
  }
  return { count, matches };
}

/** Moves a cut point off the second half of a surrogate pair, so an emoji is never split. */
function safeCut(text: string, at: number): number {
  const code = text.charCodeAt(at);
  return code >= 0xdc00 && code <= 0xdfff ? at - 1 : at;
}

/** Up to SNIPPET_LENGTH characters around a match, with the match near the middle. */
export function snippetAround(
  text: string,
  at: number,
  length: number,
): string {
  const flat = text.replace(/\s+/g, " ");
  // Positions shift when whitespace collapses, so find the match again in the flat text.
  const before = text.slice(0, at).replace(/\s+/g, " ").length;
  const room = SNIPPET_LENGTH - 2;
  const start = safeCut(
    flat,
    Math.max(
      0,
      Math.min(before - Math.floor((room - length) / 2), flat.length - room),
    ),
  );
  const end = safeCut(flat, Math.min(flat.length, start + room));
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

interface Running {
  id: string;
  filesDone: number;
  filesTotal: number;
  hits: Map<string, SearchHit>;
  withSnippets: number;
  done: boolean;
  stopped: boolean;
  cancelled: boolean;
}

export interface SearchOptions {
  /** The main transcripts to search, newest first. */
  files: () => Promise<SearchFile[]>;
  now?: () => number;
  timeMs?: number;
  /** For tests: how long unfetched results are kept. */
  keptMs?: number;
  /** History's details for these sessions, read once a search is done. */
  describe?: (sessionIds: string[]) => Promise<Map<string, SearchDetails>>;
}

/**
 * Search inside conversations (FR-36, C-16). It reads prompts and replies only when asked, holds
 * them only while a search runs, and keeps nothing but the matches it returns, for at most a
 * minute. One search runs at a time; a new one cancels the old. It reads in pieces in the
 * server's own thread, pausing after each, so session updates aren't held up (NFR-15). Nothing
 * here is ever logged.
 */
export function createSearch(options: SearchOptions) {
  const now = options.now ?? Date.now;
  const limit = options.timeMs ?? SEARCH_TIME_MS;
  const keptMs = options.keptMs ?? RESULTS_KEPT_MS;
  let current: Running | null = null;
  let dropTimer: ReturnType<typeof setTimeout> | undefined;

  const clearDrop = () => {
    if (dropTimer !== undefined) clearTimeout(dropTimer);
    dropTimer = undefined;
  };

  const drop = () => {
    clearDrop();
    if (current !== null) current.cancelled = true;
    current = null;
  };

  const record = (
    run: Running,
    sessionId: string,
    text: string,
    needle: string,
  ) => {
    const existing = run.hits.get(sessionId);
    const have = existing?.snippets.length ?? 0;
    const roomForSessions =
      have > 0 || run.withSnippets < SESSIONS_WITH_SNIPPETS;
    const room = roomForSessions ? SNIPPETS_PER_SESSION - have : 0;
    const { count, matches } = matchText(text, needle, room);
    if (count === 0) return;
    let hit = existing;
    if (hit === undefined) {
      hit = { sessionId, count: 0, snippets: [] };
      run.hits.set(sessionId, hit);
    }
    hit.count += count;
    for (const match of matches) {
      if (hit.snippets.length === 0) run.withSnippets += 1;
      hit.snippets.push(snippetAround(text, match.at, match.length));
    }
  };

  const scanFile = async (
    run: Running,
    file: SearchFile,
    needle: string,
    deadline: number,
  ): Promise<void> => {
    // Decoded as a stream, so a character split between two pieces stays whole.
    const stream = createReadStream(file.file, {
      highWaterMark: CHUNK_BYTES,
      encoding: "utf8",
    });
    let carry = "";
    let skipping = false;
    const consume = (line: string) => {
      if (!line.includes('"user"') && !line.includes('"assistant"')) return;
      let fields: unknown;
      try {
        fields = JSON.parse(line);
      } catch {
        return;
      }
      if (fields === null || typeof fields !== "object") return;
      for (const text of visibleText(fields as Fields)) {
        record(run, file.sessionId, text, needle);
      }
    };
    try {
      for await (const chunk of stream) {
        const piece = chunk as string;
        let start = 0;
        let newline = piece.indexOf("\n");
        while (newline !== -1) {
          // A line too long to hold is skipped, even when its end arrives in this piece.
          if (!skipping && carry.length + (newline - start) <= MAX_LINE_CHARS) {
            consume(carry + piece.slice(start, newline));
          }
          carry = "";
          skipping = false;
          start = newline + 1;
          newline = piece.indexOf("\n", start);
        }
        if (!skipping) {
          carry += piece.slice(start);
          // A line too long to hold is skipped to its end.
          if (carry.length > MAX_LINE_CHARS) {
            carry = "";
            skipping = true;
          }
        }
        // Let polls and other requests run between pieces (NFR-15).
        await nextTurn();
        if (run.cancelled || now() >= deadline) return;
      }
      if (!skipping && carry !== "") consume(carry);
    } catch {
      // A file that can't be read is skipped.
    } finally {
      stream.destroy();
    }
  };

  const scan = async (run: Running, needle: string): Promise<void> => {
    const deadline = now() + limit;
    let files: SearchFile[];
    try {
      files = await options.files();
    } catch {
      files = [];
    }
    run.filesTotal = files.length;
    for (const file of files) {
      if (run.cancelled) return;
      if (now() >= deadline) {
        run.stopped = true;
        break;
      }
      await scanFile(run, file, needle, deadline);
      if (run.cancelled) return;
      run.filesDone += 1;
      if (now() >= deadline && run.filesDone < files.length) {
        run.stopped = true;
        break;
      }
    }
    // The sessions shown with snippets get History's details, so results can be used (FR-36).
    if (options.describe !== undefined && run.withSnippets > 0) {
      const shown = [...run.hits.values()].filter(
        (hit) => hit.snippets.length > 0,
      );
      // Held to the search's own time limit, so a busy History can't hold up the results.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const details = await Promise.race([
          options.describe(shown.map((hit) => hit.sessionId)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => {
                reject(new Error("timed out"));
              },
              Math.max(0, deadline - now()),
            );
          }),
        ]);
        if (run.cancelled) return;
        for (const hit of shown) {
          const found = details.get(hit.sessionId);
          if (found === undefined) continue;
          hit.folder = found.folder;
          hit.lastActivityAt = found.lastActivityAt;
          hit.inList = found.inList;
          if (found.folderUsable !== undefined)
            hit.folderUsable = found.folderUsable;
        }
      } catch {
        // Results still show, without their details.
      } finally {
        clearTimeout(timer);
      }
      if (run.cancelled) return;
    }
    run.done = true;
    // Unfetched results are dropped after a minute, whether or not anything asks again (C-16).
    if (current === run) {
      clearDrop();
      dropTimer = setTimeout(drop, keptMs);
      dropTimer.unref?.();
    }
  };

  return {
    /** Starts a search, cancelling any running one. Null if the query isn't allowed. */
    start(query: string): string | null {
      const trimmed = query.trim();
      if (trimmed.length < MIN_QUERY || trimmed.length > MAX_QUERY) return null;
      drop();
      const run: Running = {
        id: randomBytes(16).toString("hex"),
        filesDone: 0,
        filesTotal: 0,
        hits: new Map(),
        withSnippets: 0,
        done: false,
        stopped: false,
        cancelled: false,
      };
      current = run;
      void scan(run, foldCase(trimmed));
      return run.id;
    },

    /** Progress, or the results once, after which they're dropped (C-16). */
    poll(id: string): SearchStatus {
      const run = current;
      if (run === null || run.id !== id || run.cancelled)
        return { status: "gone" };
      if (!run.done) {
        return {
          status: "running",
          filesDone: run.filesDone,
          filesTotal: run.filesTotal,
        };
      }
      const sessions = [...run.hits.values()].sort((a, b) => b.count - a.count);
      drop();
      return {
        status: "done",
        filesDone: run.filesDone,
        filesTotal: run.filesTotal,
        stopped: run.stopped,
        sessions,
      };
    },

    /** Stops a search and drops what it found. */
    cancel(id: string): boolean {
      if (current === null || current.id !== id) return false;
      drop();
      return true;
    },
  };
}

export type Search = ReturnType<typeof createSearch>;
