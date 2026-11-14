import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "../shared/protocol.js";
import {
  createHistory,
  FORK_COPY_MS,
  HEAD_BYTES,
  HISTORY_PAGE_SIZE,
  readHead,
  readLastTimestamp,
  startTime,
  type UsageReader,
} from "./history.js";
import { createTranscriptReader } from "./transcripts.js";

// Close to now, so a freshly written file doesn't look like a fork with copied timestamps.
const T0 = Date.now() - 30_000;
const id = (n: number) =>
  `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccsm-history-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function transcript(
  project: string,
  sessionId: string,
  lines: unknown[],
  modifiedAt?: number,
): string {
  mkdirSync(join(root, project), { recursive: true });
  const file = join(root, project, `${sessionId}.jsonl`);
  writeFileSync(
    file,
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
  if (modifiedAt !== undefined)
    utimesSync(file, modifiedAt / 1000, modifiedAt / 1000);
  return file;
}

const header = { type: "summary", leafUuid: "x" };
const user = (time: number, cwd = "C:\\work\\alpha") => ({
  type: "user",
  cwd,
  sessionId: "ignored",
  timestamp: new Date(time).toISOString(),
  gitBranch: "main",
  message: { role: "user", content: "private prompt text" },
});

const noUsage: UsageReader = (sessions) =>
  Promise.resolve({ sessions, warnings: [] });

describe("reading a transcript's start (U-23)", () => {
  it("takes the first cwd and the first timestamp, and no message text", async () => {
    const file = transcript("p", id(1), [
      header,
      user(T0, "C:\\first"),
      user(T0 + 5000, "C:\\second"),
    ]);
    const head = await readHead(file);
    expect(head).toEqual({ folder: "C:\\first", firstTimestamp: T0 });
    expect(JSON.stringify(head)).not.toContain("private");
  });

  it("reads only the first 64 KB, and ignores a cut-off last line", async () => {
    const big = { type: "x", pad: "y".repeat(HEAD_BYTES) };
    const file = transcript("p", id(2), [header, big, user(T0)]);
    expect(await readHead(file)).toEqual({
      folder: null,
      firstTimestamp: null,
    });
  });

  it("uses the file's creation time for a fork, whose first timestamps are copied", () => {
    expect(startTime(T0, T0 + 1000)).toBe(T0);
    expect(startTime(T0, T0 + FORK_COPY_MS + 1)).toBe(T0 + FORK_COPY_MS + 1);
    expect(startTime(null, T0)).toBeNull();
  });
});

describe("History pages (FR-35)", () => {
  it("lists every main transcript newest first, with no names, and leaves out empty ones", async () => {
    transcript("a", id(1), [header, user(T0)], T0 + 1000);
    transcript("b", id(2), [header, user(T0, "C:\\work\\beta")], T0 + 2000);
    transcript("b", id(3), [header], T0 + 3000);
    mkdirSync(join(root, "b", id(2)), { recursive: true });
    writeFileSync(join(root, "b", id(2), "agent-sub.jsonl"), "{}\n");
    writeFileSync(join(root, "b", "not-a-session.jsonl"), "{}\n");
    const history = createHistory({ root, read: noUsage });
    const page = await history.page(0, []);
    // The transcript with no messages isn't counted.
    expect(page.total).toBe(2);
    expect(page.sessions.map((entry) => entry.sessionId)).toEqual([
      id(2),
      id(1),
    ]);
    expect(page.sessions[0]).toMatchObject({
      folder: "C:\\work\\beta",
      startedAt: T0,
      inList: false,
    });
    expect(JSON.stringify(page)).not.toContain("private");
    expect(JSON.stringify(page)).not.toContain("name");
  });

  it("pages 50 at a time, clamping a page past the end", async () => {
    for (let i = 0; i < HISTORY_PAGE_SIZE + 3; i += 1) {
      transcript("p", id(i), [user(T0 + i)], T0 + i * 1000);
    }
    const history = createHistory({ root, read: noUsage });
    const first = await history.page(0, []);
    expect(first.pages).toBe(2);
    expect(first.sessions).toHaveLength(HISTORY_PAGE_SIZE);
    const last = await history.page(99, []);
    expect(last.page).toBe(1);
    expect(last.sessions).toHaveLength(3);
  });

  it("marks sessions Claude Code still lists", async () => {
    transcript("p", id(1), [user(T0)]);
    const history = createHistory({ root, read: noUsage });
    const listing = [{ sessionId: id(1) } as SessionView];
    expect((await history.page(0, listing)).sessions[0]?.inList).toBe(true);
  });

  it("adds branch, model, activity, and usage from the reader, and survives its failure", async () => {
    transcript("p", id(1), [user(T0)]);
    const read = vi.fn<UsageReader>((sessions) =>
      Promise.resolve({
        sessions: sessions.map((session) => ({
          ...session,
          gitBranch: "feature",
          model: "claude-opus-5-5",
          usage: { groups: [], counting: true, cost: 0, unpriced: [] },
        })),
        warnings: [],
      }),
    );
    const page = await createHistory({ root, read }).page(0, []);
    expect(page.sessions[0]).toMatchObject({
      gitBranch: "feature",
      model: "claude-opus-5-5",
      usage: { counting: true },
    });
    const broken = createHistory({
      root,
      read: () => Promise.reject(new Error("x")),
    });
    expect((await broken.page(0, [])).sessions).toHaveLength(1);
  });

  it("reads only when asked, so a closed History reads nothing (NFR-15)", async () => {
    transcript("p", id(1), [user(T0)]);
    const read = vi.fn(noUsage);
    createHistory({ root, read });
    expect(read).not.toHaveBeenCalled();
  });

  it("works with the real transcript reader, with no message text in the result", async () => {
    transcript("p", id(1), [
      user(T0),
      {
        type: "assistant",
        timestamp: new Date(T0 + 1000).toISOString(),
        gitBranch: "main",
        message: {
          id: "msg_1",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: "private reply text" }],
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ]);
    const reader = createTranscriptReader(root);
    const page = await createHistory({
      root,
      read: (s) => reader.enrich(s),
    }).page(0, []);
    expect(page.sessions[0]?.model).toBe("claude-opus-5-5");
    expect(page.sessions[0]?.usage?.groups[0]?.output).toBe(20);
    expect(JSON.stringify(page)).not.toContain("private");
  });

  it("finds a past session's folder by ID, and refuses a malformed ID", async () => {
    transcript("p", id(7), [user(T0, "C:\\work\\gamma")]);
    const history = createHistory({ root, read: noUsage });
    expect((await history.find(id(7)))?.folder).toBe("C:\\work\\gamma");
    expect(await history.find(id(8))).toBeNull();
    expect(await history.find("../../etc")).toBeNull();
  });
});

describe("History order and turns (FR-35, review of #61)", () => {
  it("orders every page by last activity, not by when a file was last changed", async () => {
    // Sixty sessions; the files changed most recently hold the oldest activity.
    for (let i = 0; i < HISTORY_PAGE_SIZE + 10; i += 1) {
      transcript(
        "p",
        id(i),
        [user(T0 + i * 1000)],
        T0 + (HISTORY_PAGE_SIZE + 10 - i) * 60_000,
      );
    }
    const history = createHistory({ root, read: noUsage });
    const first = await history.page(0, []);
    const second = await history.page(1, []);
    const times = [...first.sessions, ...second.sessions].map(
      (entry) => entry.lastActivityAt ?? 0,
    );
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(first.sessions[0]?.sessionId).toBe(id(HISTORY_PAGE_SIZE + 9));
  });

  it("reads the last timestamp from the end of a transcript only", async () => {
    const file = transcript("p", id(1), [
      user(T0),
      user(T0 + 7000),
      { type: "summary" },
    ]);
    expect(
      await readLastTimestamp(
        file,
        (await import("node:fs")).statSync(file).size,
      ),
    ).toBe(T0 + 7000);
  });

  it("makes requests take turns, so the reader never serves two at once", async () => {
    for (let i = 0; i < 3; i += 1) transcript("p", id(i), [user(T0 + i)]);
    let active = 0;
    let most = 0;
    const read: UsageReader = async (sessions) => {
      active += 1;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { sessions, warnings: [] };
    };
    const history = createHistory({ root, read });
    await Promise.all([
      history.page(0, []),
      history.page(0, []),
      history.find(id(1)),
    ]);
    expect(most).toBe(1);
  });

  it("keeps going after a request fails", async () => {
    transcript("p", id(1), [user(T0)]);
    let fail = true;
    const read: UsageReader = (sessions) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error("x"));
      }
      return Promise.resolve({ sessions, warnings: [] });
    };
    const history = createHistory({ root, read });
    expect((await history.page(0, [])).sessions).toHaveLength(1);
    expect((await history.page(0, [])).sessions).toHaveLength(1);
  });

  it("shows a session found in two project folders once, from its newer file", async () => {
    transcript("old", id(1), [user(T0, "C:\\older")], T0);
    transcript("new", id(1), [user(T0, "C:\\newer")], T0 + 60_000);
    const page = await createHistory({ root, read: noUsage }).page(0, []);
    expect(page.sessions).toHaveLength(1);
    expect(page.sessions[0]?.folder).toBe("C:\\newer");
  });

  it("never starts a fork after its last activity", () => {
    expect(startTime(T0, T0 + FORK_COPY_MS * 10, T0 + 5000)).toBe(T0 + 5000);
  });
});

describe("reading the last timestamp quickly", () => {
  it("finds it in the short tail, and falls back to 256 KB when the end is one long line", async () => {
    const plain = transcript("p", id(1), [user(T0), user(T0 + 4000)]);
    const { statSync } = await import("node:fs");
    expect(
      await readLastTimestamp(plain, statSync(plain).size, 16 * 1024),
    ).toBe(T0 + 4000);
    const padded = transcript("p", id(2), [
      user(T0 + 9000),
      { type: "x", pad: "z".repeat(40 * 1024) },
    ]);
    expect(
      await readLastTimestamp(padded, statSync(padded).size, 16 * 1024),
    ).toBeNull();
    const page = await createHistory({ root, read: noUsage }).page(0, []);
    expect(
      page.sessions.find((entry) => entry.sessionId === id(2))?.lastActivityAt,
    ).toBe(T0 + 9000);
  });
});
