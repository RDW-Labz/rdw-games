// ---- passive hooks: armour / weight, heavy hands, bolt punch, stomp Spark, landing quakes -----------------------------------------------------------------------------------------------------------
const _hurtHero2 = hurtHero;
hurtHero = function (sx, sz) {
  const hp0 = RT.hp, inv = P.invuln; _hurtHero2(sx, sz); if (!(RT.hp < hp0 - 0.001 || P.invuln > inv + 0.01)) return; const d = classDef(RP.cls), w = d.base.weight || 1, k = Math.pow(Math.max(0.5, Math.min(1.8, 1 / w)), 0.7); P.vx *= k; P.vz *= k;
  if (RT.S.fx.armor) { P.vx *= 0.15; P.vz *= 0.15; P.vy = Math.min(P.vy, 3.5); P.hurtT = 0.15; }
};
const _doPunch2 = doPunch;
doPunch = function () {
  _doPunch2(); const fx = RT.S.fx;
  if (fx.heavyHands) { const f = P.yaw; let n = 0; for (const e of ENEMIES) { if (!gemOk(e) || !e.rpg) continue; const dx = e.x - P.x, dz = e.z - P.z, d = Math.hypot(dx, dz); if (d < TUNING.punch.reach * 1.5 && Math.abs(angDiff(f, Math.atan2(dx, dz))) < 1.05 && Math.abs(e.y - P.y) < 2 && !e.rpg.aff.includes('juggernaut')) { const m = (e.type === 'brute' ? 0.6 : 1) * (e.rpg.tier === 'guardian' ? 0.25 : 1); e.kbx = dx / (d + 0.01) * 16 * m; e.kbz = dz / (d + 0.01) * 16 * m; n++; } } if (n) { camShake(0.3); fxArc(P.x, P.y, P.z, f, 1.0, TUNING.punch.reach * 1.5, 0.3, 'shatter', 0.8); } }
  if (fx.boltPunch) { const R = formRef(), a = P.yaw, o = gemHand(a, 0.6), r2 = Object.assign({}, R, { hit: RT.S.baseDmg * 1.0 * RT.S.dmgMul * (1 + RT.S.skillDmg), burn: 0.2 }); pjSpawn(4, r2, o.x, o.y, o.z, Math.sin(a) * 22, 0.8, Math.cos(a) * 22, 1, { rad: 0.7, sc: 0.28, life: 1.2, elem: 'ember' }); gsfx('gfire'); GM.spark = Math.min(GM.sparkMax, GM.spark + 1.5); }
};
const _killEnemy3 = killEnemy;
killEnemy = function (e, kind, sx, sz) { _killEnemy3(e, kind, sx, sz); if (kind === 'stomp' && RT.S.fx.stompSpark) GM.spark = Math.min(GM.sparkMax, GM.spark + 4); };
const _onHeroLand2 = onHeroLand;
onHeroLand = function () {
  const triple = P.act === 'flip' && P.flipKind === 'triple', imp = Math.max(0, Math.min(1.4, -P.prevVy / 20)); _onHeroLand2();
  if (triple && RT.S.fx.stompSpark) { gemQuake(4.6, 0.55, 8, 'shatter', 8); GM.spark = Math.min(GM.sparkMax, GM.spark + 8); }
  if (STAR.run && STAR.fx.twinStomp && imp > 0.28) { gemQuake(5.6, 0.7, 11, 'gust', 10); fxRing(P.x, P.y, P.z, 0.4, 8.5, 0.6, 0x9ffff0, 0.7); }
};
const _updateEnemies2 = updateEnemies; updateEnemies = function (dt, t) { _updateEnemies2(dt * GM.enemyScale, t); };
const _rpgEnemiesTick2 = rpgEnemiesTick; rpgEnemiesTick = function (dt) { _rpgEnemiesTick2(dt * GM.enemyScale); };
const _updateHeroVisual2 = updateHeroVisual; updateHeroVisual = function (dt, rdt) { _updateHeroVisual2(dt, rdt); gemHeroTint(); };
const _rpgRecalc2 = rpgRecalc; rpgRecalc = function () { _rpgRecalc2(); GM.dirty = true; };
const _rpgStatState = rpgStatState;
rpgStatState = function () { const s = _rpgStatState(), d = classDef(RP.cls), a = RPG_TUNING.autoPerLevel * (RP.level - 1); s.alloc = { power: a * d.weights.power + RP.spent.power, agility: a * d.weights.agility + RP.spent.agility, resolve: a * d.weights.resolve + RP.spent.resolve }; s.cmods = d.mods; s.cfx = d.fx; return s; };
const attrShow = (k, au) => Math.round(au * classDef(RP.cls).weights[k] + RP.spent[k]);
const HERO_SFX = new Set(['jump', 'jump2', 'jump3', 'long', 'flip', 'kick', 'land', 'punch', 'dive', 'poundstart', 'poundgo', 'pound', 'hurt', 'stomp', 'bonk']);
const _sfx2 = sfx; sfx = function (name, a) { SFXP = HERO_SFX.has(name) ? GSFX_PITCH() : 1; _sfx2(name, a); SFXP = 1; };

