import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import type { Identity } from "./protect.js";

const FILE_NAME = "instance.json";
const HANDOVER_TIMEOUT_MS = 5_000;
const MAX_RESPONSE = 4096;

const lockSchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  secret: z.string().regex(/^[0-9a-f]{64}$/),
});
export type InstanceLock = z.infer<typeof lockSchema>;

const HEX_64 = /^[0-9a-f]{64}$/;

const handoverResponseSchema = z.object({
  loginUrl: z
    .string()
    .regex(/^http:\/\/127\.0\.0\.1:\d{1,5}\/auth\?token=[0-9a-f]{64}$/),
  proof: z.string().regex(HEX_64),
});

/**
 * Each side of a handover proves it knows the lock's secret without sending it, so a program
 * answering on a stale lock's port learns nothing and can't pass itself off as the tool.
 */
export function handoverProof(
  secret: string,
  side: "client" | "server",
  nonce: string,
): string {
  return createHmac("sha256", secret).update(`${side}:${nonce}`).digest("hex");
}

export function proofMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newHandoverSecret(): string {
  return randomBytes(32).toString("hex");
}

export function lockPath(directory: string): string {
  return join(directory, FILE_NAME);
}

/** The running instance's lock, or null if there's none or it can't be read. */
export function readLock(directory: string): InstanceLock | null {
  try {
    const parsed = lockSchema.safeParse(
      JSON.parse(readFileSync(lockPath(directory), "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Creates the lock with exclusive creation, so two starts can't both win. Returns false if
 * another instance's lock is already there.
 */
export function createLock(directory: string, lock: InstanceLock): boolean {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(lockPath(directory), JSON.stringify(lock), {
      flag: "wx",
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Removes a lock, but only if it's still this one. */
export function removeLock(directory: string, lock: InstanceLock): void {
  const current = readLock(directory);
  if (current?.secret === lock.secret && current.pid === lock.pid) {
    rmSync(lockPath(directory), { force: true });
  }
}

export function lockExists(directory: string): boolean {
  return existsSync(lockPath(directory));
}

/** Whether a process with this ID is running. Access denied still means it's running. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function removeStaleLock(directory: string): void {
  rmSync(lockPath(directory), { force: true });
}

/**
 * Asks the running instance for a one-time sign-in link, passing this start's session so it's
 * protected too. Returns null if the instance doesn't answer correctly, which means its lock
 * is stale.
 */
export async function requestHandover(
  lock: InstanceLock,
  identities: Identity[],
): Promise<string | null> {
  const result = await askHandover(lock, identities);
  return result.kind === "link" ? result.url : null;
}

/**
 * What a hand-over got: a link; a refusal from a dashboard that answered, such as another
 * version that reads the request differently (BUG-41); or no proper answer at all.
 */
export type HandoverResult =
  { kind: "link"; url: string } | { kind: "refused" } | { kind: "no-answer" };

export function askHandover(
  lock: InstanceLock,
  identities: Identity[],
): Promise<HandoverResult> {
  const nonce = randomBytes(32).toString("hex");
  const body = JSON.stringify({
    nonce,
    proof: handoverProof(lock.secret, "client", nonce),
    identities,
  });
  return new Promise((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: lock.port,
        method: "POST",
        path: "/api/handover",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: HANDOVER_TIMEOUT_MS,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
          if (text.length > MAX_RESPONSE) req.destroy();
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            // The dashboard's own refusal, as every version words it.
            let refused: boolean;
            try {
              const parsed: unknown = JSON.parse(text);
              refused =
                res.statusCode === 403 &&
                typeof parsed === "object" &&
                parsed !== null &&
                (parsed as { message?: unknown }).message === "Forbidden";
            } catch {
              refused = false;
            }
            resolve(refused ? { kind: "refused" } : { kind: "no-answer" });
            return;
          }
          try {
            const parsed = handoverResponseSchema.safeParse(JSON.parse(text));
            const url =
              parsed.success &&
              proofMatches(
                parsed.data.proof,
                handoverProof(lock.secret, "server", nonce),
              )
                ? parsed.data.loginUrl
                : null;
            // The link must be for the port in the lock, so a stale lock can't redirect us.
            resolve(
              url?.startsWith(`http://127.0.0.1:${String(lock.port)}/`) === true
                ? { kind: "link", url }
                : { kind: "no-answer" },
            );
          } catch {
            resolve({ kind: "no-answer" });
          }
        });
        res.on("error", () => {
          resolve({ kind: "no-answer" });
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => {
      resolve({ kind: "no-answer" });
    });
    req.end(body);
  });
}
