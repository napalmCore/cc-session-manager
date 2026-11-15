import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "../shared/protocol.js";
import { canSendTo } from "../shared/send.js";
import {
  createActionTracker,
  type ActionExecutors,
  type ActionResult,
} from "./actions.js";
import { sendArguments } from "./launch.js";
import type { DriveTypeReader } from "./local-folder.js";
import type { LaunchPlan, Programs } from "./programs.js";
import { toSessionView } from "./rules.js";
import {
  type BackgroundRun,
  createLauncher,
  type SendRequest,
  type SendTarget,
} from "./start.js";
import type { ListingWatch } from "./stop-delete.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SHORT = "abcd1234";
const HOSTILE = '-p "q" ; a & b | c % ^ ! \\\n--settings x';
const programs: Programs = {
  claude: "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
  wt: null,
  cmd: "C:\\Windows\\System32\\cmd.exe",
  powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
};
const fixed: DriveTypeReader = () => Promise.resolve("Fixed");

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccsm-send-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const exited = (code: number, stdout: string, stderr = ""): BackgroundRun => ({
  kind: "exited",
  code,
  stdout,
  stderr,
});

/** A launcher whose listing watch replays these listings to the predicate. */
function launcher(
  run: (plan: LaunchPlan) => Promise<BackgroundRun>,
  listings: SessionView[][] = [],
) {
  const watch = vi.fn<ListingWatch>((predicate) => {
    for (const sessions of listings) {
      if (predicate(sessions)) {
        return Promise.resolve({ sawSuccess: true, met: true, sessions });
      }
    }
    return Promise.resolve({ sawSuccess: true, met: false, sessions: [] });
  });
  const runSpy = vi.fn(run);
  return {
    l: createLauncher({
      programs,
      driveType: fixed,
      launch: () => Promise.resolve(),
      run: runSpy,
      watch,
    }),
    run: runSpy,
    watch,
  };
}

const request = (message = "carry on"): SendRequest => ({
  action: "send",
  key: SHORT,
  message,
});
const target = (fields: Partial<SendTarget> = {}): SendTarget => ({
  shortId: SHORT,
  sessionId: SESSION_ID,
  folder: root,
  state: "done",
  ...fields,
});
const woke = `note: woke session ${SHORT} with its saved options (--name, --model).\n`;

type Fields = Parameters<typeof toSessionView>[0];
/** A background session; a field set to undefined is left out. */
function bg(fields: { [K in keyof Fields]?: Fields[K] | undefined } = {}) {
  const session = Object.fromEntries(
    Object.entries({
      id: SHORT,
      sessionId: SESSION_ID,
      kind: "background",
      state: "done",
      cwd: "C:\\work",
      ...fields,
    }).filter(([, value]) => value !== undefined),
  );
  return toSessionView(session as Fields);
}

describe("which sessions can take a message (FR-37, 0029)", () => {
  it("is a background session in stopped, done, or failed with no process", () => {
    for (const state of ["stopped", "done", "failed"] as const) {
      expect(canSendTo(bg({ state }))).toBe(true);
    }
    expect(canSendTo(bg({ state: "working" }))).toBe(false);
    expect(canSendTo(bg({ state: "blocked" }))).toBe(false);
    expect(canSendTo(bg({ pid: 42 }))).toBe(false);
    expect(canSendTo(bg({ kind: "interactive" }))).toBe(false);
    expect(canSendTo(bg({ id: undefined }))).toBe(false);
    expect(canSendTo(bg({ sessionId: undefined }))).toBe(false);
    expect(canSendTo(bg({ cwd: undefined }))).toBe(false);
    expect(
      canSendTo(bg({ status: "waiting", waitingFor: "input needed" })),
    ).toBe(false);
  });
});

describe("Send's arguments (C-19)", () => {
  it("passes only --bg, --resume, the session ID, --, and the message", () => {
    expect(sendArguments(SESSION_ID, HOSTILE)).toEqual([
      "--bg",
      "--resume",
      SESSION_ID,
      "--",
      HOSTILE,
    ]);
    expect(() => sendArguments("not-an-id", "hi")).toThrow();
    expect(() => sendArguments(SESSION_ID, "  ")).toThrow();
  });
});

