import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findClaude,
  isSafeProgramPath,
  planOpen,
  SESSION_IDENTITY_VARIABLES,
  sessionLaunchEnv,
  type Programs,
} from "./programs.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

let root: string;

function touch(path: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccsm-programs-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("findClaude", () => {
  it("uses the native claude.exe inside an npm install", () => {
    const npm = join(root, "npm");
    touch(join(npm, "claude.cmd"));
    const exe = join(
      npm,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    );
    touch(exe);

    expect(findClaude({ PATH: npm })).toBe(exe);
  });

  it("uses a claude.exe found directly on PATH", () => {
    const bin = join(root, "native");
    touch(join(bin, "claude.exe"));
    expect(findClaude({ PATH: bin })).toBe(join(bin, "claude.exe"));
  });

  it("takes the first match in PATH order", () => {
    const first = join(root, "first");
    const second = join(root, "second");
    touch(join(first, "claude.exe"));
    touch(join(second, "claude.exe"));
    expect(findClaude({ PATH: `${first};${second}` })).toBe(
      join(first, "claude.exe"),
    );
  });

  it("never searches relative PATH entries, so a planted file is ignored", () => {
    const planted = join(root, "session");
    touch(join(planted, "claude.exe"));
    const cwd = process.cwd();
    try {
      process.chdir(planted);
      expect(findClaude({ PATH: `.;session;;` })).toBeNull();
    } finally {
      process.chdir(cwd);
    }
  });

  it("ignores an npm shim without the native executable", () => {
    const npm = join(root, "npm");
    touch(join(npm, "claude.cmd"));
    expect(findClaude({ PATH: npm })).toBeNull();
  });

  it("accepts PATH under any capitalization", () => {
    const bin = join(root, "native");
    touch(join(bin, "claude.exe"));
    expect(findClaude({ Path: bin })).toBe(join(bin, "claude.exe"));
  });

  it("skips a location whose path wt would treat specially", () => {
    const bad = join(root, "a;b");
    touch(join(bad, "claude.exe"));
    expect(findClaude({ PATH: `"${bad}"` })).toBeNull();
  });
});

describe("isSafeProgramPath", () => {
  it.each([
    "C:\\a;b\\claude.exe",
    "C:\\%TEMP%\\claude.exe",
    'C:\\"x"\\claude.exe',
    "claude.exe",
    ".\\claude.exe",
  ])("rejects %s", (path) => {
    expect(isSafeProgramPath(path)).toBe(false);
  });

  it("accepts an absolute path with spaces", () => {
    expect(isSafeProgramPath("C:\\Program Files\\Claude\\claude.exe")).toBe(
      true,
    );
  });
});

describe("sessionLaunchEnv", () => {
  it("removes the variables that would hide a new session, and keeps the user's settings", () => {
    const env = sessionLaunchEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_SESSION_ID: SESSION_ID,
      CLAUDE_PID: "123",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_MESSAGING_SOCKET: "x",
      CLAUDE_CODE_SESSION_ATTENDED: "1",
      CLAUDE_JOB_DIR: "x",
      CLAUDE_CODE_EXECPATH: "x",
      CLAUDE_CONFIG_DIR: "D:\\claude",
      CLAUDE_CODE_GIT_BASH_PATH: "D:\\git\\bash.exe",
      PATH: "C:\\bin",
    });

    expect(env).toEqual({
      CLAUDE_CONFIG_DIR: "D:\\claude",
      CLAUDE_CODE_GIT_BASH_PATH: "D:\\git\\bash.exe",
      PATH: "C:\\bin",
    });
  });

  it("lists the identity variables it removes", () => {
    expect(SESSION_IDENTITY_VARIABLES).toContain("CLAUDE_CODE_CHILD_SESSION");
  });
});

describe("planOpen", () => {
  const programs: Programs = {
    claude:
      "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
    wt: "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe",
    cmd: "C:\\Windows\\System32\\cmd.exe",
    powershell:
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  };
  const hostile = "C:\\work\\a & b %PATH% ^x; 'q'";

  it("opens a background session in a new Windows Terminal window", () => {
    const plan = planOpen(
      programs,
      { mode: "attach", id: "abcd1234" },
      hostile,
    );

    expect(plan.file).toBe(programs.wt);
    expect(plan.args).toEqual([
      "-w",
      "new",
      "-d",
      ".",
      "--",
      programs.claude,
      "attach",
      "abcd1234",
    ]);
    expect(plan.cwd).toBe(hostile);
    expect(plan.args.join(" ")).not.toContain("work");
  });

  it("resumes a finished session in its own folder", () => {
    const plan = planOpen(
      programs,
      { mode: "resume", sessionId: SESSION_ID },
      hostile,
    );
    expect(plan.args.slice(-2)).toEqual(["--resume", SESSION_ID]);
    expect(plan.cwd).toBe(hostile);
  });

  it("falls back to a standard console with one exact command string", () => {
    const plan = planOpen(
      { ...programs, wt: null },
      { mode: "attach", id: "abcd1234" },
      hostile,
    );

    expect(plan.file).toBe(programs.cmd);
    expect(plan.windowsVerbatimArguments).toBe(true);
    expect(plan.args).toEqual([
      "/d",
      "/c",
      `start "" "${programs.claude}" attach abcd1234`,
    ]);
    expect(plan.args.join(" ")).not.toContain("work");
  });

  it.each([
    ["a short ID that isn't hex", { mode: "attach", id: "abcd123;" }],
    ["a short ID of the wrong length", { mode: "attach", id: "abcd12345" }],
    [
      "a session ID with a separator",
      { mode: "resume", sessionId: `${SESSION_ID};calc` },
    ],
    [
      "a session ID that isn't a UUID",
      { mode: "resume", sessionId: "../../x" },
    ],
  ] as const)("refuses %s", (_label, target) => {
    expect(() => planOpen(programs, target, root)).toThrow();
  });

  it("refuses when claude.exe wasn't found", () => {
    expect(() =>
      planOpen(
        { ...programs, claude: null },
        { mode: "attach", id: "abcd1234" },
        root,
      ),
    ).toThrow();
  });
});

describe.runIf(process.platform === "win32")(
  "a program planted in the session's folder",
  () => {
    let saved: string | undefined;

    beforeEach(() => {
      // Windows skips the current folder only when this is set, which would make the test pass
      // falsely. Node reads it from this process's own environment.
      saved = process.env.NoDefaultCurrentDirectoryInExePath;
      delete process.env.NoDefaultCurrentDirectoryInExePath;
    });

    afterEach(() => {
      if (saved !== undefined)
        process.env.NoDefaultCurrentDirectoryInExePath = saved;
    });

    it("doesn't run when the resolved program is launched", () => {
      const session = join(root, "session");
      mkdirSync(session);
      const marker = join(root, "planted-ran.txt");
      writeFileSync(
        join(session, "claude.cmd"),
        `@echo planted> "${marker}"\r\n`,
      );
      const fake = join(root, "real", "claude.exe");
      mkdirSync(join(root, "real"));
      copyFileSync(process.execPath, fake);

      // Control: an unqualified launch from that folder does run the planted program.
      spawnSync("claude", ["x"], {
        cwd: session,
        shell: true,
        windowsHide: true,
      });
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);

      const resolved = findClaude({ PATH: join(root, "real") });
      expect(resolved).toBe(fake);
      spawnSync(resolved ?? "", ["-e", "0"], {
        cwd: session,
        windowsHide: true,
      });
      expect(existsSync(marker)).toBe(false);
    });
  },
);
