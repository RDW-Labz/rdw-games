/* GK.Art — native-resolution donor sprites for every game in the collection.
 *
 * The first pass of this collection drew creatures as authored vectors and
 * washed a 64 px palette sample over them. The painted Flare monster is
 * 106x256. Downscaling it to a swatch and painting it *through* an ellipse
 * keeps the silhouette we invented and throws away the artist's work — which
 * is exactly why the games read as prototypes.
 *
 * This module blits the donor art at the size it was painted for:
 *
 *   - load()    decodes the PNG once, scans its alpha channel, and stores the
 *               *visible* bounding box. Flare ships most creatures inside a
 *               canvas padded with transparency (goblin.png is 106x256 with the
 *               body occupying roughly the lower two thirds), so drawing at a
 *               requested height without trimming makes every creature sit a
 *               third of the way up the screen at two thirds of the intended
 *               size.
 *   - draw()    anchors the trimmed art bottom-centre on a ground point, so an
 *               actor is placed by the tile it stands on and never by its
 *               sprite's padding.
 *   - tint()    caches per-colour variants (hit flash, poison, freeze, drop
 *               shadow) once instead of compositing per frame.
 *   - frames()  slices a sheet (Shattered Pixel sheets are 16-wide rows) into
 *               indexed frames for animation.
 *
 * Classic script, no modules, no network, works from file://.
 */
