## Unreleased

- Orb drag fix (found on Braden's Mac): the orb window lacked `core:window:allow-start-dragging`, so it could not be moved. It now starts a native drag once the pointer moves 4 px (`startOrbDrag` in `src/lib/platform.ts`), so a plain click still toggles the panel and a right-button press never drags. The clipped menu and the dark box are T17 (decision #56).

- Mac quickstart guide (`docs/mac-quickstart.md`, linked from `README.md` and
  `docs/rig.md`), covering exactly what was verified on Braden's Mac: building the app, installing the
  service, keychain secrets, the drawer (decision #55), connecting Outlook,
  starting the service, running daily-summary and the Scoreboard, what's
  skipped on Mac, what's not built yet, and troubleshooting.
  Two fixes alongside it:
  - (k) The status poll (every 3s, from both the `main` and `orb` windows)
    was calling `get_service_token` on every tick, so macOS re-prompted the
    keychain dialog after every "Allow". `get_service_token` now caches the
    token in Tauri-managed state and only reads the keychain when the cache
    is empty; a new `forget_service_token` command clears it. `serviceClient.ts`
    calls `forget_service_token` and retries exactly once on an HTTP 401,
    never looping on a second failure. The token is still never logged or
    shown.
  - (i) The Activity tab's generic "Could not read the activity log yet"
    message is replaced with two specific ones: "Can't reach the service to
    find the log." when `getLogPath` itself fails, and "Can't read the log
    at \<path\>" (the path the service returned) when reading that file fails.

- Updater public key set (key id `E25107C3B69B99B9`); private key stays in the keychain.
  The real public key is now in `tauri.conf.json`, and the signing credentials
  (private key and password) are stored via `agent-core` secrets for use at release time.

- T16b run-now — `POST /skills/<name>/run` endpoint for manual skill runs through the scheduler (decision #52).
