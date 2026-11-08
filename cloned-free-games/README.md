# cloned-free-games

Open-source games cloned from GitHub, **built, run on an Android 16 emulator
(headless AVD, x86_64), and judged** — not just cataloged. Targeted at finding
genuinely deep, well-optimized free games ("badd ass shit", not Flappy Bird —
though the Flappy-tier montage is here too, judged accordingly).

- **[CATALOG.md](CATALOG.md)** — type, score, optimized platforms, test evidence per game.
- **[GAMES.lock](GAMES.lock)** — upstream URLs + pinned commits.
- **scripts/** — clone, serve, and emulator smoke-test harnesses.
- **evidence/** — screenshots captured from the emulator during testing.
- **build-*.log** — full build logs for each Android build.

## Reproducing
```bash
scripts/clone-donors.sh         # clone/refresh donors at pinned commits (fetch-games.sh wraps it)
scripts/asset-inventory.py      # what a clone actually carries: licence, art, audio, data
scripts/android-env.sh          # source for ANDROID_HOME etc.
# per-game, e.g.:
cd games/shattered-pixel-dungeon && ./gradlew :android:assembleDebug
adb install -r games/shattered-pixel-dungeon/android/build/outputs/apk/debug/android-debug.apk
```

> **Never `rm -rf games/`.** The tree is only mirrors — nothing authored lives there — but it is
> 20 GB of download to get back. Delete a single clone by naming it: `rm -rf "games/$name"` with
> `$name` verified (`[ -n "$name" ] && [ -d "games/$name" ]`). A shell one-liner that wrote
> `name=$1 url=$2 shift 2` on a single line left `$name` empty and emptied the whole tree once.

```bash
scripts/test-web-game.sh hextris hextris   # web tier, in Chrome on the emulator
```
