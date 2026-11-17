import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkPosixFolder,
  isLocalMount,
  MAX_LINKS,
  type MountTable,
  mountFor,
  parseMacMount,
  parseMountinfo,
  readMountTable,
  resolveLocal,
  type ResolveFs,
  visibleMounts,
} from "./posix-folders.js";

// Lines in the shape the probes saw on Ubuntu 26.04 (U-31).
const MOUNTINFO = [
  "22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
  "23 22 0:21 / /proc rw,nosuid shared:2 - proc proc rw",
  "40 22 0:35 / /tmp/m/sp\\040ace\\011tab\\012nl\\134bs rw - tmpfs tmpfs rw",
  "41 22 0:36 / /mnt/nfs rw shared:30 - nfs server:/export rw,vers=3",
  "42 22 0:37 / /mnt/sshfs rw - fuse.sshfs me@host:/ rw",
  "",
].join("\n");

// Lines in the shape the probes saw on macOS 26 (U-31).
const MAC_MOUNT = [
  "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
  "devfs on /dev (devfs, local, nobrowse)",
  "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
  '/dev/disk4s1 on /Volumes/we ird (x) "q" $v (apfs, local, nodev, nosuid, journaled)',
  "//me@server/share on /Volumes/share (smbfs, nodev, nosuid, mounted by me)",
].join("\n");

describe("reading the mount table (FR-44, U-31)", () => {
  it("parses Linux's mountinfo, decoding its escapes", () => {
    const table = parseMountinfo(MOUNTINFO);
    expect(table.map((mount) => [mount.point, mount.type])).toEqual([
      ["/", "ext4"],
      ["/proc", "proc"],
      ["/tmp/m/sp ace\ttab\nnl\\bs", "tmpfs"],
      ["/mnt/nfs", "nfs"],
      ["/mnt/sshfs", "fuse.sshfs"],
    ]);
  });

  it("parses macOS's mount output, with its local flag and odd volume names", () => {
    const table = parseMacMount(MAC_MOUNT);
    expect(table).toEqual([
      { point: "/", type: "apfs", local: true },
      { point: "/dev", type: "devfs", local: true },
      { point: "/System/Volumes/Data/home", type: "autofs", local: false },
      { point: '/Volumes/we ird (x) "q" $v', type: "apfs", local: true },
      { point: "/Volumes/share", type: "smbfs", local: false },
    ]);
  });

  it("counts only known local types, and on macOS only with the local flag", () => {
    expect(isLocalMount({ point: "/", type: "ext4" }, "linux")).toBe(true);
    expect(isLocalMount({ point: "/", type: "ecryptfs" }, "linux")).toBe(true);
    expect(isLocalMount({ point: "/", type: "vfat" }, "linux")).toBe(true);
    for (const type of [
      "nfs",
      "nfs4",
      "cifs",
      "fuse.sshfs",
      "fuseblk",
      "9p",
      "virtiofs",
      "autofs",
      "proc",
    ]) {
      expect(isLocalMount({ point: "/", type }, "linux")).toBe(false);
    }
    expect(
      isLocalMount({ point: "/", type: "apfs", local: true }, "darwin"),
    ).toBe(true);
    expect(
      isLocalMount({ point: "/", type: "zfs", local: true }, "darwin"),
    ).toBe(true);
    expect(
      isLocalMount({ point: "/", type: "apfs", local: false }, "darwin"),
    ).toBe(false);
    expect(
      isLocalMount({ point: "/", type: "smbfs", local: true }, "darwin"),
    ).toBe(false);
  });
});

describe("which mount a folder is on (FR-44)", () => {
  it("matches the longest prefix on whole parts", () => {
    const visible = visibleMounts(parseMountinfo(MOUNTINFO));
    expect(mountFor("/mnt/nfs/sub", visible)?.type).toBe("nfs");
    expect(mountFor("/mnt/nfsfoo", visible)?.type).toBe("ext4");
    expect(mountFor("/home/me", visible)?.type).toBe("ext4");
  });

  it("leaves out a mount a later one covers, so a network mount over a parent wins", () => {
    const table: MountTable = [
      { point: "/", type: "ext4" },
      { point: "/x/y", type: "tmpfs" },
      { point: "/x", type: "nfs" },
    ];
    const visible = visibleMounts(table);
    expect(visible.map((mount) => mount.point)).toEqual(["/", "/x"]);
    expect(mountFor("/x/y/z", visible)?.type).toBe("nfs");
  });

  it("takes the later of two mounts on the same point", () => {
    const visible = visibleMounts([
      { point: "/", type: "ext4" },
      { point: "/s", type: "tmpfs" },
      { point: "/s", type: "nfs" },
    ]);
    expect(mountFor("/s/a", visible)?.type).toBe("nfs");
  });
});

