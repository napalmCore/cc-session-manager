# 0031: Iteration 6 requirements choices

- **Status:** Accepted
- **Date:** 2026-11-15
- **Follows:** [0030](0030-iteration-6-plan.md)

## Context

Decision 0030 brings the tool to macOS and Linux in 0.5.0, except End, Force end, and leftover programs, with Terminal on macOS and the first Linux terminal found. These parts were left for requirements: where the finished-session list is saved, how folders are checked without drive letters, how the tool finds the session that started it, and how the page shows that End isn't available.

## Options considered

- **Where the list is saved:** each system's usual place for app state (macOS `~/Library/Application Support`, Linux `$XDG_STATE_HOME` or `~/.local/state`); Linux's data folder instead (`$XDG_DATA_HOME` or `~/.local/share`); or one dot-folder in the home folder.
- **Folder checks:** refuse network filesystems by their type, and refuse a type that can't be read; or accept any existing folder.
- **Self-protection:** follow the parent processes to a `claude` process; or rely only on variables a session passes to its shell.
- **End on macOS and Linux:** hide the buttons, with one line saying so; or show them disabled with a reason.

## Decision

The owner chose the first option each time.

## Consequences

- FR-40 to FR-46, C-22, C-23, NFR-19, and NFR-20 are added, with the known unknowns U-30 to U-33 for design.
- Moving between systems doesn't move the list: each system keeps its own.
- A folder whose filesystem type can't be read is refused, which errs on the side of not touching a network folder.
- Without a machine, only CI tests macOS and Linux, so the release notes will say what wasn't checked live.
