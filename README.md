# pi-iterm-session

[![pi releases tested](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/keen99/pi-iterm-session/main/latest-tested.json)](https://github.com/keen99/pi-iterm-session/actions/workflows/release-watch.yml)

Ties pi sessions to iTerm2 tabs so you can find and resume the right session from the right terminal tab.

## How it works

iTerm2 gives every tab a stable `ITERM_SESSION_ID` (survives iTerm restarts with session restore). On every session start, the extension records that id into the session itself as a custom entry (`iterm-session/v1`). Sessions know their tab; nothing else is stored — no sidecar files, no PATH shims.

`/iterm-session` lists the sessions bound to the current tab, newest first, with age and first-message preview:

```
Sessions from this iTerm tab — resume one?
  1m ago · refactor storage
  2h ago · fix auth middleware
  Start new session
```

Pick one → in-place session switch. Escape → stay. `Start new session` → stay on the fresh session.

## Commands

| Command | Effect |
|---|---|
| `/iterm-session` | Show this tab's id and open the session picker. |
| `/iterm-session <tabId>` | Same picker for another tab id. |
| (startup) | Binds the tab automatically. A fresh session with tab history shows a hint: `N prior session(s) for this iTerm tab — /iterm-session to resume.` |

## Limits

- **Startup auto-resume is not possible on pi 0.75.4**: `session_start` receives a base context without `switchSession` (command context only). Switching is command-only. If pi later exposes `switchSession` on event contexts, the startup hint becomes a one-key prompt.
- **tmux**: all panes share one `ITERM_SESSION_ID`; last writer wins.
- **ssh**: the id propagates, so remote pi binds your local tab — intended.
- **Lazy session persistence**: pi writes session files only after the first assistant message. A binding created in a session that never got a reply exists only in memory until then.
- Scan cost: reads only the current project's session directory (`~/.pi/agent/sessions/<encoded-cwd>/`), substring gate before JSON parsing, ~milliseconds.

## Install

Add to `~/.pi/agent/settings.json` packages:

```json
"/Users/draistrick/git/keen99/pi-iterm-session"
```

Then `/reload`.

## Development

```sh
npm run check       # typecheck + unit tests (fake fs, no pi process)
node test/rpc-smoke.mjs   # real pinned-pi load + command registration
```

`PI_TEST_BIN` overrides the pi binary in the smoke test. Tests use synthetic sessions in temp dirs; never touches real sessions.

MIT.
