// ============================================================================
// HERO STATE + CONTROLLER
// ============================================================================
const P = {
  x: -24, y: 0, gy: 0, z: -46, vx: 0, vy: 0, vz: 0, yaw: 0.6, grounded: false, groundedT: 0, act: 'ground', actT: 0, h: TUNING.height, size: 1,
  stepOff: 0, jumpBuf: 0, zBuf: 0, fireBuf: 0, chainN: 0, chainT: 0, landT: 9, jumpHeld: false, airKind: 'jump', wallT: 0, wnx: 0, wnz: 0, kickCd: 0,
  invuln: 0, hurtT: 0, hp: TUNING.hp, big: false, poundT: 0, diveT: 0, punchT: 0, punchAlt: 0, crouch: false, speed: 0, wade: false, inLowG: false,
  stats: { jumps: 0, punches: 0, dives: 0, pounds: 0, flips: 0, kicks: 0 }, dead: false, frozen: 0, skid: false, flipT: 0, flipKind: '', prevY: 0, step: 0, onPlat: null, victory: 0, talk: 0, bounceT: 0,
};
const INP = { ix: 0, iz: 0, jump: false, crouch: false, run: false, mag: 0, spd: 1 };
const VRIN = { mag: 0, x: 0, z: 0 }; // analog stick from the VR layer (speed scale + continuous direction); mag 0 = unused (flat play)
const _pk = { jump: false, z: false, e: false, j: false, q: false, m: false, p: false, fire: false, place: false };
let heroJustPounded = false;
function pollInput(dt) {
  const k = keys, up = k.has('w') || k.has('arrowup'), dn = k.has('s') || k.has('arrowdown'), lf = k.has('a') || k.has('arrowleft'), rt = k.has('d') || k.has('arrowright');
  INP.ix = (rt ? 1 : 0) - (lf ? 1 : 0); INP.iz = (up ? 1 : 0) - (dn ? 1 : 0);
  const m = Math.hypot(INP.ix, INP.iz); INP.mag = m ? 1 : 0; if (m > 1) { INP.ix /= m; INP.iz /= m; }
  if (VRIN.mag > 0) { INP.ix = VRIN.x; INP.iz = VRIN.z; INP.mag = 1; INP.spd = VRIN.mag; } else INP.spd = 1; // analog stick (VR): continuous direction + proportional speed
  const jumpNow = k.has(' '), zNow = k.has('z'), fireNow = mouseFire || padFireDown, placeNow = mousePlace || padPlaceDown || placeLatch;
  INP.jump = jumpNow || latch.has(' '); INP.crouch = zNow; INP.run = k.has('shift'); INP.place = placeNow; INP.fire = fireNow;
  if ((jumpNow && !_pk.jump) || latch.has(' ')) P.jumpBuf = TUNING.buffer; if ((zNow && !_pk.z) || latch.has('z')) P.zBuf = 0.18; if ((fireNow && !_pk.fire) || edge.fire) { P.fireBuf = 0.16; edge.fire = false; }
  for (const key of ['e', 'j', 'q', 'm', 'p']) if ((k.has(key) && !_pk[key]) || latch.has(key)) edge[key] = true;
  _pk.jump = jumpNow; _pk.z = zNow; _pk.e = k.has('e'); _pk.j = k.has('j'); _pk.q = k.has('q'); _pk.m = k.has('m'); _pk.p = k.has('p'); _pk.fire = fireNow;
  latch.clear(); placeLatch = false;
}
function heroH() { return P.crouch || P.act === 'slide' ? 1.0 * P.size : TUNING.height * P.size; }
function heroGround() { return P.grounded; }
function setAct(a) { P.act = a; P.actT = 0; }

