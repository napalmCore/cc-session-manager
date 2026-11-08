#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { DEFAULT_PORT, POLL_INTERVAL_MS } from "../shared/constants.js";
import { sessionKeys } from "../shared/notifications.js";
import { createActionTracker, FRESHNESS_MS } from "./actions.js";
import {
  CLOSE_WAIT_MS,
  createEndExecutors,
  createHelperRunner,
  helperAvailable,
  helperScriptPath,
} from "./end.js";
import {
  createLock,
  type InstanceLock,
  lockExists,
  newHandoverSecret,
  processAlive,
  readLock,
  removeLock,
  removeStaleLock,
  requestHandover,
} from "./instance.js";
import { createOpenExecutors } from "./open.js";
import {
  createStopDeleteExecutors,
  runClaude,
  watchPoller,
} from "./stop-delete.js";
import { createPoller, runClaudeAgents } from "./poller.js";
import { resolvePrograms } from "./programs.js";
import {
  createProtection,
  PROTECTED_MESSAGE,
  processStartMs,
  readIdentity,
} from "./protect.js";
import { toSessionView } from "./rules.js";
import { parseSessions } from "./schema.js";
import { startServer } from "./server.js";
import { createFileStore, dataDirectory } from "./store.js";
import type { Snapshot } from "../shared/protocol.js";
import { createSessionTracker } from "./tracker.js";
import { createMetadataReader, transcriptExists } from "./transcripts.js";

function browserCommand(url: string): [string, string[]] {
  if (process.platform === "win32")
    return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  if (process.platform === "darwin") return ["open", [url]];
  return ["xdg-open", [url]];
}

/**
 * Starts the browser detached, because Windows ends a process's attached children, and what
 * they start, when it exits. It settles once the command has finished, so a start that exits
 * straight after still reports a failure.
 */
function openBrowser(url: string): Promise<void> {
  const [command, args] = browserCommand(url);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (failed: boolean) => {
      if (settled) return;
      settled = true;
      if (failed) {
        console.log(
          `Could not open a browser. Open this one-time link: ${url}`,
        );
      }
      resolve();
    };
    try {
      const child = spawn(command, args, {
        cwd: homedir(),
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", () => {
        finish(true);
      });
      child.once("exit", (code) => {
        finish(code !== 0);
      });
    } catch {
      finish(true);
    }
  });
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const programs = resolvePrograms();
const dataFolder = dataDirectory();

// The session this start came from, if any, so it's protected from Stop, Delete, and End (FR-22).
const identity = readIdentity(process.env);
if (identity.pid !== undefined) {
  const startMs = await processStartMs(programs.powershell, identity.pid);
  if (startMs !== null) identity.pidStartMs = startMs;
}

// A second start hands over to the running instance, so the port stays the same (U-15).
// It tries twice, a second apart, so a lock that's still being written, or an instance that's
// busy, isn't taken for a stale one.
const handOver = async (): Promise<boolean> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await pause(1_000);
    const existing = readLock(dataFolder);
    if (existing === null) {
      if (!lockExists(dataFolder)) return false;
      continue;
    }
    // A dead instance's port could be anyone's now, so don't ask it for anything.
    if (!processAlive(existing.pid)) return false;
    const link = await requestHandover(existing, identity);
    if (link !== null) {
      console.log(
        `cc-session-manager is already running at http://127.0.0.1:${String(existing.port)}`,
      );
      await openBrowser(link);
      return true;
    }
    if (!processAlive(existing.pid)) return false;
  }
  return false;
};
if (await handOver()) process.exit(0);
removeStaleLock(dataFolder);

const protection = createProtection([identity]);
let lastSnapshot: Snapshot | null = null;
let sequence = 0;
const runId = randomBytes(4).toString("hex");
const publish = (snapshot: Snapshot) => {
  lastSnapshot = snapshot;
  sequence += 1;
  serverRef.current?.publish({
    ...snapshot,
    actionsBlocked: protection.blockedReason(),
    seq: sequence,
    runId,
    ownActions: actionsRef.current?.ownActionSessions() ?? [],
    protectedSessions: snapshot.sessions
      .filter(
        (session) => protection.isProtected(session) === PROTECTED_MESSAGE,
      )
      .flatMap(sessionKeys),
  });
};

