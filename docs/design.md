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

An investigator agent tested on Windows 11 with Claude Code 2.1.319, installed through npm, on 2026-11-07, and a reviewer audited its logs. Two proof runs then tested the PowerShell helper itself, and another reviewer audited those.

- **Supported by the logs:**
  - With the fixed helper, Ctrl+Break closed the session in every trial, in 1.1 to 2.7 seconds, and kept the transcript. The helper reported and exited cleanly each time.
  - Three permission-prompt trials, with nothing pre-allowed in two of them, left the prompt unapproved.
  - Across 17 sessions, processes started 0.9 to 1.6 seconds before `startedAt`.
  - With npm's `claude.cmd`, the terminal shows "Terminate batch job (Y/N)?" afterwards, and a cmd or PowerShell parent shell survives.
  - Git Bash sessions are refused, and Force end leaves a Git Bash or cmd shell alive.
  - `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID` reach programs a session starts.
  - A planted program runs on an unqualified launch, and doesn't on an absolute one.
  - `wt` splits on `;` and expands `%VAR%`.
  - Browser notifications work from `http://127.0.0.1`.
  - Per the CLI code, `claude rm` has two different exit-1 cases.
- **Not in the logs, and needing a check in Implementation or Testing:**
  - Which states `claude attach` opens, and resume folder behavior.
  - The `claude stop` exit codes.
  - Notification delivery to a hidden tab, and a real notification click.
  - A session that exits during a Force end, which the helper now refuses rather than proceeding.

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
- **Rejected requests:** a missing or invalid session cookie, a missing or wrong page key, or a missing or mismatched `Origin` or `Host`. Reads and page loads can't trigger an action, and `frame-ancestors 'none'` stays.
- **Page key:** browsers send a cookie to every port on a host, so the cookie alone could reach another program listening on the PC, which could then send any header it likes. The security review found this (NFR-9), and the owner chose to fix it before release.
  - Sign-in redirects to `/#key=<key>`. Browsers never send the part after `#` to a server.
  - The page moves the key into its own storage, which is separate for each port, and removes it from the address.
  - Actions need the key in an `X-CCSM-Key` header. The WebSocket needs it as a subprotocol, `ccsm-key-<key>`, after a plain `ccsm` that the server echoes, so the key is never sent back. Without it, the connection is refused before it opens.
  - The server never returns the key to a request that only has the cookie. A page without the key says it isn't signed in.
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
- **`cmd.exe` and `powershell.exe`:** under the System32 folder. Node can't ask the operating system for that folder without starting another program, so the tool reads `SystemRoot` and requires an absolute path with no `;`, `%`, or `"`. Anyone who can change the tool's environment could already change `PATH`, so this adds no new trust.
- **Poller:** it moves to the resolved `claude.exe` when one is found.
- **Tests:** Node applies `NoDefaultCurrentDirectoryInExePath` from its own environment, so tests run the tool without it and plant a fake program in the session's folder.

### Launching a terminal (FR-14)

- **Environment:** remove only the variables that mark a running session, so that a launched `claude` is listed: `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`, `CLAUDE_CODE_ENTRYPOINT`, every `CLAUDE_CODE_MESSAGING_*`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_JOB_DIR`, and `CLAUDE_CODE_EXECPATH`, plus the list Claude Code 2.1.319 itself removes for child sessions: `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_HOST_WORKTREE`, `CLAUDE_CODE_HOST_WORKTREE_FENCE`, `CLAUDE_CODE_CHROME_MCP_ORG_DENIED`, `CLAUDE_CODE_EVAL_INTERVIEW_SESSION`, and every `CLAUDE_BG_*`. Names match whatever their capitalization. User settings, such as `CLAUDE_CONFIG_DIR`, are kept. The poller removes the same set. The list needs reviewing when Claude Code changes.
- **Windows Terminal:** `wt.exe -w new -d . -- <claude.exe> attach <id>`, with the session's folder as the process's working directory, never in command text. `-w new` opens a new window rather than a tab.
- **Fallback console:** `cmd.exe /d /v:off /c start "" "<claude.exe>" attach <id>`, passed as one exact string with Node's verbatim-arguments option, with the same working directory and environment.
- **Resume:**
  - Runs `claude.exe --resume <sessionId>` in the session's original folder.
  - Offered only when the session's transcript exists, the original folder still exists, and the recheck passes.
  - The server checks finished sessions' folders in the background, at most once per folder every 10 seconds, and lists the missing ones in each snapshot so the page leaves out Resume (BUG-31). A network folder isn't checked this way, because every check would connect to that server. The server still checks the folder when Resume is pressed.
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
- It has a 10-second timeout. A run takes about 0.7 seconds to refuse, and 1.1 to 1.4 seconds otherwise.
- A Group Policy execution policy, or Constrained Language Mode, can block it, and End is then unavailable, with a message saying so.

**Ownership check, run before each signal:**

1. Take a fresh listing.
2. Open a handle to the process ID, and keep it open until the signal is sent.
3. Through that handle, require all of these:
   - The image file name is `claude.exe`.
   - The process started no more than 5 seconds before the listing's `startedAt`, and no later than 1 second after it.
   - The listing still shows the same `kind` and `sessionId` for that process ID.
4. If any check fails, refuse.

Across 17 sessions, including one with a slow MCP server, processes started 0.9 to 1.6 seconds before `startedAt`, inside the window.

**Console members check:** a console event reaches every process on the console. The helper lists them, and refuses if any is neither the session, its ancestors, nor its descendants. Git Bash hides its shell from the process chain, so End is refused for sessions started from Git Bash, and the page says to use the session's own terminal. Force end still works there.

**Normal close:**

- Ctrl+Break to the session's console. With npm's `claude.cmd`, the terminal then shows "Terminate batch job (Y/N)?", and a hidden console leaves its idle wrapper and console host running. The dialog says so.
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
- **Unknown session:** if the start came from inside Claude Code, shown by `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, or either ID variable, but no row has matched yet, Stop, Delete, and End are blocked for every session, with a banner explaining why. Open still works. Once a protected session has been listed, it stays protected after it leaves the list, without blocking the others.
- **Matching by process ID:** a row's listed start time must be within 1 second before to 5 seconds after the process's start time. If either time is unknown, the row is protected anyway, because blocking a reused process ID is the safe mistake.

### Single instance (U-15)

- **Lock file:** at startup, the tool creates `instance.json` in its data folder, with exclusive creation so two starts can't both win. It holds the tool's process ID, port, and a random handover secret. It's removed on a normal shutdown, only if it's still this instance's.
- **Handover:** a second start sends `POST /api/handover` with its own session values, if any, and proves it knows the secret without sending it.
  - It sends a random nonce and an HMAC of it keyed with the secret. The running tool answers with its own HMAC of the nonce, and the second start trusts the link only if that matches. A program answering on a stale lock's port learns nothing and can't pass itself off as the tool.
  - The second start asks only if the lock's process is still running.
  - The route requires the correct `Host`, rejects any request with a browser `Origin`, compares the proof in constant time, and refuses a nonce it has already seen.
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
  - End also mentions the "Terminate batch job (Y/N)?" prompt with npm's `claude.cmd`, and that a Git Bash session is offered Force end instead.
  - One dialog serves the page, so a row moving between groups doesn't close it. Cancel has focus when it opens, so Enter alone never confirms.
  - Open and Resume run straight away, because they're non-destructive.
- **Which buttons:** match what the server allows. Background rows offer Open, Stop, and Delete. Live interactive rows with a process ID offer End. Finished interactive rows offer Resume, unless their folder is known to be gone. Force end appears only after End reports the session wasn't closed, for the 2 minutes the server accepts it.
- **Self-protection on the page:** snapshots list the protected sessions, so their rows leave out Stop, Delete, and End and say why. When actions are off for every session, the page shows the reason as a banner and leaves those buttons out. The server still refuses either way (NFR-10).
- **Focus:** returns to the button, or its row, afterward, or to the group heading if the row has gone (NFR-8). It's only moved when focus was lost, and never after the user has clicked elsewhere.
- **Results:** appear in the existing announcement region and next to the row. Once a row has gone, such as after Delete, the last result stays visible above the list. An answer the page can't read, or no answer, is shown as unknown.
- **Requests:** `fetch` to the page's own origin, so the Content Security Policy's `connect-src` includes `'self'` alongside the WebSocket.
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

## Iteration 3 design

- **Status:** Signed off on 2026-11-09, by agent review and merge
- **Requirements:** FR-23 to FR-31, C-12 to C-14, NFR-11 to NFR-13 in [requirements.md](requirements.md)
- **Decisions:** [0018](decisions/0018-iteration-3-plan.md), [0019](decisions/0019-iteration-3-requirements.md), [0020](decisions/0020-iteration-3-design.md)

