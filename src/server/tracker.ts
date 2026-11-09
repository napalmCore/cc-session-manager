import type {
  FinishedSession,
  SessionUsage,
  SessionView,
} from "../shared/protocol.js";
import type { SessionStore } from "./store.js";
import type { EnrichResult } from "./transcripts.js";

export const RETENTION_MS = 24 * 60 * 60 * 1000;
/** A finished session's transcript is read this long after it finishes, for late lines (BUG-27). */
export const READ_AFTER_FINISH_MS = 30_000;
/** Failed reads in a row, after the window, before a still-counting session is given up on. */
export const READS_BEFORE_GIVING_UP = 20;

/** Which sessions the transcript reader should read on this poll. */
export interface ReadPlan {
  /** Listed sessions to read: every live one, and finished ones still being read. */
  read: SessionView[];
  /** Finished sessions no longer listed, but still being read. */
  finished: FinishedSession[];
  /** Sessions whose reading has stopped, so the reader can drop what it holds for them. */
  forget: string[];
}

export interface ReadResult {
  before: SessionView;
  after: SessionView;
}

export interface TrackedSessions {
  sessions: SessionView[];
  warnings: string[];
}

export interface SessionTracker {
  update: (current: SessionView[]) => TrackedSessions;
  readPlan: (current: SessionView[]) => ReadPlan;
  /** Takes what was read for finished sessions, before the next update saves it. */
  absorb: (results: ReadResult[]) => void;
}

export interface TrackerOptions {
  store: SessionStore;
  now?: () => number;
}

function keyOf(session: SessionView): string | null {
  return session.sessionId ?? session.id ?? null;
}

/** What the transcript reader adds to a session, kept for a finished session it no longer reads. */
function transcriptFields(
  session: Partial<SessionView> | undefined,
): Partial<SessionView> {
  if (!session) return {};
  const fields: Partial<SessionView> = {};
  if (session.gitBranch !== undefined) fields.gitBranch = session.gitBranch;
  if (session.model !== undefined) fields.model = session.model;
  if (session.lastActivityAt !== undefined) {
    fields.lastActivityAt = session.lastActivityAt;
  }
  if (session.usage !== undefined) fields.usage = session.usage;
  return fields;
}

function tokenCount(usage: SessionUsage): number {
  return usage.groups.reduce(
    (sum, group) =>
      sum +
      group.input +
      group.output +
      group.cacheWrite5m +
      group.cacheWrite1h +
      group.cacheRead,
    0,
  );
}

/**
 * Saved usage stands until a new read is as complete and counts at least as much, so a
 * re-read from the start after a restart doesn't replace it with a partial count.
 */
function preferUsage(
  previous: SessionUsage | undefined,
  next: SessionUsage | undefined,
): SessionUsage | undefined {
  if (!previous) return next;
  if (!next) return previous;
  if (next.counting && !previous.counting) return previous;
  if (
    next.counting === previous.counting &&
    tokenCount(next) < tokenCount(previous)
  ) {
    return previous;
  }
  return next;
}

/** A finished session's fields after a read, keeping saved usage where it's better. */
function merged(
  previous: FinishedSession | undefined,
  next: SessionView,
): Partial<SessionView> {
  const fields: Partial<SessionView> = { ...next };
  const usage = preferUsage(previous?.usage, next.usage);
  if (usage) fields.usage = usage;
  return fields;
}

function toFinishedInteractive(
  session: SessionView,
  finishedAt: number,
): FinishedSession {
  const details = { ...session };
  delete details.status;
  delete details.waitingFor;
  delete details.pid;
  return {
    ...details,
    needsAttention: false,
    attentionReason: null,
    finished: true,
    statusLabel: "finished",
    finishedAt,
  };
}

/**
 * Records stay stored while the CLI still lists a session, even once hidden.
 * Without this, a completed background session would look newly finished on the
 * next poll and never leave the dashboard.
 */
