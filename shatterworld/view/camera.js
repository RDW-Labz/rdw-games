// ============================================================================
// CAMERA (orbit follow-cam, collision, recentre, FOV kick, cinematic framing) + hero pose driver
// ============================================================================
const CAM = { yaw: 0.55, pitch: 0.27, dist: 7.2, cd: 7.2, pos: new THREE.Vector3(), tgt: new THREE.Vector3(), ty: 0, wide: false, idle: 9, fov: 62, shake: 0, roll: 0, recent: 0,
  cine: 0, cineDur: 1, cineDist: 1, cinePitch: 0, cineYaw: 0, look: new THREE.Vector3(), menuT: 0, fixed: null };
function camShake(a) { CAM.shake = Math.max(CAM.shake, a); }
function camCine(dur, distMul, pitchAdd, yawRate) { CAM.cine = dur; CAM.cineDur = dur; CAM.cineDist = distMul; CAM.cinePitch = pitchAdd; CAM.cineYaw = yawRate; }
const _co = new THREE.Vector3();
function updateCamera(dt, rdt) {
  if (VR.presenting) { vrRig(dt, rdt); return; }
  const T = TUNING.cam;
  if (G.state === 'menu') { // title-screen dolly: from the east, looking into the low golden sun, hero + twin on the right third
    CAM.menuT += rdt; const t = CAM.menuT, a = 0.42 + Math.sin(t * 0.09) * 0.32, r = 9.5;
    const hx = P.x, hz = P.z, cx = hx + Math.cos(a) * r, cz = hz + Math.sin(a) * r;
    const gy = hfGround(cx, cz);
    camera.position.set(cx, Math.max(gy + 1.9, P.y + 1.8) + Math.sin(t * 0.21) * 0.2, cz); CAM.look.set(hx - 3.2, P.y + 2.5, hz + 2.2); camera.lookAt(CAM.look);
    camera.fov = damp(camera.fov, 46, 3, rdt); camera.updateProjectionMatrix(); return;
  }
  if (CAM.free) { camera.position.set(...CAM.free.pos); CAM.look.set(...CAM.free.look); camera.up.set(0, 1, 0); camera.lookAt(CAM.look); camera.fov = CAM.free.fov || 55; camera.updateProjectionMatrix(); return; }
  const manual = lookDX !== 0 || lookDY !== 0 || padLookV.x !== 0 || padLookV.y !== 0;
  if (manual) { CAM.yaw -= lookDX * T.sens + padLookV.x * T.padRate * rdt; CAM.pitch += lookDY * T.sens * 0.9 + padLookV.y * T.padRate * 0.7 * rdt; CAM.idle = 0; lookDX = lookDY = 0; }
  CAM.pitch = clamp(CAM.pitch, -0.3, 1.3);
  CAM.idle += rdt;
  if (CAM.recent > 0) { CAM.recent -= rdt; CAM.yaw += angDiff(CAM.yaw, P.yaw + 0) * Math.min(1, rdt * 9); }
  else if (CAM.idle > 0.5 && G.state === 'play' && P.grounded && !CAM.fixed) CAM.yaw -= INP.ix * (INP.iz < 0.4 ? 0.8 : 0.25) * rdt * (CAM.wide ? 0.6 : 1);
  // cinematic override (shatter / victory)
  let distMul = 1, pitchAdd = 0;
  if (CAM.cine > 0) { const k = Math.sin(clamp(CAM.cine / CAM.cineDur, 0, 1) * PI); distMul = lerp(1, CAM.cineDist, Math.min(1, k * 1.6)); pitchAdd = CAM.cinePitch * Math.min(1, k * 1.6); CAM.yaw += CAM.cineYaw * rdt * k; CAM.cine -= rdt; }
  // target (smoothed vertical follow)
  const sz = P.size, upY = GF > 0 ? 1 : -1, hy = (GF > 0 ? P.y : P.y) + upY * 1.15 * sz;
  CAM.ty = P.grounded || CAM.cine > 0 ? damp(CAM.ty, hy, 9, rdt) : damp(CAM.ty, hy, 5.5, rdt);
  if (Math.abs(CAM.ty - hy) > 8) CAM.ty = hy;
  CAM.tgt.set(P.x + P.vx * 0.1, CAM.ty, P.z + P.vz * 0.1);
  const wide = CAM.wide; const wantD = (wide ? T.distWide : T.dist) * distMul * (0.85 + 0.15 * sz), wantP = CAM.pitch + (wide ? 0.14 : 0) + pitchAdd;
  CAM.dist = damp(CAM.dist, wantD, 4, rdt);
  const cp = Math.cos(wantP), sp = Math.sin(wantP);
  _co.set(-Math.sin(CAM.yaw) * cp, sp * upY, -Math.cos(CAM.yaw) * cp);
  // camera collision: march from the target out, pull in at the first solid sample
  let d = CAM.dist; const step = 0.4;
  for (let t = step; t <= CAM.dist + 0.3; t += step) { if (solidPoint(CAM.tgt.x + _co.x * t, CAM.tgt.y + _co.y * t, CAM.tgt.z + _co.z * t)) { d = Math.max(1.1, t - step - T.collide); break; } }
  CAM.cd = d < CAM.cd ? damp(CAM.cd, d, 30, rdt) : damp(CAM.cd, d, 2.5, rdt);
  camera.position.set(CAM.tgt.x + _co.x * CAM.cd, CAM.tgt.y + _co.y * CAM.cd, CAM.tgt.z + _co.z * CAM.cd);
  if (WC.hf && GF > 0) { const g = hfGround(camera.position.x, camera.position.z) + 0.45; if (camera.position.y < g) camera.position.y = g; }
  // look slightly ahead of the hero in wide mode
  CAM.look.set(CAM.tgt.x, CAM.tgt.y + (wide ? 0.3 : 0.1) * upY, CAM.tgt.z);
  if (CAM.shake > 0.001) { const s = CAM.shake; camera.position.x += (Math.random() - 0.5) * s * 0.35; camera.position.y += (Math.random() - 0.5) * s * 0.35; camera.position.z += (Math.random() - 0.5) * s * 0.35; CAM.shake *= Math.exp(-7 * rdt); }
  CAM.roll = damp(CAM.roll, GF < 0 ? PI : 0, 3.2, rdt);
  camera.up.set(0, 1, 0); camera.lookAt(CAM.look); if (Math.abs(CAM.roll) > 0.001) camera.rotateZ(CAM.roll);
  const sprint = clamp((P.speed - 9) / 6, 0, 1), fovT = (wide ? T.fovWide : T.fov) + T.fovKick * sprint + (P.act === 'long' || P.act === 'dive' ? 5 : 0) + (CAM.cine > 0 ? 6 : 0);
  camera.fov = damp(camera.fov, fovT, 5, rdt); camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------------------------------------------------------------
const _tgPose = { lx: 0, rx: 0, la: 0, ra: 0, lean: 0, side: 0, pitch: 0, hx: 0, hy: 0, bob: 0, roll: 0 }; // reused every frame (no per-frame allocation)
let heroVis = { yaw: 0.6, t: 0, fid: 0, fidT: 4, blink: 0 };
function updateHeroVisual(dt, rdt) {
  const h = hero, v = heroVis; v.t += dt; const T = TUNING;
  v.yaw += angDiff(v.yaw, P.yaw) * Math.min(1, rdt * 22);
  const sp = P.speed, runK = clamp(sp / 10.2, 0, 1.35), g = P.grounded;
  const t = _tgPose; t.lx = t.rx = t.la = t.ra = t.lean = t.side = t.pitch = t.hx = t.hy = t.bob = t.roll = 0; let k = 14;
  const act = P.act;
  if (g && (act === 'ground' || act === 'punch')) {
    if (P.crouch) { t.lx = -1.25; t.rx = -1.25; t.lean = 0.7; t.bob = -0.22; t.la = -0.6; t.ra = -0.6; t.hx = -0.25; }
    else if (act === 'punch') { const r = P.punchAlt; t.lean = 0.2; if (r) { t.ra = -1.7; t.la = 0.7; } else { t.la = -1.7; t.ra = 0.7; } if (P.punchAlt === 1 && v.t % 1 > 2) t.lx = -1; t.hx = -0.1; k = 28; }
    else if (P.skid) { t.lean = -0.4; t.la = -0.5; t.ra = -0.5; t.side = 1; t.lx = -0.6; t.rx = 0.4; k = 24; }
    else if (sp > 0.5) { h.ph += sp * rdt * 0.95 * (P.wade ? 0.7 : 1); const s = Math.sin(h.ph), c = Math.cos(h.ph); t.lx = s * 0.95 * runK; t.rx = -s * 0.95 * runK; t.la = -s * 1.0 * runK; t.ra = s * 1.0 * runK; t.lean = 0.1 + 0.26 * runK; t.bob = Math.abs(c) * 0.07 * runK; t.hx = -0.1 * runK; t.side = runK > 0.9 ? 0.3 : 0; }
    else { // idle with breathing + fidgets
      const br = Math.sin(v.t * 2.1); t.bob = br * 0.008; t.la = br * 0.05; t.ra = -br * 0.05; v.fidT -= dt; if (v.fidT < 0) { v.fid = 1.4; v.fidT = 4 + Math.random() * 4; v.fidKind = (Math.random() * 3) | 0; }
      if (v.fid > 0) { v.fid -= dt; const f = Math.sin(clamp(v.fid / 1.4, 0, 1) * PI); if (v.fidKind === 0) { t.hy = Math.sin(v.t * 3) * 0.6 * f; } else if (v.fidKind === 1) { t.ra = -2.6 * f; t.hx = -0.2 * f; t.side = f * 0.4; } else { t.lean = 0.12 * f; t.la = -0.6 * f; t.ra = -0.6 * f; t.hx = 0.25 * f; } }
    }
  } else if (act === 'slide') { t.pitch = -1.35; t.la = -3.0; t.ra = -3.0; t.rx = 0.5; t.lx = 0.3; k = 20; }
  else if (act === 'pound_land') { t.lx = -1.1; t.rx = -1.1; t.lean = 0.8; t.bob = -0.25; t.la = -0.4; t.ra = -0.4; }
  else if (act === 'long') { t.pitch = -1.25; t.la = -2.9; t.ra = -2.9; t.lx = 0.55; t.rx = 0.3; t.hx = 0.4; k = 18; }
  else if (act === 'dive') { t.pitch = -1.45; t.la = -3.1; t.ra = -3.1; t.lx = 0.4; t.rx = 0.4; t.hx = 0.5; k = 22; }
  else if (act === 'pound') { if (P.poundT < T.pound.hang) { h.pose.spin += rdt * 26; t.pitch = -0.55; t.lx = -1.1; t.rx = -1.1; t.la = -1.4; t.ra = -1.4; t.bob = 0.1; } else { t.la = -3.0; t.ra = -3.0; t.lx = 0.3; t.rx = 0.3; t.hx = -0.2; } k = 22; }
  else if (act === 'flip') {
    const d = P.flipKind; const pr = clamp(P.flipT / (d === 'wall' ? 0.3 : d === 'triple' ? 0.66 : 0.58), 0, 1);
    t.pitch = d === 'triple' ? -PI * 2 * pr : d === 'back' || d === 'side' ? PI * 2 * pr : d === 'wall' ? -PI * pr * 0.0 : 0; t.lx = -0.9; t.rx = -0.9; t.la = -1.2; t.ra = -1.2; t.lean = 0; k = 40; if (d !== 'wall') { h.pose.pitch = t.pitch; k = 90; } else { t.la = -2.6; t.ra = -2.6; t.lx = -0.5; t.rx = 0.5; }
  }
  else { // air / jump / fall
    if (P.vy > 1) { t.la = -2.7; t.ra = -2.7; t.lx = -0.9; t.rx = 0.5; t.side = 0.3; t.lean = -0.05; } else { t.la = -0.7; t.ra = -0.7; t.lx = 0.35; t.rx = -0.25; t.side = 1; t.lean = 0.1; t.hx = -0.1; }
    if (P.wallT > 0) { t.la = -2.5; t.ra = -2.5; }
  }
  if (P.hurtT > 0) { t.lean = -0.55; t.la = -2.3; t.ra = -2.3; t.hx = -0.5; t.side = 1; k = 30; }
  if (P.victory > 0) { t.la = -3.0 + Math.sin(v.t * 9) * 0.3; t.ra = -3.0 - Math.sin(v.t * 9) * 0.3; t.bob = Math.abs(Math.sin(v.t * 5)) * 0.35; t.hx = -0.25; t.lean = -0.1; }
  if (P.talk > 0 && g && !P.crouch) { t.hy = Math.sin(v.t * 2) * 0.2; }
  if (act !== 'flip') { if (act !== 'pound') h.pose.spin = damp(h.pose.spin, 0, 18, rdt); if (act !== 'long' && act !== 'dive' && act !== 'slide') { if (Math.abs(h.pose.pitch) > 0.4 && Math.abs(h.pose.pitch) > PI) h.pose.pitch = 0; } }
  k = gemPoseApply(t, h, rdt, k); poseTo(h, t, rdt, k); applyPose(h, rdt);
  P.stepOff *= Math.exp(-14 * rdt); if (Math.abs(P.stepOff) < 0.002) P.stepOff = 0;
  h.root.position.set(P.x, P.y - (GF > 0 ? 1 : -1) * P.stepOff, P.z); h.root.rotation.set(0, v.yaw, GF < 0 ? PI : 0);
  const tgtS = (P.big ? 1.26 : 1) * h.S; P.size = damp(P.size, P.big ? 1.26 : 1, 6, rdt); h.root.scale.setScalar(h.S * P.size);
  h.root.visible = !(P.invuln > 0 && Math.floor(v.t * 18) % 2 === 0 && P.hurtT <= 0.0001 && P.invuln < 1.5);
  h.mats.red.emissiveIntensity = h.mats.blue.emissiveIntensity = 0.1 + (P.invuln > 0 ? 0.15 : 0);
}

