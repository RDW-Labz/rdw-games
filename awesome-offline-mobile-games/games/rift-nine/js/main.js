/* Rift Nine — a momentum platformer: nine procedurally-built rooms, one grapple
 * hook, and a stopwatch that judges you.
 *
 * Controls
 *   run ....... A / D or <- / ->
 *   jump ...... Space / W / Z   (hold for height, tap for a hop)
 *   grapple ... hold X / Shift / E, or the B pad button
 *   touch ..... drag the left half to run, A jumps, B holds the hook
 *
 * Design lineage: DDNet's momentum-first movement (air control, coyote time,
 * hook physics) crossed with SuperTuxKart's drift/boost economy — pads only
 * pay out if you arrive with speed, and chaining them stacks a multiplier.
 *
 * Everything is drawn with Canvas 2D primitives. Audio and backdrop art come
 * from vendor/ (SuperTuxKart sfx + music, Shattered Pixel Dungeon sprites),
 * with GK.sfx synthesis and no dressing as the fallback when the bundle is
 * absent. Classic script, no modules, no network: runs from file:// as-is.
 */
(function () {
  'use strict';

  var GK = window.GK;
  if (!GK) return;

  var canvas = document.getElementById('game');
  if (!canvas) return;
  var store = GK.store('rift-nine');

  /* ==================================================================
   * VENDORED CONTENT — real audio, real sprite art
   *
   * vendor/vendor.js (loaded before gamekit) carries SuperTuxKart's seven
   * sound effects, its alien_signal track, and Shattered Pixel Dungeon's
   * sprite sheets. Everything below is optional: each lookup is guarded and
   * degrades to GK.sfx synthesis / no dressing, so the game boots without
   * the bundle. Classic scripts only, no fetch — media elements are built
   * with new Audio(url), which also works on file://.
   * ================================================================== */
  var VENDOR = window.AOMG_VENDOR || { data: {}, assets: [] };
  function vendorUrl(p) { return '../../' + p; }
  function vendorTable(key) { return (VENDOR && VENDOR.data && VENDOR.data[key]) || null; }

  /* required credit line (title screen) */
  var CREDIT = 'Music and sfx: SuperTuxKart contributors (GPL-2.0+/CC-BY-SA); sprites: Shattered Pixel Dungeon contributors (GPL-3.0)';

  /* ------------------------------------------------------------------
   * AUDIO — vendored files mapped onto the game's real events.
   *
   * Pooled <audio> voices (not WebAudio): decodeAudioData needs fetch,
   * which is dead on file://. Three voices per cue so overlapping jumps
   * and coin pickups do not cut each other off.
   * ------------------------------------------------------------------ */
  var AUDIO = (function () {
    var stk = vendorTable('stk-assets/audio');
    var spd = vendorTable('shattered-pixel-dungeon/assets');
    var file = {};

    function add(prefix, list) {
      if (!list) return;
      for (var j = 0; j < list.length; j++) {
        var e = list[j];
        if (e && e.name && e.audio) file[prefix + e.name] = vendorUrl(e.audio);
      }
    }
    if (stk) { add('', stk.sounds); add('music:', stk.music); }
    if (spd) add('spd:', spd.sounds);   // SPD names would otherwise shadow STK ones

    /* event -> vendored cue + the synth cue used when the bundle is missing.
     * There is no 'crystal' sfx in the STK set, so the room-clear chime is
     * SPD's level-up instead; the run report gets SPD's mastery flourish. */
    var EVENTS = {
      jump:    { key: 'boing',             vol: 0.55, fallback: 'jump' },
      land:    { key: 'anvil',             vol: 0.5,  fallback: 'step' },
      death:   { key: 'crash',             vol: 0.7,  fallback: 'hurt' },
      coin:    { key: 'clock',             vol: 0.4,  fallback: 'coin' },
      clear:   { key: 'spd:levelup',       vol: 0.6,  fallback: 'win' },
      hook:    { key: 'break',             vol: 0.5,  fallback: 'shoot' },
      release: { key: 'bubblegum_explode', vol: 0.45, fallback: 'step' },
      boost:   { key: 'explosion',         vol: 0.55, fallback: 'boom' },
      finish:  { key: 'spd:mastery',       vol: 0.6,  fallback: 'win' }
    };

    var VOICES = 3, pools = {}, unlocked = false;

    function synth(name) {
      var f = GK.sfx[name];
      if (typeof f === 'function') { try { f(); } catch (e) { /* older engines */ } }
    }

    function pool(name) {
      var p = pools[name];
      if (p) return p;
      var def = EVENTS[name];
      p = { el: [], i: 0 };
      if (def && file[def.key]) {
        for (var n = 0; n < VOICES; n++) {
          try {
            var a = new Audio(file[def.key]);
            a.preload = 'auto';
            a.volume = def.vol;
            p.el.push(a);
          } catch (e) { p.el.length = 0; break; }
        }
      }
      pools[name] = p;
      return p;
    }

    function play(name) {
      if (!GK.sfx.enabled) return false;          // the shared mute toggle
      var def = EVENTS[name];
      if (!def) return false;
      var p = pool(name);
      if (!p.el.length) { synth(def.fallback); return false; }
      var a = p.el[p.i = (p.i + 1) % p.el.length];
      try {
        a.currentTime = 0;
        var pr = a.play();
        if (pr && pr.catch) pr.catch(function () { /* policy / decode */ });
      } catch (e) { synth(def.fallback); return false; }
      return true;
    }

    /* One play() inside a real gesture authorises an element for the rest of
     * the session; prime every voice silently so the first shotgun-of-events
     * (jump + land in the same frame) is not swallowed by autoplay policy. */
    function prime(a) {
      var v = a.volume;
      try {
        a.volume = 0;
        var pr = a.play();
        if (pr && pr.then) {
          pr.then(function () {
            try { a.pause(); a.currentTime = 0; } catch (e) { /* ignore */ }
            a.volume = v;
          }, function () { a.volume = v; });
        } else { a.pause(); a.volume = v; }
      } catch (e) { a.volume = v; }
    }
    function unlock() {
      if (unlocked) return;
      unlocked = true;
      for (var k in EVENTS) {
        var p = pool(k);
        for (var n = 0; n < p.el.length; n++) prime(p.el[n]);
      }
    }

    /* ---- music: alien_signal, looped, low, from the first input onward ---- */
    var MUSIC_VOL = 0.16;
    var mus = { el: null, vol: 0 };

    function music() {
      if (mus.el !== null) return mus.el;
      if (!file['music:alien_signal']) { mus.el = false; return false; }
      try {
        var a = new Audio(file['music:alien_signal']);
        a.loop = true;
        a.preload = 'auto';
        a.volume = 0;
        mus.el = a;
      } catch (e) { mus.el = false; }
      return mus.el;
    }

    /* Eases in/out so muting is a fade, not a chop; pauses once silent. */
    function tick(dt, want) {
      var a = music();
      if (!a) return;
      var audible = !!want && GK.sfx.enabled;
      mus.vol += ((audible ? MUSIC_VOL : 0) - mus.vol) * (1 - Math.pow(0.02, dt));
      if (mus.vol < 0.002) {
        mus.vol = 0;
        if (!a.paused) a.pause();
      } else if (a.paused && audible) {
        var pr = a.play();
        if (pr && pr.catch) pr.catch(function () { /* policy */ });
      }
      try { a.volume = mus.vol; } catch (e) { /* ignore */ }
    }

    return { play: play, unlock: unlock, tick: tick };
  })();

  /* ------------------------------------------------------------------
   * SPR — Shattered Pixel Dungeon sheets as set dressing.
   *
   * Each PNG is one horizontal strip: frame = image height, count =
   * width / height. Drawn at integer scales with smoothing off, stepped at
   * 2-4 fps so the creatures breathe instead of strobe. Purely visual:
   * nothing here touches solids or hazard checks.
   * ------------------------------------------------------------------ */
  var SPR = (function () {
    var table = vendorTable('shattered-pixel-dungeon/assets');
    var path = {}, cache = {};

    /* ax/ay = anchor inside the frame, in frame pixels (feet for the golem,
     * centre for the floaters), sc = integer pixel-art scale, fps = step rate.
     * tint/mix pull the sheet's own palette toward the game's mint-on-ink one:
     * raw SPD colour read as pixel noise against the neon vector art, and a
     * graded silhouette reads as distant fauna / carved stone instead. */
    var KINDS = {
      wisp:  { sprite: 'crystal_wisp', ax: 8,  ay: 8,  sc: 2, fps: 3.2, tint: '#7cf5d0', mix: 0.5,  gain: 0.9 },
      eye:   { sprite: 'eye',          ax: 16, ay: 8,  sc: 1, fps: 2.4, tint: '#9ad8ff', mix: 0.5,  gain: 0.8 },
      golem: { sprite: 'golem',        ax: 16, ay: 19, sc: 2, fps: 2.4, tint: '#33465a', mix: 0.8,  gain: 1 }
    };
    var graded = {};

    if (table && table.sprites) {
      for (var i = 0; i < table.sprites.length; i++) {
        path[table.sprites[i].name] = vendorUrl(table.sprites[i].image);
      }
    }
    var any = false, k;
    for (k in KINDS) if (path[KINDS[k].sprite]) any = true;

    function img(name) {
      var p = path[name];
      if (!p) return null;
      var im = cache[name];
      if (!im) {
        try { im = new Image(); im.src = p; } catch (e) { return null; }
        cache[name] = im;
      }
      return im;
    }
    function ready(im) {
      return !!(im && im.complete && im.naturalWidth > 0 && im.naturalHeight > 0);
    }

    /* One graded frame, built once per (sprite, frame, tint) and reused: flat
     * colour over the sprite's own alpha via 'source-atop'. No canvas filter,
     * so it stays cheap and identical on every engine. */
    function grade(im, fh, f, tint, mix) {
      var key = im.src + '|' + f + '|' + tint;
      var c = graded[key];
      if (c) return c;
      c = document.createElement('canvas');
      c.width = fh; c.height = fh;
      var g = c.getContext('2d');
      if (!g) return null;
      g.imageSmoothingEnabled = false;
      g.drawImage(im, f * fh, 0, fh, fh, 0, 0, fh, fh);
      g.globalCompositeOperation = 'source-atop';
      g.globalAlpha = mix;
      g.fillStyle = tint;
      g.fillRect(0, 0, fh, fh);
      graded[key] = c;
      return c;
    }

    /* x/y are the anchor point; ph offsets the frame index per instance.
     * opt can retint a single pass (the sentinel's rim light reuses the sheet). */
    function draw(ctx, kind, x, y, ph, alpha, opt) {
      var kd = KINDS[kind];
      if (!kd) return false;
      var im = img(kd.sprite);
      if (!ready(im)) return false;
      var fh = im.naturalHeight;
      var n = Math.max(1, Math.round(im.naturalWidth / fh));
      var f = ((Math.floor(clock * kd.fps + (ph || 0)) % n) + n) % n;
      var tint = (opt && opt.tint) || kd.tint;
      var src = grade(im, fh, f, tint, (opt && opt.mix != null) ? opt.mix : kd.mix);
      if (!src) return false;
      var sc = (opt && opt.sc) || kd.sc;
      var smooth = !!(opt && opt.smooth);
      var wasSmooth = ctx.imageSmoothingEnabled;
      if (smooth !== wasSmooth) ctx.imageSmoothingEnabled = smooth;
      ctx.globalAlpha = (alpha == null ? 1 : alpha) * kd.gain;
      ctx.drawImage(src, 0, 0, fh, fh,
        Math.round(x - kd.ax * sc), Math.round(y - kd.ay * sc), fh * sc, fh * sc);
      if (smooth !== wasSmooth) ctx.imageSmoothingEnabled = wasSmooth;
      return true;
    }

    return {
      enabled: function () { return any; },
      has: function (kind) { return !!(KINDS[kind] && path[KINDS[kind].sprite]); },
      draw: draw
    };
  })();

  /* ==================================================================
   * PALETTE
   * ================================================================== */
  var C = {
    bg: '#0a0b12',
    bgDeep: '#070810',
    ink: '#0b0e18',
    slate: '#141a2a',
    dim: '#26304a',
    mint: '#7cf5d0',
    mintInk: '#173b33',
    red: '#ff4d6d',
    gold: '#ffd166',
    blue: '#5aa9ff',
    white: '#eaf6ff'
  };
  var MONO = 'ui-monospace,SFMono-Regular,Menlo,monospace';
  var UI = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  /* One type scale for every number in the HUD: tabular monospace, weight
   * 700, never below 12px. Labels sit a size down, tracked out and never
   * below 11px, so the top bar stays legible on a 360px-wide phone. */
  var NUM_SM = '700 12px ui-monospace,SFMono-Regular,Menlo,monospace';
  var LBL_SM = '600 11px ui-monospace,SFMono-Regular,Menlo,monospace';
  function numFont(px) { return '700 ' + Math.max(12, Math.round(px)) + 'px ' + MONO; }
  function lblFont(px) { return '600 ' + Math.max(11, Math.round(px)) + 'px ' + MONO; }

  /* Carved-stone palettes, cycled by room. Every string is pre-built once so
   * the level pass never concatenates a colour while drawing. */
  var PAL = [
    {
      edge: 'rgba(124,245,208,0.88)', edgeMid: 'rgba(124,245,208,0.42)',
      edgeLow: 'rgba(124,245,208,0.20)', glow: 'rgba(124,245,208,0.07)',
      lip: '#3a5f57', lipDeep: '#1b3134', body: '#070c11', bodyLow: '#080d12',
      tones: ['#1d2a36', '#24333f', '#16212b'],
      vein: 'rgba(124,245,208,0.07)', seam: 'rgba(2,5,8,0.7)'
    },
    {
      edge: 'rgba(90,169,255,0.88)', edgeMid: 'rgba(90,169,255,0.40)',
      edgeLow: 'rgba(90,169,255,0.18)', glow: 'rgba(90,169,255,0.07)',
      lip: '#37506c', lipDeep: '#1a2636', body: '#06090f', bodyLow: '#070a12',
      tones: ['#1b2433', '#22303f', '#141d2a'],
      vein: 'rgba(120,175,255,0.07)', seam: 'rgba(2,4,9,0.7)'
    },
    {
      edge: 'rgba(255,209,102,0.86)', edgeMid: 'rgba(255,209,102,0.38)',
      edgeLow: 'rgba(255,209,102,0.16)', glow: 'rgba(255,209,102,0.06)',
      lip: '#5a5236', lipDeep: '#2a2718', body: '#08080a', bodyLow: '#0a0a0d',
      tones: ['#23242b', '#2b2c35', '#1a1b21'],
      vein: 'rgba(255,209,102,0.06)', seam: 'rgba(3,3,5,0.7)'
    }
  ];

  /* ==================================================================
   * MOVEMENT TUNING — all values px and px/s. Units are world units;
   * one world unit is one CSS pixel at zoom 1 (zoom normalises for
   * screen height, so a phone and a desktop see the same vertical slice).
   *
   * Feel targets:
   *   - jump apex ~143px, full arc ~0.79s, horizontal reach ~237px
   *   - 90ms coyote window and 120ms jump buffer: forgiving, never floaty
   *   - speed above the cap is *kept*; only friction bleeds it away, which
   *     is what makes boost pads and swing releases worth chasing
   * ================================================================== */
  var GRAVITY         = 2150;   // px/s^2, baseline downward pull
  var GRAVITY_RISE    = 1480;   // lighter while jump is held and vy < 0
  var GRAVITY_FALL    = 2380;   // heavier on the way down — short, snappy arcs
  var JUMP_VEL        = 650;    // takeoff speed; apex = JUMP_VEL^2 / (2*GRAVITY_RISE)
  var JUMP_CUT        = 0.42;   // vy multiplier when jump is released early
  var MAX_RUN         = 300;    // base horizontal top speed
  var ACCEL_GROUND    = 2900;   // px/s^2 toward the cap while a direction is held
  var ACCEL_AIR       = 1720;   // air control acceleration
  var FRICTION_GROUND = 2600;   // deceleration with no direction held, on the floor
  var DRAG_AIR        = 240;    // horizontal drag in the air
  var TURN_MUL        = 1.6;    // extra acceleration when reversing (snappy pivots)
  var COYOTE_TIME     = 0.09;   // 90 ms of grace after leaving a ledge
  var JUMP_BUFFER     = 0.12;   // a jump pressed this early still fires on landing
  var WALL_SLIDE_MAX  = 200;    // terminal fall speed while hugging a wall
  var WALL_JUMP_X     = 350;    // push away from the wall
  var WALL_JUMP_Y     = 610;
  var WALL_JUMP_LOCK  = 0.11;   // input is ignored briefly so the kick reads
  var MAX_FALL        = 900;

  /* GRAPPLE — see the rope maths block above ropeConstraint(). */
  var HOOK_RANGE      = 430;    // search radius from the player's centre
  var HOOK_MIN_LEN    = 46;     // shortest rope; stops slingshotting into the anchor
  var HOOK_REEL       = 200;    // px/s the rope shortens while held
  var HOOK_AIR_MUL    = 0.55;   // air-control scaling on the rope
  var HOOK_GRAV_MUL   = 0.9;    // slightly floatier while swinging
  var HOOK_GRAB_KICK  = 42;     // small upward snap on attach, reads as a "catch"
  var HOOK_RELEASE_V  = 60;     // upward nudge on release, only below 200 px/s
  var HOOK_CONE       = 0.12;   // min dot(product) between aim and anchor direction

  /* BOOST / DRIFT — the SuperTuxKart half of the design. */
  var BOOST_MIN_SPEED = 165;    // pads only pay above this entry speed
  var BOOST_IMPULSE   = 172;    // instant velocity added along the pad arrow
  var BOOST_CEIL      = 130;    // hard ceiling above the cap so a pad can't launch you into orbit
  var BOOST_GAIN      = 0.42;   // multiplier gained per pad / per second of drift
  var BOOST_DECAY     = 0.5;    // multiplier units lost per second
  var BOOST_MAX       = 2.1;    // cap on the speed multiplier

  /* Run structure */
  var ROOMS = 9;
  var PAR = [11, 12, 13, 14, 15, 16, 17, 18, 20];   // per-room target, 136s total

  /* ==================================================================
   * RUNTIME STATE
   * ================================================================== */
  var view = { w: 960, h: 540, dpr: 1 };
  var zoom = 1;
  var mode = 'title';          // 'title' | 'play' | 'roomClear' | 'results'
  var clock = 0;               // global animation clock (always advances)
  var screenT = 0;             // seconds on the current screen
  var level = null;
  var run = null;
  var result = null;
  var clearCard = null;        // split card shown between rooms
  var best = loadBest();
  var lastTick = 0;

  var P = {
    x: 0, y: 0, vx: 0, vy: 0,
    hw: 9, hh: 13,              // half extents of the collision box
    onGround: false, coyote: 0, jumpBuf: 0, jumped: false, jumpCut: false,
    wallDir: 0, wallT: 0, wallLock: 0,
    face: 1,
    sx: 1, sy: 1,               // squash & stretch, eased back to 1
    trail: [],
    spawnT: 0
  };

  var hook = { on: false, ax: 0, ay: 0, len: 0, t: 0, cd: 0 };
  var boost = { mult: 1, t: 0, drift: 0 };
  var cam = { x: 0, y: 0 };
  var shake = 0, shakeX = 0, shakeY = 0;
  var hurtFlash = 0, roomIntro = 0;
  var parts = [];
  var floats = [];
  var ghostSamples = null;

  /* input: pad state + touch stick + the scripted overrides used by __game */
  var input = { x: 0, jump: false, hook: false };
  var prevJump = false, prevHook = false, anyPrev = false;
  var manual = { x: 0, jump: false, hook: false, pulse: false };
  var tstick = { active: false, ox: 0, oy: 0, x: 0, y: 0 };
  var tJump = { held: false };
  var tapEdge = false;

  var pad = GK.pad({ actions: [['A', 'jump'], ['B', 'hook']] });

  /* ==================================================================
   * STORAGE
   * ================================================================== */
  function loadBest() {
    var b = {
      total: Number(store.get('bestTime', 0)) || 0,
      deaths: Number(store.get('bestDeaths', 0)) || 0,
      rooms: store.get('roomBest', null),
      ghosts: store.get('ghosts', null)
    };
    if (!b.rooms || b.rooms.length !== ROOMS) b.rooms = [];
    if (!b.ghosts || b.ghosts.length !== ROOMS) b.ghosts = [];
    for (var i = 0; i < ROOMS; i++) {
      if (typeof b.rooms[i] !== 'number') b.rooms[i] = 0;
      if (!b.ghosts[i] || !b.ghosts[i].length) b.ghosts[i] = [];
    }
    return b;
  }

  /* ==================================================================
   * SMALL HELPERS
   * ================================================================== */
  function approach(v, target, delta) {
    if (v < target) return Math.min(v + delta, target);
    if (v > target) return Math.max(v - delta, target);
    return v;
  }
  function overlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }
  function circRect(cx, cy, r, rx, ry, rw, rh) {
    var nx = GK.clamp(cx, rx, rx + rw), ny = GK.clamp(cy, ry, ry + rh);
    var dx = cx - nx, dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }
  function pbox() { return { x: P.x - P.hw, y: P.y - P.hh, w: P.hw * 2, h: P.hh * 2 }; }
  function fmt(s) { return GK.fmtTime(s) + '.' + pad2(Math.floor((s % 1) * 100)); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtMs(s) {
    var cs = Math.floor((s % 1) * 100);
    return GK.fmtTime(s) + '.' + pad2(cs);
  }
  function fmtDelta(d) {
    if (!d || Math.abs(d) < 0.005) return '±0.00';
    return (d > 0 ? '+' : '−') + Math.abs(d).toFixed(2);
  }
  function rgbs(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* ==================================================================
   * TOUCH LAYERS — GK.pad gives us the visible thumb pad; these two
   * invisible halves widen the hit areas: drag anywhere on the left to
   * run, tap anywhere on the right to jump.
   * ================================================================== */
  var coarse = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) ||
    (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

  /* Both layers unlock on the same gestures: GK.sfx for the synth fallback,
   * AUDIO for the vendored media elements. */
  function unlockAudio() {
    GK.sfx.unlock();
    AUDIO.unlock();
  }

  function makeHalf(side) {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;top:0;bottom:0;z-index:39;touch-action:none;' +
      (side === 'l' ? 'left:0;right:50%;' : 'left:50%;right:0;');
    document.body.appendChild(d);
    return d;
  }

  function buildTouch() {
    var l = makeHalf('l');
    l.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      unlockAudio();
      tstick.active = true;
      tstick.ox = e.clientX; tstick.oy = e.clientY;
      tstick.x = 0; tstick.y = 0;
      try { l.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ }
      if (mode !== 'play') tapEdge = true;
    });
    l.addEventListener('pointermove', function (e) {
      if (!tstick.active) return;
      var x = (e.clientX - tstick.ox) / 58;
      tstick.x = Math.abs(x) < 0.16 ? 0 : GK.clamp(x, -1, 1);
      tstick.y = GK.clamp((e.clientY - tstick.oy) / 58, -1, 1);
    });
    function rel() { tstick.active = false; tstick.x = 0; tstick.y = 0; }
    l.addEventListener('pointerup', rel);
    l.addEventListener('pointercancel', rel);
    l.addEventListener('pointerleave', rel);

    var r = makeHalf('r');
    r.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      unlockAudio();
      tJump.held = true;
      if (mode === 'play') manual.pulse = true; else tapEdge = true;
    });
    function relR() { tJump.held = false; }
    r.addEventListener('pointerup', relR);
    r.addEventListener('pointercancel', relR);
  }
  if (coarse) buildTouch();

  canvas.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    unlockAudio();
    if (mode === 'play') manual.pulse = true; else tapEdge = true;
  });
  window.addEventListener('keydown', function (e) {
    unlockAudio();
    /* M is the mute toggle: GK.sfx.enabled gates both the synth cues and
     * every vendored voice, and fades the soundtrack out in AUDIO.tick. */
    if (e.key === 'm' || e.key === 'M') GK.sfx.enabled = !GK.sfx.enabled;
  });

  /* ==================================================================
   * PARTICLES AND FLOATING TEXT
   * ================================================================== */
  function spawn(x, y, vx, vy, life, size, color, kind) {
    if (parts.length > 340) parts.shift();
    parts.push({ x: x, y: y, vx: vx, vy: vy, life: life, max: life, size: size, color: color, kind: kind || 0 });
  }
  function burst(x, y, n, color, spd) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, s = spd * (0.25 + Math.random() * 0.75);
      spawn(x, y, Math.cos(a) * s, Math.sin(a) * s, 0.25 + Math.random() * 0.45,
        1.4 + Math.random() * 2.2, color, 0);
    }
  }
  function puff(x, y, n, color, dir) {
    for (var i = 0; i < n; i++) {
      var a = -Math.PI / 2 + (Math.random() - 0.5) * 1.9 + (dir || 0) * 0.5;
      var s = 30 + Math.random() * 95;
      spawn(x + (Math.random() - 0.5) * 14, y, Math.cos(a) * s * 0.5, Math.sin(a) * s * 0.6,
        0.22 + Math.random() * 0.3, 1 + Math.random() * 2, color, 0);
    }
  }
  function ring(x, y, color, r0, r1, life) {
    spawn(x, y, 0, 0, life || 0.35, r0, color, 2);
    parts[parts.length - 1].r1 = r1;
  }

  /* Landing dust: a low, spreading puff that hugs the floor and rises slightly,
   * so a heavy landing reads as contact rather than a light show. */
  function dustPuff(x, y, n, k) {
    for (var i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2 + Math.random() * 0.8;
      var s = (26 + Math.random() * 78) * (0.45 + k);
      spawn(x + Math.cos(a) * 5, y - 1.5, Math.cos(a) * s, -Math.abs(Math.sin(a)) * s * 0.30 - 8,
        0.28 + Math.random() * 0.36, 2.2 + Math.random() * 4.2, C.white, 3);
    }
  }
  function float(x, y, text, color, size) {
    floats.push({ x: x, y: y, text: text, color: color, size: size || 10, life: 0.9, max: 0.9 });
  }

  function updateParticles(dt) {
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.life -= dt;
      if (p.life <= 0) { parts.splice(i, 1); continue; }
      if (p.kind !== 2) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.kind === 3) {
          /* dust: drags hard, rises a little, and swells as it disperses */
          p.vy += 26 * dt;
          p.vx *= 0.90;
          p.size += 9 * dt;
        } else {
          p.vy += (p.kind === 1 ? 0 : 320) * dt;
          p.vx *= 0.97;
        }
      }
    }
    for (var j = floats.length - 1; j >= 0; j--) {
      var f = floats[j];
      f.life -= dt;
      f.y -= 26 * dt;
      if (f.life <= 0) floats.splice(j, 1);
    }
    shake *= Math.pow(0.00004, dt);
    if (shake < 0.15) shake = 0;
    if (shake > 0) {
      shakeX = (Math.random() - 0.5) * 2 * shake;
      shakeY = (Math.random() - 0.5) * 2 * shake;
    } else { shakeX = 0; shakeY = 0; }
    hurtFlash = Math.max(0, hurtFlash - dt * 2.4);
  }

  /* ==================================================================
   * LEVEL GENERATION
   *
   * Build the route first, decorate second. The route is a chain of
   * platforms from the spawn ledge to the exit ledge whose gaps are
   * clamped to <=136px and rises to <=66px — inside a 237px jump reach
   * with room to spare — so every room is solvable by construction and
   * decoration can never seal the path. The floor beneath is continuous
   * except for spiked pits, which are themselves <=132px wide.
   * ================================================================== */
  function genRoom(seed, idx) {
    var rng = GK.rand(((seed + (idx + 1) * 7919) * 2654435761) >>> 0);
    var diff = idx / (ROOMS - 1);          // 0..1 difficulty ramp
    var H = 720;
    var gy = H - 64;                       // floor surface
    var W = Math.round(1750 + idx * 140 + GK.rr(rng, 0, 160));
    var L = {
      idx: idx, w: W, h: H, gy: gy, rng: rng,
      solids: [], spikes: [], saws: [], lasers: [], anchors: [],
      pads: [], drifts: [], coins: [], chain: [], pits: [],
      spawn: { x: 0, y: 0 }, portal: { x: 0, y: 0, w: 34, h: 62 },
      far: [], near: [], stars: [], decor: []
    };

    /* ---------- 1. floor, with pits ---------- */
    var px = 560;
    while (px < W - 620) {
      var pw = Math.round(GK.rr(rng, 86, 86 + 44 * diff));
      L.pits.push({ x: Math.round(px), w: pw });
      px += pw + Math.round(GK.rr(rng, 380, 640 - 80 * diff));
    }

    var gx = 0, i;
    for (i = 0; i < L.pits.length; i++) {
      var pt = L.pits[i];
      if (pt.x > gx) L.solids.push({ x: gx, y: gy, w: pt.x - gx, h: H - gy, floor: true });
      L.spikes.push({ x: pt.x + 3, y: gy + 24, w: pt.w - 6, h: 30 });
      gx = pt.x + pt.w;
    }
    L.solids.push({ x: gx, y: gy, w: W - gx, h: H - gy, floor: true });
    L.solids.push({ x: 0, y: 0, w: W, h: 24, ceil: true });

    /* ---------- 2. the route ---------- */
    var cy = gy - 44;
    L.chain.push({ x: 44, y: cy, w: 200, h: 18 });
    var cx = 244;
    var steps = 5 + idx;
    for (i = 0; i < steps; i++) {
      /* 68..126px gaps, 118..186px landings, rises up to 66px. A full-speed
       * jump carries ~237px, so it always clears the gap and still lands on
       * the plate (overshoot past the lip stays under the plate width). */
      var gap = Math.round(GK.rr(rng, 68, 96 + 30 * diff));
      var rise = GK.rr(rng, -66, 50);
      if (rise < -38) gap = Math.min(gap, 92);   // steep rises keep a short gap
      var ny = GK.clamp(cy + rise, 140, gy - 104);
      var w = Math.round(GK.rr(rng, 118, 186));
      var nx = cx + gap;
      if (nx + w > W - 260) break;
      L.chain.push({ x: nx, y: ny, w: w, h: 18 });
      cx = nx + w;
      cy = ny;
    }
    /* The exit ledge is capped at one jump above the floor, so the floor is
     * always a slower (but valid) way home instead of a place to get stranded. */
    var ey = gy - 92 + Math.round(GK.rr(rng, -6, 6));
    var ex = Math.min(cx + Math.round(GK.rr(rng, 92, 130)), W - 250);
    if (ex < cx + 40) ex = cx + 40;
    var exitW = Math.max(180, W - ex - 44);
    L.chain.push({ x: ex, y: ey, w: exitW, h: 18 });

    for (i = 0; i < L.chain.length; i++) {
      var c = L.chain[i];
      L.solids.push({ x: c.x, y: c.y, w: c.w, h: c.h, plat: true });
    }
    var last = L.chain[L.chain.length - 1];
    L.portal.x = last.x + last.w - 92;
    L.portal.y = last.y - 64;
    L.spawn.x = L.chain[0].x + 72;
    L.spawn.y = L.chain[0].y - 15;

    /* ---------- 3. bonus ledges: alternative lines, coin perches ---------- */
    for (i = 1; i < L.chain.length - 1; i++) {
      var b0 = L.chain[i];
      if (rng() < 0.42) {
        var bw = Math.round(GK.rr(rng, 70, 124));
        var bx = Math.round(GK.clamp(b0.x + GK.rr(rng, -30, b0.w - 40), 30, W - bw - 30));
        var by = GK.clamp(b0.y - GK.rr(rng, 120, 162), 118, gy - 150);
        L.solids.push({ x: bx, y: by, w: bw, h: 14, ledge: true });
        if (rng() < 0.75) L.coins.push({ x: bx + bw / 2, y: by - 22, got: false, ph: rng() * 6.283 });
      }
    }

    /* ---------- 4. grapple anchors ---------- */
    for (i = 0; i < L.chain.length - 1; i++) {
      var a = L.chain[i], b = L.chain[i + 1];
      var gx0 = a.x + a.w, gx1 = b.x;
      if (gx1 - gx0 < 52) continue;
      var topY = Math.min(a.y, b.y);
      if (topY - 95 < 70) continue;
      var ayv = GK.clamp(topY - GK.rr(rng, 140, 212), 70, topY - 92);
      L.anchors.push({ x: (gx0 + gx1) / 2, y: ayv, ph: rng() * 6.283, kind: 0 });
    }
    for (i = 0; i < L.pits.length; i++) {
      if (rng() < 0.75) {
        L.anchors.push({ x: L.pits[i].x + L.pits[i].w / 2, y: GK.rr(rng, 112, 220), ph: rng() * 6.283, kind: 1 });
      }
    }
    for (var ax2 = 300; ax2 < W - 220 && L.anchors.length < 15; ax2 += GK.rr(rng, 280, 430)) {
      L.anchors.push({ x: ax2, y: GK.rr(rng, 54, 102), ph: rng() * 6.283, kind: 1 });
    }

    /* ---------- 5. hazards ---------- */
    var sawN = Math.min(4, 1 + Math.floor(idx * 0.5));
    var picked = [];
    for (i = 1; i < L.chain.length - 1 && picked.length < sawN; i++) {
      if (rng() < 0.7) picked.push(i);
    }
    for (i = 0; i < picked.length; i++) {
      var pc = L.chain[picked[i]];
      /* Saws patrol only the middle of a plate: the lips stay safe to land on,
       * so a hazard is something you read and time, never a coin flip. */
      var rad = 13 + Math.round(diff * 5);
      if (rng() < 0.62) {
        L.saws.push({
          x0: pc.x + pc.w * 0.3, y0: pc.y - rad, x1: pc.x + pc.w * 0.7, y1: pc.y - rad,
          r: rad, sp: GK.rr(rng, 0.9, 1.5), ph: rng() * 6.283, rot: 0, x: pc.x, y: pc.y
        });
      } else {
        var top = GK.clamp(pc.y - 150, 90, pc.y - 50);
        L.saws.push({
          x0: pc.x + pc.w / 2, y0: pc.y - 44, x1: pc.x + pc.w / 2, y1: top,
          r: rad, sp: GK.rr(rng, 0.7, 1.2), ph: rng() * 6.283, rot: 0, x: pc.x, y: pc.y
        });
      }
    }

    var laserN = idx === 0 ? 0 : Math.min(3, 1 + Math.floor(idx / 3));
    for (i = 0; i < laserN * 2 && i < L.chain.length - 2; i++) {
      var li = GK.ri(rng, 1, L.chain.length - 2);
      var la = L.chain[li], lb = L.chain[li + 1];
      var lgx = lb.x - (la.x + la.w);
      if (lgx < 50) continue;
      if (rng() < 0.55) {
        // vertical: hangs from the ceiling into the air over the gap - you
        // can pass underneath on the floor, or time a swing through it
        var yTop = Math.min(la.y, lb.y) - 210;
        if (yTop > 210) {
          L.lasers.push({
            x: (la.x + la.w + lb.x) / 2, y: 24, dx: 0, dy: 1, len: yTop - 24,
            period: GK.rr(rng, 2.3, 3.2), ph: rng() * 4, unit: 0
          });
        }
      } else {
        // horizontal: cuts the jump arc between two ledges
        var hy = Math.min(la.y, lb.y) - 58;
        L.lasers.push({
          x: la.x + la.w, y: hy, dx: 1, dy: 0, len: lgx,
          period: GK.rr(rng, 2.1, 3.0), ph: rng() * 4, unit: 1
        });
      }
    }

    /* ---------- 6. boost pads and drift strips ---------- */
    function addPad(ci) {
      var cpx = L.chain[ci], cnx = L.chain[Math.min(ci + 1, L.chain.length - 1)];
      var w2 = 46;
      // sit pads mid-platform, never flush with the lip: a boost needs runway
      L.pads.push({
        x: cpx.x + Math.max(10, cpx.w * 0.5 - w2 / 2), y: cpx.y - 7, w: w2, h: 7,
        dx: 1, dy: GK.clamp((cnx.y - cpx.y) / 150, -0.4, 0.4),
        cd: 0, hit: 0
      });
    }
    // the start ledge always carries one: room 1 teaches the payout rule
    addPad(0);
    var padN = 1 + Math.floor(idx / 4);
    var wide = [];
    for (i = 1; i < L.chain.length - 1; i++) if (L.chain[i].w >= 110) wide.push(i);
    for (i = 0; i < padN && wide.length; i++) {
      var pickIdx = Math.floor((i + 0.5) * wide.length / padN);
      addPad(wide[Math.min(wide.length - 1, pickIdx)]);
    }
    for (i = 0; i < L.chain.length; i++) {
      if (L.chain[i].w >= 150 && rng() < 0.6) {
        L.drifts.push({ x: L.chain[i].x + 12, y: L.chain[i].y - 5, w: L.chain[i].w - 24, h: 6 });
      }
    }

    /* ---------- 7. coins: an arc over every gap ---------- */
    for (i = 0; i < L.chain.length - 1; i++) {
      var ca = L.chain[i], cb = L.chain[i + 1];
      var x0 = ca.x + ca.w - 8, x1 = cb.x + 8;
      var base = Math.min(ca.y, cb.y) - 30;
      var apex = Math.min(ca.y, cb.y) - 108;
      for (var k = 0; k < 5; k++) {
        var u = k / 4;
        L.coins.push({
          x: GK.lerp(x0, x1, u),
          y: GK.lerp(base, apex, Math.sin(u * Math.PI)),
          got: false, ph: rng() * 6.283
        });
      }
      if (rng() < 0.5) {
        L.coins.push({ x: ca.x + ca.w / 2, y: ca.y - 32, got: false, ph: rng() * 6.283 });
      }
    }

    /* ---------- 8. backdrop silhouettes ---------- */
    for (i = 0; i < 26; i++) {
      L.far.push({
        x: rng() * (W + 500) - 250, w: GK.rr(rng, 40, 160),
        h: GK.rr(rng, 90, 430), d: GK.rr(rng, 0.1, 0.28)
      });
    }
    for (i = 0; i < 20; i++) {
      L.near.push({
        x: rng() * (W + 400) - 200, w: GK.rr(rng, 26, 110),
        h: GK.rr(rng, 60, 300), d: GK.rr(rng, 0.38, 0.6)
      });
    }
    for (i = 0; i < 90; i++) {
      L.stars.push({ x: rng() * W, y: rng() * (H - 220), s: GK.rr(rng, 0.6, 1.9), a: GK.rr(rng, 0.14, 0.55) });
    }

    /* ---------- 9. vendored set dressing ----------
     * Two kinds of pure decoration, both from the Shattered Pixel Dungeon
     * sheets: creatures drifting in the parallax strata, and a stone sentinel
     * standing on the odd wide plate. Nothing here enters solids, hazards or
     * pickups, and every piece is culled once it leaves the view, so the
     * route stays exactly as generated above. */
    if (SPR.enabled()) {
      /* The camera only ever sees a ~200-unit window, and parallax squeezes
       * it further, so decoration is laid out across the band it can actually
       * reach (W * d + the view) instead of the full room width. */
      var band = Math.round(W * 0.45) + 160;
      var nw = 12 + Math.round(rng() * 5);
      for (i = 0; i < nw && SPR.has('wisp'); i++) {
        L.decor.push({
          k: 'wisp', x: 40 + rng() * band, y: GK.rr(rng, 60, 430), d: GK.rr(rng, 0.12, 0.3),
          ph: rng() * 12, amp: GK.rr(rng, 12, 44), sp: GK.rr(rng, 0.1, 0.26)
        });
      }
      for (i = 0; i < 4 && SPR.has('eye'); i++) {
        L.decor.push({
          k: 'eye', x: 40 + rng() * band, y: GK.rr(rng, 90, 340), d: GK.rr(rng, 0.16, 0.34),
          ph: rng() * 12, amp: GK.rr(rng, 18, 58), sp: GK.rr(rng, 0.07, 0.2)
        });
      }
      /* sentinels: only on a clean plate — no pad, drift strip, saw, laser or
       * exit — and inset from the lips, so it never sits on a mechanic the
       * player has to read (a statue over a drift chevron reads as debris) */
      if (SPR.has('golem')) {
        var sentinels = 0;
        for (i = 1; i < L.chain.length - 1 && sentinels < 2; i++) {
          var sc0 = L.chain[i];
          if (sc0.w < 140 || (sentinels > 0 && rng() < 0.35)) continue;
          var busy = false, q;
          for (q = 0; q < L.pads.length; q++) {
            if (sc0.x < L.pads[q].x + L.pads[q].w && sc0.x + sc0.w > L.pads[q].x) busy = true;
          }
          for (q = 0; q < L.drifts.length; q++) {
            if (sc0.x < L.drifts[q].x + L.drifts[q].w && sc0.x + sc0.w > L.drifts[q].x) busy = true;
          }
          for (q = 0; q < L.saws.length; q++) {
            if (sc0.x < L.saws[q].x1 + 40 && sc0.x + sc0.w > L.saws[q].x0 - 40) busy = true;
          }
          for (q = 0; q < L.lasers.length; q++) {
            if (sc0.x < L.lasers[q].x + 30 && sc0.x + sc0.w > L.lasers[q].x - 30) busy = true;
          }
          if (Math.abs(sc0.x - L.portal.x) < 140) busy = true;
          if (busy) continue;
          L.decor.push({
            k: 'golem', x: Math.round(sc0.x + sc0.w * (rng() < 0.5 ? 0.24 : 0.76)),
            y: sc0.y, d: 1, ph: rng() * 12
          });
          sentinels++;
        }
      }
    }

    return L;
  }

  /* ==================================================================
   * RUN LIFECYCLE
   * ================================================================== */
  function startRun() {
    unlockAudio();
    run = {
      seed: (Math.random() * 4294967296) >>> 0,
      room: 0, time: 0, roomTime: 0,
      deaths: 0, coins: 0, score: 0,
      samples: [], splits: [], sampleT: 0
    };
    mode = 'play';
    screenT = 0;
    result = null;
    parts.length = 0;
    floats.length = 0;
    buildRoom(0);
    AUDIO.play('jump');
  }

  function buildRoom(i) {
    run.room = i;
    run.roomTime = 0;
    run.samples.length = 0;
    run.sampleT = 0;
    level = genRoom(run.seed, i);
    ghostSamples = best.ghosts[i] && best.ghosts[i].length > 1 ? best.ghosts[i] : null;
    respawn(true);
    roomIntro = 1.1;
    ring(level.spawn.x, level.spawn.y, C.mint, 4, 52, 0.55);
    puff(level.spawn.x, level.spawn.y, 10, C.mint, 0);
  }

  function respawn(snap) {
    P.x = level.spawn.x; P.y = level.spawn.y;
    P.vx = 0; P.vy = 0;
    P.onGround = false; P.coyote = 0; P.jumpBuf = 0; P.jumped = false;
    P.wallDir = 0; P.wallT = 0; P.wallLock = 0;
    P.sx = 0.55; P.sy = 1.55; P.spawnT = 0.3;
    P.trail.length = 0;
    hook.on = false; hook.len = 0; hook.cd = 0.12;
    boost.mult = 1; boost.t = 0; boost.drift = 0;
    for (var i = 0; i < level.pads.length; i++) level.pads[i].cd = 0;
    if (snap) snapCamera(); else updateCamera(1 / 60);
  }

  function die() {
    if (mode !== 'play') return;
    run.deaths++;
    AUDIO.play('death');
    GK.buzz(18);
    shake = Math.max(shake, 15);
    hurtFlash = 1;
    burst(P.x, P.y, 26, C.red, 320);
    ring(P.x, P.y, C.red, 5, 46, 0.4);
    float(P.x, P.y - 20, '✕', C.red, 20);
    run.samples.length = 0;
    run.sampleT = 0;
    respawn(true);
  }

  function clearRoom() {
    if (mode !== 'play') return;
    var i = run.room, t = run.roomTime;
    var pb = best.rooms[i] || 0;
    var rec = !pb || t < pb;
    run.splits.push({ t: t, best: pb, rec: rec });
    if (rec) {
      best.rooms[i] = Math.round(t * 1000) / 1000;
      if (run.samples.length > 2) best.ghosts[i] = run.samples.slice(0, 420);
      store.set('roomBest', best.rooms);
      store.set('ghosts', best.ghosts);
    }
    AUDIO.play('clear');
    GK.buzz(12);
    burst(level.portal.x + 17, level.portal.y + 30, 22, C.mint, 240);
    shake = Math.max(shake, 4);
    /* hold on a split card so you can see the gap to your best */
    clearCard = { room: i, t: t, best: pb, rec: rec, last: i >= ROOMS - 1 };
    mode = 'roomClear';
    screenT = 0;
  }

  /* leave the split card: next room, or the run report after room nine */
  function continueRun() {
    if (mode !== 'roomClear' || !clearCard) return;
    var card = clearCard;
    clearCard = null;
    if (card.last) { finishRun(); return; }
    mode = 'play';
    screenT = 0;
    buildRoom(card.room + 1);
  }

  function finishRun() {
    var total = run.time;
    var g = gradeFor(total, run.deaths);
    var pb = best.total;
    var isPb = !pb || total < pb;
    if (isPb) {
      best.total = Math.round(total * 1000) / 1000;
      best.deaths = run.deaths;
      store.set('bestTime', best.total);
      store.set('bestDeaths', run.deaths);
    }
    store.set('runs', (Number(store.get('runs', 0)) || 0) + 1);
    result = {
      total: total, deaths: run.deaths, grade: g,
      pb: isPb, prevPb: pb, coins: run.coins,
      score: run.score, splits: run.splits.slice(), seed: run.seed
    };
    mode = 'results';
    screenT = 0;
    parts.length = 0;
    AUDIO.play('finish');
    GK.buzz(24);
  }

  function gradeFor(t, d) {
    var eff = t + d * 3;
    if (eff <= 122) return 'S';
    if (eff <= 150) return 'A';
    if (eff <= 196) return 'B';
    return 'C';
  }

  /* ==================================================================
   * CAMERA — smoothed follow with velocity look-ahead
   * ================================================================== */
  function camTarget() {
    var vw = view.w / zoom, vh = view.h / zoom;
    var tx = P.x + GK.clamp(P.vx * 0.28, -130, 150) - vw * 0.42;
    var ty = P.y + GK.clamp(P.vy * 0.11, -60, 90) - vh * 0.56;
    tx = GK.clamp(tx, 0, Math.max(0, level.w - vw));
    ty = GK.clamp(ty, 0, Math.max(0, level.h - vh));
    return { x: tx, y: ty };
  }
  function updateCamera(dt) {
    var t = camTarget();
    var k = 1 - Math.pow(0.0009, dt);
    cam.x += (t.x - cam.x) * k;
    cam.y += (t.y - cam.y) * k;
  }
  function snapCamera() {
    var t = camTarget();
    cam.x = t.x; cam.y = t.y;
  }

  /* ==================================================================
   * INPUT READ
   * ================================================================== */
  function gatherInput() {
    var x = tstick.active ? tstick.x : pad.state.x;
    if (manual.x !== 0) x = manual.x;
    input.x = GK.clamp(x, -1, 1);
    input.jump = !!(pad.state.jump || manual.jump || tJump.held);
    input.hook = !!(pad.state.hook || pad.state.dash || pad.state.use || manual.hook);
    if (input.x > 0.18) P.face = 1;
    else if (input.x < -0.18) P.face = -1;
  }

  function aimVec() {
    var ax = input.x !== 0 ? input.x : P.face * 0.85;
    var sy = pad.state.y;
    var ay = -1.05 - Math.min(0, sy) * 0.9;
    if (sy > 0.45) ay = -0.3;                 // stick down: a flat, forward shot
    var l = Math.sqrt(ax * ax + ay * ay) || 1;
    return { x: ax / l, y: ay / l };
  }

  function findAnchor() {
    var aim = aimVec();
    var bx = null, best = -1e9;
    for (var i = 0; i < level.anchors.length; i++) {
      var a = level.anchors[i];
      var dx = a.x - P.x, dy = a.y - P.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d > HOOK_RANGE || d < 26) continue;
      var nx = dx / d, ny = dy / d;
      var dot = nx * aim.x + ny * aim.y;
      if (dot < HOOK_CONE) continue;
      var s = dot * 2.4 + (1 - d / HOOK_RANGE) * 1.1;
      if (s > best) { best = s; bx = a; }
    }
    return bx;
  }

  function fireHook() {
    var a = findAnchor();
    if (!a) { hook.cd = 0.13; hook.miss = 0.2; return; }
    hook.on = true;
    hook.ax = a.x; hook.ay = a.y;
    hook.len = GK.clamp(Math.sqrt((a.x - P.x) * (a.x - P.x) + (a.y - P.y) * (a.y - P.y)), HOOK_MIN_LEN + 22, HOOK_RANGE + 40);
    hook.t = 0;
    if (P.vy > 0) P.vy = Math.min(P.vy * 0.4, 130);   // the rope catches the fall
    P.vy -= HOOK_GRAB_KICK;
    AUDIO.play('hook');
    GK.buzz(6);
    puff(P.x, P.y, 5, C.mint, 0);
    ring(P.x, P.y, C.mint, 3, 14, 0.2);
  }

  function releaseHook() {
    if (!hook.on) return;
    hook.on = false;
    hook.cd = 0.05;
    var sp = Math.sqrt(P.vx * P.vx + P.vy * P.vy);
    if (sp < 200) P.vy -= HOOK_RELEASE_V;     // a hop off a dead-hang, never a boost
    AUDIO.play('release');
    ring(P.x, P.y - 6, C.mint, 2, 12, 0.18);
  }

  function grappleInput(dt) {
    hook.cd = Math.max(0, hook.cd - dt);
    if (hook.miss > 0) hook.miss -= dt;
    if (hook.on) {
      if (!input.hook) { releaseHook(); }
      else {
        hook.t += dt;
        var reel = HOOK_REEL * (P.onGround ? 0.35 : 1);
        hook.len = Math.max(HOOK_MIN_LEN, hook.len - reel * dt);
      }
    } else if (input.hook && !prevHook && hook.cd <= 0) {
      fireHook();
    }
    prevHook = input.hook;
  }

  /* ==================================================================
   * THE STEP
   * ================================================================== */
  function step(dt) {
    run.time += dt;
    run.roomTime += dt;
    roomIntro = Math.max(0, roomIntro - dt);
    P.spawnT = Math.max(0, P.spawnT - dt);
    if (hook.miss > 0) hook.miss -= dt;
    animTick(dt);

    gatherInput();

    /* ---- timers ---- */
    P.coyote = P.onGround ? COYOTE_TIME : Math.max(0, P.coyote - dt);
    P.jumpBuf = Math.max(0, P.jumpBuf - dt);
    if (input.jump && !prevJump) P.jumpBuf = JUMP_BUFFER;
    prevJump = input.jump;
    if (manual.pulse) { P.jumpBuf = JUMP_BUFFER; manual.pulse = false; }
    if (P.wallLock > 0) P.wallLock = Math.max(0, P.wallLock - dt);

    grappleInput(dt);

    var dir = P.wallLock > 0 ? input.x * 0.12 : input.x;
    var cap = MAX_RUN * boost.mult;

    /* ---- horizontal: accelerate toward the cap, never crush overspeed ---- */
    if (dir !== 0) {
      var turn = (P.vx * dir < 0) ? TURN_MUL : 1;
      var acc = (P.onGround ? ACCEL_GROUND : ACCEL_AIR) * turn * (hook.on ? HOOK_AIR_MUL : 1);
      if (P.vx * dir < cap) {
        P.vx = approach(P.vx, dir * cap, acc * dt);
      } else {
        var bleed = (P.onGround ? 640 : 120) * (boost.t > 0 ? 0 : 1);
        P.vx = approach(P.vx, dir * cap, bleed * dt);
      }
    } else {
      var fr = (P.onGround ? FRICTION_GROUND : DRAG_AIR) * dt;
      if (hook.on) fr *= 0.45;
      P.vx = approach(P.vx, 0, fr);
    }

    /* ---- jump: buffered, coyote-tolerant, wall-kickable ---- */
    if (P.jumpBuf > 0) {
      if (P.onGround || P.coyote > 0) {
        P.vy = -JUMP_VEL;
        P.jumped = true; P.jumpCut = false;
        P.onGround = false; P.coyote = 0; P.jumpBuf = 0;
        P.sx = 0.74; P.sy = 1.3;
        puff(P.x, P.y + P.hh, 7, C.mint, 0);
        ring(P.x, P.y + P.hh, C.mint, 3, 17, 0.24);
        AUDIO.play('jump');
        GK.buzz(6);
      } else if (P.wallT > 0 && P.wallDir !== 0) {
        P.vx = -P.wallDir * WALL_JUMP_X;
        P.vy = -WALL_JUMP_Y;
        P.wallLock = WALL_JUMP_LOCK;
        P.jumpBuf = 0; P.jumped = true; P.jumpCut = false;
        P.sx = 0.8; P.sy = 1.26;
        P.face = P.vx > 0 ? 1 : -1;
        puff(P.x - P.wallDir * P.hw, P.y, 6, C.white, P.wallDir);
        AUDIO.play('jump');
      }
    }

    /* ---- variable jump height: let go early, hop lower ---- */
    if (P.jumped && !input.jump && P.vy < -140 && !P.jumpCut) {
      P.vy *= JUMP_CUT;
      P.jumpCut = true;
    }

    /* ---- gravity: light while rising under a held jump, heavy falling ---- */
    var g = GRAVITY;
    if (P.vy < 0 && input.jump) g = GRAVITY_RISE;
    else if (P.vy > 0) g = GRAVITY_FALL;
    if (hook.on) g *= HOOK_GRAV_MUL;
    P.vy += g * dt;
    if (P.vy > MAX_FALL) P.vy = MAX_FALL;

    /* ---- wall slide ---- */
    if (!P.onGround && P.wallDir !== 0 && P.vy > WALL_SLIDE_MAX && !hook.on) {
      P.vy = approach(P.vy, WALL_SLIDE_MAX, 3000 * dt);
      if (Math.random() < 0.3) {
        spawn(P.x - P.wallDir * P.hw, P.y + (Math.random() - 0.5) * 16,
          -P.wallDir * 22, -26, 0.28, 1.4, C.dim, 0);
      }
    }

    moveAndCollide(dt);
    ropeConstraint();
    padTick(dt);
    hazardTick();
    updateCamera(dt);
    updateParticles(dt);

    /* ---- squash eases home ---- */
    var k2 = 1 - Math.pow(0.00005, dt);
    P.sx = GK.lerp(P.sx, 1, k2);
    P.sy = GK.lerp(P.sy, 1, k2);

    /* ---- trail samples for the motion streak ---- */
    P.trail.push({ x: P.x, y: P.y, a: 1 });
    if (P.trail.length > 10) P.trail.shift();

    /* ---- running dust ---- */
    if (P.onGround && Math.abs(P.vx) > 260 && Math.random() < 0.4) {
      spawn(P.x - Math.sign(P.vx) * 7, P.y + P.hh - 1,
        -P.vx * 0.1, -14 - Math.random() * 22, 0.3, 1.3, C.dim, 0);
    }

    recordGhost(dt);
    hook.preview = hook.on ? null : findAnchor();
  }

  /* ==================================================================
   * COLLISION
   * ================================================================== */
  function moveAndCollide(dt) {
    var i, s, b, hitWall = 0;

    /* horizontal pass */
    P.x += P.vx * dt;
    for (i = 0; i < level.solids.length; i++) {
      s = level.solids[i];
      if (!overlap(P.x - P.hw, P.y - P.hh, P.hw * 2, P.hh * 2, s.x, s.y, s.w, s.h)) continue;
      if (P.vx > 0) { P.x = s.x - P.hw; hitWall = 1; }
      else if (P.vx < 0) { P.x = s.x + s.w + P.hw; hitWall = -1; }
      else {
        if (P.x < s.x + s.w / 2) { P.x = s.x - P.hw; hitWall = 1; }
        else { P.x = s.x + s.w + P.hw; hitWall = -1; }
      }
      P.vx = 0;
    }

    /* vertical pass */
    var wasGround = P.onGround;
    P.onGround = false;
    P.y += P.vy * dt;
    for (i = 0; i < level.solids.length; i++) {
      s = level.solids[i];
      if (!overlap(P.x - P.hw, P.y - P.hh, P.hw * 2, P.hh * 2, s.x, s.y, s.w, s.h)) continue;
      if (P.vy >= 0) {
        var impact = P.vy;
        P.y = s.y - P.hh;
        P.vy = 0;
        P.onGround = true;
        if (!wasGround) onLand(impact);
      } else {
        P.y = s.y + s.h + P.hh;
        P.vy = 0;
        if (!P.wallLock) shake = Math.max(shake, 1.2);
      }
    }
    if (wasGround && !P.onGround) P.coyote = COYOTE_TIME;

    /* wall memory: a wall stays "jumpable off" for 120ms */
    if (hitWall !== 0 && !P.onGround) { P.wallDir = hitWall; P.wallT = 0.12; }
    else if (P.wallT > 0) { P.wallT = Math.max(0, P.wallT - dt); if (P.wallT === 0) P.wallDir = 0; }
    if (P.onGround) { P.wallDir = 0; P.wallT = 0; }
  }

  function onLand(impact) {
    var k = GK.clamp(impact / 900, 0.12, 1);
    P.sx = 1 + 0.38 * k;
    P.sy = 1 - 0.28 * k;
    P.jumped = false;
    anim.land = k;
    puff(P.x, P.y + P.hh, 3 + Math.round(5 * k), C.white, 0);
    dustPuff(P.x, P.y + P.hh, 4 + Math.round(9 * k), k);
    if (impact > 430) {
      /* hard landing: reuse the existing camera shake, scaled by impact */
      shake = Math.max(shake, 2.4 * k + 1.2);
      AUDIO.play('land');
      ring(P.x, P.y + P.hh, C.mint, 2, 12 + 18 * k, 0.24);
    }
  }

  /* --- rope maths -----------------------------------------------------
   * The player is a point p with velocity v; a hook is an anchor a and a
   * rest length L. Each step:
   *
   *   1. gravity and (reduced) air control are integrated into v;
   *   2. p moves by v*dt and collides with the world;
   *   3. the rope is a rigid constraint that can PULL but never PUSH:
   *        d = p − a ; len = |d|
   *        if (len > L) { p = a + (d/len)·L ; vr = v · (d/len) ;
   *                       if (vr > 0) v −= (d/len)·vr ; }
   *      Only the outward radial component is removed. The tangential
   *      component survives untouched — that is the swing.
   *   4. reeling shortens L. Because the length constraint is solved
   *      positionally and then radially projected, shortening L turns
   *      into tangential speed for free: angular momentum falls out of
   *      the projection instead of being hand-simulated.
   *   5. release never touches v, so every bit of the swing is kept.
   * ------------------------------------------------------------------- */
  function ropeConstraint() {
    if (!hook.on) return;
    var dx = P.x - hook.ax, dy = P.y - hook.ay;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.001) return;
    if (len > hook.len) {
      var nx = dx / len, ny = dy / len;
      P.x = hook.ax + nx * hook.len;
      P.y = hook.ay + ny * hook.len;
      var vr = P.vx * nx + P.vy * ny;
      if (vr > 0) {
        P.vx -= nx * vr;
        P.vy -= ny * vr;
        if (vr > 360) shake = Math.max(shake, GK.clamp(vr / 110, 1, 5));
      }
    }
  }

  /* ==================================================================
   * BOOSTS AND DRIFT
   * ================================================================== */
  function padTick(dt) {
    var b = pbox(), drifting = false, i, p0;

    for (i = 0; i < level.pads.length; i++) {
      p0 = level.pads[i];
      if (p0.cd > 0) p0.cd -= dt;
      p0.hit *= 0.9;
      if (!overlap(b.x, b.y + 4, b.w, b.h, p0.x, p0.y - 5, p0.w, p0.h + 9)) continue;
      if (p0.cd > 0) continue;
      if (Math.abs(P.vx) < BOOST_MIN_SPEED) {
        p0.hit = -0.7;                       // arrived slow: dead pad, no payout
        continue;
      }
      p0.cd = 0.55;
      p0.hit = 1;
      boost.mult = Math.min(BOOST_MAX, boost.mult + BOOST_GAIN);
      boost.t = 0.85;
      var pow = BOOST_IMPULSE * (0.7 + 0.3 * boost.mult);
      P.vx += p0.dx * pow;
      P.vy += p0.dy * pow * 0.85;
      var ceilV = MAX_RUN * boost.mult + BOOST_CEIL;
      if (P.vx > ceilV) P.vx = ceilV;
      if (P.vx < -ceilV) P.vx = -ceilV;
      if (P.vy < -ceilV * 0.8) P.vy = -ceilV * 0.8;
      AUDIO.play('boost');
      GK.buzz(14);
      burst(p0.x + p0.w / 2, p0.y, 14, C.gold, 260);
      ring(p0.x + p0.w / 2, p0.y, C.gold, 6, 34, 0.3);
      shake = Math.max(shake, 3.4);
      float(P.x, P.y - 26, '×' + boost.mult.toFixed(1), C.gold, 11);
    }

    for (i = 0; i < level.drifts.length; i++) {
      var d0 = level.drifts[i];
      if (!P.onGround) continue;
      if (!overlap(b.x, b.y + 2, b.w, b.h, d0.x, d0.y - 8, d0.w, d0.h + 16)) continue;
      if (Math.abs(P.vx) < 190) continue;
      drifting = true;
      boost.mult = Math.min(BOOST_MAX, boost.mult + BOOST_GAIN * 0.5 * dt);
      if (Math.random() < 0.4) {
        spawn(P.x + (Math.random() - 0.5) * 16, P.y + P.hh, -P.vx * 0.14, -20, 0.3, 1.6, C.gold, 0);
      }
    }

    boost.drift = drifting ? 1 : 0;
    if (!drifting) boost.mult = Math.max(1, boost.mult - BOOST_DECAY * (boost.t > 0 ? 0.3 : 1) * dt);
    boost.t = Math.max(0, boost.t - dt);
    if (boost.mult < 1.02) boost.mult = 1;
  }

  /* ==================================================================
   * HAZARDS, PICKUPS, EXIT
   * ================================================================== */
  function laserFiring(z) {
    var cyc = (clock * 0.9 + z.ph) % z.period;
    return cyc > 1.05 && cyc < 1.62;
  }

  function hazardTick() {
    var b = pbox(), i, h, s;

    for (i = 0; i < level.spikes.length; i++) {
      h = level.spikes[i];
      if (overlap(b.x + 1, b.y + 1, b.w - 2, b.h - 2, h.x, h.y + 10, h.w, h.h - 10)) { die(); return; }
    }

    for (i = 0; i < level.saws.length; i++) {
      s = level.saws[i];
      var k = (Math.sin(clock * s.sp + s.ph) + 1) * 0.5;
      s.x = GK.lerp(s.x0, s.x1, k);
      s.y = GK.lerp(s.y0, s.y1, k);
      s.rot += 0.19;
      if (circRect(s.x, s.y, s.r - 2, b.x, b.y, b.w, b.h)) { die(); return; }
    }

    for (i = 0; i < level.lasers.length; i++) {
      var z = level.lasers[i];
      if (!laserFiring(z)) continue;
      var rx = z.dx ? z.x : z.x - 3;
      var ry = z.dy ? z.y - 3 : z.y;
      var rw = z.dx ? z.len : 6;
      var rh = z.dy ? z.len : 6;
      if (overlap(b.x, b.y, b.w, b.h, rx, ry, rw, rh)) { die(); return; }
    }

    for (i = 0; i < level.coins.length; i++) {
      var c = level.coins[i];
      if (c.got) continue;
      var dx = c.x - P.x, dy = c.y - P.y;
      if (dx * dx + dy * dy > 27 * 27) continue;
      c.got = true;
      run.coins++;
      run.score += 10;
      AUDIO.play('coin');
      burst(c.x, c.y, 7, C.gold, 110);
      ring(c.x, c.y, C.gold, 3, 17, 0.26);
    }

    var pr = level.portal;
    if (overlap(b.x, b.y, b.w, b.h, pr.x, pr.y, pr.w, pr.h)) { clearRoom(); return; }
    if (P.y > level.h + 70) die();
  }

  function recordGhost(dt) {
    run.sampleT += dt;
    if (run.sampleT < 0.06) return;
    run.sampleT -= 0.06;
    run.samples.push([
      Math.round(run.roomTime * 100) / 100,
      Math.round(P.x),
      Math.round(P.y)
    ]);
    if (run.samples.length > 420) run.samples.shift();
  }

  /* ==================================================================
   * DRAWING PRIMITIVES
   * ================================================================== */
  function rr2(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
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

  function spacedText(ctx, text, cx, y, spacing) {
    var i, total = 0;
    for (i = 0; i < text.length; i++) total += ctx.measureText(text.charAt(i)).width + spacing;
    total -= spacing;
    var x = cx - total / 2;
    for (i = 0; i < text.length; i++) {
      ctx.fillText(text.charAt(i), x, y);
      x += ctx.measureText(text.charAt(i)).width + spacing;
    }
  }

  function chevron(ctx, x, y, dir) {
    ctx.beginPath();
    ctx.moveTo(x - 4 * dir, y - 5);
    ctx.lineTo(x + 2 * dir, y);
    ctx.lineTo(x - 4 * dir, y + 5);
    ctx.stroke();
  }

  /* ==================================================================
   * BACKDROP — three parallax bands of silhouetted structures + dust
   *
   * Everything is generated once per room and reused every frame; the draw
   * path allocates nothing (no arrays, no objects, no gradients).
   * ================================================================== */
  var BG = { far: [], mid: [], near: [], dust: [], level: null, span: 4000 };

  function bgBuild() {
    var rng = GK.rand(((run ? run.seed : 1) + level.idx * 977) >>> 0);
    var span = BG.span, i, n;
    BG.far.length = 0; BG.mid.length = 0; BG.near.length = 0; BG.dust.length = 0;

    /* band 1 — thin spires, the far skyline */
    n = Math.round(span / 44);
    for (i = 0; i < n; i++) {
      BG.far.push({
        x: i * 44 + GK.rr(rng, -10, 10),
        w: 5 + Math.round(GK.rr(rng, 0, 11)),
        h: 96 + Math.round(GK.rr(rng, 0, 330)),
        d: 0.055 + GK.rr(rng, 0, 0.025)
      });
    }

    /* band 2 — broken ruins with a stepped, crenellated top */
    n = Math.round(span / 132);
    for (i = 0; i < n; i++) {
      BG.mid.push({
        x: i * 132 + GK.rr(rng, -26, 26),
        w: 32 + Math.round(GK.rr(rng, 0, 52)),
        h: 52 + Math.round(GK.rr(rng, 0, 104)),
        step: 7 + Math.round(GK.rr(rng, 0, 15)),
        win: Math.round(GK.rr(rng, 1, 3)),
        d: 0.13 + GK.rr(rng, 0, 0.05)
      });
    }

    /* band 3 — near masses, the darkest and the slowest */
    n = Math.round(span / 268);
    for (i = 0; i < n; i++) {
      BG.near.push({
        x: i * 268 + GK.rr(rng, -40, 40),
        w: 92 + Math.round(GK.rr(rng, 0, 150)),
        h: 34 + Math.round(GK.rr(rng, 0, 74)),
        d: 0.24 + GK.rr(rng, 0, 0.07)
      });
    }

    /* band 4 — fine dust motes, screen-space but parallaxed like the near band */
    for (i = 0; i < 130; i++) {
      BG.dust.push({
        x: rng(), y: rng(),
        s: rng() < 0.72 ? 1 : 2,
        sp: 2 + rng() * 9,
        a: 0.05 + rng() * 0.18,
        ph: rng() * 6.283
      });
    }
    BG.level = level;
  }

  function drawBackdrop(ctx, v) {
    if (BG.level !== level) bgBuild();

    var g = ctx.createLinearGradient(0, 0, 0, v.h);
    g.addColorStop(0, '#05060c');
    g.addColorStop(0.46, '#090b13');
    g.addColorStop(1, '#0b1220');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, v.w, v.h);

    var hy = (level.gy - cam.y) * zoom;
    var base = hy + 34 * zoom;
    var i, sx, sy, b, wx;
    var span = BG.span;

    /* horizon bloom */
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var hg = ctx.createRadialGradient(v.w * 0.5, base, 8, v.w * 0.5, base, v.w * 0.62);
    hg.addColorStop(0, 'rgba(90,169,255,0.075)');
    hg.addColorStop(1, 'rgba(90,169,255,0)');
    ctx.fillStyle = hg;
    ctx.fillRect(0, base - v.h * 0.55, v.w, v.h);
    ctx.restore();

    /* stars, above the horizon only */
    for (i = 0; i < level.stars.length; i++) {
      var s = level.stars[i];
      sx = (s.x - cam.x * 0.06) * zoom;
      sy = (s.y - cam.y * 0.06) * zoom;
      if (sx < -10 || sx > v.w + 10 || sy < -10 || sy > Math.min(v.h, base)) continue;
      ctx.fillStyle = 'rgba(180,215,255,' + (s.a * (0.35 + 0.5 * Math.sin(clock * 1.2 + s.x))) + ')';
      ctx.fillRect(sx, sy, s.s, s.s);
    }

    /* ---- band 1: far spires, near-flat silhouettes ---- */
    for (i = 0; i < BG.far.length; i++) {
      b = BG.far[i];
      wx = b.x - cam.x * b.d;
      wx = wx % span; if (wx < 0) wx += span;
      sx = (wx - 300) * zoom;
      var bw = b.w * zoom, bh = b.h * zoom;
      if (sx > v.w + 50 || sx + bw < -50) continue;
      ctx.fillStyle = 'rgba(38,52,78,0.94)';
      ctx.fillRect(sx, base - bh, bw, bh + 2);
      /* air lit on the upper third: value change sells the distance */
      ctx.fillStyle = 'rgba(62,82,120,0.55)';
      ctx.fillRect(sx, base - bh, bw, bh * 0.32);
      /* a needle top so it reads as a spire, not a bar */
      ctx.fillRect(sx + bw * 0.35, base - bh - 7 * zoom, Math.max(1, bw * 0.32), 9 * zoom);
      ctx.fillStyle = 'rgba(150,200,255,0.10)';
      ctx.fillRect(sx, base - bh, bw, 1);
    }

    /* drifting creatures behind the near strata */
    drawDecorSky(ctx, v, 0, 0.37);

    /* ---- band 2: ruins with stepped tops and window slits ---- */
    for (i = 0; i < BG.mid.length; i++) {
      b = BG.mid[i];
      wx = b.x - cam.x * b.d;
      wx = wx % span; if (wx < 0) wx += span;
      sx = (wx - 300) * zoom;
      var mw = b.w * zoom, mh = b.h * zoom;
      if (sx > v.w + 60 || sx + mw < -60) continue;
      var top = base - mh;
      ctx.fillStyle = 'rgba(27,38,58,0.96)';
      ctx.fillRect(sx, top, mw, mh + 2);
      /* stepped crown: two shoulders at different heights */
      ctx.fillRect(sx - 3 * zoom, top + mh * 0.18, Math.max(2, mw * 0.26), mh * 0.82);
      ctx.fillRect(sx + mw * 0.62, top - 6 * zoom, Math.max(2, mw * 0.3), mh + 6 * zoom);
      /* window slits, lit very faintly from inside */
      ctx.fillStyle = 'rgba(124,245,208,0.05)';
      for (var k = 0; k < b.win; k++) {
        ctx.fillRect(sx + mw * (0.22 + k * 0.26), top + mh * 0.3, Math.max(1, 2 * zoom), Math.max(2, 5 * zoom));
      }
      /* rim on the lit edge */
      ctx.fillStyle = 'rgba(150,200,255,0.07)';
      ctx.fillRect(sx, top, Math.max(1, mw), 1);
    }

    /* ---- band 3: near masses, deepest silhouette ---- */
    for (i = 0; i < BG.near.length; i++) {
      b = BG.near[i];
      wx = b.x - cam.x * b.d;
      wx = wx % span; if (wx < 0) wx += span;
      sx = (wx - 300) * zoom;
      var nw = b.w * zoom, nh = b.h * zoom;
      if (sx > v.w + 80 || sx + nw < -80) continue;
      ctx.fillStyle = 'rgba(9,14,24,0.97)';
      ctx.fillRect(sx, base - nh, nw, nh + 2);
      /* chipped top: a notch out of the middle third */
      ctx.fillStyle = 'rgba(31,43,66,0.96)';
      ctx.fillRect(sx + nw * 0.42, base - nh, nw * 0.16, 3 * zoom);
      ctx.fillStyle = 'rgba(124,245,208,0.06)';
      ctx.fillRect(sx, base - nh, nw, 1);
    }

    /* a cone of rift-light rising off the far end of the hall: gives the eye
     * something to travel toward and fills the empty sky above the horizon */
    var cls = (level.portal.x + level.portal.w / 2 - cam.x * 0.8) * zoom;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var cg = ctx.createLinearGradient(0, base - v.h * 0.85, 0, base);
    cg.addColorStop(0, 'rgba(124,245,208,0)');
    cg.addColorStop(0.65, 'rgba(124,245,208,0.030)');
    cg.addColorStop(1, 'rgba(124,245,208,0.075)');
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.moveTo(cls - 54, base + 4);
    ctx.lineTo(cls - 16, base - v.h * 0.85);
    ctx.lineTo(cls + 16, base - v.h * 0.85);
    ctx.lineTo(cls + 54, base + 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    /* light raking in from the upper right: one clear light direction makes
     * the whole frame read as lit volume instead of flat ambient fill */
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (i = 0; i < 3; i++) {
      var ox = v.w * (0.52 + i * 0.15) + Math.sin(clock * 0.19 + i) * 12;
      var sw = 22 + i * 14;
      var lg = ctx.createLinearGradient(ox, 0, ox - 90, base);
      lg.addColorStop(0, 'rgba(148,236,255,' + (0.055 - i * 0.013) + ')');
      lg.addColorStop(1, 'rgba(148,236,255,0)');
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.moveTo(ox, -10);
      ctx.lineTo(ox + sw, -10);
      ctx.lineTo(ox + sw - 130, base + 10);
      ctx.lineTo(ox - 130, base + 10);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    /* haze: two soft banks of air hanging between the strata */
    for (i = 0; i < 2; i++) {
      var fy = base - (i === 0 ? 168 : 84) * zoom + Math.sin(clock * 0.22 + i * 2.1) * 9;
      var fg = ctx.createLinearGradient(0, fy - 80, 0, fy + 80);
      fg.addColorStop(0, 'rgba(96,172,255,0)');
      fg.addColorStop(0.5, 'rgba(96,172,255,' + (i === 0 ? 0.05 : 0.065) + ')');
      fg.addColorStop(1, 'rgba(96,172,255,0)');
      ctx.fillStyle = fg;
      ctx.fillRect(0, fy - 80, v.w, 160);
    }

    /* ---- dust: fine motes, always in motion, never spawned per frame ---- */
    for (i = 0; i < BG.dust.length; i++) {
      var d = BG.dust[i];
      var dx = d.x * v.w + clock * d.sp - cam.x * 0.24 * zoom;
      dx = dx % v.w; if (dx < 0) dx += v.w;
      var dy = d.y * v.h + Math.sin(clock * 0.5 + d.ph) * 7 - cam.y * 0.12 * zoom;
      dy = dy % v.h; if (dy < 0) dy += v.h;
      ctx.fillStyle = 'rgba(178,212,245,' + d.a + ')';
      ctx.beginPath();
      ctx.arc(dx, dy, d.s * 0.65, 0, 6.2832);
      ctx.fill();
    }

    /* the rift floor line, where the strata meet the ground */
    ctx.strokeStyle = 'rgba(124,245,208,0.085)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(base) + 0.5);
    ctx.lineTo(v.w, Math.round(base) + 0.5);
    ctx.stroke();
  }

  /* ==================================================================
   * SET DRESSING — vendored sprite sheets in the parallax strata
   *
   * Screen-space (the strata are screen-space too), fixed pixel size so the
   * art stays on the pixel grid at any zoom, and culled the moment it leaves
   * the view. bands: [lo, hi) of parallax depth, so a creature can sit behind
   * or in front of the near towers.
   * ================================================================== */
  function drawDecorSky(ctx, v, lo, hi) {
    var dec = level.decor;
    if (!dec || !dec.length) return;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (var i = 0; i < dec.length; i++) {
      var d = dec[i];
      if (d.k === 'golem' || d.d < lo || d.d >= hi) continue;
      var wx = d.x + Math.sin(clock * d.sp + d.ph) * d.amp;
      var sx = (wx - cam.x * d.d) * zoom;
      var sy = (d.y - cam.y * d.d) * zoom;
      if (sx < -72 || sx > v.w + 72 || sy < -72 || sy > v.h + 72) continue;
      /* a slow pulse so the wisps read as alive, dimmer the further back */
      var a = (0.45 + d.d * 0.55) * (0.82 + 0.18 * Math.sin(clock * 1.3 + d.ph));
      /* soft halo: the same graded frame one step larger, smoothed, so the
       * spirit glows into the ink instead of ending on a hard pixel edge */
      SPR.draw(ctx, d.k, sx, sy, d.ph, a);
    }
    ctx.restore();
  }

  /* Stone sentinels standing on the odd plate — carved props, drawn under the
   * player and under every hazard, culled with the rest of the level. */
  function drawProps(ctx) {
    var dec = level.decor;
    if (!dec || !dec.length) return;
    var drew = false;
    for (var i = 0; i < dec.length; i++) {
      var d = dec[i];
      if (d.k !== 'golem') continue;
      if (d.x < cull.l - 40 || d.x > cull.r + 40) continue;
      if (d.y < cull.t - 60 || d.y - 44 > cull.b) continue;   // vertical cull too
      if (!drew) {
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        drew = true;
      }
      /* contact shadow: it has to sit *on* the plate, not hover over it */
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(3,5,10,0.55)';
      ctx.beginPath();
      ctx.ellipse(d.x, d.y + 1, 30, 5, 0, 0, 6.2832);
      ctx.fill();
      /* rim light: the same sheet, retinted mint and nudged four ways, so the
       * silhouette carries the game's neon edge instead of reading as a stray
       * patch of foreign pixels */
      var rim = { tint: '#7cf5d0', mix: 0.95 };
      SPR.draw(ctx, 'golem', d.x - 2, d.y - 2, d.ph, 0.13, rim);
      SPR.draw(ctx, 'golem', d.x + 2, d.y + 2, d.ph, 0.13, rim);
      SPR.draw(ctx, 'golem', d.x - 2, d.y + 2, d.ph, 0.09, rim);
      SPR.draw(ctx, 'golem', d.x + 2, d.y - 2, d.ph, 0.09, rim);
      SPR.draw(ctx, 'golem', d.x, d.y, d.ph, 0.9);
    }
    if (drew) ctx.restore();
  }

  /* ==================================================================
   * LEVEL
   * ================================================================== */
  var cull = { l: 0, r: 0, t: 0, b: 0 };

  function drawLevel(ctx, t) {
    cull.l = cam.x - 80;
    cull.r = cam.x + view.w / zoom + 80;
    cull.t = cam.y;
    cull.b = cam.y + view.h / zoom + 80;

    drawSolids(ctx);
    drawProps(ctx);
    drawDrifts(ctx);
    drawSpikes(ctx);
    drawLasers(ctx);
    drawSaws(ctx);
    drawAnchors(ctx);
    drawPads(ctx);
    drawCoins(ctx);
    drawPortal(ctx);
    drawGhost(ctx);
    drawRope(ctx);
    drawPlayer(ctx);
    drawParticles(ctx);
    drawFloats(ctx);
  }

  /* One carved block: real masonry — individually toned stones with dark
   * mortar between them, a bevel lit on each stone's top edge, and a vignette
   * falling into the underside. No gradient allocation, all culled to the view.
   * Collision is untouched: this only paints the rect the physics already uses. */
  function stoneBody(ctx, s, pal) {
    var x = s.x, y = s.y, w = s.w, h = s.h;
    var gx, gy, bx, bw2, bh2, row = 0, tone;
    /* stone size follows the slab: a thin ledge needs small courses or the
     * blocks read as one giant panel */
    var rowH = h >= 48 ? 15 : 8;
    var blockW = h >= 48 ? 34 : 22;

    /* mortar bed */
    ctx.fillStyle = pal.body;
    ctx.fillRect(x, y, w, h);

    for (gy = y + 3; gy < y + h; gy += rowH) {
      bh2 = Math.min(rowH - 1, y + h - gy);
      if (bh2 <= 1) break;
      var off = (row & 1) ? -Math.round(blockW * 0.5) : 0;
      for (gx = x + off; gx < x + w; gx += blockW) {
        bx = Math.max(gx, x);
        bw2 = Math.min(gx + blockW - 1, x + w) - bx;
        if (bw2 <= 1) continue;
        if (bx > cull.r || bx + bw2 < cull.l) continue;
        tone = pal.tones[(Math.abs(Math.round(gx / 3) + Math.round(gy / 2) * 7)) % 3];
        ctx.fillStyle = tone;
        ctx.fillRect(bx, gy, bw2, bh2);
        /* bevel: lit on top, shadowed at the base */
        ctx.fillStyle = 'rgba(255,255,255,0.045)';
        ctx.fillRect(bx, gy, bw2, 1);
        ctx.fillStyle = 'rgba(0,0,0,0.30)';
        ctx.fillRect(bx, gy + bh2 - 1, bw2, 1);
        /* chipped corner on a few stones */
        if (((gx * 31 + gy * 17) & 63) < 6) {
          ctx.fillStyle = 'rgba(0,0,0,0.42)';
          ctx.fillRect(bx + bw2 - 3, gy, 3, 2);
        }
      }
      row++;
    }

    /* underside vignette: three flat bands, darker as they fall */
    if (h > 10) {
      ctx.fillStyle = 'rgba(0,0,0,0.26)';
      ctx.fillRect(x, y + h * 0.52, w, h * 0.48);
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      ctx.fillRect(x, y + h * 0.78, w, h * 0.22);
      ctx.fillStyle = pal.bodyLow;
      ctx.fillRect(x, y + h - 2, w, 2);
    }
  }

  function drawSolids(ctx) {
    var i, s, pal, x;
    for (i = 0; i < level.solids.length; i++) {
      s = level.solids[i];
      if (s.x > cull.r || s.x + s.w < cull.l) continue;
      pal = PAL[level.idx % PAL.length];

      stoneBody(ctx, s, pal);

      if (s.floor) {
        /* lit bedding plane: a 4px face, a hot 1px edge, a soft bleed below */
        ctx.fillStyle = pal.lip;
        ctx.fillRect(s.x, s.y, s.w, 4);
        ctx.fillStyle = pal.edgeMid;
        ctx.fillRect(s.x, s.y + 1, s.w, 1);
        ctx.fillStyle = pal.edge;
        ctx.fillRect(s.x, s.y, s.w, 1);
        ctx.fillStyle = pal.glow;
        ctx.fillRect(s.x, s.y + 4, s.w, 8);
        /* a second course line gives the front face a step, not a flat plane */
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(s.x, s.y + Math.round(s.h * 0.42), s.w, 1);
        ctx.fillStyle = 'rgba(255,255,255,0.025)';
        ctx.fillRect(s.x, s.y + Math.round(s.h * 0.42) + 1, s.w, 1);
        /* chamfered corners so the plate reads as cut stone */
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(s.x, s.y, 1, 4);
        ctx.fillRect(s.x + s.w - 1, s.y, 1, 4);
        /* rivets along the bedding plane + rune marks cut into the face */
        for (x = s.x + 14; x < s.x + s.w; x += 34) {
          if (x < cull.l || x > cull.r) continue;
          ctx.fillStyle = 'rgba(0,0,0,0.45)';
          ctx.fillRect(x, s.y + 2, 2, 2);
          ctx.fillStyle = pal.edgeLow;
          ctx.fillRect(x, s.y + 3.4, 2, 0.8);
        }
        for (x = s.x + 60; x < s.x + s.w; x += 148) {
          if (x < cull.l || x > cull.r) continue;
          ctx.fillStyle = 'rgba(124,245,208,0.10)';
          ctx.fillRect(x, s.y + s.h * 0.5 + 5, 9, 1);
          ctx.fillRect(x + 4, s.y + s.h * 0.5 + 2, 1, 7);
        }
      } else if (s.ceil) {
        ctx.fillStyle = pal.lipDeep;
        ctx.fillRect(s.x, s.y + s.h - 4, s.w, 4);
        ctx.fillStyle = pal.edgeLow;
        ctx.fillRect(s.x, s.y + s.h - 1, s.w, 1);
      } else {
        /* floating platform: top face lit, underside in shadow with a faint
         * accent bounce so the slab sits in the air instead of on the page */
        ctx.fillStyle = 'rgba(0,0,0,0.42)';
        ctx.fillRect(s.x + 3, s.y + s.h, s.w - 6, 3);
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fillRect(s.x + 1, s.y + s.h + 3, s.w - 2, 3);
        ctx.fillStyle = pal.lip;
        ctx.fillRect(s.x, s.y, s.w, 4);
        ctx.fillStyle = s.ledge ? 'rgba(150,205,255,0.95)' : pal.edge;
        ctx.fillRect(s.x, s.y, s.w, 1);
        ctx.fillStyle = pal.glow;
        ctx.fillRect(s.x, s.y + 4, s.w, 6);
        ctx.fillStyle = pal.lipDeep;
        ctx.fillRect(s.x + 1, s.y + s.h - 2, s.w - 2, 2);
        ctx.fillStyle = s.ledge ? 'rgba(90,169,255,0.30)' : pal.edgeLow;
        ctx.fillRect(s.x + 1, s.y + s.h - 1, s.w - 2, 1);
        /* end caps catch the rim light */
        ctx.fillStyle = s.ledge ? 'rgba(90,169,255,0.55)' : pal.edgeMid;
        ctx.fillRect(s.x, s.y + 1, 1.5, s.h - 2);
        ctx.fillRect(s.x + s.w - 1.5, s.y + 1, 1.5, s.h - 2);
        /* bolts under the lip: the slab is held up, not floating */
        for (x = s.x + 12; x < s.x + s.w - 8; x += 30) {
          if (x < cull.l || x > cull.r) continue;
          ctx.fillStyle = 'rgba(0,0,0,0.5)';
          ctx.fillRect(x, s.y + 5, 2, 2);
          ctx.fillStyle = 'rgba(255,255,255,0.10)';
          ctx.fillRect(x, s.y + 5, 2, 0.8);
        }
      }
    }
  }

  function drawDrifts(ctx) {
    for (var i = 0; i < level.drifts.length; i++) {
      var d = level.drifts[i];
      if (d.x > cull.r || d.x + d.w < cull.l) continue;
      var on = Math.abs(P.vx) > 190 && P.onGround;
      ctx.strokeStyle = on ? 'rgba(255,209,102,0.85)' : 'rgba(255,209,102,0.28)';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 7]);
      ctx.lineDashOffset = -clock * 40;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x + d.w, d.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }
  }

  function drawSpikes(ctx) {
    for (var i = 0; i < level.spikes.length; i++) {
      var h = level.spikes[i];
      if (h.x > cull.r || h.x + h.w < cull.l) continue;
      var n = Math.max(2, Math.round(h.w / 11));
      var step = h.w / n, k, x;
      ctx.beginPath();
      for (k = 0; k < n; k++) {
        x = h.x + k * step;
        ctx.moveTo(x, h.y + h.h);
        ctx.lineTo(x + step / 2, h.y + 1);
        ctx.lineTo(x + step, h.y + h.h);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,77,109,0.16)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,77,109,0.85)';
      ctx.lineWidth = 1.1;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,77,109,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(h.x, h.y + h.h + 1.5);
      ctx.lineTo(h.x + h.w, h.y + h.h + 1.5);
      ctx.stroke();
    }
  }

  function drawSaws(ctx) {
    for (var i = 0; i < level.saws.length; i++) {
      var s = level.saws[i];
      if (s.x > cull.r + 40 || s.x < cull.l - 40) continue;

      ctx.strokeStyle = 'rgba(255,77,109,0.13)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(s.x0, s.y0);
      ctx.lineTo(s.x1, s.y1);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.beginPath();
      var teeth = 9;
      for (var k = 0; k < teeth; k++) {
        var a0 = (k / teeth) * Math.PI * 2;
        var a1 = a0 + (Math.PI * 2 / teeth) * 0.52;
        ctx.lineTo(Math.cos(a0) * s.r, Math.sin(a0) * s.r);
        ctx.lineTo(Math.cos(a1) * s.r * 0.76, Math.sin(a1) * s.r * 0.76);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,77,109,0.18)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,77,109,0.92)';
      ctx.lineWidth = 1.3;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, s.r * 0.26, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,77,109,0.95)';
      ctx.fill();
      ctx.restore();
    }
  }

  function drawLasers(ctx) {
    for (var i = 0; i < level.lasers.length; i++) {
      var z = level.lasers[i];
      if (z.x > cull.r + 60 || z.x + (z.dx ? z.len : 0) < cull.l - 60) continue;
      var x2 = z.x + z.dx * z.len, y2 = z.y + z.dy * z.len;
      var cyc = (clock * 0.9 + z.ph) % z.period;
      var firing = cyc > 1.05 && cyc < 1.62;
      var charge = GK.clamp((cyc - 0.62) / 0.42, 0, 1);

      ctx.strokeStyle = 'rgba(255,77,109,0.10)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 7]);
      ctx.beginPath(); ctx.moveTo(z.x, z.y); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.setLineDash([]);

      if (charge > 0 && !firing) {
        var flick = 0.35 + 0.65 * Math.abs(Math.sin(clock * 26));
        ctx.strokeStyle = 'rgba(255,77,109,' + (0.42 * charge * flick) + ')';
        ctx.lineWidth = 1 + charge * 2;
        ctx.beginPath(); ctx.moveTo(z.x, z.y); ctx.lineTo(x2, y2); ctx.stroke();
        /* warning pips run along the beam */
        ctx.fillStyle = 'rgba(255,209,102,' + (0.5 * flick) + ')';
        for (var q = 1; q < 6; q++) {
          var u = q / 6;
          ctx.fillRect(z.x + (x2 - z.x) * u - 1.5, z.y + (y2 - z.y) * u - 1.5, 3, 3);
        }
      }

      if (firing) {
        ctx.strokeStyle = 'rgba(255,77,109,0.22)';
        ctx.lineWidth = 11;
        ctx.beginPath(); ctx.moveTo(z.x, z.y); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,77,109,0.95)';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(z.x, z.y); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,240,244,0.95)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(z.x, z.y); ctx.lineTo(x2, y2); ctx.stroke();
      }

      /* emitters */
      ctx.beginPath(); ctx.arc(z.x, z.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#1a0e18';
      ctx.fill();
      ctx.strokeStyle = firing ? 'rgba(255,77,109,0.95)' : 'rgba(255,77,109,0.5)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.beginPath(); ctx.arc(x2, y2, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = '#1a0e18';
      ctx.fill();
      ctx.stroke();
    }
  }

  function drawAnchors(ctx) {
    for (var i = 0; i < level.anchors.length; i++) {
      var a = level.anchors[i];
      if (a.x > cull.r + 30 || a.x < cull.l - 30) continue;
      var pulse = 0.5 + 0.5 * Math.sin(clock * 2.6 + a.ph);
      var live = !hook.on && hook.preview === a;

      ctx.strokeStyle = 'rgba(124,245,208,0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(a.x, a.y - 17); ctx.lineTo(a.x, a.y - 7); ctx.stroke();

      ctx.beginPath();
      ctx.arc(a.x, a.y, 6.2 + pulse * 1.1, 0, Math.PI * 2);
      ctx.strokeStyle = live ? 'rgba(255,209,102,0.95)' : 'rgba(124,245,208,' + (0.5 + 0.4 * pulse) + ')';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(a.x, a.y, 2.1, 0, Math.PI * 2);
      ctx.fillStyle = live ? C.gold : C.mint;
      ctx.fill();

      if (live) {
        ctx.strokeStyle = 'rgba(255,209,102,0.9)';
        ctx.lineWidth = 1.5;
        var r = 12.5;
        for (var c = 0; c < 4; c++) {
          var ang = Math.PI / 4 + c * Math.PI / 2;
          ctx.beginPath();
          ctx.arc(a.x, a.y, r, ang - 0.22, ang + 0.22);
          ctx.stroke();
        }
      }
      if (hook.on && Math.abs(hook.ax - a.x) < 0.5 && Math.abs(hook.ay - a.y) < 0.5) {
        ctx.beginPath();
        ctx.arc(a.x, a.y, 9, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(234,255,250,0.55)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  function drawPads(ctx) {
    for (var i = 0; i < level.pads.length; i++) {
      var p = level.pads[i];
      if (p.x > cull.r || p.x + p.w < cull.l) continue;
      var glow = GK.clamp(Math.abs(p.hit), 0, 1);
      ctx.fillStyle = 'rgba(255,209,102,' + (0.12 + 0.4 * glow) + ')';
      ctx.fillRect(p.x, p.y, p.w, p.h);
      ctx.strokeStyle = 'rgba(255,209,102,' + (0.5 + 0.45 * glow) + ')';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y + 0.6); ctx.lineTo(p.x + p.w, p.y + 0.6);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,209,102,' + (0.55 + 0.45 * glow) + ')';
      ctx.lineWidth = 2;
      for (var k = 0; k < 3; k++) {
        var bx = p.x + 10 + k * 13 + Math.sin(clock * 5 - k * 0.8) * 1.6;
        chevron(ctx, bx, p.y + p.h / 2 + 1, 1);
      }
    }
  }

  function drawCoins(ctx) {
    for (var i = 0; i < level.coins.length; i++) {
      var c = level.coins[i];
      if (c.got) continue;
      if (c.x > cull.r || c.x < cull.l) continue;
      var bob = Math.sin(clock * 2.4 + c.ph) * 3;
      var spin = Math.abs(Math.cos(clock * 2.1 + c.ph));
      ctx.save();
      ctx.translate(c.x, c.y + bob);
      ctx.scale(0.3 + 0.7 * spin, 1);
      ctx.beginPath();
      ctx.moveTo(0, -8);
      ctx.lineTo(6, 0);
      ctx.lineTo(0, 8);
      ctx.lineTo(-6, 0);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,209,102,0.30)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,209,102,0.95)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -3); ctx.lineTo(2.4, 0); ctx.lineTo(0, 3); ctx.lineTo(-2.4, 0);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,245,215,0.9)';
      ctx.fill();
      ctx.restore();
    }
  }

  function drawPortal(ctx) {
    var pr = level.portal;
    if (pr.x > cull.r + 90 || pr.x + pr.w < cull.l - 90) return;
    var cx = pr.x + pr.w / 2, cy = pr.y + pr.h / 2;
    var g = ctx.createRadialGradient(cx, cy, 2, cx, cy, 78);
    g.addColorStop(0, 'rgba(124,245,208,0.20)');
    g.addColorStop(0.5, 'rgba(124,245,208,0.06)');
    g.addColorStop(1, 'rgba(124,245,208,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - 80, cy - 80, 160, 160);

    for (var i = 0; i < 3; i++) {
      var k = 1 - i * 0.2;
      ctx.save();
      ctx.rotate(clock * (0.5 + i * 0.4) + i * 1.4);
      ctx.strokeStyle = 'rgba(124,245,208,' + (0.8 - i * 0.2) + ')';
      ctx.lineWidth = 1.6 - i * 0.3;
      ctx.setLineDash(i === 1 ? [7, 9] : []);
      ctx.beginPath();
      ctx.ellipse(cx, cy, (pr.w / 2) * k, (pr.h / 2) * k, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(234,255,250,0.10)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, pr.w * 0.2, pr.h * 0.36, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(234,255,250,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(cx, cy, pr.w * 0.2, pr.h * 0.36, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  /* ==================================================================
   * GHOST, ROPE, PLAYER
   * ================================================================== */
  function ghostPos() {
    if (!ghostSamples || ghostSamples.length < 2) return null;
    var t = run.roomTime;
    var first = ghostSamples[0], last = ghostSamples[ghostSamples.length - 1];
    if (t >= last[0] + 0.5) return null;
    if (t <= first[0]) return { x: first[1], y: first[2] };
    if (t >= last[0]) return { x: last[1], y: last[2] };
    for (var i = 1; i < ghostSamples.length; i++) {
      if (ghostSamples[i][0] >= t) {
        var a = ghostSamples[i - 1], b = ghostSamples[i];
        var u = (t - a[0]) / Math.max(0.001, b[0] - a[0]);
        return { x: GK.lerp(a[1], b[1], u), y: GK.lerp(a[2], b[2], u) };
      }
    }
    return null;
  }

  /* ==================================================================
   * THE RUNNER — a drawn character, not a capsule
   *
   * The pose is driven by the simulation's own state (|vx|, grounded, P.sx/
   * P.sy squash) so the animation can never disagree with the physics.
   * P.hw / P.hh and every collision value stay exactly as they were.
   * ================================================================== */
  var anim = { phase: 0, air: 0, land: 0 };
  var _rig = { s: 0, s2: 0, air: 0, lean: 0, bob: 0 };

  var PAL_HALO = {
    limb: 'rgba(124,245,208,0.70)', torso: 'rgba(124,245,208,0.70)',
    head: 'rgba(124,245,208,0.70)', trim: 'rgba(124,245,208,0.40)'
  };
  var PAL_BODY = { limb: '#1a424b', torso: '#21525a', head: '#265a63', trim: '#0a1a1e' };
  var PAL_GHOST = {
    limb: 'rgba(124,245,208,0.85)', torso: 'rgba(124,245,208,0.85)',
    head: 'rgba(124,245,208,0.85)', trim: 'rgba(124,245,208,0.55)'
  };

  function animTick(dt) {
    var spd = Math.abs(P.vx);
    if (P.onGround) anim.phase += spd * dt * 0.075;
    anim.air = approach(anim.air, P.onGround ? 0 : 1, dt * 9);
    anim.land = Math.max(0, anim.land - dt * 4);
    hookFx.fade = Math.max(0, hookFx.fade - dt * 2.6);
    hookFx.flash = Math.max(0, hookFx.flash - dt * 4.5);
  }

  /* nearest solid surface under a point — used for the contact shadow only */
  function groundBelow(x, y) {
    var best = 1e9;
    for (var i = 0; i < level.solids.length; i++) {
      var s = level.solids[i];
      if (x < s.x - 3 || x > s.x + s.w + 3) continue;
      if (s.y < y - 2) continue;
      if (s.y < best) best = s.y;
    }
    return best === 1e9 ? y + 300 : best;
  }

  function drawRunnerShadow(ctx) {
    var gy = groundBelow(P.x, P.y + P.hh * 0.5);
    var d = gy - (P.y + P.hh);
    if (d > 300) return;
    var k = GK.clamp(1 - d / 300, 0, 1);
    var rx = (P.hw * 1.15) * (0.55 + 0.45 * k);
    var ry = rx * 0.34;
    ctx.fillStyle = 'rgba(2,4,8,' + (0.10 + 0.30 * k) + ')';
    ctx.beginPath();
    ctx.ellipse(P.x, gy + 1, rx * 1.8, ry * 1.7, 0, 0, 6.2832);
    ctx.fill();
    ctx.fillStyle = 'rgba(1,3,6,' + (0.18 + 0.34 * k) + ')';
    ctx.beginPath();
    ctx.ellipse(P.x, gy + 0.5, rx, ry, 0, 0, 6.2832);
    ctx.fill();
  }

  function limbTo(ctx, x0, y0, cx, cy, x1, y1, w) {
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(cx, cy, x1, y1);
    ctx.stroke();
  }

  /* Draws the whole rig in one colour set. Called twice per frame: once as the
   * cyan halo underneath, once as the body on top. */
  function actorPose(ctx, k) {
    var f = P.face;
    var s = _rig.s, s2 = _rig.s2, air = _rig.air, bob = _rig.bob;
    var i;

    /* ---- back leg (behind the torso) ---- */
    var hipX = -1.2 * f, kneeX = (-1.2 + s2 * 3.2) * f, footX = (-1.2 + s2 * 6.2) * f;
    var kneeY = 8.2 - Math.abs(s2) * 0.4, footY = 12.9 - Math.max(0, s2) * 3.0;
    kneeX = GK.lerp(kneeX, -4.6 * f, air);
    kneeY = GK.lerp(kneeY, 7.6, air);
    footX = GK.lerp(footX, -7.0 * f, air);
    footY = GK.lerp(footY, 12.4, air);
    ctx.strokeStyle = k.limb;
    limbTo(ctx, hipX, 3.2 + bob, kneeX, kneeY + bob, footX, footY + bob, 3.0);
    ctx.fillStyle = k.limb;
    ctx.beginPath();
    ctx.ellipse(footX + 0.8 * f, footY + bob + 0.3, 2.5, 1.3, 0, 0, 6.2832);
    ctx.fill();

    /* ---- back arm ---- */
    var shX = -2.0 * f, shY = -4.4 + bob;
    var elX = (-2.0 - s2 * 2.9) * f, elY = -0.4 + bob;
    var hdX = (-2.0 - s2 * 4.3) * f, hdY = 2.4 + bob;
    elX = GK.lerp(elX, -5.4 * f, air);
    elY = GK.lerp(elY, -2.4, air);
    hdX = GK.lerp(hdX, -6.6 * f, air);
    hdY = GK.lerp(hdY, -4.0, air);
    limbTo(ctx, shX, shY, elX, elY, hdX, hdY, 2.6);
    ctx.beginPath();
    ctx.arc(hdX, hdY, 1.5, 0, 6.2832);
    ctx.fillStyle = k.limb;
    ctx.fill();

    /* ---- torso: tapered, leaning with the run ---- */
    ctx.fillStyle = k.torso;
    ctx.beginPath();
    ctx.moveTo(3.5 * f, -5.4 + bob);
    ctx.lineTo(-3.1 * f, -5.4 + bob);
    ctx.quadraticCurveTo(-4.2 * f, -1.2 + bob, -2.7 * f, 3.6 + bob);
    ctx.lineTo(2.9 * f, 3.6 + bob);
    ctx.quadraticCurveTo(4.3 * f, -1.2 + bob, 3.5 * f, -5.4 + bob);
    ctx.closePath();
    ctx.fill();
    /* chest plate: one darker inset so the torso has a front and a back */
    ctx.fillStyle = k.trim;
    ctx.beginPath();
    ctx.moveTo(2.9 * f, -4.0 + bob);
    ctx.lineTo(-0.4 * f, -4.0 + bob);
    ctx.quadraticCurveTo(-1.4 * f, -0.6 + bob, -0.2 * f, 2.4 + bob);
    ctx.lineTo(2.2 * f, 2.4 + bob);
    ctx.quadraticCurveTo(3.4 * f, -1.0 + bob, 2.9 * f, -4.0 + bob);
    ctx.closePath();
    ctx.fill();

    /* ---- front leg ---- */
    var fHip = 1.3 * f, fKnee = (1.3 + s * 3.3) * f, fFoot = (1.3 + s * 6.4) * f;
    var fKneeY = 8.0 - Math.abs(s) * 0.5, fFootY = 12.9 - Math.max(0, s) * 3.2;
    fKnee = GK.lerp(fKnee, 5.6 * f, air);
    fKneeY = GK.lerp(fKneeY, 6.2, air);
    fFoot = GK.lerp(fFoot, 7.6 * f, air);
    fFootY = GK.lerp(fFootY, 10.4, air);
    ctx.strokeStyle = k.limb;
    limbTo(ctx, fHip, 3.2 + bob, fKnee, fKneeY + bob, fFoot, fFootY + bob, 3.2);
    ctx.fillStyle = k.limb;
    ctx.beginPath();
    ctx.ellipse(fFoot + 0.9 * f, fFootY + bob + 0.3, 2.7, 1.4, 0, 0, 6.2832);
    ctx.fill();

    /* ---- front arm ---- */
    var aShX = 2.2 * f, aShY = -4.2 + bob;
    var aElX = (2.2 - s * 2.9) * f, aElY = -0.2 + bob;
    var aHdX = (2.2 - s * 4.4) * f, aHdY = 2.6 + bob;
    aElX = GK.lerp(aElX, 5.6 * f, air);
    aElY = GK.lerp(aElY, -3.0, air);
    aHdX = GK.lerp(aHdX, 6.4 * f, air);
    aHdY = GK.lerp(aHdY, -5.0, air);
    limbTo(ctx, aShX, aShY, aElX, aElY, aHdX, aHdY, 2.7);
    ctx.beginPath();
    ctx.arc(aHdX, aHdY, 1.6, 0, 6.2832);
    ctx.fillStyle = k.limb;
    ctx.fill();

    /* ---- neck + head ---- */
    var hx = 0.9 * f, hy = -9.9 + bob;
    ctx.fillStyle = k.trim;
    ctx.fillRect(hx - 1.6, hy + 2.6, 3.2, 3.0);
    ctx.fillStyle = k.head;
    ctx.beginPath();
    ctx.arc(hx, hy, 4.4, 0, 6.2832);
    ctx.fill();
    /* helmet crest, swept back — gives the head a direction */
    ctx.beginPath();
    ctx.moveTo(hx - 0.6 * f, hy - 4.2);
    ctx.quadraticCurveTo(hx - 4.4 * f, hy - 3.4, hx - 5.4 * f, hy + 0.4);
    ctx.quadraticCurveTo(hx - 3.4 * f, hy - 1.2, hx - 0.4 * f, hy - 1.1);
    ctx.closePath();
    ctx.fillStyle = k.trim;
    ctx.fill();

    /* ---- scarf: a ribbon that trails with speed. At 30px tall this is the
     * clearest read that the figure is a designed character, not a shape ---- */
    var spd2 = Math.abs(P.vx) * 0.5 + Math.abs(P.vy) * 0.35;
    var len = 7 + GK.clamp(spd2 / 34, 0, 15);
    var wave = Math.sin(clock * 7.5) * 2.1;
    var wave2 = Math.sin(clock * 7.5 + 1.3) * 3.0;
    ctx.strokeStyle = k.trim;
    ctx.lineWidth = 2.0;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-1.2 * f, -7.6 + bob);
    ctx.quadraticCurveTo((-4.4 - len * 0.45) * f, -8.2 + wave + bob, (-4.0 - len) * f, -2.6 + wave2 + bob);
    ctx.stroke();
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.moveTo(-1.2 * f, -7.6 + bob);
    ctx.quadraticCurveTo((-4.0 - len * 0.45) * f, -8.6 + wave + bob, (-3.6 - len * 0.92) * f, -3.0 + wave2 + bob);
    ctx.stroke();
  }

  function drawGhost(ctx) {
    var gp = ghostPos();
    if (!gp) return;
    _rig.s = Math.sin(clock * 9) * 0.8;
    _rig.s2 = -_rig.s;
    _rig.air = 0.3;
    _rig.bob = 0;
    ctx.save();
    ctx.globalAlpha = 0.30;
    ctx.translate(gp.x, gp.y);
    actorPose(ctx, PAL_GHOST);
    ctx.restore();
  }

  function ropePath(ctx) {
    var d = Math.sqrt((P.x - hook.ax) * (P.x - hook.ax) + (P.y - hook.ay) * (P.y - hook.ay));
    var slack = GK.clamp((hook.len - d) / 70, 0, 1);
    ctx.beginPath();
    ctx.moveTo(hook.ax, hook.ay);
    if (slack > 0.04) {
      ctx.quadraticCurveTo((hook.ax + P.x) / 2, (hook.ay + P.y) / 2 + 34 * slack, P.x, P.y);
    } else {
      ctx.lineTo(P.x, P.y);
    }
  }

  /* rope point at u (0 at the anchor, 1 at the hand) — no allocation */
  var _rp = { x: 0, y: 0, slack: 0 };
  function ropeAt(u) {
    var d = Math.sqrt((P.x - hook.ax) * (P.x - hook.ax) + (P.y - hook.ay) * (P.y - hook.ay));
    var slack = GK.clamp((hook.len - d) / 70, 0, 1);
    var cx = (hook.ax + P.x) / 2, cy = (hook.ay + P.y) / 2 + 34 * slack;
    var iu = 1 - u;
    _rp.x = iu * iu * hook.ax + 2 * u * iu * cx + u * u * P.x;
    _rp.y = iu * iu * hook.ay + 2 * u * iu * cy + u * u * P.y;
    _rp.slack = slack;
  }

  var hookFx = { fade: 0, ax: 0, ay: 0, was: false, flash: 0 };

  function drawHookTip(ctx, x, y, a, ang) {
    /* a claw, not a dot: two prongs plus a hot core */
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.strokeStyle = 'rgba(234,255,250,' + (0.85 * a) + ')';
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(-5, -3.4);
    ctx.moveTo(0, 0); ctx.lineTo(-5, 3.4);
    ctx.stroke();
    ctx.fillStyle = 'rgba(124,245,208,' + (0.30 * a) + ')';
    ctx.beginPath(); ctx.arc(0, 0, 7.5, 0, 6.2832); ctx.fill();
    ctx.fillStyle = 'rgba(235,255,250,' + (0.95 * a) + ')';
    ctx.beginPath(); ctx.arc(0, 0, 2.4, 0, 6.2832); ctx.fill();
    ctx.restore();
  }

  function drawRope(ctx) {
    var i, ang;

    /* catch / release edges, detected here so the rope needs no new state in
     * the simulation */
    if (hook.on) {
      if (!hookFx.was) { hookFx.flash = 1; hookFx.was = true; }
    } else if (hookFx.was) {
      hookFx.was = false;
      hookFx.fade = 1;
    }
    if (!hook.on && hookFx.fade <= 0) return;

    if (hook.on) { hookFx.ax = hook.ax; hookFx.ay = hook.ay; }
    var a = hook.on ? 1 : GK.clamp(hookFx.fade, 0, 1);

    /* rope: wide bloom, core, then a specular thread */
    ropePath(ctx);
    ctx.strokeStyle = 'rgba(124,245,208,' + (0.22 * a) + ')';
    ctx.lineWidth = 4.2;
    ctx.lineCap = 'round';
    ctx.stroke();
    ropePath(ctx);
    ctx.strokeStyle = 'rgba(160,255,232,' + (0.95 * a) + ')';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ropePath(ctx);
    ctx.strokeStyle = 'rgba(240,255,252,' + (0.55 * a) + ')';
    ctx.lineWidth = 0.6;
    ctx.stroke();

    /* a bead of light running down the rope while it is live */
    if (hook.on) {
      for (i = 0; i < 2; i++) {
        var u = ((clock * 1.5 + i * 0.5) % 1);
        ropeAt(1 - u);
        ctx.fillStyle = 'rgba(240,255,252,' + (0.75 * (1 - u)) + ')';
        ctx.beginPath();
        ctx.arc(_rp.x, _rp.y, 1.8, 0, 6.2832);
        ctx.fill();
        ctx.fillStyle = 'rgba(124,245,208,' + (0.22 * (1 - u)) + ')';
        ctx.beginPath();
        ctx.arc(_rp.x, _rp.y, 5.2, 0, 6.2832);
        ctx.fill();
      }
    }

    /* the tip: bright at the moment of the catch, then fading out */
    ang = Math.atan2(P.y - hookFx.ay, P.x - hookFx.ax);
    var tip = a * (0.65 + 0.35 * hookFx.flash);
    drawHookTip(ctx, hookFx.ax, hookFx.ay, tip, ang);

    /* catch ring, only on the frame the hook bites */
    if (hookFx.flash > 0.02) {
      ctx.strokeStyle = 'rgba(234,255,250,' + (0.6 * hookFx.flash) + ')';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(hookFx.ax, hookFx.ay, 6 + (1 - hookFx.flash) * 22, 0, 6.2832);
      ctx.stroke();
    }
  }

  function drawPlayer(ctx) {
    var sp = Math.sqrt(P.vx * P.vx + P.vy * P.vy);
    var i, tr, a;

    /* contact shadow on the floor, never on the runner */
    drawRunnerShadow(ctx);

    /* motion trail: soft smears, not clones */
    if (!hook.on) {
      for (i = 0; i < P.trail.length; i += 2) {
        tr = P.trail[i];
        a = (i + 1) / P.trail.length;
        ctx.fillStyle = 'rgba(124,245,208,' + (0.05 * a * a) + ')';
        ctx.beginPath();
        ctx.ellipse(tr.x, tr.y, P.hw * 0.9, P.hh * 1.0, 0, 0, 6.2832);
        ctx.fill();
      }
    }

    /* pose inputs, from the simulation only */
    var spd = Math.abs(P.vx);
    var run = P.onGround && spd > 16 ? 1 : 0;
    _rig.s = Math.sin(anim.phase) * run;
    _rig.s2 = -_rig.s;
    _rig.air = anim.air;
    _rig.bob = run ? -Math.abs(Math.sin(anim.phase)) * 0.9 : 0;
    _rig.lean = GK.clamp(P.vx / 5200, -0.12, 0.12) + _rig.s * 0.02;

    var vstr = GK.clamp(Math.abs(P.vy) / 1900, 0, 0.26);
    var hstr = GK.clamp(Math.abs(P.vx) / 2400, 0, 0.16);
    var VS = 1.2;   // visual scale only: the hitbox is untouched
    var sx = VS * P.sx * (1 - vstr * 0.45) * (1 + hstr);
    var sy = VS * P.sy * (1 + vstr) * (1 - hstr * 0.25);

    ctx.save();
    ctx.translate(P.x, P.y);
    ctx.rotate(_rig.lean);

    /* squash and stretch is anchored at the feet so a landing presses the
     * character into the floor instead of shrinking it about its centre */
    ctx.translate(0, P.hh);
    ctx.scale(sx, sy);
    ctx.translate(0, -P.hh);

    /* cyan rim: the rig drawn once in mint with a bloom, then the body on top */
    ctx.save();
    ctx.shadowColor = 'rgba(124,245,208,0.9)';
    ctx.shadowBlur = P.spawnT > 0 ? 20 : 11;
    ctx.lineJoin = 'round';
    actorPose(ctx, PAL_HALO);
    ctx.restore();

    actorPose(ctx, PAL_BODY);

    /* crisp edge light down the facing side and over the helmet: at 30px tall
     * the silhouette needs one hard line or it melts into the room */
    ctx.strokeStyle = 'rgba(170,255,238,0.55)';
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(3.3 * P.face, -4.9 + _rig.bob);
    ctx.quadraticCurveTo(4.0 * P.face, -0.8 + _rig.bob, 2.9 * P.face, 3.2 + _rig.bob);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0.9 * P.face, -9.9 + _rig.bob, 4.35, -2.5, -0.5);
    ctx.stroke();

    /* visor: the one hot, saturated note on the character */
    var hx = 0.9 * P.face, hy = -9.9 + _rig.bob;
    ctx.fillStyle = 'rgba(234,255,250,0.95)';
    ctx.beginPath();
    ctx.moveTo(hx + 3.6 * P.face, hy - 2.6);
    ctx.lineTo(hx + 3.6 * P.face, hy + 0.4);
    ctx.quadraticCurveTo(hx + 1.0 * P.face, hy + 1.5, hx - 0.4 * P.face, hy + 0.8);
    ctx.lineTo(hx - 0.4 * P.face, hy - 2.4);
    ctx.closePath();
    ctx.fill();

    /* chest lamp: a slow pulse that reads at thumbnail size */
    var lum = 0.55 + 0.25 * Math.sin(clock * 3.4);
    ctx.fillStyle = 'rgba(124,245,208,' + lum + ')';
    ctx.beginPath();
    ctx.arc(1.0 * P.face, -1.0 + _rig.bob, 1.5, 0, 6.2832);
    ctx.fill();

    ctx.restore();

    /* speed streaks, kept out of the body's transform */
    if (sp > 430) {
      var n = Math.min(9, Math.floor((sp - 430) / 60) + 1);
      ctx.strokeStyle = 'rgba(124,245,208,' + GK.clamp((sp - 430) / 900, 0, 0.32) + ')';
      ctx.lineWidth = 1;
      for (i = 0; i < n; i++) {
        var off = (Math.sin(i * 37.1 + clock * 9) * 0.5 + 0.5);
        var len = 10 + off * 26;
        var y2 = P.y - 12 + off * 26;
        ctx.beginPath();
        ctx.moveTo(P.x - Math.sign(P.vx || 1) * (8 + off * 6), y2);
        ctx.lineTo(P.x - Math.sign(P.vx || 1) * (8 + off * 6 + len), y2);
        ctx.stroke();
      }
    }
  }

  function drawParticles(ctx) {
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var a = p.life / p.max;
      if (p.kind === 3) {
        /* dust: a soft, expanding dot — two arcs, no gradient allocation */
        ctx.fillStyle = 'rgba(196,220,236,' + (0.055 * a * a) + ')';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 2.1, 0, 6.2832);
        ctx.fill();
        ctx.fillStyle = 'rgba(226,242,252,' + (0.11 * a) + ')';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, 6.2832);
        ctx.fill();
      } else if (p.kind === 2) {
        var r = GK.lerp(p.size, p.r1 || 20, 1 - a);
        ctx.strokeStyle = rgbs(p.color, a * 0.65);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = rgbs(p.color, a * 0.85);
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }
  }

  function drawFloats(ctx) {
    for (var i = 0; i < floats.length; i++) {
      var f = floats[i];
      var a = GK.clamp(f.life / f.max, 0, 1);
      ctx.font = '700 ' + f.size + 'px ' + MONO;
      ctx.textAlign = 'center';
      ctx.fillStyle = rgbs(f.color, a);
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.textAlign = 'left';
  }

  /* ==================================================================
   * SCREEN FX + HUD
   * ================================================================== */
  /* Foreground plane: the rock walls at the extreme margins. Drawn after the
   * world so the frame has three real depth planes — rock, play space, sky —
   * instead of one flat layer with decorations behind it. */
  function drawForeground(ctx, v) {
    var side, i, x, y, wid, inner;
    for (side = 0; side < 2; side++) {
      var edge = side ? v.w : 0;
      var dir = side ? -1 : 1;
      wid = v.w * (0.052 + 0.012 * Math.sin(clock * 0.13 + side * 2.1));
      ctx.fillStyle = 'rgba(4,6,10,0.93)';
      ctx.beginPath();
      ctx.moveTo(edge, -2);
      for (i = 0; i <= 14; i++) {
        y = v.h * (i / 14);
        inner = wid * (0.62 + 0.38 * Math.sin(i * 2.1 + side * 1.7 + clock * 0.1));
        x = edge + dir * inner;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(edge, v.h + 2);
      ctx.closePath();
      ctx.fill();
      /* rim light on the inner lip, matching the room palette */
      ctx.strokeStyle = 'rgba(124,245,208,0.09)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (i = 0; i <= 14; i++) {
        y = v.h * (i / 14);
        inner = wid * (0.62 + 0.38 * Math.sin(i * 2.1 + side * 1.7 + clock * 0.1));
        x = edge + dir * inner;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  function drawScreenFx(ctx, v) {
    var sp = Math.sqrt(P.vx * P.vx + P.vy * P.vy);
    if (sp > 400) {
      var a = GK.clamp((sp - 400) / 900, 0, 0.3);
      var g = ctx.createRadialGradient(v.w / 2, v.h / 2, v.h * 0.28, v.w / 2, v.h / 2, v.h * 0.9);
      g.addColorStop(0, 'rgba(124,245,208,0)');
      g.addColorStop(1, 'rgba(124,245,208,' + a + ')');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, v.w, v.h);
    }

    var vg = ctx.createRadialGradient(v.w / 2, v.h / 2, Math.min(v.w, v.h) * 0.34,
      v.w / 2, v.h / 2, Math.max(v.w, v.h) * 0.78);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(3,4,9,0.46)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, v.w, v.h);

    if (hurtFlash > 0) {
      ctx.fillStyle = 'rgba(255,77,109,' + (hurtFlash * 0.2) + ')';
      ctx.fillRect(0, 0, v.w, v.h);
    }
  }

  /* ---------------------------------------------------------------- HUD */
  var hudScrim = null, hudScrimH = 0;

  function trackedW(ctx, text, sp) {
    var i, total = 0;
    for (i = 0; i < text.length; i++) total += ctx.measureText(text.charAt(i)).width + sp;
    return total - sp;
  }

  function tracked(ctx, text, x, y, sp, align) {
    var total = trackedW(ctx, text, sp);
    var sx = align === 'right' ? x - total : align === 'center' ? x - total / 2 : x;
    for (var i = 0; i < text.length; i++) {
      ctx.fillText(text.charAt(i), sx, y);
      sx += ctx.measureText(text.charAt(i)).width + sp;
    }
  }

  function drawHud(ctx, v) {
    if (!run) return;
    var pad = GK.clamp(Math.round(v.h * 0.03), 12, 22);
    var lab = Math.max(11, Math.round(v.h * 0.0152));           // 13 on a 844pt phone
    var num = Math.max(12, Math.round(v.h * 0.0182));           // 15
    var big = Math.min(GK.clamp(Math.round(v.h * 0.046), 22, 32), Math.round(v.w * 0.072));
    var i, x, tw;

    /* scrim so white text never sits on a bright platform */
    if (hudScrimH !== v.h) {
      hudScrimH = v.h;
      hudScrim = ctx.createLinearGradient(0, 0, 0, v.h * 0.2);
      hudScrim.addColorStop(0, 'rgba(3,5,9,0.88)');
      hudScrim.addColorStop(0.5, 'rgba(3,5,9,0.42)');
      hudScrim.addColorStop(1, 'rgba(3,5,9,0)');
    }
    ctx.fillStyle = hudScrim;
    ctx.fillRect(0, 0, v.w, v.h * 0.2);

    /* ---- room progress, top-left ---- */
    ctx.textAlign = 'left';
    ctx.font = lblFont(lab);
    ctx.fillStyle = 'rgba(124,245,208,0.62)';
    tracked(ctx, 'RIFT', pad, pad + lab, 2.4, 'left');
    var rw = trackedW(ctx, 'RIFT ', 2.4);
    ctx.fillStyle = 'rgba(234,246,255,0.9)';
    ctx.fillText(pad2(run.room + 1), pad + rw + 4, pad + lab);
    ctx.fillStyle = 'rgba(234,246,255,0.30)';
    tracked(ctx, '/ ' + pad2(ROOMS), pad + rw + 4 + ctx.measureText(pad2(run.room + 1)).width + 7, pad + lab, 1.2, 'left');

    /* the nine rooms as a segmented track */
    var segW = GK.clamp(Math.round(v.w * 0.019), 8, 13);
    var segY = pad + lab + 7;
    for (i = 0; i < ROOMS; i++) {
      x = pad + i * (segW + 3);
      ctx.fillStyle = i < run.room ? 'rgba(124,245,208,0.85)'
        : i === run.room ? 'rgba(255,209,102,0.95)'
        : 'rgba(255,255,255,0.12)';
      rr2(ctx, x, segY, segW, 2.5, 1.25);
      ctx.fill();
      if (i === run.room) {
        ctx.save();
        ctx.shadowColor = 'rgba(255,209,102,0.9)';
        ctx.shadowBlur = 8;
        ctx.fill();
        ctx.restore();
      }
    }

    /* ---- stopwatch, top-centre: one tabular mono scale ---- */
    ctx.textAlign = 'center';
    ctx.font = numFont(big);
    ctx.fillStyle = 'rgba(240,255,252,0.96)';
    ctx.shadowColor = 'rgba(124,245,208,0.45)';
    ctx.shadowBlur = 12;
    ctx.fillText(fmtMs(run.time), v.w / 2, pad + big * 0.95);
    ctx.shadowBlur = 0;

    var pbr = best.rooms[run.room];
    if (pbr) {
      var d = run.roomTime - pbr;
      var dtxt = fmtDelta(d);
      ctx.font = lblFont(lab);
      tw = ctx.measureText(dtxt).width;
      var chipY = pad + big * 0.95 + 6;
      var chipH = lab + 6;
      ctx.fillStyle = d <= 0 ? 'rgba(124,245,208,0.10)' : 'rgba(255,77,109,0.13)';
      rr2(ctx, v.w / 2 - tw / 2 - 8, chipY, tw + 16, chipH, chipH / 2);
      ctx.fill();
      ctx.strokeStyle = d <= 0 ? 'rgba(124,245,208,0.34)' : 'rgba(255,77,109,0.36)';
      ctx.lineWidth = 1;
      rr2(ctx, v.w / 2 - tw / 2 - 7.5, chipY + 0.5, tw + 15, chipH - 1, (chipH - 1) / 2);
      ctx.stroke();
      ctx.fillStyle = d <= 0 ? 'rgba(186,255,238,0.95)' : 'rgba(255,148,168,0.95)';
      ctx.fillText(dtxt, v.w / 2, chipY + chipH - 5.5);
    }

    /* ---- best / deaths, top-right ---- */
    var rx = v.w - pad;
    var rowY = pad + num;
    ctx.textAlign = 'right';
    /* no placeholder text: the best row simply appears once there is a time */
    if (best.total) {
      ctx.font = numFont(num);
      var pbTxt = fmtMs(best.total);
      tw = ctx.measureText(pbTxt).width;
      ctx.fillStyle = 'rgba(234,246,255,0.80)';
      ctx.fillText(pbTxt, rx, rowY);
      ctx.font = lblFont(lab);
      ctx.fillStyle = 'rgba(234,246,255,0.32)';
      tracked(ctx, 'BEST', rx - tw - 8, rowY - 1, 1.7, 'right');
    }

    var dRow = best.total ? rowY + num + 8 : rowY;
    ctx.font = numFont(num);
    var dTxt = String(run.deaths);
    tw = ctx.measureText(dTxt).width;
    ctx.fillStyle = run.deaths ? 'rgba(255,120,142,0.95)' : 'rgba(234,246,255,0.5)';
    ctx.fillText(dTxt, rx, dRow);
    ctx.font = lblFont(lab);
    ctx.fillStyle = 'rgba(234,246,255,0.32)';
    tracked(ctx, 'DEATHS', rx - tw - 8, dRow - 1, 1.7, 'right');

    /* multiplier: a pill with a thin meter, only while it is live */
    if (boost.mult > 1.02) {
      var mY = dRow + num + 10;
      var mtxt = 'x' + boost.mult.toFixed(1);
      ctx.font = numFont(num);
      tw = ctx.measureText(mtxt).width;
      ctx.fillStyle = 'rgba(255,209,102,0.10)';
      rr2(ctx, rx - tw - 14, mY - num + 1, tw + 14, num + 5, (num + 5) / 2);
      ctx.fill();
      ctx.fillStyle = C.gold;
      ctx.textAlign = 'right';
      ctx.fillText(mtxt, rx, mY);
      var bw = tw + 14;
      var frac = GK.clamp((boost.mult - 1) / (BOOST_MAX - 1), 0, 1);
      ctx.fillStyle = 'rgba(255,209,102,0.20)';
      ctx.fillRect(rx - bw, mY + 5, bw, 2);
      ctx.fillStyle = C.gold;
      ctx.fillRect(rx - bw, mY + 5, bw * frac, 2);
    }

    /* ---- exit marker when the portal is off-screen ---- */
    var pr = level.portal;
    var sx = (pr.x + pr.w / 2 - cam.x) * zoom;
    if (sx > v.w - 16) {
      var my = GK.clamp((pr.y + 30 - cam.y) * zoom, v.h * 0.3, v.h * 0.68);
      var pg = 0.35 + 0.25 * Math.sin(clock * 5);
      ctx.fillStyle = 'rgba(124,245,208,' + pg + ')';
      ctx.beginPath();
      ctx.moveTo(v.w - 8, my);
      ctx.lineTo(v.w - 18, my - 6);
      ctx.lineTo(v.w - 18, my + 6);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(124,245,208,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(v.w - 20, my, 10, -1.1, 1.1);
      ctx.stroke();
    }

    /* ---- room banner ---- */
    if (roomIntro > 0) {
      var a = GK.clamp(roomIntro / 0.35, 0, 1);
      ctx.textAlign = 'center';
      ctx.font = numFont(Math.round(v.h * 0.07));
      ctx.fillStyle = 'rgba(234,246,255,' + (0.13 * a) + ')';
      tracked(ctx, 'RIFT ' + pad2(run.room + 1), v.w / 2, v.h * 0.5, 9, 'center');
      if (run.room === 0 && roomIntro > 0.25) {
        ctx.font = lblFont(Math.max(11, smallLabel(v)));
        ctx.fillStyle = 'rgba(234,246,255,' + (0.5 * a) + ')';
        tracked(ctx, 'HOLD B TO GRAPPLE - PADS PAY ONLY IF YOU ARRIVE FAST',
          v.w / 2, v.h * 0.5 + 26, 1.4, 'center');
      }
    }
    ctx.textAlign = 'left';
  }

  function smallLabel(v) { return Math.max(11, Math.round(v.h * 0.0148)); }

  /* ------------------------------------------------------- TOUCH CHROME
   * The DOM pad still owns every pointer event; it is painted transparent and
   * this draws its chrome on the canvas from the pad's own live state, so the
   * pressed state can never desync from the input.
   * ------------------------------------------------------------------ */
  var ctl = { w: 0, h: 0, ok: false, stick: null, a: null, b: null };

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  }

  function ctlLayout(v) {
    if (ctl.w === v.w && ctl.h === v.h && ctl.ok) return;
    ctl.w = v.w; ctl.h = v.h;
    ctl.ok = false;
    if (!pad || !pad.root || !pad.root.children.length) return;
    var kids = pad.root.children;
    if (!kids[0] || kids[0].offsetWidth === 0) return;
    ctl.stick = rectOf(kids[0]);
    var btns = pad.root.querySelectorAll('.gk-btn');
    ctl.a = btns[0] ? rectOf(btns[0]) : null;
    ctl.b = btns[1] ? rectOf(btns[1]) : null;
    ctl.ok = !!(ctl.stick && ctl.a && ctl.b);
  }

  function ctlGlow(ctx, cx, cy, r, a) {
    var g = ctx.createRadialGradient(cx, cy, r * 0.55, cx, cy, r * 1.7);
    g.addColorStop(0, 'rgba(124,245,208,' + a + ')');
    g.addColorStop(0.55, 'rgba(124,245,208,' + (a * 0.35) + ')');
    g.addColorStop(1, 'rgba(124,245,208,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.7, 0, 6.2832);
    ctx.fill();
  }

  function ctlDisc(ctx, cx, cy, r, press) {
    /* inner gradient fill: lit from the top-left, falling into the rim */
    var g = ctx.createRadialGradient(cx - r * 0.34, cy - r * 0.38, r * 0.08, cx, cy, r);
    g.addColorStop(0, 'rgba(46,68,80,0.62)');
    g.addColorStop(0.62, 'rgba(13,21,30,0.66)');
    g.addColorStop(1, 'rgba(5,9,14,0.78)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r - 0.5, 0, 6.2832);
    ctx.fill();
    /* hairline ring */
    ctx.strokeStyle = 'rgba(255,255,255,0.11)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r - 0.5, 0, 6.2832);
    ctx.stroke();
    /* the accent ring is what responds to touch */
    ctx.strokeStyle = 'rgba(124,245,208,' + (0.20 + 0.45 * press) + ')';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r - 4.5, 0, 6.2832);
    ctx.stroke();
  }

  function drawStick(ctx) {
    if (!ctl.ok) return;
    var c = ctl.stick, r = c.w / 2;
    var st = pad.state;
    var mag = Math.min(1, Math.sqrt(st.x * st.x + st.y * st.y));
    ctlGlow(ctx, c.cx, c.cy, r, 0.05 + 0.13 * mag);
    ctlDisc(ctx, c.cx, c.cy, r, mag);

    /* cardinal ticks */
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 1;
    for (var i = 0; i < 4; i++) {
      var a = i * Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(c.cx + Math.cos(a) * (r - 15), c.cy + Math.sin(a) * (r - 15));
      ctx.lineTo(c.cx + Math.cos(a) * (r - 8), c.cy + Math.sin(a) * (r - 8));
      ctx.stroke();
    }

    /* knob */
    var kr = r * 0.40;
    var kx = c.cx + st.x * (r - kr - 7), ky = c.cy + st.y * (r - kr - 7);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(kx, ky + 3, kr * 0.98, kr * 0.9, 0, 0, 6.2832);
    ctx.fill();
    var kg = ctx.createRadialGradient(kx - kr * 0.35, ky - kr * 0.45, kr * 0.06, kx, ky, kr);
    kg.addColorStop(0, 'rgba(206,238,232,0.92)');
    kg.addColorStop(0.42, 'rgba(104,152,156,0.80)');
    kg.addColorStop(1, 'rgba(24,44,52,0.92)');
    ctx.fillStyle = kg;
    ctx.beginPath();
    ctx.arc(kx, ky, kr, 0, 6.2832);
    ctx.fill();
    ctx.strokeStyle = 'rgba(124,245,208,' + (0.35 + 0.5 * mag) + ')';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(kx, ky, kr - 0.6, 0, 6.2832);
    ctx.stroke();
    /* specular */
    ctx.strokeStyle = 'rgba(255,255,255,' + (0.25 + 0.35 * mag) + ')';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(kx, ky, kr * 0.62, -2.5, -1.05);
    ctx.stroke();
  }

  function drawBtn(ctx, c, letter, caption, down, accent) {
    var r = Math.min(c.w, c.h) / 2;
    var press = down ? 1 : 0;
    if (press) ctlGlow(ctx, c.cx, c.cy, r, 0.22);
    ctx.save();
    ctx.translate(c.cx, c.cy);
    ctx.scale(1 - 0.04 * press, 1 - 0.04 * press);
    ctx.translate(-c.cx, -c.cy);
    ctlDisc(ctx, c.cx, c.cy, r, press);
    if (press) {
      var g = ctx.createRadialGradient(c.cx, c.cy - r * 0.2, r * 0.1, c.cx, c.cy, r);
      g.addColorStop(0, 'rgba(124,245,208,0.30)');
      g.addColorStop(1, 'rgba(124,245,208,0.04)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c.cx, c.cy, r - 2, 0, 6.2832);
      ctx.fill();
    }
    ctx.textAlign = 'center';
    ctx.font = numFont(Math.round(r * 0.52));
    ctx.fillStyle = press ? 'rgba(236,255,250,0.98)' : 'rgba(236,250,255,0.86)';
    ctx.fillText(letter, c.cx, c.cy - 1);
    ctx.font = lblFont(Math.max(11, Math.round(r * 0.19)));
    ctx.fillStyle = press ? 'rgba(180,255,236,0.95)' : 'rgba(200,225,235,0.42)';
    tracked(ctx, caption, c.cx, c.cy + r * 0.42, 1.1, 'center');
    ctx.restore();
  }

  function drawControls(ctx, v) {
    ctlLayout(v);
    if (!ctl.ok) return;
    drawStick(ctx);
    drawBtn(ctx, ctl.a, 'A', 'JUMP', !!pad.state.jump, C.mint);
    drawBtn(ctx, ctl.b, 'B', 'HOOK', !!pad.state.hook, C.blue);
  }

  /* ==================================================================
   * TITLE
   * ================================================================== */
  function drawTitle(ctx, v, t) {
    var g = ctx.createLinearGradient(0, 0, 0, v.h);
    g.addColorStop(0, '#06070e');
    g.addColorStop(0.6, '#0a0b12');
    g.addColorStop(1, '#0b1220');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, v.w, v.h);

    var hy = v.h * 0.66;
    var i, x, y;

    /* receding horizontal grid */
    var step = 14;
    for (i = 0; i < 26; i++) {
      var k = i / 26;
      y = hy + Math.pow(k, 2.2) * (v.h - hy) + ((clock * 12) % step);
      ctx.strokeStyle = 'rgba(124,245,208,' + (0.05 - k * 0.03) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(v.w, Math.round(y) + 0.5);
      ctx.stroke();
    }

    /* nine slits on the horizon */
    var sw = Math.min(v.w * 0.5, 420) / 9;
    for (i = 0; i < 9; i++) {
      x = v.w / 2 - (sw * 9) / 2 + i * sw + sw * 0.5;
      var hh = 26 + Math.abs(Math.sin(clock * 0.9 + i * 0.7)) * 62;
      ctx.fillStyle = 'rgba(124,245,208,' + (0.05 + 0.05 * Math.abs(Math.sin(clock + i))) + ')';
      ctx.fillRect(x - 1, hy - hh, 2, hh);
    }
    ctx.strokeStyle = 'rgba(124,245,208,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, hy);
    ctx.lineTo(v.w, hy);
    ctx.stroke();

    /* horizon glow */
    var rg = ctx.createRadialGradient(v.w / 2, hy, 4, v.w / 2, hy, v.w * 0.5);
    rg.addColorStop(0, 'rgba(124,245,208,0.13)');
    rg.addColorStop(1, 'rgba(124,245,208,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, hy - v.h * 0.5, v.w, v.h);

    /* title */
    var ts = Math.min(v.w * 0.135, v.h * 0.19);
    ctx.textAlign = 'center';
    ctx.font = '700 ' + Math.round(ts) + 'px ' + MONO;
    ctx.shadowColor = 'rgba(124,245,208,0.65)';
    ctx.shadowBlur = 26;
    ctx.fillStyle = C.mint;
    spacedText(ctx, 'RIFT NINE', v.w / 2, hy - v.h * 0.3, ts * 0.14);
    ctx.shadowBlur = 0;

    /* tagline */
    ctx.font = '600 ' + Math.round(GK.clamp(v.h * 0.032, 9, 15)) + 'px ' + MONO;
    ctx.fillStyle = 'rgba(234,246,255,0.5)';
    spacedText(ctx, 'NINE ROOMS · ONE HOOK · ONE STOPWATCH', v.w / 2, hy - v.h * 0.3 + ts * 0.55, 1.6);

    /* how to play — three lines, touch first */
    var hf = Math.round(GK.clamp(v.h * 0.029, 9, 13));
    var hbase = hy - v.h * 0.3 + ts * 0.55;
    var hstep = GK.clamp(v.h * 0.072, hf * 2.1, 62);
    /* keep the third line off the horizon on wide, short screens */
    hstep = Math.min(hstep, (hy - v.h * 0.045 - hbase) / 3);
    var hints = [
      ['DRAG THE LEFT SIDE', 'to run'],
      ['TAP THE RIGHT SIDE', 'to jump'],
      ['HOLD B', 'to fire the hook']
    ];
    ctx.font = '600 ' + hf + 'px ' + MONO;
    for (i = 0; i < hints.length; i++) {
      ctx.fillStyle = 'rgba(234,246,255,0.62)';
      ctx.fillText(hints[i][0], v.w / 2, hbase + hstep * (i + 1));
      var lead = ctx.measureText(hints[i][0]).width;
      ctx.font = '500 ' + Math.round(hf * 0.86) + 'px ' + UI;
      ctx.fillStyle = 'rgba(234,246,255,0.32)';
      ctx.textAlign = 'left';
      ctx.fillText(' ' + hints[i][1], v.w / 2 + lead / 2, hbase + hstep * (i + 1));
      ctx.textAlign = 'center';
      ctx.font = '600 ' + hf + 'px ' + MONO;
    }

    /* best */
    if (best.total) {
      ctx.font = '700 ' + Math.round(GK.clamp(v.h * 0.05, 13, 24)) + 'px ' + MONO;
      ctx.fillStyle = 'rgba(255,209,102,0.9)';
      ctx.fillText('BEST ' + fmtMs(best.total), v.w / 2, hy + v.h * 0.11);
      ctx.font = '600 ' + Math.round(GK.clamp(v.h * 0.026, 8, 12)) + 'px ' + MONO;
      ctx.fillStyle = 'rgba(234,246,255,0.35)';
      ctx.fillText(best.deaths + ' deaths · ' + (Number(store.get('runs', 0)) || 0) + ' runs', v.w / 2, hy + v.h * 0.155);
    }

    /* call to action */
    var pulse = 0.55 + 0.45 * Math.sin(clock * 3.4);
    ctx.font = '700 ' + Math.round(GK.clamp(v.h * 0.036, 10, 17)) + 'px ' + MONO;
    ctx.fillStyle = 'rgba(234,246,255,' + pulse + ')';
    ctx.fillText('TAP OR PRESS SPACE TO RUN', v.w / 2, v.h * 0.855);

    ctx.font = '500 ' + Math.round(GK.clamp(v.h * 0.024, 8, 11)) + 'px ' + UI;
    ctx.fillStyle = 'rgba(234,246,255,0.3)';
    ctx.fillText('A/D run · SPACE jump · hold X to grapple · M mute', v.w / 2, v.h * 0.9);

    /* vendored-content credits: one string, wrapped after the '; ' so both
     * halves stay legible on a phone */
    var crf = Math.round(GK.clamp(v.h * 0.019, 7, 9));
    var cut = CREDIT.indexOf('; ') + 1;
    ctx.font = '500 ' + crf + 'px ' + UI;
    ctx.fillStyle = 'rgba(234,246,255,0.26)';
    ctx.fillText(CREDIT.slice(0, cut), v.w / 2, v.h * 0.938);
    ctx.fillText(CREDIT.slice(cut + 1), v.w / 2, v.h * 0.938 + crf * 1.5);

    ctx.textAlign = 'left';
  }

  /* ==================================================================
   * RESULTS
   * ================================================================== */
  function gradeColor(g) {
    if (g === 'S') return C.gold;
    if (g === 'A') return C.mint;
    if (g === 'B') return C.blue;
    return C.red;
  }

  /* room cleared — split card, time vs best, then on to the next rift */
  function drawClearCard(ctx, v, t) {
    if (!clearCard) return;
    var a = GK.clamp(screenT / 0.16, 0, 1);
    ctx.fillStyle = 'rgba(5,6,11,' + (0.5 * a) + ')';
    ctx.fillRect(0, 0, v.w, v.h);

    var pw = Math.min(v.w - 28, 420);
    var ph = Math.min(v.h * 0.34, 216);
    var px = (v.w - pw) / 2;
    var py = v.h * 0.46 - ph / 2;
    var cx = px + pw / 2;
    var acc = clearCard.rec ? C.gold : C.mint;
    var ease = 1 - Math.pow(1 - a, 3);

    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(cx, py + ph / 2);
    ctx.scale(0.94 + 0.06 * ease, 0.94 + 0.06 * ease);
    ctx.translate(-cx, -(py + ph / 2));

    ctx.fillStyle = 'rgba(11,15,25,0.95)';
    rr2(ctx, px, py, pw, ph, 16);
    ctx.fill();
    ctx.strokeStyle = rgbs(acc, 0.34);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    /* room label + progress pips */
    ctx.textAlign = 'left';
    ctx.font = '700 ' + Math.round(GK.clamp(ph * 0.062, 9, 12)) + 'px ' + MONO;
    ctx.fillStyle = 'rgba(234,246,255,0.45)';
    ctx.fillText('ROOM ' + pad2(clearCard.room + 1) + ' / ' + pad2(ROOMS), px + pw * 0.06, py + ph * 0.16);
    for (var k = 0; k < ROOMS; k++) {
      var pipX = px + pw * 0.06 + k * 11;
      ctx.fillStyle = k < clearCard.room ? 'rgba(124,245,208,0.85)'
        : k === clearCard.room ? acc : 'rgba(234,246,255,0.13)';
      ctx.fillRect(pipX, py + ph * 0.245, 7, 3);
    }

    /* the split */
    ctx.textAlign = 'center';
    ctx.font = '800 ' + Math.round(GK.clamp(ph * 0.27, 26, 54)) + 'px ' + MONO;
    ctx.fillStyle = C.white;
    ctx.shadowColor = rgbs(acc, 0.5);
    ctx.shadowBlur = 16;
    ctx.fillText(fmtMs(clearCard.t), cx, py + ph * 0.6);
    ctx.shadowBlur = 0;

    /* delta vs personal best */
    ctx.font = '700 ' + Math.round(GK.clamp(ph * 0.075, 9, 13)) + 'px ' + MONO;
    if (clearCard.rec) {
      ctx.fillStyle = C.gold;
      ctx.fillText(clearCard.best ? 'NEW BEST' : 'FIRST CLEAR', cx, py + ph * 0.73);
    } else {
      var d = clearCard.t - clearCard.best;
      ctx.fillStyle = d > 0 ? C.red : C.mint;
      ctx.fillText(fmtDelta(d), cx, py + ph * 0.73);
      ctx.fillStyle = 'rgba(234,246,255,0.35)';
      ctx.font = '600 ' + Math.round(GK.clamp(ph * 0.062, 8, 11)) + 'px ' + MONO;
      ctx.fillText('BEST ' + fmtMs(clearCard.best), cx, py + ph * 0.82);
    }

    ctx.fillStyle = 'rgba(234,246,255,' + (0.3 + 0.24 * Math.sin(t * 4)) + ')';
    ctx.font = '600 ' + Math.round(GK.clamp(ph * 0.058, 8, 11)) + 'px ' + MONO;
    ctx.fillText(clearCard.last ? 'TAP FOR THE RUN REPORT' : 'TAP TO CONTINUE', cx, py + ph * 0.93);
    ctx.textAlign = 'center';
    ctx.restore();
  }

  function drawResults(ctx, v, t) {
    if (!result) return;
    var a = GK.clamp(screenT / 0.3, 0, 1);
    ctx.fillStyle = 'rgba(5,6,11,' + (0.86 * a) + ')';
    ctx.fillRect(0, 0, v.w, v.h);

    var pw = Math.min(v.w - 24, 680);
    var ph = Math.min(v.h - 20, 400);
    var px = (v.w - pw) / 2, py = (v.h - ph) / 2;
    var small = GK.clamp(ph * 0.032, 9, 13);
    var i;

    ctx.fillStyle = 'rgba(11,15,25,0.94)';
    rr2(ctx, px, py, pw, ph, 14);
    ctx.fill();
    ctx.strokeStyle = 'rgba(124,245,208,0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();

    /* header */
    ctx.textAlign = 'left';
    ctx.font = '700 ' + Math.round(small * 1.1) + 'px ' + MONO;
    ctx.fillStyle = 'rgba(124,245,208,0.65)';
    ctx.fillText('RUN COMPLETE', px + pw * 0.05, py + ph * 0.13);

    if (result.pb) {
      ctx.textAlign = 'right';
      ctx.fillStyle = C.gold;
      ctx.fillText('NEW BEST', px + pw * 0.95, py + ph * 0.13);
      ctx.textAlign = 'left';
    }

    /* grade */
    var gx = px + pw * 0.2, gy = py + ph * 0.44;
    var gr = Math.min(pw, ph) * 0.15;
    ctx.beginPath();
    ctx.arc(gx, gy, gr, 0, Math.PI * 2);
    ctx.strokeStyle = rgbs(gradeColor(result.grade), 0.28);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(gx, gy, gr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * GK.clamp(screenT / 0.7, 0, 1));
    ctx.strokeStyle = gradeColor(result.grade);
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.font = '700 ' + Math.round(gr * 1.25) + 'px ' + MONO;
    ctx.shadowColor = rgbs(gradeColor(result.grade), 0.7);
    ctx.shadowBlur = 18;
    ctx.fillStyle = gradeColor(result.grade);
    ctx.fillText(result.grade, gx, gy + gr * 0.42);
    ctx.shadowBlur = 0;

    /* totals */
    ctx.font = '700 ' + Math.round(ph * 0.075) + 'px ' + MONO;
    ctx.fillStyle = C.white;
    ctx.fillText(fmtMs(result.total), gx, gy + gr * 1.85);

    ctx.font = '600 ' + Math.round(small) + 'px ' + MONO;
    ctx.fillStyle = 'rgba(234,246,255,0.5)';
    ctx.fillText(result.deaths + ' deaths · ' + result.coins + ' coins', gx, gy + gr * 1.85 + small * 1.7);

    if (best.total) {
      ctx.fillStyle = 'rgba(255,209,102,0.7)';
      ctx.fillText('best ' + fmtMs(best.total), gx, gy + gr * 1.85 + small * 3.2);
    }

    /* splits grid */
    var cols = 3;
    var ox = px + pw * 0.4;
    var gw = (pw * 0.55) / cols;
    var oy = py + ph * 0.3;
    var rowH = ph * 0.155;

    ctx.textAlign = 'left';
    ctx.font = '600 ' + Math.round(small * 0.95) + 'px ' + MONO;
    ctx.fillStyle = 'rgba(234,246,255,0.3)';
    ctx.fillText('SPLITS', ox, py + ph * 0.22);

    for (i = 0; i < ROOMS; i++) {
      var cx = ox + (i % cols) * gw;
      var cy = oy + Math.floor(i / cols) * rowH;
      var sp = result.splits[i];
      ctx.font = '600 ' + Math.round(small) + 'px ' + MONO;
      ctx.fillStyle = 'rgba(234,246,255,0.28)';
      ctx.fillText(pad2(i + 1), cx, cy);
      ctx.fillStyle = sp ? 'rgba(234,246,255,0.88)' : 'rgba(234,246,255,0.16)';
      ctx.fillText(sp ? fmtMs(sp.t) : '—', cx + small * 1.9, cy);
      if (sp && sp.best) {
        ctx.font = '600 ' + Math.round(small * 0.85) + 'px ' + MONO;
        ctx.fillStyle = sp.t <= sp.best ? 'rgba(124,245,208,0.8)' : 'rgba(255,77,109,0.75)';
        ctx.fillText(fmtDelta(sp.t - sp.best), cx + small * 1.9, cy + small * 1.15);
      }
    }

    /* footer */
    var pulse = 0.5 + 0.5 * Math.sin(clock * 3.2);
    ctx.textAlign = 'center';
    ctx.font = '700 ' + Math.round(GK.clamp(ph * 0.04, 9, 15)) + 'px ' + MONO;
    ctx.fillStyle = 'rgba(234,246,255,' + pulse + ')';
    ctx.fillText('TAP TO RUN AGAIN', px + pw / 2, py + ph * 0.955);

    ctx.textAlign = 'left';
  }

  /* ==================================================================
   * RENDER
   * ================================================================== */
  function render(ctx, t, v) {
    view.w = v.w;
    view.h = v.h;
    zoom = GK.clamp(v.h / 430, 0.62, 2.4);

    if (mode === 'title' || !level || !run) {
      drawTitle(ctx, v, t);
      drawControls(ctx, v);
      return;
    }

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, v.w, v.h);

    drawBackdrop(ctx, v);

    ctx.save();
    ctx.translate(shakeX, shakeY);
    ctx.scale(zoom, zoom);
    ctx.translate(-cam.x, -cam.y);
    drawLevel(ctx, t);
    ctx.restore();

    drawScreenFx(ctx, v);
    drawForeground(ctx, v);
    drawHud(ctx, v);
    drawControls(ctx, v);
    if (mode === 'roomClear') drawClearCard(ctx, v, t);
    if (mode === 'results') drawResults(ctx, v, t);
  }

  /* ==================================================================
   * LOOP
   * ================================================================== */
  function pollPress() {
    var a = !!(pad.state.jump || pad.state.hook || pad.state.dash || pad.state.use ||
      manual.jump || manual.hook || tJump.held);
    var edge = a && !anyPrev;
    anyPrev = a;
    return edge;
  }

  function update(dt, t) {
    lastTick = performance.now();
    clock += dt;
    screenT += dt;

    var edge = pollPress();
    if (tapEdge) { tapEdge = false; edge = true; }

    /* the run soundtrack: in on the first input, out on the report, and
     * silenced (with a short fade) by the shared mute toggle */
    AUDIO.tick(dt, !!run && (mode === 'play' || mode === 'roomClear'));

    if (mode === 'title') {
      updateParticles(dt);
      if (screenT > 0.35 && edge) startRun();
      return;
    }
    if (mode === 'results') {
      updateParticles(dt);
      if (screenT > 0.9 && edge) startRun();
      return;
    }
    if (mode === 'roomClear') {
      updateParticles(dt);
      /* one short beat on the split, then roll on by itself: never a stall */
      if ((screenT > 0.16 && edge) || screenT > 0.8) continueRun();
      return;
    }
    step(dt);
  }

  /* ==================================================================
   * TEST HOOK — window.__game
   * ================================================================== */
  function pubState() {
    return {
      started: mode !== 'title',
      room: run ? Math.min(run.room, ROOMS - 1) + 1 : 1,     // 1-based, as the HUD counts rooms
      time: run ? Math.round(run.time * 1000) / 1000 : 0,
      deaths: run ? run.deaths : 0,
      score: run ? run.score : 0,
      onGround: !!P.onGround,
      x: Math.round(P.x * 100) / 100,
      y: Math.round(P.y * 100) / 100
    };
  }

  /* If the rAF loop is stalled (headless, backgrounded tab) advance the sim
   * ourselves so scripted input still produces motion. */
  function pumpStalled() {
    if (mode !== 'play') return;
    var now = performance.now();
    if (!lastTick) lastTick = now;
    var gap = now - lastTick;
    if (gap < 120) return;
    var n = Math.min(120, Math.floor(gap / 16.7));
    for (var i = 0; i < n; i++) step(1 / 60);
    lastTick = performance.now();
  }

  function ensureStarted() {
    if (mode === 'roomClear') { continueRun(); return; }
    if (mode !== 'play') startRun();
  }

  function act(name) {
    try {
      if (name === 'newGame') {
        startRun();
      } else if (name === 'jump') {
        ensureStarted();
        manual.jump = true;
        manual.pulse = true;
      } else if (name === 'hook') {
        ensureStarted();
        manual.hook = !manual.hook;
      } else if (name === 'right') {
        ensureStarted();
        manual.x = 1;
      } else if (name === 'left') {
        ensureStarted();
        manual.x = -1;
      } else if (name === 'stop') {
        manual.x = 0;
        manual.jump = false;
        manual.hook = false;
        manual.pulse = false;
      }
      pumpStalled();
      return true;
    } catch (err) {
      return false;
    }
  }

  window.__game = window.__game || {};
  window.__game.state = pubState;
  window.__game.act = act;

  /* ==================================================================
   * BOOT
   * ================================================================== */
  GK.boot({
    canvas: canvas,
    update: update,
    render: render,
    onResize: function (v) {
      view.w = v.w;
      view.h = v.h;
    }
  });
})();
