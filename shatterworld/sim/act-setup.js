// ---- act setup ---------------------------------------------------------------------------------------------------------------
function clearEntities() {
  for (const s of SHARDS) scene.remove(s.mesh); SHARDS.length = 0; COINS.length = 0; coinMesh.count = 0;
  for (const b of BLOCKS) { scene.remove(b.mesh); if (b.box) b.box.on = false; } BLOCKS.length = 0;
  for (const e of ENEMIES) scene.remove(e.mesh); ENEMIES.length = 0; for (const p of POWERUPS) scene.remove(p.mesh); POWERUPS.length = 0;
  for (const m of lowgMeshes) scene.remove(m); lowgMeshes.length = 0; NPC.active = false; NPC.talkT = 0; $('talk').classList.remove('on'); P.talk = 0;
}
const SHARD_ORDER_1 = ['s1', 's2', 's3', 's4', 's5'];
function act1Shard(k) { const S = SITES[k]; switch (k) { case 's1': return [S.x, SITE_H.s1 + 1.7, S.z]; case 's2': return [S.x, 3.15 + 1.7, S.z]; case 's3': return [S.x, SITE_H.s3 + 1.7, S.z]; case 's4': return [S.x + 0.2, SITES.s4.top + 1.7, S.z + 2.6]; default: return [S.x, SITE_H.s5 + 0.28 + 1.7, S.z]; } }
function setupAct1Entities() {
  clearEntities(); G.act = 1; G.shards = 0; G.shardsTotal = 5;
  SHARD_ORDER_1.forEach((k, i) => { const [x, y, z] = act1Shard(k); const s = addShard(x, y, z, k === 's5', { id: i }); if (G.flags[1][i]) { s.got = true; s.mesh.visible = false; G.shards++; } });
  // coins along the path, blocks, enemies, the twin
  const arc = (x, z, n, dx, dz, h) => { for (let i = 0; i < n; i++) { const t = i / (n - 1); addCoin(x + dx * t, HT(x + dx * t, z + dz * t) + 1.0 + Math.sin(t * PI) * h, z + dz * t); } };
  arc(-23, -41, 6, 1, 8, 1.6); arc(-20, -30, 5, -2, 6, 1.4); arc(-16, -14, 6, 8, 8, 1.6); arc(2, 1.2, 7, 0, 0.1, 0); arc(26, 5, 5, 6, 5, 1.8); arc(37, 22, 6, 0, 10, 1.5); arc(28, 41, 5, -8, -1, 1.4); arc(10, 40, 6, -12, -3, 1.6);
  for (let i = 0; i < 7; i++) { const a = i / 7 * TAU, x = SITES.s1.x + Math.cos(a) * 3.2, z = SITES.s1.z + Math.sin(a) * 3.2; addCoin(x, SITE_H.s1 + 1.0, z); }
  addBlock(-22.5, HT(-22.5, -40) + 3.4, -40, 'mushroom'); addBlock(-21.5, HT(-21.5, -40) + 3.4, -40, 'coin'); addBlock(-20.5, HT(-20.5, -40) + 3.4, -40, 'coin');
  addBlock(30, HT(30, 22) + 3.4, 22, 'coin'); addBlock(31, HT(31, 22) + 3.4, 22, 'mushroom'); addBlock(-14, HT(-14, 22) + 3.4, 22, 'coin');
  [[-19, -36, 3], [-12, -18, 4], [-3, -6, 3], [24, 6, 4], [34, 26, 3], [24, 38, 4]].forEach(([x, z, r], i) => addEnemy({ type: i % 3 === 2 ? 'shell' : 'walker', x, y: HT(x, z), z, r }));
  NPC.active = true; NPC.x = -20.6; NPC.z = -44.2; NPC.y = HT(NPC.x, NPC.z); NPC.base = -2.3; NPC.yaw = undefined; NPC.line = -1;
  NPC.lines = ['Hello! I am the Plumber\'s twin. Golden Sun Shards are scattered across this valley. Follow the beams of light!', 'Ground-pound (Z in the air) shatters trees, rocks and walls into blocks. Hold RMB and they fly back together.', 'Collect a shard and the world pulses between smooth and blocky. Five shards will break the valley open completely...'];
  updateHUD();
}
function setupLevelEntities(L) {
  clearEntities(); G.act = L.act; G.shardsTotal = ACT_SHARDS[L.act]; G.shards = 0; const O = L.O;
  for (const b of BOXES) if (b.on && b.tag !== 'tree') { } // act-1 boxes already disabled
  L.shards.forEach((s, i) => { const sh = addShard(O.x + s.x, O.y + s.y, O.z + s.z, !!s.final, { id: i, flip: !!s.ceil }); if (G.flags[L.act][i]) { sh.got = true; sh.mesh.visible = false; G.shards++; } });
  for (const c of L.coins) addCoin(O.x + c[0], O.y + c[1], O.z + c[2]);
  for (const b of L.blocks) addBlock(O.x + b.x, O.y + b.y, O.z + b.z, b.item);
  for (const e of L.enemies) addEnemy({ type: e.type, x: O.x + e.x, y: O.y + e.y, z: O.z + e.z, r: e.r, ceil: e.ceil });
  for (const p of L.pipes) { p.x += O.x; p.y += O.y; p.z += O.z; }
  for (const p of L.pads) { p.x += O.x; p.y += O.y; p.z += O.z; if (!p.fixed) { p.fixed = true; } }
  for (const g of L.lowg) { g.x += O.x; g.y += O.y; g.z += O.z; const m = new THREE.Mesh(new THREE.SphereGeometry(g.r, 28, 18), lowgMat); m.position.set(g.x, g.y, g.z); scene.add(m); lowgMeshes.push(m); }
  if (L.npc) { NPC.active = true; NPC.x = O.x + L.npc.x; NPC.y = O.y + L.npc.y; NPC.z = O.z + L.npc.z; NPC.base = PI; NPC.yaw = undefined; NPC.lines = L.hints; NPC.line = -1; }
  for (const lp of L.lamps) { }
  updateHUD();
}
function makeAct1Colliders() { }
let ACT1_BOXES = [];

