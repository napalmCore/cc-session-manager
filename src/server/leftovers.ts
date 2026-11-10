import type {
  LeftoverOffer,
  LeftoverProgram,
  SessionView,
} from "../shared/protocol.js";
import { sessionKeys } from "../shared/notifications.js";
import { actionKey } from "../shared/session-actions.js";
import type { ActionResult } from "./actions.js";
import {
  type InputRun,
  type LeftoverRecord,
  type ProcessEntry,
  type ProcessId,
  parseCheck,
  parseEndLeftovers,
} from "./leftovers-helper.js";

/** The first check after an action (FR-27). */
export const FIRST_CHECK_MS = 5_000;
/** How long a record waits for a session process that's still running to exit. */
export const WAIT_FOR_EXIT_MS = 10 * 60_000;
/** The helper takes at most this many entries in one request. */
const MAX_ENTRIES = 2000;
/** Programs sent to the page per session; the row shows 10 of them, the dialog all of these. */
export const OFFER_PROGRAMS = 50;
/** Programs whose new children are looked for, because they start programs (U-16). */
const WRAPPERS = new Set(["bash", "sh"]);

export type RecordedAction = "stop" | "delete" | "end" | "forceEnd";

/** Time to the next check, backing off as the action gets older. */
export function checkDelay(sinceAction: number): number {
  if (sinceAction < 60_000) return 10_000;
  if (sinceAction < WAIT_FOR_EXIT_MS) return 30_000;
  return 60_000;
}

interface Held {
  keys: string[];
  view: SessionView;
  action: RecordedAction;
  actedAt: number;
  deleted: boolean;
  session: ProcessId;
  /** True once the session's own process is seen to have exited. */
  sessionGone: boolean;
  /** Entries believed to be running: recorded ones and children found since. */
  entries: ProcessEntry[];
  nextCheckAt: number;
}

export interface LeftoverTrackerOptions {
  /** Runs the helper's check and end-leftovers modes, or null when it's unavailable. */
  run: InputRun | null;
  /** Called when what the page should show has changed. */
  onChange: () => void;
  now?: () => number;
}

const idOf = (process: ProcessId) =>
  `${String(process.pid)}@${String(process.startMs)}`;

function baseName(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, "");
}

const SKIP_REASONS: Record<string, string> = {
  "not-running": "had already exited",
  "different-process": "is now a different process",
  "different-program": "is now a different program",
  "access-denied": "the tool isn't allowed to end it",
  protected: "it belongs to the tool or to Claude Code",
  "no-path": "it couldn't be identified",
};

function describe(entry: ProcessEntry): string {
  const name = entry.name === "" ? "Unknown program" : entry.name;
  return `${name} (process ${String(entry.pid)})`;
}

