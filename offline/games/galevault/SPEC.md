# Galevault — build spec

A canyon time-trial in the air: a glider, a flooded gorge, twenty gates and three pirates who
want you dead before the last one. **Full 3D**: WebGL via the vendored three.js r156 UMD build,
portrait, classic scripts only, works from `file://` with no bundler and no network.

Lane: `hybrid`. Donors: **Endless Sky** (the 120-hull ship table, used as flight envelopes) ×
**Luanti** (five node textures) × **three.js** (renderer). Opt-in recorded in
`docs/SCOPE-GATE.md` decision 13. No new donor payload enters the collection.

## The loop

1. Pick a hull on the title screen. Each hull's mass, drag and hull points come from the
   Endless Sky table; the game derives thrust, top speed, turn rate and climb from them.
2. Fly. Left thumb steers and climbs, right thumb holds boost. Boost is a meter that recharges,
   and every gate you pass tops it up — so the fastest line is the one that keeps threading gates.
3. Twenty gates are laid along a generated racing line down the gorge. Passing the next gate
   rings it out and lights the one after.
4. Three pirates shadow you, firing bolts. Rock, water and bolts all cost hull. Hull zero ends
   the run where it is; the clock is the score, and the best time per hull is stored locally.

## Files

| file | owner | contract |
|---|---|---|
| `js/world.js` | world + physics | `window.GV` — `buildWorld(seed)`, `newRun(world, craft)`, `step(run, dt, input)`, `groundAt(world, x, z)`, `pathAhead(world, x, z, ahead)`, `score(run)`. No DOM, no canvas, no network. |
| `js/scene3d.js` | scene | `window.GV3D` — `create(canvas, world, run)`, `sync(run, dt)`, `render()`, `resize(view, w, h)`, `pick(cols, rows)`, `info()`, `dbg()`. Owns three.js. |
| `js/main.js` | integrator | game loop, input (touch, mouse, keyboard), HUD, phases, storage, test hooks. |

Script order in `index.html`: `../../vendor/vendor.js`, `../../vendor/three/three.min.js`,
`../../shell/lib/gamekit.js`, `js/world.js`, `js/scene3d.js`, `js/main.js`.
Two canvases: `#game` (WebGL) under `#hud` (2D overlay, **transparent**).

## Conventions this collection uses (match them)

- Classic script, IIFE, `'use strict'`, `var`, no build step, no imports, no fetch at runtime.
- Vendored art lives at `../../vendor/...` on disk but is referenced as `vendor/...` in code.
  Every texture read is guarded: if the probe fails (a bare `file://` page can block the
  WebGL upload), the scene is rebuilt in flat colour and the game still plays.
- The HUD canvas must be created with `{alpha: true}`. `GK.boot` asks for `{alpha:false}` and
  would paint an opaque sheet over the WebGL canvas — this title runs its own rAF loop instead.
- Lights belong to `buildScene()`, not `create()`: `clearScene()` drops every child but the
  camera, and lights made outside the build vanish on the textured rebuild.
- Target 60 fps on a mid phone. One draw call for vegetation (InstancedMesh), sprites for
  clouds, no per-frame allocation in the sim.

## Test hooks

`window.__game.state()` returns the run (phase, gates, hull, boost, speed, alt, score, renderer
counters). `window.__game.act(name, arg)` drives it:

| act | effect |
|---|---|
| `newGame` / `start` | start a run on the selected hull |
| `select {index}` | pick a hull on the title screen |
| `steer {x, y}` | set steer / climb, −1..1 |
| `boost {on}` | hold or release boost |
| `fly {n}` | run `n` fixed 1/60 s steps on the autopilot (path-following, gate-seeking) |
| `tick {n}` | run `n` fixed steps with whatever input is set |
| `hit {dmg}` | apply damage, for the wreck path |
| `redraw` | paint one full frame now (3D + HUD) — the rAF loop paints on its own schedule |
| `toTitle` | back to the title screen |
| `pick {cols, rows}` | raycast the WebGL scene through a grid, for coverage checks |

The autopilot follows the generated racing line a lookahead ahead, then tracks the gate itself
inside 120 units; it threads all twenty gates in ~26 s with no damage, which is what the browser
suite asserts.
