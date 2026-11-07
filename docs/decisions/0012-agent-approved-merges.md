# 0012: Agent-approved merges and BUG-4

- **Status:** Accepted
- **Date:** 2026-11-06
- **Amends:** the review row in [0008](0008-development-setup.md), and FR-2 in [requirements.md](../requirements.md)

## Decisions

| Area                                                | Options considered                                                                                           | Decision                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Merging                                             | Merge when agents approve, the owner keeps merging, agents for docs and tests only                           | Merge when CI passes and an independent agent approves                |
| BUG-4: finished session removed from the CLI's list | Amend FR-2, keep rows for 24 hours, ship as a known issue                                                    | Amend FR-2, so a session the CLI no longer lists leaves the dashboard |
| BUG-5: false warning on a new session               | Fix before release by warning only if the status is still missing on the next refresh, ship as a known issue | Fix before release                                                    |

## Consequences

- The agent that reviews a change must not be the one that wrote it. All pull requests come from the owner's GitHub account, which GitHub won't let approve its own pull request, so the reviewer's verdict is posted as a comment. The owner sees changes after they merge, and can revert them.
- Making the repository public, and product decisions, stay with the owner.
- Deleting a finished background session with `claude rm` also removes it from the dashboard.
- A missing `status` raises no warning for an identified session not listed in the previous successful poll, and warns if it's still missing on the next poll. This also covers existing sessions on the tool's first poll. Beyond the choice as worded, a session that keeps leaving the list or changes its ID can avoid the warning (BUG-19). A known session that loses its status warns at once rather than waiting. Every other parsing problem warns at once.
- If the CLI ever prunes completed sessions by itself within 24 hours, they would leave the dashboard early. This hasn't been confirmed either way.
