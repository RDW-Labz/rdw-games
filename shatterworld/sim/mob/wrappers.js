// ---- wrappers: spawn / decorate / damage / death / contact ----------------------------------------------------------------------------------------------------------------------------------------------------------------
const _mb_addEnemy2 = addEnemy;
addEnemy = function (spec) {
  const def = MOB_DEFS[spec.type]; if (!def) return _mb_addEnemy2(spec);
  let g, body, mx = null; if (def.inst) { g = new THREE.Group(); body = new THREE.Group(); g.add(body); mobiGet(def.id); } else { const md = MOB_SHAPES[def.shape](def.pal); g = md.g; body = md.body; mx = md.x; }
  const sc = def.size * 1.15; g.scale.setScalar(sc); g.position.set(spec.x, spec.y, spec.z); scene.add(g); if (VR.merge && !def.inst) vrMergeApply(g, true); const seed = ((Math.random() * 4294967296) >>> 0);
  const e = { type: spec.type, x: spec.x, y: spec.y, z: spec.z, hx: spec.x, hz: spec.z, r: spec.r || 4, dir: 1, ang: Math.random() * TAU, vy: 0, state: 'mob', t: 0, mesh: g, body, mx, alive: true, ceil: false, kx: 0, kz: 0, h: def.h * sc, ph: Math.random() * 6, fy: spec.y };
  e.mob = mobNew(def.id, seed, { x: spec.x, y: spec.y, z: spec.z, r: e.r, face: e.ang }); e.mob.hidden = def.start === 'burrow'; e.mob.noContact = e.mob.hidden; if (def.start === 'burrow') body.visible = false; ENEMIES.push(e); MOBX.spawned++; return e;
};
const _mb_rpgDecorate2 = rpgDecorate;
rpgDecorate = function (e, o = {}) {
  _mb_rpgDecorate2(e, o); if (!e.mob) return e; const R = e.rpg, m = e.mob, d = m.def; if (o.seed != null) { m.seed = o.seed >>> 0; m.rng = rpgRng((o.seed ^ 0x3F1) >>> 0); } if (o.aggroR != null && o.aggroR <= 0) m.aggro = 0.0001; else if (o.aggroR != null && o.aggroR > 0) m.aggro = Math.max(d.aggro, 0);
  if (R.tier === 'guardian') R.name = (R.aff.map(i => RPG_MAFFIX[i].adj).join(' ') + ' ' + d.name).trim(); if (o.pack != null) m.pack = o.pack; R.spdMul = Math.min(R.spdMul, 1.8); m.spdK = 1; e.mob.baseSpd = 1; return e;
};
const _mb_rpgApplyDamage2 = rpgApplyDamage;
rpgApplyDamage = function (e, v, crit, ak) {
  if (e.mob) { const m = e.mob; if (m.hidden || m.dead) return false; v *= mobShieldFactor(m, P.x, P.z, ak === 'pound' ? 'pound' : ak); if (m.invuln) v *= 0.25; mobHurt(m, P.x, P.z); m.flash = 0.6; if (m.ev.length) mobDrain(e); }
  return _mb_rpgApplyDamage2(e, v, crit, ak);
};
const _mb_killEnemy2 = killEnemy; killEnemy = function (e, kind, sx, sz) { if (e && e.mob && (e.mob.hidden || e.mob.dead)) return; _mb_killEnemy2(e, kind, sx, sz); };
const _mb_rpgDamageEnemy2 = rpgDamageEnemy; rpgDamageEnemy = function (o, v, ak, from, forceCrit) { if (o && o.mob && (o.mob.hidden || o.mob.dead)) return false; return _mb_rpgDamageEnemy2(o, v, ak, from, forceCrit); };
const _mb_gemOk2 = gemOk; gemOk = function (e) { return _mb_gemOk2(e) && !(e.mob && (e.mob.hidden || e.mob.dead)); };
const _mb_rpgOnKilled2 = rpgOnKilled;
rpgOnKilled = function (e, ak, sx, sz) {
  if (e.mob) { const m = e.mob; if (!m.dead) { mobDie(m, 'hit'); mobDrain(e); } if (e.rpg) { MOBX.kills[e.type] = (MOBX.kills[e.type] | 0) + 1; } for (const o of ENEMIES) if (o.owner === e && o.alive && (m.def.fam === 'summoner' || m.def.boss)) mobSilentKill(o); FD.kill = e; }
  _mb_rpgOnKilled2(e, ak, sx, sz); FD.kill = null;
};
const _mb_heroVsEnemy2 = heroVsEnemy;
heroVsEnemy = function (e) { if (e.mob) { const m = e.mob; if (m.noContact || m.hidden || m.dead) return; if (m.def.fam === 'healer' || m.def.fam === 'summoner' || m.def.fam === 'artillery') { if (!(P.vy < -1 || P.act === 'dive' || P.act === 'pound' || P.act === 'punch')) return; } if (m.def.fly && m.hover > 1.1 && P.y - e.y < 0.4) return; if (m.phaseT > 0) return; } _mb_heroVsEnemy2(e); };
const _mb_rpgEnemiesTick3 = rpgEnemiesTick; rpgEnemiesTick = function (dt) { _mb_rpgEnemiesTick3(dt); mobTickAll(dt * GM.enemyScale); };
const _mb_rpgFrame2 = rpgFrame; rpgFrame = function (rdt, sdt) { _mb_rpgFrame2(rdt, sdt); try { mobFxFrame(rdt, sdt * GM.enemyScale); mobiUpdate(); } catch (err) { if (!MOBX.err) { MOBX.err = 1; console.error('mobFx', err); } } };
const _mb_clearEntities3 = clearEntities; clearEntities = function () { mobClearFx(); _mb_clearEntities3(); };
function rpgBossRef() { const g = RIFT && RIFT.guardian && RIFT.guardian.alive && RIFT.guardian.rpg ? RIFT.guardian : null; return g || (MOBX.boss && MOBX.boss.alive && MOBX.boss.rpg ? MOBX.boss : null); }
