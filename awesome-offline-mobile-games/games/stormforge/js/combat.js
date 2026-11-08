/* Stormforge — combat layer: Suroi's gun tables turned into playable weapons, bullets, hit
 * resolution, and the bot brain. No canvas, no DOM: main.js draws what this decides.
 *
 * Every number here comes from the vendored Suroi definitions (vendor/suroi/guns.json and
 * gear.json, parsed upstream by tools/vendor.py). Suroi measures range in "units" and bullet
 * speed in units/ms; PX_PER_UNIT scales those into this game's world pixels. */
(function (g) {
  'use strict';

  var C = {};

  var PX_PER_UNIT = 4.2;         // 130 Suroi units ≈ 546 world px of reach
  var PLAYER_SPEED = 205;        // px/s, sprint 285
  var BOT_SPEED = 178;
  var HEALTH_MAX = 100, SHIELD_MAX = 100;

  var TIER_RANK = { D: 0, C: 1, B: 2, A: 3, S: 4 };
  var TIER_COLOR = { D: '#b9c0cc', C: '#4ade80', B: '#38bdf8', A: '#a855f7', S: '#fbbf24' };

  /* ---------------------------------------------------------------- tables */

  var WEAPONS = [];
  var BY_ID = {};
  var AMMO_TYPES = {};
  var ARMOR = {};                // level -> damage reduction
  var HEALS = [];

  C.PX_PER_UNIT = PX_PER_UNIT;
  C.HEALTH_MAX = HEALTH_MAX;
  C.SHIELD_MAX = SHIELD_MAX;
  C.PLAYER_SPEED = PLAYER_SPEED;
  C.BOT_SPEED = BOT_SPEED;
  C.TIER_COLOR = TIER_COLOR;
  C.TIER_RANK = TIER_RANK;

  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

  C.loadTables = function (vdata) {
    var guns = (vdata && vdata['suroi/guns'] && vdata['suroi/guns'].guns) || [];
    WEAPONS = guns.map(function (d) {
      var range = num(d.range, 120) * PX_PER_UNIT;
      return {
        id: d.id,
        name: d.name || d.id,
        tier: TIER_RANK[d.tier] != null ? d.tier : 'D',
        rank: TIER_RANK[d.tier] != null ? TIER_RANK[d.tier] : 0,
        color: TIER_COLOR[d.tier] || TIER_COLOR.D,
        ammo: d.ammo || '9mm',
        damage: num(d.damage, 12),
        fireDelay: Math.max(40, num(d.fire_delay, 140)),
        reload: Math.max(0.6, num(d.reload, 2)),
        capacity: Math.max(1, Math.round(num(d.capacity, 12))),
        spread: num(d.spread, 4),
        moveSpread: num(d.move_spread, 8),
        recoil: num(d.recoil, 0.8),
        mode: (d.mode || 'Single'),
        bulletSpeed: Math.max(420, num(d.bullet_speed, 0.2) * 1000 * PX_PER_UNIT),
        range: range,
        ammoSpawn: Math.max(8, Math.round(num(d.ammo_spawn, 20))),
        icon: 'vendor/suroi/guns/' + d.id + '.png',
        world: 'vendor/suroi/guns/' + d.id + '_world.png'
      };
    });
    BY_ID = {};
    WEAPONS.forEach(function (w) { BY_ID[w.id] = w; });

    AMMO_TYPES = {};
    WEAPONS.forEach(function (w) { AMMO_TYPES[w.ammo] = true; });

    var gear = (vdata && vdata['suroi/gear']) || {};
    (gear.armors || []).forEach(function (a) {
      var key = a.type === 'helmet' ? 'helmet' : 'vest';
      ARMOR[key] = ARMOR[key] || {};
      ARMOR[key][Math.round(num(a.level, 1))] = num(a.reduction, 0.05);
    });
    HEALS = (gear.healing || []).map(function (h) {
      return {
        id: h.id,
        name: h.name || h.id,
        restore: num(h.restore, 20),
        useTime: Math.max(0.6, num(h.use_time, 3)),
        shield: (h.type || '').toLowerCase() === 'shield'
      };
    });
    if (!HEALS.length) {
      HEALS = [{ id: 'gauze', name: 'Gauze', restore: 20, useTime: 3, shield: false }];
    }
    return C;
  };

  C.weapons = function () { return WEAPONS; };
  C.weaponById = function (id) { return BY_ID[id] || null; };
  C.armorReduction = function (slot, level) {
    var t = ARMOR[slot];
    return (t && t[level]) || 0;
  };
  C.heals = function () { return HEALS; };

  /* Loot roll: Suroi's own tier spread, biased by how deep into the round we are. Loot that
   * drops early is mostly C/D; the gold tier is rare until the circle has closed a couple of
   * times, which is what makes a late S-tier find feel like a swing. */
  C.rollWeapon = function (rng, depth) {
    depth = depth || 0;                        // 0..1 through the match
    var pool = WEAPONS.filter(function (w) {
      var bias = w.rank / 4;
      if (bias < 0.25) return true;
      return rng() < 0.25 + bias * 0.55 + depth * 0.35;
    });
    if (!pool.length) pool = WEAPONS;
    return pool[Math.floor(rng() * pool.length) % pool.length];
  };

  C.rollArmor = function (rng, depth) {
    var level = 1 + Math.floor(rng() * (1 + (depth || 0) * 3));
    level = Math.min(4, level);
    return { slot: rng() < 0.5 ? 'helmet' : 'vest', level: level };
  };

  C.rollHeal = function (rng) {
    return HEALS[Math.floor(rng() * HEALS.length) % HEALS.length];
  };

  /* ---------------------------------------------------------------- actors */

  C.makeActor = function (opts) {
    return {
      id: opts.id,
      team: opts.team || 0,
      x: opts.x, y: opts.y,
      vx: 0, vy: 0,
      ang: opts.ang || 0,
      hp: HEALTH_MAX,
      shield: 0,
      helmet: 0, vest: 0,
      team: opts.team || 0,
      isPlayer: !!opts.isPlayer,
      name: opts.name || 'Bot',
      alive: true,
      weapons: [],            // two slots, weapon objects with runtime state clone
      slot: 0,
      ammo: {},               // ammo type -> rounds carried
      heals: [],
      healProgress: 0,
      reloading: 0,
      cooldown: 0,
      kills: 0,
      damage: 0,
      oreMined: 0,
      blocksBuilt: 0,
      lastHit: 0,
      hitFlash: 0,
      recoil: 0,
      sprint: false,
      running: 0,
      // brain
      role: opts.role || 'hunter',
      state: 'rotate',
      stateT: 0,
      targetId: 0,
      goal: null,
      seen: 0,
      buildT: 2 + (opts.brainDelay || 0)
    };
  };

  /* A weapon slot is the table entry plus per-actor ammo state. */
  C.equip = function (actor, slotIdx, weapon) {
    if (!weapon) return null;
    var inst = {
      w: weapon,
      mag: weapon.capacity,
      reloading: 0,
      cooldown: 0,
      recoil: 0
    };
    actor.weapons[slotIdx] = inst;
    if (!actor.weapons[actor.slot]) actor.slot = slotIdx;
    return inst;
  };

  C.current = function (actor) { return actor.weapons[actor.slot] || null; };

  C.aliveWeapons = function (actor) {
    return actor.weapons.filter(function (w) { return !!w; });
  };

  /* ---------------------------------------------------------------- bullets */

  C.spawnBullet = function (list, b) {
    if (list.length > 260) return null;
    var o = {
      x: b.x, y: b.y,
      ang: b.ang,
      speed: b.speed,
      damage: b.damage,
      travel: 0,
      range: b.range,
      owner: b.owner,
      team: b.team,
      color: b.color || '#ffd9a0',
      tracer: b.tracer !== false,
      width: b.width || 2
    };
    list.push(o);
    return o;
  };

  /* Steps bullets with a swept segment so a 900 px/s round cannot skip a 16 px body at 60 Hz.
   * `hit` gathers everything a bullet could stop on; main.js supplies it because only it knows
   * about walls, props, turret block health and the actor list. */
  C.stepBullets = function (list, dt, hit) {
    for (var i = list.length - 1; i >= 0; i--) {
      var b = list[i];
      var dist = b.speed * dt;
      var steps = Math.max(1, Math.ceil(dist / 12));
      var sd = dist / steps;
      var dx = Math.cos(b.ang) * sd, dy = Math.sin(b.ang) * sd;
      var dead = false;
      for (var s = 0; s < steps && !dead; s++) {
        b.x += dx; b.y += dy; b.travel += sd;
        var r = hit(b);
        if (r) dead = true;
        else if (b.travel >= b.range) dead = true;
      }
      if (dead) { list.splice(i, 1); }
    }
  };

  /* Bullet impact on a body: armour reduces by the upstream gear reduction for that slot. */
  C.applyHit = function (actor, amount, fromAng) {
    if (!actor || !actor.alive) return 0;
    var red = Math.max(C.armorReduction('vest', actor.vest || 0),
                       C.armorReduction('helmet', actor.helmet || 0));
    var dealt = amount * (1 - red);
    if (actor.shield > 0) {
      var s = Math.min(actor.shield, dealt);
      actor.shield -= s;
      dealt -= s;
    }
    actor.hp -= dealt;
    actor.lastHit = 0;
    actor.hitFlash = 0.16;
    if (fromAng != null) actor.lastHitAng = fromAng;
    if (actor.hp <= 0) { actor.hp = 0; actor.alive = false; }
    return dealt;
  };

  /* ---------------------------------------------------------------- shooting */

  /* Fires one round if the slot is ready. Returns the bullet spec or null. The caller owns the
   * bullet list, so bursts and pellets all come back through here. */
  C.fire = function (actor, rng, moving) {
    var inst = C.current(actor);
    if (!inst || inst.reloading > 0 || inst.cooldown > 0) return null;
    if (inst.mag <= 0) return null;
    var w = inst.w;
    var spread = (w.spread + (moving ? w.moveSpread : 0)) * Math.PI / 180;
    var ang = actor.ang + (rng() - 0.5) * spread;
    inst.mag--;
    inst.cooldown = w.fireDelay / 1000;
    inst.recoil = Math.min(1, inst.recoil + w.recoil * 0.55);
    actor.recoil = Math.min(1, actor.recoil + w.recoil * 0.4);
    return {
      x: actor.x + Math.cos(ang) * 16,
      y: actor.y + Math.sin(ang) * 14 - 4,
      ang: ang,
      speed: w.bulletSpeed,
      damage: w.damage,
      range: w.range,
      owner: actor.id,
      team: actor.team,
      color: w.rank >= 3 ? '#ffe6a3' : '#ffd9a0',
      width: w.rank >= 3 ? 2.6 : 1.8
    };
  };

  C.reload = function (actor) {
    var inst = C.current(actor);
    if (!inst || inst.reloading > 0 || inst.mag >= inst.w.capacity) return false;
    inst.reloading = inst.w.reload;
    return true;
  };

  C.stepWeapons = function (actor, dt) {
    for (var i = 0; i < actor.weapons.length; i++) {
      var inst = actor.weapons[i];
      if (!inst) continue;
      if (inst.cooldown > 0) inst.cooldown = Math.max(0, inst.cooldown - dt);
      inst.recoil = Math.max(0, inst.recoil - dt * 2.4);
      if (inst.reloading > 0) {
        inst.reloading -= dt;
        if (inst.reloading <= 0) {
          inst.reloading = 0;
          inst.mag = inst.w.capacity;
        }
      }
    }
    if (actor.recoil > 0) actor.recoil = Math.max(0, actor.recoil - dt * 3);
    if (actor.hitFlash > 0) actor.hitFlash = Math.max(0, actor.hitFlash - dt);
    if (actor.lastHit < 3) actor.lastHit += dt;
    if (actor.healProgress > 0) actor.healProgress = Math.max(0, actor.healProgress - dt);
  };

  C.giveAmmo = function (actor, type, n) {
    actor.ammo[type] = (actor.ammo[type] || 0) + n;
  };

  /* ---------------------------------------------------------------- bots */

  var ROLE_MIX = ['hunter', 'hunter', 'hunter', 'looter', 'engineer', 'camper'];

  /* One bot's decision for this frame. Pure logic: it sets bot.mvx/mvy, bot.ang, bot.wantsFire
   * and bot.wantsBuild, which main.js turns into movement, bullets and blocks. */
  C.botThink = function (bot, ctx, dt) {
    var world = ctx.world, sim = ctx.sim, rng = ctx.rng;
    bot.stateT += dt;
    bot.buildT -= dt;
    bot.mvx = 0; bot.mvy = 0;
    bot.wantsFire = false;
    bot.wantsBuild = null;

    var storm = world.stormAt(ctx.time);
    var safe = ctx.stormSafe;
    var dxp = storm.cx - bot.x, dyp = storm.cy - bot.y;
    var outside = Math.hypot(dxp, dyp) > storm.r - 40;

    // Find the nearest thing worth shooting. Bots see about 460 px and lose you behind cover.
    var best = null, bestD = 1e9;
    for (var i = 0; i < ctx.actors.length; i++) {
      var a = ctx.actors[i];
      if (!a.alive || a.team === bot.team) continue;
      var d = Math.hypot(a.x - bot.x, a.y - bot.y);
      if (d < bestD && d < 470) { bestD = d; best = a; }
    }

    var inst = C.current(bot);
    var needHeal = bot.hp < 45 && bot.heals.length > 0 && (!best || bestD > 220);

    if (needHeal) {
      bot.state = 'heal';
      bot.healProgress = 1.2;
      if (bot.hp < HEALTH_MAX) bot.hp = Math.min(HEALTH_MAX, bot.hp + 14 * dt);
      if (bot.hp >= 96) bot.heals.pop();
    } else if (outside) {
      bot.state = 'run';
      var a1 = Math.atan2(dyp, dxp);
      bot.mvx = Math.cos(a1); bot.mvy = Math.sin(a1);
    } else if (best && ctx.time > 6 && bot.seen > 0.3) {
      bot.state = 'fight';
      bot.ang = Math.atan2(best.y - bot.y, best.x - bot.x);
      bot.targetId = best.id;
      var keep = inst ? Math.min(inst.w.range * 0.7, 360) : 220;
      var stride = bestD > keep ? 1 : (bestD < keep * 0.55 ? -1 : 0);
      var strafe = Math.sin(ctx.time * 1.7 + bot.id) * 0.9;
      bot.mvx = Math.cos(bot.ang) * stride - Math.sin(bot.ang) * strafe;
      bot.mvy = Math.sin(bot.ang) * stride + Math.cos(bot.ang) * strafe;
      if (inst && inst.mag > 0 && inst.reloading <= 0) {
        var moving = Math.abs(bot.mvx) + Math.abs(bot.mvy) > 0.4;
        bot.wantsFire = C.botDuel(bot, best, rng) && bestD < inst.w.range * 1.05;
        bot.movingShot = moving;
      } else if (inst) {
        C.reload(bot);
      }
    } else {
      bot.state = 'rotate';
      // Wander toward the next circle and pick up whatever is on the way.
      var a2 = Math.atan2(dyp, dxp);
      var wob = Math.sin(ctx.time * 0.8 + bot.id * 2.3) * 0.6;
      bot.ang = a2 + wob;
      bot.mvx = Math.cos(bot.ang); bot.mvy = Math.sin(bot.ang);
      var loot = ctx.nearestLoot(bot.x, bot.y, 240);
      if (loot) {
        var al = Math.atan2(loot.y - bot.y, loot.x - bot.x);
        bot.mvx = Math.cos(al); bot.mvy = Math.sin(al);
        if (Math.hypot(loot.x - bot.x, loot.y - bot.y) < 22 && ctx.takeLoot) ctx.takeLoot(loot, bot);
      }
      if (bot.role === 'engineer' && bot.buildT <= 0 && sim && rng() < 0.55) {
        var plan = ctx.planBuild ? ctx.planBuild(bot) : null;
        if (plan) { bot.wantsBuild = plan; bot.buildT = 9; }
      }
    }

    // Engineering roles also drop a wall when someone is shooting them.
    if (bot.role === 'engineer' && best && C.botDuel(bot, best, rng) && bot.buildT <= 0 && sim &&
        Math.hypot(best.x - bot.x, best.y - bot.y) < 260) {
      ctx.enqueueBuild && ctx.enqueueBuild(bot, 'wall');
      bot.buildT = 7;
    }
  };

  /* Bots are not aimbots: they need a moment on target, and their accuracy tracks their tier
   * of weapon plus how long they have been looking at you. */
  C.botDuel = function (bot, target, rng) {
    var inst = C.current(bot);
    if (!inst || inst.mag <= 0) return false;
    // A bot that has had you in view for a moment shoots better; one that just turned the
    // corner usually misses, and distance matters more than anything else. Capped at 0.5 so a
    // whole squad cannot delete you in two frames.
    var d = target ? Math.hypot(target.x - bot.x, target.y - bot.y) : 400;
    var falloff = Math.max(0.22, Math.min(1, 1 - (d - 140) / 620));
    var acc = Math.min(0.5, 0.14 + (inst.w.rank / 4) * 0.2 + Math.min(0.14, bot.seen * 0.01)) * falloff;
    if (rng() > acc) return false;
    // Lead slightly, the way a decent player would.
    return true;
  };

  C.tickBotLook = function (bot, target, dt) {
    if (target) bot.seen = Math.min(60, bot.seen + dt * 6);
    else bot.seen = Math.max(0, bot.seen - dt * 3);
  };

  C.roles = ROLE_MIX;

  g.SF_COMBAT = C;

// Registers this module on the shared hook the collection's smoke test looks for; main.js
// replaces the hook with the live game object once everything is loaded.
window.__game = window.__game || {};

})(window);
