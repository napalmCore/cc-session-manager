# cc-session-manager docs

SDLC records for cc-session-manager, a tool for managing and monitoring Claude Code sessions.

## Current phase

**Iteration 1, Phase 4: Implementation.** Planning, Requirements, and Design were signed off on 2026-11-06.

## How these docs work

- Living documents describe what is true today. Git keeps their history.
- Decision records capture why a choice was made. To change a decision, add a new record that supersedes the old one.

## Living documents

| Document                             | Status                     |
| ------------------------------------ | -------------------------- |
| [`requirements.md`](requirements.md) | Signed off for iteration 1 |
| [`design.md`](design.md)             | Signed off for iteration 1 |
| `test-plan.md`                       | Not started (Phase 5)      |

## Decision log

| ID                                                      | Decision                                            | Status                    |
| ------------------------------------------------------- | --------------------------------------------------- | ------------------------- |
| [0001](decisions/0001-sdlc-model.md)                    | Follow an iterative SDLC                            | Accepted                  |
| [0002](decisions/0002-product-direction.md)             | Build a new open-source thin layer                  | Accepted, amended by 0006 |
| [0003](decisions/0003-first-iteration-and-platforms.md) | Start with read-only live monitoring, Windows first | Accepted                  |
| [0004](decisions/0004-provisional-stack.md)             | Local web dashboard in TypeScript on Node           | Accepted                  |
| [0005](decisions/0005-project-setup.md)                 | Name, license, repository timing, docs layout       | Accepted                  |
| [0006](decisions/0006-transcript-metadata.md)           | Allow transcript metadata for session activity      | Accepted                  |
| [0007](decisions/0007-iteration-1-architecture.md)      | Iteration 1 architecture                            | Accepted                  |
| [0008](decisions/0008-development-setup.md)             | Development setup                                   | Accepted                  |
| [0009](decisions/0009-dashboard-ui.md)                  | Dashboard UI                                        | Accepted                  |
