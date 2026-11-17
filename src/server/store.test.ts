import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { FinishedSession, UsageGroup } from "../shared/protocol.js";
import {
  CORRUPT_NAME,
  createFileStore,
  dataDirectory,
  secureDataFolder,
  scrubNames,
} from "./store.js";
import { createSessionTracker } from "./tracker.js";

const record: FinishedSession = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  kind: "interactive",
  cwd: "C:/work",
  startedAt: 1,
  needsAttention: false,
  attentionReason: null,
  finished: true,
  statusLabel: "finished",
  finishedAt: 2,
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccsm-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createFileStore", () => {
  it("starts empty with no notice when there is no file", () => {
    expect(createFileStore(dir).load()).toEqual({
      records: [],
      notice: null,
      needsRewrite: false,
    });
  });

  it("creates its folder and loads what it saved", () => {
    const nested = join(dir, "a", "b");
    const store = createFileStore(nested);

    expect(store.save([record])).toBeNull();

    expect(store.load()).toEqual({
      records: [record],
      notice: null,
      needsRewrite: false,
    });
  });

  it("keeps transcript metadata in saved sessions", () => {
    const store = createFileStore(dir);
    const withMetadata = {
      ...record,
      gitBranch: "main",
      model: "m",
      lastActivityAt: 3,
    };

    store.save([withMetadata]);

    expect(store.load().records).toEqual([withMetadata]);
  });

  it("never writes session names, which can hold prompt text", () => {
    createFileStore(dir).save([{ ...record, name: "my secret prompt" }]);

    const raw = readFileSync(join(dir, "finished-sessions.json"), "utf8");
    expect(raw).not.toContain("my secret prompt");
    expect(raw).not.toContain('"name"');
  });

  it("drops names already in an older file when loading", () => {
    writeFileSync(
      join(dir, "finished-sessions.json"),
      JSON.stringify({
        version: 1,
        sessions: [{ ...record, name: "my secret prompt" }],
      }),
    );

    const { records } = createFileStore(dir).load();

    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain("my secret prompt");
  });

  it("leaves no temporary files behind", () => {
    createFileStore(dir).save([record]);
    expect(readdirSync(dir)).toEqual(["finished-sessions.json"]);
  });

  it("deletes a file that isn't JSON, and logs it without its contents", () => {
    const file = join(dir, "finished-sessions.json");
    writeFileSync(file, '{ "name": "my secret prompt", not json');
    const log = vi.fn();

    const result = createFileStore(dir, { log }).load();

    expect(result.records).toEqual([]);
    expect(result.notice).toBeTruthy();
    expect(readdirSync(dir)).toEqual([]);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });

  it("sets aside a file with the wrong structure, with names removed", () => {
    const file = join(dir, "finished-sessions.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        sessions: [
          {
            finishedAt: "soon",
            name: "my secret prompt",
            nested: { title: "another secret", kept: 1 },
          },
        ],
      }),
    );
    const log = vi.fn();

    const result = createFileStore(dir, { log }).load();

    expect(result.records).toEqual([]);
    expect(result.notice).toBeTruthy();
    expect(readdirSync(dir)).toEqual([CORRUPT_NAME]);
    const kept = readFileSync(join(dir, CORRUPT_NAME), "utf8");
    expect(kept).not.toContain("secret");
    expect(JSON.parse(kept)).toEqual({
      version: 1,
      sessions: [{ finishedAt: "soon", nested: { kept: 1 } }],
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });

  it("keeps only one corrupt copy, replacing the earlier one", () => {
    const file = join(dir, "finished-sessions.json");
    const store = createFileStore(dir, { log: vi.fn() });
    writeFileSync(file, JSON.stringify({ version: 1, sessions: "first" }));
    store.load();
    writeFileSync(file, JSON.stringify({ version: 1, sessions: "second" }));
    store.load();

    expect(readdirSync(dir)).toEqual([CORRUPT_NAME]);
    expect(readFileSync(join(dir, CORRUPT_NAME), "utf8")).toContain("second");
  });

  it("leaves a file it can't open alone, and doesn't save over it", () => {
    // A folder in the file's place can't be read, as a locked file can't.
    const file = join(dir, "finished-sessions.json");
    mkdirSync(file);
    const store = createFileStore(dir, { log: vi.fn() });

    const result = store.load();

    expect(result.records).toEqual([]);
    expect(result.notice).toContain("left as it is");
    expect(store.save([record])).toBe(result.notice);
    expect(statSync(file).isDirectory()).toBe(true);
    expect(readdirSync(dir)).toEqual(["finished-sessions.json"]);
  });

  it("does not load fields outside the allow-list", () => {
    const file = join(dir, "finished-sessions.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        sessions: [{ ...record, message: "private text" }],
      }),
    );

    const { records } = createFileStore(dir).load();

    expect(JSON.stringify(records)).not.toContain("private text");
  });

  it("does not write fields outside the allow-list", () => {
    const store = createFileStore(dir);
    store.save([{ ...record, message: "private text" } as FinishedSession]);

    const raw = readFileSync(join(dir, "finished-sessions.json"), "utf8");
    expect(raw).not.toContain("private text");
  });

  it("reports a write failure instead of throwing", () => {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "");
    const store = createFileStore(join(blocker, "child"));

    expect(store.save([record])).toBeTruthy();
  });

  it("does not put paths or session values into notices", () => {
    const file = join(dir, "finished-sessions.json");
    writeFileSync(file, "{ not json");

    const { notice } = createFileStore(dir).load();

    expect(notice).not.toContain(dir);
  });
});

