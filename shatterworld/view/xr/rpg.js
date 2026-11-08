// <vr-rpg> ====================================================================================================================
// RPG layer inside the VR layer (merge of the RPG build and the VR build). DOM overlays are invisible in an immersive session, so:
//  * inventory / sheet / perks / codex / rift tabs and the perk pick are drawn on ONE big world-space panel (UI.rp): laser-clickable AND drivable with the Touch controls
//    (while state is 'inv' / 'perk' the sticks move the cursor instead of snap-turning, A confirm, B back, X salvage, Y lock, grips = tabs, trigger = laser click)
//  * HUD: the wrist panel carries level / xp / hp / rewind / gold / buffs / rift timer; a second strip panel (UI.hudP) carries rift bar, boss bar, banners and the loot log
//  * loot / chest / elite name plates are a small pool of 3D text sprites; loot beams and elite auras are capped + shortened in the diorama
//  * item pickup, level-up, legendary, equip, salvage ... each get their own haptic pattern (vrRsfxHaptic + a tiny scheduler: no timers, no per-frame allocation)
// Open / close the inventory: HOLD Y (left) for 0.4 s (a short tap is still pause / resume, now acted on at release). Nothing in this block runs in flat play except VR.presenting checks.
// ====================================================================================================================
const RV = {
  open: false, dirty: true, hotId: ['', ''], btns: [], armedOn: false, pkPage: 0,
  ban: { on: false, h: '', p: '', leg: false, until: 0, seq: 0 }, log: [{ t: '', c: '', until: 0 }, { t: '', c: '', until: 0 }], logSeq: 0,
  ws: { hp: -1, mx: -1, sh: -1, xp: -1, lv: -1, rw: -1, rwm: -1, gold: -1, buf: -1, rl: -2, rp: -2, big: -1, t: -1, coins: -1, shards: -1, score: -1, nsd: -9 }, hs: { rl: -2, rp: -2, ph: -2, bh: -2, ban: -1, log: -1, key: -1 },
  plates: [], cand: [], selN: 0, putN: 0, plateT: 0, nPlates: 0, nBeams: 0, rep: { dir: 0, t: 0 }, hap: [], hapSeq: 0, hapPlayed: 0, cullT: 0, yHold: 0, yFr: 0, drawT: 0, scratch: null, st: [],
};
const RV_PERKS_PER_PAGE = 8;

// ---- haptics: per-event patterns [delay ms, amplitude, duration ms] x n; played through a preallocated queue (no timers, never allocates while presenting) ---------------------
const RV_HP = {
  pick1: [0, 0.3, 40], pick2: [0, 0.45, 40, 95, 0.55, 55], pick3: [0, 0.35, 60, 100, 0.6, 80, 210, 1, 380], drop3: [0, 0.7, 140, 160, 0.5, 90],
  levelup: [0, 0.3, 50, 110, 0.5, 60, 230, 0.7, 80, 370, 1, 420], rift: [0, 1, 260, 330, 0.7, 340], riftwin: [0, 0.5, 70, 130, 0.7, 80, 270, 1, 450], riftlose: [0, 1, 520], phoenix: [0, 1, 160, 220, 0.8, 120, 380, 1, 420],
  equip: [0, 0.3, 30], salvage: [0, 0.6, 90, 130, 0.4, 60], reroll: [0, 0.3, 20, 70, 0.4, 20, 140, 0.5, 20, 210, 0.7, 60], lock: [0, 0.25, 25], chest: [0, 0.6, 90, 130, 0.4, 70], deny: [0, 0.45, 70], uiopen: [0, 0.3, 40], perk: [0, 0.4, 50, 110, 0.6, 90],
  crit: [0, 0.6, 50], slam: [0, 0.9, 220], nova: [0, 0.6, 110], pulse: [0, 0.5, 80], shield: [0, 0.3, 60], heal: [0, 0.2, 90],
};
for (let i = 0; i < 24; i++) RV.hap.push({ on: false, t: 0, h: 2, a: 0, ms: 0 });
function vrHapPlay(h, pat) {
  const now = performance.now(), n = pat.length / 3; RV.hapSeq++;
  for (let k = 0; k < n; k++) { let s = null; for (let i = 0; i < RV.hap.length; i++) if (!RV.hap[i].on) { s = RV.hap[i]; break; } if (!s) return; s.on = true; s.t = now + pat[k * 3]; s.h = h; s.a = pat[k * 3 + 1]; s.ms = pat[k * 3 + 2]; }
}
function vrHapTick() { // one due step per frame, earliest first: vrHaptic() drops pulses closer than 22 ms, so on a slow frame the steps of a pattern must not all fire at once
  const now = performance.now(); let b = null; for (let i = 0; i < RV.hap.length; i++) { const s = RV.hap[i]; if (s.on && now >= s.t && (b === null || s.t < b.t)) b = s; }
  if (b !== null) { b.on = false; vrHaptic(b.h, b.a, b.ms); RV.hapPlayed++; }
}
function vrRsfxHaptic(name, a) { // called from rsfx() while presenting (every RPG event that has a sound also gets a feel)
  switch (name) {
    case 'pick0': vrHaptic(1, 0.16, 18); RV.hapSeq++; break;
    case 'pick1': vrHapPlay(1, RV_HP.pick1); break;
    case 'pick2': vrHapPlay(2, RV_HP.pick2); break;
    case 'pick3': vrHapPlay(2, RV_HP.pick3); break;
    case 'drop3': vrHapPlay(2, RV_HP.drop3); break;
    case 'drop2': vrHaptic(2, 0.25, 35); break;
    case 'dust': vrHaptic(1, 0.14, 16); break;
    case 'levelup': vrHapPlay(2, RV_HP.levelup); break;
    case 'perk': vrHapPlay(2, RV_HP.perk); break;
    case 'rift': vrHapPlay(2, RV_HP.rift); break;
    case 'riftwin': vrHapPlay(2, RV_HP.riftwin); break;
    case 'riftlose': vrHapPlay(2, RV_HP.riftlose); break;
    case 'phoenix': vrHapPlay(2, RV_HP.phoenix); break;
    case 'equip': vrHapPlay(2, RV_HP.equip); break;
    case 'salvage': vrHapPlay(2, RV_HP.salvage); break;
    case 'reroll': vrHapPlay(2, RV_HP.reroll); break;
    case 'lock': vrHapPlay(2, RV_HP.lock); break;
    case 'chest': vrHapPlay(2, RV_HP.chest); break;
    case 'deny': vrHapPlay(2, RV_HP.deny); break;
    case 'uiopen': vrHapPlay(2, RV_HP.uiopen); break;
    case 'crit': vrHapPlay(VR.fireHand, RV_HP.crit); break;
    case 'slam': vrHapPlay(2, RV_HP.slam); break;
    case 'nova': vrHapPlay(2, RV_HP.nova); break;
    case 'pulse': vrHapPlay(2, RV_HP.pulse); break;
    case 'shield': vrHapPlay(2, RV_HP.shield); break;
    case 'heal': vrHapPlay(2, RV_HP.heal); break;
  }
}

// ---- hooks into the RPG layer (function re-binding, the technique the RPG layer itself uses on the original game) ------------------------------------------------------------
const _rpgRenderInv = rpgRenderInv; rpgRenderInv = function () { if (VR.presenting) { RV.dirty = true; return; } _rpgRenderInv(); }; // the DOM grid / tooltip HTML is not built while the headset shows the panel
const _renderPerks = renderPerks; renderPerks = function () { if (VR.presenting) { RV.dirty = true; return; } _renderPerks(); };
const _rpgBanner = rpgBanner; rpgBanner = function (h, p, leg) { _rpgBanner(h, p, leg); if (VR.presenting) { const b = RV.ban; b.on = true; b.seq++; b.h = h; b.p = p || ''; b.leg = !!leg; b.until = performance.now() + 3400; } };
const _rpgLogLine = rpgLogLine; rpgLogLine = function (txt, col) { _rpgLogLine(txt, col); if (VR.presenting) { const l = RV.log, a = l[0]; l[0] = l[1]; l[1] = a; a.t = txt; a.c = col || '#eaf6ff'; a.until = performance.now() + 4600; RV.logSeq++; } };

