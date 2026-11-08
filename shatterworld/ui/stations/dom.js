// <sui-ui> ======================================================================================================================
// SHATTERWORLD station UI, part 2 of 2: the flat DOM overlay (#sta), the world-space VR panel, and all input routing (keyboard, mouse, touch, Xbox / PlayStation pad, phone pad, Touch controllers + laser).
// Both renderers draw the one view-model from sui-model.js. State is G.state === 'sta' (the world is paused, exactly like the inventory).
// Keys (the same ones the inventory uses, so every pad already works): arrows / stick = move,  LB RB (Q / Shift) = tabs,  A (Space) = primary,  X (J) = second,  Y (E) = third,  B (Z / Esc) = close.
// ==============================================================================================================================
(() => {
  const st = document.createElement('style'); st.textContent = `
  #sta { background:radial-gradient(ellipse at 50% 40%, rgba(12,26,40,.82), rgba(4,8,14,.95)); font-size:var(--fs); z-index:11; }
  #sta.hidden { display:none !important; }
  .stWrap { width:min(1200px,98vw); height:min(690px,96vh); display:flex; flex-direction:column; gap:clamp(5px,1.2vh,12px); text-align:left; }
  #stTitle { font-weight:900; letter-spacing:.2em; font-size:1.25em; white-space:nowrap; text-shadow:0 0 18px currentColor; display:flex; flex-direction:column; line-height:1.1; }
  #stTitle small { font-size:.52em; letter-spacing:.16em; color:#a9bccb; font-weight:700; text-shadow:none; }
  #stTabs { display:flex; gap:6px; flex:1; flex-wrap:wrap; }
  #stTabs button { font:inherit; font-weight:800; letter-spacing:.14em; font-size:.84em; cursor:pointer; color:#cfe0ec; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.22); border-radius:999px; padding:.4em 1.05em; min-height:34px; }
  #stTabs button.on { color:#2a1400; background:linear-gradient(180deg,#fff2b0,#ffc54a 55%,#ff9c2b); border-color:#ffe9a8; box-shadow:0 0 14px rgba(255,190,80,.5); }
  .stBody { flex:1; min-height:0; display:flex; gap:clamp(6px,1.4vh,14px); }
  .stList { flex:0 0 38%; min-width:0; overflow:hidden auto; display:flex; flex-direction:column; gap:5px; }
  .stInfo { flex:1; min-width:0; overflow:hidden auto; display:flex; flex-direction:column; gap:.15em; }
  .stRow { display:flex; align-items:center; gap:.7em; padding:.35em .6em; border-radius:12px; background:rgba(255,255,255,.05); border:2px solid transparent; cursor:pointer; min-height:52px; flex:none; }
  .stRow.focus { border-color:#fff2b0; box-shadow:0 0 16px rgba(255,214,107,.7); background:rgba(255,255,255,.1); }
  .stRow.lock { opacity:.55; } .stRow.no .stR { color:#ff9a8a; } .stRow.ok .stR { color:#9cf7ab; }
  .stRow .stIc, .stCost .stIc, .stH .stIc { width:40px; height:40px; flex:none; border-radius:9px; background:rgba(255,255,255,.07); }
  .stRow .stT { flex:1; min-width:0; display:flex; flex-direction:column; line-height:1.2; } .stRow .stT b { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:.98em; letter-spacing:.02em; } .stRow .stT small { color:#a9bccb; font-weight:600; font-size:.74em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; letter-spacing:.06em; }
  .stRow .stR { font-weight:900; font-size:.8em; letter-spacing:.06em; white-space:nowrap; } .stRow .stG { width:40px; height:40px; flex:none; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:900; color:#0b1722; }
  .stH { font-weight:900; font-size:1.2em; letter-spacing:.06em; display:flex; align-items:center; gap:.6em; line-height:1.15; margin:.05em 0 .2em; } .stH.small { font-size:.8em; letter-spacing:.24em; }
  .stP { margin:.1em 0; color:#cfe0ec; font-weight:600; line-height:1.4; font-size:.92em; } .stP.dim { color:#8195a6; font-size:.82em; }
  .stSay { margin:.4em 0; padding:.7em .9em; border-radius:14px; background:rgba(255,255,255,.07); border-left:4px solid currentColor; font-size:1.2em; font-weight:700; line-height:1.45; color:#fff4d8; }
  .stSp { height:.45em; flex:none; }
  .stCost { display:flex; align-items:center; gap:.6em; padding:.12em 0; font-weight:700; font-size:.9em; } .stCost span { flex:1; } .stCost b { font-weight:800; } .stCost.ok b { color:#9cf7ab; } .stCost.no b { color:#ff9a8a; } .stCost i { font-style:normal; font-weight:900; width:1.2em; text-align:center; } .stCost.ok i { color:#9cf7ab; } .stCost.no i { color:#ff8f7a; }
  .stInfo .tipRow { justify-content:space-between; } .stInfo .tipRow span:first-child { color:#a9bccb; font-weight:700; } .stInfo .tipRow .rg { color:#e8f2fa; font-weight:700; margin-left:1em; text-align:right; white-space:normal; }
  .stInfo .tipRow.aff { cursor:pointer; gap:.6em; justify-content:flex-start; border-radius:8px; padding:.2em .3em; } .stInfo .tipRow.aff span:first-child { color:#fff; } .stInfo .tipRow.aff .rg { margin-left:auto; color:#7c8e9d; }
  .stLeg { margin:.4em 0; padding:.45em .7em; border-radius:10px; background:linear-gradient(180deg,rgba(255,138,42,.2),rgba(255,138,42,.06)); border:1px solid rgba(255,138,42,.55); color:#ffd2a6; font-weight:700; line-height:1.35; font-size:.86em; } .stLeg b { color:var(--r3); letter-spacing:.14em; display:block; font-size:.9em; }
  .stActs { margin-top:auto; padding-top:.6em; display:flex; flex-wrap:wrap; gap:8px; } .stActs button { font:inherit; font-weight:800; font-size:.86em; letter-spacing:.1em; cursor:pointer; color:#eaf6ff; background:rgba(255,255,255,.09); border:1.5px solid rgba(255,255,255,.28); border-radius:999px; padding:.5em 1.2em; min-height:42px; } .stActs button.go { color:#2a1400; background:linear-gradient(180deg,#fff2b0,#ffc54a 55%,#ff9c2b); border-color:#ffe9a8; } .stActs button:disabled, .stActs button.off { opacity:.4; }
  #stMsg { min-height:1.6em; text-align:center; font-weight:800; letter-spacing:.06em; font-size:.92em; color:#9cf7ab; } #stMsg.bad { color:#ff9a8a; } #stEmpty { margin:auto; text-align:center; color:#8195a6; letter-spacing:.12em; font-weight:700; line-height:1.8; padding:1em; }
  @media (max-width:760px) { .stBody { flex-direction:column; } .stList { flex:0 0 36%; } .stWrap { height:98vh; } #stTitle { font-size:1em; } #stTabs button { padding:.35em .7em; font-size:.76em; } .stRow { min-height:46px; } }
  @media (max-height:520px) { .stWrap { height:98vh; } .stRow { min-height:40px; padding:.2em .5em; } .stRow .stIc { width:30px; height:30px; } #stTabs button { min-height:28px; padding:.2em .8em; } .stP { font-size:.82em; } .invFoot { display:none; } }`;
  document.head.appendChild(st);
  document.body.insertAdjacentHTML('beforeend', '<div id="sta" class="ovl hidden"><div class="invWrap stWrap"><div class="invHead"><div id="stTitle"></div><div id="stTabs"></div><div class="invRes" id="stRes"></div><button class="chip" id="stClose" data-id="close" style="min-height:34px;min-width:42px">X</button></div><div class="invBody stBody"><div class="pnl stList" id="stList"></div><div class="pnl stInfo" id="stInfo"></div></div><div id="stMsg"></div><div class="invFoot" id="stFoot"></div></div></div>');
})();
const stEl = { title: $('stTitle'), tabs: $('stTabs'), res: $('stRes'), list: $('stList'), info: $('stInfo'), msg: $('stMsg'), foot: $('stFoot'), root: $('sta') };
const SUI_KK = { A: 'a', B: 'b', X: 'x', Y: 'y', 'LB RB': 't' };
function suiIconOf(spec) { // spec = [kind, id] | gem id string | function -> canvas
  if (!spec) return null; if (typeof spec === 'function') return spec(); if (Array.isArray(spec)) return fdIcon(spec[0], spec[1]); return null;
}
function suiGlyphHTML(name, col) { const ch = { scroll: '!', rift: '*', gate: '>', hall: 'H', market: '$', kitchen: 'K', smithy: 'S', gems: 'G', apothecary: 'A', warehouse: 'W', garden: 'g', board: 'N' }[name] || '?'; return `<div class="stG" style="background:${col}">${ch}</div>`; }
function suiRender() {
  if (!SUI.open) return; const M = SUI.M = suiModel(); SUI.dirty = false; SUI.icons.length = 0; const nrows = M.rows.length; SUI.row = nrows ? clamp(SUI.row, 0, nrows - 1) : 0;
  const ic = (spec, extra) => { const c = suiIconOf(spec); if (!c) return ''; SUI.icons.push(c); return `<canvas class="stIc${extra ? ' ' + extra : ''}" width="48" height="48" data-ic="${SUI.icons.length - 1}"></canvas>`; };
  stEl.title.style.color = M.col; stEl.title.innerHTML = esc(M.title) + (M.sub ? `<small>${esc(M.sub)}</small>` : '');
  stEl.tabs.innerHTML = M.tabs.map((t, i) => `<button data-id="tab:${i}" class="${i === SUI.tab ? 'on' : ''}">${esc(t)}</button>`).join('');
  stEl.res.innerHTML = `<span class="lv">${esc(classDef(RP.cls).name.toUpperCase())} ${RP.level}</span><span class="gold"><i></i>${rfmt(RP.gold)}</span><span class="dust"><i></i>${rfmt(RP.dust)}</span>`;
  const keepScroll = stEl.list.scrollTop, keepInfo = stEl.info.scrollTop;
  stEl.list.style.display = M.dlg ? 'none' : '';
  stEl.list.innerHTML = nrows ? M.rows.map((r, i) => `<div class="stRow ${r.st || ''}${i === SUI.row ? ' focus' : ''}" data-id="row:${i}">${r.ic ? ic(r.ic) : r.glyph ? suiGlyphHTML(r.glyph, r.col || '#fff') : ''}<div class="stT"><b style="color:${r.col || '#fff'}">${esc(r.name)}</b><small>${esc(r.sub || '')}</small></div>${r.right ? `<span class="stR">${esc(r.right)}</span>` : ''}</div>`).join('') : `<div id="stEmpty">${esc(M.empty || '')}</div>`;
  let h = ''; for (const l of M.info) {
    if (l.t === 'h') h += `<div class="stH${l.small ? ' small' : ''}" style="color:${l.col || '#fff'}">${l.ic ? ic(l.ic) : l.gem ? ic(() => gemIconBase(l.gem)) : ''}<span>${esc(l.a)}</span></div>`;
    else if (l.t === 'p') h += `<p class="stP${l.dim ? ' dim' : ''}">${esc(l.a)}</p>`;
    else if (l.t === 'say') h += `<div class="stSay" style="color:${l.col || '#ffe27a'}"><span style="color:#fff4d8">${esc(l.a)}</span></div>`;
    else if (l.t === 'kv') h += `<div class="tipRow"><span>${esc(l.a)}</span><span class="rg"${l.col ? ` style="color:${l.col}"` : ''}>${esc(l.b)}</span></div>`;
    else if (l.t === 'cost') h += `<div class="stCost ${l.ok ? 'ok' : 'no'}">${l.ic ? ic(l.ic) : ''}<span>${esc(l.a)}</span><b>${esc(l.b)}</b><i>${l.ok ? '&#10003;' : '&#10007;'}</i></div>`;
    else if (l.t === 'aff') h += `<div class="tipRow aff${l.sel ? ' sel' : ''}" ${l.id ? `data-id="${l.id}"` : ''}><span class="tb t${l.tier}" style="font-size:.66em;font-weight:900;padding:0 .45em;border-radius:4px;color:#0b1722;flex:none">T${l.tier + 1}</span><span>${esc(l.a)}</span><span class="rg">${esc(l.b.replace(/^T\d+\s*/, ''))}</span></div>`;
    else if (l.t === 'imb') h += `<div class="tipRow aff sel" data-id="imb"><span style="color:#ffe27a">${esc(l.a)}</span><span class="rg">${esc(l.b)}</span></div>`;
    else if (l.t === 'leg') h += `<div class="stLeg"><b>LEGENDARY POWER: ${esc(l.a)}</b>${esc(l.b)}</div>`;
    else if (l.t === 'sp') h += '<div class="stSp"></div>';
  }
  if (!M.info.length && M.empty && nrows) h += `<p class="stP dim">${esc(M.empty)}</p>`;
  h += `<div class="stActs">${M.acts.map(a => `<button data-id="act:${a.id}" class="${a.primary ? 'go' : ''}${a.off ? ' off' : ''}">${esc(a.label)}</button>`).join('')}</div>`; stEl.info.innerHTML = h;
  stEl.msg.className = SUI.msgT > 0 && !SUI.msgOk ? 'bad' : ''; stEl.msg.textContent = SUI.msgT > 0 ? SUI.msg : '';
  stEl.foot.innerHTML = (M.foot.length ? M.foot : [['B', 'close']]).map(([k, t]) => `<span><i class="kk ${SUI_KK[k] || 't'}">${esc(padTxt(k))}</i>${esc(t)}</span>`).join('');
  for (const cv of stEl.root.querySelectorAll('canvas[data-ic]')) { const src = SUI.icons[+cv.dataset.ic]; if (src) { const g = cv.getContext('2d'); g.clearRect(0, 0, 48, 48); g.drawImage(src, 0, 0, 48, 48); } }
  stEl.list.scrollTop = keepScroll; stEl.info.scrollTop = keepInfo; const f = stEl.list.querySelector('.stRow.focus'); if (f) { const t = f.offsetTop, b = t + f.offsetHeight; if (t < stEl.list.scrollTop) stEl.list.scrollTop = t - 6; else if (b > stEl.list.scrollTop + stEl.list.clientHeight) stEl.list.scrollTop = b - stEl.list.clientHeight + 6; }
}
// ---- open / close ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function suiOpen(kind, o = {}) {
  if (SUI.open) return false; const stt = G.state; if (!(stt === 'play' || stt === 'pause' || stt === 'menu' || stt === 'dead')) return false; if (RUI.open || PK.open || CSU.open) return false; if (stt === 'play' && (G.trans || G.finale || P.dead)) { toast('Not now'); return false; }
  SUI.from = stt; SUI.open = true; G.state = 'sta'; SUI.kind = kind; SUI.tab = o.tab | 0; SUI.row = o.row | 0; SUI.aff = 0; SUI.imb = 0; SUI.npc = o.npc || null; SUI.dlgI = 0; SUI.msg = ''; SUI.msgT = 0; SUI.t = 0; SUI.acts = 0; SUI.stale = new Set(keys); mouseFire = mousePlace = padFireDown = padPlaceDown = false; SUI.hid = [];
  for (const id of ['menu', 'dead', 'pause']) { const el = $(id); if (el && !el.classList.contains('hidden')) { el.classList.add('hidden'); SUI.hid.push(id); } }
  document.exitPointerLock && document.exitPointerLock(); if (!VR.presenting) stEl.root.classList.remove('hidden'); SUI.M = null; SUI.dirty = true; if (!VR.presenting) suiRender(); else RV.dirty = true; rsfx('uiopen'); return true;
}
function suiSwitch(kind, o = {}) { SUI.kind = kind; SUI.tab = o.tab | 0; SUI.row = 0; SUI.aff = 0; SUI.imb = 0; SUI.dlgI = 0; SUI.msg = ''; SUI.msgT = 0; SUI.npc = o.npc !== undefined ? o.npc : SUI.npc; SUI.M = null; SUI.dirty = true; if (!VR.presenting) suiRender(); else RV.dirty = true; rsfx('ui'); }
function suiClose() {
  if (!SUI.open) return; SUI.open = false; stEl.root.classList.add('hidden'); const from = SUI.from; for (const id of SUI.hid) if (!(id === 'pause' && from === 'play')) $(id).classList.remove('hidden'); SUI.hid = [];
  if (from === 'play') { G.state = 'play'; $('pause').classList.add('hidden'); requestLock(); } else G.state = from; if (from === 'menu') rpgRenderMenu(); if (typeof rpgSwallow === 'function') rpgSwallow();
  RT.dirty = true; rpgFlush(true); rsfx('uiclose'); if (typeof townOnClose === 'function') townOnClose();
}
// ---- input -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function suiMoveRow(d) { const M = SUI.M || suiModel(), n = M.rows.length; if (!n) return; const r = clamp(SUI.row + d, 0, n - 1); if (r !== SUI.row) { SUI.row = r; SUI.aff = 0; SUI.imb = 0; SUI.dirty = true; rsfx('ui'); } }
function suiMoveTab(d) { const M = SUI.M || suiModel(), n = M.tabs.length; if (n < 2) return; SUI.tab = (SUI.tab + d + n) % n; SUI.row = 0; SUI.aff = 0; SUI.imb = 0; SUI.dirty = true; rsfx('ui'); }
function suiKey(k) {
  if (!SUI.open) return; const m = UI_MAP[k];
  if (k === 'arrowup' || k === 'w') suiMoveRow(-1); else if (k === 'arrowdown' || k === 's') suiMoveRow(1); else if (k === 'arrowleft' || k === 'a' || k === 'q') suiMoveTab(-1); else if (k === 'arrowright' || k === 'd' || k === 'shift') suiMoveTab(1);
  else if (k === ' ' || k === 'enter') suiDo('A'); else if (k === 'j') suiDo('X'); else if (k === 'e') suiDo(SUI.kind === 'dlg' ? 'A' : 'Y'); else if (k === 'z' || k === 'escape' || k === 'b' || k === 'i' || k === 'tab') suiClose();
  else if (k === 'pageup') suiMoveRow(-5); else if (k === 'pagedown') suiMoveRow(5);
}
function suiClick(id) {
  if (!SUI.open) return; rsfx('ui');
  if (id === 'close') { suiClose(); return; } if (id.startsWith('tab:')) { const t = +id.slice(4); if (t !== SUI.tab) { SUI.tab = t; SUI.row = 0; SUI.aff = 0; SUI.imb = 0; SUI.dirty = true; } return; }
  if (id.startsWith('row:')) { const r = +id.slice(4); if (r !== SUI.row) { SUI.row = r; SUI.aff = 0; SUI.imb = 0; SUI.dirty = true; } return; }
  if (id.startsWith('act:')) { suiDo(id.slice(4)); return; } if (id.startsWith('aff:')) { SUI.aff = +id.slice(4); SUI.dirty = true; return; } if (id === 'imb') { SUI.imb++; SUI.dirty = true; return; }
  if (id === 'pg:-1') { suiMoveRow(-5); return; } if (id === 'pg:1') { suiMoveRow(5); return; }
}
stEl.root.addEventListener('click', e => { if (!SUI.open) return; const el = e.target.closest('[data-id]'); if (!el) return; e.stopPropagation(); if (el.disabled) return; suiClick(el.dataset.id); if (SUI.dirty) suiRender(); });
stEl.root.addEventListener('mousedown', e => e.stopPropagation()); stEl.root.addEventListener('pointerdown', e => e.stopPropagation());
stEl.root.addEventListener('mouseover', e => { if (!SUI.open || e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) return; const el = e.target.closest('.stRow'); if (!el) return; const r = +el.dataset.id.slice(4); if (r !== SUI.row) { SUI.row = r; SUI.aff = 0; SUI.imb = 0; SUI.dirty = true; suiRender(); } });
stEl.root.addEventListener('wheel', e => e.stopPropagation(), { passive: true });
// pad / keyboard repeat for held directions, the message timer, and a slow refresh for timers (garden, effects)
function suiTick(rdt) {
  if (!SUI.open) { SUI.rep.k = ''; return; } SUI.t += rdt; if (SUI.msgT > 0) { SUI.msgT -= rdt; if (SUI.msgT <= 0) { SUI.msgT = 0; SUI.dirty = true; } }
  let hk = ''; for (const k of ['arrowup', 'w', 'arrowdown', 's', 'arrowleft', 'a', 'arrowright', 'd']) { if (SUI.stale && SUI.stale.has(k)) { if (!keys.has(k)) SUI.stale.delete(k); continue; } if (keys.has(k)) { hk = k; break; } }
  if (!hk) SUI.rep.k = ''; else if (hk !== SUI.rep.k) { SUI.rep.k = hk; SUI.rep.t = 0.38; } else { SUI.rep.t -= rdt; if (SUI.rep.t <= 0) { SUI.rep.t = 0.11; suiKey(hk); } }
  if (SUI.t > 1 && (SUI.kind === 'garden' || SUI.kind === 'pack' || SUI.kind === 'board')) { SUI.t = 0; SUI.dirty = true; }
  if (SUI.dirty) { if (VR.presenting) { SUI.M = suiModel(); SUI.dirty = false; RV.dirty = true; } else suiRender(); }
}
{ const _f = rpgFrame; rpgFrame = function (rdt, sdt) { _f(rdt, sdt); if (SUI.open) { try { suiTick(rdt); } catch (err) { if (!SUI.err) { SUI.err = 1; console.error('sui', err); } } } }; }
{ const _k = rpgKeyDown; rpgKeyDown = function (k) { if (SUI.open) { suiKey(k); return; } _k(k); }; }
{ const _u = uiKey; uiKey = function (k) { if (SUI.open) { suiKey(k); return; } _u(k); }; }
// the rpg overlay hides while a station is open; nothing else to do for the DOM (it is a full-screen overlay)
// ---- VR: one big world-space panel, laser + sticks ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const SVR = { rowH: 84, rows: 10, y0: 226, off: 0 };
function suiVrWrap(c, text, x, y, w, size, col, weight, lh, maxLines) { c.font = (weight || 600) + ' ' + size + 'px ' + VFONT; wrapLines(c, text, w, _wl); c.fillStyle = col; c.textAlign = 'left'; let n = 0; for (let i = 0; i < _wl.length && i < (maxLines || 6); i++) { c.fillText(_wl[i], x, y + i * lh); n++; } return n; }
function suiDrawVr() {
  const p = UI.rp, c = p.ctx, W = p.pw, H = p.ph; c.clearRect(0, 0, W, H); RV.btns.length = 0; c.textBaseline = 'alphabetic'; const M = SUI.M || (SUI.M = suiModel()); SUI.dirty = false; const nrows = M.rows.length; SUI.row = nrows ? clamp(SUI.row, 0, nrows - 1) : 0;
  rrect(c, 8, 8, W - 16, H - 16, 50); const gr = c.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, 'rgba(12,28,46,.96)'); gr.addColorStop(1, 'rgba(6,14,24,.96)'); c.fillStyle = gr; c.fill(); c.lineWidth = 7; c.strokeStyle = M.col; c.stroke();
  rvTxt(c, M.title, 52, 84, 58, M.col, 900, 'left', 500);
  for (let i = 0; i < M.tabs.length; i++) rvBtn(c, 'tab:' + i, 560 + i * 196, 24, 188, 80, M.tabs[i], { on: i === SUI.tab, fs: 34, r: 22 });
  rvCoin(c, 1556, 64, 22); rvTxt(c, rfmt(RP.gold), 1590, 80, 42, '#fff4d8', 900); rvDiamond(c, 1744, 62, 22, '#53e0d0'); rvTxt(c, rfmt(RP.dust), 1778, 80, 42, '#c8fff6', 900); rvBtn(c, 'close', 1884, 24, 124, 80, 'X', { fs: 48, r: 22 });
  const showList = !M.dlg, lx = 40, lw = 770, ix = showList ? 830 : 40, iw = showList ? 1178 : 1968;
  if (showList) {
    rvPanelBg(c, lx, 130, lw, 1010, 26); rvTxt(c, M.sub || ' ', lx + 26, 184, 38, '#9fd8ff', 800, 'left', lw - 52);
    if (!nrows) rvTxt(c, M.empty || '', lx + lw / 2, 560, 38, '#8195a6', 700, 'center', lw - 60);
    const first = clamp(SUI.row - 4, 0, Math.max(0, nrows - SVR.rows)); SVR.off = first;
    if (first > 0) rvBtn(c, 'pg:-1', lx + lw - 96, 140, 80, 48, '^', { fs: 34, r: 14, dim: true }); if (first + SVR.rows < nrows) rvBtn(c, 'pg:1', lx + lw - 96, 1086, 80, 48, 'v', { fs: 30, r: 14, dim: true });
    for (let k = 0; k < SVR.rows && first + k < nrows; k++) {
      const i = first + k, r = M.rows[i], y = SVR.y0 + k * SVR.rowH, foc = i === SUI.row, hot = rvHot(r.id); RV.btns.push({ id: r.id, x: lx + 12, y, w: lw - 24, h: SVR.rowH - 8 });
      rrect(c, lx + 12, y, lw - 24, SVR.rowH - 8, 18); c.fillStyle = foc ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.05)'; c.fill(); c.lineWidth = foc ? 7 : hot ? 4 : 2; c.strokeStyle = foc ? '#fff2b0' : hot ? 'rgba(160,220,255,.9)' : 'rgba(255,255,255,.14)'; c.stroke();
      const icn = r.ic ? suiIconOf(r.ic) : null; if (icn) c.drawImage(icn, lx + 24, y + 7, 62, 62); else if (r.glyph) { c.beginPath(); c.arc(lx + 55, y + 38, 28, 0, TAU); c.fillStyle = r.col || '#fff'; c.fill(); }
      c.globalAlpha = r.st === 'lock' ? 0.55 : 1; rvTxt(c, r.name, lx + 102, y + 36, 38, r.col || '#fff', 800, 'left', lw - 102 - (r.right ? 190 : 40)); rvTxt(c, r.sub || '', lx + 102, y + 66, 28, '#a9bccb', 600, 'left', lw - 102 - (r.right ? 190 : 40)); if (r.right) rvTxt(c, r.right, lx + lw - 30, y + 48, 32, r.st === 'ok' ? '#9cf7ab' : r.st === 'no' ? '#ff9a8a' : '#c8d6e2', 900, 'right', 170); c.globalAlpha = 1;
    }
  }
  rvPanelBg(c, ix, 130, iw, 1010, 26); let y = 196; const tx = ix + 30, tw = iw - 60;
  for (const l of M.info) {
    if (y > 1000) break;
    if (l.t === 'h') { const icn = l.ic ? suiIconOf(l.ic) : l.gem ? gemIconBase(l.gem) : null, o = icn ? 74 : 0; if (icn) c.drawImage(icn, tx, y - 46, 62, 62); rvTxt(c, l.a, tx + o, y, l.small ? 34 : 50, l.col || '#fff', 900, 'left', tw - o); y += l.small ? 46 : 62; }
    else if (l.t === 'p') { const n = suiVrWrap(c, l.a, tx, y, tw, l.dim ? 32 : 36, l.dim ? '#8195a6' : '#cfe0ec', 600, 42, 5); y += n * 42 + 8; }
    else if (l.t === 'say') { rrect(c, tx - 10, y - 50, tw + 20, 0 + 4, 4); const n = suiVrWrap(c, l.a, tx + 6, y, tw - 20, 52, '#fff4d8', 700, 66, 6); c.fillStyle = l.col || '#ffe27a'; c.fillRect(tx - 14, y - 46, 8, n * 66 + 6); y += n * 66 + 24; }
    else if (l.t === 'kv') { rvTxt(c, l.a, tx, y, 36, '#a9bccb', 700, 'left', tw * 0.5); rvTxt(c, l.b, tx + tw, y, 36, l.col || '#ffffff', 800, 'right', tw * 0.55); y += 48; }
    else if (l.t === 'cost') { const icn = l.ic ? suiIconOf(l.ic) : null; if (icn) c.drawImage(icn, tx, y - 34, 44, 44); rvTxt(c, l.a, tx + (icn ? 56 : 0), y, 36, '#dfe9f2', 700, 'left', tw * 0.55); rvTxt(c, l.b, tx + tw - 56, y, 36, l.ok ? '#9cf7ab' : '#ff9a8a', 800, 'right', tw * 0.5); rvTxt(c, l.ok ? 'OK' : 'NO', tx + tw, y, 30, l.ok ? '#9cf7ab' : '#ff8f7a', 900, 'right'); y += 50; }
    else if (l.t === 'aff' || l.t === 'imb') { const id = l.id; if (id) RV.btns.push({ id, x: tx - 10, y: y - 40, w: tw + 20, h: 54 }); const hot = id && rvHot(id); if (l.sel || hot) { rrect(c, tx - 10, y - 40, tw + 20, 54, 12); c.fillStyle = l.sel ? 'rgba(255,226,122,.26)' : 'rgba(160,220,255,.2)'; c.fill(); } if (l.t === 'aff') { rrect(c, tx, y - 34, 62, 42, 10); c.fillStyle = ['#46607a', '#3a8a8a', '#3d8f5a', '#a8842a', '#c8602a'][l.tier] || '#46607a'; c.fill(); rvTxt(c, 'T' + (l.tier + 1), tx + 31, y - 3, 32, '#fff', 900, 'center'); rvTxt(c, l.a, tx + 78, y, 36, '#fff', 700, 'left', tw - 330); rvTxt(c, l.b.replace(/^T\d+\s*/, ''), tx + tw, y, 30, '#7d93a6', 600, 'right', 250); } else { rvTxt(c, l.a, tx, y, 36, '#ffe27a', 800, 'left', tw * 0.6); rvTxt(c, l.b, tx + tw, y, 30, '#c8d6e2', 700, 'right', tw * 0.5); } y += 56; }
    else if (l.t === 'leg') { rvTxt(c, 'LEGENDARY: ' + l.a, tx, y, 34, '#ffb15e', 900, 'left', tw); y += 40; const n = suiVrWrap(c, l.b, tx, y, tw, 32, '#ffe9c8', 600, 40, 3); y += n * 40 + 10; }
    else if (l.t === 'sp') y += 18;
  }
  if (!M.info.length && nrows && M.empty) rvTxt(c, M.empty, tx, y, 36, '#8195a6', 600, 'left', tw);
  const na = M.acts.length, aw = na ? Math.min(380, (tw - (na - 1) * 16) / na) : 0; for (let i = 0; i < na; i++) { const a = M.acts[i]; rvBtn(c, 'act:' + a.id, tx + i * (aw + 16), 1050, aw, 76, a.label, { primary: a.primary && !a.off, dim: a.off, fs: a.label.length > 14 ? 30 : 38, r: 38 }); }
  const foot = (M.foot.length ? M.foot : [['B', 'close']]).map(([k, t]) => k + ' ' + t).join('    ') + '    STICK select    GRIPS tabs    TRIGGER click'; rvTxt(c, foot, W / 2, 1196, 36, '#9fd8ff', 700, 'center', W - 80);
  if (SUI.msgT > 0) rvTxt(c, SUI.msg, W / 2, 1248, 42, SUI.msgOk ? '#9cf7ab' : '#ff9a8a', 800, 'center', W - 80);
  p.tex.needsUpdate = true; RV.dirty = false;
}
function suiVrHover(id) { if (id.startsWith('row:')) { const r = +id.slice(4); if (r !== SUI.row) { SUI.row = r; SUI.aff = 0; SUI.imb = 0; SUI.M = null; SUI.dirty = true; RV.dirty = true; } } }
function suiVrClick(id) { suiClick(id); SUI.M = null; SUI.dirty = true; RV.dirty = true; }
function suiVrActions(rdt, L, R) {
  let ax = R.has ? R.ax : 0, ay = R.has ? R.ay : 0, hh = 1; if (L.has && hyp2(L.ax, L.ay) > hyp2(ax, ay)) { ax = L.ax; ay = L.ay; hh = 0; }
  const rep = RV.rep, on = rep.dir ? 0.3 : 0.62; let d = 0; if (Math.abs(ax) > Math.abs(ay)) { if (ax < -on) d = 1; else if (ax > on) d = 2; } else { if (ay < -on) d = 3; else if (ay > on) d = 4; }
  const step = dd => { vrHaptic(hh, 0.1, 8); suiKey(dd === 1 ? 'arrowleft' : dd === 2 ? 'arrowright' : dd === 3 ? 'arrowup' : 'arrowdown'); SUI.M = null; RV.dirty = true; };
  if (!d) rep.dir = 0; else if (d !== rep.dir) { rep.dir = d; rep.t = 0.36; step(d); } else { rep.t -= rdt; if (rep.t <= 0) { rep.t = 0.11; step(d); } }
  if (R.rise & 4) suiKey(' '); if (R.rise & 8) suiKey('z'); if (L.rise & 4) suiKey('j'); if (L.rise & 8) suiKey('e'); if (L.rise & 2) suiKey('q'); if (R.rise & 2) suiKey('shift'); if (SUI.open) { SUI.M = null; SUI.dirty = true; }
}
{ const _h = vrRpgHover; vrRpgHover = function (id) { if (UI.mode === 'sta') { suiVrHover(id); return; } _h(id); }; const _c = vrRpgClick; vrRpgClick = function (id) { if (UI.mode === 'sta') { sfx('click'); suiVrClick(id); return; } _c(id); }; const _a = vrRpgActions; vrRpgActions = function (rdt, L, R) { if (SUI.open) { suiVrActions(rdt, L, R); return; } _a(rdt, L, R); }; const _d = vrDrawRp; vrDrawRp = function () { if (UI.mode === 'sta') { suiDrawVr(); return; } _d(); }; }
// ---- test API ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
window.__sta = {
  open(kind, o) { return suiOpen(kind, o || {}); }, close() { suiClose(); }, state() { return { open: SUI.open, kind: SUI.kind, tab: SUI.tab, row: SUI.row, from: SUI.from, msg: SUI.msg, ok: SUI.msgOk, acts: SUI.acts, gstate: G.state }; },
  model() { const M = suiModel(); return { title: M.title, sub: M.sub, tabs: M.tabs, rows: M.rows.map(r => ({ name: r.name, sub: r.sub, right: r.right, st: r.st })), info: M.info.map(l => ({ t: l.t, a: l.a, b: l.b, ok: l.ok })), acts: M.acts.map(a => ({ id: a.id, label: a.label, off: a.off })), foot: M.foot, empty: M.empty, build: M.build || null, dlg: M.dlg || null }; },
  key(k) { suiKey(k); if (!VR.presenting) { if (SUI.dirty) suiRender(); } else { SUI.M = null; RV.dirty = true; } }, click(id) { suiClick(id); if (!VR.presenting) { if (SUI.dirty) suiRender(); } else { SUI.M = null; RV.dirty = true; } }, do(id) { suiDo(id); if (!VR.presenting && SUI.dirty) suiRender(); },
  select(tab, row) { if (tab != null) SUI.tab = tab; if (row != null) SUI.row = row; SUI.M = null; SUI.dirty = true; if (!VR.presenting) suiRender(); else RV.dirty = true; }, ids() { return [...stEl.root.querySelectorAll('[data-id]')].map(e => e.dataset.id); }, vrBtns() { return RV.btns.map(b => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h })); },
  drawVr() { suiDrawVr(); },
};
// </sui-ui>

