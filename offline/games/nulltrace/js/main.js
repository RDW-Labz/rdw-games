/* Nulltrace — a momentum platformer: nine procedurally-built rooms, one grapple
 * hook, and a stopwatch that judges you.
 *
 * Controls
 *   run ....... A / D or <- / ->
 *   jump ...... Space / W / Z   (hold for height, tap for a hop)
 *   grapple ... hold X / Shift / E, or the B pad button
 *   touch ..... drag the left half to run, A jumps, B holds the hook
 *
 * Cross-hybrid lineage: Rift Nine's nine-room grapple course and its run
 * structure, crossed with id's Quake movement — PM_Friction, PM_Accelerate and
 * PM_AirAccelerate at the shipped constants (sv_maxspeed 320, sv_friction 6,
 * sv_stopspeed 100, sv_accelerate 10, sv_airaccelerate 10 with the 30-unit air
 * wishspeed clamp) — and DDNet's speedrun framing: a run clock that never
 * pauses, per-room splits, a medal ladder, and a ghost of your best line.
 * Horizontal movement is Quake's; the vertical arc stays Rift Nine's, because
 * the nine rooms were built around that jump height.
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
  var store = GK.store('nulltrace');

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
  var MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  var UI = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

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
  /* Quake's movement constants, verbatim, at one world px per Quake unit. These
     replace Rift Nine's "accelerate toward a cap" model: speed is only ever
     bled away by friction, and friction itself is capped by stopspeed, so a run
     that arrives fast leaves fast. */
  var SV_MAXSPEED     = 320;    // sv_maxspeed
  var SV_ACCELERATE   = 10;     // sv_accelerate
  var SV_AIRACCELERATE = 10;    // sv_airaccelerate
  var SV_FRICTION     = 6;      // sv_friction
  var SV_STOPSPEED    = 100;    // sv_stopspeed
  var AIR_WISHSPEED   = 30;     // PM_AirAccelerate's wishspeed clamp
  var MAX_RUN         = 300;    // kept for the boost-ceiling maths and the HUD
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
  /* DDNet's ladder, applied to those targets: gold meets par, silver is within a
     third more, bronze within four fifths. Medals are stored per room and never
     downgraded — the same rule DDNet uses for a rank you have already earned. */
  var MEDAL_T = [1.0, 1.35, 1.8];
  var MEDAL_NAME = ['none', 'BRONZE', 'SILVER', 'GOLD'];
  var MEDAL_COL = ['rgba(255,255,255,.18)', '#c98a5a', '#cdd6e4', '#ffd166'];
  function medalFor(room, t) {
    var par = PAR[Math.min(room, PAR.length - 1)];
    if (!par) return 0;
    if (t <= par * MEDAL_T[0]) return 3;
    if (t <= par * MEDAL_T[1]) return 2;
    if (t <= par * MEDAL_T[2]) return 1;
    return 0;
  }

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

  /* presentation-only state — never read by the sim, never part of a save */
  var dust = [];                 // fixed pool, seeded once, recycled forever
  var DUST_N = 64;
  var skyGrad = null, skyKey = '';
  var vigGrad = null, vigKey = '';
  var horizonGrad = null, horizonKey = '';

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
    if (!b.medals || b.medals.length !== ROOMS) b.medals = new Array(ROOMS).join(',').split(',').map(function () { return 0; });
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
        p.vy += (p.kind === 1 ? 0 : 320) * dt;
        p.vx *= 0.97;
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
    var medal = medalFor(i, t);
    var prevMedal = best.medals[i] || 0;
    if (medal > prevMedal) {
      best.medals[i] = medal;
      store.set('medals', best.medals);
    }
    clearCard = { room: i, t: t, best: pb, rec: rec, last: i >= ROOMS - 1,
                  medal: medal, prevMedal: prevMedal, par: PAR[i] || 0,
                  clean: run.deaths === 0 };
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
  /* ---------------------------------------------------------------- *
   * Quake movement primitives. Formulas are id's, transcribed: friction
   * drops `control * sv_friction * dt` where control is at least stopspeed;
   * accelerate adds min(accel * wishspeed * dt, addspeed) along the wish
   * direction. Because air friction does not exist in Quake, anything you
   * carry off a jump is yours until you land.
   * ---------------------------------------------------------------- */
  function pmFriction(dt) {
    var sp = Math.abs(P.vx);
    if (sp < 0.001) { P.vx = 0; return; }
    var control = sp < SV_STOPSPEED ? SV_STOPSPEED : sp;
    var drop = control * SV_FRICTION * dt;
    if (hook.on) drop *= 0.45;            // a rope is not a floor
    var ns = Math.max(0, sp - drop);
    P.vx = P.vx < 0 ? -ns : ns;
  }

  function pmAccelerate(wish, wishspeed, accel, dt) {
    var current = P.vx * wish;
    var addspeed = wishspeed - current;
    if (addspeed <= 0) return;
    var accelspeed = Math.min(accel * wishspeed * dt, addspeed);
    P.vx += wish * accelspeed;
  }

  function step(dt) {
    run.time += dt;
    run.roomTime += dt;
    roomIntro = Math.max(0, roomIntro - dt);
    P.spawnT = Math.max(0, P.spawnT - dt);
    if (hook.miss > 0) hook.miss -= dt;

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
    var wish = dir === 0 ? 0 : (dir > 0 ? 1 : -1);
    var cap = SV_MAXSPEED * boost.mult;

    /* ---- horizontal: Quake's friction, then accelerate (ground) or
       air-accelerate with the 30-unit wishspeed clamp (air) ---- */
    if (P.onGround) {
      pmFriction(dt);
      if (wish !== 0) pmAccelerate(wish, cap, SV_ACCELERATE, dt);
    } else if (wish !== 0) {
      var airwish = Math.min(cap, AIR_WISHSPEED);
      if (hook.on) airwish *= 1.0;        // the rope does not change the clamp
      pmAccelerate(wish, airwish, SV_AIRACCELERATE, dt);
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
    puff(P.x, P.y + P.hh, 3 + Math.round(5 * k), C.white, 0);

    /* dust sprayed along the surface + a low ring wave off the footprint */
    var n = 4 + Math.round(6 * k), d, side, sd;
    for (d = 0; d < n; d++) {
      side = d % 2 ? 1 : -1;
      sd = 34 + Math.random() * 120 * (0.4 + k);
      spawn(P.x + side * (3 + Math.random() * 7), P.y + P.hh - 1 - Math.random() * 3,
        side * sd, -16 - Math.random() * 34 * k,
        0.30 + Math.random() * 0.45, 0.9 + Math.random() * 1.7,
        k > 0.55 ? C.white : C.mint, 1);
    }
    ring(P.x, P.y + P.hh - 1, C.mint, 3, 20 + 26 * k, 0.20);

    if (impact > 430) {
      shake = Math.max(shake, 2.4 * k);
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
   * BACKDROP — parallax strata anchored to the horizon line
   * ================================================================== */
  function drawBackdrop(ctx, v) {
    var key = v.w + 'x' + v.h;
    if (!skyGrad || skyKey !== key) {
      var g = ctx.createLinearGradient(0, 0, 0, v.h);
      g.addColorStop(0, '#0a101c');
      g.addColorStop(0.34, '#0e1728');
      g.addColorStop(0.68, '#16253c');
      g.addColorStop(1, '#1f3450');
      skyGrad = g; skyKey = key;
    }
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, v.w, v.h);

    var hy = (level.gy - cam.y) * zoom;
    var i, sx;

    /* The rift floor can be hundreds of px below the current room, so the
     * skyline is anchored in screen space with only a light vertical drift:
     * every room gets a silhouette backdrop instead of empty sky. */
    var base = GK.clamp(v.h * 0.84 + (level.gy - cam.y) * zoom * 0.045,
      v.h * 0.42, v.h * 1.02);

    /* horizon bloom: light bleeding up out of the rift floor */
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var hg = ctx.createRadialGradient(v.w * 0.5, base, 6, v.w * 0.5, base, v.w * 0.7);
    hg.addColorStop(0, 'rgba(96,176,255,0.20)');
    hg.addColorStop(0.35, 'rgba(96,176,255,0.075)');
    hg.addColorStop(1, 'rgba(90,169,255,0)');
    ctx.fillStyle = hg;
    ctx.fillRect(0, base - v.h * 0.65, v.w, v.h * 1.3);
    ctx.restore();

    /* stars: fine field, a few flare */
    for (i = 0; i < level.stars.length; i++) {
      var s = level.stars[i];
      sx = (s.x - cam.x * 0.1) * zoom;
      var sy = (s.y - cam.y * 0.1) * zoom;
      if (sx < -10 || sx > v.w + 10 || sy < -10 || sy > v.h) continue;
      var tw = 0.5 + 0.5 * Math.sin(clock * 1.15 + s.x * 0.02);
      ctx.fillStyle = 'rgba(186,218,255,' + (s.a * (0.30 + 0.70 * tw)) + ')';
      ctx.fillRect(sx, sy, s.s, s.s);
      if (s.s > 1.7 && tw > 0.88) {
        ctx.fillStyle = 'rgba(210,235,255,' + (s.a * 0.30) + ')';
        ctx.fillRect(sx - 1.6, sy + s.s * 0.4, s.s + 3.2, 0.8);
        ctx.fillRect(sx + s.s * 0.4, sy - 1.6, 0.8, s.s + 3.2);
      }
    }

    /* ---------- layer 0: an infinite distant ridge ----------------------
     * Deterministic from the column index, so it scrolls with the camera and
     * is always present — no level data, no allocation, never an empty sky. */
    var step = 46 * zoom;
    var scroll = cam.x * 0.05 * zoom;
    var k0 = Math.floor(scroll / step);
    var frac = scroll - k0 * step;
    ctx.fillStyle = '#070b13';
    for (var g3 = -1; g3 * step - frac < v.w + step; g3++) {
      var kk = k0 + g3;
      var bw0 = step * (0.52 + hash01(kk * 2.3) * 0.44);
      var bh0 = (16 + hash01(kk * 7.7) * 88) * zoom;
      var bx0 = g3 * step - frac;
      ctx.fillRect(bx0, base - bh0, bw0, bh0 + v.h);
      ctx.fillStyle = 'rgba(112,162,238,0.15)';
      ctx.fillRect(bx0, base - bh0, bw0, 1.2 * zoom);
      ctx.fillStyle = '#070b13';
      var th0 = bh0 * (0.08 + hash01(kk * 5.1) * 0.14);
      ctx.fillRect(bx0 + bw0 * (0.24 + hash01(kk * 9.3) * 0.4), base - bh0 - th0, bw0 * 0.2, th0 + 1);
    }

    /* ---------- layer 1: far skyline, hazed toward the horizon ---------- */
    for (i = 0; i < level.far.length; i++) {
      var f = level.far[i];
      sx = (f.x - cam.x * f.d) * zoom;
      var fw = f.w * zoom;
      var fh = Math.min(f.h * zoom, v.h * 0.30);
      if (sx > v.w + 300 || sx + fw < -300) continue;
      var ftop = base - fh;

      ctx.fillStyle = '#050810';
      ctx.fillRect(sx, ftop, fw, fh + v.h);

      /* stepped crown so the skyline is a silhouette, not a box */
      for (var j = 0; j < 3; j++) {
        var cw = fw * (0.16 + hash01(i * 3.7 + j) * 0.26);
        var ch = fh * (0.05 + hash01(i * 7.1 + j) * 0.12);
        ctx.fillRect(sx + fw * (0.08 + j * 0.29), ftop - ch, cw, ch + 2);
      }
      /* mast + beacon */
      var mx = sx + fw * (0.2 + hash01(i * 1.9) * 0.6);
      var mh = 8 + hash01(i * 5.3) * 26;
      ctx.fillStyle = '#050810';
      ctx.fillRect(mx, ftop - mh, 1.4, mh);
      ctx.fillStyle = 'rgba(255,90,110,' + (0.20 + 0.4 * (0.5 + 0.5 * Math.sin(clock * 1.6 + i))) + ')';
      ctx.fillRect(mx - 0.4, ftop - mh - 1.6, 2.2, 1.6);

      /* vertical shading bands + rim light on the lit face */
      ctx.fillStyle = 'rgba(3,5,10,0.35)';
      ctx.fillRect(sx + fw * 0.62, ftop, fw * 0.38, fh + v.h);
      ctx.fillStyle = 'rgba(138,190,255,0.30)';
      ctx.fillRect(sx, ftop, fw, 1.4);
      ctx.fillStyle = 'rgba(138,190,255,0.09)';
      ctx.fillRect(sx, ftop + 1.4, fw, 9);
    }

    /* haze between the two strata: sells the distance */
    var hz = ctx.createLinearGradient(0, base - 130 * zoom, 0, base + 90 * zoom);
    hz.addColorStop(0, 'rgba(14,24,42,0)');
    hz.addColorStop(0.62, 'rgba(14,24,42,0.34)');
    hz.addColorStop(1, 'rgba(9,15,26,0.72)');
    ctx.fillStyle = hz;
    ctx.fillRect(0, base - 130 * zoom, v.w, 220 * zoom);

    /* drifting creatures behind the near strata */
    drawDecorSky(ctx, v, 0, 0.37);

    /* ---------- layer 2: near skyline, lit windows, mint rim ---------- */
    for (i = 0; i < level.near.length; i++) {
      var n = level.near[i];
      sx = (n.x - cam.x * n.d) * zoom;
      var nw = n.w * zoom;
      var nh = Math.min(n.h * zoom, v.h * 0.26);
      var ntop = base - nh * 0.7;
      if (sx > v.w + 260 || sx + nw < -260) continue;

      ctx.fillStyle = '#02040a';
      ctx.fillRect(sx, ntop, nw, nh + v.h);

      /* a couple of setbacks to break the roofline */
      for (var k = 0; k < 2; k++) {
        var bw = nw * (0.22 + hash01(i * 4.3 + k) * 0.3);
        var bh = nh * (0.04 + hash01(i * 8.9 + k) * 0.09);
        ctx.fillRect(sx + nw * (0.1 + k * 0.36), ntop - bh, bw, bh + 2);
      }

      /* window grid — deterministic, cheap, clipped to the silhouette */
      ctx.save();
      ctx.beginPath(); ctx.rect(sx, ntop, nw, nh * 0.9); ctx.clip();
      var cols = Math.min(16, Math.floor(nw / 17));
      var rows = Math.min(9, Math.floor(nh * 0.8 / 15));
      for (var cx = 0; cx < cols; cx++) {
        for (var cy = 0; cy < rows; cy++) {
          var hsh = hash01(i * 31.7 + cx * 7.3 + cy * 2.9);
          if (hsh < 0.44) continue;
          var wx = sx + 7 + cx * (nw - 14) / Math.max(1, cols);
          var wy = ntop + 9 + cy * (nh * 0.78) / Math.max(1, rows);
          ctx.fillStyle = hsh > 0.88 ? 'rgba(255,209,102,0.70)' : 'rgba(124,245,208,0.40)';
          ctx.fillRect(wx, wy, 2.2, 1.5);
        }
      }
      ctx.restore();

      /* shaded body edge + mint rim along the top */
      ctx.fillStyle = 'rgba(4,7,13,0.42)';
      ctx.fillRect(sx + nw * 0.7, ntop, nw * 0.3, nh + v.h);
      ctx.fillStyle = 'rgba(150,255,228,0.42)';
      ctx.fillRect(sx, ntop, nw, 1.6);
      ctx.fillStyle = 'rgba(150,255,228,0.10)';
      ctx.fillRect(sx, ntop + 1.6, nw, 10);
    }

    /* ---------- fine drifting dust, preallocated pool, zero alloc/frame -- */
    drawDust(ctx, v);

    /* floor fog + horizon accent line */
    var fog = ctx.createLinearGradient(0, base - 30 * zoom, 0, base + 26 * zoom);
    fog.addColorStop(0, 'rgba(9,14,26,0)');
    fog.addColorStop(1, 'rgba(9,14,26,0.78)');
    ctx.fillStyle = fog;
    ctx.fillRect(0, base - 30 * zoom, v.w, 56 * zoom);

    ctx.fillStyle = 'rgba(160,255,232,0.20)';
    ctx.fillRect(0, Math.round(base), v.w, 1);
  }

  /* dust motes live in normalised screen space and wrap on themselves, so
   * the pool is allocated once and only ever re-read each frame */
  function seedDust() {
    dust.length = 0;
    for (var i = 0; i < DUST_N; i++) {
      dust.push({
        x: Math.random(), y: Math.random(),
        s: 0.6 + Math.random() * 1.4,
        sp: 0.22 + Math.random() * 0.9,
        ph: Math.random() * 6.2832,
        a: 0.07 + Math.random() * 0.26
      });
    }
  }

  function drawDust(ctx, v) {
    if (dust.length !== DUST_N) seedDust();
    var i, d, x, y, t = clock;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = '#a8d2ff';
    for (i = 0; i < DUST_N; i++) {
      d = dust[i];
      x = (((d.x + t * 0.0032 * d.sp - cam.x * 0.00032) % 1) + 1) % 1 * v.w;
      y = (((d.y - t * 0.0055 * d.sp - cam.y * 0.0002) % 1) + 1) % 1 * v.h;
      ctx.globalAlpha = d.a * (0.5 + 0.5 * Math.sin(t * 1.7 + d.ph));
      ctx.fillRect(x, y, d.s, d.s);
    }
    ctx.restore();
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
      SPR.draw(ctx, d.k, sx, sy, d.ph, a * 0.42, { sc: 5, smooth: true });
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

  /* ---------- volumetric key light ------------------------------------
   * Three soft shafts falling from the ceiling: they sit behind the geometry
   * and only ever lift the darkness, so the play field reads as a lit room
   * instead of a black rectangle. Purely a paint pass. */
  function drawShafts(ctx) {
    var i, x0, w, g;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (i = 0; i < 3; i++) {
      x0 = cam.x + view.w * (0.14 + i * 0.3) / zoom;
      w = (54 + i * 22) / zoom;
      g = ctx.createLinearGradient(0, cam.y, 0, cam.y + view.h * 0.95 / zoom);
      g.addColorStop(0, 'rgba(124,245,208,0.075)');
      g.addColorStop(0.5, 'rgba(124,245,208,0.028)');
      g.addColorStop(1, 'rgba(124,245,208,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x0, cam.y - 40);
      ctx.lineTo(x0 + w, cam.y - 40);
      ctx.lineTo(x0 + w * 2.1, cam.y + view.h * 1.15 / zoom);
      ctx.lineTo(x0 + w * 0.3, cam.y + view.h * 1.15 / zoom);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function drawLevel(ctx, t) {
    cull.l = cam.x - 80;
    cull.r = cam.x + view.w / zoom + 80;
    cull.t = cam.y;
    cull.b = cam.y + view.h / zoom + 80;

    drawShafts(ctx);
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

  /* ---------- material helpers ----------------------------------------
   * Every solid is drawn as three stacked layers: a shaded body, a lit top
   * edge, and a 1px accent line in the room palette, with procedural
   * masonry/grid inside anything large enough to read as a surface. None
   * of this touches collision geometry — it only paints the same rects. */
  function hash01(n) {
    var v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return v - Math.floor(v);
  }

  /* per-solid body gradient, cached on the solid (geometry never moves) */
  function bodyGrad(ctx, s, top, bot) {
    if (!s._g || s._gk !== s.w + ':' + s.h) {
      var g = ctx.createLinearGradient(0, s.y, 0, s.y + Math.min(s.h, 190));
      g.addColorStop(0, top);
      g.addColorStop(0.5, bot);
      g.addColorStop(1, '#05070c');
      s._g = g;
      s._gk = s.w + ':' + s.h;
    }
    return s._g;
  }

  function drawSolids(ctx) {
    var i, s, x, y, w, h, accent;

    for (i = 0; i < level.solids.length; i++) {
      s = level.solids[i];
      if (s.x > cull.r || s.x + s.w < cull.l) continue;
      x = s.x; y = s.y; w = s.w; h = s.h;
      accent = s.ledge ? C.blue : C.mint;

      if (s.floor) {
        /* ---- floor slab: lit lip, shaded body, masonry courses ---- */
        ctx.fillStyle = bodyGrad(ctx, s, '#1d2f4e', '#0a1320');
        ctx.fillRect(x, y, w, h);

        /* light spilling down off the lip */
        ctx.save();
        ctx.beginPath(); ctx.rect(x, y, w, Math.min(h, 30)); ctx.clip();
        var spill = ctx.createLinearGradient(0, y, 0, y + 30);
        spill.addColorStop(0, 'rgba(124,245,208,0.11)');
        spill.addColorStop(1, 'rgba(124,245,208,0)');
        ctx.fillStyle = spill;
        ctx.fillRect(x, y, w, 30);
        ctx.restore();

        /* masonry: seams + courses, plus dark chips to break the grid */
        if (h > 26 && w > 40) {
          ctx.save();
          ctx.beginPath(); ctx.rect(x, y + 6, w, h - 6); ctx.clip();
          ctx.strokeStyle = 'rgba(126,168,226,0.24)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (var gx = x + 0.5 + hash01(i) * 24; gx < x + w; gx += 52) {
            ctx.moveTo(gx, y + 6); ctx.lineTo(gx, y + h);
          }
          for (var gy = y + 32.5; gy < y + h; gy += 30) {
            ctx.moveTo(x, gy); ctx.lineTo(x + w, gy);
          }
          ctx.stroke();
          ctx.fillStyle = 'rgba(2,4,8,0.62)';
          for (var c = 0; c < 5; c++) {
            ctx.fillRect(x + hash01(i * 7.3 + c) * w,
              y + 16 + hash01(i * 13.7 + c) * Math.max(8, h - 26),
              20 + hash01(i + c * 2.1) * 46, 8);
          }
          ctx.restore();
        }

        /* accent line + its faint echo, in the room palette */
        ctx.strokeStyle = 'rgba(124,245,208,0.50)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y + 4.5); ctx.lineTo(x + w, y + 4.5); ctx.stroke();
        ctx.strokeStyle = 'rgba(124,245,208,0.13)';
        ctx.beginPath(); ctx.moveTo(x, y + 9.5); ctx.lineTo(x + w, y + 9.5); ctx.stroke();

        /* the lit top edge: 2px, near white-hot, then a 1px warm falloff */
        ctx.fillStyle = 'rgba(220,255,246,0.88)';
        ctx.fillRect(x, y, w, 1.7);
        ctx.fillStyle = 'rgba(124,245,208,0.20)';
        ctx.fillRect(x, y + 1.7, w, 1.5);

        /* bolts sunk into the lip */
        ctx.fillStyle = 'rgba(180,225,255,0.26)';
        for (var bx = x + 26; bx < x + w - 8; bx += 104) ctx.fillRect(bx, y + 6, 2, 1);
      } else if (s.ceil) {
        /* ---- ceiling: dark body, lit edge underneath, drip notches ---- */
        ctx.fillStyle = bodyGrad(ctx, s, '#0b1220', '#070a12');
        ctx.fillRect(x, y, w, h);

        if (h > 20) {
          ctx.save();
          ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
          ctx.strokeStyle = 'rgba(112,154,214,0.10)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (var cgx = x + 0.5 + hash01(i + 4) * 24; cgx < x + w; cgx += 76) {
            ctx.moveTo(cgx, y); ctx.lineTo(cgx, y + h);
          }
          ctx.stroke();
          /* notches hanging off the underside */
          ctx.fillStyle = 'rgba(6,9,15,0.9)';
          for (var n = 0; n < 6; n++) {
            var nx = x + hash01(i * 3.1 + n) * w;
            var nw = 5 + hash01(n + i) * 10;
            var nh = 3 + hash01(i * 5.7 + n) * 9;
            ctx.fillRect(nx, y + h - nh, nw, nh);
          }
          ctx.restore();
        }

        ctx.fillStyle = 'rgba(90,169,255,0.30)';
        ctx.fillRect(x, y + h - 1.6, w, 1.6);
        ctx.strokeStyle = 'rgba(124,245,208,0.10)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y + h - 1); ctx.lineTo(x + w, y + h - 1); ctx.stroke();
      } else {
        /* ---- floating platform: machined deck with a hard lit rail ---- */
        ctx.fillStyle = bodyGrad(ctx, s, '#26364f', '#0b1220');
        ctx.fillRect(x, y, w, h);

        /* faint top-light wash + grid inside the deck */
        if (w > 90 || h > 40) {
          ctx.save();
          ctx.beginPath(); ctx.rect(x + 1, y + 3, w - 2, h - 4); ctx.clip();
          ctx.strokeStyle = s.ledge ? 'rgba(96,176,255,0.26)' : 'rgba(124,245,208,0.24)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (var pgx = x + 0.5 + hash01(i * 2.9) * 12; pgx < x + w; pgx += 26) {
            ctx.moveTo(pgx, y + 4); ctx.lineTo(pgx, y + h - 1);
          }
          for (var pgy = y + 11.5; pgy < y + h; pgy += 12) {
            ctx.moveTo(x, pgy); ctx.lineTo(x + w, pgy);
          }
          ctx.stroke();
          ctx.restore();
        }

        /* panel courses on decks and slabs: without them a platform is a flat dark stripe,
           which is exactly how the first pass read at phone scale */
        if (!s.floor && h > 10 && w > 40) {
          ctx.save();
          ctx.beginPath(); ctx.rect(x, y + 3, w, Math.max(1, h - 4)); ctx.clip();
          /* the top few pixels are the deck's upper face, catching light off the rail */
          var face = ctx.createLinearGradient(0, y + 3, 0, y + Math.min(h, 16));
          face.addColorStop(0, 'rgba(150,196,255,0.20)');
          face.addColorStop(1, 'rgba(150,196,255,0)');
          ctx.fillStyle = face;
          ctx.fillRect(x, y + 3, w, Math.min(h - 3, 13));
          ctx.strokeStyle = s.ledge ? 'rgba(126,176,240,0.34)' : 'rgba(126,176,240,0.26)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (var pgx = x + 0.5 + hash01(i + 11) * 20; pgx < x + w; pgx += 44) {
            ctx.moveTo(pgx, y + 3); ctx.lineTo(pgx, y + h);
          }
          for (var pgy = y + 15.5; pgy < y + h; pgy += 13) {
            ctx.moveTo(x, pgy); ctx.lineTo(x + w, pgy);
          }
          ctx.stroke();
          /* alternating panel tones, not just hairlines: at phone scale a 1px seam at 0.3 alpha
             disappears in the downscale, a lit block does not */
          var courseH = 13, panelW = 44, rowIdx = 0;
          for (var cy2 = y + 4; cy2 < y + h; cy2 += courseH, rowIdx++) {
            var offx = (rowIdx % 2) * (panelW / 2);
            for (var bx2 = x - offx; bx2 < x + w; bx2 += panelW) {
              if ((Math.floor(bx2 / panelW) + rowIdx) % 2 === 0) {
                ctx.fillStyle = 'rgba(126,176,240,0.17)';
                ctx.fillRect(bx2 + 1, cy2, panelW - 2, Math.min(courseH - 1, y + h - cy2 - 0.5));
              }
            }
          }
          ctx.fillStyle = 'rgba(2,4,8,0.38)';
          for (var pp = 0; pp < 6; pp++) {
            var pw = 20 + hash01(i * 3.1 + pp) * 40;
            ctx.fillRect(x + hash01(i * 5.7 + pp) * Math.max(1, w - pw),
              y + 8 + hash01(i * 9.3 + pp) * Math.max(1, h - 18), pw, 10);
          }
          ctx.restore();
        }

        /* dark underside shadow so the deck reads as a slab, not a stripe */
        var us = ctx.createLinearGradient(0, y + h - Math.min(h, 14), 0, y + h);
        us.addColorStop(0, 'rgba(2,4,8,0)');
        us.addColorStop(1, 'rgba(2,4,8,0.75)');
        ctx.fillStyle = us;
        ctx.fillRect(x, y + Math.max(2, h - 14), w, Math.min(14, h));

        /* inner shadow directly under the rail: the lip's cast shadow */
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(x + 2, y + 3.2, w - 4, 1.6);

        /* 1px accent under the rail, in the room palette */
        ctx.strokeStyle = s.ledge ? 'rgba(90,169,255,0.50)' : 'rgba(124,245,208,0.52)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y + 3.5); ctx.lineTo(x + w, y + 3.5); ctx.stroke();

        /* the lit rail: 2px, with a soft bloom in the palette colour */
        ctx.save();
        ctx.shadowColor = s.ledge ? 'rgba(90,169,255,0.55)' : 'rgba(124,245,208,0.55)';
        ctx.shadowBlur = 7;
        ctx.fillStyle = 'rgba(226,255,250,0.90)';
        ctx.fillRect(x, y, w, 1.8);
        ctx.fillStyle = s.ledge ? 'rgba(90,169,255,0.86)' : 'rgba(124,245,208,0.86)';
        ctx.fillRect(x, y + 1.8, w, 1.1);
        ctx.restore();

        /* end caps + rivets */
        ctx.fillStyle = 'rgba(9,13,22,0.85)';
        ctx.fillRect(x, y + 2.9, 2.2, h - 2.9);
        ctx.fillRect(x + w - 2.2, y + 2.9, 2.2, h - 2.9);
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.45;
        ctx.fillRect(x, y + 2.9, 1.4, Math.max(1, h - 3.5));
        ctx.fillRect(x + w - 1.4, y + 2.9, 1.4, Math.max(1, h - 3.5));
        ctx.globalAlpha = 1;
        if (w > 60 && h > 10) {
          ctx.fillStyle = 'rgba(190,230,255,0.22)';
          ctx.fillRect(x + 9, y + 7, 1.6, 1.6);
          ctx.fillRect(x + w - 11, y + 7, 1.6, 1.6);
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

  function bodyPath(ctx) {
    rr2(ctx, -P.hw, -P.hh, P.hw * 2, P.hh * 2, 6.5);
  }

  function drawGhost(ctx) {
    var gp = ghostPos();
    if (!gp) return;
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.translate(gp.x, gp.y);
    bodyPath(ctx);
    ctx.fillStyle = C.mint;
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = 0.32;
    ctx.strokeStyle = C.mint;
    ctx.lineWidth = 1;
    ctx.translate(gp.x, gp.y);
    bodyPath(ctx);
    ctx.stroke();
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

  function drawRope(ctx) {
    if (!hook.on) return;

    /* soft glow, core, then a hot filament */
    ropePath(ctx);
    ctx.strokeStyle = 'rgba(124,245,208,0.16)';
    ctx.lineWidth = 5.4;
    ctx.stroke();
    ropePath(ctx);
    ctx.strokeStyle = 'rgba(124,245,208,0.55)';
    ctx.lineWidth = 2.0;
    ctx.stroke();
    ropePath(ctx);
    ctx.strokeStyle = 'rgba(226,255,250,0.78)';
    ctx.lineWidth = 0.6;
    ctx.stroke();

    /* the tip lands hot and fades back to a resting ember */
    var tf = GK.clamp(1 - hook.t / 0.9, 0.18, 1);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.shadowColor = 'rgba(124,245,208,0.9)';
    ctx.shadowBlur = 9 + 20 * tf;
    ctx.beginPath();
    ctx.arc(hook.ax, hook.ay, 2.1 + 2.8 * tf, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(236,255,250,' + (0.55 + 0.42 * tf) + ')';
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(124,245,208,' + (0.50 * tf) + ')';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(hook.ax, hook.ay, 4.4 + 4.2 * (1 - tf), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    /* one pulse running the rope, so the line reads as live tension */
    var u = (clock * 1.35) % 1;
    var px = GK.lerp(P.x, hook.ax, u), py = GK.lerp(P.y, hook.ay, u);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(232,255,252,0.60)';
    ctx.beginPath();
    ctx.arc(px, py, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /* nearest surface directly under a point — presentation only, used to pin
   * the contact shadow to the floor the player is actually standing over */
  function groundBelow(x, y) {
    var best = y + 300, i, s;
    for (i = 0; i < level.solids.length; i++) {
      s = level.solids[i];
      if (x < s.x - 3 || x > s.x + s.w + 3) continue;
      if (s.y < y - 2) continue;
      if (s.y < best) best = s.y;
    }
    return best;
  }

  var charGrad = null, headGrad = null, visorGrad = null;

  function drawPlayer(ctx) {
    var sp = Math.sqrt(P.vx * P.vx + P.vy * P.vy);
    var i, tr, a;

    if (!charGrad) {
      charGrad = ctx.createLinearGradient(0, -9, 0, 4);
      charGrad.addColorStop(0, '#37997f');
      charGrad.addColorStop(0.55, '#17544c');
      charGrad.addColorStop(1, '#081c22');
      headGrad = ctx.createLinearGradient(0, -18, 0, -7);
      headGrad.addColorStop(0, '#48b39a');
      headGrad.addColorStop(1, '#0d2b30');
      visorGrad = ctx.createLinearGradient(-2.6, -14, 3.4, -11);
      visorGrad.addColorStop(0, '#7cf5d0');
      visorGrad.addColorStop(1, '#ffd166');
    }

    /* ---------- contact shadow, soft, stays on the surface below ---------- */
    var gy = groundBelow(P.x, P.y + P.hh * 0.4);
    var dropH = GK.clamp(gy - (P.y + P.hh), 0, 260);
    var shA = 0.34 * (1 - dropH / 300);
    if (shA > 0.012) {
      var srx = 13 - dropH * 0.022;
      if (srx > 2) {
        ctx.save();
        var sg = ctx.createRadialGradient(P.x, gy - 1, 0, P.x, gy - 1, srx);
        sg.addColorStop(0, 'rgba(0,0,0,' + shA + ')');
        sg.addColorStop(0.5, 'rgba(0,0,0,' + (shA * 0.6) + ')');
        sg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = sg;
        ctx.beginPath();
        ctx.ellipse(P.x, gy - 1.2, srx, srx * 0.28, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    /* aura: a soft pool of mint light so the character never sinks into the
     * dark backdrop — the 2D stand-in for a rim light plus bloom */
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var au = ctx.createRadialGradient(P.x, P.y - 3, 2, P.x, P.y - 3, 34);
    au.addColorStop(0, 'rgba(124,245,208,0.14)');
    au.addColorStop(0.5, 'rgba(124,245,208,0.05)');
    au.addColorStop(1, 'rgba(124,245,208,0)');
    ctx.fillStyle = au;
    ctx.fillRect(P.x - 36, P.y - 38, 72, 76);
    ctx.restore();

    /* motion trail */
    if (!hook.on) {
      for (i = 0; i < P.trail.length; i += 2) {
        tr = P.trail[i];
        a = (i + 1) / P.trail.length;
        ctx.fillStyle = 'rgba(124,245,208,' + (0.05 * a * a) + ')';
        rr2(ctx, tr.x - P.hw, tr.y - P.hh, P.hw * 2, P.hh * 2, 6.5);
        ctx.fill();
      }
    }

    var vstr = GK.clamp(Math.abs(P.vy) / 1900, 0, 0.26);
    var hstr = GK.clamp(Math.abs(P.vx) / 2400, 0, 0.16);
    var sx = P.sx * (1 - vstr * 0.45) * (1 + hstr);
    var sy = P.sy * (1 + vstr) * (1 - hstr * 0.25);

    /* run cycle is a pure function of travelled distance, so the stride
     * matches the ground speed exactly and nothing new enters the sim */
    var stride = P.x * 0.088;
    var grounded = P.onGround && Math.abs(P.vx) > 26;
    var s1 = grounded ? Math.sin(stride) : 0;
    var s2 = grounded ? Math.sin(stride + Math.PI) : 0;
    var tuck = GK.clamp(P.vy / 900, -1, 1);
    var breathe = Math.sin(clock * 2.1) * 0.5;

    ctx.save();
    ctx.translate(P.x, P.y);
    ctx.rotate(GK.clamp(P.vx / 7200, -0.09, 0.09));
    /* squash/stretch anchored at the feet: he compresses into the floor */
    ctx.translate(0, P.hh);
    /* visual overhang only: the drawn character is 12% taller than its
     * collision box, anchored at the feet, so detail reads on a phone */
    ctx.scale(sx * 1.12, sy * 1.12);
    ctx.translate(0, -P.hh);
    ctx.scale(P.face, 1);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    /* ---------- legs (behind the torso) ---------- */
    function leg(hipX, hipY, kneeX, kneeY, footX, footY, dark, w) {
      ctx.strokeStyle = dark;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(hipX, hipY);
      ctx.lineTo(kneeX, kneeY);
      ctx.lineTo(footX, footY);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(140,255,226,0.62)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(hipX, hipY);
      ctx.lineTo(kneeX, kneeY);
      ctx.stroke();
      ctx.fillStyle = 'rgba(12,40,44,0.98)';
      ctx.beginPath();
      ctx.ellipse(footX + 1.0, footY + 0.4, 3.0, 1.9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(150,255,232,0.75)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(footX - 1.6, footY + 1.9);
      ctx.lineTo(footX + 3.2, footY + 1.9);
      ctx.stroke();
    }

    if (grounded) {
      leg(-1.2, 3.0, -1.2 + s2 * 3.2, 8.6, -1.2 + s2 * 5.2, 13.0 - Math.max(0, s2) * 1.4, '#1e6a5f', 3.4);
    } else {
      leg(-1.4, 3.0, -2.6 - tuck * 1.4, 8.4, -3.6 - tuck * 2.2, 11.4 + tuck * 1.4, '#1e6a5f', 3.4);
    }

    /* ---------- back arm ---------- */
    ctx.strokeStyle = '#17594f';
    ctx.lineWidth = 3.0;
    ctx.beginPath();
    ctx.moveTo(-1.6, -5.6);
    ctx.lineTo(-3.2 + (grounded ? s1 * 2.2 : -1.6), -1.0);
    ctx.lineTo(-4.2 + (grounded ? s1 * 3.0 : -2.6), 3.2);
    ctx.stroke();

    /* ---------- ribbon trailing off the neck (reads as speed) ---------- */
    var rib = GK.clamp(sp / 900, 0, 1);
    if (rib > 0.08) {
      ctx.strokeStyle = 'rgba(124,245,208,' + (0.22 + rib * 0.4) + ')';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-3.4, -8.6);
      ctx.quadraticCurveTo(-8 - rib * 5, -7 + Math.sin(clock * 9 + stride) * 2.4,
        -12 - rib * 8, -3.6 + Math.sin(clock * 7.3) * 3.6);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,209,102,0.30)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-3.4, -8.0);
      ctx.quadraticCurveTo(-7 - rib * 5, -5.4 + Math.cos(clock * 8) * 2.2,
        -10.4 - rib * 7, -1.4 + Math.cos(clock * 6.1) * 3.0);
      ctx.stroke();
    }

    /* ---------- torso: rim light first, then the lit body over it ------- */
    var bob = grounded ? Math.abs(s1) * -0.7 : breathe * 0.5;
    ctx.save();
    ctx.translate(0, bob);

    function torsoPath() {
      ctx.beginPath();
      ctx.moveTo(-4.7, -7.6);
      ctx.quadraticCurveTo(-5.6, -2.2, -3.6, 3.7);
      ctx.lineTo(3.4, 3.7);
      ctx.quadraticCurveTo(5.0, -2.2, 4.3, -7.6);
      ctx.quadraticCurveTo(0, -9.4, -4.7, -7.6);
      ctx.closePath();
    }

    /* cyan rim: the same silhouette offset up-left, behind the fill */
    ctx.save();
    ctx.translate(-1.3, -1.4);
    torsoPath();
    ctx.strokeStyle = 'rgba(124,245,208,0.75)';
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.restore();

    torsoPath();
    ctx.fillStyle = charGrad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(174,255,238,0.85)';
    ctx.lineWidth = 1.1;
    ctx.stroke();

    /* chest light */
    ctx.save();
    ctx.shadowColor = 'rgba(255,209,102,0.9)';
    ctx.shadowBlur = 7;
    ctx.fillStyle = 'rgba(255,214,120,0.95)';
    ctx.fillRect(0.2, -3.4, 2.6, 1.5);
    ctx.restore();
    /* shoulder plate catching the key light */
    ctx.fillStyle = 'rgba(214,255,248,0.34)';
    ctx.fillRect(-3.6, -7.0, 6.6, 1.4);

    /* ---------- head ---------- */
    ctx.save();
    ctx.translate(0.9, -12.6);
    ctx.beginPath();
    ctx.arc(0, 0, 5.3, 0, Math.PI * 2);
    ctx.fillStyle = headGrad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(178,255,240,0.9)';
    ctx.lineWidth = 1.1;
    ctx.stroke();
    /* helmet crest */
    ctx.strokeStyle = 'rgba(124,245,208,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 5.3, Math.PI * 1.05, Math.PI * 1.75);
    ctx.stroke();
    /* visor: warm focal accent, the one amber note on the character */
    ctx.save();
    ctx.shadowColor = 'rgba(255,209,102,0.95)';
    ctx.shadowBlur = 9;
    rr2(ctx, 0.4, -1.9, 4.6, 2.7, 1.3);
    ctx.fillStyle = visorGrad;
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(1.4, -1.4, 1.6, 2.0);
    /* antenna + beacon */
    ctx.strokeStyle = 'rgba(124,245,208,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-2.4, -4.2);
    ctx.lineTo(-4.6, -8.6);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,120,140,' + (0.35 + 0.45 * (0.5 + 0.5 * Math.sin(clock * 3.4))) + ')';
    ctx.beginPath();
    ctx.arc(-4.6, -8.6, 1.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    /* ---------- front leg ---------- */
    if (grounded) {
      leg(1.0, 3.0, 1.0 + s1 * 3.6, 8.8, 1.0 + s1 * 6.0, 13.2 - Math.max(0, s1) * 1.8, '#2f8f7a', 3.6);
    } else {
      leg(1.0, 3.0, 2.6 + tuck * 1.8, 8.2, 4.4 + tuck * 2.4, 11.6 - tuck * 1.6, '#2f8f7a', 3.6);
    }

    /* ---------- front arm: reaches for the hook when it is out ---------- */
    if (hook.on) {
      var ha = Math.atan2(hook.ay - P.y, (hook.ax - P.x) * P.face);
      var hx = 3.0 + Math.cos(ha) * 9.4;
      var hy2 = -5.2 + Math.sin(ha) * 9.4;
      ctx.strokeStyle = '#2b8073';
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(2.6, -5.4);
      ctx.lineTo(3.0 + Math.cos(ha) * 5.2, -5.2 + Math.sin(ha) * 5.2);
      ctx.lineTo(hx, hy2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(226,255,250,0.9)';
      ctx.beginPath();
      ctx.arc(hx, hy2, 1.7, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = '#38a08c';
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(2.6, -5.4);
      ctx.lineTo(4.4 + (grounded ? -s1 * 2.4 : 1.6), -1.0);
      ctx.lineTo(3.8 + (grounded ? -s1 * 3.4 : 3.4), 3.4);
      ctx.stroke();
      ctx.fillStyle = 'rgba(160,255,236,0.85)';
      ctx.beginPath();
      ctx.arc(3.8 + (grounded ? -s1 * 3.4 : 3.4), 3.4, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore(); /* bob */

    ctx.restore(); /* character frame */

    /* ---------- heel kick dust while running ---------- */
    if (P.onGround && Math.abs(P.vx) > 210) {
      var kick = GK.clamp((Math.abs(P.vx) - 210) / 700, 0, 1);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (i = 0; i < 3; i++) {
        var ph2 = (clock * 6 + i * 0.9) % 1;
        var kx = P.x - P.face * (6 + ph2 * 16);
        var ky = P.y + P.hh - 1 - ph2 * 5;
        ctx.fillStyle = 'rgba(160,220,255,' + (0.18 * kick * (1 - ph2)) + ')';
        ctx.fillRect(kx, ky, 2.2 - ph2, 2.2 - ph2);
      }
      ctx.restore();
    }

    /* spawn shimmer */
    if (P.spawnT > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(124,245,208,' + (P.spawnT * 0.35) + ')';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(P.x, P.y, 16 + (1 - P.spawnT) * 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    drawSpeedLines(ctx, sp);
  }

  /* streaks trail the velocity vector — world space, no allocations */
  function drawSpeedLines(ctx, sp) {
    if (sp < 560) return;
    var k = GK.clamp((sp - 560) / 900, 0, 1);
    var dx = P.vx / sp, dy = P.vy / sp;
    var nx = -dy, ny = dx;
    var n = 3 + Math.floor(k * 8);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (var i = 0; i < n; i++) {
      var off = (hash01(i * 12.3) - 0.5) * 40;
      var back = 16 + hash01(i * 5.7) * 12;
      var len = 14 + k * 56 * (0.45 + hash01(i * 9.1));
      var wob = Math.sin(clock * 7.3 + i * 1.7) * 2.6;
      var ax = P.x - dx * back + nx * (off + wob);
      var ay = P.y - dy * back + ny * (off + wob);
      var bx = ax - dx * len, by = ay - dy * len;
      ctx.strokeStyle = (i % 3 === 0)
        ? 'rgba(124,245,208,' + (0.13 * k) + ')'
        : 'rgba(205,236,255,' + (0.15 * k) + ')';
      ctx.lineWidth = 0.9 + (1 - i / n) * 0.9;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.fillStyle = 'rgba(232,255,252,' + (0.22 * k) + ')';
      ctx.fillRect(ax - 1.1, ay - 1.1, 2.2, 2.2);
    }
    ctx.restore();
  }

  function drawParticles(ctx) {
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var a = p.life / p.max;
      if (p.kind === 2) {
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
  function drawScreenFx(ctx, v) {
    var sp = Math.sqrt(P.vx * P.vx + P.vy * P.vy);

    /* speed rush: mint bloom pushed in from the frame edges */
    if (sp > 400) {
      var a = GK.clamp((sp - 400) / 900, 0, 0.3);
      var g = ctx.createRadialGradient(v.w / 2, v.h / 2, v.h * 0.26, v.w / 2, v.h / 2, v.h * 0.92);
      g.addColorStop(0, 'rgba(124,245,208,0)');
      g.addColorStop(0.7, 'rgba(124,245,208,' + (a * 0.5) + ')');
      g.addColorStop(1, 'rgba(124,245,208,' + a + ')');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, v.w, v.h);
    }

    /* edge streaks at speed — screen space, streaks off the top and bottom */
    if (sp > 700) {
      var k = GK.clamp((sp - 700) / 1000, 0, 1);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = 1;
      for (var i = 0; i < 7; i++) {
        var side = i % 2 ? 1 : -1;
        var yy = ((clock * (760 + i * 60) + i * 149) % (v.h + 240)) - 120;
        var lx = side < 0 ? 0 : v.w;
        var ln = 40 + hash01(i * 3.1) * 90;
        ctx.strokeStyle = 'rgba(190,230,255,' + (0.09 * k) + ')';
        ctx.beginPath();
        ctx.moveTo(lx - side * 4, yy);
        ctx.lineTo(lx - side * (4 + ln * 0.10), yy + (P.vy >= 0 ? ln : -ln) * 0.45);
        ctx.stroke();
      }
      ctx.restore();
    }

    /* foreground strata: two dark pillars in front of the level, with a
     * hairline rim on their inner edge — the frame gains back-to-front
     * depth without any extra simulation or assets */
    var inL = v.w * 0.052, inR = v.w * 0.948;
    ctx.fillStyle = 'rgba(2,4,9,0.88)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(inL * 0.86, 0);
    ctx.quadraticCurveTo(inL * 0.72, v.h * 0.34, inL * 0.94, v.h * 0.62);
    ctx.quadraticCurveTo(inL * 0.70, v.h * 0.84, inL * 0.80, v.h);
    ctx.lineTo(0, v.h);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(v.w, 0);
    ctx.lineTo(inR * 1.14, 0);
    ctx.quadraticCurveTo(inR * 1.28, v.h * 0.34, inR * 1.06, v.h * 0.62);
    ctx.quadraticCurveTo(inR * 1.30, v.h * 0.84, inR * 1.20, v.h);
    ctx.lineTo(v.w, v.h);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,200,255,0.13)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(inL * 0.86, 0);
    ctx.quadraticCurveTo(inL * 0.72, v.h * 0.34, inL * 0.94, v.h * 0.62);
    ctx.quadraticCurveTo(inL * 0.70, v.h * 0.84, inL * 0.80, v.h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(inR * 1.14, 0);
    ctx.quadraticCurveTo(inR * 1.28, v.h * 0.34, inR * 1.06, v.h * 0.62);
    ctx.quadraticCurveTo(inR * 1.30, v.h * 0.84, inR * 1.20, v.h);
    ctx.stroke();

    /* vignette over the play field, cached per viewport size */
    var vk = v.w + 'x' + v.h;
    if (!vigGrad || vigKey !== vk) {
      var vg = ctx.createRadialGradient(v.w / 2, v.h * 0.46, Math.min(v.w, v.h) * 0.30,
        v.w / 2, v.h * 0.48, Math.max(v.w, v.h) * 0.80);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(0.55, 'rgba(4,6,12,0.16)');
      vg.addColorStop(1, 'rgba(2,3,8,0.62)');
      vigGrad = vg;
      vigKey = vk;
    }
    ctx.fillStyle = vigGrad;
    ctx.fillRect(0, 0, v.w, v.h);

    if (hurtFlash > 0) {
      ctx.fillStyle = 'rgba(255,77,109,' + (hurtFlash * 0.2) + ')';
      ctx.fillRect(0, 0, v.w, v.h);
    }
  }

  function drawHud(ctx, v) {
    if (!run) return;

    /* ---- one type scale for every reading --------------------------------
     * labels are the 9.5px uppercase token with tracking, numbers are the
     * 700 12px tabular token; both ride hudScale so the label never lands
     * under 11px effective on small phones. */
    var hudScale = GK.clamp(v.h / 430, 1.16, 1.42);
    var lab = Math.round(9.5 * hudScale);
    var num = Math.round(12 * hudScale);
    var pad = Math.max(9, Math.round(v.h * 0.03));
    var i, x, y;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    function setLab() {
      ctx.font = '600 ' + lab + 'px ' + MONO;
      ctx.letterSpacing = '0.10em';
    }
    function setNum(size) {
      ctx.font = '700 ' + (size || num) + 'px ' + MONO;
      ctx.letterSpacing = '0em';
    }
    function measure(t, isNum) {
      if (isNum) setNum(); else setLab();
      return ctx.measureText(t).width;
    }
    /* a reading chip: rgba(8,10,14,.8) plate, hairline border, lit top edge */
    function chip(cx, cy, cw, chh, accent) {
      rr2(ctx, cx + 0.5, cy + 0.5, cw, chh, 5);
      ctx.fillStyle = 'rgba(8,10,14,0.80)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(234,246,255,0.085)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.strokeStyle = accent || 'rgba(234,246,255,0.10)';
      ctx.beginPath();
      ctx.moveTo(cx + 5.5, cy + 1);
      ctx.lineTo(cx + cw - 4.5, cy + 1);
      ctx.stroke();
    }

    /* ---- ROOM chip: label, reading, and the nine-room pip strip ---- */
    var roomVal = pad2(run.room + 1) + ' / ' + pad2(ROOMS);
    var pipsW = ROOMS * 6 + (ROOMS - 1) * 3;
    var roomW = Math.max(measure('ROOM'), measure(roomVal, 1), pipsW) + 16;
    var roomH = lab + num + 22;
    chip(pad, pad, roomW, roomH, 'rgba(124,245,208,0.34)');
    setLab();
    ctx.fillStyle = 'rgba(124,245,208,0.60)';
    ctx.fillText('ROOM', pad + 8, pad + lab + 2);
    setNum();
    ctx.fillStyle = C.white;
    ctx.fillText(roomVal, pad + 8, pad + lab + num + 4);

    for (i = 0; i < ROOMS; i++) {
      x = pad + 8 + i * 9;
      y = pad + roomH - 9;
      ctx.fillStyle = i < run.room ? 'rgba(124,245,208,0.85)'
        : i === run.room ? 'rgba(255,209,102,0.95)'
        : 'rgba(255,255,255,0.12)';
      ctx.fillRect(x, y, 6, 2.6);
    }
    var stackY = pad + roomH + 6;

    /* ---- medals earned so far, same chip grammar ---- */
    var golds = 0;
    for (i = 0; i < ROOMS; i++) if ((best.medals[i] || 0) === 3) golds++;
    var medVal = golds + ' / ' + ROOMS;
    setLab();
    var medLabW = ctx.measureText(MEDAL_NAME[3]).width;
    setNum();
    var medW = medLabW + ctx.measureText(medVal).width + 28;
    var medH = num + 13;
    chip(pad, stackY, medW, medH, 'rgba(255,209,102,0.32)');
    setLab();
    ctx.fillStyle = 'rgba(255,209,102,0.55)';
    ctx.fillText(MEDAL_NAME[3], pad + 8, stackY + num + 3);
    setNum();
    ctx.fillStyle = 'rgba(255,209,102,0.96)';
    ctx.fillText(medVal, pad + medW - 8 - ctx.measureText(medVal).width, stackY + num + 3);
    stackY += medH + 6;

    /* ---- TIME chip, top-centre: reading over a par-budget bar ---- */
    var timeTxt = fmtMs(run.time);
    var timeSize = Math.round(num * 1.34);
    var parNow = PAR[Math.min(run.room, PAR.length - 1)];
    var pacc = parNow ? run.roomTime - parNow : 0;

    setLab();
    var tLabW = ctx.measureText('TIME').width;
    setNum(timeSize);
    var timeW = Math.max(ctx.measureText(timeTxt).width, tLabW) + 30;
    var timeH = lab + timeSize + 20;
    var tx = Math.round((v.w - timeW) / 2);
    chip(tx, pad, timeW, timeH, 'rgba(124,245,208,0.30)');

    ctx.textAlign = 'center';
    setLab();
    ctx.fillStyle = 'rgba(124,245,208,0.55)';
    ctx.fillText('TIME', v.w / 2, pad + lab + 2);
    setNum(timeSize);
    ctx.fillStyle = C.white;
    ctx.fillText(timeTxt, v.w / 2, pad + lab + timeSize + 5);

    if (parNow) {
      var frac = GK.clamp(run.roomTime / parNow, 0, 1);
      var bwid = timeW - 16;
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(tx + 8, pad + timeH - 9, bwid, 2);
      ctx.fillStyle = frac < 1 ? 'rgba(124,245,208,0.85)' : 'rgba(255,77,109,0.9)';
      ctx.fillRect(tx + 8, pad + timeH - 9, bwid * frac, 2);
    }

    /* ---- PAR + room-PB readings, centred chips under the timer ---- */
    var pbr = best.rooms[run.room];
    var pbd = pbr ? run.roomTime - pbr : 0;
    /* the par row sits below whichever of the two top blocks is taller, so
     * the left column and the centre column can never overlap */
    var rowY = Math.max(pad + timeH, stackY) + 6;
    var rowH = num + 13;
    var groups = [];
    if (parNow) {
      groups.push(['PAR ' + parNow.toFixed(0) + 's', fmtDelta(pacc),
        pacc <= 0 ? 'rgba(124,245,208,0.95)' : 'rgba(255,209,102,0.95)',
        'rgba(255,209,102,0.26)']);
    }
    if (pbr) {
      groups.push(['PB', fmtDelta(pbd),
        pbd <= 0 ? 'rgba(124,245,208,0.95)' : 'rgba(255,77,109,0.92)',
        'rgba(124,245,208,0.22)']);
    }
    function chipW(lbl, val) {
      setLab(); var a = ctx.measureText(lbl).width;
      setNum(); var b = ctx.measureText(val).width;
      return a + b + 26;
    }
    function readingChip(cx, cy, lbl, val, valColor, accent) {
      var w = chipW(lbl, val);
      chip(cx, cy, w, rowH, accent);
      setLab();
      ctx.fillStyle = 'rgba(234,246,255,0.42)';
      ctx.fillText(lbl, cx + 8, cy + num + 3);
      setNum();
      ctx.fillStyle = valColor;
      ctx.fillText(val, cx + w - 8 - ctx.measureText(val).width, cy + num + 3);
      return w;
    }
    var grp = 0;
    for (i = 0; i < groups.length; i++) grp += chipW(groups[i][0], groups[i][1]) + (i ? 6 : 0);
    var gx = Math.round(v.w / 2 - grp / 2);
    ctx.textAlign = 'left';
    for (i = 0; i < groups.length; i++) {
      gx += readingChip(gx, rowY, groups[i][0], groups[i][1], groups[i][2], groups[i][3]) + 6;
    }

    /* ---- BEST / DEATHS / BOOST chips, top-right ---- */
    function rightChip(cy, lbl, val, valColor, accent) {
      var w = chipW(lbl, val);
      var x0 = v.w - pad - w;
      chip(x0, cy, w, rowH, accent);
      setLab();
      ctx.fillStyle = 'rgba(234,246,255,0.42)';
      ctx.fillText(lbl, x0 + 8, cy + num + 3);
      setNum();
      ctx.fillStyle = valColor;
      ctx.fillText(val, x0 + w - 8 - ctx.measureText(val).width, cy + num + 3);
      return w;
    }

    var rY = pad;
    rightChip(rY, 'BEST', best.total ? fmtMs(best.total) : '—',
      'rgba(234,246,255,0.70)', 'rgba(234,246,255,0.12)');
    rY += rowH + 6;
    rightChip(rY, 'DEATHS', '' + run.deaths,
      run.deaths ? 'rgba(255,77,109,0.95)' : 'rgba(234,246,255,0.38)',
      run.deaths ? 'rgba(255,77,109,0.30)' : 'rgba(234,246,255,0.10)');
    rY += rowH + 6;

    if (boost.mult > 1.02) {
      var bVal = '×' + boost.mult.toFixed(1);
      var bw = chipW('BOOST', bVal);
      var bx = v.w - pad - bw;
      var bh = rowH + 6;
      chip(bx, rY, bw, bh, 'rgba(255,209,102,0.42)');
      setLab();
      ctx.fillStyle = 'rgba(255,209,102,0.58)';
      ctx.fillText('BOOST', bx + 8, rY + num + 3);
      setNum();
      ctx.fillStyle = C.gold;
      ctx.fillText(bVal, bx + bw - 8 - ctx.measureText(bVal).width, rY + num + 3);
      var bfrac = GK.clamp((boost.mult - 1) / (BOOST_MAX - 1), 0, 1);
      ctx.fillStyle = 'rgba(255,209,102,0.16)';
      ctx.fillRect(bx + 8, rY + bh - 8, bw - 16, 2);
      ctx.fillStyle = 'rgba(255,209,102,0.95)';
      ctx.fillRect(bx + 8, rY + bh - 8, (bw - 16) * bfrac, 2);
    }

    ctx.letterSpacing = '0px';
    ctx.textAlign = 'left';

    /* ---- exit marker when the portal is off-screen ---- */
    var pr = level.portal;
    var sx = (pr.x + pr.w / 2 - cam.x) * zoom;
    if (sx > v.w - 16) {
      var my = GK.clamp((pr.y + 30 - cam.y) * zoom, v.h * 0.3, v.h * 0.68);
      ctx.fillStyle = 'rgba(124,245,208,' + (0.35 + 0.25 * Math.sin(clock * 5)) + ')';
      ctx.beginPath();
      ctx.moveTo(v.w - 8, my);
      ctx.lineTo(v.w - 18, my - 6);
      ctx.lineTo(v.w - 18, my + 6);
      ctx.closePath();
      ctx.fill();
    }

    /* ---- room banner ---- */
    if (roomIntro > 0) {
      var a = GK.clamp(roomIntro / 0.35, 0, 1);
      ctx.textAlign = 'center';
      ctx.font = '700 ' + Math.round(v.h * 0.085) + 'px ' + MONO;
      ctx.fillStyle = 'rgba(234,246,255,' + (0.14 * a) + ')';
      ctx.fillText('RIFT ' + pad2(run.room + 1), v.w / 2, v.h * 0.5);
      if (run.room === 0 && roomIntro > 0.25) {
        ctx.font = '600 ' + lab + 'px ' + UI;
        ctx.fillStyle = 'rgba(234,246,255,' + (0.55 * a) + ')';
        ctx.fillText('hold B / X to grapple — pads only pay out if you arrive fast',
          v.w / 2, v.h * 0.5 + lab * 2.6);
      }
    }
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
    if (clearCard.medal) {
      ctx.textAlign = 'center';
      ctx.font = '700 ' + Math.round(ph * 0.055) + 'px ' + MONO;
      ctx.fillStyle = MEDAL_COL[clearCard.medal];
      ctx.fillText(MEDAL_NAME[clearCard.medal] + (clearCard.medal > clearCard.prevMedal ? '  NEW' : ''),
                   px + pw / 2, py + ph * 0.30);
      if (clearCard.clean) {
        ctx.font = '600 ' + Math.round(ph * 0.032) + 'px ' + MONO;
        ctx.fillStyle = 'rgba(124,245,208,0.85)';
        ctx.fillText('NO-DEATH ROOM', px + pw / 2, py + ph * 0.37);
      }
    }
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
    drawHud(ctx, v);
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
      y: Math.round(P.y * 100) / 100,
      total: run ? Math.round(run.time * 100) / 100 : 0,
      medals: run ? best.medals.join(',') : '',
      golds: best.medals.filter ? best.medals.filter(function (m) { return m === 3; }).length : 0,
      par: PAR[Math.min(run ? run.room : 0, PAR.length - 1)]
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
      } else if (name === 'medalProbe') {
        // expose the ladder so a test can assert the thresholds, not just the paint
        return medalFor(run ? run.room : 0, arg);
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
  window.__game = { state: pubState, act: act };

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
