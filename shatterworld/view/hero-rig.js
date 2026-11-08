// ============================================================================
// THE PLUMBER (and friends): procedural cartoon rig with outline hull, squash & stretch, full pose-driven animation
// ============================================================================
const outlineMat = new THREE.MeshBasicMaterial({ color: 0x14080a, side: THREE.BackSide, fog: true });
const hv = hex => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.52, metalness: 0, emissive: hex, emissiveIntensity: 0.1 });
const SPH = new THREE.SphereGeometry(1, 16, 12), CYL = new THREE.CylinderGeometry(1, 1, 1, 14, 1), HEMI = new THREE.SphereGeometry(1, 20, 10, 0, TAU, 0, PI / 2);
function part(parent, geo, mat, x, y, z, sx, sy, sz, outline = 0.075) {
  const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.scale.set(sx, sy, sz); m.castShadow = true; parent.add(m); (parent.userData.vrp || (parent.userData.vrp = [])).push(m);
  if (outline) { const o = new THREE.Mesh(geo, outlineMat); (parent.userData.vro || (parent.userData.vro = [])).push(o); o.position.copy(m.position); o.scale.set(sx * (1 + outline) + 0.014, sy * (1 + outline) + 0.014, sz * (1 + outline) + 0.014); o.renderOrder = -1; parent.add(o); }
  return m;
}
function buildPlumber(o = {}) {
  const red = hv(o.cap || 0xd8302a), blue = hv(o.overall || 0x2f5fdc), shirt = hv(o.shirt || o.cap || 0xd8302a), skin = hv(0xffc9a0), white = hv(0xfafafa), boot = hv(0x5c3516), hair = hv(0x3a2412), yellow = hv(0xffd84a), eyeBlue = hv(0x2a6bd8);
  const root = new THREE.Group(), body = new THREE.Group(); root.add(body);
  const hips = new THREE.Group(); hips.position.set(0, 0.64, 0); body.add(hips);
  const torso = new THREE.Group(); torso.position.set(0, 0.64, 0); body.add(torso);
  const legs = [-1, 1].map(s => { const g = new THREE.Group(); g.position.set(s * 0.17, 0.64, 0); body.add(g); part(g, CYL, blue, 0, -0.2, 0, 0.145, 0.46, 0.145, 0.05); part(g, SPH, boot, 0, -0.5, 0.07, 0.2, 0.14, 0.31, 0.06); return g; });
  part(torso, SPH, blue, 0, 0.26, 0, 0.35, 0.34, 0.31, 0.06);               // overalls belly
  part(torso, SPH, shirt, 0, 0.5, -0.02, 0.33, 0.2, 0.27, 0.05);            // shirt chest
  part(torso, SPH, blue, 0, 0.42, 0.2, 0.22, 0.19, 0.1, 0);                  // bib
  for (const s of [-1, 1]) { part(torso, SPH, yellow, s * 0.14, 0.46, 0.285, 0.055, 0.055, 0.04, 0); part(torso, CYL, blue, s * 0.15, 0.58, 0.02, 0.05, 0.3, 0.12, 0); }
  const arms = [-1, 1].map(s => { const g = new THREE.Group(); g.position.set(s * 0.4, 0.62, 0); torso.add(g); part(g, CYL, shirt, 0, -0.15, 0, 0.105, 0.34, 0.105, 0.05); part(g, SPH, white, 0, -0.38, 0, 0.145, 0.145, 0.145, 0.06); return g; });
  const head = new THREE.Group(); head.position.set(0, 0.86, 0); torso.add(head);
  part(head, SPH, skin, 0, 0, 0, 0.34, 0.32, 0.33, 0.07);
  part(head, SPH, skin, 0, -0.04, 0.33, 0.12, 0.1, 0.1, 0.05);                                   // big round nose
  for (const s of [-1, 1]) { part(head, SPH, hair, s * 0.11, -0.14, 0.3, 0.14, 0.065, 0.08, 0.03).rotation.z = -s * 0.28; part(head, SPH, white, s * 0.115, 0.08, 0.3, 0.07, 0.09, 0.04, 0); part(head, SPH, eyeBlue, s * 0.115, 0.075, 0.335, 0.036, 0.05, 0.02, 0); part(head, SPH, hair, s * 0.12, 0.2, 0.28, 0.09, 0.025, 0.04, 0).rotation.z = s * 0.15; part(head, SPH, skin, s * 0.33, -0.02, 0, 0.06, 0.09, 0.05, 0.04); part(head, SPH, hair, s * 0.27, 0.0, -0.06, 0.07, 0.14, 0.11, 0); }
  part(head, SPH, hair, 0, 0.0, -0.17, 0.3, 0.28, 0.2, 0);
  const cap = new THREE.Group(); cap.position.set(0, 0.09, 0.02); cap.rotation.x = -0.08; head.add(cap);
  part(cap, HEMI, red, 0, 0.0, 0, 0.36, 0.34, 0.37, 0.06); part(cap, SPH, red, 0, 0.0, 0.3, 0.3, 0.05, 0.22, 0.05);
  part(cap, SPH, red, 0, 0.33, -0.01, 0.05, 0.04, 0.05, 0);
  const S = o.scale || 0.94; root.scale.setScalar(S);
  return { root, body, hips, torso, legs, arms, head, cap, mats: { red, blue, shirt, skin, white, boot, hair, yellow, eyeBlue }, ph: 0, sq: 0, sqv: 0, pose: { lx: 0, rx: 0, la: 0, ra: 0, lean: 0, side: 0, pitch: 0, hx: 0, hy: 0, bob: 0, roll: 0, spin: 0 }, S };
}
const hero = buildPlumber({}); hero.root.traverse(m => { if (m.isMesh) { m.frustumCulled = false; } }); scene.add(hero.root);
const twin = buildPlumber({ cap: 0x2fbf4a, shirt: 0x2fbf4a, overall: 0x3a4ee0 }); scene.add(twin.root);
twin.root.visible = false;

// pose application: smooth toward the target pose, then write joint transforms
function poseTo(h, t, dt, k) {
  const p = h.pose; const a = 1 - Math.exp(-k * dt);
  for (const key in t) p[key] += (t[key] - p[key]) * a;
}
function applyPose(h, dt) {
  const p = h.pose;
  h.legs[0].rotation.x = p.lx; h.legs[1].rotation.x = p.rx;
  h.arms[0].rotation.x = p.la; h.arms[1].rotation.x = p.ra; h.arms[0].rotation.z = -0.14 - Math.max(0, p.side) * 0.6; h.arms[1].rotation.z = 0.14 + Math.max(0, p.side) * 0.6;
  h.torso.rotation.x = p.lean; h.torso.rotation.z = p.side * 0.12; h.head.rotation.x = p.hx; h.head.rotation.y = p.hy;
  h.body.position.y = p.bob; h.body.rotation.x = p.pitch; h.body.rotation.z = p.roll; h.body.rotation.y = p.spin;
  // squash & stretch spring (about the feet)
  h.sqv += (-90 * h.sq - 11 * h.sqv) * dt; h.sq += h.sqv * dt; const s = clamp(h.sq, -0.45, 0.55);
  h.body.scale.set(1 - s * 0.45, 1 + s, 1 - s * 0.45);
}
function heroKick(h, v) { h.sqv += v; }

