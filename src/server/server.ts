import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { WSContext } from "hono/ws";
import type { Snapshot, SnapshotMessage } from "../shared/protocol.js";

const LOOPBACK = "127.0.0.1";
const PORT_ATTEMPTS = 20;

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
}

export interface RunningServer {
  address: string;
  port: number;
  loginUrl: string;
  publish: (snapshot: Snapshot) => void;
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
  const styleNonce = randomBytes(16).toString("hex");
  const clients = new Set<WSContext>();
  let loginToken: string | null = randomBytes(32).toString("hex");
  const issuedToken = loginToken;
  let port = 0;
  let latest: Snapshot | null = null;

  const cookieName = () => `ccsm_session_${String(port)}`;
  const expectedHost = () => `${LOOPBACK}:${String(port)}`;
  const contentSecurityPolicy = (styleSource = "'self'") =>
    [
      "default-src 'none'",
      "script-src 'self'",
      `style-src ${styleSource}`,
      `connect-src ws://${expectedHost()}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; ");
  const toMessage = (snapshot: Snapshot) =>
    JSON.stringify({ type: "snapshot", snapshot } satisfies SnapshotMessage);

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({
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

  app.get("/auth", (c) => {
    const supplied = c.req.query("token");
    if (
      loginToken === null ||
      !supplied ||
      !secureEquals(supplied, loginToken)
    ) {
      return c.text("This sign-in link is invalid or was already used.", 403);
    }
    loginToken = null;
    setCookie(c, cookieName(), sessionSecret, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
    return c.redirect("/", 303);
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
      await next();
      return undefined;
    },
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        clients.add(ws);
        if (latest) ws.send(toMessage(latest));
      },
      onClose(_event, ws) {
        clients.delete(ws);
      },
    })),
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
    close() {
      for (const client of wss.clients) client.terminate();
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
