import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cachedLocalDrives,
  createFolderPicker,
  MAX_FOLDERS,
  powershellLocalDrives,
} from "./folder-picker.js";
import type { DriveTypeReader } from "./local-folder.js";
import { resolvePrograms } from "./programs.js";

const fixed: DriveTypeReader = () => Promise.resolve("Fixed");
const drives = () => Promise.resolve(["C:\\"]);

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccsm-picker-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the folder picker (FR-32, NFR-15)", () => {
  it("lists subfolders only, sorted, with the local drives", async () => {
    mkdirSync(join(root, "beta"));
    mkdirSync(join(root, "Alpha"));
    writeFileSync(join(root, "file.txt"), "x");
    const pick = createFolderPicker({ driveType: fixed, localDrives: drives });
    const listing = await pick(root);
    expect(listing.outcome).toBe("succeeded");
    expect(listing.folders).toEqual(["Alpha", "beta"]);
    expect(listing.truncated).toBe(false);
    expect(listing.drives).toEqual(["C:\\"]);
  });

  it("starts from the home folder when none is given", async () => {
    mkdirSync(join(root, "home-child"));
    const pick = createFolderPicker({
      driveType: fixed,
      localDrives: drives,
      home: root,
    });
    const listing = await pick(undefined);
    expect(listing.folders).toEqual(["home-child"]);
  });

  it(`lists at most ${String(MAX_FOLDERS)} subfolders, and says there were more`, async () => {
    for (let i = 0; i < MAX_FOLDERS + 5; i += 1)
      mkdirSync(join(root, `f${String(i).padStart(4, "0")}`));
    const pick = createFolderPicker({ driveType: fixed, localDrives: drives });
    const listing = await pick(root);
    expect(listing.folders).toHaveLength(MAX_FOLDERS);
    expect(listing.truncated).toBe(true);
  });

  it("refuses a network share or a network drive, with the drives still offered", async () => {
    const pick = createFolderPicker({ driveType: fixed, localDrives: drives });
    const share = await pick("\\\\server\\share");
    expect(share.outcome).toBe("refused");
    expect(share.folders).toBeUndefined();
    expect(share.drives).toEqual(["C:\\"]);
    const network = createFolderPicker({
      driveType: () => Promise.resolve("Network"),
      localDrives: drives,
    });
    expect((await network(root)).outcome).toBe("refused");
  });

  it.runIf(process.platform === "win32")(
    "doesn't list junctions, so it never follows them",
    async () => {
      mkdirSync(join(root, "real"));
      execFileSync(
        "cmd.exe",
        [
          "/d",
          "/c",
          "mklink",
          "/J",
          join(root, "junction"),
          join(root, "real"),
        ],
        {
          windowsHide: true,
        },
      );
      const pick = createFolderPicker({
        driveType: fixed,
        localDrives: drives,
      });
      expect((await pick(root)).folders).toEqual(["real"]);
    },
  );

  it.runIf(process.platform === "win32")(
    "reads this PC's local drives through PowerShell",
    async () => {
      const list = powershellLocalDrives(resolvePrograms().powershell);
      const found = await list();
      expect(found).toContain("C:\\");
      expect(found.every((drive) => /^[A-Z]:\\$/.test(drive))).toBe(true);
      expect(await powershellLocalDrives(null)()).toEqual([]);
    },
    15_000,
  );
});

describe("folders Windows reports as links", () => {
  it.runIf(process.platform === "win32")(
    "lists a real folder that has a reparse point, such as OneDrive, but not a junction",
    async () => {
      const { lstatSync, readdirSync } = await import("node:fs");
      const { homedir } = await import("node:os");
      // A real folder in the home folder that readdir calls a link but lstat calls a folder, as
      // OneDrive's is. Skipped when this PC has none.
      const home = homedir();
      const tagged = readdirSync(home, { withFileTypes: true })
        .filter((entry) => entry.isSymbolicLink())
        .map((entry) => entry.name)
        .find((name) => {
          try {
            const stats = lstatSync(join(home, name));
            return stats.isDirectory() && !stats.isSymbolicLink();
          } catch {
            return false;
          }
        });
      if (tagged === undefined) return;
      const pick = createFolderPicker({
        driveType: fixed,
        localDrives: drives,
        home,
      });
      expect((await pick(undefined)).folders).toContain(tagged);
    },
    15_000,
  );

  it("remembers the drive list for a while, but not an empty one", async () => {
    let time = 0;
    let calls = 0;
    let answer = ["C:\\"];
    const cached = cachedLocalDrives(
      () => {
        calls += 1;
        return Promise.resolve(answer);
      },
      () => time,
    );
    await cached();
    await cached();
    expect(calls).toBe(1);
    time += 31_000;
    answer = [];
    await cached();
    await cached();
    expect(calls).toBe(3);
  });
});
