# 0018: Plan for iterations 3 to 5, and iteration 3 scope

- **Status:** Accepted
- **Date:** 2026-11-09
- **Amends:** the screen-reader testing limit in [0013](0013-release-without-wcag-claim.md) and [0016](0016-defer-l10.md), and L10's deferral in [0016](0016-defer-l10.md)

## Context

0.1.0 is released. The owner was offered the features left out of iterations 1 and 2, and four quality items, and chose all eight:

- **Features:**
  - cost and token use
  - answering prompts and sending messages
  - history and search
  - starting, renaming, and forking sessions
- **Quality:**
  - fixing open bugs
  - the deferred live check L10
  - macOS and Linux support
  - screen-reader testing

Together they're about three times the size of iteration 2. Answering prompts and macOS and Linux support both need research before they can be estimated.

## The owner's decisions

| Area                          | Options considered                                                                                                      | Decision                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Staging                       | Three iterations with low risk first, three iterations with most value first, one big iteration, a research spike first | Three iterations, low risk first. See [Staging](#staging).          |
| What cost and token use shows | Tokens and an estimated cost, tokens only, tokens and a cost from prices the user sets                                  | Tokens and an estimated cost at API prices, labelled as an estimate |
| Where it appears              | Per session and totals, per session only, per session and daily totals                                                  | Each session's details, and totals for the listed sessions          |
| Which bugs to fix             | UI and accessibility, status and warnings, BUG-30, privacy and other bugs                                               | All four groups                                                     |
| BUG-30                        | Offer to end leftover programs after confirmation, show them only, end them automatically, leave as is                  | Offer to end them, after a confirmation that lists them             |
| Who runs screen-reader tests  | An agent with NVDA, the owner with a script, both                                                                       | An agent with NVDA                                                  |
| L10                           | The owner accepts one trust prompt during Testing, defer again                                                          | The owner accepts one trust prompt for a throwaway repository       |
| WCAG claim if NVDA tests pass | No claim and report the results, claim AA                                                                               | No claim. The release notes report what was tested and how.         |

## Staging

| Iteration | Release | Scope                                                                          |
| --------- | ------- | ------------------------------------------------------------------------------ |
| 3         | 0.2.0   | Cost and token use, bug fixes, L10, screen-reader testing with NVDA            |
| 4         | 0.3.0   | History and search, starting, renaming, and forking sessions                   |
| 5         | 0.4.0   | Answering prompts and sending messages after research, macOS and Linux support |

Iterations 4 and 5 are planned, not committed. Each gets its own Planning phase, and the owner can change them then.

## Iteration 3 bug groups

- **UI and accessibility:** BUG-6, BUG-10, BUG-11, BUG-16, BUG-17
- **Status and warnings:** BUG-9, BUG-13, BUG-18, BUG-19, BUG-20, BUG-24, BUG-26, BUG-27
- **BUG-30:** handled by the new leftover-programs action
- **Privacy and other bugs:** BUG-8, BUG-12, BUG-14, BUG-23, BUG-29

BUG-7 and BUG-22 are Claude Code's own behaviour and stay open. Requirements or Design may find a bug can't be fixed. If so, it goes back to the owner with options.

## Consequences

- Cost figures are estimates. On a Pro or Max subscription, they don't reflect what the user pays. The price table is in the tool, so it can go out of date, and the release notes must say so.
- Totals mean reading whole transcripts, not only the last 256 KB. Design must keep the polling cost within NFR limits, for example by reading new bytes only. C-4 still holds: only usage fields are kept, never message text.
- Ending leftover programs is a new risky action. It needs a confirmation dialog, the server-side checks from NFR-6, NFR-7, and NFR-10, and a security review before release (NFR-9).
- An agent installs NVDA on the owner's PC for testing, with the owner's approval at that step. Agent testing reads NVDA's speech output and isn't a real user listening, so the project still makes no WCAG claim.
- During Testing, the owner spends about a minute accepting a trust prompt for a throwaway repository. The agent deletes the repository after L10.
- History, search, and the session actions wait for 0.3.0. Answering prompts and macOS and Linux support wait for 0.4.0.
