# Stormforge — build spec

A Fortnite-shaped battle royale for phones, with Fortnite's instant-build replaced by a
factory you actually run. **Third-person 3D**: WebGL via a vendored three.js r156 UMD build,
portrait, classic scripts only, works from `file://` with no bundler and no network.

Lane: `hybrid`. Donors: **Suroi** (battle-royale loop, real ballistics, loot tiers, storm,
weapon/structure/sound art) × **Mindustry** (drills, conveyors, fabricators, turrets).
Opt-in recorded in `docs/SCOPE-GATE.md` decision 11.

## Files

| file | owner | contract |
|---|---|---|
| `js/world.js` | world module | `window.SF_WORLD.make(seed, opts)` → world object (below). No DOM, no canvas, no network. |
| `js/factory.js` | factory module | `window.SF_FACTORY.make(world)` → sim object (below). No DOM, no canvas. |
| `js/render.js` | HUD | 2D canvas overlay: health/shield, weapon card, minimap, drop map, results |
| `js/scene3d.js` | scene | three.js island, buildings, prop instancing, soldiers, bullets, loot, storm, factory blocks |
| `js/main.js` | integrator | game loop, input, audio, bots, combat, phases, test hooks |

Script order in `index.html`: `../../vendor/vendor.js`, `../../vendor/three/three.min.js`,
`../../shell/lib/gamekit.js`, `js/world.js`, `js/factory.js`, `js/combat.js`, `js/render.js`,
`js/scene3d.js`, `js/main.js`. Two canvases: `#game` (WebGL) under `#hud` (2D overlay).

## Conventions the other ten titles use (match them)

- Classic script, IIFE, `var`, no build step, no imports, no fetch. Nothing may touch the
  network at runtime.
- Vendored art lives at `../../vendor/...` on disk but is referenced as `vendor/...` in code.
  Guard every read: a texture that fails to load (browsers block cross-origin images for WebGL
  when the page is opened as a bare `file://`) falls back to flat colour, and the game still plays.
- `window.AOMG_VENDOR.data['suroi/guns']` etc. hold the parsed donor tables.
- `window.GK` (gamekit) provides `GK.fit(canvas)`, `GK.boot({update, draw})`, `GK.store(ns)`,
  `GK.buzz(ms)`. Read `shell/lib/gamekit.js` before using it.
- Target 60 fps on a mid phone. Pool everything per frame: no allocation inside hot loops,
  no `ctx.shadowBlur` per sprite, no per-frame `createLinearGradient` in the tens.

## Vendored content available

Suroi (`vendor/suroi/…`):

- `guns/<id>.png` — 117 loot sprites (tier cards, ground loot, HUD)
- `guns/<id>_world.png` — 72 in-hand sprites (rotate to aim)
- `guns.json` — 69 guns, real numbers: `damage`, `fire_delay` (ms), `reload` (s), `spread`,
  `move_spread`, `recoil`, `capacity`, `ammo`, `bullet_speed`, `range`, `tier` (D→S).
  Tiers: S 17, A 19, B 12, C 16, D 5.
- `gear.json` — 10 armour pieces (helmet/vest, `level`, `reduction`) and 5 healing items
  (`restore`, `use_time`)
- `loot/*.png` — 51 loot icons (armour, scopes, packs, meds, ammo)
- `buildings/<poi>/…` — 83 structure sprites over 9 POIs: `blue_house, barn, warehouse,
  container, construction_site, armory, mansion, lodge, cabin` (floors, walls, roofs, stairs)
- `props/<name>/…` — 137 sprites over 91 props: walls, doors, crates, barrels, trees, bushes,
  cars; some have a broken/open state
- `particles/`, `projectiles/`, `player/`, `indicators/`, `airdrop/` — FX art
- `sfx/*.opus` — 320 sounds (per-gun `_fire`/`_reload`/`_switch`, hits, footsteps, heals,
  pickups, shields, explosions, doors)
- `audio/menu_music.opus` — 75 s drop-screen loop

Mindustry (`vendor/mindustry/…`): item icons (`items/*.png`), conveyor frames, and
`assets.json` → `blocks[]` with `{category, name, sprites[]}` for drills, conveyors,
junctions/routers/sorters, nine turrets, six walls, production blocks and power.

## world.js contract

```js
var world = SF_WORLD.make(seed /* int */, {
  size: 3000,      // world is size x size px, square
  cell: 16,        // build/logic grid cell in px (world px / cell = grid dim)
  pois: 9,         // structures to place
  ore: 90,         // ore patches
  props: 420       // scatter props
});
```

Returns (all fields stable for the whole run):

