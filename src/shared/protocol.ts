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
}

export interface Snapshot {
  sessions: SessionView[];
  error: string | null;
  warnings: string[];
}

export interface SnapshotMessage {
  type: "snapshot";
  snapshot: Snapshot;
}
