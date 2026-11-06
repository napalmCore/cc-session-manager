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

| Component              | Responsibility                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| CLI entry point        | Chooses a port, creates the token, starts the server, and opens the browser.                         |
| Session poller         | Runs one `claude agents --json --all` at a time, on the server, whatever the number of browser tabs. |
| Schema layer           | Uses tolerant Zod schemas that ignore unknown fields and report missing ones.                        |
| Metadata reader        | Reads the end of a transcript only when its modified time changes, and caches the result.            |
| Finished-session store | Keeps finished sessions in a JSON file and removes them after 24 hours.                              |
| Auth layer             | Handles the one-time token, the session cookie, and the checks on incoming connections.              |
| Dashboard              | Shows the session list using React, React Aria, and CSS Modules, built with Vite and served locally. |

## Data flow

1. The poller runs the CLI. The interval is in the 2 to 5 second range, and the final value comes from load measurements (U-5).
2. The schema layer validates each entry and records any missing fields.
3. The metadata reader adds git branch, model, and last activity time.
4. The server compares the result with the last state, and updates the store.
5. The server sends changes to connected dashboards over WebSocket.

## Session rules

| Case                         | Rule                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Needs attention              | `status` is `waiting`, or `state` is `blocked`.                                                                 |
| Reason                       | Use `waitingFor` when present, otherwise show "needs input".                                                    |
| Finished background session  | `state` is `done`, `failed`, or `stopped`.                                                                      |
| Finished interactive session | It was seen earlier and is no longer listed.                                                                    |
| End time                     | The CLI doesn't provide one, so use the time the tool first sees the session as finished, shown as approximate. |

## Transcript metadata

- **Fields kept:** `gitBranch`, `message.model`, and `timestamp`. An explicit allow-list copies only these fields, and tests must confirm that no message text gets through (C-4).
- **Lookup:** `sessionId` must be a valid UUID before it is used to find `~/.claude/projects/*/<sessionId>.jsonl`, which prevents path traversal.
- **Partial results:** a field not found near the end of a file shows as unavailable (FR-6).
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

The file holds session names and project paths, but no message text.

Records stay in the file while the CLI still lists a session, even after 24 hours, so a completed background session doesn't look newly finished on the next poll. A completed background session first seen by the tool, including on its first run, is treated as finishing at that moment, because the CLI doesn't report end times.

## Failure handling

| Failure                                       | Behavior                                                            |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `claude` isn't installed or the command fails | Show a banner explaining the problem, and keep retrying.            |
| Output can't be parsed                        | Keep the last good data, mark it as out of date, and show a banner. |
| A field is missing                            | Mark it as unavailable and show a banner.                           |
| Transcript is missing or unreadable           | Show the session without metadata.                                  |
| Store file is corrupt                         | Set it aside, start with an empty list, and show a notice.          |
| Default port is busy                          | Try the next free port.                                             |

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

Each step is a separate pull request, approved by the owner before merge.

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

- **Phase 5 (Testing):** the final polling interval.
- **Phase 6 (Release):** packaging and distribution, including a packaged executable for users without Node.
