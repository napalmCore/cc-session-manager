import { randomBytes } from "node:crypto";
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

const handoverResponseSchema = z.object({
  loginUrl: z
    .string()
    .regex(/^http:\/\/127\.0\.0\.1:\d{1,5}\/auth\?token=[0-9a-f]{64}$/),
});

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
export function requestHandover(
  lock: InstanceLock,
  identity: Identity,
): Promise<string | null> {
  const body = JSON.stringify({ secret: lock.secret, identity });
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
            resolve(null);
            return;
          }
          try {
            const parsed = handoverResponseSchema.safeParse(JSON.parse(text));
            const url = parsed.success ? parsed.data.loginUrl : null;
            // The link must be for the port in the lock, so a stale lock can't redirect us.
            resolve(
              url?.startsWith(`http://127.0.0.1:${String(lock.port)}/`) === true
                ? url
                : null,
            );
          } catch {
            resolve(null);
          }
        });
        res.on("error", () => {
          resolve(null);
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => {
      resolve(null);
    });
    req.end(body);
  });
}
