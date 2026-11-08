// ============================================================================
// STRUCTURES: stone bridge, castle ruin (breakable walls), windmill, basalt pillars, far mountains. All procedural.
// ============================================================================
function makeStoneTex() {
  const N = 256, c = document.createElement('canvas'); c.width = c.height = N; const g = c.getContext('2d'); g.fillStyle = '#4a4540'; g.fillRect(0, 0, N, N);
  const r = mulberry(42); const rows = 8, rh = N / rows;
  for (let y = 0; y < rows; y++) { let x = -(y % 2) * 22, bw = 36; while (x < N) { const w = bw + (r() * 26 | 0); const l = 58 + r() * 26, wm = r() * 12; g.fillStyle = `hsl(${32 + wm},${10 + r() * 10}%,${l}%)`; g.fillRect(x + 1.5, y * rh + 1.5, w - 3, rh - 3);
      for (let k = 0; k < 40; k++) { g.fillStyle = `rgba(${r() < 0.5 ? '255,255,255' : '0,0,0'},${0.03 + r() * 0.06})`; g.fillRect(x + r() * w, y * rh + r() * rh, 2 + r() * 5, 1 + r() * 3); } x += w; } }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
const stoneTex = makeStoneTex();
const stoneMat = patchVox(new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 0.92, metalness: 0 }), { cs: 0.5, moss: true });
const stoneDark = patchVox(new THREE.MeshStandardMaterial({ map: stoneTex, color: 0xb9b2aa, roughness: 0.95 }), { cs: 0.5, moss: true });
const plasterMat = patchVox(new THREE.MeshStandardMaterial({ color: 0xf2e6cf, roughness: 0.9 }), { cs: 0.5 });
const woodMat = patchVox(new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.85 }), { cs: 0.5 });
const roofMat = patchVox(new THREE.MeshStandardMaterial({ color: 0x9b3d2a, roughness: 0.8 }), { cs: 0.5 });
const clothMat = new THREE.MeshStandardMaterial({ color: 0xf4ead2, roughness: 0.9, side: THREE.DoubleSide });
const bannerMat = new THREE.MeshStandardMaterial({ color: 0xc8352f, roughness: 0.8, side: THREE.DoubleSide });
const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.72, 0.3).multiplyScalar(2.6), toneMapped: true });
const STATIC = new Map(); // material -> geometry list (merged at the end)
function pushStatic(mat, geo) { let a = STATIC.get(mat); if (!a) { a = []; STATIC.set(mat, a); } a.push(geo); }
function boxGeo(w, h, d, uvScale = 0.34) {
  const g = new THREE.BoxGeometry(w, h, d), uv = g.attributes.uv, dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) { const i = f * 4 + k; uv.setXY(i, uv.getX(i) * dims[f][0] * uvScale, uv.getY(i) * dims[f][1] * uvScale); }
  g.deleteAttribute('uv2'); return g;
}
const PIECES = []; // breakable stone pieces {mesh, box, shapes(), alive}
function stoneBox(x0, y0, z0, x1, y1, z1, mat, opts = {}) {
  const w = x1 - x0, h = y1 - y0, d = z1 - z0, g = boxGeo(w, h, d); g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  const box = opts.col === false ? null : addBoxCol(x0, y0, z0, x1, y1, z1, opts.tag || 'stone');
  if (opts.breakable) {
    const m = new THREE.Mesh(g, mat || stoneMat); m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; scene.add(m);
    const p = { mesh: m, box, x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2, alive: true, b: [x0, y0, z0, x1, y1, z1], kind: 'wall' }; if (box) box.ref = p; PIECES.push(p); return p;
  }
  pushStatic(mat || stoneMat, g); return box;
}
function groundMin(x0, z0, x1, z1) { return Math.min(HT(x0, z0), HT(x1, z0), HT(x0, z1), HT(x1, z1), HT((x0 + x1) / 2, (z0 + z1) / 2)); }
function stoneWall(x0, z0, x1, z1, top, thick, opts) { // wall along x or z; goes from below ground to y = top
  const lo = groundMin(x0, z0, x1, z1) - 0.8; return stoneBox(x0, lo, z0, x1, top, z1, stoneMat, opts);
}
function cylMesh(r0, r1, h, seg, x, y, z, mat, col) {
  const g = new THREE.CylinderGeometry(r1, r0, h, seg, 1); g.translate(x, y + h / 2, z); const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * r0 * 3.2, uv.getY(i) * h * 0.34);
  pushStatic(mat, g); if (col) addBoxCol(x - r0 * 0.78, y, z - r0 * 0.78, x + r0 * 0.78, y + h, z + r0 * 0.78, 'stone');
}
let millSails = null, bannerGeo = null, bannerMesh = null; const LAMPS = [];
function buildStructures() {
  // ---------- stone bridge over the river (shard 2) ----------
  const bz = SITES.s2.z, rx = riverX(bz), xL = rx - 10.5, xR = rx + 10.5, deckY = 3.15;
  stoneBox(xL + 2.6, deckY - 1.0, bz - 1.9, xR - 2.6, deckY, bz + 1.9, stoneMat, { tag: 'bridge' });
  for (const s of [-1, 1]) { stoneBox(xL + 2.6, deckY, bz + s * 1.9 - (s > 0 ? 0.5 : 0), xR - 2.6, deckY + 0.85, bz + s * 1.9 + (s > 0 ? 0 : 0.5), stoneDark, { tag: 'bridge' }); }
  for (const side of [-1, 1]) { // approach steps
    for (let i = 0; i < 5; i++) { const xa = side < 0 ? xL + 2.6 - (i + 1) * 0.9 : xR - 2.6 + i * 0.9, y1 = deckY - 0.3 * (i + 1) + 0.02; stoneBox(xa, Math.min(HT(xa, bz), y1) - 1.2, bz - 1.9, xa + 0.9, y1 + 0.3 - 0.02 + (0), bz + 1.9, stoneMat, { tag: 'bridge' }); }
  }
  for (const px of [rx - 3.6, rx + 3.6]) stoneBox(px - 0.9, -1.0, bz - 1.5, px + 0.9, deckY - 1.0, bz + 1.5, stoneDark, { tag: 'pier', col: false });
  for (const [lx, lz] of [[xL + 2.9, bz - 1.65], [xL + 2.9, bz + 1.65], [xR - 2.9, bz - 1.65], [xR - 2.9, bz + 1.65]]) { cylMesh(0.14, 0.14, 1.9, 6, lx, deckY, lz, woodMat); const s = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), lampMat); s.position.set(lx, deckY + 2.05, lz); scene.add(s); LAMPS.push(s); }
  // ---------- castle ruin on the north-west hill (shard 5) ----------
  const C = SITES.s5, Hp = SITE_H.s5, cx = C.x, cz = C.z, rnd2 = mulberry(5150);
  const piece = (x0, z0, x1, z1, top) => stoneWall(x0, z0, x1, z1, top, 1, { breakable: true, tag: 'wall' });
  // north wall with a gate (walkable rampart) - pieces 2.3 wide
  for (let i = 0; i < 3; i++) { const x0 = cx - 7 + i * 1.8 + (i > 0 ? 0 : 0); piece(x0, cz + 7.0, x0 + 1.8, cz + 8.3, Hp + 5.4); }
  stoneBox(cx - 1.7, Hp + 3.6, cz + 7.0, cx + 1.7, Hp + 5.4, cz + 8.3, stoneMat, { tag: 'lintel' });
  for (const s of [-1, 1]) cylMesh(0.55, 0.5, 3.6, 10, cx + s * 1.9, Hp, cz + 7.65, stoneDark, false);
  for (let i = 0; i < 3; i++) { const x0 = cx + 1.9 + i * 1.8; piece(x0, cz + 7.0, x0 + 1.8, cz + 8.3, Hp + (i === 2 ? 3.8 : 5.4)); }
  // west wall (broken) + inner stair up to the rampart
  const wh = [4.8, 3.2, 4.4, 2.4, 3.8, 5.4];
  for (let i = 0; i < 6; i++) { const z0 = cz - 7 + i * 2.3; piece(cx - 8.4, z0, cx - 7.1, z0 + 2.3, Hp + wh[i]); }
  for (let i = 0; i < 13; i++) { const z0 = cz - 5.2 + i * 0.95, y1 = Hp + 0.43 * (i + 1); stoneBox(cx - 7.1, Hp - 0.6, z0, cx - 5.9, y1, z0 + 0.95, stoneDark, { tag: 'stair' }); }
  stoneBox(cx - 7.1, Hp - 0.6, cz + 7.15, cx - 1.7, Hp + 5.4 - 0.001, cz + 8.3, stoneMat, { col: false });
  // east side ruins + corner tower stub
  for (let i = 0; i < 3; i++) { const z0 = cz - 6 + i * 3.1; piece(cx + 8.2, z0, cx + 9.5, z0 + 3.1, Hp + [3.0, 1.8, 3.6][i]); }
  stoneWall(cx + 6.6, cz + 5.0, cx + 9.6, cz + 8.3, Hp + 7.4, 3, { tag: 'tower' });
  // columns (some broken) and a dais
  [[3.2, -2.4, 3.9], [3.4, 2.6, 2.2], [-3.6, 2.4, 3.8], [-3.3, -3.4, 1.6], [0.6, -5.6, 3.5]].forEach(([dx, dz, h]) => cylMesh(0.58, 0.5, h, 10, cx + dx, Hp, cz + dz, stoneDark, true));
  { const g = new THREE.CylinderGeometry(0.5, 0.5, 3.4, 10); g.rotateZ(PI / 2); g.translate(cx - 2.2, Hp + 0.5, cz - 1.0); g.rotateY(0.0); pushStatic(stoneDark, g); addBoxCol(cx - 3.9, Hp, cz - 1.5, cx - 0.5, Hp + 1.0, cz - 0.5, 'stone'); }
  stoneBox(cx - 1.4, Hp - 0.2, cz - 1.4, cx + 1.4, Hp + 0.28, cz + 1.4, stoneMat, { tag: 'dais' });
  // banner on a pole
  { const px = cx + 5.4, pz = cz + 6.0; cylMesh(0.08, 0.08, 6.6, 6, px, Hp - 0.5, pz, woodMat); bannerGeo = new THREE.PlaneGeometry(1.7, 2.4, 8, 10); bannerMesh = new THREE.Mesh(bannerGeo, bannerMat); bannerMesh.position.set(px + 0.9, Hp + 4.6, pz); bannerMesh.userData.base = bannerGeo.attributes.position.array.slice(); scene.add(bannerMesh); }
  // ---------- windmill (shard 3) ----------
  { const mx = 43.5, mz = 12, by = HT(mx, mz) - 0.6;
    cylMesh(2.7, 2.7, 1.3, 9, mx, by, mz, stoneMat, false); cylMesh(2.45, 1.7, 7.0, 9, mx, by + 1.2, mz, plasterMat, false);
    { const g = new THREE.ConeGeometry(2.3, 3.0, 9); g.translate(mx, by + 8.2 + 1.5, mz); pushStatic(roofMat, g); }
    stoneBox(mx - 0.55, by + 0.6, mz - 2.7, mx + 0.55, by + 2.6, mz - 2.2, woodMat, { col: false }); stoneBox(mx - 2.45, by + 4.6, mz - 0.4, mx - 2.0, by + 5.8, mz + 0.4, woodMat, { col: false });
    addBoxCol(mx - 2.0, by, mz - 2.0, mx + 2.0, by + 8.2, mz + 2.0, 'mill');
    millSails = new THREE.Group(); millSails.position.set(mx - 2.9, by + 7.7, mz); scene.add(millSails);
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), woodMat); millSails.add(hub);
    for (let i = 0; i < 4; i++) { const arm = new THREE.Group(); const beam = new THREE.Mesh(new THREE.BoxGeometry(0.16, 5.6, 0.14), woodMat); beam.position.y = 2.9; const sail = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 3.8), clothMat); sail.position.set(0.62, 3.2, 0.02); arm.add(beam, sail); arm.rotation.x = i * PI / 2; millSails.add(arm); }
    millSails.children.forEach(o => { o.castShadow = true; if (o.children) o.children.forEach(c => c.castShadow = true); });
  }
  // ---------- basalt pillars (shard 4) ----------
  { const S = SITES.s4, Hp4 = SITE_H.s4;
    const P = [[3.5, 0.6, 1.1, 1.2], [5.0, -2.2, 1.45, 1.1], [2.6, -4.6, 2.0, 1.25], [-1.0, -5.4, 2.6, 1.2], [-4.4, -3.6, 3.3, 1.3], [-6.0, 0.2, 4.1, 1.15], [-3.6, 4.0, 4.8, 1.3], [0.2, 2.6, 5.7, 1.5]];
    P.forEach(([dx, dz, h, r], i) => { const x = S.x + dx, z = S.z + dz, g = new THREE.CylinderGeometry(r * 0.96, r, h + 4, 6); g.rotateY(i * 0.7); g.translate(x, Hp4 - 4 + (h + 4) / 2, z); const uv = g.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * 2, uv.getY(k) * (h + 4) * 0.3); pushStatic(stoneDark, g); addBoxCol(x - r * 0.84, Hp4 - 4, z - r * 0.84, x + r * 0.84, Hp4 + h, z + r * 0.84, 'basalt'); });
    SITES.s4.top = Hp4 + 5.7; }
  // merge static pieces per material
  act1Objects.push(millSails, bannerMesh, ...LAMPS);
  for (const [mat, list] of STATIC) { const hasIdx = list.every(g => g.index); const geos = list.map(g => { if (!hasIdx) g = g.toNonIndexed(); g.deleteAttribute('uv1'); return g; }); const m = new THREE.Mesh(mergeGeometries(geos), mat); m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; scene.add(m); act1Objects.push(m); }
  STATIC.clear();
}
function updateStructures(dt, t) {
  if (millSails) millSails.rotation.x -= dt * 0.38;
  if (bannerGeo) { const a = bannerGeo.attributes.position, b = bannerMesh.userData.base; for (let i = 0; i < a.count; i++) { const x = b[i * 3] + 0.85, w = Math.sin(t * 3.1 + x * 3.2 + b[i * 3 + 1] * 1.3) * 0.12 * (x / 1.7); a.setZ(i, b[i * 3 + 2] + w); } a.needsUpdate = true; }
  for (const l of LAMPS) l.scale.setScalar(1 + 0.05 * Math.sin(t * 5 + l.position.x));
}

