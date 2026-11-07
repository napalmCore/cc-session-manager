# Requirements

- **Status:** Signed off for iteration 1 on 2026-11-06
- **Scope:** Read-only live monitoring of Claude Code sessions, Windows first

## Functional requirements

| ID    | Requirement                              | Acceptance criteria                                                                                                                                                                                                                                                                                                                                                           |
| ----- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-1  | List active sessions                     | Running interactive and background sessions from `claude agents --json` appear on the dashboard.                                                                                                                                                                                                                                                                              |
| FR-2  | Keep recently finished sessions          | Finished sessions the tool observed while running, and completed background sessions reported by the CLI, stay listed for 24 hours and are marked as finished. A background session the CLI no longer lists, such as after `claude rm`, leaves the dashboard straight away. Interactive sessions that end while the tool is off aren't listed, and the docs state this limit. |
| FR-3  | Show identity and status                 | Each session shows its name, project folder, kind (interactive or background), and current status. The name comes from the CLI, which can use prompt text until a title is generated, and it isn't stored, so a finished session the CLI no longer lists shows as unnamed after a restart.                                                                                    |
| FR-4  | Show time information                    | Each session shows its start time and how long it has been running.                                                                                                                                                                                                                                                                                                           |
| FR-5  | Show why a session needs the user        | Sessions needing attention show the reason when the CLI provides it, or a generic "needs input" label otherwise.                                                                                                                                                                                                                                                              |
| FR-6  | Show latest activity metadata            | Each session shows its git branch, model, and last activity time when available. A branch reported as `HEAD` counts as unavailable. If no timestamp can be read from a transcript, last activity is the file's modified time. A missing value doesn't hide the session or cause an error.                                                                                     |
| FR-7  | Highlight sessions needing attention     | These sessions are listed first with a clear marker that doesn't rely on color alone. Stale sessions, as defined in [0009](decisions/0009-dashboard-ui.md), appear in a separate collapsed group.                                                                                                                                                                             |
| FR-8  | Show an attention count                  | The browser tab title shows how many sessions need attention, excluding stale sessions.                                                                                                                                                                                                                                                                                       |
| FR-9  | Stay current                             | Session changes appear on the dashboard within 5 seconds.                                                                                                                                                                                                                                                                                                                     |
| FR-10 | Announce new attention to screen readers | A session that newly needs the user is announced politely, with its name and reason. Sessions already waiting when the page opens are not announced.                                                                                                                                                                                                                          |

## Constraints

| ID  | Constraint                                                                                       | Source                                                  |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| C-1 | The tool must not change sessions, Claude Code settings, or files under `~/.claude`.             | [0003](decisions/0003-first-iteration-and-platforms.md) |
| C-2 | The tool must never read, log, or display `~/.claude/.credentials.json` or session `.key` files. | [0002](decisions/0002-product-direction.md)             |
| C-3 | The tool must not depend on `~/.claude/jobs/<id>/`.                                              | [0002](decisions/0002-product-direction.md)             |
| C-4 | Transcript reads must not store or display message text.                                         | [0006](decisions/0006-transcript-metadata.md)           |
| C-5 | Iteration 1 doesn't use hooks.                                                                   | Requirements review, 2026-11-06                         |
| C-6 | Windows is supported first, and the code stays portable.                                         | [0003](decisions/0003-first-iteration-and-platforms.md) |
| C-7 | The store must not contain session names, because they can hold prompt text.                     | [0011](decisions/0011-testing-bug-fixes.md)             |

## Out of scope for iteration 1

- Starting, stopping, resuming, or otherwise controlling sessions
- Sending prompts or answering permission requests
- History, search, cost, and token analytics
- Message previews
- Desktop or browser notifications
- macOS and Linux support

## Known unknowns

| ID  | Question                                                                                                                                                                               | Resolve in |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| U-1 | Resolved: the [docs](https://code.claude.com/docs/en/agent-view) list `status: waiting` for sessions needing the user. Confirm against a live session during Testing.                  | Testing    |
| U-2 | Resolved: `waitingFor` is present only when `status` is `waiting`, so a `blocked` session without an open prompt needs the generic label.                                              | Done       |
| U-3 | Resolved: `--all` keeps completed background sessions, but only those are documented as staying listed, and no end time is listed. The tool must store finished sessions to meet FR-2. | Done       |
| U-4 | Resolved: `gitBranch`, `message.model`, and `timestamp` were found in all 43 local transcripts checked on 2026-11-06.                                                                  | Done       |
| U-5 | Resolved: one poll uses about 353 ms of CPU, so a 3-second interval uses about 1.3% of an 8-core PC. See [test-plan.md](test-plan.md).                                                 | Done       |

## Non-functional requirements

| ID    | Requirement                | Acceptance criteria                                                                                                                                                                                                                                                                              |
| ----- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| NFR-1 | Local access only          | The server listens only on the loopback interface and is unreachable from other devices.                                                                                                                                                                                                         |
| NFR-2 | Token required             | Requests without the valid random token are rejected. The token isn't written to logs.                                                                                                                                                                                                           |
| NFR-3 | No data leaves the machine | No telemetry or error reports are sent. The running tool makes no external network requests, and the dashboard loads all its assets locally.                                                                                                                                                     |
| NFR-4 | Degrade on change          | When Claude Code output changes or data is missing, the dashboard keeps showing what still works, marks what is missing, and displays a clear banner. A missing `status` on an identified interactive session not listed in the previous successful poll doesn't raise the banner for that poll. |
| NFR-5 | Accessibility              | The dashboard is built towards WCAG 2.2 AA and passes automated axe scans and keyboard tests. It doesn't claim conformance, and hasn't been verified with a screen reader. See [0013](decisions/0013-release-without-wcag-claim.md).                                                             |
