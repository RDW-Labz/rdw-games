// ---- movement through the real world: floor / step / edge / wall, with the cheap wall probe the charge attacks use ------------------------------------------------------------------------------------------------
function mobMoveEnemy(e, nx, nz) {
  const m = e.mob, d = m.def, fy = floorAt(nx, nz, e.fy + (d.fly ? 3.2 : 0.95)), none = !(fy > -1e8);
  if (m.hidden) { if (none) return false; m.x = nx; m.z = nz; e.fy = fy; return true; }
  if (d.fly) { if (none || fy > e.fy + 2.6) return false; m.x = nx; m.z = nz; e.fy = fy; return true; }
  const edge = none || fy < e.fy - 1.1, wall = fy > e.fy + 0.6;
  if (edge || wall) { // slide along the obstacle if one axis is free, but still report "blocked" (a charger that scrapes a wall is stunned)
    const fx = floorAt(nx, m.z, e.fy + 0.95), fz = floorAt(m.x, nz, e.fy + 0.95); if (fx > -1e8 && fx >= e.fy - 1.1 && fx <= e.fy + 0.6 && Math.abs(nx - m.x) > Math.abs(nz - m.z)) { m.x = nx; e.fy = fx; } else if (fz > -1e8 && fz >= e.fy - 1.1 && fz <= e.fy + 0.6) { m.z = nz; e.fy = fz; } return false; }
  m.x = nx; m.z = nz; e.fy = fy; return true;
}
function mobWallAhead(x, z, ang, len) { const sx = Math.sin(ang), sz = Math.cos(ang); let y = MOBX.curFy; for (let i = 1; i <= len; i++) { const px = x + sx * i, pz = z + sz * i, f = floorAt(px, pz, y + 0.95); if (!(f > -1e8) || f > y + 0.6 || f < y - 1.1) return (i - 1) / len; y = f; } return 1; }
