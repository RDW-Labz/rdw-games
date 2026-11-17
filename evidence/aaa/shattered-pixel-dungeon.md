# Shattered Pixel Dungeon

- **Repo:** https://github.com/00-Evan/shattered-pixel-dungeon
- **Stars:** 6,709 | **License:** GPL-3.0 | **Language:** Java | **Engine:** custom libGDX (Watabou SPD engine fork)
- **Version tested:** v4.0.2 (commit 57a4e06, 2026-10-06; repo pushed 2026-10-07 — actively maintained)

## Game type & platforms
Roguelike dungeon crawler (Pixel Dungeon remake — the reference free roguelike on mobile). Officially supported: **Android, iOS, desktop** (Windows/macOS/Linux), plus Nintendo Switch port. Modules: `core/`, `SPD-classes/` (engine), `android/`, `ios/`, `desktop/`, `services/`.

## Build log summary
Commands (from `docs/getting-started-desktop.md` / `getting-started-android.md`), with `JAVA_HOME=~/tools/jdk21` (Temurin 21), `ANDROID_HOME=~/Android/Sdk`:

1. `./gradlew :desktop:release --no-daemon --max-workers=8` → **BUILD SUCCESSFUL** (exit 0, only config-cache advisories). Fat jar `desktop/build/libs/desktop-4.0.2.jar`, **52 MB**.
2. `ANDROID_HOME=~/Android/Sdk ./gradlew :android:assembleDebug --no-daemon --max-workers=8` → **BUILD SUCCESSFUL** (exit 0). APK `android/build/outputs/apk/debug/android-debug.apk`, **35.1 MB**, package `com.shatteredpixel.shatteredpixeldungeon.indev` v4.0.2-INDEV (versionCode 922), minSdk 21 / targetSdk 36, compileSdk 36, 8 native `.so` (libGDX, multi-ABI). Logs: `~/freegames/logs/shattered-{desktop-build,android-build}.log`.

No source patches needed; both builds clean from scratch on first try.

## Runtime smoke evidence
- `timeout 45 xvfb-run -a java -jar desktop-4.0.2.jar`: process ran the full 45s, zero exceptions/crashes in log (`~/freegames/logs/shattered-desktop-run.log`); `[Controllers] added manager for application` (gdx-controllers) initializes only after the LWJGL3/GLFW window + game loop are up.
- Second boot under persistent `Xvfb :97`: **GAME_ALIVE_AFTER_22S**, grabbed framebuffer with ffmpeg x11grab → `~/freegames/logs/shattered-frame.png`. signalstats: YMIN=16, YAVG=34.7, YMAX=235 — fully rendered content (title screen), not a blank/black display.
- APK not installed to emulator per task constraints; packaged and badging-verified instead.

## Mobile-optimization evidence
- Full **`android/` module**: `AndroidLauncher.java` (fullscreen libGDX `AndroidApplicationClient`, GL2), `AndroidPlatformSupport.java` (device info, backup handler), `AndroidManifest.xml` (GLES2 `uses-feature`, VIBRATE, INTERNET for update check only).
- Full **`ios/` module** with RoboVM: `robovm.xml` (arm64, iOS Info.plist, bundled assets), `IOSLauncher.java`, `IOSPlatformSupport.java`; `docs/getting-started-ios.md`.
- Touch input: `SPD-classes/src/main/java/com/watabou/input/InputHandler.java` — libGDX `InputAdapter` + `InputMultiplexer` (`input.setInputProcessor(multiplexer)`), tap/swipe-to-move semantics, shared across all platforms; keyboard/gamepad layered on top.
- Screen scaling/DPI: engine renders at dynamic pixel scale (`Game.screenResize`, uiScale options) so the 16px art fits phones/tablets/desktops; manifest + launcher handle fullscreen/rotation.
- Offline play: fully offline single-player; network used only for update/news service (pluggable `services/` module).

## Score breakdown
| Category | Score | Notes |
|---|---|---|
| Gameplay depth & polish | 30/30 | Gold-standard roguelike: 6 hero classes, 30+ floors, artifacts, challenges, daily runs, 25+ years of Pixel Dungeon lineage, polished commercial-grade free game |
| Mobile optimization | 24/25 | First-class Android+iOS projects in-repo, touch-first input, DPI scaling, offline; iOS build requires macOS (can't verify on Linux) |
| Build health | 15/15 | Desktop jar + debug APK built clean on this host, documented steps, zero patches |
| Runtime smoke | 13/15 | Desktop boots + renders frames under Xvfb, 45s+ stable; APK launch on emulator skipped by design |
| Code quality & activity | 13/15 | 6.7k stars, pushed Oct 2026, clean multi-module structure, GPL-3.0; no CI workflows in repo |
| **Total** | **95/100** | **S** |

## Verdict
The best open-source roguelike, full stop — clean two-platform builds on first try and mobile is a first-class citizen, not an afterthought. An instant S-tier lock for the main list.
