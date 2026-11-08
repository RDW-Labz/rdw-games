/* Stormforge — 3D scene. Builds the island, the buildings, the people, the factory and the
 * storm out of Three.js geometry, and syncs them to the simulation each frame.
 *
 * Only the maths lives here. Game state stays in main.js; this file reads it and moves meshes.
 * Textures come from the vendored Suroi floors/ceilings and Mindustry block art; if a texture
 * cannot be loaded (a browser opening the folder over file:// blocks cross-origin images for
 * WebGL) the material falls back to flat colour and the game still plays.
 */
(function (g) {

  /* Suroi names its armour art by grade, not by level number: basic 1, regular 2,
   * tactical 3, power 4. The parsed table only carries the level, so map it here once. */
  function armorIcon(slot, level) {
    var grades = ['basic', 'regular', 'tactical', 'power'];
    var g2 = grades[Math.max(0, Math.min(3, (level | 0) - 1))];
    return 'vendor/suroi/loot/' + g2 + '_' + (slot === 'helmet' ? 'helmet' : 'vest') + '.png';
  }

  'use strict';

  var THREE = g.THREE;
  var S = {};

  var texCache = {};
  var loader = new THREE.TextureLoader();
  var texOK = true;

  function tex(path, repeat) {
    if (!texOK || !path) return null;
    var key = path + '|' + (repeat || 1);
    if (texCache[key]) return texCache[key];
    var t = loader.load('../../' + path, function () { t.needsUpdate = true; }, undefined, function () {
      // A single blocked image means every further file:// texture will fail the same way.
      texOK = false;
      texCache[key] = null;
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (repeat) t.repeat.set(repeat, repeat);
    t.anisotropy = 4;
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
    texCache[key] = t;
    return t;
  }

  /* Plaster wall texture: near-white so the material colour still tints per POI, with horizontal
   * trowel bands, vertical grime drips and a few hairline cracks. Flat vertex-coloured boxes were
   * the single biggest tell that the buildings were placeholder. */
  var wallTex = null;
  function makeWallTexture() {
    if (wallTex) return wallTex;
    var N = 256, c = document.createElement('canvas');
    c.width = c.height = N;
    var x = c.getContext('2d');
    var seed = 7717;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    x.fillStyle = '#f2ece1'; x.fillRect(0, 0, N, N);
    /* Block courses: a construction surface needs a readable joint grid. Without it the wall is
     * a tinted box no matter how much grime is painted on top of it. */
    for (var row = 0; row < 8; row++) {
      var yy0 = row * (N / 8);
      x.fillStyle = 'rgba(120,112,98,0.42)';
      x.fillRect(0, yy0, N, 1.6);
      var off = (row % 2) * (N / 8);
      for (var col = 0; col < 4; col++) x.fillRect(off + col * (N / 4), yy0, 1.4, N / 8);
      // per-block tone wobble so the courses are not one shade
      for (var blk = 0; blk < 4; blk++) {
        var bv = 190 + Math.floor(rnd() * 60);
        x.fillStyle = 'rgba(' + bv + ',' + (bv - 4) + ',' + (bv - 14) + ',' + (0.10 + rnd() * 0.22).toFixed(2) + ')';
        x.fillRect(off + blk * (N / 4) + 2, yy0 + 2, N / 4 - 4, N / 8 - 4);
      }
    }
    // trowel streaks over the courses
    for (var b = 0; b < 22; b++) {
      var y0 = rnd() * N, hh = 1 + rnd() * 4;
      var v = 210 + Math.floor(rnd() * 45);
      x.fillStyle = 'rgba(' + v + ',' + v + ',' + v + ',' + (0.12 + rnd() * 0.22).toFixed(2) + ')';
      x.fillRect(0, y0, N, hh);
    }
    // vertical grime drips from the top
    for (var d = 0; d < 22; d++) {
      var dx = rnd() * N, dl = 12 + rnd() * 70, dw = 1 + rnd() * 2.6;
      var g = x.createLinearGradient(0, 0, 0, dl);
      g.addColorStop(0, 'rgba(78,70,58,0.52)');
      g.addColorStop(1, 'rgba(96,88,74,0)');
      x.fillStyle = g;
      x.fillRect(dx, 0, dw, dl);
    }
    // speckle
    for (var i2 = 0; i2 < 1800; i2++) {
      var vv = 120 + Math.floor(rnd() * 110);
      x.fillStyle = 'rgba(' + vv + ',' + (vv - 6) + ',' + (vv - 18) + ',' + (0.16 + rnd() * 0.42).toFixed(2) + ')';
      x.fillRect(rnd() * N, rnd() * N, 1 + rnd() * 1.6, 1 + rnd() * 1.6);
    }
    // panel joints: two vertical seams so a long wall is not one field of colour
    for (var pj = 1; pj < 3; pj++) {
      x.fillStyle = 'rgba(120,112,98,0.35)';
      x.fillRect(pj * N / 3, 0, 1.6, N);
    }
    // ground grime: the bottom of a wall is always dirtier
    var gg = x.createLinearGradient(0, N, 0, N * 0.62);
    gg.addColorStop(0, 'rgba(86,78,64,0.55)');
    gg.addColorStop(1, 'rgba(86,78,64,0)');
    x.fillStyle = gg;
    x.fillRect(0, N * 0.62, N, N * 0.38);
    // hairline cracks
    x.strokeStyle = 'rgba(74,66,56,0.45)';
    x.lineWidth = 0.9;
    for (var k = 0; k < 7; k++) {
      var cx = rnd() * N, cy = rnd() * N;
      x.beginPath(); x.moveTo(cx, cy);
      for (var seg = 0; seg < 4; seg++) { cx += (rnd() - 0.5) * 16; cy += 6 + rnd() * 12; x.lineTo(cx, cy); }
      x.stroke();
    }
    wallTex = new THREE.CanvasTexture(c);
    wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping;
    wallTex.repeat.set(1, 1);
    if (THREE.SRGBColorSpace) wallTex.colorSpace = THREE.SRGBColorSpace;
    wallTex.anisotropy = 4;
    return wallTex;
  }

  function mat(color, opts) {
    var o = opts || {};
    return new THREE.MeshLambertMaterial({
      color: color,
      map: o.map || null,
      transparent: !!o.transparent,
      opacity: o.opacity == null ? 1 : o.opacity,
      emissive: o.emissive || 0x000000,
      emissiveIntensity: o.emissiveIntensity == null ? 1 : o.emissiveIntensity,
      side: o.side || THREE.FrontSide,
      depthWrite: o.depthWrite == null ? true : o.depthWrite
    });
  }

  /* ---------------------------------------------------------------- island */

  var BIOME_COLOR = [
    0x5b9c46,   // grass
    0x8a6a44,   // dirt
    0xc9b283,   // sand
    0x2f6f9e,   // water (never seen: the water plane covers it)
    0x555b61,   // road
    0x77716a    // rock
  ];

  function hash2(x, y, seed) {
    var h = x * 374761393 + y * 668265263 + seed * 2246822519;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function smoothNoise(x, y, seed) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    var a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
    var c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }

  function groundHeight(world, wx, wy) {
    var gx = Math.max(0, Math.min(world.grid - 1, Math.floor(wx / world.cell)));
    var gy = Math.max(0, Math.min(world.grid - 1, Math.floor(wy / world.cell)));
    var bi = world.tiles[gy * world.grid + gx];
    var n = smoothNoise(wx * 0.0035, wy * 0.0035, world.seed | 0) * 2 - 1;
    // Land sits comfortably above the water line; only the lake bed goes under it. An earlier
    // pass had land noise reaching below zero and half the island read as flooded.
    var base = 1.5;
    if (bi === 3) base = -1.9;           // lake bed
    else if (bi === 5) base = 5.2;       // rock shelf
    else if (bi === 1) base = 1.6;
    else if (bi === 2) base = 1.3;
    var amp = bi === 3 ? 0.25 : bi === 5 ? 2.2 : 1.25;
    return base + n * amp;
  }

  /* A tiling speckle map keeps the ground from reading as flat vertex colour at arm's length,
   * without shipping a texture the collection would have to attribute to someone. */
  var groundTex = null;

  /* Tileable value noise, four octaves, written per pixel. A 128px white speckle reads as flat
   * colour once the camera is 8 units up; the ground needs grain at three scales plus a fine
   * dither layer, and it must stay NEUTRAL (near-white, near-grey) because this map MULTIPLIES
   * the per-biome vertex colours — any tint here washes every biome toward one hue. */
  function makeGroundTexture() {
    if (groundTex) return groundTex;
    var N = 256;
    var c = document.createElement('canvas');
    c.width = c.height = N;
    var x = c.getContext('2d');
    var img = x.createImageData(N, N);
    var seed = 1337;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    var octaves = [];
    for (var o = 0; o < 4; o++) {
      var per = 4 << o;                       // 4, 8, 16, 32 cells across the tile
      var grid = [];
      for (var i = 0; i < per * per; i++) grid.push(rnd());
      octaves.push({ per: per, grid: grid, amp: [0.20, 0.16, 0.11, 0.07][o] });
    }
    function sample(oct, u, v) {
      var per = oct.per;
      var fx = u * per, fy = v * per;
      var x0 = Math.floor(fx) % per, y0 = Math.floor(fy) % per;
      var x1 = (x0 + 1) % per, y1 = (y0 + 1) % per;
      var tx = fx - Math.floor(fx), ty = fy - Math.floor(fy);
      tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
      var a = oct.grid[y0 * per + x0], b2 = oct.grid[y0 * per + x1];
      var c2 = oct.grid[y1 * per + x0], d2 = oct.grid[y1 * per + x1];
      return (a * (1 - tx) + b2 * tx) * (1 - ty) + (c2 * (1 - tx) + d2 * tx) * ty;
    }
    for (var py = 0; py < N; py++) {
      for (var px = 0; px < N; px++) {
        var u = px / N, v = py / N;
        var n = 0;
        for (var k = 0; k < octaves.length; k++) n += (sample(octaves[k], u, v) - 0.5) * octaves[k].amp;
        var grain = (rnd() - 0.5) * 0.055;
        var lum = 0.95 + n + grain;
        lum = Math.max(0.52, Math.min(1.16, lum));
        var tint = (n * 0.5) * 10;            // a whisper of warm/cool in the noise, sat ~0.04
        var r2 = Math.min(255, lum * 255 + tint);
        var g2 = Math.min(255, lum * 255);
        var b2b = Math.min(255, lum * 255 - tint);
        var idx = (py * N + px) * 4;
        img.data[idx] = r2; img.data[idx + 1] = g2; img.data[idx + 2] = b2b; img.data[idx + 3] = 255;
      }
    }
    x.putImageData(img, 0, 0);

    /* Blades and pebbles on top of the noise field. The noise alone is a 20% luminance wobble,
     * which is invisible once the texture is mip-mapped and shaded; short high-contrast strokes
     * survive downscaling and are what actually reads as ground cover at arm's length. */
    x.lineCap = 'round';
    var s2 = 4242;
    function srnd() { s2 = (s2 * 1103515245 + 12345) & 0x7fffffff; return s2 / 0x7fffffff; }
    for (var sb = 0; sb < 210; sb++) {
      var bx = srnd() * N, by = srnd() * N, len = 4 + srnd() * 11, ang = -1.2 + srnd() * 2.4;
      var v3 = 96 + Math.floor(srnd() * 96);
      x.strokeStyle = 'rgba(' + v3 + ',' + (v3 + 8) + ',' + (v3 - 6) + ',' + (0.20 + srnd() * 0.34).toFixed(2) + ')';
      x.lineWidth = 0.9 + srnd() * 1.2;
      x.beginPath();
      x.moveTo(bx, by);
      x.lineTo(bx + Math.cos(ang) * len, by + Math.sin(ang) * len);
      x.stroke();
    }
    for (var pb = 0; pb < 150; pb++) {
      var px2 = srnd() * N, py2 = srnd() * N, pr = 0.7 + srnd() * 1.5;
      var pv = 150 + Math.floor(srnd() * 90);
      x.fillStyle = 'rgba(' + pv + ',' + pv + ',' + pv + ',' + (0.3 + srnd() * 0.4).toFixed(2) + ')';
      x.beginPath(); x.arc(px2, py2, pr, 0, Math.PI * 2); x.fill();
    }
    groundTex = new THREE.CanvasTexture(c);
    groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
    groundTex.anisotropy = 4;
    groundTex.anisotropy = 4;
    /* Linear, not sRGB: this is a multiply map that should average ~1.0. Tagged sRGB at 0.95 it
     * linearises to ~0.89 and quietly darkens the whole island. */
    if (THREE.LinearSRGBColorSpace) groundTex.colorSpace = THREE.LinearSRGBColorSpace;
    return groundTex;
  }

  var ROCK_COLOR = new THREE.Color(0x7d746b);
  var WET_SAND = new THREE.Color(0x9c8d6d);

  function buildTerrain(world) {
    var step = world.cell;                         // one quad per cell (16u) instead of two
    var n = Math.floor(world.size / step);
    var geo = new THREE.PlaneGeometry(world.size, world.size, n, n);
    geo.rotateX(-Math.PI / 2);

    var pos = geo.attributes.position;
    var colors = new Float32Array(pos.count * 3);
    var c = new THREE.Color();

    for (var i = 0; i < pos.count; i++) {
      var x = pos.getX(i) + world.size / 2;
      var z = pos.getZ(i) + world.size / 2;
      var h = groundHeight(world, x, z);
      pos.setY(i, h);
      var gx = Math.max(0, Math.min(world.grid - 1, Math.floor(x / world.cell)));
      var gy = Math.max(0, Math.min(world.grid - 1, Math.floor(z / world.cell)));
      var bi = world.tiles[gy * world.grid + gx];
      c.setHex(BIOME_COLOR[bi] || BIOME_COLOR[0]);
      // slope shading: steeper ground darkens, which is what makes a low-poly hill read
      var shade = 0.86 + (h - groundHeight(world, x + step, z)) * -0.22;
      var grain = 0.93 + hash2(Math.floor(x), Math.floor(z), world.seed | 0) * 0.14;
      /* Two extra terms the first pass was missing: a LOW-frequency patch field (period ~14 and
       * ~40 world units) so the island has visible light and dark regions instead of one uniform
       * green, and a crevice/AO term that darkens vertices sitting below their neighbours. */
      var sd = world.seed | 0;
      var patchA = Math.sin(x * 0.071 + sd * 0.013) * Math.cos(z * 0.063 - sd * 0.021);
      var patchB = Math.sin(x * 0.026 - sd * 0.007) * Math.cos(z * 0.031 + sd * 0.011);
      var patch = 1 + patchA * 0.19 + patchB * 0.12;
      var hN = groundHeight(world, x, z - step), hE = groundHeight(world, x + step, z);
      var hS = groundHeight(world, x, z + step), hW = groundHeight(world, x - step, z);
      var rel = h - (hN + hE + hS + hW) / 4;
      var ao = Math.max(0.74, Math.min(1.06, 1 + rel * 0.34));
      /* Cliffs: past ~30 degrees the grass colour is nonsense, so blend into bare rock. The
       * gradient is measured over one cell, which is the finest scale the heightfield has. */
      var grad = (Math.abs(h - hE) + Math.abs(h - hS)) / (step * 2);
      var rockMix = Math.min(1, Math.max(0, (grad - 0.42) / 0.5));
      if (rockMix > 0) c.lerp(ROCK_COLOR, rockMix * 0.8);
      /* Shoreline: any vertex whose cell touches water gets wet sand, darker and less saturated,
       * so lakes stop meeting grass with a hard colour edge. */
      var nearWater = 0;
      for (var wd = 0; wd < 4; wd++) {
        var wx2 = gx + (wd === 0 ? -1 : wd === 1 ? 1 : 0), wy2 = gy + (wd === 2 ? -1 : wd === 3 ? 1 : 0);
        if (wx2 < 0 || wy2 < 0 || wx2 >= world.grid || wy2 >= world.grid) continue;
        if (world.tiles[wy2 * world.grid + wx2] === 3) { nearWater = 1; break; }
      }
      if (nearWater || h < 0.28) c.lerp(WET_SAND, h < 0.28 ? 0.72 : 0.5);
      c.multiplyScalar(Math.max(0.62, Math.min(1.12, shade)) * grain * patch * ao);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    var gtex = makeGroundTexture();
    gtex.repeat.set(world.size / 7.5, world.size / 7.5);
    var mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, map: gtex, roughness: 0.94, metalness: 0.0
    }));
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    /* The heightfield samples world tiles 0..size, but a PlaneGeometry is centred on the origin,
     * so the mesh has always drawn the island half a map away from where the simulation, the
     * water plane and every actor think it is. Everything past the old seam rendered as open
     * water with an invisible floor: that is the "the ground is a flat blue plane" report. */
    mesh.position.set(world.size / 2, 0, world.size / 2);
    return mesh;
  }

  /* Wave bump: a tileable ripple field scrolled in two directions at different rates. A flat
   * Lambert plane reads as blue paper; a low-roughness surface with a moving bump picks up the
   * sun and finally looks like water. */
  var waveTex = null;
  function makeWaveTexture() {
    if (waveTex) return waveTex;
    var N = 128, c = document.createElement('canvas');
    c.width = c.height = N;
    var x = c.getContext('2d');
    var img = x.createImageData(N, N);
    for (var py = 0; py < N; py++) {
      for (var px = 0; px < N; px++) {
        var u = px / N * Math.PI * 2, v = py / N * Math.PI * 2;
        var w = Math.sin(u * 3 + Math.sin(v * 2) * 1.2) * 0.5 + Math.sin(v * 5 - u * 2) * 0.3 +
                Math.sin((u + v) * 7) * 0.2;
        var l = 128 + w * 78;
        var idx = (py * N + px) * 4;
        img.data[idx] = img.data[idx + 1] = img.data[idx + 2] = l;
        img.data[idx + 3] = 255;
      }
    }
    x.putImageData(img, 0, 0);
    waveTex = new THREE.CanvasTexture(c);
    waveTex.wrapS = waveTex.wrapT = THREE.RepeatWrapping;
    waveTex.repeat.set(26, 26);
    if (THREE.LinearSRGBColorSpace) waveTex.colorSpace = THREE.LinearSRGBColorSpace;
    return waveTex;
  }

  /* Large-scale albedo drift for the water plane: teal blotches with a slow diagonal current.
   * The ripple bump is high frequency and disappears at distance, this is what still reads from
   * the air. */
  var waterTone = null;
  function makeWaterTone() {
    if (waterTone) return waterTone;
    var N = 128, c = document.createElement('canvas');
    c.width = c.height = N;
    var x = c.getContext('2d');
    var seed = 5150;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, N, N);
    for (var i = 0; i < 30; i++) {
      var bx = rnd() * N, by = rnd() * N, br = 14 + rnd() * 40;
      var g = x.createRadialGradient(bx, by, 0, bx, by, br);
      var t = rnd();
      g.addColorStop(0, t > 0.5 ? 'rgba(214,238,248,0.55)' : 'rgba(96,150,178,0.55)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g;
      x.beginPath(); x.arc(bx, by, br, 0, Math.PI * 2); x.fill();
    }
    waterTone = new THREE.CanvasTexture(c);
    waterTone.wrapS = waterTone.wrapT = THREE.RepeatWrapping;
    waterTone.repeat.set(64, 64);
    if (THREE.SRGBColorSpace) waterTone.colorSpace = THREE.SRGBColorSpace;
    return waterTone;
  }

  /* Foam: soft white smudges placed on every cell boundary where land meets water. Vertex
   * colours cannot fade, so this is a merged quad sheet with one soft alpha texture — a whole
   * coastline for one draw call. */
  var foamTex = null;
  function makeFoamTexture() {
    if (foamTex) return foamTex;
    var N = 64, c = document.createElement('canvas');
    c.width = c.height = N;
    var x = c.getContext('2d');
    var g = x.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.92)');
    g.addColorStop(0.45, 'rgba(236,248,252,0.55)');
    g.addColorStop(1, 'rgba(236,248,252,0)');
    x.fillStyle = g; x.fillRect(0, 0, N, N);
    foamTex = new THREE.CanvasTexture(c);
    if (THREE.SRGBColorSpace) foamTex.colorSpace = THREE.SRGBColorSpace;
    return foamTex;
  }

  function buildShore(world) {
    var parts = [], cell = world.cell;
    for (var gy = 1; gy < world.grid - 1; gy++) {
      for (var gx = 1; gx < world.grid - 1; gx++) {
        if (world.tiles[gy * world.grid + gx] !== 3) continue;
        for (var d = 0; d < 4; d++) {
          var nx = gx + (d === 0 ? -1 : d === 1 ? 1 : 0);
          var ny = gy + (d === 2 ? -1 : d === 3 ? 1 : 0);
          if (world.tiles[ny * world.grid + nx] === 3) continue;
          var ex = (d === 0 ? gx : d === 1 ? gx + 1 : gx + 0.5) * cell;
          var ez = (d === 2 ? gy : d === 3 ? gy + 1 : gy + 0.5) * cell;
          parts.push({
            geo: new THREE.PlaneGeometry(cell * 1.5, cell * 1.5),
            color: 0xffffff,
            pos: [ex, -0.16, ez],
            rot: [-Math.PI / 2, 0, 0]
          });
        }
      }
    }
    if (!parts.length) return null;
    var mesh = new THREE.Mesh(bakeGeo(parts), new THREE.MeshBasicMaterial({
      map: makeFoamTexture(), transparent: true, opacity: 0.5, depthWrite: false
    }));
    mesh.name = 'shore';
    mesh.renderOrder = 2;
    return mesh;
  }

  function buildWater(world) {
    var geo = new THREE.PlaneGeometry(world.size, world.size, 1, 1);
    geo.rotateX(-Math.PI / 2);
    /* metalness 0.42 with no environment map makes a surface DARKER, not shinier — that was why
     * the lake read as flat blue paper. Low metalness, a soft albedo tile for large-scale tone
     * variation and a much stronger bump is what makes it read as water under a bright sky. */
    var m = new THREE.MeshStandardMaterial({
      color: 0x2f86b0, roughness: 0.26, metalness: 0.06,
      transparent: true, opacity: 0.88,
      map: makeWaterTone(), bumpMap: makeWaveTexture(), bumpScale: 0.55
    });
    var mesh = new THREE.Mesh(geo, m);
    mesh.position.set(world.size / 2, -0.35, world.size / 2);
    mesh.name = 'water';
    return mesh;
  }

  /* ---------------------------------------------------------------- scatter
   *
   * The island was carrying a couple of hundred hand-placed props around the POIs, which left
   * open ground reading as empty coloured polygons. Merging each species into one geometry and
   * drawing it with an InstancedMesh puts roughly 2,300 trees, bushes and rocks on the map for
   * four draw calls, with per-instance tint so the canopy does not tile.
   */
  function scatterGeo(kind) {
    var C = THREE.ConeGeometry, I = THREE.IcosahedronGeometry, Cy = THREE.CylinderGeometry;
    if (kind === 'pine') {
      return bakeGeo([
        { geo: new Cy(0.2, 0.32, 1.7, 5), color: 0x4d3722, pos: [0, 0.85, 0] },
        { geo: new C(1.55, 1.9, 7), color: 0x2c5f34, pos: [0, 2.35, 0] },
        { geo: new C(1.20, 1.7, 7), color: 0x356f3c, pos: [0, 3.35, 0] },
        { geo: new C(0.80, 1.4, 7), color: 0x3d7f44, pos: [0, 4.20, 0] }
      ]);
    }
    if (kind === 'broad') {
      return bakeGeo([
        { geo: new Cy(0.24, 0.36, 2.3, 5), color: 0x5b4028, pos: [0, 1.15, 0] },
        { geo: new I(1.75, 0), color: 0x3f7a30, pos: [0, 3.05, 0], scale: [1, 0.9, 1] },
        { geo: new I(1.15, 0), color: 0x4e8b3a, pos: [0.85, 2.75, 0.5] },
        { geo: new I(0.95, 0), color: 0x35702c, pos: [-0.75, 3.55, -0.35] }
      ]);
    }
    if (kind === 'bush') {
      return bakeGeo([
        { geo: new I(0.78, 0), color: 0x35702c, pos: [0, 0.6, 0], scale: [1, 0.8, 1] },
        { geo: new I(0.55, 0), color: 0x468233, pos: [0.42, 0.45, 0.3] },
        { geo: new I(0.48, 0), color: 0x2c5f26, pos: [-0.4, 0.42, -0.25] }
      ]);
    }
    return bakeGeo([                                   // 'rock'
      { geo: new I(1.15, 0), color: 0x7c7f83, pos: [0, 0.55, 0], scale: [1, 0.72, 0.92] },
      { geo: new I(0.62, 0), color: 0x8b8e92, pos: [0.85, 0.32, 0.4], scale: [1, 0.7, 1] },
      { geo: new I(0.44, 0), color: 0x6c7074, pos: [-0.6, 0.26, -0.5] }
    ]);
  }

  var SCATTER_PLAN = [
    { kind: 'pine',  count: 520, biomes: [0, 5], min: 3.0, max: 4.6, tint: 0.16, shadow: true },
    { kind: 'broad', count: 460, biomes: [0, 1, 2], min: 2.8, max: 4.2, tint: 0.20, shadow: true },
    { kind: 'bush',  count: 1150, biomes: [0, 1, 2], min: 1.6, max: 3.2, tint: 0.24, shadow: false },
    { kind: 'rock',  count: 340, biomes: [0, 5, 1], min: 1.2, max: 3.4, tint: 0.14, shadow: true }
  ];

  function buildScatter(world) {
    var grp = new THREE.Group();
    grp.name = 'scatter';
    var mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0, flatShading: true });
    var seed = ((world.seed | 0) ^ 0x5f3a91) >>> 0;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    var mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(),
        v = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color();

    for (var pi = 0; pi < SCATTER_PLAN.length; pi++) {
      var plan = SCATTER_PLAN[pi];
      var geo = scatterGeo(plan.kind);
      var inst = new THREE.InstancedMesh(geo, mat, plan.count);
      inst.castShadow = !!plan.shadow;
      inst.receiveShadow = true;
      inst.name = 'scatter_' + plan.kind;
      var placed = 0, tries = 0, cap = plan.count * 24;
      while (placed < plan.count && tries < cap) {
        tries++;
        var wx = rnd() * world.size, wz = rnd() * world.size;
        var gx = Math.max(0, Math.min(world.grid - 1, Math.floor(wx / world.cell)));
        var gy = Math.max(0, Math.min(world.grid - 1, Math.floor(wz / world.cell)));
        var bi = world.tiles[gy * world.grid + gx];
        if (plan.biomes.indexOf(bi) < 0) continue;
        var nearPOI = false;
        for (var k = 0; k < world.pois.length; k++) {
          var p0 = world.pois[k];
          if (Math.abs(p0.cx - wx) < 26 && Math.abs(p0.cy - wz) < 26) { nearPOI = true; break; }
        }
        if (nearPOI) continue;
        var h = groundHeight(world, wx, wz);
        if (h < -0.2) continue;                       // never plant in a lake
        var s2 = plan.min + rnd() * (plan.max - plan.min);
        e.set(0, rnd() * Math.PI * 2, 0);
        q.setFromEuler(e);
        v.set(wx, h - 0.15, wz);
        sc.set(s2 * (0.85 + rnd() * 0.3), s2, s2 * (0.85 + rnd() * 0.3));
        mtx.compose(v, q, sc);
        inst.setMatrixAt(placed, mtx);
        var t3 = 1 - plan.tint * 0.5 + rnd() * plan.tint;
        col.setRGB(t3 * (0.94 + rnd() * 0.12), t3, t3 * (0.92 + rnd() * 0.1));
        inst.setColorAt(placed, col);
        placed++;
      }
      inst.count = placed;
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      grp.add(inst);
    }
    return grp;
  }

  /* ---------------------------------------------------------------- grass
   *
   * One InstancedMesh of merged blades, scattered on grass tiles only. A field with nothing
   * standing on it reads as a painted polygon no matter how good the texture is; 2.6k blades in
   * a single draw call is the cheapest way to fix that on a phone.
   */
  function buildGrass(world) {
    var blade = bakeGeo([
      { geo: new THREE.ConeGeometry(0.055, 0.46, 4), color: 0x3f7a34, pos: [0, 0.23, 0], rot: [0.12, 0, 0.1] },
      { geo: new THREE.ConeGeometry(0.045, 0.36, 4), color: 0x4e8f3d, pos: [0.11, 0.18, 0.05], rot: [-0.08, 0.7, -0.18] },
      { geo: new THREE.ConeGeometry(0.05, 0.40, 4), color: 0x376b2e, pos: [-0.1, 0.20, -0.04], rot: [0.15, 1.4, 0.22] },
      { geo: new THREE.ConeGeometry(0.04, 0.30, 4), color: 0x59a046, pos: [0.02, 0.15, -0.12], rot: [-0.2, 2.2, 0.1] }
    ]);
    var mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
    var COUNT = 4200;
    var inst = new THREE.InstancedMesh(blade, mat, COUNT);
    inst.castShadow = false;
    inst.receiveShadow = true;
    var mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3();
    var seed = (world.seed | 0) || 12345;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    var placed = 0, tries = 0;
    while (placed < COUNT && tries < COUNT * 12) {
      tries++;
      var wx = rnd() * world.size, wz = rnd() * world.size;
      var gx = Math.max(0, Math.min(world.grid - 1, Math.floor(wx / world.cell)));
      var gy = Math.max(0, Math.min(world.grid - 1, Math.floor(wz / world.cell)));
      var bi = world.tiles[gy * world.grid + gx];
      if (bi !== 0 && bi !== 1 && bi !== 2) continue;   // grass / dirt / sand only
      var h = groundHeight(world, wx, wz);
      var s2 = 0.7 + rnd() * 0.9;
      e.set(0, rnd() * Math.PI * 2, 0);
      q.setFromEuler(e);
      v.set(wx, h, wz);
      sc.set(s2, 0.7 + rnd() * 0.8, s2);
      mtx.compose(v, q, sc);
      inst.setMatrixAt(placed++, mtx);
    }
    inst.count = placed;
    inst.instanceMatrix.needsUpdate = true;
    inst.name = 'grass';
    return inst;
  }

  /* ---------------------------------------------------------------- props */

  function treeMesh(kind, scale) {
    var grp = new THREE.Group();
    var trunkH = kind === 'pine' || kind === 'spruce' ? 1.5 : 2.1;
    var trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22 * scale, 0.34 * scale, trunkH * scale, 6),
      mat(0x5b4028)
    );
    trunk.position.y = trunkH * scale / 2;
    trunk.castShadow = true;
    grp.add(trunk);

    if (kind === 'pine' || kind === 'spruce' || kind === 'dead_pine') {
      var leafCol = kind === 'dead_pine' ? 0x6b5a3d : (kind === 'pine' ? 0x2f6b3a : 0x356f3f);
      for (var i = 0; i < 3; i++) {
        var r = (1.5 - i * 0.36) * scale;
        var cone = new THREE.Mesh(new THREE.ConeGeometry(r, 1.7 * scale, 7), mat(leafCol));
        cone.position.y = (trunkH + 0.35 + i * 1.05) * scale;
        cone.castShadow = true;
        grp.add(cone);
      }
    } else {
      var crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1.55 * scale, 0),
        mat(kind === 'birch' ? 0x7fb548 : 0x4e8b3a));
      crown.position.y = (trunkH + 0.9) * scale;
      crown.scale.set(1, 0.85, 1);
      crown.castShadow = true;
      grp.add(crown);
      var crown2 = new THREE.Mesh(new THREE.IcosahedronGeometry(1.05 * scale, 0),
        mat(kind === 'birch' ? 0x8cc552 : 0x5a9a41));
      crown2.position.set(0.7 * scale, (trunkH + 1.5) * scale, 0.4 * scale);
      crown2.castShadow = true;
      grp.add(crown2);
    }
    return grp;
  }

  function propMesh(prop, scale) {
    var kind = prop.kind || '';
    var grp = new THREE.Group();
    if (/tree|pine|birch|oak|spruce/.test(kind)) return treeMesh(kind, scale || 1);
    if (/bush/.test(kind)) {
      var b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.8 * (scale || 1), 0), mat(0x3f7a34));
      b.position.y = 0.55; b.scale.y = 0.75; b.castShadow = true;
      grp.add(b);
      return grp;
    }
    if (/rock/.test(kind)) {
      var r = new THREE.Mesh(new THREE.DodecahedronGeometry(0.9 * (scale || 1), 0), mat(0x7b7873));
      r.position.y = 0.55; r.rotation.set(0.4, hash2(1, 2, 3) * 3, 0.2);
      r.castShadow = true; r.receiveShadow = true;
      grp.add(r);
      return grp;
    }
    if (/car|wreck|truck/.test(kind)) {
      var body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.75, 3.4), mat(0x7a4a3f));
      body.position.y = 0.6; body.castShadow = true;
      var cab = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.6, 1.5), mat(0x4a5866));
      cab.position.set(0, 1.2, -0.4); cab.castShadow = true;
      grp.add(body); grp.add(cab);
      return grp;
    }
    if (/barrel/.test(kind)) {
      var bar = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.05, 8), mat(0x8a5a2a));
      bar.position.y = 0.53; bar.castShadow = true;
      grp.add(bar);
      return grp;
    }
    if (/crate|box|container/.test(kind)) {
      var box = new THREE.Mesh(new THREE.BoxGeometry(1.15, 1.0, 1.15), mat(0x8a6a44));
      box.position.y = 0.5; box.castShadow = true; box.receiveShadow = true;
      grp.add(box);
      return grp;
    }
    // wall / door / fence / anything structural
    var wall = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.25, 0.3), mat(0x8f8375));
    wall.position.y = 0.62; wall.castShadow = true;
    grp.add(wall);
    return grp;
  }

  /* ---------------------------------------------------------------- buildings */

  var POI_WALL = {
    blue_house: 0xd9d2c2, barn: 0x8f3f33, warehouse: 0x9aa2a8, container: 0x3f6f8f,
    construction_site: 0xa8a29a, armory: 0x4d5748, mansion: 0xe0d8c6, lodge: 0x7a5236,
    cabin: 0x8a6a44
  };

  /* A POI used to be ONE box the size of the whole footprint — a 432 x 392 room with four walls,
   * which from the air read as a flat beige slab and from the ground as a warehouse you could see
   * across. It is now a district: the same footprint is split into lots with streets between them,
   * every lot gets a building of its own with a door, windows, plinth and a roof, and all of the
   * walls in the district are merged into a single vertex-coloured mesh so the whole POI still
   * costs a handful of draw calls.
   */
  function buildHouse(poi, world) {
    var grp = new THREE.Group();
    var w = poi.w, d = poi.h;
    var wallCol = POI_WALL[poi.kind] || 0xbfb8a8;
    var floorTex = (poi.art && poi.art.floor && poi.art.floor[0]) || null;
    var roofTex = (poi.art && poi.art.roof && poi.art.roof[0]) || null;
    if (floorTex && typeof floorTex === 'object') floorTex = floorTex.path;
    if (roofTex && typeof roofTex === 'object') roofTex = roofTex.path;

    var seed = ((poi.cx | 0) * 73856093 ^ (poi.cy | 0) * 19349663) | 0;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

    /* the vendored floor art is a bright tile sheet; knocked back to a concrete tone so the plaza
     * reads as paving instead of a car park */
    var floor = new THREE.Mesh(new THREE.BoxGeometry(w, 0.25, d),
      mat(0xa8a496, { map: tex(floorTex, Math.max(2, Math.round(w / 24))) }));
    floor.position.y = 0.12;
    floor.receiveShadow = true;
    grp.add(floor);

    var cols = Math.max(2, Math.min(4, Math.round(w / 118)));
    var rows = Math.max(2, Math.min(4, Math.round(d / 118)));
    var lotW = w / cols, lotD = d / rows;
    var street = Math.max(7, Math.min(15, lotW * 0.15));

    var wallParts = [], roofParts = [];
    for (var ry = 0; ry < rows; ry++) {
      for (var rx = 0; rx < cols; rx++) {
        if (rnd() < 0.15) continue;                       // courtyards, not a solid block
        var bw = Math.max(12, lotW - street - rnd() * 7);
        var bd = Math.max(12, lotD - street - rnd() * 7);
        var bh = 3.6 + rnd() * 2.8;
        var ox = (rx + 0.5) * lotW - w / 2 + (rnd() - 0.5) * 4;
        var oz = (ry + 0.5) * lotD - d / 2 + (rnd() - 0.5) * 4;
        var cc = new THREE.Color(wallCol).multiplyScalar(0.88 + rnd() * 0.26).getHex();
        var t = 0.36, halfW = bw / 2, halfD = bd / 2;
        var doorW = Math.min(3.6, bw * 0.34);
        var gap = doorW / 2;

        function seg(px, py, pz, sx, sy, sz, col) {
          /* uvRepeat keeps texel density constant: without it every wall, whatever its size,
           * maps the texture exactly once and a 110-unit wall shows a 110-unit-wide smear. */
          wallParts.push({
            geo: new THREE.BoxGeometry(sx, sy, sz),
            color: col == null ? cc : col,
            pos: [ox + px, py, oz + pz],
            uvRepeat: [Math.max(1, sx / 5), Math.max(1, sy / 5)]
          });
        }
        // back + both sides solid, front split around the door gap
        seg(0, bh / 2, halfD, bw, bh, t);
        seg(-halfW, bh / 2, 0, t, bh, bd);
        seg(halfW, bh / 2, 0, t, bh, bd);
        var frontSeg = halfW - gap;
        if (frontSeg > 0.7) {
          seg(-(gap + frontSeg / 2), bh / 2, -halfD, frontSeg, bh, t);
          seg((gap + frontSeg / 2), bh / 2, -halfD, frontSeg, bh, t);
        } else {
          seg(0, bh / 2, -halfD, bw, bh, t);               // too narrow for a doorway: solid front
        }
        seg(0, bh - 1.05, -halfD, doorW, 2.1, t);          // wall above the door
        // skirting, fascia
        seg(0, 0.25, 0, bw + 0.3, 0.5, bd + 0.3, 0x4b453a);
        seg(0, bh - 0.02, 0, bw + 0.9, 0.16, bd + 0.9, 0x3a342c);
        // window panes
        for (var sgn = -1; sgn <= 1; sgn += 2) {
          seg(sgn * bw * 0.27, bh * 0.64, -halfD - 0.02, 1.6, 1.0, 0.1, 0x2b3a46);
          seg(-halfW - 0.02, bh * 0.64, sgn * bd * 0.27, 0.1, 1.0, 1.6, 0x2b3a46);
          seg(halfW + 0.02, bh * 0.64, sgn * bd * 0.27, 0.1, 1.0, 1.6, 0x2b3a46);
        }
        /* District clutter: crates, barrels, a sandbag line and a lamp post per lot. They merge
         * into the same wall mesh, so a furnished district still costs one draw call. */
        for (var cr = 0; cr < 3; cr++) {
          var cs = 0.9 + rnd() * 0.6;
          var cxp = ox + (rnd() - 0.5) * (bw + 7), czp = oz + (rnd() - 0.5) * (bd + 7);
          if (Math.abs(cxp - ox) < halfW + 0.9 && Math.abs(czp - oz) < halfD + 0.9) continue;
          wallParts.push({
            geo: new THREE.BoxGeometry(cs, cs, cs),
            color: [0x8a6a44, 0x7d7261, 0x6f5a3c][cr % 3],
            pos: [cxp, cs / 2 + 0.14, czp],
            rot: [0, rnd() * Math.PI, 0]
          });
        }
        if (rnd() < 0.6) {
          var bx2 = ox + (rnd() > 0.5 ? 1 : -1) * (halfW + 2.1), bz2 = oz + (rnd() - 0.5) * bd * 0.7;
          wallParts.push({ geo: new THREE.CylinderGeometry(0.42, 0.42, 1.15, 8), color: 0x6b7f86, pos: [bx2, 0.72, bz2] });
        }
        if (rnd() < 0.5) {
          var sgn3 = rnd() > 0.5 ? 1 : -1;
          var sbx = ox + sgn3 * (halfW + 2.8), sbz = oz - halfD * 0.2;
          for (var sbi = 0; sbi < 3; sbi++) {
            wallParts.push({ geo: new THREE.BoxGeometry(0.95, 0.42, 0.62), color: 0x9c8f74,
                             pos: [sbx, 0.26 + sbi * 0.42, sbz + (sbi % 2) * 0.15] });
          }
        }
        if (rnd() < 0.45) {
          var lx2 = ox + halfW + 3.4, lz2 = oz + halfD + 2.6;
          wallParts.push({ geo: new THREE.CylinderGeometry(0.09, 0.12, 4.6, 6), color: 0x3f4348, pos: [lx2, 2.3, lz2] });
          wallParts.push({ geo: new THREE.BoxGeometry(0.62, 0.22, 0.62), color: 0xffe9b0, pos: [lx2, 4.66, lz2] });
        }

        /* Verticality: a third of the lots stack a smaller upper storey. Flat single-storey
         * boxes from a hilltop read as a car park; one upper floor gives the POI a skyline. */
        if (rnd() < 0.34 && bw > 14 && bd > 14) {
          var uw = bw * 0.62, ud = bd * 0.62, uh = 2.8 + rnd() * 1.4;
          seg(0, bh + uh / 2, 0, uw, uh, ud, cc);
          for (var sgn2 = -1; sgn2 <= 1; sgn2 += 2) {
            seg(sgn2 * uw * 0.26, bh + uh * 0.6, -ud / 2 - 0.02, 1.2, 0.8, 0.1, 0x2b3a46);
            seg(-uw / 2 - 0.02, bh + uh * 0.6, sgn2 * ud * 0.26, 0.1, 0.8, 1.2, 0x2b3a46);
            seg(uw / 2 + 0.02, bh + uh * 0.6, sgn2 * ud * 0.26, 0.1, 0.8, 1.2, 0x2b3a46);
          }
          roofParts.push({ geo: new THREE.BoxGeometry(uw + 0.8, 0.26, ud + 0.8), color: 0xffffff,
                           pos: [ox, bh + uh + 0.13, oz], uvRepeat: [Math.max(1, uw / 9), Math.max(1, ud / 9)] });
        } else {
          roofParts.push({ geo: new THREE.BoxGeometry(bw + 0.7, 0.3, bd + 0.7), color: 0xffffff, pos: [ox, bh + 0.15, oz],
                           uvRepeat: [Math.max(1, bw / 9), Math.max(1, bd / 9)] });
        }
      }
    }

    if (wallParts.length) {
      var wallMesh = new THREE.Mesh(bakeGeo(wallParts),
        new THREE.MeshLambertMaterial({ vertexColors: true, map: makeWallTexture() }));
      wallMesh.castShadow = true; wallMesh.receiveShadow = true;
      wallMesh.name = 'walls';
      grp.add(wallMesh);
      var roofGeo = bakeGeo(roofParts);
      var roofMat = new THREE.MeshLambertMaterial({ vertexColors: true, map: tex(roofTex, 1) });
      var roofMesh = new THREE.Mesh(roofGeo, roofMat);
      roofMesh.castShadow = true;
      roofMesh.name = 'roof';
      grp.add(roofMesh);
      grp.userData = { roof: roofMesh, w: w, d: d, cx: poi.cx, cy: poi.cy };
    } else {
      grp.userData = { roof: null, w: w, d: d, cx: poi.cx, cy: poi.cy };
    }

    grp.position.set(poi.cx, 0, poi.cy);
    return grp;
  }

  /* ---------------------------------------------------------------- people */

  /* Bake a pile of primitives into ONE vertex-coloured geometry.
   *
   * A detailed soldier used to cost 8 draw calls and looked like a stack of boxes; 20 primitives
   * per actor x 32 actors is 640 calls, which is why the first pass stayed at 8. Merging by
   * vertex colour gives the same 1-call-per-limb budget with ten times the detail. */
  function bakeGeo(parts) {
    var pos = [], nor = [], col = [], uvs = [];
    var m4 = new THREE.Matrix4(), nm = new THREE.Matrix3();
    var c = new THREE.Color(), v = new THREE.Vector3(), q = new THREE.Quaternion(), e = new THREE.Euler();
    for (var i2 = 0; i2 < parts.length; i2++) {
      var pt = parts[i2];
      var g = pt.geo.index ? pt.geo.toNonIndexed() : pt.geo;
      var pa = g.attributes.position, na = g.attributes.normal;
      e.set(pt.rot ? pt.rot[0] : 0, pt.rot ? pt.rot[1] : 0, pt.rot ? pt.rot[2] : 0);
      q.setFromEuler(e);
      m4.compose(
        new THREE.Vector3(pt.pos ? pt.pos[0] : 0, pt.pos ? pt.pos[1] : 0, pt.pos ? pt.pos[2] : 0),
        q,
        new THREE.Vector3(pt.scale ? pt.scale[0] : (pt.s || 1), pt.scale ? pt.scale[1] : (pt.s || 1), pt.scale ? pt.scale[2] : (pt.s || 1))
      );
      nm.getNormalMatrix(m4);
      if (ctCache[pt.color] == null) ctCache[pt.color] = new THREE.Color(pt.color);
      c.copy(ctCache[pt.color]);
      var ua = g.attributes.uv;
      var uru = pt.uvRepeat ? pt.uvRepeat[0] : 1, urv = pt.uvRepeat ? pt.uvRepeat[1] : 1;
      for (var k = 0; k < pa.count; k++) {
        v.set(pa.getX(k), pa.getY(k), pa.getZ(k)).applyMatrix4(m4);
        pos.push(v.x, v.y, v.z);
        v.set(na.getX(k), na.getY(k), na.getZ(k)).applyMatrix3(nm).normalize();
        nor.push(v.x, v.y, v.z);
        col.push(c.r, c.g, c.b);
        if (ua) uvs.push(ua.getX(k) * uru, ua.getY(k) * urv); else uvs.push(0, 0);
      }
    }
    var out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    if (uvs.length) out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    out.computeBoundingSphere();
    return out;
  }
  var ctCache = {};

  function soldierMaterial() {
    if (!SOLDIER_MAT) {
      SOLDIER_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.74, metalness: 0.06 });
    }
    return SOLDIER_MAT;
  }
  var SOLDIER_MAT = null;

  function makeSoldier(color, isPlayer) {
    var grp = new THREE.Group();
    var B = THREE.BoxGeometry, S = THREE.SphereGeometry, C = THREE.CylinderGeometry;
    var skin = 0xc98f62, suit = color, dark = 0x262b33, boot = 0x1b1f25;
    var rigCol = 0x30363f, strapCol = 0x3d444e, metal = 0x8f98a3;
    var glow = isPlayer ? 0x53d8ff : 0xff7a4a;

    // ---- torso: hips, waist, tapered chest, chest rig, pouches, belt, pack, shoulders, head
    var torsoGeo = bakeGeo([
      { geo: new B(0.50, 0.22, 0.32), color: suit, pos: [0, 0.92, 0] },
      { geo: new B(0.44, 0.20, 0.30), color: dark, pos: [0, 1.06, 0] },
      { geo: new B(0.58, 0.46, 0.34), color: suit, pos: [0, 1.32, 0] },
      { geo: new B(0.62, 0.16, 0.36), color: suit, pos: [0, 1.50, 0] },        // shoulder yoke
      { geo: new B(0.40, 0.30, 0.07), color: rigCol, pos: [0, 1.34, 0.20] },   // chest rig
      { geo: new B(0.10, 0.13, 0.07), color: strapCol, pos: [-0.13, 1.24, 0.235] },
      { geo: new B(0.10, 0.13, 0.07), color: strapCol, pos: [0.01, 1.24, 0.235] },
      { geo: new B(0.10, 0.13, 0.07), color: strapCol, pos: [0.15, 1.24, 0.235] },
      { geo: new B(0.50, 0.09, 0.34), color: boot, pos: [0, 0.99, 0] },        // belt
      { geo: new B(0.10, 0.07, 0.05), color: metal, pos: [0, 0.99, 0.19] },    // buckle
      { geo: new S(0.155, 8, 6), color: suit, pos: [-0.33, 1.49, 0] },         // shoulder pads
      { geo: new S(0.155, 8, 6), color: suit, pos: [0.33, 1.49, 0] },
      { geo: new C(0.085, 0.095, 0.09, 8), color: skin, pos: [0, 1.60, 0] },   // neck
      { geo: new S(0.205, 10, 8), color: skin, pos: [0, 1.72, 0] },            // head
      { geo: new S(0.235, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.58), color: isPlayer ? 0x2f5f7f : 0x39404a, pos: [0, 1.745, 0] },
      { geo: new B(0.27, 0.085, 0.09), color: glow, pos: [0, 1.735, 0.165] },  // visor / goggles
      { geo: new B(0.075, 0.05, 0.045), color: 0xffe9a8, pos: [0, 1.815, 0.16] }, // head lamp
      { geo: new B(0.40, 0.46, 0.22), color: 0x39434f, pos: [0, 1.32, -0.27] },   // pack
      { geo: new B(0.34, 0.10, 0.20), color: 0x2b333d, pos: [0, 1.52, -0.27] },   // pack lid
      { geo: new B(0.07, 0.38, 0.05), color: strapCol, pos: [-0.17, 1.35, 0.185] },
      { geo: new B(0.07, 0.38, 0.05), color: strapCol, pos: [0.17, 1.35, 0.185] },
      { geo: new C(0.03, 0.03, 0.34, 5), color: metal, pos: [0.21, 1.60, -0.30], rot: [0.25, 0, 0] } // antenna
    ]);
    var torso = new THREE.Mesh(torsoGeo, soldierMaterial());

    // ---- legs pivot at the hip so the walk cycle swings from the joint
    function legMesh(side) {
      return new THREE.Mesh(bakeGeo([
        { geo: new B(0.20, 0.40, 0.22), color: dark, pos: [0, -0.22, 0] },
        { geo: new B(0.185, 0.09, 0.24), color: boot, pos: [0, -0.44, 0.01] },   // knee pad
        { geo: new B(0.175, 0.32, 0.20), color: dark, pos: [0, -0.64, 0] },
        { geo: new B(0.215, 0.14, 0.30), color: boot, pos: [0, -0.83, 0.04] }    // boot
      ]), soldierMaterial());
    }
    var legL = legMesh(-1), legR = legMesh(1);
    legL.position.set(-0.145, 1.0, 0);
    legR.position.set(0.145, 1.0, 0);

    // ---- arms pivot at the shoulder; the right one carries the weapon
    function armMesh(side) {
      return new THREE.Mesh(bakeGeo([
        { geo: new B(0.145, 0.40, 0.145), color: suit, pos: [0, -0.20, 0] },
        { geo: new B(0.125, 0.10, 0.135), color: boot, pos: [0, -0.42, 0] },     // elbow pad
        { geo: new B(0.135, 0.30, 0.135), color: suit, pos: [0, -0.56, 0] },
        { geo: new B(0.155, 0.14, 0.17), color: 0x1f242b, pos: [0, -0.75, 0.02] } // glove
      ]), soldierMaterial());
    }
    var armL = armMesh(-1), armR = armMesh(1);
    armL.position.set(-0.355, 1.46, 0);
    armR.position.set(0.355, 1.46, 0);

    [torso, legL, legR, armL, armR].forEach(function (m) {
      m.castShadow = true;
      m.receiveShadow = true;
      grp.add(m);
    });
    grp.userData = { legL: legL, legR: legR, armR: armR, armL: armL, torso: torso, head: torso, hand: armR };
    return grp;
  }

  function makeGun(weapon) {
    var len = 0.9 + (weapon ? Math.min(1.1, weapon.range / 700) : 0.3);
    var tier = GUN_TIER_COLOR[weapon ? weapon.rank : 0] || 0x9aa3ad;
    var geo = bakeGeo([
      { geo: new THREE.BoxGeometry(0.085, 0.13, len * 0.62), color: 0x22262b, pos: [0, 0, len * 0.20] },
      { geo: new THREE.BoxGeometry(0.055, 0.055, len * 0.55), color: 0x14181c, pos: [0, 0.02, len * 0.72] },
      { geo: new THREE.CylinderGeometry(0.028, 0.03, len * 0.34, 6), color: 0x0f1216, pos: [0, 0.02, len * 0.98], rot: [Math.PI / 2, 0, 0] },
      { geo: new THREE.BoxGeometry(0.07, 0.22, 0.10), color: 0x2b3138, pos: [0, -0.15, len * 0.28] },   // magazine
      { geo: new THREE.BoxGeometry(0.05, 0.10, 0.10), color: 0x1a1e23, pos: [0, -0.11, len * 0.02] },   // grip
      { geo: new THREE.BoxGeometry(0.06, 0.08, 0.16), color: 0x20252b, pos: [0, 0.02, -len * 0.12] },   // stock
      { geo: new THREE.BoxGeometry(0.095, 0.045, 0.16), color: tier, pos: [0, 0.07, len * 0.22] },       // tier accent
      { geo: new THREE.BoxGeometry(0.045, 0.05, 0.05), color: 0xd6e6ff, pos: [0, 0.10, len * 0.30] }     // sight
    ]);
    var mesh = new THREE.Mesh(geo, soldierMaterial());
    mesh.castShadow = true;
    return mesh;
  }

  var GUN_TIER_COLOR = [0x9aa3ad, 0x4ade80, 0x38bdf8, 0xa855f7, 0xfbbf24];

  function makeGun(weapon) {
    var grp = new THREE.Group();
    var len = 0.9 + (weapon ? Math.min(1.1, weapon.range / 700) : 0.3);
    var body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, len), mat(0x22262b));
    body.position.z = len / 2;
    var barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, len * 0.5, 6), mat(0x14181c));
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = len * 0.95;
    var mag = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.24, 0.12), mat(0x2b3138));
    mag.position.set(0, -0.16, len * 0.35);
    var accent = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.2),
      mat(GUN_TIER_COLOR[weapon ? weapon.rank : 0] || 0x9aa3ad, { emissive: 0x111111 }));
    accent.position.set(0, 0.08, len * 0.2);
    grp.add(body); grp.add(barrel); grp.add(mag); grp.add(accent);
    return grp;
  }

  /* ---------------------------------------------------------------- factory blocks */

  var BLOCK_TEX = {
    drill: 'vendor/mindustry/blocks/drills/mechanical-drill/mechanical-drill.png',
    conveyor: 'vendor/mindustry/blocks/distribution-conveyors/conveyor/conveyor.png',
    fabricator: 'vendor/mindustry/blocks/production/graphite-press/graphite-press.png',
    turret: 'vendor/mindustry/blocks/turrets/duo/duo.png',
    wall: 'vendor/mindustry/blocks/walls/copper-wall/copper-wall.png'
  };
  var BLOCK_COLOR = { drill: 0x8a6a44, conveyor: 0x4a5560, fabricator: 0x6b7a52, turret: 0x6f5b46, wall: 0x8a8f96 };

  function makeBlock(kind, cell) {
    var grp = new THREE.Group();
    var s = cell * 1.35;
    var h = kind === 'wall' ? 2.2 : kind === 'turret' ? 1.15 : 0.8;
    var base = new THREE.Mesh(new THREE.BoxGeometry(s, h, s), mat(BLOCK_COLOR[kind] || 0x777));
    base.position.y = h / 2;
    base.castShadow = true; base.receiveShadow = true;
    grp.add(base);
    var topMat = mat(0xffffff, { map: tex(BLOCK_TEX[kind] || BLOCK_TEX.conveyor) });
    var top = new THREE.Mesh(new THREE.PlaneGeometry(s * 0.94, s * 0.94), topMat);
    top.rotation.x = -Math.PI / 2;
    top.position.y = h + 0.01;
    grp.add(top);
    if (kind === 'turret') {
      var barrel = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 1.1), mat(0x2b3138));
      barrel.position.set(0, h + 0.35, 0.35);
      barrel.name = 'barrel';
      grp.add(barrel);
    }
    if (kind === 'drill') {
      var bit = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.7, 6), mat(0x9aa3ad));
      bit.position.y = h + 0.3;
      bit.name = 'bit';
      grp.add(bit);
    }
    grp.userData = { kind: kind, h: h };
    return grp;
  }

  function makeItem(type, cell) {
    var col = type === 'titanium' ? 0xcfe6ff : type === 'coal' ? 0x4a4a4a : 0xd98342;
    var m = new THREE.Mesh(new THREE.BoxGeometry(cell * 0.26, cell * 0.26, cell * 0.26), mat(col, { emissive: 0x221100 }));
    return m;
  }

  /* ---------------------------------------------------------------- instanced props */

  var PROTO_CACHE = {};

  /* One prototype = the parts a prop is made of, in local space. Parts of the same prototype
   * become one InstancedMesh each, so a forest costs a handful of draw calls. */
  function propProto(kind) {
    if (PROTO_CACHE[kind]) return PROTO_CACHE[kind];
    var parts = [];
    function add(geo, color, y, opts) {
      parts.push({ geo: geo, color: color, y: y, opts: opts || {} });
    }
    if (/pine|spruce|dead_pine/.test(kind)) {
      add(new THREE.CylinderGeometry(0.2, 0.32, 1.5, 5), 0x5b4028, 0.75);
      var leaf = kind === 'dead_pine' ? 0x6b5a3d : (kind === 'pine' ? 0x2f6b3a : 0x356f3f);
      add(new THREE.ConeGeometry(1.5, 1.7, 7), leaf, 1.85, { tint: 0.12 });
      add(new THREE.ConeGeometry(1.15, 1.5, 7), leaf, 2.75, { tint: 0.18 });
      add(new THREE.ConeGeometry(0.78, 1.3, 7), leaf, 3.6, { tint: 0.24 });
    } else if (/tree|birch|oak/.test(kind)) {
      add(new THREE.CylinderGeometry(0.22, 0.34, 2.1, 6), 0x60452c, 1.05);
      add(new THREE.IcosahedronGeometry(1.5, 0), kind === 'birch' ? 0x86bd4e : 0x4e8b3a, 2.9, { tint: 0.16, squash: 0.85 });
      add(new THREE.IcosahedronGeometry(1.0, 0), kind === 'birch' ? 0x96cc5c : 0x5a9a41, 3.6, { tint: 0.2, offset: [0.7, 0, 0.4] });
    } else if (/bush/.test(kind)) {
      add(new THREE.IcosahedronGeometry(0.85, 0), 0x3f7a34, 0.5, { tint: 0.2, squash: 0.75 });
    } else if (/rock/.test(kind)) {
      add(new THREE.DodecahedronGeometry(0.9, 0), 0x7b7873, 0.5, { tint: 0.12 });
    } else if (/car|wreck|truck/.test(kind)) {
      add(new THREE.BoxGeometry(1.7, 0.75, 3.4), 0x7a4a3f, 0.6);
      add(new THREE.BoxGeometry(1.5, 0.6, 1.5), 0x4a5866, 1.2, { offset: [0, 0, -0.4] });
    } else if (/barrel/.test(kind)) {
      add(new THREE.CylinderGeometry(0.42, 0.42, 1.05, 8), 0x8a5a2a, 0.53);
    } else if (/crate|box|container/.test(kind)) {
      add(new THREE.BoxGeometry(1.15, 1.0, 1.15), 0x8a6a44, 0.5);
    } else {
      add(new THREE.BoxGeometry(1.9, 1.25, 0.3), 0x8f8375, 0.62);
    }
    PROTO_CACHE[kind] = parts;
    return parts;
  }

  function buildInstancedProps(scene, world) {
    var byKind = {};
    for (var i = 0; i < world.props.length; i++) {
      var p = world.props[i];
      var k = p.kind || 'wall';
      (byKind[k] = byKind[k] || []).push(p);
    }
    var mtx = new THREE.Matrix4();
    var q = new THREE.Quaternion();
    var eul = new THREE.Euler();
    var vec = new THREE.Vector3();
    var scl = new THREE.Vector3();

    Object.keys(byKind).forEach(function (kind) {
      var list = byKind[kind];
      var proto = propProto(kind);
      for (var part = 0; part < proto.length; part++) {
        var def = proto[part];
        var mat = new THREE.MeshLambertMaterial({ color: def.color });
        var inst = new THREE.InstancedMesh(def.geo, mat, list.length);
        inst.castShadow = true;
        inst.receiveShadow = true;
        var col = new THREE.Color();
        for (var j = 0; j < list.length; j++) {
          var pr = list[j];
          var sc = 0.85 + (pr.r % 7) * 0.07;
          eul.set(0, hash2(j, 7, world.seed | 0) * Math.PI * 2, 0);
          q.setFromEuler(eul);
          vec.set(pr.x, groundHeight(world, pr.x, pr.y), pr.y);
          scl.set(sc, def.opts.squash ? sc * def.opts.squash : sc, sc);
          mtx.compose(vec, q, scl);
          inst.setMatrixAt(j, mtx);
          if (def.opts.tint) {
            var t = hash2(j, 11, world.seed | 0);
            col.setHex(def.color).multiplyScalar(0.82 + t * def.opts.tint * 2);
            inst.setColorAt(j, col);
          }
        }
        inst.instanceMatrix.needsUpdate = true;
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
        scene.add(inst);
      }
    });
  }

  /* ---------------------------------------------------------------- scene */

  /* Frame budget, not device pixel ratio: a 2x buffer on a tall phone shades ~5.3 MP before the
   * composer gets involved. Cap the actual shaded pixels instead, and keep the same formula in
   * the resize path so a rotation can't silently restore the old cost. */
  var PIX_BUDGET = 2.4e6;
  function budgetDpr(w, h) {
    var dev = g.devicePixelRatio || 1;
    return Math.max(0.7, Math.min(dev, Math.sqrt(PIX_BUDGET / Math.max(1, w * h)), 1.6));
  }

  /* ---------------------------------------------------------------- post
   *
   * A hand-rolled chain: three.js r156's UMD build ships no addons, so EffectComposer is not
   * available offline. Scene -> HDR target -> bright pass -> separable blur -> composite
   * (exposure, bloom add, filmic shoulder, grade, vignette, grain, sRGB encode).
   *
   * Why not the engine tone mapper: ACESFilmic lifts shadows and desaturates saturated albedo
   * (a rich green vertex colour comes back pale), which is exactly the "washed out, no
   * contrast" read on the first pass. The shoulder below is an extended Reinhard: it keeps
   * saturation in the midtones and only compresses the highlights.
   */

  var QUAD_VS = 'varying vec2 vUv;\nvoid main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

  var BRIGHT_FS = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D tDiffuse;',
    'uniform float threshold;',
    'void main(){',
    '  vec3 c = texture2D(tDiffuse, vUv).rgb;',
    '  float l = max(c.r, max(c.g, c.b));',
    '  float k = smoothstep(threshold, threshold + 0.55, l);',
    '  gl_FragColor = vec4(c * k, 1.0);',
    '}'
  ].join('\n');

  var BLUR_FS = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D tDiffuse;',
    'uniform vec2 dir;',
    'void main(){',
    '  vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.227027;',
    '  sum += (texture2D(tDiffuse, vUv + dir * 1.3846).rgb + texture2D(tDiffuse, vUv - dir * 1.3846).rgb) * 0.316216;',
    '  sum += (texture2D(tDiffuse, vUv + dir * 3.2308).rgb + texture2D(tDiffuse, vUv - dir * 3.2308).rgb) * 0.070270;',
    '  gl_FragColor = vec4(sum, 1.0);',
    '}'
  ].join('\n');

  var COMP_FS = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D tScene;',
    'uniform sampler2D tBloom;',
    'uniform float exposure;',
    'uniform float bloomK;',
    'uniform float sat;',
    'uniform float vig;',
    'uniform float grain;',
    'uniform float time;',
    'uniform float hurt;',
    'uniform vec3 tint;',
    'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    'vec3 shoulder(vec3 x){',
    '  float L = dot(x, vec3(0.2126, 0.7152, 0.0722));',
    '  return x * (1.0 + L * 0.0833) / (1.0 + L);',
    '}',
    'void main(){',
    '  vec3 c = texture2D(tScene, vUv).rgb * exposure;',
    '  c += texture2D(tBloom, vUv).rgb * bloomK;',
    '  c = shoulder(c);',
    '  c *= tint;',
    '  c = mix(c, c * vec3(1.18, 0.86, 0.86), hurt * 0.55);',
    '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '  c = mix(vec3(l), c, sat);',
    '  vec2 d = (vUv - 0.5) * vec2(1.0, 0.82);',
    '  float v = smoothstep(0.76, 0.24, length(d) * 1.45);',
    '  c *= mix(1.0, v, vig);',
    '  c += (hash(vUv * vec2(1024.0, 768.0) + time) - 0.5) * grain;',
    '  c = clamp(c, 0.0, 1.0);',
    '  gl_FragColor = vec4(pow(c, vec3(0.4545)), 1.0);',
    '}'
  ].join('\n');

  function makePost(renderer, w, h, dpr) {
    var mkW = Math.max(2, Math.floor(w * dpr)), mkH = Math.max(2, Math.floor(h * dpr));
    var hdrOpts = {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false
    };
    if (renderer.capabilities && renderer.capabilities.isWebGL2) hdrOpts.samples = 2;
    var sceneRT = new THREE.WebGLRenderTarget(mkW, mkH, hdrOpts);
    sceneRT.texture.colorSpace = THREE.NoColorSpace;

    function lowres(div) {
      return new THREE.WebGLRenderTarget(Math.max(2, Math.floor(mkW / div)), Math.max(2, Math.floor(mkH / div)), {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false
      });
    }
    var bloomA = lowres(4), bloomB = lowres(4), bloomC = lowres(8), bloomD = lowres(8);

    var quadGeo = new THREE.PlaneGeometry(2, 2);
    var quad = new THREE.Mesh(quadGeo, null);
    quad.frustumCulled = false;
    var quadScene = new THREE.Scene();
    quadScene.add(quad);
    var quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    quadCam.position.z = 1;

    var brightMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VS, fragmentShader: BRIGHT_FS, depthTest: false, depthWrite: false,
      uniforms: { tDiffuse: { value: null }, threshold: { value: 0.82 } }
    });
    var blurMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VS, fragmentShader: BLUR_FS, depthTest: false, depthWrite: false,
      uniforms: { tDiffuse: { value: null }, dir: { value: new THREE.Vector2() } }
    });
    var compMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VS, fragmentShader: COMP_FS, depthTest: false, depthWrite: false,
      uniforms: {
        tScene: { value: null }, tBloom: { value: null },
        /* exposure compensates for the shoulder: extended Reinhard maps 1.0 to ~0.54, so a
         * neutral exposure reads half a stop dark before the grade even starts */
        exposure: { value: 1.62 }, bloomK: { value: 0.5 },
        sat: { value: 1.2 }, vig: { value: 0.38 }, grain: { value: 0.02 },
        time: { value: 0 }, hurt: { value: 0 }, tint: { value: new THREE.Color(1, 1, 1) }
      }
    });

    return {
      enabled: true,
      sceneRT: sceneRT, bloomA: bloomA, bloomB: bloomB, bloomC: bloomC, bloomD: bloomD,
      quad: quad, quadScene: quadScene, quadCam: quadCam,
      brightMat: brightMat, blurMat: blurMat, compMat: compMat,
      w: w, h: h, dpr: dpr,
      resize: function (nw, nh, ndpr) {
        this.w = nw; this.h = nh; this.dpr = ndpr;
        var pw = Math.max(2, Math.floor(nw * ndpr)), ph = Math.max(2, Math.floor(nh * ndpr));
        sceneRT.setSize(pw, ph);
        bloomA.setSize(Math.max(2, pw >> 2), Math.max(2, ph >> 2));
        bloomB.setSize(Math.max(2, pw >> 2), Math.max(2, ph >> 2));
        bloomC.setSize(Math.max(2, pw >> 3), Math.max(2, ph >> 3));
        bloomD.setSize(Math.max(2, pw >> 3), Math.max(2, ph >> 3));
      },
      dispose: function () {
        sceneRT.dispose(); bloomA.dispose(); bloomB.dispose(); bloomC.dispose(); bloomD.dispose();
        brightMat.dispose(); blurMat.dispose(); compMat.dispose(); quadGeo.dispose();
      }
    };
  }

  S.create = function (canvas, world) {
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(budgetDpr(g.innerWidth || 390, g.innerHeight || 844));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    /* The composite pass does its own shoulder + sRGB encode. Leaving the engine tone mapper on
     * as well double-grades the frame and lifts every shadow toward grey. */
    renderer.toneMapping = THREE.NoToneMapping;
    if (THREE.LinearSRGBColorSpace) renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0x8ec6e6);
    /* fog colour is the horizon colour: a mismatch here is what draws a hard cut-out line
     * across the sky where the terrain ends */
    scene.fog = new THREE.Fog(0xcfe6f2, 420, 1650);

    var camera = new THREE.PerspectiveCamera(62, 1, 0.4, 3000);

    // sky dome: a vertical gradient on the inside of a big sphere, so the horizon reads
    var skyGeo = new THREE.SphereGeometry(2400, 32, 20);
    var skyCol = [];
    var posAttr = skyGeo.attributes.position;
    var skyTop = new THREE.Color(0x2a6fb4), skyMid = new THREE.Color(0x79b6e0);
    var skyHor = new THREE.Color(0xdff1fa), skyWarm = new THREE.Color(0xffeeda);
    var c2 = new THREE.Color();
    for (var si = 0; si < posAttr.count; si++) {
      var yy = posAttr.getY(si) / 2400;                    // -1 nadir .. 0 horizon .. 1 zenith
      if (yy <= 0) {
        // below the horizon the dome is only ever seen as haze over distant water
        c2.copy(skyHor).lerp(new THREE.Color(0x9fb8c8), Math.min(1, -yy * 2.2));
      } else {
        /* three stops placed where the camera actually looks: the visible band is roughly
         * y=0..0.35R at a 3.6-unit eye height, so the warm horizon must live inside it */
        /* The camera sits 3.6 units up with a 62-degree lens pitched slightly down, so the
         * VISIBLE sky is only y=0..0.28R. Stops placed higher than that render as one flat
         * pale band — which is exactly what the first attempt looked like. */
        /* The camera is pitched down, so only y = 0..0.28R of the dome is ever on screen. A warm
         * horizon band wider than a few degrees eats the whole visible sky and the frame reads
         * "sunset haze" instead of blue day. */
        if (yy < 0.016) c2.copy(skyHor).lerp(skyWarm, 1 - yy / 0.016);
        else if (yy < 0.075) c2.copy(skyWarm).lerp(skyMid, (yy - 0.016) / 0.059);
        else c2.copy(skyMid).lerp(skyTop, Math.min(1, (yy - 0.075) / 0.19));
      }
      skyCol.push(c2.r, c2.g, c2.b);
    }
    skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(skyCol, 3));
    /* fog:false is load-bearing — the dome sits at 2400 units and the fog far plane is 1650, so
     * a fogged dome renders as one flat slab of fog colour and the gradient never appears. */
    var sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false }));
    scene.add(sky);

    /* Sun disc + corona on a billboard in the sun's direction. Cheap, and it gives the sky a
     * focal point instead of a bare gradient. */
    (function () {
      var cc = document.createElement('canvas');
      cc.width = cc.height = 128;
      var cx2 = cc.getContext('2d');
      var rg = cx2.createRadialGradient(64, 64, 4, 64, 64, 64);
      rg.addColorStop(0, 'rgba(255,252,240,1)');
      rg.addColorStop(0.18, 'rgba(255,238,196,0.95)');
      rg.addColorStop(0.45, 'rgba(255,214,150,0.28)');
      rg.addColorStop(1, 'rgba(255,200,120,0)');
      cx2.fillStyle = rg;
      cx2.fillRect(0, 0, 128, 128);
      var tex2 = new THREE.CanvasTexture(cc);
      if (THREE.SRGBColorSpace) tex2.colorSpace = THREE.SRGBColorSpace;
      var sunSpr = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex2, transparent: true, depthWrite: false, depthTest: false,
        blending: THREE.AdditiveBlending, fog: false
      }));
      sunSpr.scale.set(520, 520, 1);
      var dir = new THREE.Vector3(-260, 300, 180).normalize().multiplyScalar(2100);
      sunSpr.position.copy(dir);
      sunSpr.renderOrder = -1;
      scene.add(sunSpr);
    })();

    /* Clouds live as billboards out near the sky dome: a horizontal plane at 90 units is
     * overhead and out of frame for a camera that never looks above the horizon. */
    (function () {
      var cc = document.createElement('canvas');
      cc.width = 256; cc.height = 128;
      var cx3 = cc.getContext('2d');
      var sd = 17;
      function rnd2() { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return sd / 0x7fffffff; }
      for (var blob = 0; blob < 26; blob++) {
        var bx = 40 + rnd2() * 176, by = 40 + rnd2() * 48, br = 14 + rnd2() * 30;
        var rg2 = cx3.createRadialGradient(bx, by, 1, bx, by, br);
        rg2.addColorStop(0, 'rgba(255,255,255,0.55)');
        rg2.addColorStop(1, 'rgba(255,255,255,0)');
        cx3.fillStyle = rg2;
        cx3.beginPath(); cx3.arc(bx, by, br, 0, 6.2832); cx3.fill();
      }
      var tex3 = new THREE.CanvasTexture(cc);
      if (THREE.SRGBColorSpace) tex3.colorSpace = THREE.SRGBColorSpace;
      var cloudMat2 = new THREE.SpriteMaterial({
        map: tex3, transparent: true, opacity: 0.72, depthWrite: false, depthTest: false, fog: false
      });
      for (var ci = 0; ci < 16; ci++) {
        var spr = new THREE.Sprite(cloudMat2);
        var ang = (ci / 16) * Math.PI * 2 + 0.3;
        var rad = 1650 + (ci % 4) * 90;
        spr.position.set(Math.cos(ang) * rad, 150 + (ci % 5) * 62, Math.sin(ang) * rad);
        var wsc = 620 + (ci % 3) * 220;
        spr.scale.set(wsc, wsc * 0.42, 1);
        spr.renderOrder = -2;
        scene.add(spr);
      }
    })();

    scene.add(new THREE.HemisphereLight(0xbfdcf5, 0x3a4a2c, 0.24));
    var sun = new THREE.DirectionalLight(0xffeec2, 3.1);
    sun.position.set(-260, 420, 180);
    sun.castShadow = true;
    /* 2048 over a +-110 unit frustum is ~10 cm/texel — a 1024 map across +-520 was 1 m/texel,
     * which is why every shadow looked like a smudge. The frustum tracks the player. */
    sun.shadow.mapSize.set(2048, 2048);
    var sc = 110;
    sun.shadow.camera.left = -sc; sun.shadow.camera.right = sc;
    sun.shadow.camera.top = sc; sun.shadow.camera.bottom = -sc;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 900;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
    scene.add(sun);
    scene.add(sun.target);

    /* Cool rim from behind keeps silhouettes from merging into the sky, and a dim bounce from
     * the water fills the side the sun can't reach. Three lights, no IBL — this box renders on
     * software GL in QA and an env map costs texture uploads it does not need. */
    var rim = new THREE.DirectionalLight(0x9fccff, 0.42);
    rim.position.set(220, 160, -260);
    scene.add(rim);
    var fill = new THREE.DirectionalLight(0xffd9b0, 0.12);
    fill.position.set(120, 40, 260);
    scene.add(fill);

    var terrain = buildTerrain(world);
    scene.add(terrain);
    var grass = buildGrass(world);
    scene.add(grass);
    var scatter = buildScatter(world);
    scene.add(scatter);
    var water = buildWater(world);
    scene.add(water);
    var shore = buildShore(world);
    if (shore) scene.add(shore);

    // storm wall
    var stormGeo = new THREE.CylinderGeometry(1, 1, 260, 64, 1, true);
    /* The wall was a flat 16% violet cylinder. A shader with a height fade, a fresnel rim and
     * scrolling bands reads as energy instead of tinted glass, and it is one material. */
    var stormMat = new THREE.ShaderMaterial({
      transparent: true, side: THREE.DoubleSide, depthWrite: false,
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0x9b5cf6) }, uHot: { value: new THREE.Color(0xd9c2ff) } },
      vertexShader: [
        'varying vec2 vUv; varying vec3 vPos;',
        'void main(){ vUv = uv; vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
      ].join('\n'),
      fragmentShader: [
        'precision highp float;',
        'varying vec2 vUv; varying vec3 vPos;',
        'uniform float uTime; uniform vec3 uColor; uniform vec3 uHot;',
        'void main(){',
        '  float h = smoothstep(0.0, 0.30, vUv.y) * (1.0 - smoothstep(0.72, 1.0, vUv.y));',
        '  float bands = 0.5 + 0.5 * sin(vUv.x * 160.0 + uTime * 2.2 + sin(vUv.y * 9.0 + uTime * 1.3) * 2.0);',
        '  float rim = pow(1.0 - abs(dot(normalize(vec3(vPos.x, 0.0, vPos.z)), vec3(0.0, 0.0, 1.0))), 1.4);',
        '  vec3 col = mix(uColor, uHot, bands * 0.55 + rim * 0.35);',
        '  float a = (0.10 + bands * 0.16) * h * (0.55 + rim * 0.9);',
        '  gl_FragColor = vec4(col, a);',
        '}'
      ].join('\n')
    });
    var storm = new THREE.Mesh(stormGeo, stormMat);
    scene.add(storm);
    var stormRing = new THREE.Mesh(new THREE.RingGeometry(0.985, 1, 96),
      new THREE.MeshBasicMaterial({ color: 0xc4a6ff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
    stormRing.rotation.x = -Math.PI / 2;
    scene.add(stormRing);

    // buildings
    var houses = [];
    for (var i = 0; i < world.pois.length; i++) {
      var house = buildHouse(world.pois[i], world);
      scene.add(house);
      houses.push(house);
    }

    // outposts: cheap authored structures scattered between the nine vendored POIs, so every
    // sightline has something to break and every rotation has cover
    var outposts = 0;
    var oRng = world.rng;
    for (var oi = 0; oi < 26; oi++) {
      var ox = 220 + oRng() * (world.size - 440);
      var oz = 220 + oRng() * (world.size - 440);
      if (!world.walkable(ox, oz)) continue;
      var tooClose = false;
      for (var q = 0; q < world.pois.length; q++) {
        var pp = world.pois[q];
        if (Math.abs(pp.cx - ox) < pp.w * 0.9 && Math.abs(pp.cy - oz) < pp.h * 0.9) { tooClose = true; break; }
      }
      if (tooClose) continue;
      var shack = new THREE.Group();
      var sw = 7 + Math.floor(oRng() * 5), sd = 6 + Math.floor(oRng() * 5);
      var sh = 2.6 + oRng() * 1.2;
      var wallMat = mat([0x8f7f6a, 0x6f7a6a, 0x7a6f7f, 0x8a6a52][oi % 4], { map: makeWallTexture() });
      var slab = new THREE.Mesh(new THREE.BoxGeometry(sw, 0.2, sd), new THREE.MeshLambertMaterial({ color: 0xcfc6b4 }));
      slab.position.y = 0.1; slab.receiveShadow = true;
      shack.add(slab);
      // three walls, one open side: cheap cover you can shoot through the gap
      for (var side = 0; side < 3; side++) {
        var isLong = side !== 0;
        var bw = isLong ? sw : 0.3, bd = isLong ? 0.3 : sd;
        var bxx = side === 1 ? -sw / 2 : side === 2 ? sw / 2 : 0;
        var bzz = side === 0 ? -sd / 2 : 0;
        var wm = new THREE.Mesh(new THREE.BoxGeometry(bw, sh, bd), wallMat);
        wm.position.set(bxx, sh / 2, bzz);
        wm.castShadow = true; wm.receiveShadow = true;
        shack.add(wm);
      }
      var rf = new THREE.Mesh(new THREE.BoxGeometry(sw + 0.6, 0.24, sd + 0.6), new THREE.MeshLambertMaterial({ color: 0x53595f }));
      rf.position.y = sh;
      rf.castShadow = true;
      shack.add(rf);
      shack.position.set(ox, groundHeight(world, ox, oz), oz);
      shack.rotation.y = oRng() * Math.PI * 2;
      scene.add(shack);
      outposts++;
    }

    // props: instanced per prototype part, because 1,500 trees as individual meshes would be
    // thousands of draw calls on a phone
    buildInstancedProps(scene, world);

    var post = makePost(renderer, g.innerWidth || canvas.width || 390, g.innerHeight || canvas.height || 844, renderer.getPixelRatio());

    var V = {
      THREE: THREE,
      renderer: renderer,
      scene: scene,
      camera: camera,
      sun: sun,
      world: world,
      post: post,
      dpr: renderer.getPixelRatio(),
      stormMesh: storm,
      stormRing: stormRing,
      water: water,
      houses: houses,
      groundHeight: function (x, z) { return groundHeight(world, x, z); },
      actorMeshes: {},
      bulletMesh: null,
      bullets: [],
      lootMeshes: [],
      blockMeshes: new Map(),
      itemMeshes: [],
      makeSoldier: makeSoldier,
      makeGun: makeGun,
      makeBlock: makeBlock,
      makeItem: makeItem,
      tex: tex,
      mat: mat
    };

    S.buildNearGrass(V);
    return V;
  };

  /* ---------------------------------------------------------------- per-frame sync */

  S.sync = function (V, G, dt) {
    var scene = V.scene, cam = V.camera;

    // --- people -----------------------------------------------------------
    var seen = {};
    for (var i = 0; i < G.actors.length; i++) {
      var a = G.actors[i];
      var mesh = V.actorMeshes[a.id];
      if (!a.alive) {
        if (mesh) { scene.remove(mesh); delete V.actorMeshes[a.id]; }
        continue;
      }
      if (!mesh) {
        var col = a.isPlayer ? 0x3f8fbf : [0x9a5a3f, 0x5f7a44, 0xa89042, 0x6a5f8a, 0x8a4a5a][a.team % 5];
        mesh = makeSoldier(col, a.isPlayer);
        var gun = makeGun(a.weapons && a.weapons[a.slot] ? a.weapons[a.slot].w : null);
        gun.position.set(0, -0.72, 0.16);
        gun.rotation.x = -0.15;
        gun.name = 'gun';
        if (mesh.userData.armR) mesh.userData.armR.add(gun); else mesh.add(gun);
        scene.add(mesh);
        V.actorMeshes[a.id] = mesh;
      }
      var ground = V.groundHeight(a.x, a.y);
      mesh.position.set(a.x, ground + (a.yOff || 0), a.y);
      mesh.rotation.y = -a.ang + Math.PI / 2;
      var ud = mesh.userData;
      var run = a.moving || (a.state === 'run') ? 1 : 0;
      var phase = (G.matchT * 9 + a.id) % (Math.PI * 2);
      ud.legL.rotation.x = run * Math.sin(phase) * 0.7;
      ud.legR.rotation.x = run * -Math.sin(phase) * 0.7;
      ud.armR.rotation.x = run * Math.sin(phase + Math.PI) * 0.5;
      if (a.muzzle > 0) {
        var gm = mesh.getObjectByName('gun');
        if (gm) gm.position.z = 0.1 + a.muzzle * 0.12;
      }
      seen[a.id] = true;
    }

    // --- bullets ----------------------------------------------------------
    var need = G.bullets.length;
    while (V.bullets.length < need) {
      var bm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.9),
        new THREE.MeshBasicMaterial({ color: 0xffe0a0 }));
      V.bullets.push(bm); scene.add(bm);
    }
    for (var b = 0; b < V.bullets.length; b++) {
      var mesh2 = V.bullets[b];
      var bullet = G.bullets[b];
      if (!bullet) { mesh2.visible = false; continue; }
      mesh2.visible = true;
      mesh2.position.set(bullet.x, V.groundHeight(bullet.x, bullet.y) + 1.15, bullet.y);
      mesh2.rotation.y = -bullet.ang;
    }

    // --- loot -------------------------------------------------------------
    for (var l = 0; l < G.loot.length; l++) {
      var o = G.loot[l];
      var lm = V.lootMeshes[l];
      if (!lm) {
        var card = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 1.05),
          new THREE.MeshBasicMaterial({ color: o.color || 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }));
        var path = o.kind === 'gun' && o.w ? o.w.icon :
                   o.kind === 'heal' ? 'vendor/suroi/loot/' + o.heal.id + '.png' :
                   o.kind === 'armor' ? 'vendor/suroi/loot/' + armorIcon(o.slot, o.level) : null;
        if (path) card.material.map = tex(path);
        card.material.needsUpdate = true;
        var beam = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.6, 6),
          new THREE.MeshBasicMaterial({ color: o.color || 0xffffff, transparent: true, opacity: 0.22, depthWrite: false }));
        beam.position.y = 1.3;
        var lootGrp = new THREE.Group();
        lootGrp.add(card); lootGrp.add(beam);
        card.position.y = 0.9;
        scene.add(lootGrp);
        V.lootMeshes[l] = lootGrp;
        lm = lootGrp;
      }
      lm.visible = true;
      lm.position.set(o.x, V.groundHeight(o.x, o.y) + 0.2, o.y);
      lm.rotation.y = G.matchT * 1.8 + l;
    }
    for (var lx = G.loot.length; lx < V.lootMeshes.length; lx++) {
      if (V.lootMeshes[lx]) V.lootMeshes[lx].visible = false;
    }

    // --- factory ----------------------------------------------------------
    if (G.sim) {
      var cell = G.sim.cell;
      var alive = new Set();
      G.sim.blocks.forEach(function (bl, key) {
        alive.add(key);
        var mesh3 = V.blockMeshes.get(key);
        if (!mesh3) {
          mesh3 = makeBlock(bl.kind, cell);
          mesh3.position.set((bl.gx + 0.5) * cell, V.groundHeight((bl.gx + 0.5) * cell, (bl.gy + 0.5) * cell), (bl.gy + 0.5) * cell);
          scene.add(mesh3);
          V.blockMeshes.set(key, mesh3);
        }
        mesh3.rotation.y = -(bl.dir || 0) * Math.PI / 2;
      });
      V.blockMeshes.forEach(function (mesh4, key) {
        if (!alive.has(key)) { scene.remove(mesh4); V.blockMeshes.delete(key); }
      });

      // flowing items: one merged list of belt cargo so a line visibly carries ore
      var want = [];
      G.sim.blocks.forEach(function (bl) {
        if (bl.kind === 'conveyor' && bl.items) {
          for (var q = 0; q < bl.items.length; q++) {
            want.push({ x: (bl.gx + 0.5) * cell, z: (bl.gy + 0.5) * cell, type: bl.items[q].type });
          }
        }
        if (bl.kind === 'drill' && bl.buffer) {
          for (var q2 = 0; q2 < bl.buffer.length; q2++) want.push({ x: (bl.gx + 0.5) * cell, z: (bl.gy + 0.5) * cell, type: bl.buffer[q2] });
        }
      });
      while (V.itemMeshes.length < want.length) {
        var im = makeItem(want[V.itemMeshes.length].type, cell);
        scene.add(im); V.itemMeshes.push(im);
      }
      for (var imI = 0; imI < V.itemMeshes.length; imI++) {
        var it = want[imI];
        var imMesh = V.itemMeshes[imI];
        if (!it) { imMesh.visible = false; continue; }
        imMesh.visible = true;
        imMesh.position.set(it.x, V.groundHeight(it.x, it.z) + 1.05, it.z);
        imMesh.rotation.y = G.matchT * 3;
      }
    }

    // --- storm ------------------------------------------------------------
    var st = G.storm;
    var stormH = 260;
    V.stormMesh.scale.set(Math.max(1, st.r), stormH / 2, Math.max(1, st.r));
    V.stormMesh.position.set(st.cx, 20, st.cy);
    V.stormRing.scale.set(st.r, st.r, 1);
    V.stormRing.position.set(st.cx, V.groundHeight(st.cx, st.cy) + 0.6, st.cy);
    V.water.position.y = -0.35 + Math.sin(G.matchT * 0.6) * 0.03;

    // roofs fade when you are inside the footprint
    for (var h = 0; h < V.houses.length; h++) {
      var house = V.houses[h];
      var ud2 = house.userData;
      var inside = G.player && Math.abs(G.player.x - ud2.cx) < ud2.w / 2 && Math.abs(G.player.y - ud2.cy) < ud2.d / 2;
      if (ud2.roof) {
        ud2.roof.material.opacity = inside ? 0.22 : 1;
        ud2.roof.material.transparent = inside;
      }
    }
  };

  /* Third-person camera: orbits behind the player, looks slightly down the aim line. */
  /* ---------------------------------------------------------------- near grass
   *
   * 4.2k blades spread over 9 km2 is one blade per 2,000 m2 — invisible at arm's length. This is
   * a second instanced field that lives only in a 46-unit disc around the player and is rebuilt
   * (snapped to a 4-unit grid so tufts do not swim) whenever the player walks 6 units.
   */
  var NEAR_R = 46, NEAR_N = 2000;
  S.buildNearGrass = function (V) {
    var tuft = bakeGeo([
      { geo: new THREE.ConeGeometry(0.05, 0.52, 4), color: 0x3c7a30, pos: [0, 0.26, 0], rot: [0.1, 0, 0.12] },
      { geo: new THREE.ConeGeometry(0.042, 0.42, 4), color: 0x4f9440, pos: [0.12, 0.21, 0.06], rot: [-0.06, 0.8, -0.2] },
      { geo: new THREE.ConeGeometry(0.046, 0.46, 4), color: 0x356b2b, pos: [-0.11, 0.23, -0.05], rot: [0.14, 1.5, 0.2] },
      { geo: new THREE.ConeGeometry(0.036, 0.34, 4), color: 0x63a94c, pos: [0.03, 0.17, -0.13], rot: [-0.18, 2.4, 0.1] }
    ]);
    var mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    var inst = new THREE.InstancedMesh(tuft, mat, NEAR_N);
    inst.castShadow = false;
    inst.receiveShadow = true;
    inst.frustumCulled = false;
    inst.name = 'neargrass';
    inst.count = 0;
    V.nearGrass = inst;
    V.nearAt = { x: 1e9, z: 1e9 };
    V.scene.add(inst);
    return inst;
  };

  S.updateNearGrass = function (V, G) {
    var inst = V.nearGrass;
    if (!inst || !G.world) return;
    var p = G.player, ax = p.x, az = p.y;
    if (V.nearAt && Math.abs(ax - V.nearAt.x) < 6 && Math.abs(az - V.nearAt.z) < 6) return;
    V.nearAt.x = ax; V.nearAt.z = az;
    var w = G.world;
    var seed = (((ax / 4) | 0) * 73856093 ^ ((az / 4) | 0) * 19349663) | 0;
    function rnd2() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    var mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3();
    var n = 0;
    for (var i3 = 0; i3 < NEAR_N; i3++) {
      var ang = rnd2() * Math.PI * 2, rad2 = Math.sqrt(rnd2()) * NEAR_R;
      var wx = ax + Math.cos(ang) * rad2, wz = az + Math.sin(ang) * rad2;
      var gx = Math.max(0, Math.min(w.grid - 1, Math.floor(wx / w.cell)));
      var gy = Math.max(0, Math.min(w.grid - 1, Math.floor(wz / w.cell)));
      var bi = w.tiles[gy * w.grid + gx];
      if (bi !== 0 && bi !== 1 && bi !== 2) continue;              // no blades on rock or lake
      var h = groundHeight(w, wx, wz);
      if (h < -0.2) continue;
      var sv = 0.65 + rnd2() * 1.05;
      e.set((rnd2() - 0.5) * 0.18, rnd2() * Math.PI * 2, (rnd2() - 0.5) * 0.18);
      q.setFromEuler(e);
      v.set(wx, h - 0.03, wz);
      sc.set(sv, 0.7 + rnd2() * 0.9, sv);
      mtx.compose(v, q, sc);
      inst.setMatrixAt(n++, mtx);
    }
    inst.count = n;
    inst.instanceMatrix.needsUpdate = true;
  };

  S.placeCamera = function (V, G, dt) {
    if (V.water && V.water.material && V.water.material.bumpMap) {
      var bm = V.water.material.bumpMap;
      bm.offset.x = (bm.offset.x + dt * 0.012) % 1;
      bm.offset.y = (bm.offset.y + dt * 0.007) % 1;
      var tm2 = V.water.material.map;
      if (tm2) {
        tm2.offset.x = (tm2.offset.x + dt * 0.004) % 1;
        tm2.offset.y = (tm2.offset.y - dt * 0.0025) % 1;
      }
    }
    if (V.stormMesh && V.stormMesh.material && V.stormMesh.material.uniforms) {
      V.stormMesh.material.uniforms.uTime.value += dt;
    }
    var p = G.player;
    var cam = V.camera;
    var dist = G.buildOpen ? 11 : 8.2;
    var height = G.buildOpen ? 8.5 : 3.6;
    var yaw = G.view.yaw, pitch = G.view.pitch;
    var cx = p.x - Math.sin(yaw) * dist * Math.cos(pitch);
    var cz = p.y - Math.cos(yaw) * dist * Math.cos(pitch);
    var cy = V.groundHeight(p.x, p.y) + height + Math.sin(pitch) * dist;
    var groundAtCam = V.groundHeight(cx, cz);
    if (cy < groundAtCam + 1.2) cy = groundAtCam + 1.2;
    cam.position.set(cx, cy, cz);
    var lookY = V.groundHeight(p.x, p.y) + 1.35;
    cam.lookAt(p.x + Math.sin(yaw) * 2.2, lookY, p.y + Math.cos(yaw) * 2.2);
    V.sun.position.set(p.x - 260, 420, p.y + 180);
    V.sun.target.position.set(p.x, 0, p.y);
  };

  S.resize = function (V, w, h, dpr) {
    V.renderer.setSize(w, h, false);
    if (dpr && Math.abs(dpr - V.renderer.getPixelRatio()) > 1e-3) {
      V.renderer.setPixelRatio(dpr);
      V.renderer.setSize(w, h, false);
      V.dpr = dpr;
    }
    V.camera.aspect = w / h;
    V.camera.updateProjectionMatrix();
    if (V.post) V.post.resize(w, h, V.renderer.getPixelRatio());
  };

  /* Adaptive resolution: the device drives this, not a fixed target. Every 90 frames the mean
   * frame time decides whether the buffer grows or shrinks. */
  S.adapt = function (V, dt) {
    if (!V.post || !V.post.enabled) return;
    V._ft = (V._ft || 0) + dt;
    V._fn = (V._fn || 0) + 1;
    if (V._fn < 90) return;
    var avg = V._ft / V._fn;
    V._ft = 0; V._fn = 0;
    var cap = budgetDpr(g.innerWidth || 390, g.innerHeight || 844);
    var cur = V.renderer.getPixelRatio();
    var next = cur;
    if (avg > 0.024 && cur > 0.72) next = Math.max(0.7, cur - 0.1);
    else if (avg < 0.017 && cur < cap) next = Math.min(cap, cur + 0.05);
    if (Math.abs(next - cur) > 1e-3) S.resize(V, g.innerWidth, g.innerHeight, next);
  };

  S.render = function (V) {
    var r = V.renderer, P = V.post;
    /* The post chain ends by drawing one fullscreen quad, and with autoReset the renderer's own
     * counters then describe that quad instead of the scene — the browser test reads them as
     * evidence the WebGL scene drew something, so they have to cover the whole frame. */
    r.info.autoReset = false;
    r.info.reset();
    if (!P || !P.enabled) { r.setRenderTarget(null); r.render(V.scene, V.camera); return; }

    r.setRenderTarget(P.sceneRT);
    r.clear();
    r.render(V.scene, V.camera);

    P.quad.material = P.brightMat;
    P.brightMat.uniforms.tDiffuse.value = P.sceneRT.texture;
    r.setRenderTarget(P.bloomA);
    r.render(P.quadScene, P.quadCam);

    P.quad.material = P.blurMat;
    var bw = 1 / Math.max(2, P.bloomA.width), bh = 1 / Math.max(2, P.bloomA.height);
    P.blurMat.uniforms.tDiffuse.value = P.bloomA.texture;
    P.blurMat.uniforms.dir.value.set(bw, 0);
    r.setRenderTarget(P.bloomB);
    r.render(P.quadScene, P.quadCam);

    P.blurMat.uniforms.tDiffuse.value = P.bloomB.texture;
    P.blurMat.uniforms.dir.value.set(0, bh);
    r.setRenderTarget(P.bloomA);
    r.render(P.quadScene, P.quadCam);

    P.blurMat.uniforms.tDiffuse.value = P.bloomA.texture;
    P.blurMat.uniforms.dir.value.set(bw * 2.4, 0);
    r.setRenderTarget(P.bloomC);
    r.render(P.quadScene, P.quadCam);

    P.blurMat.uniforms.tDiffuse.value = P.bloomC.texture;
    P.blurMat.uniforms.dir.value.set(0, bh * 2.4);
    r.setRenderTarget(P.bloomD);
    r.render(P.quadScene, P.quadCam);

    P.quad.material = P.compMat;
    P.compMat.uniforms.tScene.value = P.sceneRT.texture;
    P.compMat.uniforms.tBloom.value = P.bloomD.texture;
    P.compMat.uniforms.time.value = (V.clockT = (V.clockT || 0) + 0.016);
    r.setRenderTarget(null);
    r.render(P.quadScene, P.quadCam);
  };

  /* QA handle: `window.__game.post.off()` renders raw, and post.stats() reports the chain. */
  S.post = function (V) { return V && V.post ? V.post : null; };

  S.groundHeight = groundHeight;

  g.SF_SCENE = S;

// Registers this module on the shared hook the collection's smoke test looks for; main.js
// replaces the hook with the live game object once everything is loaded.
window.__game = window.__game || {};

})(window);
