import { describe, expect, it } from "vitest";
import {
  claudeArguments,
  consoleSafe,
  planBackground,
  planTerminal,
  windowsTerminalArgument,
} from "./launch.js";
import type { Programs } from "./programs.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const HOSTILE_PROMPT =
  '--dangerously-skip-permissions "q" ; a;b %PATH% ^ & | ! \\\r\n\tend\\';
const HOSTILE_NAME = '-n "q" ; a;b ^ & | ! \\';

const programs: Programs = {
  claude: "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
  wt: "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe",
  cmd: "C:\\Windows\\System32\\cmd.exe",
  powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
};

describe("claude arguments (C-15)", () => {
  it("starts a background session with the prompt after --", () => {
    expect(
      claudeArguments({ kind: "background", prompt: HOSTILE_PROMPT }),
    ).toEqual(["--bg", "--", HOSTILE_PROMPT]);
  });

  it("puts a name before --, however it looks", () => {
    expect(
      claudeArguments({
        kind: "background",
        name: "--fork-session",
        prompt: "-p",
      }),
    ).toEqual(["--bg", "--name=--fork-session", "--", "-p"]);
  });

  it("starts an interactive session with only a name", () => {
    expect(
      claudeArguments({ kind: "interactive", name: HOSTILE_NAME }),
    ).toEqual([`--name=${HOSTILE_NAME}`, "--"]);
    expect(claudeArguments({ kind: "interactive" })).toEqual(["--"]);
  });

  it("always passes --fork-session for a fork, of either kind", () => {
    expect(
      claudeArguments({
        kind: "background",
        forkOf: SESSION_ID,
        prompt: "go on",
      }),
    ).toEqual([
      "--resume",
      SESSION_ID,
      "--fork-session",
      "--bg",
      "--",
      "go on",
    ]);
    expect(
      claudeArguments({ kind: "interactive", forkOf: SESSION_ID, name: "b" }),
    ).toEqual(["--resume", SESSION_ID, "--fork-session", "--name=b", "--"]);
  });

  it("passes only the four allowed options, always before --", () => {
    const all = [
      claudeArguments({
        kind: "background",
        forkOf: SESSION_ID,
        name: "n",
        prompt: "--settings x",
      }),
      claudeArguments({ kind: "interactive", name: "--agents" }),
    ];
    for (const args of all) {
      const options = args.slice(0, args.indexOf("--"));
      const flags = options.filter((arg) => arg.startsWith("-"));
      expect(
        flags.every(
          (flag) =>
            ["--bg", "--resume", "--fork-session"].includes(flag) ||
            flag.startsWith("--name="),
        ),
      ).toBe(true);
    }
  });

  it("refuses a background start without a prompt, and a prompt for an interactive one", () => {
    expect(() => claudeArguments({ kind: "background" })).toThrow();
    expect(() =>
      claudeArguments({ kind: "background", prompt: "  " }),
    ).toThrow();
    expect(() =>
      claudeArguments({ kind: "interactive", prompt: "hello" }),
    ).toThrow();
  });

  it("refuses a malformed session ID for a fork", () => {
    expect(() =>
      claudeArguments({ kind: "interactive", forkOf: `${SESSION_ID};x` }),
    ).toThrow();
  });
});

describe("Windows Terminal escaping (U-24)", () => {
  it.each([
    ["plain", "plain"],
    ["a;b", "a\\;b"],
    ["a b;c", "a b\\;c"],
    ['say "hi"', 'say \\"hi\\"'],
    ["ends\\", "ends\\"],
    ["ends with space\\", "ends with space\\\\"],
    ['q\\"x', 'q\\\\\\"x'],
    ["--", "--"],
    ['a"b', 'a\\"b'],
    ['""', '\\"\\"'],
    ["a\\\\", "a\\\\"],
    ["a\\;b c", "a\\\\;b c"],
  ])("escapes %j as %j", (value, expected) => {
    expect(windowsTerminalArgument(value)).toBe(expected);
  });
});

describe("terminal plans", () => {
  const folder = "C:\\work\\a & b ;wt; ^x";

  it("uses Windows Terminal with the folder only as the working folder", () => {
    const args = claudeArguments({ kind: "interactive", name: "a;b c" });
    const plan = planTerminal(programs, args, folder);
    expect(plan.file).toBe(programs.wt);
    expect(plan.args).toEqual([
      "-w",
      "new",
      "-d",
      ".",
      "--",
      programs.claude,
      "--name=a\\;b c",
      "--",
    ]);
    expect(plan.cwd).toBe(folder);
    expect(plan.args.join(" ")).not.toContain("work");
    expect(plan.windowsVerbatimArguments).toBe(false);
  });

  it("falls back to cmd /c start for arguments with no name", () => {
    const args = claudeArguments({ kind: "interactive", forkOf: SESSION_ID });
    const plan = planTerminal({ ...programs, wt: null }, args, folder);
    expect(plan.file).toBe(programs.cmd);
    expect(plan.windowsVerbatimArguments).toBe(true);
    expect(plan.args).toEqual([
      "/d",
      "/v:off",
      "/c",
      `start "" "${String(programs.claude)}" --resume ${SESSION_ID} --fork-session --`,
    ]);
    expect(plan.cwd).toBe(folder);
    expect(plan.args.join(" ")).not.toContain("work");
  });

  it("refuses a name without Windows Terminal (0025)", () => {
    for (const name of ["plain", HOSTILE_NAME, "a b"]) {
      const args = claudeArguments({ kind: "interactive", name });
      expect(consoleSafe(args)).toBe(false);
      expect(() =>
        planTerminal({ ...programs, wt: null }, args, folder),
      ).toThrow("A name needs Windows Terminal");
    }
  });

  it("is unavailable with neither terminal, or without claude", () => {
    expect(() =>
      planTerminal({ ...programs, wt: null, cmd: null }, ["--"], folder),
    ).toThrow();
    expect(() =>
      planTerminal({ ...programs, claude: null }, ["--"], folder),
    ).toThrow();
  });

  it("starts a background session as claude itself, with no shell or terminal", () => {
    const args = claudeArguments({
      kind: "background",
      prompt: HOSTILE_PROMPT,
    });
    const plan = planBackground(programs, args, folder);
    expect(plan.file).toBe(programs.claude);
    expect(plan.args).toEqual(["--bg", "--", HOSTILE_PROMPT]);
    expect(plan.windowsVerbatimArguments).toBe(false);
  });
});
