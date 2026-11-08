// ---- shockwave rings (linear radius so they match the hit test in the core), enemy projectiles (instanced), spore clouds ---------------------------------------------------------------------------------------------------------
const WAVEG = new THREE.RingGeometry(0.9, 1, 64).rotateX(-PI / 2), WAVES = []; for (let i = 0; i < 4; i++) { const m = new THREE.Mesh(WAVEG, decMat(0.8, true)); m.visible = false; m.frustumCulled = false; m.renderOrder = 17; scene.add(m); WAVES.push({ m, on: false, x: 0, y: 0, z: 0, r: 0, spd: 0, max: 20, col: '#ffffff' }); }
function mobWave(x, y, z, spd, max, col) { const w = WAVES.find(q => !q.on) || WAVES[0]; w.on = true; w.x = x; w.y = y + 0.18; w.z = z; w.r = 0.5; w.spd = spd; w.max = max; w.col = col; w.m.visible = true; }
const NMP = 24, MPJ = [], mpjMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 8, 6), new THREE.MeshBasicMaterial({ fog: false, toneMapped: false }), NMP); mpjMesh.frustumCulled = false; mpjMesh.count = 0; mpjMesh.visible = false; mpjMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(NMP * 3), 3); scene.add(mpjMesh);
for (let i = 0; i < NMP; i++) MPJ.push({ on: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, dmg: 1, src: null, lob: false, T: 0, t: 0, tx: 0, tz: 0, ty: 0, r: 2, cloud: 0, col: '#ff9a4a', sc: 1 });
const CLOUDG = new THREE.CircleGeometry(1, 40).rotateX(-PI / 2), CLOUDS = []; for (let i = 0; i < 5; i++) { const m = new THREE.Mesh(CLOUDG, decMat(0.3)); m.visible = false; m.frustumCulled = false; m.renderOrder = 15; scene.add(m); CLOUDS.push({ m, on: false, x: 0, y: 0, z: 0, r: 2, t: 0, dur: 3, tick: 0, dmg: 0.3, src: null, col: '#b8e86a' }); }
function mobCloud(x, y, z, r, dur, dmg, src, col) { const c = CLOUDS.find(q => !q.on) || CLOUDS[0]; c.on = true; c.x = x; c.y = y + 0.14; c.z = z; c.r = r; c.t = 0; c.dur = dur; c.tick = 0.3; c.dmg = dmg; c.src = src; c.col = col || '#b8e86a'; c.m.visible = true; }
function mobShoot(e, ev) {
  const R = e.rpg, p = MPJ.find(q => !q.on); if (!p) return; const hy = e.y + 0.9 * (e.mesh.scale.y || 1), mk = ev.dmg || 1; p.on = true; p.src = e; p.x = ev.x; p.y = hy; p.z = ev.z; p.dmg = mk; p.col = ev.col || '#ff9a4a'; p.lob = !!ev.lob; p.t = 0; p.sc = ev.lob ? 1.6 : 1;
  if (ev.lob) { p.T = ev.flight || 0.9; p.tx = ev.tx; p.tz = ev.tz; p.ty = floorAt(ev.tx, ev.tz, e.y + 4); if (!(p.ty > -1e8)) p.ty = e.fy; p.vx = (p.tx - p.x) / p.T; p.vz = (p.tz - p.z) / p.T; p.vy = ((p.ty + 0.3 - p.y) + 0.5 * 22 * p.T * p.T) / p.T; p.r = ev.r || 2.4; p.cloud = ev.cloud || 0; p.life = p.T + 0.5; msfx('lob'); }
  else { p.vx = Math.sin(ev.ang) * ev.spd; p.vz = Math.cos(ev.ang) * ev.spd; p.vy = 0; p.life = ev.ring ? 3.2 : 3.0; p.cloud = 0; p.r = 0; msfx('zap'); }
}
function mobHurtHero(e, mult, kb, sx, sz) {
  if (P.dead || P.invuln > 0 || G.trans || !e.rpg) return false; RT.curEnemy = e; RT.dmgOverride = e.rpg.dmg * mult; hurtHero(sx != null ? sx : e.x, sz != null ? sz : e.z); RT.curEnemy = null;
  if (kb > 7) { const dx = P.x - (sx != null ? sx : e.x), dz = P.z - (sz != null ? sz : e.z), l = hyp2(dx, dz) + 0.01; P.vx += dx / l * (kb - 7) * 0.7; P.vz += dz / l * (kb - 7) * 0.7; } return true;
}
function mobFxFrame(rdt, sdt) {
  if (G.state !== 'play') { if (G.state === 'menu' || G.state === 'dead') mobClearFx(); return; } const t = U.time.value;
  for (let i = TELLS.length - 1; i >= 0; i--) mobTellUpdate(TELLS[i], sdt);
  for (const w of WAVES) { if (!w.on) continue; w.r += w.spd * sdt; if (w.r > w.max) { w.on = false; w.m.visible = false; continue; } w.m.position.set(w.x, w.y, w.z); w.m.scale.set(w.r, 1, w.r); decColor(w.m, w.col, 2.4, 0.9 * (1 - w.r / w.max), true); }
  // projectiles
  let n = 0; for (const p of MPJ) {
    if (!p.on) continue; p.t += sdt; p.life -= sdt; if (p.lob) p.vy -= 22 * sdt; p.x += p.vx * sdt; p.y += p.vy * sdt; p.z += p.vz * sdt; let dead = false;
    if (p.lob) { if (p.t >= p.T) { dead = true; mobLand(p); } } else { if (!P.dead && hyp2(P.x - p.x, P.z - p.z) < 0.8 && Math.abs(P.y + 0.9 - p.y) < 1.1) { if (p.src && p.src.alive) mobHurtHero(p.src, p.dmg, 5, p.x - p.vx, p.z - p.vz); dead = true; sparkBurst(p.x, p.y, p.z, 7, hexNum(p.col), 4); } else if (p.life <= 0 || solidPoint(p.x, p.y, p.z)) { dead = true; sparkBurst(p.x, p.y, p.z, 5, hexNum(p.col), 3); } }
    if (p.life <= 0 && !dead) dead = true; if (dead) { p.on = false; continue; }
    if (Math.random() < 0.5) puff(p.x, p.y, p.z, 1, 0.35, hexNum(p.col), 0.3, 0, 0.35);
    _mI.makeScale(p.sc * (1 + Math.sin(t * 20 + n) * 0.12), p.sc, p.sc * (1 + Math.sin(t * 20 + n) * 0.12)); _mI.setPosition(p.x, p.y, p.z); mpjMesh.setMatrixAt(n, _mI); _mC.set(p.col); mpjMesh.setColorAt(n, _mC.multiplyScalar(2.2)); n++;
  }
  mpjMesh.count = n; mpjMesh.visible = n > 0; if (n > 0) { mpjMesh.instanceMatrix.needsUpdate = true; mpjMesh.instanceColor.needsUpdate = true; }
  for (const c of CLOUDS) { if (!c.on) continue; c.t += sdt; if (c.t > c.dur) { c.on = false; c.m.visible = false; continue; } const k = c.t < 0.3 ? c.t / 0.3 : c.t > c.dur - 0.5 ? (c.dur - c.t) / 0.5 : 1; c.m.position.set(c.x, c.y, c.z); c.m.scale.set(c.r * (0.9 + 0.1 * Math.sin(t * 3)), 1, c.r); decColor(c.m, c.col, 1.3, 0.34 * k); if (Math.random() < 0.18) puff(c.x + (Math.random() - 0.5) * c.r * 1.4, c.y + 0.2, c.z + (Math.random() - 0.5) * c.r * 1.4, 1, 0.9, hexNum(c.col), 0.2, 0.9, 1.4);
    c.tick -= sdt; if (c.tick <= 0) { c.tick = 0.5; if (!P.dead && hyp2(P.x - c.x, P.z - c.z) < c.r && P.y - c.y < 1.6 && c.src && c.src.alive !== undefined) { RT.curEnemy = c.src; RT.dmgOverride = (c.src.rpg ? c.src.rpg.dmg : 20) * c.dmg; hurtHero(c.x, c.z); RT.curEnemy = null; } } }
}
function mobLand(p) {
  const e = p.src, fy = p.ty; sparkBurst(p.x, fy + 0.3, p.z, 12, hexNum(p.col), 5); fxRing(p.x, fy, p.z, 0.3, p.r, 0.4, hexNum(p.col), 0.9, true); puff(p.x, fy + 0.2, p.z, 8, 1.2, hexNum(p.col), 2.5, -1, 0.8); msfx('splat'); camShake(0.1);
  if (e && e.alive && !P.dead && hyp2(P.x - p.x, P.z - p.z) < p.r + 0.3 && P.y - fy < 1.4) mobHurtHero(e, p.dmg, 6, p.x, p.z);
  if (p.cloud > 0 && e) mobCloud(p.x, fy, p.z, p.r * 0.9, p.cloud, 0.3, e, p.col);
}
function mobClearFx() { for (const T of TELLS.slice()) mobTellKill(T); for (const w of WAVES) { w.on = false; w.m.visible = false; } for (const p of MPJ) p.on = false; mpjMesh.count = 0; mpjMesh.visible = false; for (const c of CLOUDS) { c.on = false; c.m.visible = false; } MOBX.boss = null; }