describe("Send in the launcher (FR-37, C-21)", () => {
  it("sends in the session's folder with no shell, and says so without repeating the message", async () => {
    const { l, run } = launcher(() =>
      Promise.resolve(exited(0, `backgrounded · ${SHORT} · name\n`, woke)),
    );
    const result = await l.send(request(HOSTILE), target());
    expect(result).toEqual({
      outcome: "succeeded",
      message: "Message sent. The session is running again.",
    });
    const plan = run.mock.calls[0]?.[0];
    expect(plan?.file).toBe(programs.claude);
    expect(plan?.args).toEqual(["--bg", "--resume", SESSION_ID, "--", HOSTILE]);
    expect(plan?.cwd).toBe(root);
    expect(JSON.stringify(result)).not.toContain("carry");
  });

  it("adds a line when Claude Code doesn't say it restored the saved options", async () => {
    const { l } = launcher(() =>
      Promise.resolve(exited(0, `backgrounded · ${SHORT}\n`, "")),
    );
    const result = await l.send(request(), target());
    expect(result.outcome).toBe("succeeded");
    expect(result.message).toMatch(/didn't say it restored/);
  });

  it("reports a copy Claude Code started instead, with its ID", async () => {
    const { l, watch } = launcher(() =>
      Promise.resolve(
        exited(
          0,
          "backgrounded · 78fe91f0\n",
          `note: session ${SHORT} is already running in the background, so this started a copy as 78fe91f0.\n`,
        ),
      ),
    );
    const result = await l.send(request(), target());
    expect(result).toEqual({
      outcome: "started",
      message:
        "Claude Code started a new session, 78fe91f0, with your message, because this one was running.",
      newSessionId: "78fe91f0",
    });
    expect(watch).not.toHaveBeenCalled();
  });

  it("gives unknown for output it can't match and for a timeout, and never retries", async () => {
    const nothing = launcher(() => Promise.resolve(exited(0, "hello\n")));
    expect((await nothing.l.send(request(), target())).outcome).toBe("unknown");
    expect(nothing.run).toHaveBeenCalledTimes(1);
    const slow = launcher(() => Promise.resolve({ kind: "timeout" }));
    const timed = await slow.l.send(request(), target());
    expect(timed.outcome).toBe("unknown");
    expect(timed.message).toMatch(/may have been sent/);
    expect(slow.run).toHaveBeenCalledTimes(1);
  });

  it("maps a refusal to the tool's own words, and an error to failed", async () => {
    const refused = launcher(() =>
      Promise.resolve(
        exited(
          1,
          "",
          "Workspace not trusted. Run `claude` in C:\\secret once.",
        ),
      ),
    );
    const result = await refused.l.send(request(), target());
    expect(result.outcome).toBe("refused");
    expect(result.message).not.toContain("secret");
    const broken = launcher(() => Promise.resolve({ kind: "error" }));
    expect((await broken.l.send(request(), target())).outcome).toBe("failed");
  });

  it("reports a failure straight away, but not an old one before the session has run", async () => {
    const before = bg({ state: "failed" });
    const running = bg({ state: "working", pid: 7 });
    const failedAgain = bg({ state: "failed" });
    // Still showing its old failure, then running, then failed again.
    const { l } = launcher(
      () => Promise.resolve(exited(0, `backgrounded · ${SHORT}\n`)),
      [[before], [running], [failedAgain]],
    );
    const result = await l.send(request(), target({ state: "failed" }));
    expect(result.outcome).toBe("failed");
    // Only the old failure: not a new one.
    const quiet = launcher(
      () => Promise.resolve(exited(0, `backgrounded · ${SHORT}\n`)),
      [[before], [before]],
    );
    expect(
      (await quiet.l.send(request(), target({ state: "failed" }))).outcome,
    ).toBe("succeeded");
    // A session that was done and shows failed has failed now.
    const done = launcher(
      () => Promise.resolve(exited(0, `backgrounded · ${SHORT}\n`)),
      [[failedAgain]],
    );
    expect((await done.l.send(request(), target())).outcome).toBe("failed");
  });

  it("checks the message and the folder before running anything", async () => {
    const { l, run } = launcher(() => Promise.resolve(exited(0, "")));
    expect((await l.send(request("  "), target())).message).toBe(
      "Type a message to send.",
    );
    expect((await l.send(request("a".repeat(8001)), target())).outcome).toBe(
      "refused",
    );
    expect((await l.send(request("a\u0007b"), target())).outcome).toBe(
      "refused",
    );
    const gone = await l.send(
      request(),
      target({ folder: join(root, "missing") }),
    );
    expect(gone.message).toMatch(/folder can't be used/);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("Send in the action tracker (FR-37, NFR-17)", () => {
  function tracker(options: {
    listing?: SessionView[];
    fresh?: SessionView[] | Error;
    stale?: boolean;
    protectedIds?: string[];
    unknownStarter?: boolean;
    send?: (request: SendRequest, target: SendTarget) => Promise<ActionResult>;
    open?: (session: SessionView) => Promise<ActionResult>;
  }) {
    const send = vi.fn(
      options.send ??
        (() =>
          Promise.resolve({ outcome: "succeeded" as const, message: "Sent." })),
    );
    const executors: ActionExecutors = {
      open:
        options.open ??
        (() => Promise.resolve({ outcome: "started", message: "Opened." })),
    };
    const t = createActionTracker({
      listing: () => ({
        sessions: options.listing ?? [bg()],
        lastSuccessAt: options.stale ? Date.now() - 60_000 : Date.now(),
        lastPollFailed: false,
      }),
      freshListing: () =>
        options.fresh instanceof Error
          ? Promise.reject(options.fresh)
          : Promise.resolve(options.fresh ?? options.listing ?? [bg()]),
      executors,
      isProtected: (session: SessionView) => {
        if (options.unknownStarter) {
          return "The tool can't tell which session started it.";
        }
        return (options.protectedIds ?? []).includes(session.sessionId ?? "");
      },
      send,
    });
    return { t, send };
  }
  const sendTo = (key = SHORT): SendRequest => ({
    action: "send",
    key,
    message: "carry on",
  });

  it("sends to the listed session with its ID and folder from the fresh listing", async () => {
    const { t, send } = tracker({});
    expect((await t.handle(sendTo())).outcome).toBe("succeeded");
    expect(send.mock.calls[0]?.[1]).toEqual({
      shortId: SHORT,
      sessionId: SESSION_ID,
      folder: "C:\\work",
      state: "done",
    });
    // The user's own action, so its changes don't notify for a while.
    expect(t.ownActionSessions()).toContain(SESSION_ID);
  });

  it("refuses a running session, the protected one, and every session while the starter is unknown", async () => {
    const running = tracker({ listing: [bg({ pid: 9, state: "working" })] });
    expect((await running.t.handle(sendTo())).outcome).toBe("refused");
    const own = tracker({ protectedIds: [SESSION_ID] });
    expect((await own.t.handle(sendTo())).outcome).toBe("refused");
    const unknown = tracker({ unknownStarter: true });
    expect((await unknown.t.handle(sendTo())).outcome).toBe("refused");
    expect(running.send).not.toHaveBeenCalled();
    expect(own.send).not.toHaveBeenCalled();
    expect(unknown.send).not.toHaveBeenCalled();
  });

  it("refuses an out-of-date listing, a session that changed, and gives unknown if it can't check", async () => {
    expect((await tracker({ stale: true }).t.handle(sendTo())).message).toMatch(
      /out of date/,
    );
    const changed = tracker({ fresh: [bg({ pid: 5, state: "working" })] });
    expect((await changed.t.handle(sendTo())).message).toMatch(/changed/);
    const removed = tracker({ fresh: [] });
    expect((await removed.t.handle(sendTo())).outcome).toBe("refused");
    const failing = tracker({ fresh: new Error("no") });
    expect((await failing.t.handle(sendTo())).outcome).toBe("unknown");
    expect(changed.send).not.toHaveBeenCalled();
    expect(removed.send).not.toHaveBeenCalled();
  });

  it("holds notifications only once Claude Code has run, not after a refusal (I-4)", async () => {
    const { t } = tracker({
      send: () =>
        Promise.resolve({ outcome: "refused", message: "Not that folder." }),
    });
    expect((await t.handle(sendTo())).outcome).toBe("refused");
    expect(t.ownActionSessions()).not.toContain(SESSION_ID);
  });

  it("shares the per-session lock with Open", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<ActionResult>((resolve) => {
      release = () => {
        resolve({ outcome: "started", message: "Opened." });
      };
    });
    const { t, send } = tracker({ open: () => held });
    const opening = t.handle({ action: "open", key: SHORT });
    const result = await t.handle(sendTo());
    expect(result.message).toMatch(/Another action/);
    expect(send).not.toHaveBeenCalled();
    release();
    await opening;
  });
});

describe("security review of iteration 5", () => {
  it("gives unknown when Claude Code printed too much to read, since the message may have gone (L-2)", async () => {
    const { l } = launcher(() => Promise.resolve({ kind: "overflow" }));
    const result = await l.send(request(), target());
    expect(result.outcome).toBe("unknown");
    expect(result.message).toMatch(/may have been sent/);
  });

  it("matches only Claude Code's own first line for a refusal, and the note only as a line (I-1, I-2)", async () => {
    const echoed = launcher(() =>
      Promise.resolve(
        exited(1, "", "Session not found.\nyour message said: please update"),
      ),
    );
    expect((await echoed.l.send(request(), target())).message).toBe(
      "Claude Code refused the message.",
    );
    const faked = launcher(() =>
      Promise.resolve(
        exited(0, `backgrounded · ${SHORT}\n`, `prompt: ${woke.trim()}\n`),
      ),
    );
    expect((await faked.l.send(request(), target())).message).toMatch(
      /didn't say it restored/,
    );
  });
});
