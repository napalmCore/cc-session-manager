import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { toSessionView } from "./rules.js";
import { startServer, type RunningServer } from "./server.js";

let server: RunningServer;

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
}

function request(
  path: string,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: server.port, path, headers },
      (res) => {
        res.resume();
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function loginPath(): string {
  const url = new URL(server.loginUrl);
  return url.pathname + url.search;
}

async function login(): Promise<string> {
  const response = await request(loginPath());
  const cookie = response.headers["set-cookie"]?.[0];
  if (!cookie) throw new Error("login did not set a cookie");
  return cookie.split(";")[0] ?? "";
}

function connect(
  headers: Record<string, string>,
): Promise<{ opened: boolean; first?: string }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(server.port)}/ws`, {
      headers,
    });
    socket.on("message", (data: Buffer) => {
      socket.close();
      resolve({ opened: true, first: data.toString() });
    });
    socket.on("error", () => {
      resolve({ opened: false });
    });
  });
}

beforeEach(async () => {
  server = await startServer({ preferredPort: 0 });
  server.publish({
    sessions: [
      toSessionView({
        cwd: "C:/work",
        kind: "interactive",
        startedAt: 1,
        status: "busy",
      }),
    ],
    error: null,
    warnings: [],
  });
});

afterEach(async () => {
  await server.close();
});

describe("network binding", () => {
  it("listens on the loopback interface only", () => {
    expect(server.address).toBe("127.0.0.1");
  });
});

describe("login", () => {
  it("rejects a wrong token", async () => {
    const response = await request("/auth?token=wrong");
    expect(response.status).toBe(403);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects a missing token", async () => {
    expect((await request("/auth")).status).toBe(403);
  });

  it("sets a protected cookie and redirects away from the token URL", async () => {
    const token =
      new URL(server.loginUrl).searchParams.get("token") ?? "missing";
    const response = await request(loginPath());

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("/");
    const cookie = response.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain(token);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("accepts the token only once", async () => {
    await login();
    expect((await request(loginPath())).status).toBe(403);
  });

  it("uses a different token on each run", async () => {
    const other = await startServer({ preferredPort: 0 });
    expect(new URL(other.loginUrl).search).not.toBe(
      new URL(server.loginUrl).search,
    );
    await other.close();
  });
});

describe("request guard", () => {
  it("rejects requests without a valid cookie", async () => {
    const name = (await login()).split("=")[0] ?? "";
    expect((await request("/")).status).toBe(401);
    expect((await request("/", { cookie: `${name}=forged` })).status).toBe(401);
  });

  it("does not accept the login token as a cookie value", async () => {
    const token = new URL(server.loginUrl).searchParams.get("token") ?? "";
    const name = (await login()).split("=")[0] ?? "";
    expect((await request("/", { cookie: `${name}=${token}` })).status).toBe(
      401,
    );
  });

  it("blocks DNS rebinding through the Host header", async () => {
    const cookie = await login();
    expect((await request("/", { cookie, host: "evil.example" })).status).toBe(
      403,
    );
  });

  it("blocks a matching host on another port", async () => {
    const cookie = await login();
    expect((await request("/", { cookie, host: "127.0.0.1:1" })).status).toBe(
      403,
    );
  });

  it("allows a valid session", async () => {
    const cookie = await login();
    const { status } = await request("/", { cookie });
    expect(status).not.toBe(401);
    expect(status).not.toBe(403);
  });
});

describe("WebSocket", () => {
  const origin = () => `http://127.0.0.1:${String(server.port)}`;

  it("rejects a connection without a cookie", async () => {
    expect((await connect({ origin: origin() })).opened).toBe(false);
  });

  it("rejects a connection from another origin", async () => {
    const cookie = await login();
    expect(
      (await connect({ cookie, origin: "https://evil.example" })).opened,
    ).toBe(false);
  });

  it("rejects a connection with no origin", async () => {
    const cookie = await login();
    expect((await connect({ cookie })).opened).toBe(false);
  });

  it("sends the current snapshot to an authorized client", async () => {
    const cookie = await login();
    const result = await connect({ cookie, origin: origin() });

    expect(result.opened).toBe(true);
    const message = JSON.parse(result.first ?? "{}") as {
      type: string;
      snapshot: { sessions: unknown[] };
    };
    expect(message.type).toBe("snapshot");
    expect(message.snapshot.sessions).toHaveLength(1);
  });
});

describe("port selection", () => {
  it("falls back to the next free port when the preferred one is busy", async () => {
    const other = await startServer({ preferredPort: server.port });
    expect(other.port).not.toBe(server.port);
    await other.close();
  });
});
