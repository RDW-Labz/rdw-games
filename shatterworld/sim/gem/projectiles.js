// ---- projectile update --------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const _pc3 = new THREE.Color();
function pjImpact(p, e) { // what happens when a projectile touches an enemy (or the world when e = null)
  const R = p.R, el = p.elem, x = p.x, y = p.y, z = p.z;
  if (p.kind === 1 || p.kind === 4) { gsfx('gcubehit', 1); fxChunks(x, y, z, p.kind === 1 ? 9 : 5, p.kind === 1 ? 0x9fbbd8 : 0xff8a3c, p.kind === 1 ? 0.2 : 0.12, 5, y - 0.4); sparkBurst(x, y, z, 6, VCOL[el] || 0xffe090, 4); fxRing(x, y - 0.3, z, 0.2, 1.6, 0.3, VCOL[el], 0.7); if (p.kind === 1 && R.area > 1.05) rpgAoE(x, y, z, p.rad * R.area, R.hit * 0.45 * p.mul, 'skill', e); }
  else if (p.kind === 2) { gemBloom(p, true); }
  else if (p.kind === 5) { gemMeteorHit(p); }
  else if (p.kind === 3 && e) { sparkBurst(x, y, z, 6, 0xffd45a, 4); fxRing(x, y - 0.2, z, 0.2, 1.4, 0.25, VCOL.sun, 0.8); }
  if (e) {
    gemStrike(R, e, p.mul, p.ox, p.oz, p.kind === 5 ? 0 : 6);
    if (p.chain > 0 && p.kind !== 2 && p.kind !== 3) gemChain(R, e, p.chain, p.mul, el);
    if (R.pull > 0) gemPull(x, z, 4, R.pull);
  }
}
function pjFork(p, e) { const R = p.R; p.forked = true; const base = Math.atan2(p.vx, p.vz), n = p.fork; for (let k = 0; k < n; k++) { const a = base + (k - (n - 1) / 2) * 0.5, q = pjSpawn(p.kind, R, p.x, p.y, p.z, Math.sin(a) * p.spd, p.vy, Math.cos(a) * p.spd, p.mul * 0.8, { rad: p.rad, sc: p.sc * 0.8, forked: true, life: 1.2, pierce: 0, chain: 0, fork: 0, ox: p.x, oz: p.z }); if (q) pjAddHit(q, e); } }
function gemBloom(p, big) { // a Cinder Bloom orb blooming: flame petals + a small ground burst
  const R = p.R, rad = (big ? p.rad : p.rad * 0.6) * R.area, x = p.x, z = p.z, f = floorAt(x, z, p.y + 1); const gy = f > -1e8 ? f : p.y - 0.4; gsfx('gbloom'); fxRing(x, gy, z, 0.3, rad, big ? 0.45 : 0.3, VCOL.ember, 0.9, true); fxRing(x, gy, z, 0.2, rad * 0.6, 0.3, 0xffe0a0, 0.8);
  for (let k = 0; k < (big ? 7 : 4); k++) { const a = k / (big ? 7 : 4) * TAU + Math.random() * 0.4; pt(x, gy + 0.2, z, Math.cos(a) * 3.2, 2.5 + Math.random() * 2, Math.sin(a) * 3.2, 0.7, 0.9, -5, vcol('ember', 1)); }
  sparkBurst(x, gy + 0.4, z, big ? 14 : 6, 0xff9a3c, 6); if (big) camShake(0.15);
  for (const o of ENEMIES) { if (!gemOk(o) || Math.hypot(o.x - x, o.z - z) > rad || Math.abs(o.y - gy) > 3) continue; gemStrike(R, o, p.mul * (big ? 1 : 0.55), x, z, big ? 5 : 2); }
}
function pjFinish(m, n) { m.count = n; if (m.visible !== (n > 0)) m.visible = n > 0; if (n > 0) { m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true; } }
function pjUpdate(dt) {
  let nc = 0, no = 0, ns = 0; if (!PJM.cube.visible && !PJM.orb.visible && !PJM.shard.visible) { let any = false; for (let i = 0; i < PJN; i++) if (PJ[i].on) { any = true; break; } if (!any) return; }
  for (let i = 0; i < PJN; i++) {
    const p = PJ[i]; if (!p.on) continue; p.t += dt; p.life -= dt; p.rot += dt * 9; let dead = false;
    if (p.kind === 1 || p.kind === 4) { // cube / bolt: slight arc, stops on a wall or an enemy
      p.vy -= (p.kind === 1 ? 6 : 1.5) * dt; const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, nz = p.z + p.vz * dt; if (solidPoint(nx, ny, nz)) { pjImpact(p, null); dead = true; } else { p.x = nx; p.y = ny; p.z = nz; p.dist += p.spd * dt; if (p.dist > p.R.p.range || p.life <= 0) { pjImpact(p, null); dead = true; } }
    } else if (p.kind === 2) { // orb: bounces along the floor, blooms on contact
      p.vy -= 26 * dt; p.x += p.vx * dt; p.z += p.vz * dt; p.y += p.vy * dt; const f = floorAt(p.x, p.z, p.y + 1.2), gy = f > -1e8 ? f : -1e9; if (gy > -1e8 && p.y < gy + 0.45 && p.vy < 0) { p.y = gy + 0.45; p.vy = 7.2; p.bounces--; if (p.bounces < 0) { gemBloom(p, true); dead = true; } else gemBloom(p, false); }
      if (solidPoint(p.x + Math.sign(p.vx) * 0.5, p.y, p.z + Math.sign(p.vz) * 0.5) && !dead) { p.vx = -p.vx * 0.6; p.vz = -p.vz * 0.6; } if (p.life <= 0 && !dead) { gemBloom(p, true); dead = true; }
      if (!dead) for (const o of ENEMIES) { if (!gemOk(o) || o.y - p.y > 2 || p.y - o.y > 2.2) continue; const dx = o.x - p.x, dz = o.z - p.z; if (dx * dx + dz * dz < 1.0) { gemBloom(p, true); dead = true; break; } }
    } else if (p.kind === 3) { // shard boomerang
      const px = p.x, pz = p.z; if (p.phase === 0) { p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.dist += p.spd * dt; if (p.dist > p.R.p.range || solidPoint(p.x, p.y, p.z)) { p.phase = 1; p.hitN = 0; gsfx('gboom'); } }
      else { const tx = P.x, ty = P.y + 1.0, tz = P.z, dx = tx - p.x, dy = ty - p.y, dz = tz - p.z, d = Math.hypot(dx, dy, dz) + 1e-4, sp = p.R.p.back; p.x += dx / d * sp * dt; p.y += dy / d * sp * dt; p.z += dz / d * sp * dt; if (d < 1.1) { dead = true; gsfx('gcatch'); sparkBurst(P.x, P.y + 1, P.z, 8, 0xffd45a, 4); heroKick(hero, 5); } }
      // scoop loot + coins along the way
      const mg = p.R.p.magnet * p.R.area; for (let k = LOOT.length - 1; k >= 0; k--) { const L = LOOT[k], dx = L.x - p.x, dz = L.z - p.z; if (dx * dx + dz * dz < mg * mg && Math.abs(L.y - p.y) < 3) rpgPickupLoot(L); } for (const c of COINS) if (c.alive && !c.pop) { const dx = c.x - p.x, dz = c.z - p.z; if (dx * dx + dz * dz < mg * mg && Math.abs(c.y - p.y) < 3) collectCoin(c); }
      if (!dead && Math.random() < 0.7) pt(p.x, p.y, p.z, (Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5), 0.35, 0.5, 0, vcol('sun', 0.8));
    } else if (p.kind === 5) { // meteor: falls, lands, explodes
      p.vy -= 26 * dt; p.y += p.vy * dt; p.x += p.vx * dt; p.z += p.vz * dt; if (Math.random() < 0.9) pt(p.x, p.y + 0.4, p.z, (Math.random() - 0.5) * 1.5, 1 + Math.random(), (Math.random() - 0.5) * 1.5, 0.45, 1.1, 0, vcol('ember', 0.9)); if (p.y <= p.gy) { p.y = p.gy; pjImpact(p, null); dead = true; }
    }
    // enemy contact for cube / bolt / shard
    if (!dead && (p.kind === 1 || p.kind === 3 || p.kind === 4)) {
      const rr = (p.kind === 3 ? p.R.p.rad * p.R.area : p.rad * 0.8) + 0.5; for (const o of ENEMIES) { if (!gemOk(o)) continue; const dx = o.x - p.x, dz = o.z - p.z; if (dx * dx + dz * dz > rr * rr || o.y - p.y > 1.5 || p.y - o.y > 2.2 || pjHasHit(p, o)) continue;
        pjAddHit(p, o); pjImpact(p, o); if (p.fork > 0 && !p.forked && p.kind !== 3) pjFork(p, o); if (p.pierce > 0) { p.pierce--; } else if (p.kind !== 3) { dead = true; break; } else { p.pierce = 99; } }
    }
    if (!dead && p.kind !== 2 && p.life <= 0 && p.kind !== 3 && p.kind !== 5) dead = true;
    if (p.kind === 3 && p.t > 6) dead = true;
    if (dead) { p.on = false; continue; }
    // trail + instance
    p.trail -= dt; if (p.trail <= 0) { p.trail = 0.03; const c = vcol(p.elem, 0.9); pt(p.x, p.y, p.z, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6, 0.38, p.kind === 5 ? 1.4 : 0.55, 0, c); }
    const m = p.kind === 1 ? PJM.cube : p.kind === 3 ? PJM.shard : PJM.orb, idx = p.kind === 1 ? nc++ : p.kind === 3 ? ns++ : no++;
    _pjD.position.set(p.x, p.y, p.z); _pjD.rotation.set(p.rot * 0.7, p.rot, p.rot * 0.4); const s = p.sc * (p.kind === 3 ? 1.0 : 1); _pjD.scale.set(s, p.kind === 3 ? s * 0.5 : s, s); _pjD.updateMatrix(); m.setMatrixAt(idx, _pjD.matrix);
    const c = p.kind === 1 ? _pc3.setRGB(0.75, 0.85, 1) : vcol(p.elem, 1); m.setColorAt(idx, c);
  }
  pjFinish(PJM.cube, nc); pjFinish(PJM.orb, no); pjFinish(PJM.shard, ns);
}

