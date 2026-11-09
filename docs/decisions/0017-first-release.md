# 0017: First release, 0.1.0

- **Status:** Accepted
- **Date:** 2026-11-08
- **Amends:** the repository timing in [0005](0005-project-setup.md)

## Context

Iteration 1 passed Testing but wasn't released. The owner chose to build iteration 2 first. Iteration 2 Testing closed under [0016](0016-defer-l10.md). The version number, distribution, publicity, and release notes were left for Phase 6. Decision 0005 planned to make the repository public at the first release, after a name check.

## Options considered

- **Version:**
  - 0.1.0
  - 0.2.0, counting iteration 1 as an unreleased 0.1
  - 1.0.0
- **Distribution:**
  - A GitHub release only
  - An npm package
  - Both
- **Going public:**
  - A name check, then public
  - Stay private
  - Public now
- **Release notes:** a full list of limits and bugs, or a short summary.
- **After the name check:**
  - Keep the name
  - Rename
  - Keep the name and stay private
- **Who makes the repository public:** the owner, or Claude after confirmation.

## Decision

- Release iterations 1 and 2 together as **0.1.0**.
- Distribute through a **GitHub release** only. Users clone the `v0.1.0` tag and build it. Nothing is published to npm, and `package.json` stays `private`.
- The release notes give the **full list** of known limits, open bugs, and checks not run live.
- **Keep the name** cc-session-manager. The name check on 2026-11-08 found:
  - no trademark for it
  - two GitHub repositories and a VS Code extension with the same name, all for Claude Code tools
  - similar names: cc-session, cc-sessions, cc-session-control, and ccmanager

  The README states that the tool isn't affiliated with Anthropic.

- **The owner makes the repository public** in GitHub's settings, after the release is published, rather than Claude doing it.

## Consequences

- Users need Git, Node 24, and pnpm to install it, and must build it themselves.
- Searches for the name will also find the other projects.
- The release is a tag and a GitHub release while the repository is private. It reaches anyone only once the owner makes the repository public.
- Later releases follow the same steps, with 0.2.0 and up for later iterations.
