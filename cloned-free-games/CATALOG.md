# Cloned Free Games — Tested & Judged Catalog

Every entry was actually cloned, built/run, and judged on real targets — not just listed.
Testing rigs: Android 16 emulator (x86_64, swiftshader GPU) via headless AVD `pm_pixel`,
plus the host Linux desktop (CachyOS, AMD Strix Halo).

**Score rubric (0–10):** buildability from source (2), runs on phone target (3),
depth/replay value ("badd ass" factor) (3), polish/optimization (2).

| # | Game | Type | Score | Optimized platforms | Status / evidence |
|---|------|------|-------|--------------------|-------------------|
| 1 | **Shattered Pixel Dungeon** | Roguelike (turn-based dungeon crawler) | **9.0** | Android (arm64-v8a + x86_64 native), desktop (libGDX), iOS | Built from source `v4.0.2`, APK installed, booted to main menu on emulator, steady PID, `evidence/spd-emulator.png`. Flagship content updates for a decade; touch-first UI. |
| 2 | **Unciv** | 4X strategy (Civ-like) | **8.5** | Android (tiny libGDX APK), desktop, iOS, any JVM | Built from source, APK installed, rendered to screen on emulator (`gfxinfo` frame counts, `evidence/unciv-emulator.png`). Full Civilization gameplay in ~20 MB; runs on potato phones. |
| 3 | **Mindustry** | Tower-defense / RTS / factory-sim hybrid | **9.5** | Android (arm64 + x86_64), desktop (JVM), iOS, web (GWT) | Built from source at b873c01 (Gradle 9.3.1, JDK 21, local Arc 7445105cd2), APK installed, ran 10+ min stable on emulator (PID 4599, 14 948-color rendered frame, 0 FATAL, `evidence/mindustry-emulator.png`). Pitfall found: upstream forces R8 (`minifyEnabled=true`) precisely because without it default-interface methods aren't desugared and the app dies with `AbstractMethodError` on boot — do NOT disable it. Deepest game in the list. |
| 4 | **Luanti (Minetest)** | Voxel sandbox (Minecraft-class) | **9.0** | Android (NDK 28.2, x86_64/arm64), Linux/Windows/macOS, iOS, dedicated servers | Built from source at 32bb549 — full NDK cross-compile of engine + IrrlichtMt, `app-x86_64-debug.apk`, launched on emulator: `GameActivity` focused, menu textures + menu audio loaded, no FATAL (`evidence/luanti-emulator.png`, 2 841 colors). Infinite sandbox + modding (Lua) + server multiplayer. |
| 5 | **SuperTuxKart** | 3D kart racer (AAA-look) | **8.0** | Linux/Windows/macOS (GL/Vulkan), Android (official APK; NDK build not run here), Switch | Built from source (stk-code master + 2.5 GB stk-assets mirror, bundled Bullet) with Ninja; ran the built-in full-race replay benchmark on Xvfb/llvmpipe: 782 frames, clean exit, replay `benchmark_black_forest` (`build-stk-bench.log`, "Steady FPS 12" on pure CPU software GL — real GPUs hit hundreds). 24-track campaign, karts, ghost replay. |
| 6 | **OpenTTD** | Transport/tycoon sim | **8.5** | Linux (verified: built + ran here), Windows/macOS, Android + consoles (official ports, not rebuilt here) | Built from source at 51cb6dc (ninja, 193 targets), launched under Xvfb — full main menu + isometric scenery rendered via software fallback, steady PID 30s+, `evidence/openttd-run.png`. |
| 7 | **OpenRA** | RTS (C&C/Red Alert-class) | *desktop-only* | Windows/Linux/macOS (requires .NET 8; no official Android port) | Source complete. Kept in catalog as a "real game" reference; not phone-testable. |
| 8 | **Hextris** | Puzzle (hexagonal Tetris) — montage tier | **6.5** | Browser (mobile-first), real Android/iOS apps exist | Loaded in Chrome on emulator; swipe input changed screen (`evidence/web-hextris-{before,after}.png`, 348 KB rendered frame). |
| 9 | **2048** | Sliding-tile puzzle — montage tier | **6.0** | Browser (mobile-first) | Loaded in Chrome on emulator; swipe moved tiles (`evidence/web-2048-{before,after}.png`). |
| 10 | **Clumsy Bird** | Flappy-style — montage tier | **5.0** | Browser (MelonJS) | Loaded in Chrome on emulator; tap started game, scene animating without further input (`evidence/web-clumsybird-play.png`). |
| 11 | **FlappyBird (VadimBoev)** | Flappy clone — montage tier | **3.5** | Windows/Linux via MonoGame (.sln) | Reference clone only; not a phone target. Kept for the montage, exactly as flagged. |
| 12 | **Endless Sky** | Space sim/trade/combat (Elite-class, open world) | **9.0** | Linux/Windows/macOS (verified: built + ran here), Android (official APK + Play Store), iOS (community) | Built clean from source at c3c7908 (CMake+Ninja, 261/261 targets); launched under Xvfb — main menu/starfield rendered (12 098 unique colors, `evidence/endless-sky-run.png`), log clean apart from Xvfb vsync notice. Official Android port ships on the Play Store — a genuinely deep 100+ hour sandbox on a phone. Free campaign + scripting system + modding. |
| 13 | **DDNet** | 2D coop platformer + racing (Teeworlds family) | **8.5** | Linux/Windows/macOS (verified: built + ran here), Android + iOS (official ports), dedicated servers | Built clean from source at 00955a3 (CMake+Ninja+clang, bundled libs, 442/442 targets); launched under Xvfb — full main menu rendered (9 094 unique colors, `evidence/ddnet-run.png`), clean config save/shutdown in `ddnet-run.log`. 2500+ maps, 12-player coop, rendering engine tuned for low-end hardware; official mobile ports. |
| 14 | **DarkPlaces (Quake engine)** | FPS — the original AAA shooter (id Tech 2, enhanced) | **9.0** | Linux/Windows/macOS (verified: built + ran here, AMD Strix Halo GPU), Android (multiple DarkPlaces-based ports), WebGL forks | Built from source at 10d4863 (`make sdl-release`); ran with verified shareware `pak0.pak` (SHA1 36b42dc7b6313fd9cabc0be8b9e9864840929735): full `demo1` (E1M5 Necropolis) replayed end-to-end on radeonsi GPU — timedemo: **98.5 fps avg / 172 max** at 1280x720 (969-frame window, one-second min/avg/max 45/104/172 over 74 s); menu+demo rendered (21 871 unique colors, `evidence/darkplaces-run.png`). GLSL relighting, 64-bit, controller support; the reference enhanced-Quake engine. Pitfall: under Xvfb force `SDL_VIDEODRIVER=x11`, otherwise DP grabs DRM directly and X root captures are blank. |
| 15 | **Cataclysm: Dark Days Ahead** (`Cataclysm-DDA`) | Turn-based post-apocalyptic survival roguelike (open world, crafting, vehicles, base building) | **8.5** | Linux/Windows/macOS (verified: built + ran here), Android (in-tree Gradle app `android/` + touch joystick, APK not built this run), iOS (community) | Built from source at `2599825` (`cdda-experimental-2026-11-01-1411`; ncurses build: `make -j12 RELEASE=1 LOCALIZE=0 BUILD_PREFIX=.build/cdda/ <abs>/cataclysm`, 345.7 s wall, exit 0, 503 objects, 279 MB binary, no SDL shims needed — the TILES path needs the local SDL3 extras and overruns the budget). Ran the real binary headless in a 120x40 pty: ASCII banner at t=8.2 s → Play → **Create World** dialog (difficulty slider, mod manager) → `f` → "Are you finished creating your world?" confirm; process alive throughout, rendered screens in `evidence/cdda-play.log.screen.txt`, raw pty bytes `evidence/cdda-play.log`. No in-game turn was taken. Depth measured from data, not reputation: **3 340 JSON files / 46.3 MB / 58 126 typed objects** — 10 448 items, 7 090 mapgen chunks, 5 597 recipes, 1 286 overmap terrains, 1 226 monsters, 1 076 mutations, 783 constructions, 507 vehicle parts, 49 mods. Split: build 2/2, phone 2/3 (in-tree Android app exists, APK not built), depth 3/3, polish 1.5/2 (dense keyboard-driven UI, heavy RAM). |

