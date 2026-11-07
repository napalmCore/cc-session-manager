import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRequest, ActionResult } from "./actions.js";
import { startServer, type RunningServer } from "./server.js";

let server: RunningServer;
let onAction: ReturnType<
  typeof vi.fn<(request: ActionRequest) => Promise<ActionResult>>
>;

interface RawResponse {
  status: number;
  body: string;
}

function send(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: server.port, path, method, headers },
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
  return (response.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
}

const origin = () => `http://127.0.0.1:${String(server.port)}`;
const validBody = JSON.stringify({ action: "stop", key: "abcd1234" });

beforeEach(async () => {
  onAction = vi.fn(() =>
    Promise.resolve({ outcome: "succeeded" as const, message: "Stopped." }),
  );
  server = await startServer({ preferredPort: 0, onAction });
});

afterEach(async () => {
  await server.close();
});

describe("POST /api/actions", () => {
  it("runs a valid request and returns the result", async () => {
    const cookie = await login();
    const response = await send(
      "POST",
      "/api/actions",
      { cookie, origin: origin(), "content-type": "application/json" },
      validBody,
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      outcome: "succeeded",
      message: "Stopped.",
    });
    expect(onAction).toHaveBeenCalledWith({ action: "stop", key: "abcd1234" });
  });

  it("rejects a request without a session cookie", async () => {
    const response = await send(
      "POST",
      "/api/actions",
      { origin: origin(), "content-type": "application/json" },
      validBody,
    );
    expect(response.status).toBe(401);
    expect(onAction).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["from another site", "https://evil.example"],
    ["from another local port", "http://127.0.0.1:1"],
  ])("rejects an Origin that is %s", async (_label, value) => {
    const cookie = await login();
    const headers: Record<string, string> = {
      cookie,
      "content-type": "application/json",
    };
    if (value !== undefined) headers.origin = value;
    const response = await send("POST", "/api/actions", headers, validBody);
    expect(response.status).toBe(403);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("rejects a body that isn't JSON by content type", async () => {
    const cookie = await login();
    const response = await send(
      "POST",
      "/api/actions",
      { cookie, origin: origin(), "content-type": "text/plain" },
      validBody,
    );
    expect(response.status).toBe(415);
    expect(onAction).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an unknown field",
      JSON.stringify({ action: "stop", key: "abcd1234", force: true }),
    ],
    ["a missing key", JSON.stringify({ action: "stop" })],
    ["a non-string action", JSON.stringify({ action: 1, key: "abcd1234" })],
    ["malformed JSON", "{"],
    ["an array", "[]"],
  ])("rejects %s", async (_label, body) => {
    const cookie = await login();
    const response = await send(
      "POST",
      "/api/actions",
      { cookie, origin: origin(), "content-type": "application/json" },
      body,
    );
    expect(response.status).toBe(400);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("rejects an oversized body without passing it on", async () => {
    const cookie = await login();
    const body = JSON.stringify({
      action: "stop",
      key: "abcd1234",
      pad: "x".repeat(10_000),
    });
    const response = await send(
      "POST",
      "/api/actions",
      { cookie, origin: origin(), "content-type": "application/json" },
      body,
    );
    expect(response.status).toBe(413);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("can't be triggered by a read", async () => {
    const cookie = await login();
    await send("GET", "/api/actions?action=stop&key=abcd1234", {
      cookie,
      origin: origin(),
    });
    expect(onAction).not.toHaveBeenCalled();
  });

  it("reports actions as unavailable when no handler is set up", async () => {
    const plain = await startServer({ preferredPort: 0 });
    const previous = server;
    server = plain;
    try {
      const cookie = await login();
      const response = await send(
        "POST",
        "/api/actions",
        { cookie, origin: origin(), "content-type": "application/json" },
        validBody,
      );
      expect(response.status).toBe(503);
    } finally {
      server = previous;
      await plain.close();
    }
  });
});
