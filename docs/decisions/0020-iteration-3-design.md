# 0020: Iteration 3 design choices

- **Status:** Accepted
- **Date:** 2026-11-09
- **Builds on:** [0019](0019-iteration-3-requirements.md)

## Context

Design research answered U-16 to U-19 (see the iteration 3 section of [design.md](../design.md)). Leftover programs can be identified reliably only from a record taken just before the tool's own action. The remaining choices change what the owner sees, or the tool's security surface, so they went to the owner.

## The owner's decisions

| Area                                      | Options considered                                                                                                                              | Decision                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| How to find leftover programs (U-16)      | Record before the tool's own actions; also record on every poll; also track them in a job the tool owns; also list possible leftovers by folder | Record before the tool's own actions                       |
| Reading other processes' environment      | No; yes, to match the session ID                                                                                                                | No                                                         |
| If recording fails or times out           | Act anyway and say so; refuse the action                                                                                                        | Act anyway, and the result says leftovers can't be checked |
| BUG-9, stale data                         | A status line after 10 seconds; an always-visible timestamp; both                                                                               | A status line after 10 seconds                             |
| NVDA setup                                | A portable copy; a full install                                                                                                                 | A portable copy                                            |
| BUG-23, `claude -p` listed as interactive | Leave it and document it; detect it from the command line                                                                                       | Leave it and document it                                   |
| BUG-29, not reproduced                    | Add a guard test and keep it open; close it; launch through a helper                                                                            | Add a guard test, and keep it open                         |
| BUG-18, first listing with no status      | Show "Starting"; hide the row until it has a status                                                                                             | Show "Starting"                                            |
| Where a Deleted row appears               | Top of Finished; its own group; where the row was                                                                                               | Top of Finished                                            |

## Consequences

- Nothing is offered for a session stopped, deleted, or ended outside the dashboard, or while the tool is off. The release notes say so.
- Each Stop, Delete, End, and Force end takes about 1 second longer, for the record.
- Programs that leave the session's process tree and consoles aren't found. Without the environment scan, a few edge cases are missed, and no other process's memory is read.
- A failed record never blocks an action, so leftovers can occasionally go unchecked, and the page says when.
- BUG-23's `claude -p` half and BUG-29 stay open.
