// ============================================================================
// FINALE "BLOOM": every cube of the neon canyon streams home and re-forms the golden valley; a heal wave morphs voxel -> smooth
// ============================================================================
function finaleBegin() {
  const tgt = { x: SITES.s5.x, y: SITE_H.s5, z: SITES.s5.z - 3.4 }, T = TUNING.shatter;
  const F = { t: 0, from: { x: P.x, y: P.y, z: P.z }, to: tgt, ride: 3.6, healT0: 2.6, R2: 0, done: false, items: [], hi: 0, end: 0, victoryAt: -1 };
  SH.kind = 'finale'; SH.finale = F; G.finale = F; G.cineLock = true; P.vx = P.vy = P.vz = 0;
  clearEntities(); LV = null; VG.on = false; VG.data = null; DISCS.length = 0; WC.hf = true; GF = 1; CAM.roll = 0; CS.ground = true; CS.grav = 20; CS.drag = 0; CS.floorY = -90;
  // the valley comes back as lowered voxel columns...
  resetDrops(); setAct1Visible(true); for (const t of TREES) { setTreeVisible(t, true); t.group = null; } for (const r of ROCKS) setRockVisible(r, true); for (const p of PIECES) { p.alive = true; p.mesh.visible = true; if (p.box) p.box.on = true; }
  for (const b of BOXES) b.on = ACT1_BOXES.includes(b) && b.tag !== 'block';
  for (const b of BLOCKS) b.mesh.visible = false;
  WV.x = tgt.x; WV.z = tgt.z; WV.R1 = 1e5; WV.R2 = -1; WV.band = T.band; WV.glow = 0.6; syncWave();
  // columns ordered outward from the landing plateau; the kept fraction receives a flying cube, the rest are simply "already built"
  const frac = clamp(Q.cap * 0.5 / (GRID * GRID * 0.62), 0.12, 1), cols = [];
  for (let ci = 0; ci < GRID * GRID; ci++) { const i = ci % GRID, j = (ci / GRID) | 0, d = Math.hypot(i - HALF + 0.5 - tgt.x, j - HALF + 0.5 - tgt.z); cols.push({ ci, d, keep: hash2(i, j) < frac && d < 64 }); }
  cols.sort((a, b) => a.d - b.d);
  const pool = []; for (let i = 0; i < cubeHi; i++) { const s = C.st[i]; if (s === ST.BALL || s === ST.REST || s === ST.SET || s === ST.POP || s === ST.AMB || s === ST.HOMED) { if (s === ST.SET || s === ST.POP) { C.st[i] = ST.BALL; C.vx[i] = (Math.random() - 0.5) * 4; C.vy[i] = 2 + Math.random() * 4; C.vz[i] = (Math.random() - 0.5) * 4; C.wx[i] = (Math.random() - 0.5) * 6; C.wy[i] = (Math.random() - 0.5) * 6; C.wz[i] = (Math.random() - 0.5) * 6; } pool.push(i); } else if (s === ST.STRM || s === ST.ROT) freeCube(i); }
  for (let i = pool.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
  let pi = 0;
  for (const c of cols) {
    const ci = c.ci; if (!c.keep) { DROPT[ci] = 0; DROP[ci] = 0; continue; } DROP[ci] = 1; DROPT[ci] = 1; if (pi >= pool.length) { DROPT[ci] = 0; DROP[ci] = 0; continue; }
    const k = pool[pi++], i = ci % GRID, j = (ci / GRID) | 0, x = i - HALF + 0.5, z = j - HALF + 0.5;
    C.rew[k] = 1; C.tx[k] = x; C.ty[k] = HQ[ci] - 0.5; C.tz[k] = z; C.hx[k] = x; C.hy[k] = HQ[ci] - 0.5; C.hz[k] = z; C.tr[k] = CELLCOL[ci * 3]; C.tg[k] = CELLCOL[ci * 3 + 1]; C.tb[k] = CELLCOL[ci * 3 + 2]; C.owner[k] = ci; C.ts[k] = 1;
    C.delay[k] = 0.2 + Math.pow(c.d / 60, 0.8) * 4.2 + Math.random() * 0.4; if (C.st[k] === ST.HOMED || C.st[k] === ST.SET) C.st[k] = ST.BALL; C.grp[k] = -1; C.tgl[k] = 0;
  }
  for (; pi < pool.length; pi++) { const k = pool[pi]; if (pi - pool.length > -2500 && Math.random() < 0.9) { C.tx[k] = tgt.x + (Math.random() - 0.5) * 110; C.ty[k] = HT(tgt.x, tgt.z) + 8 + Math.random() * 34; C.tz[k] = tgt.z + (Math.random() - 0.5) * 110; C.ts[k] = 0.15 + Math.random() * 0.3; C.tr[k] = 1; C.tg[k] = 0.85 + Math.random() * 0.15; C.tb[k] = 0.5 + Math.random() * 0.5; C.tgl[k] = 0.3; C.owner[k] = -3; C.wy[k] = Math.random() * 20; C.wx[k] = Math.random() * 6; C.wz[k] = Math.random() * 6; C.delay[k] = 0.5 + Math.random() * 3; C.rew[k] = 0; C.st[k] = ST.BALL; } else { C.st[k] = ST.DIE; C.age[k] = -Math.random() * 2; } }
  // props wake up as the heal front passes
  for (const t of TREES) F.items.push({ d: Math.hypot(t.x - tgt.x, t.z - tgt.z), t });
  F.items.sort((a, b) => a.d - b.d);
  camCine(18, 2.5, 0.34, 0.05); sfx('rebuild'); toast('THE WORLD BLOOMS');
}
function updateFinale(rdt) {
  const F = SH.finale, T = TUNING.shatter; F.t += rdt;
  G.atmT = sstep(0.3, 6, F.t); setAtmosphere(3, 1, G.atmT); applyAtmosphere(); skyMat.uniforms.uSkyVox.value = 0.9 * sstep(0.1, 1, F.t) * (1 - sstep(4, 7, F.t));
  // the hero rides a glowing ring down to the plateau
  const e = sstep(0, 1, clamp(F.t / F.ride, 0, 1)); P.x = lerp(F.from.x, F.to.x, e); P.z = lerp(F.from.z, F.to.z, e); P.y = lerp(F.from.y, F.to.y, e) + Math.sin(e * PI) * 2.0; P.gy = P.y; P.vx = P.vy = P.vz = 0; P.grounded = true; P.act = 'ground';
  if (F.t < F.ride && Math.random() < 0.5) puff(P.x, P.y + 0.05, P.z, 1, 0.6, 0xffe9a0, 1.5, 0.5, 0.8);
  if (F.t > F.ride) { P.victory = 1; P.y = F.to.y; P.gy = P.y; }
  if (F.t > F.healT0) { if (F.R2 === 0) { F.R2 = 0.01; sfx('heal'); G.flash = 0.3; } F.R2 += 20 * rdt; WV.R2 = F.R2; }
  WV.glow = 0.7 * (1 - sstep(8, 12, F.t));
  if (F.R2 > 135 && !F.done) { F.done = true; F.end = F.t; WV.R1 = -1; WV.R2 = -1; WV.glow = 0; skyMat.uniforms.uSkyVox.value = 0; updateEnv(); CS.ground = true; }
  syncWave();
  if (F.done && F.t > F.end + 5.5 && G.state === 'play') { G.trans = null; G.finale = null; SH.on = false; P.victory = 0; victory(); }
}

