// ---- SHATTER RIFTS: seeded arena runs built with the same voxel-level machinery as acts 2 / 3 ---------------------------------------------------------------------------
const RIFT_SETS = [ // palettes: {top a, top b, soil, stone, glow}
  { a: [0.1, 0.78, 0.8], b: [0.92, 0.16, 0.62], soil: [0.22, 0.1, 0.38], stone: [0.34, 0.16, 0.55], glow: [0.2, 1, 0.9] }, { a: [1, 0.55, 0.2], b: [0.85, 0.2, 0.15], soil: [0.3, 0.12, 0.1], stone: [0.45, 0.2, 0.14], glow: [1, 0.7, 0.2] },
  { a: [0.72, 0.92, 1], b: [0.45, 0.7, 1], soil: [0.3, 0.4, 0.6], stone: [0.45, 0.55, 0.75], glow: [0.6, 0.95, 1] }, { a: [0.55, 0.95, 0.3], b: [0.25, 0.7, 0.35], soil: [0.2, 0.3, 0.15], stone: [0.35, 0.28, 0.4], glow: [0.8, 1, 0.3] },
];
function buildRiftArena(O, rift) {
  const L = mkLevel(rift.theme, O), vb = L.vb; L.cellGroup = new Map(); const rng = rpgRng(rift.seed ^ 0xA11CE), R = RPG_TUNING.rift.arena + ((rng() * 4) | 0), fragile = rift.mods.includes('fragile'), S = RIFT_SETS[(rng() * RIFT_SETS.length) | 0];
  const PA = vb.addPal(...S.a), PB = vb.addPal(...S.b), SO = vb.addPal(...S.soil), ST = vb.addPal(...S.stone), GL = vb.addPal(S.glow[0], S.glow[1], S.glow[2], 10.9); L.pal = { WT: GL }; L.arenaR = R;
  if (fragile) { // thin two-layer floor of 3x3 tiles; every tile is a breakable group (the same groups bridge planks use), rewind restores them
    const gid = new Map(); let gi = 0, ph = rng() * 6;
    for (let x = -R - 3; x <= R + 3; x++) for (let z = -R - 3; z <= R + 3; z++) {
      const d = Math.hypot(x + 0.5, z + 0.5), ang = Math.atan2(z + 0.5, x + 0.5), rr = R * (1 + 0.08 * Math.sin(ang * 3 + ph) + 0.05 * Math.sin(ang * 5 + ph * 2)); if (d >= rr || d < 4.4) continue;
      const tx = Math.floor(x / 3), tz = Math.floor(z / 3), tk = tx + ',' + tz; let g = gid.get(tk); if (g === undefined) { g = gi++; gid.set(tk, g); L.groups[g] = { cells: [], cubes: [], broken: false, id: g }; }
      for (const y of [-2, -1]) { vb.set(x, y, z, y === -1 ? (((tx + tz) & 1) ? PA : PB) : SO); L.groups[g].cells.push([x, y, z]); L.cellGroup.set(levelCellKey(x, y, z), g); }
    }
    vb.cyl(0, 0, -4, 0, 4.6, ST, (x, y, z) => y === -1 ? (Math.hypot(x + 0.5, z + 0.5) > 3.4 ? GL : (((x + z) & 1) ? PA : PB)) : ST);
  } else {
    island(vb, 0, 0, 0, R, 7, { top: [PA, PB], soil: SO, stone: ST }, 1 + ((rng() * 6) | 0));
    vb.cyl(0, 0, -1, 0, 5.2, PA, (x, y, z) => Math.hypot(x + 0.5, z + 0.5) > 4.1 ? GL : (((x + z) & 1) ? PA : PB));
  }
  const nP = 4 + ((rng() * 3) | 0); for (let i = 0; i < nP; i++) { const a = (i / nP) * TAU + rng() * 0.6, rr = 9 + rng() * (R - 14), px = Math.round(Math.cos(a) * rr), pz = Math.round(Math.sin(a) * rr), h = 3 + ((rng() * 4) | 0); vb.cyl(px, pz, 0, h, 1.5, ST, (x, y, z) => y === h - 1 ? GL : (y % 3 === 0 ? PB : ST)); }
  for (let i = 0; i < 3; i++) { const a = rng() * TAU, rr = 10 + rng() * (R - 15), cx = Math.round(Math.cos(a) * rr), cz = Math.round(Math.sin(a) * rr); vb.box(cx - 3, 0, cz - 3, cx + 3, 1, cz + 3, PA); vb.box(cx - 2, 1, cz - 2, cx + 2, 2, cz + 2, PB); }
  for (let k = 0; k < 150; k++) { if (k % 15 < 2) continue; const a = k / 150 * TAU, x = Math.round(Math.cos(a) * (R - 1.3)), z = Math.round(Math.sin(a) * (R - 1.3)); if (vb.get(x, -1, z) && !vb.get(x, 0, z)) { vb.set(x, 0, z, ST); if (k % 3 === 0) vb.set(x, 1, z, GL); } }
  L.start = { x: 0.5, y: 0, z: 0.5 }; L.deathY = -40; L.name = 'SHATTER RIFT'; if (rift.mods.includes('lowgrav')) L.lowg.push({ x: O.x, y: O.y + 6, z: O.z, r: 140 });
  return L;
}
function rpgBreakTile(g) { // breakGroup() without the "bridge" toast; the same rewind-able debris
  g.broken = true; const id = 400000 + g.id, grp = { id, need: g.cubes.length, back: 0, done: false, cubes: g.cubes.slice(), restore: () => { for (const c of g.cubes) { if (C.owner[c] !== id) continue; C.x[c] = C.tx[c]; C.y[c] = C.ty[c]; C.z[c] = C.tz[c]; C.vx[c] = C.vy[c] = C.vz[c] = 0; C.qx[c] = C.qy[c] = C.qz[c] = 0; C.qw[c] = 1; C.st[c] = ST.SET; C.owner[c] = -1; C.rew[c] = 0; vgSet(Math.floor(C.tx[c]), Math.floor(C.ty[c]), Math.floor(C.tz[c]), 1); writeCube(c); cubesDirty = true; } g.broken = false; HOMEG.delete(id); } }; HOMEG.set(id, grp);
  for (const c of g.cubes) { if (C.st[c] === ST.FREE) continue; vgSet(Math.floor(C.tx[c]), Math.floor(C.ty[c]), Math.floor(C.tz[c]), 0); C.st[c] = ST.BALL; C.owner[c] = id; C.hx[c] = C.tx[c]; C.hy[c] = C.ty[c]; C.hz[c] = C.tz[c]; C.vx[c] = (Math.random() - 0.5) * 3; C.vz[c] = (Math.random() - 0.5) * 3; C.vy[c] = 1 + Math.random() * 3; C.wx[c] = (Math.random() - 0.5) * 8; C.wy[c] = (Math.random() - 0.5) * 8; C.wz[c] = (Math.random() - 0.5) * 8; C.glow[c] = 0.4; C.delay[c] = 0; C.rew[c] = 0; }
  CS.grav = 22; CS.drag = 0; sfx('shatter_small'); camShake(0.3);
}
function rpgStartRift(tier, seed) {
  tier = sat(tier | 0 || 1, 1, RPG_TUNING.rift.maxTier); seed = (seed == null ? (dseed() & 0xFFFFFF) | 1 : seed) >>> 0; const spec = rpgRiftSpec(tier, seed);
  if (!G.started) G.started = true; audioInit(); for (const id of ['menu', 'dead', 'pause']) $(id).classList.add('hidden'); $('hud').classList.remove('hidden');
  if (RUI.open) { RUI.open = false; $('inv').classList.add('hidden'); } if (PK.open) { PK.open = false; $('perkpick').classList.add('hidden'); }
  rpgVacuum(); RT_TIMERS.length = 0; for (const p of PROJ) { p.on = false; p.m.visible = false; } RIFT = null; clearEntities(); RT.pend = null;
  Object.assign(RUN, { xp: 0, kills: 0, elites: 0, loot: [0, 0, 0, 0], gold: 0, dust: 0, lvStart: RP.level, levels: 0, legends: [], salv: 0, shards: 0 }); RT.runFlags = {}; RT.runDiff = RP.diff;
  RIFT = { ...spec, fams: mobRiftFamilies(seed, tier), t: 0, prog: 0, kills: 0, spawned: 0, phase: 'fight', guardian: null, spawnT: 0.8, rng: rpgRng(seed ^ 0xC0FFEE), done: false, won: false, theme: (seed & 1) ? 3 : 2, tileT: {}, endAt: 0, gT: 0 };
  freeAllCubes(); HOMEG.clear(); DISCS.length = 0; SH = { on: false }; G.trans = null; G.finale = null; WV.R1 = -1; WV.R2 = -1; syncWave(); setAct1Visible(false); WC.hf = false; GF = 1; CAM.roll = 0; for (const b of BOXES) b.on = false; CS.ground = false; CS.grav = 5; CS.drag = 0.5; CS.floorY = -90;
  const O = { x: 0, y: 24, z: 0 }; LV = buildRiftArena(O, RIFT); instantBuild(LV); G.act = RIFT.theme; G.shards = 0; G.shardsTotal = 0; setAtmosphereInstant(RIFT.theme); G.ck = null;
  G.won = false; G.t = 0; G.slow = 1; G.cine = 0; CAM.cine = 0; G.state = 'play'; resetHero({ x: O.x + LV.start.x, y: O.y + LV.start.y, z: O.z + LV.start.z }); P.yaw = 0; CAM.yaw = 0; CAM.pitch = 0.3; updateHUD(); rpgRecalc(); rpgHealFull(); RT.rw = RT.rwMax;
  G.flash = 0.7; camShake(0.5); camCine(2.4, 1.6, 0.2, 0.05); rsfx('rift'); sparkBurst(P.x, P.y + 1, P.z, 30, 0x53e0d0, 9); fxRing(P.x, P.y, P.z, 0.5, 14, 1.2, 0x53e0d0, 1);
  rpgBanner('SHATTER RIFT', 'TIER ' + tier + '  ·  SEED ' + hexSeed(seed)); rpgLogLine('Modifiers: ' + spec.mods.map(m => RPG_RIFT_MODS[m].name).join(', '), '#ffb15e'); requestLock(); RP.riftTier = tier; RP.riftSeed = seed; RT.dirty = true;
  rpgRiftSpawn(Math.min(6, 3 + (tier >> 1)));
}
function rpgRiftSpawn(n) {
  const R = RPG_TUNING.rift, O = LV.O, sw = RIFT.mods.includes('swarm');
  for (let k = 0; k < n; k++) {
    let x = 0, z = 0, y = 0, ok = false; for (let tries = 0; tries < 14 && !ok; tries++) { const a = RIFT.rng() * TAU, rr = 6 + RIFT.rng() * (LV.arenaR - 8); x = O.x + Math.cos(a) * rr; z = O.z + Math.sin(a) * rr; y = floorAt(x, z, O.y + 14); if (y > -1e8 && y > O.y - 3 && Math.hypot(x - P.x, z - P.z) > 9) ok = true; } if (!ok) continue;
    const r = RIFT.rng(), eliteP = (R.eliteBase + R.elitePerTier * RIFT.tier) * (sw ? 3 : 1), tier = r < eliteP ? 'elite' : r < eliteP + R.champion * (sw ? 1.4 : 1) ? 'champion' : 'normal', q = RIFT.rng();
    const type = mobRiftType(q) || (q < 0.32 ? 'walker' : q < 0.44 ? 'shell' : q < 0.6 ? 'hopper' : q < 0.76 ? 'spitter' : 'brute');
    rpgSpawnEnemy(type, x, z, { y, mlvl: RIFT.mlvl + (RIFT.spawned % 3), tier, idx: RIFT.spawned, aggroR: 16, r: 5 }); RIFT.spawned++; fxRing(x, y, z, 0.3, 2.2, 0.5, 0xc28cff, 0.7); puff(x, y + 0.4, z, 5, 0.8, 0xc28cff, 2);
  }
}
function rpgRiftKill(e) {
  if (RIFT.done || e.rpg.minion) return; if (e.rpg.guardian) { RIFT.phase = 'victory'; RIFT.gT = 0; RIFT.guardian = null; for (const o of ENEMIES) if (o.alive && o !== e && o.state !== 'dead') { o.alive = false; o.mesh.visible = false; puff(o.x, o.y + 0.5, o.z, 6, 1, 0xffd866); } rsfx('riftwin'); camShake(0.6); G.flash = 0.4; G.slow = 0.35; rpgBanner('GUARDIAN DOWN', 'COLLECT YOUR REWARDS'); return; }
  RIFT.kills++; RIFT.prog += e.rpg.tier === 'elite' ? 4 : e.rpg.tier === 'champion' ? 2 : 1;
}
function rpgRiftTick(dt) {
  if (!RIFT || RIFT.done || !LV) return; const R = RPG_TUNING.rift;
  if (RIFT.phase === 'victory') { RIFT.gT += dt; if (RIFT.gT > 2.6) rpgRiftEnd(true); return; }
  RIFT.t += dt; if (RIFT.t >= RIFT.limit) { rpgRiftEnd(false, 'time'); return; }
  if (RIFT.mods.includes('fragile') && P.grounded && !P.dead) { const k = levelCellKey(Math.floor(P.x) - LV.O.x, Math.floor(P.y - 0.02) - 1 - LV.O.y, Math.floor(P.z) - LV.O.z), g = LV.cellGroup.get(k); if (g !== undefined) { const gr = LV.groups[g]; if (gr && !gr.broken) { RIFT.tileT[g] = (RIFT.tileT[g] || 0) + dt; for (const c of gr.cubes) { C.glow[c] = 0.5 + 0.5 * Math.sin(RIFT.t * 30); writeCube(c); } cubesDirty = true; if (RIFT.tileT[g] > 0.85) { rpgBreakTile(gr); RIFT.tileT[g] = 0; } } } else { /* stepping on solid ground */ } }
  let alive = 0; for (const e of ENEMIES) if (e.alive && e.state !== 'dead' && e.state !== 'squash' && e.rpg && !e.rpg.minion) alive++;
  if (RIFT.phase === 'fight') {
    RIFT.spawnT -= dt; const sw = RIFT.mods.includes('swarm'), maxAlive = Math.round(R.alive + R.alivePerTier * RIFT.tier) + (sw ? 6 : 0);
    if (RIFT.spawnT <= 0 && alive < maxAlive) { rpgRiftSpawn(sw ? 2 : 1); RIFT.spawnT = R.every * (sw ? 0.6 : 1) * (alive < 3 ? 0.4 : 1); }
    if (RIFT.prog >= RIFT.need) { RIFT.phase = 'guardian'; for (const o of ENEMIES) if (o.alive && o.state !== 'dead' && o.state !== 'squash') { o.alive = false; o.mesh.visible = false; puff(o.x, o.y + 0.5, o.z, 8, 1, 0xffd866); }
      const a = Math.atan2(P.z - LV.O.z, P.x - LV.O.x) + PI, gx = LV.O.x + Math.cos(a) * 11, gz = LV.O.z + Math.sin(a) * 11, gy = floorAt(gx, gz, LV.O.y + 14);
      const g = rpgSpawnEnemy(mobGuardianType(), gx, gz, { y: gy > -1e8 ? gy : LV.O.y, tier: 'guardian', mlvl: RIFT.mlvl + 3, aggroR: 60, r: 8, seed: RIFT.seed }); if (g) { g.rpg.guardian = true; RIFT.guardian = g; } rsfx('elite'); rsfx('windup'); G.flash = 0.35; camShake(0.6); rpgBanner('THE GUARDIAN AWAKENS', g ? g.rpg.name.toUpperCase() : ''); }
  } else if (RIFT.phase === 'guardian') {
    RIFT.spawnT -= dt; if (RIFT.spawnT <= 0 && alive < 5) { rpgRiftSpawn(1); RIFT.spawnT = 7; }
  }
}
function rpgRiftEnd(win, why) {
  if (!RIFT || RIFT.done) return; RIFT.done = true; RIFT.won = win; const tier = RIFT.tier; document.exitPointerLock && document.exitPointerLock();
  if (win) { RP.bestRift = Math.max(RP.bestRift, tier); RP.totals.rifts++; const mlvl = RIFT.mlvl; rpgGainXp(rpgObjectiveXp('rift', mlvl, 0, RP.level) * RPG_TUNING.rift.xpMul, 'rift'); rpgVacuum(); RP.riftTier = Math.min(RPG_TUNING.rift.maxTier, tier + 1); RP.riftSeed = 0; }
  else rpgVacuum(); rpgSaveNow(); G.state = 'dead'; G.won = false; rsfx(win ? 'riftwin' : 'riftlose');
  const d = $('dead'); d.className = win ? 'ovl' : 'ovl lose'; $('deadT').textContent = win ? 'RIFT CLEARED' : (why === 'time' ? 'TIME EXPIRED' : 'RIFT LOST');
  $('deadS').innerHTML = `Tier ${tier} &middot; seed ${hexSeed(RIFT.seed)} &middot; ${fmtTime(RIFT.t)}`;
  $('cta2').textContent = win ? 'NEXT TIER' : 'RETRY'; d.classList.remove('hidden'); rpgDeadExtras(); G.slow = 1;
}
function rpgRiftRestart(sameSeed, nextTier) { if (!RIFT) return; const t = nextTier ? Math.min(RPG_TUNING.rift.maxTier, RIFT.tier + 1, RP.bestRift + 1) : RIFT.tier; rpgStartRift(t, sameSeed ? RIFT.seed : null); }

