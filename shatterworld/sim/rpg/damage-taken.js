// ---- enemy -> hero damage ---------------------------------------------------------------------------------------------------------------------------------
const _heroVsEnemy = heroVsEnemy;
heroVsEnemy = function (e) { RT.curEnemy = e; RT.inHVE = true; RT.stompFlag = false; _heroVsEnemy(e); RT.inHVE = false; RT.curEnemy = null; if (RT.stompFlag) { RT.stompFlag = false; const S = RT.S; let k = 1 + 0.12 * (S.fx.springHeels || 0) + (S.powers.includes('rebound') ? 0.08 * Math.max(0, RT.stompChain - 1) : 0); if (k > 1) P.vy *= Math.min(1.6, k); } };
const _doPunch = doPunch; doPunch = function () { RT.inAttack = true; _doPunch(); RT.inAttack = false; };
const _hurtHero = hurtHero;
hurtHero = function (sx, sz) {
  if (P.invuln > 0 || P.dead || G.trans) return; const e = RT.curEnemy, dmg = RT.dmgOverride || (e && e.rpg ? e.rpg.dmg : RPG_TUNING.monster.dmg.walker); RT.dmgOverride = 0;
  const hp0 = P.hp; P.hp = 99; _hurtHero(sx, sz); const landed = P.hp < 99; P.hp = hp0; // the original handles knockback / sfx / invuln / the mushroom shield; hp bookkeeping is ours
  if (landed) rpgHeroDamageRaw(dmg, e, 'hit', sx, sz); else { rpgMirror(); floatText(P.x, P.y + 2, P.z, 'BLOCKED', 'heal'); }
  if (!landed) return;
};
function rpgHeroDamageRaw(dmg, e, how, sx, sz) {
  const S = RT.S; let v = dmg * (1 - S.reduce); if (RT.shield > 0) { const a = Math.min(RT.shield, v); RT.shield -= a; v -= a; if (RT.shield <= 0) rsfx('shield'); }
  RT.hp -= v; RT.lastHurt = RT.t; floatText(P.x, P.y + 2.1, P.z, '-' + Math.round(Math.max(1, v)), 'hurt'); const R = e && e.rpg;
  if (R && how === 'hit' && R.aff.includes('vampiric')) { R.hp = Math.min(R.maxhp, R.hp + R.maxhp * 0.2); sparkBurst(e.x, e.y + 0.8, e.z, 10, 0xff4a6a, 4); }
  if (how === 'hit') { if (S.fx.ghostStep) P.invuln += 0.4 * S.fx.ghostStep; if (S.powers.includes('thornweave')) { fxRing(P.x, P.y + 0.3, P.z, 0.4, 4.2, 0.45, 0x8cf06a, 0.9); rsfx('nova'); rpgAoE(P.x, P.y, P.z, 4.2, rpgHitDamage(S, 'punch') * 1.5, 'nova'); } }
  if (RT.hp <= 0) {
    if (S.powers.includes('phoenix') && RT.t > RT.phoenixT) { RT.phoenixT = RT.t + 90; RT.hp = RT.max * 0.5; P.invuln = Math.max(P.invuln, 2); rsfx('phoenix'); fxRing(P.x, P.y, P.z, 0.5, 9, 0.9, 0xff8a2a, 1); sparkBurst(P.x, P.y + 1, P.z, 36, 0xff9a3a, 9); rpgAoE(P.x, P.y, P.z, 7, rpgHitDamage(S, 'pound') * 1.2, 'nova'); toast('PHOENIX! Back from the brink'); G.flash = 0.5; }
    else { RT.hp = 0; rpgMirror(); killHero('hits'); return; }
  }
  if (S.fx.secondWind && RT.hp < RT.max * 0.3 && RT.t > RT.swT) { RT.swT = RT.t + Math.max(20, 70 - 15 * S.fx.secondWind); rpgHeal(RT.max * (0.3 + 0.1 * S.fx.secondWind)); rsfx('heal'); toast('Second Wind'); }
  rpgMirror(); updateHUD();
}
// projectiles (spitter bolts)
const PROJ = [], projGeo = new THREE.SphereGeometry(0.24, 10, 8), projMat = new THREE.MeshBasicMaterial({ color: 0xd68cff, fog: false });
for (let i = 0; i < 14; i++) { const m = new THREE.Mesh(projGeo, projMat); m.visible = false; m.frustumCulled = false; scene.add(m); PROJ.push({ m, on: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, dmg: 0, src: null }); }
function rpgFire(e, tx, ty, tz, spd) { const p = PROJ.find(q => !q.on); if (!p) return; const sx = e.x, sy = e.y + 0.9 * (e.mesh.scale.y || 1), sz = e.z, dx = tx - sx, dy = ty - sy, dz = tz - sz, l = Math.hypot(dx, dy, dz) + 0.001; p.on = true; p.x = sx; p.y = sy; p.z = sz; p.vx = dx / l * spd; p.vy = dy / l * spd; p.vz = dz / l * spd; p.life = 4; p.dmg = e.rpg.dmg; p.src = e; p.m.visible = true; p.m.position.set(sx, sy, sz); rsfx('spit'); }
function rpgProjectiles(dt) {
  for (const p of PROJ) {
    if (!p.on) continue; p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.m.position.set(p.x, p.y, p.z); p.m.scale.setScalar(1 + Math.sin(U.time.value * 20) * 0.15);
    const hit = !P.dead && Math.hypot(P.x - p.x, P.z - p.z) < 0.8 && Math.abs(P.y + 0.9 - p.y) < 1.1;
    if (hit) { RT.curEnemy = p.src; RT.dmgOverride = p.dmg; hurtHero(p.x, p.z); RT.curEnemy = null; }
    if (hit || p.life <= 0 || solidPoint(p.x, p.y, p.z)) { p.on = false; p.m.visible = false; sparkBurst(p.x, p.y, p.z, 6, 0xd68cff, 3); }
  }
}

