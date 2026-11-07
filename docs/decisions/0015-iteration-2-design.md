# 0015: Iteration 2 design choices

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

A design investigation tested the iteration 2 unknowns on Windows with Claude Code 2.1.319, and a reviewer audited its logs. Ctrl+Break closed an interactive session cleanly in every trial, though all trials used a compiled helper, not the chosen PowerShell one. A process start time can confirm a process ID still belongs to a session, and session variables identify the session that started the tool. Some remaining points were choices for the owner.

## Decisions

| Area                                            | Options considered                                                                                                                 | Decision                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Normal close                                    | Ctrl+Break only; two Ctrl+C keypresses when idle, otherwise Ctrl+Break; Ctrl+Break then answer the wrapper's prompt                | Ctrl+Break only                                        |
| Force end scope                                 | The session's descendants, checked by start time; the session only; the whole tree below the session, without the start-time check | The session and its descendants, checked by start time |
| Started from an unknown session                 | Block Stop, Delete, and End with an explanation; allow them with a warning                                                         | Block them, with an explanation                        |
| Port                                            | Hand over to a running instance; a fixed port with a clear error; keep the fallback                                                | Hand over to a running instance                        |
| Process helper                                  | A PowerShell script, a native Node module, a small compiled helper                                                                 | A PowerShell script                                    |
| Unproven PowerShell helper                      | Prove it as the first implementation step, re-test before Design closes, switch to the tested compiled helper                      | Prove it first, and return to the owner if it fails    |
| "Can't read sessions" notification              | After 3 failed polls in a row, on the first failure                                                                                | After 3 failed polls in a row                          |
| A session that hands over to a running instance | Protect it too, protect only the first                                                                                             | Protect it too                                         |
| Variables removed before launching `claude`     | The session-identity set, every `CLAUDE*` variable                                                                                 | The session-identity set                               |
| Helper ordering bug found in the proof          | Fix it and re-prove, switch to the compiled helper                                                                                 | Fix it and re-prove                                    |
| "Terminate batch job" after End                 | Accept and document, clean up the wrapper, use Force end instead                                                                   | Accept and document                                    |
| Sessions started from Git Bash                  | Refuse End with an explanation, allow processes started earlier, offer Force end only                                              | Refuse End with an explanation                         |

The Force end options were reworded on 2026-11-07 at the owner's request: the owner was shown "session's children only", "session only", and "whole process tree".

## Consequences

- On npm installs, a session closed with Ctrl+Break is expected to leave its terminal showing "Terminate batch job (Y/N)?". This isn't yet in the logs.
- Force end also ends programs the session started, such as dev servers.
- If the tool can't tell which session started it, those three actions are unavailable until it's restarted outside Claude Code.
- End needs Windows PowerShell, and the proof measured about 1 second per helper step. If PowerShell is blocked by policy, End is unavailable.
- The single-instance handover adds a secret in the tool's data folder, which is as exposed as the store file.
- The PowerShell helper is proven before anything is built on it.
- More sessions can be protected from Stop, Delete, and End, because handovers add to the set.
- On npm installs, End leaves "Terminate batch job (Y/N)?" in the terminal, and a hidden console keeps two idle processes until it's closed or the PC restarts.
- End isn't available for sessions started from Git Bash. Force end still is.
