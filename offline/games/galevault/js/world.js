window.__game = window.__game || {};
/**
 * Galevault — simulation layer.
 *
 * A gorge flown at speed: one winding canyon cut through a plateau, gates strung
 * along its centreline, pirate gliders working the same air. Nothing in this file
 * touches three.js; it owns the numbers, the world is a heightfield plus a spline.
 *
 * The flight model is not invented. Every craft is a hull out of Endless Sky's own
 * ship table (vendor/endless-sky, data/human/ships.txt and friends, GPL-3.0): mass
 * sets how hard the airframe answers, drag sets the wall it runs into, hull is the
 * damage it soaks. Pick the nimble Barb and the numbers on the HUD — mass 20,
 * drag 0.8, hull 200 — are the ones in the upstream file, not a designer's guess.
 */
(function (g) {
  'use strict';

  var WV = g.GV = g.GV || {};

  /* ---------------------------------------------------------------- constants */

  WV.SIZE = 2600;          // world is SIZE x SIZE units, 1 unit ~ 1 metre
  WV.CELL = 12;            // heightfield cell; ~217 x 217 samples over the world
  WV.WATER = -3;           // river surface
  WV.GRAVITY = 9.2;        // gentle: this is a glider, not a brick
  WV.GATE_R = 13;          // gate radius; pass within it and it counts
  WV.GATES = 20;
  WV.TIME_CAP = 240;       // seconds before the run is called
  WV.PIRATES = 3;

  WV.clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  WV.lerp = function (a, b, t) { return a + (b - a) * t; };
  WV.wrap = function (a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  };

  /* deterministic hash noise: the canyon must be the same canyon every boot,
   * or a saved best time means nothing */
  function hash2(x, y, seed) {
    var h = x * 374761393 + y * 668265263 + seed * 1442695041;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
  }
  function vnoise(x, y, seed) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    var a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
    var c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
    return WV.lerp(WV.lerp(a, b, u), WV.lerp(c, d, u), v);
  }
  function fbm(x, y, seed, oct) {
    var s = 0, amp = 0.5, f = 1;
    for (var i = 0; i < (oct || 4); i++) {
      s += vnoise(x * f, y * f, seed + i * 17) * amp;
      amp *= 0.5; f *= 2.02;
    }
    return s;
  }
  WV.hash2 = hash2;

  /* ------------------------------------------------------------------- craft */
  /* Read straight out of the vendored table. A hull without mass or drag cannot
   * fly, so it is skipped rather than defaulted — a missing field would otherwise
   * turn into a fiction that still passes a "loaded" count. */
  WV.craftTable = function (V) {
    var out = [];
    var rows = (V && V.data && V.data['endless-sky/ships']) || [];
    for (var i = 0; i < rows.length; i++) {
      var s = rows[i];
      if (typeof s.mass !== 'number' || s.mass <= 0) continue;
      if (typeof s.drag !== 'number') continue;
      out.push({
        name: s.name, mass: s.mass, drag: s.drag, hull: s.hull || 400,
        category: s.category, cost: s.cost, image: s.image,
        /* the three the player can pick, in the order they appear here */
        playable: s.name === 'Barb' || s.name === 'Sprout' || s.name === 'Windjammer'
      });
    }
    return out;
  };

  /* handling derived from the upstream numbers, not typed in: light airframes
   * accelerate, draggy ones top out early */
  WV.deriveFlight = function (c) {
    /* Mass is clamped for flight only: Endless Sky's Windjammer masses 1240, and the
     * uncapped derivation topped it out at 81 km/h — a choice nobody would ever take
     * in a race. Capped at 600 it flies at ~145 km/h with 6900 hull, which is the
     * "flying fortress" the card promises. Hull points stay uncapped and upstream. */
    var m = WV.clamp(c.mass, 0.6, 600), d = WV.clamp(c.drag, 0.05, 6);
    return {
      accel: 340 / Math.sqrt(m),
      topSpeed: 210 / (1 + d * 0.30) / Math.sqrt(1 + m / 900),
      /* turn authority is a rate in rad/s. At 190 u/s a 1.15 rad/s hull needs a
       * 165-unit radius, wider than the gorge: every bend became an overshoot. */
      turn: WV.clamp(1.72 - Math.log(m + 1) * 0.10, 0.62, 1.55),
      hp: Math.round(c.hull || 400),
      climb: WV.clamp(26 - Math.log(m + 1) * 1.4, 8, 26)
    };
  };

  /* ------------------------------------------------------------ the canyon */

  /* A spline through the world, sampled into a polyline. Turns are wide enough to
   * fly at speed: the fun is in reading the gorge ahead, not in threadneedle turns. */
  function buildPath(rng, seed) {
    /* A closed radial loop: r(theta) = R * (1 + harmonics). The old version was a
     * Catmull-Rom through jittered control radii, which self-intersected and threw
     * hairpins — gates ended up on the wrong side of a wall and the run became
     * unflyable no matter how the autopilot steered. Harmonic radii are simple
     * (never crossing), closed, and their curvature is bounded by the amplitudes. */
    var cx = WV.SIZE * 0.5, cz = WV.SIZE * 0.5;
    var R = WV.SIZE * 0.30;
    var p1 = rng() * Math.PI * 2, p2 = rng() * Math.PI * 2;
    var a3 = 0.15 + rng() * 0.06, a5 = 0.05 + rng() * 0.035;
    var n = 260;
    var curve = [];
    for (var i = 0; i < n; i++) {
      var th = (i / n) * Math.PI * 2;
      var r = R * (1 + a3 * Math.sin(3 * th + p1) + a5 * Math.sin(5 * th + p2));
      curve.push({ x: cx + Math.cos(th) * r, z: cz + Math.sin(th) * r });
    }
    return curve;
  }

  /* distance from a point to the polyline, plus the index of the closest sample */
  function pathDist(curve, x, z) {
    var best = 1e9, bi = 0;
    for (var i = 0; i < curve.length; i++) {
      var dx = curve[i].x - x, dz = curve[i].z - z;
      var d = dx * dx + dz * dz;
      if (d < best) { best = d; bi = i; }
    }
    return { d: Math.sqrt(best), i: bi };
  }

  /* Build the world: heightfield + track. Heights come from fbm plateaus minus a
   * Gaussian carve along the spline, so the river has a floor and the walls are
   * steep but not vertical — a glider can clip them, which is the point. */
  /* The point on the flight path a given distance ahead of the craft. Steering at
   * a gate directly is pursuit of a point, which overshoots: at 200 u/s the craft
   * arrived at each gate 20-40 units to one side and flew past outside the ring.
   * Following the path that the gates sit on puts it through them. */
  WV.pathAhead = function (w, x, z, ahead) {
    var r = pathDist(w.curve, x, z);
    var step = Math.max(1, Math.round((ahead || 60) / (w.pathStep || 10)));
    var i = (r.i + step) % w.curve.length;
    return { p: w.curve[i], near: r.d };
  };

  WV.buildWorld = function (seed) {
    var rng = (function (s) {
      var t = s >>> 0;
      return function () {
        t += 0x6D2B79F5;
        var r = t;
        r = Math.imul(r ^ (r >>> 15), r | 1);
        r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
      };
    })(seed);

    var curve = buildPath(rng, seed);
    var N = Math.round(WV.SIZE / WV.CELL);
    var heights = new Float32Array((N + 1) * (N + 1));
    var sx = WV.SIZE / N;

    /* cache the path distance per cell in one pass: N^2 * curve is ~28k * 200 */
    var dist = new Float32Array((N + 1) * (N + 1));
    for (var j = 0; j <= N; j++) {
      for (var i = 0; i <= N; i++) {
        var x = i * sx, z = j * sx;
        dist[j * (N + 1) + i] = pathDist(curve, x, z).d;
      }
    }

    for (var jj = 0; jj <= N; jj++) {
      for (var ii = 0; ii <= N; ii++) {
        var wx = ii * sx, wz = jj * sx;
        var d = dist[jj * (N + 1) + ii];
        /* plateau: rolling high ground */
        var plateau = 46 + fbm(wx / 420, wz / 420, seed, 4) * 58;
        plateau += fbm(wx / 90, wz / 90, seed + 31, 3) * 9;
        /* the gorge: full depth near the centreline, plateau outside ~55 units */
        var w = 64 + vnoise(wx / 260, wz / 260, seed + 7) * 30;
        var carve = Math.exp(-(d * d) / (w * w));
        /* terraces on the walls read as strata and give the eye a sense of scale */
        var terrace = Math.cos(d * 0.09) * 2.4 * (1 - carve);
        var h = plateau - carve * (plateau - (WV.WATER - 6 + fbm(wx / 60, wz / 60, seed + 3, 2) * 4)) + terrace;
        heights[jj * (N + 1) + ii] = h;
      }
    }

    /* gates along the curve, spaced so consecutive gates are a real entry line */
    var gates = [];
    var step = Math.floor(curve.length / (WV.GATES + 1));
    for (var gi = 1; gi <= WV.GATES; gi++) {
      var c = curve[gi * step];
      var nxt = curve[Math.min(curve.length - 1, gi * step + 8)];
      var h0 = WV.groundAt({ N: N, sx: sx, heights: heights }, c.x, c.z);
      gates.push({
        x: c.x, z: c.z, y: Math.max(h0 + 26, WV.WATER + 32),
        yaw: Math.atan2(nxt.x - c.x, nxt.z - c.z),
        index: gi - 1, passed: false
      });
    }

    var plen = 0;
    for (var q = 1; q < curve.length; q++) plen += Math.hypot(curve[q].x - curve[q - 1].x, curve[q].z - curve[q - 1].z);
    var world = {
      seed: seed, N: N, sx: sx, heights: heights, curve: curve,
      pathStep: plen / Math.max(1, curve.length),
      gates: gates, waterY: WV.WATER, size: WV.SIZE
    };
    world.start = {
      x: curve[2].x, z: curve[2].z,
      y: WV.groundAt(world, curve[2].x, curve[2].z) + 31,
      yaw: Math.atan2(curve[6].x - curve[2].x, curve[6].z - curve[2].z)
    };
    return world;
  };

  /* bilinear height sample; the world outside the grid falls back to the last row */
  WV.groundAt = function (w, x, z) {
    var N = w.N, sx = w.sx, H = w.heights;
    var fx = WV.clamp(x / sx, 0, N - 1e-4), fz = WV.clamp(z / sx, 0, N - 1e-4);
    var i = Math.floor(fx), j = Math.floor(fz);
    var tx = fx - i, tz = fz - j;
    var a = H[j * (N + 1) + i], b = H[j * (N + 1) + i + 1];
    var c = H[(j + 1) * (N + 1) + i], d = H[(j + 1) * (N + 1) + i + 1];
    return WV.lerp(WV.lerp(a, b, tx), WV.lerp(c, d, tx), tz);
  };

  /* --------------------------------------------------------------- the run */

  WV.newRun = function (world, craft) {
    var f = WV.deriveFlight(craft);
    var run = {
      world: world, craft: craft, flight: f,
      phase: 'ready',             // ready | flying | wrecked | finished
      t: 0, gates: 0, gatesTotal: world.gates.length,
      hull: f.hp, hullMax: f.hp,
      boost: 100, boosting: false,
      speed: 0, tilt: 0, bank: 0, roll: 0,
      x: world.start.x, z: world.start.z, y: world.start.y,
      yaw: world.start.yaw, pitch: 0,
      pirates: [], bolts: [], nextGate: 0,
      damage: 0, hits: 0, best: 0,
      trail: [], msgs: []
    };
    for (var i = 0; i < WV.PIRATES; i++) {
      var g0 = world.gates[Math.min(world.gates.length - 1, 2 + i)];
      run.pirates.push({
        name: 'Pirate ' + (i + 1), alive: true, hull: 120,
        x: g0.x + (i - 1) * 14, z: g0.z - 60 - i * 18, y: g0.y + 6,
        yaw: 0, cool: 0.6 + i * 0.4, speed: 0
      });
    }
    /* gates carry their own passed flag on the run, never on the shared world */
    run.gatesPassed = [];
    for (var k = 0; k < world.gates.length; k++) run.gatesPassed.push(false);
    return run;
  };

  /* One physics step. Steer is -1..1 (yaw), throttle 0..1, climb -1..1. */
  WV.step = function (run, dt, input) {
    if (run.phase !== 'flying') return run;
    input = input || {};
    var f = run.flight, w = run.world;

    run.t += dt;

    /* ---- rotation. banking follows the turn, which is what sells a glider. */
    var turnIn = WV.clamp(input.steer || 0, -1, 1);
    var targetRoll = -turnIn * 0.62;
    run.roll = WV.lerp(run.roll, targetRoll, Math.min(1, dt * 6));
    /* forward is (sin yaw, cos yaw): a positive steer has to INCREASE yaw, or the
     * stick steers away from where the nose is pointed and the autopilot spirals */
    run.yaw += turnIn * f.turn * dt * 1.25;

    var climbIn = WV.clamp(input.climb || 0, -1, 1);
    run.pitch = WV.lerp(run.pitch, climbIn * 0.5, Math.min(1, dt * 4.5));

    /* ---- thrust. boost is a multiplier on the hull's own acceleration. */
    var wantBoost = !!input.boost && run.boost > 1;
    run.boosting = wantBoost;
    if (wantBoost) run.boost = Math.max(0, run.boost - 26 * dt);
    else run.boost = Math.min(100, run.boost + 9 * dt);

    var throttle = input.throttle == null ? 1 : WV.clamp(input.throttle, 0, 1);
    var boostMul = wantBoost ? 1.85 : 1;
    var accel = f.accel * throttle * boostMul;
    var top = f.topSpeed * (wantBoost ? 1.32 : 1);
    /* drag as a soft wall: the closer to top speed, the less the air takes */
    run.speed += (accel - run.speed * (accel / Math.max(1, top))) * dt * 1.15;
    /* gravity trades speed for height, which is the whole game in a gorge */
    run.speed -= Math.sin(run.pitch) * WV.GRAVITY * dt * 1.6;
    run.speed = WV.clamp(run.speed, 0, top * 1.15);

    var fwdX = Math.sin(run.yaw), fwdZ = Math.cos(run.yaw);
    var prevX = run.x, prevZ = run.z;          // for an honest crash test
    run.x += fwdX * run.speed * dt;
    run.z += fwdZ * run.speed * dt;
    run.y += (Math.sin(run.pitch) * run.speed * 0.42) * dt;
    /* a wing makes lift: at cruise the sink is nil, and it only drops as airspeed
     * bleeds away. Without this the craft fell out of the sky at 3 u/s^2 and spent
     * the run scraping the canyon floor. */
    var lift = WV.clamp(run.speed / Math.max(1, top * 0.72), 0, 1);
    run.y -= WV.GRAVITY * 0.42 * dt * (1 - lift) * (1 - Math.abs(Math.sin(run.pitch)) * 0.6);

    /* ---- terrain, tested where the craft actually is.
     * The old version probed 22 units ahead and counted anything above the nose as
     * a wall: on a bend that is the far bank of the same river the craft is
     * following, so a clean run bled 200 hull in twenty seconds. Now the move is
     * rejected when it would put the nose inside rock or water, and the damage has
     * a cooldown so one bad decision costs one hit, not sixty. */
    run.cd = Math.max(0, (run.cd || 0) - dt);
    var gy = WV.groundAt(w, run.x, run.z);
    var floorY = Math.max(gy, w.waterY) + 2.2;
    if (run.y < floorY) {
      run.x = prevX;
      run.z = prevZ;
      var backG = Math.max(WV.groundAt(w, prevX, prevZ), w.waterY) + 2.2;
      run.y = Math.max(run.y, backG);
      if (run.cd <= 0 && run.speed > 25) {
        run.cd = 0.5;
        WV.hit(run, Math.min(30, 4 + run.speed * 0.05), gy > w.waterY + 1 ? 'wall' : 'terrain');
        run.speed *= 0.7;
        run.pitch = Math.min(0.45, run.pitch + 0.22);
        /* one deflection per impact, toward whichever shoulder has open air.
         * Applied every frame it fought the stick and spun the craft in place. */
        var look = 14;
        var gl = WV.groundAt(w, run.x + Math.cos(run.yaw) * look, run.z - Math.sin(run.yaw) * look);
        var gr = WV.groundAt(w, run.x - Math.cos(run.yaw) * look, run.z + Math.sin(run.yaw) * look);
        run.yaw += (gl < gr ? 0.18 : -0.18);
      }
    }

    /* ---- gates */
    var gate = w.gates[run.nextGate];
    if (gate) {
      var dx = gate.x - run.x, dz = gate.z - run.z, dy = gate.y - run.y;
      if (dx * dx + dz * dz + dy * dy < WV.GATE_R * WV.GATE_R * 1.6) {
        run.gatesPassed[run.nextGate] = true;
        run.gates++;
        run.nextGate++;
        run.boost = Math.min(100, run.boost + 22);
        run.msgs.push({ text: '+' + (run.nextGate) + '/' + run.gatesTotal, at: run.t, good: true });
        if (run.nextGate >= w.gates.length) WV.finish(run, 'finished');
      }
    }

    /* ---- pirates: steer at the player, keep station behind, fire on cooldown */
    for (var p = 0; p < run.pirates.length; p++) {
      var pr = run.pirates[p];
      if (!pr.alive) continue;
      var pdx = run.x - pr.x, pdz = run.z - pr.z, pdy = run.y - pr.y;
      var dist = Math.sqrt(pdx * pdx + pdz * pdz + pdy * pdy) || 1;
      var want = Math.atan2(pdx, pdz);
      pr.yaw += WV.clamp(WV.wrap(want - pr.yaw), -1, 1) * dt * 1.05;
      var keep = 46;
      var pull = dist > keep ? 1 : -0.7;
      pr.speed = WV.lerp(pr.speed, run.speed * 0.94, dt * 0.8);
      pr.x += Math.sin(pr.yaw) * pr.speed * dt * pull;
      pr.z += Math.cos(pr.yaw) * pr.speed * dt * pull;
      pr.y = WV.lerp(pr.y, run.y + Math.sin(run.t * 0.7 + p) * 7, dt * 1.4);
      pr.cool -= dt;
      if (pr.cool <= 0 && dist < 190) {
        pr.cool = 1.15 + (p % 3) * 0.22;
        run.bolts.push({
          x: pr.x, y: pr.y, z: pr.z,
          vx: pdx / dist * 190, vy: pdy / dist * 190, vz: pdz / dist * 190,
          life: 3.2
        });
      }
    }

    /* ---- bolts */
    for (var b = run.bolts.length - 1; b >= 0; b--) {
      var bo = run.bolts[b];
      bo.x += bo.vx * dt; bo.y += bo.vy * dt; bo.z += bo.vz * dt;
      bo.life -= dt;
      var bx = bo.x - run.x, by = bo.y - run.y, bz = bo.z - run.z;
      if (bx * bx + by * by + bz * bz < 36) {
        WV.hit(run, 7, 'bolt');
        run.bolts.splice(b, 1);
        continue;
      }
      if (bo.life <= 0) run.bolts.splice(b, 1);
    }

    /* ---- trail for the renderer: short history, cheap to draw */
    run.trail.push({ x: run.x, y: run.y, z: run.z });
    if (run.trail.length > 26) run.trail.shift();

    if (run.hull <= 0) WV.finish(run, 'wrecked');
    if (run.t >= WV.TIME_CAP) WV.finish(run, 'finished');
    return run;
  };

  WV.hit = function (run, dmg, cause) {
    run.hull = Math.max(0, run.hull - dmg);
    run.damage += dmg;
    run.hits++;
    run.msgs.push({ text: cause === 'terrain' ? 'TERRAIN' : cause === 'wall' ? 'WALL' : 'HIT', at: run.t, bad: true });
    if (run.msgs.length > 6) run.msgs.shift();
  };

  WV.finish = function (run, phase) {
    if (run.phase !== 'flying') return run;
    run.phase = phase;
    run.speed = 0;
    run.boosting = false;
    return run;
  };

  /* Score: gates are the spine, time is the tax, damage is the fine. */
  WV.score = function (run) {
    var s = run.gates * 120 - Math.round(run.t * 1.6) - Math.round(run.damage * 2.2);
    if (run.phase === 'wrecked') s = Math.round(s * 0.35);
    return Math.max(0, s);
  };
})(window);
