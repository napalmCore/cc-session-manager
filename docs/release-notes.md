# Release notes

## 0.4.0

The fourth release. It covers iteration 5. Get it from the GitHub release: clone the repository at the `v0.4.0` tag, then follow the README. It isn't published to npm. It's the first release since the repository became public, on the day 0.3.0 was released.

cc-session-manager is an independent tool. It isn't made, endorsed, or supported by Anthropic.

**Upgrading from 0.3.0:** stop the old version, run `git fetch --tags`, check out `v0.4.0`, and run `pnpm install` and `pnpm build` again. The saved list of finished sessions carries over unchanged, and going back to 0.3.0 keeps it.

### What's new

- **Send:** a "Send…" button on a background session that has finished, stopped, or failed and has no process opens a form with a message box. Pressing Send is the confirmation. The message goes to the session as its next turn, with `claude --bg --resume <session ID> -- <message>`, and the session runs again with its own saved options. If the session started running in the meantime, Claude Code starts a new session with the message instead; the result names it and its row is highlighted, and it's left for you to stop or delete; it uses your quota until you do. A send counts as your own action, so that session's notifications are held for 30 seconds afterwards, as after Stop (FR-37).
- **Waiting sessions:** a session waiting on Claude Code reads "Waiting on a permission prompt", "Waiting on your answer", or "Needs you in Claude Code", on its row, in notifications, and in screen-reader announcements. A row in Needs you adds "Answer it in Claude Code." The dashboard never answers a prompt (FR-38).
- **The repository is public,** with `SECURITY.md` pointing to GitHub's private vulnerability reporting. Its CI actions are pinned to full commit hashes and kept current by Dependabot, and `main` takes changes only through pull requests with CI passing, which the owner can bypass as admin.
- The open bugs were checked again on Claude Code 2.1.325, except BUG-22, which would need a session left at its trust dialog. BUG-29 is closed as not reproducible. Reports for Claude Code's own behaviour are drafted in [claude-code-reports.md](claude-code-reports.md).

### Privacy and security

0.3.0's privacy and security notes still apply, with these changes:

- A message is passed to Claude Code and never stored, logged, cached, or put in the page address, and the result doesn't repeat it. Claude Code keeps it in the session's transcript, as for any turn. The message field asks the browser not to autofill or spell-check it, though the browser decides. An error from running Claude Code, which can hold its command line, is never logged or shown (C-21).
- Send passes only `--bg`, `--resume`, the session ID, `--`, and the message, with no shell. The session ID and folder come from the server's own listing, never from the page. Nothing that could change a session's permission mode is passed (C-19).
- Send isn't offered, and is refused, for the session that started the dashboard, and for every session while the dashboard can't tell which session that is. It's refused for a session that has a process or is waiting, and, after a fresh listing just before sending, for one that has changed or gone. Like Fork, it runs only in the session's recorded folder, and only if that's still a local folder.
- The dashboard doesn't use hooks, doesn't change Claude Code's settings, and never answers a permission prompt or question (C-20).

### Known limits

The known limits of 0.3.0 still apply. Also:

- Send only reaches a background session with no process. A running one, an interactive one, or one only in History offers Open, Resume, or Fork instead. Claude Code itself offers no supported way for another program to message a running session or answer its prompts.
- `claude stop` on an idle background session leaves it "done", not "stopped", and Claude Code's own idle timeout does the same after about an hour. Both can take a message.
- A send usually answers in about 15 seconds, because the dashboard watches the session for 10 seconds afterwards to catch one that fails straight away. It can take up to about 40 seconds, or more if the folder's drive is slow to check. A send to a session that was already failed and fails again at once may still be reported as sent (BUG-39); its row shows the failure on a later update.
- If Claude Code doesn't say it restored the session's saved options, the result says so, sometimes when nothing was lost. If a session is removed with `claude rm` in the moment between the dashboard's last check and the send, Claude Code rebuilds it without its saved options, such as its name.
- A message is on Claude Code's command line for a few seconds while it starts, where other programs running as you can read it, as with Start's prompts.
- The dashboard can't see which permission mode a message runs in. Nothing it passes can change it, so the session's own saved mode applies.
- A message can be at most 8,000 characters. A lone half of a surrogate pair in it reaches Claude Code as a replacement character.
- The page isn't limited in how many sessions it sends to at once, and each send starts a turn that uses your quota.

### Open bugs

