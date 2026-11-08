// ---------------------------------------------------------------------------------------------------------------------
// voxelise arbitrary shapes (trees, rocks, walls) into shell cubes
// ---------------------------------------------------------------------------------------------------------------------
function voxelizeShapes(shapes, cell) {
  const map = new Map(), K = (a, b, c) => ((a + 4096) * 8192 + (b + 4096)) * 8192 + (c + 4096);
  for (const sp of shapes) {
    let x0, x1, y0, y1, z0, z1;
    if (sp.t === 'ell') { x0 = sp.cx - sp.rx; x1 = sp.cx + sp.rx; y0 = sp.cy - sp.ry; y1 = sp.cy + sp.ry; z0 = sp.cz - sp.rz; z1 = sp.cz + sp.rz; }
    else if (sp.t === 'box') { x0 = sp.x0; x1 = sp.x1; y0 = sp.y0; y1 = sp.y1; z0 = sp.z0; z1 = sp.z1; }
    else if (sp.t === 'cyl') { x0 = sp.cx - sp.r; x1 = sp.cx + sp.r; y0 = sp.y0; y1 = sp.y1; z0 = sp.cz - sp.r; z1 = sp.cz + sp.r; }
    else { x0 = sp.cx - sp.r; x1 = sp.cx + sp.r; y0 = sp.y0; y1 = sp.y0 + sp.h; z0 = sp.cz - sp.r; z1 = sp.cz + sp.r; }
    for (let ix = Math.floor(x0 / cell); ix <= Math.floor(x1 / cell); ix++) for (let iy = Math.floor(y0 / cell); iy <= Math.floor(y1 / cell); iy++) for (let iz = Math.floor(z0 / cell); iz <= Math.floor(z1 / cell); iz++) {
      const x = (ix + 0.5) * cell, y = (iy + 0.5) * cell, z = (iz + 0.5) * cell; let inside = false;
      if (sp.t === 'ell') { const dx = (x - sp.cx) / sp.rx, dy = (y - sp.cy) / sp.ry, dz = (z - sp.cz) / sp.rz; inside = dx * dx + dy * dy + dz * dz <= 1 + 0.18 * (hash3(ix, iy, iz) - 0.5); }
      else if (sp.t === 'box') inside = true;
      else if (sp.t === 'cyl') { const dx = x - sp.cx, dz = z - sp.cz; inside = dx * dx + dz * dz <= sp.r * sp.r && y >= sp.y0 && y <= sp.y1; }
      else { const t = (y - sp.y0) / sp.h; if (t >= 0 && t <= 1) { const rr = sp.r * (1 - t), dx = x - sp.cx, dz = z - sp.cz; inside = dx * dx + dz * dz <= rr * rr; } }
      if (inside) map.set(K(ix, iy, iz), [ix, iy, iz, sp.col(x, y, z)]);
    }
  }
  const out = [];
  for (const [, v] of map) { const [ix, iy, iz, c] = v; if (map.has(K(ix + 1, iy, iz)) && map.has(K(ix - 1, iy, iz)) && map.has(K(ix, iy + 1, iz)) && map.has(K(ix, iy - 1, iz)) && map.has(K(ix, iy, iz + 1)) && map.has(K(ix, iy, iz - 1))) continue; out.push((ix + 0.5) * cell, (iy + 0.5) * cell, (iz + 0.5) * cell, c[0], c[1], c[2]); }
  return out; // flat [x,y,z,r,g,b]*n
}
function treeShapes(t) {
  const S = TREE_SPEC[t.type], sh = [], s = t.s, ca = Math.cos(t.rot), sa = Math.sin(t.rot), T = lc(S.top), B = lc(S.bot), K = lc(S.bark);
  sh.push({ t: 'cyl', cx: t.x, cz: t.z, y0: t.y, y1: t.y + S.trunk.h * s, r: Math.max(0.2, S.trunk.r0 * s * 1.1), col: (x, y, z) => { const v = 0.8 + 0.4 * hash3((x * 7) | 0, (y * 7) | 0, (z * 7) | 0); return [K[0] * v, K[1] * v, K[2] * v]; } });
  if (S.blobs) for (const b of S.blobs) { const bx = b[0] * s, bz = b[2] * s; const cx = t.x + bx * ca + bz * sa, cz = t.z - bx * sa + bz * ca, cy = t.y + b[1] * s, rr = (b[3] + b[5]) * 0.5 * s;
    sh.push({ t: 'ell', cx, cy, cz, rx: rr, ry: b[4] * s, rz: rr, col: (x, y, z) => { const u = clamp((y - (cy - b[4] * s)) / (b[4] * s * 2), 0, 1), v = 0.82 + 0.36 * hash3((x * 5) | 0, (y * 5) | 0, (z * 5) | 0), c = mix3(B, T, u * 0.9); return [c[0] * v, c[1] * v, c[2] * v]; } }); }
  if (S.cones) for (const cn of S.cones) sh.push({ t: 'cone', cx: t.x, cz: t.z, y0: t.y + cn[0] * s, h: cn[2] * s, r: cn[1] * s, col: (x, y, z) => { const u = clamp((y - (t.y + cn[0] * s)) / (cn[2] * s), 0, 1), v = 0.82 + 0.36 * hash3((x * 5) | 0, (y * 5) | 0, (z * 5) | 0), c = mix3(B, T, u); return [c[0] * v, c[1] * v, c[2] * v]; } });
  return sh;
}
function rockShapes(r) { const c = lc([0.5, 0.46, 0.4]), m = lc([0.22, 0.38, 0.1]); return [{ t: 'ell', cx: r.x, cy: r.y + r.s * 0.4, cz: r.z, rx: r.s * 1.05, ry: r.s * 0.75, rz: r.s * 0.95, col: (x, y, z) => { const v = 0.8 + 0.4 * hash3((x * 4) | 0, (y * 4) | 0, (z * 4) | 0), u = y > r.y + r.s * 0.8 ? 1 : 0, cc = mix3(c, m, u * 0.7); return [cc[0] * v, cc[1] * v, cc[2] * v]; } }]; }
function pieceShapes(p) { const c = lc([0.55, 0.52, 0.47]); const b = p.b; return [{ t: 'box', x0: b[0], x1: b[3], y0: Math.max(b[1], HT((b[0] + b[3]) / 2, (b[2] + b[5]) / 2) - 0.4), y1: b[4], z0: b[2], z1: b[5], col: (x, y, z) => { const v = 0.76 + 0.4 * hash3((x * 4) | 0, (y * 4) | 0, (z * 4) | 0); return [c[0] * v, c[1] * v, c[2] * v]; } }]; }

