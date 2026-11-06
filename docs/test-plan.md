# Test plan

- **Status:** In progress for iteration 1
- **Requirements:** [requirements.md](requirements.md)

## Exit criteria

Testing passes when both of these are true:

- Every requirement and constraint below has been checked.
- No critical or high severity bugs are open. Medium and low severity bugs may ship if the release notes list them.

| Severity | Meaning                                                                           |
| -------- | --------------------------------------------------------------------------------- |
| Critical | Exposes data or credentials, changes Claude Code files or sessions, or loses data |
| High     | A requirement fails, or the dashboard gives a wrong answer with no warning        |
| Medium   | A requirement works with a noticeable problem, and a workaround exists            |
| Low      | Cosmetic, or unlikely to affect use                                               |

## Test levels

| Level       | Tool                                      | Runs                    |
| ----------- | ----------------------------------------- | ----------------------- |
| Unit        | Vitest                                    | Every pull request      |
| Integration | Vitest with a real server                 | Every pull request      |
| Browser     | Playwright with axe                       | Every pull request      |
| Live        | Real Claude Code sessions                 | Each release, agent-led |
| Manual      | Keyboard by automation, NVDA by the owner | Each release            |

## How checks are approved

A runner agent performs the live checks and records evidence. A separate verifier agent audits that evidence and runs its own checks. A check passes when both agree. See [0011](decisions/0011-testing-bug-fixes.md).

Results below are from `main` at `b0ed97a` on 2026-11-06, before the fixes in decision 0011. Re-run after fixes where noted.

## Requirements coverage

| ID    | Automated                                      | Live or manual check | Status                                                                     |
| ----- | ---------------------------------------------- | -------------------- | -------------------------------------------------------------------------- |
| FR-1  | `poller`, `schema`, `dashboard` tests          | L1                   | Passing                                                                    |
| FR-2  | `tracker`, `store` tests                       | L3, L4               | Passing, amended by decision 0012                                          |
| FR-3  | `schema`, `store`, `dashboard` tests           | L1, L4               | Re-check due, stored names changed. See BUG-18.                            |
| FR-4  | `format`, `dashboard` tests                    | L1                   | Passing                                                                    |
| FR-5  | `rules`, `dashboard` tests                     | L2                   | Passing                                                                    |
| FR-6  | `transcripts`, `store`, `dashboard` tests      | L1                   | Fix for BUG-1 awaiting re-check. A real branch name hasn't been seen live. |
| FR-7  | `session-groups`, `dashboard` tests            | L2                   | Passing                                                                    |
| FR-8  | `session-groups`, `dashboard` tests            | L2                   | Passing                                                                    |
| FR-9  | `dashboard` test, load measurement             | L2, L3               | Passing                                                                    |
| FR-10 | `announcements`, `dashboard` tests             | M2                   | Automated tests pass, needs M2                                             |
| C-1   | `store` tests                                  | L5                   | Passing                                                                    |
| C-2   | Permission-model run, no automated test        | L5                   | Passing                                                                    |
| C-3   | Permission-model run, no automated test        | L5                   | Passing                                                                    |
| C-4   | `schema`, `store`, `transcripts` tests         | L5                   | Passing                                                                    |
| C-5   | Code review, no automated test                 | L5                   | Passing                                                                    |
| C-6   | CI on Windows                                  | Not needed           | Passing                                                                    |
| C-7   | `store` tests                                  | L5                   | Fix for BUG-2 awaiting re-check                                            |
| NFR-1 | `server` test                                  | L5                   | Passing, no test from a second device                                      |
| NFR-2 | `server`, `dashboard` tests                    | L5                   | Passing, see BUG-8                                                         |
| NFR-3 | `server`, `dashboard` tests                    | L5                   | Passing for the tool's own process and page                                |
| NFR-4 | `schema`, `poller`, `store`, `dashboard` tests | Not needed           | Passing                                                                    |
| NFR-5 | axe scans, 320 px and keyboard tests           | M1, M2               | M1 passing, M2 not run                                                     |

## Live checks

These use real sessions in throwaway folders. `claude --bg` refuses an untrusted folder, so L2 needs a folder under a location the user already trusts.

| ID  | Check                                                                                     | Expected                                                                                    | Result                                                                                                             |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| L1  | Run the dashboard with real sessions                                                      | Name, project, kind, status, times, branch, and model are correct                           | Passed except branch, see BUG-1                                                                                    |
| L2  | Trigger a real permission prompt                                                          | Within 5 seconds, the session is under Needs you with its reason, and the title count rises | Passed for a background session. Raw values: `status: waiting`, `state: blocked`, `waitingFor: permission prompt`. |
| L3  | End an interactive session while the dashboard runs                                       | It moves to Finished with an approximate end time                                           | Passed, using a force-kill and no transcript                                                                       |
| L4  | Restart the tool                                                                          | The finished session is still listed                                                        | Passed, including a hard kill with a simulated CLI                                                                 |
| L5  | Review the running tool: listening address, data folder, and files changed in `~/.claude` | Loopback only, no message text stored, and the tool changes nothing in `~/.claude`          | Passed under Node's permission model, except BUG-2                                                                 |

