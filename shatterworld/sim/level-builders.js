// ============================================================================
// LEVEL BUILDERS for the block worlds (act 2 sky archipelago, act 3 neon canyon) + the rebuild choreography
// ============================================================================
let LV = null; // current block level
const DISCS = []; // analytic rotating discs {cx,cy,cz,R,y0,y1,w,ang}
const n3 = (x, y, z) => vn3(x, y, z);
function jit(c, x, y, z, a = 0.07) { const v = 1 - a + 2 * a * hash3(x, y, z); return [c[0] * v, c[1] * v, c[2] * v]; }

function mkLevel(act, O) { return { act, O, vb: new VB(O.x, O.y, O.z), shards: [], coins: [], blocks: [], enemies: [], npc: null, pipes: [], pads: [], rot: [], lowg: [], streams: [], lamps: [], groups: [], start: { x: 0, y: 0, z: 0 }, deathY: -60, hints: [], flowerGlow: [] }; }
function island(vb, cx, cy, cz, r, thick, P, seed = 0) {
  // P: {top:[pal...], soil, stone}; top surface at y = cy (cells at cy-1 are the walkable layer)
  for (let x = Math.floor(cx - r - 2); x <= Math.ceil(cx + r + 2); x++) for (let z = Math.floor(cz - r - 2); z <= Math.ceil(cz + r + 2); z++) {
    const dx = x + 0.5 - cx, dz = z + 0.5 - cz, ang = Math.atan2(dz, dx), rr = r * (1 + 0.16 * Math.sin(ang * 3 + seed) + 0.1 * Math.sin(ang * 5 + seed * 2.3)), d = Math.hypot(dx, dz) / rr; if (d >= 1) continue;
    const top = cy - 1 + (d > 0.8 && n3(x * 0.4 + seed, 0, z * 0.4) > 0.62 ? -1 : 0) + (d < 0.5 && n3(x * 0.3, seed, z * 0.3) > 0.78 ? 1 : 0);
    const depth = Math.max(2, Math.floor(thick * Math.pow(1 - d * d, 0.85) * (0.75 + 0.5 * n3(x * 0.25, seed, z * 0.25))) + 1);
    for (let y = top - depth + 1; y <= top; y++) {
      let p; if (y === top) p = P.top[(n3(x * 0.18 + seed, 3, z * 0.18) > 0.5 ? 1 : 0) % P.top.length]; else if (y >= top - 1) p = P.soil; else p = n3(x * 0.5, y * 0.5, z * 0.5) > 0.7 ? P.soil : P.stone;
      vb.set(x, y, z, p);
    }
  }
}
function blossomTree(vb, x, y, z, h, trunkP, l1, l2, r = 3) {
  for (let k = 0; k < h; k++) vb.set(x, y + k, z, trunkP); if (h > 4) { vb.set(x + 1, y + h - 2, z, trunkP); vb.set(x - 1, y + h - 3, z, trunkP); }
  vb.ell(x + 0.5, y + h + 1, z + 0.5, r, r * 0.75, r, l1, (a, b, c) => n3(a * 0.9, b * 0.9, c * 0.9) > 0.52 ? l1 : l2);
}
function pipeVox(vb, cx, cz, y0, h, P, PL, PD) {
  vb.cyl(cx, cz, y0, y0 + h - 1, 2, P, (x, y, z) => ((x + z) & 1) === 0 && y % 3 === 0 ? PL : P);
  vb.cyl(cx, cz, y0 + h - 1, y0 + h, 2.75, PL); vb.cyl(cx, cz, y0 + h - 1, y0 + h, 1.4, PD);
}
function cloudVox(vb, cx, cy, cz, rx, ry, rz, W, Pk) { vb.ell(cx, cy, cz, rx, ry, rz, W, (x, y, z) => y < cy - ry * 0.35 ? Pk : W); }
function bridgeVox(L, x0, y0, z0, dx, dz, len, w, rise, plank, rail, seg) {
  const vb = L.vb; const px = -dz, pz = dx; // perpendicular
  for (let k = 0; k < len; k++) {
    const y = y0 + Math.floor(k * rise), gid = L.groups.length > 0 ? -1 : -1; const g = Math.floor(k / seg), gidx = (L.bgBase || 0) + g;
    if (!L.groups[gidx]) L.groups[gidx] = { cells: [], cubes: [], broken: false, id: gidx };
    for (let s = -Math.floor(w / 2); s <= Math.floor(w / 2); s++) { const x = x0 + dx * k + px * s, z = z0 + dz * k + pz * s; vb.set(x, y - 1, z, plank); L.groups[gidx].cells.push([x, y - 1, z]); L.cellGroup.set((x + 512) * 1048576 + (y - 1 + 512) * 1024 + (z + 512), gidx);
      if (Math.abs(s) === Math.floor(w / 2) && k % 3 === 1) { vb.set(x, y, z, rail); L.groups[gidx].cells.push([x, y, z]); L.cellGroup.set((x + 512) * 1048576 + (y + 512) * 1024 + (z + 512), gidx); } }
  }
  L.bgBase = (L.bgBase || 0) + Math.ceil(len / seg);
}
function setPedestal(vb, x, y, z, p, p2) { vb.set(x, y, z, p); vb.set(x, y + 1, z, p2); }

