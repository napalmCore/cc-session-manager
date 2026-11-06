# 0007: Iteration 1 architecture

- **Status:** Accepted
- **Date:** 2026-11-06

## Context

Requirements for read-only live monitoring were signed off. The [agent view docs](https://code.claude.com/docs/en/agent-view) name `claude agents --json` as the supported way to read session state, and recommend polling it with `--all`. Only completed background sessions are documented as staying listed, so the tool must keep its own record of finished sessions.

## Decisions

| Area | Options considered | Decision |
|---|---|---|
| Live updates | Server-Sent Events, WebSocket, browser polling | WebSocket |
| Finished-session storage | JSON file, SQLite, memory only | JSON file |
| UI framework | React, Svelte, Preact, no framework | React |
| Server framework | Hono, Fastify, Express, Node built-in http | Hono |
| Startup | Manual command, command with optional auto-start, background service | Manual command |
| Token delivery | One-time URL then cookie, token stays in URL, user-entered password | One-time URL then cookie |
| Code structure | Single package, pnpm workspace, separate repositories | Single package |
| Transcript reading | Read file ends if changed, stream the whole file, modified time only | Read file ends if changed |
| Build tool | Vite, esbuild, Next.js | Vite |
| Styling and accessibility | React Aria with CSS Modules, Tailwind with shadcn/ui, Material UI, plain CSS | React Aria with CSS Modules |
| Data validation | Zod, Valibot, hand-written checks | Zod with tolerant schemas |
| Port selection | Default with fallback, random free port, fixed port only | Default with fallback |

## Consequences

- WebSocket goes beyond what a read-only release strictly needs, but suits later interaction features. The server must check the cookie and `Origin` when a connection opens, and in iteration 1 it ignores messages from the browser.
- The JSON store will likely be replaced when history and analytics arrive.
- With a manual command, the tool can't watch for sessions that end while it's off. FR-2 was amended to accept and document this limit, rather than recover sessions from transcripts or add auto-start.
- Validation checks data structure. It doesn't replace the transcript field allow-list, which needs its own tests.
- Reading only the end of a transcript means some metadata may show as unavailable.
