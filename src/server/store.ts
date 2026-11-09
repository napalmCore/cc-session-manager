import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { estimateCost } from "../shared/prices.js";
import type { FinishedSession } from "../shared/protocol.js";

const APP_FOLDER = "cc-session-manager";
const FILE_NAME = "finished-sessions.json";
/** At most one corrupt copy is kept, with names removed (FR-30). */
export const CORRUPT_NAME = "finished-sessions.corrupt.json";
/** The copies 0.1.0 set aside, one per corrupt load, with names still in them. */
const OLD_CORRUPT = /^finished-sessions\.corrupt-(\d+)\.json$/;

const LOAD_PROBLEM =
  "The saved list of finished sessions could not be read, so it was reset.";
const LOCKED_PROBLEM =
  "The saved list of finished sessions could not be opened, so it was left as it is. Finished sessions won't be saved until it can be opened.";
const SAVE_PROBLEM =
  "Finished sessions could not be saved, and may be lost when the tool stops.";

const count = z.number().int().nonnegative();
/** Numbers and model IDs only (C-12). The cost isn't saved: it's worked out again on load. */
const usageGroupSchema = z.object({
  model: z.string(),
  speed: z.string(),
  geo: z.string(),
  source: z.enum(["main", "subagent"]),
  longContext: z.boolean(),
  input: count,
  output: count,
  cacheWrite5m: count,
  cacheWrite1h: count,
  cacheRead: count,
  webSearches: count,
});
const usageSchema = z.object({
  groups: z.array(usageGroupSchema),
  /** True while a finished session's transcripts haven't been fully read (FR-26). */
  counting: z.boolean(),
  partial: z.boolean().optional(),
});

/**
 * An explicit allow-list: anything else is dropped on both load and save. It leaves
 * out `name`, because the CLI uses a prompt as the name until a title is generated.
 */
const recordSchema = z.object({
  cwd: z.string().optional(),
  kind: z.string().optional(),
  startedAt: z.number().optional(),
  id: z.string().optional(),
  state: z.string().optional(),
  pid: z.number().optional(),
  status: z.string().optional(),
  waitingFor: z.string().optional(),
  sessionId: z.string().optional(),
  needsAttention: z.boolean(),
  attentionReason: z.string().nullable(),
  finished: z.boolean(),
  statusLabel: z.string(),
  finishedAt: z.number(),
  gitBranch: z.string().optional(),
  model: z.string().optional(),
  lastActivityAt: z.number().optional(),
  usage: usageSchema.optional(),
});
const fileSchema = z.object({
  version: z.literal(1),
  sessions: z.array(recordSchema),
});

export interface LoadResult {
  records: FinishedSession[];
  /** True when the file holds data the store no longer keeps, such as a name. */
  needsRewrite: boolean;
  notice: string | null;
  /** True when the file exists but couldn't be opened, so loading should be tried again. */
  locked?: boolean;
}

export interface StoreOptions {
  /** Where the store says what it did with a corrupt file. It's never given file contents. */
  log?: (message: string) => void;
}

export interface SessionStore {
  load: () => LoadResult;
  /** Returns a problem to show the user, or null on success. Never throws. */
  save: (records: FinishedSession[]) => string | null;
}

function withoutHeadBranch(record: FinishedSession): FinishedSession {
  if (record.gitBranch !== "HEAD") return record;
  const cleaned = { ...record };
  delete cleaned.gitBranch;
  return cleaned;
}

/** Adds the cost from the current price table, so a newer table applies to saved sessions. */
function withCost(record: FinishedSession): FinishedSession {
  if (!record.usage) return record;
  return {
    ...record,
    usage: { ...record.usage, ...estimateCost(record.usage.groups) },
  };
}

/** Removes every `name` and `title` field, at any depth, since they can hold prompt text. */
export function scrubNames(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubNames);
  if (value === null || typeof value !== "object") return value;
  const scrubbed: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (key === "name" || key === "title") continue;
    scrubbed[key] = scrubNames(field);
  }
  return scrubbed;
}

