# Reports for Claude Code

Drafts of bug reports about Claude Code's own behaviour, found while building cc-session-manager. The owner files them with Anthropic. Each was seen on Claude Code 2.1.325 on Windows 11 in iteration 5 (FR-39), except where it says otherwise. Paths are generic.

## `claude agents --json` doesn't list an interactive session started with an inherited `CLAUDE_CODE_CHILD_SESSION` (BUG-7)

**Steps:**

1. In a shell where `CLAUDE_CODE_CHILD_SESSION` is set, such as a Bash tool shell inside Claude Code, start `claude "Reply with the word ok."` in a new console, in a trusted folder.
2. Run `claude agents --json`.
3. Repeat with the variable unset.

**Expected:** both sessions are listed, or the documentation says child sessions are hidden.

**Actual:** with the variable set, the session is never listed, no `<pid>.json` appears under `~/.claude/sessions`, and no transcript is written after several minutes. With it unset, the session is listed within seconds and answers. `claude -p` and `claude --bg` runs started with the variable set are listed.

## `claude agents --json` doesn't list an interactive session waiting at the workspace trust dialog (BUG-22)

**Steps:**

1. Start `claude` interactively in a folder that has never been trusted.
2. Leave the trust dialog open, and run `claude agents --json`.

**Expected:** the session is listed, ideally with a status such as `waiting`.

**Actual:** it isn't listed until trust is accepted. Seen in earlier versions; not re-run on 2.1.325.

## `claude agents --json` lists `claude -p` runs as interactive sessions (BUG-23)

**Steps:**

1. In any folder, run `claude -p "Write a 300-word essay. Do not use any tools."`.
2. While it runs, run `claude agents --json`.

**Expected:** a distinct kind, such as `print`, or a field such as `nonInteractive: true`.

**Actual:** `kind: "interactive"` and `status: "busy"`, with the same fields as an interactive terminal session. The entry disappears when the run ends, even from `claude agents --json --all`.

## `claude stop` leaves a background session's shells and their programs running (BUG-30)

**Steps:**

1. Run `claude --bg "Use the Bash tool to run ping -n 300 127.0.0.1 in the background, then reply started."`.
2. Once it's done, run `claude stop <id>`.
3. List the processes whose parent chain leads to the session's process.

**Expected:** Stop ends the session's shells and the programs they started, or the documentation says they keep running.

**Actual:** the `claude` process exits, but its `bash.exe` chain and `ping.exe` keep running. A later `claude rm` ended them on 2.1.325. Earlier versions sometimes left them running after `claude rm`, or left the folder locked.
