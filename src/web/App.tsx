import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Disclosure,
  DisclosurePanel,
  Heading,
} from "react-aria-components";
import { attentionKeys, newAttentionMessage } from "../shared/announcements.js";
import { formatDuration } from "../shared/format.js";
import { sessionKeys } from "../shared/notifications.js";
import type { SessionView } from "../shared/protocol.js";
import {
  actionContext,
  actionKey,
  availableActions,
  isProtectedSession,
  ACTION_LABELS,
  isRisky,
  sessionLabel,
  type ActionContext,
  type SessionAction,
} from "../shared/session-actions.js";
import { groupSessions, pageTitle } from "../shared/session-groups.js";
import {
  ESTIMATE_NOTE,
  sessionUsageLines,
  totalsLines,
  usageTotals,
} from "../shared/usage-summary.js";
import cssClasses from "./App.module.css";
import {
  ConfirmDialog,
  RowActions,
  type Confirming,
} from "./SessionActions.js";
import { type NotifyPermission, useNotifications } from "./useNotifications.js";
import {
  restoreFocus,
  type ActionResultView,
  type FocusTarget,
  useSessionActions,
} from "./useSessionActions.js";
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
  | "lastResult"
  | "note"
  | "notifyButton"
  | "notifyStatus"
  | "toolbar"
  | "usage"
  | "usageNote"
  | "usageTitle"
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
  // Helps find a live session's terminal, since it has no Open (FR-20).
  if (
    session.kind === "interactive" &&
    !session.finished &&
    session.pid !== undefined
  ) {
    items.push(`Process ID ${String(session.pid)}`);
  }

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
  items.push(...sessionUsageLines(session.usage));
  return items;
}

