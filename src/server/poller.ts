import { exec, execFile } from "node:child_process";
import { homedir } from "node:os";
import type { SessionView, Snapshot } from "../shared/protocol.js";
import { sessionLaunchEnv } from "./programs.js";
import { toSessionView } from "./rules.js";
import { parseSessions } from "./schema.js";
import type { ListingState } from "./actions.js";
import type { TrackedSessions } from "./tracker.js";
import type { EnrichResult } from "./transcripts.js";

const POLL_FAILED =
  "Could not read sessions from Claude Code. Showing the last known data.";

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
}: PollerOptions): Poller {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let sessions: SessionView[] = [];
  let warnings: string[] = [];
  let lastSuccessAt: number | null = null;
  let lastPollFailed = false;
  let listedLastPoll = new Set<string>();
  let lastReported: string | undefined;

  const report = (error: string | null) => {
    const snapshot: Snapshot = { sessions, error, warnings };
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastReported) return;
    lastReported = serialized;
    onSnapshot(snapshot);
  };

  const tick = async () => {
    const pollStartedAt = Date.now();
    try {
      const parsed = parseSessions(await run(), listedLastPoll);
      listedLastPoll = parsed.listed;
      const views = parsed.sessions.map(toSessionView);
      const enriched = (await enrich?.(views)) ?? {
        sessions: views,
        warnings: [],
      };
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
      if (running) report(null);
    } catch {
      lastPollFailed = true;
      if (running) report(POLL_FAILED);
    }
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
