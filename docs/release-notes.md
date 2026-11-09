# Release notes

## 0.1.0

The first release. It covers iterations 1 and 2. Get it from the GitHub release: clone the repository at the `v0.1.0` tag, then follow the README. It isn't published to npm.

cc-session-manager is an independent tool. It isn't made, endorsed, or supported by Anthropic.

### What it does

cc-session-manager is a dashboard for your Claude Code sessions. It runs on your own computer and opens in your browser.

**Monitoring:**

- Lists your running interactive and background sessions.
- Puts sessions that need you first, with the reason, and shows the count in the browser tab title.
- Marks sessions that newly need you for screen readers to announce. See Accessibility.
- Moves blocked sessions with no activity for over 7 days to a collapsed Stale group. A session with an open prompt or unknown activity is never moved there.
- Shows each session's name, project folder, kind, status, start time, running time, git branch, model, and last activity. A live interactive session also shows its process ID, so you can find its terminal.
- Keeps finished sessions listed for 24 hours, including after a restart.

**Desktop notifications**, once you turn them on from the page:

- When a session newly needs you, or its reason changes.
- When a background session finishes or a session fails.
- When the tool can't read sessions three times in a row.

A notification shows only the project folder and the reason, and clicking it highlights the session's row. Notifications only arrive while the dashboard page is open, though it can be in the background. Your own actions from the dashboard don't notify.

**Actions** on each row:

- **Open** a background session in a new terminal, through `claude attach`.
- **Resume** a finished interactive session in a new terminal, through `claude --resume`, in its original folder.
- **Stop** a background session. The conversation is kept.
- **Delete** a background session, through plain `claude rm`.
- **End** a live interactive session by asking it to close normally, and **Force end** it if that doesn't work.

Stop, Delete, End, and Force end ask you to confirm first, and the dialog names the session. Results appear on the row in the tool's own words. If the result can't be confirmed, the page says it's unknown.

### What it doesn't do yet

- It can't answer prompts, send messages, start, rename, or fork sessions, or show history, search, cost, or token use.
- It can't jump to a live session's existing terminal.
- It can't force a delete that Claude Code refused.
- Only Windows is tested, and opening a terminal is Windows-only. It needs Node 24 or later, pnpm, and Claude Code installed.

### Safety rules for actions

- **Delete never forces.** The tool never passes `claude rm`'s `--discard-unpushed` or `--force-remove-worktree` flags. If Claude Code keeps a session to protect its work, the page says so and you finish in the CLI.
- **Actions use a fresh listing.** Stop, Delete, End, and Resume are refused while the latest refresh has failed or the list is more than 10 seconds old. The server then rechecks the session against a new listing before acting.
- **End checks the process.** Immediately before each signal, End checks that the process ID still belongs to the session. Force end is only accepted for the same process within 2 minutes of a normal close.
- **The starting session is protected.** If you start the dashboard from inside a Claude Code session, that session has no Stop, Delete, or End. If the tool can't find it in the list, those actions are off for every session, and the page says why.
- **One action at a time.** Each session runs one action at a time, and nothing retries automatically.
- **No folder search.** Programs are never looked up in a session's folder, so a program planted there can't run.

### Privacy and security

- The server listens on `127.0.0.1` only, and needs a one-time sign-in link and a session cookie.
- Browsers send a cookie to every port on a computer, so sign-in also gives the page a key, kept in browser storage that's separate for each port. Actions and live updates need both the cookie and the key, so another program on your computer can't use a cookie it obtains. Chrome may record the sign-in address, which holds the key, in your history. The key changes each time the tool starts.
- Actions need a request from the dashboard's own page. The page names an action and a session, and the tool builds the command from its own data.
- A second start of the tool opens the running one instead, through a lock file, `instance.json`, in the same folder. That file holds a secret that's as exposed as the finished-sessions file, because any program running as you can read both.
- Nothing is sent off your computer by the tool itself. It runs `claude agents --json --all`, and doesn't assess what that command does.
- It reads the last 256 KB of each session's transcript, and keeps only the branch, model, and timestamp.
- Finished sessions are saved in plain text in `%LOCALAPPDATA%\cc-session-manager\finished-sessions.json`. The file holds project paths, branch, model, session IDs, and times, but no names or message text. Project paths and branch names can themselves reveal your username or client names.
- A completed background session stays in that file while Claude Code still lists it, even after it leaves the page. A corrupt older file is set aside unchanged, so it could still hold names.
- Live session names come from Claude Code, which can use your prompt as the name until a title is generated, so the page and screen-reader announcements can show prompt text. A session that ends before it has a title keeps showing that text under Finished until the row leaves or the tool restarts. A background session Claude Code still lists keeps whatever name it reports.
- If opening the browser fails with an error, the one-time sign-in link is printed to the terminal. If you lose the sign-in cookie or switch browsers, restart the tool for a new link.

### Known limits

**Actions and notifications:**

