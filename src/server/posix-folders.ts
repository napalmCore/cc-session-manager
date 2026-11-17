import { execFile } from "node:child_process";
import { lstat, readFile, readlink, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { posix } from "node:path";
import { hasControl } from "./text-checks.js";

/**
 * Folder checks on macOS and Linux (FR-44, 0032). A folder is used only if the mount table puts
 * it on a known local filesystem. The table is read before anything under the folder is touched,
 * and the folder is resolved one part at a time against it, because `realpath`, `stat`, and
 * `statfs` hang on a dead network mount while the table doesn't.
 */

/** One line of the mount table: where it's mounted, and what it is. */
export interface Mount {
  point: string;
  type: string;
  /** macOS marks local volumes; Linux doesn't need it. */
  local?: boolean;
  /** Linux's mount ID and the ID of the mount it sits on, from mountinfo. */
  id?: number;
  parent?: number;
}

/** The table, in the order the system lists it, so later mounts sit on top of earlier ones. */
export type MountTable = Mount[];

const LINUX_LOCAL = new Set([
  "ext2",
  "ext3",
  "ext4",
  "xfs",
  "btrfs",
  "zfs",
  "f2fs",
  "bcachefs",
  "jfs",
  "reiserfs",
  "ecryptfs",
  "tmpfs",
  "ramfs",
  "overlay",
  "vfat",
  "exfat",
  "ntfs3",
]);
const MAC_LOCAL = new Set(["apfs", "hfs", "zfs", "exfat", "msdos"]);
/** At most this many links are followed while resolving one folder. */
export const MAX_LINKS = 40;
const LINUX_TABLE = "/proc/self/mountinfo";
const LINUX_TABLE_TIMEOUT_MS = 2_000;
const MAC_MOUNT = "/sbin/mount";
const MAC_MOUNT_TIMEOUT_MS = 5_000;
const SYSTEM_FOLDERS = ["/proc", "/sys", "/dev"];

/** Whether a mount's type counts as local on this system (FR-44, 0032). */
export function isLocalMount(mount: Mount, platform: NodeJS.Platform): boolean {
  if (platform === "darwin") {
    return MAC_LOCAL.has(mount.type) && mount.local === true;
  }
  return LINUX_LOCAL.has(mount.type);
}

/** Linux writes space, tab, newline, and backslash in mount points as `\ooo`. */
function decodeOctal(text: string): string {
  return text.replace(/\\([0-7]{3})/g, (_, digits: string) =>
    String.fromCharCode(parseInt(digits, 8)),
  );
}

/** Parses `/proc/self/mountinfo`: the mount point is the fifth field, the type follows `-`. */
export function parseMountinfo(text: string): MountTable {
  const mounts: MountTable = [];
  for (const line of text.split("\n")) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    const point = fields[4];
    const type = fields[separator + 1];
    if (separator < 6 || point === undefined || type === undefined) continue;
    const id = Number(fields[0]);
    const parent = Number(fields[1]);
    if (!Number.isInteger(id) || !Number.isInteger(parent)) continue;
    mounts.push({ point: decodeOctal(point), type, id, parent });
  }
  return mounts;
}

/**
 * Parses macOS's `mount` output: `<source> on <path> (<type>, <flags>)`. A line that holds
 * " on " more than once can't be split for certain, and a mount point read wrong would let its
 * folders count as local, so such a table is refused as a whole (null).
 */
export function parseMacMount(text: string): MountTable | null {
  const mounts: MountTable = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    // Only " on /" separates the source from the mount point, so a volume named like
    // "Photos on SSD" is fine; a source holding " on /" too can't be split for certain.
    if (line.split(" on /").length > 2) return null;
    // The mount point is where " on /" starts it, so a source holding " on " but not
    // " on /" still splits in the right place.
    const match = /^(.+?) on (\/.*) \(([^()]*)\)$/.exec(line.trimEnd());
    if (match === null) continue;
    const flags = (match[3] ?? "").split(",").map((flag) => flag.trim());
    const type = flags[0];
    if (type === undefined || match[2] === undefined) continue;
    mounts.push({ point: match[2], type, local: flags.includes("local") });
  }
  return mounts;
}

/**
 * How paths are compared: exactly on Linux; on macOS without case or Unicode form, as its usual
 * volumes are, so `/volumes/share` still finds the mount at `/Volumes/share` (C-24).
 */
function comparable(path: string, platform: NodeJS.Platform): string {
  // Upper then lower case folds more letters than lower case alone, such as ß and ſ.
  return platform === "darwin"
    ? path.normalize("NFD").toUpperCase().toLowerCase()
    : path;
}

/** Whether `path` is `point` or under it, on whole parts. */
function within(
  path: string,
  point: string,
  platform: NodeJS.Platform = "linux",
): boolean {
  const p = comparable(path, platform);
  const m = comparable(point, platform);
  if (m === "/") return p.startsWith("/");
  return p === m || p.startsWith(`${m}/`);
}

