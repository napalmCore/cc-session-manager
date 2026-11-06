# 0004: Local web dashboard in TypeScript on Node

- **Status:** Provisional. To be confirmed or changed in Phase 3 (Design), after requirements are written.
- **Date:** 2026-11-06

## Context

The owner asked to set a stack direction early without skipping the Design review. The stack must suit a public tool that runs commands, may later receive local hook HTTP calls, and shows rich views.

## Options considered

Interface:

- **Local web dashboard**
- **Terminal UI**
- **Desktop app**
- **Web and terminal**

Language and runtime:

- **TypeScript on Node**
- **Go**
- **Rust**
- **.NET 10 (C#)**

## Decision

Work towards a local web dashboard written in TypeScript on Node.

Still open for Design: UI framework, server framework, data storage, packaging, and test tools.

## Consequences

- One language covers the server and the UI.
- The local server must be secured, especially before any interaction features are added.
- Claude Code's native install doesn't need Node, so some users won't have it. Reaching them requires a packaged executable.
