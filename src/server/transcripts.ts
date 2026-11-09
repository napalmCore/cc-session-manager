import { lstat, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type {
  SessionUsage,
  SessionView,
  UsageCounts,
  UsageGroup,
} from "../shared/protocol.js";

/** The most bytes read across all transcripts in one poll (NFR-11). */
export const READ_BUDGET_BYTES = 8 * 1024 * 1024;

/** Complete lines in a row with no usable entry before a format warning (BUG-24, BUG-26). */
export const FORMAT_RUN = 20;

/** A line longer than this is dropped, up to its end, rather than held in memory. */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

/** While a transcript is still being counted, its metadata comes from this much of its end. */
export const TAIL_BYTES = 256 * 1024;

/** The first bytes of a file, compared on each read to notice a replaced file. */
const HEAD_BYTES = 64;

/** Claude Haiku 5.5 prompts strictly over this many tokens cost more (FR-24). */
export const LONG_CONTEXT_TOKENS = 100_000;

/** Reader state for sessions not asked about for this long is dropped. */
const FORGET_AFTER_MS = 10 * 60 * 1000;

const FORMAT_CHANGED =
  "Claude Code's transcript format may have changed, so some session details are unavailable.";

const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUBAGENT_FILE = /^agent-[A-Za-z0-9_-]+\.jsonl$/;

const count = z.number().int().nonnegative().catch(0);
const text = z.string().optional().catch(undefined);

/** The allow-list for transcripts: every other field in a line is discarded (C-4, C-12). */
const lineSchema = z.object({
  gitBranch: text,
  timestamp: text,
  isSidechain: z.boolean().optional().catch(undefined),
  message: z
    .object({
      id: text,
      model: text,
      usage: z
        .object({
          input_tokens: count.optional(),
          output_tokens: count.optional(),
          cache_creation_input_tokens: count.optional(),
          cache_read_input_tokens: count.optional(),
          cache_creation: z
            .object({
              ephemeral_5m_input_tokens: count.optional(),
              ephemeral_1h_input_tokens: count.optional(),
            })
            .optional()
            .catch(undefined),
          server_tool_use: z
            .object({ web_search_requests: count.optional() })
            .optional()
            .catch(undefined),
          speed: text,
          inference_geo: text,
        })
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
});

type Line = z.infer<typeof lineSchema>;

export interface TranscriptMetadata {
  gitBranch?: string;
  model?: string;
  lastActivityAt?: number;
}

export interface EnrichResult {
  sessions: SessionView[];
  warnings: string[];
}

type Source = UsageGroup["source"];

interface Response {
  key: string;
  group: UsageGroup;
}

/** What has been learned from a transcript's text so far. */
export interface TextState {
  source: Source;
  branch?: string;
  model?: string;
  lastActivityAt?: number;
  /** Usage per response ID, from the latest line for that ID, so repeats count once. */
  responses: Map<string, Response>;
  unnamed: number;
  badRun: number;
  formatChanged: boolean;
}

export function createTextState(source: Source = "main"): TextState {
  return {
    source,
    responses: new Map(),
    unnamed: 0,
    badRun: 0,
    formatChanged: false,
  };
}

export function isValidSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

export function claudeProjectsDirectory(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "projects");
}

function parse(line: string): Line | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const result = lineSchema.safeParse(value);
  return result.success ? result.data : null;
}

function validTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

function isPlaceholderModel(model: string): boolean {
  return model.startsWith("<");
}

function groupKey(group: UsageGroup): string {
  return [
    group.model,
    group.speed,
    group.geo,
    group.source,
    group.longContext ? "long" : "short",
  ].join("\u0000");
}

function recordUsage(state: TextState, line: Line): void {
  const message = line.message;
  const usage = message?.usage;
  const model = message?.model;
  if (!usage || !model || isPlaceholderModel(model)) return;

  const totalWrite = usage.cache_creation_input_tokens ?? 0;
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m =
    usage.cache_creation?.ephemeral_5m_input_tokens ??
    Math.max(0, totalWrite - write1h);
  const input = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const prompt = input + cacheRead + write5m + write1h;

  const group: UsageGroup = {
    model,
    speed: usage.speed ?? "standard",
    geo: usage.inference_geo ?? "global",
    source:
      state.source === "subagent" || line.isSidechain ? "subagent" : "main",
    longContext:
      model.startsWith("claude-haiku-5-5") && prompt > LONG_CONTEXT_TOKENS,
    input,
    output: usage.output_tokens ?? 0,
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
    cacheRead,
    webSearches: usage.server_tool_use?.web_search_requests ?? 0,
  };
  const id = message.id ?? `unnamed-${(state.unnamed += 1)}`;
  state.responses.set(id, { key: groupKey(group), group });
}

/** The newest line containing `marker` that yields a value, searching backwards. */
function newest<T>(
  lines: string[],
  marker: string,
  pick: (line: Line) => T | undefined,
): T | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line?.includes(marker)) continue;
    const parsed = parse(line);
    if (!parsed) continue;
    const value = pick(parsed);
    if (value !== undefined) return value;
  }
  return undefined;
}

