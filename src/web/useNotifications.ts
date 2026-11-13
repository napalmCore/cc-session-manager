import { useCallback, useEffect, useRef, useState } from "react";
import {
  initialNotifyState,
  keepPending,
  nextEvents,
  notificationContent,
  pendingToShow,
  type NotificationContent,
  type NotifyState,
  type PendingNotification,
} from "../shared/notifications.js";
import type { Snapshot } from "../shared/protocol.js";

export type NotifyPermission = NotificationPermission | "unavailable";

const LOCK_NAME = "cc-session-manager-notifier";
/** The notifying tab says here which notifications it showed, so no other tab shows them. */
const SHOWN_CHANNEL = "cc-session-manager-shown";
/** How many shown tags a tab remembers. */
const SHOWN_LIMIT = 50;

function currentPermission(): NotifyPermission {
  return typeof Notification === "undefined"
    ? "unavailable"
    : Notification.permission;
}

/**
 * Shows desktop notifications for new events (FR-11 to FR-13, FR-21). Every tab tracks events,
 * so the comparison is ready if it takes over, but only the tab holding the lock shows them.
 */
export function useNotifications(
  snapshot: Snapshot | null,
  onClick: (keys: string[]) => void,
) {
  const [permission, setPermission] =
    useState<NotifyPermission>(currentPermission);
  const state = useRef<NotifyState>(initialNotifyState);
  // Without the Web Locks API, every tab notifies, and the shared tag keeps it to one alert.
  const leader = useRef(
    typeof navigator === "undefined" || !("locks" in navigator),
  );
  const clickHandler = useRef(onClick);
  useEffect(() => {
    clickHandler.current = onClick;
  }, [onClick]);
  // Notifications this tab didn't show because another tab was showing them (BUG-32).
  const pending = useRef<PendingNotification[]>([]);
  // Tags the notifying tab has shown, so this tab never shows them again (FR-13).
  const shownTags = useRef(new Set<string>());
  const channel = useRef<BroadcastChannel | null>(null);

  const remember = useCallback((tag: string) => {
    const tags = shownTags.current;
    tags.add(tag);
    if (tags.size > SHOWN_LIMIT) {
      const oldest = tags.values().next().value;
      if (oldest !== undefined) tags.delete(oldest);
    }
    pending.current = pending.current.filter(
      (item) => item.content.tag !== tag,
    );
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const shownChannel = new BroadcastChannel(SHOWN_CHANNEL);
    shownChannel.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data === "string") remember(event.data);
    };
    channel.current = shownChannel;
    return () => {
      channel.current = null;
      shownChannel.close();
    };
  }, [remember]);

  const show = useCallback(
    (content: NotificationContent) => {
      remember(content.tag);
      channel.current?.postMessage(content.tag);
      try {
        const notification = new Notification(content.title, {
          body: content.body,
          tag: content.tag,
        });
        notification.onclick = () => {
          window.focus();
          clickHandler.current(content.keys);
          notification.close();
        };
      } catch {
        // Some browsers only allow notifications from a service worker.
      }
    },
    [remember],
  );

  // Permission can change in another tab or in the browser's settings.
  useEffect(() => {
    const refresh = () => {
      setPermission(currentPermission());
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    let status: PermissionStatus | undefined;
    if ("permissions" in navigator) {
      navigator.permissions
        .query({ name: "notifications" })
        .then((result) => {
          status = result;
          status.onchange = refresh;
        })
        .catch(() => {
          // The focus and visibility checks still apply.
        });
    }
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      if (status !== undefined) status.onchange = null;
    };
  }, []);

  useEffect(() => {
    if (!("locks" in navigator)) return;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    navigator.locks
      .request(LOCK_NAME, { signal: controller.signal }, () => {
        leader.current = true;
        // Shows what arrived while the previous tab was closing, if it's still recent.
        const waiting = pendingToShow(pending.current, performance.now());
        pending.current = [];
        if (currentPermission() === "granted") waiting.forEach(show);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      })
      .catch(() => {
        // Aborted when the page closes before it got the lock.
      });
    return () => {
      leader.current = false;
      controller.abort();
      release?.();
    };
  }, [show]);

  useEffect(() => {
    if (snapshot === null) return;
    const result = nextEvents(state.current, snapshot, Date.now());
    state.current = result.state;
    // Events from before notifications were turned on are never sent later.
    if (currentPermission() !== "granted") return;
    const content = notificationContent(
      result.events,
      snapshot.seq,
      snapshot.runId,
    );
    if (!leader.current) {
      pending.current = keepPending(
        pending.current,
        content,
        performance.now(),
        shownTags.current,
      );
      return;
    }
    if (content !== null) show(content);
  }, [snapshot, show]);

  const request = useCallback(() => {
    if (typeof Notification === "undefined") return;
    void Notification.requestPermission().then(setPermission, () => {
      setPermission(currentPermission());
    });
  }, []);

  return { permission, request };
}
