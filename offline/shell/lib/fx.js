/* GK.FX — the finishing pass that separates "canvas demo" from "shipping game".
 *
 * Every title in this collection draws its world correctly and flatly: a
 * background fill, some sprites, a HUD. That reads as a prototype no matter how
 * good the underlying art is, because real shipped games run their frame through
 * a last-mile image pipeline. This module is that pipeline, built from cached
 * offscreen canvases so a phone never pays for it in CPU:
 *
 *   bloom      a 1/6-resolution copy of the frame added back on top. Painted
 *              highlights (torches, lava, muzzle flash, screen glow) bleed.
 *   grade      a two-stop soft-light gradient: cool in the shadows, warm on the
 *              light. This is the single cheapest change that makes a palette
 *              look "art directed" instead of "chosen".
 *   vignette   cached radial, sells the frame edge.
 *   grain      a 3-frame noise tile at 4% overlay. Kills banding on dark
 *              gradients, which is what most of these games are made of.
 *
 * plus the lighting primitive every game needs and none of them had:
 *
 *   light()    an additive radial falloff. Point lights, muzzle flashes, ember
 *              glow, UI pulses — all the same call.
 *
 * Usage (once per frame, after the world and BEFORE the HUD):
 *     GK.FX.finish(ctx, W, H, { warmth: 0.16, vignette: 0.85, bloom: 0.22 });
 *
 * Finish is a no-op until the first call, is safe on a canvas that was resized,
 * and skips the expensive steps on a low tier.
 */
