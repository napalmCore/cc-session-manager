import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "../shared/protocol.js";
import {
  createActionTracker,
  type ActionExecutors,
  type ActionResult,
} from "./actions.js";
import type { DriveTypeReader } from "./local-folder.js";
import type { LaunchPlan, Programs } from "./programs.js";
import { toSessionView } from "./rules.js";
import {
  type BackgroundRun,
  createLauncher,
  type ForkRequest,
} from "./start.js";
import type { ListingWatch } from "./stop-delete.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const PAST_ID = "22222222-2222-4222-8222-222222222222";
const programs: Programs = {
  claude: "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
  wt: "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe",
  cmd: "C:\\Windows\\System32\\cmd.exe",
  powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
};
const fixed: DriveTypeReader = () => Promise.resolve("Fixed");

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccsm-fork-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function launcher(
  run: (plan: LaunchPlan) => Promise<BackgroundRun>,
  extra: Partial<Programs> = {},
) {
  const launch = vi.fn<
    (plan: LaunchPlan, env: NodeJS.ProcessEnv) => Promise<void>
  >(() => Promise.resolve());
  const watch = vi.fn<ListingWatch>(() =>
    Promise.resolve({ sawSuccess: true, met: false, sessions: [] }),
  );
  const runSpy = vi.fn(run);
  return {
    l: createLauncher({
      programs: { ...programs, ...extra },
      driveType: fixed,
      launch,
      run: runSpy,
      watch,
    }),
    launch,
    run: runSpy,
  };
}

describe("Fork (FR-33)", () => {
  const request = (fields: Partial<ForkRequest> = {}): ForkRequest => ({
    action: "fork",
    key: SESSION_ID,
    kind: "background",
    prompt: "carry on",
    ...fields,
  });

  it("forks in the background with --resume and --fork-session before --", async () => {
    const { l, run } = launcher(() =>
      Promise.resolve({
        kind: "exited",
        code: 0,
        stdout: "backgrounded · abcd1234\n",
        stderr: "",
      }),
    );
    const result = await l.fork(request({ name: "copy" }), {
      sessionId: SESSION_ID,
      folder: root,
    });
    expect(result).toEqual({
      outcome: "succeeded",
      message: "Forked in the background.",
    });
    const plan = run.mock.calls[0]?.[0];
    expect(plan?.args).toEqual([
      "--resume",
      SESSION_ID,
      "--fork-session",
      "--bg",
      "--name=copy",
      "--",
      "carry on",
    ]);
    // Run in the folder as the session recorded it, after its resolved path was checked.
    expect(plan?.cwd).toBe(root);
  });

  it("forks interactively in a new terminal, with the folder only as its working folder", async () => {
    const { l, launch } = launcher(() => Promise.resolve({ kind: "error" }));
    const result = await l.fork(
      request({ kind: "interactive", prompt: undefined }),
      {
        sessionId: SESSION_ID,
        folder: root,
      },
    );
    expect(result.outcome).toBe("started");
    const plan = launch.mock.calls[0]?.[0];
    expect(plan?.file).toBe(programs.wt);
    expect(plan?.args.slice(-4)).toEqual([
      "--resume",
      SESSION_ID,
      "--fork-session",
      "--",
    ]);
    expect(plan?.args.join(" ")).not.toContain(root);
  });

  it("refuses a folder that's gone or isn't local, and bad text, before running anything", async () => {
    const { l, run } = launcher(() => Promise.resolve({ kind: "error" }));
    const gone = await l.fork(request(), {
      sessionId: SESSION_ID,
      folder: join(root, "gone"),
    });
    expect(gone.outcome).toBe("refused");
    const share = await l.fork(request(), {
      sessionId: SESSION_ID,
      folder: "\\\\server\\share",
    });
    expect(share.outcome).toBe("refused");
    const named = await l.fork(request({ name: "100%" }), {
      sessionId: SESSION_ID,
      folder: root,
    });
    expect(named.outcome).toBe("refused");
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a named interactive fork without Windows Terminal", async () => {
    const { l, launch } = launcher(() => Promise.resolve({ kind: "error" }), {
      wt: null,
    });
    const result = await l.fork(
      request({ kind: "interactive", prompt: undefined, name: "x" }),
      {
        sessionId: SESSION_ID,
        folder: root,
      },
    );
    expect(result.outcome).toBe("refused");
    expect(result.message).toMatch(/Start the fork without a name/);
    expect(launch).not.toHaveBeenCalled();
  });
});

function tracker(options: {
  listing?: SessionView[];
  fresh?: SessionView[];
  historyFolder?: (id: string) => Promise<string | null>;
  transcriptExists?: (id: string) => Promise<boolean>;
  lastActivity?: (id: string) => Promise<number | null>;
  stale?: boolean;
  fork?: (
    request: ForkRequest,
    target: { sessionId: string; folder: string },
  ) => Promise<ActionResult>;
  resume?: (session: SessionView) => Promise<ActionResult>;
}) {
  const fork = vi.fn(
    options.fork ??
      (() =>
        Promise.resolve({ outcome: "succeeded" as const, message: "Forked." })),
  );
  const resume = vi.fn(
    options.resume ??
      (() =>
        Promise.resolve({
          outcome: "started" as const,
          message: "Terminal started.",
        })),
  );
  const executors: ActionExecutors = { resume };
  const t = createActionTracker({
    listing: () => ({
      sessions: options.listing ?? [],
      lastSuccessAt: options.stale ? Date.now() - 60_000 : Date.now(),
      lastPollFailed: false,
    }),
    freshListing: () => Promise.resolve(options.fresh ?? options.listing ?? []),
    executors,
    isProtected: () => true,
    fork,
    historyFolder: options.historyFolder ?? (() => Promise.resolve(null)),
    transcriptExists: options.transcriptExists ?? (() => Promise.resolve(true)),
    lastActivity: options.lastActivity ?? (() => Promise.resolve(0)),
  });
  return { t, fork, resume };
}

