# cc-session-manager

A local dashboard for your Claude Code sessions. It shows which sessions need you, sends desktop notifications, and lets you open, resume, stop, delete, or end sessions from your browser.

cc-session-manager is an independent, open-source tool. It isn't made, endorsed, or supported by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC.

## Requirements

- Windows. Other platforms aren't tested, and opening a terminal is Windows-only.
- Git.
- [Node.js](https://nodejs.org/) 24 or later.
- [pnpm](https://pnpm.io/). On Node 24, running `corepack enable` once sets up the version this project uses. Later Node versions don't include corepack, so install it or pnpm first.
- [Claude Code](https://code.claude.com/), installed and signed in.

## Install and run

```
git clone --branch v0.1.0 https://github.com/napalmCore/cc-session-manager.git
cd cc-session-manager
pnpm install
pnpm build
pnpm start
```

The tool starts a server on `127.0.0.1` and opens the dashboard in your browser with a one-time sign-in link. Press Ctrl+C in its terminal to stop it. Starting it again while it runs opens the running one instead.

To use Stop, Delete, and End on every session, start it from a normal terminal, not from inside a Claude Code session. A session that starts the dashboard is protected from those actions.

## What it does

- Lists your interactive and background sessions, puts the ones that need you first, and keeps finished ones for 24 hours.
- Sends a desktop notification when a session needs you, finishes, or fails, while the page is open. Turn them on from the page.
- Opens or resumes a session in a new terminal, and stops, deletes, or ends one after you confirm.

See the [release notes](docs/release-notes.md) for details, the safety rules for actions, privacy, and known limits.

## Privacy

The tool itself sends nothing off your computer. It runs `claude agents --json --all`, and Open and Resume start Claude Code, which works as it normally does. It reads a little metadata from session transcripts, and saves finished sessions, without their names or message text, in `%LOCALAPPDATA%\cc-session-manager`. A damaged older file is set aside unchanged, so it could still hold names.

## Development

`pnpm check` runs type checks, lint, formatting, and unit tests. `pnpm test:e2e` builds and runs the browser tests. The project's requirements, design, test plan, and decisions are in [`docs/`](docs/README.md).

## License

[MIT](LICENSE)