// The tracker needs the poller, which needs the server, so the server reads the tracker through
// this holder once it exists.
const actionsRef: { current?: ReturnType<typeof createActionTracker> } = {};
const serverRef: { current?: Awaited<ReturnType<typeof startServer>> } = {};
const handoverSecret = newHandoverSecret();
const server = await startServer({
  preferredPort: DEFAULT_PORT,
  onAction: (request) =>
    actionsRef.current === undefined
      ? Promise.resolve({ outcome: "unavailable", message: "Not ready yet." })
      : actionsRef.current.handle(request),
  handover: {
    secret: handoverSecret,
    onHandover: (handed) => {
      protection.add(handed);
      if (lastSnapshot !== null) publish(lastSnapshot);
    },
  },
});
serverRef.current = server;

const lock: InstanceLock = {
  version: 1,
  pid: process.pid,
  port: server.port,
  secret: handoverSecret,
};
let locked = false;
try {
  locked = createLock(dataFolder, lock);
  if (!locked) {
    // Another start won the race while this one was starting.
    if (await handOver()) {
      await server.close();
      process.exit(0);
    }
    removeStaleLock(dataFolder);
    locked = createLock(dataFolder, lock);
  }
} catch {
  locked = false;
}
if (!locked) {
  console.log(
    "Couldn't create the instance lock, so a second start will open its own dashboard.",
  );
}

const tracker = createSessionTracker({ store: createFileStore() });
if (programs.claude === null) {
  console.log(
    "Couldn't find claude.exe, so session actions will be unavailable. Monitoring still works.",
  );
}
const poller = createPoller({
  run: () => runClaudeAgents(programs.claude),
  intervalMs: POLL_INTERVAL_MS,
  onSnapshot: publish,
  track: (current) => {
    // The poller only publishes when the sessions change, so a change in whether actions are
    // turned off, such as a handed-over session being found, is published here.
    if (protection.observe(current) && lastSnapshot !== null) {
      publish(lastSnapshot);
    }
    return tracker.update(current);
  },
  enrich: createMetadataReader().enrich,
});
const openExecutors = createOpenExecutors({
  programs,
  folderExists: (folder) => {
    try {
      return existsSync(folder) && statSync(folder).isDirectory();
    } catch {
      return false;
    }
  },
  transcriptExists: (sessionId) => transcriptExists(sessionId),
  homeFolder: homedir(),
});
const claudeExe = programs.claude;
const stopDelete = createStopDeleteExecutors({
  claudeAvailable: claudeExe !== null,
  run: (args) =>
    claudeExe === null
      ? Promise.resolve({ kind: "error" as const })
      : runClaude(claudeExe, args),
  watch: watchPoller(() => poller.state()),
});
const helperScript = helperScriptPath();
const powershell = programs.powershell;
const endExecutors = createEndExecutors({
  helperAvailable: helperAvailable(powershell, helperScript),
  run:
    powershell === null
      ? () => Promise.resolve({ kind: "error" as const })
      : createHelperRunner(powershell, helperScript),
  watch: watchPoller(() => poller.state(), CLOSE_WAIT_MS),
  confirmListing: async () => {
    try {
      return parseSessions(
        await runClaudeAgents(programs.claude, FRESHNESS_MS),
      ).sessions.map(toSessionView);
    } catch {
      return null;
    }
  },
});
actionsRef.current = createActionTracker({
  listing: () => poller.state(),
  freshListing: async () =>
    parseSessions(
      await runClaudeAgents(programs.claude, FRESHNESS_MS),
    ).sessions.map(toSessionView),
  executors: {
    open: (session) => openExecutors.open(session),
    resume: (session) => openExecutors.resume(session),
    stop: (session) => stopDelete.stop(session),
    delete: (session) => stopDelete.delete(session),
    end: (session) => endExecutors.end(session),
    forceEnd: (session, record) => endExecutors.forceEnd(session, record),
  },
  isProtected: (session) => protection.isProtected(session),
});
poller.start();

console.log(
  `cc-session-manager is running at http://${server.address}:${String(server.port)}`,
);
console.log("Press Ctrl+C to stop.");

void openBrowser(server.loginUrl);

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  poller.stop();
  if (locked) removeLock(dataFolder, lock);
  void server.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