Not yet seen live: a permission prompt in an interactive session, a normal interactive exit, and a session started in an existing repository.

## Manual checks

| ID  | Check                                                                 | Expected                                                                                    | Result                                    |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------- |
| M1  | Use the page with only the keyboard: Tab, Shift+Tab, Enter, and Space | Every control can be reached and used, and focus is always visible                          | Passed by automation in headless Chromium |
| M2  | With NVDA, follow the script below                                    | Headings, counts, reasons, and expanded state are announced, and new attention is announced | Not run, needs the owner                  |

### M2 script

1. Start NVDA, then start the tool and open its page in your browser.
2. Press `Insert+Down Arrow` to read the page from the top. Check that groups, counts, names, and reasons make sense.
3. Press `Insert+F7` and choose Headings. Check that each group is listed.
4. Press `Tab` to reach the Stale section, if shown, and press `Enter`. Check that its expanded state is announced.
5. With the page open, make a session hit a permission prompt. Check that NVDA says the session needs you, with its reason, without you moving focus.

## Performance

One `claude agents --json --all` run used about 353 ms of CPU, averaged over 12 runs on an 8-core Windows PC on 2026-11-06. This excludes the shell wrapper and transcript reads. At the 3-second interval, that is about 10.5% of one core, or about 1.3% of the whole PC.

Across 6 measured live changes, the slowest upper bound was 2309 ms. Across 94 polls, the poll cycle had a median of 3392 ms and a maximum of 3531 ms. The strict worst case is about 4.1 seconds: run, interval, run, and delivery. FR-9 is at risk once one run takes more than about 950 ms. This wasn't measured under heavy load.

## Bugs

| ID     | Severity          | Bug                                                                                                                                                                             | Status                                                                                                                                                                                             |
| ------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BUG-1  | High              | Branch shows `HEAD`, with no warning                                                                                                                                            | Fixed by decision 0011, merged in pull request 10, live re-check due                                                                                                                               |
| BUG-2  | High              | Prompt text used as `name` is stored                                                                                                                                            | Fixed by decision 0011, merged in pull request 10, live re-check due                                                                                                                               |
| BUG-3  | High, provisional | New sessions under Needs you reach no live region                                                                                                                               | Fixed by decision 0011, needs M2                                                                                                                                                                   |
| BUG-4  | Medium            | A background session's Finished row disappears when the CLI stops listing it                                                                                                    | Closed: FR-2 amended by decision 0012                                                                                                                                                              |
| BUG-5  | Medium            | False warning when a new interactive session's first listing has no `status`                                                                                                    | Fixed: a missing `status` is excused for a session not listed in the previous successful poll. How long a real first listing stays incomplete hasn't been measured, so this needs a live re-check. |
| BUG-6  | Low               | Rows move within Active when activity times change or appear                                                                                                                    | Open                                                                                                                                                                                               |
| BUG-7  | Low               | Sessions with an inherited `CLAUDE_CODE_CHILD_SESSION` weren't listed by the CLI in one observation, and the docs don't say so                                                  | Open, unconfirmed by the verifier                                                                                                                                                                  |
| BUG-8  | Low               | The login token prints to stdout when no browser opens, and the docs don't mention this                                                                                         | Open                                                                                                                                                                                               |
| BUG-9  | Low               | No signal that data is stale while the CLI is slow, for up to 15 seconds                                                                                                        | Open, from code reading                                                                                                                                                                            |
| BUG-10 | Low               | Screen-reader noise: triangles, dots, and name and reason run together                                                                                                          | Open, from substitute evidence                                                                                                                                                                     |
| BUG-11 | Low               | Focus falls to the page body when the focused expandable section disappears                                                                                                     | Open                                                                                                                                                                                               |
| BUG-12 | Low               | A corrupt older file is set aside with any names still inside                                                                                                                   | Open                                                                                                                                                                                               |
| BUG-13 | Low               | A stale session that loses its activity time moves to Needs you and is announced                                                                                                | Open                                                                                                                                                                                               |
| BUG-14 | Low               | A second session with no ID and no name isn't announced separately                                                                                                              | Open                                                                                                                                                                                               |
| BUG-15 | Medium            | Shutting down could hang forever with a half-open connection, found through a CI timeout                                                                                        | Fixed in the same pull request                                                                                                                                                                     |
| BUG-16 | Low               | An announcement can be lost if a second update arrives within 100 ms, which the 3-second poll can't produce except around a reconnect                                           | Open                                                                                                                                                                                               |
| BUG-17 | Low               | After a failed first poll, the page says it is showing last known data and also "No sessions to show"                                                                           | Open                                                                                                                                                                                               |
| BUG-18 | Low               | A new interactive session whose first listing has no `status` reads `unknown` for that one refresh                                                                              | Open                                                                                                                                                                                               |
| BUG-19 | Low               | The `status` excuse also covers existing sessions on the tool's first poll, and a session that flaps in and out of the list or changes its ID each poll could avoid the warning | Open                                                                                                                                                                                               |
| BUG-20 | Low               | A session listed first with no ID and no status warns, and is then excused once it gets an ID                                                                                   | Open                                                                                                                                                                                               |
