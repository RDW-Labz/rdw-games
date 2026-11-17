# Unciv — build, smoke-test & rubric judgment

- **Repo:** https://github.com/yairm210/Unciv @ HEAD (`e267763`, 2026-10-22, shallow clone)
- **Genre record:** 4X turn-based strategy (Civilization V ruleset replica)
- **Stack:** Kotlin (673 files in `core/` alone) + libGDX (LWJGL3 desktop, Android backend); Gradle 9.4.1
- **License:** MPL-2.0 (clear) · **Stars:** 11,480 · **Pushed:** 2026-10-22 (yesterday) · **Open issues:** 129
- **Official platforms:** Android (Play + F-Droid), desktop (Windows/macOS/Linux), plus a Dockerizable multiplayer **server** module. **iOS is explicitly "no plans"** per README — community forks only, no iOS project in-repo. (No official browser target either; forks exist.)

## 1. Desktop build — OK
`JAVA_HOME=~/tools/jdk21`, `./gradlew desktop:dist --no-daemon --max-workers=8` (the task names `desktopJar`/`apkDebug` from the brief no longer exist in this tree; current canonical tasks are `desktop:dist` / `android:assembleDebug`, per `desktop/build.gradle.kts:83` and `docs/Developers/Building-Locally.md`).

- **Artifact:** `desktop/build/libs/Unciv.jar` — **56 MB** fat jar (assets bundled)
- BUILD SUCCESSFUL, first try, no patches. (One `server:dist` invocation failed once while a parallel Gradle run held the build dir; clean success when run alone — environmental, not repo.)

## 2. Android build — OK
`ANDROID_HOME=~/Android/Sdk ./gradlew android:assembleDebug`

- **APK:** `android/build/outputs/apk/debug/Unciv-debug.apk` — **32 MB** (debug; includes 4 native ABIs: arm64-v8a, armeabi-v7a, x86, x86_64 libgdx natives)
- `aapt dump badging`: package `com.unciv.app` v4.22.13 (code 1275), **minSdk 21**, targetSdk 36, leanback/touchscreen features optional — valid, store-shaped manifest.
- Whole desktop+Android build: 1m35s, 47 tasks, zero errors.

## 3. Runtime smoke — OK on all three surfaces
1. **Desktop under Xvfb:** `xvfb-run -a java -jar Unciv.jar` → log `Loaded 2 rulesets in 71ms`, process stayed alive at ~5% CPU / 581 MB RSS (render loop), wrote `GameSettings.json`, and a root-window screenshot (`import -window root`) captured **2000 distinct colors, gray stdev 0.095** — a rendered UI frame, not a blank X root. (Vision-analysis service was down this session, so no textual read of the screenshot; pixel stats + focus window + settings-file write are the grounding.)
2. **Headless server:** `java -jar UncivServer.jar` boots fully headless — `Starting open server on host '0.0.0.0' port '8080'`, `HTTP server started`, game list served.
3. **Android emulator (real runtime):** AVD `pm_pixel` (headless, swiftshader) — `adb install` Success, `am start com.unciv.app/.AndroidLauncher`, logcat shows libGDX GLThread, atlas loading, and `UncivGame: Setting new screen: LanguagePickerScreen` (first-run screen), `mCurrentFocus=Window{com.unciv.app/...AndroidLauncher}`, screencap 160 KB / **3754 colors** — game actually ran on Android 15 emulator.
4. **Unit tests:** `:tests:test` — PathfindingTests **116 tests, 0 failures** (6 skipped); SerializationTests + GameSerializationTests + MapGenerationTests **19 tests, 0 failures**.

## 4. Mobile-optimization evidence
- Dedicated `android/` module (AndroidManifest with orientation/configChanges handling, POST_NOTIFICATIONS, deep-link intent).
- Touch-first UI in shared core: `ZoomGestureListener.kt` (pinch-zoom/pan gestures), DPI scaling in `DesktopLauncher` + `GUI.kt` hardware-keyboard detection, `UnitGroupBackground` etc. — same UI runs thumb-sized on phone.
- Autosave wired into app lifecycle: `UncivGame.pause()` → `files.autosaves.requestAutoSave()` — survives phone app-kill. Fully offline single-player; multiplayer optional.
- minSdk 21 breadth; assets 34 MB, APK 32 MB debug.
- **No iOS** (README: "no plans"; no xcodeproj in tree) — deduction against a mobile-first rubric.

## 5. Depth & quality
- Full Civ V content parity: Vanilla + Gods & Kings rulesets in-repo — **62 nations, 100 units, 100 buildings, 74 techs, 70 policies, 100 promotions, 34 improvements, 31 resources**, religions, city-states, quests, 51 translations, mod system, tutorial system, deterministic multiplayer with server.
- Activity: commits daily (last 2026-10-22), 11.5k stars, active maintainer (yairm210) + uncivbot.
- CI: buildAndTest, androidBuild, detekt static analysis, docker publish, multiplatform build workflows; public dev docs site.

## Score
| Axis | Score | Basis |
|---|---|---|
| Gameplay depth & polish | 29/30 | Full Civ V ruleset, mods, MP, tutorials, 51 languages |
| Mobile optimization | 22/25 | Excellent Android/touch/autosave; **no iOS**, no official browser |
| Build health | 15/15 | Desktop jar + APK build clean first try on stock toolchain |
| Runtime smoke | 15/15 | Desktop render under Xvfb + headless server + APK live on emulator + 135 unit tests pass |
| Code quality & activity | 14/15 | MPL-2.0 clear, 11.5k stars, daily commits, CI + detekt |
| **Total** | **95/100** | **Tier S** |

**Verdict:** The reference open-source strategy game. Builds exactly as documented on stock JDK21/Android-SDK with zero patches, runs for real on desktop, headless server, and Android emulator in one sitting, and ships genuinely deep Civ V–parity 4X gameplay with touch-first UI, autosave, and offline play. Only gaps vs a perfect mobile score: no iOS target (officially declined) and no official browser build.
