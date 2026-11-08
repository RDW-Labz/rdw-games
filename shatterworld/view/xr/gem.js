// <vr-gem> =====================================================================================================================================================================================
// VR parity for skills, Star Power and the character classes (no per-frame allocation while presenting: preallocated vectors / matrices, signature-gated canvas redraws, pooled haptic queue).
//  * WRIST SKILL BAR: a 1024 x 256 panel under the wrist readout (child of it): 4 hotbar slots + Star Power + Spark bar. POKE a slot with the right controller tip and pull the trigger.
//  * Right stick: flick UP = slot 1, DOWN = slot 2. Hold the LEFT grip while flicking = slots 3 / 4. BOTH grips = Star Power. A single grip is still the old "place" (rewind) button: it starts
//    after 0.12 s (so a chord is never mistaken for it), a quick tap is replayed as a short pulse.
//  * GEMS tab on the big inventory panel (sockets, links, hotbar, bag, stash, detail + compare, action buttons for A / X / Y / RT / LT).
//  * CHARACTER SELECT: the same big panel with 6 cards; 3D figurines (baked into one mesh + one outline mesh each) stand on pedestals in front of the card windows and turn slowly.
//  * haptic patterns for every skill / Star / gem event (vrGsfxHaptic).
// ===============================================================================================================================================================================================
const GV = { built: false, bar: null, hot: -1, sg: new Int32Array(16), flick: true, gHold: false, gAge: 0, chord: false, used: false, tapT: 0, figs: null, figRoot: null, backs: null, figOn: false, stickDir: 0, stickRep: 0, castFlash: 0, eat: false };
const _gvP = new THREE.Vector3(), _gvQ = new THREE.Vector3(), _gvM = new THREE.Matrix4(), _gvMr = new THREE.Matrix4();
const GV_BAR = { w: 0.26, h: 0.065, pw: 1024, ph: 256, x0: 18, pitch: 200, cell: 188, y0: 52 };

// ---- haptics -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const GV_HP = {
  spin: [0, 0.25, 80, 90, 0.4, 80, 180, 0.55, 80], slam: [0, 1, 200], clap: [0, 0.8, 80, 110, 0.5, 60], dash: [0, 0.35, 50, 70, 0.6, 60], rewind: [0, 0.3, 30, 55, 0.3, 30, 110, 0.3, 30],
  beamup: [0, 0.2, 100, 120, 0.35, 100, 240, 0.5, 100], beam: [0, 1, 260], whirl: [0, 0.3, 130], stasis: [0, 0.4, 200], meteorhit: [0, 0.9, 180],
  level: [0, 0.3, 50, 100, 0.5, 60, 230, 0.8, 100], star: [0, 0.4, 80, 120, 0.6, 80, 250, 0.8, 100, 400, 1, 380], starup: [0, 0.15, 150, 180, 0.3, 150, 360, 0.5, 150, 540, 0.7, 150],
  starend: [0, 0.6, 200], form: [0, 0.4, 60, 100, 0.6, 100], unlock: [0, 0.4, 70, 120, 0.6, 70, 240, 0.8, 90, 380, 1, 300], bloom: [0, 0.3, 40],
};
function vrGsfxHaptic(name, a) {
  switch (name) {
    case 'gcube': case 'gboom': case 'gcinder': case 'gfire': vrHaptic(1, 0.4, 30); break;
    case 'gcubehit': vrHaptic(1, 0.3, 20); break;
    case 'gspin': vrHapPlay(2, GV_HP.spin); break; case 'gslam': vrHapPlay(2, GV_HP.slam); break; case 'gclap': vrHapPlay(2, GV_HP.clap); break;
    case 'gbloom': vrHapPlay(1, GV_HP.bloom); break; case 'gdash': vrHapPlay(2, GV_HP.dash); break; case 'grewind': vrHapPlay(2, GV_HP.rewind); break;
    case 'gcatch': vrHaptic(1, 0.5, 50); break; case 'gbeamup': vrHapPlay(2, GV_HP.beamup); break; case 'gbeam': vrHapPlay(2, GV_HP.beam); break;
    case 'gwhirl': vrHapPlay(2, GV_HP.whirl); break; case 'gstasis': vrHapPlay(2, GV_HP.stasis); break; case 'gmeteorhit': vrHapPlay(2, GV_HP.meteorhit); break;
    case 'glevel': vrHapPlay(2, GV_HP.level); break; case 'gsocket': vrHaptic(1, 0.3, 25); break; case 'gunsock': vrHaptic(1, 0.2, 20); break; case 'gdeny': vrHaptic(1, 0.45, 70); break;
    case 'gcls': vrHaptic(1, 0.25, 25); break; case 'gunlock': vrHapPlay(2, GV_HP.unlock); break;
    case 'gstar': vrHapPlay(2, GV_HP.star); break; case 'gstarup': vrHapPlay(2, GV_HP.starup); break; case 'gstarend': vrHapPlay(2, GV_HP.starend); break;
    case 'gstarhit': vrHaptic(1, 0.35, 22); break; case 'gform': vrHapPlay(2, GV_HP.form); break; case 'gformend': vrHaptic(2, 0.3, 80); break;
  }
}

