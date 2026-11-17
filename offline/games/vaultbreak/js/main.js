/* Vaultbreak — turn-based vault roguelike.
 * Lineage: Shattered Pixel Dungeon's turn economy + permadeath crossed with
 * Mindustry's scrap -> craft -> upgrade resource loop.
 * Art and audio: Shattered Pixel Dungeon contributors (GPL-3.0);
 * item data: Cataclysm: DDA contributors (CC-BY-SA-3.0) — both arrive through
 * vendor/vendor.js, which is optional: without it the authored art, numbers
 * and names below are used and the game plays exactly as it did before.
 * One file, no dependencies beyond ../shell/lib/gamekit.js and ../../vendor/vendor.js. */
(function () {
  'use strict';

  var W = 30, H = 22;
  var WALL = 0, FLOOR = 1, DOOR = 2, STAIRS = 3;
  var store = GK.store('vaultbreak');
  var rng = Math.random;

  /* ------------------------------------------------------------------ *
   * VENDORED CONTENT
   * Shattered Pixel Dungeon supplies the pixel bestiary, the item icons and
   * the whole sound set; Cataclysm: DDA supplies the loot table (names,
   * prices, weights, descriptions), the monster stats that scale the
   * bestiary and the recipes behind the fabricator. vendor/vendor.js is a
   * classic script (works from file:// with the network off) and is
   * optional: with it missing every table below is empty and the game falls
   * back to the authored numbers, names and vector shapes.
   * ------------------------------------------------------------------ */
  var VENDOR = window.AOMG_VENDOR || null;
  var VDATA = (VENDOR && VENDOR.data) || {};
  var VSPD = VDATA['shattered-pixel-dungeon/assets'] || null;
  var CDDA_ITEMS = VDATA['cataclysm-dda/items'] || [];
  var CDDA_MON = VDATA['cataclysm-dda/monsters'] || [];
  var CDDA_REC = VDATA['cataclysm-dda/recipes'] || [];

  var ASSET_SET = {};
  if (VENDOR && VENDOR.assets) {
    for (var ai = 0; ai < VENDOR.assets.length; ai++) ASSET_SET[VENDOR.assets[ai]] = true;
  }
  function hasAsset(p) { return !VENDOR || ASSET_SET[p] === true; }
  function assetUrl(p) { return '../../' + p; }

  /* ---- sprite sheets: horizontal strips, frame = height ---- */
  var SPR = {};
  function spritePath(name) {
    if (!VSPD || !VSPD.sprites) return null;
    for (var i = 0; i < VSPD.sprites.length; i++) if (VSPD.sprites[i].name === name) return VSPD.sprites[i].image;
    return null;
  }
  function preloadSprite(name) {
    var s = SPR[name];
    if (s) return s;
    s = SPR[name] = { img: null, ready: false, frames: 1, h: 16 };
    var p = spritePath(name);
    if (!p || !hasAsset(p)) return s;
    var img = new Image();
    img.onload = function () {
      s.h = img.naturalHeight || img.height || 16;
      var w = img.naturalWidth || img.width || s.h;
      s.frames = Math.max(1, Math.round(w / s.h));
      s.ready = s.h > 1 && w >= s.h;
    };
    img.onerror = function () { s.ready = false; };
    img.src = assetUrl(p);
    s.img = img;
    return s;
  }

  /* ---- item icon atlas (16x16 cells) ---- */
  var ATLAS = { img: null, ready: false };
  (function loadAtlas() {
    var p = spritePath('items');
    if (!p || !hasAsset(p)) return;
    var img = new Image();
    img.onload = function () { ATLAS.ready = img.naturalWidth >= 16; };
    img.src = assetUrl(p);
    ATLAS.img = img;
  })();
  /* Cells read off SPD's items.png: rock, pickaxe, sword, map, skull, chest,
   * key, bomb, potion, wand, staff, shirt, bag, scroll, crystal, book. */
  var ICON = {
    scrap: [2, 4], spare_parts: [2, 4], misc: [2, 4], other: [2, 4], rock: [2, 4],
    weapons: [4, 4], tools: [3, 4], veh_parts: [3, 4],
    armor: [7, 11], clothing: [7, 11], shirt: [7, 11],
    drugs: [4, 5], food: [4, 5], firstaid: [4, 5], potion: [4, 5],
    tool_magazine: [7, 26], crystal: [7, 26], artifacts: [7, 26],
    traps: [0, 5], bomb: [0, 5],
    keys: [10, 3], key: [10, 3],
    container: [12, 0], ammo: [3, 10],
    books: [1, 30], manuals: [1, 30], book: [1, 30],
    currency: [5, 2], cache: [5, 2], chest: [5, 2],
    wand: [0, 13], staff: [8, 13], scroll: [6, 19]
  };
  /* ---- terrain atlases: real SPD dungeon tiles, one 256x256 sheet per region ----
   * Cell indices are SPD's own (DungeonTileSheet.java: xy(x,y) = x-1 + 16*(y-1)):
   * FLOOR=0, FLOOR_ALT_1=6, FLOOR_ALT_2=12, FLAT_WALL=48, FLAT_WALL_ALT=52. */
  var TILE_FLOOR_0 = 0, TILE_FLOOR_1 = 6, TILE_FLOOR_2 = 12, TILE_WALL = 48, TILE_WALL_ALT = 52;
  var TSHEET = 16, TCELL = 16;
  var TERRAIN = {};
  function tileBlit(ctx, t, cell, px, py, ts) {
    var cx = (cell % TSHEET) * TCELL, cy = ((cell / TSHEET) | 0) * TCELL;
    ctx.drawImage(t.img, cx, cy, TCELL, TCELL, px, py, ts, ts);
  }
  /* sector -> region, the way SPD layers sewers / prison / caves downwards */
  function terrainTheme(depth) {
    if (depth <= 2) return 'sewers';
    if (depth <= 4) return 'prison';
    return 'caves';
  }
  function terrainFor(depth) {
    var name = terrainTheme(depth);
    if (TERRAIN[name]) return TERRAIN[name];
    var t = TERRAIN[name] = { img: null, ready: false, name: name };
    var list = VSPD && VSPD.terrain;
    if (!list) return t;
    for (var i = 0; i < list.length; i++) {
      if (list[i].name !== name) continue;
      var p = list[i].image;               // already a 'vendor/...' path, like the sprites
      if (!hasAsset(p)) return t;
      var img = new Image();
      img.onload = function () { t.ready = img.naturalWidth >= TCELL * 2; };
      img.src = assetUrl(p);
      t.img = img;
      return t;
    }
    return t;
  }

  /* A few things get their own SPD sprite rather than an atlas cell. */
  var ICON_SPR = { artifacts: 'amulet' };
  for (var isk in ICON_SPR) if (ICON_SPR[isk]) preloadSprite(ICON_SPR[isk]);
  /* The hero comes from SPD's avatars strip: eight 32px cells, six of them full-body figures.
     (The class sheets like warrior.png are contact sheets of tiny variant figures, not frames —
     drawing one as a single image scales the whole grid down, which is worse than a square.) */
  var HERO_SPR = preloadSprite('avatars');
  function drawIcon(ctx, key, x, y, size) {
    var named = ICON_SPR[key];
    if (named) {
      var s = SPR[named];
      if (s && s.ready && s.img) {
        var sc0 = s.h <= size ? Math.max(1, Math.round(size / s.h)) : 1;
        var d0 = Math.round(s.h * sc0);
        if (d0 > size * 1.4) d0 = Math.round(size);
        ctx.drawImage(s.img, 0, 0, s.h, s.h,
          Math.round(x + (size - d0) / 2), Math.round(y + (size - d0) / 2), d0, d0);
        return true;
      }
    }
    var cell = ICON[key] || ICON.misc;
    if (!ATLAS.ready || !ATLAS.img) return false;
    var sc = Math.max(1, Math.round(size / 16));
    var d = 16 * sc;
    ctx.drawImage(ATLAS.img, cell[0] * 16, cell[1] * 16, 16, 16,
      Math.round(x + (size - d) / 2), Math.round(y + (size - d) / 2), d, d);
    return true;
  }

  /* ---- audio: Opus via <audio>, gesture-unlocked, follows GK.sfx ---- */
  var SFX = {}, SFX_POOL = {};
  if (VSPD && VSPD.sounds) {
    for (var si = 0; si < VSPD.sounds.length; si++) SFX[VSPD.sounds[si].name] = VSPD.sounds[si].audio;
  }
  /* With the bundle missing there is no Opus to play, so each event falls back
   * to the shared GameKit synthesiser and the game is still audible. */
  var SFX_FALLBACK = {
    hit_slash: 'hit', hit_strong: 'hit', hit_crush: 'hurt', hit_magic: 'shoot',
    miss: 'hit', zap: 'shoot', item: 'coin', gold: 'coin', descend: 'unlock',
    levelup: 'win', death: 'lose', boss: 'boom', unlock: 'unlock', step: 'step'
  };
  function sfx(name, vol) {
    if (!GK.sfx.enabled) return;
    var p = SFX[name];
    if (!p || !hasAsset(p)) {
      var fb = SFX_FALLBACK[name];
      if (fb && GK.sfx[fb]) GK.sfx[fb]();
      return;
    }
    var pool = SFX_POOL[name];
    if (!pool) {
      pool = SFX_POOL[name] = [];
      for (var i = 0; i < 3; i++) {
        var au = new Audio(assetUrl(p));
        au.preload = 'auto';
        pool.push(au);
      }
      pool.i = 0;
    }
    var a = pool[pool.i = (pool.i + 1) % pool.length];
    try {
      a.currentTime = 0;
      a.volume = vol == null ? 0.5 : vol;
      var pr = a.play();
      if (pr && pr.catch) pr.catch(function () {});
    } catch (e) {}
  }

  var MUSIC = { vault: null, tense: null, cur: null, unlocked: false };
  (function loadMusic() {
    if (!VSPD || !VSPD.music) return;
    for (var i = 0; i < VSPD.music.length; i++) {
      var m = VSPD.music[i];
      if (!m.audio || !hasAsset(m.audio)) continue;
      var a = new Audio(assetUrl(m.audio));
      a.loop = true; a.preload = 'auto'; a.volume = 0.3;
      if (m.name === 'caves_1') MUSIC.vault = a;
      else if (m.name === 'caves_tense') MUSIC.tense = a;
    }
  })();
  function musicPlay(which) {
    if (!MUSIC.unlocked) return;
    var want = (which === 'tense' && MUSIC.tense) ? MUSIC.tense : MUSIC.vault;
    if (!want || MUSIC.cur === want) return;
    if (MUSIC.cur) { try { MUSIC.cur.pause(); } catch (e) {} }
    MUSIC.cur = want;
    try {
      want.muted = !GK.sfx.enabled;
      want.currentTime = 0;
      var pr = want.play();
      if (pr && pr.catch) pr.catch(function () {});
    } catch (e) {}
  }
  function audioUnlock() {
    GK.sfx.unlock();
    MUSIC.unlocked = true;
    if (G.mode === 'play') musicPlay(G.depth >= 6 ? 'tense' : 'vault');
  }
  function musicTick() {
    if (MUSIC.vault) MUSIC.vault.muted = !GK.sfx.enabled;
    if (MUSIC.tense) MUSIC.tense.muted = !GK.sfx.enabled;
    if (!MUSIC.unlocked || !MUSIC.cur || G.mode !== 'play') return;
    if (GK.sfx.enabled && MUSIC.cur.paused) {
      var pr = MUSIC.cur.play();
      if (pr && pr.catch) pr.catch(function () {});
    }
  }

  /* Palettes per depth: each sector of the vault looks different. */
  var SECTORS = [
    { name: 'SERVICE LEVEL', bg: '#0b0d12', wall: '#2b3341', wallTop: '#3d4859', floor: '#151a22', accent: '#f0b429' },
    { name: 'COOLANT LOOPS', bg: '#07110f', wall: '#1e3b36', wallTop: '#2d5b52', floor: '#0d1a18', accent: '#4de2c0' },
    { name: 'RUST WORKS', bg: '#120b09', wall: '#452a1e', wallTop: '#63402c', floor: '#1c110d', accent: '#ff7a45' },
    { name: 'CRYO ARCHIVE', bg: '#080c14', wall: '#243449', wallTop: '#365072', floor: '#0e1521', accent: '#7cc7ff' },
    { name: 'FOUNDRY CORE', bg: '#140a06', wall: '#4a2412', wallTop: '#6d371b', floor: '#1e100a', accent: '#ff9f43' },
    { name: 'THE WARDEN', bg: '#0c0710', wall: '#3a1f45', wallTop: '#573068', floor: '#170e1c', accent: '#d98cff' }
  ];

  var G = {
    mode: 'title',       // title | play | craft | dead | win | help
    depth: 1, seed: 1,
    map: null, seen: null, vis: null,
    actors: [], items: [], parts: [],
    player: null,
    turns: 0, kills: 0, scrap: 0, energy: 8, maxEnergy: 8,
    atk: 4, armor: 0, hp: 60, maxHp: 60,
    cam: { x: 0, y: 0 }, shake: 0, flash: 0,
    log: [], msgT: 0,
    carry: [], tip: null, hover: null, floats: [], dust: [],
    best: store.get('bestDepth', 0),
    bestScore: store.get('bestScore', 0),
    wardenSpawned: false,
    craftHover: -1,
    palette: SECTORS[0]
  };

  /* A few motes of dungeon air. Preallocated so the render loop allocates nothing. */
  function seedDust() {
    if (G.dust.length) return;
    for (var i = 0; i < 46; i++)
      G.dust.push({ x: Math.random(), y: Math.random(), r: 0.6 + Math.random() * 1.6,
                    s: 0.006 + Math.random() * 0.014, a: 0.05 + Math.random() * 0.12 });
  }

  /* Damage and loot numbers drift up out of the tile that produced them. */
  function floatText(x, y, text, color) {
    G.floats.push({ x: x + 0.5, y: y + 0.5, text: text, c: color, t: 0, life: 0.95 });
    if (G.floats.length > 24) G.floats.shift();
  }

  function idx(x, y) { return y * W + x; }
  function inB(x, y) { return x >= 0 && y >= 0 && x < W && y < H; }
  function tileAt(x, y) { return inB(x, y) ? G.map[idx(x, y)] : WALL; }
  function isWalk(x, y) { var t = tileAt(x, y); return t === FLOOR || t === DOOR || t === STAIRS; }
  function blocksSight(x, y) { var t = tileAt(x, y); return t === WALL; }

  function log(s) {
    G.log.unshift(s);
    if (G.log.length > 4) G.log.pop();
    G.msgT = 2.4;
  }

  /* ------------------------------------------------------------------ *
   * FLOOR GENERATION — rooms placed without overlap, then L-corridors.
   * ------------------------------------------------------------------ */
  function genFloor(depth, seed) {
    rng = GK.rand(seed * 7919 + depth * 131 + 17);
    G.map = new Uint8Array(W * H);
    G.seen = new Uint8Array(W * H);
    G.vis = new Uint8Array(W * H);
    G.actors = []; G.items = []; G.parts = [];
    G.palette = SECTORS[Math.min(depth - 1, SECTORS.length - 1)];

    var rooms = [];
    for (var attempt = 0; attempt < 220 && rooms.length < 8; attempt++) {
      var rw = GK.ri(rng, 4, 8), rh = GK.ri(rng, 3, 6);
      var rx = GK.ri(rng, 1, W - rw - 2), ry = GK.ri(rng, 1, H - rh - 2);
      var clash = false;
      for (var i = 0; i < rooms.length; i++) {
        var r = rooms[i];
        if (rx < r.x + r.w + 1 && rx + rw + 1 > r.x && ry < r.y + r.h + 1 && ry + rh + 1 > r.y) { clash = true; break; }
      }
      if (clash) continue;
      rooms.push({ x: rx, y: ry, w: rw, h: rh, cx: (rx + (rw >> 1)) | 0, cy: (ry + (rh >> 1)) | 0 });
    }
    rooms.forEach(function (r) {
      for (var y = r.y; y < r.y + r.h; y++)
        for (var x = r.x; x < r.x + r.w; x++) G.map[idx(x, y)] = FLOOR;
    });
    // corridors: chain rooms, plus one loop so it isn't a pure tree
    function corr(a, b) {
      var x = a.cx, y = a.cy;
      if (rng() < 0.5) {
        while (x !== b.cx) { x += Math.sign(b.cx - x); if (tileAt(x, y) === WALL) G.map[idx(x, y)] = FLOOR; }
        while (y !== b.cy) { y += Math.sign(b.cy - y); if (tileAt(x, y) === WALL) G.map[idx(x, y)] = FLOOR; }
      } else {
        while (y !== b.cy) { y += Math.sign(b.cy - y); if (tileAt(x, y) === WALL) G.map[idx(x, y)] = FLOOR; }
        while (x !== b.cx) { x += Math.sign(b.cx - x); if (tileAt(x, y) === WALL) G.map[idx(x, y)] = FLOOR; }
      }
    }
    for (var k = 1; k < rooms.length; k++) corr(rooms[k - 1], rooms[k]);
    if (rooms.length > 3) corr(rooms[0], rooms[rooms.length - 1]);

    var start = rooms[0], end = rooms[rooms.length - 1];
    G.map[idx(end.cx, end.cy)] = STAIRS;

    G.player = { kind: 'you', x: start.cx, y: start.cy, px: start.cx, py: start.cy, hp: G.hp, maxHp: G.maxHp, face: { x: 1, y: 0 } };

    // enemies scale with depth; the warden waits on the last floor
    var count = Math.min(14, 3 + depth * 2);
    for (var e = 0; e < count; e++) {
      var rm = rooms[GK.ri(rng, 0, rooms.length - 1)];
      var ex = GK.ri(rng, rm.x, rm.x + rm.w - 1), ey = GK.ri(rng, rm.y, rm.y + rm.h - 1);
      if ((ex === G.player.x && ey === G.player.y) || G.actors.some(function (a) { return a.x === ex && a.y === ey; })) continue;
      spawnEnemy(pickKind(depth), ex, ey);
    }
    if (depth === 6) { G.wardenSpawned = true; spawnEnemy('warden', end.cx, Math.max(1, end.cy - 1)); }

    // loot: scrap piles for the fabricator, plus real salvaged items
    for (var s = 0; s < 4 + depth; s++) {
      var rr = rooms[GK.ri(rng, 0, rooms.length - 1)];
      var ix = GK.ri(rng, rr.x, rr.x + rr.w - 1), iy = GK.ri(rng, rr.y, rr.y + rr.h - 1);
      if (tileAt(ix, iy) !== FLOOR || G.items.some(function (it) { return it.x === ix && it.y === iy; })) continue;
      var found = rng() < 0.42 ? null : pickLoot(depth);
      if (found) G.items.push({ kind: 'item', x: ix, y: iy, item: found, phase: rng() * 6.28 });
      else G.items.push({ kind: 'scrap', x: ix, y: iy, amount: GK.ri(rng, 2, 4 + depth), phase: rng() * 6.28 });
    }
    var midRoom = rooms[1 + (rooms.length >> 1)] || end;
    G.items.push({ kind: 'cache', x: midRoom.cx, y: midRoom.cy, amount: 0, phase: 0, used: false });

    computeFOV(G.player.x, G.player.y, 8);
  }

  /* Bestiary — one Shattered Pixel Dungeon sprite per creature, with the hit
   * points, melee dice and speed taken from the matching Cataclysm: DDA
   * monster row (see `cdda:`). The authored numbers are the fallback used
   * when the bundle is missing. */
  var KINDS = {}, KIND_ORDER = [];

  function cdaaMonster(id) {
    for (var i = 0; i < CDDA_MON.length; i++) if (CDDA_MON[i].id === id) return CDDA_MON[i];
    return null;
  }
  function defineKind(def) {
    var row = def.cdda ? cdaaMonster(def.cdda) : null;
    var k = {
      hp: def.hp, atk: def.atk, def: def.def, sight: def.sight, speed: def.speed || 1,
      name: def.name, color: def.color, spr: def.spr, anim: def.anim, shape: def.shape,
      ranged: !!def.ranged, flees: !!def.flees, erratic: !!def.erratic, boss: !!def.boss,
      cdda: def.cdda || '', cddaName: '', cddaHp: 0, cddaDice: ''
    };
    if (row) {
      var avg = (row.melee_dice || 0) * ((row.melee_dice_sides || 0) + 1) / 2;
      if (def.boss) {
        if (avg > 0) k.atk = Math.max(k.atk, Math.round(avg * 0.55));
      } else {
        k.hp = Math.round(6 + row.hp * 0.16);
        k.atk = Math.max(2, Math.round(avg * 0.55));
        k.def = GK.clamp(Math.round(row.hp / 60), 0, 6);
      }
      if (row.speed) k.speed = row.speed >= 90 ? 1 : row.speed >= 60 ? 2 : 3;
      k.cddaName = row.name;
      k.cddaHp = row.hp;
      k.cddaDice = (row.melee_dice || 0) + 'd' + (row.melee_dice_sides || 0);
    }
    if (k.spr) preloadSprite(k.spr);
    KINDS[def.kind] = k;
    KIND_ORDER.push(def.kind);
  }

  defineKind({ kind: 'rat', name: 'rat', spr: 'rat', anim: [0, 2], shape: 'tri', color: '#9ad0a0',
    cdda: 'mon_big_rat', hp: 9, atk: 2, def: 0, sight: 6, speed: 1, erratic: true });
  defineKind({ kind: 'bat', name: 'bat', spr: 'bat', anim: [0, 5], shape: 'tri', color: '#8fa9ff',
    cdda: 'mon_crow_mutant_small', hp: 7, atk: 2, def: 0, sight: 8, speed: 1, erratic: true });
  defineKind({ kind: 'snake', name: 'snake', spr: 'snake', anim: [0, 1], shape: 'diamond', color: '#7ee0a0',
    cdda: 'mon_fly', hp: 12, atk: 3, def: 1, sight: 7, speed: 1 });
  defineKind({ kind: 'gnoll', name: 'gnoll', spr: 'gnoll', anim: [0, 1], shape: 'sq', color: '#d9a45c',
    cdda: 'mon_cougar', hp: 16, atk: 4, def: 1, sight: 7, speed: 1 });
  defineKind({ kind: 'eye', name: 'eye', spr: 'eye', anim: [0, 4], shape: 'circle', color: '#ff6b6b',
    cdda: 'mon_science_bot', hp: 10, atk: 4, def: 1, sight: 9, speed: 1, ranged: true });
  defineKind({ kind: 'ghoul', name: 'ghoul', spr: 'ghoul', anim: [0, 2], shape: 'sq', color: '#a3c98a',
    cdda: 'mon_fungaloid_young', hp: 17, atk: 4, def: 1, sight: 6, speed: 2, flees: true });
  defineKind({ kind: 'brute', name: 'brute', spr: 'brute', anim: [0, 3], shape: 'sq', color: '#c084fc',
    cdda: 'mon_zombear', hp: 34, atk: 8, def: 3, sight: 6, speed: 1 });
  defineKind({ kind: 'golem', name: 'golem', spr: 'golem', anim: [0, 4], shape: 'sq', color: '#b9c3d4',
    cdda: 'mon_zomborg', hp: 26, atk: 5, def: 2, sight: 5, speed: 2 });
  defineKind({ kind: 'ghost', name: 'ghost', spr: 'ghost', anim: [0, 2], shape: 'circle', color: '#cfe6ff',
    cdda: 'mon_eigenspectre_1', hp: 22, atk: 6, def: 1, sight: 9, speed: 1 });
  defineKind({ kind: 'elemental', name: 'elemental', spr: 'elemental', anim: [2, 5], shape: 'circle', color: '#7cc7ff',
    cdda: 'mon_exodii_worker', hp: 30, atk: 7, def: 2, sight: 8, speed: 1, ranged: true });
  defineKind({ kind: 'warden', name: 'VAULT WARDEN', spr: 'vault_boss_elemental', anim: [0, 1], shape: 'circle', color: '#f472b6',
    cdda: 'mon_alpha_razorclaw', hp: 120, atk: 13, def: 6, sight: 12, speed: 1, boss: true });

  var SPAWN_TABLE = {
    1: [['rat', 0.60], ['bat', 0.40]],
    2: [['rat', 0.30], ['bat', 0.30], ['snake', 0.25], ['gnoll', 0.15]],
    3: [['bat', 0.15], ['snake', 0.25], ['gnoll', 0.30], ['eye', 0.15], ['ghoul', 0.15]],
    4: [['gnoll', 0.15], ['eye', 0.20], ['ghoul', 0.25], ['brute', 0.20], ['ghost', 0.20]],
    5: [['ghoul', 0.15], ['brute', 0.25], ['golem', 0.20], ['ghost', 0.20], ['elemental', 0.20]],
    6: [['brute', 0.20], ['golem', 0.25], ['ghost', 0.20], ['elemental', 0.35]]
  };

  function pickKind(depth) {
    var tbl = SPAWN_TABLE[Math.min(depth, 6)] || SPAWN_TABLE[6];
    var roll = rng(), acc = 0;
    for (var i = 0; i < tbl.length; i++) { acc += tbl[i][1]; if (roll <= acc) return tbl[i][0]; }
    return tbl[tbl.length - 1][0];
  }

  /* Loot — every floor pickup that is not raw scrap is a real Cataclysm: DDA
   * item: its name, price, weight and description come straight from the
   * table, and its icon is an SPD item-atlas cell chosen by category. */
  var LOOT = [];
  (function buildLoot() {
    var skip = /fake_|disconnected|prototype|machine|compressor|concentrator|containment|ammonia|nitrogen|glassblower|oxygen_|hd_|compact_ASRG|ammonia_/i;
    for (var i = 0; i < CDDA_ITEMS.length; i++) {
      var it = CDDA_ITEMS[i];
      if (!it || !it.id || !it.name) continue;
      if (skip.test(it.id)) continue;
      var price = +it.price_usd || 0;
      if (price <= 0 || price > 1200) continue;
      var cat = String(it.category || 'misc').toLowerCase();
      var row = {
        id: it.id, name: it.name, cat: cat, price: price,
        weight: +it.weight_g || 0, desc: String(it.description || '').replace(/\s+/g, ' ').trim()
      };
      LOOT.push(row);
    }
  })();

  function pickLoot(depth) {
    if (!LOOT.length) return null;
    var cap = depth <= 2 ? 60 : depth <= 4 ? 250 : 1200;
    var pool = [], i;
    for (i = 0; i < LOOT.length; i++) if (LOOT[i].price <= cap) pool.push(LOOT[i]);
    if (!pool.length) pool = LOOT;
    return pool[GK.ri(rng, 0, pool.length - 1)];
  }

  function spawnEnemy(kind, x, y) {
    var d = KINDS[kind];
    var scale = 1 + (G.depth - 1) * 0.18;
    G.actors.push({
      kind: kind, x: x, y: y, px: x, py: y,
      hp: Math.round(d.hp * scale), maxHp: Math.round(d.hp * scale),
      atk: Math.round(d.atk * scale), def: d.def,
      sight: d.sight, speed: d.speed || 1, tick: 0,
      awake: false, hurt: 0, phase: rng() * 6.28
    });
  }

  /* ------------------------------------------------------------------ *
   * FIELD OF VIEW — recursive shadowcasting, 8 octants.
   * ------------------------------------------------------------------ */
  var OCT = [[1, 0, 0, -1, -1, 0, 0, 1], [0, 1, -1, 0, 0, -1, 1, 0],
             [0, 1, 1, 0, 0, -1, -1, 0], [1, 0, 0, 1, -1, 0, 0, -1]];

  function computeFOV(cx, cy, radius) {
    G.vis.fill(0);
    G.vis[idx(cx, cy)] = 1; G.seen[idx(cx, cy)] = 1;
    for (var o = 0; o < 8; o++) {
      var m = OCT[o >> 1];
      castLight(cx, cy, 1, 1.0, 0.0, m[(o % 2) * 4], m[(o % 2) * 4 + 1], m[(o % 2) * 4 + 2], m[(o % 2) * 4 + 3], radius);
    }
  }

  function castLight(cx, cy, row, start, end, xx, xy, yx, yy, radius) {
    if (start < end) return;
    var newStart = 0;
    for (var j = row; j <= radius; j++) {
      var dx = -j - 1, dy = -j, blocked = false;
      while (dx <= 0) {
        dx++;
        var X = cx + dx * xx + dy * xy;
        var Y = cy + dx * yx + dy * yy;
        var lSlope = (dx - 0.5) / (dy + 0.5);
        var rSlope = (dx + 0.5) / (dy - 0.5);
        if (start < rSlope) continue;
        if (end > lSlope) break;
        if (dx * dx + dy * dy < radius * radius && inB(X, Y)) { G.vis[idx(X, Y)] = 1; G.seen[idx(X, Y)] = 1; }
        if (blocked) {
          if (inB(X, Y) && blocksSight(X, Y)) { newStart = rSlope; continue; }
          blocked = false; start = newStart;
        } else if (inB(X, Y) && blocksSight(X, Y) && j < radius) {
          blocked = true;
          castLight(cx, cy, j + 1, start, lSlope, xx, xy, yx, yy, radius);
          newStart = rSlope;
        }
      }
      if (blocked) break;
    }
  }

  function lineOfSight(x0, y0, x1, y1) {
    var dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx - dy;
    var x = x0, y = y0, guard = 0;
    while (guard++ < 200) {
      if (x === x1 && y === y1) return true;
      if (!(x === x0 && y === y0) && blocksSight(x, y)) return false;
      var e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * PATHING — BFS, uniform cost, 4-directional.
   * ------------------------------------------------------------------ */
  function pathStep(sx, sy, tx, ty) {
    if (sx === tx && sy === ty) return null;
    var prev = new Int32Array(W * H).fill(-1);
    var q = [idx(sx, sy)], head = 0;
    prev[idx(sx, sy)] = idx(sx, sy);
    var D = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (head < q.length) {
      var cur = q[head++], cx = cur % W, cy = (cur / W) | 0;
      for (var i = 0; i < 4; i++) {
        var nx = cx + D[i][0], ny = cy + D[i][1];
        if (!inB(nx, ny) || !isWalk(nx, ny)) continue;
        var ni = idx(nx, ny);
        if (prev[ni] !== -1) continue;
        prev[ni] = cur;
        if (nx === tx && ny === ty) { head = q.length; break; }
        q.push(ni);
      }
    }
    var goal = idx(tx, ty);
    if (prev[goal] === -1) return null;
    var step = goal;
    while (prev[step] !== idx(sx, sy) && prev[step] !== step) step = prev[step];
    return { x: step % W, y: (step / W) | 0 };
  }

  /* ------------------------------------------------------------------ *
   * TURN RESOLUTION
   * ------------------------------------------------------------------ */
  function enemyAt(x, y) {
    for (var i = 0; i < G.actors.length; i++) if (G.actors[i].x === x && G.actors[i].y === y && G.actors[i].hp > 0) return G.actors[i];
    return null;
  }

  function endTurns(n) {
    n = n || 1;
    for (var t = 0; t < n; t++) {
      G.turns++;
      G.energy = Math.min(G.maxEnergy, G.energy + (G.turns % 5 === 0 ? 1 : 0));
      enemiesAct();
      if (G.hp <= 0) { die(); return; }
    }
    computeFOV(G.player.x, G.player.y, 8);
  }

  function tryMove(dx, dy) {
    if (G.mode !== 'play') return false;
    var p = G.player;
    p.face = { x: dx, y: dy };
    var nx = p.x + dx, ny = p.y + dy;
    var foe = enemyAt(nx, ny);
    if (foe) { attack(foe); endTurns(1); return true; }
    if (!isWalk(nx, ny)) { log('Blocked.'); GK.buzz(6); return false; }
    p.x = nx; p.y = ny;
    GK.sfx.step();
    pickup(nx, ny);
    if (tileAt(nx, ny) === STAIRS) { descend(); return true; }
    endTurns(1);
    return true;
  }

  function walkTo(tx, ty) {
    var foe = enemyAt(tx, ty);
    if (foe) {
      var dx = foe.x - G.player.x, dy = foe.y - G.player.y;
      if (Math.abs(dx) + Math.abs(dy) === 1) { tryMove(dx, dy); return; }
      var s = pathStep(G.player.x, G.player.y, foe.x, foe.y);
      if (s) tryMove(s.x - G.player.x, s.y - G.player.y);
      return;
    }
    var step = pathStep(G.player.x, G.player.y, tx, ty);
    if (step) tryMove(step.x - G.player.x, step.y - G.player.y);
    else if (tileAt(tx, ty) === WALL) log('No route.');
  }

  function attack(foe) {
    var def = KINDS[foe.kind];
    if (Math.random() < 0.08) {
      foe.awake = true;
      sfx('miss', 0.4);
      log('You miss the ' + def.name + '.');
      return;
    }
    var dmg = Math.max(1, G.atk - foe.def + GK.ri(Math.random, -1, 1));
    foe.hp -= dmg; foe.hurt = 0.25; foe.awake = true;
    G.player.swing = 0.22;
    floatText(foe.x, foe.y, '-' + dmg, def.boss ? '#ff8b8b' : '#ffd08a');
    burst(foe.x, foe.y, '#ff9f43', 6);
    G.shake = Math.min(6, G.shake + 2);
    sfx(def.boss ? 'hit_strong' : 'hit_slash', 0.45);
    GK.buzz(10);
    log('You hit the ' + def.name + ' for ' + dmg + '.');
    if (foe.hp <= 0) killEnemy(foe);
  }

  function killEnemy(foe) {
    foe.hp = 0;
    G.kills++;
    var def = KINDS[foe.kind];
    var drop = foe.kind === 'warden' ? 40 : GK.ri(Math.random, 1, 3) + Math.floor(G.depth * 0.8);
    G.scrap += drop;
    floatText(foe.x, foe.y, '+' + drop + ' scrap', '#f0b429');
    burst(foe.x, foe.y, def.color, 16);
    sfx(def.boss ? 'boss' : 'death', 0.5);
    log(def.name + ' scrapped (+' + drop + ' scrap).');
    // some corpses leave salvage behind
    if (Math.random() < 0.3) {
      var li = pickLoot(G.depth);
      if (li && !G.items.some(function (it) { return it.x === foe.x && it.y === foe.y; }))
        G.items.push({ kind: 'item', x: foe.x, y: foe.y, item: li, phase: Math.random() * 6.28 });
    }
    if (foe.kind === 'warden') victory();
  }

  function fire() {
    if (G.mode !== 'play') return;
    if (G.energy <= 0) { log('No charge. WAIT to recharge.'); GK.buzz(8); return; }
    G.energy--;
    var p = G.player, x = p.x, y = p.y, dx = p.face.x, dy = p.face.y;
    var hit = null, dist = 0;
    for (var i = 0; i < 10; i++) {
      x += dx; y += dy; dist++;
      if (!inB(x, y) || blocksSight(x, y)) break;
      var foe = enemyAt(x, y);
      if (foe) { hit = foe; break; }
    }
    G.beam = { x0: p.x, y0: p.y, x1: x, y1: y, t: 0.16 };
    sfx('zap', 0.4);
    if (hit) {
      var dmg = G.atk + 3 + GK.ri(Math.random, 0, 2);
      hit.hp -= dmg; hit.hurt = 0.25; hit.awake = true;
      burst(hit.x, hit.y, '#ffd166', 10);
      sfx('hit_magic', 0.35);
      log('Bolt hits the ' + KINDS[hit.kind].name + ' for ' + dmg + '.');
      if (hit.hp <= 0) killEnemy(hit);
    } else if (dist > 1) log('Bolt scorches the wall.');
    endTurns(1);
  }

  function pickup(x, y) {
    for (var i = 0; i < G.items.length; i++) {
      var it = G.items[i];
      if (it.x !== x || it.y !== y || it.used) continue;
      if (it.kind === 'scrap') {
        G.scrap += it.amount; it.used = true;
        sfx('gold', 0.35); burst(x, y, '#f0b429', 5);
        log('+' + it.amount + ' scrap.');
      } else if (it.kind === 'item') {
        it.used = true;
        var res = itemEffect(it.item);
        G.carry.unshift({ name: it.item.name, cat: it.item.cat });
        if (G.carry.length > 6) G.carry.pop();
        G.tip = {
          name: it.item.name,
          sub: '$' + it.item.price + ' · ' + Math.round(it.item.weight) + ' g · +' + res.scrap + ' scrap',
          desc: it.item.desc, t: 5
        };
        sfx('item', 0.4); burst(x, y, '#7cc7ff', 6);
        log('Picked up ' + it.item.name + res.txt + '.');
      } else if (it.kind === 'cache') {
        it.used = true;
        var roll = rng();
        if (roll < 0.34) { G.atk += 2; log('CACHE: weapon core (+2 ATK).'); }
        else if (roll < 0.67) { G.armor += 2; log('CACHE: plate layer (+2 ARMOR).'); }
        else { G.maxHp += 12; G.hp = Math.min(G.maxHp, G.hp + 12); log('CACHE: repair rig (+12 MAX HP).'); }
        G.scrap += 6;
        sfx('levelup', 0.45); burst(x, y, '#4de2c0', 20);
      }
    }
    G.items = G.items.filter(function (it) { return !it.used; });
  }

  /* What a salvaged C:DDA item does when it goes into the pack. Price sets
   * the scrap it breaks down into; category sets the small bonus. */
  function itemEffect(it) {
    var txt = '';
    var v = GK.clamp(Math.round((it.price || 1) / 10), 1, 60);
    if (it.cat === 'drugs' || it.cat === 'firstaid') {
      var heal = it.price >= 200 ? 30 : 14;
      var before = G.hp;
      G.hp = Math.min(G.maxHp, G.hp + heal);
      txt = ' +' + Math.round(G.hp - before) + ' HP';
    } else if (it.cat === 'tool_magazine') {
      G.energy = Math.min(G.maxEnergy, G.energy + 2);
      txt = ' +2 charge';
    } else if (it.cat === 'weapons' && G.atk < 26) {
      G.atk += 1; txt = ' +1 ATK';
    } else if ((it.cat === 'armor' || it.cat === 'clothing') && G.armor < 12) {
      G.armor += 1; txt = ' +1 ARM';
    }
    G.scrap += v;
    return { scrap: v, txt: txt };
  }

  function descend() {
    G.depth++;
    if (G.depth > G.best) { G.best = G.depth; store.set('bestDepth', G.best); }
    G.hp = Math.min(G.maxHp, G.hp + 8);
    G.energy = G.maxEnergy;
    genFloor(G.depth, G.seed);
    log('Sector ' + G.depth + ': ' + G.palette.name + '.');
    sfx('descend', 0.45);
    musicPlay(G.depth >= 6 ? 'tense' : 'vault');
    if (G.depth >= 6) log('Something enormous is breathing in here.');
    saveRun();
  }

  function enemiesAct() {
    var p = G.player;
    for (var i = 0; i < G.actors.length; i++) {
      var a = G.actors[i];
      if (a.hp <= 0) continue;
      a.tick++;
      if (a.tick % a.speed !== 0) continue;
      var def = KINDS[a.kind];
      var dx = p.x - a.x, dy = p.y - a.y;
      var dist = Math.abs(dx) + Math.abs(dy);
      var sees = dist <= a.sight && lineOfSight(a.x, a.y, p.x, p.y);
      if (!a.awake && sees) a.awake = true;
      if (!a.awake) {
        if (Math.random() < 0.15) randomStep(a);
        continue;
      }
      if (def.ranged) {
        if (sees && dist <= 7 && a.tick % 2 === 0) rangedShot(a);
        else if (sees && dist > 4) stepToward(a, p.x, p.y);
        continue;
      }
      if (def.boss) { wardenAct(a, dist, sees); continue; }
      if (dist === 1) { enemyAttack(a); continue; }
      if (def.flees && a.hp < a.maxHp * 0.45 && dist < 6) { fleeStep(a); continue; }
      if (sees) stepToward(a, p.x, p.y);
      else if (def.erratic && Math.random() < 0.6) randomStep(a);
      else if (Math.random() < 0.5 && dist < 14) stepToward(a, p.x, p.y);
    }
  }

  function wardenAct(a, dist, sees) {
    if (dist === 1) { enemyAttack(a); return; }
    if (a.tick % 15 === 0 && G.actors.filter(function (x) { return x.kind === 'bat' && x.hp > 0; }).length < 5) {
      spawnEnemy('bat', a.x, a.y); log('The Warden vents a swarm of bats.');
    }
    if (sees && dist <= 5 && a.tick % 9 === 0) {
      var dmg = Math.max(2, 8 - G.armor);
      hurtPlayer(dmg, 'a plasma surge');
      burst(G.player.x, G.player.y, '#f472b6', 14);
      return;
    }
    if (sees) stepToward(a, G.player.x, G.player.y);
  }

  function rangedShot(a) {
    var def = KINDS[a.kind];
    var dmg = Math.max(1, a.atk - G.armor);
    hurtPlayer(dmg, 'a ' + def.name);
    burst(G.player.x, G.player.y, def.color, 8);
    G.shake = Math.min(7, G.shake + 2);
  }

  function enemyAttack(a) {
    var dmg = Math.max(1, a.atk - G.armor);
    hurtPlayer(dmg, 'a ' + KINDS[a.kind].name);
    G.shake = Math.min(9, G.shake + 3);
  }

  function hurtPlayer(dmg, from) {
    G.hp -= dmg;
    G.flash = 0.25;
    sfx('hit_crush', 0.35); GK.buzz(18);
    log('Hit by ' + from + ' for ' + dmg + '.');
    if (G.hp <= 0) die();
  }

  function stepToward(a, tx, ty) {
    var s = pathStep(a.x, a.y, tx, ty);
    if (s && !enemyAt(s.x, s.y) && !(s.x === G.player.x && s.y === G.player.y)) { a.x = s.x; a.y = s.y; return true; }
    var dx = Math.sign(tx - a.x), dy = Math.sign(ty - a.y);
    var opts = [[dx, 0], [0, dy], [dx, dy]];
    for (var i = 0; i < opts.length; i++) {
      var nx = a.x + opts[i][0], ny = a.y + opts[i][1];
      if (isWalk(nx, ny) && !enemyAt(nx, ny) && !(nx === G.player.x && ny === G.player.y) && (nx !== a.x || ny !== a.y)) { a.x = nx; a.y = ny; return true; }
    }
    return false;
  }
  function fleeStep(a) {
    var best = null, bd = -1;
    var D = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (var i = 0; i < 4; i++) {
      var nx = a.x + D[i][0], ny = a.y + D[i][1];
      if (!isWalk(nx, ny) || enemyAt(nx, ny)) continue;
      var d = Math.abs(nx - G.player.x) + Math.abs(ny - G.player.y);
      if (d > bd) { bd = d; best = { x: nx, y: ny }; }
    }
    if (best) { a.x = best.x; a.y = best.y; }
  }
  function randomStep(a) {
    var D = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    var d = D[Math.floor(Math.random() * 4)];
    var nx = a.x + d[0], ny = a.y + d[1];
    if (isWalk(nx, ny) && !enemyAt(nx, ny) && !(nx === G.player.x && ny === G.player.y)) { a.x = nx; a.y = ny; }
  }

  /* ------------------------------------------------------------------ *
   * CRAFTING — the Mindustry loop: scrap is the only currency. Every entry
   * is a real Cataclysm: DDA recipe (result id + component list), so the
   * fabricator reads like the game it came from; the effect stays
   * Vaultbreak's. The authored component strings are the fallback.
   * ------------------------------------------------------------------ */
  function compLabel(rec) {
    if (!rec || !rec.components) return '';
    var parts = [];
    for (var i = 0; i < rec.components.length && parts.length < 3; i++) {
      var c = rec.components[i] || {};
      var any = c.any_of || [];
      if (!any.length) continue;
      var id = any[0], n = 1;
      if (typeof c.count === 'number') n = c.count;
      else if (c.count && c.count.length) { id = c.count[0] || id; n = +c.count[1] || 1; }
      var label = String(id).replace(/_/g, ' ').trim();
      if (n > 1) label += ' ×' + n;
      parts.push(label);
    }
    return parts.join(' · ');
  }

  var RECIPES = [
    { id: 'bandages', name: 'Bandages', cost: 5, desc: '+26 HP', icon: 'drugs',
      comps: 'cotton patchwork · medical tape ×5 · disinfectant',
      can: function () { return G.hp < G.maxHp; },
      run: function () { G.hp = Math.min(G.maxHp, G.hp + 26); } },
    { id: 'foot_locker_recharge_station', name: 'Recharge Station', cost: 4, desc: '+3 charge', icon: 'crystal',
      comps: 'frame · recharge station',
      can: function () { return G.energy < G.maxEnergy; },
      run: function () { G.energy = Math.min(G.maxEnergy, G.energy + 3); } },
    { id: 'pillow', name: 'Pillow Padding', cost: 9, desc: '+2 ARMOR (permanent)', icon: 'armor',
      comps: 'cotton patchwork · cotton ball',
      can: function () { return G.armor < 12; },
      run: function () { G.armor += 2; } },
    { id: 'napalm', name: 'Napalm', cost: 14, desc: '+3 ATK (permanent)', icon: 'traps',
      comps: 'diesel ×125 · plastic chunk · bleach · oxidizer powder',
      can: function () { return G.atk < 26; },
      run: function () { G.atk += 3; } }
  ];
  (function enrichRecipes() {
    for (var i = 0; i < RECIPES.length; i++) {
      var r = RECIPES[i], rec = null;
      for (var j = 0; j < CDDA_REC.length; j++) if (CDDA_REC[j].result === r.id) { rec = CDDA_REC[j]; break; }
      if (!rec) continue;
      var label = compLabel(rec);
      if (label) r.comps = label;
      r.skill = rec.skill_used || '';
      r.cdda = true;
    }
  })();

  function craft(id) {
    var r = RECIPES.filter(function (x) { return x.id === id; })[0];
    if (!r) return false;
    if (G.scrap < r.cost) { log('Need ' + r.cost + ' scrap.'); GK.buzz(10); return false; }
    if (!r.can()) { log('Nothing to repair there.'); return false; }
    G.scrap -= r.cost; r.run();
    sfx('unlock', 0.4); log('Crafted ' + r.name + '.');
    saveRun();
    return true;
  }

  /* ------------------------------------------------------------------ *
   * RUN STATE
   * ------------------------------------------------------------------ */
  function newRun(seed) {
    G.seed = seed || (Date.now() % 100000);
    G.depth = 1; G.turns = 0; G.kills = 0; G.scrap = 0;
    G.energy = 8; G.maxEnergy = 8; G.atk = 4; G.armor = 0; G.hp = 60; G.maxHp = 60;
    G.log = []; G.mode = 'play'; G.shake = 0; G.flash = 0; G.wardenSpawned = false;
    G.carry = []; G.tip = null; G.hover = null;
    genFloor(1, G.seed);
    log('You cut into sector 1. Tap a tile to move.');
    musicPlay('vault');
    saveRun();
  }

  function score() { return G.depth * 120 + G.kills * 15 + G.scrap + (G.victoryFlag ? 1500 : 0); }

  function die() {
    if (G.mode === 'dead') return;
    G.mode = 'dead';
    G.hp = 0;
    sfx('death', 0.5);
    var s = score();
    if (s > G.bestScore) { G.bestScore = s; store.set('bestScore', s); }
    store.set('run', null);
  }

  function victory() {
    G.victoryFlag = true;
    G.mode = 'win';
    sfx('levelup', 0.5); GK.sfx.win();
    var s = score();
    if (s > G.bestScore) { G.bestScore = s; store.set('bestScore', s); }
    store.set('run', null);
    store.set('cleared', true);
  }

  function saveRun() {
    if (G.mode !== 'play') return;
    store.set('run', {
      seed: G.seed, depth: G.depth, turns: G.turns, kills: G.kills, scrap: G.scrap,
      hp: G.hp, maxHp: G.maxHp, energy: G.energy, atk: G.atk, armor: G.armor,
      x: G.player.x, y: G.player.y, at: Date.now()
    });
  }

  function resumeRun() {
    var r = store.get('run', null);
    if (!r || !r.seed) return false;
    G.seed = r.seed; G.depth = r.depth; G.turns = r.turns; G.kills = r.kills;
    G.scrap = r.scrap; G.atk = r.atk; G.armor = r.armor;
    G.hp = r.hp; G.maxHp = r.maxHp; G.energy = r.energy;
    G.mode = 'play'; G.log = []; G.victoryFlag = false;
    G.carry = []; G.tip = null; G.hover = null;
    genFloor(r.depth, r.seed);
    // drop the player where they left off if that tile is still walkable
    if (isWalk(r.x, r.y)) { G.player.x = r.x; G.player.y = r.y; }
    computeFOV(G.player.x, G.player.y, 8);
    log('Resumed sector ' + G.depth + '.');
    musicPlay(G.depth >= 6 ? 'tense' : 'vault');
    return true;
  }

  /* ------------------------------------------------------------------ *
   * PARTICLES
   * ------------------------------------------------------------------ */
  function burst(x, y, color, n) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, sp = 1 + Math.random() * 3.2;
      G.parts.push({ x: x + 0.5, y: y + 0.5, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.45 + Math.random() * 0.3, max: 0.75, c: color });
    }
    if (G.parts.length > 400) G.parts.splice(0, G.parts.length - 400);
  }

  /* ------------------------------------------------------------------ *
   * RENDER
   * ------------------------------------------------------------------ */
  var canvas = document.getElementById('c');

  /* Tiles are sized so ~14 columns are visible and the floor's full height fits
   * under the HUD: bigger, thumb-friendly tiles that pan instead of shrinking
   * into a postage stamp. */
  var HUD_TOP = 78, HUD_BOTTOM = 46;

  function tileSize(view) {
    var availH = Math.max(120, view.h - HUD_TOP - HUD_BOTTOM);
    var t = Math.min(view.w / 14, availH / H);
    return GK.clamp(t, 14, 64);
  }

  function camera(view, ts) {
    var p = G.player;
    var cx = p.px + 0.5, cy = p.py + 0.5;
    var viewW = view.w / ts, viewH = Math.max(120, view.h - HUD_TOP - HUD_BOTTOM) / ts;
    var tx, ty;
    // centre the floor on an axis where it is smaller than the viewport
    tx = viewW >= W ? -(viewW - W) / 2 : GK.clamp(cx - viewW / 2, 0, W - viewW);
    ty = viewH >= H ? -(viewH - H) / 2 : GK.clamp(cy - viewH / 2, 0, H - viewH);
    G.cam.x = GK.lerp(G.cam.x, tx, 0.25);
    G.cam.y = GK.lerp(G.cam.y, ty, 0.25);
    return { x: G.cam.x, y: G.cam.y };
  }

  function hash(x, y) {
    var h = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) & 0xffff) / 65535;
  }

  function draw(ctx, t, view) {
    var pal = G.palette;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, view.w, view.h);

    if (G.mode === 'title') { drawTitle(ctx, view, t); return; }

    var ts = tileSize(view);
    var shakeX = 0, shakeY = 0;
    if (G.shake > 0.1) {
      shakeX = (Math.random() - 0.5) * G.shake;
      shakeY = (Math.random() - 0.5) * G.shake;
    }
    var cam = camera(view, ts);
    ctx.save();
    ctx.translate(Math.round(-cam.x * ts + shakeX), Math.round(HUD_TOP - cam.y * ts + shakeY));

    var terr = terrainFor(G.depth);
    var x0 = Math.max(0, Math.floor(cam.x) - 1), x1 = Math.min(W, Math.ceil(cam.x + view.w / ts) + 1);
    var y0 = Math.max(0, Math.floor(cam.y) - 1), y1 = Math.min(H, Math.ceil(cam.y + view.h / ts) + 1);

    for (var y = y0; y < y1; y++) {
      for (var x = x0; x < x1; x++) {
        var i = idx(x, y);
        if (!G.seen[i]) continue;
        var lit = G.vis[i];
        var px = x * ts, py = y * ts, tt = G.map[i];

        if (tt === WALL) {
          if (terr && terr.ready && terr.img) {
            /* real SPD masonry from the region atlas; the hash picks the alt variant
               so long walls do not repeat a single cell */
            tileBlit(ctx, terr, hash(x * 3, y * 7) > 0.78 ? TILE_WALL_ALT : TILE_WALL, px, py, ts);
            ctx.fillStyle = 'rgba(0,0,0,.18)';
            ctx.fillRect(px, py + ts - Math.max(1, ts * 0.1), ts, Math.max(1, ts * 0.1));
          } else {
            ctx.fillStyle = lit ? pal.wall : GK.shade(pal.wall, -18);
            ctx.fillRect(px, py, ts, ts);
            ctx.fillStyle = lit ? pal.wallTop : GK.shade(pal.wallTop, -20);
            ctx.fillRect(px, py, ts, Math.max(2, ts * 0.16));
            ctx.fillStyle = 'rgba(0,0,0,.22)';
            ctx.fillRect(px, py + ts - Math.max(1, ts * 0.1), ts, Math.max(1, ts * 0.1));
          }
        } else {
          var hv = hash(x, y);
          if (terr && terr.ready && terr.img) {
            tileBlit(ctx, terr,
              hv > 0.9 ? TILE_FLOOR_2 : hv > 0.74 ? TILE_FLOOR_1 : TILE_FLOOR_0, px, py, ts);
          } else {
            ctx.fillStyle = lit ? pal.floor : GK.shade(pal.floor, -8);
            ctx.fillRect(px, py, ts, ts);
          }
          if (hv > 0.72 && !(terr && terr.ready)) {
            ctx.fillStyle = 'rgba(255,255,255,' + (lit ? 0.045 : 0.02) + ')';
            var n = 1 + ((hv * 7) | 0) % 3;
            for (var d = 0; d < n; d++) {
              var dx2 = hash(x + d * 13, y * 7 + d) * ts * 0.8 + ts * 0.1;
              var dy2 = hash(x * 5 + d, y + d * 11) * ts * 0.8 + ts * 0.1;
              ctx.fillRect(px + dx2, py + dy2, Math.max(1, ts * 0.06), Math.max(1, ts * 0.06));
            }
          }
          if (tt === STAIRS) {
            var pulse = 0.55 + Math.sin(t * 3) * 0.2;
            ctx.fillStyle = 'rgba(77,226,192,' + (lit ? pulse * 0.35 : 0.1) + ')';
            ctx.fillRect(px, py, ts, ts);
            ctx.strokeStyle = lit ? '#4de2c0' : '#1d5a4d';
            ctx.lineWidth = Math.max(1.5, ts * 0.06);
            ctx.strokeRect(px + ts * 0.18, py + ts * 0.18, ts * 0.64, ts * 0.64);
            ctx.beginPath();
            ctx.moveTo(px + ts * 0.32, py + ts * 0.5); ctx.lineTo(px + ts * 0.5, py + ts * 0.34);
            ctx.lineTo(px + ts * 0.68, py + ts * 0.5); ctx.stroke();
          }
        }
        if (!lit) { ctx.fillStyle = 'rgba(4,5,8,.58)'; ctx.fillRect(px, py, ts, ts); }
      }
    }

    // items — SPD item-atlas icons over a soft glow
    for (var k = 0; k < G.items.length; k++) {
      var it = G.items[k];
      if (!G.seen[idx(it.x, it.y)]) continue;
      var glow = 0.6 + Math.sin(t * 3 + it.phase) * 0.4;
      var ix = it.x * ts + ts * 0.5, iy = it.y * ts + ts * 0.5;
      var tint = it.kind === 'scrap' ? '240,180,41' : it.kind === 'cache' ? '77,226,192' : '124,199,255';
      ctx.fillStyle = 'rgba(' + tint + ',' + (0.20 * glow) + ')';
      ctx.beginPath(); ctx.arc(ix, iy, ts * 0.44, 0, 6.2832); ctx.fill();
      var iconKey = it.kind === 'item' ? it.item.cat : it.kind;
      if (!drawIcon(ctx, iconKey, it.x * ts + ts * 0.1, it.y * ts + ts * 0.1, ts * 0.8)) {
        ctx.fillStyle = it.kind === 'scrap' ? '#f0b429' : '#4de2c0';
        ctx.fillRect(ix - ts * 0.14, iy - ts * 0.14, ts * 0.28, ts * 0.28);
      }
    }

    // bolt beam
    if (G.beam && G.beam.t > 0) {
      ctx.strokeStyle = 'rgba(255,209,102,' + (G.beam.t / 0.16) + ')';
      ctx.lineWidth = Math.max(2, ts * 0.12);
      ctx.beginPath();
      ctx.moveTo((G.beam.x0 + 0.5) * ts, (G.beam.y0 + 0.5) * ts);
      ctx.lineTo((G.beam.x1 + 0.5) * ts, (G.beam.y1 + 0.5) * ts);
      ctx.stroke();
    }

    // actors — interpolate display position toward grid position
    /* Torchlight: everything past the player's reach falls into a soft well of shadow, which
       both frames the hero and makes lit/unlit tiles read apart instead of one flat grey. */
    if (G.player) {
      var sx = (G.player.px + 0.5) * ts, sy = (G.player.py + 0.5) * ts;
      var reach = ts * 7.2;
      var lit2 = ctx.createRadialGradient(sx, sy, ts * 0.8, sx, sy, reach);
      lit2.addColorStop(0, 'rgba(6,8,12,0)');
      lit2.addColorStop(0.55, 'rgba(6,8,12,.10)');
      lit2.addColorStop(0.82, 'rgba(6,8,12,.34)');
      lit2.addColorStop(1, 'rgba(6,8,12,.58)');
      ctx.fillStyle = lit2;
      ctx.fillRect(sx - reach, sy - reach, reach * 2, reach * 2);
    }

    for (var a = 0; a < G.actors.length; a++) {
      var ac = G.actors[a];
      if (ac.hp <= 0) continue;
      var seenNow = G.vis[idx(ac.x, ac.y)];
      if (!seenNow && !G.seen[idx(ac.x, ac.y)]) continue;
      ac.px = GK.lerp(ac.px, ac.x, 0.28);
      ac.py = GK.lerp(ac.py, ac.y, 0.28);
      ac.hurt = Math.max(0, ac.hurt - 0.016);
      drawEnemy(ctx, ac, ts, seenNow, t);
    }

    var p = G.player;
    p.px = GK.lerp(p.px, p.x, 0.3);
    p.py = GK.lerp(p.py, p.y, 0.3);
    drawPlayer(ctx, p, ts, t);

    // particles
    for (var q = 0; q < G.parts.length; q++) {
      var pt = G.parts[q];
      ctx.globalAlpha = Math.max(0, pt.life / pt.max);
      ctx.fillStyle = pt.c;
      var sz = Math.max(1.5, ts * 0.1);
      ctx.fillRect(pt.x * ts - sz / 2, pt.y * ts - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;

    for (var fj = 0; fj < G.floats.length; fj++) {
      var ft = G.floats[fj], fk = ft.t / ft.life;
      ctx.globalAlpha = Math.max(0, 1 - fk * fk);
      ctx.font = '800 ' + Math.max(11, Math.round(ts * 0.44)) + 'px ui-monospace,SFMono-Regular,Menlo,monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,.62)';
      ctx.fillText(ft.text, ft.x * ts + 1.5, (ft.y - fk * 0.75) * ts + 1.5);
      ctx.fillStyle = ft.c;
      ctx.fillText(ft.text, ft.x * ts, (ft.y - fk * 0.75) * ts);
      ctx.textAlign = 'left';
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // depth: vignette frames the play field, dust gives the air something in it
    if (G.mode === 'play' || G.mode === 'craft') {
      var vg = ctx.createRadialGradient(view.w / 2, view.h / 2, Math.min(view.w, view.h) * 0.34,
                                        view.w / 2, view.h / 2, Math.max(view.w, view.h) * 0.78);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,0,0,.46)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, view.w, view.h);
      for (var dj = 0; dj < G.dust.length; dj++) {
        var dd = G.dust[dj];
        ctx.globalAlpha = dd.a;
        ctx.fillStyle = '#ffe9b8';
        ctx.beginPath();
        ctx.arc(dd.x * view.w, dd.y * view.h, dd.r, 0, 6.2832);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    drawHUD(ctx, view, ts);
    if (G.mode === 'craft') drawCraft(ctx, view);
    if (G.mode === 'dead') drawEnd(ctx, view, false);
    if (G.mode === 'win') drawEnd(ctx, view, true);
    if (G.mode === 'help') drawHelp(ctx, view);
    if (G.flash > 0) {
      ctx.fillStyle = 'rgba(255,60,60,' + Math.min(0.35, G.flash) + ')';
      ctx.fillRect(0, 0, view.w, view.h);
    }
  }

  function drawPlayer(ctx, p, ts, t) {
    var cx = p.px * ts + ts / 2, cy = p.py * ts + ts / 2;
    var fx = p.face.x || 0, fy = p.face.y || 0;

    // grounding: a soft shadow at the feet, then a warmth halo so the hero reads against grey stone
    ctx.fillStyle = 'rgba(0,0,0,.34)';
    ctx.beginPath();
    if (ctx.ellipse) ctx.ellipse(cx, cy + ts * 0.34, ts * 0.34, ts * 0.16, 0, 0, 6.2832);
    else ctx.arc(cx, cy + ts * 0.34, ts * 0.2, 0, 6.2832);
    ctx.fill();
    var glow = ctx.createRadialGradient(cx, cy, ts * 0.08, cx, cy, ts * 0.95);
    glow.addColorStop(0, 'rgba(255,214,138,.22)');
    glow.addColorStop(1, 'rgba(255,214,138,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(cx - ts, cy - ts, ts * 2, ts * 2);

    var flashed = (p.hurt > 0) || G.flash > 0;
    var drew = false;
    if (HERO_SPR && HERO_SPR.ready && HERO_SPR.img) {
      var h = HERO_SPR.h;
      // one figure, moved not swapped: each cell is a different character, so bob and lean
      var bob = Math.sin(t * (G.mode === 'play' ? 4.4 : 1.5)) * ts * 0.022;
      var d = Math.round(ts * 1.22);
      var dx = Math.floor(cx - d / 2), dy = Math.floor(cy - d / 2 - ts * 0.08 + bob);
      ctx.save();
      if (fx < 0) { ctx.translate(cx, 0); ctx.scale(-1, 1); ctx.translate(-cx, 0); }
      ctx.drawImage(HERO_SPR.img, 0, 0, h, h, dx, dy, d, d);
      ctx.restore();
      if (flashed) {
        ctx.fillStyle = 'rgba(255,86,86,.4)';
        ctx.fillRect(dx, dy, d, d);
      }
      drew = true;
    }

    // authored fallback: still a character, never a bare square with eyes
    if (!drew) {
      var m = ts * 0.14;
      ctx.fillStyle = '#2b1d08';
      ctx.fillRect(cx - ts * 0.3, cy - ts * 0.1, ts * 0.6, ts * 0.5);
      ctx.fillStyle = flashed ? '#ffd0d0' : '#f0b429';
      ctx.fillRect(cx - ts * 0.24, cy - ts * 0.34, ts * 0.48, ts * 0.42);
      ctx.fillStyle = '#1a1205';
      ctx.fillRect(cx - ts * 0.14 + fx * ts * 0.04, cy - ts * 0.22, ts * 0.1, ts * 0.1);
      ctx.fillRect(cx + ts * 0.04 + fx * ts * 0.04, cy - ts * 0.22, ts * 0.1, ts * 0.1);
      ctx.fillStyle = '#8a5a12';
      ctx.fillRect(cx - m, cy + ts * 0.36, ts * 0.28, ts * 0.08);
    }

    // swing arc: the hit has to be visible, not only audible
    if (p.swing > 0) {
      var k = Math.max(0, Math.min(1, p.swing / 0.22));
      var ang = Math.atan2(fy || 0.001, fx || (fx === 0 ? 1 : fx));
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ang);
      ctx.strokeStyle = 'rgba(255,232,176,' + (0.9 * k).toFixed(3) + ')';
      ctx.lineWidth = Math.max(2, ts * 0.13);
      ctx.beginPath();
      ctx.arc(0, 0, ts * (0.44 + (1 - k) * 0.55), -0.85 + (1 - k) * 0.55, 0.45 + (1 - k) * 0.55);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawEnemy(ctx, a, ts, lit, t) {
    var def = KINDS[a.kind];
    var x = a.px * ts, y = a.py * ts;
    ctx.globalAlpha = lit ? 1 : 0.45;
    var cx = x + ts / 2, cy = y + ts / 2;
    var drew = false;

    // real SPD sprite: horizontal sheet, two-frame idle step
    var spr = def.spr ? SPR[def.spr] : null;
    if (spr && spr.ready && spr.img) {
      var h = spr.h, frames = Math.max(1, spr.frames);
      var pair = def.anim || [0, 1];
      var f = pair[((t * 3.2 + a.phase) | 0) % 2] % frames;
      var scale = Math.max(1, Math.round(ts / h));
      var d = h * scale;
      if (d > ts * 1.35) d = Math.round(ts);   // 64/128px sheets fit the cell
      var dx = Math.round(cx - d / 2), dy = Math.round(cy - d / 2);
      ctx.drawImage(spr.img, f * h, 0, h, h, dx, dy, d, d);
      drew = true;
      if (a.hurt > 0) {
        ctx.fillStyle = 'rgba(255,255,255,.45)';
        ctx.fillRect(dx, dy, d, d);
      }
    }

    // authored vector fallback (bundle missing, or sprite still decoding)
    if (!drew) {
      ctx.fillStyle = a.hurt > 0 ? '#ffffff' : def.color;
      if (def.shape === 'tri') {
        ctx.beginPath();
        ctx.moveTo(cx, cy - ts * 0.3); ctx.lineTo(cx + ts * 0.3, cy + ts * 0.26);
        ctx.lineTo(cx - ts * 0.3, cy + ts * 0.26); ctx.closePath(); ctx.fill();
      } else if (def.shape === 'diamond') {
        ctx.beginPath();
        ctx.moveTo(cx, cy - ts * 0.32); ctx.lineTo(cx + ts * 0.3, cy);
        ctx.lineTo(cx, cy + ts * 0.32); ctx.lineTo(cx - ts * 0.3, cy); ctx.closePath(); ctx.fill();
      } else if (def.shape === 'sq') {
        ctx.fillRect(cx - ts * 0.32, cy - ts * 0.32, ts * 0.64, ts * 0.64);
        ctx.fillStyle = 'rgba(0,0,0,.4)';
        ctx.fillRect(cx - ts * 0.12, cy - ts * 0.1, ts * 0.24, ts * 0.2);
      } else {
        var pulse = 1 + Math.sin(t * 2.4) * 0.05;
        ctx.beginPath();
        ctx.arc(cx, cy, ts * 0.42 * pulse, 0, 6.2832); ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,.45)';
        ctx.beginPath(); ctx.arc(cx, cy, ts * 0.2, 0, 6.2832); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillRect(cx - ts * 0.14, cy - ts * 0.05, ts * 0.08, ts * 0.08);
        ctx.fillRect(cx + ts * 0.06, cy - ts * 0.05, ts * 0.08, ts * 0.08);
      }
    }
    if (a.hp < a.maxHp) {
      var bw = ts * 0.7, bh = Math.max(2, ts * 0.08);
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      ctx.fillRect(cx - bw / 2, y + ts * 0.04, bw, bh);
      ctx.fillStyle = a.hp / a.maxHp > 0.4 ? '#7cf59a' : '#ff6b6b';
      ctx.fillRect(cx - bw / 2, y + ts * 0.04, bw * Math.max(0, a.hp / a.maxHp), bh);
    }
    ctx.globalAlpha = 1;
  }

  function clipText(ctx, s, maxW) {
    s = String(s);
    if (ctx.measureText(s).width <= maxW) return s;
    while (s.length > 3 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }
  function wrapText(ctx, s, maxW, maxLines) {
    var words = String(s).split(' '), lines = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var t2 = cur ? cur + ' ' + words[i] : words[i];
      if (ctx.measureText(t2).width > maxW && cur) {
        lines.push(cur); cur = words[i];
        if (lines.length >= maxLines) break;
      } else cur = t2;
    }
    if (lines.length < maxLines && cur) lines.push(cur);
    if (lines.length) lines[lines.length - 1] = clipText(ctx, lines[lines.length - 1], maxW);
    return lines;
  }
  function itemAt(x, y) {
    for (var i = 0; i < G.items.length; i++) if (G.items[i].x === x && G.items[i].y === y) return G.items[i];
    return null;
  }
  function tipFor(it) {
    if (!it) return null;
    if (it.kind === 'item') {
      return {
        name: it.item.name,
        sub: '$' + it.item.price + ' · ' + Math.round(it.item.weight) + ' g · ' + it.item.cat,
        desc: it.item.desc
      };
    }
    if (it.kind === 'scrap') {
      return { name: 'scrap', sub: '×' + it.amount + ' · fabricator stock', desc: 'Salvaged plating, cut and sorted. The only currency down here.' };
    }
    return { name: 'supply cache', sub: 'one-time upgrade', desc: 'A sealed locker: weapon core, plate layer or repair rig.' };
  }

  function drawHUD(ctx, view, ts) {
    var pad = 10, top = pad + (parseFloat(getComputedStyle(document.body).paddingTop) || 0);
    ctx.font = '600 12px system-ui,sans-serif';
    // hp bar
    var bw = Math.min(220, view.w * 0.5), bh = 14;
    ctx.fillStyle = 'rgba(8,10,14,.78)';
    ctx.fillRect(pad, top, bw, bh);
    ctx.fillStyle = G.hp / G.maxHp > 0.35 ? '#3ddc84' : '#ff5c5c';
    ctx.fillRect(pad + 1, top + 1, (bw - 2) * GK.clamp(G.hp / G.maxHp, 0, 1), bh - 2);
    ctx.fillStyle = '#08110a';
    ctx.fillText(Math.max(0, Math.ceil(G.hp)) + '/' + G.maxHp, pad + 7, top + 10);

    // energy pips
    for (var i = 0; i < G.maxEnergy; i++) {
      ctx.fillStyle = i < G.energy ? '#4de2ff' : 'rgba(120,140,160,.25)';
      ctx.fillRect(pad + bw + 8 + i * 9, top + 3, 6, 8);
    }

    /* Stats as icon-led chips: one type scale, numbers right-aligned in tabular mono so a
       changing value never shifts its neighbours, and a glyph so a number has a noun. */
    function glyph(kind, gx, gy, gs, color) {
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      if (kind === 'coin') {
        ctx.beginPath(); ctx.arc(gx + gs / 2, gy + gs / 2, gs * 0.44, 0, 6.2832); ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,.5)';
        ctx.fillRect(gx + gs * 0.42, gy + gs * 0.3, gs * 0.16, gs * 0.4);
      } else if (kind === 'sword') {
        ctx.lineWidth = Math.max(1.5, gs * 0.15);
        ctx.beginPath(); ctx.moveTo(gx + gs * 0.52, gy + gs * 0.05); ctx.lineTo(gx + gs * 0.52, gy + gs * 0.78); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(gx + gs * 0.24, gy + gs * 0.62); ctx.lineTo(gx + gs * 0.8, gy + gs * 0.62); ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(gx + gs * 0.5, gy + gs * 0.06); ctx.lineTo(gx + gs * 0.88, gy + gs * 0.26);
        ctx.lineTo(gx + gs * 0.5, gy + gs * 0.94); ctx.lineTo(gx + gs * 0.12, gy + gs * 0.26);
        ctx.closePath(); ctx.fill();
      }
    }
    var chipY = top + bh + 6, chipH = 21, chipX = pad;
    function statChip(kind, value, accent) {
      var label = String(value);
      ctx.font = '800 12px ui-monospace,SFMono-Regular,Menlo,monospace';
      var w = 30 + ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(8,10,14,.8)';
      ctx.fillRect(chipX, chipY, w, chipH);
      ctx.strokeStyle = 'rgba(255,255,255,.07)';
      ctx.lineWidth = 1;
      ctx.strokeRect(chipX + 0.5, chipY + 0.5, w - 1, chipH - 1);
      glyph(kind, chipX + 6, chipY + 4.5, 12, accent);
      ctx.fillStyle = '#eef2f8';
      ctx.textAlign = 'right';
      ctx.fillText(label, chipX + w - 8, chipY + 15);
      ctx.textAlign = 'left';
      chipX += w + 5;
    }
    statChip('coin', G.scrap, '#f0b429');
    statChip('sword', G.atk, '#ff9f43');
    statChip('shield', G.armor, '#7cc7ff');

    // sector tag, uppercase and tracked so it reads as a place, not a stat
    var tag = 'S' + G.depth + ' \u00b7 ' + G.palette.name.toUpperCase();
    ctx.font = '700 9.5px ui-monospace,SFMono-Regular,Menlo,monospace';
    var tagW = ctx.measureText(tag).width + 14;
    if (chipX + tagW < view.w - pad) {
      ctx.fillStyle = 'rgba(8,10,14,.55)';
      ctx.fillRect(chipX, chipY + 2, tagW, chipH - 4);
      ctx.fillStyle = G.palette.accent;
      ctx.fillText(tag, chipX + 7, chipY + 14);
    }

    // salvaged items: SPD icons, newest first
    var isz = 22, igap = 3;
    for (var ci = 0; ci < G.carry.length; ci++) {
      var bx = view.w - pad - isz - ci * (isz + igap), by = top + 1;
      if (bx < pad + 4) break;
      ctx.fillStyle = 'rgba(8,10,14,.72)';
      ctx.fillRect(bx, by, isz, isz);
      ctx.strokeStyle = 'rgba(124,199,255,.22)';
      ctx.strokeRect(bx + .5, by + .5, isz - 1, isz - 1);
      drawIcon(ctx, G.carry[ci].cat, bx + 3, by + 3, isz - 6);
    }

    // item tooltip: hovered floor loot, or the last thing picked up
    var showTip = null;
    if (G.mode === 'play' && G.hover) {
      var hit = itemAt(G.hover.x, G.hover.y);
      if (hit && G.seen[idx(hit.x, hit.y)]) showTip = tipFor(hit);
    }
    if (!showTip && G.tip && G.tip.t > 0) showTip = G.tip;
    if (showTip) {
      var tw = Math.min(view.w - pad * 2, 310), th = 60;
      var ty = view.h - 96 - (G.msgT > 0 ? 34 : 0);
      ctx.fillStyle = 'rgba(6,8,12,.88)';
      ctx.fillRect(pad, ty, tw, th);
      ctx.strokeStyle = 'rgba(124,199,255,.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(pad + .5, ty + .5, tw - 1, th - 1);
      ctx.font = '700 12px system-ui,sans-serif';
      ctx.fillStyle = '#dff0ff';
      ctx.fillText(clipText(ctx, showTip.name, tw - 16), pad + 8, ty + 17);
      ctx.font = '600 10px system-ui,sans-serif';
      ctx.fillStyle = '#7cc7ff';
      ctx.fillText(clipText(ctx, showTip.sub, tw - 16), pad + 8, ty + 31);
      ctx.font = '500 10px system-ui,sans-serif';
      ctx.fillStyle = 'rgba(207,214,228,.78)';
      var tl = wrapText(ctx, showTip.desc, tw - 16, 2);
      for (var tli = 0; tli < tl.length; tli++) ctx.fillText(tl[tli], pad + 8, ty + 45 + tli * 11);
    }

    // messages
    if (G.msgT > 0) {
      ctx.globalAlpha = Math.min(1, G.msgT);
      ctx.font = '600 11.5px ui-monospace,SFMono-Regular,Menlo,monospace';
      for (var m = 0; m < Math.min(3, G.log.length); m++) {
        var text = G.log[m];
        var w = Math.min(view.w - pad * 2, ctx.measureText(text).width + 22);
        var ly = view.h - 28 - m * 20, alpha = m === 0 ? 0.86 : 0.62 - m * 0.14;
        // a left accent bar carries the "this just happened" signal better than colour alone
        ctx.fillStyle = 'rgba(6,8,12,' + alpha + ')';
        ctx.fillRect(pad, ly, w, 18);
        ctx.fillStyle = m === 0 ? (G.palette.accent || '#f0b429') : 'rgba(124,199,255,.35)';
        ctx.fillRect(pad, ly, 2, 18);
        ctx.fillStyle = m === 0 ? '#ffe9b8' : 'rgba(214,222,236,.62)';
        ctx.fillText(text, pad + 9, ly + 13);
      }
      ctx.globalAlpha = 1;
    }
  }

  function drawTitle(ctx, view, t) {
    var cx = view.w / 2;
    ctx.fillStyle = '#0b0d12'; ctx.fillRect(0, 0, view.w, view.h);
    // drifting tiles
    for (var i = 0; i < 26; i++) {
      var hx = hash(i, 7), hy = hash(i, 13);
      var x = ((hx * view.w + t * (6 + hx * 14)) % (view.w + 60)) - 30;
      var y = ((hy * view.h + t * (10 + hy * 20)) % (view.h + 60)) - 30;
      ctx.fillStyle = 'rgba(240,180,41,' + (0.05 + hx * 0.06) + ')';
      ctx.fillRect(x, y, 16 + hy * 18, 16 + hx * 18);
    }
    ctx.textAlign = 'center';
    var size = Math.min(view.w * 0.16, 64);
    ctx.font = '800 ' + size + 'px system-ui,sans-serif';
    ctx.fillStyle = '#f0b429';
    ctx.fillText('VAULTBREAK', cx, view.h * 0.34);
    ctx.font = '600 ' + Math.min(view.w * 0.04, 15) + 'px system-ui,sans-serif';
    ctx.fillStyle = '#8f9aad';
    ctx.fillText('SIX SECTORS · ONE WARDEN · NO MERCY', cx, view.h * 0.34 + size * 0.62);

    var pulse = 0.6 + Math.sin(t * 2.6) * 0.4;
    ctx.fillStyle = 'rgba(240,180,41,' + pulse + ')';
    ctx.font = '700 ' + Math.min(view.w * 0.05, 19) + 'px system-ui,sans-serif';
    ctx.fillText('TAP TO DIVE', cx, view.h * 0.58);

    var run = store.get('run', null);
    if (run && run.seed) {
      ctx.fillStyle = '#cfd6e4';
      ctx.font = '600 14px system-ui,sans-serif';
      ctx.fillText('RESUME — sector ' + run.depth, cx, view.h * 0.68);
    }
    ctx.fillStyle = '#6b7688';
    ctx.font = '500 12px system-ui,sans-serif';
    ctx.fillText('best depth ' + G.best + '  ·  best score ' + G.bestScore, cx, view.h * 0.86);
    ctx.fillText('tap a tile to walk · bump to hit · FIRE to shoot', cx, view.h * 0.91);
    ctx.fillStyle = 'rgba(140,150,168,.7)';
    ctx.font = '500 9px system-ui,sans-serif';
    ctx.fillText('Art and audio: Shattered Pixel Dungeon contributors (GPL-3.0)', cx, view.h - 25);
    ctx.fillText('Item data: Cataclysm: DDA contributors (CC-BY-SA-3.0)', cx, view.h - 13);
    ctx.textAlign = 'left';
  }

  function drawCraft(ctx, view) {
    ctx.fillStyle = 'rgba(5,7,11,.86)';
    ctx.fillRect(0, 0, view.w, view.h);
    var pw = Math.min(view.w - 32, 340), ph = 78 + RECIPES.length * 58;
    var px = (view.w - pw) / 2, py = (view.h - ph) / 2;
    ctx.fillStyle = '#12161f';
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = '#2b3242'; ctx.lineWidth = 1;
    ctx.strokeRect(px + .5, py + .5, pw - 1, ph - 1);
    ctx.fillStyle = '#f0b429';
    ctx.font = '700 16px system-ui,sans-serif';
    ctx.fillText('FABRICATOR', px + 16, py + 28);
    ctx.fillStyle = '#8f9aad';
    ctx.font = '600 12px system-ui,sans-serif';
    ctx.fillText('scrap: ' + G.scrap, px + pw - 84, py + 28);
    for (var i = 0; i < RECIPES.length; i++) {
      var r = RECIPES[i], ry = py + 44 + i * 58;
      var afford = G.scrap >= r.cost && r.can();
      ctx.fillStyle = afford ? 'rgba(240,180,41,.10)' : 'rgba(255,255,255,.03)';
      ctx.fillRect(px + 12, ry, pw - 24, 48);
      ctx.strokeStyle = afford ? 'rgba(240,180,41,.45)' : 'rgba(255,255,255,.07)';
      ctx.strokeRect(px + 12.5, ry + .5, pw - 25, 47);
      ctx.globalAlpha = afford ? 1 : 0.45;
      drawIcon(ctx, r.icon || 'chest', px + 18, ry + 11, 26);
      ctx.globalAlpha = 1;
      ctx.fillStyle = afford ? '#ffe9b8' : '#5c6675';
      ctx.font = '700 13px system-ui,sans-serif';
      ctx.fillText(r.name, px + 52, ry + 18);
      ctx.fillStyle = afford ? '#8f9aad' : '#454d5a';
      ctx.font = '500 10px system-ui,sans-serif';
      ctx.fillText(r.desc, px + 52, ry + 31);
      ctx.fillStyle = afford ? 'rgba(124,199,255,.8)' : '#3d4552';
      ctx.font = '500 8.5px system-ui,sans-serif';
      ctx.fillText(clipText(ctx, r.comps, pw - 118), px + 52, ry + 43);
      ctx.fillStyle = afford ? '#f0b429' : '#454d5a';
      ctx.font = '700 13px system-ui,sans-serif';
      ctx.fillText(r.cost + '◆', px + pw - 52, ry + 26);
    }
    ctx.fillStyle = '#6b7688';
    ctx.font = '500 11px system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('tap an item to craft · tap outside to close', view.w / 2, py + ph + 20);
    ctx.fillStyle = 'rgba(140,150,168,.65)';
    ctx.font = '500 8.5px system-ui,sans-serif';
    ctx.fillText('recipes: Cataclysm: DDA contributors (CC-BY-SA-3.0)', view.w / 2, py + ph + 34);
    ctx.textAlign = 'left';
  }

  function drawEnd(ctx, view, win) {
    ctx.fillStyle = win ? 'rgba(4,14,12,.88)' : 'rgba(14,5,8,.88)';
    ctx.fillRect(0, 0, view.w, view.h);
    ctx.textAlign = 'center';
    var cx = view.w / 2;
    ctx.font = '800 34px system-ui,sans-serif';
    ctx.fillStyle = win ? '#4de2c0' : '#ff5c5c';
    ctx.fillText(win ? 'VAULT CLEARED' : 'YOU DIED', cx, view.h * 0.36);
    ctx.font = '600 14px system-ui,sans-serif';
    ctx.fillStyle = '#cfd6e4';
    ctx.fillText('sector ' + G.depth + ' · ' + G.kills + ' kills · ' + G.turns + ' turns', cx, view.h * 0.44);
    ctx.fillStyle = '#f0b429';
    ctx.font = '700 22px system-ui,sans-serif';
    ctx.fillText('SCORE ' + score(), cx, view.h * 0.52);
    ctx.fillStyle = '#6b7688';
    ctx.font = '500 12px system-ui,sans-serif';
    ctx.fillText('best ' + G.bestScore + ' · best depth ' + G.best, cx, view.h * 0.57);
    var pulse = 0.6 + Math.sin(Date.now() / 300) * 0.4;
    ctx.fillStyle = 'rgba(240,180,41,' + pulse + ')';
    ctx.font = '700 16px system-ui,sans-serif';
    ctx.fillText('TAP TO DIVE AGAIN', cx, view.h * 0.7);
    ctx.textAlign = 'left';
  }

  function drawHelp(ctx, view) {
    ctx.fillStyle = 'rgba(5,7,11,.92)';
    ctx.fillRect(0, 0, view.w, view.h);
    var pad = 22, y = 48;
    ctx.fillStyle = '#f0b429';
    ctx.font = '700 18px system-ui,sans-serif';
    ctx.fillText('HOW TO SURVIVE', pad, y);
    y += 26;
    var lines = [
      ['Tap a tile', 'walk one step toward it (A* path)'],
      ['Walk into a foe', 'melee attack'],
      ['FIRE', 'spend 1 charge, bolt in facing dir'],
      ['WAIT', 'pass a turn, recharge charge'],
      ['CRAFT', 'spend scrap: heal, charge, +ATK, +ARMOR'],
      ['Stairs', 'descend a sector'],
      ['Cache', 'permanent upgrade, once per sector'],
      ['Death', 'is permanent. The run is the point.']
    ];
    ctx.font = '500 13px system-ui,sans-serif';
    for (var i = 0; i < lines.length; i++) {
      ctx.fillStyle = '#ffe9b8';
      ctx.fillText(lines[i][0], pad, y);
      ctx.fillStyle = '#8f9aad';
      ctx.fillText(lines[i][1], pad + 118, y);
      y += 22;
    }
    ctx.fillStyle = '#6b7688';
    ctx.font = '500 12px system-ui,sans-serif';
    ctx.fillText('keys: WASD/arrows move · space fire · f craft · m mute · esc craft', pad, view.h - 30);
    ctx.fillStyle = '#f0b429';
    ctx.font = '700 14px system-ui,sans-serif';
    ctx.fillText('tap anywhere to close', pad, view.h - 56);
    ctx.fillStyle = 'rgba(140,150,168,.65)';
    ctx.font = '500 8.5px system-ui,sans-serif';
    ctx.fillText('Art and audio: Shattered Pixel Dungeon contributors (GPL-3.0)', pad, view.h - 14);
    ctx.fillText('Item data: Cataclysm: DDA contributors (CC-BY-SA-3.0)', pad, view.h - 4);
  }

  /* ------------------------------------------------------------------ *
   * INPUT
   * ------------------------------------------------------------------ */
  function toTile(clientX, clientY) {
    var r = canvas.getBoundingClientRect();
    var ts = tileSize({ w: r.width, h: r.height });
    var cam = { x: G.cam.x, y: G.cam.y };
    var wx = (clientX - r.left) / ts + cam.x;
    var wy = (clientY - r.top - HUD_TOP) / ts + cam.y;
    return { x: Math.floor(wx), y: Math.floor(wy) };
  }

  canvas.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    audioUnlock();
    if (G.mode === 'title') {
      var run = store.get('run', null);
      if (run && run.seed && e.clientX > canvas.getBoundingClientRect().left) {
        // tapping the resume line resumes, anywhere else starts fresh
        var r = canvas.getBoundingClientRect();
        var rel = (e.clientY - r.top) / r.height;
        if (rel > 0.62 && rel < 0.72 && resumeRun()) { syncBar(); return; }
      }
      G.victoryFlag = false;
      newRun();
      syncBar();
      return;
    }
    if (G.mode === 'dead' || G.mode === 'win') { G.victoryFlag = false; newRun(); syncBar(); return; }
    if (G.mode === 'help') { G.mode = 'play'; return; }
    if (G.mode === 'craft') {
      var view = { w: canvas.getBoundingClientRect().width, h: canvas.getBoundingClientRect().height };
      var pw = Math.min(view.w - 32, 340), ph = 78 + RECIPES.length * 58;
      var px = (view.w - pw) / 2, py = (view.h - ph) / 2;
      var r2 = canvas.getBoundingClientRect();
      var lx = e.clientX - r2.left, ly = e.clientY - r2.top;
      for (var i = 0; i < RECIPES.length; i++) {
        var ry = py + 44 + i * 58;
        if (lx > px + 12 && lx < px + pw - 12 && ly > ry && ly < ry + 48) { craft(RECIPES[i].id); return; }
      }
      if (lx < px || lx > px + pw || ly < py || ly > py + ph) G.mode = 'play';
      return;
    }
    if (G.mode === 'play') {
      var t = toTile(e.clientX, e.clientY);
      if (inB(t.x, t.y) && G.seen[idx(t.x, t.y)]) walkTo(t.x, t.y);
    }
  });

  // swipe = one step in the dominant direction
  var swipe = null;
  canvas.addEventListener('pointermove', function (e) {
    if (G.mode === 'play' && e.pointerType === 'mouse') G.hover = toTile(e.clientX, e.clientY);
    if (!swipe) return;
    var dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    if (Math.hypot(dx, dy) > 34 && G.mode === 'play') {
      if (Math.abs(dx) > Math.abs(dy)) tryMove(Math.sign(dx), 0);
      else tryMove(0, Math.sign(dy));
      swipe = null;
    }
  });
  canvas.addEventListener('pointerup', function () { swipe = null; });

  var bFire = document.getElementById('bFire');
  var bWait = document.getElementById('bWait');
  var bCraft = document.getElementById('bCraft');
  var bHelp = document.getElementById('bHelp');

  bFire.addEventListener('pointerdown', function (e) { e.preventDefault(); audioUnlock(); if (G.mode === 'play') fire(); });
  bWait.addEventListener('pointerdown', function (e) {
    e.preventDefault(); audioUnlock();
    if (G.mode === 'play') { log('You wait.'); endTurns(1); saveRun(); }
  });
  bCraft.addEventListener('pointerdown', function (e) {
    e.preventDefault(); audioUnlock();
    if (G.mode === 'play' || G.mode === 'craft') G.mode = G.mode === 'craft' ? 'play' : 'craft';
  });
  bHelp.addEventListener('pointerdown', function (e) {
    e.preventDefault(); audioUnlock();
    if (G.mode === 'help') G.mode = 'play'; else if (G.mode === 'play') G.mode = 'help';
  });

  function syncBar() {
    var live = G.mode === 'play';
    bFire.style.opacity = live ? '1' : '.35';
    bWait.style.opacity = live ? '1' : '.35';
  }

  window.addEventListener('keydown', function (e) {
    audioUnlock();
    if (G.mode === 'title' && (e.key === 'Enter' || e.key === ' ')) { newRun(); return; }
    if (G.mode === 'dead' || G.mode === 'win') { if (e.key === 'Enter' || e.key === ' ') newRun(); return; }
    if (G.mode === 'help') { G.mode = 'play'; return; }
    if (e.key === 'Escape') { G.mode = G.mode === 'craft' ? 'play' : 'craft'; return; }
    if (e.key === 'm' || e.key === 'M') {
      GK.sfx.enabled = !GK.sfx.enabled;
      musicTick();
      log('Sound ' + (GK.sfx.enabled ? 'on' : 'off') + '.');
      return;
    }
    if (G.mode !== 'play') return;
    var k = e.key;
    if (k === 'ArrowLeft' || k === 'a') tryMove(-1, 0);
    else if (k === 'ArrowRight' || k === 'd') tryMove(1, 0);
    else if (k === 'ArrowUp' || k === 'w') tryMove(0, -1);
    else if (k === 'ArrowDown' || k === 's') tryMove(0, 1);
    else if (k === ' ') fire();
    else if (k === '.') { log('You wait.'); endTurns(1); }
    else if (k === 'f') G.mode = 'craft';
    else return;
    e.preventDefault();
  });

  /* ------------------------------------------------------------------ *
   * BOOT
   * ------------------------------------------------------------------ */
  var loop = GK.boot({
    canvas: canvas,
    update: function (dt) {
      if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 22);
      if (G.flash > 0) G.flash = Math.max(0, G.flash - dt * 1.6);
      if (G.msgT > 0) G.msgT -= dt;
      if (G.tip) { G.tip.t -= dt; if (G.tip.t <= 0) G.tip = null; }
      musicTick();
      if (G.beam) { G.beam.t -= dt; if (G.beam.t <= 0) G.beam = null; }
      if (G.player && G.player.swing > 0) G.player.swing = Math.max(0, G.player.swing - dt);
      seedDust();
      for (var di = 0; di < G.dust.length; di++) {
        var d0 = G.dust[di];
        d0.y -= d0.s * dt * 60 * 0.016;
        d0.x += Math.sin((G.turns + di) * 0.7) * dt * 0.004;
        if (d0.y < -0.02) { d0.y = 1.02; d0.x = Math.random(); }
      }
      for (var fi = G.floats.length - 1; fi >= 0; fi--) {
        var fl = G.floats[fi];
        fl.t += dt;
        if (fl.t >= fl.life) G.floats.splice(fi, 1);
      }
      for (var i = G.parts.length - 1; i >= 0; i--) {
        var p = G.parts[i];
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vx *= 0.92; p.vy *= 0.92;
        p.life -= dt;
        if (p.life <= 0) G.parts.splice(i, 1);
      }
      if (G.mode === 'play' && G.turns > 0 && G.turns % 12 === 0) saveRun();
    },
    render: draw
  });

  document.addEventListener('visibilitychange', function () { if (document.hidden && G.mode === 'play') saveRun(); });

  /* Debug/test surface — used by tests/smoke.mjs, harmless in play. */
  window.__game = {
    state: function () {
      return {
        started: G.mode === 'play', mode: G.mode, depth: G.depth, hp: G.hp,
        turns: G.turns, kills: G.kills, scrap: G.scrap, enemies: G.actors.filter(function (a) { return a.hp > 0; }).length,
        x: G.player ? G.player.x : -1, y: G.player ? G.player.y : -1,
        alive: G.hp > 0 && G.mode !== 'dead', gameOver: G.mode === 'dead' || G.mode === 'win'
      };
    },
    /* diagnostic surface: which vendored sheets actually decoded and can be painted.
       The harness uses this to prove the art is drawn, not merely downloaded. */
    terrain: function () {
      var t = terrainFor(G.depth);
      return { theme: t.name, ready: !!t.ready, loaded: !!t.img,
               src: t.img ? String(t.img.currentSrc || t.img.src || '').split('/').pop() : null };
    },
    sprites: function () {
      var out = [];
      for (var k in SPR) {
        out.push({ name: k, ready: !!SPR[k].ready, img: !!SPR[k].img,
                   h: SPR[k].h, frames: SPR[k].frames,
                   src: SPR[k].img ? String(SPR[k].img.currentSrc || SPR[k].img.src || '').split('/').pop() : null });
      }
      return out;
    },
    act: function (name, arg) {
      if (name === 'newGame') { G.victoryFlag = false; newRun(arg || 1234); return true; }
      if (name === 'step') { var d = arg || { x: 1, y: 0 }; return tryMove(d.x, d.y); }
      if (name === 'walkTo') return walkTo(arg.x, arg.y), true;
      /* automation helper: take one step toward the nearest live actor, so the
         harness can get a monster on screen and prove its sprite really paints */
      if (name === 'approach') {
        if (!G.player) return false;
        var foes = G.actors.filter(function (a) { return a.hp > 0; }).sort(function (p, q) {
          return (Math.abs(p.x - G.player.x) + Math.abs(p.y - G.player.y))
            - (Math.abs(q.x - G.player.x) + Math.abs(q.y - G.player.y));
        });
        // nearest first, but skip one the path can't reach this step
        for (var fi = 0; fi < foes.length && fi < 4; fi++) {
          var px = G.player.x, py = G.player.y;
          walkTo(foes[fi].x, foes[fi].y);   // pathfinds around walls, steps onto the foe
          if (G.player.x !== px || G.player.y !== py) return true;
        }
        return false;
      }
      if (name === 'fire') { fire(); return true; }
      if (name === 'wait') { endTurns(1); return true; }
      if (name === 'craft') return craft(arg);
      if (name === 'resume') return resumeRun();
      return false;
    }
  };

  syncBar();
})();
