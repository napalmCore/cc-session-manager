import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLock,
  handoverProof,
  lockPath,
  newHandoverSecret,
  processAlive,
  readLock,
  removeLock,
  requestHandover,
  type InstanceLock,
} from "./instance.js";
import type { Identity } from "./protect.js";
import { HANDOVER_LINK_MS, startServer, type RunningServer } from "./server.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const identity: Identity = {
  insideClaude: true,
  sessionId: SESSION_ID,
  pid: 4321,
  pidStartMs: 1000,
};

let server: RunningServer;
let secret: string;
let clock: number;
const onHandover = vi.fn<(identity: Identity) => void>();

function post(
  body: string,
  headers: Record<string, string> = { "Content-Type": "application/json" },
  host?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.port,
        method: "POST",
        path: "/api/handover",
        headers: host === undefined ? headers : { ...headers, Host: host },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString();
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: text });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function get(path: string): Promise<{ status: number; cookie?: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: server.port, path }, (res) => {
        res.resume();
        res.on("end", () => {
          const cookie = res.headers["set-cookie"]?.[0];
          resolve({
            status: res.statusCode ?? 0,
            ...(cookie === undefined ? {} : { cookie }),
          });
        });
      })
      .on("error", reject);
  });
}

const lockFor = (): InstanceLock => ({
  version: 1,
  pid: process.pid,
  port: server.port,
  secret,
});

/** A correctly signed request body, as a second start sends. */
const signed = (
  extra: Record<string, unknown> = {},
  nonce = "a".repeat(64),
) => ({
  nonce,
  proof: handoverProof(secret, "client", nonce),
  identity,
  ...extra,
});

const pathOf = (url: string) => {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
};

beforeEach(async () => {
  secret = newHandoverSecret();
  clock = 1_000_000;
  onHandover.mockReset();
  server = await startServer({
    preferredPort: 0,
    handover: { secret, onHandover },
    now: () => clock,
  });
});

afterEach(async () => {
  await server.close();
});

describe("handover route", () => {
  it("returns a one-time sign-in link and protects the second start's session", async () => {
    const link = await requestHandover(lockFor(), identity);
    expect(link).toMatch(
      new RegExp(
        `^http://127\\.0\\.0\\.1:${String(server.port)}/auth\\?token=[0-9a-f]{64}$`,
      ),
    );
    expect(onHandover).toHaveBeenCalledWith(identity);

    const first = await get(pathOf(link ?? ""));
    expect(first.status).toBe(303);
    expect(first.cookie).toMatch(/HttpOnly/i);
    expect((await get(pathOf(link ?? ""))).status).toBe(403);
  });

  it("keeps the first sign-in link working alongside a handover link", async () => {
    await requestHandover(lockFor(), identity);
    expect((await get(pathOf(server.loginUrl))).status).toBe(303);
  });

  it("expires a handover link after 60 seconds", async () => {
    const link = await requestHandover(lockFor(), identity);
    clock += HANDOVER_LINK_MS + 1;
    expect((await get(pathOf(link ?? ""))).status).toBe(403);
  });

  it("refuses a wrong secret", async () => {
    const link = await requestHandover(
      { ...lockFor(), secret: newHandoverSecret() },
      identity,
    );
    expect(link).toBeNull();
    expect(onHandover).not.toHaveBeenCalled();
  });

  it("refuses any request with a browser Origin", async () => {
    const response = await post(JSON.stringify(signed()), {
      "Content-Type": "application/json",
      Origin: `http://127.0.0.1:${String(server.port)}`,
    });
    expect(response.status).toBe(403);
    expect(onHandover).not.toHaveBeenCalled();
  });

  it("refuses the wrong Host", async () => {
    const response = await post(
      JSON.stringify(signed()),
      { "Content-Type": "application/json" },
      `localhost:${String(server.port)}`,
    );
    expect(response.status).toBe(403);
    expect(onHandover).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown fields", () => signed({ extra: 1 })],
    [
      "a bad session ID",
      () => signed({ identity: { ...identity, sessionId: "x" } }),
    ],
    ["no identity", () => ({ nonce: "a".repeat(64), proof: signed().proof })],
    ["the secret itself instead of a proof", () => ({ secret, identity })],
    [
      "a proof made with another secret",
      () => ({
        nonce: "a".repeat(64),
        proof: handoverProof(newHandoverSecret(), "client", "a".repeat(64)),
        identity,
      }),
    ],
  ])("refuses a request with %s", async (_label, body) => {
    expect((await post(JSON.stringify(body()))).status).toBe(403);
    expect(onHandover).not.toHaveBeenCalled();
  });

  it("refuses a request that isn't JSON", async () => {
    expect(
      (
        await post(JSON.stringify(signed()), {
          "Content-Type": "text/plain",
        })
      ).status,
    ).toBe(415);
  });

  it("isn't there without a handover secret", async () => {
    await server.close();
    server = await startServer({ preferredPort: 0 });
    expect((await post(JSON.stringify(signed()))).status).toBe(404);
  });
});

