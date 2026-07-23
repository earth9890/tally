# DEPLOY.md — Release runbook

Everything required to ship a Tally release, from GitHub to Homebrew.

## Channels

| Channel | What users do | What we maintain |
|---|---|---|
| GitHub Releases | download the `.dmg` | `earth9890/tally` releases (electron-builder uploads) |
| Auto-update | nothing — in-app | same releases; `latest-mac.yml` is the manifest |
| Homebrew | `brew install --cask earth9890/tap/tally` | `earth9890/homebrew-tap` → `Casks/tally.rb` |

npm is deliberately **not** a channel (GUI app, wrong registry).

## Prerequisites (once per machine)

- `gh auth status` logged in as **earth9890** (token stays in the keyring; never
  write it to a file)
- `NODE_ENV=development npm install --include=dev` then `npm run rebuild`
- Python has distutils: `python3 -m pip install --break-system-packages setuptools`
- Icons already exist in `build/` — regenerate only if the mark changes:
  `./node_modules/.bin/electron scripts/make-icon.js` (app) and `… tray` (tray)

## Release steps

```bash
# 1. Bump the version (this is what triggers updates for users)
#    edit package.json "version": e.g. 0.1.5 -> 0.1.6

# 2. Commit + push the code
git add -A && git commit -m "..." && git push origin master

# 3. Build both arches + upload to a draft GitHub release
export GH_TOKEN=$(gh auth token)
rm -rf dist
npm run release          # = electron-builder --mac --publish always

# 4. Publish the draft (electron-builder always leaves it as Draft)
gh release edit v<VER> --draft=false --title "Tally <VER>" --notes "### What's new
- ..."

# 5. Verify assets — must list BOTH arches + manifest:
gh release view v<VER> --json assets -q '.assets[].name'
#   latest-mac.yml, Tally-<VER>-arm64.dmg/zip(+blockmaps), Tally-<VER>-x64.dmg/zip(+blockmaps)
```

Users on any previous version now get the update automatically (check runs at
launch + hourly → background download → "Install v<VER> & Relaunch" in the
popover).

## Homebrew cask bump (after every release)

```bash
shasum -a 256 dist/Tally-<VER>-arm64.dmg dist/Tally-<VER>-x64.dmg

cd ~/homebrew-tap
#   edit Casks/tally.rb: version "<VER>", sha256 arm: "...", intel: "..."
git add -A && git commit -m "tally <VER>" && git push origin master

# sanity check
brew update && brew info --cask earth9890/tap/tally   # should show <VER>, no warnings
```

The cask is arch-conditional (`arch arm: "arm64", intel: "x64"`) — never
reintroduce an arm64-only `depends_on`; Intel is supported since 0.1.5.
`auto_updates true` keeps `brew upgrade` from fighting the in-app updater.

## What needs a release vs what doesn't

- **App code** (`src/`, `package.json` deps, icons) → release
- **Docs** (`*.md`), tap changes, repo housekeeping → just push, no release

## Rollback

Delete or un-latest the bad release (`gh release delete v<VER>` or edit), and
point the cask back at the previous version/shas. Installed apps only move
forward when `latest-mac.yml` says a *newer* version exists, so removing the
release stops the rollout.

## Signing / notarization (future)

Currently signed with a local identity, not notarized:
- users right-click → Open on first launch
- updates *notify* everywhere but may only auto-*apply* on the build machine

When an Apple Developer ID exists ($99/yr):
1. Create a "Developer ID Application" certificate → Keychain
2. electron-builder picks it up automatically; add notarization env
   (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) — env only,
   never commit credentials
3. Result: no Gatekeeper friction, silent auto-update for all users, and
   eligibility for the official homebrew/cask repo (also needs repo notability:
   ~75 stars / 30 forks / 30 watchers)