### Evidence

**Transcripts (U-17, U-18), checked on 2026-11-09 by reading only usage, ID, and model fields:**

- Every assistant line with a `usage` object has `message.id`. One response is written on several lines, and in 15 main and 15 subagent transcripts (8,584 usage lines across all local transcripts) every repeat of an ID carried identical usage. Counting each `message.id` once counts each response once.
- Usage holds `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`, `server_tool_use`, `speed`, and `inference_geo`. All local responses so far are `standard` speed and `global` routing.
- Subagent transcripts are `<session ID>/subagents/agent-*.jsonl`, with a `.meta.json` beside each. Their lines have `isSidechain: true`, and none of their response IDs appear in the main transcript, so adding them doesn't double count.
- `<synthetic>` appears as a model on a few entries Claude Code writes itself.
- All local transcripts together are about 104 MB. The largest single transcript is 24 MB.

**Leftover programs (U-16), from a live experiment on throwaway sessions:**

- One shared `claude.exe daemon run` runs per user. Under it, each background session has its own `--bg-pty-host` process, whose child is the session process, `claude.exe --session-id <ID>`. The listing's `pid` is that session process. A stopped session has no `pid`.
- Each Bash tool command runs as `bash.exe` under `bash.exe`, with its own hidden console. Programs started through Git Bash, such as `sleep.exe`, have a parent process ID that already points to an exited process while the session is still running, because Git Bash starts programs by fork then exec. Native programs keep their parent link.
- Job objects don't contain the session's programs, which is why they outlive it.
- After `claude stop`, the bash wrappers and their programs survive. What survives `claude rm`, or End, varies between runs: in the first experiment only programs started through Git Bash survived, with no parent, no console, and no Claude variables, and their working folder was the session's folder. In step 5's proofs, with Claude Code 2.1.321, one run kept everything (the bash wrappers, `sleep`, and a native `ping`) and another kept a single program. The tracker doesn't depend on which: it checks every recorded entry.
- The only reliable link from a surviving program to its session is a record taken before the action, matched by process ID and creation time. That match held live.
- Taking the record took about 0.85 seconds, almost all in one process query.
- The experiment's agent used a folder path left trusted by an earlier proof, because `claude --bg` refuses untrusted folders and agents don't accept trust prompts. Force end wasn't re-run live; the expected result is the same as End.

**Prices:** Anthropic's [pricing page](https://platform.claude.com/docs/en/about-claude/pricing), read on 2026-11-09.

### New components

| Component         | Responsibility                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Transcript reader | Replaces the metadata reader. Reads each transcript from where it last stopped, and keeps the branch, model, last activity, and usage. |
| Price table       | A dated table of API list prices in the tool, and the cost rules.                                                                      |
| Leftover tracker  | Holds, in memory, the programs recorded before each action, checks which still run, and keeps Deleted rows.                            |
| Process helper    | Gains `record`, `check`, and `end-leftovers` modes alongside its End and Force end modes.                                              |

### Transcript reader (FR-23, FR-26, NFR-11)

- **Incremental reading:** for each transcript, the reader keeps the byte offset it has read to, any unfinished last line as raw bytes (so a multi-byte character split across reads is decoded whole), and the file's size, modified time, and the first 64 bytes. On each poll it reads only new bytes. If the file is smaller than the offset, or its first 64 bytes changed, it starts again from the beginning. NTFS can keep a creation time when a file is replaced, so that isn't used.
- **Budget per poll:** the reader reads at most 8 MB in total per poll across all transcripts, newest sessions first, so a large backlog never delays session updates (FR-9) or the CPU budget (NFR-11). Until a transcript is fully read, its usage shows as "counting", and totals say so. It also stops after 500 ms per poll, on a monotonic clock, reading in 256 KB pieces, so a slow disk or a large first read can't push a poll past FR-9's 5 seconds (BUG-33). 50 MB of transcripts takes at least 7 polls, or 21 seconds, after a start, and more if the time limit is reached first.
- **Cheap filtering:** only lines containing `"usage"` are parsed in full. For metadata, the reader parses just the last complete line in each new chunk that contains `"timestamp"`, and keeps its `timestamp` and `gitBranch`. Measured locally, lines with `"usage"` are 2 to 33% of a transcript's bytes. An allow-list copies only `message.id`, `message.model`, the usage numbers, `speed`, `inference_geo`, `timestamp`, and `gitBranch` (C-4, C-12).
- **Counting once:** each transcript keeps a map from response ID to the usage on its latest line, so a later line for the same ID replaces the earlier one rather than adding to it. The map is in memory only, and isn't saved (C-12). It's dropped 30 seconds after the session finishes and its usage is saved. After a restart, the store's saved usage stands for finished sessions, and live sessions are re-read from the start.
- **Subagents:** the reader lists `<session ID>/subagents/agent-*.jsonl` when that folder's modified time changes, and reads each file the same way. Their usage is kept apart, as "subagents".
- **Grouping:** usage is summed per group of model, speed, routing, and main or subagent. For Claude Haiku 5.5, each response is also marked as over 100,000 prompt tokens (input plus cache reads plus cache writes, strictly more than 100,000) or not, because the price differs.
- **Metadata:** the same pass keeps the latest branch, model, and timestamp, so the 256 KB tail read goes away. This also removes BUG-24's large-line case.
- **Left out:** entries whose model is `<synthetic>`.
- **CPU:** filtering by substring before parsing keeps steady-state cost to the new bytes only. Testing measures it against U-5 (NFR-11).

### Estimated cost (FR-24, FR-25)

- **Price table:** `src/shared/prices.ts`, dated 2026-11-09, with the source URL. One row per model ID, with input, output, 5-minute cache write, 1-hour cache write, and cache read prices per million tokens, from the pricing page:

| Model                         | Input | 5m write | 1h write | Read | Output |
| ----------------------------- | ----- | -------- | -------- | ---- | ------ |
| Fable 5.1, Mythos 5.1         | 10    | 12.50    | 20       | 0.25 | 50     |
| Fable 5, Mythos 5             | 10    | 12.50    | 20       | 1    | 50     |
| Opus 5.5                      | 4     | 5        | 8        | 0.20 | 20     |
| Opus 5, 4.8, 4.7, 4.6, 4.5    | 5     | 6.25     | 10       | 0.50 | 25     |
| Opus 4.1, 4                   | 15    | 18.75    | 30       | 1.50 | 75     |
| Sonnet 5.5                    | 2     | 2.50     | 4        | 0.10 | 10     |
| Sonnet 5                      | 2     | 2.50     | 4        | 0.20 | 10     |
| Sonnet 4.6, 4.5, 4            | 3     | 3.75     | 6        | 0.30 | 15     |
| Haiku 5.5, prompts up to 100K | 0.10  | 0.125    | 0.20     | 0.01 | 0.50   |
| Haiku 5.5, prompts over 100K  | 0.50  | 0.625    | 1        | 0.05 | 2.50   |
| Haiku 4.5                     | 1     | 1.25     | 2        | 0.10 | 5      |

- **Matching:** a model ID matches a row exactly, or with a trailing date such as `-20250929`. Anything else is unknown, and its cost is unavailable (FR-24).
- **Fast mode:** responses with `speed: "fast"` use the fast input and output prices (Opus 5.5: 8 and 40; Opus 5 and 4.8: 10 and 50). Cache prices use that model's own multipliers on the fast input price: 1.25 times for 5-minute writes, 2 times for 1-hour writes, and the model's read multiplier, so an Opus 5.5 fast cache read is $0.40. Fast mode on a model with no fast price makes that group's cost unavailable.
- **US-only routing:** responses with `inference_geo: "us"` cost 1.1 times as much, for Claude 4.6 and later models only, as the pricing page says.
- **Web search:** `server_tool_use.web_search_requests` costs $10 per 1,000 searches. Other server tools aren't priced, and the label says the estimate covers tokens and web searches.
- **Labels:** "Estimated cost at API list prices of 9 November 2026. Not what a Pro or Max plan costs." A session with an unknown model shows its tokens and "Cost unavailable for <model>".
- **Totals (FR-25):** a summary bar under the page heading shows the totals of each token type and the estimated cost for the listed sessions. The rules:
  - Tokens are always added up, including for models with no price.
  - The cost total adds up every group with a price. A session with any group whose cost is unavailable counts as left out: "Estimated cost $X, leaving out N sessions".
  - A session still being counted adds what's been read so far, and the bar says "still counting".
  - A session with no readable transcript, or a finished session saved by 0.1.0 with no usage, has no usage. It's counted as left out of both tokens and cost: "N sessions have no usage".
  - Deleted rows show only the leftover offer, and aren't counted.
