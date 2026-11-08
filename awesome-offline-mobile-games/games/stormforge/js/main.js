/* Stormforge — the game. Third-person 3D battle royale on a single island, where Fortnite's
 * instant build is replaced by a factory you mine, belt and arm yourself.
 *
 * Phases: 'drop' (map + bus line) → 'sky' (skydive) → 'ground' → 'over'.
 * Three.js draws the island, the people, the storm and the factory; a 2D canvas on top draws
 * the HUD. Game state lives here and nowhere else.
 */
(function (g) {

  /* Suroi names its armour art by grade, not by level number: basic 1, regular 2,
   * tactical 3, power 4. The parsed table only carries the level, so map it here once. */
  function armorIcon(slot, level) {
    var grades = ['basic', 'regular', 'tactical', 'power'];
    var g2 = grades[Math.max(0, Math.min(3, (level | 0) - 1))];
    return 'vendor/suroi/loot/' + g2 + '_' + (slot === 'helmet' ? 'helmet' : 'vest') + '.png';
  }

  'use strict';

  var VENDOR = g.AOMG_VENDOR || { assets: [], data: {} };
  var SFW = g.SF_WORLD, SFF = g.SF_FACTORY, CMB = g.SF_COMBAT, SC = g.SF_SCENE, RND = g.SF_RENDER, GK = g.GK;

  if (!SC || !SFW || !SFF) {
    document.body.innerHTML = '<pre style="color:#e6edf7;font:13px monospace;padding:24px">Stormforge could not start: a module failed to load.</pre>';
    return;
  }

  var canvas = document.getElementById('game');
  var hud = document.getElementById('hud');
  var hctx = hud.getContext('2d');
  var bootEl = document.getElementById('boot');
  var bootBar = document.getElementById('bootbar');

  var TAU = Math.PI * 2;
  var clamp = GK.clamp, lerp = GK.lerp;

  var G = {
    phase: 'drop',
    t: 0,
    seed: 0,
    world: null,
    sim: null,
    view: { yaw: 0, pitch: 0.22, yawT: 0, pitchT: 0.22 },
    actors: [],
    player: null,
    bullets: [],
    loot: [],
    parts: [],
    dmg: [],
    feed: [],
    contacts: [],
    storm: { cx: 0, cy: 0, r: 0, phase: 0 },
    stormNext: -1,
    matchT: 0,
    alive: 32,
    won: false,
    place: 0,
    kills: 0,
    damageDealt: 0,
    picked: 0,
    playerFired: false,
    buildOpen: false,
    buildKind: 'drill',
    move: { id: -1, x: 0, y: 0, ox: 0, oy: 0, active: false, sprint: false },
    look: { id: -1, ox: 0, oy: 0, active: false, moved: 0 },
    keys: {},
    tapFire: 0,
    dropHint: 'TAP THE MAP TO DROP',
    dropPick: null,
    stats: [],
    fps: 60,
    fall: 0
  };

  var BUILD_KINDS = [
    { kind: 'drill', label: 'DRILL' },
    { kind: 'conveyor', label: 'BELT' },
    { kind: 'fabricator', label: 'SMELT' },
    { kind: 'turret', label: 'TURRET' },
    { kind: 'wall', label: 'WALL' }
  ];
  // Costs come from the simulation, not from a second copy: the build wheel shows a price and
  // the factory charges it, and they cannot drift apart because they are the same table.
  var BUILD_COST = {};
  (function () {
    var kinds = (g.SF_FACTORY && g.SF_FACTORY.KINDS) || {};
    for (var k in kinds) if (kinds.hasOwnProperty(k)) BUILD_COST[k] = kinds[k].cost;
  })();

  var view = { w: 390, h: 844 };
  var V = null;
  var ghost = null;

  /* ------------------------------------------------------------------ audio */

  var AUD = (function () {
    var pool = {}, live = 0, MAX = 7;
    function el(path) {
      if (!pool[path]) {
        var a = new Audio();
        a.src = '../../' + path;
        a.preload = 'auto';
        a.volume = 0.5;
        pool[path] = a;
      }
      return pool[path];
    }
    return {
      play: function (path, vol, rate) {
        if (live > MAX || !path) return;
        try {
          var src = el(path);
          var node = src.cloneNode ? src.cloneNode() : src;
          node.volume = clamp(vol == null ? 0.5 : vol, 0, 1);
          if (rate && node.playbackRate) node.playbackRate = rate;
          live++;
          node.onended = function () { live--; };
          var p = node.play();
          if (p && p.catch) p.catch(function () { live--; });
        } catch (e) { /* a dead mixer must never break the frame */ }
      },
      gun: function (id, vol) { this.play('vendor/suroi/sfx/' + id + '_fire.opus', vol == null ? 0.2 : vol); },
      reload: function (id) { this.play('vendor/suroi/sfx/' + id + '_reload.opus', 0.26); },
      pickup: function () { this.play('vendor/suroi/sfx/pickup_item.opus', 0.35); },
      music: function (play) {
        var m = el('vendor/suroi/audio/menu_music.opus');
        m.loop = true; m.volume = 0.2;
        if (play) { var p = m.play(); if (p && p.catch) p.catch(function () {}); }
        else { try { m.pause(); } catch (e) {} }
      }
    };
  })();

  /* ------------------------------------------------------------------ utils */

  function rnd() { return G.world ? G.world.rng() : Math.random(); }
  function burst(x, y, n, color, spd, life) {
    for (var i = 0; i < n; i++) {
      if (G.parts.length > 260) return;
      var a = rnd() * TAU, s = spd * (0.35 + rnd() * 0.9);
      G.parts.push({ x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: life || 0.5, max: life || 0.5 });
    }
  }
  function damageText(x, y, amount, crit) {
    if (G.dmg.length > 30) return;
    G.dmg.push({ x: x, y: y, v: Math.round(amount), life: 0.8, crit: !!crit });
  }
  function feedSay(a, v, me) {
    G.feed.unshift({ a: a, v: v, me: me, life: 6 });
    if (G.feed.length > 4) G.feed.pop();
  }

  /* ------------------------------------------------------------------ run */

  function startRun(seed) {
    G.seed = seed >>> 0;
    // 1,500 props: a Fortnite-shaped island needs forest belts you can lose a squad in, not a
    // golf course with nine houses on it
    G.world = SFW.make(G.seed, { size: 3000, cell: 16, pois: 9, ore: 130, props: 1500 });
    G.sim = SFF.make(G.world);
    CMB.loadTables(VENDOR.data);

    V = SC.create(canvas, G.world);
    G.__V = V;
    SC.resize(V, view.w, view.h);

    G.actors.length = 0;
    G.bullets.length = 0;
    G.loot.length = 0;
    G.parts.length = 0;
    G.dmg.length = 0;
    G.feed.length = 0;
    G.contacts.length = 0;
    G.matchT = 0;
    G.kills = 0;
    G.damageDealt = 0;
    G.picked = 0;
    G.playerFired = false;
    G.won = false;
    G.place = 0;
    G.buildOpen = false;
    G.fall = 0;

    var p = CMB.makeActor({ id: 1, x: G.world.size / 2, y: G.world.size / 2, isPlayer: true, name: 'YOU', team: 0 });
    G.player = p;
    G.actors.push(p);

    var starter = CMB.weaponById('g19');
    if (starter) { CMB.equip(p, 0, starter); CMB.giveAmmo(p, starter.ammo, starter.capacity * 3); }
    for (var sh = 0; sh < 2; sh++) p.heals.push(CMB.rollHeal(rnd));
    p.vest = 1;                       // everyone lands with a basic vest; tier up by looting

    var names = ['Vex', 'Rook', 'Sable', 'Kilo', 'Nova', 'Hatch', 'Pike', 'Bram', 'Wren', 'Tess',
                 'Kade', 'Onyx', 'Vale', 'Juno', 'Rhys', 'Mace', 'Dune', 'Ash', 'Cove', 'Fenn',
                 'Grit', 'Hale', 'Iris', 'Jett', 'Kestrel', 'Lark', 'Moss', 'Nix', 'Orin', 'Pax', 'Quill'];
    var spawns = G.world.spawnPoints(31);
    for (var i = 0; i < 31; i++) {
      var sp = spawns[i] || { x: 200 + i * 80, y: 200 };
      var bot = CMB.makeActor({
        id: 100 + i, x: sp.x, y: sp.y, team: 1 + (i % 4),
        name: names[i % names.length],
        role: CMB.roles[i % CMB.roles.length],
        brainDelay: i * 0.05
      });
      var w1 = CMB.rollWeapon(rnd, 0.15);
      CMB.equip(bot, 0, w1);
      CMB.giveAmmo(bot, w1.ammo, w1.capacity * 3);
      if (rnd() < 0.5) {
        var w2 = CMB.rollWeapon(rnd, 0.2);
        CMB.equip(bot, 1, w2);
        CMB.giveAmmo(bot, w2.ammo, w2.capacity * 2);
      }
      var arm = CMB.rollArmor(rnd, 0.3);
      bot[arm.slot === 'helmet' ? 'helmet' : 'vest'] = arm.level;
      for (var h = 0; h < 2; h++) bot.heals.push(CMB.rollHeal(rnd));
      G.actors.push(bot);
    }

    seedLoot();
    G.alive = G.actors.length;
    G.storm = G.world.stormAt(0);
    G.phase = 'drop';
    G.t = 0;
    G.dropPick = null;
    G.view.yaw = G.view.yawT = 0;

    if (bootEl && bootEl.parentNode) {
      if (bootBar) bootBar.style.width = '100%';
      bootEl.classList.add('hide');
      setTimeout(function () { if (bootEl && bootEl.parentNode) bootEl.parentNode.removeChild(bootEl); }, 500);
    }
  }

  function seedLoot() {
    var w = G.world;
    for (var i = 0; i < w.pois.length; i++) {
      var p = w.pois[i];
      var n = 5 + Math.floor(rnd() * 4);
      for (var k = 0; k < n; k++) {
        var lx = p.cx + (rnd() - 0.5) * p.w * 0.8;
        var ly = p.cy + (rnd() - 0.5) * p.h * 0.8;
        if (!w.walkable(lx, ly)) continue;
        var roll = rnd();
        if (roll < 0.46) {
          var wep = CMB.rollWeapon(rnd, 0);
          G.loot.push({ x: lx, y: ly, kind: 'gun', w: wep, tier: wep.rank, color: wep.color });
        } else if (roll < 0.66) {
          var arm = CMB.rollArmor(rnd, 0);
          G.loot.push({ x: lx, y: ly, kind: 'armor', slot: arm.slot, level: arm.level, color: '#cbd5e1' });
        } else if (roll < 0.86) {
          G.loot.push({ x: lx, y: ly, kind: 'heal', heal: CMB.rollHeal(rnd), color: '#4ade80' });
        } else {
          var anyW = CMB.weapons();
          G.loot.push({ x: lx, y: ly, kind: 'ammo', ammo: anyW[Math.floor(rnd() * anyW.length) % anyW.length], color: '#fbbf24' });
        }
      }
    }
  }

  function stormCountdown(t) {
    var ladder = (G.world && G.world.storm) || [];
    var acc = 0;
    for (var i = 0; i < ladder.length; i++) {
      var hold = ladder[i].wait || 0, shrink = ladder[i].shrink || 0;
      if (t < acc + hold) return { phase: i, next: acc + hold - t, shrinking: false };
      acc += hold;
      if (t < acc + shrink) return { phase: i, next: 0, shrinking: true };
      acc += shrink;
    }
    return { phase: Math.max(0, ladder.length - 1), next: -1, shrinking: false };
  }

  function stormTick(dt) {
    var s = G.world.stormAt(G.matchT);
    G.storm = s;
    G.stormNext = stormCountdown(G.matchT).next;
    if (G.phase !== 'ground') return;

    var p = G.player;
    if (Math.hypot(p.x - s.cx, p.y - s.cy) > s.r) {
      p.stormAcc = (p.stormAcc || 0) + dt;
      if (p.stormAcc >= 1) {
        p.stormAcc -= 1;
        var dmg = 2 + s.phase * 2.2;
        CMB.applyHit(p, dmg, null);
        damageText(p.x, p.y, dmg, false);
        if (!p.alive) playerDown();
      }
    }
    for (var i = 1; i < G.actors.length; i++) {
      var b = G.actors[i];
      if (!b.alive) continue;
      if (Math.hypot(b.x - s.cx, b.y - s.cy) > s.r) {
        b.stormAcc = (b.stormAcc || 0) + dt;
        if (b.stormAcc >= 1.4) { b.stormAcc = 0; CMB.applyHit(b, 3 + s.phase * 1.6, null); if (!b.alive) botDown(b, null); }
      }
    }
  }

  /* ------------------------------------------------------------------ combat */

  function resolveHits(b) {
    if (G.sim && G.sim.solidAt) {
      var gx = Math.floor(b.x / G.sim.cell), gy = Math.floor(b.y / G.sim.cell);
      if (G.sim.solidAt(gx, gy)) {
        var blk = G.sim.blocks.get(gx + ',' + gy);
        if (blk && blk.kind === 'wall') {
          blk.hp = (blk.hp || 100) - b.damage;
          burst(b.x, b.y, 3, '#cbd5e1', 60, 0.3);
          if (blk.hp <= 0) { G.sim.remove(gx, gy); burst(b.x, b.y, 8, '#94a3b8', 90, 0.5); }
        }
        return true;
      }
    }
    var wp = G.world.propAt && G.world.propAt(b.x, b.y);
    if (wp && wp.solid) { burst(b.x, b.y, 3, '#8a7f6a', 50, 0.3); return true; }

    for (var i = 0; i < G.actors.length; i++) {
      var a = G.actors[i];
      if (!a.alive || a.id === b.owner || a.team === b.team) continue;
      var dx = a.x - b.x, dy = a.y - b.y;
      if (dx * dx + dy * dy > 16 * 16) continue;
      // The opening grace has to cover stray crossfire as well as being ignored as a target:
      // 31 bots spraying at each other was killing a fresh drop before it could move.
      if (a.isPlayer && (a.immune > 0 || (G.matchT < 20 && !G.playerFired))) {
        burst(b.x, b.y, 3, '#7fe3ff', 60, 0.3);
        return true;
      }
      // capped per hit: the vendored guns top out near 60 damage, which at any honest multiplier
      // deleted an unarmoured player in 1.5 s of one bot's fire
      var dmg = a.isPlayer ? Math.min(9, b.damage * 0.26) : b.damage;
      var dealt = CMB.applyHit(a, dmg, b.ang + Math.PI);
      if (b.owner === G.player.id) {
        G.damageDealt += dealt;
        damageText(a.x, a.y, dealt, b.damage > 30);
      }
      burst(b.x, b.y, 4, '#c0392b', 70, 0.35);
      if (!a.alive) { if (a.isPlayer) playerDown(); else botDown(a, b.owner); }
      return true;
    }
    return false;
  }

  function botDown(bot, killerId) {
    if (bot.__counted) return;
    bot.__counted = true;
    bot.alive = false;
    burst(bot.x, bot.y, 16, '#8e2f2f', 110, 0.7);
    var inst = CMB.current(bot);
    if (inst) G.loot.push({ x: bot.x, y: bot.y, kind: 'gun', w: inst.w, tier: inst.w.rank, color: inst.w.color });
    if (bot.heals.length) G.loot.push({ x: bot.x + 10, y: bot.y, kind: 'heal', heal: bot.heals[0], color: '#4ade80' });
    var killer = 'STORM';
    if (killerId === G.player.id) killer = 'YOU';
    else for (var i = 0; i < G.actors.length; i++) if (G.actors[i].id === killerId) { killer = G.actors[i].name; break; }
    feedSay(killer, bot.name, killerId === G.player.id);
    if (killerId === G.player.id) { G.kills++; GK.buzz(22); }
  }

  function playerDown() {
    G.player.alive = false;
    G.place = Math.max(2, G.alive);
    burst(G.player.x, G.player.y, 22, '#8e2f2f', 120, 0.9);
    endRun(false);
  }

  function endRun(won) {
    if (G.phase === 'over') return;
    G.won = won;
    G.phase = 'over';
    AUD.music(false);
    try { GK.sfx[won ? 'win' : 'lose'](); } catch (e) {}
    G.stats = [
      ['ELIMINATIONS', G.kills],
      ['DAMAGE', Math.round(G.damageDealt)],
      ['ORE MINED', Math.round(G.sim ? G.sim.state().oreMined : 0)],
      ['BLOCKS BUILT', G.sim ? G.sim.state().blocks : 0],
      ['LOOT TAKEN', G.picked],
      ['SURVIVED', GK.fmtTime(G.matchT)]
    ];
  }

  /* ------------------------------------------------------------------ player */

  function aimAngle() { return Math.PI / 2 - G.view.yaw; }

  function playerTick(dt) {
    var p = G.player;
    if (!p.alive) return;
    CMB.stepWeapons(p, dt);
    p.ang = aimAngle();

    var mx = G.move.x, my = G.move.y;
    if (G.keys.a) mx -= 1; if (G.keys.d) mx += 1;
    if (G.keys.w) my -= 1; if (G.keys.s) my += 1;
    var ml = Math.hypot(mx, my);
    if (ml > 1) { mx /= ml; my /= ml; }

    var yaw = G.view.yaw;
    var fx = Math.sin(yaw), fz = Math.cos(yaw);
    var rx = Math.cos(yaw), rz = -Math.sin(yaw);
    var wx = fx * (-my) + rx * mx;
    var wz = fz * (-my) + rz * mx;
    var speed = CMB.PLAYER_SPEED * (G.move.sprint ? 1.35 : 1);
    p.moving = Math.hypot(wx, wz) > 0.12;

    var nx = p.x + wx * speed * dt;
    var ny = p.y + wz * speed * dt;
    if (canStand(nx, p.y)) p.x = nx;
    if (canStand(p.x, ny)) p.y = ny;

    if (p.jumpT > 0) {
      p.jumpT -= dt;
      p.yOff = Math.sin(Math.max(0, p.jumpT) / 0.55 * Math.PI) * 1.6;
      if (p.jumpT <= 0) p.yOff = 0;
    }

    var firing = (G.look.active && G.look.moved < 12) || G.tapFire > 0 || G.keys[' '];
    if (G.tapFire > 0) G.tapFire -= dt;
    if (firing && !G.buildOpen) tryFire(p);
    autoPickup();
    handMine(dt);
  }

  function tryFire(p) {
    var inst = CMB.current(p);
    if (!inst) return;
    if (inst.mag <= 0) { if (inst.reloading <= 0 && refill(p)) CMB.reload(p); return; }
    var b = CMB.fire(p, rnd, p.moving);
    if (!b) return;
    if (!G.playerFired) {
      // Your first shot is what puts you on the island's map. Give the shooter four seconds of
      // armour while the bots turn, otherwise one trigger pull deletes you at 8 seconds.
      G.player.immune = Math.max(G.player.immune || 0, 4);
    }
    G.playerFired = true;
    CMB.spawnBullet(G.bullets, b);
    p.muzzle = 1;
    AUD.gun(inst.w.id, 0.22);
    if (inst.mag === 0 && refill(p)) CMB.reload(p);
  }

  function refill(p) {
    var inst = CMB.current(p);
    if (!inst) return false;
    var have = p.ammo[inst.w.ammo] || 0;
    if (have <= 0) return false;
    p.ammo[inst.w.ammo] = have - inst.w.capacity;
    inst.mag = 0;
    AUD.reload(inst.w.id);
    return true;
  }

  function canStand(x, y) {
    if (x < 16 || y < 16 || x > G.world.size - 16 || y > G.world.size - 16) return false;
    if (G.world.walkable && !G.world.walkable(x, y)) return false;
    var wp = G.world.propAt && G.world.propAt(x, y);
    if (wp && wp.solid && wp.r > 10) return false;
    if (G.sim && G.sim.solidAt) {
      var gx = Math.floor(x / G.sim.cell), gy = Math.floor(y / G.sim.cell);
      if (G.sim.solidAt(gx, gy)) return false;
    }
    return true;
  }

  function autoPickup() {
    var p = G.player;
    for (var i = G.loot.length - 1; i >= 0; i--) {
      var o = G.loot[i];
      if (Math.hypot(o.x - p.x, o.y - p.y) > 34) continue;
      if (o.kind === 'gun') {
        var cur = CMB.current(p);
        if (cur && cur.w.rank >= (o.w ? o.w.rank : 0) && CMB.aliveWeapons(p).length >= 2) continue;
        takeGun(o);
      } else if (o.kind === 'armor') {
        var slot = o.slot === 'helmet' ? 'helmet' : 'vest';
        if (p[slot] >= o.level) continue;
        p[slot] = o.level; G.picked++; AUD.pickup();
      } else if (o.kind === 'heal') {
        if (p.heals.length >= 5) continue;
        p.heals.push(o.heal); G.picked++; AUD.pickup();
      } else if (o.kind === 'ammo') {
        CMB.giveAmmo(p, o.ammo.ammo, o.ammo.ammoSpawn); G.picked++; AUD.pickup();
      }
      G.loot.splice(i, 1);
    }
  }

  function takeGun(o) {
    var p = G.player;
    var free = p.weapons.length < 2 ? p.weapons.length : -1;
    if (free < 0) {
      var a = p.weapons[0], b = p.weapons[1];
      var weaker = (a && b) ? (a.w.rank <= b.w.rank ? 0 : 1) : (a ? 0 : 1);
      p.weapons[weaker] = null;
      free = weaker;
    }
    CMB.equip(p, free, o.w);
    CMB.giveAmmo(p, o.w.ammo, o.w.ammoSpawn);
    G.picked++;
    AUD.pickup();
  }

  function handMine(dt) {
    var p = G.player, sim = G.sim;
    if (!sim || !sim.ore) return;
    var gx = Math.floor(p.x / sim.cell), gy = Math.floor(p.y / sim.cell);
    var patch = sim.ore.get(gx + ',' + gy);
    if (!patch || patch.amount <= 0) { p.mineT = 0; return; }
    p.mineT = (p.mineT || 0) + dt;
    if (p.mineT > 0.55) {
      p.mineT = 0;
      var got = sim.mineAdjacent(gx, gy, 1);
      if (got && got.ok) { burst(p.x, p.y + 8, 2, '#e08a4d', 40, 0.3); GK.buzz(5); }
    }
  }

  /* ------------------------------------------------------------------ bots */

  function botsTick(dt) {
    var ctx = {
      world: G.world, sim: G.sim, actors: G.actors, time: G.matchT, rng: rnd, stormSafe: true,
      nearestLoot: function (x, y, r) {
        var best = null, bd = r * r;
        for (var i = 0; i < G.loot.length; i++) {
          var o = G.loot[i];
          if (o.kind === 'ammo') continue;
          var d = (o.x - x) * (o.x - x) + (o.y - y) * (o.y - y);
          if (d < bd) { bd = d; best = o; }
        }
        return best;
      },
      takeLoot: function (o, bot) {
        var idx = G.loot.indexOf(o);
        if (idx >= 0) G.loot.splice(idx, 1);
        if (o.kind === 'gun' && o.w) {
          var free = bot.weapons.length < 2 ? bot.weapons.length : 0;
          CMB.equip(bot, free, o.w);
          CMB.giveAmmo(bot, o.w.ammo, o.w.ammoSpawn);
        } else if (o.kind === 'heal') bot.heals.push(o.heal);
        else if (o.kind === 'armor') bot[o.slot === 'helmet' ? 'helmet' : 'vest'] = o.level;
      },
      planBuild: function (bot) { return planBotBuild(bot); },
      enqueueBuild: function (bot, kind) { planBotBuild(bot, kind); }
    };

    // A squad hunting you is fair; the whole island hunting you is not. Only bots close enough
    // to have heard the shot, and at most three of them, may break off to fight the player.
    G.hunters = 0;
    for (var i = 1; i < G.actors.length; i++) {
      var b = G.actors[i];
      if (!b.alive) continue;
      CMB.stepWeapons(b, dt);
      var target = null, bd = 1e9;
      for (var k = 0; k < G.actors.length; k++) {
        var a2 = G.actors[k];
        if (!a2.alive || a2.team === b.team) continue;
        var d2 = Math.hypot(a2.x - b.x, a2.y - b.y);
        if (a2.isPlayer) {
          if (G.matchT < 20 && !G.playerFired) continue;
          if (d2 > 620 || G.hunters >= 3) continue;
        }
        if (d2 < bd) { bd = d2; target = a2; }
      }
      if (target && target.isPlayer) G.hunters++;
      CMB.tickBotLook(b, bd < 420 ? target : null, dt);
      CMB.botThink(b, ctx, dt);
      if (b.mvx || b.mvy) {
        var sp = CMB.BOT_SPEED * (b.state === 'run' ? 1.25 : 1);
        var nx2 = b.x + b.mvx * sp * dt, ny2 = b.y + b.mvy * sp * dt;
        if (canStand(nx2, b.y)) b.x = nx2;
        if (canStand(b.x, ny2)) b.y = ny2;
      }
      if (b.wantsFire) {
        var bb = CMB.fire(b, rnd, b.movingShot);
        if (bb) {
          CMB.spawnBullet(G.bullets, bb);
          b.muzzle = 1;
          var binst = CMB.current(b);
          if (binst && bd < 320) AUD.gun(binst.w.id, clamp(0.2 - bd / 2000, 0.03, 0.18));
        }
      }
      if (b.muzzle > 0) b.muzzle = Math.max(0, b.muzzle - dt * 8);
      if (bd < 340) { if (G.contacts.length > 20) G.contacts.shift(); G.contacts.push({ x: b.x, y: b.y, t: 2 }); }
    }
  }

  function planBotBuild(bot, forceKind) {
    var sim = G.sim;
    if (!sim) return null;
    var gx = Math.floor(bot.x / sim.cell), gy = Math.floor(bot.y / sim.cell);
    var kind = forceKind || 'turret';
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        var chk = sim.canPlace(kind, gx + dx, gy + dy, 0);
        if (chk && chk.ok) {
          var r = sim.place(kind, gx + dx, gy + dy, 0);
          if (r && r.ok) { burst((gx + dx) * sim.cell, (gy + dy) * sim.cell, 6, '#ffb64d', 60, 0.4); return { kind: kind }; }
        }
      }
    }
    return null;
  }

  function dirFromAng(a) {
    var q = Math.round(a / (Math.PI / 2));
    return ((q % 4) + 4) % 4;
  }

  function tryPlaceAt(gx, gy) {
    var dir = dirFromAng(G.player.ang);
    var chk = G.sim.canPlace(G.buildKind, gx, gy, dir);
    if (!chk || !chk.ok) {
      feedSay('FORGE', (chk && chk.reason ? chk.reason : 'blocked').toUpperCase(), false);
      try { GK.sfx.hurt(); } catch (e) {}
      return false;
    }
    var r = G.sim.place(G.buildKind, gx, gy, dir);
    if (r && r.ok) {
      burst((gx + 0.5) * G.sim.cell, (gy + 0.5) * G.sim.cell, 8, '#ffb64d', 80, 0.45);
      try { GK.sfx.coin(); } catch (e) {}
      GK.buzz(8);
      return true;
    }
    return false;
  }

  function ghostCell() {
    var p = G.player;
    var reach = G.sim.cell * 2.6;
    var cx = p.x + Math.cos(p.ang) * reach;
    var cy = p.y + Math.sin(p.ang) * reach;
    return { gx: Math.floor(cx / G.sim.cell), gy: Math.floor(cy / G.sim.cell), x: cx, y: cy };
  }

  function updateGhost() {
    if (!G.sim || !V) return;
    if (!ghost) {
      ghost = new V.THREE.Mesh(new V.THREE.BoxGeometry(G.sim.cell * 1.3, 0.4, G.sim.cell * 1.3),
        new V.THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.45, depthWrite: false }));
      V.scene.add(ghost);
    }
    ghost.visible = G.buildOpen;
    if (!G.buildOpen) return;
    var c = ghostCell();
    var chk = G.sim.canPlace(G.buildKind, c.gx, c.gy, dirFromAng(G.player.ang));
    ghost.material.color.setHex(chk && chk.ok ? 0x4ade80 : 0xef4444);
    ghost.position.set((c.gx + 0.5) * G.sim.cell, V.groundHeight(c.x, c.y) + 0.5, (c.gy + 0.5) * G.sim.cell);
  }

  /* ------------------------------------------------------------------ tick */

  function tick(dt) {
    G.t += dt;
    for (var i = G.parts.length - 1; i >= 0; i--) {
      var pt = G.parts[i];
      pt.life -= dt;
      if (pt.life <= 0) { G.parts.splice(i, 1); continue; }
      pt.x += pt.vx * dt; pt.y += pt.vy * dt;
      pt.vx *= 0.92; pt.vy *= 0.92;
    }
    for (var d = G.dmg.length - 1; d >= 0; d--) { G.dmg[d].life -= dt; if (G.dmg[d].life <= 0) G.dmg.splice(d, 1); }
    for (var f = G.feed.length - 1; f >= 0; f--) { G.feed[f].life -= dt; if (G.feed[f].life <= 0) G.feed.splice(f, 1); }
    for (var c = G.contacts.length - 1; c >= 0; c--) { G.contacts[c].t -= dt; if (G.contacts[c].t <= 0) G.contacts.splice(c, 1); }

    if (G.move.active && G.__moveUntil && G.t > G.__moveUntil) {
      G.move.active = false; G.move.x = 0; G.move.y = 0;
    }

    G.view.yaw = lerp(G.view.yaw, G.view.yawT, Math.min(1, dt * 14));
    G.view.pitch = lerp(G.view.pitch, G.view.pitchT, Math.min(1, dt * 10));

    if (G.phase === 'sky') { skyTick(dt); return; }
    if (G.phase !== 'ground') return;

    G.matchT += dt;
    var living = 0;
    for (var li = 0; li < G.actors.length; li++) if (G.actors[li].alive) living++;
    G.alive = living;
    if (G.player.immune > 0) G.player.immune = Math.max(0, G.player.immune - dt);

    stormTick(dt);
    playerTick(dt);
    botsTick(dt);
    CMB.stepBullets(G.bullets, dt, resolveHits);
    if (G.sim) {
      G.sim.tick(dt, {
        time: G.matchT,
        enemies: G.actors,
        onTurretHit: function (enemy, dmg) {
          var dealt = CMB.applyHit(enemy, dmg, null);
          if (enemy.isPlayer) {
            damageText(enemy.x, enemy.y, dealt, false);
            if (!enemy.alive) playerDown();
          } else if (!enemy.alive) botDown(enemy, 0);
        }
      });
    }
    updateGhost();
    if (G.alive <= 1 && G.player.alive) endRun(true);
  }

  function skyTick(dt) {
    var p = G.player;
    var target = G.dropPick || { x: G.world.size / 2, y: G.world.size / 2 };
    var d = Math.hypot(target.x - p.x, target.y - p.y);
    var step = Math.min(d, 900 * dt);
    if (d > 1) { p.x += (target.x - p.x) / d * step; p.y += (target.y - p.y) / d * step; }
    p.ang = Math.atan2(target.y - p.y, target.x - p.x);
    G.view.yawT = Math.PI / 2 - p.ang;
    G.fall = Math.max(0, G.fall - dt * 0.55);
    p.yOff = 34 * G.fall;
    if (d < 26 && G.fall <= 0.06) {
      G.phase = 'ground';
      G.matchT = 0;
      p.immune = 3.2;
      p.yOff = 0;
      burst(p.x, p.y, 14, '#cbd5e1', 90, 0.5);
      GK.buzz(18);
    }
  }

  /* ------------------------------------------------------------------ input */

  var BUTTONS = [];
  function layoutButtons() {
    var W = view.w, H = view.h, pad = Math.max(12, Math.round(W * 0.035));
    var r = Math.min(34, W * 0.095);
    BUTTONS = [
      { id: 'fire', x: W - pad - r * 1.15, y: H - pad - r * 3.5, r: r * 1.15, label: 'FIRE' },
      { id: 'build', x: W - pad - r * 1.1, y: H - pad - r * 6.0, r: r * 0.78, label: 'BUILD' },
      { id: 'reload', x: W - pad - r * 3.5, y: H - pad - r * 3.4, r: r * 0.7, label: 'RLD' },
      { id: 'heal', x: pad + r * 0.8, y: H - pad - r * 3.4, r: r * 0.7, label: 'HEAL' },
      { id: 'jump', x: pad + r * 2.7, y: H - pad - r * 4.6, r: r * 0.62, label: 'JUMP' },
      { id: 'swap', x: W - pad - r * 5.4, y: H - pad - r * 6.0, r: r * 0.62, label: 'SWAP' }
    ];
  }

  function hitButton(sx, sy) {
    for (var i = 0; i < BUTTONS.length; i++) {
      var b = BUTTONS[i];
      if ((sx - b.x) * (sx - b.x) + (sy - b.y) * (sy - b.y) < b.r * b.r * 1.35) { press(b.id); return true; }
    }
    return false;
  }

  function press(id) {
    var p = G.player;
    if (id === 'fire') { G.tapFire = 0.3; return; }
    if (id === 'reload') { refill(p); CMB.reload(p); return; }
    if (id === 'build') { G.buildOpen = !G.buildOpen; updateGhost(); GK.buzz(8); return; }
    if (id === 'heal') {
      var heal = p.heals.pop();
      if (heal) {
        p.hp = Math.min(CMB.HEALTH_MAX, p.hp + heal.restore);
        if (heal.shield) p.shield = Math.min(CMB.SHIELD_MAX, p.shield + heal.restore);
        try { GK.sfx.coin(); } catch (e) {}
      }
      return;
    }
    if (id === 'jump') { if (!p.jumpT || p.jumpT <= 0) p.jumpT = 0.55; return; }
    if (id === 'swap') { p.slot = p.slot === 0 ? 1 : 0; if (!p.weapons[p.slot]) p.slot = 0; return; }
  }

  function onDown(e) {
    var r = canvas.getBoundingClientRect();
    var sx = e.clientX - r.left, sy = e.clientY - r.top;
    try { GK.sfx.unlock(); } catch (err) {}

    if (G.phase === 'drop') {
      var m = Math.min(view.w * 0.86, view.h * 0.44);
      var mx = (view.w - m) / 2, my = view.h * 0.17;
      var pick = { x: G.world.size / 2, y: G.world.size / 2 };
      if (sx > mx && sx < mx + m && sy > my && sy < my + m) {
        var sc = m / G.world.size;
        pick = { x: clamp((sx - mx) / sc, 120, G.world.size - 120), y: clamp((sy - my) / sc, 120, G.world.size - 120) };
      }
      G.dropPick = pick;
      G.phase = 'sky';
      G.fall = 1;
      G.player.x = G.world.bus ? G.world.bus.a.x : G.world.size / 2;
      G.player.y = G.world.bus ? G.world.bus.a.y : G.world.size / 2;
      AUD.music(false);
      GK.buzz(12);
      return;
    }

    if (G.phase === 'over') { startRun((G.seed * 1103515245 + 12345) >>> 0); return; }
    if (G.phase !== 'ground') return;
    if (hitButton(sx, sy)) return;

    if (sx < view.w * 0.45) {
      G.move.id = e.pointerId; G.move.active = true; G.move.ox = sx; G.move.oy = sy;
    } else {
      G.look.id = e.pointerId; G.look.active = true; G.look.ox = sx; G.look.oy = sy; G.look.moved = 0;
    }
  }

  function onMove(e) {
    var r = canvas.getBoundingClientRect();
    var sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (G.move.active && e.pointerId === G.move.id) {
      var dx = sx - G.move.ox, dy = sy - G.move.oy;
      var l = Math.hypot(dx, dy) || 1;
      var max = 62, cl = Math.min(l, max);
      G.move.x = (dx / l) * (cl / max);
      G.move.y = (dy / l) * (cl / max);
      G.move.sprint = cl / max > 0.86;
    }
    if (G.look.active && e.pointerId === G.look.id) {
      var lx = sx - G.look.ox, ly = sy - G.look.oy;
      G.look.moved += Math.abs(lx) + Math.abs(ly);
      G.view.yawT -= lx * 0.006;
      G.view.pitchT = clamp(G.view.pitchT + ly * 0.004, -0.25, 0.9);
      G.look.ox = sx; G.look.oy = sy;
    }
  }

  function onUp(e) {
    if (e.pointerId === G.move.id) {
      G.move.active = false; G.move.id = -1; G.move.x = 0; G.move.y = 0; G.move.sprint = false;
    }
    if (e.pointerId === G.look.id) {
      if (G.look.moved < 14) G.tapFire = 0.22;
      G.look.active = false; G.look.id = -1;
    }
  }

  function keyDown(e) {
    G.keys[e.key] = true;
    var k = e.key.toLowerCase();
    if (k === 'b') { G.buildOpen = !G.buildOpen; updateGhost(); }
    if (k === '1') G.buildKind = 'drill';
    if (k === '2') G.buildKind = 'conveyor';
    if (k === '3') G.buildKind = 'fabricator';
    if (k === '4') G.buildKind = 'turret';
    if (k === '5') G.buildKind = 'wall';
    if (k === 'q') press('swap');
    if (k === 'r') press('reload');
    if (k === 'f') press('heal');
    if (k === 'e' && G.buildOpen) { var c = ghostCell(); tryPlaceAt(c.gx, c.gy); }
    if (k === 'enter' && G.phase === 'drop') { G.phase = 'sky'; G.fall = 1; }
  }

  /* ------------------------------------------------------------------ draw */

  function drawHUD() {
    var W = view.w, H = view.h;
    hctx.clearRect(0, 0, W, H);
    if (G.phase === 'drop') {
      RND.drawDrop(hctx, view, { world: G.world, t: G.t, dropHint: G.dropHint });
      return;
    }
    if (G.phase === 'over') {
      RND.drawResult(hctx, view, { won: G.won, place: G.place, stats: G.stats, t: G.t });
      return;
    }
    RND.drawHUD(hctx, view, hudState());
    drawTouchUI();
    drawDamage();
  }

  function drawDamage() {
    if (!V) return;
    var cam = V.camera;
    var v = new V.THREE.Vector3();
    hctx.font = '800 13px ui-monospace, Menlo, monospace';
    hctx.textAlign = 'center';
    for (var i = 0; i < G.dmg.length; i++) {
      var d = G.dmg[i];
      v.set(d.x, V.groundHeight(d.x, d.y) + 2.1 + (1 - d.life) * 1.4, d.y);
      v.project(cam);
      if (v.z > 1) continue;
      hctx.globalAlpha = Math.min(1, d.life * 1.6);
      hctx.fillStyle = d.crit ? '#fbbf24' : '#ffe6c2';
      hctx.fillText(String(d.v), (v.x * 0.5 + 0.5) * view.w, (-v.y * 0.5 + 0.5) * view.h);
    }
    hctx.globalAlpha = 1;
  }

  function drawTouchUI() {
    var W = view.w;
    if (G.move.active) {
      hctx.strokeStyle = 'rgba(230,237,247,.35)';
      hctx.lineWidth = 2;
      hctx.beginPath(); hctx.arc(G.move.ox, G.move.oy, 62, 0, TAU); hctx.stroke();
      hctx.fillStyle = 'rgba(230,237,247,.22)';
      hctx.beginPath();
      hctx.arc(G.move.ox + G.move.x * 44, G.move.oy + G.move.y * 44, 24, 0, TAU);
      hctx.fill();
    }
    for (var i = 0; i < BUTTONS.length; i++) {
      var b = BUTTONS[i];
      var active = (b.id === 'build' && G.buildOpen);
      hctx.beginPath();
      hctx.arc(b.x, b.y, b.r, 0, TAU);
      hctx.fillStyle = active ? 'rgba(255,182,77,.30)' : 'rgba(10,14,20,.55)';
      hctx.fill();
      hctx.strokeStyle = active ? 'rgba(255,182,77,.9)' : 'rgba(230,237,247,.28)';
      hctx.lineWidth = 1.6;
      hctx.stroke();
      hctx.fillStyle = active ? '#ffe6c2' : 'rgba(230,237,247,.72)';
      hctx.font = '700 ' + Math.max(8, Math.round(b.r * 0.34)) + 'px ui-monospace, Menlo, monospace';
      hctx.textAlign = 'center';
      hctx.fillText(b.label, b.x, b.y + 3);
    }
  }

  function hudState() {
    var p = G.player;
    var inst = CMB.current(p);
    var stock = (G.sim && G.sim.stock) || { copper: 0, titanium: 0, ammo: 0 };
    var kinds = BUILD_KINDS.map(function (b) {
      var c = BUILD_COST[b.kind] || { copper: 0, titanium: 0 };
      return {
        label: b.label, icon: null, sel: G.buildKind === b.kind,
        ok: (stock.copper || 0) >= c.copper && (stock.titanium || 0) >= c.titanium
      };
    });
    return {
      world: G.world, alive: G.alive, hp: p.hp, shield: p.shield,
      weapon: inst, ammoCount: p.ammo[inst ? inst.w.ammo : ''] || 0,
      stock: stock, feed: G.feed, storm: G.storm, stormNext: G.stormNext,
      hero: { x: p.x, y: p.y }, contacts: G.contacts,
      buildOpen: G.buildOpen, kinds: kinds,
      buildHint: G.buildOpen ? 'TAP GROUND OR PRESS E' : ''
    };
  }

  /* ------------------------------------------------------------------ loop */

  var last = 0, fpsT = 0, fpsN = 0;

  function frame(ts) {
    var dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
    last = ts;
    fpsN++; fpsT += dt;
    if (fpsT > 1) { G.fps = Math.round(fpsN / fpsT); fpsN = 0; fpsT = 0; }

    if (!G.qaFreeze) tick(dt);
    if (V && G.world) {
      SC.sync(V, G, dt);
      SC.updateNearGrass(V, G);
      if (!G.qaFreeze) SC.placeCamera(V, G, dt);
      if (G.phase === 'drop') G.view.yawT += dt * 0.05;
      SC.render(V);
      SC.adapt(V, dt);
    }
    drawHUD();
    requestAnimationFrame(frame);
  }

  function resize() {
    var w = window.innerWidth, h = window.innerHeight;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    view.w = w; view.h = h;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    hud.style.width = w + 'px'; hud.style.height = h + 'px';
    canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
    hud.width = Math.floor(w * dpr); hud.height = Math.floor(h * dpr);
    if (V) SC.resize(V, w, h);
    hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layoutButtons();
  }

  /* ------------------------------------------------------------------ test hooks */

  function state() {
    var p = G.player;
    var inst = CMB.current(p);
    var nearest = null, nd = 1e9;
    for (var i = 0; i < G.actors.length; i++) {
      var a = G.actors[i];
      if (!a.alive || a.isPlayer) continue;
      var d = Math.hypot(a.x - p.x, a.y - p.y);
      if (d < nd) { nd = d; nearest = { dx: a.x - p.x, dy: a.y - p.y, dist: d, name: a.name }; }
    }
    var simState = G.sim ? G.sim.state() : {};
    return {
      phase: G.phase, mode: G.phase, started: G.phase === 'ground' || G.phase === 'over',
      alive: G.alive, hp: p.hp, shield: p.shield,
      ammo: inst ? inst.mag : 0, ammoReserve: inst ? (p.ammo[inst.w.ammo] || 0) : 0,
      weapon: inst ? inst.w.id : null, weaponTier: inst ? inst.w.tier : null,
      loot: { picked: G.picked }, storm: { phase: G.storm.phase, r: G.storm.r },
      blocks: simState.blocks || 0, ore: Math.round(simState.oreMined || 0),
      items: simState.itemsMoved || 0, ammoMade: simState.ammo || 0,
      stock: G.sim ? G.sim.stock : null, kills: G.kills, bots: G.actors.length - 1,
      hero: { x: p.x, y: p.y, z: p.yOff || 0 }, nearest: nearest,
      seed: G.seed, matchT: G.matchT, fps: G.fps,
      three: !!V && !!V.renderer, draws: V ? V.renderer.info.render.calls : 0,
      tris: V ? V.renderer.info.render.triangles : 0
    };
  }

  function act(name, arg) {
    arg = arg || {};
    if (name === 'drop') {
      if (G.phase === 'drop') {
        var target = arg.x != null ? { x: arg.x, y: arg.y }
          : (G.world.pois[0] ? { x: G.world.pois[0].cx, y: G.world.pois[0].cy } : { x: G.world.size / 2, y: G.world.size / 2 });
        G.dropPick = target;
        G.player.x = G.world.bus.a.x; G.player.y = G.world.bus.a.y;
        G.phase = 'sky'; G.fall = 1;
      }
      return state();
    }
    if (name === 'skipLand') {
      G.player.x = G.dropPick ? G.dropPick.x : G.player.x;
      G.player.y = G.dropPick ? G.dropPick.y : G.player.y;
      G.player.yOff = 0;
      G.phase = 'ground'; G.matchT = 0; G.player.immune = 1;
      return state();
    }
    if (name === 'move') {
      var dx = arg.dx || 0, dy = arg.dy || 0;
      var l = Math.hypot(dx, dy) || 1;
      var yaw = G.view.yaw;
      var wx = dx / l, wz = dy / l;
      // world direction -> camera-relative stick
      var forward = wx * Math.sin(yaw) + wz * Math.cos(yaw);
      var right = wx * Math.cos(yaw) - wz * Math.sin(yaw);
      G.move.active = true;
      G.move.x = right;
      G.move.y = -forward;
      G.__moveUntil = G.t + (arg.ms || 300) / 1000;
      return state();
    }
    if (name === 'fire') { G.tapFire = (arg.ms || 250) / 1000; return state(); }
    if (name === 'reload') { refill(G.player); CMB.reload(G.player); return state(); }
    if (name === 'heal') { press('heal'); return state(); }
    if (name === 'pickup') { autoPickup(); return state(); }
    if (name === 'grant') { G.sim.stock.copper += arg.copper || 100; G.sim.stock.titanium += arg.titanium || 40; return state(); }
    if (name === 'tick') { var n = arg.n || 60; for (var i = 0; i < n; i++) tick(1 / 60); return state(); }
    /* QA only: stop the simulation and the camera so a probe can park the camera wherever it
     * likes and still get a stable frame. */
    if (name === 'freeze') { G.qaFreeze = arg.on !== false; return state(); }
    if (name === 'build') {
      var gx = arg.gx != null ? arg.gx : ghostCell().gx;
      var gy = arg.gy != null ? arg.gy : ghostCell().gy;
      var dir = arg.dir != null ? arg.dir : dirFromAng(G.player.ang);
      var r = G.sim.place(arg.kind || 'drill', gx, gy, dir);
      return { ok: !!(r && r.ok), reason: r && r.reason, state: state() };
    }
    if (name === 'buildLine') {
      var bestOre = null, bd2 = 1e9;
      G.sim.ore.forEach(function (o, k) {
        if (o.amount <= 0) return;
        var parts = k.split(',');
        var ogx = +parts[0], ogy = +parts[1];
        var d3 = Math.hypot((ogx + 0.5) * G.sim.cell - G.player.x, (ogy + 0.5) * G.sim.cell - G.player.y);
        if (d3 < bd2) { bd2 = d3; bestOre = { gx: ogx, gy: ogy }; }
      });
      if (!bestOre) return { ok: false, reason: 'no ore', state: state() };
      var order = ['drill', 'conveyor', 'fabricator', 'turret'];
      var built = [];
      for (var oi = 0; oi < order.length; oi++) {
        var rr = G.sim.place(order[oi], bestOre.gx + oi, bestOre.gy, 1);
        built.push({ kind: order[oi], ok: !!(rr && rr.ok), reason: rr && rr.reason });
      }
      G.player.x = (bestOre.gx + 0.5) * G.sim.cell;
      G.player.y = (bestOre.gy + 2.6) * G.sim.cell;
      return { ok: built.every(function (b) { return b.ok; }), built: built, state: state() };
    }
    if (name === 'skipToEndgame') {
      for (var k = 1; k < G.actors.length; k++) {
        if (k % 3 === 0) continue;
        var b = G.actors[k];
        if (b.alive) botDown(b, G.player.id);
      }
      return state();
    }
    if (name === 'killNearest') {
      var nn = state().nearest;
      if (nn) for (var j = 0; j < G.actors.length; j++) {
        var a = G.actors[j];
        if (!a.alive || a.isPlayer || a.name !== nn.name) continue;
        CMB.applyHit(a, 999, 0); botDown(a, G.player.id); break;
      }
      return state();
    }
    if (name === 'buildOpen') { G.buildOpen = !!arg.on; updateGhost(); return state(); }
    if (name === 'look') {
      if (arg.dyaw != null) G.view.yawT += arg.dyaw;
      if (arg.yaw != null) G.view.yawT = arg.yaw;
      G.view.yaw = G.view.yawT;
      return state();
    }
    return state();
  }

  /* ------------------------------------------------------------------ boot */

  function boot() {
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', function () { setTimeout(resize, 120); });
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', function (e) { G.keys[e.key] = false; });

    var seed = (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
    startRun(seed);
    layoutButtons();
    AUD.music(true);
    requestAnimationFrame(function (ts) { last = ts; requestAnimationFrame(frame); });
    g.__game = {
      state: state, act: act, boot: startRun, G: G, SF: { SC: SC, CMB: CMB, RND: RND },
      /* QA hooks: post.on(false) renders raw so a probe can diff the grade, perf() proves the
       * adaptive scaler engaged, and sun()/sky() read the lighting actually in the scene. */
      post: function (on) {
        var P = V && V.post;
        if (!P) return null;
        if (on != null) P.enabled = !!on;
        return { on: P.enabled, dpr: V.renderer.getPixelRatio(), exposure: P.compMat.uniforms.exposure.value };
      },
      /* Toggling shadows is the only way to prove they are actually on the screen: a still
       * frame with soft 8% shadows and a still frame with none look identical to an eye. */
      shadows: function (on) {
        if (!V) return null;
        V.sun.castShadow = on !== false;
        V.renderer.shadowMap.needsUpdate = true;
        return { shadows: V.sun.castShadow, map: V.sun.shadow.mapSize.x };
      },
      view: function () { return V; },
      /* Raycast a grid of screen points and report what is actually there. Cheaper and far more
       * reliable than asking a vision model what colour the ground is. */
      pick: function (cols, rows) {
        if (!V || !V.THREE) return null;
        var THREE = V.THREE, rc = new THREE.Raycaster();
        var out = [], seen = {};
        cols = cols || 5; rows = rows || 5;
        for (var ry = 0; ry < rows; ry++) {
          for (var rx = 0; rx < cols; rx++) {
            var nx = (rx + 0.5) / cols * 2 - 1, ny = 1 - (ry + 0.5) / rows * 2;
            rc.setFromCamera(new THREE.Vector2(nx, ny), V.camera);
            var hits = rc.intersectObjects(V.scene.children, true);
            var h = hits[0];
            var label = h ? (h.object.name || (h.object.parent && h.object.parent.name) || h.object.type) : 'sky';
            seen[label] = (seen[label] || 0) + 1;
          }
        }
        /* straight-down probe: proves what the ground under the player actually is */
        var px = G.player.x, pz = G.player.y, py = V.groundHeight(px, pz);
        var down = new THREE.Raycaster(new THREE.Vector3(px, py + 30, pz), new THREE.Vector3(0, -1, 0));
        down.camera = V.camera;   // Sprite.raycast dereferences the camera
        var dh = down.intersectObjects(V.scene.children, true).slice(0, 4).map(function (h) {
          return { name: h.object.name || h.object.type, dist: +h.distance.toFixed(2), y: +h.point.y.toFixed(2) };
        });
        /* what the centre of the screen sees, with distances */
        var centre = new THREE.Raycaster();
        centre.camera = V.camera;
        centre.setFromCamera(new THREE.Vector2(0, -0.55), V.camera);
        var ch2 = centre.intersectObjects(V.scene.children, true).slice(0, 3).map(function (h) {
          return { name: h.object.name || h.object.type, dist: +h.distance.toFixed(1), y: +h.point.y.toFixed(2) };
        });
        return { seen: seen, down: dh, centre: ch2, playerY: +py.toFixed(2), camY: +V.camera.position.y.toFixed(2) };
      },
      probe: function () {
        if (!V) return null;
        var g2 = V.scene.getObjectByName('grass');
        var t2 = V.scene.getObjectByName('terrain');
        return {
          grass: g2 ? g2.count : -1,
          grassVisible: g2 ? g2.visible : false,
          terrainMat: t2 ? t2.material.type : 'none',
          terrainVerts: t2 ? t2.geometry.attributes.position.count : 0,
          water: !!V.scene.getObjectByName('water'),
          shadowsOn: V.sun.castShadow,
          shadowMap: V.sun.shadow.mapSize.x,
          dpr: V.renderer.getPixelRatio(),
          post: !!(V.post && V.post.enabled)
        };
      },
      perf: function () {
        if (!V) return null;
        var inf = V.renderer.info;
        return { fps: G.fps, dpr: V.renderer.getPixelRatio(), calls: inf.render.calls, tris: inf.render.triangles,
                 progs: inf.programs ? inf.programs.length : -1, tex: inf.memory.textures };
      }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  g.SF_GAME = G;
  // The collection's smoke test wants a __game hook in every module; this is the real one.
  window.__game = window.__game || {};
})(window);