/** Totals for the listed sessions, under the page heading (FR-25). */
function UsageSummary({ sessions }: { sessions: SessionView[] }) {
  const lines = totalsLines(usageTotals(sessions));
  return (
    <section aria-labelledby="usage-title" className={styles.usage}>
      <h2 id="usage-title" className={styles.usageTitle}>
        Usage
      </h2>
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      <p className={styles.usageNote}>{ESTIMATE_NOTE}</p>
    </section>
  );
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

/** What every row needs to offer and show actions. */
interface RowActionProps {
  context: ActionContext;
  pending: ReadonlyMap<string, SessionAction>;
  results: ReadonlyMap<string, ActionResultView>;
  forceOffers: ReadonlySet<string>;
  onAction: (
    session: SessionView,
    action: SessionAction,
    label: string,
    groupId: string,
  ) => void;
}

function rowActions(
  session: SessionView,
  props: RowActionProps,
  key: string | undefined,
): SessionAction[] {
  const actions = availableActions(session, props.context);
  // Force end follows an End that couldn't close the session, while End is still allowed.
  if (
    key !== undefined &&
    props.forceOffers.has(key) &&
    actions.includes("end")
  ) {
    actions.push("forceEnd");
  }
  return actions;
}

function SessionList({
  sessions,
  now,
  flagged = false,
  highlighted,
  groupId,
  actionProps,
}: {
  sessions: SessionView[];
  now: number;
  flagged?: boolean;
  highlighted: Set<string>;
  groupId: string;
  actionProps: RowActionProps;
}) {
  return (
    <ul className={styles.list}>
      {sessions.map((session, index) => {
        const isHighlighted = sessionKeys(session).some((key) =>
          highlighted.has(key),
        );
        const key = actionKey(session);
        const label = sessionLabel(session, formatTime);
        return (
          <li
            key={session.sessionId ?? session.id ?? index}
            className={rowClass(flagged, isHighlighted)}
            data-highlighted={isHighlighted ? "true" : undefined}
            data-session-key={key}
            tabIndex={-1}
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
            {isProtectedSession(session, actionProps.context) && (
              <p className={styles.note}>
                The dashboard was started from this session, so it can&apos;t be
                stopped, deleted, or ended from here.
              </p>
            )}
            <RowActions
              actions={rowActions(session, actionProps, key)}
              label={label}
              pending={
                key === undefined ? undefined : actionProps.pending.get(key)
              }
              result={
                key === undefined ? undefined : actionProps.results.get(key)
              }
              onAction={(action) => {
                actionProps.onAction(session, action, label, groupId);
              }}
            />
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
  actionProps,
}: {
  title: string;
  sessions: SessionView[];
  now: number;
  flagged?: boolean;
  highlighted: Set<string>;
  actionProps: RowActionProps;
}) {
  if (sessions.length === 0) return null;
  const id = `group-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <section aria-labelledby={id} className={styles.group}>
      <h2 id={id} className={styles.groupTitle} tabIndex={-1}>
        {title} ({sessions.length})
      </h2>
      <SessionList
        sessions={sessions}
        now={now}
        flagged={flagged}
        highlighted={highlighted}
        groupId={id}
        actionProps={actionProps}
      />
    </section>
  );
}

function StaleGroup({
  sessions,
  now,
  highlighted,
  actionProps,
}: {
  sessions: SessionView[];
  now: number;
  highlighted: Set<string>;
  actionProps: RowActionProps;
}) {
  if (sessions.length === 0) return null;
  return (
    <Disclosure className={styles.group}>
      <Heading level={2} className={styles.groupTitle}>
        <Button
          id="group-stale"
          slot="trigger"
          className={styles.disclosureButton}
        >
          Stale ({sessions.length}): blocked, inactive for over 7 days
        </Button>
      </Heading>
      <DisclosurePanel>
        <SessionList
          sessions={sessions}
          now={now}
          highlighted={highlighted}
          groupId="group-stale"
          actionProps={actionProps}
        />
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
  const status = useRef<HTMLParagraphElement>(null);
  const [asked, setAsked] = useState(false);

  // The button goes away once the prompt is answered, so focus moves to the result.
  useEffect(() => {
    if (asked && permission !== "default") status.current?.focus();
  }, [asked, permission]);

  return (
    <div className={styles.toolbar}>
      {permission === "default" ? (
        <Button
          className={styles.notifyButton}
          onPress={() => {
            setAsked(true);
            onTurnOn();
          }}
        >
          Turn on desktop notifications
        </Button>
      ) : (
        <p
          ref={status}
          tabIndex={-1}
          role="status"
          className={styles.notifyStatus}
        >
          {PERMISSION_TEXT[permission]}
        </p>
      )}
    </div>
  );
}

function Banners({
  signedIn,
  connected,
  error,
  warnings,
  actionsBlocked,
}: {
  signedIn: boolean;
  connected: boolean;
  error: string | null;
  warnings: string[];
  actionsBlocked: string | null;
}) {
  return (
    <>
      {actionsBlocked !== null && (
        <p className={styles.banner}>{actionsBlocked}</p>
      )}
      {!signedIn && (
        <p role="alert" className={styles.banner}>
          This page isn&apos;t signed in. Open the dashboard from the link the
          tool printed when it started, or start the tool again.
        </p>
      )}
      {signedIn && !connected && (
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
  const { snapshot, connected, signedIn } = useSnapshot();
  const [now, setNow] = useState(() => Date.now());
  const [highlighted, setHighlighted] = useState<Set<string>>(() => new Set());
  const onNotificationClick = useCallback((keys: string[]) => {
    setHighlighted(new Set(keys));
  }, []);
  const { permission, request } = useNotifications(
    snapshot,
    onNotificationClick,
  );

  const [announcement, setAnnouncement] = useState("");
  const announceTimer = useRef<number | undefined>(undefined);
  const queued = useRef<string[]>([]);
  const announce = useCallback((message: string) => {
    // An empty message only clears the region, and never cancels one that's about to be read.
    if (message === "") {
      if (queued.current.length === 0) setAnnouncement("");
      return;
    }
    // Clearing first means identical text still counts as a change to a screen reader.
    setAnnouncement("");
    queued.current.push(message);
    window.clearTimeout(announceTimer.current);
    announceTimer.current = window.setTimeout(() => {
      setAnnouncement(queued.current.join(" "));
      queued.current = [];
    }, ANNOUNCE_DELAY_MS);
  }, []);
  useEffect(
    () => () => {
      window.clearTimeout(announceTimer.current);
    },
    [],
  );

  const actions = useSessionActions(announce);
  const { run, lastTarget } = actions;
  const [confirming, setConfirming] = useState<
    (Confirming & { session: SessionView; target: FocusTarget }) | null
  >(null);
  const onAction = useCallback(
    (
      session: SessionView,
      action: SessionAction,
      label: string,
      groupId: string,
    ) => {
      const key = actionKey(session);
      if (key === undefined) return;
      if (isRisky(action)) {
        setConfirming({
          action,
          label,
          session,
          target: { key, action, groupId },
        });
      } else {
        void run(session, action, label, groupId);
      }
    },
    [run],
  );
  const closeDialog = useCallback(() => {
    const target = confirming?.target ?? null;
    setConfirming(null);
    restoreFocus(target);
  }, [confirming]);
  const confirm = useCallback(() => {
    if (confirming === null) return;
    const { session, action, label, target } = confirming;
    setConfirming(null);
    restoreFocus(target);
    void run(session, action, label, target.groupId);
  }, [confirming, run]);

  // A row that has gone, such as after Delete, takes focus with it, so it goes to its group.
  useEffect(() => {
    restoreFocus(lastTarget.current);
  }, [snapshot, lastTarget]);

  // Brings the first highlighted row into view, and clears the highlight after a while.
  useEffect(() => {
    if (highlighted.size === 0) return;
    const row = document.querySelector<HTMLElement>(
      '[data-highlighted="true"]',
    );
    row?.scrollIntoView({ block: "center" });
    row?.focus({ preventScroll: true });
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
  const actionProps: RowActionProps = {
    context: actionContext(snapshot),
    pending: actions.pending,
    results: actions.results,
    forceOffers: actions.forceOffers,
    onAction,
  };
  // The result stays visible above the list once its row has gone, such as after Delete.
  const lastResult = actions.lastResult;
  const lastResultGone =
    lastResult !== null &&
    !(snapshot?.sessions ?? []).some(
      (session) => actionKey(session) === lastResult.key,
    )
      ? lastResult
      : null;

  // A dialog whose action is no longer offered, such as after the session finished or became
  // protected, closes rather than offering something the server would refuse.
  const forceOffers = actions.forceOffers;
  useEffect(() => {
    if (confirming === null) return;
    const { key, action } = confirming.target;
    const current = (snapshot?.sessions ?? []).find(
      (session) => actionKey(session) === key,
    );
    const offered =
      current !== undefined &&
      rowActions(
        current,
        {
          context: actionContext(snapshot),
          pending: new Map(),
          results: new Map(),
          forceOffers,
          onAction,
        },
        key,
      ).includes(action);
    if (offered) return;
    announce(
      `${ACTION_LABELS[action]} is no longer available for ${confirming.label}.`,
    );
    closeDialog();
  }, [snapshot, confirming, forceOffers, onAction, closeDialog, announce]);
  const attentionCount = groups.needsYou.length;

  useEffect(() => {
    document.title = pageTitle(attentionCount);
  }, [attentionCount]);

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

    const message = newAttentionMessage(previous, groups.needsYou);
    // A change with nothing new still clears the region, so a session that returns is read again.
    announce(message);
  }, [loaded, attentionSignature, announce]);

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Claude Code sessions</h1>
      <div role="status" data-announcer className={styles.visuallyHidden}>
        {announcement}
      </div>
      <NotificationControl permission={permission} onTurnOn={request} />
      <Banners
        signedIn={signedIn}
        connected={connected}
        error={snapshot?.error ?? null}
        warnings={snapshot?.warnings ?? []}
        actionsBlocked={snapshot?.actionsBlocked ?? null}
      />
      {lastResultGone !== null && (
        <p
          className={styles.lastResult}
          data-outcome={lastResultGone.reply.outcome}
        >
          {ACTION_LABELS[lastResultGone.action]}, {lastResultGone.label}:{" "}
          {lastResultGone.reply.message}
        </p>
      )}
      {snapshot !== null && snapshot.sessions.length > 0 && (
        <UsageSummary sessions={snapshot.sessions} />
      )}
      {signedIn && snapshot === null && <p>Loading sessions…</p>}
      {snapshot?.sessions.length === 0 && <p>No sessions to show.</p>}
      <Group
        title="Needs you"
        sessions={groups.needsYou}
        now={now}
        flagged
        highlighted={highlighted}
        actionProps={actionProps}
      />
      <Group
        title="Active"
        sessions={groups.active}
        now={now}
        highlighted={highlighted}
        actionProps={actionProps}
      />
      <StaleGroup
        sessions={groups.stale}
        now={now}
        highlighted={highlighted}
        actionProps={actionProps}
      />
      <Group
        title="Finished"
        sessions={groups.finished}
        now={now}
        highlighted={highlighted}
        actionProps={actionProps}
      />
      <ConfirmDialog
        confirming={confirming}
        onCancel={closeDialog}
        onConfirm={confirm}
      />
    </main>
  );
}
