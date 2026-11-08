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

export interface ActionResultView {
  action: SessionAction;
  reply: ActionReply;
  /** How the session was named when the action ran, for when its row has gone. */
  label: string;
}

/** Where focus goes once an action or its dialog is done (NFR-8). */
export interface FocusTarget {
  key: string;
  action: SessionAction;
  groupId: string;
}

async function post(action: SessionAction, key: string): Promise<ActionReply> {
  let response: Response;
  try {
    response = await fetch("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
export function restoreFocus(target: FocusTarget | null): void {
  if (target === null) return;
  requestAnimationFrame(() => {
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
  });
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
    // A click anywhere means the user has moved on, so a later refresh never pulls focus back.
    const forget = () => {
      lastTarget.current = null;
    };
    document.addEventListener("pointerdown", forget, true);
    return () => {
      document.removeEventListener("pointerdown", forget, true);
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
      if (action === "end") setOffer(key, reply.outcome === "not-closed");
      if (action === "forceEnd" && reply.outcome !== "refused") {
        setOffer(key, false);
      }
      announce(`${ACTION_LABELS[action]}, ${label}: ${reply.message}`);
      restoreFocus(lastTarget.current);
    },
    [announce, setOffer],
  );

  return { run, pending, results, lastResult, forceOffers, lastTarget };
}
