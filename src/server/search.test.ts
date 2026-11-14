import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSearch,
  MAX_QUERY,
  RESULTS_KEPT_MS,
  SNIPPET_LENGTH,
  type SearchFile,
  type SearchStatus,
  snippetAround,
  visibleText,
} from "./search.js";

const id = (n: number) =>
  `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccsm-search-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function transcript(n: number, lines: unknown[]): SearchFile {
  const file = join(root, `${id(n)}.jsonl`);
  writeFileSync(
    file,
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
  return { sessionId: id(n), file };
}

const typed = (text: string) => ({
  type: "user",
  origin: { kind: "human" },
  promptSource: "typed",
  message: { role: "user", content: text },
});
const reply = (text: string) => ({
  type: "assistant",
  message: { model: "claude-opus-5-5", content: [{ type: "text", text }] },
});

async function finish(
  search: ReturnType<typeof createSearch>,
  searchId: string,
) {
  for (let i = 0; i < 200; i += 1) {
    const status = search.poll(searchId);
    if (status.status !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("search didn't finish");
}

describe("what search reads (U-22, FR-36)", () => {
  it.each([
    ["a typed prompt", typed("NEEDLE"), ["NEEDLE"]],
    [
      "an SDK prompt",
      {
        type: "user",
        promptSource: "sdk",
        message: { content: [{ type: "text", text: "NEEDLE" }] },
      },
      ["NEEDLE"],
    ],
    ["a visible reply", reply("NEEDLE"), ["NEEDLE"]],
    [
      "thinking",
      {
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "NEEDLE" }] },
      },
      [],
    ],
    [
      "a tool call",
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", input: { q: "NEEDLE" } }] },
      },
      [],
    ],
    [
      "a tool result",
      {
        type: "user",
        toolUseResult: { stdout: "NEEDLE" },
        message: { content: "NEEDLE" },
      },
      [],
    ],
    ["an inserted message", { ...typed("NEEDLE"), isMeta: true }, []],
    [
      "a compaction summary",
      { ...typed("NEEDLE"), isCompactSummary: true },
      [],
    ],
    [
      "a task notification",
      {
        type: "user",
        origin: { kind: "task-notification" },
        message: { content: "NEEDLE" },
      },
      [],
    ],
    [
      "a command line with no origin",
      {
        type: "user",
        message: { content: "<command-name>NEEDLE</command-name>" },
      },
      [],
    ],
    [
      "a synthetic reply",
      {
        type: "assistant",
        message: {
          model: "<synthetic>",
          content: [{ type: "text", text: "NEEDLE" }],
        },
      },
      [],
    ],
    ["an API error reply", { ...reply("NEEDLE"), isApiErrorMessage: true }, []],
    ["a subagent line", { ...reply("NEEDLE"), isSidechain: true }, []],
    ["a system line", { type: "system", content: "NEEDLE" }, []],
    [
      "an attachment",
      { type: "attachment", attachment: { content: "NEEDLE" } },
      [],
    ],
    [
      "a request blob",
      { type: "api-request-blob", message: { content: "NEEDLE" } },
      [],
    ],
  ])("%s", (_label, line, expected) => {
    expect(visibleText(line as Record<string, unknown>)).toEqual(expected);
  });
});

describe("snippets (FR-36)", () => {
  it("is at most 160 characters, with the match in it, and whitespace collapsed", () => {
    const text = `${"a ".repeat(300)}\n\nTHE MATCH\t${"b ".repeat(300)}`;
    const at = text.indexOf("THE MATCH");
    const snippet = snippetAround(text, at, "THE MATCH".length);
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_LENGTH);
    expect(snippet).toContain("THE MATCH");
    expect(snippet).not.toMatch(/\s{2}|\n|\t/);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("keeps a short text whole", () => {
    expect(snippetAround("find me here", 5, 2)).toBe("find me here");
  });
});

describe("searching (FR-36, NFR-15, C-16)", () => {
  it("counts matches case-insensitively and keeps up to three snippets per session", async () => {
    const files = [
      transcript(1, [
        typed("alpha Needle one"),
        reply("needle two, NEEDLE three, needle four"),
      ]),
      transcript(2, [typed("nothing here")]),
      transcript(3, [{ ...typed("needle"), isMeta: true }]),
    ];
    const search = createSearch({ files: () => Promise.resolve(files) });
    const searchId = search.start("  needle ");
    expect(searchId).toMatch(/^[0-9a-f]{32}$/);
    const result = (await finish(search, searchId ?? "")) as Extract<
      SearchStatus,
      { status: "done" }
    >;
    expect(result.status).toBe("done");
    expect(result.filesDone).toBe(3);
    expect(result.stopped).toBe(false);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.count).toBe(4);
    expect(result.sessions[0]?.snippets).toHaveLength(3);
  });

  it("refuses a query under 2 or over 200 characters", () => {
    const search = createSearch({ files: () => Promise.resolve([]) });
    expect(search.start(" a ")).toBeNull();
    expect(search.start("x".repeat(MAX_QUERY + 1))).toBeNull();
    expect(search.start("ok")).not.toBeNull();
  });

  it("gives the results once, then drops them", async () => {
    const search = createSearch({
      files: () => Promise.resolve([transcript(1, [typed("needle")])]),
    });
    const searchId = search.start("needle") ?? "";
    expect((await finish(search, searchId)).status).toBe("done");
    expect(search.poll(searchId).status).toBe("gone");
  });

  it("drops unfetched results after a minute", async () => {
    let time = 0;
    const search = createSearch({
      files: () => Promise.resolve([transcript(1, [typed("needle")])]),
      now: () => time,
    });
    const searchId = search.start("needle") ?? "";
    // Let it finish without fetching the results.
    for (let i = 0; i < 50; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 2));
    time += RESULTS_KEPT_MS + 1;
    expect(search.poll(searchId).status).toBe("gone");
  });

  it("cancels the old search when a new one starts, and on request", async () => {
    const files = [transcript(1, [typed("needle")])];
    const search = createSearch({ files: () => Promise.resolve(files) });
    const first = search.start("needle") ?? "";
    const second = search.start("needle") ?? "";
    expect(search.poll(first).status).toBe("gone");
    expect(search.cancel(second)).toBe(true);
    expect(search.poll(second).status).toBe("gone");
    expect(search.cancel("0".repeat(32))).toBe(false);
  });

  it("stops at its time limit with the results so far, and says so", async () => {
    const files = Array.from({ length: 40 }, (_, n) =>
      transcript(n, [typed("needle"), reply("x".repeat(70_000))]),
    );
    let time = 0;
    const search = createSearch({
      files: () => Promise.resolve(files),
      now: () => {
        time += 50;
        return time;
      },
      timeMs: 1000,
    });
    const result = (await finish(
      search,
      search.start("needle") ?? "",
    )) as Extract<SearchStatus, { status: "done" }>;
    expect(result.stopped).toBe(true);
    expect(result.filesDone).toBeLessThan(40);
    expect(result.sessions.length).toBeGreaterThan(0);
  });

  it("reports progress while it runs", async () => {
    let release: () => void = () => undefined;
    const search = createSearch({
      files: () =>
        new Promise((resolve) => {
          release = () => {
            resolve([transcript(1, [typed("needle")])]);
          };
        }),
    });
    const searchId = search.start("needle") ?? "";
    expect(search.poll(searchId)).toEqual({
      status: "running",
      filesDone: 0,
      filesTotal: 0,
    });
    release();
    expect((await finish(search, searchId)).status).toBe("done");
  });

  it("never writes the query or any text to the console or standard output", async () => {
    const written: string[] = [];
    const spies = [
      vi
        .spyOn(console, "log")
        .mockImplementation((...args) => written.push(args.join(" "))),
      vi
        .spyOn(console, "error")
        .mockImplementation((...args) => written.push(args.join(" "))),
      vi
        .spyOn(console, "warn")
        .mockImplementation((...args) => written.push(args.join(" "))),
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      }),
    ];
    try {
      const files = [transcript(1, [typed("SECRET-TEXT-4411"), "not json"])];
      const search = createSearch({ files: () => Promise.resolve(files) });
      await finish(search, search.start("SECRET-TEXT") ?? "");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(written.join("\n")).not.toContain("SECRET");
  });
});
