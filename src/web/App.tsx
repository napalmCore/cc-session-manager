import { useEffect, useState } from "react";
import { formatDuration } from "../shared/format.js";
import type { Snapshot, SnapshotMessage } from "../shared/protocol.js";

const RECONNECT_MS = 2000;
const CLOCK_MS = 30_000;

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const clock = window.setInterval(() => {
      setNow(Date.now());
    }, CLOCK_MS);
    return () => {
      window.clearInterval(clock);
    };
  }, []);

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
      {snapshot && snapshot.warnings.length > 0 && (
        <div role="status">
          <p>
            Claude Code&apos;s output has changed, so some details may be
            missing or inaccurate.
          </p>
          <ul>
            {snapshot.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      {snapshot && (
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Project</th>
              <th scope="col">Kind</th>
              <th scope="col">Status</th>
              <th scope="col">Needs you</th>
              <th scope="col">Branch</th>
              <th scope="col">Model</th>
              <th scope="col">Last activity</th>
              <th scope="col">Started</th>
              <th scope="col">Ran for</th>
              <th scope="col">Ended (approximate)</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.sessions.map((session, index) => (
              <tr key={session.sessionId ?? session.id ?? index}>
                <td>{session.name ?? "Unnamed"}</td>
                <td>{session.cwd ?? "Unknown"}</td>
                <td>{session.kind ?? "Unknown"}</td>
                <td>{session.finished ? "Finished" : session.statusLabel}</td>
                <td>{session.attentionReason ?? ""}</td>
                <td>{session.gitBranch ?? "Unavailable"}</td>
                <td>{session.model ?? "Unavailable"}</td>
                <td>
                  {session.lastActivityAt === undefined
                    ? "Unavailable"
                    : new Date(session.lastActivityAt).toLocaleString()}
                </td>
                <td>
                  {session.startedAt === undefined
                    ? "Unknown"
                    : new Date(session.startedAt).toLocaleString()}
                </td>
                <td>
                  {session.startedAt === undefined ||
                  (session.finished && session.finishedAt === undefined)
                    ? ""
                    : formatDuration(
                        (session.finishedAt ?? now) - session.startedAt,
                      )}
                </td>
                <td>
                  {session.finishedAt === undefined
                    ? ""
                    : new Date(session.finishedAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
