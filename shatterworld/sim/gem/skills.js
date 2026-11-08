// ---- the skills: wind-up (windFx) -> impact (fire) -> afterglow. c = { R, yaw, mul, k (repeat index), echo } ---------------------------------------------------------------------------------------
const _og = { x: 0, y: 0, z: 0 };
function gemHand(yaw, fwd = 0.55) { _og.x = P.x + Math.sin(yaw) * fwd; _og.y = P.y + 1.05 * P.size; _og.z = P.z + Math.cos(yaw) * fwd; return _og; }
function gemTarget(yaw, dist, range) { // aim spot: the targeted enemy when one is in range, else straight ahead
  const e = GM.aimEnemy; let x = P.x + Math.sin(yaw) * dist, z = P.z + Math.cos(yaw) * dist; if (e && gemOk(e) && Math.hypot(e.x - P.x, e.z - P.z) < dist + range) { x = e.x; z = e.z; } const f = floorAt(x, z, P.y + 8); _og.x = x; _og.z = z; _og.y = f > -1e8 ? f : P.y; return _og;
}
const mmOf = R => R.multi > 0 ? R.multiMore : 1;
const SK = {
  cubetoss: { pose: 'throw', multi: 'spread', cat: 'ranged',
    windFx(c) { }, fire(c) { const R = c.R, n = 1 + (c.echo ? 0 : R.multi), mm = mmOf(R), o = gemHand(c.yaw); gsfx('gcube');
      for (let k = 0; k < n; k++) { const a = c.yaw + (n > 1 ? (k - (n - 1) / 2) * 0.22 : 0); pjSpawn(1, R, o.x, o.y, o.z, Math.sin(a) * R.p.speed, gemAimVy(o, a, R.p.speed, 6, 2.4), Math.cos(a) * R.p.speed, c.mul * mm, { rad: R.p.rad, sc: 0.55, life: 2.2 }); }
      fxRing(o.x, o.y - 0.9, o.z, 0.3, 1.5, 0.28, VCOL.shatter, 0.7); sparkBurst(o.x, o.y, o.z, 7, 0xbcd4ee, 5); heroKick(hero, 4); } },
  spinslam: { pose: 'spin', multi: 'repeat', cat: 'melee',
    windFx(c, dt) { if (Math.random() < dt * 40) { const a = Math.random() * TAU; pt(P.x + Math.cos(a) * 1.3, P.y + 0.15, P.z + Math.sin(a) * 1.3, -Math.sin(a) * 6, 0.5, Math.cos(a) * 6, 0.4, 0.8, 0, vcol('shatter', 0.8)); } },
    fire(c) { const R = c.R, rad = R.p.rad * R.area * (1 + 0.28 * (c.k || 0)); gsfx('gslam'); camShake(0.5); heroHitstop(0.06);
      fxRing(P.x, P.y, P.z, 0.6, rad, 0.5, VCOL.shatter, 0.95); fxRing(P.x, P.y, P.z, 0.3, rad * 0.7, 0.35, 0xe8f2ff, 0.7, true); fxChunks(P.x, P.y + 0.4, P.z, 14, 0x8fa3b8, 0.24, 7, P.y); sparkBurst(P.x, P.y + 0.5, P.z, 18, 0xbcd4ee, 8); ptRing(P.x, P.y + 0.2, P.z, 18, rad * 0.35, 2.2, 0.8, 1.1, vcol('shatter', 0.8), rad * 0.9);
      for (const o of ENEMIES) { if (!gemOk(o) || Math.hypot(o.x - P.x, o.z - P.z) > rad || Math.abs(o.y - P.y) > 3) continue; gemStrike(R, o, c.mul, P.x, P.z, R.p.kb); }
      if (G.act === 1 && !c.echo) { let n = 0; for (const t of TREES) if (t.alive && TREE_MESH[t.type].visible && Math.hypot(t.x - P.x, t.z - P.z) < rad && n < 2) { shatterTree(t, P.x, P.z, 6); n++; } for (const r of ROCKS) if (r.alive && Math.hypot(r.x - P.x, r.z - P.z) < rad * 0.8 && n < 3) { shatterRock(r, P.x, P.z, 6); n++; } }
      if (RT.S.powers.includes('quakewave') && !c.echo) { const x = P.x, y = P.y, z = P.z, v = rpgHitDamage(RT.S, 'pound') * 0.7; fxRing(x, y, z, 1, 15, 0.7, 0xffb060, 0.95); rsfx('nova'); for (const o of ENEMIES) { if (!gemOk(o)) continue; const d = Math.hypot(o.x - x, o.z - z); if (d < 15 && Math.abs(o.y - y) < 3.5) rpgLater(d / 15 * 0.7, () => rpgDamageEnemy(o, v, 'ring', { x, z })); } } } },
  shockclap: { pose: 'clap', multi: 'repeat', cat: 'melee',
    windFx() { }, fire(c) { const R = c.R, range = R.p.range * R.area, half = R.p.arc / 2; gsfx('gclap'); camShake(0.35); heroHitstop(0.04);
      for (const o of ENEMIES) { if (!gemOk(o)) continue; const dx = o.x - P.x, dz = o.z - P.z, d = Math.hypot(dx, dz); if (d < range && d > 0.01 && Math.abs(angDiff(c.yaw, Math.atan2(dx, dz))) < half && Math.abs(o.y - P.y) < 3.2) gemStrike(R, o, c.mul, P.x, P.z, R.p.kb); }
      fxArc(P.x, P.y, P.z, c.yaw, 1.2, range * 0.55, 0.32, 'sun', 0.95); fxArc(P.x, P.y, P.z, c.yaw, 1.8, range * 0.8, 0.4, 'sun', 0.8); fxArc(P.x, P.y, P.z, c.yaw, 2.4, range, 0.5, 'sun', 0.65);
      const o = gemHand(c.yaw, 0.8); sparkBurst(o.x + Math.sin(c.yaw) * 2, o.y - 0.3, o.z + Math.cos(c.yaw) * 2, 18, 0xffd45a, 9); for (let k = 0; k < 10; k++) { const a = c.yaw + (Math.random() - 0.5) * R.p.arc, sp = 7 + Math.random() * 8; pt(o.x, o.y - 0.4, o.z, Math.sin(a) * sp, (Math.random() - 0.5), Math.cos(a) * sp, 0.4, 0.7, 0, vcol('sun', 1)); } } },
  gustdash: { pose: 'dash', multi: 'none', cat: 'move',
    windFx() { }, fire(c) { const R = c.R; P.yaw = c.yaw; gsfx('gdash'); dashStart(R, Math.sin(c.yaw), Math.cos(c.yaw), R.p.dist, R.p.time, c.mul, 'gust', 0); puff(P.x, P.y + 0.3, P.z, 8, 1, 0xdffff8, 3, 0, 0.5); } },
  rewinddash: { pose: 'dash', multi: 'none', cat: 'move',
    windFx() { }, fire(c) { const R = c.R; let t = histBack(R.p.back), dx = 0, dz = 0, dy = 0;
      if (t.ok) { dx = t.x - P.x; dz = t.z - P.z; dy = t.y - P.y; } let lh = Math.hypot(dx, dz); if (!t.ok || lh < 2.2) { dx = -Math.sin(c.yaw) * 5; dz = -Math.cos(c.yaw) * 5; dy = 0; lh = 5; }
      const tm = Math.max(0.11, Math.min(0.24, lh / 46)); gsfx('grewind'); P.yaw = Math.atan2(-dx, -dz); // keep facing the way you were running
      const sx = P.x, sy = P.y, sz = P.z; for (let k = 0; k < 9; k++) { const u = k / 8, x = sx + dx * u, y = sy + dy * u + 0.9, z = sz + dz * u; pt(x, y, z, 0, 0.6, 0, 0.8 + u * 0.3, 1.1, 0, vcol('time', 1)); ptRing(x, y, z, 5, 0.35, 0.4, 0.5, 0.6, vcol('time', 0.9), 1.2); }
      dashStart(R, dx / lh, dz / lh, lh, tm, c.mul, 'time', Math.max(-18, Math.min(18, dy / tm))); GM.dash.fy = P.yaw; fxRing(sx, sy, sz, 0.3, 2.6, 0.5, VCOL.time, 0.9); } },
  shardboomerang: { pose: 'throw', multi: 'spread', cat: 'ranged',
    windFx() { }, fire(c) { const R = c.R, n = 1 + (c.echo ? 0 : R.multi), mm = mmOf(R), o = gemHand(c.yaw); gsfx('gboom');
      for (let k = 0; k < n; k++) { const a = c.yaw + (n > 1 ? (k - (n - 1) / 2) * 0.35 : 0); pjSpawn(3, R, o.x, o.y, o.z, Math.sin(a) * R.p.speed, gemAimVy(o, a, R.p.speed, 0, 0.0), Math.cos(a) * R.p.speed, c.mul * mm, { rad: R.p.rad, sc: 0.95, life: 6, pierce: 99, chain: 0, fork: 0 }); }
      fxRing(o.x, o.y - 0.9, o.z, 0.3, 1.6, 0.3, VCOL.sun, 0.75); sparkBurst(o.x, o.y, o.z, 8, 0xffd45a, 5); heroKick(hero, 4); } },
  cinderbloom: { pose: 'cast', multi: 'spread', cat: 'ranged',
    windFx(c, dt) { if (Math.random() < dt * 40) { const o = gemHand(c.yaw, 0.6); pt(o.x, o.y, o.z, (Math.random() - 0.5) * 2, 1.5, (Math.random() - 0.5) * 2, 0.4, 0.7, 0, vcol('ember', 1)); } },
    fire(c) { const R = c.R, n = R.p.orbs + (c.echo ? 0 : R.multi * 2) + (RT.S.powers.includes('cindercrown') ? 2 : 0), mm = mmOf(R), o = gemHand(c.yaw, 0.6); gsfx('gcinder');
      for (let k = 0; k < n; k++) { const a = c.yaw + (k - (n - 1) / 2) * 0.42, sp = R.p.speed * (0.85 + (k % 2) * 0.2); pjSpawn(2, R, o.x, o.y, o.z, Math.sin(a) * sp, 5.2, Math.cos(a) * sp, c.mul * mm, { rad: R.p.rad, sc: 0.55, bounces: R.p.bounces, life: R.p.life }); }
      fxRing(o.x, o.y - 0.9, o.z, 0.3, 1.8, 0.35, VCOL.ember, 0.85); sparkBurst(o.x, o.y, o.z, 12, 0xff9a3c, 6); heroKick(hero, 5); } },
  whirlgale: { pose: 'cast', multi: 'repeat', cat: 'ranged',
    windFx() { }, fire(c) { const R = c.R, yw = c.yaw + (c.k ? (c.k % 2 ? 0.55 : -0.55) : 0), t = gemTarget(yw, R.p.dist, 4); gsfx('gwhirl'); znSpawn(0, R, t.x, t.y, t.z, Math.sin(yw) * R.p.speed, Math.cos(yw) * R.p.speed, c.mul); fxRing(t.x, t.y, t.z, 0.4, R.p.rad * 1.4, 0.5, VCOL.gust, 0.9); sparkBurst(t.x, t.y + 1, t.z, 14, 0x9ff8ee, 6); } },
  stasis: { pose: 'cast', multi: 'repeat', cat: 'ranged',
    windFx() { }, fire(c) { const R = c.R, t = gemTarget(c.yaw + (c.k ? (c.k % 2 ? 0.7 : -0.7) : 0), R.p.dist, 4); gsfx('gstasis'); znSpawn(1, R, t.x, t.y, t.z, 0, 0, c.mul); fxRing(t.x, t.y, t.z, 0.4, R.p.rad * 1.3, 0.6, VCOL.time, 0.9); fxRing(t.x, t.y, t.z, 0.2, R.p.rad * 0.7, 0.45, 0xe6dcff, 0.7, true); } },
  sunbeam: { pose: 'gather', multi: 'spread', cat: 'ranged',
    windFx(c, dt) { const o = gemHand(c.yaw, 0.7); if (Math.random() < dt * 90) ptSuck(o.x, o.y, o.z, 1, 1.7, 0.3, 0.7, 'sun'); if (c.t < dt * 1.5) { gsfx('gbeamup'); fxRing(o.x, o.y - 0.9, o.z, 2.2, 0.3, Math.max(0.2, c.R.wind), VCOL.sun, 0.8); } },
    fire(c) { const R = c.R, n = 1 + (c.echo ? 0 : R.multi), mm = mmOf(R), o = gemHand(c.yaw, 0.7); gsfx('gbeam'); camShake(0.4); heroHitstop(0.05);
      for (let k = 0; k < n; k++) { const a = c.yaw + (n > 1 ? (k - (n - 1) / 2) * 0.3 : 0), dx = Math.sin(a), dz = Math.cos(a), range = R.p.range; let end = range; for (let d = 1; d < range; d += 0.6) if (solidPoint(o.x + dx * d, o.y, o.z + dz * d)) { end = d; break; }
        const hits = []; for (const e of ENEMIES) { if (!gemOk(e)) continue; const ex = e.x - o.x, ez = e.z - o.z, along = ex * dx + ez * dz; if (along < 0 || along > end) continue; const perp = Math.abs(ex * dz - ez * dx); if (perp < R.p.width * R.area * 0.5 + 0.6 && Math.abs(e.y - P.y) < 3.5) hits.push({ e, along }); }
        hits.sort((p, q) => p.along - q.along); const lim = 3 + R.pierce * 2; let last = null; for (let i = 0; i < hits.length && i < lim; i++) { gemStrike(R, hits[i].e, c.mul * mm, o.x, o.z, 4); last = hits[i].e; sparkBurst(hits[i].e.x, hits[i].e.y + 0.8, hits[i].e.z, 8, 0xffd45a, 6); } if (last && R.chain > 0) gemChain(R, last, R.chain, c.mul * mm, 'sun');
        const ex = o.x + dx * end, ez = o.z + dz * end; fxBeam(o.x, o.y, o.z, ex, o.y, ez, R.p.width * 0.55 * R.area, 0.45, 'sun'); fxBeam(o.x, o.y, o.z, ex, o.y, ez, R.p.width * 0.22, 0.3, 'sun'); sparkBurst(ex, o.y, ez, 14, 0xffe08a, 8); for (let q = 0; q < 14; q++) { const u = Math.random() * end; pt(o.x + dx * u, o.y + (Math.random() - 0.5) * 0.4, o.z + dz * u, (Math.random() - 0.5) * 2, 0.6, (Math.random() - 0.5) * 2, 0.7, 0.7, 0, vcol('sun', 1)); } }
      fxRing(o.x, o.y - 0.9, o.z, 0.4, 2.8, 0.4, VCOL.sun, 0.9); heroKick(hero, -8); } },
  meteorfall: { pose: 'cast', multi: 'spread', cat: 'ranged',
    windFx() { }, fire(c) { const R = c.R, t = gemTarget(c.yaw, R.p.dist, 6), cx = t.x, cz = t.z, n = R.p.count + (c.echo ? 0 : R.multi), mm = mmOf(R), delay = R.p.delay * R.windFactor; gsfx('gmeteor');
      for (let k = 0; k < n; k++) { const a = k / n * TAU + Math.random(), rr = k === 0 && GM.aimEnemy ? 0 : R.p.spread * (0.4 + Math.random() * 0.6), x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr, f = floorAt(x, z, P.y + 8), gy = f > -1e8 ? f : P.y; let fl = null; for (const q of FL) if (!q.on) { fl = q; break; } if (!fl) break;
        fl.on = true; fl.x = x; fl.z = z; fl.gy = gy; fl.t = -k * 0.18; fl.delay = delay; fl.R = R; fl.mul = c.mul * mm; fxRing(x, gy, z, R.p.rad * 0.15, R.p.rad * R.area, delay + k * 0.18, VCOL.ember, 0.55, true); } } },
};
function gemFinal2(R) { return R; }

