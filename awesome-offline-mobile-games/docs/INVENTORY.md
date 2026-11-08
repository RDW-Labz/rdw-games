# Inventory — what was actually in `cloned-free-games`

Audited 2026-10-28 against the live trees, not against the README.

## Two trees, and why that matters

| Tree | Path | Size | What it is |
|---|---|---|---|
| Metadata repo | `cloned-free-games/` (git, origin `RDW-Labz/cloned-free-games`) | **17.3 GB** working tree / 90,141 files | The real thing: 14 upstream clones in `games/`, 29 build logs, 52 evidence screenshots, 6 harness scripts |
| Earlier workspace copy | `…/workspace/cloned-free-games/` | 7.5 MB | Docs only (`CATALOG.md`, `GAMES.md`, `GAMES.lock`, `README.md`, `AAA_MOBILE_GAMES.md`) — no `games/` payload |

The 7.5 MB figure that circulated earlier was the docs-only copy. **All reusable code lives in
the 17.3 GB tree.** This repo therefore *references* the clones by path+commit and never vendors
them (`SCOPE-GATE.md` decision 4).

## Per-clone payload

| Clone | Size | Android project? | Built APK present | Status in catalog |
|---|---|---|---|---|
| `Cataclysm-DDA` | 7.4 G | yes (`android/`) | no | **Unscored** — 4 build attempts logged (`build-cdda{,2,3,4}.log`), none produced an APK |
| `luanti` | 5.7 G | yes | **4 ABIs**, 19.0–22.7 MB | Scored 9.0, builds + boots |
| `stk-assets` | 2.5 G | n/a | n/a | Asset mirror for `stk-code` |
| `Mindustry` | 584 M | yes | **79.3 MB** | Scored 9.5, 10+ min stable |
| `shattered-pixel-dungeon` | 308 M | yes | **33.5 MB** | Scored 9.0, boots to menu |
| `Unciv` | 290 M | yes | **31.0 MB** | Scored 8.5, renders to screen |
| `stk-code` | 260 M | yes | no | Scored 8.0, desktop benchmark only |
| `sgtpuzzles` | 208 M | yes | **22.9 MB** | Present, not scored in `CATALOG.md` |
| `openttd` | 197 M | no (official ports elsewhere) | no | Scored 8.5, desktop verified |
| `OpenRA` | 146 M | no (needs .NET 8) | no | Desktop-only reference |
| `Arc` | 104 M | n/a | n/a | Mindustry's engine dependency (local, pinned `7445105cd2`) |
| `clumsy-bird` | 7.5 M | n/a (MelonJS web) | n/a | Scored 5.0 |
| `FlappyBird` | 6.9 M | yes (MonoGame) | 0.1 MB | Scored 3.5, not a phone target |
| `hextris` | 2.6 M | n/a (canvas web) | n/a | Scored 6.5 |
| `2048` | 1.1 M | n/a (DOM web) | n/a | Scored 6.0 |
| `OpenTTD/` (top level) | 279 M | — | — | Second, older build tree at repo root |
| `~/crg/games/{ddnet,darkplaces,endless-sky}` | — | mixed | no | Desktop-verified, **not** inside the repo tree |

### APKs already on disk (total 9 artifacts)

```
79.3 MB  Mindustry/android/build/outputs/apk/debug/android-debug.apk
33.5 MB  shattered-pixel-dungeon/android/build/outputs/apk/debug/android-debug.apk
31.0 MB  Unciv/android/build/outputs/apk/debug/Unciv-debug.apk
22.9 MB  sgtpuzzles/app/build/outputs/apk/debug/app-debug.apk
22.7 MB  luanti/…/app-x86-debug.apk
21.7 MB  luanti/…/app-x86_64-debug.apk
21.3 MB  luanti/…/app-arm64-v8a-debug.apk
19.0 MB  luanti/…/app-armeabi-v7a-debug.apk
 0.1 MB  FlappyBird/…/FlappyBird-signed.apk
```

## Tooling that is reusable (and was reused)

