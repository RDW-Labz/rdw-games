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

## Web arcade (game.cluerholdings.com/play/<slug>/)

Everything below runs unattended each night from `games-arcade.timer` →
`scripts/arcade-sync.sh`, in five stages:

| stage | script | what it does |
|---|---|---|
| detect | `detect-web-games.py` | finds entries that are already static-runnable (`games/`, `.build/out/`) |
| build | `auto-build.py` | builds clones that ship their own `npm run build`, validates the output, allow-lists it |
| promote | `promote-web-games.py` | mirrors allow-listed builds into `.site-play/` (this is what `/play/` serves) |
| plan | `port-plan.py` | classifies every clone into a lane + measures disk |
| publish | `publish-site.sh` | catalog + mirrors + gate function → Cloudflare Pages |

The build stage is the only one that touches the network or writes scratch space. It copies a
clone to `.build/src/`, installs, builds, then accepts the result only if:

- the generator produced an `index.html` (not a committed one with an old mtime),
- every `src`/`href` it references exists on disk,
- nothing is fetched from a remote origin (a CDN stylesheet is vendored into `_vendor/`,
  anything larger or stranger fails the build),
- root-absolute paths (`/app.js`) are rewritten relative, because these games live under
  `/play/<slug>/` and a `/app.js` would 404,
- the output is inside the size budget (`--max-mb`, default 160).

Passing builds are appended to `scripts/playable-auto.txt`; failures land in
`scripts/playable-block.txt` with the reason, so a bad tree costs one attempt instead of one a
night. Delete a line from the block file to retry. A clone that needs a small pre-build fix
(the kind of thing upstream gitignores) gets a hook at `scripts/build-shims/<slug>.sh`, run
inside the scratch copy before the build.

```bash
python3 scripts/auto-build.py --list                          # what is queued to build
python3 scripts/auto-build.py --slug Diadem --force --keep-scratch   # one game, keep scratch
python3 scripts/port-plan.py                                  # lanes + disk accounting
NO_BUILD=1 bash scripts/arcade-sync.sh                        # everything except the build
```

### Disk

Clones are the permanent source of truth and are never pruned, moved, or rewritten — a port
only ever copies from them. What can grow is scratch space and published bytes, so both are
measured on every run and reported in `.queue/port-plan.json` under `disk`:

- `games_dir_mb` — real `du` of `games/` (nothing prunes this by design; add disk instead)
- `published_mb` — what actually ships (`.site-play/` + `.site-out/thumbs/`)
- `over_budget` — clones carrying more art than the per-port vendoring budget
  (`--budget-mb`, default 12): a port of one of these takes a subset, never the whole art tree

Scratch copies are deleted after every attempt, and a crashed run's leftovers are swept at the
start of the next one. The build stage is skipped entirely when free space drops under
`MIN_FREE_GB` (default 20), so a full disk can never take the publish down with it.

