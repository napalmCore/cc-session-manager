import { exec, execFile } from "node:child_process";
import { homedir } from "node:os";
import type { SessionView, Snapshot } from "../shared/protocol.js";
import { sessionLaunchEnv } from "./programs.js";
import { toSessionViewAt } from "./rules.js";
import { parseSessions } from "./schema.js";
import { createSessionMemory } from "./session-memory.js";
import type { ListingState } from "./actions.js";
import type { TrackedSessions } from "./tracker.js";
import type { EnrichResult } from "./transcripts.js";

const POLL_FAILED =
  "Could not read sessions from Claude Code. Showing the last known data.";
/** Before any poll has succeeded there's no data to show, known or not (BUG-17). */
export const NOT_LOADED_YET =
  "Can't read sessions yet: Claude Code didn't return its session list. Trying again every few seconds.";

const AGENTS_ARGS = ["agents", "--json", "--all"];
const RUN_OPTIONS = {
  timeout: 15_000,
  maxBuffer: 10_000_000,
  windowsHide: true,
};

/**
 * Runs `claude agents --json --all`. With a resolved `claude.exe`, it runs that file directly,
 * with no shell (C-11). Without one, it falls back to iteration 1's method: a shell from the
 * home folder, because npm installs `claude` as a .cmd file. The command is a constant either
 * way, and the home folder stops Windows finding a `claude` planted where the tool started.
 */
export function runClaudeAgents(
  claudeExe: string | null = null,
  timeoutMs: number = RUN_OPTIONS.timeout,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, stdout: string) => {
      if (error) reject(error);
      else resolve(stdout);
    };
    if (claudeExe !== null) {
      execFile(
        claudeExe,
        AGENTS_ARGS,
        {
          ...RUN_OPTIONS,
          timeout: timeoutMs,
          cwd: homedir(),
          env: sessionLaunchEnv(process.env),
        },
        (error, stdout) => {
          done(error, stdout);
        },
      );
    } else {
      exec(
        `claude ${AGENTS_ARGS.join(" ")}`,
        { ...RUN_OPTIONS, timeout: timeoutMs, cwd: homedir() },
        (error, stdout) => {
          done(error, stdout);
        },
      );
    }
  });
}

export interface PollerOptions {
  run: () => Promise<string>;
  intervalMs: number;
  onSnapshot: (snapshot: Snapshot) => void;
  track?: (current: SessionView[]) => TrackedSessions;
  enrich?: (current: SessionView[]) => Promise<EnrichResult>;
  /** Called after every poll, whether or not anything changed (BUG-9). */
  onPoll?: (state: ListingState) => void;
}

export interface Poller {
  start: () => void;
  stop: () => void;
  /** The latest listing and its freshness, for the action tracker. */
  state: () => ListingState;
}

export function createPoller({
  run,
  intervalMs,
  onSnapshot,
  track,
  enrich,
  onPoll,
}: PollerOptions): Poller {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let sessions: SessionView[] = [];
  let warnings: string[] = [];
  let lastSuccessAt: number | null = null;
  let lastPollFailed = false;
  let failedPolls = 0;
  const memory = createSessionMemory();
  let lastReported: string | undefined;

  const report = (error: string | null) => {
    const snapshot: Snapshot = { sessions, error, warnings };
    if (error !== null && failedPolls > 0) snapshot.failedPolls = failedPolls;
    if (lastSuccessAt === null) snapshot.notLoadedYet = true;
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastReported) return;
    lastReported = serialized;
    onSnapshot(snapshot);
  };

  const tick = async () => {
    const pollStartedAt = Date.now();
    try {
      const output = await run();
      const parsed = parseSessions(output, (session) =>
        memory.isStarting(session),
      );
      memory.observe(parsed.sessions);
      const views = parsed.sessions.map((session) =>
        toSessionViewAt(session, memory.isStarting(session)),
      );
      const read = (await enrich?.(views)) ?? {
        sessions: views,
        warnings: [],
      };
      const enriched = { ...read, sessions: memory.recall(read.sessions) };
      const tracked = track?.(enriched.sessions) ?? {
        sessions: enriched.sessions,
        warnings: [],
      };
      sessions = tracked.sessions;
      warnings = [
        ...parsed.warnings,
        ...enriched.warnings,
        ...tracked.warnings,
      ];
      lastSuccessAt = pollStartedAt;
      lastPollFailed = false;
      failedPolls = 0;
      if (running) report(null);
    } catch {
      lastPollFailed = true;
      failedPolls += 1;
      if (running)
        report(lastSuccessAt === null ? NOT_LOADED_YET : POLL_FAILED);
    }
    if (running) onPoll?.({ sessions, lastSuccessAt, lastPollFailed });
    if (running) timer = setTimeout(() => void tick(), intervalMs);
  };

  return {
    start() {
      if (running) return;
      running = true;
      void tick();
    },
    stop() {
      running = false;
      clearTimeout(timer);
    },
    state() {
      return { sessions, lastSuccessAt, lastPollFailed };
    },
  };
}
