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

- **Status:** Draft, under review
- **Requirements:** FR-11 to FR-22, C-8 to C-11, NFR-6 to NFR-10 in [requirements.md](requirements.md)
- **Decisions:** [0014](decisions/0014-iteration-2-scope.md), [0015](decisions/0015-iteration-2-design.md)

### Evidence

An investigator agent tested on Windows 11 with Claude Code 2.1.319, installed through npm, on 2026-11-07. A reviewer then audited its logs.

- **Supported by the logs:**
  - Ctrl+Break closed the session in all 5 trials, in 0.4 to 1.8 seconds, and kept the transcript.
  - Two processes started 1.1 and 1.4 seconds before `startedAt`.
  - `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID` reach programs a session starts.
  - A planted program runs on an unqualified launch, and doesn't on an absolute one.
  - `wt` splits on `;` and expands `%VAR%`.
  - Browser notifications work from `http://127.0.0.1`.
  - Per the CLI code, `claude rm` has two different exit-1 cases.
- **Weakly supported:**
  - One permission-prompt trial, which suggests Ctrl+Break doesn't approve the prompt.
- **Not in the logs, and needing a check in Implementation or Testing:**
  - The leftover "Terminate batch job (Y/N)?" prompt, and whether the parent shell survives a break.
  - Which states `claude attach` opens, and resume folder behavior.
  - The `claude stop` exit codes.
  - Any trial of the PowerShell helper. Every Ctrl+Break trial used a compiled C# helper.
  - Notification delivery to a hidden tab, and a real notification click.

### New components

| Component            | Responsibility                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Program resolver     | Finds absolute paths for `claude.exe`, `wt.exe`, `cmd.exe`, and `powershell.exe` at startup, without searching any session's folder (C-11).                                             |
| Action route         | Accepts `POST /api/actions`, applies the access and action rules, and returns a result in the tool's own words.                                                                         |
| Action planner       | Builds a fixed command from the server's own data, never from page text (NFR-7).                                                                                                        |
| Action tracker       | Holds per-session action state on the server: the one-action lock, normal-close records for Force end, and own-action markers for notifications.                                        |
| Process helper       | A PowerShell script shipped with the tool. It checks that a process still belongs to a session while holding a handle, sends Ctrl+Break, or force-ends the session and its descendants. |
| Self-protection      | Keeps the set of sessions that started or handed over to the tool, and blocks Stop, Delete, and End on them (FR-22).                                                                    |
| Single-instance lock | Lets a second start hand over to the running instance, so the port and the browser's notification permission stay stable.                                                               |
| Notifier             | Runs in the page. Compares snapshots, shows browser notifications, and handles clicks. One tab notifies at a time.                                                                      |

### Access rules for actions (NFR-6, NFR-7)

- **Request format:** only `POST` with `Content-Type: application/json`, and a body holding exactly an action name and a session key. Unknown fields are rejected.
- **Rejected requests:** a missing or invalid session cookie, or a missing or mismatched `Origin` or `Host`. Reads and page loads can't trigger an action, and `frame-ancestors 'none'` stays.
- **Session key:** a short `id` of 8 hex characters, or a `sessionId` UUID.
- **One action at a time:** the action tracker allows one action per session, keyed by `sessionId` when known, and nothing retries automatically (NFR-10).

### Freshness and recheck (C-9)

- **Freshness:** Stop, Delete, End, Force end, and Resume are blocked if the latest poll failed, or the last successful listing is more than 10 seconds old.
- **Fresh listing:** before running one of them, the server takes a fresh listing, with a 10-second timeout.
- **Recheck for Stop, Delete, End, and Force end:** the session must still be listed with the same kind, process ID, and session ID, and its current state or status must still permit the action. An exact match on status isn't required, because a busy session changes status within seconds.
- **Recheck for Resume:** the session must still be absent from the listing. That shows it isn't live, which matters because the CLI allows two resumes of one session at once.
- **Open by short `id`:** skips freshness and recheck, because it's non-destructive.

### Program resolution (C-11)

