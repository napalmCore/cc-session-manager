# 0014: Iteration 2 scope

- **Status:** Accepted
- **Date:** 2026-11-06
- **Amends:** the read-only limit in [0003](0003-first-iteration-and-platforms.md), and C-1 in [requirements.md](../requirements.md)

## Context

After iteration 1 passed testing, the owner chose to build more before the first release. The read-only dashboard shows who needs the user, but its alerts are easy to miss and it can't act on a session.

The CLI has commands to stop, delete, and attach to background sessions. It has no command to stop an interactive session, and deleting a background session can also remove its worktree, including uncommitted changes.

## Decisions

| Area                          | Options considered                                                         | Decision                                                                           |
| ----------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Iteration 2 scope             | Desktop notifications, session control, history and analytics, interaction | Desktop notifications and session control                                          |
| First release                 | After iteration 2, tag iteration 1 privately, release iteration 1 first    | No owner preference, so the recommended default applies: release after iteration 2 |
| Notification delivery         | Browser, native Windows, both                                              | Browser notifications                                                              |
| Notification events           | A session needs the user, a session finishes, something goes wrong         | All three                                                                          |
| Notification content          | Project folder and reason, session name and reason, generic message        | Project folder and reason                                                          |
| Notification limits           | Once per event and grouped, every event separately, remind until handled   | Once per event and grouped                                                         |
| Actions                       | Open or resume, stop background, delete background, end interactive        | All four                                                                           |
| Confirmation                  | Confirm risky actions, confirm every action, stronger for delete, none     | Confirm risky actions                                                              |
| Opening a terminal            | Windows Terminal then console, always console, copy the command only       | Windows Terminal, otherwise a standard console                                     |
| Ending an interactive session | Normal close then offer force, force only, remove the action               | Normal close first, then offer a second confirmed force                            |

The owner chose to include ending an interactive session after being told that it's an unsupported route and can lose work in progress.

## Consequences

- The dashboard is no longer read-only, so a flaw in its access controls could now change or end sessions, not only reveal them. This needs a security review before release.
- Browser notifications only arrive while the dashboard page is open, though it can be in the background.
- Notifications don't show session names, so similar sessions in one folder look alike.
- Deleting a session can lose work in its worktree, and ending one can lose work in progress. Confirmation dialogs must say so.
- Opening a terminal is Windows-specific for now, so macOS and Linux need their own handling later.
- History, analytics, and interaction stay for later iterations.
