# shattered-pixel-dungeon — provenance

Everything this repository claims about the title, in one file. Regenerate with `python3 tools/ports-provenance.py`.

| field | value |
|---|---|
| upstream | https://github.com/00-Evan/shattered-pixel-dungeon |
| license | GPL-3.0 |
| pinned commit | `57a4e06` (2026-10-06) — v4.0.2: updated changelog, version, and translations for v4.0.2 release! |
| local clone | `/home/cluer/cloned-free-games/games/shattered-pixel-dungeon` |
| artifact | `/home/cluer/cloned-free-games/games/shattered-pixel-dungeon/android/build/outputs/apk/debug/android-debug.apk` |
| artifact type | apk |
| size | 35,133,909 bytes (35.1 MB) |
| sha256 | `73c62f7c3e438ff0e6bc93528d421497e5be9f5a728af94bec7c06a7fa1297f3` |
| re-verified | no — the donor clone is not on this machine; the pin, size and hash above are the values recorded when it was |
| package / version | `com.shatteredpixel.shatteredpixeldungeon` 4.0.2 |
| ABIs in the artifact | arm64-v8a, armeabi-v7a, x86, x86_64 |

## Build recipe (the commands actually run)

```sh
cd /home/cluer/cloned-free-games/games/shattered-pixel-dungeon
./gradlew android:assembleDebug  (LibGDX + gdx-freetype; needs JDK 21 and the Android SDK at local.properties)
```

## Install

`adb install -r android-debug.apk` — or copy the APK to the phone and open it. Package `com.shatteredpixel.shatteredpixeldungeon` version `4.0.2`, ABI arm64-v8a, armeabi-v7a, x86, x86_64.

## Notes

Single-player roguelike, no network code at all. The deepest permadeath dungeon crawler in the collection.

## Licence

GPL-3.0. The upstream licence text is authoritative and lives in the clone at `/home/cluer/cloned-free-games/games/shattered-pixel-dungeon`; this repository carries no copy of it and vendors none of the source.
