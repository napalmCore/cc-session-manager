import type { SessionView, Snapshot } from "./protocol.js";
import { groupSessions } from "./session-groups.js";

/** The label used when a session needs the user but doesn't say why. */
export const GENERIC_REASON = "needs input";
/** Failed polls in a row, after a success, before the tool says it can't read sessions. */
export const READ_FAILURES_BEFORE_ALERT = 3;

export type NotifyEvent =
  | { kind: "needs-you"; keys: string[]; folder: string; reason: string }
  | { kind: "finished"; keys: string[]; folder: string }
  | { kind: "failed"; keys: string[]; folder: string }
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

/**
 * Every name a session goes by. A background row's short id comes first, because it's stable,
 * while its sessionId can appear between polls.
 */
export function sessionKeys(session: SessionView): string[] {
  const keys: string[] = [];
  if (session.id !== undefined) keys.push(session.id);
  if (session.sessionId !== undefined) keys.push(session.sessionId);
  return keys;
}

function lookup<T>(map: Map<string, T>, keys: string[]): T | undefined {
  for (const key of keys) {
    const value = map.get(key);
    if (value !== undefined) return value;
  }
  return undefined;
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
    for (const key of sessionKeys(session)) {
      before.set(key, session.attentionReason ?? "");
    }
  }
  for (const session of groupSessions(snapshot.sessions, now).needsYou) {
    const keys = sessionKeys(session);
    if (keys.length === 0 || isOwnAction(session, own)) continue;
    const reason = session.attentionReason ?? GENERIC_REASON;
    const earlier = lookup(before, keys);
    // A change to a specific reason notifies, but falling back to the generic label doesn't.
    if (
      earlier === undefined ||
      (earlier !== reason && reason !== GENERIC_REASON)
    ) {
      events.push({
        kind: "needs-you",
        keys,
        folder: folderName(session.cwd),
        reason,
      });
    }
  }

  // Finished and failed, for sessions that were listed before in another state.
  const states = new Map<string, string>();
  for (const session of previous.sessions) {
    for (const key of sessionKeys(session)) {
      states.set(key, session.state ?? "");
    }
  }
  for (const session of snapshot.sessions) {
    const keys = sessionKeys(session);
    const earlier = lookup(states, keys);
    if (earlier === undefined || isOwnAction(session, own)) continue;
    if (session.state === "failed" && earlier !== "failed") {
      events.push({ kind: "failed", keys, folder: folderName(session.cwd) });
    } else if (
      session.kind === "background" &&
      session.state !== undefined &&
      FINISHED.has(session.state) &&
      earlier !== "" &&
      !FINISHED.has(earlier) &&
      earlier !== "failed"
    ) {
      events.push({ kind: "finished", keys, folder: folderName(session.cwd) });
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
  runId = "",
): NotificationContent | null {
  if (events.length === 0) return null;
  const keys = events.flatMap((event) =>
    event.kind === "read-failure" ? [] : event.keys,
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
    // The run's id keeps a restarted server's numbers from replacing older notifications quietly.
    tag: `cc-session-manager-${runId === "" ? "" : `${runId}-`}${String(seq ?? Date.now())}`,
    keys,
  };
}

/**
 * How long a tab that isn't showing notifications keeps one, in case the tab that shows them
 * has just closed and this one takes over (BUG-32).
 */
export const PENDING_NOTIFY_MS = 10_000;

export interface PendingNotification {
  content: NotificationContent;
  at: number;
}

/**
 * Adds a notification a tab didn't show, and drops ones too old to show, keeping the newest
 * few. The tag is the same in every tab, so showing one the closed tab already showed only
 * replaces it.
 */
export function keepPending(
  pending: readonly PendingNotification[],
  content: NotificationContent | null,
  now: number,
): PendingNotification[] {
  const kept = pending.filter((item) => now - item.at <= PENDING_NOTIFY_MS);
  if (content !== null) kept.push({ content, at: now });
  return kept.slice(-5);
}

/** The kept notifications still recent enough to show once this tab takes over. */
export function pendingToShow(
  pending: readonly PendingNotification[],
  now: number,
): NotificationContent[] {
  return pending
    .filter((item) => now - item.at <= PENDING_NOTIFY_MS)
    .map((item) => item.content);
}
