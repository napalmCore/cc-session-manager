import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import type { WSContext } from "hono/ws";
import { z } from "zod";
import {
  ACTION_NAMES,
  type ActionRequest,
  type ActionResult,
} from "./actions.js";
import type {
  HeartbeatMessage,
  Snapshot,
  SnapshotMessage,
} from "../shared/protocol.js";
import { handoverProof, proofMatches } from "./instance.js";
import { type Identity, identitySchema, toIdentity } from "./protect.js";

const LOOPBACK = "127.0.0.1";
const PORT_ATTEMPTS = 20;
/** The body limit for most actions, and the larger one for Start's prompt (NFR-14). */
const MAX_ACTION_BODY = 4096;
const MAX_START_BODY = 32_768;
export const HANDOVER_LINK_MS = 60_000;
/** A sign-in link printed because no browser opened works for this long (FR-29, BUG-8). */
export const PRINTED_LINK_MS = 2 * 60_000;
/** The header that carries the page key on action requests. */
export const PAGE_KEY_HEADER = "x-ccsm-key";
/** The WebSocket subprotocol that carries the page key, since a browser can't add headers. */
export const PAGE_KEY_PROTOCOL_PREFIX = "ccsm-key-";
export const WS_PROTOCOL = "ccsm";

const handoverRequestSchema = z
  .object({
    nonce: z.string().regex(/^[0-9a-f]{64}$/),
    proof: z.string().regex(/^[0-9a-f]{64}$/),
    identity: identitySchema,
  })
  .strict();

const actionRequestSchema = z.union([
  z.object({ action: z.enum(ACTION_NAMES), key: z.string().max(64) }).strict(),
  // Lengths are checked again, with clear messages, by the Start action itself.
  z
    .object({
      action: z.literal("start"),
      folder: z.string().max(4096),
      kind: z.enum(["background", "interactive"]),
      name: z.string().max(1000).optional(),
      prompt: z.string().max(20_000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("history"),
      page: z.number().int().min(0).max(100_000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("listFolders"),
      folder: z.string().max(4096).optional(),
    })
    .strict(),
]);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};

export interface ServerOptions {
  preferredPort: number;
  webDir?: string;
  /** Runs a session action. Without it, actions are reported as unavailable. */
  onAction?: (request: ActionRequest) => Promise<ActionResult>;
  /** Lets a second start of the tool hand over to this one (U-15). */
  handover?: { secret: string; onHandover: (identity: Identity) => void };
  now?: () => number;
  /** A clock that never goes back, for the printed link's expiry. */
  monotonic?: () => number;
}

export interface RunningServer {
  address: string;
  port: number;
  loginUrl: string;
  publish: (snapshot: Snapshot) => void;
  /** Tells every page when the latest successful poll started, after each poll (BUG-9). */
  heartbeat: (lastSuccessAt: number | null) => void;
  /**
   * Makes the first sign-in link expire this long from now, because it's about to be printed
   * rather than opened in a browser (FR-29).
   */
  limitLoginLink: (ms: number) => void;
  close: () => Promise<void>;
}

function secureEquals(a: string, b: string): boolean {
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(a), hash(b));
}

/** Only files found here at startup can be served, which rules out path traversal. */
function loadAssets(webDir: string): Map<string, string> {
  const assets = new Map<string, string>();
  if (!existsSync(webDir)) return assets;
  for (const entry of readdirSync(webDir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    assets.set(`/${relative(webDir, file).split(sep).join("/")}`, file);
  }
  return assets;
}

function listen(server: Server, preferredPort: number): Promise<number> {
  const attempts = preferredPort === 0 ? 1 : PORT_ATTEMPTS;

  const tryPort = (port: number, remaining: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (error.code === "EADDRINUSE" && remaining > 1) {
          resolve(tryPort(port + 1, remaining - 1));
        } else {
          reject(error);
        }
      };
      const onListening = () => {
        server.off("error", onError);
        resolve((server.address() as AddressInfo).port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, LOOPBACK);
    });

  return tryPort(preferredPort, attempts);
}

