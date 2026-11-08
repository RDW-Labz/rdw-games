// ---- enemy brain (runs per rendered frame; movement itself stays in the original updateEnemies) -------------------------------------------------------------------
let RT_MINIONS = 0;
function rpgEnemiesTick(dt) {
  RT.chillWant = 0; let minions = 0; const t = U.time.value;
  for (const e of ENEMIES) {
    if (!e.alive) continue; const R = e.rpg; if (!R) continue; if (R.minion && e.state !== 'dead') minions++;
    if (e.state === 'dead' || e.state === 'squash') { if (e.aura) e.aura.visible = false; continue; }
    R.showT = Math.max(0, R.showT - dt); if (e.flinch > 0) { e.flinch -= dt; if (e.flinch <= 0 && e.state !== 'shell' && e.state !== 'crouch' && e.state !== 'charge' && e.state !== 'leap') e.body.scale.y = 1; }
    if (Math.abs(e.kbx) + Math.abs(e.kbz) > 0.15 && e.state !== 'leap') { const nx = e.x + e.kbx * dt, nz = e.z + e.kbz * dt, f = floorAt(nx, nz, e.y + 0.7); if (f > -1e8 && f > e.y - 0.9) { e.x = nx; e.z = nz; } const k = Math.exp(-9 * dt); e.kbx *= k; e.kbz *= k; }
    const dx = P.x - e.x, dz = P.z - e.z, d = Math.hypot(dx, dz), near = Math.abs(P.y - e.y) < 4.5, alive = !P.dead;
    if (e.aura) { const u = e.aura.userData; e.aura.visible = true; const orbs = u.orbs; for (let i = 0; i < orbs.length; i++) { if (VR.presenting) { orbs[i].visible = false; continue; } orbs[i].visible = true; const a = t * 2 + i * TAU / orbs.length; const orr = 0.7 + (e.mesh.scale.x || 1) * 0.5; orbs[i].position.set(Math.cos(a) * orr, 0.9 + (e.mesh.scale.y || 1) * 0.35 + Math.sin(t * 3 + i) * 0.12, Math.sin(a) * orr); } if (u.shell) u.shell.visible = R.shield > 0 && !VR.presenting; if (u.frost) { u.frost.rotation.y = t * 0.4; u.frost.visible = !VR.presenting; } }
    if (R.shieldMax > 0 && R.shield < R.shieldMax && RT.t > R.shieldT) R.shield = Math.min(R.shieldMax, R.shield + R.maxhp * 0.12 * dt);
    if (R.aff.includes('frozen') && d < 5.2 && near && alive) RT.chillWant = Math.max(RT.chillWant, 0.35);
    if (e.state === 'walk' && alive) {
      if (e.aggroR && near && d < e.aggroR) { e.aggro = true; if (e.type !== 'spitter') { e.hx = P.x; e.hz = P.z; e.r = 90; e.ang = Math.atan2(dx, dz); e.dir = 1; } else e.ang = Math.atan2(dx, dz); }
      else if (e.aggro && (d > e.aggroR * 1.7 || !near)) { e.aggro = false; e.hx = e.ox; e.hz = e.oz; e.r = e.or; }
    }
    // ---- per-type attacks, always with a telegraph ----
    if (e.type === 'brute') {
      e.slamCd -= dt;
      if (e.state === 'walk' && e.aggro && d < 3.6 && e.slamCd <= 0 && alive) { e.state = 'windup'; e.wt = 0; e.slamCd = 3.4; fxRing(e.x, e.y, e.z, 0.4, 3.5, 0.9, 0xff5a3a, 0.75, true); rsfx('windup'); }
      if (e.state === 'windup') { e.wt += dt; const k = Math.min(1, e.wt / 0.9); if (e.arms) { e.arms[0].rotation.x = e.arms[1].rotation.x = -2.6 * k; } e.body.position.y = 0.12 * Math.sin(k * PI * 6) * k;
        if (e.wt >= 0.9) { e.state = 'walk'; if (e.arms) e.arms[0].rotation.x = e.arms[1].rotation.x = 0; e.body.position.y = 0; rsfx('slam'); camShake(0.5); fxRing(e.x, e.y, e.z, 0.5, 4.2, 0.45, 0xffb070, 1); sparkBurst(e.x, e.y + 0.2, e.z, 16, 0xffd0a0, 7); puff(e.x, e.y + 0.1, e.z, 10, 1.6, 0xd8c8a0, 4, -1, 0.8);
          if (!P.dead && Math.hypot(P.x - e.x, P.z - e.z) < 3.6 && Math.abs(P.y - e.y) < 1.9) { RT.curEnemy = e; RT.dmgOverride = R.dmg * 1.3; hurtHero(e.x, e.z); RT.curEnemy = null; } } }
    } else if (e.type === 'hopper') {
      e.hopCd -= dt;
      if (e.state === 'walk' && e.aggro && d > 2.4 && d < 10 && e.hopCd <= 0 && alive) { e.state = 'crouch'; e.wt = 0; rsfx('hop'); }
      if (e.state === 'crouch') { e.wt += dt; e.body.scale.y = 1 - 0.4 * Math.min(1, e.wt / 0.45); if (e.wt >= 0.45) { e.state = 'leap'; e.body.scale.y = 1.15; e.lvx = dx / (d + 0.01) * 8; e.lvz = dz / (d + 0.01) * 8; e.vy = 9.5; e.lt = 0; } }
      if (e.state === 'leap') { e.lt += dt; e.vy -= 30 * dt; e.x += e.lvx * dt; e.z += e.lvz * dt; e.y += e.vy * dt; const f = floorAt(e.x, e.z, e.y + 0.7); if (f > -1e8 && e.y <= f && e.vy < 0) { e.y = f; e.vy = 0; e.state = 'walk'; e.body.scale.y = 1; e.hopCd = 1.2 + Math.random() * 0.8; e.hx = e.x; e.hz = e.z; puff(e.x, e.y + 0.1, e.z, 5, 0.9, 0xd8c8a0, 2.5); } else if (e.y < P.y - 45 || e.lt > 3) { e.alive = false; e.mesh.visible = false; } e.mesh.position.set(e.x, e.y, e.z); e.mesh.rotation.y = Math.atan2(e.lvx, e.lvz); }
    } else if (e.type === 'spitter') {
      e.fireCd -= dt;
      if (e.state === 'walk' && d < 15 && near && e.fireCd <= 0 && alive) { e.state = 'charge'; e.wt = 0; rsfx('windup'); }
      if (e.state === 'charge') { e.wt += dt; e.body.scale.setScalar(1 + 0.18 * Math.sin(Math.min(1, e.wt / 0.65) * PI)); e.ang = Math.atan2(dx, dz); if (e.wt >= 0.65) { e.state = 'walk'; e.body.scale.setScalar(1); e.fireCd = 2.4 + Math.random() * 1.2; if (alive) rpgFire(e, P.x + P.vx * 0.25, P.y + 0.9, P.z + P.vz * 0.25, 9); } }
    }
    e.spdMul = e.type === 'hopper' && e.aggro ? 0.0005 : R.spdMul;
    if (R.aff.includes('summoner') && e.aggro && alive) { R.sumT -= dt; if (R.sumT <= 0 && minions < 5) { R.sumT = 8; fxRing(e.x, e.y, e.z, 0.4, 3, 0.6, 0xc28cff, 0.8); rsfx('elite'); for (let i = 0; i < 2; i++) { const a = Math.random() * TAU; rpgSpawnEnemy('walker', e.x + Math.cos(a) * 1.6, e.z + Math.sin(a) * 1.6, { y: e.y, mlvl: Math.max(1, R.lvl - 2), minion: true, xpMul: 0.25, aggroR: 9, r: 4 }); minions++; } } }
  }
  RT_MINIONS = minions; RT.chill += (RT.chillWant - RT.chill) * Math.min(1, dt * 5); if (Math.abs(RT.chill - (RT.chillApplied || 0)) > 0.03) { RT.chillApplied = RT.chill; rpgApplyTuning(); }
  rpgProjectiles(dt); if (ENEMIES.length > 70) rpgCompactEnemies();
}
function rpgDisposeEnemy(e) { if (e.aura && !e.auraGone) { e.auraGone = true; e.aura.traverse(o => { if (o.isMesh && o.material && o.material.dispose && o.material !== LOOT_BEAM[2] && o.material !== LOOT_BEAM[3]) o.material.dispose(); }); } }
function rpgCompactEnemies() { for (let i = ENEMIES.length - 1; i >= 0; i--) { const e = ENEMIES[i]; if (!e.alive) { rpgDisposeEnemy(e); scene.remove(e.mesh); ENEMIES.splice(i, 1); } } }
function rpgSpawnEnemy(type, x, z, o = {}) { const y = o.y != null ? o.y : floorAt(x, z, P.y + 30); if (!(y > -1e8)) return null; const e = addEnemy({ type, x, y, z, r: o.r || 3 }); rpgDecorate(e, o); if (o.minion) puff(x, y + 0.3, z, 6, 0.8, 0xc28cff, 2); return e; }