describe("scrubNames", () => {
  it("removes name and title at any depth, and keeps everything else", () => {
    expect(
      scrubNames([
        { name: "a", title: "b", keep: [{ name: "c", other: null }] },
        "name",
        3,
      ]),
    ).toEqual([{ keep: [{ other: null }] }, "name", 3]);
  });
});

describe("corrupt copies left by 0.1.0", () => {
  const old = (time: number, text: string) => {
    writeFileSync(
      join(dir, `finished-sessions.corrupt-${String(time)}.json`),
      text,
    );
  };

  it("keeps only the newest, scrubbed, as the one corrupt copy", () => {
    old(100, JSON.stringify({ sessions: [{ name: "older secret" }] }));
    old(300, JSON.stringify({ sessions: [{ name: "newest secret", n: 3 }] }));
    old(20, "not json");

    createFileStore(dir, { log: vi.fn() }).load();

    expect(readdirSync(dir)).toEqual([CORRUPT_NAME]);
    expect(JSON.parse(readFileSync(join(dir, CORRUPT_NAME), "utf8"))).toEqual({
      sessions: [{ n: 3 }],
    });
  });

  it("deletes the newest too when it isn't JSON", () => {
    old(300, "{ name: newest secret");
    old(100, JSON.stringify({ sessions: [] }));
    const log = vi.fn();

    createFileStore(dir, { log }).load();

    expect(readdirSync(dir)).toEqual([]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });

  it("deletes them all when this version has already set one aside", () => {
    writeFileSync(join(dir, CORRUPT_NAME), "{}");
    old(300, JSON.stringify({ sessions: [{ name: "secret" }] }));

    createFileStore(dir, { log: vi.fn() }).load();

    expect(readdirSync(dir)).toEqual([CORRUPT_NAME]);
    expect(readFileSync(join(dir, CORRUPT_NAME), "utf8")).toBe("{}");
  });
});

describe("saved usage", () => {
  const group: UsageGroup = {
    model: "claude-opus-5-5",
    speed: "standard",
    geo: "global",
    source: "main",
    longContext: false,
    input: 1_000_000,
    output: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    webSearches: 0,
  };
  const withUsage: FinishedSession = {
    ...record,
    usage: { groups: [group], counting: false, cost: 4, unpriced: [] },
  };

  it("saves token counts and model IDs, but not the cost", () => {
    createFileStore(dir).save([withUsage]);

    const raw = JSON.parse(
      readFileSync(join(dir, "finished-sessions.json"), "utf8"),
    ) as { sessions: FinishedSession[] };
    expect(raw.sessions[0]?.usage).toEqual({
      groups: [group],
      counting: false,
    });
  });

  it("works out the cost again from the price table on load", () => {
    const store = createFileStore(dir);
    store.save([
      {
        ...withUsage,
        usage: {
          groups: [group, { ...group, model: "claude-new" }],
          counting: true,
          cost: 999,
          unpriced: [],
        },
      },
    ]);

    const { records, needsRewrite } = store.load();

    expect(records[0]?.usage).toEqual({
      groups: [group, { ...group, model: "claude-new" }],
      counting: true,
      cost: 4,
      unpriced: ["claude-new"],
    });
    expect(needsRewrite).toBe(false);
  });

  it("never writes text from a usage group's other fields", () => {
    createFileStore(dir).save([
      {
        ...withUsage,
        usage: {
          counting: false,
          cost: 0,
          unpriced: [],
          groups: [{ ...group, text: "private text" } as UsageGroup],
        },
      },
    ]);

    const raw = readFileSync(join(dir, "finished-sessions.json"), "utf8");
    expect(raw).not.toContain("private text");
  });

  it("reads a file from 0.1.0, which has no usage", () => {
    writeFileSync(
      join(dir, "finished-sessions.json"),
      JSON.stringify({ version: 1, sessions: [record] }),
    );

    expect(createFileStore(dir).load().records).toEqual([record]);
  });

  it("writes records that 0.1.0's schema still accepts", () => {
    // 0.1.0's record schema, unchanged, which drops fields it doesn't know.
    const v010Record = z.object({
      cwd: z.string().optional(),
      kind: z.string().optional(),
      startedAt: z.number().optional(),
      id: z.string().optional(),
      state: z.string().optional(),
      pid: z.number().optional(),
      status: z.string().optional(),
      waitingFor: z.string().optional(),
      sessionId: z.string().optional(),
      needsAttention: z.boolean(),
      attentionReason: z.string().nullable(),
      finished: z.boolean(),
      statusLabel: z.string(),
      finishedAt: z.number(),
      gitBranch: z.string().optional(),
      model: z.string().optional(),
      lastActivityAt: z.number().optional(),
    });
    const v010File = z.object({
      version: z.literal(1),
      sessions: z.array(v010Record),
    });
    createFileStore(dir).save([withUsage]);

    const raw: unknown = JSON.parse(
      readFileSync(join(dir, "finished-sessions.json"), "utf8"),
    );
    expect(v010File.safeParse(raw).success).toBe(true);
  });
});

describe("older files", () => {
  const file = () => join(dir, "finished-sessions.json");
  const writeOlderFile = (fields: Record<string, unknown>) => {
    writeFileSync(
      file(),
      JSON.stringify({ version: 1, sessions: [{ ...record, ...fields }] }),
    );
  };

  it("flags a file that holds a name, so it gets rewritten", () => {
    writeOlderFile({ name: "my secret prompt" });
    expect(createFileStore(dir).load().needsRewrite).toBe(true);
  });

  it("does not flag a clean file", () => {
    const store = createFileStore(dir);
    store.save([record]);
    expect(store.load().needsRewrite).toBe(false);
  });

  it("removes a stored HEAD branch when loading", () => {
    writeOlderFile({ gitBranch: "HEAD" });

    const { records, needsRewrite } = createFileStore(dir).load();

    expect(records[0]?.gitBranch).toBeUndefined();
    expect(needsRewrite).toBe(true);
  });

  it("removes a name from disk on the tracker's first update", () => {
    writeOlderFile({ name: "my secret prompt", finishedAt: 1000 });
    const tracker = createSessionTracker({
      store: createFileStore(dir),
      now: () => 2000,
    });

    const { sessions } = tracker.update([]);

    expect(sessions).toHaveLength(1);
    expect(readFileSync(file(), "utf8")).not.toContain("my secret prompt");
  });

  it("does not create a file when there is nothing to store", () => {
    const tracker = createSessionTracker({
      store: createFileStore(dir),
      now: () => 2000,
    });

    tracker.update([]);

    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("dataDirectory", () => {
  it("uses LOCALAPPDATA on Windows", () => {
    expect(
      dataDirectory("win32", { LOCALAPPDATA: "C:/Local" }, "C:/Home"),
    ).toContain(join("C:/Local", "cc-session-manager"));
  });

  it("uses Application Support on macOS", () => {
    expect(dataDirectory("darwin", {}, "/home/a")).toBe(
      join("/home/a", "Library", "Application Support", "cc-session-manager"),
    );
  });

  it("uses XDG_STATE_HOME on Linux when it's absolute, or ~/.local/state (FR-41)", () => {
    expect(
      dataDirectory("linux", { XDG_STATE_HOME: "/state" }, "/home/a"),
    ).toBe(join("/state", "cc-session-manager"));
    expect(dataDirectory("linux", { XDG_STATE_HOME: "state" }, "/home/a")).toBe(
      join("/home/a", ".local", "state", "cc-session-manager"),
    );
    expect(dataDirectory("linux", {}, "/home/a")).toBe(
      join("/home/a", ".local", "state", "cc-session-manager"),
    );
  });

  it("is never under the Claude data folder", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(dataDirectory(platform, {}, "/home/a")).not.toContain(".claude");
    }
  });
});

describe("a private data folder on macOS and Linux (FR-41)", () => {
  it("does nothing on Windows", () => {
    expect(secureDataFolder("C:/nowhere", "win32", 1000)).toBeNull();
  });

  // Modes, links, and owners only mean this on macOS and Linux.
  describe.runIf(process.platform !== "win32")("on this system", () => {
    let folder = "";
    const uid = process.getuid?.() ?? -1;
    beforeEach(() => {
      folder = mkdtempSync(join(tmpdir(), "ccsm-private-"));
    });
    afterEach(() => {
      rmSync(folder, { recursive: true, force: true });
    });

    it("creates a missing folder private before checking it", () => {
      const missing = join(folder, "new");
      expect(secureDataFolder(missing, process.platform, uid)).toBeNull();
      expect(statSync(missing).mode & 0o777).toBe(0o700);
    });

    it("sets a folder and its files back to the user's own modes", () => {
      chmodSync(folder, 0o755);
      writeFileSync(join(folder, "instance.json"), "{}", { mode: 0o644 });
      expect(secureDataFolder(folder, process.platform, uid)).toBeNull();
      expect(statSync(folder).mode & 0o777).toBe(0o700);
      expect(statSync(join(folder, "instance.json")).mode & 0o777).toBe(0o600);
    });

    it("refuses a folder or file that's a link, or someone else's", () => {
      writeFileSync(join(folder, "elsewhere"), "{}");
      symlinkSync(join(folder, "elsewhere"), join(folder, "instance.json"));
      expect(secureDataFolder(folder, process.platform, uid)).toMatch(
        /isn't a file of your own/,
      );
      const link = `${folder}-link`;
      symlinkSync(folder, link);
      try {
        expect(secureDataFolder(link, process.platform, uid)).toMatch(
          /isn't a folder of your own/,
        );
      } finally {
        rmSync(link, { force: true });
      }
      expect(secureDataFolder(folder, process.platform, uid + 1)).toMatch(
        /isn't a folder of your own/,
      );
    });
  });
});
