# Local EAS build + submit (x86 Linux) — cheaper / Actions-free path

`scripts/eas-local.sh` builds and submits the mobile apps from any **x86_64
Linux** box (e.g. the Ubuntu server) **without GitHub Actions**.

Use it when:
- **GitHub Actions is unavailable** (billing / account block — every run
  `startup_failure`s at 0s), or
- you simply want to **save Actions minutes** (this path costs none).

> The Windows laptop (win32-arm64) **cannot** run `eas-cli` — its bundled
> `hermesc` is x86 ELF. That's the whole reason `eas-build.yml` / `eas-submit.yml`
> exist. This script is the same thing for an x86 Linux machine. EAS still does
> the real macOS/Xcode (or Android) build in its cloud — the script only drives
> the CLI, so it works on Linux.

## One-time setup on the Linux box
```bash
# 1. tools
npm i -g eas-cli@13
# 2. repo on the commit you want to ship
git clone <repo> auction-platform && cd auction-platform   # (or: cd existing && git pull)
npm ci
# 3. EXPO_TOKEN — export it, or drop it into apps/field-mobile/.env (the script
#    auto-reads it from there). Same token the GH workflows use.
export EXPO_TOKEN=...                         # scopes: build:create, submit:create
# 4. submit credentials (gitignored — copy once from the dev machine's .secrets/)
#    iOS:      .secrets/AuthKey_25M83P99J8.p8
#    Android:  .secrets/google-play-service-account.json
#    eas.json already points at ../../.secrets/... so no patching is needed.
```

## Ship the current mobile fixes (#315 staff checkout-scan, #316 bidder multi-live)
On the Linux box, from the repo root:
```bash
git checkout master && git pull          # gets #315/#316/#317 (already merged)
npm ci
bash scripts/eas-local.sh both preview ios --submit
```
That builds **staff** (checkout Code128/UPC scan fix) and **bidder** (show-all-live
auctions fix) for iOS, waits for each cloud build, then submits the latest to
TestFlight. Build numbers auto-increment (remote `appVersionSource`). Testers
update via TestFlight as usual.

## General usage
```
scripts/eas-local.sh <app> <profile> <platform> [--submit]
  app:      bidder | staff | both
  profile:  preview | production       # preview = internal / TestFlight
  platform: ios | android | all        # staff is iOS-only in eas.json
```
- **No `--submit`** -> queues the build(s) with `--no-wait` and returns; watch
  progress at expo.dev (`rdw_cluer` / `auction-platform-bidder` + `bidwizops-field`).
- **`--submit`** -> builds run to completion (blocking) so `eas submit --latest`
  grabs exactly that build.

## Gotchas
- `eas.json` has `requireCommit: true` — commit / `git pull` first; the build
  uses the committed tree and refuses uncommitted changes.
- JS-only changes can alternatively ship via OTA: `eas update --branch preview`
  (also runnable from this box) — but a fresh build is the reliable path when an
  install might not pick up the OTA.
- This does **not** replace CI (lint/typecheck/test) — it only builds/submits.
  When Actions is restored, normal PR CI resumes.
