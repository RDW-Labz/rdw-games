// ---- input ----
function uiMove(dx, dy) {
  rsfx('ui'); RUI.armed = null;
  if (RUI.tab === 0) {
    if (RUI.rr) { const it = uiSel().item; if (dy) RUI.rr.row = (RUI.rr.row + dy + it.affixes.length) % it.affixes.length; rpgRenderInv(); return; }
    if (RUI.zone === 'eq') { const c = RUI.i % 2, r = (RUI.i / 2) | 0; if (dx > 0 && c === 1) { RUI.zone = 'bag'; RUI.i = Math.min(3, r) * 6; } else if (dx) RUI.i = r * 2 + sat(c + dx, 0, 1); else RUI.i = sat(r + dy, 0, 2) * 2 + c; }
    else if (RUI.zone === 'bag') { const c = RUI.i % 6, r = (RUI.i / 6) | 0; if (dx < 0 && c === 0) { RUI.zone = 'eq'; RUI.i = Math.min(2, r) * 2 + 1; } else if (dx) RUI.i = r * 6 + sat(c + dx, 0, 5); else if (dy < 0 && r === 0) { RUI.zone = 'chip'; RUI.i = Math.min(3, c >> 1); } else RUI.i = sat(r + dy, 0, 3) * 6 + c; }
    else { if (dx) RUI.i = sat(RUI.i + dx, 0, 3); else if (dy > 0) { RUI.zone = 'bag'; RUI.i = RUI.i * 2; } }
  } else if (RUI.tab === 1) { if (dy) RUI.sheetRow = sat(RUI.sheetRow + dy, 0, 2); }
  else if (RUI.tab === 3) { const n = RPG_LEGENDARIES.length, cols = 3; if (dx) RUI.cdx = sat(RUI.cdx + dx, 0, n - 1); else RUI.cdx = sat(RUI.cdx + dy * cols, 0, n - 1); }
  else if (RUI.tab === 4) { if (dy) RUI.riftRow = sat(RUI.riftRow + dy, 0, RP.riftUnlocked ? 3 : 0); else if (dx) uiRiftAdjust(dx); }
  rpgRenderInv();
}
function uiRiftAdjust(dx) {
  if (RUI.riftRow === 0) { RP.diff = sat(RP.diff + dx, 0, RP.diffUnlocked); RT.dirty = true; rpgRenderMenu(); }
  else if (RUI.riftRow === 1 && RP.riftUnlocked) { RP.riftTier = sat(RP.riftTier + dx, 1, Math.min(RPG_TUNING.rift.maxTier, RP.bestRift + 1)); RP.riftSeed = 0; RT.dirty = true; }
  else if (RUI.riftRow === 2 && RP.riftUnlocked) { RP.riftSeed = (dseed() & 0xFFFFFF) | 1; }
}
function uiAct(kind) { // A / X / Y / RT / LT on the current tab
  if (RUI.tab === 0) {
    const sel = uiSel();
    if (kind === 'A') {
      if (RUI.rr) { if (invReroll(sel, RUI.rr.row)) { RUI.rr = null; } rpgRenderInv(); return; }
      if (sel.where === 'chip') invChip(sel.idx); else if (sel.where === 'bag' && sel.item) invEquip(sel.idx); else if (sel.where === 'eq' && sel.item) invUnequip(sel.slot); else rsfx('deny'); rpgRenderInv();
    } else if (kind === 'X') {
      if (sel.where !== 'bag' || !sel.item) { if (sel.where === 'eq' && sel.item) { toast('Unequip it first (' + padTxt('A') + '), then salvage'); } rsfx('deny'); return; }
      if (sel.item.rarity === 'common' || (RUI.armed && RUI.armed.k === 'b' + sel.idx && RT.real - RUI.armed.t < 2.6)) { invSalvage(sel.idx); RUI.armed = null; } else { RUI.armed = { k: 'b' + sel.idx, t: RT.real }; toast('Press ' + padTxt('X') + ' again to salvage ' + rpgItemName(sel.item)); rsfx('ui'); } rpgRenderInv();
    } else if (kind === 'Y') { if (sel.item) invLock(sel.item); else rsfx('deny'); rpgRenderInv(); }
    else if (kind === 'RT') { if (sel.item && sel.item.affixes.length) { RUI.rr = RUI.rr ? null : { row: 0 }; rsfx('ui'); } else { toast('Nothing to reroll'); rsfx('deny'); } rpgRenderInv(); }
    else if (kind === 'LT') { invSort(); rpgRenderInv(); }
  } else if (RUI.tab === 1) { if (kind === 'A') { const k = ['power', 'agility', 'resolve'][RUI.sheetRow]; if (RP.free > 0) { RP.free--; RP.spent[k]++; rpgRecalc(); rsfx('perk'); } else rsfx('deny'); rpgRenderInv(); } }
  else if (RUI.tab === 2) { if (kind === 'A' && RP.pending > 0) { closeInv(); openPerks(); } }
  else if (RUI.tab === 4) {
    if (kind === 'A') { if (RUI.riftRow === 0) { RP.diff = (RP.diff + 1) % (RP.diffUnlocked + 1); RT.dirty = true; rpgRenderMenu(); rsfx('ui'); rpgRenderInv(); } else if (RUI.riftRow === 1 && RP.riftUnlocked) { const mx = Math.min(RPG_TUNING.rift.maxTier, RP.bestRift + 1); RP.riftTier = RP.riftTier >= mx ? 1 : RP.riftTier + 1; RP.riftSeed = 0; rsfx('ui'); rpgRenderInv(); } else if (RUI.riftRow === 2 && RP.riftUnlocked) { RP.riftSeed = (dseed() & 0xFFFFFF) | 1; rsfx('ui'); rpgRenderInv(); } else if (RUI.riftRow === 3 && RP.riftUnlocked) { const { t, seed } = riftInfo(); closeInv(); rpgStartRift(t, seed); } }
  }
}
function uiTab(d) { RUI.tab = (RUI.tab + d + TAB_NAMES.length) % TAB_NAMES.length; RUI.rr = null; RUI.armed = null; if (RUI.tab === 0 && RUI.zone === 'chip') RUI.zone = 'bag'; rsfx('ui'); rpgRenderInv(); }
const UI_MAP = { arrowleft: 'L', a: 'L', arrowright: 'R', d: 'R', arrowup: 'U', w: 'U', arrowdown: 'D', s: 'D', ' ': 'A', enter: 'A', j: 'X', e: 'Y', z: 'B', escape: 'B', q: 'LB', shift: 'RB', i: 'CLOSE', tab: 'CLOSE', r: 'RT', t: 'LT', f: 'F' };
function uiKey(k) {
  const m = UI_MAP[k]; if (k >= '1' && k <= '6' && k.length === 1) { RUI.tab = +k - 1; RUI.rr = null; rpgRenderInv(); rsfx('ui'); return; } if (!m) return;
  if (m === 'L') uiMove(-1, 0); else if (m === 'R') uiMove(1, 0); else if (m === 'U') uiMove(0, -1); else if (m === 'D') uiMove(0, 1);
  else if (m === 'B') { if (RUI.rr) { RUI.rr = null; rpgRenderInv(); } else closeInv(); } else if (m === 'CLOSE') closeInv(); else if (m === 'LB') uiTab(-1); else if (m === 'RB') uiTab(1);
  else if (m === 'F') { invChip(3); rpgRenderInv(); } else uiAct(m);
}
// key repeat for held d-pad / stick directions
let uiRepT = 0, uiRepKey = '';
function uiRepeat(rdt) {
  if (!RUI.open && !PK.open) { uiRepKey = ''; return; } const stale = RUI.open ? RUI.stale : PK.stale; let hk = ''; for (const k of ['arrowleft', 'a', 'arrowright', 'd', 'arrowup', 'w', 'arrowdown', 's']) { if (stale && stale.has(k)) { if (!keys.has(k)) stale.delete(k); continue; } if (keys.has(k)) { hk = k; break; } }
  if (!hk) { uiRepKey = ''; return; } if (hk !== uiRepKey) { uiRepKey = hk; uiRepT = 0.38; return; } uiRepT -= rdt; if (uiRepT <= 0) { uiRepT = 0.11; (RUI.open ? uiKey : perkKey)(hk); }
}
$('inv').addEventListener('click', e => {
  const t = e.target; if (!RUI.open) return; const tab = t.closest('[data-tab]'); if (tab) { RUI.tab = +tab.dataset.tab; RUI.rr = null; rpgRenderInv(); rsfx('ui'); return; }
  const act = t.closest('[data-act]'); if (act) { const a = act.dataset.act, sel = uiSel(); if (a === 'equip') uiAct('A'); else if (a === 'unequip') uiAct('A'); else if (a === 'salv') { RUI.armed = { k: 'b' + sel.idx, t: RT.real }; uiAct('X'); } else if (a === 'lock') uiAct('Y'); else if (a === 'rrmode') uiAct('RT'); else if (a === 'rr') { if (invReroll(sel, +act.dataset.k)) RUI.rr = null; rpgRenderInv(); } return; }
  const el = t.closest('[data-z]'); if (!el) return; const z = el.dataset.z, i = el.dataset.i == null ? 0 : +el.dataset.i, key = z + i, now = performance.now(), dbl = RUI.lastClick.k === key && now - RUI.lastClick.t < 450; RUI.lastClick = { k: key, t: now };
  if (z === 'eq' || z === 'bag' || z === 'chip') { const same = RUI.zone === z && RUI.i === i; RUI.zone = z; RUI.i = i; if (z === 'chip') { invChip(i); rpgRenderInv(); } else if (dbl) { uiAct('A'); } else if (!same) { rsfx('ui'); rpgRenderInv(); } }
  else if (z === 'attr') { RUI.sheetRow = i; uiAct('A'); } else if (z === 'cdx') { RUI.cdx = i; rpgRenderInv(); } else if (z === 'perkgo') uiAct('A'); else if (z === 'rift') { RUI.riftRow = i; if (i <= 1) { const r = el.getBoundingClientRect(); uiRiftAdjust(e.clientX < r.left + r.width / 2 ? -1 : 1); rpgRenderInv(); } else uiAct('A'); }
});
$('inv').addEventListener('mouseover', e => { const el = e.target.closest('[data-z]'); if (!el || !RUI.open || RUI.tab !== 0) return; const z = el.dataset.z; if (z === 'chip' || z === 'attr') return; const i = +el.dataset.i; if (RUI.zone === z && RUI.i === i) return; RUI.zone = z; RUI.i = i; RUI.rr = null; rpgRenderInv(); });
$('inv').addEventListener('contextmenu', e => { e.preventDefault(); const el = e.target.closest('[data-z="bag"]'); if (el && RUI.open) { RUI.zone = 'bag'; RUI.i = +el.dataset.i; uiAct('X'); } });

