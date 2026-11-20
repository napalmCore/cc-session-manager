import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  browserCommand,
  HANDOVER_LINK_NOTE,
  openBrowser,
  PRINTED_LINK_NOTE,
} from "./browser.js";

const URL = "http://127.0.0.1:4780/auth?token=abc";
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
    });
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/xdg-open",
      [URL],
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
