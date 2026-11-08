import { describe, expect, it } from "vitest";
import {
  createProtection,
  PROTECTED_MESSAGE,
  processStartMs,
  readIdentity,
  UNKNOWN_MESSAGE,
} from "./protect.js";
import { toSessionView } from "./rules.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

const interactive = (sessionId: string, pid: number, startedAt = 10_500) =>
  toSessionView({
    sessionId,
    kind: "interactive",
    status: "idle",
    pid,
    startedAt,
    cwd: "C:\\work",
  });

describe("readIdentity", () => {
  it("reads the session and process Claude Code passes to the programs it starts", () => {
    expect(
      readIdentity({
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: SESSION_ID,
        CLAUDE_PID: "4321",
      }),
    ).toEqual({ insideClaude: true, sessionId: SESSION_ID, pid: 4321 });
  });

  it("is outside Claude Code with none of the variables", () => {
    expect(readIdentity({ PATH: "x" })).toEqual({ insideClaude: false });
  });

  it("counts a child session as inside, even with no IDs", () => {
    expect(readIdentity({ CLAUDE_CODE_CHILD_SESSION: "1" })).toEqual({
      insideClaude: true,
    });
  });

  it("ignores malformed values but still counts the start as inside", () => {
    expect(
      readIdentity({ CLAUDE_CODE_SESSION_ID: "nope", CLAUDE_PID: "12; rm" }),
    ).toEqual({ insideClaude: true });
    expect(readIdentity({ CLAUDE_PID: "0" })).toEqual({ insideClaude: true });
  });
});

describe("createProtection", () => {
  it("protects nothing when the tool wasn't started from Claude Code", () => {
    const protection = createProtection([{ insideClaude: false }]);
    protection.observe([interactive(SESSION_ID, 100)]);
    expect(protection.isProtected(interactive(SESSION_ID, 100))).toBe(false);
    expect(protection.blockedReason()).toBeNull();
  });

  it("protects the session by its session ID, and leaves others alone once it's listed", () => {
    const protection = createProtection([
      { insideClaude: true, sessionId: SESSION_ID },
    ]);
    protection.observe([
      interactive(SESSION_ID, 100),
      interactive(OTHER_ID, 200),
    ]);
    expect(protection.isProtected(interactive(SESSION_ID, 100))).toBe(
      PROTECTED_MESSAGE,
    );
    expect(protection.isProtected(interactive(OTHER_ID, 200))).toBe(false);
    expect(protection.blockedReason()).toBeNull();
  });

  it("protects by process ID when the start times agree", () => {
    const protection = createProtection([
      { insideClaude: true, pid: 100, pidStartMs: 10_000 },
    ]);
    protection.observe([interactive(OTHER_ID, 100, 10_500)]);
    expect(protection.isProtected(interactive(OTHER_ID, 100, 10_500))).toBe(
      PROTECTED_MESSAGE,
    );
  });

  it("doesn't protect a reused process ID with a different start time", () => {
    const protection = createProtection([
      {
        insideClaude: true,
        sessionId: SESSION_ID,
        pid: 100,
        pidStartMs: 10_000,
      },
    ]);
    protection.observe([interactive(SESSION_ID, 300)]);
    expect(protection.isProtected(interactive(OTHER_ID, 100, 90_000))).toBe(
      false,
    );
  });

  it("protects a process ID when no start time is known", () => {
    const protection = createProtection([{ insideClaude: true, pid: 100 }]);
    protection.observe([interactive(OTHER_ID, 100, 90_000)]);
    expect(protection.isProtected(interactive(OTHER_ID, 100, 90_000))).toBe(
      PROTECTED_MESSAGE,
    );
  });

  it("turns actions off for every session until the starting session is listed", () => {
    const protection = createProtection([
      { insideClaude: true, sessionId: SESSION_ID },
    ]);
    protection.observe([interactive(OTHER_ID, 200)]);
    expect(protection.blockedReason()).toBe(UNKNOWN_MESSAGE);
    expect(protection.isProtected(interactive(OTHER_ID, 200))).toBe(
      UNKNOWN_MESSAGE,
    );

    protection.observe([
      interactive(SESSION_ID, 100),
      interactive(OTHER_ID, 200),
    ]);
    expect(protection.blockedReason()).toBeNull();
    expect(protection.isProtected(interactive(OTHER_ID, 200))).toBe(false);
  });

  it("keeps actions off when the start has no IDs at all", () => {
    const protection = createProtection([{ insideClaude: true }]);
    protection.observe([interactive(SESSION_ID, 100)]);
    expect(protection.blockedReason()).toBe(UNKNOWN_MESSAGE);
  });

  it("stays protected, without blocking others, after the session leaves the list", () => {
    const protection = createProtection([
      { insideClaude: true, sessionId: SESSION_ID },
    ]);
    protection.observe([interactive(SESSION_ID, 100)]);
    protection.observe([interactive(OTHER_ID, 200)]);
    expect(protection.blockedReason()).toBeNull();
    expect(protection.isProtected(interactive(SESSION_ID, 100))).toBe(
      PROTECTED_MESSAGE,
    );
  });

  it("adds sessions from a handover", () => {
    const protection = createProtection([{ insideClaude: false }]);
    protection.add({ insideClaude: true, sessionId: OTHER_ID });
    protection.observe([interactive(OTHER_ID, 200)]);
    expect(protection.isProtected(interactive(OTHER_ID, 200))).toBe(
      PROTECTED_MESSAGE,
    );
  });
});

describe("processStartMs", () => {
  it("is null without PowerShell or with an invalid process ID", async () => {
    expect(await processStartMs(null, 100)).toBeNull();
    expect(await processStartMs("powershell.exe", 0)).toBeNull();
    expect(await processStartMs("powershell.exe", 1.5)).toBeNull();
  });

  it.runIf(process.platform === "win32")(
    "reads this process's start time",
    async () => {
      const value = await processStartMs(
        `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
        process.pid,
      );
      expect(value).not.toBeNull();
      expect(
        Math.abs((value ?? 0) - (Date.now() - process.uptime() * 1000)),
      ).toBeLessThan(5_000);
    },
    20_000,
  );
});