- `scripts/android-env.sh` — SDK/NDK/Gradle env bootstrap (this repo's `tools/android-env.sh` derives from it).
- `scripts/test-web-game.sh` — serve → open in emulator Chrome → inject tap/swipe → pixel-diff before/after. The pattern behind `tests/smoke.mjs`.
- `scripts/fetch-games.sh` + `GAMES.lock` — the clone-on-demand model this repo adopts by reference.
- `evidence/*.png` — 52 screenshots; used here only as citations in `docs/HYBRIDIZATION.md`, never re-shipped.

## Scored leaderboard (carried forward)

| # | Title | Score | Lane here |
|---|---|---|---|
| 1 | Mindustry | 9.5 | port |
| 2 | Shattered Pixel Dungeon | 9.0 | port |
| 3 | Luanti | 9.0 | port |
| 4 | Endless Sky | 9.0 | port |
| 5 | DarkPlaces | 9.0 | port |
| 6 | Unciv | 8.5 | *lineage only* → Tessera |
| 7 | OpenTTD | 8.5 | *lineage only* → Tessera |
| 8 | DDNet | 8.5 | port |
| 9 | SuperTuxKart | 8.0 | *lineage only* → Rift Nine |
| 10 | Hextris | 6.5 | *lineage only* → Overrun grid math |
| 11 | 2048 | 6.0 | not used |
| 12 | Clumsy Bird | 5.0 | not used |
| 13 | FlappyBird | 3.5 | not used |
| — | Cataclysm-DDA | — | candidate, blocked (no APK) |

## What the clones were used for, per hybrid

The cross-hybrids (SCOPE-GATE decision 8) draw on the same trees, so the audit trails below are
the ones that matter when questioning a hybrid's provenance. The last two entries are the
2026-10-30 pair, which take a donor's *data* rather than a sibling original's engine:

| Hybrid | Clone whose systems were copied | Clone whose systems *and* files were crossed in | Files taken | Not taken |
|---|---|---|---|---|
| Siegehaus | `shattered-pixel-dungeon` (via `games/vaultbreak`) | `Mindustry` | Mindustry: 30 `items/item-*.png`, `belt`/`belt_anim`, `drill`, `turret` — 36 sprites. SPD: 3 terrain atlases, 11 sheets, sounds | no Mindustry Java/Kotlin, no `core/src` logic — belts and drills are authored in `games/siegehaus` |
| Charterline | `Unciv` (via `games/tessera`) | `endless-sky` + `luanti` | ES: 10 commodities with prices. Luanti: 15 node-material textures from `devtest/mods/basenodes` | no Unciv tilesets (flat-top, wrong for a pointy-top hex), no Luanti engine code |
| Nulltrace | `ddnet` + `darkplaces` (movement feel) via `games/rift-nine` | `endless-sky`, `stk-assets` | ES ship sprites, STK audio already vendored for the lineage title | no Quake pak — none exists in the tree, so the arena layer is authored |
| Lanternfall | `endless-sky` (via `games/ember-drift`) | — (Quake-era cadence is authored) | ES: 13 ship sprites, 120-hull table, 10 commodities | no Quake assets, no DarkPlaces code |
| Cinderhold | new build — no parent original; DCSS's vault corpus is the level source | `flare-game` | DCSS: 420 vault layouts normalised out of 6,127 `MAP` grids, 100 tiles. Flare: 12 portraits, 6 painted menu panels, 2 HUD atlases, 140 item records, monster sheets used as a palette source | no Flare engine (Lua/C++), no DCSS code — floors are drawn and simulated in `games/cinderhold` |
| Wardenmarch | new build — no parent original; Wesnoth's unit rules are the combat model | `dcss` (arena geometry) | Wesnoth: 22 unit records with sprites and portraits, 14 terrain tiles, 2 tracks. DCSS: the same vault corpus, filtered to 10–22-wide arenas | no Wesnoth engine (WML interpreter), no DCSS code — turns, movement BFS and attack resolution are authored in `games/wardenmarch` |

## The AAA reference list

`AAA_MOBILE_GAMES.md` scores 12 commercial free-to-play titles (Genshin, HSR, CoD Mobile,
Wuthering Waves, Where Winds Meet, Asphalt 9, Wild Rift, Marvel Snap, Brawl Stars, Monument
Valley 2, Alto's Odyssey, Once Human). They are **closed-source and cannot be cloned**, and
six of the twelve fail this collection's offline or no-account rules outright. They are kept
as a **quality bar**, not as candidates: `docs/QUALITY-BAR.md` turns their strongest design
choices into the acceptance checklist the four original titles and all six hybrids are measured against.
