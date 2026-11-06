import { exec } from "node:child_process";
import { homedir } from "node:os";
import type { SessionView, Snapshot } from "../shared/protocol.js";
import { toSessionView } from "./rules.js";
import { parseSessions } from "./schema.js";
import type { TrackedSessions } from "./tracker.js";
import type { EnrichResult } from "./transcripts.js";

const POLL_FAILED =
  "Could not read sessions from Claude Code. Showing the last known data.";

/**
 * Runs through a shell because npm installs `claude` as a .cmd file on Windows.
 * The command is a constant, and running from the home folder stops Windows from
 * finding a `claude` program planted in the folder the tool was started from.
 */
export function runClaudeAgents(): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      "claude agents --json --all",
      {
        cwd: homedir(),
        timeout: 15_000,
        maxBuffer: 10_000_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
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
  let previousParseWarnings = new Set<string>();
  let lastReported: string | undefined;

  const report = (error: string | null) => {
    const snapshot: Snapshot = { sessions, error, warnings };
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastReported) return;
    lastReported = serialized;
    onSnapshot(snapshot);
  };

  const tick = async () => {
    try {
      const parsed = parseSessions(await run());
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
      // The CLI's first listing of a new session can lack fields, so only a problem
      // seen in two polls in a row is reported.
      const repeated = parsed.warnings.filter((warning) =>
        previousParseWarnings.has(warning),
      );
      previousParseWarnings = new Set(parsed.warnings);
      warnings = [...repeated, ...enriched.warnings, ...tracked.warnings];
      if (running) report(null);
    } catch {
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
  };
}
