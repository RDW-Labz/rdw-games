// ---- chests + crates (new breakables / interactables) -------------------------------------------------------------------------------------------------------
const CHESTS = [], CRATES = [], rpWoodMat = hv(0x8a5a2b), trimMat = new THREE.MeshStandardMaterial({ color: 0xffc830, metalness: 0.8, roughness: 0.3, emissive: 0x8a5a00, emissiveIntensity: 0.4 }), crateTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); g.fillStyle = '#b07a3e'; g.fillRect(0, 0, 64, 64); g.strokeStyle = '#6a4420'; g.lineWidth = 4; g.strokeRect(2, 2, 60, 60); g.lineWidth = 3; g.beginPath(); g.moveTo(4, 4); g.lineTo(60, 60); g.moveTo(60, 4); g.lineTo(4, 60); g.stroke(); g.strokeStyle = 'rgba(0,0,0,.18)'; g.lineWidth = 1; for (let y = 16; y < 64; y += 16) { g.beginPath(); g.moveTo(4, y); g.lineTo(60, y); g.stroke(); } const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
const crateMat = new THREE.MeshStandardMaterial({ map: crateTex, roughness: 0.8 }), crateGeo = new THREE.BoxGeometry(0.86, 0.86, 0.86);
function buildChest(big) {
  const g = new THREE.Group(), s = big ? 1.3 : 1; const base = part(g, CYL, rpWoodMat, 0, 0.26 * s, 0, 0.5 * s, 0.26 * s, 0.34 * s, 0); base.geometry = new THREE.BoxGeometry(1, 1, 1); base.scale.set(0.9 * s, 0.5 * s, 0.6 * s); base.position.y = 0.25 * s;
  const lid = new THREE.Group(); lid.position.set(0, 0.5 * s, -0.3 * s); g.add(lid); const lm = new THREE.Mesh(new THREE.CylinderGeometry(0.3 * s, 0.3 * s, 0.9 * s, 12, 1, false, 0, PI).rotateZ(PI / 2), rpWoodMat); lm.position.set(0, 0, 0.3 * s); lm.castShadow = true; lid.add(lm);
  const vg = g.userData.vrp || (g.userData.vrp = []), vl = lid.userData.vrp || (lid.userData.vrp = []); vl.push(lm); // vrp: baked into one mesh per group while presenting (VR draw-call diet)
  for (const x of [-0.3, 0.3]) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.1 * s, 0.56 * s, 0.64 * s), trimMat); b.position.set(x * s, 0.24 * s, 0); g.add(b); vg.push(b); const t = new THREE.Mesh(new THREE.CylinderGeometry(0.31 * s, 0.31 * s, 0.1 * s, 12, 1, false, 0, PI).rotateZ(PI / 2), trimMat); t.position.set(x * s, 0, 0.3 * s); lid.add(t); vl.push(t); }
  const lock = new THREE.Mesh(new THREE.BoxGeometry(0.14 * s, 0.16 * s, 0.06 * s), trimMat); lock.position.set(0, 0.46 * s, 0.32 * s); g.add(lock); vg.push(lock);
  g.traverse(o => { if (o.isMesh) o.frustumCulled = false; }); return { g, lid };
}
function rpgAddChest(x, y, z, act, tag) { if (RT.runFlags['c' + tag]) return; const m = buildChest(act); m.g.position.set(x, y, z); m.g.rotation.y = Math.random() * TAU; scene.add(m.g); if (VR.merge) vrMergeApply(m.g, true); let beam = null; if (act) { beam = new THREE.Mesh(LOOT_GEO.beam, LOOT_BEAM[2]); beam.scale.set(1.2, 34, 1.2); m.g.add(beam); } CHESTS.push({ x, y, z, act, tag, open: false, t: 0, g: m.g, lid: m.lid, beam }); }
function rpgAddCrate(x, y, z, tag) { if (RT.runFlags['k' + tag]) return; const m = new THREE.Mesh(crateGeo, crateMat); m.position.set(x, y + 0.43, z); m.rotation.y = Math.random() * TAU; m.castShadow = true; m.receiveShadow = true; scene.add(m); CRATES.push({ x, y, z, tag, m, alive: true }); }
function rpgOpenChest(c) {
  c.open = true; c.t = 0; RT.runFlags['c' + c.tag] = 1; rsfx('chest'); if (c.beam) { c.g.remove(c.beam); c.beam = null; } sparkBurst(c.x, c.y + 0.7, c.z, 20, 0xffd040, 6); fxRing(c.x, c.y, c.z, 0.4, 4, 0.7, 0xffd66b, 0.8); camShake(0.2);
  const mlvl = rpgMonsterLevel({ act: G.act, diff: rpgDiffIdx(), idx: 2, rift: RIFT ? RIFT.tier : 0 }); rpgDrops(c.act ? 'actchest' : 'chest', c.x, c.y + 0.6, c.z, mlvl); rpgGainXp(rpgObjectiveXp('chest', mlvl, rpgDiffIdx(), RP.level), 'chest'); floatText(c.x, c.y + 1.6, c.z, c.act ? 'ACT CHEST' : 'CHEST', 'gold');
}
function rpgBreakCrate(k, bounce) {
  k.alive = false; scene.remove(k.m); RT.runFlags['k' + k.tag] = 1; rsfx('crate'); fxChunks(k.x, k.y + 0.5, k.z, 12, 0xb07a3e, 0.2, 5, k.y); puff(k.x, k.y + 0.4, k.z, 6, 1, 0xd8c8a0, 2); camShake(0.1);
  const mlvl = rpgMonsterLevel({ act: G.act, diff: rpgDiffIdx(), idx: 1, rift: RIFT ? RIFT.tier : 0 }); rpgDrops('crate', k.x, k.y + 0.4, k.z, mlvl); rpgGainXp(rpgObjectiveXp('crate', mlvl, rpgDiffIdx(), RP.level), 'crate');
  if (bounce) { P.vy = INP.jump ? 14 : 9.5; P.grounded = false; }
}
function rpgPropsTick(dt) {
  const px = P.x, pz = P.z, py = P.y, atk = P.act, melee = atk === 'punch' || atk === 'dive' || atk === 'slide' || atk === 'pound' || atk === 'pound_land' || atk === 'long';
  for (const c of CHESTS) {
    if (c.open) { c.t += dt; c.lid.rotation.x = -Math.min(1.9, c.t * 6) * (1 - 0.06 * Math.sin(c.t * 9)); continue; }
    c.g.position.y = c.y + (c.act ? Math.sin(U.time.value * 2) * 0.03 : 0); if (Math.hypot(px - c.x, pz - c.z) < 1.9 && Math.abs(py - c.y) < 2.0) rpgOpenChest(c);
  }
  for (let i = CRATES.length - 1; i >= 0; i--) { const k = CRATES[i]; if (!k.alive) { CRATES.splice(i, 1); continue; } const d = Math.hypot(px - k.x, pz - k.z), dy = py - k.y;
    if (melee && d < (atk === 'pound' || atk === 'pound_land' ? TUNING.pound.radius * 0.7 : TUNING.punch.reach + 0.5) && Math.abs(dy) < 1.8) rpgBreakCrate(k, false);
    else if (!P.grounded && P.vy < -1.5 && d < 1.0 && dy > 0.5 && dy < 1.7) rpgBreakCrate(k, true); }
}
function rpgClearProps() { for (const c of CHESTS) scene.remove(c.g); CHESTS.length = 0; for (const k of CRATES) scene.remove(k.m); CRATES.length = 0; for (const L of LOOT.slice()) rpgFree(L); }
function rpgVacuum() { // nothing the hero earned is ever lost to a death / act change: every pile on the ground is collected (bag-full commons auto-salvage)
  for (const L of LOOT.slice()) { if (L.kind === 'item' && rpgBagFree() < 0 && L.item.rarity !== 'common') { const d = rpgSalvageValue(L.item, RT.S.dustFind); RP.dust += d; RUN.dust += d; rpgFree(L); continue; } rpgPickupLoot(L, true); }
}