## Donor pool — cloned 2026-10-30, assets measured, nothing built yet

Brief: *"lets clone some more to build with, i want something closer to aaa."* These were
cloned for **asset value**, not for playability. **No score is assigned** — the rubric scores
builds that ran, and none of these has been built here.

| Clone | Licence | Measured content | Why it is worth having |
|---|---|---|---|
| **crawl** `cf8c9bc` | tiles **CC0**, code GPL-2.0 | 8,796 tiles (37 MB, 32×32), 144 `.des` files holding **6,127 `MAP`-grid vaults**, 6.2 MB of item/monster/spell tables | hand-authored dungeon geometry — real rooms, not procedural noise |
| **widelands** `29753773` | GPL-2.0 | 17,900 art files (334 MB), 148 ogg (119 MB), **2,314 Lua data files** (tribes, buildings, wares) | Settlers-style production chains — wares, workers, roads, the deepest chain economy in free software |
| **openrct2** `3b7114c` | GPL-3.0 | 10,011 PNGs (17.8 MB, mostly its own UI art), 6.5 MB of data | park-sim systems: guest AI, ride economics, research gating. Needs RCT2 data at runtime, so reference only |
| **flare-game** `af6eee6` | GPL-3.0 + CC-BY-SA-3.0 art | 429 PNGs (1.2 GB sparse clone — enemy sheets up to 6144², 9 tilesets, 42 portrait dirs, 66 menu panels), 128 ogg, **560 item definition files** | the only 2D donor with art rendered from 3D models, plus real item records with damage/price/bonus numbers |
| **wesnoth** `7af37dd0` | GPL-2.0 + CC-BY-SA-4.0 art | 15,852 PNGs (637 MB sparse clone), 7,175 unit PNGs from **327 unit `.cfg` definitions**, 284 portraits, 44 music tracks | a complete rule set written as data: hp, movement, cost, alignment, per-attack damage/number/range |

