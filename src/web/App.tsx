import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Disclosure,
  DisclosurePanel,
  Heading,
} from "react-aria-components";
import { attentionKeys, newAttentionMessage } from "../shared/announcements.js";
import { formatDuration } from "../shared/format.js";
import { sessionKey } from "../shared/notifications.js";
import type { SessionView } from "../shared/protocol.js";
import { groupSessions, pageTitle } from "../shared/session-groups.js";
import cssClasses from "./App.module.css";
import { type NotifyPermission, useNotifications } from "./useNotifications.js";
import { useSnapshot } from "./useSnapshot.js";

const CLOCK_MS = 30_000;
const ANNOUNCE_DELAY_MS = 100;
const HIGHLIGHT_MS = 15_000;
const styles = cssClasses as Record<
  | "banner"
  | "bannerTitle"
  | "details"
  | "disclosureButton"
  | "flagged"
  | "group"
  | "groupTitle"
  | "highlighted"
  | "notifyButton"
  | "notifyStatus"
  | "toolbar"
  | "list"
  | "marker"
  | "name"
  | "page"
  | "row"
  | "status"
  | "summary"
  | "title"
  | "visuallyHidden"
  | "warnings",
  string
>;

function formatTime(time: number): string {
  return new Date(time).toLocaleString();
}

function details(session: SessionView, now: number): string[] {
  const items = [
    session.cwd ?? "Project unknown",
    session.kind ?? "Kind unknown",
    session.gitBranch ?? "Branch unavailable",
    session.model ?? "Model unavailable",
    session.startedAt === undefined
      ? "Start time unknown"
      : `Started ${formatTime(session.startedAt)}`,
  ];

  if (session.startedAt !== undefined) {
    if (session.finishedAt !== undefined) {
      const ran = session.finishedAt - session.startedAt;
      items.push(`Ran for ${formatDuration(ran)}`);
    } else if (!session.finished) {
      items.push(`Running for ${formatDuration(now - session.startedAt)}`);
    }
  }

  items.push(
    session.lastActivityAt === undefined
      ? "Last activity unavailable"
      : `Last active ${formatDuration(now - session.lastActivityAt)} ago`,
  );
  return items;
}

function statusText(session: SessionView): string {
  if (session.attentionReason) return session.attentionReason;
  if (session.finished) {
    return session.finishedAt === undefined
      ? "Finished"
      : `Ended about ${formatTime(session.finishedAt)}`;
  }
  return session.statusLabel;
}

function rowClass(flagged: boolean, highlighted: boolean): string {
  return [
    styles.row,
    flagged ? styles.flagged : "",
    highlighted ? styles.highlighted : "",
  ]
    .filter((name) => name !== "")
    .join(" ");
}

