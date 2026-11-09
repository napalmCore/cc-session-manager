import type { FinishedSession, SessionView } from "../shared/protocol.js";
import type { SessionStore } from "./store.js";
import type { EnrichResult } from "./transcripts.js";

export const RETENTION_MS = 24 * 60 * 60 * 1000;
/** A finished session's transcript is read this long after it finishes, for late lines (BUG-27). */
export const READ_AFTER_FINISH_MS = 30_000;

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
  session: SessionView | undefined,
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
  const loaded = store.load();
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
  // Finished sessions whose transcript couldn't be read after the window, until a restart.
  const unreadable = new Set<string>();

  /**
   * A finished session is read for 30 seconds, and after that until it's fully counted, so
   * late lines and a large transcript are both taken in (FR-26, BUG-27).
   */
  const stillReading = (key: string, record: FinishedSession, time: number) =>
    !unreadable.has(key) &&
    (time - record.finishedAt < READ_AFTER_FINISH_MS ||
      record.usage?.counting === true);

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
        if (!stillReading(key, record, time)) return false;
        next.add(key);
        return true;
      });
      const finished: FinishedSession[] = [];
      for (const [key, record] of records) {
        if (listed.has(key) || !stillReading(key, record, time)) continue;
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
          // Nothing could be read. Past the window, it isn't tried again until a restart.
          if (time - record.finishedAt >= READ_AFTER_FINISH_MS) {
            unreadable.add(key);
          }
          continue;
        }
        // A listed session is updated from the listing itself, in update().
        if (record === before) {
          records.set(key, { ...record, ...transcriptFields(after) });
        }
      }
    },

    update(current) {
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
          const kept = session.usage ? {} : transcriptFields(previous);
          records.set(key, { ...kept, ...session, finishedAt });
        } else {
          records.delete(key);
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