export async function startServer(
  options: ServerOptions,
): Promise<RunningServer> {
  const webDir =
    options.webDir ?? fileURLToPath(new URL("../web", import.meta.url));
  const assets = loadAssets(webDir);
  const sessionSecret = randomBytes(32).toString("hex");
  // Browsers send cookies to every port on a host, so the cookie alone could reach another local
  // program. The page key travels only in the sign-in redirect's fragment, which browsers never
  // send to a server, and lives in the page's own storage, which is per port.
  const pageKey = randomBytes(32).toString("hex");
  const hasPageKey = (value: string | undefined) =>
    value !== undefined && secureEquals(value, pageKey);
  const styleNonce = randomBytes(16).toString("hex");
  const clients = new Set<WSContext>();
  let loginToken: string | null = randomBytes(32).toString("hex");
  const issuedToken = loginToken;
  const handoverLinks = new Map<string, number>();
  // A recorded handover request can't be sent again to get another link.
  const usedNonces = new Set<string>();
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  let loginExpiresAt: number | null = null;
  let port = 0;
  let latest: Snapshot | null = null;

  const cookieName = () => `ccsm_session_${String(port)}`;
  const expectedHost = () => `${LOOPBACK}:${String(port)}`;
  const contentSecurityPolicy = (styleSource = "'self'") =>
    [
      "default-src 'none'",
      "script-src 'self'",
      `style-src ${styleSource}`,
      `connect-src 'self' ws://${expectedHost()}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; ");
  const toMessage = (snapshot: Snapshot) =>
    JSON.stringify({ type: "snapshot", snapshot } satisfies SnapshotMessage);
  // The age, not the time, so the page's clock doesn't need to agree with this one.
  let lastSuccess: number | null | undefined;
  const toHeartbeat = (at: number | null) =>
    JSON.stringify({
      type: "heartbeat",
      lastSuccessAgeMs: at === null ? null : Math.max(0, Date.now() - at),
    } satisfies HeartbeatMessage);

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({
    app,
  });

  app.use("*", async (c, next) => {
    await next();
    if (!c.res.headers.has("Content-Security-Policy")) {
      c.header("Content-Security-Policy", contentSecurityPolicy());
    }
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
  });

  app.use("*", async (c, next) => {
    if (c.req.header("host") !== expectedHost()) {
      return c.text("Forbidden", 403);
    }
    await next();
    return undefined;
  });

  // A second start has no cookie, so this comes before the cookie check. It needs the secret
  // from the lock file, and a browser can't send it, because any Origin is refused.
  app.post(
    "/api/handover",
    bodyLimit({
      maxSize: MAX_ACTION_BODY,
      onError: (c) => c.json({ message: "Request too large" }, 413),
    }),
    async (c) => {
      const handover = options.handover;
      if (handover === undefined) return c.json({ message: "Not found" }, 404);
      if (c.req.header("origin") !== undefined) {
        return c.json({ message: "Forbidden" }, 403);
      }
      const contentType = c.req.header("content-type") ?? "";
      if (
        contentType.split(";")[0]?.trim().toLowerCase() !== "application/json"
      ) {
        return c.json({ message: "Expected JSON" }, 415);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await c.req.text());
      } catch {
        return c.json({ message: "Invalid request" }, 400);
      }
      const request = handoverRequestSchema.safeParse(parsed);
      if (
        !request.success ||
        usedNonces.has(request.data.nonce) ||
        !proofMatches(
          request.data.proof,
          handoverProof(handover.secret, "client", request.data.nonce),
        )
      ) {
        return c.json({ message: "Forbidden" }, 403);
      }
      usedNonces.add(request.data.nonce);
      handover.onHandover(toIdentity(request.data.identity));
      const token = randomBytes(32).toString("hex");
      const current = now();
      for (const [link, expires] of handoverLinks) {
        if (expires <= current) handoverLinks.delete(link);
      }
      handoverLinks.set(token, current + HANDOVER_LINK_MS);
      return c.json(
        {
          loginUrl: `http://${expectedHost()}/auth?token=${token}`,
          proof: handoverProof(handover.secret, "server", request.data.nonce),
        },
        200,
      );
    },
  );

  const useHandoverLink = (supplied: string): boolean => {
    for (const [link, expires] of handoverLinks) {
      if (secureEquals(supplied, link)) {
        handoverLinks.delete(link);
        return expires > now();
      }
    }
    return false;
  };

  app.get("/auth", (c) => {
    const supplied = c.req.query("token");
    if (loginExpiresAt !== null && monotonic() >= loginExpiresAt) {
      loginToken = null;
    }
    const first =
      loginToken !== null &&
      supplied !== undefined &&
      secureEquals(supplied, loginToken);
    if (!supplied || (!first && !useHandoverLink(supplied))) {
      return c.text("This sign-in link is invalid or was already used.", 403);
    }
    if (first) loginToken = null;
    setCookie(c, cookieName(), sessionSecret, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
    return c.redirect(`/#key=${pageKey}`, 303);
  });

  app.use("*", async (c, next) => {
    const cookie = getCookie(c, cookieName());
    if (!cookie || !secureEquals(cookie, sessionSecret)) {
      return c.text(
        "Not signed in. Restart cc-session-manager to get a new link.",
        401,
      );
    }
    await next();
    return undefined;
  });

  app.get(
    "/ws",
    async (c, next) => {
      if (c.req.header("origin") !== `http://${expectedHost()}`) {
        return c.text("Forbidden", 403);
      }
      const offered = (c.req.header("sec-websocket-protocol") ?? "")
        .split(",")
        .map((value) => value.trim())
        .find((value) => value.startsWith(PAGE_KEY_PROTOCOL_PREFIX));
      if (!hasPageKey(offered?.slice(PAGE_KEY_PROTOCOL_PREFIX.length))) {
        return c.text("Forbidden", 403);
      }
      await next();
      return undefined;
    },
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        clients.add(ws);
        if (latest) ws.send(toMessage(latest));
        if (lastSuccess !== undefined) ws.send(toHeartbeat(lastSuccess));
      },
      onClose(_event, ws) {
        clients.delete(ws);
      },
    })),
  );

  // Actions change sessions, so they need the cookie checked above, plus a JSON POST from the
  // dashboard's own origin (NFR-6). The tracker validates the key and applies the action rules.
  app.post(
    "/api/actions",
    bodyLimit({
      maxSize: MAX_START_BODY,
      onError: (c) =>
        c.json({ outcome: "refused", message: "Request too large" }, 413),
    }),
    async (c) => {
      if (c.req.header("origin") !== `http://${expectedHost()}`) {
        return c.json({ outcome: "refused", message: "Forbidden" }, 403);
      }
      if (!hasPageKey(c.req.header(PAGE_KEY_HEADER))) {
        return c.json(
          {
            outcome: "refused",
            message:
              "This page can't run actions. Open the dashboard again from the tool's sign-in link.",
          },
          403,
        );
      }
      const contentType = c.req.header("content-type") ?? "";
      if (
        contentType.split(";")[0]?.trim().toLowerCase() !== "application/json"
      ) {
        return c.json({ outcome: "refused", message: "Expected JSON" }, 415);
      }
      const text = await c.req.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return c.json({ outcome: "refused", message: "Invalid request" }, 400);
      }
      // Only Start carries a prompt, so only it gets the larger limit.
      const isStart =
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { action?: unknown }).action === "start";
      if (!isStart && text.length > MAX_ACTION_BODY) {
        return c.json(
          { outcome: "refused", message: "Request too large" },
          413,
        );
      }
      const request = actionRequestSchema.safeParse(parsed);
      if (!request.success) {
        return c.json({ outcome: "refused", message: "Invalid request" }, 400);
      }
      if (options.onAction === undefined) {
        return c.json(
          { outcome: "unavailable", message: "Actions aren't available." },
          503,
        );
      }
      return c.json(await options.onAction(request.data), 200);
    },
  );

  app.get("*", (c) => {
    const path = c.req.path === "/" ? "/index.html" : c.req.path;
    const file = assets.get(path);
    if (!file) {
      return path === "/index.html"
        ? c.text("The dashboard has not been built. Run: pnpm build", 503)
        : c.text("Not found", 404);
    }
    const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
    if (path === "/index.html") {
      // React Aria reads this nonce for the one inline style it adds.
      const meta = `<meta property="csp-nonce" nonce="${styleNonce}" />`;
      const page = readFileSync(file, "utf8").replace(
        "<head>",
        `<head>${meta}`,
      );
      return c.body(page, 200, {
        "Content-Type": type,
        "Content-Security-Policy": contentSecurityPolicy(
          `'self' 'nonce-${styleNonce}'`,
        ),
      });
    }
    return c.body(readFileSync(file), 200, { "Content-Type": type });
  });

  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
  injectWebSocket(server);
  port = await listen(server, options.preferredPort);

  return {
    address: LOOPBACK,
    port,
    loginUrl: `http://${expectedHost()}/auth?token=${issuedToken}`,
    publish(snapshot) {
      latest = snapshot;
      const message = toMessage(snapshot);
      for (const client of clients) client.send(message);
    },
    limitLoginLink(ms) {
      loginExpiresAt = monotonic() + ms;
    },
    heartbeat(at) {
      lastSuccess = at;
      const message = toHeartbeat(at);
      for (const client of clients) client.send(message);
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        // Otherwise a half-open request or upgrade would keep this waiting forever.
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}
