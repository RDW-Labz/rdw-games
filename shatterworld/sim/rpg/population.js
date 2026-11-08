// ---- campaign population: levels for the original enemies, plus extra spawns, chests and crates (seeded per act) -----------------------------------------------------------------
function rpgSpot(rng, anchors, used, o) {
  for (let tries = 0; tries < 40; tries++) {
    const a = anchors[(rng() * anchors.length) | 0], ang = rng() * TAU, rr = 1 + rng() * 2.4, x = a[0] + Math.cos(ang) * rr, z = a[2] + Math.sin(ang) * rr, f = floorAt(x, z, a[1] + 1.6);
    if (!(f > -1e8) || Math.abs(f - a[1]) > 2.2 || solidPoint(x, f + 0.9, z) || (G.act === 1 && f < WATER_Y + 0.2) || Math.hypot(x - P.x, z - P.z) < (o.minHero || 11)) continue;
    if (NPC.active && Math.hypot(x - NPC.x, z - NPC.z) < 6) continue; let ok = true; for (const u of used) if (Math.hypot(u[0] - x, u[2] - z) < (o.space || 3.4)) { ok = false; break; } if (!ok) continue;
    const s = [x, f, z]; used.push(s); return s;
  }
  return null;
}
function rpgScatter(rng, out, n) { // extra floor anchors: terrain samples in the valley, headroom-checked top cubes in the block worlds
  if (WC.hf && !VG.on) { for (let i = 0; i < n * 3 && out.length < n + 20; i++) { const x = (rng() * 2 - 1) * 56, z = (rng() * 2 - 1) * 56, y = HT(x, z); if (y > WATER_Y + 0.35 && terrSlope(x, z) < 0.55) out.push([x, y, z]); } return; }
  if (LV && LV.vb && LV.surf) { const vb = LV.vb, s = LV.surf, O = LV.O; for (let i = 0; i < n * 8 && out.length < n + 20; i++) { const k = (rng() * s.n) | 0, x = s.x[k], y = s.y[k], z = s.z[k]; if (vb.get(x, y + 1, z) || vb.get(x, y + 2, z) || vb.get(x, y + 3, z)) continue; out.push([O.x + x + 0.5, O.y + y + 1, O.z + z + 0.5]); } }
}
function rpgSpawnAct() {
  const act = G.act, diff = rpgDiffIdx(), TC = RPG_TUNING.campaign, rng = rpgRng(rpgHashSeed(RP.seed ^ 0x51ED, act * 977 + diff * 31 + 7));
  let idx = 0; for (const e of ENEMIES) if (!e.rpg) { const tier = idx === 3 && rng() < 0.6 ? 'champion' : 'normal'; rpgDecorate(e, { idx, tier, seed: (rng() * 4294967296) >>> 0 }); idx++; }
  const anchors = []; for (const c of COINS) if (c.alive && !c.pop) anchors.push([c.x, c.y - 1, c.z]); for (const e of ENEMIES) if (e.alive && !e.ceil) anchors.push([e.hx, e.y, e.hz]);
  rpgScatter(rng, anchors, act === 1 ? 160 : 220); if (!anchors.length) return;
  const used = ENEMIES.filter(e => e.alive).map(e => [e.x, e.y, e.z]);
  for (let i = 0; i < TC.extraPerAct[act]; i++) {
    const r = rng(), forced = i === 0, big = forced || r < TC.elite + TC.champion, s = rpgSpot(rng, anchors, used, { minHero: big ? 20 : 12 }); if (!s) continue; const tier = forced ? 'elite' : r < TC.elite ? 'elite' : r < TC.elite + TC.champion ? 'champion' : 'normal', q = rng();
    const type = forced ? (act >= 2 && rng() < 0.6 ? 'brute' : rng() < 0.5 ? 'hopper' : 'walker') : q < TC.brute ? 'brute' : q < TC.brute + TC.hopper ? 'hopper' : q < TC.brute + TC.hopper + TC.spitter ? 'spitter' : rng() < 0.35 ? 'shell' : 'walker';
    rpgSpawnEnemy(type, s[0], s[2], { y: s[1], idx: idx++, tier, seed: (rng() * 4294967296) >>> 0, r: 2.5 + rng() * 2 });
  }
  // chests: the first one of each act is the guaranteed ACT CHEST (placed far from the start)
  const nCh = TC.chests[act]; let far = null, fd = -1; for (let k = 0; k < 24; k++) { const s = rpgSpot(rng, anchors, used.slice(), { space: 5, minHero: 18 }); if (s) { const d = Math.hypot(s[0] - P.x, s[2] - P.z); if (d > fd) { fd = d; far = s; } } }
  if (far) { used.push(far); rpgAddChest(far[0], far[1], far[2], true, act + 'a'); if (!RT.runFlags['c' + act + 'a']) rpgLogLine('An act chest glimmers somewhere in this world', '#ffd84a'); }
  for (let i = 1; i < nCh; i++) { const s = rpgSpot(rng, anchors, used, { space: 5, minHero: 8 }); if (s) rpgAddChest(s[0], s[1], s[2], false, act + 'c' + i); }
  for (let i = 0; i < TC.crates[act]; i++) { const s = rpgSpot(rng, anchors, used, { space: 3, minHero: 6 }); if (s) rpgAddCrate(s[0], s[1], s[2], act + 'k' + i); }
}
function rpgPending() { if (RT.pend && !RIFT && !G.trans && !SH.on && !G.finale && G.state === 'play') { const p = RT.pend; RT.pend = null; if (p.act === G.act) rpgSpawnAct(); } }

