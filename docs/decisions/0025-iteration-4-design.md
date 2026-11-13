# 0025: Iteration 4 design choices

- **Status:** Accepted
- **Date:** 2026-11-13
- **Builds on:** [0024](0024-iteration-4-requirements.md)
- **Amends:** NFR-14 in [requirements.md](../requirements.md): it refuses `%` in a name, refuses control characters in a prompt other than line breaks and tabs, and says where the prompt and name are tested

## Context

Design experiments on throwaway sessions answered U-20 to U-24. The iteration 4 section of [design.md](../design.md) has the evidence. Three findings change what the owner sees, so they went to the owner:

- Windows Terminal expands `%NAME%` in an argument, with no escape for it.
- The current console fallback, `cmd /c start`, mangles names.
- `claude --bg` can accept a session that then fails, with the reason only in an undocumented file.

## The owner's decisions

| Area                                                                    | Options considered                                                                                         | Decision                                                                                                                               |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `%` in a session name                                                   | Refuse `%`; allow a single `%`                                                                             | Refuse `%` in names                                                                                                                    |
| Interactive Start and Fork without Windows Terminal                     | Launch through `conhost.exe` and prove it; refuse names without Windows Terminal; require Windows Terminal | Launch through `conhost.exe`, proven with a real session in implementation step 1. If it fails, refuse names without Windows Terminal. |
| A background session that fails after starting                          | Watch for 10 seconds and say it failed, with no reason; also read the reason from Claude Code's job file   | Watch for 10 seconds and say it failed straight away, without reading the job file                                                     |
| Refusal text from Claude Code (asked after review)                      | The tool's own words, mapping known reasons; also show Claude Code's line, amending FR-18                  | The tool's own words only, mapping known reasons. FR-18 is unchanged                                                                   |
| Mapped drives, `subst` drives, and links to shares (asked after review) | Detect and refuse them; accept as a known limit                                                            | Detect and refuse them                                                                                                                 |

## Additions by the author

- **Prompt control characters** (NFR-14): line breaks and tabs are allowed; other control characters are refused.
- **Search query:** 2 to 200 characters. Snippets stop after 100 matching sessions, but counting goes on.
- **History start time:** the file's creation time is used when the first timestamp is more than 60 seconds before it, because a fork copies the original's timestamps.
- **NFR-11:** History reading and search run only on demand, so they don't count toward its steady-state CPU figure.
- **Prompt tests** run on the background launch only, the one path that passes a prompt. The name's tests run on the Windows Terminal and console paths.

## Consequences

- **Step 1 result:** `conhost.exe` failed through the dashboard's own detached launch, because it exits at once unless its parent keeps live pipes to it. The owner chose this decision's fallback: `cmd /c start` stays the console fallback for Open, Resume, and interactive Start and Fork, and a name is refused without Windows Terminal. `conhost.exe` isn't used.
- The release notes must say names can't contain `%`.
- Design's review follows 0019: an independent agent reviews, and merging after CI passes signs it off.