// spawn voxelised cubes of a prop with impulses away from (ox,oz); group them for rewind
let groupId = 100000;
function spawnPropCubes(list, cell, ox, oz, power, ownerId, g) {
  const n = list.length / 6; let made = 0; const keep = Math.min(1, (Q.cap - cubeLive) / (n + 1));
  for (let k = 0; k < n; k++) {
    if (keep < 1 && hash3(k, ownerId, 3) > keep) continue; const i = allocCube(); if (i < 0) break; made++;
    const x = list[k * 6], y = list[k * 6 + 1], z = list[k * 6 + 2]; setCubeTransform(i, x, y, z, cell * 0.98, list[k * 6 + 3], list[k * 6 + 4], list[k * 6 + 5]);
    let dx = x - ox, dz = z - oz; const dl = Math.hypot(dx, dz) + 0.001; dx /= dl; dz /= dl; const pw = power * (0.5 + Math.random() * 0.9);
    C.vx[i] = dx * pw + (Math.random() - 0.5) * 2; C.vz[i] = dz * pw + (Math.random() - 0.5) * 2; C.vy[i] = 3 + Math.random() * 6 * (power / 5); C.wx[i] = (Math.random() - 0.5) * 12; C.wy[i] = (Math.random() - 0.5) * 12; C.wz[i] = (Math.random() - 0.5) * 12;
    C.owner[i] = ownerId; C.hx[i] = x; C.hy[i] = y; C.hz[i] = z; C.glow[i] = 0.5; C.tr[i] = C.r[i]; C.tg[i] = C.g[i]; C.tb[i] = C.b[i]; if (g) g.cubes.push(i); writeCube(i);
  }
  if (g) g.need = made; cubeMesh.count = Math.max(cubeMesh.count, cubeHi);
  return made;
}
function shatterTree(t, ox, oz, power = 6) {
  if (!t.alive) return; const S = TREE_SPEC[t.type]; setTreeVisible(t, false); const id = groupId++;
  const g = { id, need: 0, back: 0, done: false, cubes: [], restore: () => { setTreeVisible(t, true); cubeFreeGroup(g); HOMEG.delete(id); } }; HOMEG.set(id, g);
  const made = spawnPropCubes(voxelizeShapes(treeShapes(t), Q.cap < 20000 ? S.cell * 1.3 : S.cell), S.cell, ox, oz, power, id, g); g.shatterT = G.t; sfx('shatter_small'); puff(t.x, t.y + 3, t.z, 8, 1.4, 0x4f8a2a);
  t.group = g; return made;
}
function shatterRock(r, ox, oz, power = 6) { if (!r.alive) return; setRockVisible(r, false); const id = groupId++; const g = { id, need: 0, back: 0, done: false, cubes: [], restore: () => { setRockVisible(r, true); cubeFreeGroup(g); HOMEG.delete(id); } }; HOMEG.set(id, g); spawnPropCubes(voxelizeShapes(rockShapes(r), 0.5), 0.5, ox, oz, power, id, g); sfx('shatter_small'); puff(r.x, r.y + 1, r.z, 6, 1, 0x887766); }
function shatterPiece(p, ox, oz, power = 6) {
  if (!p.alive) return; p.alive = false; p.mesh.visible = false; if (p.box) p.box.on = false; const id = groupId++;
  const g = { id, need: 0, back: 0, done: false, cubes: [], restore: () => { p.alive = true; p.mesh.visible = true; if (p.box) p.box.on = true; cubeFreeGroup(g); HOMEG.delete(id); } }; HOMEG.set(id, g);
  spawnPropCubes(voxelizeShapes(pieceShapes(p), 0.5), 0.5, ox, oz, power, id, g); sfx('shatter_small'); puff(p.x, p.y, p.z, 8, 1.2, 0x9a9488);
}

