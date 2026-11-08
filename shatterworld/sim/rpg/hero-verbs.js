// ---- hero verbs: rewind pulse, pound / landing hooks, gold + shard + block hooks, per-frame hero tick ---------------------------------------------------------------
function rpgSetBuffs() { const k = 0.03 * RT.goldStack + (RT.surgeT > 0 ? 0.12 : 0); if (Math.abs(k - RT.buffRun) > 1e-6) { RT.buffRun = k; rpgApplyTuning(); } }
function rpgPulse(free) { // Rewind Pulse: tapping RMB with enemies close fires a time ring (1 charge). Debris rewinding on the same press is untouched.
  if (G.state !== 'play' || P.dead) return; const S = RT.S, R = RPG_TUNING.rewind, near = rpgNearest(P.x, P.z, R.radius * 1.4, null, 40); if (!near.length) return;
  if (!free) { if (RT.rw < 1 || RT.pulseCd > 0) return; RT.rw -= 1; RT.pulseCd = R.cd; }
  RT.pulses = (RT.pulses || 0) + 1; RT.pulseNear = near.length;   rsfx('pulse'); fxRing(P.x, P.y, P.z, 0.5, R.radius, 0.5, 0x53e0d0, 0.9); fxRing(P.x, P.y, P.z, 0.2, R.radius * 0.55, 0.35, 0xffffff, 0.6); camShake(0.15); G.flash = Math.max(G.flash, 0.05);
  const v = rpgHitDamage(S, 'pulse'), pull = S.fx.rewindPull ? R.pull : 0;
  for (const o of near) { if (Math.hypot(o.x - P.x, o.z - P.z) > R.radius) continue; const dx = o.x - P.x, dz = o.z - P.z, l = Math.hypot(dx, dz) + 0.01; rpgDamageEnemy(o, v, 'pulse', P); if (pull && o.alive && o.rpg && !o.rpg.aff.includes('juggernaut')) { o.kbx = -dx / l * pull; o.kbz = -dz / l * pull; } }
  if (S.powers.includes('afterimage')) { const ax = P.x, ay = P.y, az = P.z, dmg = rpgHitDamage(S, 'punch') * 1.2 * (1 + S.rewindDmg); fxChunks(ax, ay + 0.9, az, 8, 0x53e0d0, 0.14, 1.5, ay); rpgLater(1.4, () => { fxRing(ax, ay, az, 0.4, 4.6, 0.45, 0x9ffff0, 1); sparkBurst(ax, ay + 0.8, az, 22, 0x9ffff0, 8); rsfx('nova'); camShake(0.25); rpgAoE(ax, ay, az, 4.6, dmg, 'afterimage'); }); for (let i = 0; i < 5; i++) rpgLater(i * 0.28, () => puff(ax, ay + 0.9, az, 2, 0.8, 0x9ffff0, 0.4, 0.2, 0.5)); toast('Afterimage'); }
}
const _doPound = doPound;
doPound = function () {
  RT.inAttack = true; _doPound(); RT.inAttack = false; const S = RT.S;
  if (S.powers.includes('quakewave')) { const x = P.x, y = P.y, z = P.z, v = rpgHitDamage(S, 'pound') * 0.7; fxRing(x, y, z, 1, 15, 0.7, 0xffb060, 0.95); fxRing(x, y, z, 1, 11, 0.55, 0xfff0c0, 0.7); rsfx('nova');
    for (const o of ENEMIES) { if (!o.alive || o.state === 'dead' || o.state === 'squash') continue; const d = Math.hypot(o.x - x, o.z - z); if (d < 15 && Math.abs(o.y - y) < 3.5) rpgLater(d / 15 * 0.7, () => rpgDamageEnemy(o, v, 'ring', { x, z })); } }
};
const _onHeroLand = onHeroLand;
onHeroLand = function () {
  const triple = P.act === 'flip' && P.flipKind === 'triple'; _onHeroLand();
  if (triple && RT.S.powers.includes('starjump')) { rsfx('nova'); fxRing(P.x, P.y, P.z, 0.5, 6, 0.5, 0xffe27a, 1); sparkBurst(P.x, P.y + 0.4, P.z, 22, 0xffe27a, 8); rpgAoE(P.x, P.y, P.z, 6, rpgHitDamage(RT.S, 'punch'), 'nova'); RT.surgeT = 3; rpgSetBuffs(); }
};
const rpgCoinValue = () => Math.max(1, Math.round((2 + 0.45 * rpgMonsterLevel({ act: G.act, diff: rpgDiffIdx(), idx: 0, rift: RIFT ? RIFT.tier : 0 })) * RT.S.goldMul));
const _collectCoin = collectCoin;
collectCoin = function (c) {
  _collectCoin(c); const g = rpgCoinValue(); RP.gold += g; RUN.gold += g; RT.dirty = true; floatText(c.x, c.y + 0.6, c.z, '+' + g, 'gold');
  if (RT.S.powers.includes('goldrush')) { RT.goldStack = Math.min(10, RT.goldStack + 1); RT.goldT = 5; rpgSetBuffs(); }
  if (G.coins % TUNING.coinHeal === 0) rpgHealFull();
};
const _collectShard = collectShard;
collectShard = function (s) {
  const was = s.got; _collectShard(s); if (was || !s.got) return; const diff = rpgDiffIdx(), mlvl = rpgMonsterLevel({ act: G.act, diff, idx: 2, rift: 0 }); rpgHealFull(); RUN.shards = (RUN.shards || 0) + 1;
  rpgDrops('shard', s.x, s.y - 0.4, s.z, mlvl); rpgGainXp(rpgObjectiveXp('shard', mlvl, diff, RP.level), 'shard'); toast('SUN SHARD  +loot', 2200);
  if (s.final) { rpgGainXp(rpgObjectiveXp('act', mlvl, diff, RP.level), 'act'); setTimeout(() => rpgVacuum(), 700); }
};
const _bumpBlock = bumpBlock;
bumpBlock = function (b) { const was = b.used; _bumpBlock(b); if (was) return; const diff = rpgDiffIdx(), mlvl = rpgMonsterLevel({ act: G.act, diff, idx: 1 }); rpgDrops('qblock', b.x, b.y + 0.9, b.z, mlvl); rpgGainXp(rpgObjectiveXp('qblock', mlvl, diff, RP.level), 'block'); };