// ---- canvas helpers ------------------------------------------------------------------------------------------------------------------------------------
function rvFit(c, t, maxW) { if (c.measureText(t).width <= maxW) return t; while (t.length > 1 && c.measureText(t + '…').width > maxW) t = t.slice(0, -1); return t + '…'; }
function rvTxt(c, t, x, y, size, col, weight, align, maxW) { c.font = (weight || 700) + ' ' + size + 'px ' + VFONT; if (maxW) t = rvFit(c, t, maxW); c.fillStyle = col; c.textAlign = align || 'left'; c.fillText(t, x, y); }
const RV_RC = ['rgba(34,48,66,.92)', 'rgba(24,52,98,.92)', 'rgba(74,60,14,.92)', 'rgba(88,42,10,.92)'];
function rvTri(c, x, y, s, up, col) { c.beginPath(); if (up) { c.moveTo(x, y - s); c.lineTo(x + s, y + s * 0.8); c.lineTo(x - s, y + s * 0.8); } else { c.moveTo(x, y + s); c.lineTo(x + s, y - s * 0.8); c.lineTo(x - s, y - s * 0.8); } c.closePath(); c.fillStyle = col; c.fill(); }
function rvArrow(c, x, y, s, dir, col) { c.beginPath(); c.moveTo(x + dir * s, y); c.lineTo(x - dir * s * 0.7, y - s); c.lineTo(x - dir * s * 0.7, y + s); c.closePath(); c.fillStyle = col; c.fill(); }
function rvDiamond(c, x, y, s, col) { c.beginPath(); c.moveTo(x, y - s); c.lineTo(x + s * 0.75, y); c.lineTo(x, y + s); c.lineTo(x - s * 0.75, y); c.closePath(); c.fillStyle = col; c.fill(); c.lineWidth = 3; c.strokeStyle = 'rgba(255,255,255,.55)'; c.stroke(); }
function rvCoin(c, x, y, r) { c.beginPath(); c.arc(x, y, r, 0, TAU); const g = c.createRadialGradient(x - r * 0.3, y - r * 0.3, 2, x, y, r); g.addColorStop(0, '#fff7c2'); g.addColorStop(0.55, '#ffc93a'); g.addColorStop(1, '#d98a12'); c.fillStyle = g; c.fill(); }
function rvPanelBg(c, x, y, w, h, r) { rrect(c, x, y, w, h, r || 28); c.fillStyle = 'rgba(255,255,255,.05)'; c.fill(); }
function rvHot(id) { return RV.hotId[0] === id || RV.hotId[1] === id; }
function rvBtn(c, id, x, y, w, h, label, o) {
  o = o || {}; const hot = !o.static && rvHot(id); if (!o.static) RV.btns.push({ id, x, y, w, h });
  rrect(c, x, y, w, h, o.r != null ? o.r : h / 2); const g = c.createLinearGradient(0, y, 0, y + h);
  if (o.primary) { g.addColorStop(0, hot ? '#fff9d0' : '#fff2b0'); g.addColorStop(0.55, hot ? '#ffd45f' : '#ffc54a'); g.addColorStop(1, hot ? '#ffa43a' : '#ff9c2b'); }
  else if (o.on) { g.addColorStop(0, hot ? 'rgba(120,255,240,.85)' : 'rgba(83,224,208,.72)'); g.addColorStop(1, hot ? 'rgba(40,180,170,.85)' : 'rgba(30,140,130,.72)'); }
  else if (o.dim) { g.addColorStop(0, hot ? 'rgba(120,200,255,.35)' : 'rgba(255,255,255,.06)'); g.addColorStop(1, hot ? 'rgba(60,140,220,.35)' : 'rgba(255,255,255,.02)'); }
  else { g.addColorStop(0, hot ? 'rgba(120,200,255,.6)' : 'rgba(255,255,255,.14)'); g.addColorStop(1, hot ? 'rgba(60,140,220,.6)' : 'rgba(255,255,255,.06)'); }
  c.fillStyle = g; c.fill(); c.lineWidth = hot ? 7 : 3; c.strokeStyle = hot ? '#ffffff' : (o.primary ? 'rgba(255,235,170,.6)' : 'rgba(255,255,255,.38)'); c.stroke();
  c.textBaseline = 'middle'; rvTxt(c, label, x + w / 2, y + h / 2 + 2, o.fs || 40, o.primary ? '#2a1400' : o.dim ? 'rgba(234,246,255,.5)' : '#eaf6ff', 800, 'center', w - 20); c.textBaseline = 'alphabetic';
}
function rvSlot(c, id, x, y, s, it, zone, focus, ghost) {
  const hot = rvHot(id); RV.btns.push({ id, x, y, w: s, h: s }); const ri = it ? RPG_RARITIES.indexOf(it.rarity) : -1;
  rrect(c, x, y, s, s, s * 0.14); c.fillStyle = it ? RV_RC[ri] : 'rgba(255,255,255,.05)'; c.fill();
  if (it) c.drawImage(rpgIconBase(it), x + 5, y + 5, s - 10, s - 10);
  else if (ghost) { c.globalAlpha = 0.22; c.drawImage(rpgIconBase({ slot: ghost, rarity: 'common', seed: 0, ilvl: 1, affixes: [] }), x + 5, y + 5, s - 10, s - 10); c.globalAlpha = 1; }
  rrect(c, x, y, s, s, s * 0.14); c.lineWidth = focus ? 8 : 3; c.strokeStyle = focus ? '#ffffff' : it ? RPG_RARITY_COL[ri] : 'rgba(255,255,255,.22)'; c.stroke();
  if (hot && !focus) { rrect(c, x - 4, y - 4, s + 8, s + 8, s * 0.17); c.lineWidth = 4; c.strokeStyle = 'rgba(160,220,255,.9)'; c.stroke(); }
  if (it) {
    c.textBaseline = 'alphabetic'; c.lineWidth = 6; c.strokeStyle = 'rgba(0,0,0,.85)'; c.font = '800 ' + Math.round(s * 0.27) + 'px ' + VFONT; c.textAlign = 'right'; c.strokeText(String(it.ilvl), x + s - 8, y + s - 9); c.fillStyle = '#fff'; c.fillText(String(it.ilvl), x + s - 8, y + s - 9);
    if (it.locked) { c.beginPath(); c.arc(x + 17, y + 17, 11, 0, TAU); c.fillStyle = '#ffd24a'; c.fill(); c.lineWidth = 3; c.strokeStyle = '#2a1400'; c.stroke(); }
    if (zone === 'bag' && rpgItemScore(it) > rpgItemScore(rpgCmpTarget(it))) rvTri(c, x + s - 20, y + 20, 11, true, '#7bf08a');
  }
}

