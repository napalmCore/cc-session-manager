# 0026: How the iteration 4 page works

- **Status:** Accepted
- **Date:** 2026-11-14
- **Amends:** [0025](0025-iteration-4-design.md), whose Page section said what the page offers but not how it behaves

## Context

Implementation step 7 adds the page for New session (FR-32), Fork (FR-33), History (FR-35), and Search (FR-36). The design named the forms and views, but left open how the forms open, how you move between views, what Fork asks for, and what a search result offers.

## Options considered

- **New session form:** a modal dialog; or an inline panel at the top of the page.
- **Views:** tabs that put `#history` or `#search` in the address; tabs kept only in the page's memory; or one long page with sections.
- **Fork:** a small Fork dialog with the folder fixed and shown; or the New session form, filled in, with its folder locked.
- **Search results:** snippets with the session's folder and last activity, and Resume and Fork; snippets with a link to History; or snippets only.

## Decision

The owner chose the first option each time:

- New session opens a modal dialog.
- Sessions, History, and Search are links in the header, each with its own address, so Back and reload keep the view.
- Fork opens its own dialog, with kind, name, and prompt. The folder is the session's recorded one, shown but not editable.
- Each search result shows its match count, up to 3 snippets, its folder and last activity from History, and Resume and Fork.

## Consequences

- Search results get History's details for the sessions shown with snippets, read once a search is done. The folder is already shown in History, so nothing new reaches the page. A search still keeps nothing once its results are fetched.
- Fork is offered on every row with a session ID, the protected one and rows with actions turned off included, since forking changes nothing. It isn't offered where Claude Code reports the folder gone, because a fork runs there.
- A History entry still in Claude Code's list offers only Fork; Resume is left to the session list.
- The header comes first in Tab order: the page heading, New session, then the view links.
- History and search results offer Resume and Fork only when the session's folder can be used. The drive type is checked before the folder is touched, so a network, mapped, or `subst` folder is never touched and counts as unusable (the owner chose this in review of #64).
