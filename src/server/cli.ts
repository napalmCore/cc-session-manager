#!/usr/bin/env node
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { DEFAULT_PORT, POLL_INTERVAL_MS } from "../shared/constants.js";
import { createPoller, runClaudeAgents } from "./poller.js";
import { startServer } from "./server.js";

function browserCommand(url: string): [string, string[]] {
  if (process.platform === "win32")
    return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  if (process.platform === "darwin") return ["open", [url]];
  return ["xdg-open", [url]];
}

const server = await startServer({ preferredPort: DEFAULT_PORT });
const poller = createPoller({
  run: runClaudeAgents,
  intervalMs: POLL_INTERVAL_MS,
  onSnapshot: server.publish,
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