BUG-30 is Medium. BUG-7, BUG-22, BUG-23's `claude -p` half, and BUG-39 are Low.

| ID     | Bug                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BUG-7  | An interactive session started with an inherited `CLAUDE_CODE_CHILD_SESSION` isn't listed by Claude Code and writes no transcript. The dashboard's own launches remove the variable.              |
| BUG-22 | Claude Code doesn't list a session waiting at its trust dialog.                                                                                                                                   |
| BUG-23 | `claude -p` runs are listed as interactive sessions, as Claude Code reports them.                                                                                                                 |
| BUG-30 | **Medium.** After `claude stop`, programs a background session started can keep running. This is Claude Code's behaviour; the dashboard lists them and can end them after its own Stop or Delete. |
| BUG-39 | A send to an already-failed session that fails again at once may be reported as sent.                                                                                                             |

### Accessibility

The dashboard is built towards WCAG 2.2 AA and passes automated accessibility scans and keyboard tests, but it doesn't claim conformance and **hasn't been tested with a screen reader** (decision 0021). The Send form and the waiting labels are checked by browser tests and by automated scans in both themes. A live keyboard-only pass found that focus was lost after a send (BUG-37), fixed in this release and checked again live in both themes.

### Not checked live

These were checked by automated tests and review, but not on real sessions:

- A send that meets a session starting to run at the same moment. The new-session result was checked with the test server holding back its listing, not with a real race, and only before the last Testing fixes.
- The "Waiting on a permission prompt" and "Needs you in Claude Code" labels: the test machine's Claude Code ran in auto mode, so no permission prompt came up. "Waiting on your answer" was seen, before the last Testing fixes.
- A send to a session in the `stopped` state; the checks used `done` and `failed` ones.
- Send for a session whose folder has gone or isn't trusted, and Send's refusal wording from Claude Code.
- Claude Code output too long to read, and the 30-second limit on a send.
- macOS and Linux, planned for 0.5.0.

## 0.3.0

The third release. It covers iteration 4. Get it from the GitHub release: clone the repository at the `v0.3.0` tag, then follow the README. It isn't published to npm.

cc-session-manager is an independent tool. It isn't made, endorsed, or supported by Anthropic.

**Upgrading from 0.2.0:** stop the old version, run `git fetch --tags`, check out `v0.3.0`, and run `pnpm install` and `pnpm build` again. The saved list of finished sessions carries over unchanged, and going back to 0.2.0 keeps it.

### What's new

- **New session:** a button in the header opens a form with a folder, typed or picked with Browse, a kind, an optional name, and, for a background session, a prompt. A background session starts with `claude --bg`; an interactive one opens in a new terminal. Pressing Start is the confirmation, and a refusal stays in the form in the tool's own words (FR-32).
- **Fork:** a Fork button starts a new session from a conversation so far, in its recorded folder, with `--resume <ID> --fork-session`. It's offered on sessions with a session ID whose folder can still be used: in the list, unless its folder has been deleted, and in History and search results, when the folder is still a local folder. The original is never changed, so Fork is offered on the session that started the dashboard too (FR-33).
- **Names only at start:** a name can be given when a session is started or forked, and isn't changed afterwards (FR-34).
- **History:** a view of every past session whose main transcript is still under `~/.claude/projects`, newest first, 50 to a page, with folder, branch, model, times, and usage, and Resume and Fork. A session still in Claude Code's list offers only Fork (FR-35).
- **Search:** a view that searches your prompts and Claude's visible replies, as plain text ignoring case, for 2 to 200 characters. It shows progress and can be cancelled, and each result shows its match count, up to three snippets, its folder and last activity, and Resume and Fork (FR-36).
- Sessions, History, and Search each have their own address, so Back and reload keep the view.

### Privacy and security

0.2.0's privacy and security notes still apply, with these changes:

- **Search is the only thing that reads message text**, and only when you search, with no index. It reads prompts and visible replies only: not thinking, tool calls or results, subagents, or text Claude Code inserts. The text it reads goes no further than the search. The matches and snippets are kept in memory until the page fetches them, or for at most 60 seconds after the search finishes, then dropped; until then a snippet may keep its whole message in memory. Snippets go only to the page that asked, in responses that aren't cached. Nothing about a search is logged, saved, or put in the page address (C-16).
- History reads every main transcript under `~/.claude/projects` for its folder, branch, model, times, and token counts, as the dashboard already did for listed sessions, and keeps them in memory only. It shows no names.
- The tool doesn't store or log a starting prompt or a name (C-18). Claude Code keeps them in the session's transcript, as it does for any session. The name, folder, prompt, and search fields ask the browser not to autofill or spell-check them, though the browser decides.
- A prompt and a name are passed on Claude Code's command line, and a name also on Windows Terminal's, where other programs running as you can read them, as with the sign-in link a browser is started with.
- New session and Fork pass only `--bg`, `--name=<name>`, `--resume`, and `--fork-session`, all before `--`. No permission mode or permission-skipping option is ever passed, so each folder's own Claude Code settings decide, as when you start Claude Code yourself (C-15). A background session runs with no shell. A terminal session runs through Windows Terminal, or, without it, through `cmd /c start`, which is given only options and a session ID: never a prompt or a name.
- New session takes only a local folder. Network shares, mapped network drives, and `subst` drives or links that lead to a share are refused, while ones that lead to a local folder are used as that folder. The drive type is checked before the folder is touched, except through a local link (see Known limits).
- Fork and Resume from History take the session's folder from its transcript on the server, never from the page.

### Known limits

The known limits of 0.2.0 still apply. Also:

- A name can't contain `%`. A terminal session can only be named when Windows Terminal is installed; without it, a start or fork with a name is refused.
- A background start or fork usually answers in about 15 seconds, because the dashboard watches the new session for 10 seconds after `claude --bg` returns, to catch one that fails straight away. It can take up to about 40 seconds, or more if a folder's drive is slow to check. It can say a session failed, but not why.
- A session with no conversation saved yet, such as a terminal session that hasn't had a turn, can't be forked.
- An interactive session may wait at Claude Code's own trust prompt in a folder you haven't used before. The dashboard never answers it, and Claude Code doesn't list a session waiting there (BUG-22).
- A typed path that is a local link to a network share is refused, but resolving it first reaches the share. History and search check each past session's folder the same way, so a planted link of this kind is reached without you opening it.
- Resume from History is refused for a minute after a session's last activity, and while a session in the same folder is still starting, in case it's still running.
- History reads with its own transcript reader, so while it's open, the dashboard can read up to twice as much per poll. Once in testing, a first History page took 6.7 seconds, over FR-35's 5 seconds, just after a fork while another build was running; seven later first pages took 0.56 to 1.3 seconds.
- Search skips any single line of more than about a million characters, stops after 30 seconds with what it found, and shows snippets for at most 100 sessions.
- A very slow Windows PowerShell can make New session, Fork, or History wait up to 15 seconds to check a folder's drive. If it can't, the folder isn't used, and the result says so.

### Open bugs

The open bugs of 0.2.0 are unchanged: BUG-30 is Medium, and BUG-7, BUG-22, BUG-23, and BUG-29 are Low. No new bug is open.

### Accessibility

The dashboard is built towards WCAG 2.2 AA and passes automated accessibility scans and keyboard tests, but it doesn't claim conformance and **hasn't been tested with a screen reader** (decision 0021). The new forms, History, and Search are checked by browser tests for keyboard use, focus, labels, and announcements, and by automated scans in both themes. A live keyboard-only pass of the page found two focus bugs, fixed in this release (BUG-34, BUG-35).

### Not checked live

These weren't checked live on the final code, or at all. They're covered by automated tests and review:

- No live check ran on the final code. The verifier's repeats of background Start, Fork, refusals, History, and Search ran just before the last Testing fixes (BUG-34 to BUG-36).
- Interactive Start, interactive Fork, Fork and Resume from History, and the keyboard pass ran only before the security fixes. The Resume from History that was checked would now wait for the one-minute guard.
- New session or Fork in a folder Claude Code doesn't trust yet, and Claude Code's refusal messages. The agents' throwaway folders inherited trust.
- A background session that fails straight away.
- Mapped network drives, `subst` drives, and links to shares. Shares themselves were refused live.
- The "still starting" guard of Resume from History. Its one-minute guard was checked live.
- The 15-second limit on checking a folder's drive, and search's 30-second stop, long-line skip, and 100-session limit.
- Starting a terminal session without Windows Terminal installed.

## 0.2.0

The second release. It covers iteration 3. Get it from the GitHub release: clone the repository at the `v0.2.0` tag, then follow the README. It isn't published to npm.

cc-session-manager is an independent tool. It isn't made, endorsed, or supported by Anthropic.

