/* Tessera — a 4X in your pocket.
 * Classic script (no modules, no network). One AI opponent, seeded hex map,
 * city economy, road trade, the 74-tech Civ V tree (Unciv tables), turn 80 scoring.
 * Everything is canvas 2D; the shared runtime (GK) handles boot/storage/sfx. */
(function () {
  'use strict';
  var GK = window.GK;

  /* ============================ constants ============================ */
  var COLS = 24, ROWS = 18;
  var HEX_R = 26;
  var HEX_W = Math.sqrt(3) * HEX_R;      // pointy-top hex width
  var HEX_H = 1.5 * HEX_R;               // row pitch
  var MAP_W = HEX_W * (COLS + 0.5);
  var MAP_H = HEX_H * (ROWS - 1) + 2 * HEX_R;
  var MAX_TURN = 80;

  var BG = '#0e1116';
  var PANEL = '#151b24';
  var PANEL2 = '#1c2431';
  var LINE = 'rgba(255,255,255,.09)';
  var INK = '#e7ebf2';
  var MUTED = '#8b95a5';
  var ACCENT = '#f0b429';
  var P1 = '#f0b429';                    // player: amber
  var P2 = '#d1573f';                    // rival: rust

  /* Terrain table: yields per turn, movement cost, defence bonus. */
  var TER = {
    ocean:    { name: 'Ocean',     color: '#123a4d', f: 0, p: 0, g: 1, move: 2, def: 0,    land: false },
    plains:   { name: 'Plains',    color: '#34512f', f: 2, p: 1, g: 0, move: 1, def: 0,    land: true },
    forest:   { name: 'Forest',    color: '#22422d', f: 1, p: 2, g: 0, move: 2, def: 0.25, land: true },
    hills:    { name: 'Hills',     color: '#4b4732', f: 1, p: 2, g: 1, move: 2, def: 0.35, land: true },
    mountain: { name: 'Mountains', color: '#3b3a42', f: 0, p: 2, g: 1, move: 9, def: 0.5,  land: true, imp: true },
    desert:   { name: 'Desert',    color: '#5c4b2c', f: 0, p: 1, g: 1, move: 1, def: 0,    land: true }
  };

  /* ============================ vendored content ============================ */
  /* The Civ V rule set — 74 technologies, 100 units, 100 buildings, 24 nations —
   * comes from the table bundle at vendor/vendor.js (see docs/VENDORED-CONTENT.md).
   * The bundle is optional: with it missing the game boots on the authored
   * eight-tech timeline below and plays exactly as it used to. */
  var VDATA = (window.AOMG_VENDOR && window.AOMG_VENDOR.data) || {};
  function table(key) { var t = VDATA[key]; return (t && t.length) ? t : null; }
  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  /* Unciv prices a full Civ V campaign: Agriculture 20 -> Future Tech 9500 science,
   * a Warrior 40 and a Factory 360 hammers. Tessera is 80 turns at 2-14 science and
   * 2-10 hammers per turn, so every table is scaled onto that horizon:
   *
   *   TECH_SCALE  0.10  Pottery 35 -> 4 (two opening turns at 2 science),
   *                     Steam Power 2350 -> 235 (~20 turns of a mid-game empire's
   *                     ~12 science). A straight copy of the raw costs would put
   *                     Industrial techs 250 turns out; this lands one every few
   *                     turns for the whole 80.
   *   UNIT_SCALE  0.30  Warrior 40 -> 12 hammers, Settler 106 -> 32 (was 30).
   *   BUILD_SCALE 0.32  Granary 60 -> 19, Factory 360 -> 115.
   *
   * TECH_SLOPE is the per-owned-tech price rise: 8% here, because 74 techs compound
   * far harder than the original 8 did at 22%. */
  var TECH_SCALE = 0.10, UNIT_SCALE = 0.30, BUILD_SCALE = 0.32, TECH_SLOPE = 0.08;

  var TECHS = [], TECH_BY = {}, TECH_ERAS = [], START_TECH = null;
  var BUILDS = {}, BUILD_ORDER = [], UNITS = {}, UNIT_ORDER = [];
  var CIVS = [];

  /* Real Civ V rows that drive a live rule in this game get a written effect line;
   * every other tech says what it unlocks, read straight out of the unit and
   * building tables. */
  var TECH_EFFECT = {
    'bronze-working': 'Melee units +25% attack',
    'iron-working':   'Melee units +2 attack',
    'writing':        '+1 science per city, +10% research',
    'the-wheel':      'Roads cost half movement',
    'masonry':        'Walls, +4 city defence',
    'sailing':        'Units may cross coastal water',
    'currency':       'Market, trade routes +2 gold',
    'mathematics':    '+1 production per city, +20% research'
  };

  (function loadContent() {
    var techRows = table('unciv/techs');
    var unitRows = table('unciv/units');
    var buildRows = table('unciv/buildings');
    var nationRows = table('unciv/nations');
    var i, k;

    /* ---- technologies ---- */
    if (techRows) {
      techRows = techRows.slice().sort(function (a, b) {
        return (a.column - b.column) || (a.row - b.row) || (a.name < b.name ? -1 : 1);
      });
      var byCol = {};
      for (i = 0; i < techRows.length; i++) {
        var col = techRows[i].column | 0;
        (byCol[col] = byCol[col] || []).push(slug(techRows[i].name));
      }
      for (i = 0; i < techRows.length; i++) {
        var r = techRows[i], id = slug(r.name), c = r.column | 0;
        var quote = String(r.quote || '')
          .replace(/^["'\u2018\u201c]+/, '').replace(/["'\u2019\u201d]+$/, '').trim();
        var t = {
          id: id, name: r.name, col: c, row: r.row | 0,
          era: r.era || 'Ancient era', quote: quote,
          cost: Math.max(3, Math.round((+r.cost || 20) * TECH_SCALE)),
          bcost: +r.building_cost || 0,
          req: c > 0 ? (byCol[c - 1] || []).slice() : [],
          all: false, eff: ''
        };
        TECHS.push(t);
        TECH_BY[id] = t;
        if ((r.uniques || []).indexOf('Starting tech') >= 0) START_TECH = id;
        if (TECH_ERAS.indexOf(t.era) < 0) TECH_ERAS.push(t.era);
      }
      if (!START_TECH && TECHS.length) START_TECH = TECHS[0].id;
    } else {
      /* Fallback: the original eight-tech miniature, unchanged. */
      TECH_SLOPE = 0.22;
      var OLD = [
        ['bronze',  'Bronze Working', 26, [],               'Melee units +25% attack'],
        ['writing', 'Writing',        32, [],               '+1 science per city, +10% research'],
        ['wheel',   'The Wheel',      38, ['bronze'],       'Roads cost half movement'],
        ['masonry', 'Masonry',        44, ['bronze'],       'Unlocks Walls, +4 city defence'],
        ['sailing', 'Sailing',        50, ['wheel'],        'Units may cross coastal water'],
        ['currency','Currency',       58, ['writing'],      'Unlocks Market, trade routes +2 gold'],
        ['iron',    'Iron Working',   76, ['bronze'],       'Melee units +2 strength'],
        ['math',    'Mathematics',    92, ['writing','currency'], '+1 production per city, +20% research']
      ];
      for (i = 0; i < OLD.length; i++) {
        TECHS.push({ id: OLD[i][0], name: OLD[i][1], cost: OLD[i][2], req: OLD[i][3],
                     all: true, eff: OLD[i][4], era: 'Ancient era', quote: '', col: 0, row: i });
        TECH_BY[OLD[i][0]] = TECHS[i];
      }
      TECH_ERAS = ['Ancient era'];
    }

    /* ---- units: standard (non-unique) roster, real strength/movement/cost ---- */
    var ROLE = { Sword: 'melee', Archery: 'ranged', Mounted: 'mounted', Siege: 'ranged',
                 Gunpowder: 'melee', Armored: 'melee', Scout: 'scout', Civilian: 'civ' };
    if (unitRows) {
      var seenU = {}, roster = [];
      for (i = 0; i < unitRows.length; i++) {
        var u = unitRows[i], role = ROLE[u.unitType];
        if (!role) continue;                       // no naval / air / great-people rules here
        if (!u.requiredTech) continue;             // barbarians and ungated uniques
        if (role === 'civ' && u.name !== 'Worker' && u.name !== 'Settler') continue;
        var ukey = (u.name === 'Worker' || u.name === 'Settler' || u.name === 'Scout')
          ? 'base|' + u.name : u.requiredTech + '|' + u.unitType;
        if (seenU[ukey]) continue;                 // first of each class is the standard unit
        seenU[ukey] = 1;
        roster.push(u);
      }
      roster.sort(function (a, b) { return (a.cost - b.cost) || (a.name < b.name ? -1 : 1); });
      for (i = 0; i < roster.length; i++) {
        u = roster[i]; role = ROLE[u.unitType];
        var str = +u.strength || 0, rstr = +u.rangedStrength || 0;
        var uid = slug(u.name), techId = slug(u.requiredTech);
        if (!TECH_BY[techId]) continue;
        UNITS[uid] = {
          name: u.name, atk: rstr || str, def: Math.round(str * 0.85 * 10) / 10,
          mv: Math.max(1, +u.movement || 2), ranged: rstr > 0, role: role,
          sight: role === 'scout' ? 4 : role === 'mounted' ? 3 : 2,
          glyph: role === 'civ' ? (u.name === 'Settler' ? 'settler' : 'worker') : role
        };
        BUILDS[uid] = {
          name: u.name,
          cost: Math.max(6, Math.round((+u.cost || 40) * UNIT_SCALE)),
          kind: 'unit', tech: techId,
          desc: role === 'civ'
            ? (u.name === 'Settler' ? 'Founds a city · uses 1 pop' : 'Lays roads between cities')
            : 'Str ' + str + (rstr ? ' / rng ' + rstr : '') + ' · ' + UNITS[uid].mv + ' moves'
        };
        UNIT_ORDER.push(uid);
      }
      BUILD_ORDER = UNIT_ORDER.slice();
    }

    /* ---- buildings: the standard building of each tech, real costs ---- */
    if (buildRows) {
      var seenB = {}, brows = [];
      for (i = 0; i < buildRows.length; i++) {
        var b = buildRows[i];
        if (!b.requiredTech) continue;              // Palace is capital-only
        var bt = TECH_BY[slug(b.requiredTech)];
        if (!bt || seenB[bt.id]) continue;
        seenB[bt.id] = 1;
        b.__t = bt;
        brows.push(b);
      }
      brows.sort(function (a, b2) {
        return ((+a.cost || a.__t.bcost || 120) - (+b2.cost || b2.__t.bcost || 120)) ||
          (a.name < b2.name ? -1 : 1);
      });
      for (i = 0; i < brows.length; i++) {
        b = brows[i]; bt = b.__t;
        var bid = slug(b.name), raw = +b.cost || bt.bcost || 120;
        BUILDS[bid] = {
          name: b.name, cost: Math.max(8, Math.round(raw * BUILD_SCALE)), kind: 'b', tech: bt.id,
          desc: (b.maintenance ? b.maintenance + 'g upkeep' : 'No upkeep') +
                ' · ' + String(bt.era || '').replace(' era', '')
        };
        BUILD_ORDER.push(bid);
      }
    }

    /* ---- authored roster, only if the bundle carried no unit/building rows ---- */
    if (!BUILD_ORDER.length) {
      var FB = [
        ['warrior',  'Warrior',  18, 'unit', null,       'Str 6 · 2 moves · holds ground',
          { name: 'Warrior', atk: 6, def: 5, mv: 2, sight: 2, role: 'melee', glyph: 'melee' }],
        ['scout',    'Scout',    12, 'unit', null,       'Str 3 · 3 moves · sees far',
          { name: 'Scout', atk: 3, def: 3, mv: 3, sight: 4, role: 'scout', glyph: 'scout' }],
        ['worker',   'Worker',   16, 'unit', null,       'Builds roads between cities',
          { name: 'Worker', atk: 1, def: 2, mv: 2, sight: 2, role: 'civ', glyph: 'worker' }],
        ['settler',  'Settler',  30, 'unit', null,       'Found a city · uses 1 pop',
          { name: 'Settler', atk: 0, def: 2, mv: 2, sight: 2, role: 'civ', glyph: 'settler' }],
        ['granary',  'Granary',  24, 'b', null,          '+20% food', null],
        ['workshop', 'Workshop', 26, 'b', null,          '+20% production', null],
        ['market',   'Market',   28, 'b', 'currency',    '+1 gold per worked tile', null],
        ['walls',    'Walls',    26, 'b', 'masonry',     '+10 city defence', null]
      ];
      for (i = 0; i < FB.length; i++) {
        BUILDS[FB[i][0]] = { name: FB[i][1], cost: FB[i][2], kind: FB[i][3], tech: FB[i][4], desc: FB[i][5] };
        if (FB[i][6]) { UNITS[FB[i][0]] = FB[i][6]; UNIT_ORDER.push(FB[i][0]); }
        BUILD_ORDER.push(FB[i][0]);
      }
    }

    /* ---- effect line for every tech ---- */
    for (i = 0; i < TECHS.length; i++) {
      var tt = TECHS[i];
      if (TECH_EFFECT[tt.id]) { tt.eff = TECH_EFFECT[tt.id]; continue; }
      var un = [];
      for (k = 0; k < BUILD_ORDER.length; k++) {
        var it = BUILDS[BUILD_ORDER[k]];
        if (it.tech === tt.id) un.push(it.name);
      }
      tt.eff = un.length
        ? 'Unlocks ' + un.slice(0, 2).join(', ') + (un.length > 2 ? ' +' + (un.length - 2) + ' more' : '')
        : '';
    }

    /* ---- civilisations ---- */
    if (nationRows) {
      var seenN = {};
      for (i = 0; i < nationRows.length; i++) {
        var n = nationRows[i];
        if (!n.leaderName || seenN[n.name]) continue;
        seenN[n.name] = 1;
        CIVS.push({ name: n.name, leader: n.leaderName });
      }
    }
    if (!CIVS.length) {
      CIVS = [{ name: 'Aurelia', leader: 'the Aurelian Council' },
              { name: 'Zarrak', leader: 'the Zarrak Warlord' }];
    }
  })();

  /* Seeded draw of the two powers on the board: P1 is you, P2 the rival. */
  function civPair(seed) {
    var n = CIVS.length;
    if (!n) return null;
    var s = (seed >>> 0) || 1;
    var a = s % n, b = (a + 1 + ((s >>> 3) % Math.max(1, n - 1))) % n;
    return [CIVS[a], CIVS[b === a ? (a + 1) % n : b]];
  }

  /* Techs get dearer as the tree fills, so research stays a decision all game. */
  function techCost(p, id) {
    var owned = 0;
    for (var k in p.techs) if (p.techs[k]) owned++;
    return Math.round(TECH_BY[id].cost * (1 + TECH_SLOPE * owned));
  }

  function has(p, id) { return !!(p && p.techs[id]); }

  /* Availability. Unciv ships the Civ V tree as 18 columns and the arrows between
   * them only ever run left to right, so the previous column IS the prerequisite
   * tier: knowing any tech of the tier above unlocks this one, and the row distance
   * decides how the path reads (a player can skip a branch, as in Civ V). A flat
   * "prerequisite" list would strand most of the tree — measured, the strict
   * row-ordered link left 62 of 74 techs unreachable — so the tier is the rule. */
  function techAvailable(p, t) {
    if (!t || p.techs[t.id]) return false;
    if (!t.req.length) return true;
    var i;
    if (t.all) {
      for (i = 0; i < t.req.length; i++) if (!p.techs[t.req[i]]) return false;
      return true;
    }
    for (i = 0; i < t.req.length; i++) if (p.techs[t.req[i]]) return true;
    return false;
  }

  var P_NAMES = ['Aurelia', 'Brantis', 'Caldor', 'Dunmere', 'Eshara', 'Fairhold', 'Giltan', 'Harrow'];
  var A_NAMES = ['Zarrak', 'Kesh', 'Mordul', 'Vharn', 'Tazir', 'Belkor', 'Sarnath', 'Drem'];
  var DIFF = { easy: { aiProd: 0.82, aiSci: 0.85, aggro: 0.85, label: 'Easy' },
               normal: { aiProd: 1.0, aiSci: 1.0, aggro: 1.0, label: 'Normal' },
               hard: { aiProd: 1.18, aiSci: 1.15, aggro: 1.25, label: 'Hard' } };

  /* ============================ helpers ============================ */
  function idx(c, r) { return r * COLS + c; }
  function inB(c, r) { return c >= 0 && c < COLS && r >= 0 && r < ROWS; }
  function dist(a, b, c, d) {
    var aq = a - ((b - (b & 1)) >> 1), bq = c - ((d - (d & 1)) >> 1);
    var ds = b - d, dq = aq - bq;
    return Math.max(Math.abs(dq), Math.abs(ds), Math.abs(-dq - ds));
  }
  function cxp(c, r) { return HEX_W * (c + 0.5 * (r & 1)) + HEX_W * 0.5; }
  function cyp(c, r) { return HEX_H * r + HEX_R; }

  var PTS = [[0, -HEX_R], [HEX_W * 0.5, -HEX_R * 0.5], [HEX_W * 0.5, HEX_R * 0.5],
             [0, HEX_R], [-HEX_W * 0.5, HEX_R * 0.5], [-HEX_W * 0.5, -HEX_R * 0.5]];

  function hexPath(ctx, x, y) {
    ctx.beginPath();
    ctx.moveTo(x + PTS[0][0], y + PTS[0][1]);
    for (var i = 1; i < 6; i++) ctx.lineTo(x + PTS[i][0], y + PTS[i][1]);
    ctx.closePath();
  }

  function txt(ctx, s, x, y, size, color, align, weight, maxW) {
    ctx.font = (weight || 600) + ' ' + size + 'px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
    ctx.fillStyle = color || INK;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    if (maxW) ctx.fillText(s, x, y, maxW); else ctx.fillText(s, x, y);
  }

  function rrect(ctx, x, y, w, h, r) {
    r = Math.min(r, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function fmt(n) { return String(Math.round(n)); }
  function sign(n) { return (n >= 0 ? '+' : '') + Math.round(n); }

  /* ============================ game state ============================ */
  var G = null;
  var ui = {
    screen: 'title', panel: null, cityId: 0, selId: 0, reach: null, best: null,
    techPage: 0, buildPage: 0,
    seedText: '20261028', diff: 'normal', toast: '', toastT: 0, keypad: false,
    helpFrom: 'title', menuReturn: null
  };
  var cam = { x: MAP_W / 2, y: MAP_H / 2, z: 0.95 };
  var store = GK.store('tessera');

  /* ============================ map generation ============================ */
  function nlattice(rng, gw, gh) {
    var a = new Float32Array(gw * gh);
    for (var i = 0; i < a.length; i++) a[i] = rng();
    return { a: a, w: gw, h: gh };
  }
  function sample(lat, u, v) {
    var x = u * (lat.w - 1), y = v * (lat.h - 1);
    var x0 = Math.floor(x), y0 = Math.floor(y);
    var fx = x - x0, fy = y - y0;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    var x1 = Math.min(lat.w - 1, x0 + 1), y1 = Math.min(lat.h - 1, y0 + 1);
    var a = lat.a[y0 * lat.w + x0], b = lat.a[y0 * lat.w + x1];
    var c = lat.a[y1 * lat.w + x0], d = lat.a[y1 * lat.w + x1];
    var top = a + (b - a) * fx, bot = c + (d - c) * fx;
    return top + (bot - top) * fy;
  }

  function generate(seed) {
    var rng = GK.rand(seed >>> 0);
    var e1 = nlattice(rng, 7, 6), e2 = nlattice(rng, 13, 10), ml = nlattice(rng, 9, 7);
    var tiles = new Array(COLS * ROWS);
    var c, r, t;

    for (r = 0; r < ROWS; r++) {
      for (c = 0; c < COLS; c++) {
        var u = c / (COLS - 1), v = r / (ROWS - 1);
        var dx = (u - 0.5) * 1.95, dy = (v - 0.5) * 1.85;
        var fall = 1 - Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.02);
        var e = sample(e1, u, v) * 0.58 + sample(e2, u, v) * 0.27 + Math.max(0, fall) * 0.42 - 0.10;
        var m = sample(ml, u, v);
        var terr;
        if (c < 1 || r < 1 || c > COLS - 2 || r > ROWS - 2) terr = 'ocean';
        else if (e < 0.40) terr = 'ocean';
        else if (e > 0.86) terr = 'mountain';
        else if (e > 0.70) terr = 'hills';
        else if (m < 0.30) terr = 'desert';
        else if (m > 0.62) terr = 'forest';
        else terr = 'plains';

        t = {
          c: c, r: r, terr: terr, res: null, road: 0, owner: 0, city: 0,
          explored: false, vis: false, coast: false,
          shade: Math.round(GK.rr(rng, -9, 9)),
          pts: []
        };
        // deterministic texture marks, baked once per map
        var np = GK.ri(rng, 2, 4);
        for (var k = 0; k < np; k++) {
          t.pts.push(GK.rr(rng, -0.5, 0.5), GK.rr(rng, -0.38, 0.34), GK.rr(rng, 0.8, 2.6));
        }
        tiles[idx(c, r)] = t;
      }
    }

    var work = { tiles: tiles };
    // coast flag + resources
    for (r = 0; r < ROWS; r++) {
      for (c = 0; c < COLS; c++) {
        t = tiles[idx(c, r)];
        var land = TER[t.terr].land;
        if (t.terr === 'ocean') {
          var nb = neighbours(work, t);
          for (var j = 0; j < nb.length; j++) if (TER[nb[j].terr].land) { t.coast = true; break; }
        }
        if (land && !TER[t.terr].imp && t.terr !== 'desert' && t.terr !== 'mountain') {
          var roll = rng();
          if (t.terr === 'plains' && roll < 0.13) t.res = 'grain';
          else if (t.terr === 'hills' && roll < 0.16) t.res = 'ore';
          else if (t.terr === 'forest' && roll < 0.10) t.res = 'grain';
          else if (t.terr === 'desert' && roll < 0.18) t.res = 'crystal';
        }
      }
    }
    return tiles;
  }

  function neighbours(w, t) {
    var odd = t.r & 1;
    var c = t.c, r = t.r, out = [];
    var N = odd ? [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]]
                : [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]];
    for (var i = 0; i < 6; i++) {
      var nc = c + N[i][0], nr = r + N[i][1];
      if (inB(nc, nr)) out.push(w.tiles[idx(nc, nr)]);
    }
    return out;
  }

  function pickStart(tiles, rng, region) {
    var best = null, bs = -1e9;
    for (var r = region[1]; r <= region[3]; r++) {
      for (var c = region[0]; c <= region[2]; c++) {
        var t = tiles[idx(c, r)];
        if (!TER[t.terr].land || TER[t.terr].imp || t.terr === 'desert') continue;
        var s = tileYield(t).f * 1.3 + tileYield(t).p * 1.1;
        var nb = neighbours({ tiles: tiles }, t);
        for (var i = 0; i < nb.length; i++) {
          var n = nb[i];
          if (n.terr === 'ocean') s -= 0.35;
          else if (!TER[n.terr].imp) s += tileYield(n).f * 0.5 + tileYield(n).p * 0.5;
        }
        s += GK.rr(rng, 0, 1.2);
        if (s > bs) { bs = s; best = t; }
      }
    }
    return best;
  }

  function tileYield(t) {
    var b = TER[t.terr];
    var y = { f: b.f, p: b.p, g: b.g };
    if (t.res === 'grain') y.f += 2;
    else if (t.res === 'ore') y.p += 2;
    else if (t.res === 'crystal') y.g += 2;
    return y;
  }

  /* ============================ new game ============================ */
  function newGame(seed, diff) {
    seed = (seed >>> 0) || 1;
    diff = DIFF[diff] ? diff : 'normal';
    var d = DIFF[diff];
    var tiles = generate(seed);
    var rng = GK.rand((seed ^ 0x5bf03635) >>> 0);

    var sg = { tiles: tiles };
    var pStart = pickStart(tiles, rng, [2, ROWS - 8, 8, ROWS - 3]);
    var aStart = pickStart(tiles, rng, [COLS - 9, 2, COLS - 3, 7]);
    if (!pStart) pStart = tiles[idx(3, ROWS - 4)];
    if (!aStart) aStart = tiles[idx(COLS - 4, 3)];
    if (dist(pStart.c, pStart.r, aStart.c, aStart.r) < 10) {
      aStart = tiles[idx(COLS - 4, 3)];
      if (aStart.terr === 'ocean') aStart = tiles[idx(COLS - 5, 4)];
    }

    /* Two real Civ V powers from the nations table, drawn from the seed. */
    var pair = civPair(seed) || [{ name: 'Tessera', leader: 'the Council' },
                                 { name: 'Rival', leader: 'the Warlord' }];

    G = {
      seed: seed, diff: diff, turn: 1, over: false, result: '', reason: '',
      rng: rng, tiles: tiles, cities: [], units: [], nextId: 1, cityById: {},
      civs: { 1: pair[0], 2: pair[1] },
      players: {
        1: { id: 1, gold: 12, progress: 0, research: null, lastTech: null, techs: {}, trade: 0, sci: 0, goldNow: 0 },
        2: { id: 2, gold: 12, progress: 0, research: null, lastTech: null, techs: {}, trade: 0, sci: 0, goldNow: 0 }
      },
      log: []
    };

    /* Both powers start with the tree's root tech (Agriculture in Civ V). */
    var p1 = G.players[1], p2 = G.players[2];
    if (START_TECH) { p1.techs[START_TECH] = true; p2.techs[START_TECH] = true; }
    p1.research = chooseResearch(p1);
    p2.research = chooseResearch(p2);

    // guaranteed starter resources so the opening is never barren
    gift(pStart, 'grain', sg);
    gift(aStart, 'grain', sg);
    var pn = neighbours(sg, pStart);
    for (var i = 0; i < pn.length; i++) if (TER[pn[i].terr].land && !pn[i].res && pn[i].terr !== 'ocean') { pn[i].res = 'ore'; break; }
    var an = neighbours(sg, aStart);
    for (var j = 0; j < an.length; j++) if (TER[an[j].terr].land && !an[j].res && an[j].terr !== 'ocean') { an[j].res = 'ore'; break; }

    var pc = foundCity(1, pStart.c, pStart.r, P_NAMES[0], true);
    var ac = foundCity(2, aStart.c, aStart.r, A_NAMES[0], true);
    pc.pop = 2; pc.food = 0;
    ac.pop = 2; ac.food = 0;

    // a settler each, parked on a legal second-city site
    placeSettler(1, pStart, sg);
    placeSettler(2, aStart, sg);
    var pw = spawnTile(pc), aw = spawnTile(ac);
    if (pw) spawnUnit(1, 'warrior', pw.c, pw.r);
    if (aw) spawnUnit(2, 'warrior', aw.c, aw.r);
    if (diff === 'hard') { var aw2 = spawnTile(ac); if (aw2) spawnUnit(2, 'warrior', aw2.c, aw2.r); }

    ui.screen = 'game';
    ui.panel = null;
    ui.selId = 0;
    ui.reach = null;
    ui.cityId = 0;
    cam.z = 0.95;
    centerOn(pStart.c, pStart.r);
    computeVisibility();
    selectFirstUnit();
    ui.toast = 'Turn 1 — found, build, expand.';
    ui.toastT = 2.6;
    bakeMap();
  }

  function gift(t, res, w) {
    if (t && TER[t.terr].land && t.terr !== 'ocean' && t.terr !== 'mountain') t.res = res;
  }

  function placeSettler(owner, start, w) {
    // search rings 2..5 for a legal city site
    for (var rad = 2; rad <= 5; rad++) {
      var cands = tilesInRadius(w, start, rad);
      for (var i = 0; i < cands.length; i++) {
        var t = cands[i];
        if (dist(t.c, t.r, start.c, start.r) !== rad) continue;
        if (canFoundAt(t.c, t.r, owner) && !unitAt(t.c, t.r)) {
          spawnUnit(owner, 'settler', t.c, t.r);
          return;
        }
      }
    }
  }

  function tilesInRadius(w, t, rad) {
    var out = [];
    for (var r = Math.max(0, t.r - rad); r <= Math.min(ROWS - 1, t.r + rad); r++) {
      for (var c = Math.max(0, t.c - rad - 1); c <= Math.min(COLS - 1, t.c + rad + 1); c++) {
        if (dist(t.c, t.r, c, r) <= rad) out.push(w.tiles[idx(c, r)]);
      }
    }
    return out;
  }

  /* ============================ cities ============================ */
  function cityAt(t) { return t && t.city ? G.cityById[t.city] : null; }

  /* First unused name from the owner's pool — no duplicate city names. */
  function cityName(owner) {
    var pool = owner === 1 ? P_NAMES : A_NAMES, used = {};
    for (var i = 0; i < G.cities.length; i++) used[G.cities[i].name] = true;
    for (var j = 0; j < pool.length; j++) if (!used[pool[j]]) return pool[j];
    return pool[G.cities.length % pool.length] + ' II';
  }

  function canFoundAt(c, r, owner) {
    if (!inB(c, r)) return false;
    var t = G.tiles[idx(c, r)];
    if (!t || !TER[t.terr].land || TER[t.terr].imp) return false;
    if (t.city) return false;
    if (t.owner && t.owner !== owner) return false;
    for (var i = 0; i < G.cities.length; i++) {
      var ci = G.cities[i];
      if (dist(c, r, ci.c, ci.r) < 3) return false;
    }
    return true;
  }

  function foundCity(owner, c, r, name, silent) {
    var t = G.tiles[idx(c, r)];
    var p = G.players[owner];
    var city = {
      id: G.nextId++, owner: owner, c: c, r: r, name: name,
      pop: 1, food: 0, prod: 0, queue: [], buildings: {},
      hp: 0, maxHp: 0, held: null, yields: null, founded: G.turn
    };
    city.maxHp = cityHP(city);
    city.hp = city.maxHp;
    G.cities.push(city);
    G.cityById[city.id] = city;
    t.city = city.id;
    t.owner = owner;
    claimTiles(city);
    computeCity(city);
    if (!silent) {
      logMsg((owner === 1 ? 'Founded ' : 'Rival founds ') + name);
      if (owner === 1) GK.sfx.unlock();
    }
    return city;
  }

  function claimTiles(city) {
    var t = G.tiles[idx(city.c, city.r)];
    t.owner = city.owner;
    var nb = neighbours(G, t);
    for (var i = 0; i < nb.length; i++) {
      if (TER[nb[i].terr].land && !nb[i].imp && !nb[i].city) nb[i].owner = city.owner;
    }
  }

  /* Building ids come from the real table, so a few Civ V buildings can drive the
   * economy directly: the library line adds science, and every finished building
   * stiffens the city a little (cityHP). */
  var SCIENCE_BUILDINGS = { library: 1, university: 1, observatory: 1, 'public-school': 1, 'research-lab': 1 };
  function scienceBuildings(city) {
    var n = 0;
    for (var k in SCIENCE_BUILDINGS) if (city.buildings[k]) n += SCIENCE_BUILDINGS[k];
    return n;
  }
  function cityBuildingCount(city) {
    var n = 0;
    for (var k in city.buildings) if (city.buildings[k]) n++;
    return n;
  }

  function cityHP(city) {
    var p = G.players[city.owner];
    var hp = 15 + city.pop * 2.2;    // sieges need a few turns, not one warrior
    if (city.buildings.walls) hp += 10;
    if (has(p, 'masonry')) hp += 4;
    hp += Math.min(8, cityBuildingCount(city) * 2);   // real buildings harden a city
    var t = G.tiles[idx(city.c, city.r)];
    hp *= 1 + TER[t.terr].def;
    return Math.round(hp);
  }

  function computeCity(city) {
    var center = G.tiles[idx(city.c, city.r)];
    var res = { f: 0, p: 0, g: 0, s: 0, worked: [] };
    var cy = tileYield(center);
    res.f += Math.max(2, cy.f + 1);
    res.p += Math.max(1, cy.p + 1);
    res.g += cy.g + 1;

    var ring = neighbours(G, center), vals = [];
    for (var i = 0; i < ring.length; i++) {
      var t = ring[i];
      if (!TER[t.terr].land || TER[t.terr].imp) continue;
      if (t.owner && t.owner !== city.owner) continue;
      var y = tileYield(t);
      vals.push({ t: t, y: y, s: y.f * 1.25 + y.p * 1.15 + y.g * 0.6 });
    }
    vals.sort(function (a, b) { return b.s - a.s; });
    var n = Math.min(Math.max(1, city.pop), vals.length);
    for (var k = 0; k < n; k++) {
      res.f += vals[k].y.f; res.p += vals[k].y.p; res.g += vals[k].y.g;
      res.worked.push(idx(vals[k].t.c, vals[k].t.r));
    }

    if (city.buildings.granary) res.f = Math.round(res.f * 1.2);
    if (city.buildings.workshop) res.p = Math.round(res.p * 1.2);

    var p = G.players[city.owner];
    if (city.buildings.market) res.g += Math.max(1, res.worked.length);
    if (has(p, 'mathematics')) res.p += 1;

    var sci = 1 + city.pop * 0.5 + (has(p, 'writing') ? 1 : 0) + scienceBuildings(city);
    if (has(p, 'mathematics')) sci *= 1.2;
    if (has(p, 'writing')) sci *= 1.1;
    res.s = Math.round(sci * 10) / 10;
    city.yields = res;
    return res;
  }

  /* Road connectivity → trade routes. Cities are nodes; a road tile is a node too,
   * and two nodes connect when the hexes touch. Returns (cities in network - 1)
   * summed over networks, i.e. the number of extra city pairs trading. */
  function tradeRoutes(owner) {
    var cities = citiesOf(owner);
    if (cities.length < 2) return 0;

    function nodeKey(t) {
      if (t.city) {
        var c = G.cityById[t.city];
        return c && c.owner === owner ? 'c' + c.id : null;
      }
      return t.road === owner ? 'r' + idx(t.c, t.r) : null;
    }

    var seen = {}, pairs = 0;
    for (var i = 0; i < cities.length; i++) {
      var start = cities[i], sk = 'c' + start.id;
      if (seen[sk]) continue;
      seen[sk] = 1;
      var stack = [G.tiles[idx(start.c, start.r)]], count = 0;
      while (stack.length) {
        var t = stack.pop();
        if (t.city) count++;
        var nb = neighbours(G, t);
        for (var j = 0; j < nb.length; j++) {
          var k = nodeKey(nb[j]);
          if (!k || seen[k]) continue;
          seen[k] = 1;
          stack.push(nb[j]);
        }
      }
      if (count > 1) pairs += count - 1;
    }
    return pairs;
  }

  /* ============================ units ============================ */
  function spawnUnit(owner, type, c, r) {
    var st = UNITS[type];
    var u = {
      id: G.nextId++, owner: owner, type: type, c: c, r: r,
      hp: 10, maxHp: 10, mp: st.mv, maxMoves: st.mv, fort: false
    };
    G.units.push(u);
    return u;
  }

  function unitAt(c, r) {
    for (var i = 0; i < G.units.length; i++) {
      var u = G.units[i];
      if (u.c === c && u.r === r) return u;
    }
    return null;
  }

  function unitById(id) {
    for (var i = 0; i < G.units.length; i++) if (G.units[i].id === id) return G.units[i];
    return null;
  }

  function unitsOf(owner) {
    var out = [];
    for (var i = 0; i < G.units.length; i++) if (G.units[i].owner === owner) out.push(G.units[i]);
    return out;
  }

  function citiesOf(owner) {
    var out = [];
    for (var i = 0; i < G.cities.length; i++) if (G.cities[i].owner === owner) out.push(G.cities[i]);
    return out;
  }

  function freeTileNear(c, r, owner) {
    var t = G.tiles[idx(c, r)];
    if (!unitAt(c, r)) return t;
    var nb = neighbours(G, t);
    for (var i = 0; i < nb.length; i++) {
      var n = nb[i];
      if (!TER[n.terr].imp && n.terr !== 'ocean' && !n.city && !unitAt(n.c, n.r)) return n;
    }
    return null;
  }

  /* Units never stack: new builds appear on a free neighbouring land tile. */
  function spawnTile(city) {
    var nb = neighbours(G, G.tiles[idx(city.c, city.r)]);
    for (var i = 0; i < nb.length; i++) {
      var n = nb[i];
      if (TER[n.terr].imp || !TER[n.terr].land || n.city) continue;
      if (unitAt(n.c, n.r)) continue;
      return n;
    }
    return null;
  }

  /* ============================ tech ============================ */
  function researchTech(p, id) {
    var t = TECH_BY[id];
    if (!t || !techAvailable(p, t)) return false;
    p.research = id;
    return true;
  }

  function grantTech(p, id) {
    p.techs[id] = true;
    p.lastTech = id;
    p.research = chooseResearch(p);
    p.progress = 0;
  }

  /* First available tech in tree order (column by column, top to bottom). */
  function chooseResearch(p) {
    for (var i = 0; i < TECHS.length; i++) {
      if (techAvailable(p, TECHS[i])) return TECHS[i].id;
    }
    return null;
  }

  /* How many techs the player could start right now — the pacing probe. */
  function techCountAhead(p) {
    var n = 0;
    for (var i = 0; i < TECHS.length; i++) if (techAvailable(p, TECHS[i])) n++;
    return n;
  }

  /* ============================ fog ============================ */
  function computeVisibility() {
    for (var i = 0; i < G.tiles.length; i++) G.tiles[i].vis = false;
    var us = unitsOf(1), cs = citiesOf(1), k;
    for (k = 0; k < us.length; k++) revealAround(us[k].c, us[k].r, UNITS[us[k].type].sight);
    for (k = 0; k < cs.length; k++) revealAround(cs[k].c, cs[k].r, 2 + (cs[k].pop > 3 ? 1 : 0));
  }

  function revealAround(c, r, rad) {
    for (var rr = Math.max(0, r - rad); rr <= Math.min(ROWS - 1, r + rad); rr++) {
      for (var cc = Math.max(0, c - rad - 1); cc <= Math.min(COLS - 1, c + rad + 1); cc++) {
        if (dist(c, r, cc, rr) > rad) continue;
        var t = G.tiles[idx(cc, rr)];
        t.vis = true; t.explored = true;
      }
    }
  }

  /* ============================ log / toast ============================ */
  function logMsg(s) {
    if (!G) return;
    G.log.push(s);
    if (G.log.length > 40) G.log.shift();
    ui.toast = s;
    ui.toastT = 2.4;
  }

  /* ============================ movement ============================ */
  function moveCost(u, t) {
    var p = G.players[u.owner];
    if (t.road === u.owner) return has(p, 'the-wheel') ? 0.5 : 1;
    return TER[t.terr].move;
  }

  function canEnter(u, t) {
    if (!t) return false;
    if (TER[t.terr].imp) return false;
    if (!TER[t.terr].land) {
      if (!has(G.players[u.owner], 'sailing') || !t.coast) return false;
    }
    if (t.city && G.cityById[t.city].owner !== u.owner) return false;
    if (unitAt(t.c, t.r)) return false;
    return true;
  }

  /* Dijkstra-ish relaxation over the small hex grid; returns cost map. */
  function computeReach(u) {
    var best = new Float32Array(COLS * ROWS);
    for (var i = 0; i < best.length; i++) best[i] = 99;
    best[idx(u.c, u.r)] = 0;
    for (var pass = 0; pass < 12; pass++) {
      var changed = false;
      for (var r = 0; r < ROWS; r++) {
        for (var c = 0; c < COLS; c++) {
          var bi = idx(c, r), b = best[bi];
          if (b >= 99) continue;
          var nb = neighbours(G, G.tiles[bi]);
          for (var k = 0; k < nb.length; k++) {
            var n = nb[k], ni = idx(n.c, n.r);
            if (!canEnter(u, n)) continue;
            var nc = b + moveCost(u, n);
            if (nc <= u.mp + 1e-6 && nc < best[ni] - 1e-6) { best[ni] = nc; changed = true; }
          }
        }
      }
      if (!changed) break;
    }
    return best;
  }

  function selectUnit(u) {
    if (!u || u.owner !== 1) { ui.selId = 0; ui.best = null; ui.reach = null; return false; }
    ui.selId = u.id;
    ui.best = computeReach(u);
    ui.reach = {};
    for (var i = 0; i < ui.best.length; i++) if (ui.best[i] < 99 && i !== idx(u.c, u.r)) ui.reach[i] = true;
    return true;
  }

  function selectFirstUnit() {
    var us = unitsOf(1);
    for (var i = 0; i < us.length; i++) if (us[i].mp > 0.01) return selectUnit(us[i]);
    for (var j = 0; j < us.length; j++) if (us[j].type !== 'settler') return selectUnit(us[j]);
    if (us.length) return selectUnit(us[0]);
    ui.selId = 0; ui.best = null; ui.reach = null;
    return false;
  }

  function moveUnit(u, dest) {
    if (!ui.best || u.mp <= 0) return false;
    var d = ui.best[idx(dest.c, dest.r)];
    if (!(d <= u.mp + 1e-6) || d >= 99) return false;
    // walk backwards through the cost field to validate the path exists
    var cur = dest, guard = 0, ok = false;
    while (guard++ < 20) {
      if (cur.c === u.c && cur.r === u.r) { ok = true; break; }
      var cb = ui.best[idx(cur.c, cur.r)], nb = neighbours(G, cur), next = null;
      var step = moveCost(u, cur);
      for (var i = 0; i < nb.length; i++) {
        var n = nb[i], nc = ui.best[idx(n.c, n.r)];
        if (nc < 99 && Math.abs(nc + step - cb) < 1e-4) { next = n; break; }
      }
      if (!next) break;
      cur = next;
    }
    if (!ok) return false;
    u.c = dest.c; u.r = dest.r;
    u.mp = Math.max(0, u.mp - d);
    u.fort = false;
    GK.sfx.jump();
    computeVisibility();
    selectUnit(u);
    return true;
  }

  /* ============================ combat ============================ */
  function effAtk(u) {
    var p = G.players[u.owner], st = UNITS[u.type];
    var a = st.atk * (u.hp / u.maxHp);
    if (has(p, 'bronze-working')) a *= 1.25;
    if (has(p, 'iron-working')) a += 2;
    return a;
  }

  function effDef(u, t) {
    var p = G.players[u.owner], st = UNITS[u.type];
    var d = st.def * (u.hp / u.maxHp);
    d *= 1 + (TER[t.terr].def || 0);
    if (u.fort) d *= 1.25;
    if (has(p, 'bronze-working')) d *= 1.1;
    if (has(p, 'iron-working')) d += 1;
    return d;
  }

  function adjacentEnemies(u) {
    var out = [], nb = neighbours(G, G.tiles[idx(u.c, u.r)]);
    for (var i = 0; i < nb.length; i++) {
      var t = nb[i];
      if (t.city && G.cityById[t.city].owner !== u.owner) { out.push(t); continue; }
      var d = unitAt(t.c, t.r);
      if (d && d.owner !== u.owner) out.push(t);
    }
    return out;
  }

  function attackTile(u, t) {
    if (u.mp <= 0) return false;
    if (dist(u.c, u.r, t.c, t.r) !== 1) return false;
    var city = t.city ? G.cityById[t.city] : null;
    if (city && city.owner !== u.owner) return attackCity(u, city, unitAt(t.c, t.r));
    var def = unitAt(t.c, t.r);
    if (!def || def.owner === u.owner) return false;

    var a = effAtk(u) * GK.rr(G.rng, 0.92, 1.08);
    var d = effDef(def, t) * GK.rr(G.rng, 0.92, 1.08);
    var dmgD = GK.clamp(Math.round(22 * a / Math.max(0.5, d)), 3, 40);
    var dmgA = GK.clamp(Math.round(16 * d / Math.max(0.5, a)), 2, 30);
    def.hp -= dmgD;
    u.hp -= dmgA;
    u.mp = 0;
    GK.sfx.hit();
    if (def.hp <= 0) {
      killUnit(def);
      logMsg((u.owner === 1 ? 'Killed ' : 'Rival kills ') + UNITS[def.type].name);
      if (u.type !== 'settler') {
        // melee units advance into the vacated tile
        if (!t.city && !unitAt(t.c, t.r)) { u.c = t.c; u.r = t.r; }
      }
    }
    if (u.hp <= 0) killUnit(u);
    computeVisibility();
    if (u.owner === 1 && !G.over) selectUnit(unitById(u.id));
    return true;
  }

  function attackCity(u, city, defender) {
    var t = G.tiles[idx(city.c, city.r)];
    var a = effAtk(u) * GK.rr(G.rng, 0.92, 1.08);
    var defVal = (6 + city.pop * 0.5 + (city.buildings.walls ? 6 : 0)) * (1 + TER[t.terr].def);
    if (has(G.players[city.owner], 'masonry')) defVal += 3;
    var dmg = GK.clamp(Math.round(18 * a / Math.max(1, defVal)), 4, 30);
    var back = GK.clamp(Math.round(12 * defVal / Math.max(0.5, a)), 2, 22);
    city.hp -= dmg;
    u.hp -= back;
    u.mp = 0;
    GK.sfx.boom();
    logMsg((u.owner === 1 ? 'Assault on ' : 'Rival assaults ') + city.name + ' — ' + Math.max(0, Math.round(city.hp)) + ' def left');
    if (city.hp <= 0) captureCity(city, u.owner, defender);
    if (u.hp <= 0) killUnit(u);
    computeVisibility();
    if (u.owner === 1 && !G.over) selectUnit(unitById(u.id));
    checkEnd();
    return true;
  }

  function killUnit(u) {
    var i = G.units.indexOf(u);
    if (i >= 0) G.units.splice(i, 1);
    if (ui.selId === u.id) { ui.selId = 0; ui.best = null; ui.reach = null; }
  }

  function captureCity(city, owner, defender) {
    var loser = city.owner;
    city.owner = owner;
    city.pop = Math.max(1, Math.floor(city.pop / 2));
    city.hp = 8;
    city.queue.length = 0;
    city.held = null;
    city.maxHp = cityHP(city);
    if (defender) killUnit(defender);
    claimTiles(city);
    computeCity(city);
    logMsg(city.name + ' captured by ' + (owner === 1 ? 'you' : 'the rival'));
    if (owner === 1) GK.sfx.win(); else GK.sfx.hurt();
    if (ui.cityId === city.id) ui.panel = null;
    if (loser === 1) { ui.selId = 0; ui.best = null; ui.reach = null; }
  }

  /* ============================ player actions ============================ */
  function foundWith(u) {
    if (!u || u.owner !== 1 || u.type !== 'settler') return false;
    if (!canFoundAt(u.c, u.r, 1)) { logMsg('Cannot found here — need open land, 3 tiles from a city'); return false; }
    foundCity(1, u.c, u.r, cityName(1));
    killUnit(u);
    computeVisibility();
    ui.selId = 0; ui.best = null; ui.reach = null;
    GK.sfx.coin();
    checkEnd();
    return true;
  }

  function buildRoadWith(u) {
    if (!u || u.owner !== 1 || u.type !== 'worker') return false;
    var t = G.tiles[idx(u.c, u.r)];
    if (!TER[t.terr].land || TER[t.terr].imp) return false;
    if (t.road === 1) { logMsg('Road already here'); return false; }
    t.road = 1;
    u.mp = 0;
    bakeMap();
    GK.sfx.coin();
    logMsg('Road built — connect two cities for trade gold');
    selectUnit(u);
    return true;
  }

  function fortify(u) {
    if (!u || u.owner !== 1) return false;
    u.fort = true; u.mp = 0;
    GK.sfx.hit();
    selectUnit(u);
    return true;
  }

  /* ============================ turn economy ============================ */
  function income(owner) {
    var p = G.players[owner], d = DIFF[G.diff];
    var mult = owner === 2 ? d.aiProd : 1;
    var sciMult = owner === 2 ? d.aiSci : 1;
    var gold = 0, sci = 0;
    var cs = citiesOf(owner);
    for (var i = 0; i < cs.length; i++) {
      var city = cs[i], y = computeCity(city);
      p.gold += y.g; gold += y.g;
      p.progress += y.s * sciMult;
      sci += y.s * sciMult;

      city.food += y.f - city.pop;
      var need = 10 + city.pop * 6;
      while (city.food >= need) {
        city.food -= need;
        city.pop++;
        need = 10 + city.pop * 6;
        if (owner === 1) logMsg(city.name + ' grows to ' + city.pop);
      }
      if (city.food < 0) city.food = 0;

      city.prod += y.p * mult;
      finishQueue(city, owner);
    }
    var pairs = tradeRoutes(owner);
    p.trade = pairs;
    var tg = pairs * (has(p, 'currency') ? 4 : 2);
    p.gold += tg; gold += tg;
    p.goldNow = Math.round(gold);
    p.sci = Math.round(sci * 10) / 10;
    checkTech(p);
    for (var k = 0; k < G.cities.length; k++) {
      var ci = G.cities[k];
      if (ci.owner === owner) {
        ci.maxHp = cityHP(ci);
        ci.hp = Math.min(ci.maxHp, ci.hp + 3);
      }
    }
  }

  function finishQueue(city, owner) {
    var guard = 0;
    while (city.queue.length && guard++ < 4) {
      var id = city.queue[0], item = BUILDS[id];
      if (city.prod + 1e-9 < item.cost) break;
      if (id === 'settler' && city.pop < 2) break;
      if (item.kind === 'unit' && !spawnTile(city)) break;   // hold production until a tile opens
      city.prod -= item.cost;
      city.queue.shift();
      complete(city, id, owner);
    }
  }

  function complete(city, id, owner) {
    var item = BUILDS[id];
    if (item.kind === 'unit') {
      var t = spawnTile(city) || G.tiles[idx(city.c, city.r)];
      var u = spawnUnit(owner, id, t.c, t.r);
      u.mp = 0;
      if (id === 'settler') city.pop = Math.max(1, city.pop - 1);
      if (owner === 1) logMsg(city.name + ' built ' + item.name);
    } else {
      city.buildings[id] = true;
      city.maxHp = cityHP(city);
      city.hp = city.maxHp;
      if (owner === 1) logMsg(city.name + ' built ' + item.name);
    }
    computeCity(city);
  }

  function checkTech(p) {
    var guard = 0;
    while (p.research && guard++ < 3) {
      var t = TECH_BY[p.research], cost = techCost(p, t.id);
      if (p.progress < cost) break;
      p.progress -= cost;
      p.techs[t.id] = true;
      p.lastTech = t.id;
      p.research = chooseResearch(p);
      if (p.id === 1) { logMsg('Research complete: ' + t.name + ' — ' + t.era); GK.sfx.unlock(); }
    }
    if (p.progress < 0) p.progress = 0;
  }

  function healUnits(owner) {
    var us = unitsOf(owner);
    for (var i = 0; i < us.length; i++) {
      var u = us[i], t = G.tiles[idx(u.c, u.r)];
      var inCity = t.city && G.cityById[t.city].owner === owner;
      if (u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + (inCity ? 3 : 1));
      u.mp = u.maxMoves;
      u.fort = false;
    }
  }

  function endTurn() {
    if (!G || G.over) return false;
    income(1);
    income(2);
    aiTurn();
    if (G.roadDirty) { bakeMap(); G.roadDirty = false; }
    if (G.over) return true;
    checkEnd();
    if (G.over) return true;
    if (G.turn >= MAX_TURN) { finishByScore(); return true; }
    G.turn++;
    healUnits(1);
    healUnits(2);
    computeVisibility();
    try { GK.store('tessera').set('turn', G.turn); } catch (e) {}
    selectFirstUnit();
    if (G.turn === 12 || G.turn === 40) logMsg('Turn ' + G.turn + ' — the rival is expanding');
    return true;
  }

  /* ============================ AI ============================ */
  /* The rival researches down the same tree, one column at a time. */
  function aiResearch() {
    var p = G.players[2];
    if (p.research && !p.techs[p.research]) return p.research;
    return chooseResearch(p);
  }

  /* Rival unit choice: cheapest thing that works early, then a mixed army — the real
   * roster is dominated by siege/naval-free ranged units (Catapult atk 11 beats the
   * Swordsman's 11 on cost), so without a mix the rival builds nothing but catapults. */
  function aiMilPick() {
    if (G.turn < 20 && BUILDS.warrior) return 'warrior';
    var p = G.players[2], i;
    var bestM = null, bmA = -1, bestR = null, bR = -1;
    for (i = 0; i < UNIT_ORDER.length; i++) {
      var id = UNIT_ORDER[i], st = UNITS[id];
      if (!st || st.role === 'civ') continue;
      if (!has(p, BUILDS[id].tech)) continue;
      var sc = st.atk + (st.role === 'mounted' ? 2 : 0);
      if (st.ranged) { if (sc > bR) { bR = sc; bestR = id; } }
      else if (sc > bmA) { bmA = sc; bestM = id; }
    }
    var ranged = 0, total = 0, us = unitsOf(2);
    for (i = 0; i < us.length; i++) {
      if (!UNITS[us[i].type] || UNITS[us[i].type].role === 'civ') continue;
      total++;
      if (UNITS[us[i].type].ranged) ranged++;
    }
    if (bestR && (ranged < total * 0.5 || !bestM)) return bestR;
    return bestM || bestR || 'warrior';
  }

  function aiTurn() {
    var p = G.players[2];
    if (!p.research) p.research = aiResearch();
    var cs = citiesOf(2), i;
    for (i = 0; i < cs.length; i++) aiQueue(cs[i]);

    var us = unitsOf(2);
    for (i = 0; i < us.length; i++) { us[i].mp = UNITS[us[i].type].mv; us[i].fort = false; }
    for (i = 0; i < us.length; i++) {
      if (G.over) return;
      aiUnit(us[i]);
    }
    computeVisibility();
  }

  function aiQueue(city) {
    if (city.queue.length) return;
    var cs = citiesOf(2), us = unitsOf(2);
    var target = G.diff === 'hard' ? 6 : G.diff === 'normal' ? 5 : 3;
    var mil = 0, settlers = 0, workers = 0;
    function isMil(id) { return !!BUILDS[id] && BUILDS[id].kind === 'unit' && UNITS[id] && UNITS[id].role !== 'civ'; }
    for (var i = 0; i < us.length; i++) {
      if (isMil(us[i].type)) mil++;
      if (us[i].type === 'settler') settlers++;
      if (us[i].type === 'worker') workers++;
    }
    for (i = 0; i < city.queue.length; i++) {
      if (isMil(city.queue[i])) mil++;
      if (city.queue[i] === 'settler') settlers++;
      if (city.queue[i] === 'worker') workers++;
    }
    if (cs.length < target && settlers === 0 && BUILDS.settler) { city.queue.push('settler'); return; }
    // military ramps with time so the opening is not a rush, then tracks the empire
    if (mil < Math.min(cs.length + 3, 2 + Math.floor(G.turn / 5))) { city.queue.push(aiMilPick()); return; }
    if (workers < Math.min(2, cs.length) && BUILDS.worker) { city.queue.push('worker'); return; }
    var p = G.players[2];
    var want = ['granary', 'workshop', 'market', 'walls'];
    for (i = 0; i < want.length; i++) {
      var wid = want[i], wi = BUILDS[wid];
      if (wi && !city.buildings[wid] && (!wi.tech || has(p, wi.tech))) { city.queue.push(wid); return; }
    }
    /* Nothing on the want list is available: reinforce, but respect the army cap
     * (each city queues independently, so an uncapped fallback swarms the map). */
    if (mil < Math.min(cs.length + 4, 4 + Math.floor(G.turn / 4))) city.queue.push(aiMilPick());
  }

  function power(owner) {
    var us = unitsOf(owner), s = 0;
    for (var i = 0; i < us.length; i++) {
      if (us[i].type === 'settler' || us[i].type === 'worker') continue;
      s += UNITS[us[i].type].atk * (us[i].hp / us[i].maxHp);
    }
    return s;
  }

  function aiUnit(u) {
    if (G.units.indexOf(u) < 0) return;   // died earlier in the same turn
    if (u.type === 'settler') { aiSettler(u); return; }
    if (u.type === 'worker') { aiWorker(u); return; }
    if (u.type === 'scout') { aiScout(u); return; }
    if (UNITS[u.type] && UNITS[u.type].role === 'civ') { aiWorker(u); return; }
    aiWarrior(u);
  }

  function aiSettler(u) {
    if (canFoundAt(u.c, u.r, 2)) {
      foundCity(2, u.c, u.r, cityName(2));
      killUnit(u);
      return;
    }
    var spot = bestSettleSpot(u);
    if (spot) moveToward(u, spot.c, spot.r);
    if (canFoundAt(u.c, u.r, 2)) {
      foundCity(2, u.c, u.r, cityName(2));
      killUnit(u);
    }
  }

  function bestSettleSpot(u) {
    var cs = citiesOf(2), best = null, bs = -1e9;
    for (var i = 0; i < cs.length; i++) {
      var cands = tilesInRadius(G, G.tiles[idx(cs[i].c, cs[i].r)], 8);
      for (var k = 0; k < cands.length; k++) {
        var t = cands[k];
        if (!canFoundAt(t.c, t.r, 2)) continue;
        if (unitAt(t.c, t.r) && unitAt(t.c, t.r) !== u) continue;
        var s = 0, ring = neighbours(G, t), food = 0, prod = 0;
        for (var j = 0; j < ring.length; j++) {
          if (!TER[ring[j].terr].land || TER[ring[j].terr].imp) continue;
          var y = tileYield(ring[j]);
          food += y.f; prod += y.p;
        }
        s = food * 1.4 + prod * 1.1;
        // prefer sites away from the player's border
        var pd = 99;
        var pcs = citiesOf(1);
        for (j = 0; j < pcs.length; j++) pd = Math.min(pd, dist(t.c, t.r, pcs[j].c, pcs[j].r));
        s += Math.min(pd, 8) * 0.9;
        s -= dist(t.c, t.r, u.c, u.r) * 0.25;
        if (s > bs) { bs = s; best = t; }
      }
    }
    return best;
  }

  function aiWorker(u) {
    var cs = citiesOf(2);
    if (cs.length < 2) { wander(u); return; }
    // walk toward the midpoint between two cities, paving as it goes
    var a = cs[0], b = null, bd = 1e9;
    for (var i = 1; i < cs.length; i++) {
      var d = dist(a.c, a.r, cs[i].c, cs[i].r);
      if (d < bd && d > 2) { bd = d; b = cs[i]; }
    }
    if (!b) b = cs[1];
    var mid = { c: Math.round((a.c + b.c) / 2), r: Math.round((a.r + b.r) / 2) };
    var t = G.tiles[idx(u.c, u.r)];
    if (t.road !== 2 && TER[t.terr].land && !TER[t.terr].imp) { t.road = 2; G.roadDirty = true; }
    var md = G.tiles[idx(GK.clamp(mid.c, 1, COLS - 2), GK.clamp(mid.r, 1, ROWS - 2))];
    if (!TER[md.terr].land) md = G.tiles[idx(b.c, b.r)];
    moveToward(u, md.c, md.r);
    var t2 = G.tiles[idx(u.c, u.r)];
    if (t2.road !== 2 && TER[t2.terr].land && !TER[t2.terr].imp) { t2.road = 2; G.roadDirty = true; }
  }

  function aiScout(u) {
    // head for the nearest land tile the rival has not touched
    var best = null, bs = 1e9;
    for (var i = 0; i < 24; i++) {
      var r = GK.ri(G.rng, 1, ROWS - 2), c = GK.ri(G.rng, 1, COLS - 2);
      var t = G.tiles[idx(c, r)];
      if (!TER[t.terr].land || TER[t.terr].imp) continue;
      if (t.owner === 2) continue;
      var d = dist(u.c, u.r, c, r);
      if (d < bs && d > 1) { bs = d; best = t; }
    }
    if (best) moveToward(u, best.c, best.r); else wander(u);
  }

  function wander(u) {
    var nb = neighbours(G, G.tiles[idx(u.c, u.r)]);
    for (var i = 0; i < nb.length; i++) {
      var n = nb[(i + u.id) % nb.length];
      if (TER[n.terr].land && !TER[n.terr].imp && !unitAt(n.c, n.r)) { moveToward(u, n.c, n.r); return; }
    }
  }

  function aiWarrior(u) {
    var d = DIFF[G.diff];
    var adjacent = adjacentEnemies(u);
    // defend: hit anything threatening a city
    for (var i = 0; i < adjacent.length; i++) {
      var t = adjacent[i];
      var city = t.city ? G.cityById[t.city] : null;
      if (city) { attackTile(u, t); break; }
      var e = unitAt(t.c, t.r);
      if (e && effAtk(u) * 0.9 >= effDef(e, t)) { attackTile(u, t); return; }
    }
    var aiPow = power(2), plPow = power(1);
    var aggressive = aiPow >= plPow * (1.35 / d.aggro);
    /* The rival builds and expands first; campaigning opens in the second third of the
     * 80 turns. With the real roster it fields mounted units (Chariot Archer on The
     * Wheel, Horseman on Horseback Riding) by the mid-teens, so a turn-10 rush would
     * be unwinnable for anyone who spent the opening on economy. */
    var rushTurn = G.diff === 'hard' ? 18 : G.diff === 'easy' ? 36 : 28;
    if (G.turn < rushTurn) aggressive = false;
    if (G.turn > 20 && G.diff === 'hard') aggressive = true;

    if (aggressive) {
      var target = weakestPlayerCity();
      if (target) {
        moveToward(u, target.c, target.r);
        var adj2 = adjacentEnemies(u);
        for (var k = 0; k < adj2.length; k++) {
          var c2 = adj2[k].city ? G.cityById[adj2[k].city] : null;
          if (c2 && c2.id === target.id && aiPow > power(1) * 0.9) { attackTile(u, adj2[k]); return; }
        }
        return;
      }
    }
    // garrison the AI city with the fewest defenders
    var city = thinCity(2);
    if (city) {
      if (u.c === city.c && u.r === city.r) { u.fort = true; u.mp = 0; return; }
      moveToward(u, city.c, city.r);
      if (u.c === city.c && u.r === city.r) { u.fort = true; u.mp = 0; }
    }
  }

  function weakestPlayerCity() {
    var cs = citiesOf(1), best = null, bs = 1e9;
    for (var i = 0; i < cs.length; i++) {
      var s = cs[i].hp;
      var us = unitsOf(1);
      for (var j = 0; j < us.length; j++) if (dist(us[j].c, us[j].r, cs[i].c, cs[i].r) <= 2) s += UNITS[us[j].type].def * 2;
      if (s < bs) { bs = s; best = cs[i]; }
    }
    return best;
  }

  function thinCity(owner) {
    var cs = citiesOf(owner), us = unitsOf(owner), best = null, bn = 99;
    for (var i = 0; i < cs.length; i++) {
      var n = 0;
      for (var j = 0; j < us.length; j++) if (dist(us[j].c, us[j].r, cs[i].c, cs[i].r) <= 1) n++;
      if (n < bn) { bn = n; best = cs[i]; }
    }
    return best;
  }

  function findPath(u, tc, tr) {
    var start = idx(u.c, u.r), goal = idx(tc, tr);
    if (start === goal) return [];
    var prev = new Int32Array(COLS * ROWS);
    for (var i = 0; i < prev.length; i++) prev[i] = -2;
    prev[start] = -1;
    var q = [start], head = 0;
    while (head < q.length) {
      var cur = q[head++];
      if (cur === goal) break;
      var t = G.tiles[cur], nb = neighbours(G, t);
      for (var k = 0; k < nb.length; k++) {
        var n = nb[k], ni = idx(n.c, n.r);
        if (prev[ni] !== -2) continue;
        if (!TER[n.terr].land && !(has(G.players[u.owner], 'sailing') && n.coast)) continue;
        if (TER[n.terr].imp) continue;
        if (n.city && G.cityById[n.city].owner !== u.owner && ni !== goal) continue;
        if (ni !== goal && unitAt(n.c, n.r)) continue;
        prev[ni] = cur;
        q.push(ni);
      }
    }
    if (prev[goal] === -2) return null;
    var out = [], cur2 = goal, guard = 0;
    while (cur2 !== start && cur2 !== -1 && guard++ < 80) {
      out.unshift(G.tiles[cur2]);
      cur2 = prev[cur2];
    }
    return out;
  }

  function moveToward(u, tc, tr) {
    var path = findPath(u, tc, tr);
    if (!path || !path.length) return false;
    for (var i = 0; i < path.length; i++) {
      var n = path[i];
      if (unitAt(n.c, n.r)) break;   // one unit per tile, even at the goal
      var cost = moveCost(u, n);
      if (cost > u.mp + 1e-6) break;
      u.c = n.c; u.r = n.r; u.mp -= cost;
      if (n.c === tc && n.r === tr) break;
    }
    return true;
  }

  /* ============================ scoring / end ============================ */
  function scoreOf(owner) {
    var cs = citiesOf(owner), pop = 0, i;
    for (i = 0; i < cs.length; i++) pop += cs[i].pop;
    var tiles = 0;
    for (i = 0; i < G.tiles.length; i++) if (G.tiles[i].owner === owner) tiles++;
    var p = G.players[owner], techs = 0;
    for (var k in p.techs) if (p.techs[k]) techs++;
    return {
      cities: cs.length, pop: pop, techs: techs, tiles: tiles, trade: p.trade,
      gold: Math.floor(p.gold),
      total: cs.length * 12 + techs * 8 + pop * 4 + Math.floor(p.gold / 10) + Math.floor(tiles / 2) + p.trade * 2
    };
  }

  function finishByScore() {
    var a = scoreOf(1), b = scoreOf(2);
    if (a.total >= b.total) finish('win', 'Highest score at turn ' + MAX_TURN);
    else finish('lose', 'The rival scores higher at turn ' + MAX_TURN);
  }

  function checkEnd() {
    if (!G || G.over) return;
    if (citiesOf(2).length === 0) { finish('win', 'Rival eliminated'); return; }
    if (citiesOf(1).length === 0) {
      var hasSettler = false, us = unitsOf(1);
      for (var i = 0; i < us.length; i++) if (us[i].type === 'settler') hasSettler = true;
      if (!hasSettler) finish('lose', 'Your last city has fallen');
    }
  }

  function finish(result, reason) {
    if (G.over) return;
    G.over = true;
    G.result = result;
    G.reason = reason;
    ui.panel = null;
    ui.screen = 'over';
    var sc = scoreOf(1);
    try {
      var st = GK.store('tessera');
      var best = st.get('best', 0) || 0;
      G.newBest = sc.total > best;
      if (sc.total > best) st.set('best', sc.total);
      st.set('lastSeed', G.seed);
    } catch (e) {}
    if (result === 'win') GK.sfx.win(); else GK.sfx.lose();
  }

  /* ============================ drawing: map ============================ */
  var bake = null, bctx = null;
  var BAKE = 1.2;
  var HITS = [];
  var TAU = Math.PI * 2;

  function hit(x, y, w, h, id, arg) { HITS.push({ x: x, y: y, w: w, h: h, id: id, arg: arg }); }
  function hitAt(px, py) {
    for (var i = HITS.length - 1; i >= 0; i--) {
      var r = HITS[i];
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return r;
    }
    return null;
  }

  function bakeMap() {
    if (!bake) { bake = document.createElement('canvas'); bctx = bake.getContext('2d'); }
    if (!G) return;
    bake.width = Math.ceil(MAP_W * BAKE);
    bake.height = Math.ceil(MAP_H * BAKE);
    bctx.setTransform(BAKE, 0, 0, BAKE, 0, 0);
    bctx.fillStyle = '#08131b';
    bctx.fillRect(0, 0, MAP_W, MAP_H);

    var i, t, x, y, k;
    for (i = 0; i < G.tiles.length; i++) {
      t = G.tiles[i];
      x = cxp(t.c, t.r); y = cyp(t.c, t.r);
      hexPath(bctx, x, y);
      bctx.fillStyle = GK.shade(TER[t.terr].color, t.shade);
      bctx.fill();
      bctx.strokeStyle = 'rgba(0,0,0,.22)';
      bctx.lineWidth = 1;
      bctx.stroke();

      // per-tile texture marks (deterministic, baked once)
      var pts = t.pts;
      if (t.terr === 'ocean') {
        bctx.strokeStyle = 'rgba(120,190,220,.10)';
        bctx.lineWidth = 1.2;
        for (k = 0; k + 2 < pts.length; k += 3) {
          bctx.beginPath();
          bctx.moveTo(x + pts[k] * HEX_W * 0.5, y + pts[k + 1] * HEX_R);
          bctx.lineTo(x + pts[k] * HEX_W * 0.5 + 7, y + pts[k + 1] * HEX_R);
          bctx.stroke();
        }
      } else if (t.terr === 'forest') {
        for (k = 0; k + 2 < pts.length; k += 3) {
          var fx = x + pts[k] * HEX_W * 0.42, fy = y + pts[k + 1] * HEX_R * 0.8;
          bctx.fillStyle = 'rgba(10,32,20,.55)';
          bctx.beginPath();
          bctx.moveTo(fx, fy - 6); bctx.lineTo(fx + 3.6, fy + 2); bctx.lineTo(fx - 3.6, fy + 2);
          bctx.closePath(); bctx.fill();
        }
      } else if (t.terr === 'hills') {
        bctx.strokeStyle = 'rgba(255,235,190,.10)';
        bctx.lineWidth = 1.4;
        for (k = 0; k + 2 < pts.length; k += 3) {
          var hx = x + pts[k] * HEX_W * 0.4, hy = y + pts[k + 1] * HEX_R * 0.7;
          bctx.beginPath(); bctx.arc(hx, hy, 4.2, Math.PI * 0.15, Math.PI * 0.85); bctx.stroke();
        }
      } else if (t.terr === 'mountain') {
        bctx.fillStyle = 'rgba(18,18,24,.55)';
        bctx.beginPath();
        bctx.moveTo(x - 11, y + 7); bctx.lineTo(x - 2, y - 11); bctx.lineTo(x + 6, y + 7);
        bctx.closePath(); bctx.fill();
        bctx.fillStyle = 'rgba(215,220,235,.22)';
        bctx.beginPath();
        bctx.moveTo(x - 2, y - 11); bctx.lineTo(x + 1, y - 5); bctx.lineTo(x - 5, y - 5);
        bctx.closePath(); bctx.fill();
      } else if (t.terr === 'desert') {
        bctx.fillStyle = 'rgba(255,235,190,.07)';
        for (k = 0; k + 2 < pts.length; k += 3) bctx.fillRect(x + pts[k] * HEX_W * 0.4, y + pts[k + 1] * HEX_R * 0.7, 3, 1.4);
      } else {
        bctx.fillStyle = 'rgba(180,220,150,.10)';
        for (k = 0; k + 2 < pts.length; k += 3) {
          bctx.beginPath();
          bctx.arc(x + pts[k] * HEX_W * 0.42, y + pts[k + 1] * HEX_R * 0.7, pts[k + 2] * 0.5, 0, TAU);
          bctx.fill();
        }
      }
    }

    // beach line where land meets water
    for (i = 0; i < G.tiles.length; i++) {
      t = G.tiles[i];
      if (!TER[t.terr].land) continue;
      var nb = neighbours(G, t), wet = false;
      for (k = 0; k < nb.length; k++) if (nb[k].terr === 'ocean') wet = true;
      if (!wet) continue;
      hexPath(bctx, cxp(t.c, t.r), cyp(t.c, t.r));
      bctx.strokeStyle = 'rgba(226,202,140,.20)';
      bctx.lineWidth = 2.4;
      bctx.stroke();
    }

    // roads sit on top of terrain
    for (i = 0; i < G.tiles.length; i++) {
      t = G.tiles[i];
      if (!t.road) continue;
      var nb2 = neighbours(G, t);
      x = cxp(t.c, t.r); y = cyp(t.c, t.r);
      for (k = 0; k < nb2.length; k++) {
        var n = nb2[k];
        if (!n.road || idx(n.c, n.r) < i) continue;
        bctx.strokeStyle = '#6d5730';
        bctx.lineWidth = 4.5;
        bctx.beginPath(); bctx.moveTo(x, y); bctx.lineTo(cxp(n.c, n.r), cyp(n.c, n.r)); bctx.stroke();
        bctx.strokeStyle = '#b99a5c';
        bctx.lineWidth = 1.4;
        bctx.beginPath(); bctx.moveTo(x, y); bctx.lineTo(cxp(n.c, n.r), cyp(n.c, n.r)); bctx.stroke();
      }
      bctx.fillStyle = '#b99a5c';
      bctx.beginPath(); bctx.arc(x, y, 2.6, 0, TAU); bctx.fill();
    }

    // resource markers
    for (i = 0; i < G.tiles.length; i++) {
      t = G.tiles[i];
      if (!t.res) continue;
      x = cxp(t.c, t.r); y = cyp(t.c, t.r) - 3;
      if (t.res === 'grain') {
        bctx.fillStyle = '#e8c46a';
        for (k = -1; k <= 1; k++) { bctx.beginPath(); bctx.arc(x + k * 3.4, y - Math.abs(k) * 1.6, 1.7, 0, TAU); bctx.fill(); }
      } else if (t.res === 'ore') {
        bctx.fillStyle = '#9aa4b8';
        bctx.beginPath(); bctx.moveTo(x, y - 5); bctx.lineTo(x + 4.6, y + 3); bctx.lineTo(x - 4.6, y + 3);
        bctx.closePath(); bctx.fill();
      } else {
        bctx.fillStyle = '#8fd0e8';
        bctx.beginPath(); bctx.moveTo(x, y - 5); bctx.lineTo(x + 3.6, y); bctx.lineTo(x, y + 5); bctx.lineTo(x - 3.6, y);
        bctx.closePath(); bctx.fill();
      }
    }
  }

  function drawMap(ctx, view, t) {
    ctx.save();
    ctx.translate(view.w / 2, view.h / 2);
    ctx.scale(cam.z, cam.z);
    ctx.translate(-cam.x, -cam.y);
    if (bake) ctx.drawImage(bake, 0, 0, MAP_W, MAP_H);

    var left = cam.x - view.w / (2 * cam.z) - HEX_W;
    var right = cam.x + view.w / (2 * cam.z) + HEX_W;
    var top = cam.y - view.h / (2 * cam.z) - HEX_R;
    var bot = cam.y + view.h / (2 * cam.z) + HEX_R;
    var sel = ui.selId ? unitById(ui.selId) : null;
    var k, t2;

    for (var i = 0; i < G.tiles.length; i++) {
      t2 = G.tiles[i];
      var x = cxp(t2.c, t2.r), y = cyp(t2.c, t2.r);
      if (x < left || x > right || y < top || y > bot) continue;

      if (!t2.explored) {
        hexPath(ctx, x, y);
        ctx.fillStyle = '#080b10';
        ctx.fill();
        continue;
      }
      if (!t2.vis) {
        hexPath(ctx, x, y);
        ctx.fillStyle = 'rgba(9,13,19,.55)';
        ctx.fill();
      }
      if (t2.owner) {
        hexPath(ctx, x, y);
        ctx.fillStyle = t2.owner === 1 ? 'rgba(240,180,41,.10)' : 'rgba(209,87,63,.10)';
        ctx.fill();
      }
      if (ui.reach && ui.reach[i]) {
        hexPath(ctx, x, y);
        ctx.fillStyle = 'rgba(240,180,41,.14)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, TAU);
        ctx.fillStyle = 'rgba(240,180,41,.55)';
        ctx.fill();
      }
      if (sel && ui.reach && ui.reach[i] && (t2.city || unitAt(t2.c, t2.r))) {
        hexPath(ctx, x, y);
        ctx.strokeStyle = 'rgba(224,90,74,.85)';
        ctx.lineWidth = 2 / cam.z;
        ctx.stroke();
      }
    }

    // selected hex ring + neighbours that can be attacked
    if (sel) {
      var sx = cxp(sel.c, sel.r), sy = cyp(sel.c, sel.r);
      hexPath(ctx, sx, sy);
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2.5 / cam.z;
      ctx.stroke();
      var adj = adjacentEnemies(sel);
      for (k = 0; k < adj.length; k++) {
        hexPath(ctx, cxp(adj[k].c, adj[k].r), cyp(adj[k].c, adj[k].r));
        ctx.strokeStyle = 'rgba(224,90,74,' + (0.55 + 0.35 * Math.sin(t * 4)) + ')';
        ctx.lineWidth = 2 / cam.z;
        ctx.stroke();
      }
    }

    drawCityMarkers(ctx, t);
    drawUnits(ctx, view, t, left, right, top, bot);
    ctx.restore();

    drawCityLabels(ctx, view);
  }

  function drawCityMarkers(ctx, t) {
    for (var i = 0; i < G.cities.length; i++) {
      var c = G.cities[i], tl = G.tiles[idx(c.c, c.r)];
      if (!tl.explored) continue;
      var x = cxp(c.c, c.r), y = cyp(c.c, c.r);
      var col = c.owner === 1 ? P1 : P2;
      hexPath(ctx, x, y);
      ctx.fillStyle = c.owner === 1 ? 'rgba(240,180,41,.22)' : 'rgba(209,87,63,.22)';
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 2 / Math.max(0.4, cam.z);
      ctx.stroke();

      // little city block glyph
      ctx.fillStyle = col;
      ctx.fillRect(x - 7, y - 2, 5, 8);
      ctx.fillRect(x - 1, y - 6, 5, 12);
      ctx.fillRect(x + 5, y + 1, 4, 5);
      ctx.fillStyle = 'rgba(10,14,20,.55)';
      ctx.fillRect(x + 0.6, y - 3.5, 2.4, 2);
      ctx.fillRect(x - 5, y + 1, 2.2, 2);

      // population badge
      ctx.beginPath();
      ctx.arc(x + 9, y - 9, 7, 0, TAU);
      ctx.fillStyle = '#0e1116';
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      txt(ctx, String(c.pop), x + 9, y - 8.6, 12, INK, 'center', 700);

      // damage bar
      if (c.hp < c.maxHp) {
        var frac = Math.max(0, c.hp / c.maxHp);
        ctx.fillStyle = 'rgba(0,0,0,.55)';
        ctx.fillRect(x - 12, y + 12, 24, 3);
        ctx.fillStyle = frac > 0.5 ? '#6fd08a' : '#e0574a';
        ctx.fillRect(x - 12, y + 12, 24 * frac, 3);
      }
    }
  }

  function drawUnits(ctx, view, t, left, right, top, bot) {
    for (var i = 0; i < G.units.length; i++) {
      var u = G.units[i];
      var x = cxp(u.c, u.r), y = cyp(u.c, u.r);
      if (x < left || x > right || y < top || y > bot) continue;
      var t2 = G.tiles[idx(u.c, u.r)];
      if (u.owner !== 1 && !t2.vis && !t2.explored) continue;
      var col = u.owner === 1 ? P1 : P2;
      var sel = ui.selId === u.id;

      ctx.beginPath();
      ctx.arc(x, y + 1, HEX_R * 0.40, 0, TAU);
      ctx.fillStyle = sel ? 'rgba(30,24,10,.95)' : 'rgba(10,14,20,.90)';
      ctx.fill();
      ctx.strokeStyle = sel ? ACCENT : col;
      ctx.lineWidth = sel ? 2.4 : 1.6;
      ctx.stroke();

      drawGlyph(ctx, u.type, x, y + 1, col);

      if (u.hp < u.maxHp) {
        var frac = Math.max(0, u.hp / u.maxHp);
        ctx.fillStyle = 'rgba(0,0,0,.6)';
        ctx.fillRect(x - 9, y + 11, 18, 2.6);
        ctx.fillStyle = frac > 0.5 ? '#6fd08a' : '#e0574a';
        ctx.fillRect(x - 9, y + 11, 18 * frac, 2.6);
      }
      if (u.owner === 1) {
        // remaining-move pips
        if (u.mp > 0.01) {
          ctx.fillStyle = 'rgba(240,180,41,.9)';
          for (var k = 0; k < Math.ceil(u.mp); k++) {
            ctx.beginPath();
            ctx.arc(x - 4 + k * 4, y - 11, 1.4, 0, TAU);
            ctx.fill();
          }
        }
        if (u.fort) {
          ctx.strokeStyle = 'rgba(240,180,41,.8)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(x - 8, y - 9); ctx.lineTo(x - 8, y - 14); ctx.lineTo(x - 3, y - 14);
          ctx.stroke();
        }
      }
    }
  }

  function drawGlyph(ctx, type, x, y, col) {
    var g = (UNITS[type] && UNITS[type].glyph) || 'melee';
    ctx.fillStyle = col;
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'round';
    if (g === 'melee') {
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x + 5, y - 3.5);
      ctx.lineTo(x + 4.2, y + 2.5);
      ctx.lineTo(x, y + 6);
      ctx.lineTo(x - 4.2, y + 2.5);
      ctx.lineTo(x - 5, y - 3.5);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(14,17,22,.75)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 3.5); ctx.stroke();
    } else if (g === 'scout') {
      ctx.beginPath();
      ctx.moveTo(x - 5, y - 4); ctx.lineTo(x, y + 1); ctx.lineTo(x + 5, y - 4);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 5, y + 1); ctx.lineTo(x, y + 6); ctx.lineTo(x + 5, y + 1);
      ctx.stroke();
    } else if (g === 'worker') {
      ctx.fillRect(x - 4.5, y - 4, 9, 2.4);
      ctx.beginPath(); ctx.moveTo(x, y - 1.6); ctx.lineTo(x, y + 5); ctx.stroke();
      ctx.fillRect(x - 1.6, y + 3.6, 3.4, 2);
    } else if (g === 'ranged') {
      // bow: an arc and a drawn string
      ctx.beginPath(); ctx.arc(x - 1, y, 5.4, -Math.PI * 0.62, Math.PI * 0.62); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 1 + 5.4 * Math.cos(-Math.PI * 0.62), y + 5.4 * Math.sin(-Math.PI * 0.62));
      ctx.lineTo(x + 2, y); ctx.lineTo(x - 1 + 5.4 * Math.cos(Math.PI * 0.62), y + 5.4 * Math.sin(Math.PI * 0.62));
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + 1, y); ctx.lineTo(x + 5, y); ctx.stroke();
    } else if (g === 'mounted') {
      // hoofprint chevron: fast
      ctx.beginPath(); ctx.moveTo(x - 5, y + 3); ctx.lineTo(x, y - 5); ctx.lineTo(x + 5, y + 3); ctx.stroke();
      ctx.fillRect(x - 5.5, y + 3.6, 4, 2);
      ctx.fillRect(x + 1.5, y + 3.6, 4, 2);
    } else {
      // settler: little wagon
      ctx.beginPath(); ctx.arc(x - 3, y + 3, 2.2, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(x + 3, y + 3, 2.2, 0, TAU); ctx.fill();
      ctx.fillRect(x - 5.5, y - 5, 11, 6);
      ctx.fillStyle = 'rgba(14,17,22,.8)';
      ctx.fillRect(x - 2.5, y - 3.4, 5, 2.4);
    }
    ctx.lineCap = 'butt';
  }

  function worldToScreen(c, r, view) {
    return {
      x: (cxp(c, r) - cam.x) * cam.z + view.w / 2,
      y: (cyp(c, r) - cam.y) * cam.z + view.h / 2
    };
  }

  function drawCityLabels(ctx, view) {
    for (var i = 0; i < G.cities.length; i++) {
      var c = G.cities[i], tl = G.tiles[idx(c.c, c.r)];
      if (!tl.explored) continue;
      var s = worldToScreen(c.c, c.r, view);
      if (s.x < -30 || s.x > view.w + 30 || s.y < 40 || s.y > view.h - 90) continue;
      var label = c.name;
      ctx.font = '600 12px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
      var tw = ctx.measureText(label).width;
      var bx = s.x, by = s.y - 28 * Math.max(0.55, cam.z) - 6;
      ctx.fillStyle = 'rgba(10,14,20,.78)';
      rrect(ctx, bx - tw / 2 - 5, by - 8, tw + 10, 16, 4);
      ctx.fill();
      txt(ctx, label, bx, by, 12, c.owner === 1 ? P1 : P2, 'center', 600);
    }
  }

  /* ============================ minimap ============================ */
  function miniRect(view) {
    var mw = Math.min(92, view.w * 0.25), mh = mw * (MAP_H / MAP_W);
    return { x: 10, y: view.h - 88 - mh - 10, w: mw, h: mh };
  }

  function drawMinimap(ctx, view) {
    var m = miniRect(view);
    var sx = m.w / MAP_W, sy = m.h / MAP_H;
    ctx.fillStyle = 'rgba(8,12,18,.86)';
    rrect(ctx, m.x - 2, m.y - 2, m.w + 4, m.h + 4, 6);
    ctx.fill();
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1;
    rrect(ctx, m.x - 2, m.y - 2, m.w + 4, m.h + 4, 6);
    ctx.stroke();

    for (var i = 0; i < G.tiles.length; i++) {
      var t = G.tiles[i];
      if (!t.explored) continue;
      var x = m.x + cxp(t.c, t.r) * sx, y = m.y + cyp(t.c, t.r) * sy;
      ctx.fillStyle = GK.shade(TER[t.terr].color, t.vis ? 8 : -12);
      ctx.fillRect(x - 2.4, y - 2.4, 5, 5);
    }
    for (i = 0; i < G.cities.length; i++) {
      var c = G.cities[i], tl = G.tiles[idx(c.c, c.r)];
      if (!tl.explored) continue;
      ctx.fillStyle = c.owner === 1 ? P1 : P2;
      ctx.fillRect(m.x + cxp(c.c, c.r) * sx - 2, m.y + cyp(c.c, c.r) * sy - 2, 4.5, 4.5);
    }
    // viewport rectangle
    var vw = (view.w / cam.z) * sx, vh = ((view.h - 140) / cam.z) * sy;
    var vx = m.x + cam.x * sx - vw / 2, vy = m.y + cam.y * sy - vh / 2;
    ctx.strokeStyle = 'rgba(240,180,41,.75)';
    ctx.lineWidth = 1;
    ctx.strokeRect(vx, vy, vw, vh);
    hit(m.x - 4, m.y - 4, m.w + 8, m.h + 8, 'minimap');
  }

  /* ============================ drawing: HUD ============================ */
  function computeStats() {
    if (!G) return;
    var p = G.players[1], cs = citiesOf(1);
    var food = 0, prod = 0, gold = 0, sci = 0;
    for (var i = 0; i < cs.length; i++) {
      var y = computeCity(cs[i]);
      food += y.f - cs[i].pop; prod += y.p; gold += y.g; sci += y.s;
    }
    gold += p.trade * (has(p, 'currency') ? 4 : 2);
    G.stats = {
      food: Math.round(food * 10) / 10, prod: Math.round(prod * 10) / 10,
      gold: Math.round(gold), sci: Math.round(sci * 10) / 10,
      cities: cs.length, units: unitsOf(1).length
    };
  }

  function chip(ctx, x, y, label, id, arg, filled) {
    ctx.font = '700 13px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
    var w = ctx.measureText(label).width + 22;
    rrect(ctx, x, y, w, 32, 8);
    if (filled) { ctx.fillStyle = ACCENT; ctx.fill(); }
    else {
      ctx.fillStyle = 'rgba(240,180,41,.10)'; ctx.fill();
      ctx.strokeStyle = 'rgba(240,180,41,.55)'; ctx.lineWidth = 1; ctx.stroke();
    }
    txt(ctx, label, x + w / 2, y + 16.5, 13, filled ? '#131722' : ACCENT, 'center', 700);
    hit(x, y, w, 32, id, arg);
    return w;
  }

  function drawHud(ctx, view, t) {
    var w = view.w, h = view.h, p = G.players[1];
    var st = G.stats || { food: 0, prod: 0, gold: 0, sci: 0, cities: 0, units: 0 };

    /* -- top bar -- */
    ctx.fillStyle = '#0b0f15';
    ctx.fillRect(0, 0, w, 62);
    ctx.fillStyle = LINE; ctx.fillRect(0, 61, w, 1);

    var cw = w / 4;
    var cols = [
      ['TURN', G.turn + '/' + MAX_TURN, INK],
      ['GOLD', fmt(p.gold), ACCENT],
      ['SCIENCE', sign(st.sci), '#7fc8f0'],
      ['FOOD', sign(st.food), '#7fd08a']
    ];
    for (var i = 0; i < 4; i++) {
      var x = 10 + i * cw;
      txt(ctx, cols[i][0], x, 13, 12, MUTED, 'left', 600);
      txt(ctx, cols[i][1], x, 31, 16, cols[i][2], 'left', 700, cw - 14);
    }

    var tech = p.research ? TECH_BY[p.research] : null;
    var tname = tech ? tech.name : 'All techs researched';
    txt(ctx, tname, 10, 47, 12, tech ? INK : MUTED, 'left', 600, w - 130);
    if (tech) {
      var tcost = techCost(p, tech.id);
      txt(ctx, Math.floor(p.progress) + '/' + tcost, w - 14, 47, 12, ACCENT, 'right', 700);
      var frac = GK.clamp(p.progress / tcost, 0, 1);
      ctx.fillStyle = 'rgba(255,255,255,.08)';
      ctx.fillRect(10, 55, w - 20, 3);
      ctx.fillStyle = ACCENT;
      ctx.fillRect(10, 55, (w - 20) * frac, 3);
    }
    hit(0, 0, w, 62, 'techpanel');

    /* -- bottom bar -- */
    var by = h - 88;
    ctx.fillStyle = '#0b0f15';
    ctx.fillRect(0, by, w, 88);
    ctx.fillStyle = LINE; ctx.fillRect(0, by, w, 1);

    var sel = ui.selId ? unitById(ui.selId) : null;
    var ebw = 80, ebx = w - ebw - 12;        // end-turn button owns the right column
    if (sel) {
      txt(ctx, UNITS[sel.type].name.toUpperCase(), 12, by + 16, 12, ACCENT, 'left', 700);
      txt(ctx, 'HP ' + Math.max(0, Math.round(sel.hp)) + '/' + sel.maxHp + '   MP ' + (Math.round(sel.mp * 10) / 10) + '/' + sel.maxMoves,
        12 + 78, by + 16, 12, MUTED, 'left', 600, ebx - 90);
      var cx2 = 12;
      if (sel.type === 'settler') cx2 += chip(ctx, cx2, by + 34, 'Found City', 'act', 'found', true) + 8;
      if (sel.type === 'worker') cx2 += chip(ctx, cx2, by + 34, 'Build Road', 'act', 'road', true) + 8;
      if (UNITS[sel.type].role !== 'civ') cx2 += chip(ctx, cx2, by + 34, sel.fort ? 'Fortified' : 'Fortify', 'act', 'fort', false) + 8;
      if (cx2 < ebx - 66) chip(ctx, cx2, by + 34, 'Next', 'act', 'next', false);
    } else {
      txt(ctx, 'Tap a unit or city', 14, by + 26, 14, INK, 'left', 600);
      txt(ctx, 'Tap a tile to inspect · drag to pan', 14, by + 50, 12, MUTED, 'left', 600, ebx - 26);
    }

    // end turn: outlined while anything can still move, solid once the turn is spent
    var anyMoves = false, us = unitsOf(1);
    for (i = 0; i < us.length; i++) if (us[i].mp > 0.01) anyMoves = true;
    rrect(ctx, ebx, by + 12, ebw, 64, 12);
    if (anyMoves) {
      ctx.fillStyle = 'rgba(240,180,41,.12)'; ctx.fill();
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.5; ctx.stroke();
      txt(ctx, 'END', ebx + ebw / 2, by + 36, 16, ACCENT, 'center', 700);
      txt(ctx, 'TURN', ebx + ebw / 2, by + 55, 12, ACCENT, 'center', 700);
    } else {
      ctx.fillStyle = ACCENT; ctx.fill();
      txt(ctx, 'END', ebx + ebw / 2, by + 36, 16, '#131722', 'center', 700);
      txt(ctx, 'TURN', ebx + ebw / 2, by + 55, 12, '#131722', 'center', 700);
    }
    hit(ebx, by + 12, ebw, 64, 'endturn');

    // zoom + menu
    var zx = w - 46, zy = by - 96;
    rrect(ctx, zx, zy, 36, 36, 8);
    ctx.fillStyle = 'rgba(20,26,35,.9)'; ctx.fill();
    ctx.strokeStyle = LINE; ctx.lineWidth = 1; ctx.stroke();
    txt(ctx, '+', zx + 18, zy + 19, 20, INK, 'center', 600);
    hit(zx, zy, 36, 36, 'zoom', 1);

    rrect(ctx, zx, zy + 42, 36, 36, 8);
    ctx.fillStyle = 'rgba(20,26,35,.9)'; ctx.fill();
    ctx.strokeStyle = LINE; ctx.stroke();
    ctx.fillStyle = INK;            // drawn, not typeset: a minus glyph is not universal
    ctx.fillRect(zx + 11, zy + 59, 14, 2.5);
    hit(zx, zy + 42, 36, 36, 'zoom', -1);

    rrect(ctx, zx, zy - 46, 36, 36, 8);
    ctx.fillStyle = 'rgba(20,26,35,.9)'; ctx.fill();
    ctx.strokeStyle = LINE; ctx.stroke();
    for (i = 0; i < 3; i++) { ctx.fillStyle = INK; ctx.fillRect(zx + 10, zy - 34 + i * 7, 16, 2); }
    hit(zx, zy - 46, 36, 36, 'menu');

    drawMinimap(ctx, view);
    drawToast(ctx, view);
  }

  function drawToast(ctx, view) {
    if (ui.toastT <= 0 || !ui.toast) return;
    var a = GK.clamp(ui.toastT * 2, 0, 1);
    ctx.globalAlpha = a;
    ctx.font = '600 12px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
    var tw = Math.min(view.w - 40, ctx.measureText(ui.toast).width + 24);
    var x = view.w / 2 - tw / 2;
    ctx.fillStyle = 'rgba(10,14,20,.92)';
    rrect(ctx, x, 70, tw, 26, 8); ctx.fill();
    ctx.strokeStyle = 'rgba(240,180,41,.35)'; ctx.lineWidth = 1; rrect(ctx, x, 70, tw, 26, 8); ctx.stroke();
    txt(ctx, ui.toast, view.w / 2, 83.5, 12, INK, 'center', 600, tw - 16);
    ctx.globalAlpha = 1;
  }

  /* ============================ panels ============================ */
  function drawPanel(ctx, view, t) {
    ctx.fillStyle = 'rgba(6,8,12,.74)';
    ctx.fillRect(0, 0, view.w, view.h);
    hit(0, 0, view.w, view.h, 'block');
    var x = 8, y = 62, w = view.w - 16, h = view.h - 62 - 96;

    ctx.fillStyle = PANEL;
    rrect(ctx, x, y, w, h, 12); ctx.fill();
    ctx.strokeStyle = LINE; ctx.lineWidth = 1; rrect(ctx, x, y, w, h, 12); ctx.stroke();
    hit(x, y, w, h, 'panelbody');

    var title = '', sub = '';
    if (ui.panel === 'tech') { title = 'Research'; sub = TECHS.length + ' technologies · ' + TECH_ERAS.length + ' eras · tap one to study'; }
    else if (ui.panel === 'city') {
      var c = G.cityById[ui.cityId];
      title = c ? c.name : 'City';
      sub = c ? 'Population ' + c.pop + ' · Garrison ' + Math.max(0, Math.round(c.hp)) + '/' + c.maxHp : '';
    } else if (ui.panel === 'unit') {
      var su = ui.selId ? unitById(ui.selId) : null;
      title = su ? UNITS[su.type].name : 'Unit';
      sub = su ? 'Turn ' + G.turn + ' · ' + (Math.round(su.mp * 10) / 10) + ' moves left' : '';
    } else if (ui.panel === 'menu') {
      title = 'Paused';
      sub = (G.civs ? G.civs[1].name + ' vs ' + G.civs[2].name + ' · ' : '') + 'Seed ' + G.seed + ' · ' + DIFF[G.diff].label;
    }
    else if (ui.panel === 'help') { title = 'How to play'; sub = 'Four actions win an empire'; }

    txt(ctx, title, x + 14, y + 22, 17, INK, 'left', 700, w - 70);
    txt(ctx, sub, x + 14, y + 40, 12, MUTED, 'left', 600, w - 60);

    rrect(ctx, x + w - 40, y + 8, 30, 30, 8);
    ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.fill();
    txt(ctx, 'X', x + w - 25, y + 23, 14, INK, 'center', 700);
    hit(x + w - 42, y + 6, 34, 34, 'close');

    if (ui.panel === 'tech') drawTechList(ctx, x, y + 50, w, h - 60);
    else if (ui.panel === 'unit') drawUnitPanel(ctx, x, y + 50, w, h - 60);
    else if (ui.panel === 'city') drawCityPanel(ctx, x, y + 50, w, h - 60);
    else if (ui.panel === 'menu') drawMenu(ctx, x, y + 56, w, h - 66);
    else drawHelp(ctx, x, y + 56, w, h - 66);
  }

  var CREDIT = 'Technology tables: Unciv contributors (MPL-2.0), Civ V rule set';

  /* single-line truncation that measures before it cuts */
  function fitText(ctx, s, maxW, size, weight) {
    ctx.font = (weight || 500) + ' ' + size + 'px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
    if (ctx.measureText(s).width <= maxW) return s;
    var lo = 0, hi = s.length;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(s.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
    }
    return s.slice(0, Math.max(0, lo - 1)).replace(/[\s,;:.-]+$/, '') + '…';
  }

  /* The tree in column order, with an era header wherever the era changes. */
  function techFlow() {
    var flow = [], era = null;
    for (var i = 0; i < TECHS.length; i++) {
      var t = TECHS[i];
      if (t.era !== era) { era = t.era; flow.push({ era: era }); }
      flow.push({ t: t });
    }
    return flow;
  }

  /* Greedy page packing: era headers cost headH, tech rows rowH. A page that opens
     mid-era repeats the era header so a row is never orphaned. */
  function paginate(flow, availH, headH, rowH) {
    var pages = [], page = [], used = 0;
    for (var i = 0; i < flow.length; i++) {
      var ih = flow[i].era ? headH : rowH;
      if (page.length && used + ih > availH) { pages.push(page); page = []; used = 0; }
      if (!page.length && !flow[i].era) { page.push({ era: flow[i].t.era }); used += headH; }
      page.push(flow[i]);
      used += ih;
    }
    if (page.length) pages.push(page);
    return pages.length ? pages : [[]];
  }

  function eraLine(ctx, x, y, w, era, p) {
    var done = 0, tot = 0;
    for (var k = 0; k < TECHS.length; k++) {
      if (TECHS[k].era !== era) continue;
      tot++;
      if (p.techs[TECHS[k].id]) done++;
    }
    txt(ctx, era.toUpperCase() + '   ' + done + '/' + tot, x + 14, y + 9, 10, ACCENT, 'left', 700, w - 28);
    ctx.fillStyle = 'rgba(240,180,41,.20)';
    ctx.fillRect(x + 14, y + 17, w - 28, 1);
  }

  function drawTechList(ctx, x, y, w, h) {
    var p = G.players[1];

    /* --- era + real Civ V quote of what is being studied --- */
    var cur = p.research ? TECH_BY[p.research] : null;
    var show = cur || (p.lastTech ? TECH_BY[p.lastTech] : null) || TECHS[0];
    if (!show) return;
    txt(ctx, String(show.era || '').toUpperCase(), x + 14, y + 7, 11, ACCENT, 'left', 700, w - 100);
    txt(ctx, cur ? 'Studying · ' + Math.floor(p.progress) + '/' + techCost(p, cur.id) : 'All techs known',
      x + w - 14, y + 7, 11, cur ? MUTED : '#7fd08a', 'right', 600, w * 0.5);
    var quote = show.quote ? '\u201c' + show.quote + '\u201d' : (show.eff || '');
    if (quote) txt(ctx, fitText(ctx, quote, w - 28, 11, 500), x + 14, y + 23, 11, MUTED, 'left', 500, w - 28);
    ctx.fillStyle = 'rgba(255,255,255,.06)';
    ctx.fillRect(x + 14, y + 34, w - 28, 1);

    /* --- the tree, paged --- */
    var footH = 16, navH = 34, rowH = 34, headH = 20;
    var listTop = y + 40;
    var listH = Math.max(rowH, (y + h - footH - navH) - listTop);
    var pages = paginate(techFlow(), listH, headH, rowH);
    if (ui.techPage > pages.length - 1) ui.techPage = pages.length - 1;
    if (ui.techPage < 0) ui.techPage = 0;
    if (ui.techJump) {
      ui.techJump = false;
      var want = cur ? cur.id : null;
      for (var wI = 0; wI < TECHS.length && !want; wI++) if (techAvailable(p, TECHS[wI])) want = TECHS[wI].id;
      ui.techPage = 0;
      for (var pi = 0; pi < pages.length && want; pi++) {
        for (var pj = 0; pj < pages[pi].length; pj++) {
          if (pages[pi][pj].t && pages[pi][pj].t.id === want) { ui.techPage = pi; break; }
        }
      }
    }
    if (ui.techPage > pages.length - 1) ui.techPage = pages.length - 1;
    var page = pages[ui.techPage], yy = listTop;

    for (var i = 0; i < page.length; i++) {
      var it = page[i];
      if (it.era) { eraLine(ctx, x, yy, w, it.era, p); yy += headH; continue; }
      var t = it.t;
      var done = !!p.techs[t.id];
      var isCur = p.research === t.id;
      var open = !done && techAvailable(p, t);

      if (isCur) { ctx.fillStyle = 'rgba(240,180,41,.10)'; ctx.fillRect(x + 6, yy + 1, w - 12, rowH - 2); }
      if (isCur) { ctx.fillStyle = ACCENT; ctx.fillRect(x + 6, yy + 1, 3, rowH - 2); }

      var col = done ? '#7fd08a' : open ? INK : 'rgba(139,149,165,.72)';
      txt(ctx, t.name, x + 16, yy + rowH * 0.34, 14, col, 'left', 700, w - 110);
      if (t.eff) txt(ctx, t.eff, x + 16, yy + rowH * 0.70, 11, done ? 'rgba(139,149,165,.8)' : MUTED, 'left', 500, w - 106);

      var right;
      if (done) right = 'done';
      else if (isCur) right = Math.floor(p.progress) + '/' + techCost(p, t.id);
      else if (open) right = String(techCost(p, t.id));
      else right = 'locked';
      txt(ctx, right, x + w - 16, yy + rowH * 0.5, 12,
        done ? '#7fd08a' : isCur ? ACCENT : open ? MUTED : 'rgba(139,149,165,.55)', 'right', 700, 76);

      if (open) hit(x + 6, yy, w - 12, rowH, 'tech', t.id);
      yy += rowH;
    }

    /* --- pager --- */
    if (pages.length > 1) {
      var ny = y + h - footH - navH + 4;
      txt(ctx, '‹', x + 24, ny + 13, 20, ui.techPage > 0 ? ACCENT : 'rgba(139,149,165,.35)', 'center', 700);
      hit(x + 8, ny, 36, 30, 'techprev');
      txt(ctx, (ui.techPage + 1) + ' / ' + pages.length, x + w / 2, ny + 13, 12, MUTED, 'center', 600);
      txt(ctx, '›', x + w - 24, ny + 13, 20, ui.techPage < pages.length - 1 ? ACCENT : 'rgba(139,149,165,.35)', 'center', 700);
      hit(x + w - 44, ny, 36, 30, 'technext');
    }

    txt(ctx, CREDIT, x + w / 2, y + h - 8, 9, 'rgba(139,149,165,.75)', 'center', 500, w - 20);
  }

  function cityBuildList(p, city) {
    var out = [];
    for (var i = 0; i < BUILD_ORDER.length; i++) {
      var id = BUILD_ORDER[i], item = BUILDS[id];
      if (!item) continue;
      if (item.tech && !p.techs[item.tech]) continue;        // gated by research
      if (item.kind === 'b' && city.buildings[id]) continue;  // already standing
      out.push(id);
    }
    return out;
  }

  function drawCityPanel(ctx, x, y, w, h) {
    var city = G.cityById[ui.cityId];
    if (!city) return;
    var yv = computeCity(city);
    var p = G.players[1];

    txt(ctx, 'Food ' + sign(yv.f) + '   Prod ' + sign(yv.p) + '   Gold ' + sign(yv.g) + '   Sci ' + sign(yv.s),
      x + 14, y + 12, 12, INK, 'left', 600, w - 28);

    // growth + queue
    var need = 10 + city.pop * 6;
    txt(ctx, 'Growth ' + Math.floor(city.food) + '/' + need, x + 14, y + 32, 12, MUTED, 'left', 600);
    var q = city.queue.length ? city.queue[0] : null;
    var qi = q ? BUILDS[q] : null;
    txt(ctx, q ? 'Building ' + qi.name + ' ' + Math.floor(city.prod) + '/' + qi.cost : 'Idle — pick a build',
      x + w - 14, y + 32, 12, q ? ACCENT : MUTED, 'right', 600, w - 120);
    if (q) {
      ctx.fillStyle = 'rgba(255,255,255,.08)';
      ctx.fillRect(x + 14, y + 42, w - 28, 3);
      ctx.fillStyle = ACCENT;
      ctx.fillRect(x + 14, y + 42, (w - 28) * GK.clamp(city.prod / qi.cost, 0, 1), 3);
    }

    // chip row: queue control + any unit parked in the city
    var chipX = x + 14;
    if (q) chipX += chip(ctx, chipX, y + 50, 'Clear queue', 'clearq', 0, false) + 8;
    var gu = unitAt(city.c, city.r);
    if (gu && gu.owner === 1) chip(ctx, chipX, y + 50, 'Unit: ' + UNITS[gu.type].name, 'selectunit', 0, false);

    /* The build list is everything the research has unlocked: real Civ V units with
     * their real strengths and real buildings, filtered by the techs this player has. */
    var list = cityBuildList(p, city);
    var top = y + 90;
    var navH = list.length > 6 ? 30 : 0;
    var availH = (y + h - top - 6 - navH);
    var rowH = GK.clamp(availH / Math.max(1, Math.min(list.length, 9)), 30, 44);
    var rows = Math.max(1, Math.floor(availH / rowH));
    var pages = Math.max(1, Math.ceil(list.length / rows));
    if (ui.buildPage > pages - 1) ui.buildPage = pages - 1;
    if (ui.buildPage < 0) ui.buildPage = 0;
    var lo = ui.buildPage * rows, hi = Math.min(list.length, lo + rows);

    for (var i = lo; i < hi; i++) {
      var id = list[i], item = BUILDS[id], ry = top + (i - lo) * rowH;
      var noPop = id === 'settler' && city.pop < 2;
      var col = noPop ? MUTED : INK;

      txt(ctx, item.name, x + 16, ry + rowH * 0.34, 14, col, 'left', 700, w * 0.5);
      txt(ctx, item.desc, x + 16, ry + rowH * 0.70, 12, noPop ? 'rgba(139,149,165,.65)' : MUTED, 'left', 500, w * 0.66);

      var est = noPop ? 'needs pop 2'
        : item.cost + '  ~' + Math.max(1, Math.ceil((item.cost - Math.min(city.prod, item.cost)) / Math.max(0.5, yv.p))) + 't';
      txt(ctx, est, x + w - 16, ry + rowH * 0.5, 12, noPop ? MUTED : ACCENT, 'right', 700, w * 0.32);

      if (!noPop) hit(x + 6, ry, w - 12, rowH - 2, 'build', id);
      ctx.fillStyle = 'rgba(255,255,255,.05)';
      ctx.fillRect(x + 16, ry + rowH - 1, w - 32, 1);
    }

    if (!list.length) {
      txt(ctx, 'Nothing to build yet — research unlocks units and buildings.',
        x + 16, top + 20, 12, MUTED, 'left', 600, w - 32);
    }

    if (navH) {
      var ny = y + h - navH + 2;
      if (pages > 1) {
        txt(ctx, '‹', x + 26, ny + 13, 18, ui.buildPage > 0 ? ACCENT : 'rgba(139,149,165,.35)', 'center', 700);
        hit(x + 10, ny, 34, 26, 'buildprev');
        txt(ctx, '›', x + w - 26, ny + 13, 18, ui.buildPage < pages - 1 ? ACCENT : 'rgba(139,149,165,.35)', 'center', 700);
        hit(x + w - 44, ny, 34, 26, 'buildnext');
      }
      txt(ctx, (pages > 1 ? (ui.buildPage + 1) + ' / ' + pages + '   ' : '') + list.length + ' available',
        x + w / 2, ny + 13, 11, MUTED, 'center', 600);
    }
  }

  function drawUnitPanel(ctx, x, y, w, h) {
    var u = ui.selId ? unitById(ui.selId) : null;
    if (!u) {
      txt(ctx, 'No unit selected — tap one on the map', x + 16, y + 26, 13, MUTED, 'left', 600, w - 32);
      return;
    }
    var st = UNITS[u.type], tl = G.tiles[idx(u.c, u.r)];
    txt(ctx, 'HP ' + Math.max(0, Math.round(u.hp)) + '/' + u.maxHp + '   MOVES ' +
      (Math.round(u.mp * 10) / 10) + '/' + u.maxMoves, x + 16, y + 14, 13, INK, 'left', 700, w - 32);
    txt(ctx, 'Attack ' + Math.round(effAtk(u)) + '  ·  Defence ' + Math.round(effDef(u, tl)) + (u.fort ? ' (fortified)' : ''),
      x + 16, y + 36, 12, MUTED, 'left', 600, w - 32);
    txt(ctx, TER[tl.terr].name + (tl.road === 1 ? ' · your road' : tl.road === 2 ? ' · rival road' : '') +
      ' · sight ' + st.sight, x + 16, y + 56, 12, MUTED, 'left', 600, w - 32);

    var rows = [];
    if (u.type === 'settler') rows.push(['Found city here', 'found']);
    if (u.type === 'worker') rows.push([tl.road === 1 ? 'Road already here' : 'Build road', 'road']);
    if (st.role !== 'civ') rows.push([u.fort ? 'Fortified — tap to wake' : 'Fortify', 'fort']);
    rows.push(['Next unit with moves', 'next']);

    var top = y + 76;
    for (var i = 0; i < rows.length && top + i * 46 < y + h; i++) {
      var ry = top + i * 46;
      ctx.fillStyle = 'rgba(255,255,255,.04)';
      rrect(ctx, x + 8, ry, w - 16, 40, 8); ctx.fill();
      txt(ctx, rows[i][0], x + 24, ry + 20, 14, ACCENT, 'left', 700, w - 60);
      hit(x + 8, ry, w - 16, 40, 'act', rows[i][1]);
    }
  }

  function menuRow(ctx, x, y, w, label, id, val) {
    var h = 46;
    ctx.fillStyle = 'rgba(255,255,255,.04)';
    rrect(ctx, x + 6, y, w - 12, h - 6, 8); ctx.fill();
    txt(ctx, label, x + 20, y + (h - 6) / 2, 14, INK, 'left', 600);
    if (val) txt(ctx, val, x + w - 20, y + (h - 6) / 2, 13, ACCENT, 'right', 700);
    hit(x + 6, y, w - 12, h - 6, id);
    return h;
  }

  function drawMenu(ctx, x, y, w, h) {
    var yy = y;
    yy += menuRow(ctx, x, yy, w, 'Resume', 'resume');
    yy += menuRow(ctx, x, yy, w, 'Restart (same seed)', 'restart');
    yy += menuRow(ctx, x, yy, w, 'How to play', 'help');
    yy += menuRow(ctx, x, yy, w, 'Sound', 'sound', GK.sfx.enabled ? 'on' : 'off');
    yy += menuRow(ctx, x, yy, w, 'Quit to title', 'quit');
  }

  function drawHelp(ctx, x, y, w, h) {
    var lines = [
      ['GOAL', 'Score more than the rival at turn 80, or take every enemy city.'],
      ['FOUND', 'Select the Settler, tap Found City. Cities work the 6 tiles around them.'],
      ['BUILD', 'Tap a city to add units and buildings to its queue.'],
      ['MOVE', 'Tap a unit, then tap a highlighted hex. Tap a red-ringed enemy to attack.'],
      ['ROAD', 'Workers lay roads. Two cities joined by road earn trade gold every turn.'],
      ['RESEARCH', 'Tap the top bar. 74 Civ V techs, era by era, decide what you can build.'],
      ['FIGHT', 'Terrain defence, fortify and Walls decide assaults. Cities heal each turn.'],
      ['TURN', 'End Turn runs the rival’s move. Movement resets at the start of each turn.']
    ];
    var rowH = Math.min(58, h / lines.length);
    for (var i = 0; i < lines.length; i++) {
      var ry = y + i * rowH;
      txt(ctx, lines[i][0], x + 16, ry + 12, 12, ACCENT, 'left', 700);
      txt(ctx, lines[i][1], x + 16, ry + 30, 12, INK, 'left', 500, w - 32);
    }
  }

  /* ============================ title ============================ */
  function seedPreview() {
    var s = parseInt(ui.seedText, 10);
    if (!s || s < 0) s = 20261028;
    return s;
  }

  function drawTitle(ctx, view, t) {
    var w = view.w, h = view.h;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    // faint hex field background
    for (var i = -1; i < 6; i++) {
      for (var j = -1; j < 9; j++) {
        var hx = HEX_W * (i + 0.5 * (j & 1)) + 30, hy = HEX_H * j + 20;
        hexPath(ctx, hx, hy);
        ctx.strokeStyle = 'rgba(240,180,41,.045)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    var cx = w / 2;
    var y = Math.max(52, h * 0.10);

    // logo: nested hexes
    var R1 = 30;
    hexPath(ctx, cx, y + R1);
    ctx.fillStyle = 'rgba(240,180,41,.10)'; ctx.fill();
    ctx.strokeStyle = ACCENT; ctx.lineWidth = 2.5; ctx.stroke();
    hexPath(ctx, cx, y + R1);
    ctx.save(); ctx.translate(cx, y + R1); ctx.scale(0.55, 0.55); ctx.translate(-cx, -(y + R1));
    hexPath(ctx, cx, y + R1);
    ctx.strokeStyle = 'rgba(240,180,41,.5)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
    txt(ctx, 'T', cx, y + R1 + 1, 22, ACCENT, 'center', 800);

    y += R1 * 2 + 16;
    // letterspaced wordmark
    var word = 'TESSERA', fs = Math.min(34, w * 0.095), spacing = fs * 0.16;
    ctx.font = '800 ' + fs + 'px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
    var totalW = 0;
    for (i = 0; i < word.length; i++) totalW += ctx.measureText(word[i]).width + spacing;
    totalW -= spacing;
    var px = cx - totalW / 2;
    for (i = 0; i < word.length; i++) {
      ctx.font = '800 ' + fs + 'px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
      ctx.fillStyle = INK;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(word[i], px, y);
      px += ctx.measureText(word[i]).width + spacing;
    }
    y += fs * 0.9;

    txt(ctx, 'A 4X in your pocket — one rival, eighty turns.', cx, y, 13, MUTED, 'center', 500, w - 40);
    y += 20;

    /* The two powers this seed deals out, straight from the nations table. */
    var prePair = civPair(seedPreview());
    if (prePair) {
      txt(ctx, 'You   ' + prePair[0].name + ' · ' + prePair[0].leader, cx, y, 11, ACCENT, 'center', 600, w - 40);
      txt(ctx, 'Rival   ' + prePair[1].name + ' · ' + prePair[1].leader, cx, y + 14, 11, P2, 'center', 600, w - 40);
    }
    y += 32;

    // seed row
    txt(ctx, 'SEED', 16, y + 16, 12, MUTED, 'left', 600);
    var sw = w - 140;
    rrect(ctx, 56, y, sw, 34, 8);
    ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fill();
    ctx.strokeStyle = LINE; ctx.lineWidth = 1; ctx.stroke();
    txt(ctx, ui.keypad ? ui.seedText + '|' : ui.seedText, 68, y + 17, 15, INK, 'left', 700, sw - 24);
    hit(56, y, sw, 34, 'seedbox');
    chip(ctx, w - 78, y + 1, 'Random', 'random', 0, false);
    y += 46;

    // difficulty
    txt(ctx, 'RIVAL', 16, y + 15, 12, MUTED, 'left', 600);
    var dx = 62, dw = (w - 74) / 3;
    var diffs = ['easy', 'normal', 'hard'];
    for (i = 0; i < 3; i++) {
      var on = ui.diff === diffs[i];
      rrect(ctx, dx + i * (dw + 4), y, dw, 32, 8);
      ctx.fillStyle = on ? 'rgba(240,180,41,.16)' : 'rgba(255,255,255,.04)'; ctx.fill();
      ctx.strokeStyle = on ? ACCENT : LINE; ctx.lineWidth = on ? 1.5 : 1; ctx.stroke();
      txt(ctx, DIFF[diffs[i]].label, dx + i * (dw + 4) + dw / 2, y + 16.5, 12, on ? ACCENT : MUTED, 'center', 700);
      hit(dx + i * (dw + 4), y, dw, 32, 'diff', diffs[i]);
    }
    y += 54;

    // start
    var bw = w - 52, bh = 54, bx = 26;
    rrect(ctx, bx, y, bw, bh, 12);
    ctx.fillStyle = ACCENT; ctx.fill();
    txt(ctx, 'START GAME', cx, y + bh / 2 + 1, 17, '#131722', 'center', 800);
    hit(bx, y, bw, bh, 'start');
    y += bh + 14;

    txt(ctx, 'How to play', cx, y + 12, 13, ACCENT, 'center', 600);
    hit(cx - 70, y - 2, 140, 28, 'help');

    var best = 0;
    try { best = store.get('best', 0) || 0; } catch (e) { best = 0; }
    txt(ctx, best ? 'Best score ' + best : 'No score recorded yet', cx, h - 26, 12, MUTED, 'center', 600);
    txt(ctx, CREDIT, cx, h - 45, 9, 'rgba(139,149,165,.72)', 'center', 500, w - 20);

    if (ui.keypad) drawKeypad(ctx, view);
  }

  function drawKeypad(ctx, view) {
    var w = view.w;
    ctx.fillStyle = 'rgba(6,8,12,.85)';
    ctx.fillRect(0, 0, w, view.h);
    var pw = Math.min(300, w - 32), ph = 330, x = (w - pw) / 2, y = (view.h - ph) / 2;
    ctx.fillStyle = PANEL;
    rrect(ctx, x, y, pw, ph, 14); ctx.fill();
    ctx.strokeStyle = LINE; ctx.stroke();
    txt(ctx, 'Map seed', x + 18, y + 24, 15, INK, 'left', 700);
    txt(ctx, ui.seedText, x + pw - 18, y + 24, 14, ACCENT, 'right', 700);

    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];
    var kw = (pw - 36 - 16) / 3, kh = 44;
    for (var i = 0; i < keys.length; i++) {
      var c = i % 3, r = Math.floor(i / 3);
      var kx = x + 18 + c * (kw + 8), ky = y + 44 + r * (kh + 8);
      var k = keys[i];
      var filled = k === 'ok';
      rrect(ctx, kx, ky, kw, kh, 8);
      ctx.fillStyle = filled ? ACCENT : 'rgba(255,255,255,.06)'; ctx.fill();
      ctx.strokeStyle = filled ? ACCENT : LINE; ctx.lineWidth = 1; ctx.stroke();
      var lbl = k === 'del' ? 'DEL' : k === 'ok' ? 'OK' : k;
      txt(ctx, lbl, kx + kw / 2, ky + kh / 2, 15, filled ? '#131722' : INK, 'center', 700);
      hit(kx, ky, kw, kh, 'key', k);
    }
  }

  /* ============================ game over ============================ */
  function drawOver(ctx, view, t) {
    var w = view.w, h = view.h;
    ctx.fillStyle = 'rgba(8,11,16,.88)';
    ctx.fillRect(0, 0, w, h);
    hit(0, 0, w, h, 'block');
    var win = G.result === 'win';
    var col = win ? ACCENT : '#e0574a';
    var y = Math.max(46, h * 0.10);

    txt(ctx, win ? 'VICTORY' : 'DEFEAT', w / 2, y + 18, 32, col, 'center', 800);
    txt(ctx, G.reason, w / 2, y + 46, 13, MUTED, 'center', 500, w - 40);
    y += 78;

    var a = scoreOf(1), b = scoreOf(2);
    var rows = [
      ['Cities', a.cities + '  x12', a.cities * 12],
      ['Techs', a.techs + '  x8', a.techs * 8],
      ['Population', a.pop + '  x4', a.pop * 4],
      ['Gold', a.gold + '  /10', Math.floor(a.gold / 10)],
      ['Tiles', a.tiles + '  /2', Math.floor(a.tiles / 2)],
      ['Trade routes', String(a.trade), a.trade * 2]
    ];
    var rowH = Math.min(30, (h * 0.42) / rows.length);
    for (var i = 0; i < rows.length; i++) {
      var ry = y + i * rowH;
      txt(ctx, rows[i][0], 24, ry, 12, MUTED, 'left', 600);
      txt(ctx, rows[i][1], w / 2 + 10, ry, 12, MUTED, 'right', 600);
      txt(ctx, String(rows[i][2]), w - 24, ry, 13, INK, 'right', 700);
      ctx.fillStyle = 'rgba(255,255,255,.05)';
      ctx.fillRect(24, ry + rowH / 2 + 8, w - 48, 1);
    }
    y += rows.length * rowH + 14;

    ctx.fillStyle = 'rgba(240,180,41,.08)';
    rrect(ctx, 20, y - 12, w - 40, 44, 10); ctx.fill();
    txt(ctx, 'TOTAL', 34, y + 10, 14, INK, 'left', 700);
    txt(ctx, String(a.total), w - 34, y + 10, 20, col, 'right', 800);
    y += 46;

    var riv = G.civs && G.civs[2] ? G.civs[2].name : 'Rival';
    txt(ctx, riv + ' ' + b.total + '  ·  Cities ' + b.cities + '  ·  Techs ' + b.techs, w / 2, y + 8, 12, MUTED, 'center', 600, w - 40);
    if (G.newBest) txt(ctx, 'NEW BEST SCORE', w / 2, y + 28, 12, ACCENT, 'center', 700);
    else {
      var best = 0;
      try { best = store.get('best', 0) || 0; } catch (e) {}
      txt(ctx, 'Best ' + best, w / 2, y + 28, 12, MUTED, 'center', 600);
    }

    var by = h - 132;
    rrect(ctx, 26, by, w - 52, 50, 12);
    ctx.fillStyle = ACCENT; ctx.fill();
    txt(ctx, 'PLAY AGAIN', w / 2, by + 25, 15, '#131722', 'center', 800);
    hit(26, by, w - 52, 50, 'again');

    txt(ctx, 'New seed / title', w / 2, by + 76, 13, ACCENT, 'center', 600);
    hit(w / 2 - 80, by + 62, 160, 28, 'quit');
  }

  /* ============================ interaction ============================ */
  var VIEW = { w: 360, h: 640 };
  var pointers = {}, pinchDist = 0;

  function setZoom(z) {
    z = GK.clamp(z, 0.34, 1.65);
    cam.z = z;
    clampCam();
  }

  function clampCam() {
    cam.x = GK.clamp(cam.x, HEX_W, MAP_W - HEX_W);
    cam.y = GK.clamp(cam.y, HEX_R, MAP_H - HEX_R);
  }

  function centerOn(c, r) {
    cam.x = cxp(c, r);
    cam.y = cyp(c, r);
    clampCam();
  }

  function pickTile(sx, sy) {
    if (!G) return null;
    var wx = (sx - VIEW.w / 2) / cam.z + cam.x;
    var wy = (sy - VIEW.h / 2) / cam.z + cam.y;
    var r0 = Math.round((wy - HEX_R) / HEX_H);
    var best = null, bd = 1e9;
    for (var r = r0 - 1; r <= r0 + 1; r++) {
      if (r < 0 || r >= ROWS) continue;
      var c0 = Math.round((wx - HEX_W * 0.5 * (r & 1) - HEX_W * 0.5) / HEX_W);
      for (var c = c0 - 1; c <= c0 + 1; c++) {
        if (!inB(c, r)) continue;
        var dx = wx - cxp(c, r), dy = wy - cyp(c, r), d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = G.tiles[idx(c, r)]; }
      }
    }
    if (!best) return null;
    if (bd > HEX_R * HEX_R * 1.25) return null;
    return best;
  }

  function onTileTap(t) {
    if (!G || G.over) return;
    var sel = ui.selId ? unitById(ui.selId) : null;
    var city = cityAt(t);
    var u = unitAt(t.c, t.r);
    var i = idx(t.c, t.r);

    if (sel) {
      var adj = adjacentEnemies(sel);
      for (var k = 0; k < adj.length; k++) {
        if (adj[k].c === t.c && adj[k].r === t.r) { attackTile(sel, t); return; }
      }
      if (ui.reach && ui.reach[i] && !u && !city) {
        if (moveUnit(sel, t)) return;
      }
      if (ui.reach && ui.reach[i] && city && city.owner === 1) {
        if (moveUnit(sel, t)) return;
      }
    }
    if (city && city.owner === 1) { ui.cityId = city.id; ui.panel = 'city'; ui.buildPage = 0; return; }
    if (u && u.owner === 1) {
      /* first tap selects, a second tap on the same counter opens its details */
      if (u.id === ui.selId) { ui.panel = 'unit'; GK.buzz(8); return; }
      selectUnit(u); GK.buzz(8); return;
    }
    if (city && city.owner === 2) {
      ui.toast = city.name + ' — rival city, ' + Math.round(city.hp) + '/' + city.maxHp + ' defence';
      ui.toastT = 2.2;
      return;
    }
    if (u && u.owner === 2) {
      ui.toast = 'Rival ' + UNITS[u.type].name + ' — ' + Math.round(u.hp) + '/' + u.maxHp + ' HP';
      ui.toastT = 2;
      return;
    }
    if (!t.explored) { ui.toast = 'Unexplored'; ui.toastT = 1.4; return; }
    var y = tileYield(t);
    ui.toast = TER[t.terr].name + (t.res ? ' · ' + t.res : '') + ' — ' + y.f + 'F ' + y.p + 'P ' + y.g + 'G' +
      (t.road ? ' · road' : '');
    ui.toastT = 2;
    if (sel) { ui.selId = 0; ui.best = null; ui.reach = null; }
  }

  function handleHit(h, x, y) {
    if (!h) return;
    var id = h.id;
    if (id === 'block' || id === 'panelbody') {
      /* on the results overlay a tap anywhere re-deals the same seed */
      if (id === 'block' && G && G.over) { newGame(G.seed, G.diff); computeStats(); GK.buzz(8); }
      return;
    }

    if (id === 'endturn') { endTurn(); GK.buzz(10); return; }
    if (id === 'techpanel') { if (ui.screen === 'game') { ui.panel = 'tech'; ui.techJump = true; } return; }
    if (id === 'techprev') { ui.techPage--; if (ui.techPage < 0) ui.techPage = 0; GK.buzz(4); return; }
    if (id === 'technext') { ui.techPage++; GK.buzz(4); return; }
    if (id === 'buildprev') { ui.buildPage--; if (ui.buildPage < 0) ui.buildPage = 0; GK.buzz(4); return; }
    if (id === 'buildnext') { ui.buildPage++; GK.buzz(4); return; }
    if (id === 'menu') { ui.panel = 'menu'; return; }
    if (id === 'close') { ui.panel = ui.panel === 'help' && ui.helpFrom === 'menu' ? 'menu' : null; return; }
    if (id === 'tech') {
      if (researchTech(G.players[1], h.arg)) { GK.sfx.step(); GK.buzz(8); }
      return;
    }
    if (id === 'build') {
      var city = G.cityById[ui.cityId];
      if (!city) return;
      if (city.owner !== 1) return;
      if (city.queue.length >= 4) city.queue.shift();
      city.queue.push(h.arg);
      GK.sfx.step();
      return;
    }
    if (id === 'clearq') {
      var c2 = G.cityById[ui.cityId];
      if (c2) { c2.queue.length = 0; c2.held = null; }
      return;
    }
    if (id === 'selectunit') {
      var c3 = G.cityById[ui.cityId];
      if (!c3) return;
      var gu = unitAt(c3.c, c3.r);
      if (gu) { selectUnit(gu); ui.panel = null; }
      return;
    }
    if (id === 'act') {
      var sel = ui.selId ? unitById(ui.selId) : null;
      if (!sel) return;
      if (h.arg === 'found') foundWith(sel);
      else if (h.arg === 'road') buildRoadWith(sel);
      else if (h.arg === 'fort') fortify(sel);
      else if (h.arg === 'next') cycleUnit(sel);
      return;
    }
    if (id === 'zoom') { setZoom(cam.z * (h.arg > 0 ? 1.22 : 1 / 1.22)); return; }
    if (id === 'minimap') {
      var m = miniRect(VIEW);
      cam.x = (x - m.x) / m.w * MAP_W;
      cam.y = (y - m.y) / m.h * MAP_H;
      clampCam();
      return;
    }
    if (id === 'start') { startGame(); return; }
    if (id === 'random') {
      ui.seedText = String(Math.floor(Math.random() * 9000000) + 1000);
      GK.buzz(8);
      return;
    }
    if (id === 'diff') { ui.diff = h.arg; GK.buzz(6); return; }
    if (id === 'seedbox') { ui.keypad = true; return; }
    if (id === 'key') {
      var k = h.arg;
      if (k === 'ok') { ui.keypad = false; return; }
      if (k === 'del') { ui.seedText = ui.seedText.slice(0, -1) || '1'; return; }
      if (ui.seedText.length < 9) ui.seedText = (ui.seedText === '0' ? '' : ui.seedText) + k;
      return;
    }
    if (id === 'help') { ui.helpFrom = ui.panel || 'title'; ui.panel = 'help'; return; }
    if (id === 'resume') { ui.panel = null; return; }
    if (id === 'restart') { if (G) newGame(G.seed, G.diff); computeStats(); return; }
    if (id === 'sound') { GK.sfx.enabled = !GK.sfx.enabled; return; }
    if (id === 'quit') { ui.panel = null; ui.screen = 'title'; ui.keypad = false; return; }
    if (id === 'again') { if (G) { newGame(G.seed, G.diff); computeStats(); } return; }
  }

  function cycleUnit(from) {
    var us = unitsOf(1), startI = -1, i;
    for (i = 0; i < us.length; i++) if (us[i].id === from.id) startI = i;
    for (i = 1; i <= us.length; i++) {
      var u = us[(startI + i) % us.length];
      if (u.mp > 0.01) { selectUnit(u); return; }
    }
    selectUnit(us[(startI + 1) % us.length]);
  }

  /* ============================ pointer wiring ============================ */
  function relPoint(e, canvas) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function bindInput(canvas) {
    canvas.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      var p = relPoint(e, canvas);
      pointers[e.pointerId] = { x: p.x, y: p.y, sx: p.x, sy: p.y, inMap: ui.screen === 'game' && !ui.panel };
      var ids = Object.keys(pointers);
      if (ids.length === 2) {
        var a = pointers[ids[0]], b = pointers[ids[1]];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
      GK.sfx.unlock();
    }, { passive: false });

    canvas.addEventListener('pointermove', function (e) {
      var p0 = pointers[e.pointerId];
      if (!p0) return;
      var p = relPoint(e, canvas);
      var dx = p.x - p0.x, dy = p.y - p0.y;
      p0.x = p.x; p0.y = p.y;
      var ids = Object.keys(pointers);
      if (ids.length >= 2) {
        var a = pointers[ids[0]], b = pointers[ids[1]];
        var d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0 && d > 0) setZoom(cam.z * (d / pinchDist));
        pinchDist = d;
        return;
      }
      if (p0.inMap && ui.screen === 'game' && !ui.panel) {
        cam.x -= dx / cam.z;
        cam.y -= dy / cam.z;
        clampCam();
      }
    });

    function release(e) {
      var p0 = pointers[e.pointerId];
      if (!p0) return;
      var r = canvas.getBoundingClientRect();
      var x = e.clientX - r.left, y = e.clientY - r.top;
      var moved = Math.hypot(x - p0.sx, y - p0.sy);
      delete pointers[e.pointerId];
      if (Object.keys(pointers).length < 2) pinchDist = 0;
      if (moved > 14) return;
      tapAt(x, y);
    }
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', function (e) {
      delete pointers[e.pointerId];
      if (Object.keys(pointers).length < 2) pinchDist = 0;
    });

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      setZoom(cam.z * (e.deltaY > 0 ? 0.92 : 1.08));
    }, { passive: false });

    window.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (ui.screen === 'game' && !ui.panel) endTurn();
        else if (ui.screen === 'title' && !ui.keypad) startGame();
        else if (ui.screen === 'over') { newGame(G.seed, G.diff); computeStats(); }
      } else if (e.key === 'Escape') {
        if (ui.keypad) ui.keypad = false;
        else if (ui.panel) ui.panel = null;
        else if (ui.screen === 'game') ui.panel = 'menu';
      } else if (e.key === 't' || e.key === 'T') {
        if (ui.screen === 'game' && !ui.panel) ui.panel = 'tech';
      } else if (e.key === 'n' || e.key === 'N') {
        if (ui.screen === 'game' && G) cycleUnit(unitById(ui.selId) || { id: 0 });
      }
    });
  }

  function tapAt(x, y) {
    var h = hitAt(x, y);
    if (h) { handleHit(h, x, y); return; }
    if (ui.screen === 'title') return;
    if (ui.panel) { ui.panel = null; return; }
    if (ui.screen !== 'game' || !G || G.over) return;
    if (y < 62) return;
    var t = pickTile(x, y);
    if (t) onTileTap(t);
  }

  /* ============================ game flow ============================ */
  function startGame() {
    var seed = parseInt(ui.seedText, 10);
    if (!seed || seed < 0) seed = 20261028;
    ui.seedText = String(seed);
    ui.keypad = false;
    try { store.set('lastSeed', seed); store.set('diff', ui.diff); } catch (e) {}
    newGame(seed, ui.diff);
    computeStats();
    GK.sfx.unlock();
  }

  function update(dt, t) {
    if (ui.toastT > 0) ui.toastT -= dt;
    ui.statT = (ui.statT || 0) - dt;
    if (G && ui.statT <= 0) {
      computeStats();
      ui.statT = 0.35;
    }
  }

  function render(ctx, t, view) {
    HITS.length = 0;
    VIEW.w = view.w; VIEW.h = view.h;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, view.w, view.h);

    if (!G || ui.screen === 'title') {
      drawTitle(ctx, view, t);
      if (ui.panel === 'help') drawPanel(ctx, view, t);
      return;
    }

    drawMap(ctx, view, t);
    drawHud(ctx, view, t);
    if (ui.screen === 'over') drawOver(ctx, view, t);
    if (ui.panel) drawPanel(ctx, view, t);
  }


  /* ============================ automation hook ============================ */
  function countTechs(p) { var n = 0; for (var k in p.techs) if (p.techs[k]) n++; return n; }

  window.__game = {
    state: function () {
      /* Contract shape: started/mode/turn/score/cities/gold/over (+ extras). */
      try {
        var live = !!(G && !G.over && ui.screen !== 'title' && ui.screen !== 'over');
        var pc = G ? citiesOf(1).length : 0;
        var mode = (!G || ui.screen === 'title') ? 'title' : (G.over || ui.screen === 'over' ? 'over' : 'play');
        return {
          /* contract keys */
          started: live,
          turn: G ? G.turn : 0,
          gold: G ? Math.round(G.players[1].gold) : 0,
          cities: pc,
          units: G ? unitsOf(1).length : 0,
          alive: G ? pc > 0 : false,
          gameOver: G ? !!G.over : false,
          techs: G ? countTechs(G.players[1]) : 0,
          /* convenience extras */
          mode: mode,
          live: live,
          score: G ? scoreOf(1).total : 0,
          over: !!(G && G.over),
          seed: G ? G.seed : 0,
          research: G && G.players[1].research && TECH_BY[G.players[1].research]
            ? TECH_BY[G.players[1].research].name : null,
          techAhead: G ? techCountAhead(G.players[1]) : 0,
          civs: G && G.civs ? [G.civs[1].name, G.civs[2].name] : null
        };
      } catch (e) {
        return { started: false, turn: 0, gold: 0, cities: 0, units: 0, alive: false, gameOver: false, techs: 0,
                 mode: 'title', live: false, score: 0, over: false, seed: 0, research: null, techAhead: 0, civs: null };
      }
    },
    act: function (name, arg) {
      try {
        if (name === 'newGame') {
          newGame(arg || 20261028, ui.diff);
          computeStats();
          return true;
        }
        if (!G) return false;
        if (name === 'endTurn') {
          if (G.over) return false;
          var ok = endTurn();
          computeStats();
          return !!ok;
        }
        if (name === 'select') {
          if (arg && typeof arg === 'object') {
            if (arg.id) {
              var byId = unitById(arg.id);
              if (byId && byId.owner === 1) { selectUnit(byId); return true; }
              return false;
            }
            if (typeof arg.c === 'number' && typeof arg.r === 'number' && inB(arg.c, arg.r)) {
              onTileTap(G.tiles[idx(arg.c, arg.r)]);
              return true;
            }
            return false;
          }
          if (typeof arg === 'number') {
            var one = unitById(arg);
            if (one && one.owner === 1) { selectUnit(one); return true; }
            return false;
          }
          return selectFirstUnit();
        }
        if (name === 'panel') {
          /* debug/inspection affordance: open or close a sheet by name */
          if (!arg || arg === 'none') { ui.panel = null; return true; }
          ui.panel = String(arg);
          if (ui.panel === 'city') {
            var firstCity = citiesOf(1)[0];
            if (!firstCity) { ui.panel = null; return false; }
            ui.cityId = firstCity.id;
            ui.buildPage = 0;
          }
          return true;
        }
        if (name === 'foundCity') {
          var sel = ui.selId ? unitById(ui.selId) : null;
          if (!sel || sel.type !== 'settler') {
            sel = null;
            var us = unitsOf(1);
            for (var i = 0; i < us.length; i++) if (us[i].type === 'settler') { sel = us[i]; break; }
          }
          if (!sel) return false;
          selectUnit(sel);
          var ok = foundWith(sel);
          if (!ok) { centerOn(sel.c, sel.r); }
          computeStats();
          return ok;
        }
        return false;
      } catch (e) {
        return false;
      }
    }
  };

  /* ============================ boot ============================ */
  if (!GK || !GK.boot) {
    window.__game = window.__game || {
      state: function () { return { started: false, turn: 0, gold: 0, cities: 0, units: 0, alive: false, gameOver: false, techs: 0, mode: 'title', score: 0, over: false }; },
      act: function () { return false; }
    };
    return;
  }

  try { ui.seedText = String(store.get('lastSeed', 20261028) || 20261028); } catch (e) {}
  try { var savedDiff = store.get('diff', 'normal'); if (DIFF[savedDiff]) ui.diff = savedDiff; } catch (e) {}

  var canvas = document.getElementById('game') || document.getElementById('c');
  if (canvas) {
    GK.boot({
      canvas: canvas,
      update: update,
      render: render,
      onResize: function (v) { VIEW.w = v.w; VIEW.h = v.h; }
    });
    bindInput(canvas);
  }
})();
