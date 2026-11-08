# Stormforge — provenance

Eleventh title, lane `hybrid`, opted in by Michael on 2026-10-30 ("lets make one new bad ass one,
look for aaa clones to do it, fortnight style with throwing some sweet hybrids in there").
Recorded as decision 11 in `docs/SCOPE-GATE.md`; the engine dependency is decision 12.

## Donors

| Donor | Upstream | Licence | Pinned at | What was taken |
|---|---|---|---|---|
| Suroi | https://github.com/HasangerGames/suroi | GPL-3.0 | see `vendor/MANIFEST.json` → `sources.suroi.commit` | 69 gun definitions parsed straight out of `common/src/definitions/items/guns.ts` (damage, fire delay, reload, spread, move spread, recoil, capacity, bullet speed, range, tier), 10 armour pieces and 5 healing items from `armors.ts` / `healingItems.ts`, 117 loot sprites + 72 in-hand gun sprites, 83 structure sprites over nine POIs, 137 prop sprites, loot icons, 320 sound effects and 75 s of menu music |
| Mindustry | https://github.com/Anuken/Mindustry | GPL-3.0 | see `sources.mindustry.commit` | Item icons and the block art for drills, conveyors, junctions/routers, nine turrets, six walls, production blocks and power |
| three.js | https://www.npmjs.com/package/three | MIT | `npm three@0.156.1`, tarball hash in `sources.three.commit` | The WebGL renderer (r156 UMD build, the last one that loads from `file://` without a bundler) |

Every file is listed byte-for-byte with a sha256 in `vendor/MANIFEST.json`; `node tests/vendor.mjs`
re-verifies all 1,497 vendored files.

## What was authored here (MIT)

The island generator (`js/world.js`), the build economy (`js/factory.js`), the combat and bot
layer (`js/combat.js`), the 3D scene assembly (`js/scene3d.js`), the game itself (`js/main.js`) and
the HUD (`js/render.js`). Upstream code was not copied: Suroi's tables were parsed as data, its
art is used as art, and the simulation is written from scratch.

## What was deliberately not taken

- No Suroi engine code, server, netcode, map files or battle-pass content.
- No Mindustry source, campaign, tech tree or sprite logic beyond the block art.
- No Fortnite assets, names or audio; "battle royale" is used as a genre description only.
