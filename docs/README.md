# cc-session-manager docs

SDLC records for cc-session-manager, a tool for managing and monitoring Claude Code sessions.

## Current phase

**Iteration 3, Phase 5: Testing.** 0.1.0 is released ([0017](decisions/0017-first-release.md)). Iteration 3 covers cost and token use, bug fixes, L10, and screen-reader testing, for release as 0.2.0 ([0018](decisions/0018-iteration-3-plan.md)). Requirements are signed off ([0019](decisions/0019-iteration-3-requirements.md)), and so is the design ([0020](decisions/0020-iteration-3-design.md)). Implementation steps 1 to 9 are merged, and Testing is under way: see the [test plan](test-plan.md#iteration-3).

## How these docs work

- Living documents describe what is true today. Git keeps their history.
- Decision records capture why a choice was made. To change a decision, add a new record that supersedes the old one.

## Living documents

| Document                               | Status                                                             |
| -------------------------------------- | ------------------------------------------------------------------ |
| [`requirements.md`](requirements.md)   | Signed off for iteration 3                                         |
| [`design.md`](design.md)               | Signed off for iteration 3                                         |
| [`test-plan.md`](test-plan.md)         | Exit criteria met for iteration 2; iteration 3 Testing in progress |
| [`release-notes.md`](release-notes.md) | 0.1.0                                                              |

## Decision log

| ID                                                      | Decision                                            | Status                    |
| ------------------------------------------------------- | --------------------------------------------------- | ------------------------- |
| [0001](decisions/0001-sdlc-model.md)                    | Follow an iterative SDLC                            | Accepted                  |
| [0002](decisions/0002-product-direction.md)             | Build a new open-source thin layer                  | Accepted, amended by 0006 |
| [0003](decisions/0003-first-iteration-and-platforms.md) | Start with read-only live monitoring, Windows first | Accepted, amended by 0014 |
| [0004](decisions/0004-provisional-stack.md)             | Local web dashboard in TypeScript on Node           | Accepted                  |
| [0005](decisions/0005-project-setup.md)                 | Name, license, repository timing, docs layout       | Accepted                  |
| [0006](decisions/0006-transcript-metadata.md)           | Allow transcript metadata for session activity      | Accepted                  |
| [0007](decisions/0007-iteration-1-architecture.md)      | Iteration 1 architecture                            | Accepted                  |
| [0008](decisions/0008-development-setup.md)             | Development setup                                   | Accepted                  |
| [0009](decisions/0009-dashboard-ui.md)                  | Dashboard UI                                        | Accepted                  |
| [0010](decisions/0010-style-nonce.md)                   | Per-run style nonce                                 | Accepted                  |
| [0011](decisions/0011-testing-bug-fixes.md)             | Fixes for High bugs found in testing                | Accepted                  |
| [0012](decisions/0012-agent-approved-merges.md)         | Agent-approved merges and BUG-4                     | Accepted                  |
| [0013](decisions/0013-release-without-wcag-claim.md)    | Release without a WCAG claim                        | Accepted, amended by 0018 |
| [0014](decisions/0014-iteration-2-scope.md)             | Iteration 2 scope                                   | Accepted                  |
| [0015](decisions/0015-iteration-2-design.md)            | Iteration 2 design choices                          | Accepted                  |
| [0016](decisions/0016-defer-l10.md)                     | Defer L10 and close iteration 2 testing             | Accepted, amended by 0018 |
| [0017](decisions/0017-first-release.md)                 | First release, 0.1.0                                | Accepted                  |
| [0018](decisions/0018-iteration-3-plan.md)              | Plan for iterations 3 to 5, and iteration 3 scope   | Accepted                  |
| [0019](decisions/0019-iteration-3-requirements.md)      | Iteration 3 requirements choices                    | Accepted                  |
| [0020](decisions/0020-iteration-3-design.md)            | Iteration 3 design choices                          | Accepted                  |
