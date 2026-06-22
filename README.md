# pi-podcast

A Pocket Casts podcast player that lives inside [pi](https://pi.dev).

Browse your subscriptions, search the catalog, pick up where you left off, and play episodes in [mpv](https://mpv.io) — all from the `/podcast` command.

## Install

```bash
pi install git:github.com/Lukather/pi-podcast
```

Or, for a quick test without installing:

```bash
pi -e git:github.com/Lukather/pi-podcast
```

You'll also need `mpv` on your `PATH`:

```bash
# Windows
winget install mpv

# macOS
brew install mpv

# Linux
sudo apt install mpv   # or your distro's equivalent
```

## Setup

1. Sign in to Pocket Casts Plus (this extension uses the Pocket Casts web API, which requires a Plus subscription):

   ```
   /podcast login
   ```

2. Your email and password go straight to Pocket Casts. Tokens are stored in the OS keychain (Windows Credential Manager / macOS Keychain / Secret Service). If no keychain is available, a `0600` file is written to `~/.config/pi/podcast.json`.

3. That's it. Try `/podcast` for the interactive menu.

## Usage

| Command | What it does |
|---|---|
| `/podcast` | Interactive main menu |
| `/podcast login` | Email + password → store token in OS keychain |
| `/podcast logout` | Forget token |
| `/podcast subs` | List subscriptions → pick → episodes → play |
| `/podcast new` | New releases → pick → play |
| `/podcast continue` | In-progress episodes → pick → resume |
| `/podcast search <query>` | Search → pick podcast → episodes → play |
| `/podcast trending` / `popular` / `featured` | Browse public lists |
| `/podcast pause` / `resume` / `stop` | Playback control |
| `/podcast now` | Show what's playing and where |
| `/podcast ff` / `rew` | Skip +30s / -15s |
| `/podcast seek <seconds>` | Jump to absolute position |
| `/podcast position` | Show current position |

A progress bar widget appears above the editor while something is playing. Position is synced back to Pocket Casts every 15s, on pause/stop, and on session shutdown.

## Platform notes

- **Windows** — mpv IPC uses named pipes (`\\.\pipe\mpv-podcast-<pid>-<ts>`) because the common Windows mpv builds ship without TCP IPC.
- **macOS / Linux** — TCP IPC on `127.0.0.1` with an OS-assigned port.
- The mpv binary is auto-discovered from `PATH` plus a few common install locations (winget, `Program Files`, etc.).

## License

MIT — see [LICENSE](./LICENSE).