function stepHero(dt) {
  if (P.dead) return;
  const T = TUNING, hs = P.size;
  P.actT += dt; P.landT += dt; P.groundedT = P.grounded ? 0 : P.groundedT + dt; P.invuln = Math.max(0, P.invuln - dt); P.kickCd = Math.max(0, P.kickCd - dt);
  P.jumpBuf = Math.max(0, P.jumpBuf - dt); P.zBuf = Math.max(0, P.zBuf - dt); P.fireBuf = Math.max(0, P.fireBuf - dt); P.wallT = Math.max(0, P.wallT - dt); P.frozen = Math.max(0, P.frozen - dt);
  if (P.chainT > 0 && P.grounded) { P.chainT -= dt; if (P.chainT <= 0) P.chainN = 0; }
  const hsp = Math.hypot(P.vx, P.vz); P.speed = hsp;
  // camera-relative wish direction
  const fx = Math.sin(CAM.yaw), fz = Math.cos(CAM.yaw), rx = -fz, rz = fx;
  let wx = fx * INP.iz + rx * INP.ix, wz = fz * INP.iz + rz * INP.ix; const wl = Math.hypot(wx, wz); if (wl > 1e-4) { wx /= wl; wz /= wl; } else { wx = wz = 0; }
  const locked = P.frozen > 0 || P.hurtT > 0 || P.victory > 0 || G.cine > 0 && G.cineLock;
  if (P.hurtT > 0) P.hurtT -= dt;
  if (locked) { wx = wz = 0; }
  const want = wl > 1e-4 && !locked;
  const maxSp = (INP.run ? T.sprint : T.run) * INP.spd;
  P.crouch = P.grounded && INP.crouch && !locked && P.act !== 'pound' && P.act !== 'pound_land';
  let gMul = P.inLowG ? T.lowG : 1;
  // ---------------- ground / air control ----------------
  if (P.grounded) {
    if (P.act === 'air' || P.act === 'flip' || P.act === 'long' || P.act === 'dive' || P.act === 'pound' || P.act === 'wall') { /* landed */ }
    if (P.act === 'slide') { // belly slide after a dive
      const sp = Math.max(0, hsp - 16 * dt); if (hsp > 0.01) { P.vx *= sp / hsp; P.vz *= sp / hsp; }
      if (P.actT > T.dive.slide || sp < 1.5) setAct('ground');
    } else if (P.act === 'pound_land') { P.vx = P.vz = 0; if (P.actT > 0.38) setAct('ground'); }
    else if (P.act === 'punch') { if (P.actT > T.punch.time) setAct('ground'); P.vx *= Math.exp(-8 * dt); P.vz *= Math.exp(-8 * dt); }
    else {
      if (P.act !== 'ground') setAct('ground');
      const tgt = maxSp * (P.wade ? 0.72 : 1);
      if (P.crouch) { // crouch: a short slide that keeps speed for a moment (long-jump window), then stops
        P.skid = false; const k = Math.max(0, hsp - 11 * dt) / Math.max(hsp, 1e-6); P.vx *= k; P.vz *= k;
      } else if (want) {
        const dot = hsp > 0.3 ? (P.vx * wx + P.vz * wz) / hsp : 1;
        if (hsp > 6 && dot < -0.45) { // skid turn
          const k = Math.max(0, hsp - T.skidDecel * dt) / hsp; P.vx *= k; P.vz *= k; P.skid = true; P.skidT = 0.2;
        } else {
          P.skid = false; const tx = wx * tgt, tz = wz * tgt, dx = tx - P.vx, dz = tz - P.vz, dl = Math.hypot(dx, dz); const ac = (T.accel * (dot < 0.6 ? 1.7 : 1)) * dt;
          if (dl <= ac) { P.vx = tx; P.vz = tz; } else { P.vx += dx / dl * ac; P.vz += dz / dl * ac; }
        }
      } else { P.skid = false; const k = Math.max(0, hsp - T.decel * dt) / Math.max(hsp, 1e-6); P.vx *= k; P.vz *= k; }
    }
    // ----- jumps -----
    if (P.jumpBuf > 0 && P.act !== 'pound_land' && !locked) {
      P.jumpBuf = 0; P.zBuf = 0; P.grounded = false; P.groundedT = 1;
      const sp = Math.hypot(P.vx, P.vz), face = P.yaw;
      if (P.crouch && sp > 5.5) { // long jump
        const s = Math.min(Math.max(sp, 6) * T.longJump.mult, T.longJump.cap); P.vx = Math.sin(face) * s; P.vz = Math.cos(face) * s; P.vy = T.longJump.vy; setAct('long'); P.airKind = 'long'; P.stats.jumps++; sfx('long'); heroKick(hero, -9); puff(P.x, P.y + 0.1, P.z, 6, 0.9);
      } else if (P.crouch) { // backflip
        P.vx = -Math.sin(face) * T.backflip.back; P.vz = -Math.cos(face) * T.backflip.back; P.vy = T.backflip.vy; setAct('flip'); P.flipKind = 'back'; P.airKind = 'flip'; P.flipT = 0; P.stats.flips++; sfx('flip'); heroKick(hero, 10);
      } else if (P.skid && sp > 3) { // side flip out of a skid
        const nx = wx || -Math.sin(face), nz = wz || -Math.cos(face); P.vx = nx * T.sideflip.speed; P.vz = nz * T.sideflip.speed; P.yaw = Math.atan2(nx, nz); P.vy = T.sideflip.vy; setAct('flip'); P.flipKind = 'side'; P.airKind = 'flip'; P.flipT = 0; sfx('flip'); heroKick(hero, 10);
      } else {
        let n = 0; if (P.chainN > 0 && P.landT < T.chain + 0.05 && sp > 3) n = P.chainN; P.chainN = (n + 1) % 3 || 0; if (n === 0) P.chainN = 1; P.chainT = T.chain + 0.1;
        const base = T.jump[n]; P.vy = base + (n < 2 ? T.jumpSpeedBonus * sp : 0); const k = T.jumpKeep; P.vx *= k; P.vz *= k; P.airKind = 'jump'; setAct(n === 2 ? 'flip' : 'air'); P.flipKind = n === 2 ? 'triple' : ''; P.flipT = 0; P.jumpN = n;
        if (n === 2) P.chainN = 0; P.stats.jumps++; sfx(n === 0 ? 'jump' : n === 1 ? 'jump2' : 'jump3'); heroKick(hero, 8 + n * 2);
      }
    }
    if (P.fireBuf > 0 && P.act === 'ground' && !locked && !P.crouch) { P.fireBuf = 0; setAct('punch'); P.punchAlt ^= 1; P.punchT = T.punch.time; P.stats.punches++; aimMelee(); const f = P.yaw; P.vx += Math.sin(f) * 3.2; P.vz += Math.cos(f) * 3.2; sfx('punch'); doPunch(); }
    else if (P.fireBuf > 0 && P.crouch && !locked) { P.fireBuf = 0; } // crouch + fire does nothing special
  } else {
    // ---------------- airborne ----------------
    const air = P.act;
    if (P.act === 'ground' || P.act === 'punch' || P.act === 'slide' || P.act === 'pound_land') { setAct('air'); P.airKind = 'jump'; }
    if (air !== 'pound' && air !== 'dive' && air !== 'long' && !locked) {
      const sp = Math.hypot(P.vx, P.vz), lim = Math.max(maxSp, sp > maxSp + 0.5 ? sp : 0);
      if (want) { P.vx += wx * T.airAccel * dt; P.vz += wz * T.airAccel * dt; const s2 = Math.hypot(P.vx, P.vz); if (s2 > lim) { P.vx *= lim / s2; P.vz *= lim / s2; } }
      else { const k = Math.exp(-T.airDrag * dt * 0.5); P.vx *= k; P.vz *= k; }
    }
    if (air === 'long') { const sp = Math.hypot(P.vx, P.vz); if (want) { P.vx += wx * 6 * dt; P.vz += wz * 6 * dt; const s2 = Math.hypot(P.vx, P.vz); if (s2 > sp) { P.vx *= sp / s2; P.vz *= sp / s2; } } }
    // coyote jump
    if (P.jumpBuf > 0 && P.groundedT < T.coyote && P.vy <= 0.1 && air !== 'pound' && P.act !== 'wallkick') { P.jumpBuf = 0; P.vy = T.jump[0] + T.jumpSpeedBonus * Math.hypot(P.vx, P.vz); P.groundedT = 1; setAct('air'); P.airKind = 'jump'; P.chainN = 1; sfx('jump'); heroKick(hero, 8); }
    // wall kick
    if (P.jumpBuf > 0 && P.wallT > 0 && air !== 'pound') {
      P.jumpBuf = 0; P.wallT = 0; P.vy = T.wallKick.vy; const sp = Math.max(T.wallKick.push, Math.hypot(P.vx, P.vz) * 0.6); P.vx = P.wnx * sp; P.vz = P.wnz * sp; P.yaw = Math.atan2(P.wnx, P.wnz); P.stats.kicks++; setAct('flip'); P.flipKind = 'wall'; P.flipT = 0; P.airKind = 'flip'; sfx('kick'); heroKick(hero, 9); puff(P.x - P.wnx * 0.4, P.y + 1, P.z - P.wnz * 0.4, 6, 0.8);
    }
    // ground pound
    if (P.zBuf > 0 && air !== 'pound' && !locked) {
      const f = floorAt(P.x, P.z, P.y + 0.3), clear = f < -1e8 || P.y - f > 0.9;
      if (clear) { P.zBuf = 0; setAct('pound'); P.stats.pounds++; P.poundT = 0; P.vx = P.vz = 0; P.vy = 0; sfx('poundstart'); }
    }
    if (P.fireBuf > 0 && air !== 'dive' && air !== 'pound' && !locked) { P.fireBuf = 0; setAct('dive'); P.stats.dives++; aimDive(); const sp = Math.min(Math.max(Math.hypot(P.vx, P.vz), 5.5) + T.dive.add, T.dive.cap); P.vx = Math.sin(P.yaw) * sp; P.vz = Math.cos(P.yaw) * sp; P.vy = Math.max(T.dive.vy, P.vy * 0.3); sfx('dive'); }
    // variable jump height: releasing jump caps the rise (like the originals)
    if (P.airKind === 'jump' && !INP.jump && P.vy > T.jumpCutVy) P.vy = Math.max(T.jumpCutVy, P.vy * Math.exp(-40 * dt));
    if (air === 'pound') {
      P.poundT += dt; if (P.poundT < T.pound.hang) { P.vy = 0.8; P.vx = P.vz = 0; } else if (P.poundT - dt < T.pound.hang) { P.vy = -T.pound.speed; sfx('poundgo'); }
    }
  }
  // gravity
  if (P.act !== 'pound' || P.poundT >= T.pound.hang) {
    let g = (P.act === 'long' ? T.longGravity : T.gravity) * gMul;
    P.vy -= g * dt; const mf = (P.act === 'pound' ? T.maxFall * 1.25 : T.maxFall) * (gMul < 1 ? 0.6 : 1); if (P.vy < -mf) P.vy = -mf;
    if (P.wallT > 0 && P.vy < -T.wallSlide && P.act !== 'pound' && P.act !== 'dive') P.vy = -T.wallSlide;
  }
  // facing
  if (P.act === 'dive' || P.act === 'slide') { /* keep */ } else if (P.act === 'long' || P.act === 'pound') { } else if (hsp > 0.8 && !locked && !(P.skid && P.grounded)) { const ty = Math.atan2(P.vx, P.vz); P.yaw += angDiff(P.yaw, ty) * Math.min(1, T.turn * dt * (P.grounded ? 1 : 0.5)); }
  if (P.skid) { P.skidT -= dt; if (P.skidT < 0) P.skid = false; }
  moveHero(dt);
  // pipes / pads / wading handled by game layer
  P.flipT += dt;
}

