// ==============================================================================================================================================================================================
// STAR POWER: a meter (Sun Shards, kills, combos) -> the collect-animation moment (slow-mo, light ring, beam, music sting) -> ~10 s of invulnerability with a rainbow trail, the ground under you shatters to
// blocks and REBUILDS behind you, enemies bounce off in coin bursts, speed + jump boost. Each class has a variant (data: class.star.fx). Gear affixes / perks: duration, trail damage, starfall, gain.
// ==============================================================================================================================================================================================
const STAR = { meter: 0, on: false, run: false, wind: 0, t: 0, dur: 10, fx: {}, def: null, gT: 0, trT: 0, hue: 0, chain: 0, chainT: 0, fallT: 0, quakeT: 0, bloomT: 0, tickT: 0, tickN: 0, ghostT: 0, healT: 0, owns: false, tinted: false, vis: 1, visT: 1, rib: null, beam: null, R: null, lastSafe: { x: 0, y: 0, z: 0, ok: false }, trail: new Float32Array(8 * 3), trailN: 0, orbA: 0, hits: 0 };
STAR.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 1.0, 70, 20, 1, true), beamMat.clone()); STAR.beam.material.uniforms.uCol = { value: new THREE.Color(1.0, 0.8, 0.35) }; STAR.beam.material.forceSinglePass = true; STAR.beam.position.y = 35; STAR.beam.visible = false; STAR.beam.frustumCulled = false; STAR.beam.renderOrder = 21; scene.add(STAR.beam);
STAR.rib = [0, 1].map(() => new GRibbon(30, ribbonMat(1, 1, 1, 1), 21)); GM.ribDash = new GRibbon(18, ribbonMat(0, 1.2, 3, 2.6), 21);
const STAR_TINT = { rainbow: [3, 2.2, 0.8], mint: [0.8, 2.6, 1.8], gold: [3, 2.2, 0.6], violet: [1.9, 1.2, 3.4], pink: [3, 1.2, 2], ember: [3.2, 1.3, 0.35] };
function starRef() { const S = RT.S, R = STAR.R || (STAR.R = { id: 'star', elem: 'sun', tags: ['sun'], sups: [], p: { rad: 2.2 }, area: 1, kbMul: 1, burn: 0, slow: 0, leech: 0, pull: 0, crit: 0.1, slotI: null, hit: 10 }); R.hit = S.baseDmg * GEM_TUNING.star.touch * S.dmgMul; R.crit = 0.05; return R; }
function starGain(amount, why) { if (STAR.on || amount <= 0 || G.state !== 'play') return; const was = STAR.meter; STAR.meter = Math.min(GEM_TUNING.star.max, STAR.meter + amount); if (was < GEM_TUNING.star.max && STAR.meter >= GEM_TUNING.star.max) { gsfx('gform'); toast(VR.presenting ? 'STAR POWER READY: squeeze both grips' : 'STAR POWER READY  ·  ' + padTxt('LB + RB') + '  /  G', 3200); rpgLogLine('Star Power ready!', '#ffe27a'); } }
function starTry(force) {
  if (STAR.on || G.state !== 'play' || P.dead || G.trans || G.finale) return false; if (!force && STAR.meter < GEM_TUNING.star.max - 0.01) { if (!force) toast('STAR POWER ' + Math.floor(STAR.meter) + '%'); return false; }
  const d = classDef(RP.cls).star, S = RT.S; STAR.def = d; STAR.fx = d.fx || {}; STAR.on = true; STAR.run = false; STAR.wind = 0.95; STAR.dur = gemStarDur(S, d.dur); STAR.t = STAR.dur; STAR.meter = 0; STAR.hue = Math.random(); STAR.chain = 0; STAR.hits = 0; STAR.fallT = 0; STAR.quakeT = 0; STAR.bloomT = 1; STAR.tickT = 0; STAR.tickN = 0; STAR.gT = 0; STAR.trT = 0; STAR.trailN = 0; STAR.visT = STAR.fx.size || 1; STAR.lastSafe.ok = false; starRef(); GM.stats.stars++; RP.totals.stars = (RP.totals.stars | 0) + 1;
  const c = STAR_TINT[d.col] || STAR_TINT.rainbow; for (const r of STAR.rib) { r.reset(); const u = r.mesh.material.uniforms; u.uRain.value = d.col === 'rainbow' ? 1 : 0; u.uCol.value.setRGB(c[0], c[1], c[2]); u.uAlpha.value = 1; }
  // the collect-animation moment: slow-mo, rings of light, a beam, camera push, the music sting
  G.slow = 0.14; G.flash = Math.max(G.flash, 0.55); camShake(0.6); camCine(1.6, 1.8, 0.22, 0.07); gsfx('gstar'); gsfx('gstarup'); P.invuln = Math.max(P.invuln, STAR.dur + 2); P.vx *= 0.3; P.vz *= 0.3; GM.pose.kind = 'gather'; GM.pose.t = GM.pose.dur = 1.0; GM.pose.hand = 1;
  fxRing(P.x, P.y, P.z, 0.4, 9, 1.0, 0xffd45a, 1); fxRing(P.x, P.y, P.z, 0.3, 6.5, 0.8, 0xffffff, 0.45, true); fxRing(P.x, P.y + 1.2, P.z, 0.3, 5, 1.2, 0xff6fb1, 0.9); fxRing(P.x, P.y + 2.4, P.z, 0.2, 4, 1.4, 0x53e0d0, 0.8); sparkBurst(P.x, P.y + 1, P.z, 50, 0xffd060, 11);
  STAR.beam.visible = true; STAR.beam.position.set(P.x, P.y + 35, P.z); starOverlay(true); GM.dirty = true; rpgBanner(d.name.toUpperCase(), 'STAR POWER', true); RT.dirty = true; return true;
}
function starBegin() { // end of the wind-up: the run proper
  STAR.run = true; G.slow = Math.max(G.slow, 0.9); STAR.beam.visible = false; RT.speedK = GEM_TUNING.star.speed * (STAR.fx.speedMul || 1); RT.jumpK = GEM_TUNING.star.jump * (STAR.fx.jumpMul || 1); rpgApplyTuning(true); GM.enemyScale = STAR.fx.timeScale || 1;
  const fx = STAR.fx; if (fx.heal) { rpgHeal(RT.max * fx.heal); fxRing(P.x, P.y, P.z, 0.4, 7, 0.8, 0xff9ccc, 1); } fxRing(P.x, P.y, P.z, 0.5, 11, 0.7, 0xffffff, 0.8); camShake(0.4); GM.dirty = true;
}
function starEnd(quiet) {
  if (!STAR.on) return; STAR.on = false; STAR.run = false; STAR.beam.visible = false; RT.speedK = 1; RT.jumpK = 1; rpgApplyTuning(true); GM.enemyScale = 1; STAR.visT = 1; P.invuln = Math.max(P.invuln, quiet ? 0 : GEM_TUNING.star.grace); GM.dirty = true;
  if (STAR.owns && !SH.on) { WV.R1 = -1; WV.R2 = -1; WV.glow = 0; syncWave(); } STAR.owns = false; starOverlay(false);
  if (!quiet) { gsfx('gstarend'); toast('STAR POWER FADES'); fxRing(P.x, P.y, P.z, 0.4, 7, 0.6, 0xffd45a, 0.9); sparkBurst(P.x, P.y + 1, P.z, 24, 0xffd060, 8); }
  for (const r of STAR.rib) r.life = 0.6;
}
let starFxEl = null; function starOverlay(on) { if (!starFxEl) starFxEl = $('starFx'); if (starFxEl) { starFxEl.className = on ? 'on ' + (STAR.def ? STAR.def.col : 'rainbow') : ''; } }
function gemQuake(r, mul, kb, elem, chunks) { // an AoE ring at the hero's feet (Titan steps, twin landings, the Pip triple-jump quake)
  const S = RT.S, v = rpgHitDamage(S, 'pound') * mul; fxRing(P.x, P.y, P.z, 0.5, r, 0.45, VCOL[elem] || 0xffd45a, 0.95); fxRing(P.x, P.y, P.z, 0.3, r * 0.65, 0.3, 0xffffff, 0.6, true); if (chunks) fxChunks(P.x, P.y + 0.3, P.z, chunks, 0x9a8a6a, 0.22, 6, P.y); camShake(0.3); gsfx('gslam');
  for (const o of ENEMIES) { if (!gemOk(o) || Math.hypot(o.x - P.x, o.z - P.z) > r || Math.abs(o.y - P.y) > 3) continue; rpgDamageEnemy(o, v, 'ring', { x: P.x, z: P.z }); if (gemOk(o) && o.rpg && !o.rpg.aff.includes('juggernaut')) { const dx = o.x - P.x, dz = o.z - P.z, l = Math.hypot(dx, dz) + 0.01; o.kbx = dx / l * kb; o.kbz = dz / l * kb; } }
}
function starGroundTick(dt) { // the world core idea, made a power: shatter the ground under the hero to blocks and let it rebuild behind
  STAR.gT -= dt; const R = STAR.fx.trailR || 2.4;
  if (!VG.on && WC.hf && !SH.on && act1Visible) { STAR.owns = true; WV.x = P.x; WV.z = P.z; WV.R1 = R * 1.35 + 2.0; WV.R2 = -1; WV.band = 3.4; WV.glow = 0.3; syncWave(); }
  if (STAR.gT > 0) return; STAR.gT = 0.055;
  if (VG.on) { let n = 0; for (let i = 0; i < cubeHi && n < 12; i++) { if (C.st[i] !== ST.SET) continue; const dx = C.x[i] - P.x, dz = C.z[i] - P.z; if (dx * dx + dz * dz > R * R || C.y[i] > P.y + 0.6 || C.y[i] < P.y - 2.6 || Math.random() > 0.45) continue;
      C.st[i] = ST.BALL; C.vy[i] = 3 + Math.random() * 5; C.vx[i] = (Math.random() - 0.5) * 3; C.vz[i] = (Math.random() - 0.5) * 3; C.wx[i] = (Math.random() - 0.5) * 8; C.wy[i] = (Math.random() - 0.5) * 8; C.wz[i] = (Math.random() - 0.5) * 8; C.delay[i] = 0.45 + Math.random() * 0.4; C.glow[i] = 0.9; C.owner[i] = -1; C.vox[i] = 1; n++; } }
  else if (WC.hf && act1Visible) for (let k = 0; k < 2; k++) { const a = Math.random() * TAU, rr = Math.random() * R, x = P.x + Math.cos(a) * rr, z = P.z + Math.sin(a) * rr, ci = Math.floor(z + HALF) * GRID + Math.floor(x + HALF); if (ci < 0 || ci >= GRID * GRID || Math.abs(HQ[ci] - P.y) > 2.5) continue;
    const q = colCube(ci, P.x, P.z, 5); if (q >= 0) { C.rew[q] = 1; C.tx[q] = C.hx[q]; C.ty[q] = C.hy[q]; C.tz[q] = C.hz[q]; C.delay[q] = 0.4 + Math.random() * 0.4; C.glow[q] = 0.9; } }
}
function starTick(rdt, sdt) {
  if (!STAR.on) { for (const r of STAR.rib) if (r.life > 0) { r.life -= rdt; r.build(0.5, CP.x, CP.y, CP.z); if (r.life <= 0) r.reset(); } return; }
  const fx = STAR.fx; if (!STAR.run) { // wind-up (real time)
    STAR.wind -= rdt; G.slow = Math.min(G.slow, 0.18) + (1 - Math.min(1, STAR.wind / 0.95)) * 0.0; STAR.beam.position.set(P.x, P.y + 35, P.z); STAR.beam.material.uniforms.uTime = U.time; STAR.beam.scale.set(1 + (1 - STAR.wind) * 0.4, 1, 1 + (1 - STAR.wind) * 0.4); ptSuck(P.x, P.y + 1.1, P.z, 2, 3.4, 0.5, 1.0, 'sun'); P.invuln = Math.max(P.invuln, 1);
    if (STAR.wind <= 0) starBegin(); return;
  }
  STAR.t -= sdt; P.invuln = Math.max(P.invuln, 0.35); STAR.hue = (STAR.hue + rdt * 0.9) % 1; if (P.grounded) { STAR.lastSafe.x = P.x; STAR.lastSafe.y = P.y; STAR.lastSafe.z = P.z; STAR.lastSafe.ok = true; }
  const killY = LV ? LV.deathY + LV.O.y : -28; if (STAR.lastSafe.ok && P.y < killY + 5 && GF > 0) { setHeroPos(STAR.lastSafe.x, STAR.lastSafe.y + 0.2, STAR.lastSafe.z); G.flash = 0.3; fxRing(P.x, P.y, P.z, 0.3, 4, 0.5, 0xffd45a, 1); } // the star never lets you fall out of the world
  // trail ribbons (rainbow) + feet sparkle
  const sy = Math.sin(P.yaw), cy = Math.cos(P.yaw), px = P.x - sy * 0.15, pz = P.z - cy * 0.15, w = 1.15 * (fx.size ? 1.5 : 1); STAR.rib[0].push(px + cy * 0.35, P.y + 0.45, pz - sy * 0.35); STAR.rib[1].push(px - cy * 0.35, P.y + 0.45, pz + sy * 0.35); for (const r of STAR.rib) r.build(w, CP.x, CP.y, CP.z);
  STAR.trT -= sdt; if (STAR.trT <= 0) { STAR.trT = 0.03; _hc.setHSL(STAR.hue, 0.9, 0.62); const rg = STAR.def.col === 'rainbow'; const c = rg ? _hc.multiplyScalar(2.2) : vcol(STAR.def.col === 'violet' ? 'time' : STAR.def.col === 'mint' ? 'gust' : STAR.def.col === 'ember' ? 'ember' : 'sun', 1); pt(P.x + (Math.random() - 0.5) * 0.8, P.y + 0.15 + Math.random() * 0.5, P.z + (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 1.2, 0.8 + Math.random(), (Math.random() - 0.5) * 1.2, 0.6, 0.9, -0.5, c); if (fx.bloom) { _hc.setHSL(0.92 + Math.random() * 0.1, 0.8, 0.75); pt(P.x + (Math.random() - 0.5) * 1.5, P.y + 0.1, P.z + (Math.random() - 0.5) * 1.5, (Math.random() - 0.5), 1.2, (Math.random() - 0.5), 0.9, 1.1, -1, _hc.multiplyScalar(1.4)); } }
  starGroundTick(sdt);
  // arpeggio shimmer
  STAR.tickT -= sdt; if (STAR.tickT <= 0) { STAR.tickT = 0.22; STAR.tickN++; gsfx('gstartick', [0, 4, 7, 12, 7, 4][STAR.tickN % 6]); }
  // enemies bounce off in coin bursts; trail damage
  STAR.chainT -= sdt; if (STAR.chainT <= 0) STAR.chain = 0; STAR.trailN = 0; const touchR = 1.5 * (fx.size ? 1.7 : 1) + 0.6, S = RT.S, R = starRef(), kb = GEM_TUNING.star.kb * (fx.kbMul || 1);
  for (const e of ENEMIES) { if (!gemOk(e)) continue; const dx = e.x - P.x, dz = e.z - P.z, d = Math.hypot(dx, dz); if (e.gStarT > 0) e.gStarT -= sdt; if (d < touchR && Math.abs(e.y - P.y) < 2.6 && !(e.gStarT > 0)) {
      e.gStarT = 0.5; STAR.chain++; STAR.chainT = 1.4; STAR.hits++; if (!e.rpg) rpgDecorate(e, {}); rpgDamageEnemy(e, R.hit, 'star', { x: P.x, z: P.z }); if (gemOk(e) && e.rpg && !e.rpg.aff.includes('juggernaut')) { const l = d + 0.01, m = e.rpg.tier === 'guardian' ? 0.35 : 1; e.kbx = dx / l * kb * m; e.kbz = dz / l * kb * m; e.vy = Math.max(e.vy || 0, 4); }
      for (let q = 0; q < GEM_TUNING.star.coins; q++) COINS.push({ x: e.x, y: e.y + 0.8, z: e.z, alive: true, ph: 0, vy: 8 + Math.random() * 5, pop: true, life: 0.6 + Math.random() * 0.2 }); const g = Math.max(1, Math.round(rpgCoinValue() * 1.5)); RP.gold += g; RUN.gold += g; RT.dirty = true; floatText(e.x, e.y + 1.6, e.z, '+' + g, 'gold');
      gsfx('gstarhit', Math.min(10, STAR.chain)); camShake(0.15); heroHitstop(0.03); sparkBurst(e.x, e.y + 0.8, e.z, 12, 0xffd040, 7); }
  }
  STAR.fallT -= sdt; const sf = S.starfall || 0; if (sf > 0) { STAR.fallT -= 0; } // starfall: a rain of mini stars around the hero
  if (sf > 0 && STAR.fallT <= 0) { STAR.fallT = 1 / sf; const a = Math.random() * TAU, rr = 2 + Math.random() * 9, x = P.x + Math.cos(a) * rr + P.vx * 0.3, z = P.z + Math.sin(a) * rr + P.vz * 0.3, f = floorAt(x, z, P.y + 8); if (f > -1e8) { const mr = starRef(); mr.p.rad = 2.2; pjSpawn(5, mr, x, f + 14, z, 0, -4, 0, 0.8, { sc: 0.34, gy: f, life: 2, elem: 'sun', rad: 2.2, mini: true }); } }
  STAR.quakeT -= sdt; if (fx.quake && P.grounded && P.speed > 3 && STAR.quakeT <= 0) { STAR.quakeT = 0.42; gemQuake(4.2, 0.5, 10, 'sun', 6); }
  if (fx.bloom) { STAR.bloomT -= sdt; if (STAR.bloomT <= 0) { STAR.bloomT = 2.5; fxRing(P.x, P.y, P.z, 0.4, 7, 0.7, 0xff9ccc, 0.95); fxRing(P.x, P.y, P.z, 0.2, 4.5, 0.5, 0xffffff, 0.7, true); for (let k = 0; k < 22; k++) { _hc.setHSL(0.9 + Math.random() * 0.12, 0.8, 0.7); const a = Math.random() * TAU, sp = 3 + Math.random() * 6; pt(P.x, P.y + 1, P.z, Math.cos(a) * sp, 2 + Math.random() * 3, Math.sin(a) * sp, 1.0, 1.2, -4, _hc.multiplyScalar(1.5)); } gsfx('gbloom'); gemQuake(6.5, 0.35, 6, 'ember', 0); } RT.hp = Math.min(RT.max, RT.hp + RT.max * 0.05 * sdt); }
  if (fx.orbit) { STAR.orbA += rdt * 5; STAR.hits += 0; for (let k = 0; k < 4; k++) { const a = STAR.orbA + k * PI / 2, ox = P.x + Math.cos(a) * 2.3, oz = P.z + Math.sin(a) * 2.3, oy = P.y + 1 + Math.sin(a * 2) * 0.3; pt(ox, oy, oz, 0, 0.2, 0, 0.12, 1.5, 0, vcol('ember', 1.4)); pt(ox, oy, oz, (Math.random() - 0.5), 0.5, (Math.random() - 0.5), 0.35, 0.8, 0, vcol('ember', 0.9));
      for (const e of ENEMIES) { if (!gemOk(e) || e.gOrbT > 0) continue; const dx = e.x - ox, dz = e.z - oz; if (dx * dx + dz * dz < 1.2 && Math.abs(e.y - P.y) < 3) { e.gOrbT = 0.4; rpgDamageEnemy(e, rpgHitDamage(S, 'punch') * 1.2, 'nova', { x: P.x, z: P.z }); } } } for (const e of ENEMIES) if (e.gOrbT > 0) e.gOrbT -= sdt; }
  if (fx.ghosts) { STAR.ghostT -= sdt; if (STAR.ghostT <= 0) { STAR.ghostT = 0.07; for (let q = 0; q < 3; q++) pt(P.x + (Math.random() - 0.5) * 0.5, P.y + 0.4 + Math.random() * 1.2, P.z + (Math.random() - 0.5) * 0.5, 0, 0, 0, 0.5, 1.6, 0, vcol('time', 0.8)); } }
  // trail damage: segments of the recent path hurt enemies that stand in them
  STAR.trT = STAR.trT; if (!STAR.dmgT || STAR.dmgT <= 0) { STAR.dmgT = 0.22; const v = rpgHitDamage(S, 'punch') * GEM_TUNING.star.trail * (1 + S.starTrail); const tr = fx.trailR || 2.4; for (const e of ENEMIES) { if (!gemOk(e)) continue; const dx = e.x - STAR.rib[0].pts[3 * 6], dz = e.z - STAR.rib[0].pts[3 * 6 + 2]; if (STAR.rib[0].len > 7 && dx * dx + dz * dz < tr * tr * 0.5 && Math.abs(e.y - P.y) < 2.5 && !(e.gStarT > 0)) { rpgDamageEnemy(e, v, 'nova', { x: P.x, z: P.z }); e.gStarT = 0.3; } } } else STAR.dmgT -= sdt;
  if (STAR.t <= 0) starEnd(false);
}
function gemHeroTint() { // hero glow while Star Power / a form is on (flat: material emissive; in VR the merged mesh is untouched and the trail + rings carry the effect)
  const m = hero.mats; if (!m) return; const on = STAR.on, tint = on || FORM.id; STAR.vis += (STAR.visT - STAR.vis) * Math.min(1, 6 * (1 / 60)); if (Math.abs(STAR.vis - 1) > 0.002) hero.root.scale.setScalar(hero.S * P.size * STAR.vis);
  if (tint) { STAR.tinted = true; let r, g, b; if (on) { if (STAR.def.col === 'rainbow') { _hc.setHSL(STAR.hue, 0.85, 0.55); r = _hc.r; g = _hc.g; b = _hc.b; } else { const c = STAR_TINT[STAR.def.col] || STAR_TINT.gold; r = c[0] * 0.5; g = c[1] * 0.5; b = c[2] * 0.5; } } else { const c = FORM.id === 'cinder' ? STAR_TINT.ember : STAR_TINT.mint; r = c[0] * 0.35; g = c[1] * 0.35; b = c[2] * 0.35; }
    for (const k in m) { const mt = m[k]; if (mt && mt.emissive) { mt.emissive.setRGB(r, g, b); mt.emissiveIntensity = on ? 0.5 : 0.35; } } }
  else if (STAR.tinted) { STAR.tinted = false; for (const k in m) { const mt = m[k]; if (mt && mt.emissive && mt.color) mt.emissive.copy(mt.color); } }
}

