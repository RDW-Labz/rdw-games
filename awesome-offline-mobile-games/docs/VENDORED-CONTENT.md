# Vendored content contract

The four originals and the six cross-hybrids are built on real content taken out of the cloned upstream repos:
ship hulls and market tables from Endless Sky, a pixel bestiary and sound set from
Shattered Pixel Dungeon, the Civ V technology tree from Unciv, item/monster/recipe
tables from Cataclysm: DDA, and music/sfx from SuperTuxKart.

Two of those repos exist only for the hybrids: **Mindustry** supplies the 30 item icons plus the
conveyor, drill and turret sprites that Siegehaus draws over its dungeon floor, and **Luanti**
supplies the node material textures Charterline tiles inside its hexes. Both are art-only pulls —
no Mindustry code, no Luanti code, and no Quake pak (none exists in the source tree), which is why
Lanternfall's arena cadence is authored rather than imported.

`tools/vendor.py sync` regenerates everything under `vendor/`; `--check` (run by
`npm test`) verifies all 578 files byte-for-byte against `vendor/MANIFEST.json`.
**Never hand-edit anything under `vendor/`.** Change the importer and re-sync instead.

## Loading it

Every game page loads one classic script before its own `main.js`:

```html
<script src="../../vendor/vendor.js"></script>
<script src="../../shell/lib/gamekit.js"></script>
<script src="js/main.js"></script>
```

That gives you `window.AOMG_VENDOR = { sources, assets, data }` and nothing else —
no fetch, no modules, works from `file://` with the network off.

```js
var V = window.AOMG_VENDOR;
var ships = V.data['endless-sky/ships'];          // 120 hulls
```

Always guard the load (`var V = window.AOMG_VENDOR || { data: {}, assets: [] }`) and
keep the authored fallback in place. A game must still boot if the bundle is missing.

## Asset paths

Paths in `assets` and in every table are **repo-root relative** (`vendor/endless-sky/...`).
A game page lives two directories down, so prefix them once:

```js
function assetUrl(p) { return '../../' + p; }   // 'vendor/endless-sky/ships/x.png'
```

## Tables

| key | count | shape |
|---|---|---|
| `endless-sky/ships` | 120 | `{name, sprite, category, cost, shields, hull, mass, drag, thrust, turn, fuel, cargo, crew, bunks, shield_damage, hull_damage, image}` |
| `endless-sky/commodities` | 10 | `{name, price, capacity}` — Food, Clothing, Metal, Plastic, Equipment, Medical, Industrial, Electronics, Heavy Metals, Luxury Goods |
| `shattered-pixel-dungeon/assets` | 78 sprites / 3 terrain atlases / 67 sfx / 2 tracks | `{sprites:[{name,image}], terrain:[{name,image}], sounds:[{name,audio}], music:[{name,audio}]}` |
| `unciv/techs` | 74 | `{name, column, row, era, cost, building_cost, quote, uniques}` — 18 columns = prerequisite chain |
| `unciv/buildings` | 100 | `{name, cost, maintenance, requiredTech, uniqueTo, uniques}` |
| `unciv/units` | 100 | `{name, cost, strength, rangedStrength, movement, requiredTech, unitType}` |
| `unciv/nations` | 24 | `{name, leaderName}` |
| `cataclysm-dda/items` | 180 | `{id, name, category, price_usd, weight_g, volume_ml, symbol, color, description}` |
| `cataclysm-dda/monsters` | 60 | `{id, name, hp, speed, melee_dice, melee_dice_sides, symbol}` |
| `cataclysm-dda/recipes` | 60 | `{result, components:[{any_of, count}], skill_used}` |
| `stk-assets/audio` | 2 tracks / 7 sfx | `{music:[{name,audio}], sounds:[{name,audio}]}` |
| `flare-game/assets` | 36 monsters / 4 tilesets / 12 portraits / 6 ui / 4 icons / 3 music / **140 items** | `{monsters:[{name,image,w,h}], tilesets:[...], portraits:[...], ui:[...], icons:[...], music:[{name,audio}], items:[{name, source_mod, slot, level, price, damage:{kind,min,max}, armour, bonus:{defense,mp,...}}]}` |
| `dcss/vaults` | **420 vaults** (from 6,127 `MAP` grids in 144 `.des` files) | `{vaults:[{id, depth, tags:[], weight, w, h, grid:['....##', ...]}]}` — grid chars are normalised: `#` wall, `.` floor, `+` door, `>` stairs down, `' '` void |
| `dcss/tiles` | 100 tiles (32×32) | `{items:[{name,image}], monsters:[{name,image}]}` |
| `wesnoth/assets` | 22 units / 14 terrain / 21 portraits / 2 tracks | `{units:[{id, name, race, level, hp, movement, cost, alignment, attacks:[{name,type,range,damage,number}], image, portrait}], terrain:[{name,image}], music:[{name,audio}]}` |

### Reading the two data donors properly

