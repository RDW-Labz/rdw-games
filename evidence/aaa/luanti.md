# Luanti (formerly Minetest)

- **Repo:** https://github.com/luanti-org/luanti
- **Stars:** 13,764 (GitHub API, 2026-10-23)
- **License:** LGPL-2.1-or-later (code; COPYING.LESSER) + CC BY-SA (textures/sounds per LICENSE.txt); GitHub shows NOASSERTION due to mixed licensing
- **Language:** C++ (LuaJIT scripting)
- **Engine:** proprietary voxel engine with bundled IrrlichtMt (`irr/`), SQLite3 + Leveldb backends
- **Version built:** 5.18.0-dev-32bb549 (commit pushed 2026-10-22 — active daily)

## Genre / Platforms
Voxel sandbox engine + game (Minecraft-class), with the largest mod ecosystem in FOSS gaming (ContentDB).
Officially supported: Linux, Windows, macOS, **Android (official app on F-Droid + Google Play)**, iOS (community builds). Web: no.

## Build log summary
Deps installed via pacman: `leveldb openssl` (everything else present: sqlite, curl, json-c, libpng, libjpeg-turbo, libogg/vorbis, freetype2, gmp, gettext, cmake 4.4, ninja).

```
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_CLIENT=ON -DBUILD_SERVER=ON -DRUN_CALL=db_or_ignore
ninja -C build -j6
```

- **Result: clean success**, `[677/677] BUILD_EXIT=0`, zero compile errors. Only warning: `RUN_CALL` unused by current CMake (obsolete var, harmless).
- Binaries land in repo `bin/`: `luanti` (client, 14M), `luantiserver` (7.1M); build tree 161M.
- `./bin/luantiserver --version` → `Luanti 5.18.0-dev-32bb549 (Linux), LuaJIT 2.1.1792349434, GCC 16.2, Release, USE_CURL=1`.

## Runtime smoke evidence (STRONG: headless server)
```
./bin/luantiserver --world ~/freegames/work/luanti-world2 --port 30001 --gameid devtest
```
Log excerpts:
```
ACTION[Main]: World at [/home/cluer/freegames/work/luanti-world2]
ACTION[Main]: Server for gameid="devtest" listening on [::]:30001.
...
ACTION[Main]: Server: Shutting down
```
- World created on disk (`map.sqlite`, `map_meta.txt`, `world.mt`, `mod_storage.sqlite`).
- UDP socket verified bound: `ss -lunp` → `*:30001 users:(("luantiserver",pid=977516))`.
- Server loop confirmed for 80s+ until SIGTERM; clean shutdown, no ERROR/FATAL lines.
- Note: the legacy `Asyncio: Using Event Engine` line no longer exists in 5.18-dev source (old Asyncio rewrite removed it) — absence is expected, not a failure.

## Mobile-optimization evidence
- **`android/` in-repo**: full Gradle Android project (`app/`, `build.gradle`, `gradlew`, `native/` JNI, `keystore-minetest.jks`) — this is the build for the official F-Droid/Play app.
- **`fastlane/`** metadata directory — F-Droid/Play store publishing pipeline.
- **`doc/android.md`** — official Android build instructions.
- Touch input: 54 touch-related references in `src/client/game.cpp`; touch-aware GUI code in `src/gui/guiFormSpecMenu.cpp`, `guiInventoryList.cpp`, `mainmenumanager.h`.
- iOS: community-maintained builds (repo supports cross-compile paths; no in-repo .xcodeproj).
- Fully offline-playable by design (own servers / singleplayer).

## Score breakdown
| Category | Score | Notes |
|---|---|---|
| Gameplay depth & polish | 24/30 | Minecraft-class sandbox; base game is a platform — depth unlocked via ContentDB (thousands of games/mods, e.g. Mineclonia/VoxeLibre); devtest shipped in-repo |
| Mobile optimization | 22/25 | Official Android app (F-Droid + Play), in-repo gradle+fastlane+JNI, deep touch handling; iOS community-only |
| Build health | 14/15 | Clean from-scratch build, 2 missing pkgs trivially installed, one obsolete cmake var warning |
| Runtime smoke | 14/15 | Headless server fully operational: world gen, UDP listen, clean shutdown; client not frame-tested headless |
| Code quality & activity | 14/15 | 13.8k stars, commit yesterday, CI, clear LGPL+CC licensing, mature structure |
| **Total** | **88** | **Tier S** |

## Verdict
The definitive open-source voxel sandbox — a Minecraft-class engine that builds clean out of the box, runs a real multiplayer headless server on first try, and ships an official Android app plus the deepest mod ecosystem in free software. Instant S-tier anchor of the list.