describe("Fork in the action tracker (FR-33, NFR-14)", () => {
  const listed = toSessionView({
    sessionId: SESSION_ID,
    kind: "interactive",
    status: "busy",
    pid: 100,
    cwd: "C:\\work\\listed",
  });

  it("takes the session's ID and folder from the listing, even for a protected session", async () => {
    const { t, fork } = tracker({ listing: [listed] });
    const result = await t.handle({
      action: "fork",
      key: SESSION_ID,
      kind: "interactive",
    });
    expect(result.outcome).toBe("succeeded");
    expect(fork.mock.calls[0]?.[1]).toEqual({
      sessionId: SESSION_ID,
      folder: "C:\\work\\listed",
    });
  });

  it("finds a session Claude Code no longer lists in History", async () => {
    const { t, fork } = tracker({
      historyFolder: () => Promise.resolve("C:\\work\\past"),
    });
    await t.handle({ action: "fork", key: PAST_ID, kind: "interactive" });
    expect(fork.mock.calls[0]?.[1]).toEqual({
      sessionId: PAST_ID,
      folder: "C:\\work\\past",
    });
  });

  it("refuses an unknown session, a malformed key, and one with no saved conversation", async () => {
    const unknown = tracker({});
    expect(
      (
        await unknown.t.handle({
          action: "fork",
          key: PAST_ID,
          kind: "interactive",
        })
      ).outcome,
    ).toBe("refused");
    expect(
      (
        await unknown.t.handle({
          action: "fork",
          key: "../x",
          kind: "interactive",
        })
      ).outcome,
    ).toBe("refused");
    const noTranscript = tracker({
      listing: [listed],
      transcriptExists: () => Promise.resolve(false),
    });
    const result = await noTranscript.t.handle({
      action: "fork",
      key: SESSION_ID,
      kind: "interactive",
    });
    expect(result.message).toMatch(/no saved conversation/);
    expect(unknown.fork).not.toHaveBeenCalled();
    expect(noTranscript.fork).not.toHaveBeenCalled();
  });

  it("runs one Fork per session at a time", async () => {
    let release: () => void = () => undefined;
    const { t, fork } = tracker({
      listing: [listed],
      fork: () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ outcome: "succeeded", message: "Forked." });
          };
        }),
    });
    const first = t.handle({
      action: "fork",
      key: SESSION_ID,
      kind: "interactive",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      (await t.handle({ action: "fork", key: SESSION_ID, kind: "interactive" }))
        .outcome,
    ).toBe("refused");
    release();
    expect((await first).outcome).toBe("succeeded");
    expect(fork).toHaveBeenCalledTimes(1);
  });
});

describe("Resume from History (FR-35, FR-14, C-9)", () => {
  it("resumes a session Claude Code no longer lists, in its folder from History", async () => {
    const { t, resume } = tracker({
      historyFolder: () => Promise.resolve("C:\\work\\past"),
    });
    const result = await t.handle({ action: "resume", key: PAST_ID });
    expect(result.outcome).toBe("started");
    expect(resume.mock.calls[0]?.[0]).toMatchObject({
      sessionId: PAST_ID,
      cwd: "C:\\work\\past",
      kind: "interactive",
      finished: true,
    });
  });

  it("refuses when the fresh listing shows the session again", async () => {
    const again = toSessionView({
      sessionId: PAST_ID,
      kind: "interactive",
      status: "busy",
      pid: 9,
    });
    const { t, resume } = tracker({
      historyFolder: () => Promise.resolve("C:\\work\\past"),
      fresh: [again],
    });
    expect((await t.handle({ action: "resume", key: PAST_ID })).outcome).toBe(
      "refused",
    );
    expect(resume).not.toHaveBeenCalled();
  });

  it("refuses while a session in its folder has no ID yet, or it was active in the last minute (C-9)", async () => {
    const starting = toSessionView({
      id: "abcd1234",
      kind: "background",
      state: "working",
      cwd: "c:\\WORK\\past",
    });
    const early = tracker({
      historyFolder: () => Promise.resolve("C:\\work\\past"),
      fresh: [starting],
    });
    expect(
      (await early.t.handle({ action: "resume", key: PAST_ID })).message,
    ).toMatch(/still starting/);
    const recent = tracker({
      historyFolder: () => Promise.resolve("C:\\work\\past"),
      lastActivity: () => Promise.resolve(Date.now() - 5_000),
    });
    expect(
      (await recent.t.handle({ action: "resume", key: PAST_ID })).message,
    ).toMatch(/active in the last minute/);
    expect(early.resume).not.toHaveBeenCalled();
    expect(recent.resume).not.toHaveBeenCalled();
  });

  it("refuses when History doesn't know it, or the listing is out of date", async () => {
    expect(
      (await tracker({}).t.handle({ action: "resume", key: PAST_ID })).outcome,
    ).toBe("refused");
    const stale = tracker({
      historyFolder: () => Promise.resolve("C:\\work\\past"),
      stale: true,
    });
    expect(
      (await stale.t.handle({ action: "resume", key: PAST_ID })).message,
    ).toMatch(/out of date/);
    expect(stale.resume).not.toHaveBeenCalled();
  });
});
