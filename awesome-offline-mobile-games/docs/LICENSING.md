# Licensing

This collection is two bodies of work glued together, and they do not share a licence.

**Our code** — the launcher, the four originals, the six cross-hybrids, the test harness and the tooling — is
MIT (`LICENSE` at the repo root). Reuse it however you like.

**The vendored content under `vendor/`** — ship hulls, sprites, audio and game-data
tables taken from ten upstream projects — stays under each upstream's licence. Those
licences were read from the upstream trees, not assumed, and each one's full text is
shipped next to its files.

| Source | Licence | What we redistributed | Files | Size |
|---|---|---|---|---|
| [Endless Sky](https://github.com/endless-sky/endless-sky) | GPL-3.0 | 120 ship hulls (name, class, cost, hull/shield/thrust/turn, cargo, crew, weapon damage) as two data tables, 120 ship sprites downscaled to ≤192 px, the 10 commodities with base prices | 120 | 2.68 MB |
| [Shattered Pixel Dungeon](https://github.com/00-Evan/shattered-pixel-dungeon) | GPL-3.0 | 78 pixel-art sprite sheets, 3 region terrain atlases (sewers/prison/caves, 16×16 grid of 16 px dungeon tiles), 67 sound effects re-encoded to Opus, 2 music tracks trimmed to 100 s — 69 audio files in all | 151 | 1.55 MB |
| [Unciv](https://github.com/yairm210/Unciv) | MPL-2.0 | the Civ V technology tree (74 techs over 18 columns, with eras, costs and quotes), 100 buildings, 100 units, 24 civilisations | 4 | 0.06 MB |
| [Cataclysm: Dark Days Ahead](https://github.com/CleverRaven/Cataclysm-DDA) | CC-BY-SA-3.0 | 180 items (name, category, price, weight, volume, description), 60 monsters, 60 recipes | 3 | 0.09 MB |
| [Mindustry](https://github.com/Anuken/Mindustry) | GPL-3.0 | 36 sprites: 30 item icons (`items/item-*.png`), the conveyor pair, the drill and the duo turret, copied byte-for-byte at their native 32 px | 37 | 0.05 MB |
| [Luanti](https://github.com/luanti-org/luanti) | LGPL-2.1-or-later and CC-BY-SA-3.0 | 15 node material textures from the `devtest` basenodes mod (grass, dirt, stone, sand, leaves, water and friends) | 16 | 0.02 MB |
| [SuperTuxKart assets](https://github.com/supertuxkart/stk-assets) | GPL-2.0+ and CC-BY-SA | 7 sound effects re-encoded to Opus and 2 music tracks trimmed to 90 s — 9 audio files | 11 | 0.92 MB |
| [Flare](https://github.com/clintbellanger/flare-game) | GPL-3.0, art CC-BY-SA-3.0 | 36 painted monster sheets and 12 portraits (downscaled to ≤512 px from sheets up to 6144²), 4 painted tilesets (≤2048 px), 6 menu panels, 4 icon sheets, 3 music tracks trimmed to 90 s, and **140 item records** parsed out of 560 upstream definition files (name, slot, level, price, damage, armour, bonus stats) | 67 | 13.51 MB |
| [Dungeon Crawl Stone Soup](https://github.com/crawl/crawl) | code GPL-2.0, tiles **CC0** | **420 vault layouts** lifted out of the 6,127 hand-authored `MAP` grids in the `.des` corpus (normalised to wall/floor/door/stairs, with each vault's depth band and tags), and 100 32×32 dungeon tiles | 103 | 0.56 MB |
| [Battle for Wesnoth](https://github.com/wesnoth/wesnoth) | GPL-2.0-or-later, art CC-BY-SA-4.0 | **22 unit records** read out of its own WML (hit points, movement, cost, alignment, and every attack's damage, number and melee/ranged range), their 96 px sprite sheets and 21 portraits, 14 terrain tiles, 2 music tracks | 61 | 1.87 MB |

Total: 578 files, 21.9 MB — 568 upstream content files, 10 attribution texts and 1 generated bundle — pinned to these upstream commits:

```
cataclysm-dda           4733654d9c619feabc92c8fba029a920899af562
dcss                    cf8c9bca90651c7a226516c2a3cf459b995ab2cf
endless-sky             c3c7908862cb18fef88459fd970c208ca06cba20
flare-game              af6eee6d339ac98011864bfe89da837fe7769c28
shattered-pixel-dungeon 57a4e06a4caf162446d1c28caa7983f0493fecf0
stk-assets              56b611c0fab2a9dabb57ed4a7db05a1fa6330730
unciv                   adc539dc91aa3a1ebd9ffc74fa8c1078210454a3
wesnoth                 7af37dd0658ed70bea5758e35d4875438d3f2c50
```

The exact commit for each source is in `vendor/MANIFEST.json` (authoritative — it is
generated, the list above is a convenience) together with the source path, byte size and
SHA-256 of every single vendored file.

## What that means in practice

- **Playing it**: no obligation on you. Nothing here phones home, and the licences are
  about distribution, not use.
- **Forking the code**: MIT. Delete `vendor/` and all ten browser titles still boot — they
  fall back to authored content on purpose, and `tests/vendor.mjs` guards the wiring.
- **Redistributing the collection**: you are shipping GPL-3.0 and CC-BY-SA-3.0 material,
  so the bundle as a whole has to satisfy those terms. In practice: keep `vendor/*/LICENSE-*`
  and `vendor/*/ATTRIBUTION.md` intact, keep the commit pins, and if you modify a vendored
  file, publish the modification under the same licence. Our MIT code does not become GPL
  by sitting next to it, but you cannot distribute the art under MIT alone.
- **The modifications are reproducible**: every conversion (downscaling, Opus re-encode,
  trim length, table extraction, C:DDA unit normalisation) is in `tools/vendor.py` and can
  be re-run from the pinned upstream commits. That is also how the "source form" obligation
  of the GPL/CC-BY-SA licences is met for the derived files: the script plus the upstream
  commit is the recipe.
- **Attribution in the running games**: each original names its donors on the title screen
  (e.g. "Ships and market data: Endless Sky contributors (GPL-3.0)"). That is the
  attribution requirement being met where a player can actually see it.

## Why not one licence for everything?

Because the alternatives are worse. Relicensing upstream art as MIT would be a lie;
dropping the vendored content to keep the repo uniformly MIT is what this collection
did before, and it made "built on the clones" a claim rather than a fact.

## Stormforge's donors (added 2026-10-30)

**Suroi** (`HasangerGames/suroi`, GPL-3.0) supplies the battle-royale half: gun, armour and
healing definitions parsed from its own TypeScript tables, plus weapon/loot/structure/prop
sprites and its sound effects. Its full licence text ships at `vendor/suroi/LICENSE-*`, and
because Stormforge combines Suroi (GPL-3.0) with Mindustry (GPL-3.0), **the vendored payload for
this title is distributed under GPL-3.0**, not MIT. The repo's MIT licence covers only the code
written for this collection; if you redistribute `dist/` you must honour GPL-3.0 for the vendored
bytes, exactly as the other nine cross-hybrids already require.

**three.js** (`npm three@0.156.1`, MIT) is vendored as `vendor/three/three.min.js` so the game
renders WebGL with no network fetch. MIT text ships beside it, and `vendor/three/version.json`
records the tarball hash the build came from.