// ---- wrist skill bar ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function gvBuild() {
  if (GV.built) return; GV.built = true;
  GV.bar = vrPanel(GV_BAR.w, GV_BAR.h, GV_BAR.pw, GV_BAR.ph, false); GV.bar.mesh.position.set(0, -(0.195 + GV_BAR.h) / 2 - 0.006, 0); GV.bar.mesh.visible = true; GV.bar.mat.opacity = 0; UI.wrP.mesh.add(GV.bar.mesh); GV.sg.fill(-7);
}
let _gvK = 0, _gvCh = false;
function gvSet(v) { v |= 0; if (GV.sg[_gvK] !== v) { GV.sg[_gvK] = v; _gvCh = true; } _gvK++; }
function gvBarSig() { // numbers only, no closures; true when anything the bar shows changed
  _gvK = 0; _gvCh = false;
  gvSet(GM.spark * 0.5); gvSet(GM.sparkMax); gvSet(GM.sparkFlash > 0 ? 1 : 0); gvSet(GV.hot + 1);
  for (let i = 0; i < 4; i++) { const a = GM.slot[i]; gvSet(a ? (a.gem.u ^ (a.gem.lv << 24)) : 0); gvSet(a && GM.cd[i] > 0 ? Math.ceil(GM.cd[i] / Math.max(0.1, GM.cdMax[i]) * 12) : 0); }
  gvSet(STAR.meter * 0.5); gvSet(STAR.on ? 1 + Math.ceil(STAR.t) : 0); gvSet(FORM.id ? Math.ceil(FORM.t) + (FORM.id === 'gust' ? 1000 : 0) : 0); gvSet(STAR.meter >= GEM_TUNING.star.max - 0.01 && !STAR.on ? ((performance.now() / 320) | 0) & 1 : 0);
  return _gvCh;
}
function gvDrawBar() {
  const p = GV.bar, c = p.ctx, W = p.pw, H = p.ph, B = GV_BAR; c.clearRect(0, 0, W, H); c.textBaseline = 'alphabetic';
  rrect(c, 4, 4, W - 8, H - 8, 34); const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, 'rgba(10,26,42,.94)'); g.addColorStop(1, 'rgba(6,14,24,.94)'); c.fillStyle = g; c.fill(); c.lineWidth = 5; c.strokeStyle = STAR.on ? 'rgba(255,214,107,.95)' : 'rgba(160,190,255,.8)'; c.stroke();
  const sf = clamp(GM.spark / Math.max(1, GM.sparkMax), 0, 1); rrect(c, 24, 14, W - 48, 26, 13); c.fillStyle = 'rgba(255,255,255,.1)'; c.fill(); if (sf > 0.01) { rrect(c, 24, 14, Math.max(26, (W - 48) * sf), 26, 13); c.fillStyle = GM.sparkFlash > 0 ? '#ff8a7a' : '#6aa0ff'; c.fill(); }
  for (let i = 0; i < 4; i++) {
    const x = B.x0 + i * B.pitch, y = B.y0, s = B.cell, a = GM.slot[i], hot = GV.hot === i; rrect(c, x, y, s, s, 28); c.fillStyle = a ? RV_RC[GEM_BY_ID[a.gem.id].tier] : 'rgba(255,255,255,.05)'; c.fill();
    if (a) {
      c.drawImage(gemIconBase(a.gem.id), x + 14, y + 10, s - 28, s - 28);
      if (GM.cd[i] > 0) { const f = clamp(GM.cd[i] / Math.max(0.1, GM.cdMax[i]), 0, 1); c.save(); rrect(c, x, y, s, s, 28); c.clip(); c.fillStyle = 'rgba(0,0,0,.66)'; c.fillRect(x, y, s, s * f); c.restore(); }
      c.lineWidth = 6; c.strokeStyle = 'rgba(0,0,0,.85)'; c.font = '900 40px ' + VFONT; c.textAlign = 'right'; c.strokeText(String(a.gem.lv), x + s - 12, y + s - 12); c.fillStyle = '#fff'; c.fillText(String(a.gem.lv), x + s - 12, y + s - 12);
      c.textAlign = 'left'; c.font = '800 30px ' + VFONT; c.strokeText(String(Math.round(a.R.cost)), x + 12, y + s - 12); c.fillStyle = '#9fc4ff'; c.fillText(String(Math.round(a.R.cost)), x + 12, y + s - 12);
    }
    c.lineWidth = hot ? 9 : 4; rrect(c, x, y, s, s, 28); c.strokeStyle = hot ? '#ffffff' : a ? RPG_RARITY_COL[GEM_BY_ID[a.gem.id].tier] : 'rgba(255,255,255,.22)'; c.stroke();
    c.textAlign = 'left'; c.font = '900 40px ' + VFONT; c.lineWidth = 6; c.strokeStyle = 'rgba(0,0,0,.85)'; c.strokeText(String(i + 1), x + 14, y + 42); c.fillStyle = '#ffe27a'; c.fillText(String(i + 1), x + 14, y + 42);
  }
  { // Star cell: ring meter
    const x = B.x0 + 4 * B.pitch, y = B.y0, s = B.cell, cx = x + s / 2, cy = y + s / 2, hot = GV.hot === 4, rdy = STAR.meter >= GEM_TUNING.star.max - 0.01 && !STAR.on, f = STAR.on ? clamp(STAR.t / Math.max(1, STAR.dur), 0, 1) : clamp(STAR.meter / GEM_TUNING.star.max, 0, 1);
    c.beginPath(); c.arc(cx, cy, s / 2 - 6, 0, TAU); c.fillStyle = rdy ? 'rgba(90,64,10,.9)' : 'rgba(8,16,28,.85)'; c.fill(); c.lineWidth = 14; c.strokeStyle = 'rgba(255,255,255,.12)'; c.stroke();
    if (f > 0.005) { c.beginPath(); c.arc(cx, cy, s / 2 - 6, -PI / 2, -PI / 2 + TAU * f); c.lineWidth = 14; c.strokeStyle = STAR.on || rdy ? '#ffd45a' : '#e6b84a'; c.stroke(); }
    if (hot) { c.beginPath(); c.arc(cx, cy, s / 2 + 2, 0, TAU); c.lineWidth = 8; c.strokeStyle = '#fff'; c.stroke(); }
    c.textAlign = 'center'; c.fillStyle = rdy ? '#fff2b0' : '#ffe9b8'; c.font = '900 ' + (rdy ? 40 : 50) + 'px ' + VFONT; c.fillText(STAR.on ? Math.ceil(STAR.t) + 's' : rdy ? 'READY' : Math.floor(STAR.meter) + '%', cx, cy + 10); c.font = '800 28px ' + VFONT; c.fillStyle = '#ffd45a'; c.fillText(FORM.id ? FORM_DEF[FORM.id].name.split(' ')[0] + ' ' + Math.ceil(FORM.t) : 'STAR', cx, cy + 52);
  }
  p.tex.needsUpdate = true;
}
function gvBarPrep() { // inside vrRenderPrep, after the wrist readout
  if (!GV.bar) return; if (gvBarSig()) gvDrawBar(); GV.bar.mat.opacity = UI.wrP.mat.opacity;
}
function gvPoke(play) { // the right controller TIP against the bar: allocation-free; returns the hot cell (0-3 skills, 4 star) or -1
  GV.hot = -1; if (!play || !GV.bar || !UI.wrP.mesh.visible || UI.wrP.mat.opacity < 0.45) return -1; const c = UI.ch[1], X = XI[1]; if (!c || !X.has) return -1;
  const m = GV.bar.mesh; m.updateWorldMatrix(true, false); _gvMr.copy(m.matrixWorld).invert(); c.updateWorldMatrix(true, false); _gvP.set(0, 0, -0.045).applyMatrix4(c.matrixWorld).applyMatrix4(_gvMr);
  const x = _gvP.x, y = _gvP.y, z = _gvP.z; if (Math.abs(z) > 0.045 || Math.abs(x) > GV_BAR.w * 0.5 + 0.01 || Math.abs(y) > GV_BAR.h * 0.5 + 0.015) return -1;
  const u = (x / GV_BAR.w + 0.5) * GV_BAR.pw - GV_BAR.x0, i = Math.floor(u / GV_BAR.pitch); if (i < 0 || i > 4) return -1; if (u - i * GV_BAR.pitch > GV_BAR.cell + 6) return -1; GV.hot = i; return i;
}
function gvCastCell(i) { if (i < 4) return gemCast(i); return starTry(false); }

