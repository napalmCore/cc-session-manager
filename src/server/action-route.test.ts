import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRequest, ActionResult } from "./actions.js";
import { startServer, type RunningServer } from "./server.js";

let server: RunningServer;
let pageKey = "";
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
  pageKey =
    /#key=([0-9a-f]{64})$/.exec(response.headers.location ?? "")?.[1] ?? "";
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
      {
        cookie,
        "x-ccsm-key": pageKey,
        origin: origin(),
        "content-type": "application/json",
      },
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
      "x-ccsm-key": pageKey,
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
      {
        cookie,
        "x-ccsm-key": pageKey,
        origin: origin(),
        "content-type": "text/plain",
      },
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
      {
        cookie,
        "x-ccsm-key": pageKey,
        origin: origin(),
        "content-type": "application/json",
      },
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
      {
        cookie,
        "x-ccsm-key": pageKey,
        origin: origin(),
        "content-type": "application/json",
      },
      body,
    );
    expect(response.status).toBe(413);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("accepts a Start with an 8,000-character prompt, up to its own larger limit", async () => {
    const cookie = await login();
    const headers = {
      cookie,
      "x-ccsm-key": pageKey,
      origin: origin(),
      "content-type": "application/json",
    };
    const ok = await send(
      "POST",
      "/api/actions",
      headers,
      JSON.stringify({
        action: "start",
        folder: "C:/work",
        kind: "background",
        prompt: "x".repeat(8000),
      }),
    );
    expect(ok.status).toBe(200);
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "start", kind: "background" }),
    );
    const tooBig = await send(
      "POST",
      "/api/actions",
      headers,
      JSON.stringify({
        action: "start",
        folder: "C:/w",
        kind: "background",
        prompt: "x".repeat(40_000),
      }),
    );
    expect(tooBig.status).toBe(413);
  });

  it("refuses unknown fields, and a session's key, on a Start", async () => {
    const cookie = await login();
    const headers = {
      cookie,
      "x-ccsm-key": pageKey,
      origin: origin(),
      "content-type": "application/json",
    };
    for (const body of [
      {
        action: "start",
        folder: "C:/w",
        kind: "background",
        prompt: "p",
        permissionMode: "bypassPermissions",
      },
      {
        action: "start",
        folder: "C:/w",
        kind: "background",
        prompt: "p",
        key: "abcd1234",
      },
      { action: "start", folder: "C:/w", kind: "detached", prompt: "p" },
      { action: "stop", key: "abcd1234", folder: "C:/w" },
    ]) {
      const response = await send(
        "POST",
        "/api/actions",
        headers,
        JSON.stringify(body),
      );
      expect(response.status).toBe(400);
    }
    expect(onAction).not.toHaveBeenCalled();
  });

  it("takes a listFolders request, with or without a folder, and nothing else", async () => {
    const cookie = await login();
    const headers = {
      cookie,
      "x-ccsm-key": pageKey,
      origin: origin(),
      "content-type": "application/json",
    };
    for (const body of [
      { action: "listFolders" },
      { action: "listFolders", folder: "C:/work" },
    ]) {
      expect(
        (await send("POST", "/api/actions", headers, JSON.stringify(body)))
          .status,
      ).toBe(200);
    }
    expect(
      (
        await send(
          "POST",
          "/api/actions",
          headers,
          JSON.stringify({ action: "listFolders", key: "abcd1234" }),
        )
      ).status,
    ).toBe(400);
    // Without the page key, nothing is listed (NFR-6).
    const withoutKey = await send(
      "POST",
      "/api/actions",
      { cookie, origin: origin(), "content-type": "application/json" },
      JSON.stringify({ action: "listFolders" }),
    );
    expect(withoutKey.status).toBe(403);
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it("can't be triggered by a read", async () => {
    const cookie = await login();
    await send("GET", "/api/actions?action=stop&key=abcd1234", {
      cookie,
      "x-ccsm-key": pageKey,
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
        {
          cookie,
          "x-ccsm-key": pageKey,
          origin: origin(),
          "content-type": "application/json",
        },
        validBody,
      );
      expect(response.status).toBe(503);
    } finally {
      server = previous;
      await plain.close();
    }
  });
});

describe("the page key", () => {
  const post = (headers: Record<string, string>) =>
    send(
      "POST",
      "/api/actions",
      { origin: origin(), "content-type": "application/json", ...headers },
      validBody,
    );

  it("refuses a request with the cookie but no page key, as another local program would send", async () => {
    const cookie = await login();
    const response = await post({ cookie });

    expect(response.status).toBe(403);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("refuses a wrong page key", async () => {
    const cookie = await login();
    const response = await post({ cookie, "x-ccsm-key": "0".repeat(64) });

    expect(response.status).toBe(403);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("refuses the page key without the cookie", async () => {
    await login();
    const response = await post({ "x-ccsm-key": pageKey });

    expect(response.status).toBe(401);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("is never in a response that only needed the cookie", async () => {
    const cookie = await login();
    const page = await send("GET", "/", { cookie });

    expect(pageKey).toMatch(/^[0-9a-f]{64}$/);
    expect(page.body).not.toContain(pageKey);
  });
});
