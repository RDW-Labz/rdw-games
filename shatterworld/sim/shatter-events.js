// ============================================================================
// SHATTER EVENTS: the shockwave director. 'local' = regional pulse that heals itself (rewind); 'world' = act transition.
// ============================================================================
let SH = { on: false };
let act1Visible = true;
function setAct1Visible(v) {
  act1Visible = v; terrain.visible = v; water.visible = v; grass.visible = v; flowers.visible = v;
  for (const k in TREE_MESH) TREE_MESH[k].visible = v; scene.traverse(o => { if (o.userData.act1) o.visible = v; });
  act1Objects.forEach(o => o.visible = v); FAR.forEach(m => m.visible = v); for (const p of PIECES) p.mesh.visible = v && p.alive;
}
const act1Objects = [];
function updateDrops(dt) {
  if (dropActive) {
    let any = false; const k = Math.min(1, dt * 16);
    for (let ci = 0; ci < DROP.length; ci++) { const t = DROPT[ci]; if (FALLT[ci] < 1e8) continue; const d = DROP[ci]; if (d !== t) { const nd = d + (t - d) * k; DROP[ci] = Math.abs(nd - t) < 0.002 ? t : nd; any = true; } }
    dropActive = any || collapsing; texDrop.needsUpdate = true;
  }
  if (collapsing) {
    let any = false; const tt = SH.t || 0;
    for (let ci = 0; ci < DROP.length; ci++) { if (FALLT[ci] > tt) { if (FALLT[ci] < 1e8) any = true; continue; } if (DROP[ci] > 150) continue; DROPV[ci] += 38 * dt; DROP[ci] += DROPV[ci] * dt; any = true; }
    texDrop.needsUpdate = true; if (!any) collapsing = false;
  }
}
function resetDrops() { DROP.fill(0); DROPT.fill(0); DROPV.fill(0); FALLT.fill(1e9); collapsing = false; dropActive = true; texDrop.needsUpdate = true; }

function colCube(ci, ox, oz, power) {
  const i = ci % GRID, j = (ci / GRID) | 0, x = i - HALF + 0.5, z = j - HALF + 0.5, top = HQ[ci] - DROP[ci];
  const k = allocCube(); if (k < 0) return -1;
  setCubeTransform(k, x, top - 0.5, z, 1, CELLCOL[ci * 3], CELLCOL[ci * 3 + 1], CELLCOL[ci * 3 + 2]);
  let dx = x - ox, dz = z - oz; const dl = Math.hypot(dx, dz) + 0.001; dx /= dl; dz /= dl; const pw = power * (0.35 + Math.random() * 0.85);
  C.vx[k] = dx * pw + (Math.random() - 0.5) * 2.2; C.vz[k] = dz * pw + (Math.random() - 0.5) * 2.2; C.vy[k] = 3 + Math.random() * 7.5; C.wx[k] = (Math.random() - 0.5) * 9; C.wy[k] = (Math.random() - 0.5) * 9; C.wz[k] = (Math.random() - 0.5) * 9;
  C.owner[k] = ci; C.hx[k] = x; C.hy[k] = HQ[ci] - 0.5; C.hz[k] = z; C.vox[k] = 1; C.glow[k] = 1; C.tr[k] = C.r[k]; C.tg[k] = C.g[k]; C.tb[k] = C.b[k];
  writeCube(k); return k;
}

