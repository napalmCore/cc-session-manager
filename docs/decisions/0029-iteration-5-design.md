# 0029: Iteration 5 design choices

- **Status:** Accepted
- **Date:** 2026-11-14
- **Amends:** FR-37 and FR-38 in [0028](0028-iteration-5-requirements.md)'s requirements, and FR-5's label for waiting sessions

## Context

Design experiments with Claude Code 2.1.325, by an agent on its own throwaway background sessions, found that `stopped` is rare: `claude stop` on an idle session, and Claude Code's own idle timeout, leave a session `done` with no process. Whether a message is delivered depends on there being no process; with one, Claude Code starts a copy. A session removed and rebuilt prints the same ID without the note line that lists its restored options. The details are in the design's Iteration 5 section.

## Options considered

- **Which sessions offer Send:** background sessions in `stopped`, `done`, or `failed` with no process; `stopped` and `done` only; or `stopped` only, as written.
- **The note line:** an extra signal only; or required, giving an unknown result without it. After the design review, since the server can't tell whether options were lost: a generic line whenever the note is missing; nothing; or an experiment first.
- **Send on the page:** a "Send…" button and dialog, like Fork; or a box on the row.
- **Waiting sessions:** a plain label and "Answer it in Claude Code"; or Claude Code's own words plus the note. After the design review: notifications use the same plain labels; or Claude Code's words.
- **Build order:** upkeep, bugs, waiting sessions, then Send; or Send first.

## Decision

The owner chose the first option each time.

## Consequences

- FR-37 now offers Send on background sessions in `stopped`, `done`, or `failed` with no process, and U-25, U-26, U-28, and U-29 are resolved in the requirements.
- FR-38's plain labels replace FR-5's for waiting sessions, on rows and in notifications. Claude Code's own value is kept underneath, so a wording change never notifies.
- When Claude Code doesn't print its note about saved options, the result says so, even when nothing was lost.
- A `failed` session can be continued with a message, as Claude Code allows.
- The permission mode a message runs in isn't visible to the tool. Nothing Send passes can change it (C-19).
- Implementation starts with project upkeep.
