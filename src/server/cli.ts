#!/usr/bin/env node
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
import {
  HANDOVER_LINK_NOTE,
  openBrowser,
  PRINTED_LINK_NOTE,
} from "./browser.js";
import { createFolderWatch } from "./folders.js";
import { createLeftoverTracker } from "./leftovers.js";
import { createInputRunner, parseRecord } from "./leftovers-helper.js";
import {
  cachedLocalDrives,
  createFolderPicker,
  powershellLocalDrives,
} from "./folder-picker.js";
import { createHistory } from "./history.js";
import { createSearch } from "./search.js";
import {
  cachedDriveType,
  checkLocalFolder,
  powershellDriveType,
} from "./local-folder.js";
import { createOpenExecutors, launchDetached } from "./open.js";
import { createLauncher, FAILURE_WATCH_MS } from "./start.js";
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
import { PRINTED_LINK_MS, startServer } from "./server.js";
import { createFileStore, dataDirectory } from "./store.js";
import type { Snapshot } from "../shared/protocol.js";
import { createSessionTracker, enrichWithFinished } from "./tracker.js";
import { createTranscriptReader, transcriptExists } from "./transcripts.js";

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
      await openBrowser(link, { note: HANDOVER_LINK_NOTE });
      return true;
    }
    if (!processAlive(existing.pid)) return false;
  }
  return false;
};
if (await handOver()) process.exit(0);
removeStaleLock(dataFolder);

function folderExists(folder: string): boolean {
  try {
    return existsSync(folder) && statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

const protection = createProtection([identity]);
let lastSnapshot: Snapshot | null = null;
let sequence = 0;
const runId = randomBytes(4).toString("hex");
// A deleted folder doesn't change the sessions, so the watch resends the snapshot itself.
const folderWatch = createFolderWatch({
  onChange: () => {
    if (lastSnapshot !== null) publish(lastSnapshot);
  },
});
const publish = (snapshot: Snapshot) => {
  lastSnapshot = snapshot;
  const missing = folderWatch.missing(snapshot.sessions);
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
    missingFolders: missing,
    leftovers: leftoversRef.current?.offers() ?? [],
  });
};

// The tracker needs the poller, which needs the server, so the server reads the tracker through
// this holder once it exists.
const actionsRef: { current?: ReturnType<typeof createActionTracker> } = {};
const leftoversRef: { current?: ReturnType<typeof createLeftoverTracker> } = {};
const serverRef: { current?: Awaited<ReturnType<typeof startServer>> } = {};
const handoverSecret = newHandoverSecret();
// History reads with a reader of its own, so live sessions keep their budget (NFR-15).
const historyReader = createTranscriptReader();
const history = createHistory({
  read: (sessions) => historyReader.enrich(sessions),
  // The drive type is checked before the folder is touched, so network folders never are.
  canUse: async (folder) => (await checkLocalFolder(folder, driveType)).ok,
});
// Search reads History's list of transcripts, only while a search runs (FR-36, C-16).
const search = createSearch({
  files: () => history.files(),
  describe: (ids) => history.describe(ids, poller.state().sessions),
});
const server = await startServer({
  preferredPort: DEFAULT_PORT,
  search,
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
    const tracked = tracker.update(current);
    // Starts any due folder checks, even when nothing else changes.
    folderWatch.missing(tracked.sessions);
    return tracked;
  },
  enrich: enrichWithFinished(tracker, createTranscriptReader()),
  onPoll: (state) => {
    serverRef.current?.heartbeat(state.lastSuccessAt);
  },
});
const openExecutors = createOpenExecutors({
  programs,
  folderExists,
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
const canRunHelper = helperAvailable(powershell, helperScript);
const runHelper =
  powershell === null
    ? () => Promise.resolve({ kind: "error" as const })
    : createHelperRunner(powershell, helperScript);
const leftovers = createLeftoverTracker({
  run:
    powershell === null || !canRunHelper
      ? null
      : createInputRunner(powershell, helperScript),
  onChange: () => {
    if (lastSnapshot !== null) publish(lastSnapshot);
  },
});
leftoversRef.current = leftovers;
const endExecutors = createEndExecutors({
  helperAvailable: canRunHelper,
  run: runHelper,
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
// One drive-type cache for Start, Fork, and Browse.
const driveType = cachedDriveType(powershellDriveType(programs.powershell));
const launcher = createLauncher({
  programs,
  driveType,
  launch: launchDetached,
  watch: watchPoller(() => poller.state(), FAILURE_WATCH_MS),
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
  history: (page, listing) => history.page(page, listing),
  listFolders: createFolderPicker({
    driveType,
    localDrives: cachedLocalDrives(powershellLocalDrives(programs.powershell)),
  }),
  start: (request) => launcher.start(request),
  fork: (request, target) => launcher.fork(request, target),
  // A past session's folder, only if it's still a local folder that can be used (FR-33, FR-35).
  historyFolder: async (sessionId) => {
    const entry = await history.find(sessionId);
    if (entry?.folder === null || entry?.folder === undefined) return null;
    const checked = await checkLocalFolder(entry.folder, driveType);
    // The recorded folder, once its resolved path passes the checks, so Resume runs where the
    // session was saved.
    return checked.ok ? entry.folder : null;
  },
  transcriptExists: (sessionId) => transcriptExists(sessionId),
  lastActivity: async (sessionId) =>
    (await history.find(sessionId))?.lastActivityAt ?? null,
  leftovers: {
    // Stop and Delete record the session's programs first, with the same ownership check End
    // uses. A session with no process, such as a stopped one, has nothing new to record.
    record: async (session) => {
      const { pid, startedAt } = session;
      if (pid === undefined) return undefined;
      // A process with no start time can't pass the ownership check, so it can't be recorded.
      if (startedAt === undefined) return null;
      if (!canRunHelper) return null;
      const outcome = await runHelper({
        action: "record",
        pid,
        startedAtMs: startedAt,
        toolPid: process.pid,
      });
      if (outcome.kind !== "ok" || outcome.result.ok !== true) return null;
      return parseRecord(outcome.result.record);
    },
    hold: (session, action, record, result) => {
      leftovers.hold(session, action, record, result);
    },
    find: (key) => leftovers.find(key),
    end: (key) => leftovers.end(key),
  },
});
poller.start();

console.log(
  `cc-session-manager is running at http://${server.address}:${String(server.port)}`,
);
console.log("Press Ctrl+C to stop.");

void openBrowser(server.loginUrl, {
  note: PRINTED_LINK_NOTE,
  beforePrint: () => {
    server.limitLoginLink(PRINTED_LINK_MS);
  },
});

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  poller.stop();
  leftovers.stop();
  if (locked) removeLock(dataFolder, lock);
  void server.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
