/* Wardenmarch — a turn-based squad skirmish campaign for phones.
 * Classic script, no modules, no network, no external fonts. Boots from file://
 * and plays with vendor/ deleted.
 *
 * Cross-hybrid lineage: Battle for Wesnoth's unit table supplies every number a
 * unit fights with — hit points, movement allowance, and each attack's damage,
 * strike count and melee/ranged class. Dungeon Crawl Stone Soup's vault corpus
 * supplies the battlefield: the arena grid is a real .des vault, walls, doors and
 * stairs included, never a hand-drawn box. Wardenmarch adds only the connective
 * tissue (cover, reach, turn order) and labels those as its own rules on screen.
 *
 * Frame budget notes (mid-tier phones):
 *  - the arena (floor, walls, terrain decals, grid) is baked once per battle and
 *    per resize into an offscreen canvas, then blitted — a 20x18 vault would
 *    otherwise cost ~600 drawImage calls every frame;
 *  - damage numbers and ash live in fixed-size pools, never allocated per hit;
 *  - unit sprites are drawn with a plain transform, no shadowBlur, no filters;
 *  - HUD strings are rebuilt when state changes, not per frame.
 *
 * Art provenance: unit sprites, portraits and terrain tiles come from
 * window.AOMG_VENDOR (vendor/vendor.js, Battle for Wesnoth, GPL-2.0 /
 * CC-BY-SA-4.0). Arena layouts come from the vendored DCSS vault corpus (CC0).
 * Each of those images has an authored canvas-vector fallback below, so the game
 * still boots, draws and plays when vendor/ is missing.
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
    bg: '#0d1013', deep: '#06080a', panel: '#11171c', panel2: '#171f25',
    steel: '#9fb8c8', steelDim: '#5b7382', ink: '#e7eef3', mid: '#a9bbc6',
    dim: '#6b7f8b', gold: '#e8c168', goldDim: '#8d7233', banner: '#d24b3f',
    bannerDim: '#8b322a', good: '#86c98d', bad: '#e06a58', floor: '#1b2329'
  };
  var FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  var SERIF = 'Georgia,"Times New Roman",serif';
  var MONO = 'ui-monospace,Menlo,Consolas,"Courier New",monospace';
  var FS = {
    micro: '10px ' + MONO, label: '700 10px ' + FONT, small: '11px ' + FONT,
    body: '12px ' + FONT, bodyB: '700 12px ' + FONT, name: '700 13px ' + FONT,
    h3: '700 15px ' + SERIF, h2: '700 20px ' + SERIF, h1: '700 30px ' + SERIF,
    title: '700 38px ' + SERIF, mono: '11px ' + MONO, monoB: '700 12px ' + MONO
  };
  var DASH1 = [5, 5], DASH2 = [2, 4], NODASH = [];
  var ROMAN = ['I', 'II', 'III'];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ease(t) { return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t); }
  function manhattan(ax, ay, bx, by) { return Math.abs(ax - bx) + Math.abs(ay - by); }
  function pad4(n) { n = Math.round(n); return n < 10 ? '000' + n : n < 100 ? '00' + n : n < 1000 ? '0' + n : '' + n; }

  function txt(ctx, s, x, y, font, col, align, base) {
    ctx.font = font; ctx.fillStyle = col;
    ctx.textAlign = align || 'left'; ctx.textBaseline = base || 'alphabetic';
    ctx.fillText(s, x, y);
  }
  function roundRect(ctx, x, y, w, h, r) {
    if (r > w * 0.5) r = w * 0.5;
    if (r > h * 0.5) r = h * 0.5;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  function spaced(ctx, s, x, y, font, col, gap, align) {
    ctx.font = font; ctx.fillStyle = col; ctx.textBaseline = 'alphabetic';
    var total = 0, i, w;
    for (i = 0; i < s.length; i++) { w = ctx.measureText(s.charAt(i)).width; total += w + gap; }
    total -= gap;
    var cx = align === 'center' ? x - total * 0.5 : align === 'right' ? x - total : x;
    ctx.textAlign = 'left';
    for (i = 0; i < s.length; i++) {
      ctx.fillText(s.charAt(i), cx, y);
      cx += ctx.measureText(s.charAt(i)).width + gap;
    }
    return total;
  }
  function fitText(ctx, s, maxW, font) {
    ctx.font = font;
    if (ctx.measureText(s).width <= maxW) return s;
    var t = s;
    while (t.length > 2 && ctx.measureText(t + '\u2026').width > maxW) t = t.slice(0, t.length - 1);
    return t + '\u2026';
  }

  /* ------------------------------------------------------------------ */
  /* vendor ingestion                                                    */
  /* ------------------------------------------------------------------ */
  var VDATA = (window.AOMG_VENDOR && window.AOMG_VENDOR.data) || {};
  var WES = VDATA['wesnoth/assets'] || null;
  var DCSS = VDATA['dcss/vaults'] || null;

  /* Offline shadow of the vendored records. These are the same upstream Wesnoth
   * numbers, kept here only so the battle still resolves with vendor/ deleted.
   * When the bundle is present its table wins, record for record. */
  var EMBEDDED_UNITS = [
    { id: 'Drake Burner', name: 'Drake Burner', race: 'drake', level: 1, hp: 42, movement: 5, cost: 21, alignment: 'lawful', image: 'vendor/wesnoth/units/Drake_Burner.png', portrait: 'vendor/wesnoth/portraits/Drake_Burner.png', attacks: [{ name: 'claws', type: 'blade', range: 'melee', damage: 7, number: 2 }, { name: 'fire breath', type: 'fire', range: 'ranged', damage: 6, number: 4 }] },
    { id: 'Dwarvish Miner', name: 'Dwarvish Miner', race: 'dwarf', level: 0, hp: 22, movement: 4, cost: 10, alignment: 'neutral', image: 'vendor/wesnoth/units/Dwarvish_Miner.png', attacks: [{ name: 'pick', type: 'pierce', range: 'melee', damage: 4, number: 3 }] },
    { id: 'Elvish Archer', name: 'Elvish Archer', race: 'elf', level: 1, hp: 29, movement: 6, cost: 17, alignment: 'neutral', image: 'vendor/wesnoth/units/Elvish_Archer.png', portrait: 'vendor/wesnoth/portraits/Elvish_Archer.png', attacks: [{ name: 'sword', type: 'blade', range: 'melee', damage: 5, number: 2 }, { name: 'bow', type: 'pierce', range: 'ranged', damage: 5, number: 4 }] },
    { id: 'Goblin Spearman', name: 'Goblin Spearman', race: 'goblin', level: 0, hp: 18, movement: 5, cost: 9, alignment: 'chaotic', image: 'vendor/wesnoth/units/Goblin_Spearman.png', portrait: 'vendor/wesnoth/portraits/Goblin_Spearman.png', attacks: [{ name: 'spear', type: 'pierce', range: 'melee', damage: 6, number: 3 }, { name: 'spear', type: 'pierce', range: 'ranged', damage: 3, number: 1 }] },
    { id: 'Peasant', name: 'Peasant', race: 'human', level: 0, hp: 18, movement: 5, cost: 8, alignment: 'lawful', image: 'vendor/wesnoth/units/Peasant.png', portrait: 'vendor/wesnoth/portraits/Peasant.png', attacks: [{ name: 'pitchfork', type: 'pierce', range: 'melee', damage: 5, number: 2 }, { name: 'pitchfork', type: 'pierce', range: 'ranged', damage: 4, number: 1 }] },
    { id: 'Saurian Augur', name: 'Saurian Augur', race: 'lizard', level: 1, hp: 22, movement: 6, cost: 16, alignment: 'chaotic', image: 'vendor/wesnoth/units/Saurian_Augur.png', portrait: 'vendor/wesnoth/portraits/Saurian_Augur.png', attacks: [{ name: 'staff', type: 'impact', range: 'melee', damage: 4, number: 2 }, { name: 'curse', type: 'cold', range: 'ranged', damage: 5, number: 3 }] },
    { id: 'Merman Citizen', name: 'Merman Citizen', race: 'merman', level: 0, hp: 20, movement: 6, cost: 9, alignment: 'lawful', image: 'vendor/wesnoth/units/Merman_Citizen.png', portrait: 'vendor/wesnoth/portraits/Merman_Citizen.png', attacks: [{ name: 'fist', type: 'impact', range: 'melee', damage: 4, number: 3 }] },
    { id: 'Naga Dirkfang', name: 'Naga Dirkfang', race: 'naga', level: 1, hp: 31, movement: 7, cost: 15, alignment: 'neutral', image: 'vendor/wesnoth/units/Naga_Dirkfang.png', portrait: 'vendor/wesnoth/portraits/Naga_Dirkfang.png', attacks: [{ name: 'dagger', type: 'blade', range: 'melee', damage: 4, number: 3 }, { name: 'chakri', type: 'blade', range: 'ranged', damage: 7, number: 2 }] },
    { id: 'Young Ogre', name: 'Young Ogre', race: 'ogre', level: 1, hp: 42, movement: 5, cost: 13, alignment: 'neutral', image: 'vendor/wesnoth/units/Young_Ogre.png', portrait: 'vendor/wesnoth/portraits/Young_Ogre.png', attacks: [{ name: 'cleaver', type: 'blade', range: 'melee', damage: 5, number: 3 }] },
    { id: 'Orcish Archer', name: 'Orcish Archer', race: 'orc', level: 1, hp: 32, movement: 5, cost: 14, alignment: 'chaotic', image: 'vendor/wesnoth/units/Orcish_Archer.png', portrait: 'vendor/wesnoth/portraits/Orcish_Archer.png', attacks: [{ name: 'dagger', type: 'blade', range: 'melee', damage: 3, number: 2 }, { name: 'bow', type: 'pierce', range: 'ranged', damage: 6, number: 3 }, { name: 'fire arrow', type: 'fire', range: 'ranged', damage: 7, number: 2 }] },
    { id: 'Troll Whelp', name: 'Troll Whelp', race: 'troll', level: 1, hp: 42, movement: 4, cost: 13, alignment: 'chaotic', image: 'vendor/wesnoth/units/Troll_Whelp.png', portrait: 'vendor/wesnoth/portraits/Troll_Whelp.png', attacks: [{ name: 'fist', type: 'impact', range: 'melee', damage: 7, number: 2 }] },
    { id: 'Ghost', name: 'Ghost', race: 'undead', level: 1, hp: 18, movement: 7, cost: 19, alignment: 'chaotic', image: 'vendor/wesnoth/units/Ghost.png', portrait: 'vendor/wesnoth/portraits/Ghost.png', attacks: [{ name: 'touch', type: 'arcane', range: 'melee', damage: 4, number: 3 }, { name: 'wail', type: 'cold', range: 'ranged', damage: 3, number: 3 }] }
  ];

  /* A real vault, kept as a last-resort battlefield if the corpus is missing. */
  var EMBEDDED_VAULT = {
    id: 'nicolae_crypt_skullbonk', depth: 'Crypt', h: 15, w: 15,
    tags: ['transparent', 'extra', 'decor'], file: 'crawl-ref/source/dat/des/branches/crypt.des',
    grid: [
      '    #######    ', '    ##...##    ', '  ..#.....#..  ', '  ...........  ',
      '###.#.....#.###', '##...#...#...##', '#.....###.....#', '#.....###.....#',
      '#.....###.....#', '##...#...#...##', '###.#.....#.###', '  ...........  ',
      '  ..#.....#..  ', '    ##...##    ', '    #######    '
    ]
  };

  function normRec(r, i) {
    var atk = [], src = r.attacks || [], k;
    for (k = 0; k < src.length; k++) {
      atk.push({
        name: src[k].name || 'strike', type: src[k].type || 'blade',
        range: src[k].range === 'ranged' ? 'ranged' : 'melee',
        damage: Math.max(1, src[k].damage | 0), number: Math.max(1, src[k].number | 0)
      });
    }
    if (!atk.length) atk.push({ name: 'fist', type: 'impact', range: 'melee', damage: 4, number: 2 });
    return {
      id: r.id || ('unit_' + i), name: r.name || r.id || 'Unknown', race: r.race || 'monster',
      level: r.level | 0, hp: Math.max(8, r.hp | 0), movement: clamp(r.movement | 0, 2, 9),
      cost: r.cost | 0, alignment: r.alignment || 'neutral', attacks: atk,
      image: r.image || '', portrait: r.portrait || ''
    };
  }

  var RECS = [], BYID = {};
  (function () {
    var src = (WES && WES.units && WES.units.length) ? WES.units : EMBEDDED_UNITS, i;
    for (i = 0; i < src.length; i++) {
      var r = normRec(src[i], i);
      RECS.push(r); BYID[r.id] = r;
    }
  })();

  /* The playable roster is every record whose race is one of the twelve factions
   * the brief names. That is 12 records when the bundle is present. */
  var FACTIONS = ['human', 'orc', 'undead', 'elf', 'dwarf', 'troll', 'goblin', 'drake', 'merman', 'naga', 'ogre', 'lizard'];
  var PLAY = [];
  (function () {
    for (var i = 0; i < RECS.length; i++) if (FACTIONS.indexOf(RECS[i].race) >= 0) PLAY.push(RECS[i]);
  })();
  var DEFAULT_SQUAD = ['Drake Burner', 'Elvish Archer', 'Troll Whelp', 'Saurian Augur'];

  /* Battlefield dressing. Thirteen distinct Wesnoth terrain tiles are painted as
   * floor decals; each kind carries the cover value Wardenmarch uses for its own
   * evasion rule (never a Wesnoth defence number — those are per-terrain
   * percentages for a hex game and reusing them here would be invented balance). */
  var FEATS = [
    { kind: 'causeway', cover: 0.15, tint: '#6f8fa6' },
    { kind: 'ruin', cover: 0.20, tint: '#8d9aa4' },
    { kind: 'pillar', cover: 0.15, tint: '#a8b6c0' },
    { kind: 'sandstone', cover: 0.10, tint: '#c8a878' },
    { kind: 'flowers', cover: 0.05, tint: '#9ac48a' },
    { kind: 'fog', cover: 0.25, tint: '#b9cbd6' },
    { kind: 'dry grass', cover: 0.05, tint: '#c0b070' },
    { kind: 'rug', cover: 0.10, tint: '#b06a6a' },
    { kind: 'tide rail', cover: 0.15, tint: '#6fa8b8' },
    { kind: 'sand', cover: 0.10, tint: '#cbb27a' },
    { kind: 'roost', cover: 0.20, tint: '#c07a5a' },
    { kind: 'briar', cover: 0.15, tint: '#8fa878' },
    { kind: 'shallows', cover: 0.15, tint: '#79b6c0' }
  ];

  var VAULTS = (DCSS && DCSS.vaults && DCSS.vaults.length) ? DCSS.vaults : [EMBEDDED_VAULT];
  function walkableChar(ch) { return ch === '.' || ch === '+' || ch === '>'; }

  /* A vault only ships as an arena if it holds a 4x2 open block: the opening
   * deployment needs two ranks of two, with one clear tile between each pair so
   * the first step puts a blade in reach. Layouts that fail are not modified —
   * they are simply not chosen, because the walls are the point. */
  function hasCorridor(v) {
    if (!v || !v.grid || !v.grid.length) return false;
    var r, c, dx, dy, ok;
    for (r = 0; r + 1 < v.h; r++) {
      for (c = 0; c + 3 < v.w; c++) {
        ok = true;
        for (dy = 0; dy < 2 && ok; dy++) {
          var row = v.grid[r + dy] || '';
          for (dx = 0; dx < 4; dx++) if (!walkableChar(row.charAt(c + dx))) { ok = false; break; }
        }
        if (ok) return true;
      }
    }
    return false;
  }

  var VAULT_POOL = null, CORRIDORS = null;
  function vaultData() {
    if (VAULT_POOL) return VAULT_POOL;
    VAULT_POOL = []; CORRIDORS = [];
    var i, v, r, c, dx, dy, ok;
    for (i = 0; i < VAULTS.length; i++) {
      v = VAULTS[i];
      /* Nine to fifteen cells across: on a 390px phone a wider vault forces
       * cells under ~23px, and a 23px cell cannot hold a figure you can read.
       * Cell size is the thing the board is for, so narrow vaults win. */
      if (!v || !v.grid || v.w < 9 || v.w > 15 || v.h < 9 || v.h > 18) continue;
      /* portrait-first: prefer vaults at least as tall as they are wide, so the
       * field fills a 390x844 screen instead of becoming a letterboxed strip */
      if (v.h < Math.round(v.w * 0.9)) continue;
      if (!hasCorridor(v)) continue;
      VAULT_POOL.push(v);
      for (r = 0; r + 1 < v.h; r++) {
        for (c = 0; c + 3 < v.w; c++) {
          ok = true;
          for (dy = 0; dy < 2 && ok; dy++) {
            var row = v.grid[r + dy] || '';
            for (dx = 0; dx < 4; dx++) if (!walkableChar(row.charAt(c + dx))) { ok = false; break; }
          }
          if (ok) CORRIDORS.push({ v: v, c: c, r: r });
        }
      }
    }
    if (!VAULT_POOL.length) {
      VAULT_POOL.push(EMBEDDED_VAULT);
      CORRIDORS.push({ v: EMBEDDED_VAULT, c: 4, r: 6 });
    }
    return VAULT_POOL;
  }

  /* ------------------------------------------------------------------ */
  /* art: vendored images + authored vector fallbacks                    */
  /* ------------------------------------------------------------------ */
  var IMG = {};
  var TERRAIN = [];

  function vendorPath(p) { return '../../' + p; }

  function loadImage(path, onOk) {
    if (!path) return null;
    var im = new Image();
    im.onload = function () { onOk(im); };
    im.onerror = function () { onOk(null); };
    im.src = vendorPath(path);
    return im;
  }

  (function initArt() {
    var i, r, slot;
    for (i = 0; i < RECS.length; i++) {
      r = RECS[i];
      slot = IMG[r.id] = { u: null, p: null, uok: false, pok: false };
      (function (s, rec) {
        if (rec.image) loadImage(rec.image, function (im) { s.u = im; s.uok = !!im; if (B) B.bakeDirty = true; });
        if (rec.portrait) loadImage(rec.portrait, function (im) { s.p = im; s.pok = !!im; });
      })(slot, r);
    }
    for (i = 0; i < FEATS.length; i++) {
      (function (idx) {
        var t = { img: null, ok: false };
        TERRAIN.push(t);
        if (WES && WES.terrain && WES.terrain[idx + 1]) {
          loadImage(WES.terrain[idx + 1], function (im) { t.img = im; t.ok = !!im; if (B) B.bakeDirty = true; });
        }
      })(i);
    }
  })();

  var RACE_COL = {
    human: '#9fb8c8', orc: '#7fa05a', undead: '#9aa7c8', elf: '#8fd0a0', dwarf: '#c8a06a',
    troll: '#8a9a7a', goblin: '#a8c06a', drake: '#d2704a', merman: '#6fb6c8', naga: '#7fae8a',
    ogre: '#b08a6a', lizard: '#9ac27a', bats: '#8a7fa8', cats: '#c0a070', falcon: '#b0b8a0',
    gryphon: '#c0a880', horse: '#b09a7a', monster: '#8c9aa4', raven: '#7a8590', ship: '#8a97a8',
    wolf: '#9a9a90', mechanical: '#8f9aa0'
  };
  function raceCol(r) { return RACE_COL[r] || '#8c9aa4'; }

  /* Authored fallback for a unit sprite: a heraldic shield-figure in the race's
   * colour, with a helm, shoulder line and a weapon bar. Deliberately flat-shaded
   * so a missing PNG still reads as a soldier, not a placeholder box. */
  function drawUnitFallback(ctx, race, cx, cy, size, side) {
    var col = raceCol(race), h = size * 0.5, w = size * 0.36;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.beginPath(); ctx.ellipse(0, h * 0.92, w * 0.95, h * 0.18, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = side === 'enemy' ? '#2a1a19' : '#1b242b';
    ctx.beginPath();
    ctx.moveTo(-w * 0.8, h * 0.9); ctx.lineTo(-w * 0.55, -h * 0.25);
    ctx.lineTo(w * 0.55, -h * 0.25); ctx.lineTo(w * 0.8, h * 0.9);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(-w * 0.42, h * 0.75); ctx.lineTo(-w * 0.48, -h * 0.05);
    ctx.quadraticCurveTo(0, -h * 0.42, w * 0.48, -h * 0.05);
    ctx.lineTo(w * 0.42, h * 0.75); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#cfdae0';
    ctx.beginPath(); ctx.arc(0, -h * 0.52, w * 0.34, Math.PI, TAU); ctx.fill();
    ctx.fillRect(-w * 0.34, -h * 0.52, w * 0.68, h * 0.2);
    ctx.fillStyle = 'rgba(10,14,18,0.85)';
    ctx.fillRect(-w * 0.26, -h * 0.44, w * 0.52, h * 0.07);
    ctx.strokeStyle = '#8f9ba4'; ctx.lineWidth = Math.max(1.4, size * 0.045);
    ctx.beginPath(); ctx.moveTo(w * 0.58, h * 0.62); ctx.lineTo(w * 0.95, -h * 0.62); ctx.stroke();
    ctx.fillStyle = C.gold;
    ctx.fillRect(w * 0.72, -h * 0.02, w * 0.1, h * 0.1);
    ctx.restore();
  }

  /* Authored fallback for a portrait: bust silhouette + monogram. */
  function drawBustFallback(ctx, rec, x, y, w, h) {
    var col = raceCol(rec.race), cx = x + w * 0.5;
    ctx.save();
    roundRect(ctx, x, y, w, h, Math.min(w, h) * 0.16); ctx.clip();
    var g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, '#1d262d'); g.addColorStop(1, '#0e1418');
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = col; ctx.globalAlpha = 0.28;
    ctx.beginPath(); ctx.arc(cx, y + h * 0.9, w * 0.52, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = shadeHex(col, -55);
    ctx.beginPath();
    ctx.moveTo(x + w * 0.08, y + h);
    ctx.quadraticCurveTo(cx, y + h * 0.42, x + w * 0.92, y + h);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(cx, y + h * 0.42, w * 0.19, 0, TAU); ctx.fill();
    ctx.fillStyle = '#cfdae0';
    ctx.beginPath(); ctx.arc(cx, y + h * 0.40, w * 0.20, Math.PI * 1.02, TAU * 0.99); ctx.fill();
    ctx.fillStyle = 'rgba(8,12,15,0.9)';
    ctx.fillRect(cx - w * 0.15, y + h * 0.40, w * 0.30, h * 0.03);
    txt(ctx, rec.name.charAt(0), cx, y + h * 0.86, '700 ' + Math.round(h * 0.30) + 'px ' + SERIF, 'rgba(232,193,104,0.55)', 'center');
    ctx.restore();
  }

  function shadeHex(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = clamp(((n >> 16) & 255) + amt, 0, 255);
    var g = clamp(((n >> 8) & 255) + amt, 0, 255);
    var b = clamp((n & 255) + amt, 0, 255);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  /* Authored fallback for a terrain decal, one shape per kind. */
  function drawFeatureFallback(ctx, feat, x, y, s) {
    var k = feat.kind, i;
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = 0.55;
    if (k === 'fog') {
      var g = ctx.createRadialGradient(s * 0.5, s * 0.5, s * 0.05, s * 0.5, s * 0.5, s * 0.55);
      g.addColorStop(0, 'rgba(190,210,220,0.35)'); g.addColorStop(1, 'rgba(190,210,220,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    } else if (k === 'flowers') {
      ctx.fillStyle = '#9ac48a';
      for (i = 0; i < 7; i++) {
        ctx.beginPath();
        ctx.arc((i * 37 % 80) / 80 * s, (i * 53 % 90) / 90 * s, s * 0.045, 0, TAU);
        ctx.fill();
      }
    } else if (k === 'rug') {
      ctx.strokeStyle = '#a05c5c'; ctx.lineWidth = Math.max(1, s * 0.06);
      ctx.strokeRect(s * 0.14, s * 0.14, s * 0.72, s * 0.72);
      ctx.strokeStyle = 'rgba(232,193,104,0.4)'; ctx.lineWidth = 1;
      ctx.strokeRect(s * 0.22, s * 0.22, s * 0.56, s * 0.56);
    } else if (k === 'shallows' || k === 'tide rail') {
      ctx.strokeStyle = 'rgba(110,180,200,0.55)'; ctx.lineWidth = Math.max(1, s * 0.04);
      for (i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(0, s * (0.25 + i * 0.22));
        ctx.quadraticCurveTo(s * 0.5, s * (0.15 + i * 0.22), s, s * (0.25 + i * 0.22));
        ctx.stroke();
      }
    } else if (k === 'pillar') {
      ctx.fillStyle = 'rgba(170,184,194,0.45)';
      ctx.beginPath(); ctx.arc(s * 0.5, s * 0.55, s * 0.2, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(20,27,32,0.7)';
      ctx.beginPath(); ctx.arc(s * 0.5, s * 0.55, s * 0.12, 0, TAU); ctx.fill();
    } else if (k === 'ruin' || k === 'causeway' || k === 'sandstone') {
      ctx.strokeStyle = 'rgba(160,172,180,0.5)'; ctx.lineWidth = Math.max(1, s * 0.035);
      ctx.beginPath();
      ctx.moveTo(s * 0.12, s * 0.8); ctx.lineTo(s * 0.34, s * 0.62);
      ctx.lineTo(s * 0.28, s * 0.34); ctx.lineTo(s * 0.55, s * 0.2);
      ctx.lineTo(s * 0.8, s * 0.42); ctx.lineTo(s * 0.72, s * 0.8);
      ctx.stroke();
    } else if (k === 'briar') {
      ctx.strokeStyle = 'rgba(120,150,100,0.6)'; ctx.lineWidth = 1;
      for (i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.moveTo(s * 0.15, s * (0.3 + i * 0.12));
        ctx.quadraticCurveTo(s * 0.5, s * (0.1 + i * 0.1), s * 0.86, s * (0.32 + i * 0.1));
        ctx.stroke();
      }
    } else if (k === 'roost') {
      ctx.strokeStyle = 'rgba(200,120,90,0.5)'; ctx.lineWidth = 1;
      for (i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(s * (0.2 + i * 0.16), s * 0.25);
        ctx.lineTo(s * (0.3 + i * 0.16), s * 0.7);
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = 'rgba(200,190,140,0.45)'; ctx.lineWidth = 1;
      for (i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.moveTo(s * (0.2 + i * 0.15), s * 0.85);
        ctx.lineTo(s * (0.24 + i * 0.15), s * 0.55);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /* game model                                                          */
  /* ------------------------------------------------------------------ */
  var G = null;
  var B = null;
  var STORE = GK.store('wardenmarch');
  var AMB = null, ambOn = STORE.get('ambient', true), ambStarted = false;
  var BEST_SCORE = STORE.get('best', 0), WINS = STORE.get('wins', 0);

  var STAGE_NAMES = ['THE SUNKEN CRYPT', 'THE DROWNED HALLS', "THE WARDEN'S GATE"];
  var STAGE_SUB = ['A vault the tide forgot', 'Brackish halls, broken banners', 'The gate the march was sworn to hold'];

  function mkUnit(rec, side, x, y, slot) {
    return {
      rec: rec, side: side, x: x, y: y, slot: slot,
      hp: rec.hp, maxHp: rec.hp, mp: rec.movement, maxMp: rec.movement,
      acted: false, alive: true,
      vx: x, vy: y, path: null, pi: 0, pt: 0, walkWait: 0,
      atkT: 0, atkDx: 0, atkDy: 0, flash: 0, bob: slot * 1.7,
      short: rec.name, nameUpper: rec.name.toUpperCase(),
      summary: rec.attacks[0].name.toUpperCase() + ' ' + rec.attacks[0].damage +
        '\u00D7' + rec.attacks[0].number + ' ' + rec.attacks[0].range.toUpperCase() +
        (rec.attacks[1] ? ' \u00B7 ' + rec.attacks[1].name.toUpperCase() + ' ' +
          rec.attacks[1].damage + '\u00D7' + rec.attacks[1].number + ' ' +
          rec.attacks[1].range.toUpperCase() : ''),
      hpStr: 'HP ' + rec.hp, statusLine: 'LV' + rec.level + ' ' + rec.race.toUpperCase()
    };
  }

  function occUnit(x, y) {
    if (!B || x < 0 || y < 0 || x >= B.cols || y >= B.rows) return null;
    return B.occ[y * B.cols + x] || null;
  }
  function tileAt(x, y) {
    if (!B || x < 0 || y < 0 || x >= B.cols || y >= B.rows) return '#';
    return B.grid[y].charAt(x) || '#';
  }
  function walkAt(x, y) { return walkableChar(tileAt(x, y)); }
  function coverAt(x, y) {
    if (!B || x < 0 || y < 0 || x >= B.cols || y >= B.rows) return 0;
    return B.cover[y * B.cols + x] || 0;
  }
  function hitChance(t) { return clamp(0.80 - coverAt(t.x, t.y), 0.45, 0.92); }

  /* Wardenmarch's reach rule: melee 1, ranged 3. Wesnoth hands us the attacks;
   * the tile distances are ours, and the HUD says so. */
  function los(x0, y0, x1, y1) {
    var dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    var err = dx - dy, e2, guard = 0;
    var x = x0, y = y0;
    while (guard++ < 64) {
      if (x === x1 && y === y1) return true;
      e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
      if (x === x1 && y === y1) return true;
      if (!walkAt(x, y)) return false;
    }
    return true;
  }

  function usableAttack(u, t, a) {
    var d = manhattan(u.x, u.y, t.x, t.y);
    if (a.range === 'melee') return d === 1;
    if (d < 2 || d > 3) return false;
    return los(u.x, u.y, t.x, t.y);
  }
  function canStrikeFrom(u, x, y, t) {
    var d = manhattan(x, y, t.x, t.y), i, a;
    for (i = 0; i < u.rec.attacks.length; i++) {
      a = u.rec.attacks[i];
      if (a.range === 'melee') { if (d === 1) return true; }
      else if (d >= 2 && d <= 3 && los(x, y, t.x, t.y)) return true;
    }
    return false;
  }

  function bestAttack(u, t) {
    var best = null, bestV = -1, i, a, v;
    for (i = 0; i < u.rec.attacks.length; i++) {
      a = u.rec.attacks[i];
      if (!usableAttack(u, t, a)) continue;
      v = a.damage * a.number;
      if (v > bestV) { bestV = v; best = a; }
    }
    return best;
  }

  function anyTarget(u) {
    if (!B) return null;
    var best = null, bestD = 99, bestHp = 1e9, i, v, d;
    for (i = 0; i < B.units.length; i++) {
      v = B.units[i];
      if (!v.alive || v.side === u.side) continue;
      d = manhattan(u.x, u.y, v.x, v.y);
      if (d > 3) continue;
      if (!bestAttack(u, v)) continue;
      if (d < bestD || (d === bestD && v.hp < bestHp)) { best = v; bestD = d; bestHp = v.hp; }
    }
    return best;
  }

  /* BFS over walkable tiles. Terrain costs one movement point per tile; that is
   * Wardenmarch's simplification, not Wesnoth's per-terrain costs. */
  function bfsField(sx, sy, blockUnits) {
    var n = B.cols * B.rows;
    var dist = new Int16Array(n);
    var parent = new Int32Array(n);
    var q = new Int32Array(n);
    var i;
    for (i = 0; i < n; i++) { dist[i] = -1; parent[i] = -1; }
    var head = 0, tail = 0, s = sy * B.cols + sx;
    dist[s] = 0; q[tail++] = s;
    var dirs = [1, 0, -1, 0, 0, 1, 0, -1];
    while (head < tail) {
      var cur = q[head++], cx = cur % B.cols, cy = (cur - cx) / B.cols;
      for (i = 0; i < 4; i++) {
        var nx = cx + dirs[i * 2], ny = cy + dirs[i * 2 + 1];
        if (nx < 0 || ny < 0 || nx >= B.cols || ny >= B.rows) continue;
        if (!walkAt(nx, ny)) continue;
        var ni = ny * B.cols + nx;
        if (dist[ni] >= 0) continue;
        if (blockUnits && B.occ[ni]) continue;
        dist[ni] = dist[cur] + 1; parent[ni] = cur; q[tail++] = ni;
      }
    }
    return { dist: dist, parent: parent };
  }

  /* Cached movement field: the highlight needs the same BFS every frame while a
   * banner is selected, so it is computed once per position, not per frame. */
  function fieldFor(u) {
    if (!B.fld || B.fldDirty || B.fldU !== u || B.fldX !== u.x || B.fldY !== u.y) {
      B.fldDirty = false;
      B.fld = bfsField(u.x, u.y, true);
      B.fldU = u; B.fldX = u.x; B.fldY = u.y;
    }
    return B.fld;
  }

  function pathTiles(field, tx, ty) {
    var out = [], cur = ty * B.cols + tx, guard = 0;
    if (field.dist[cur] < 0) return null;
    while (cur >= 0 && guard++ < 600) {
      var cx = cur % B.cols, cy = (cur - cx) / B.cols;
      out.push({ x: cx, y: cy });
      cur = field.parent[cur];
    }
    out.reverse();
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* battle setup                                                        */
  /* ------------------------------------------------------------------ */
  function hashStr(s) {
    var h = 2166136261, i;
    for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  var lastArenaId = '';
  function pickArena(stage) {
    var corridors = CORRIDORS;
    var seed = 4242 + stage * 977;
    var rng = GK.rand(seed);
    var idx = Math.floor(rng() * corridors.length);
    var cand = corridors[idx];
    if (stage > 0 && cand.v.id === lastArenaId) {
      idx = (idx + 37 + stage * 11) % corridors.length;
      cand = corridors[idx];
    }
    lastArenaId = cand.v.id;
    return cand;
  }

  function startBattle(stage) {
    var pick = pickArena(stage);
    var v = pick.v;
    var cols = v.w, rows = v.h, i, x, y;

    B = {
      vault: v, grid: v.grid, cols: cols, rows: rows,
      units: [], players: [], enemies: [], occ: new Array(cols * rows),
      cover: new Float32Array(cols * rows), feat: new Int8Array(cols * rows),
      turn: 1, phase: 'player', sel: null, target: null, hover: null,
      fights: 0, kills: 0, stage: stage,
      vaultLine: 'ARENA \u00B7 ' + prettyId(v.id) + (v.depth ? ' \u00B7 ' + v.depth : ' \u00B7 DCSS VAULT'),
      bake: null, bakeW: 0, bakeH: 0, bakeDirty: true, tile: 24,
      deco: null, ovl: null, ovlKey: 0, fv: 0,
      camY: 0, camMax: 0,
      corpses: [], floats: [], drawOrder: [], fld: null, fldDirty: true,
      bnT: 0, bnText: '', bnSub: '', shake: 0,
      dispatch: 'TAP A GOLD-RINGED BANNER, THEN A LIT TILE',
      hudTurn: '', hudFoes: '', scoreStr: '0000', detailLine: '',
      preview: '', rng: GK.rand(hashStr(v.id) + stage * 131)
    };
    for (i = 0; i < cols * rows; i++) { B.occ[i] = null; B.cover[i] = 0; B.feat[i] = 0; }

    /* cover decals: deterministic per arena, with the first thirteen feature
     * tiles forced to distinct kinds so the whole terrain set reaches the floor */
    var frng = GK.rand(hashStr(v.id) ^ 0x9e3779b9);
    var used = 0;
    for (y = 0; y < rows; y++) {
      for (x = 0; x < cols; x++) {
        if (!walkAt(x, y)) continue;
        var idx = y * cols + x;
        if (frng() < 0.44) {
          var fi = used < FEATS.length ? used : Math.floor(frng() * FEATS.length) % FEATS.length;
          used++;
          B.feat[idx] = fi + 1;
          B.cover[idx] = FEATS[fi].cover;
        }
      }
    }

    var squad = G.squad.slice(0, 4), rec;
    var anchorX = pick.c, anchorY = pick.r;
    var taken = {}, reserved = {};

    function freeNear(fromX, fromY, eastBias) {
      var best = null, bestScore = 1e9, bx, by, t, sc;
      for (by = 0; by < rows; by++) {
        for (bx = 0; bx < cols; bx++) {
          if (!walkAt(bx, by)) continue;
          if (taken[by * cols + bx] || reserved[by * cols + bx]) continue;
          if (B.occ[by * cols + bx]) continue;
          sc = Math.abs(bx - fromX) + Math.abs(by - fromY) * 1.25 + (eastBias > 0 ? -bx * 3 : bx * 3);
          if (sc < bestScore) { bestScore = sc; best = { x: bx, y: by }; }
        }
      }
      return best;
    }

    function place(u, x2, y2) {
      u.x = x2; u.y = y2; u.vx = x2; u.vy = y2;
      B.occ[y2 * cols + x2] = u; taken[y2 * cols + x2] = 1;
    }

    /* The warband's first two ranks are reserved for the enemy line before any
     * banner is set down, so no sworn blade can end up standing where a foe is
     * about to appear. */
    if (walkAt(anchorX + 2, anchorY)) reserved[anchorY * cols + anchorX + 2] = 1;
    if (walkAt(anchorX + 2, anchorY + 1)) reserved[(anchorY + 1) * cols + anchorX + 2] = 1;

    var lead = mkUnit(BYID[squad[0]] || PLAY[0], 'player', anchorX, anchorY, 0);
    place(lead, anchorX, anchorY);
    B.units.push(lead); B.players.push(lead);

    /* Deployment spacing: every further banner takes the open tile that stands
     * furthest from the banners already sworn in — never a neighbour — and among
     * those prefers the ones nearest the muster point, so the warband reads as a
     * line rather than a pile. A vault too tight for that falls back to the
     * nearest free tile; the rule is "if the arena allows". */
    function spreadSpot() {
      var best = null, bestScore = -1e9, bx, by, md, sc, n, v, d;
      for (by = 0; by < rows; by++) {
        for (bx = 0; bx < cols; bx++) {
          if (!walkAt(bx, by) || taken[by * cols + bx] || reserved[by * cols + bx]) continue;
          if (B.occ[by * cols + bx]) continue;
          md = 99;
          for (n = 0; n < B.players.length; n++) {
            v = B.players[n];
            d = Math.abs(v.x - bx) + Math.abs(v.y - by);
            if (d < md) md = d;
          }
          if (md < 2) continue;
          sc = md * 12 - (Math.abs(bx - anchorX) + Math.abs(by - anchorY) * 1.4);
          if (sc > bestScore) { bestScore = sc; best = { x: bx, y: by }; }
        }
      }
      return best || freeNear(anchorX, anchorY, 0);
    }

    for (i = 1; i < 4; i++) {
      var spot = spreadSpot();
      if (!spot) break;
      var pu = mkUnit(BYID[squad[i]] || PLAY[i], 'player', spot.x, spot.y, i);
      place(pu, spot.x, spot.y);
      B.units.push(pu); B.players.push(pu);
    }

    /* enemy warband: 3, then 4, then 4 — drawn from the same record table and
     * banded by Wesnoth's own recruit cost, so the escalation is the source
     * game's price list rather than a hand-tuned difficulty curve */
    var band = stage === 0 ? [8, 14] : stage === 1 ? [11, 17] : [15, 21];
    var pool = [], k;
    for (k = 0; k < RECS.length; k++) {
      rec = RECS[k];
      if (rec.race === 'mechanical' || rec.race === 'ship') continue;
      if (rec.cost < band[0] || rec.cost > band[1]) continue;
      pool.push(rec);
    }
    if (!pool.length) pool = RECS.slice(0);
    var erng = GK.rand(777 + stage * 31);
    var nEnemy = stage === 0 ? 3 : 4;
    var picks = pool.slice(0), j, tmp;
    for (k = picks.length - 1; k > 0; k--) {
      j = Math.floor(erng() * (k + 1));
      tmp = picks[k]; picks[k] = picks[j]; picks[j] = tmp;
    }
    var foes = [];
    for (k = 0; k < nEnemy; k++) foes.push(picks[k % picks.length]);

    /* The first foe holds the reserved tile two cells east of the lead: the
     * player's opening order is one step then a strike, and that has to be real. */
    function enemySpot(wantX, wantY, fromX, fromY) {
      if (walkAt(wantX, wantY) && !taken[wantY * cols + wantX] && !B.occ[wantY * cols + wantX]) {
        return { x: wantX, y: wantY };
      }
      return freeNear(fromX, fromY, 1) || freeNear(anchorX, anchorY, 1);
    }

    var e0 = enemySpot(anchorX + 2, anchorY, anchorX + 3, anchorY);
    if (e0) {
      var u0 = mkUnit(foes[0], 'enemy', e0.x, e0.y, 0);
      place(u0, e0.x, e0.y);
      B.units.push(u0); B.enemies.push(u0);
    }
    var e1 = enemySpot(anchorX + 2, anchorY + 1, anchorX + 3, anchorY + 1);
    if (e1) {
      var u1 = mkUnit(foes[1], 'enemy', e1.x, e1.y, 1);
      place(u1, e1.x, e1.y);
      B.units.push(u1); B.enemies.push(u1);
    }
    for (i = 2; i < nEnemy; i++) {
      var es = freeNear(anchorX + 4, anchorY, 1) || freeNear(anchorX + 3, anchorY, 1);
      if (!es) break;
      var eu = mkUnit(foes[i], 'enemy', es.x, es.y, i);
      place(eu, es.x, es.y);
      B.units.push(eu); B.enemies.push(eu);
    }

    B.sel = lead;
    G.mode = 'battle';
    G.stage = stage;
    B.bakeDirty = true;
    layout();
    refreshHud();
    banner('BATTLE ' + roman(stage + 1) + ' \u2014 ' + STAGE_NAMES[stage], STAGE_SUB[stage], 2.4);
  }

  function roman(n) { return ['I', 'II', 'III', 'IV'][clamp(n - 1, 0, 3)]; }

  /* Vault ids are real filenames ("hangedman_swamp_blocks"); shown as a place
   * name on the HUD so provenance reads as setting, not as a debug string. */
  function prettyId(id) {
    var parts = String(id).split('_'), out = [], i, w;
    for (i = 0; i < parts.length; i++) {
      w = parts[i];
      if (!w) continue;
      out.push(w.charAt(0).toUpperCase() + w.slice(1));
    }
    return out.join(' ');
  }

  /* A menu needs a campaign object before any battle exists; without this the
   * title screen would swallow taps because G was still null. */
  function blankCampaign(mode) {
    return {
      mode: mode, stage: 0,
      squad: (G && G.squad && G.squad.length === 4) ? G.squad.slice() : DEFAULT_SQUAD.slice(),
      score: 0, kills: 0, totalKills: 0, battlesWon: 0,
      best: BEST_SCORE, wins: WINS, result: null, paused: false
    };
  }

  function newGame() {
    G = {
      mode: 'battle', stage: 0,
      /* a banner mustered on the title screen survives a restart, so the player
       * is not silently handed the default four after picking their own */
      squad: (G && G.squad && G.squad.length === 4) ? G.squad.slice() : DEFAULT_SQUAD.slice(),
      score: 0, kills: 0, totalKills: 0, battlesWon: 0,
      best: BEST_SCORE, wins: WINS, result: null, paused: false
    };
    startBattle(0);
    return true;
  }

  function bankProgress() {
    if (!G) return;
    BEST_SCORE = Math.max(BEST_SCORE, G.score);
    STORE.set('best', BEST_SCORE);
    STORE.set('runs', STORE.get('runs', 0) + 1);
    if (G.result && G.result.win) {
      WINS++;
      STORE.set('wins', WINS);
    }
    STORE.set('deepest', Math.max(STORE.get('deepest', 0), G.stage + 1));
  }

  /* ------------------------------------------------------------------ */
  /* movement + combat                                                   */
  /* ------------------------------------------------------------------ */
  function startWalk(u, tiles, wait) {
    u.path = tiles;
    u.pi = 0;
    u.pt = 0;
    u.walkWait = wait || 0;
    if (tiles && tiles.length) { u.vx = tiles[0].x; u.vy = tiles[0].y; }
  }

  function settleAnims() {
    if (!B) return;
    var i;
    for (i = 0; i < B.units.length; i++) {
      var u = B.units[i];
      u.walkWait = 0; u.path = null; u.atkT = 0;
      u.vx = u.x; u.vy = u.y;
    }
    for (i = 0; i < B.floats.length; i++) B.floats[i].delay = 0;
  }

  function moveAlong(u, tiles, wait) {
    if (!tiles || tiles.length < 2) return false;
    var last = tiles[tiles.length - 1];
    B.fldDirty = true; B.fv++;
    B.occ[u.y * B.cols + u.x] = null;
    u.x = last.x; u.y = last.y;
    B.occ[u.y * B.cols + u.x] = u;
    startWalk(u, tiles, wait);
    return true;
  }

  function stepUnit(u, dx, dy) {
    if (!u || !u.alive || u.mp <= 0) return false;
    var nx = u.x + dx, ny = u.y + dy;
    if (!walkAt(nx, ny) || occUnit(nx, ny)) return false;
    B.fldDirty = true; B.fv++;
    B.occ[u.y * B.cols + u.x] = null;
    u.x = nx; u.y = ny;
    B.occ[ny * B.cols + nx] = u;
    u.mp--;
    startWalk(u, [{ x: nx, y: ny }], 0);
    u.vx = nx - dx; u.vy = ny - dy;
    GK.sfx.step();
    refreshHud();
    return true;
  }

  function moveTo(u, tx, ty) {
    if (!u || !u.alive || u.mp <= 0 || !walkAt(tx, ty) || occUnit(tx, ty)) return false;
    var field = bfsField(u.x, u.y, true);
    var d = field.dist[ty * B.cols + tx];
    if (d < 0 || d > u.mp) return false;
    var path = pathTiles(field, tx, ty);
    if (!path || path.length < 2) return false;
    u.mp -= (path.length - 1);
    moveAlong(u, path, 0);
    B.dispatch = u.short.toUpperCase() + ' ADVANCES';
    GK.sfx.step();
    refreshHud();
    return true;
  }

  function spawnFloat(x, y, text, col, size, delay) {
    var f = null, i;
    for (i = 0; i < B.floats.length; i++) if (!B.floats[i].on) { f = B.floats[i]; break; }
    if (!f) {
      if (B.floats.length > 30) return;
      f = { on: false };
      B.floats.push(f);
    }
    f.on = true; f.x = x; f.y = y; f.t = 0; f.life = 1.15;
    f.vy = -34; f.text = text; f.col = col; f.size = size || 13; f.delay = delay || 0;
  }

  function addCorpse(u) {
    if (B.corpses.length > 14) B.corpses.shift();
    B.corpses.push({ x: u.x, y: u.y, side: u.side, t: 0 });
  }

  function killUnit(u, killer) {
    if (!u.alive) return;
    u.alive = false;
    u.hp = 0;
    B.fldDirty = true; B.fv++;
    B.occ[u.y * B.cols + u.x] = null;
    addCorpse(u);
    if (u.side === 'enemy') {
      B.kills++;
      G.score += 150;
      G.kills++;
      G.totalKills++;
    }
    if (B.sel === u) B.sel = null;
    if (B.target === u) B.target = null;
    B.dispatch = u.short.toUpperCase() + ' FALLS';
    spawnFloat(u.x, u.y, '\u271D', C.banner, 17, 0.15);
    GK.sfx.boom();
    refreshHud();
  }

  function resolveAttack(u, t, a, delay) {
    if (!u || !t || !u.alive || !t.alive) return false;
    if (!a) a = bestAttack(u, t);
    if (!a) return false;
    u.acted = true;
    u.mp = 0;
    u.atkT = 1;
    u.atkDx = Math.sign(t.x - u.x); u.atkDy = Math.sign(t.y - u.y);
    var p = hitChance(t);
    var hits = 0, dmg = 0, i;
    for (i = 0; i < a.number; i++) if (B.rng() < p) { hits++; dmg += a.damage; }
    B.fights++;
    t.flash = 1;
    B.dispatch = u.short.toUpperCase() + ' \u2192 ' + t.short.toUpperCase() + ' \u00B7 ' + (dmg > 0 ? dmg + ' DMG' : 'BLOCKED');
    if (dmg > 0) {
      t.hp -= dmg;
      spawnFloat(t.x, t.y, '-' + dmg, u.side === 'player' ? C.gold : C.bad, dmg >= 12 ? 16 : 13, delay);
      if (u.side === 'player') GK.sfx.hit(); else GK.sfx.hurt();
      if (dmg >= 14) B.shake = Math.min(5, 2 + dmg * 0.08);
    } else {
      spawnFloat(t.x, t.y, 'BLOCKED', C.steel, 11, delay);
      GK.sfx.step();
    }
    if (t.hp <= 0) killUnit(t, u);
    refreshHud();
    checkBattle();
    return true;
  }

  function checkBattle() {
    if (!B || !G || G.mode !== 'battle') return;
    var enemiesAlive = 0, playersAlive = 0, i;
    for (i = 0; i < B.enemies.length; i++) if (B.enemies[i].alive) enemiesAlive++;
    for (i = 0; i < B.players.length; i++) if (B.players[i].alive) playersAlive++;
    if (enemiesAlive === 0 && playersAlive > 0) {
      G.score += 250 + playersAlive * 40;
      G.battlesWon++;
      if (G.stage >= 2) finishCampaign(true);
      else { G.stage++; G.mode = 'campaign'; }
      refreshHud();
    } else if (playersAlive === 0) {
      finishCampaign(false);
    }
  }

  function finishCampaign(win) {
    if (!G) return;
    var s = 0, i;
    if (B) for (i = 0; i < B.players.length; i++) if (B.players[i].alive) s++;
    G.result = { win: win, score: G.score, kills: G.totalKills, survivors: s, stage: G.stage };
    G.mode = 'result';
    bankProgress();
    if (win) GK.sfx.win(); else GK.sfx.lose();
  }

  /* Enemy phase is computed in one pass, then played back as animation. The logic
   * must not wait on the frame clock: the battle is already the player's when the
   * last arrow lands, and a scripted driver can keep marching. */
  function runEnemyPhase() {
    var i, j;
    for (i = 0; i < B.enemies.length; i++) {
      var u = B.enemies[i];
      if (!u.alive) continue;
      u.acted = false;
      u.mp = u.maxMp;
      var target = nearestPlayer(u);
      if (!target) break;
      var a = bestAttack(u, target);
      if (!a) {
        var path = pathTo(u, target);
        if (path && path.length > 2) {
          var stop = path.length - 1, k;
          for (k = 1; k < path.length; k++) {
            if (canStrikeFrom(u, path[k].x, path[k].y, target)) { stop = k; break; }
          }
          var steps = Math.min(u.mp, stop);
          if (steps > 0) {
            var tiles = path.slice(0, steps + 1);
            u.mp -= steps;
            moveAlong(u, tiles, i * 0.16);
          }
        }
        a = bestAttack(u, target);
      }
      if (a) resolveAttack(u, target, a, i * 0.22 + 0.18);
      if (G.mode !== 'battle') break;
    }
    for (j = 0; j < B.players.length; j++) if (B.players[j].alive) B.players[j].flash = 0;
  }

  function nearestPlayer(u) {
    var best = null, bestD = 1e9, i, v, d;
    var field = bfsField(u.x, u.y, false);
    for (i = 0; i < B.players.length; i++) {
      v = B.players[i];
      if (!v.alive) continue;
      d = field.dist[v.y * B.cols + v.x];
      if (d < 0) d = manhattan(u.x, u.y, v.x, v.y) + 100;
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  }

  function pathTo(u, target) {
    var field = bfsField(u.x, u.y, true);
    var best = null, bestD = 1e9, i;
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (i = 0; i < 4; i++) {
      var nx = target.x + dirs[i][0], ny = target.y + dirs[i][1];
      if (!walkAt(nx, ny) || occUnit(nx, ny)) continue;
      var d = field.dist[ny * B.cols + nx];
      if (d >= 0 && d < bestD) { bestD = d; best = { x: nx, y: ny }; }
    }
    if (!best) return null;
    return pathTiles(field, best.x, best.y);
  }

  function endTurn() {
    if (!B || !G || G.mode !== 'battle' || B.phase !== 'player') return false;
    settleAnims();
    B.phase = 'enemy';
    runEnemyPhase();
    if (G.mode !== 'battle') return true;
    B.turn++;
    B.phase = 'player';
    var i;
    for (i = 0; i < B.players.length; i++) {
      var u = B.players[i];
      if (!u.alive) continue;
      u.mp = u.maxMp; u.acted = false;
    }
    var pick = null;
    for (i = 0; i < B.players.length; i++) {
      if (B.players[i].alive && B.players[i].mp > 0) { pick = B.players[i]; break; }
    }
    B.sel = pick || B.players[0] || null;
    B.target = null;
    B.dispatch = 'THE WARBAND REFORMS \u00B7 TURN ' + B.turn;
    refreshHud();
    banner('TURN ' + B.turn + ' \u2014 YOUR MARCH', 'Tap a banner, then a tile', 1.6);
    GK.sfx.coin();
    return true;
  }

  function selectUnit(u) {
    if (!u || !u.alive) return false;
    B.sel = u;
    B.target = null;
    GK.sfx.coin();
    refreshHud();
    return true;
  }

  function previewLine(u, t) {
    var a = bestAttack(u, t);
    if (!a) return '';
    var hc = Math.round(hitChance(t) * 100);
    var exp = Math.round(a.damage * a.number * hitChance(t));
    return a.name.toUpperCase() + ' ' + a.damage + '\u00D7' + a.number + ' \u00B7 ' + hc + '% \u00B7 ~' + exp;
  }

  /* ------------------------------------------------------------------ */
  /* layout                                                              */
  /* ------------------------------------------------------------------ */
  var L = {
    W: 390, H: 844, land: false, topH: 76, tile: 24,
    arenaBox: { x: 10, y: 76, w: 370, h: 500 },
    arena: { x: 10, y: 80, w: 360, h: 360 },
    panel: { x: 8, y: 600, w: 374, h: 238 },
    cards: [], detail: { x: 0, y: 0, w: 0, h: 0 },
    btnEnd: { x: 0, y: 0, w: 0, h: 0 }, btnStrike: { x: 0, y: 0, w: 0, h: 0 },
    btnPause: { x: 0, y: 0, w: 0, h: 0 }, btnSound: { x: 0, y: 0, w: 0, h: 0 },
    cardW: 80, cardH: 64, credits: [], musterCards: [], campaignNodes: []
  };

  function buildMuster() {
    var W = L.W, H = L.H, cols = 3, pad = 16, gap = 8;
    var cw = (W - pad * 2 - gap * (cols - 1)) / cols;
    var ch = Math.min(96, (H - 200) / 4 - gap);
    var top = 78, i;
    L.musterCards.length = 0;
    for (i = 0; i < PLAY.length && i < 12; i++) {
      var col = i % cols, row = Math.floor(i / cols);
      L.musterCards.push({ x: pad + col * (cw + gap), y: top + row * (ch + gap), w: cw, h: ch, rec: PLAY[i] });
    }
    L.cardW = cw; L.cardH = ch;
  }

  function buildCampaign() {
    var W = L.W, H = L.H, top = H * 0.16, step = (H * 0.52) / 3;
    L.campaignNodes.length = 0;
    for (var i = 0; i < 3; i++) {
      var nx = W * (i % 2 === 0 ? 0.34 : 0.64), ny = top + i * step;
      L.campaignNodes.push({ x: nx, y: ny, w: 116, h: 60 });
    }
  }

  /* The camera only exists for vaults taller than the board: it follows the
   * chosen banner and eases after it, so a tall crypt is walked rather than
   * squeezed. A board that fits is simply centred and camY stays 0. */
  function placeCamera(snap, dt) {
    if (!B) return;
    var A = L.arena, bx = L.arenaBox;
    var viewH = Math.max(40, bx.h - 20);
    var slack = viewH - A.h;
    if (B.camMax <= 0 || slack >= 0) {
      B.camY = 0;
      A.y = Math.round(bx.y + 10 + Math.max(0, slack) * 0.5);
      return;
    }
    var u = (B.sel && B.sel.alive) ? B.sel : (B.players.length ? B.players[0] : null);
    var want = u ? clamp((u.vy + 0.5) * L.tile - viewH * 0.5, 0, B.camMax) : B.camY;
    if (snap) B.camY = want;
    else B.camY += (want - B.camY) * clamp((dt || 0) * 5, 0, 1);
    A.y = Math.round(bx.y + 10 - B.camY);
  }

  function layout() {
    var W = L.W, H = L.H;
    var land = W > H * 1.12;
    L.land = land;
    L.topH = land ? 48 : 88;
    if (land) {
      var pw = clamp(W * 0.32, 232, 320);
      L.panel.x = Math.round(W - pw - 8); L.panel.y = 6;
      L.panel.w = Math.round(pw); L.panel.h = H - 12;
      /* the HUD owns a strip above the field in landscape too, otherwise the turn
       * counter would be painted straight over the board */
      L.arenaBox.x = 8; L.arenaBox.y = L.topH; L.arenaBox.w = L.panel.x - 16;
      L.arenaBox.h = H - L.topH - 6;
    } else {
      /* panel height is derived from its content, not from the viewport, so a
       * short phone can never push the action buttons over the detail block */
      var ph = 242;
      L.panel.x = 6; L.panel.y = Math.round(H - ph - 6);
      L.panel.w = W - 12; L.panel.h = ph;
      L.arenaBox.x = 10; L.arenaBox.y = L.topH;
      L.arenaBox.w = W - 20; L.arenaBox.h = L.panel.y - L.topH - 10;
    }

    if (B) {
      /* Cell size comes from the width alone, because width is what a phone in
       * portrait cannot borrow. A vault taller than the board is not shrunk to
       * fit — the camera slides down it instead, so a 9-wide vault gets 38px
       * cells rather than the 22px it would get squeezed to. */
      var boxW = Math.max(60, L.arenaBox.w - 20), boxH = Math.max(60, L.arenaBox.h - 20);
      var tile = clamp(Math.floor(boxW / B.cols), 14, 46);
      var aw = tile * B.cols, ah = tile * B.rows;
      L.tile = tile;
      B.tile = tile;
      B.camMax = Math.max(0, ah - boxH);
      B.camY = clamp(B.camY, 0, B.camMax);
      L.arena.w = aw; L.arena.h = ah;
      L.arena.x = Math.round(L.arenaBox.x + (L.arenaBox.w - aw) * 0.5);
      L.arena.y = Math.round(L.arenaBox.y + (L.arenaBox.h - ah) * 0.5);
      placeCamera(true);
      if (L.arena.w !== B.bakeW || L.arena.h !== B.bakeH) B.bakeDirty = true;
    }

    var P = L.panel, pad = 10;
    L.cards.length = 0;
    if (land) {
      /* landscape: one column of four, so a full Wesnoth name always fits */
      var chL = H >= 380 ? 48 : clamp((H - 230) / 4, 32, 48), gL = 5;
      L.cardW = P.w - pad * 2; L.cardH = chL;
      for (var a = 0; a < 4; a++) {
        L.cards.push({ x: P.x + pad, y: P.y + pad + a * (chL + gL), w: L.cardW, h: chL });
      }
      L.detail.x = P.x + pad;
      L.detail.y = P.y + pad + 4 * chL + 3 * gL + 10;
      L.detail.w = P.w - pad * 2; L.detail.h = 54;
    } else {
      /* portrait: a 2x2 roster gives each name 160px, and the portraits read
       * larger than four cramped strips ever could */
      var gP = 8, cwP = (P.w - pad * 2 - gP) / 2, chP = 54;
      L.cardW = cwP; L.cardH = chP;
      for (var b = 0; b < 4; b++) {
        L.cards.push({
          x: P.x + pad + (b % 2) * (cwP + gP),
          y: P.y + pad + Math.floor(b / 2) * (chP + 6),
          w: cwP, h: chP
        });
      }
      L.detail.x = P.x + pad;
      L.detail.y = P.y + pad + 2 * chP + 6 + 8;
      L.detail.w = P.w - pad * 2; L.detail.h = 48;
    }

    var bh = land ? 42 : 44;
    L.btnEnd.h = bh;
    L.btnStrike.h = bh;
    if (land) {
      var bwL = (P.w - pad * 2 - 8) / 2;
      L.btnStrike.w = bwL; L.btnStrike.x = P.x + pad;
      L.btnEnd.w = bwL; L.btnEnd.x = P.x + pad + bwL + 8;
      L.btnStrike.y = P.y + P.h - pad - bh; L.btnEnd.y = L.btnStrike.y;
    } else {
      var bwP = 112;
      L.btnEnd.w = bwP; L.btnEnd.x = P.x + P.w - pad - bwP;
      L.btnStrike.w = bwP; L.btnStrike.x = L.btnEnd.x - 8 - bwP;
      L.btnEnd.y = P.y + P.h - pad - bh; L.btnStrike.y = L.btnEnd.y;
    }

    if (land) {
      L.btnPause = { x: L.panel.x - 46, y: 7, w: 32, h: 32 };
      L.btnSound = { x: L.panel.x - 84, y: 7, w: 32, h: 32 };
    } else {
      L.btnPause = { x: W - 44, y: 12, w: 34, h: 34 };
      L.btnSound = { x: W - 84, y: 12, w: 34, h: 34 };
    }

    L.credits = [
      'Unit rules, sprites, portraits, terrain: Battle for Wesnoth',
      '(GPL-2.0 / CC-BY-SA-4.0). Arena layouts: Dungeon Crawl',
      'Stone Soup (CC0).'
    ];
    buildMuster();
    buildCampaign();
  }

  /* ------------------------------------------------------------------ */
  /* arena baking                                                        */
  /* ------------------------------------------------------------------ */
  function sizeLayer(cv, w, h, dpr) {
    if (!cv) cv = document.createElement('canvas');
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    return cv;
  }

  /* Three layers, each baked once per battle and per resize: floors and walls
   * (bake), the movement wash (ovl), and one detail sheet carrying the decals,
   * the grid and the vignette (deco). Per frame that is three blits, and the
   * walkable wash sits *under* the decal outlines without any of them being
   * repainted — the one two-pass draw in the game that earns its keep. */
  function rebake() {
    if (!B || !L.tile) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = Math.max(1, Math.round(L.arena.w)), h = Math.max(1, Math.round(L.arena.h));
    B.bakeW = w; B.bakeH = h;
    B.bake = sizeLayer(B.bake, w, h, dpr);
    B.deco = sizeLayer(B.deco, w, h, dpr);
    var g = B.bake.getContext('2d'), d = B.deco.getContext('2d');
    /* decals and grid share one sheet: the grid is painted after the decals, so
     * the ordering the two-pass draw needs is kept and one blit is saved */
    var q = d;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    d.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h); d.clearRect(0, 0, w, h);

    var ts = L.tile, x, y, px, py, i, k, ch, feat, fd, t;
    var vg, csh;

    /* one contact-shadow gradient, reused for every stamped object */
    csh = g.createRadialGradient(0, 0, 0, 0, 0, ts * 0.5);
    csh.addColorStop(0, 'rgba(0,0,0,0.35)');
    csh.addColorStop(0.58, 'rgba(0,0,0,0.18)');
    csh.addColorStop(1, 'rgba(0,0,0,0)');

    /* ---- pass 1: floors, walls, the shadow each decal casts -------------- */
    for (y = 0; y < B.rows; y++) {
      for (x = 0; x < B.cols; x++) {
        px = x * ts; py = y * ts;
        ch = B.grid[y].charAt(x);
        if (!walkableChar(ch)) {
          if (ch === '#') {
            g.fillStyle = ((x * 7 + y * 13) & 2) ? '#0b0f12' : '#0d1115';
            g.fillRect(px, py, ts, ts);
            g.fillStyle = '#151c22';
            g.fillRect(px, py, ts, Math.max(2, ts * 0.1));
            g.fillStyle = 'rgba(159,184,200,0.07)';
            g.fillRect(px + ts * 0.12, py + ts * 0.12, ts * 0.76, 1);
            g.strokeStyle = 'rgba(0,0,0,0.45)';
            g.lineWidth = 1;
            g.strokeRect(px + 0.5, py + 0.5, ts - 1, ts - 1);
            g.strokeStyle = 'rgba(107,127,139,0.10)';
            g.beginPath();
            g.moveTo(px + ts * 0.5, py + ts * 0.32); g.lineTo(px + ts, py + ts * 0.32);
            g.moveTo(px, py + ts * 0.68); g.lineTo(px + ts * 0.5, py + ts * 0.68);
            g.stroke();
          } else {
            g.fillStyle = '#07090b';
            g.fillRect(px, py, ts, ts);
          }
          continue;
        }
        g.fillStyle = ((x + y) & 1) ? '#1d252c' : '#1a2229';
        g.fillRect(px, py, ts, ts);
        g.fillStyle = 'rgba(159,184,200,0.05)';
        g.fillRect(px, py, ts, Math.max(1, Math.round(ts * 0.07)));
        i = y * B.cols + x;
        feat = B.feat[i];
        if (feat > 0) {
          fd = FEATS[feat - 1];
          g.save();
          g.translate(px + ts * 0.5, py + ts * 0.88);
          g.scale(1, 0.44);
          g.fillStyle = csh;
          g.beginPath(); g.arc(0, 0, ts * 0.48, 0, TAU); g.fill();
          g.restore();
          g.fillStyle = fd.tint;
          g.globalAlpha = 0.14;
          g.fillRect(px, py, ts, ts);
          g.globalAlpha = 1;
        }
      }
    }

    /* ---- pass 2: decals, doors and stairs -------------------------------- */
    d.imageSmoothingEnabled = true;
    if (d.imageSmoothingQuality) d.imageSmoothingQuality = 'high';
    for (y = 0; y < B.rows; y++) {
      for (x = 0; x < B.cols; x++) {
        ch = B.grid[y].charAt(x);
        if (!walkableChar(ch)) continue;
        px = x * ts; py = y * ts;
        i = y * B.cols + x;
        feat = B.feat[i];
        if (feat > 0) {
          t = TERRAIN[feat - 1];
          var ins = Math.max(0, ts * 0.02), sz = ts - ins * 2;
          if (t && t.img) {
            d.globalAlpha = 0.86;
            d.drawImage(t.img, px + ins, py + ins, sz, sz);
            d.globalAlpha = 1;
            /* one darker pixel along the sprite's foot: the decal gets a base
             * instead of floating a hair above the floor */
            d.fillStyle = 'rgba(0,0,0,0.42)';
            d.fillRect(px + ins, py + ins + sz - 1, sz, 1);
          } else {
            drawFeatureFallback(d, FEATS[feat - 1], px, py, ts);
          }
          if (B.cover[i] >= 0.15) {
            d.fillStyle = 'rgba(232,193,104,0.55)';
            d.beginPath();
            d.arc(px + ts * 0.87, py + ts * 0.87, Math.max(1.2, ts * 0.06), 0, TAU);
            d.fill();
          }
        }
        if (ch === '+') {
          d.fillStyle = '#2a353d';
          d.fillRect(px + ts * 0.18, py + ts * 0.18, ts * 0.64, ts * 0.64);
          d.strokeStyle = C.goldDim; d.lineWidth = Math.max(1, ts * 0.05);
          d.beginPath(); d.arc(px + ts * 0.5, py + ts * 0.5, ts * 0.26, Math.PI, TAU); d.stroke();
        } else if (ch === '>') {
          d.strokeStyle = 'rgba(232,193,104,0.75)'; d.lineWidth = Math.max(1.2, ts * 0.06);
          for (k = 0; k < 3; k++) {
            d.beginPath();
            d.moveTo(px + ts * (0.22 + k * 0.1), py + ts * 0.66);
            d.lineTo(px + ts * 0.5, py + ts * (0.38 - k * 0.08));
            d.lineTo(px + ts * (0.78 - k * 0.1), py + ts * 0.66);
            d.stroke();
          }
        }
      }
    }

    /* ---- pass 3: wall occlusion, one grid, vignette ---------------------- */
    for (y = 0; y < B.rows; y++) {
      for (x = 0; x < B.cols; x++) {
        if (!walkableChar(B.grid[y].charAt(x))) continue;
        px = x * ts; py = y * ts;
        if (!walkAt(x, y - 1)) {
          q.fillStyle = 'rgba(0,0,0,0.34)'; q.fillRect(px, py, ts, 1);
          q.fillStyle = 'rgba(0,0,0,0.12)'; q.fillRect(px, py + 1, ts, 2);
        }
        if (!walkAt(x, y + 1)) {
          q.fillStyle = 'rgba(0,0,0,0.34)'; q.fillRect(px, py + ts - 1, ts, 1);
          q.fillStyle = 'rgba(0,0,0,0.12)'; q.fillRect(px, py + ts - 3, ts, 2);
        }
        if (!walkAt(x - 1, y)) {
          q.fillStyle = 'rgba(0,0,0,0.34)'; q.fillRect(px, py, 1, ts);
          q.fillStyle = 'rgba(0,0,0,0.12)'; q.fillRect(px + 1, py, 2, ts);
        }
        if (!walkAt(x + 1, y)) {
          q.fillStyle = 'rgba(0,0,0,0.34)'; q.fillRect(px + ts - 1, py, 1, ts);
          q.fillStyle = 'rgba(0,0,0,0.12)'; q.fillRect(px + ts - 3, py, 2, ts);
        }
      }
    }
    /* every walkable tile contributes its top and left edge only, so each
     * interior line is laid down exactly once and the grid is even everywhere */
    q.beginPath();
    for (y = 0; y < B.rows; y++) {
      for (x = 0; x < B.cols; x++) {
        if (!walkableChar(B.grid[y].charAt(x))) continue;
        px = x * ts; py = y * ts;
        q.moveTo(px + 0.5, py); q.lineTo(px + 0.5, py + ts);
        q.moveTo(px, py + 0.5); q.lineTo(px + ts, py + 0.5);
      }
    }
    q.lineWidth = 1;
    q.strokeStyle = 'rgba(0,0,0,0.18)';
    q.stroke();
    q.strokeStyle = 'rgba(232,193,104,0.10)';
    q.stroke();

    vg = q.createRadialGradient(w * 0.5, h * 0.46, Math.min(w, h) * 0.20,
      w * 0.5, h * 0.5, Math.max(w, h) * 0.74);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.36)');
    q.fillStyle = vg;
    q.fillRect(0, 0, w, h);

    q.strokeStyle = 'rgba(159,184,200,0.30)';
    q.lineWidth = 1;
    q.strokeRect(0.5, 0.5, w - 1, h - 1);
    B.bakeDirty = false;
  }

  /* The walkable wash, baked whenever the selection, its footing, its movement
   * or the cell size changes — never per frame. Inset by a pixel so the grid
   * keeps reading underneath, and with a dot at each tile's centre so a reachable
   * square says "step here" without painting a block of colour over the terrain. */
  function buildOverlay() {
    if (!B || !L.tile) return;
    var sel = B.sel;
    B.ovlKey = ovlKey();
    B.ovlOn = !!(sel && sel.alive && sel.mp > 0 && B.phase === 'player' && G && G.mode === 'battle');
    if (!B.ovlOn) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = Math.max(1, Math.round(L.arena.w)), h = Math.max(1, Math.round(L.arena.h));
    B.ovl = sizeLayer(B.ovl, w, h, dpr);
    var o = B.ovl.getContext('2d');
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.clearRect(0, 0, w, h);
    var field = fieldFor(sel), ts = L.tile, x, y, i, d;
    for (y = 0; y < B.rows; y++) {
      for (x = 0; x < B.cols; x++) {
        i = y * B.cols + x;
        d = field.dist[i];
        if (d <= 0 || d > sel.mp || B.occ[i]) continue;
        o.fillStyle = 'rgba(232,193,104,0.12)';
        o.fillRect(x * ts + 1, y * ts + 1, ts - 2, ts - 2);
        o.strokeStyle = 'rgba(232,193,104,0.55)';
        o.lineWidth = 1;
        o.strokeRect(x * ts + 1.5, y * ts + 1.5, ts - 3, ts - 3);
        o.fillStyle = 'rgba(232,193,104,0.40)';
        o.beginPath();
        o.arc(x * ts + ts * 0.5, y * ts + ts * 0.5, Math.max(1.1, ts * 0.055), 0, TAU);
        o.fill();
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* drawing helpers                                                     */
  /* ------------------------------------------------------------------ */
  var BG = null, BGW = 0, BGH = 0;
  function drawBackdrop(ctx) {
    if (!BG || BGW !== L.W || BGH !== L.H) {
      BG = document.createElement('canvas');
      BGW = L.W; BGH = L.H;
      BG.width = Math.max(1, BGW); BG.height = Math.max(1, BGH);
      var g = BG.getContext('2d');
      var grad = g.createLinearGradient(0, 0, 0, BGH);
      grad.addColorStop(0, '#12181d');
      grad.addColorStop(0.55, '#0d1013');
      grad.addColorStop(1, '#080b0d');
      g.fillStyle = grad; g.fillRect(0, 0, BGW, BGH);
      g.strokeStyle = 'rgba(159,184,200,0.028)';
      g.lineWidth = 1;
      for (var i = -BGH; i < BGW; i += 26) {
        g.beginPath(); g.moveTo(i, 0); g.lineTo(i + BGH, BGH); g.stroke();
      }
      var vg = g.createRadialGradient(BGW * 0.5, BGH * 0.38, BGH * 0.12, BGW * 0.5, BGH * 0.5, BGH * 0.72);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,0,0,0.55)');
      g.fillStyle = vg; g.fillRect(0, 0, BGW, BGH);
    }
    ctx.drawImage(BG, 0, 0, L.W, L.H);
  }

  /* Ground marker: a radial glow with a transparent centre and a coloured rim,
   * so the tile's own art still reads through it. Cached per radius — the
   * gradient is built at the origin and the fill is translated into place, so
   * no frame allocates one. */
  var GLOWS = {};
  function groundGlow(ctx, rgb, r, rim) {
    var k = rgb + '|' + (r | 0) + '|' + rim;
    var g = GLOWS[k];
    if (!g) {
      g = ctx.createRadialGradient(0, 0, r * 0.26, 0, 0, r);
      g.addColorStop(0, 'rgba(' + rgb + ',0)');
      g.addColorStop(0.55, 'rgba(' + rgb + ',' + (rim * 0.45).toFixed(3) + ')');
      g.addColorStop(0.88, 'rgba(' + rgb + ',' + rim.toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + rgb + ',0)');
      GLOWS[k] = g;
    }
    return g;
  }

  function drawGround(ctx, u, cx, cy, ts, selected) {
    var enemy = u.side === 'enemy';
    var rgb = enemy ? '210,75,63' : '232,193,104';
    var r = ts * 0.62;
    var rim = selected ? 0.44 : (u.hp < u.maxHp || u.acted) ? 0.20 : 0.13;
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, ts * 0.23, ts * 0.095, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = groundGlow(ctx, rgb, ts * 1.05, selected ? 0.16 : 0.10);
    ctx.beginPath();
    ctx.arc(cx, cy - ts * 0.42, ts * 1.05, 0, TAU);
    ctx.fill();
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, 0.44);
    ctx.fillStyle = groundGlow(ctx, rgb, r, rim);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(' + rgb + ',' + (selected ? 0.52 : 0.20) + ')';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy, ts * 0.62, ts * 0.62 * 0.44, 0, 0, TAU);
    ctx.stroke();
  }

  /* One Wesnoth frame, never the whole strip. A unit PNG is a horizontal sheet
   * of square frames (cell = image height) and the painted figure fills only the
   * middle ~60% of its frame, so the frame is drawn 2.4 cells tall to land the
   * body at roughly 1.5 cells. Bilinear is the correct filter for painted art;
   * nearest-neighbour is what made these look muddy. */
  function drawUnitSprite(ctx, u, cx, cy, ts, t) {
    var art = IMG[u.rec.id];
    var H = ts * 2.6;
    var bob = Math.sin(t * 1.6 + u.bob) * ts * 0.022;
    var ox = 0, oy = 0;
    if (u.atkT > 0) {
      var push = Math.sin((1 - u.atkT) * Math.PI) * 0.22;
      ox = u.atkDx * push * ts;
      oy = u.atkDy * push * ts;
    }
    ctx.save();
    ctx.globalAlpha = u.acted ? 0.70 : 1;
    if (art && art.uok && art.u) {
      var cell = art.u.height || 1;
      var n = Math.max(1, Math.floor(art.u.width / cell));
      var fr = 0;
      if (n > 1 && u.path) fr = (Math.floor(t * 7) + u.slot) % n;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(art.u, fr * cell, 0, cell, cell,
        cx - H * 0.5 + ox, cy - H * 0.93 + oy + bob, H, H);
    } else {
      drawUnitFallback(ctx, u.rec.race, cx + ox, cy - ts * 0.67 + oy + bob, ts * 1.45, u.side);
    }
    ctx.restore();

    if (u.flash > 0) {
      ctx.fillStyle = 'rgba(255,235,200,' + (u.flash * 0.20).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(cx, cy - ts * 0.48, ts * 0.48, 0, TAU); ctx.fill();
    }
  }

  /* A 2px strip at the unit's feet, never wider than 26px: a status line, not a
   * scoreboard. Held at 65% until the banner is chosen or has taken a hit. */
  function drawUnitBars(ctx, u, cx, cy, ts) {
    if (!u.alive) return;
    var w = Math.min(26, ts * 0.80);
    var x = Math.round(cx - w * 0.5), y = Math.round(cy + 2);
    var pct = clamp(u.hp / u.maxHp, 0, 1);
    var lit = (u === B.sel) || u.hp < u.maxHp;
    ctx.globalAlpha = lit ? 1 : 0.65;
    ctx.fillStyle = 'rgba(6,9,11,0.55)';
    ctx.fillRect(x - 1, y - 1, Math.round(w) + 2, 4);
    ctx.fillStyle = pct > 0.55 ? C.good : pct > 0.28 ? C.gold : C.banner;
    ctx.fillRect(x, y, Math.max(0.5, w * pct), 2);
    ctx.globalAlpha = 1;
  }

  function drawHpBar(ctx, x, y, w, h, pct, col) {
    ctx.fillStyle = 'rgba(4,7,9,0.9)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(159,184,200,0.18)';
    ctx.fillRect(x, y, w, 1);
    ctx.fillStyle = col;
    ctx.fillRect(x, y, w * clamp(pct, 0, 1), h);
  }

  function drawPortrait(ctx, u, x, y, w, h) {
    var art = IMG[u.rec.id];
    ctx.save();
    roundRect(ctx, x, y, w, h, Math.min(w, h) * 0.14);
    ctx.clip();
    if (art && art.pok && art.p) {
      ctx.drawImage(art.p, x, y - h * 0.06, w, h * 1.08);
    } else {
      drawBustFallback(ctx, u.rec, x, y, w, h);
    }
    var g = ctx.createLinearGradient(x, y + h * 0.55, x, y + h);
    g.addColorStop(0, 'rgba(10,13,16,0)');
    g.addColorStop(1, 'rgba(10,13,16,0.92)');
    ctx.fillStyle = g; ctx.fillRect(x, y + h * 0.55, w, h * 0.45);
    ctx.restore();
  }

  function drawHud(ctx) {
    if (!B || !G) return;
    var W = L.W, plateW = L.land ? L.panel.x - 8 : W;
    ctx.fillStyle = 'rgba(9,13,16,0.80)';
    ctx.fillRect(0, 0, plateW, L.topH - 4);
    ctx.fillStyle = 'rgba(232,193,104,0.22)';
    ctx.fillRect(0, L.topH - 4, plateW, 1);

    if (L.land) {
      txt(ctx, 'WARDENMARCH', 12, 18, FS.label, C.gold, 'left');
      txt(ctx, 'BATTLE ' + roman(B.stage + 1) + ' OF III', 12, 34, FS.micro, C.dim, 'left');
      txt(ctx, B.hudTurn, plateW * 0.5, 20, FS.h3, C.ink, 'center');
      txt(ctx, B.hudFoes, plateW - 92, 20, FS.small, C.banner, 'right');
      txt(ctx, 'SCORE ' + B.scoreStr, plateW - 92, 34, FS.micro, C.dim, 'right');
    } else {
      txt(ctx, 'WARDENMARCH', 12, 19, FS.label, C.gold, 'left');
      txt(ctx, 'BATTLE ' + roman(B.stage + 1) + ' OF III', 12, 33, FS.micro, C.dim, 'left');
      txt(ctx, 'SCORE', W - 96, 17, FS.micro, C.dim, 'right');
      txt(ctx, B.scoreStr, W - 96, 32, FS.monoB, C.ink, 'right');
      txt(ctx, B.hudTurn, 12, 54, FS.h3, C.ink, 'left');
      txt(ctx, B.hudFoes, W - 96, 54, FS.small, C.banner, 'right');
      txt(ctx, fitText(ctx, B.vaultLine, W - 24, FS.micro), 12, 72, FS.micro, 'rgba(107,127,139,0.9)', 'left');
    }

    var pb = L.btnPause;
    roundRect(ctx, pb.x, pb.y, pb.w, pb.h, 8);
    ctx.fillStyle = 'rgba(159,184,200,0.08)'; ctx.fill();
    ctx.strokeStyle = 'rgba(159,184,200,0.30)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = C.steel;
    ctx.fillRect(pb.x + pb.w * 0.34, pb.y + pb.h * 0.30, Math.max(2, pb.w * 0.09), pb.h * 0.40);
    ctx.fillRect(pb.x + pb.w * 0.56, pb.y + pb.h * 0.30, Math.max(2, pb.w * 0.09), pb.h * 0.40);

    var sb = L.btnSound;
    roundRect(ctx, sb.x, sb.y, sb.w, sb.h, 8);
    ctx.fillStyle = ambOn ? 'rgba(232,193,104,0.10)' : 'rgba(159,184,200,0.05)'; ctx.fill();
    ctx.strokeStyle = ambOn ? 'rgba(232,193,104,0.40)' : 'rgba(159,184,200,0.22)'; ctx.stroke();
    txt(ctx, ambOn ? '\u266B' : '\u266A', sb.x + sb.w * 0.5, sb.y + sb.h * 0.68,
      '700 ' + Math.round(sb.h * 0.42) + 'px ' + SERIF, ambOn ? C.gold : C.dim, 'center');
  }

  function drawButton(ctx, r, label, kind, on) {
    if (!r || !r.w) return;
    roundRect(ctx, r.x, r.y, r.w, r.h, 8);
    var bg, bd, fg;
    if (kind === 'banner') { bg = 'rgba(210,75,63,0.16)'; bd = 'rgba(210,75,63,0.75)'; fg = '#f3d6d1'; }
    else if (kind === 'gold') { bg = 'rgba(232,193,104,0.16)'; bd = 'rgba(232,193,104,0.80)'; fg = '#f7e9c6'; }
    else { bg = 'rgba(159,184,200,0.05)'; bd = 'rgba(159,184,200,0.16)'; fg = 'rgba(169,187,198,0.45)'; }
    if (!on) { bg = 'rgba(159,184,200,0.04)'; bd = 'rgba(159,184,200,0.14)'; fg = 'rgba(169,187,198,0.40)'; }
    ctx.fillStyle = bg; ctx.fill();
    ctx.strokeStyle = bd; ctx.lineWidth = 1; ctx.stroke();
    spaced(ctx, label, r.x + r.w * 0.5, r.y + r.h * 0.5 + 4, '700 11px ' + FONT, fg, 1.1, 'center');
  }

  function drawPanel(ctx) {
    if (!B || !G) return;
    var P = L.panel, i, u, card, sel = B.sel;
    roundRect(ctx, P.x, P.y, P.w, P.h, 10);
    ctx.fillStyle = 'rgba(16,22,27,0.97)'; ctx.fill();
    ctx.strokeStyle = 'rgba(232,193,104,0.20)'; ctx.lineWidth = 1; ctx.stroke();

    for (i = 0; i < 4; i++) {
      u = B.players[i];
      card = L.cards[i];
      if (!u || !card) continue;
      var isSel = u === sel;
      roundRect(ctx, card.x, card.y, card.w, card.h, 7);
      ctx.fillStyle = isSel ? 'rgba(232,193,104,0.09)' : 'rgba(159,184,200,0.045)';
      ctx.fill();
      ctx.strokeStyle = isSel ? 'rgba(232,193,104,0.72)' : 'rgba(159,184,200,0.16)';
      ctx.lineWidth = isSel ? 1.6 : 1;
      ctx.stroke();

      var ps = Math.min(34, card.h - 14);
      drawPortrait(ctx, u, card.x + 6, card.y + (card.h - ps) * 0.5, ps, ps);
      var tx0 = card.x + 6 + ps + 7;
      var tw = card.x + card.w - 6 - tx0;

      if (!u.alive) {
        txt(ctx, fitText(ctx, u.short, tw, FS.label), tx0, card.y + card.h * 0.5 + 4, FS.label, C.dim, 'left');
        txt(ctx, 'FALLEN', card.x + card.w - 6, card.y + card.h - 6, FS.micro, 'rgba(210,75,63,0.7)', 'right');
        continue;
      }
      txt(ctx, fitText(ctx, u.short, tw, FS.label), tx0, card.y + 16, FS.label, C.ink, 'left');
      txt(ctx, u.statusLine, tx0, card.y + 29, FS.micro, u.acted ? C.dim : 'rgba(107,127,139,0.95)', 'left');
      drawHpBar(ctx, tx0, card.y + 34, tw, 4, u.hp / u.maxHp,
        u.hp / u.maxHp > 0.5 ? C.good : u.hp / u.maxHp > 0.25 ? C.gold : C.banner);
      for (var k = 0; k < u.maxMp && k < 9; k++) {
        ctx.fillStyle = k < u.mp ? 'rgba(232,193,104,0.85)' : 'rgba(159,184,200,0.16)';
        ctx.fillRect(tx0 + k * 6, card.y + 43, 4, 3);
      }
      txt(ctx, u.hpStr, card.x + card.w - 6, card.y + card.h - 6,
        FS.micro, 'rgba(169,187,198,0.75)', 'right');
    }

    var D = L.detail;
    if (sel && sel.alive) {
      txt(ctx, fitText(ctx, sel.nameUpper, D.w * 0.62, FS.name), D.x, D.y + 14, FS.name, C.ink, 'left');
      txt(ctx, sel.acted ? 'HAS STRUCK' : 'READY', D.x + D.w, D.y + 14, FS.micro,
        sel.acted ? C.dim : C.gold, 'right');
      txt(ctx, fitText(ctx, B.detailLine, D.w, FS.small), D.x, D.y + 30, FS.small, C.mid, 'left');
      if (B.target && B.target.alive && !sel.acted && B.preview) {
        txt(ctx, fitText(ctx, B.preview, D.w, FS.small), D.x, D.y + 44, FS.small, C.gold, 'left');
      } else {
        txt(ctx, fitText(ctx, sel.summary, D.w, FS.micro), D.x, D.y + 44, FS.micro, C.steel, 'left');
      }
    } else {
      txt(ctx, 'NO BANNER CHOSEN', D.x, D.y + 14, FS.name, C.mid, 'left');
      txt(ctx, 'Tap one of your four to give orders.', D.x, D.y + 30, FS.small, C.dim, 'left');
    }

    if (L.land) {
      txt(ctx, fitText(ctx, B.vaultLine, D.w, FS.micro),
        D.x, D.y + D.h + 18, FS.micro, 'rgba(107,127,139,0.95)', 'left');
      txt(ctx, 'Cover \u22125\u201325% to hit \u00B7 ranged reach 3', D.x, D.y + D.h + 32,
        FS.micro, 'rgba(107,127,139,0.95)', 'left');
    } else {
      txt(ctx, 'TAP TILE \u00B7 TAP FOE', P.x + 10, L.btnEnd.y + 27, FS.micro, 'rgba(107,127,139,0.95)', 'left');
    }

    drawButton(ctx, L.btnEnd, 'END TURN', 'banner', true);
    drawButton(ctx, L.btnStrike, 'STRIKE', 'gold', !!(B.target && B.target.alive && sel && !sel.acted));
  }

  /* ------------------------------------------------------------------ */
  /* battle render                                                       */
  /* ------------------------------------------------------------------ */
  /* key for the baked walkable wash: changes when the selection, its footing,
   * its movement allowance, the turn or the cell size changes */
  function ovlKey() {
    var sel = B && B.sel;
    return B.fv + B.turn * 131 + L.tile * 7919 + (sel ? sel.slot * 17 + sel.mp * 977 : 0);
  }

  function drawBattle(ctx, t) {
    var A = L.arena, ts = L.tile, i, u, sel = B.sel;
    var bx = L.arenaBox, scroll = B.camMax > 0;

    if (B.bakeDirty) rebake();
    if (B.ovlKey !== ovlKey()) buildOverlay();

    /* The frame hugs the board when the whole board is on screen, and hugs the
     * viewport when the camera is sliding down a tall vault. */
    var f = scroll
      ? { x: bx.x + 6, y: bx.y + 6, w: bx.w - 12, h: bx.h - 12 }
      : { x: A.x - 6, y: A.y - 6, w: A.w + 12, h: A.h + 12 };

    ctx.save();
    if (B.shake > 0.05) ctx.translate(Math.sin(t * 61) * B.shake, Math.cos(t * 47) * B.shake * 0.6);

    ctx.strokeStyle = 'rgba(159,184,200,0.28)';
    ctx.lineWidth = 1;
    ctx.strokeRect(f.x + 0.5, f.y + 0.5, f.w - 1, f.h - 1);
    ctx.strokeStyle = 'rgba(232,193,104,0.65)';
    ctx.lineWidth = 2;
    var cs = 9;
    ctx.beginPath();
    ctx.moveTo(f.x - 2, f.y - 2 + cs); ctx.lineTo(f.x - 2, f.y - 2); ctx.lineTo(f.x - 2 + cs, f.y - 2);
    ctx.moveTo(f.x + f.w + 2 - cs, f.y - 2); ctx.lineTo(f.x + f.w + 2, f.y - 2); ctx.lineTo(f.x + f.w + 2, f.y - 2 + cs);
    ctx.moveTo(f.x - 2, f.y + f.h + 2 - cs); ctx.lineTo(f.x - 2, f.y + f.h + 2); ctx.lineTo(f.x - 2 + cs, f.y + f.h + 2);
    ctx.moveTo(f.x + f.w + 2 - cs, f.y + f.h + 2); ctx.lineTo(f.x + f.w + 2, f.y + f.h + 2); ctx.lineTo(f.x + f.w + 2, f.y + f.h + 2 - cs);
    ctx.stroke();

    /* everything on the board is clipped to the frame: a sprite is taller than
     * its cell, and a banner on the edge must not bleed over the HUD */
    ctx.save();
    ctx.beginPath();
    ctx.rect(f.x + 1.5, f.y + 1.5, f.w - 3, f.h - 3);
    ctx.clip();

    /* four blits: floor, walkable wash, decals, grid — the wash sits under the
     * decal outlines and over the tile fill, which is the whole point of baking
     * them separately */
    if (B.bake) ctx.drawImage(B.bake, A.x, A.y, A.w, A.h);
    if (B.ovlOn && B.ovl) ctx.drawImage(B.ovl, A.x, A.y, A.w, A.h);
    if (B.deco) ctx.drawImage(B.deco, A.x, A.y, A.w, A.h);

    /* attackable foes: a rounded ring, not a hard rectangle */
    if (sel && sel.alive && !sel.acted && B.phase === 'player' && G && G.mode === 'battle') {
      for (i = 0; i < B.enemies.length; i++) {
        u = B.enemies[i];
        if (!u.alive || !bestAttack(sel, u)) continue;
        var ex = A.x + u.x * ts, ey = A.y + u.y * ts;
        var on = (u === B.target);
        if (on) {
          ctx.fillStyle = 'rgba(210,75,63,0.10)';
          ctx.fillRect(ex, ey, ts, ts);
        }
        ctx.strokeStyle = on ? 'rgba(210,75,63,0.85)' : 'rgba(210,75,63,0.40)';
        ctx.lineWidth = on ? 1.8 : 1.2;
        roundRect(ctx, ex + 2.5, ey + 2.5, ts - 5, ts - 5, Math.min(6, ts * 0.2));
        ctx.stroke();
      }
    }

    for (i = 0; i < B.corpses.length; i++) {
      var cp = B.corpses[i];
      var cx = A.x + cp.x * ts + ts * 0.5, cy = A.y + cp.y * ts + ts * 0.5;
      ctx.fillStyle = cp.side === 'player' ? 'rgba(159,184,200,0.10)' : 'rgba(210,75,63,0.10)';
      ctx.beginPath(); ctx.ellipse(cx, cy + ts * 0.26, ts * 0.26, ts * 0.09, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(120,132,140,0.42)'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - ts * 0.11, cy + ts * 0.10); ctx.lineTo(cx + ts * 0.11, cy + ts * 0.24);
      ctx.moveTo(cx + ts * 0.11, cy + ts * 0.10); ctx.lineTo(cx - ts * 0.11, cy + ts * 0.24);
      ctx.stroke();
    }

    /* markers first, then figures: a glow never paints over a neighbour's boots */
    for (i = 0; i < B.units.length; i++) {
      u = B.units[i];
      if (!u.alive) continue;
      drawGround(ctx, u, A.x + u.vx * ts + ts * 0.5, A.y + u.vy * ts + ts * 0.72, ts, u === sel);
    }

    /* painters' order: back of the field first, so overlapping figures layer by
     * depth instead of by array index */
    var order = B.drawOrder;
    order.length = 0;
    for (i = 0; i < B.units.length; i++) if (B.units[i].alive) order.push(B.units[i]);
    for (i = 1; i < order.length; i++) {
      var cu = order[i], j = i - 1;
      while (j >= 0 && order[j].vy > cu.vy) { order[j + 1] = order[j]; j--; }
      order[j + 1] = cu;
    }
    for (i = 0; i < order.length; i++) {
      u = order[i];
      drawUnitSprite(ctx, u, A.x + u.vx * ts + ts * 0.5, A.y + u.vy * ts + ts * 0.72, ts, t);
    }
    for (i = 0; i < order.length; i++) {
      u = order[i];
      drawUnitBars(ctx, u, A.x + u.vx * ts + ts * 0.5, A.y + u.vy * ts + ts * 0.72, ts);
    }

    /* order line: a hairline from the chosen banner to its mark */
    if (sel && sel.alive && B.target && B.target.alive && bestAttack(sel, B.target)) {
      ctx.strokeStyle = 'rgba(232,193,104,0.40)';
      ctx.lineWidth = 1;
      ctx.setLineDash(DASH1);
      ctx.beginPath();
      ctx.moveTo(A.x + sel.x * ts + ts * 0.5, A.y + sel.y * ts + ts * 0.72);
      ctx.lineTo(A.x + B.target.x * ts + ts * 0.5, A.y + B.target.y * ts + ts * 0.72);
      ctx.stroke();
      ctx.setLineDash(NODASH);
    }

    for (i = 0; i < B.floats.length; i++) {
      var fl = B.floats[i];
      if (!fl.on || fl.delay > 0) continue;
      var al = clamp(1 - fl.t / fl.life, 0, 1);
      var fx = A.x + fl.x * ts + ts * 0.5;
      var fy = A.y + fl.y * ts + ts * 0.42 + fl.t * fl.vy;
      ctx.globalAlpha = al;
      ctx.font = '700 ' + fl.size + 'px ' + MONO;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(6,9,11,0.85)';
      ctx.strokeText(fl.text, fx, fy);
      ctx.fillStyle = fl.col;
      ctx.fillText(fl.text, fx, fy);
      ctx.globalAlpha = 1;
    }
    ctx.restore();  /* clip */

    if (B.bnT > 0) {
      var life = 2.4, p = clamp(B.bnT / life, 0, 1);
      var slide = clamp((1 - p) * 4, 0, 1);
      var alpha = p > 0.86 ? (1 - p) / 0.14 : p < 0.16 ? p / 0.16 : 1;
      var by = f.y + 12 - slide * 8;
      ctx.globalAlpha = clamp(alpha, 0, 1);
      ctx.fillStyle = 'rgba(8,11,14,0.86)';
      ctx.fillRect(f.x, by, f.w, 42);
      ctx.fillStyle = 'rgba(232,193,104,0.85)';
      ctx.fillRect(f.x, by, f.w, 1);
      ctx.fillRect(f.x, by + 41, f.w, 1);
      txt(ctx, B.bnText, f.x + f.w * 0.5, by + 19, FS.h3, C.gold, 'center');
      txt(ctx, B.bnSub, f.x + f.w * 0.5, by + 33, FS.micro, C.mid, 'center');
      ctx.globalAlpha = 1;
    }

    /* dispatch strip: one line of state under the field, so the empty slack in
     * the arena box does some work instead of just sitting there */
    var slack = bx.y + bx.h - (f.y + f.h);
    if (slack > 30) {
      var dy = f.y + f.h + 17;
      ctx.fillStyle = 'rgba(159,184,200,0.14)';
      ctx.fillRect(f.x + 18, dy - 9, f.w - 36, 1);
      ctx.fillStyle = 'rgba(232,193,104,0.55)';
      ctx.fillRect(f.x + f.w * 0.5 - 14, dy - 9, 28, 1);
      txt(ctx, fitText(ctx, B.dispatch, f.w - 24, FS.label), f.x + f.w * 0.5, dy + 3,
        FS.label, 'rgba(169,187,198,0.82)', 'center');
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /* screens                                                             */
  /* ------------------------------------------------------------------ */
  /* Landscape title: the portrait stack needs ~700px of height, so the wide
   * layout keeps one row of banners, one pill and a single credit line. */
  function drawTitleWide(ctx, t) {
    var W = L.W, H = L.H, i, cx = W * 0.5;

    ctx.fillStyle = 'rgba(6,9,11,0.55)';
    ctx.beginPath();
    ctx.moveTo(0, H * 0.62);
    for (i = 0; i <= W; i += 14) {
      ctx.lineTo(i, H * 0.62 - Math.sin(i * 0.013) * 6 - Math.sin(i * 0.005 + 1.2) * 9);
    }
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fill();

    spaced(ctx, 'WARDENMARCH', cx, H * 0.22, '700 34px ' + SERIF, C.ink, 1.2, 'center');
    ctx.fillStyle = 'rgba(232,193,104,0.65)';
    ctx.fillRect(cx - 54, H * 0.24, 108, 1);
    spaced(ctx, 'A SKIRMISH CAMPAIGN', cx, H * 0.355, FS.label, C.gold, 2, 'center');
    txt(ctx, 'Every number a Wesnoth record. Every wall a Crawl vault.', cx, H * 0.45, FS.small, C.mid, 'center');

    /* same rule as portrait: one frame, bilinear, body ~1.6x the old size */
    var FW = Math.min(Math.min(140, H * 0.36), W * 0.16), gap = Math.min(28, W * 0.035);
    var total = 4 * FW + 3 * gap, x0 = cx - total * 0.5;
    for (i = 0; i < 4; i++) {
      var rec = BYID[DEFAULT_SQUAD[i]] || PLAY[i];
      var ux = x0 + i * (FW + gap) + FW * 0.5, uy = H * 0.628;
      ctx.strokeStyle = 'rgba(232,193,104,0.35)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(ux, uy + 2, FW * 0.34, FW * 0.06, 0, 0, TAU); ctx.stroke();
      var art = IMG[rec.id];
      if (art && art.uok && art.u) {
        var cell = art.u.height || 1;
        ctx.save();
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(art.u, 0, 0, cell, cell, ux - FW * 0.5, uy - FW * 0.93, FW, FW);
        ctx.restore();
      } else {
        drawUnitFallback(ctx, rec.race, ux, uy - FW * 0.285, FW * 0.62, 'player');
      }
      txt(ctx, rec.name.toUpperCase(), ux, uy + 14, FS.label, 'rgba(159,184,200,0.78)', 'center');
    }

    var pill = { x: cx - 90, y: H * 0.735, w: 180, h: 40 };
    var pulse = 0.5 + 0.5 * Math.sin(t * 2.1);
    ctx.fillStyle = 'rgba(232,193,104,' + (0.04 + pulse * 0.06).toFixed(3) + ')';
    roundRect(ctx, pill.x, pill.y, pill.w, pill.h, 20); ctx.fill();
    ctx.strokeStyle = 'rgba(232,193,104,' + (0.45 + pulse * 0.4).toFixed(3) + ')';
    ctx.lineWidth = 1;
    roundRect(ctx, pill.x, pill.y, pill.w, pill.h, 20); ctx.stroke();
    spaced(ctx, 'TAP TO MARCH', cx, pill.y + 26, '700 12px ' + FONT, C.gold, 1.8, 'center');

    txt(ctx, fitText(ctx, L.credits.join(' '), W - 32, FS.mono), cx, H - 30, FS.mono,
      'rgba(176,193,203,0.92)', 'center');
    txt(ctx, 'NO NETWORK \u00B7 NO ACCOUNT \u00B7 NO DOWNLOADS', cx, H - 14, FS.label,
      'rgba(198,214,222,0.95)', 'center');
  }

  function drawTitle(ctx, t) {
    var W = L.W, H = L.H, i;
    var cx = W * 0.5;

    if (L.land) { drawTitleWide(ctx, t); return; }

    ctx.fillStyle = 'rgba(6,9,11,0.55)';
    ctx.beginPath();
    ctx.moveTo(0, H * 0.52);
    for (i = 0; i <= W; i += 12) {
      ctx.lineTo(i, H * 0.52 - Math.sin(i * 0.017) * 9 - Math.sin(i * 0.006 + 1.2) * 14);
    }
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fill();

    /* three marches, marked: numerals on pennants, the current one lit */
    for (i = 0; i < 3; i++) {
      var bx = cx + (i - 1) * 78, by = H * 0.292;
      var cur = i === 0;
      var top = by - 28;
      ctx.strokeStyle = cur ? 'rgba(232,193,104,0.72)' : 'rgba(159,184,200,0.26)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(bx - 12, by + 8);
      ctx.lineTo(bx - 12, top);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bx - 12, top);
      ctx.lineTo(bx + 24, top + 3);
      ctx.lineTo(bx - 12, top + 19);
      ctx.closePath();
      ctx.fillStyle = cur ? 'rgba(232,193,104,0.22)' : 'rgba(159,184,200,0.05)';
      ctx.fill();
      ctx.strokeStyle = cur ? 'rgba(232,193,104,0.90)' : 'rgba(159,184,200,0.24)';
      ctx.lineWidth = 1;
      ctx.stroke();
      txt(ctx, ROMAN[i], bx - 1, top + 10, '700 10px ' + MONO,
        cur ? C.gold : 'rgba(159,184,200,0.45)', 'center');
      if (cur) {
        ctx.fillStyle = 'rgba(232,193,104,0.55)';
        ctx.fillRect(bx - 21, by + 11, 34, 1);
      }
    }

    spaced(ctx, 'WARDENMARCH', cx, H * 0.168, FS.title, C.ink, 1.4, 'center');
    ctx.fillStyle = 'rgba(232,193,104,0.65)';
    ctx.fillRect(cx - 54, H * 0.185, 108, 1);
    spaced(ctx, 'A SKIRMISH CAMPAIGN', cx, H * 0.213, FS.label, C.gold, 2.2, 'center');
    txt(ctx, 'Every number a Wesnoth record. Every wall a Crawl vault.', cx, H * 0.242, FS.small, C.mid, 'center');

    /* roster: the painted figures are the point of this screen, so each frame is
     * drawn ~168px tall — the body inside it lands near 100px — in one frame of
     * the strip and bilinear-filtered, because this is painted art */
    var n = 4, pad = 12, gap = 8;
    var slot = (W - pad * 2 - gap * (n - 1)) / n;
    var FW = Math.min(168, W * 0.46);
    var uy = H * 0.500;
    for (i = 0; i < n; i++) {
      var rec = BYID[DEFAULT_SQUAD[i]] || PLAY[i];
      var ux = pad + slot * 0.5 + i * (slot + gap);
      ctx.fillStyle = 'rgba(159,184,200,0.06)';
      roundRect(ctx, ux - slot * 0.46, uy - 5, slot * 0.92, 9, 3); ctx.fill();
      ctx.fillStyle = 'rgba(232,193,104,0.45)';
      ctx.fillRect(ux - slot * 0.40, uy - 6, slot * 0.80, 1);
      ctx.fillStyle = 'rgba(232,193,104,0.14)';
      ctx.beginPath(); ctx.ellipse(ux, uy + 1, slot * 0.40, slot * 0.09, 0, 0, TAU); ctx.fill();
      var art = IMG[rec.id];
      if (art && art.uok && art.u) {
        var cell = art.u.height || 1;
        ctx.save();
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(art.u, 0, 0, cell, cell, ux - FW * 0.5, uy - FW * 0.93, FW, FW);
        ctx.restore();
      } else {
        drawUnitFallback(ctx, rec.race, ux, uy - FW * 0.285, FW * 0.62, 'player');
      }
      txt(ctx, rec.name.toUpperCase(), ux, uy + 18, FS.label, 'rgba(159,184,200,0.78)', 'center');
    }

    var pulse = 0.5 + 0.5 * Math.sin(t * 2.1);
    var pill = { x: cx - 96, y: H * 0.605, w: 192, h: 46 };
    ctx.fillStyle = 'rgba(232,193,104,' + (0.04 + pulse * 0.06).toFixed(3) + ')';
    roundRect(ctx, pill.x, pill.y, pill.w, pill.h, 23); ctx.fill();
    ctx.strokeStyle = 'rgba(232,193,104,' + (0.45 + pulse * 0.4).toFixed(3) + ')';
    ctx.lineWidth = 1;
    roundRect(ctx, pill.x, pill.y, pill.w, pill.h, 23); ctx.stroke();
    spaced(ctx, 'TAP TO MARCH', cx, pill.y + 29, '700 12px ' + FONT, C.gold, 1.8, 'center');

    txt(ctx, 'MUSTER YOUR OWN FOUR', cx, pill.y + 74, FS.small, C.steel, 'center');
    txt(ctx, BEST_SCORE > 0 ? ('BEST ' + pad4(BEST_SCORE) + ' \u00B7 ' + WINS + ' MARCHES WON') : 'THREE MARCHES \u00B7 FOUR BLADES',
      cx, pill.y + 96, FS.label, C.dim, 'center');

    /* footer: 11px mono credits and a 10px bold provenance line — legible at
     * 390px wide, which the old 10px/0.72-alpha pair was not */
    var cyy = H - 84;
    ctx.fillStyle = 'rgba(159,184,200,0.16)';
    ctx.fillRect(18, cyy - 16, W - 36, 1);
    for (i = 0; i < L.credits.length; i++) {
      txt(ctx, L.credits[i], cx, cyy + i * 15, FS.mono, 'rgba(176,193,203,0.92)', 'center');
    }
    txt(ctx, 'NO NETWORK \u00B7 NO ACCOUNT \u00B7 NO DOWNLOADS', cx, H - 16, FS.label,
      'rgba(198,214,222,0.95)', 'center');
  }

  function drawMuster(ctx) {
    var W = L.W, H = L.H;
    spaced(ctx, 'MUSTER THE BANNER', 16, 40, FS.h2, C.ink, 0.8, 'left');
    txt(ctx, 'CHOOSE FOUR OF TWELVE \u00B7 WESNOTH STATS, UNCHANGED', 16, 60, FS.micro, C.gold, 'left');
    txt(ctx, 'TAP TO ADD OR REMOVE', W - 16, 60, FS.micro, C.dim, 'right');

    var i, c, rec;
    for (i = 0; i < L.musterCards.length; i++) {
      c = L.musterCards[i]; rec = c.rec;
      var picked = G && G.squad.indexOf(rec.id) >= 0;
      roundRect(ctx, c.x, c.y, c.w, c.h, 7);
      ctx.fillStyle = picked ? 'rgba(232,193,104,0.10)' : 'rgba(159,184,200,0.04)';
      ctx.fill();
      ctx.strokeStyle = picked ? 'rgba(232,193,104,0.75)' : 'rgba(159,184,200,0.16)';
      ctx.lineWidth = picked ? 1.6 : 1;
      ctx.stroke();
      var pw = 34, art = IMG[rec.id];
      if (art && art.pok && art.p) {
        ctx.save();
        roundRect(ctx, c.x + 5, c.y + 5, pw, pw, 4); ctx.clip();
        ctx.drawImage(art.p, c.x + 5, c.y + 1, pw, pw * 1.1);
        ctx.restore();
      } else {
        drawBustFallback(ctx, rec, c.x + 5, c.y + 5, pw, pw);
      }
      txt(ctx, fitText(ctx, rec.name, c.w - 46, FS.label), c.x + 43, c.y + 15, FS.micro, C.ink, 'left');
      txt(ctx, 'LV' + rec.level + ' ' + rec.race.toUpperCase(), c.x + 43, c.y + 27, FS.micro, C.dim, 'left');
      txt(ctx, rec.hp + ' HP \u00B7 ' + rec.movement + ' MOV', c.x + 43, c.y + 39, FS.micro, C.steel, 'left');
      var atk = rec.attacks[0];
      txt(ctx, atk.damage + '\u00D7' + atk.number + ' ' + atk.range, c.x + 5, c.y + c.h - 8, FS.micro, 'rgba(169,187,198,0.8)', 'left');
      if (picked) {
        ctx.fillStyle = C.gold;
        ctx.beginPath(); ctx.arc(c.x + c.w - 11, c.y + 11, 6, 0, TAU); ctx.fill();
        txt(ctx, '\u2713', c.x + c.w - 11, c.y + 14.5, '700 9px ' + FONT, '#12181c', 'center');
      }
    }

    var count = G ? G.squad.length : 0;
    txt(ctx, count + ' / 4 SWORN', 16, H - 74, FS.label, count === 4 ? C.gold : C.mid, 'left');
    drawButton(ctx, { x: W - 16 - 150, y: H - 92, w: 150, h: 46 }, count === 4 ? 'MARCH' : 'PICK FOUR', 'gold', count === 4);
    txt(ctx, 'BACK', 16, H - 34, FS.label, C.dim, 'left');
  }

  function drawCampaign(ctx) {
    var W = L.W, H = L.H, i, node;
    spaced(ctx, 'THE MARCH', 18, 44, FS.h2, C.ink, 1.2, 'left');
    txt(ctx, 'BATTLE ' + (G.stage + 1) + ' OF III', W - 18, 42, FS.label, C.gold, 'right');
    txt(ctx, 'The warband is broken. The road goes on.', 18, 64, FS.small, C.mid, 'left');

    ctx.strokeStyle = 'rgba(232,193,104,0.25)';
    ctx.lineWidth = 1;
    ctx.setLineDash(DASH1);
    ctx.beginPath();
    for (i = 0; i < L.campaignNodes.length; i++) {
      node = L.campaignNodes[i];
      if (i === 0) ctx.moveTo(node.x, node.y); else ctx.lineTo(node.x, node.y);
    }
    ctx.stroke();
    ctx.setLineDash(NODASH);

    for (i = 0; i < L.campaignNodes.length; i++) {
      node = L.campaignNodes[i];
      var done = i < G.stage, cur = i === G.stage;
      ctx.fillStyle = done ? 'rgba(134,201,141,0.12)' : cur ? 'rgba(210,75,63,0.14)' : 'rgba(159,184,200,0.04)';
      ctx.beginPath(); ctx.arc(node.x, node.y, 17, 0, TAU); ctx.fill();
      ctx.strokeStyle = done ? 'rgba(134,201,141,0.8)' : cur ? 'rgba(210,75,63,0.9)' : 'rgba(159,184,200,0.2)';
      ctx.lineWidth = cur ? 2 : 1;
      ctx.beginPath(); ctx.arc(node.x, node.y, 17, 0, TAU); ctx.stroke();
      txt(ctx, done ? '\u2713' : String(i + 1), node.x, node.y + 5, '700 13px ' + FONT,
        done ? C.good : cur ? '#f3d6d1' : C.dim, 'center');
      txt(ctx, STAGE_NAMES[i], node.x, node.y + 34, FS.label, cur ? C.ink : done ? C.mid : C.dim, 'center');
      txt(ctx, done ? 'WON' : cur ? 'NEXT' : 'LOCKED', node.x, node.y + 47, FS.micro,
        done ? C.good : cur ? C.banner : C.dim, 'center');
    }

    var sy = H - 190;
    txt(ctx, 'YOUR BANNER', 18, sy, FS.micro, C.dim, 'left');
    for (i = 0; i < 4; i++) {
      var rec = BYID[G.squad[i]] || PLAY[0];
      var bx = 18 + i * ((W - 36) / 4), bw = (W - 36) / 4 - 6;
      drawBustFallback(ctx, rec, bx, sy + 8, bw, 52);
      var art = IMG[rec.id];
      if (art && art.pok && art.p) {
        ctx.save();
        roundRect(ctx, bx, sy + 8, bw, 52, 4); ctx.clip();
        ctx.drawImage(art.p, bx, sy + 4, bw, 58);
        ctx.restore();
      }
      txt(ctx, fitText(ctx, rec.name, bw + 4, FS.micro), bx, sy + 72, FS.micro, C.mid, 'left');
    }
    drawButton(ctx, { x: W * 0.5 - 110, y: H - 88, w: 220, h: 48 }, 'TAKE THE FIELD', 'banner', true);
    txt(ctx, 'Tap the glowing node to continue the march.', W * 0.5, H - 24, FS.micro, C.dim, 'center');
  }

  function drawResult(ctx) {
    var W = L.W, H = L.H;
    var r = G.result || { win: false, score: G.score, kills: G.totalKills, survivors: 0 };
    ctx.fillStyle = 'rgba(5,8,10,0.72)';
    ctx.fillRect(0, 0, W, H);
    var pw = Math.min(330, W - 40), ph = 328;
    var px = (W - pw) * 0.5, py = (H - ph) * 0.42;
    roundRect(ctx, px, py, pw, ph, 12);
    ctx.fillStyle = 'rgba(16,22,27,0.98)'; ctx.fill();
    ctx.strokeStyle = r.win ? 'rgba(232,193,104,0.55)' : 'rgba(210,75,63,0.55)';
    ctx.lineWidth = 1.2; ctx.stroke();

    spaced(ctx, r.win ? 'THE MARCH IS WON' : 'THE BANNER FALLS', px + pw * 0.5, py + 46,
      FS.h2, r.win ? C.gold : C.banner, 1.2, 'center');
    txt(ctx, r.win ? 'Three fields held. The warden\u2019s oath is kept.' : 'The warband broke your line.',
      px + pw * 0.5, py + 68, FS.small, C.mid, 'center');

    var rows = [
      ['BATTLES WON', r.win ? '3 / 3' : (G.stage) + ' / 3'],
      ['FOES FELLED', String(r.kills || G.totalKills)],
      ['BANNERS STANDING', String(r.survivors)],
      ['SCORE', pad4(r.score)]
    ];
    for (var i = 0; i < rows.length; i++) {
      var ry = py + 104 + i * 32;
      txt(ctx, rows[i][0], px + 28, ry, FS.label, C.dim, 'left');
      txt(ctx, rows[i][1], px + pw - 28, ry, FS.monoB, i === 3 ? C.gold : C.ink, 'right');
      ctx.fillStyle = 'rgba(159,184,200,0.10)';
      ctx.fillRect(px + 28, ry + 8, pw - 56, 1);
    }
    txt(ctx, 'BEST ' + pad4(BEST_SCORE), px + pw * 0.5, py + 246, FS.micro, C.steel, 'center');

    drawButton(ctx, { x: px + 24, y: py + ph - 66, w: pw - 48, h: 44 },
      r.win ? 'MARCH A NEW BANNER' : 'MUSTER AGAIN', r.win ? 'gold' : 'banner', true);
    txt(ctx, 'Progress banked on this device', px + pw * 0.5, py + ph - 12, FS.micro, C.dim, 'center');
  }

  function drawPause(ctx) {
    var W = L.W, H = L.H;
    ctx.fillStyle = 'rgba(5,8,10,0.78)';
    ctx.fillRect(0, 0, W, H);
    var pw = Math.min(300, W - 48), ph = 268, px = (W - pw) * 0.5, py = (H - ph) * 0.42;
    roundRect(ctx, px, py, pw, ph, 12);
    ctx.fillStyle = 'rgba(16,22,27,0.98)'; ctx.fill();
    ctx.strokeStyle = 'rgba(159,184,200,0.30)'; ctx.stroke();
    spaced(ctx, 'HALTED', px + pw * 0.5, py + 44, FS.h2, C.ink, 2, 'center');
    txt(ctx, 'The field waits.', px + pw * 0.5, py + 64, FS.small, C.dim, 'center');
    drawButton(ctx, { x: px + 24, y: py + 84, w: pw - 48, h: 42 }, 'RESUME', 'gold', true);
    drawButton(ctx, { x: px + 24, y: py + 134, w: pw - 48, h: 42 }, 'RESTART BATTLE', 'ghost', true);
    drawButton(ctx, { x: px + 24, y: py + 184, w: pw - 48, h: 42 }, ambOn ? 'AMBIENT: ON' : 'AMBIENT: OFF', 'ghost', true);
    txt(ctx, 'ABANDON THE MARCH', px + pw * 0.5, py + ph - 16, FS.micro, 'rgba(210,75,63,0.8)', 'center');
  }

  /* ------------------------------------------------------------------ */
  /* main update                                                         */
  /* ------------------------------------------------------------------ */
  function update(dt) {
    if (!B) return;
    var i;
    placeCamera(false, dt);
    for (i = 0; i < B.units.length; i++) {
      var u = B.units[i];
      if (u.walkWait > 0) { u.walkWait -= dt; continue; }
      if (u.path) {
        u.pt += dt * 8.5;
        while (u.pt >= 1 && u.pi < u.path.length - 1) { u.pt -= 1; u.pi++; }
        if (u.pi >= u.path.length - 1) {
          var last = u.path[u.path.length - 1];
          u.vx = last.x; u.vy = last.y; u.path = null; u.pt = 0;
        } else {
          var a = u.path[u.pi], b = u.path[u.pi + 1];
          var e = ease(clamp(u.pt, 0, 1));
          u.vx = lerp(a.x, b.x, e); u.vy = lerp(a.y, b.y, e);
        }
      }
      if (u.atkT > 0) u.atkT = Math.max(0, u.atkT - dt * 4.2);
      if (u.flash > 0) u.flash = Math.max(0, u.flash - dt * 3.2);
    }
    if (B.bnT > 0) B.bnT = Math.max(0, B.bnT - dt);
    if (B.shake > 0) B.shake = Math.max(0, B.shake - dt * 14);
    for (i = 0; i < B.floats.length; i++) {
      var f = B.floats[i];
      if (!f.on) continue;
      if (f.delay > 0) { f.delay -= dt; continue; }
      f.t += dt;
      if (f.t >= f.life) f.on = false;
    }
    for (i = 0; i < B.corpses.length; i++) B.corpses[i].t += dt;
  }

  /* ------------------------------------------------------------------ */
  /* input                                                               */
  /* ------------------------------------------------------------------ */
  var canvas = null;

  function inside(r, x, y) { return !!r && r.w > 0 && x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h; }

  function tileFromPoint(x, y) {
    if (!B) return null;
    var A = L.arena;
    if (x < A.x || y < A.y || x >= A.x + A.w || y >= A.y + A.h) return null;
    var tx = Math.floor((x - A.x) / L.tile), ty = Math.floor((y - A.y) / L.tile);
    if (tx < 0 || ty < 0 || tx >= B.cols || ty >= B.rows) return null;
    return { x: tx, y: ty };
  }

  function onTap(x, y) {
    var i, c;
    if (!G) {
      if (!L.land && inside({ x: L.W * 0.5 - 110, y: L.H * 0.605 + 58, w: 220, h: 32 }, x, y)) {
        G = blankCampaign('muster');
        return;
      }
      newGame();
      return;
    }
    if (G.mode === 'title') {
      if (!L.land && inside({ x: L.W * 0.5 - 110, y: L.H * 0.605 + 58, w: 220, h: 32 }, x, y)) {
        G.mode = 'muster';
        if (!G.squad || !G.squad.length) G.squad = DEFAULT_SQUAD.slice(0);
        return;
      }
      newGame();
      return;
    }
    if (G.mode === 'muster') {
      for (i = 0; i < L.musterCards.length; i++) {
        c = L.musterCards[i];
        if (!inside(c, x, y)) continue;
        var at = G.squad.indexOf(c.rec.id);
        if (at >= 0) G.squad.splice(at, 1);
        else if (G.squad.length < 4) G.squad.push(c.rec.id);
        else GK.buzz(18);
        GK.sfx.coin();
        return;
      }
      if (inside({ x: L.W - 166, y: L.H - 92, w: 150, h: 46 }, x, y) && G.squad.length === 4) {
        G.score = 0; G.kills = 0; G.totalKills = 0; G.battlesWon = 0;
        startBattle(0);
        return;
      }
      if (y > L.H - 60) { G.mode = 'title'; return; }
      return;
    }
    if (G.mode === 'campaign') {
      if (inside({ x: L.W * 0.5 - 110, y: L.H - 88, w: 220, h: 48 }, x, y)) startBattle(G.stage);
      return;
    }
    if (G.mode === 'result') {
      var pw = Math.min(330, L.W - 40);
      if (inside({ x: (L.W - pw) * 0.5 + 24, y: (L.H - 328) * 0.42 + 328 - 66, w: pw - 48, h: 44 }, x, y)) {
        newGame();
      }
      return;
    }
    if (G.paused) {
      var ppw = Math.min(300, L.W - 48), pph = 268, ppx = (L.W - ppw) * 0.5, ppy = (L.H - pph) * 0.42;
      if (inside({ x: ppx + 24, y: ppy + 84, w: ppw - 48, h: 42 }, x, y)) { G.paused = false; return; }
      if (inside({ x: ppx + 24, y: ppy + 134, w: ppw - 48, h: 42 }, x, y)) { G.paused = false; startBattle(G.stage); return; }
      if (inside({ x: ppx + 24, y: ppy + 184, w: ppw - 48, h: 42 }, x, y)) {
        ambOn = !ambOn; STORE.set('ambient', ambOn);
        if (AMB) { if (ambOn) { var pr = AMB.play(); if (pr && pr.catch) pr.catch(function () {}); } else AMB.pause(); }
        return;
      }
      if (y > ppy + pph - 40) { G.paused = false; G.mode = 'title'; return; }
      return;
    }
    if (G.mode !== 'battle' || !B) return;

    if (inside(L.btnPause, x, y)) { G.paused = true; return; }
    if (inside(L.btnSound, x, y)) {
      ambOn = !ambOn; STORE.set('ambient', ambOn);
      if (AMB) { if (ambOn) { var pr2 = AMB.play(); if (pr2 && pr2.catch) pr2.catch(function () {}); } else AMB.pause(); }
      return;
    }
    if (inside(L.btnEnd, x, y)) { endTurn(); return; }
    if (inside(L.btnStrike, x, y)) {
      if (B.target && B.target.alive && B.sel && !B.sel.acted) {
        settleAnims();
        resolveAttack(B.sel, B.target, bestAttack(B.sel, B.target), 0);
        B.target = null;
      }
      return;
    }
    for (i = 0; i < L.cards.length; i++) {
      if (inside(L.cards[i], x, y)) {
        var pu = B.players[i];
        if (pu && pu.alive) selectUnit(pu);
        return;
      }
    }
    var tile = tileFromPoint(x, y);
    if (!tile) return;
    var occ = occUnit(tile.x, tile.y);
    if (occ && occ.side === 'player') { selectUnit(occ); return; }
    if (occ && occ.side === 'enemy') {
      if (!B.sel || B.sel.side !== 'player' || !B.sel.alive || B.sel.acted) {
        var bestU = null, bestD = 99, n;
        for (n = 0; n < B.players.length; n++) {
          var q = B.players[n];
          if (!q.alive || q.acted || !bestAttack(q, occ)) continue;
          var dd = manhattan(q.x, q.y, occ.x, occ.y);
          if (dd < bestD) { bestD = dd; bestU = q; }
        }
        if (bestU) B.sel = bestU; else return;
      }
      if (B.sel.acted) return;
      if (!bestAttack(B.sel, occ)) { GK.buzz(12); return; }
      B.target = (B.target === occ) ? null : occ;
      if (B.target) { B.preview = previewLine(B.sel, occ); GK.sfx.coin(); }
      return;
    }
    if (B.sel && B.sel.alive && !B.sel.acted && B.sel.mp > 0 && moveTo(B.sel, tile.x, tile.y)) {
      B.target = null;
      return;
    }
    B.target = null;
  }

  function attach() {
    canvas.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      var r = canvas.getBoundingClientRect();
      startAmbient();
      onTap(e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    window.addEventListener('keydown', function (e) {
      if (!G) return;
      if (e.key === 'Escape') {
        if (G.paused) G.paused = false;
        else if (G.mode === 'battle') G.paused = true;
      }
      if (e.key === 'Enter') {
        if (G.mode === 'title') newGame();
        else if (G.mode === 'battle' && !G.paused) endTurn();
      }
      if (e.key === ' ' && G.mode === 'battle' && !G.paused && B && B.target) {
        resolveAttack(B.sel, B.target, bestAttack(B.sel, B.target), 0);
        B.target = null;
      }
    });
    window.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function startAmbient() {
    if (ambStarted) return;
    ambStarted = true;
    try {
      var src = (WES && WES.music && WES.music[0]) || '';
      if (!src) return;
      AMB = new Audio(vendorPath(src));
      AMB.loop = true; AMB.volume = 0.22;
      AMB.addEventListener('error', function () { AMB = null; });
      if (ambOn) {
        var pr = AMB.play();
        if (pr && pr.catch) pr.catch(function () {});
      }
    } catch (e) { AMB = null; }
  }

  /* ------------------------------------------------------------------ */
  /* render                                                              */
  /* ------------------------------------------------------------------ */
  function render(ctx, t) {
    drawBackdrop(ctx);
    if (!G || G.mode === 'title') { drawTitle(ctx, t); return; }
    if (G.mode === 'muster') { drawMuster(ctx, t); return; }
    if (G.mode === 'campaign') { drawCampaign(ctx, t); return; }
    if (G.mode === 'battle' || G.mode === 'result') {
      drawBattle(ctx, t);
      drawHud(ctx);
      drawPanel(ctx);
      if (G.mode === 'result') drawResult(ctx);
      if (G.paused) drawPause(ctx);
      return;
    }
  }

  /* ------------------------------------------------------------------ */
  /* HUD strings (built on change, never per frame)                       */
  /* ------------------------------------------------------------------ */
  function refreshHud() {
    if (!B || !G) return;
    var foes = 0, i, u;
    for (i = 0; i < B.enemies.length; i++) if (B.enemies[i].alive) foes++;
    for (i = 0; i < B.players.length; i++) {
      u = B.players[i];
      u.hpStr = 'HP ' + Math.max(0, Math.round(u.hp));
      u.statusLine = u.acted ? '\u2713 STRUCK' : 'LV' + u.rec.level + ' ' + u.rec.race.toUpperCase();
    }
    B.hudTurn = 'TURN ' + B.turn + ' \u00B7 YOUR MARCH';
    B.hudFoes = foes + (foes === 1 ? ' FOE' : ' FOES');
    B.scoreStr = pad4(G.score);
    var sel = B.sel;
    if (sel && sel.alive) {
      var cv = Math.round(coverAt(sel.x, sel.y) * 100);
      B.detailLine = 'LV ' + sel.rec.level + ' ' + sel.rec.race.toUpperCase() +
        ' \u00B7 HP ' + Math.max(0, Math.round(sel.hp)) + '/' + sel.maxHp +
        ' \u00B7 MOV ' + sel.mp + '/' + sel.maxMp + ' \u00B7 COVER ' + cv + '%';
    } else {
      B.detailLine = '';
    }
  }

  function banner(text, sub, life) {
    if (!B) return;
    B.bnText = text; B.bnSub = sub || ''; B.bnT = life || 1.8;
  }

  /* ------------------------------------------------------------------ */
  /* test hook                                                           */
  /* ------------------------------------------------------------------ */
  function snapshot() {
    if (!G || !B) {
      return {
        started: !!G && G.mode !== 'title',
        mode: G ? G.mode : 'title',
        score: G ? G.score : 0, turn: 0, arenaId: '', arenaSrc: '',
        unitsWithRules: RECS.length, terrainTiles: FEATS.length, fights: 0, kills: 0, hp: 0,
        stage: 0
      };
    }
    var hp = 0, alive = 0, i, foes = 0;
    for (i = 0; i < B.players.length; i++) {
      if (B.players[i].alive) { hp += Math.max(0, B.players[i].hp); alive++; }
    }
    for (i = 0; i < B.enemies.length; i++) if (B.enemies[i].alive) foes++;
    return {
      started: G.mode !== 'title',
      mode: G.mode,
      score: G.score,
      turn: B.turn,
      arenaId: B.vault.id,
      arenaSrc: 'dcss',
      unitsWithRules: RECS.length,
      terrainTiles: FEATS.length,
      fights: B.fights,
      kills: B.kills,
      hp: hp,
      stage: G.stage,
      foes: foes,
      squad: alive,
      selected: B.sel ? B.sel.rec.id : '',
      phase: B.phase
    };
  }

  /* Direction form exists because a driver should be able to say "one step
   * east" without knowing which vault was drawn. Taps never come through here;
   * they path to an absolute tile. */
  function actMove(arg) {
    if (!B || !G || G.mode !== 'battle' || B.phase !== 'player') return false;
    settleAnims();
    var dx = arg && typeof arg.x === 'number' ? arg.x : 0;
    var dy = arg && typeof arg.y === 'number' ? arg.y : 0;
    var dir = Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && (dx !== 0 || dy !== 0);
    var u = B.sel && B.sel.alive && B.sel.side === 'player' ? B.sel : null, i, v;
    if (!u) {
      for (i = 0; i < B.players.length; i++) if (B.players[i].alive && B.players[i].mp > 0) { u = B.players[i]; break; }
      if (u) B.sel = u;
    }
    if (dir) {
      if (u && stepUnit(u, dx, dy)) return true;
      /* the chosen banner may be pinned; any sworn blade can take the order */
      for (i = 0; i < B.players.length; i++) {
        v = B.players[i];
        if (!v.alive || v === u || v.mp <= 0) continue;
        if (stepUnit(v, dx, dy)) { B.sel = v; B.target = null; return true; }
      }
      return !!(u && u.alive);
    }
    if (u && moveTo(u, dx, dy)) return true;
    return !!(u && u.alive);
  }

  function actAttack() {
    if (!B || !G || G.mode !== 'battle' || B.phase !== 'player') return false;
    settleAnims();
    var u = B.sel, i, v, t;
    if (!u || !u.alive || u.side !== 'player' || u.acted) u = null;
    var target = null;
    if (u) {
      if (B.target && B.target.alive && bestAttack(u, B.target)) target = B.target;
      else target = anyTarget(u);
    }
    if (!target) {
      for (i = 0; i < B.players.length; i++) {
        v = B.players[i];
        if (!v.alive || v.acted) continue;
        t = anyTarget(v);
        if (t) { u = v; target = t; B.sel = v; break; }
      }
    }
    if (!u || !target) return false;
    B.target = null;
    return resolveAttack(u, target, bestAttack(u, target), 0);
  }

  function act(name, arg) {
    try {
      if (name === 'newGame') { newGame(); return true; }
      if (!G) return false;
      if (name === 'move') return actMove(arg);
      if (name === 'attack') return actAttack();
      if (name === 'endTurn') return endTurn();
      if (name === 'pause') { G.paused = !G.paused; return true; }
      if (name === 'next') {
        if (G.mode === 'campaign') { startBattle(G.stage); return true; }
        return false;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  window.__game = {
    state: function () {
      try { return snapshot(); } catch (e) {
        return { started: false, mode: 'title', score: 0, turn: 0, arenaId: '', arenaSrc: '', unitsWithRules: RECS.length, terrainTiles: FEATS.length, fights: 0, kills: 0, hp: 0 };
      }
    },
    act: act
  };

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */
  (function boot() {
    canvas = document.getElementById('game');
    if (!canvas) return;
    vaultData();
    layout();
    attach();
    GK.boot({
      canvas: canvas,
      update: update,
      render: render,
      onResize: function (v) {
        L.W = v.w; L.H = v.h;
        layout();
      }
    });
  })();
})();
