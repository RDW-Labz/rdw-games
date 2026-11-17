window.__game = window.__game || {};
/**
 * Galevault — renderer.
 *
 * three.js (r0.156.1, UMD build, vendored) draws one gorge, one river, fourteen
 * gates, a glider and three pirates. The simulation in world.js never sees a
 * three.js object; this file owns every mesh and every material, so the scene can
 * be reshaped without touching the physics or the tests.
 *
 * All surface art is Luanti's seamless node textures (GPL-2.0+ / CC-BY-SA, see
 * docs/LICENSING.md): stone for cliff faces, grass for the flat tops, gravel for
 * scree, sand for the riverbank, water for the river. They are 16 px tiles
 * repeated across the ground, which is the one kind of donor art that survives a
 * mip-mapped downscale — the rock still reads as rock at arm's length on a phone.
 */
(function (g) {
  'use strict';

  var SL = g.GV3D = g.GV3D || {};
  var THREE = g.THREE;

  var MAT = {
    stone: 'vendor/luanti/textures/stone.png',
    grass: 'vendor/luanti/textures/grass.png',
    gravel: 'vendor/luanti/textures/gravel.png',
    sand: 'vendor/luanti/textures/sand.png',
    water: 'vendor/luanti/textures/water.png'
  };

  var S = null;                 // scene state, one per created renderer
  var texOk = null;             // null = untested, true/false after the boot probe
  var probed = false;           // the probe runs once per page, not once per build
  var loader = null;

  function hasAsset(path) {
    var V = g.AOMG_VENDOR;
    if (!V || !V.assets) return false;
    for (var i = 0; i < V.assets.length; i++) if (V.assets[i] === path) return true;
    return false;
  }

  /* One probe, once. WebGL throws on an image the page is not allowed to read
   * (bare file:// without the flag), and an unguarded TextureLoader turns that
   * into a black scene. When it fails every material below falls back to a flat
   * colour and the game still plays. */
  function probeTextures(done) {
    /* `probed`, not `texOk`: create() builds a flat-colour scene before the probe
     * answers, and testing texOk here made the probe see its own placeholder and
     * give up — every material stayed untextured while the code looked correct. */
    if (probed) { done(texOk === true); return; }
    probed = true;
    if (!THREE || !hasAsset(MAT.stone)) { texOk = false; done(false); return; }
    loader = loader || new THREE.TextureLoader();
    loader.load('../../' + MAT.stone, function (t) {
      texOk = true;
      if (t && t.dispose) t.dispose();
      done(true);
    }, undefined, function () {
      texOk = false;
      done(false);
    });
  }

  var TEX_CACHE = {};
  function tex(path, repeatX, repeatY) {
    if (texOk !== true) return null;
    var key = path + ':' + repeatX + 'x' + repeatY;
    if (TEX_CACHE[key]) return TEX_CACHE[key];
    var t = loader.load('../../' + path);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeatX, repeatY);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = S && S.renderer ? Math.min(8, S.renderer.capabilities.getMaxAnisotropy()) : 1;
    TEX_CACHE[key] = t;
    return t;
  }

  function mat(color, opts) {
    var o = opts || {};
    return new THREE.MeshLambertMaterial({
      color: color,
      map: o.map || null,
      vertexColors: !!o.vertexColors,
      transparent: !!o.transparent,
      opacity: o.opacity == null ? 1 : o.opacity,
      emissive: o.emissive || 0x000000,
      emissiveIntensity: o.emissiveIntensity == null ? 1 : o.emissiveIntensity,
      side: o.side || THREE.FrontSide,
      depthWrite: o.depthWrite == null ? true : o.depthWrite,
      fog: o.fog == null ? true : o.fog
    });
  }

  /* ------------------------------------------------------------------ sky */

  function buildSky(scene) {
    var geo = new THREE.SphereGeometry(2400, 24, 16);
    var pos = geo.attributes.position;
    var colors = new Float32Array(pos.count * 3);
    var top = new THREE.Color(0x18466f), mid = new THREE.Color(0x82b4dc), low = new THREE.Color(0xf2d2a4);
    var c = new THREE.Color();
    for (var i = 0; i < pos.count; i++) {
      var y = pos.getY(i) / 2400;                    // -1..1
      if (y > 0.22) c.copy(mid).lerp(top, Math.min(1, (y - 0.22) / 0.5));
      else c.copy(mid).lerp(low, Math.min(1, (0.22 - y) / 0.55));
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    /* unlit, deliberately: the gradient IS the art direction. Any lit material
     * multiplies it by the light rig, which turned the navy zenith flat grey. */
    /* toneMapped:false — ACES desaturates anything bright, and it pulled the whole
     * gradient toward the same flat grey the sky was supposed to avoid. */
    var dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false, toneMapped: false
    }));
    dome.name = 'sky';
    /* The dome has to travel with the camera. Centred on the world origin it was a
     * 2400-unit sphere in a 2600-unit world, so the chase camera flew outside it
     * near the rim and the sky vanished, leaving flat fog grey above the horizon. */
    var rig = new THREE.Group();
    rig.name = 'skyRig';
    rig.add(dome);

    var sun = new THREE.Mesh(new THREE.CircleGeometry(95, 26),
      new THREE.MeshBasicMaterial({ color: 0xfff3d0, fog: false, transparent: true, opacity: 0.95,
        depthWrite: false, toneMapped: false }));
    sun.position.set(-1180, 620, -1560);
    sun.lookAt(0, 0, 0);
    sun.name = 'sun';
    rig.add(sun);

    /* a halo around the sun so the horizon glows instead of stopping at a disc */
    var halo = new THREE.Mesh(new THREE.CircleGeometry(340, 28),
      new THREE.MeshBasicMaterial({ color: 0xffc887, fog: false, transparent: true, opacity: 0.2,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    halo.position.copy(sun.position).multiplyScalar(0.98);
    halo.lookAt(0, 0, 0);
    halo.name = 'sunHalo';
    rig.add(halo);
    scene.add(rig);
    return rig;
  }

  /* --------------------------------------------------------------- terrain */

  function terrainColors(heights, N, sx, waterY) {
    var colors = new Float32Array(heights.length * 3);
    var c = new THREE.Color();
    for (var j = 0; j <= N; j++) {
      for (var i = 0; i <= N; i++) {
        var k = j * (N + 1) + i;
        var h = heights[k];
        /* slope from the neighbours, in world units per metre */
        var hl = heights[j * (N + 1) + Math.max(0, i - 1)];
        var hr = heights[j * (N + 1) + Math.min(N, i + 1)];
        var hd = heights[Math.max(0, j - 1) * (N + 1) + i];
        var hu = heights[Math.min(N, j + 1) * (N + 1) + i];
        var slope = Math.min(1, (Math.abs(hr - hl) + Math.abs(hu - hd)) / (sx * 2.6));
        var above = h - waterY;
        if (above < 11) c.setHex(0xd3bd90);                      // riverbank sand
        else if (slope > 0.42) {
          /* strata: the bands are what makes a cliff read as rock rather than a
           * brown ramp. Two frequencies, height-locked, so they follow the wall. */
          var band = Math.sin(above * 0.42) * 0.5 + Math.sin(above * 1.13 + i * 0.7) * 0.5;
          c.setHex(above > 62 ? 0xd6d8d4 : 0xa87d52);
          c.offsetHSL(0, 0.05 * band, band * 0.075);
        }
        else if (above > 74) c.setHex(0xe4e8ea);                  // high plateau
        else if (slope > 0.20) c.setHex(0x8b9c69);                // mossy scree
        else c.setHex(0x7aa85a);                                  // grass
        /* a little per-vertex noise so the tint is not a contour map */
        var n = (g.GV.hash2(i, j, 11) - 0.5) * 0.09;
        colors[k * 3] = c.r + n; colors[k * 3 + 1] = c.g + n; colors[k * 3 + 2] = c.b + n;
      }
    }
    return colors;
  }

  function buildTerrain(scene, world) {
    var N = world.N, sx = world.sx, H = world.heights;

    var verts = N + 1;
    var pos = new Float32Array(verts * verts * 3);
    var uv = new Float32Array(verts * verts * 2);
    /* one tile per ~20 units, not 46: a 16 px tile stretched over 46 metres read as
     * smeared cardboard on the gorge walls */
    var repeat = world.size / 20;
    for (var j = 0; j < verts; j++) {
      for (var i = 0; i < verts; i++) {
        var k = j * verts + i;
        pos[k * 3] = i * sx;
        pos[k * 3 + 1] = H[k];
        pos[k * 3 + 2] = j * sx;
        uv[k * 2] = (i / N) * repeat;
        uv[k * 2 + 1] = (j / N) * repeat;
      }
    }
    var idx = [];
    for (var jj = 0; jj < N; jj++) {
      for (var ii = 0; ii < N; ii++) {
        var a = jj * verts + ii, b = a + 1, c2 = a + verts, d = c2 + 1;
        idx.push(a, c2, b, b, c2, d);
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(terrainColors(H, N, sx, world.waterY), 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    /* The donor stone tile averages mid-grey (127,127,127), so a straight multiply
     * halves every vertex colour and the gorge came out almost black. The colour
     * multiplier is the compensation, kept on the material so the palette above
     * still reads in normal sRGB terms. */
    var rockMat = mat(0xffffff, { map: tex(MAT.stone, 1, 1), vertexColors: true });
    rockMat.color.setScalar(2.3);
    var rock = new THREE.Mesh(geo, rockMat);
    rock.name = 'terrain';
    scene.add(rock);

    /* Grass cap: the same field, but only the quads that are flat enough to hold
     * soil. One extra mesh, so the tops read as green ground instead of tinted
     * stone, and it sits a whisker above the rock to avoid z-fighting. */
    var gpos = [], guv = [], gcol = [], gidx = [];
    var gc = new THREE.Color(0x6f8c52);
    for (var q = 0; q < N; q++) {
      for (var p = 0; p < N; p++) {
        var ka = q * verts + p, kb = ka + 1, kc = ka + verts, kd = kc + 1;
        var ha = H[ka], hb = H[kb], hc = H[kc], hd2 = H[kd];
        var dh = Math.max(Math.abs(ha - hb), Math.abs(ha - hc), Math.abs(hb - hd2), Math.abs(hc - hd2));
        if (dh > sx * 0.36) continue;                       // too steep for grass
        if (Math.min(ha, hb, hc, hd2) < world.waterY + 6) continue;
        var base = gpos.length / 3;
        var corners = [[p, q, ha], [p + 1, q, hb], [p, q + 1, hc], [p + 1, q + 1, hd2]];
        for (var ci = 0; ci < 4; ci++) {
          var cx = corners[ci][0], cz = corners[ci][1], cy = corners[ci][2];
          gpos.push(cx * sx, cy + 0.16, cz * sx);
          guv.push(cx * 0.35, cz * 0.35);
          var tint = 0.88 + g.GV.hash2(cx, cz, 5) * 0.26;
          gcol.push(gc.r * tint, gc.g * tint, gc.b * tint);
        }
        gidx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      }
    }
    var gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(gpos), 3));
    gg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(guv), 2));
    gg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(gcol), 3));
    gg.setIndex(gidx);
    gg.computeVertexNormals();
    var grass = new THREE.Mesh(gg, mat(0xffffff, { map: tex(MAT.grass, 1, 1), vertexColors: true }));
    grass.name = 'grass';
    scene.add(grass);

    /* river */
    var waterGeo = new THREE.PlaneGeometry(world.size, world.size);
    waterGeo.rotateX(-Math.PI / 2);
    /* Phong, not Lambert: the river needs a specular sheen that moves with the
     * camera or it reads as a flat blue sheet. The map scrolls in sync(). */
    var waterMat = new THREE.MeshPhongMaterial({
      color: 0x3fa3c4, map: tex(MAT.water, 60, 60), transparent: true, opacity: 0.9,
      emissive: 0x0d3d4b, emissiveIntensity: 0.5,
      specular: 0xe8fbff, shininess: 110, side: THREE.FrontSide
    });
    var water = new THREE.Mesh(waterGeo, waterMat);
    water.position.set(world.size / 2, world.waterY, world.size / 2);
    water.name = 'water';
    scene.add(water);

    /* A second, additive skin scrolling at a different rate. One plane with one
     * texture read as a sheet of blue plastic however it was lit; two layers moving
     * against each other produce travelling highlight bands, which is what the eye
     * reads as "water". Cheap: one more draw call, no shader work. */
    var sheenMat = new THREE.MeshBasicMaterial({
      color: 0x9fe8ff, map: tex(MAT.water, 26, 26), transparent: true, opacity: 0.22,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide, fog: true
    });
    var sheen = new THREE.Mesh(waterGeo, sheenMat);
    sheen.position.set(world.size / 2, world.waterY + 0.35, world.size / 2);
    sheen.name = 'waterSheen';
    scene.add(sheen);

    return { rock: rock, grass: grass, water: water, sheen: sheen };
  }

  /* ----------------------------------------------------------------- rocks */
  /* Scree and spires, instanced: one draw call per prototype part whatever the count. */
  function buildRocks(scene, world) {
    var curve = world.curve;
    var count = 150;
    var geo = new THREE.ConeGeometry(1, 1, 6, 1);
    /* the gravel tile is dark (80,73,65): multiplied straight it turned every spire
     * into a black spike against the sunlit rock */
    var m = mat(0x9a938a, { map: tex(MAT.gravel, 1, 1) });
    m.color.setScalar(2.1);
    var inst = new THREE.InstancedMesh(geo, m, count);
    inst.name = 'rocks';
    var mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    var v = new THREE.Vector3(), sc = new THREE.Vector3();
    var placed = 0;
    for (var i = 0; i < count; i++) {
      var c = curve[(i * 7) % curve.length];
      var ang = g.GV.hash2(i, 3, world.seed) * Math.PI * 2;
      var rad = 16 + g.GV.hash2(i, 9, world.seed) * 46;
      var x = c.x + Math.cos(ang) * rad, z = c.z + Math.sin(ang) * rad;
      var gh = g.GV.groundAt(world, x, z);
      if (gh < world.waterY + 2) continue;
      var h = 5 + g.GV.hash2(i, 13, world.seed) * 16;
      var r = 1.2 + g.GV.hash2(i, 17, world.seed) * 2.4;
      e.set(0, ang, 0); q.setFromEuler(e);
      v.set(x, gh + h / 2 - 0.4, z);
      sc.set(r, h, r);
      mtx.compose(v, q, sc);
      inst.setMatrixAt(placed, mtx);
      var tint = 0.8 + g.GV.hash2(i, 23, world.seed) * 0.4;
      inst.setColorAt(placed, new THREE.Color(tint, tint * 0.98, tint * 0.94));
      placed++;
    }
    inst.count = placed;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    scene.add(inst);
    return inst;
  }

  /* ----------------------------------------------------------------- gates */

  /* Scrub, crags and cloud: the cheap things that stop a heightfield reading as a
   * heightfield. One instanced mesh for the vegetation and a dozen sprites for the
   * clouds, so the frame cost stays flat. */
  function buildProps(scene, world) {
    var N = world.N, sx = world.sx, H = world.heights;
    var geo = new THREE.ConeGeometry(1.5, 5.2, 5);
    var mat2 = mat(0xffffff, { vertexColors: false });
    var spots = [];
    var step = 4;
    for (var j = 3; j < N - 3; j += step) {
      for (var i = 3; i < N - 3; i += step) {
        var k = j * (N + 1) + i;
        var h = H[k];
        var above = h - world.waterY;
        var hl = H[j * (N + 1) + i - 2], hr = H[j * (N + 1) + i + 2];
        var hd = H[(j - 2) * (N + 1) + i], hu = H[(j + 2) * (N + 1) + i];
        var slope = Math.min(1, (Math.abs(hr - hl) + Math.abs(hu - hd)) / (sx * 2.6));
        if (slope > 0.16 || above < 8 || above > 86) continue;
        var r = g.GV.hash2(i, j, 23);
        if (r > 0.42) continue;
        spots.push({ x: i * sx + (g.GV.hash2(i, j, 5) - 0.5) * sx, y: h - 0.6,
          z: j * sx + (g.GV.hash2(i, j, 9) - 0.5) * sx, s: 0.6 + r * 2.2, r: r });
      }
    }
    if (!spots.length) return null;
    var mesh = new THREE.InstancedMesh(geo, mat2, spots.length);
    mesh.name = 'scrub';
    var m4 = new THREE.Matrix4(), col = new THREE.Color();
    for (var s = 0; s < spots.length; s++) {
      var sp = spots[s];
      m4.makeTranslation(sp.x, sp.y + sp.s * 2.1, sp.z);
      m4.multiply(new THREE.Matrix4().makeScale(sp.s, sp.s * 1.25, sp.s));
      mesh.setMatrixAt(s, m4);
      col.setHex(sp.r < 0.16 ? 0x51713a : 0x6f9247);
      mesh.setColorAt(s, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);

    /* clouds: soft sprite billboards, drifting */
    var cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    var cx2 = cv.getContext('2d');
    var grd = cx2.createRadialGradient(64, 64, 4, 64, 64, 62);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.45, 'rgba(240,248,255,0.55)');
    grd.addColorStop(1, 'rgba(226,240,255,0)');
    cx2.fillStyle = grd;
    cx2.fillRect(0, 0, 128, 128);
    var cloudTex = new THREE.CanvasTexture(cv);
    cloudTex.colorSpace = THREE.SRGBColorSpace;
    var clouds = [];
    for (var c = 0; c < 16; c++) {
      var sm = new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.5,
        depthWrite: false, fog: false, toneMapped: false });
      var spr = new THREE.Sprite(sm);
      var ang = g.GV.hash2(c, 3, 41) * Math.PI * 2;
      var rad = 500 + g.GV.hash2(c, 7, 43) * 1500;
      spr.position.set(world.size * 0.5 + Math.cos(ang) * rad,
        240 + g.GV.hash2(c, 11, 47) * 190, world.size * 0.5 + Math.sin(ang) * rad);
      var sc = 260 + g.GV.hash2(c, 13, 53) * 420;
      spr.scale.set(sc, sc * 0.55, 1);
      spr.name = 'cloud' + c;
      scene.add(spr);
      clouds.push({ spr: spr, drift: 3 + g.GV.hash2(c, 17, 59) * 5 });
    }
    return { scrub: mesh, clouds: clouds };
  }

  function buildGates(scene, world) {
    var gs = [];
    /* a 0.62 tube on a 13-unit ring read as a thin white line — the gate needs mass */
    var ringGeo = new THREE.TorusGeometry(g.GV.GATE_R, 1.15, 8, 28);
    var haloGeo = new THREE.TorusGeometry(g.GV.GATE_R, 2.4, 6, 24);
    for (var i = 0; i < world.gates.length; i++) {
      var gd = world.gates[i];
      var group = new THREE.Group();
      var m = mat(0x0e2b33, { emissive: 0x27c8ac, emissiveIntensity: 1.3 });
      var ring = new THREE.Mesh(ringGeo, m);
      ring.name = 'gate' + i;
      group.add(ring);
      /* a wide, additive halo: the glow that says "fly here" without the ring itself
       * blowing out to white under tone mapping */
      var halo = new THREE.Mesh(haloGeo, new THREE.MeshBasicMaterial({
        color: 0x2ff0cc, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending,
        depthWrite: false, fog: false, toneMapped: false }));
      halo.name = 'gateHalo' + i;
      group.add(halo);
      /* four chevrons on the ring so the gate reads as a direction, not a hole */
      for (var c = 0; c < 4; c++) {
        var chev = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, 0.5),
          mat(0x0e2b33, { emissive: 0x9ff8e8, emissiveIntensity: 1.9 }));
        var a = c * Math.PI / 2 + Math.PI / 4;
        chev.position.set(Math.cos(a) * (g.GV.GATE_R - 1.6), Math.sin(a) * (g.GV.GATE_R - 1.6), 0);
        chev.rotation.z = a;
        group.add(chev);
      }
      /* a faint additive disc gives the gate a pane of light instead of an empty
       * hoop — at speed it is the pane, not the ring, that reads */
      var disc = new THREE.Mesh(new THREE.CircleGeometry(g.GV.GATE_R - 0.9, 22),
        new THREE.MeshBasicMaterial({ color: 0x66ffe0, transparent: true, opacity: 0.09,
          side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      disc.name = 'gatePane' + i;
      group.add(disc);
      group.position.set(gd.x, gd.y, gd.z);
      group.rotation.y = gd.yaw;
      group.name = 'gateGroup' + i;
      scene.add(group);
      gs.push({ group: group, ring: ring, disc: disc, mat: m, index: i });
    }
    return gs;
  }

  /* ---------------------------------------------------------------- glider */

  /* The glider is built from a handful of primitives, but the shapes matter: a
   * box with flat plank wings reads as "low-poly plane" at any distance. A
   * tapered fuselage, swept delta wings and a bright leading edge give a
   * silhouette that still says "glider" when it is 40 units away and leaning. */
  function buildGlider(scene, craft) {
    var root = new THREE.Group();
    root.name = 'craft';

    var hullMat = mat(0xe8f1f4, { map: tex(MAT.stone, 1, 2) });
    var wingMat = mat(0x2fd8bd, { emissive: 0x0d6f63, emissiveIntensity: 0.3, side: THREE.DoubleSide });
    var accentMat = mat(0xffb64d, { emissive: 0xff8a24, emissiveIntensity: 0.55, side: THREE.DoubleSide });

    /* fuselage: a slim spindle tapering into a long nose */
    var body = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.3, 6.2, 9), hullMat);
    body.rotation.x = Math.PI / 2;
    body.position.set(0, 0, 0.4);
    root.add(body);

    var nose = new THREE.Mesh(new THREE.ConeGeometry(0.62, 2.8, 9), hullMat);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 0, 4.9);
    root.add(nose);

    /* swept delta wings, built as real triangles so the leading edge is a line
     * and not a rectangle seen edge-on */
    function wing(sign) {
      var g2 = new THREE.BufferGeometry();
      var a = [0, 0.06, 1.9], b = [sign * 5.6, 0.55, -1.05], c = [0, 0.06, -2.1],
          d = [sign * 5.0, 0.55, -2.15];
      var verts = [];
      if (sign > 0) verts = [].concat(a, b, c, b, d, c);
      else verts = [].concat(a, c, b, b, c, d);
      g2.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
      g2.computeVertexNormals();
      return new THREE.Mesh(g2, wingMat);
    }
    root.add(wing(1));
    root.add(wing(-1));

    /* amber leading-edge strips: the bright line that carries the silhouette */
    function edge(sign) {
      var strip = new THREE.Mesh(new THREE.BoxGeometry(5.72, 0.1, 0.17), accentMat);
      strip.position.set(sign * 2.8, 0.3, 0.42);
      strip.rotation.y = sign * 0.56;
      strip.rotation.z = sign * -0.09;
      return strip;
    }
    root.add(edge(1));
    root.add(edge(-1));

    /* winglets */
    function tip(sign) {
      var t = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.95, 1.15), wingMat);
      t.position.set(sign * 5.35, 0.75, -1.55);
      t.rotation.z = sign * -0.3;
      t.rotation.x = 0.16;
      return t;
    }
    root.add(tip(1));
    root.add(tip(-1));

    /* V-tail */
    var finL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.15, 1.3), wingMat);
    finL.position.set(-0.55, 0.62, -2.75);
    finL.rotation.z = 0.62;
    root.add(finL);
    var finR = finL.clone();
    finR.position.x = 0.55; finR.rotation.z = -0.62;
    root.add(finR);

    /* darker belly so the spindle reads as a solid object against the sky */
    var belly = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.26, 5.6, 8), mat(0x9fb0ba));
    belly.rotation.x = Math.PI / 2;
    belly.position.set(0, -0.42, 0.2);
    belly.scale.set(0.9, 1, 0.6);
    root.add(belly);

    /* canopy */
    var can = new THREE.Mesh(new THREE.SphereGeometry(0.62, 12, 9),
      mat(0x9fe8ff, { emissive: 0x2f8ea6, emissiveIntensity: 0.7, transparent: true, opacity: 0.92 }));
    can.scale.set(0.9, 0.72, 2.1);
    can.position.set(0, 0.5, 2.35);
    root.add(can);

    /* engine glow: two discs, additive, scaled by throttle in sync() */
    var glowMat = mat(0x7bf0d0, { emissive: 0x7bf0d0, emissiveIntensity: 2.4, transparent: true, opacity: 0.9, fog: false });
    var gl = new THREE.Mesh(new THREE.CircleGeometry(0.62, 12), glowMat);
    gl.position.set(-0.62, 0.12, -2.65); gl.rotation.y = Math.PI;
    root.add(gl);
    var gr = gl.clone(); gr.position.x = 0.62;
    root.add(gr);

    root.userData.glow = [gl, gr];
    root.userData.wingMat = wingMat;
    scene.add(root);

    var shadow = new THREE.Mesh(new THREE.CircleGeometry(2.6, 14),
      new THREE.MeshBasicMaterial({        color: 0x0b1016, transparent: true, opacity: 0.34, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.name = 'craftShadow';
    scene.add(shadow);

    return root;
  }

  function buildPirates(scene, run) {
    var out = [];
    for (var i = 0; i < run.pirates.length; i++) {
      var grp = new THREE.Group();
      grp.name = 'pirate' + i;
      var body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.2, 6.2), mat(0x3a2b30, { map: tex(MAT.stone, 1, 2) }));
      grp.add(body);
      var wing = new THREE.Mesh(new THREE.BoxGeometry(8.2, 0.2, 2.0), mat(0x6b2f36, { emissive: 0x521018, emissiveIntensity: 0.6 }));
      grp.add(wing);
      var fin = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.8, 1.5), mat(0x6b2f36));
      fin.position.set(0, 1.0, -2.4);
      grp.add(fin);
      var jet = new THREE.Mesh(new THREE.CircleGeometry(0.55, 10),
        mat(0xff7a4a, { emissive: 0xff5a20, emissiveIntensity: 2.6, transparent: true, opacity: 0.92, fog: false }));
      jet.position.set(0, 0, -3.1); jet.rotation.y = Math.PI;
      grp.add(jet);
      scene.add(grp);
      out.push(grp);
    }
    return out;
  }

  function buildBolts(scene) {
    var geo = new THREE.SphereGeometry(0.62, 8, 6);
    var m = mat(0xffb066, { emissive: 0xff7a2a, emissiveIntensity: 2.6, fog: false });
    var inst = new THREE.InstancedMesh(geo, m, 48);
    inst.name = 'bolts';
    inst.frustumCulled = false;
    inst.count = 0;
    scene.add(inst);
    return inst;
  }

  function buildTrail(scene) {
    var geo = new THREE.BufferGeometry();
    var arr = new Float32Array(26 * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    var line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0x8efce4, transparent: true, opacity: 0.55
    }));
    line.name = 'trail';
    line.frustumCulled = false;
    scene.add(line);
    return line;
  }

  /* ------------------------------------------------------------------ boot */

  SL.create = function (canvas, world, run) {
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(2, g.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    /* filmic roll-off: without it the sunlit rock clips to flat white-brown and the
     * whole gorge reads as one muddy tone, which is exactly how it looked before */
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;

    var scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x9db8cc, 0.00088);

    var camera = new THREE.PerspectiveCamera(68, 1, 0.5, 3400);
    camera.position.set(world.start.x, world.start.y + 8, world.start.z - 26);

    S = {
      renderer: renderer, scene: scene, camera: camera, world: world,
      sky: null, terrain: null, rocks: null, gates: null, craft: null,
      pirates: null, bolts: null, trail: null, shadow: null, water: null, props: null,
      camYaw: run.yaw, camPitch: 0, fov: 64, t: 0
    };

    /* build immediately with flat colours, then rebuild once the texture probe
     * answers — the first frame must never wait on a disk read */
    buildScene(world, run);

    probeTextures(function (ok) {
      if (!ok) return;
      TEX_CACHE = {};
      clearScene();
      buildScene(world, run);
    });
    return S;
  };

  function clearScene() {
    var keep = [S.camera];
    for (var i = S.scene.children.length - 1; i >= 0; i--) {
      var ch = S.scene.children[i];
      if (keep.indexOf(ch) >= 0) continue;
      S.scene.remove(ch);
      if (ch.geometry && ch.geometry.dispose) ch.geometry.dispose();
    }
  }

  function buildScene(world, run) {
    /* lights belong to the build, not to create(): clearScene() drops every child
     * but the camera, so lights made outside this function vanished on the textured
     * rebuild and the whole gorge rendered black. */
    var hemi = new THREE.HemisphereLight(0xc6ddf2, 0x6b5a42, 1.7);
    hemi.name = 'hemi';
    S.scene.add(hemi);
    /* the sun sits low so the gorge walls carry a bright face and a shadowed face;
     * a high sun flattened every cliff into the same brown */
    var sunLight = new THREE.DirectionalLight(0xffeccb, 2.8);
    sunLight.name = 'sunLight';
    sunLight.position.set(-1180, 620, -1560);
    S.scene.add(sunLight);
    var fill = new THREE.AmbientLight(0x8298ac, 0.5);
    fill.name = 'ambient';
    S.scene.add(fill);

    S.sky = buildSky(S.scene);
    S.terrain = buildTerrain(S.scene, world);
    S.props = buildProps(S.scene, world);
    S.water = S.terrain.water;
    S.sheen = S.terrain.sheen;
    S.rocks = buildRocks(S.scene, world);
    S.gates = buildGates(S.scene, world);
    S.craft = buildGlider(S.scene, run.craft);
    S.pirates = buildPirates(S.scene, run);
    S.bolts = buildBolts(S.scene);
    S.trail = buildTrail(S.scene);
    S.shadow = S.scene.getObjectByName('craftShadow');
  }

  SL.resize = function (view, w, h) {
    if (!S) return;
    S.renderer.setSize(w, h, false);
    S.camera.aspect = w / Math.max(1, h);
    S.camera.updateProjectionMatrix();
  };

  /* ------------------------------------------------------------- per frame */

  var _v = null, _q = null, _mtx = null, _col = null;
  function ensureTmp() {
    if (_v) return;
    _v = new THREE.Vector3(); _q = new THREE.Quaternion();
    _mtx = new THREE.Matrix4(); _col = new THREE.Color();
  }

  SL.sync = function (run, dt) {
    if (!S || !run) return;
    ensureTmp();
    S.t += dt;

    /* ---- glider */
    var craft = S.craft;
    craft.position.set(run.x, run.y, run.z);
    craft.rotation.set(run.pitch, run.yaw, run.roll, 'YXZ');
    var glowOn = run.phase === 'flying' ? 1 : 0;
    var pulse = 0.85 + Math.sin(S.t * 24) * 0.15;
    for (var i = 0; i < craft.userData.glow.length; i++) {
      var gl = craft.userData.glow[i];
      var sc = (run.boosting ? 1.9 : 1.05) * pulse;
      gl.scale.set(sc, sc, 1);
      gl.visible = glowOn > 0;
    }

    /* ---- shadow puck on the ground below, so altitude is legible */
    if (S.shadow) {
      var gy = g.GV.groundAt(S.world, run.x, run.z);
      /* sit the blob above the water sheen, or the additive skin washes it out */
      S.shadow.position.set(run.x, Math.max(gy, S.world.waterY) + 0.55, run.z);
      var alt = Math.max(0, run.y - gy);
      /* a shadow spreads and fades as the craft climbs: shrinking it made it
       * invisible at altitude, which is where the craft spends most of a run */
      var s2 = g.GV.clamp(2.2 + alt * 0.028, 2.2, 6.5);
      S.shadow.scale.set(s2, s2, 1);
      S.shadow.material.opacity = g.GV.clamp(0.30 - alt * 0.0028, 0.07, 0.30);
    }

    /* clouds drift on their own slow wind */
    if (S.props && S.props.clouds) {
      for (var ci = 0; ci < S.props.clouds.length; ci++) {
        var cl = S.props.clouds[ci];
        cl.spr.position.x += cl.drift * dt;
        var span = S.world.size + 1800;
        if (cl.spr.position.x > S.world.size + 900) cl.spr.position.x -= span;
      }
    }

    /* sky follows the camera in plan view, so the dome always encloses it */
    if (S.sky && S.camera) {
      S.sky.position.set(S.camera.position.x, 0, S.camera.position.z);
    }

    /* ---- river: scroll the donor water tile so the surface is alive */
    if (S.water && S.water.material && S.water.material.map) {
      S.water.material.map.offset.set(S.t * 0.006, -S.t * 0.021);
    }
    if (S.sheen && S.sheen.material && S.sheen.material.map) {
      S.sheen.material.map.offset.set(-S.t * 0.014, S.t * 0.033);
    }

    /* ---- gates: the next one pulses, passed ones dim */
    for (var gi = 0; gi < S.gates.length; gi++) {
      var gg = S.gates[gi];
      var isNext = gi === run.nextGate;
      var done = run.gatesPassed[gi];
      gg.mat.emissiveIntensity = isNext ? 1.55 + Math.sin(S.t * 6) * 0.45 : (done ? 0.16 : 0.7);
      if (gg.disc) {
        gg.disc.material.opacity = isNext ? 0.10 + Math.sin(S.t * 4.2) * 0.05 : (done ? 0.0 : 0.03);
        gg.disc.visible = !done;
      }
      gg.group.rotation.z = isNext ? Math.sin(S.t * 1.6) * 0.06 : 0;
      gg.group.visible = !done || isNext;
      gg.group.scale.setScalar(isNext ? 1.06 : 1);
    }

    /* ---- pirates */
    for (var p = 0; p < run.pirates.length; p++) {
      var pr = run.pirates[p], mesh = S.pirates[p];
      if (!mesh) continue;
      mesh.visible = pr.alive;
      if (!pr.alive) continue;
      mesh.position.set(pr.x, pr.y, pr.z);
      mesh.rotation.set(0, pr.yaw, 0);
    }

    /* ---- bolts */
    if (S.bolts) {
      var n = Math.min(run.bolts.length, 48);
      for (var b = 0; b < n; b++) {
        var bo = run.bolts[b];
        _v.set(bo.x, bo.y, bo.z);
        _q.identity();
        _mtx.compose(_v, _q, new THREE.Vector3(1, 1, 1));
        S.bolts.setMatrixAt(b, _mtx);
      }
      S.bolts.count = n;
      S.bolts.instanceMatrix.needsUpdate = true;
    }

    /* ---- engine trail */
    if (S.trail) {
      var arr = S.trail.geometry.attributes.position.array;
      var tp = run.trail;
      for (var k = 0; k < 26; k++) {
        var src = tp[Math.max(0, tp.length - 1 - k)];
        arr[k * 3] = src ? src.x : run.x;
        arr[k * 3 + 1] = src ? src.y : run.y;
        arr[k * 3 + 2] = src ? src.z : run.z;
      }
      S.trail.geometry.attributes.position.needsUpdate = true;
      S.trail.visible = run.phase === 'flying' && tp.length > 2;
    }

    /* ---- chase camera: trails the craft, kicks FOV on boost, rolls with the bank */
    var cam = S.camera;
    var fwdX = Math.sin(run.yaw), fwdZ = Math.cos(run.yaw);
    var back = 16 + run.speed * 0.028;
    var wantX = run.x - fwdX * back;
    var wantZ = run.z - fwdZ * back;
    var wantY = run.y + 5.6 - Math.sin(run.pitch) * 5;
    var gy2 = g.GV.groundAt(S.world, wantX, wantZ);
    wantY = Math.max(wantY, Math.max(gy2, S.world.waterY) + 4.5);
    var smooth = Math.min(1, dt * 12);
    cam.position.x += (wantX - cam.position.x) * smooth;
    cam.position.y += (wantY - cam.position.y) * smooth;
    cam.position.z += (wantZ - cam.position.z) * smooth;
    var lookX = run.x + fwdX * 34, lookZ = run.z + fwdZ * 34;
    cam.up.set(Math.sin(run.roll * 0.55), 1, 0);
    cam.lookAt(lookX, run.y + 2.4 + Math.sin(run.pitch) * 12, lookZ);

    var wantFov = 68 + (run.boosting ? 8 : 0) + Math.min(9, run.speed * 0.04);
    S.fov += (wantFov - S.fov) * Math.min(1, dt * 3);
    if (Math.abs(cam.fov - S.fov) > 0.05) {
      cam.fov = S.fov;
      cam.updateProjectionMatrix();
    }
  };

  SL.render = function () {
    if (!S) return;
    S.renderer.render(S.scene, S.camera);
  };

  SL.info = function () {
    if (!S) return { calls: 0, triangles: 0 };
    return { calls: S.renderer.info.render.calls, triangles: S.renderer.info.render.triangles };
  };

  /* QA: what is actually under the camera? Labels come from mesh.name. */
  SL.pick = function (cols, rows) {
    if (!S) return null;
    var ray = new THREE.Raycaster();
    ray.camera = S.camera;
    var seen = {};
    var ndc = new THREE.Vector2();
    for (var j = 0; j < (rows || 4); j++) {
      for (var i = 0; i < (cols || 4); i++) {
        ndc.set((i + 0.5) / (cols || 4) * 2 - 1, -((j + 0.5) / (rows || 4) * 2 - 1));
        ray.setFromCamera(ndc, S.camera);
        var hits = ray.intersectObjects(S.scene.children, true);
        for (var h = 0; h < hits.length; h++) {
          var nm = hits[h].object.name || hits[h].object.type;
          /* bubble up to the named group so 'gateGroup3' does not read as 14 rows */
          var par = hits[h].object.parent;
          if (par && par.name) nm = par.name;
          seen[nm] = (seen[nm] || 0) + 1;
          break;
        }
      }
    }
    return seen;
  };

  SL.ready = function () { return !!S; };

  /* Which donor textures the live scene actually carries. tools/art-runtime.mjs can
   * only see a canvas 2D drawImage or a WebGL texImage2D, and three uploads its maps
   * inside the renderer, so "loaded 7 images" was the most that tool could prove. This
   * answers the claim directly: these vendor files are attached to materials now. */
  SL.donorTextures = function () {
    var seen = {};
    for (var k in TEX_CACHE) {
      if (!Object.prototype.hasOwnProperty.call(TEX_CACHE, k)) continue;
      var path = k.split(':')[0];
      if (path.indexOf('vendor/') === 0 && TEX_CACHE[k].image) seen[path] = true;
    }
    return Object.keys(seen).sort();
  };

  /* Introspection for the debug probe and the browser suite: the live objects,
   * not a copy, so a test can project a gate or check what the camera sees. */
  SL.dbg = function () {
    return S ? { scene: S.scene, camera: S.camera, craft: S.craft, gates: S.gates,
      rocks: S.rocks, texOk: texOk, shadow: S.shadow } : null;
  };
})(window);