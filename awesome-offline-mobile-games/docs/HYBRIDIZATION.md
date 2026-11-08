# Hybridization — what was reused, from where, and why

This collection takes a source repo full of open-source game clones and turns it into eleven
playable titles. "Hybridization" here means a specific, auditable thing: **for each original,
name the upstream titles it draws on, say exactly what was taken — mechanics *and* the actual
bytes — and say what was deliberately not taken.** Nothing is absorbed silently.

The raw audit of the source repo is `docs/INVENTORY.md`. Scope rules are `docs/SCOPE-GATE.md`
(standing decision #7 records the opt-in that made real upstream content shippable). The
mechanics of the import are in `docs/VENDORED-CONTENT.md`, per-file provenance in
`vendor/MANIFEST.json`, licensing in `docs/LICENSING.md`.

## The two lanes

| Lane | What it means | Titles |
|---|---|---|
| **port** | An upstream open-source game, built from a pinned commit. Reused as-is. Engine, assets and licence stay upstream's; the 18 GB tree is not vendored. | Mindustry, Shattered Pixel Dungeon, Luanti, Endless Sky, DarkPlaces, DDNet |
| **forge** | An original title written for this repo: its own renderer, rules and content design, running on real upstream sprites, audio and game-data tables. MIT code. | Vaultbreak, Tessera, Ember Drift, Rift Nine |

Each `ports/<id>/PROVENANCE.md` records upstream URL, pinned commit, licence, artifact size and
SHA-256, and the build commands that were actually run.

## The four originals run on real upstream payload

578 files / 21.9 MB under `vendor/`, produced by `tools/vendor.py` from ten pinned commits
(Endless Sky, Shattered Pixel Dungeon, Unciv, Cataclysm: DDA, SuperTuxKart assets), verified
file-by-file by size and SHA-256 in `tests/vendor.mjs`. Every game still declares its own art
and audio fallback, and every game boots and plays when the bundle is deleted — tested, including
a control run where `window.AOMG_VENDOR` is neutered.

### Vaultbreak — roguelike

|Taken from|What was taken|What was not taken|
|---|---|---|
|Shattered Pixel Dungeon|11 animated creature sheets driven as the whole bestiary — rat, bat, snake, gnoll, eye, ghoul, brute, golem, ghost, elemental, and `vault_boss_elemental` as the VAULT WARDEN — plus the 16×16 item atlas for loot icons and `amulet.png` for artifacts, and the three region **terrain atlases** (sewers/prison/caves) as the dungeon floor and masonry — cell indices taken from SPD's own `DungeonTileSheet.java`, not guessed. 12 sound effects (hit_slash, hit_strong, hit_crush, hit_magic, miss, zap, item, gold, descend, levelup, death, boss) and two music loops (`vault.opus` in the dungeon, `tense.opus` from sector 6).|Its turn engine, class system, item behaviour, level generator. No Java code copied.|
|Cataclysm: DDA|169 items as the loot table with their real names, prices, weights and descriptions shown verbatim in the tooltip and log; 11 monsters used as the **stat anchors** for the bestiary (e.g. `mon_zombear` → the brute, `mon_big_rat` → the rat) through a documented hp/atk/dice conversion; 4 real recipes in the fabricator (bandages from cotton patchwork + medical tape ×5 + disinfectant; recharge station from frame + recharge station; pillow from cotton patchwork + cotton ball; napalm from diesel ×125 + plastic chunk + bleach + oxidizer powder).|Its C++ engine, its mapgen, its huge item matrix.|
|Mindustry|Scrap → craft → upgrade still shapes the mid-run power curve: loot is a material, and the fabricator is where power comes from.|Its conveyor/defence sim, engine, assets.|

Turn economy is SPD's: the world advances one tick per player action. Canvas 2D, procedural BSP
floors, shadowcast field of view, tap-to-path movement.

### Tessera — hex 4X

|Taken from|What was taken|What was not taken|
|---|---|---|
|Unciv|The **actual Civ V technology tree**: 74 technologies across 18 columns, 7 eras, with their real costs, prerun quotes and building costs. 31 units and 50 buildings (81 buildables) gated on it, and 23 nations with leader names for the title/pause/game-over lines.|Its Java/LibGDX engine, its map generator, and its tilesets: every Unciv tilesheet (HexaRealm, FantasyHex, Minimal) is flat-top 64×56, while Tessera's map is pointy-top, so blitting them would need a 90° rotation that turns a mountain peak sideways. Tessera keeps its own drawn hexes rather than ship art that reads wrong.|
|OpenTTD|Road-and-trade logistics: roads cut movement cost and generate trade income between connected cities.|Its transport sim, its sprite sets.|

Shipped rule: a tech opens when any tech of the previous column is known — measured, the stricter
"previous column, lower-or-equal row" rule only reached 12 of 74 techs. Costs scale 0.10×, units
0.30×, buildings 0.32× so a 74-tech tree still finishes inside an 80-turn game.

### Ember Drift — space trading and combat

|Taken from|What was taken|What was not taken|
|---|---|---|
|Endless Sky|13 ship sprites (downscaled, loaded from `vendor/`) for 6 buyable hulls, 3 pirate classes and two kinds of ambient traffic; the hull table itself — 120 hulls with real cost/hull/shield/mass/cargo — converted to game stats by a documented mapping; the 10 ES commodities with their real base prices driving the market.|Its engine, its data-file interpreter, its 120-hull full data set (13 preloaded).|
|DarkPlaces / Quake|The arena-shooter cadence: screen shake, hit flashes, projectile speed that reads at a glance.|Its engine, maps, shareware data.|

Stat mapping, in code: hull 100·√(ES hull/600), shield 60·√(ES shields/300), accel from ES mass,
turn from ES mass, cargo ES cargo ×0.5, price 450 + ES cost/2000 with 40% trade-in. Enemy hull
scales with the player's tier so a warship does not trivialise combat.

### Rift Nine — momentum platformer

|Taken from|What was taken|What was not taken|
|---|---|---|
|SuperTuxKart|Seven sound effects mapped to the moment they belong to (boing = jump, anvil = hard landing, crash = death, clock = coin, break = hook fire, bubblegum_explode = hook release, explosion = boost pad) and `alien_signal.opus` as the looped soundtrack.|Its 3D engine, karts, tracks.|
|Shattered Pixel Dungeon|Animated sprite sheets used as scenery: `crystal_wisp` (32 frames) as drifting wisps, `eye` as a watching eye, `golem` as feet-anchored plates creatures. Palette-graded so they belong in the neon palette instead of reading as pixel noise.|Its gameplay, its UI.|
|DDNet|Speedrun structure: per-room timing, best-time deltas, ghost replays, instant respawn at a checkpoint.|Its netcode (single-player, offline by design).|

Level generation is untouched by the decor pass — creatures are added after all geometry, never
near solids/spikes/saws/lasers/pads/coins, and each room has its own seed, so the generator's
output is byte-identical with or without the bundle. Measured frame time is unchanged (median
16.7 ms, p95 16.7 ms over 301 rAF samples before and after).

## Attribution where a player can see it

Every original names its donors on the title screen, e.g. "Ships and market data: Endless Sky
contributors (GPL-3.0)" and "Item data: Cataclysm: DDA contributors (CC-BY-SA-3.0)". That is the
licence attribution requirement being met in the artifact, not only in a doc.

## Technique reused across all four

`shell/lib/gamekit.js` is the only code common to the originals: device-tier detection,
DPR-capped canvas fitting, a fixed-step loop with clamped dt, namespaced `localStorage` with
export/import, haptics, a synthesised sound kit used as the fallback when the vendored audio is
missing, a thumb-pad builder, and a seeded PRNG. Each game still owns its renderer and rules.

## The cross-hybrid lane

Michael's standing directive (SCOPE-GATE decision 8): *use the clones' assets and back ends to
cross with other ones that mesh well, mix up and collab, then rename.* Four titles do exactly
that. Each is a renamed game in its own folder, built from one clone's engine plus a second
clone's systems and shipped assets — both halves have to carry weight at runtime.

| Title | Engine taken from | Systems crossed in | Assets it draws | Renamed from |
|---|---|---|---|---|
| **Siegehaus** | Vaultbreak (SPD turn economy, permadeath, BSP floors, shadowcast FOV, crafting, boss) | Mindustry's production model — ore veins, drills, conveyors, fabricators, turrets on a per-turn tick | 3 SPD terrain atlases, 11 SPD creature sheets, 169 C:DDA items, 36 Mindustry sprites | `vaultbreak` |
| **Charterline** | Tessera (hex 4X: 74 Unciv techs, 50 buildings, 31 units, 23 nations, one expanding AI) | Endless Sky's commodity market as chartered trade routes between your cities | Unciv's tech/building/unit tables, 10 ES commodities, 6 Luanti node materials | `tessera` |
| **Nulltrace** | Rift Nine (nine grapple rooms, run structure, per-room timing) | id's PM_Friction / PM_Accelerate / PM_AirAccelerate at shipped constants (320 / 6 / 100 / 10 / 30) and DDNet's speedrun framing | 13 ES ship sprites, DarkPlaces-derived weapon feel, stk audio | `rift-nine` |
| **Lanternfall** | Ember Drift (ES 120-hull table, 10 commodities, market, Newtonian flight) | Quake-era arena cadence — 10-frag limit, armour on 25 s, weapon crate on 40 s | 13 ES ship sprites, ES commodity table | `ember-drift` |
| **Cinderhold** | new build (this repo) — isometric actor/ability layer, camera, loot and inventory | DCSS's vault corpus as the level source: every floor is cut from a real `MAP` grid with its depth band and tags | 12 Flare portraits, 6 painted menu panels (9-sliced for every window), Flare's `tooltips.png` and `character.png` HUD frames, 140 Flare item records, Flare monster sheets as a palette source | new — no parent original |
| **Wardenmarch** | new build (this repo) — turn/phase manager, movement BFS, attack resolution | Wesnoth's own unit rules (hp, movement, cost, alignment, per-attack damage/number/range) played on DCSS arena geometry | 22 Wesnoth unit records with sprites and portraits, 14 terrain tiles | new — no parent original |

What each cross actually costs and buys:

- **Siegehaus** is the strictest of the four: Mindustry contributes *art only*. The belt, drill,
  fabricator and turret logic is written from scratch in `games/siegehaus/js/main.js`, because
  shipping Mindustry's simulation would make the "backend × backend" claim false. The mesh is
  temporal — the SPD turn you spend is also the tick your line runs on, so fighting and building
  compete for the same resource.
- **Charterline** keeps Tessera's whole tech tree and gives the map an economy that isn't a flat
  bonus: each city exports one good cheap and imports another dear, chosen deterministically from
  its id and re-drifted every turn, so route income is the live spread between two specific
  cities. Luanti materials texture the terrain because a material swatch has no implied camera
  angle — which is precisely why Unciv's flat-top tilesets are still not used (decision above).
- **Nulltrace** replaces Rift Nine's "accelerate toward a cap" model with Quake's friction-then-
  accelerate model, so speed is only ever bled by friction and a fast line stays fast. The
  vertical arc stays Rift Nine's: the nine rooms were built around that jump height, and changing
  it would invalidate the course rather than improve it. DDNet contributes the framing — an
  unpausable run clock, splits, a bronze/silver/gold ladder against Rift Nine's existing par
  table, and a ghost of the best run.
- **Lanternfall** puts Ember Drift's hulls and market inside an arena: the frag limit ends a
  round, the item timers decide who holds armour, and the credits the round pays buy the next
  hull. The Quake contribution is cadence, not physics — no shareware pak exists anywhere in the
  clone tree, so nothing was imported from Quake itself.

The two 2026-10-30 hybrids cross the *data*, not just the pictures, and that is what makes them
different from a reskin:

- **Cinderhold** takes DCSS's hand-authored geometry as its level format. A floor is not a
  procedural blob: it is one vault chosen from the corpus by depth, so its shape has authored
  intent (a corridor, a ring, a hall with pillars) and it arrives with the vault's own tags and
  depth band. Flare supplies what fills it — 140 item records whose damage ranges, armour values and bonus stats are Flare's own numbers, so a
  found dagger's damage is an upstream value rather than a balance guess.
- **Wardenmarch** takes Wesnoth's rule set as its combat model. Hit points, movement allowance,
  recruit cost, alignment and every attack's damage/number/range come out of Wesnoth's WML, and
  the game resolves them as written — melee attacks cannot reach two tiles, a 5-move unit has 5
  move points. The arena is the DCSS half: the fight happens over a vault's actual floor plan,
  where doors and pillars decide line of sight instead of an open board.

Neither of them presents as a port: no upstream engine runs inside either page. What is borrowed
is geometry, rules and art, all vendored and attributed; the code that turns it into a game is
written here.

## Dependency policy

Zero npm packages, no CDN, no web fonts, no analytics, no runtime network of any kind — the
vendored payload is a local file set, loaded by a classic `<script>` so it works from `file://`.
Bookkeeping still stops the build if `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or a
remote URL appears in shipped game code; `tests/offline.mjs` additionally cuts the network at the
DevTools protocol level and requires a game to boot and play.

## What the originals are NOT

- They are not forks of the upstream games. No upstream source file was copied; the reuse is
  content (art, audio, data tables) plus mechanics.
- They are not asset rips passed off as original art. Each vendored file is pinned to a commit,
  listed with its SHA-256, licensed, and credited in-game — and the four games still fall back to
  authored shapes and synthesised sound when the bundle is absent.
- They are not "inspired by" in the loose sense: each one names its parents above and the specific
  thing taken from each — now down to individual sprite sheets, sound files and data rows.

## Stormforge (eleventh title, `hybrid`)

| | |
|---|---|
| **Systems from** | Suroi — battle-royale loop, tiered loot, armour mitigation, storm timing, and 69 guns whose damage/spread/fire-delay/reload/range come out of its own definition files |
| **Systems and art from** | Mindustry — drills, belts, fabricators, turrets and walls, as the replacement for Fortnite's instant build |
| **Taken** | Suroi: gun/armour/healing tables, 117 loot + 72 in-hand gun sprites, 83 structure sprites over nine POIs, 137 prop sprites, 320 SFX, menu music. Mindustry: item icons and block art for 38 blocks. three.js r156 as the renderer (MIT). |
| **Not taken** | No Suroi engine, server, netcode or map data. No Mindustry source or tech tree. No Fortnite asset, name or sound. |
| **Why a hybrid** | The build in a battle royale is usually free cover on demand. Here it is a supply chain: you mine ore, route belts, smelt ammo and let turrets hold ground you cannot hold yourself — a factory economy in a shooter's time budget. |