**Upgrading from 0.1.0:** stop the old version, run `git fetch --tags`, check out `v0.2.0`, and run `pnpm install` and `pnpm build` again. The saved list of finished sessions carries over. Sessions that finished under 0.1.0 show no usage, because 0.1.0 didn't save it. Going back to 0.1.0 drops the saved usage the next time it saves the list.

### What's new

- Each session shows its token use, by input, output, cache writes, and cache reads, and an estimated cost at API list prices. A bar under the page heading adds them up for the listed sessions, and says which sessions it leaves out (FR-23, FR-24, FR-25).
- Finished sessions keep their token use and estimated cost after a restart. Going back to 0.1.0 drops the saved usage the next time it saves the list (FR-26).
- After the dashboard stops, deletes, or ends a session, programs it started that keep running are listed on its row, by name and process ID, with an "End leftover programs" button. A deleted session's row stays at the top of Finished, marked Deleted, until none of its programs run. The dialog lists the programs and says unsaved work in them is lost (FR-27).
- Active sessions stay in order of start time, newest first, instead of moving as their activity changes (BUG-6). A new session with no status yet shows "starting" (BUG-18).
- When Claude Code is slow to answer and the data is over 10 seconds old, the page says so, and that actions on sessions are paused (BUG-9).
- Before the first successful read of the session list, the page says it can't read sessions yet, instead of "No sessions to show" (BUG-17).
- If no browser opens, the printed sign-in link now works once, for 2 minutes, and the terminal says so and to restart for a new one. If a second start can't open a browser, the link it prints works once, for 60 seconds, and says so (FR-29, BUG-8).
- With the dashboard open in more than one tab, a notification that arrives just as the notifying tab closes is shown by the next tab instead of being lost (BUG-32).
- Screen readers no longer read the decorative triangles and dots, and each row reads as its name, then its status or reason, with pauses between (BUG-10). Announcements are queued, so one arriving straight after another isn't lost (BUG-16). When a focused expandable section disappears, focus moves to a heading instead of the page body (BUG-11).
- Reading transcripts for the first time after a start is spread over polls, stopping after about half a second of reading each time, so session updates aren't held up (NFR-11, BUG-33). In the measured case a poll's reading took at most 770 ms.
- A corrupt saved list is set aside once, with names removed, or deleted if it isn't JSON. Copies that 0.1.0 set aside are reduced to the newest one, scrubbed the same way (FR-30, BUG-12).
- A finished session's Finished row picks up lines written just after it ended, such as its model (BUG-27).
- Format warnings for transcripts are no longer raised by large lines or new header lines, and are raised when many lines in a row can't be read, or when replies no longer carry their message details (BUG-24, BUG-26).
- Other fixes from 0.1.0's open bugs: a stale session whose transcript can no longer be read keeps its last activity time, instead of moving to Needs you and being announced (BUG-13). A second session with no ID and no name is announced separately, by folder, kind, and start time (BUG-14). A new session's missing status is excused only when it really just started, for at most 10 seconds, and gaining an ID doesn't renew the excuse (BUG-19, BUG-20). A background session's start time no longer jumps by about 3 seconds once it has a process: the first one seen is shown and sorted on (BUG-23).

### Privacy and security

0.1.0's privacy and security notes still apply, with these changes:

- The tool now reads each session's whole transcript, from where it last stopped, rather than its last 256 KB. From each line it keeps only response IDs, model IDs, token counts, web-search counts, speed, routing, the timestamp, and the branch. It never keeps message text (C-12).
- Finished sessions are saved with their token counts by model, in the same file. Still no names, message text, or response IDs.
- A corrupt saved list is set aside once with its names removed, or deleted if it isn't JSON. 0.1.0's earlier copies are reduced to the newest one, scrubbed the same way, so set-aside files no longer hold names.
- Ending leftover programs runs a PowerShell helper that ends only programs the dashboard recorded before its own action, each checked by start time and program file. The page names only the session; the list comes from the dashboard's own record.
- Live updates now include a small message after each poll with only the age of the last successful read.
- If no browser opens, the printed sign-in link works once, for 2 minutes.

### Known limits

The known limits of 0.1.0 still apply, except where this release fixes them. Also:

- Estimated costs use Anthropic's API list prices of 9 November 2026. The price table is built into the tool, so it goes out of date when prices change, until a new release updates it. The estimates aren't what a Pro or Max plan costs, and a model missing from the table shows its tokens with no cost.
- Leftover programs are only found for sessions stopped, deleted, or ended from the dashboard while it runs. Programs started outside the session's process tree and the consoles of its programs, in the second between recording them and the action, or later by a program whose shell has gone, aren't found. The list is kept in memory, so it's gone after a restart.
- If recording a session's programs fails before Stop, Delete, End, or Force end, the action goes ahead, and its result says leftover programs can't be checked for that session.
- Ending leftover programs ends each one at once, with no chance to save. Programs whose start time or program file no longer match the record are skipped and named in the result.
- The first read of large transcripts after a start can take a few polls. While it runs, usage shows "still counting", and reading takes at most about 0.8 seconds per poll in the measured case.
- `claude -p` runs are still listed as interactive sessions, as Claude Code reports them (BUG-23).
- A background session's start time, as Claude Code lists it, moves when its process starts and again after Stop. The dashboard shows the first one it saw.
- Branch and model now come from the latest lines read from the whole transcript, not from its last 256 KB, so 0.1.0's limit about branch or model lines near the end of a transcript no longer applies.

### Open bugs

One open bug is Medium, and the rest are Low.

| ID     | Bug                                                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BUG-7  | Sessions with an inherited `CLAUDE_CODE_CHILD_SESSION` weren't listed by the CLI in one observation                                                                                      |
| BUG-22 | Claude Code doesn't list a session at a trust dialog                                                                                                                                     |
| BUG-23 | `claude -p` runs are listed as interactive sessions, as Claude Code reports them. The start-time part is fixed.                                                                          |
| BUG-29 | A terminal started by Open might keep the tool's output open after the tool exits. It was seen once and couldn't be reproduced, and a guard test now checks it.                          |
| BUG-30 | **Medium.** After Stop or Delete, programs the session started can keep running. This is Claude Code's behavior. The dashboard now lists them and can end them, within the limits above. |

### Accessibility

The dashboard is built towards WCAG 2.2 AA and passes automated accessibility scans and keyboard tests, but it doesn't claim conformance and **hasn't been tested with a screen reader**. Planned testing with NVDA was dropped (decision 0021). This release's screen-reader fixes (BUG-10, BUG-11, BUG-16) are checked by browser tests only.

### Not checked live

These were checked by automated tests and review, but not on real sessions:

- Delete on a session whose worktree has unsaved work, which Claude Code should keep (L10, skipped by decision 0022).
- A notification arriving while the dashboard tab is hidden.
- The printed sign-in link when the browser really fails to open, and the BUG-32 hand-over between tabs in a real browser with real notifications.
- Usage from subagents. The live check used a session with none.
- The totals bar on real sessions, and saved usage surviving a restart or a downgrade to 0.1.0.
- A corrupt saved list being set aside or deleted (FR-30).
- The security review's L-1 fix in the helper, which came after the live checks.

## 0.1.0

The first release. It covers iterations 1 and 2. Get it from the GitHub release: clone the repository at the `v0.1.0` tag, then follow the README. It isn't published to npm.

cc-session-manager is an independent tool. It isn't made, endorsed, or supported by Anthropic.

### What it does

cc-session-manager is a dashboard for your Claude Code sessions. It runs on your own computer and opens in your browser.

**Monitoring:**

- Lists your running interactive and background sessions.
- Puts sessions that need you first, with the reason, and shows the count in the browser tab title.
- Marks sessions that newly need you for screen readers to announce. See Accessibility.
- Moves blocked sessions with no activity for over 7 days to a collapsed Stale group. A session with an open prompt or unknown activity is never moved there.
- Shows each session's name, project folder, kind, status, start time, running time, git branch, model, and last activity. A live interactive session also shows its process ID, so you can find its terminal.
- Keeps finished sessions listed for 24 hours, including after a restart.

**Desktop notifications**, once you turn them on from the page:

- When a session newly needs you, or its reason changes.
- When a background session finishes or a session fails.
- When the tool can't read sessions three times in a row.

A notification shows only the project folder and the reason, and clicking it highlights the session's row. Notifications only arrive while the dashboard page is open. They're meant to arrive while it's in the background too, but delivery to a hidden tab hasn't been checked live. Your own actions from the dashboard don't notify.

**Actions** on each row:

