#!/usr/bin/env node
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { DEFAULT_PORT, POLL_INTERVAL_MS } from "../shared/constants.js";
import { createActionTracker } from "./actions.js";
import { createPoller, runClaudeAgents } from "./poller.js";
import { resolvePrograms } from "./programs.js";
import { toSessionView } from "./rules.js";
import { parseSessions } from "./schema.js";
import { startServer } from "./server.js";
import { createFileStore } from "./store.js";
import { createSessionTracker } from "./tracker.js";
import { createMetadataReader } from "./transcripts.js";

function browserCommand(url: string): [string, string[]] {
  if (process.platform === "win32")
    return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  if (process.platform === "darwin") return ["open", [url]];
  return ["xdg-open", [url]];
}

// The tracker needs the poller, which needs the server, so the server reads the tracker through
// this holder once it exists.
const actionsRef: { current?: ReturnType<typeof createActionTracker> } = {};
const server = await startServer({
  preferredPort: DEFAULT_PORT,
  onAction: (request) =>
    actionsRef.current === undefined
      ? Promise.resolve({ outcome: "unavailable", message: "Not ready yet." })
      : actionsRef.current.handle(request),
});
const tracker = createSessionTracker({ store: createFileStore() });
const programs = resolvePrograms();
if (programs.claude === null) {
  console.log(
    "Couldn't find claude.exe, so session actions will be unavailable. Monitoring still works.",
  );
}
const poller = createPoller({
  run: () => runClaudeAgents(programs.claude),
  intervalMs: POLL_INTERVAL_MS,
  onSnapshot: server.publish,
  track: tracker.update,
  enrich: createMetadataReader().enrich,
});
// Executors for each action arrive in later build steps, so for now every action is unavailable.
actionsRef.current = createActionTracker({
  listing: () => poller.state(),
  freshListing: async () =>
    parseSessions(await runClaudeAgents(programs.claude)).sessions.map(
      toSessionView,
    ),
  executors: {},
  isProtected: () => false,
});
poller.start();

console.log(
  `cc-session-manager is running at http://${server.address}:${String(server.port)}`,
);
console.log("Press Ctrl+C to stop.");

const [command, args] = browserCommand(server.loginUrl);
execFile(command, args, { cwd: homedir(), windowsHide: true }, (error) => {
  if (error) {
    console.log(
      `Could not open a browser. Open this one-time link: ${server.loginUrl}`,
    );
  }
});

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  poller.stop();
  void server.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
