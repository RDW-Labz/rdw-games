// ---- canvas panels -----------------------------------------------------------------------------------------------------------------------
const VFONT = '"Trebuchet MS","Segoe UI",system-ui,sans-serif';
function rrect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
function vrPanel(wm, hm, pw, ph, mips) {
  const cv = document.createElement('canvas'); cv.width = pw; cv.height = ph; const ctx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; if (!mips) { tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter; }
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(wm, hm), mat); mesh.renderOrder = 1000; mesh.frustumCulled = false; mesh.visible = false;
  return { cv, ctx, tex, mat, mesh, wm, hm, pw, ph, cx: 0, cy: 0, cz: -1, nx: 0, ny: 0, nz: 1, rx: 1, rz: 0 };
}
function vrPlacePanel(p, x, y, z, hx, hz) { // face the head (yaw only, always upright); store the plane basis for the analytic ray test
  p.cx = x; p.cy = y; p.cz = z; const a = Math.atan2(hx - x, hz - z); p.mesh.position.set(x, y, z); p.mesh.rotation.set(0, a, 0);
  p.nx = Math.sin(a); p.nz = Math.cos(a); p.ny = 0; p.rx = Math.cos(a); p.rz = -Math.sin(a);
}
function vrHitPanel(p, ox, oy, oz, dx, dy, dz, out) { // ray (rig-local) vs panel -> out.u/v in canvas px, out.t in real metres
  const dn = dx * p.nx + dy * p.ny + dz * p.nz; if (dn > -0.02) return false;
  const t = ((p.cx - ox) * p.nx + (p.cy - oy) * p.ny + (p.cz - oz) * p.nz) / dn; if (t < 0.03 || t > 6) return false;
  const px = ox + dx * t - p.cx, py = oy + dy * t - p.cy, pz = oz + dz * t - p.cz;
  const u = (px * p.rx + pz * p.rz) / p.wm + 0.5, v = py / p.hm + 0.5; if (u < 0 || u > 1 || v < 0 || v > 1) return false;
  out.u = u * p.pw; out.v = (1 - v) * p.ph; out.t = t; return true;
}
const _hit = { u: 0, v: 0, t: 0 };
function wrapLines(c, text, maxW, out) { out.length = 0; const words = String(text).split(/\s+/); let line = ''; for (const w of words) { const t = line ? line + ' ' + w : w; if (c.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; } if (line) out.push(line); return out; }
const _wl = [];

function vrRpgSubLines() { // two short RPG status lines for the start panel (mirrors #rpgMenuSub)
  const cap = RP.level >= RPG_TUNING.levelCap;
  return ['LEVEL ' + RP.level + (cap ? ' MAX' : ' \u00b7 ' + rfmt(RP.xp) + ' / ' + rfmt(rpgXpNext(RP.level)) + ' XP') + ' \u00b7 ' + rfmt(RP.gold) + ' GOLD', Object.keys(RP.codex).length + '/' + RPG_LEGENDARIES.length + ' LEGENDARIES' + (RP.bestRift ? ' \u00b7 BEST RIFT T' + RP.bestRift : '') + (RP.pending ? ' \u00b7 PERK READY' : '')];
}
function vrDrawMain() {
  const p = UI.main, c = p.ctx, W = p.pw, H = p.ph, m = UI.mode; c.clearRect(0, 0, W, H);
  const FH = Math.min(H - 16, Math.max(520, UI.contentH + 20)); rrect(c, 8, 8, W - 16, FH, 46); const gr = c.createLinearGradient(0, 0, 0, FH); gr.addColorStop(0, 'rgba(12,30,48,.95)'); gr.addColorStop(1, 'rgba(6,14,24,.95)'); c.fillStyle = gr; c.fill();
  c.lineWidth = 6; c.strokeStyle = m === 'lose' ? 'rgba(255,143,122,.9)' : 'rgba(255,214,107,.9)'; c.stroke();
  c.textAlign = 'center'; c.textBaseline = 'alphabetic';
  let title = 'SHATTERWORLD', sub = '', sub2 = '', col = '#ffd66b';
  if (m === 'start') { sub = 'A REALISTIC WORLD. SHATTERED INTO BLOCKS.'; sub2 = $('best').textContent; }
  else if (m === 'pause') { title = 'PAUSED'; sub = 'Y tap resumes \u00b7 Y hold = inventory'; }
  else { title = $('deadT').textContent; col = m === 'lose' ? '#ff8f7a' : '#ffd66b'; sub = ($('deadS').innerHTML || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''); }
  c.fillStyle = col; c.font = '900 ' + (title.length > 12 ? 78 : 92) + 'px ' + VFONT; c.shadowColor = 'rgba(0,0,0,.6)'; c.shadowBlur = 12; c.fillText(title, W / 2, 128); c.shadowBlur = 0;
  c.fillStyle = '#ffe9b8'; c.font = '600 36px ' + VFONT;
  const sl = sub.split('\n'); let y = 190; for (const s of sl) { c.fillText(s, W / 2, y); y += 44; }
  if (sub2) { c.fillStyle = '#53e0d0'; c.font = '700 34px ' + VFONT; c.fillText(sub2, W / 2, y + 4); y += 44; }
  if (m === 'start') { const L = vrRpgSubLines(); c.fillStyle = RP.pending ? '#ffe27a' : '#9fd8ff'; c.font = '700 32px ' + VFONT; for (const t of L) { c.fillText(t, W / 2, y + 4); y += 40; } }
  if (UI.chips.length) { // run summary chips (#rpgRunSum): xp / kills / loot by rarity / gold / legendaries
    for (const q of UI.chips) { rrect(c, q.x, q.y, q.w, 52, 26); c.fillStyle = 'rgba(255,255,255,.08)'; c.fill(); c.lineWidth = 3; c.strokeStyle = q.cls === 'r3' ? 'rgba(255,138,42,.9)' : q.cls === 'r2' ? 'rgba(255,216,74,.7)' : q.cls === 'r1' ? 'rgba(106,169,255,.7)' : 'rgba(255,255,255,.25)'; c.stroke(); c.fillStyle = q.cls === 'r3' ? '#ffb06a' : q.cls === 'r2' ? '#ffe27a' : q.cls === 'r1' ? '#a9ccff' : '#fff0cc'; c.font = '700 32px ' + VFONT; c.textBaseline = 'middle'; c.fillText(q.t, q.x + q.w / 2, q.y + 28); c.textBaseline = 'alphabetic'; }
  }
  for (let i = 0; i < UI.btns.length; i++) {
    const b = UI.btns[i], hot = !b.static && (UI.hot[0] === i || UI.hot[1] === i); rrect(c, b.x, b.y, b.w, b.h, b.h / 2);
    const g2 = c.createLinearGradient(0, b.y, 0, b.y + b.h);
    if (b.primary) { g2.addColorStop(0, hot ? '#fff9d0' : '#fff2b0'); g2.addColorStop(0.55, hot ? '#ffd45f' : '#ffc54a'); g2.addColorStop(1, hot ? '#ffa43a' : '#ff9c2b'); } else if (b.static) { g2.addColorStop(0, 'rgba(255,255,255,.05)'); g2.addColorStop(1, 'rgba(255,255,255,.02)'); } else { g2.addColorStop(0, hot ? 'rgba(120,200,255,.55)' : 'rgba(255,255,255,.14)'); g2.addColorStop(1, hot ? 'rgba(60,140,220,.55)' : 'rgba(255,255,255,.06)'); }
    c.fillStyle = g2; c.fill(); c.lineWidth = hot ? 6 : 3; c.strokeStyle = hot ? '#ffffff' : (b.primary ? 'rgba(255,235,170,.6)' : 'rgba(255,255,255,.4)'); c.stroke();
    const lab = b.label(); let fs = b.primary ? 54 : 36; c.font = (b.primary ? '900 ' : '800 ') + fs + 'px ' + VFONT; while (c.measureText(lab).width > b.w - 28 && fs > 26) { fs -= 2; c.font = (b.primary ? '900 ' : '800 ') + fs + 'px ' + VFONT; }
    c.fillStyle = b.primary ? '#2a1400' : b.id === 'rtl' ? '#ffe27a' : b.static ? 'rgba(234,246,255,.55)' : '#eaf6ff'; c.textBaseline = 'middle'; c.fillText(lab, b.x + b.w / 2, b.y + b.h / 2 + 2); c.textBaseline = 'alphabetic';
  }
  p.tex.needsUpdate = true;
}
function vrBuildButtons(mode) {
  const W = UI.main.pw, B = UI.btns, ctx = UI.main.ctx; B.length = 0; UI.chips.length = 0;
  const sizeL = () => 'SIZE: ' + ['S', 'M', 'L'][vrCfg.size], turnL = () => 'TURN: ' + (vrCfg.snap ? 'SNAP 30\u00b0' : 'SMOOTH'), gfxL = () => 'GFX: ' + (vrCfg.q === 'vr' ? 'VR' : 'LITE'), diffL = () => 'DIFFICULTY: ' + RPG_TUNING.difficulty[RP.diff].name, tierL = () => 'RIFT TIER ' + RP.riftTier;
  let rows, y = 300; const ul = RP.riftUnlocked;
  if (mode === 'start') { y = 372; rows = [[['cta', () => 'BEGIN', 1]], [['diff', diffL], ['inv', () => 'INVENTORY']], ul ? [['rtm', () => '-', 0, 1], ['rtl', tierL, 0, 3, 1], ['rtp', () => '+', 0, 1], ['rift', () => 'SHATTER RIFT', 0, 4]] : [['rtl', () => 'SHATTER RIFTS UNLOCK AFTER THE FINALE', 0, 1, 1]], [['size', sizeL], ['turn', turnL], ['qual', gfxL]], [['cls', () => 'CHARACTER: ' + classDef(RP.cls).name.toUpperCase()], ['town', () => 'HOME TOWN'], ['exit', () => 'EXIT VR']]]; }
  else if (mode === 'pause') rows = [[['resume', () => 'RESUME', 1]], [['cls', () => 'CHARACTER'], ['inv', () => 'INVENTORY'], ['menu', () => 'MAIN MENU'], ['exit', () => 'EXIT VR']], [['size', sizeL], ['turn', turnL], ['qual', gfxL], ['town', () => TW.on ? 'THE GATE' : 'HOME TOWN']]];
  else {
    const lines = (($('deadS').innerHTML || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).split('\n').length; y = 190 + lines * 44 + 12;
    const sum = $('rpgRunSum'); if (sum && sum.children.length) { ctx.font = '700 32px ' + VFONT; let x = 48, ry = y; for (const el of sum.children) { const w = Math.ceil(ctx.measureText(el.textContent).width) + 40; if (x + w > W - 48 && x > 48) { x = 48; ry += 64; } UI.chips.push({ t: el.textContent, cls: el.className, x, y: ry, w }); x += w + 12; } y = ry + 52 + 26; const rowW = {}; for (const q of UI.chips) rowW[q.y] = (rowW[q.y] || 48) + q.w + 12; for (const q of UI.chips) { const tot = rowW[q.y] - 12 - 48, off = (W - 96 - tot) / 2; q.x += off; } }
    const ex = [['inv', () => 'INVENTORY']]; if (RIFT) ex.push(['seed', () => 'NEW SEED']); else if (G.won && RP.riftUnlocked) ex.push(['rift', () => 'SHATTER RIFT']); ex.push(['town', () => 'HOME TOWN']); ex.push(['menu', () => 'MAIN MENU']);
    rows = [[['cta2', () => $('cta2').textContent || 'RETRY', 1]], ex, [['exit', () => 'EXIT VR']]];
  }
  const m = 48; UI.sumBottom = y;
  rows.forEach((row, ri) => { const h = ri === 0 ? 112 : 84, n = row.length, gap = 22; let tw = 0; for (const r of row) tw += r[3] || 1; const aw = W - 2 * m - gap * (n - 1); let x = m; row.forEach(r => { const w = aw * (r[3] || 1) / tw; B.push({ id: r[0], label: r[1], primary: !!r[2], static: !!r[4], x, y, w, h }); x += w + gap; }); y += h + 22; }); UI.contentH = y;
}
function vrDrawHow() {
  const p = UI.how, c = p.ctx, W = p.pw, H = p.ph; c.clearRect(0, 0, W, H);
  rrect(c, 8, 8, W - 16, H - 16, 42); c.fillStyle = 'rgba(8,22,34,.93)'; c.fill(); c.lineWidth = 6; c.strokeStyle = 'rgba(83,224,208,.9)'; c.stroke();
  c.textBaseline = 'alphabetic'; c.textAlign = 'center'; c.fillStyle = '#53e0d0'; c.font = '900 52px ' + VFONT; c.fillText('TOUCH CONTROLS', W / 2, 84);
  const rows = [['LEFT STICK', 'move (relative to your head)'], ['RIGHT STICK', 'turn the table 30\u00b0 (flick)'], ['A', 'jump - chain 3 for a triple'], ['B', 'crouch / ground-pound in air'], ['TRIGGER', 'punch / dive in air'], ['GRIP (hold)', 'REWIND shattered blocks'], ['X  tap / hold', 'table size / recentre'], ['Y  tap', 'pause menu'], ['Y  HOLD', 'inventory, perks, character'], ['L-STICK CLICK', 'sprint'], ['R-STICK CLICK', 'talk / flip pad']];
  let y = 150; c.textAlign = 'left';
  for (const r of rows) { c.fillStyle = r[0] === 'Y  HOLD' ? '#ffe27a' : '#ffd66b'; c.font = '800 34px ' + VFONT; c.fillText(r[0], 44, y); c.fillStyle = r[0] === 'Y  HOLD' ? '#fff4c8' : '#eaf6ff'; c.font = '600 34px ' + VFONT; c.fillText(r[1], 330, y); y += 50; }
  c.fillStyle = '#ffb15e'; c.font = '800 32px ' + VFONT; c.fillText('IN THE INVENTORY / PERK PICK', 44, y + 18); y += 62;
  c.font = '600 31px ' + VFONT; c.fillStyle = '#eaf6ff'; for (const t of ['Sticks move the cursor (no turning). A equip / pick.', 'B back. X salvage (twice). Y lock. Y hold = close.', 'Grips switch tab. Trigger clicks what the laser points at.']) { c.fillText(t, 44, y); y += 40; }
  c.textAlign = 'center'; c.fillStyle = '#9fd8ff'; c.font = '600 30px ' + VFONT; c.fillText('Bluetooth pad: same as flat play', W / 2, H - 34);
  p.tex.needsUpdate = true;
}
function vrDrawCaption() {
  const p = UI.capP, c = p.ctx, W = p.pw, H = p.ph, k = UI.cap; c.clearRect(0, 0, W, H); c.textAlign = 'center'; c.textBaseline = 'alphabetic';
  if (k.talkOn) {
    rrect(c, 8, 8, W - 16, H - 16, 36); const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, 'rgba(14,40,32,.93)'); g.addColorStop(1, 'rgba(8,24,22,.93)'); c.fillStyle = g; c.fill(); c.lineWidth = 5; c.strokeStyle = '#7be08a'; c.stroke();
    c.textAlign = 'left'; c.fillStyle = '#9cf0a0'; c.font = '800 32px ' + VFONT; c.fillText(k.who, 40, 62); c.fillStyle = '#f4fff4'; c.font = '600 38px ' + VFONT; wrapLines(c, k.talk, W - 80, _wl); let y = 114; for (let i = 0; i < _wl.length && i < 4; i++) { c.fillText(_wl[i], 40, y); y += 48; }
  } else {
    let y = H - 20;
    if (k.promptOn) { c.font = '700 38px ' + VFONT; const w = c.measureText(k.prompt).width + 60; rrect(c, W / 2 - w / 2, y - 60, w, 70, 20); c.fillStyle = 'rgba(10,22,34,.9)'; c.fill(); c.lineWidth = 3; c.strokeStyle = 'rgba(255,255,255,.4)'; c.stroke(); c.fillStyle = '#fff4d8'; c.fillText(k.prompt, W / 2, y - 12); y -= 84; }
    if (k.toastOn) { c.font = '700 42px ' + VFONT; const w = Math.min(W - 20, c.measureText(k.toast).width + 80); rrect(c, W / 2 - w / 2, y - 66, w, 76, 38); c.fillStyle = 'rgba(10,22,34,.9)'; c.fill(); c.lineWidth = 3; c.strokeStyle = 'rgba(255,230,160,.6)'; c.stroke(); c.fillStyle = '#fff4d8'; c.fillText(k.toast, W / 2, y - 12); }
  }
  p.tex.needsUpdate = true;
}
function vrDrawWrist() {
  const p = UI.wrP, c = p.ctx, W = p.pw, H = p.ph; c.clearRect(0, 0, W, H);
  rrect(c, 8, 8, W - 16, H - 16, 52); const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, 'rgba(10,26,42,.94)'); g.addColorStop(1, 'rgba(6,14,24,.94)'); c.fillStyle = g; c.fill(); c.lineWidth = 6; c.strokeStyle = 'rgba(83,224,208,.9)'; c.stroke();
  c.textBaseline = 'alphabetic'; c.textAlign = 'left'; c.fillStyle = '#ffd66b'; c.font = '800 40px ' + VFONT; c.fillText(RIFT ? 'RIFT TIER ' + RIFT.tier : TW.on ? 'HOME TOWN' : (ACT_NAMES[G.act] || ''), 44, 78);
  const cap = RP.level >= RPG_TUNING.levelCap; c.textAlign = 'right'; c.fillStyle = '#ffe27a'; c.font = '900 46px ' + VFONT; c.fillText('LV ' + RP.level + (cap ? ' MAX' : ''), W - 44, 78);
  // hp bar (+ shield sliver)
  const hf = clamp(RT.hp / RT.max, 0, 1); rrect(c, 40, 100, W - 80, 86, 24); c.fillStyle = 'rgba(255,255,255,.1)'; c.fill();
  if (hf > 0.01) { rrect(c, 40, 100, Math.max(40, (W - 80) * hf), 86, 24); const hg = c.createLinearGradient(0, 100, 0, 186); const hc = hf > 0.5 ? ['#7cf08a', '#2faa4a'] : hf > 0.25 ? ['#ffe27a', '#d9a21a'] : ['#ff8f7a', '#d93a2a']; hg.addColorStop(0, hc[0]); hg.addColorStop(1, hc[1]); c.fillStyle = hg; c.fill(); }
  if (RT.shield > 0.5) { rrect(c, 40, 176, Math.max(20, (W - 80) * clamp(RT.shield / RT.max, 0, 1)), 14, 7); c.fillStyle = '#9fd0ff'; c.fill(); }
  c.textAlign = 'center'; c.fillStyle = '#fff'; c.font = '900 56px ' + VFONT; c.lineWidth = 7; c.strokeStyle = 'rgba(0,0,0,.55)'; const ht = Math.ceil(RT.hp) + ' / ' + RT.max + (RT.shield > 0.5 ? '  +' + Math.round(RT.shield) : ''); c.strokeText(ht, W / 2, 162); c.fillText(ht, W / 2, 162);
  // xp bar
  const xf = cap ? 1 : clamp(RP.xp / rpgXpNext(RP.level), 0, 1); rrect(c, 40, 206, W - 80, 40, 20); c.fillStyle = 'rgba(255,255,255,.1)'; c.fill(); if (xf > 0.01) { rrect(c, 40, 206, Math.max(40, (W - 80) * xf), 40, 20); c.fillStyle = '#53c8e0'; c.fill(); }
  c.fillStyle = '#04202a'; c.font = '800 30px ' + VFONT; c.fillText('XP ' + Math.floor(xf * 100) + '%', W / 2, 236);
  // rewind pips + gold
  c.textAlign = 'left'; c.fillStyle = '#9fb4c8'; c.font = '700 30px ' + VFONT; c.fillText('REWIND', 44, 312); const nrw = Math.ceil(RT.rwMax); for (let i = 0; i < nrw; i++) { const x = 200 + i * 66; rrect(c, x, 280, 56, 44, 12); c.fillStyle = 'rgba(255,255,255,.12)'; c.fill(); const f = clamp(RT.rw - i, 0, 1); if (f > 0.02) { rrect(c, x, 280, Math.max(14, 56 * f), 44, 12); c.fillStyle = '#53e0d0'; c.fill(); } }
  c.textAlign = 'right'; c.fillStyle = '#fff4d8'; c.font = '900 58px ' + VFONT; const gw = c.measureText(rfmt(RP.gold)).width; c.fillText(rfmt(RP.gold), W - 44, 324); rvCoin(c, W - 44 - gw - 34, 304, 28);
  // buff chips
  let bx = 44; const chip = (t, col) => { c.font = '800 30px ' + VFONT; const w = c.measureText(t).width + 30; if (bx + w > W - 40) return; rrect(c, bx, 346, w, 46, 23); c.fillStyle = col; c.fill(); c.fillStyle = '#10202e'; c.textAlign = 'left'; c.fillText(t, bx + 15, 380); bx += w + 10; };
  if (RT.chill > 0.05) chip('CHILLED', '#9cf3ff'); if (RT.goldStack) chip('GOLD RUSH x' + RT.goldStack, '#ffd24a'); if (RT.surgeT > 0) chip('STAR SURGE', '#ffe27a'); if (RT.S.fx.comboFiend && RT.combo > 1) chip('COMBO x' + Math.min(5, RT.combo), '#ff9a7a'); if (RT.shield > 0.5) chip('SHIELD', '#9fd0ff'); if (P.big) chip('SUPER', '#ff8f7a'); fdVrChips(chip);
  if (RIFT) { c.textAlign = 'left'; c.fillStyle = '#ffb15e'; c.font = '800 30px ' + VFONT; c.fillText(RIFT.mods.map(m => RPG_RIFT_MODS[m].name.toUpperCase()).join('  \u00b7  '), 44, 436); }
  // shards
  const n = ACT_SHARDS[G.act] || 0; if (!RIFT && !TW.on) for (let i = 0; i < n; i++) { const x = 70 + i * (n > 4 ? 84 : 98), y = 440, on = i < G.shards; c.save(); c.translate(x, y); c.rotate(PI / 4); rrect(c, -24, -24, 48, 48, 6); c.fillStyle = on ? '#ffc54a' : 'rgba(255,255,255,.12)'; c.fill(); c.lineWidth = 4; c.strokeStyle = on ? '#fff2b8' : 'rgba(255,230,160,.5)'; c.stroke(); c.restore(); }
  c.textAlign = 'left'; c.fillStyle = '#9fb4c8'; c.font = '700 30px ' + VFONT; c.fillText('TIME', 44, 520); c.fillText('SCORE', 470, 520);
  c.fillStyle = '#fff4d8'; c.font = '900 72px ' + VFONT; c.fillText(fmtTime(G.t), 44, 590); c.fillText(String(G.score), 470, 590);
  if (RIFT) { const left = Math.max(0, RIFT.limit - RIFT.t), pr = RIFT.phase === 'fight' ? RIFT.prog / RIFT.need : 1; c.fillStyle = left < 30 ? '#ff8f7a' : '#53e0d0'; c.font = '900 56px ' + VFONT; c.fillText(fmtTime(left), 44, 676); rrect(c, 260, 640, W - 300, 36, 18); c.fillStyle = 'rgba(255,255,255,.12)'; c.fill(); if (pr > 0.01) { rrect(c, 260, 640, Math.max(36, (W - 300) * clamp(pr, 0, 1)), 36, 18); c.fillStyle = RIFT.phase === 'fight' ? '#53e0d0' : '#ffb15e'; c.fill(); } c.fillStyle = '#cfe0ee'; c.font = '700 32px ' + VFONT; c.fillText(RIFT.phase === 'fight' ? Math.floor(pr * 100) + '% to the guardian' : RIFT.phase === 'guardian' ? 'GUARDIAN' : 'CLEARED', 260, 722); }
  else { c.fillStyle = '#53e0d0'; c.font = '800 42px ' + VFONT; c.fillText(G.nsd >= 0 ? 'NEXT SHARD  ' + G.nsd + ' m' : (G.shardsTotal > 0 && G.shards >= G.shardsTotal ? 'ALL SHARDS FOUND' : ''), 44, 700); }
  p.tex.needsUpdate = true;
}
function vrWristSig() { // redraw the wrist panel only when something it shows changed (allocation-free: numbers only)
  const w = RV.ws, hp = RT.hp | 0, mx = RT.max | 0, sh = RT.shield | 0, t = G.t | 0, cap = RP.level >= RPG_TUNING.levelCap, xp = cap ? 100 : ((RP.xp / rpgXpNext(RP.level)) * 100) | 0, rw = (RT.rw * 4) | 0, rwm = RT.rwMax | 0;
  const buf = (RT.chill > 0.05 ? 1 : 0) | (RT.shield > 0.5 ? 2 : 0) | (P.big ? 4 : 0) | (RT.surgeT > 0 ? 8 : 0) | (Math.min(10, RT.goldStack) << 4) | ((RT.S.fx.comboFiend && RT.combo > 1 ? Math.min(5, RT.combo) : 0) << 8);
  const rl = RIFT ? Math.max(0, RIFT.limit - RIFT.t) | 0 : -1, rp = RIFT ? (RIFT.phase === 'fight' ? Math.min(100, (RIFT.prog / RIFT.need * 100) | 0) : 101 + (RIFT.phase === 'guardian' ? 0 : 1)) : -1;
  if (w.hp !== hp || w.mx !== mx || w.sh !== sh || w.xp !== xp || w.lv !== RP.level || w.rw !== rw || w.rwm !== rwm || w.gold !== RP.gold || w.buf !== buf || w.rl !== rl || w.rp !== rp || w.big !== G.act || w.t !== t || w.coins !== G.coins || w.shards !== G.shards || w.score !== G.score || w.nsd !== G.nsd) {
    w.hp = hp; w.mx = mx; w.sh = sh; w.xp = xp; w.lv = RP.level; w.rw = rw; w.rwm = rwm; w.gold = RP.gold; w.buf = buf; w.rl = rl; w.rp = rp; w.big = G.act; w.t = t; w.coins = G.coins; w.shards = G.shards; w.score = G.score; w.nsd = G.nsd; return true;
  }
  return false;
}

