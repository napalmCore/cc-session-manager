import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView, UsageGroup } from "../shared/protocol.js";
import { groupSessions } from "../shared/session-groups.js";
import { toSessionView } from "./rules.js";
import {
  claudeProjectsDirectory,
  consumeLines,
  createTextState,
  createTranscriptReader,
  FORMAT_RUN,
  isValidSessionId,
  metadataOf,
  summarizeUsage,
  transcriptExists,
} from "./transcripts.js";

const ID = "11111111-1111-4111-8111-111111111111";
const TIME = "2026-11-06T10:00:00.000Z";

const assistant = JSON.stringify({
  type: "assistant",
  gitBranch: "main",
  timestamp: TIME,
  message: { model: "claude-test", content: "private text" },
});

interface UsageLine {
  id?: string;
  model?: string;
  input?: number;
  output?: number;
  write5m?: number;
  write1h?: number;
  read?: number;
  searches?: number;
  speed?: string;
  geo?: string;
  sidechain?: boolean;
  totalWriteOnly?: number;
}

function reply(options: UsageLine = {}): string {
  const usage: Record<string, unknown> = {
    input_tokens: options.input ?? 10,
    output_tokens: options.output ?? 20,
    cache_read_input_tokens: options.read ?? 0,
  };
  if (options.totalWriteOnly !== undefined) {
    usage.cache_creation_input_tokens = options.totalWriteOnly;
  } else {
    usage.cache_creation_input_tokens =
      (options.write5m ?? 0) + (options.write1h ?? 0);
    usage.cache_creation = {
      ephemeral_5m_input_tokens: options.write5m ?? 0,
      ephemeral_1h_input_tokens: options.write1h ?? 0,
    };
  }
  if (options.searches !== undefined) {
    usage.server_tool_use = { web_search_requests: options.searches };
  }
  if (options.speed !== undefined) usage.speed = options.speed;
  if (options.geo !== undefined) usage.inference_geo = options.geo;
  return JSON.stringify({
    type: "assistant",
    timestamp: TIME,
    gitBranch: "main",
    isSidechain: options.sidechain ?? false,
    message: {
      id: options.id ?? "msg_1",
      model: options.model ?? "claude-opus-5-5",
      content: [{ type: "text", text: "private text" }],
      usage,
    },
  });
}

function extract(text: string) {
  const state = createTextState();
  consumeLines(state, text);
  return state;
}

let root: string;

function writeTranscript(content: string, id = ID, project = "project-a") {
  const dir = join(root, project);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, content);
  return file;
}