function rpgHeroTick(dt) {
  const S = RT.S; if (P.dead) return;
  if (RT.hp < RT.max && S.regenHp > 0) RT.hp = Math.min(RT.max, RT.hp + S.regenHp * dt);
  if (P.big && !RT.wasBig) { rpgHealFull(); } RT.wasBig = P.big; rpgMirror();
  if (S.fx.bulwark) { if (RT.bulRank !== S.fx.bulwark) { RT.bulRank = S.fx.bulwark; RT.bulT = 6; } RT.bulT -= dt; if (RT.bulT <= 0) { RT.bulT = Math.max(8, 18 - 3 * S.fx.bulwark); RT.shield = RT.max * (0.06 + 0.04 * S.fx.bulwark); rsfx('shield'); floatText(P.x, P.y + 2, P.z, 'SHIELD', 'heal'); } } else RT.shield = 0;
  RT.rw = Math.min(RT.rwMax, RT.rw + S.rewindRate * dt); RT.pulseCd = Math.max(0, RT.pulseCd - dt);
  const pl = !!INP.place; if (pl && !RT.prevPlace) rpgPulse(false); RT.prevPlace = pl;
  if (S.powers.includes('echobell')) { RT.bellT -= dt; if (RT.bellT <= 0) { RT.bellT = 6; rpgPulse(true); } }
  RT.comboT -= dt; if (RT.comboT <= 0) RT.combo = 0;
  if (RT.goldStack > 0) { RT.goldT -= dt; if (RT.goldT <= 0) { RT.goldStack = 0; rpgSetBuffs(); } } if (RT.surgeT > 0) { RT.surgeT -= dt; if (RT.surgeT <= 0) rpgSetBuffs(); }
}

