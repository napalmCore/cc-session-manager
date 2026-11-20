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

describe("Claude Code processes the first walk missed (L1)", () => {
  it("knows an older npm install, a replaced program, and a renamed process", () => {
    // npm's `claude` script run by Node: node /usr/local/bin/claude.
    expect(
      isClaudeProcess(
        info({
          program: "/usr/bin/node",
          args: ["node", "/usr/local/bin/claude", "--resume"],
        }),
      ),
    ).toBe(true);
    // A program an update replaced while it ran.
    expect(
      isClaudeProcess(
        info({
          program: "/home/me/.local/share/claude/versions/2.1.3 (deleted)",
        }),
      ),
    ).toBe(true);
    expect(
      isClaudeProcess(
        info({ program: "/home/me/.local/bin/claude (deleted)" }),
      ),
    ).toBe(true);
    // Node that set its title to claude.
    expect(
      isClaudeProcess(info({ program: "/usr/bin/node", args: ["claude"] })),
    ).toBe(true);
    // Still not: Node running something else, or a program merely named like it.
    expect(
      isClaudeProcess(
        info({
          program: "/usr/bin/node",
          args: ["node", "/srv/app/claude.js"],
        }),
      ),
    ).toBe(false);
    expect(isClaudeProcess(info({ program: "/usr/bin/claude-helper" }))).toBe(
      false,
    );
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

  it("reports none when it reaches process 1 without one", async () => {
    const seen: number[] = [];
    const tracked = (pid: number) => {
      seen.push(pid);
      return pid === 1
        ? Promise.resolve(info({ parent: 0, program: "/sbin/init" }))
        : read(pid);
    };
    expect(await walkToClaude(tracked, 20)).toEqual({ kind: "none" });
    expect(seen).toEqual([20, 10, 1]);
    // An unreadable process 1 is none too, not a failed walk.
    expect(await walkToClaude(read, 20)).toEqual({ kind: "none" });
  });

  it("finds Claude Code as process 1, as in a container that starts it directly (L1)", async () => {
    const container = (pid: number) =>
      Promise.resolve(
        pid === 1
          ? info({
              parent: 0,
              program: "/usr/local/bin/claude",
              startMs: 5_000,
            })
          : info({ parent: 1, program: "/bin/bash" }),
      );
    expect(await walkToClaude(container, 30)).toEqual({
      kind: "found",
      pid: 1,
      startMs: 5_000,
    });
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
