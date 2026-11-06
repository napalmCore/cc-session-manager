# 0006: Allow transcript metadata for session activity

- **Status:** Accepted
- **Date:** 2026-11-06
- **Amends:** [0002](0002-product-direction.md)

## Context

Decision 0002 limited transcript reading to analytics. Iteration 1 should also show each session's latest activity, which is likely only available from transcripts.

## Options considered

- **Metadata only:** git branch, model, and last activity time, with no message text.
- **Metadata and last message:** also preview the latest message, which needs redaction and an off switch.
- **Defer:** leave latest activity out of iteration 1.

## Decision

Transcripts may also be read for session metadata in iteration 1: git branch, model, and last activity time. Message text must not be stored or displayed.

## Consequences

- Iteration 1 depends on transcript fields that may change between Claude Code versions, so missing or changed fields must not break the dashboard.
- Transcripts can contain sensitive content, so extracting metadata must not copy message text into logs or storage.
- Message previews would need a new decision record.
