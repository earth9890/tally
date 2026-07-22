# Tally

Local-first, automatic personal time tracker for macOS. Tally counts your day
the way people do — apps, windows, URLs, focus — and keeps every byte in a local
SQLite file. Nothing leaves your machine.

Visual design follows the imported *Tally* brand kit — see [DESIGN.md](DESIGN.md).

## Features

- **Automatic app / window tracking** — samples the foreground app and window
  title on an interval, groups into segments.
- **URL tracking** — captures the active browser tab URL (Chrome, Safari, etc.)
  when Screen Recording permission is granted.
- **Idle detection** — auto-marks time as idle after N seconds without keyboard
  or mouse input (default 5 min).
- **Productivity tags** — tag each app productive / neutral / unproductive;
  productivity % = productive time ÷ total active time.
- **Menu-bar app** — tray shows today's total; menu has current app,
  productivity %, pause/resume, quit.
- **Launch at login** — starts automatically in the menu bar at login
  (on by default; toggle in Settings). Registered via the macOS login-item API;
  shows as "Electron" until packaged as `Tally.app`.
- **Dashboard** — today totals, this-week bar chart, productivity doughnut,
  top apps.
- **History** — per-day timeline bar + segment list, pick any past day.
- **Categories & Settings** tabs.

## Requirements

macOS. Grant the **Electron** binary these permissions in
*System Settings → Privacy & Security*, then restart the app:

- **Accessibility** — read the foreground app + window title.
- **Screen Recording** — read browser tab URLs.

Without them, tracking still runs but records apps as `Unknown` / no URL.

## Run

```bash
npm install                       # installs deps
npm run rebuild                   # build better-sqlite3 for Electron (if needed)
npm start
```

If `npm install` runs with `NODE_ENV=production`, dev deps (Electron) are
skipped — use `NODE_ENV=development npm install --include=dev`.

## Data location

`~/Library/Application Support/Tally/desktime.db` (SQLite, WAL mode).

## Stack

Electron · better-sqlite3 · get-windows (prebuilt Swift binary) · Geist type ·
vanilla renderer with pure-CSS/SVG charts. No React, no chart lib, no bundler.

## Building & releases

Packaged with **electron-builder**, published to **GitHub Releases**.

```bash
npm run dist                       # build a local .dmg + .zip in dist/ (no upload)
GH_TOKEN=$(gh auth token) npm run release   # build + upload to GitHub Releases
```

`npm run release` bumps nothing on its own — set the version in `package.json`
first, then run it. It uploads `Tally-<ver>-arm64.dmg`, the `.zip`, and
`latest-mac.yml` (the update manifest) to a release tagged `v<version>`.

## Updates

The app uses **electron-updater**. On launch (and hourly) a packaged build
checks the GitHub Releases `latest-mac.yml`; if a newer version exists it
downloads the `.zip` in the background and notifies the user to restart.

Release a new version:

1. Bump `version` in `package.json` (e.g. `0.1.0` → `0.2.0`).
2. `GH_TOKEN=$(gh auth token) npm run release`.
3. Done — existing installs pick it up automatically.

> **macOS signing:** unsigned builds still *notify* about updates, but macOS
> only auto-*applies* them for apps signed with an Apple Developer ID (+
> notarization). To enable silent auto-update, add signing credentials to the
> `mac` build config. Until then, users download the new `.dmg` manually
> (right-click → Open the first time, since it's unsigned).

## Not included (yet)

Multi-user/teams, cloud sync, private-time mode, data export, code signing.
Say the word to add any.