/** A small file system: folders, and links to targets. */
function fakeFs(links: Record<string, string>, folders: string[]) {
  const touched: string[] = [];
  const fs: ResolveFs = {
    lstat: (path) => {
      touched.push(path);
      if (path in links) return Promise.resolve({ isSymbolicLink: () => true });
      if (folders.includes(path))
        return Promise.resolve({ isSymbolicLink: () => false });
      return Promise.reject(new Error("ENOENT"));
    },
    readlink: (path) => Promise.resolve(links[path] ?? ""),
  };
  return { fs, touched };
}

describe("resolving a folder one part at a time (FR-44)", () => {
  const visible = visibleMounts([
    { point: "/", type: "ext4" },
    { point: "/net", type: "nfs" },
  ]);

  it("follows relative and absolute links, and .. from the physical path", async () => {
    const { fs } = fakeFs({ "/a/rel": "../b", "/a/abs": "/c/d" }, [
      "/a",
      "/b",
      "/c",
      "/c/d",
    ]);
    expect(await resolveLocal("/a/rel", visible, "linux", fs)).toEqual({
      ok: true,
      path: "/b",
    });
    expect(await resolveLocal("/a/abs", visible, "linux", fs)).toEqual({
      ok: true,
      path: "/c/d",
    });
    expect(await resolveLocal("/../../a", visible, "linux", fs)).toEqual({
      ok: true,
      path: "/a",
    });
  });

  it("refuses before touching anything on a network mount, even through a link", async () => {
    const { fs, touched } = fakeFs({ "/a/link": "/net/share" }, ["/a"]);
    expect(await resolveLocal("/a/link/x", visible, "linux", fs)).toEqual({
      ok: false,
      reason: "not-local",
    });
    expect(touched.some((path) => path.startsWith("/net"))).toBe(false);
    const direct = fakeFs({}, []);
    expect(await resolveLocal("/net/x", visible, "linux", direct.fs)).toEqual({
      ok: false,
      reason: "not-local",
    });
    expect(direct.touched).toEqual([]);
  });

  it("stops after too many links, and says when a folder is missing", async () => {
    const { fs } = fakeFs({ "/loop": "/loop" }, []);
    expect(await resolveLocal("/loop", visible, "linux", fs)).toEqual({
      ok: false,
      reason: "links",
    });
    expect(MAX_LINKS).toBe(40);
    const empty = fakeFs({}, []);
    expect(await resolveLocal("/nope", visible, "linux", empty.fs)).toEqual({
      ok: false,
      reason: "missing",
    });
  });
});

describe("checking a folder (FR-44)", () => {
  const table = () =>
    Promise.resolve<MountTable>([
      { point: "/", type: "ext4" },
      { point: "/proc", type: "proc" },
      { point: "/net", type: "nfs" },
    ]);
  const plain = fakeFs({}, ["/work", "/proc"]);
  const options = {
    platform: "linux" as const,
    readTable: table,
    fs: plain.fs,
    isDirectory: () => Promise.resolve(true),
  };

  it("takes a local folder, and refuses relative, control, network, and system paths", async () => {
    expect(await checkPosixFolder("/work", options)).toEqual({
      ok: true,
      folder: "/work",
    });
    expect((await checkPosixFolder("work", options)).ok).toBe(false);
    expect((await checkPosixFolder("/wo\nrk", options)).ok).toBe(false);
    expect(await checkPosixFolder("/net/a", options)).toMatchObject({
      ok: false,
      message: expect.stringMatching(
        /isn't on a local disk/,
      ) as unknown as string,
    });
    expect((await checkPosixFolder("/proc", options)).ok).toBe(false);
  });

  it("refuses when the mount table can't be read", async () => {
    expect(
      await checkPosixFolder("/work", {
        ...options,
        readTable: () => Promise.resolve(null),
      }),
    ).toMatchObject({ ok: false });
  });
});

// The real mount table and file system, on macOS and Linux only.
describe.runIf(process.platform !== "win32")("on this system (FR-44)", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccsm-posix-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads the real mount table, with / on a local disk", async () => {
    const table = await readMountTable();
    expect(table).not.toBeNull();
    expect(table?.some((mount) => mount.point === "/")).toBe(true);
  });

  it("accepts a real temporary folder through a link, resolved", async () => {
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    const checked = await checkPosixFolder(join(root, "link"));
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.folder.endsWith("/real")).toBe(true);
    expect((await checkPosixFolder(join(root, "missing"))).ok).toBe(false);
  });
});
