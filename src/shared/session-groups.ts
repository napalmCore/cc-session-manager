import type { SessionView } from "./protocol.js";

export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionGroups {
  needsYou: SessionView[];
  stale: SessionView[];
  active: SessionView[];
  finished: SessionView[];
}

/**
 * A live open prompt is never stale, however old, and neither is a session whose
 * activity is unknown, because hiding a real request is the worse mistake.
 */
function isStale(session: SessionView, now: number): boolean {
  return (
    session.state === "blocked" &&
    session.status !== "waiting" &&
    session.lastActivityAt !== undefined &&
    now - session.lastActivityAt > STALE_AFTER_MS
  );
}

const oldestFirst = (time: (session: SessionView) => number | undefined) => {
  return (a: SessionView, b: SessionView) =>
    (time(a) ?? Infinity) - (time(b) ?? Infinity);
};

const newestFirst = (time: (session: SessionView) => number | undefined) => {
  return (a: SessionView, b: SessionView) =>
    (time(b) ?? -Infinity) - (time(a) ?? -Infinity);
};

const lastActivity = (session: SessionView) => session.lastActivityAt;

/** Newest start first, then by ID, so activity never reorders Active (BUG-6). */
function byStart(a: SessionView, b: SessionView): number {
  const started = (session: SessionView) =>
    session.firstStartedAt ?? session.startedAt ?? -Infinity;
  const difference = started(b) - started(a);
  if (difference !== 0 && !Number.isNaN(difference)) return difference;
  const id = (session: SessionView) => session.sessionId ?? session.id ?? "";
  return id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0;
}
const finishedAt = (session: SessionView) => session.finishedAt;

export function groupSessions(
  sessions: SessionView[],
  now: number,
): SessionGroups {
  const groups: SessionGroups = {
    needsYou: [],
    stale: [],
    active: [],
    finished: [],
  };

  for (const session of sessions) {
    if (session.finished) groups.finished.push(session);
    else if (isStale(session, now)) groups.stale.push(session);
    else if (session.needsAttention) groups.needsYou.push(session);
    else groups.active.push(session);
  }

  groups.needsYou.sort(oldestFirst(lastActivity));
  groups.stale.sort(newestFirst(lastActivity));
  groups.active.sort(byStart);
  groups.finished.sort(newestFirst(finishedAt));
  return groups;
}

export function pageTitle(attentionCount: number): string {
  const title = "Claude Code sessions";
  return attentionCount > 0 ? `(${String(attentionCount)}) ${title}` : title;
}
