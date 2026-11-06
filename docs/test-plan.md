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

| Level       | Tool                      | Runs                    |
| ----------- | ------------------------- | ----------------------- |
| Unit        | Vitest                    | Every pull request      |
| Integration | Vitest with a real server | Every pull request      |
| Browser     | Playwright with axe       | Every pull request      |
| Live        | Real Claude Code sessions | Each release, owner-led |
| Manual      | Keyboard and NVDA         | Each release, owner-led |

## Requirements coverage

Automated results are from 2026-11-06: 136 unit and integration tests and 24 browser tests passed.

| ID    | Automated                                      | Live or manual check | Status           |
| ----- | ---------------------------------------------- | -------------------- | ---------------- |
| FR-1  | `poller`, `schema`, `dashboard` tests          | L1                   | Live check due   |
| FR-2  | `tracker`, `store` tests                       | L3, L4               | Live check due   |
| FR-3  | `schema`, `dashboard` tests                    | L1                   | Live check due   |
| FR-4  | `format`, `dashboard` tests                    | L1                   | Live check due   |
| FR-5  | `rules`, `dashboard` tests                     | L2                   | Live check due   |
| FR-6  | `transcripts`, `dashboard` tests               | L1                   | Live check due   |
| FR-7  | `session-groups`, `dashboard` tests            | L2                   | Live check due   |
| FR-8  | `session-groups`, `dashboard` tests            | L2                   | Live check due   |
| FR-9  | `dashboard` test, load measurement             | L2                   | Live check due   |
| C-1   | `store` tests                                  | L5                   | Live check due   |
| C-2   | Not automated: no code path opens these files  | L5                   | Live check due   |
| C-3   | Not automated: no code path opens this folder  | L5                   | Live check due   |
| C-4   | `schema`, `store`, `transcripts` tests         | L5                   | Live check due   |
| C-5   | Not automated: no hook code exists             | L5                   | Live check due   |
| C-6   | CI on Windows                                  | Not needed           | Passing          |
| NFR-1 | `server` test                                  | L5                   | Live check due   |
| NFR-2 | `server`, `dashboard` tests                    | L5                   | Live check due   |
| NFR-3 | `server`, `dashboard` tests                    | Not needed           | Passing          |
| NFR-4 | `schema`, `poller`, `store`, `dashboard` tests | Not needed           | Passing          |
| NFR-5 | axe scans, 320 px and keyboard tests           | M1, M2               | Manual check due |

## Live checks

These use real sessions in a throwaway folder. Each step is approved by the owner before it runs.

| ID  | Check                                                                                     | Expected                                                                                    | Result  |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------- |
| L1  | Run the dashboard with real sessions                                                      | Name, project, kind, status, times, branch, and model are correct                           | Not run |
| L2  | Trigger a real permission prompt                                                          | Within 5 seconds, the session is under Needs you with its reason, and the title count rises | Not run |
| L3  | End an interactive session while the dashboard runs                                       | It moves to Finished with an approximate end time                                           | Not run |
| L4  | Restart the tool                                                                          | The finished session is still listed                                                        | Not run |
| L5  | Review the running tool: listening address, data folder, and files changed in `~/.claude` | Loopback only, no message text stored, and the tool changes nothing in `~/.claude`          | Not run |

## Manual checks

| ID  | Check                                                                                                                        | Expected                                                                           | Result  |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------- |
| M1  | Use the page with only the keyboard: Tab, Shift+Tab, Enter, and Space                                                        | Every control can be reached and used, and focus is always visible                 | Not run |
| M2  | With NVDA: read the page, list headings (`Insert+F7`), expand Stale, and watch for a change in status while the page is open | Headings, counts, reasons, and expanded state are announced, and alerts are spoken | Not run |

## Performance

One `claude agents --json --all` run used about 353 ms of CPU, averaged over 12 runs on an 8-core Windows PC on 2026-11-06. This excludes the shell wrapper and transcript reads. At the chosen 3-second interval, that is about 10.5% of one core, or about 1.3% of the whole PC, with changes visible within about 3.5 seconds.

## Bugs

None open.
