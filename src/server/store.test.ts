import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FinishedSession } from "../shared/protocol.js";
import { createFileStore, dataDirectory } from "./store.js";

const record: FinishedSession = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  kind: "interactive",
  cwd: "C:/work",
  startedAt: 1,
  name: "demo",
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
    expect(createFileStore(dir).load()).toEqual({ records: [], notice: null });
  });

  it("creates its folder and loads what it saved", () => {
    const nested = join(dir, "a", "b");
    const store = createFileStore(nested);

    expect(store.save([record])).toBeNull();

    expect(store.load()).toEqual({ records: [record], notice: null });
  });

  it("leaves no temporary files behind", () => {
    createFileStore(dir).save([record]);
    expect(readdirSync(dir)).toEqual(["finished-sessions.json"]);
  });

  it("sets aside a corrupt file and reports it", () => {
    const file = join(dir, "finished-sessions.json");
    writeFileSync(file, "{ not json");

    const result = createFileStore(dir).load();

    expect(result.records).toEqual([]);
    expect(result.notice).toBeTruthy();
    expect(existsSync(file)).toBe(false);
    const names = readdirSync(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toContain("corrupt");
  });

  it("treats a file with the wrong structure as corrupt", () => {
    const file = join(dir, "finished-sessions.json");
    writeFileSync(
      file,
      JSON.stringify({ version: 1, sessions: [{ finishedAt: "soon" }] }),
    );

    const result = createFileStore(dir).load();

    expect(result.records).toEqual([]);
    expect(result.notice).toBeTruthy();
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

  it("uses XDG_DATA_HOME on Linux, or falls back under the home folder", () => {
    expect(dataDirectory("linux", { XDG_DATA_HOME: "/data" }, "/home/a")).toBe(
      join("/data", "cc-session-manager"),
    );
    expect(dataDirectory("linux", {}, "/home/a")).toBe(
      join("/home/a", ".local", "share", "cc-session-manager"),
    );
  });

  it("is never under the Claude data folder", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(dataDirectory(platform, {}, "/home/a")).not.toContain(".claude");
    }
  });
});
