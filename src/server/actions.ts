import type { SessionView } from "../shared/protocol.js";
import type { LeftoverRecord } from "./leftovers-helper.js";
import type { FolderListing } from "./folder-picker.js";
import type { HistoryPage } from "./history.js";
import type { ForkRequest, ForkTarget, StartRequest } from "./start.js";
import { PROTECTED_MESSAGE as PROTECTED } from "./protect.js";
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
  "endLeftovers",
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

/** An action on a session the tool already knows. */
export interface SessionActionRequest {
  action: ActionName;
  key: string;
}

/** Lists a local folder's subfolders for the New session form (FR-32). */
export interface ListFoldersRequest {
  action: "listFolders";
  folder?: string | undefined;
}

/** One page of History (FR-35). */
export interface HistoryRequest {
  action: "history";
  page?: number | undefined;
}

/** Every request the action route takes, one shape per action (NFR-14). */
export type ActionRequest =
  | SessionActionRequest
  | StartRequest
  | ForkRequest
  | ListFoldersRequest
  | HistoryRequest;

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
  /**
   * The session's programs, recorded by End or Force end before the signal: null when
   * recording was tried and failed, absent when it wasn't tried. Never sent to the page.
   */
  leftovers?: LeftoverRecord | null;
  /** A folder listing, for listFolders only. */
  folder?: string;
  folders?: string[];
  truncated?: boolean;
  drives?: string[];
  /** A page of History, for history only. */
  history?: HistoryPage;
}

/** Recording and ending the programs a session leaves running (FR-27). */
export interface LeftoverHooks {
  /**
   * Records a session's programs before Stop or Delete: null when it failed, undefined when the
   * session has no process to record.
   */
  record: (session: SessionView) => Promise<LeftoverRecord | null | undefined>;
  hold: (
    session: SessionView,
    action: "stop" | "delete" | "end" | "forceEnd",
    record: LeftoverRecord | null | undefined,
    result: ActionResult,
  ) => void;
  find: (
    key: string,
  ) => { view: SessionView; sessionGone: boolean } | undefined;
  end: (key: string) => Promise<ActionResult>;
}

