// ============================================================================
// box collider registry (spatial hash) + instanced wind-swayed grass and flowers that morph with the voxel field
// ============================================================================
const BOXES = []; const BGRID = new Map(); const BCS = 8;
const bkey = (cx, cz) => (cx + 512) * 1024 + (cz + 512);
function addBoxCol(x0, y0, z0, x1, y1, z1, tag, ref) {
  const b = { x0, y0, z0, x1, y1, z1, on: true, tag: tag || '', ref: ref || null };
  BOXES.push(b);
  for (let cx = Math.floor(x0 / BCS); cx <= Math.floor(x1 / BCS); cx++) for (let cz = Math.floor(z0 / BCS); cz <= Math.floor(z1 / BCS); cz++) { const k = bkey(cx, cz); let a = BGRID.get(k); if (!a) { a = []; BGRID.set(k, a); } a.push(b); }
  return b;
}
function clearBoxes() { BOXES.length = 0; BGRID.clear(); }
// iterate boxes whose xz footprint touches [x0,x1]x[z0,z1] (callback may see a box twice; callers tolerate that)
function boxesIn(x0, z0, x1, z1, fn) {
  for (let cx = Math.floor(x0 / BCS); cx <= Math.floor(x1 / BCS); cx++) for (let cz = Math.floor(z0 / BCS); cz <= Math.floor(z1 / BCS); cz++) { const a = BGRID.get(bkey(cx, cz)); if (a) for (let i = 0; i < a.length; i++) { const b = a[i]; if (b.on && b.x1 > x0 && b.x0 < x1 && b.z1 > z0 && b.z0 < z1) fn(b); } }
}

