/* Ember Drift — a Newtonian space trading/combat sandbox for phones.
 * Classic script, no modules, no network, no external fonts. Sound is
 * synthesised by GK.sfx; hull sprites and the commodity table come from
 * window.AOMG_VENDOR (vendor/vendor.js, Endless Sky, GPL-3.0) and every one of
 * them has an authored canvas-vector fallback, so the game still boots and
 * plays with the bundle deleted.
 *
 * Frame budget notes (mid-tier phones):
 *  - bullets and particles live in fixed-size pools, never allocated per shot;
 *  - the nebula is baked once per system into an offscreen canvas;
 *  - shadowBlur is used only for a handful of hero objects, never per particle.
 */
(function () {
  'use strict';
  if (!window.GK) { return; }
  var GK = window.GK;
  var TAU = Math.PI * 2;

  /* ------------------------------------------------------------------ */
  /* palette + tiny maths                                                */
  /* ------------------------------------------------------------------ */
  var C = {
    bg: '#06080f',
    panel: 'rgba(8,12,22,0.94)',
    panel2: 'rgba(14,20,34,0.96)',
    line: 'rgba(77,226,255,0.16)',
    cyan: '#4de2ff',
    cyanDim: '#2b7c93',
    ember: '#ff7a45',
    ink: '#e2f4ff',
    mid: '#8ba3bb',
    dim: '#4c6275',
    core: '#4de2ff',
    frontier: '#ffc46b',
    pirate: '#ff7a45',
    good: '#7dffb2',
    bad: '#ff5a6e',
    gold: '#ffe08a'
  };
  var FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  var MONO = 'ui-monospace,Menlo,Consolas,"Courier New",monospace';

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function mod(v, m) { v = v % m; return v < 0 ? v + m : v; }
  function rr(a, b) { return a + Math.random() * (b - a); }
  function angDiff(a, b) { var d = (a - b + Math.PI) % TAU; if (d < 0) d += TAU; return d - Math.PI; }
  function dist(ax, ay, bx, by) { var dx = bx - ax, dy = by - ay; return Math.sqrt(dx * dx + dy * dy); }
  function money(n) {
    n = Math.round(n);
    var s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '-' : '') + s;
  }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  function txt(ctx, s, x, y, size, color, align, weight, mono) {
    ctx.font = (weight || 600) + ' ' + size + 'px ' + (mono ? MONO : FONT);
    ctx.fillStyle = color;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(s, x, y);
  }
  function rrect(ctx, x, y, w, h, r) {
    r = Math.min(r, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  function bar(ctx, x, y, w, h, pct, col, bg) {
    ctx.fillStyle = bg || 'rgba(255,255,255,0.07)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = col;
    ctx.fillRect(x, y, Math.max(0, Math.min(1, pct)) * w, h);
  }

  /* ------------------------------------------------------------------ */
  /* vendored Endless Sky content (optional; every use is guarded)       */
  /* ------------------------------------------------------------------ */
  // vendor/vendor.js publishes window.AOMG_VENDOR from a classic script, so this
  // works from file:// with the network off. If the bundle is missing the game
  // falls back to the authored vectors and prices below and still plays.
  var VENDOR = window.AOMG_VENDOR || null;
  var ES_SHIPS = (VENDOR && VENDOR.data && VENDOR.data['endless-sky/ships']) || [];
  var ES_COMM = (VENDOR && VENDOR.data && VENDOR.data['endless-sky/commodities']) || [];
  var ES_BY_NAME = {};
  for (var esi = 0; esi < ES_SHIPS.length; esi++) {
    if (ES_SHIPS[esi] && ES_SHIPS[esi].name) ES_BY_NAME[ES_SHIPS[esi].name] = ES_SHIPS[esi];
  }
  // Only load art the service worker already precaches (AOMG_VENDOR.assets is
  // that list), so the game never asks for a file that might not be on disk.
  var ASSET_SET = {};
  if (VENDOR && VENDOR.assets && VENDOR.assets.length) {
    for (var api = 0; api < VENDOR.assets.length; api++) ASSET_SET[VENDOR.assets[api]] = true;
  }
  function hasAsset(p) {
    // no manifest at all: let the <img> decide
    return !VENDOR || ASSET_SET[p] === true;
  }
  function assetUrl(p) { return '../../' + p; }

  /* ------------------------------------------------------------------ */
  /* static data                                                         */
  /* ------------------------------------------------------------------ */
  // tilt > 0: costs more where tech is high (raw goods). tilt < 0: cheaper there.
  // The ten goods are the Endless Sky commodity table; `base` is the ES price
  // halved so the price band still matches Ember Drift's upgrade costs, and the
  // station's economic profile (tech tilt, faction rep, local stock) is applied
  // on top by priceOf().
  var COMM = [];
  (function buildCommodities() {
    var spec = [
      { id: 'food', name: 'Food', tilt: 0.05, short: 'FOOD', fb: 100 },
      { id: 'clothing', name: 'Clothing', tilt: 0.02, short: 'CLOTH', fb: 140 },
      { id: 'metal', name: 'Metal', tilt: 0.06, short: 'METAL', fb: 190 },
      { id: 'plastic', name: 'Plastic', tilt: 0.03, short: 'PLAST', fb: 240 },
      { id: 'equipment', name: 'Equipment', tilt: -0.04, short: 'EQUIP', fb: 330 },
      { id: 'medical', name: 'Medical', tilt: -0.05, short: 'MED', fb: 430 },
      { id: 'industrial', name: 'Industrial', tilt: 0.00, short: 'INDUS', fb: 520 },
      { id: 'electronics', name: 'Electronics', tilt: -0.09, short: 'ELEC', fb: 590 },
      { id: 'heavy', name: 'Heavy Metals', tilt: 0.07, short: 'HVYMET', fb: 610 },
      { id: 'luxury', name: 'Luxury Goods', tilt: -0.08, short: 'LUX', fb: 920 }
    ];
    var byName = {};
    for (var i = 0; i < ES_COMM.length; i++) byName[ES_COMM[i].name] = ES_COMM[i];
    for (var s = 0; s < spec.length; s++) {
      var sp = spec[s], es = byName[sp.name];
      var price = es ? es.price : sp.fb;
      var cap = es ? es.capacity : 700;
      // stock0 comes from the ES capacity, so cheap bulk goods sit deeper on the dock
      COMM.push({
        id: sp.id, name: sp.name, short: sp.short, tilt: sp.tilt,
        base: Math.round(price * 0.5),
        stock0: Math.round(clamp(cap / 14, 18, 80))
      });
    }
  })();
  var COMM_IX = {};
  COMM.forEach(function (c, i) { COMM_IX[c.id] = i; });

  /* ------------------------------------------------------------------ */
  /* hulls: Endless Sky stats mapped onto this game's numbers            */
  /* ------------------------------------------------------------------ */
  // hull/shield are sqrt-compressed into the 100-hull / 60-shield band the
  // game was tuned around; mass becomes inertia (acceleration and turn rate
  // both fall as mass rises); cargo is half the ES hold. Price is roughly
  // ES cost / 2000 plus a small floor, which keeps the shipyard inside the
  // same credit economy as the outfits and contracts. Each entry carries the
  // authored fallback numbers, overwritten by the ES row when vendored.
  var HULLS = [
    { key: 'shuttle', name: 'EMERGENCY SHUTTLE', spr: 'shuttle', es: 'Emergency Shuttle', role: 'STARTER', len: 30,
      hull: 100, shield: 60, accel: 400, turn: 3.0, cargo: 20, price: 472 },
    { key: 'slate', name: 'SLATE', spr: 'slate', es: 'Slate', role: 'LIGHT FREIGHTER', len: 34,
      hull: 130, shield: 18, accel: 400, turn: 2.9, cargo: 40, price: 535 },
    { key: 'enforcer', name: 'ENFORCER', spr: 'enforcer', es: 'Enforcer', role: 'LIGHT WARSHIP', len: 38,
      hull: 135, shield: 166, accel: 400, turn: 2.8, cargo: 15, price: 695 },
    { key: 'saber', name: 'SABER', spr: 'saber', es: 'Saber', role: 'MEDIUM WARSHIP', len: 44,
      hull: 208, shield: 235, accel: 300, turn: 2.3, cargo: 15, price: 1550 },
    { key: 'dolomite', name: 'DOLOMITE', spr: 'dolomite', es: 'Dolomite', role: 'HEAVY FREIGHTER', len: 50,
      hull: 234, shield: 18, accel: 210, turn: 1.9, cargo: 100, price: 1834 },
    { key: 'mfalcon', name: 'MARAUDER FALCON', spr: 'mfalcon', es: 'Marauder Falcon', role: 'HEAVY WARSHIP', len: 52,
      hull: 261, shield: 411, accel: 250, turn: 1.9, cargo: 40, price: 7400 }
  ];
  // The vendored rows carry hull/shield/mass/cargo/cost, but ES leaves thrust
  // and turn on the engine rather than the ship, so inertia comes from mass:
  // heavy hulls accelerate and rotate more slowly. (Only 4 of 120 rows have a
  // thrust value, all of them tugs, so mass is the honest signal.)
  function hullStats(def) {
    var mass = def.mass > 0 ? def.mass : 120;
    var hull = def.hull > 0 ? def.hull : 600;
    var shield = def.shields > 0 ? def.shields : 0;
    var turn = def.turn > 0 ? def.turn : clamp(4.2 * Math.pow(90 / mass, 0.35), 0.8, 4.2);
    var accel = clamp(520 * Math.pow(120 / mass, 0.42), 95, 560);
    return {
      hull: Math.round(clamp(100 * Math.sqrt(hull / 600), 55, 420)),
      shield: Math.round(clamp(60 * Math.sqrt(shield / 300), 18, 380)),
      accel: Math.round(accel),
      turn: Math.round(turn * 100) / 100,
      cargo: Math.round(clamp((def.cargo || 20) * 0.5, 8, 120)),
      price: Math.round(clamp(450 + (def.cost || 50000) / 2000, 400, 12000))
    };
  }
  HULLS.forEach(function (h) {
    var def = ES_BY_NAME[h.es];
    if (!def) { return; }
    var s = hullStats(def);
    h.hull = s.hull; h.shield = s.shield; h.accel = s.accel;
    h.turn = s.turn; h.cargo = s.cargo; h.price = s.price;
  });
  var HULL_IX = {};
  HULLS.forEach(function (h, i) { HULL_IX[h.key] = i; });
  function hullDef(key) { return HULLS[HULL_IX[key] == null ? 0 : HULL_IX[key]]; }

  /* ------------------------------------------------------------------ */
  /* sprites: a dozen ES hulls, preloaded; the vectors stay as fallback  */
  /* ------------------------------------------------------------------ */
  var SPRITES = {
    shuttle: { es: 'Emergency Shuttle', len: 30 },
    barb: { es: 'Barb', len: 26 },
    dunite: { es: 'Dunite', len: 30 },
    marrows: { es: 'Marauder Arrow', len: 28 },
    mbounder: { es: 'Marauder Bounder', len: 38 },
    slate: { es: 'Slate', len: 34 },
    enforcer: { es: 'Enforcer', len: 38 },
    saber: { es: 'Saber', len: 44 },
    dolomite: { es: 'Dolomite', len: 50 },
    mfalcon: { es: 'Marauder Falcon', len: 52 },
    diorite: { es: 'Diorite', len: 58 },
    aphid: { es: 'Aphid', len: 40 },
    blackbird: { es: 'Blackbird', len: 62 }
  };
  function preloadSprites() {
    for (var k in SPRITES) {
      (function (s) {
        s.img = null; s.w = 1; s.h = 1; s.ready = false;
        var def = ES_BY_NAME[s.es];
        if (!def || !def.image || !hasAsset(def.image)) return;
        var img = new Image();
        img.onload = function () {
          s.w = img.naturalWidth || img.width || 1;
          s.h = img.naturalHeight || img.height || 1;
          if (s.w > 1 && s.h > 1) s.ready = true;
        };
        img.onerror = function () { s.ready = false; };
        img.src = assetUrl(def.image);
        s.img = img;
      })(SPRITES[k]);
    }
  }
  // ES art points up; game headings point right, so every blit adds PI/2.
  function blitSprite(ctx, key, len) {
    var s = SPRITES[key];
    if (!s || !s.ready) return false;
    var sc = len / Math.max(s.w, s.h);
    ctx.save();
    ctx.rotate(Math.PI * 0.5);
    ctx.drawImage(s.img, -s.w * sc * 0.5, -s.h * sc * 0.5, s.w * sc, s.h * sc);
    ctx.restore();
    return true;
  }
  function drawShipSprite(ctx, key, x, y, a, len, alpha) {
    var s = SPRITES[key];
    if (!s || !s.ready) return false;
    var prev = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;   // painted art, not pixel art
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    if (alpha != null) ctx.globalAlpha = alpha;
    blitSprite(ctx, key, len);
    ctx.restore();
    ctx.imageSmoothingEnabled = prev;
    return true;
  }

  var WEAPONS = [
    { id: 'pulse', name: 'PULSE', dmg: 6.2, rof: 0.105, spd: 940, spread: 0.085, shots: 2, nrg: 1.6, color: C.cyan, kind: 'tracer' },
    { id: 'rail', name: 'RAIL', dmg: 54, rof: 1.05, spd: 2000, spread: 0, shots: 1, nrg: 26, color: '#e7f8ff', kind: 'rail', charge: 0.8, pierce: 3, shake: 9 },
    { id: 'miss', name: 'MISSILE', dmg: 30, rof: 0.85, spd: 320, shots: 1, nrg: 12, color: C.ember, kind: 'missile', homing: 2.4, aoe: 40 },
    { id: 'flak', name: 'FLAK', dmg: 20, rof: 0.7, spd: 470, spread: 0.03, shots: 1, nrg: 10, color: C.gold, kind: 'flak', fuse: 0.62, aoe: 62 }
  ];

  // Pirates fly Endless Sky Fighters and Interceptors; the vector in drawEnemy()
  // remains the fallback while the sprite is still decoding (or if the bundle
  // is absent).
  var KIND = {
    interceptor: { hp: 26, r: 11, acc: 400, turn: 2.5, maxv: 460, fire: 0.62, dmg: 6, col: C.ember, bounty: 55, name: 'INTERCEPTOR', spr: ['barb', 'dunite'] },
    gunship: { hp: 78, r: 17, acc: 220, turn: 1.2, maxv: 250, fire: 1.35, dmg: 12, col: C.gold, bounty: 130, name: 'GUNSHIP', spr: ['mbounder'] },
    raider: { hp: 44, r: 13, acc: 330, turn: 2.0, maxv: 380, fire: 0.8, dmg: 8, col: C.pirate, bounty: 85, name: 'RAIDER', spr: ['marrows'] }
  };

  var NAME_A = ['Tarn', 'Vexil', 'Kessa', 'Orrin', 'Halcy', 'Drav', 'Merid', 'Cinder', 'Ophix', 'Sable',
    'Yarrow', 'Pell', 'Quorum', 'Ixion', 'Thorne', 'Vela', 'Ashen', 'Kyra', 'Nadir', 'Rust',
    'Cael', 'Mire', 'Ostra', 'Vane', 'Soris', 'Brenn', 'Kalt', 'Lumen', 'Ghast', 'Vesper'];
  var NAME_B = ['', 'Prime', 'Minor', 'Major', 'Reach', 'Gate', 'Deep', 'Drift', 'Hollow', 'Watch',
    'Spire', 'Falls', 'Belt', 'Haven', 'Rest', 'Array', 'Rise', 'Veil'];

  var FAC_NAME = { core: 'CORE', frontier: 'FRONTIER', pirate: 'PIRATE' };
  var FAC_COL = { core: C.core, frontier: C.frontier, pirate: C.pirate };

  /* ------------------------------------------------------------------ */
  /* galaxy: seeded systems, lanes, markets                              */
  /* ------------------------------------------------------------------ */
  function laneKey(a, b) { return a < b ? a + '-' + b : b + '-' + a; }

  function genGalaxy(seed) {
    var rng = GK.rand(seed);
    var n = GK.ri(rng, 14, 19);
    var pts = [], guard = 0;
    while (pts.length < n && guard++ < 8000) {
      var x = GK.rr(rng, 0.07, 0.93), y = GK.rr(rng, 0.10, 0.90);
      var ok = true;
      for (var i = 0; i < pts.length; i++) {
        var dx = pts[i].x - x, dy = (pts[i].y - y) * 1.45;
        if (dx * dx + dy * dy < 0.0105) { ok = false; break; }
      }
      if (ok) pts.push({ x: x, y: y });
    }
    while (pts.length < n) pts.push({ x: GK.rr(rng, 0.1, 0.9), y: GK.rr(rng, 0.1, 0.9) });

    // --- lanes: minimum spanning tree first (guarantees the map is connected),
    // --- then a few short "shortcut" lanes so routes form loops.
    var links = [], inTree = { 0: true }, count = 1, key = {};
    while (count < n) {
      var best = -1, bestA = 0, bestB = 0;
      for (var a = 0; a < n; a++) {
        if (!inTree[a]) continue;
        for (var b = 0; b < n; b++) {
          if (inTree[b]) continue;
          var d = dist(pts[a].x, pts[a].y * 1.45, pts[b].x, pts[b].y * 1.45);
          if (best < 0 || d < best) { best = d; bestA = a; bestB = b; }
        }
      }
      inTree[bestB] = true; count++;
      links.push([bestA, bestB]); key[laneKey(bestA, bestB)] = true;
    }
    for (var p = 0; p < n; p++) {
      for (var q = p + 1; q < n; q++) {
        if (key[laneKey(p, q)]) continue;
        var dd = dist(pts[p].x, pts[p].y * 1.45, pts[q].x, pts[q].y * 1.45);
        if (dd < 0.26 && rng() < 0.42) { links.push([p, q]); key[laneKey(p, q)] = true; }
      }
    }

    var adj = [];
    for (var k = 0; k < n; k++) adj.push([]);
    links.forEach(function (l) { adj[l[0]].push(l[1]); adj[l[1]].push(l[0]); });

    // --- identity
    var used = {}, systems = [];
    for (var s = 0; s < n; s++) {
      var pt = pts[s];
      var dc = Math.sqrt(Math.pow((pt.x - 0.5), 2) + Math.pow((pt.y - 0.5) * 1.45, 2));
      var fac = dc < 0.155 ? 'core' : dc < 0.33 ? 'frontier' : 'pirate';
      var tech = fac === 'core' ? GK.ri(rng, 4, 6) : fac === 'frontier' ? GK.ri(rng, 2, 4) : GK.ri(rng, 1, 3);
      var name = '', tries = 0;
      do {
        name = GK.pick(rng, NAME_A) + (rng() < 0.55 ? ' ' + GK.pick(rng, NAME_B) : '');
        if (name.charAt(name.length - 1) === ' ') name = name.slice(0, -1);
        if (rng() < 0.22) name += '-' + GK.ri(rng, 2, 9);
        tries++;
      } while (used[name] && tries < 30);
      used[name] = true;
      var mk = {};
      for (var ci = 0; ci < COMM.length; ci++) {
        mk[ci] = {
          stock: Math.round(COMM[ci].stock0 * (0.55 + rng() * 0.95)),
          drift: GK.rr(rng, -0.09, 0.11)
        };
      }
      systems.push({ id: s, name: name, x: pt.x, y: pt.y, faction: fac, tech: tech, market: mk, hue: rng() });
    }
    // home = system nearest the middle of the map
    var home = 0, hd = 9;
    for (var h = 0; h < n; h++) {
      var d2 = dist(systems[h].x, systems[h].y * 1.45, 0.5, 0.5 * 1.45);
      if (d2 < hd) { hd = d2; home = h; }
    }
    systems[home].faction = 'core';
    systems[home].tech = Math.max(4, systems[home].tech);
    return { n: n, systems: systems, links: links, adj: adj, home: home };
  }

  /* price of a commodity: tech tilt + local stock + slow drift + reputation. */
  function priceOf(sys, ci, side) {
    var c = COMM[ci], m = sys.market[ci];
    var stockF = clamp((c.stock0 - m.stock) / c.stock0 * 0.55, -0.42, 1.0);
    var mult = 1 + c.tilt * (sys.tech - 3) + stockF + m.drift;
    var rep = (G && G.rep[sys.faction]) || 0;
    var p = c.base * Math.max(0.3, mult);
    if (side === 'sell') p *= 0.82 + clamp(rep, -100, 100) * 0.0011;
    else p *= 1 - clamp(rep, 0, 100) * 0.0016;
    return Math.max(1, Math.round(p));
  }
  function stockPct(sys, ci) { return clamp(sys.market[ci].stock / (COMM[ci].stock0 * 1.6), 0, 1); }

  /* ------------------------------------------------------------------ */
  /* persistent state                                                    */
  /* ------------------------------------------------------------------ */
  var SAVE = null;
  try { SAVE = GK.store('ember-drift'); } catch (e) { SAVE = null; }

  var G = null;          // the whole run
  var SP = null;         // space instance of the current system
  var cam = { x: 0, y: 0, tx: 0, ty: 0, shake: 0 };
  var ARENA = 3200;      // world is a square; the edge is visible and soft

  var pad = null;        // set in boot()

  function hasSave() {
    if (!SAVE) return false;
    var s = SAVE.get('save', null);
    // v2: the market is the vendored ten-commodity list and the player owns a
    // hull, so a v1 save (eight synthetic goods) is not migratable.
    return !!(s && s.v === 2 && s.seed);
  }

  function saveGame() {
    if (!G || !SAVE) return;
    var stock = [], drift = [];
    for (var i = 0; i < G.gal.systems.length; i++) {
      var row = [], row2 = [];
      for (var ci = 0; ci < COMM.length; ci++) { row.push(Math.round(G.gal.systems[i].market[ci].stock)); row2.push(Math.round(G.gal.systems[i].market[ci].drift * 1000) / 1000); }
      stock.push(row); drift.push(row2);
    }
    var snap = {
      v: 2, seed: G.seed, cur: G.cur, credits: Math.round(G.credits), fuel: Math.round(G.fuel * 10) / 10,
      hull: Math.round(G.player.hull), shield: Math.round(G.player.shield), ship: G.player.ship,
      cargo: G.cargo, freight: G.freight, upgrades: G.upgrades, rep: G.rep,
      active: G.active, wep: G.player.wep, kills: G.kills, time: Math.round(G.time),
      last: G.lastStation, visited: G.visited, scanned: G.scanned, disc: G.disc, taken: G.taken,
      stock: stock, drift: drift
    };
    try { SAVE.set('save', snap); } catch (e) {}
  }

  function loadGame() {
    if (!SAVE) return false;
    var s = SAVE.get('save', null);
    if (!s || s.v !== 2 || !s.seed) return false;
    var gal = genGalaxy(s.seed);
    for (var i = 0; i < gal.systems.length; i++) {
      if (!s.stock || !s.stock[i]) continue;
      for (var ci = 0; ci < COMM.length; ci++) {
        if (s.stock[i][ci] == null) continue;
        gal.systems[i].market[ci].stock = s.stock[i][ci];
        gal.systems[i].market[ci].drift = (s.drift && s.drift[i] && s.drift[i][ci] != null) ? s.drift[i][ci] : 0;
      }
    }
    G = freshState(s.seed, gal);
    G.cur = clamp(s.cur | 0, 0, gal.n - 1);
    G.credits = s.credits || 0;
    G.fuel = s.fuel == null ? 16 : s.fuel;
    G.player.ship = HULL_IX[s.ship] != null ? s.ship : 'shuttle';
    G.cargo = s.cargo || {};
    G.freight = s.freight || [];
    for (var u in G.upgrades) if (s.upgrades && s.upgrades[u] != null) G.upgrades[u] = s.upgrades[u];
    for (var f in G.rep) if (s.rep && s.rep[f] != null) G.rep[f] = s.rep[f];
    G.active = s.active || [];
    G.lastStation = s.last == null ? G.cur : s.last;
    G.visited = s.visited || {};
    G.scanned = s.scanned || {};
    G.disc = s.disc || {};
    G.taken = s.taken || {};
    G.kills = s.kills || 0;
    G.time = s.time || 0;
    applyUpgrades();
    G.player.hull = clamp(s.hull == null ? G.player.maxHull : s.hull, 1, G.player.maxHull);
    G.player.shield = clamp(s.shield || 0, 0, G.player.maxShield);
    G.player.wep = clamp(s.wep | 0, 0, WEAPONS.length - 1);
    G.visited[G.cur] = true;
    revealLinks(G.cur);
    enterSystem(G.cur, false);
    G.mode = 'flight';
    return true;
  }

  // Outfits stack on top of the hull's own ES-derived base stats, so a Saber
  // with no upgrades already outflies a Shuttle with three engine tunings.
  function applyUpgrades() {
    var p = G.player, u = G.upgrades;
    var h = hullDef(p.ship);
    p.maxHull = h.hull + u.hull * 14;
    p.maxShield = h.shield + u.shield * 16;
    p.hold = h.cargo + u.cargo * 8;
    p.dmgMul = 1 + u.weapon * 0.12;
    p.accel = h.accel * (1 + u.engine * 0.075);
    p.turn = h.turn * (1 + u.engine * 0.06);
    if (p.hull > p.maxHull) p.hull = p.maxHull;
    if (p.shield > p.maxShield) p.shield = p.maxShield;
  }

  function revealLinks(i) {
    var adj = G.gal.adj[i] || [];
    for (var k = 0; k < adj.length; k++) G.disc[laneKey(i, adj[k])] = true;
  }
  function laneKnown(a, b) { return !!G.disc[laneKey(a, b)]; }
  function isAdjacent(a, b) { return G.gal.adj[a].indexOf(b) >= 0; }

  function freshState(seed, gal) {
    var p = {
      x: 0, y: 0, vx: 0, vy: 0, a: 0,
      hull: 100, maxHull: 100, shield: 60, maxShield: 60, shieldT: 0,
      energy: 100, maxEnergy: 100, hold: 20, dmgMul: 1, accel: 400, turn: 3, ship: 'shuttle',
      wep: 0, cool: 0, charge: 0, charging: false, thrust: 0, boost: 0,
      flash: 0, ripple: 0, rippleA: 0, invuln: 1.2, dead: false,
      lowWarn: 0
    };
    return {
      seed: seed, gal: gal, cur: gal.home, mode: 'flight', time: 0,
      credits: 1400, fuel: 18,
      cargo: {}, freight: [], upgrades: { cargo: 0, shield: 0, hull: 0, weapon: 0, engine: 0 },
      rep: { core: 6, frontier: 0, pirate: -30 },
      active: [], taken: {}, visited: {}, scanned: {}, disc: {},
      kills: 0, deaths: 0, traded: 0, lastStation: gal.home,
      toast: null, toastT: 0, spawnT: 6, shake: 0,
      player: p, flightT: 0, docked: false
    };
  }

  function newRun(fromSave) {
    if (fromSave && loadGame()) { return true; }
    var seed = (Math.random() * 2147483647) | 0;
    var gal = genGalaxy(seed);
    G = freshState(seed, gal);
    applyUpgrades();
    G.player.hull = G.player.maxHull;
    G.player.shield = G.player.maxShield;
    G.player.wep = 0;
    revealLinks(G.cur);
    enterSystem(G.cur, false);
    G.mode = 'flight';
    saveGame();
    return true;
  }

  function driftMarket(sys) {
    var rng = GK.rand((G.seed ^ ((sys.id + 3) * 2654435761)) >>> 0);
    for (var ci = 0; ci < COMM.length; ci++) {
      var m = sys.market[ci];
      m.stock = Math.round(clamp(m.stock + GK.rr(rng, -9, 9), 0, COMM[ci].stock0 * 1.7));
      m.drift = clamp(m.drift * 0.72 + GK.rr(rng, -0.045, 0.045), -0.24, 0.28);
    }
  }

  /* ------------------------------------------------------------------ */
  /* the flight instance of a system                                     */
  /* ------------------------------------------------------------------ */
  function makeSpace(sys) {
    var rng = GK.rand((G.seed ^ ((sys.id + 1) * 7919)) >>> 0);
    var cx = ARENA * 0.5, cy = ARENA * 0.5;
    var st = {
      id: sys.id,
      station: { x: cx + GK.rr(rng, -90, 90), y: cy + GK.rr(rng, -90, 90), spin: 0 },
      gate: { x: 0, y: 0, spin: 0 },
      rocks: [], enemies: [], traffic: [], neb: null, maxEnemies: 0, hue: sys.hue
    };
    var ga = GK.rr(rng, 0, TAU), gr = GK.rr(rng, 820, 1080);
    st.gate.x = clamp(cx + Math.cos(ga) * gr, 240, ARENA - 240);
    st.gate.y = clamp(cy + Math.sin(ga) * gr, 240, ARENA - 240);

    var nrocks = GK.ri(rng, 14, 20);
    for (var i = 0; i < nrocks; i++) {
      var x, y, tries = 0;
      do {
        x = GK.rr(rng, 120, ARENA - 120); y = GK.rr(rng, 120, ARENA - 120); tries++;
      } while (tries < 40 && (dist(x, y, st.station.x, st.station.y) < 330 || dist(x, y, st.gate.x, st.gate.y) < 190));
      var r = GK.rr(rng, 16, 58), pts = [], seg = GK.ri(rng, 7, 10);
      for (var s = 0; s < seg; s++) {
        var a2 = s / seg * TAU, rad = r * GK.rr(rng, 0.68, 1.15);
        pts.push([Math.cos(a2) * rad, Math.sin(a2) * rad]);
      }
      st.rocks.push({ x: x, y: y, r: r, pts: pts, spin: GK.rr(rng, -0.5, 0.5), a: GK.rr(rng, 0, TAU), shade: GK.rr(rng, 0, 1) });
    }

    // hostility pressure by faction + reputation
    var fac = sys.faction;
    if (fac === 'core') st.maxEnemies = G.rep.core < -25 ? 2 : 0;
    else if (fac === 'frontier') st.maxEnemies = 4;
    else st.maxEnemies = 6;

    // Ambient traffic: ES freighters and militia warships on a slow orbit of the
    // station. Cosmetic only — they are not targets and never shoot — but they
    // give a docked system the busiest sky.
    var nTraffic = fac === 'core' ? 4 : fac === 'frontier' ? 3 : 1;
    for (var ti = 0; ti < nTraffic; ti++) {
      var militia = fac === 'core' && ti % 2 === 1;
      var tr = {
        spr: militia ? 'diorite' : (rng() < 0.5 ? 'aphid' : 'blackbird'),
        civ: !militia,
        cx: st.station.x, cy: st.station.y,
        r: GK.rr(rng, militia ? 300 : 200, militia ? 520 : 400),
        a: GK.rr(rng, 0, TAU),
        w: (rng() < 0.5 ? -1 : 1) * GK.rr(rng, 0.07, 0.2),
        len: militia ? 56 : GK.rr(rng, 34, 46),
        x: 0, y: 0, ang: 0
      };
      tr.x = tr.cx + Math.cos(tr.a) * tr.r;
      tr.y = tr.cy + Math.sin(tr.a) * tr.r * 0.85;
      tr.ang = Math.atan2(Math.cos(tr.a) * tr.w * 0.85, -Math.sin(tr.a) * tr.w);
      st.traffic.push(tr);
    }

    st.neb = bakeNebula(sys);
    SP = st;
    cam.x = G.player.x; cam.y = G.player.y;
    return st;
  }

  function bakeNebula(sys) {
    var cv = document.createElement('canvas');
    cv.width = 512; cv.height = 512;
    var g = cv.getContext('2d');
    var rng = GK.rand((G.seed ^ ((sys.id + 11) * 40503)) >>> 0);
    var hues = ['#0d2136', '#1a1030', '#0b2b2e', '#241410', '#101a3c'];
    g.globalCompositeOperation = 'lighter';
    for (var i = 0; i < 5; i++) {
      var x = GK.rr(rng, 0.1, 0.9) * 512, y = GK.rr(rng, 0.1, 0.9) * 512;
      var r = GK.rr(rng, 110, 250);
      var grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, hues[(sys.id + i) % hues.length]);
      grd.addColorStop(1, 'rgba(6,8,15,0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    }
    return cv;
  }

  function enterSystem(id, announce) {
    G.cur = id;
    var sys = G.gal.systems[id];
    G.visited[id] = true;
    revealLinks(id);
    driftMarket(sys);
    clearBullets();
    clearParticles();
    G.player.x = 0; G.player.y = 0;   // park at origin before makeSpace reads cam
    SP = null;
    SP = makeSpace(sys);
    var p = G.player;
    p.x = SP.gate.x; p.y = SP.gate.y; p.vx = 0; p.vy = 0;
    p.a = Math.atan2(SP.station.y - p.y, SP.station.x - p.x);
    p.shield = p.maxShield; p.shieldT = 0; p.invuln = 1.4;
    p.charge = 0; p.charging = false; p.cool = 0.3;
    cam.x = p.x; cam.y = p.y; cam.tx = p.x; cam.ty = p.y;
    G.spawnT = 5;
    var initial = sys.faction === 'pirate' ? 3 : sys.faction === 'frontier' ? 2 : (SP.maxEnemies ? 1 : 0);
    for (var i = 0; i < initial; i++) spawnEnemy();
    G.mode = 'flight';
    G.docked = false;
    if (announce) say(sys.name.toUpperCase() + '  ·  ' + FAC_NAME[sys.faction] + ' SPACE');
    saveGame();
  }

  /* ------------------------------------------------------------------ */
  /* bullets + particles: fixed pools, zero per-frame allocation         */
  /* ------------------------------------------------------------------ */
  var BMAX = 340, PMAX = 460;
  var bullets = [], parts = [], bIdx = 0, pIdx = 0;

  function initPools() {
    bullets = new Array(BMAX);
    for (var i = 0; i < BMAX; i++) bullets[i] = { on: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, dmg: 0, own: 0, kind: 'tracer', r: 2, color: '#fff', homing: 0, target: null, pierce: 0, aoe: 0, fuse: 0, ignore: null, trail: 0, ang: 0 };
    parts = new Array(PMAX);
    for (var j = 0; j < PMAX; j++) parts[j] = { on: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 2, color: '#fff', kind: 'spark', a: 0, va: 0, txt: '' };
  }
  function bget() {
    for (var k = 0; k < BMAX; k++) { bIdx = (bIdx + 1) % BMAX; if (!bullets[bIdx].on) return bullets[bIdx]; }
    return bullets[bIdx];
  }
  function pget() {
    for (var k = 0; k < PMAX; k++) { pIdx = (pIdx + 1) % PMAX; if (!parts[pIdx].on) return parts[pIdx]; }
    return parts[pIdx];
  }
  function clearBullets() { for (var i = 0; i < bullets.length; i++) bullets[i].on = false; }
  function clearParticles() { for (var i = 0; i < parts.length; i++) parts[i].on = false; }

  function spawnBullet(x, y, ang, spd, dmg, own, kind, w) {
    var b = bget();
    b.on = true; b.x = x; b.y = y; b.ang = ang;
    b.vx = Math.cos(ang) * spd; b.vy = Math.sin(ang) * spd;
    b.dmg = dmg; b.own = own; b.kind = kind;
    b.target = null; b.pierce = 0; b.aoe = 0; b.fuse = 0; b.ignore = null; b.trail = 0;
    b.color = w ? w.color : '#fff';
    b.life = kind === 'rail' ? 0.72 : kind === 'missile' ? 3.4 : 1.5;
    b.r = kind === 'rail' ? 4 : kind === 'missile' ? 3.5 : kind === 'flak' ? 4 : 2.4;
    if (kind === 'rail') b.pierce = w.pierce || 2;
    if (kind === 'missile') b.homing = w.homing || 2.4;
    if (kind === 'flak') { b.fuse = w.fuse || 0.6; b.aoe = w.aoe || 60; }
    if (kind === 'missile') b.aoe = w.aoe || 40;
    return b;
  }

  function spawnP(x, y, vx, vy, life, size, color, kind) {
    var p = pget();
    p.on = true; p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.life = life; p.max = life; p.size = size; p.color = color; p.kind = kind || 'spark';
    p.a = Math.random() * TAU; p.va = rr(-6, 6); p.txt = '';
    return p;
  }
  function sparks(x, y, color, n, spd) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * TAU, s = rr(spd * 0.35, spd);
      spawnP(x, y, Math.cos(a) * s, Math.sin(a) * s, rr(0.25, 0.6), rr(1.2, 2.6), color, 'spark');
    }
  }
  function ring(x, y, color, size) {
    var p = spawnP(x, y, 0, 0, 0.45, size || 8, color, 'ring');
    p.va = 1;
  }
  function debris(x, y, color, n) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * TAU, s = rr(40, 170);
      spawnP(x, y, Math.cos(a) * s, Math.sin(a) * s, rr(0.7, 1.5), rr(2, 5.5), color, 'shard');
    }
  }
  function floatText(x, y, s, color) {
    var p = spawnP(x, y, rr(-8, 8), -26, 1.1, 9, color, 'text');
    p.txt = s;
  }

  function updateParticles(dt) {
    for (var i = 0; i < PMAX; i++) {
      var p = parts[i];
      if (!p.on) continue;
      p.life -= dt;
      if (p.life <= 0) { p.on = false; continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.a += p.va * dt;
      var damp = p.kind === 'smoke' ? 0.4 : p.kind === 'text' ? 1.4 : 2.2;
      var f = Math.max(0, 1 - damp * dt);
      p.vx *= f; p.vy *= f;
    }
  }

  /* ------------------------------------------------------------------ */
  /* player: thrust-vector flight with momentum and a little drift      */
  /* ------------------------------------------------------------------ */
  var IN = { x: 0, y: 0, fire: false, boost: false, use: false };

  function updatePlayer(dt) {
    var p = G.player;
    var mx = IN.x, my = IN.y;
    var mag = Math.sqrt(mx * mx + my * my);
    if (mag > 1) { mx /= mag; my /= mag; mag = 1; }
    var nose = p.a;

    // --- steering: the nose chases the stick at a capped rate. Because thrust
    // --- follows the nose (Quake-style), a hard turn leaves the old velocity
    // --- intact: the ship slides until grip pulls it around.
    if (mag > 0.14) {
      var want = Math.atan2(my, mx);
      var d = angDiff(want, nose);
      var rate = p.turn * (0.55 + 0.45 * Math.min(1, mag * 1.6));
      p.a += clamp(d, -rate * dt, rate * dt);
      nose = p.a;
    }

    var boosting = IN.boost && p.energy > 1;
    var accel = p.accel * (boosting ? 2.15 : 1);
    p.thrust = mag > 0.14 ? mag : 0;

    if (p.thrust > 0) {
      p.vx += Math.cos(nose) * accel * mag * dt;
      p.vy += Math.sin(nose) * accel * mag * dt;
    }
    if (boosting && p.thrust > 0.05) {
      // afterburner burns energy; it is the only way to outrun a raider
      p.energy -= 26 * dt;
      p.boost = 1;
      if (Math.random() < 0.7) {
        spawnP(p.x - Math.cos(nose) * 15, p.y - Math.sin(nose) * 15,
          -Math.cos(nose) * rr(40, 120) + rr(-30, 30), -Math.sin(nose) * rr(40, 120) + rr(-30, 30),
          rr(0.25, 0.5), rr(2, 4), C.ember, 'smoke');
      }
    } else {
      p.boost = Math.max(0, p.boost - dt * 3);
    }

    // --- grip: kill sideways momentum (never forward momentum). Low value =
    // --- more drift, more "weight". This is the air-control feel.
    var vx = p.vx, vy = p.vy;
    var fwd = vx * Math.cos(nose) + vy * Math.sin(nose);
    var latX = vx - Math.cos(nose) * fwd, latY = vy - Math.sin(nose) * fwd;
    var grip = 2.6 * dt;
    p.vx -= latX * Math.min(1, grip);
    p.vy -= latY * Math.min(1, grip);

    // --- linear drag instead of a speed clamp: acceleration stays authoritative
    var drag = 0.92;
    p.vx *= Math.max(0, 1 - drag * dt);
    p.vy *= Math.max(0, 1 - drag * dt);

    var sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    if (sp > 900) { p.vx *= 900 / sp; p.vy *= 900 / sp; }

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // --- soft arena edge: push back and warn instead of hard-stopping
    var m = 40;
    if (p.x < m) { p.x = m; p.vx = Math.abs(p.vx) * 0.35; }
    if (p.x > ARENA - m) { p.x = ARENA - m; p.vx = -Math.abs(p.vx) * 0.35; }
    if (p.y < m) { p.y = m; p.vy = Math.abs(p.vy) * 0.35; }
    if (p.y > ARENA - m) { p.y = ARENA - m; p.vy = -Math.abs(p.vy) * 0.35; }

    // shields recharge after three seconds out of fire
    p.shieldT = Math.max(0, p.shieldT - dt);
    if (p.shieldT <= 0) p.shield = Math.min(p.maxShield, p.shield + 9 * dt);
    p.energy = Math.min(p.maxEnergy, p.energy + (p.thrust > 0.05 ? 9 : 15) * dt);
    p.flash = Math.max(0, p.flash - dt * 3);
    p.ripple = Math.max(0, p.ripple - dt * 2.2);
    p.invuln = Math.max(0, p.invuln - dt);

    tryFire(dt);
  }

  function aimAngle() {
    // light aim assist: snap to the nearest hostile in a 30 degree cone
    var p = G.player, best = null, bestS = 1e9;
    if (!SP) return p.a;
    for (var i = 0; i < SP.enemies.length; i++) {
      var e = SP.enemies[i];
      if (!e.on) continue;
      var dx = e.x - p.x, dy = e.y - p.y;
      var dd = Math.sqrt(dx * dx + dy * dy);
      if (dd > 820) continue;
      var off = Math.abs(angDiff(Math.atan2(dy, dx), p.a));
      if (off > 0.55) continue;
      var s = off * 2.2 + dd / 1400;
      if (s < bestS) { bestS = s; best = e; }
    }
    if (!best) return p.a;
    var bs = Math.sqrt(best.vx * best.vx + best.vy * best.vy);
    var tof = dist(p.x, p.y, best.x, best.y) / 940;
    return Math.atan2(best.y + best.vy * tof * 0.7 - p.y, best.x + best.vx * tof * 0.7 - p.x);
  }

  function tryFire(dt) {
    var p = G.player, w = WEAPONS[p.wep];
    p.cool -= dt;
    if (w.kind === 'rail') {
      if (IN.fire && p.energy > 5) {
        p.charging = true;
        p.charge = Math.min(1, p.charge + dt / w.charge);
        if (p.charge >= 1 && p.cool <= 0 && p.energy >= w.nrg) { shoot(w, 1); p.charging = false; p.charge = 0; }
      } else if (p.charging) {
        if (p.charge > 0.3 && p.cool <= 0 && p.energy >= w.nrg) shoot(w, p.charge);
        p.charging = false; p.charge = 0;
      }
      return;
    }
    p.charge = 0; p.charging = false;
    if (IN.fire && p.cool <= 0) {
      if (p.energy >= w.nrg) shoot(w, 1);
      else if (p.lowWarn <= 0) { p.lowWarn = 1.2; say('ENERGY LOW'); GK.sfx.hit(); }
    }
    p.lowWarn = Math.max(0, p.lowWarn - dt);
  }

  function shoot(w, power) {
    var p = G.player;
    var base = aimAngle();
    p.cool = w.rof;
    p.energy = Math.max(0, p.energy - w.nrg * (w.kind === 'rail' ? 0.35 + power * 0.65 : 1));
    var n = w.kind === 'rail' ? 1 : w.shots;
    var spread = w.spread || 0;
    for (var i = 0; i < n; i++) {
      var off = n > 1 ? (i - (n - 1) / 2) * spread : 0;
      var ang = base + off + (spread ? rr(-spread * 0.45, spread * 0.45) : 0);
      var bx = p.x + Math.cos(p.a) * 14, by = p.y + Math.sin(p.a) * 14;
      var b = spawnBullet(bx, by, ang, w.spd * (w.kind === 'rail' ? 0.7 + power * 0.3 : 1), w.dmg * p.dmgMul * (w.kind === 'rail' ? 0.5 + power * 0.5 : 1), 'P', w.kind, w);
      if (w.kind === 'missile') b.target = nearestEnemy(1900);
    }
    // muzzle flash + recoil, kept to a handful of particles
    for (var k = 0; k < 3; k++) {
      var a2 = p.a + rr(-0.35, 0.35);
      spawnP(p.x + Math.cos(p.a) * 16, p.y + Math.sin(p.a) * 16, Math.cos(a2) * rr(60, 260), Math.sin(a2) * rr(60, 260), rr(0.08, 0.18), rr(1.5, 3), w.color, 'spark');
    }
    cam.shake = Math.max(cam.shake, w.kind === 'rail' ? w.shake * power : w.kind === 'flak' ? 2.5 : 1.1);
    p.vx -= Math.cos(p.a) * (w.kind === 'rail' ? 34 : 2);
    p.vy -= Math.sin(p.a) * (w.kind === 'rail' ? 34 : 2);
    GK.sfx.shoot();
  }

  function nearestEnemy(maxd) {
    var p = G.player, best = null, bd = maxd || 1e9;
    if (!SP) return null;
    for (var i = 0; i < SP.enemies.length; i++) {
      var e = SP.enemies[i];
      if (!e.on) continue;
      var d = dist(p.x, p.y, e.x, e.y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* hostiles                                                            */
  /* ------------------------------------------------------------------ */
  function spawnEnemy(kind) {
    if (!SP) return null;
    var sys = G.gal.systems[G.cur];
    if (!kind) {
      kind = sys.faction === 'pirate' ? (Math.random() < 0.55 ? 'raider' : Math.random() < 0.6 ? 'interceptor' : 'gunship')
        : (Math.random() < 0.6 ? 'interceptor' : Math.random() < 0.7 ? 'raider' : 'gunship');
    }
    var k = KIND[kind];
    var p = G.player, a = Math.random() * TAU, d = rr(700, 1250);
    var x = clamp(p.x + Math.cos(a) * d, 100, ARENA - 100);
    var y = clamp(p.y + Math.sin(a) * d, 100, ARENA - 100);
    // Threat follows the hull you fly: a Saber draws tougher escorts than the
    // starter shuttle, on top of the old outfit/credit scaling.
    var tier = 1 + (G.player.maxHull / 100 - 1) * 0.5;
    var scale = (1 + G.upgrades.weapon * 0.1 + G.credits / 60000) * tier;
    var spr = k.spr ? k.spr[Math.floor(Math.random() * k.spr.length)] : null;
    var e = {
      on: true, kind: kind, x: x, y: y, vx: 0, vy: 0, a: Math.atan2(p.y - y, p.x - x),
      hp: k.hp * scale, maxHp: k.hp * scale, r: k.r, fireT: rr(0.8, 2), burstT: 0, burst: 0,
      hand: Math.random() < 0.5 ? 1 : -1, flee: false, hitFlash: 0, drift: rr(-0.4, 0.4), age: 0,
      spr: spr, len: SPRITES[spr] ? SPRITES[spr].len : k.r * 2
    };
    SP.enemies.push(e);
    return e;
  }

  function updateEnemies(dt) {
    var p = G.player;
    for (var i = 0; i < SP.enemies.length; i++) {
      var e = SP.enemies[i];
      if (!e.on) continue;
      var k = KIND[e.kind];
      e.age += dt;
      e.hitFlash = Math.max(0, e.hitFlash - dt * 4);
      var dx = p.x - e.x, dy = p.y - e.y;
      var d = Math.sqrt(dx * dx + dy * dy) || 1;
      var toP = Math.atan2(dy, dx);
      var desired = toP, thrust = 1;

      /* --- three behaviours ------------------------------------------
       * interceptor: closes fast, then strafes across the target so the
       *   player has to lead a moving ship.
       * gunship: holds a firing envelope (~380u), backs off when crowded.
       * raider: presses the attack, but breaks and runs once badly hurt.
       * ------------------------------------------------------------ */
      if (e.kind === 'interceptor') {
        if (d > 340) { desired = toP + Math.sin(e.age * 1.3 + e.drift) * 0.18; thrust = 1; }
        else { desired = toP + e.hand * 1.25; thrust = 0.8; }
      } else if (e.kind === 'gunship') {
        if (d > 480) { desired = toP; thrust = 1; }
        else if (d < 250) { desired = toP + Math.PI; thrust = 0.9; }
        else { desired = toP + e.hand * Math.PI * 0.5; thrust = 0.45; }
      } else {
        if (e.hp < e.maxHp * 0.42) e.flee = true;
        if (e.flee) { desired = toP + Math.PI + e.hand * 0.25; thrust = 1; }
        else if (d > 300) { desired = toP; thrust = 1; }
        else { desired = toP + e.hand * 0.95; thrust = 0.75; }
      }

      // keep inside the arena
      if (e.x < 140 && Math.cos(desired) < 0) desired = 0;
      if (e.x > ARENA - 140 && Math.cos(desired) > 0) desired = Math.PI;
      if (e.y < 140 && Math.sin(desired) < 0) desired = Math.PI * 0.5;
      if (e.y > ARENA - 140 && Math.sin(desired) > 0) desired = -Math.PI * 0.5;

      // Attack runs: when the guns are nearly ready, swing the nose onto the
      // target instead of orbiting it forever. This is what keeps a strafing
      // interceptor from circling a stationary player without ever shooting.
      if (!e.flee && e.fireT < 0.28 && d < 720) {
        desired = toP;
        if (thrust < 0.45) thrust = 0.45;
      }

      var turn = k.turn * (e.flee ? 1.3 : 1);
      e.a += clamp(angDiff(desired, e.a), -turn * dt, turn * dt);
      e.vx += Math.cos(e.a) * k.acc * thrust * dt;
      e.vy += Math.sin(e.a) * k.acc * thrust * dt;
      e.vx *= Math.max(0, 1 - 1.5 * dt);
      e.vy *= Math.max(0, 1 - 1.5 * dt);
      var sp = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
      if (sp > k.maxv) { e.vx *= k.maxv / sp; e.vy *= k.maxv / sp; }
      e.x += e.vx * dt; e.y += e.vy * dt;

      // fire when the nose is roughly on target
      if (!e.flee && d < 760 && e.age > 1.2) {
        e.fireT -= dt;
        if (e.fireT <= 0 && Math.abs(angDiff(toP, e.a)) < 0.45) {
          e.fireT = k.fire * rr(0.85, 1.25);
          var lead = d / 620;
          var aim = Math.atan2(p.y + p.vy * lead * 0.55 - e.y, p.x + p.vx * lead * 0.55 - e.x);
          aim += rr(-0.05, 0.05);
          var shots = e.kind === 'gunship' ? 2 : 1;
          for (var s = 0; s < shots; s++) {
            var b = spawnBullet(e.x + Math.cos(e.a) * e.r, e.y + Math.sin(e.a) * e.r,
              aim + (shots > 1 ? (s - 0.5) * 0.09 : 0), 560, k.dmg * 0.85, 'E', 'tracer', { color: k.col });
            b.life = 1.4;
          }
          sparks(e.x + Math.cos(e.a) * e.r, e.y + Math.sin(e.a) * e.r, k.col, 2, 90);
        }
      }
    }
    // reap
    var live = [];
    for (var j = 0; j < SP.enemies.length; j++) if (SP.enemies[j].on) live.push(SP.enemies[j]);
    if (live.length !== SP.enemies.length) SP.enemies = live;
  }

  function damageEnemy(e, dmg, hx, hy, col) {
    e.hp -= dmg;
    e.hitFlash = 1;
    sparks(hx, hy, col || C.cyan, 3, 150);
    if (e.hp <= 0) killEnemy(e);
  }

  function killEnemy(e) {
    if (!e.on) return;
    e.on = false;
    var k = KIND[e.kind];
    var gain = Math.round(k.bounty * rr(0.85, 1.25));
    G.credits += gain;
    G.kills++;
    floatText(e.x, e.y - 12, '+' + money(gain), C.gold);
    debris(e.x, e.y, k.col, e.kind === 'gunship' ? 12 : 7);
    sparks(e.x, e.y, C.ember, 14, 260);
    ring(e.x, e.y, C.ember, 10);
    ring(e.x, e.y, C.cyan, 4);
    cam.shake = Math.max(cam.shake, 7);
    GK.sfx.boom();
    if (G.rep.pirate > -100) G.rep.pirate -= 2;
    if (G.rep.core < 100) G.rep.core += 1;
    if (G.rep.frontier < 100) G.rep.frontier += 1;
    // bounty contracts tick on every pirate kill
    for (var i = 0; i < G.active.length; i++) {
      var m = G.active[i];
      if (m.type === 'bounty' && !m.done) {
        m.prog++;
        if (m.prog >= m.need) completeMission(m);
      }
    }
  }

  function hurtPlayer(dmg, fx, fy) {
    var p = G.player;
    if (p.invuln > 0 || G.mode !== 'flight') return;
    p.shieldT = 3.2;
    p.ripple = 1;
    p.rippleA = Math.atan2(fy - p.y, fx - p.x);
    var absorbed = Math.min(p.shield, dmg);
    p.shield -= absorbed;
    dmg -= absorbed;
    if (absorbed > 0) GK.sfx.hit();
    if (dmg > 0) {
      p.hull -= dmg;
      p.flash = 1;
      cam.shake = Math.max(cam.shake, 8);
      GK.sfx.hurt();
      GK.buzz(22);
      sparks(p.x, p.y, C.ember, 6, 190);
    }
    if (p.hull <= 0) { p.hull = 0; die(); }
  }

  function die() {
    if (G.mode === 'dead') return;
    G.mode = 'dead';
    G.deaths++;
    var p = G.player;
    p.dead = true;
    for (var i = 0; i < 26; i++) {
      var a = Math.random() * TAU, s = rr(60, 340);
      spawnP(p.x, p.y, Math.cos(a) * s, Math.sin(a) * s, rr(0.7, 1.6), rr(2, 5), i % 3 ? C.ember : C.cyan, i % 4 ? 'spark' : 'shard');
    }
    ring(p.x, p.y, C.ember, 24);
    cam.shake = 22;
    GK.sfx.boom();
    GK.sfx.lose();
    pad.show(false);
  }

  function respawn() {
    if (!G) return;
    var p = G.player;
    // cargo is lost in the wreck; a fraction of the credits goes to recovery fees
    var lost = 0;
    for (var id in G.cargo) {
      var keep = Math.floor(G.cargo[id] * 0.7);
      lost += G.cargo[id] - keep;
      if (keep > 0) G.cargo[id] = keep; else delete G.cargo[id];
    }
    G.credits = Math.max(0, Math.round(G.credits * 0.9));
    G.freight = [];
    G.cur = G.lastStation;
    p.dead = false;
    p.hull = Math.max(1, Math.round(p.maxHull * 0.6));
    enterSystem(G.cur, false);
    p.shield = p.maxShield * 0.5;
    p.invuln = 2.5;
    G.mode = 'flight';
    pad.show(true);
    say('RECOVERED AT ' + G.gal.systems[G.cur].name.toUpperCase() + '  ·  -' + lost + ' CARGO');
    saveGame();
  }

  /* ------------------------------------------------------------------ */
  /* bullets in flight, hits, area damage                                */
  /* ------------------------------------------------------------------ */
  function nearestFrom(x, y, maxd) {
    var best = null, bd = maxd;
    for (var i = 0; i < SP.enemies.length; i++) {
      var e = SP.enemies[i];
      if (!e.on) continue;
      var d = dist(x, y, e.x, e.y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  function burst(b) {
    explodeAt(b.x, b.y, b.aoe, b.dmg, b.own);
    ring(b.x, b.y, C.gold, 6);
  }

  function explodeAt(x, y, r, dmg, own) {
    if (own === 'P') {
      for (var i = 0; i < SP.enemies.length; i++) {
        var e = SP.enemies[i];
        if (!e.on) continue;
        var d = dist(x, y, e.x, e.y);
        if (d < r + e.r) damageEnemy(e, dmg * (1 - 0.5 * d / (r + e.r)), e.x, e.y, C.gold);
      }
    } else {
      var dp = dist(x, y, G.player.x, G.player.y);
      if (dp < r + 16) hurtPlayer(dmg * 0.8, x, y);
    }
    sparks(x, y, C.gold, 10, 240);
    spawnP(x, y, 0, 0, 0.4, r * 0.5, 'rgba(255,200,120,0.55)', 'ring');
    cam.shake = Math.max(cam.shake, 5);
    GK.sfx.boom();
  }

  function updateBullets(dt) {
    var p = G.player;
    for (var i = 0; i < BMAX; i++) {
      var b = bullets[i];
      if (!b.on) continue;
      b.life -= dt;

      if (b.kind === 'missile') {
        var t = b.target;
        if (!t || !t.on) { t = b.target = nearestFrom(b.x, b.y, 1500); }
        if (t) {
          var want = Math.atan2(t.y - b.y, t.x - b.x);
          var cur = Math.atan2(b.vy, b.vx);
          var na = cur + clamp(angDiff(want, cur), -b.homing * dt, b.homing * dt);
          var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
          b.vx = Math.cos(na) * sp; b.vy = Math.sin(na) * sp;
          b.ang = na;
        }
        b.trail -= dt;
        if (b.trail <= 0) {
          b.trail = 0.035;
          spawnP(b.x, b.y, rr(-14, 14), rr(-14, 14), 0.4, 2.6, 'rgba(255,122,69,0.45)', 'smoke');
        }
      }
      if (b.kind === 'flak') {
        b.fuse -= dt;
        if (b.fuse <= 0) { burst(b); b.on = false; continue; }
      }
      if (b.life <= 0) {
        if (b.kind === 'flak') burst(b);
        if (b.kind === 'missile') explodeAt(b.x, b.y, b.aoe, b.dmg, b.own);
        b.on = false; continue;
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.x < -140 || b.x > ARENA + 140 || b.y < -140 || b.y > ARENA + 140) { b.on = false; continue; }

      // rocks eat bullets: they double as cover
      for (var r = 0; r < SP.rocks.length; r++) {
        var k = SP.rocks[r];
        if (dist(b.x, b.y, k.x, k.y) < k.r * 0.92) {
          sparks(b.x, b.y, '#8d9aae', 4, 130);
          if (b.kind === 'flak') burst(b);
          b.on = false;
          break;
        }
      }
      if (!b.on) continue;

      if (b.own === 'P') {
        for (var ei = 0; ei < SP.enemies.length; ei++) {
          var e = SP.enemies[ei];
          if (!e.on || e === b.ignore) continue;
          if (dist(b.x, b.y, e.x, e.y) > e.r + b.r) continue;
          damageEnemy(e, b.dmg, b.x, b.y, b.color);
          ring(b.x, b.y, b.color, 3);
          cam.shake = Math.max(cam.shake, b.kind === 'rail' ? 6 : 1.8);
          if (b.kind === 'rail') { b.ignore = e; b.pierce--; if (b.pierce <= 0) b.on = false; }
          else if (b.kind === 'missile') { explodeAt(b.x, b.y, b.aoe, b.dmg * 0.8, 'P'); b.on = false; }
          else if (b.kind === 'flak') { burst(b); b.on = false; }
          else b.on = false;
          break;
        }
      } else if (p.invuln <= 0 && dist(b.x, b.y, p.x, p.y) < 20) {
        hurtPlayer(b.dmg, b.x, b.y);
        b.on = false;
      }
    }
  }

  function collideRocks() {
    var p = G.player;
    for (var i = 0; i < SP.rocks.length; i++) {
      var k = SP.rocks[i];
      var d = dist(p.x, p.y, k.x, k.y);
      var min = k.r * 0.9 + 12;
      if (d < min && d > 0.01) {
        var nx = (p.x - k.x) / d, ny = (p.y - k.y) / d;
        p.x = k.x + nx * min;
        p.y = k.y + ny * min;
        var vn = p.vx * nx + p.vy * ny;
        if (vn < 0) { p.vx -= nx * vn * 1.6; p.vy -= ny * vn * 1.6; }
        if (Math.abs(vn) > 260) hurtPlayer(4, k.x, k.y);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* per-frame world step                                                */
  /* ------------------------------------------------------------------ */
  var VIEW = { w: 640, h: 360 };

  function updateSpace(dt) {
    var p = G.player;
    G.time += dt;
    G.flightT = (G.flightT || 0) + dt;

    updatePlayer(dt);
    updateEnemies(dt);
    updateBullets(dt);
    collideRocks();
    updateParticles(dt);

    SP.station.spin += dt * 0.15;
    SP.gate.spin += dt * 0.55;
    for (var i = 0; i < SP.rocks.length; i++) SP.rocks[i].a += SP.rocks[i].spin * dt;
    for (var tv = 0; tv < SP.traffic.length; tv++) {
      var tr = SP.traffic[tv];
      tr.a += tr.w * dt;
      tr.x = tr.cx + Math.cos(tr.a) * tr.r;
      tr.y = tr.cy + Math.sin(tr.a) * tr.r * 0.85;
      tr.ang = Math.atan2(Math.cos(tr.a) * tr.w * 0.85, -Math.sin(tr.a) * tr.w);
    }

    // trickle of new hostiles so a system never goes quiet for long
    if (SP.maxEnemies > 0) {
      var alive = 0;
      for (var e = 0; e < SP.enemies.length; e++) if (SP.enemies[e].on) alive++;
      G.spawnT -= dt;
      if (alive < SP.maxEnemies && G.spawnT <= 0) {
        spawnEnemy();
        G.spawnT = rr(4.5, 9);
      }
    }

    // camera: look ahead along the velocity vector so fast flight reads well
    cam.tx = p.x + p.vx * 0.26;
    cam.ty = p.y + p.vy * 0.26;
    var k = Math.min(1, dt * 5.5);
    cam.x += (cam.tx - cam.x) * k;
    cam.y += (cam.ty - cam.y) * k;
    var hw = VIEW.w * 0.5, hh = VIEW.h * 0.5;
    cam.x = clamp(cam.x, Math.min(hw, ARENA * 0.5), Math.max(ARENA - hw, ARENA * 0.5));
    cam.y = clamp(cam.y, Math.min(hh, ARENA * 0.5), Math.max(ARENA - hh, ARENA * 0.5));
    cam.shake = Math.max(0, cam.shake - dt * 34);

    G.toastT = Math.max(0, G.toastT - dt);
    if (G.toastT <= 0) G.toast = null;
  }

  function say(msg) { if (!G) return; G.toast = msg; G.toastT = 2.8; }

  function stationInRange() {
    if (!G || !SP) return false;
    return dist(G.player.x, G.player.y, SP.station.x, SP.station.y) < 165;
  }

  /* ------------------------------------------------------------------ */
  /* economy                                                             */
  /* ------------------------------------------------------------------ */
  function cargoCount() {
    var n = 0;
    for (var id in G.cargo) n += G.cargo[id];
    return n;
  }
  function cargoFree() { return Math.max(0, G.player.hold - cargoCount()); }

  function buyCommodity(ci, qty) {
    if (!G || G.mode !== 'station') return false;
    var sys = G.gal.systems[G.cur];
    var unit = priceOf(sys, ci, 'buy');
    var max = Math.min(qty, Math.floor(cargoFree()), Math.floor(sys.market[ci].stock), Math.floor(G.credits / unit));
    if (max <= 0) return false;
    G.credits -= unit * max;
    sys.market[ci].stock -= max;
    var id = COMM[ci].id;
    G.cargo[id] = (G.cargo[id] || 0) + max;
    G.traded += max;
    G.rep[sys.faction] = clamp((G.rep[sys.faction] || 0) + max * 0.12, -100, 100);
    GK.sfx.coin();
    saveGame();
    return true;
  }

  function sellCommodity(ci, qty) {
    if (!G || G.mode !== 'station') return false;
    var sys = G.gal.systems[G.cur];
    var id = COMM[ci].id;
    var have = G.cargo[id] || 0;
    var n = Math.min(qty, have);
    if (n <= 0) return false;
    var unit = priceOf(sys, ci, 'sell');
    G.credits += unit * n;
    sys.market[ci].stock = Math.min(COMM[ci].stock0 * 1.7, sys.market[ci].stock + n);
    G.cargo[id] = have - n;
    if (G.cargo[id] <= 0) delete G.cargo[id];
    G.traded += n;
    G.rep[sys.faction] = clamp((G.rep[sys.faction] || 0) + n * 0.1, -100, 100);
    GK.sfx.coin();
    saveGame();
    return true;
  }

  var UPG = [
    { key: 'cargo', name: 'CARGO BAY', desc: '+8 hold', max: 4, cost: [1200, 2600, 4600, 7600] },
    { key: 'shield', name: 'SHIELD ARRAY', desc: '+16 shield', max: 4, cost: [900, 2000, 3600, 6000] },
    { key: 'hull', name: 'HULL PLATING', desc: '+14 hull', max: 3, cost: [800, 1800, 3400] },
    { key: 'weapon', name: 'WEAPON CORE', desc: '+12% damage', max: 3, cost: [1400, 3000, 5600] },
    { key: 'engine', name: 'ENGINE TUNING', desc: '+7.5% thrust', max: 3, cost: [1000, 2200, 4400] }
  ];

  function buyUpgrade(key) {
    if (!G || G.mode !== 'station') return false;
    for (var i = 0; i < UPG.length; i++) {
      var u = UPG[i];
      if (u.key !== key) continue;
      var lvl = G.upgrades[key];
      if (lvl >= u.max) return false;
      var price = u.cost[lvl];
      if (G.credits < price) { say('NOT ENOUGH CREDITS'); GK.sfx.hit(); return false; }
      G.credits -= price;
      G.upgrades[key] = lvl + 1;
      applyUpgrades();
      if (key === 'shield') G.player.shield = G.player.maxShield;
      if (key === 'hull') G.player.hull = Math.min(G.player.maxHull, G.player.hull + 14);
      GK.sfx.unlock();
      say(u.name + ' MK' + (lvl + 2) + ' INSTALLED');
      saveGame();
      return true;
    }
    return false;
  }

  // Shipyard: buy an ES hull, trading in the one you flew in for 40% of its
  // price. The hull's hull/shield/cargo/thrust/turn replace the base stats and
  // the outfit levels the player already owns carry over.
  function tradeInValue(key) { return Math.round(hullDef(key).price * 0.4); }

  function buyShip(key) {
    if (!G || G.mode !== 'station') return false;
    var h = hullDef(key);
    if (!h || G.player.ship === key) return false;
    var cost = Math.max(0, h.price - tradeInValue(G.player.ship));
    if (G.credits < cost) { say('NOT ENOUGH CREDITS'); GK.sfx.hit(); return false; }
    G.credits -= cost;
    G.player.ship = key;
    applyUpgrades();
    var p = G.player;
    p.hull = p.maxHull;
    p.shield = p.maxShield;
    // a smaller hold leaves cargo on the dock rather than in the void
    while (cargoCount() > p.hold) {
      var dropped = false;
      for (var id in G.cargo) {
        if (G.cargo[id] > 0) {
          G.cargo[id]--;
          if (G.cargo[id] <= 0) delete G.cargo[id];
          dropped = true;
          break;
        }
      }
      if (!dropped) break;
    }
    GK.sfx.unlock();
    say(h.name + ' PURCHASED');
    saveGame();
    return true;
  }

  function repairHull() {
    var p = G.player;
    var need = Math.ceil(p.maxHull - p.hull);
    if (need <= 0) return false;
    var cost = need * 3;
    if (G.credits < cost) { say('NOT ENOUGH CREDITS'); GK.sfx.hit(); return false; }
    G.credits -= cost;
    p.hull = p.maxHull;
    GK.sfx.win();
    say('HULL REPAIRED');
    saveGame();
    return true;
  }

  function refuel() {
    var need = Math.ceil(24 - G.fuel);
    if (need <= 0) return false;
    var cost = need * 11;
    if (G.credits < cost) { say('NOT ENOUGH CREDITS'); GK.sfx.hit(); return false; }
    G.credits -= cost;
    G.fuel = 24;
    GK.sfx.coin();
    saveGame();
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* missions                                                            */
  /* ------------------------------------------------------------------ */
  function hops(a, b) {
    // BFS over the lane graph — short maps, so this is cheap and exact
    var q = [a], seen = {}, d = {};
    seen[a] = true; d[a] = 0;
    while (q.length) {
      var cur = q.shift();
      if (cur === b) return d[cur];
      var adj = G.gal.adj[cur];
      for (var i = 0; i < adj.length; i++) {
        if (!seen[adj[i]]) { seen[adj[i]] = true; d[adj[i]] = d[cur] + 1; q.push(adj[i]); }
      }
    }
    return 99;
  }

  function boardFor(sysId) {
    if (!G.boards) G.boards = {};
    if (G.boards[sysId]) return G.boards[sysId];
    var rng = GK.rand((G.seed ^ ((sysId + 7) * 104729)) >>> 0);
    var list = [];
    for (var i = 0; i < 3; i++) {
      var id = sysId + ':' + i;
      if (G.taken[id]) continue;
      var type = i === 0 ? 'courier' : i === 1 ? 'bounty' : (rng() < 0.6 ? 'survey' : 'courier');
      var m = { id: id, type: type, from: sysId, taken: false };
      if (type === 'courier') {
        var to = sysId, guard = 0;
        while ((to === sysId || hops(sysId, to) > 3) && guard++ < 40) to = GK.ri(rng, 0, G.gal.n - 1);
        var ci = GK.ri(rng, 0, COMM.length - 1);
        var qty = GK.ri(rng, 4, 10);
        m.to = to; m.comm = ci; m.qty = qty;
        m.reward = Math.round((340 + qty * COMM[ci].base * 0.7) * (1 + hops(sysId, to) * 0.18));
        m.title = 'HAUL ' + qty + 'x ' + COMM[ci].short;
        m.sub = 'TO ' + G.gal.systems[to].name.toUpperCase();
      } else if (type === 'bounty') {
        m.need = GK.ri(rng, 3, 6);
        m.reward = Math.round(m.need * 130 * rr(0.9, 1.25));
        m.title = 'CLEAR ' + m.need + ' HOSTILES';
        m.sub = 'ANY SYSTEM  ·  BOUNTY CONTRACT';
      } else {
        var to2 = sysId, g2 = 0;
        while ((to2 === G.gal.home || to2 === sysId) && g2++ < 40) to2 = GK.ri(rng, 0, G.gal.n - 1);
        m.to = to2;
        m.reward = Math.round(380 + hops(sysId, to2) * 160 * rr(0.9, 1.2));
        m.title = 'SURVEY ' + G.gal.systems[to2].name.toUpperCase();
        m.sub = 'DEEP SCAN THAT SYSTEM';
      }
      m.giver = G.gal.systems[sysId].faction;
      list.push(m);
    }
    G.boards[sysId] = list;
    return list;
  }

  function acceptMission(m) {
    if (!G || G.mode !== 'station') return false;
    if (G.active.length >= 3) { say('MISSION LOG FULL'); GK.sfx.hit(); return false; }
    if (m.type === 'courier' && cargoFree() < m.qty) { say('NOT ENOUGH CARGO SPACE'); GK.sfx.hit(); return false; }
    var copy = { id: m.id, type: m.type, from: m.from, to: m.to, comm: m.comm, qty: m.qty, need: m.need,
      reward: m.reward, prog: 0, done: false, title: m.title, sub: m.sub, giver: m.giver };
    G.active.push(copy);
    if (copy.type === 'courier') G.freight.push({ id: copy.id, to: copy.to, comm: copy.comm, qty: copy.qty });
    G.taken[m.id] = true;
    m.taken = true;
    var b = boardFor(G.cur);
    var ix = b.indexOf(m);
    if (ix >= 0) b.splice(ix, 1);
    GK.sfx.unlock();
    say('CONTRACT ACCEPTED');
    saveGame();
    return true;
  }

  function completeMission(m) {
    if (m.done) return;
    m.done = true;
    G.credits += m.reward;
    G.rep[m.giver] = clamp((G.rep[m.giver] || 0) + 7, -100, 100);
    var other = m.giver === 'core' ? 'frontier' : m.giver === 'frontier' ? 'core' : null;
    if (other) G.rep[other] = clamp((G.rep[other] || 0) + 2, -100, 100);
    floatText(G.player.x, G.player.y - 26, '+' + money(m.reward) + ' CR', C.gold);
    say('CONTRACT COMPLETE  +' + money(m.reward) + ' CR');
    GK.sfx.win();
    for (var i = G.active.length - 1; i >= 0; i--) if (G.active[i].id === m.id) G.active.splice(i, 1);
    for (var f = G.freight.length - 1; f >= 0; f--) if (G.freight[f].id === m.id) G.freight.splice(f, 1);
    saveGame();
  }

  function abandonMission(m) {
    for (var i = G.active.length - 1; i >= 0; i--) if (G.active[i].id === m.id) G.active.splice(i, 1);
    for (var f = G.freight.length - 1; f >= 0; f--) if (G.freight[f].id === m.id) G.freight.splice(f, 1);
    G.rep[m.giver] = clamp((G.rep[m.giver] || 0) - 3, -100, 100);
    say('CONTRACT DROPPED');
    saveGame();
  }

  /* ------------------------------------------------------------------ */
  /* travel + docking                                                    */
  /* ------------------------------------------------------------------ */
  function jumpCost(a, b) {
    var s1 = G.gal.systems[a], s2 = G.gal.systems[b];
    var d = dist(s1.x, s1.y * 1.45, s2.x, s2.y * 1.45);
    return d > 0.26 ? 2 : 1;
  }

  function jumpTo(target) {
    if (!G || target == null || target === G.cur) return false;
    if (!laneKnown(G.cur, target)) { say('NO LANE CHARTED — SCAN FIRST'); return false; }
    var cost = jumpCost(G.cur, target);
    if (G.fuel < cost) { say('INSUFFICIENT FUEL — DOCK TO REFUEL'); GK.sfx.hit(); return false; }
    G.fuel -= cost;
    G.mode = 'flight';
    GK.sfx.jump();
    enterSystem(target, true);
    pad.show(true);
    return true;
  }

  function dock() {
    if (!G || !SP || G.player.dead || G.mode === 'dead') return false;
    var p = G.player;
    G.docked = true;
    G.lastStation = G.cur;
    G.mode = 'station';
    G.stationTab = G.stationTab || 'market';
    G.selComm = G.selComm || 0;
    G.selSys = G.cur;
    pad.show(false);
    GK.sfx.jump();
    GK.sfx.unlock();
    // courier freight is handed over on arrival
    for (var i = G.freight.length - 1; i >= 0; i--) {
      if (G.freight[i].to === G.cur) {
        for (var a = 0; a < G.active.length; a++) {
          var m = G.active[a];
          if (m.id === G.freight[i].id) { completeMission(m); break; }
        }
      }
    }
    p.vx = 0; p.vy = 0;
    saveGame();
    return true;
  }

  function undock() {
    if (!G) return false;
    G.mode = 'flight';
    G.docked = false;
    var p = G.player;
    p.x = SP.station.x + 190;
    p.y = SP.station.y + 40;
    p.vx = 0; p.vy = 0;
    p.invuln = 1.5;
    pad.show(true);
    saveGame();
    return true;
  }

  function deepScan() {
    if (!G) return false;
    var id = G.cur;
    G.scanned[id] = true;
    revealLinks(id);
    var adj = G.gal.adj[id];
    for (var i = 0; i < adj.length; i++) revealLinks(adj[i]);
    G.fuel = Math.max(0, G.fuel - 1);
    for (var a = 0; a < G.active.length; a++) {
      var m = G.active[a];
      if (m.type === 'survey' && m.to === id) completeMission(m);
    }
    GK.sfx.unlock();
    say('DEEP SCAN COMPLETE  ·  ' + G.gal.systems[id].name.toUpperCase() + ' MAPPED');
    saveGame();
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* canvas UI kit: buttons register a hit-rect as they are drawn        */
  /* ------------------------------------------------------------------ */
  var UI = { hits: [] };
  function hit(x, y, w, h, fn) { UI.hits.push({ x: x, y: y, w: w, h: h, fn: fn }); }
  function glow(ctx, col, blur) { ctx.shadowColor = col; ctx.shadowBlur = blur; }
  function noglow(ctx) { ctx.shadowBlur = 0; }

  function button(ctx, label, x, y, w, h, fn, o) {
    o = o || {};
    var dis = !!o.disabled;
    var bg = dis ? 'rgba(255,255,255,0.03)' : (o.bg || 'rgba(77,226,255,0.10)');
    var bd = dis ? 'rgba(255,255,255,0.10)' : (o.border || 'rgba(77,226,255,0.45)');
    var fg = dis ? C.dim : (o.fg || C.cyan);
    rrect(ctx, x, y, w, h, o.r == null ? 4 : o.r);
    ctx.fillStyle = bg; ctx.fill();
    ctx.strokeStyle = bd; ctx.lineWidth = 1; ctx.stroke();
    txt(ctx, label, x + w / 2, y + h / 2 + 0.5, o.size || 9.5, fg, 'center', 700, o.mono !== false);
    if (!dis && fn) hit(x, y, w, h, fn);
  }

  function chip(ctx, label, x, y, w, h, on, fn) {
    rrect(ctx, x, y, w, h, 4);
    ctx.fillStyle = on ? 'rgba(77,226,255,0.16)' : 'rgba(255,255,255,0.04)';
    ctx.fill();
    ctx.strokeStyle = on ? 'rgba(77,226,255,0.75)' : 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1; ctx.stroke();
    txt(ctx, label, x + w / 2, y + h / 2 + 0.5, 8.5, on ? C.ink : C.mid, 'center', 700, true);
    if (fn) hit(x, y, w, h, fn);
  }

  function panel(ctx, x, y, w, h, alpha) {
    rrect(ctx, x, y, w, h, 6);
    ctx.fillStyle = alpha ? 'rgba(6,9,17,' + alpha + ')' : C.panel;
    ctx.fill();
    ctx.strokeStyle = 'rgba(77,226,255,0.18)';
    ctx.lineWidth = 1; ctx.stroke();
  }

  /* ------------------------------------------------------------------ */
  /* starfield                                                           */
  /* ------------------------------------------------------------------ */
  var STARS = [];
  function initStars() {
    STARS.length = 0;
    for (var i = 0; i < 170; i++) {
      STARS.push({
        x: Math.random(), y: Math.random(),
        p: i % 3 === 0 ? 0.5 : 0.22,
        r: Math.random() < 0.12 ? 2 : 1,
        a: 0.2 + Math.random() * 0.6,
        tw: Math.random() * TAU
      });
    }
  }

  function drawBackdrop(ctx, t) {
    var W = VIEW.w, H = VIEW.h;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    if (SP && SP.neb) {
      var s = Math.max(W, H) * 1.7;
      var ox = (W - s) * 0.5 - (cam.x - ARENA * 0.5) * 0.05;
      var oy = (H - s) * 0.5 - (cam.y - ARENA * 0.5) * 0.05;
      ctx.globalAlpha = 0.95;
      ctx.drawImage(SP.neb, ox, oy, s, s);
      ctx.globalAlpha = 1;
    }
    for (var i = 0; i < STARS.length; i++) {
      var st = STARS[i];
      var sx = mod(st.x * W - cam.x * st.p, W + 40) - 20;
      var sy = mod(st.y * H - cam.y * st.p, H + 40) - 20;
      ctx.globalAlpha = st.a * (0.72 + 0.28 * Math.sin(t * 1.7 + st.tw));
      ctx.fillStyle = i % 11 === 0 ? '#ffd7c2' : '#d8ecff';
      ctx.fillRect(sx, sy, st.r, st.r);
    }
    ctx.globalAlpha = 1;
  }

  function onScreen(x, y, pad) {
    return Math.abs(x - cam.x) < VIEW.w * 0.5 + (pad || 60) && Math.abs(y - cam.y) < VIEW.h * 0.5 + (pad || 60);
  }

  /* ------------------------------------------------------------------ */
  /* world rendering                                                     */
  /* ------------------------------------------------------------------ */
  function drawArena(ctx, t) {
    var g = 400;
    ctx.strokeStyle = 'rgba(77,226,255,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = g; x < ARENA; x += g) { ctx.moveTo(x, 0); ctx.lineTo(x, ARENA); }
    for (var y = g; y < ARENA; y += g) { ctx.moveTo(0, y); ctx.lineTo(ARENA, y); }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(77,226,255,0.22)';
    ctx.setLineDash([14, 10]);
    ctx.lineDashOffset = -t * 18;
    ctx.strokeRect(2, 2, ARENA - 4, ARENA - 4);
    ctx.setLineDash([]);
    // corner brackets
    ctx.strokeStyle = 'rgba(77,226,255,0.55)';
    ctx.lineWidth = 3;
    var b = 46;
    var corners = [[0, 0, 1, 1], [ARENA, 0, -1, 1], [0, ARENA, 1, -1], [ARENA, ARENA, -1, -1]];
    for (var i = 0; i < 4; i++) {
      var c = corners[i];
      ctx.beginPath();
      ctx.moveTo(c[0] + c[2] * b, c[1]);
      ctx.lineTo(c[0], c[1]);
      ctx.lineTo(c[0], c[1] + c[3] * b);
      ctx.stroke();
    }
    ctx.lineWidth = 1;
  }

  function drawRocks(ctx) {
    for (var i = 0; i < SP.rocks.length; i++) {
      var k = SP.rocks[i];
      if (!onScreen(k.x, k.y, k.r + 40)) continue;
      ctx.save();
      ctx.translate(k.x, k.y);
      ctx.rotate(k.a);
      ctx.beginPath();
      ctx.moveTo(k.pts[0][0], k.pts[0][1]);
      for (var p = 1; p < k.pts.length; p++) ctx.lineTo(k.pts[p][0], k.pts[p][1]);
      ctx.closePath();
      ctx.fillStyle = k.shade > 0.6 ? '#11161f' : '#0c1018';
      ctx.fill();
      ctx.strokeStyle = k.shade > 0.6 ? 'rgba(140,160,185,0.30)' : 'rgba(120,138,160,0.20)';
      ctx.stroke();
      // a lit edge sells the silhouette
      ctx.beginPath();
      ctx.moveTo(k.pts[0][0], k.pts[0][1]);
      ctx.lineTo(k.pts[1][0], k.pts[1][1]);
      ctx.strokeStyle = 'rgba(77,226,255,0.18)';
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawStationBody(ctx, st, t) {
    if (!onScreen(st.x, st.y, 260)) return;
    var pulse = 0.5 + 0.5 * Math.sin(t * 2);
    ctx.save();
    ctx.translate(st.x, st.y);
    // dock ring
    ctx.rotate(st.spin);
    ctx.strokeStyle = 'rgba(77,226,255,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (var i = 0; i < 6; i++) {
      var a0 = i / 6 * TAU, a1 = a0 + 0.55;
      ctx.moveTo(Math.cos(a0) * 52, Math.sin(a0) * 52);
      ctx.arc(0, 0, 52, a0, a1);
    }
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.translate(st.x, st.y);
    ctx.rotate(-st.spin * 0.4);
    ctx.beginPath();
    for (var h = 0; h < 6; h++) {
      var ang = h / 6 * TAU;
      var px = Math.cos(ang) * 30, py = Math.sin(ang) * 30;
      if (h === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = '#0b1420';
    ctx.fill();
    glow(ctx, C.cyan, 14);
    ctx.strokeStyle = 'rgba(77,226,255,0.85)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    noglow(ctx);
    // ember hangar light
    ctx.fillStyle = 'rgba(255,122,69,' + (0.55 + 0.35 * pulse) + ')';
    ctx.fillRect(-9, -2, 18, 4);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(-2, -2, 4, 4);
    ctx.restore();

    // beacon
    ctx.globalAlpha = 0.35 + 0.4 * pulse;
    ctx.fillStyle = C.ember;
    ctx.beginPath(); ctx.arc(st.x, st.y - 58, 2.5, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawGate(ctx, g, t, label) {
    if (!onScreen(g.x, g.y, 160)) return;
    var pulse = 0.5 + 0.5 * Math.sin(t * 3 + g.x * 0.01);
    ctx.save();
    ctx.translate(g.x, g.y);
    for (var i = 0; i < 3; i++) {
      ctx.globalAlpha = 0.22 + 0.2 * pulse;
      ctx.strokeStyle = C.cyan;
      ctx.lineWidth = 1 + i * 0.6;
      ctx.beginPath();
      ctx.arc(0, 0, 26 + i * 9 + pulse * 2, g.spin + i, g.spin + i + 2.1);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(77,226,255,0.5)';
    ctx.setLineDash([3, 5]);
    ctx.beginPath(); ctx.arc(0, 0, 12, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    if (label) {
      ctx.globalAlpha = 0.5;
      txt(ctx, 'JUMP POINT', g.x, g.y + 44, 8, C.cyan, 'center', 700, true);
      ctx.globalAlpha = 1;
    }
  }

  function drawPlayerShip(ctx, p, t) {
    if (p.dead) return;
    var sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.a);
    // engine plume
    if (p.thrust > 0.06) {
      var len = 8 + Math.min(22, sp * 0.035) + Math.random() * 5;
      var col = p.boost > 0.1 ? C.ember : 'rgba(77,226,255,0.9)';
      ctx.beginPath();
      ctx.moveTo(-9, -4.5);
      ctx.lineTo(-9 - len, 0);
      ctx.lineTo(-9, 4.5);
      ctx.closePath();
      ctx.fillStyle = p.boost > 0.1 ? 'rgba(255,122,69,0.65)' : 'rgba(77,226,255,0.4)';
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-9, -2);
      ctx.lineTo(-9 - len * 0.55, 0);
      ctx.lineTo(-9, 2);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
    }
    // hull: the Endless Sky sprite once it has decoded, the authored vector
    // while it is still loading (or if vendor/ is missing entirely)
    var hd = hullDef(p.ship);
    var drew = false;
    if (hd && SPRITES[hd.spr] && SPRITES[hd.spr].ready) {
      var prevSmooth = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = true;
      drew = blitSprite(ctx, hd.spr, hd.len);
      ctx.imageSmoothingEnabled = prevSmooth;
    }
    if (drew) {
      if (p.flash > 0.3) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = p.flash * 0.45;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(0, 0, hd.len * 0.32, 0, TAU); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
    } else {
      ctx.beginPath();
      ctx.moveTo(16, 0);
      ctx.lineTo(-7, -10);
      ctx.lineTo(-2, 0);
      ctx.lineTo(-7, 10);
      ctx.closePath();
      ctx.fillStyle = p.flash > 0.35 ? '#2a3f52' : '#0d1a26';
      ctx.fill();
      glow(ctx, C.cyan, 10);
      ctx.strokeStyle = p.flash > 0.35 ? '#ffffff' : 'rgba(77,226,255,0.95)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      noglow(ctx);
      // wing accents
      ctx.strokeStyle = 'rgba(255,122,69,0.8)';
      ctx.beginPath();
      ctx.moveTo(-4, -6.5); ctx.lineTo(2, -2.5);
      ctx.moveTo(-4, 6.5); ctx.lineTo(2, 2.5);
      ctx.stroke();
      // cockpit
      ctx.fillStyle = C.ember;
      ctx.beginPath(); ctx.arc(3, 0, 2.2, 0, TAU); ctx.fill();
    }
    ctx.restore();

    // deflector bubble: faint when idle, bright ripple on impact
    if (p.shield > 0.5 || p.ripple > 0.02) {
      var a = 0.07 + (p.shield / p.maxShield) * 0.07;
      ctx.strokeStyle = 'rgba(77,226,255,' + a + ')';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, 21, 0, TAU); ctx.stroke();
    }
    if (p.ripple > 0.02) {
      ctx.strokeStyle = 'rgba(77,226,255,' + (p.ripple * 0.85) + ')';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 21 + (1 - p.ripple) * 9, p.rippleA - 0.7, p.rippleA + 0.7);
      ctx.stroke();
    }
  }

  function drawEnemy(ctx, e, t) {
    if (!onScreen(e.x, e.y, 60)) return;
    var k = KIND[e.kind];
    var col = e.flee ? '#9aa7c7' : k.col;
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.rotate(e.a);
    var sp = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
    if (sp > 30) {
      ctx.beginPath();
      ctx.moveTo(-e.r * 0.7, -3);
      ctx.lineTo(-e.r * 0.7 - 6 - Math.min(10, sp * 0.02), 0);
      ctx.lineTo(-e.r * 0.7, 3);
      ctx.closePath();
      ctx.fillStyle = e.flee ? 'rgba(154,167,199,0.35)' : 'rgba(255,122,69,0.35)';
      ctx.fill();
    }
    // pirate hull: ES Fighter/Interceptor sprite, vector as the fallback
    var drew = false;
    if (e.spr && SPRITES[e.spr] && SPRITES[e.spr].ready) {
      var prevSmooth = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = true;
      drew = blitSprite(ctx, e.spr, e.len);
      ctx.imageSmoothingEnabled = prevSmooth;
    }
    if (drew) {
      if (e.hitFlash > 0.2) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = e.hitFlash * 0.4;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(0, 0, e.len * 0.3, 0, TAU); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
    } else {
      ctx.beginPath();
      if (e.kind === 'interceptor') {
        ctx.moveTo(e.r + 4, 0);
        ctx.lineTo(-e.r * 0.8, -e.r * 0.85);
        ctx.lineTo(-e.r * 0.25, 0);
        ctx.lineTo(-e.r * 0.8, e.r * 0.85);
      } else if (e.kind === 'gunship') {
        ctx.moveTo(e.r, -e.r * 0.35);
        ctx.lineTo(e.r * 0.25, -e.r);
        ctx.lineTo(-e.r, -e.r * 0.75);
        ctx.lineTo(-e.r, e.r * 0.75);
        ctx.lineTo(e.r * 0.25, e.r);
        ctx.lineTo(e.r, e.r * 0.35);
      } else {
        ctx.moveTo(e.r + 3, 0);
        ctx.lineTo(-e.r * 0.4, -e.r * 1.05);
        ctx.lineTo(-e.r, -e.r * 0.3);
        ctx.lineTo(-e.r * 0.5, 0);
        ctx.lineTo(-e.r, e.r * 0.3);
        ctx.lineTo(-e.r * 0.4, e.r * 1.05);
      }
      ctx.closePath();
      ctx.fillStyle = e.hitFlash > 0.2 ? 'rgba(255,255,255,0.55)' : 'rgba(18,12,14,0.9)';
      ctx.fill();
      ctx.strokeStyle = e.hitFlash > 0.2 ? '#ffffff' : col;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    ctx.restore();

    if (e.hp < e.maxHp - 0.01) {
      var w = 26;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(e.x - w / 2, e.y - e.r - 10, w, 2.5);
      ctx.fillStyle = col;
      ctx.fillRect(e.x - w / 2, e.y - e.r - 10, w * clamp01(e.hp / e.maxHp), 2.5);
    }
  }

  /* ambient civilian freighters and militia patrols orbiting the station */
  function drawTraffic(ctx, t) {
    if (!SP || !SP.traffic) return;
    for (var i = 0; i < SP.traffic.length; i++) {
      var tr = SP.traffic[i];
      if (!onScreen(tr.x, tr.y, 90)) continue;
      var pulse = 0.45 + 0.55 * Math.sin(t * 3 + i * 1.7);
      ctx.globalAlpha = 0.35 + 0.4 * pulse;
      ctx.fillStyle = tr.civ ? C.cyan : C.gold;
      ctx.beginPath(); ctx.arc(tr.x, tr.y, 1.6, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
      if (drawShipSprite(ctx, tr.spr, tr.x, tr.y, tr.ang, tr.len, 0.92)) continue;
      // no sprite yet: a small vector hull keeps the lane readable
      ctx.save();
      ctx.translate(tr.x, tr.y); ctx.rotate(tr.ang);
      ctx.beginPath();
      ctx.moveTo(tr.len * 0.35, 0);
      ctx.lineTo(-tr.len * 0.3, -tr.len * 0.18);
      ctx.lineTo(-tr.len * 0.16, 0);
      ctx.lineTo(-tr.len * 0.3, tr.len * 0.18);
      ctx.closePath();
      ctx.fillStyle = 'rgba(14,20,34,0.9)';
      ctx.fill();
      ctx.strokeStyle = tr.civ ? 'rgba(77,226,255,0.35)' : 'rgba(255,224,138,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawBullets(ctx, t) {
    for (var i = 0; i < BMAX; i++) {
      var b = bullets[i];
      if (!b.on || !onScreen(b.x, b.y, 60)) continue;
      ctx.strokeStyle = b.color;
      ctx.fillStyle = b.color;
      if (b.kind === 'rail') {
        var len = 46;
        var nx = b.vx / 2000, ny = b.vy / 2000;
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - nx * len * 6, b.y - ny * len * 6);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (b.kind === 'missile') {
        ctx.save();
        ctx.translate(b.x, b.y); ctx.rotate(b.ang);
        ctx.beginPath(); ctx.moveTo(5, 0); ctx.lineTo(-4, -3); ctx.lineTo(-4, 3); ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else if (b.kind === 'flak') {
        ctx.globalAlpha = 0.6 + 0.4 * Math.sin(t * 40);
        ctx.beginPath(); ctx.arc(b.x, b.y, 3.5, 0, TAU); ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        var lx = b.vx * 0.022, ly = b.vy * 0.022;
        ctx.lineWidth = b.own === 'P' ? 1.8 : 1.5;
        ctx.globalAlpha = 0.95;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - lx, b.y - ly);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawParticles(ctx) {
    for (var i = 0; i < PMAX; i++) {
      var p = parts[i];
      if (!p.on || !onScreen(p.x, p.y, 40)) continue;
      var k = p.life / p.max;
      ctx.globalAlpha = Math.min(1, k * 1.4);
      if (p.kind === 'ring') {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size + (1 - k) * p.size * 3.2, 0, TAU);
        ctx.stroke();
      } else if (p.kind === 'shard') {
        ctx.save();
        ctx.translate(p.x, p.y); ctx.rotate(p.a);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size * 0.5, -p.size * 0.3, p.size, p.size * 0.6);
        ctx.restore();
      } else if (p.kind === 'text') {
        ctx.globalAlpha = Math.min(1, k * 1.6);
        txt(ctx, p.txt, p.x, p.y, 10, p.color, 'center', 700, true);
      } else if (p.kind === 'smoke') {
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1.6 - k * 0.6), 0, TAU); ctx.fill();
      } else {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size * 0.55;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.02, p.y - p.vy * 0.02);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawWorld(ctx, t) {
    var W = VIEW.w, H = VIEW.h;
    var sh = cam.shake;
    var ox = sh > 0.2 ? (Math.random() - 0.5) * sh : 0;
    var oy = sh > 0.2 ? (Math.random() - 0.5) * sh : 0;
    ctx.save();
    ctx.translate(Math.round(W * 0.5 - cam.x + ox), Math.round(H * 0.5 - cam.y + oy));
    drawArena(ctx, t);
    drawRocks(ctx);
    if (SP) {
      drawStationBody(ctx, SP.station, t);
      drawGate(ctx, SP.gate, t, true);
      drawTraffic(ctx, t);
      for (var i = 0; i < SP.enemies.length; i++) if (SP.enemies[i].on) drawEnemy(ctx, SP.enemies[i], t);
      drawBullets(ctx, t);
      drawPlayerShip(ctx, G.player, t);
      drawParticles(ctx);
    }
    ctx.restore();
  }

  /* off-screen target chevrons: hostiles and the station stay findable */
  function drawMarkers(ctx, t) {
    var W = VIEW.w, H = VIEW.h;
    var cx = W / 2, cy = H / 2;
    function marker(x, y, col, label) {
      var sx = x - cam.x + cx, sy = y - cam.y + cy;
      if (sx > 24 && sx < W - 24 && sy > 24 && sy < H - 24) return;
      var ang = Math.atan2(sy - cy, sx - cx);
      var rx = Math.min(W * 0.5 - 22, Math.abs(Math.cos(ang)) > 0.001 ? (W * 0.5 - 22) / Math.abs(Math.cos(ang)) : 1e9);
      var ry = Math.min(H * 0.5 - 22, Math.abs(Math.sin(ang)) > 0.001 ? (H * 0.5 - 22) / Math.abs(Math.sin(ang)) : 1e9);
      var r = Math.min(rx, ry);
      var px = cx + Math.cos(ang) * r, py = cy + Math.sin(ang) * r;
      ctx.save();
      ctx.translate(px, py); ctx.rotate(ang);
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, -4); ctx.lineTo(-4, 4); ctx.closePath(); ctx.fill();
      ctx.restore();
      if (label) {
        ctx.globalAlpha = 0.55;
        txt(ctx, label, px - Math.cos(ang) * 14, py - Math.sin(ang) * 14, 7.5, col, 'center', 700, true);
      }
      ctx.globalAlpha = 1;
    }
    for (var i = 0; i < SP.enemies.length; i++) {
      var e = SP.enemies[i];
      if (e.on) marker(e.x, e.y, KIND[e.kind].col, null);
    }
    marker(SP.station.x, SP.station.y, C.cyan, 'STATION');
  }

  /* ------------------------------------------------------------------ */
  /* HUD                                                                 */
  /* ------------------------------------------------------------------ */
  function drawHUD(ctx, t) {
    var W = VIEW.w, H = VIEW.h;
    var p = G.player, sys = G.gal.systems[G.cur];
    var fcol = FAC_COL[sys.faction];

    // --- system identity
    txt(ctx, sys.name.toUpperCase(), 14, 16, 12, C.ink, 'left', 700);
    var nw = ctx.measureText(sys.name.toUpperCase()).width;
    ctx.fillStyle = fcol;
    ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.arc(20 + nw, 16, 3, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
    txt(ctx, FAC_NAME[sys.faction] + ' · TECH ' + sys.tech, 28 + nw, 16, 8, C.mid, 'left', 600, true);

    // --- hull / shield / energy
    var bx = 14, by = 28, bw = 104;
    txt(ctx, 'HULL', bx, by + 3, 7, C.mid, 'left', 700, true);
    bar(ctx, bx + 30, by, bw, 5, p.hull / p.maxHull, p.hull / p.maxHull < 0.3 ? C.bad : C.ember);
    txt(ctx, 'SHLD', bx, by + 12, 7, C.mid, 'left', 700, true);
    bar(ctx, bx + 30, by + 9, bw, 5, p.shield / p.maxShield, C.cyan);
    txt(ctx, 'PWR', bx, by + 21, 7, C.mid, 'left', 700, true);
    bar(ctx, bx + 30, by + 18, bw * 0.72, 3, p.energy / p.maxEnergy, p.energy < 20 ? C.bad : C.good);
    txt(ctx, hullDef(p.ship).name, bx + 30 + bw * 0.72 + 8, by + 21, 7, C.dim, 'left', 700, true);

    // --- credits / cargo / fuel
    txt(ctx, money(G.credits) + ' CR', W - 14, 15, 12, C.gold, 'right', 700, true);
    var cargo = cargoCount();
    txt(ctx, 'HOLD ' + cargo + '/' + p.hold + '   FUEL ' + Math.floor(G.fuel) + '/24', W - 14, 29, 8, C.mid, 'right', 600, true);

    button(ctx, 'MAP', W - 60, 38, 46, 18, openMap, { size: 8.5 });
    button(ctx, 'II', W - 112, 38, 44, 18, togglePause, { size: 8.5, bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.16)', fg: C.mid });

    // --- weapon chips: own row under the status bars, so long system names
    //     in the identity line can never be overprinted by the chips
    var cwid = 42, gap = 4;
    var total = WEAPONS.length * cwid + (WEAPONS.length - 1) * gap;
    var wx = 14;
    for (var i = 0; i < WEAPONS.length; i++) {
      (function (ix) {
        chip(ctx, WEAPONS[ix].name, wx + ix * (cwid + gap), 56, cwid, 17, p.wep === ix, function () {
          G.player.wep = ix; G.player.charge = 0; G.player.cool = 0.12; GK.sfx.hit();
        });
      })(i);
    }
    if (WEAPONS[p.wep].kind === 'rail' && p.charging) {
      bar(ctx, wx, 75, total, 2.5, p.charge, p.charge >= 1 ? C.ink : C.ember);
    }

    // --- active contract
    if (G.active.length) {
      var m = G.active[0];
      var line = m.type === 'courier' ? ('HAUL ' + m.qty + 'x ' + COMM[m.comm].short + ' → ' + G.gal.systems[m.to].name.toUpperCase())
        : m.type === 'bounty' ? ('BOUNTY  ' + m.prog + '/' + m.need + ' KILLS')
          : ('SURVEY  ' + G.gal.systems[m.to].name.toUpperCase());
      txt(ctx, 'CONTRACT', 14, 88, 7.5, C.cyanDim, 'left', 700, true);
      txt(ctx, line, 14, 99, 8.5, C.ink, 'left', 600, true);
      if (G.active.length > 1) txt(ctx, '+' + (G.active.length - 1) + ' MORE', 14, 110, 7.5, C.dim, 'left', 600, true);
    }

    // --- dock prompt
    var near = stationInRange();
    if (near) {
      ctx.globalAlpha = 0.6 + 0.4 * Math.sin(t * 6);
      txt(ctx, 'DOCKING RANGE — TAP DOCK', W * 0.5, H - 92, 9, C.ember, 'center', 700, true);
      ctx.globalAlpha = 1;
    }

    // --- toast (top centre, clear of both thumbs)
    if (G.toast) {
      var a = Math.min(1, G.toastT / 0.5);
      ctx.globalAlpha = a;
      ctx.font = '700 9px ' + MONO;
      var tw = Math.min(W - 120, ctx.measureText(G.toast).width + 22);
      panel(ctx, W * 0.5 - tw / 2, 34, tw, 19, 0.85);
      txt(ctx, G.toast, W * 0.5, 43.5, 9, C.ink, 'center', 700, true);
      ctx.globalAlpha = 1;
    }

    // --- low hull vignette
    if (p.hull / p.maxHull < 0.3) {
      var vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.62);
      vg.addColorStop(0, 'rgba(255,60,80,0)');
      vg.addColorStop(1, 'rgba(255,50,70,' + (0.22 + 0.12 * Math.sin(t * 5)) + ')');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);
    }
  }

  /* ------------------------------------------------------------------ */
  /* galaxy map                                                          */
  /* ------------------------------------------------------------------ */
  function sysKnown(id) {
    if (G.visited[id]) return true;
    for (var k in G.disc) {
      var p = k.split('-');
      if (+p[0] === id || +p[1] === id) return true;
    }
    return false;
  }

  var MPOS = [];
  function mapPositions(gx, gy, gw, gh) {
    for (var i = 0; i < G.gal.n; i++) {
      if (!MPOS[i]) MPOS[i] = { x: 0, y: 0 };
      var s = G.gal.systems[i];
      MPOS[i].x = gx + 26 + s.x * (gw - 52);
      MPOS[i].y = gy + 26 + s.y * (gh - 52);
    }
    return MPOS;
  }

  function drawMap(ctx, t) {
    var W = VIEW.w, H = VIEW.h;
    ctx.fillStyle = '#04060c';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(77,226,255,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var gx2 = 0; gx2 < W; gx2 += 34) { ctx.moveTo(gx2, 0); ctx.lineTo(gx2, H); }
    for (var gy2 = 0; gy2 < H; gy2 += 34) { ctx.moveTo(0, gy2); ctx.lineTo(W, gy2); }
    ctx.stroke();

    txt(ctx, 'GALAXY MAP', 16, 20, 13, C.ink, 'left', 700);
    txt(ctx, 'FUEL ' + Math.floor(G.fuel) + '/24   ·   ' + money(G.credits) + ' CR', W - 58, 20, 8.5, C.mid, 'right', 600, true);
    button(ctx, 'X', W - 40, 8, 28, 24, closeMap, { size: 11 });

    var gx = 14, gy = 44, gw = Math.min(W * 0.58, 470), gh = H - 92;
    var ix = gx + gw + 12, iw = W - ix - 14;
    panel(ctx, gx, gy, gw, gh, 0.55);

    var pos = mapPositions(gx, gy, gw, gh);

    // lanes: charted ones read bright, uncharted ones are a rumour
    for (var l = 0; l < G.gal.links.length; l++) {
      var lk = G.gal.links[l], a = lk[0], b = lk[1];
      var known = G.disc[laneKey(a, b)];
      if (!known && !(sysKnown(a) && sysKnown(b))) continue;
      ctx.strokeStyle = known ? 'rgba(77,226,255,0.45)' : 'rgba(150,170,200,0.12)';
      ctx.lineWidth = known ? 1.3 : 1;
      if (!known) ctx.setLineDash([2, 5]);
      ctx.beginPath();
      ctx.moveTo(pos[a].x, pos[a].y);
      ctx.lineTo(pos[b].x, pos[b].y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (var i = 0; i < G.gal.n; i++) {
      var s = G.gal.systems[i], px = pos[i].x, py = pos[i].y;
      var known2 = sysKnown(i);
      var col = FAC_COL[s.faction];
      var isCur = i === G.cur, isSel = i === G.selSys;
      if (!known2) {
        ctx.fillStyle = 'rgba(160,180,205,0.22)';
        ctx.beginPath(); ctx.arc(px, py, 2.4, 0, TAU); ctx.fill();
        continue;
      }
      if (isCur) {
        ctx.strokeStyle = 'rgba(77,226,255,' + (0.35 + 0.3 * Math.sin(t * 3)) + ')';
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(px, py, 12 + Math.sin(t * 3) * 1.5, 0, TAU); ctx.stroke();
      }
      if (isSel) {
        ctx.strokeStyle = C.ember;
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(px, py, 9, 0, TAU); ctx.stroke();
      }
      ctx.fillStyle = G.visited[i] ? col : '#0a121c';
      ctx.beginPath(); ctx.arc(px, py, 5, 0, TAU); ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      if (G.scanned[i]) {
        ctx.fillStyle = 'rgba(125,255,178,0.9)';
        ctx.fillRect(px + 6, py - 9, 3, 3);
      }
      txt(ctx, s.name.toUpperCase(), px + 9, py - 7, 7.5, isCur ? C.ink : C.mid, 'left', 700, true);
      // tap target, generous for thumbs
      (function (idx) {
        hit(px - 15, py - 15, 30, 30, function () { G.selSys = idx; GK.sfx.hit(); });
      })(i);
    }

    // --- info card
    var sel = G.gal.systems[G.selSys];
    panel(ctx, ix, gy, iw, gh);
    var ky = gy + 20;
    if (!sysKnown(G.selSys)) {
      txt(ctx, 'UNCHARTED', ix + 12, ky, 11, C.mid, 'left', 700);
      txt(ctx, 'Chart a lane here to see', ix + 12, ky + 22, 8, C.dim, 'left', 600, true);
      txt(ctx, 'its market and contracts.', ix + 12, ky + 34, 8, C.dim, 'left', 600, true);
      button(ctx, 'DEEP SCAN', ix + 12, gy + gh - 42, iw - 24, 30, deepScan, { size: 9 });
      return;
    }
    txt(ctx, sel.name.toUpperCase(), ix + 12, ky, 11.5, C.ink, 'left', 700);
    txt(ctx, FAC_NAME[sel.faction] + ' · TECH ' + sel.tech, ix + 12, ky + 16, 8, FAC_COL[sel.faction], 'left', 700, true);
    var rep = Math.round(G.rep[sel.faction]);
    txt(ctx, 'REP ' + (rep > 0 ? '+' : '') + rep, ix + 12, ky + 28, 8, rep >= 0 ? C.good : C.bad, 'left', 700, true);
    if (G.visited[G.selSys]) txt(ctx, 'VISITED', ix + iw - 12, ky + 16, 7.5, C.dim, 'right', 700, true);

    ctx.strokeStyle = 'rgba(77,226,255,0.14)';
    ctx.beginPath(); ctx.moveTo(ix + 12, ky + 40); ctx.lineTo(ix + iw - 12, ky + 40); ctx.stroke();

    // best local prices, coloured against the system you are sitting in
    var here = G.gal.systems[G.cur];
    var py2 = ky + 54;
    txt(ctx, 'LOCAL MARKET', ix + 12, py2, 7, C.cyanDim, 'left', 700, true);
    py2 += 14;
    for (var c2 = Math.max(0, COMM.length - 5); c2 < COMM.length; c2++) {
      var pSel = priceOf(sel, c2, 'buy'), pHere = priceOf(here, c2, 'buy');
      var better = pSel < pHere;
      txt(ctx, COMM[c2].short, ix + 12, py2, 8.5, C.mid, 'left', 600, true);
      txt(ctx, String(pSel), ix + iw - 14, py2, 9, better ? C.good : C.ink, 'right', 700, true);
      py2 += 15;
    }

    var offers = (G.boards && G.boards[G.selSys]) ? G.boards[G.selSys].length : boardFor(G.selSys).length;
    txt(ctx, offers + ' CONTRACT' + (offers === 1 ? '' : 'S') + ' ON THE BOARD', ix + 12, py2 + 6, 7.5, C.dim, 'left', 600, true);

    // --- jump control
    var isHere = G.selSys === G.cur;
    var linked = !isHere && laneKnown(G.cur, G.selSys);
    var cost = isHere ? 0 : jumpCost(G.cur, G.selSys);
    var jy = gy + gh - 70;
    if (isHere) {
      button(ctx, 'DEEP SCAN · 1 FUEL', ix + 12, jy, iw - 24, 30, deepScan, { size: 8.5, disabled: !!G.scanned[G.cur] });
    } else if (linked) {
      button(ctx, 'JUMP · ' + cost + ' FUEL', ix + 12, jy, iw - 24, 30, function () { jumpTo(G.selSys); }, {
        bg: 'rgba(255,122,69,0.16)', border: 'rgba(255,122,69,0.65)', fg: C.ember, size: 10,
        disabled: G.fuel < cost
      });
    } else {
      button(ctx, 'NO LANE CHARTED', ix + 12, jy, iw - 24, 30, null, { size: 8.5, disabled: true });
    }
    button(ctx, isHere ? 'STAY IN SYSTEM' : 'BACK TO FLIGHT', ix + 12, jy + 36, iw - 24, 24, closeMap, { size: 8.5 });

    // legend
    txt(ctx, '● VOID   ● CORE   ● FRONTIER   ● PIRATE', 16, H - 20, 7, C.dim, 'left', 600, true);
  }

  /* ------------------------------------------------------------------ */
  /* station: market / contracts / outfitting                            */
  /* ------------------------------------------------------------------ */
  function qtyChoice() { return [1, 5, 10, 999][G.qtyIdx || 0]; }

  function drawStation(ctx, t) {
    var W = VIEW.w, H = VIEW.h;
    ctx.fillStyle = '#04060c';
    ctx.fillRect(0, 0, W, H);
    var cw = Math.min(W, 880), ox = (W - cw) / 2;
    var sys = G.gal.systems[G.cur];

    // header
    ctx.fillStyle = 'rgba(77,226,255,0.9)';
    ctx.fillRect(ox + 10, 10, 3, 26);
    txt(ctx, sys.name.toUpperCase() + '  STATION', ox + 20, 15, 12.5, C.ink, 'left', 700);
    txt(ctx, FAC_NAME[sys.faction] + ' · TECH ' + sys.tech + ' · REP ' + (Math.round(G.rep[sys.faction]) > 0 ? '+' : '') + Math.round(G.rep[sys.faction]) + ' · WELCOME', ox + 20, 30, 7.5, FAC_COL[sys.faction], 'left', 700, true);
    txt(ctx, money(G.credits) + ' CR', ox + cw - 16, 15, 12, C.gold, 'right', 700, true);
    txt(ctx, 'HOLD ' + cargoCount() + '/' + G.player.hold + '   FUEL ' + Math.floor(G.fuel) + '/24   HULL ' + Math.round(G.player.hull) + '/' + G.player.maxHull, ox + cw - 16, 30, 7.5, C.mid, 'right', 600, true);

    // tabs — widths come from the row budget so OUTFIT can never run into MAP
    var tabs = [['market', 'MARKET'], ['missions', 'JOBS'], ['outfit', 'OUTFIT'], ['yard', 'YARD']];
    var undockW = 82, mapW = 50, tgap = 6;
    var tabBudget = cw - 28 - mapW - undockW - tgap * 5;
    var tabW = clamp(Math.floor(tabBudget / tabs.length), 40, 78);
    var tx = ox + 14;
    for (var i = 0; i < tabs.length; i++) {
      (function (key, label) {
        var on = G.stationTab === key;
        hit(tx, 44, tabW, 22, function () { G.stationTab = key; GK.sfx.hit(); });
        rrect(ctx, tx, 44, tabW, 22, 4);
        ctx.fillStyle = on ? 'rgba(77,226,255,0.15)' : 'rgba(255,255,255,0.03)';
        ctx.fill();
        ctx.strokeStyle = on ? 'rgba(77,226,255,0.7)' : 'rgba(255,255,255,0.08)';
        ctx.stroke();
        txt(ctx, label, tx + tabW / 2, 55.5, 8.5, on ? C.ink : C.mid, 'center', 700, true);
        tx += tabW + tgap;
      })(tabs[i][0], tabs[i][1]);
    }
    var mapX = ox + cw - 14 - undockW - tgap - mapW;
    button(ctx, 'MAP', mapX, 44, mapW, 22, openMap, { size: 8.5, bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.16)', fg: C.mid });
    button(ctx, 'UNDOCK', ox + cw - 14 - undockW, 44, undockW, 22, undock, { size: 8.5, bg: 'rgba(255,122,69,0.12)', border: 'rgba(255,122,69,0.55)', fg: C.ember });

    var cy = 72, ch = H - cy - 36;
    rrect(ctx, ox + 10, cy, cw - 20, ch, 5);
    ctx.fillStyle = 'rgba(9,13,23,0.75)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(77,226,255,0.12)';
    ctx.stroke();

    if (G.stationTab === 'market') drawMarket(ctx, ox, cw, cy, ch);
    else if (G.stationTab === 'missions') drawContracts(ctx, ox, cw, cy, ch);
    else if (G.stationTab === 'yard') drawShipyard(ctx, ox, cw, cy, ch);
    else drawOutfit(ctx, ox, cw, cy, ch);

    // footer
    var fy = H - 30;
    txt(ctx, 'QTY', ox + 16, fy + 10, 7.5, C.dim, 'left', 700, true);
    var qs = ['1', '5', '10', 'MAX'];
    for (var q = 0; q < 4; q++) {
      (function (ix) {
        chip(ctx, qs[ix], ox + 44 + ix * 40, fy, 36, 20, (G.qtyIdx || 0) === ix, function () { G.qtyIdx = ix; GK.sfx.hit(); });
      })(q);
    }
    if (G.toast) {
      ctx.globalAlpha = Math.min(1, G.toastT / 0.4);
      txt(ctx, G.toast, ox + cw - 16, fy + 10, 8.5, C.ink, 'right', 700, true);
      ctx.globalAlpha = 1;
    } else {
      txt(ctx, 'TAP BUY / SELL — PRICES MOVE AS YOU TRADE', ox + cw - 16, fy + 10, 7, C.dim, 'right', 600, true);
    }
  }

  function drawMarket(ctx, ox, cw, cy, ch) {
    var x0 = ox + 22, y0 = cy + 6;
    txt(ctx, 'COMMODITY', x0, y0 + 8, 7, C.cyanDim, 'left', 700, true);
    txt(ctx, 'STOCK', ox + cw * 0.22, y0 + 8, 7, C.cyanDim, 'left', 700, true);
    txt(ctx, 'BUY', ox + cw * 0.46, y0 + 8, 7, C.cyanDim, 'right', 700, true);
    txt(ctx, 'SELL', ox + cw * 0.60, y0 + 8, 7, C.cyanDim, 'right', 700, true);
    var sys = G.gal.systems[G.cur];
    // ten real commodities: squeeze the row height when the screen is short
    var rh = clamp((ch - 24) / COMM.length, 17, 26);
    var bh = Math.min(20, rh - 2);
    var fs = rh >= 21 ? 9.5 : 8.5;
    for (var i = 0; i < COMM.length; i++) (function (ci) {
      var ry = y0 + 18 + ci * rh, mid = ry + rh * 0.5;
      if (ci % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.022)';
        ctx.fillRect(x0 - 6, ry, cw - 32, rh - 1);
      }
      var have = G.cargo[COMM[ci].id] || 0;
      txt(ctx, COMM[ci].name, x0, mid, fs, C.ink, 'left', 600);
      var sp = stockPct(sys, ci);
      bar(ctx, ox + cw * 0.22, mid - 2, 44, 4, sp, sp < 0.2 ? C.ember : C.cyanDim);
      txt(ctx, String(Math.round(sys.market[ci].stock)), ox + cw * 0.22 + 50, mid, 8, C.mid, 'left', 600, true);
      var bp = priceOf(sys, ci, 'buy'), sp2 = priceOf(sys, ci, 'sell');
      txt(ctx, String(bp), ox + cw * 0.46, mid, 10, C.cyan, 'right', 700, true);
      txt(ctx, String(sp2), ox + cw * 0.60, mid, 10, C.good, 'right', 700, true);
      button(ctx, 'BUY', ox + cw * 0.62, mid - bh * 0.5, 50, bh, function () { buyCommodity(ci, qtyChoice()); }, { size: 8.5, disabled: cargoFree() <= 0 || G.credits < bp });
      button(ctx, 'SELL', ox + cw * 0.62 + 56, mid - bh * 0.5, 50, bh, function () { sellCommodity(ci, qtyChoice()); }, { size: 8.5, bg: 'rgba(125,255,178,0.08)', border: 'rgba(125,255,178,0.4)', fg: C.good, disabled: have <= 0 });
      txt(ctx, have > 0 ? 'x' + have : '—', ox + cw - 22, mid, 8.5, have > 0 ? C.gold : C.dim, 'right', 700, true);
    })(i);
  }

  function drawContracts(ctx, ox, cw, cy, ch) {
    var x0 = ox + 22, y = cy + 6;
    var board = boardFor(G.cur);
    if (G.active.length) {
      txt(ctx, 'ACTIVE  ' + G.active.length + '/3', x0, y + 6, 7, C.cyanDim, 'left', 700, true);
      y += 12;
      for (var a = 0; a < G.active.length; a++) (function (m) {
        ctx.fillStyle = 'rgba(77,226,255,0.055)';
        ctx.fillRect(x0 - 6, y, cw - 32, 23);
        var dest = G.gal.systems[m.to] ? G.gal.systems[m.to].name.toUpperCase() : 'ANY';
        var prog = m.type === 'bounty' ? (m.prog + '/' + m.need + ' KILLS') : ('→ ' + dest);
        txt(ctx, m.title, x0, y + 8, 8, C.ink, 'left', 700, true);
        txt(ctx, prog + '  ·  ' + money(m.reward) + ' CR', x0, y + 17.5, 6.5, C.mid, 'left', 600, true);
        button(ctx, 'DROP', ox + cw - 70, y + 3, 50, 17, function () { abandonMission(m); }, { size: 7, bg: 'rgba(255,90,110,0.08)', border: 'rgba(255,90,110,0.35)', fg: C.bad });
        y += 23;
      })(G.active[a]);
      y += 4;
    }
    txt(ctx, 'AVAILABLE CONTRACTS', x0, y + 6, 7, C.cyanDim, 'left', 700, true);
    y += 12;
    if (!board.length) {
      txt(ctx, 'No work on the board right now.', x0, y + 10, 8.5, C.dim, 'left', 600, true);
      return;
    }
    for (var i = 0; i < board.length; i++) (function (m) {
      var ry = y + i * 44;
      if (ry + 42 > cy + ch - 2) return;
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(x0 - 6, ry, cw - 32, 40);
      ctx.fillStyle = FAC_COL[m.giver];
      ctx.fillRect(x0 - 6, ry, 2, 40);
      var icon = m.type === 'courier' ? 'HAUL' : m.type === 'bounty' ? 'BOUNTY' : 'SURVEY';
      txt(ctx, icon, x0, ry + 10, 7, FAC_COL[m.giver], 'left', 700, true);
      txt(ctx, m.title, x0, ry + 21, 8.5, C.ink, 'left', 700, true);
      txt(ctx, m.sub, x0, ry + 32, 6.5, C.mid, 'left', 600, true);
      txt(ctx, money(m.reward) + ' CR', ox + cw - 90, ry + 18, 10, C.gold, 'right', 700, true);
      button(ctx, 'ACCEPT', ox + cw - 78, ry + 10, 56, 19, function () { acceptMission(m); }, { size: 8 });
    })(board[i]);
  }

  function drawOutfit(ctx, ox, cw, cy, ch) {
    var x0 = ox + 22, y = cy + 8;
    txt(ctx, 'SHIP SYSTEMS', x0, y + 6, 7, C.cyanDim, 'left', 700, true);
    y += 14;
    for (var i = 0; i < UPG.length; i++) (function (u) {
      var ry = y + i * 28;
      var lvl = G.upgrades[u.key], maxed = lvl >= u.max;
      var cost = maxed ? 0 : u.cost[lvl];
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      ctx.fillRect(x0 - 6, ry, cw - 32, 27);
      txt(ctx, u.name, x0, ry + 10, 8.5, C.ink, 'left', 700, true);
      txt(ctx, u.desc, x0, ry + 20, 7, C.mid, 'left', 600, true);
      // level pips
      for (var p = 0; p < u.max; p++) {
        ctx.fillStyle = p < lvl ? C.cyan : 'rgba(255,255,255,0.10)';
        ctx.fillRect(ox + cw * 0.52 + p * 10, ry + 11, 6, 6);
      }
      if (maxed) button(ctx, 'MAX', ox + cw - 76, ry + 4, 54, 20, null, { size: 8, disabled: true });
      else button(ctx, money(cost) + ' CR', ox + cw - 96, ry + 4, 74, 20, function () { buyUpgrade(u.key); }, { size: 7.5, disabled: G.credits < cost });
    })(UPG[i]);
    y += UPG.length * 28 + 4;
    txt(ctx, 'DOCK SERVICES', x0, y + 6, 7, C.cyanDim, 'left', 700, true);
    y += 14;
    var p = G.player;
    var repairNeed = Math.ceil(p.maxHull - p.hull), repairCost = repairNeed * 3;
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    ctx.fillRect(x0 - 6, y, cw - 32, 27);
    txt(ctx, 'HULL REPAIR', x0, y + 10, 8.5, C.ink, 'left', 700, true);
    txt(ctx, repairNeed > 0 ? (repairNeed + ' integrity points') : 'hull at full strength', x0, y + 20, 7, C.mid, 'left', 600, true);
    button(ctx, repairNeed > 0 ? money(repairCost) + ' CR' : 'FULL', ox + cw - 96, y + 4, 74, 20, repairHull, { size: 7.5, disabled: repairNeed <= 0 || G.credits < repairCost });
    y += 30;
    var fuelNeed = Math.max(0, Math.ceil(24 - G.fuel)), fuelCost = fuelNeed * 11;
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    ctx.fillRect(x0 - 6, y, cw - 32, 27);
    txt(ctx, 'REFUEL', x0, y + 10, 8.5, C.ink, 'left', 700, true);
    txt(ctx, fuelNeed > 0 ? (fuelNeed + ' units of jump fuel') : 'tanks full', x0, y + 20, 7, C.mid, 'left', 600, true);
    button(ctx, fuelNeed > 0 ? money(fuelCost) + ' CR' : 'FULL', ox + cw - 96, y + 4, 74, 20, refuel, { size: 7.5, disabled: fuelNeed <= 0 || G.credits < fuelCost });
    y += 34;
    txt(ctx, 'WEAPONS: ' + WEAPONS[0].name + ' · ' + WEAPONS[1].name + ' · ' + WEAPONS[2].name + ' · ' + WEAPONS[3].name, x0, y + 4, 7, C.dim, 'left', 600, true);
  }

  /* shipyard: the vendored ES hulls, bought with the same button pattern
   * as the outfit list. Stats are the hull's real ES-derived numbers. */
  function drawShipyard(ctx, ox, cw, cy, ch) {
    var x0 = ox + 22, y = cy + 6;
    var cur = hullDef(G.player.ship);
    txt(ctx, 'SHIPYARD · ENDLESS SKY HULLS', x0, y + 6, 7, C.cyanDim, 'left', 700, true);
    txt(ctx, 'FLYING ' + cur.name + ' · TRADE-IN 40%', ox + cw - 22, y + 6, 7, C.gold, 'right', 700, true);
    y += 16;
    var rh = clamp((ch - 28) / HULLS.length, 30, 52);
    for (var i = 0; i < HULLS.length; i++) (function (h) {
      var ry = y + i * rh;
      var owned = G.player.ship === h.key;
      ctx.fillStyle = owned ? 'rgba(77,226,255,0.08)' : 'rgba(255,255,255,0.025)';
      ctx.fillRect(x0 - 6, ry, cw - 32, rh - 3);
      if (owned) {
        ctx.fillStyle = C.cyan;
        ctx.fillRect(x0 - 6, ry, 2, rh - 3);
      }
      // thumbnail: the same sprite the hull flies with, nose up
      if (!drawShipSprite(ctx, h.spr, x0 + 15, ry + (rh - 3) * 0.5, -Math.PI * 0.5, Math.min(30, rh - 8), owned ? 1 : 0.85)) {
        ctx.strokeStyle = owned ? C.cyan : C.cyanDim;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0 + 22, ry + rh * 0.5);
        ctx.lineTo(x0 + 8, ry + rh * 0.5 - 7);
        ctx.lineTo(x0 + 11, ry + rh * 0.5);
        ctx.lineTo(x0 + 8, ry + rh * 0.5 + 7);
        ctx.closePath();
        ctx.stroke();
      }
      txt(ctx, h.name + ' · ' + h.role, x0 + 34, ry + rh * 0.3, 8.5, C.ink, 'left', 700, true);
      txt(ctx, 'HULL ' + h.hull + ' · SHD ' + h.shield + ' · CGO ' + h.cargo + ' · THR ' + h.accel + ' · T ' + h.turn.toFixed(1),
        x0 + 34, ry + rh * 0.66, 7, C.mid, 'left', 600, true);
      if (owned) {
        button(ctx, 'FLYING', ox + cw - 94, ry + (rh - 3) * 0.5 - 10, 68, 20, null, { size: 7.5, disabled: true });
      } else {
        var cost = Math.max(0, h.price - tradeInValue(G.player.ship));
        button(ctx, money(cost) + ' CR', ox + cw - 102, ry + (rh - 3) * 0.5 - 10, 76, 20,
          function () { buyShip(h.key); }, { size: 7.5, disabled: G.credits < cost });
      }
    })(HULLS[i]);
  }

  /* ------------------------------------------------------------------ */
  /* title / pause / game over                                           */
  /* ------------------------------------------------------------------ */
  var titleT = 0;

  function drawTitle(ctx, t) {
    var W = VIEW.w, H = VIEW.h;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    // slow drifting starfield, independent of the run camera
    for (var i = 0; i < STARS.length; i++) {
      var st = STARS[i];
      var sx = mod(st.x * W + t * 4 * st.p, W + 40) - 20;
      var sy = mod(st.y * H + t * 1.6 * st.p, H + 40) - 20;
      ctx.globalAlpha = st.a * (0.6 + 0.4 * Math.sin(t * 1.4 + st.tw));
      ctx.fillStyle = i % 13 === 0 ? '#ffd7c2' : '#cfe6ff';
      ctx.fillRect(sx, sy, st.r, st.r);
    }
    ctx.globalAlpha = 1;

    // limb of a planet
    var pr = Math.max(W, H) * 0.8;
    var grd = ctx.createRadialGradient(W * 0.82, H * 1.25, pr * 0.4, W * 0.82, H * 1.25, pr);
    grd.addColorStop(0, '#0b1c2a');
    grd.addColorStop(0.55, '#081019');
    grd.addColorStop(1, 'rgba(6,8,15,0)');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(W * 0.82, H * 1.25, pr, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(77,226,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(W * 0.82, H * 1.25, pr * 0.985, Math.PI * 1.12, Math.PI * 1.68); ctx.stroke();

    var cx = W * 0.5;
    var big = clamp(W * 0.088, 26, 58);
    ctx.textAlign = 'center';
    glow(ctx, 'rgba(77,226,255,0.55)', 26);
    txt(ctx, 'EMBER', cx, H * 0.26, big, '#e9fbff', 'center', 800);
    noglow(ctx);
    glow(ctx, 'rgba(255,122,69,0.5)', 24);
    txt(ctx, 'DRIFT', cx, H * 0.26 + big * 1.02, big, C.ember, 'center', 800);
    noglow(ctx);
    txt(ctx, 'TRADE · FIGHT · DRIFT', cx, H * 0.26 + big * 1.9, 9.5, C.mid, 'center', 700, true);

    // three lines of how to play, tap-first
    var howY = H * 0.26 + big * 1.9 + Math.max(26, H * 0.035);
    var how = [
      'STICK TO THRUST + TURN   ·   FIRE TO SHOOT',
      'DOCK AT A STATION TO TRADE, REPAIR AND REFUEL',
      'TAKE CONTRACTS · JUMP SYSTEMS · SURVIVE THE DRIFT'
    ];
    for (var hi = 0; hi < how.length; hi++) {
      txt(ctx, how[hi], cx, howY + hi * 14, 8, hi === 0 ? C.mid : C.dim, 'center', 600, true);
    }

    // little ship on approach — a real ES hull when the bundle is loaded
    var tx0 = cx + Math.sin(t * 0.6) * 18, ty0 = H * 0.66 + Math.cos(t * 0.5) * 6;
    var ta = -Math.PI * 0.5 + Math.sin(t * 0.5) * 0.12;
    if (!drawShipSprite(ctx, 'shuttle', tx0, ty0, ta, 40)) {
      ctx.save();
      ctx.translate(tx0, ty0);
      ctx.rotate(Math.PI * 0.5 + Math.sin(t * 0.5) * 0.12);
      ctx.beginPath();
      ctx.moveTo(14, 0); ctx.lineTo(-6, -8); ctx.lineTo(-2, 0); ctx.lineTo(-6, 8);
      ctx.closePath();
      ctx.fillStyle = '#0d1a26';
      ctx.fill();
      glow(ctx, C.cyan, 12);
      ctx.strokeStyle = 'rgba(77,226,255,0.9)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      noglow(ctx);
      ctx.fillStyle = C.ember;
      ctx.beginPath(); ctx.arc(3, 0, 2, 0, TAU); ctx.fill();
      ctx.restore();
    }

    var by = H * 0.78;
    if (hasSave()) {
      button(ctx, 'CONTINUE', cx - 84, by, 168, 34, continueGame, { size: 11, bg: 'rgba(77,226,255,0.16)', border: 'rgba(77,226,255,0.75)', fg: C.ink });
      button(ctx, 'NEW RUN', cx - 84, by + 42, 168, 28, startNewGame, { size: 9, bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.16)', fg: C.mid });
    } else {
      button(ctx, 'START DRIFT', cx - 90, by, 180, 38, startNewGame, { size: 11.5, bg: 'rgba(77,226,255,0.16)', border: 'rgba(77,226,255,0.75)', fg: C.ink });
    }
    txt(ctx, 'Ships and market data: Endless Sky contributors (GPL-3.0)', cx, H - 29, 7, C.dim, 'center', 600, true);
    txt(ctx, 'OFFLINE · NO ACCOUNTS · SAVES ON THIS DEVICE', cx, H - 16, 7.5, C.dim, 'center', 600, true);
  }

  function drawPause(ctx) {
    var W = VIEW.w, H = VIEW.h;
    ctx.fillStyle = 'rgba(4,6,12,0.78)';
    ctx.fillRect(0, 0, W, H);
    var pw = Math.min(280, W - 40), px = (W - pw) / 2, py = H * 0.5 - 92;
    panel(ctx, px, py, pw, 184);
    txt(ctx, 'PAUSED', W / 2, py + 22, 14, C.ink, 'center', 700);
    txt(ctx, G.gal.systems[G.cur].name.toUpperCase() + ' · ' + GK.fmtTime(G.time), W / 2, py + 38, 8, C.mid, 'center', 600, true);
    button(ctx, 'RESUME', px + 16, py + 52, pw - 32, 28, togglePause, { size: 10 });
    button(ctx, 'GALAXY MAP', px + 16, py + 84, pw - 32, 24, function () { togglePause(); openMap(); }, { size: 9 });
    button(ctx, 'SOUND: ' + (GK.sfx.enabled ? 'ON' : 'OFF'), px + 16, py + 112, pw - 32, 24, function () { GK.sfx.enabled = !GK.sfx.enabled; if (GK.sfx.enabled) GK.sfx.coin(); }, { size: 9, bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.16)', fg: C.mid });
    button(ctx, 'SAVE + QUIT', px + 16, py + 140, pw - 32, 24, quitToTitle, { size: 9, bg: 'rgba(255,90,110,0.08)', border: 'rgba(255,90,110,0.35)', fg: C.bad });
  }

  function drawDead(ctx) {
    var W = VIEW.w, H = VIEW.h;
    ctx.fillStyle = 'rgba(20,4,8,0.62)';
    ctx.fillRect(0, 0, W, H);
    var pw = Math.min(300, W - 40), px = (W - pw) / 2, py = H * 0.5 - 96;
    panel(ctx, px, py, pw, 192);
    ctx.fillStyle = C.ember;
    ctx.fillRect(px, py, pw, 2);
    txt(ctx, 'SHIP DESTROYED', W / 2, py + 26, 14, C.ember, 'center', 800);
    txt(ctx, 'Escape pod recovered by ' + G.gal.systems[G.lastStation].name.toUpperCase(), W / 2, py + 44, 7.5, C.mid, 'center', 600, true);
    txt(ctx, 'KILLS ' + G.kills + '   ·   CREDITS ' + money(G.credits) + '   ·   TIME ' + GK.fmtTime(G.time), W / 2, py + 60, 8, C.ink, 'center', 600, true);
    txt(ctx, '30% of cargo lost in the wreck', W / 2, py + 74, 7, C.dim, 'center', 600, true);
    button(ctx, 'RESPAWN AT STATION', px + 16, py + 92, pw - 32, 32, respawn, { size: 9.5, bg: 'rgba(255,122,69,0.16)', border: 'rgba(255,122,69,0.7)', fg: C.ink });
    button(ctx, 'ABANDON RUN', px + 16, py + 132, pw - 32, 24, quitToTitle, { size: 8.5, bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.14)', fg: C.mid });
  }

  /* ------------------------------------------------------------------ */
  /* screen flow + input                                                 */
  /* ------------------------------------------------------------------ */
  function startNewGame() {
    GK.sfx.unlock();
    newRun(false);
    UI.hits.length = 0;
    pad.show(true);
    say('WELCOME TO ' + G.gal.systems[G.cur].name.toUpperCase() + ' — DOCK OR JUMP');
  }
  function continueGame() {
    GK.sfx.unlock();
    if (!newRun(true)) { startNewGame(); return; }
    pad.show(true);
    say('WELCOME BACK · ' + G.gal.systems[G.cur].name.toUpperCase());
  }
  function quitToTitle() {
    saveGame();
    G = null;
    SP = null;
    UI.hits.length = 0;
    if (pad) pad.show(false);
  }
  function openMap() {
    if (!G || G.mode === 'dead' || G.mode === 'map') return;
    G.prevMode = G.mode === 'pause' ? 'flight' : G.mode;
    G.mode = 'map';
    if (G.selSys == null) G.selSys = G.cur;
    G.selSys = G.cur;
    pad.show(false);
  }
  function closeMap() {
    if (!G || G.mode !== 'map') return;
    G.mode = G.prevMode === 'station' ? 'station' : 'flight';
    pad.show(G.mode === 'flight');
  }
  function togglePause() {
    if (!G || G.mode === 'dead' || G.mode === 'map' || G.mode === 'station') return;
    if (G.mode === 'pause') { G.mode = G.prevMode || 'flight'; pad.show(G.mode === 'flight'); }
    else { G.prevMode = G.mode; G.mode = 'pause'; pad.show(false); }
  }

  function onPadPress(key) {
    if (!G) return;
    if (key === 'use') {
      if (G.mode !== 'flight') return;
      if (stationInRange()) dock();
      else say('TOO FAR FROM STATION');
    }
  }

  function onTap(e) {
    if (e) e.preventDefault();
    GK.sfx.unlock();
    var r = canvasEl.getBoundingClientRect();
    var x = e.clientX - r.left, y = e.clientY - r.top;
    for (var i = UI.hits.length - 1; i >= 0; i--) {
      var h = UI.hits[i];
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
        GK.buzz(6);
        try { h.fn(); } catch (err) {}
        return;
      }
    }
  }

  function onKey(e) {
    var k = e.key;
    if (!G) {
      if (k === 'Enter' || k === ' ') { if (hasSave()) continueGame(); else startNewGame(); }
      return;
    }
    if (k >= '1' && k <= '4') {
      G.player.wep = (+k) - 1;
      G.player.charge = 0; G.player.cool = 0.1;
      GK.sfx.hit();
    } else if (k === 'm' || k === 'M') {
      if (G.mode === 'map') closeMap(); else openMap();
    } else if (k === 'Escape' || k === 'p' || k === 'P') {
      togglePause();
    } else if (k === 'f' || k === 'F') {
      if (G.mode === 'flight') { if (stationInRange()) dock(); else say('TOO FAR FROM STATION'); }
    }
  }

  /* ------------------------------------------------------------------ */
  /* update / render / boot                                              */
  /* ------------------------------------------------------------------ */
  function update(dt, t) {
    if (pad) {
      IN.x = pad.state.x; IN.y = pad.state.y;
      IN.fire = !!pad.state.jump;
      IN.boost = !!pad.state.dash;
    }
    if (!G) { titleT += dt; return; }
    if (G.mode === 'flight' && SP) updateSpace(dt);
    else if (G.mode === 'dead') {
      updateParticles(dt);
      cam.shake = Math.max(0, cam.shake - dt * 18);
      G.toastT = Math.max(0, G.toastT - dt);
      if (G.toastT <= 0) G.toast = null;
    } else {
      updateParticles(dt);
      G.toastT = Math.max(0, G.toastT - dt);
      if (G.toastT <= 0) G.toast = null;
    }
  }

  function render(ctx, t, view) {
    VIEW.w = view.w; VIEW.h = view.h;
    UI.hits.length = 0;
    var mode = G ? G.mode : 'title';
    if (mode === 'title' || !SP) { drawTitle(ctx, t); return; }
    drawBackdrop(ctx, t);
    drawWorld(ctx, t);
    if (mode === 'flight') {
      drawMarkers(ctx, t);
      drawHUD(ctx, t);
    } else if (mode === 'map') {
      drawMap(ctx, t);
    } else if (mode === 'station') {
      drawStation(ctx, t);
    } else if (mode === 'pause') {
      drawPause(ctx);
    } else if (mode === 'dead') {
      drawDead(ctx);
    }
  }

  /* ------------------------------------------------------------------ */
  /* test hook: window.__game                                            */
  /* ------------------------------------------------------------------ */
  function snapshot() {
    var en = 0;
    if (G && SP) for (var i = 0; i < SP.enemies.length; i++) if (SP.enemies[i].on) en++;
    return {
      started: !!(G && G.mode && G.mode !== 'title'),
      system: G ? G.gal.systems[G.cur].name : '',
      ship: G ? hullDef(G.player.ship).name : '',
      credits: G ? Math.round(G.credits) : 0,
      hull: G ? Math.max(0, Math.round(G.player.hull)) : 0,
      cargo: G ? cargoCount() : 0,
      enemies: en,
      alive: !!(G && G.mode !== 'dead' && G.player.hull > 0)
    };
  }

  function act(name) {
    try {
      if (name === 'newGame') { startNewGame(); return true; }
      if (!G) return false;
      if (name === 'fire') {
        if (G.mode === 'dead' || G.player.dead) return false;
        if (G.mode !== 'flight') { G.mode = 'flight'; if (pad) pad.show(true); }
        G.player.cool = 0;
        G.player.energy = Math.max(G.player.energy, 40);
        G.player.charging = false;
        shoot(WEAPONS[G.player.wep], 1);
        return true;
      }
      if (name === 'jumpNext') {
        var adj = G.gal.adj[G.cur].slice();
        // prefer a system we have never seen, so repeated calls keep exploring
        adj.sort(function (a, b) { return (G.visited[a] ? 1 : 0) - (G.visited[b] ? 1 : 0); });
        for (var i = 0; i < adj.length; i++) {
          if (!laneKnown(G.cur, adj[i])) G.disc[laneKey(G.cur, adj[i])] = true;
          var cost = jumpCost(G.cur, adj[i]);
          if (G.fuel < cost) G.fuel = cost;   // harness convenience: never strand a script
          if (jumpTo(adj[i])) return true;
        }
        return false;
      }
      if (name === 'dock') { dock(); return true; }
      return false;
    } catch (e) {
      return false;
    }
  }

  window.__game = { state: function () { try { return snapshot(); } catch (e) { return { started: false, system: '', credits: 0, hull: 0, cargo: 0, enemies: 0, alive: false }; } }, act: act };

  var canvasEl = document.getElementById('game');

  function boot() {
    if (!canvasEl) return;
    initPools();
    initStars();
    preloadSprites();
    cam.x = ARENA * 0.5; cam.y = ARENA * 0.5;
    pad = GK.pad({
      actions: [['FIRE', 'jump'], ['BOOST', 'dash'], ['DOCK', 'use']],
      onPress: onPadPress
    });
    pad.show(false);
    canvasEl.addEventListener('pointerdown', onTap, { passive: false });
    window.addEventListener('keydown', onKey);
    window.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    GK.boot({
      canvas: canvasEl,
      update: update,
      render: render,
      onResize: function (v) { VIEW.w = v.w; VIEW.h = v.h; }
    });
  }

  boot();
})();