// ---- input: poke, flick, grips (called from vrActions) -------------------------------------------------------------------------------------------------------------------------------------------
function gvPokeActions(play) {
  const prev = GV.hot, h = gvPoke(play); if (h >= 0 && h !== prev) vrHaptic(1, 0.15, 10);
  if (h >= 0 && (XI[1].rawRise & 1)) { gvCastCell(h); GV.castFlash = 0.2; }
  return h;
}
function gvStickActions(play, rdt, L, R) { // right-stick flick = slots 1 / 2 (left grip held: 3 / 4)
  const ry = R.has ? R.ay : 0, rx = R.has ? R.ax : 0;
  if (GV.flick) { if (play && Math.abs(ry) > 0.8 && Math.abs(ry) > Math.abs(rx) * 1.5) { GV.flick = false; let slot = ry < 0 ? 0 : 1; if (L.e & 2) { slot += 2; GV.used = true; } gemCast(slot); } }
  else if (Math.abs(ry) < 0.45) GV.flick = true;
}
function gvPlaceLogic(play, L, R, rdt) { // the old "place / rewind" = either grip; now delayed 0.12 s so that BOTH grips (Star Power) can be told apart; a short tap is replayed as a pulse
  const lg = !!(L.e & 2), rg = !!(R.e & 2), any = lg || rg;
  if (!play) { GV.gHold = false; GV.chord = false; GV.used = false; GV.tapT = 0; return false; }
  if (any) { if (!GV.gHold) { GV.gHold = true; GV.gAge = 0; GV.chord = false; GV.used = false; } GV.gAge += rdt; if (lg && rg && !GV.chord) { GV.chord = true; starTry(false); } }
  else { if (GV.gHold) { GV.gHold = false; if (!GV.chord && !GV.used && GV.gAge < 0.12) GV.tapT = 0.07; } GV.chord = false; GV.used = false; }
  let place = any && !GV.chord && !GV.used && GV.gAge >= 0.12; if (GV.tapT > 0) { GV.tapT -= rdt; place = true; }
  return place;
}