// ---- the big panel ---------------------------------------------------------------------------------------------------------------------------------------
function rvHeader(c) {
  for (let i = 0; i < TAB_NAMES.length; i++) {
    const x = 40 + i * 208, w = 198; rvBtn(c, 'tab:' + i, x, 22, w, 84, TAB_NAMES[i], { on: RUI.tab === i, fs: 38, r: 22 });
    const n = i === 2 ? RP.pending : i === 1 ? RP.free : 0; if (n) { c.beginPath(); c.arc(x + w - 14, 30, 24, 0, TAU); c.fillStyle = '#ff5a4a'; c.fill(); c.lineWidth = 3; c.strokeStyle = '#fff'; c.stroke(); c.textBaseline = 'middle'; rvTxt(c, String(n), x + w - 14, 32, 32, '#fff', 900, 'center'); c.textBaseline = 'alphabetic'; }
  }
  rvTxt(c, 'LV ' + RP.level, 1318, 82, 50, '#ffe27a', 900); rvCoin(c, 1500, 66, 24); rvTxt(c, rfmt(RP.gold), 1536, 82, 46, '#fff4d8', 900);
  rvDiamond(c, 1730, 64, 24, '#53e0d0'); rvTxt(c, rfmt(RP.dust), 1768, 82, 46, '#c8fff6', 900); rvBtn(c, 'close', 1884, 22, 124, 84, 'X', { fs: 50, r: 22 });
}
function rvStatBlock(c, x, y, w, rows, pitch, size) {
  for (let i = 0; i < rows.length; i++) { const r = rows[i]; rvTxt(c, r[0], x, y + i * pitch, size, '#a9bccb', 700); rvTxt(c, r[1], x + w, y + i * pitch, size, '#ffffff', 800, 'right'); }
}
function rvTooltip(c, x0, y0, w, h) {
  rvPanelBg(c, x0, y0, w, h, 26); const sel = uiSel(), item = sel.item, x = x0 + 26, iw = w - 52; let y = y0 + 64; c.textBaseline = 'alphabetic';
  if (!item) { rvTxt(c, sel.where === 'eq' ? 'NOTHING EQUIPPED' : sel.where === 'chip' ? CHIPS[sel.idx] : 'EMPTY', x0 + w / 2, y0 + 220, 50, '#a9bccb', 800, 'center', iw); rvTxt(c, sel.where === 'chip' ? 'press A to use' : 'loot drops from', x0 + w / 2, y0 + 290, 40, '#7d93a6', 600, 'center'); if (sel.where !== 'chip') rvTxt(c, 'enemies, chests, crates', x0 + w / 2, y0 + 340, 40, '#7d93a6', 600, 'center'); return; }
  const ri = RPG_RARITIES.indexOf(item.rarity), col = RPG_RARITY_COL[ri], im = rpgImplicit(item), cmpTo = sel.where === 'bag' ? rpgCmpTarget(item) : null;
  rvTxt(c, rpgItemName(item), x, y, 54, col, 900, 'left', iw); y += 52;
  rvTxt(c, RPG_RARITY_NAME[ri] + ' ' + RPG_SLOT_LABEL[item.slot] + '  ·  ilvl ' + item.ilvl + (item.locked ? '  ·  LOCKED' : '') + (sel.where === 'eq' ? '  ·  EQUIPPED' : ''), x, y, 38, '#a9bccb', 700, 'left', iw); y += 54;
  rvTxt(c, rpgFmtStat(im.stat, im.value) + ' ' + RPG_STATS[im.stat].label, x, y, 40, '#dfe9f2', 700, 'left', iw - 110); rvTxt(c, 'base', x + iw, y, 34, '#7d93a6', 600, 'right'); y += 52;
  for (let k = 0; k < item.affixes.length; k++) {
    const a = item.affixes[k], d = RPG_AFFIX_BY_ID[a.id], T = d.tiers[a.tier], sl = !!RUI.rr && RUI.rr.row === k, id = 'rr:' + k, hot = !!RUI.rr && rvHot(id);
    if (RUI.rr) RV.btns.push({ id, x: x - 8, y: y - 40, w: iw + 16, h: 56 });
    if (sl || hot) { rrect(c, x - 8, y - 40, iw + 16, 56, 12); c.fillStyle = sl ? 'rgba(255,226,122,.28)' : 'rgba(160,220,255,.22)'; c.fill(); }
    rrect(c, x, y - 34, 64, 42, 10); c.fillStyle = ['#46607a', '#3a8a8a', '#3d8f5a', '#a8842a', '#c8602a'][a.tier] || '#46607a'; c.fill(); rvTxt(c, 'T' + (a.tier + 1), x + 32, y - 3, 34, '#fff', 900, 'center');
    const txt = rpgFmtStat(d.stat, a.value) + ' ' + RPG_STATS[d.stat].label, rng = rpgFmtStat(d.stat, T.lo, false) + '-' + rpgFmtStat(d.stat, T.hi, false); rvTxt(c, txt, x + 78, y, 40, '#ffffff', 700, 'left', iw - 80);
    c.font = '700 40px ' + VFONT; const tw = c.measureText(txt).width; c.font = '600 34px ' + VFONT; const rw = c.measureText(rng).width; if (78 + tw + 24 + rw < iw) rvTxt(c, rng, x + iw, y, 34, '#7d93a6', 600, 'right'); y += 54;
  }
  if (item.legendary) { const L = RPG_LEG_BY_ID[item.legendary]; c.font = '600 38px ' + VFONT; wrapLines(c, L.text, iw - 24, _wl); const hh = 56 + Math.min(4, _wl.length) * 42; rrect(c, x - 6, y - 38, iw + 12, hh, 14); c.fillStyle = 'rgba(255,138,42,.16)'; c.fill(); c.lineWidth = 3; c.strokeStyle = 'rgba(255,138,42,.6)'; c.stroke(); rvTxt(c, 'LEGENDARY POWER', x + 8, y, 34, '#ffb15e', 900); y += 44; c.font = '600 38px ' + VFONT; c.fillStyle = '#ffe9c8'; c.textAlign = 'left'; for (let i = 0; i < _wl.length && i < 4; i++) { c.fillText(_wl[i], x + 8, y); y += 42; } y += 16; }
  if (RUI.rr) { const rc = rpgRerollCost(item); rvTxt(c, 'REROLL: pick an affix (A). Cost ' + rc.dust + ' shards + ' + rc.gold + ' gold', x, y, 34, '#ffe27a', 700, 'left', iw); y += 48; }
  if (sel.where === 'bag') {
    const d = rpgCompare(item, cmpTo); rvTxt(c, cmpTo ? 'VS EQUIPPED: ' + rpgItemName(cmpTo).toUpperCase() : 'VS EMPTY SLOT', x, y, 34, '#9fd8ff', 800, 'left', iw); y += 46;
    if (!d.length) { rvTxt(c, 'no change', x, y, 38, '#a9bccb', 600); y += 44; }
    for (let i = 0; i < d.length && i < 6; i++) { const q = d[i], up = q.delta > 0; rvTri(c, x + 16, y - 14, 12, up, up ? '#7bf08a' : '#ff8f7a'); rvTxt(c, rpgFmtStat(q.stat, q.delta) + ' ' + RPG_STATS[q.stat].label, x + 44, y, 40, up ? '#9cf7ab' : '#ffa898', 700, 'left', iw - 50); y += 44; }
  }
}
function rvItems(c) {
  const eqx = 40, eqw = 480, bx = 540, bw = 780, tx = 1340, tw = 668, y0 = 130, hh = 1010;
  rvPanelBg(c, eqx, y0, eqw, hh, 26); rvTxt(c, 'EQUIPPED', eqx + 28, y0 + 56, 40, '#9fd8ff', 800);
  for (let i = 0; i < 6; i++) { const k = RPG_EQUIP[i], cx = eqx + 56 + (i % 2) * 220, cy = y0 + 84 + ((i / 2) | 0) * 262; rvSlot(c, 'eq:' + i, cx, cy, 180, RP.equipped[k], 'eq', RUI.zone === 'eq' && RUI.i === i, k.replace(/\d/, '')); rvTxt(c, RPG_SLOT_LABEL[k], cx + 90, cy + 180 + 40, 40, '#cfe0ee', 700, 'center'); }
  const S = RT.S; rvStatBlock(c, eqx + 30, y0 + 888, eqw - 60, [['MAX HP', String(RT.max)], ['DAMAGE / hit', rfmt(RT.sheet.punch)], ['CRIT', Math.round(S.critTotal * 100) + '%  x' + S.critMul.toFixed(2)]], 46, 40);
  rvPanelBg(c, bx, y0, bw, hh, 26); const cnt = RP.bag.filter(Boolean).length; rvTxt(c, 'BAG ' + cnt + ' / ' + BAG_N, bx + 28, y0 + 56, 40, '#9fd8ff', 800);
  for (let i = 0; i < BAG_N; i++) rvSlot(c, 'bag:' + i, bx + 12 + (i % 6) * 128, y0 + 78 + ((i / 6) | 0) * 128, 116, RP.bag[i], 'bag', RUI.zone === 'bag' && RUI.i === i);
  const cy0 = y0 + 78 + 4 * 128 + 24;
  for (let i = 0; i < 4; i++) rvBtn(c, 'chip:' + i, bx + 12 + (i % 2) * 378, cy0 + ((i / 2) | 0) * 84, 366, 72, i === 3 ? (RP.filter ? 'COMMONS HIDDEN' : 'HIDE COMMONS') : i === 2 ? 'SALVAGE MAGIC' : i === 1 ? 'SALVAGE COMMON' : 'SORT BAG', { fs: 34, r: 20, on: i === 3 && RP.filter });
  if (RUI.zone === 'chip') { rrect(c, bx + 6 + (RUI.i % 2) * 378, cy0 - 6 + ((RUI.i / 2) | 0) * 84, 378, 84, 24); c.lineWidth = 7; c.strokeStyle = '#fff'; c.stroke(); }
  const sel = uiSel(), item = sel.item, by = cy0 + 218; rvTxt(c, 'SELECTED ITEM', bx + 28, by - 18, 34, '#9fd8ff', 800);
  if (item) {
    const rc = rpgRerollCost(item), can = RP.dust >= rc.dust && RP.gold >= rc.gold;
    if (sel.where === 'bag') { rvBtn(c, 'act:equip', bx + 12, by, 366, 72, 'EQUIP', { primary: true, fs: 42 }); if (item.locked) rvBtn(c, '', bx + 390, by, 366, 72, 'LOCKED', { dim: true, static: true, fs: 38 }); else rvBtn(c, 'act:salv', bx + 390, by, 366, 72, 'SALVAGE +' + rpgSalvageValue(item, RT.S.dustFind), { fs: 38 }); }
    else { rvBtn(c, 'act:unequip', bx + 12, by, 366, 72, 'UNEQUIP', { primary: true, fs: 42 }); rvBtn(c, '', bx + 390, by, 366, 72, '', { dim: true, static: true }); }
    rvBtn(c, 'act:lock', bx + 12, by + 84, 366, 72, item.locked ? 'UNLOCK' : 'LOCK', { fs: 40 }); rvBtn(c, 'act:rrmode', bx + 390, by + 84, 366, 72, RUI.rr ? 'CANCEL REROLL' : 'REROLL ' + rc.dust + '+' + rc.gold + 'g', { fs: 36, dim: !can && !RUI.rr });
  } else rvTxt(c, 'point at an item or move the cursor', bx + 28, by + 40, 38, '#6f8aa0', 600);
  rvTooltip(c, tx, y0, tw, hh);
}
function rvSheet(c) {
  const S = RT.S, sh = RT.sheet, T = TUNING, lv = RP.level, au = RPG_TUNING.autoPerLevel * (lv - 1), xpn = lv >= RPG_TUNING.levelCap ? 0 : rpgXpNext(lv), g = TB.gravity, jh = v => (v * v / (2 * g)).toFixed(1) + ' m', P1 = x => (x * 100).toFixed(1) + '%';
  rvPanelBg(c, 40, 130, 720, 1010, 26); rvTxt(c, 'ATTRIBUTES', 68, 186, 40, '#9fd8ff', 800); rvTxt(c, 'LEVEL ' + lv + (lv >= RPG_TUNING.levelCap ? ' (MAX)' : ''), 68, 270, 78, '#ffe27a', 900);
  rvTxt(c, 'XP ' + rfmt(RP.xp) + ' / ' + (xpn ? rfmt(xpn) : '-'), 68, 330, 42, '#cfe0ee', 700); rvTxt(c, 'POINTS TO SPEND  ' + RP.free, 68, 384, 44, '#ffe27a', 900);
  const att = [['power', 'POWER', 'All damage'], ['agility', 'AGILITY', 'Speed, jump, crit'], ['resolve', 'RESOLVE', 'Health, defence']];
  for (let i = 0; i < 3; i++) {
    const y = 420 + i * 150, a = att[i], id = 'attr:' + i, hot = rvHot(id); RV.btns.push({ id, x: 60, y, w: 680, h: 130 }); rrect(c, 60, y, 680, 130, 22); c.fillStyle = RUI.sheetRow === i ? 'rgba(255,226,122,.2)' : hot ? 'rgba(160,220,255,.18)' : 'rgba(255,255,255,.06)'; c.fill(); c.lineWidth = RUI.sheetRow === i ? 6 : 3; c.strokeStyle = RUI.sheetRow === i ? '#ffe27a' : 'rgba(255,255,255,.3)'; c.stroke();
    rvTxt(c, a[1], 90, y + 56, 48, '#fff', 900); rvTxt(c, a[2], 90, y + 106, 38, '#a9bccb', 600); rvTxt(c, String(attrShow(a[0], au)), 560, y + 88, 70, '#fff', 900, 'right'); rrect(c, 600, y + 20, 112, 90, 20); c.fillStyle = RP.free ? '#ffc54a' : 'rgba(255,255,255,.12)'; c.fill(); rvTxt(c, '+', 656, y + 92, 78, RP.free ? '#2a1400' : '#5a6b7b', 900, 'center');
  }
  c.font = '600 36px ' + VFONT; wrapLines(c, 'Each level: +1 to every attribute and ' + RPG_TUNING.pointsPerLevel + ' points to spend. Power +1.2% damage. Agility +0.4% run, +0.6% jump, +0.2% crit. Resolve +7 health, +0.2% damage reduction.', 650, _wl); c.fillStyle = '#a9bccb'; c.textAlign = 'left'; for (let i = 0; i < _wl.length && i < 6; i++) c.fillText(_wl[i], 68, 890 + i * 42);
  rvPanelBg(c, 780, 130, 1228, 1010, 26); rvTxt(c, 'DERIVED', 808, 186, 40, '#9fd8ff', 800);
  const L = [['Max health', RT.max], ['Regeneration', S.regenHp.toFixed(1) + ' /s'], ['Damage reduction', P1(S.reduce)], ['Run speed', T.run.toFixed(1) + ' m/s'], ['Sprint speed', T.sprint.toFixed(1) + ' m/s'], ['Jump / triple', jh(T.jump[0]) + ' / ' + jh(T.jump[2])], ['Wall grip', P1(S.wallGrip)], ['Pound radius', T.pound.radius.toFixed(1) + ' m'], ['Crit chance', P1(S.critTotal)],
    ['Crit power', 'x' + S.critMul.toFixed(2)], ['Rewind charges', S.rewindCharges + ' (' + S.rewindRate.toFixed(2) + '/s)'], ['Cube burst', '+' + P1(S.burstSize)], ['Magic find', P1(S.magicFind)], ['Gold find', P1(S.goldFind)], ['Shard find', P1(S.dustFind)], ['Experience', '+' + P1(S.xpGain)], ['Loot magnet', S.magnetR.toFixed(1) + ' m'], ['Health on kill', P1(S.lifeOnKill)]];
  rvStatBlock(c, 808, 246, 560, L.slice(0, 9), 50, 40); rvStatBlock(c, 1420, 246, 560, L.slice(9), 50, 40);
  rvTxt(c, 'OFFENSE  ·  PER HIT / DPS-ISH', 808, 760, 40, '#9fd8ff', 800);
  const O = [['Punch', rfmt(sh.punch) + ' / ' + rfmt(sh.dpsPunch)], ['Dive', rfmt(sh.dive)], ['Stomp', rfmt(sh.stomp) + ' / ' + rfmt(sh.dpsStomp)], ['Ground pound', rfmt(sh.pound) + ' / ' + rfmt(sh.dpsPound)], ['Rewind pulse', rfmt(sh.pulse)], ['Avg crit factor', 'x' + sh.crit.toFixed(2)]];
  rvStatBlock(c, 808, 820, 560, O.slice(0, 3), 50, 40); rvStatBlock(c, 1420, 820, 560, O.slice(3), 50, 40);
  if (S.powers.length) { rvTxt(c, 'LEGENDARY POWERS', 808, 1010, 38, '#ffb15e', 800); for (let i = 0; i < S.powers.length && i < 3; i++) rvTxt(c, RPG_LEG_BY_ID[S.powers[i]].name + ': ' + RPG_LEG_BY_ID[S.powers[i]].text, 808, 1056 + i * 42, 36, '#ffe9c8', 600, 'left', 1170); }
}
function rvPerksTab(c) {
  const ids = Object.keys(RP.perks).filter(k => RP.perks[k] > 0), pages = Math.max(1, Math.ceil(ids.length / RV_PERKS_PER_PAGE)); RV.pkPage = clamp(RV.pkPage, 0, pages - 1);
  rvPanelBg(c, 40, 130, 1968, 1010, 26); rvTxt(c, 'PERKS  ·  ' + ids.length + ' OF ' + RPG_PERKS.length + ' LEARNED', 68, 186, 40, '#9fd8ff', 800);
  let y = 216; if (RP.pending) { rvBtn(c, 'perkgo', 68, y, 1912, 96, 'PERK READY  ·  ' + RP.pending + ' PICK' + (RP.pending > 1 ? 'S' : '') + ' WAITING  ·  A: CHOOSE', { primary: true, fs: 48 }); y += 118; }
  if (!ids.length) { rvTxt(c, 'No perks yet.', 1024, 560, 56, '#a9bccb', 800, 'center'); rvTxt(c, 'Every level you choose 1 of 3.', 1024, 630, 42, '#7d93a6', 600, 'center'); return; }
  const top = y, ch = Math.floor((1010 - top) / 4) - 12; if (!RV.scratch) RV.scratch = document.createElement('canvas');
  for (let n = 0; n < RV_PERKS_PER_PAGE; n++) {
    const id = ids[RV.pkPage * RV_PERKS_PER_PAGE + n]; if (!id) break; const p = RPG_PERK_BY_ID[id], r = RP.perks[id], x = 68 + (n % 2) * 964, yy = top + ((n / 2) | 0) * (ch + 12);
    rrect(c, x, yy, 948, ch, 22); c.fillStyle = 'rgba(255,255,255,.07)'; c.fill(); c.lineWidth = 3; c.strokeStyle = 'rgba(255,214,107,.4)'; c.stroke();
    rpgSigil(RV.scratch, p.glyph, '#ffd66b'); c.drawImage(RV.scratch, x + 14, yy + (ch - 104) / 2, 104, 104);
    rvTxt(c, p.name, x + 136, yy + 50, 44, '#fff', 900, 'left', 560); for (let i = 0; i < p.max; i++) rvDiamond(c, x + 906 - i * 34, yy + 34, 12, i < r ? '#ffd66b' : 'rgba(255,255,255,.18)');
    c.font = '600 36px ' + VFONT; wrapLines(c, p.desc(r), 780, _wl); c.fillStyle = '#c4d4e2'; c.textAlign = 'left'; for (let i = 0; i < _wl.length && i < 2; i++) c.fillText(_wl[i], x + 136, yy + 94 + i * 40);
  }
  if (pages > 1) { rvBtn(c, 'pkpg:-1', 760, 1040, 150, 76, '<', { fs: 48, r: 20 }); rvTxt(c, 'PAGE ' + (RV.pkPage + 1) + ' / ' + pages, 1024, 1092, 42, '#cfe0ee', 800, 'center'); rvBtn(c, 'pkpg:1', 1138, 1040, 150, 76, '>', { fs: 48, r: 20 }); }
}
function rvCodex(c) {
  rvPanelBg(c, 40, 130, 1968, 1010, 26); rvTxt(c, 'LEGENDARY CODEX  ·  ' + Object.keys(RP.codex).length + ' / ' + RPG_LEGENDARIES.length, 68, 186, 40, '#9fd8ff', 800);
  for (let i = 0; i < RPG_LEGENDARIES.length; i++) {
    const L = RPG_LEGENDARIES[i], got = RP.codex[L.id], x = 68 + (i % 3) * 648, y = 200 + ((i / 3) | 0) * 232, id = 'cdx:' + i, hot = rvHot(id); RV.btns.push({ id, x, y, w: 632, h: 220 });
    rrect(c, x, y, 632, 220, 22); c.fillStyle = got ? 'rgba(88,42,10,.55)' : 'rgba(255,255,255,.05)'; c.fill(); c.lineWidth = RUI.cdx === i ? 7 : 3; c.strokeStyle = RUI.cdx === i ? '#fff' : hot ? 'rgba(160,220,255,.9)' : got ? 'rgba(255,138,42,.7)' : 'rgba(255,255,255,.2)'; c.stroke();
    rvTxt(c, RPG_SLOT_LABEL[L.slot].toUpperCase(), x + 24, y + 38, 34, got ? '#ffb15e' : '#6f8294', 800); rvTxt(c, got ? L.name : '? ? ?', x + 24, y + 86, 46, got ? '#ffd9a8' : '#6f8294', 900, 'left', 584);
    c.font = '600 34px ' + VFONT; wrapLines(c, got ? L.text : 'Not found yet.', 584, _wl); c.fillStyle = got ? '#e9d6bd' : '#5d7083'; c.textAlign = 'left'; for (let q = 0; q < _wl.length && q < 3; q++) c.fillText(_wl[q], x + 24, y + 130 + q * 35);
  }
}
function rvRift(c) {
  const D = RPG_TUNING.difficulty, { t, seed, sp } = riftInfo(), R = RPG_TUNING.rift, ok = RP.riftUnlocked, maxT = Math.min(R.maxTier, RP.bestRift + 1);
  rvPanelBg(c, 40, 130, 980, 1010, 26); rvTxt(c, 'CAMPAIGN DIFFICULTY', 68, 186, 40, '#9fd8ff', 800);
  const row = (i, y, lab, val, arrows) => {
    const id = 'rift:' + i, hot = rvHot(id) || rvHot(id + ':-1') || rvHot(id + ':1'); rrect(c, 60, y, 940, 110, 22); c.fillStyle = RUI.riftRow === i ? 'rgba(255,226,122,.2)' : hot ? 'rgba(160,220,255,.16)' : 'rgba(255,255,255,.06)'; c.fill(); c.lineWidth = RUI.riftRow === i ? 6 : 3; c.strokeStyle = RUI.riftRow === i ? '#ffe27a' : 'rgba(255,255,255,.3)'; c.stroke(); rvTxt(c, lab, 90, y + 70, 44, '#fff', 900);
    if (arrows) { RV.btns.push({ id: id + ':-1', x: 60, y, w: 470, h: 110 }, { id: id + ':1', x: 530, y, w: 470, h: 110 }); rvTxt(c, val, 880, y + 70, 44, '#ffe27a', 900, 'right'); rvArrow(c, 925, y + 55, 22, -1, '#cfe0ee'); rvArrow(c, 975, y + 55, 22, 1, '#cfe0ee'); }
    else { RV.btns.push({ id, x: 60, y, w: 940, h: 110 }); rvTxt(c, val, 970, y + 70, 44, '#ffe27a', 900, 'right'); }
  };
  row(0, 214, 'DIFFICULTY', D[RP.diff].name + (RP.diff > RP.diffUnlocked ? ' (locked)' : ''), true);
  c.font = '600 36px ' + VFONT; wrapLines(c, 'Next campaign run: monster level +' + D[RP.diff].mlvl + ', item level floor ' + D[RP.diff].ilvlFloor + ', enemy health x' + D[RP.diff].hp + ', damage x' + D[RP.diff].dmg + '. Finish the finale to unlock the next difficulty (' + (RP.diffUnlocked + 1) + ' of 3 open).', 920, _wl); c.fillStyle = '#a9bccb'; c.textAlign = 'left'; for (let i = 0; i < _wl.length && i < 5; i++) c.fillText(_wl[i], 68, 372 + i * 42);
  rvTxt(c, 'SHATTER RIFT' + (ok ? '' : '  ·  LOCKED'), 68, 640, 40, '#9fd8ff', 800);
  if (ok) { row(1, 668, 'RIFT TIER', 'TIER ' + t + '  (max ' + maxT + ')', true); row(2, 794, 'SEED', hexSeed(seed) + '   A = new', false); row(3, 920, 'ENTER RIFT', 'SHATTER >', false); }
  else { c.font = '700 40px ' + VFONT; wrapLines(c, 'Restore the world (clear the Act III finale) to unlock repeatable Shatter Rifts.', 900, _wl); c.fillStyle = '#a9bccb'; c.textAlign = 'left'; for (let i = 0; i < _wl.length; i++) c.fillText(_wl[i], 68, 720 + i * 50); }
  rvPanelBg(c, 1040, 130, 968, 1010, 26); rvTxt(c, 'RIFT PREVIEW', 1068, 186, 40, '#9fd8ff', 800);
  if (ok) {
    const L2 = [['MONSTER LEVEL', sp.mlvl + '-' + (sp.mlvl + 2)], ['ITEM LEVEL', String(rpgItemLevel({ plvl: RP.level, act: 3, diff: 0, rift: sp.tier }))], ['KILLS FOR GUARDIAN', String(sp.need)], ['TIME LIMIT', fmtTime(sp.limit)], ['BEST CLEARED TIER', RP.bestRift ? String(RP.bestRift) : 'none']];
    rvStatBlock(c, 1068, 256, 912, L2, 58, 42); let y = 580;
    for (const m of sp.mods) { rrect(c, 1068, y - 40, 912, 52, 14); c.fillStyle = 'rgba(255,177,94,.16)'; c.fill(); rvTxt(c, RPG_RIFT_MODS[m].name, 1084, y, 40, '#ffb15e', 900); y += 54; c.font = '600 35px ' + VFONT; wrapLines(c, RPG_RIFT_MODS[m].text, 890, _wl); c.fillStyle = '#c4d4e2'; c.textAlign = 'left'; for (let i = 0; i < _wl.length && i < 2; i++) { c.fillText(_wl[i], 1084, y); y += 40; } y += 22; }
    rvTxt(c, 'Families: ' + mobRiftFamilies(sp.seed, sp.tier).map(f => MOB_FAMILIES[f].name).join(', '), 1068, 1056, 35, '#9fd8ff', 700); rvTxt(c, 'The same seed always builds the same arena.', 1068, 1100, 35, '#7d93a6', 600);
  } else rvTxt(c, 'Rifts are timed arena runs with a guardian at 100%.', 1068, 300, 40, '#a9bccb', 600, 'left', 900);
}
function rvPerkPick(c) {
  const W = UI.rp.pw; rvTxt(c, 'LEVEL ' + RP.level, W / 2, 190, 110, '#ffe27a', 900, 'center'); rvTxt(c, RP.pending > 1 ? 'CHOOSE A PERK  ·  ' + RP.pending + ' PICKS WAITING' : 'CHOOSE A PERK', W / 2, 270, 54, '#cfe0ee', 800, 'center');
  const n = PK.choices.length, cw = 600, gap = 44, x0 = (W - (n * cw + (n - 1) * gap)) / 2; if (!RV.scratch) RV.scratch = document.createElement('canvas');
  for (let i = 0; i < n; i++) {
    const p = PK.choices[i], rk = (RP.perks[p.id] || 0) + 1, x = x0 + i * (cw + gap), y = 350, h = 660, f = PK.i === i, id = 'pk:' + i, hot = rvHot(id); RV.btns.push({ id, x, y, w: cw, h });
    rrect(c, x, y, cw, h, 32); const g = c.createLinearGradient(0, y, 0, y + h); g.addColorStop(0, f || hot ? 'rgba(70,110,150,.95)' : 'rgba(34,52,74,.92)'); g.addColorStop(1, f || hot ? 'rgba(30,60,96,.95)' : 'rgba(16,28,42,.92)'); c.fillStyle = g; c.fill(); c.lineWidth = f ? 10 : 4; c.strokeStyle = f ? '#ffe27a' : hot ? '#bfe6ff' : 'rgba(255,255,255,.35)'; c.stroke();
    rpgSigil(RV.scratch, p.glyph, f ? '#ffe27a' : '#ffd66b'); c.drawImage(RV.scratch, x + cw / 2 - 100, y + 36, 200, 200);
    rvTxt(c, p.name, x + cw / 2, y + 300, 58, '#fff', 900, 'center', cw - 40); rvTxt(c, 'RANK ' + rk + ' / ' + p.max, x + cw / 2, y + 362, 42, '#ffd66b', 800, 'center');
    c.font = '600 48px ' + VFONT; wrapLines(c, p.desc(rk), cw - 70, _wl); c.fillStyle = '#e3eef7'; c.textAlign = 'center'; for (let q = 0; q < _wl.length && q < 6; q++) c.fillText(_wl[q], x + cw / 2, y + 446 + q * 60);
    c.beginPath(); c.arc(x + 44, y + 44, 30, 0, TAU); c.fillStyle = f ? '#ffe27a' : 'rgba(255,255,255,.2)'; c.fill(); c.textBaseline = 'middle'; rvTxt(c, String(i + 1), x + 44, y + 46, 38, f ? '#2a1400' : '#fff', 900, 'center'); c.textBaseline = 'alphabetic';
  }
}
function vrDrawRp() {
  const p = UI.rp, c = p.ctx, W = p.pw, H = p.ph; c.clearRect(0, 0, W, H); RV.btns.length = 0; c.textBaseline = 'alphabetic';
  rrect(c, 8, 8, W - 16, H - 16, 50); const gr = c.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, 'rgba(12,28,46,.96)'); gr.addColorStop(1, 'rgba(6,14,24,.96)'); c.fillStyle = gr; c.fill(); c.lineWidth = 7; c.strokeStyle = 'rgba(255,214,107,.9)'; c.stroke();
  if (UI.mode === 'perk') { if (PK.open) rvPerkPick(c); rvTxt(c, 'STICK choose   A confirm   TRIGGER click a card', W / 2, 1196, 40, '#9fd8ff', 700, 'center'); }
  else {
    rvHeader(c); [rvItems, rvSheet, rvPerksTab, rvCodex, rvRift, rvGems][RUI.tab](c);
    const k = UI.cap, armed = RUI.tab === 0 && RUI.armed && RT.real - RUI.armed.t < 2.6;
    const foot = RUI.tab === 0 ? ['A equip / unequip   X salvage (twice)   Y lock   B back   GRIPS tabs   STICK cursor   TRIGGER click', 'Hold Y to close. Pointing at a slot selects it. Rare+ drops, chests and elites get name plates in the world.'] : RUI.tab === 1 ? ['A spend a point   STICK select   GRIPS tabs   B close   TRIGGER click', ''] : RUI.tab === 4 ? ['A change / start   STICK left-right adjust   GRIPS tabs   B close   TRIGGER click', ''] : RUI.tab === 2 ? ['STICK up-down page   A open the pick   GRIPS tabs   B close   TRIGGER click', ''] : RUI.tab === 5 ? ['STICK cursor   A socket / take   X hotbar / stash   Y lock   GRIPS tabs   B close   TRIGGER click', 'Pointing at a cell selects it. A gem in a socket of its own colour counts as +1 level; linked sockets share supports.'] : ['STICK cursor   GRIPS tabs   B close   TRIGGER click', ''];
    rvTxt(c, foot[0], W / 2, 1196, 38, '#9fd8ff', 700, 'center', W - 80);
    if (armed) rvTxt(c, 'SALVAGE: press X again to confirm', W / 2, 1246, 40, '#ffb15e', 800, 'center', W - 80); else if (k.toastOn) rvTxt(c, k.toast, W / 2, 1246, 40, '#fff4d8', 800, 'center', W - 80); else if (foot[1]) rvTxt(c, foot[1], W / 2, 1246, 35, '#6f8aa0', 600, 'center', W - 80);
  }
  p.tex.needsUpdate = true; RV.dirty = false;
}

