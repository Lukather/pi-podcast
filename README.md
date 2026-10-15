# pi-podcast

A Pocket Casts podcast player that lives inside [pi](https://pi.dev).

[![CI](https://github.com/Lukather/pi-podcast/actions/workflows/ci.yml/badge.svg)](https://github.com/Lukather/pi-podcast/actions/workflows/ci.yml)

<img width="601" height="405" alt="image" src="https://github.com/user-attachments/assets/2047529d-cb32-4c11-94a0-f602f0f2b0f3" />

Browse your subscriptions, search the catalog, pick up where you left off, and play episodes in [mpv](https://mpv.io) — all from the `/podcast` command.

## Requirements

- **[Pocket Casts](https://pocketcasts.com) account with a Plus subscription.** This extension talks to the Pocket Casts web API, which is gated behind Plus. Free accounts will fail at login. Without an account, you can still browse Trending, Popular, and Featured and play episodes from those lists.
- **[mpv](https://mpv.io) media player.** Episodes are streamed straight into mpv via IPC. The binary is auto-discovered from `PATH` plus a few common install locations (winget, `Program Files`, etc.) on Windows.
  ```bash
  # Windows
  winget install mpv

  # macOS
  brew install mpv

  # Linux
  sudo apt install mpv   # or your distro's equivalent
  ```

## Install

```bash
pi install npm:pi-podcast
```

Or, for a quick test without installing:

```bash
pi -e npm:pi-podcast
```

You can also install straight from the git repo:

```bash
pi install git:github.com/Lukather/pi-podcast
```

## Setup

1. Sign in with your Pocket Casts email and password:

   ```
   /podcast login
   ```

2. Your email and password go straight to Pocket Casts. Tokens are stored in the OS keychain (Windows Credential Manager / macOS Keychain / Secret Service). If no keychain is available — common on headless Linux, WSL, and CI runners — a `0600` file is written to `~/.config/pi/podcast.json` instead.

3. That's it. Try `/podcast` for the interactive menu.

## Usage

| Command | What it does |
|---|---|
| `/podcast` | Interactive main menu |
| `/podcast login` | Email + password → store token (Plus required) |
| `/podcast logout` | Forget token |
| `/podcast subs` | List subscriptions → pick → episodes → play (Plus) |
| `/podcast new` | New releases → pick → play (Plus) |
| `/podcast continue` | In-progress episodes → pick → resume (Plus) |
| `/podcast search <query>` | Search → pick podcast → episodes → play (Plus) |
| `/podcast trending` / `popular` / `featured` | Browse public lists (work without an account) |
| `/podcast pause` | Pause playback |
| `/podcast resume` / `unpause` | Resume playback |
| `/podcast stop` | Stop playback |
| `/podcast now` | Show what's playing and where |
| `/podcast ff` / `rew` | Skip +30s / -15s (relative) |
| `/podcast seek <seconds>` | Jump to absolute position |
| `/podcast position` | Show current position |

A progress bar widget appears above the editor while something is playing. Position is synced back to Pocket Casts every 15s, on pause/stop, and on session shutdown. The Subscriptions, New releases, Continue listening, and Search menu entries carry ` (Plus)` while you're logged out, so the gate is visible before you click.

## Platform notes

- **Windows** — verified. mpv IPC uses named pipes (`\\.\pipe\mpv-podcast-<pid>-<ts>`) because the common Windows mpv builds ship without TCP IPC. The mpv binary is auto-discovered from `PATH`, winget, `Program Files`, and similar locations.
- **Linux** — verified. mpv IPC uses a unix domain socket, because mpv has no TCP IPC; the socket lives in `$XDG_RUNTIME_DIR` (or `/tmp`) and is removed on stop. mpv must be on `PATH` (no extra install paths checked).
- **macOS** — best-effort on the same Unix code path as Linux. Not verified by the maintainer because no Apple hardware is available.

## Known limitations

- **Subscriptions show no play state.** The Pocket Casts `show_notes` endpoint is public and does not return per-user position, so picking an episode from a subscription always plays it from the start.
- **20-episode cap per podcast.** Older episodes are not exposed in the picker. The cap is applied when fetching episodes for a podcast and covers all the user-facing flows (Subscriptions, New releases, Search, the public lists).
- **Position sync requires Plus.** Without an account, playback still works, but the progress widget appends ` — progress not syncing (not logged in)` and no position is sent back to Pocket Casts.

## Troubleshooting

- **`mpv not found. Install it: winget install mpv`** — mpv isn't on `PATH` and isn't in any of the discovered install locations. Install it for your platform (see Requirements) and make sure the binary is reachable from your shell.
- **`Login failed: <API message> — a Pocket Casts Plus account is required. ...`** — your account doesn't have Plus. The extension still works without login for Trending, Popular, and Featured.
- **Tokens fall back to a file at `~/.config/pi/podcast.json` with mode `0600`** — this is the expected fallback on headless Linux, WSL, and CI runners when no keychain is available. The file holds real Pocket Casts access tokens, so leave its permissions tight and don't check it in.
- **An episode plays but the progress widget shows `… — progress not syncing (not logged in)`** — you started playback from a public list without an active session. Log in with `/podcast login` (Plus required) to start syncing position again.

## License

MIT — see [LICENSE](./LICENSE).
