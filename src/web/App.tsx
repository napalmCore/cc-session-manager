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
import type { LeftoverOffer, SessionView } from "../shared/protocol.js";
import {
  actionContext,
  actionKey,
  availableActions,
  canEndLeftovers,
  canFork,
  isProtectedSession,
  ACTION_LABELS,
  isRisky,
  leftoverOffer,
  programLines,
  sessionLabel,
  unlistedOffers,
  type ActionContext,
  type SessionAction,
} from "../shared/session-actions.js";
import { groupSessions, pageTitle } from "../shared/session-groups.js";
import { ANSWER_IN_CLAUDE_CODE, waitingLabel } from "../shared/waiting.js";
import {
  ESTIMATE_NOTE,
  isCostLine,
  sessionUsageLines,
  totalsLines,
  usageTotals,
} from "../shared/usage-summary.js";
import cssClasses from "./App.module.css";
import {
  ConfirmDialog,
  LeftoverPanel,
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
import { createAnnouncer } from "./announcer.js";
import { type Freshness, useSnapshot } from "./useSnapshot.js";
import { HistoryView, SearchView } from "./PastSessions.js";
import {
  ForkDialog,
  NewSessionDialog,
  type ForkTargetView,
} from "./StartDialog.js";
import { useView, VIEWS, type View } from "./useView.js";

const CLOCK_MS = 30_000;
/** Data older than this gets a line saying so (BUG-9, 0020). */
export const STALE_DATA_MS = 10_000;
const HIGHLIGHT_MS = 15_000;
const styles = cssClasses as Record<
  | "banner"
  | "bannerTitle"
  | "details"
  | "disclosureButton"
  | "flagged"
  | "group"
  | "header"
  | "tab"
  | "tabs"
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
  const startedAt = session.firstStartedAt ?? session.startedAt;
  const items = [
    session.cwd ?? "Project unknown",
    session.kind ?? "Kind unknown",
    session.gitBranch ?? "Branch unavailable",
    session.model ?? "Model unavailable",
    startedAt === undefined
      ? "Start time unknown"
      : `Started ${formatTime(startedAt)}`,
  ];
  // Helps find a live session's terminal, since it has no Open (FR-20).
  if (
    session.kind === "interactive" &&
    !session.finished &&
    session.pid !== undefined
  ) {
    items.push(`Process ID ${String(session.pid)}`);
  }

  if (startedAt !== undefined) {
    if (session.finishedAt !== undefined) {
      const ran = session.finishedAt - startedAt;
      items.push(`Ran for ${formatDuration(ran)}`);
    } else if (!session.finished) {
      items.push(`Running for ${formatDuration(now - startedAt)}`);
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

const ESTIMATE_NOTE_ID = "usage-estimate-note";

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
      <p id={ESTIMATE_NOTE_ID} className={styles.usageNote}>
        {ESTIMATE_NOTE}
      </p>
    </section>
  );
}

function statusText(session: SessionView): string {
  if (session.attentionReason) return waitingLabel(session.attentionReason);
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
  /** Programs left running after the dashboard's own actions (FR-27). */
  offers: readonly LeftoverOffer[];
  onAction: (
    session: SessionView,
    action: SessionAction,
    label: string,
    groupId: string,
  ) => void;
  onFork: (target: ForkTargetView, from: HTMLElement | null) => void;
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

/** The pending action and the last result of a session, by its action key. */
function rowState(key: string | undefined, props: RowActionProps) {
  return {
    pending: key === undefined ? undefined : props.pending.get(key),
    result: key === undefined ? undefined : props.results.get(key),
  };
}

/**
 * A session that's no longer listed, such as a deleted one, whose programs still run. It shows
 * only those programs and the button that ends them (0020).
 */
function UnlistedRow({
  offer,
  groupId,
  actionProps,
}: {
  offer: LeftoverOffer;
  groupId: string;
  actionProps: RowActionProps;
}) {
  const session = { ...offer.session, finished: true };
  const label = sessionLabel(session, formatTime);
  const { pending, result } = rowState(offer.key, actionProps);
  return (
    <li className={styles.row} data-session-key={offer.key} tabIndex={-1}>
      <div className={styles.summary}>
        <span className={styles.name}>{session.name ?? "Unnamed session"}</span>
        <span className={styles.visuallyHidden}>. </span>
        <span className={styles.status}>
          {offer.deleted ? "Deleted" : "No longer listed"}
        </span>
        <span className={styles.visuallyHidden}>.</span>
      </div>
      <LeftoverPanel
        offer={offer}
        label={label}
        canEnd={canEndLeftovers(session, actionProps.context)}
        pending={pending}
        onEnd={() => {
          actionProps.onAction(session, "endLeftovers", label, groupId);
        }}
      />
      <RowActions
        actions={[]}
        label={label}
        pending={pending}
        result={result}
        onAction={() => undefined}
      />
    </li>
  );
}

function SessionList({
  sessions,
  unlisted = [],
  now,
  flagged = false,
  highlighted,
  groupId,
  actionProps,
}: {
  sessions: SessionView[];
  unlisted?: LeftoverOffer[];
  now: number;
  flagged?: boolean;
  highlighted: Set<string>;
  groupId: string;
  actionProps: RowActionProps;
}) {
  return (
    <ul className={styles.list}>
      {unlisted.map((offer) => (
        <UnlistedRow
          key={`unlisted-${offer.key}`}
          offer={offer}
          groupId={groupId}
          actionProps={actionProps}
        />
      ))}
      {sessions.map((session, index) => {
        const isHighlighted = sessionKeys(session).some((key) =>
          highlighted.has(key),
        );
        const key = actionKey(session);
        const label = sessionLabel(session, formatTime);
        const offer = leftoverOffer(session, actionProps.offers);
        const { pending, result } = rowState(key, actionProps);
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
              {/* Punctuation for screen readers, outside the visible text (BUG-10). */}
              {/* The status itself says what a flagged row needs (FR-38), so no prefix. */}
              <span className={styles.visuallyHidden}>. </span>
              <span className={styles.status}>{statusText(session)}</span>
              <span className={styles.visuallyHidden}>.</span>
            </div>
            <ul className={styles.details}>
              {details(session, now).map((item) => (
                <li
                  key={item}
                  // Ties each cost to the note giving the price table's date (FR-24).
                  aria-describedby={
                    isCostLine(item) ? ESTIMATE_NOTE_ID : undefined
                  }
                >
                  {item}
                </li>
              ))}
            </ul>
            {/* Only Needs you rows: a Stale row usually has no live prompt to answer. */}
            {flagged && session.needsAttention && (
              <p className={styles.note}>{ANSWER_IN_CLAUDE_CODE}</p>
            )}
            {isProtectedSession(session, actionProps.context) && (
              <p className={styles.note}>
                The dashboard was started from this session, so it can&apos;t be
                stopped, deleted, or ended from here.
              </p>
            )}
            {offer !== undefined && key !== undefined && (
              <LeftoverPanel
                offer={offer}
                label={label}
                canEnd={canEndLeftovers(session, actionProps.context)}
                pending={pending}
                onEnd={() => {
                  actionProps.onAction(session, "endLeftovers", label, groupId);
                }}
              />
            )}
            <RowActions
              actions={rowActions(session, actionProps, key)}
              label={label}
              pending={pending}
              result={result}
              onAction={(action) => {
                actionProps.onAction(session, action, label, groupId);
              }}
              onFork={
                key === undefined || !canFork(session, actionProps.context)
                  ? undefined
                  : (from) => {
                      actionProps.onFork(
                        { key, label, folder: session.cwd ?? null },
                        from,
                      );
                    }
              }
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
  unlisted = [],
  now,
  flagged = false,
  highlighted,
  actionProps,
}: {
  title: string;
  sessions: SessionView[];
  unlisted?: LeftoverOffer[];
  now: number;
  flagged?: boolean;
  highlighted: Set<string>;
  actionProps: RowActionProps;
}) {
  const count = sessions.length + unlisted.length;
  if (count === 0) return null;
  const id = `group-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <section aria-labelledby={id} className={styles.group}>
      <h2 id={id} className={styles.groupTitle} tabIndex={-1}>
        {title} ({count})
      </h2>
      <SessionList
        sessions={sessions}
        unlisted={unlisted}
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
          data-expandable="true"
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
              <Button
                slot="trigger"
                data-expandable="true"
                className={styles.disclosureButton}
              >
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

/**
 * When a focused expandable section's button disappears, focus moves to its group's heading,
 * or to the page heading if the group has gone, instead of falling to the page body (BUG-11).
 */
function useFocusGuard(snapshot: unknown) {
  const last = useRef<{ element: Element; headingId: string | null } | null>(
    null,
  );
  useEffect(() => {
    const onFocus = (event: FocusEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest("[data-expandable]") === null) {
        last.current = null;
        return;
      }
      const section = event.target.closest("section[aria-labelledby]");
      last.current = {
        element: event.target,
        headingId: section?.getAttribute("aria-labelledby") ?? null,
      };
    };
    // A click anywhere means the user has moved on, even if focus lands on the page body.
    const forget = (event: PointerEvent) => {
      // A click on the remembered button itself keeps it remembered.
      const remembered = last.current?.element;
      if (event.target instanceof Node && remembered?.contains(event.target)) {
        return;
      }
      last.current = null;
    };
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("pointerdown", forget, true);
    return () => {
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("pointerdown", forget, true);
    };
  }, []);
  useEffect(() => {
    const focused = last.current;
    if (focused === null || focused.element.isConnected) return;
    last.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const heading =
      (focused.headingId === null
        ? null
        : document.getElementById(focused.headingId)) ??
      document.querySelector<HTMLElement>("h1");
    heading?.focus();
  }, [snapshot]);
}

/**
 * Says when the data is getting old, as when Claude Code is slow to answer, since snapshots are
 * only sent when something changes (BUG-9).
 */
function StaleNotice({ freshness }: { freshness: Freshness | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  const at = freshness?.lastSuccessAt ?? null;
  if (at === null) return null;
  const age = now - at;
  if (age <= STALE_DATA_MS) return null;
  const seconds = Math.ceil(age / 1000);
  return (
    <p className={styles.banner} data-stale-notice>
      Last updated {seconds} seconds ago. Claude Code is slow to respond, so
      actions on sessions are paused.
    </p>
  );
}

const VIEW_LABELS: Record<View, string> = {
  sessions: "Sessions",
  history: "History",
  search: "Search",
};

/** Sessions, History, and Search, each with its own address so Back works (0025). */
function ViewTabs({ view }: { view: View }) {
  return (
    <nav aria-label="Views" className={styles.tabs}>
      {VIEWS.map((name) => (
        <a
          key={name}
          href={`#${name}`}
          className={styles.tab}
          aria-current={view === name ? "page" : undefined}
        >
          {VIEW_LABELS[name]}
        </a>
      ))}
    </nav>
  );
}

export function App() {
  const { snapshot, connected, freshness, signedIn } = useSnapshot();
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
  // Announcements wait their turn, each read for at least a second (BUG-16).
  const [announcer] = useState(() => createAnnouncer(setAnnouncement));
  const announce = announcer.announce;
  useEffect(
    () => () => {
      announcer.dispose();
    },
    [announcer],
  );
  useFocusGuard(snapshot);

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

  const view = useView();
  const [newOpen, setNewOpen] = useState(false);
  const [forkTarget, setForkTarget] = useState<ForkTargetView | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const onFork = useCallback(
    (target: ForkTargetView, from: HTMLElement | null) => {
      opener.current = from;
      setForkTarget(target);
    },
    [],
  );
  // Focus goes back to the button that opened a form, once it's closed.
  const closeForm = useCallback(() => {
    setNewOpen(false);
    setForkTarget(null);
    const back = opener.current;
    opener.current = null;
    window.setTimeout(() => {
      if (back?.isConnected === true) back.focus();
      else document.querySelector<HTMLElement>("h1")?.focus();
    }, 0);
  }, []);

  const groups = groupSessions(snapshot?.sessions ?? [], now);
  const offers = snapshot?.leftovers ?? [];
  // Sessions no longer listed, such as deleted ones, whose programs still run.
  const unlisted = unlistedOffers(snapshot?.sessions ?? [], offers);
  const actionProps: RowActionProps = {
    context: actionContext(snapshot),
    pending: actions.pending,
    results: actions.results,
    forceOffers: actions.forceOffers,
    offers,
    onAction,
    onFork,
  };
  // The result stays visible above the list once its row has gone, such as after Delete.
  const lastResult = actions.lastResult;
  const lastResultGone =
    lastResult !== null &&
    !(snapshot?.sessions ?? []).some(
      (session) => actionKey(session) === lastResult.key,
    ) &&
    !unlisted.some((offer) => offer.key === lastResult.key)
      ? lastResult
      : null;
  // The dialog lists the programs as the latest snapshot has them, so it shows the list growing.
  const confirmingOffer =
    confirming?.action === "endLeftovers"
      ? offers.find(
          (offer) =>
            offer.key === confirming.target.key ||
            offer.keys.includes(confirming.target.key),
        )
      : undefined;
  const dialogPrograms =
    confirmingOffer === undefined
      ? []
      : programLines(confirmingOffer, confirmingOffer.programs.length);

  // A dialog whose action is no longer offered, such as after the session finished or became
  // protected, closes rather than offering something the server would refuse.
  const forceOffers = actions.forceOffers;
  useEffect(() => {
    if (confirming === null) return;
    const { key, action } = confirming.target;
    const current = (snapshot?.sessions ?? []).find(
      (session) => actionKey(session) === key,
    );
    const context = actionContext(snapshot);
    const offered =
      action === "endLeftovers"
        ? (snapshot?.leftovers ?? []).some(
            (offer) => offer.key === key || offer.keys.includes(key),
          ) && canEndLeftovers(current ?? confirming.session, context)
        : current !== undefined &&
          rowActions(
            current,
            {
              context,
              pending: new Map(),
              results: new Map(),
              forceOffers,
              offers: [],
              onAction,
              onFork: () => undefined,
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
      <div className={styles.header}>
        <h1 className={styles.title} tabIndex={-1}>
          Claude Code sessions
        </h1>
        <Button
          ref={newButton}
          className={styles.notifyButton}
          isDisabled={!signedIn}
          onPress={() => {
            opener.current = newButton.current;
            setNewOpen(true);
          }}
        >
          New session…
        </Button>
      </div>
      <ViewTabs view={view} />
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
      {view === "history" && (
        <HistoryView announce={announce} onFork={onFork} now={now} />
      )}
      {view === "search" && (
        <SearchView announce={announce} onFork={onFork} now={now} />
      )}
      {view === "sessions" && (
        <>
          {snapshot !== null && snapshot.sessions.length > 0 && (
            <UsageSummary sessions={snapshot.sessions} />
          )}
          {connected && <StaleNotice freshness={freshness} />}
          {signedIn && snapshot === null && <p>Loading sessions…</p>}
          {snapshot?.sessions.length === 0 &&
            unlisted.length === 0 &&
            snapshot.notLoadedYet !== true && <p>No sessions to show.</p>}
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
            unlisted={unlisted}
            now={now}
            highlighted={highlighted}
            actionProps={actionProps}
          />
        </>
      )}
      {newOpen && (
        <NewSessionDialog
          isOpen
          onClose={closeForm}
          onStarted={(reply) => {
            announce(`New session: ${reply.message}`);
            closeForm();
          }}
        />
      )}
      {forkTarget !== null && (
        <ForkDialog
          key={forkTarget.key}
          target={forkTarget}
          onClose={closeForm}
          onStarted={(reply) => {
            announce(`Fork, ${forkTarget.label}: ${reply.message}`);
            closeForm();
          }}
        />
      )}
      <ConfirmDialog
        confirming={confirming}
        programs={dialogPrograms}
        onCancel={closeDialog}
        onConfirm={confirm}
      />
    </main>
  );
}
