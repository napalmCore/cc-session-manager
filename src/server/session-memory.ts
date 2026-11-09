import type { Session, SessionView } from "../shared/protocol.js";

/** How long a new session may go without a status, shown as "Starting" (BUG-18). */
export const STARTING_MS = 10_000;
/** Sessions not listed for this long are forgotten. */
const FORGET_AFTER_MS = 10 * 60 * 1000;

function keyOf(session: Session): string | undefined {
  return session.sessionId ?? session.id;
}

/**
 * A session's process, by process ID and start time, so an ID that appears later doesn't make
 * it look new (BUG-19, BUG-20). Without a process, its session ID stands in.
 */
function identityOf(session: Session): string | undefined {
  if (session.pid !== undefined && session.startedAt !== undefined) {
    return `pid:${String(session.pid)}@${String(session.startedAt)}`;
  }
  const key = keyOf(session);
  return key === undefined ? undefined : `key:${key}`;
}

export interface SessionMemory {
  /** Notes the sessions in a listing, before the rules are applied. */
  observe: (sessions: Session[]) => void;
  /**
   * Whether a session with no status is new enough to excuse: it started within 10 seconds of
   * when the tool first saw it, and that was under 10 seconds ago (BUG-5, BUG-19, BUG-20).
   */
  isStarting: (session: Session) => boolean;
  /** Adds the first start time seen, and the last known activity time where it's gone. */
  recall: (sessions: SessionView[]) => SessionView[];
}

export function createSessionMemory(
  now: () => number = Date.now,
): SessionMemory {
  const firstSeen = new Map<string, number>();
  const firstStart = new Map<string, number>();
  const lastActivity = new Map<string, number>();
  const lastListed = new Map<string, number>();

  const forgetOld = (time: number) => {
    for (const [key, listedAt] of lastListed) {
      if (time - listedAt < FORGET_AFTER_MS) continue;
      lastListed.delete(key);
      firstSeen.delete(key);
      firstStart.delete(key);
      lastActivity.delete(key);
    }
  };

  return {
    observe(sessions) {
      const time = now();
      for (const session of sessions) {
        const identity = identityOf(session);
        if (identity !== undefined) {
          if (!firstSeen.has(identity)) firstSeen.set(identity, time);
          lastListed.set(identity, time);
        }
        const key = keyOf(session);
        if (key !== undefined) {
          lastListed.set(`key:${key}`, time);
          if (
            session.startedAt !== undefined &&
            !firstStart.has(`key:${key}`)
          ) {
            firstStart.set(`key:${key}`, session.startedAt);
          }
        }
      }
      forgetOld(time);
    },

    isStarting(session) {
      const identity = identityOf(session);
      if (identity === undefined || session.startedAt === undefined) {
        return false;
      }
      // Not seen before means first seen now, as when parsing the listing that shows it.
      const time = now();
      const seenAt = firstSeen.get(identity) ?? time;
      return (
        seenAt - session.startedAt <= STARTING_MS && time - seenAt < STARTING_MS
      );
    },

    recall(sessions) {
      return sessions.map((session) => {
        const key = keyOf(session);
        if (key === undefined) return session;
        const recalled = { ...session };
        const started = firstStart.get(`key:${key}`);
        // Claude Code moves a background session's start time once it has a process (BUG-23).
        // The first one is shown and sorted on; startedAt stays as listed for the ownership check.
        if (started !== undefined) recalled.firstStartedAt = started;
        // A transcript that can no longer be read keeps the last time it showed (BUG-13).
        if (session.lastActivityAt !== undefined) {
          lastActivity.set(`key:${key}`, session.lastActivityAt);
        } else {
          const known = lastActivity.get(`key:${key}`);
          if (known !== undefined) recalled.lastActivityAt = known;
        }
        return recalled;
      });
    },
  };
}