describe("handover proofs", () => {
  it("refuses a recorded request sent again", async () => {
    const body = JSON.stringify(signed({}, "b".repeat(64)));
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(403);
    expect(onHandover).toHaveBeenCalledTimes(1);
  });

  it("answers with a proof that it knows the secret", async () => {
    const nonce = "c".repeat(64);
    const response = await post(JSON.stringify(signed({}, nonce)));
    const body = JSON.parse(response.body) as { proof: string };
    expect(body.proof).toBe(handoverProof(secret, "server", nonce));
  });
});

describe("requestHandover", () => {
  it("is null when nothing answers on the lock's port", async () => {
    const lock = lockFor();
    await server.close();
    expect(await requestHandover(lock, identity)).toBeNull();
    server = await startServer({ preferredPort: 0 });
  });
});

describe("requestHandover's checks on the answer", () => {
  let fake: http.Server;
  let fakePort: number;
  let answer: { status: number; body: string };
  let received: string[];

  beforeEach(async () => {
    received = [];
    fake = http.createServer((req, res) => {
      let text = "";
      req.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      req.on("end", () => {
        received.push(text);
        const nonce =
          (JSON.parse(text) as { nonce?: string }).nonce ?? "missing";
        res.writeHead(answer.status, { "Content-Type": "application/json" });
        res.end(
          answer.body.replace("PROOF", handoverProof(secret, "server", nonce)),
        );
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    fakePort = (fake.address() as { port: number }).port;
  });
  afterEach(async () => {
    await new Promise((resolve) => fake.close(resolve));
  });

  const ask = () =>
    requestHandover(
      { version: 1, pid: process.pid, port: fakePort, secret },
      identity,
    );
  const token = "c".repeat(64);

  it("accepts a link for the lock's own port", async () => {
    const url = `http://127.0.0.1:${String(fakePort)}/auth?token=${token}`;
    answer = {
      status: 200,
      body: JSON.stringify({ loginUrl: url, proof: "PROOF" }),
    };
    expect(await ask()).toBe(url);
  });

  it("never sends the secret, so whatever answers on the port can't learn it", async () => {
    answer = { status: 403, body: "{}" };
    await ask();
    expect(received).toHaveLength(1);
    expect(received[0]).not.toContain(secret);
  });

  it.each([
    ["no proof", () => ({})],
    ["a wrong proof", () => ({ proof: "0".repeat(64) })],
    [
      "a proof for another secret",
      () => ({
        proof: handoverProof(newHandoverSecret(), "server", "x"),
      }),
    ],
  ])(
    "refuses a link that comes with %s, as an impostor would send",
    async (_label, extra) => {
      const url = `http://127.0.0.1:${String(fakePort)}/auth?token=${token}`;
      answer = {
        status: 200,
        body: JSON.stringify({ loginUrl: url, ...extra() }),
      };
      expect(await ask()).toBeNull();
    },
  );

  it.each([
    [
      "another port",
      (port: number) =>
        `http://127.0.0.1:${String(port + 1)}/auth?token=${token}`,
    ],
    [
      "a port that starts the same",
      (port: number) => `http://127.0.0.1:${String(port)}0/auth?token=${token}`,
    ],
    ["another host", () => `http://evil.example/auth?token=${token}`],
    [
      "another path",
      (port: number) => `http://127.0.0.1:${String(port)}/x?token=${token}`,
    ],
  ])("refuses a link for %s", async (_label, link) => {
    answer = {
      status: 200,
      body: JSON.stringify({ loginUrl: link(fakePort), proof: "PROOF" }),
    };
    expect(await ask()).toBeNull();
  });

  it.each([
    ["an error status", { status: 403, body: "{}" }],
    ["a body that isn't JSON", { status: 200, body: "nope" }],
    ["an oversized body", { status: 200, body: "x".repeat(10_000) }],
  ])("is null for %s", async (_label, response) => {
    answer = response;
    expect(await ask()).toBeNull();
  });
});

describe("processAlive", () => {
  it("is true for this process and false for an unused process ID", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(0x7ffffff0)).toBe(false);
  });
});

describe("instance lock", () => {
  let folder: string;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "ccsm-lock-"));
  });
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  const lock = (): InstanceLock => ({
    version: 1,
    pid: 1234,
    port: 4780,
    secret: "a".repeat(64),
  });

  it("is created once, so a second start can't also win", () => {
    expect(createLock(folder, lock())).toBe(true);
    expect(createLock(folder, { ...lock(), pid: 99 })).toBe(false);
    expect(readLock(folder)?.pid).toBe(1234);
  });

  it("is removed only by its owner", () => {
    createLock(folder, lock());
    removeLock(folder, { ...lock(), secret: "b".repeat(64) });
    expect(readLock(folder)).not.toBeNull();
    removeLock(folder, lock());
    expect(readLock(folder)).toBeNull();
  });

  it("reads a damaged lock as none", () => {
    writeFileSync(lockPath(folder), "{not json");
    expect(readLock(folder)).toBeNull();
    writeFileSync(
      lockPath(folder),
      JSON.stringify({ ...lock(), secret: "short" }),
    );
    expect(readLock(folder)).toBeNull();
  });
});
