// ---- poses (cast poses + the class animation set) ----------------------------------------------------------------------------------------------------------------------------------------
function gemPoseApply(t, h, rdt, k) {
  const A = classDef(RP.cls).anim, v = heroVis, g = P.grounded, sp = P.speed, act = P.act, tm = v.t, stand = g && !P.crouch && (act === 'ground');
  if (stand && sp > 0.5 && A.run !== 1) { h.ph += sp * rdt * 0.95 * (A.run - 1); } if (stand && sp > 0.5 && A.swing !== 1) { t.lx *= A.swing; t.rx *= A.swing; t.la *= A.swing; t.ra *= A.swing; }
  if (stand && sp <= 0.5 && P.hurtT <= 0 && P.victory <= 0) { // idle personality
    if (A.idle === 'sway') { t.side = Math.sin(tm * 1.5) * 0.35; t.hy = Math.sin(tm * 0.9) * 0.3; t.la = Math.sin(tm * 1.5) * 0.12; t.ra = -Math.sin(tm * 1.5) * 0.12; }
    else if (A.idle === 'staff') { t.ra = -0.55 + Math.sin(tm * 2.1) * 0.08; t.la = 0.2; t.hy = Math.sin(tm * 0.7) * 0.35; t.hx = -0.05; }
    else if (A.idle === 'flex') { const f = Math.max(0, Math.sin(tm * 0.9)); t.la = -1.1 * f; t.ra = -1.1 * f; t.side = 0.9 * f; t.lean = -0.08 * f; t.bob = 0.02 * f; }
    else if (A.idle === 'bounce') { const b = Math.abs(Math.sin(tm * 6)); t.bob = b * 0.06; t.lx = Math.sin(tm * 6) * 0.25; t.rx = -Math.sin(tm * 6) * 0.25; t.la = -t.lx * 0.8; t.ra = -t.rx * 0.8; }
  }
  if (!g && P.victory <= 0 && act !== 'pound' && act !== 'dive' && act !== 'long') { const gl = (RT.S.fx.glide || (FORM.id === 'gust')) && INP.jump && P.vy < -0.5;
    if (gl) { t.side = 1.9; t.la = -0.5; t.ra = -0.5; t.lx = 0.15; t.rx = 0.15; t.lean = 0.25; t.hx = -0.15; k = 12; }
    else if (A.jump === 'float' && P.vy < 2) { t.lx = 0.45; t.rx = -0.2; t.la = -2.2; t.ra = -2.0; t.side = 0.8; t.lean = -0.05; }
    else if (A.jump === 'tuck' && P.vy > -2) { t.lx = -1.5; t.rx = -1.3; t.la = -0.4; t.ra = -0.4; t.lean = 0.45; t.hx = 0.15; } }
  if (P.victory > 0) { if (A.win === 'spin') { h.pose.spin = (tm * 6) % TAU; t.la = -2.8; t.ra = -2.8; } else if (A.win === 'bloom') { t.side = 1.8; t.la = -1.0; t.ra = -1.0; t.hy = Math.sin(tm * 3) * 0.4; } else if (A.win === 'flex') { t.la = -1.6; t.ra = -1.6; t.side = 1.2; t.bob = Math.abs(Math.sin(tm * 4)) * 0.2; } }
  const p = GM.pose; if (p.t > 0) {
    p.t -= rdt; const u = 1 - Math.max(0, p.t) / p.dur, hand = p.hand ? 'ra' : 'la', off = p.hand ? 'la' : 'ra';
    switch (p.kind) {
      case 'throw': t[hand] = -2.5 + Math.sin(u * PI) * -0.3; t[off] = 0.5; t.lean = 0.25; t.hx = -0.1; k = 40; break;
      case 'spin': h.pose.spin = u * TAU * 2.2 * (GM.cast ? 1 : 0); t.la = -1.5; t.ra = -1.5; t.side = 1.2; t.lean = 0.3; k = 40; break;
      case 'slam': t.la = -3.0 * (1 - u) + 0.3 * u; t.ra = -3.0 * (1 - u) + 0.3 * u; t.lean = 0.5 * u; t.bob = -0.18 * Math.sin(u * PI); t.lx = -0.9 * u; t.rx = -0.9 * u; k = 34; break;
      case 'clap': t.la = -1.7; t.ra = -1.7; t.side = -0.6 * (1 - u); t.hx = -0.25; t.lean = 0.3; k = 40; break;
      case 'dash': t.pitch = -1.25; t.la = -3.0; t.ra = -3.0; t.lx = 0.5; t.rx = 0.4; t.hx = 0.4; k = 40; break;
      case 'gather': t.la = -2.8; t.ra = -2.8; t.hx = -0.35; t.lean = -0.1; t.bob = Math.sin(u * 20) * 0.02; k = 24; break;
      case 'cast': t.la = -1.6; t.ra = -1.6; t.lean = 0.25; t.hx = -0.1; k = 34; break;
    }
    if (p.t <= 0) { p.kind = ''; if (h.pose.spin !== 0 && !GM.cast) h.pose.spin = 0; }
  }
  return k;
}

