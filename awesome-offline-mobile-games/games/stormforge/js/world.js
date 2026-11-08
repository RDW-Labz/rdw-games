/* Stormforge — the map.
 *
 * One deterministic pass turns a seed into a stretch of coast, nine Suroi
 * structures, the roads between them, ore for the factory and cover to fight
 * from. Nothing here touches the DOM, a canvas, an Image or the network:
 * world.js only ever hands out sprite *paths*, and main.js is the one that
 * loads them. That split is what lets this file run under plain node for the
 * tests, and it is why the map survives a missing vendor bundle.
 *
 * Why the shapes are the shapes:
 *  - a lake in one corner plus a pond somewhere inland gives every match a
 *    natural boundary and somewhere to break line of sight without a wall;
 *  - rock is cut by percentile rather than a fixed elevation, so a hilly seed
 *    and a flat seed both end up with roughly the same amount of cliff — a
 *    fixed threshold would give one map cliffs and the next none;
 *  - roads are carved with A* over the terrain instead of drawn straight
 *    between POIs, so they bend around the lake and squeeze through the rock
 *    the way a real road would;
 *  - the nine vendored POIs are placed exactly once each (nine is also the
 *    default count), so no map is ever short a building type;
 *  - the storm is a nested ladder: every new centre is inside the previous
 *    circle by at least (prev.r - next.r), so shrinking can never strand a
 *    player outside a zone that jumped past them.
 *
 * Determinism: no Math.random, no Date, no floating-point accumulation that
 * depends on iteration order. Every subsystem draws from its own stream, so
 * asking for 300 props instead of 420 does not move a single tree that was
 * already there, and the tiles come out byte-identical on a repeat call.
 */
