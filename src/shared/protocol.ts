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

export interface Snapshot {
  sessions: Session[];
  error: string | null;
}

export interface SnapshotMessage {
  type: "snapshot";
  snapshot: Snapshot;
}