function noteBad(state: TextState): void {
  state.badRun += 1;
  if (state.badRun >= FORMAT_RUN) state.formatChanged = true;
}

/**
 * Takes complete transcript lines. Only lines with usage are parsed in full; the
 * metadata comes from the newest line holding each field (NFR-11).
 */
export function consumeLines(state: TextState, chunk: string): void {
  const lines = chunk.split("\n").map((line) => line.replace(/\r$/, ""));

  for (const line of lines) {
    if (!line) continue;
    if (!(line.startsWith("{") && line.endsWith("}"))) {
      noteBad(state);
      continue;
    }
    if (line.includes('"usage"')) {
      const parsed = parse(line);
      // Only assistant lines are judged: other line types, such as attachments, can
      // mention usage without being a model response.
      if (line.includes('"type":"assistant"')) {
        if (
          parsed?.message !== undefined &&
          validTime(parsed.timestamp) !== undefined
        ) {
          state.badRun = 0;
        } else {
          noteBad(state);
        }
      }
      if (parsed) recordUsage(state, parsed);
      continue;
    }
    if (line.includes('"type":"assistant"') && !line.includes('"message"')) {
      noteBad(state);
    }
  }

  const time = newest(lines, '"timestamp"', (line) =>
    validTime(line.timestamp),
  );
  if (time !== undefined) state.lastActivityAt = time;

  // An empty branch is skipped; HEAD counts as the newest value and is hidden later.
  const branch = newest(lines, '"gitBranch"', (line) =>
    line.gitBranch ? line.gitBranch : undefined,
  );
  if (branch !== undefined) state.branch = branch;

  const model = newest(lines, '"model"', (line) => {
    const value = line.message?.model;
    return value && !isPlaceholderModel(value) ? value : undefined;
  });
  if (model !== undefined) state.model = model;
}

export function metadataOf(state: TextState): TranscriptMetadata {
  const metadata: TranscriptMetadata = {};
  // The CLI writes HEAD when a session has no branch to report, such as one started
  // outside a repository, so the value doesn't identify a branch.
  if (state.branch !== undefined && state.branch !== "HEAD") {
    metadata.gitBranch = state.branch;
  }
  if (state.model !== undefined) metadata.model = state.model;
  if (state.lastActivityAt !== undefined) {
    metadata.lastActivityAt = state.lastActivityAt;
  }
  return metadata;
}

const COUNT_FIELDS: (keyof UsageCounts)[] = [
  "input",
  "output",
  "cacheWrite5m",
  "cacheWrite1h",
  "cacheRead",
  "webSearches",
];

/** Adds up each state's responses into one usage group per model, speed, routing, and source. */
export function summarizeUsage(states: TextState[]): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const state of states) {
    for (const { key, group } of state.responses.values()) {
      const total = groups.get(key);
      if (!total) {
        groups.set(key, { ...group });
        continue;
      }
      for (const field of COUNT_FIELDS) total[field] += group[field];
    }
  }
  return [...groups.values()];
}

interface FileState {
  file: string;
  offset: number;
  pending: Buffer;
  /** True after an overlong line was dropped, until the next newline. */
  skipping: boolean;
  size: number;
  mtimeMs: number;
  head: Buffer;
  text: TextState;
}

interface TailMetadata {
  size: number;
  mtimeMs: number;
  metadata: TranscriptMetadata;
}

interface SessionState {
  main: FileState;
  /** Metadata from the end of the main transcript, used until it's fully read. */
  tail?: TailMetadata | undefined;
  subagentDir?: { path: string; mtimeMs: number } | undefined;
  subagents: Map<string, FileState>;
  lastAsked: number;
}

