import { useCallback, useEffect, useRef, useState } from "react";
import {
  initialNotifyState,
  nextEvents,
  notificationContent,
  type NotifyState,
} from "../shared/notifications.js";
import type { Snapshot } from "../shared/protocol.js";

export type NotifyPermission = NotificationPermission | "unavailable";

const LOCK_NAME = "cc-session-manager-notifier";

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
  }, []);

  useEffect(() => {
    if (snapshot === null) return;
    const result = nextEvents(state.current, snapshot, Date.now());
    state.current = result.state;
    // Events from before notifications were turned on are never sent later.
    if (!leader.current || currentPermission() !== "granted") return;
    const content = notificationContent(
      result.events,
      snapshot.seq,
      snapshot.runId,
    );
    if (content === null) return;
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
  }, [snapshot]);

  const request = useCallback(() => {
    if (typeof Notification === "undefined") return;
    void Notification.requestPermission().then(setPermission, () => {
      setPermission(currentPermission());
    });
  }, []);

  return { permission, request };
}
