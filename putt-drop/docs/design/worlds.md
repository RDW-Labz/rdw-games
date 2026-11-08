# Paid Pocket Park worlds

World 2, **Dewglass Garden** (13–24): pale dew lanes weave through folded garden beds.
World 3, **Wicket Grove** (25–36): little garden wickets make forward progress easy and return banks deliberate.

## Mechanic decision

Three candidates: fast turf, one-way wickets, and paired burrows. Fast turf teaches
distance control with a visible surface; wickets teach direction with a visible
arrow. Both use the existing aim gesture, deterministic geometry and the normal
solver. Burrows would add excellent spectacle but disconnected routes, velocity
orientation and an exit lock are a larger teaching and renderer burden. Choose
fast turf and wickets. Each world introduces exactly one mechanic; World 3 may
reuse World 2's turf after its opening lessons.

## Fast turf (World 2)

JSON: `"fastTurf": [{"poly": [[x,y], ...]}]`. Optional, empty by default.
Ball-center coverage reduces rolling deceleration from 400 to **140 units/s²**
(`FAST_TURF_FRICTION_MULT = 0.35`). Speed is never added. Sand takes precedence
(1600 units/s²); overlapping turf patches never stack. Cup and slope rules stay
unchanged. A resting ball stays asleep. Crossing fractions are measured along
each integrated substep, so even a narrow patch is not skipped at full power.
No clock, cooldown or persistent phase: position completely determines coverage.

Events: `fast-turf-enter` and `fast-turf-exit`, each with `{index, x, y}`;
index is the zero-based JSON zone index, x/y the exact boundary crossing.
Starting a shot inside emits enter at the starting position. A water reset emits
exit for each occupied patch at the water contact before returning to shot origin.
Stopping inside keeps coverage; shooting there emits a fresh enter.

Renderer: exact polygon in pale waterRipple with a waterEdge outline and sparse
long rounded dew dashes. Use botanical leaf-shaped highlights, never pond ripples
or sand dots. Bake it below sand, water, rails and ball so sand precedence stays visible. Enter may briefly brighten one baked
patch; exit stops the highlight. No looping shimmer; reduced motion is static.

## One-way wickets (World 3)

JSON: `"oneWayGates": [{"from": [x,y], "to": [x,y], "normal": [nx,ny]}]`.
Endpoints define a zero-thickness collision segment. `normal` must be a unit
vector perpendicular to the segment and points in the **allowed travel direction**.
Degenerate segments and invalid normals are rejected. Forward or parallel motion
passes through. Reverse motion from the normal-facing side reflects with the
existing wall restitution **0.8**, ball radius **7**, rounded endpoints and
unchanged travel-bounded substeps. A ball already on the other side can depart
without being pulled back. A resting ball never moves itself. No timer or latch;
position and incoming velocity determine the response, so no extra solver phase
or save-state field is needed. Simulation time still carries existing mover phase.

Event: `one-way-hit` with `{index, x, y, nx, ny, speed}` at the ball/segment
contact, including the actual collision normal and incoming speed. The solver
counts each reflected wicket contact as a cushion, just like a wall.

Renderer: cream posts at exact endpoints, a thin coral dashed strip along the
segment, and three dark chevrons toward `normal`. Wickets must look different
from solid rails and sliding bars. On hit flex only the decorative strip for
120 ms; never move the collision line. No idle animation or independent clock.

## Authoring and verification

Free holes remain byte-for-byte unchanged. New holes use par 3–5, intended routes
with at most two cushions per stroke, cups at least 30 units from rails and
corridors at least 44 units wide. Opening lessons isolate the new mechanic;
later holes layer ponds, bumpers, slopes and moving bars. The last two holes in
each world are multi-stage showpieces. Sand is limited to four holes per world
and 20% of each silhouette. Existing solver, feasibility and runtime gates remain.

## Variety pass verification — 2026-10-13

The prior job's checker table and route descriptions are superseded by this
variety pass. Final checker output and its runtime status are recorded below.

