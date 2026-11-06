# 0005: Name, license, repository timing, docs layout

- **Status:** Accepted
- **Date:** 2026-11-06

## Options considered

- **Name:** `cc-session-manager`, `cc-helm`, `sessiondeck`
- **License:** MIT, Apache-2.0, GPL-3.0, AGPL-3.0
- **Repository timing:** private now and public later, public from day one, local git only for now
- **Docs layout:** living docs with a decision log, one folder per iteration, one folder per SDLC phase

## Decision

- **Name:** `cc-session-manager`
- **License:** MIT, with aymen mejri as the copyright holder
- **Repository timing:** private GitHub repository now, made public at the first release
- **Default branch:** `main`
- **Commit email:** GitHub noreply address, set for this repository
- **Docs layout:** one living file each for requirements, design, and test plan, plus numbered decision records in `docs/decisions/`

## Consequences

- On 2026-11-06 the name was free on npm and PyPI, with 17 GitHub repositories using a similar name. No trademark check has been done, so one is needed before the public release.
- The git history must be reviewed for personal data before the repository goes public.