function buildAct2(O, plinthR) {
  const L = mkLevel(2, O), vb = L.vb; L.cellGroup = new Map();
  const PK = vb.addPal(1.0, 0.6, 0.76), MN = vb.addPal(0.52, 0.88, 0.62), PE = vb.addPal(0.97, 0.72, 0.56), LI = vb.addPal(0.64, 0.55, 0.82), CR = vb.addPal(1.0, 0.93, 0.78), WH = vb.addPal(1, 0.97, 1), CP = vb.addPal(1, 0.84, 0.92),
    PP = vb.addPal(0.16, 0.72, 0.32), PL = vb.addPal(0.55, 0.96, 0.58), PD = vb.addPal(0.06, 0.34, 0.18), WD = vb.addPal(0.62, 0.42, 0.32), BL = vb.addPal(1, 0.66, 0.84), BL2 = vb.addPal(1, 0.82, 0.92), LA = vb.addPal(1, 0.88, 0.5, 0.9),
    WT = vb.addPal(0.45, 0.85, 1, 0.3), GD = vb.addPal(1, 0.82, 0.3, 0.28), CY = vb.addPal(0.78, 0.5, 1, 0.7), PN = vb.addPal(0.92, 0.5, 0.6), BR = vb.addPal(0.5, 0.36, 0.3);
  L.pal = { PK, MN, PE, LI, CR, WH, CP, PP, PL, PD, WD, BL, BL2, LA, WT, GD, CY, PN };
  const A = { top: [PK, MN], soil: PE, stone: LI };
  // --- A: start island (plinth lives here); top surface y=0 ---
  island(vb, 0, 0, 0, 9.5, 9, A, 1);
  vb.cyl(0, 0, -1, 0, plinthR + 0.6, CR, (x, y, z) => ((x + z) & 1) ? CR : PK);          // flat tiled plinth (matches the valley plinth cells exactly)
  vb.cyl(0, 0, -2, -1, plinthR + 0.6, PE);
  blossomTree(vb, -5, 0, -4, 6, BR, BL, BL2, 3.4); blossomTree(vb, 6, 0, 5, 4, BR, BL2, BL, 2.6);
  for (const [lx, lz] of [[-3, 5], [6, -3], [-7, 1]]) { vb.set(lx, 0, lz, WD); vb.set(lx, 1, lz, WD); vb.set(lx, 2, lz, LA); L.lamps.push([lx + 0.5, 2.5, lz + 0.5]); }
  for (let k = 0; k < 26; k++) { const a = hash2(k, 1) * TAU, rr = 3 + hash2(k, 2) * 5.5, fx = Math.round(Math.cos(a) * rr), fz = Math.round(Math.sin(a) * rr); if (vb.get(fx, -1, fz) && !vb.get(fx, 0, fz)) vb.set(fx, 0, fz, k % 3 === 0 ? CP : k % 3 === 1 ? GD : BL2); }
  L.npc = { x: 4.5, y: 0, z: 2.5 };
  // --- bridge A -> B (stairs unfold outward) ---
  bridgeVox(L, 9, 0, 0, 1, 0, 13, 3, 0.25, WD, CR, 3);
  // --- B: shard island ---
  island(vb, 25, 3, 0, 7.5, 7, A, 2); blossomTree(vb, 28, 3, -4, 5, BR, BL, BL2, 2.8);
  setPedestal(vb, 25, 3, 0, GD, CR); L.shards.push({ x: 25.5, y: 6.7, z: 0.5 });
  L.blocks.push({ x: 22.5, y: 6.5, z: 3.5, item: 'coin' }, { x: 23.5, y: 6.5, z: 3.5, item: 'mushroom' }, { x: 24.5, y: 6.5, z: 3.5, item: 'coin' });
  L.enemies.push({ type: 'walker', x: 22.5, y: 3, z: -3.5, r: 3 }, { type: 'walker', x: 29, y: 3, z: 3, r: 2.5 });
  // --- cloud steps B -> C ---
  [[32, 5, 6, 2.8], [37, 7.5, 10.5, 2.6], [42, 10, 9, 2.8]].forEach(([x, y, z, r]) => { cloudVox(vb, x, y - 1, z, r, 1.4, r * 0.9, WH, CP); L.coins.push([x + 0.5, y + 1.6, z + 0.5]); });
  // --- C: pipe island ---
  island(vb, 52, 10, 9, 8.5, 7, A, 3); pipeVox(vb, 56, 14, 10, 4, PP, PL, PD); L.pipes.push({ x: 56.5, y: 14, z: 14.5, id: 0, to: 1, h: 4 }); vb.set(52, 10, 14, PE); vb.set(53, 10, 14, PE); vb.set(53, 11, 14, PE);
  blossomTree(vb, 47, 10, 4, 5, BR, BL2, BL, 2.6);
  L.blocks.push({ x: 50.5, y: 14.5, z: 10.5, item: 'coin' }, { x: 51.5, y: 14.5, z: 10.5, item: 'coin' }, { x: 52.5, y: 14.5, z: 10.5, item: 'mushroom' });
  L.enemies.push({ type: 'shell', x: 50, y: 10, z: 7, r: 3.5 }, { type: 'walker', x: 54, y: 10, z: 12, r: 2.5 });
  // --- bridge C -> D (toward -z, descending then rising) ---
  bridgeVox(L, 52, 10, 1, 0, -1, 13, 3, 0.15, WD, CR, 3);
  // --- D: the rotating island (analytic disc + visual cubes carried around) ---
  const D = { cx: 52, cy: 12, cz: -19, R: 6.4 }; L.rot.push({ ...D, w: 0.45, ang: 0, cells: [] });
  for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) { const d = Math.hypot(x + 0.5, z + 0.5); if (d < D.R) { const p = d < 1.6 ? GD : (Math.floor(Math.atan2(z + 0.5, x + 0.5) / (PI / 4)) & 1) ? PK : CR; L.rot[0].cells.push([x, -2, z, p]); L.rot[0].cells.push([x, -1, z, d > D.R - 1 ? LI : p === GD ? CR : PE]); } }
  L.shards.push({ x: 52.5, y: 14.6, z: -18.5 }); L.coins.push(...[0, 1, 2, 3, 4, 5].map(k => [52.5 + Math.cos(k * 1.047) * 4.4, 13.6, -18.5 + Math.sin(k * 1.047) * 4.4]));
  // --- bridge D -> F (west, rising) ---
  bridgeVox(L, 46, 12, -19, -1, 0, 14, 3, 0.15, WD, CR, 3);
  // --- F: low gravity pocket island ---
  island(vb, 26, 14, -20, 7, 6, A, 4); L.lowg.push({ x: 26.5, y: 22, z: -19.5, r: 11 });
  [[22, 19, -22], [27, 23, -17], [31, 26.5, -22]].forEach(([x, y, z], k) => { cloudVox(vb, x, y - 1, z, 2.2, 1.1, 2.2, WH, CP); L.coins.push([x + 0.5, y + 1.6, z + 0.5]); });
  setPedestal(vb, 31, 26, -22, GD, CR); L.shards.push({ x: 31.5, y: 29.6, z: -21.5 });
  L.blocks.push({ x: 24.5, y: 18, z: -20.5, item: 'coin' });
  L.enemies.push({ type: 'walker', x: 28, y: 14, z: -23, r: 2.5 });
  // --- E: the final island (pipe destination) at the far west; flat plinth for the next shatter ---
  island(vb, -34, 24, -28, 9, 8, A, 5); vb.cyl(-34, -28, 23, 24, 4.8, CR, (x, y, z) => ((x + z) & 1) ? CR : MN);
  blossomTree(vb, -39, 24, -32, 6, BR, BL, BL2, 3); pipeVox(vb, -38, -24, 24, 5, PP, PL, PD); L.pipes.push({ x: -37.5, y: 29, z: -23.5, id: 1, to: 0, h: 5 });
  L.shards.push({ x: -33.5, y: 25.7, z: -27.5, final: true }); L.coins.push(...[0, 1, 2, 3, 4].map(k => [-33.5 + Math.cos(k * 1.26) * 3.8, 25, -27.5 + Math.sin(k * 1.26) * 3.8]));
  L.enemies.push({ type: 'walker', x: -30, y: 24, z: -31, r: 2.5 }, { type: 'shell', x: -37, y: 24, z: -27, r: 3 });
  // --- waterfalls of falling cubes ---
  L.streams.push({ x: 31.5, y: 3, z: 3.5, len: 55, n: 70 }, { x: -28.5, y: 24, z: -21.5, len: 70, n: 70 }, { x: 59.5, y: 10, z: 12.5, len: 60, n: 60 });
  L.start = { x: 0.5, y: 0, z: 0.5 }; L.deathY = -50; L.name = 'SKY ARCHIPELAGO';
  L.hints = ['Welcome, traveller! The valley is gone... but the world rebuilds itself as you run.', 'Follow the bridge. Ground-pound a plank and it crumbles. Hold RMB to rewind it.', 'Green pipes are warp pipes: crouch (Z) on top of one to travel.'];
  return L;
}

