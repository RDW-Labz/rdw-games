/* Stormforge — rendering. Ground, structures, props, actors, storm, HUD, and the two full-screen
 * phases (drop map and results). Reads only what main.js hands it; never mutates game state. */
(function (g) {
  'use strict';

  var R = {};

  var VENDOR = g.AOMG_VENDOR || null;
  var ASSET = [];
  var ASSET_SET = {};
  (function () {
    var list = (VENDOR && VENDOR.assets) || [];
    for (var i = 0; i < list.length; i++) { ASSET.push(list[i]); ASSET_SET[list[i]] = true; }
  })();

  function assetUrl(p) { return '../../' + p; }
  function hasAsset(p) { return !VENDOR || ASSET_SET[p] === true; }

  var IMG = {};
  var LOADING = 0, LOADED = 0;

  R.sprite = function (path) {
    if (!path) return null;
    var rec = IMG[path];
    if (rec) return rec.ready ? rec.img : null;
    return null;
  };
  R.hasSprite = function (path) { var i = R.sprite(path); return !!i; };
  R.progress = function () { return LOADING ? LOADED / LOADING : 1; };

  R.load = function (paths, onEach) {
    var seen = {};
    var queue = [];
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      if (!p || seen[p] || !hasAsset(p) || IMG[p]) continue;
      seen[p] = true;
      queue.push(p);
    }
    LOADING += queue.length;
    queue.forEach(function (p) {
      var rec = { img: new Image(), ready: false, path: p };
      IMG[p] = rec;
      rec.img.onload = function () {
        rec.ready = true;
        LOADED++;
        if (onEach) onEach(p);
      };
      rec.img.onerror = function () { LOADED++; };
      rec.img.src = assetUrl(p);
    });
  };

  /* ---------------------------------------------------------------- palette */

  var BIOME = [
    { base: '#33512f', alt: '#2c472a', speck: '#3d5c34' },   // 0 grass
    { base: '#4b3f2d', alt: '#453a29', speck: '#574a34' },   // 1 dirt
    { base: '#6a5a41', alt: '#64553d', speck: '#786549' },   // 2 sand
    { base: '#1d3a4c', alt: '#1a3444', speck: '#245066' },   // 3 water
    { base: '#3a3f45', alt: '#353a40', speck: '#454b52' },   // 4 road
    { base: '#413a38', alt: '#3b3533', speck: '#4d4441' }    // 5 rock
  ];

  var patterns = null;
  function buildPatterns(ctx) {
    if (patterns) return patterns;
    patterns = BIOME.map(function (b, bi) {
      var c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      var x = c.getContext('2d');
      x.fillStyle = b.base;
      x.fillRect(0, 0, 64, 64);
      // Deterministic speckle so the same map always looks the same, and the ground never
      // reads as a flat fill at phone zoom.
      var seed = 1337 + bi * 977;
      var rnd = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      for (var i = 0; i < 90; i++) {
        var px = rnd() * 64, py = rnd() * 64, s = 1 + rnd() * 2.2;
        x.fillStyle = rnd() > 0.45 ? b.alt : b.speck;
        x.globalAlpha = 0.35 + rnd() * 0.5;
        x.fillRect(px, py, s, s);
      }
      x.globalAlpha = 1;
      if (bi === 3) {   // water: a couple of long highlight strokes
        x.strokeStyle = 'rgba(140,210,240,.10)';
        x.lineWidth = 1;
        for (var w = 0; w < 5; w++) {
          x.beginPath();
          x.moveTo(0, 6 + w * 13);
          x.bezierCurveTo(20, 3 + w * 13, 44, 9 + w * 13, 64, 5 + w * 13);
          x.stroke();
        }
      }
      if (bi === 4) {   // road: centre dashes
        x.fillStyle = 'rgba(226,232,240,.10)';
        for (var d = 0; d < 3; d++) x.fillRect(4 + d * 24, 30, 14, 3);
      }
      return ctx.createPattern(c, 'repeat');
    });
    return patterns;
  }

  /* ---------------------------------------------------------------- helpers */

  function roundRect(ctx, x, y, w, h, r) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function bar(ctx, x, y, w, h, frac, col, bg) {
    ctx.fillStyle = bg || 'rgba(6,10,16,.72)';
    roundRect(ctx, x, y, w, h, h / 2); ctx.fill();
    if (frac > 0) {
      ctx.fillStyle = col;
      roundRect(ctx, x + 1, y + 1, Math.max(0, (w - 2) * frac), h - 2, (h - 2) / 2); ctx.fill();
    }
  }

  function text(ctx, s, x, y, size, color, align, weight) {
    ctx.font = (weight || 700) + ' ' + size + 'px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  }

  /* ---------------------------------------------------------------- world */

  /* Camera is a plain struct: {x, y, zoom, w, h} in screen pixels. */
  function worldToScreen(cam, wx, wy) {
    var sx = (wx - cam.x) * cam.zoom + cam.w / 2;
    var sy = (wy - cam.y) * cam.zoom + cam.h / 2;
    return { x: sx, y: sy };
  }
  R.worldToScreen = worldToScreen;

  R.drawGround = function (ctx, view, cam, world) {
    var pats = buildPatterns(ctx);
    var cell = world.cell;
    var x0 = cam.x - cam.w / (2 * cam.zoom), x1 = cam.x + cam.w / (2 * cam.zoom);
    var y0 = cam.y - cam.h / (2 * cam.zoom), y1 = cam.y + cam.h / (2 * cam.zoom);
    var gx0 = Math.max(0, Math.floor(x0 / cell)), gx1 = Math.min(world.grid - 1, Math.ceil(x1 / cell));
    var gy0 = Math.max(0, Math.floor(y0 / cell)), gy1 = Math.min(world.grid - 1, Math.ceil(y1 / cell));

    ctx.save();
    ctx.translate(view.w / 2, view.h / 2);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);
    ctx.fillStyle = BIOME[0].base;
    ctx.fillRect(x0 - 20, y0 - 20, x1 - x0 + 40, y1 - y0 + 40);

    for (var gy = gy0; gy <= gy1; gy++) {
      var row = gy * world.grid;
      var runStart = -1, runBiome = -1;
      for (var gx = gx0; gx <= gx1 + 1; gx++) {
        var bi = gx <= gx1 ? world.tiles[row + gx] : -1;
        if (bi !== runBiome) {
          if (runBiome >= 0 && runStart >= 0) {
            ctx.fillStyle = pats[runBiome];
            ctx.fillRect(runStart * cell, gy * cell, (gx - runStart) * cell, cell);
          }
          runBiome = bi; runStart = gx;
        }
      }
    }

    // Hot dust drifting over the roads and sand, so open ground never sits perfectly still.
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#ffd9a0';
    ctx.globalAlpha = 1;
    ctx.restore();
  };

  R.drawStructures = function (ctx, view, cam, world, player) {
    ctx.save();
    ctx.translate(view.w / 2, view.h / 2);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    function paint(list, rect, alpha, tileIt) {
      for (var i = 0; i < list.length; i++) {
        var entry = list[i];
        var isObj = entry && typeof entry === 'object';
        var path = isObj ? (entry.path || entry.src) : entry;
        var img = R.sprite(path);
        if (!img) continue;
        if (isObj && entry.x != null) {
          ctx.drawImage(img, entry.x, entry.y, entry.w, entry.h);
          continue;
        }
        if (!tileIt) {
          // a single ceiling covers the footprint
          ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h);
          continue;
        }
        var tile = Math.max(40, Math.min(rect.w, rect.h) / 3.4);
        var nx = Math.max(1, Math.round(rect.w / tile));
        var ny = Math.max(1, Math.round(rect.h / tile));
        var tw = rect.w / nx, th = rect.h / ny;
        for (var ty = 0; ty < ny; ty++) {
          for (var tx = 0; tx < nx; tx++) {
            ctx.drawImage(img, rect.x + tx * tw, rect.y + ty * th, tw + 0.6, th + 0.6);
          }
        }
      }
    }

    for (var i = 0; i < world.pois.length; i++) {
      var p = world.pois[i];
      if (!p.art) continue;
      var rect = { x: p.x, y: p.y, w: p.w, h: p.h };
      var inside = player && Math.abs(player.x - p.cx) < p.w / 2 && Math.abs(player.y - p.cy) < p.h / 2;
      // Suroi ships a handful of floor variants per building; alternate them so the lot
      // does not read as one texture smeared over 500 px.
      if (p.art.floor && p.art.floor.length) {
        var variants = p.art.floor;
        var tile = Math.max(40, Math.min(p.w, p.h) / 3.4);
        var nx = Math.max(1, Math.round(p.w / tile)), ny = Math.max(1, Math.round(p.h / tile));
        var tw = p.w / nx, th = p.h / ny;
        for (var ty = 0; ty < ny; ty++) {
          for (var tx = 0; tx < nx; tx++) {
            var f = variants[(tx * 2 + ty * 3) % variants.length];
            var fi = R.sprite(typeof f === 'string' ? f : f.path);
            if (!fi) continue;
            ctx.drawImage(fi, p.x + tx * tw, p.y + ty * th, tw + 0.6, th + 0.6);
          }
        }
      }
      if (p.art.wall && p.art.wall.length) paint(p.art.wall, rect, 1, false);
      if (p.art.roof && p.art.roof.length) {
        ctx.globalAlpha = inside ? 0.18 : 0.97;
        paint(p.art.roof, rect, 1, false);
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  };

  R.drawProps = function (ctx, view, cam, world, t) {
    var x0 = cam.x - cam.w / (2 * cam.zoom) - 80, x1 = cam.x + cam.w / (2 * cam.zoom) + 80;
    var y0 = cam.y - cam.h / (2 * cam.zoom) - 80, y1 = cam.y + cam.h / (2 * cam.zoom) + 80;
    var list = [];
    for (var i = 0; i < world.props.length; i++) {
      var p = world.props[i];
      if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
      list.push(p);
    }
    list.sort(function (a, b) { return a.y - b.y; });

    ctx.save();
    ctx.translate(view.w / 2, view.h / 2);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);
    for (var k = 0; k < list.length; k++) {
      var pr = list[k];
      var img = R.sprite(pr.sprite);
      var h = pr.h || pr.r * 2.6;
      // contact shadow: one flattened ellipse under every prop reads as ground contact
      ctx.fillStyle = 'rgba(0,0,0,.30)';
      ctx.beginPath();
      ctx.ellipse(pr.x, pr.y + 2, pr.r * 1.05, pr.r * 0.42, 0, 0, 6.2832);
      ctx.fill();
      if (img) {
        var w = pr.drawW || img.width * (cam.zoom > 1 ? 0.9 : 0.8);
        var dh = pr.drawH || img.height * (cam.zoom > 1 ? 0.9 : 0.8);
        ctx.drawImage(img, pr.x - w / 2, pr.y - dh + pr.r * 0.6, w, dh);
      } else {
        ctx.fillStyle = pr.tint || '#2b3a2a';
        roundRect(ctx, pr.x - pr.r * 0.6, pr.y - pr.r * 1.5, pr.r * 1.2, pr.r * 1.7, pr.r * 0.35);
        ctx.fill();
      }
    }
    ctx.restore();
  };

  /* ---------------------------------------------------------------- actors */

  R.drawActors = function (ctx, view, cam, actors, player, t) {
    ctx.save();
    ctx.translate(view.w / 2, view.h / 2);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    var sorted = actors.filter(function (a) { return a.alive; });
    sorted.sort(function (a, b) { return a.y - b.y; });

    for (var i = 0; i < sorted.length; i++) {
      var a = sorted[i];
      var isMe = a.isPlayer;
      // shadow
      ctx.fillStyle = 'rgba(0,0,0,.34)';
      ctx.beginPath();
      ctx.ellipse(a.x, a.y + 9, 13, 6, 0, 0, 6.2832);
      ctx.fill();

      ctx.save();
      ctx.translate(a.x, a.y);
      // body: boots, torso, pack, helmet — reads at phone zoom without any sprite
      ctx.fillStyle = isMe ? '#2b3f52' : '#33302c';
      roundRect(ctx, -9, -6, 18, 14, 5); ctx.fill();
      ctx.fillStyle = isMe ? '#3f6f8e' : '#4a423b';
      roundRect(ctx, -8, -13, 16, 12, 6); ctx.fill();
      ctx.fillStyle = isMe ? '#8fd4ff' : '#6b6156';
      ctx.beginPath(); ctx.arc(0, -14, 6.2, 0, 6.2832); ctx.fill();
      if (a.hitFlash > 0) {
        ctx.globalAlpha = a.hitFlash * 3;
        ctx.fillStyle = '#ff6b6b';
        ctx.beginPath(); ctx.arc(0, -8, 13, 0, 6.2832); ctx.fill();
        ctx.globalAlpha = 1;
      }
      // gun in hand, rotated to aim
      var inst = a.weapons && a.weapons[a.slot];
      var wimg = inst ? R.sprite(inst.w.world) : null;
      ctx.save();
      ctx.rotate(a.ang);
      ctx.translate(6, -2);
      if (wimg) {
        var gw = 34, gh = gw * (wimg.height / wimg.width);
        ctx.drawImage(wimg, -6, -gh / 2, gw, gh);
      } else {
        ctx.fillStyle = '#20262e';
        ctx.fillRect(-4, -2, 22, 4);
      }
      if (a.muzzle > 0) {
        ctx.globalAlpha = Math.min(1, a.muzzle * 12);
        ctx.fillStyle = '#ffe9b8';
        ctx.beginPath();
        ctx.moveTo(24, 0); ctx.lineTo(34, -5); ctx.lineTo(38, 0); ctx.lineTo(34, 5);
        ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.restore();
      ctx.restore();

      // name plate for bots you can see, and a health pip when hurt
      if (a.hp < 100 || isMe) {
        var w2 = 30;
        var frac = a.hp / 100;
        ctx.fillStyle = 'rgba(4,8,12,.66)';
        ctx.fillRect(a.x - w2 / 2, a.y - 32, w2, 3.4);
        ctx.fillStyle = frac > 0.55 ? '#4ade80' : frac > 0.28 ? '#fbbf24' : '#ef4444';
        ctx.fillRect(a.x - w2 / 2, a.y - 32, w2 * frac, 3.4);
      }
    }
    ctx.restore();
  };

  R.drawBullets = function (ctx, view, cam, bullets) {
    ctx.save();
    ctx.translate(view.w / 2, view.h / 2);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);
    ctx.lineCap = 'round';
    for (var i = 0; i < bullets.length; i++) {
      var b = bullets[i];
      ctx.strokeStyle = b.color;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = b.width;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - Math.cos(b.ang) * 14, b.y - Math.sin(b.ang) * 14);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  };

  R.drawStorm = function (ctx, view, cam, world, storm, t) {
    var s = worldToScreen(cam, storm.cx, storm.cy);
    var r = storm.r * cam.zoom;
    ctx.save();
    // The wall of the storm: a soft gradient band at the ring, and a hard edge on top of it.
    var grad = ctx.createRadialGradient(s.x, s.y, Math.max(0, r - 70), s.x, s.y, r + 14);
    grad.addColorStop(0, 'rgba(120,60,200,0)');
    grad.addColorStop(0.55, 'rgba(126,74,214,.20)');
    grad.addColorStop(0.92, 'rgba(86,196,255,.42)');
    grad.addColorStop(1, 'rgba(160,230,255,.62)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r + 14, 0, 6.2832);
    ctx.arc(s.x, s.y, Math.max(0, r - 70), 0, 6.2832, true);
    ctx.fill();

    ctx.strokeStyle = 'rgba(190,240,255,' + (0.5 + Math.sin(t * 2) * 0.14) + ')';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, 6.2832);
    ctx.stroke();
    ctx.restore();
  };

  /* ---------------------------------------------------------------- HUD */

  R.drawHUD = function (ctx, view, st) {
    var W = view.w, H = view.h;
    var pad = Math.max(12, Math.round(W * 0.035));

    /* top-left: alive counter + storm timer */
    ctx.fillStyle = 'rgba(8,12,18,.62)';
    roundRect(ctx, pad, pad, 148, 46, 10); ctx.fill();
    text(ctx, (st.alive < 10 ? '0' : '') + st.alive, pad + 12, pad + 30, 25, '#e6edf7', 'left', 800);
    text(ctx, 'ALIVE', pad + 56, pad + 25, 9, 'rgba(230,237,247,.55)', 'left', 700);
    var stormLabel = st.storm.phase >= 5 ? 'FINAL' : 'STORM ' + (st.storm.phase + 1);
    text(ctx, stormLabel, pad + 12, pad + 41, 9, '#7fe3ff', 'left', 700);
    text(ctx, st.stormNext >= 0 ? st.stormNext.toFixed(0) + 's' : 'CLOSING', pad + 74, pad + 41, 9,
         st.stormNext >= 0 && st.stormNext < 10 ? '#ef4444' : 'rgba(230,237,247,.66)', 'left', 700);

    /* top-right: minimap */
    var mm = Math.min(112, Math.round(W * 0.26));
    var mx = W - pad - mm, my = pad;
    ctx.fillStyle = 'rgba(8,12,18,.70)';
    roundRect(ctx, mx - 4, my - 4, mm + 8, mm + 8, 8); ctx.fill();
    ctx.save();
    roundRect(ctx, mx, my, mm, mm, 5); ctx.clip();
    ctx.fillStyle = '#22301f'; ctx.fillRect(mx, my, mm, mm);
    var sc = mm / st.world.size;
    for (var i = 0; i < st.world.pois.length; i++) {
      var p = st.world.pois[i];
      ctx.fillStyle = 'rgba(230,237,247,.30)';
      ctx.fillRect(mx + (p.cx - p.w / 2) * sc, my + (p.cy - p.h / 2) * sc,
                   Math.max(2, p.w * sc), Math.max(2, p.h * sc));
    }
    // storm ring
    ctx.strokeStyle = 'rgba(160,230,255,.85)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(mx + st.storm.cx * sc, my + st.storm.cy * sc, st.storm.r * sc, 0, 6.2832);
    ctx.stroke();
    // bots with recent contact, then the player
    ctx.fillStyle = 'rgba(239,68,68,.55)';
    for (var b = 0; b < st.contacts.length; b++) {
      var c = st.contacts[b];
      ctx.fillRect(mx + c.x * sc - 1.2, my + c.y * sc - 1.2, 2.4, 2.4);
    }
    ctx.fillStyle = '#8fd4ff';
    ctx.fillRect(mx + st.hero.x * sc - 1.8, my + st.hero.y * sc - 1.8, 3.6, 3.6);
    ctx.restore();

    /* bottom-left: health and shield */
    var bw = Math.min(230, W * 0.52);
    var by = H - pad - 78;
    bar(ctx, pad, by, bw, 13, st.shield / 100, '#7fe3ff', 'rgba(6,10,16,.72)');
    bar(ctx, pad, by + 17, bw, 15, st.hp / 100,
        st.hp > 55 ? '#4ade80' : st.hp > 28 ? '#fbbf24' : '#ef4444', 'rgba(6,10,16,.72)');
    text(ctx, Math.ceil(st.hp) + ' HP', pad + 6, by + 29, 10, '#0a0d14', 'left', 800);
    text(ctx, Math.ceil(st.shield) + ' SHIELD', pad + 6, by + 11, 9, '#0a1a22', 'left', 800);

    /* bottom-right: weapon card + ammo */
    var cw = 128, ch = 52;
    var cx = W - pad - cw, cy = H - pad - ch;
    var inst = st.weapon;
    ctx.fillStyle = 'rgba(8,12,18,.72)';
    roundRect(ctx, cx, cy, cw, ch, 9); ctx.fill();
    if (inst) {
      ctx.strokeStyle = inst.w.color;
      ctx.lineWidth = 1.6;
      roundRect(ctx, cx, cy, cw, ch, 9); ctx.stroke();
      var ico = R.sprite(inst.w.icon);
      if (ico) {
        var iw = 44, ih = iw * (ico.height / ico.width);
        ctx.drawImage(ico, cx + 8, cy + ch / 2 - ih / 2, iw, ih);
      }
      text(ctx, inst.w.tier, cx + cw - 12, cy + 18, 12, inst.w.color, 'right', 800);
      text(ctx, inst.mag + '/' + inst.w.capacity, cx + cw - 12, cy + ch - 12, 13, '#e6edf7', 'right', 800);
      if (inst.reloading > 0) {
        bar(ctx, cx + 8, cy + ch - 8, cw - 16, 3, 1 - inst.reloading / inst.w.reload, '#ffb64d');
      }
    } else {
      text(ctx, 'UNARMED', cx + cw / 2, cy + ch / 2 + 4, 11, 'rgba(230,237,247,.5)', 'center', 700);
    }
    text(ctx, 'AMMO ' + (st.ammoCount || 0), cx + cw, cy - 8, 9, 'rgba(230,237,247,.6)', 'right', 700);

    /* build resources, sitting above the weapon card */
    var ry = cy - 42;
    var chips = [['CU', st.stock.copper, '#e08a4d'], ['TI', st.stock.titanium, '#9fd6ff'], ['AMMO', st.stock.ammo, '#ffd479']];
    var cxp = cx;
    for (var k = 0; k < chips.length; k++) {
      ctx.fillStyle = 'rgba(8,12,18,.66)';
      roundRect(ctx, cxp, ry, 44, 20, 6); ctx.fill();
      text(ctx, chips[k][0], cxp + 5, ry + 14, 8, chips[k][2], 'left', 800);
      text(ctx, String(chips[k][1] | 0), cxp + 39, ry + 14, 9, '#e6edf7', 'right', 800);
      cxp += 48;
    }

    /* kill feed, under the alive counter */
    var fy = pad + 56;
    for (var f = 0; f < st.feed.length; f++) {
      var e = st.feed[f];
      ctx.globalAlpha = Math.min(1, e.life);
      ctx.fillStyle = 'rgba(8,12,18,.62)';
      roundRect(ctx, pad, fy, Math.min(230, W - pad * 2 - 130), 18, 5); ctx.fill();
      text(ctx, e.a + '  ›  ' + e.v, pad + 7, fy + 13, 9, e.me ? '#ffd479' : 'rgba(230,237,247,.82)', 'left', 700);
      ctx.globalAlpha = 1;
      fy += 21;
    }

    /* build wheel: one row of blocks, cost-stamped */
    if (st.buildOpen) R.drawBuildWheel(ctx, view, st);

    /* damage numbers float over the world, drawn by main.js */
  };

  R.drawBuildWheel = function (ctx, view, st) {
    var W = view.w, H = view.h;
    var kinds = st.kinds;
    var n = kinds.length;
    var cw = Math.min(92, (W - 40) / n - 6);
    var total = n * (cw + 6);
    var x0 = (W - total) / 2 + 3;
    var y0 = H - 168;
    ctx.fillStyle = 'rgba(8,12,18,.72)';
    roundRect(ctx, x0 - 10, y0 - 12, total + 14, 86, 12); ctx.fill();
    for (var i = 0; i < n; i++) {
      var k = kinds[i];
      var x = x0 + i * (cw + 6);
      var affordable = k.ok;
      ctx.fillStyle = affordable ? 'rgba(255,182,77,.14)' : 'rgba(120,130,145,.10)';
      roundRect(ctx, x, y0, cw, 54, 8); ctx.fill();
      ctx.strokeStyle = k.sel ? '#ffb64d' : 'rgba(230,237,247,.18)';
      ctx.lineWidth = k.sel ? 2 : 1;
      roundRect(ctx, x, y0, cw, 54, 8); ctx.stroke();
      var img = R.sprite(k.icon);
      if (img) {
        var iw = Math.min(cw - 18, 42), ih = iw * (img.height / img.width);
        ctx.globalAlpha = affordable ? 1 : 0.4;
        ctx.drawImage(img, x + (cw - iw) / 2, y0 + 22 - ih / 2, iw, ih);
        ctx.globalAlpha = 1;
      }
      text(ctx, k.label, x + cw / 2, y0 + 46, 8, affordable ? '#e6edf7' : 'rgba(230,237,247,.4)', 'center', 800);
    }
    text(ctx, 'BUILD · ' + st.buildHint, W / 2, y0 - 20, 9, 'rgba(230,237,247,.62)', 'center', 700);
  };

  /* ---------------------------------------------------------------- phases */

  R.drawDrop = function (ctx, view, st) {
    var W = view.w, H = view.h;
    var world = st.world;
    ctx.fillStyle = '#0a0d14';
    ctx.fillRect(0, 0, W, H);

    // map panel
    var m = Math.min(W * 0.86, H * 0.44);
    var mx = (W - m) / 2, my = H * 0.17;
    ctx.save();
    roundRect(ctx, mx, my, m, m, 10); ctx.clip();
    var sc = m / world.size;
    ctx.fillStyle = '#1c2a1a'; ctx.fillRect(mx, my, m, m);
    for (var gy = 0; gy < world.grid; gy += 2) {
      for (var gx = 0; gx < world.grid; gx += 2) {
        var bi = world.tiles[gy * world.grid + gx];
        if (bi === 0) continue;
        ctx.fillStyle = BIOME[bi] ? BIOME[bi].base : '#22301f';
        ctx.globalAlpha = 0.85;
        ctx.fillRect(mx + gx * world.cell * sc, my + gy * world.cell * sc,
                     world.cell * 2 * sc + 0.6, world.cell * 2 * sc + 0.6);
      }
    }
    ctx.globalAlpha = 1;
    for (var i = 0; i < world.pois.length; i++) {
      var p = world.pois[i];
      ctx.fillStyle = 'rgba(230,237,247,.22)';
      ctx.fillRect(mx + (p.cx - p.w / 2) * sc, my + (p.cy - p.h / 2) * sc, p.w * sc, p.h * sc);
      text(ctx, p.kind.toUpperCase(), mx + p.cx * sc, my + (p.cy - p.h / 2) * sc - 4, 8,
           'rgba(230,237,247,.55)', 'center', 700);
    }
    // bus route
    ctx.strokeStyle = 'rgba(255,182,77,.75)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.moveTo(mx + world.bus.a.x * sc, my + world.bus.a.y * sc);
    ctx.lineTo(mx + world.bus.b.x * sc, my + world.bus.b.y * sc);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    ctx.strokeStyle = 'rgba(127,227,255,.5)';
    ctx.lineWidth = 1.4;
    roundRect(ctx, mx, my, m, m, 10); ctx.stroke();

    text(ctx, 'STORMFORGE', W / 2, H * 0.115, Math.min(46, W * 0.105), '#e6edf7', 'center', 900);
    text(ctx, 'A BATTLE ROYALE YOU HAVE TO MINE, BELT AND ARM', W / 2, H * 0.145, 9.5,
         'rgba(230,237,247,.55)', 'center', 700);

    // landing hint under the map
    var hint = st.dropHint || 'TAP THE MAP TO DROP';
    var pulse = 0.55 + Math.sin(st.t * 3) * 0.25;
    ctx.globalAlpha = pulse;
    text(ctx, hint, W / 2, my + m + 34, 12, '#ffb64d', 'center', 800);
    ctx.globalAlpha = 1;
    text(ctx, '32 DROP · ONE FORGE LEFT STANDING', W / 2, my + m + 56, 9,
         'rgba(230,237,247,.42)', 'center', 700);
    text(ctx, 'OFFLINE · NO ACCOUNT · NO NETWORK', W / 2, H - 26, 9,
         'rgba(230,237,247,.30)', 'center', 700);
  };

  R.drawResult = function (ctx, view, st) {
    var W = view.w, H = view.h;
    ctx.fillStyle = 'rgba(6,9,14,.82)';
    ctx.fillRect(0, 0, W, H);
    var win = st.won;
    text(ctx, win ? 'VICTORY ROYALE' : 'ELIMINATED', W / 2, H * 0.30, Math.min(40, W * 0.095),
         win ? '#ffd479' : '#ef4444', 'center', 900);
    text(ctx, win ? 'THE FORGE HELD' : '#' + st.place + ' OF 32', W / 2, H * 0.335, 11,
         'rgba(230,237,247,.62)', 'center', 700);

    var rows = st.stats;
    var ry = H * 0.42;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      ctx.globalAlpha = 0.9;
      text(ctx, r[0], W * 0.28, ry + i * 26, 10, 'rgba(230,237,247,.55)', 'left', 700);
      text(ctx, String(r[1]), W * 0.72, ry + i * 26, 14, '#e6edf7', 'right', 800);
      ctx.globalAlpha = 1;
    }
    var pulse = 0.6 + Math.sin(st.t * 3) * 0.3;
    ctx.globalAlpha = pulse;
    text(ctx, 'TAP TO REDROP', W / 2, H * 0.82, 12, '#ffb64d', 'center', 800);
    ctx.globalAlpha = 1;
  };

  R.BIOME = BIOME;
  g.SF_RENDER = R;

// Registers this module on the shared hook the collection's smoke test looks for; main.js
// replaces the hook with the live game object once everything is loaded.
window.__game = window.__game || {};

})(window);
