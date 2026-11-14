# 0028: Iteration 5 requirements choices

- **Status:** Accepted
- **Date:** 2026-11-14
- **Follows:** [0027](0027-iteration-5-plan.md)

## Context

Decision 0027 limited answering prompts and sending messages to Claude Code's own supported ways. Research on Claude Code 2.1.325, by an agent reading `claude --help` and the documentation, and sending trivial messages to its own throwaway background sessions, found:

- **Messages:** `claude --bg --resume <session ID> -- <prompt>` delivers a prompt to a **stopped** background session as its next turn, under the same ID and with its saved options. On a session that's running, even idle, it starts a copy as a new session and says so. `claude -p --resume` also reaches a stopped session, but with a fresh run's permission mode, and it's refused for a running one. Sending to a running session needs a real terminal or Claude Code's own agent view. The cross-session inbox needs a key that only Claude Code's own processes may read, and its messages don't count as the user's.
- **Prompts:** no supported way lets another program answer a running interactive or background session's permission prompt or question. Hooks can, but only from the user's settings, running in every session, with no ID tying an answer to its prompt. Channels can, but only for sessions started with research-preview options. `claude agents --json` says what a session waits for.

An experiment to watch a waiting permission prompt was refused by the agent's permission check and not retried.

## Options considered

- **Prompts:** show what a session waits for and offer Open; the same, keeping hooks as a possible later item; or design an opt-in hook.
- **A running idle session:** Send only to stopped sessions, with Open for running ones; or stop it, then send.
- **A copy started by a race:** report it and keep the copy; or report it and stop the copy.
- **History:** Send to listed sessions only; or from History too.
- **Confirmation:** the form is the confirmation; or a form and a dialog.
- **Open bugs:** re-check live, work around what the tool can, and draft reports for Claude Code's behaviour; re-check and fix only; or leave them as documented.
- **The protected session:** no Send on it; or Send allowed, as Fork is.
- **After a Send:** the user's own action, holding that session's notifications for 30 seconds, with a copy named and highlighted; or notifications as usual.
- **Branch protection:** a pull request with CI required, with admin bypass; CI only; or both with no bypass.
- **Reporting vulnerabilities:** GitHub's private reporting; or an email address.

## Decision

The owner chose the first option each time, the last two after the requirements review:

- No answering prompts. Rows say what a session waits for, with Open where it's offered. Hooks stay ruled out.
- Send only to stopped background sessions in the list. Running sessions offer Open.
- A copy started by a race is reported and kept, for the user to stop or delete.
- No Send from History.
- The Send form is the confirmation, with a starting prompt's limits and checks.
- The open bugs are re-checked live, worked around where the tool can, and reported for Claude Code's own behaviour, as drafts the owner files.
- No Send on the protected session, and none at all while the tool can't tell which session started it, because a message continues the original session, unlike Fork.
- A Send counts as the user's own action for notifications, and a copy is named and highlighted.
- `main` needs a pull request with CI passing, with no force pushes or deletion, and the owner can bypass as admin.
- `SECURITY.md` points to GitHub's private vulnerability reporting.

## Consequences

- FR-37 to FR-39, C-19 to C-21, NFR-17, NFR-18, PU-1 to PU-4, and the known unknowns U-25 to U-29 are added. C-20 replaces C-17. A requirements review by an agent tightened FR-37's checks before sign-off.
- 0027's note on what answering prompts would need, confirmation, tying an answer to its prompt, and self-protection, no longer applies, since answering is dropped.
- The tool never answers a prompt in any iteration unless a later decision changes C-20.
- Send can start a copy if a session starts running at the wrong moment. The result says so, and the copy uses the user's quota until they stop it.
- With branch protection on, agents' PRs still merge once CI passes, as now.
