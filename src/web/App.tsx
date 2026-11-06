import { useEffect, useState } from "react";
import {
  Button,
  Disclosure,
  DisclosurePanel,
  Heading,
} from "react-aria-components";
import { formatDuration } from "../shared/format.js";
import type { SessionView } from "../shared/protocol.js";
import { groupSessions, pageTitle } from "../shared/session-groups.js";
import cssClasses from "./App.module.css";
import { useSnapshot } from "./useSnapshot.js";

const CLOCK_MS = 30_000;
const styles = cssClasses as Record<
  | "banner"
  | "bannerTitle"
  | "details"
  | "disclosureButton"
  | "flagged"
  | "group"
  | "groupTitle"
  | "list"
  | "marker"
  | "name"
  | "page"
  | "row"
  | "status"
  | "summary"
  | "title"
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

function SessionList({
  sessions,
  now,
  flagged = false,
}: {
  sessions: SessionView[];
  now: number;
  flagged?: boolean;
}) {
  return (
    <ul className={styles.list}>
      {sessions.map((session, index) => (
        <li
          key={session.sessionId ?? session.id ?? index}
          className={flagged ? `${styles.row} ${styles.flagged}` : styles.row}
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
      ))}
    </ul>
  );
}

function Group({
  title,
  sessions,
  now,
  flagged = false,
}: {
  title: string;
  sessions: SessionView[];
  now: number;
  flagged?: boolean;
}) {
  if (sessions.length === 0) return null;
  const id = `group-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <section aria-labelledby={id} className={styles.group}>
      <h2 id={id} className={styles.groupTitle}>
        {title} ({sessions.length})
      </h2>
      <SessionList sessions={sessions} now={now} flagged={flagged} />
    </section>
  );
}

function StaleGroup({
  sessions,
  now,
}: {
  sessions: SessionView[];
  now: number;
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
        <SessionList sessions={sessions} now={now} />
      </DisclosurePanel>
    </Disclosure>
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

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Claude Code sessions</h1>
      <Banners
        connected={connected}
        error={snapshot?.error ?? null}
        warnings={snapshot?.warnings ?? []}
      />
      {snapshot === null && <p>Loading sessions…</p>}
      {snapshot?.sessions.length === 0 && <p>No sessions to show.</p>}
      <Group title="Needs you" sessions={groups.needsYou} now={now} flagged />
      <Group title="Active" sessions={groups.active} now={now} />
      <StaleGroup sessions={groups.stale} now={now} />
      <Group title="Finished" sessions={groups.finished} now={now} />
    </main>
  );
}
