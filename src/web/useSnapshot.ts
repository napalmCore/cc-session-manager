import { useEffect, useState } from "react";
import type { Snapshot, SnapshotMessage } from "../shared/protocol.js";
import { readPageKey } from "./pageKey.js";

const RECONNECT_MS = 2000;

export function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(true);
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
        const message = JSON.parse(event.data) as SnapshotMessage;
        setSnapshot(message.snapshot);
      };
      socket.onclose = () => {
        if (disposed) return;
        setConnected(false);
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

  return { snapshot, connected, signedIn: pageKey !== null };
}
