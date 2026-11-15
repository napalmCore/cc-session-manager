import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionView } from "../shared/protocol.js";
import {
  ACTION_LABELS,
  actionKey,
  FORCE_END_OFFER_MS,
  readReply,
  UNREACHABLE,
  type ActionReply,
  type SessionAction,
} from "../shared/session-actions.js";
import { readPageKey } from "./pageKey.js";

export interface ActionResultView {
  action: SessionAction;
  reply: ActionReply;
  /** How the session was named when the action ran, for when its row has gone. */
  label: string;
}

/** Where focus goes once an action or its dialog is done (NFR-8). */
export interface FocusTarget {
  key: string;
  /** The button to return to; Send and Fork are row buttons too. */
  action: SessionAction | "send" | "fork";
  groupId: string;
}

/** When focus is checked again after an action or a dialog closing. */
const FOCUS_RECHECK_MS = 50;

async function post(action: SessionAction, key: string): Promise<ActionReply> {
  let response: Response;
  try {
    response = await fetch("/api/actions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CCSM-Key": readPageKey() ?? "",
      },
      body: JSON.stringify({ action, key }),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return UNREACHABLE;
  }
  try {
    return readReply(await response.json());
  } catch {
    return readReply(null);
  }
}

/**
 * Moves focus back to the button that started an action, or its row, or its group's heading if
 * the row has gone, but only when focus was lost, so it never pulls focus from somewhere the
 * user moved it.
 */
// Counts focus moves, so a delayed check stands down once focus has gone anywhere.
let focusMoves = 0;
if (typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    () => {
      focusMoves += 1;
    },
    true,
  );
}

export function restoreFocus(target: FocusTarget | null): void {
  if (target === null) return;
  const movesAtStart = focusMoves;
  const attempt = () => {
    if (focusMoves !== movesAtStart) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const row = document.querySelector<HTMLElement>(
      `[data-session-key="${CSS.escape(target.key)}"]`,
    );
    const button =
      row?.querySelector<HTMLElement>(`[data-action="${target.action}"]`) ??
      row?.querySelector<HTMLElement>("[data-action]");
    const next =
      button ??
      row ??
      document.getElementById(target.groupId) ??
      document.querySelector<HTMLElement>("h1");
    next?.focus();
  };
  // React Aria restores focus from a closing dialog on its own schedule, and can leave it on the
  // page body when its button has gone, so this checks again shortly after.
  requestAnimationFrame(attempt);
  window.setTimeout(attempt, FOCUS_RECHECK_MS);
}

export function useSessionActions(announce: (message: string) => void) {
  const [pending, setPending] = useState<ReadonlyMap<string, SessionAction>>(
    () => new Map(),
  );
  const [results, setResults] = useState<ReadonlyMap<string, ActionResultView>>(
    () => new Map(),
  );
  const [lastResult, setLastResult] = useState<
    (ActionResultView & { key: string }) | null
  >(null);
  const [forceOffers, setForceOffers] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const timers = useRef(new Map<string, number>());
  const lastTarget = useRef<FocusTarget | null>(null);

  useEffect(() => {
    const pendingTimers = timers.current;
    // A click anywhere, or focus moving outside the row, means the user has moved on, so a
    // later refresh never pulls focus back.
    const forget = () => {
      lastTarget.current = null;
    };
    const focusMoved = (event: FocusEvent) => {
      const target = lastTarget.current;
      if (target === null || !(event.target instanceof Element)) return;
      const row = event.target.closest("[data-session-key]");
      if (row?.getAttribute("data-session-key") !== target.key) forget();
    };
    document.addEventListener("pointerdown", forget, true);
    document.addEventListener("focusin", focusMoved, true);
    return () => {
      document.removeEventListener("pointerdown", forget, true);
      document.removeEventListener("focusin", focusMoved, true);
      for (const timer of pendingTimers.values()) window.clearTimeout(timer);
    };
  }, []);

  const setOffer = useCallback((key: string, offered: boolean) => {
    window.clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    setForceOffers((current) => {
      const next = new Set(current);
      if (offered) next.add(key);
      else next.delete(key);
      return next;
    });
    if (offered) {
      // The server only accepts Force end for a while after End, so the offer goes with it.
      timers.current.set(
        key,
        window.setTimeout(() => {
          setOffer(key, false);
        }, FORCE_END_OFFER_MS),
      );
    }
  }, []);

  const run = useCallback(
    async (
      session: SessionView,
      action: SessionAction,
      label: string,
      groupId: string,
    ) => {
      const key = actionKey(session);
      if (key === undefined) return;
      lastTarget.current = { key, action, groupId };
      setPending((current) => new Map(current).set(key, action));
      const reply = await post(action, key);
      setPending((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
      const result = { action, reply, label };
      setResults((current) => new Map(current).set(key, result));
      setLastResult({ ...result, key });
      // A refused or unknown attempt leaves an earlier Force end offer alone, since the server
      // may still accept it.
      const settled =
        reply.outcome !== "refused" && reply.outcome !== "unknown";
      if (action === "end" && settled) {
        setOffer(key, reply.outcome === "not-closed");
      }
      if (action === "forceEnd" && settled) setOffer(key, false);
      announce(`${ACTION_LABELS[action]}, ${label}: ${reply.message}`);
      restoreFocus(lastTarget.current);
    },
    [announce, setOffer],
  );

  return { run, pending, results, lastResult, forceOffers, lastTarget };
}