function writeSubagent(content: string, name = "agent-abc123.jsonl") {
  const dir = join(root, "project-a", ID, "subagents");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

function view(sessionId?: string, startedAt?: number): SessionView {
  if (sessionId === undefined) return toSessionView({});
  return toSessionView(
    startedAt === undefined ? { sessionId } : { sessionId, startedAt },
  );
}

function only(groups: UsageGroup[] | undefined): UsageGroup {
  const group = groups?.[0];
  expect(groups).toHaveLength(1);
  if (!group) throw new Error("expected one usage group");
  return group;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccsm-transcripts-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("transcript metadata", () => {
  it("keeps exactly the allow-listed fields", () => {
    const metadata = metadataOf(extract(`${assistant}\n`));
    expect(metadata).toEqual({
      gitBranch: "main",
      model: "claude-test",
      lastActivityAt: Date.parse(TIME),
    });
    expect(JSON.stringify(metadata)).not.toContain("private text");
  });

  it("uses the newest value of each field", () => {
    const older = JSON.stringify({
      gitBranch: "old",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { model: "old-model" },
    });
    expect(metadataOf(extract(`${older}\n${assistant}\n`))).toEqual({
      gitBranch: "main",
      model: "claude-test",
      lastActivityAt: Date.parse(TIME),
    });
  });

  it("keeps newer values across chunks", () => {
    const state = createTextState();
    consumeLines(state, assistant);
    consumeLines(state, JSON.stringify({ gitBranch: "next" }));
    expect(metadataOf(state).gitBranch).toBe("next");
    expect(metadataOf(state).model).toBe("claude-test");
  });

  it("finds fields that appear on different lines", () => {
    const user = JSON.stringify({ gitBranch: "dev", timestamp: TIME });
    const model = JSON.stringify({ message: { model: "m" } });
    expect(metadataOf(extract(`${model}\n${user}\n`))).toEqual({
      gitBranch: "dev",
      model: "m",
      lastActivityAt: Date.parse(TIME),
    });
  });

  it("treats HEAD as an unavailable branch, without falling back", () => {
    const older = JSON.stringify({ gitBranch: "main", timestamp: TIME });
    const newer = JSON.stringify({ gitBranch: "HEAD", timestamp: TIME });
    expect(metadataOf(extract(`${older}\n${newer}\n`)).gitBranch).toBe(
      undefined,
    );
  });

  it("keeps a real branch name that merely contains HEAD", () => {
    const line = JSON.stringify({ gitBranch: "fix/HEAD-bug", timestamp: TIME });
    expect(metadataOf(extract(`${line}\n`)).gitBranch).toBe("fix/HEAD-bug");
  });

  it("skips placeholder models and empty branches", () => {
    const real = JSON.stringify({ message: { model: "real" } });
    const synthetic = JSON.stringify({
      gitBranch: "",
      message: { model: "<synthetic>" },
    });
    const metadata = metadataOf(extract(`${real}\n${synthetic}\n`));
    expect(metadata.model).toBe("real");
    expect(metadata.gitBranch).toBeUndefined();
  });

  it("tolerates bad lines and wrongly typed fields", () => {
    const wrong = JSON.stringify({
      gitBranch: 5,
      timestamp: "not a date",
      message: "text",
    });
    expect(metadataOf(extract(`garbage\nnull\n[]\n${wrong}\n`))).toEqual({});
  });

  it("accepts Windows line endings", () => {
    expect(metadataOf(extract(`${assistant}\r\n`)).gitBranch).toBe("main");
  });
});

describe("usage", () => {
  it("counts each response once, using its latest line", () => {
    const state = extract(
      [
        reply({ id: "a", output: 5 }),
        reply({ id: "a", output: 5 }),
        reply({ id: "a", output: 7 }),
        reply({ id: "b", output: 1 }),
      ].join("\n"),
    );
    expect(only(summarizeUsage([state])).output).toBe(8);
  });

  it("splits cache writes by duration, and falls back to 5 minutes", () => {
    const split = only(
      summarizeUsage([extract(reply({ write5m: 3, write1h: 4 }))]),
    );
    expect([split.cacheWrite5m, split.cacheWrite1h]).toEqual([3, 4]);

    const total = only(summarizeUsage([extract(reply({ totalWriteOnly: 9 }))]));
    expect([total.cacheWrite5m, total.cacheWrite1h]).toEqual([9, 0]);
  });

  it("keeps every count and the defaults for speed and routing", () => {
    const group = only(
      summarizeUsage([
        extract(
          reply({ input: 1, output: 2, read: 3, write5m: 4, searches: 5 }),
        ),
      ]),
    );
    expect(group).toEqual({
      model: "claude-opus-5-5",
      speed: "standard",
      geo: "global",
      source: "main",
      longContext: false,
      input: 1,
      output: 2,
      cacheWrite5m: 4,
      cacheWrite1h: 0,
      cacheRead: 3,
      webSearches: 5,
    });
  });

  it("groups responses that price differently", () => {
    const state = extract(
      [
        reply({ id: "1" }),
        reply({ id: "2", model: "claude-sonnet-5-5" }),
        reply({ id: "3", speed: "fast" }),
        reply({ id: "4", geo: "us" }),
        reply({ id: "5", sidechain: true }),
        reply({ id: "6" }),
      ].join("\n"),
    );
    const groups = summarizeUsage([state]);
    expect(groups).toHaveLength(5);
    expect(groups.find((g) => g.source === "subagent")?.input).toBe(10);
    expect(
      groups.find(
        (g) =>
          g.model === "claude-opus-5-5" &&
          g.speed === "standard" &&
          g.geo === "global" &&
          g.source === "main",
      )?.input,
    ).toBe(20);
  });

  it("marks Claude Haiku 5.5 prompts strictly over 100,000 tokens", () => {
    const at = only(
      summarizeUsage([
        extract(
          reply({ model: "claude-haiku-5-5", input: 50_000, read: 50_000 }),
        ),
      ]),
    );
    expect(at.longContext).toBe(false);

    const over = only(
      summarizeUsage([
        extract(
          reply({
            model: "claude-haiku-5-5",
            input: 50_000,
            read: 50_000,
            write1h: 1,
          }),
        ),
      ]),
    );
    expect(over.longContext).toBe(true);

    const opus = only(summarizeUsage([extract(reply({ input: 200_000 }))]));
    expect(opus.longContext).toBe(false);
  });

  it("leaves out entries Claude Code writes without a model", () => {
    const state = extract(reply({ model: "<synthetic>" }));
    expect(summarizeUsage([state])).toEqual([]);
  });

  it("keeps no message text", () => {
    const state = extract(reply());
    expect(JSON.stringify(summarizeUsage([state]))).not.toContain(
      "private text",
    );
    expect(JSON.stringify([...state.responses.values()])).not.toContain(
      "private text",
    );
  });

  it("ignores wrongly typed counts", () => {
    const line = JSON.stringify({
      timestamp: TIME,
      message: {
        id: "x",
        model: "claude-opus-5-5",
        usage: { input_tokens: "lots", output_tokens: -4, speed: 5 },
      },
    });
    const group = only(summarizeUsage([extract(line)]));
    expect([group.input, group.output, group.speed]).toEqual([
      0,
      0,
      "standard",
    ]);
  });
});

describe("format change warning", () => {
  const bad = (count: number, line: string) =>
    Array.from({ length: count }, () => line).join("\n");

  it("isn't raised for a normal transcript or an empty one", () => {
    expect(extract(`${reply()}\n`).formatChanged).toBe(false);
    expect(extract("").formatChanged).toBe(false);
  });

  it("isn't raised for header lines or unknown line types (BUG-24)", () => {
    const lines = [
      ...["mode", "permission-mode", "ai-title", "file-history-snapshot"],
      ...Array.from({ length: 30 }, () => "something-new"),
    ].map((type) => JSON.stringify({ type }));
    expect(extract(lines.join("\n")).formatChanged).toBe(false);
  });

  it("isn't raised for a very large line between normal ones (BUG-24)", () => {
    const blob = JSON.stringify({
      type: "api-request-blob",
      data: "x".repeat(1_000_000),
    });
    expect(extract(`${reply()}\n${blob}\n`).formatChanged).toBe(false);
  });

  it(`needs ${FORMAT_RUN} bad lines in a row`, () => {
    expect(extract(bad(FORMAT_RUN - 1, "garbage")).formatChanged).toBe(false);
    expect(
      extract(
        `${bad(FORMAT_RUN - 1, "garbage")}\n${reply()}\n${bad(FORMAT_RUN - 1, "garbage")}`,
      ).formatChanged,
    ).toBe(false);
    expect(extract(bad(FORMAT_RUN, "garbage")).formatChanged).toBe(true);
  });

  it.each([
    ["lines that aren't objects (BUG-26)", "[1,2]"],
    [
      "message renamed (BUG-26)",
      JSON.stringify({
        type: "assistant",
        timestamp: TIME,
        msg: { usage: {} },
      }),
    ],
    [
      "timestamp renamed",
      JSON.stringify({ type: "assistant", ts: TIME, message: { usage: {} } }),
    ],
    [
      "assistant lines without a message",
      JSON.stringify({ type: "assistant", timestamp: TIME }),
    ],
  ])("is raised for %s", (_label, line) => {
    expect(extract(bad(FORMAT_RUN, line)).formatChanged).toBe(true);
  });
});

describe("createTranscriptReader", () => {
  it("adds metadata and usage to a session and keeps its other fields", async () => {
    writeTranscript(`${reply()}\n`);
    const reader = createTranscriptReader(root);

    const { sessions } = await reader.enrich([
      toSessionView({ sessionId: ID, name: "demo" }),
    ]);

    expect(sessions[0]?.name).toBe("demo");
    expect(sessions[0]?.gitBranch).toBe("main");
    expect(sessions[0]?.model).toBe("claude-opus-5-5");
    expect(sessions[0]?.lastActivityAt).toBe(Date.parse(TIME));
    expect(sessions[0]?.usage?.counting).toBe(false);
    expect(only(sessions[0]?.usage?.groups).output).toBe(20);
    expect(JSON.stringify(sessions)).not.toContain("private text");
  });

  it("leaves a session unchanged when it has no transcript", async () => {
    const session = view(ID);
    const result = await createTranscriptReader(root).enrich([session]);
    expect(result.sessions).toEqual([session]);
    expect(result.warnings).toEqual([]);
  });

  it("leaves a session unchanged when the projects folder does not exist", async () => {
    const session = view(ID);
    const result = await createTranscriptReader(join(root, "none")).enrich([
      session,
    ]);
    expect(result.sessions).toEqual([session]);
  });

  it("leaves a session without a session ID unchanged", async () => {
    const session = view();
    const reader = createTranscriptReader(root);
    expect((await reader.enrich([session])).sessions).toEqual([session]);
  });

  it.each([
    "../../secrets",
    "..\\..\\secrets",
    "not-a-uuid",
    `${ID}/../../x`,
    "*",
  ])("refuses the unsafe session ID %s", async (sessionId) => {
    expect(isValidSessionId(sessionId)).toBe(false);

    writeFileSync(join(root, "secrets.jsonl"), `${assistant}\n`);
    mkdirSync(join(root, "a", "b"), { recursive: true });
    const session = view(sessionId);
    const reader = createTranscriptReader(join(root, "a", "b"));
    expect((await reader.enrich([session])).sessions).toEqual([session]);
  });

  it("accepts a real session ID format", () => {
    expect(isValidSessionId(ID)).toBe(true);
  });

  it("does not follow a symbolic link", async () => {
    const outside = join(root, "outside.jsonl");
    writeFileSync(outside, `${assistant}\n`);
    const dir = join(root, "project-a");
    mkdirSync(dir);
    try {
      symlinkSync(outside, join(dir, `${ID}.jsonl`));
    } catch {
      return; // Creating links needs extra rights on Windows.
    }
    const session = view(ID);
    const reader = createTranscriptReader(root);
    expect((await reader.enrich([session])).sessions).toEqual([session]);
  });

  it("only opens JSONL files named after the session", async () => {
    writeTranscript(`${assistant}\n`, "22222222-2222-4222-8222-222222222222");
    const session = view(ID);
    const reader = createTranscriptReader(root);
    expect((await reader.enrich([session])).sessions).toEqual([session]);
  });

  it("reads the whole file, so fields at the start are found", async () => {
    const start = JSON.stringify({ gitBranch: "beginning", timestamp: TIME });
    const filler = JSON.stringify({ padding: "x".repeat(600_000) });
    writeTranscript(`${start}\n${filler}\n`);

    const { sessions } = await createTranscriptReader(root).enrich([view(ID)]);

    expect(sessions[0]?.gitBranch).toBe("beginning");
  });

  it("reads only new bytes after the first read", async () => {
    const file = writeTranscript(`${reply({ id: "a" })}\n`);
    const reader = createTranscriptReader(root);
    const read = vi.spyOn(reader.internals, "readBytes");

    await reader.enrich([view(ID)]);
    await reader.enrich([view(ID)]);
    const firstLength = (read.mock.calls[0]?.[2] as number) ?? 0;
    expect(read).toHaveBeenCalledTimes(1);

    appendFileSync(file, `${reply({ id: "b", output: 1 })}\n`);
    const { sessions } = await reader.enrich([view(ID)]);

    const positions = read.mock.calls.map((call) => call[1]);
    expect(positions).toContain(firstLength);
    expect(only(sessions[0]?.usage?.groups).output).toBe(21);
  });

  it("holds an unfinished last line until it ends", async () => {
    const line = reply({ id: "a" });
    const file = writeTranscript(line.slice(0, 40));
    const reader = createTranscriptReader(root);

    expect(
      (await reader.enrich([view(ID)])).sessions[0]?.usage?.groups,
    ).toEqual([]);

    appendFileSync(file, `${line.slice(40)}\n`);
    const { sessions } = await reader.enrich([view(ID)]);
    expect(only(sessions[0]?.usage?.groups).output).toBe(20);
  });

  it("decodes a character split across two reads", async () => {
    const line = JSON.stringify({ gitBranch: "café-ü", timestamp: TIME });
    writeTranscript(`${line}\n`);
    const split = Buffer.from(`${line}\n`).indexOf(Buffer.from("é")) + 1;
    const reader = createTranscriptReader(root, { budgetBytes: split });

    const first = await reader.enrich([view(ID)]);
    expect(first.sessions[0]?.usage?.counting).toBe(true);

    let sessions = first.sessions;
    for (let poll = 0; poll < 100 && sessions[0]?.usage?.counting; poll += 1) {
      sessions = (await reader.enrich([view(ID)])).sessions;
    }
    expect(sessions[0]?.gitBranch).toBe("café-ü");
  });

  it("shares the read budget across sessions, newest first", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const content = `${reply()}\n`;
    writeTranscript(content);
    writeTranscript(content, other);
    const reader = createTranscriptReader(root, {
      budgetBytes: Buffer.byteLength(content),
    });

    const { sessions } = await reader.enrich([view(ID, 1), view(other, 2)]);

    expect(sessions[1]?.usage?.counting).toBe(false);
    expect(sessions[0]?.usage?.counting).toBe(true);
    expect(sessions[0]?.usage?.groups).toEqual([]);

    const next = await reader.enrich([view(ID, 1), view(other, 2)]);
    expect(next.sessions[0]?.usage?.counting).toBe(false);
  });

  it("starts again when the file is replaced or cut short", async () => {
    const file = writeTranscript(
      `${reply({ id: "a", output: 5 })}\n${reply({ id: "b", output: 5 })}\n`,
    );
    const reader = createTranscriptReader(root);
    await reader.enrich([view(ID)]);

    writeFileSync(file, `${reply({ id: "c", output: 1 })}\n`);
    let { sessions } = await reader.enrich([view(ID)]);
    expect(only(sessions[0]?.usage?.groups).output).toBe(1);

    const replacement = JSON.stringify({
      type: "assistant",
      timestamp: TIME,
      message: {
        id: "d",
        model: "claude-opus-5-5",
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    });
    writeFileSync(
      file,
      `${replacement}\n${replacement.replace('"d"', '"e"')}\n`,
    );
    ({ sessions } = await reader.enrich([view(ID)]));
    expect(only(sessions[0]?.usage?.groups).output).toBe(4);
  });

  it("includes subagent transcripts as subagent usage", async () => {
    writeTranscript(`${reply({ id: "main" })}\n`);
    writeSubagent(
      `${reply({ id: "sub", model: "claude-haiku-5-5", output: 3 })}\n`,
    );
    writeSubagent("not a transcript\n", "notes.txt");

    const { sessions } = await createTranscriptReader(root).enrich([view(ID)]);

    const groups = sessions[0]?.usage?.groups ?? [];
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.source === "subagent")).toMatchObject({
      model: "claude-haiku-5-5",
      output: 3,
    });
    expect(sessions[0]?.model).toBe("claude-opus-5-5");
  });

  it("picks up a subagent that starts later", async () => {
    writeTranscript(`${reply({ id: "main" })}\n`);
    const reader = createTranscriptReader(root);
    await reader.enrich([view(ID)]);

    writeSubagent(`${reply({ id: "sub" })}\n`);
    const later = Date.now() / 1000 + 10;
    utimesSync(join(root, "project-a", ID, "subagents"), later, later);

    const { sessions } = await reader.enrich([view(ID)]);
    expect(sessions[0]?.usage?.groups).toHaveLength(2);
  });

  it("forgets sessions it isn't asked about for 10 minutes", async () => {
    writeTranscript(`${reply()}\n`);
    let time = 0;
    const reader = createTranscriptReader(root, { now: () => time });
    const read = vi.spyOn(reader.internals, "readBytes");

    await reader.enrich([view(ID)]);
    time = 11 * 60 * 1000;
    await reader.enrich([]);
    await reader.enrich([view(ID)]);

    expect(read.mock.calls.filter((call) => call[1] === 0)).toHaveLength(2);
  });

  it("warns once when transcripts appear to have changed format", async () => {
    writeTranscript(`${"[]\n".repeat(FORMAT_RUN)}`);
    const reader = createTranscriptReader(root);

    const { warnings } = await reader.enrich([view(ID), view(ID)]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(root);
  });

  describe("when no timestamp can be read", () => {
    const OLD = Date.parse("2026-01-01T00:00:00.000Z");
    const setFileTime = (file: string) => {
      utimesSync(file, new Date(OLD), new Date(OLD));
    };
    const blocked = () =>
      toSessionView({ sessionId: ID, kind: "background", state: "blocked" });

    it("uses the file's modified time when only header lines are readable", async () => {
      setFileTime(writeTranscript(`${JSON.stringify({ type: "mode" })}\n`));
      const { sessions } = await createTranscriptReader(root).enrich([
        view(ID),
      ]);
      expect(sessions[0]?.lastActivityAt).toBe(OLD);
    });

    it("uses the file's modified time when every line is unreadable", async () => {
      setFileTime(writeTranscript("garbage\n[]\nnull\n"));
      const { sessions } = await createTranscriptReader(root).enrich([
        view(ID),
      ]);
      expect(sessions[0]?.lastActivityAt).toBe(OLD);
    });

    it("uses the file's modified time for an empty file", async () => {
      setFileTime(writeTranscript(""));
      const { sessions } = await createTranscriptReader(root).enrich([
        view(ID),
      ]);
      expect(sessions[0]?.lastActivityAt).toBe(OLD);
    });

    it("follows the file's modified time when it changes", async () => {
      const file = writeTranscript(`${JSON.stringify({ type: "mode" })}\n`);
      setFileTime(file);
      const reader = createTranscriptReader(root);
      await reader.enrich([view(ID)]);

      const later = OLD + 60_000;
      utimesSync(file, new Date(later), new Date(later));

      const { sessions } = await reader.enrich([view(ID)]);
      expect(sessions[0]?.lastActivityAt).toBe(later);
    });

    it("prefers a timestamp from the transcript", async () => {
      setFileTime(writeTranscript(`${assistant}\n`));
      const { sessions } = await createTranscriptReader(root).enrich([
        view(ID),
      ]);
      expect(sessions[0]?.lastActivityAt).toBe(Date.parse(TIME));
    });

    it("keeps an idle blocked session in Stale", async () => {
      setFileTime(writeTranscript(`${JSON.stringify({ type: "mode" })}\n`));

      const { sessions } = await createTranscriptReader(root).enrich([
        blocked(),
      ]);
      const groups = groupSessions(sessions, Date.parse(TIME));

      expect(groups.stale).toHaveLength(1);
      expect(groups.needsYou).toEqual([]);
    });
  });
});

describe("transcriptExists", () => {
  it("finds a session's transcript in any project", async () => {
    writeTranscript(`${assistant}\n`, ID, "project-b");
    expect(await transcriptExists(ID, root)).toBe(true);
  });

  it("doesn't accept an invalid ID even when a matching file exists", async () => {
    writeTranscript(`${assistant}\n`, "not-a-session-id");
    expect(await transcriptExists("not-a-session-id", root)).toBe(false);
  });

  it("is false when there's no transcript or the ID isn't valid", async () => {
    expect(await transcriptExists(ID, root)).toBe(false);
    expect(await transcriptExists("../x", root)).toBe(false);
    expect(await transcriptExists(ID, join(root, "missing"))).toBe(false);
  });
});

describe("claudeProjectsDirectory", () => {
  it("defaults to the home folder", () => {
    expect(claudeProjectsDirectory({}, "/home/a")).toBe(
      join("/home/a", ".claude", "projects"),
    );
  });

  it("respects CLAUDE_CONFIG_DIR", () => {
    expect(
      claudeProjectsDirectory({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/a"),
    ).toBe(join("/cfg", "projects"));
  });
});
