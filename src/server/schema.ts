import { z } from "zod";
import type { Session } from "../shared/protocol.js";

/**
 * Field types and known values come from the `claude agents --json` documentation.
 * Only fields listed here are copied, so anything else in the output is dropped.
 */
const STRING_FIELDS = [
  "cwd",
  "kind",
  "id",
  "state",
  "status",
  "waitingFor",
  "sessionId",
  "name",
] as const;
const NUMBER_FIELDS = ["startedAt", "pid"] as const;
const ALWAYS_PRESENT = ["cwd", "kind", "startedAt"] as const;

const entrySchema = z.record(z.string(), z.unknown());
const stringSchema = z.string();
const numberSchema = z.number();
const kindSchema = z.enum(["interactive", "background"]);
const stateSchema = z.enum(["working", "blocked", "done", "failed", "stopped"]);
const statusSchema = z.enum(["busy", "waiting", "idle"]);

export interface ParsedSessions {
  sessions: Session[];
  warnings: string[];
  /** Identities of the sessions in this listing. */
  listed: Set<string>;
}

const missing = (field: string) =>
  `Claude Code did not report "${field}" for a session.`;
const unexpected = (field: string) =>
  `Claude Code reported an unexpected value for "${field}".`;

function parseEntry(
  source: Record<string, unknown>,
  warnings: Set<string>,
  listedBefore: Set<string>,
) {
  const session: Session = {};

  for (const field of STRING_FIELDS) {
    if (source[field] === undefined) continue;
    const result = stringSchema.safeParse(source[field]);
    if (result.success) session[field] = result.data;
    else warnings.add(unexpected(field));
  }
  for (const field of NUMBER_FIELDS) {
    if (source[field] === undefined) continue;
    const result = numberSchema.safeParse(source[field]);
    if (result.success) session[field] = result.data;
    else warnings.add(unexpected(field));
  }

  const known: [string, string | undefined, z.ZodType][] = [
    ["kind", session.kind, kindSchema],
    ["state", session.state, stateSchema],
    ["status", session.status, statusSchema],
  ];
  for (const [field, value, schema] of known) {
    if (value !== undefined && !schema.safeParse(value).success) {
      warnings.add(unexpected(field));
    }
  }

  for (const field of ALWAYS_PRESENT) {
    if (source[field] === undefined) warnings.add(missing(field));
  }
  if (session.kind === "background" && source.state === undefined) {
    warnings.add(missing("state"));
  }
  // The CLI's first listing of a new interactive session may not have a status yet.
  const identity = session.sessionId ?? session.id;
  const firstListing = identity !== undefined && !listedBefore.has(identity);
  if (
    session.kind === "interactive" &&
    source.status === undefined &&
    !firstListing
  ) {
    warnings.add(missing("status"));
  }
  if (session.status === "waiting" && source.waitingFor === undefined) {
    warnings.add(missing("waitingFor"));
  }

  return session;
}

/** Throws when the output as a whole is unusable. Problems within entries become warnings. */
export function parseSessions(
  output: string,
  listedBefore: Set<string> = new Set(),
): ParsedSessions {
  const parsed = z.array(z.unknown()).parse(JSON.parse(output));
  const warnings = new Set<string>();
  const sessions: Session[] = [];

  for (const entry of parsed) {
    const result = entrySchema.safeParse(entry);
    if (result.success) {
      sessions.push(parseEntry(result.data, warnings, listedBefore));
    } else {
      warnings.add("Claude Code reported a session in an unexpected format.");
    }
  }

  const listed = new Set(
    sessions.flatMap((session) => session.sessionId ?? session.id ?? []),
  );
  return { sessions, warnings: [...warnings], listed };
}
