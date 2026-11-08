// ---- cubes: index for upgrades; the rebuild animation --------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function twIndexCubes() { const O = TW.O, m = new Map(); for (let k = 0; k < cubeHi; k++) { const st = C.st[k]; if (st !== ST.SET && st !== ST.POP) continue; m.set(levelCellKey(Math.floor(C.tx[k] - O.x), Math.floor(C.ty[k] - O.y), Math.floor(C.tz[k] - O.z)), k); } TW.cubeAt = m; }
function townRebuild(role) { // build the town again with the new tiers; the difference flies in / out as cubes
  const O = TW.O, old = TW.lv, nl = twBuildAll(O, TOWN, TOWN.seed), vbN = nl.vb, surf = vbN.surface(), cube = TW.cubeAt, keep = new Set(); let added = 0, removed = 0, recol = 0; const t0 = TW.t;
  const b = TW.L.buildings.find(q => q.role === role), cx = b ? (b.x0 + b.x1) / 2 : 0, cz = b ? (b.z0 + b.z1) / 2 : 0;
  for (let i = 0; i < surf.n; i++) {
    const x = surf.x[i], y = surf.y[i], z = surf.z[i], p = surf.p[i], key = levelCellKey(x, y, z); keep.add(key); const k0 = cube.get(key);
    if (k0 !== undefined) { const col = jit(vbN.pal[p], x, y, z, 0.06); if (Math.abs(C.tr[k0] - col[0]) + Math.abs(C.tg[k0] - col[1]) + Math.abs(C.tb[k0] - col[2]) > 0.01 || Math.abs(C.tgl[k0] - vbN.palFx[p]) > 0.4) { C.r[k0] = C.tr[k0] = col[0]; C.g[k0] = C.tg[k0] = col[1]; C.b[k0] = C.tb[k0] = col[2]; C.tgl[k0] = C.glow[k0] = vbN.palFx[p]; C.st[k0] = ST.POP; C.age[k0] = -Math.random() * 0.5; recol++; } setCubeAO(k0, surf.a[i], surf.b[i]); continue; }
    const k = allocCube(); if (k < 0) continue; const col = jit(vbN.pal[p], x, y, z, 0.06), fx = O.x + x + 0.5, fy = O.y + y + 0.5, fz = O.z + z + 0.5, a = Math.random() * TAU, rr = 3 + Math.random() * 7;
    setCubeTransform(k, fx + Math.cos(a) * rr, fy + 9 + Math.random() * 9, fz + Math.sin(a) * rr, 1, col[0], col[1], col[2]); C.tx[k] = fx; C.ty[k] = fy; C.tz[k] = fz; C.tr[k] = col[0]; C.tg[k] = col[1]; C.tb[k] = col[2]; C.tgl[k] = vbN.palFx[p]; C.glow[k] = 1.2; C.owner[k] = -1; C.grp[k] = -1; C.vx[k] = C.vy[k] = C.vz[k] = 0;
    setCubeAO(k, surf.a[i], surf.b[i]); C.st[k] = ST.REST; C.age[k] = 0; C.delay[k] = 0.05 + Math.max(0, y) * 0.07 + hyp2(x - cx, z - cz) * 0.012 + Math.random() * 0.25; C.vox[k] = 0.6; cube.set(key, k); added++;
  }
  for (const [key, k] of cube) if (!keep.has(key)) { C.st[k] = ST.DIE; C.age[k] = -Math.random() * 0.3; C.ts[k] = 1; cube.delete(key); removed++; }
  old.vb.g.set(vbN.g); VG.data.set(vbN.g); old.surf = surf; old.n = surf.n; old.chimneys = nl.chimneys; cubesDirty = true; TW.cubeAt = cube; twCollectGlow();
  return { added, removed, recol, cubes: cubeLive };
}
function townOnUpgrade(role, from, to) { const p = TW.pending || (TW.pending = { roles: [], last: role, to }); p.roles.push(role); p.last = role; p.to = to; }
function townOnClose() {
  if (TW.on && TW.pending) { const p = TW.pending; TW.pending = null; try { const r = townRebuild(p.last), b = TW.L.buildings.find(q => q.role === p.last), c = b ? wp((b.x0 + b.x1) / 2 - 0.5, (b.z0 + b.z1) / 2 - 0.5) : { x: P.x, z: P.z };
    G.flash = Math.max(G.flash, 0.3); camShake(0.4); fxRing(c.x, TW.O.y, c.z, 1, 14, 1.4, 0xffe27a, 1); fxRing(c.x, TW.O.y, c.z, 0.5, 9, 1.0, 0xffffff, 0.8); sparkBurst(c.x, TW.O.y + 2, c.z, 40, 0xffe27a, 9); rsfx('pick3'); rpgBanner(TOWN_ROLES[p.last].name.toUpperCase(), (p.roles.length > 1 ? p.roles.length + ' BUILDINGS UPGRADED' : 'UPGRADED TO ' + suiTierName(p.to).toUpperCase()), true); TW.upN = r.added; fxBeacon(c.x, TW.O.y, c.z); twBuildPeople(); } catch (err) { console.error('town rebuild', err); } }
  twGardenNodes();
}
function fxBeacon(x, y, z) { for (let i = 0; i < 6; i++) setTimeout(() => { if (TW.on) { sparkBurst(x + (Math.random() - 0.5) * 3, y + 1 + i * 1.4, z + (Math.random() - 0.5) * 3, 6, 0xffe27a, 4); } }, i * 110); }
// ---- garden beds as nodes (instanced herb / leaf meshes from food-game) -----------------------------------------------------------------------------------------------------------------------------------------------------------
function twGardenNodes() { FD.nodes.length = 0; if (!TW.on) return; const L = TW.L, n = TOWN_BEDS[townTier(TOWN, 'garden')]; for (let i = 0; i < Math.min(n, L.beds.length); i++) { const b = L.beds[i], q = wp(b.x + 0.5, b.z), nd = fdAddNode('herb', q.x, TW.O.y + 1, q.z, 'sunberry', 1); if (nd) { nd.bed = i; nd.on = true; } } }
function townBedChanged(i) { /* the node reads TOWN.garden every frame */ }
