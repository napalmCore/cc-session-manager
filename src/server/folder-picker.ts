import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { checkLocalFolder, type DriveTypeReader } from "./local-folder.js";

/** At most this many subfolders are returned for one folder (NFR-15). */
export const MAX_FOLDERS = 500;
const DRIVES_TIMEOUT_MS = 5_000;

/** What the New session form's Browse shows (FR-32). */
export interface FolderListing {
  outcome: "succeeded" | "refused";
  message: string;
  /** The folder listed, resolved, or absent when refused. */
  folder?: string;
  /** Its subfolders' names, sorted, at most MAX_FOLDERS. */
  folders?: string[];
  /** True when there were more than MAX_FOLDERS. */
  truncated?: boolean;
  /** Local drive roots, such as `C:\`, to start from. */
  drives?: string[];
}

/** Lists local drive roots, through the PowerShell the tool already uses. Never network drives. */
export function powershellLocalDrives(
  powershell: string | null,
): () => Promise<string[]> {
  return () =>
    new Promise((resolve) => {
      if (powershell === null) {
        resolve([]);
        return;
      }
      execFile(
        powershell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[System.IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name + '|' + $_.DriveType }",
        ],
        { timeout: DRIVES_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => {
          if (error !== null) {
            resolve([]);
            return;
          }
          const drives = stdout
            .split(/\r?\n/)
            .map((line) => line.trim().split("|"))
            .filter(
              ([name, type]) =>
                name !== undefined &&
                /^[A-Z]:\\$/.test(name) &&
                type !== undefined &&
                !["Network", "NoRootDirectory", "Unknown"].includes(type),
            )
            .map(([name]) => name as string);
          resolve(drives);
        },
      );
    });
}

export interface FolderPickerOptions {
  driveType: DriveTypeReader;
  localDrives: () => Promise<string[]>;
  home?: string;
}

/**
 * Lists the subfolders of a local folder for Browse (FR-32). The folder goes through the same
 * checks as Start, so network, mapped, `subst`, and linked network folders are refused. It never
 * reads files, and doesn't list links or junctions, so it never follows them (NFR-15).
 */
export function createFolderPicker(options: FolderPickerOptions) {
  return async (requested: string | undefined): Promise<FolderListing> => {
    const target =
      requested === undefined || requested === ""
        ? (options.home ?? homedir())
        : requested;
    const checked = await checkLocalFolder(target, options.driveType);
    const drives = await options.localDrives();
    if (!checked.ok) {
      return { outcome: "refused", message: checked.message, drives };
    }
    let names: string[];
    try {
      const entries = await readdir(checked.folder, { withFileTypes: true });
      names = entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    } catch {
      return {
        outcome: "refused",
        message: "That folder can't be read.",
        drives,
      };
    }
    return {
      outcome: "succeeded",
      message: "Listed.",
      folder: checked.folder,
      folders: names.slice(0, MAX_FOLDERS),
      truncated: names.length > MAX_FOLDERS,
      drives,
    };
  };
}
