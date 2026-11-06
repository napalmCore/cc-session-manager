import type { Session, SessionView } from "../shared/protocol.js";

const GENERIC_REASON = "needs input";
const FINISHED_STATES = new Set(["done", "failed", "stopped"]);

/** Applies the session rules in docs/design.md. */
export function toSessionView(session: Session): SessionView {
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
    statusLabel: session.state ?? session.status ?? "unknown",
  };
}
