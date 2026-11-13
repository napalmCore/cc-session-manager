# 0022: Skip live check L10 in iteration 3

- **Status:** Accepted
- **Date:** 2026-11-13
- **Amends:** [0018](0018-iteration-3-plan.md), which brought L10 back for iteration 3 after [0016](0016-defer-l10.md) deferred it

## Context

L10 checks FR-16's kept case live: Delete on a background session whose worktree has uncommitted, untracked, and ignored files should show Kept with the FR-16 message, and the files should survive (U-10). `claude --bg` won't start in a git repository until someone accepts its trust prompt there, and agents don't accept trust prompts.

In iteration 3 Testing, an agent made a throwaway repository, `ccsm-l10`. The owner ran `claude` in it and accepted the trust prompt. An agent's `claude --bg` there, with Claude Code 2.1.323, answered "Workspace not trusted" (attempt 2 in the evidence). The owner accepted the prompt again, and the next run answered the same (attempt 2b). So the check never started. Meanwhile, `claude rm` kept answering "the background service may be restarting" for leftover test sessions.

## Options considered

- **Skip L10 again:** FR-16's kept case stays covered by unit tests and review.
- **Try the trust prompt once more:** send one message in the interactive session before exiting, in case trust is only saved then.
- **Investigate first:** find out how this Claude Code version stores folder trust for background sessions.

## Decision

Skip L10 for iteration 3. The owner chose this.

## Consequences

- As in decision 0016, FR-16's kept case is covered by unit tests and code review only. The tool never passes `claude rm`'s forcing flags (C-8), so Claude Code's own check decides whether a session is kept. A change in the CLI's wording would show a kept session as Failed rather than Kept, which errs on the safe side.
- The release notes say L10 wasn't run.
- L10 stays in the test plan for a later iteration.
- The throwaway repository is deleted.
