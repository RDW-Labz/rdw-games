# desktop-app Mac-build PR input

## Commits
- 0b9bea6 Mac quickstart guide; cache the service token; plain Activity errors; orb drag fix
- 815af8c Set real updater public key

## Diff stat
```
 CHANGELOG.md                    |  25 +++++
 README.md                       |   4 +
 docs/mac-quickstart.md          | 202 ++++++++++++++++++++++++++++++++++++++++
 docs/rig.md                     |  50 +++++-----
 src-tauri/capabilities/orb.json |   3 +-
 src-tauri/src/lib.rs            | 160 ++++++++++++++++++++++++++++++-
 src-tauri/tauri.conf.json       |   2 +-
 src/components/ActivityLog.tsx  |  12 ++-
 src/lib/platform.ts             |   6 ++
 src/lib/serviceClient.ts        |  91 ++++++++++++++----
 src/orb/OrbApp.tsx              |  44 ++++++++-
 tests/ActivityLog.test.tsx      |  24 ++++-
 tests/Orb.test.tsx              |  33 ++++++-
 tests/serviceClientAuth.test.ts |  47 +++++++++-
 14 files changed, 645 insertions(+), 58 deletions(-)
```
## Checks (coordinator, on 0b9bea6)
```
npm test → Test Files 10 passed, Tests 44 passed
npm run lint → clean
npm run typecheck → no errors
cargo test → 20 passed
cargo clippy --all-targets -- -D warnings → clean
cargo fmt --check → clean
git diff --check → clean
npm run tauri build -- --bundles app -c '{"bundle":{"createUpdaterArtifacts":false}}' → OASIS.app built
```
## Checked on Braden's Mac (2026-09-23)
- Every step in docs/mac-quickstart.md was run on this Mac: build, install, keychain, drawer, connect Outlook (both), service, Rig (Chat Connected and answering, Connect shows both Outlook tiles, Activity reads the log), daily-summary run-now (note written, counts matched Outlook), Scoreboard once (10 measures).
- Rebuilt app: at most one keychain prompt (Always Allow), then none; the orb drags and a click still opens the panel. Braden: "it works".
## Facts
- Updater public key id E25107C3B69B99B9 (the private key is never read by a local build).
- Windows-only parts skipped (decision #53): T05 watcher, .msi/.exe installer and signing, Windows keychain acceptance.
- Orb clipped menu and dark box go to T17 Orb v2 (decision #56). Drawer path ~/.oasis/drawers/<person> (decision #55).
- Known follow-ups, not in this PR: status polls flood log.jsonl (m); a second same-day daily-summary run fails its check (j); drawer path from one source (h).
