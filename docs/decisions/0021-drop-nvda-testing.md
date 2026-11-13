# 0021: Drop screen-reader testing with NVDA

- **Status:** Accepted
- **Date:** 2026-11-13
- **Amends:** [0018](0018-iteration-3-plan.md), [0019](0019-iteration-3-requirements.md), and [0020](0020-iteration-3-design.md) for NFR-12, U-19, and M2

## Context

Iteration 3 planned to test the dashboard with the NVDA screen reader (NFR-12, U-19, and the M2 script), because earlier iterations hadn't (decisions 0013 and 0016).

During Testing, the owner approved downloading NVDA 2026.3.1 from NV Access and running it in temporary mode. The first run ended about a minute in, before any check. NVDA spoke aloud and read whatever had focus, including other windows, so a run needs the PC left alone. Its speech log also caught text from other windows, so that log was deleted.

## Decision

The owner chose to drop NVDA testing: "drop all the NVDA feature, we do not need it".

## Consequences

- NFR-12 and U-19 are dropped from iteration 3. M2 isn't run.
- As with decisions 0013 and 0016, the project makes no screen-reader claim. The dashboard is still built towards WCAG 2.2 AA (NFR-5) and keeps its automated checks: axe scans in both themes, keyboard and focus tests, and browser tests of accessible names and row text (BUG-10, BUG-11, BUG-16).
- The screen-reader fixes in step 8 stay. They're checked by browser tests only.
- The release notes say that the dashboard hasn't been tested with a screen reader.
- The NVDA download, scripts, and logs from the attempt are deleted.
