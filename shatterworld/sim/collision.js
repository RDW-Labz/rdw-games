// ============================================================================
// WORLD COLLISION (boxes + voxel grid + act-1 heightfield), gravity-frame aware
// ============================================================================
const WC = { hf: true };
const VG = { on: false, ox: 0, oy: 0, oz: 0, nx: 0, ny: 0, nz: 0, data: null };
let GF = 1; // gravity frame: +1 normal, -1 flipped (hero walks on ceilings)
const HW = TUNING.radius;
const S = { hit: false, top: -1e9, bot: 1e9, topHF: -1e9, topO: -1e9, box: null, hi: 0 };
let _wy0 = 0, _wy1 = 0;
function vgSolid(ix, iy, iz) { if (!VG.on) return false; ix -= VG.ox; iy -= VG.oy; iz -= VG.oz; if (ix < 0 || iy < 0 || iz < 0 || ix >= VG.nx || iy >= VG.ny || iz >= VG.nz) return false; return VG.data[(iy * VG.nz + iz) * VG.nx + ix] !== 0; }
function vgSet(ix, iy, iz, v) { ix -= VG.ox; iy -= VG.oy; iz -= VG.oz; if (ix < 0 || iy < 0 || iz < 0 || ix >= VG.nx || iy >= VG.ny || iz >= VG.nz) return; VG.data[(iy * VG.nz + iz) * VG.nx + ix] = v; }
function _cbScan(b) {
  if (b.y1 > _wy0 + 0.001 && b.y0 < _wy1 - 0.001) {
    S.hit = true; const top = GF > 0 ? b.y1 : -b.y0, bot = GF > 0 ? b.y0 : -b.y1;
    if (top > S.top) { S.top = top; S.topO = Math.max(S.topO, top); } if (bot < S.bot) { S.bot = bot; S.box = b; }
  }
}
// overlap test for the hero body (feet centre x,z; gravity-frame feet height gy; height h)
function scan(x, gy, z, h) {
  S.hit = false; S.top = -1e9; S.bot = 1e9; S.topHF = -1e9; S.topO = -1e9; S.box = null;
  const r = HW; _wy0 = GF > 0 ? gy : -gy - h; _wy1 = _wy0 + h;
  if (WC.hf && GF > 0) {
    for (let i = 0; i < 5; i++) { const px = i === 0 ? x : x + (i & 1 ? r : -r), pz = i === 0 ? z : z + (i > 2 ? r : -r), g = hfGround(px, pz); if (g > gy + 0.0005) { S.hit = true; if (g > S.top) S.top = g; if (g > S.topHF) S.topHF = g; } }
  }
  boxesIn(x - r, z - r, x + r, z + r, _cbScan);
  for (let i = 0; i < DISCS.length; i++) { const d = DISCS[i]; if (d.y1 > _wy0 + 0.001 && d.y0 < _wy1 - 0.001) { const dx = x - d.cx, dz = z - d.cz; if (dx * dx + dz * dz < (d.R + 0.1) * (d.R + 0.1)) { S.hit = true; const top = GF > 0 ? d.y1 : -d.y0, bot = GF > 0 ? d.y0 : -d.y1; if (top > S.top) { S.top = top; if (top > S.topO) S.topO = top; } if (bot < S.bot) { S.bot = bot; S.box = null; } } } }
  if (VG.on) {
    const ix0 = Math.floor(x - r), ix1 = Math.floor(x + r - 1e-4), iz0 = Math.floor(z - r), iz1 = Math.floor(z + r - 1e-4), iy0 = Math.floor(_wy0 + 0.001), iy1 = Math.floor(_wy1 - 0.001);
    for (let ix = ix0; ix <= ix1; ix++) for (let iz = iz0; iz <= iz1; iz++) for (let iy = iy0; iy <= iy1; iy++) if (vgSolid(ix, iy, iz)) {
      S.hit = true; const top = GF > 0 ? iy + 1 : -iy, bot = GF > 0 ? iy : -(iy + 1); if (top > S.top) { S.top = top; if (top > S.topO) S.topO = top; } if (bot < S.bot) { S.bot = bot; S.box = null; }
    }
  }
  return S.hit;
}
// solid test for a world point (camera / bullets / enemies)
let _ptHit = false, _ptx = 0, _pty = 0, _ptz = 0;
function _cbPt(b) { if (_pty > b.y0 && _pty < b.y1 && _ptx > b.x0 && _ptx < b.x1 && _ptz > b.z0 && _ptz < b.z1) _ptHit = true; }
function solidPoint(x, y, z) {
  if (WC.hf && y < hfGround(x, z)) return true;
  if (VG.on && vgSolid(Math.floor(x), Math.floor(y), Math.floor(z))) return true;
  _ptHit = false; _ptx = x; _pty = y; _ptz = z; boxesIn(x - 0.01, z - 0.01, x + 0.01, z + 0.01, _cbPt); return _ptHit;
}
// highest walkable floor at (x,z) not above yMax (world frame) - for enemies / items
function floorAt(x, z, yMax) {
  let best = -1e9;
  if (WC.hf) { const g = hfGround(x, z); if (g <= yMax) best = g; else best = -1e9; }
  if (VG.on) { for (let iy = Math.floor(yMax); iy > Math.floor(yMax) - 40; iy--) { if (vgSolid(Math.floor(x), iy, Math.floor(z)) && !vgSolid(Math.floor(x), iy + 1, Math.floor(z))) { best = Math.max(best, iy + 1); break; } } }
  _fy = yMax; _fb = best; _fx = x; _fz = z; boxesIn(x - 0.01, z - 0.01, x + 0.01, z + 0.01, _cbFloor); return _fb;
}
let _fy = 0, _fb = 0, _fx = 0, _fz = 0;
function _cbFloor(b) { if (b.y1 <= _fy + 0.01 && b.y1 > _fb && _fx > b.x0 && _fx < b.x1 && _fz > b.z0 && _fz < b.z1) _fb = b.y1; }

