# SuperTuxKart — Evaluation Report

**Genre:** kart racer (Mario Kart-like) · **Repo:** https://github.com/supertuxkart/stk-code (the brief's `SuperTuxKart/supertuxkart` URL 404s; corrected) · **License:** GPL v3+ (COPYING in repo; GitHub shows NOASSERTION because of multi-license files) · **Evaluated:** 2026-10-23, HEAD `2997f192` (2026-10-17, "Fix AngelScript compilation for Android (#5901)")

## 1. Gameplay depth & polish — 28/30
- Flagship open-source kart racer: single-player story/grand-prix mode, time trials, follow mode, soccer mode, offline split-screen, and full online multiplayer with server browser and rankings (Gamerzilla integration present in `data/gamerzilla/`).
- 15+ karts / characters, 30+ official tracks, challenges & achievements (`data/achievements.xml`, `data/challenges/`), item/powerup system (`data/items.xml`, `data/powerup.xml`), replay system (`data/replay/`, `src/replay/`), in-game addon/mod downloader (`src/addons/`) plus AngelScript scripting engine (`src/scriptengine/`, bundled AngelScript 2.38 built during compile).
- Polish infrastructure: scripted tips (`src/tips/`), localization via `data/po/` (dozens of languages), configurable graphical restrictions profiles, controller support incl. Wii U/USB WiiUse (built from `lib/wiiuse`) and SDL2 game controllers.
- One point off because full content richness could not be play-verified in this environment (assets are external — see §4).

## 2. Mobile optimization — 23/25
- **Official Android port shipped on the Play Store**; repo has a complete `android/` project: `AndroidManifest.xml`, Gradle build (`build.gradle`, wrapper `gradlew`, `minSdkVersion` configurable, min Android 5.0 per README), `make_deps.sh` + `make.sh` for NDK deps, `ANDROID.md` documentation.
- Touch controls are first-class code, not an afterthought: `src/input/multitouch_device.{cpp,hpp}`, a dedicated touch race HUD (`src/states_screens/race_gui_multitouch.cpp`), an in-game multitouch button-layout editor dialog (`src/states_screens/dialogs/multitouch_settings_dialog.cpp`), plus accelerometer/gyroscope steering (`src/input/input_manager.cpp:860-1278`).
- Screen adaptation: aspect-ratio handling in `src/guiengine/screen.cpp`; README documents GLES ≥3.0 requirement path. iOS: plist bundles in `data/` (`SuperTuxKart-Info-iOS.plist`) and an `apple.yml` CI workflow — but iOS is community-side, not an official store presence.
- CI targets mobile-adjacent platforms: linux.yml, windows.yml, apple.yml, switch.yml workflows.

## 3. Build health — 14/15
- Environment: CachyOS, 32 cores, ~17GB free RAM, CMake + Ninja, gcc 16.
- All required deps already present via pkgconf — no pacman installs needed: harfbuzz (pkg name `harfbuzz`, not `libharfbuzz`), fribidi, libpng, libjpeg, zlib, enet (`libenet`), soundtouch, sqlite3, libcurl, ogg/vorbis, SDL2, GLEW, OpenGL, OpenSSL.
- Configure: `cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUNDLE_RESCALE=off -DUSE_STK_SHADER_BUNDLE=ON -DENABLE_SERVER_ONLY=OFF` needed one extra flag, `-DCHECK_ASSETS=off`, because the CMake step hard-fails without the external `stk-assets` folder ("The stk-assets folder does not exist"). With that, configure succeeds cleanly (system SDL2/harfbuzz/sqlite3 detected, bundled mcpp + wiiuse + angelscript).
- Compile: `ninja -C build -j8` (the brief's `-O7` is not a valid Ninja display option and was dropped; job limit kept for RAM restraint). **819/819 targets, 0 errors, exit 0**, produced `build/bin/supertuxkart` (20MB, all shared libs resolve). Far faster than the 30-45 min estimate.

## 4. Runtime smoke — 10/15
- `./bin/supertuxkart --version` → banner: "SuperTuxKart, git." ✔
- `./bin/supertuxkart --no-render --list-tracks` (90s timeout): engine boots fully — user-dir created, `data/` dir validated, OpenGL/GLES capability checks run, file manager scans, shader paths enumerated — then exits with a **clean, documented abort**: "Missing files from the media directory. Please visit stk-assets website, under section 'Folder Missing' to see exactly which folder is missing: models tracks music sfx textures". This is by-design behavior, not a crash: no segfault, informative diagnostics.
- Per the brief, headless boot evidence counts; full gameplay could not be exercised because the asset repo is not fetchable: `SuperTuxKart/game-data` → 404, `supertuxkart/stk-assets` → 404 on GitHub, gitlab.com/supertuxkart/stk-assets → 403 (anonymous fetch blocked), bitbucket → 404. Android's `generate_assets.sh` looks for `../../stk-assets` locally, confirming assets are a separate repo the client expects to be placed next to the code.
- No Xvfb run attempted: with no models/tracks the render path would hit the same asset abort.

## 5. Code quality & activity — 14/15
- 5,446 stars, 1,249 forks, 534 open issues; last push 2026-10-17 — continuously developed for ~20 years.
- Clean C++ module layout (`src/`: audio, karts, physics, tracks, network, states_screens, guiengine…), 4 CI platform workflows, AngelScript modding layer, cross-platform abstraction over SDL2/OpenGL/GLES/Direct3D.
- One point off for the NOASSERTION-license ambiguity in repo metadata and the assets/code split friction that hurts build-from-source UX.

## Official platforms
Desktop (Linux/Windows/macOS), **Android (official, Play Store)**, Switch (CI + `switch/` dir), iOS community builds; UWP deprecated.

## Assets separate-repo finding (explicit)
Game assets (models, tracks, music, sfx, textures) are **not in the code repo**: in-repo `data/` (58MB) holds only UI, shaders, fonts, configs. The build system itself demands a sibling `stk-assets` checkout, and none of the public asset-repo URLs are anonymously fetchable. A source build therefore yields a bootable engine but no playable content without obtaining assets out-of-band.

## Totals
| Axis | Score |
|---|---|
| Gameplay depth & polish | 28/30 |
| Mobile optimization | 23/25 |
| Build health | 14/15 |
| Runtime smoke | 10/15 |
| Code quality & activity | 14/15 |
| **Total** | **89/100** |

**Tier: S** — flagship open-source kart racer; builds clean, engine boots headless, official shipped Android port with first-class touch controls; only gap is the externally-hosted asset repo limiting full from-source playability.
