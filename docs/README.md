# cc-session-manager docs

SDLC records for cc-session-manager, a tool for managing and monitoring Claude Code sessions.

## Current phase

**Iteration 5, Phase 6: Release.** 0.1.0, 0.2.0, and 0.3.0 are released ([0017](decisions/0017-first-release.md)), and the repository is public. Iteration 5, for 0.4.0, covers upkeep for the public repository, the open bugs, sending messages to background sessions that aren't running, and plain labels for waiting sessions, with no answering of prompts ([0027](decisions/0027-iteration-5-plan.md), [0028](decisions/0028-iteration-5-requirements.md), [0029](decisions/0029-iteration-5-design.md)). Implementation steps 1 to 5 are merged, and Testing is closed by the owner: see the [test plan](test-plan.md#iteration-5). 0.4.0 is being released as 0.3.0 was: a `v0.4.0` tag and a GitHub release. Iteration 6, for 0.5.0, covers macOS and Linux.

## How these docs work

- Living documents describe what is true today. Git keeps their history.
- Decision records capture why a choice was made. To change a decision, add a new record that supersedes the old one.

## Living documents

| Document                               | Status                                   |
| -------------------------------------- | ---------------------------------------- |
| [`requirements.md`](requirements.md)   | Signed off for iteration 3               |
| [`design.md`](design.md)               | Signed off for iteration 3               |
| [`test-plan.md`](test-plan.md)         | Exit criteria met for iterations 2 and 3 |
| [`release-notes.md`](release-notes.md) | 0.4.0, 0.3.0, 0.2.0, and 0.1.0           |

## Decision log

| ID                                                      | Decision                                            | Status                                    |
| ------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------- |
| [0001](decisions/0001-sdlc-model.md)                    | Follow an iterative SDLC                            | Accepted                                  |
| [0002](decisions/0002-product-direction.md)             | Build a new open-source thin layer                  | Accepted, amended by 0006                 |
| [0003](decisions/0003-first-iteration-and-platforms.md) | Start with read-only live monitoring, Windows first | Accepted, amended by 0014                 |
| [0004](decisions/0004-provisional-stack.md)             | Local web dashboard in TypeScript on Node           | Accepted                                  |
| [0005](decisions/0005-project-setup.md)                 | Name, license, repository timing, docs layout       | Accepted                                  |
| [0006](decisions/0006-transcript-metadata.md)           | Allow transcript metadata for session activity      | Accepted                                  |
| [0007](decisions/0007-iteration-1-architecture.md)      | Iteration 1 architecture                            | Accepted                                  |
| [0008](decisions/0008-development-setup.md)             | Development setup                                   | Accepted                                  |
| [0009](decisions/0009-dashboard-ui.md)                  | Dashboard UI                                        | Accepted                                  |
| [0010](decisions/0010-style-nonce.md)                   | Per-run style nonce                                 | Accepted                                  |
| [0011](decisions/0011-testing-bug-fixes.md)             | Fixes for High bugs found in testing                | Accepted                                  |
| [0012](decisions/0012-agent-approved-merges.md)         | Agent-approved merges and BUG-4                     | Accepted                                  |
| [0013](decisions/0013-release-without-wcag-claim.md)    | Release without a WCAG claim                        | Accepted, amended by 0018                 |
| [0014](decisions/0014-iteration-2-scope.md)             | Iteration 2 scope                                   | Accepted                                  |
| [0015](decisions/0015-iteration-2-design.md)            | Iteration 2 design choices                          | Accepted                                  |
| [0016](decisions/0016-defer-l10.md)                     | Defer L10 and close iteration 2 testing             | Accepted, amended by 0018                 |
| [0017](decisions/0017-first-release.md)                 | First release, 0.1.0                                | Accepted                                  |
| [0018](decisions/0018-iteration-3-plan.md)              | Plan for iterations 3 to 5, and iteration 3 scope   | Accepted, amended by 0021, 0022, and 0023 |
| [0019](decisions/0019-iteration-3-requirements.md)      | Iteration 3 requirements choices                    | Accepted                                  |
| [0020](decisions/0020-iteration-3-design.md)            | Iteration 3 design choices                          | Accepted                                  |
| [0021](decisions/0021-drop-nvda-testing.md)             | Drop screen-reader testing with NVDA                | Accepted                                  |
| [0022](decisions/0022-skip-l10-iteration-3.md)          | Skip L10 in iteration 3                             | Accepted                                  |
| [0023](decisions/0023-iteration-4-plan.md)              | Close iteration 3, and iteration 4 scope            | Accepted                                  |
| [0024](decisions/0024-iteration-4-requirements.md)      | Iteration 4 requirements choices                    | Accepted                                  |
| [0025](decisions/0025-iteration-4-design.md)            | Iteration 4 design choices                          | Accepted                                  |
| [0026](decisions/0026-iteration-4-page.md)              | How the iteration 4 page works                      | Accepted                                  |
| [0027](decisions/0027-iteration-5-plan.md)              | Close iteration 4, and iterations 5 and 6 scope     | Accepted                                  |
| [0028](decisions/0028-iteration-5-requirements.md)      | Iteration 5 requirements choices                    | Accepted                                  |
| [0029](decisions/0029-iteration-5-design.md)            | Iteration 5 design choices                          | Accepted                                  |