function buildAct3(O, plinthR) {
  const L = mkLevel(3, O), vb = L.vb; L.cellGroup = new Map();
  const MG = vb.addPal(0.92, 0.16, 0.62), TL = vb.addPal(0.1, 0.78, 0.8), PU = vb.addPal(0.22, 0.1, 0.38), PU2 = vb.addPal(0.34, 0.16, 0.55), CRM = vb.addPal(1, 0.86, 0.94), RV = vb.addPal(0.2, 1, 0.9, 10.9), RV2 = vb.addPal(1, 0.3, 0.8, 10.9),
    CV = vb.addPal(0.75, 0.35, 1, 0.8), CV2 = vb.addPal(0.2, 0.95, 0.95, 0.85), CV3 = vb.addPal(1, 0.35, 0.75, 0.85), PD = vb.addPal(1, 0.9, 0.4, 0.95), PAD = vb.addPal(0.5, 1, 0.9, 0.95), PP = vb.addPal(0.16, 0.72, 0.32), PL = vb.addPal(0.55, 0.96, 0.58), GD = vb.addPal(1, 0.82, 0.3, 0.6), WD = vb.addPal(0.5, 0.35, 0.55), WL = vb.addPal(0.14, 0.07, 0.24);
  const wide = Q.cap >= 30000, mid = Q.cap >= 20000, len = wide ? 60 : mid ? 54 : 48, hw = wide ? 19 : mid ? 16 : 12, H = wide ? 30 : mid ? 26 : 22; // canyon length, half width, ceiling height
  L.canyon = { len, hw, H }; L.filter = (x, y, z) => Math.abs(z) <= hw + 3 && y >= -3 && y <= H + 1 && x > -13 && x < len + 2;
  const noise = (x, z) => 0.5 * n3(x * 0.07 + 3, 1, z * 0.07) + 0.3 * n3(x * 0.16, 7, z * 0.16 + 5) + 0.2 * n3(x * 0.4, 3, z * 0.4);
  const riverZ = x => 5 * Math.sin(x * 0.07) + 2 * Math.sin(x * 0.19 + 1);
  for (let x = -12; x <= len; x++) {
    for (let z = -hw - 8; z <= hw + 8; z++) {
      const az = Math.abs(z), inCanyon = az < hw + 2 * n3(x * 0.1, 0, 4);
      const wallH = H + 4;
      if (!inCanyon) { // canyon walls: solid rock from floor to ceiling
        for (let y = -3; y <= wallH; y++) vb.set(x, y, z, (Math.floor((y + n3(x * 0.2, 0, z * 0.2) * 3) / 2) & 1) ? PU2 : PU);
        continue;
      }
      const edge = clamp(1 - (hw - az) / 5, 0, 1), fh = Math.round(edge * 3 * n3(x * 0.3, 1, z * 0.3) + noise(x, z) * 1.6 - 0.4);
      // candy-stripe floor
      const stripe = (Math.floor((x + z * 0.6) / 3) & 1);
      const rz = riverZ(x), inRiver = Math.abs(z - rz) < 2.6 && x > 8 && x < len - 8;
      const top = inRiver ? -2 : Math.max(-1, fh);
      for (let y = -4; y <= top - 1; y++) vb.set(x, y, z, y === top - 1 ? (inRiver ? RV : stripe ? MG : TL) : PU);
      if (inRiver) vb.set(x, -3, z, RV);
      // ceiling slab: hanging terrain (walkable underside when gravity is flipped)
      const ch = Math.round(noise(x + 40, z - 30) * 3.4 + edge * 2.5);
      for (let y = H - ch; y <= wallH; y++) vb.set(x, y, z, y === H - ch ? ((Math.floor((x - z * 0.6) / 3) & 1) ? CRM : MG) : y < H - ch + 2 ? PU2 : PU);
    }
  }
  // end cap + start cap so the canyon is enclosed
  for (let z = -hw - 8; z <= hw + 8; z++) for (let y = -3; y <= H + 4; y++) { vb.set(len + 1, y, z, PU); vb.set(len + 2, y, z, PU); vb.set(-13, y, z, PU); }
  // start plinth: flat glowing disc at y=0
  vb.cyl(0, 0, -1, 0, plinthR + 1.6, TL, (x, y, z) => Math.hypot(x + 0.5, z + 0.5) > plinthR + 0.5 ? MG : ((x + z) & 1) ? TL : CRM);
  for (let y = -5; y < -1; y++) vb.cyl(0, 0, y, y + 1, plinthR + 1.6, PU);
  // crystals: stalagmites + stalactites
  const crystal = (cx, cz, y0, up, h, r, p) => { for (let k = 0; k < h; k++) { const rr = r * (1 - k / (h + 1)); vb.cyl(cx, cz, up > 0 ? y0 + k : y0 - k, up > 0 ? y0 + k + 1 : y0 - k + 1, Math.max(0.6, rr), p); } };
  const cr = mulberry(333);
  for (let k = 0; k < (wide ? 54 : 34); k++) { const x = Math.floor(cr() * (len - 16)) + 8, z = Math.floor((cr() * 2 - 1) * (hw - 3)); if (Math.hypot(x, z) < 8 || (Math.abs(z - riverZ(x)) < 4 && x > 8)) continue; const base = vb.get(x, 0, z) ? 1 : (vb.get(x, -1, z) ? 0 : -1); if (base < 0) continue; crystal(x, z, 0, 1, 3 + ((cr() * 5) | 0), 1.7 + cr() * 1.1, cr() < 0.5 ? CV : cr() < 0.5 ? CV2 : CV3); }
  for (let k = 0; k < (wide ? 60 : 38); k++) { const x = Math.floor(cr() * (len - 10)) + 5, z = Math.floor((cr() * 2 - 1) * (hw - 2)); let top = H; while (top > 8 && !vb.get(x, top, z)) top--; if (top > H + 1 || top < 16) continue; crystal(x, z, top - 1, -1, 3 + ((cr() * 6) | 0), 1.8 + cr() * 1.2, cr() < 0.5 ? CV3 : cr() < 0.5 ? CV2 : CV); }
  // flip pads: floor pad + ceiling pad
  const padAt = (px, pz, y, dir) => { vb.cyl(px, pz, y - (dir > 0 ? 1 : 0), y - (dir > 0 ? 0 : -1), 2, PAD, (x, yy, z) => Math.hypot(x + 0.5 - px, z + 0.5 - pz) < 1.1 ? PD : PAD); };
  const floorTop = (x, z) => { for (let y = 6; y >= -4; y--) if (vb.get(x, y, z)) return y + 1; return 0; };
  const ceilBot = (x, z) => { for (let y = H - 8; y <= H + 6; y++) if (vb.get(x, y, z)) return y; return H; };
  const f1 = [12, 6], f2 = [Math.floor(len * 0.62), -6], c1 = [Math.floor(len * 0.36), 4], c2 = [len - 12, 0];
  L.pads.push({ x: f1[0] + 0.5, y: floorTop(...f1), z: f1[1] + 0.5, dir: 1 }); padAt(f1[0], f1[1], floorTop(...f1), 1);
  L.pads.push({ x: c1[0] + 0.5, y: ceilBot(...c1), z: c1[1] + 0.5, dir: -1 }); padAt(c1[0], c1[1], ceilBot(...c1), -1);
  L.pads.push({ x: f2[0] + 0.5, y: floorTop(...f2), z: f2[1] + 0.5, dir: 1 }); padAt(f2[0], f2[1], floorTop(...f2), 1);
  L.pads.push({ x: c2[0] + 0.5, y: ceilBot(...c2), z: c2[1] + 0.5, dir: -1 }); padAt(c2[0], c2[1], ceilBot(...c2), -1);
  // shards: floor, ceiling, final (on the end plinth)
  const s1 = [28, -4]; setPedestal(vb, s1[0], floorTop(...s1) - 1, s1[1], GD, WL); L.shards.push({ x: s1[0] + 0.5, y: floorTop(...s1) + 1.8, z: s1[1] + 0.5 });
  const s2 = [Math.floor(len * 0.5), 6]; L.shards.push({ x: s2[0] + 0.5, y: ceilBot(...s2) - 1.9, z: s2[1] + 0.5, ceil: true }); vb.set(s2[0], ceilBot(...s2) - 1, s2[1], GD);
  const fin = [len - 6, 0]; const ft = floorTop(...fin); vb.cyl(fin[0], fin[1], ft - 1, ft, 4.8, CRM, (x, y, z) => ((x + z) & 1) ? CRM : TL); for (let y = ft - 4; y < ft - 1; y++) vb.cyl(fin[0], fin[1], y, y + 1, 4.8, PU); L.shards.push({ x: fin[0] + 0.5, y: ft + 1.7, z: fin[1] + 0.5, final: true });
  // coins in arcs, blocks, enemies
  for (let k = 0; k < 7; k++) L.coins.push([18 + k * 1.6 + 0.5, 2.2 + Math.sin(k / 6 * PI) * 2.4, 0.5]);
  for (let k = 0; k < 6; k++) { const x = Math.floor(len * 0.4) + k * 1.6; L.coins.push([x + 0.5, ceilBot(Math.floor(x), 8) - 2.2, 8.5]); }
  L.blocks.push({ x: 10.5, y: 4.5, z: -3.5, item: 'mushroom' }, { x: 36.5, y: 4.5, z: 2.5, item: 'coin' }, { x: 37.5, y: 4.5, z: 2.5, item: 'coin' });
  L.enemies.push({ type: 'walker', x: 22, y: floorTop(22, 3), z: 3, r: 4 }, { type: 'shell', x: 34, y: floorTop(34, -5), z: -5, r: 4 }, { type: 'walker', x: Math.floor(len * 0.5) - 4, y: ceilBot(Math.floor(len * 0.5) - 4, 2), z: 2, r: 5, ceil: true }, { type: 'walker', x: Math.floor(len * 0.7), y: ceilBot(Math.floor(len * 0.7), -4), z: -4, r: 5, ceil: true }, { type: 'walker', x: len - 18, y: floorTop(len - 18, 4), z: 4, r: 4 });
  L.npc = { x: 3.5, y: 0, z: 3.5 }; L.start = { x: 0.5, y: 0, z: 0.5 }; L.deathY = -30; L.name = 'NEON CANYON';
  L.hints = ['The canyon hums with colour. See the glowing hex pad? Press E on it to flip gravity.', 'The ceiling is a world too. Fall upward, and watch the enemies up there!', 'Three Sun Shards remain. The last one waits at the canyon\'s end.'];
  L.streams.push({ x: 20.5, y: 28, z: 10.5, len: 28, n: 40, color: RV2 }, { x: len * 0.7 + 0.5, y: 28, z: -9.5, len: 28, n: 40, color: RV2 });
  return L;
}

