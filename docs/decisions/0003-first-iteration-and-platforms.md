# 0003: Start with read-only live monitoring, Windows first

- **Status:** Accepted, read-only limit lifted for iteration 2 by [0014](0014-iteration-2-scope.md)
- **Date:** 2026-11-06

## Context

The iterative model needs a small first release. The tool will be public, but current testing is on Windows.

## Options considered

First iteration:

- **Live monitoring only**
- **Monitoring and control**
- **Monitoring and analytics**
- **All four capabilities**

Platforms:

- **Windows first, with portable code**
- **Windows, macOS, and Linux from day one**
- **Windows only**

## Decision

- Iteration 1 delivers read-only live monitoring: a view of all sessions and which ones need the user.
- Windows is the first supported platform. The code stays portable, and macOS and Linux follow in later iterations.

## Consequences

- Iteration 1 cannot alter sessions, which limits risk and avoids the security questions raised by control and interaction.
- Control, analytics, and interaction are deferred to later iterations.
- Avoid Windows-only dependencies unless a later decision record allows them.
