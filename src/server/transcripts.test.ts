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
import type { SessionView } from "../shared/protocol.js";
import { toSessionView } from "./rules.js";
import {
  claudeProjectsDirectory,
  createMetadataReader,
  extractMetadata,
  isValidSessionId,
  TAIL_BYTES,
} from "./transcripts.js";

const ID = "11111111-1111-4111-8111-111111111111";
const TIME = "2026-11-06T10:00:00.000Z";

const assistant = JSON.stringify({
  type: "assistant",
  gitBranch: "main",
  timestamp: TIME,
  message: { model: "claude-test", content: "private text" },
});

let root: string;

function writeTranscript(content: string, id = ID, project = "project-a") {
  const dir = join(root, project);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, content);
  return file;
}

function view(sessionId?: string): SessionView {
  return toSessionView(sessionId === undefined ? {} : { sessionId });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccsm-transcripts-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("extractMetadata", () => {
  it("returns exactly the allow-listed fields", () => {
    const { metadata } = extractMetadata(`${assistant}\n`);
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
    expect(extractMetadata(`${older}\n${assistant}\n`).metadata).toEqual({
      gitBranch: "main",
      model: "claude-test",
      lastActivityAt: Date.parse(TIME),
    });
  });

  it("finds fields that appear on different lines", () => {
    const user = JSON.stringify({ gitBranch: "dev", timestamp: TIME });
    const reply = JSON.stringify({ message: { model: "m" } });
    expect(extractMetadata(`${reply}\n${user}\n`).metadata).toEqual({
      gitBranch: "dev",
      model: "m",
      lastActivityAt: Date.parse(TIME),
    });
  });

  it("treats HEAD as an unavailable branch", () => {
    const line = JSON.stringify({ gitBranch: "HEAD", timestamp: TIME });
    expect(
      extractMetadata(`${line}
`).metadata.gitBranch,
    ).toBeUndefined();
  });

  it("does not fall back to an older branch when the newest value is HEAD", () => {
    const older = JSON.stringify({ gitBranch: "main", timestamp: TIME });
    const newer = JSON.stringify({ gitBranch: "HEAD", timestamp: TIME });
    expect(
      extractMetadata(`${older}
${newer}
`).metadata.gitBranch,
    ).toBeUndefined();
  });

  it("keeps a real branch name that merely contains HEAD", () => {
    const line = JSON.stringify({ gitBranch: "fix/HEAD-bug", timestamp: TIME });
    expect(
      extractMetadata(`${line}
`).metadata.gitBranch,
    ).toBe("fix/HEAD-bug");
  });

  it("skips placeholder models and empty branches", () => {
    const real = JSON.stringify({ message: { model: "real" } });
    const synthetic = JSON.stringify({
      gitBranch: "",
      message: { model: "<synthetic>" },
    });
    const { metadata } = extractMetadata(`${real}\n${synthetic}\n`);
    expect(metadata.model).toBe("real");
    expect(metadata.gitBranch).toBeUndefined();
  });

  it("tolerates bad lines and wrongly typed fields", () => {
    const wrong = JSON.stringify({
      gitBranch: 5,
      timestamp: "not a date",
      message: "text",
    });
    const { metadata } = extractMetadata(`garbage\nnull\n[]\n${wrong}\n`);
    expect(metadata).toEqual({});
  });

  describe("format change warning", () => {
    const headerTypes = [
      "mode",
      "permission-mode",
      "session-owner",
      "atis-latch",
      "file-history-snapshot",
      "ai-title",
      "agent-name",
      "artifact-comment-monitor",
    ];
    const header = headerTypes
      .map((type) => JSON.stringify({ type }))
      .join("\n");

    it("isn't raised for a normal transcript or an empty one", () => {
      expect(extractMetadata(`${assistant}\n`).formatChanged).toBe(false);
      expect(extractMetadata("").formatChanged).toBe(false);
    });

    it.each(headerTypes)("isn't raised for a %s header line", (type) => {
      const line = JSON.stringify({ type });
      expect(extractMetadata(`${line}\n`).formatChanged).toBe(false);
    });

    it("isn't raised for a new transcript with only header lines", () => {
      expect(extractMetadata(`${header}\n`).formatChanged).toBe(false);
    });

    it.each([
      ["a message without a timestamp", { message: { model: "m" } }],
      ["an unreadable timestamp", { timestamp: "soon", message: {} }],
      [
        "a renamed timestamp and message",
        { type: "assistant", ts: 1, msg: {} },
      ],
      [
        "fields moved under another key",
        { type: "user", data: { timestamp: "x" } },
      ],
      ["an unknown line type", { type: "something-new" }],
      ["a line with no type", { other: 1 }],
      ["a non-string type", { type: 5 }],
    ])("is raised for %s", (_label, fields) => {
      const line = JSON.stringify(fields);
      expect(extractMetadata(`${header}\n${line}\n`).formatChanged).toBe(true);
    });

    it("isn't raised once any line has a usable timestamp", () => {
      const line = JSON.stringify({ type: "something-new" });
      expect(extractMetadata(`${line}\n${assistant}\n`).formatChanged).toBe(
        false,
      );
    });
  });
});

describe("createMetadataReader", () => {
  it("adds metadata to a session and keeps its other fields", async () => {
    writeTranscript(`${assistant}\n`);
    const reader = createMetadataReader(root);

    const { sessions } = await reader.enrich([
      toSessionView({ sessionId: ID, name: "demo" }),
    ]);

    expect(sessions[0]?.name).toBe("demo");
    expect(sessions[0]?.gitBranch).toBe("main");
    expect(sessions[0]?.model).toBe("claude-test");
    expect(sessions[0]?.lastActivityAt).toBe(Date.parse(TIME));
    expect(JSON.stringify(sessions)).not.toContain("private text");
  });

  it("leaves a session unchanged when it has no transcript", async () => {
    const reader = createMetadataReader(root);
    const session = view(ID);
    const result = await reader.enrich([session]);
    expect(result.sessions).toEqual([session]);
    expect(result.warnings).toEqual([]);
  });

  it("leaves a session unchanged when the projects folder does not exist", async () => {
    const session = view(ID);
    const result = await createMetadataReader(join(root, "none")).enrich([
      session,
    ]);
    expect(result.sessions).toEqual([session]);
  });

  it("leaves a session without a session ID unchanged", async () => {
    const session = view();
    const reader = createMetadataReader(root);
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
    const reader = createMetadataReader(join(root, "a", "b"));
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
    const reader = createMetadataReader(root);
    expect((await reader.enrich([session])).sessions).toEqual([session]);
  });

  it("reads only the end of a large file", async () => {
    const start = JSON.stringify({ gitBranch: "beginning", timestamp: TIME });
    const filler = JSON.stringify({ padding: "x".repeat(TAIL_BYTES) });
    const end = JSON.stringify({ timestamp: TIME });
    writeTranscript(`${start}\n${filler}\n${end}\n`);

    const { sessions } = await createMetadataReader(root).enrich([view(ID)]);

    expect(sessions[0]?.gitBranch).toBeUndefined();
    expect(sessions[0]?.lastActivityAt).toBe(Date.parse(TIME));
  });

  it("ignores a partial first line when reading the end of a file", async () => {
    const cut = JSON.stringify({
      gitBranch: "cut-off",
      padding: "x".repeat(TAIL_BYTES - 40),
    });
    writeTranscript(`${cut}\n${assistant}\n`);

    const { sessions } = await createMetadataReader(root).enrich([view(ID)]);

    expect(sessions[0]?.gitBranch).toBe("main");
  });

  it("reuses cached metadata until the file changes", async () => {
    const file = writeTranscript(`${assistant}\n`);
    const reader = createMetadataReader(root);
    const session = view(ID);
    const read = vi.spyOn(reader.internals, "readTail");

    await reader.enrich([session]);
    await reader.enrich([session]);
    expect(read).toHaveBeenCalledTimes(1);

    appendFileSync(
      file,
      `${JSON.stringify({ gitBranch: "next", timestamp: TIME })}\n`,
    );
    utimesSync(file, new Date(), new Date(Date.now() + 5000));

    const { sessions } = await reader.enrich([session]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(sessions[0]?.gitBranch).toBe("next");
  });

  it("warns once when transcripts appear to have changed format", async () => {
    writeTranscript(`{"message":{}}\n`);
    const reader = createMetadataReader(root);

    const { warnings } = await reader.enrich([view(ID), view(ID)]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(root);
  });

  it("only opens JSONL files named after the session", async () => {
    writeTranscript(`${assistant}\n`, "22222222-2222-4222-8222-222222222222");
    const session = view(ID);
    const reader = createMetadataReader(root);
    expect((await reader.enrich([session])).sessions).toEqual([session]);
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
