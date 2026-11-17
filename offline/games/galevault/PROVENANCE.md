# Galevault — provenance

Twelfth title, lane `hybrid`, asked for by Michael on 2026-11-01 ("I want one brand new one,
blow me away full 3d and awesome hybrid"). Recorded as decision 13 in `docs/SCOPE-GATE.md`.

**No new donor enters the collection for this title.** Everything it borrows was already
vendored, licensed and pinned under earlier decisions; this is a new use of old payload.

## Donors

| Donor | Upstream | Licence | Pinned at | What was taken |
|---|---|---|---|---|
| Endless Sky | https://github.com/endless-sky/endless-sky | GPL-3.0 | `vendor/MANIFEST.json` → `sources.endless-sky.commit` | The ship table only: 120 hulls with name, class, mass, drag and hull points. The game derives thrust, top speed, turn rate, climb rate and hit points from those numbers (`WV.deriveFlight`), so each hull flies like the ship it is — a Sprout is a paper dart, a Windjammer is a barge. No Endless Sky code, art, saves or galaxy data are used. |
| Luanti | https://github.com/luanti-org/luanti | LGPL-2.1-or-later and CC-BY-SA-3.0 | `sources.luanti.commit` | Four 16 px node textures — `stone.png`, `grass.png`, `gravel.png`, `water.png` — tiled over the heightfield, the grass cap, the scree and the river. The shoreline is a vertex-coloured sand band, not a tiled texture. `window.__game.state().donorTextures` names the four the live scene is carrying. |
| three.js | https://www.npmjs.com/package/three | MIT | `npm three@0.156.1`, tarball hash in `sources.three.commit` | The WebGL renderer (r156 UMD build, the last that loads from `file://` without a bundler). |

Every vendored file is listed byte-for-byte with a sha256 in `vendor/MANIFEST.json` and
re-verified by `tests/vendor.mjs` and `tools/ports-provenance.py --check`.

## What was authored here (MIT)

The gorge generator (`js/world.js`: harmonic loop path, Gaussian carve, heightfield, gate
placement, flight physics, collision, pirates, scoring), the 3D scene assembly
(`js/scene3d.js`: terrain mesh with strata-tinted vertex colours, instanced scrub, cloud
sprites, gate rings, the glider model, the chase camera) and the game and HUD (`js/main.js`).
No upstream code was copied: Endless Sky's table is read as data, Luanti's textures are used
as art, and the simulation is written from scratch.

## What was deliberately not taken

- No Endless Sky engine code, mission data, galaxy map, ship sprites or audio.
- No Luanti engine, mods, sounds or world formats — five textures and their attribution text.
- No other game's tracks, gates or course design; the racing line is generated per seed.