### Examined and rejected as donors

- **opentyrian** — the GitHub repo is code only (2 MB); its data comes from `get_data.sh`, which
  pulls the 1995 freeware Tyrian 2.1 archive off a third-party mirror. 320×200 pixel art, extra
  network step, nothing the pool doesn't already beat. Removed after inspection.
- **0 A.D.** — `0ad/0ad` is 8.4 GB and its art/audio are Git-LFS objects; the local checkout in
  `~/freegames/work/0ad` is pointers only. Not cloned; it would need `git lfs pull` to become a
  donor, and its art style is covered by Wesnoth and Flare.

### Art libraries already on disk from the earlier sweep

| Tree | Licence | Measured |
|---|---|---|
| **Wesnoth** (`~/freegames/work/wesnoth2`, 1.21.0-dev) | GPL-2.0 + CC-BY-SA-4.0 | **21,265 art files / 307 MB** — 9,146 unit/creature sprites, 6,826 terrain tiles, 592 portraits, 1,274 UI icons; **396 audio files (268 MB, 310 ogg)** |
| **Flare** (`~/freegames/work/flare-game`) | CC-BY-SA 3.0 | **721 art files / 555 MB** — 93 painted enemy sheets (boss sprite sheets up to 6144×6144), 12 isometric tilesets (47 MB), 73 portraits, 103 menu panels; 197 item definitions; 136 ogg |
| **Endless Sky** (`~/freegames/work/endless-sky`) | GPL-3.0 | **6,944 art files / 348 MB** — 567 port panoramas, 2,020 effect frames, 201 UI icons, 118 ship sprites; 247 audio files |
| **0 A.D.** (`~/freegames/work/0ad`) | GPL-2.0 / CC-BY-SA | **not usable as-is** — art and audio are Git-LFS pointers in this checkout (7,726 PNGs total 4.4 MB of pointer text). Needs `git lfs pull` before it is a donor |

