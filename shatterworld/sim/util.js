// ---------------------------------------------------------------------------
// utilities
// ---------------------------------------------------------------------------
const PI = Math.PI, TAU = PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
const wrapPI = a => { a = (a + PI) % TAU; if (a < 0) a += TAU; return a - PI; };
const angDiff = (a, b) => wrapPI(b - a);
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const hash3 = (x, y, z) => { let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1274126177)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
const hash2 = (x, y) => hash3(x, y, 7919);
const _rng = mulberry(20260610); const rnd = () => _rng();

// simplex noise (seeded permutation)
const PERM = new Uint8Array(512);
{ const r = mulberry(99173), p = []; for (let i = 0; i < 256; i++) p.push(i); for (let i = 255; i > 0; i--) { const j = (r() * (i + 1)) | 0; [p[i], p[j]] = [p[j], p[i]]; } for (let i = 0; i < 512; i++) PERM[i] = p[i & 255]; }
const GR = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
function snoise(xin, yin) {
  const s = (xin + yin) * F2, i = Math.floor(xin + s), j = Math.floor(yin + s), t = (i + j) * G2;
  const x0 = xin - (i - t), y0 = yin - (j - t); const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
  const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2, ii = i & 255, jj = j & 255;
  let n = 0, tt = 0.5 - x0 * x0 - y0 * y0; if (tt > 0) { tt *= tt; const g = GR[PERM[ii + PERM[jj]] & 7]; n += tt * tt * (g[0] * x0 + g[1] * y0); }
  tt = 0.5 - x1 * x1 - y1 * y1; if (tt > 0) { tt *= tt; const g = GR[PERM[ii + i1 + PERM[jj + j1]] & 7]; n += tt * tt * (g[0] * x1 + g[1] * y1); }
  tt = 0.5 - x2 * x2 - y2 * y2; if (tt > 0) { tt *= tt; const g = GR[PERM[ii + 1 + PERM[jj + 1]] & 7]; n += tt * tt * (g[0] * x2 + g[1] * y2); }
  return 70 * n;
}
function fbm(x, y, o = 4) { let a = 0.5, f = 1, s = 0, n = 0; for (let i = 0; i < o; i++) { s += a * snoise(x * f, y * f); n += a; a *= 0.5; f *= 2.03; } return s / n; }
function vn3(x, y, z) { // smooth 3D value noise [0,1]
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z); let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const a = hash3(ix, iy, iz), b = hash3(ix + 1, iy, iz), c = hash3(ix, iy + 1, iz), d = hash3(ix + 1, iy + 1, iz);
  const e = hash3(ix, iy, iz + 1), f = hash3(ix + 1, iy, iz + 1), g = hash3(ix, iy + 1, iz + 1), h = hash3(ix + 1, iy + 1, iz + 1);
  return lerp(lerp(lerp(a, b, fx), lerp(c, d, fx), fy), lerp(lerp(e, f, fx), lerp(g, h, fx), fy), fz);
}
const $ = id => document.getElementById(id);

