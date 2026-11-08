// ---- striking: one function for every skill hit (damage, crit, leech, burn, slow, knockback, xp, hit-stop) ------------------------------------------------------------------------------------------
const BN = []; for (let i = 0; i < 16; i++) BN.push({ on: false, e: null, t: 0, tick: 0, dmg: 0, R: null });
function gemBurn(e, dmg, sec, R) { let b = null; for (const q of BN) if (q.on && q.e === e) { b = q; break; } if (!b) for (const q of BN) if (!q.on) { b = q; break; } if (!b) return; b.on = true; b.e = e; b.t = sec; b.tick = 0.4; b.dmg = dmg / (sec / 0.4); b.R = R; }
function updateBurns(dt) { for (const b of BN) { if (!b.on) continue; const e = b.e; if (!gemOk(e)) { b.on = false; continue; } b.t -= dt; b.tick -= dt; if (e.mesh && Math.random() < 0.4) puff(e.x + (Math.random() - 0.5) * 0.5, e.y + 0.6 + Math.random() * 0.5, e.z + (Math.random() - 0.5) * 0.5, 1, 0.5, 0xff8a2a, 0.5, 2.5, 0.5); if (b.tick <= 0) { b.tick = 0.4; rpgDamageEnemy(e, b.dmg, 'skill', null, false); } if (b.t <= 0) b.on = false; } }
function gemStrike(R, e, mul, sx, sz, kb) { // returns true when the hit was lethal
  if (!gemOk(e)) return false; if (!e.rpg) rpgDecorate(e, {}); const v = R.hit * mul * (0.93 + Math.random() * 0.14), crit = Math.random() < R.crit; GM.hits++; GM.stats.hits++;
  const lethal = rpgDamageEnemy(e, v, 'skill', { x: sx, z: sz }, crit); const A = GEM_BY_ID[R.id]; if (A && R.hitsThisCast !== undefined) R.hitsThisCast++;
  const sl = R.slotI != null ? GM.slot[R.slotI] : null; if (sl && GM.slotXp[R.slotI] < GEM_TUNING.xpCastCap * 1.2) { GM.slotXp[R.slotI] += GEM_TUNING.xpPerHit; gemGainXp(sl.gem, GEM_TUNING.xpPerHit); for (const q of sl.sups) gemGainXp(q.gem, GEM_TUNING.xpPerHit * GEM_TUNING.supShare); }
  if (R.leech > 0 && !P.dead && GM.leechT <= 0) { rpgHeal(RT.max * R.leech); GM.leechT = 0.15; }
  if (!lethal) {
    if (R.burn > 0) gemBurn(e, v * R.burn, 2, R); if (R.slow > 0) { e.gSlowT = 2; e.gSlowAmt = Math.max(e.gSlowAmt || 0, Math.min(0.8, R.slow)); }
    const rr = e.rpg, kbm = (rr.aff.includes('juggernaut') ? 0 : 1) * (e.type === 'brute' ? 0.45 : 1) * (rr.tier === 'guardian' ? 0.2 : 1); if (kb > 0) { const dx = e.x - sx, dz = e.z - sz, l = Math.hypot(dx, dz) + 0.01; e.kbx = dx / l * kb * R.kbMul * kbm; e.kbz = dz / l * kb * R.kbMul * kbm; }
  }
  if (GM.hitstopT <= 0) { heroHitstop(0.03); GM.hitstopT = 0.1; } return lethal;
}
function gemChain(R, from, n, mul, elem) { const hit = new Set([from]); let cur = from; for (let i = 0; i < n; i++) { let best = null, bd = 49; for (const o of ENEMIES) { if (!gemOk(o) || hit.has(o)) continue; const d = (o.x - cur.x) * (o.x - cur.x) + (o.z - cur.z) * (o.z - cur.z); if (d < bd && Math.abs(o.y - cur.y) < 5) { bd = d; best = o; } } if (!best) break; hit.add(best); fxBolt(cur.x, cur.y + 0.8, cur.z, best.x, best.y + 0.8, best.z, VCOL[elem] || 0x9fe8ff); rsfx('bolt'); gemStrike(R, best, mul * 0.8, cur.x, cur.z, 3); cur = best; } }
function gemPull(x, z, r, str) { for (const o of ENEMIES) { if (!gemOk(o)) continue; const dx = x - o.x, dz = z - o.z, d = Math.hypot(dx, dz); if (d < r && d > 0.3 && o.rpg && !o.rpg.aff.includes('juggernaut')) { o.kbx = dx / d * str; o.kbz = dz / d * str; } } }

