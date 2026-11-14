import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Search, SearchStatus } from "./search.js";
import { startServer, type RunningServer } from "./server.js";

let server: RunningServer;
let pageKey = "";
const SEARCH_ID = "0123456789abcdef0123456789abcdef";
let search: {
  start: ReturnType<typeof vi.fn>;
  poll: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
};

interface Raw {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function send(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: server.port, path, method, headers },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString();
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: text,
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function login(): Promise<string> {
  const url = new URL(server.loginUrl);
  const response = await new Promise<http.IncomingMessage>(
    (resolve, reject) => {
      http
        .get(
          {
            host: "127.0.0.1",
            port: server.port,
            path: url.pathname + url.search,
          },
          resolve,
        )
        .on("error", reject);
    },
  );
  response.resume();
  pageKey =
    /#key=([0-9a-f]{64})$/.exec(response.headers.location ?? "")?.[1] ?? "";
  return (response.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
}

const origin = () => `http://127.0.0.1:${String(server.port)}`;

beforeEach(async () => {
  search = {
    start: vi.fn((query: string) =>
      query.trim().length >= 2 ? SEARCH_ID : null,
    ),
    poll: vi.fn((): SearchStatus => ({
      status: "running",
      filesDone: 1,
      filesTotal: 4,
    })),
    cancel: vi.fn(() => true),
  };
  server = await startServer({
    preferredPort: 0,
    search: search as unknown as Search,
  });
});

afterEach(async () => {
  await server.close();
});

describe("search routes (FR-36, C-16, NFR-6)", () => {
  const headers = async () => ({
    cookie: await login(),
    "x-ccsm-key": pageKey,
    origin: origin(),
    "content-type": "application/json",
  });

  it("starts a search, follows it, and cancels it, all without caching", async () => {
    const h = await headers();
    const started = await send(
      "POST",
      "/api/search",
      h,
      JSON.stringify({ query: "needle" }),
    );
    expect(started.status).toBe(200);
    expect(JSON.parse(started.body)).toEqual({ id: SEARCH_ID });
    expect(started.headers["cache-control"]).toBe("no-store");
    const polled = await send("POST", `/api/search/${SEARCH_ID}`, h);
    expect(JSON.parse(polled.body)).toEqual({
      status: "running",
      filesDone: 1,
      filesTotal: 4,
    });
    expect(polled.headers["cache-control"]).toBe("no-store");
    const cancelled = await send("POST", `/api/search/${SEARCH_ID}/cancel`, h);
    expect(JSON.parse(cancelled.body)).toEqual({ cancelled: true });
    expect(cancelled.headers["cache-control"]).toBe("no-store");
  });

  it("refuses without the dashboard's origin, the page key, or the cookie", async () => {
    const h = await headers();
    const body = JSON.stringify({ query: "needle" });
    expect(
      (
        await send(
          "POST",
          "/api/search",
          { ...h, origin: "http://evil.example" },
          body,
        )
      ).status,
    ).toBe(403);
    expect(
      (await send("POST", "/api/search", { ...h, "x-ccsm-key": "nope" }, body))
        .status,
    ).toBe(403);
    const withoutCookie: Record<string, string> = { ...h };
    delete withoutCookie.cookie;
    expect(
      (await send("POST", "/api/search", withoutCookie, body)).status,
    ).toBe(401);
    expect(
      (
        await send("POST", `/api/search/${SEARCH_ID}`, {
          ...h,
          origin: "http://evil.example",
        })
      ).status,
    ).toBe(403);
    expect(search.start).not.toHaveBeenCalled();
    expect(search.poll).not.toHaveBeenCalled();
  });

  it("can't be read with a GET, which a browser sends without an origin", async () => {
    const h = await headers();
    const response = await send("GET", `/api/search/${SEARCH_ID}`, h);
    expect(response.status).not.toBe(200);
    expect(search.poll).not.toHaveBeenCalled();
  });

  it("refuses bad bodies and ids", async () => {
    const h = await headers();
    expect((await send("POST", "/api/search", h, "not json")).status).toBe(400);
    expect(
      (
        await send(
          "POST",
          "/api/search",
          h,
          JSON.stringify({ query: "needle", extra: 1 }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await send("POST", "/api/search", h, JSON.stringify({ query: "a" })))
        .status,
    ).toBe(400);
    expect(
      (
        await send(
          "POST",
          "/api/search",
          { ...h, "content-type": "text/plain" },
          "{}",
        )
      ).status,
    ).toBe(415);
    expect((await send("POST", "/api/search/not-an-id", h)).status).toBe(404);
  });
});