All 24 intended routes were replayed with at most two cushions per stroke.
A separate directed clearance search and segment-distance check found a
tee-to-cup corridor at least **44 units** wide on every paid hole. The existing
paid-course tests verify cup clearance >=30, tee hazard distance >=16, bounds,
par ranges, unique names/outlines, and the unchanged sand budgets.

Every World 2 intended route crosses fast turf. Replaying the same shots with
that surface removed changes a same-time path position by **13–114 units**
(the endpoint alone can hide an effect when both shots eventually hole).
Every World 3 hole has a reverse approach from its tee or an intended waypoint
that emits `one-way-hit`; removing the wickets changes that shot's endpoint by
more than **70 units**. These probes verify that the mechanics affect play.

The finale bank rails and braking patches are deliberately forgiving: they
reduce sensitivity to adjacent curved-wall segments without changing physics,
solver sampling, feasibility thresholds, or the runtime gate. Both par-five
finales still require four sampled strokes.

Previews: `build/previews/index.html`, the three world pages, all 36 route SVGs
and PNGs, 36 mechanic-only SVGs, and world contact sheets. The preview script
adds mechanic-only links and clips surface coverage to the playable boundary.
The PNGs were rasterized with AppKit and visually inspected, including the four
showpieces at full size. The diagnostic palette is not production artwork.

Validation artifacts are in `build/previews/validation/`: raw checker output,
per-world timings, exact intended shots and mechanic probes, clearance results,
and test output. Per-world timings sum the rounded per-hole milliseconds from
the same full checker invocation, rather than mixing independently timed runs.

`tsc --noEmit` passed. The final geometry/frame subset passed **18/18 tests**.
The full suite passed **159/160 tests**; its one failure is the unchanged
`tests/billing.test.ts:286` assertion that the catalog still contains 12 holes.
Running that billing file in a separate archive of pre-job commit `2cdcd39`
reproduced the same failure (12 passed, 1 failed). The baseline already has all
36 level files. Source, tests, the checker, and free holes remain unchanged.

### Full checker table

`node --import tsx scripts/check-levels.ts` returned **exit 0**: all 36
holes pass, including the unchanged **60-second runtime gate**, in **58.88
seconds**. No threshold was lowered and no check was bypassed.

Per-world row-time totals from that run: World 1 **19.978 s**,
World 2 **18.435 s**, World 3 **20.460 s**. The runtime margin
is narrow and host timings varied: earlier full runs of this same final geometry
failed the runtime gate at 85.04 and 62.24 seconds, while all gameplay rows passed.
An earlier run spent 69.42 seconds on the unchanged free holes alone. Final
geometry reduced the two finales' full-search simulation counts from
212,362 / 346,670 to 49,736 / 49,340, preserving four strokes and 100% worst-shot
feasibility. The passing run used the normal command, with no scheduling override,
cache substitution, or split-run acceptance.