// ---- actions: the same code paths as flat play (uiKey / uiAct / perkKey / invReroll ...) ---------------------------------------------------------------------------------
function vrRpgHover(id) { // pointing at a slot selects it, exactly like the mouse does in the DOM
  if (UI.mode === 'cls') { gvClsHover(id); return; } if (UI.mode === 'inv' && RUI.tab === 5) { gvGemHover(id); return; }
  if (UI.mode === 'perk') { if (id.startsWith('pk:')) { const i = +id.slice(3); if (PK.open && i !== PK.i) { PK.i = i; RV.dirty = true; } } return; }
  if (RUI.tab === 0) { const eq = id.startsWith('eq:'); if (eq || id.startsWith('bag:')) { const zone = eq ? 'eq' : 'bag', i = +id.slice(eq ? 3 : 4); if (RUI.zone !== zone || RUI.i !== i) { RUI.zone = zone; RUI.i = i; RUI.rr = null; RV.dirty = true; } } }
  else if (RUI.tab === 3 && id.startsWith('cdx:')) { const i = +id.slice(4); if (RUI.cdx !== i) { RUI.cdx = i; RV.dirty = true; } }
}
function vrRpgClick(id) {
  sfx('click'); if (UI.mode === 'cls') { gvClsClick(id); return; }
  if (UI.mode === 'perk') { if (PK.open && id.startsWith('pk:')) { PK.i = +id.slice(3); perkPick(PK.i); RV.dirty = true; } return; }
  if (!RUI.open) return; const sel = uiSel();
  if (id.startsWith('gz:') || id.startsWith('ga:')) { gvGemClick(id); return; }
  if (id === 'close') { closeInv(); return; }
  if (id.startsWith('tab:')) { RUI.tab = +id.slice(4); RUI.rr = null; RUI.armed = null; rsfx('ui'); rpgRenderInv(); return; }
  if (id.startsWith('bag:') || id.startsWith('eq:')) { const eq = id.startsWith('eq:'); RUI.zone = eq ? 'eq' : 'bag'; RUI.i = +id.slice(eq ? 3 : 4); RUI.rr = null; uiAct('A'); rpgRenderInv(); return; }
  if (id.startsWith('chip:')) { RUI.zone = 'chip'; RUI.i = +id.slice(5); invChip(RUI.i); rpgRenderInv(); return; }
  if (id.startsWith('act:')) { const a = id.slice(4); if (a === 'equip' || a === 'unequip') uiAct('A'); else if (a === 'salv') { RUI.armed = { k: 'b' + sel.idx, t: RT.real }; uiAct('X'); } else if (a === 'lock') uiAct('Y'); else if (a === 'rrmode') uiAct('RT'); rpgRenderInv(); return; }
  if (id.startsWith('rr:')) { if (invReroll(sel, +id.slice(3))) RUI.rr = null; rpgRenderInv(); return; }
  if (id.startsWith('attr:')) { RUI.sheetRow = +id.slice(5); uiAct('A'); return; }
  if (id === 'perkgo') { uiAct('A'); return; }
  if (id.startsWith('pkpg:')) { RV.pkPage += +id.slice(5); RV.dirty = true; return; }
  if (id.startsWith('rift:')) { const q = id.split(':'); RUI.riftRow = +q[1]; if (q.length > 2) { uiRiftAdjust(+q[2]); rpgRenderInv(); } else uiAct('A'); return; }
}
function vrRpgStep(d, h) {
  vrHaptic(h, 0.1, 8);
  if (G.state === 'perk') { perkKey(d === 1 ? 'arrowleft' : 'arrowright'); return; }
  if (RUI.tab === 2 && (d === 3 || d === 4)) { RV.pkPage += d === 4 ? 1 : -1; RV.dirty = true; rsfx('ui'); return; }
  uiKey(d === 1 ? 'arrowleft' : d === 2 ? 'arrowright' : d === 3 ? 'arrowup' : 'arrowdown');
}
function vrRpgActions(rdt, L, R) { // inventory / perk pick open: the Touch controls become menu controls (called from vrActions, which then returns)
  if (CSU.open) { gvClsActions(rdt, L, R); return; }
  const perk = G.state === 'perk'; let ax = R.has ? R.ax : 0, ay = R.has ? R.ay : 0, hh = 1; if (L.has && Math.hypot(L.ax, L.ay) > Math.hypot(ax, ay)) { ax = L.ax; ay = L.ay; hh = 0; }
  const rep = RV.rep, on = rep.dir ? 0.3 : 0.62; let d = 0;
  if (Math.abs(ax) > Math.abs(ay)) { if (ax < -on) d = 1; else if (ax > on) d = 2; } else { if (ay < -on) d = 3; else if (ay > on) d = 4; }
  if (!d) rep.dir = 0; else if (d !== rep.dir) { rep.dir = d; rep.t = 0.36; vrRpgStep(d, hh); } else { rep.t -= rdt; if (rep.t <= 0) { rep.t = 0.11; vrRpgStep(d, hh); } }
  if (R.rise & 4) { if (perk) perkKey(' '); else uiKey(' '); }
  if (!perk) {
    if (R.rise & 8) uiKey('z');
    if (L.rise & 4) uiKey('j');
    if (L.rise & 2) uiKey('q'); if (R.rise & 2) uiKey('shift');
    if (L.e & 8) { RV.yHold += rdt; RV.yFr++; if (RV.yHold >= 0.4 && RV.yFr >= 12 && !VR.yDone) { VR.yDone = true; closeInv(); } } else { if (RV.yFr > 0 && !VR.yDone && G.state === 'inv') uiKey('e'); RV.yHold = 0; RV.yFr = 0; VR.yDone = false; }
  } else { RV.yHold = 0; RV.yFr = 0; VR.yDone = false; }
}
// Y outside the inventory: a short tap is pause / resume (acted on at release); holding it for 0.4 s opens the inventory instead. Returns true when the inventory just opened.
function vrYLogic(rdt, L) {
  if (L.rawRise & 8) { RV.yHold = 0; RV.yFr = 0; VR.yDone = false; VR.yArm = G.state; }
  if (L.m & 8) { if (VR.yArm !== '') { RV.yHold += rdt; RV.yFr++; if (RV.yHold >= 0.4 && RV.yFr >= 12 && !VR.yDone) { VR.yDone = true; if (openInv()) { VR.yArm = ''; return true; } } } } /* >= 12 frames as well as 0.4 s (29 frames at 72 Hz): on a slow emulator rdt is 0.25 s per frame, so a 2-frame test tap would otherwise count as a hold */
  else { if (VR.yArm !== '' && !VR.yDone && VR.yArm === G.state) { if (G.state === 'play') pauseGame(); else if (G.state === 'pause') resumeGame(); } VR.yArm = ''; RV.yHold = 0; RV.yFr = 0; VR.yDone = false; }
  return false;
}

