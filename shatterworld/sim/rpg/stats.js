// ---- stats -> existing TUNING (always recomputed from the pristine copy TB) ---------------------------------------------------------------------------
function rpgStatState() { const L = RP.level, a = RPG_TUNING.autoPerLevel * (L - 1); return { level: L, alloc: { power: a + RP.spent.power, agility: a + RP.spent.agility, resolve: a + RP.spent.resolve }, equipped: RP.equipped, perks: RP.perks }; }
function rpgApplyTuning(force) {
  const S = RT.S, T = TUNING, jv = Math.sqrt(1 + Math.min(S.jumpH, RPG_TUNING.caps.jumpH)) * RT.jumpK, rs = (1 + Math.min(S.runSpd, RPG_TUNING.caps.runSpd) + RT.buffRun) * (1 - RT.chill) * RT.speedK, wg = sat(S.wallGrip, 0, 1);
  const key = [jv.toFixed(3), rs.toFixed(3), wg.toFixed(2), S.poundRad.toFixed(2), S.strikeRad.toFixed(2)].join('|'); if (!force && key === RT.tuneKey) return; RT.tuneKey = key;
  T.jump = TB.jump.map(v => v * jv); T.longJump.vy = TB.longJump.vy * jv; T.backflip.vy = TB.backflip.vy * jv; T.sideflip.vy = TB.sideflip.vy * jv; T.wallKick.vy = TB.wallKick.vy * jv * (S.fx.wallRun ? 1.25 : 1);
  T.walk = TB.walk * rs; T.run = TB.run * rs; T.sprint = TB.sprint * rs; T.accel = TB.accel * (1 + (rs - 1) * 0.8); T.airAccel = TB.airAccel * (1 + (rs - 1) * 0.6); T.longJump.cap = TB.longJump.cap * Math.max(1, rs); T.dive.cap = TB.dive.cap * Math.max(1, rs);
  T.wallSlide = TB.wallSlide * (1 - 0.6 * wg); T.wallKick.window = TB.wallKick.window * (1 + 1.2 * wg);
  T.pound.radius = TB.pound.radius * (1 + Math.min(S.poundRad, RPG_TUNING.caps.poundRad)); T.punch.reach = TB.punch.reach * (1 + Math.min(S.strikeRad, RPG_TUNING.caps.strikeRad));
}
function rpgRecalc() {
  const ratio = RT.S ? RT.hp / Math.max(1, RT.max) : 1; RT.S = rpgComputeStats(rpgStatState()); RT.sheet = rpgSheetNumbers(RT.S); RT.max = RT.S.maxHpTotal; RT.hp = sat(ratio * RT.max, 0, RT.max); if (ratio >= 0.999) RT.hp = RT.max;
  RT.rwMax = RT.S.rewindCharges; RT.rw = Math.min(RT.rw, RT.rwMax); rpgApplyTuning(true); rpgMirror(); RT.dirty = true;
}
function rpgMirror() { P.hp = RT.hp <= 0 ? 0 : sat(Math.ceil(RT.hp / RT.max * 3 - 1e-6), 1, 3); RT.mirror = P.hp; }
function rpgHealFull() { RT.hp = RT.max; rpgMirror(); }