function newFile(file: string, source: Source): FileState {
  return {
    file,
    offset: 0,
    pending: Buffer.alloc(0),
    skipping: false,
    size: 0,
    mtimeMs: 0,
    head: Buffer.alloc(0),
    text: createTextState(source),
  };
}

function restart(state: FileState): void {
  Object.assign(state, newFile(state.file, state.text.source));
}

async function readBytes(
  file: string,
  position: number,
  length: number,
): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The file name is built from a validated ID, and links are never followed. */
async function statFile(file: string) {
  try {
    const stats = await lstat(file);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}

/** Whether a session has a transcript, which Resume needs. Links aren't followed. */
export async function transcriptExists(
  sessionId: string,
  root: string = claudeProjectsDirectory(),
): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;
  try {
    const projects = await readdir(root, { withFileTypes: true });
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      if (await statFile(join(root, project.name, `${sessionId}.jsonl`))) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function createTranscriptReader(
  root: string = claudeProjectsDirectory(),
  options: { budgetBytes?: number; now?: () => number } = {},
) {
  const budgetBytes = options.budgetBytes ?? READ_BUDGET_BYTES;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, SessionState>();
  const internals = { readBytes };

  const locate = async (sessionId: string) => {
    const name = `${sessionId}.jsonl`;
    const projects = await readdir(root, { withFileTypes: true });
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const file = join(root, project.name, name);
      if (await statFile(file)) return file;
    }
    return null;
  };

  /** Reads new bytes of one file within the budget; false if the file has gone. */
  const readFile = async (
    state: FileState,
    budget: { left: number },
  ): Promise<boolean> => {
    const stats = await statFile(state.file);
    if (!stats) return false;

    const unchanged =
      stats.size === state.size &&
      stats.mtimeMs === state.mtimeMs &&
      state.offset === stats.size;
    if (unchanged) return true;

    if (state.offset > 0) {
      let replaced = stats.size < state.offset;
      if (!replaced && state.head.length > 0) {
        const head = await internals.readBytes(
          state.file,
          0,
          state.head.length,
        );
        replaced = !head.equals(state.head);
      }
      if (replaced) restart(state);
    }

    state.size = stats.size;
    state.mtimeMs = stats.mtimeMs;
    const length = Math.min(stats.size - state.offset, budget.left);
    if (length <= 0) return true;

    const bytes = await internals.readBytes(state.file, state.offset, length);
    budget.left -= bytes.length;
    const start = state.offset;
    state.offset += bytes.length;
    if (state.head.length < HEAD_BYTES && start < HEAD_BYTES) {
      state.head = Buffer.concat([state.head, bytes]).subarray(0, HEAD_BYTES);
      state.head = Buffer.from(state.head);
    }

    let data = bytes;
    if (state.skipping) {
      const next = data.indexOf(0x0a);
      if (next === -1) return true;
      state.skipping = false;
      data = data.subarray(next + 1);
    }

    // Lines are split as bytes, so a character cut across two reads is decoded whole.
    const combined = Buffer.concat([state.pending, data]);
    const end = combined.lastIndexOf(0x0a);
    if (end === -1) {
      state.pending = combined;
    } else {
      consumeLines(state.text, combined.subarray(0, end).toString("utf8"));
      state.pending = Buffer.from(combined.subarray(end + 1));
    }
    if (state.pending.length > MAX_PENDING_BYTES) {
      state.pending = Buffer.alloc(0);
      state.skipping = true;
      noteBad(state.text);
    }
    return true;
  };

  /** A real folder, not a link or junction, or null. */
  const statFolder = async (path: string) => {
    try {
      const stats = await lstat(path);
      return stats.isDirectory() && !stats.isSymbolicLink() ? stats : null;
    } catch {
      return null;
    }
  };

  const refreshSubagents = async (session: SessionState, sessionId: string) => {
    const sessionFolder = join(dirname(session.main.file), sessionId);
    const path = join(sessionFolder, "subagents");
    const stats = (await statFolder(sessionFolder))
      ? await statFolder(path)
      : null;
    if (!stats) {
      // Files already tracked are dropped too, so nothing is read through a new link.
      session.subagentDir = undefined;
      session.subagents.clear();
      return;
    }
    if (
      session.subagentDir?.path === path &&
      session.subagentDir.mtimeMs === stats.mtimeMs
    ) {
      return;
    }
    // Remembered only once the listing succeeds, so a failed listing is retried.
    const entries = await readdir(path, { withFileTypes: true });
    session.subagentDir = { path, mtimeMs: stats.mtimeMs };
    for (const entry of entries) {
      if (!entry.isFile() || !SUBAGENT_FILE.test(entry.name)) continue;
      const file = join(path, entry.name);
      if (!session.subagents.has(file)) {
        session.subagents.set(file, newFile(file, "subagent"));
      }
    }
  };

  /**
   * The main transcript's metadata. While it's still being counted, the lines read so far
   * are old, so the metadata comes from its last 256 KB instead.
   */
  const currentMetadata = async (
    session: SessionState,
  ): Promise<TranscriptMetadata> => {
    const main = session.main;
    if (main.offset >= main.size) {
      session.tail = undefined;
      return metadataOf(main.text);
    }
    const cached = session.tail;
    if (cached?.size === main.size && cached.mtimeMs === main.mtimeMs) {
      return { ...cached.metadata };
    }
    const length = Math.min(main.size, TAIL_BYTES);
    const bytes = await internals.readBytes(
      main.file,
      main.size - length,
      length,
    );
    const end = bytes.lastIndexOf(0x0a);
    let text = end === -1 ? "" : bytes.subarray(0, end).toString("utf8");
    // The first line is usually cut off, so it's left out.
    if (length < main.size) text = text.slice(text.indexOf("\n") + 1);
    const state = createTextState();
    consumeLines(state, text);
    // A field missing from the end falls back to what's been read so far.
    const metadata = { ...metadataOf(main.text), ...metadataOf(state) };
    session.tail = { size: main.size, mtimeMs: main.mtimeMs, metadata };
    return { ...metadata };
  };

  const read = async (
    sessionId: string,
    budget: { left: number },
  ): Promise<{
    metadata: TranscriptMetadata;
    usage: SessionUsage;
    formatChanged: boolean;
  } | null> => {
    try {
      let session = sessions.get(sessionId);
      if (session && !(await statFile(session.main.file))) {
        sessions.delete(sessionId);
        session = undefined;
      }
      if (!session) {
        const file = await locate(sessionId);
        if (!file) return null;
        session = {
          main: newFile(file, "main"),
          subagents: new Map(),
          lastAsked: now(),
        };
        sessions.set(sessionId, session);
      }
      session.lastAsked = now();

      if (!(await readFile(session.main, budget))) {
        sessions.delete(sessionId);
        return null;
      }
      await refreshSubagents(session, sessionId).catch(() => undefined);
      for (const [file, state] of session.subagents) {
        let present: boolean;
        try {
          present = await readFile(state, budget);
        } catch {
          // A locked file is read again next poll; only a file that's gone is dropped.
          present = (await statFile(file)) !== null;
        }
        if (!present) session.subagents.delete(file);
      }

      const files = [session.main, ...session.subagents.values()];
      const metadata = await currentMetadata(session);
      // Without this, an idle session whose newest line can't be read would look newly
      // blocked, because Stale depends on knowing its last activity.
      metadata.lastActivityAt ??= Math.floor(session.main.mtimeMs);
      return {
        metadata,
        usage: {
          groups: summarizeUsage(files.map((file) => file.text)),
          counting: files.some((file) => file.offset < file.size),
        },
        formatChanged: session.main.text.formatChanged,
      };
    } catch {
      return null;
    }
  };

  return {
    internals,
    async enrich(current: SessionView[]): Promise<EnrichResult> {
      const budget = { left: budgetBytes };
      let formatChanged = false;
      const results = new Map<SessionView, SessionView>();

      // Newest sessions first, so they're counted first when the budget runs out.
      const order = [...current].sort(
        (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0),
      );
      for (const session of order) {
        const { sessionId } = session;
        if (sessionId === undefined || !isValidSessionId(sessionId)) continue;
        const found = await read(sessionId, budget);
        if (!found) continue;
        if (found.formatChanged) formatChanged = true;
        results.set(session, {
          ...session,
          ...found.metadata,
          usage: found.usage,
        });
      }

      const cutoff = now() - FORGET_AFTER_MS;
      for (const [id, state] of sessions) {
        if (state.lastAsked < cutoff) sessions.delete(id);
      }

      return {
        sessions: current.map((session) => results.get(session) ?? session),
        warnings: formatChanged ? [FORMAT_CHANGED] : [],
      };
    },
  };
}
