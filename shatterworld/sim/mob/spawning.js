// ---- spawning: per act (extra, seeded), act guardians, rift families ------------------------------------------------------------------------------------------------------------------------------------------------------------------
function mobPickType(rng, act, fams) {
  const tbl = MOB_CAMPAIGN.table.filter(r => r[2] <= act && (!fams || fams.some(f => MOB_FAMILIES[f].mobs.includes(r[0])))); if (!tbl.length) return 'slinger'; let tot = 0; for (const r of tbl) tot += r[1]; let x = rng() * tot; for (const r of tbl) { x -= r[1]; if (x <= 0) return r[0]; } return tbl[tbl.length - 1][0];
}
function mobSpawnAct() {
  const act = G.act, diff = rpgDiffIdx(), rng = rpgRng(rpgHashSeed(RP.seed ^ 0x4D0B, act * 977 + diff * 31 + 11)), n = MOB_CAMPAIGN.extraPerAct[act] || 0; if (RIFT) return;
  const anchors = []; for (const c of COINS) if (c.alive && !c.pop) anchors.push([c.x, c.y - 1, c.z]); for (const e of ENEMIES) if (e.alive && !e.ceil && !e.mob) anchors.push([e.hx, e.y, e.hz]); rpgScatter(rng, anchors, act === 1 ? 120 : 160); if (!anchors.length) return;
  const used = ENEMIES.filter(e => e.alive).map(e => [e.x, e.y, e.z]); let idx = 100, placed = 0;
  for (let i = 0; i < n * 2 && placed < n; i++) {
    const type = mobPickType(rng, act, null), def = MOB_DEFS[type], s = rpgSpot(rng, anchors, used, { minHero: Math.max(14, def.aggro + 5), space: 4 }); /* a mob never starts inside its own view range of the spawn point */ if (!s) continue; const r = rng(), tier = type === 'warden' ? 'normal' : r < 0.1 ? 'elite' : r < 0.26 ? 'champion' : 'normal', packN = def.pack ? MOB_CAMPAIGN.packSize : 1, pack = def.pack ? (++MOBX.spawned) : 0;
    for (let k = 0; k < packN; k++) { const a = k / packN * TAU, x = s[0] + Math.cos(a) * (k ? 1.4 : 0), z = s[2] + Math.sin(a) * (k ? 1.4 : 0), e = rpgSpawnEnemy(type, x, z, { y: s[1], idx: idx++, tier: k === 0 ? tier : 'normal', seed: (rng() * 4294967296) >>> 0, r: 2.5 + rng() * 2, pack }); if (e && pack) e.mob.pack = pack; } placed++;
  }
  mobSpawnGuardian(act, rng);
}
function mobSpawnGuardian(act, rng) {
  const id = MOB_BOSS_BY_ACT[act]; if (!id || RIFT) return; const sh = SHARDS.find(s => s.final); if (!sh) return; let best = null;
  for (let k = 0; k < 36 && !best; k++) { const a = rng() * TAU, rr = 7 + rng() * 3, x = sh.x + Math.cos(a) * rr, z = sh.z + Math.sin(a) * rr, f = floorAt(x, z, sh.y + 2); if (f > -1e8 && Math.abs(f - (sh.y - 1.7)) < 2.5 && !solidPoint(x, f + 1.0, z)) best = [x, f, z]; }
  if (!best) { const f = floorAt(sh.x + 4, sh.z, sh.y + 2); if (f > -1e8) best = [sh.x + 4, f, sh.z]; } if (!best) return;
  const aff = act === 1 ? ['thorned', 'juggernaut'] : act === 2 ? ['shielded', 'vampiric'] : ['frozen', 'volatile'], e = rpgSpawnEnemy(id, best[0], best[2], { y: best[1], tier: 'guardian', aff, mlvl: rpgMonsterLevel({ act, diff: rpgDiffIdx(), idx: 3 }) + 1, seed: (rng() * 4294967296) >>> 0, aggroR: 30, r: 6 }); if (e) { e.rpg.actGuardian = act; MOBX.guardians = (MOBX.guardians | 0) + 1; }
}
const _mb_rpgSpawnAct2 = rpgSpawnAct; rpgSpawnAct = function () { _mb_rpgSpawnAct2(); try { mobSpawnAct(); } catch (err) { console.error('mobSpawnAct', err); } };
// rifts: the families the seed picked fill ~55% of the spawns; the guardian is one of the three boss patterns (by seed)
function mobRiftType(q) { const f = RIFT && RIFT.fams; if (!f || !f.length) return null; const r = rpgRng(rpgHashSeed(RIFT.seed, 0x600D + RIFT.spawned * 7)); if (r() > 0.55) return null; const pool = []; for (const id of f) for (const t of MOB_FAMILIES[id].mobs) pool.push(t); return pool[(r() * pool.length) | 0]; }
function mobGuardianType() { return MOB_BOSS_BY_ACT[1 + ((RIFT ? RIFT.seed : 0) % 3)] || 'g_thorn'; }
