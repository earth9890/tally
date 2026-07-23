# CLAUDE.md

Guidance for Claude Code (and humans) working on **Tally** — a local-first,
automatic time tracker for macOS. Menu-bar Electron app, everything stored in
local SQLite, no server.

## Docs

- **DESIGN.md** — the visual design system (warm Geist "Tally" brand). Follow it
  for any UI work; tokens live in `src/renderer/styles.css`.
- **DEPLOY.md** — the complete release runbook: version bump → GitHub Release →
  Homebrew cask. Read it before shipping anything.

## Architecture (5 source files + renderer)

```
src/main.js        app lifecycle, tray + custom popover window, IPC, icons, auto-update
src/tracker.js     polls foreground app (get-windows) + idle (powerMonitor), writes segments
src/db.js          better-sqlite3: segments, categories, settings, reminders, app_meta
src/reminders.js   scheduler: daily/interval/goal reminders → Notification + `say`
src/preload.js     contextBridge — the only renderer↔main surface
src/renderer/      index.html + app.js (dashboard window), popover.html + popover.js (tray panel)
```

Vanilla JS everywhere. No React, no bundler, no chart lib — charts are CSS/SVG.

## Conventions

- Renderer global for the bridge is `dt` (`const dt = window.api`). **Never name a
  top-level renderer variable `api`** — it collides with an existing global and the
  SyntaxError kills the whole script silently.
- Escape all dynamic strings with `esc()` before `innerHTML`.
- Data stays local. No analytics, no network calls except the update check.
- Commits: plain messages, **no Claude co-author trailer**.

## Hard-won gotchas (do not rediscover these)

- **get-windows**: calling it without macOS Screen Recording permission makes its
  Swift binary block forever on the permission prompt. Always check
  `systemPreferences.getMediaAccessStatus('screen')` first and pass
  `{ screenRecordingPermission: false }` when not granted (app name/bundle/path
  still works; only titles/URLs need the permission).
- **App icons**: `app.getFileIcon()` returns a generic placeholder for `.app`
  bundles and `qlmanage` hangs. Read the bundle's `.icns` (CFBundleIconFile) and
  convert with `sips` (see ICON_SH in main.js).
- **Window**: `fullscreenable: false` is deliberate — native fullscreen hides the
  menu bar and with it the tray icon.
- **Popover**: shown with `showInactive()` + visibleOnAllWorkspaces +
  skipTransformProcessType so it floats over any Space without yanking the user
  to Tally's Space. Focusing it would reintroduce that bug.
- **npm install**: this shell exports `NODE_ENV=production` — devDependencies get
  skipped. Use `NODE_ENV=development npm install --include=dev`. npm is wrapped
  by Socket (`SOCKET_CLI_ACCEPT_RISKS=1` for non-interactive runs).
- **better-sqlite3** must be rebuilt for Electron: `npm run rebuild`.
- **Python 3.12+** removed `distutils`; node-gyp needs `python3 -m pip install
  --break-system-packages setuptools` on fresh machines.

## Dev flags (env vars, all optional)

- `DT_SHOW=1` — open the dashboard window on launch (always-on-top, centered)
- `DT_TAB=<tab>` — boot the window into a tab (`categories`, `reminders`, …)
- `DT_SHOT=/path.png` — capture the dashboard via `capturePage` after ~3s
- `DT_POP=/path.png` — show + capture the tray popover

Run dev: `npm start` (tray-only; open the dashboard from the tray icon).
Kill dev instances: `pkill -f "desktime/node_modules/electron"`.

## Data

`~/Library/Application Support/Tally/desktime.db` (WAL). Renaming `productName`
moves userData and effectively resets the DB — don't rename casually.
