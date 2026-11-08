// ---- the rig: camera dolly follows the hero (replaces the flat chase camera in VR) ---------------------------------------------------
function vrRig(dt, rdt) {
  const sc = VR.S;
  if (VR.snapFollow) { VR.hx = P.x; VR.hy = P.y; VR.hz = P.z; VR.gy = P.y; VR.lpx = P.x; VR.lpy = P.y; VR.lpz = P.z; VR.snapFollow = false; }
  const dx = P.x - VR.lpx, dy = P.y - VR.lpy, dz = P.z - VR.lpz; VR.lpx = P.x; VR.lpy = P.y; VR.lpz = P.z; const bd = VRT.blinkDist + 20 * rdt;
  if (dx * dx + dz * dz > bd * bd || dy > 12 || dy < -12) { VR.hx = P.x; VR.hy = P.y; VR.hz = P.z; VR.gy = P.y; VR.fade = 1; } // respawn / pipe warp: blink, never slide the table across the map
  else if (VR.fade > 0) VR.fade = Math.max(0, VR.fade - rdt / VRT.blinkTime);
  if (P.grounded) VR.gy = P.y; // jumps do not move the table; only changes of ground level do
  if (P.y > VR.gy + VRT.slackUp) VR.gy = P.y - VRT.slackUp; else if (P.y < VR.gy - VRT.slackDown) VR.gy = P.y + VRT.slackDown;
  const kx = 1 - Math.exp(-VRT.followXZ * rdt), ky = 1 - Math.exp(-VRT.followY * rdt);
  VR.hx += (P.x - VR.hx) * kx; VR.hz += (P.z - VR.hz) * kx; VR.hy += (VR.gy - VR.hy) * ky;
  const c = Math.cos(VR.yaw), s = Math.sin(VR.yaw);
  rig.rotation.y = VR.yaw; rig.scale.set(sc, sc, sc);
  const bx = VR.hx - sc * (c * VR.ax + s * VR.az), by = VR.hy - sc * VR.ay, bz = VR.hz - sc * (-s * VR.ax + c * VR.az);
  { // hills beside the table must never reach the eyes: float the rig up (damped, up fast / down slow) when the ground under the head gets closer than VRT.clear metres
    const ex = bx + sc * (c * VR.hpx + s * VR.hpz), ey = by + sc * VR.hpy, ez = bz + sc * (-s * VR.hpx + c * VR.hpz), r = 0.28 * sc; let need = 0;
    for (let i = 0; i < 5; i++) { const px = ex + (i === 0 ? 0 : (i & 1 ? r : -r)), pz = ez + (i < 3 ? 0 : (i === 3 ? r : -r)), g = WC.hf ? hfGround(px, pz) : floorAt(px, pz, ey + 1.5); if (g > -1e8) need = Math.max(need, g + VRT.clear * sc - ey); }
    VR.lift += (need - VR.lift) * (1 - Math.exp(-(need > VR.lift ? 4 : 1.2) * rdt));
  }
  rig.position.set(bx, by + VR.lift, bz); // the anchor (a point on the real table) stays glued to the damped hero
  CP.set(rig.position.x + sc * (c * VR.hpx + s * VR.hpz), rig.position.y + sc * VR.hpy, rig.position.z + sc * (-s * VR.hpx + c * VR.hpz));
  scene.fog.density = VRT.fog * (ATM.fogD / 0.0038); // fog is measured in REAL metres here: it hazes the table out at ~3-5 m (act 3's thicker mist scales along)
  ptMat.uniforms.uWS.value = sc; moteMat.uniforms.uWS.value = sc;
  const cs = renderer.xr.getCamera().cameras; if (cs.length) { const v = cs[0].viewport, e5 = cs[0].projectionMatrix.elements[5]; VR.pix = 0.507 * (v.w * e5 * 0.5) / 380; ptMat.uniforms.uPix.value = VR.pix; moteMat.uniforms.uPix.value = VR.pix; }
  VR.beamK = VRT.beamLen / 90;
  // arrow to the nearest shard when it is out of sight
  const ns = G.nextShard; if (ns && G.state === 'play' && G.nsd > 24) { const ax = ns.x - P.x, az = ns.z - P.z, l = Math.hypot(ax, az) + 1e-4; vrArrow.visible = true; vrArrow.position.set(P.x + ax / l * 2.7, P.y + 0.35, P.z + az / l * 2.7); vrArrow.rotation.y = Math.atan2(ax, az); const pu = 1 + 0.12 * Math.sin(U.time.value * 6); vrArrow.scale.set(pu, pu, pu); } else vrArrow.visible = false;
}
// last-moment work before renderer.render(): panel placement that depends on this frame's poses, animations, blink
function vrRenderPrep() {
  vrBlink.visible = VR.fade > 0.003; vrBlink.material.opacity = VR.fade;
  // controllers: trigger / stick / buttons animate
  for (let i = 0; i < 2; i++) {
    const c = vrCtrl[i], u = c.userData; if (!u.hasSrc || (u.hand !== 'left' && u.hand !== 'right')) continue; const h = u.hand === 'left' ? 0 : 1, X = XI[h]; const md = u.model.userData;
    md.trig.rotation.x = -X.trig * 0.45; md.stick.position.x = X.ax * 0.008; md.stick.position.z = 0.04 + X.ay * 0.008; md.btnA.material.color.setHex(X.b4 ? 0xffd66b : 0x444b5c); md.btnB.material.color.setHex(X.b5 ? 0xffd66b : 0x444b5c);
  }
  if (UI.wrP) {
    if (vrWristSig()) vrDrawWrist();
    const m = UI.wrP.mesh; let a = 0.0;
    if (!UI.wristFloat && m.parent && m.parent !== rig) { // facing test in rig space: panel normal vs direction to the head
      const c = m.parent; _va.set(0, 0.06, 0.07).applyQuaternion(c.quaternion).add(c.position); _vb.set(0, Math.cos(0.5), Math.sin(0.5)).applyQuaternion(c.quaternion);
      _vc.set(VR.hpx - _va.x, VR.hpy - _va.y, VR.hpz - _va.z).normalize(); const d = _vb.x * _vc.x + _vb.y * _vc.y + _vb.z * _vc.z; a = sstep(0.15, 0.55, d);
    } else if (UI.wristFloat) { // no left controller: a small floating readout low in front of the viewer
      m.position.set(VR.hpx + VR.gx * 0.75, Math.max(0.5, VR.hpy - 0.42), VR.hpz + VR.gz * 0.75); m.rotation.set(0, Math.atan2(VR.hpx - m.position.x, VR.hpz - m.position.z), 0); a = 1;
    }
    UI.wrP.mat.opacity += (a - UI.wrP.mat.opacity) * 0.35; m.visible = UI.wrP.mat.opacity > 0.02 && !(UI.mode !== 'none' && false); gvBarPrep();
  }
  if (UI.capP) { // caption panel: lags behind the gaze direction (does not rigidly follow the head), upright, below the eye line
    const k = UI.cap, want = (k.talkOn || k.promptOn || k.toastOn) && UI.mode === 'none' ? 1 : 0; const ga = Math.atan2(VR.gx, VR.gz), err = angDiff(VR.capAng, ga);
    VR.capAng += err * 0.1 * sstep(0.2, 0.7, Math.abs(err));
    const p = UI.capP, x = VR.hpx + Math.sin(VR.capAng) * 1.05, z = VR.hpz + Math.cos(VR.capAng) * 1.05; vrPlacePanel(p, x, Math.max(0.4, VR.hpy - 0.4), z, VR.hpx, VR.hpz);
    p.mat.opacity += (want - p.mat.opacity) * 0.25; p.mesh.visible = p.mat.opacity > 0.02;
  }
  vrRpgRenderPrep();
}
function vrDbg() {
  const inp = [];
  for (let h = 0; h < 2; h++) { const X = XI[h]; inp.push({ hand: h ? 'right' : 'left', has: X.has, isHand: X.hand, axes: [+X.ax.toFixed(2), +X.ay.toFixed(2)], trig: +X.trig.toFixed(2), grip: +X.grip.toFixed(2), a: X.b4, b: X.b5, stick: X.stick }); }
  const r = renderer.info.render;
  return { supported: VR.supported, presenting: VR.presenting, mode: VR.mode, snapDeg: vrCfg.snap ? VRT.snapDeg : 0, scale: VR.S, size: vrCfg.size, rigYawDeg: +(VR.yaw * 180 / PI).toFixed(3), rigPos: [rig.position.x, rig.position.y, rig.position.z], frames: VR.frames, turns: VR.turns, haptics: VR.haptics, ui: UI.mode, tier: Q.vr ? qName : null, features: VR.sessionFeatures, fade: VR.fade, avgMs: +VR.avgMs.toFixed(1), draw: { calls: r.calls, triangles: r.triangles }, inputs: inp, rpg: { rp: !!UI.rp && UI.rp.mesh.visible, hud: !!UI.hudP && UI.hudP.mesh.visible, hot: RV.hotId.slice(), btns: RV.btns.length, plates: RV.nPlates, beams: RV.nBeams, haps: RV.hapSeq, hapPlayed: RV.hapPlayed, yHold: +RV.yHold.toFixed(2), banner: RV.ban.on && performance.now() < RV.ban.until, bannerSeq: RV.ban.seq, bannerText: RV.ban.h }, gem: gvDbg() };
}

