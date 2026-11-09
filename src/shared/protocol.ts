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

/** Token counts for one group of a session's model responses (FR-23). */
export interface UsageCounts {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  webSearches: number;
}

/** Responses that share a model, speed, routing, and source, which price the same (FR-24). */
export interface UsageGroup extends UsageCounts {
  model: string;
  speed: string;
  geo: string;
  source: "main" | "subagent";
  /** Claude Haiku 5.5 prompts over 100,000 tokens, which cost more. */
  longContext: boolean;
}

export interface SessionUsage {
  groups: UsageGroup[];
  /** True until every transcript of the session has been read to its end. */
  counting: boolean;
  /** True when reading stopped before the end, because the transcript couldn't be read. */
  partial?: boolean;
  /** The estimated cost in US dollars of every group that could be priced (FR-24). */
  cost: number;
  /** Models whose usage couldn't be priced, so the cost leaves them out. */
  unpriced: string[];
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
  usage?: SessionUsage;
  /** The first start time seen, which stays put when Claude Code's changes (BUG-23). */
  firstStartedAt?: number;
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
  /** Finished sessions whose folder no longer exists, so Resume isn't offered. */
  missingFolders?: string[];
}

export interface SnapshotMessage {
  type: "snapshot";
  snapshot: Snapshot;
}
