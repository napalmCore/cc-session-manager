import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { FinishedSession } from "../shared/protocol.js";

const APP_FOLDER = "cc-session-manager";
const FILE_NAME = "finished-sessions.json";

const LOAD_PROBLEM =
  "The saved list of finished sessions could not be read, so it was reset.";
const SAVE_PROBLEM =
  "Finished sessions could not be saved, and may be lost when the tool stops.";

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
): SessionStore {
  const file = join(directory, FILE_NAME);

  return {
    load() {
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        return {
          records: [],
          notice: missing ? null : LOAD_PROBLEM,
          needsRewrite: false,
        };
      }

      try {
        const parsed: unknown = JSON.parse(raw);
        const { sessions } = fileSchema.parse(parsed);
        const records = (sessions as FinishedSession[]).map(withoutHeadBranch);
        return {
          records,
          notice: null,
          needsRewrite:
            JSON.stringify((parsed as { sessions: unknown }).sessions) !==
            JSON.stringify(records),
        };
      } catch {
        try {
          const name = `finished-sessions.corrupt-${String(Date.now())}.json`;
          renameSync(file, join(directory, name));
        } catch {
          // The list still resets for this run, and the next save replaces the file.
        }
        return { records: [], notice: LOAD_PROBLEM, needsRewrite: false };
      }
    },

    save(records) {
      const temporary = `${file}.${String(process.pid)}.tmp`;
      try {
        const sessions = z.array(recordSchema).parse(records);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeFileSync(
          temporary,
          JSON.stringify({ version: 1, sessions }, null, 2),
          { mode: 0o600 },
        );
        renameSync(temporary, file);
        return null;
      } catch {
        rmSync(temporary, { force: true });
        return SAVE_PROBLEM;
      }
    },
  };
}
