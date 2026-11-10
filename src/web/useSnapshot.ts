import { useEffect, useState } from "react";
import type { ServerMessage, Snapshot } from "../shared/protocol.js";
import { readPageKey } from "./pageKey.js";

const RECONNECT_MS = 2000;

/** When the latest successful poll started, on this page's clock (BUG-9). */
export interface Freshness {
  lastSuccessAt: number | null;
}

export function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(true);
  const [freshness, setFreshness] = useState<Freshness | null>(null);
  const [pageKey] = useState(readPageKey);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retry: number | undefined;
    let disposed = false;

    if (pageKey === null) return;
    const connect = () => {
      // The server picks the first protocol, so the key is never echoed back.
      socket = new WebSocket(`ws://${location.host}/ws`, [
        "ccsm",
        `ccsm-key-${pageKey}`,
      ]);
      socket.onopen = () => {
        setConnected(true);
      };
      socket.onmessage = (event: MessageEvent<string>) => {
        const message = JSON.parse(event.data) as ServerMessage;
        if (message.type === "heartbeat") {
          const age = message.lastSuccessAgeMs;
          setFreshness({
            lastSuccessAt: age === null ? null : Date.now() - age,
          });
          return;
        }
        setSnapshot(message.snapshot);
      };
      socket.onclose = () => {
        if (disposed) return;
        setConnected(false);
        setFreshness(null);
        retry = window.setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();

    return () => {
      disposed = true;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, [pageKey]);

  return { snapshot, connected, freshness, signedIn: pageKey !== null };
}
