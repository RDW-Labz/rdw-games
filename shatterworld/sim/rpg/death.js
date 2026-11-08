// ---- death: xp, drops, burst, perks, affix on-death ------------------------------------------------------------------------------------------------------------
function rpgOnKilled(e, ak, sx, sz) {
  const R = e.rpg, S = RT.S; if (R.dead) return; R.dead = true; const tier = R.tier, diff = rpgDiffIdx(); RT.depth++;
  rsfx('death'); RUN.kills++; RP.totals.kills++; if (tier !== 'normal') { RUN.elites++; RP.totals.elites++; }
  if (!R.minion || true) { const xp = Math.round(rpgKillXp(e.type, R.lvl, tier, diff, RP.level) * R.xpMul * (RIFT ? RPG_TUNING.rift.xpMul : 1)); rpgGainXp(xp, 'kill'); floatText(e.x, e.y + 0.8, e.z, '+' + Math.round(xp * (1 + S.xpGain)) + ' xp', 'xp'); }
  if (!R.minion) rpgDrops(tier === 'normal' ? 'normal' : tier, e.x, e.y + 0.3, e.z, R.lvl);
  if (S.fx.coinRain) { const n = 2 + S.fx.coinRain * 2; for (let i = 0; i < n; i++) spawnLoot('gold', e.x, e.y + 0.5, e.z, Math.max(1, Math.round(rpgGoldDrop(R.lvl, 0.12, drand()) * S.goldMul))); }
  const heal = S.lifeOnKill + (S.powers.includes('vampfang') ? 0.06 : 0); if (heal > 0 && !P.dead) rpgHeal(RT.max * heal);
  rpgBurst(e);
  if (S.fx.ricochetCubes) { for (const o of rpgNearest(e.x, e.z, 9, e, S.fx.ricochetCubes)) { fxBolt(e.x, e.y + 0.6, e.z, o.x, o.y + 0.6, o.z, 0xffa860); rpgDamageEnemy(o, rpgHitDamage(S, 'punch') * 0.45, 'burst', e); } }
  if (R.aff.includes('volatile')) { fxRing(e.x, e.y, e.z, 0.4, 4.2, 0.9, 0xff8a3c, 0.8, true); const dmg = R.dmg * 1.3, ex = e.x, ey = e.y, ez = e.z; rpgLater(0.9, () => { fxRing(ex, ey, ez, 0.5, 4.4, 0.4, 0xffd0a0, 1); sparkBurst(ex, ey + 0.5, ez, 24, 0xff9a3c, 9); rsfx('nova'); camShake(0.5); if (!P.dead && Math.hypot(P.x - ex, P.z - ez) < 4.2 && Math.abs(P.y - ey) < 2.5) { RT.curEnemy = e; RT.dmgOverride = dmg; hurtHero(ex, ez); } }); }
  if (RIFT) rpgRiftKill(e); RT.depth--; RT.dirty = true;
}
function rpgBurst(e) {
  const S = RT.S, size = 1 + S.burstSize, n = Math.min(26, Math.round(7 * size) + (e.rpg.tier === 'normal' ? 0 : 6)), r = 1.8 * size; fxChunks(e.x, e.y + 0.5, e.z, n, EN_COL[e.type] || 0xa5602d, 0.2 * Math.sqrt(size), 5 + size * 1.5, e.y);
  if (RT.depth < 3 && S.burstSize > 0.05) rpgAoE(e.x, e.y, e.z, r, rpgHitDamage(S, 'punch') * 0.5, 'burst', e);
}
function rpgHeal(v) { if (v <= 0 || RT.hp >= RT.max) return; RT.hp = Math.min(RT.max, RT.hp + v); rpgMirror(); floatText(P.x, P.y + 2.1, P.z, '+' + Math.round(v), 'heal'); }
const RT_TIMERS = []; function rpgLater(sec, fn) { RT_TIMERS.push({ t: sec, fn }); }
function rpgTimers(dt) { for (let i = RT_TIMERS.length - 1; i >= 0; i--) { const q = RT_TIMERS[i]; q.t -= dt; if (q.t <= 0) { RT_TIMERS.splice(i, 1); try { q.fn(); } catch (err) { console.error(err); } } } }

