import type { SessionView } from "./protocol.js";

/** The states a background session can take a message in, when it has no process (0029). */
const SENDABLE_STATES = new Set(["stopped", "done", "failed"]);

/**
 * Whether a listed session can take a message (FR-37): a background session with a short ID
 * and a session ID, in a state that takes one, with no process, and not waiting on anything.
 * A session with a process would get a copy instead, so it keeps Open. Protection and the
 * folder are checked separately.
 */
export function canSendTo(session: SessionView): boolean {
  return (
    session.kind === "background" &&
    session.id !== undefined &&
    session.sessionId !== undefined &&
    session.pid === undefined &&
    session.cwd !== undefined &&
    !session.needsAttention &&
    session.state !== undefined &&
    SENDABLE_STATES.has(session.state)
  );
}