// ---- local shatter: a regional pulse (collecting a shard, or a ground-pound set-piece) -----------------------------------
function startLocalShatter(cx, cz, R) {
  if (SH.on) return; const T = TUNING.shatter;
  SH = { on: true, kind: 'local', t: 0, cx, cz, R, R1: 0, R2: 0, items: [], ci: 0, hi: 0, healStart: -1, spawned: [], finished: false };
  WV.x = cx; WV.z = cz; WV.R1 = 0.01; WV.R2 = -1; WV.band = T.band; WV.glow = 1; syncWave();
  const ci0 = Math.floor(cz + HALF) * GRID + Math.floor(cx + HALF);
  for (let j = Math.max(0, Math.floor(cz + HALF - R - 2)); j < Math.min(GRID, Math.ceil(cz + HALF + R + 2)); j++) for (let i = Math.max(0, Math.floor(cx + HALF - R - 2)); i < Math.min(GRID, Math.ceil(cx + HALF + R + 2)); i++) {
    const d = Math.hypot(i - HALF + 0.5 - cx, j - HALF + 0.5 - cz); if (d > R) continue; if (hash2(i, j) > Math.min(1, 0.6 * Q.cap / 14000 + 0.4)) continue;
    SH.items.push({ d, t: 0, ci: j * GRID + i });
  }
  for (const t of TREES) if (t.alive && Math.hypot(t.x - cx, t.z - cz) < R - 2 && TREE_MESH[t.type].visible) SH.items.push({ d: Math.hypot(t.x - cx, t.z - cz), t: 1, ref: t });
  for (const r of ROCKS) if (r.alive && Math.hypot(r.x - cx, r.z - cz) < R - 2) SH.items.push({ d: Math.hypot(r.x - cx, r.z - cz), t: 2, ref: r });
  SH.items.sort((a, b) => a.d - b.d);
  G.slow = 0.45; G.flash = 0.3; camShake(0.45); camCine(3.8, 1.9, 0.3, 0.05); sfx('shatter'); toast('SUN SHARD');
}
function updateLocalShatter(rdt) {
  const T = TUNING.shatter; SH.t += rdt;
  if (SH.R1 < SH.R + T.band * 1.4) SH.R1 += T.localSpeed * rdt; WV.R1 = SH.R1;
  while (SH.ci < SH.items.length && SH.items[SH.ci].d < SH.R1 - 4) {
    const it = SH.items[SH.ci++];
    if (it.t === 0) { const k = colCube(it.ci, SH.cx, SH.cz, 7); if (k >= 0) { it.k = k; DROPT[it.ci] = 1; dropActive = true; } }
    else if (it.t === 1) { shatterTree(it.ref, SH.cx, SH.cz, 9); }
    else shatterRock(it.ref, SH.cx, SH.cz, 8);
  }
  if (SH.ci >= SH.items.length && SH.R1 >= SH.R && SH.healStart < 0) SH.healStart = SH.t;
  if (SH.healStart >= 0 && SH.t > SH.healStart + T.healDelay) {
    if (SH.R2 === 0) { SH.R2 = 0.01; sfx('heal'); G.flash = 0.18; }
    SH.R2 += T.healSpeed * rdt; WV.R2 = SH.R2;
    while (SH.hi < SH.items.length && SH.items[SH.hi].d < SH.R2 + 8) {
      const it = SH.items[SH.hi++];
      if (it.t === 0 && it.k !== undefined) { const k = it.k; if (C.st[k] !== ST.FREE && C.owner[k] === it.ci) { C.rew[k] = 1; C.tx[k] = C.hx[k]; C.ty[k] = C.hy[k]; C.tz[k] = C.hz[k]; C.tr[k] = CELLCOL[it.ci * 3]; C.tg[k] = CELLCOL[it.ci * 3 + 1]; C.tb[k] = CELLCOL[it.ci * 3 + 2]; launchFly(k); C.vx[k] *= 0.3; C.vz[k] *= 0.3; } else DROPT[it.ci] = 0; }
      else if (it.t === 1 && it.ref.group) { for (const k of it.ref.group.cubes) if (C.owner[k] === it.ref.group.id && (C.st[k] === ST.BALL || C.st[k] === ST.REST)) { C.rew[k] = 1; C.tx[k] = C.hx[k]; C.ty[k] = C.hy[k]; C.tz[k] = C.hz[k]; C.tr[k] = C.r[k]; C.tg[k] = C.g[k]; C.tb[k] = C.b[k]; launchFly(k); } }
      else if (it.t === 2) { /* rocks: rewound on demand by the player */ }
    }
    if (SH.R2 > SH.R1 + T.band * 1.2 && SH.hi >= SH.items.length) { // done: switch the morph field off once the last cubes are home
      if (SH.R2 > SH.R + T.band * 2.5) { WV.R1 = -1; WV.R2 = -1; WV.glow = 0; syncWave(); SH.on = false; for (const t of TREES) if (t.group && !t.alive && SH.kind === 'local') { /* trees not rewound stay as debris until the player rewinds */ } }
    }
  }
  WV.glow = 1 - sstep(SH.R + 6, SH.R + 20, SH.R1) * 0.4; syncWave();
}

