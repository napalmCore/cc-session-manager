# Release notes

## Iteration 1 (draft)

Not released yet. The version number, packaging, and distribution will be decided in Phase 6.

### What it does

cc-session-manager is a read-only dashboard for your Claude Code sessions. It runs on your own computer and opens in your browser.

- Lists your running interactive and background sessions.
- Puts sessions that need you first, with the reason, and shows the count in the browser tab title.
- Announces sessions that newly need you to screen readers.
- Moves blocked sessions with no activity for over 7 days to a collapsed Stale group.
- Shows each session's name, project folder, kind, status, start time, running time, git branch, model, and last activity.
- Keeps finished sessions listed for 24 hours, including after a restart.

### What it doesn't do yet

It can't control sessions, answer prompts, send notifications outside the page, or show history, search, cost, or token use. Only Windows is tested. It needs Node 24 or later.

### Privacy and security

- The server listens on `127.0.0.1` only, and needs a one-time sign-in link and a session cookie.
- Nothing is sent off your computer by the tool itself. It runs `claude agents --json --all`, and doesn't assess what that command does.
- It reads the last 256 KB of each session's transcript, and keeps only the branch, model, and timestamp.
- Finished sessions are saved in your local data folder without their names or message text. A corrupt older file is set aside unchanged, so it could still hold names.
- Live session names come from Claude Code, which can use your prompt as the name until a title is generated, so the page and screen-reader announcements can briefly show prompt text.
- If no browser opens, the one-time sign-in link is printed to the terminal.

### Known limits

- Interactive sessions that end while the tool is off aren't listed.
- A background session you delete with `claude rm` leaves the dashboard straight away.
- A session sitting at a trust dialog isn't listed by Claude Code, so it can't be shown.
- Sessions started from inside another Claude Code session may not be listed.
- Branch shows as unavailable for a session started outside a repository, for a detached HEAD, and for a repository created after the session started.
- End times are approximate, because Claude Code doesn't report them.
- When no timestamp can be read, last activity comes from the file's modified time, which ran up to about 87 hours later than the real last activity on the files tested.
- The tool depends on Claude Code's local files and command output, which may change between versions.

### Open bugs

No Medium, High, or Critical bugs are open, subject to the screen-reader check below.

| ID     | Bug                                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BUG-6  | Rows move within Active when activity times change or appear                                                                                                  |
| BUG-7  | Sessions with an inherited `CLAUDE_CODE_CHILD_SESSION` weren't listed by the CLI in one observation                                                           |
| BUG-8  | The login token prints to the terminal when no browser opens                                                                                                  |
| BUG-9  | No signal that data is stale while the CLI is slow, for up to 15 seconds                                                                                      |
| BUG-10 | Screen-reader noise: triangles, dots, and name and reason run together                                                                                        |
| BUG-11 | Focus falls to the page body when the focused expandable section disappears                                                                                   |
| BUG-12 | A corrupt older file is set aside with any names still inside                                                                                                 |
| BUG-13 | A stale session with no readable transcript file can move to Needs you and be announced                                                                       |
| BUG-14 | A second session with no ID and no name isn't announced separately                                                                                            |
| BUG-16 | An announcement can be lost if a second update arrives within 100 ms                                                                                          |
| BUG-17 | After a failed first poll, the page says it is showing last known data and also "No sessions to show"                                                         |
| BUG-18 | A new interactive session whose first listing has no `status` reads `unknown` for one refresh                                                                 |
| BUG-19 | The `status` excuse also covers existing sessions on the tool's first poll, and a session that keeps leaving the list or changes its ID can avoid the warning |
| BUG-20 | A session listed first with no ID and no status warns, and is then excused once it gets an ID                                                                 |
| BUG-22 | Claude Code doesn't list a session at a trust dialog                                                                                                          |
| BUG-23 | A background session's start time shifts by about 3 seconds, and `claude -p` runs are listed as interactive                                                   |
| BUG-24 | False format warnings remain possible, from a new header line type or a large `api-request-blob` line                                                         |
| BUG-26 | Some format changes raise no warning: all lines malformed, or `message` renamed while `timestamp` stays                                                       |

### Before this can ship

- **M2:** the owner runs the NVDA script in [test-plan.md](test-plan.md). BUG-3 (High, provisional) stays open until then, and the WCAG 2.2 AA requirement can't be claimed without it.
