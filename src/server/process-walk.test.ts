import { describe, expect, it } from "vitest";
import {
  isClaudeProcess,
  parseLinuxStat,
  type ProcessInfo,
  walkFromHere,
  walkToClaude,
} from "./process-walk.js";

const info = (fields: Partial<ProcessInfo>): ProcessInfo => ({
  parent: 1,
  startMs: 0,
  program: null,
  args: [],
  ...fields,
});

describe("which process is Claude Code's (FR-45)", () => {
  it("knows its own program, a ClaudeCode.app host, and Node running its CLI", () => {
    expect(
      isClaudeProcess(info({ program: "/home/me/.local/bin/claude" })),
    ).toBe(true);
    expect(
      isClaudeProcess(
        info({ program: "/home/me/.local/share/claude/versions/2.1.325" }),
      ),
    ).toBe(true);
    expect(
      isClaudeProcess(
        info({
          program:
            "/Users/me/.local/share/claude/ClaudeCode.app/Contents/MacOS/x",
        }),
      ),
    ).toBe(true);
    expect(
      isClaudeProcess(
        info({
          program: "/usr/local/bin/node",
          args: [
            "node",
            "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
          ],
        }),
      ),
    ).toBe(true);
  });

  it("uses the arguments when the program can't be read, and keeps a path with a space whole", () => {
    expect(
      isClaudeProcess(info({ args: ["/opt/my tools/claude", "--resume"] })),
    ).toBe(true);
    expect(
      isClaudeProcess(info({ program: "/usr/sbin/sshd", args: ["sshd: me"] })),
    ).toBe(false);
    expect(
      isClaudeProcess(info({ program: "/bin/bash", args: ["-bash"] })),
    ).toBe(false);
    // Node running something else isn't Claude Code; Node installed as nodejs still counts.
    expect(
      isClaudeProcess(
        info({ program: "/usr/bin/node", args: ["node", "server.js"] }),
      ),
    ).toBe(false);
    expect(
      isClaudeProcess(
        info({
          program: "/usr/bin/nodejs",
          args: [
            "nodejs",
            "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe("reading /proc/<pid>/stat (FR-45)", () => {
  it("reads after the last ), since a name can hold one", () => {
    const fields = Array.from({ length: 20 }, (_, i) => String(i));
    fields[1] = "4242"; // parent
    fields[19] = "12345"; // start time, in 1/100 s since boot
    const line = `77 (we ird) (name)) S ${fields.slice(1).join(" ")}`;
    expect(parseLinuxStat(line, 1_000_000)).toEqual({
      parent: 4242,
      startMs: 1_000_000 + 123_450,
    });
    expect(parseLinuxStat("garbage", 0)).toBeNull();
  });
});

describe("walking up the parent processes (FR-45)", () => {
  const tree: Record<number, ProcessInfo> = {
    50: info({ parent: 40, program: "/bin/bash" }),
    40: info({
      parent: 30,
      program: "/home/me/.local/bin/claude",
      startMs: 9_000,
    }),
    30: info({ parent: 1, program: "/usr/sbin/sshd" }),
    20: info({ parent: 10, program: "/bin/zsh" }),
    10: info({ parent: 1, program: "/usr/bin/login" }),
  };
  const read = (pid: number) => Promise.resolve(tree[pid] ?? null);

  it("finds the first Claude Code process above, with its start time", async () => {
    expect(await walkToClaude(read, 50)).toEqual({
      kind: "found",
      pid: 40,
      startMs: 9_000,
    });
  });

  it("reports none when it reaches process 1 without one, never reading process 1", async () => {
    const seen: number[] = [];
    const tracked = (pid: number) => {
      seen.push(pid);
      return read(pid);
    };
    expect(await walkToClaude(tracked, 20)).toEqual({ kind: "none" });
    expect(seen).not.toContain(1);
  });

  it("fails when a process can't be read, or points to itself", async () => {
    expect(await walkToClaude(read, 99)).toEqual({ kind: "failed" });
    const loop = () => Promise.resolve(info({ parent: 7 }));
    expect(await walkToClaude(loop, 7)).toEqual({ kind: "failed" });
  });
});

// The real walk, on macOS and Linux only. CI isn't started from Claude Code.
describe.runIf(process.platform !== "win32")("the real walk (FR-45)", () => {
  it("reads this machine's parent processes, and finds no Claude Code above CI", async () => {
    const walked = await walkFromHere();
    expect(walked.kind).not.toBe("failed");
  });
});
