# Port lane — provenance and build notes

The six port titles are **not vendored** in this repository. Each is referenced by
upstream URL, licence and pinned commit, plus the exact commands used to produce the
artifact that was verified. That keeps the repo cloneable (no multi-gigabyte engine
sources, no Gradle caches) while making every claim reproducible.

Why not vendor: Mindustry's engine, Luanti's C++ tree and Endless Sky's assets add up to
well over a gigabyte. Vendoring them would also mean shipping their licences in bulk and
re-syncing forks forever. A provenance manifest + build recipe gives the same guarantee —
"this is the game, this commit, this licence" — at 2 KB per title.

| id | upstream | licence | artifact verified |
|---|---|---|---|
| `mindustry` | [Anuken/Mindustry](https://github.com/Anuken/Mindustry) | GPL-3.0 | Android debug APK (arm64) |
| `shattered-pixel-dungeon` | [00-Evan/shattered-pixel-dungeon](https://github.com/00-Evan/shattered-pixel-dungeon) | GPL-3.0 | Android debug APK |
| `luanti` | [luanti-org/luanti](https://github.com/luanti-org/luanti) | LGPL-2.1+ | 4 ABI-split APKs |
| `endless-sky` | [endless-sky/endless-sky](https://github.com/endless-sky/endless-sky) | GPL-3.0 | desktop binary |
| `darkplaces` | [DarkPlaces engine](https://github.com/evilant0/DarkPlaces) | GPL-2.0 | `darkplaces-sdl` binary |
| `ddnet` | [ddnet/ddnet](https://github.com/ddnet/ddnet) | Zlib | `DDNet` binary |

Each folder holds a `PROVENANCE.md` with the pinned commit, the build commands that were
actually run, the resulting artifact's size and hash, and the licence text pointer.
