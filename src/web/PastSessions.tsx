import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Label, SearchField } from "react-aria-components";
import { formatDuration } from "../shared/format.js";
import type { ActionReply } from "../shared/session-actions.js";
import { sessionUsageLines } from "../shared/usage-summary.js";
import cssClasses from "./App.module.css";
import {
  postAction,
  postJson,
  readHistoryPage,
  readSearchStatus,
  type HistoryPageView,
  type SearchHitView,
  type SearchStatusView,
} from "./api.js";
import type { ForkTargetView } from "./StartDialog.js";

const styles = cssClasses as Record<
  | "actions"
  | "button"
  | "details"
  | "field"
  | "fieldHelp"
  | "group"
  | "groupTitle"
  | "input"
  | "list"
  | "name"
  | "note"
  | "pager"
  | "result"
  | "row"
  | "searchForm"
  | "snippets"
  | "status"
  | "summary"
  | "visuallyHidden",
  string
>;

/** History re-reads its page this often while usage is still being counted. */
const COUNTING_REFRESH_MS = 5_000;
const SEARCH_POLL_MS = 500;

function formatTime(time: number): string {
  return new Date(time).toLocaleString();
}

/** A past session has no name in History, so it's named by its folder and start (0024). */
export function pastLabel(
  folder: string | null,
  startedAt: number | null,
  sessionId: string,
): string {
  const place = folder ?? `session ${sessionId.slice(0, 8)}`;
  return startedAt === null
    ? place
    : `${place}, started ${formatTime(startedAt)}`;
}

interface PastActionProps {
  announce: (message: string) => void;
  onFork: (target: ForkTargetView, from: HTMLElement | null) => void;
}

/** Resume and Fork for a session found in History or search (FR-35, FR-36). */
function PastActions({
  sessionId,
  label,
  folder,
  inList,
  folderUsable,
  props,
}: {
  sessionId: string;
  label: string;
  folder: string | null;
  inList: boolean | null;
  folderUsable: boolean;
  props: PastActionProps;
}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ActionReply | null>(null);
  const forkButton = useRef<HTMLButtonElement>(null);
  if (!folderUsable) {
    return (
      <p className={styles.note}>
        Its folder is gone or isn&apos;t on a local drive, so it can&apos;t be
        resumed or forked from here.
      </p>
    );
  }
  return (
    <>
      <div
        role="group"
        aria-label={`Actions for ${label}`}
        className={styles.actions}
      >
        {inList !== true && (
          <Button
            data-action="resume"
            className={styles.button}
            isPending={pending}
            onPress={() => {
              setPending(true);
              void postAction({ action: "resume", key: sessionId }).then(
                ({ reply }) => {
                  setPending(false);
                  setResult(reply);
                  props.announce(`Resume, ${label}: ${reply.message}`);
                },
              );
            }}
          >
            {pending ? "Resuming…" : "Resume"}
          </Button>
        )}
        <Button
          ref={forkButton}
          data-action="fork"
          className={styles.button}
          isDisabled={pending}
          onPress={() => {
            props.onFork({ key: sessionId, label, folder }, forkButton.current);
          }}
        >
          Fork…
        </Button>
      </div>
      {inList === true && (
        <p className={styles.note}>
          Also in the session list, where it can be resumed.
        </p>
      )}
      {result !== null && (
        <p className={styles.result} data-outcome={result.outcome}>
          Resume: {result.message}
        </p>
      )}
    </>
  );
}