// ---- GEMS tab on the big panel ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
function gvGemCell(c, id, x, y, s, g, focus, sock, tgt) {
  const hot = rvHot(id); RV.btns.push({ id, x, y, w: s, h: s }); const d = g ? GEM_BY_ID[g.id] : null;
  if (sock) { c.beginPath(); c.arc(x + s / 2, y + s / 2, s / 2 - 3, 0, TAU); c.fillStyle = 'rgba(8,16,28,.82)'; c.fill(); c.lineWidth = 7; c.strokeStyle = GEM_COLORS[sock].css; c.stroke(); }
  else { rrect(c, x, y, s, s, s * 0.16); c.fillStyle = d ? RV_RC[d.tier] : 'rgba(255,255,255,.05)'; c.fill(); c.lineWidth = 3; c.strokeStyle = d ? RPG_RARITY_COL[d.tier] : 'rgba(255,255,255,.22)'; c.stroke(); }
  if (g) { const pad = sock ? s * 0.13 : 4; c.drawImage(gemIconBase(g.id), x + pad, y + pad, s - 2 * pad, s - 2 * pad); c.textBaseline = 'alphabetic'; c.textAlign = 'right'; c.font = '900 ' + Math.round(s * 0.3) + 'px ' + VFONT; c.lineWidth = 6; c.strokeStyle = 'rgba(0,0,0,.85)'; c.strokeText(String(g.lv), x + s - 6, y + s - 6); c.fillStyle = '#fff'; c.fillText(String(g.lv), x + s - 6, y + s - 6); if (g.lk) { c.beginPath(); c.arc(x + 13, y + 13, 9, 0, TAU); c.fillStyle = '#ffd24a'; c.fill(); } }
  if (tgt) { c.beginPath(); if (sock) c.arc(x + s / 2, y + s / 2, s / 2 + 6, 0, TAU); else rrect(c, x - 5, y - 5, s + 10, s + 10, s * 0.2); c.lineWidth = 6; c.strokeStyle = '#ffe27a'; c.stroke(); }
  if (focus) { c.beginPath(); if (sock) c.arc(x + s / 2, y + s / 2, s / 2 + 3, 0, TAU); else rrect(c, x - 3, y - 3, s + 6, s + 6, s * 0.18); c.lineWidth = 8; c.strokeStyle = '#ffffff'; c.stroke(); }
  else if (hot) { c.beginPath(); if (sock) c.arc(x + s / 2, y + s / 2, s / 2 + 5, 0, TAU); else rrect(c, x - 4, y - 4, s + 8, s + 8, s * 0.19); c.lineWidth = 4; c.strokeStyle = 'rgba(160,220,255,.9)'; c.stroke(); }
}
function rvGems(c) {
  const y0 = 130, hh = 1010, sel = guSel(), tg = GU.tgt;
  { // column 1: sockets + links
    const x0 = 40, w = 500; rvPanelBg(c, x0, y0, w, hh, 26); rvTxt(c, 'SOCKETS  ·  LINKS', x0 + 24, y0 + 48, 36, '#9fd8ff', 800);
    for (let r = 0; r < GEM_ROWS.length; r++) {
      const k = GEM_ROWS[r], it = gemRowItem(k), L = it ? gemSockets(it) : null, y = y0 + 70 + r * 134, cur = GU.zone === 'sock' && GU.row === r;
      if (cur) { rrect(c, x0 + 10, y - 6, w - 20, 126, 18); c.fillStyle = 'rgba(255,226,122,.10)'; c.fill(); }
      rvTxt(c, GEM_ROW_LABEL[k], x0 + 28, y + 24, 30, cur ? '#ffe27a' : '#cfe0ee', 900); if (it && k !== 'core') rvTxt(c, rpgItemName(it), x0 + 28 + 170, y + 24, 25, RPG_RARITY_COL[RPG_RARITIES.indexOf(it.rarity)], 700, 'left', w - 210); else if (k === 'core') rvTxt(c, 'innate rig', x0 + 28 + 170, y + 24, 25, '#7d93a6', 600); else rvTxt(c, 'empty', x0 + 28 + 170, y + 24, 25, '#566a7c', 600);
      if (!L || !L.n) { rvTxt(c, it ? 'no sockets' : '-', x0 + 30, y + 86, 30, '#566a7c', 600); continue; }
      for (let j = 0; j < L.n; j++) {
        const cx = x0 + 30 + j * 96, g = it.gems ? it.gems[j] : null; gvGemCell(c, 'gz:sock:' + r + ':' + j, cx, y + 38, 76, g, GU.zone === 'sock' && GU.row === r && GU.j === j, L.colors[j], !!tg && tg.row === r && tg.j === j);
        if (j < L.n - 1) { rrect(c, cx + 76 + 1, y + 38 + 30, 18, 16, 6); c.fillStyle = L.links[j] ? '#ffe27a' : 'rgba(255,255,255,.14)'; c.fill(); }
      }
    }
  }
  { // column 2: hotbar + bag + stash
    const x0 = 560, w = 820; rvPanelBg(c, x0, y0, w, hh, 26); rvTxt(c, 'HOTBAR', x0 + 24, y0 + 46, 36, '#9fd8ff', 800); rvTxt(c, 'wrist bar / right stick', x0 + 200, y0 + 46, 26, '#6f8aa0', 600);
    for (let i = 0; i < 4; i++) { const uid = RP.hot[i], a = uid ? gemFindActive(uid) : null, x = x0 + 30 + i * 150; gvGemCell(c, 'gz:hot:' + i, x, y0 + 62, 116, a ? a.gem : null, GU.zone === 'hot' && GU.i === i); rvTxt(c, String(i + 1), x + 58, y0 + 62 + 116 + 34, 30, '#ffe27a', 900, 'center'); }
    rvTxt(c, 'GEM BAG ' + RP.gems.filter(Boolean).length + ' / ' + GEM_TUNING.bagN, x0 + 24, y0 + 262, 34, '#9fd8ff', 800);
    for (let i = 0; i < GEM_TUNING.bagN; i++) gvGemCell(c, 'gz:gem:' + i, x0 + 24 + (i % 6) * 128, y0 + 280 + ((i / 6) | 0) * 112, 100, RP.gems[i], GU.zone === 'gem' && GU.i === i);
    rvTxt(c, 'SHARED STASH ' + RP.stash.filter(Boolean).length + ' / ' + GEM_TUNING.stashN, x0 + 24, y0 + 872, 30, '#9fd8ff', 800);
    for (let i = 0; i < GEM_TUNING.stashN; i++) gvGemCell(c, 'gz:stash:' + i, x0 + 24 + (i % 10) * 78, y0 + 886 + ((i / 10) | 0) * 56, 50, RP.stash[i], GU.zone === 'stash' && GU.i === i);
  }
  { // column 3: detail + compare + action buttons
    const x0 = 1400, w = 608, x = x0 + 26, iw = w - 52, lim = y0 + hh - 250; rvPanelBg(c, x0, y0, w, hh, 26); let y = y0 + 62;
    if (tg) { rrect(c, x0 + 12, y0 + 10, w - 24, 52, 16); c.fillStyle = 'rgba(255,226,122,.2)'; c.fill(); rvTxt(c, 'CHOOSE A GEM FOR THE ' + GEM_COLORS[gemSockets(gemRowItem(GEM_ROWS[tg.row])).colors[tg.j]].name.toUpperCase() + ' SOCKET', x0 + w / 2, y0 + 46, 26, '#ffe27a', 800, 'center', w - 40); y += 20; }
    for (const l of gemDetailLines(sel)) {
      if (y > lim) break;
      switch (l.k) {
        case 'h': rvTxt(c, l.t, x, y, 44, l.c || '#fff', 900, 'left', iw); y += 50; break;
        case 'sub': rvTxt(c, l.t, x, y, 26, '#a9bccb', 700, 'left', iw); y += 40; break;
        case 'bar': rrect(c, x, y - 28, iw, 38, 19); c.fillStyle = 'rgba(255,255,255,.1)'; c.fill(); if (l.v > 0.01) { rrect(c, x, y - 28, Math.max(38, iw * l.v), 38, 19); c.fillStyle = '#53c8e0'; c.fill(); } rvTxt(c, l.txt, x + iw / 2, y - 1, 24, '#04202a', 800, 'center'); y += 46; break;
        case 'p': if (l.t) { c.font = '600 28px ' + VFONT; wrapLines(c, l.t, iw, _wl); c.fillStyle = '#dfe9f2'; c.textAlign = 'left'; for (let i = 0; i < _wl.length && y < lim; i++) { c.fillText(_wl[i], x, y); y += 34; } y += 6; } break;
        case 'sep': y += 4; c.fillStyle = 'rgba(255,255,255,.12)'; c.fillRect(x, y, iw, 2); y += 22; break;
        case 'h2': y += 6; rvTxt(c, l.t, x, y, 26, '#9fd8ff', 800, 'left', iw); y += 38; break;
        case 'row': rvTxt(c, l.t, x, y, 28, '#a9bccb', 700, 'left', iw * 0.6); rvTxt(c, l.c, x + iw, y, 28, '#ffffff', 800, 'right', iw * 0.5); y += 36; break;
        case 'sup': rvTxt(c, (l.ok ? '✓ ' : '✗ ') + l.t, x, y, 28, l.c, 700, 'left', iw); y += 34; if (l.note) { rvTxt(c, l.note, x + 30, y, 24, '#a9bccb', 600, 'left', iw - 30); y += 30; } break;
        case 'cmp': rvTxt(c, (l.up ? '▲ ' : l.dn ? '▼ ' : '● ') + l.t, x, y, 28, l.c || '#a9bccb', 700, 'left', iw); y += 36; break;
      }
    }
    const bw = (iw - 14) / 2, by = y0 + hh - 236, hasG = !!sel.gem, AL = gemActLabels(sel, tg), aL = AL.A, xL = AL.X, rL = AL.RT;
    rvBtn(c, 'ga:A', x, by, bw, 66, aL, { primary: aL !== '-', dim: aL === '-', fs: 32, r: 18 }); rvBtn(c, 'ga:X', x + bw + 14, by, bw, 66, xL, { dim: xL === '-', fs: 30, r: 18 });
    rvBtn(c, 'ga:Y', x, by + 78, bw, 66, hasG ? (sel.gem.lk ? 'UNLOCK' : 'LOCK') : '-', { dim: !hasG, fs: 32, r: 18 }); rvBtn(c, 'ga:RT', x + bw + 14, by + 78, bw, 66, rL, { dim: rL === '-', fs: 30, r: 18 });
    rvBtn(c, 'ga:LT', x, by + 156, iw, 62, 'SORT GEM BAG', { fs: 30, r: 18 });
  }
}
function gvGemSet(id) { const q = id.split(':'); if (q[1] === 'sock') { GU.zone = 'sock'; GU.row = +q[2]; GU.j = +q[3]; } else { GU.zone = q[1]; GU.i = +q[2]; } }
function gvGemHover(id) { if (!id.startsWith('gz:')) return; const o = GU.zone + GU.row + GU.j + GU.i; gvGemSet(id); if (o !== GU.zone + GU.row + GU.j + GU.i) RV.dirty = true; }
function gvGemClick(id) { if (id.startsWith('gz:')) { gvGemSet(id); guAct('A'); } else guAct(id.slice(3)); RV.dirty = true; }

