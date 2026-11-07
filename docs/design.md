# Design

- **Status:** Signed off for iteration 1 on 2026-11-06
- **Requirements:** [requirements.md](requirements.md)
- **Decisions:** [0004](decisions/0004-provisional-stack.md), [0007](decisions/0007-iteration-1-architecture.md)

## Overview

A user runs one command. It starts a local server and opens the dashboard in the browser. Closing the command stops everything.

```text
claude agents --json --all ---+
                              |
transcript file ends ---------+--> Local server --WebSocket--> React dashboard
(metadata fields only)        |    (Hono, Zod)    (one way)
                              |
finished-sessions.json <------+
```

## Components

| Component              | Responsibility                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| CLI entry point        | Chooses a port, creates the token, starts the server, and opens the browser.                                                      |
| Session poller         | Runs one `claude agents --json --all` at a time, on the server, whatever the number of browser tabs.                              |
| Schema layer           | Uses tolerant Zod schemas that ignore unknown fields and report missing ones.                                                     |
| Metadata reader        | Reads the end of a transcript only when its modified time changes, and caches the result.                                         |
| Finished-session store | Keeps finished sessions in a JSON file and removes them after 24 hours, or as soon as the CLI stops listing a background session. |
| Auth layer             | Handles the one-time token, the session cookie, and the checks on incoming connections.                                           |
| Dashboard              | Shows the session list using React, React Aria, and CSS Modules, built with Vite and served locally.                              |
| Announcer              | Tells screen readers about sessions that newly need the user, through a polite live region.                                       |

## Data flow

1. The poller runs the CLI, waiting 3 seconds between runs. A 5-second interval would miss FR-9, because the delay includes the run itself.
2. The schema layer validates each entry and records any missing fields.
3. The metadata reader adds git branch, model, and last activity time.
4. The server compares the result with the last state, and updates the store.
5. The server sends changes to connected dashboards over WebSocket.

## Session rules

| Case                         | Rule                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Needs attention              | `status` is `waiting`, or `state` is `blocked`.                                                                 |
| Reason                       | Use `waitingFor` when present, otherwise show "needs input".                                                    |
| Finished background session  | `state` is `done`, `failed`, or `stopped`. It leaves the dashboard as soon as the CLI stops listing it.         |
| Finished interactive session | It was seen earlier and is no longer listed.                                                                    |
| End time                     | The CLI doesn't provide one, so use the time the tool first sees the session as finished, shown as approximate. |

A session sitting at a trust dialog isn't listed by the CLI, so the dashboard can't show it.

## Transcript metadata

- **Fields kept:** `gitBranch`, `message.model`, and `timestamp`. An explicit allow-list copies only these fields, and tests must confirm that no message text gets through (C-4).
- **Lookup:** `sessionId` must be a valid UUID before it is used to find `~/.claude/projects/*/<sessionId>.jsonl`, which prevents path traversal.
- **Branch `HEAD`:** the CLI writes this for a session started outside a repository and for a detached HEAD, so it shows as unavailable.
- **Format warning:** raised when no line has a usable timestamp and at least one parsed line isn't a known header type, because a new transcript starts with header lines that have none. Unknown lines warn, which covers most format changes, but see BUG-26.
- **Last activity fallback:** when no timestamp can be read, last activity is the file's modified time.
- **Partial results:** a branch or model not found near the end of a file shows as unavailable (FR-6).
- **Risk:** the transcript location and fields aren't known to be a stable interface, so failures must degrade rather than break the dashboard (NFR-4).

## Security

| Area            | Design                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Network         | Listen on the loopback interface only (NFR-1).                                                                                                         |
| Token           | Create a random token on each run, and exchange it once through the opening URL.                                                                       |
| Cookie          | Use an `HttpOnly`, `SameSite=Strict` session cookie, then remove the token from the address bar.                                                       |
| Requests        | Reject requests without a valid cookie. Check the `Host` header to block DNS rebinding.                                                                |
| WebSocket       | Check the cookie and `Origin` when the connection opens to block cross-site connections. In iteration 1, the server ignores messages from the browser. |
| Browser policy  | Set a strict Content Security Policy that only allows local assets (NFR-3).                                                                            |
| Logs            | Never log the token, cookie, or transcript content.                                                                                                    |
| Forbidden files | Never read `.credentials.json` or `.key` files (C-2).                                                                                                  |
| Rendering       | Rely on React's text escaping, and don't inject raw HTML.                                                                                              |

