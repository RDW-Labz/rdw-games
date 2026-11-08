// ---- cast pipeline -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
GM.castObj = { i: 0, a: null, R: null, t: 0, yaw: 0, mul: 1, k: 0, echo: false, wind: 0 }; GM.aimEnemy = null; GM.hitstopT = 0; GM.leechT = 0; GM.ribDash = null;
function gemCanCast() { return G.state === 'play' && !P.dead && !G.trans && !G.finale && !(GM.dash && GM.dash.on); }
function gemAim(range) {
  const cy = CAM.yaw; let best = null, bd = 1e9; for (const e of ENEMIES) { if (!gemOk(e)) continue; const dx = e.x - P.x, dz = e.z - P.z, d = Math.hypot(dx, dz); if (d > range || Math.abs(e.y - P.y) > 6) continue; const da = Math.abs(angDiff(cy, Math.atan2(dx, dz))); if (da < 0.7 && d * (1 + da * 2.2) < bd) { bd = d * (1 + da * 2.2); best = e; } }
  GM.aimEnemy = best; return best ? Math.atan2(best.x - P.x, best.z - P.z) : cy;
}
function gemCast(i) {
  if (!gemCanCast()) return false; if (GM.cast) { GM.queued = i; return false; } if (G.state !== 'play') return false;
  if (GM.dirty) gemRebuild(); const a = GM.slot[i]; if (!a) { toast(RP.hot[i] ? 'That gem is not socketed right now' : 'Empty skill slot ' + (i + 1) + ' - socket a skill gem (inventory, GEMS tab)'); gsfx('gdeny'); GM.deny = 0.3; return false; }
  if (GM.cd[i] > 0) { if (GM.cd[i] < 0.28) GM.queued = i; else { GM.castFlash[i] = -0.3; } return false; }
  const R = a.R, cost = STAR.on && STAR.fx.freeCast ? 0 : R.cost; if (GM.spark < cost) { GM.sparkFlash = 0.45; gsfx('gdeny'); GM.castFlash[i] = -0.3; return false; }
  GM.spark -= cost; GM.cd[i] = R.cd; GM.castFlash[i] = 1; GM.slotXp[i] = 0; const sk = SK[R.id], yaw = gemAim(R.p.range || R.p.dist || 12), c = GM.castObj; c.i = i; c.a = a; c.R = R; c.t = 0; c.yaw = yaw; c.mul = sk.multi === 'repeat' ? mmOf(R) : 1; c.k = 0; c.echo = false; c.wind = R.wind; GM.cast = c;
  P.yaw = yaw; GM.pose.kind = sk.pose; GM.pose.t = GM.pose.dur = R.wind + 0.28; GM.pose.hand = (i & 1) ? 0 : 1; if (R.wind <= 0.001) gemFireCast(c); return true;
}
function gemFireCast(c) {
  const R = c.R, sk = SK[R.id]; GM.cast = null; GM.lastCast = R.id; sk.fire(c); GM.stats.casts++;
  if (sk.multi === 'repeat' && R.multi > 0) for (let j = 1; j <= R.multi; j++) gemEcho(R, c.yaw, 0.11 * j, c.mul, j);
  for (let j = 1; j <= R.echo; j++) gemEcho(R, c.yaw, 0.38 * j, mmOf(R) * R.echoMore, 100 + j);
  const a = c.a; if (a) { gemGainXp(a.gem, GEM_TUNING.xpPerCast); for (const q of a.sups) gemGainXp(q.gem, GEM_TUNING.xpPerCast * GEM_TUNING.supShare); }
  GM.pose.t = GM.pose.dur = Math.max(GM.pose.t, 0.3); if (SK[R.id].pose === 'spin' || SK[R.id].pose === 'gather') { GM.pose.kind = SK[R.id].pose === 'spin' ? 'slam' : 'cast'; }
  if (GM.queued >= 0) { const q = GM.queued; GM.queued = -1; gemCast(q); }
}
function gemCastTick(dt) {
  const c = GM.cast; if (!c) return; c.t += dt; const sk = SK[c.R.id]; if (sk.windFx) sk.windFx(c, dt); if (c.t >= c.wind) gemFireCast(c);
}