// ---- CHARACTER SELECT on the big panel (+ 3D figurines) ------------------------------------------------------------------------------------------------------------------------------------------
const GV_CARD = { x0: 40, y0: 130, w: 440, h: 500, gx: 456, gy: 510, portH: 330 };
function gvCardRect(i) { return { x: GV_CARD.x0 + (i % 3) * GV_CARD.gx, y: GV_CARD.y0 + ((i / 3) | 0) * GV_CARD.gy, w: GV_CARD.w, h: GV_CARD.h }; }
function gvFlatten(root) { // one rig at its current pose -> [body mesh (vertex colours), outline mesh]; the six figurines cost 12 draw calls in total
  if (!vrLitMat) vrLitMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x100e0c });
  root.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), l1 = [], l2 = [];
  const vis = m => { for (let q = m; q && q !== root.parent; q = q.parent) if (!q.visible) return false; return true; };
  root.traverse(o => { const ud = o.userData; if (!ud || !ud.vrp) return; for (const m of ud.vrp) if (vis(m)) { m.updateWorldMatrix(true, false); l1.push({ geo: m.geometry, mat: new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld), col: m.material.color }); } if (ud.vro) for (const m of ud.vro) if (vis(m)) { m.updateWorldMatrix(true, false); l2.push({ geo: m.geometry, mat: new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld) }); } });
  return { l1, l2 };
}
function gvFigBuild() {
  if (GV.figs) return; GV.figRoot = new THREE.Group(); GV.figRoot.visible = false; UI.rp.mesh.add(GV.figRoot); GV.figs = []; const quads = [];
  const ped = new THREE.CylinderGeometry(0.5, 0.58, 0.14, 24), ring = new THREE.CylinderGeometry(0.46, 0.46, 0.02, 24), pc = new THREE.Color(0x1e2a3a), rc = new THREE.Color(1, 0.84, 0.35);
  CLASS_ORDER.forEach((id, i) => {
    const rig = buildClassRig(id), f = gvFlatten(rig.root), bb = new THREE.Box3(); const tmp = new THREE.Mesh(vrBake(f.l1, true), vrLitMat); tmp.geometry.computeBoundingBox(); bb.copy(tmp.geometry.boundingBox); tmp.geometry.dispose();
    const h = Math.max(0.5, bb.max.y - bb.min.y), k = 0.19 / (h + 0.14); // figurine + pedestal about 19 cm tall
    const m1 = new THREE.Matrix4().makeTranslation(0, -bb.min.y + 0.14, 0), l1 = f.l1.map(q => ({ geo: q.geo, mat: new THREE.Matrix4().multiplyMatrices(m1, q.mat), col: q.col })), l2 = f.l2.map(q => ({ geo: q.geo, mat: new THREE.Matrix4().multiplyMatrices(m1, q.mat) }));
    l1.push({ geo: ped, mat: new THREE.Matrix4().makeTranslation(0, 0.07, 0), col: pc }); l1.push({ geo: ring, mat: new THREE.Matrix4().makeTranslation(0, 0.146, 0), col: rc });
    const body = new THREE.Mesh(vrBake(l1, true), vrLitMat), out = new THREE.Mesh(vrBake(l2, false), outlineMat); out.renderOrder = -1; body.frustumCulled = out.frustumCulled = false;
    const g = new THREE.Group(); g.add(body, out); g.scale.setScalar(k); const hold = new THREE.Group(); hold.add(g); const r = gvCardRect(i), pw = UI.rp.pw, ph = UI.rp.ph;
    hold.position.set(((r.x + r.w / 2) / pw - 0.5) * UI.rp.wm, (0.5 - (r.y + 14 + GV_CARD.portH - 22) / ph) * UI.rp.hm, 0.04); hold.userData = { g, i, ph: i * 1.3 }; GV.figRoot.add(hold); GV.figs.push(hold);
    const q = new THREE.PlaneGeometry((GV_CARD.w - 28) / pw * UI.rp.wm, GV_CARD.portH / ph * UI.rp.hm); q.translate(((r.x + r.w / 2) / pw - 0.5) * UI.rp.wm, (0.5 - (r.y + 14 + GV_CARD.portH / 2) / ph) * UI.rp.hm, 0.012); quads.push(q);
  });
  GV.backs = new THREE.Mesh(mergeGeometries(quads, false), new THREE.MeshBasicMaterial({ color: 0x0b1626, fog: false, toneMapped: false })); GV.backs.frustumCulled = false; GV.figRoot.add(GV.backs);
}
function vrClsOpen() { gvFigBuild(); GV.figRoot.visible = true; GV.figOn = true; RV.dirty = true; GV.stickDir = 0; }
function vrClsClose() { GV.figOn = false; if (GV.figRoot) GV.figRoot.visible = false; }
function vrClsDirty() { RV.dirty = true; }
function gvFigTick(rdt) {
  if (!GV.figOn || !GV.figs) return; const t = performance.now() / 1000;
  for (let i = 0; i < GV.figs.length; i++) { const h = GV.figs[i], sel = i === CSU.i, ud = h.userData; ud.g.rotation.y += rdt * (sel ? 0.9 : 0.35); const s = sel ? 1.12 + Math.sin(t * 3) * 0.015 : 1; h.scale.setScalar(s); }
}
function gvDrawCls() {
  const p = UI.rp, c = p.ctx, W = p.pw, H = p.ph; c.clearRect(0, 0, W, H); RV.btns.length = 0; c.textBaseline = 'alphabetic';
  rrect(c, 8, 8, W - 16, H - 16, 50); const gr = c.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, 'rgba(12,28,46,.96)'); gr.addColorStop(1, 'rgba(6,14,24,.96)'); c.fillStyle = gr; c.fill(); c.lineWidth = 7; c.strokeStyle = 'rgba(255,214,107,.9)'; c.stroke();
  rvTxt(c, 'CHOOSE YOUR CHARACTER', 52, 90, 56, '#ffd66b', 900); rvTxt(c, 'LV ' + RP.level + '  ·  ' + classDef(RP.cls).name.toUpperCase() + ' playing', 1380, 84, 36, '#9fd8ff', 800, 'right'); rvBtn(c, 'cls:back', 1884, 22, 124, 84, 'X', { fs: 50, r: 22 });
  for (let i = 0; i < CLASS_ORDER.length; i++) {
    const id = CLASS_ORDER[i], d = classDef(id), un = classUnlocked(d, RP.unlocked), r = gvCardRect(i), foc = i === CSU.i, hot = rvHot('cls:' + i), cur = id === RP.cls, sl = cur ? { level: RP.level } : RP.slots[id]; RV.btns.push({ id: 'cls:' + i, x: r.x, y: r.y, w: r.w, h: r.h });
    rrect(c, r.x, r.y, r.w, r.h, 26); c.fillStyle = 'rgba(20,38,58,.86)'; c.fill(); c.save(); c.globalCompositeOperation = 'destination-out'; rrect(c, r.x + 14, r.y + 14, r.w - 28, GV_CARD.portH, 18); c.fillStyle = '#000'; c.fill(); c.restore(); // the portrait window: the 3D figurine shows through
    c.lineWidth = foc ? 9 : hot ? 6 : cur ? 6 : 3; c.strokeStyle = foc ? '#fff2b0' : hot ? '#9fd8ff' : cur ? 'rgba(83,224,208,.9)' : 'rgba(255,255,255,.2)'; rrect(c, r.x, r.y, r.w, r.h, 26); c.stroke();
    rrect(c, r.x + 14, r.y + 14, r.w - 28, GV_CARD.portH, 18); c.lineWidth = 2; c.strokeStyle = 'rgba(255,255,255,.12)'; c.stroke();
    if (!un) { rrect(c, r.x + 14, r.y + 14, r.w - 28, GV_CARD.portH, 18); c.fillStyle = 'rgba(5,10,18,.8)'; c.fill(); rvTxt(c, 'LOCKED', r.x + r.w / 2, r.y + 14 + GV_CARD.portH / 2 - 6, 52, '#ffd2a6', 900, 'center'); c.font = '700 28px ' + VFONT; wrapLines(c, d.unlock.text, r.w - 80, _wl); c.fillStyle = '#ffd2a6'; c.textAlign = 'center'; for (let k = 0; k < _wl.length && k < 3; k++) c.fillText(_wl[k], r.x + r.w / 2, r.y + 14 + GV_CARD.portH / 2 + 38 + k * 34); }
    rvTxt(c, d.name.toUpperCase(), r.x + r.w / 2, r.y + GV_CARD.portH + 78, 54, '#fff4d8', 900, 'center', r.w - 30); rvTxt(c, d.role.toUpperCase(), r.x + r.w / 2, r.y + GV_CARD.portH + 120, 30, '#ffd66b', 800, 'center');
    if (cur) { rrect(c, r.x + 22, r.y + 22, 138, 40, 20); c.fillStyle = 'rgba(83,224,208,.92)'; c.fill(); rvTxt(c, 'PLAYING', r.x + 91, r.y + 51, 24, '#04202a', 900, 'center'); }
    if (un && sl) { rrect(c, r.x + r.w - 118, r.y + 22, 96, 40, 20); c.fillStyle = 'rgba(255,226,122,.92)'; c.fill(); rvTxt(c, 'LV ' + sl.level, r.x + r.w - 70, r.y + 51, 26, '#2a1400', 900, 'center'); }
  }
  { // detail column
    const id = CLASS_ORDER[CSU.i], d = classDef(id), b = classBars(d), un = classUnlocked(d, RP.unlocked), sig = GEM_BY_ID[d.sig], st = d.star, x0 = 1400, x = x0 + 26, iw = 556; rvPanelBg(c, x0, 130, 608, 1010, 26); let y = 196;
    rvTxt(c, d.name.toUpperCase(), x, y, 60, '#fff4d8', 900, 'left', iw); y += 42; rvTxt(c, d.role.toUpperCase() + (un ? '' : '  ·  LOCKED'), x, y, 28, '#ffd66b', 800); y += 36;
    c.font = '600 28px ' + VFONT; wrapLines(c, d.blurb, iw, _wl); c.fillStyle = '#dfe9f2'; c.textAlign = 'left'; for (let i = 0; i < _wl.length && i < 3; i++) { c.fillText(_wl[i], x, y); y += 34; } y += 8;
    const bars = [['HEALTH', b.hp], ['SPEED', b.speed], ['JUMP', b.jump], ['WEIGHT', b.weight], ['POWER', b.power]];
    for (const q of bars) { rvTxt(c, q[0], x, y, 26, '#a9bccb', 800); rrect(c, x + 150, y - 22, 330, 24, 12); c.fillStyle = 'rgba(255,255,255,.1)'; c.fill(); rrect(c, x + 150, y - 22, Math.max(24, 330 * q[1] / 10), 24, 12); const gg = c.createLinearGradient(x + 150, 0, x + 480, 0); gg.addColorStop(0, '#53e0d0'); gg.addColorStop(1, '#ffe27a'); c.fillStyle = gg; c.fill(); rvTxt(c, String(q[1]), x + iw, y, 26, '#fff', 900, 'right'); y += 36; }
    y += 6; const sec = (h, col, t) => { rvTxt(c, h, x, y, 25, col, 900, 'left', iw); y += 32; c.font = '600 27px ' + VFONT; wrapLines(c, t, iw, _wl); c.fillStyle = '#dfe9f2'; c.textAlign = 'left'; for (let i = 0; i < _wl.length && y < 1000; i++) { c.fillText(_wl[i], x, y); y += 32; } y += 10; };
    sec('PASSIVE  ·  ' + d.passive.name, '#9fd8ff', d.passive.text); sec('SIGNATURE  ·  ' + sig.name, GEM_ELEMS[sig.elem].css, sig.text); sec('STAR POWER  ·  ' + st.name, '#ffd45a', st.text);
    const aff = d.aff ? GEM_ELEMS[d.aff.elem] : null; if (aff && y < 990) sec('AFFINITY', aff.css, aff.name + ' gems +' + d.aff.lv + ' level, +' + Math.round(d.aff.dmg * 100) + '% damage.');
    const cur = id === RP.cls; rvBtn(c, 'cls:go', x, 1006, iw, 70, cur ? 'KEEP ' + d.name.toUpperCase() : un ? 'SWITCH TO ' + d.name.toUpperCase() : 'LOCKED', { primary: un, dim: !un, fs: 38, r: 20 }); rvBtn(c, 'cls:back', x, 1086, iw, 44, 'BACK', { fs: 28, r: 16 });
  }
  rvTxt(c, 'STICK choose   A play   B back   TRIGGER click a card', W / 2, 1196, 38, '#9fd8ff', 700, 'center', W - 80); rvTxt(c, 'Each character plays differently: passive, signature skill, Star Power. Locked ones unlock by playing.', W / 2, 1246, 32, '#6f8aa0', 600, 'center', W - 80);
  p.tex.needsUpdate = true; RV.dirty = false;
}
function gvClsHover(id) { if (id.startsWith('cls:') && id.length === 5 && id.charCodeAt(4) >= 48 && id.charCodeAt(4) <= 57) { const i = +id.slice(4); if (i !== CSU.i && i < CLASS_ORDER.length) { CSU.i = i; CSU.animKind = 0; CSU.animT = 0; RV.dirty = true; } } }
function gvClsClick(id) { if (id === 'cls:back') { closeChars(); return; } if (id === 'cls:go') { clsConfirm(); return; } if (id.startsWith('cls:')) { const i = +id.slice(4); if (i < CLASS_ORDER.length) { CSU.i = i; clsConfirm(); } } }
function gvClsStep(d) { gsfx('gcls'); if (d === 1) clsMove(-1, 0); else if (d === 2) clsMove(1, 0); else if (d === 3) clsMove(0, -1); else clsMove(0, 1); RV.dirty = true; }
function gvClsActions(rdt, L, R) {
  let ax = R.has ? R.ax : 0, ay = R.has ? R.ay : 0; if (L.has && Math.hypot(L.ax, L.ay) > Math.hypot(ax, ay)) { ax = L.ax; ay = L.ay; }
  const on = GV.stickDir ? 0.3 : 0.62; let d = 0; if (Math.abs(ax) > Math.abs(ay)) { if (ax < -on) d = 1; else if (ax > on) d = 2; } else { if (ay < -on) d = 3; else if (ay > on) d = 4; }
  if (!d) GV.stickDir = 0; else if (d !== GV.stickDir) { GV.stickDir = d; GV.stickRep = 0.36; gvClsStep(d); } else { GV.stickRep -= rdt; if (GV.stickRep <= 0) { GV.stickRep = 0.2; gvClsStep(d); } }
  if (R.rise & 4) { GV.eat = true; clsConfirm(); } else if ((R.rise & 8) || (L.rise & 8)) { GV.eat = true; closeChars(); } // GV.eat: the same press must not also confirm the pause panel that comes back
}

