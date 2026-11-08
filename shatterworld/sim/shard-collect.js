// ---- shard collection ----------------------------------------------------------------------------------------------------------
function collectShard(s) {
  if (s.got || G.trans || SH.on) return; s.got = true; s.mesh.visible = false; G.shards++; G.totalShards++; G.flags[G.act][s.id] = 1; G.score += 1000; sfx('shard'); sparkBurst(s.x, s.y, s.z, 40, 0xffd060, 9); P.hp = TUNING.hp; heroKick(hero, 10); updateHUD();
  const fy = floorAt(s.x, s.z, s.y); const stand = fy > -1e8 ? fy : P.y;
  if (s.final) { // world shatter -> next act
    G.ck = G.act >= 3 ? { act: 4, coins: G.coins, t: G.t } : { act: G.act + 1, O: { x: Math.floor(s.x), y: Math.round(stand), z: Math.floor(s.z) }, pos: null, coins: G.coins, t: G.t, shatterPending: true }; // dying mid-transition restarts at the next act's beginning
    startWorldShatter(G.act, G.act + 1, s.x, stand, s.z);
  } else {
    G.ck = { act: G.act, O: LV ? LV.O : G.ck && G.ck.O, pos: { x: s.x, y: stand + 0.05, z: s.z + 1.6 }, coins: G.coins, t: G.t };
    if (G.act === 1) startLocalShatter(s.x, s.z, TUNING.shatter.localR); else startLocalPulse(s.x, s.y, s.z);
  }
}
function startLocalPulse(cx, cy, cz) { // act 2/3 shard: ring pulse through the block world; nearby cubes hop and snap back
  if (SH.on) return; const T = TUNING.shatter;
  SH = { on: true, kind: 'pulse', t: 0, cx, cz, R: 18, R1: 0, R2: 0, items: [], ci: 0, healStart: -1 };
  WV.x = cx; WV.z = cz; WV.R1 = 0.01; WV.R2 = -1; WV.band = T.band; WV.glow = 1; syncWave();
  for (let i = 0; i < cubeHi; i++) if (C.st[i] === ST.SET && Math.abs(C.y[i] - cy) < 14) { const d = Math.hypot(C.x[i] - cx, C.z[i] - cz); if (d < 18 && hash3(i, 7, 7) < 0.5) SH.items.push({ d, k: i }); }
  SH.items.sort((a, b) => a.d - b.d); G.slow = 0.5; G.flash = 0.35; camShake(0.35); camCine(2.6, 1.3, 0.1, 0.03); sfx('shatter');
}
function updatePulse(rdt) {
  const T = TUNING.shatter; SH.t += rdt; if (SH.R1 < SH.R + T.band * 1.4) SH.R1 += 30 * rdt; WV.R1 = SH.R1;
  while (SH.ci < SH.items.length && SH.items[SH.ci].d < SH.R1 - 3) { const k = SH.items[SH.ci++].k; if (C.st[k] === ST.SET) { C.st[k] = ST.BALL; C.vy[k] = 4 + Math.random() * 5; C.vx[k] = (Math.random() - 0.5) * 3; C.vz[k] = (Math.random() - 0.5) * 3; C.wx[k] = (Math.random() - 0.5) * 8; C.wy[k] = (Math.random() - 0.5) * 8; C.wz[k] = (Math.random() - 0.5) * 8; C.delay[k] = 0.55 + Math.random() * 0.5; C.glow[k] = 0.8; C.owner[k] = -1; C.vox[k] = 1; } }
  if (SH.t > 1.4 && SH.R2 === 0) { SH.R2 = 0.01; sfx('heal'); }
  if (SH.R2 > 0) { SH.R2 += 28 * rdt; WV.R2 = SH.R2; if (SH.R2 > SH.R + T.band * 2.5) { WV.R1 = -1; WV.R2 = -1; WV.glow = 0; SH.on = false; } }
  syncWave();
}

