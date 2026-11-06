import http from "node:http";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { toSessionView } from "./rules.js";
import { startServer, type RunningServer } from "./server.js";

let server: RunningServer;

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  path: string,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: server.port, path, headers },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
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

describe("Content Security Policy", () => {
  it("allows only local resources and the server's own WebSocket", async () => {
    const cookie = await login();
    const policy = (await request("/", { cookie })).headers[
      "content-security-policy"
    ];

    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("style-src 'self'");
    expect(policy).toContain(
      `connect-src ws://127.0.0.1:${String(server.port)}`,
    );
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("unsafe");
  });

  it("gives the page a nonce that the policy accepts for styles only", async () => {
    const cookie = await login();
    const { headers, body } = await request("/", { cookie });

    const match = /<meta property="csp-nonce" nonce="([0-9a-f]{32})"/.exec(
      body,
    );
    expect(match).not.toBeNull();
    const policy = String(headers["content-security-policy"]);
    expect(policy).toContain(`style-src 'self' 'nonce-${match?.[1] ?? ""}'`);
    expect(policy).toContain("script-src 'self';");
  });

  it("does not reveal the nonce to requests that aren't signed in", async () => {
    const { headers, body } = await request("/");
    expect(body).not.toContain("csp-nonce");
    expect(String(headers["content-security-policy"])).not.toContain("nonce");
  });

  it("uses a different nonce on each run", async () => {
    const pageNonce = async () => {
      const { headers } = await request("/", { cookie: await login() });
      return /'nonce-[0-9a-f]+'/.exec(
        String(headers["content-security-policy"]),
      )?.[0];
    };
    const first = await pageNonce();
    await server.close();
    server = await startServer({ preferredPort: 0 });

    expect(first).toBeTruthy();
    expect(await pageNonce()).not.toBe(first);
  });

  it("is also sent on rejected requests", async () => {
    const { headers } = await request("/");
    expect(headers["content-security-policy"]).toBeTruthy();
  });
});

describe("before the first poll", () => {
  it("sends nothing until real data is published", async () => {
    const fresh = await startServer({ preferredPort: 0 });
    const url = new URL(fresh.loginUrl);
    const previous = server;
    server = fresh;
    try {
      const response = await request(url.pathname + url.search);
      const cookie =
        (response.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
      const messages: string[] = [];
      const socket = new WebSocket(`ws://127.0.0.1:${String(fresh.port)}/ws`, {
        headers: { cookie, origin: `http://127.0.0.1:${String(fresh.port)}` },
      });
      socket.on("message", (data: Buffer) => messages.push(data.toString()));
      await new Promise((resolve) => socket.once("open", resolve));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(messages).toEqual([]);

      fresh.publish({ sessions: [], error: null, warnings: [] });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(messages).toHaveLength(1);
      socket.close();
    } finally {
      server = previous;
      await fresh.close();
    }
  });
});

describe("shutting down", () => {
  const closesInTime = async (target: RunningServer) => {
    const outcome = await Promise.race([
      target.close().then(() => "closed"),
      new Promise((resolve) =>
        setTimeout(() => {
          resolve("timed out");
        }, 2000),
      ),
    ]);
    expect(outcome).toBe("closed");
  };

  it("finishes with a half-sent request still open", async () => {
    const target = await startServer({ preferredPort: 0 });
    const socket = net.connect(target.port, "127.0.0.1");
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.on("error", () => undefined);
    socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n");
    await new Promise((resolve) => setTimeout(resolve, 50));

    await closesInTime(target);
    socket.destroy();
  });

  it("finishes with a WebSocket connected", async () => {
    const target = await startServer({ preferredPort: 0 });
    target.publish({ sessions: [], error: null, warnings: [] });
    const previous = server;
    server = target;
    const cookie = await login();
    server = previous;
    const socket = new WebSocket(`ws://127.0.0.1:${String(target.port)}/ws`, {
      headers: { cookie, origin: `http://127.0.0.1:${String(target.port)}` },
    });
    socket.on("error", () => undefined);
    await new Promise((resolve) => socket.once("message", resolve));

    await closesInTime(target);
  });

  it("finishes with a WebSocket upgrade still in progress", async () => {
    const target = await startServer({ preferredPort: 0 });
    const previous = server;
    server = target;
    const cookie = await login();
    server = previous;
    const socket = net.connect(target.port, "127.0.0.1");
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.on("error", () => undefined);
    socket.write(
      [
        "GET /ws HTTP/1.1",
        `Host: 127.0.0.1:${String(target.port)}`,
        `Origin: http://127.0.0.1:${String(target.port)}`,
        `Cookie: ${cookie}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "",
        "",
      ].join("\r\n"),
    );

    await closesInTime(target);
    socket.destroy();
  });
});

describe("port selection", () => {
  it("falls back to the next free port when the preferred one is busy", async () => {
    const other = await startServer({ preferredPort: server.port });
    expect(other.port).not.toBe(server.port);
    await other.close();
  });
});
