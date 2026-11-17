# Mindustry — Judgment Report

## 1. Header
- **Repo:** https://github.com/Anuken/Mindustry
- **Stars:** 29,446
- **License:** GPL-3.0
- **Language:** Java (835 `.java` files across core/desktop/server/android/ios)
- **Engine:** Arc (Anuken's libGDX-fork engine, built as external dependency) + Box2D
- **Last push:** 2026-10-22 (day before this review)

## 2. Game type & platforms
- **Genre:** Tower-defense factory RTS (belt-driven supply chains, turrets, unit production, campaigns on two planets: Serpulo and Erekpe, PvP, co-op, map editor, mod support)
- **Official platforms:** Android (Google Play), iOS (App Store), desktop (Windows/macOS/Linux, incl. Steam), web (Mindustry.in browser build)

## 3. Build log summary
- Source obtained via `curl --http1.1 https://codeload.github.com/Anuken/Mindustry/tar.gz/refs/heads/master` (59.7 MB) — repeated `git clone --depth 1` died mid-transfer with `fetch-pack: unexpected disconnect` on this host's network; tarball is equivalent to a depth-1 checkout. Extracted to `~/freegames/work/mindustry`.
- Commands (JAVA_HOME=`~/tools/jdk21`, PATH prepended):
  - `./gradlew :desktop:jar -x test --no-daemon --max-workers=8` → **BUILD SUCCESSFUL in 2m 1s** (10 tasks; log: `~/freegames/logs/mindustry-build.log`) — produces thin jar `desktop-release.jar` (47 KB).
  - `./gradlew :server:dist :desktop:dist -x test --no-daemon --max-workers=8` → **BUILD SUCCESSFUL in 41s** (log: `~/freegames/logs/mindustry-dist.log`) — fat runnable jars: `desktop/build/libs/Mindustry.jar` (**88.5 MB**) and `server/build/libs/server-release.jar` (**19.3 MB**).
- Note: the runnable desktop/server artifacts are the `dist` fat-jar tasks, not bare `:desktop:jar`.
- Zero compile errors or configuration friction on JDK21.

## 4. Runtime smoke evidence
Ran the **headless server** (`server-release.jar`) on JDK21, driving its interactive console over stdin (`host` command, log excerpts from `~/freegames/logs/srvtest/boot4.log`):

```
[10-23-2026 07:06:19] [I] Server loaded. Type 'help' for help.
[10-23-2026 07:06:28] [I] Randomized next map to be Maze.
[10-23-2026 07:06:28] [I] Loading map...
[10-23-2026 07:06:28] [I] Map loaded.
[10-23-2026 07:06:28] [I] Opened a server on port 6567.
[10-23-2026 07:06:48] [I]   Playing on map Maze / Wave 1
[10-23-2026 07:06:48] [I]   220 seconds until next wave.
[10-23-2026 07:06:48] [I]   61 FPS, 39 MB used.
[10-23-2026 07:06:51] [I] Shutting down server.
```

The full game engine boots: world/rules loaded, map ticked (wave timer counting), 61 FPS headless tick, clean shutdown. Console command parsing verified (`--help`, unknown-map and status commands handled with proper error messages). No errors/exceptions in boot logs. Desktop GUI not launched (no display on host — expected); game traffic is UDP so a TCP probe is not meaningful.

## 5. Mobile-optimization evidence
- **`android/` module in-repo:** `android/src/mindustry/android/AndroidLauncher.java` (full Android backend), `android/build.gradle` with `minSdkVersion 21` / `targetSdkVersion 36`; README documents `gradlew android:assembleDebug` APK build.
- **DPI/screen-density assets:** `android/res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,anydpi-v26}` — proper multi-density icon/scaling pipeline.
- **iOS project in-repo:** `ios/` RoboVM project — `robovm.xml`, `robovm.properties` (`app.id=io.anuke.mindustry`, `app.mainclass=mindustry.ios.IOSLauncher`), `Info.plist.xml`.
- **Touch input handling:** dedicated `core/src/mindustry/input/MobileInput.java` (touch-first placement/planning layer vs `DesktopInput.java`), referenced from `InputHandler`.
- **Store tooling:** `fastlane/` (Appfile, Fastfile, store metadata) for automated Play Store shipping.
- Shipped, live, paid/Free games on both Google Play and the App Store; fully offline-capable.

## 6. Score breakdown
| Category | Score | Rationale |
|---|---|---|
| Gameplay depth & polish | 28/30 | Two-planet campaigns, hundreds of blocks/units, PvP/co-op, editor, mods, 62 MB of assets — a commercially shipped, award-level game, not a toy |
| Mobile optimization | 24/25 | First-class Android+iOS projects in-repo, dedicated touch input layer, density-specific assets, fastlane shipping; offline play |
| Build health | 14/15 | Clean build on JDK21 on first try (2m + 41s); minor friction: git clone network drops (tarball fallback) and `jar` vs `dist` task naming |
| Runtime smoke | 15/15 | Headless server boots engine, hosts live world on port 6567, ticks at 61 FPS, graceful shutdown |
| Code quality & activity | 15/15 | 29.4k stars, GPL-3.0, pushed yesterday, 4 GitHub Actions workflows (CI + wrapper validation + tagged deploys), clean modular structure |
| **Total** | **96/100** | **Tier S** |

## 7. Verdict
Mindustry is the gold standard of open-source games: a deep, commercially released factory-RTS that builds clean from scratch in minutes and boots a live ticking headless server with world simulation out of the box, with first-class Android and iOS targets sitting right in the repo.