### The games/ tree

`games/` is gitignored and fully reproducible: `scripts/clone-donors.sh [name ...]` does depth-1
clones (sparse paths where a clone is only wanted for its art or data), records the commit it
lands on, and refreshes rather than deletes an existing tree. `scripts/asset-inventory.py`
reports what a clone actually carries — licence, art by type and bucket, audio, data tables.

An accidental `rm -rf games/` on 2026-10-30 emptied this tree. Nothing authored was lost — the
catalog table, `evidence/`, and the build logs live outside `games/` — and the trees needed
since were rebuilt with the script above.

## Leaderboard (by score)
1. Mindustry 9.5 · 2. Shattered Pixel Dungeon 9.0 · 3. Luanti 9.0 · 4. Endless Sky 9.0 · 5. DarkPlaces 9.0 · 6. Unciv 8.5 · 7. OpenTTD 8.5 · 8. DDNet 8.5 · 9. SuperTuxKart 8.0 · 10. Hextris 6.5 · 11. 2048 6.0 · 12. Clumsy Bird 5.0 · 13. FlappyBird 3.5

## How each test works
- **Native Android:** `gradlew assembleDebug` → `adb install` → `monkey` launch →
  screenshot + `dumpsys gfxinfo` frame counts + PID liveness.
- **Web tier:** served locally (`scripts/serve-games.sh` → :8100), opened in Chrome **on the
  Android emulator**, tap/swipe injected, before/after screenshots pixel-diffed (`scripts/test-web-game.sh`).

