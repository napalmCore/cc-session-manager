# 0015: Iteration 2 design choices

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

A design investigation tested the iteration 2 unknowns on Windows with Claude Code 2.1.319. It found that Ctrl+Break closes an interactive session cleanly, that a process start time confirms a process ID still belongs to a session, and that documented variables identify the session that started the tool. Some remaining points were choices for the owner.

## Decisions

| Area                            | Options considered                                                                                                  | Decision                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Normal close                    | Ctrl+Break only; two Ctrl+C keypresses when idle, otherwise Ctrl+Break; Ctrl+Break then answer the wrapper's prompt | Ctrl+Break only                                     |
| Force end scope                 | The session's children, checked by start time; the session only; the whole process tree                             | The session and its children, checked by start time |
| Started from an unknown session | Block Stop, Delete, and End with an explanation; allow them with a warning                                          | Block them, with an explanation                     |
| Port                            | Hand over to a running instance; a fixed port with a clear error; keep the fallback                                 | Hand over to a running instance                     |
| Process helper                  | A PowerShell script, a native Node module, a small compiled helper                                                  | A PowerShell script                                 |

## Consequences

- On npm installs, a session closed with Ctrl+Break leaves its terminal showing "Terminate batch job (Y/N)?".
- Force end also ends programs the session started, such as dev servers.
- If the tool can't tell which session started it, those three actions are unavailable until it's restarted outside Claude Code.
- End needs Windows PowerShell, and takes about 0.6 seconds longer per step. If PowerShell is blocked by policy, End is unavailable.
- The single-instance handover adds a secret in the tool's data folder, which is as exposed as the store file.
