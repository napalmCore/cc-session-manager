# 0001: Follow an iterative SDLC

- **Status:** Accepted
- **Date:** 2026-11-06

## Context

The project must follow an SDLC, and every project decision is made by the project owner from a set of options. Claude Code's local files may change between versions, and needs are likely to shift once the tool is in use.

## Options considered

- **Iterative:** run all phases once per small release.
- **Waterfall:** complete and sign off each phase once, in order.
- **V-Model:** Waterfall with a matching test plan for each phase.
- **Kanban:** pull work continuously, with lightweight phase checks.

## Decision

Use the iterative model. Each iteration runs these phases, with owner approval between them:

1. Planning
2. Requirements
3. Design
4. Implementation
5. Testing
6. Release
7. Maintenance

## Consequences

- Each release is small and goes through every phase.
- Later iterations can revise earlier decisions through new decision records.
