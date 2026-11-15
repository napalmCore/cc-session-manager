import type { SessionView } from "./protocol.js";
import { waitingLabel } from "./waiting.js";

function attentionKey(session: SessionView): string {
  // With no ID or name, the folder, kind, and start time tell sessions apart (BUG-14).
  const identity =
    session.sessionId ??
    session.id ??
    session.name ??
    `${session.cwd ?? ""}|${session.kind ?? ""}|${String(session.firstStartedAt ?? session.startedAt ?? "")}`;
  return `${identity}|${session.attentionReason ?? ""}`;
}

export function attentionKeys(sessions: SessionView[]): Set<string> {
  return new Set(sessions.map(attentionKey).sort());
}

/** Text for screen readers about sessions that newly need the user. */
export function newAttentionMessage(
  previous: Set<string>,
  current: SessionView[],
): string {
  const seen = new Set(previous);
  return current
    .filter((session) => {
      const key = attentionKey(session);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(
      (session) =>
        `${session.name ?? "A session"}: ${waitingLabel(session.attentionReason)}.`,
    )
    .join(" ");
}
