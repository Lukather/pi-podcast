# Pre-release Checklist

This checklist covers what the test harness cannot: the player lifecycle
against a real Pocket Casts account and real mpv. Run it before every
release, on a machine where the maintainer (or release engineer) is the
tester.

Failures should be fixed or filed as a new issue, not silently ignored.
Link the resulting ticket numbers in the **Findings** section below.

The harness ([#10](https://github.com/Lukather/pi-podcast/issues/10))
already covers pure logic, command dispatch, and the API layer with
stubbed `fetch` and no mpv. CI ([#11](https://github.com/Lukather/pi-podcast/issues/11))
runs `npm test` and `npm run typecheck` on every push to `main`. Both
must be green before this checklist is meaningful.

## Prerequisites

- [ ] **mpv** is installed and reachable from `PATH`, or in one of the
      auto-discovery paths the extension checks (`Program Files\MPV
      Player`, winget packages, etc.). `mpv --version` should print.
- [ ] A **Pocket Casts Plus** account you can log in with.
- [ ] The repo checked out at the commit you're releasing.
- [ ] `npm install` has been run; `npm run typecheck` and `npm test`
      are both green.

## Environment

| Field | Value |
|---|---|
| Date | |
| Tester | |
| OS | |
| Node version | `node --version` |
| mpv version | `mpv --version \| head -1` |
| Package version | |
| Commit | `git rev-parse HEAD` |

## Setup

- [ ] **One registration only.**
      ```
      pi list | grep podcast
      ```
      Expected: a single match for the package. There must be no stale
      copy at `~/.pi/agent/extensions/podcast.ts` (see
      [#7](https://github.com/Lukather/pi-podcast/issues/7)).
- [ ] **Log in.**
      ```
      /podcast login
      ```
      Enter your Pocket Casts email and password. Expected: a notify
      reads `Logged in as <your email>` at `info` severity.
- [ ] **File fallback exists.**
      ```
      ls ~/.config/pi/podcast.json
      ```
      (On Windows, under `%USERPROFILE%`.) Expected: the file exists,
      mode `0600`. If mpv sees a keyring, tokens live in the keyring
      instead — that's also OK, but it should match the README.

## Player lifecycle checks

### 1. Play from a public list (no Plus required)

- [ ] `/podcast trending` (or `popular` / `featured`), pick a podcast,
      pick an episode.
- Expected: a progress bar widget appears above the editor.
- Expected: a `Now playing: …` notify fires at `info` severity.

### 2. Pause / resume

- [ ] While playing: `/podcast pause`.
- Expected: widget shows the paused glyph (⏸). Position stops advancing.
- [ ] `/podcast resume`.
- Expected: widget shows the playing glyph (▶). Position advances
  again.
- [ ] `/podcast unpause` (alias).
- Expected: behaves the same as `/podcast resume`.

### 3. Absolute `/podcast seek` vs `/podcast ff` / `/podcast rew`

- [ ] `/podcast position` — note the current position.
- [ ] `/podcast seek <n>` where `<n>` is well past the current position.
- Expected: notify reads `Seeking to <MM:SS>.` and the player jumps.
- [ ] `/podcast ff`.
- Expected: position advances by ~30s.
- [ ] `/podcast rew`.
- Expected: position moves back by ~15s.

The asymmetry is intentional: `seek` is absolute, `ff` / `rew` are
relative. Both must surface distinct, correct behavior.

### 4. Switch episodes mid-play (the SIGKILL race)

- [ ] Start playing episode A.
- [ ] While A is playing, open `/podcast trending` (or `subs` / `new`)
      and pick episode B.
- Expected: A stops cleanly, B starts. Exactly one `mpv` process is
  running (verify with Task Manager / `ps` / `pgrep`).
- Expected: no orphaned `mpv` processes left behind from episode A.

If you see two `mpv` processes after switching, the SIGKILL race
regressed. File a ticket.

### 5. Stop mid-episode, episode stays in-progress

- [ ] Play an episode, let it run for ~30 seconds.
- [ ] `/podcast stop`.
- Expected: widget disappears. `/podcast now` reports `Nothing playing.
- [ ] `/podcast continue`.
- Expected: the same episode is at the top of the list, with the
  position you stopped at — not 0, not finished.

If the episode shows up at position 0, sync is regressed. File a
ticket.

### 6. Let one finish (status `played`)

- [ ] Pick an episode that's short, or jump near the end with
      `/podcast seek <n>`.
- [ ] Let it play to the end without stopping.
- Expected: mpv exits on its own. The widget disappears.
- Expected: the episode disappears from `/podcast continue`
  (Continue listening only shows in-progress episodes).
- Expected: the episode shows up as played in the Pocket Casts web app.

### 7. Kill mpv mid-play, confirm clean state

- [ ] Start playing an episode.
- [ ] In a separate terminal:
      - Windows: `taskkill /IM mpv.exe /F`
      - macOS / Linux: `pkill -9 mpv`
- Expected: pi doesn't crash. The widget disappears.
- [ ] `/podcast now` immediately after.
- Expected: `Nothing playing.` (because mpv is gone).
- Expected: a follow-up `/podcast trending` (or any) command works
  normally — no zombie IPC socket, no leaked state.

If a follow-up command hangs or crashes, the cleanup regressed. File a
ticket.

### 8. Continue listening carries the right position

- [ ] Play an episode to ~50% (or seek to `/podcast seek <halfway>`).
- [ ] `/podcast stop` (so it's in-progress, not playing).
- [ ] Quit pi.
- [ ] Reopen pi.
- [ ] `/podcast continue`.
- Expected: the episode is at the top with `playedUpTo` ≈ 50%, not 0,
  not finished.

If the position is wrong (much lower or much higher), sync regressed.
File a ticket.

## README command table

Run each command from the [Usage](../README.md#usage) section once
against the live session. A command that's missing, broken, or that
the README doesn't describe accurately is a documentation or
implementation bug — file a ticket.

- [ ] `/podcast` (open menu, dismiss)
- [ ] `/podcast login` (already done in Setup; verify here too) and
      `/podcast logout`
- [ ] `/podcast subs` (Plus)
- [ ] `/podcast new` (Plus)
- [ ] `/podcast continue` (Plus) — covered in check 5 / 8 above
- [ ] `/podcast search <a-known-title>` (Plus) — expected: results
      surface a podcast to pick
- [ ] `/podcast search <random-gibberish>` — expected: notify reads
      `Search failed: /discover/search failed: 400` or similar
- [ ] `/podcast trending` (no Plus) — covered in check 1
- [ ] `/podcast popular` (no Plus)
- [ ] `/podcast featured` (no Plus)
- [ ] `/podcast pause` / `/podcast resume` / `/podcast unpause` —
      covered in check 2
- [ ] `/podcast stop` — covered in check 5
- [ ] `/podcast now`
- [ ] `/podcast ff` / `/podcast rew` — covered in check 3
- [ ] `/podcast seek 120` (valid), `/podcast seek` (missing arg),
      `/podcast seek banana` (non-numeric) — covered in check 3 plus
      the argument-validation paths
- [ ] `/podcast position`

## Free-path UI

- [ ] `/podcast logout` if you're authed.
- [ ] `/podcast` (open menu).
- Expected: the four account entries (`📚 Subscriptions`,
  `🆕 New releases`, `⏯  Continue listening`, `🔎 Search`) carry
  ` (Plus)`. The three public lists (`📈 Trending`, `🔥 Popular`,
  `⭐ Featured`) don't.
- [ ] Pick `📚 Subscriptions (Plus)`.
- Expected: notify reads the `NEEDS_PLUS` guard message at `warning`
  severity.

If the labels don't carry ` (Plus)`, the free-path UI copy regressed
(see [#16](https://github.com/Lukather/pi-podcast/issues/16)). File a
ticket.

## Findings

| # | Title |
|---|---|
| | |

## Sign-off

If every box above is checked, the release can proceed. The release
ticket ([#14](https://github.com/Lukather/pi-podcast/issues/14)) is the
action item — link any tickets from **Findings** in its description so
they ship alongside the release or get their own version bump.