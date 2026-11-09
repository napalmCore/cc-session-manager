# 0019: Iteration 3 requirements choices

- **Status:** Accepted
- **Date:** 2026-11-09
- **Builds on:** [0018](0018-iteration-3-plan.md)
- **Amends:** C-1 and FR-2 in [requirements.md](../requirements.md)

## Context

Decision 0018 set iteration 3's scope. The requirements left questions where the answer changes what the owner sees, and these went to the owner.

## The owner's decisions

| Area                                 | Options considered                                                                  | Decision                                                                   | Requirement |
| ------------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------- |
| Subagents' usage                     | Include and show the split, include as one total, main session only                 | Include, and show how much came from subagents                             | FR-23       |
| Usage after a restart                | Save it in the store, re-read transcripts, live sessions only                       | Save usage in the store, as numbers only                                   | FR-26       |
| A model not in the price table       | Show tokens with the cost unavailable, use the closest known price                  | Show tokens, with the cost unavailable                                     | FR-24       |
| When to offer leftover programs      | After Stop, Delete, and End; after Stop and Delete only; any session at any time    | After Stop, Delete, and End                                                | FR-27       |
| Leftover programs after Force end    | Include Force end, only Stop, Delete, and End (asked after review)                  | Include Force end                                                          | FR-27       |
| Where the offer appears after Delete | Keep a Deleted row, a separate section, not after Delete (asked after review)       | Keep the row, marked Deleted, while the programs run, not across a restart | FR-2, FR-27 |
| How long the offer stays             | While the programs run, 2 minutes                                                   | While any of them runs                                                     | FR-27       |
| BUG-8, the printed link              | A short-lived link, never print it, print only with a flag                          | Print a single-use link that expires after 2 minutes                       | FR-29       |
| BUG-12, a corrupt store              | Scrub then set aside, delete it, keep as is                                         | Remove names and set it aside; delete it if it can't be read               | FR-30       |
| BUG-6, Active order                  | Stable by start time, activity order with less movement, a sort control on the page | Start time, newest first                                                   | FR-28       |
| CPU budget for usage reading         | At most 1.5 times today, at most 1.2 times today, no fixed limit                    | At most 1.5 times the iteration 1 figure                                   | NFR-11      |
| Requirements sign-off                | Agent review then sign off, the owner reads first                                   | An independent agent reviews; merging after CI passes signs off            |             |

## Additions by the author

These follow from the choices above and weren't put to the owner as options:

- The cost label states the price table's date, and says it isn't what a Pro or Max subscription costs (FR-24).
- Totals say how many sessions they leave out when a cost is unavailable (FR-25).
- The store also keeps model IDs and the splits FR-23 and FR-24 need (token type, cache-write duration, model, main or subagent), so the figures can be rebuilt after a restart (FR-26). C-7 allows this, because none of it is a name.
- Entries Claude Code writes without calling a model, such as `<synthetic>`, are left out of usage (FR-24).
- Leftover programs never include the tool's own processes, nor anything belonging to a protected session (FR-27). Each is identity-checked immediately before it's ended (C-14). The request names a session, not process IDs, the server refuses it for a protected session, and C-9 applies (NFR-13).
- C-1 now allows ending processes for FR-27, and FR-2 allows the Deleted row.
- Active ties are broken by session ID (FR-28). At most one scrubbed copy of a corrupt store is kept (FR-30).
- NFR-11 sets the first-read test at 50 MB of transcripts in total, and NFR-12 defines a High screen-reader finding.
- The bugs not covered by their own requirement are fixed with a test each. One that can't be reproduced, comes from Claude Code's own output, or needs a behaviour change goes back to the owner (FR-31).

## Consequences

- The store gains numeric usage fields, so older versions reading a newer store must ignore them. Design checks this.
- Finding a stopped background session's programs may not be possible (U-16). If so, FR-27 goes back to the owner with options.