export function createLeftoverTracker(options: LeftoverTrackerOptions) {
  const now = options.now ?? Date.now;
  const held: Held[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking: Promise<void> | null = null;
  let stopped = false;

  const find = (key: string) => held.find((item) => item.keys.includes(key));
  const drop = (item: Held) => {
    const index = held.indexOf(item);
    if (index >= 0) held.splice(index, 1);
  };

  const signature = () => JSON.stringify(offers());

  const offers = (): LeftoverOffer[] =>
    held
      .filter((item) => item.sessionGone && item.entries.length > 0)
      .flatMap((item) => {
        const key = actionKey(item.view);
        if (key === undefined) return [];
        const programs: LeftoverProgram[] = item.entries
          .slice(0, OFFER_PROGRAMS)
          .map((entry) => ({ pid: entry.pid, name: entry.name }));
        return [
          {
            key,
            keys: item.keys,
            deleted: item.deleted,
            session: item.view,
            programs,
            count: item.entries.length,
          },
        ];
      });

  /** What one check run asks the helper, for the given records. */
  const request = (items: Held[]) => {
    const processes = new Map<string, ProcessId>();
    const parents = new Map<string, ProcessId>();
    for (const item of items) {
      if (!item.sessionGone) processes.set(idOf(item.session), item.session);
      for (const entry of item.entries) {
        const id = { pid: entry.pid, startMs: entry.startMs };
        processes.set(idOf(id), id);
        if (WRAPPERS.has(baseName(entry.name))) parents.set(idOf(id), id);
      }
    }
    return {
      processes: [...processes.values()].slice(0, MAX_ENTRIES),
      parents: [...parents.values()].slice(0, MAX_ENTRIES),
    };
  };

  /**
   * Checks the given records once. Returns false when the helper couldn't answer, in which case
   * nothing changes.
   */
  const checkItems = async (items: Held[]): Promise<boolean> => {
    if (options.run === null || items.length === 0) return false;
    const outcome = await options.run("check", request(items));
    if (outcome.kind !== "ok") return false;
    const result = parseCheck(outcome.result);
    if (result === null) return false;
    // A process whose start time couldn't be read is treated as still running.
    const alive = new Set([...result.running, ...result.unverified].map(idOf));
    const time = now();
    for (const item of items) {
      if (!item.sessionGone) {
        item.sessionGone = !alive.has(idOf(item.session));
        if (!item.sessionGone && time - item.actedAt > WAIT_FOR_EXIT_MS) {
          drop(item);
          continue;
        }
      }
      const kept = item.entries.filter((entry) => alive.has(idOf(entry)));
      const known = new Set(kept.map(idOf));
      const parentIds = new Set(kept.map((entry) => entry.pid));
      for (const child of result.children) {
        if (!parentIds.has(child.parentPid) || known.has(idOf(child))) continue;
        if (kept.length >= MAX_ENTRIES) break;
        known.add(idOf(child));
        kept.push({
          pid: child.pid,
          startMs: child.startMs,
          name: child.name,
          path: child.path,
        });
      }
      item.entries = kept;
      if (item.sessionGone && kept.length === 0) {
        drop(item);
        continue;
      }
      item.nextCheckAt = time + checkDelay(time - item.actedAt);
    }
    return true;
  };

  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (stopped || held.length === 0) return;
    const next = Math.min(...held.map((item) => item.nextCheckAt));
    timer = setTimeout(
      () => {
        timer = undefined;
        void check();
      },
      Math.max(0, next - now()),
    );
    timer.unref?.();
  };

  /** One check run covers every held record. */
  const check = async (): Promise<void> => {
    if (checking !== null) return checking;
    const before = signature();
    checking = (async () => {
      try {
        const ok = await checkItems([...held]);
        if (!ok) {
          // Try again later, at the same pace.
          const time = now();
          for (const item of held) {
            item.nextCheckAt = time + checkDelay(time - item.actedAt);
          }
        }
      } catch {
        // A failed check changes nothing.
      } finally {
        checking = null;
      }
    })();
    await checking;
    if (signature() !== before) options.onChange();
    schedule();
  };

  return {
    /**
     * Keeps the programs recorded before an action. A null record means recording failed; with
     * none, a Delete carries over the record of an earlier Stop of the same session.
     */
    hold(
      view: SessionView,
      action: RecordedAction,
      record: LeftoverRecord | null | undefined,
      result: ActionResult,
    ): void {
      const keys = sessionKeys(view);
      const existing = keys
        .map((key) => find(key))
        .find((item) => item !== undefined);
      const deleted = action === "delete" && result.outcome === "succeeded";
      const before = signature();
      if (record === null || record === undefined) {
        if (existing !== undefined && action === "delete") {
          existing.deleted = deleted || existing.deleted;
          existing.view = view;
          existing.keys = [...new Set([...existing.keys, ...keys])];
        }
      } else {
        if (existing !== undefined) drop(existing);
        if (record.entries.length > 0) {
          const time = now();
          held.push({
            keys,
            view,
            action,
            actedAt: time,
            deleted,
            session: record.session,
            sessionGone: false,
            entries: record.entries.slice(0, MAX_ENTRIES),
            nextCheckAt: time + FIRST_CHECK_MS,
          });
        }
      }
      if (signature() !== before) options.onChange();
      schedule();
    },

    /** Whether a record is held for the session, and whether its own process has exited. */
    find(key: string): { view: SessionView; sessionGone: boolean } | undefined {
      const item = find(key);
      return item === undefined
        ? undefined
        : { view: item.view, sessionGone: item.sessionGone };
    },

    offers,
    check,

    /**
     * Ends the programs recorded for a session, after checking again that its own process has
     * exited. The caller has already applied the action rules (FR-27, NFR-13).
     */
    async end(key: string): Promise<ActionResult> {
      const item = find(key);
      if (item === undefined) {
        return {
          outcome: "refused",
          message: "No leftover programs are recorded for this session.",
        };
      }
      if (options.run === null) {
        return {
          outcome: "unavailable",
          message:
            "Ending programs needs Windows PowerShell, which isn't available here.",
        };
      }
      const before = signature();
      try {
        if (!(await checkItems([item]))) {
          return {
            outcome: "unknown",
            message: "Couldn't check the programs, so nothing was ended.",
          };
        }
        if (!item.sessionGone) {
          return {
            outcome: "refused",
            message:
              "The session is still running, so its programs aren't leftovers yet.",
          };
        }
        const entries = [...item.entries];
        if (!held.includes(item) || entries.length === 0) {
          return {
            outcome: "succeeded",
            message: "None of the programs were still running.",
          };
        }
        const outcome = await options.run("end-leftovers", {
          entries: entries
            .filter((entry) => entry.path !== "")
            .map(({ pid, startMs, path }) => ({ pid, startMs, path })),
        });
        if (outcome.kind === "timeout") {
          return {
            outcome: "unknown",
            message: "Couldn't confirm the result. The list updates shortly.",
          };
        }
        const result =
          outcome.kind === "ok" ? parseEndLeftovers(outcome.result) : null;
        if (result === null) {
          return {
            outcome: "failed",
            message: "The tool's helper couldn't end the programs.",
          };
        }
        const ended = new Set(result.ended);
        const reasons = new Map(
          result.skipped.map((skip) => [skip.pid, skip.reason]),
        );
        const notEnded = entries
          .filter((entry) => !ended.has(entry.pid))
          .map((entry) => {
            const reason =
              entry.path === ""
                ? "no-path"
                : (reasons.get(entry.pid) ?? "failed");
            return `${describe(entry)}: ${SKIP_REASONS[reason] ?? "it couldn't be ended"}`;
          });
        item.entries = item.entries.filter((entry) => !ended.has(entry.pid));
        if (item.entries.length === 0) drop(item);
        else item.nextCheckAt = now() + FIRST_CHECK_MS;
        const total = entries.length;
        const count = entries.filter((entry) => ended.has(entry.pid)).length;
        const summary = `Ended ${String(count)} of ${String(total)} ${total === 1 ? "program" : "programs"}.`;
        return notEnded.length === 0
          ? { outcome: "succeeded", message: summary }
          : {
              outcome: "failed",
              message: `${summary} Not ended: ${notEnded.join("; ")}.`,
            };
      } finally {
        if (signature() !== before) options.onChange();
        schedule();
      }
    },

    stop(): void {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

export type LeftoverTracker = ReturnType<typeof createLeftoverTracker>;
