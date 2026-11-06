import { useEffect, useState } from "react";
import type { Snapshot, SnapshotMessage } from "../shared/protocol.js";

const RECONNECT_MS = 2000;

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retry: number | undefined;
    let disposed = false;

    const connect = () => {
      socket = new WebSocket(`ws://${location.host}/ws`);
      socket.onopen = () => {
        setConnected(true);
      };
      socket.onmessage = (event: MessageEvent<string>) => {
        const message = JSON.parse(event.data) as SnapshotMessage;
        setSnapshot(message.snapshot);
      };
      socket.onclose = () => {
        setConnected(false);
        if (!disposed) retry = window.setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();

    return () => {
      disposed = true;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, []);

  return (
    <main>
      <h1>Claude Code sessions</h1>
      {!connected && <p role="status">Not connected to the local server.</p>}
      {snapshot?.error && <p role="alert">{snapshot.error}</p>}
      {snapshot && (
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Project</th>
              <th scope="col">Kind</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.sessions.map((session, index) => (
              <tr key={session.sessionId ?? session.id ?? index}>
                <td>{session.name ?? "Unnamed"}</td>
                <td>{session.cwd ?? "Unknown"}</td>
                <td>{session.kind ?? "Unknown"}</td>
                <td>{session.status ?? session.state ?? "Unknown"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
