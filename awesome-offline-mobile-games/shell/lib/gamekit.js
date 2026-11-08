/* GameKit — the shared runtime every game in this collection boots on.
 * Classic script (no modules) so games run from file:// with zero server.
 * Exposes window.GK. No dependencies, no network, no build step. */
(function (global) {
  'use strict';

  var GK = {};
  var TIER = null;

  /* ---------- device tier ---------- */
  GK.tier = function () {
    if (TIER) return TIER;
    var mem = navigator.deviceMemory || 4;          // Chrome/Android reports GB
    var cores = navigator.hardwareConcurrency || 4;
    var px = (screen.width * screen.height) * (window.devicePixelRatio || 1);
    var touch = ('ontouchstart' in global) || navigator.maxTouchPoints > 0;
    var score = 0;
    if (mem >= 8) score += 2; else if (mem >= 4) score += 1;
    if (cores >= 8) score += 2; else if (cores >= 4) score += 1;
    if (px > 3000000) score += 1;
    TIER = { name: score >= 4 ? 'high' : score >= 2 ? 'mid' : 'low', mem: mem, cores: cores, touch: touch, dpr: window.devicePixelRatio || 1 };
    return TIER;
  };

  /* ---------- canvas sizing ---------- */
  /* Fills the canvas to its CSS box at a capped device pixel ratio, and keeps
   * the drawing surface honest on rotate/resize. Returns {w,h,dpr}. */
  GK.fit = function (canvas, opts) {
    opts = opts || {};
    var cap = opts.maxDpr || (GK.tier().name === 'low' ? 1.5 : 2);
    var state = { w: 0, h: 0, dpr: 1 };
    function apply() {
      var r = canvas.getBoundingClientRect();
      var dpr = Math.min(cap, window.devicePixelRatio || 1);
      var w = Math.max(1, Math.round(r.width));
      var h = Math.max(1, Math.round(r.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      state.w = w; state.h = h; state.dpr = dpr;
      if (opts.onResize) opts.onResize(state);
    }
    apply();
    var raf = 0;
    function lazy() { cancelAnimationFrame(raf); raf = requestAnimationFrame(apply); }
    window.addEventListener('resize', lazy);
    window.addEventListener('orientationchange', lazy);
    if (global.ResizeObserver) new ResizeObserver(lazy).observe(canvas);
    return state;
  };

  /* ---------- main loop ---------- */
  /* Fixed-step update (default 60 Hz) with a clamped dt so a backgrounded tab
   * cannot fast-forward the simulation on return. Pauses on hide. */
  GK.boot = function (opts) {
    var ctx = opts.canvas.getContext('2d', { alpha: false, desynchronized: true });
    var view = GK.fit(opts.canvas, { onResize: opts.onResize });
    var step = 1 / (opts.hz || 60);
    var acc = 0, last = 0, raf = 0, running = true, paused = false;
    var t = 0, frames = 0, fps = 0, fpsT = 0;

    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (!last) last = now;
      var dt = (now - last) / 1000;
      last = now;
      if (dt > 0.25) dt = step;            // tab was hidden / stalled: drop the gap
      if (paused) return;
      acc += dt;
      var guard = 0;
      while (acc >= step && guard++ < 5) {
        t += step;
        if (opts.update) opts.update(step, t);
        acc -= step;
      }
      frames++; fpsT += dt;
      if (fpsT >= 0.5) { fps = Math.round(frames / fpsT); frames = 0; fpsT = 0; }
      if (opts.render) {
        ctx.save();
        ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
        opts.render(ctx, t, view);
        ctx.restore();
      }
      if (opts.hud) opts.hud({ fps: fps, view: view, t: t });
    }

    document.addEventListener('visibilitychange', function () {
      paused = document.hidden;
      last = 0; acc = 0;
    });

    raf = requestAnimationFrame(frame);
    return {
      view: view,
      ctx: ctx,
      get fps() { return fps; },
      get t() { return t; },
      pause: function () { paused = true; },
      resume: function () { paused = false; last = 0; },
      stop: function () { running = false; cancelAnimationFrame(raf); },
      get running() { return running; }
    };
  };

  /* ---------- storage ---------- */
  GK.store = function (ns) {
    var key = 'aomg.' + ns;
    function read() {
      try { return JSON.parse(localStorage.getItem(key) || '{}'); }
      catch (e) { return {}; }
    }
    return {
      get: function (k, d) { var o = read(); return k in o ? o[k] : d; },
      set: function (k, v) {
        var o = read(); o[k] = v;
        try { localStorage.setItem(key, JSON.stringify(o)); return true; }
        catch (e) { return false; }
      },
      all: read,
      wipe: function () { localStorage.removeItem(key); },
      export: function () { return JSON.stringify({ ns: ns, data: read(), at: new Date().toISOString() }); },
      import: function (json) {
        try {
          var o = JSON.parse(json);
          if (!o || o.ns !== ns) return false;
          localStorage.setItem(key, JSON.stringify(o.data || {}));
          return true;
        } catch (e) { return false; }
      }
    };
  };

  /* ---------- haptics ---------- */
  GK.buzz = function (ms) {
    if (navigator.vibrate && GK.store('settings').get('haptics', true)) {
      try { navigator.vibrate(ms || 12); } catch (e) {}
    }
  };

  /* ---------- audio: synthesised, so it ships as zero bytes ---------- */
  GK.sfx = (function () {
    var ac = null, on = true, master = null;
    function ensure() {
      if (!ac) {
        var C = global.AudioContext || global.webkitAudioContext;
        if (!C) return null;
        ac = new C();
        master = ac.createGain();
        master.gain.value = 0.18;
        master.connect(ac.destination);
      }
      if (ac.state === 'suspended') ac.resume();
      return ac;
    }
    function tone(freq, dur, type, vol, slide) {
      var a = ensure(); if (!a || !on) return;
      var o = a.createOscillator(), g = a.createGain();
      o.type = type || 'square';
      o.frequency.setValueAtTime(freq, a.currentTime);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, slide), a.currentTime + dur);
      g.gain.setValueAtTime(0.0001, a.currentTime);
      g.gain.exponentialRampToValueAtTime(vol || 0.5, a.currentTime + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
      o.connect(g); g.connect(master);
      o.start(); o.stop(a.currentTime + dur + 0.02);
    }
    function noise(dur, vol, hp) {
      var a = ensure(); if (!a || !on) return;
      var n = a.sampleRate * dur, buf = a.createBuffer(1, n, a.sampleRate), d = buf.getChannelData(0);
      for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      var s = a.createBufferSource(); s.buffer = buf;
      var f = a.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp || 400;
      var g = a.createGain(); g.gain.value = vol || 0.4;
      s.connect(f); f.connect(g); g.connect(master); s.start();
    }
    return {
      unlock: function () { ensure(); },
      set enabled(v) { on = v; },
      get enabled() { return on; },
      hit: function () { tone(220, 0.09, 'square', 0.5, 110); },
      shoot: function () { tone(880, 0.06, 'sawtooth', 0.28, 320); },
      boom: function () { noise(0.28, 0.5, 200); tone(90, 0.25, 'sine', 0.5, 40); },
      coin: function () { tone(1050, 0.05, 'triangle', 0.3, 1400); },
      step: function () { noise(0.05, 0.12, 900); },
      jump: function () { tone(420, 0.12, 'sine', 0.35, 720); },
      hurt: function () { tone(180, 0.18, 'sawtooth', 0.5, 70); },
      win: function () { [523, 659, 784, 1046].forEach(function (f, i) { setTimeout(function () { tone(f, 0.14, 'triangle', 0.4); }, i * 90); }); },
      lose: function () { [392, 330, 262, 196].forEach(function (f, i) { setTimeout(function () { tone(f, 0.18, 'sawtooth', 0.35); }, i * 110); }); }
    };
  })();

  /* ---------- touch controls ---------- */
  /* Builds a thumb-pad overlay: a 4-way d-pad plus up to 3 action buttons.
   * Buttons are real DOM nodes (cheap hit-testing, works while canvas redraws).
   * state = {x, y, jump, dash, use} all -1..1 / boolean. */
  GK.pad = function (opts) {
    opts = opts || {};
    var host = opts.host || document.body;
    var state = { x: 0, y: 0, jump: false, dash: false, use: false };
    var root = document.createElement('div');
    root.className = 'gk-pad';
    root.style.cssText = 'position:fixed;inset:auto 0 0 0;pointer-events:none;z-index:40;' +
      'display:flex;justify-content:space-between;align-items:flex-end;padding:14px;' +
      'padding-bottom:calc(14px + env(safe-area-inset-bottom));touch-action:none;';
    if (opts.hidden) root.style.display = 'none';

    function mkButton(label, cls, down, up) {
      var b = document.createElement('div');
      b.className = 'gk-btn ' + cls;
      b.textContent = label;
      b.style.cssText = 'pointer-events:auto;width:64px;height:64px;border-radius:50%;' +
        'background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.22);' +
        'color:#fff;font:600 13px/64px system-ui,sans-serif;text-align:center;' +
        'backdrop-filter:blur(6px);user-select:none;-webkit-user-select:none;touch-action:none;';
      b.addEventListener('pointerdown', function (e) { e.preventDefault(); b.setPointerCapture(e.pointerId); b.style.background = 'rgba(255,255,255,.28)'; down(); });
      b.addEventListener('pointerup', function (e) { e.preventDefault(); b.style.background = 'rgba(255,255,255,.10)'; up(); });
      b.addEventListener('pointercancel', function (e) { e.preventDefault(); b.style.background = 'rgba(255,255,255,.10)'; up(); });
      return b;
    }

    // D-pad: one drag surface, direction from the vector
    var pad = document.createElement('div');
    pad.style.cssText = 'pointer-events:auto;width:132px;height:132px;border-radius:50%;' +
      'background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.18);' +
      'touch-action:none;position:relative;';
    var knob = document.createElement('div');
    knob.style.cssText = 'position:absolute;left:50%;top:50%;width:52px;height:52px;margin:-26px 0 0 -26px;' +
      'border-radius:50%;background:rgba(255,255,255,.20);border:1px solid rgba(255,255,255,.30);' +
      'transition:transform .05s linear;';
    pad.appendChild(knob);
    var active = false;
    function move(e) {
      if (!active) return;
      var r = pad.getBoundingClientRect();
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var dx = e.clientX - cx, dy = e.clientY - cy;
      var max = r.width / 2;
      var len = Math.hypot(dx, dy) || 1;
      var cl = Math.min(len, max);
      var nx = (dx / len) * cl, ny = (dy / len) * cl;
      state.x = Math.abs(nx / max) > 0.22 ? nx / max : 0;
      state.y = Math.abs(ny / max) > 0.22 ? ny / max : 0;
      knob.style.transform = 'translate(' + nx + 'px,' + ny + 'px)';
    }
    pad.addEventListener('pointerdown', function (e) { e.preventDefault(); active = true; pad.setPointerCapture(e.pointerId); move(e); });
    pad.addEventListener('pointermove', move);
    function release(e) {
      active = false; state.x = 0; state.y = 0; knob.style.transform = '';
      if (e) { try { pad.releasePointerCapture(e.pointerId); } catch (err) {} }
    }
    pad.addEventListener('pointerup', release);
    pad.addEventListener('pointercancel', release);

    var right = document.createElement('div');
    right.style.cssText = 'display:flex;gap:12px;align-items:flex-end;';
    var acts = (opts.actions || [['A', 'jump'], ['B', 'dash']]);
    acts.forEach(function (a) {
      var key = a[1];
      right.appendChild(mkButton(a[0], 'gk-btn-' + key,
        function () { state[key] = true; if (opts.onPress) opts.onPress(key); GK.buzz(8); },
        function () { state[key] = false; if (opts.onRelease) opts.onRelease(key); }));
    });

    root.appendChild(pad);
    root.appendChild(right);
    host.appendChild(root);

    // keyboard mirrors the pad so one code path drives both
    var keys = {};
    window.addEventListener('keydown', function (e) {
      keys[e.key] = true; syncKeys(e.key, true);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArkRight', ' ', 'ArrowRight'].indexOf(e.key) >= 0) e.preventDefault();
    });
    window.addEventListener('keyup', function (e) { keys[e.key] = false; syncKeys(e.key, false); });
    function syncKeys(k, down) {
      var map = { ArrowLeft: ['x', -1], a: ['x', -1], ArrowRight: ['x', 1], d: ['x', 1], ArrowUp: ['y', -1], w: ['y', -1], ArrowDown: ['y', 1], s: ['y', 1] };
      if (map[k]) {
        if (down) state[map[k][0]] = map[k][1];
        else if (Math.sign(state[map[k][0]]) === map[k][1]) state[map[k][0]] = 0;
      }
      if (k === ' ' || k === 'z' || k === 'k') { state.jump = down; if (opts.onPress && down) opts.onPress('jump'); if (opts.onRelease && !down) opts.onRelease('jump'); }
      if (k === 'Shift' || k === 'x' || k === 'l') { state.dash = down; if (opts.onPress && down) opts.onPress('dash'); if (opts.onRelease && !down) opts.onRelease('dash'); }
      if (k === 'e' || k === 'Enter') { state.use = down; if (opts.onPress && down) opts.onPress('use'); if (opts.onRelease && !down) opts.onRelease('use'); }
    }

    return {
      state: state,
      root: root,
      show: function (v) { root.style.display = v ? 'flex' : 'none'; },
      destroy: function () { root.remove(); }
    };
  };

  /* ---------- tiny helpers games keep re-implementing ---------- */
  GK.clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  GK.lerp = function (a, b, t) { return a + (b - a) * t; };
  GK.rand = function (seed) { // mulberry32 — deterministic per seed
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  GK.rr = function (rng, a, b) { return a + rng() * (b - a); };
  GK.ri = function (rng, a, b) { return Math.floor(a + rng() * (b - a + 1)); };
  GK.pick = function (rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length]; };
  GK.fmtTime = function (s) {
    s = Math.max(0, s);
    var m = Math.floor(s / 60), r = Math.floor(s % 60);
    return m + ':' + (r < 10 ? '0' : '') + r;
  };
  GK.shade = function (hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = GK.clamp(((n >> 16) & 255) + amt, 0, 255);
    var g = GK.clamp(((n >> 8) & 255) + amt, 0, 255);
    var b = GK.clamp((n & 255) + amt, 0, 255);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  };

  global.GK = GK;
})(window);
