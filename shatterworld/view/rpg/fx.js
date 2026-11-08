// ---- 3D fx pools: expanding rings, cube chunks, hit sparks -------------------------------------------------------------------------------------------------
const RFX_RING_GEO = new THREE.RingGeometry(0.9, 1, 64).rotateX(-PI / 2), RFX_DISC_GEO = new THREE.CircleGeometry(1, 48).rotateX(-PI / 2), RING_POOL = [];
for (let i = 0; i < 16; i++) { const m = new THREE.Mesh(RFX_RING_GEO, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide, forceSinglePass: true })); m.visible = false; m.frustumCulled = false; m.renderOrder = 18; scene.add(m); RING_POOL.push({ m, t: 0, dur: 1, r0: 1, r1: 1, op: 1, on: false, fade: 1.2 }); }
let ringNext = 0;
function fxRing(x, y, z, r0, r1, dur, color = 0xffd66b, op = 0.9, disc = false) {
  const r = RING_POOL[ringNext++ % RING_POOL.length]; r.on = true; r.t = 0; r.dur = dur; r.r0 = r0; r.r1 = r1; r.op = op; r.fade = disc ? 1.0 : 1.3; r.m.geometry = disc ? RFX_DISC_GEO : RFX_RING_GEO; r.m.material.color.set(color); r.m.position.set(x, y + 0.06, z); r.m.visible = true; r.m.scale.set(r0, 1, r0); return r;
}
function updateRings(dt) { for (const r of RING_POOL) { if (!r.on) continue; r.t += dt; const k = r.t / r.dur; if (k >= 1) { r.on = false; r.m.visible = false; continue; } const e = 1 - Math.pow(1 - k, 2.4), s = r.r0 + (r.r1 - r.r0) * e; r.m.scale.set(s, 1, s); r.m.material.opacity = r.op * Math.pow(1 - k, r.fade); } }
const NCHUNK = 192, CH = { x: new Float32Array(NCHUNK), y: new Float32Array(NCHUNK), z: new Float32Array(NCHUNK), vx: new Float32Array(NCHUNK), vy: new Float32Array(NCHUNK), vz: new Float32Array(NCHUNK), s: new Float32Array(NCHUNK), life: new Float32Array(NCHUNK), max: new Float32Array(NCHUNK), gy: new Float32Array(NCHUNK), rx: new Float32Array(NCHUNK), ry: new Float32Array(NCHUNK) };
const chunkMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.05, emissive: 0x222222 }), NCHUNK); chunkMesh.frustumCulled = false; chunkMesh.castShadow = false; chunkMesh.count = NCHUNK; scene.add(chunkMesh);
chunkMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(NCHUNK * 3), 3); const _chD = new THREE.Object3D(), _chC = new THREE.Color(); let chunkNext = 0;
for (let i = 0; i < NCHUNK; i++) { _chD.scale.set(0, 0, 0); _chD.updateMatrix(); chunkMesh.setMatrixAt(i, _chD.matrix); }
function fxChunks(x, y, z, n, color, size = 0.22, speed = 5, gy = null) {
  _chC.set(color); const g = gy == null ? y - 0.6 : gy;
  for (let k = 0; k < n; k++) { const i = chunkNext++ % NCHUNK, a = Math.random() * TAU, sp = speed * (0.35 + Math.random() * 0.8); CH.x[i] = x; CH.y[i] = y; CH.z[i] = z; CH.vx[i] = Math.cos(a) * sp; CH.vz[i] = Math.sin(a) * sp; CH.vy[i] = 2 + Math.random() * speed * 0.9; CH.s[i] = size * (0.6 + Math.random() * 0.8); CH.life[i] = CH.max[i] = 0.9 + Math.random() * 0.7; CH.gy[i] = g; CH.rx[i] = Math.random() * 6; CH.ry[i] = Math.random() * 6; const v = 0.8 + Math.random() * 0.4; chunkMesh.setColorAt(i, _chC.clone().multiplyScalar(v)); }
  chunkMesh.instanceColor.needsUpdate = true; chunkMesh.visible = true;
}
function updateChunks(dt) {
  let any = false;
  for (let i = 0; i < NCHUNK; i++) {
    if (CH.life[i] <= 0) continue; any = true; CH.life[i] -= dt; CH.vy[i] -= 24 * dt; CH.x[i] += CH.vx[i] * dt; CH.y[i] += CH.vy[i] * dt; CH.z[i] += CH.vz[i] * dt;
    if (CH.y[i] < CH.gy[i] + CH.s[i] * 0.5) { CH.y[i] = CH.gy[i] + CH.s[i] * 0.5; if (CH.vy[i] < -2) { CH.vy[i] *= -0.32; CH.vx[i] *= 0.6; CH.vz[i] *= 0.6; } else { CH.vy[i] = 0; CH.vx[i] *= 0.85; CH.vz[i] *= 0.85; } }
    const k = CH.life[i] / CH.max[i], sc = CH.s[i] * (k < 0.3 ? k / 0.3 : 1); CH.rx[i] += dt * 5; CH.ry[i] += dt * 4;
    _chD.position.set(CH.x[i], CH.y[i], CH.z[i]); _chD.rotation.set(CH.rx[i], CH.ry[i], 0); _chD.scale.set(sc, sc, sc); _chD.updateMatrix(); chunkMesh.setMatrixAt(i, _chD.matrix);
    if (CH.life[i] <= 0) { _chD.scale.set(0, 0, 0); _chD.updateMatrix(); chunkMesh.setMatrixAt(i, _chD.matrix); }
  }
  if (any) chunkMesh.instanceMatrix.needsUpdate = true; chunkMesh.visible = any; // an idle chunk pool costs no draw call
}
function fxBolt(x0, y0, z0, x1, y1, z1, color = 0x9fe8ff) { const n = Math.max(3, Math.min(9, Math.round(Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 0.9))); for (let i = 0; i <= n; i++) { const t = i / n, j = i === 0 || i === n ? 0 : 0.35; puff(x0 + (x1 - x0) * t + (Math.random() - 0.5) * j, y0 + (y1 - y0) * t + (Math.random() - 0.5) * j, z0 + (z1 - z0) * t + (Math.random() - 0.5) * j, 1, 0.45, color, 0.3, 0, 0.3); } sparkBurst(x1, y1, z1, 4, color, 3); }
const _pv = new THREE.Vector3();
function rpgProject(x, y, z, out) { _pv.set(x, y, z).project(camera); if (_pv.z > 1 || _pv.z < -1) return false; out.x = (_pv.x * 0.5 + 0.5) * W; out.y = (-_pv.y * 0.5 + 0.5) * H; return out.x > -80 && out.x < W + 80 && out.y > -40 && out.y < H + 40; }