// ---- HUD strip panel (rift bar, boss bar, banner, loot log) -----------------------------------------------------------------------------------------------------------
function vrHudWant(now) { return !!RIFT || !!rpgBossRef() || (RV.ban.on && now < RV.ban.until) || RV.log[0].until > now || RV.log[1].until > now; }
function vrHudSig(now) {
  const h = RV.hs, rl = RIFT ? Math.max(0, RIFT.limit - RIFT.t) | 0 : -1, rp = RIFT ? (RIFT.phase === 'fight' ? Math.min(100, (RIFT.prog / RIFT.need * 100) | 0) : 100) : -1, g = rpgBossRef(), bh = g ? Math.ceil(g.rpg.hp / g.rpg.maxhp * 40) : -1;
  const ban = RV.ban.on && now < RV.ban.until ? 1 + (RV.ban.until | 0) : 0, lg = (RV.logSeq << 2) | (RV.log[0].until > now ? 1 : 0) | (RV.log[1].until > now ? 2 : 0), key = RIFT ? RIFT.seed : -1, ph = RIFT ? (RIFT.phase === 'fight' ? 0 : RIFT.phase === 'guardian' ? 1 : 2) : -1;
  if (h.rl !== rl || h.rp !== rp || h.ph !== ph || h.bh !== bh || h.ban !== ban || h.log !== lg || h.key !== key) { h.rl = rl; h.rp = rp; h.ph = ph; h.bh = bh; h.ban = ban; h.log = lg; h.key = key; return true; }
  return false;
}
function vrDrawHud(now) {
  const p = UI.hudP, c = p.ctx, W = p.pw, H = p.ph; c.clearRect(0, 0, W, H); c.textBaseline = 'alphabetic'; const B = RV.ban;
  if (B.on && now < B.until) {
    rrect(c, 8, 8, W - 16, 200, 40); c.fillStyle = B.leg ? 'rgba(70,28,6,.93)' : 'rgba(12,30,52,.93)'; c.fill(); c.lineWidth = 6; c.strokeStyle = B.leg ? '#ff9a3a' : '#ffe27a'; c.stroke();
    rvTxt(c, B.h, W / 2, 100, 84, B.leg ? '#ffb15e' : '#ffe27a', 900, 'center', W - 80); rvTxt(c, B.p, W / 2, 164, 40, '#ffe9c8', 700, 'center', W - 80);
  } else {
    let y = 8;
    if (RIFT) {
      const left = Math.max(0, RIFT.limit - RIFT.t), pr = RIFT.phase === 'fight' ? RIFT.prog / RIFT.need : 1;
      rrect(c, 8, y, W - 16, 150, 36); c.fillStyle = 'rgba(10,22,38,.92)'; c.fill(); c.lineWidth = 5; c.strokeStyle = 'rgba(83,224,208,.9)'; c.stroke();
      rvTxt(c, fmtTime(left), 44, y + 104, 92, left < 30 ? '#ff8f7a' : '#fff4d8', 900); rvTxt(c, 'RIFT TIER ' + RIFT.tier + '  ·  SEED ' + hexSeed(RIFT.seed), 330, y + 52, 36, '#9fd8ff', 800);
      rrect(c, 330, y + 68, 640, 34, 17); c.fillStyle = 'rgba(255,255,255,.12)'; c.fill(); if (pr > 0.01) { rrect(c, 330, y + 68, Math.max(34, 640 * clamp(pr, 0, 1)), 34, 17); c.fillStyle = RIFT.phase === 'fight' ? '#53e0d0' : '#ffb15e'; c.fill(); }
      rvTxt(c, (RIFT.phase === 'fight' ? Math.min(100, Math.floor(pr * 100)) + '%  ·  ' : RIFT.phase === 'guardian' ? 'DEFEAT THE GUARDIAN  ·  ' : '') + RIFT.mods.map(m => RPG_RIFT_MODS[m].name.toUpperCase()).join('  ·  '), 330, y + 134, 32, '#cfe0ee', 700, 'left', 640); y += 160;
    }
    const g = rpgBossRef();
    if (g) { rrect(c, 8, y, W - 16, 112, 30); c.fillStyle = 'rgba(40,12,16,.93)'; c.fill(); c.lineWidth = 5; c.strokeStyle = '#ff6a4a'; c.stroke(); rvTxt(c, g.rpg.name.toUpperCase(), W / 2, y + 48, 40, '#ffb1a0', 900, 'center', W - 100); rrect(c, 44, y + 62, W - 88, 30, 15); c.fillStyle = 'rgba(255,255,255,.14)'; c.fill(); const f = clamp(g.rpg.hp / g.rpg.maxhp, 0, 1); if (f > 0.005) { rrect(c, 44, y + 62, Math.max(30, (W - 88) * f), 30, 15); c.fillStyle = '#ff5a3c'; c.fill(); } y += 122; }
    for (let i = 0; i < 2; i++) { const l = RV.log[i]; if (l.until > now && l.t) { c.font = '700 38px ' + VFONT; const tw = Math.min(W - 40, c.measureText(l.t).width + 60); rrect(c, W / 2 - tw / 2, y, tw, 58, 29); c.fillStyle = 'rgba(10,22,34,.9)'; c.fill(); c.lineWidth = 3; c.strokeStyle = l.c; c.stroke(); rvTxt(c, l.t, W / 2, y + 41, 38, l.c, 700, 'center', W - 100); y += 66; } }
  }
  p.tex.needsUpdate = true;
}

