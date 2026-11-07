import { lstat, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { SessionView } from "../shared/protocol.js";

/** Large enough to find all fields in every transcript measured on 2026-11-06. */
export const TAIL_BYTES = 256 * 1024;

const FORMAT_CHANGED =
  "Claude Code's transcript format may have changed, so some session details are unavailable.";

const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The allow-list for transcripts: every other field in a line is discarded. */
const lineSchema = z.object({
  gitBranch: z.string().optional().catch(undefined),
  timestamp: z.string().optional().catch(undefined),
  message: z
    .object({ model: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

export interface TranscriptMetadata {
  gitBranch?: string;
  model?: string;
  lastActivityAt?: number;
}

export interface Extraction {
  metadata: TranscriptMetadata;
  formatChanged: boolean;
}

export interface EnrichResult {
  sessions: SessionView[];
  warnings: string[];
}

/** Line types seen before the first timestamp in real transcripts on 2026-11-06. */
const HEADER_LINE_TYPES = new Set([
  "mode",
  "permission-mode",
  "session-owner",
  "atis-latch",
  "file-history-snapshot",
  "ai-title",
  "agent-name",
  "artifact-comment-monitor",
]);

function isKnownHeaderLine(value: unknown): boolean {
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && HEADER_LINE_TYPES.has(type);
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

export function extractMetadata(text: string): Extraction {
  const metadata: TranscriptMetadata = {};
  const lines = text.split("\n");
  let unexplainedLines = 0;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const result = lineSchema.safeParse(value);
    if (!result.success || Array.isArray(value)) continue;
    if (!isKnownHeaderLine(value)) unexplainedLines += 1;

    const { gitBranch, timestamp, message } = result.data;
    if (metadata.gitBranch === undefined && gitBranch) {
      metadata.gitBranch = gitBranch;
    }
    const model = message?.model;
    if (metadata.model === undefined && model && !model.startsWith("<")) {
      metadata.model = model;
    }
    if (metadata.lastActivityAt === undefined && timestamp) {
      const time = Date.parse(timestamp);
      if (!Number.isNaN(time)) metadata.lastActivityAt = time;
    }

    if (
      metadata.gitBranch !== undefined &&
      metadata.model !== undefined &&
      metadata.lastActivityAt !== undefined
    ) {
      break;
    }
  }

  // The CLI writes HEAD when a session has no branch to report, such as one started
  // outside a repository, so the value doesn't identify a branch.
  if (metadata.gitBranch === "HEAD") delete metadata.gitBranch;

  return {
    metadata,
    // A new transcript starts with header lines that have no timestamp. Any other
    // line without one suggests the format changed, so unknown lines warn.
    formatChanged:
      unexplainedLines > 0 && metadata.lastActivityAt === undefined,
  };
}

async function readTail(file: string, size: number): Promise<string> {
  const length = Math.min(size, TAIL_BYTES);
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    return size > TAIL_BYTES ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

interface CacheEntry {
  file: string;
  mtimeMs: number;
  size: number;
  extraction: Extraction;
}

export function createMetadataReader(root: string = claudeProjectsDirectory()) {
  const cache = new Map<string, CacheEntry>();
  const internals = { readTail };

  /** The file name is built from a validated ID, and links are never followed. */
  const statFile = async (file: string) => {
    try {
      const stats = await lstat(file);
      return stats.isFile() ? stats : null;
    } catch {
      return null;
    }
  };

  const locate = async (sessionId: string) => {
    const name = `${sessionId}.jsonl`;
    const projects = await readdir(root, { withFileTypes: true });
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const file = join(root, project.name, name);
      const stats = await statFile(file);
      if (stats) return { file, stats };
    }
    return null;
  };

  const read = async (sessionId: string): Promise<Extraction | null> => {
    try {
      const cached = cache.get(sessionId);
      const cachedStats = cached ? await statFile(cached.file) : null;
      const found =
        cached && cachedStats
          ? { file: cached.file, stats: cachedStats }
          : await locate(sessionId);
      if (!found) {
        cache.delete(sessionId);
        return null;
      }

      const { file, stats } = found;
      if (
        cached?.file === file &&
        cached.mtimeMs === stats.mtimeMs &&
        cached.size === stats.size
      ) {
        return cached.extraction;
      }

      const extraction = extractMetadata(
        await internals.readTail(file, stats.size),
      );
      cache.set(sessionId, {
        file,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        extraction,
      });
      return extraction;
    } catch {
      return null;
    }
  };

  return {
    internals,
    async enrich(sessions: SessionView[]): Promise<EnrichResult> {
      let formatChanged = false;
      const enriched = await Promise.all(
        sessions.map(async (session) => {
          const { sessionId } = session;
          if (sessionId === undefined || !isValidSessionId(sessionId)) {
            return session;
          }
          const extraction = await read(sessionId);
          if (!extraction) return session;
          if (extraction.formatChanged) formatChanged = true;
          return { ...session, ...extraction.metadata };
        }),
      );
      return {
        sessions: enriched,
        warnings: formatChanged ? [FORMAT_CHANGED] : [],
      };
    },
  };
}