export interface ListingState {
  sessions: SessionView[];
  /** When the latest successful poll started, so its listing is at least this recent. */
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
  /**
   * True, or a refusal message, for a session that started or handed over to the tool (FR-22).
   */
  isProtected: (session: SessionView) => boolean | string;
  leftovers?: LeftoverHooks;
  /** Starts a new session (FR-32). */
  start?: (request: StartRequest) => Promise<ActionResult>;
  /** Lists a folder for Browse (FR-32). */
  listFolders?: (folder: string | undefined) => Promise<FolderListing>;
  /** Reads a page of History (FR-35). */
  history?: (page: number, listing: SessionView[]) => Promise<HistoryPage>;
  /** Forks a session into a new one (FR-33). */
  fork?: (request: ForkRequest, target: ForkTarget) => Promise<ActionResult>;
  /**
   * A past session's folder from History, for Fork and Resume of a session Claude Code no longer
   * lists. Null if it's not on disk or its folder can't be used.
   */
  historyFolder?: (sessionId: string) => Promise<string | null>;
  /** Whether a session's saved conversation is on disk, checked before a fork (FR-33). */
  transcriptExists?: (sessionId: string) => Promise<boolean>;
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

/** Added to an action's result when its programs couldn't be recorded (0020). */
export const NOT_RECORDED =
  "Leftover programs can't be checked for this session.";

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
    case "endLeftovers":
      // Checked against the leftover record instead, since the session may not be listed.
      return false;
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

function protectedMessage(value: boolean | string): string | null {
  if (typeof value === "string") return value === "" ? PROTECTED : value;
  return value ? PROTECTED : null;
}

export function createActionTracker(options: ActionTrackerOptions) {
  const now = options.now ?? Date.now;
  const locks = new Set<string>();
  const closeRecords = new Map<string, CloseRecord & { at: number }>();
  const ownActions = new Map<string, number>();

  const isStale = (state: ListingState) =>
    state.lastPollFailed ||
    state.lastSuccessAt === null ||
    now() - state.lastSuccessAt > FRESHNESS_MS;
  const STALE = "The session list is out of date. Try again when it refreshes.";
  const STILL_RUNNING =
    "The session is still running, so its programs aren't leftovers yet.";

  /**
   * Ends the programs the server recorded for a session. The page names only the session, and
   * the program list comes from the server's own record (NFR-13).
   */
  const endLeftovers = async (key: string): Promise<ActionResult> => {
    const hooks = options.leftovers;
    if (hooks === undefined)
      return { outcome: "unavailable", message: "Not available yet." };
    const held = hooks.find(key);
    if (held === undefined)
      return refused("No leftover programs are recorded for this session.");
    const state = options.listing();
    const listed = findSession(state.sessions, key);
    const protection = protectedMessage(
      options.isProtected(listed ?? held.view),
    );
    if (protection !== null) return refused(protection);
    if (isStale(state)) return refused(STALE);
    if (!held.sessionGone || listed?.pid !== undefined) {
      return refused(STILL_RUNNING);
    }

    const lockKey = held.view.id ?? held.view.sessionId ?? key;
    if (locks.has(lockKey))
      return refused("Another action on this session is still running.");
    locks.add(lockKey);
    try {
      let fresh: SessionView[];
      try {
        fresh = await options.freshListing();
      } catch {
        return {
          outcome: "unknown",
          message: "Couldn't check the session's current state.",
        };
      }
      // A session still listed must be the same one, with no process (C-9).
      const match = findSession(fresh, key);
      if (match !== undefined) {
        if (match.pid !== undefined) return refused(STILL_RUNNING);
        if (
          held.view.sessionId !== undefined &&
          match.sessionId !== held.view.sessionId
        ) {
          return refused("The session has changed. Check it and try again.");
        }
        const again = protectedMessage(options.isProtected(match));
        if (again !== null) return refused(again);
      }
      return await hooks.end(key);
    } finally {
      locks.delete(lockKey);
    }
  };

  /** Only one Start runs at a time, through its 10-second watch (NFR-14). */
  const START_LOCK = "start";
  const startSession = async (request: StartRequest): Promise<ActionResult> => {
    if (options.start === undefined) {
      return { outcome: "unavailable", message: "Not available yet." };
    }
    if (locks.has(START_LOCK)) {
      return refused("Another session is still starting. Wait for its result.");
    }
    locks.add(START_LOCK);
    try {
      return await options.start(request);
    } finally {
      locks.delete(START_LOCK);
    }
  };

  /**
   * Forks a session (FR-33). The page names only the session; its ID and folder come from the
   * listing or History. One Fork runs per session at a time, locked on its session ID.
   */
  const forkSession = async (request: ForkRequest): Promise<ActionResult> => {
    const { fork } = options;
    if (fork === undefined) {
      return { outcome: "unavailable", message: "Not available yet." };
    }
    const { key } = request;
    if (!SHORT_ID.test(key) && !isValidSessionId(key)) {
      return refused("Unknown session.");
    }
    const listed = findSession(options.listing().sessions, key);
    let target: ForkTarget | null = null;
    if (listed !== undefined) {
      if (listed.sessionId !== undefined && listed.cwd !== undefined) {
        target = { sessionId: listed.sessionId, folder: listed.cwd };
      }
    } else if (isValidSessionId(key) && options.historyFolder !== undefined) {
      const folder = await options.historyFolder(key);
      if (folder !== null) target = { sessionId: key, folder };
    }
    if (target === null) {
      return refused("That session can't be forked from here.");
    }
    if (
      options.transcriptExists !== undefined &&
      !(await options.transcriptExists(target.sessionId))
    ) {
      return refused("That session has no saved conversation to fork.");
    }
    const lockKey = `fork:${target.sessionId}`;
    if (locks.has(lockKey)) {
      return refused("This session is already being forked.");
    }
    locks.add(lockKey);
    try {
      return await fork(request, target);
    } finally {
      locks.delete(lockKey);
    }
  };

  /**
   * Resume of a session Claude Code no longer lists, found in History (FR-35, FR-14). A fresh
   * listing comes first (C-9): a session listed again isn't resumed from here.
   */
  const resumeFromHistory = async (key: string): Promise<ActionResult> => {
    const executor = options.executors.resume;
    if (executor === undefined || options.historyFolder === undefined) {
      return refused("That session isn't listed.");
    }
    if (isStale(options.listing())) return refused(STALE);
    const folder = await options.historyFolder(key);
    if (folder === null) return refused("That session isn't listed.");
    if (locks.has(key)) {
      return refused("Another action on this session is still running.");
    }
    locks.add(key);
    try {
      let fresh: SessionView[];
      try {
        fresh = await options.freshListing();
      } catch {
        return {
          outcome: "unknown",
          message: "Couldn't check the session's current state.",
        };
      }
      if (fresh.some((other) => other.sessionId === key)) {
        return refused(
          "That session is listed again. Use it from the session list.",
        );
      }
      return await executor({
        sessionId: key,
        cwd: folder,
        kind: "interactive",
        finished: true,
        needsAttention: false,
        attentionReason: null,
        statusLabel: "finished",
      });
    } finally {
      locks.delete(key);
    }
  };

  const run = async (request: ActionRequest): Promise<ActionResult> => {
    if (request.action === "start") return startSession(request);
    if (request.action === "fork") return forkSession(request);
    if (request.action === "history") {
      if (options.history === undefined) {
        return { outcome: "unavailable", message: "Not available yet." };
      }
      try {
        const page = await options.history(
          request.page ?? 0,
          options.listing().sessions,
        );
        return {
          outcome: "succeeded",
          message: "History read.",
          history: page,
        };
      } catch {
        return { outcome: "failed", message: "History couldn't be read." };
      }
    }
    if (request.action === "listFolders") {
      if (options.listFolders === undefined) {
        return { outcome: "unavailable", message: "Not available yet." };
      }
      return options.listFolders(request.folder);
    }
    const { action, key } = request;
    if (!(ACTION_NAMES as readonly string[]).includes(action))
      return refused("Unknown action.");
    if (!SHORT_ID.test(key) && !isValidSessionId(key))
      return refused("Unknown session.");
    if (action === "endLeftovers") return endLeftovers(key);

    const state = options.listing();
    const session = findSession(state.sessions, key);
    if (session === undefined) {
      if (action === "resume" && isValidSessionId(key)) {
        return resumeFromHistory(key);
      }
      return refused("That session isn't listed.");
    }
    if (!permits(action, session))
      return refused("That action isn't available for this session.");
    if (DESTRUCTIVE.has(action)) {
      const protection = protectedMessage(options.isProtected(session));
      if (protection !== null) return refused(protection);
    }
    if (NEEDS_FRESH.has(action) && isStale(state)) return refused(STALE);

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
          const protection = protectedMessage(options.isProtected(match));
          if (protection !== null) return refused(protection);
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
        let forced: ActionResult;
        try {
          forced = await executor(current, {
            pid: record.pid,
            processStartMs: record.processStartMs,
          });
        } finally {
          ownActions.set(sessionKey, now());
        }
        return keepLeftovers(current, action, forced.leftovers, forced);
      }

      const executor = options.executors[action];
      if (executor === undefined)
        return { outcome: "unavailable", message: "Not available yet." };
      if (DESTRUCTIVE.has(action)) ownActions.set(sessionKey, now());
      // Stop and Delete record the session's programs here, after the checks above and before
      // the command. End records them in its own helper run, before the signal (FR-27).
      let recorded: LeftoverRecord | null | undefined;
      if (
        (action === "stop" || action === "delete") &&
        options.leftovers !== undefined
      ) {
        try {
          recorded = await options.leftovers.record(current);
        } catch {
          recorded = null;
        }
      }
      let result: ActionResult;
      try {
        result = await executor(current);
      } finally {
        if (DESTRUCTIVE.has(action)) ownActions.set(sessionKey, now());
      }
      if (action === "end" && result.closeRecord !== undefined) {
        closeRecords.set(sessionKey, { ...result.closeRecord, at: now() });
      }
      if (action === "stop" || action === "delete") {
        return keepLeftovers(current, action, recorded, result);
      }
      if (action === "end") {
        return keepLeftovers(current, action, result.leftovers, result);
      }
      return result;
    } finally {
      locks.delete(lockKey);
    }
  };

  /** Hands the record to the leftover tracker, and says so when it couldn't be taken. */
  function keepLeftovers(
    session: SessionView,
    action: "stop" | "delete" | "end" | "forceEnd",
    record: LeftoverRecord | null | undefined,
    result: ActionResult,
  ): ActionResult {
    const hooks = options.leftovers;
    if (hooks === undefined) return result;
    // An earlier record of the same session, such as End's before Force end, still covers it.
    const covered =
      record === null &&
      [session.sessionId, session.id].some(
        (key) => key !== undefined && hooks.find(key) !== undefined,
      );
    try {
      hooks.hold(session, action, record, result);
    } catch {
      // Tracking leftovers never changes the action's own result.
    }
    const actedOn =
      result.outcome !== "refused" && result.outcome !== "unavailable";
    return record === null && actedOn && !covered
      ? { ...result, message: `${result.message} ${NOT_RECORDED}` }
      : result;
  }

  return {
    async handle(request: ActionRequest): Promise<ActionResult> {
      try {
        // The record stays on the server (NFR-13).
        const result = await run(request);
        delete result.leftovers;
        return result;
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
