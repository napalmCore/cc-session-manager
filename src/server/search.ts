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
  const start = Math.max(
    0,
    Math.min(before - Math.floor((room - length) / 2), flat.length - room),
  );
  const end = Math.min(flat.length, start + room);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

interface Running {
  id: string;
  filesDone: number;
  filesTotal: number;
  hits: Map<string, SearchHit>;
  done: boolean;
  stopped: boolean;
  cancelled: boolean;
  readyAt: number | null;
}

export interface SearchOptions {
  /** The main transcripts to search, newest first. */
  files: () => Promise<SearchFile[]>;
  now?: () => number;
  timeMs?: number;
}

/**
 * Search inside conversations (FR-36, C-16). It reads prompts and replies only when asked, holds
 * them only while a search runs, and keeps nothing but the matches it returns, for at most a
 * minute. One search runs at a time; a new one cancels the old. Reading pauses after each piece,
 * so session updates aren't held up (NFR-15). Nothing here is ever logged.
 */
export function createSearch(options: SearchOptions) {
  const now = options.now ?? Date.now;
  const limit = options.timeMs ?? SEARCH_TIME_MS;
  let current: Running | null = null;

  const scanFile = async (
    run: Running,
    file: SearchFile,
    needle: string,
    deadline: number,
  ): Promise<void> => {
    const stream = createReadStream(file.file, { highWaterMark: CHUNK_BYTES });
    let carry = "";
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
        const lower = text.toLowerCase();
        let at = lower.indexOf(needle);
        while (at !== -1) {
          let hit = run.hits.get(file.sessionId);
          if (hit === undefined) {
            hit = { sessionId: file.sessionId, count: 0, snippets: [] };
            run.hits.set(file.sessionId, hit);
          }
          hit.count += 1;
          const withSnippets = [...run.hits.values()].filter(
            (h) => h.snippets.length > 0,
          ).length;
          if (
            hit.snippets.length < SNIPPETS_PER_SESSION &&
            (hit.snippets.length > 0 || withSnippets < SESSIONS_WITH_SNIPPETS)
          ) {
            hit.snippets.push(snippetAround(text, at, needle.length));
          }
          at = lower.indexOf(needle, at + needle.length);
        }
      }
    };
    try {
      for await (const chunk of stream) {
        const text = carry + (chunk as Buffer).toString("utf8");
        const lines = text.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) consume(line);
        // Let polls and other requests run between pieces (NFR-15).
        await nextTurn();
        if (run.cancelled || now() >= deadline) {
          stream.destroy();
          return;
        }
      }
      if (carry !== "") consume(carry);
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
      if (now() >= deadline && run.filesDone < files.length - 1)
        run.stopped = true;
      if (run.cancelled) return;
      run.filesDone += 1;
      if (run.stopped) break;
    }
    run.done = true;
    run.readyAt = now();
  };

  const expire = () => {
    if (
      current !== null &&
      current.readyAt !== null &&
      now() - current.readyAt > RESULTS_KEPT_MS
    ) {
      current = null;
    }
  };

  return {
    /** Starts a search, cancelling any running one. Null if the query isn't allowed. */
    start(query: string): string | null {
      const trimmed = query.trim();
      if (trimmed.length < MIN_QUERY || trimmed.length > MAX_QUERY) return null;
      if (current !== null) current.cancelled = true;
      const run: Running = {
        id: randomBytes(16).toString("hex"),
        filesDone: 0,
        filesTotal: 0,
        hits: new Map(),
        done: false,
        stopped: false,
        cancelled: false,
        readyAt: null,
      };
      current = run;
      void scan(run, trimmed.toLowerCase());
      return run.id;
    },

    /** Progress, or the results once, after which they're dropped (C-16). */
    poll(id: string): SearchStatus {
      expire();
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
      current = null;
      return {
        status: "done",
        filesDone: run.filesDone,
        filesTotal: run.filesTotal,
        stopped: run.stopped,
        sessions: [...run.hits.values()].sort((a, b) => b.count - a.count),
      };
    },

    /** Stops a search and drops what it found. */
    cancel(id: string): boolean {
      if (current === null || current.id !== id) return false;
      current.cancelled = true;
      current = null;
      return true;
    },
  };
}

export type Search = ReturnType<typeof createSearch>;