- After Stop or Delete, programs the session started, such as a long-running command, can keep running, and a deleted session's shell can keep its folder locked. This is Claude Code's behavior, and the dialogs say so (BUG-30).
- End sends Ctrl+Break, which also reaches the shells that started the session.
- A session started from Git Bash can't be closed normally from here, so End offers Force end straight away.
- With npm's `claude.cmd`, the terminal shows "Terminate batch job (Y/N)?" after End.
- Resume runs in the session's original folder, so Claude Code loads that folder's own settings, as it would if you resumed it by hand.
- Resume disappears up to about 13 seconds after a session's folder is deleted. A folder on a network share isn't checked in advance, but Resume is still refused if the folder has gone.
- Notifications only work while the page is open, and don't show session names, so similar sessions in one folder look alike. A crashed interactive session sends no notification.
- Ending a session, or a Force end, can lose work in progress.

**Monitoring:**

- Interactive sessions that end while the tool is off aren't listed.
- After a restart, finished sessions show as unnamed unless Claude Code still lists them.
- A background session you delete with `claude rm` leaves the dashboard straight away. If Claude Code ever removes completed sessions itself within 24 hours, they would leave early too.
- A session sitting at a trust dialog isn't listed by Claude Code, so it can't be shown.
- Sessions started from inside another Claude Code session may not be listed.
- Branch shows as unavailable for a session started outside a repository, for a detached HEAD, and for a repository created after the session started. A branch or model not found near the end of a transcript also shows as unavailable.
- End times are approximate, because Claude Code doesn't report them. A completed background session counts as finishing when the tool first sees it, so its end time can be well off, and older ones can appear as newly finished on first run.
- When no timestamp can be read, last activity comes from the file's modified time, which ran up to about 87 hours later than the real last activity on the files tested. A session can reach Stale late, and a touched file can cause a false alert.
- A new session could raise a false warning for one refresh, if its first listing stays incomplete across two refreshes.
- The tool depends on Claude Code's local files and command output, which may change between versions.

### Open bugs

One open bug is Medium, and the rest are Low.

| ID     | Bug                                                                                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BUG-6  | Rows move within Active when activity times change or appear                                                                                                                                                                         |
| BUG-7  | Sessions with an inherited `CLAUDE_CODE_CHILD_SESSION` weren't listed by the CLI in one observation                                                                                                                                  |
| BUG-8  | The login token prints to the terminal when the browser launch fails                                                                                                                                                                 |
| BUG-9  | No signal that data is stale while the CLI is slow, for up to 15 seconds                                                                                                                                                             |
| BUG-10 | Screen-reader noise: triangles, dots, and name and reason run together                                                                                                                                                               |
| BUG-11 | Focus falls to the page body when the focused expandable section disappears                                                                                                                                                          |
| BUG-12 | A corrupt older file is set aside with any names still inside                                                                                                                                                                        |
| BUG-13 | A stale session with no readable transcript file can move to Needs you and be announced                                                                                                                                              |
| BUG-14 | A second session with no ID and no name isn't announced separately                                                                                                                                                                   |
| BUG-16 | A screen-reader announcement can be lost if a second update arrives within 100 ms, which is only likely around a reconnect                                                                                                           |
| BUG-17 | After a failed first poll, the page says it is showing last known data and also "No sessions to show"                                                                                                                                |
| BUG-18 | A new interactive session whose first listing has no `status` reads `unknown` for one refresh                                                                                                                                        |
| BUG-19 | A missing status doesn't warn on a session's first listing, which also covers existing sessions when the tool starts. A session that keeps leaving the list or changes its ID could avoid the warning, though this hasn't been seen. |
| BUG-20 | A session listed first with no ID and no status warns, and is then excused once it gets an ID                                                                                                                                        |
| BUG-22 | Claude Code doesn't list a session at a trust dialog                                                                                                                                                                                 |
| BUG-23 | A background session's start time shifts by about 3 seconds, and `claude -p` runs are listed as interactive                                                                                                                          |
| BUG-24 | False format warnings remain possible, if Claude Code adds a new kind of header line, or writes a very large line that hides the last timestamp, until the next timestamped line                                                     |
| BUG-26 | Some format changes raise no warning: all lines malformed, or `message` renamed while `timestamp` stays                                                                                                                              |
| BUG-27 | A very short session can keep older details on its Finished row, such as "Model unavailable"                                                                                                                                         |
| BUG-29 | A terminal started by Open might keep the tool's output open after the tool exits. It was seen once and couldn't be reproduced.                                                                                                      |
| BUG-30 | **Medium.** After Stop or Delete, programs the session started can keep running. This is Claude Code's behavior, and the dialogs say so.                                                                                             |

### Accessibility

The dashboard is built towards WCAG 2.2 AA and passes automated accessibility scans and keyboard tests, but it doesn't claim conformance and **hasn't been tested with a screen reader**. Screen-reader announcements are in place, but whether and how they're read out is unverified, and BUG-10 lists likely noise. The action buttons and dialogs work with the keyboard and pass the same automated checks, and haven't been tested with a screen reader either (decision 0016).

### Not checked live

These were checked by automated tests and review, but not on real sessions:

- Delete on a session whose worktree has unsaved work, which Claude Code should keep (L10, deferred by decision 0016).
- A notification arriving while the dashboard tab is hidden. One was checked with the window in the background, but the page still counted as visible.
