# 0009: Dashboard UI

- **Status:** Accepted
- **Date:** 2026-11-06
- **Amends:** FR-7 and FR-8 in [requirements.md](../requirements.md)

## Context

Each session has about 10 pieces of information, which is too wide for a plain table. Testing against real data also found a `blocked` session with no activity for about 27 days, which would otherwise hold the top of the list and the attention count indefinitely.

## Decisions

| Area            | Options considered                                                                     | Decision               |
| --------------- | -------------------------------------------------------------------------------------- | ---------------------- |
| Layout          | Grouped rows, dense table, card grid                                                   | Grouped rows           |
| Stale sessions  | Separate stale group, keep flagged and sort last, no special treatment, user dismissal | Separate stale group   |
| Theme           | Follow system setting, system with manual toggle, dark only, light only                | Follow system setting  |
| Warning banners | Top banner with expandable details, top banner with all details, dismissible banner    | Top banner, expandable |

## Stale rule

A session is stale when `state` is `blocked` and its last activity was more than 7 days ago. Stale sessions appear in a collapsed group and don't count towards the attention count.

Two cases never count as stale, because hiding a real request is the worse mistake:

- A session with `status: waiting`, which means a live open prompt, however old.
- A session whose last activity is unknown.

## Consequences

- A session that is truly waiting could be overlooked in the collapsed group, which is why the group stays visible with a count.
- The 7-day threshold is fixed for now, and could become a setting if it proves wrong.