/** Every past session, newest first, 50 to a page (FR-35). */
export function HistoryView(props: PastActionProps & { now: number }) {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<HistoryPageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const turned = useRef(false);
  // Only the latest request's reply is shown, so a late refresh can't replace a newer page.
  const latest = useRef(0);
  const shown = useRef<number | null>(null);

  const load = useCallback(async (at: number) => {
    latest.current += 1;
    const ticket = latest.current;
    const { reply, data: body } = await postAction({
      action: "history",
      page: at,
    });
    if (ticket !== latest.current) return;
    const read =
      reply.outcome === "succeeded" ? readHistoryPage(body.history) : null;
    setLoading(false);
    if (read === null) {
      setError(reply.message);
      // A page that couldn't be read leaves the shown page and its number as they were.
      if (shown.current !== null) setPage(shown.current);
      return;
    }
    setError(null);
    shown.current = read.page;
    setData(read);
  }, []);

  useEffect(() => {
    setLoading(true);
    void load(page);
  }, [page, load]);

  // A new page replaces the buttons, so focus goes to the heading.
  useEffect(() => {
    if (turned.current && !loading) {
      turned.current = false;
      heading.current?.focus();
    }
  }, [data, loading]);

  // Usage fills in over the reader's polls, so the page is read again while it's counting.
  const counting =
    data?.sessions.some((entry) => entry.usage?.counting === true) ?? false;
  useEffect(() => {
    if (!counting) return;
    const timer = window.setTimeout(() => {
      void load(page);
    }, COUNTING_REFRESH_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [counting, data, page, load]);

  const turn = (to: number) => {
    turned.current = true;
    setPage(to);
  };

  return (
    <section aria-labelledby="history-title" className={styles.group}>
      <h2
        id="history-title"
        ref={heading}
        tabIndex={-1}
        className={styles.groupTitle}
      >
        History
        {data !== null && ` (${String(data.total)})`}
      </h2>
      <p className={styles.note}>
        Every past session in this computer&apos;s Claude Code transcripts,
        newest first.
      </p>
      {loading && data === null && <p role="status">Reading History…</p>}
      {error !== null && (
        <p role="alert" className={styles.result} data-outcome="failed">
          {error}
        </p>
      )}
      {data !== null && data.total === 0 && <p>No past sessions.</p>}
      {data !== null && data.sessions.length > 0 && (
        <ul className={styles.list}>
          {data.sessions.map((entry) => {
            const label = pastLabel(
              entry.folder,
              entry.startedAt,
              entry.sessionId,
            );
            const items = [
              entry.folder ?? "Folder unknown",
              entry.gitBranch ?? "Branch unavailable",
              entry.model ?? "Model unavailable",
              entry.startedAt === null
                ? "Start time unknown"
                : `Started ${formatTime(entry.startedAt)}`,
              entry.lastActivityAt === null
                ? "Last activity unavailable"
                : `Last active ${formatDuration(props.now - entry.lastActivityAt)} ago`,
              ...sessionUsageLines(entry.usage),
            ];
            return (
              <li
                key={entry.sessionId}
                className={styles.row}
                data-session-key={entry.sessionId}
              >
                <div className={styles.summary}>
                  <span className={styles.name}>
                    {entry.startedAt === null
                      ? `Session ${entry.sessionId.slice(0, 8)}`
                      : `Session started ${formatTime(entry.startedAt)}`}
                  </span>
                </div>
                <ul className={styles.details}>
                  {items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <PastActions
                  sessionId={entry.sessionId}
                  label={label}
                  folder={entry.folder}
                  inList={entry.inList}
                  folderUsable={entry.folderUsable}
                  props={props}
                />
              </li>
            );
          })}
        </ul>
      )}
      {data !== null && data.pages > 1 && (
        <nav aria-label="History pages" className={styles.pager}>
          <Button
            className={styles.button}
            isDisabled={page === 0 || loading}
            onPress={() => {
              turn(page - 1);
            }}
          >
            Newer
          </Button>
          <span>
            Page {page + 1} of {data.pages}
          </span>
          <Button
            className={styles.button}
            isDisabled={page >= data.pages - 1 || loading}
            onPress={() => {
              turn(page + 1);
            }}
          >
            Older
          </Button>
        </nav>
      )}
    </section>
  );
}

function progressText(status: SearchStatusView | null): string {
  if (status?.status === "running") {
    return status.filesTotal === 0
      ? "Searching…"
      : `Searching… ${String(status.filesDone)} of ${String(status.filesTotal)} conversations read.`;
  }
  return "";
}

function resultsText(
  status: Extract<SearchStatusView, { status: "done" }>,
): string {
  const found =
    status.sessions.length === 0
      ? "No conversations match."
      : status.sessions.length === 1
        ? "1 conversation matches."
        : `${String(status.sessions.length)} conversations match.`;
  return status.stopped
    ? `${found} The search stopped after 30 seconds, with ${String(status.filesDone)} of ${String(status.filesTotal)} conversations read.`
    : found;
}

/** Search inside conversations: read on demand, nothing kept (FR-36, C-16). */
export function SearchView(props: PastActionProps & { now: number }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SearchStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchId = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const generation = useRef(0);
  const box = useRef<HTMLInputElement>(null);

  const stopPolling = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  };

  const cancel = useCallback(() => {
    stopPolling();
    generation.current += 1;
    const id = searchId.current;
    searchId.current = null;
    if (id !== null) void postJson(`/api/search/${id}/cancel`);
  }, []);

  // Leaving the view stops the search, so nothing is read for no one.
  useEffect(() => cancel, [cancel]);

  const poll = (id: string, ticket: number) => {
    timer.current = window.setTimeout(() => {
      void postJson(`/api/search/${id}`).then((answer) => {
        if (generation.current !== ticket || searchId.current !== id) return;
        const next =
          answer === null
            ? ({ status: "gone" } as const)
            : readSearchStatus(answer.data);
        if (next.status === "running") {
          setStatus(next);
          poll(id, ticket);
          return;
        }
        searchId.current = null;
        if (next.status === "gone") {
          setStatus(null);
          setError(
            "The search's results are no longer available. Search again.",
          );
          props.announce("The search's results are no longer available.");
          return;
        }
        setStatus(next);
        props.announce(resultsText(next));
      });
    }, SEARCH_POLL_MS);
  };

  const start = async () => {
    cancel();
    setError(null);
    setStatus({ status: "running", filesDone: 0, filesTotal: 0 });
    const ticket = generation.current;
    const answer = await postJson("/api/search", { query });
    const data = answer?.data as { id?: unknown; message?: unknown } | null;
    // Cancelled, left, or replaced while it was starting: it's stopped on the server too.
    if (generation.current !== ticket) {
      if (typeof data?.id === "string") {
        void postJson(`/api/search/${data.id}/cancel`);
      }
      return;
    }
    if (
      answer === null ||
      answer.status !== 200 ||
      typeof data?.id !== "string"
    ) {
      setStatus(null);
      setError(
        typeof data?.message === "string"
          ? data.message
          : "Couldn't reach the local server.",
      );
      return;
    }
    searchId.current = data.id;
    poll(data.id, ticket);
  };

  const running = status?.status === "running";
  const done = status?.status === "done" ? status : null;
  return (
    <section aria-labelledby="search-title" className={styles.group}>
      <h2 id="search-title" tabIndex={-1} className={styles.groupTitle}>
        Search
      </h2>
      <form
        role="search"
        className={styles.searchForm}
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <SearchField
          className={styles.field}
          value={query}
          onChange={setQuery}
          onClear={() => {
            setQuery("");
          }}
          maxLength={200}
        >
          <Label>Search your prompts and Claude&apos;s replies</Label>
          <Input
            ref={box}
            className={styles.input}
            autoComplete="off"
            spellCheck={false}
          />
        </SearchField>
        <div className={styles.actions}>
          <Button type="submit" className={styles.button} isPending={running}>
            {running ? "Searching…" : "Search"}
          </Button>
          {running && (
            <Button
              className={styles.button}
              onPress={() => {
                cancel();
                setStatus(null);
                props.announce("Search cancelled.");
                // The button goes away, so focus goes back to the search box.
                box.current?.focus();
              }}
            >
              Cancel search
            </Button>
          )}
        </div>
      </form>
      <p className={styles.fieldHelp}>
        2 to 200 characters, matched as plain text, ignoring case. Search reads
        your transcripts only while it runs and keeps nothing afterwards.
        Thinking, tool output, and subagents aren&apos;t searched.
      </p>
      <p role="status" className={styles.note}>
        {progressText(status)}
      </p>
      {error !== null && (
        <p role="alert" className={styles.result} data-outcome="failed">
          {error}
        </p>
      )}
      {done !== null && (
        <>
          <p className={styles.status}>{resultsText(done)}</p>
          {done.sessions.length > 0 && (
            <ul className={styles.list} aria-label="Matching conversations">
              {done.sessions.map((hit) => (
                <SearchHitRow
                  key={hit.sessionId}
                  hit={hit}
                  now={props.now}
                  props={props}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function SearchHitRow({
  hit,
  now,
  props,
}: {
  hit: SearchHitView;
  now: number;
  props: PastActionProps;
}) {
  const label = pastLabel(hit.folder, null, hit.sessionId);
  const items = [
    hit.count === 1 ? "1 match" : `${String(hit.count)} matches`,
    hit.folder ?? "Folder unknown",
    hit.lastActivityAt === null
      ? "Last activity unavailable"
      : `Last active ${formatDuration(now - hit.lastActivityAt)} ago`,
  ];
  return (
    <li className={styles.row} data-session-key={hit.sessionId}>
      <div className={styles.summary}>
        <span className={styles.name}>{label}</span>
      </div>
      <ul className={styles.details}>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {hit.snippets.length > 0 && (
        <ul className={styles.snippets} aria-label={`Matches in ${label}`}>
          {hit.snippets.map((snippet, index) => (
            <li key={index}>{snippet}</li>
          ))}
        </ul>
      )}
      <PastActions
        sessionId={hit.sessionId}
        label={label}
        folder={hit.folder}
        inList={hit.inList}
        folderUsable={hit.folderUsable}
        props={props}
      />
    </li>
  );
}
