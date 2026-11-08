# Putt Drop level format

Levels are JSON files (`levels/holeNN.json`) describing one hole each.

## Coordinate system

Portrait playfield **360×640** world units. Origin at **top-left**, **y increases downward**.

## Required fields

| Field | Type | Notes |
|-------|------|--------|
| `id` | string | Unique id, e.g. `hole01` |
| `name` | string | Display name |
| `par` | number | Integer **2–5** |
| `tee` | `[x, y]` | Ball start position |
| `cup` | `[x, y]` | Hole center |
| `walls` | array | At least one wall; see below |

## Walls

```json
{ "points": [[x,y], ...], "closed": true }
```

- Polylines: consecutive points form segments. If `closed` is true, the last point connects back to the first.
- Ball reflects off segments with restitution **0.8**.
- At least one **closed** wall with **≥ 3** points defines the outer boundary. `tee` and `cup` must lie inside it.

## Optional hazards and objects

### `bumpers` (circles)

```json
{ "x": 180, "y": 340, "r": 18 }
```

Restitution **1.15** (“pop”).

### `sand` (polygons)

```json
{ "poly": [[x,y], [x,y], [x,y], ...] }
```

Rolling friction **×4** while the ball center is inside. Polygons need **≥ 3** points.
The free course uses sand on **at most four holes**, covering **at most 20%** of
any hole's outer silhouette. The checker sums polygon areas conservatively
(overlaps count twice); use compact approach patches rather than full fairways.

### `water` (polygons)

Same shape as sand. Entering water ends the stroke: ball returns to **where that shot started**, and counts as **+1 penalty stroke**. `tee` must not be in water.

### `slopes` (polygons + force)

```json
{ "poly": [[...]], "force": [ax, ay] }
```

Constant acceleration (units/s²) applied while inside the polygon.

### `movers` (sliding bars)

```json
{
  "from": [x, y],
  "to": [x, y],
  "width": 60,
  "thickness": 10,
  "period": 3.0
}
```

Bar center moves between `from` and `to` with sine easing; position is a function of simulation time `t`. `period` is seconds for one full cycle. Ball reflects in the bar’s moving frame, so a moving bar can impart speed to it.

### `fastTurf` (World 2: dew lanes)

```json
{ "poly": [[80,280], [180,280], [180,380], [80,380]] }
```

Optional polygon array, same geometry format as sand. Rolling deceleration is
**140 units/s²** (400 × 0.35), with no added velocity. Swept ball-center coverage
weights friction for partial substeps; even thin polygons are detected. Overlaps
form a union and never stack. Sand overrides fast turf. Resting balls stay asleep.
Events `fast-turf-enter` / `fast-turf-exit` carry `{index, x, y}` at the boundary;
starting a shot inside emits enter, and a water reset emits exit at the contact.

### `oneWayGates` (World 3: wickets)

```json
{ "from": [80,320], "to": [180,320], "normal": [0,-1] }
```

Optional array of zero-thickness segments. The perpendicular **unit** normal
points in the permitted direction (the example permits upward travel).
Forward/parallel motion passes. Reverse motion on the normal-facing side collides
with radius 7 and restitution 0.8, including rounded endpoints. A ball on the
back side can depart freely. The existing travel bound protects full-speed shots.
`one-way-hit` carries `{index, x, y, nx, ny, speed}`: actual contact position,
collision normal and incoming speed. Every reflection counts as a solver cushion.
Invalid arrays, degenerate segments and non-unit/non-perpendicular normals throw
field-specific parser errors. Both new arrays are optional in the public `Level`
type; legacy parsed levels keep exactly their old fields.

Neither mechanic has a timer, latch or cooldown. Ball position determines turf
coverage; incoming velocity and position determine wickets. Thus `BallState.t`
continues to include all dynamic phase (existing movers), and existing exact-state
solver caches and continuation searches apply unchanged. See
[paid world design](design/worlds.md) for renderer recipes and the teaching order.

## Cup feel and settling

Ball radius is **7**, cup radius **11**, and shot power **1 = 900 units/s**.
Speeds below are instantaneous at the cup, before that substep's rolling friction.

- Within **1.6 × cup radius = 17.6 units**, a moving ball below **300 units/s**
  receives acceleration toward the center of **650 × (1 − distance / 17.6)**
  units/s². Pull is off at 300 or faster and outside that region. An already
  resting ball stays asleep; cup pull never wakes a distant resting ball.
- A ball within **cup radius − 2 = 9 units** drops at speed **below 230**.
- A firm putt at **230–330** drops when its incoming path passes **less than
  0.45 × cup radius = 4.95 units** from the center. It emits
  `{ type: "holed", firm: true }`. Ordinary captures emit `{ type: "holed" }`.
- At **230–420**, an offset of **4.95 or more** catches the rim. The ball bends
  outward by up to **60 degrees**, scaled by `(420 − speed) / 190` and
  `offset / 11`, retains **65%** of its speed, and emits `lip-out` once.
  Offset is perpendicular distance from the incoming path, not distance at
  the first sampled position inside the cup.
- Centered putts above **330** hop over; putts above **420** skim with at most
  **2 degrees** of deflection and no cup speed loss. These emit `rim`.
  A rim catch or hop suppresses further capture and rim responses until the ball
  leaves the 17.6-unit region, preventing an immediate slow recapture.
- Normal rest requires speed **below 4 for three consecutive 1/120-second
  ticks**. Faster motion resets the count. Holed balls, water resets, and the
  existing 12-second stroke timeout still end the shot immediately.

