// ==============================================================================================================================================================================================
// CHARACTER MODELS: every class is a style applied to the existing procedural plumber rig (buildPlumber / part / poseTo / applyPose are reused as they are). A class = data in CLASSES + ONE builder
// entry in CLASS_MODELS (rig, def) that recolours, reshapes and adds parts. Silhouettes are chosen to read at diorama distance: Lou tall + green, Gruntmaw wide + horned, Zip small + goggles + scarf,
// Petal flower hat + leaf wings, Ember wizard hat + staff.
// ==============================================================================================================================================================================================
const CONE = new THREE.ConeGeometry(1, 1, 10);
const rcol = (m, hex) => { m.color.set(hex); if (m.emissive) m.emissive.set(hex); };
function rigShape(r, o) { // proportions: legs / torso / arms scale (x,y,z), head scale, overall scale S. Hips follow the leg length so the feet stay on the ground.
  const ls = o.legs || [1, 1, 1], ts = o.torso || [1, 1, 1], as = o.arms || [1, 1, 1], hip = 0.64 * ls[1];
  for (const l of r.legs) { l.scale.set(ls[0], ls[1], ls[2]); l.position.y = hip; } r.torso.position.y = hip; r.torso.scale.set(ts[0], ts[1], ts[2]); for (const a of r.arms) a.scale.set(as[0], as[1], as[2]); r.head.scale.setScalar(o.head || 1);
  if (o.S) { r.S = o.S; r.root.scale.setScalar(o.S); }
}
const CLASS_MODELS = {
  pip: (r, d) => { },
  lou: (r, d) => { // the tall twin: long legs, small head, green cap, violet overalls, springy coil boots
    const M = r.mats; rcol(M.red, 0x2fbf4a); rcol(M.shirt, 0x2fbf4a); rcol(M.blue, 0x5a46e6); rigShape(r, { S: 1.04, legs: [0.9, 1.4, 0.9], torso: [0.9, 1.15, 0.9], arms: [0.88, 1.25, 0.88], head: 0.92 });
    const coil = hv(0xdfe7f0), gold = hv(0xffd84a); r.legs.forEach(l => { for (let i = 0; i < 3; i++) part(l, SPH, coil, 0, -0.36 - i * 0.045, 0.02, 0.17, 0.028, 0.17, 0); }); part(r.cap, SPH, gold, 0, 0.12, 0.37, 0.1, 0.1, 0.03, 0);
  },
  gruntmaw: (r, d) => { // the brawler: wide, short, green-grey skin, iron horned helm, pauldrons, belt, tusks
    const M = r.mats; rcol(M.skin, 0x8fb86a); rcol(M.red, 0x727b88); rcol(M.shirt, 0x6b4a32); rcol(M.blue, 0x4a3a2a); rcol(M.boot, 0x3a2a20); rcol(M.hair, 0x2a2a2a); rigShape(r, { S: 1.1, legs: [1.3, 0.82, 1.3], torso: [1.38, 1.05, 1.3], arms: [1.35, 1.1, 1.35], head: 0.8 });
    const bone = hv(0xf2ead2), iron = hv(0x59626e), gold = hv(0xd9a21a);
    for (const s of [-1, 1]) { const h = part(r.cap, CONE, bone, s * 0.36, 0.14, 0, 0.1, 0.36, 0.1, 0.04); h.rotation.z = -s * 0.85; part(r.head, CONE, bone, s * 0.13, -0.2, 0.3, 0.05, 0.17, 0.05, 0).rotation.x = -0.35; part(r.torso, SPH, iron, s * 0.56, 0.7, 0, 0.21, 0.17, 0.23, 0.05); for (let i = 0; i < 3; i++) { const k = part(r.torso, CONE, iron, s * (0.55 + i * 0.04), 0.84, (i - 1) * 0.1, 0.045, 0.14, 0.045, 0); k.rotation.z = -s * 0.5; } }
    part(r.torso, CYL, gold, 0, 0.02, 0, 0.37, 0.07, 0.34, 0); part(r.torso, SPH, gold, 0, 0.02, 0.33, 0.09, 0.09, 0.04, 0);
  },
  zip: (r, d) => { // the speedster: small, big-headed, yellow + teal, goggles, trailing scarf, lightning boots
    const M = r.mats; rcol(M.shirt, 0xffc83a); rcol(M.blue, 0x1fb6a6); rcol(M.red, 0xffc83a); rcol(M.boot, 0xf4f4f4); rigShape(r, { S: 0.84, legs: [0.88, 1.12, 0.88], torso: [0.86, 0.96, 0.86], arms: [0.9, 1.1, 0.9], head: 1.1 }); r.cap.rotation.y = PI; // cap on backwards
    const lens = hv(0x5ff0ff), dark = hv(0x20303a), scarf = hv(0xff5a4a), bolt = hv(0xffe24a);
    part(r.head, SPH, dark, 0, 0.13, 0.02, 0.37, 0.05, 0.35, 0); for (const s of [-1, 1]) { part(r.head, SPH, lens, s * 0.13, 0.15, 0.31, 0.1, 0.1, 0.05, 0.04); part(r.legs[s > 0 ? 1 : 0], SPH, bolt, 0, -0.45, 0.2, 0.05, 0.1, 0.03, 0); }
    part(r.torso, SPH, scarf, 0, 0.66, 0, 0.3, 0.1, 0.28, 0.04); r.tail = []; for (let i = 0; i < 3; i++) { const g = new THREE.Group(); g.position.set(0.14, 0.64, -0.26 - i * 0.2); r.torso.add(g); part(g, SPH, scarf, 0, 0, 0, 0.1, 0.05, 0.14, 0.02); r.tail.push(g); }
    r.tick = (t, sp) => { for (let i = 0; i < r.tail.length; i++) { r.tail[i].position.y = 0.64 + Math.sin(t * 9 - i * 0.9) * 0.05 * (0.5 + sp * 0.1); r.tail[i].position.x = 0.14 + Math.sin(t * 7 - i) * 0.04; } };
  },
  petal: (r, d) => { // the glider: slender, flower hat, leaf wings, petal skirt, pink + green
    const M = r.mats; rcol(M.skin, 0xffe0cf); rcol(M.blue, 0x4fbf6a); rcol(M.shirt, 0xff8fc1); rcol(M.boot, 0x8a5a3a); rcol(M.hair, 0xb87a4a); rigShape(r, { S: 0.9, legs: [0.82, 1.1, 0.82], torso: [0.8, 1.04, 0.8], arms: [0.78, 1.05, 0.78], head: 1.02 }); r.cap.visible = false;
    const pink = hv(0xff8fc1), white = hv(0xfff2f8), gold = hv(0xffd84a), leaf = hv(0x58c878), leaf2 = hv(0x8fe0a0);
    for (let i = 0; i < 7; i++) { const a = i / 7 * TAU, p = part(r.head, SPH, i % 2 ? pink : white, Math.cos(a) * 0.22, 0.3, Math.sin(a) * 0.22, 0.16, 0.05, 0.09, 0.03); p.rotation.y = -a; p.rotation.z = Math.cos(a) * 0.0 + 0.0; p.rotation.x = 0; } part(r.head, SPH, gold, 0, 0.33, 0, 0.11, 0.08, 0.11, 0.03);
    r.wing = []; for (const s of [-1, 1]) { const g = new THREE.Group(); g.position.set(s * 0.18, 0.56, -0.26); r.torso.add(g); const w = part(g, SPH, leaf, s * 0.34, 0.02, 0, 0.4, 0.04, 0.2, 0.03); w.rotation.z = s * 0.18; part(g, SPH, leaf2, s * 0.3, 0.03, 0.0, 0.26, 0.045, 0.1, 0); g.rotation.z = s * 0.35; g.userData.s = s; r.wing.push(g); }
    for (let i = 0; i < 6; i++) { const a = i / 6 * TAU, p = part(r.torso, SPH, i % 2 ? pink : white, Math.cos(a) * 0.24, -0.02, Math.sin(a) * 0.22, 0.14, 0.045, 0.09, 0.02); p.rotation.y = -a; p.rotation.z = 0.0; }
    r.tick = (t, sp, gl) => { for (const g of r.wing) g.rotation.z = g.userData.s * (0.35 + Math.sin(t * (gl ? 5 : 2.4)) * (gl ? 0.35 : 0.12)); };
  },
  ember: (r, d) => { // the mage: wizard hat, robe over the legs, a glowing staff in the right hand
    const M = r.mats; rcol(M.red, 0xa8222c); rcol(M.shirt, 0xd9552a); rcol(M.blue, 0x5a1f3a); rcol(M.boot, 0x2a1418); rigShape(r, { S: 0.96, legs: [0.9, 1, 0.9], torso: [0.95, 1.05, 0.95], head: 1 }); r.cap.visible = false;
    const hat = hv(0x8a1a2a), robe = hv(0x6a2442), gold = hv(0xffc93a), wood = hv(0x6a4426), bead = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 1.25, 0.32), toneMapped: false, fog: false }), white = hv(0xf2eee8);
    part(r.head, CYL, hat, 0, 0.27, 0, 0.5, 0.04, 0.5, 0.04); part(r.head, CONE, hat, 0, 0.66, 0, 0.32, 0.78, 0.32, 0.05); const tip = part(r.head, CONE, hat, 0.12, 1.08, 0, 0.12, 0.3, 0.12, 0.04); tip.rotation.z = -0.6; part(r.head, SPH, gold, 0, 0.36, 0.3, 0.07, 0.07, 0.04, 0); part(r.head, SPH, white, 0, -0.23, 0.22, 0.2, 0.17, 0.1, 0.04);
    part(r.torso, CYL, robe, 0, -0.1, 0, 0.44, 0.62, 0.4, 0.05); part(r.torso, CYL, gold, 0, 0.03, 0, 0.38, 0.04, 0.35, 0);
    part(r.arms[1], CYL, wood, 0.03, -0.3, 0.14, 0.035, 1.05, 0.035, 0.03); r.orb = part(r.arms[1], SPH, bead, 0.03, 0.26, 0.14, 0.12, 0.12, 0.12, 0); r.tick = (t, sp) => { const s = 0.12 + Math.sin(t * 6) * 0.015; r.orb.scale.set(s, s, s); };
  },
};
function buildClassRig(id) {
  const d = classDef(id), rig = buildPlumber({ scale: 0.94 }), fn = CLASS_MODELS[d.model] || CLASS_MODELS.pip; fn(rig, d); rig.root.traverse(m => { if (m.isMesh) m.frustumCulled = false; }); rig.cls = id; return rig;
}
function heroSetModel(id) {
  const n = buildClassRig(id), old = hero.root, seen = new Set(); scene.remove(old); old.traverse(o => { if (o.isMesh && o.material && o.material !== outlineMat && !seen.has(o.material)) { seen.add(o.material); if (o.material.dispose) o.material.dispose(); } });
  Object.assign(hero, n); hero.pose = n.pose; scene.add(hero.root); if (VR.merge) vrMergeApply(hero.root, true); STAR.tinted = false; hero.root.position.set(P.x, P.y, P.z);
}
function rigTick(r, t, sp, gl) { if (r.tick) r.tick(t, sp, gl); }
const _updateHeroVisual3 = updateHeroVisual; updateHeroVisual = function (dt, rdt) { _updateHeroVisual3(dt, rdt); rigTick(hero, heroVis.t, P.speed, FORM.id === 'gust' || (RT.S.fx.glide && !P.grounded && INP.jump && P.vy < -0.5)); };