/**
 * The mounts not covered by a later one. A mount is hidden when a later one is mounted on its
 * own point or on a folder above it, so a network mount over a parent can't be mistaken for the
 * local one beneath it (FR-44).
 */
export function visibleMounts(
  table: MountTable,
  platform: NodeJS.Platform = "linux",
): MountTable {
  return table.filter(
    (mount, i) =>
      !table
        .slice(i + 1)
        .some((later) => within(mount.point, later.point, platform)),
  );
}

/**
 * Linux: the mount a path is on, found by going down the kernel's own mount tree from the root
 * by mountinfo's IDs, at each step into the child mount whose point is the path's longest
 * prefix. A mount stacked on the same point, or moved over a parent, is that mount's child, so
 * the one on top is always reached, whatever order the lines are in (FR-44).
 */
function mountByTree(path: string, table: MountTable): Mount | null {
  const ids = new Set(table.map((mount) => mount.id));
  const roots = table.filter(
    (mount) => mount.point === "/" && !ids.has(mount.parent),
  );
  let current = roots[roots.length - 1];
  if (current === undefined) return null;
  for (let depth = 0; depth < table.length; depth += 1) {
    const here: Mount = current;
    const matching = table.filter(
      (mount) =>
        mount !== here && mount.parent === here.id && within(path, mount.point),
    );
    // A child mounted later over a folder above another child's point covers it, so the
    // earlier one is left out, as on Linux a later NFS mount at /a hides a tmpfs at /a/b.
    const children = matching.filter(
      (mount) =>
        !matching.some(
          (other) =>
            other !== mount &&
            // Linux can reuse a freed ID, so this can miss a later mount; resolveLocal
            // still checks each folder above first, and refuses there.
            (other.id ?? 0) > (mount.id ?? 0) &&
            within(mount.point, other.point),
        ),
    );
    if (children.length === 0) return here;
    current = children.reduce((a, b) =>
      b.point.length >= a.point.length ? b : a,
    );
  }
  return null;
}

/**
 * The mount a path is on. On Linux, by the mount tree; elsewhere, the visible mount whose point
 * is its longest whole-part prefix, the later listed winning a tie.
 */
export function mountFor(
  path: string,
  table: MountTable,
  platform: NodeJS.Platform = "linux",
): Mount | null {
  if (platform !== "darwin" && table.every((mount) => mount.id !== undefined)) {
    return mountByTree(path, table);
  }
  let best: Mount | null = null;
  for (const mount of visibleMounts(table, platform)) {
    if (!within(path, mount.point, platform)) continue;
    if (best === null || mount.point.length >= best.point.length) best = mount;
  }
  return best;
}

/** What resolving reads from the file system, so tests can stand in for it. */
export interface ResolveFs {
  lstat: (path: string) => Promise<{ isSymbolicLink(): boolean }>;
  readlink: (path: string) => Promise<string>;
}

export type Resolved =
  | { ok: true; path: string }
  | { ok: false; reason: "not-local" | "missing" | "links" };

/**
 * Resolves a folder one part at a time against the mount table, touching each part only after
 * the mount it's on is known to be local (FR-44). `..` goes up from the physical path resolved
 * so far, and from `/` stays at `/`. A link's target is resolved against the link's own folder,
 * or from `/` when absolute. At most MAX_LINKS links are followed in all.
 */
export async function resolveLocal(
  folder: string,
  table: MountTable,
  platform: NodeJS.Platform,
  fs: ResolveFs,
): Promise<Resolved> {
  const local = (path: string) => {
    const mount = mountFor(path, table, platform);
    return mount !== null && isLocalMount(mount, platform);
  };
  if (!local("/")) return { ok: false, reason: "not-local" };
  let resolved = "/";
  const pending = folder.split("/").filter((part) => part !== "");
  let links = 0;
  while (pending.length > 0) {
    const part = pending.shift() as string;
    if (part === ".") continue;
    if (part === "..") {
      resolved = posix.dirname(resolved);
      continue;
    }
    const candidate = posix.join(resolved, part);
    if (!local(candidate)) return { ok: false, reason: "not-local" };
    let isLink: boolean;
    try {
      isLink = (await fs.lstat(candidate)).isSymbolicLink();
    } catch {
      return { ok: false, reason: "missing" };
    }
    if (!isLink) {
      resolved = candidate;
      continue;
    }
    links += 1;
    if (links > MAX_LINKS) return { ok: false, reason: "links" };
    let target: string;
    try {
      target = await fs.readlink(candidate);
    } catch {
      return { ok: false, reason: "missing" };
    }
    // An empty target points nowhere.
    if (target === "") return { ok: false, reason: "missing" };
    if (target.startsWith("/")) resolved = "/";
    pending.unshift(...target.split("/").filter((p) => p !== ""));
  }
  return { ok: true, path: resolved };
}