- **`claude.exe`:**
  - Scan only absolute entries in `PATH`, using `lstat`.
  - For an npm install, the folder with `claude.cmd` contains `node_modules\@anthropic-ai\claude-code\bin\claude.exe`, which the tool launches directly, with no shell. A native install's `claude.exe` is used as found.
  - The resolved path must contain no `;`, `%`, or `"`, because `wt` treats those specially.
  - If resolution fails, monitoring falls back to the iteration 1 method, running `claude` through a shell from the home folder, with a banner saying the actions are unavailable. This covers other installers, such as pnpm, volta, or scoop.
- **`wt.exe`:** `%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe`, checked with `lstat`, because it's an app execution alias that `stat` can't read.
- **`cmd.exe` and `powershell.exe`:** under the System32 folder, which the tool gets from the operating system rather than the `SystemRoot` variable.
- **Poller:** it moves to the resolved `claude.exe` when one is found.
- **Tests:** Node applies `NoDefaultCurrentDirectoryInExePath` from its own environment, so tests run the tool without it and plant a fake program in the session's folder.

### Launching a terminal (FR-14)

- **Environment:** remove only the variables that mark a running session, so that a launched `claude` is listed: `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`, `CLAUDE_CODE_ENTRYPOINT`, every `CLAUDE_CODE_MESSAGING_*`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_JOB_DIR`, and `CLAUDE_CODE_EXECPATH`. User settings, such as `CLAUDE_CONFIG_DIR`, are kept. The poller removes the same set. The list needs reviewing when Claude Code changes.
- **Windows Terminal:** `wt.exe -w new -d . -- <claude.exe> attach <id>`, with the session's folder as the process's working directory, never in command text. `-w new` opens a new window rather than a tab.
- **Fallback console:** `cmd.exe /d /c start "" "<claude.exe>" attach <id>`, passed as one exact string with Node's verbatim-arguments option, with the same working directory and environment.
- **Resume:**
  - Runs `claude.exe --resume <sessionId>` in the session's original folder.
  - Offered only when the session's transcript exists, the original folder still exists, and the recheck passes.
- **Result:** "terminal started", because `wt.exe` exits 0 even when its arguments are wrong, and a `claude attach` failure shows in the new terminal.
- **Repeated clicks:** a second Open or Resume for the same session within 10 seconds is ignored, and the page says a terminal was just started.

### Stop and Delete (FR-15, FR-16)

- **Stop:** `claude.exe stop <id>`, offered on every background state.
- **Delete:** `claude.exe rm <id>`, never with `--discard-unpushed` or `--force-remove-worktree` (C-8).
- **Timing:** both have a 15-second timeout. Afterwards, the tool watches the listing for up to 15 seconds, because Stop takes effect asynchronously.

| Action | Exit code                 | Listing within 15 seconds                       | Result                                                 |
| ------ | ------------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| Stop   | Any                       | `stopped`, `done`, or `failed`, with no process | Succeeded                                              |
| Stop   | Any                       | Still `working` or `blocked`                    | Failed                                                 |
| Delete | 0                         | Row gone                                        | Succeeded                                              |
| Delete | Non-zero, "kept" message  | Row still there                                 | Kept, with the FR-16 message                           |
| Delete | Non-zero, other message   | Row still there                                 | Failed, try again later                                |
| Delete | 0                         | Row still there                                 | Unknown                                                |
| Delete | Non-zero                  | Row gone                                        | Succeeded, with a note that the CLI reported a problem |
| Any    | Timeout, or polls failing | Any                                             | Unknown                                                |

Telling the two non-zero Delete cases apart relies on the CLI's message, so a change in its wording only turns "Kept" into "Failed".

### Ending an interactive session (FR-17)

**Helper:**

- Runs as `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script> <arguments>`.
- The script lives in the tool's own folder, and runs with that folder as its working directory. Its arguments are numbers only.
- It frees its own console before attaching to the target's, and registers a handler so the break doesn't end the helper.
- It has a 10-second timeout.
- A Group Policy execution policy, or Constrained Language Mode, can block it, and End is then unavailable, with a message saying so.
- **Implementation step 1:** prove the helper, since no trial used it. If it doesn't work, the owner decides between the tested compiled helper and other options.

**Ownership check, run before each signal:**

1. Take a fresh listing.
2. Open a handle to the process ID, and keep it open until the signal is sent.
3. Through that handle, require all of these:
   - The image file name is `claude.exe`.
   - The process started no more than 5 seconds before the listing's `startedAt`, and no later than 1 second after it.
   - The listing still shows the same `kind` and `sessionId` for that process ID.
4. If any check fails, refuse.

Two trials support the start-time window. Testing must also cover slow starts and sessions with MCP servers, where a correct session could be refused.

**Console members check:** a console event reaches every process on the console. The helper lists them, and refuses if any is neither the session, its ancestors, nor its descendants. What a break does to a Git Bash or cmd parent shell needs testing.

**Normal close:**

- Ctrl+Break to the session's console.
- The action tracker records the session ID, process ID, process start time, and the time it was sent.
- The tool waits 5 seconds. If the session is still listed, the page offers Force end, so a `SessionEnd` hook that's still running could see Force end offered.

**Force end:**

- The server accepts it only for the same session ID, process ID, and start time as a normal close sent within the last 2 minutes (NFR-10).
- The helper repeats the ownership check, finds the session's descendants through process parent links, and checks each one's start time against its parent's.
- It opens every handle first, then ends the session and its descendants. The parent shell and terminal are left alone.
- The dialog says programs the session started, such as dev servers, are also ended.

**End results:**

| Outcome                                        | Result                                             |
| ---------------------------------------------- | -------------------------------------------------- |
| Ownership or console check failed              | Refused, with the reason                           |
| Session no longer listed within 5 seconds      | Succeeded                                          |
| Still listed after 5 seconds                   | Not closed, offering Force end                     |
| Force end, and session gone within 5 seconds   | Succeeded                                          |
| Helper failed, timed out, or blocked by policy | Failed, or unavailable for policy, with the reason |
| Polls failing                                  | Unknown                                            |

### Self-protection (FR-22)

- **At startup:** the tool records `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`, and that process's start time. These variables survive the parent exiting.
- **On handover:** a second start's matching values are sent with the handover and added to the protected set.
- **Protected rows:** a row matching a protected session ID, or a protected process ID with the same start time, gets no Stop, Delete, or End, and the server refuses them.
- **Unknown session:** if `CLAUDECODE` or `CLAUDE_CODE_CHILD_SESSION` is set but no row matches, Stop, Delete, and End are blocked for every session, with a banner explaining why. Open still works.

### Single instance (U-15)

- **Lock file:** at startup, the tool creates `instance.json` in its data folder, with exclusive creation so two starts can't both win. It holds the tool's process ID and start time, port, and a random handover secret.
- **Handover:** a second start sends `POST /api/handover` with the secret, and its own session values if any.
  - The route requires the correct `Host`, rejects any request with a browser `Origin`, and compares the secret in constant time.
  - It returns a one-time sign-in link that's valid for 60 seconds, which the second start opens before exiting.
  - It's an exception to NFR-2's single token, for the same user only.
- **Stale lock:** if the lock's process is gone or doesn't answer, the tool replaces the file and starts normally.
- **Exposure:** the secret is as exposed as the store file, because any program running as the same user can read both.

### Notifications (FR-11 to FR-13, FR-21)

- **Sequence numbers:** the server stamps each snapshot with a sequence number, and includes own-action markers: the sessions with an action from the dashboard in the last 30 seconds.
- **Comparison:** a tab compares each new snapshot with the last successful one. The first successful snapshot only sets the starting point, and the comparison carries across reconnects.
- **Leader tab:** only the tab holding a Web Locks API lock shows notifications. If that tab closes, another takes over.

| Event               | Notifies when                                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Needs you           | A session enters Needs you, including one that first appears already needing the user, or its specific reason changes. A fallback to the generic label, and Stale sessions, don't count. |
| Finished            | A background session moves to `done` or `stopped`                                                                                                                                        |
| Failed              | A session moves to `failed`. This doesn't also count as finished.                                                                                                                        |
| Can't read sessions | Three polls in a row fail after a success. Only once until polling recovers.                                                                                                             |

- **Own actions:** sessions in an own-action marker don't notify. This works across tabs, because the server sends the marker.
- **Content:** a session notification shows the project folder name and the reason. A read failure says only that. There's no icon, so the Content Security Policy is unchanged.
- **Combining:** events in one snapshot are combined. The notification tag includes the snapshot's sequence number, so a recurring event alerts again.
- **Permission:** the page has a button to turn notifications on, which is the only place the browser's prompt can appear. If permission is denied or unavailable, the button says so, and the page works as before. Turning notifications on doesn't send earlier events.
- **Click:** brings the tab up with `window.focus()`, as far as the browser allows, and highlights the rows still listed.

### Dashboard changes

- **Row buttons:** risky actions open a React Aria alert dialog, which identifies the session (FR-19).
  - Stop says work in progress is interrupted and the conversation is kept.
  - Delete says the session is removed and its work stops, and that a worktree Claude created is removed when that's safe.
  - End and Force end say work in progress can be lost, and Force end also says it ends programs the session started.
- **Focus:** returns to the row afterward, or to the group heading if the row has gone (NFR-8).
- **Results:** appear in the existing announcement region and next to the row.
- **Live interactive rows:** show their process ID (FR-20). A row with neither ID has no Open.

### Requirements coverage

| Requirements          | Covered by                                                  |
| --------------------- | ----------------------------------------------------------- |
| FR-11 to FR-13, FR-21 | Notifications                                               |
| FR-14, FR-20          | Program resolution, launching a terminal, dashboard changes |
| FR-15, FR-16, FR-18   | Stop and Delete, End results                                |
| FR-17                 | Ending an interactive session                               |
| FR-19                 | Dashboard changes                                           |
| FR-22                 | Self-protection, single instance                            |
| C-8, C-11             | Stop and Delete, program resolution                         |
| C-9                   | Freshness and recheck                                       |
| C-10                  | No hooks or prompts in any component                        |
| NFR-6, NFR-7          | Access rules for actions                                    |
| NFR-8                 | Dashboard changes                                           |
| NFR-9                 | Security review before release                              |
| NFR-10                | Action tracker, Force end, timeouts                         |

### Build plan

Each step is a separate pull request, approved by an independent agent before merge.

| Step | Pull request                                                                  | Covers                   |
| ---- | ----------------------------------------------------------------------------- | ------------------------ |
| 1    | Prove the PowerShell helper on throwaway sessions                             | FR-17                    |
| 2    | Program resolver and safe launch, with planted-program and hostile-name tests | C-11, NFR-7              |
| 3    | Action route, tracker, freshness, and recheck                                 | NFR-6, NFR-10, C-9       |
| 4    | Open and Resume                                                               | FR-14, FR-20             |
| 5    | Stop and Delete                                                               | FR-15, FR-16, FR-18, C-8 |
| 6    | End and Force end                                                             | FR-17                    |
| 7    | Self-protection and single instance                                           | FR-22                    |
| 8    | Notifications                                                                 | FR-11 to FR-13, FR-21    |
| 9    | Dashboard actions, dialogs, and accessibility                                 | FR-19, NFR-8             |

### Testing approach

- **Unit tests:** the planner, validation, the freshness rule, result rules, notification rules, self-protection, the handover, and program resolution, including hostile folder names.
- **Browser tests:** dialogs, keyboard use, suppression after the user's own actions, and the leader tab. Headless Chromium denies notification permission, so these tests mock `Notification`.
- **Windows tests:** the process helper with throwaway processes. CI may not support console events, so these may run as live checks instead. A planted-program test runs without `NoDefaultCurrentDirectoryInExePath`.
- **Live checks:**
  - Each action.
  - The leftover wrapper prompt, and a parent shell surviving.
  - Resume folders.
  - `claude stop` exit codes.
  - Start-time checks for slow starts.
  - A notification in a hidden tab, and a real notification click.
  - `claude rm` on a real worktree with uncommitted, untracked, and ignored files (U-10).
- **Security review:** of the action routes and handover, before release (NFR-9).