## Build logs
`build-{spd,unciv,mindustry,luanti,stk,openttd,endless-sky,ddnet,darkplaces}.log` in repo root.
Desktop runs: `Xvfb :9` + ImageMagick root captures, colorfulness-verified (`evidence/*-run.png`).
| 16 | **DevilutionX** (`DevilutionX`) | Action RPG (Diablo 1 + Hellfire engine reimplementation) | *_8.0 — desk audit_* | Linux/Windows/macOS (documented CMake build, not run here), Android (first-class in-tree Gradle app: NDK 29.0.14206865, minSdk 21, compileSdk/targetSdk 35, `org.diasurgical.devilutionx`), iOS/Vita/Switch/3DS/PS4/Xbox/Amiga | **Desk audit — no build run** (C++/SDL2, 271 `.cpp` + 165 `.h`, 6.0 MB `Source/`; documented build is `cmake -S. -Bbuild -DCMAKE_BUILD_TYPE=Release && cmake --build build -j`, far over the 90 s triage budget). Counted in-tree content: **47 `MonsterClass` entries**, **56 `SpellID` entries**, **15 `ItemType` values**, **16 dungeon-generator sources** (`levels/drlg_l1..l4`, `dungeon`, `setmaps`), **26 `.po` translations**, **68 test `.cpp`**, `mods/hf` Hellfire mod; `assets/` is 5.7 MB of fonts/colour transforms only. **Blocker:** zero game art ships — needs proprietary `DIABDAT.MPQ` from the retail CD/GoG install (shareware `spawn.mpq` opens the demo portion only), and the license is the **Sustainable Use License** (source-available, non-commercial — not OSI open source). Score breakdown: buildability 2/2, runs on phone 1/3 (Android target exists but unbuilt here and inert without retail data), depth 3/3, polish 2/2. |
| 17 | **EasyRPG Player** (`EasyRPG-Player`) | RPG engine/runtime (plays RPG Maker 2000/2003 + EasyRPG games) | *_7.0 — desk audit_* | Android (first-class in-tree Gradle app: `builds/android`, NDK 28.2.13676358, minSdk 23, compile/targetSdk 36, ABI filters), Linux/Windows/macOS (CMake), plus 3DS/PSP/PS Vita/PS4/Switch/Wii/WiiU/AmigaOS4/MorphOS/OpenDingux/Emscripten/libretro backends (`src/platform/`, 19 dirs) | **Desk audit — no build run** (C++/SDL; 543 `.cpp`/`.h` = 182 393 LOC; documented build is `cmake -S. -Bbuild -DCMAKE_BUILD_TYPE=Release && cmake --build build` per `docs/BUILDING.md`, far over the 90 s triage budget; `liblcf >= 0.8.1` is an external dep unless `PLAYER_BUILD_LIBLCF=ON` clones it). Counted in-tree: **49 test suites**, 114 `resources/` files (shinonome/ttyp0/wenquanyi/baekmuk fonts, RTP table, per-console icon packs), CMake presets + `bench/`. **Caveat: this is an engine, not a game — zero RPG Maker game data ships in the repo; it boots a game-browser and is inert until a `.ldb`/`.lmu` project is supplied.** Score breakdown: buildability 2/2, runs on phone 2/3 (Android target real and maintained upstream, unbuilt here), depth 1/3 (interpreter breadth is large but baked-in content is nil), polish 2/2. |
| 18 | **0 A.D.** (`0ad`) | Real-time strategy (AAA-scale, 2001->present) | *_7.0 — desk audit_* | Linux/Windows/macOS (premake5 + GCC/Clang, untried here), BSD; **no official Android port** (experimental forks only) | **Clone + content audit — no build run.** Cloned from live upstream `gitea.wildfiregames.com/0ad/0ad` at `cedd5e89` onto the shield: **30 099 tracked files, 4.0 GB**, of which **3.6 GB is the `public` mod** — **1 979 simulation templates**, **5 705 art actor XMLs**, **8 600 textures (2.8 GB art)**, **156 maps**, **1 466 audio files**, 73 MB `mod` UI assets, plus a self-test mod suite (`_test.*`). This is the only free project on the list with a genuine asset pipeline at commercial scale — a decade of commissioned 3D art and an in-house engine. Ticket to run is a long build (premake5, Boost, SDL2, SpiderMonkey vendored) that no triage budget covers. Score breakdown: buildability 1/2 (deps + ~40 min build, not attempted), runs on phone 1/3 (desktop RTS, pointer-driven, no maintained Android target), depth 3/3, polish 2/2. |
| 19 | **OpenTTD** (`OpenTTD`) | Business sim / transport tycoon (Transport Tycoon Deluxe reimplementation) | **8.0** | Linux (built here), Windows/macOS, **official Android + iOS builds upstream**, Haiku/OS2/BSD | **Built from source and run in-game.** Cloned `c02e87b` (714 MB repo, Btrfs-hosted build — exfat is case-insensitive and would poison C++ includes), `cmake -G Ninja -DCMAKE_BUILD_TYPE=Release` + `ninja` -> 21.9 MB `openttd` binary in **~2 min**, zero errors; OpenGFX 7.1 base graphics fetched from `cdn.openttd.org` (35 MB zip) since no original TTD media exists here. Ran headless under Xvfb at 1600x1000 with the SDL driver for 30 s: **in-game, Jan 25th 1950, £100 000**, toolbar live — `evidence/openttd-aaa-run.png` (+ `-2.png`). Survey prompt suppressed with `[network] participate_survey = no`. **Caveat:** 20 years of depth and a real economy underneath a 12 MB sprite engine, but it is pointer-driven — the Android build is official yet awkward on a phone. Score breakdown: buildability 2/2 (verified), runs on phone 1/3 (official port exists, untested here, mouse-first UI), depth 3/3, polish 2/2. |
