# 0032: Iteration 6 design choices

- **Status:** Accepted
- **Date:** 2026-11-15
- **Amends:** C-22 and FR-44 in [0031](0031-iteration-6-requirements.md)'s requirements, and the name rules of FR-34

## Context

Design research for iteration 6 read Claude Code's documentation and the systems' manuals, and ran throwaway probes on GitHub's macOS and Ubuntu runners, as the owner chose. It found that Konsole expands `$` variables in its arguments, that reading the macOS mount table needs `/sbin/mount`, that `realpath` and `statfs` hang on a dead network mount while the mount tables don't, and that `fish` and `tcsh` break single-quoted `\` and `!`. The details are in the design's Iteration 6 section.

## Options considered

- **`$` in names:** refuse it on every system, as `%` is; or skip Konsole for a name with `$`.
- **Removable-disk filesystems:** allow FAT, exFAT, NTFS (`ntfs3`), and msdos as local; or refuse them.
- **A Linux terminal that exits with code 0 within about 2 seconds:** report failed and stop; or try the next terminal.
- **A macOS folder with `\` or `!`:** show the command for it; or open Terminal anyway.

After a design review by an agent:

- **When to try the next Linux terminal:** only when a terminal's program can't be started or there's no display, any other quick exit being failed; on any non-zero exit within about 2 seconds, as FR-43 said; or per terminal, after a probe.
- **A folder with `$` for Konsole:** leave out `--workdir` and use the working folder only, skipping Konsole if a probe shows it doesn't keep it; skip Konsole for it; or show the command.
- **More local types:** allow `ecryptfs` on Linux and `zfs` on macOS; or neither.

After a second design review:

- **A row's Resume when its folder isn't local:** offer none, with Open starting in the home folder; or offer it, with the terminal started in that folder.
- **`x-terminal-emulator` leading to an unlisted terminal:** skip it and try the listed ones; use it with the 2-second rule; or show the command.
- **Case on macOS:** always compare without case; or check each volume with `getconf`.

## Decision

The owner chose the first option each time, including after both reviews.

## Consequences

- C-22 adds `/sbin/mount` on macOS, and FR-44 names the removable-disk types and `ecryptfs`. A name can't contain `$` or `%` anywhere.
- FR-43 now tries the next terminal only when a terminal can't be started at all, so a session that fails at once opens one window, not four.
- FR-44 covers a row's Resume and Open's starting folder, and C-24 compares without case on macOS.
- A macOS folder with a control character is refused for Open and Resume, since its command can't be shown safely quoted.
- U-30 to U-33 are resolved in the requirements. Process names, the first Automation prompt, and real network mounts need a live check once a machine is available.
- Implementation starts with CI on all three systems.