// ---- per-frame + debug ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function gvPre(rdt) { GV.eat = false; gvFigTick(rdt); }
function gvDbg() { return { bar: !!GV.bar && GV.bar.mesh.visible && !!GV.bar.mesh.parent && UI.wrP.mesh.visible, barOpacity: GV.bar ? +GV.bar.mat.opacity.toFixed(2) : 0, hot: GV.hot, chord: GV.chord, flickArmed: GV.flick, figs: GV.figs ? GV.figs.length : 0, figVisible: !!GV.figRoot && GV.figRoot.visible && UI.rp.mesh.visible }; }
GV.api = {
  cellPose(i) { // rig-local pose that puts the right controller TIP on cell i (the test drives the emulator with it)
    const m = GV.bar.mesh; m.updateWorldMatrix(true, false); const x = ((GV_BAR.x0 + i * GV_BAR.pitch + GV_BAR.cell / 2) / GV_BAR.pw - 0.5) * GV_BAR.w, y = (0.5 - (GV_BAR.y0 + GV_BAR.cell / 2) / GV_BAR.ph) * GV_BAR.h;
    _gvP.set(x, y, 0).applyMatrix4(m.matrixWorld); _gvQ.set(x, y, 1).applyMatrix4(m.matrixWorld); rig.worldToLocal(_gvP); rig.worldToLocal(_gvQ); _gvQ.sub(_gvP).normalize(); return { pos: [_gvP.x, _gvP.y, _gvP.z], n: [_gvQ.x, _gvQ.y, _gvQ.z] };
  },
  barPng() { return GV.bar.cv.toDataURL('image/png'); }, state: gvDbg, figs() { return GV.figs ? GV.figs.map(h => ({ x: h.position.x, y: h.position.y, rot: h.userData.g.rotation.y, scale: h.scale.x, parts: h.userData.g.children.length })) : []; },
  rpCard(i) { const r = gvCardRect(i); return { x: r.x, y: r.y, w: r.w, h: r.h }; },
};
const _vrDrawRp = vrDrawRp; vrDrawRp = function () { if (UI.mode === 'cls') { gvDrawCls(); return; } _vrDrawRp(); };
const _vrUiOpen = vrUiOpen; vrUiOpen = function (mode) { _vrUiOpen(mode); if (mode === 'cls') vrClsOpen(); else if (GV.figOn) vrClsClose(); };
// </vr-gem>

