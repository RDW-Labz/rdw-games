// ---- inventory / character UI (state object RUI): pad-first, mouse + keyboard too -------------------------------------------------------------------------------------------------------------------
const RUI = { stale: null, open: false, tab: 0, zone: 'bag', i: 0, from: 'play', rr: null, armed: null, hid: [], sheetRow: 0, cdx: 0, perkRow: 0, riftRow: 0, lastClick: { k: '', t: 0 } };
const TAB_NAMES = ['ITEMS', 'SHEET', 'PERKS', 'CODEX', 'RIFT', 'GEMS'], CHIPS = ['SORT', 'SALVAGE COMMONS', 'SALVAGE MAGIC', 'HIDE COMMONS'];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rcl = it => it ? 'r' + RPG_RARITIES.indexOf(it.rarity) : '';
const slotKey = (zone, i) => zone === 'eq' ? RPG_EQUIP[i] : zone === 'bag' ? 'b' + i : 'c' + i;
function uiSel() { // -> {item, where:'bag'|'eq', idx, slot}
  if (RUI.zone === 'bag') return { item: RP.bag[RUI.i], where: 'bag', idx: RUI.i }; if (RUI.zone === 'eq') return { item: RP.equipped[RPG_EQUIP[RUI.i]], where: 'eq', idx: RUI.i, slot: RPG_EQUIP[RUI.i] }; return { item: null, where: 'chip', idx: RUI.i };
}
function rpgCmpTarget(item) { // which equipped item would this replace?
  if (!item) return null; if (item.slot !== 'charm') return RP.equipped[item.slot]; const a = RP.equipped.charm1, b = RP.equipped.charm2; if (!a || !b) return null; return rpgItemScore(a) <= rpgItemScore(b) ? a : b;
}
function openInv(tab) {
  if (RUI.open || PK.open) return false; if (typeof tab !== 'number') tab = null; const st = G.state; if (!(st === 'play' || st === 'pause' || st === 'menu' || st === 'dead')) return false;
  if (st === 'play' && (G.trans || G.finale || P.dead)) { toast('Not now'); return false; }
  RUI.from = st; RUI.open = true; G.state = 'inv'; RUI.tab = tab != null ? tab : 0; RUI.stale = new Set(keys); mouseFire = mousePlace = padFireDown = padPlaceDown = false; RUI.hid = []; // keys stay as they are (a held stick must not go dead after the menu); held ones just don't count as RUI input
  for (const id of ['menu', 'dead', 'pause']) { const el = $(id); if (el && !el.classList.contains('hidden')) { el.classList.add('hidden'); RUI.hid.push(id); } }
  document.exitPointerLock && document.exitPointerLock(); RUI.rr = null; RUI.armed = null; if (RUI.tab === 0) { RUI.zone = 'bag'; const f = RP.bag.findIndex(x => x); RUI.i = f < 0 ? 0 : f; }
  $('inv').classList.remove('hidden'); rpgRenderInv(); rsfx('uiopen'); return true;
}
function closeInv() {
  if (!RUI.open) return; RUI.open = false; RUI.rr = null; RUI.armed = null; $('inv').classList.add('hidden'); const from = RUI.from;
  for (const id of RUI.hid) if (!(id === 'pause' && from === 'play')) $(id).classList.remove('hidden'); RUI.hid = [];
  if (from === 'play') { G.state = 'play'; $('pause').classList.add('hidden'); requestLock(); } else G.state = from; if (from === 'menu') rpgRenderMenu();
  rpgFlush(true); rsfx('uiclose');
}
function invEquip(i, slotPref) {
  const it = RP.bag[i]; if (!it) return false; let slot = it.slot; if (slot === 'charm') slot = slotPref || (!RP.equipped.charm1 ? 'charm1' : !RP.equipped.charm2 ? 'charm2' : (rpgItemScore(RP.equipped.charm1) <= rpgItemScore(RP.equipped.charm2) ? 'charm1' : 'charm2'));
  const old = RP.equipped[slot]; RP.equipped[slot] = it; RP.bag[i] = old; rpgRecalc(); rsfx('equip'); if (it.legendary) { sparkBurst(P.x, P.y + 1, P.z, 10, 0xff9a3a, 5); } return true;
}
function invUnequip(slot) { const it = RP.equipped[slot]; if (!it) return false; const i = rpgBagFree(); if (i < 0) { toast('Bag is full'); rsfx('deny'); return false; } RP.bag[i] = it; RP.equipped[slot] = null; rpgRecalc(); rsfx('equip'); return true; }
function invSalvage(i) {
  const it = RP.bag[i]; if (!it) return false; if (it.locked) { toast('Locked: press ' + padTxt('Y') + ' to unlock first'); rsfx('deny'); return false; } const d = rpgSalvageValue(it, RT.S.dustFind); RP.dust += d; RUN.dust += d; RP.totals.salvaged++; RP.bag[i] = null; rsfx('salvage'); RT.dirty = true; rpgLogLine('Salvaged ' + rpgItemName(it) + ' (+' + d + ' shards)', '#53e0d0'); return true;
}
function invLock(item) { if (!item) return false; item.locked = !item.locked; if (!item.locked) delete item.locked; rsfx('lock'); RT.dirty = true; return true; }
function invReroll(ref, k) {
  const it = ref.item; if (!it || !it.affixes[k]) return false; const c = rpgRerollCost(it); if (RP.dust < c.dust || RP.gold < c.gold) { toast('Need ' + c.dust + ' shards and ' + c.gold + ' gold'); rsfx('deny'); return false; }
  const nw = rpgRerollAffix(it, k, dseed()); if (!nw) { toast('No other affix can roll here'); rsfx('deny'); return false; } if (it.locked) nw.locked = true; RP.dust -= c.dust; RP.gold -= c.gold; RP.totals.rerolls++;
  if (ref.where === 'bag') RP.bag[ref.idx] = nw; else RP.equipped[ref.slot] = nw; rpgRecalc(); rsfx('reroll'); const a = RPG_AFFIX_BY_ID[nw.affixes[k].id]; rpgLogLine('Rerolled: ' + RPG_AFFIX_BY_ID[it.affixes[k].id].word + ' -> ' + a.word, '#ffe27a'); return true;
}
function invSort() { const items = RP.bag.filter(Boolean); items.sort((a, b) => (RPG_RARITIES.indexOf(b.rarity) - RPG_RARITIES.indexOf(a.rarity)) || (rpgItemScore(b) - rpgItemScore(a)) || (b.ilvl - a.ilvl)); RP.bag = items.concat(new Array(BAG_N - items.length).fill(null)); RUI.i = 0; rsfx('ui'); RT.dirty = true; toast('Bag sorted'); }
function invBulk(maxR) { let n = 0, d = 0; for (let i = 0; i < BAG_N; i++) { const it = RP.bag[i]; if (it && !it.locked && RPG_RARITIES.indexOf(it.rarity) <= maxR) { d += rpgSalvageValue(it, RT.S.dustFind); n++; RP.bag[i] = null; } } if (n) { RP.dust += d; RUN.dust += d; RP.totals.salvaged += n; rsfx('salvage'); RT.dirty = true; toast('Salvaged ' + n + ' items (+' + d + ' shards)'); } else { toast('Nothing to salvage (locked items are kept)'); rsfx('deny'); } }
function invChip(i) { if (i === 0) invSort(); else if (i === 1) invBulk(0); else if (i === 2) invBulk(1); else { RP.filter = !RP.filter; RT.dirty = true; rsfx('lock'); toast(RP.filter ? 'Common drops hidden (converted to gold)' : 'Showing all drops'); } }

