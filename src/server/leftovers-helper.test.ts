import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHelperRunner, helperScriptPath } from "./end.js";
import {
  createInputRunner,
  parseCheck,
  parseEndLeftovers,
  parseRecord,
} from "./leftovers-helper.js";
import { resolvePrograms } from "./programs.js";

describe("parseRecord", () => {
  it("reads the session and its entries", () => {
    expect(
      parseRecord({
        session: { pid: 10, startMs: 1000 },
        entries: [
          {
            pid: 11,
            startMs: 1001,
            name: "sleep.exe",
            path: "C:\\x\\sleep.exe",
          },
          { pid: 12, startMs: 1002, name: "a.exe", path: null },
        ],
      }),
    ).toEqual({
      session: { pid: 10, startMs: 1000 },
      entries: [
        { pid: 11, startMs: 1001, name: "sleep.exe", path: "C:\\x\\sleep.exe" },
        { pid: 12, startMs: 1002, name: "a.exe", path: "" },
      ],
    });
  });

  it("drops malformed entries, and rejects a record with no session", () => {
    expect(
      parseRecord({
        session: { pid: 10, startMs: 1000 },
        entries: [
          { pid: -1, startMs: 1, name: "", path: "" },
          { pid: 1.5, startMs: 1, name: "", path: "" },
          { pid: 2, startMs: 1, name: 3, path: "" },
          { pid: 3, startMs: 1, name: "x".repeat(40_000), path: "" },
          "nonsense",
        ],
      })?.entries,
    ).toEqual([]);
    expect(parseRecord({ entries: [] })).toBeNull();
    expect(parseRecord(null)).toBeNull();
    expect(parseRecord([])).toBeNull();
  });
});

describe("parseCheck and parseEndLeftovers", () => {
  it("reads a check result", () => {
    expect(
      parseCheck({
        ok: true,
        action: "check",
        running: [{ pid: 1, startMs: 2 }, { pid: "x" }],
        unverified: [],
        children: [
          { pid: 5, startMs: 6, name: "n", path: "p", parentPid: 1 },
          { pid: 7, startMs: 8, name: "n", path: "p" },
        ],
      }),
    ).toEqual({
      running: [{ pid: 1, startMs: 2 }],
      unverified: [],
      children: [{ pid: 5, startMs: 6, name: "n", path: "p", parentPid: 1 }],
    });
    expect(parseCheck({ ok: false, action: "check" })).toBeNull();
  });

  it("reads an end-leftovers result", () => {
    expect(
      parseEndLeftovers({
        ok: true,
        action: "end-leftovers",
        requested: 3,
        ended: [4, "5"],
        skipped: [{ pid: 6, reason: "different-program" }, { pid: 7 }],
      }),
    ).toEqual({
      requested: 3,
      ended: [4],
      skipped: [{ pid: 6, reason: "different-program" }],
    });
    expect(parseEndLeftovers({ ok: true, action: "check" })).toBeNull();
  });
});

const powershell = resolvePrograms().powershell;
const script = helperScriptPath();
// A cold Windows PowerShell on a busy CI runner can take far longer than the tool's own 10 s
// limit, which stays as it is; these tests give the real helper more room (BUG-40).
const SLOW = 120_000;
const TEST_HELPER_TIMEOUT_MS = 45_000;