- **Open** a background session in a new terminal, through `claude attach`.
- **Resume** a finished interactive session in a new terminal, through `claude --resume`, in its original folder.
- **Stop** a background session. The conversation is kept.
- **Delete** a background session, through plain `claude rm`.
- **End** a live interactive session by asking it to close normally, and **Force end** it if that doesn't work.

Stop, Delete, End, and Force end ask you to confirm first, and the dialog names the session. Results appear on the row in the tool's own words. If the result can't be confirmed, the page says it's unknown.

### What it doesn't do yet

- It can't answer prompts, send messages, start, rename, or fork sessions, or show history, search, cost, or token use.
- It can't jump to a live session's existing terminal.
- It can't force a delete that Claude Code refused.
- Only Windows is tested, and opening a terminal is Windows-only. It needs Node 24 or later, pnpm, and Claude Code installed.

### Safety rules for actions

- **Delete never forces.** The tool never passes `claude rm`'s `--discard-unpushed` or `--force-remove-worktree` flags. If Claude Code keeps a session to protect its work, the page says so and you finish in the CLI.
- **Actions use a fresh listing.** Stop, Delete, End, and Resume are refused while the latest refresh has failed or the list is more than 10 seconds old. The server then rechecks the session against a new listing before acting.
- **End checks the process.** Immediately before each signal, End checks that the process ID still belongs to the session. Force end is only accepted for the same process within 2 minutes of a normal close.
- **The starting session is protected.** If you start the dashboard from inside a Claude Code session, that session has no Stop, Delete, or End. If the tool can't find it in the list, those actions are off for every session, and the page says why.
- **One action at a time.** Each session runs one action at a time, and nothing retries automatically.
- **No folder search.** Programs are never looked up in a session's folder, so a program planted there can't run.

### Privacy and security

- The server listens on `127.0.0.1` only, and needs a one-time sign-in link and a session cookie.
- Browsers send a cookie to every port on a computer, so sign-in also gives the page a key, kept in browser storage that's separate for each port. Actions and live updates need both the cookie and the key, so another program on your computer can't use a cookie it obtains. Chrome may record the sign-in address, which holds the key, in your history. The key changes each time the tool starts.
- Actions need a request from the dashboard's own page. The page names an action and a session, and the tool builds the command from its own data.
- A second start of the tool opens the running one instead, through a lock file, `instance.json`, in the same folder. That file holds a secret that's as exposed as the finished-sessions file, because any program running as you can read both.
- Nothing is sent off your computer by the tool itself. It runs `claude agents --json --all`, and doesn't assess what that command does.
- It reads the last 256 KB of each session's transcript, and keeps only the branch, model, and timestamp.
- Finished sessions are saved in plain text in `%LOCALAPPDATA%\cc-session-manager\finished-sessions.json`. The file holds project paths, branch, model, session IDs, and times, but no names or message text. Project paths and branch names can themselves reveal your username or client names.
- A completed background session stays in that file while Claude Code still lists it, even after it leaves the page. A corrupt older file is set aside unchanged, so it could still hold names.
- Live session names come from Claude Code, which can use your prompt as the name until a title is generated, so the page and screen-reader announcements can show prompt text. A session that ends before it has a title keeps showing that text under Finished until the row leaves or the tool restarts. A background session Claude Code still lists keeps whatever name it reports.
- If opening the browser fails with an error, the one-time sign-in link is printed to the terminal. If you lose the sign-in cookie or switch browsers, restart the tool for a new link.

### Known limits

**Actions and notifications:**

- After Stop or Delete, programs the session started, such as a long-running command, can keep running, and a deleted session's shell can keep its folder locked. This is Claude Code's behavior, and the dialogs say so (BUG-30).
- End sends Ctrl+Break, which also reaches the shells that started the session.
- A session started from Git Bash can't be closed normally from here, so End offers Force end straight away.
- With npm's `claude.cmd`, the terminal shows "Terminate batch job (Y/N)?" after End.
- Resume runs in the session's original folder, so Claude Code loads that folder's own settings, as it would if you resumed it by hand.
- Resume disappears up to about 13 seconds after a session's folder is deleted. A `\\server\share` folder isn't checked in advance, but Resume is still refused if the folder has gone. A mapped drive letter is checked like a local folder.
- Notifications only work while the page is open, and don't show session names, so similar sessions in one folder look alike. A crashed interactive session sends no notification.
- Ending a session, or a Force end, can lose work in progress.

**Monitoring:**

