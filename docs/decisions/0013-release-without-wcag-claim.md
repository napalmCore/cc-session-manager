# 0013: Release without a WCAG claim

- **Status:** Accepted
- **Date:** 2026-11-06
- **Amends:** the M2 row in [0011](0011-testing-bug-fixes.md), and NFR-5 in [requirements.md](../requirements.md)
- **Supersedes in part:** the requirement in [0008](0008-development-setup.md) that NFR-5 needs manual screen-reader checks

## Context

NFR-5 required WCAG 2.2 AA. Automated axe scans and keyboard tests pass, but they can't prove it. Agents can't judge what a screen reader says, so the M2 check needed a person.

## Options considered

- **The owner runs NVDA:** the only way to verify NFR-5 and the BUG-3 fix.
- **Release without the claim:** skip M2, and amend NFR-5.
- **Ask users to test:** release, with NFR-5 open until someone reports back.

## Decision

Release without the claim. NFR-5 now requires the dashboard to be built towards WCAG 2.2 AA and to pass the automated checks. The project doesn't claim conformance.

M2 wasn't run. Its script stays in [test-plan.md](../test-plan.md) for a later iteration or a contributor.

## Consequences

- The release notes must say that the dashboard hasn't been verified with a screen reader.
- BUG-3 stops being counted as an open High bug: the announcement region is in place and passes automated tests, but what a screen reader says about it is unverified. FR-10 is checked to that level only.
- People who rely on screen readers may hit problems that the automated checks can't find, such as BUG-10.