```js
{
  seed, size, cell, grid,            // grid = size / cell
  rng,                               // seeded, returns [0,1); never Math.random
  tiles: Uint8Array(grid*grid),       // 0 grass, 1 dirt, 2 sand, 3 water, 4 road, 5 rock
  tileAt(wx, wy), walkable(wx, wy),
  pois: [{id, kind, cx, cy, x, y, w, h, ang, art:{floor[],wall[],roof[]}}],
  ore:  [{gx, gy, x, y, type:'copper'|'titanium'|'coal', amount}],
  props: [{x, y, r, sprite, kind, solid, destructible, hp}],
  propAt(wx, wy),                    // prop whose circle contains the point, else null
  spawnPoints(n),                    // n spread points, all walkable, not inside a solid prop
  bus: {a:{x,y}, b:{x,y}},           // drop line across the map
  storm: [{wait, shrink, cx, cy, r}], // 6 phases; phase 0 is the full map
  stormAt(t),                        // t seconds since the drop → {cx, cy, r, phase, closed}
}
```

Rules: same seed → identical world (no `Math.random`, no `Date`); the map must read as a
place (forest belts, roads between POIs, water in a corner, no structure overlapping
another, spawn points reachable); every POI sits on flat walkable ground with a clear apron.

## factory.js contract

```js
var sim = SF_FACTORY.make(world);
```

```js
{
  cell, grid,
  blocks: Map /* "gx,gy" -> {kind, gx, gy, dir, hp, ...} */,
  ore: Map /* "gx,gy" -> {type, amount} */,
  stock: {copper, titanium, coal, ammo, plates},
  canPlace(kind, gx, gy, dir),       // {ok, reason, cost:{copper,titanium}}
  place(kind, gx, gy, dir),          // spends ore from `stock`; returns {ok, reason}
  remove(gx, gy),                    // refunds half
  mineAdjacent(gx, gy, amount),      // player hand-mining into stock
  tick(dt, ctx),                     // ctx: {enemies:[{id,x,y,hp,isPlayer}], onTurretHit(enemy, dmg), time}
  turrets(),                         // live turret list with cooldown/ammo for HUD
  state()                            // {blocks, oreMined, itemsMoved, ammo, plates, turrets, firing}
}
```

Kinds and costs (copper / titanium): `drill` 15/0, `conveyor` 3/0, `fabricator` 20/5,
`turret` 25/10, `wall` 8/0. Rules: a drill must touch ore and mine it into `stock`; a
conveyor carries items one cell along its `dir` each tick into the next block; a fabricator
turns 2 copper → 1 ammo and 2 titanium → 1 plate; turrets spend 1 ammo per shot at enemies
inside range and call `onTurretHit`; walls have hp and block movement (`world` asks
`sim.solidAt(gx,gy)`). Everything is deterministic under a fixed dt sequence.

## main.js — what "done" means

1. **Drop**: title card over the map, music, `TAP TO DROP`, tap anywhere → skydive along
   `world.bus`, player falls, camera follows, 31 bots land on their own.
2. **Ground game**: twin-stick movement/aim (virtual sticks, thumb-sized, 48 px+ hit area),
   fire, reload, swap weapon (2 slots), heal, build wheel, minimap with storm ring, storm
   damage ticks, kill feed, elimination counter `28 alive`, damage numbers, hit markers,
   muzzle flash, casings, blood decals, footprint sounds.
3. **Loot**: rarity-coloured beams (grey/green/blue/purple/gold from Suroi tier D/C/B/A/S),
   walk over to pick up, ammo from `ammo_spawn`, armour reduces damage exactly as
   `gear.json` says, heals with `use_time` progress.
4. **Factory**: build wheel (drill / conveyor / fabricator / turret / wall), ghost preview
   with valid/invalid tint, ore mined by hand when standing on a patch, belts that visibly
   move items, fabricator glow, turrets that track and fire with Mindustry sprites, walls
   that take damage and break.
5. **Endgame**: final circle, `VICTORY ROYALE` or `#n / 32`, stats screen (kills, damage,
   ore mined, blocks built), restart.
6. **Test hooks**: `window.__game = { state(), act(name, arg), boot(seed) }`.
   `state()` must expose at least: `{phase, alive, hp, shield, ammo, weapon, weaponTier,
   loot:{picked}, storm:{phase,r}, blocks, ore, kills, bots, hero:{x,y}, nearest}`.
   `act()` supports at least: `drop`, `move {dx,dy,ms}`, `fire {ms}`, `reload`, `pickup`,
   `build {kind, gx, gy, dir}`, `heal`, `skipToEndgame`.

## Quality bar

`docs/QUALITY-BAR.md` at 8.5+ — the same bar the other ten cleared. Concretely: no rectangle
placeholder where art exists, transitions and hit feedback everywhere, a readable HUD that
never covers the fight, and 60 fps with 32 combatants + a running factory.
