window.__game = window.__game || {};
/**
 * Galevault — game shell: boot, input, HUD, phases, and the automation hooks the
 * browser suite drives. The scene lives in scene3d.js, the numbers in world.js.
 */
(function (g) {
  'use strict';

  var GK = g.GK;
  var V = g.GV;
  var SL = g.GV3D;

  var SAVE_NS = 'galevault';

  var els = {
    game: document.getElementById('game'),
    hud: document.getElementById('hud'),
    stage: document.getElementById('stage'),
    boot: document.getElementById('boot'),
    bar: document.getElementById('bootbar')
  };

  var store = GK.store(SAVE_NS);
  var G = null;                     // { run, world, craft, phase, ui }
  var view = null;
  var fps = 0;
  var hits = 0;                     // count of hull hits, for the damage flash
  var lastHit = -99;
  var bootT = 0;

  /* ------------------------------------------------------------------ boot */

  function bootProgress(p) {
    if (els.bar) els.bar.style.width = Math.round(p * 100) + '%';
  }

  function start() {
    bootProgress(0.15);
    var vendor = g.AOMG_VENDOR || {};
    var crafts = V.craftTable(vendor);
    bootProgress(0.35);

    var seed = 20261101;
    var world = V.buildWorld(seed);
    bootProgress(0.62);

    /* the fast hull is the default because the game is a race; the others change
     * how it feels rather than how it looks */
    var playable = crafts.filter(function (c) { return c.playable; });
    var craft = playable[0] || crafts[0] || { name: 'Glider', mass: 20, drag: 1, hull: 300 };
    var run = V.newRun(world, craft);

    G = {
      run: run, world: world, craft: craft, craftTable: crafts,
      playable: playable.length ? playable : [craft],
      phase: 'title', ui: { craftIndex: 0, t: 0, flash: 0 },
      wins: store.get('finished', 0), best: store.get('best', 0),
      hints: store.get('hints', {})
    };

    SL.create(els.game, world, run);
    bootProgress(0.88);

    view = startLoop();
    if (view) SL.resize(view, view.w, view.h);

    bindInput();
    bootProgress(1);
    setTimeout(function () { if (els.boot) els.boot.classList.add('hide'); }, 260);
  }

  /* A local loop instead of GK.boot: the HUD is a transparent layer over a WebGL
   * canvas, and GK.boot asks for a 2D context with {alpha:false}, which paints an
   * opaque background and hides the entire 3D scene behind it. */
  function startLoop() {
    var ctx = els.hud.getContext('2d', { alpha: true, desynchronized: true });
    var vw = GK.fit(els.hud, { onResize: onResize });
    var step = 1 / 60, acc = 0, last = 0, frames = 0, fpsT = 0;
    var paused = false;

    function frame(now) {
      requestAnimationFrame(frame);
      if (!last) last = now;
      var dt = (now - last) / 1000;
      last = now;
      if (dt > 0.25) dt = step;
      if (document.hidden || paused) { acc = 0; return; }
      acc += dt;
      var guard = 0;
      while (acc >= step && guard++ < 5) { update(step); acc -= step; }
      frames++; fpsT += dt;
      if (fpsT >= 0.5) { fps = Math.round(frames / fpsT); frames = 0; fpsT = 0; }
      ctx.setTransform(vw.dpr, 0, 0, vw.dpr, 0, 0);
      drawHud(ctx, 0, vw);
    }
    requestAnimationFrame(frame);
    return vw;
  }

  function onResize(vw) {
    if (vw) SL.resize(vw, vw.w, vw.h);
  }

  /* ---------------------------------------------------------------- phases */

  function beginRun(index) {
    var craft = G.playable[index || 0] || G.craft;
    G.craft = craft;
    G.run = V.newRun(G.world, craft);
    G.phase = 'flying';
    G.runID = (G.runID || 0) + 1;
    G.newBest = false;
    G.prevBest = store.get('best:' + G.run.craft.name, 0) || 0;
    G.run.phase = 'flying';
    hits = 0; lastHit = -99;
    if (SL.create) {
      /* gate visuals and the pirate meshes belong to the run, not the world */
      SL.resetRun && SL.resetRun(G.run);
    }
    SL.sync(G.run, 0.016);
    GK.sfx.unlock();
    GK.sfx.jump();
  }

  function toTitle() {
    G.phase = 'title';
    G.run = V.newRun(G.world, G.craft);
    SL.sync(G.run, 0.016);
  }

  /* ------------------------------------------------------------------- tick */

  var input = { steer: 0, climb: 0, throttle: 1, boost: false, firing: false };

  /* One place for end-of-run bookkeeping, so a run driven by the loop and a run
   * driven by act('fly') record the same score and the same personal best. */
  function settleRun() {
    if (!G || !G.run) return;
    var run = G.run;
    if (run.phase !== 'finished' && run.phase !== 'wrecked') return;
    G.phase = run.phase;
    G.lastScore = V.score(run);
    store.set('finished', (G.wins || 0) + 1);
    G.wins = (G.wins || 0) + 1;
    var key = 'best:' + run.craft.name;
    var prev = store.get(key, 0) || 0;
    G.prevBest = prev;
    var better = run.phase === 'finished' && (!prev || run.t < prev);
    G.newBest = better;
    if (better) {
      store.set(key, Math.round(run.t * 100) / 100);
      if (!G.best || run.t < G.best) { G.best = run.t; store.set('best', Math.round(G.best * 100) / 100); }
    }
    if (settleRun.sfxed !== G.runID) {
      settleRun.sfxed = G.runID;
      if (run.phase === 'finished') GK.sfx.win(); else GK.sfx.lose();
    }
  }

  function update(dt) {
    if (!G) return;
    G.ui.t += dt;

    if (G.phase === 'flying') {
      var before = G.run.hull;
      V.step(G.run, dt, input);
      if (G.run.hull < before) { hits++; lastHit = G.run.t; GK.sfx.hurt(); }
      if (G.run.phase === 'finished' || G.run.phase === 'wrecked') settleRun();
      /* gentle recentre of the stick when nobody is touching it */
      if (!touch.steerActive) input.steer *= 0.82;
      input.boost = touch.boost || boostLatch;
    }

    SL.sync(G.run, dt);
    SL.render();
  }

  /* ---------------------------------------------------------------- drawing */

  function drawHud(ctx, t, vw) {
    var w = vw.w, h = vw.h;
    ctx.clearRect(0, 0, w, h);
    if (!G) return;

    var run = G.run;

    /* sky-side chrome: vignette + speed streaks, painted under the readouts */
    paintAtmosphere(ctx, w, h, run);

    if (G.phase === 'title') { paintTitle(ctx, w, h); return; }
    paintInstruments(ctx, w, h, run);
    paintReticle(ctx, w, h, run);
    paintMinimap(ctx, w, h, run);
    paintMessages(ctx, w, h, run);
    if (G.phase === 'finished' || G.phase === 'wrecked') paintResult(ctx, w, h, run);
  }

  function paintAtmosphere(ctx, w, h, run) {
    var speed = run ? run.speed : 0;
    /* speed streaks: radial lines from the vanishing point, only once it is fast */
    if (run && run.phase === 'flying' && speed > 70) {
      var k = GK.clamp((speed - 70) / 150, 0, 1);
      ctx.save();
      ctx.translate(w * 0.5, h * 0.46);
      ctx.strokeStyle = 'rgba(190,240,255,' + (0.05 + k * 0.16).toFixed(3) + ')';
      ctx.lineWidth = 1.2;
      for (var i = 0; i < 18; i++) {
        var a = (i / 18) * Math.PI * 2 + G.ui.t * 0.9;
        var r0 = 92 + (i % 5) * 26 + Math.sin(G.ui.t * 3 + i) * 10;
        var r1 = r0 + 40 + k * 130;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0 * 0.82);
        ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1 * 0.82);
        ctx.stroke();
      }
      ctx.restore();
    }
    /* damage flash */
    var flash = run ? GK.clamp(1 - (run.t - lastHit) / 0.5, 0, 1) : 0;
    if (flash > 0) {
      var grd = ctx.createRadialGradient(w * 0.5, h * 0.5, h * 0.22, w * 0.5, h * 0.5, h * 0.72);
      grd.addColorStop(0, 'rgba(255,60,40,0)');
      grd.addColorStop(1, 'rgba(255,48,32,' + (flash * 0.4).toFixed(3) + ')');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, w, h);
    }
    var vg = ctx.createRadialGradient(w * 0.5, h * 0.48, h * 0.3, w * 0.5, h * 0.48, h * 0.8);
    vg.addColorStop(0, 'rgba(4,8,12,0)');
    vg.addColorStop(1, 'rgba(4,8,12,.52)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }

  function panel(ctx, x, y, pw, ph) {
    ctx.fillStyle = 'rgba(6,12,18,.62)';
    ctx.strokeStyle = 'rgba(120,220,210,.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, pw, ph, 8) : ctx.rect(x, y, pw, ph);
    ctx.fill(); ctx.stroke();
  }

  function bar(ctx, x, y, bw, bh, frac, col, back) {
    ctx.fillStyle = back || 'rgba(255,255,255,.12)';
    ctx.fillRect(x, y, bw, bh);
    ctx.fillStyle = col;
    ctx.fillRect(x, y, bw * GK.clamp(frac, 0, 1), bh);
  }

  function paintInstruments(ctx, w, h, run) {
    var pad = 12;
    var mono = 'ui-monospace, Menlo, Consolas, monospace';

    /* top-left: clock and gates */
    panel(ctx, pad, pad, 132, 58);
    ctx.fillStyle = '#dff6ff';
    ctx.font = '700 22px ' + mono;
    ctx.textBaseline = 'top';
    ctx.fillText(GK.fmtTime ? GK.fmtTime(run.t) : run.t.toFixed(2), pad + 10, pad + 7);
    ctx.font = '600 10px ' + mono;
    ctx.fillStyle = '#8fd8cf';
    ctx.fillText('GATES', pad + 10, pad + 36);
    ctx.fillStyle = '#eafcff';
    ctx.font = '700 13px ' + mono;
    ctx.fillText(run.gates + '/' + run.gatesTotal, pad + 50, pad + 34);

    /* top-right: hull and boost */
    var pw = 128, px = w - pw - pad;
    panel(ctx, px, pad, pw, 58);
    ctx.font = '600 9px ' + mono;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#9fe0d6';
    ctx.fillText('HULL', px + 9, pad + 7);
    var hullF = run.hull / Math.max(1, run.hullMax);
    bar(ctx, px + 9, pad + 19, pw - 18, 7, hullF, hullF > 0.5 ? '#4ade80' : hullF > 0.22 ? '#fbbf24' : '#ef4444');
    ctx.fillStyle = '#9fe0d6';
    ctx.fillText('BOOST', px + 9, pad + 30);
    bar(ctx, px + 9, pad + 42, pw - 18, 7, run.boost / 100, run.boosting ? '#7bf0d0' : '#38b9a6');

    /* lower-left: airspeed and altitude */
    var ly = h - 74;
    panel(ctx, pad, ly, 132, 62);
    ctx.fillStyle = '#dff6ff';
    ctx.font = '700 24px ' + mono;
    /* 3.6, matching the title card: the card promised 603 km/h and the HUD stopped at
     * 519 because the two conversions disagreed */
    ctx.fillText(Math.round(run.speed * 3.6) + '', pad + 10, ly + 6);
    ctx.font = '600 9px ' + mono;
    ctx.fillStyle = '#8fd8cf';
    ctx.fillText('KM/H', pad + 10, ly + 34);
    var gy = V.groundAt(G.world, run.x, run.z);
    var alt = Math.max(0, run.y - Math.max(gy, G.world.waterY));
    ctx.fillStyle = '#c8ecff';
    ctx.font = '700 12px ' + mono;
    ctx.fillText(Math.round(alt) + ' m', pad + 66, ly + 34);

    /* craft identity: the donor hull's own numbers, on screen where the player sees them */
    var c = run.craft;
    ctx.font = '600 9px ' + mono;
    ctx.fillStyle = 'rgba(200,236,255,.62)';
    ctx.fillText(String(c.name).toUpperCase() + '  ·  MASS ' + c.mass + '  ·  DRAG ' + c.drag,
      pad + 2, ly - 14);

    /* boosts and fire: bottom-right thumb cluster */
    var bx = w - 78, by = h - 96;
    ctx.beginPath();
    ctx.arc(bx, by, 34, 0, Math.PI * 2);
    ctx.fillStyle = run.boosting ? 'rgba(123,240,208,.34)' : 'rgba(56,185,166,.16)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(123,240,208,.7)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#d9fff6';
    ctx.font = '800 12px ' + mono;
    ctx.textAlign = 'center';
    ctx.fillText('BOOST', bx, by - 3);
    ctx.font = '600 8px ' + mono;
    ctx.fillStyle = 'rgba(217,255,246,.65)';
    ctx.fillText('HOLD', bx, by + 11);
    ctx.textAlign = 'left';
  }

  function paintReticle(ctx, w, h, run) {
    var cx = w * 0.5, cy = h * 0.46;
    ctx.save();
    /* No centre reticle at all. Brackets there sat exactly on the gate the player is
     * flying at and read as debris floating inside the ring; the bearing chevron below
     * already carries the aiming information, so the middle of the screen stays clear. */
    ctx.fillStyle = 'rgba(200,255,245,.5)';
    ctx.fillRect(cx - 1, cy - 1, 2, 2);

    var gate = G.world.gates[run.nextGate];
    if (gate && run.phase === 'flying') {
      var bearing = V.wrap(Math.atan2(gate.x - run.x, gate.z - run.z) - run.yaw);
      var gdist = Math.sqrt((gate.x - run.x) * (gate.x - run.x) + (gate.z - run.z) * (gate.z - run.z));
      /* the chevron sits closer to the centre the closer the gate is, so the marker
       * itself reads as a distance cue */
      /* keep the bearing marker outside the gate ring, so it reads as "the gate is
       * that way" instead of a triangle drawn inside the hoop */
      var ring = Math.max(112, Math.min(168, 60 + gdist * 0.28));
      var ax = cx + Math.sin(bearing) * ring;
      var ay = cy - Math.cos(bearing) * ring * 0.9;
      ctx.translate(ax, ay);
      ctx.rotate(bearing);
      ctx.fillStyle = 'rgba(120,245,225,.92)';
      ctx.beginPath();
      ctx.moveTo(0, -9); ctx.lineTo(6, 5); ctx.lineTo(-6, 5);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  function paintMinimap(ctx, w, h, run) {
    var size = 86, pad = 12;
    /* sit clear of the boost thumb button: at h-96 the panel's lower edge ran under
     * the button's circle and the two read as one broken widget */
    var x = w - size - pad, y = h - size - 140;
    panel(ctx, x, y, size, size);
    var sx = (size - 10) / G.world.size;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 5, y + 5, size - 10, size - 10);
    ctx.clip();
    /* path */
    ctx.strokeStyle = 'rgba(120,245,225,.34)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    var curve = G.world.curve;
    for (var i = 0; i < curve.length; i += 4) {
      var px = x + 5 + curve[i].x * sx, py = y + 5 + curve[i].z * sx;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    /* gates */
    for (var gi = 0; gi < G.world.gates.length; gi++) {
      var gd = G.world.gates[gi];
      ctx.fillStyle = run.gatesPassed[gi] ? 'rgba(120,245,225,.28)' : (gi === run.nextGate ? '#7bf0d0' : 'rgba(255,255,255,.5)');
      ctx.fillRect(x + 5 + gd.x * sx - 1.4, y + 5 + gd.z * sx - 1.4, 2.8, 2.8);
    }
    /* pirates */
    for (var p = 0; p < run.pirates.length; p++) {
      var pr = run.pirates[p];
      if (!pr.alive) continue;
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(x + 5 + pr.x * sx - 1.2, y + 5 + pr.z * sx - 1.2, 2.4, 2.4);
    }
    /* craft */
    ctx.save();
    ctx.translate(x + 5 + run.x * sx, y + 5 + run.z * sx);
    ctx.rotate(-run.yaw);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -4); ctx.lineTo(3, 3); ctx.lineTo(-3, 3);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.restore();
  }

  function paintMessages(ctx, w, h, run) {
    ctx.textAlign = 'center';
    for (var i = 0; i < (G.phase === 'flying' ? run.msgs.length : 0); i++) {
      var m = run.msgs[i];
      var age = run.t - m.at;
      if (age > 1.6) continue;
      var a = GK.clamp(1 - age / 1.6, 0, 1);
      var yy = h * 0.30 + age * -28 - i * 2;
      ctx.font = '800 17px ui-monospace, Menlo, Consolas, monospace';
      /* a dark copy behind the coloured one: on a bright sky the toast washed out */
      ctx.fillStyle = 'rgba(3,10,14,' + (a * 0.72).toFixed(3) + ')';
      ctx.fillText(m.text, w * 0.5, yy + 1.6);
      ctx.fillStyle = m.bad ? 'rgba(255,120,96,' + (a * 0.95) + ')' : 'rgba(140,250,220,' + (a * 0.98) + ')';
      ctx.fillText(m.text, w * 0.5, yy);
    }
    ctx.textAlign = 'left';
  }

  function paintTitle(ctx, w, h) {
    var t = G.ui.t;
    /* dark scrim so the gorge reads as a backdrop, not as gameplay */
    ctx.fillStyle = 'rgba(5,10,16,.52)';
    ctx.fillRect(0, 0, w, h);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#eafcff';
    ctx.font = '800 34px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText('GALEVAULT', w * 0.5, h * 0.20);
    ctx.font = '600 11px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = 'rgba(140,230,215,.85)';
    ctx.fillText('A GORGE. A GLIDER. THREE PIRATES.', w * 0.5, h * 0.20 + 22);

    /* craft cards, straight out of the Endless Sky table */
    var list = G.playable;
    var cardW = Math.min(150, (w - 44) / list.length - 10);
    var totalW = cardW * list.length + 10 * (list.length - 1);
    var startX = (w - totalW) / 2;
    var cardY = h * 0.30;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var sel = i === G.ui.craftIndex;
      var x = startX + i * (cardW + 10);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, cardY, cardW, 96, 8); else ctx.rect(x, cardY, cardW, 96);
      ctx.fillStyle = sel ? 'rgba(56,185,166,.24)' : 'rgba(8,16,22,.6)';
      ctx.fill();
      ctx.strokeStyle = sel ? 'rgba(123,240,208,.9)' : 'rgba(255,255,255,.16)';
      ctx.lineWidth = sel ? 2 : 1;
      ctx.stroke();
      ctx.fillStyle = sel ? '#eafcff' : 'rgba(220,240,250,.75)';
      ctx.font = '700 12px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText(String(c.name).toUpperCase(), x + cardW / 2, cardY + 20);
      ctx.font = '600 9px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillStyle = 'rgba(160,225,215,.85)';
      ctx.fillText('MASS ' + c.mass, x + cardW / 2, cardY + 40);
      ctx.fillText('DRAG ' + c.drag, x + cardW / 2, cardY + 54);
      ctx.fillText('HULL ' + (c.hull || 0), x + cardW / 2, cardY + 68);
      var f = V.deriveFlight(c);
      ctx.fillStyle = 'rgba(200,236,255,.55)';
      /* 3.6, the same conversion the HUD uses: the card must not promise a top speed
       * the speedometer never reaches */
      ctx.fillText(Math.round(f.topSpeed * 3.6) + ' KM/H', x + cardW / 2, cardY + 84);
    }

    /* start button */
    var bw = 190, bh = 46, bx = (w - bw) / 2, by = cardY + 118;
    var pulse = 0.55 + Math.sin(t * 3) * 0.18;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 23); else ctx.rect(bx, by, bw, bh);
    ctx.fillStyle = 'rgba(56,185,166,' + pulse.toFixed(2) + ')';
    ctx.fill();
    ctx.strokeStyle = 'rgba(190,255,240,.85)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.fillStyle = '#04120f';
    ctx.font = '800 15px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText('LAUNCH', w * 0.5, by + 29);

    ctx.font = '600 9px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = 'rgba(200,236,255,.5)';
    ctx.fillText('LEFT THUMB STEERS  ·  RIGHT HOLDS BOOST', w * 0.5, by + 68);
    if (G.best) {
      ctx.fillStyle = 'rgba(123,240,208,.8)';
      ctx.fillText('BEST ' + GK.fmtTime(G.best), w * 0.5, by + 84);
    }
    /* attribution, on the title screen: licences belong where the player sees them */
    ctx.fillStyle = 'rgba(180,215,230,.42)';
    ctx.font = '600 8px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText('HULLS: ENDLESS SKY (GPL-3.0)  ·  SURFACES: LUANTI (CC-BY-SA)  ·  THREE.JS (MIT)', w * 0.5, h - 16);
    ctx.textAlign = 'left';
  }

  function paintResult(ctx, w, h, run) {
    ctx.fillStyle = 'rgba(4,9,14,.62)';
    ctx.fillRect(0, 0, w, h);
    var cardW = Math.min(300, w - 48), cardH = 252;
    var x = (w - cardW) / 2, y = h * 0.27;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, cardW, cardH, 12); else ctx.rect(x, y, cardW, cardH);
    ctx.fillStyle = 'rgba(8,18,26,.92)';
    ctx.fill();
    ctx.strokeStyle = run.phase === 'finished' ? 'rgba(123,240,208,.8)' : 'rgba(239,68,68,.8)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = run.phase === 'finished' ? '#9ffce8' : '#ffb3ab';
    ctx.font = '800 20px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText(run.phase === 'finished' ? 'THROUGH THE VAULT' : 'WRECKED', x + cardW / 2, y + 34);

    /* a time trial without a best time on the card is just a receipt: the ghost to
     * beat is the whole point, and separate HITS / DAMAGE rows stop "7 HITS 1" reading
     * as one ambiguous number */
    var bestNow = G.newBest ? run.t : (G.prevBest || 0);
    var rows = [
      ['GATES', run.gates + '/' + run.gatesTotal],
      ['TIME', GK.fmtTime(run.t)],
      ['BEST', bestNow ? GK.fmtTime(bestNow) : '—'],
      ['HITS', String(run.hits)],
      ['DAMAGE', Math.round(run.damage) + ' / ' + Math.round(run.hullMax)],
      ['SCORE', String(V.score(run))]
    ];
    if (G.newBest) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffb64d';
      ctx.font = '800 10px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText('NEW BEST', x + cardW / 2, y + 54);
    }

    ctx.font = '600 11px ui-monospace, Menlo, Consolas, monospace';
    for (var i = 0; i < rows.length; i++) {
      var ry = y + 62 + i * 22;
      ctx.fillStyle = 'rgba(150,215,225,.8)';
      ctx.textAlign = 'left';
      ctx.fillText(rows[i][0], x + 22, ry);
      ctx.fillStyle = '#eafcff';
      ctx.textAlign = 'right';
      ctx.fillText(rows[i][1], x + cardW - 22, ry);
    }
    ctx.textAlign = 'center';
    var bw = 160, bh = 38, bx = x + (cardW - bw) / 2, by = y + cardH - 56;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 19); else ctx.rect(bx, by, bw, bh);
    ctx.fillStyle = 'rgba(56,185,166,.85)';
    ctx.fill();
    ctx.fillStyle = '#04120f';
    ctx.font = '800 13px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText('FLY AGAIN', x + cardW / 2, by + 24);
    ctx.textAlign = 'left';
  }

  /* ------------------------------------------------------------------ input */

  var touch = { steerActive: false, steerX: 0, steerY: 0, id: -1, boost: false, boostId: -1 };
  var boostLatch = false;            // set by act('boost'), survives the touch read

  function bindInput() {
    var stage = els.stage;
    function pos(e) {
      var r = stage.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    }

    function onDown(e) {
      var p = pos(e);
      if (G.phase === 'title') { chooseAt(p); return; }
      if (G.phase === 'finished' || G.phase === 'wrecked') { beginRun(G.ui.craftIndex); return; }
      if (p.x > 0.62 && p.y > 0.55) {
        touch.boost = true;
        GK.sfx.unlock();
        return;
      }
      if (p.x < 0.55) {
        touch.steerActive = true;
        touch.steerX = p.x; touch.steerY = p.y;
      }
    }
    function onMove(e) {
      if (!touch.steerActive) return;
      var p = pos(e);
      var dx = (p.x - touch.steerX) * 3.2;
      var dy = (p.y - touch.steerY) * 3.2;
      input.steer = GK.clamp(dx, -1, 1);
      input.climb = GK.clamp(-dy, -1, 1);
    }
    function onUp() {
      touch.steerActive = false;
      touch.boost = false;
      input.climb = 0;
      input.steer = 0;
    }

    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);

    window.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft' || e.key === 'a') input.steer = -1;
      else if (e.key === 'ArrowRight' || e.key === 'd') input.steer = 1;
      else if (e.key === 'ArrowUp' || e.key === 'w') input.climb = 1;
      else if (e.key === 'ArrowDown' || e.key === 's') input.climb = -1;
      else if (e.key === ' ') { if (G.phase === 'title') beginRun(G.ui.craftIndex); else touch.boost = true; e.preventDefault(); }
      else if (e.key === 'Enter' && G.phase !== 'flying') beginRun(G.ui.craftIndex);
    });
    window.addEventListener('keyup', function (e) {
      if (['ArrowLeft', 'a', 'ArrowRight', 'd'].indexOf(e.key) >= 0) input.steer = 0;
      if (['ArrowUp', 'w', 'ArrowDown', 's'].indexOf(e.key) >= 0) input.climb = 0;
      if (e.key === ' ') touch.boost = false;
    });

    /* nothing to poll: update() reads touch.boost every frame, so holding the
     * button survives a drag off it and keyboard space works the same way */
  }

  function chooseAt(p) {
    var list = G.playable;
    var cardY = 0.30;
    if (p.y < cardY - 0.02) return;
    var idx = Math.floor(p.x * list.length);
    if (idx >= 0 && idx < list.length) G.ui.craftIndex = idx;
    if (p.y > 0.52) beginRun(G.ui.craftIndex);
  }

  /* -------------------------------------------------------------- test hooks */

  function state() {
    var run = G.run;
    var info = SL.info();
    var alive = 0;
    for (var i = 0; i < run.pirates.length; i++) if (run.pirates[i].alive) alive++;
    var vendor = g.AOMG_VENDOR || {};
    var hulls = (vendor.data && vendor.data['endless-sky/ships']) || [];
    return {
      phase: G.phase,
      started: G.phase === 'flying' || G.phase === 'finished' || G.phase === 'wrecked',
      gates: run.gates, gatesTotal: run.gatesTotal, nextGate: run.nextGate,
      t: Math.round(run.t * 100) / 100,
      hull: Math.round(run.hull), hullMax: run.hullMax,
      boost: Math.round(run.boost), boosting: !!run.boosting, speed: Math.round(run.speed),
      alt: Math.round(run.y - V.groundAt(G.world, run.x, run.z)),
      yaw: run.yaw,
      /* the crossing, stated plainly: the craft is a hull from the Endless Sky table */
      craft: { name: run.craft.name, mass: run.craft.mass, drag: run.craft.drag, hull: run.craft.hull },
      craftCount: G.playable.length,
      hullsLoaded: hulls.length,
      physicsSrc: hulls.length ? 'endless-sky' : 'fallback',
      pirates: run.pirates.length, piratesAlive: alive, bolts: run.bolts.length,
      score: V.score(run),
      seed: G.world.seed,
      three: SL.ready(), draws: info.calls, tris: info.triangles,
      donorTextures: SL.donorTextures ? SL.donorTextures() : [],
      texUsed: SL.donorTextures ? SL.donorTextures().length : 0,
      fps: fps
    };
  }

  /* Point the nose at the next gate and hold throttle: the run the browser suite
   * flies. Deterministic — no wall-clock waits, no random impulses. */
  function autopilot(n) {
    var run = G.run;
    for (var i = 0; i < n; i++) {
      var gates = G.world.gates;
      var gate = gates[run.nextGate] || gates[gates.length - 1];
      if (gate && run.phase === 'flying') {
        /* Follow the path the gates sit on, aiming a speed-scaled distance ahead:
         * chasing the gate itself arrives 20-40 units wide at 200 u/s and misses
         * the ring. The path is the racing line a player would fly. */
        /* Follow the path far out, then track the gate itself on the approach.
         * Pure pursuit rides a chord inside a curve — about 11 units wide at this
         * lookahead — and the ring pass is 12 units, so it shaved every gate. */
        var gd = Math.hypot(gate.x - run.x, gate.z - run.z);
        var aimPt = gate;
        if (gd > 120) aimPt = V.pathAhead(G.world, run.x, run.z, 150 + run.speed * 0.7).p;
        var wantYaw = Math.atan2(aimPt.x - run.x, aimPt.z - run.z);
        /* rate command, not a bang-bang error: steer is the fraction of the hull's
         * turn rate to use, so aiming with dy*2.4 made the autopilot oscillate
         * around the gate in a limit cycle and never line up. */
        var dy = V.wrap(wantYaw - run.yaw);
        var wantRate = V.clamp(dy * 1.7, -run.flight.turn, run.flight.turn);
        input.steer = V.clamp(wantRate / run.flight.turn, -1, 1);
        input.throttle = Math.abs(dy) > 1.0 ? 0.78 : 1;
        var wantY = Math.max(gate.y, V.groundAt(G.world, run.x, run.z) + 24);
        input.climb = V.clamp((wantY - run.y) / 26, -0.4, 0.4);
        input.throttle = 1;
        input.boost = run.boost > 55;
      }
      V.step(run, 1 / 60, input);
      SL.sync(run, 1 / 60);
      if (run.phase !== 'flying') break;
    }
    SL.sync(run, 1 / 60);
    SL.render();
    if (run.phase === 'finished' || run.phase === 'wrecked') settleRun();
    return state();
  }

  /* Force one full frame now (3D + HUD). The rAF loop only paints on its own
   * schedule, so a caller that has just driven the simulation — a test, the
   * screenshot tool — would otherwise capture the previous frame's HUD. */
  function redraw() {
    if (!G || !view) return null;
    SL.sync(G.run, 1 / 60);
    SL.render();
    var ctx = els.hud.getContext('2d');
    if (ctx) { ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0); drawHud(ctx, 0, view); }
    return state();
  }

  function act(name, arg) {
    arg = arg || {};
    if (!G) return { ok: false, reason: 'not booted' };
    if (name === 'newGame' || name === 'start') {
      beginRun(arg.craft != null ? arg.craft : G.ui.craftIndex);
      return state();
    }
    if (name === 'select') { G.ui.craftIndex = GK.clamp(arg.index || 0, 0, G.playable.length - 1); return state(); }
    if (name === 'steer') { input.steer = GK.clamp(arg.x || 0, -1, 1); input.climb = GK.clamp(arg.y || 0, -1, 1); return state(); }
    if (name === 'boost') { boostLatch = arg.on !== false; input.boost = boostLatch; return state(); }
    if (name === 'redraw' || name === 'paint') return redraw();
    if (name === 'fly') return autopilot(arg.n || 240);
    if (name === 'tick') {
      var n = arg.n || 60;
      for (var i = 0; i < n; i++) {
        V.step(G.run, 1 / 60, input);
        if (G.run.phase !== 'flying') break;
        SL.sync(G.run, 1 / 60);
      }
      SL.sync(G.run, 1 / 60);
      SL.render();
      if (G.run.phase === 'finished' || G.run.phase === 'wrecked') settleRun();
      return state();
    }
    if (name === 'hit') { V.hit(G.run, arg.dmg || 30, 'test'); return state(); }
    if (name === 'toTitle') { toTitle(); return state(); }
    if (name === 'pick') return SL.pick(arg.cols || 4, arg.rows || 4);
    return { ok: false, reason: 'unknown act ' + name };
  }

  /* ------------------------------------------------------------------- go */

  window.__game = window.__game || {};
  window.__game = {
    state: state, act: act, boot: start, G: G,
    get run() { return G && G.run; },
    get world() { return G && G.world; },
    SL: SL, V: V
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(window);
