# luanti — provenance

Everything this repository claims about the title, in one file. Regenerate with `python3 tools/ports-provenance.py`.

| field | value |
|---|---|
| upstream | https://github.com/luanti-org/luanti |
| license | LGPL-2.1+ |
| pinned commit | `32bb549` (2026-10-22) — Builtin: Do not translate /clearobjects "full |
| local clone | `/home/cluer/cloned-free-games/games/luanti` |
| artifact | `/home/cluer/cloned-free-games/games/luanti/android/app/build/outputs/apk/debug/app-arm64-v8a-debug.apk` |
| artifact type | apk |
| size | 22,378,594 bytes (22.4 MB) |
| sha256 | `f7727c751a7661fd1443ef575a9863da2c7ee9982537c5276c4321ca9b5171e0` |
| re-verified | no — the donor clone is not on this machine; the pin, size and hash above are the values recorded when it was |
| package / version | `net.minetest.minetest` 5.17.0 |
| ABIs in the artifact | arm64-v8a |

## Build recipe (the commands actually run)

```sh
cd /home/cluer/cloned-free-games/games/luanti
cd android && ./gradlew assembleDebug  (NDK 28.2; the ABI-split build produces app-<abi>-debug.apk per target)
```

## Install

`adb install -r app-arm64-v8a-debug.apk` — or copy the APK to the phone and open it. Package `net.minetest.minetest` version `5.17.0`, ABI arm64-v8a.

## Notes

Sandbox voxel world; single-player and LAN are both offline-capable. Four ABI-split APKs exist in the clone — arm64-v8a is the one shipped here. No content mods are bundled; the base game is complete on its own.

## Licence

LGPL-2.1+. The upstream licence text is authoritative and lives in the clone at `/home/cluer/cloned-free-games/games/luanti`; this repository carries no copy of it and vendors none of the source.