```text
id       | par | best | cush | feasible | worst% | explored | ms
---------|-----|------|------|----------|--------|----------|-----
hole01   | 2   | 1    | 0    | true     | 100.0  | 964      | 171
hole02   | 3   | 2    | 2    | true     | 100.0  | 12709    | 852
hole03   | 3   | 2    | 0    | true     | 100.0  | 10646    | 732
hole04   | 3   | 2    | 0    | true     | 100.0  | 12533    | 555
hole05   | 3   | 2    | 0    | true     | 100.0  | 6965     | 559
hole06   | 3   | 2    | 2    | true     | 100.0  | 16865    | 1135
hole07   | 3   | 2    | 2    | true     | 100.0  | 16778    | 1721
hole08   | 3   | 2    | 2    | true     | 100.0  | 16684    | 2160
hole09   | 4   | 3    | 1    | true     | 100.0  | 32636    | 2413
hole10   | 4   | 3    | 1    | true     | 100.0  | 33132    | 6243
hole11   | 4   | 3    | 1    | true     | 100.0  | 32907    | 2099
hole12   | 4   | 3    | 1    | true     | 100.0  | 32663    | 1338
hole13   | 3   | 2    | 1    | true     | 100.0  | 15612    | 1416
hole14   | 3   | 2    | 1    | true     | 100.0  | 14883    | 1415
hole15   | 3   | 2    | 1    | true     | 100.0  | 13613    | 1056
hole16   | 3   | 2    | 1    | true     | 100.0  | 15554    | 1811
hole17   | 3   | 2    | 1    | true     | 100.0  | 7779     | 684
hole18   | 3   | 2    | 0    | true     | 100.0  | 6832     | 617
hole19   | 3   | 2    | 0    | true     | 100.0  | 7894     | 941
hole20   | 3   | 2    | 1    | true     | 100.0  | 14791    | 2473
hole21   | 3   | 2    | 0    | true     | 100.0  | 5862     | 392
hole22   | 3   | 2    | 0    | true     | 100.0  | 9636     | 1050
hole23   | 4   | 3    | 3    | true     | 100.0  | 29282    | 3436
hole24   | 5   | 4    | 1    | true     | 100.0  | 49736    | 3144
hole25   | 3   | 2    | 0    | true     | 100.0  | 15394    | 1576
hole26   | 3   | 2    | 1    | true     | 100.0  | 13634    | 1123
hole27   | 3   | 2    | 2    | true     | 100.0  | 15369    | 1351
hole28   | 3   | 2    | 0    | true     | 100.0  | 11532    | 1008
hole29   | 3   | 2    | 1    | true     | 100.0  | 10732    | 1144
hole30   | 3   | 2    | 1    | true     | 100.0  | 15561    | 1186
hole31   | 3   | 2    | 1    | true     | 100.0  | 16528    | 1014
hole32   | 3   | 2    | 0    | true     | 100.0  | 8652     | 790
hole33   | 3   | 2    | 0    | true     | 100.0  | 9612     | 929
hole34   | 3   | 2    | 0    | true     | 100.0  | 4811     | 586
hole35   | 4   | 3    | 1    | true     | 100.0  | 33337    | 5673
hole36   | 5   | 4    | 2    | true     | 100.0  | 49340    | 4080
Total: 58.88 s
```

`cush` describes the unrestricted best route. Hole 23's three-cushion best is
accompanied by a separately replayed three-stroke intended route capped at two
cushions per stroke. The sampled solver does not prove a global continuous
optimum over all possible angles and powers.

### Silhouettes, mechanics, and intended routes

The free twelve were inspected as the comparison set and remain byte-for-byte
unchanged. The paid set spans open crescents, pinched forms, branching figures,
compact crossways, and island circuits. Curves use short polygon segments;
these are distinct outline families, not rotations of one shared template.
The opening pairs isolate their world's mechanic. Holes 23/24 and 35/36 build
three- then four-shot showpieces. Sand appears on 16, 18, 23, 24 and 28, 31, 32,
36: four holes per paid world. The largest sand coverage is hole 24 at 17.59%.

The waypoints below are rounded from actual constrained solver replays, not
hand-drawn promises. Each route finishes within par and uses at most two
cushions per stroke. Final cup coordinates are in the level files.

