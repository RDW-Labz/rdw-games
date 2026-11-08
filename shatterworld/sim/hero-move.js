// ---- movement with axis-separated collision, step-up, wall contact, ground snap ----
function moveHero(dt) {
  const T = TUNING, h = heroH(); let moved = false;
  P.wallHit = false;
  let gy = P.gy; P.prevVy = P.vy;
  const prevGrounded = P.grounded;
  // --- horizontal, axis by axis ---
  for (let ax = 0; ax < 2; ax++) {
    const d = (ax === 0 ? P.vx : P.vz) * dt; if (d === 0) continue;
    const nx = ax === 0 ? P.x + d : P.x, nz = ax === 0 ? P.z : P.z + d;
    if (!scan(nx, gy, nz, h)) { P.x = nx; P.z = nz; continue; }
    const rise = S.top - gy, dist = Math.abs(d);
    const okHF = S.topHF < -1e8 || S.topHF - gy <= T.slopeMax * dist + 0.03;
    const lim = S.topO > -1e8 && P.grounded ? T.stepUpBlock : T.stepUp; // whole-block steps are climbed automatically while running on the ground
    if (rise <= lim && okHF && (P.grounded || P.vy <= 0.5)) {
      const ny = S.top + 0.0005; if (!scan(nx, ny, nz, h)) { P.stepOff += ny - gy; P.x = nx; P.z = nz; gy = ny; P.step++; continue; }
    }
    // wall
    if (ax === 0) { P.wnx = Math.sign(-d) || 1; P.wnz = 0; } else { P.wnx = 0; P.wnz = Math.sign(-d) || 1; }
    const hv2 = Math.hypot(P.vx, P.vz);
    P.wallHit = true; if (ax === 0) P.vx = 0; else P.vz = 0;
    if (!P.grounded && P.vy < 3 && (P.act !== 'pound')) { P.wallT = T.wallKick.window; if (hv2 > 3 && (P.act === 'dive' || P.act === 'long')) { /* bonk */ P.vx = P.wnx * 4; P.vz = P.wnz * 4; P.vy = Math.max(P.vy, 3); setAct('air'); P.airKind = 'jump'; sfx('bonk'); heroKick(hero, -6); } }
  }
  // --- vertical ---
  let dy = P.vy * dt; let landed = false;
  if (dy !== 0) {
    const ny = gy + dy;
    if (scan(P.x, ny, P.z, h)) {
      if (dy < 0) { gy = S.top + 0.0005; if (S.topHF > -1e8 && S.top === S.topHF) gy = S.top; landed = true; P.vy = 0; }
      else { // ceiling bump
        const bx = S.box; gy = Math.min(ny, S.bot - h - 0.001); if (bx) onHeadBump(bx); else if (S.bot < 1e8) { /* voxel cell */ onHeadBumpCell(); } P.vy = Math.min(0, P.vy * 0.2 - 0.5);
        if (P.act === 'flip' || P.act === 'air') { sfx('bump'); }
      }
    } else gy = ny;
  } else if (scan(P.x, gy - 0.002, P.z, h)) landed = true;
  // ground snap when walking down slopes / stairs
  if (!landed && prevGrounded && P.vy <= 0 && P.act === 'ground') {
    const sd = 0.34; if (scan(P.x, gy - sd, P.z, h) && S.top <= gy + 0.01 && S.top >= gy - sd - 0.001) { gy = S.top + 0.0005; landed = true; P.vy = 0; }
  }
  if (WC.hf && !VG.on) { P.x = clamp(P.x, -61.5, 61.5); P.z = clamp(P.z, -61.5, 61.5); } // invisible rim of the valley
  P.gy = gy; P.y = GF > 0 ? gy : -gy;
  const wasAir = !P.grounded; P.grounded = landed;
  if (landed && wasAir) onHeroLand();
  // stand on moving platforms
  if (P.onPlat) { /* handled by act layer */ }
}
function onHeroLand() {
  const T = TUNING; const imp = clamp(-P.prevVy / 20, 0, 1.4);
  heroKick(hero, -(7 + 14 * imp)); P.landT = 0; sfx(P.act === 'pound' ? 'pound' : 'land', imp);
  if (P.act === 'pound') { setAct('pound_land'); doPound(); P.vx = P.vz = 0; }
  else if (P.act === 'dive') { setAct('slide'); }
  else if (P.act === 'long') { setAct('ground'); }
  else { setAct('ground'); if (P.chainN === 0 || P.vy < -3) { } }
  if (imp > 0.35 && P.act !== 'pound_land') puff(P.x, P.y + 0.1, P.z, 5, 0.8 + imp * 0.4);
  P.airKind = 'jump'; P.wallT = 0;
}

function setHeroPos(x, y, z) { P.x = x; P.z = z; P.y = y; P.gy = GF > 0 ? y : -y; P.vx = P.vy = P.vz = 0; P.grounded = false; }

