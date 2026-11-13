# 0023: Close iteration 3, and iteration 4 scope

- **Status:** Accepted
- **Date:** 2026-11-13
- **Amends:** the iteration 4 row of [0018](0018-iteration-3-plan.md)'s staging plan

## Context

0.2.0 was released on 2026-11-13, as decision 0017 set out. Iteration 3's last phase is Maintenance (decision 0001). Its open bugs are BUG-7, BUG-22, BUG-23's `claude -p` half, BUG-29, and BUG-30. All are Low except BUG-30, which is Medium, and most come from Claude Code's own behaviour.

Decision 0018 planned iteration 4 as 0.3.0: history and search, and starting, renaming, and forking sessions. It wasn't committed.

What Claude Code 2.1.323's command line supports, from `claude --help`:

- **Starting:** `claude --bg "<prompt>"` starts a background session in the current folder, and `claude` starts an interactive one.
- **Naming:** `-n, --name <name>` sets a display name when a session starts. No command renames an existing session.
- **Forking:** `--resume <session-id> --fork-session` starts a new session that continues an earlier one, with a new session ID.
- **History:** transcripts of past sessions stay on disk under `~/.claude/projects`.

## Options considered

**Maintenance:**

- Update BUG-30's status to say FR-27 mitigates it.
- Re-check BUG-7 live.
- Draft reports to Claude Code about BUG-22 and BUG-23, for the owner to file.
- Leave all five as documented in 0.2.0's release notes.

**Iteration 4 features:** start sessions, fork a session, a history of past sessions, and search inside conversations.

**Renaming:**

- Name a session only when it starts.
- Dashboard-only labels, stored by the tool.
- Drop renaming.

## Decision

- **Maintenance:** leave the five open bugs as documented, and close iteration 3.
- **Iteration 4, 0.3.0:** all four features, so starting sessions, forking, history of past sessions, and search inside conversations.
- **Renaming:** a name can be set only when a session starts or is forked, through `-n`. Existing sessions aren't renamed.

The owner chose each of these.

## Consequences

- Iteration 4 starts with Requirements. Each feature gets requirements, and design records how it uses Claude Code's command line.
- Search inside conversations means reading message text, which the tool never keeps today (C-4, C-12). Requirements must set what may be read, held in memory, shown, or stored, and the owner decides it.
- Starting and forking sessions are new actions that change Claude Code state, so they follow the existing action rules: NFR-6, NFR-7, NFR-10, protection (FR-22), and confirmation where work could start unexpectedly.
- Iteration 5, 0.4.0, stays as planned in 0018: answering prompts and sending messages after research, and macOS and Linux support. It isn't committed.
