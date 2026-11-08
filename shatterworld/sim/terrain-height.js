// ============================================================================
// ACT 1 TERRAIN - one heightfield, two representations (smooth + voxel columns) blended per fragment by uVox(x).
// ============================================================================
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
const GRID = 128, HALF = 64, NV = GRID + 1, WATER_Y = 1.15;
const riverX = z => 4 + 9 * Math.sin(z * 0.046 + 0.6) + 3.2 * Math.sin(z * 0.12 + 2.0);
// story locations (x, z, plateau radius flat / blend) - shard plateaus are flat on an INTEGER height so the plinth matches the block lattice
const SITES = {
  spawn: { x: -24, z: -46, r0: 4.2, r1: 9 },
  s1: { x: -25, z: -23, r0: 4.6, r1: 10, up: 2 },
  s2: { x: 12.2, z: 2.0, r0: 0, r1: 0 },
  s3: { x: 37, z: 12, r0: 4.8, r1: 11, up: 3 },
  s4: { x: 31, z: 40, r0: 4.6, r1: 10, up: 1 },
  s5: { x: -27, z: 36, r0: 5.2, r1: 12, up: 6 },
};
const PATH = [[-24, -46], [-23, -34], [-25, -23], [-18, -12], [-4, -4], [1.5, 2], [23, 2], [31, 8], [37, 12], [36, 28], [31, 40], [18, 40], [-6, 38], [-27, 36]];

function hillsRaw(x, z) {
  let h = 4.2 + 3.9 * fbm(x * 0.019 + 3.1, z * 0.019 - 1.7, 4);
  const rg = 1 - Math.abs(snoise(x * 0.04 + 9, z * 0.04 - 4)); h += rg * rg * 1.3;
  h += 0.35 * snoise(x * 0.16, z * 0.16);
  return h;
}
function Hbase(x, z) {
  let h = hillsRaw(x, z);
  const d = Math.abs(x - riverX(z));
  const flood = 1 - sstep(8, 26, d);
  h = lerp(h, 2.2 + 0.4 * fbm(x * 0.07, z * 0.07, 2) + d * 0.05, flood * 0.9);
  const bed = -0.12 + 2.15 * sstep(1.4, 6.0, d);
  h = lerp(h, Math.min(h, bed), 1 - sstep(5.2, 7.6, d));
  const r = Math.pow(Math.pow(Math.abs(x), 4) + Math.pow(Math.abs(z), 4), 0.25), rimT = sstep(47, 69, r);
  const rn = Math.max(0, 0.55 + fbm(x * 0.035 + 20, z * 0.035 + 5, 3));
  const rr = 1 - Math.abs(snoise(x * 0.06 - 8, z * 0.06 + 11));
  h += rimT * (6 + 15 * rimT * rn + 3.5 * rr * rimT);
  if (d > 6) h = Math.max(h, WATER_Y + 0.55 + 0.1 * Math.min(d - 6, 5));   // no stray ponds outside the river
  return h;
}
const SITE_H = {};
for (const k in SITES) { const s = SITES[k]; if (s.r0 > 0) { SITE_H[k] = Math.round(Hbase(s.x, s.z)) + (s.up || 0); } }
function HT(x, z) {
  let h = Hbase(x, z);
  for (const k in SITES) { const s = SITES[k]; if (s.r0 <= 0) continue; const d = Math.hypot(x - s.x, z - s.z); if (d < s.r1) h = lerp(h, SITE_H[k], 1 - sstep(s.r0, s.r1, d)); }
  return h;
}
const SHARD_SITES = ['s1', 's2', 's3', 's4', 's5'];

// ---- sampled data -----------------------------------------------------------------------------------------------
const NF = GRID * 2 + 1; // 257 samples (2 per metre)
const HF = new Float32Array(NF * NF);
for (let j = 0; j < NF; j++) for (let i = 0; i < NF; i++) HF[j * NF + i] = HT(i * 0.5 - HALF, j * 0.5 - HALF);
const HS = new Float32Array(NV * NV);            // smooth heights at the 129x129 vertex lattice
for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) HS[j * NV + i] = HF[(j * 2) * NF + i * 2];
const HQ = new Float32Array(GRID * GRID);        // quantised (block) column tops - integer heights
for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) HQ[j * GRID + i] = Math.max(0, Math.round(HT(i - HALF + 0.5, j - HALF + 0.5)));
const DROP = new Float32Array(GRID * GRID);      // how far each column top has been lowered (burst removes 1, collapse removes more)
const DROPV = new Float32Array(GRID * GRID);     // per-column fall velocity (collapse)
function hfSample(x, z) { // bilinear of the 2/m grid
  const fx = clamp((x + HALF) * 2, 0, NF - 1.001), fz = clamp((z + HALF) * 2, 0, NF - 1.001), i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
  const a = HF[j * NF + i], b = HF[j * NF + i + 1], c = HF[(j + 1) * NF + i], d = HF[(j + 1) * NF + i + 1];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
}
function terrSlope(x, z) { const e = 0.6; return Math.hypot(hfSample(x + e, z) - hfSample(x - e, z), hfSample(x, z + e) - hfSample(x, z - e)) / (2 * e); }
// exact CPU mirror of the mesh: triangle interpolation of smooth corner heights, mixed with the flat column top by the voxel field
function hfGround(x, z) {
  const fx = clamp(x + HALF, 0, GRID - 0.0001), fz = clamp(z + HALF, 0, GRID - 0.0001), i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
  const h00 = HS[j * NV + i], h10 = HS[j * NV + i + 1], h01 = HS[(j + 1) * NV + i], h11 = HS[(j + 1) * NV + i + 1];
  const sm = tx + tz <= 1 ? h00 + tx * (h10 - h00) + tz * (h01 - h00) : h11 + (1 - tx) * (h01 - h11) + (1 - tz) * (h10 - h11);
  const ci = j * GRID + i, vx = WV.R1 < 0 ? 0 : voxAtCPU(i - HALF + 0.5, j - HALF + 0.5);
  const flat = HQ[ci] - DROP[ci];
  return vx > 0.0001 ? lerp(sm, flat, vx) : sm - 0 * flat;
}
function colHeight(x, z) { const i = clamp(Math.floor(x + HALF), 0, GRID - 1), j = clamp(Math.floor(z + HALF), 0, GRID - 1); return HQ[j * GRID + i] - DROP[j * GRID + i]; }