function setAtmosphereInstant(a) { setAtmosphere(a, a, 0); applyAtmosphere(); skyMat.uniforms.uSkyVox.value = 0; updateEnv(); G.atmT = 1; }
function resetAct1World() {
  freeAllCubes(); for (const t of TREES) { setTreeVisible(t, true); t.group = null; } for (const r of ROCKS) setRockVisible(r, true); for (const p of PIECES) { p.alive = true; p.mesh.visible = true; if (p.box) p.box.on = true; }
  HOMEG.clear(); resetDrops(); setAct1Visible(true); WV.R1 = -1; WV.R2 = -1; WV.glow = 0; syncWave(); VG.on = false; VG.data = null; DISCS.length = 0; WC.hf = true; GF = 1; CAM.roll = 0; SH = { on: false }; G.trans = null; collapsing = false; CS.ground = true; CS.grav = 26; CS.drag = 0; CS.floorY = -90;
  for (const b of BOXES) { if (b.tag === 'block') b.on = false; else if (ACT1_BOXES.includes(b)) b.on = true; }
  skyMat.uniforms.uSkyVox.value = 0; LV = null;
}
function loadAct(n, pos) {
  if (n === 1) { resetAct1World(); setAtmosphereInstant(1); setupAct1Entities(); }
  else {
    freeAllCubes(); HOMEG.clear(); DISCS.length = 0; SH = { on: false }; G.trans = null; WV.R1 = -1; WV.R2 = -1; syncWave(); setAct1Visible(false); WC.hf = false; GF = 1; CAM.roll = 0; for (const b of BOXES) b.on = false; CS.ground = false; CS.grav = 5; CS.drag = 0.5;
    const O = G.ck && G.ck.O ? G.ck.O : { x: Math.floor(SITES.s5.x), y: SITE_H.s5, z: Math.floor(SITES.s5.z) }; if (n === 2) LV = buildAct2(O, TUNING.shatter.plinth); else LV = buildAct3(O, TUNING.shatter.plinth);
    instantBuild(LV); setAtmosphereInstant(n); setupLevelEntities(LV);
  }
}
function instantBuild(L) {
  const vb = L.vb, surf = vb.surface(L.filter), O = L.O; const grid = new Uint8Array(GX * GY * GZ); VG.on = true; VG.ox = O.x - GOX; VG.oy = O.y - GOY; VG.oz = O.z - GOZ; VG.nx = GX; VG.ny = GY; VG.nz = GZ; VG.data = grid;
  L.surf = surf; L.n = surf.n;
  for (let i = 0; i < surf.n; i++) { const k = allocCube(); if (k < 0) break; const x = surf.x[i], y = surf.y[i], z = surf.z[i], p = surf.p[i], col = jit(vb.pal[p], x, y, z, 0.06); setCubeTransform(k, O.x + x + 0.5, O.y + y + 0.5, O.z + z + 0.5, 1, col[0], col[1], col[2]); C.tx[k] = C.x[k]; C.ty[k] = C.y[k]; C.tz[k] = C.z[k]; C.tr[k] = col[0]; C.tg[k] = col[1]; C.tb[k] = col[2]; C.tgl[k] = vb.palFx[p]; C.glow[k] = vb.palFx[p]; C.st[k] = ST.SET; C.owner[k] = -1; setCubeAO(k, surf.a[i], surf.b[i]); const kk = levelCellKey(x, y, z); C.grp[k] = L.cellGroup.get(kk) ?? -1; if (C.grp[k] >= 0) L.groups[C.grp[k]].cubes.push(k); writeCube(k); }
  // collision comes from the full grid (every solid cell)
  grid.set(vb.g);
  for (const R of L.rot) { R.cubes = []; for (const [lx, ly, lz, p] of R.cells) { const k = allocCube(); if (k < 0) break; const col = jit(vb.pal[p] || [1, 1, 1], lx, ly, lz, 0.05); setCubeTransform(k, R.cx + O.x + lx + 0.5, R.cy + O.y + ly + 0.5, R.cz + O.z + lz + 0.5, 1, col[0], col[1], col[2]); C.hx[k] = lx + 0.5; C.hy[k] = ly + 0.5; C.hz[k] = lz + 0.5; C.ts[k] = 1; C.st[k] = ST.ROT; C.owner[k] = -1; R.cubes.push(k); } R.cxw = R.cx + O.x; R.czw = R.cz + O.z; R.cyw = R.cy + O.y; DISCS.push({ cx: R.cxw, cz: R.czw, R: R.R, y0: R.cyw - 2, y1: R.cyw, w: R.w, ang: 0, ref: R }); }
  for (const s of L.streams) { s.cubes = []; for (let q = 0; q < s.n; q++) { const k = allocCube(); if (k < 0) break; const pc = s.color ? vb.pal[s.color] : vb.pal[L.pal.WT]; setCubeTransform(k, O.x + s.x, O.y + s.y, O.z + s.z, 1, pc[0], pc[1], pc[2]); C.st[k] = ST.STRM; C.ts[k] = 0.35 + hash2(q, 9) * 0.35; C.wy[k] = hash2(q, 2); C.wx[k] = (hash2(q, 3) - 0.5) * 1.6; C.wz[k] = (hash2(q, 4) - 0.5) * 1.6; C.tx[k] = O.x + s.x; C.ty[k] = O.y + s.y; C.tz[k] = O.z + s.z; C.glow[k] = s.color ? 10.8 : 0.3; C.owner[k] = -1; C.hx[k] = s.len; C.hy[k] = 0.7 + hash2(q, 6) * 0.6; s.cubes.push(k); } }
  cubesDirty = true;
}
function onActReady(act) {
  G.act = act; G.ck = { act, O: LV ? LV.O : null, pos: LV ? { x: LV.O.x + LV.start.x, y: LV.O.y + LV.start.y, z: LV.O.z + LV.start.z } : null, coins: G.coins, t: G.t };
  updateHUD(); toast(ACT_NAMES[act]); if (LV && LV.npc) setTimeout(() => { if (NPC.active && Math.hypot(P.x - NPC.x, P.z - NPC.z) < 12) { showTalk('TWIN', LV.hints[0]); sfx('talk'); } }, 1500); setTimeout(() => $('talk').classList.remove('on'), 9000);
}

