# 0030: Close iteration 5, and iteration 6 scope

- **Status:** Accepted
- **Date:** 2026-11-15
- **Amends:** [0027](0027-iteration-5-plan.md)'s plan for iteration 6

## Context

0.4.0 was released on 2026-11-15. Iteration 5's open bugs are BUG-30, which is Medium, and BUG-7, BUG-22, BUG-23's `claude -p` half, and BUG-39, which are Low. Decision 0027 planned iteration 6, for 0.5.0, as macOS and Linux support, tested on CI only until a machine is available.

These parts of the tool are Windows-specific today: where the finished-session list is saved (`%LOCALAPPDATA%`), opening the browser, the terminals for Open, Resume, New session, and Fork (Windows Terminal or `cmd`), ending processes and finding leftover programs (a PowerShell helper), folder checks (drive letters and drive types), and finding the session that started the tool (the Windows process tree). Listing sessions, Stop, Delete, History, Search, and Send go through Claude Code itself.

## Options considered

**Scope on macOS and Linux:**

- Staged: everything except End, Force end, and leftover programs, which stay Windows-only for now.
- Full parity, with End, Force end, and leftover programs rebuilt with POSIX process tools.
- Monitoring only first, with no actions.

**Terminals:**

- macOS Terminal through `open`; on Linux, the first of `x-terminal-emulator`, `gnome-terminal`, `konsole`, and `xterm`; and if none is found, the command to run instead.
- A setting naming the terminal program, with those defaults.
- No terminals: show the command to copy.

## Decision

The owner chose the first option each time:

- **Iteration 6, 0.5.0:** on macOS and Linux, monitoring, notifications, usage, History, Search, Stop, Delete, Send, Open, Resume, New session, and Fork. End, Force end, and leftover programs stay Windows-only, and say so there. Windows is unchanged.
- **Terminals:** macOS Terminal through `open`; on Linux, the first found of `x-terminal-emulator`, `gnome-terminal`, `konsole`, and `xterm`; and if none is found, the action says so and shows the command to run.

## Consequences

- Iteration 6 starts with Requirements. They set where the list is saved on each system, how the browser opens, how folders are checked without drive letters, how the tool finds the session that started it, and what End and leftover programs say where they aren't available.
- CI runs the tests on Windows, macOS, and Linux. Live checks on macOS and Linux are recorded as not run until a machine is available (0027).
- Self-protection stays on everywhere: where the tool can't tell which session started it, Stop, Delete, End, and Send are turned off, as on Windows today.
- End, Force end, and leftover programs on macOS and Linux can be planned for a later release.