// ---------- far mountain ranges (layers fade into the golden haze) ----------
const FAR = [];
function buildFarMountains() {
  const rings = [{ R: 190, hMin: 18, hMax: 70, col: [0.42, 0.45, 0.52] }, { R: 260, hMin: 25, hMax: 105, col: [0.5, 0.52, 0.6] }, { R: 340, hMin: 35, hMax: 150, col: [0.6, 0.6, 0.68] }];
  const sunAz = Math.atan2(U.sunDir.value.x, U.sunDir.value.z);
  rings.forEach((rg, ri) => {
    const SEG = 220, V = 5, pos = new Float32Array(SEG * (V + 1) * 3 * 2), col = new Float32Array(pos.length), idx = [];
    for (let i = 0; i <= SEG; i++) {
      const a = i / SEG * TAU, saddle = 1 - 0.72 * Math.exp(-Math.pow(wrapPI(a - sunAz), 2) / 0.28);
      const rid = 1 - Math.abs(snoise(Math.cos(a) * 2.2 + ri * 7, Math.sin(a) * 2.2 + ri * 3)), n2 = snoise(Math.cos(a) * 6 + 3, Math.sin(a) * 6 + ri);
      const hh = (rg.hMin + (rg.hMax - rg.hMin) * Math.pow(rid, 2.2) * (0.6 + 0.4 * (0.5 + 0.5 * n2))) * saddle;
      for (let v = 0; v <= V; v++) {
        const t = v / V, h = -30 + (hh + 30) * t, rr = rg.R * (1 + (1 - t) * 0.12) + (rid) * 14 * t;
        const o = (i * (V + 1) + v) * 3; pos[o] = Math.cos(a) * rr; pos[o + 1] = h; pos[o + 2] = Math.sin(a) * rr;
        const snow = sstep(0.62, 0.9, h / (rg.hMax)) * (ri > 0 ? 1 : 0.4), k = 0.78 + 0.3 * t; col[o] = lerp(rg.col[0] * k, 0.95, snow); col[o + 1] = lerp(rg.col[1] * k, 0.95, snow); col[o + 2] = lerp(rg.col[2] * k, 1.0, snow);
      }
    }
    for (let i = 0; i < SEG; i++) for (let v = 0; v < V; v++) { const a = i * (V + 1) + v, b = (i + 1) * (V + 1) + v; idx.push(a, a + 1, b, b, a + 1, b + 1); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos.slice(0, (SEG + 1) * (V + 1) * 3), 3)); g.setAttribute('color', new THREE.BufferAttribute(col.slice(0, (SEG + 1) * (V + 1) * 3), 3)); g.setIndex(idx); g.computeVertexNormals();
    { const nm = g.attributes.normal, cc = g.attributes.color, L = U.sunDir.value; for (let i = 0; i < cc.count; i++) { const l = 0.55 + 0.75 * Math.max(0, nm.getX(i) * L.x + nm.getY(i) * L.y + nm.getZ(i) * L.z) + 0.12 * Math.abs(nm.getY(i)); cc.setXYZ(i, cc.getX(i) * l, cc.getY(i) * l * 0.98, cc.getZ(i) * l * 0.95); } } // baked sun shading: distant ranges need no per-pixel lighting
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: true })); m.frustumCulled = false; scene.add(m); FAR.push(m);
  });
}

