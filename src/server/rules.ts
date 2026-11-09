import type { Session, SessionView } from "../shared/protocol.js";

const GENERIC_REASON = "needs input";
const FINISHED_STATES = new Set(["done", "failed", "stopped"]);

/** Applies the session rules in docs/design.md. */
export function toSessionView(session: Session): SessionView {
  return toSessionViewAt(session, false);
}

/** As toSessionView, for a session the tool saw start moments ago (BUG-18). */
export function toSessionViewAt(
  session: Session,
  starting: boolean,
): SessionView {
  const needsAttention =
    session.status === "waiting" || session.state === "blocked";

  return {
    ...session,
    needsAttention,
    attentionReason: needsAttention
      ? (session.waitingFor ?? GENERIC_REASON)
      : null,
    finished:
      !needsAttention &&
      session.state !== undefined &&
      FINISHED_STATES.has(session.state),
    // A new interactive session's first listings can lack a status (BUG-18).
    statusLabel:
      session.state ??
      session.status ??
      (starting && session.kind === "interactive" ? "starting" : "unknown"),
  };
}
