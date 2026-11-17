# mindustry — provenance

Everything this repository claims about the title, in one file. Regenerate with `python3 tools/ports-provenance.py`.

| field | value |
|---|---|
| upstream | https://github.com/Anuken/Mindustry |
| license | GPL-3.0 |
| pinned commit | `b873c01` (2026-10-22) — Merge remote-tracking branch 'origin/master' |
| local clone | `/home/cluer/cloned-free-games/games/Mindustry` |
| artifact | `/home/cluer/cloned-free-games/games/Mindustry/android/build/outputs/apk/debug/android-debug.apk` |
| artifact type | apk |
| artifact | **missing on disk** — rebuild from the recipe below |
| package / version | `io.anuke.mindustry` 9-bleeding-edge-28063 |
| ABIs in the artifact | arm64-v8a, armeabi-v7a, x86, x86_64 |

## Build recipe (the commands actually run)

```sh
cd /home/cluer/cloned-free-games/games/Mindustry
./gradlew android:assembleDebug  (JDK 21; keep minifyEnabled true — without R8 desugaring the app dies on boot with AbstractMethodError)
```

## Install

`adb install -r android-debug.apk` — or copy the APK to the phone and open it. Package `io.anuke.mindustry` version `9-bleeding-edge-28063`, ABI arm64-v8a, armeabi-v7a, x86, x86_64.

## Notes

The Arc engine it depends on is pinned locally at cloned-free-games/games/Arc (commit 7445105cd2). Campaign is fully offline; LAN multiplayer is optional and never required.

## Licence

GPL-3.0. The upstream licence text is authoritative and lives in the clone at `/home/cluer/cloned-free-games/games/Mindustry`; this repository carries no copy of it and vendors none of the source.
