# darkplaces — provenance

Everything this repository claims about the title, in one file. Regenerate with `python3 tools/ports-provenance.py`.

| field | value |
|---|---|
| upstream | https://github.com/evilant0/DarkPlaces |
| license | GPL-2.0 |
| pinned commit | `10d4863` (2026-10-20) — Update SDL2 nuget package version. |
| local clone | `/home/cluer/crg/games/darkplaces` |
| artifact | `/home/cluer/crg/games/darkplaces/darkplaces-sdl` |
| artifact type | binary |
| size | 4,253,952 bytes (4.3 MB) |
| sha256 | `a1e0ad9d9d403c9e1578e7f5a7fa65be2c3a4f6919b0a3a59b026b457ac4f19b` |

## Build recipe (the commands actually run)

```sh
cd /home/cluer/crg/games/darkplaces
make sdl-release  (then copy the freely redistributable shareware pak0.pak into id1/ and run ./darkplaces-sdl -basedir .)
```

## Install

Desktop build: run `/home/cluer/crg/games/darkplaces/darkplaces-sdl`. Quake engine.

## Notes

Quake engine. Ships instructions to fetch the shareware pak only — never a retail pak. Timedemo measured at 98.5 fps average on the reference machine.

## Licence

GPL-2.0. The upstream licence text is authoritative and lives in the clone at `/home/cluer/crg/games/darkplaces`; this repository carries no copy of it and vendors none of the source.
