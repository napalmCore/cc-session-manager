import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  browserCommand,
  writeRedirectFile,
  HANDOVER_LINK_NOTE,
  openBrowser,
  PRINTED_LINK_NOTE,
} from "./browser.js";

const URL = "http://127.0.0.1:4780/auth?token=abc";
const folders: string[] = [];
/** A fresh folder for redirect files, removed after the tests. */
const folder = () => {
  const made = mkdtempSync(join(tmpdir(), "ccsm-signin-"));
  folders.push(made);
  return made;
};
afterAll(() => {
  for (const made of folders) rmSync(made, { recursive: true, force: true });
});
/** A display, so Linux runs these the same as the other systems. */
const WITH_DISPLAY = { DISPLAY: ":0" };
/** Finds every program at a fixed place, so these run the same on every system. */
const find = (name: string) => `/usr/bin/${name}`;

/** A process starter whose child exits with the given code, or fails to start. */
function fakeSpawn(result: number | "error" | "throw") {
  return vi.fn(() => {
    if (result === "throw") throw new Error("no such program");
    const child = new EventEmitter();
    setTimeout(() => {
      if (result === "error") child.emit("error", new Error("ENOENT"));
      else child.emit("exit", result);
    }, 0);
    return child;
  }) as unknown as typeof spawn;
}

describe("opening the browser (FR-29, BUG-8)", () => {
  it("prints nothing and sets no limit when the browser opens", async () => {
    const log = vi.fn();
    const beforePrint = vi.fn();
    await openBrowser(URL, {
      note: PRINTED_LINK_NOTE,
      beforePrint,
      log,
      spawn: fakeSpawn(0),
      env: WITH_DISPLAY,
      platform: "win32",
      find,
    });
    expect(log).not.toHaveBeenCalled();
    expect(beforePrint).not.toHaveBeenCalled();
  });

  for (const result of [1, "error", "throw"] as const) {
    it(`starts the limit, then prints the link and how long it works, when the browser can't open (${String(result)})`, async () => {
      const order: string[] = [];
      await openBrowser(URL, {
        note: PRINTED_LINK_NOTE,
        beforePrint: () => order.push("limit"),
        log: (line) => order.push(line),
        spawn: fakeSpawn(result),
        env: WITH_DISPLAY,
        platform: "win32",
        find,
      });
      expect(order).toEqual([
        "limit",
        `Could not open a browser. Open this link: ${URL}`,
        "This link works once, for 2 minutes. Restart cc-session-manager for a new one.",
      ]);
    });
  }

  it("says a printed handover link works for 60 seconds", async () => {
    const log = vi.fn();
    await openBrowser(URL, {
      note: HANDOVER_LINK_NOTE,
      log,
      spawn: fakeSpawn(1),
      env: WITH_DISPLAY,
      platform: "win32",
      find,
    });
    expect(log).toHaveBeenLastCalledWith(
      "This link works once, for 60 seconds. Run cc-session-manager again for a new one.",
    );
  });
});

