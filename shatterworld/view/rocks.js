// ---- rocks -----------------------------------------------------------------------------------------------------------
function rockGeo(seed, sx, sy, sz) {
  let g = new THREE.IcosahedronGeometry(1, 2); g.deleteAttribute('uv'); g.deleteAttribute('normal'); g = mergeVertices(g, 1e-3);
  const p = g.attributes.position, col = new Float32Array(p.count * 3), base = lc([0.52, 0.47, 0.42]), moss = lc([0.22, 0.38, 0.1]), warm = lc([0.62, 0.52, 0.4]);
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i); const n = vn3(x * 1.6 + seed, y * 1.6, z * 1.6), n2 = vn3(x * 4 + seed, y * 4, z * 4);
    const s = 0.75 + n * 0.5 + (n2 - 0.5) * 0.16; x *= s * sx; y *= s * sy; z *= s * sz; if (y < -0.3 * sy) y = -0.3 * sy + (y + 0.3 * sy) * 0.2;
    p.setXYZ(i, x, y, z); const up = y / (sy * 0.9);
    let c = mix3(base, warm, n2); c = mix3(c, moss, sstep(0.45, 0.85, up) * 0.75); const v = 0.8 + 0.4 * n2; col[i * 3] = c[0] * v; col[i * 3 + 1] = c[1] * v; col[i * 3 + 2] = c[2] * v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.computeVertexNormals(); return g;
}
const rockMat = patchVox(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, flatShading: true }), { cs: 0.5 });
const ROCKS = []; let rockMesh = null;
function placeRocks() {
  const geos = [rockGeo(1, 1.2, 0.8, 1.0), rockGeo(5, 1.0, 1.1, 0.9), rockGeo(9, 1.3, 0.7, 1.1)];
  const per = 26, meshes = geos.map(g => { const m = new THREE.InstancedMesh(g, rockMat, per); m.count = 0; m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; scene.add(m); return m; });
  const r = mulberry(8080), dummy = new THREE.Object3D(); let tries = 0;
  while (ROCKS.length < per * 3 && tries++ < 8000) {
    const x = (r() * 2 - 1) * 60, z = (r() * 2 - 1) * 60, h = HT(x, z), sl = terrSlope(x, z), d = Math.abs(x - riverX(z));
    if (pathDist(x, z) < 2 || nearSite(x, z, 0.5) || Math.hypot(x + 24, z + 46) < 12) continue;
    const near = d < 9 && d > 2.5, ok = near ? r() < 0.5 : (sl > 0.4 || h > 12 ? r() < 0.5 : r() < 0.05);
    if (!ok || h < WATER_Y - 0.6) continue;
    const vi = ROCKS.length % 3, m = meshes[vi], s = 0.6 + Math.pow(r(), 2.2) * 2.4; dummy.position.set(x, h - 0.12 * s, z); dummy.rotation.set(0, r() * TAU, 0); dummy.scale.setScalar(s); dummy.updateMatrix();
    const idx = m.count++; m.setMatrixAt(idx, dummy.matrix);
    const rk = { x, y: h, z, s, vi, idx, mesh: m, alive: true, box: null, rot: dummy.rotation.y }; if (s > 1.5) rk.box = addBoxCol(x - s * 0.62, h - 0.2, z - s * 0.62, x + s * 0.62, h + s * 0.78, z + s * 0.62, 'rock', rk); ROCKS.push(rk);
  }
  meshes.forEach(m => { m.instanceMatrix.needsUpdate = true; act1Objects.push(m); });
}
function setRockVisible(rk, vis) { if (vis) { const d = new THREE.Object3D(); d.position.set(rk.x, rk.y - 0.12 * rk.s, rk.z); d.rotation.y = rk.rot; d.scale.setScalar(rk.s); d.updateMatrix(); rk.mesh.setMatrixAt(rk.idx, d.matrix); } else rk.mesh.setMatrixAt(rk.idx, _hid); rk.mesh.instanceMatrix.needsUpdate = true; rk.alive = vis; if (rk.box) rk.box.on = vis; }

