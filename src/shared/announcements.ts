import type { SessionView } from "./protocol.js";

function attentionKey(session: SessionView): string {
  const identity = session.sessionId ?? session.id ?? session.name ?? "";
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
        `${session.name ?? "A session"} needs you: ${session.attentionReason ?? "needs input"}.`,
    )
    .join(" ");
}
