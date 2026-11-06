# 0008: Development setup

- **Status:** Accepted
- **Date:** 2026-11-06

## Decisions

| Area                   | Options considered                                                                            | Decision                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Minimum Node version   | Node 22+, Node 24+, Node 26+                                                                  | Node 24+                                                                                                              |
| Package manager        | pnpm, npm                                                                                     | pnpm                                                                                                                  |
| Git workflow           | Feature branches with pull requests, direct commits to main, Git Flow                         | Feature branches with pull requests                                                                                   |
| Default port           | 4780, 7420, 8787                                                                              | 4780                                                                                                                  |
| Test stack             | Vitest with Playwright and axe, Vitest with Testing Library, Node test runner with Playwright | Vitest, Playwright, and axe                                                                                           |
| Continuous integration | GitHub Actions on Windows, Windows and Linux, local checks only                               | GitHub Actions on Windows                                                                                             |
| Linting and formatting | ESLint with Prettier, Biome, TypeScript strict only                                           | ESLint with Prettier                                                                                                  |
| Local Node setup       | fnm, system-wide upgrade, owner-managed                                                       | fnm                                                                                                                   |
| Build order            | Thin end-to-end first, backend then UI, UI first with sample data                             | Thin end-to-end first                                                                                                 |
| Review                 | Each pull request, each milestone, at the end                                                 | The owner approves each pull request before merge                                                                     |
| Test approach          | Test-first for risky logic, test-first for everything, tests after each feature               | Test-first for session rules, parsing, the transcript allow-list, and security, with tests for the rest as it's built |
| Commit messages        | Conventional Commits, plain descriptive messages                                              | Conventional Commits                                                                                                  |
| TypeScript version     | TypeScript 6.0, TypeScript 7 and 6 side by side, TypeScript 7 with Biome                      | TypeScript 6.0, the latest version `typescript-eslint` 8.72.1 supports                                                |

## Consequences

- Node 24 is supported until 2028-04-30, per the [Node release schedule](https://github.com/nodejs/Release).
- The first release must state that Node 24 or later is required, until a packaged executable is available.
- Private-repository CI uses limited free minutes, and Windows runners consume them faster.
- Automated axe checks can't prove WCAG 2.2 AA on their own, so NFR-5 also needs manual keyboard and screen-reader checks.
- Move to TypeScript 7 once `typescript-eslint` supports it.
- CI doesn't test Linux yet, so portability relies on avoiding Windows-only dependencies until a later iteration adds it.
