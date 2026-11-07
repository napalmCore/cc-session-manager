# 0014: Iteration 2 scope

- **Status:** Accepted
- **Date:** 2026-11-06
- **Amends:** the read-only limit in [0003](0003-first-iteration-and-platforms.md), and C-1 in [requirements.md](../requirements.md)

## Context

After iteration 1 passed testing, the owner chose to build more before the first release. The read-only dashboard shows who needs the user, but its alerts are easy to miss and it can't act on a session.

The CLI has commands to stop, delete, and attach to background sessions, and to resume a session by ID. It has no command to stop an interactive session. Per the docs, plain `claude rm` removes a worktree Claude created when that's safe, and keeps the session when it has uncommitted changes, unconfirmed commits, or a worktree in use or locked.

## The owner's decisions

| Area                              | Options considered                                                             | Decision                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Iteration 2 scope                 | Desktop notifications, session control, history and analytics, interaction     | Desktop notifications and session control                                                                           |
| First release                     | After iteration 2, tag iteration 1 privately, release iteration 1 first        | No owner preference, so the recommended default applies: release after iteration 2                                  |
| Notification delivery             | Browser, native Windows, both                                                  | Browser notifications                                                                                               |
| Notification events               | A session needs the user, a session finishes, something goes wrong             | All three                                                                                                           |
| Which finishes notify             | Background only, all finished, background plus interactive crashes             | Background sessions only                                                                                            |
| The user's own actions            | Stay quiet, notify anyway                                                      | Stay quiet                                                                                                          |
| Notification content              | Project folder and reason, session name and reason, generic message            | Project folder and reason                                                                                           |
| Notification limits               | Once per event and grouped, every event separately, remind until handled       | Once per event and grouped, with a failure to read sessions alerting once until it recovers                         |
| Clicking a notification           | Bring up the dashboard, nothing                                                | Bring up the dashboard and highlight the row                                                                        |
| Actions                           | Open or resume, stop background, delete background, end interactive            | All four                                                                                                            |
| Confirmation                      | Confirm risky actions, confirm every action, stronger for delete, none         | Confirm risky actions: Stop and Delete have a dialog, and Open runs straight away                                   |
| Opening a terminal                | Windows Terminal then console, always console, copy the command only           | Windows Terminal, otherwise a standard console                                                                      |
| Live interactive session's row    | Show where it is, try to focus its window, leave as written                    | Show its project folder and process ID                                                                              |
| Ending an interactive session     | Normal close then offer force, force only, remove the action                   | Normal close first, then offer a second confirmed force, after checking the process ID still belongs to the session |
| If no normal close is reliable    | Keep End as Force, remove End, decide then                                     | Keep End as a confirmed Force end                                                                                   |
| The session that started the tool | Refuse, allow with a stronger warning                                          | Refuse                                                                                                              |
| A delete the CLI refuses          | Explain with no force, show the CLI's suggestion, offer force in the dashboard | Explain in the tool's own words, with no force                                                                      |

The owner chose to include ending an interactive session after being told that it's an unsupported route and can lose work in progress.

## Additions by the author and reviewers

These weren't options put to the owner. They follow from the choices above, and the owner has been told about them:

- End counts as a risky action, so it has a confirmation dialog.
- Stop, Delete, and End are blocked on a failed or old listing, and the server rechecks a session when it acts (C-9).
- Programs are never looked up in a session's folder (C-11), which is what makes an unconfirmed Open safe.
- The tool never passes `claude rm`'s forcing flags (C-8), and the server enforces the action rules (NFR-6, NFR-7, NFR-10).
- A security review is required before release (NFR-9).
- "Something goes wrong" means a session failing or the tool being unable to read sessions. A format-change warning doesn't notify.
- Starting, renaming, and forking sessions are out of scope.

## Consequences

- The dashboard is no longer read-only, so a flaw in its access controls could now change or end sessions, not only reveal them.
- Browser notifications only arrive while the dashboard page is open, though it can be in the background.
- Notifications don't show session names, so similar sessions in one folder look alike.
- A crashed interactive session sends no notification.
- A notification about a live interactive session leads to its row, not its terminal.
- Ending a session can lose work in progress, and may have to be a Force end. A refused delete has to be finished in the CLI.
- Opening a terminal is Windows-specific for now, so macOS and Linux need their own handling later.
- History, analytics, and interaction stay for later iterations.
