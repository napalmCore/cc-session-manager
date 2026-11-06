# 0010: Per-run style nonce

- **Status:** Accepted
- **Date:** 2026-11-06

## Context

The Content Security Policy allows only local styles and scripts. React Aria's press handling adds one small inline style, `touch-action: pan-x pan-y pinch-zoom`, which the policy blocked and reported as a browser console error.

## Options considered

- **Per-run nonce:** the server creates a random value each run, and allows only styles carrying it.
- **Fixed style hash:** allow exactly this style through its hash.
- **Replace React Aria here:** use native `details` and `summary` for the two expandable sections.
- **Allow inline styles:** add `'unsafe-inline'` to `style-src`.

## Decision

Use a per-run nonce for styles only. The server adds it to `index.html` as `<meta property="csp-nonce">`, which React Aria reads, and includes it in that page's policy. Scripts don't get a nonce.

## Consequences

- The server modifies `index.html` when serving it.
- Library updates that change the inline style keep working, while styles without the nonce stay blocked.
- Any script running in the page could read the nonce, so it doesn't protect against a script that is already running. The policy's ban on inline and external scripts is what prevents that.
