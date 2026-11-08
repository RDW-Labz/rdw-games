// ---- the per-mob step + the per-frame sync -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function mobStepEnemy(e) {
  const m = e.mob, R = e.rpg, c = MOBX.ctx; c.hx = P.x; c.hz = P.z; c.hy = P.y; c.hAir = MOBX.hAir; c.alive = !P.dead && !MOBX.peace; c.hvx = P.vx; c.hvz = P.vz; c.hpf = R ? clamp(R.hp / R.maxhp, 0, 1) : 1; c.minions = e.nMin | 0; c.ally = null;
  if (m.def.fam === 'healer') { let best = null, bf = 0.82; for (const o of ENEMIES) { if (o === e || !o.alive || o.state === 'dead' || !o.rpg || o.mob && o.mob.hidden) continue; const f = o.rpg.hp / o.rpg.maxhp; if (f < bf && hyp2(o.x - m.x, o.z - m.z) < MOB_ATK.mend.range[1]) { bf = f; best = o; } } if (best) c.ally = { hurt: { x: best.x, z: best.z, ref: best } }; }
  MOBX.curFy = e.fy; c.move = e.mvFn || (e.mvFn = (mm, nx, nz) => mobMoveEnemy(e, nx, nz)); c.wallAhead = mobWallAhead; mobTick(m, MOB_STEP, c); m.lastHpf = c.hpf; if (m.ev.length) mobDrain(e);
}
function mobSync(e, dt) {
  const m = e.mob, d = m.def; e.x = m.x; e.z = m.z; e.y = e.fy + m.hover; e.ang = m.face; e.dir = 1; e.aggro = m.alert; if (e.mesh) { e.mesh.position.set(e.x, e.y, e.z); e.mesh.rotation.y = m.face; }
  if (d.start === 'burrow' || d.move === 'burrow') { if (m.hidden && (m.vx || m.vz) && Math.random() < 0.5) puff(m.x, e.fy + 0.1, m.z, 1, 0.8, 0xd8b878, 1.2, -0.5, 0.7); }
  if (m.st === 'stun' && Math.random() < 0.15) puff(m.x + (Math.random() - 0.5) * 0.8, e.y + 1.4 * (e.mesh.scale.y || 1), m.z + (Math.random() - 0.5) * 0.8, 1, 0.4, 0xffe27a, 0.6, 0.5, 0.5);
  m.flash = m.flash || 0; mobAnimate(e, dt, U.time.value);
}
function mobTickAll(dt) {
  MOBX.t += dt; const hf = floorAt(P.x, P.z, P.y + 0.6); MOBX.hAir = P.grounded ? 0 : (hf > -1e8 ? Math.max(0, P.y - hf) : 3); let boss = null; const minions = MOBX.minions || (MOBX.minions = new Map()); minions.clear();
  for (const e of ENEMIES) if (e.owner && e.alive && e.state !== 'dead') minions.set(e.owner, (minions.get(e.owner) || 0) + 1);
  for (const e of ENEMIES) {
    if (!e.mob || !e.alive) continue; if (e.state === 'dead' || e.state === 'squash') continue; if (!e.rpg) continue; const m = e.mob;
    m.x = e.x; m.z = e.z; e.nMin = minions.get(e) || 0; e.macc = (e.macc || 0) + dt; let n = 0; while (e.macc >= MOB_STEP && n++ < 6) { e.macc -= MOB_STEP; mobStepEnemy(e); if (m.dead || e.state === 'dead') break; } if (e.macc > MOB_STEP * 6) e.macc = 0;
    if (e.alive && e.state !== 'dead') mobSync(e, dt); if (m.def.boss && m.alert && e.alive && e.state !== 'dead') boss = e;
  }
  MOBX.boss = boss; mobVlTick();
}
// VR draw-call diet (every drawable costs two calls, one per eye). The 4 nearest enemies keep animated limbs + outlines (any guardian always), the next 2 mobs lose their outlines, everything else is
// drawn as one baked body (see vlBake). The older enemy types are only ever baked when they are also farther than 9 m, so nothing close to the hero freezes.
let MOB_VL_FULL = 4;
const MOB_VD = new Float32Array(1024); // distances of the ranked enemies (a typed array: no boxed doubles on the per-frame path)
function mobVlTick() {
  if (!VR.merge) { if (MOBX.vlOn) { MOBX.vlOn = false; for (const e of ENEMIES) if (e.mesh && e.mesh.userData.vlB) vlApply(e.mesh, 0); if (twin.root.userData.vlB) vlApply(twin.root, 0); } return; } MOBX.vlOn = true; const L = MOBX.vl || (MOBX.vl = []); L.length = 0; let nm = 0; const VD = MOB_VD;
  for (const e of ENEMIES) { if (L.length >= 1024) break; if (!e.alive || e.state === 'dead' || e.state === 'squash' || !(e.mesh.userData.vlB === undefined ? vlInfo(e.mesh) : e.mesh.userData.vlB)) continue; VD[L.length] = (e.mob && e.mob.def.boss) || (e.rpg && e.rpg.tier === 'guardian') ? -1 : hyp2(e.x - P.x, e.z - P.z); L.push(e); if (e.mob) nm++; }
  const FULL = nm > 10 ? MOB_VL_FULL - 2 : MOB_VL_FULL; // a crowd (> 10 mobs) keeps fewer fully animated
  for (let i = 0; i < L.length; i++) { const e = L[i], d = VD[i]; let rank = 0; for (let k = 0; k < L.length; k++) if (VD[k] < d || VD[k] === d && k < i) rank++;
    vlApply(e.mesh, d < 0 ? 0 : d > 22 || rank >= FULL + 2 && (e.mob || d > 9) ? 2 : rank >= FULL && e.mob ? 1 : 0, false); }
  vlApply(twin.root, 1, false); // the Act I companion keeps its limbs but loses its outlines in VR (7 drawables)
}
