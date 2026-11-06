# 0002: Build a new open-source thin layer

- **Status:** Accepted, amended by [0006](0006-transcript-metadata.md)
- **Date:** 2026-11-06

## Context

The product should eventually cover four capabilities for a public open-source audience:

- Live monitoring
- History and analytics
- Session control
- Interaction with sessions

An evaluation on 2026-11-06 found no tool described as covering all four, though each is partly covered. It was based on documentation, tool descriptions, and GitHub metadata. No community tool was installed or tested, and their Windows support is unconfirmed.

| Tool                                                                            | Stars    | Last push  | Coverage as described                                  |
| ------------------------------------------------------------------------------- | -------- | ---------- | ------------------------------------------------------ |
| Claude Code `claude agents`                                                     | Built in | n/a        | Background session monitoring, control, peek and reply |
| [ccusage](https://github.com/ccusage/ccusage)                                   | 19,342   | 2026-11-06 | Cost reports                                           |
| [phuryn/claude-usage](https://github.com/phuryn/claude-usage)                   | 2,288    | 2026-07-10 | Usage charts and cost estimates                        |
| [ccboard](https://github.com/FlorianBruniaux/ccboard)                           | 101      | 2026-09-01 | Monitoring and analytics                               |
| [seunggabi/claude-dashboard](https://github.com/seunggabi/claude-dashboard)     | 38       | 2026-03-27 | Monitoring and control, requires tmux                  |
| [Stargx/claude-code-dashboard](https://github.com/stargx/claude-code-dashboard) | 17       | 2026-11-03 | Monitoring with tokens and cost                        |
| [panoptes](https://github.com/ivan-brko/panoptes)                               | 4        | 2026-09-23 | Monitoring, including waiting for input                |

## Options considered

- **New thin layer:** build on documented Claude Code interfaces.
- **Contribute to an existing project:** add the missing capabilities upstream.
- **Combine existing tools:** use `claude agents` and ccusage with minimal glue.
- **Test tools first:** defer the decision until candidates are tried on Windows.

## Decision

Build a new open-source tool as a thin layer:

- Use `claude agents --json` and Claude Code CLI commands for live state and control.
- Use hooks for events and interaction, only with explicit user opt-in.
- Read transcripts only for analytics, with a parser that tolerates format changes.

Do not depend on `~/.claude/jobs/<id>/`, which the [agent view docs](https://code.claude.com/docs/en/agent-view) say is not a stable interface.

## Consequences

- **Adoption risk:** cost tools have far more users than session dashboards. The project needs a clear reason to exist, such as one tool for all four capabilities and solid Windows support.
- **Compatibility:** the tool must handle Claude Code changes over time.
- **Security:** the tool must never read, log, or display `~/.claude/.credentials.json` or the session `.key` files. Answering permission requests needs a security review before release.
- **Settings changes:** installing hooks changes the user's Claude Code settings, so it must be opt-in and reversible.
