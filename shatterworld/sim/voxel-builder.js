// ---------------------------------------------------------------------------------------------------------------------
// voxel builder: palette-indexed occupancy grid -> visible cubes with baked per-vertex AO; doubles as collision grid
// ---------------------------------------------------------------------------------------------------------------------
const GX = 128, GY = 128, GZ = 128, GOX = 64, GOY = 64, GOZ = 64; // grid extents (cells) and the origin offset inside the grid
class VB {
  constructor(ox, oy, oz) { this.ox = ox; this.oy = oy; this.oz = oz; this.g = new Uint8Array(GX * GY * GZ); this.pal = [null]; this.palFx = [0]; this.n = 0; this.breaks = []; }
  addPal(r, g, b, glow = 0) { this.pal.push([s2l(r), s2l(g), s2l(b)]); this.palFx.push(glow); return this.pal.length - 1; }
  idx(x, y, z) { return ((y + GOY) * GZ + (z + GOZ)) * GX + (x + GOX); }
  inb(x, y, z) { return x >= -GOX && x < GX - GOX && y >= -GOY && y < GY - GOY && z >= -GOZ && z < GZ - GOZ; }
  get(x, y, z) { return this.inb(x, y, z) ? this.g[this.idx(x, y, z)] : 0; }
  set(x, y, z, p) { if (this.inb(x, y, z)) this.g[this.idx(x, y, z)] = p; }
  ell(cx, cy, cz, rx, ry, rz, p, fn) { for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++) { const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry, dz = (z + 0.5 - cz) / rz; if (dx * dx + dy * dy + dz * dz <= 1) this.set(x, y, z, fn ? fn(x, y, z) : p); } }
  box(x0, y0, z0, x1, y1, z1, p, fn) { for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) this.set(x, y, z, fn ? fn(x, y, z) : p); }
  cyl(cx, cz, y0, y1, r, p, fn) { for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) { const dx = x + 0.5 - cx, dz = z + 0.5 - cz; if (dx * dx + dz * dz <= r * r) for (let y = y0; y < y1; y++) this.set(x, y, z, fn ? fn(x, y, z) : p); } }
  // visible-surface extraction with ambient occlusion. Returns {n, x,y,z (cell coords), pal, aoA, aoB}
  surface(filter) {
    const out = { x: [], y: [], z: [], p: [], a: [], b: [] }, g = this.g;
    for (let y = -GOY; y < GY - GOY; y++) for (let z = -GOZ; z < GZ - GOZ; z++) for (let x = -GOX; x < GX - GOX; x++) {
      const p = g[this.idx(x, y, z)]; if (!p) continue;
      if (this.get(x + 1, y, z) && this.get(x - 1, y, z) && this.get(x, y + 1, z) && this.get(x, y - 1, z) && this.get(x, y, z + 1) && this.get(x, y, z - 1)) continue;
      if (filter && !filter(x, y, z)) continue;
      let A = 0, B = 0; const c = [x, y, z];
      for (let k = 0; k < 24; k++) {
        const t = AOT[k], f = (k / 4) | 0, cor = k - f * 4, base = [c[0] + t.n[0], c[1] + t.n[1], c[2] + t.n[2]];
        if (this.get(base[0], base[1], base[2])) continue; // hidden face
        const s1 = [base[0], base[1], base[2]], s2 = [base[0], base[1], base[2]], co = [base[0], base[1], base[2]]; s1[t.ta] += t.sa; s2[t.tb] += t.sb; co[t.ta] += t.sa; co[t.tb] += t.sb;
        const a = this.get(s1[0], s1[1], s1[2]) ? 1 : 0, b = this.get(s2[0], s2[1], s2[2]) ? 1 : 0, d = this.get(co[0], co[1], co[2]) ? 1 : 0; const lv = (a && b) ? 3 : a + b + d;
        if (f < 3) A |= lv << (f * 8 + cor * 2); else B |= lv << ((f - 3) * 8 + cor * 2);
      }
      out.x.push(x); out.y.push(y); out.z.push(z); out.p.push(p); out.a.push(A); out.b.push(B);
    }
    out.n = out.x.length; return out;
  }
}
function installGrid(vb) { // make the builder's occupancy the active collision grid
  VG.on = true; VG.ox = vb.ox - GOX; VG.oy = vb.oy - GOY; VG.oz = vb.oz - GOZ; VG.nx = GX; VG.ny = GY; VG.nz = GZ; VG.data = vb.g;
}