// ---- world shatter: act transition ------------------------------------------------------------------------------------
function startWorldShatter(from, to, cx, cy, cz) {
  const T = TUNING.shatter;
  SH = { on: true, kind: 'world', from, to, t: 0, cx, cy, cz, R1: 0, items: [], ci: 0, rebuilt: false, tReb: from === 1 ? 2.5 : 2.2, finished: false, plinth: [], pendingDone: 0 };
  G.trans = SH; WV.x = cx; WV.z = cz; WV.R1 = 0.01; WV.R2 = -1; WV.band = T.band; WV.glow = 1.2; syncWave();
  CS.ground = from === 1; CS.grav = from === 1 ? 24 : 5; CS.drag = from === 1 ? 0 : 0.5; CS.floorY = cy - 70;
  G.slow = T.slowmo; G.flash = 0.8; camShake(0.9); camCine(7.5, 2.1, 0.32, 0.07); sfx('shatter_big'); G.cine = 7.5; G.cineLock = false; toast('THE WORLD SHATTERS');
  if (from === 1) {
    const frac = clamp(Q.cap * 0.5 / (GRID * GRID * 0.62), 0.12, 1);
    for (let ci = 0; ci < GRID * GRID; ci++) { const i = ci % GRID, j = (ci / GRID) | 0, d = Math.hypot(i - HALF + 0.5 - cx, j - HALF + 0.5 - cz); if (d < T.plinth) { SH.plinth.push(ci); continue; } if (d > 62) continue; SH.items.push({ d, t: 0, ci, keep: hash2(i, j) < frac }); }
    const tList = TREES.filter(t => t.alive).map(t => ({ d: Math.hypot(t.x - cx, t.z - cz), t: 1, ref: t })).sort((a, b) => a.d - b.d); const tKeep = Math.floor(Q.cap * 0.28 / 200);
    tList.forEach((it, n) => { it.keep = n < tKeep; SH.items.push(it); });
    ROCKS.filter(r => r.alive).forEach((r, n) => SH.items.push({ d: Math.hypot(r.x - cx, r.z - cz), t: 2, ref: r, keep: n < Math.floor(Q.cap / 900) }));
    PIECES.filter(p => p.alive).forEach((p, n) => SH.items.push({ d: Math.hypot(p.x - cx, p.z - cz), t: 3, ref: p, keep: n < Math.floor(Q.cap / 500) }));
    SH.items.push({ d: 12, t: 4 }); // the static ruin/bridge/mill meshes
  } else {
    for (let i = 0; i < cubeHi; i++) if (C.st[i] === ST.SET || C.st[i] === ST.POP || C.st[i] === ST.HOMED) { const d = Math.hypot(C.x[i] - cx, C.z[i] - cz); if (d < T.plinth && C.y[i] > cy - 2.5) { C.owner[i] = -2; continue; } SH.items.push({ d, t: 5, k: i }); }
  }
  SH.items.sort((a, b) => a.d - b.d); SH.R1speed = T.worldSpeed;
  for (const e of ENEMIES) if (e.alive) e.poof = true;
}
function updateWorldShatter(rdt) {
  const T = TUNING.shatter; SH.t += rdt;
  SH.R1 += SH.R1speed * rdt * (SH.t < 1.5 ? 0.85 : 1.25); WV.R1 = SH.R1; WV.glow = 1.2 * (1 - sstep(2.8, 5.5, SH.t));
  // atmosphere crossfade: begins as the wave rolls, finishes shortly after the rebuild starts
  G.atmT = sstep(0.4, SH.tReb + 3.6, SH.t); setAtmosphere(SH.from, SH.to === 4 ? 3 : SH.to, SH.to === 4 ? 0 : G.atmT); applyAtmosphere(); skyMat.uniforms.uSkyVox.value = sstep(0.1, 1.6, SH.t) * (1 - sstep(SH.tReb + 1.5, SH.tReb + 4.5, SH.t)) * 0.9;
  while (SH.ci < SH.items.length && SH.items[SH.ci].d < SH.R1 - 5) {
    const it = SH.items[SH.ci++];
    if (it.t === 0) { DROPT[it.ci] = 1; dropActive = true; if (it.keep) { const k = colCube(it.ci, SH.cx, SH.cz, 9); if (k >= 0) { C.owner[k] = -4; } } FALLT[it.ci] = SH.t + 0.9 + it.d * 0.014 + hash2(it.ci, 5) * 0.5; collapsing = true; }
    else if (it.t === 1) { if (it.keep) { shatterTree(it.ref, SH.cx, SH.cz, 11); const g = it.ref.group; if (g) { for (const k of g.cubes) C.owner[k] = -4; HOMEG.delete(g.id); } } else { setTreeVisible(it.ref, false); puff(it.ref.x, it.ref.y + 3, it.ref.z, 5, 1.2, 0x5a9a30); } }
    else if (it.t === 2) { if (it.keep) { shatterRock(it.ref, SH.cx, SH.cz, 9); } else setRockVisible(it.ref, false); }
    else if (it.t === 3) { if (it.keep) shatterPiece(it.ref, SH.cx, SH.cz, 10); else { it.ref.mesh.visible = false; it.ref.alive = false; } }
    else if (it.t === 4) { act1Objects.forEach(o => o.visible = false); }
    else if (it.t === 5) { const k = it.k; if (C.st[k] !== ST.FREE && C.owner[k] !== -2) { vgSet(Math.floor(C.x[k]), Math.floor(C.y[k]), Math.floor(C.z[k]), 0); C.st[k] = ST.BALL; C.owner[k] = -4; let dx = C.x[k] - SH.cx, dz = C.z[k] - SH.cz; const dl = Math.hypot(dx, dz) + 0.01; const pw = 5 + Math.random() * 9; C.vx[k] = dx / dl * pw; C.vz[k] = dz / dl * pw; C.vy[k] = 3 + Math.random() * 9; C.wx[k] = (Math.random() - 0.5) * 9; C.wy[k] = (Math.random() - 0.5) * 9; C.wz[k] = (Math.random() - 0.5) * 9; C.vox[k] = 1; C.glow[k] = 1; } }
  }
  for (const e of ENEMIES) if (e.poof && e.alive && Math.hypot(e.x - SH.cx, e.z - SH.cz) < SH.R1 - 5) { e.alive = false; e.mesh.visible = false; puff(e.x, e.y + 0.5, e.z, 8, 1.2, 0xffd866); }
  if (!SH.rebuilt && SH.t >= SH.tReb) rebuildWorld();
  if (SH.rebuilt && !SH.finished) {
    if (SH.t > SH.tReb + 2 && CS.nFly === 0 && CS.nPend === 0) finishWorldShatter();
    else if (SH.t > SH.tReb + 16) finishWorldShatter();
  }
}
function finishWorldShatter() {
  SH.finished = true; WV.R1 = -1; WV.R2 = -1; WV.glow = 0; syncWave(); skyMat.uniforms.uSkyVox.value = 0; setAtmosphere(SH.to, SH.to, 0); applyAtmosphere(); updateEnv();
  if (SH.from === 1) { setAct1Visible(false); }
  G.trans = null; SH.on = false; G.cine = 0; CS.ground = false; onActReady(SH.to);
}