export function createSessionTracker({
  store,
  now = Date.now,
}: TrackerOptions): SessionTracker {
  let loaded = store.load();
  const records = new Map<string, FinishedSession>();
  for (const record of loaded.records) {
    const key = keyOf(record);
    if (key) records.set(key, record);
  }
  let lastSaved = loaded.needsRewrite
    ? null
    : JSON.stringify([...records.values()]);
  let running = new Map<string, SessionView>();
  // Finished sessions being read, so the reader can be told when each stops.
  let reading = new Set<string>();
  // Failed reads in a row of finished sessions still being counted, after the window.
  const failures = new Map<string, number>();

  /**
   * A finished session is read for 30 seconds, and after that until it's fully counted, so
   * late lines and a large transcript are both taken in (FR-26, BUG-27).
   */
  const stillReading = (record: FinishedSession, time: number) =>
    time - record.finishedAt < READ_AFTER_FINISH_MS ||
    record.usage?.counting === true;

  /** A file that couldn't be opened at the start is tried again, and merged in once it opens. */
  const retryLoad = () => {
    if (loaded.locked !== true) return;
    const again = store.load();
    if (again.locked === true) return;
    for (const record of again.records) {
      const key = keyOf(record);
      if (key && !records.has(key)) records.set(key, record);
    }
    loaded = again;
    lastSaved = null;
  };

  return {
    readPlan(current) {
      const time = now();
      const listed = new Set(current.map(keyOf));
      const live = new Set(
        current.filter((session) => !session.finished).map(keyOf),
      );
      const next = new Set<string>();
      const read = current.filter((session) => {
        const key = keyOf(session);
        if (key === null || !session.finished) return true;
        const record = records.get(key);
        // First seen finished, so it's read until its record exists.
        if (!record) return true;
        if (!stillReading(record, time)) return false;
        next.add(key);
        return true;
      });
      const finished: FinishedSession[] = [];
      for (const [key, record] of records) {
        if (listed.has(key) || !stillReading(record, time)) continue;
        next.add(key);
        finished.push(record);
      }
      const forget = [...reading].filter(
        (key) => !next.has(key) && !live.has(key),
      );
      reading = next;
      return { read, finished, forget };
    },

    absorb(results) {
      const time = now();
      for (const { before, after } of results) {
        const key = keyOf(before);
        if (key === null) continue;
        const record = records.get(key);
        if (!record) continue;
        if (after === before) {
          // Nothing could be read, perhaps for a moment, as when another program has the file
          // open. Only many failures in a row, after the window, end the count, as partial.
          const usage = record.usage;
          if (
            time - record.finishedAt < READ_AFTER_FINISH_MS ||
            !usage?.counting
          ) {
            continue;
          }
          const failed = (failures.get(key) ?? 0) + 1;
          failures.set(key, failed);
          if (failed >= READS_BEFORE_GIVING_UP) {
            failures.delete(key);
            records.set(key, {
              ...record,
              usage: { ...usage, counting: false, partial: true },
            });
          }
          continue;
        }
        failures.delete(key);
        // A listed session is updated from the listing itself, in update().
        if (record === before) {
          records.set(key, {
            ...record,
            ...transcriptFields(merged(record, after)),
          });
        }
      }
    },

    update(current) {
      retryLoad();
      const time = now();
      const listedKeys = new Set(current.map(keyOf));
      const listedPids = new Set(current.map((session) => session.pid));
      const live: SessionView[] = [];
      const nextRunning = new Map<string, SessionView>();

      for (const session of current) {
        const key = keyOf(session);
        if (key === null) {
          live.push(session);
        } else if (session.finished) {
          const previous = records.get(key);
          const finishedAt = previous?.finishedAt ?? time;
          // A session the reader didn't read this time keeps what it last had.
          const kept = session.usage
            ? merged(previous, session)
            : { ...transcriptFields(previous), ...session };
          records.set(key, { ...session, ...kept, finishedAt });
        } else {
          records.delete(key);
          failures.delete(key);
          live.push(session);
          nextRunning.set(key, session);
        }
      }

      for (const [key, session] of running) {
        const ended =
          !listedKeys.has(key) &&
          session.kind !== "background" &&
          (session.pid === undefined || !listedPids.has(session.pid));
        if (ended) records.set(key, toFinishedInteractive(session, time));
      }
      running = nextRunning;

      for (const [key, record] of records) {
        const listed = listedKeys.has(key);
        const expired = time - record.finishedAt >= RETENTION_MS;
        const deleted = record.kind === "background" && !listed;
        if (deleted || (expired && !listed)) records.delete(key);
      }

      const warnings = loaded.notice ? [loaded.notice] : [];
      const toSave = [...records.values()];
      const serialized = JSON.stringify(toSave);
      if (serialized !== lastSaved) {
        const problem = store.save(toSave);
        if (problem) warnings.push(problem);
        else lastSaved = serialized;
      }

      const visible = toSave.filter(
        (record) => time - record.finishedAt < RETENTION_MS,
      );
      return {
        sessions: [...live, ...visible],
        warnings: [...new Set(warnings)],
      };
    },
  };
}

export interface TranscriptReading {
  enrich: (current: SessionView[]) => Promise<EnrichResult>;
  forget: (sessionId: string) => void;
}

/**
 * Reads listed sessions and recently finished ones together, within the reader's one budget,
 * and hands what was read for finished sessions to the tracker.
 */
export function enrichWithFinished(
  tracker: SessionTracker,
  reader: TranscriptReading,
): (current: SessionView[]) => Promise<EnrichResult> {
  return async (current) => {
    const plan = tracker.readPlan(current);
    for (const sessionId of plan.forget) reader.forget(sessionId);
    const input = [...plan.read, ...plan.finished];
    const result = await reader.enrich(input);
    const read = new Map<SessionView, SessionView>();
    input.forEach((session, index) => {
      read.set(session, result.sessions[index] ?? session);
    });
    tracker.absorb(
      input
        .filter((session) => session.finished)
        .map((before) => ({ before, after: read.get(before) ?? before })),
    );
    return {
      sessions: current.map((session) => read.get(session) ?? session),
      warnings: result.warnings,
    };
  };
}