(function () {
  'use strict';
  if (!window.GK) { return; }
  var GK = window.GK;

  var CACHE = {};
  var TINTS = {};
  var MAX_TINTS = 48;

  function Rec(key) {
    this.key = key;
    this.img = null;
    this.ready = false;
    this.w = 0;
    this.h = 0;
    // visible box in source pixels
    this.sx = 0; this.sy = 0; this.sw = 0; this.sh = 0;
    this.src = '';
  }

  /* Alpha-trim: find the box that actually holds pixels. Runs once per image
     at load. Falls back to the full canvas if getImageData is unavailable
     (some file:// builds taint canvases) so callers never see a broken box. */
  function trim(rec) {
    var w = rec.w, h = rec.h;
    rec.sx = 0; rec.sy = 0; rec.sw = w; rec.sh = h;
    var cv, cx, data;
    try {
      cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cx = cv.getContext('2d');
      cx.drawImage(rec.img, 0, 0);
      data = cx.getImageData(0, 0, w, h).data;
    } catch (e) { return; }
    var minX = w, minY = h, maxX = -1, maxY = -1, x, y, a;
    for (y = 0; y < h; y++) {
      var row = y * w * 4;
      for (x = 0; x < w; x++) {
        a = data[row + x * 4 + 3];
        if (a > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return; // fully transparent — keep the full box
    rec.sx = minX; rec.sy = minY;
    rec.sw = maxX - minX + 1; rec.sh = maxY - minY + 1;
  }

  /* A one-colour copy of the sprite, used for hit flashes and drop shadows.
     Built by painting the colour then compositing the sprite with source-in,
     which keeps the artist's alpha exactly. */
  function tinted(rec, colour) {
    var key = rec.key + '|' + colour;
    if (TINTS[key]) return TINTS[key];
    var n = 0, k;
    for (k in TINTS) { n++; }
    if (n > MAX_TINTS) { TINTS = {}; }
    var cv = document.createElement('canvas');
    cv.width = rec.w; cv.height = rec.h;
    var x = cv.getContext('2d');
    x.drawImage(rec.img, 0, 0);
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = colour;
    x.fillRect(0, 0, rec.w, rec.h);
    TINTS[key] = cv;
    return cv;
  }

  function ensure(key) {
    var r = CACHE[key];
    return r && r.ready ? r : (r || null);
  }

  /* draw(ctx, rec, cx, groundY, heightPx, opts)
   * opts: { flip, alpha, flash, flashColour, shadow, shadowAlpha, rot, pixel,
   *         width (explicit px width instead of height), footY (0..1 anchor) }
   */
  function draw(ctx, rec, cx, groundY, hpx, opts) {
    if (!rec || !rec.ready) return false;
    opts = opts || {};
    var src = rec.img;
    var sw = rec.sw, sh = rec.sh, sx = rec.sx, sy = rec.sy;
    var scale = hpx / sh;
    var wpx = sw * scale;
    if (opts.width) { wpx = opts.width; scale = wpx / sw; hpx = sh * scale; }
    var foot = opts.footY == null ? 1 : opts.footY;
    var x = cx - wpx * 0.5;
    var y = groundY - hpx * foot;

    ctx.save();
    if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
    var smooth = !opts.pixel;
    ctx.imageSmoothingEnabled = smooth;
    if (smooth) ctx.imageSmoothingQuality = 'high';

    if (opts.shadow) {
      ctx.save();
      ctx.globalAlpha = (opts.shadowAlpha == null ? 0.32 : opts.shadowAlpha) * (opts.alpha == null ? 1 : opts.alpha);
      ctx.translate(cx, groundY);
      ctx.scale(1, 0.34);
      ctx.beginPath();
      ctx.arc(0, 0, wpx * 0.44, 0, Math.PI * 2);
      ctx.fillStyle = '#000';
      ctx.filter = 'blur(3px)';
      ctx.fill();
      ctx.restore();
    }

    if (opts.rot) {
      ctx.translate(cx, groundY - hpx * 0.5);
      ctx.rotate(opts.rot);
      ctx.translate(-cx, -(groundY - hpx * 0.5));
    }
    if (opts.flip) {
      ctx.translate(cx, 0);
      ctx.scale(-1, 1);
      ctx.translate(-cx, 0);
    }
    ctx.drawImage(src, sx, sy, sw, sh, x, y, wpx, hpx);

    if (opts.flash && opts.flash > 0.01) {
      var t = tinted(rec, opts.flashColour || '#ffffff');
      ctx.globalAlpha = (opts.alpha == null ? 1 : opts.alpha) * Math.min(0.85, opts.flash);
      ctx.drawImage(t, sx, sy, sw, sh, x, y, wpx, hpx);
    }
    ctx.restore();
    return { x: x, y: y, w: wpx, h: hpx, scale: scale };
  }

  /* frames(sheet, frameW, frameH) → array of trim boxes, left-to-right,
     top-to-bottom. Empty cells are skipped so a sheet with ragged rows still
     indexes cleanly. */
  function frames(rec, fw, fh) {
    if (!rec || !rec.ready) return [];
    var out = [], cols = Math.floor(rec.w / fw), rows = Math.floor(rec.h / fh), c, r;
    for (r = 0; r < rows; r++) {
      for (c = 0; c < cols; c++) {
        out.push({ sx: c * fw, sy: r * fh, sw: fw, sh: fh });
      }
    }
    return out;
  }

  GK.Art = {
    load: function (key, url, opts) {
      opts = opts || {};
      var rec = CACHE[key] || (CACHE[key] = new Rec(key));
      if (rec.src === url) return rec;
      rec.src = url;
      rec.ready = false;
      var img = new Image();
      if (opts.crossOrigin) img.crossOrigin = 'anonymous';
      img.onload = function () {
        rec.img = img;
        rec.w = img.naturalWidth || img.width;
        rec.h = img.naturalHeight || img.height;
        if (!rec.w || !rec.h) return;
        trim(rec);
        rec.ready = true;
        if (opts.onload) opts.onload(rec);
      };
      img.onerror = function () {
        rec.ready = false;
        if (opts.onerror) opts.onerror(rec);
      };
      img.src = url;
      return rec;
    },
    get: function (key) { return ensure(key); },
    ready: function (key) { return !!ensure(key); },
    draw: draw,
    frames: frames,
    tinted: tinted,
    /* A sheet-blit for indexed frames (used by the pixel-art donors). */
    drawFrame: function (ctx, rec, f, cx, groundY, hpx, opts) {
      if (!rec || !rec.ready || !f) return false;
      var shim = { key: rec.key, img: rec.img, ready: true, w: rec.w, h: rec.h, sx: f.sx, sy: f.sy, sw: f.sw, sh: f.sh };
      return draw(ctx, shim, cx, groundY, hpx, opts);
    }
  };
})();
