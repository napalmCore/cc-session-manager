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
}

export interface SnapshotMessage {
  type: "snapshot";
  snapshot: Snapshot;
}
