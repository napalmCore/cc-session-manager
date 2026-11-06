import type { FinishedSession, SessionView } from "../shared/protocol.js";
import type { SessionStore } from "./store.js";

export const RETENTION_MS = 24 * 60 * 60 * 1000;

export interface TrackedSessions {
  sessions: SessionView[];
  warnings: string[];
}

export interface SessionTracker {
  update: (current: SessionView[]) => TrackedSessions;
}

export interface TrackerOptions {
  store: SessionStore;
  now?: () => number;
}

function keyOf(session: SessionView): string | null {
  return session.sessionId ?? session.id ?? null;
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

  return {
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
          const finishedAt = records.get(key)?.finishedAt ?? time;
          records.set(key, { ...session, finishedAt });
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
      return { sessions: [...live, ...visible], warnings };
    },
  };
}