Keep approaches open enough to choose between a soft capture and a firm,
centered putt; a high-power rim catch should not be the only route.

## Validation

Use `parseLevel(json, fileHint)` from `src/sim/level.ts`. Invalid levels throw an error naming the file and field.

## Solver and authoring checks

Run `npm run check-levels` (or `node --import tsx scripts/check-levels.ts`).
The table reports `id | par | best | cush | feasible | worst% | explored | ms`.

### Intended route (optional authoring metadata)

```json
"intended": { "strokes": 3, "maxCushions": 2 }
```

`strokes` is a budget of 1–7 including water penalties; `maxCushions` is a
nonnegative integer limiting **each stroke**, not the route total. Free holes use
one or two at most. `parseIntended(json, fileHint)` in `solver.ts` validates this
metadata for both authoring scripts. `parseLevel` intentionally leaves it out of
the runtime `Level`; existing callers and gameplay need no API changes.

`solveLevel(level, { maxStrokes, maxCushions })` searches only legal shots under
that cap, including continuation searches. An unrestricted winner already within
the cap can be reused: it is also a valid restricted winner. A missing restricted
route fails the checker, even if an unrestricted pinball route finishes the hole.
`checkFeasibility: false` omits perturbations for route previews/checking metadata;
its `feasible` and `robust` are false and `worstPassRate` is zero, indicating
that feasibility has not been checked.

- **Best** includes shots and water penalties. At equal stroke cost, prefer the
  fewest **total** wall and mover contacts, then the shortest travelled path, then
  fewer penalties. All 960 sampled shots of an expanded state are examined.
- **Cush** (`SolveResult.cushions`) is the **maximum in one stroke** of that
  winning route. Bumper hits and cup lip-outs are excluded. Wall events count
  reflections; movers are measured against a collision-disabled shadow tick
  with identical integration bounds. Sustained mover contact is conservatively
  charged once per affected public tick. Path length sums public-tick travel,
  excluding the teleport after water.
- **Fail (exit 1):** invalid data, no solution within **par + 2**, best outside
  **par - 1 .. par**, **best = 1 on par >= 3**, failed intended route, failed
  feasibility (including worst% below 60), more than four sand holes **per twelve-hole world**, sand
  coverage above 20%, an intended cushion limit above two, or all holes taking **60 seconds or more**. These are hard gates.
- **Feasible:** perturb every shot at its original position/time by all nine
  combinations of angle **-1, 0, +1 degree** and power **-0.03, 0, +0.03**
  (clamped to 0–1). A variant passes if it holes or a newly planned continuation
  from its actual end finishes within **par + 2 total**, including the original
  prefix and water penalties. Each shot needs at least **six of nine** passes.
  `worst%` is the lowest per-shot pass rate. No displaced suffix is replayed.
- **Explored:** new candidate simulations in the main/continuation searches.
  Exact state/shot outcomes are cached across authoring calls for the same level;
  changing any level data invalidates the cache. `ms` includes the intended check.

The bounded search samples 96 directions and ten powers (0.1–1.0), merges
positions into 8-unit cells with mover phase buckets, and keeps 16 states per
stroke cost. A coarse navigation grid ranks progress around walls, water, and
bumpers, with an 80-unit beam-ranking cost per cushion; it never substitutes for
shot simulation. Equal-cell states prefer
fewer contacts, then shorter paths. Feasibility continuations first try a four-state beam of freshly aimed shots
toward the cup and visible navigation corners, using ten powers plus an estimated
rollout power. Every shot is simulated from its actual position and time. If that
fails, the full sampled search runs; either search stops once a finish is proved. **Best is the minimum found by this bounded discrete search**, not a
proof over all continuous aims and powers. Play-test shortcuts and comfortable
routes too.

Run `node --import tsx scripts/preview-levels.ts` to write individual SVGs and an
`index.html` to `build/previews`. Solid lime shows the intended constrained route;
faint dotted white shows the overall best. Captions report both routes' stroke
and cushion counts. Gates are drawn at time zero; their dashed tracks show travel.
Pale leaf dashes denote fast turf; coral chevrons point through one-way wickets.
`world1.html`, `world2.html`, and `world3.html` group the complete course.
Both authoring scripts accept `--world 1`, `--world 2`, or `--world 3`; omitted
means all holes and invalid values fail loudly. Filtered previews update only the
selected world index, preserving the all-world index. All checker thresholds,
including the **60-second** runtime gate, apply to both filtered and full runs.

The wall broad phase uses cached 32-unit spatial cells, expanded by ball radius.
It preserves the original segment order and falls back to that full order if
separation crosses a cell. Exact narrow-phase math and integration substeps are
unchanged. Wall edits between shots invalidate the geometry index.

Physics uses fixed 1/120-second public ticks with deterministic internal steps
of at most **BALL_R × 0.4 = 2.8 units** of integrated ball travel. The bound also
accounts for slope and cup acceleration and relative mover travel. Wall and mover contacts
preserve the side at the start of each sub-step, including a shot from wall contact.

## Authoring tips

- Keep the course within **16..344 × 72..624**, corridors at least **44** wide,
  cups at least **30** from walls, and hazards at least **16** from the tee.
- Shape the boundary around the route. Curves use short polygon segments.
- Hazards must affect a natural line: sand catches approaches, ponds punish
  corner cuts, slopes bend travel, bumpers guard lanes, and movers cross necks.
- Gate periods are **2.5–5 seconds**. Most tees belong in the lower third.
- Recheck all twelve holes together after geometry edits and inspect the SVGs.
