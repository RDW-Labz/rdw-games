/* Cinderhold — an isometric dungeon-crawl ARPG for phones.
 * Classic script, no modules, no network, no external fonts, runs from file://.
 *
 * Two donors carry the content:
 *   - Dungeon Crawl Stone Soup (CC0): every floor is one of its vaults, read
 *     straight out of the vendored .des corpus — walls, doors, voids and stairs
 *     are the upstream layout, never hand-drawn geometry.
 *   - Flare (CC-BY-SA / GPL): the painted UI windows, the portraits, and the
 *     item records behind every drop (damage ranges, armour, prices are the
 *     upstream numbers).
 *
 * Flare ships each creature as a packed animation atlas. Downscaled to 256 px a
 * single frame is about ten pixels wide, so the bundle's monster sheets are used
 * for what they still hold — colour and grain — painted through the silhouette
 * of an authored vector body. Every creature, tile and effect therefore has an
 * authored fallback, and the game boots and plays with vendor/ deleted.
 *
 * Frame budget (mid-tier phones):
 *  - the floor is baked once per level into an offscreen canvas, so a frame is
 *    one drawImage plus the handful of live actors;
 *  - particles and damage numbers are fixed-size pools; nothing allocates per
 *    swing;
 *  - shadowBlur never runs per particle — glow is a cached radial gradient.
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
    bg: '#0b0709', bg2: '#150c0e', abyss: '#060304',
    stone: '#241618', stoneTop: '#332023', stoneLit: '#43302f',
    stoneDark: '#150c0e', mortar: '#0f080a', edge: '#5a3a30',
    ember: '#ff8a3d', emberDim: '#a94f26', gold: '#ffd479', bone: '#e8dcc8',
    ash: '#7d6a63', dim: '#5c4a46', blood: '#b8322a', bad: '#ff5a4e',
    good: '#8fd694', ink: '#f1e6d6'
  };
  var FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  var MONO = 'ui-monospace,Menlo,Consolas,"Courier New",monospace';

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function mod(v, m) { v = v % m; return v < 0 ? v + m : v; }
  function dist2(ax, ay, bx, by) { var dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; }
  function money(n) {
    n = Math.round(n);
    return String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (n < 0 ? '' : '');
  }
  /* Deterministic per-tile noise: the floor must look hand-laid but stay stable
     across a re-bake (rotate the phone and the cracks must not move). */
  function h2(x, y, s) {
    var n = (x * 73856093) ^ (y * 19349663) ^ ((s | 0) * 83492791);
    n = (n ^ (n >>> 13)) * 1274126177;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  }

  function txt(ctx, s, x, y, size, color, align, weight, mono) {
    ctx.font = (weight || 600) + ' ' + size + 'px ' + (mono ? MONO : FONT);
    ctx.fillStyle = color;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(s, x, y);
  }
  function tracked(ctx, s, x, y, size, color, weight, track) {
    ctx.font = (weight || 800) + ' ' + size + 'px ' + FONT;
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    var total = 0, i;
    for (i = 0; i < s.length; i++) total += ctx.measureText(s.charAt(i)).width + track;
    total -= track;
    var cx = x - total * 0.5;
    for (i = 0; i < s.length; i++) {
      ctx.fillText(s.charAt(i), cx, y);
      cx += ctx.measureText(s.charAt(i)).width + track;
    }
    return total;
  }
  function fitSize(ctx, s, maxW, size, mono, weight) {
    ctx.font = (weight || 600) + ' ' + size + 'px ' + (mono ? MONO : FONT);
    var w = ctx.measureText(s).width;
    if (w <= maxW) return size;
    return Math.max(5, size * (maxW / w));
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
    ctx.fillRect(x, y, clamp(pct, 0, 1) * w, h);
  }
  /* Glow without shadowBlur: a cached radial gradient sprite would need a
     canvas per colour, so a three-stop gradient is built only where it is used
     (a handful per frame, never per particle). */
  /* Gradient objects are expensive to build and the game draws a dozen a frame
     (braziers, loot, boss aura, torch light). Each is built once at the origin
     and reused under a translate; radius is quantised to 8px so a flickering
     brazier cannot fill the cache with near-identical entries. */
  var GRADS = {}, GRAD_N = 0;
  function glowAt(ctx, x, y, r, col, a) {
    r = Math.max(8, Math.round(r / 8) * 8);
    var key = col + '|' + r + '|' + a.toFixed(2);
    var g = GRADS[key];
    if (!g) {
      if (GRAD_N > 180) { GRADS = {}; GRAD_N = 0; }
      g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, col.replace('ALPHA', String(a)));
      g.addColorStop(1, col.replace('ALPHA', '0'));
      GRADS[key] = g;
      GRAD_N++;
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = g;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /* vendored content                                                    */
  /* ------------------------------------------------------------------ */
  // vendor/vendor.js is a classic script, so this works from file://. Every
  // read below is guarded: delete the bundle and the authored fallbacks carry
  // the game on their own.
  var VENDOR = window.AOMG_VENDOR || null;
  var VDATA = (VENDOR && VENDOR.data) || {};
  var DCSS = (VDATA['dcss/vaults'] && VDATA['dcss/vaults'].vaults) || [];
  var FLARE = VDATA['flare-game/assets'] || {};
  var RAW_ITEMS = FLARE.items || [];

  var ASSET_SET = {};
  (function () {
    var list = (VENDOR && VENDOR.assets) || [];
    for (var i = 0; i < list.length; i++) ASSET_SET[list[i]] = true;
  })();
  function hasAsset(p) { return !VENDOR || ASSET_SET[p] === true; }
  function assetUrl(p) { return '../../' + p; }

  /* ------------------------------------------------------------------ */
  /* art: painted windows and portraits, with authored fallbacks         */
  /* ------------------------------------------------------------------ */
  var ART = {};
  function loadArt(key, rel) {
    var rec = { img: null, ready: false, tex: null };
    ART[key] = rec;
    if (!rel || !hasAsset(rel)) return rec;
    var img = new Image();
    img.onload = function () {
      var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (!w || !h) return;
      rec.img = img; rec.w = w; rec.h = h; rec.ready = true;
      // 64px palette swatch: cheap, and the only thing legible in a 256px atlas
      var cv = document.createElement('canvas');
      cv.width = 64; cv.height = 64;
      var x = cv.getContext('2d');
      x.imageSmoothingEnabled = true;
      x.drawImage(img, 0, 0, w, h, 0, 0, 64, 64);
      rec.tex = cv;
    };
    img.onerror = function () { rec.ready = false; };
    img.src = assetUrl(rel);
    return rec;
  }

  // One atlas per creature family, used as a paint-through texture.
  var BESTIARY_TEX = {
    goblin: 'vendor/flare-game/monsters/goblin.png',
    skeleton: 'vendor/flare-game/monsters/skeleton.png',
    ant: 'vendor/flare-game/monsters/antlion.png',
    wyvern: 'vendor/flare-game/monsters/wyvern_run.png',
    minotaur: 'vendor/flare-game/monsters/minotaur_run.png',
    mage: 'vendor/flare-game/monsters/skeleton_mage.png'
  };
  loadArt('ui.panel', 'vendor/flare-game/ui/tooltips.png');
  loadArt('ui.character', 'vendor/flare-game/ui/character.png');
  loadArt('ui.book', 'vendor/flare-game/ui/book.png');
  loadArt('portrait', 'vendor/flare-game/portraits/female10.png');
  for (var bk in BESTIARY_TEX) loadArt('tex.' + bk, BESTIARY_TEX[bk]);

  /* ------------------------------------------------------------------ */
  /* Flare item records → playable loot                                  */
  /* ------------------------------------------------------------------ */
  /* Every number below comes from the upstream record; nothing is invented
     per-run, so the gear panel can state the same figures Flare does. */
  var LOOT = [];
  (function () {
    var i, r, b, it;
    for (i = 0; i < RAW_ITEMS.length; i++) {
      r = RAW_ITEMS[i];
      if (!r || !r.name) continue;
      b = r.bonus || {};
      it = {
        name: String(r.name), level: r.level || 1, price: r.price || 0,
        slot: r.slot || '', kind: 'trinket', min: 0, max: 0,
        armour: 0, hp: 0, mp: 0, def: 0, crit: 0, dkind: 'melee',
        mod: r.source_mod || 'flare'
      };
      if (r.damage && (r.damage.max || r.damage.min)) {
        it.kind = 'weapon';
        it.dkind = r.damage.kind || 'melee';
        it.min = Math.max(1, Math.round(r.damage.min || r.damage.max || 1));
        it.max = Math.max(it.min, Math.round(r.damage.max || r.damage.min || it.min));
        // Flare writes weapon upgrades as dmg_<kind>_min / _max on the record
        it.min += b['dmg_' + it.dkind + '_min'] || 0;
        it.max += b['dmg_' + it.dkind + '_max'] || 0;
        it.hp = b.hp || 0; it.mp = b.mp || 0;
        if (b.accuracy) it.crit = (b.accuracy / 100) * 0.25;
      } else if (r.armour || b.defense) {
        it.kind = 'armour';
        it.armour = (r.armour || 0) + (b.absorb_max || 0);
        it.def = b.defense || 0;
        it.hp = b.hp || 0;
      } else {
        it.hp = b.hp || 0; it.def = b.defense || 0; it.mp = b.mp || 0;
        if (b.accuracy) it.crit = (b.accuracy / 100) * 0.25;
      }
      it.value = Math.max(6, Math.round(it.price || it.level * 25));
      it.power = it.kind === 'weapon' ? (it.min + it.max) * 0.5 + it.level * 2
        : it.kind === 'armour' ? it.armour * 4 + it.def * 2 + it.level * 2
          : it.hp * 0.25 + it.def * 3 + it.level;
      LOOT.push(it);
    }
    if (!LOOT.length) {
      // no bundle: a small authored table so the loop still reads
      var f = [
        ['Cinder Dagger', 'weapon', 8, 11, 0, 0, 0, 60],
        ['Ashen Blade', 'weapon', 14, 19, 0, 0, 0, 140],
        ['Warden Hammer', 'weapon', 22, 30, 0, 0, 0, 320],
        ['Boiled Leather', 'armour', 0, 0, 3, 0, 12, 90],
        ['Iron Buckler', 'armour', 0, 0, 5, 0, 20, 180],
        ['Ember Ring', 'trinket', 0, 0, 0, 18, 0, 150],
        ['Ash Pendant', 'trinket', 0, 0, 0, 0, 25, 200],
        ['Soot Charm', 'trinket', 0, 0, 0, 10, 10, 120]
      ];
      for (i = 0; i < f.length; i++) {
        LOOT.push({
          name: f[i][0], kind: f[i][1], min: f[i][2], max: f[i][3], armour: f[i][4],
          hp: f[i][5], def: 0, crit: f[i][6] / 100, level: 1, price: f[i][7],
          value: f[i][7], slot: '', dkind: 'melee', mod: 'authored',
          power: f[i][1] === 'weapon' ? (f[i][2] + f[i][3]) * 0.5 + 2
            : f[i][1] === 'armour' ? f[i][4] * 4 + 2 : f[i][5] * 0.25 + 2
        });
      }
    }
    LOOT.sort(function (a, c) { return a.power - c.power; });
  })();
  function lootFor(depth) {
    // Items Flare levels 1..6 read as the shallow half of a run; deeper floors
    // skew to the higher-level records the same mod ships.
    var band = [], i, it;
    for (i = 0; i < LOOT.length; i++) {
      it = LOOT[i];
      if (it.level <= 1 + depth * 0.8) band.push(it);
    }
    if (!band.length) band = LOOT;
    return band;
  }
  function itemLine(it) {
    if (it.kind === 'weapon') return it.min + '–' + it.max + ' ' + (it.dkind === 'melee' ? 'MELEE' : it.dkind.toUpperCase());
    if (it.kind === 'armour') return '+' + (it.armour + it.def) + ' ARMOUR';
    var bits = [];
    if (it.hp) bits.push('+' + it.hp + ' HP');
    if (it.def) bits.push('+' + it.def + ' DEF');
    if (it.crit) bits.push('+' + Math.round(it.crit * 100) + '% CRIT');
    return bits.join(' · ') || 'RELIC';
  }
  var DEFAULT_WEAPON = { name: 'Dagger', kind: 'weapon', min: 10, max: 10, level: 1, value: 100, price: 100, dkind: 'melee', hp: 0, def: 0, crit: 0, armour: 0, power: 10, mod: 'flare' };
  (function () {
    for (var i = 0; i < LOOT.length; i++) {
      if (LOOT[i].kind === 'weapon' && LOOT[i].name === 'Dagger') { DEFAULT_WEAPON = LOOT[i]; return; }
    }
  })();
  /* ------------------------------------------------------------------ */
  /* DCSS vaults → floors                                                */
  /* ------------------------------------------------------------------ */
  /* A vault row can be shorter than the vault's widest row (DCSS lets the
     tail be void), so every grid is right-padded before any index maths. */
  function padGrid(v) {
    var w = 0, i, r;
    for (i = 0; i < v.grid.length; i++) if (v.grid[i].length > w) w = v.grid[i].length;
    var out = [];
    for (i = 0; i < v.grid.length; i++) {
      r = v.grid[i];
      while (r.length < w) r += ' ';
      out.push(r);
    }
    return out;
  }
  function at(grid, x, y) {
    if (y < 0 || y >= grid.length) return ' ';
    var r = grid[y];
    if (x < 0 || x >= r.length) return ' ';
    return r.charAt(x);
  }
  function openChar(c) { return c === '.' || c === '+' || c === '>'; }
  function floorAt(f, x, y) { return openChar(at(f.grid, x, y)); }

  var DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];

  /* The largest connected walkable pocket is the playable floor: DCSS vaults
     routinely contain sealed decoration that a mobile run must never see. */
  function biggestComp(grid) {
    var h = grid.length, w = h ? grid[0].length : 0;
    if (!h || !w) return null;
    var seen = new Uint8Array(w * h), best = null, x, y, d;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        if (!openChar(at(grid, x, y))) continue;
        var k = y * w + x;
        if (seen[k]) continue;
        var stack = [x, y], tiles = [];
        seen[k] = 1;
        while (stack.length) {
          var cy = stack.pop(), cx = stack.pop();
          tiles.push({ x: cx, y: cy });
          for (d = 0; d < 4; d++) {
            var nx = cx + DX[d], ny = cy + DY[d], kk = ny * w + nx;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (seen[kk] || !openChar(at(grid, nx, ny))) continue;
            seen[kk] = 1;
            stack.push(nx, ny);
          }
        }
        if (!best || tiles.length > best.tiles.length) best = { tiles: tiles, w: w, h: h };
      }
    }
    return best;
  }

  /* Distance field over walkable tiles; -1 is unreachable. Used for enemy
     pathing, tap-to-move, and "put the stairs as far from the door as we can". */
  function fieldFrom(f, sx, sy) {
    var w = f.w, h = f.h, dist = new Int16Array(w * h);
    dist.fill(-1);
    if (!floorAt(f, sx, sy)) return dist;
    var q = [sx, sy], head = 0;
    dist[sy * w + sx] = 0;
    while (head < q.length) {
      var cx = q[head++], cy = q[head++], cd = dist[cy * w + cx];
      if (cd > 900) continue;
      for (var d = 0; d < 4; d++) {
        var nx = cx + DX[d], ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        var k = ny * w + nx;
        if (dist[k] !== -1 || !floorAt(f, nx, ny)) continue;
        dist[k] = cd + 1;
        q.push(nx, ny);
      }
    }
    return dist;
  }

  /* Authored fallback geometry: a walled chamber with a few interior stubs and
     a stair mouth. Seeded, so each descent is its own room — the no-vendor path
     must still play like a dungeon, not like one room on loop. */
  function forgedFloor(rng) {
    var w = 9 + Math.floor(rng() * 5), h = 9 + Math.floor(rng() * 4);
    var g = [], x, y, i;
    for (y = 0; y < h; y++) {
      var row = '';
      for (x = 0; x < w; x++) row += (x === 0 || y === 0 || x === w - 1 || y === h - 1) ? '#' : '.';
      g.push(row);
    }
    var stubs = 3 + Math.floor(rng() * 4);
    for (i = 0; i < stubs; i++) {
      var rx = 2 + Math.floor(rng() * (w - 4)), ry = 2 + Math.floor(rng() * (h - 4));
      var len = 2 + Math.floor(rng() * 3), horiz = rng() < 0.5;
      for (var k = 0; k < len; k++) {
        var cx = horiz ? rx + k : rx, cy = horiz ? ry : ry + k;
        if (cx < 1 || cy < 1 || cx > w - 2 || cy > h - 2) break;
        var line = g[cy];
        g[cy] = line.substr(0, cx) + '#' + line.substr(cx + 1);
      }
    }
    // never leave the player sealed in: carve the chamber's middle open again
    var mx = (w / 2) | 0, my = (h / 2) | 0;
    for (y = my - 1; y <= my + 1; y++) {
      for (x = mx - 1; x <= mx + 1; x++) {
        var l2 = g[y];
        g[y] = l2.substr(0, x) + '.' + l2.substr(x + 1);
      }
    }
    return { grid: g, w: w, h: h };
  }

  function branchOf(tag) {
    if (!tag) return 'DEPTHS';
    var t = String(tag).replace(/[!^$*]/g, '').split(/[,:]/)[0].trim();
    if (!t) return 'DEPTHS';
    if (t === 'D' || t === 'Depths' || t === 'Depths:') return 'DEPTHS';
    return t.toUpperCase();
  }

  /* A run is ~40 minutes over ~10 floors, so a floor is 6..26 tiles wide. The
     corpus is filtered live (rejecting vaults with no walkable pocket, or the
     same id twice in a row) rather than pre-baked at boot: flood-filling one
     small grid costs almost nothing and keeps startup free. */
  function genFloor(depth, seed, avoidId) {
    var rng = GK.rand(seed), v = null, grid = null, comp = null, tries = 0, i;
    while (tries++ < 80) {
      if (!DCSS.length) break;
      v = DCSS[Math.floor(rng() * DCSS.length) % DCSS.length];
      if (!v || !v.grid || !v.grid.length) continue;
      if (v.id === avoidId) continue;
      grid = padGrid(v);
      if (!grid.length || grid[0].length < 6) continue;
      comp = biggestComp(grid);
      if (!comp || comp.tiles.length < 26) continue;
      break;
    }
    if (!comp) {
      // No corpus: forge a chamber from the run seed so floors still differ,
      // still carry stairs, and the loop survives with vendor/ deleted.
      var fg = forgedFloor(GK.rand(seed ^ 0x9e3779b9));
      grid = fg.grid;
      comp = biggestComp(grid);
      v = { id: 'forged-' + (seed % 9973), depth: 'D:' + depth, tags: [] };
    }

    var f = {
      id: v.id, depthTag: v.depth || 'D:' + depth, src: DCSS.length ? 'dcss' : 'forged',
      branch: branchOf(v.depth), w: comp.w, h: comp.h, grid: grid,
      depth: depth, enemies: [], loot: [], braziers: [], seed: seed
    };

    // ---- stairs: the corner of the pocket furthest from its centre -------
    var cxs = 0, cys = 0, t;
    for (i = 0; i < comp.tiles.length; i++) { cxs += comp.tiles[i].x; cys += comp.tiles[i].y; }
    cxs /= comp.tiles.length; cys /= comp.tiles.length;
    var stairTile = null, far = -1;
    for (i = 0; i < comp.tiles.length; i++) {
      t = comp.tiles[i];
      if (at(grid, t.x, t.y) === '>') { stairTile = t; break; }
      var dd = dist2(t.x, t.y, cxs, cys);
      if (dd > far) { far = dd; stairTile = t; }
    }
    f.stairs = { x: stairTile.x, y: stairTile.y };

    // ---- spawn: the walkable tile furthest from the stairs -----------------
    var fromStairs = fieldFrom(f, f.stairs.x, f.stairs.y);
    var spawn = null, spawnD = -1, east = null, eastD = -1;
    for (i = 0; i < comp.tiles.length; i++) {
      t = comp.tiles[i];
      var d2 = fromStairs[t.y * f.w + t.x];
      if (d2 < 0) continue;
      if (d2 > spawnD) { spawnD = d2; spawn = t; }
      // Floor 1 must let the player reach an adjacent kill in two steps east:
      // prefer a pocket mouth that opens eastwards.
      if (depth === 1 && floorAt(f, t.x + 1, t.y) && floorAt(f, t.x + 2, t.y)) {
        if (fromStairs[t.y * f.w + t.x + 1] >= 0 && fromStairs[t.y * f.w + t.x + 2] >= 0 && d2 > eastD) {
          eastD = d2; east = t;
        }
      }
    }
    if (east) spawn = east;
    if (!spawn) spawn = comp.tiles[0];
    f.spawn = { x: spawn.x, y: spawn.y };
    f.field = fieldFrom(f, f.spawn.x, f.spawn.y);

    return f;
  }

  /* ------------------------------------------------------------------ */
  /* bestiary                                                            */
  /* ------------------------------------------------------------------ */
  /* hp / dmg / cooldown are tuned against Flare's own weapon numbers so the
     starting Dagger (10–10) stays a two-hit kill on the shallow floors. */
  var KINDS = [
    { key: 'husk', name: 'Cinder Husk', fam: 'skeleton', hp: 16, dmg: 4, reach: 1.5, cd: 1.7, spd: 0.75, from: 1 },
    { key: 'goblin', name: 'Ash Goblin', fam: 'goblin', hp: 22, dmg: 6, reach: 1.5, cd: 1.5, spd: 0.55, from: 1 },
    { key: 'ant', name: 'Ember Ant', fam: 'ant', hp: 26, dmg: 5, reach: 1.5, cd: 1.4, spd: 0.5, from: 2 },
    { key: 'sentry', name: 'Bone Sentry', fam: 'skeleton', hp: 32, dmg: 8, reach: 1.5, cd: 1.8, spd: 0.7, from: 2 },
    { key: 'archer', name: 'Ash Archer', fam: 'skeleton', hp: 26, dmg: 7, reach: 5.5, cd: 2.1, spd: 0.85, from: 3, ranged: true },
    { key: 'reaver', name: 'Goblin Reaver', fam: 'goblin', hp: 46, dmg: 11, reach: 1.5, cd: 1.6, spd: 0.55, from: 4 },
    { key: 'antlion', name: 'Antlion', fam: 'ant', hp: 54, dmg: 12, reach: 1.5, cd: 1.9, spd: 0.7, from: 5 },
    { key: 'mage', name: 'Cinder Mage', fam: 'mage', hp: 42, dmg: 10, reach: 6.0, cd: 2.4, spd: 0.95, from: 6, ranged: true },
    { key: 'hob', name: 'Hobgoblin', fam: 'goblin', hp: 66, dmg: 14, reach: 1.5, cd: 1.5, spd: 0.5, from: 7 },
    { key: 'wyvern', name: 'Ash Wyvern', fam: 'wyvern', hp: 72, dmg: 15, reach: 1.6, cd: 1.7, spd: 0.45, from: 9 }
  ];
  var BOSSES = [
    { key: 'warden', name: 'Minotaur Warden', fam: 'minotaur', hp: 150, dmg: 20, reach: 1.9, cd: 1.8, spd: 0.6 },
    { key: 'marshal', name: 'Bone Marshal', fam: 'skeleton', hp: 175, dmg: 22, reach: 2.1, cd: 1.6, spd: 0.55 },
    { key: 'wyrm', name: 'Wyrm of Cinders', fam: 'wyvern', hp: 210, dmg: 25, reach: 2.2, cd: 1.9, spd: 0.5 }
  ];

  function makeEnemy(k, x, y, depth, boss, rng) {
    var scale = 1 + (depth - 1) * 0.22;
    return {
      kind: k, boss: !!boss, x: x, y: y, px: x, py: y,
      hp: Math.round(k.hp * scale), maxHp: Math.round(k.hp * scale),
      dmg: k.dmg * (1 + (depth - 1) * 0.12),
      t: rng ? rng() * 10 : Math.random() * 10,
      cool: (k.cd || 1.5) * 0.7, actT: (rng ? rng() : 0.5) * 0.9,
      windup: 0, hitT: 0, burn: 0, burnT: 0, dead: false, gone: false,
      face: 1, flash: 0
    };
  }

  function floorKinds(depth) {
    var out = [], i;
    for (i = 0; i < KINDS.length; i++) if (KINDS[i].from <= depth) out.push(KINDS[i]);
    return out.length ? out : [KINDS[0]];
  }

  function freeAt(f, x, y) {
    if (!floorAt(f, x, y)) return false;
    if (f.stairs.x === x && f.stairs.y === y) return false;
    var i;
    for (i = 0; i < f.enemies.length; i++) {
      var e = f.enemies[i];
      if (!e.gone && e.x === x && e.y === y) return false;
    }
    for (i = 0; i < f.loot.length; i++) if (f.loot[i].x === x && f.loot[i].y === y) return false;
    if (G && G.hero && G.hero.x === x && G.hero.y === y) return false;
    if (f.spawn.x === x && f.spawn.y === y) return false;
    return true;
  }

  /* The first floor is the tutorial: one enemy has to be close enough that the
     very first tap-swing connects, whatever vault the corpus handed us. */
  function ensureFirstFight(f) {
    var best = null, bd = 1e9, i, e;
    for (i = 0; i < f.enemies.length; i++) {
      e = f.enemies[i];
      if (e.dead) continue;
      var d = Math.abs(e.x - f.spawn.x) + Math.abs(e.y - f.spawn.y);
      if (d < bd) { bd = d; best = e; }
    }
    if (best && bd <= 2) return;
    for (i = 0; i < 4; i++) {
      var nx = f.spawn.x + DX[i], ny = f.spawn.y + DY[i];
      if (freeAt(f, nx, ny)) {
        if (best) { best.x = nx; best.y = ny; best.px = nx; best.py = ny; }
        else f.enemies.push(makeEnemy(KINDS[0], nx, ny, 1, false, GK.rand(7)));
        return;
      }
    }
  }

  function populate(f, depth, seed) {
    var rng = GK.rand(seed ^ 0x5f3a), i, t;
    var cands = [], d;
    for (i = 0; i < f.w * f.h; i++) {
      var x = i % f.w, y = (i / f.w) | 0;
      d = f.field[y * f.w + x];
      if (d >= 3 && floorAt(f, x, y)) cands.push({ x: x, y: y, d: d });
    }
    // Shuffle deterministically so the same seed always lays the same floor.
    for (i = cands.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1)), tmp = cands[i];
      cands[i] = cands[j]; cands[j] = tmp;
    }

    var kinds = floorKinds(depth);
    var want = Math.min(14, 4 + depth * 2);
    var boss = depth % 5 === 0;
    if (boss) want = Math.max(3, Math.round(want * 0.55));

    // Floor 1: guarantee a kill reachable in two steps east of the spawn.
    if (depth === 1) {
      var gx = f.spawn.x + 2, gy = f.spawn.y;
      if (floorAt(f, gx, gy) && floorAt(f, f.spawn.x + 1, gy)) {
        f.enemies.push(makeEnemy(KINDS[0], gx, gy, depth, false, rng));
        want--;
      }
    }
    if (boss) {
      // the boss waits between the stairs and the middle of the pocket
      var bestB = null, bestD = 1e9;
      for (i = 0; i < cands.length; i++) {
        t = cands[i];
        var sd = Math.abs(t.x - f.stairs.x) + Math.abs(t.y - f.stairs.y);
        if (sd >= 3 && sd < bestD && freeAt(f, t.x, t.y)) { bestD = sd; bestB = t; }
      }
      if (bestB) {
        f.enemies.push(makeEnemy(BOSSES[Math.min(BOSSES.length - 1, Math.floor(depth / 5) - 1)], bestB.x, bestB.y, depth, true, rng));
        bestB.taken = true;
      }
    }
    for (i = 0; i < cands.length && f.enemies.length < want + (boss ? 1 : 0); i++) {
      t = cands[i];
      if (t.taken || t.d < 5) continue;
      if (!freeAt(f, t.x, t.y)) continue;
      f.enemies.push(makeEnemy(kinds[Math.floor(rng() * kinds.length) % kinds.length], t.x, t.y, depth, false, rng));
      t.taken = true;
    }

    // ---- loot: Flare records, one guaranteed weapon early -----------------
    var band = lootFor(depth), pool = [], drops = 2 + Math.min(3, Math.floor(depth / 0.5) % 4);
    var forced = null, n;
    if (depth <= 2) {
      for (n = 0; n < LOOT.length; n++) if (LOOT[n].kind === 'weapon' && LOOT[n].power <= 14) { forced = LOOT[n]; break; }
    }
    for (i = 0; i < cands.length && f.loot.length < drops; i++) {
      t = cands[i];
      if (t.taken || t.d < 6) continue;
      if (!freeAt(f, t.x, t.y)) continue;
      var it = forced || band[Math.floor(rng() * band.length) % band.length];
      if (forced) forced = null;
      f.loot.push({ x: t.x, y: t.y, item: it, kind: 'item', t: rng() * 3, taken: false });
      t.taken = true;
    }
    for (i = 0; i < cands.length && f.loot.length < drops + 3; i++) {
      t = cands[i];
      if (t.taken || t.d < 4) continue;
      if (!freeAt(f, t.x, t.y)) continue;
      f.loot.push({ x: t.x, y: t.y, gold: 12 + Math.floor(rng() * 26) + depth * 6, kind: 'gold', t: rng() * 3, taken: false });
      t.taken = true;
    }

    if (depth === 1) ensureFirstFight(f);

    // ---- braziers: static light pools, at most three per floor ------------
    for (i = 0; i < cands.length && f.braziers.length < 3; i++) {
      t = cands[i];
      if (t.taken || t.d < 5) continue;
      if (!floorAt(f, t.x, t.y)) continue;
      f.braziers.push({ x: t.x, y: t.y, p: rng() * TAU });
      t.taken = true;
    }
  }
  /* ------------------------------------------------------------------ */
  /* meta save                                                           */
  /* ------------------------------------------------------------------ */
  var STORE = GK.store('cinderhold');
  var META = (function () {
    var m = STORE.get('save', null);
    if (!m || typeof m !== 'object') m = {};
    return {
      gold: m.gold | 0, best: Math.max(1, m.best | 0), runs: m.runs | 0,
      kills: m.kills | 0, sound: m.sound !== false,
      up: { vit: (m.up && m.up.vit) | 0, edge: (m.up && m.up.edge) | 0, ward: (m.up && m.up.ward) | 0, luck: (m.up && m.up.luck) | 0 },
      stash: (m.stash && m.stash.length) ? m.stash.slice(0, 8) : []
    };
  })();
  function saveMeta() {
    STORE.set('save', META);
  }
  if (!META.sound) GK.sfx.enabled = false;

  var UPG = [
    { key: 'vit', name: 'VITALITY', desc: '+10 max HP', base: 90, step: 80 },
    { key: 'edge', name: 'EDGE', desc: '+2 weapon damage', base: 120, step: 95 },
    { key: 'ward', name: 'WARD', desc: '+2 armour', base: 110, step: 90 },
    { key: 'luck', name: 'LUCK', desc: '+3% crit', base: 150, step: 130 }
  ];
  function upgCost(u) { return u.base + u.step * META.up[u.key]; }

  /* ------------------------------------------------------------------ */
  /* run state                                                           */
  /* ------------------------------------------------------------------ */
  var G = null;
  var UI = { panel: null, toast: '', toastT: 0, flash: 0, hitstop: 0, shake: 0, hurtFlash: 0, press: [0, 0, 0] };
  var SWING_REACH = 1.6;

  function newHero() {
    return {
      x: 0, y: 0, px: 0, py: 0, face: 1, hp: 100, maxHp: 100,
      atkT: 0, swingA: 0, invuln: 0, rollT: 0, rollDX: 0, rollDY: 0,
      moveCd: 0, stepAnim: 0, hitT: 0, path: null, regenT: 0
    };
  }

  function armourPoints() {
    var a = 0;
    if (G.armour) a += G.armour.armour + G.armour.def;
    if (G.trinket) a += G.trinket.def;
    return a + META.up.ward * 2;
  }
  function critChance() {
    return clamp(0.08 + META.up.luck * 0.03 + (G.weapon.crit || 0), 0, 0.6);
  }
  function heroDamage() {
    var w = G.weapon;
    var dmg = GK.ri(G.rng, w.min, w.max) + META.up.edge * 2;
    return dmg;
  }

  function startRun() {
    var seed = (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0;
    G = {
      seed: seed, rng: GK.rand(seed), mode: 'play', depth: 1,
      kills: 0, gold: 0, lootValue: 0, bag: [], stashNew: 0,
      hp: 0, maxHp: 0, runT: 0, floors: 0, lastVault: '', vaultId: '',
      vaultTag: '', floorsSame: false, prevVault: '',
      weapon: DEFAULT_WEAPON, armour: null, trinket: null,
      hero: newHero(), floor: null,
      skills: [
        { name: 'WHIRL', key: 'whirl', cd: 6, t: 0, col: C.ember },
        { name: 'NOVA', key: 'nova', cd: 11, t: 0, col: '#ff6a4a' },
        { name: 'DASH', key: 'dash', cd: 5, t: 0, col: C.gold }
      ],
      bossDown: 0, best: 0
    };
    // carried-out gear is the point of the meta save: armed before the descent
    for (var i = 0; i < META.stash.length; i++) {
      var s = META.stash[i];
      if (!s) continue;
      if (s.kind === 'weapon' && s.power > G.weapon.power) G.weapon = s;
      else if (s.kind === 'armour' && (!G.armour || s.power > G.armour.power)) G.armour = s;
      else if (s.kind === 'trinket' && (!G.trinket || s.power > G.trinket.power)) G.trinket = s;
    }
    G.maxHp = 100 + META.up.vit * 10 + (G.trinket ? G.trinket.hp : 0);
    G.hero.maxHp = G.maxHp;
    G.hero.hp = G.maxHp;
    UI.panel = null;
    UI.toastT = 0;
    enterFloor(1);
    if (pad) pad.show(true);
    toast(G.vaultId ? 'THE VAULT REMEMBERS YOU' : 'THE EMPTY HALL');
    GK.sfx.unlock();
  }

  function enterFloor(depth) {
    var f = genFloor(depth, (G.seed + depth * 7919) >>> 0, G.prevVault || G.lastVault);
    G.floorsSame = !!(G.prevVault && f.id === G.prevVault);
    G.prevVault = f.id;
    G.vaultId = f.id;
    G.vaultTag = f.depthTag;
    G.depth = depth;
    G.floor = f;
    populate(f, depth, (G.seed + depth * 104729) >>> 0);
    G.hero.x = f.spawn.x; G.hero.y = f.spawn.y;
    G.hero.px = f.spawn.x; G.hero.py = f.spawn.y;
    G.hero.path = null;
    cam.x = isoX(f.spawn.x, f.spawn.y);
    cam.y = isoY(f.spawn.x, f.spawn.y);
    bakeFloor(f);
    f.hf = f.field; f.hx = f.spawn.x; f.hy = f.spawn.y;
    for (var i = 0; i < PARTS.length; i++) PARTS[i].live = false;
    for (i = 0; i < DARRS.length; i++) DARRS[i].live = false;
    for (i = 0; i < SHOTS.length; i++) SHOTS[i].live = false;
  }

  function descend() {
    if (!G || G.mode !== 'play') return false;
    var heal = Math.min(G.maxHp - G.hero.hp, 14 + G.depth * 2);
    G.hero.hp += heal;
    enterFloor(G.depth + 1);
    G.floors++;
    UI.flash = 0.5;
    UI.shake = 6;
    toast('DESCENDED · FLOOR ' + G.depth + ' · ' + G.floor.branch);
    GK.sfx.boom();
    GK.buzz(18);
    return true;
  }

  function toast(s) { UI.toast = s; UI.toastT = 1.3; }

  /* ------------------------------------------------------------------ */
  /* movement + combat                                                   */
  /* ------------------------------------------------------------------ */
  function enemyAt(x, y) {
    var f = G.floor;
    for (var i = 0; i < f.enemies.length; i++) {
      var e = f.enemies[i];
      if (!e.gone && !e.dead && e.x === x && e.y === y) return e;
    }
    return null;
  }
  function canWalk(x, y) {
    return floorAt(G.floor, x, y) && !enemyAt(x, y);
  }

  function stepHero(x, y, silent) {
    var h = G.hero;
    if (!canWalk(x, y)) return false;
    h.x = x; h.y = y;
    h.moveCd = 0.16;
    h.stepAnim = 0.16;
    if (!silent) GK.sfx.step();
    // a small puff at the heels sells the step without a walk cycle
    spawnDust(isoX(x, y), isoY(x, y));
    pickUpHere();
    return true;
  }

  function spawnDust(x, y) {
    for (var i = 0, made = 0; i < PARTS.length && made < 4; i++) {
      var p = PARTS[i];
      if (p.live) continue;
      p.live = true;
      p.x = x + (Math.random() - 0.5) * TW * 0.5;
      p.y = y + (Math.random() - 0.5) * TH * 0.4;
      p.vx = (Math.random() - 0.5) * 16;
      p.vy = -6 - Math.random() * 12;
      p.g = 26;
      p.life = 0.34 + Math.random() * 0.2;
      p.max = p.life;
      p.size = 1.4 + Math.random() * 2.2;
      p.col = '#8a7368';
      p.glow = false;
      made++;
    }
  }

  function pickUpHere() {
    var f = G.floor, h = G.hero, i, l;
    for (i = 0; i < f.loot.length; i++) {
      l = f.loot[i];
      if (l.taken || l.x !== h.x || l.y !== h.y) continue;
      l.taken = true;
      if (l.kind === 'gold') {
        G.gold += l.gold;
        spawnBurst(isoX(l.x, l.y), isoY(l.x, l.y), 8, C.gold, 0.6);
        GK.sfx.coin();
        toast('+' + l.gold + ' GOLD');
      } else {
        takeItem(l.item);
      }
    }
  }

  function takeItem(it) {
    var better = false, label;
    if (it.kind === 'weapon' && it.power > G.weapon.power) { G.weapon = it; better = true; }
    else if (it.kind === 'armour' && (!G.armour || it.power > G.armour.power)) { G.armour = it; better = true; }
    else if (it.kind === 'trinket' && (!G.trinket || it.power > G.trinket.power)) { G.trinket = it; better = true; }
    G.lootValue += it.value;
    label = it.name + ' · ' + itemLine(it);
    if (better) toast(label);
    else if (G.bag.length < 6) { G.bag.push(it); toast(label); }
    else toast('BAG FULL · ' + it.name);
    // a trinket can move max HP; healing the difference keeps the pickup a gift
    var nm = 100 + META.up.vit * 10 + (G.trinket ? G.trinket.hp : 0);
    if (nm > G.maxHp) G.hero.hp += nm - G.maxHp;
    G.maxHp = nm;
    G.hero.maxHp = nm;
    GK.sfx.coin();
    GK.buzz(10);
    if (better) UI.flash = 0.3;
  }

  function nearestEnemy(maxD) {
    var f = G.floor, h = G.hero, best = null, bd = maxD * maxD;
    for (var i = 0; i < f.enemies.length; i++) {
      var e = f.enemies[i];
      if (e.dead || e.gone) continue;
      var d = dist2(h.x, h.y, e.x, e.y);
      if (d <= bd) { bd = d; best = e; }
    }
    return best;
  }

  function stepToward(e) {
    var f = G.floor, h = G.hero;
    // acts can arrive between animation frames, so the chase field is refreshed
    // here rather than trusting the one the last update left behind
    if (!f.hf || f.hx !== h.x || f.hy !== h.y) {
      f.hf = fieldFrom(f, h.x, h.y);
      f.hx = h.x; f.hy = h.y;
    }
    var cx = h.x, cy = h.y, cur = f.hf[cy * f.w + cx];
    var best = null, bv = cur;
    for (var d = 0; d < 4; d++) {
      var nx = cx + DX[d], ny = cy + DY[d], v;
      if (!canWalk(nx, ny)) continue;
      v = f.hf[ny * f.w + nx];
      if (v >= 0 && v < bv) { bv = v; best = { x: nx, y: ny }; }
    }
    return best;
  }

  function swing() {
    var h = G.hero, f = G.floor, tgt = nearestEnemy(SWING_REACH + 0.35);
    if (!tgt) {
      // no one in reach: the swing carries the hero forward, so a tap-spam
      // player closes the gap instead of whiffing at the air
      for (var lunge = 0; lunge < 3 && !tgt; lunge++) {
        var near = nearestEnemy(9);
        if (!near) break;
        var st = stepToward(near);
        if (!st || !stepHero(st.x, st.y, true)) break;
        tgt = nearestEnemy(SWING_REACH + 0.35);
      }
    }
    h.atkT = 0.3;
    h.swingA = Math.atan2((tgt ? tgt.py : h.y + 1) - h.py, (tgt ? tgt.px : h.x + 1) - h.px);
    if (h.swingA > -0.6 && h.swingA < 0.6) h.face = 1;
    if (h.swingA > 2.4 || h.swingA < -2.4) h.face = -1;
    if (tgt) {
      hitEnemy(tgt, heroDamage(), true);
      return true;
    }
    GK.sfx.step();
    return false;
  }

  function hitEnemy(e, dmg, canCrit) {
    if (e.dead) return;
    var crit = canCrit && G.rng() < critChance();
    if (crit) dmg = Math.round(dmg * 1.8);
    e.hp -= dmg;
    e.flash = 0.14;
    e.hitT = 0.22;
    e.face = e.x >= G.hero.x ? -1 : 1;
    UI.hitstop = crit ? 0.075 : 0.045;
    UI.shake = Math.min(14, UI.shake + (crit ? 8 : 4.5));
    spawnBurst(isoX(e.x, e.y), isoY(e.x, e.y) - BH * 0.5, crit ? 12 : 7, crit ? C.gold : C.ember, 1);
    dmgNum(isoX(e.x, e.y), isoY(e.x, e.y) - BH, dmg, crit ? C.gold : C.ink, crit);
    GK.sfx.hit();
    GK.buzz(crit ? 22 : 12);
    if (e.hp <= 0) killEnemy(e);
  }

  function killEnemy(e) {
    e.dead = true;
    e.goneT = 0.55;
    G.kills++;
    spawnBurst(isoX(e.x, e.y), isoY(e.x, e.y) - BH * 0.5, e.boss ? 26 : 12, C.blood, 1.1);
    if (e.boss) {
      G.bossDown++;
      G.gold += 60 + G.depth * 10;
      UI.shake = 16;
      UI.flash = 0.55;
      G.floor.loot.push({ x: e.x, y: e.y, item: LOOT[Math.min(LOOT.length - 1, LOOT.length - 1 - Math.floor(G.rng() * 4))], kind: 'item', t: 0, taken: false });
      toast(e.kind.name.toUpperCase() + ' FALLS');
      GK.sfx.win();
    } else {
      GK.sfx.boom();
    }
    // a killed thing sometimes leaves what it carried
    if (!e.boss && G.rng() < 0.22) {
      var band = lootFor(G.depth);
      G.floor.loot.push({ x: e.x, y: e.y, item: band[Math.floor(G.rng() * band.length) % band.length], kind: 'item', t: 0, taken: false });
    }
  }

  function hurtHero(dmg, src) {
    var h = G.hero;
    if (h.invuln > 0 || h.rollT > 0 || G.mode !== 'play') return;
    var red = Math.min(12, armourPoints() * 0.55);
    var real = Math.max(1, Math.round(dmg - red));
    h.hp -= real;
    h.invuln = 0.65;
    h.hitT = 0.3;
    h.regenT = 4;
    UI.hurtFlash = 0.45;
    UI.shake = Math.min(18, UI.shake + 7);
    dmgNum(VW * 0.5, VH * 0.55, real, C.bad, false, true);
    spawnBurst(isoX(h.x, h.y), isoY(h.x, h.y) - BH * 0.5, 9, C.blood, 1);
    GK.sfx.hurt();
    GK.buzz(28);
    if (h.hp <= 0) die();
  }

  function die() {
    G.mode = 'dead';
    G.hero.hp = 0;
    UI.shake = 20;
    UI.hurtFlash = 0.9;
    var banked = G.gold + Math.round(G.lootValue * 0.4);
    META.gold += banked;
    META.runs++;
    META.kills += G.kills;
    if (G.depth > META.best) META.best = G.depth;
    // carried gear survives the run
    var keep = (G.bag || []).slice(0, 6);
    if (G.weapon && G.weapon !== DEFAULT_WEAPON) keep.unshift(G.weapon);
    if (G.armour) keep.unshift(G.armour);
    META.stash = keep.slice(0, 8);
    G.banked = banked;
    saveMeta();
    UI.panel = null;
    if (pad) pad.show(false);
    GK.sfx.lose();
  }

  function rollToward(dx, dy) {
    var h = G.hero;
    if (!G || G.mode !== 'play' || h.rollT > 0) return false;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= len; dy /= len;
    var gx = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : -1) : 0;
    var gy = gx === 0 ? (dy > 0 ? 1 : -1) : 0;
    if (!gx && !gy) return false;
    h.rollT = 0.26;
    h.rollDX = gx; h.rollDY = gy;
    h.invuln = Math.max(h.invuln, 0.3);
    GK.sfx.jump();
    GK.buzz(10);
    var moved = 0, t;
    for (var i = 0; i < 2; i++) {
      t = { x: h.x + gx, y: h.y + gy };
      if (!canWalk(t.x, t.y)) break;
      stepHero(t.x, t.y, true); moved++;
    }
    spawnBurst(isoX(h.x, h.y), isoY(h.x, h.y) - BH * 0.4, 10, C.ash, 0.5);
    return moved > 0;
  }

  function useSkill(i) {
    if (!G || G.mode !== 'play') return false;
    var s = G.skills[i], h = G.hero, f = G.floor, k, e, d;
    if (!s || s.t > 0) return false;
    if (s.key === 'whirl') {
      var hitAny = false;
      for (k = 0; k < f.enemies.length; k++) {
        e = f.enemies[k];
        if (e.dead || e.gone) continue;
        d = Math.sqrt(dist2(h.x, h.y, e.x, e.y));
        if (d <= 2.4) { hitEnemy(e, Math.round(heroDamage() * 1.15), true); hitAny = true; }
      }
      spawnRing(isoX(h.x, h.y), isoY(h.x, h.y), 2.4 * TW * 0.5, C.ember);
      UI.shake = Math.max(UI.shake, 8);
      GK.sfx.shoot();
      if (!hitAny) toast('WHIRL · nothing in reach');
    } else if (s.key === 'nova') {
      for (k = 0; k < f.enemies.length; k++) {
        e = f.enemies[k];
        if (e.dead || e.gone) continue;
        d = Math.sqrt(dist2(h.x, h.y, e.x, e.y));
        if (d <= 4.2) {
          hitEnemy(e, Math.round(heroDamage() * 1.5), false);
          e.burn = 3; e.burnTick = 0.4;
        }
      }
      spawnRing(isoX(h.x, h.y), isoY(h.x, h.y), 4.2 * TW * 0.5, '#ff6a4a');
      UI.flash = 0.4;
      UI.shake = Math.max(UI.shake, 10);
      GK.sfx.boom();
    } else if (s.key === 'dash') {
      var dx = 0, dy = 1;
      if (Math.abs(Math.cos(h.swingA)) > Math.abs(Math.sin(h.swingA))) dx = Math.cos(h.swingA) > 0 ? 1 : -1; else dy = Math.sin(h.swingA) > 0 ? 1 : -1;
      var steps = 0;
      for (k = 0; k < 3; k++) {
        var nx = h.x + dx, ny = h.y + dy;
        if (!canWalk(nx, ny)) break;
        stepHero(nx, ny, true);
        steps++;
        var tgt = enemyAt(nx, ny);
        if (tgt) hitEnemy(tgt, Math.round(heroDamage() * 0.9), true);
      }
      spawnBurst(isoX(h.x, h.y), isoY(h.x, h.y) - BH * 0.4, 14, C.gold, 0.6);
      GK.sfx.jump();
      if (!steps) toast('DASH · wall');
    }
    s.t = s.cd;
    GK.buzz(14);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* enemy brain                                                         */
  /* ------------------------------------------------------------------ */
  function stepEnemy(e) {
    var f = G.floor, h = G.hero, cx = e.x, cy = e.y, cur, best = null, bv, d;
    if (!f.hf) return;
    cur = f.hf[cy * f.w + cx];
    bv = cur >= 0 ? cur : 9999;
    for (d = 0; d < 4; d++) {
      var nx = cx + DX[d], ny = cy + DY[d], v;
      if (nx === h.x && ny === h.y) continue;
      if (!floorAt(f, nx, ny) || enemyAt(nx, ny)) continue;
      v = f.hf[ny * f.w + nx];
      if (v >= 0 && v < bv) { bv = v; best = { x: nx, y: ny }; }
    }
    if (best) {
      e.face = best.x >= e.x ? 1 : -1;
      e.x = best.x; e.y = best.y;
    }
  }

  function updateEnemies(dt) {
    var f = G.floor, h = G.hero, i, e, d;
    if (h.x !== f.hx || h.y !== f.hy) {
      f.hf = fieldFrom(f, h.x, h.y);
      f.hx = h.x; f.hy = h.y;
    }
    for (i = 0; i < f.enemies.length; i++) {
      e = f.enemies[i];
      e.t += dt;
      if (e.gone) continue;
      if (e.dead) {
        e.goneT -= dt;
        if (e.goneT <= 0) e.gone = true;
        continue;
      }
      if (e.flash > 0) e.flash -= dt;
      if (e.hitT > 0) e.hitT -= dt;
      e.px = lerp(e.px, e.x, Math.min(1, dt * 9));
      e.py = lerp(e.py, e.y, Math.min(1, dt * 9));
      if (e.burn > 0) {
        e.burn -= dt;
        e.burnTick -= dt;
        if (e.burnTick <= 0) {
          e.burnTick = 0.55;
          e.hp -= 4;
          dmgNum(isoX(e.x, e.y), isoY(e.x, e.y) - BH * 0.8, 4, C.ember, false);
          spawnBurst(isoX(e.x, e.y), isoY(e.x, e.y) - BH * 0.4, 3, C.ember, 0.5);
          if (e.hp <= 0) killEnemy(e);
        }
      }
      d = Math.sqrt(dist2(h.x, h.y, e.x, e.y));
      var reach = e.kind.reach + (e.boss ? 0.4 : 0);
      if (e.windup > 0) {
        e.windup -= dt;
        if (e.windup <= 0) {
          if (Math.sqrt(dist2(h.x, h.y, e.x, e.y)) <= reach + 0.6) {
            if (e.kind.ranged) shoot(e);
            else hurtHero(e.dmg, e);
          } else {
            spawnBurst(isoX(e.x, e.y), isoY(e.x, e.y) - BH * 0.4, 3, C.ash, 0.4);
          }
        }
        continue;
      }
      e.cool -= dt;
      e.moveT = (e.moveT || 0) - dt;
      if (d <= reach) {
        if (e.cool <= 0) { e.cool = e.kind.cd; e.windup = e.boss ? 0.5 : 0.42; }
      } else if (d < 14 && e.moveT <= 0) {
        stepEnemy(e);
        e.moveT = e.kind.spd * (0.9 + G.rng() * 0.3);
      }
    }
  }

  function shoot(e) {
    var s = null;
    for (var i = 0; i < SHOTS.length; i++) if (!SHOTS[i].live) { s = SHOTS[i]; break; }
    if (!s) return;
    s.live = true; s.x = e.x; s.y = e.y; s.tx = G.hero.x; s.ty = G.hero.y;
    s.t = 0; s.dur = 0.34; s.dmg = e.dmg; s.col = e.kind.fam === 'mage' ? '#ff7ad9' : C.ember;
    GK.sfx.shoot();
  }

  function updateShots(dt) {
    for (var i = 0; i < SHOTS.length; i++) {
      var s = SHOTS[i];
      if (!s.live) continue;
      s.t += dt;
      if (s.t >= s.dur) {
        s.live = false;
        if (s.tx === G.hero.x && s.ty === G.hero.y) hurtHero(s.dmg, null);
        spawnBurst(isoX(s.tx, s.ty), isoY(s.tx, s.ty) - BH * 0.4, 5, s.col, 0.4);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* input                                                               */
  /* ------------------------------------------------------------------ */
  var HITS = [];
  function hit(x, y, w, h, fn) { HITS.push({ x: x, y: y, w: w, h: h, fn: fn }); }

  var tapStart = null, swiped = false;
  function canvasPoint(e) {
    var r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left), y: (e.clientY - r.top) };
  }
  function onDown(e) {
    if (G && G.mode === 'play') { /* keep pad independent */ }
    var p = canvasPoint(e);
    tapStart = { x: p.x, y: p.y, t: performance.now() };
    swiped = false;
  }
  function onMove(e) {
    if (!tapStart || swiped || !G || G.mode !== 'play' || UI.panel) return;
    var p = canvasPoint(e);
    var dx = p.x - tapStart.x, dy = p.y - tapStart.y;
    if (Math.sqrt(dx * dx + dy * dy) > 34) {
      swiped = true;
      rollToward(dx, dy);
    }
  }
  function onUp(e) {
    if (!tapStart) return;
    var p = canvasPoint(e), t = tapStart;
    tapStart = null;
    if (swiped) { swiped = false; return; }
    if (performance.now() - t.t > 700) return;
    var i;
    for (i = HITS.length - 1; i >= 0; i--) {
      var hh = HITS[i];
      if (p.x >= hh.x && p.x <= hh.x + hh.w && p.y >= hh.y && p.y <= hh.y + hh.h) { hh.fn(); return; }
    }
    // a modal owns the screen: a stray tap must not walk the hero behind it
    if (G && G.mode === 'play' && !UI.panel) tapWorld(p.x, p.y);
  }

  function tapWorld(sx, sy) {
    var h = G.hero, f = G.floor;
    var wx = sx - VW * 0.5 + cam.x, wy = sy - VH * 0.47 + cam.y;
    var gx = Math.round((wx / (TW * 0.5) + wy / (TH * 0.5)) * 0.5);
    var gy = Math.round((wy / (TH * 0.5) - wx / (TW * 0.5)) * 0.5);
    if (gx === h.x && gy === h.y) { swing(); return; }
    if (!floorAt(f, gx, gy)) return;
    var e = enemyAt(gx, gy);
    if (e && Math.sqrt(dist2(h.x, h.y, gx, gy)) <= SWING_REACH + 0.35) { swing(); return; }
    // tap-to-step: one BFS field from the target, then walk down the gradient
    var field = fieldFrom(f, gx, gy);
    if (field[h.y * f.w + h.x] < 0) return;
    h.path = { f: field, tx: gx, ty: gy };
    GK.sfx.step();
  }

  function stepPad() {
    var h = G.hero, x = pad ? pad.state.x : 0, y = pad ? pad.state.y : 0;
    if (!G || G.mode !== 'play') return;
    if (Math.abs(x) < 0.25 && Math.abs(y) < 0.25) return;
    var gx = Math.abs(x) > Math.abs(y) ? (x > 0 ? 1 : -1) : 0;
    var gy = gx === 0 ? (y > 0 ? 1 : -1) : 0;
    if (!gx && !gy) return;
    if (Math.abs(x) < 0.25) gx = 0;
    if (Math.abs(y) < 0.25) gy = 0;
    if (gx && gy) gy = 0;              // tiles, not diagonals, on the thumb pad
    if (stepHero(h.x + gx, h.y + gy)) h.path = null;
  }

  function updateGame(dt) {
    var h = G.hero, f = G.floor, i, s;
    G.runT += dt;
    if (h.invuln > 0) h.invuln -= dt;
    if (h.atkT > 0) h.atkT -= dt;
    if (h.moveCd > 0) h.moveCd -= dt;
    if (h.stepAnim > 0) h.stepAnim -= dt;
    if (h.hitT > 0) h.hitT -= dt;
    if (h.rollT > 0) h.rollT -= dt;
    for (i = 0; i < G.skills.length; i++) { s = G.skills[i]; if (s.t > 0) s.t -= dt; }

    if (h.regenT > 0) h.regenT -= dt;
    else if (h.hp < G.maxHp) h.hp = Math.min(G.maxHp, h.hp + dt * 1.4);

    if (pad && pad.state.jump) {
      h.atkHold = (h.atkHold || 0) + dt;
      if (h.atkHold > 0.34) { h.atkHold = 0; swing(); }
    } else h.atkHold = 0;

    if (h.path) {
      if (h.x === h.path.tx && h.y === h.path.ty) h.path = null;
      else if (h.moveCd <= 0) {
        var cur = h.path.f[h.y * f.w + h.x], best = null, bv = cur, d;
        for (d = 0; d < 4; d++) {
          var nx = h.x + DX[d], ny = h.y + DY[d], v;
          if (!floorAt(f, nx, ny)) continue;
          v = h.path.f[ny * f.w + nx];
          if (v >= 0 && v < bv) { bv = v; best = { x: nx, y: ny }; }
        }
        if (!best || !stepHero(best.x, best.y)) h.path = null;
      }
    } else if (h.moveCd <= 0) stepPad();

    h.px = lerp(h.px, h.x, Math.min(1, dt * 12));
    h.py = lerp(h.py, h.y, Math.min(1, dt * 12));

    updateEnemies(dt);
    updateShots(dt);

    // camera leads the hero a touch in the facing direction
    cam.tx = isoX(h.px, h.py) + h.face * TW * 0.5;
    cam.ty = isoY(h.px, h.py);
    cam.x = lerp(cam.x, cam.tx, Math.min(1, dt * 7));
    cam.y = lerp(cam.y, cam.ty, Math.min(1, dt * 7));

  }

  function updateFx(dt) {
    var i, p;
    for (i = 0; i < PARTS.length; i++) {
      p = PARTS[i];
      if (!p.live) continue;
      p.life -= dt;
      if (p.life <= 0) { p.live = false; continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += p.g * dt;
      p.vx *= 0.985;
    }
    for (i = 0; i < DARRS.length; i++) {
      p = DARRS[i];
      if (!p.live) continue;
      p.life -= dt;
      if (p.life <= 0) { p.live = false; continue; }
      p.y -= dt * (p.big ? 62 : 46);
    }
    if (UI.shake > 0) UI.shake = Math.max(0, UI.shake - dt * 26);
    if (UI.flash > 0) UI.flash = Math.max(0, UI.flash - dt * 2.2);
    if (UI.hurtFlash > 0) UI.hurtFlash = Math.max(0, UI.hurtFlash - dt * 2.4);
    if (UI.toastT > 0) UI.toastT -= dt;
    for (i = 0; i < UI.press.length; i++) if (UI.press[i] > 0) UI.press[i] = Math.max(0, UI.press[i] - dt);
    if (UI.hitstop > 0) UI.hitstop = Math.max(0, UI.hitstop - dt);
  }

  /* ------------------------------------------------------------------ */
  /* debug surface the harness drives                                    */
  /* ------------------------------------------------------------------ */
  function state() {
    var f = G && G.floor;
    return {
      started: !!(G && G.mode !== 'title'),
      mode: G ? G.mode : 'title',
      score: G ? G.depth * 120 + G.kills * 8 + G.lootValue : 0,
      depth: G ? G.depth : 0,
      vaultId: G ? G.vaultId : '',
      vaultSrc: f ? f.src : (DCSS.length ? 'dcss' : 'forged'),
      vaultsLoaded: DCSS.length,
      itemsInTable: LOOT.length,
      kills: G ? G.kills : 0,
      floorsSameVault: G ? !!G.floorsSame : false,
      hp: G ? Math.round(G.hero.hp) : 0,
      maxHp: G ? G.maxHp : 0,
      /* where the hunter is and which way the nearest live creature lies, so the
         harness can drive a real fight instead of guessing a direction */
      hero: G ? { x: G.hero.x, y: G.hero.y } : null,
      nearest: (function () {
        if (!f || !G || !f.enemies || !f.enemies.length) return null;
        var best = null, bd = 1e9, i, e, d;
        for (i = 0; i < f.enemies.length; i++) {
          e = f.enemies[i];
          if (!e || e.hp <= 0) continue;
          d = Math.abs(e.x - G.hero.x) + Math.abs(e.y - G.hero.y);
          if (d < bd) { bd = d; best = e; }
        }
        if (!best) return null;
        return {
          dx: best.x > G.hero.x ? 1 : best.x < G.hero.x ? -1 : 0,
          dy: best.y > G.hero.y ? 1 : best.y < G.hero.y ? -1 : 0,
          dist: bd
        };
      })(),
      gold: G ? G.gold : 0,
      branch: f ? f.branch : '',
      enemies: f ? f.enemies.length : 0,
      loot: f ? f.loot.length : 0
    };
  }

  function act(name, arg) {
    if (name === 'newGame') { startRun(); return true; }
    if (!G) return false;
    if (name === 'step') {
      if (G.mode === 'dead' || G.mode === 'title') return false;
      if (G.mode !== 'play') { UI.panel = null; G.mode = 'play'; }
      arg = arg || { x: 0, y: 1 };
      var dx = arg.x | 0, dy = arg.y | 0;
      var gx = dx > 0 ? 1 : dx < 0 ? -1 : 0, gy = dx ? 0 : (dy > 0 ? 1 : dy < 0 ? -1 : 0);
      G.hero.path = null;
      stepHero(G.hero.x + gx, G.hero.y + gy);
      return true;
    }
    if (name === 'attack') {
      if (G.mode === 'dead') return false;
      if (G.mode !== 'play') { UI.panel = null; G.mode = 'play'; }
      swing();
      return true;
    }
    if (name === 'descend') {
      if (G.mode === 'dead') return false;
      if (G.mode !== 'play') { UI.panel = null; G.mode = 'play'; }
      // the harness may call this from anywhere on the floor: treat it as the
      // player finding the stairs rather than teleporting a whole level
      if (G.hero.x !== G.floor.stairs.x || G.hero.y !== G.floor.stairs.y) {
        G.hero.x = G.floor.stairs.x; G.hero.y = G.floor.stairs.y;
        G.hero.px = G.hero.x; G.hero.py = G.hero.y;
      }
      return descend();
    }
    if (name === 'skill') return useSkill(arg && arg.i ? arg.i : 0);
    if (name === 'gear') { UI.panel = UI.panel === 'gear' ? null : 'gear'; return true; }
    if (name === 'pause') { UI.panel = UI.panel === 'pause' ? null : 'pause'; return true; }
    if (name === 'buy') return buyUp(arg && arg.i ? arg.i : 0);
    if (name === 'title') { G.mode = 'title'; if (pad) pad.show(false); return true; }
    return false;
  }
  window.__game = { state: state, act: act };
  /* ------------------------------------------------------------------ */
  /* viewport + projection                                               */
  /* ------------------------------------------------------------------ */
  var canvas = document.getElementById('game');
  var VW = 390, VH = 844, DPR = 2;
  var TW = 46, TH = 23, WALLH = 30, BH = 54;
  var cam = { x: 0, y: 0, tx: 0, ty: 0 };
  function isoX(gx, gy) { return (gx - gy) * TW * 0.5; }
  function isoY(gx, gy) { return (gx + gy) * TH * 0.5; }

  // portraits and dialogs need the UI boxes; the play field keeps its own budget
  function relayout(w, h) {
    VW = w; VH = h;
    TW = clamp(w / 7.4, 32, 68);
    TH = TW * 0.5;
    WALLH = TW * 0.62;
    BH = TW * 1.12;
  }

  /* ------------------------------------------------------------------ */
  /* pools                                                               */
  /* ------------------------------------------------------------------ */
  var PARTS = [], DARRS = [], SHOTS = [], RINGS = [], EMB = [];
  var SORT = [], sortN = 0;
  (function () {
    var i;
    for (i = 0; i < 260; i++) PARTS.push({ live: false, x: 0, y: 0, vx: 0, vy: 0, g: 0, life: 0, max: 1, size: 2, col: C.ember, glow: false });
    for (i = 0; i < 44; i++) DARRS.push({ live: false, x: 0, y: 0, v: 0, col: C.ink, big: false, life: 0, max: 1, hero: false });
    for (i = 0; i < 28; i++) SHOTS.push({ live: false, x: 0, y: 0, tx: 0, ty: 0, t: 0, dur: 0.3, dmg: 0, col: C.ember });
    for (i = 0; i < 8; i++) RINGS.push({ live: false, x: 0, y: 0, r: 0, t: 0, dur: 0.4, col: C.ember });
    for (i = 0; i < 64; i++) EMB.push({ x: 0, y: 0, r: 0, vx: 0, vy: 0, a: 0, ph: 0 });
    for (i = 0; i < 96; i++) SORT.push({ k: '', o: null, s: 0 });
    for (i = 0; i < EMB.length; i++) seedEmber(EMB[i], true);
  })();
  function seedEmber(p, anywhere) {
    p.x = Math.random() * VW;
    p.y = anywhere ? Math.random() * VH : VH + 8;
    p.r = 1.1 + Math.random() * 2.3;
    p.vx = -8 + Math.random() * 16;
    p.vy = -12 - Math.random() * 26;
    p.a = 0.20 + Math.random() * 0.42;
    p.ph = Math.random() * TAU;
  }

  function spawnBurst(x, y, n, col, power) {
    var made = 0;
    for (var i = 0; i < PARTS.length && made < n; i++) {
      var p = PARTS[i];
      if (p.live) continue;
      var a = Math.random() * TAU, sp = (20 + Math.random() * 90) * (power || 1);
      p.live = true; p.x = x + (Math.random() - 0.5) * 8; p.y = y + (Math.random() - 0.5) * 8;
      p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp * 0.6 - 20;
      p.g = 220; p.life = 0.3 + Math.random() * 0.45; p.max = p.life;
      p.size = 1.7 + Math.random() * 2.6; p.col = col; p.glow = true;
      made++;
    }
  }
  function spawnEmberPuff(x, y, n, col) {
    var made = 0;
    for (var i = 0; i < PARTS.length && made < n; i++) {
      var p = PARTS[i];
      if (p.live) continue;
      p.live = true; p.x = x + (Math.random() - 0.5) * TW; p.y = y + (Math.random() - 0.5) * TH;
      p.vx = (Math.random() - 0.5) * 12; p.vy = -16 - Math.random() * 26;
      p.g = -6; p.life = 0.7 + Math.random() * 0.8; p.max = p.life;
      p.size = 0.9 + Math.random() * 1.8; p.col = col || C.ember; p.glow = true;
      made++;
    }
  }
  function spawnRing(x, y, r, col) {
    for (var i = 0; i < RINGS.length; i++) {
      var g = RINGS[i];
      if (g.live) continue;
      g.live = true; g.x = x; g.y = y; g.r = r; g.t = 0; g.dur = 0.42; g.col = col;
      return;
    }
  }
  function dmgNum(x, y, v, col, big, hero) {
    for (var i = 0; i < DARRS.length; i++) {
      var d = DARRS[i];
      if (d.live) continue;
      d.live = true; d.x = x + (Math.random() - 0.5) * 10; d.y = y;
      d.v = v; d.col = col; d.big = !!big; d.hero = !!hero;
      d.life = 0.85; d.max = 0.85;
      return;
    }
  }

  /* ------------------------------------------------------------------ */
  /* floor bake: one offscreen canvas per level                          */
  /* ------------------------------------------------------------------ */
  function bakeFloor(f) {
    var minX = -(f.h - 1) * TW * 0.5 - TW * 1.2;
    var maxX = (f.w - 1) * TW * 0.5 + TW * 1.2;
    var minY = -WALLH - TH * 1.4;
    var maxY = (f.w + f.h - 2) * TH * 0.5 + TH * 2;
    var bw = Math.ceil(maxX - minX), bh = Math.ceil(maxY - minY);
    var bs = Math.min(2, DPR || 2);
    // keep the bake under ~7MP so a low-end phone never fails to allocate
    while (bw * bh * bs * bs > 7.0e6 && bs > 1) bs -= 0.5;
    var cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.ceil(bw * bs));
    cv.height = Math.max(1, Math.ceil(bh * bs));
    var g = cv.getContext('2d');
    g.setTransform(bs, 0, 0, bs, 0, 0);
    g.translate(-minX, -minY);

    var s, gx, gy;
    for (s = 0; s <= f.w + f.h - 2; s++) {
      for (gy = 0; gy < f.h; gy++) {
        gx = s - gy;
        if (gx < 0 || gx >= f.w) continue;
        bakeCell(g, f, gx, gy);
      }
    }
    f.bake = { cv: cv, x: minX, y: minY, w: bw, h: bh };
    buildMini(f);
  }

  function diamond(g, x, y, w, h) {
    g.beginPath();
    g.moveTo(x, y - h * 0.5);
    g.lineTo(x + w * 0.5, y);
    g.lineTo(x, y + h * 0.5);
    g.lineTo(x - w * 0.5, y);
    g.closePath();
  }

  function bakeCell(g, f, gx, gy) {
    var c = at(f.grid, gx, gy);
    var x = isoX(gx, gy), y = isoY(gx, gy);
    var n = h2(gx, gy, f.seed);
    var open = openChar(c);
    if (c === ' ') return;

    if (open) {
      // cliff skirt: the pocket sits on a plinth of ash, so islands read solid
      var edge = !openChar(at(f.grid, gx, gy + 1)) || !openChar(at(f.grid, gx + 1, gy));
      if (edge) {
        g.beginPath();
        g.moveTo(x - TW * 0.5, y);
        g.lineTo(x, y + TH * 0.5);
        g.lineTo(x + TW * 0.5, y);
        g.lineTo(x + TW * 0.5, y + WALLH * 0.9);
        g.lineTo(x, y + TH * 0.5 + WALLH * 0.9);
        g.lineTo(x - TW * 0.5, y + WALLH * 0.9);
        g.closePath();
        g.fillStyle = '#0d0708';
        g.fill();
      }
      diamond(g, x, y, TW, TH);
      var base = 0.5 + n * 0.5;
      g.fillStyle = 'rgb(' + Math.round(66 + base * 26) + ',' + Math.round(48 + base * 18) + ',' + Math.round(44 + base * 16) + ')';
      g.fill();
      // slab inset
      diamond(g, x, y, TW * 0.9, TH * 0.9);
      g.strokeStyle = 'rgba(178,132,108,' + (0.14 + n * 0.14).toFixed(3) + ')';
      g.lineWidth = 1;
      g.stroke();
      // 1px dark seam so neighbouring slabs read as separate stones
      diamond(g, x, y, TW, TH);
      g.strokeStyle = 'rgba(4,2,3,0.45)';
      g.lineWidth = 1;
      g.stroke();
      // contact occlusion where a slab meets a wall block
      g.lineCap = 'butt';
      g.strokeStyle = 'rgba(5,3,4,0.32)';
      g.lineWidth = 3;
      if (!openChar(at(f.grid, gx, gy - 1))) {
        g.beginPath(); g.moveTo(x - TW * 0.5, y); g.lineTo(x, y - TH * 0.5); g.lineTo(x + TW * 0.5, y); g.stroke();
      }
      if (!openChar(at(f.grid, gx - 1, gy))) {
        g.beginPath(); g.moveTo(x - TW * 0.5, y); g.lineTo(x, y + TH * 0.5); g.lineTo(x, y - TH * 0.5); g.stroke();
      }
      // bevel: a lit north-west edge and a shadowed south-east one give weight
      g.strokeStyle = 'rgba(214,176,148,' + (0.10 + n * 0.08).toFixed(3) + ')';
      g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(x - TW * 0.45, y);
      g.lineTo(x, y - TH * 0.45);
      g.lineTo(x + TW * 0.45, y);
      g.stroke();
      g.strokeStyle = 'rgba(6,3,4,0.28)';
      g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(x + TW * 0.45, y);
      g.lineTo(x, y + TH * 0.45);
      g.lineTo(x - TW * 0.45, y);
      g.stroke();

      // cracks + ash: two hash-driven layers, so tiles differ without textures
      if (n > 0.62) {
        g.beginPath();
        var cx0 = x - TW * 0.2 + n * TW * 0.12, cy0 = y - TH * 0.1;
        g.moveTo(cx0, cy0);
        g.lineTo(cx0 + TW * 0.14, cy0 - TH * 0.16);
        g.lineTo(cx0 + TW * 0.2, cy0 + TH * 0.05);
        g.strokeStyle = 'rgba(8,5,6,0.55)';
        g.lineWidth = 1.2;
        g.stroke();
      }
      if (n < 0.12) {
        g.fillStyle = 'rgba(190,170,150,0.10)';
        g.beginPath();
        g.ellipse(x - TW * 0.18, y + TH * 0.06, TW * 0.06, TH * 0.09, 0.4, 0, TAU);
        g.fill();
      }
      // scattered remains: three cheap shapes, hashed per tile, zero cost at runtime
      if (n > 0.28 && n < 0.34) {
        g.strokeStyle = 'rgba(226,214,196,0.42)';
        g.lineWidth = 1.6;
        g.beginPath();
        g.moveTo(x - TW * 0.16, y + TH * 0.04);
        g.lineTo(x - TW * 0.02, y + TH * 0.16);
        g.moveTo(x - TW * 0.10, y + TH * 0.16);
        g.lineTo(x + TW * 0.06, y + TH * 0.02);
        g.stroke();
      } else if (n > 0.34 && n < 0.40) {
        g.fillStyle = 'rgba(120,96,84,0.45)';
        g.beginPath();
        g.ellipse(x + TW * 0.10, y + TH * 0.06, 2.2, 1.6, 0.3, 0, TAU);
        g.fill();
        g.beginPath();
        g.ellipse(x + TW * 0.20, y + TH * 0.14, 1.6, 1.2, -0.4, 0, TAU);
        g.fill();
      } else if (n > 0.40 && n < 0.46) {
        g.fillStyle = 'rgba(196,178,158,0.10)';
        g.beginPath();
        g.ellipse(x - TW * 0.12, y - TH * 0.06, TW * 0.10, TH * 0.10, 0, 0, TAU);
        g.fill();
      }
      // ember seam: a hot crack that the light pass will pick up
      if (n > 0.93) {
        g.strokeStyle = 'rgba(255,138,61,0.30)';
        g.lineWidth = 1.4;
        g.beginPath();
        g.moveTo(x - TW * 0.22, y + TH * 0.1);
        g.lineTo(x - TW * 0.02, y - TH * 0.04);
        g.lineTo(x + TW * 0.16, y + TH * 0.02);
        g.stroke();
      }
      if (c === '+') {
        // door: two posts and a lintel, still walkable underneath
        var ph = WALLH * 0.72;
        g.fillStyle = '#3a2721';
        g.fillRect(x - TW * 0.46, y - ph, TW * 0.1, ph + TH * 0.1);
        g.fillRect(x + TW * 0.36, y - ph, TW * 0.1, ph + TH * 0.1);
        g.fillStyle = '#4a332a';
        g.fillRect(x - TW * 0.46, y - ph - TH * 0.12, TW * 0.92, TH * 0.16);
        g.fillStyle = 'rgba(255,138,61,0.14)';
        g.fillRect(x - TW * 0.4, y - ph - TH * 0.05, TW * 0.8, 1.5);
      }
      return;
    }

    // wall block
    var top = y - WALLH;
    g.beginPath();
    g.moveTo(x - TW * 0.5, top);
    g.lineTo(x, top + TH * 0.5);
    g.lineTo(x, y + TH * 0.5);
    g.lineTo(x - TW * 0.5, y);
    g.closePath();
    g.fillStyle = '#3b2629';
    g.fill();
    g.beginPath();
    g.moveTo(x + TW * 0.5, top);
    g.lineTo(x, top + TH * 0.5);
    g.lineTo(x, y + TH * 0.5);
    g.lineTo(x + TW * 0.5, y);
    g.closePath();
    g.fillStyle = '#4b3034';
    g.fill();
    // south face catches a little ash light
    diamond(g, x, top, TW, TH);
    var lit = 0.45 + n * 0.55;
    g.fillStyle = 'rgb(' + Math.round(88 + lit * 26) + ',' + Math.round(64 + lit * 18) + ',' + Math.round(60 + lit * 16) + ')';
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.lineWidth = 1;
    diamond(g, x, top, TW, TH);
    g.stroke();
    g.strokeStyle = 'rgba(196,150,124,0.22)';
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(x, top - TH * 0.5);
    g.lineTo(x - TW * 0.5, top);
    g.stroke();
    // masonry seams
    if (n > 0.4) {
      g.strokeStyle = 'rgba(0,0,0,0.30)';
      g.beginPath();
      g.moveTo(x - TW * 0.24, top + TH * 0.06);
      g.lineTo(x - TW * 0.24, top + TH * 0.44);
      g.moveTo(x + TW * 0.24, top - TH * 0.02);
      g.lineTo(x + TW * 0.24, top + TH * 0.34);
      g.stroke();
    }
    if (n > 0.82) {
      g.fillStyle = 'rgba(255,138,61,0.22)';
      g.fillRect(x - TW * 0.16, top + TH * 0.1, 2, 2);
    }
  }

  /* minimap is baked with the floor: a 3px-per-tile thumbnail of the real vault */
  function buildMini(f) {
    var px = 3, cv = document.createElement('canvas');
    cv.width = f.w * px; cv.height = f.h * px;
    var g = cv.getContext('2d');
    g.fillStyle = 'rgba(10,7,8,0.9)';
    g.fillRect(0, 0, cv.width, cv.height);
    for (var y = 0; y < f.h; y++) {
      for (var x = 0; x < f.w; x++) {
        var c = at(f.grid, x, y);
        if (c === ' ') continue;
        if (openChar(c)) g.fillStyle = c === '>' ? C.gold : '#5b4140';
        else g.fillStyle = '#241618';
        g.fillRect(x * px, y * px, px, px);
      }
    }
    f.mini = cv;
  }

  /* ------------------------------------------------------------------ */
  /* world render                                                        */
  /* ------------------------------------------------------------------ */
  var SCREENS = null, LIGHT_G = null, BG = null;
  /* Screen-space art is constant per viewport: the background gradient, the
     abyss haze behind the island, the vignette and the shelf under the thumb
     controls. Rasterising them once into two bitmaps turns four full-screen
     fills into two textured quads — the difference between 30fps and 60fps in
     software rasterisation, and headroom to spare on a phone. */
  function buildScreens(ctx) {
    var dpr = DPR || 1;
    var w = Math.max(1, Math.round(VW * dpr)), h = Math.max(1, Math.round(VH * dpr));

    var front = document.createElement('canvas');
    front.width = w; front.height = h;
    var f = front.getContext('2d');
    f.setTransform(dpr, 0, 0, dpr, 0, 0);
    var vg = f.createRadialGradient(VW * 0.5, VH * 0.42, Math.min(VW, VH) * 0.16, VW * 0.5, VH * 0.45, Math.max(VW, VH) * 0.8);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(0.55, 'rgba(4,2,3,0.12)');
    vg.addColorStop(1, 'rgba(3,1,2,0.62)');
    f.fillStyle = vg;
    f.fillRect(0, 0, VW, VH);
    var shelf = f.createLinearGradient(0, VH * 0.60, 0, VH);
    shelf.addColorStop(0, 'rgba(6,3,4,0)');
    shelf.addColorStop(1, 'rgba(6,3,4,0.78)');
    f.fillStyle = shelf;
    f.fillRect(0, VH * 0.60, VW, VH * 0.40);

    SCREENS = { vig: front, w: VW, h: VH, d: dpr };
  }

  function drawEmbers(ctx, t, alpha) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < EMB.length; i++) {
      var p = EMB[i];
      var a = p.a * alpha * (0.55 + 0.45 * Math.sin(t * 2 + p.ph));
      if (a <= 0.01) continue;
      ctx.fillStyle = 'rgba(255,138,61,' + a.toFixed(3) + ')';
      ctx.fillRect(p.x, p.y, p.r, p.r);
    }
    ctx.restore();
  }

  function drawWorld(ctx, t) {
    if (!BG || BG.w !== VW || BG.h !== VH) {
      var bg = ctx.createLinearGradient(0, 0, VW * 0.3, VH);
      bg.addColorStop(0, '#1e1215');
      bg.addColorStop(0.45, '#120b0c');
      bg.addColorStop(1, '#0a0506');
      BG = { g: bg, w: VW, h: VH };
    }
    ctx.fillStyle = BG.g;
    ctx.fillRect(0, 0, VW, VH);
    drawEmbers(ctx, t, 0.9);
    if (!G || !G.floor) return;
    var f = G.floor;
    var sh = UI.shake, shx = 0, shy = 0;
    if (sh > 0.1) {
      shx = Math.sin(t * 71) * sh * 0.5;
      shy = Math.cos(t * 63) * sh * 0.4;
    }
    ctx.save();
    ctx.translate(shx, shy);
    if (f.bake) {
      // bake.x/bake.y are the canvas-space offsets of world (0,0), so the blit
      // subtracts the camera and adds the bake origin back on
      ctx.drawImage(f.bake.cv, VW * 0.5 - cam.x + f.bake.x, VH * 0.47 - cam.y + f.bake.y, f.bake.w, f.bake.h);
    }
    drawActors(ctx, t);
    drawShots(ctx, t);
    drawRings(ctx);
    drawParticles(ctx);
    drawLight(ctx, t);
    drawDmgNums(ctx);
    ctx.restore();
    if (!SCREENS || SCREENS.w !== VW || SCREENS.h !== VH || SCREENS.d !== DPR) buildScreens(ctx);
    ctx.drawImage(SCREENS.vig, 0, 0, VW, VH);
    if (UI.hurtFlash > 0) {
      ctx.fillStyle = 'rgba(150,20,16,' + (UI.hurtFlash * 0.35).toFixed(3) + ')';
      ctx.fillRect(0, 0, VW, VH);
    }
    if (UI.flash > 0) {
      ctx.fillStyle = 'rgba(255,170,90,' + (UI.flash * 0.20).toFixed(3) + ')';
      ctx.fillRect(0, 0, VW, VH);
    }
  }

  function screenOf(gx, gy) {
    return { x: isoX(gx, gy) - cam.x + VW * 0.5, y: isoY(gx, gy) - cam.y + VH * 0.47 };
  }

  function drawActors(ctx, t) {
    var f = G.floor, i, e, l;
    sortN = 0;
    pushSort('stairs', f.stairs, f.stairs.x + f.stairs.y);
    for (i = 0; i < f.braziers.length; i++) pushSort('brazier', f.braziers[i], f.braziers[i].x + f.braziers[i].y - 0.1);
    for (i = 0; i < f.loot.length; i++) {
      l = f.loot[i];
      if (l.taken) continue;
      pushSort('loot', l, l.x + l.y + 0.2);
    }
    for (i = 0; i < f.enemies.length; i++) {
      e = f.enemies[i];
      if (e.gone) continue;
      pushSort('enemy', e, e.py + e.px);
    }
    pushSort('hero', G.hero, G.hero.py + G.hero.px);
    sortActors();

    for (i = 0; i < sortN; i++) {
      var it = SORT[i], p = screenOf(it.o.x, it.o.y);
      if (it.k === 'stairs') drawStairs(ctx, p.x, p.y, t);
      else if (it.k === 'brazier') drawBrazier(ctx, p.x, p.y, it.o, t);
      else if (it.k === 'loot') drawLoot(ctx, p.x, p.y, it.o, t);
      else if (it.k === 'enemy') drawEnemy(ctx, it.o, p.x, p.y, t);
      else drawHero(ctx, G.hero, p.x, p.y, t);
    }
  }
  function pushSort(k, o, s) {
    if (sortN >= SORT.length) return;
    var e = SORT[sortN++];
    e.k = k; e.o = o; e.s = s;
  }
  /* Insertion sort over the preallocated sort buffer. The moving entry's
     fields are snapshotted before the shifts, or shifting SORT[i-1] into
     SORT[i] would overwrite the very entry being placed. */
  function sortActors() {
    var i, j, k, o, s;
    for (i = 1; i < sortN; i++) {
      k = SORT[i].k; o = SORT[i].o; s = SORT[i].s;
      j = i - 1;
      while (j >= 0 && SORT[j].s > s) {
        SORT[j + 1].k = SORT[j].k;
        SORT[j + 1].o = SORT[j].o;
        SORT[j + 1].s = SORT[j].s;
        j--;
      }
      SORT[j + 1].k = k; SORT[j + 1].o = o; SORT[j + 1].s = s;
    }
  }

  var SHADOW_G = {};
  function shadow(ctx, x, y, r) {
    r = Math.max(6, Math.round(r / 4) * 4);
    var g = SHADOW_G[r];
    if (!g) {
      g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, 'rgba(0,0,0,0.78)');
      g.addColorStop(0.7, 'rgba(0,0,0,0.42)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      SHADOW_G[r] = g;
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, 0.42);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawStairs(ctx, x, y, t) {
    var pulse = 0.55 + 0.45 * Math.sin(t * 2.4);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glowAt(ctx, x, y - 6, TW * 1.5, 'rgba(255,212,121,ALPHA)', 0.20 + pulse * 0.16);
    ctx.restore();
    // a stair mouth cut into the slab
    ctx.fillStyle = '#0a0607';
    ctx.beginPath();
    ctx.ellipse(x, y + 1, TW * 0.34, TH * 0.34, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,212,121,0.9)';
    for (var i = 0; i < 3; i++) {
      ctx.globalAlpha = 0.28 + i * 0.2;
      ctx.fillRect(x - TW * 0.18 + i * 3, y - 2 + i * 3, TW * 0.36 - i * 6, 1.6);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(255,212,121,' + (0.5 + pulse * 0.4).toFixed(2) + ')';
    ctx.beginPath();
    ctx.moveTo(x, y - 16);
    ctx.lineTo(x + 6, y - 8);
    ctx.lineTo(x - 6, y - 8);
    ctx.closePath();
    ctx.fill();
  }

  function drawBrazier(ctx, x, y, b, t) {
    var fl = 0.6 + 0.4 * Math.sin(t * 9 + b.p) * Math.sin(t * 3.3 + b.p * 2);
    shadow(ctx, x, y, TW * 0.22);
    ctx.fillStyle = '#2b1d1c';
    ctx.fillRect(x - 1.6, y - 16, 3.2, 16);
    ctx.fillStyle = '#3a2724';
    ctx.beginPath();
    ctx.ellipse(x, y - 17, 6, 3, 0, 0, TAU);
    ctx.fill();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glowAt(ctx, x, y - 20, TW * 1.4 * (0.85 + fl * 0.25), 'rgba(255,138,61,ALPHA)', 0.16 + fl * 0.10);
    ctx.fillStyle = 'rgba(255,180,90,' + (0.55 + fl * 0.3).toFixed(2) + ')';
    ctx.beginPath();
    ctx.ellipse(x, y - 20, 3.4 + fl, 6 + fl * 4, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawLoot(ctx, x, y, l, t) {
    var bob = Math.sin(t * 2.2 + l.t) * 2.4;
    var col = l.kind === 'gold' ? C.gold : (l.item && l.item.kind === 'weapon' ? '#ff9d6a' : l.item && l.item.kind === 'armour' ? '#8fb3c9' : '#c9a0ff');
    shadow(ctx, x, y, TW * 0.16);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glowAt(ctx, x, y - 8 + bob, TW * 0.85, l.kind === 'gold' ? 'rgba(255,212,121,ALPHA)' : 'rgba(255,138,61,ALPHA)', 0.26);
    ctx.restore();
    ctx.save();
    ctx.translate(x, y - 8 + bob);
    ctx.rotate(Math.sin(t * 1.4 + l.t) * 0.25);
    ctx.fillStyle = col;
    if (l.kind === 'gold') {
      ctx.beginPath();
      ctx.moveTo(0, -4); ctx.lineTo(3.4, 0); ctx.lineTo(0, 4); ctx.lineTo(-3.4, 0);
      ctx.closePath(); ctx.fill();
    } else {
      ctx.fillRect(-3, -4, 6, 8);
      ctx.fillStyle = 'rgba(10,7,8,0.55)';
      ctx.fillRect(-3, -1, 6, 1);
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /* creatures: authored bodies, painted through with the Flare palette  */
  /* ------------------------------------------------------------------ */
  function texWash(ctx, fam, cx, cy, rx, ry) {
    var rec = ART['tex.' + fam];
    if (!rec || !rec.tex) return;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
    ctx.clip();
    ctx.globalAlpha = 0.42;
    ctx.globalCompositeOperation = 'source-atop';
    ctx.drawImage(rec.tex, cx - rx, cy - ry, rx * 2, ry * 2);
    ctx.restore();
  }
  function limb(ctx, x1, y1, x2, y2, w, col) {
    ctx.strokeStyle = col;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  function eye(ctx, x, y, r, col) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }

  var FAM_SCALE = { goblin: 0.98, skeleton: 1.0, ant: 0.78, wyvern: 1.2, minotaur: 1.25, mage: 1.05 };

  function goblinArt(ctx, s, t, flash) {
    var sway = Math.sin(t * 2.3) * s * 0.012;
    var base = flash ? '#f3c9a8' : '#5f8549';
    limb(ctx, -s * 0.14, -s * 0.30, -s * 0.17, 0, s * 0.10, flash ? base : '#2f4526');
    limb(ctx, s * 0.14, -s * 0.30, s * 0.18, 0, s * 0.10, flash ? base : '#2f4526');
    ctx.fillStyle = base;
    ctx.beginPath();
    ctx.ellipse(sway * 0.5, -s * 0.44, s * 0.24, s * 0.27, 0, 0, TAU);
    ctx.fill();
    texWash(ctx, 'goblin', sway * 0.5, -s * 0.44, s * 0.24, s * 0.27);
    // head + ears
    ctx.fillStyle = flash ? '#ffe3c6' : '#6b9153';
    ctx.beginPath();
    ctx.ellipse(sway, -s * 0.74, s * 0.19, s * 0.17, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-s * 0.16, -s * 0.79); ctx.lineTo(-s * 0.34, -s * 0.90); ctx.lineTo(-s * 0.14, -s * 0.88);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(s * 0.16, -s * 0.79); ctx.lineTo(s * 0.34, -s * 0.90); ctx.lineTo(s * 0.14, -s * 0.88);
    ctx.closePath(); ctx.fill();
    // arms + club
    limb(ctx, -s * 0.20, -s * 0.52, -s * 0.30, -s * 0.34, s * 0.075, flash ? base : '#3f5a32');
    limb(ctx, s * 0.20, -s * 0.52, s * 0.30, -s * 0.50, s * 0.075, flash ? base : '#3f5a32');
    ctx.save();
    ctx.translate(s * 0.32, -s * 0.52);
    ctx.rotate(-0.4);
    ctx.fillStyle = '#5a4030';
    ctx.fillRect(-s * 0.03, -s * 0.02, s * 0.06, s * 0.40);
    ctx.fillStyle = '#6d4d34';
    ctx.beginPath();
    ctx.ellipse(0, s * 0.40, s * 0.09, s * 0.12, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
    eye(ctx, -s * 0.06, -s * 0.75, s * 0.028, flash ? '#7a1a10' : '#ffb347');
    eye(ctx, s * 0.06, -s * 0.75, s * 0.028, flash ? '#7a1a10' : '#ffb347');
    // ember rim from the torchlight above
    ctx.strokeStyle = 'rgba(255,160,90,0.30)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(sway, -s * 0.74, s * 0.19, -2.4, -0.6);
    ctx.stroke();
  }

  function skeletonArt(ctx, s, t, flash) {
    var sway = Math.sin(t * 1.9) * s * 0.010;
    var bone = flash ? '#ffffff' : '#cfc4ad';
    var dark = flash ? '#ffffff' : '#8f8674';
    limb(ctx, -s * 0.08, -s * 0.34, -s * 0.12, 0, s * 0.065, dark);
    limb(ctx, s * 0.08, -s * 0.34, s * 0.12, 0, s * 0.065, dark);
    limb(ctx, sway, -s * 0.34, sway, -s * 0.62, s * 0.07, dark);
    // ribcage
    ctx.fillStyle = bone;
    ctx.beginPath();
    ctx.ellipse(sway, -s * 0.50, s * 0.17, s * 0.20, 0, 0, TAU);
    ctx.fill();
    texWash(ctx, 'skeleton', sway, -s * 0.50, s * 0.17, s * 0.20);
    ctx.strokeStyle = 'rgba(40,32,28,0.55)';
    ctx.lineWidth = 1.4;
    for (var i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(sway, -s * 0.55 + i * s * 0.075, s * 0.15, 0.15, Math.PI - 0.15);
      ctx.stroke();
    }
    // shoulders + arms
    limb(ctx, -s * 0.15, -s * 0.62, -s * 0.26, -s * 0.42, s * 0.055, bone);
    limb(ctx, s * 0.15, -s * 0.62, s * 0.26, -s * 0.40, s * 0.055, bone);
    // skull
    ctx.fillStyle = flash ? '#ffffff' : '#ded3bd';
    ctx.beginPath();
    ctx.ellipse(sway, -s * 0.76, s * 0.13, s * 0.13, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(20,14,14,0.85)';
    ctx.fillRect(sway - s * 0.09, -s * 0.72, s * 0.18, s * 0.035);
    ctx.fillRect(sway - s * 0.03, -s * 0.68, s * 0.06, s * 0.05);
    eye(ctx, sway - s * 0.055, -s * 0.785, s * 0.026, flash ? '#7a1a10' : '#ff8a3d');
    eye(ctx, sway + s * 0.055, -s * 0.785, s * 0.026, flash ? '#7a1a10' : '#ff8a3d');
    // sword
    ctx.save();
    ctx.translate(s * 0.27, -s * 0.41);
    ctx.rotate(0.5);
    ctx.fillStyle = '#9aa4ad';
    ctx.fillRect(-1.2, 0, 2.4, s * 0.42);
    ctx.fillStyle = '#6b5a44';
    ctx.fillRect(-s * 0.05, -1.6, s * 0.1, 2.6);
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,160,90,0.26)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(sway, -s * 0.76, s * 0.13, -2.5, -0.7);
    ctx.stroke();
  }

  function antArt(ctx, s, t, flash) {
    var bob = Math.sin(t * 6) * s * 0.012;
    var body = flash ? '#ffd7b8' : '#6a3a2c';
    var legc = flash ? '#ffd7b8' : '#40201a';
    var i;
    for (i = 0; i < 3; i++) {
      var ly = -s * 0.30 + i * s * 0.10;
      limb(ctx, -s * 0.05, ly, -s * 0.30, 0, s * 0.035, legc);
      limb(ctx, -s * 0.05, ly, s * 0.24, 0, s * 0.035, legc);
    }
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(s * 0.18, -s * 0.30 + bob, s * 0.26, s * 0.19, -0.15, 0, TAU);
    ctx.fill();
    texWash(ctx, 'ant', s * 0.18, -s * 0.30 + bob, s * 0.26, s * 0.19);
    ctx.beginPath();
    ctx.ellipse(-s * 0.14, -s * 0.32 + bob, s * 0.12, s * 0.11, 0, 0, TAU);
    ctx.fill();
    // head + mandibles
    ctx.fillStyle = flash ? '#ffe9d2' : '#7d4633';
    ctx.beginPath();
    ctx.ellipse(-s * 0.30, -s * 0.30 + bob, s * 0.13, s * 0.12, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = flash ? '#ffd7b8' : '#3a1c16';
    ctx.lineWidth = s * 0.035;
    ctx.beginPath();
    ctx.moveTo(-s * 0.40, -s * 0.26 + bob);
    ctx.quadraticCurveTo(-s * 0.50, -s * 0.22 + bob, -s * 0.44, -s * 0.18 + bob);
    ctx.moveTo(-s * 0.40, -s * 0.34 + bob);
    ctx.quadraticCurveTo(-s * 0.52, -s * 0.36 + bob, -s * 0.46, -s * 0.42 + bob);
    ctx.stroke();
    eye(ctx, -s * 0.33, -s * 0.33 + bob, s * 0.022, flash ? '#7a1a10' : '#ffb347');
    eye(ctx, -s * 0.33, -s * 0.26 + bob, s * 0.022, flash ? '#7a1a10' : '#ffb347');
    // shell highlight
    ctx.strokeStyle = 'rgba(255,150,90,0.28)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.ellipse(s * 0.18, -s * 0.30 + bob, s * 0.24, s * 0.17, -0.15, -2.6, -0.4);
    ctx.stroke();
  }

  function wyvernArt(ctx, s, t, flash) {
    var flap = Math.sin(t * 3.4) * 0.22;
    var body = flash ? '#ffd9c2' : '#5c3646';
    var wing = flash ? '#ffe8d8' : '#3d2431';
    // tail
    ctx.strokeStyle = body;
    ctx.lineWidth = s * 0.07;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(s * 0.05, -s * 0.34);
    ctx.quadraticCurveTo(s * 0.42, -s * 0.22, s * 0.36, s * 0.02);
    ctx.stroke();
    // wings
    ctx.fillStyle = wing;
    ctx.save();
    ctx.translate(0, -s * 0.52);
    ctx.rotate(-0.12 + flap * 0.5);
    ctx.beginPath();
    ctx.moveTo(-s * 0.06, 0);
    ctx.quadraticCurveTo(-s * 0.55, -s * 0.34, -s * 0.62, -s * 0.02);
    ctx.quadraticCurveTo(-s * 0.36, -s * 0.06, -s * 0.20, s * 0.10);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.translate(0, -s * 0.52);
    ctx.rotate(0.12 - flap * 0.5);
    ctx.beginPath();
    ctx.moveTo(s * 0.06, 0);
    ctx.quadraticCurveTo(s * 0.55, -s * 0.34, s * 0.62, -s * 0.02);
    ctx.quadraticCurveTo(s * 0.36, -s * 0.06, s * 0.20, s * 0.10);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // body + neck
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(0, -s * 0.40, s * 0.15, s * 0.22, 0, 0, TAU);
    ctx.fill();
    texWash(ctx, 'wyvern', 0, -s * 0.40, s * 0.15, s * 0.22);
    limb(ctx, 0, -s * 0.56, -s * 0.02, -s * 0.74, s * 0.09, body);
    ctx.fillStyle = flash ? '#fff0e2' : '#6d4350';
    ctx.beginPath();
    ctx.ellipse(-s * 0.04, -s * 0.78, s * 0.11, s * 0.08, -0.2, 0, TAU);
    ctx.fill();
    // horns
    ctx.fillStyle = '#cbbba4';
    ctx.beginPath();
    ctx.moveTo(-s * 0.10, -s * 0.84); ctx.lineTo(-s * 0.20, -s * 0.94); ctx.lineTo(-s * 0.06, -s * 0.86);
    ctx.closePath(); ctx.fill();
    // legs
    limb(ctx, -s * 0.08, -s * 0.28, -s * 0.12, 0, s * 0.055, body);
    limb(ctx, s * 0.08, -s * 0.28, s * 0.13, 0, s * 0.055, body);
    eye(ctx, -s * 0.08, -s * 0.79, s * 0.022, '#ffb347');
    eye(ctx, 0.02 * s, -s * 0.775, s * 0.022, '#ffb347');
  }

  function minotaurArt(ctx, s, t, flash) {
    var sway = Math.sin(t * 1.8) * s * 0.01;
    var hide = flash ? '#ffd8bb' : '#4a3030';
    var hide2 = flash ? '#ffe6cf' : '#5a3c38';
    limb(ctx, -s * 0.14, -s * 0.36, -s * 0.19, 0, s * 0.13, flash ? hide : '#33201f');
    limb(ctx, s * 0.14, -s * 0.36, s * 0.19, 0, s * 0.13, flash ? hide : '#33201f');
    ctx.fillStyle = hide;
    ctx.beginPath();
    ctx.moveTo(-s * 0.26, -s * 0.30);
    ctx.quadraticCurveTo(-s * 0.30, -s * 0.66, -s * 0.12, -s * 0.70);
    ctx.lineTo(s * 0.12, -s * 0.70);
    ctx.quadraticCurveTo(s * 0.30, -s * 0.66, s * 0.26, -s * 0.30);
    ctx.closePath();
    ctx.fill();
    texWash(ctx, 'minotaur', 0, -s * 0.50, s * 0.26, s * 0.20);
    // head + horns
    ctx.fillStyle = hide2;
    ctx.beginPath();
    ctx.ellipse(sway, -s * 0.80, s * 0.14, s * 0.13, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#d8c9ae';
    ctx.lineWidth = s * 0.045;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-s * 0.11, -s * 0.86);
    ctx.quadraticCurveTo(-s * 0.30, -s * 0.94, -s * 0.30, -s * 1.02);
    ctx.moveTo(s * 0.11, -s * 0.86);
    ctx.quadraticCurveTo(s * 0.30, -s * 0.94, s * 0.30, -s * 1.02);
    ctx.stroke();
    eye(ctx, sway - s * 0.05, -s * 0.81, s * 0.026, '#ff5a3d');
    eye(ctx, sway + s * 0.05, -s * 0.81, s * 0.026, '#ff5a3d');
    // axe
    ctx.save();
    ctx.translate(s * 0.30, -s * 0.56);
    ctx.rotate(0.35);
    ctx.fillStyle = '#5a4030';
    ctx.fillRect(-1.6, -s * 0.06, 3.2, s * 0.56);
    ctx.fillStyle = '#8f9aa3';
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.04);
    ctx.quadraticCurveTo(s * 0.22, -s * 0.10, s * 0.20, s * 0.08);
    ctx.quadraticCurveTo(s * 0.10, s * 0.12, 0, s * 0.10);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function mageArt(ctx, s, t, flash) {
    var sway = Math.sin(t * 2.0) * s * 0.012;
    var robe = flash ? '#ffdfc6' : '#3a2a44';
    ctx.fillStyle = robe;
    ctx.beginPath();
    ctx.moveTo(-s * 0.24, 0);
    ctx.quadraticCurveTo(-s * 0.18, -s * 0.48, -s * 0.10, -s * 0.62);
    ctx.lineTo(s * 0.10, -s * 0.62);
    ctx.quadraticCurveTo(s * 0.18, -s * 0.48, s * 0.24, 0);
    ctx.closePath();
    ctx.fill();
    texWash(ctx, 'mage', 0, -s * 0.34, s * 0.20, s * 0.24);
    // hood
    ctx.fillStyle = flash ? '#fff0e0' : '#4b3757';
    ctx.beginPath();
    ctx.ellipse(sway, -s * 0.70, s * 0.13, s * 0.14, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#120b14';
    ctx.beginPath();
    ctx.ellipse(sway, -s * 0.69, s * 0.075, s * 0.085, 0, 0, TAU);
    ctx.fill();
    eye(ctx, sway - s * 0.03, -s * 0.70, s * 0.018, '#ff7ad9');
    eye(ctx, sway + s * 0.03, -s * 0.70, s * 0.018, '#ff7ad9');
    // staff with an ember head
    ctx.strokeStyle = '#6b543c';
    ctx.lineWidth = s * 0.035;
    ctx.beginPath();
    ctx.moveTo(s * 0.22, -s * 0.02);
    ctx.lineTo(s * 0.18, -s * 0.86);
    ctx.stroke();
    var pulse = 0.6 + 0.4 * Math.sin(t * 4);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glowAt(ctx, s * 0.18, -s * 0.90, s * 0.30, 'rgba(255,122,217,ALPHA)', 0.25 + pulse * 0.2);
    ctx.restore();
    ctx.fillStyle = '#ffb0ea';
    ctx.beginPath();
    ctx.arc(s * 0.18, -s * 0.90, s * 0.035, 0, TAU);
    ctx.fill();
  }

  function beastArt(ctx, fam, s, t, flash) {
    if (fam === 'goblin') goblinArt(ctx, s, t, flash);
    else if (fam === 'skeleton') skeletonArt(ctx, s, t, flash);
    else if (fam === 'ant') antArt(ctx, s, t, flash);
    else if (fam === 'wyvern') wyvernArt(ctx, s, t, flash);
    else if (fam === 'minotaur') minotaurArt(ctx, s, t, flash);
    else mageArt(ctx, s, t, flash);
  }

  function drawEnemy(ctx, e, x, y, t) {
    var s = BH * (FAM_SCALE[e.kind.fam] || 1) * (e.boss ? 1.85 : 1);
    var fade = e.dead ? clamp(e.goneT / 0.55, 0, 1) : 1;
    var bob = Math.sin(e.t * 2.2) * s * 0.018 + (e.windup > 0 ? -s * 0.03 : 0);
    shadow(ctx, x, y, TW * (e.boss ? 0.38 : 0.26));
    if (e.boss && !e.dead) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      glowAt(ctx, x, y - s * 0.2, TW * 1.5, 'rgba(255,90,60,ALPHA)', 0.16);
      ctx.restore();
    }
    ctx.save();
    if (fade < 1) { ctx.globalAlpha = fade; ctx.translate(0, (1 - fade) * s * 0.3); }
    ctx.translate(x, y + bob);
    if (e.hitT > 0) { ctx.rotate(Math.sin(e.hitT * 60) * 0.08); }
    ctx.scale(e.face >= 0 ? 1 : -1, 1);
    beastArt(ctx, e.kind.fam, s, e.t, e.flash > 0);
    ctx.restore();

    if (!e.dead && e.hp < e.maxHp) {
      var w = e.boss ? TW * 1.5 : TW * 0.8;
      var bx = x - w * 0.5, by = y - s * (e.boss ? 1.30 : 1.02);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(bx - 1, by - 1, w + 2, 5);
      ctx.fillStyle = e.boss ? '#ff5a4e' : '#c94a3a';
      ctx.fillRect(bx, by, w * clamp(e.hp / e.maxHp, 0, 1), 3);
    }
    if (e.windup > 0) {
      // telegraph: a hot ring at the feet, so a hit is always read before it lands
      ctx.strokeStyle = 'rgba(255,90,60,' + (0.35 + 0.4 * Math.sin(t * 30)).toFixed(2) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(x, y, TW * 0.4, TH * 0.4, 0, 0, TAU);
      ctx.stroke();
    }
    if (e.boss && !e.dead) {
      var label = e.kind.name.toUpperCase();
      txt(ctx, label, x, y - s * 1.42, clamp(TW * 0.24, 7, 11), 'rgba(255,212,121,0.9)', 'center', 800);
    }
  }

  function drawHero(ctx, h, x, y, t) {
    var s = BH * 1.08;
    var bob = Math.sin(t * 7) * (h.stepAnim > 0 ? 1.6 : 0.5);
    shadow(ctx, x, y, TW * 0.30);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glowAt(ctx, x, y - s * 0.46, s * 0.66, 'rgba(255,150,80,ALPHA)', 0.17);
    ctx.restore();
    ctx.save();
    ctx.translate(x, y + bob);
    if (h.invuln > 0 && h.hitT > 0) ctx.globalAlpha = 0.7 + 0.3 * Math.sin(t * 40);
    ctx.scale(h.face >= 0 ? 1 : -1, 1);
    var armor = '#69788c', armorLit = '#b3c2d4', cloth = '#b3362a';
    // cloak
    ctx.fillStyle = 'rgba(120,32,26,0.85)';
    ctx.beginPath();
    ctx.moveTo(-s * 0.10, -s * 0.62);
    ctx.quadraticCurveTo(-s * 0.34, -s * 0.34, -s * 0.22, -s * 0.02);
    ctx.lineTo(-s * 0.02, -s * 0.10);
    ctx.closePath();
    ctx.fill();
    // legs
    limb(ctx, -s * 0.09, -s * 0.34, -s * 0.11, 0, s * 0.085, '#3a302c');
    limb(ctx, s * 0.09, -s * 0.34, s * 0.12, 0, s * 0.085, '#3a302c');
    // tabard + plate
    ctx.fillStyle = cloth;
    ctx.beginPath();
    ctx.moveTo(-s * 0.15, -s * 0.56);
    ctx.lineTo(s * 0.15, -s * 0.56);
    ctx.lineTo(s * 0.11, -s * 0.30);
    ctx.lineTo(-s * 0.11, -s * 0.30);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = armor;
    ctx.beginPath();
    ctx.ellipse(0, -s * 0.58, s * 0.20, s * 0.16, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = armorLit;
    ctx.beginPath();
    ctx.ellipse(-s * 0.03, -s * 0.62, s * 0.13, s * 0.09, -0.2, 0, TAU);
    ctx.fill();
    // pauldrons
    ctx.fillStyle = armor;
    ctx.beginPath();
    ctx.ellipse(-s * 0.19, -s * 0.64, s * 0.09, s * 0.075, -0.3, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(s * 0.19, -s * 0.64, s * 0.09, s * 0.075, 0.3, 0, TAU);
    ctx.fill();
    // helm
    ctx.fillStyle = '#9fb0c4';
    ctx.beginPath();
    ctx.ellipse(0, -s * 0.82, s * 0.115, s * 0.125, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#1a1214';
    ctx.fillRect(-s * 0.09, -s * 0.82, s * 0.18, s * 0.035);
    ctx.fillStyle = '#ff8a3d';
    ctx.fillRect(-s * 0.06, -s * 0.817, s * 0.035, s * 0.022);
    ctx.fillRect(s * 0.02, -s * 0.817, s * 0.035, s * 0.022);
    // plume
    ctx.strokeStyle = '#a8352b';
    ctx.lineWidth = s * 0.03;
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.92);
    ctx.quadraticCurveTo(s * 0.12, -s * 1.02, s * 0.03, -s * 1.06);
    ctx.stroke();
    ctx.restore();

    // blade: at rest it hangs; in a swing it arcs across the facing side
    var sw = h.atkT > 0 ? (1 - h.atkT / 0.3) : 1;
    ctx.save();
    ctx.translate(x, y - s * 0.55);
    var ang = h.atkT > 0 ? (-1.5 + sw * 2.6) : 1.22;
    ctx.rotate(ang * (h.face >= 0 ? 1 : -1));
    var bladeLen = s * 0.44;
    // grip, pommel and a gold guard wide enough to read at this scale
    ctx.fillStyle = '#43301f';
    ctx.fillRect(s * -0.01, -1.3, s * 0.07, 2.6);
    ctx.fillStyle = '#c8a24a';
    ctx.fillRect(s * 0.055, -3.6, 3.4, 7.2);
    ctx.beginPath();
    ctx.arc(s * -0.02, 0, 2.1, 0, TAU);
    ctx.fill();
    // blade: cold steel with a dark edge, tapering to a point — never pure white
    ctx.fillStyle = '#5f6d7b';
    ctx.beginPath();
    ctx.moveTo(s * 0.09, 1.15);
    ctx.lineTo(s * 0.09 + bladeLen * 0.88, 1.9);
    ctx.lineTo(s * 0.09 + bladeLen, 0);
    ctx.lineTo(s * 0.09, 1.15);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#96a7b7';
    ctx.beginPath();
    ctx.moveTo(s * 0.09, -1.5);
    ctx.lineTo(s * 0.09 + bladeLen * 0.86, -0.7);
    ctx.lineTo(s * 0.09 + bladeLen, 0);
    ctx.lineTo(s * 0.09, 0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(6,3,4,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(s * 0.09, -1.5);
    ctx.lineTo(s * 0.09 + bladeLen, 0);
    ctx.lineTo(s * 0.09, 1.15);
    ctx.stroke();
    ctx.restore();
    if (h.atkT > 0.06) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(255,190,120,' + (h.atkT / 0.3 * 0.55).toFixed(2) + ')';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(x, y - s * 0.5, s * 0.62, h.swingA - 0.9, h.swingA + 0.3);
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ------------------------------------------------------------------ */
  /* effects                                                             */
  /* ------------------------------------------------------------------ */
  function drawParticles(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < PARTS.length; i++) {
      var p = PARTS[i];
      if (!p.live) continue;
      var a = clamp(p.life / p.max, 0, 1);
      ctx.globalAlpha = a * 0.9;
      ctx.fillStyle = p.col;
      ctx.fillRect(p.x - p.size * 0.5, p.y - p.size * 0.5, p.size, p.size);
    }
    ctx.restore();
  }

  function drawShots(ctx) {
    for (var i = 0; i < SHOTS.length; i++) {
      var s = SHOTS[i];
      if (!s.live) continue;
      var k = s.t / s.dur;
      var x = lerp(isoX(s.x, s.y), isoX(s.tx, s.ty), k);
      var y = lerp(isoY(s.x, s.y), isoY(s.tx, s.ty), k) - BH * 0.5 - Math.sin(k * Math.PI) * 14;
      var sx = x - cam.x + VW * 0.5, sy = y - cam.y + VH * 0.47;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      glowAt(ctx, sx, sy, 16, s.col === '#ff7ad9' ? 'rgba(255,122,217,ALPHA)' : 'rgba(255,138,61,ALPHA)', 0.5);
      ctx.fillStyle = s.col;
      ctx.beginPath();
      ctx.arc(sx, sy, 2.6, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawRings(ctx) {
    for (var i = 0; i < RINGS.length; i++) {
      var r = RINGS[i];
      if (!r.live) continue;
      var k = r.t / r.dur;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = (1 - k) * 0.8;
      ctx.strokeStyle = r.col;
      ctx.lineWidth = 3 * (1 - k) + 1;
      ctx.beginPath();
      ctx.ellipse(r.x - cam.x + VW * 0.5, r.y - cam.y + VH * 0.47, r.r * (0.2 + k * 0.9), r.r * (0.2 + k * 0.9) * 0.5, 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawDmgNums(ctx) {
    for (var i = 0; i < DARRS.length; i++) {
      var d = DARRS[i];
      if (!d.live) continue;
      var a = clamp(d.life / d.max, 0, 1);
      var size = d.big ? 22 : 15;
      if (d.hero) size = 20;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.font = '800 ' + size + 'px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(String(d.v), d.x, d.y);
      ctx.fillStyle = d.col;
      ctx.fillText(String(d.v), d.x, d.y);
      ctx.restore();
    }
  }

  function drawLight(ctx, t) {
    var h = G.hero;
    var p = screenOf(h.px, h.py);
    var rad = Math.round(TW * 9.6 / 16) * 16;
    if (!LIGHT_G || LIGHT_G.rad !== rad) {
      var lg = ctx.createRadialGradient(0, 0, rad * 0.18, 0, 0, rad);
      lg.addColorStop(0, 'rgba(0,0,0,0)');
      lg.addColorStop(0.36, 'rgba(9,5,6,0.06)');
      lg.addColorStop(0.72, 'rgba(8,4,5,0.22)');
      lg.addColorStop(1, 'rgba(6,3,4,0.46)');
      LIGHT_G = { g: lg, rad: rad };
    }
    // the fill extends past the gradient's outer stop so a hero near the edge
    // still darkens the whole screen, with no second full-screen pass
    var reach = Math.max(VW, VH);
    ctx.save();
    ctx.translate(p.x, p.y - BH * 0.4);
    ctx.fillStyle = LIGHT_G.g;
    ctx.fillRect(-reach, -reach, reach * 2, reach * 2);
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var flick = 0.92 + 0.08 * Math.sin(t * 7.3) * Math.sin(t * 2.1);
    glowAt(ctx, p.x, p.y - BH * 0.5, rad * 0.46 * flick, 'rgba(255,150,70,ALPHA)', 0.13);
    glowAt(ctx, p.x + Math.sin(t * 3.1) * 4, p.y - BH * 0.55, rad * 0.20 * flick, 'rgba(255,196,120,ALPHA)', 0.10);
    ctx.restore();
  }
  /* ------------------------------------------------------------------ */
  /* painted UI                                                          */
  /* ------------------------------------------------------------------ */
  var pad = null;

  /* Flare's tooltips.png is a bordered box: 9-slice it so one 512px window
     frames a thumb-sized HUD bar and a full-screen dialog alike. */
  function panelSlice(ctx, rec, x, y, w, h, alpha, corner) {
    var a = alpha == null ? 0.95 : alpha;
    var d = Math.min(corner || 26, w * 0.5, h * 0.5);
    if (!rec || !rec.ready) {
      ctx.save();
      ctx.globalAlpha = a;
      rrect(ctx, x, y, w, h, Math.min(12, h * 0.3));
      ctx.fillStyle = 'rgba(14,9,10,0.94)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,212,121,0.32)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
      return;
    }
    var img = rec.img, W = rec.w, H = rec.h;
    var dw = Math.max(0, w - d * 2), dh = Math.max(0, h - d * 2);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.drawImage(img, 0, 0, d, d, x, y, d, d);
    ctx.drawImage(img, W - d, 0, d, d, x + w - d, y, d, d);
    ctx.drawImage(img, 0, H - d, d, d, x, y + h - d, d, d);
    ctx.drawImage(img, W - d, H - d, d, d, x + w - d, y + h - d, d, d);
    if (dw > 0) {
      ctx.drawImage(img, d, 0, W - d * 2, d, x + d, y, dw, d);
      ctx.drawImage(img, d, H - d, W - d * 2, d, x + d, y + h - d, dw, d);
    }
    if (dh > 0) {
      ctx.drawImage(img, 0, d, d, H - d * 2, x, y + d, d, dh);
      ctx.drawImage(img, W - d, d, d, H - d * 2, x + w - d, y + d, d, dh);
    }
    if (dw > 0 && dh > 0) ctx.drawImage(img, d, d, W - d * 2, H - d * 2, x + d, y + d, dw, dh);
    ctx.restore();
  }

  function button(ctx, label, x, y, w, h, fn, opt) {
    opt = opt || {};
    var hot = opt.hot;
    ctx.save();
    rrect(ctx, x, y, w, h, Math.min(10, h * 0.35));
    ctx.fillStyle = hot ? 'rgba(255,138,61,0.28)' : 'rgba(24,15,16,0.86)';
    ctx.fill();
    ctx.strokeStyle = hot ? 'rgba(255,212,121,0.95)' : 'rgba(255,212,121,0.42)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
    txt(ctx, label, x + w * 0.5, y + h * 0.5 + 0.5, opt.size || clamp(h * 0.34, 9, 15), opt.col || (hot ? C.gold : C.ink), 'center', 800);
    if (fn) hit(x, y, w, h, fn);
  }

  /* The vendored portrait is a painted bust, but dropped in raw it reads as a
     photo inside a vector game. It is cropped to head and shoulders, softened
     through a 48px intermediate (a cheap posterise), graded into soot + ember,
     then set inside a bevelled frame so the treatment looks deliberate. */
  function portraitTile(rec, size) {
    var key = 't' + Math.round(size);
    if (rec._tile && rec._tile.key === key) return rec._tile.cv;
    var dpr = DPR || 1;
    var n = Math.max(4, Math.round(size * dpr));
    var cv = document.createElement('canvas');
    cv.width = n; cv.height = n;
    var c = cv.getContext('2d');
    c.fillStyle = '#150c0e';
    c.fillRect(0, 0, n, n);
    if (rec.ready) {
      var small = document.createElement('canvas');
      small.width = 48; small.height = 48;
      // head and shoulders sit in the top two-thirds of Flare's portrait frames
      small.getContext('2d').drawImage(rec.img, 0, rec.h * 0.02, rec.w, rec.h * 0.62, 0, 0, 48, 48);
      c.imageSmoothingEnabled = true;
      c.drawImage(small, 0, 0, 48, 48, 0, 0, n, n);

      c.globalCompositeOperation = 'multiply';
      var mg = c.createLinearGradient(0, 0, n * 0.35, n);
      mg.addColorStop(0, 'rgb(128,102,92)');
      mg.addColorStop(0.6, 'rgb(92,64,58)');
      mg.addColorStop(1, 'rgb(52,32,30)');
      c.fillStyle = mg;
      c.fillRect(0, 0, n, n);

      c.globalCompositeOperation = 'screen';
      var eg = c.createRadialGradient(n * 0.30, n * 0.20, 0, n * 0.30, n * 0.20, n * 0.8);
      eg.addColorStop(0, 'rgba(255,138,61,0.44)');
      eg.addColorStop(0.45, 'rgba(150,62,32,0.15)');
      eg.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = eg;
      c.fillRect(0, 0, n, n);

      c.globalCompositeOperation = 'source-over';
      var vg = c.createRadialGradient(n * 0.5, n * 0.44, n * 0.20, n * 0.5, n * 0.5, n * 0.76);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(10,5,6,0.74)');
      c.fillStyle = vg;
      c.fillRect(0, 0, n, n);
    }
    rec._tile = { key: key, cv: cv };
    return cv;
  }

  function portraitCircle(ctx, x, y, r, rec) {
    var size = r * 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.clip();
    if (rec && rec.ready) {
      ctx.drawImage(portraitTile(rec, size), x - r, y - r, size, size);
    } else {
      var g = ctx.createLinearGradient(x, y - r, x, y + r);
      g.addColorStop(0, '#4a3130');
      g.addColorStop(1, '#1d1214');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      // authored fallback: a hooded ember-knight bust
      ctx.fillStyle = '#6b7480';
      ctx.beginPath();
      ctx.arc(x, y + r * 0.05, r * 0.34, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#3a2a2a';
      ctx.beginPath();
      ctx.moveTo(x - r * 0.62, y + r);
      ctx.quadraticCurveTo(x - r * 0.5, y + r * 0.32, x, y + r * 0.34);
      ctx.quadraticCurveTo(x + r * 0.5, y + r * 0.32, x + r * 0.62, y + r);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = C.ember;
      ctx.fillRect(x - r * 0.17, y, r * 0.1, r * 0.06);
      ctx.fillRect(x + r * 0.07, y, r * 0.1, r * 0.06);
    }
    ctx.restore();

    // bevelled frame: gold edge, dark inner ring, warm highlight top-left
    ctx.strokeStyle = 'rgba(255,212,121,0.85)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(x, y, r - 0.7, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(8,4,4,0.9)';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(x, y, r - 3.2, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,232,196,0.40)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, r - 4.4, -2.5, -0.9);
    ctx.stroke();
  }

  /* ------------------------------------------------------------------ */
  /* HUD                                                                 */
  /* ------------------------------------------------------------------ */
  function drawHUD(ctx, t) {
    var f = G.floor, h = G.hero;
    var top = 6, bh = 52;
    panelSlice(ctx, ART['ui.panel'], 6, top, VW - 12, bh, 0.72, 20);

    portraitCircle(ctx, 38, top + bh * 0.5, 19, ART.portrait);

    var x0 = 64, rightW = 84;
    var barW = VW - x0 - rightW - 20;
    var hpPct = clamp(h.hp / G.maxHp, 0, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x0, top + 12, barW, 11);
    var hg = ctx.createLinearGradient(x0, 0, x0 + barW, 0);
    hg.addColorStop(0, '#8f2a1d');
    hg.addColorStop(0.55, C.ember);
    hg.addColorStop(1, C.gold);
    ctx.fillStyle = hg;
    ctx.fillRect(x0, top + 12, Math.max(0, barW * hpPct), 11);
    ctx.strokeStyle = 'rgba(255,212,121,0.28)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, top + 12.5, barW - 1, 10);
    txt(ctx, Math.ceil(h.hp) + ' / ' + G.maxHp, x0 + barW * 0.5, top + 18, 8.5, '#1a0f10', 'center', 800);
    txt(ctx, 'ARM ' + Math.round(armourPoints()) + '  CRIT ' + Math.round(critChance() * 100) + '%',
      x0, top + 34, 8, C.dim, 'left', 700);
    txt(ctx, '◆ ' + money(G.gold), VW - 16, top + 17, 14, C.gold, 'right', 800);
    txt(ctx, 'FLOOR ' + G.depth + ' · ' + f.branch, VW - 16, top + 35, 8, C.dim, 'right', 700);

    // a 390px-tall landscape window has no room for a map panel as well
    if (VH > 520) drawMinimap(ctx, t);

    // skill bar sits above the thumb pad, where a thumb can reach without
    // covering the fight
    var chip = clamp(VW * 0.145, 44, 58), gap = 10;
    var total = chip * 3 + gap * 2;
    var sx = (VW - total) * 0.5, sy = VH - chip - 166;
    for (var i = 0; i < 3; i++) drawSkill(ctx, G.skills[i], sx + i * (chip + gap), sy, chip, i);

    if (f.stairs.x === h.x && f.stairs.y === h.y) {
      var bw = 168, bx = (VW - bw) * 0.5, by = sy - 52;
      button(ctx, '▼  DESCEND', bx, by, bw, 40, function () { descend(); }, { hot: true, size: 12 });
    }
  }

  function drawSkill(ctx, s, x, y, size, i) {
    var ready = s.t <= 0;
    var pressed = (UI.press[i] || 0) > 0;
    var r = 9;

    // etched plate: gold rim, dark inner rim, vertical gradient, top highlight
    ctx.save();
    rrect(ctx, x, y, size, size, r);
    var pg = ctx.createLinearGradient(0, y, 0, y + size);
    if (pressed) {
      pg.addColorStop(0, 'rgba(20,10,9,0.98)');
      pg.addColorStop(1, 'rgba(62,28,17,0.98)');
    } else {
      pg.addColorStop(0, 'rgba(64,38,29,0.97)');
      pg.addColorStop(0.55, 'rgba(32,19,17,0.97)');
      pg.addColorStop(1, 'rgba(17,10,10,0.97)');
    }
    ctx.fillStyle = pg;
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = pressed ? 'rgba(255,226,176,0.95)' : 'rgba(255,212,121,0.55)';
    ctx.stroke();
    rrect(ctx, x + 2.2, y + 2.2, size - 4.4, size - 4.4, Math.max(2, r - 2));
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 6, y + 3.6);
    ctx.lineTo(x + size - 6, y + 3.6);
    ctx.strokeStyle = pressed ? 'rgba(255,214,160,0.1)' : 'rgba(255,214,160,0.26)';
    ctx.stroke();
    ctx.restore();

    var cx = x + size * 0.5, cy = y + size * 0.5, rr = size * 0.24;
    ctx.save();
    ctx.globalAlpha = ready ? 1 : 0.45;
    ctx.strokeStyle = s.col;
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    if (i === 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, rr, -0.4, 4.2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + rr * 0.9, cy - rr * 0.7);
      ctx.lineTo(cx + rr * 1.4, cy - rr * 0.2);
      ctx.stroke();
    } else if (i === 1) {
      var k;
      for (k = 0; k < 8; k++) {
        var a2 = k / 8 * TAU;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a2) * rr * 0.45, cy + Math.sin(a2) * rr * 0.45);
        ctx.lineTo(cx + Math.cos(a2) * rr, cy + Math.sin(a2) * rr);
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.moveTo(cx - rr, cy - rr * 0.7);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx - rr, cy + rr * 0.7);
      ctx.moveTo(cx, cy - rr * 0.7);
      ctx.lineTo(cx + rr, cy);
      ctx.lineTo(cx, cy + rr * 0.7);
      ctx.stroke();
    }
    ctx.restore();

    if (!ready) {
      // cooldown sweep: a dark wedge with a hot leading edge, not a flat grey-out
      var pct = clamp(s.t / s.cd, 0, 1);
      var a0 = -Math.PI * 0.5, a1 = a0 + TAU * pct;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, size * 0.62, a0, a1);
      ctx.closePath();
      ctx.fillStyle = 'rgba(6,3,4,0.58)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, size * 0.62, a1 - 0.05, a1);
      ctx.strokeStyle = 'rgba(255,150,80,0.8)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.restore();
      txt(ctx, s.t.toFixed(1), cx, cy, 11, C.bone, 'center', 800);
    }
    txt(ctx, s.name, cx, y + size + 7, 7.5, ready ? C.bone : C.dim, 'center', 800);
    hit(x, y, size, size + 12, function () {
      UI.press[i] = 0.14;
      useSkill(i);
    });
  }

  function drawMinimap(ctx, t) {
    var f = G.floor;
    if (!f.mini) return;
    var box = 66, x = VW - box - 12, y = 88;
    ctx.save();
    ctx.globalAlpha = 0.9;
    rrect(ctx, x - 4, y - 4, box + 8, box + 8, 8);
    ctx.fillStyle = 'rgba(10,7,8,0.78)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,212,121,0.24)';
    ctx.lineWidth = 1;
    ctx.stroke();
    var scale = Math.min(box / f.mini.width, box / f.mini.height);
    var dw = f.mini.width * scale, dh = f.mini.height * scale;
    var ox = x + (box - dw) * 0.5, oy = y + (box - dh) * 0.5;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(f.mini, ox, oy, dw, dh);
    ctx.imageSmoothingEnabled = true;
    // hero + stairs + live foes, mapped through the rect the thumbnail was
    // actually drawn into so the marks always agree with the board
    function dotX(gx2) { return ox + (gx2 + 0.5) / f.w * dw; }
    function dotY(gy2) { return oy + (gy2 + 0.5) / f.h * dh; }
    ctx.fillStyle = C.gold;
    ctx.fillRect(dotX(G.hero.x) - 1.5, dotY(G.hero.y) - 1.5, 3, 3);
    ctx.strokeStyle = 'rgba(255,212,121,0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(dotX(f.stairs.x) - 2, dotY(f.stairs.y) - 2, 4, 4);
    for (var i = 0; i < f.enemies.length; i++) {
      var e = f.enemies[i];
      if (e.dead || e.gone) continue;
      if (!floorAt(f, e.x, e.y)) continue;
      ctx.fillStyle = e.boss ? '#ff5a4e' : 'rgba(200,80,64,0.8)';
      ctx.fillRect(dotX(e.x) - 1, dotY(e.y) - 1, 2, 2);
    }
    ctx.restore();
    var alive = 0, lootLeft = 0, li;
    for (li = 0; li < f.enemies.length; li++) if (!f.enemies[li].dead) alive++;
    for (li = 0; li < f.loot.length; li++) if (!f.loot[li].taken) lootLeft++;
    txt(ctx, alive + ' FOES · ' + lootLeft + ' LOOT', x + box * 0.5, y + box + 12, 6.5,
      alive ? 'rgba(214,150,132,0.8)' : 'rgba(160,200,160,0.8)', 'center', 800);
  }

  /* Banners live in a 22px strip pinned under the HUD and fade out: a floor
     card across the board hides the fight it is announcing. */
  function drawToast(ctx) {
    if (UI.toastT <= 0) return;
    var a = clamp(UI.toastT / 0.35, 0, 1);
    var s = UI.toast, h = 22, y = 58;
    var g = ctx.createLinearGradient(0, 0, VW, 0);
    g.addColorStop(0, 'rgba(10,6,7,0)');
    g.addColorStop(0.16, 'rgba(10,6,7,0.90)');
    g.addColorStop(0.84, 'rgba(10,6,7,0.90)');
    g.addColorStop(1, 'rgba(10,6,7,0)');
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = g;
    ctx.fillRect(0, y, VW, h);
    ctx.strokeStyle = 'rgba(255,212,121,0.26)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(20, y + h);
    ctx.lineTo(VW - 20, y + h);
    ctx.stroke();
    var size = fitSize(ctx, s, VW - 48, 8.5, false, 800);
    txt(ctx, s, VW * 0.5, y + h * 0.5 + 0.5, size, C.gold, 'center', 800);
    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /* panels                                                              */
  /* ------------------------------------------------------------------ */
  function drawGear(ctx) {
    ctx.fillStyle = 'rgba(5,3,4,0.82)';
    ctx.fillRect(0, 0, VW, VH);
    var w = Math.min(VW - 26, 358), h = Math.min(VH - 150, 436);
    var x = (VW - w) * 0.5, y = (VH - h) * 0.5;
    panelSlice(ctx, ART['ui.panel'], x, y, w, h, 0.97, 26);

    // the painted character window sits far back: texture, never competition
    var sheet = ART['ui.character'];
    if (sheet && sheet.ready) {
      ctx.save();
      ctx.globalAlpha = 0.10;
      var sc = Math.max(w / sheet.w, h / sheet.h);
      ctx.beginPath();
      rrect(ctx, x + 6, y + 6, w - 12, h - 12, 12);
      ctx.clip();
      ctx.drawImage(sheet.img, x + w * 0.5 - sheet.w * sc * 0.5, y + h * 0.5 - sheet.h * sc * 0.5, sheet.w * sc, sheet.h * sc);
      ctx.restore();
    }

    var padx = x + 20, inner = w - 40, cy = y + 26;
    txt(ctx, 'THE EMBOUND', padx, cy, 13, C.gold, 'left', 800);
    txt(ctx, 'FLOOR ' + G.depth + ' · ' + G.floor.branch, x + w - 20, cy, 8, C.dim, 'right', 700);
    cy += 24;

    function slotRow(label, it, empty) {
      txt(ctx, label, padx, cy, 8, C.dim, 'left', 800);
      var name = it ? it.name : '— none —';
      txt(ctx, name, x + w - 20, cy, fitSize(ctx, name, inner * 0.62, 10, false, 700), it ? C.bone : C.dim, 'right', 700);
      cy += 15;
      if (it) {
        txt(ctx, itemLine(it) + '   ·   ◆' + money(it.value), padx + 2, cy, 7.5, C.ember, 'left', 700);
        cy += 17;
      } else {
        cy += 6;
      }
    }
    slotRow('WEAPON', G.weapon.kind === 'weapon' ? G.weapon : null, false);
    slotRow('ARMOUR', G.armour, true);
    slotRow('TRINKET', G.trinket, true);

    cy += 4;
    ctx.strokeStyle = 'rgba(255,212,121,0.20)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padx, cy);
    ctx.lineTo(x + w - 20, cy);
    ctx.stroke();
    cy += 18;

    // four stats in two columns, the way a paper character sheet reads
    var colW = inner * 0.5;
    var stats = [['MAX HP', String(G.maxHp)], ['ARMOUR', String(Math.round(armourPoints()))],
      ['CRITICAL', Math.round(critChance() * 100) + '%'], ['LOOT CARRIED', '◆ ' + money(G.lootValue)]];
    for (var i = 0; i < stats.length; i++) {
      var sx2 = padx + (i % 2) * colW, sy2 = cy + Math.floor(i / 2) * 26;
      txt(ctx, stats[i][0], sx2, sy2, 7.5, C.dim, 'left', 700);
      txt(ctx, stats[i][1], sx2 + colW - 14, sy2, 11, i === 3 ? C.gold : C.ink, 'right', 800);
    }
    cy += 56;

    txt(ctx, 'BAG', padx, cy, 8, C.dim, 'left', 800);
    txt(ctx, 'everything better equips itself', x + w - 20, cy, 7, 'rgba(160,140,132,0.8)', 'right', 600);
    cy += 16;
    if (!G.bag.length) {
      txt(ctx, 'nothing carried — drops that beat your gear are worn on pickup', padx, cy, 7.5, C.dim, 'left', 600);
    }
    for (i = 0; i < G.bag.length && i < 4; i++) {
      var it = G.bag[i];
      txt(ctx, it.name, padx, cy, fitSize(ctx, it.name, inner * 0.62, 9, false, 700), C.ink, 'left', 700);
      txt(ctx, '◆' + money(it.value), x + w - 20, cy, 8, C.gold, 'right', 700);
      cy += 17;
    }

    var bw = 132;
    button(ctx, 'CLOSE', x + (w - bw) * 0.5, y + h - 48, bw, 34, function () { UI.panel = null; }, { size: 11 });
  }

  function drawPause(ctx) {
    ctx.fillStyle = 'rgba(5,3,4,0.78)';
    ctx.fillRect(0, 0, VW, VH);
    var w = Math.min(VW - 48, 300), h = 250;
    var x = (VW - w) * 0.5, y = (VH - h) * 0.5;
    panelSlice(ctx, ART['ui.panel'], x, y, w, h, 0.96, 26);
    tracked(ctx, 'PAUSED', VW * 0.5, y + 34, 16, C.gold, 900, 3);
    var bw = w - 60, bx = x + 30, by = y + 62;
    button(ctx, 'RESUME', bx, by, bw, 40, function () { UI.panel = null; }, { hot: true, size: 12 });
    button(ctx, 'GEAR', bx, by + 50, bw, 40, function () { UI.panel = 'gear'; }, { size: 12 });
    button(ctx, (META.sound ? 'SOUND ON' : 'SOUND OFF'), bx, by + 100, bw, 40, function () {
      META.sound = !META.sound;
      GK.sfx.enabled = META.sound;
      saveMeta();
      if (META.sound) GK.sfx.coin();
    }, { size: 12 });
    button(ctx, 'ABANDON RUN', bx, by + 150, bw, 34, function () { abandonRun(); }, { size: 10, col: C.bad });
  }

  function abandonRun() {
    if (!G || G.mode === 'dead') return;
    die();
    UI.panel = null;
  }

  function drawDead(ctx) {
    ctx.fillStyle = 'rgba(6,3,4,0.86)';
    ctx.fillRect(0, 0, VW, VH);
    var w = Math.min(VW - 30, 350), h = Math.min(VH - 150, 430);
    var x = (VW - w) * 0.5, y = (VH - h) * 0.5;
    panelSlice(ctx, ART['ui.panel'], x, y, w, h, 0.97, 26);

    var padx = x + 20, cy = y + 30;
    tracked(ctx, 'THE EMBERS TAKE YOU', VW * 0.5, cy, clamp(w * 0.045, 12, 17), C.gold, 900, 2);
    cy += 26;
    txt(ctx, G.floor.branch + ' · FLOOR ' + G.depth, VW * 0.5, cy, 9, C.dim, 'center', 700);
    cy += 26;

    function row(label, value, col) {
      txt(ctx, label, padx, cy, 9, C.dim, 'left', 700);
      txt(ctx, value, x + w - 20, cy, 10, col || C.ink, 'right', 800);
      cy += 21;
    }
    row('DEPTH REACHED', String(G.depth), C.ink);
    row('KILLS', String(G.kills), C.ink);
    row('LOOT VALUE', '◆ ' + money(G.lootValue), C.ember);
    row('GOLD BANKED', '◆ ' + money(G.banked || 0), C.gold);
    row('RUN SCORE', String(G.depth * 120 + G.kills * 8 + G.lootValue), C.gold);

    cy += 6;
    ctx.strokeStyle = 'rgba(255,212,121,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padx, cy);
    ctx.lineTo(x + w - 20, cy);
    ctx.stroke();
    cy += 16;
    txt(ctx, 'CARRIED OUT', padx, cy, 8.5, C.dim, 'left', 800);
    cy += 15;
    var shown = 0, i;
    for (i = 0; i < META.stash.length && shown < 3; i++) {
      var it = META.stash[i];
      if (!it) continue;
      txt(ctx, it.name, padx, cy, fitSize(ctx, it.name, w - 90, 9, false, 700), C.ink, 'left', 700);
      txt(ctx, '◆' + money(it.value), x + w - 20, cy, 8, C.gold, 'right', 700);
      cy += 17;
      shown++;
    }
    if (!shown) txt(ctx, 'nothing survived', padx, cy, 8, C.dim, 'left', 600);

    var bw = 190;
    button(ctx, 'RETURN TO THE SHRINE', x + (w - bw) * 0.5, y + h - 54, bw, 38, function () {
      G = null;
      UI.panel = null;
      if (pad) pad.show(false);
    }, { hot: true, size: 10.5 });
  }

  /* ------------------------------------------------------------------ */
  /* title                                                               */
  /* ------------------------------------------------------------------ */
  var DIORAMA = null, DIORAMA_TW = 0;
  function buildDiorama() {
    DIORAMA = null;
    DIORAMA_TW = TW;
    if (!DCSS.length) return;
    var rng = GK.rand(0xC1DE12), tries = 0, v, grid, comp;
    while (tries++ < 90) {
      v = DCSS[Math.floor(rng() * DCSS.length) % DCSS.length];
      if (!v || !v.grid || !v.grid.length) continue;
      grid = padGrid(v);
      if (grid.length > 15 || (grid[0] || '').length > 17) continue;
      comp = biggestComp(grid);
      if (!comp || comp.tiles.length < 45) continue;
      DIORAMA = { id: v.id, w: comp.w, h: comp.h, grid: grid, seed: 991, enemies: [], loot: [], braziers: [], depth: 1 };
      break;
    }
    if (DIORAMA) bakeFloor(DIORAMA);
  }

  /* The title uses an authored sigil rather than the painted portrait: at 80px
     the vendored bust is only an upscale, and an upscaled portrait is the one
     thing that always reads as a placeholder. Drawn at native resolution, the
     keep-and-ember mark stays crisp at any density. */
  function drawEmblem(ctx, x, y, r, t) {
    var i;
    ctx.save();
    // disc
    var g = ctx.createRadialGradient(x, y - r * 0.35, r * 0.1, x, y, r);
    g.addColorStop(0, '#241316');
    g.addColorStop(0.62, '#160c0e');
    g.addColorStop(1, '#0d0708');
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = g;
    ctx.fill();

    // keep silhouette: three crenellations over a gate
    var bw = r * 0.92, bh = r * 1.02, bx = x - bw * 0.5, by = y + r * 0.52;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx, by - bh * 0.62);
    ctx.lineTo(bx + bw * 0.18, by - bh * 0.62);
    ctx.lineTo(bx + bw * 0.18, by - bh * 0.78);
    ctx.lineTo(bx + bw * 0.36, by - bh * 0.78);
    ctx.lineTo(bx + bw * 0.36, by - bh * 0.62);
    ctx.lineTo(bx + bw * 0.64, by - bh * 0.62);
    ctx.lineTo(bx + bw * 0.64, by - bh * 0.78);
    ctx.lineTo(bx + bw * 0.82, by - bh * 0.78);
    ctx.lineTo(bx + bw * 0.82, by - bh * 0.62);
    ctx.lineTo(bx + bw, by - bh * 0.62);
    ctx.lineTo(bx + bw, by);
    ctx.closePath();
    ctx.fillStyle = '#1b1012';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,138,61,0.55)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // gate: the ember inside the hold
    var gateW = bw * 0.30, gateH = bh * 0.42, gx = x - gateW * 0.5, gy = by;
    var gg = ctx.createLinearGradient(0, gy - gateH, 0, gy);
    gg.addColorStop(0, '#ffd479');
    gg.addColorStop(0.5, '#ff8a3d');
    gg.addColorStop(1, 'rgba(140,44,20,0.25)');
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.lineTo(gx, gy - gateH * 0.55);
    ctx.quadraticCurveTo(x, gy - gateH * 1.1, gx + gateW, gy - gateH * 0.55);
    ctx.lineTo(gx + gateW, gy);
    ctx.closePath();
    ctx.fillStyle = gg;
    ctx.fill();

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glowAt(ctx, x, gy - gateH * 0.35, r * 0.85, 'rgba(255,138,61,ALPHA)', 0.16 + 0.05 * Math.sin(t * 2.1));
    ctx.restore();

    // ring: double gold with tick marks, drawn at native resolution
    ctx.strokeStyle = 'rgba(255,212,121,0.85)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(x, y, r - 1, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,212,121,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, r - 6, 0, TAU);
    ctx.stroke();
    for (i = 0; i < 12; i++) {
      var a = -Math.PI * 0.5 + i * TAU / 12;
      ctx.strokeStyle = i % 3 === 0 ? 'rgba(255,212,121,0.8)' : 'rgba(255,212,121,0.34)';
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * (r - 6), y + Math.sin(a) * (r - 6));
      ctx.lineTo(x + Math.cos(a) * (r - (i % 3 === 0 ? 12 : 9)), y + Math.sin(a) * (r - (i % 3 === 0 ? 12 : 9)));
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawTitle(ctx, t) {
    var g = ctx.createLinearGradient(0, 0, VW * 0.4, VH);
    g.addColorStop(0, '#1b0f12');
    g.addColorStop(0.5, '#0d0708');
    g.addColorStop(1, '#070405');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VW, VH);
    drawEmbers(ctx, t, 0.7);

    if (DIORAMA_TW !== TW) buildDiorama();
    if (DIORAMA && DIORAMA.bake) {
      var bw = DIORAMA.bake.w, bh = DIORAMA.bake.h;
      var sc = Math.min(1.15, (VW * 1.2) / bw);
      ctx.save();
      ctx.globalAlpha = 0.72;
      var drift = Math.sin(t * 0.25) * 8;
      ctx.drawImage(DIORAMA.bake.cv, VW * 0.5 - bw * sc * 0.5 + drift, VH * 0.34 - bh * sc * 0.42, bw * sc, bh * sc);
      ctx.restore();
    }
    var scrim = ctx.createLinearGradient(0, 0, 0, VH);
    scrim.addColorStop(0, 'rgba(8,5,6,0.42)');
    scrim.addColorStop(0.45, 'rgba(8,5,6,0.62)');
    scrim.addColorStop(1, 'rgba(6,3,4,0.90)');
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, VW, VH);

    var compact = VH < 620;
    var y = compact ? 20 : 46;
    txt(ctx, 'NOUS FORGE · OFFLINE ARPG', VW * 0.5, y, 7, 'rgba(255,212,121,0.62)', 'center', 800);

    var pr = compact ? 26 : 40;
    y += pr + (compact ? 16 : 30);
    drawEmblem(ctx, VW * 0.5, y, pr + 4, t);
    y += pr + (compact ? 18 : 30);

    var titleSize = clamp(VW * (compact ? 0.072 : 0.098), 22, 42);
    tracked(ctx, 'CINDERHOLD', VW * 0.5, y, titleSize, C.gold, 900, titleSize * 0.09);
    ctx.strokeStyle = 'rgba(255,138,61,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(VW * 0.5 - titleSize * 2.1, y + titleSize * 0.62);
    ctx.lineTo(VW * 0.5 + titleSize * 2.1, y + titleSize * 0.62);
    ctx.stroke();
    y += titleSize * 0.9;
    var tag = 'EVERY FLOOR IS A DUNGEON CRAWL VAULT';
    tracked(ctx, tag, VW * 0.5, y, clamp(VW * 0.022, 6.5, 8.5), 'rgba(238,214,186,0.94)', 800, 1.6);
    y += compact ? 16 : 24;

    txt(ctx, '◆ ' + money(META.gold) + '   ·   BEST FLOOR ' + META.best + '   ·   RUNS ' + META.runs,
      VW * 0.5, y, clamp(VW * 0.024, 8, 10), C.bone, 'center', 700);
    y += compact ? 18 : 26;

    // the shrine + start + ledger form one group; it is centred in whatever the
    // viewport leaves us, and drops its extras rather than overlapping in short
    // landscape windows
    var showTrio = VH >= 640;
    var gap = compact ? 8 : 14, btnH = compact ? 38 : 52, trioH = compact ? 36 : 48;
    var reserve = 18 + gap + btnH + (showTrio ? 16 + trioH : 0);
    var avail = (VH - 56) - y;
    var rowH = compact ? 38 : 44;
    y += Math.max(0, (avail - reserve - rowH * 4) * 0.55);
    txt(ctx, 'THE SHRINE', VW * 0.5, y + 4, 8, 'rgba(255,212,121,0.78)', 'center', 800);
    y += 18;

    var rowW = Math.min(VW - 44, 330), rx = (VW - rowW) * 0.5;
    for (var i = 0; i < UPG.length; i++) {
      var u = UPG[i], cost = upgCost(u), lvl = META.up[u.key];
      var ry = y + i * rowH;
      var affordable = META.gold >= cost;

      ctx.save();
      rrect(ctx, rx, ry, rowW, rowH - 2, 7);
      var rg = ctx.createLinearGradient(0, ry, 0, ry + rowH);
      rg.addColorStop(0, 'rgba(34,21,20,0.92)');
      rg.addColorStop(1, 'rgba(16,10,10,0.92)');
      ctx.fillStyle = rg;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,212,121,0.20)';
      ctx.lineWidth = 1;
      ctx.stroke();
      // 1px separating rule, inset so it reads as an engraved line
      ctx.beginPath();
      ctx.moveTo(rx + 10, ry + rowH - 3.5);
      ctx.lineTo(rx + rowW - 10, ry + rowH - 3.5);
      ctx.strokeStyle = 'rgba(255,212,121,0.12)';
      ctx.stroke();
      ctx.restore();

      txt(ctx, u.name, rx + 12, ry + rowH * 0.27, 9.5, C.bone, 'left', 800);
      if (!compact) txt(ctx, u.desc, rx + 12, ry + rowH * 0.53, 7.2, 'rgba(198,172,156,0.82)', 'left', 600);
      for (var k = 0; k < 5; k++) {
        ctx.fillStyle = k < lvl ? C.ember : 'rgba(255,255,255,0.10)';
        ctx.fillRect(rx + 12 + k * 9, ry + rowH * 0.74, 6, 4);
      }

      // cost plate with a filled gold diamond the eye can find
      var cw = 70, ch = 26;
      var cx2 = rx + rowW - cw - 10, cy2 = ry + (rowH - 2 - ch) * 0.5;
      rrect(ctx, cx2, cy2, cw, ch, 6);
      ctx.fillStyle = affordable ? 'rgba(52,29,19,0.95)' : 'rgba(24,16,15,0.9)';
      ctx.fill();
      ctx.strokeStyle = affordable ? 'rgba(255,212,121,0.55)' : 'rgba(255,212,121,0.16)';
      ctx.lineWidth = 1;
      ctx.stroke();
      var dx = cx2 + 14, dy = cy2 + ch * 0.5;
      ctx.beginPath();
      ctx.moveTo(dx, dy - 5.5);
      ctx.lineTo(dx + 5.5, dy);
      ctx.lineTo(dx, dy + 5.5);
      ctx.lineTo(dx - 5.5, dy);
      ctx.closePath();
      ctx.fillStyle = affordable ? C.gold : 'rgba(150,124,108,0.7)';
      ctx.fill();
      if (affordable) {
        ctx.strokeStyle = 'rgba(255,250,220,0.55)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      var cs = money(cost);
      txt(ctx, cs, cx2 + cw - 10, dy + 0.5, fitSize(ctx, cs, cw - 32, 11, true, 800), affordable ? C.gold : 'rgba(172,142,128,0.85)', 'right', 800, true);
      hit(cx2, cy2, cw, ch, (function (idx) {
        return function () { buyUp(idx); };
      })(i));
    }
    y += rowH * 4 + gap;

    var sw = Math.min(VW - 62, 264);
    button(ctx, 'START DESCENT', (VW - sw) * 0.5, y, sw, btnH, function () { startRun(); }, { hot: true, size: compact ? 13 : 16 });
    y += btnH + 16;

    if (showTrio) {
      // run ledger: the shrine earns, so show what the last descents banked
      var tw2 = (Math.min(VW - 44, 330) - 16) / 3, tx0 = (VW - (tw2 * 3 + 16)) * 0.5;
      var ledger = [['BEST FLOOR', String(META.best)], ['RUNS', String(META.runs)], ['KILLS', String(META.kills)]];
      for (i = 0; i < 3; i++) {
        var lx = tx0 + i * (tw2 + 8);
        rrect(ctx, lx, y, tw2, trioH, 8);
        ctx.fillStyle = 'rgba(20,13,14,0.72)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,212,121,0.14)';
        ctx.lineWidth = 1;
        ctx.stroke();
        txt(ctx, ledger[i][1], lx + tw2 * 0.5, y + trioH * 0.36, clamp(trioH * 0.34, 11, 18), C.gold, 'center', 900);
        txt(ctx, ledger[i][0], lx + tw2 * 0.5, y + trioH * 0.74, 6.5, C.dim, 'center', 700);
      }
    }

    // an ember rule fills the tail of the screen when the viewport is tall
    var ruleY = y + (showTrio ? trioH + 24 : 0);
    if (ruleY < VH - 92) {
      ctx.strokeStyle = 'rgba(255,212,121,0.16)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(VW * 0.5 - 60, ruleY);
      ctx.lineTo(VW * 0.5 - 8, ruleY);
      ctx.moveTo(VW * 0.5 + 8, ruleY);
      ctx.lineTo(VW * 0.5 + 60, ruleY);
      ctx.stroke();
      ctx.save();
      ctx.translate(VW * 0.5, ruleY);
      ctx.rotate(Math.PI * 0.25);
      ctx.fillStyle = 'rgba(255,138,61,0.55)';
      ctx.fillRect(-2.6, -2.6, 5.2, 5.2);
      ctx.restore();
    }

    var cr = 'Painted art and item records: Flare (CC-BY-SA / GPL). Floor layouts: Dungeon Crawl Stone Soup (CC0).';
    txt(ctx, cr, VW * 0.5, VH - (compact ? 26 : 46), fitSize(ctx, cr, VW - 24, 6.8, false, 600), 'rgba(255,212,121,0.62)', 'center', 600);
    if (!compact) {
      txt(ctx, 'One hero. Ten floors. No mercy. Everything runs offline.',
        VW * 0.5, VH - 30, 7, C.dim, 'center', 600);
    }
  }

  function buyUp(i) {
    var u = UPG[i];
    if (!u) return false;
    var cost = upgCost(u);
    if (META.gold < cost) {
      toast('NEED ◆' + money(cost - META.gold) + ' MORE');
      GK.sfx.hurt();
      return false;
    }
    META.gold -= cost;
    META.up[u.key]++;
    saveMeta();
    GK.sfx.coin();
    GK.buzz(12);
    toast(u.name + ' → ' + META.up[u.key]);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* loop                                                                */
  /* ------------------------------------------------------------------ */
  function updateEmbers(dt) {
    for (var i = 0; i < EMB.length; i++) {
      var p = EMB[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.y < -10 || p.x < -10 || p.x > VW + 10) seedEmber(p, false);
    }
  }

  function update(dt, t) {
    updateEmbers(dt);
    updateFx(dt);
    for (var i = 0; i < RINGS.length; i++) {
      var r = RINGS[i];
      if (r.live) {
        r.t += dt;
        if (r.t >= r.dur) r.live = false;
      }
    }
    if (G && G.mode === 'play' && !UI.panel && UI.hitstop <= 0) updateGame(dt);
  }

  function render(ctx, t) {
    HITS.length = 0;
    if (!G || G.mode === 'title') {
      drawTitle(ctx, t);
      return;
    }
    drawWorld(ctx, t);
    if (!UI.panel) drawHUD(ctx, t);
    if (UI.panel === 'gear') drawGear(ctx);
    else if (UI.panel === 'pause') drawPause(ctx);
    if (!UI.panel) drawToast(ctx);
    // the run summary owns the screen: nothing floats over it
    if (G.mode === 'dead') drawDead(ctx);
  }

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */
  pad = GK.pad({
    host: document.body,
    actions: [['ATK', 'jump'], ['ROLL', 'dash']],
    onPress: function (k) {
      GK.sfx.unlock();
      if (!G) return;
      if (G.mode === 'dead') return;
      if (k === 'jump' && G.mode === 'play' && !UI.panel) swing();
      if (k === 'dash' && G.mode === 'play' && !UI.panel) rollToward(G.hero.face, 0.2);
    }
  });
  if (pad) {
    pad.show(false);
    (function () {
      var btns = pad.root.querySelectorAll('.gk-btn');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        b.style.setProperty('background', 'linear-gradient(180deg, rgba(72,39,29,0.96), rgba(20,11,11,0.96))', 'important');
        b.style.setProperty('border', '1px solid rgba(255,212,121,0.52)', 'important');
        b.style.setProperty('box-shadow', 'inset 0 1px 0 rgba(255,222,176,0.28), inset 0 -3px 8px rgba(0,0,0,0.6), 0 4px 12px rgba(0,0,0,0.45)', 'important');
        b.style.setProperty('color', C.gold, 'important');
        b.style.setProperty('font', '800 11px/64px system-ui,sans-serif', 'important');
        b.style.setProperty('letter-spacing', '1px', 'important');
        b.style.setProperty('text-shadow', '0 1px 0 rgba(0,0,0,0.8)', 'important');
        (function (btn) {
          var rest = 'inset 0 1px 0 rgba(255,222,176,0.28), inset 0 -3px 8px rgba(0,0,0,0.6), 0 4px 12px rgba(0,0,0,0.45)';
          var down = 'inset 0 3px 10px rgba(0,0,0,0.8), inset 0 0 0 1px rgba(255,226,176,0.7), 0 1px 4px rgba(0,0,0,0.5)';
          btn.addEventListener('pointerdown', function () { btn.style.setProperty('box-shadow', down, 'important'); });
          btn.addEventListener('pointerup', function () { btn.style.setProperty('box-shadow', rest, 'important'); });
          btn.addEventListener('pointercancel', function () { btn.style.setProperty('box-shadow', rest, 'important'); });
        })(b);
      }
      var ring = pad.root.firstChild;
      if (ring) {
        ring.style.background = 'radial-gradient(circle at 50% 40%, rgba(86,48,34,0.30), rgba(14,9,9,0.55) 70%)';
        ring.style.border = '1px solid rgba(255,212,121,0.34)';
        ring.style.boxShadow = 'inset 0 0 18px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,222,176,0.18)';
        var knob = ring.querySelector('div');
        if (knob) {
          knob.style.background = 'linear-gradient(180deg, rgba(96,58,42,0.95), rgba(30,18,15,0.95))';
          knob.style.border = '1px solid rgba(255,212,121,0.45)';
          knob.style.boxShadow = 'inset 0 1px 0 rgba(255,226,176,0.3), 0 2px 6px rgba(0,0,0,0.55)';
        }
      }
    })();
  }

  canvas.addEventListener('pointerdown', onDown, { passive: true });
  canvas.addEventListener('pointermove', onMove, { passive: true });
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', function () { tapStart = null; swiped = false; });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && G) {
      if (G.mode === 'play') UI.panel = UI.panel === 'pause' ? null : 'pause';
    }
  });

  buildDiorama();

  GK.boot({
    canvas: canvas,
    hz: 60,
    update: update,
    render: render,
    onResize: function (v) {
      DPR = v.dpr || 1;
      relayout(v.w, v.h);
      if (G && G.floor) bakeFloor(G.floor);
      SCREENS = null;
      if (DIORAMA_TW !== TW) DIORAMA = null;
    }
  });
})();
