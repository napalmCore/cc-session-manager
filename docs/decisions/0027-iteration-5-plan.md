# 0027: Close iteration 4, and iterations 5 and 6 scope

- **Status:** Accepted
- **Date:** 2026-11-14
- **Amends:** [0023](0023-iteration-4-plan.md), which left iteration 5 as planned in [0018](0018-iteration-3-plan.md) but not committed

## Context

0.3.0 was released on 2026-11-14, and the owner made the repository public the same day. Iteration 4's open bugs are the same as 0.2.0's: BUG-30, which is Medium, and BUG-7, BUG-22, BUG-23's `claude -p` half, and BUG-29, which are Low.

Decisions 0018 and 0023 pencilled in answering prompts, sending messages, and macOS and Linux support for 0.4.0, without committing to them. Being public brings upkeep: some docs still say the repository is private, there's no `SECURITY.md`, `main` has no branch protection, and CI pins its actions by tag.

## Options considered

**Scope:** answering prompts and sending messages; macOS and Linux; upkeep for the public repository; the open bugs.

**Releases:**

- Split in two: 0.4.0 has upkeep, the open bugs, and answering prompts and sending messages; 0.5.0 has macOS and Linux, as iteration 6.
- One release, 0.4.0, with all four.
- Upkeep straight away as small changes outside the phases, then everything else as one iteration.

**Testing on macOS and Linux:**

- CI only, with live checks recorded as not run until a machine is available.
- A Mac from the owner, with Linux on CI only.
- Both from the owner.
- WSL or a Linux virtual machine on the owner's PC, with macOS on CI only.

**The boundary for answering prompts:**

- Only ways Claude Code itself documents or provides, such as its command line or hooks. Never typing into a terminal or editing Claude Code's files. Every answer is a choice the user makes on the page, with nothing approved automatically. If Claude Code has no supported way, that part is dropped.
- Messages only, never answering permission prompts.
- Research first, then decide.

## Decision

The owner chose all four parts, and:

- **Releases:** split in two.
  - **Iteration 5, 0.4.0:** upkeep for the public repository, the open bugs, and answering prompts and sending messages.
  - **Iteration 6, 0.5.0:** macOS and Linux.
- **Testing on macOS and Linux:** CI only. Live checks there are recorded as not run until a machine is available.
- **Answering prompts:** only Claude Code's own supported ways, with every answer chosen by the user on the page and nothing approved automatically. A part with no supported way is dropped.

## Consequences

- Iteration 4 is closed. Iteration 5 starts with Requirements, after research into how Claude Code takes answers and messages from outside a terminal. The research only reads documentation and `claude --help`, and tries things on the agents' own throwaway sessions, as in iteration 4's design.
- Answering a prompt can approve a tool on the user's behalf, so requirements must cover confirmation, which prompt an answer is for, what happens if the prompt has changed or gone, and self-protection (FR-22). C-17, which keeps iteration 4 from answering prompts, is replaced for iteration 5 only by what the owner signs off.
- Upkeep for the public repository and work on the open bugs go through the same phases, as small steps.
- Iteration 6 plans macOS and Linux after 0.4.0 is released. Its live checks depend on a machine being available.