/** Reads the mount table, with a time limit, or null if it can't be read. */
export function readMountTable(
  platform: NodeJS.Platform = process.platform,
): Promise<MountTable | null> {
  if (platform === "darwin") {
    return new Promise((resolve) => {
      execFile(
        MAC_MOUNT,
        [],
        {
          timeout: MAC_MOUNT_TIMEOUT_MS,
          env: { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        },
        (error, stdout) => {
          resolve(error === null ? parseMacMount(stdout) : null);
        },
      );
    });
  }
  const read = readFile(LINUX_TABLE, "utf8").then(
    (text) => parseMountinfo(text),
    () => null,
  );
  const limit = new Promise<null>((resolve) => {
    setTimeout(() => {
      resolve(null);
    }, LINUX_TABLE_TIMEOUT_MS).unref();
  });
  return Promise.race([read, limit]);
}

export interface PosixFolderOptions {
  platform?: NodeJS.Platform;
  readTable?: () => Promise<MountTable | null>;
  fs?: ResolveFs;
  isDirectory?: (path: string) => Promise<boolean>;
}

export type PosixFolderCheck =
  { ok: true; folder: string } | { ok: false; message: string };

const NOT_LOCAL =
  "That folder isn't on a local disk. Network folders and FUSE or virtual filesystems can't be used.";

/** Decides whether a folder may be used on macOS or Linux (FR-44), resolved. */
export async function checkPosixFolder(
  folder: string,
  options: PosixFolderOptions = {},
): Promise<PosixFolderCheck> {
  const platform = options.platform ?? process.platform;
  if (folder.length === 0 || folder.length > 1024) {
    return { ok: false, message: "Choose a folder." };
  }
  if (hasControl(folder) || !folder.startsWith("/")) {
    return {
      ok: false,
      message: "Use a full folder path, such as /home/you/work.",
    };
  }
  const table = await (options.readTable ?? (() => readMountTable(platform)))();
  if (table === null) {
    return {
      ok: false,
      message:
        "Couldn't read the list of mounted folders, so the folder can't be used right now. Try again.",
    };
  }
  const resolved = await resolveLocal(
    folder,
    table,
    platform,
    options.fs ?? { lstat, readlink },
  );
  if (!resolved.ok) {
    if (resolved.reason === "not-local")
      return { ok: false, message: NOT_LOCAL };
    if (resolved.reason === "links") {
      return {
        ok: false,
        message: "That folder has too many links to follow.",
      };
    }
    return { ok: false, message: "That folder doesn't exist." };
  }
  // The resolved path is checked again, since a link can lead anywhere.
  if (resolved.path.length > 1024 || hasControl(resolved.path)) {
    return { ok: false, message: "That folder can't be used." };
  }
  if (
    SYSTEM_FOLDERS.some(
      (system) =>
        resolved.path === system || resolved.path.startsWith(`${system}/`),
    )
  ) {
    return { ok: false, message: "That folder can't be used." };
  }
  // Safe to touch now: it's on a local mount.
  const isDirectory =
    options.isDirectory ??
    (async (path: string) => {
      try {
        // lstat: the path is already resolved, so a link here would be a change since.
        return (await lstat(path)).isDirectory();
      } catch {
        return false;
      }
    });
  if (!(await isDirectory(resolved.path))) {
    return { ok: false, message: "That path isn't a folder." };
  }
  return { ok: true, folder: resolved.path };
}

/**
 * Where Browse starts on macOS and Linux (FR-44): the home folder, `/`, and mounted volumes,
 * each only if it passes the checks.
 */
export async function posixPlaces(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): Promise<string[]> {
  // $USER, as FR-44 says, so Browse doesn't look the user up each time.
  const user = /^[^/\0]+$/.test(process.env.USER ?? "")
    ? (process.env.USER as string)
    : "";
  const volumeRoots =
    platform === "darwin"
      ? ["/Volumes"]
      : [
          ...(user === "" ? [] : [`/media/${user}`, `/run/media/${user}`]),
          "/mnt",
        ];
  const candidates = [home, "/"];
  for (const root of volumeRoots) {
    const checked = await checkPosixFolder(root, { platform });
    if (!checked.ok) continue;
    try {
      for (const name of (await readdir(checked.folder)).sort()) {
        candidates.push(posix.join(checked.folder, name));
      }
    } catch {
      // A root that can't be read offers nothing.
    }
  }
  const places: string[] = [];
  for (const candidate of candidates) {
    const checked = await checkPosixFolder(candidate, { platform });
    if (checked.ok && !places.includes(checked.folder)) {
      places.push(checked.folder);
    }
  }
  return places;
}
