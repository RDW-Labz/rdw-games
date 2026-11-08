# desktop-app Mac-build PR

## Summary

- **Mac quickstart guide**: New `docs/mac-quickstart.md` covers building, installing the service, keychain setup, the drawer, connecting Outlook, running daily-summary and Scoreboard, what's skipped on Mac, what's not built yet, and troubleshooting. Linked from README and docs/rig.md.

- **Updater public key**: Set the real public key (id E25107C3B69B99B9) in `tauri.conf.json`. Private key stays in the keychain for release-time signing.

- **Token cache fix**: Service token is now cached in Tauri state instead of re-prompting the keychain on every status poll. On HTTP 401, retry once and clear the cache. Token never logged or shown.

- **Activity error messages**: Replaced generic error with two specific messages: one when the service can't be reached, one when the log file can't be read at the path the service returned.

- **Orb drag fix**: Added `core:window:allow-start-dragging` capability and native drag detection after 4 px pointer movement. A plain click still toggles the panel.

## Checked on the Mac

- Every step in docs/mac-quickstart.md was run on this Mac: build, install, keychain, drawer, connect Outlook (both), service, Rig (Chat Connected and answering, Connect shows both Outlook tiles, Activity reads the log), daily-summary run-now (note written, counts matched Outlook), Scoreboard once (10 measures).
- Rebuilt app: at most one keychain prompt (Always Allow), then none; the orb drags and a click still opens the panel. Braden: "it works".

## Tests

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

## Not in this PR

- Windows-only parts (decision #53): T05 watcher, .msi/.exe installer and signing, Windows keychain acceptance.
- T17 Orb v2 (decision #56): clipped menu and dark box.
- Known follow-ups: status polls flood log.jsonl; a second same-day daily-summary run fails its check; drawer path from one source.

## Open for Braden

nothing

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