- Interactive sessions that end while the tool is off aren't listed.
- After a restart, finished sessions show as unnamed unless Claude Code still lists them.
- A background session you delete with `claude rm` leaves the dashboard straight away. If Claude Code ever removes completed sessions itself within 24 hours, they would leave early too.
- A session sitting at a trust dialog isn't listed by Claude Code, so it can't be shown.
- Sessions started from inside another Claude Code session may not be listed.
- Branch shows as unavailable for a session started outside a repository, for a detached HEAD, and for a repository created after the session started. A branch or model not found near the end of a transcript also shows as unavailable.
- End times are approximate, because Claude Code doesn't report them. A completed background session counts as finishing when the tool first sees it, so its end time can be well off, and older ones can appear as newly finished on first run.
- When no timestamp can be read, last activity comes from the file's modified time, which ran up to about 87 hours later than the real last activity on the files tested. A session can reach Stale late, and a touched file can cause a false alert.
- A new session could raise a false warning for one refresh, if its first listing stays incomplete across two refreshes.
- The tool depends on Claude Code's local files and command output, which may change between versions.

### Open bugs

One open bug is Medium, and the rest are Low.

| ID     | Bug                                                                                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BUG-6  | Rows move within Active when activity times change or appear                                                                                                                                                                         |
| BUG-7  | Sessions with an inherited `CLAUDE_CODE_CHILD_SESSION` weren't listed by the CLI in one observation                                                                                                                                  |
| BUG-8  | The login token prints to the terminal when the browser launch fails                                                                                                                                                                 |
| BUG-9  | No signal that data is stale while the CLI is slow, for up to 15 seconds                                                                                                                                                             |
| BUG-10 | Screen-reader noise: triangles, dots, and name and reason run together                                                                                                                                                               |
| BUG-11 | Focus falls to the page body when the focused expandable section disappears                                                                                                                                                          |
| BUG-12 | A corrupt older file is set aside with any names still inside                                                                                                                                                                        |
| BUG-13 | A stale session with no readable transcript file can move to Needs you and be announced                                                                                                                                              |
| BUG-14 | A second session with no ID and no name isn't announced separately                                                                                                                                                                   |
| BUG-16 | A screen-reader announcement can be lost if a second update arrives within 100 ms, which is only likely around a reconnect                                                                                                           |
| BUG-17 | After a failed first poll, the page says it is showing last known data and also "No sessions to show"                                                                                                                                |
| BUG-18 | A new interactive session whose first listing has no `status` reads `unknown` for one refresh                                                                                                                                        |
| BUG-19 | A missing status doesn't warn on a session's first listing, which also covers existing sessions when the tool starts. A session that keeps leaving the list or changes its ID could avoid the warning, though this hasn't been seen. |
| BUG-20 | A session listed first with no ID and no status warns, and is then excused once it gets an ID                                                                                                                                        |
| BUG-22 | Claude Code doesn't list a session at a trust dialog                                                                                                                                                                                 |
| BUG-23 | A background session's start time shifts by about 3 seconds, and `claude -p` runs are listed as interactive                                                                                                                          |
| BUG-24 | False format warnings remain possible, if Claude Code adds a new kind of header line, or writes a very large line that hides the last timestamp, until the next timestamped line                                                     |
| BUG-26 | Some format changes raise no warning: all lines malformed, or `message` renamed while `timestamp` stays                                                                                                                              |
| BUG-27 | A very short session can keep older details on its Finished row, such as "Model unavailable"                                                                                                                                         |
| BUG-29 | A terminal started by Open might keep the tool's output open after the tool exits. It was seen once and couldn't be reproduced.                                                                                                      |
| BUG-30 | **Medium.** After Stop or Delete, programs the session started can keep running. This is Claude Code's behavior, and the dialogs say so.                                                                                             |

### Accessibility

The dashboard is built towards WCAG 2.2 AA and passes automated accessibility scans and keyboard tests, but it doesn't claim conformance and **hasn't been tested with a screen reader**. Screen-reader announcements are in place, but whether and how they're read out is unverified, and BUG-10 lists likely noise. The action buttons and dialogs work with the keyboard and pass the same automated checks, and haven't been tested with a screen reader either (decision 0016).

### Not checked live

These were checked by automated tests and review, but not on real sessions:

- Delete on a session whose worktree has unsaved work, which Claude Code should keep (L10, deferred by decision 0016).
- A notification arriving while the dashboard tab is hidden. One was checked with the window in the background, but the page still counted as visible.