// ---- turning a level into flying cubes ------------------------------------------------------------------------------
function levelCellKey(x, y, z) { return (x + 512) * 1048576 + (y + 512) * 1024 + (z + 512); }
function rebuildWorld() {
  SH.rebuilt = true; const to = SH.to, from = SH.from, T = TUNING.shatter;
  if (to === 4) { finaleBegin(); return; }
  const O = { x: Math.floor(SH.cx), y: Math.round(SH.cy), z: Math.floor(SH.cz) };
  if (to === 2) LV = buildAct2(O, T.plinth); else if (to === 3) LV = buildAct3(O, T.plinth); else LV = null;
  if (!LV) return;
  const vb = LV.vb, surf = vb.surface(LV.filter), n = surf.n;
  // fresh collision grid (filled as cubes arrive); the plinth region is solid immediately so the hero never loses footing
  const grid = new Uint8Array(GX * GY * GZ); VG.on = true; VG.ox = O.x - GOX; VG.oy = O.y - GOY; VG.oz = O.z - GOZ; VG.nx = GX; VG.ny = GY; VG.nz = GZ; VG.data = grid; WC.hf = false;
  for (const b of BOXES) b.on = false; LV.colliders = []; DISCS.length = 0;
  // held cubes: the exact cubes under the hero's feet become the new world's start island
  const heldMap = new Map();
  if (from === 1) {
    for (const ci of SH.plinth) { const k = allocCube(); if (k < 0) continue; const i = ci % GRID, j = (ci / GRID) | 0, x = i - HALF + 0.5, z = j - HALF + 0.5; setCubeTransform(k, x, HQ[ci] - 0.5, z, 1, CELLCOL[ci * 3], CELLCOL[ci * 3 + 1], CELLCOL[ci * 3 + 2]); C.st[k] = ST.SET; C.vox[k] = 1; C.owner[k] = -2; writeCube(k); heldMap.set(levelCellKey(Math.floor(x) - O.x, HQ[ci] - 1 - O.y, Math.floor(z) - O.z), k); vgSet(Math.floor(x), HQ[ci] - 1, Math.floor(z), 1); DROPT[ci] = 1; dropActive = true; FALLT[ci] = SH.t + 1.2 + hash2(ci, 3) * 0.6; collapsing = true; }
    // also any column under the plinth cube layer can fall; keep a solid layer under the hero in the grid
    for (const ci of SH.plinth) { const i = ci % GRID, j = (ci / GRID) | 0; for (let y = 2; y <= 4; y++) vgSet(i - HALF, HQ[ci] - y, j - HALF, 1); }
  } else {
    for (let i = 0; i < cubeHi; i++) if (C.owner[i] === -2 && C.st[i] !== ST.FREE) { heldMap.set(levelCellKey(Math.floor(C.x[i]) - O.x, Math.floor(C.y[i]) - O.y, Math.floor(C.z[i]) - O.z), i); vgSet(Math.floor(C.x[i]), Math.floor(C.y[i]), Math.floor(C.z[i]), 1); }
  }
  // targets sorted by build order (outward from the hero and upward) -> stairs/bridges unfold toward where you run
  const order = new Int32Array(n); for (let i = 0; i < n; i++) order[i] = i; const key = new Float32Array(n);
  for (let i = 0; i < n; i++) { const dx = surf.x[i] + 0.5, dy = surf.y[i] + 0.5, dz = surf.z[i] + 0.5; key[i] = Math.hypot(dx, dz) * 1.0 + Math.abs(dy) * 0.5 + hash3(surf.x[i], surf.y[i], surf.z[i]) * 2; }
  order.sort((a, b) => key[a] - key[b]);
  // available pool cubes (debris), shuffled
  const pool = []; for (let i = 0; i < cubeHi; i++) { const s = C.st[i]; if ((s === ST.BALL || s === ST.REST) && C.owner[i] !== -2) pool.push(i); }
  for (let i = pool.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
  const span = 5.2, t0 = 0.0; let pi = 0, assigned = 0; const maxKey = key[order[n - 1]] || 1;
  const rot0 = LV.rot.length ? LV.rot[0] : null;
  for (let oi = 0; oi < n; oi++) {
    const ti = order[oi], x = surf.x[ti], y = surf.y[ti], z = surf.z[ti], p = surf.p[ti]; const kk = levelCellKey(x, y, z);
    let cube = heldMap.get(kk), held = false; if (cube !== undefined) held = true; else { while (pi < pool.length && C.st[pool[pi]] === ST.FREE) pi++; if (pi >= pool.length) { cube = allocCube(); if (cube < 0) continue; C.x[cube] = O.x + x + 0.5 + (Math.random() - 0.5) * 60; C.y[cube] = O.y - 40 - Math.random() * 20; C.z[cube] = O.z + z + 0.5 + (Math.random() - 0.5) * 60; C.vox[cube] = 1; C.r[cube] = 0.9; C.g[cube] = 0.7; C.b[cube] = 0.4; } else cube = pool[pi++]; }
    const tx = O.x + x + 0.5, ty = O.y + y + 0.5, tz = O.z + z + 0.5, col = jit(vb.pal[p], x, y, z, 0.06);
    C.tx[cube] = tx; C.ty[cube] = ty; C.tz[cube] = tz; C.tr[cube] = col[0]; C.tg[cube] = col[1]; C.tb[cube] = col[2]; C.tgl[cube] = vb.palFx[p]; C.ts[cube] = 1; C.owner[cube] = held ? -2 : -1; C.rew[cube] = 0;
    setCubeAO(cube, surf.a[ti], surf.b[ti]); C.grp[cube] = LV.cellGroup.get(kk) ?? -1; if (C.grp[cube] >= 0) LV.groups[C.grp[cube]].cubes.push(cube);
    C.delay[cube] = held ? 0.15 : t0 + Math.pow(key[ti] / maxKey, 0.85) * span; if (held) { C.st[cube] = ST.REST; C.r0[cube] = C.r[cube]; C.g0[cube] = C.g[cube]; C.b0[cube] = C.b[cube]; }
    if (C.st[cube] !== ST.REST) { C.st[cube] = C.st[cube] === ST.FREE ? ST.BALL : C.st[cube]; }
    assigned++;
  }
  // held cubes that matched no target just join the world as-is (they stay), leftover pool cubes become ambient specks or dissolve
  let amb = 0; const ambMax = Q.cap >= 40000 ? 3200 : Q.cap >= 25000 ? 1500 : 500;
  for (; pi < pool.length; pi++) { const k = pool[pi]; if (C.st[k] === ST.FREE) continue; if (amb < ambMax && Math.random() < 0.5) { amb++; C.tx[k] = O.x + (Math.random() - 0.5) * 120; C.ty[k] = O.y + (Math.random() - 0.3) * 50 + 8; C.tz[k] = O.z + (Math.random() - 0.5) * 120; C.ts[k] = 0.18 + Math.random() * 0.4; const c = vb.pal[1 + ((Math.random() * (vb.pal.length - 1)) | 0)]; C.tr[k] = c[0]; C.tg[k] = c[1]; C.tb[k] = c[2]; C.tgl[k] = 0; C.owner[k] = -3; C.wy[k] = Math.random() * 20; C.wx[k] = Math.random() * 6; C.wz[k] = Math.random() * 6; C.delay[k] = 0.5 + Math.random() * span; C.rew[k] = 0; C.st[k] = ST.BALL; C.grp[k] = -5; }
    else { C.st[k] = ST.DIE; C.age[k] = -Math.random() * 3; } }
  // held cubes recolour towards the new palette (plinth morphs in place)
  LV.surf = surf; LV.n = n; LV.O = O;
  // rotating island cubes
  for (const R of LV.rot) { R.cubes = []; for (const [lx, ly, lz, p] of R.cells) { const k = allocCube(); if (k < 0) break; const col = jit(vb.pal[p] || [1, 1, 1], lx, ly, lz, 0.05); setCubeTransform(k, R.cx + O.x + lx + 0.5, R.cy + O.y + ly + 0.5, R.cz + O.z + lz + 0.5, 0.01, col[0], col[1], col[2]); C.hx[k] = lx + 0.5; C.hy[k] = ly + 0.5; C.hz[k] = lz + 0.5; C.ts[k] = 1; C.st[k] = ST.ROT; C.owner[k] = -1; C.delay[k] = 0; C.glow[k] = 0; C.tgl[k] = 0; C.vox[k] = 1; R.cubes.push(k); } R.cxw = R.cx + O.x; R.czw = R.cz + O.z; R.cyw = R.cy + O.y; DISCS.push({ cx: R.cxw, cz: R.czw, R: R.R, y0: R.cyw - 2, y1: R.cyw, w: R.w, ang: 0, ref: R }); }
  // waterfalls
  for (const s of LV.streams) { s.cubes = []; for (let q = 0; q < s.n; q++) { const k = allocCube(); if (k < 0) break; const pc = s.color ? vb.pal[s.color] : vb.pal[LV.pal.WT]; setCubeTransform(k, O.x + s.x, O.y + s.y, O.z + s.z, 0.01, pc[0], pc[1], pc[2]); C.st[k] = ST.STRM; C.ts[k] = 0.35 + hash2(q, 9) * 0.35; C.wy[k] = hash2(q, 2); C.wx[k] = (hash2(q, 3) - 0.5) * 1.6; C.wz[k] = (hash2(q, 4) - 0.5) * 1.6; C.tx[k] = O.x + s.x; C.ty[k] = O.y + s.y; C.tz[k] = O.z + s.z; C.glow[k] = s.color ? 10.8 : 0.3; C.vox[k] = 0.0; C.owner[k] = -1; C.delay[k] = 0; C.hx[k] = s.len; C.hy[k] = 0.7 + hash2(q, 6) * 0.6; s.cubes.push(k); } }
  setupLevelEntities(LV);
  // hero: stay put; the collision world is now the grid
  G.cineLock = false; sfx('rebuild');
}