(function () {
  'use strict';
  if (!window.GK) { return; }
  var GK = window.GK;
  var TAU = Math.PI * 2;

  var buf = null, bctx = null;         // full-res snapshot
  var small = null, sctx = null;       // 1/6-res bloom source
  var vig = null, vigKey = '';
  var grain = null, grainKey = '', grainFrame = 0, grainTick = 0;

  function mk(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function buildVignette(w, h, strength) {
    var key = w + 'x' + h + '@' + strength.toFixed(2);
    if (vigKey === key && vig) return vig;
    vig = mk(w, h);
    var x = vig.getContext('2d');
    var g = x.createRadialGradient(w * 0.5, h * 0.46, Math.min(w, h) * 0.24, w * 0.5, h * 0.46, Math.max(w, h) * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.55, 'rgba(0,0,0,' + (0.18 * strength).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(0,0,0,' + (0.72 * strength).toFixed(3) + ')');
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    vigKey = key;
    return vig;
  }

  function buildGrain(w, h) {
    var key = w + 'x' + h;
    if (grainKey === key && grain) return grain;
    grain = mk(w, h);
    var x = grain.getContext('2d');
    var data = x.createImageData(w, h);
    var d = data.data, i, v;
    for (i = 0; i < d.length; i += 4) {
      v = 90 + ((Math.random() * 76) | 0);
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    x.putImageData(data, 0, 0);
    grainKey = key;
    return grain;
  }

  function ensure(w, h) {
    if (!buf || buf.width !== w || buf.height !== h) {
      buf = mk(w, h); bctx = buf.getContext('2d');
      small = mk(Math.max(2, (w / 6) | 0), Math.max(2, (h / 6) | 0));
      sctx = small.getContext('2d');
      vigKey = ''; grainKey = '';
    }
  }

  function finish(ctx, w, h, opts) {
    opts = opts || {};
    ensure(w, h);
    var bloom = opts.bloom == null ? 0.2 : opts.bloom;
    var warmth = opts.warmth == null ? 0.14 : opts.warmth;
    var vigStrength = opts.vignette == null ? 0.75 : opts.vignette;
    var grainAmt = opts.grain == null ? 0.045 : opts.grain;
    var tier = GK.tier ? GK.tier() : 2;

    if (bloom > 0.001) {
      var sw = small.width, sh = small.height;
      // the caller draws under a DPR scale transform, so the snapshot has to
      // read the canvas at its real pixel size and write back in CSS units
      var cw = ctx.canvas.width, ch = ctx.canvas.height;
      sctx.globalCompositeOperation = 'source-over';
      sctx.clearRect(0, 0, sw, sh);
      sctx.imageSmoothingEnabled = true;
      sctx.drawImage(ctx.canvas, 0, 0, cw, ch, 0, 0, sw, sh);
      // square the downsampled frame against itself: mid-tones drop out and only
      // genuinely bright pixels (fire, flashes, specular) survive to glow. Without
      // this the bloom is a full-frame haze that softens every sprite edge.
      sctx.globalCompositeOperation = 'multiply';
      sctx.drawImage(small, 0, 0);
      sctx.drawImage(small, 0, 0);
      sctx.globalCompositeOperation = 'source-over';
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = bloom;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(small, 0, 0, sw, sh, 0, 0, w, h);
      // second, tighter pass keeps bright cores from washing out
      ctx.globalAlpha = bloom * 0.55;
      ctx.drawImage(small, 0, 0, sw, sh, 0, 0, w, h);
      ctx.restore();
    }

    if (warmth > 0.001) {
      var g = ctx.createLinearGradient(0, 0, w * 0.35, h);
      g.addColorStop(0, 'rgba(255,196,132,' + warmth.toFixed(3) + ')');
      g.addColorStop(0.5, 'rgba(120,110,140,' + (warmth * 0.25).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(46,74,120,' + (warmth * 0.9).toFixed(3) + ')');
      ctx.save();
      ctx.globalCompositeOperation = 'soft-light';
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }

    if (vigStrength > 0.001) {
      ctx.drawImage(buildVignette(w, h, vigStrength), 0, 0);
    }

    if (grainAmt > 0.001 && tier > 1) {
      grainTick++;
      if (grainTick % 4 === 0) { grainFrame = (grainFrame + 1) % 3; }
      ctx.save();
      ctx.globalAlpha = grainAmt;
      ctx.globalCompositeOperation = 'overlay';
      // shift the tile each frame so the noise crawls instead of sitting still
      var ox = (grainFrame * 37) % w, oy = (grainFrame * 53) % h;
      ctx.drawImage(buildGrain(w, h), -ox, -oy);
      ctx.drawImage(buildGrain(w, h), w - ox, -oy);
      ctx.drawImage(buildGrain(w, h), -ox, h - oy);
      ctx.restore();
    }
  }

  /* Additive point light. The falloff is a cached radial gradient keyed by
     radius bucket, because createRadialGradient per light per frame is the
     classic 2D-bloom mistake (it allocates and re-rasterises every call). */
  var LG = {};
  function lightSprite(r, colour) {
    var bucket = Math.max(8, Math.round(r / 16) * 16);
    var key = bucket + colour;
    if (LG[key]) return LG[key];
    var c = mk(bucket * 2, bucket * 2);
    var x = c.getContext('2d');
    var g = x.createRadialGradient(bucket, bucket, 0, bucket, bucket, bucket);
    g.addColorStop(0, colour);
    g.addColorStop(0.45, colour.replace(/[\d.]+\)$/, '0.35)'));
    g.addColorStop(1, colour.replace(/[\d.]+\)$/, '0)'));
    x.fillStyle = g;
    x.fillRect(0, 0, bucket * 2, bucket * 2);
    LG[key] = c;
    return c;
  }

  GK.FX = {
    finish: finish,
    ensure: ensure,
    light: function (ctx, x, y, r, colour, alpha) {
      if (r <= 0) return;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      if (alpha != null) ctx.globalAlpha = alpha;
      ctx.drawImage(lightSprite(r, colour || 'rgba(255,190,120,1)'), x - r, y - r, r * 2, r * 2);
      ctx.restore();
    },
    /* Soft light pool on the floor (no additive burn) — for braziers, lamps,
       running engines and anything that should tint the ground under it. */
    pool: function (ctx, x, y, r, colour, alpha) {
      if (r <= 0) return;
      ctx.save();
      ctx.globalCompositeOperation = 'overlay';
      if (alpha != null) ctx.globalAlpha = alpha;
      ctx.drawImage(lightSprite(r, colour || 'rgba(255,170,90,1)'), x - r * 0.5, y - r * 0.5, r * 2, r * 2);
      ctx.restore();
    },
    /* Cheap film-style flash used on hits and explosions. */
    flash: function (ctx, w, h, colour, a) {
      if (a <= 0.002) return;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(1, a);
      ctx.fillStyle = colour;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    },
    easing: {
      outQuad: function (t) { return t * (2 - t); },
      outCubic: function (t) { var u = 1 - t; return 1 - u * u * u; },
      outBack: function (t) { var s = 1.7; var u = t - 1; return 1 + (s + 1) * u * u * u + s * u * u; },
      inOutSine: function (t) { return -(Math.cos(Math.PI * t) - 1) / 2; }
    }
  };
})();