function writeAtomically(file: string, text: string): void {
  const temporary = `${file}.${String(process.pid)}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function printLine(message: string): void {
  console.log(message);
}

export function dataDirectory(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), APP_FOLDER);
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", APP_FOLDER);
  }
  return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), APP_FOLDER);
}

export function createFileStore(
  directory: string = dataDirectory(),
  { log = printLine }: StoreOptions = {},
): SessionStore {
  const file = join(directory, FILE_NAME);
  const corruptCopy = join(directory, CORRUPT_NAME);
  // Set when the file exists but can't be opened, so a save doesn't replace what's in it.
  let leaveFileAlone = false;

  /**
   * Keeps a file that parses but isn't valid as the one corrupt copy, with names removed.
   * Returns false if the copy couldn't be written, so the caller keeps the original.
   */
  const setAside = (parsed: unknown): boolean => {
    try {
      writeAtomically(corruptCopy, JSON.stringify(scrubNames(parsed), null, 2));
      return true;
    } catch {
      return false;
    }
  };

  const remove = (path: string) => {
    try {
      rmSync(path);
    } catch {
      // Tried again on the next start, or replaced by the next save.
    }
  };

  /** 0.1.0 kept every corrupt file, names and all: keep only the newest, scrubbed. */
  const tidyOldCopies = () => {
    let names: string[];
    try {
      names = readdirSync(directory).filter((name) => OLD_CORRUPT.test(name));
    } catch {
      return;
    }
    const time = (name: string) => Number(OLD_CORRUPT.exec(name)?.[1] ?? 0);
    names.sort((a, b) => time(b) - time(a));
    // A copy set aside by this version is newer than any that 0.1.0 left.
    let keepNewest = names.length > 0 && !existsSync(corruptCopy);
    for (const name of names) {
      const path = join(directory, name);
      if (keepNewest) {
        keepNewest = false;
        let raw: string;
        try {
          raw = readFileSync(path, "utf8");
        } catch {
          continue; // It can't be opened, so it's left alone.
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          remove(path);
          log(
            "An old copy of the saved list of finished sessions wasn't valid JSON, so it was deleted.",
          );
          continue;
        }
        if (!setAside(parsed)) continue;
      }
      remove(path);
    }
  };

  return {
    load() {
      tidyOldCopies();
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        if (!missing) leaveFileAlone = true;
        if (missing) return { records: [], notice: null, needsRewrite: false };
        return {
          records: [],
          notice: LOCKED_PROBLEM,
          needsRewrite: false,
          locked: true,
        };
      }
      leaveFileAlone = false;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        remove(file);
        log(
          "The saved list of finished sessions wasn't valid JSON, so it was deleted.",
        );
        return { records: [], notice: LOAD_PROBLEM, needsRewrite: false };
      }

      const result = fileSchema.safeParse(parsed);
      if (!result.success) {
        if (setAside(parsed)) {
          remove(file);
          log(
            `The saved list of finished sessions was set aside as ${CORRUPT_NAME}, with names removed.`,
          );
        }
        return { records: [], notice: LOAD_PROBLEM, needsRewrite: false };
      }

      const cleaned = (result.data.sessions as FinishedSession[]).map(
        withoutHeadBranch,
      );
      return {
        records: cleaned.map(withCost),
        notice: null,
        needsRewrite:
          JSON.stringify((parsed as { sessions: unknown }).sessions) !==
          JSON.stringify(cleaned),
      };
    },

    save(records) {
      if (leaveFileAlone) return LOCKED_PROBLEM;
      try {
        const sessions = z.array(recordSchema).parse(records);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeAtomically(
          file,
          JSON.stringify({ version: 1, sessions }, null, 2),
        );
        return null;
      } catch {
        return SAVE_PROBLEM;
      }
    },
  };
}
