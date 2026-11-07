# 0011: Fixes for High bugs found in testing

- **Status:** Accepted
- **Date:** 2026-11-06
- **Amends:** [0006](0006-transcript-metadata.md), FR-3 and FR-6 in [requirements.md](../requirements.md), and adds FR-10 and C-7

## Context

Independent agents ran the live checks and found three High bugs. See [test-plan.md](../test-plan.md).

## Decisions

| Bug                           | Options considered                                                                      | Decision                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| BUG-1: branch shows `HEAD`    | Treat `HEAD` as unavailable, read `.git/HEAD`, run git per folder, keep it and document | Show `HEAD` as "Branch unavailable"                                                                                                          |
| BUG-2: prompt text in `name`  | Don't store names, remove names everywhere, accept and document                         | Never store names, and document that live names can briefly show prompt text                                                                 |
| BUG-3: no screen-reader alert | Polite announcement, immediate alert, treat as not required                             | Polite announcement for sessions that newly need the user                                                                                    |
| M2: NVDA check                | Owner runs NVDA once, release without the claim, ask users to test                      | The owner runs a short NVDA script before release. Replaced by [0013](0013-release-without-wcag-claim.md), which releases without the claim. |

## Validation process

The owner asked on 2026-11-06 for live checks and validation to be run by independent agents, without asking the owner to confirm each step, and approved when the agents agree. Agents can't judge what a screen reader says, so M2 still needs a person. Product decisions and making the repository public stay with the owner.

## Consequences

- A real detached HEAD, or a repository created after a session started, shows as "Branch unavailable".
- Sessions that start in an existing repository show their branch name. This was seen live with `claude -p`, but not yet with a long-running interactive session.
- Finished sessions show as unnamed after a restart unless the CLI still lists them, and are identified by project folder.
- Live names, which come from the CLI, can still show prompt text on the page until a title is generated. Screen-reader announcements can read them too.
