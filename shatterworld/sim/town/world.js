// <town-world> ==================================================================================================================
// SHATTERWORLD home town, part 2a: the VOXEL TOWN. townLayout(seed) (town-core, deterministic) says where the plaza, roads, wards, lots, buildings, stalls, board, garden beds, trees, lamps and the gate are; this block turns it
// into a block world with the same VB builder the three acts use (so it gets the same cube shader, AO, bloom glow and shatter blend). Every building has a role silhouette and grows visibly with its tier
// (chimneys, clock tower, crystals, greenhouses, extra stalls ...). Window and lamp cubes are tracked so they light up at dusk. Hard budget: < ~9k visible cubes (one InstancedMesh, one draw call).
// ==============================================================================================================================
const TWP = {}; // palette ids for the town VB
function twPalette(vb) {
  const A = (k, r, g, b, gl) => { TWP[k] = vb.addPal(r, g, b, gl || 0); };
  A('g1', 0.45, 0.76, 0.36); A('g2', 0.38, 0.70, 0.32); A('g3', 0.52, 0.82, 0.40); A('dirt', 0.56, 0.40, 0.28); A('dirt2', 0.46, 0.32, 0.22); A('stone', 0.62, 0.62, 0.66); A('stone2', 0.52, 0.52, 0.58); A('rock', 0.44, 0.42, 0.46); A('rock2', 0.36, 0.34, 0.40);
  A('road1', 0.82, 0.74, 0.60); A('road2', 0.74, 0.66, 0.54); A('plaza1', 0.96, 0.89, 0.74); A('plaza2', 0.87, 0.79, 0.65); A('wood', 0.56, 0.38, 0.24); A('wood2', 0.42, 0.28, 0.18); A('wood3', 0.72, 0.52, 0.32);
  A('win', 1.0, 0.86, 0.46, 0.123); A('lamp', 1.0, 0.92, 0.56, 0.234); A('water', 0.45, 0.85, 1.0, 0.25); A('hedge', 0.24, 0.56, 0.28); A('hedge2', 0.30, 0.64, 0.32); A('leaf1', 0.30, 0.66, 0.32); A('leaf2', 0.40, 0.76, 0.36); A('pine', 0.18, 0.46, 0.30); A('pine2', 0.24, 0.54, 0.34);
  A('blos1', 1.0, 0.70, 0.84); A('blos2', 1.0, 0.84, 0.92); A('flow1', 1.0, 0.50, 0.60); A('flow2', 1.0, 0.90, 0.40); A('flow3', 0.95, 0.95, 1.0); A('flow4', 0.70, 0.60, 1.0); A('soil', 0.34, 0.22, 0.14); A('soil2', 0.44, 0.29, 0.18); A('door', 0.36, 0.22, 0.14);
  A('gold', 1.0, 0.82, 0.30, 0.55); A('crystal', 0.78, 0.50, 1.0, 0.9); A('forge', 1.0, 0.50, 0.15, 1.0); A('portal', 0.33, 0.88, 0.82, 1.1); A('white', 0.98, 0.97, 0.96); A('brick', 0.72, 0.38, 0.32); A('brick2', 0.60, 0.30, 0.26); A('glass', 0.62, 0.94, 0.96, 0.35); A('paper', 0.98, 0.94, 0.82);
  A('cloth1', 0.92, 0.30, 0.30); A('cloth2', 0.98, 0.96, 0.90); A('cloth3', 0.30, 0.55, 0.92); A('cloth4', 1.0, 0.76, 0.24); A('flask', 0.5, 1.0, 0.65, 0.7); A('ember', 1.0, 0.35, 0.1, 0.7); A('coal', 0.16, 0.14, 0.16); A('iron', 0.34, 0.36, 0.42);
  const R = { hall: [[0.99, 0.91, 0.64], [0.80, 0.26, 0.24]], kitchen: [[1.0, 0.77, 0.55], [0.86, 0.40, 0.20]], smithy: [[0.66, 0.70, 0.78], [0.30, 0.34, 0.46]], gems: [[0.80, 0.68, 0.97], [0.50, 0.32, 0.80]], apothecary: [[0.62, 0.90, 0.70], [0.22, 0.58, 0.40]], warehouse: [[0.84, 0.66, 0.46], [0.54, 0.34, 0.22]],
    h0: [[0.96, 0.83, 0.77], [0.80, 0.34, 0.30]], h1: [[0.79, 0.89, 0.96], [0.30, 0.46, 0.70]], h2: [[0.97, 0.95, 0.79], [0.86, 0.58, 0.24]], h3: [[0.87, 0.79, 0.93], [0.50, 0.34, 0.60]] };
  for (const k in R) { A('w_' + k, ...R[k][0]); A('r_' + k, ...R[k][1]); }
  return TWP;
}
// ---- building frame: local coordinates (u along the facade, v from the front wall inwards) ---------------------------------------------------------------------------------------------------------------------------
function bFrame(b) { const ev = b.face === 0 || b.face === 2, W = ev ? b.z1 - b.z0 : b.x1 - b.x0, D = ev ? b.x1 - b.x0 : b.z1 - b.z0; const at = (u, v) => b.face === 0 ? [b.x1 - 1 - v, b.z0 + u] : b.face === 2 ? [b.x0 + v, b.z0 + u] : b.face === 1 ? [b.x0 + u, b.z1 - 1 - v] : [b.x0 + u, b.z0 + v]; return { W, D, at, ev }; }
function twBox(vb, F, u0, u1, v0, v1, y0, y1, p) { for (let u = u0; u < u1; u++) for (let v = v0; v < v1; v++) { const [x, z] = F.at(u, v); for (let y = y0; y < y1; y++) vb.set(x, y, z, p); } }
function twSet(vb, F, u, v, y, p) { const [x, z] = F.at(u, v); vb.set(x, y, z, p); }
function twRoof(vb, b, y, pal, trim, gable, F) { // stepped hip roof (or a gable along the facade), 1 cell overhang, solid
  let a = b.x0 - 1, bb = b.z0 - 1, c = b.x1 + 1, d = b.z1 + 1, yy = y, first = true; const alongX = (b.x1 - b.x0) >= (b.z1 - b.z0);
  while (a < c && bb < d && yy < y + 8) { for (let x = a; x < c; x++) for (let z = bb; z < d; z++) { const edge = x === a || x === c - 1 || z === bb || z === d - 1; vb.set(x, yy, z, first && edge ? trim : pal); } if (gable) { if (alongX) { bb++; d--; } else { a++; c--; } } else { a++; bb++; c--; d--; } yy++; first = false; }
  return yy;
}
function twShell(vb, b, o) { // walls + foundation + door + windows + corner posts + roof. Returns the frame.
  const F = bFrame(b), W = F.W, D = F.D, H = o.h, wall = TWP['w_' + o.pal], roof = TWP['r_' + o.pal];
  twBox(vb, F, 0, W, 0, D, 0, 1, TWP.stone2); twBox(vb, F, 0, W, 0, D, 1, H, wall);
  for (const [u, v] of [[0, 0], [W - 1, 0], [0, D - 1], [W - 1, D - 1]]) twBox(vb, F, u, u + 1, v, v + 1, 1, H, TWP.wood2);
  twBox(vb, F, 0, W, 0, D, H - 1, H, TWP.wood); // eave beam
  const du = (W >> 1); twBox(vb, F, du, du + 1, 0, 1, 1, 3, TWP.door); twBox(vb, F, du - 1, du, 0, 1, 1, 4, TWP.wood3); twBox(vb, F, du + 1, du + 2, 0, 1, 1, 4, TWP.wood3); twBox(vb, F, du - 1, du + 2, 0, 1, 3, 4, TWP.wood3); // door + frame
  for (let u = 2; u < W - 2; u += 3) { if (Math.abs(u - du) <= 1) continue; for (let y = 2; y < Math.min(H - 1, 4); y++) { twSet(vb, F, u, 0, y, TWP.win); if (y === 2) twSet(vb, F, u, D - 1, y, TWP.win); } }
  for (let v = 2; v < D - 2; v += 3) for (const u of [0, W - 1]) twSet(vb, F, u, v, 2, TWP.win);
  const top = twRoof(vb, b, H, roof, TWP.wood2, !!o.gable); F.top = top; F.H = H; F.wall = wall; F.roof = roof; return F;
}
function twChimney(vb, F, u, v, h, o) { for (let y = F.H; y < F.H + h; y++) twSet(vb, F, u, v, y, y % 3 === 0 ? TWP.brick2 : TWP.brick); twSet(vb, F, u, v, F.H + h, TWP.coal); return F.at(u, v).concat([F.H + h + 1]); }
function twSite(vb, b) { // an unbuilt plot: foundation corners, scaffold poles, a stack of timber
  const F = bFrame(b); twBox(vb, F, 0, F.W, 0, F.D, 0, 1, TWP.dirt2); for (const [u, v] of [[0, 0], [F.W - 1, 0], [0, F.D - 1], [F.W - 1, F.D - 1]]) twBox(vb, F, u, u + 1, v, v + 1, 1, 4, TWP.wood2); twBox(vb, F, 0, F.W, 0, 1, 3, 4, TWP.wood); twBox(vb, F, 1, 3, 2, 4, 1, 3, TWP.wood3); twSet(vb, F, F.W - 2, 2, 1, TWP.paper); twSet(vb, F, F.W >> 1, 0, 1, TWP.gold); return F;
}
// ---- the roles, tier by tier ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function twBuilding(vb, b, tier, out) { // out.chimneys = [[x,y,z,kind]] smoke / spark emitters
  const role = b.role, T = tier | 0;
  if (role === 'home') { const F = twShell(vb, b, { h: 4, pal: 'h' + (b.style | 0), gable: (b.style & 1) === 1 }); twChimney(vb, F, 1, 1, 2); out.chimneys.push(twChimney(vb, F, 1, F.D - 2, 2).concat(['home'])); twBox(vb, F, 1, 2, 0, 1, 1, 2, TWP.flow1); return F; }
  if (T < 1 && (role === 'gems' || role === 'apothecary')) { twSite(vb, b); return null; }
  if (role === 'hall') {
    const F = twShell(vb, b, { h: 6, pal: 'hall' }), cx = F.W >> 1, cy = F.D >> 1; twBox(vb, F, cx - 1, cx + 2, cy - 1, cy + 2, F.top, F.top + 2, TWP.w_hall); twBox(vb, F, cx, cx + 1, cy, cy + 1, F.top + 2, F.top + 5, TWP.gold); twSet(vb, F, cx, cy, F.top + 5, TWP.lamp);
    for (const [u, y] of [[cx - 1, F.top + 1], [cx + 1, F.top + 1]]) twSet(vb, F, u, cy - 1, y, TWP.win);
    for (let u = 1; u < F.W - 1; u += 2) twSet(vb, F, u, -1 + 0, 0, TWP.stone); // steps row
    if (T >= 2) for (const u of [0, F.W - 1]) { twBox(vb, F, u, u + 1, 0, 1, F.top, F.top + 4, TWP.stone); twBox(vb, F, u, u + 1, 0, 1, F.top + 4, F.top + 5, TWP.cloth1); twSet(vb, F, u, 0, F.top + 5, TWP.gold); }
    if (T >= 3) { twBox(vb, F, cx - 1, cx + 2, cy - 1, cy + 2, F.top + 2, F.top + 6, TWP.w_hall); for (const [u, v] of [[cx, cy - 1], [cx - 1, cy], [cx + 1, cy], [cx, cy + 1]]) twSet(vb, F, u, v, F.top + 4, TWP.lamp); twBox(vb, F, cx - 1, cx + 2, cy - 1, cy + 2, F.top + 6, F.top + 7, TWP.gold); twBox(vb, F, cx, cx + 1, cy, cy + 1, F.top + 7, F.top + 10, TWP.gold); twSet(vb, F, cx, cy, F.top + 10, TWP.lamp); twBox(vb, F, 0, F.W, 0, 1, 1, 2, TWP.cloth1); }
    return F; }
  if (role === 'kitchen') {
    const F = twShell(vb, b, { h: 5, pal: 'kitchen' }); out.chimneys.push(twChimney(vb, F, F.W - 2, F.D - 2, 3).concat(['smoke']));
    twBox(vb, F, 1, F.W - 1, -1 + 0, 0, 0, 0, TWP.wood); // placeholder (no-op)
    twBox(vb, F, 1, 3, 0, 1, 1, 2, TWP.wood2); twSet(vb, F, 1, 0, 2, TWP.ember); // barrel + a glowing pot
    if (T >= 2) { out.chimneys.push(twChimney(vb, F, 1, F.D - 2, 4).concat(['smoke'])); for (let u = 1; u < F.W - 1; u++) twSet(vb, F, u, -1, 3, u % 2 ? TWP.cloth1 : TWP.cloth2); for (const u of [1, F.W - 2]) twBox(vb, F, u, u + 1, -1, 0, 0, 3, TWP.wood2); }
    if (T >= 3) { for (const u of [2, F.W - 3]) twSet(vb, F, u, -1, 2, TWP.lamp); twBox(vb, F, F.W - 4, F.W - 1, 1, 2, F.top, F.top + 1, TWP.wood3); for (let u = 1; u < F.W - 1; u += 2) twSet(vb, F, u, 0, 4, TWP.leaf2); }
    return F; }
  if (role === 'smithy') {
    const F = twShell(vb, b, { h: 5, pal: 'smithy' }); out.chimneys.push(twChimney(vb, F, F.W - 2, F.D - 2, 4).concat(['spark'])); twBox(vb, F, 0, 3, -1, 0, 0, 1, TWP.iron); twSet(vb, F, 1, -1, 1, TWP.iron); twSet(vb, F, 1, -1, 2, TWP.iron); twBox(vb, F, F.W - 3, F.W - 1, -1, 0, 0, 1, TWP.coal); twSet(vb, F, F.W - 2, -1, 0, TWP.forge); // anvil + forge pit
    if (T >= 2) { twBox(vb, F, 0, F.W, -2, -1, 4, 5, TWP.r_smithy); for (const u of [0, F.W - 1]) twBox(vb, F, u, u + 1, -2, -1, 0, 4, TWP.wood2); twSet(vb, F, F.W - 2, -1, 1, TWP.forge); twSet(vb, F, F.W - 2, -1, 2, TWP.ember); }
    if (T >= 3) { out.chimneys.push(twChimney(vb, F, 1, F.D - 2, 5).concat(['spark'])); twBox(vb, F, 1, 2, 1, 2, F.top, F.top + 2, TWP.iron); twSet(vb, F, 1, 1, F.top + 2, TWP.forge); twBox(vb, F, 3, 5, -3, -2, 0, 1, TWP.stone); }
    return F; }
  if (role === 'gems') {
    const F = twShell(vb, b, { h: 5, pal: 'gems' }), cx = F.W >> 1, cy = F.D >> 1; const spire = (u, v, h) => { for (let y = 0; y < h; y++) twSet(vb, F, u, v, F.top + y, TWP.crystal); twSet(vb, F, u, v, F.top + h, TWP.white); };
    spire(cx, cy, T >= 1 ? 3 : 2); if (T >= 2) { spire(cx - 2, cy, 2); spire(cx + 2, cy, 2); spire(cx, cy - 2, 2); } if (T >= 3) { spire(cx - 1, cy + 1, 4); spire(cx + 1, cy + 1, 4); for (let k = 0; k < 4; k++) twSet(vb, F, cx - 1 + (k & 1) * 2, cy + (k >> 1) * 0, F.top + 6, TWP.crystal); twSet(vb, F, cx, cy, F.top + 8, TWP.crystal); twSet(vb, F, cx, cy, F.top + 9, TWP.white); }
    for (let u = 1; u < F.W - 1; u += 2) twSet(vb, F, u, -1, 0, u % 4 === 1 ? TWP.crystal : TWP.flow4); return F; }
  if (role === 'apothecary') {
    const F = twShell(vb, b, { h: 5, pal: 'apothecary', gable: true }); for (const u of [2, F.W - 3]) twSet(vb, F, u, 0, 3, TWP.flask); twBox(vb, F, F.W - 2, F.W - 1, 1, 2, 1, 3, TWP.hedge); twSet(vb, F, 1, -1, 1, TWP.leaf2); twSet(vb, F, 1, -1, 0, TWP.wood2);
    if (T >= 2) { twBox(vb, F, F.W, F.W + 3, 1, F.D - 1, 0, 1, TWP.stone2); for (let v = 1; v < F.D - 1; v++) for (let u = F.W; u < F.W + 3; u++) for (let y = 1; y < 4; y++) if (u === F.W + 2 || v === 1 || v === F.D - 2 || y === 3) twSet(vb, F, u, v, y, TWP.glass); twSet(vb, F, F.W + 1, F.D >> 1, 1, TWP.leaf2); twSet(vb, F, F.W + 1, F.D >> 1, 2, TWP.flask); }
    if (T >= 3) { twBox(vb, F, -3, 0, 1, F.D - 1, 0, 1, TWP.stone2); for (let v = 1; v < F.D - 1; v++) for (let u = -3; u < 0; u++) for (let y = 1; y < 4; y++) if (u === -3 || v === 1 || v === F.D - 2 || y === 3) twSet(vb, F, u, v, y, TWP.glass); twSet(vb, F, -2, F.D >> 1, 1, TWP.flow2); twSet(vb, F, -2, F.D >> 1, 2, TWP.flask); twBox(vb, F, F.W >> 1, (F.W >> 1) + 1, 0, 1, F.top, F.top + 3, TWP.flask); }
    return F; }
  if (role === 'warehouse') {
    const F = twShell(vb, b, { h: 5, pal: 'warehouse', gable: true }); twBox(vb, F, 1, 3, -1, 0, 0, 2, TWP.wood3); twBox(vb, F, 1, 2, -1, 0, 2, 3, TWP.wood2); twBox(vb, F, F.W - 3, F.W - 1, -1, 0, 0, 1, TWP.wood3);
    if (T >= 2) { twBox(vb, F, F.W, F.W + 3, 2, F.D - 2, 0, 3, TWP.w_warehouse); twBox(vb, F, F.W, F.W + 3, 2, F.D - 2, 3, 4, TWP.r_warehouse); twBox(vb, F, 4, 6, -1, 0, 0, 2, TWP.wood3); }
    if (T >= 3) { twBox(vb, F, -3, 0, 2, F.D - 2, 0, 3, TWP.w_warehouse); twBox(vb, F, -3, 0, 2, F.D - 2, 3, 4, TWP.r_warehouse); twBox(vb, F, F.W >> 1, (F.W >> 1) + 1, 0, 1, F.top, F.top + 3, TWP.wood2); twBox(vb, F, (F.W >> 1) - 1, (F.W >> 1) + 2, 0, 1, F.top + 3, F.top + 4, TWP.wood2); twSet(vb, F, F.W >> 1, 0, F.top + 4, TWP.lamp); }
    return F; }
  return null;
}
function twGarden(vb, L, tier, out) {
  const g = L.garden; if (!g) return; const F = bFrame(g), n = TOWN_BEDS[tier | 0]; for (let u = 0; u < F.W; u++) for (let v = 0; v < F.D; v++) { const [x, z] = F.at(u, v); vb.set(x, -1, z, (x + z) & 1 ? TWP.soil2 : TWP.soil); }
  for (let u = 0; u < F.W; u++) for (let v = 0; v < F.D; v++) { const edge = u === 0 || v === 0 || u === F.W - 1 || v === F.D - 1; if (!edge) continue; const gap = v === 0 && Math.abs(u - (F.W >> 1)) <= 1; if (gap) continue; const [x, z] = F.at(u, v); if ((u + v) % 2 === 0 || u === 0 || u === F.W - 1) vb.set(x, 0, z, TWP.wood2); else vb.set(x, 0, z, TWP.wood3); }
  for (let i = 0; i < L.beds.length; i++) { const b = L.beds[i], on = i < n; for (let k = 0; k < 2; k++) { vb.set(b.x + k, 0, b.z, on ? TWP.soil : TWP.soil2); if (on) { vb.set(b.x + k, -1, b.z, TWP.soil); } } if (!on) vb.set(b.x, 0, b.z, TWP.dirt2); }
  const sx = g.x0, sz = g.z0; if (tier >= 3) for (const [u, v] of [[F.W >> 1, 0]]) { const [x, z] = F.at(u - 1, v), [x2, z2] = F.at(u + 1, v); for (let y = 0; y < 4; y++) { vb.set(x, y, z, TWP.wood2); vb.set(x2, y, z2, TWP.wood2); } for (let q = -1; q <= 1; q++) { const [xx, zz] = F.at(u + q, v); vb.set(xx, 4, zz, TWP.leaf2); } }
  void sx; void sz;
}
function twStall(vb, s, k, tier) { // 3 wide, 2 deep counter + striped awning
  const F = bFrame({ x0: s.x - 1, x1: s.x + 2, z0: s.z - 1, z1: s.z + 2, face: s.face }), cols = [['cloth1', 'cloth2'], ['cloth3', 'cloth2'], ['cloth4', 'cloth2'], ['cloth1', 'cloth4']][k % 4];
  twBox(vb, F, 0, 3, 0, 1, 0, 1, TWP.wood3); for (const [u, v] of [[0, 0], [2, 0], [0, 2], [2, 2]]) twBox(vb, F, u, u + 1, v, v + 1, 0, 4, TWP.wood2);
  for (let u = 0; u < 3; u++) for (let v = -1; v < 3; v++) twSet(vb, F, u, v, 3, TWP[cols[(u + v + 1000) % 2]]); for (let u = 0; u < 3; u++) twSet(vb, F, u, 0, 1, [TWP.flow1, TWP.flow2, TWP.leaf2][(u + k) % 3]);
  twBox(vb, F, 0, 3, 2, 3, 0, 2, TWP.wood); if (tier >= 3) { twSet(vb, F, 1, -1, 2, TWP.lamp); twSet(vb, F, 1, 3, 2, TWP.lamp); }
}
function twBoard(vb, B, tier) {
  const F = bFrame({ x0: B.x - 1, x1: B.x + 2, z0: B.z - 1, z1: B.z + 1, face: B.face }); twBox(vb, F, 0, 1, 0, 1, 0, 4, TWP.wood2); twBox(vb, F, 2, 3, 0, 1, 0, 4, TWP.wood2); twBox(vb, F, 0, 3, 0, 1, 1, 3, TWP.wood3); twBox(vb, F, 0, 3, 0, 2, 3, 4, tier >= 2 ? TWP.r_hall : TWP.wood2);
  for (const [u, y, p] of [[0, 2, 'paper'], [1, 1, 'paper'], [1, 2, 'cloth4'], [2, 2, 'paper'], [2, 1, 'cloth3']]) twSet(vb, F, u, 0, y, TWP[p]); if (tier >= 3) { twSet(vb, F, 1, -1, 3, TWP.lamp); twSet(vb, F, 1, 0, 4, TWP.gold); }
}
function twTree(vb, t) {
  const x = t.x, z = t.z, h = t.h; if (t.kind === 0) { for (let y = 0; y < h - 1; y++) vb.set(x, y, z, TWP.wood2); vb.ell(x, h, z, 2.4, 1.9, 2.4, 0, (xx, yy, zz) => (xx * 7 + zz * 3 + yy) % 5 ? TWP.leaf1 : TWP.leaf2); }
  else if (t.kind === 1) { for (let y = 0; y < h - 1; y++) vb.set(x, y, z, TWP.wood2); for (let k = 0; k < 4; k++) { const r = [2.5, 2.1, 1.5, 0.8][k]; vb.cyl(x, z, 2 + k * 2 - 1 + (h > 5 ? 1 : 0), 2 + k * 2 + 1 + (h > 5 ? 1 : 0), r, 0, (xx, yy, zz) => (xx + zz) % 3 ? TWP.pine : TWP.pine2); } }
  else { for (let y = 0; y < h - 1; y++) vb.set(x, y, z, TWP.wood2); vb.ell(x, h, z, 2.6, 2.0, 2.6, 0, (xx, yy, zz) => (xx + zz * 3 + yy) % 4 ? TWP.blos1 : TWP.blos2); }
}
function twPlaceFountain(vb) { // octagonal basin, water, central pillar
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) { const d = hyp2(x + 0.5, z + 0.5); if (d > 3.7) continue; if (d > 2.7) { vb.set(x, 0, z, TWP.stone); vb.set(x, 1, z, d > 3.2 ? TWP.stone2 : TWP.stone); } else vb.set(x, 0, z, TWP.water); }
  for (let y = 0; y < 3; y++) { vb.set(0, y, 0, TWP.stone2); vb.set(-1, y, -1, y < 2 ? TWP.stone2 : 0); } vb.set(0, 3, 0, TWP.gold); vb.set(-1, 0, 0, TWP.stone2); vb.set(0, 0, -1, TWP.stone2); vb.set(-1, 0, -1, TWP.stone2); for (let y = 1; y < 3; y++) { vb.set(-1, y, 0, TWP.stone2); vb.set(0, y, -1, TWP.stone2); vb.set(-1, y, -1, TWP.stone2); } vb.set(-1, 3, -1, TWP.water); vb.set(0, 3, -1, TWP.water); vb.set(-1, 3, 0, TWP.water);
}
function twPortalPad(vb, L) { // a rune pad at the gate end of the main road + two pillars with a glowing keystone
  const p = L.portal, ca = Math.cos(p.ang), sa = Math.sin(p.ang); for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) { const d = hyp2(x, z), X = p.x + x, Z = p.z + z; if (d > 3.2 || L.cells[L.idx(X, Z)] === TC.OUT || L.cells[L.idx(X, Z)] === TC.WALL) continue; vb.set(X, -1, Z, d > 2.4 ? TWP.portal : d > 1.4 ? TWP.stone2 : ((Math.round(d * 2) & 1) ? TWP.portal : TWP.plaza1)); }
  for (const s of [-1, 1]) { const X = Math.round(p.x - sa * s * 4), Z = Math.round(p.z + ca * s * 4); for (let y = 0; y < 5; y++) vb.set(X, y, Z, y === 4 ? TWP.gold : TWP.stone2); vb.set(X, 5, Z, TWP.lamp); vb.set(X, 0, Z, TWP.stone); for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (vb.get(X + dx, 0, Z + dz) === 0 && vb.get(X + dx, -1, Z + dz)) vb.set(X + dx, 0, Z + dz, TWP.stone); }
}
// ---- the whole town ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function twBuildAll(O, TS, seed) { // TS = TOWN-like { bld: {role: tier} } -> level
  const L = townLayout(seed), lv = mkLevel(2, O), vb = lv.vb; lv.cellGroup = new Map(); twPalette(vb); lv.layout = L; lv.chimneys = []; lv.pal = { WT: TWP.water };
  const N = L.N, H = L.H, idx = L.idx, cells = L.cells; const de = new Int16Array(N * N).fill(99), q = []; for (let z = -H; z < N - H; z++) for (let x = -H; x < N - H; x++) if (cells[idx(x, z)] === TC.OUT) { de[idx(x, z)] = 0; q.push([x, z]); }
  for (let i = 0; i < q.length; i++) { const [x, z] = q[i], d = de[idx(x, z)]; for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) { const nx = x + dx, nz = z + dz; if (nx < -H || nz < -H || nx >= N - H || nz >= N - H) continue; if (de[idx(nx, nz)] > d + 1) { de[idx(nx, nz)] = d + 1; q.push([nx, nz]); } } }
  for (let z = -H; z < N - H; z++) for (let x = -H; x < N - H; x++) {
    const c = cells[idx(x, z)]; if (c === TC.OUT) continue; const n = hash2(x * 3 + 1, z * 5 + 2), n2 = hash2(x * 7 + 11, z * 3 + 5), d = de[idx(x, z)];
    let top = TWP.g1; if (c === TC.GROUND || c === TC.WALL) top = n < 0.34 ? TWP.g2 : n < 0.8 ? TWP.g1 : TWP.g3; else if (c === TC.ROAD || c === TC.GATE) top = ((x + z) & 1) ? TWP.road1 : (n2 < 0.3 ? TWP.road1 : TWP.road2); else if (c === TC.PLAZA) { const r = hyp2(x, z); top = (((x >> 1) + (z >> 1)) & 1) ? TWP.plaza1 : TWP.plaza2; if (r > L.plazaR - 1.3) top = TWP.road2; } else if (c === TC.BLDG) top = TWP.stone2; else if (c === TC.GARDEN) top = TWP.soil;
    vb.set(x, -1, z, top); vb.set(x, -2, z, c === TC.ROAD || c === TC.PLAZA ? TWP.dirt2 : TWP.dirt); const depth = Math.max(1, Math.min(9, Math.round(d * 0.62))); for (let k = 0; k < depth; k++) vb.set(x, -3 - k, z, hash2(x + k * 31, z + k * 17) < 0.3 ? TWP.rock2 : TWP.rock);
    if (c === TC.GROUND && n2 > 0.955) vb.set(x, 0, z, [TWP.flow1, TWP.flow2, TWP.flow3, TWP.flow4][((n * 40) | 0) & 3]); else if (c === TC.GROUND && n2 < 0.012) vb.set(x, 0, z, TWP.stone);
    if (c === TC.WALL) { vb.set(x, 0, z, ((x + z) & 3) === 0 ? TWP.hedge2 : TWP.hedge); if (n2 > 0.45) vb.set(x, 1, z, n < 0.15 ? TWP.flow1 : TWP.hedge); else if (n < 0.1) vb.set(x, 1, z, TWP.flow2); }
  }
  for (const k of ['kitchen', 'hall', 'smithy', 'gems', 'apothecary', 'warehouse']) void k;
  for (const b of L.buildings) { if (b.role === 'garden') continue; const tier = b.role === 'home' ? 1 : townTier(TS, b.role); twBuilding(vb, b, tier, lv); }
  twGarden(vb, L, townTier(TS, 'garden'), lv); twPlaceFountain(vb); twPortalPad(vb, L);
  const ns = Math.min(4, 1 + townTier(TS, 'market')); L.stalls.slice(0, ns).forEach((s, i) => twStall(vb, s, i, townTier(TS, 'market'))); twBoard(vb, L.board, townTier(TS, 'board'));
  for (const t of L.trees) twTree(vb, t); for (const l of L.lamps) { for (let y = 0; y < 3; y++) vb.set(l.x, y, l.z, TWP.wood2); vb.set(l.x, 3, l.z, TWP.lamp); vb.set(l.x + 1, 3, l.z, 0); }
  const g = L.gate; for (const s of [-1, 1]) { const px = Math.round(g.x - Math.sin(L.gateAng) * s * 3), pz = Math.round(g.z + Math.cos(L.gateAng) * s * 3); if (L.inb(px, pz) && cells[idx(px, pz)] !== TC.OUT) { for (let y = 0; y < 4; y++) vb.set(px, y, pz, y === 3 ? TWP.gold : TWP.stone2); vb.set(px, 4, pz, TWP.lamp); } }
  lv.start = { x: L.spawn.x + 0.5, y: 0, z: L.spawn.z + 0.5 }; lv.deathY = -40; lv.name = 'HOME TOWN'; lv.arenaR = L.R; return lv;
}
// </town-world>