// ---- loot / chest / elite name plates (3D text sprites) --------------------------------------------------------------------------------------------------------------
function vrRpgBuildPlates() {
  for (let i = 0; i < VRT.rpgPlates; i++) {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 128; const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, toneMapped: false })); spr.scale.set(3, 0.75, 1); spr.renderOrder = 40; spr.visible = false; scene.add(spr);
    RV.plates.push({ spr, cv, ctx: cv.getContext('2d'), tex, ref: null, kind: 0, hp: -2, seed: -1 }); RV.cand.push({ ref: null, kind: 0, d2: 0 });
  }
}
function vrDrawPlate(pl, name, sub, col, hp) {
  const c = pl.ctx, W = 512, H = 128; c.clearRect(0, 0, W, H); rrect(c, 4, 4, W - 8, H - 8, 26); c.fillStyle = 'rgba(8,16,28,.86)'; c.fill(); c.lineWidth = 5; c.strokeStyle = col; c.stroke(); c.textBaseline = 'alphabetic';
  rvTxt(c, name, W / 2, hp >= 0 ? 52 : 62, 46, col, 900, 'center', W - 36); rvTxt(c, sub, W / 2, hp >= 0 ? 88 : 104, 32, '#cfe0ee', 700, 'center', W - 36);
  if (hp >= 0) { rrect(c, 40, 100, W - 80, 14, 7); c.fillStyle = 'rgba(255,255,255,.16)'; c.fill(); if (hp > 0.01) { rrect(c, 40, 100, Math.max(14, (W - 80) * hp), 14, 7); c.fillStyle = '#ff5a3c'; c.fill(); } }
  pl.tex.needsUpdate = true;
}
function vrPlatePut(ref, kind, d2) { // keeps RV.cand sorted ascending by d2 (slot objects are only permuted, never allocated)
  const cand = RV.cand, N = cand.length; if (d2 > VRT.rpgPlateVis * VRT.rpgPlateVis) return; let i = RV.putN < N ? RV.putN : N - 1; if (RV.putN >= N && d2 >= cand[N - 1].d2) return; if (RV.putN < N) RV.putN++;
  while (i > 0 && cand[i - 1].d2 > d2) { const a = cand[i]; cand[i] = cand[i - 1]; cand[i - 1] = a; i--; } const q = cand[i]; q.ref = ref; q.kind = kind; q.d2 = d2;
}
function vrRpgPlates(rdt) {
  RV.plateT -= rdt; const N = RV.plates.length; if (!N) return;
  if (RV.plateT <= 0) { // choose the nearest N plate-worthy things (rare+ loot, act chests, elites / guardians)
    RV.plateT = 0.2; RV.putN = 0; const px = P.x, pz = P.z;
    for (let i = 0; i < LOOT.length; i++) { const L = LOOT[i]; if (L.kind === 'item' && L.rar >= 2) vrPlatePut(L, 1, (L.x - px) * (L.x - px) + (L.z - pz) * (L.z - pz)); }
    for (let i = 0; i < CHESTS.length; i++) { const k = CHESTS[i]; if (!k.open && k.act) vrPlatePut(k, 2, (k.x - px) * (k.x - px) + (k.z - pz) * (k.z - pz)); }
    for (let i = 0; i < ENEMIES.length; i++) { const e = ENEMIES[i]; if (e.alive && e.rpg && e.rpg.tier !== 'normal' && e.state !== 'dead' && e.state !== 'squash') vrPlatePut(e, 3, (e.x - px) * (e.x - px) + (e.z - pz) * (e.z - pz)); }
    RV.selN = RV.putN;
    for (let i = 0; i < N; i++) { const pl = RV.plates[i]; if (i < RV.putN) { const q = RV.cand[i]; if (pl.ref !== q.ref) { pl.ref = q.ref; pl.kind = q.kind; pl.hp = -2; pl.seed = -1; } } else if (pl.ref) { pl.ref = null; pl.spr.visible = false; } }
  }
  let shown = 0;
  for (let i = 0; i < N; i++) {
    const pl = RV.plates[i], r = pl.ref; if (!r) continue;
    if (pl.kind === 1) { if (LOOT.indexOf(r) < 0) { pl.ref = null; pl.spr.visible = false; continue; } if (pl.seed !== r.item.seed) { pl.seed = r.item.seed; vrDrawPlate(pl, rpgItemName(r.item), 'ilvl ' + r.item.ilvl + ' ' + RPG_SLOT_LABEL[r.item.slot], RPG_RARITY_COL[r.rar], -1); } pl.spr.position.set(r.x, r.y + VRT.rpgPlateY, r.z); }
    else if (pl.kind === 2) { if (r.open) { pl.ref = null; pl.spr.visible = false; continue; } if (pl.seed !== 1) { pl.seed = 1; vrDrawPlate(pl, 'ACT CHEST', 'open it for loot', RPG_RARITY_COL[2], -1); } pl.spr.position.set(r.x, r.y + VRT.rpgPlateY, r.z); }
    else { const R = r.rpg; if (!r.alive || !R || r.state === 'dead' || r.state === 'squash') { pl.ref = null; pl.spr.visible = false; continue; } const hb = Math.ceil(clamp(R.hp / R.maxhp, 0, 1) * 10); if (pl.seed !== R.lvl || pl.hp !== hb) { pl.seed = R.lvl; pl.hp = hb; vrDrawPlate(pl, R.name, 'Lv ' + R.lvl + ' ' + R.tier.toUpperCase(), R.col, hb / 10); } pl.spr.position.set(r.x, r.y + VRT.rpgPlateY * (r.mesh.scale.y || 1) * 0.9 + 1.2, r.z); }
    const q = pl.spr.position, dx = q.x - CP.x, dy = q.y - CP.y, dz = q.z - CP.z, w = clamp(Math.sqrt(dx * dx + dy * dy + dz * dz) / VR.S * VRT.rpgPlateK, VRT.rpgPlateMin, VRT.rpgPlateMax); pl.spr.scale.set(w, w * 0.25, 1); // the eye can be a few cm from a plate on the near side of the table: keep its angular size constant
    for (let j = 0; j < i; j++) { const o = RV.plates[j]; if (o.ref === null) continue; const p = o.spr.position, hh = o.spr.scale.y * VR.S; if (Math.abs(p.x - q.x) < 3 && Math.abs(p.z - q.z) < 3 && Math.abs(p.y - q.y) < hh * 1.05) q.y = p.y + hh * 1.1; } // plates of loot that dropped on the same spot stack instead of overlapping
    pl.spr.visible = pl.kind === 3 ? r.mesh.visible : pl.kind === 2 ? r.g.visible : true; if (pl.spr.visible) shown++;
  }
  RV.nPlates = shown;
}