(function () {
  'use strict';

  var SF = window.SF_WORLD || (window.SF_WORLD = {});

  var TAU = Math.PI * 2;
  var T = { GRASS: 0, DIRT: 1, SAND: 2, WATER: 3, ROAD: 4, ROCK: 5 };
  var DEFAULTS = { size: 3000, cell: 16, pois: 9, ore: 90, props: 420 };

  /* ------------------------------------------------------------------ */
  /* maths, hashing, randomness                                          */
  /* ------------------------------------------------------------------ */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function dist2(ax, ay, bx, by) { var dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; }

  /* 32-bit integer avalanche. Math.imul keeps the multiply inside a word, so
     the hash is identical on every engine (a plain * would drift into doubles
     and the whole map would shift between browsers). */
  function mix32(n) {
    n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
    n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
    return (n ^ (n >>> 16)) >>> 0;
  }
  function h2(x, y, s) {
    var n = Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(s | 0, 83492791);
    return mix32(n) / 4294967296;
  }

  /* mulberry32: 32 bits of state, one imul per call, no allocation. Good
     enough for a map and fast enough to call a few hundred thousand times
     during generation. */
  function stream(seed, salt) {
    var a = mix32(Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(salt | 0, 0x85ebca6b)) | 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function nrnd(r, a, b) { return a + (b - a) * r(); }
  function irnd(r, a, b) { return a + Math.floor(r() * (b - a + 1)); }

  /* Value noise on a hashed lattice, smoothstepped. Two reads per call; the
     map only asks for ~150k of them, so clarity beats gradient noise here. */
  function noise2(x, y, s) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var fx = x - xi, fy = y - yi;
    var u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    var a = h2(xi, yi, s), b = h2(xi + 1, yi, s);
    var c = h2(xi, yi + 1, s), d = h2(xi + 1, yi + 1, s);
    var ab = a + (b - a) * u, cd = c + (d - c) * u;
    return ab + (cd - ab) * v;
  }
  function fbm(x, y, s, oct) {
    var sum = 0, amp = 0.5, total = 0, i;
    for (i = 0; i < oct; i++) {
      sum += amp * noise2(x, y, s + i * 1013);
      total += amp;
      x *= 2.03; y *= 1.97; amp *= 0.5;
    }
    return sum / total;
  }
  function percentile(sorted, q) {
    if (!sorted.length) return 0;
    return sorted[clamp(Math.floor(sorted.length * q), 0, sorted.length - 1)];
  }

  /* ------------------------------------------------------------------ */
  /* vendored structure art                                              */
  /* ------------------------------------------------------------------ */
  /* The vendored Suroi slice carries floors and ceilings for all nine POIs but
     no per-building wall strip: the only wall sprites in the bundle are the
     mansion gate and the barn's top-floor wall, and neither tiles. render.js
     paints art.wall as one sprite stretched across the footprint, so shipping
     those here would smear a gate across a 520 px mansion. The arrays stay
     present and empty, which is the signal for main.js to draw its authored
     walls — the house rule for every missing asset. */
  var P = 'vendor/suroi/buildings/';
  var POI_KINDS = [
    {
      kind: 'mansion', w: 520, h: 430,
      art: {
        floor: [P + 'mansion/mansion_bottom_floor_1.png', P + 'mansion/mansion_bottom_floor_2.png',
                P + 'mansion/mansion_bottom_floor_3.png', P + 'mansion/mansion_bottom_floor_4.png',
                P + 'mansion/mansion_top_floor.png'],
        wall: [],
        roof: [P + 'mansion/mansion_ceiling_1.png', P + 'mansion/mansion_ceiling_2.png',
               P + 'mansion/mansion_ceiling_3.png', P + 'mansion/mansion_ceiling_4.png']
      }
    },
    {
      kind: 'warehouse', w: 450, h: 340,
      art: {
        floor: [P + 'warehouse/warehouse_floor_1.png', P + 'warehouse/warehouse_floor_2.png'],
        wall: [],
        roof: [P + 'warehouse/warehouse_ceiling_1.png', P + 'warehouse/warehouse_ceiling_2.png']
      }
    },
    {
      kind: 'armory', w: 430, h: 390,
      art: {
        floor: [P + 'armory/armory_barracks_floor_1.png', P + 'armory/armory_barracks_floor_2.png',
                P + 'armory/armory_center_floor_1.png', P + 'armory/armory_center_floor_2.png',
                P + 'armory/armory_vault_floor_1.png', P + 'armory/armory_vault_floor_2.png'],
        wall: [],
        roof: [P + 'armory/armory_barracks_ceiling.png', P + 'armory/armory_center_ceiling.png',
               P + 'armory/armory_vault_ceiling.png', P + 'armory/armory_inner_vault_ceiling_1.png',
               P + 'armory/armory_inner_vault_ceiling_2.png']
      }
    },
    {
      kind: 'barn', w: 390, h: 310,
      art: {
        floor: [P + 'barn/barn_floor_1.png', P + 'barn/barn_floor_2.png',
                P + 'barn/barn_floor_3.png', P + 'barn/barn_floor_4.png'],
        wall: [],
        roof: [P + 'barn/barn_ceiling.png']
      }
    },
    {
      kind: 'construction_site', w: 370, h: 320,
      art: {
        floor: [P + 'construction_site/construction_site_floor_1_left.png',
                P + 'construction_site/construction_site_floor_1_right.png',
                P + 'construction_site/construction_site_floor_2_left.png',
                P + 'construction_site/construction_site_floor_2_right.png'],
        wall: [],
        roof: []
      }
    },
    {
      kind: 'lodge', w: 350, h: 300,
      art: {
        floor: [P + 'lodge/lodge_floor_bottom.png', P + 'lodge/lodge_floor_top.png',
                P + 'lodge/lodge_second_floor_bottom.png', P + 'lodge/lodge_second_floor_top.png'],
        wall: [],
        roof: [P + 'lodge/lodge_ceiling_bottom.png', P + 'lodge/lodge_ceiling_top.png',
               P + 'lodge/lodge_secret_room_ceiling.png']
      }
    },
    {
      kind: 'blue_house', w: 310, h: 270,
      art: {
        floor: [P + 'blue_house/blue_house_floor_1.png', P + 'blue_house/blue_house_floor_2_1.png',
                P + 'blue_house/blue_house_floor_2_2.png', P + 'blue_house/blue_house_basement_bottom.png'],
        wall: [],
        roof: [P + 'blue_house/blue_house_ceiling.png', P + 'blue_house/blue_house_vault_ceiling.png',
               P + 'blue_house/blue_house_mini_vault_ceiling.png']
      }
    },
    {
      kind: 'container', w: 250, h: 190,
      art: {
        floor: [P + 'container/container_floor_open1.png', P + 'container/container_floor_open2.png',
                P + 'container/container_floor_damaged1.png', P + 'container/container_floor_damaged2.png'],
        wall: [],
        roof: [P + 'container/container_ceiling_closed.png', P + 'container/container_ceiling_open1.png',
               P + 'container/container_ceiling_open2.png', P + 'container/container_ceiling_damaged1.png',
               P + 'container/container_ceiling_damaged2.png']
      }
    },
    {
      kind: 'cabin', w: 240, h: 200,
      art: {
        floor: [P + 'cabin/cabin_floor_1.png', P + 'cabin/cabin_floor_2.png'],
        wall: [],
        roof: [P + 'cabin/cabin_ceiling_1.png', P + 'cabin/cabin_ceiling_2.png']
      }
    }
  ];

  /* ------------------------------------------------------------------ */
  /* prop table                                                          */
  /* ------------------------------------------------------------------ */
  /* `where` is the scatter rule, not decoration:
       forest — only inside a noise belt, which is what makes the belts read;
       near   — crates and barrels hug the outskirts of a POI, so loot is
                where players already are rather than evenly sprinkled;
       rough  — rocks sit on high ground, next to the cliffs they fell off;
       any    — bushes, they go everywhere.
     hp 0 means the prop is terrain (indestructible); everything with hp can be
     shot away, and `solid` decides whether it also blocks movement. */
  var PR = 'vendor/suroi/props/';
  var PROPS = [
    { kind: 'pine', sprite: PR + 'pine_tree/pine_tree.png', r: 10, solid: true, hp: 0, weight: 22, where: 'forest' },
    { kind: 'birch', sprite: PR + 'birch_tree/birch_tree_trunk.png', r: 9, solid: true, hp: 0, weight: 13, where: 'forest' },
    { kind: 'oak', sprite: PR + 'oak_tree/oak_tree_trunk_1.png', r: 12, solid: true, hp: 0, weight: 10, where: 'forest' },
    { kind: 'spruce', sprite: PR + 'spruce_tree/spruce_tree_trunk.png', r: 10, solid: true, hp: 0, weight: 8, where: 'forest' },
    { kind: 'dead_pine', sprite: PR + 'dead_pine_tree/dead_pine_tree.png', r: 9, solid: true, hp: 0, weight: 5, where: 'forest' },
    { kind: 'bush', sprite: PR + 'bush/bush.png', r: 15, solid: false, hp: 18, weight: 13, where: 'any' },
    { kind: 'berry_bush', sprite: PR + 'blueberry_bush/blueberry_bush.png', r: 14, solid: false, hp: 18, weight: 8, where: 'forest' },
    { kind: 'rock', sprite: PR + 'rock/rock_1.png', r: 13, solid: true, hp: 0, weight: 8, where: 'rough' },
    { kind: 'boulder', sprite: PR + 'rock/rock_2.png', r: 18, solid: true, hp: 0, weight: 3, where: 'rough' },
    { kind: 'crate', sprite: PR + 'regular_crate/regular_crate.png', r: 10, solid: true, hp: 80, weight: 6, where: 'near' },
    { kind: 'ammo_crate', sprite: PR + 'ammo_crate/ammo_crate.png', r: 11, solid: true, hp: 90, weight: 2, where: 'near' },
    { kind: 'barrel', sprite: PR + 'barrel/barrel.png', r: 9, solid: true, hp: 60, weight: 5, where: 'near' },
    { kind: 'refinery_barrel', sprite: PR + 'small_refinery_barrel/small_refinery_barrel.png', r: 12, solid: true, hp: 110, weight: 2, where: 'near' },
    { kind: 'sandbags', sprite: PR + 'sandbags/sandbags.png', r: 18, solid: true, hp: 220, weight: 2, where: 'near' },
    { kind: 'fence', sprite: PR + 'fence/fence.png', r: 14, solid: true, hp: 70, weight: 3, where: 'any' },
    { kind: 'log', sprite: PR + 'hollow_log_wall/hollow_log_wall.png', r: 20, solid: true, hp: 140, weight: 2, where: 'forest' }
  ];

  /* ------------------------------------------------------------------ */
  /* make(seed, opts)                                                    */
  /* ------------------------------------------------------------------ */
  function make(seed, opts) {
    opts = opts || {};
    seed = seed | 0;
    var size = Math.max(512, (opts.size || DEFAULTS.size) | 0);
    var cell = Math.max(8, (opts.cell || DEFAULTS.cell) | 0);
    var wantPois = opts.pois == null ? DEFAULTS.pois : Math.max(0, opts.pois | 0);
    var wantOre = opts.ore == null ? DEFAULTS.ore : Math.max(0, opts.ore | 0);
    var wantProps = opts.props == null ? DEFAULTS.props : Math.max(0, opts.props | 0);

    /* 3000 / 16 is 187.5, so the grid has to round: rounding up lets the last
       row hang a few pixels over the edge, which is invisible, where rounding
       down would leave an 8 px strip of map with no tile under it. */
    var grid = Math.max(24, Math.ceil(size / cell));
    var N = grid * grid;

    var rTerrain = stream(seed, 0x1a7e);
    var rPoi = stream(seed, 0x2b81);
    var rRoad = stream(seed, 0x3c92);
    var rOre = stream(seed, 0x4d03);
    var rProp = stream(seed, 0x5e14);
    var rStorm = stream(seed, 0x6f25);
    var rBus = stream(seed, 0x7136);

    function gxOf(wx) { return clamp(Math.floor(wx / cell), 0, grid - 1); }
    function gyOf(wy) { return clamp(Math.floor(wy / cell), 0, grid - 1); }
    function wxOf(gx) { return Math.min(size - 1, (gx + 0.5) * cell); }
    function wyOf(gy) { return Math.min(size - 1, (gy + 0.5) * cell); }

    var tiles = new Uint8Array(N);

    /* ---------------------------------------------------------------- */
    /* terrain                                                           */
    /* ---------------------------------------------------------------- */
    var elev = new Float32Array(N);
    var wet = new Float32Array(N);
    var forest = new Float32Array(N);

    /* One corner lake, one inland pond. The corner is picked from the seed so
       two matches never open on the same coastline. */
    var corner = Math.floor(rTerrain() * 4) % 4;
    var lakeX = (corner & 1) ? size * 0.95 : size * 0.05;
    var lakeY = (corner & 2) ? size * 0.95 : size * 0.05;
    var lakeR = size * nrnd(rTerrain, 0.27, 0.34);
    var pondAng = rTerrain() * TAU;
    var pondD = size * nrnd(rTerrain, 0.26, 0.38);
    var pondX = size * 0.5 + Math.cos(pondAng) * pondD;
    var pondY = size * 0.5 + Math.sin(pondAng) * pondD;
    var pondR = size * nrnd(rTerrain, 0.045, 0.075);

    var i, gx, gy, wx, wy;
    for (gy = 0; gy < grid; gy++) {
      wy = gy * cell;
      for (gx = 0; gx < grid; gx++) {
        wx = gx * cell;
        i = gy * grid + gx;
        elev[i] = fbm(wx * 0.0016, wy * 0.0016, 101, 4);
        wet[i] = fbm(wx * 0.0021 + 91.7, wy * 0.0021 - 47.3, 907, 3);
        forest[i] = fbm(wx * 0.0024 + 311.5, wy * 0.0024 - 207.5, 1607, 3);
        /* shoreline wander: without the warp the lake is a circle and reads
           as a hole punched in the map */
        var lw = noise2(wx * 0.0055, wy * 0.0055, 2311);
        var dw = Math.sqrt(dist2(wx, wy, lakeX, lakeY)) / lakeR;
        var pw = Math.sqrt(dist2(wx, wy, pondX, pondY)) / (pondR * (0.78 + 0.44 * lw));
        var water = dw < 1.0 + (lw - 0.5) * 0.9 || pw < 1.0;
        var sand = !water && (dw < 1.09 + (lw - 0.5) * 0.9 || pw < 1.14);
        var t;
        if (water) t = T.WATER;
        else if (sand) t = T.SAND;
        else t = -1;
        tiles[i] = t < 0 ? 255 : t; // 255 = "still to decide" marker
      }
    }

    /* Percentile cuts instead of absolute ones. fbm rarely strays far from
       0.5, so `elev > 0.7` would produce a different amount of cliff on every
       seed; ranking the cells makes rock ~6% of the map every time. */
    var sortedE = new Float32Array(elev);
    var sortedW = new Float32Array(wet);
    var sortedF = new Float32Array(forest);
    sortedE.sort(); sortedW.sort(); sortedF.sort();
    var rockCut = percentile(sortedE, 0.94);
    var dirtCut = percentile(sortedW, 0.34);
    var forestCut = percentile(sortedF, 0.55);

    for (i = 0; i < N; i++) {
      if (tiles[i] !== 255) continue;
      if (elev[i] >= rockCut) tiles[i] = T.ROCK;
      else if (wet[i] <= dirtCut) tiles[i] = T.DIRT;
      else tiles[i] = T.GRASS;
    }

    /* ---------------------------------------------------------------- */
    /* POIs                                                              */
    /* ---------------------------------------------------------------- */
    /* One of each kind per default map: nine structures, nine vendored POIs.
       Extra POIs (if a caller asks for more) start cycling through a fresh
       shuffle so repeated kinds are still spread. */
    var plan = [];
    var pool = POI_KINDS.slice();
    var k, j, tmp;
    for (k = pool.length - 1; k > 0; k--) {
      j = Math.floor(rPoi() * (k + 1));
      tmp = pool[k]; pool[k] = pool[j]; pool[j] = tmp;
    }
    for (k = 0; k < wantPois; k++) plan.push(pool[k % pool.length]);

    /* biggest first: if the map is cramped the mansion still gets the best
       ground, where placing cabins first would box it out */
    plan.sort(function (a, b) { return (b.w * b.h) - (a.w * a.h); });

    var apron = 46;
    var margin = size * 0.05;

    /* Structures are authored for a 3000 px island. A 900 px test map, or a
       caller asking for 20 POIs instead of 9, would otherwise run out of room
       and silently place fewer than requested, so the footprints scale with
       both — area, not edge length, because footprint count grows with area. */
    var poScale = clamp(size / 3000, 0.42, 1) *
                  clamp(Math.sqrt(9 / Math.max(9, wantPois)), 0.55, 1);
    var gap = 130 * poScale;

    var pois = [];
    var reserved = new Uint8Array(N); // POI footprint + apron: no props, no ore

    function reserveCells(p, pad) {
      var x0 = gxOf(p.x - pad), x1 = gxOf(p.x + p.w + pad);
      var y0 = gyOf(p.y - pad), y1 = gyOf(p.y + p.h + pad);
      for (var yy = y0; yy <= y1; yy++) {
        for (var xx = x0; xx <= x1; xx++) reserved[yy * grid + xx] = 1;
      }
    }

    function fits(cx, cy, w, h, gap) {
      var rad = 0.5 * Math.sqrt(w * w + h * h);
      if (cx - rad < margin || cy - rad < margin || cx + rad > size - margin || cy + rad > size - margin) return false;
      for (var q = 0; q < pois.length; q++) {
        var other = pois[q];
        var need = other.rad + rad + gap;
        if (dist2(cx, cy, other.cx, other.cy) < need * need) return false;
      }
      /* the apron has to be dry ground too, or a POI ends up half in the lake */
      var x0 = gxOf(cx - w * 0.5 - apron), x1 = gxOf(cx + w * 0.5 + apron);
      var y0 = gyOf(cy - h * 0.5 - apron), y1 = gyOf(cy + h * 0.5 + apron);
      for (var yy = y0; yy <= y1; yy++) {
        for (var xx = x0; xx <= x1; xx++) {
          if (tiles[yy * grid + xx] === T.WATER) return false;
        }
      }
      return true;
    }

    for (k = 0; k < plan.length; k++) {
      var spec = plan[k];
      /* rounded to 4 px so floor textures tile without half-pixel seams */
      var w = Math.max(96, Math.round(spec.w * poScale / 4) * 4);
      var h = Math.max(84, Math.round(spec.h * poScale / 4) * 4);
      var best = null, bestScore = -1, attempt, cx, cy, score;
      /* 90 tries, keep the one furthest from everything already placed: that
         is farthest-point placement, which spreads POIs without a solver */
      for (attempt = 0; attempt < 90; attempt++) {
        cx = margin + rPoi() * (size - margin * 2);
        cy = margin + rPoi() * (size - margin * 2);
        if (!fits(cx, cy, w, h, gap)) continue;
        score = 1e12;
        for (j = 0; j < pois.length; j++) {
          var d = dist2(cx, cy, pois[j].cx, pois[j].cy);
          if (d < score) score = d;
        }
        if (score > bestScore) { bestScore = score; best = { cx: cx, cy: cy }; }
      }
      if (!best) {
        // squeeze: same search with less breathing room, then a coarse lattice
        for (attempt = 0; attempt < 90 && !best; attempt++) {
          cx = margin + rPoi() * (size - margin * 2);
          cy = margin + rPoi() * (size - margin * 2);
          if (fits(cx, cy, w, h, gap * 0.45)) best = { cx: cx, cy: cy };
        }
        for (var sy = margin; sy < size - margin && !best; sy += cell * 7) {
          for (var sx = margin; sx < size - margin && !best; sx += cell * 7) {
            if (fits(sx, sy, w, h, 18)) best = { cx: sx, cy: sy };
          }
        }
      }
      if (!best) continue; // a map too small for the spec; better to skip than overlap

      /* A quarter turn is the only rotation used. Anything else would let the
         rotated corners poke past the flattened pad, and the apron stops being
         a promise. */
      var ang = rPoi() < 0.34 ? Math.PI / 2 : 0;
      var poi = {
        id: pois.length,
        kind: spec.kind,
        cx: best.cx, cy: best.cy,
        x: best.cx - w * 0.5, y: best.cy - h * 0.5,
        w: w, h: h,
        ang: ang,
        rad: 0.5 * Math.sqrt(w * w + h * h),
        art: { floor: spec.art.floor.slice(), wall: spec.art.wall.slice(), roof: spec.art.roof.slice() }
      };

      /* flatten: the footprint becomes a dirt lot, the apron turns rock back
         into grass. Both are walkable, which is the contract's "every POI sits
         on flat walkable ground with a clear apron". */
      var fx0 = gxOf(poi.x - apron), fx1 = gxOf(poi.x + w + apron);
      var fy0 = gyOf(poi.y - apron), fy1 = gyOf(poi.y + h + apron);
      for (var fy = fy0; fy <= fy1; fy++) {
        for (var fx = fx0; fx <= fx1; fx++) {
          var fi = fy * grid + fx;
          var inside = fx >= gxOf(poi.x) && fx <= gxOf(poi.x + w) &&
                       fy >= gyOf(poi.y) && fy <= gyOf(poi.y + h);
          if (inside) tiles[fi] = T.DIRT;
          else if (tiles[fi] === T.ROCK || tiles[fi] === T.WATER) tiles[fi] = T.GRASS;
        }
      }
      reserveCells(poi, apron);
      pois.push(poi);
    }

    /* ---------------------------------------------------------------- */
    /* roads                                                            */
    /* ---------------------------------------------------------------- */
    /* Kruskal over POI pairs, but each link is an A* path across the real
       terrain. Water and rock are blocked, so a road that cannot be built is
       simply not built and the next-shortest pair gets a try — the network
       ends up connected for the pairs the land allows. */
    function walkCost(t) {
      if (t === T.WATER || t === T.ROCK) return -1;
      if (t === T.ROAD) return 0.55;
      if (t === T.SAND) return 1.35;
      return 1;
    }

    var stamp = new Uint32Array(N);
    var closedS = new Uint32Array(N);
    var gScore = new Float32Array(N);
    var cameFrom = new Int32Array(N);
    var gen = 0;

    function nearestOpen(sx, sy) {
      if (walkCost(tiles[sy * grid + sx]) > 0) return sy * grid + sx;
      for (var rr = 1; rr <= 5; rr++) {
        for (var oy = -rr; oy <= rr; oy++) {
          for (var ox = -rr; ox <= rr; ox++) {
            if (Math.abs(ox) !== rr && Math.abs(oy) !== rr) continue;
            var nx = sx + ox, ny = sy + oy;
            if (nx < 0 || ny < 0 || nx >= grid || ny >= grid) continue;
            if (walkCost(tiles[ny * grid + nx]) > 0) return ny * grid + nx;
          }
        }
      }
      return -1;
    }

    function pathfind(ax, ay, bx, by) {
      var s = nearestOpen(gxOf(ax), gyOf(ay));
      var tgt = nearestOpen(gxOf(bx), gyOf(by));
      if (s < 0 || tgt < 0) return null;
      gen++;
      var openI = [], openF = [];
      function push(node, f) {
        openI.push(node); openF.push(f);
        var at = openI.length - 1;
        while (at > 0) {
          var par = (at - 1) >> 1;
          if (openF[par] <= openF[at]) break;
          var ti = openI[par]; openI[par] = openI[at]; openI[at] = ti;
          var tf = openF[par]; openF[par] = openF[at]; openF[at] = tf;
          at = par;
        }
      }
      function pop() {
        var top = openI[0];
        var lastI = openI.pop(), lastF = openF.pop();
        if (openI.length) {
          openI[0] = lastI; openF[0] = lastF;
          var at = 0;
          for (;;) {
            var l = at * 2 + 1, r = l + 1, sm = at;
            if (l < openI.length && openF[l] < openF[sm]) sm = l;
            if (r < openI.length && openF[r] < openF[sm]) sm = r;
            if (sm === at) break;
            var ti = openI[sm]; openI[sm] = openI[at]; openI[at] = ti;
            var tf = openF[sm]; openF[sm] = openF[at]; openF[at] = tf;
            at = sm;
          }
        }
        return top;
      }
      var tx = tgt % grid, ty = (tgt - tx) / grid;
      stamp[s] = gen; gScore[s] = 0; cameFrom[s] = -1;
      push(s, 0);
      while (openI.length) {
        var cur = pop();
        if (closedS[cur] === gen) continue;
        closedS[cur] = gen;
        if (cur === tgt) {
          var out = [], walk = cur;
          while (walk >= 0) {
            var px = walk % grid;
            out.push([px, (walk - px) / grid]);
            walk = cameFrom[walk];
          }
          out.reverse();
          return out;
        }
        var cx2 = cur % grid, cy2 = (cur - cx2) / grid;
        for (var o = 0; o < 8; o++) {
          var dx = (o === 0 || o === 4 || o === 7) ? -1 : (o === 1 || o === 3 || o === 5) ? 0 : 1;
          var dy = o < 3 ? -1 : (o < 5 ? 0 : 1);
          var nx = cx2 + dx, ny = cy2 + dy;
          if (nx < 0 || ny < 0 || nx >= grid || ny >= grid) continue;
          var ni = ny * grid + nx;
          var step = walkCost(tiles[ni]);
          if (step < 0) continue;
          if (dx && dy) {
            // no cutting a diagonal past two solid corners: roads would clip
            // through the lake shore in a way the eye catches immediately
            if (walkCost(tiles[cy2 * grid + nx]) < 0 || walkCost(tiles[ny * grid + cx2]) < 0) continue;
            step *= 1.4142;
          }
          if (stamp[ni] !== gen || closedS[ni] !== gen) {
            var ng = gScore[cur] + step;
            if (stamp[ni] !== gen || ng < gScore[ni] - 1e-4) {
              stamp[ni] = gen;
              gScore[ni] = ng;
              cameFrom[ni] = cur;
              var hx = Math.abs(nx - tx), hy = Math.abs(ny - ty);
              push(ni, ng + (hx > hy ? hx + 0.4142 * hy : hy + 0.4142 * hx) * 0.5);
            }
          }
        }
      }
      return null;
    }

    /* where a road meets a building: on the rect edge, pushed out past the
       apron, so traffic never draws across the floor */
    function edgePoint(p, towardX, towardY) {
      var dx = towardX - p.cx, dy = towardY - p.cy;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var ux = dx / len, uy = dy / len;
      var tx = ux === 0 ? 1e9 : (p.w * 0.5) / Math.abs(ux);
      var ty = uy === 0 ? 1e9 : (p.h * 0.5) / Math.abs(uy);
      var reach = Math.min(tx, ty) + apron + 6;
      return { x: p.cx + ux * reach, y: p.cy + uy * reach };
    }

    function carveRoad(path) {
      if (!path) return;
      for (var q = 0; q < path.length; q++) {
        for (var oy = -1; oy <= 1; oy++) {
          for (var ox = -1; ox <= 1; ox++) {
            var nx = path[q][0] + ox, ny = path[q][1] + oy;
            if (nx < 0 || ny < 0 || nx >= grid || ny >= grid) continue;
            var ni = ny * grid + nx;
            if (tiles[ni] !== T.WATER) tiles[ni] = T.ROAD;
          }
        }
      }
    }

    if (pois.length > 1) {
      var pairs = [];
      for (i = 0; i < pois.length; i++) {
        for (j = i + 1; j < pois.length; j++) {
          pairs.push({ a: i, b: j, d: dist2(pois[i].cx, pois[i].cy, pois[j].cx, pois[j].cy) });
        }
      }
      pairs.sort(function (p, q) { return p.d - q.d; });
      var parent = [];
      for (i = 0; i < pois.length; i++) parent[i] = i;
      function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
      var links = 0;
      for (var pi = 0; pi < pairs.length && links < pois.length - 1; pi++) {
        var pr = pairs[pi];
        if (find(pr.a) === find(pr.b)) continue;
        var pa = pois[pr.a], pb = pois[pr.b];
        var ea = edgePoint(pa, pb.cx, pb.cy);
        var eb = edgePoint(pb, pa.cx, pa.cy);
        var path = pathfind(ea.x, ea.y, eb.x, eb.y);
        if (!path) continue; // the lake got in the way; try the next pair
        carveRoad(path);
        parent[find(pr.a)] = find(pr.b);
        links++;
      }
    }

    /* ---------------------------------------------------------------- */
    /* land inventory (shared by ore and props)                         */
    /* ---------------------------------------------------------------- */
    /* A flat list of buildable, prop-able ground. Sampling from this instead
       of rejection-testing random points keeps generation time proportional to
       the output, not to how unlucky the seed is. */
    var openCells = [];
    for (i = 0; i < N; i++) {
      if (reserved[i]) continue;
      var tt = tiles[i];
      if (tt === T.WATER || tt === T.ROCK || tt === T.ROAD) continue;
      openCells.push(i);
    }

    function cellX(idx) { return wxOf(idx % grid); }
    function cellY(idx) { return wyOf((idx - (idx % grid)) / grid); }
    function isOpen(gx2, gy2) {
      if (gx2 < 0 || gy2 < 0 || gx2 >= grid || gy2 >= grid) return false;
      var idx = gy2 * grid + gx2;
      if (reserved[idx]) return false;
      var t2 = tiles[idx];
      return t2 !== T.WATER && t2 !== T.ROCK && t2 !== T.ROAD;
    }

    /* ---------------------------------------------------------------- */
    /* ore                                                               */
    /* ---------------------------------------------------------------- */
    /* Clustered rather than scattered: a drill needs ore in a ring around it,
       so patches that arrive in groups of six are worth walking to and single
       cells in the middle of nowhere are not. */
    var ore = [];
    var oreMark = new Uint8Array(N);
    var ORE_TYPES = [
      { type: 'copper', weight: 56, min: 500, max: 1400 },
      { type: 'coal', weight: 27, min: 380, max: 1000 },
      { type: 'titanium', weight: 17, min: 240, max: 700 }
    ];
    function pickOreType(r) {
      var roll = r() * 100, acc = 0, q;
      for (q = 0; q < ORE_TYPES.length; q++) {
        acc += ORE_TYPES[q].weight;
        if (roll < acc) return ORE_TYPES[q];
      }
      return ORE_TYPES[0];
    }

    if (wantOre > 0 && openCells.length) {
      var clusters = clamp(Math.round(wantOre / 6), 1, Math.max(1, Math.round(openCells.length / 40)));
      var perCluster = [];
      var base = Math.floor(wantOre / clusters), extra = wantOre - base * clusters;
      for (k = 0; k < clusters; k++) perCluster.push(base + (k < extra ? 1 : 0));

      // cluster centres on a farthest-point sweep so ore covers the map
      var centres = [];
      for (k = 0; k < clusters; k++) {
        var bestC = null, bestS = -1;
        for (attempt = 0; attempt < 26; attempt++) {
          var cand = openCells[Math.floor(rOre() * openCells.length)];
          var ccx = cellX(cand), ccy = cellY(cand);
          score = 1e12;
          for (j = 0; j < centres.length; j++) {
            d = dist2(ccx, ccy, centres[j].x, centres[j].y);
            if (d < score) score = d;
          }
          if (score > bestS) { bestS = score; bestC = { x: ccx, y: ccy }; }
        }
        if (bestC) centres.push(bestC);
      }

      for (k = 0; k < centres.length && ore.length < wantOre; k++) {
        var centre = centres[k];
        var cgx = gxOf(centre.x), cgy = gyOf(centre.y);
        var need = perCluster[k] || 0, placedHere = 0, tries = 0;
        while (placedHere < need && tries < need * 30 && ore.length < wantOre) {
          tries++;
          var ox2 = cgx + irnd(rOre, -6, 6), oy2 = cgy + irnd(rOre, -6, 6);
          if (!isOpen(ox2, oy2)) continue;
          var oi = oy2 * grid + ox2;
          if (oreMark[oi]) continue;
          oreMark[oi] = 1;
          var spec2 = pickOreType(rOre);
          ore.push({
            gx: ox2, gy: oy2, x: wxOf(ox2), y: wyOf(oy2),
            type: spec2.type, amount: irnd(rOre, spec2.min, spec2.max)
          });
          placedHere++;
        }
      }
      // top up from anywhere open if a cluster was boxed in by water
      var guard = 0;
      while (ore.length < wantOre && guard < wantOre * 40) {
        guard++;
        var pickCell = openCells[Math.floor(rOre() * openCells.length)];
        if (oreMark[pickCell]) continue;
        oreMark[pickCell] = 1;
        var spec3 = pickOreType(rOre);
        ore.push({
          gx: pickCell % grid, gy: (pickCell - (pickCell % grid)) / grid,
          x: cellX(pickCell), y: cellY(pickCell),
          type: spec3.type, amount: irnd(rOre, spec3.min, spec3.max)
        });
      }
    }

    /* ---------------------------------------------------------------- */
    /* props                                                             */
    /* ---------------------------------------------------------------- */
    /* Spatial hash, built as props land, so both the overlap test here and
       propAt() at runtime are a handful of comparisons instead of a scan over
       400 entries (which main.js would otherwise do per bullet). */
    var BN = Math.ceil(size / 64) + 1;
    var buckets = new Array(BN * BN);
    var props = [];

    function bucketAdd(idx) {
      var p2 = props[idx];
      var b0x = clamp(Math.floor((p2.x - p2.r) / 64), 0, BN - 1);
      var b1x = clamp(Math.floor((p2.x + p2.r) / 64), 0, BN - 1);
      var b0y = clamp(Math.floor((p2.y - p2.r) / 64), 0, BN - 1);
      var b1y = clamp(Math.floor((p2.y + p2.r) / 64), 0, BN - 1);
      for (var by = b0y; by <= b1y; by++) {
        for (var bx = b0x; bx <= b1x; bx++) {
          var key = by * BN + bx;
          if (!buckets[key]) buckets[key] = [];
          buckets[key].push(idx);
        }
      }
    }

    function propBlocked(x, y, pad, anyProp) {
      if (!buckets.length) return false;
      var b0x = clamp(Math.floor((x - pad) / 64), 0, BN - 1);
      var b1x = clamp(Math.floor((x + pad) / 64), 0, BN - 1);
      var b0y = clamp(Math.floor((y - pad) / 64), 0, BN - 1);
      var b1y = clamp(Math.floor((y + pad) / 64), 0, BN - 1);
      for (var by = b0y; by <= b1y; by++) {
        for (var bx = b0x; bx <= b1x; bx++) {
          var list = buckets[by * BN + bx];
          if (!list) continue;
          for (var q = 0; q < list.length; q++) {
            var p3 = props[list[q]];
            if (!p3.solid && !anyProp) continue;
            var rr2 = p3.r + pad;
            if (dist2(x, y, p3.x, p3.y) < rr2 * rr2) return true;
          }
        }
      }
      return false;
    }

    var totalWeight = 0;
    for (k = 0; k < PROPS.length; k++) totalWeight += PROPS[k].weight;

    if (wantProps > 0 && openCells.length) {
      var allocated = [], sumAlloc = 0;
      for (k = 0; k < PROPS.length; k++) {
        var share = Math.floor(wantProps * PROPS[k].weight / totalWeight);
        allocated.push(share);
        sumAlloc += share;
      }
      // hand the rounding remainder to the heaviest kinds (the trees)
      for (k = 0; sumAlloc < wantProps; k = (k + 1) % PROPS.length) {
        allocated[k]++; sumAlloc++;
      }

      for (k = 0; k < PROPS.length; k++) {
        var def = PROPS[k];
        var want = allocated[k];
        var made = 0, budget = want * 40 + 40;
        while (made < want && budget > 0) {
          budget--;
          var cellIdx = openCells[Math.floor(rProp() * openCells.length)];
          var px2 = cellX(cellIdx) + nrnd(rProp, -6, 6);
          var py2 = cellY(cellIdx) + nrnd(rProp, -6, 6);
          px2 = clamp(px2, 2, size - 2); py2 = clamp(py2, 2, size - 2);
          var pgx = gxOf(px2), pgy = gyOf(py2);
          var ptile = tiles[pgy * grid + pgx];
          if (ptile === T.WATER || ptile === T.ROCK || ptile === T.ROAD) continue;
          /* trees only live in belts; crates only near a building; rocks only
             on high ground. This is what makes the map read as a place rather
             than as noise. */
          var fidx = pgy * grid + pgx;
          var okHere = true;
          if (def.where === 'forest') okHere = forest[fidx] >= forestCut;
          else if (def.where === 'rough') okHere = elev[fidx] >= rockCut - 0.055;
          else if (def.where === 'near') {
            okHere = false;
            var nearest = 1e12;
            for (j = 0; j < pois.length; j++) {
              d = dist2(px2, py2, pois[j].cx, pois[j].cy);
              if (d < nearest) nearest = d;
            }
            okHere = nearest < 520 * 520 && nearest > 120 * 120;
          }
          if (!okHere) continue;
          if (def.solid && propBlocked(px2, py2, def.r * 0.62)) continue;
          if (!def.solid && propBlocked(px2, py2, 2)) continue;
          props.push({
            x: px2, y: py2, r: def.r, sprite: def.sprite, kind: def.kind,
            solid: def.solid, destructible: def.hp > 0, hp: def.hp
          });
          bucketAdd(props.length - 1);
          made++;
        }
        /* last resort: the belt or the POI ring rejected every candidate (a
           map with one building, say). Fill the kind on any open ground so an
           explicit props: count still means what it says. */
        var spare = want - made, guard2 = 0;
        while (spare > 0 && guard2 < want * 20) {
          guard2++;
          var ci2 = openCells[Math.floor(rProp() * openCells.length)];
          var qx = cellX(ci2), qy = cellY(ci2);
          if (def.solid && propBlocked(qx, qy, def.r * 0.62)) continue;
          props.push({
            x: qx, y: qy, r: def.r, sprite: def.sprite, kind: def.kind,
            solid: def.solid, destructible: def.hp > 0, hp: def.hp
          });
          bucketAdd(props.length - 1);
          spare--; made++;
        }
      }
    }

    /* ---------------------------------------------------------------- */
    /* bus + storm                                                       */
    /* ---------------------------------------------------------------- */
    /* The bus is a chord of the map through a point near the middle: players
       get a long ride with the whole island under it, not a line that clips a
       corner. Both ends are clamped inside the margin so the drop marker never
       sits half off the play area. */
    var busAng = rBus() * TAU;
    var busOffA = rBus() * TAU;
    var busOff = size * 0.14 * rBus();
    var bcx = size * 0.5 + Math.cos(busOffA) * busOff;
    var bcy = size * 0.5 + Math.sin(busOffA) * busOff;
    var bdx = Math.cos(busAng), bdy = Math.sin(busAng);
    var inset = size * 0.05;
    var reachX = Math.abs(bdx) < 1e-6 ? 1e9 : (size * 0.5 - inset) / Math.abs(bdx);
    var reachY = Math.abs(bdy) < 1e-6 ? 1e9 : (size * 0.5 - inset) / Math.abs(bdy);
    var reach = Math.min(reachX, reachY);
    var bus = {
      a: { x: clamp(bcx + bdx * reach, inset, size - inset), y: clamp(bcy + bdy * reach, inset, size - inset) },
      b: { x: clamp(bcx - bdx * reach, inset, size - inset), y: clamp(bcy - bdy * reach, inset, size - inset) }
    };

    /* Six phases. Phase 0 is the whole map (0.98 * size clears the corners
       from any centre inside the island). Each later centre is chosen inside
       the disc that keeps the new circle contained, and prefers a POI so the
       endgame lands on a building instead of an empty field. */
    var STORM_R = [0.98, 0.46, 0.30, 0.185, 0.105, 0.055];
    var STORM_WAIT = [45, 40, 38, 34, 30, 0];
    var STORM_SHRINK = [30, 26, 24, 20, 16, 0];

    var storm = [{ wait: STORM_WAIT[0], shrink: STORM_SHRINK[0], cx: size * 0.5, cy: size * 0.5, r: size * STORM_R[0] }];
    for (k = 1; k < STORM_R.length; k++) {
      var prev = storm[k - 1];
      var nr = size * STORM_R[k];
      var allow = Math.max(0, prev.r - nr) * 0.98;
      var chosen = null;
      for (attempt = 0; attempt < 18 && !chosen; attempt++) {
        var nx2, ny2;
        if (attempt < 8 && pois.length) {
          var anchor = pois[Math.floor(rStorm() * pois.length)];
          nx2 = anchor.cx; ny2 = anchor.cy;
        } else {
          var aa = rStorm() * TAU, ad = Math.sqrt(rStorm()) * allow;
          nx2 = prev.cx + Math.cos(aa) * ad;
          ny2 = prev.cy + Math.sin(aa) * ad;
        }
        nx2 = clamp(nx2, size * 0.08, size * 0.92);
        ny2 = clamp(ny2, size * 0.08, size * 0.92);
        if (dist2(nx2, ny2, prev.cx, prev.cy) <= allow * allow) chosen = { x: nx2, y: ny2 };
      }
      if (!chosen) chosen = { x: prev.cx, y: prev.cy };
      storm.push({ wait: STORM_WAIT[k], shrink: STORM_SHRINK[k], cx: chosen.x, cy: chosen.y, r: nr });
    }

    /* stormAt walks the ladder: hold, then lerp to the next ring. Radius never
       rises, so a HUD bar drawn from this is monotonic by construction. */
    function stormAt(t) {
      if (!(t > 0)) t = 0;
      var acc = 0, q, ph;
      for (q = 0; q < storm.length; q++) {
        ph = storm[q];
        if (t < acc + ph.wait) return { cx: ph.cx, cy: ph.cy, r: ph.r, phase: q, closed: false };
        acc += ph.wait;
        if (ph.shrink > 0 && q + 1 < storm.length) {
          if (t < acc + ph.shrink) {
            var f = (t - acc) / ph.shrink;
            var nx3 = storm[q + 1];
            return {
              cx: lerp(ph.cx, nx3.cx, f), cy: lerp(ph.cy, nx3.cy, f),
              r: lerp(ph.r, nx3.r, f), phase: q, closed: false
            };
          }
          acc += ph.shrink;
        }
      }
      var last = storm[storm.length - 1];
      return { cx: last.cx, cy: last.cy, r: last.r, phase: storm.length - 1, closed: true };
    }

    /* ---------------------------------------------------------------- */
    /* public query helpers                                              */
    /* ---------------------------------------------------------------- */
    function tileAt(x, y) {
      return tiles[gyOf(y) * grid + gxOf(x)];
    }
    function walkable(x, y) {
      if (!(x >= 0) || !(y >= 0) || x >= size || y >= size) return false;
      var t = tiles[gyOf(y) * grid + gxOf(x)];
      return t !== T.WATER && t !== T.ROCK;
    }
    function propAt(x, y) {
      var bx = Math.floor(x / 64), by = Math.floor(y / 64);
      if (bx < 0 || by < 0 || bx >= BN || by >= BN) return null;
      var list = buckets[by * BN + bx];
      if (!list) return null;
      for (var q = 0; q < list.length; q++) {
        var p4 = props[list[q]];
        if (dist2(x, y, p4.x, p4.y) <= p4.r * p4.r) return p4;
      }
      return null;
    }

    /* Spawn points: the largest connected walkable region, sampled on a
       half-cell lattice (cheaper, and still finer than a player's radius), then
       farthest-point sampled so 32 bots do not all land on one beach. */
    var spawnPoolCache = null;
    function spawnPool() {
      if (spawnPoolCache) return spawnPoolCache;
      var lab = new Int32Array(N);
      var stack = new Int32Array(N);
      var comp = 0, bestComp = -1, bestCount = 0, sp, count, cur, cxx, cyy, ni2;
      for (i = 0; i < N; i++) {
        if (lab[i]) continue;
        var st = tiles[i];
        if (st === T.WATER || st === T.ROCK) { lab[i] = -1; continue; }
        comp++;
        sp = 0; stack[sp++] = i; lab[i] = comp; count = 0;
        while (sp) {
          cur = stack[--sp];
          count++;
          cxx = cur % grid; cyy = (cur - cxx) / grid;
          for (var o2 = 0; o2 < 4; o2++) {
            var nxx = cxx + (o2 === 0 ? -1 : o2 === 1 ? 1 : 0);
            var nyy = cyy + (o2 === 2 ? -1 : o2 === 3 ? 1 : 0);
            if (nxx < 0 || nyy < 0 || nxx >= grid || nyy >= grid) continue;
            ni2 = nyy * grid + nxx;
            if (lab[ni2]) continue;
            var nt = tiles[ni2];
            if (nt === T.WATER || nt === T.ROCK) { lab[ni2] = -1; continue; }
            lab[ni2] = comp;
            stack[sp++] = ni2;
          }
        }
        if (count > bestCount) { bestCount = count; bestComp = comp; }
      }
      var pool2 = [];
      for (i = 0; i < N; i++) {
        if (lab[i] !== bestComp) continue;
        gx = i % grid;
        gy = (i - gx) / grid;
        if ((gx + gy) & 1) continue;
        wx = wxOf(gx); wy = wyOf(gy);
        /* pad 16 and "any prop": a landing spot should be clear of the bush as
           well as the trunk, so the opening seconds are never a blind drop */
        if (propBlocked(wx, wy, 16, true)) continue;
        pool2.push({ x: wx, y: wy });
      }
      spawnPoolCache = pool2;
      return pool2;
    }

    function spawnPoints(n) {
      var pool2 = spawnPool();
      n = Math.max(1, n | 0);
      if (!pool2.length) return [];
      if (n > pool2.length) n = pool2.length;
      var out = new Array(n);
      var near = new Float32Array(pool2.length);
      var mx = 0, my = 0, q;
      for (q = 0; q < pool2.length; q++) { mx += pool2[q].x; my += pool2[q].y; }
      mx /= pool2.length; my /= pool2.length;
      var first = 0, bestD = Infinity;
      for (q = 0; q < pool2.length; q++) {
        var d0 = dist2(pool2[q].x, pool2[q].y, mx, my);
        if (d0 < bestD) { bestD = d0; first = q; }
      }
      var chosen = first;
      for (q = 0; q < pool2.length; q++) near[q] = dist2(pool2[q].x, pool2[q].y, pool2[chosen].x, pool2[chosen].y);
      for (var s2 = 0; s2 < n; s2++) {
        out[s2] = { x: pool2[chosen].x, y: pool2[chosen].y };
        if (s2 === n - 1) break;
        // everything at or inside the radius already covered can never win
        var far = -1, farD = -1;
        for (q = 0; q < pool2.length; q++) {
          if (near[q] > farD) { farD = near[q]; far = q; }
        }
        if (far < 0 || farD <= 0) break;
        chosen = far;
        for (q = 0; q < pool2.length; q++) {
          var nd = dist2(pool2[q].x, pool2[q].y, pool2[chosen].x, pool2[chosen].y);
          if (nd < near[q]) near[q] = nd;
        }
      }
      // if the pool was smaller than n, repeat the spread rather than lie
      while (out.length < n) out.push({ x: pool2[near.length % pool2.length].x, y: pool2[near.length % pool2.length].y });
      return out;
    }

    /* The crafting stream is left untouched by generation: main.js and bots
       can consume world.rng from the first frame without caring how many
       props the map happened to draw. */
    var rng = stream(seed, 0x9a01);

    return {
      seed: seed, size: size, cell: cell, grid: grid,
      rng: rng,
      tiles: tiles,
      tileAt: tileAt,
      walkable: walkable,
      pois: pois,
      ore: ore,
      props: props,
      propAt: propAt,
      spawnPoints: spawnPoints,
      bus: bus,
      storm: storm,
      stormAt: stormAt
    };
  }

  SF.make = make;
  SF.TILES = T;
})();

// Registers this module on the shared hook the collection's smoke test looks for; main.js
// replaces the hook with the live game object once everything is loaded.
window.__game = window.__game || {};
