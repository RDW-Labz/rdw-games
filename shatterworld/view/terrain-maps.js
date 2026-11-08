// ---- colour + normal maps -----------------------------------------------------------------------------------------
function segDist(px, pz, ax, az, bx, bz) { const dx = bx - ax, dz = bz - az, t = clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz), 0, 1); return Math.hypot(px - (ax + dx * t), pz - (az + dz * t)); }
function pathDist(x, z) { let m = 1e9; for (let i = 0; i < PATH.length - 1; i++) m = Math.min(m, segDist(x, z, PATH[i][0], PATH[i][1], PATH[i + 1][0], PATH[i + 1][1])); return m; }
const s2l = v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
const _c = [0, 0, 0, 0];
function terrColour(x, z, out) { // writes sRGB rgb + grass mask
  const h = hfSample(x, z), sl = terrSlope(x, z);
  const n1 = 0.5 + 0.5 * fbm(x * 0.045 + 7, z * 0.045 - 3, 3), n2 = snoise(x * 0.27 + 1.3, z * 0.27 + 8.1), n3 = snoise(x * 0.9, z * 0.9 + 4);
  const gold = sstep(0.34, 0.78, n1);
  let r = lerp(0.24, 0.62, gold), g = lerp(0.50, 0.58, gold), b = lerp(0.10, 0.17, gold);
  const clover = sstep(0.1, 0.7, n2) * 0.5; r *= 1 - 0.18 * clover; g *= 1 + 0.06 * clover; b *= 1 + 0.15 * clover;
  const sp = 0.93 + 0.14 * n3; r *= sp; g *= sp; b *= sp;
  const d = Math.abs(x - riverX(z));
  let gm = 1;
  const bank = 1 - sstep(2.6, 6.2, d + 0.9 * snoise(x * 0.2, z * 0.2));
  const wet = 1 - sstep(WATER_Y - 0.2, WATER_Y + 0.55, h);
  const sand = Math.max(bank * sstep(WATER_Y + 1.6, WATER_Y + 0.3, h), wet);
  r = lerp(r, lerp(0.58, 0.40, wet), sand); g = lerp(g, lerp(0.49, 0.37, wet), sand); b = lerp(b, lerp(0.33, 0.30, wet), sand); gm *= 1 - sand;
  const rockT = sstep(0.62, 1.0, sl + 0.15 * n2) + sstep(17, 27, h + 3 * n2);
  const rk = clamp(rockT, 0, 1), rv = 0.84 + 0.3 * snoise(x * 0.4 + h * 0.8, z * 0.4);
  r = lerp(r, 0.50 * rv, rk); g = lerp(g, 0.44 * rv, rk); b = lerp(b, 0.38 * rv, rk); gm *= 1 - rk;
  const snow = sstep(32, 40, h + 4 * n3) * 0.9; r = lerp(r, 0.9, snow); g = lerp(g, 0.92, snow); b = lerp(b, 0.96, snow); gm *= 1 - snow;
  const pd = pathDist(x, z), pt = 1 - sstep(0.35, 1.25, pd + 0.45 * n3); r = lerp(r, 0.66, pt * 0.8); g = lerp(g, 0.56, pt * 0.8); b = lerp(b, 0.36, pt * 0.8); gm *= 1 - pt;
  // flagstones under the castle courtyard + basalt site
  for (const k of ['s5', 's4']) { const s = SITES[k], dd = Math.hypot(x - s.x, z - s.z), st = 1 - sstep(s.r0 * (k === 's5' ? 0.95 : 0.6), s.r0 * 1.15, dd); if (st > 0) { const f = 0.85 + 0.2 * snoise(x * 1.6, z * 1.6); r = lerp(r, 0.52 * f, st); g = lerp(g, 0.49 * f, st); b = lerp(b, 0.44 * f, st); gm *= 1 - st; } }
  // golden-hour warmth + subtle ambient occlusion in hollows
  out[0] = r; out[1] = g; out[2] = b; out[3] = clamp(gm, 0, 1);
}
let colCanvas, texCol, texNm, texHS, texHW, texQH, texDrop, CELLCOL;
function buildTerrainTextures() {
  const N = Q.tex;
  colCanvas = document.createElement('canvas'); colCanvas.width = colCanvas.height = N;
  const ctx = colCanvas.getContext('2d'), img = ctx.createImageData(N, N), d = img.data;
  const cell = new Float32Array(GRID * GRID * 3), cmask = new Float32Array(GRID * GRID), cnt = N / GRID;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    terrColour(((i + 0.5) / N) * 128 - HALF, ((j + 0.5) / N) * 128 - HALF, _c);
    const k = (j * N + i) * 4; d[k] = _c[0] * 255 + 0.5; d[k + 1] = _c[1] * 255 + 0.5; d[k + 2] = _c[2] * 255 + 0.5; d[k + 3] = 255;
    const ci = ((j / cnt) | 0) * GRID + ((i / cnt) | 0);
    cell[ci * 3] += s2l(_c[0]); cell[ci * 3 + 1] += s2l(_c[1]); cell[ci * 3 + 2] += s2l(_c[2]); cmask[ci] += _c[3];
  }
  const inv = 1 / (cnt * cnt); for (let i = 0; i < cell.length; i++) cell[i] *= inv * (1 - 0.34 * cmask[(i / 3) | 0] * inv);
  CELLCOL = cell; ctx.putImageData(img, 0, 0);
  texCol = new THREE.CanvasTexture(colCanvas); texCol.flipY = false; texCol.colorSpace = THREE.SRGBColorSpace; texCol.generateMipmaps = true; texCol.minFilter = THREE.LinearMipmapLinearFilter; texCol.anisotropy = 8; texCol.wrapS = texCol.wrapT = THREE.ClampToEdgeWrapping;
  // normal/mask map 256^2 : r = nx, g = nz, b = grass mask
  const M = 256, nm = new Uint8Array(M * M * 4);
  for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
    const x = ((i + 0.5) / M) * 128 - HALF, z = ((j + 0.5) / M) * 128 - HALF, e = 0.5;
    const dx = hfSample(x + e, z) - hfSample(x - e, z), dz = hfSample(x, z + e) - hfSample(x, z - e);
    const inv = 1 / Math.hypot(dx, 2 * e, dz), nx = -dx * inv, nz = -dz * inv;
    terrColour(x, z, _c); const k = (j * M + i) * 4;
    nm[k] = (nx * 0.5 + 0.5) * 255; nm[k + 1] = (nz * 0.5 + 0.5) * 255; nm[k + 2] = _c[3] * 255; nm[k + 3] = 255;
  }
  texNm = new THREE.DataTexture(nm, M, M, THREE.RGBAFormat); texNm.minFilter = texNm.magFilter = THREE.LinearFilter; texNm.needsUpdate = true;
  texHS = new THREE.DataTexture(HS, NV, NV, THREE.RedFormat, THREE.FloatType); texHS.minFilter = texHS.magFilter = THREE.NearestFilter; texHS.needsUpdate = true;
  const hh = new Uint16Array(NV * NV); for (let i = 0; i < hh.length; i++) hh[i] = THREE.DataUtils.toHalfFloat(HS[i]);
  texHW = new THREE.DataTexture(hh, NV, NV, THREE.RedFormat, THREE.HalfFloatType); texHW.minFilter = texHW.magFilter = THREE.LinearFilter; texHW.needsUpdate = true;
  texQH = new THREE.DataTexture(HQ, GRID, GRID, THREE.RedFormat, THREE.FloatType); texQH.minFilter = texQH.magFilter = THREE.NearestFilter; texQH.needsUpdate = true;
  texDrop = new THREE.DataTexture(DROP, GRID, GRID, THREE.RedFormat, THREE.FloatType); texDrop.minFilter = texDrop.magFilter = THREE.NearestFilter; texDrop.needsUpdate = true;
}
buildTerrainTextures();
let dropDirty = false;

