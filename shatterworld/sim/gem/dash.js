// ---- hero history (for Rewind Dash) + dash --------------------------------------------------------------------------------------------------------------------------------------------------------
function histPush() { const i = (GM.histN % 48) * 4; GM.hist[i] = P.x; GM.hist[i + 1] = P.y; GM.hist[i + 2] = P.z; GM.hist[i + 3] = GM.t; GM.histN++; }
const _hb = { x: 0, y: 0, z: 0, ok: false };
function histBack(sec) { // position the hero was at `sec` seconds ago (nearest sample), or ok = false
  _hb.ok = false; const n = Math.min(GM.histN, 48); if (n < 4) return _hb; const want = GM.t - sec; let best = -1, bd = 1e9;
  for (let k = 0; k < n; k++) { const i = ((GM.histN - 1 - k) % 48) * 4, d = Math.abs(GM.hist[i + 3] - want); if (d < bd) { bd = d; best = i; } } if (best < 0) return _hb; _hb.x = GM.hist[best]; _hb.y = GM.hist[best + 1]; _hb.z = GM.hist[best + 2]; _hb.ok = true; return _hb;
}
function dashStart(R, dx, dz, dist, time, mul, kind, vy) {
  if (GM.dash && GM.dash.on) return; const d = GM.dash || (GM.dash = { on: false, hits: [], ribbon: null }); d.on = true; d.t = 0; d.dur = time; d.dx = dx; d.dz = dz; d.spd = dist / time; d.vy = vy || 0; d.R = R; d.mul = mul; d.kind = kind; d.hits.length = 0; d.x0 = P.x; d.y0 = P.y; d.z0 = P.z; d.w = R.p.width * R.area; d.fy = P.yaw;
  P.invuln = Math.max(P.invuln, R.p.iframes + time); P.act = 'air'; P.airKind = 'jump'; P.grounded = false; P.chainN = 0; heroKick(hero, kind === 'gust' ? 10 : -6); GM.ribT = 0; if (GM.ribDash) { GM.ribDash.reset(); GM.ribDash.life = time + 0.5; }
  GM.pose.kind = 'dash'; GM.pose.t = GM.pose.dur = time + 0.2;
}
function dashStep(dt) {
  const d = GM.dash; d.t += dt; P.vx = d.dx * d.spd; P.vz = d.dz * d.spd; P.vy = d.vy; P.invuln = Math.max(P.invuln, 0.08); P.wallT = 0; P.actT += dt; moveHero(dt); P.yaw = d.fy; GM.hitstopT = Math.max(0, GM.hitstopT);
  for (const o of ENEMIES) { if (!gemOk(o) || d.hits.includes(o)) continue; const dx = o.x - P.x, dz = o.z - P.z, rr = d.w * 0.5 + 0.7; if (dx * dx + dz * dz < rr * rr && Math.abs(o.y - P.y) < 2.6) { d.hits.push(o); gemStrike(d.R, o, d.mul, P.x - d.dx * 2, P.z - d.dz * 2, 6); if (RT.S.powers.includes('chaindive') && d.kind === 'gust') rpgChain(o, 3, rpgHitDamage(RT.S, 'punch') * 0.6, 0x9fe8ff); } }
  if (d.t >= d.dur || P.wallHit) dashEnd();
}
function dashEnd() {
  const d = GM.dash; d.on = false; P.vx = d.dx * Math.min(d.spd * 0.25, 9); P.vz = d.dz * Math.min(d.spd * 0.25, 9); P.vy = d.kind === 'time' ? Math.max(0, d.vy * 0.3) : 0; P.act = P.grounded ? 'ground' : 'air'; const el = d.kind === 'time' ? 'time' : 'gust';
  fxSlash(d.x0, d.y0 + 1.0, d.z0, P.x, P.y + 1.0, P.z, el === 'gust' ? 0.9 : 0.8, 0.55, el); fxRing(P.x, P.y + 0.1, P.z, 0.3, 2.4, 0.4, VCOL[el], 0.8); sparkBurst(P.x, P.y + 1, P.z, 10, VCOL[el], 5);
  if (d.kind === 'gust' && RT.S.powers.includes('quakewave') === false && d.R.sups.length > 99) { /* reserved */ }
  if (d.kind === 'time' && RT.S.powers.includes('afterimage')) { const ax = d.x0, ay = d.y0, az = d.z0, dmg = rpgHitDamage(RT.S, 'punch') * 1.2; rpgLater(1.2, () => { fxRing(ax, ay, az, 0.4, 4.6, 0.45, 0x9ffff0, 1); sparkBurst(ax, ay + 0.8, az, 22, 0x9ffff0, 8); rsfx('nova'); rpgAoE(ax, ay, az, 4.6, dmg, 'afterimage'); }); }
}