- **Where the cost is worked out:** on the server, which sends each session's usage groups and its estimate in the snapshot. The page only adds them up.

### Saved usage (FR-26)

- A finished session's usage groups are saved in its store record: per group, the model ID, speed, routing, main or subagent, the Haiku threshold side, and the counts. No names, response IDs, or text (C-7, C-12).
- They're saved when the session finishes, and saved again whenever its usage changes during the 30 seconds it's still read (BUG-27). A session that finishes while still counting keeps being read until it's fully counted, and is saved then. Until that point, its record is marked as incomplete, and its row says "still counting".
- The cost is worked out again from the table when shown, so a later price table applies to saved sessions too.
- **Compatibility:** the store file's `version` stays 1, and the usage field is optional, so this version reads 0.1.0 files. The store validates records with its own `recordSchema`, so 0.1.0 drops the usage field when it next rewrites the file. Going back to 0.1.0 therefore loses saved usage, and the release notes say so. A test confirms 0.1.0's schema still accepts a record with usage.

### Leftover programs (FR-27, C-14, NFR-13)

**Recording, before each action:**

- Before Stop, Delete, End, and Force end, the server runs the helper's `record` mode for the session's process, after the same ownership check End uses (process ID, image, start time against `startedAt`, and the listing's session ID).
- For End and Force end, the record is taken in the same helper run as the ownership check, before the signal, with its own 4-second budget inside the helper's 10 seconds. If the record runs out of time, the helper drops it and still sends the signal, so a slow record never makes End fail.
- A stopped background session has no process, so Delete records nothing new. A record from the tool's own Stop on that session, if it's still held, carries over to the Delete, so the Deleted row still appears.
- The record lists:
  - descendants found through parent links, each started after its parent, and
  - members of each console owned by one of those descendants, if they started after the session did. The session's own console is never used, because it can include the user's shell and terminal.
- It never includes the tool's own processes (the tool's Node process, its descendants, the helper, and the tool's chain of parent processes, worked out by the helper on each run), the shared daemon, any `--bg-pty-host` process, or any `claude.exe` process.
- Each entry keeps the process ID, creation time, image path, and name. No other process's environment or command line is read (0020).
- **If recording fails or takes over 10 seconds**, the action goes ahead, and its result says leftover programs can't be checked for this session (0020).

**Only once the session has gone:**

- The record also holds the session's own process ID and creation time. Programs count as leftovers only once that process has exited.
- If the action fails, is kept, is not closed, is unknown, or times out, and the session's process still runs, there's no offer, and the record waits. If the session process later exits within 10 minutes, for example after a Force end, its programs become leftovers then. Otherwise the record is dropped.
- The server refuses `endLeftovers` while the session's recorded process still runs, or while the listing shows the session with a process ID (NFR-10). The dialog isn't the protection.

**Checking:**

- After the action, the tracker keeps the record in memory, under the session's key, with the action and time. Records aren't saved, so they're gone after a restart.
- The helper's `check` mode reports which recorded entries still run with the same process ID and creation time. While bash wrappers survive (after Stop), it also adds programs whose parent is a recorded, still-running entry and that started after it.
- **Cost:** one `check` run covers every held record. It checks liveness through process handles and start times (`Get-Process`), with no C# compile and no CIM query. The CIM query runs only while a recorded bash wrapper still runs, to find its new children. Checks run 5 seconds after the action, then back off: every 10 seconds for the first minute, then every 30 seconds, then every 60 seconds after 10 minutes. Each run has a 10-second timeout. Testing measures the CPU of a check run.
- When no entry runs, the record is dropped.
- **The row:** shows "Programs still running" with each program's name and process ID, up to 10 and then "and N more", and an "End leftover programs" button. For a deleted session, the row stays at the top of Finished, marked Deleted, showing only this (0020). It goes when no entry runs, or after a restart. Deleted rows send no notifications and aren't counted in totals.

**Ending:**

- The page sends `{ action: "endLeftovers", key }`, naming only the session (NFR-13). The server takes the program list from its own record.
- The server refuses it:
  - for a protected session (FR-22)
  - while the latest poll has failed or its listing is over 10 seconds old (C-9)
  - when there's no record for that key
  - while the session's own process still runs, as above
  - while another action runs on that session (NFR-10)
- **Recheck (C-9):** the server takes a fresh listing first. A listed session must still match the record's session ID and have no process ID. A Deleted row, or any finished row after the tool's own End or Force end, isn't listed by Claude Code. For any finished row that holds a record, the record from the tool's own action, the session's absence from the fresh listing, and the per-process check below stand in for the listing.
- The dialog lists the programs and says unsaved work in them is lost. Programs found after the dialog opened, by the wrappers that still run, are ended too, and the dialog says the list may grow.
- The helper's `end-leftovers` mode reads the entries (process ID, creation time, image path) as JSON on its standard input, not as arguments, and has a 10-second timeout. For each entry it opens a handle, requires the same creation time and image path through it, and ends the process through that same handle (C-14). It never ends a process tree. Entries that fail the check are skipped.
- **Result:** "Ended N of M programs", with any skipped or failed ones named. Nothing retries automatically.

**Limits, in the release notes:** programs started outside the session's process tree and consoles, or in the second between recording and the action, or later by a program whose wrapper has gone, aren't found. Nothing is offered for a session stopped, deleted, or ended outside the dashboard, or while the tool is off.

### Other changes

| Bug or requirement | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Expected result, tested                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| BUG-6, FR-28       | Active is sorted by start time, newest first, then by session ID. The first start time seen is kept (BUG-23).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Activity changes don't reorder Active.                                                                                  |
| BUG-8, FR-29       | A printed sign-in link's token gets an expiry 2 minutes after it's printed, measured on a monotonic clock. The terminal says "This link works once, for 2 minutes. Restart cc-session-manager for a new one." The handover link keeps its 60 seconds, and its printed message says 60 seconds.                                                                                                                                                                                                                                                                                                                    | The token is refused after 2 minutes, and after one use. The handover message says 60 seconds.                          |
| BUG-9              | Snapshots are only sent when something changes, so the server also sends a small heartbeat after every poll, with the time of the last successful poll. It's a separate message type: it doesn't change the snapshot's sequence number, and notifications ignore it. A timer on the page shows, when the last success is over 10 seconds old, "Last updated N seconds ago. Claude Code is slow to respond, so actions on sessions are paused." (0020; the owner chose this wording in step 8, since Force end and End leftover programs are paused too. The buttons stay pressable, and the server refuses them.) | The line appears after 10 seconds without a successful poll, never on a quiet dashboard, and goes when a poll succeeds. |
| BUG-10             | Decorative triangles and dots are hidden from screen readers. Each row's accessible text separates name, status, and reason with punctuation, such as "Fix login bug. Needs you: permission to run Bash."                                                                                                                                                                                                                                                                                                                                                                                                         | Accessible names in browser tests. NVDA testing was dropped (0021).                                                     |
| BUG-11             | When a focused expandable section disappears, focus moves to its group's heading, or to the main heading if the group has gone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Focus never falls to the page body in that case.                                                                        |
| BUG-12, FR-30      | A store that parses as JSON but fails the schema has every `name` and `title` field removed, and is saved as `finished-sessions.corrupt.json`, replacing an earlier copy. A file that doesn't parse is deleted, and the log says so without its contents. A file that can't be read, for example because it's locked, is left alone and never deleted. At startup, older `finished-sessions.corrupt-<time>.json` files left by 0.1.0 are scrubbed the same way: the newest becomes `finished-sessions.corrupt.json` and the rest are deleted.                                                                     | Both cases, with names in the input; a locked file kept; 0.1.0 copies reduced to one scrubbed copy.                     |
| BUG-13             | A session's last known activity time is kept in memory. If its transcript becomes unreadable, the last known time is used, so a Stale session stays Stale.                                                                                                                                                                                                                                                                                                                                                                                                                                                        | No announcement or move to Needs you when a stale session's transcript disappears.                                      |
| BUG-14             | Announcements for a session with no ID and no name are keyed by folder, kind, and start time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Two such sessions are both announced.                                                                                   |
| BUG-16             | Announcements are queued, and each stays in the live region for at least 1 second before the next replaces it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Two updates 50 ms apart are both announced.                                                                             |
| BUG-17             | Before the first successful poll, a failed poll shows "Can't read sessions yet" and the reason, instead of "showing last known data" and "No sessions to show".                                                                                                                                                                                                                                                                                                                                                                                                                                                   | The empty state never contradicts the banner.                                                                           |
| BUG-18             | An interactive session first seen less than 10 seconds ago, with no status, shows "starting", lowercase like Claude Code's other statuses (0020).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | "starting", not "unknown", on that refresh.                                                                             |
| BUG-19, BUG-20     | The missing-status excuse is keyed by process ID and start time, not session ID, and applies only to a session whose start time is within 10 seconds of when the tool first saw it.                                                                                                                                                                                                                                                                                                                                                                                                                               | Existing sessions at the tool's start, and a session that gains an ID, warn as they should.                             |
| BUG-23             | The start-time shift is fixed by keeping the first start time seen. `claude -p` runs listed as interactive are Claude Code's behaviour, and stay documented (0020).                                                                                                                                                                                                                                                                                                                                                                                                                                               | Start time doesn't change once a process ID appears.                                                                    |
| BUG-24             | Full reading removes the large-line case. A warning needs 20 complete lines in a row with no usable entry. A line counts as having no usable entry if it doesn't start with `{` and end with `}`, or if it's parsed and isn't a known shape; lines skipped by the filter aren't counted either way.                                                                                                                                                                                                                                                                                                               | No warning for a large `api-request-blob` line, or a header-only new file.                                              |
| BUG-26             | A warning is raised when 20 or more complete lines in a row yield no object (judged as for BUG-24, by `{` and `}` without parsing), or when lines have timestamps but no assistant line has a `message` object.                                                                                                                                                                                                                                                                                                                                                                                                   | Both cases warn.                                                                                                        |
| BUG-27             | A finished session's transcript is read for 30 seconds after it finishes, so late lines update its Finished row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | A short run's Finished row shows its model.                                                                             |
| BUG-29             | A guard test: the tool's output pipe closes when the tool exits after an Open. BUG-29 stays open as not reproduced unless the test fails (0020).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | The pipe closes.                                                                                                        |

### Screen-reader testing (NFR-12, U-19)

Dropped by decision 0021. Kept here as it was designed.

- **Setup:** a portable copy of NVDA, made from the NVDA installer with its portable-copy option into a scratch folder, with no install (0020). The owner approves the download when Testing starts.
- **Speech output:** NVDA's log level set to input/output, which logs speech. The speech synthesizer is set to silence where possible. Keystrokes are logged too, so the test runs while the owner isn't typing, and the log and folder are deleted afterwards.
- **Driving:** the agent sends keyboard input to the dashboard in a test browser window, and reads what NVDA spoke from the log.
- **Fallback:** if the log doesn't show speech, the agent tries NVDA's Speech Viewer. If neither works, the gap goes back to the owner with options (NFR-12).
- **Scripts:** the session list and groups, a new Needs you announcement, the notification button, each action and its dialog, results, the usage details, the summary bar, and the leftover-programs offer.

### Requirements coverage

| Requirements         | Covered by                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| FR-23, FR-26         | Transcript reader, saved usage                                                                                           |
| FR-24, FR-25         | Estimated cost                                                                                                           |
| FR-27, FR-2          | Leftover programs, the Deleted row                                                                                       |
| FR-28 to FR-31       | Other changes                                                                                                            |
| C-12                 | Transcript reader allow-list                                                                                             |
| C-13                 | No hooks or prompts in any component                                                                                     |
| C-14, NFR-13         | Leftover programs                                                                                                        |
| NFR-6, NFR-7, NFR-10 | The `endLeftovers` action: same route and origin checks, the page names only a session, one action per session, timeouts |
| NFR-11               | Transcript reader                                                                                                        |
| NFR-12               | Screen-reader testing, dropped by decision 0021                                                                          |
| NFR-9                | Security review of the new action and the helper modes                                                                   |

### Build plan

Each step is a separate pull request, approved by an independent agent before merge.

| Step | Pull request                                                                                      | Covers                                                |
| ---- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1    | Transcript reader: incremental reading, allow-list, counting once, subagents, metadata            | FR-23, C-12, NFR-11, BUG-24, BUG-26                   |
| 2    | Price table and cost rules                                                                        | FR-24                                                 |
| 3    | Usage in the snapshot, details, and summary bar                                                   | FR-23 to FR-25                                        |
| 4    | Saved usage in the store, reading finished sessions for 30 seconds, and scrubbing a corrupt store | FR-26, FR-30, BUG-27                                  |
| 5    | Helper `record`, `check`, and `end-leftovers` modes, proven on throwaway sessions                 | FR-27, C-14                                           |
| 6    | Leftover tracker, the action, the Deleted row, and the dialog                                     | FR-27, NFR-13                                         |
| 7    | Session-rule bugs                                                                                 | BUG-6, BUG-13, BUG-14, BUG-18, BUG-19, BUG-20, BUG-23 |
| 8    | Page bugs                                                                                         | BUG-9, BUG-10, BUG-11, BUG-16, BUG-17                 |
| 9    | Printed link expiry and the BUG-29 guard test                                                     | FR-29, BUG-29                                         |

### Testing approach

- **Unit tests:** the reader's offsets, restarts, truncation, and counting once; the allow-list, with message text in the input; the cost rules for every price row, fast mode, US routing, the Haiku threshold, and unknown models; the store with usage; and each bug's expected result above.
- **Browser tests:** the usage details, the summary bar, the Deleted row, the leftover dialog, focus, the stale-data line, and accessible names.
- **Live checks:**
  - Usage figures for a real session, compared with its transcript.
  - CPU per poll against U-5 (NFR-11), and the first read of 50 MB of transcripts.
  - Leftover programs after Stop, Delete, End, and Force end on throwaway sessions, and no offer while a failed action leaves the session running.
  - The ownership check's start-time window for background sessions, which was measured only on interactive ones.
  - CPU of a `check` run.
  - L10, with the owner accepting the trust prompt, skipped by decision 0022.
  - NVDA testing (NFR-12), dropped by decision 0021.
- **Security review:** the new action, the helper modes, and the printed link, before release (NFR-9).

## Iteration 4 design

Requirements: the Iteration 4 section of [requirements.md](requirements.md). Decisions: [0023](decisions/0023-iteration-4-plan.md), [0024](decisions/0024-iteration-4-requirements.md), [0025](decisions/0025-iteration-4-design.md), and [0026](decisions/0026-iteration-4-page.md).

### Evidence

From experiments on throwaway sessions with Claude Code 2.1.325 on 2026-11-13, run through Node's `execFile` with no shell. Other transcripts were measured by timings, counts, and field names only.

- **Background start (U-20):**
  - **Success:** `claude --bg` exits 0 and prints `backgrounded · <short ID>` first, adding ` · <name>` when it has one. It took 5.9 s cold and 3.6 to 4.1 s warm. The session was listed on the next `claude agents` call.
  - **Refusal:** exits 1 with one line on standard error. An untrusted folder gives "Workspace not trusted. Run `claude` in <path> once and accept the trust prompt, then retry.", read from the binary, not seen live.
  - **Late failure:** some failures exit 0 and show only as `state: "failed"` 2 to 3 seconds later, with no reason in the listing. Examples are a bad option and an unknown resume ID.
- **Fork (U-21):** `--resume <ID> --fork-session` worked on idle, working, stopped, and running interactive sessions. Each got a new session ID, and the original's transcript stayed byte for byte the same. A fork copies the original's name unless `-n` is given, and copies its lines with their original timestamps.
- **Message text (U-22):** text comes from two kinds of line:
  - A prompt is a `user` line with `origin.kind: "human"` or `promptSource: "sdk"`.
  - A reply is an `assistant` line's `text` blocks.

  Everything else is left out by not being allowed: thinking, tool use and results, `isMeta`, compaction summaries, task notifications, command lines, interrupts, and `system`, `attachment`, and `api-request-blob` lines. Synthetic replies, which are `assistant` lines, are excluded explicitly (see Search). Scanning all 80 local transcripts, 147 MB, took 1.3 s wall and 1.5 s CPU with the file cache warm.

- **History fields (U-23):** every transcript has `cwd`, timestamps, `gitBranch`, and `sessionId`, which matches the file name, within its first 64 KB and last 256 KB. A fork's first timestamps are the original's.
- **Arguments (U-24):**
  - **`--`:** works before the prompt in every mode.
  - **`execFile` without a shell:** passes any prompt or name unchanged.
  - **Windows Terminal:** splits on `;`, mishandles quotes and tabs, and expands `%NAME%` with no way to escape it.
  - **The current console fallback, `cmd /c start`:** cuts line breaks, loses quotes, and expands `%NAME%`.
  - **`conhost.exe` through `execFile`:** passed every probe except `%NAME%`, but step 1 found it exits at once through a detached launch, so it isn't used.

### New components

| Component        | Responsibility                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Launch arguments | Builds `claude` argument lists for Start and Fork, with every option before `--`, and the Windows Terminal escaping for an interactive name.     |
| Start and Fork   | Two new actions on the existing route, with their own validation, the one-Start lock, and the 10-second watch for a late failure.                |
| History index    | Lists main transcripts on disk, and reads each one's folder, branch, model, times, and usage through the reader's allow-list.                    |
| Search           | Scans prompts and replies on demand in the server's own thread, returns matches and snippets, and keeps nothing.                                 |
| Folder picker    | Lists folders under a chosen local folder, through the server, for the New session form.                                                         |
| Folder checks    | Decides whether a folder is local: refuses network shares, device paths, and mapped, `subst`, or linked folders that lead to a network location. |
| Action routes    | One request schema per action, and a larger body limit for Start and Fork.                                                                       |

### Start (FR-32, C-15, NFR-14)

- **Request:** `{ action: "start", folder, kind, name?, prompt? }`. The server checks these against NFR-14:
  - **Folder:** an existing local absolute path, by the folder checks below. Network shares, device paths (`\\?\`, `\\.\`), and relative paths are refused.
  - **Name:** at most 100 characters, with no control characters and no `%` (0025).
  - **Prompt:** required for a background start. At most 8,000 characters. Line breaks and tabs are allowed; other control characters are refused.
- **Background:**
  - **Command:** `execFile(claude, ["--bg", "--name=<name>", "--", prompt], { cwd: folder })`, with no shell and `sessionLaunchEnv`. The name goes in the same argument as its option, so it can't be read as another option however it looks (security review of iteration 4, I-3). It's left out when there's no name. The timeout is 30 s.
  - **Started:** exit 0 and a first line of `backgrounded · <ID>`.
  - **Refused:** a non-zero exit. The tool shows its own words only (FR-18, 0025). Known reasons map to messages: an untrusted folder ("Claude Code doesn't trust this folder yet. Run `claude` there once and accept its prompt."), a folder that's gone, Claude Code not signed in, and its background service being out of date. Anything else is "Claude Code refused to start the session." Claude Code's own text is never shown, logged, or kept.
  - **Unknown:** a timeout, or exit 0 without a `backgrounded · <ID>` line, is reported as unknown (FR-18), and the page says to check the list.
  - **After it starts:** the tool watches the listing for 10 seconds, and the response waits for it, so a background Start or Fork answers in up to about 15 seconds; the button says "Starting…" meanwhile. If the new ID shows `failed`, the result is "Claude Code started the session, but it failed straight away" (0025). The job file that would give the reason isn't read.
- **Interactive:** launched the way Open is, with the new argument builder:
  - **With Windows Terminal:** `wt -w new -d . -- claude -n <name> --`, with the folder given only as the process's working folder, as Open does today, so the folder is never in command text (NFR-7). The name is escaped for Windows Terminal: MSVCRT quoting, trailing backslashes doubled when it has a space, then `;` becomes `\;`.
  - **Without it:** `cmd /c start`, as Open has used since iteration 2, for arguments that are only options, session IDs, and `--`. A name is refused there, because `cmd` would change it (0025). `conhost.exe` was tried in step 1 and dropped: it only runs while its parent keeps live pipes to it, which the dashboard's detached launch doesn't.
  - **Result:** success means the terminal launched (FR-18), because Claude Code may first show its own trust prompt.
- **One at a time:** one Start runs at a time across the tool, under its own lock key, held until the 10-second watch ends. The button is disabled until the result arrives, and nothing is retried.
- **Not kept:** the prompt and name aren't logged, stored, or kept after the action (C-18). The result names the folder and kind, not the prompt.

### Fork (FR-33)

- **Request:** `{ action: "fork", key, kind, name?, prompt? }`. The key is a session ID from the main list or History. The server finds the session's folder and ID in its own data, and refuses a key it doesn't know.
- **Before forking:** the folder must pass the same folder checks as Start, and the original's main transcript must be on disk. That avoids the unknown-ID case that kept restarting. Fork is hidden when the folder has gone, using the folder watch Resume uses, and refused if pressed anyway (FR-33).
- **Command:** `claude --resume <ID> --fork-session [--bg] [-n name] -- [prompt]`, with the same launch, validation, results, and 10-second watch as Start. `--fork-session` is always present, and a test checks it.
- **Locking:** one Fork per session at a time, locked on the session ID, so it holds whether Fork was pressed in the main list or History (NFR-10). FR-22's protection isn't checked, by decision 0024.
- **History rows:** a History session that isn't listed needs no freshness check (C-9), because nothing about it is changed. A listed session uses the listing as today.

### Folder checks (FR-32, FR-33, NFR-14)

- **Path form:** an absolute path on a drive letter. `\\server\share`, `\\?\`, `\\.\`, and relative paths are refused.
- **Drive type:** the drive letter's type is read through the PowerShell program the tool already uses, as `[System.IO.DriveInfo]::new('<letter>').DriveType`, with the letter checked to be A to Z first and passed as the only argument. A `Network` drive, which is how mapped drives appear, is refused, and so is any folder whose check fails or times out.
- **`subst` and links:** the path is resolved with `fs.realpath.native` first, because the plain JavaScript version doesn't resolve `subst` drives, which follows `subst` drives, junctions, and symbolic links. The resolved path is checked again, by form and drive type, and must still exist. Refused if any step fails (0025).
- These checks also apply to the folder picker, to a Fork's folder, and to Resume from History.

### Action routes (NFR-6, NFR-14)

- **Schemas:** the action route's single strict schema becomes one strict schema per action, chosen by `action`: the existing ones keep `{ action, key }`, `start` takes `{ action, folder, kind, name?, prompt? }`, and `fork` takes `{ action, key, kind, name?, prompt? }`, and `listFolders` takes `{ action, folder? }`. Unknown fields are refused as today.
- **Body limit:** 32 KB for `start` and `fork`, which fits an 8,000-character prompt, and the current 4 KB for the others, including `listFolders`.
- **Same guards:** all of them need the dashboard's origin, the page key, and JSON, as NFR-6 says today.

### Resume from History (FR-35, FR-14, C-9)

- Resume on a History row that Claude Code no longer lists isn't refused for being unlisted. The server finds the session in the History index by session ID, checks its folder with the folder checks, and takes a fresh listing first (C-9). If Claude Code lists the session again, Resume from History is refused, and the page offers it from the session list instead. It runs in the folder the session recorded, after that folder's resolved path passes the checks.
- It then runs today's Resume launch (`claude --resume <ID>`) in the session's folder, with its result rules (FR-14, FR-18).
- A listed session's Resume is unchanged.

### History (FR-35, NFR-15)

- **Finding transcripts:** `~/.claude/projects/*/<session ID>.jsonl` main transcripts, found with directory listings, newest modified first.
- **Reading each one:**
  - **Folder:** the first `cwd`, from the first 64 KB.
  - **Branch, model, and last activity:** from the last 256 KB.
  - **Start time:** the first timestamp, unless it's more than 60 seconds before the file's creation time, as for a fork, which copies the original's timestamps. Then it's the file's creation time.
  - **Usage:** the transcript reader's own incremental reading and allow-list, with `cwd` and `sessionId` added to it, and its budget. The 64 KB and 256 KB reads use the same allow-list.

  No message text is read (C-4, C-12).

- **Cache:** results are kept in memory per file, by size and modified time. A changed file is read again from where it stopped. `cwd` and `sessionId` stay in memory and never go into the store. Like `gitBranch` and `timestamp`, they're metadata, not message text, so C-12 still holds.
- **Budget:** History reads only when a page is asked for, so nothing is read while it's closed. It has a transcript reader of its own, with its own per-request budget, so while History is open a poll's reading can be up to twice one budget; live sessions' own reading is never slowed by it. Requests take turns, because the reader serves one caller at a time. A session found in two project folders shows once, from its newer file, and listing never follows links.
- **Order and paging:** 50 a page, newest last activity first across all pages (owner, after review). Each transcript's last 256 KB is read once for its last timestamp, cached by size and modified time, and the whole list is sorted by it before paging; ties go to the file changed most recently. The first page showed in 351 ms on 82 local transcripts.
- **No names:** History doesn't show names (C-7). Sessions with no messages are left out. A session in the main list is marked "In the list".

### Search (FR-36, C-16, NFR-15)

- **Routes:** `POST /api/search` starts a search, with `{ query }` in the body, so the text is never in the address. It returns a random 128-bit search id. `POST /api/search/<id>` returns progress and, when done, the results. `POST /api/search/<id>/cancel` cancels. They're all POSTs because browsers send an `Origin` header with a POST but not with a same-origin GET, and NFR-6 checks it. All three need the dashboard's origin, the page key, and the cookie (NFR-6), and every response is `Cache-Control: no-store`.
- **Who sees results:** results go only in the response to `POST /api/search/<id>`, to whoever has that id, which only the page that started the search knows. Nothing about a search goes over the WebSocket, because every tab shares it.
- **Limits:** one search at a time; a new one cancels the old. The query must be 2 to 200 characters after trimming.
- **Scanning:** in the server's own thread, reading each main transcript newest first in 64 KB pieces and pausing after each piece so polls and requests run on time (implementation step 6; scanning 147 MB measured 1.5 s of CPU, so a worker thread wasn't needed). It parses only lines containing `"user"` or `"assistant"`. It keeps prompt and reply text by U-22's allow-list, and also drops `isSidechain` lines, synthetic replies (`message.model: "<synthetic>"` or `isApiErrorMessage`), and, as a safeguard, any line with `isMeta`, `isCompactSummary`, or `toolUseResult`. It matches case-insensitively, as plain text, with no regular expressions, and maps each match back to the original text, since lowercasing can change a character's length (as with "İ"). It decodes each file as a stream, so a character split between two pieces stays whole, and snippets are never cut through an emoji. A single line longer than 8 MB of text is skipped. User lines without a human `origin` or `promptSource` are skipped; search raises no format warning.
- **Results:** per session, the match count and up to three snippets of at most 160 characters, with the match centred. The search stops collecting snippets after 100 matching sessions, but goes on counting. The page shows snippets as text, never as HTML.
- **Progress:** files done out of total, in the `POST /api/search/<id>` response, which the page asks for every second.
- **Stopping:** the page can cancel. The scan stops at 30 seconds with what it has, and says so.
- **Not kept:** results are kept in memory for at most 60 seconds after they're ready, or until they're fetched, cancelled, or replaced by a new search, then dropped. A timer drops them even if nothing asks again. The query and snippets are never logged.

### Folder picker (FR-32, NFR-15)

- **Request:** `{ action: "listFolders", folder? }`, with the page key. It returns the subfolder names of a local absolute folder, or of the user's home folder if none is given, and of drive roots.
- **Limits:** at most 500 entries. It never reads file contents, follows no shortcuts, and applies the folder checks to the folder asked for, so network, mapped, `subst`, and linked network folders are refused.

### Page

- **New session:** a "New session…" button in the header opens a modal dialog: folder (a text field and Browse), kind, name, and prompt (background only). Browse lists folders through the server, with drives, "Up one level", and "Use this folder". A refusal stays in the dialog as an alert; a start closes it, is announced, and returns focus to the button (0026).
- **Fork:** a "Fork…" button on rows with a session ID, in the main list, History, and search results, the protected session included, but not where Claude Code reports the folder gone. It opens its own dialog with kind, name, and prompt; the folder is the recorded one, shown but not editable (0026).
- **Views:** Sessions, History, and Search are header links with their own addresses (`#history`, `#search`), so Back and reload keep the view. The new view's heading takes focus (0026).
- **History:** 50 past sessions a page, newest first, with Newer and Older. Each shows its folder, branch, model, start, last activity, and usage, and Resume and Fork; one still in Claude Code's list offers only Fork. While usage is still counting, the page is read again every 5 seconds.
- **Search:** a search box; progress while it runs, with Cancel; leaving the view cancels it. Each result shows its match count, up to 3 snippets as plain text, its folder and last activity from History, and Resume and Fork (0026). History's details are read for the sessions shown with snippets, once the search is done.
- **Accessibility:** all of these meet NFR-8 (NFR-16), with axe checks in both themes.

### Other choices

- **CPU (NFR-11):** History reading and search run only when you open History or search, so they don't count toward NFR-11's steady-state figure. Search pauses after each piece, so polling stays on time.
- **Release notes:** they must say search reads message text while it runs and keeps none (C-16), that `%` isn't allowed in names, and that interactive Start and Fork may wait at Claude Code's trust prompt.

### Requirements coverage

| Requirement  | Where                                                       |
| ------------ | ----------------------------------------------------------- |
| FR-32, FR-34 | Start                                                       |
| FR-33, FR-34 | Fork                                                        |
| FR-35        | History, Resume from History                                |
| FR-36        | Search                                                      |
| C-15, NFR-14 | Start, Fork, launch arguments, folder checks, action routes |
| C-16         | Search                                                      |
| C-17, C-18   | Start, Fork                                                 |
| NFR-15       | History, Search, Folder picker                              |
| NFR-16       | Page                                                        |

### Build plan

Each step is a separate pull request, approved by an independent agent before merge.

| Step | Pull request                                                                                                        | Covers                 |
| ---- | ------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1    | Launch arguments and the Windows Terminal escape, proven through the dashboard's own launch                         | C-15, NFR-14, U-24     |
| 2    | Folder checks, the action route's schemas, and the Start action, with validation, the lock, and the 10-second watch | FR-32, FR-34, NFR-14   |
| 3    | Folder picker                                                                                                       | FR-32, NFR-15          |
| 4    | History index and its route                                                                                         | FR-35, NFR-15          |
| 5    | Fork, and Resume from History                                                                                       | FR-33, FR-35, C-9      |
| 6    | Search and its routes                                                                                               | FR-36, C-16, NFR-15    |
| 7    | Page: New session and Fork forms, History, and Search                                                               | FR-32 to FR-36, NFR-16 |

### Testing approach

- **Unit tests:**
  - **Argument building:** the options always come before `--`, and `--fork-session` is always there.
  - **Hostile input:** prompts and names with quotes, `;`, `%`, `^`, `&`, `|`, `!`, line breaks, a leading `-`, and option-like names.
  - **Windows Terminal escaping:** checked against a stand-in program.
  - **Validation:** each limit and refusal.
  - **Message text:** the U-22 allow-list, using a fixture of every line kind.
  - **History fields and snippets.**
  - **Nothing logged:** tests capture the tool's log and output and check that no prompt, name, search text, or snippet ever appears in them.
  - **Folder checks:** network, mapped, `subst`, and linked folders, using stand-ins.
- **Browser tests:** the forms, results, History paging, search progress, cancelling, the 30-second stop, focus, and axe.
- **Live checks:**
  - Start, both kinds, in a trusted throwaway folder. A refusal in an untrusted one, if the owner can provide one.
  - Fork of a running and a finished session, with the original's transcript unchanged.
  - A search over all local transcripts, timed.
  - History's first page, timed.
- **Security review (NFR-9):** the new actions, the folder picker, and search's handling of message text, before release.

## Iteration 5

Requirements: the Iteration 5 section of [requirements.md](requirements.md). Decisions: [0027](decisions/0027-iteration-5-plan.md), [0028](decisions/0028-iteration-5-requirements.md), and [0029](decisions/0029-iteration-5-design.md).

### Experiments (U-25 to U-29)

An agent ran `claude --bg --resume <session ID> -- <message>` the way Start runs Claude Code, with Claude Code 2.1.325, on seven of its own throwaway background sessions.

- **Delivered:** exit 0, `backgrounded · <short ID>[ · <name>]` on standard output, the same short ID and session ID as before, and `note: woke session <short ID> with its saved options (--name, --model).` on standard error, listing the options it restored. The session reads `working` straight away and has a process about 2 seconds later. The command returns in about 4 seconds, or 5 when Claude Code's background service has to start.
- **Copy:** a session with a process, working or idle, gets a copy: another short ID on standard output, and `note: session <ID> is already running in the background, so this started a copy as <new ID>.` on standard error. The original isn't changed.
- **Removed and rebuilt:** a session removed with `claude rm` is rebuilt from its saved conversation under the same IDs, with no note and without its saved options, such as its name.
- **Which states take a message:** `stopped`, `done`, and `failed`, whenever there's no process. `claude stop` on an idle session leaves it `done` with no process, and so does Claude Code's own idle timeout after about an hour, so `stopped` alone is rare. A `failed` session with no saved options was continued with no note.
- **Not visible:** the listing has no permission-mode field.
- **`waitingFor`:** Claude Code documents `permission prompt`, `input needed`, `sandbox request`, `worker request`, and `dialog open`.

### Send (FR-37, C-19, NFR-17)

- **Offered:** on a background row Claude Code lists, in state `stopped`, `done`, or `failed`, with a short ID, a session ID, no process ID, a usable folder, and not protected. A row with a process offers Open, as now.
- **Request:** `{ action: "send", key, message }` with its own strict schema. The route's 32 KB body limit, which now covers only `start` and `fork`, is extended to `send`. The message has a starting prompt's checks (`checkStartText`'s background rules).
- **Lock:** the per-session lock that Open, Resume, Stop, Delete, and End use, so only one action runs on a session at a time. Fork stays outside it, because it never changes the original.
- **Check:** refused if the session is protected, or if the tool can't tell which session started it, through `isProtected` as Stop, Delete, and End use it, which covers FR-37's "none at all" rule. Refused if the listing is out of date (C-9). Then a fresh listing must show the same short ID and session ID, in one of those states, with no process ID, and still not protected. Anything else is refused, and a failed fresh listing gives an unknown result.
- **Command:** `execFile(claude, ["--bg", "--resume", sessionId, "--", message], { cwd: folder })`, with no shell, `sessionLaunchEnv`, and a 30-second limit, after the folder checks.
- **Result:** Claude Code's answer decides it, as Start's does.
  - Exit 0 with the same short ID: delivered, followed by Start's 10-second failure watch. For a session that was already `failed`, a failure counts only after it has shown another state or a process. If the "woke session … with its saved options" note is missing, the result adds "Claude Code didn't say it restored the session's saved options." (0029).
  - Exit 0 with another short ID: "Claude Code started a new session, `<ID>`, with your message, because this one was running." The result carries the new short ID, and the page highlights that row once it's listed. It's left running.
  - Exit 0 with no `backgrounded · <ID>` line, or the 30-second limit reached: unknown, because the message may have been delivered. Never retried.
  - A non-zero exit: Start's refusal mapping, in the tool's own words. An error running Claude Code at all: failed.
  - Standard error is matched, never shown or logged (C-21).
- **Notifications:** Send records the user's own action for the session, as Stop does, so its events are held for 30 seconds. A copy isn't held, so its events notify as any new session's do.

### Waiting sessions (FR-38)

- **Labels:** `permission prompt` reads "Waiting on a permission prompt", and `input needed` reads "Waiting on your answer". Any other value, an unknown one, or `blocked` with no `waitingFor` reads "Needs you in Claude Code". The server keeps Claude Code's own value in `attentionReason`, so notifications compare it as now and a wording change alone never notifies. The page and the notification text map it to the plain label through one shared function (0029).
- **Note:** a row in Needs you adds "Answer it in Claude Code.", with Open where FR-14 offers it, and the folder and process ID where FR-20 applies. A Stale row keeps its label but no note, since it usually has no live prompt. Screen readers hear the row's name and then its label, with no "Needs you" prefix, since the label says it (owner's choice in the review of step 3).
- **Send:** never offered on a waiting row, which always has a process.

### Page

- **Send:** a "Send…" button on qualifying rows, hidden while actions are turned off or the row is protected, opens a dialog like Fork's, naming the session, with a message box. A refusal stays in the dialog; a send closes it, announces the result, and returns focus to the button. The field turns off autofill and spell check.

### Project upkeep (PU-1 to PU-4)

- **PU-1:** the docs' status line and the release decisions say the repository is public from 2026-11-14. Earlier wording stays as history.
- **PU-2:** private vulnerability reporting is turned on, and `SECURITY.md` points to it.
- **PU-3:** a branch rule on `main` requires a pull request and the `check` job, blocks force pushes and deletion, and lets admins bypass.
- **PU-4:** CI's actions are pinned to full commit hashes with a version comment, and `.github/dependabot.yml` updates them weekly.

### Open bugs (FR-39)

An agent re-checks each bug live on its own throwaway sessions, with the same rules as the live checks. It records the outcome in the test plan's Bugs table. For Claude Code's own behaviour, it drafts a report for the owner to file.

### Requirements coverage

| Requirement  | Design                                                                            |
| ------------ | --------------------------------------------------------------------------------- |
| FR-37        | Send                                                                              |
| FR-38        | Waiting sessions                                                                  |
| FR-39        | Open bugs                                                                         |
| C-19         | Send's command                                                                    |
| C-20         | No hooks, settings, or answers anywhere in the design                             |
| C-21         | Send's result: the message isn't echoed, and standard error isn't shown or logged |
| NFR-17       | Send's request, lock, and check                                                   |
| NFR-18       | Page                                                                              |
| PU-1 to PU-4 | Project upkeep                                                                    |

### Build plan

| Step | Change                                                                                          | Covers                      |
| ---- | ----------------------------------------------------------------------------------------------- | --------------------------- |
| 1    | Project upkeep: docs, `SECURITY.md`, private reporting, branch rule, pinned actions, Dependabot | PU-1 to PU-4                |
| 2    | Re-check the open bugs, with workarounds and drafted reports                                    | FR-39                       |
| 3    | Waiting sessions' labels and note                                                               | FR-38, FR-5                 |
| 4    | Send's server side                                                                              | FR-37, C-19 to C-21, NFR-17 |
| 5    | Send's page                                                                                     | FR-37, NFR-18               |

### Testing approach

- **Unit tests:** Send's arguments; eligibility for every state with and without a process; protected and unknown-starter refusals; the fresh check; the lock with Open and Stop; the four result cases and the timeout; the note-line warning; the watch for an already `failed` session; the own-action hold; the body limit; hostile messages; nothing logged; and the shared label function, including that a wording change doesn't notify.
- **Browser tests:** the Send dialog, its refusal and success, focus, the waiting labels, and axe in both themes.
- **Live checks:** Send to a `done` session and to a `failed` one, each with no process; to one that gains a process in the meantime, giving a copy; the refusal for a session with a process; and the waiting labels if a waiting session can be seen without answering it.
- **Security review (NFR-9):** Send and its route, before release.

## Iteration 6

Requirements: the Iteration 6 section of [requirements.md](requirements.md). Decisions: [0030](decisions/0030-iteration-6-plan.md), [0031](decisions/0031-iteration-6-requirements.md), and [0032](decisions/0032-iteration-6-design.md).

### Research (U-30 to U-33)

An agent read Claude Code's documentation and the systems' manuals, and ran throwaway probe workflows on GitHub's macOS 26 and Ubuntu 26.04 runners, with Node 24, no secrets, and nothing merged. Nothing was tried with a real Claude Code session, so process names and the first macOS Automation prompt need a live check.

- **macOS Terminal:** `osascript` passes its arguments through unchanged, and `--` must come first or a leading `-` is read as an option. Quoting with single quotes survived 25 hostile folder names in `sh`, `bash`, and `zsh`, but `fish` breaks on `\` and `tcsh` on `!`. `do script` types the text into the shell, so a control character would run part of it early. With no one to allow Automation, `osascript` waited until it timed out.
- **Mount tables:** `/proc/self/mountinfo` on Linux and `/sbin/mount` on macOS answered in milliseconds while an NFS mount was hung, but `stat`, `realpath`, and `statfs` on it hung, and a time limit in Node can't free the thread they block. Mount points use octal escapes on Linux. Stacked mounts list the top one last. macOS marks local volumes with a `local` flag; `/home` there is autofs.
- **Claude Code:** the documentation gives the same `claude agents --json` fields, commands, and variables on every system. npm now installs the native program, not a Node script. On macOS, background sessions can run from `~/.local/share/claude/ClaudeCode.app`.
- **Linux terminals:** `gnome-terminal --wait --working-directory=<folder> -- <program> <args>`, `konsole --workdir <folder> -e <program> <args>`, `xterm -e <program> <args>`, and `x-terminal-emulator -e <program> <args>` passed every hostile argument through unchanged, except that Konsole, and `x-terminal-emulator` when it's Konsole, expand set `$` variables. A bad folder falls back to the home folder silently. Without `--wait`, `gnome-terminal` always exits 0.
- **`ps`:** `ps -ww -o ppid=,lstart=,comm=,args= -p <pid>`, with `LC_ALL=C` and `TZ=UTC0`, gives the parent, a start time to the second, and the program. A walk takes under 60 ms. On Linux, Node shows as `MainThread`.

### Platforms (FR-40, C-22)

- **One module per concern:** `platform.ts` decides the system once and holds the programs, data folder, browser, terminal, folder-check, and protection code for each. Windows keeps today's code paths unchanged.
- **Programs:** found on a cleaned `PATH`, with empty, relative, and `.` entries removed, each one an existing executable file, and run with no shell. `ps` (`/bin/ps` on macOS, `/usr/bin/ps` or `/bin/ps` on Linux), `/sbin/mount`, and `/usr/bin/osascript` are run by absolute path. On macOS and Linux only, `sessionLaunchEnv` cleans the launched program's `PATH` the same way; Windows keeps today's environment.
- **Names:** `$` is refused in names on every system, as `%` is (0032). `checkStartText`, the New session form's hint, and their tests change together.

### Data folder (FR-41)

The folder is created with mode 0700 and its files with 0600. At start, the tool checks the folder and its files: a folder or file that's a link, or isn't owned by the user, is refused, and the tool stops with a message. One that others could read or write is set back to those modes, or the tool stops with a message if it can't.

### Browser (FR-42)

`open <link>` on macOS and `xdg-open <link>` on Linux, unless neither `DISPLAY` nor `WAYLAND_DISPLAY` is set. One shared check for a display serves both FR-42 and FR-43.

### Terminals (FR-43)

- **macOS:** a fixed AppleScript, passed as `-e` lines to `/usr/bin/osascript`, takes one argument after `--`: the command `cd '<folder>' && '<claude>' attach <ID>`, or `--resume <UUID>`, each part quoted with single quotes. It runs it with `do script` in Terminal. A folder or Claude Code path with `\`, `!`, or a control character shows the command instead (0032). The tool waits up to 120 seconds: exit 0 is started; a refusal to send Apple events or a timeout is failed, with a hint to allow Automation for the terminal the tool runs in, in System Settings, Privacy and Security.
- **Linux, the terminals:** in order, `x-terminal-emulator`, `gnome-terminal`, `konsole`, and `xterm`, each with the program and its arguments as separate words, at least two of them, and the folder checked again just before. `x-terminal-emulator` is resolved through its links first, and the terminal it leads to is started with that terminal's own rules below.
  - `gnome-terminal --wait --working-directory=<folder> -- <program> <args>`.
  - `konsole --nofork --workdir <folder> -e <program> <args>`, so it doesn't hand the window to another Konsole and exit at once. For a folder containing `$`, `--workdir` is left out and the folder is only the working folder, since Konsole may expand it (0032); a probe confirms Konsole keeps that folder, or else Konsole is skipped for it.
  - `xterm -e <program> <args>`, with the folder as the working folder.
- **Linux, which terminal:** a terminal is tried only if its program can be started; it fails to start when the program isn't found or can't be run, or there's no display. Then the next one is tried. Once one has started, the tool waits about 2 seconds: still running is started; exited, with any code or signal, is failed, with the command shown, and no further terminal is tried, so at most one window opens (0032).
- **The command shown:** each part quoted for `sh`, with the folder first, as `cd '<folder>' && '<claude>' …`.

### Folder checks (FR-44)

- **The table:** `/proc/self/mountinfo` on Linux, read with a 2-second limit and its `\ooo` escapes decoded; on macOS, `/sbin/mount` with `LC_ALL=C` and a 5-second limit, each line parsed as `<source> on <path> (<type>, <flags>)`. It's read once for each check.
- **Visible mounts only:** on Linux, a mount another mount covers is left out, using `mountinfo`'s mount and parent IDs: a mount is hidden when a later one is mounted on its own mount point or on a folder above it. So a network folder mounted over a parent can't be mistaken for a local mount hidden beneath it.
- **Resolving without touching a network folder:** the folder is resolved one part at a time, keeping the physical path resolved so far.
  - Before each `lstat` or `readlink`, the path including the part about to be touched is matched to the visible mount whose point is its longest prefix, on whole parts, and refused unless that mount's type is allowed.
  - `..` goes up from the physical path resolved so far, and from `/` stays at `/`.
  - A link's target is resolved against the link's own folder, or from `/` when it's absolute.
  - At most 40 links are followed over the whole resolution, and reaching that is refused.
  - `realpath`, `stat`, and `statfs` are never called on a folder that hasn't passed. The resolved path is what's checked again before a launch and used as the working folder.
- **Every check of a session's folder** goes through this, including the folder watch that marks a finished session's folder as gone and Open's and Resume's check that the folder exists. A folder that isn't local counts as unknown there, so no Resume is offered for it, rather than being touched.
- **Allowed types:** on Linux, `ext2`, `ext3`, `ext4`, `xfs`, `btrfs`, `zfs`, `f2fs`, `bcachefs`, `jfs`, `reiserfs`, `ecryptfs`, `tmpfs`, `ramfs`, `overlay`, `vfat`, `exfat`, and `ntfs3`; on macOS, `apfs`, `hfs`, `zfs`, `exfat`, and `msdos` with the `local` flag (0032). Everything else is refused, including `fuse.*`, `fuseblk`, network types, `9p`, `virtiofs`, `autofs`, and the virtual ones.
- **Browse:** the home folder, `/`, and the mounted volumes under `/Volumes`, `/media/$USER`, `/run/media/$USER`, and `/mnt`, each listed only if it passes.
- **Case:** paths are compared exactly on Linux. On macOS, they're compared without case when the volume isn't case-sensitive, which `/sbin/mount` doesn't say, so the tool checks once for each volume with `pathconf`'s case-sensitivity setting through `getconf`, and treats the usual APFS boot volume as without case if that can't be read (C-24).

### Self-protection (FR-45)

- **Variables:** `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, and `CLAUDE_PID`, as on Windows.
- **The walk, on Linux:** from the tool's parent up to process 1, reading each process's `/proc/<pid>/stat` for its parent and start time, `/proc/<pid>/exe` for its program, and `/proc/<pid>/cmdline` for its arguments, split on NUL so a path with a space stays whole. No `ps` is needed, so BusyBox systems work too.
- **The walk, on macOS:** `/bin/ps` with one field at a time, `-o ppid= -p <pid>`, `-o lstart= -p <pid>`, and `-o args= -p <pid>` with `-ww`, `LC_ALL=C`, and `TZ=UTC0`, so a space in a path can't shift the fields.
- **Claude Code's process:** its program's base name is `claude`, or its program is in a `ClaudeCode.app` bundle, or it's `node` running a path that ends in `@anthropic-ai/claude-code/cli.js`, or, on Linux, its program file matches `/claude/versions/<version>`. The first found is matched to the listing by process ID and by a start time within 1 second before and 6 seconds after the listed one, allowing for `ps`'s whole seconds.
- **Can't tell:** the walk can't be read, a variable names a session the listing doesn't show, or the walk finds a Claude Code process that isn't listed. Stop, Delete, and Send are then turned off.
- **Hand-over:** a second start sends every identity it found, from the variables and from the walk, and the hand-over's schema takes a short list of them, still strict.

### Page (FR-46)

On macOS and Linux, End, Force end, and End leftover programs aren't offered, and the page says once that they're Windows-only for now. Stop and Delete don't record leftover programs, and their result says nothing about them.

### CI (NFR-19)

One job per system, on every pull request and push to `main`, with `fail-fast: false` and time limits of 15 minutes on Windows and macOS and 10 on Linux. Linux installs Playwright's browser with its system packages. Many tests build Windows paths today, so step 1 runs them with `path.win32` or only on Windows, and later steps turn on the ones they cover for macOS and Linux. `main` requires all three jobs.

### Requirements coverage

| Requirement  | Design                                                                    |
| ------------ | ------------------------------------------------------------------------- |
| FR-40, C-22  | Platforms                                                                 |
| FR-41        | Data folder                                                               |
| FR-42        | Browser                                                                   |
| FR-43        | Terminals                                                                 |
| FR-44, C-24  | Folder checks                                                             |
| FR-45        | Self-protection                                                           |
| FR-46        | Page                                                                      |
| NFR-19       | CI                                                                        |
| NFR-20, C-23 | Every step keeps the existing guards and tests, with POSIX hostile inputs |

### Build plan

| Step | Change                                                                               | Covers             |
| ---- | ------------------------------------------------------------------------------------ | ------------------ |
| 1    | CI on all three systems, with Windows-only tests skipped elsewhere                   | NFR-19             |
| 2    | The platform module, programs on a cleaned `PATH`, `$` in names, and the data folder | FR-40, FR-41, C-22 |
| 3    | Folder checks from the mount table, and Browse's roots                               | FR-44, C-24        |
| 4    | Self-protection by the walk, and the hand-over                                       | FR-45              |
| 5    | Browser and terminals on macOS and Linux                                             | FR-42, FR-43       |
| 6    | The page: End hidden with its note, and Stop and Delete without leftover recording   | FR-46              |

### Testing approach

- **Unit tests:** each platform's code with stand-ins for `ps`, the mount table, and the terminals, run on every system; the mount-table parsers on real samples from the probes; the step-by-step resolver against links, relative and absolute targets, `..` from `/`, the 40-link cap, and a network mount over a local one; the AppleScript and `sh` quoting against the probes' hostile names; planted `claude`, `node`, and terminal programs in the session's folder that must never run; and the data folder's modes.
- **Browser tests:** the page on each system in CI, with End hidden and its note on macOS and Linux.
- **Live checks:** recorded as not run on macOS and Linux until a machine is available. When one is: a real session's process names, including a `ClaudeCode.app` host; the first Automation prompt; Terminal opening in the folder, and the `&&` command in the user's shell; each Linux terminal, including `x-terminal-emulator` through the GNOME wrapper and a Konsole already open; and an NFS or SMB folder, and one mounted over a local folder, being refused.
- **Security review (NFR-9):** the new launches, the folder checks, and the walk, before release.
