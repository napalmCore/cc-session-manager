# 0024: Iteration 4 requirements choices

- **Status:** Accepted
- **Date:** 2026-11-13
- **Builds on:** [0023](0023-iteration-4-plan.md)
- **Amends:** C-1 in [requirements.md](../requirements.md), for Start and Fork, and C-4 and C-12, for search only (C-16)

## Context

Decision 0023 set iteration 4's scope: starting sessions, forking, a history of past sessions, and search inside conversations, with names set only at start. These questions change what the owner sees, so they went to the owner.

## The owner's decisions

| Area                                                    | Options considered                                                                          | Decision                                                                    | Requirement   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------- |
| Search and message text                                 | Read on demand and keep nothing; an index in memory while running; matches without snippets | Read on demand when searching, show short snippets, keep nothing afterwards | FR-36, C-16   |
| What search covers                                      | Prompts and replies; everything, including tool output and subagents; prompts only          | Prompts and Claude's replies in main transcripts                            | FR-36, C-16   |
| How far History reaches                                 | Every transcript on disk; the last 30 days; a date filter                                   | Every transcript still on disk                                              | FR-35         |
| Kinds of start                                          | Background and interactive; background only; interactive only                               | Both                                                                        | FR-32         |
| Folders for start                                       | Any folder; only folders of existing sessions                                               | Any existing folder, typed or picked                                        | FR-32         |
| What can be forked                                      | Any session, either kind; finished only; interactive forks only                             | Any session with a session ID, as background or interactive                 | FR-33         |
| Permission modes                                        | Claude Code's defaults only; a choice of modes; any mode, including bypass                  | Defaults only: no permission flags                                          | C-15          |
| Confirmation                                            | The form is the confirmation; the form and a dialog                                         | The form is the confirmation                                                | FR-32, FR-33  |
| Renaming                                                | Name at start only; dashboard-only labels; no renaming (decision 0023)                      | Name at start or fork, through `-n`                                         | FR-34         |
| Search: thinking and inserted text (asked after review) | Leave both out; include thinking; include both                                              | Leave both out                                                              | FR-36         |
| Network shares for Start (asked after review)           | Local folders only; include network shares                                                  | Local folders only                                                          | FR-32, NFR-14 |
| Fork of the protected session (asked after review)      | Allow it; block it as for Stop, Delete, and End                                             | Allow it, because the original isn't changed                                | FR-33         |
| Requirements sign-off                                   | As in 0019                                                                                  | An independent agent reviews, and merging after CI passes signs off (0019)  |               |

## Additions by the author

These fill gaps the questions didn't cover. The owner can change any of them during review.

- **History shows no names** (FR-35). Names for sessions Claude Code no longer lists aren't read from transcripts, as for finished sessions after a restart. This keeps C-7.
- **Search limits** (FR-36, NFR-15): case-insensitive plain-text matching, up to three snippets of at most 160 characters per session, a progress display, cancelling, and a 30-second stop with partial results.
- **History paging** (FR-35): 50 sessions a page, and the first page within 5 seconds.
- **Input limits** (NFR-14): a prompt of at most 8,000 characters, below Windows' 32,767-character command line; a name of at most 100 characters; no control characters in a name or folder.
- **Options before `--`** (C-15), so a prompt or name that starts with `-` can't be read as an option, and `--fork-session` is always passed for a fork (FR-33).
- **One Start at a time**, a disabled button while it runs, and no automatic retries (FR-32, NFR-14), because each extra start is another session using tokens.
- **Prompts and names aren't stored or logged** (C-18), and search text isn't logged or put in the page address (C-16).
- **Interactive results** follow FR-18's Open rule: success means the terminal launched (FR-32, FR-33).
- **NFR-16**: the new forms, History, and search meet NFR-8.
- **Fork's folder** (FR-33): a fork runs in the original session's folder, because `--resume` finds a session by its folder, and Fork isn't offered once that folder has gone.
- **C-17** carries C-13 forward: the only prompts the tool sends are the starting prompts of sessions the user starts or forks.

## Consequences

- C-4 and C-12 still hold for everything except search. Search reads message text only while it runs (C-16), and the release notes must say so.
- Start and Fork are new actions that start work, so they're guarded like the existing ones (NFR-14), and they never pass permission flags (C-15).
- Design resolves U-20 to U-24 before Implementation.
