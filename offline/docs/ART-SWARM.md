# ART-SWARM — what the roster actually draws, measured

This file replaced a static audit written on 2026-11-01 that was **wrong** and is worth
reading as a cautionary note, because it cost a rebuild pass before anyone checked it.

The first version of this document claimed eight of eleven titles "draw zero donor bytes"
and read as prototypes. It was produced by grepping the game JS for literal
`vendor/<donor>/...` strings. That grep cannot see the way these titles are actually
written: they resolve their art through the vendor *data* tables, e.g.
`VDATA['endless-sky/ships'][i].image` → `new Image()` → `ctx.drawImage`. No literal path
appears in the source, so the regex reported zero for a title that was already painting
thousands of donor blits per run. Eight work cards were dispatched against that false
premise; all eight were stopped before they wrote anything.

**Measure art in the browser, not in the source.** Two tools, both additive:

```
python3 tools/art-audit.py            # static: which titles NAME a vendor path (and which paths are dead)
node tools/art-runtime.mjs            # runtime: how many donor images each title decodes and blits
node tools/art-runtime.mjs tessera    # one title; writes evidence/art-<id>.png
```

`tools/art-runtime.mjs` installs hooks on `HTMLImageElement.prototype.src`,
`CanvasRenderingContext2D.drawImage`, `createPattern` and WebGL `texImage2D` before the
page's first script, plays every title with its real action script
(`tests/lib/acts.mjs`), and reports donor image loads, load failures and donor blits per
asset. That is the number to trust.

## The measured baseline (2026-11-01, this machine)

| title | donor blits / run | distinct donor assets | verdict |
|---|---|---|---|
| vaultbreak | 32,314 | 15 | tiles the whole floor with SPD `tiles_sewers`, items, avatars |
| siegehaus | 26,209 | 50 | SPD floor + avatars + items + monsters, all donor |
| charterline | 10,800 | 6 | tiled Wesnoth water/leaves/grass/sand across the map |
| tessera | 6,917 | 5 | **added this pass** — Luanti materials inside every hex |
| wardenmarch | 1,530 | 56 | Wesnoth unit strips |
| cinderhold | 1,502 | 163 | Flare frames, portraits, icons, tileset |
| lanternfall | 159 | 13 | Endless Sky hulls (player + enemies + traders) |
| ember-drift | 120 | 13 | Endless Sky hulls, rotated to velocity heading |
| rift-nine | 27 | 3 | SPD creature sheets only — environment is procedural masonry |
| nulltrace | 19 | 1 | one SPD sheet — course is procedural geometry |
| stormforge | 177 | 50 | **fixed this pass** — Luanti grain in the ground texture; Mindustry blocks in 3D |

Only **tessera** was a true zero, and that is now closed: `bakeMap()` tiles a Luanti material
(`water/grass/gravel/stone/sand`) inside each hex, clipped to the hex path, offset
deterministically per tile, then tints 34% back toward the terrain identity so the six types
stay legible. `state().terrainTiles` reports the blit count, so a silent fallback to the old
flat fill cannot pass a colour-count assertion.

`stormforge` was a *measurement* zero, not an art zero: it loads 41–50 donor images and draws
through WebGL, where the canvas-2D hook sees nothing. Its ground was nonetheless a flat
vertex-coloured plane, so `makeGroundTexture()` now composites Luanti `grass/dirt/gravel` into
the neutral multiply map at four frequencies — verified by eye, and by the 177 blits the hook
now sees on the offscreen canvas.

## Rules that survived the correction

1. **Guard every donor path** (`hasAsset(path)` / `vendorTable`) and keep the authored
   fallback. All eleven titles still boot and play with `vendor/` deleted; that is a test,
   not a promise.
2. **Native resolution, anchored, legible.** Donor pixel art gets `pixel: true` and ≥ 24 px
   on a 390×844 frame; painted art keeps smoothing on.
3. **One file per title** (`games/<id>/js/main.js`, `window.__game` intact). Only
   `games/<id>/js/main.js` is precached, so a second JS file is invisible offline.
4. **Never rename or remove a `state()` key** — the offline and browser suites assert on
   them by name. New counters only, and at least one that only a real donor blit increments.
5. **Do not trust a grep for a claim about pixels.** See the top of this file.

## Dead donor paths found and fixed this pass

`grep` for `vendor/...\.(png|opus|...)` against the manifest found two dangling references in
`stormforge`, both now corrected:

- `vendor/mindustry/blocks/distribution-conveyors/conveyor/conveyor.png` (does not exist)
  → `vendor/mindustry/belt/conveyor-0-0.png`
- `vendor/suroi/sfx/pickup_item.opus` (does not exist) → `vendor/suroi/sfx/ammo_pickup.opus`

All eleven titles now name zero nonexistent donor files.

## What is actually worth doing next

Not another blanket "wire the donors" pass. By the measured table the remaining soft spots
are narrow and specific:

- `rift-nine` / `nulltrace` — environment is procedural (custom masonry painter, plain
  course plating). Swapping in SPD 16px tilesets was considered and deferred: the games tint
  donor pixel art toward a neon palette on purpose, and the masonry is already bespoke art.
  If it happens, it should be judged frame by frame, not asserted.
- `ember-drift` / `lanternfall` — the hulls are wired but the backdrop is an empty starfield;
  that, not the art plumbing, is what reads as prototype in a screenshot.
- `stormforge` — the player and bot bodies are still built from boxes. Donor textures on
  trees were tried and reverted: at gameplay distance a 16 px bark tile on a 6 px trunk is
  invisible, so the change could not be verified by eye and did not ship.