// ---- diorama limits for RPG objects: distance cull, beam cap + shortening, aura trimming ----------------------------------------------------------------------------------
function vrRpgWalk(root, mode, on) { // closure-free walk over a model: mode 0 = toon outline meshes visible, 1 = merged meshes cast shadows (iterative: no allocation)
  const st = RV.st; let n = 0; st[n++] = root;
  while (n > 0) { const o = st[--n], ud = o.userData; if (ud) { if (mode === 0) { if (ud.vrO) ud.vrO.visible = on; } else if (ud.vrM) ud.vrM.castShadow = on; } const ch = o.children; for (let i = 0; i < ch.length; i++) st[n++] = ch[i]; }
}
function vrRpgOutline(root, on) { vrRpgWalk(root, 0, on); }
function vrRpgShadow(root, on) { vrRpgWalk(root, 1, on); } // enemies / chests do not cast into the small VR shadow map (one draw call each saved)
function vrRpgCull(rdt) {
  RV.cullT -= rdt; if (RV.cullT > 0) return; RV.cullT = 0.1; const R2 = VRT.rpgVis * VRT.rpgVis, O2 = VRT.rpgOutline * VRT.rpgOutline, px = P.x, pz = P.z, bm = VRT.rpgBeamMax, bk = VRT.rpgBeamK; let nb = 0;
  for (let i = 0; i < ENEMIES.length; i++) {
    const e = ENEMIES[i]; if (!e.alive) continue; const dx = e.x - px, dz = e.z - pz, d2 = dx * dx + dz * dz, v = d2 < R2 || (RIFT !== null && e === RIFT.guardian); if (e.mesh.visible !== v) e.mesh.visible = v;
    if (v) { const ol = d2 < (e.vrOut ? O2 * 1.6 : O2) || (e.rpg !== undefined && e.rpg.tier !== 'normal'); if (e.vrOut !== ol) { e.vrOut = ol; vrRpgOutline(e.mesh, ol); } if (!e.vrSh) { e.vrSh = true; vrRpgShadow(e.mesh, false); } } // toon outline = a second mesh per enemy: only close up
    if (v && e.aura) { const u = e.aura.userData; if (u.beam) { const on = nb < bm; if (u.beam.visible !== on) u.beam.visible = on; if (on) { nb++; u.beam.scale.y = u.beamH * bk; } } }
  }
  for (let i = 0; i < CHESTS.length; i++) { const k = CHESTS[i], dx = k.x - px, dz = k.z - pz, v = dx * dx + dz * dz < R2; if (k.g.visible !== v) k.g.visible = v; if (!k.vrSh) { k.vrSh = true; vrRpgShadow(k.g, false); } if (k.beam) { const on = v && nb < bm; if (k.beam.visible !== on) k.beam.visible = on; if (on) { nb++; k.beam.scale.y = 34 * bk; } } }
  for (let i = 0; i < CRATES.length; i++) { const k = CRATES[i]; if (!k.alive) continue; const dx = k.x - px, dz = k.z - pz, v = dx * dx + dz * dz < R2; if (k.m.visible !== v) k.m.visible = v; if (k.m.castShadow) k.m.castShadow = false; }
  let nl = 0, nr = 0; // gold piles / shards / common items: only the newest few are drawn (pickup still works for all of them); rare+ items: the newest 6 (their name plates / beams stay)
  for (let i = LOOT.length - 1; i >= 0; i--) { const L = LOOT[i], dx = L.x - px, dz = L.z - pz, d2 = dx * dx + dz * dz; let v; if (L.kind !== 'item' || L.rar < 2) { v = d2 < R2 * 1.5 && nl < VRT.rpgLootMax; if (v) nl++; } else { v = nr < 6; if (v) nr++; } if (L.g.visible !== v) L.g.visible = v;
    if (L.beam) { const on = v && d2 < R2 * 1.5 && nb < bm; if (L.beam.visible !== on) L.beam.visible = on; if (on) { nb++; L.beam.scale.y = BEAM_H[L.rar] * bk; } } }
  RV.nBeams = nb;
}
function vrRpgRestore() { // leaving VR: everything the diorama limits hid comes back
  for (const e of ENEMIES) { e.vrOut = undefined; if (e.vrSh) { e.vrSh = false; vrRpgShadow(e.mesh, true); } if (e.alive) e.mesh.visible = true; if (e.aura) { const u = e.aura.userData; if (u.orbs) for (const o of u.orbs) o.visible = true; if (u.beam) { u.beam.visible = true; u.beam.scale.y = u.beamH; } } }
  for (const k of CHESTS) { k.g.visible = true; if (k.vrSh) { k.vrSh = false; vrRpgShadow(k.g, true); } if (k.beam) { k.beam.visible = true; k.beam.scale.y = 34; } } for (const k of CRATES) if (k.alive) { k.m.visible = true; k.m.castShadow = true; }
  for (const L of LOOT) { L.g.visible = true; if (L.beam) { L.beam.visible = true; L.beam.scale.y = BEAM_H[L.rar]; } }
  for (const pl of RV.plates) { pl.ref = null; pl.spr.visible = false; } RV.nPlates = 0; if (UI.hudP) UI.hudP.mesh.visible = false; if (UI.rp) UI.rp.mesh.visible = false;
  if (RUI.open) rpgRenderInv(); if (PK.open) renderPerks();
}

