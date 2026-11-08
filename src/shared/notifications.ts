import type { SessionView, Snapshot } from "./protocol.js";
import { groupSessions } from "./session-groups.js";

/** The label used when a session needs the user but doesn't say why. */
export const GENERIC_REASON = "needs input";
/** Failed polls in a row, after a success, before the tool says it can't read sessions. */
export const READ_FAILURES_BEFORE_ALERT = 3;

export type NotifyEvent =
  | { kind: "needs-you"; key: string; folder: string; reason: string }
  | { kind: "finished"; key: string; folder: string }
  | { kind: "failed"; key: string; folder: string }
  | { kind: "read-failure" };

export interface NotifyState {
  /** The last successful snapshot. Events compare against it, across reconnects. */
  baseline: Snapshot | null;
  readFailureNotified: boolean;
}

export const initialNotifyState: NotifyState = {
  baseline: null,
  readFailureNotified: false,
};

const FINISHED = new Set(["done", "stopped"]);

/** How a row and a notification refer to a session. */
export function sessionKey(session: SessionView): string | undefined {
  return session.sessionId ?? session.id;
}

/** The project folder's own name, never the full path. */
export function folderName(cwd: string | undefined): string {
  if (cwd === undefined) return "Unknown project";
  const parts = cwd.split(/[\\/]+/).filter((part) => part !== "");
  return parts.at(-1) ?? "Unknown project";
}

function isOwnAction(session: SessionView, own: Set<string>): boolean {
  return (
    (session.sessionId !== undefined && own.has(session.sessionId)) ||
    (session.id !== undefined && own.has(session.id))
  );
}

/**
 * Compares a new snapshot with the last successful one (FR-12). The first successful snapshot
 * only sets the starting point.
 */
export function nextEvents(
  state: NotifyState,
  snapshot: Snapshot,
  now: number,
): { state: NotifyState; events: NotifyEvent[] } {
  if (snapshot.error !== null) {
    if (
      state.baseline !== null &&
      !state.readFailureNotified &&
      (snapshot.failedPolls ?? 0) >= READ_FAILURES_BEFORE_ALERT
    ) {
      return {
        state: { ...state, readFailureNotified: true },
        events: [{ kind: "read-failure" }],
      };
    }
    return { state, events: [] };
  }

  const next: NotifyState = { baseline: snapshot, readFailureNotified: false };
  const previous = state.baseline;
  if (previous === null) return { state: next, events: [] };

  const own = new Set(snapshot.ownActions ?? []);
  const events: NotifyEvent[] = [];

  // Needs you, using the dashboard's own groups, so Stale sessions don't count.
  const before = new Map<string, string>();
  for (const session of groupSessions(previous.sessions, now).needsYou) {
    const key = sessionKey(session);
    if (key !== undefined) before.set(key, session.attentionReason ?? "");
  }
  for (const session of groupSessions(snapshot.sessions, now).needsYou) {
    const key = sessionKey(session);
    if (key === undefined || isOwnAction(session, own)) continue;
    const reason = session.attentionReason ?? GENERIC_REASON;
    const earlier = before.get(key);
    // A change to a specific reason notifies, but falling back to the generic label doesn't.
    if (
      earlier === undefined ||
      (earlier !== reason && reason !== GENERIC_REASON)
    ) {
      events.push({
        kind: "needs-you",
        key,
        folder: folderName(session.cwd),
        reason,
      });
    }
  }

  // Finished and failed, for sessions that were listed before in another state.
  const states = new Map<string, string | undefined>();
  for (const session of previous.sessions) {
    const key = sessionKey(session);
    if (key !== undefined) states.set(key, session.state);
  }
  for (const session of snapshot.sessions) {
    const key = sessionKey(session);
    if (key === undefined || !states.has(key) || isOwnAction(session, own))
      continue;
    const earlier = states.get(key);
    if (session.state === "failed" && earlier !== "failed") {
      events.push({ kind: "failed", key, folder: folderName(session.cwd) });
    } else if (
      session.kind === "background" &&
      session.state !== undefined &&
      FINISHED.has(session.state) &&
      earlier !== undefined &&
      !FINISHED.has(earlier) &&
      earlier !== "failed"
    ) {
      events.push({ kind: "finished", key, folder: folderName(session.cwd) });
    }
  }

  return { state: next, events };
}

export interface NotificationContent {
  title: string;
  body: string;
  tag: string;
  /** The sessions to highlight when it's clicked. */
  keys: string[];
}

function describe(event: NotifyEvent): string {
  switch (event.kind) {
    case "needs-you":
      return `${event.folder}: ${event.reason}`;
    case "finished":
      return `${event.folder}: finished`;
    case "failed":
      return `${event.folder}: failed`;
    case "read-failure":
      return "The tool can't read sessions.";
  }
}

/** One notification for all the events in a snapshot (FR-13). */
export function notificationContent(
  events: NotifyEvent[],
  seq: number | undefined,
): NotificationContent | null {
  if (events.length === 0) return null;
  const keys = events.flatMap((event) =>
    event.kind === "read-failure" ? [] : [event.key],
  );
  const title =
    events.length === 1
      ? events[0]?.kind === "read-failure"
        ? "Can't read sessions"
        : "Claude Code session"
      : `${String(events.length)} Claude Code session updates`;
  return {
    title,
    body: events.map(describe).join("\n"),
    tag: `cc-session-manager-${String(seq ?? Date.now())}`,
    keys,
  };
}