function SessionList({
  sessions,
  now,
  flagged = false,
  highlighted,
}: {
  sessions: SessionView[];
  now: number;
  flagged?: boolean;
  highlighted: Set<string>;
}) {
  return (
    <ul className={styles.list}>
      {sessions.map((session, index) => {
        const key = sessionKey(session);
        const isHighlighted = key !== undefined && highlighted.has(key);
        return (
          <li
            key={key ?? index}
            className={rowClass(flagged, isHighlighted)}
            data-highlighted={isHighlighted ? "true" : undefined}
          >
            <div className={styles.summary}>
              <span className={styles.name}>
                {flagged && (
                  <span className={styles.marker} aria-hidden="true">
                    !{" "}
                  </span>
                )}
                {session.name ?? "Unnamed session"}
              </span>
              <span className={styles.status}>{statusText(session)}</span>
            </div>
            <ul className={styles.details}>
              {details(session, now).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

function Group({
  title,
  sessions,
  now,
  flagged = false,
  highlighted,
}: {
  title: string;
  sessions: SessionView[];
  now: number;
  flagged?: boolean;
  highlighted: Set<string>;
}) {
  if (sessions.length === 0) return null;
  const id = `group-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <section aria-labelledby={id} className={styles.group}>
      <h2 id={id} className={styles.groupTitle}>
        {title} ({sessions.length})
      </h2>
      <SessionList
        sessions={sessions}
        now={now}
        flagged={flagged}
        highlighted={highlighted}
      />
    </section>
  );
}

function StaleGroup({
  sessions,
  now,
  highlighted,
}: {
  sessions: SessionView[];
  now: number;
  highlighted: Set<string>;
}) {
  if (sessions.length === 0) return null;
  return (
    <Disclosure className={styles.group}>
      <Heading level={2} className={styles.groupTitle}>
        <Button slot="trigger" className={styles.disclosureButton}>
          Stale ({sessions.length}): blocked, inactive for over 7 days
        </Button>
      </Heading>
      <DisclosurePanel>
        <SessionList sessions={sessions} now={now} highlighted={highlighted} />
      </DisclosurePanel>
    </Disclosure>
  );
}

const PERMISSION_TEXT: Record<Exclude<NotifyPermission, "default">, string> = {
  granted: "Desktop notifications are on.",
  denied:
    "Desktop notifications are blocked. You can allow them in the browser's settings for this site.",
  unavailable: "This browser can't show desktop notifications.",
};

function NotificationControl({
  permission,
  onTurnOn,
}: {
  permission: NotifyPermission;
  onTurnOn: () => void;
}) {
  return (
    <div className={styles.toolbar}>
      {permission === "default" ? (
        <Button className={styles.notifyButton} onPress={onTurnOn}>
          Turn on desktop notifications
        </Button>
      ) : (
        <p className={styles.notifyStatus}>{PERMISSION_TEXT[permission]}</p>
      )}
    </div>
  );
}

function Banners({
  connected,
  error,
  warnings,
}: {
  connected: boolean;
  error: string | null;
  warnings: string[];
}) {
  return (
    <>
      {!connected && (
        <p role="alert" className={styles.banner}>
          Not connected to the local server. Trying to reconnect.
        </p>
      )}
      {error && (
        <p role="alert" className={styles.banner}>
          {error}
        </p>
      )}
      <div role="status">
        {warnings.length > 0 && (
          <Disclosure className={styles.banner}>
            <Heading level={2} className={styles.bannerTitle}>
              <Button slot="trigger" className={styles.disclosureButton}>
                Some details may be missing or inaccurate ({warnings.length})
              </Button>
            </Heading>
            <DisclosurePanel>
              <ul className={styles.warnings}>
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </DisclosurePanel>
          </Disclosure>
        )}
      </div>
    </>
  );
}

export function App() {
  const { snapshot, connected } = useSnapshot();
  const [now, setNow] = useState(() => Date.now());
  const [highlighted, setHighlighted] = useState<Set<string>>(() => new Set());
  const onNotificationClick = useCallback((keys: string[]) => {
    setHighlighted(new Set(keys));
  }, []);
  const { permission, request } = useNotifications(
    snapshot,
    onNotificationClick,
  );

  // Brings the first highlighted row into view, and clears the highlight after a while.
  useEffect(() => {
    if (highlighted.size === 0) return;
    document
      .querySelector('[data-highlighted="true"]')
      ?.scrollIntoView({ block: "center" });
    const timer = window.setTimeout(() => {
      setHighlighted(new Set());
    }, HIGHLIGHT_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [highlighted]);

  useEffect(() => {
    const clock = window.setInterval(() => {
      setNow(Date.now());
    }, CLOCK_MS);
    return () => {
      window.clearInterval(clock);
    };
  }, []);

  const groups = groupSessions(snapshot?.sessions ?? [], now);
  const attentionCount = groups.needsYou.length;

  useEffect(() => {
    document.title = pageTitle(attentionCount);
  }, [attentionCount]);

  const [announcement, setAnnouncement] = useState("");
  const previousAttention = useRef<Set<string> | null>(null);
  const attentionSignature = [...attentionKeys(groups.needsYou)].join("\n");
  // A failed first poll has no sessions, so it can't be the baseline for what is new.
  const loaded = snapshot !== null && snapshot.error === null;

  useEffect(() => {
    if (!loaded) return;
    const previous = previousAttention.current;
    previousAttention.current = attentionKeys(groups.needsYou);
    // Sessions already waiting when the page opens are read from the page itself.
    if (!previous) return;

    // Clearing first means identical text still counts as a change to a screen reader.
    setAnnouncement("");
    const message = newAttentionMessage(previous, groups.needsYou);
    if (!message) return;
    const timer = window.setTimeout(() => {
      setAnnouncement(message);
    }, ANNOUNCE_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [loaded, attentionSignature]);

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Claude Code sessions</h1>
      <div role="status" data-announcer className={styles.visuallyHidden}>
        {announcement}
      </div>
      <NotificationControl permission={permission} onTurnOn={request} />
      <Banners
        connected={connected}
        error={snapshot?.error ?? null}
        warnings={snapshot?.warnings ?? []}
      />
      {snapshot === null && <p>Loading sessions…</p>}
      {snapshot?.sessions.length === 0 && <p>No sessions to show.</p>}
      <Group
        title="Needs you"
        sessions={groups.needsYou}
        now={now}
        flagged
        highlighted={highlighted}
      />
      <Group
        title="Active"
        sessions={groups.active}
        now={now}
        highlighted={highlighted}
      />
      <StaleGroup sessions={groups.stale} now={now} highlighted={highlighted} />
      <Group
        title="Finished"
        sessions={groups.finished}
        now={now}
        highlighted={highlighted}
      />
    </main>
  );
}
