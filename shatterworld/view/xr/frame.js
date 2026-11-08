// ---- per-frame: inputs -> game, head pose, UI ----------------------------------------------------------------------------------------
function vrReadInputs() {
  XI[0].has = XI[1].has = false; const srcs = VR.session.inputSources;
  for (let i = 0; i < srcs.length; i++) {
    const s = srcs[i], h = s.handedness === 'left' ? 0 : s.handedness === 'right' ? 1 : -1; if (h < 0) continue;
    const X = XI[h], gp = s.gamepad; X.has = true; X.src = s; X.hand = !!s.hand;
    if (gp) { // xr-standard: buttons[0] trigger, [1] squeeze, [3] thumbstick, [4] A/X, [5] B/Y; axes[2],[3] thumbstick
      const a = gp.axes, b = gp.buttons, n = b.length;
      X.ax = a.length > 2 ? a[2] : (a.length > 0 ? a[0] : 0); X.ay = a.length > 3 ? a[3] : (a.length > 1 ? a[1] : 0);
      X.trig = n > 0 ? b[0].value : 0; X.grip = n > 1 ? b[1].value : 0; X.stick = n > 3 && b[3].pressed; X.b4 = n > 4 && b[4].pressed; X.b5 = n > 5 && b[5].pressed;
    } else { X.ax = X.ay = 0; X.trig = VR.pinch[h] ? 1 : 0; X.grip = 0; X.stick = X.b4 = X.b5 = false; } // hand tracking: a pinch is the trigger
    X.trigOn = X.trig > (X.trigOn ? 0.35 : 0.55); X.gripOn = X.grip > (X.gripOn ? 0.35 : 0.55);
  }
  for (let h = 0; h < 2; h++) { const X = XI[h]; if (!X.has) { X.trig = X.grip = X.ax = X.ay = 0; X.trigOn = X.gripOn = X.stick = X.b4 = X.b5 = false; }
    X.m = (X.trigOn ? 1 : 0) | (X.gripOn ? 2 : 0) | (X.b4 ? 4 : 0) | (X.b5 ? 8 : 0) | (X.stick ? 16 : 0); X.rawRise = X.m & ~X.pm; X.pm = X.m; }
}
function vrHead(rdt) {
  const xc = renderer.xr.getCamera(), cs = xc.cameras; VR.headOk = cs.length > 0; if (!VR.headOk) return;
  const c0 = cs[0], c1 = cs.length > 1 ? cs[1] : c0;
  VR.hpx = (c0.position.x + c1.position.x) * 0.5; VR.hpy = (c0.position.y + c1.position.y) * 0.5; VR.hpz = (c0.position.z + c1.position.z) * 0.5;
  _va.set(0, 0, -1).applyQuaternion(c0.quaternion); _vb.set(0, 1, 0).applyQuaternion(c0.quaternion); VR.fy = _va.y; // heading = forward + up*(looking-down amount): stable while you look down at the table
  const w = Math.max(0, -_va.y); let gx = _va.x + _vb.x * w, gz = _va.z + _vb.z * w; const l = Math.hypot(gx, gz); if (l > 1e-4) { gx /= l; gz /= l; } else { gx = VR.gx; gz = VR.gz; }
  VR.gx = gx; VR.gz = gz; const c = Math.cos(VR.yaw), s = Math.sin(VR.yaw); const ty = Math.atan2(gx * c + gz * s, -gx * s + gz * c);
  CAM.yaw += angDiff(CAM.yaw, ty) * (VR.first ? 1 : 1 - Math.exp(-14 * rdt)); VR.first = false; // the sim's camera-relative movement basis IS the head yaw
}
function vrPlaceTable() { // put the diorama in front of the viewer, below eye level, facing so the hero runs away from them
  if (!VR.headOk) return;
  VR.ax = VR.hpx + VR.gx * VRT.fwd; VR.az = VR.hpz + VR.gz * VRT.fwd; const fy = VR.hpy + VR.floorY;
  VR.ay = clamp(fy - VRT.drop, VRT.tableMin, VRT.tableMax) - VR.floorY; VR.yaw = P.yaw - Math.atan2(VR.gx, VR.gz);
  VR.needAnchor = false; VR.snapFollow = true; VR.capAng = Math.atan2(VR.gx, VR.gz); vrRing.position.set(VR.ax, VR.ay, VR.az); UI.mode = 'none'; // re-opens (and re-places) the menu panels below
}
function vrCycleSize() { vrCfg.size = (vrCfg.size + 1) % VRT.scales.length; VR.S = VRT.scales[vrCfg.size]; VR.fade = 1; vrSaveCfg(); vrHaptic(2, 0.3, 30); toast('Table size ' + ['SMALL', 'MEDIUM', 'LARGE'][vrCfg.size]); sfx('click'); UI.dirtyMain = true; }
function vrActions(rdt) {
  const L = XI[0], R = XI[1], play = G.state === 'play', rpm = G.state === 'inv' || G.state === 'perk' || G.state === 'cls' || G.state === 'sta';
  if (play !== VR.wasPlay || rpm !== VR.wasRp) { VR.wasPlay = play; VR.wasRp = rpm; vrReleaseAll(); L.sup = L.m; R.sup = R.m; RV.rep.dir = 0; RV.yHold = 0; RV.yFr = 0; VR.yDone = false; } // buttons held across a state change must be released before they count again
  for (let h = 0; h < 2; h++) { const X = XI[h]; X.sup &= X.m; X.e = X.m & ~X.sup; X.rise = X.e & ~X.pe; X.pe = X.e; }
  if (rpm) { vrRpgActions(rdt, L, R); return; } // inventory / perk pick: sticks = cursor, A confirm, B back, X salvage, Y lock, grips = tabs (the world is paused)
  // ---- left stick: analog direction + proportional speed (VRIN) and the same WASD keys the shim uses -------------------------------------
  let mag = 0, ix = 0, iz = 0, ly = 0, lx = 0;
  if (play && L.has) { const m = Math.hypot(L.ax, L.ay), dz = VRT.stickDead; if (m > dz) { const k = (Math.min(m, 1) - dz) / (1 - dz) / m; lx = L.ax * k; ly = L.ay * k; mag = Math.hypot(lx, ly); ix = lx; iz = -ly; } }
  if (play) { vrAxisKeys('a', 'd', lx); vrAxisKeys('w', 's', ly); } else { xkey('a', false); xkey('d', false); xkey('w', false); xkey('s', false); }
  VRIN.mag = mag > 0 ? clamp(mag / 0.85, 0.22, 1) : 0; VRIN.x = ix; VRIN.z = iz;
  xkey(' ', play && !!(R.e & 4)); xkey('z', play && !!(R.e & 8)); xkey('shift', play && !!(L.e & 16));
  if (play && (R.rise & 16)) { VR.eT = 0.12; VR.eKey = true; keys.add('e'); VR.eKey = false; } if (VR.eT > 0) { VR.eT -= rdt; if (VR.eT <= 0) keys.delete('e'); } // R-stick click: talk / flip pad
  const gvh = gvPokeActions(play); gvStickActions(play, rdt, L, R); const fireNow = play && !!((L.e | (gvh >= 0 ? 0 : R.e)) & 1), placeNow = gvPlaceLogic(play, L, R, rdt);
  if (fireNow !== VR.fire) { VR.fire = fireNow; padFire(fireNow); if (fireNow) VR.fireHand = (R.e & 1) ? 1 : 0; }
  if (placeNow !== VR.place) { VR.place = placeNow; padPlace(placeNow); }
  // ---- Y: pause menu (tap) / inventory (hold); X: tap = table size, hold = recentre ------------------------------------------------------------------------------
  if (vrYLogic(rdt, L)) return; // Y: tap = pause / resume (at release), hold 0.4 s = inventory
  if (L.m & 4) { VR.xHold += rdt; if (VR.xHold > 0.6 && !VR.xDone) { VR.xDone = true; vrPlaceTable(); VR.fade = 1; vrHaptic(0, 0.5, 60); toast('Table recentred'); } }
  else { if (VR.xHold > 0 && !VR.xDone) vrCycleSize(); VR.xHold = 0; VR.xDone = false; }
  // ---- right stick: snap turn (30 deg per flick, re-armed when the stick returns) or smooth turn ----------------------------------------
  const rx = R.has ? R.ax : 0;
  if (vrCfg.snap) { if (VR.snapArmed) { if (Math.abs(rx) > VRT.snapOn) { VR.yaw -= Math.sign(rx) * VRT.snapDeg * PI / 180; VR.snapArmed = false; VR.turns++; vrHaptic(1, 0.12, 12); } } else if (Math.abs(rx) < VRT.snapOff) VR.snapArmed = true; }
  else { const m = Math.abs(rx); if (m > VRT.stickDead) VR.yaw -= Math.sign(rx) * (m - VRT.stickDead) / (1 - VRT.stickDead) * VRT.smoothDegPerSec * PI / 180 * rdt; VR.snapArmed = true; }
}
function vrUiMode() { return G.state === 'menu' ? 'start' : G.state === 'pause' ? 'pause' : G.state === 'dead' ? (G.won || (RIFT && RIFT.won) ? 'win' : 'lose') : G.state === 'inv' ? 'inv' : G.state === 'perk' ? 'perk' : G.state === 'cls' ? 'cls' : G.state === 'sta' ? 'sta' : 'none'; }
function vrUiOpen(mode) {
  UI.mode = mode; UI.hot[0] = UI.hot[1] = -1; UI.hotKey = -1; const on = mode !== 'none', rpm = mode === 'inv' || mode === 'perk' || mode === 'cls' || mode === 'sta'; UI.main.mesh.visible = on && !rpm; UI.how.mesh.visible = on && (mode === 'start' || mode === 'pause'); UI.rp.mesh.visible = rpm; RV.hotId[0] = RV.hotId[1] = ''; RV.rep.dir = 0; if (!on) return;
  if (rpm) { // the big RPG panel sits where you are looking, level with the horizon so the table below stays visible; it never follows the head afterwards
    const hx = VR.hpx, hz = VR.hpz, gx = VR.gx, gz = VR.gz, pit = clamp(Math.asin(clamp(VR.fy, -1, 1)), -0.2, 0.08), y = Math.max(0.7, VR.hpy + VR.floorY + Math.sin(pit) * 1.15) - VR.floorY, hd = Math.cos(pit) * 1.15;
    vrPlacePanel(UI.rp, hx + gx * hd, y, hz + gz * hd, hx, hz); RV.dirty = true; RV.pkPage = 0; vrDrawRp(); toastPollForce(); return;
  }
  vrBuildButtons(mode);
  const hx = VR.hpx, hz = VR.hpz, gx = VR.gx, gz = VR.gz, pit = clamp(Math.asin(clamp(VR.fy, -1, 1)), -0.5, 0.09); // panel sits where you are looking, but never steeper than ~28 deg down
  const y = Math.max(0.6, VR.hpy + VR.floorY + Math.sin(pit) * 1.3) - VR.floorY, hd = Math.cos(pit) * 1.3;
  vrPlacePanel(UI.main, hx + gx * hd, y, hz + gz * hd, hx, hz);
  const a = -0.85, ca = Math.cos(a), sa = Math.sin(a), dx = gx * ca + gz * sa, dz = -gx * sa + gz * ca; // how-to panel: ~49 deg to the right of the menu
  vrPlacePanel(UI.how, hx + dx * 1.15, y - 0.02, hz + dz * 1.15, hx, hz);
  vrDrawMain(); toastPollForce();
}
function vrUiClick(id) {
  sfx('click'); vrHaptic(2, 0.3, 24);
  switch (id) {
    case 'cta': $('cta').click(); break;
    case 'cta2': $('cta2').click(); break;
    case 'resume': resumeGame(); break;
    case 'menu': toMenu(); break;
    case 'size': vrCycleSize(); break;
    case 'turn': vrCfg.snap = vrCfg.snap ? 0 : 1; vrSaveCfg(); toast(vrCfg.snap ? 'Snap turn 30°' : 'Smooth turn'); UI.dirtyMain = true; break;
    case 'qual': vrSetQuality(vrCfg.q === 'vr' ? 'vrlite' : 'vr'); toast(vrCfg.q === 'vr' ? 'VR graphics' : 'VR lite graphics (smaller shadows, fewer blocks)'); UI.dirtyMain = true; break;
    case 'exit': vrExit(); break;
    case 'inv': openInv(); break;
    case 'cls': openChars(); break;
    case 'town': if (TW.on) suiOpen('portal'); else townEnter(); break;
    case 'diff': { const d = $('rpgMenu').querySelector('[data-diff="' + ((RP.diff + 1) % (RP.diffUnlocked + 1)) + '"]'); if (d) d.click(); UI.dirtyMain = true; break; }
    case 'rtm': case 'rtp': { const d = $('rpgMenu').querySelector('[data-rt="' + (id === 'rtp' ? 1 : -1) + '"]'); if (d) d.click(); UI.dirtyMain = true; break; }
    case 'rift': { const d = $('rpgMenu').querySelector('[data-go="rift"]'); if (d && G.state === 'menu') d.click(); else if (G.state === 'dead') { if (RIFT) rpgRiftRestart(false, false); else rpgStartRift(RP.riftTier, RP.riftSeed || null); } break; }
    case 'seed': rpgRiftRestart(false, false); break;
  }
}
function vrUiFrame(rdt) {
  const mode = vrUiMode(); if (mode !== UI.mode) vrUiOpen(mode);
  const open = UI.mode !== 'none', rpm = UI.mode === 'inv' || UI.mode === 'perk' || UI.mode === 'cls' || UI.mode === 'sta';
  if (open) {
    let hotKey = 0; const pan = rpm ? UI.rp : UI.main, list = rpm ? RV.btns : UI.btns;
    for (let h = 0; h < 2; h++) {
      const c = UI.ch[h]; let hot = -1, hit = false; UI.hit[h] = false;
      const X = XI[h]; if (X.has && c && c.visible) {
        _vb.set(0, 0, -1).applyQuaternion(c.quaternion); const p = c.position;
        if (vrHitPanel(pan, p.x, p.y, p.z, _vb.x, _vb.y, _vb.z, _hit)) {
          hit = true; UI.laserLen[h] = _hit.t; UI.hit[h] = true;
          for (let i = 0; i < list.length; i++) { const b = list[i]; if (b.static) continue; if (_hit.u >= b.x && _hit.u <= b.x + b.w && _hit.v >= b.y && _hit.v <= b.y + b.h) { hot = i; break; } }
          const r = c.userData.ret; r.position.set(p.x + _vb.x * _hit.t, p.y + _vb.y * _hit.t, p.z + _vb.z * _hit.t); r.rotation.y = Math.atan2(pan.nx, pan.nz);
        } else UI.laserLen[h] = 1.2;
        if (rpm) { // the RPG panel keys its hot regions by id (the layout changes with the selection): hover selects, trigger clicks
          const id = hot >= 0 ? list[hot].id : ''; if (id !== RV.hotId[h]) { RV.hotId[h] = id; RV.dirty = true; if (id) { vrHaptic(h, 0.12, 8); vrRpgHover(id); } }
          if (id && (X.rawRise & 1)) vrRpgClick(id);
        } else {
          if (hot >= 0 && hot !== UI.hot[h]) vrHaptic(h, 0.15, 10);
          if (hot >= 0 && (X.rawRise & 1)) vrUiClick(UI.btns[hot].id);
        }
      } else if (rpm && RV.hotId[h] !== '') { RV.hotId[h] = ''; RV.dirty = true; }
      UI.hot[h] = hot; hotKey |= (hot + 1) << (h * 8);
    }
    if (!rpm) {
      if ((XI[1].rawRise & 4) && UI.btns.length && !GV.eat) vrUiClick(UI.btns[0].id); // A confirms the primary button
      if (hotKey !== UI.hotKey || UI.dirtyMain) { UI.hotKey = hotKey; UI.dirtyMain = false; if (UI.mode !== 'none') vrDrawMain(); }
    }
  }
  // lasers / reticles visible only while a panel is open
  for (let i = 0; i < 2; i++) { const c = vrCtrl[i], u = c.userData, h = u.hand === 'left' ? 0 : u.hand === 'right' ? 1 : -1; const show = open && h >= 0 && u.hasSrc && XI[h].has && c.visible; u.laser.visible = show; u.ret.visible = show && UI.hit[h]; if (show) u.laser.scale.z = Math.max(0.01, UI.laserLen[h] - 0.004); }
}
// DOM-driven captions (toast / NPC talk / prompt) are polled at ~8 Hz so every existing code path that writes them keeps working in VR
const domToast = $('toast'), domTalk = $('talk');
function toastPollForce() { }
function vrCaptionPoll(rdt) { // allocation-free: DOM class reads + the sequence counters toast() / showTalk() bump; text is only fetched when it changed
  const k = UI.cap; let ch = false;
  const to = domToast.classList.contains('on'); if (to !== k.toastOn || G.toastSeq !== k.toastSeq) { k.toastOn = to; k.toastSeq = G.toastSeq; k.toast = G.toastMsg || ''; ch = true; }
  const ta = domTalk.classList.contains('on'); if (ta !== k.talkOn || G.talkSeq !== k.talkSeq) { k.talkOn = ta; k.talkSeq = G.talkSeq; k.talk = G.talkMsg || ''; k.who = G.talkWho || ''; ch = true; }
  const po = G.state === 'play' && PROMPT !== ''; if (po !== k.promptOn || (po && PROMPT !== k.prompt)) { k.promptOn = po; k.prompt = po ? PROMPT : k.prompt; ch = true; }
  if (ch) { vrDrawCaption(); if (UI.rp && UI.rp.mesh.visible) RV.dirty = true; }
}
function vrPre(rdt) {
  if (!UI.built || !VR.session) return;
  vrReadInputs(); vrHead(rdt);
  if (VR.needAnchor && VR.headOk) vrPlaceTable();
  vrActions(rdt); vrUiFrame(rdt); vrCaptionPoll(rdt); vrRpgPre(rdt); gvPre(rdt);
}

