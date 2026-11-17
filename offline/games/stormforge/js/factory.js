/* Stormforge — the factory.
 * Classic script, IIFE, no modules, no network, runs from file://.
 *
 * This module owns the build economy and nothing else: drills pull ore out of the
 * ground, conveyors shuffle items one cell at a time, fabricators trade those items
 * for ammo and plates, turrets spend the ammo, walls soak damage. It draws no
 * pixels and touches no DOM — main.js reads the Maps and calls render itself.
 *
 * It also does not know about world.js. All it needs from the world is a grid
 * geometry (`cell`, `grid`) and the ore patches; the ore list is copied in at
 * make() time so depleting a patch here can never corrupt the world object the
 * rest of the game still reads (minimap, respawn checks, storm cover).
 *
 * Determinism is a hard requirement: the same build sequence plus the same dt
 * sequence must give the same stock, or a recorded playtest cannot be replayed.
 * So: no Math.random, no Date, no iteration over object keys, and every timer is
 * an accumulator fed by dt. Note that the *summary* is exact while the ordering
 * inside a tick is fixed by phase (mine, hand off, carry, fabricate, fire) and by
 * Map insertion order — build order is part of the replay.
 *
 * Item flow, in one line:
 *   ore cell -> drill buffer -> belt -> fabricator intake -> stock -> turret
 * Anything that runs out of room stalls upstream instead of dropping the item:
 * a full belt stops the drill, which is the pressure that makes layouts matter.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  /* ------------------------------------------------------------------ */
  /* tuning                                                              */
  /* ------------------------------------------------------------------ */
  /* These are the only numbers main.js's build wheel has to agree with, and it
     gets them from SF_FACTORY.KINDS rather than hard-coding a second copy. */
  var KINDS = {
    drill:      { cost: { copper: 15, titanium: 0 },  hp: 60,  solid: false, name: 'DRILL' },
    conveyor:   { cost: { copper: 3,  titanium: 0 },  hp: 40,  solid: false, name: 'BELT' },
    fabricator: { cost: { copper: 20, titanium: 5 },  hp: 90,  solid: false, name: 'FAB' },
    turret:     { cost: { copper: 25, titanium: 10 }, hp: 80,  solid: false, name: 'TURRET' },
    wall:       { cost: { copper: 8,  titanium: 0 },  hp: 200, solid: true,  name: 'WALL' }
  };
  // 0 up, 1 right, 2 down, 3 left — clockwise from north, so `dir` can be derived
  // from an angle with ((round(a / (PI/2)) % 4) + 4) % 4 without a lookup table.
  var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  var TUNE = {
    drillRate: 0.45,        // s per mined item — a drill is a slow faucet, not a hose
    drillBuffer: 4,         // mined items it can hold before it chokes
    beltStep: 0.22,         // s per cell of travel
    beltCap: 4,             // items visible on one belt tile
    fabRate: 0.5,           // s per craft
    fabIntake: 12,          // items a fabricator can hold (6 crafts' worth of each)
    turretFire: 0.55,       // s between shots
    turretDmg: 7,           // damage per shot
    turretRangeCells: 7,    // 7 cells ≈ 112 px at cell=16
    refund: 0.5             // half back on demolish, floored
  };

  var EPS = 1e-9;           // float tolerance for timer crossings

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */
  function key(gx, gy) { return gx + ',' + gy; }
  function normDir(d) {
    if (typeof d !== 'number' || !isFinite(d)) { return 1; }
    return ((d | 0) % 4 + 4) % 4;
  }
  function stockKey(type) {
    return (type === 'copper' || type === 'titanium' || type === 'coal') ? type : 'copper';
  }

  /* ------------------------------------------------------------------ */
  /* make                                                                */
  /* ------------------------------------------------------------------ */
  /* world is only read, never retained and never mutated: a world-like stub
     {cell, grid, ore} is enough to unit-test the whole economy in node. */
  function make(world) {
    world = world || {};
    var cell = world.cell > 0 ? world.cell : 16;
    var grid = world.grid > 0 ? world.grid : Math.max(1, Math.floor((world.size || 3000) / cell));

    var blocks = new Map();
    var ore = new Map();

    /* Copy the patches. The world may hand us an array of {gx,gy,x,y,type,amount}
       or an already-keyed Map; both are accepted so world.js can change its mind
       without breaking the economy. Zero-amount patches are dropped up front. */
    (function () {
      var src = world.ore;
      if (!src) { return; }
      if (typeof src.forEach === 'function' && typeof src.get === 'function') {
        src.forEach(function (o, k) {
          if (!o || !(o.amount > 0)) { return; }
          ore.set(k, { type: o.type || 'copper', amount: o.amount | 0 });
        });
      } else if (src.length) {
        for (var i = 0; i < src.length; i++) {
          var o = src[i];
          if (!o || !(o.amount > 0)) { continue; }
          ore.set(key(o.gx | 0, o.gy | 0), { type: o.type || 'copper', amount: o.amount | 0 });
        }
      }
    })();

    var stock = { copper: 40, titanium: 12, coal: 0, ammo: 0, plates: 0 };
    var stats = { oreMined: 0, itemsMoved: 0, shots: 0, firing: 0, built: 0, lost: 0 };
    var turretCount = 0;
    var time = 0;
    var tickId = 0;

    /* ------------------------------------------------------------------ */
    /* geometry                                                            */
    /* ------------------------------------------------------------------ */
    function inBounds(gx, gy) {
      return gx >= 0 && gy >= 0 && gx < grid && gy < grid;
    }

    /* main.js walks the player with this every frame, so walls are the only solid
       kind: belts, drills and fabricators must stay walkable or you could wall
       yourself into your own base. Turrets are stepped over too — a turret is a
       pole, not a barricade. */
    function solidAt(gx, gy) {
      var b = blocks.get(key(gx | 0, gy | 0));
      return !!(b && b.kind === 'wall');
    }

    function blockAt(gx, gy) {
      return blocks.get(key(gx | 0, gy | 0)) || null;
    }

    /* A drill may sit on the patch or on any of the four cells around it; the
       patch it feeds from is cached on the block so the hot loop is one Map hit. */
    function oreFor(b) {
      var k = key(b.gx, b.gy), o = ore.get(k);
      if (o && o.amount > 0) { b.oreKey = k; return o; }
      for (var i = 0; i < 4; i++) {
        var v = DIRS[i], k2 = key(b.gx + v[0], b.gy + v[1]), o2 = ore.get(k2);
        if (o2 && o2.amount > 0) { b.oreKey = k2; return o2; }
      }
      b.oreKey = null;
      return null;
    }

    /* ------------------------------------------------------------------ */
    /* placement                                                           */
    /* ------------------------------------------------------------------ */
    /* Reasons are reported in layout order (bounds, occupied, ground, ore) and
       affordability last, so the build-wheel ghost says why the *cell* is bad
       before it complains about your wallet. */
    function canPlace(kind, gx, gy, dir) {
      var def = KINDS[kind];
      var cost = def ? { copper: def.cost.copper, titanium: def.cost.titanium } : { copper: 0, titanium: 0 };
      gx = gx | 0; gy = gy | 0;
      if (!def) { return { ok: false, reason: 'unknown', cost: cost }; }
      if (!inBounds(gx, gy)) { return { ok: false, reason: 'bounds', cost: cost }; }
      if (blocks.has(key(gx, gy))) { return { ok: false, reason: 'occupied', cost: cost }; }

      /* Water and rock are the world's business — only consulted when the world
         actually exposes walkable(), which the node harness stub may not. */
      if (typeof world.walkable === 'function') {
        if (!world.walkable((gx + 0.5) * cell, (gy + 0.5) * cell)) {
          return { ok: false, reason: 'ground', cost: cost };
        }
      }

      if (kind === 'drill') {
        var hit = false;
        if (ore.get(key(gx, gy))) { hit = true; }
        if (!hit) {
          for (var i = 0; i < 4; i++) {
            var v = DIRS[i];
            if (ore.get(key(gx + v[0], gy + v[1]))) { hit = true; break; }
          }
        }
        if (!hit) { return { ok: false, reason: 'no-ore', cost: cost }; }
      }

      if (stock.copper < cost.copper || stock.titanium < cost.titanium) {
        return { ok: false, reason: 'cost', cost: cost };
      }
      return { ok: true, reason: '', cost: cost };
    }

    function mkBlock(kind, gx, gy, dir) {
      var def = KINDS[kind];
      var b = {
        kind: kind, gx: gx, gy: gy, dir: normDir(dir),
        hp: def.hp, maxHp: def.hp, t: 0
      };
      if (kind === 'drill') {
        b.buffer = []; b.oreKey = null; b.oreType = null; b.stalled = false;
      } else if (kind === 'conveyor') {
        b.items = [];
      } else if (kind === 'fabricator') {
        b.intake = { copper: 0, titanium: 0 }; b.made = 0; b.idle = true;
      } else if (kind === 'turret') {
        b.cd = TUNE.turretFire;   // armed, not pre-charged: first shot after one cooldown
        b.target = null; b.shots = 0; b.fired = -1;
      }
      return b;
    }

    function place(kind, gx, gy, dir) {
      var chk = canPlace(kind, gx, gy, dir);
      if (!chk.ok) { return { ok: false, reason: chk.reason }; }
      stock.copper -= chk.cost.copper;
      stock.titanium -= chk.cost.titanium;
      var b = mkBlock(kind, gx | 0, gy | 0, dir);
      blocks.set(key(b.gx, b.gy), b);
      if (kind === 'turret') { turretCount++; }
      stats.built++;
      return { ok: true, reason: '' };
    }

    function remove(gx, gy) {
      var k = key(gx | 0, gy | 0), b = blocks.get(k);
      if (!b) { return { ok: false, reason: 'empty' }; }
      var c = KINDS[b.kind].cost;
      stock.copper += Math.floor(c.copper * TUNE.refund);
      stock.titanium += Math.floor(c.titanium * TUNE.refund);
      blocks.delete(k);
      if (b.kind === 'turret') { turretCount--; }
      stats.lost++;
      return { ok: true, refund: { copper: Math.floor(c.copper * TUNE.refund), titanium: Math.floor(c.titanium * TUNE.refund) } };
    }

    /* Walls have hp and main.js breaks them (explosions, storm, bots). Kept out of
       the contract's core list because only this module knows block hp. */
    function damage(gx, gy, amount) {
      var k = key(gx | 0, gy | 0), b = blocks.get(k);
      if (!b) { return { ok: false, reason: 'empty', destroyed: false }; }
      b.hp -= (amount > 0 ? amount : 0);
      if (b.hp <= 0) {
        b.hp = 0;
        blocks.delete(k);
        if (b.kind === 'turret') { turretCount--; }
        stats.lost++;
        return { ok: true, destroyed: true };
      }
      return { ok: true, destroyed: false };
    }

    /* ------------------------------------------------------------------ */
    /* mining                                                              */
    /* ------------------------------------------------------------------ */
    function addStock(type, n) {
      stock[stockKey(type)] += n;
    }

    /* Hand mining: what the player gets for standing on a patch and holding fire.
       Same patch pick order as a drill (own cell first, then the four neighbours)
       so the prompt "MINE" never lies about which patch it will eat. */
    function mineAdjacent(gx, gy, amount) {
      gx = gx | 0; gy = gy | 0;
      amount = amount > 0 ? Math.floor(amount) : 1;
      var k = key(gx, gy), o = ore.get(k);
      if (!o) {
        for (var i = 0; i < 4; i++) {
          var v = DIRS[i], k2 = key(gx + v[0], gy + v[1]), o2 = ore.get(k2);
          if (o2 && o2.amount > 0) { k = k2; o = o2; break; }
        }
      }
      if (!o || !(o.amount > 0)) { return { ok: false, reason: 'no-ore', type: null, got: 0 }; }
      var got = o.amount < amount ? o.amount : amount;
      o.amount -= got;
      addStock(o.type, got);
      stats.oreMined += got;
      if (o.amount <= 0) { ore.delete(k); }
      return { ok: true, type: o.type, got: got };
    }

    /* ------------------------------------------------------------------ */
    /* tick phases                                                         */
    /* ------------------------------------------------------------------ */
    /* One mined item out of the patch. Depleted patches are deleted from the Map
       so the minimap and the build ghost both stop advertising them. */
    function mineOne(b) {
      var o = oreFor(b);
      if (!o) { b.stalled = true; return null; }
      o.amount -= 1;
      stats.oreMined += 1;
      b.oreType = o.type;
      if (o.amount <= 0) { ore.delete(b.oreKey); b.oreKey = null; }
      return o.type;
    }

    function intakeRoom(b, type) {
      var held = b.intake.copper + b.intake.titanium;
      return held < TUNE.fabIntake;
    }

    /* One cell forward, or into the stockpile when the belt runs off the end of
       the line. Returns false when the neighbour refuses, which is what stalls
       the belt (and, eventually, the drill behind it). */
    function pushForward(b, type) {
      var v = DIRS[b.dir];
      var nb = blocks.get(key(b.gx + v[0], b.gy + v[1]));
      if (!nb) { addStock(type, 1); return true; }
      if (nb.kind === 'conveyor') {
        if (nb.items.length < TUNE.beltCap) { nb.items.push({ type: type, at: tickId }); return true; }
        return false;
      }
      if (nb.kind === 'fabricator') {
        // Coal is not a recipe input yet — bounce it to the stockpile rather than
        // letting one loaded line jam a fabricator for the rest of the match.
        if (stockKey(type) === 'coal') { addStock(type, 1); return true; }
        if (intakeRoom(nb, type)) { nb.intake[type === 'titanium' ? 'titanium' : 'copper'] += 1; return true; }
        return false;
      }
      return false;
    }

    function tickDrills(dt) {
      blocks.forEach(function (b) {
        if (b.kind !== 'drill') { return; }
        // Produce first, then hand off: a drill with an empty buffer should not
        // wait a full cycle before its first item reaches the belt.
        if (b.buffer.length < TUNE.drillBuffer) {
          b.t += dt;
          while (b.t >= TUNE.drillRate && b.buffer.length < TUNE.drillBuffer) {
            var type = mineOne(b);
            if (!type) { b.t = 0; break; }
            b.buffer.push(type);
            b.t -= TUNE.drillRate;
          }
        }
        if (!b.buffer.length) { return; }
        var v = DIRS[b.dir];
        var nb = blocks.get(key(b.gx + v[0], b.gy + v[1]));
        var head = b.buffer[0];
        if (!nb) {
          // Nothing in front: the ore simply lands in the stockpile, which is how
          // a bare drill works on the first ten seconds of a match.
          b.buffer.shift();
          addStock(head, 1);
        } else if (nb.kind === 'conveyor') {
          if (nb.items.length < TUNE.beltCap) {
            b.buffer.shift();
            nb.items.push({ type: head, at: tickId });
            stats.itemsMoved++;
          }
        } else if (nb.kind === 'fabricator') {
          if (intakeRoom(nb, head)) {
            b.buffer.shift();
            nb.intake[stockKey(head) === 'titanium' ? 'titanium' : 'copper'] += 1;
            stats.itemsMoved++;
          }
        }
      });
    }

    function tickBelts(dt) {
      blocks.forEach(function (b) {
        if (b.kind !== 'conveyor' || !b.items.length) { return; }
        b.t += dt;
        if (b.t < TUNE.beltStep) { return; }
        var it = b.items[0];
        // Items that arrived during this same tick get one step of rest. Without
        // this an item could ride a whole freshly-built chain in a single frame.
        // One cell per tick, never a cascade: a long frame must not warp goods.
        if (!it || it.at === tickId) { b.t = TUNE.beltStep; return; }
        if (!pushForward(b, it.type)) { b.t = TUNE.beltStep; return; }
        b.items.shift();
        stats.itemsMoved++;
        b.t -= TUNE.beltStep;
        if (b.t > TUNE.beltStep) { b.t = TUNE.beltStep; }
      });
    }

    function tickFabs(dt) {
      blocks.forEach(function (b) {
        if (b.kind !== 'fabricator') { return; }
        b.t += dt;
        while (b.t >= TUNE.fabRate) {
          if (b.intake.copper >= 2) {
            b.intake.copper -= 2; stock.ammo += 1; b.made++; b.idle = false;
          } else if (b.intake.titanium >= 2) {
            b.intake.titanium -= 2; stock.plates += 1; b.made++; b.idle = false;
          } else {
            // Starved: drop the partial cycle. Banking half a craft would let a
            // trickle of ore fire a burst of ammo the instant a second item lands.
            b.t = 0; b.idle = true; break;
          }
          b.t -= TUNE.fabRate;
        }
      });
    }

    /* Nearest live enemy inside range; ties go to whoever comes first in the
       caller's array, so the same enemy list always yields the same target.
       The player is never a target, and neither is a corpse still in the list. */
    function pickTarget(b, enemies) {
      if (!enemies || !enemies.length) { return null; }
      var tx = (b.gx + 0.5) * cell, ty = (b.gy + 0.5) * cell;
      var r2 = (TUNE.turretRangeCells * cell) * (TUNE.turretRangeCells * cell);
      var best = null, bestD = r2 + 1;
      for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (!e || e.isPlayer || !(e.hp > 0)) { continue; }
        var dx = e.x - tx, dy = e.y - ty, d = dx * dx + dy * dy;
        if (d <= r2 && d < bestD) { bestD = d; best = e; }
      }
      return best;
    }

    function tickTurrets(dt, ctx) {
      var enemies = ctx && ctx.enemies;
      var onHit = ctx && ctx.onTurretHit;
      blocks.forEach(function (b) {
        if (b.kind !== 'turret') { return; }
        b.target = pickTarget(b, enemies);
        b.cd -= dt;
        if (b.cd < 0) { b.cd = 0; }
        if (b.cd > EPS) { return; }
        if (!b.target || stock.ammo < 1) { return; }   // held at ready; fires on resupply
        var guard = 0;
        while (b.cd <= EPS && guard++ < 8) {
          if (!b.target || stock.ammo < 1) { b.cd = 0; break; }
          b.cd += TUNE.turretFire;
          stock.ammo -= 1;
          b.shots++;
          stats.shots++;
          if (b.fired !== tickId) { b.fired = tickId; stats.firing++; }
          if (typeof onHit === 'function') { onHit(b.target, TUNE.turretDmg); }
        }
      });
    }

    function tick(dt, ctx) {
      if (!(dt > 0)) { return; }
      time += dt;
      tickId++;
      stats.firing = 0;
      tickDrills(dt);
      tickBelts(dt);
      tickFabs(dt);
      tickTurrets(dt, ctx);
    }

    /* ------------------------------------------------------------------ */
    /* HUD reads                                                           */
    /* ------------------------------------------------------------------ */
    /* Rebuilt per call rather than cached: the HUD asks once a frame and a dozen
       small objects is cheaper than invalidating a cache on every place/remove.
       `ammo` is the shared stockpile (there is one magazine for the whole base),
       repeated per turret so a HUD can ring each one without a second lookup. */
    function turrets() {
      var out = [];
      blocks.forEach(function (b) {
        if (b.kind !== 'turret') { return; }
        out.push({
          gx: b.gx, gy: b.gy, dir: b.dir,
          x: (b.gx + 0.5) * cell, y: (b.gy + 0.5) * cell,
          hp: b.hp, maxHp: b.maxHp,
          cd: b.cd, ready: b.cd <= EPS,
          ammo: stock.ammo, target: b.target, shots: b.shots,
          range: TUNE.turretRangeCells * cell
        });
      });
      return out;
    }

    function state() {
      return {
        blocks: blocks.size,
        oreMined: stats.oreMined,
        itemsMoved: stats.itemsMoved,
        ammo: stock.ammo,
        plates: stock.plates,
        turrets: turretCount,
        firing: stats.firing
      };
    }

    var api = {
      cell: cell, grid: grid,
      blocks: blocks, ore: ore, stock: stock, stats: stats,
      canPlace: canPlace, place: place, remove: remove, damage: damage,
      mineAdjacent: mineAdjacent, tick: tick,
      turrets: turrets, state: state,
      solidAt: solidAt, blockAt: blockAt,
      dirVec: function (d) { var v = DIRS[normDir(d)]; return { x: v[0], y: v[1] }; }
    };
    // sim.time must read live, so it is a getter rather than a copy of the closure
    // variable that would freeze at zero the moment make() returned.
    Object.defineProperty(api, 'time', { get: function () { return time; }, enumerable: true });
    return api;
  }

  window.SF_FACTORY = { make: make, KINDS: KINDS, DIRS: DIRS, TUNE: TUNE };
})();

// Registers this module on the shared hook the collection's smoke test looks for; main.js
// replaces the hook with the live game object once everything is loaded.
window.__game = window.__game || {};
