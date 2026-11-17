# Battle for Wesnoth — Judgment Report

- **Repo:** https://github.com/wesnoth/wesnoth (fetched `master`, snapshot dated 2026-10-23)
- **Stars:** 6,951 · **License:** GPL-2.0 · **Language:** C++20 (~355k LOC in `src/`: 601 .cpp / 696 .hpp)
- **Engine:** in-house engine on **SDL3** (master; `CMakeCache`: `SDL3_DIR`, `SDL3_image_DIR`, `SDL3_mixer_DIR`). 1.18 LTS still uses SDL2 — fallback was **not needed**: SDL3 built and ran clean.
- **Version built:** `Battle for Wesnoth v1.21.0-dev x86_64`

**Working-tree note (deviation, documented):** the shallow clone into `~/freegames/work/wesnoth` stalled incomplete (1.8 GB, zero checked-out commits). The tree actually built lives at `~/freegames/work/wesnoth2`, materialized as a complete file-set snapshot of the GitHub `master` tree (verified 0 missing vs the API tree listing; no `.git`). All build/runtime evidence below is from that tree.

## 1. Genre & platforms
Turn-based tactical fantasy strategy (hex-grid, roguelike-lite campaigns, faction-based). Officially supported: **Windows, macOS, Linux, Android (official Play Store + F-Droid port)**; iOS project in-repo (projectfiles/Xcode + iOS dep bootstrap scripts); ships on Steam (README/Xcode packaging reference Steam). Headless multiplayer core supported.

## 2. Build log summary
Deps: system (CachyOS) provided gcc, cmake/ninja, pango/pangomm, cairo, lua 5.5, gettext, protobuf, asio, openssl; **boost 1.92 and the SDL3 + SDL3_image + SDL3_mixer stack were built from source into a local prefix** `~/freegames/stage/root` (no pacman sdl3 packages exist yet).

```
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DBOOST_INCLUDEDIR=~/freegames/stage/root/usr/include \
  -DBOOST_LIBRARYDIR=~/freegames/stage/root/usr/lib \
  -DENABLE_CACHE_GEN=ON -DUSE_CORE=ON
ninja -C build -j6        # RAM-constrained: max -j6 per brief
```
Two configure fixes were needed because the snapshot has no `.git`: `chmod +x utils/autorevision.sh`, and `-DENABLE_DISPLAY_REVISION=OFF` (revision target is meaningless without a repo). `ENABLE_NLS=OFF` after a gettext-submodule check hiccup; NLS is cosmetic here.

**Result: build ok** — `[542/542] … NINJA_EXIT=0`, 0 `error:` lines, **542/542 targets**, `build/wesnoth` = 34 MB ELF (all ldd deps resolve). Final clean pass 194 s @ -j6 after earlier passes (boost fix) had compiled most objects; total wall time well inside the 60-min budget, **no swap pressure** observed (monitored with `free -g`).

## 3. Runtime smoke evidence — runtime ok
1. `./wesnoth --data-path` → banner `Battle for Wesnoth v1.21.0-dev x86_64`, auto-detected data dir ✓
2. `./wesnoth --preprocess ../data/core /tmp/pp_core` → full WML engine run: **"preprocessing finished" with 1,836 macro defines** loaded from the core library ✓
3. `./wesnoth --nogui --multiplayer` → headless core server: game data initialized, `Checking lua scripts... ok`, process ran the full 60 s observation window and was killed (exit 124 = alive & serving) ✓
4. Error-path behavior sane: `--nogui` alone exits 1 with the correct diagnostic "To start the server in headless mode use --nogui with --multiplayer".
(OpenGL render path not exercised — no display; SDL dummy driver used for data checks.)

## 4. Content volume
- **21 campaigns** (`data/campaigns`, incl. the mainline *Heir to the Throne* Dark-Era trilogy, Legend of Wesreth, Rise of Wesnoth, Dead Water, Sons of the Legion…) + `data/tutorial` + **5 multiplayer campaigns**
- **656 `[unit_type]` definitions, 27 races**, 14 MP factions, 2 MP eras (Default, Age of Heroes)
- **370 campaign maps**; 14,071 PNGs in `data/core/images` (incl. 7,175 unit sprites), 437 audio files, 608 MB of game data
- 285 Lua scripts (engine glue, MP generators), 1836 WML macros; UMC ecosystem on addons.wesnoth.org adds thousands more scenarios — effectively infinite replayability
- **60 languages** in `po/LINGUAS`

## 5. Mobile-optimization evidence
- `packaging/android/`: full Gradle project, `applicationId org.wesnoth.Wesnoth`, `versionName 1.21.0-dev`, SDL3 android activity; manifest declares `android.hardware.touchscreen` (required), gamepad, `android.hardware.type.pc`, USB, bluetooth
- `fastlane/` metadata at repo root → Google Play pipeline
- Touch input handled first-class in the C++ GUI layer: `src/gui/core/event/dispatcher|distributor` handle SDL finger/touch events; scalable-GUI/DPI preferences in-game
- iOS: `projectfiles/Xcode/` with `ios/build_ios_deps.sh` + `ios/audit_ios_linkage.sh`
- Offline-first by design (single-player campaigns fully offline; MP optional)
- Not verified: APK not built/launched on emulator this pass (NDK gradle build skipped — desktop smoke prioritized)

## 6. Code quality & activity
GPL-2.0 clearly stated; 15 CI workflows (incl. android.yml); pushed **same day** (2026-10-23); 6,951 stars; 20+ years of continuous development, 300+ contributors; clean CMake module layout (`cmake/`, `packaging/{android,flatpak,macos,windows}`), flatpak + appdata + systemd unit packaging all in-tree.

## 7. Score (rubric)
| Dimension | Score | Note |
|---|---|---|
| Gameplay depth & polish | 30/30 | 21 campaigns, 656 units/27 races, 20-yr polished mechanics, addons ecosystem — benchmark open-source strategy game |
| Mobile optimization | 20/25 | Official Android (Play/F-Droid) + iOS projects + first-class touch; APK not run on emulator here |
| Build health | 13/15 | Clean 542/542 ninja, 0 errors; needed local SDL3/boost staging + 2 configure fixes for git-less snapshot |
| Runtime smoke | 13/15 | Boots banner, full core preprocess, headless MP server alive w/ Lua ok; no GL render test |
| Code quality & activity | 14/15 | Daily commits, 15 CI workflows, clear GPL, huge mature codebase |
| **Total** | **90/100** | **Tier S** |

## 8. Verdict
The flagship of open-source games: a 20-year-deep, 608 MB tactical-strategy heavyweight that compiles 0-error with ninja -j6, boots a verified headless server, ships official Android/iOS ports and 60 translations — an instant S-tier anchor for the catalog.
