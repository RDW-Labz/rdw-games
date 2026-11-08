// ---- enemies: walker (mushroom-ish) and shell (turtle-ish) ------------------------------------------------------------------
const ENEMIES = [];
const wBody = hv(0x7a4420), wCap = new THREE.MeshStandardMaterial({ color: 0xa5602d, roughness: 0.6, emissive: 0x2a1408, emissiveIntensity: 0.4 }), wFoot = hv(0x2a160a), wSkin = hv(0xf4dcb0), wShell = new THREE.MeshStandardMaterial({ color: 0x2faa4a, roughness: 0.4, emissive: 0x0a3010, emissiveIntensity: 0.4 }), wBelly = hv(0xf0d880), wEye = hv(0xffffff), wPupil = hv(0x101010);
function buildWalker() {
  const g = new THREE.Group(); const body = new THREE.Group(); g.add(body);
  part(body, HEMI, wCap, 0, 0.32, 0, 0.5, 0.46, 0.5, 0.06); part(body, CYL, wSkin, 0, 0.18, 0, 0.3, 0.26, 0.3, 0.05); part(body, SPH, wFoot, -0.17, 0.05, 0.08, 0.16, 0.1, 0.22, 0.05); part(body, SPH, wFoot, 0.17, 0.05, 0.08, 0.16, 0.1, 0.22, 0.05);
  for (const s of [-1, 1]) { part(body, SPH, wEye, s * 0.11, 0.26, 0.25, 0.07, 0.09, 0.05, 0); part(body, SPH, wPupil, s * 0.11, 0.25, 0.3, 0.03, 0.045, 0.02, 0); const br = part(body, SPH, wPupil, s * 0.12, 0.37, 0.26, 0.11, 0.03, 0.04, 0); br.rotation.z = s * -0.45; }
  g.traverse(o => { if (o.isMesh) { o.frustumCulled = false; } }); return { g, body };
}
function buildShell() {
  const g = new THREE.Group(); const body = new THREE.Group(); g.add(body);
  part(body, HEMI, wShell, 0, 0.18, -0.02, 0.5, 0.44, 0.52, 0.06); part(body, CYL, wBelly, 0, 0.17, -0.02, 0.5, 0.1, 0.52, 0.05); part(body, SPH, wSkin, 0, 0.5, 0.32, 0.17, 0.2, 0.17, 0.05); part(body, SPH, wEye, 0.07, 0.56, 0.45, 0.045, 0.06, 0.03, 0); part(body, SPH, wEye, -0.07, 0.56, 0.45, 0.045, 0.06, 0.03, 0); part(body, SPH, wFoot, -0.2, 0.06, 0.1, 0.12, 0.1, 0.16, 0.04); part(body, SPH, wFoot, 0.2, 0.06, 0.1, 0.12, 0.1, 0.16, 0.04);
  for (let i = 0; i < 6; i++) { const a = i * TAU / 6; part(body, SPH, hv(0x7be08a), Math.cos(a) * 0.3, 0.38, Math.sin(a) * 0.3 - 0.02, 0.12, 0.05, 0.12, 0); }
  g.traverse(o => { if (o.isMesh) o.frustumCulled = false; }); return { g, body };
}
function addEnemy(spec) {
  const m = spec.type === 'shell' ? buildShell() : buildWalker(); m.g.scale.setScalar(1.3); m.g.position.set(spec.x, spec.y, spec.z); scene.add(m.g); if (VR.merge) vrMergeApply(m.g, true);
  const e = { type: spec.type, x: spec.x, y: spec.y, z: spec.z, hx: spec.x, hz: spec.z, r: spec.r || 3, dir: Math.random() < 0.5 ? 1 : -1, ang: Math.random() * TAU, vy: 0, state: 'walk', t: 0, mesh: m.g, body: m.body, alive: true, ceil: !!spec.ceil, kx: 0, kz: 0, h: 0.8, ph: Math.random() * 6 };
  if (e.ceil) { m.g.rotation.z = PI; } ENEMIES.push(e); return e;
}
function killEnemy(e, kind, srcx, srcz) {
  if (!e.alive || e.state === 'dead') return; if (kind === 'stomp' && e.type === 'walker') { e.state = 'squash'; e.t = 0; sfx('stomp'); sparkBurst(e.x, e.y + 0.3, e.z, 8, 0xffe090, 3); }
  else if (kind === 'stomp' && e.type === 'shell' && e.state !== 'shell') { e.state = 'shell'; e.t = 0; e.sh = 0; sfx('stomp'); }
  else { e.state = 'dead'; e.t = 0; const dx = e.x - srcx, dz = e.z - srcz, l = Math.hypot(dx, dz) + 0.01; e.vx2 = dx / l * 6; e.vz2 = dz / l * 6; e.vy = 9; sfx('kick'); sparkBurst(e.x, e.y + 0.4, e.z, 10, 0xffe090, 5); }
  G.score += 100; heroHitstop(0.05);
}
function heroHitstop(t) { G.hitstop = Math.max(G.hitstop, t); }
function updateEnemies(dt, t) {
  for (const e of ENEMIES) {
    if (!e.alive) continue; e.t += dt;
    if (e.state === 'squash') { e.body.scale.y = 0.18; if (e.t > 0.7) { e.alive = false; e.mesh.visible = false; } continue; }
    if (e.state === 'dead') { e.vy -= 30 * dt; e.x += e.vx2 * dt; e.z += e.vz2 * dt; e.y += e.vy * dt; e.mesh.rotation.x += dt * 9; e.mesh.position.set(e.x, e.y, e.z); if (e.t > 1.6 || e.y < -80) { e.alive = false; e.mesh.visible = false; } continue; }
    const spd = (e.type === 'shell' ? (e.state === 'slide' ? 11 : e.state === 'shell' ? 0 : 1.2) : 1.6) * (e.spdMul || 1); // rpg: elite / brute speed
    if (e.state === 'shell') { e.sh += dt; e.body.scale.set(1, 0.7, 1); if (e.sh > 5) { e.state = 'walk'; e.body.scale.set(1, 1, 1); } }
    if (e.state === 'walk' || e.state === 'slide') {
      let ax = Math.sin(e.ang) * e.dir, az = Math.cos(e.ang) * e.dir; if (e.state === 'slide') { ax = e.kx; az = e.kz; }
      const nx = e.x + ax * spd * dt, nz = e.z + az * spd * dt;
      if (e.ceil) { e.x = nx; e.z = nz; if (Math.hypot(e.x - e.hx, e.z - e.hz) > e.r) { e.dir = -e.dir; } }
      else {
        const f0 = floorAt(nx + ax * 0.45, nz + az * 0.45, e.y + 0.9), fN = floorAt(nx, nz, e.y + 0.9);
        const edge = f0 < -1e8 || f0 < e.y - 1.1, wall = fN > e.y + 0.55;
        if ((edge && e.state === 'walk') || wall || (e.state === 'walk' && Math.hypot(nx - e.hx, nz - e.hz) > e.r)) { if (e.state === 'slide') { e.kx = -e.kx; e.kz = -e.kz; sfx('bonk'); } else e.dir = -e.dir; }
        else { e.x = nx; e.z = nz; }
        const f = floorAt(e.x, e.z, e.y + 0.6); if (f > -1e8 && e.y <= f + 0.02) { e.y = f; e.vy = 0; } else { e.vy -= 30 * dt; e.y += e.vy * dt; if (f > -1e8 && e.y < f) { e.y = f; e.vy = 0; } }
        if (e.y < -90) { e.alive = false; e.mesh.visible = false; }
      }
    }
    e.mesh.position.set(e.x, e.y, e.z); e.mesh.rotation.y = e.state === 'slide' ? e.mesh.rotation.y + dt * 14 : Math.atan2(Math.sin(e.ang) * e.dir, Math.cos(e.ang) * e.dir) * 0 + e.ang * 0 + Math.atan2(Math.sin(e.ang) * e.dir, Math.cos(e.ang) * e.dir);
    if (e.state === 'walk') { e.body.position.y = Math.abs(Math.sin(t * 7 + e.ph)) * 0.06; e.body.rotation.z = Math.sin(t * 7 + e.ph) * 0.1; }
    // slide kills other enemies
    if (e.state === 'slide') for (const o of ENEMIES) if (o !== e && o.alive && o.state === 'walk' && Math.hypot(o.x - e.x, o.z - e.z) < 0.9 && Math.abs(o.y - e.y) < 1) killEnemy(o, 'kick', e.x, e.z);
    // hero contact
    if (G.state === 'play' && !P.dead && e.state !== 'dead') heroVsEnemy(e);
  }
}
function heroVsEnemy(e) {
  const dx = e.x - P.x, dz = e.z - P.z, dh = Math.hypot(dx, dz), same = (GF > 0) !== e.ceil; const ge = e.ceil ? -e.y : e.y;
  const hy = GF > 0 ? P.y : P.gy; const dy = same ? (hy - ge) : (e.y - P.y);
  if (dh > 0.85 * P.size + 0.1) return; if (!same ? Math.abs(P.y - e.y) > 1.7 : Math.abs(hy - ge) > 1.6) return;
  if (e.state === 'shell') { // kick a resting shell
    if (e.kickLock > 0) { e.kickLock -= 0.01; return; } if (dh < 0.9) { const l = dh + 0.001; e.state = 'slide'; e.kx = -dx / l * 0 + (dx / l); e.kz = dz / l; if (dh < 0.01) { e.kx = Math.sin(P.yaw); e.kz = Math.cos(P.yaw); } e.kickLock = 0.5; e.t = 0; sfx('kick'); heroKick(hero, 5); return; } return;
  }
  if (same && P.vy < -1 && dy > 0.5 * e.h) { killEnemy(e, 'stomp'); P.vy = INP.jump ? 15.5 : 10.5; P.grounded = false; P.airKind = 'jump'; P.act = 'air'; heroKick(hero, 8); return; }
  if (P.act === 'dive' || P.act === 'slide' || P.act === 'pound' || (P.act === 'punch' && P.punchT > 0)) { killEnemy(e, 'kick', P.x, P.z); return; }
  if (e.state === 'slide' && e.t < 0.35) return;
  hurtHero(e.x, e.z);
}
function doPunch() { // melee hitbox in front of the hero
  const f = P.yaw, rx = P.x + Math.sin(f) * 1.0, rz = P.z + Math.cos(f) * 1.0; let hit = false;
  for (const e of ENEMIES) if (e.alive && e.state !== 'dead' && e.state !== 'squash' && Math.hypot(e.x - rx, e.z - rz) < TUNING.punch.reach * 0.8 && Math.abs(e.y - P.y) < 1.6) { if (e.state === 'shell') { e.state = 'slide'; e.kx = Math.sin(f); e.kz = Math.cos(f); e.kickLock = 0.5; sfx('kick'); } else killEnemy(e, 'kick', P.x, P.z); hit = true; }
  for (const b of BLOCKS) if (!b.used && Math.hypot(b.x - rx, b.z - rz) < 1.2 && Math.abs(b.y - (P.y + 1)) < 1.0) { bumpBlock(b); hit = true; }
  for (const t of TREES) if (t.alive && t.type !== 'pine' && Math.hypot(t.x - rx, t.z - rz) < 1.0 && Math.abs(t.y - P.y) < 3) { /* trunks shrug off a punch; ground-pound them */ }
  if (hit) { heroHitstop(0.06); camShake(0.25); }
}
function doPound() { // ground pound: shockwave, local shatter of nearby props, bumps enemies
  const R = TUNING.pound.radius; sfx('pound'); camShake(0.9); heroHitstop(0.07); sparkBurst(P.x, P.y + 0.2, P.z, 22, 0xfff0c0, 7); puff(P.x, P.y + 0.1, P.z, 14, 1.6, 0xd8c8a0, 5, -1, 0.9);
  for (const e of ENEMIES) if (e.alive && e.state !== 'dead' && e.state !== 'squash' && Math.hypot(e.x - P.x, e.z - P.z) < R && Math.abs(e.y - P.y) < 2.2) { if (e.state === 'shell') { e.state = 'walk'; e.sh = 6; } killEnemy(e, 'kick', P.x, P.z); }
  if (G.act === 1) {
    let n = 0; for (const t of TREES) if (t.alive && TREE_MESH[t.type].visible && Math.hypot(t.x - P.x, t.z - P.z) < R && n < 3) { shatterTree(t, P.x, P.z, 6); n++; }
    for (const r of ROCKS) if (r.alive && Math.hypot(r.x - P.x, r.z - P.z) < R * 0.8 && n < 5) { shatterRock(r, P.x, P.z, 6); n++; }
    for (const p of PIECES) if (p.alive && Math.hypot(p.x - P.x, p.z - P.z) < R && n < 7) { shatterPiece(p, P.x, P.z, 6); n++; }
  }
  if (LV) { // crumble bridge planks under / near the hero
    for (const g of LV.groups) if (g && !g.broken && g.cubes.length) { let near = false; for (const c of g.cubes) { if (C.st[c] === ST.SET && Math.hypot(C.x[c] - P.x, C.z[c] - P.z) < R * 0.55 && Math.abs(C.y[c] - P.y) < 2.5) { near = true; break; } } if (near) breakGroup(g); }
  }
}
function breakGroup(g) {
  g.broken = true; const id = 400000 + g.id; const grp = { id, need: g.cubes.length, back: 0, done: false, cubes: g.cubes.slice(), restore: () => { for (const c of g.cubes) { if (C.owner[c] !== id) continue; C.x[c] = C.tx[c]; C.y[c] = C.ty[c]; C.z[c] = C.tz[c]; C.vx[c] = C.vy[c] = C.vz[c] = 0; C.qx[c] = C.qy[c] = C.qz[c] = 0; C.qw[c] = 1; C.st[c] = ST.SET; C.owner[c] = -1; C.rew[c] = 0; vgSet(Math.floor(C.tx[c]), Math.floor(C.ty[c]), Math.floor(C.tz[c]), 1); writeCube(c); cubesDirty = true; } g.broken = false; HOMEG.delete(id); } }; HOMEG.set(id, grp);
  for (const c of g.cubes) { if (C.st[c] === ST.FREE) continue; vgSet(Math.floor(C.tx[c]), Math.floor(C.ty[c]), Math.floor(C.tz[c]), 0); C.st[c] = ST.BALL; C.owner[c] = id; C.hx[c] = C.tx[c]; C.hy[c] = C.ty[c]; C.hz[c] = C.tz[c]; C.vx[c] = (Math.random() - 0.5) * 3; C.vz[c] = (Math.random() - 0.5) * 3; C.vy[c] = 1 + Math.random() * 3; C.wx[c] = (Math.random() - 0.5) * 8; C.wy[c] = (Math.random() - 0.5) * 8; C.wz[c] = (Math.random() - 0.5) * 8; C.glow[c] = 0.4; C.delay[c] = 0; C.rew[c] = 0; }
  CS.grav = 22; CS.drag = 0; sfx('shatter_small'); camShake(0.5); toast('Hold RMB to rewind the bridge');
}
function hurtHero(sx, sz) {
  if (P.invuln > 0 || P.dead || G.trans) return; sfx('hurt'); G.flashRed = 0.5;
  if (P.big) { P.big = false; } else { P.hp--; }
  P.invuln = TUNING.invuln; P.hurtT = 0.45; const dx = P.x - sx, dz = P.z - sz, l = Math.hypot(dx, dz) + 0.01; P.vx = dx / l * 7; P.vz = dz / l * 7; P.vy = 9; P.grounded = false; setAct('air'); P.airKind = 'hurt'; heroKick(hero, 12); camShake(0.5); updateHUD();
  if (P.hp <= 0) killHero('hits');
}

