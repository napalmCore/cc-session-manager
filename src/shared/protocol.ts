export interface Session {
  cwd?: string;
  kind?: string;
  startedAt?: number;
  id?: string;
  state?: string;
  pid?: number;
  status?: string;
  waitingFor?: string;
  sessionId?: string;
  name?: string;
}

export interface SessionView extends Session {
  needsAttention: boolean;
  attentionReason: string | null;
  finished: boolean;
  statusLabel: string;
  finishedAt?: number;
  gitBranch?: string;
  model?: string;
  lastActivityAt?: number;
}

export interface FinishedSession extends SessionView {
  finishedAt: number;
}

export interface Snapshot {
  sessions: SessionView[];
  error: string | null;
  warnings: string[];
  /** Why Stop, Delete, and End are turned off for every session, if they are (FR-22). */
  actionsBlocked?: string | null;
  /** Polls that have failed in a row since the last success, when any have. */
  failedPolls?: number;
  /** Increases with every snapshot the server sends, so a notification's tag is unique. */
  seq?: number;
  /** Differs on each start of the server, so notification tags stay unique across restarts. */
  runId?: string;
  /** Sessions acted on from the dashboard in the last 30 seconds, so their changes don't notify. */
  ownActions?: string[];
  /** Sessions that started or handed over to the tool, so Stop, Delete, and End aren't offered. */
  protectedSessions?: string[];
}

export interface SnapshotMessage {
  type: "snapshot";
  snapshot: Snapshot;
}
