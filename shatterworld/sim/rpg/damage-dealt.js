// ---- hero -> enemy damage ---------------------------------------------------------------------------------------------------------------------------------
const ENEMY_KIND = { stomp: 'stomp', punch: 'punch', dive: 'dive', pound: 'pound', env: 'env' };
function rpgAttackKind(kind) { // which hero verb produced this call?
  if (kind === 'stomp') return 'stomp'; if (!RT.inHVE && !RT.inAttack) return 'env'; const a = P.act; return a === 'punch' ? 'punch' : a === 'dive' || a === 'slide' ? 'dive' : a === 'pound' || a === 'pound_land' ? 'pound' : a === 'long' ? 'dive' : 'punch';
}
function rpgRollHit(ak, e, base) {
  const S = RT.S, R = e.rpg; let extra = 0;
  if (RT.comboT > 0 && S.fx.comboFiend) extra += 0.03 * S.fx.comboFiend * Math.min(5, RT.combo);
  if (ak === 'stomp') { if (S.fx.springHeels) extra += 0.2 * S.fx.springHeels; if (S.powers.includes('rebound')) extra += 0.3 * Math.max(0, RT.stompChain - 1); }
  if (R.tier !== 'normal') extra += S.eliteDmg;
  let v = (base != null ? base : rpgHitDamage(S, ak, extra)) * (0.93 + Math.random() * 0.14); if (base != null) v *= 1 + extra * 0.5;
  const crit = Math.random() < S.critTotal; if (crit) v *= S.critMul; return { v, crit };
}
function rpgApplyDamage(e, v, crit, ak) { // shield first, then hp; returns true when lethal
  const R = e.rpg, total = v; if (R.shield > 0) { const a = Math.min(R.shield, v); R.shield -= a; v -= a; R.shieldT = RT.t + 5; if (R.shield <= 0 && R.shieldMax > 0) { rsfx('shield'); fxRing(e.x, e.y + 0.5, e.z, 0.4, 2.2, 0.4, 0x9fd0ff, 0.9); sparkBurst(e.x, e.y + 0.6, e.z, 12, 0x9fd0ff, 5); } }
  R.hp -= v; R.showT = 3.5; R.lastHit = RT.t;
  floatText(e.x, e.y + 1.2 * (e.mesh.scale.y || 1) + 0.4, e.z, String(Math.max(1, Math.round(total))) + (crit ? '!' : ''), crit ? 'crit' : '');
  return R.hp <= 0;
}
function rpgReact(e, ak, crit, sx, sz, kind) {
  const R = e.rpg; rsfx(crit ? 'crit' : 'hit', ak === 'pound' ? 2 : ak === 'dive' ? 1 : 0); sparkBurst(e.x, e.y + 0.6, e.z, crit ? 10 : 5, crit ? 0xffe27a : 0xffe090, crit ? 6 : 4);
  if (crit) { heroHitstop(0.05); camShake(0.2); } else heroHitstop(0.025);
  const dx = e.x - sx, dz = e.z - sz, l = Math.hypot(dx, dz) + 0.01, kb = R.aff.includes('juggernaut') ? 0 : (ak === 'pound' ? 7 : ak === 'dive' ? 6 : 4.5) * (e.type === 'brute' ? 0.45 : 1) * (R.tier === 'guardian' ? 0.2 : 1); e.kbx = dx / l * kb; e.kbz = dz / l * kb;
  if (e.body) { e.body.scale.y = 0.82; e.flinch = 0.12; }
  if (kind === 'stomp' && e.type === 'shell' && e.state === 'walk') _killEnemy(e, 'stomp', sx, sz); // a stomped shell still retreats into its shell
}
const _killEnemy = killEnemy;
function rpgFinish(e, kind, sx, sz, ak) {
  const k2 = kind === 'stomp' && e.type === 'shell' && e.state !== 'shell' ? 'kick' : kind; _killEnemy(e, k2, sx, sz);
  if (e.state === 'dead' || e.state === 'squash') rpgOnKilled(e, ak, sx, sz);
}
killEnemy = function (e, kind, sx, sz) {
  if (!e.alive || e.state === 'dead' || e.state === 'squash') return; if (!e.rpg) rpgDecorate(e, {});
  const ak = rpgAttackKind(kind), now = RT.t, CD = ak === 'punch' ? 0.2 : ak === 'dive' ? 0.32 : ak === 'stomp' ? 0.25 : ak === 'pound' ? 0.3 : 0.35;
  if ((e.cd[ak] || 0) > now) return; e.cd[ak] = now + CD;
  if (ak === 'stomp') { RT.stompChain = RT.t - RT.stompT < 3 ? RT.stompChain + 1 : 1; RT.stompT = RT.t; RT.stompFlag = true; }
  const h = rpgRollHit(ak, e), lethal = rpgApplyDamage(e, h.v, h.crit, ak); RT.hitN++; RT.combo++; RT.comboT = 2;
  rpgHitHooks(e, ak, h, sx, sz);
  if (e.rpg.aff.includes('thorned') && ak !== 'env' && !P.dead) rpgHeroDamageRaw(RT.max * 0.04, e, 'thorns');
  if (lethal) rpgFinish(e, kind, sx, sz, ak); else rpgReact(e, ak, h.crit, sx, sz, kind);
};
function rpgDamageEnemy(o, v, ak, from, forceCrit) { // secondary damage (splash / chain / nova / pulse): no cooldown, no re-triggering of hit hooks
  if (!o.alive || o.state === 'dead' || o.state === 'squash') return false; if (!o.rpg) rpgDecorate(o, {}); const crit = forceCrit !== undefined ? forceCrit : (ak === 'pulse' || ak === 'nova' ? Math.random() < RT.S.critTotal : false); if (crit) v *= RT.S.critMul;
  if (o.rpg.tier !== 'normal') v *= 1 + RT.S.eliteDmg; const lethal = rpgApplyDamage(o, v, crit, ak), sx = from ? from.x : P.x, sz = from ? from.z : P.z;
  if (lethal) rpgFinish(o, 'kick', sx, sz, ak); else rpgReact(o, ak, crit, sx, sz, 'kick'); return lethal;
}
function rpgNearest(x, z, r, skip, n) { const out = []; for (const o of ENEMIES) { if (!o.alive || o === skip || o.state === 'dead' || o.state === 'squash') continue; const d = Math.hypot(o.x - x, o.z - z); if (d < r && Math.abs(o.y - P.y) < 6) out.push({ o, d }); } out.sort((a, b) => a.d - b.d); return out.slice(0, n).map(q => q.o); }
function rpgAoE(x, y, z, r, v, ak, skip) { let n = 0; for (const o of ENEMIES) { if (!o.alive || o === skip || o.state === 'dead' || o.state === 'squash') continue; if (Math.hypot(o.x - x, o.z - z) < r && Math.abs(o.y - y) < 3.2) { rpgDamageEnemy(o, v, ak, { x, z }); n++; } } return n; }
function rpgHitHooks(e, ak, h, sx, sz) {
  const S = RT.S, fx = S.fx, base = rpgHitDamage(S, 'punch');
  if (fx.staticCharge && RT.hitN % (6 - fx.staticCharge) === 0) { rsfx('nova'); fxRing(e.x, e.y + 0.5, e.z, 0.5, 4.2, 0.45, 0x9fe8ff, 0.9); rpgAoE(e.x, e.y, e.z, 4.2, base * 0.8, 'nova', e); sparkBurst(e.x, e.y + 0.6, e.z, 14, 0x9fe8ff, 6); }
  if (ak === 'dive') {
    if (fx.diveSplash) { const r = 2.4 + 0.8 * fx.diveSplash; fxRing(e.x, e.y + 0.2, e.z, 0.4, r, 0.4, 0xffb060, 0.8); rpgAoE(e.x, e.y, e.z, r, base * (0.4 + 0.15 * fx.diveSplash) * 1.35, 'splash', e); }
    if (S.powers.includes('chaindive')) rpgChain(e, 4, base * 1.35 * 0.6, 0x9fe8ff);
  }
  if (ak === 'stomp') { if (fx.chainStomp) rpgChain(e, fx.chainStomp + 1, base * 1.25 * 0.55, 0xffe27a); if (S.powers.includes('rebound') && RT.stompChain > 1) floatText(e.x, e.y + 2, e.z, 'x' + RT.stompChain, 'crit'); }
  if (ak === 'punch' && S.powers.includes('ricochet')) rpgChain(e, 3, base * 0.8, 0xff9a3a);
}
function rpgChain(src, n, v, col) { let from = src; const hit = new Set([src]); for (let i = 0; i < n; i++) { let best = null, bd = 9; for (const o of ENEMIES) { if (!o.alive || hit.has(o) || o.state === 'dead' || o.state === 'squash') continue; const d = Math.hypot(o.x - from.x, o.z - from.z); if (d < bd && Math.abs(o.y - from.y) < 5) { bd = d; best = o; } } if (!best) break; hit.add(best); fxBolt(from.x, from.y + 0.7, from.z, best.x, best.y + 0.7, best.z, col); rsfx('bolt'); rpgDamageEnemy(best, v, 'chain', from); from = best; } }

