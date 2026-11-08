// ---- new enemy types: brute (tank + telegraphed slam), hopper (telegraphed leap), spitter (stationary bolt thrower) -------------------------------------------
const spikeGeo = new THREE.ConeGeometry(1, 1, 6), EN_COL = { walker: 0xa5602d, shell: 0x2faa4a, brute: 0x7a2638, hopper: 0x3aa89a, spitter: 0x9a4acb };
const mBruteA = hv(0x8a2c3e), mBruteB = hv(0x3a1624), mBruteGlow = new THREE.MeshBasicMaterial({ color: 0xffa04a }), mHopA = hv(0x34a894), mHopB = hv(0xe8f0a0), mSpitA = hv(0x8a3fc0), mSpitB = hv(0x2d7a3a), mSpitMouth = hv(0x1a0a2a), mGlowW = new THREE.MeshBasicMaterial({ color: 0xffffff });
function buildBrute() {
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body); const arms = [];
  part(body, SPH, mBruteA, 0, 0.62, 0, 0.58, 0.5, 0.52, 0.06); part(body, SPH, mBruteA, 0, 1.08, 0.12, 0.3, 0.27, 0.28, 0.06); for (const s of [-1, 1]) part(body, SPH, mBruteGlow, s * 0.12, 1.12, 0.37, 0.06, 0.045, 0.03, 0);
  for (const s of [-1, 1]) { const a = new THREE.Group(); a.position.set(s * 0.6, 0.85, 0.05); body.add(a); part(a, CYL, mBruteA, 0, -0.28, 0, 0.13, 0.5, 0.13, 0.05); part(a, SPH, mBruteB, 0, -0.62, 0.05, 0.24, 0.22, 0.24, 0.06); arms.push(a); part(body, CYL, mBruteB, s * 0.24, 0.14, 0, 0.17, 0.3, 0.19, 0.05); }
  for (let i = 0; i < 5; i++) { const m = new THREE.Mesh(spikeGeo, mBruteB); const a = (i - 2) * 0.5; m.position.set(Math.sin(a) * 0.4, 0.9 + Math.cos(a) * 0.12, -0.42); m.rotation.x = -PI / 2 - 0.2; m.rotation.z = -a * 0.5; m.scale.set(0.1, 0.3, 0.1); body.add(m); (body.userData.vrp || (body.userData.vrp = [])).push(m); } // vrp: merged into one mesh in VR
  g.traverse(o => { if (o.isMesh) o.frustumCulled = false; }); return { g, body, arms };
}
function buildHopper() {
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
  part(body, SPH, mHopA, 0, 0.34, 0, 0.42, 0.34, 0.45, 0.06); part(body, SPH, mHopB, 0, 0.26, 0.14, 0.3, 0.22, 0.28, 0.04);
  for (const s of [-1, 1]) { part(body, SPH, mGlowW, s * 0.17, 0.62, 0.18, 0.1, 0.12, 0.09, 0.03); part(body, SPH, mSpitMouth, s * 0.17, 0.63, 0.27, 0.045, 0.06, 0.03, 0); part(body, CYL, mHopA, s * 0.3, 0.14, -0.14, 0.11, 0.26, 0.13, 0.04); part(body, SPH, mHopB, s * 0.3, 0.04, -0.04, 0.12, 0.07, 0.2, 0.04); }
  g.traverse(o => { if (o.isMesh) o.frustumCulled = false; }); return { g, body };
}
function buildSpitter() {
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
  part(body, CYL, mSpitB, 0, 0.22, 0, 0.1, 0.46, 0.1, 0.04); part(body, SPH, mSpitA, 0, 0.72, 0, 0.42, 0.4, 0.4, 0.06); part(body, SPH, mSpitMouth, 0, 0.7, 0.34, 0.2, 0.17, 0.1, 0.03);
  for (let i = 0; i < 4; i++) { const a = i * PI / 2 + 0.4; const l = part(body, SPH, mSpitB, Math.cos(a) * 0.26, 0.16, Math.sin(a) * 0.26, 0.24, 0.05, 0.12, 0.03); l.rotation.y = -a; l.rotation.z = 0.35; }
  for (const s of [-1, 1]) part(body, SPH, mGlowW, s * 0.15, 0.88, 0.22, 0.07, 0.07, 0.06, 0.02);
  g.traverse(o => { if (o.isMesh) o.frustumCulled = false; }); return { g, body };
}
const _addEnemy = addEnemy;
addEnemy = function (spec) {
  if (spec.type !== 'brute' && spec.type !== 'hopper' && spec.type !== 'spitter') return _addEnemy(spec);
  const m = spec.type === 'brute' ? buildBrute() : spec.type === 'hopper' ? buildHopper() : buildSpitter(); m.g.scale.setScalar(spec.type === 'brute' ? 1.65 : 1.3); m.g.position.set(spec.x, spec.y, spec.z); scene.add(m.g); if (VR.merge) vrMergeApply(m.g, true); // same VR draw-call diet as the original walker / shell
  const e = { type: spec.type, x: spec.x, y: spec.y, z: spec.z, hx: spec.x, hz: spec.z, r: spec.r || 3, dir: 1, ang: Math.random() * TAU, vy: 0, state: 'walk', t: 0, mesh: m.g, body: m.body, arms: m.arms, alive: true, ceil: !!spec.ceil, kx: 0, kz: 0, h: spec.type === 'brute' ? 1.3 : 0.8, ph: Math.random() * 6 };
  ENEMIES.push(e); return e;
};