**DCSS vaults are the interesting half of `dcss`.** The corpus ships `.des` files in which a vault
is a `MAP` block of ASCII — one character per cell — where each letter means whatever that file's
`SUBST`/`KFEAT` lines say. `tools/vendor.py` keeps only the four structural classes (`#`, `.`, `+`,
`>`) and normalises everything else to floor, because the deliverable is a room's *shape*; the
placed content (monsters, altars, shops) is the game's job to supply. Each vault keeps its depth
band string (`D:4-8`, `!Spider:1`, …), its tags and its source file, so a game can pick by depth.

**Flare's items are INI, not JSON.** A record is a `[item]` block with repeated keys —
`loot_animation` appears three times, `INCLUDE` chains a category item to a base definition in
another mod. `_ini_blocks()` in `tools/vendor.py` keeps repeated keys as lists and resolves
`INCLUDE` against the whole mod load order (empyrean_campaign items include fantasycore base
definitions, which is where the armour numbers live). A plain dict parse silently drops both.

**Wesnoth's units are WML.** Each `data/core/units/**/*.cfg` carries `hp`, `movement`, `cost`,
`alignment`, `race`, and one `[attack]` block per weapon with `damage`, `number`, `range`
(`melee`/`ranged`) and `type`. Those are the numbers the tactics hybrid fights by.

## Sprites

The Shattered Pixel Dungeon PNGs are **horizontal sprite sheets**: frame size is the
image height, frame count is `width / height`. They are 16/32/64/128 px pixel art —
draw them with `imageSmoothingEnabled = false` at integer scales, or they turn to mush.

Endless Sky ship sprites are single top-down images, downscaled to ≤192 px, with alpha.

Flare's monster PNGs are **packed animation atlases**, not single figures: `antlion.png` is
152×256 and its alpha runs unbroken from top to bottom, because Flare's own `animations/*.txt`
definitions carry the frame rectangles and the atlas ships without gutters between frames. Those
definitions are not vendored, so a frame cannot be recovered by slicing on a grid — treat the
sheets as palette and texture sources, or vendor the animation text first if a game needs the
frames themselves. Wesnoth unit PNGs *are* sheets (6 frames of attack/defend per row) at 96 px cells;
if a game animates them it must walk the grid rather than squash the sheet into one rect.

## Audio

Everything is Opus. On `file://` you cannot `fetch()` the file to decode it, so use
`new Audio(url)` (or an `<audio loop>` element) and unlock on the first user gesture.
Do not add audio that has to be decoded through `fetch`/`XMLHttpRequest`.

## What the games must keep

- The `window.__game` debug surface each game already exposes — `tests/browser.mjs`,
  `tests/touch.mjs` and `tests/longrun.mjs` are written against it.
- Classic scripts only, no `<script type="module">`, no `fetch`/XHR, no external URLs.
- An in-game credit line naming the upstream source and licence (title screen or pause
  menu is fine): e.g. "Ships and market data: Endless Sky contributors, GPL-3.0".

## Proof it is really loaded

Two independent checks, because "the game mentions AOMG_VENDOR" is not evidence:

- `tests/vendor.mjs` (static, 80 invariants) — every file in `MANIFEST.json` is present with the
  recorded size and SHA-256, every table is non-empty and shaped as documented, and each original
  must *consume* payload: a literal `vendor/…png|opus` path, the asset list, or a data key that
  exists in the bundle. Mentioning the global is not enough.
- `tests/browser.mjs` (runtime) — counts `Network.responseReceived` for `/vendor/` while the page
  loads and plays, so a screenshot claim is backed by the network stack. Last run:

  | game | PNGs fetched | audio fetched | painted on the canvas | bundle |
  |---|---|---|---|---|
  | Vaultbreak | 14 | 17 | `tiles_sewers.png` (every floor and wall cell), `items.png`, `rat.png` | 1 |
  | Ember Drift | 13 | 0 | `escape_shuttle.png` (the player's hull) | 1 |
  | Rift Nine | 2–3 | 28 | `crystal_wisp.png`, `eye.png`, and `golem.png` on plates that fit one | 1 |
  | Tessera | 0 (data-only: 74 techs) | 0 | — (nothing to paint) | 1 |

  Fetched is not the same as used, so the harness hooks `CanvasRenderingContext2D.drawImage`
  before any page script runs and counts which vendored files actually reach the canvas. Two
  failures it now catches that a fetch counter alone would miss: art that downloads and is never
  drawn, and Vaultbreak's bestiary specifically — its scripted run walks up to a monster, and the
  run fails unless a real creature sheet (anything but the loot atlas) gets painted.

There is also a control run with the whole payload refused at the network layer
(`Network.setBlockedURLs('*vendor*')`): Vaultbreak must still boot, render and take input on its
authored vector fallback — measured at 92 distinct canvas colours with nothing vendored. That is
the check that keeps "the art is optional" honest.

A game that loads the bundle but fetches no vendored sprite fails the run, and so does one whose
art never reaches the canvas. `file://` is covered twice over: `tests/browser.mjs` runs all four
originals off plain files with no server, and `tests/offline.mjs` cuts the network at the CDP level
and plays every original out of the service-worker cache.

## Licences

Our code is MIT; vendored files keep their upstream licences (GPL-3.0, GPL-2.0+,
MPL-2.0, CC-BY-SA-3.0). See `docs/LICENSING.md` — it matters if you redistribute.
