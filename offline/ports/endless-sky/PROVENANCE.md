# endless-sky — provenance

Everything this repository claims about the title, in one file. Regenerate with `python3 tools/ports-provenance.py`.

| field | value |
|---|---|
| upstream | https://github.com/endless-sky/endless-sky |
| license | GPL-3.0 |
| pinned commit | `c3c7908` (2026-10-24) — feat: Track play time globally and on a pilot level, and track idle time separately (#12835) |
| local clone | `/home/cluer/crg/games/endless-sky` |
| artifact | `/home/cluer/crg/games/endless-sky/build/endless-sky` |
| artifact type | binary |
| size | 4,890,648 bytes (4.9 MB) |
| sha256 | `486ce1d43ffeeae05bfdea3842b076f18cca87ca245e28b6fd74750311ddc9eb` |

## Build recipe (the commands actually run)

```sh
cd /home/cluer/crg/games/endless-sky
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && ninja -C build  (then run build/endless-sky)
```

## Install

Desktop build: run `/home/cluer/crg/games/endless-sky/build/endless-sky`. No Android APK is checked into the clone; the verified artifact is the desktop build.

## Notes

No Android APK is checked into the clone; the verified artifact is the desktop build. For phones, use the project's official Android release or stream it from a desktop host. Open-world space trading and combat, entirely offline.

## Licence

GPL-3.0. The upstream licence text is authoritative and lives in the clone at `/home/cluer/crg/games/endless-sky`; this repository carries no copy of it and vendors none of the source.