// ---- per-frame glue (called from vrPre / vrRenderPrep) -----------------------------------------------------------------------------------------------------------------------
function vrRpgPre(rdt) {
  vrHapTick(); vrRpgCull(rdt); vrRpgPlates(rdt);
  const open = UI.mode === 'inv' || UI.mode === 'perk' || UI.mode === 'sta'; RV.open = open;
  if (open) { const armed = !!RUI.armed && RT.real - RUI.armed.t < 2.6; if (armed !== RV.armedOn) { RV.armedOn = armed; RV.dirty = true; } }
}
function vrRpgRenderPrep() {
  const now = performance.now();
  if (UI.rp.mesh.visible && RV.dirty && now - RV.drawT >= 70) { RV.drawT = now; vrDrawRp(); } // a 2048 x 1280 redraw + mipmapped upload: at most ~14 per second (hover highlights, cursor moves)
  const want = UI.mode === 'none' && vrHudWant(now) ? 1 : 0; if (want && vrHudSig(now)) vrDrawHud(now);
  const p = UI.hudP; vrPlacePanel(p, VR.hpx + Math.sin(VR.capAng) * 1.1, Math.max(0.5, VR.hpy - 0.17), VR.hpz + Math.cos(VR.capAng) * 1.1, VR.hpx, VR.hpz);
  p.mat.opacity += (want - p.mat.opacity) * 0.25; p.mesh.visible = p.mat.opacity > 0.02; if (!want && !p.mesh.visible) RV.hs.rl = -3;
}
function vrRpgBuild() {
  UI.rp = vrPanel(VRT.rpgPanelW, VRT.rpgPanelW * 0.625, 2048, 1280, true); rig.add(UI.rp.mesh);
  UI.hudP = vrPanel(0.8, 0.3, 1024, 384, false); UI.hudP.mat.opacity = 0; rig.add(UI.hudP.mesh);
  vrRpgBuildPlates();
}
// </vr-rpg>