- **13 — Crescent Carry:** Open crescent; dew carries the outside sweep. Bank into the upper-left shoulder (127,168), then thread the cup pocket below the top spur.
- **14 — Hourglass Drift:** Broad hourglass; dew preserves speed through the pinched waist. Lay up right of the lower fence (185,508), then cross the waist and bank into the upper-right bowl.
- **15 — Fern Boomerang:** Narrow curved boomerang; dew changes the middle bank's rollout. Thread the staggered rails to (210,277), then bank past the head rail into the cup.
- **16 — Silver Comma:** Asymmetric comma; a fast tail feeds a sand brake. Stop at (251,315), then round the bulb below the hanging rail and approach the left cup.
- **17 — Willow Horseshoe:** Tall horseshoe; dew carries the long outward leg, while water punishes the outer return bank. Reach (106,166), cross the crown, and descend the right arm.
- **18 — Petal River:** Sweeping river bend; a diagonal dew patch feeds the sand at the turn. Stop at (289,277), then turn left into the sheltered headwater cup.
- **19 — Brook Terraces:** Rounded ascending terraces; dew carries the climb toward a pond and sloped finish. Stage right of the pond at (243,258), then climb left of the final rail.
- **20 — Clover Clock:** Four-lobed clover; dew on the right neck changes the bank past the timed bar. Bank into the left upper lobe (108,176), then finish in the crown petal.
- **21 — Dapple Ring:** Broad oval ring around a long pond; dew rewards the left circuit. Reach the upper-left shore (114,192), then cross above the island toward the right cup.
- **22 — Rain Tulip:** Three-point tulip on a tapered stem; dew carries the stem but demands a controlled exit beside the pond. Reach (240,324) beyond the fence, then cross left through the bowl.
- **23 — Lantern Spiral:** Rounded inward spiral; two dew runs and a sandy return make three distinct stages. Bank to (151,90), descend to (320,482), then round the bottom hairpin and climb the inner finger.
- **24 — Dewglass Archipelago:** Scalloped lagoon with three islands; dew climbs alternate with sand brakes. Carry to the right bank at (277,436), turn past the middle island to (83,250), meter the bridge to (244,218), then bank above the upper island into the left cup.
- **25 — Heartwood Gate:** Heart; the downward wicket blocks the direct upward putt. Stage around its right end at (230,282), then turn left into the cup lobe.
- **26 — Butterfly Turnstile:** Four-wing butterfly; a reverse wicket closes the obvious waist line. Use the right opening to (241,328), then bank into the upper-right wing.
- **27 — Robin Trident:** Three-pronged trident; a reverse stem wicket and forward crossbar control entry and return. Bank into the left crosspiece (104,316), then climb past the short fence into the left tine.
- **28 — Picket Mushroom:** Mushroom cap and stalk; the reverse wicket requires an offset stem approach. Stage at (191,384), then turn under the hanging rail toward the left cap cup.
- **29 — Kingfisher Seahorse:** Curled seahorse; a reverse wicket guards the bend before the dew neck. Clear the tail pond to (217,431), then bypass the wicket's right end and bank through dew into the head.
- **30 — Acorn Pennant:** Concave pennant on a narrow pole; the reverse wicket offsets the climb into a cross-slope. Stage at (153,298), then bank around the shelf rail into the flag tip.
- **31 — Heron Yoke:** Compact horizontal yoke; a westward wicket blocks the direct crossing, with sand below it and a fence beyond. Brake at (193,546), then bank over the fence into the right pocket.
- **32 — Wicket Pinwheel:** Asymmetric pinwheel; opposed wickets turn the lower approach into an upward exit. Stage beside the upper wicket at (208,297), then pass in its allowed direction into the upper-left blade.
- **33 — Oriole Shell:** Scalloped shell; a reverse wicket and diagonal shelf require a rightward detour through dew. Reach (252,261), then cross left below the crown rail.
- **34 — Mulberry Frond:** Alternating frond lobes; a reverse wicket blocks the direct climb above the pond. Stage on its right at (221,322), then ascend around the hanging tip rail.
- **35 — Grove Crown:** Three-point crown above scalloped bays; two reverse wickets, a forward wicket, pond, and slider form a three-stage sequence. Reach (281,400), pass upward to (219,249), then hook around the upper rail into the crown cup.
- **36 — Infinity Jubilee:** Figure-eight twin lagoons; opposed wickets dictate both circuits and sand separates stages. Carry onto the right shore (306,496), climb to the sandy waist (185,314), use the two consistent banks to reach the upper bridge (190,114), then descend through the allowed right wicket into the cup.
