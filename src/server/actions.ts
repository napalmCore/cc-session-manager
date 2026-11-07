import type { SessionView } from "../shared/protocol.js";
import { isValidSessionId } from "./transcripts.js";

/** The latest successful listing must be at most this old for a destructive action (C-9). */
export const FRESHNESS_MS = 10_000;
/** Force end is accepted only within this time of a normal close of the same process (NFR-10). */
export const FORCE_END_WINDOW_MS = 2 * 60_000;
/** How long the user's own action suppresses notifications for that session. */
export const OWN_ACTION_MS = 30_000;

export const ACTION_NAMES = [
  "open",
  "resume",
  "stop",
  "delete",
  "end",
  "forceEnd",
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export interface ActionRequest {
  action: ActionName;
  key: string;
}

export type ActionOutcome =
  | "started"
  | "succeeded"
  | "failed"
  | "kept"
  | "not-closed"
  | "refused"
  | "unavailable"
  | "unknown";

export interface CloseRecord {
  pid: number;
  processStartMs: number;
}

export interface ActionResult {
  outcome: ActionOutcome;
  /** In the tool's own words, never raw command output (FR-18). */
  message: string;
  /** Set by End when a normal close was sent, so Force end can follow it. */
  closeRecord?: CloseRecord;
}

export interface ListingState {
  sessions: SessionView[];
  lastSuccessAt: number | null;
  lastPollFailed: boolean;
}

type Executor = (session: SessionView) => Promise<ActionResult>;
export interface ActionExecutors {
  open?: Executor;
  resume?: Executor;
  stop?: Executor;
  delete?: Executor;
  end?: Executor;
  forceEnd?: (
    session: SessionView,
    record: CloseRecord,
  ) => Promise<ActionResult>;
}

export interface ActionTrackerOptions {
  listing: () => ListingState;
  /** A fresh `claude agents` listing, taken just before a destructive action or Resume. */
  freshListing: () => Promise<SessionView[]>;
  executors: ActionExecutors;
  /** True for a session that started or handed over to the tool (FR-22). */
  isProtected: (session: SessionView) => boolean;
  now?: () => number;
}

const SHORT_ID = /^[0-9a-f]{8}$/;
const DESTRUCTIVE = new Set<ActionName>(["stop", "delete", "end", "forceEnd"]);
const NEEDS_FRESH = new Set<ActionName>([
  "stop",
  "delete",
  "end",
  "forceEnd",
  "resume",
]);

const refused = (message: string): ActionResult => ({
  outcome: "refused",
  message,
});

function findSession(
  sessions: SessionView[],
  key: string,
): SessionView | undefined {
  return SHORT_ID.test(key)
    ? sessions.find((session) => session.id === key)
    : sessions.find((session) => session.sessionId === key);
}

/** Whether a session's current kind and state still allow the action. */
function permits(action: ActionName, session: SessionView): boolean {
  switch (action) {
    case "open":
      return session.id !== undefined;
    case "resume":
      return (
        session.kind === "interactive" &&
        session.finished &&
        session.sessionId !== undefined
      );
    case "stop":
    case "delete":
      return session.kind === "background" && session.id !== undefined;
    case "end":
    case "forceEnd":
      return (
        session.kind === "interactive" &&
        session.pid !== undefined &&
        !session.finished
      );
  }
}

/** The same session, process, and kind as when the user asked. Status may have changed. */
function sameSession(original: SessionView, fresh: SessionView): boolean {
  return (
    fresh.kind === original.kind &&
    fresh.sessionId === original.sessionId &&
    fresh.id === original.id &&
    fresh.pid === original.pid
  );
}

export function createActionTracker(options: ActionTrackerOptions) {
  const now = options.now ?? Date.now;
  const locks = new Set<string>();
  const closeRecords = new Map<string, CloseRecord & { at: number }>();
  const ownActions = new Map<string, number>();

  const run = async (request: ActionRequest): Promise<ActionResult> => {
    const { action, key } = request;
    if (!(ACTION_NAMES as readonly string[]).includes(action))
      return refused("Unknown action.");
    if (!SHORT_ID.test(key) && !isValidSessionId(key))
      return refused("Unknown session.");

    const state = options.listing();
    const session = findSession(state.sessions, key);
    if (session === undefined) return refused("That session isn't listed.");
    if (!permits(action, session))
      return refused("That action isn't available for this session.");
    if (DESTRUCTIVE.has(action) && options.isProtected(session)) {
      return refused(
        "This session started the dashboard, so it can't be changed from here.",
      );
    }
    if (
      NEEDS_FRESH.has(action) &&
      (state.lastPollFailed ||
        state.lastSuccessAt === null ||
        now() - state.lastSuccessAt > FRESHNESS_MS)
    ) {
      return refused(
        "The session list is out of date. Try again when it refreshes.",
      );
    }

    // A background row's short id is stable, while its sessionId can appear between polls.
    const lockKey = session.id ?? session.sessionId ?? key;
    if (locks.has(lockKey))
      return refused("Another action on this session is still running.");
    locks.add(lockKey);
    try {
      let current = session;
      if (NEEDS_FRESH.has(action)) {
        let fresh: SessionView[];
        try {
          fresh = await options.freshListing();
        } catch {
          return {
            outcome: "unknown",
            message: "Couldn't check the session's current state.",
          };
        }
        if (action === "resume") {
          if (fresh.some((other) => other.sessionId === session.sessionId)) {
            return refused(
              "That session is running again, so it can't be resumed.",
            );
          }
        } else {
          const match = findSession(fresh, key);
          if (
            match === undefined ||
            !sameSession(session, match) ||
            !permits(action, match)
          ) {
            return refused("The session has changed. Check it and try again.");
          }
          if (options.isProtected(match)) {
            return refused(
              "This session started the dashboard, so it can't be changed from here.",
            );
          }
          current = match;
        }
      }

      const sessionKey = current.sessionId ?? current.id ?? key;
      if (action === "forceEnd") {
        const record = closeRecords.get(sessionKey);
        if (
          record === undefined ||
          now() - record.at > FORCE_END_WINDOW_MS ||
          record.pid !== current.pid
        ) {
          return refused(
            "Force end is only available just after End has tried a normal close.",
          );
        }
        const executor = options.executors.forceEnd;
        if (executor === undefined)
          return { outcome: "unavailable", message: "Not available yet." };
        closeRecords.delete(sessionKey);
        ownActions.set(sessionKey, now());
        return await executor(current, {
          pid: record.pid,
          processStartMs: record.processStartMs,
        });
      }

      const executor = options.executors[action];
      if (executor === undefined)
        return { outcome: "unavailable", message: "Not available yet." };
      if (DESTRUCTIVE.has(action)) ownActions.set(sessionKey, now());
      const result = await executor(current);
      if (action === "end" && result.closeRecord !== undefined) {
        closeRecords.set(sessionKey, { ...result.closeRecord, at: now() });
      }
      return result;
    } finally {
      locks.delete(lockKey);
    }
  };

  return {
    async handle(request: ActionRequest): Promise<ActionResult> {
      try {
        return await run(request);
      } catch {
        return {
          outcome: "unknown",
          message: "Something went wrong, so the result is unknown.",
        };
      }
    },
    /** Sessions acted on from the dashboard recently, so their changes don't notify. */
    ownActionSessions(): string[] {
      const cutoff = now() - OWN_ACTION_MS;
      return [...ownActions.entries()]
        .filter(([, at]) => at >= cutoff)
        .map(([sessionKey]) => sessionKey);
    },
  };
}