/** Start time and image path, read the way the helper reads them. */
function identify(pid: number): { startMs: number; path: string } {
  if (powershell === null) throw new Error("no PowerShell");
  const out = execFileSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p = Get-Process -Id ${String(pid)}; [DateTimeOffset]::new($p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds(); $p.Path`,
    ],
    { encoding: "utf8", windowsHide: true },
  )
    .trim()
    .split(/\r?\n/);
  return { startMs: Number(out[0]), path: out[1] ?? "" };
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.runIf(process.platform === "win32" && powershell !== null)(
  "the real helper, on harmless processes",
  () => {
    beforeAll(() => {
      execFileSync(
        powershell ?? "",
        ["-NoProfile", "-NonInteractive", "-Command", "$null"],
        { timeout: SLOW, windowsHide: true },
      );
    }, SLOW);

    const children: ChildProcess[] = [];
    const extraPids: number[] = [];
    const sleeper = (code = "setTimeout(() => {}, 60000)") => {
      const child = spawn(process.execPath, ["-e", code], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      children.push(child);
      if (child.pid === undefined) throw new Error("no pid");
      return child.pid;
    };

    afterEach(() => {
      for (const child of children.splice(0)) child.kill();
      for (const pid of extraPids.splice(0)) {
        try {
          process.kill(pid);
        } catch {
          // Already gone.
        }
      }
    });

    // Not the tool's process, so the test's own children aren't protected as the tool's.
    const unrelatedTool = () =>
      createInputRunner(powershell ?? "", script, 0, TEST_HELPER_TIMEOUT_MS);

    it(
      "reports which processes still run, by process ID and start time",
      async () => {
        const pid = sleeper();
        const { startMs } = identify(pid);

        const outcome = await unrelatedTool()("check", {
          processes: [
            { pid, startMs },
            { pid, startMs: startMs - 60_000 },
            { pid: 999_999_999, startMs },
          ],
          parents: [],
        });

        expect(outcome.kind).toBe("ok");
        if (outcome.kind !== "ok") return;
        expect(parseCheck(outcome.result)).toEqual({
          running: [{ pid, startMs }],
          unverified: [],
          children: [],
        });
      },
      SLOW,
    );

    it(
      "finds new children of a recorded parent, but never the tool's own",
      async () => {
        const parent = spawn(
          process.execPath,
          [
            "-e",
            "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); console.log(c.pid); setTimeout(() => {}, 60000);",
          ],
          { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
        );
        children.push(parent);
        const grandchild = await new Promise<number>((resolve) => {
          parent.stdout.once("data", (data: Buffer) => {
            resolve(Number(data.toString().trim()));
          });
        });
        extraPids.push(grandchild);
        const parentPid = parent.pid ?? 0;
        const { startMs } = identify(parentPid);
        const request = {
          processes: [{ pid: parentPid, startMs }],
          parents: [{ pid: parentPid, startMs }],
        };

        const found = await unrelatedTool()("check", request);
        expect(found.kind).toBe("ok");
        if (found.kind !== "ok") return;
        expect(parseCheck(found.result)?.children).toEqual([
          expect.objectContaining({
            pid: grandchild,
            parentPid,
            name: "node.exe",
          }),
        ]);

        // As the tool, its own descendants are never offered.
        const asTool = await createInputRunner(
          powershell ?? "",
          script,
          process.pid,
          TEST_HELPER_TIMEOUT_MS,
        )("check", request);
        expect(asTool.kind).toBe("ok");
        if (asTool.kind !== "ok") return;
        expect(parseCheck(asTool.result)?.children).toEqual([]);
      },
      SLOW,
    );

    it(
      "ends only an entry whose start time and image path match",
      async () => {
        const pid = sleeper();
        const { startMs, path } = identify(pid);
        const other = sleeper();
        const otherStart = identify(other).startMs;

        const mismatched = await unrelatedTool()("end-leftovers", {
          entries: [
            { pid, startMs, path: "C:\\Windows\\notepad.exe" },
            { pid: other, startMs: otherStart - 60_000, path },
          ],
        });
        expect(mismatched.kind).toBe("ok");
        if (mismatched.kind !== "ok") return;
        expect(parseEndLeftovers(mismatched.result)).toEqual({
          requested: 2,
          ended: [],
          skipped: [
            { pid, reason: "different-program" },
            { pid: other, reason: "different-process" },
          ],
        });
        expect(running(pid)).toBe(true);

        const matched = await unrelatedTool()("end-leftovers", {
          entries: [{ pid, startMs, path }],
        });
        expect(matched.kind).toBe("ok");
        if (matched.kind !== "ok") return;
        expect(parseEndLeftovers(matched.result)?.ended).toEqual([pid]);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(running(pid)).toBe(false);
      },
      SLOW,
    );

    it(
      "never ends the tool's own processes",
      async () => {
        const pid = sleeper();
        const { startMs, path } = identify(pid);

        const outcome = await createInputRunner(
          powershell ?? "",
          script,
          process.pid,
          TEST_HELPER_TIMEOUT_MS,
        )("end-leftovers", { entries: [{ pid, startMs, path }] });

        expect(outcome.kind).toBe("ok");
        if (outcome.kind !== "ok") return;
        expect(parseEndLeftovers(outcome.result)?.skipped).toEqual([
          { pid, reason: "protected" },
        ]);
        expect(running(pid)).toBe(true);
      },
      SLOW,
    );

    it(
      "ignores entries that aren't whole positive numbers with a path",
      async () => {
        const outcome = await unrelatedTool()("end-leftovers", {
          entries: [
            { pid: "1", startMs: 1, path: "x" },
            { pid: 1, startMs: -1, path: "x" },
            { pid: 1, startMs: 1 },
            null,
          ],
        });
        expect(outcome.kind).toBe("ok");
        if (outcome.kind !== "ok") return;
        expect(parseEndLeftovers(outcome.result)).toEqual({
          requested: 0,
          ended: [],
          skipped: [],
        });
      },
      SLOW,
    );

    it(
      "records nothing for a process that isn't a Claude Code session",
      async () => {
        const pid = sleeper();
        const { startMs } = identify(pid);

        const outcome = await createHelperRunner(
          powershell ?? "",
          script,
          TEST_HELPER_TIMEOUT_MS,
        )({
          action: "record",
          pid,
          startedAtMs: startMs,
          toolPid: process.pid,
        });

        expect(outcome).toMatchObject({
          kind: "ok",
          result: { ok: false, reason: "wrong-image" },
        });
      },
      SLOW,
    );

    it(
      "ends each listed process once, and reports an exited one as not running",
      async () => {
        const pid = sleeper();
        const { startMs, path } = identify(pid);
        const gone = sleeper("process.exit(0)");
        await new Promise((resolve) => setTimeout(resolve, 500));

        const outcome = await unrelatedTool()("end-leftovers", {
          entries: [
            { pid, startMs, path },
            { pid, startMs, path },
            { pid: gone, startMs, path },
          ],
        });

        expect(outcome.kind).toBe("ok");
        if (outcome.kind !== "ok") return;
        expect(parseEndLeftovers(outcome.result)).toEqual({
          requested: 2,
          ended: [pid],
          skipped: [{ pid: gone, reason: "not-running" }],
        });
      },
      SLOW,
    );

    describe("with a real target named claude.exe", () => {
      let folder = "";
      afterEach(async () => {
        // The copy can't be deleted while it runs.
        for (const child of children.splice(0)) child.kill();
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (folder !== "") {
          rmSync(folder, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 200,
          });
        }
        folder = "";
      });

      /** A copy of node named claude.exe, which starts ping and prints its process ID. */
      const fakeSession = async () => {
        folder = mkdtempSync(join(tmpdir(), "ccsm-claude-"));
        const exe = join(folder, "claude.exe");
        copyFileSync(process.execPath, exe);
        const session = spawn(
          exe,
          [
            "-e",
            "const c = require('child_process').spawn('ping', ['-n', '60', '127.0.0.1'], { stdio: 'ignore' }); console.log(c.pid); setTimeout(() => {}, 60000);",
          ],
          { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
        );
        children.push(session);
        const ping = await new Promise<number>((resolve) => {
          session.stdout.once("data", (data: Buffer) => {
            resolve(Number(data.toString().trim()));
          });
        });
        extraPids.push(ping);
        return { session: session.pid ?? 0, ping };
      };

      it(
        "records the session's programs, and they can be checked and ended",
        async () => {
          const { session, ping } = await fakeSession();
          const { startMs } = identify(session);

          const recorded = await createHelperRunner(
            powershell ?? "",
            script,
            TEST_HELPER_TIMEOUT_MS,
          )({
            action: "record",
            pid: session,
            startedAtMs: startMs,
            toolPid: 0,
          });

          expect(recorded).toMatchObject({
            kind: "ok",
            result: { ok: true, reason: "recorded" },
          });
          if (recorded.kind !== "ok") return;
          const record = parseRecord(recorded.result.record);
          expect(record?.session).toEqual({ pid: session, startMs });
          expect(record?.entries).toEqual([
            expect.objectContaining({ pid: ping, name: "PING.EXE" }),
          ]);
          const entry = record?.entries[0];
          if (!entry) return;
          expect(entry.path.toLowerCase()).toMatch(/system32.ping\.exe$/);

          const ended = await unrelatedTool()("end-leftovers", {
            entries: [entry],
          });
          expect(
            ended.kind === "ok" && parseEndLeftovers(ended.result)?.ended,
          ).toEqual([ping]);
          expect(running(session)).toBe(true);
        },
        SLOW,
      );

      it(
        "still runs inspect on a real target (no regression)",
        async () => {
          const { session } = await fakeSession();
          const { startMs } = identify(session);

          const outcome = await createHelperRunner(
            powershell ?? "",
            script,
            TEST_HELPER_TIMEOUT_MS,
          )({
            action: "inspect",
            pid: session,
            startedAtMs: startMs,
          });

          expect(outcome.kind).toBe("ok");
          if (outcome.kind !== "ok") return;
          expect(outcome.result.startMs).toBe(startMs);
          expect(outcome.result.descendants).toEqual(
            expect.arrayContaining([expect.any(Number)]),
          );
        },
        SLOW,
      );
    });
  },
);