## Storage

Finished sessions are saved in the tool's own data folder, never under `~/.claude` (C-1). On Windows, this is `%LOCALAPPDATA%\cc-session-manager\finished-sessions.json`. Each write goes to a temporary file that then replaces the original, so a crash can't leave a half-written file.

The file holds project paths, but no session names and no message text. Names are left out because the CLI can use a prompt as the name until a title is generated. An older file holding a name or a `HEAD` branch is rewritten on the first update. A corrupt file is set aside unchanged, so a corrupt older file could still hold names.

Records stay in the file while the CLI still lists a session, even after 24 hours, so a completed background session doesn't look newly finished on the next poll. A completed background session first seen by the tool, including on its first run, is treated as finishing at that moment, because the CLI doesn't report end times.

## Failure handling

| Failure                                       | Behavior                                                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude` isn't installed or the command fails | Show a banner explaining the problem, and keep retrying.                                                                                                                                             |
| Output can't be parsed                        | Keep the last good data, mark it as out of date, and show a banner.                                                                                                                                  |
| A field is missing                            | Mark it as unavailable and show a banner. The exception is a missing `status` on an identified interactive session not listed in the previous successful poll, which raises no banner for that poll. |
| Transcript is missing or unreadable           | Show the session without metadata.                                                                                                                                                                   |
| Store file is corrupt                         | Set it aside, start with an empty list, and show a notice.                                                                                                                                           |
| Default port is busy                          | Try the next free port.                                                                                                                                                                              |

## Requirements coverage

| Requirement         | Covered by                              |
| ------------------- | --------------------------------------- |
| FR-1, FR-3, FR-4    | Session poller, schema layer, dashboard |
| FR-2                | Finished-session store                  |
| FR-5, FR-7, FR-8    | Session rules, dashboard                |
| FR-6                | Metadata reader                         |
| FR-9                | Session poller, WebSocket               |
| NFR-1, NFR-2, NFR-3 | Security                                |
| NFR-4               | Schema layer, failure handling          |
| NFR-5               | React Aria, accessibility testing       |

## Build plan

Each step is a separate pull request. The owner approved steps 1 to 7, and since decision 0012, an independent agent approves pull requests before merge.

| Step | Pull request                                                                | Covers                   |
| ---- | --------------------------------------------------------------------------- | ------------------------ |
| 1    | Project scaffold: TypeScript, linting, tests, Node version pin, and CI      | Foundation               |
| 2    | Thin end-to-end slice: CLI to poller to secured WebSocket to a basic page   | FR-1, FR-9, NFR-1, NFR-2 |
| 3    | Session rules and tolerant parsing                                          | FR-3, FR-4, FR-5, NFR-4  |
| 4    | Finished-session store                                                      | FR-2                     |
| 5    | Transcript metadata reader                                                  | FR-6, C-4                |
| 6    | Dashboard UI: attention sorting, tab count, and banners                     | FR-7, FR-8, NFR-4        |
| 7    | Hardening: Content Security Policy, browser tests, and accessibility checks | NFR-3, NFR-5             |

## Open items

- **Phase 6 (Release):** packaging and distribution, including a packaged executable for users without Node.

## Iteration 2 design

- **Status:** Draft, not yet reviewed
- **Requirements:** FR-11 to FR-22, C-8 to C-11, NFR-6 to NFR-10 in [requirements.md](requirements.md)
- **Decisions:** [0014](decisions/0014-iteration-2-scope.md), [0015](decisions/0015-iteration-2-design.md)

Facts below come from tests on Windows 11 with Claude Code 2.1.319, installed through npm, on 2026-11-07, unless they're marked as coming from the docs.

### New components

| Component            | Responsibility                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Program resolver     | Finds absolute paths for `claude.exe`, `wt.exe`, `cmd.exe`, and `powershell.exe` at startup, without searching any session's folder (C-11).                                                   |
| Action route         | Accepts `POST /api/actions` with an action name and a session key, applies the access and action rules, and returns a result in the tool's own words.                                         |
| Action planner       | Builds a fixed command from the server's own data, never from page text (NFR-7).                                                                                                              |
| Process helper       | A PowerShell script shipped with the tool. It checks that a process ID still belongs to a session while holding a handle on it, sends Ctrl+Break, or force-ends the session and its children. |
| Self-protection      | Records at startup which session started the tool, and blocks Stop, Delete, and End on it (FR-22).                                                                                            |
| Single-instance lock | Lets a second start hand over to the running instance, so the port, and the browser's notification permission, stay stable.                                                                   |
| Notifier             | Runs in the page. Compares snapshots, shows browser notifications, and handles clicks.                                                                                                        |

### Access rules for actions

- Only `POST` with a JSON body. A missing or mismatched `Origin` or `Host`, or a missing session cookie, is rejected. Reads and page loads can't trigger an action, and the existing `frame-ancestors 'none'` stays (NFR-6).
- The session key must be a short `id` of 8 hex characters, or a `sessionId` UUID (NFR-7).
- Only one action runs per session at a time, and none retries automatically (NFR-10).

### Freshness and recheck (C-9)

- Stop, Delete, End, Force end, and Resume are blocked if the latest poll failed, or the last successful listing is more than 10 seconds old, which is two poll cycles plus a margin.
- Before running one of those, the server takes a fresh listing and rechecks that the session is still there with the same kind, state or status, process ID, and session ID. Open by short `id` skips this, because it's non-destructive.

### Program resolution (C-11)

- **`claude.exe`:** scan only absolute entries in `PATH`, using `lstat`. For an npm install, the `claude.cmd` folder contains `node_modules\@anthropic-ai\claude-code\bin\claude.exe`, and the tool launches that file directly, with no shell. A native install's `claude.exe` is used as found. If neither exists, Open, Stop, and Delete are unavailable, and the page says why.
- **`wt.exe`:** `%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe`, checked with `lstat`, because it's an app execution alias that `stat` can't read.
- **`cmd.exe` and `powershell.exe`:** their fixed paths under `%SystemRoot%\System32`.
- Node applies `NoDefaultCurrentDirectoryInExePath` from its own environment, so tests run the tool without it and plant a fake program in the session's folder.
- The iteration 1 poller still runs `claude` through a shell from the home folder. It moves to the resolved `claude.exe`, with no shell.

### Launching a terminal (FR-14)

- **Environment:** every `CLAUDE*` variable is removed, because a `claude` started with `CLAUDE_CODE_CHILD_SESSION` or `CLAUDECODE` set isn't listed.
- **Windows Terminal:** `wt.exe -w new -d . -- <claude.exe> attach <id>`, with the session's folder as the process's working directory, never in command text. `-w new` opens a new window rather than a tab in an existing one. `wt` splits on `;` even after `--`, which validated IDs can't contain.
- **Fallback console:** `cmd.exe /d /c start "" "<claude.exe>" attach <id>`, with the same working directory and environment.
- **Resume:** `claude.exe --resume <sessionId>` started in the session's original folder. A session resumed from another folder works in that other folder. Resume is offered only when the transcript exists, because a session ended before its first prompt has none, and only when the current listing doesn't show that session as live, because the CLI allows two resumes at once. If the original folder no longer exists, Resume is refused.
- **Result:** "terminal started". `wt.exe` exits 0 even when its arguments are wrong, and `claude attach` failures show in the new terminal, with exit code 1.
- **Repeated clicks:** a second Open for the same session is ignored for 10 seconds.

### Stop and Delete (FR-15, FR-16)

- **Stop:** `claude.exe stop <id>`, offered on every background state, because it's safe on each one.
- **Delete:** `claude.exe rm <id>`, never with `--discard-unpushed` or `--force-remove-worktree` (C-8).
- **Timeout:** 15 seconds for both.
- **Exit code:** `stop` exits 0 even when it changes nothing, so success comes from the next listing.

| Action | Exit code | Next listing                                             | Result                       |
| ------ | --------- | -------------------------------------------------------- | ---------------------------- |
| Stop   | Any       | State is `stopped`, `done`, or `failed`, with no process | Succeeded                    |
| Delete | 0         | Row gone                                                 | Succeeded                    |
| Delete | Non-zero  | Row still there                                          | Kept, with the FR-16 message |
| Either | Any       | Poll failed, or the command timed out                    | Unknown                      |

### Ending an interactive session (FR-17)

The helper runs as `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script> <arguments>`, with validated numeric arguments only. It frees its own console before attaching to the target's, and registers a handler so the break doesn't end the helper itself. Each run adds about 0.6 seconds.

**Ownership check, run before each signal:**

1. Take a fresh listing.
2. Open a handle to the process ID, and keep it open until the signal is sent.
3. Through that handle, require all of these:
   - The process image is `claude.exe` at the resolved path, or another `claude.exe`.
   - The process started no more than 5 seconds before the listing's `startedAt`, and no later than 1 second after it. Tests found it starts 0.9 to 1.4 seconds before.
   - The listing still shows the same `kind` and `sessionId` for that process ID.
4. If any check fails, refuse.

**Console members check:** a console event reaches every process on that console. The helper lists them, and refuses if any is neither the session, its ancestors, nor its descendants.

**Normal close:** Ctrl+Break to the session's console. In tests, it exited cleanly in 0.4 to 1.8 seconds, idle, busy, or at a permission prompt, and kept the transcript. A pending permission prompt wasn't approved. On npm installs, the terminal is left showing "Terminate batch job (Y/N)?", and the dialog says so. The tool waits 5 seconds, and if the session is still listed, it offers Force end.

**Force end:** the same ownership check, then the session and those of its descendants that started after it. Descendants are found from the process parent links, each checked by start time, because process IDs get reused. Each is ended through its own handle. The parent shell and terminal are left alone. The dialog says that programs the session started, such as dev servers, are also ended.

Tests found no case where Ctrl+Break failed to close the session, so the fallback to a Force-only End isn't needed.

### Self-protection (FR-22)

- At startup, the tool records `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`, and that process's start time. These are documented variables, and they survive the parent exiting.
- A row matching that session ID, or that process ID with the same start time, gets no Stop, Delete, or End, and the server refuses them.
- If `CLAUDECODE` or `CLAUDE_CODE_CHILD_SESSION` is set but no row matches, Stop, Delete, and End are blocked for every session, with a banner explaining why. Open still works.

### Single instance (U-15)

- At startup, the tool writes `instance.json` to its data folder, with its process ID and start time, port, and a random handover secret.
- A second start that finds a live instance asks it, using the secret, for a new one-time sign-in link, opens the browser on it, and exits.
- If the file is stale or the instance doesn't answer, the tool starts normally and replaces the file. The handover secret is no stronger than the store file, because any program running as the same user can read both.

### Notifications (FR-11 to FR-13, FR-21)

- The page compares each new snapshot with the last successful one. The first successful snapshot only sets the starting point, and the comparison carries across reconnects.

| Event               | Notifies when                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Needs you           | A session enters Needs you, or its specific reason changes. A fallback to the generic label doesn't count. |
| Finished            | A background session moves to `done` or `stopped`                                                          |
| Failed              | A session moves to `failed`. This doesn't also count as finished.                                          |
| Can't read sessions | A poll fails after the last one succeeded. Only once until polling recovers.                               |

- **Own actions:** for 30 seconds after the user's own Stop, Delete, or End on a session, that session's changes don't notify.
- **Content:** a session notification shows the project folder name and the reason. A read failure says only that. There's no icon, so the Content Security Policy is unchanged.
- **Tabs:** events in one snapshot are combined. Each notification has a tag built from its events, so other tabs replace it instead of adding another.
- **Click:** the click brings the tab up with `window.focus()`, as far as the browser allows, and highlights the rows that are still listed.
- **Permission:** notifications are turned on with a page button, which is the only place the browser's permission prompt can appear. Tests found notifications work from `http://127.0.0.1`, which counts as a secure context. Clicking a real notification hasn't been tested.

### Dashboard changes

- Each row has action buttons. Risky actions open a React Aria alert dialog that identifies the session (FR-19). Focus returns to the row afterward (NFR-8).
- Results appear in the existing announcement region and next to the row.
- Live interactive rows show their process ID (FR-20).

### Testing approach

- **Unit tests:** the planner, validation, the freshness rule, result rules, notification rules, self-protection, and program resolution, including hostile folder names.
- **Browser tests:** dialogs, keyboard use, and suppression after the user's own actions.
- **Windows tests:** the process helper, with throwaway processes. A planted-program test runs without `NoDefaultCurrentDirectoryInExePath`.
- **Live checks:** each action, the notification click by hand, and `claude rm` on a real worktree with uncommitted, untracked, and ignored files (U-10).

### Open items

- **U-10:** what `claude rm` keeps or removes in a Claude-created worktree hasn't been observed, so it moves to Testing.
- **Notification clicks:** `window.focus()` from a real notification click moves to Testing.
- **PowerShell:** it may be blocked by policy on some PCs. The helper then fails with a clear message, and End is unavailable.
