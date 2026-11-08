// ============================================================================
// TREES (oak / golden maple / birch / pine), ROCKS - instanced, vertex-painted, soft canopies; every one has a voxel template
// ============================================================================
const _l = v => s2l(v);
const lc = c => [_l(c[0]), _l(c[1]), _l(c[2])];
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function blobGeo(cx, cy, cz, rx, ry, rz, seed, top, bot, jit = 0.17, detail = 2) {
  let g = new THREE.IcosahedronGeometry(1, detail); g.deleteAttribute('uv'); g.deleteAttribute('normal'); g = mergeVertices(g, 1e-3);
  const p = g.attributes.position, n = p.count, col = new Float32Array(n * 3), nor = new Float32Array(n * 3), T = lc(top), B = lc(bot);
  for (let i = 0; i < n; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), s = 1 + (vn3(x * 1.9 + seed, y * 1.9 + seed * 0.3, z * 1.9) - 0.5) * 2 * jit;
    p.setXYZ(i, cx + x * rx * s, cy + y * ry * s, cz + z * rz * s);
    let nx = x, ny = y + 0.4, nz = z; const l = Math.hypot(nx, ny, nz); nor[i * 3] = nx / l; nor[i * 3 + 1] = ny / l; nor[i * 3 + 2] = nz / l;
    const t = sstep(-0.9, 0.85, y * 0.8 + (vn3(x * 2.7 + seed, y * 2.7, z * 2.7) - 0.5) * 0.9), v = 0.82 + 0.36 * vn3(x * 5.3 + seed * 3, y * 5.3, z * 5.3);
    const c = mix3(B, T, t); col[i * 3] = c[0] * v; col[i * 3 + 1] = c[1] * v; col[i * 3 + 2] = c[2] * v;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); return g;
}
function trunkGeo(h, r0, r1, bark, bandy) {
  const g = new THREE.CylinderGeometry(r1, r0, h, 7, 4); g.translate(0, h / 2, 0); g.deleteAttribute('uv');
  const p = g.attributes.position, col = new Float32Array(p.count * 3), B = lc(bark);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), t = y / h, fl = 1 + 0.9 * Math.pow(Math.max(0, 1 - y / 0.7), 2);
    p.setX(i, p.getX(i) * fl + Math.sin(y * 1.7) * 0.05); p.setZ(i, p.getZ(i) * fl);
    let v = 0.75 + 0.5 * vn3(p.getX(i) * 8, y * 3, p.getZ(i) * 8);
    if (bandy) { v *= 0.55 + 0.6 * sstep(0.2, 0.8, vn3(0, y * 5.5, 0) + 0.2 * vn3(p.getX(i) * 9, y, p.getZ(i) * 9)); }
    col[i * 3] = B[0] * v; col[i * 3 + 1] = B[1] * v; col[i * 3 + 2] = B[2] * v * (1 + 0.0 * t);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.computeVertexNormals(); return g;
}
function coneGeo(y0, r, h, seed, top, bot) {
  const g = new THREE.ConeGeometry(r, h, 10, 1, true); g.translate(0, y0 + h / 2, 0); g.deleteAttribute('uv');
  const p = g.attributes.position, col = new Float32Array(p.count * 3), T = lc(top), B = lc(bot);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), t = clamp((y - y0) / h, 0, 1);
    if (t < 0.01) { const j = 1 + 0.18 * Math.sin(Math.atan2(z, x) * 7 + seed) + 0.1 * (vn3(x * 3 + seed, 0, z * 3) - 0.5); p.setX(i, x * j); p.setZ(i, z * j); p.setY(i, y - 0.22 * (0.5 + 0.5 * Math.sin(Math.atan2(z, x) * 9 + seed))); }
    const v = 0.8 + 0.4 * vn3(x * 4 + seed, y * 4, z * 4), c = mix3(B, T, Math.pow(t, 0.8) * 0.9 + 0.1 * (1 - t)); col[i * 3] = c[0] * v; col[i * 3 + 1] = c[1] * v; col[i * 3 + 2] = c[2] * v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.computeVertexNormals();
  // soften: normals lean upward a little so cones read as soft foliage
  const nm = g.attributes.normal; for (let i = 0; i < nm.count; i++) { const x = nm.getX(i), y = nm.getY(i) + 0.45, z = nm.getZ(i), l = Math.hypot(x, y, z); nm.setXYZ(i, x / l, y / l, z / l); }
  return g;
}
const OAKB = [[0, 4.1, 0, 2.4, 2.0, 2.4], [1.6, 3.5, 0.6, 1.6, 1.3, 1.6], [-1.5, 3.6, -0.5, 1.7, 1.35, 1.6], [0.2, 5.3, -0.1, 1.5, 1.2, 1.5], [-0.5, 3.3, 1.6, 1.4, 1.1, 1.4], [0.5, 3.4, -1.6, 1.45, 1.15, 1.4], [1.9, 4.6, -0.7, 1.0, 0.9, 1.0], [-1.8, 4.7, 0.8, 1.0, 0.9, 1.0]];
const TREE_SPEC = {
  oak: { trunk: { h: 2.6, r0: 0.38, r1: 0.2 }, blobs: OAKB, top: [0.60, 0.76, 0.22], bot: [0.13, 0.31, 0.08], bark: [0.30, 0.20, 0.12], cell: 0.8 },
  maple: { trunk: { h: 2.4, r0: 0.34, r1: 0.19 }, blobs: OAKB.map(b => b.map((v, i) => i > 2 ? v * 0.9 : v * 0.9)), top: [1.0, 0.68, 0.14], bot: [0.66, 0.22, 0.06], bark: [0.34, 0.2, 0.12], cell: 0.8 },
  birch: { trunk: { h: 4.6, r0: 0.17, r1: 0.09 }, blobs: [[0, 5.4, 0, 1.3, 1.25, 1.3], [0.8, 4.7, 0.3, 0.95, 0.9, 0.95], [-0.7, 4.9, -0.3, 1.0, 0.9, 1.0], [0, 6.3, 0, 0.8, 0.8, 0.8]], top: [0.78, 0.86, 0.36], bot: [0.32, 0.52, 0.14], bark: [0.86, 0.85, 0.8], cell: 0.7, band: true },
  pine: { trunk: { h: 1.8, r0: 0.3, r1: 0.18 }, cones: [[1.4, 2.0, 2.5], [2.5, 1.7, 2.4], [3.6, 1.4, 2.3], [4.7, 1.1, 2.1], [5.7, 0.8, 1.9], [6.6, 0.5, 1.5]], top: [0.32, 0.54, 0.3], bot: [0.07, 0.23, 0.16], bark: [0.25, 0.17, 0.11], cell: 0.8 },
};
function buildTreeGeo(type, detail = 2) {
  const S = TREE_SPEC[type], parts = [trunkGeo(S.trunk.h, S.trunk.r0, S.trunk.r1, S.bark, S.band)];
  if (S.blobs) S.blobs.forEach((b, i) => parts.push(blobGeo(b[0], b[1], b[2], b[3], b[4], b[5], i * 7.3 + type.length, S.top, S.bot, 0.2, detail)));
  if (S.cones) S.cones.forEach((c, i) => parts.push(coneGeo(c[0], c[1], c[2], i * 3.1, S.top, S.bot)));
  return mergeGeometries(parts);
}
const foliageMat = patchVox(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0, side: THREE.DoubleSide }), { cs: 0.8, leaf: true });
const barkMat = foliageMat; // single material: vertex colours carry bark + leaves
const TREES = []; const TREE_MESH = {}; const TREE_GEO = {}; const TREE_CAP = { oak: 56, maple: 18, birch: 40, pine: 120 };
function minDistOK(grid, x, z, d) { const cx = Math.floor(x / 6), cz = Math.floor(z / 6); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const a = grid.get((cx + i) * 4096 + (cz + j)); if (a) for (const q of a) if (Math.hypot(q[0] - x, q[1] - z) < Math.max(d, q[2])) return false; } return true; }
function nearSite(x, z, pad) { for (const k in SITES) { const s = SITES[k]; if (s.r0 > 0 && Math.hypot(x - s.x, z - s.z) < s.r0 + pad) return true; } return Math.hypot(x - 12.2, z - 2) < 13 || Math.hypot(x - 43, z - 12) < 7; }
function placeTrees() {
  const r = mulberry(31337), grid = new Map(), dummy = new THREE.Object3D(), col = new THREE.Color();
  for (const type of Object.keys(TREE_CAP)) {
    TREE_GEO[type] = { hi: buildTreeGeo(type, 2), lo: buildTreeGeo(type, 1) }; const mesh = new THREE.InstancedMesh(TREE_GEO[type].hi, foliageMat, TREE_CAP[type]); mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false; mesh.count = 0; TREE_MESH[type] = mesh; scene.add(mesh);
    let placed = 0, tries = 0; const spacing = type === 'pine' ? 3.2 : type === 'birch' ? 3.0 : 6.0;
    while (placed < TREE_CAP[type] && tries++ < 30000) {
      const x = (r() * 2 - 1) * 61, z = (r() * 2 - 1) * 61, h = HT(x, z), sl = terrSlope(x, z), d = Math.abs(x - riverX(z));
      if (d < 5.8 || h < WATER_Y + 0.9 || sl > 0.85 || pathDist(x, z) < 2.8 || nearSite(x, z, 2.5) || Math.hypot(x + 24, z + 46) < 15) continue;
      const cl = 0.5 + 0.5 * snoise(x * 0.045 + 5, z * 0.045 + 2);
      let ok = false;
      if (type === 'pine') ok = r() < (sstep(7, 16, h) * 0.9 + sstep(0.45, 0.8, sl) * 0.4) && h < 38;
      else if (type === 'oak') ok = h < 15 && cl > 0.5 && r() < 0.55;
      else if (type === 'maple') ok = h < 14 && cl > 0.58 && r() < 0.5;
      else ok = d < 26 && h < 11 && snoise(x * 0.07 - 3, z * 0.07 + 8) > 0.12 && r() < 0.7;
      if (!ok || !minDistOK(grid, x, z, spacing)) continue;
      const k = Math.floor(x / 6) * 4096 + Math.floor(z / 6); let a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push([x, z, spacing]);
      const s = (type === 'pine' ? 0.9 + r() * 0.9 : 0.85 + r() * 0.6), rot = r() * TAU; const y = h - 0.15;
      dummy.position.set(x, y, z); dummy.rotation.set((r() - 0.5) * 0.06, rot, (r() - 0.5) * 0.06); dummy.scale.set(s, s * (0.92 + r() * 0.2), s); dummy.updateMatrix();
      const idx = mesh.count++; mesh.setMatrixAt(idx, dummy.matrix); const tint = 0.88 + r() * 0.24; col.setRGB(tint, tint * (0.96 + r() * 0.08), tint * (0.94 + r() * 0.1)); mesh.setColorAt(idx, col);
      const S = TREE_SPEC[type], hw = (S.trunk.r0 * 0.85 + 0.05) * s;
      const t = { type, x, y, z, s, rot, idx, alive: true, box: null, id: TREES.length }; t.box = addBoxCol(x - hw, y, z - hw, x + hw, y + S.trunk.h * s * 1.1, z + hw, 'tree', t); TREES.push(t); placed++;
    }
    mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}
const _hid = new THREE.Matrix4().makeScale(0, 0, 0), _mm = new THREE.Matrix4();
function setTreeVisible(t, vis) {
  const mesh = TREE_MESH[t.type];
  if (!vis) { mesh.setMatrixAt(t.idx, _hid); } else { const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, t.rot, 0)); _mm.compose(new THREE.Vector3(t.x, t.y, t.z), q, new THREE.Vector3(t.s, t.s, t.s)); mesh.setMatrixAt(t.idx, _mm); }
  mesh.instanceMatrix.needsUpdate = true; t.alive = vis; if (t.box) t.box.on = vis;
}
// quality: draw only a fraction of each species
function onTreeQuality() { for (const type in TREE_MESH) TREE_MESH[type].geometry = Q.lite ? TREE_GEO[type].lo : TREE_GEO[type].hi; for (const type in TREE_MESH) TREE_MESH[type].count = Math.min(TREE_MESH[type].instanceMatrix.count, Math.ceil(TREE_CAP[type] * Q.trees)); }