describe("the browser on each system (FR-42)", () => {
  it("uses open on macOS and xdg-open on Linux, with the link as its own argument", () => {
    expect(browserCommand(URL, "darwin")).toEqual(["open", [URL]]);
    expect(browserCommand(URL, "linux")).toEqual(["xdg-open", [URL]]);
  });

  it("prints the link without starting anything on Linux with no display", async () => {
    const spawn = fakeSpawn(0);
    const log = vi.fn();
    await openBrowser(URL, {
      note: PRINTED_LINK_NOTE,
      log,
      spawn,
      platform: "linux",
      env: { WAYLAND_DISPLAY: "" },
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      `Could not open a browser. Open this link: ${URL}`,
    );
  });

  it("starts xdg-open with a Wayland display", async () => {
    const spawn = fakeSpawn(0);
    await openBrowser(URL, {
      note: PRINTED_LINK_NOTE,
      log: vi.fn(),
      spawn,
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0" },
      find,
      redirectFolder: folder(),
    });
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/xdg-open",
      [expect.stringMatching(/signin-[0-9a-f]{32}\.html$/)],
      expect.anything(),
    );
  });

  it("prints the link when xdg-open isn't on the cleaned PATH", async () => {
    const spawn = fakeSpawn(0);
    const log = vi.fn();
    await openBrowser(URL, {
      note: PRINTED_LINK_NOTE,
      log,
      spawn,
      platform: "linux",
      env: { DISPLAY: ":0", PATH: "bin:.:" },
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      `Could not open a browser. Open this link: ${URL}`,
    );
  });
});

describe("the sign-in link on macOS and Linux (M1)", () => {
  /** A process starter that records what it was given, and whose child exits 0. */
  const recording = () => {
    const calls: { args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
    const spawn = vi.fn(
      (_file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ args, env: options.env });
        const child = new EventEmitter();
        setTimeout(() => child.emit("exit", 0), 0);
        return child;
      },
    ) as unknown as typeof import("node:child_process").spawn;
    return { spawn, calls };
  };

  for (const platform of ["darwin", "linux"] as const) {
    it(`gives the browser a private file, never the link, and always prints the link (${platform})`, async () => {
      const dir = folder();
      const { spawn, calls } = recording();
      const lines: string[] = [];
      const beforePrint = vi.fn();
      await openBrowser(URL, {
        note: PRINTED_LINK_NOTE,
        log: (line) => lines.push(line),
        beforePrint,
        spawn,
        platform,
        env: { DISPLAY: ":0", PATH: "/usr/bin:.", CLAUDECODE: "1" },
        find,
        redirectFolder: dir,
      });
      const [path] = calls[0]?.args ?? [];
      expect(path).toMatch(/signin-[0-9a-f]{32}\.html$/);
      expect(calls[0]?.args.join(" ")).not.toContain("token");
      expect(readFileSync(path ?? "", "utf8")).toContain(
        'content="0;url=http://127.0.0.1:4780/auth?token=abc"',
      );
      if (process.platform !== "win32") {
        expect(statSync(path ?? "").mode & 0o777).toBe(0o600);
      }
      // The same cleaned environment as other launched programs (I3).
      expect(calls[0]?.env?.CLAUDECODE).toBeUndefined();
      expect(calls[0]?.env?.PATH).toBe("/usr/bin");
      expect(beforePrint).toHaveBeenCalled();
      expect(lines).toEqual([
        `If the dashboard didn't open in your browser, open this link: ${URL}`,
        PRINTED_LINK_NOTE,
      ]);
    });
  }

  it("prints the link and starts nothing without a folder for the file", async () => {
    const { spawn, calls } = recording();
    const log = vi.fn();
    await openBrowser(URL, {
      note: PRINTED_LINK_NOTE,
      log,
      spawn,
      platform: "linux",
      env: { DISPLAY: ":0" },
      find,
    });
    expect(calls).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(
      `Could not open a browser. Open this link: ${URL}`,
    );
  });

  it("escapes the link for HTML, and deletes only expired redirect files", () => {
    const dir = folder();
    const old = join(dir, `signin-${"a".repeat(32)}.html`);
    const recent = join(dir, `signin-${"b".repeat(32)}.html`);
    const other = join(dir, "sessions.json");
    for (const path of [old, recent, other]) writeFileSync(path, "x");
    const now = Date.now();
    utimesSync(old, new Date(now - 10 * 60_000), new Date(now - 10 * 60_000));
    const path = writeRedirectFile(dir, 'http://h/a?x="<b>&y', now);
    expect(readFileSync(path, "utf8")).toContain(
      "http://h/a?x=&quot;&lt;b&gt;&amp;y",
    );
    expect(readdirSync(dir).sort()).toEqual(
      [
        path.slice(dir.length + 1),
        recent.slice(dir.length + 1),
        "sessions.json",
      ].sort(),
    );
  });
});
