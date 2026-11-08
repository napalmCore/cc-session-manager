import { folderName, sessionKeys } from "./notifications.js";
import type { SessionView, Snapshot } from "./protocol.js";

export type SessionAction =
  "open" | "resume" | "stop" | "delete" | "end" | "forceEnd";
export type RiskyAction = "stop" | "delete" | "end" | "forceEnd";

/** The outcomes the server's action route returns. */
export type ActionOutcome =
  | "started"
  | "succeeded"
  | "failed"
  | "kept"
  | "not-closed"
  | "refused"
  | "unavailable"
  | "unknown";

export interface ActionReply {
  outcome: ActionOutcome;
  message: string;
}

/** Force end is offered for this long after End couldn't close a session, as the server allows. */
export const FORCE_END_OFFER_MS = 2 * 60_000;

const SHORT_ID = /^[0-9a-f]{8}$/;

/** The key the server finds the session by: its short id, or else its session ID. */
export function actionKey(session: SessionView): string | undefined {
  if (session.id !== undefined && SHORT_ID.test(session.id)) return session.id;
  return session.sessionId;
}

const isLiveInteractive = (session: SessionView) =>
  session.kind === "interactive" && !session.finished;

export interface ActionContext {
  /** Why Stop, Delete, and End are off for every session, if they are (FR-22). */
  blocked: string | null;
  protectedKeys: ReadonlySet<string>;
}

export function actionContext(snapshot: Snapshot | null): ActionContext {
  return {
    blocked: snapshot?.actionsBlocked ?? null,
    protectedKeys: new Set(snapshot?.protectedSessions ?? []),
  };
}

export function isProtectedSession(
  session: SessionView,
  context: ActionContext,
): boolean {
  return sessionKeys(session).some((key) => context.protectedKeys.has(key));
}

/**
 * The actions a row offers, matching what the server allows. Force end isn't listed, because
 * it's only offered after End couldn't close the session. A live interactive session has no
 * Open (FR-20).
 */
export function availableActions(
  session: SessionView,
  context: ActionContext,
): SessionAction[] {
  if (actionKey(session) === undefined) return [];
  const actions: SessionAction[] = [];
  if (session.id !== undefined && !isLiveInteractive(session)) {
    actions.push("open");
  }
  if (
    session.kind === "interactive" &&
    session.finished &&
    session.sessionId !== undefined
  ) {
    actions.push("resume");
  }
  const risky =
    context.blocked === null && !isProtectedSession(session, context);
  if (risky && session.kind === "background" && session.id !== undefined) {
    actions.push("stop", "delete");
  }
  if (risky && isLiveInteractive(session) && session.pid !== undefined) {
    actions.push("end");
  }
  return actions;
}

/** Names the session in a dialog: by name, or by folder, kind, and start time (FR-19). */
export function sessionLabel(
  session: SessionView,
  formatTime: (time: number) => string,
): string {
  const folder = folderName(session.cwd);
  if (session.name !== undefined && session.name !== "") {
    return `"${session.name}" in ${folder}`;
  }
  const kind =
    session.kind === "background" || session.kind === "interactive"
      ? `${session.kind} session`
      : "session";
  const started =
    session.startedAt === undefined
      ? "start time unknown"
      : `started ${formatTime(session.startedAt)}`;
  return `Unnamed ${kind} in ${folder}, ${started}`;
}

export const ACTION_LABELS: Record<SessionAction, string> = {
  open: "Open",
  resume: "Resume",
  stop: "Stop",
  delete: "Delete",
  end: "End",
  forceEnd: "Force end",
};

/** What a button says while its action runs. */
export const PENDING_LABELS: Record<SessionAction, string> = {
  open: "Opening…",
  resume: "Resuming…",
  stop: "Stopping…",
  delete: "Deleting…",
  end: "Ending…",
  forceEnd: "Force ending…",
};

export interface DialogText {
  title: string;
  body: string[];
  confirm: string;
}

export const DIALOGS: Record<RiskyAction, DialogText> = {
  stop: {
    title: "Stop this session?",
    body: [
      "Work in progress is interrupted. The conversation is kept, so you can open it again.",
    ],
    confirm: "Stop session",
  },
  delete: {
    title: "Delete this session?",
    body: [
      "The session is removed and any work it's doing stops.",
      "A worktree Claude created for it is removed when that's safe. If removing it could lose work, Claude Code keeps the session and the page says so.",
    ],
    confirm: "Delete session",
  },
  end: {
    title: "End this session?",
    body: [
      "Claude Code is asked to close normally. Work in progress can be lost. The conversation is kept.",
      'If the session was started with npm\'s claude.cmd, its terminal then asks "Terminate batch job (Y/N)?". Answer it there, or close that terminal.',
      "A session started from Git Bash can't be closed normally from here. You'll be offered Force end instead.",
    ],
    confirm: "End session",
  },
  forceEnd: {
    title: "Force end this session?",
    body: [
      "The session is ended at once, with no chance to finish or save. Work in progress can be lost.",
      "Programs the session started, such as dev servers, are also ended. Its terminal stays open.",
    ],
    confirm: "Force end session",
  },
};

export function isRisky(action: SessionAction): action is RiskyAction {
  return action in DIALOGS;
}

const OUTCOMES = new Set<string>([
  "started",
  "succeeded",
  "failed",
  "kept",
  "not-closed",
  "refused",
  "unavailable",
  "unknown",
]);

/** Reads the route's answer, treating anything unexpected as an unknown result (FR-18). */
export function readReply(body: unknown): ActionReply {
  if (
    typeof body === "object" &&
    body !== null &&
    "outcome" in body &&
    "message" in body &&
    typeof body.outcome === "string" &&
    OUTCOMES.has(body.outcome) &&
    typeof body.message === "string" &&
    body.message !== ""
  ) {
    return { outcome: body.outcome as ActionOutcome, message: body.message };
  }
  return {
    outcome: "unknown",
    message: "The tool's answer couldn't be read, so the result is unknown.",
  };
}

export const UNREACHABLE: ActionReply = {
  outcome: "unknown",
  message: "Couldn't reach the local server, so the result is unknown.",
};
