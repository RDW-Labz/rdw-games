// ---- persistence: the class slots + gem state ride in snapshot.x (the top-level fields stay the ACTIVE class's, so old readers still work) -----------------------------------------
function coreClean(c, clsId) {
  const d = classDef(clsId), base = classStarterCore(d, d.tree.slot + 1); if (!c || !c.lay || typeof c.lay.c !== 'string') return base;
  const lay = { c: c.lay.c.replace(/[^RGB]/g, '').slice(0, 4) || 'RRB', l: String(c.lay.l || '').replace(/[^01]/g, '').slice(0, 3) }; const gems = new Array(lay.c.length).fill(null); (c.gems || []).slice(0, lay.c.length).forEach((g, i) => { gems[i] = gemClean(g); });
  return { slot: 'core', lay, gems };
}
function hotClean(h) { const o = [0, 0, 0, 0]; if (Array.isArray(h)) h.slice(0, 4).forEach((v, i) => { o[i] = v | 0; }); return o; }
function slotClean(raw, id) {
  const s = classNewSlot(id, BAG_N, GEM_TUNING.bagN); if (!raw || typeof raw !== 'object') return s;
  s.level = sat(raw.level | 0 || 1, 1, RPG_TUNING.levelCap); s.xp = Math.max(0, +raw.xp || 0); s.free = Math.max(0, raw.free | 0); s.pending = Math.max(0, raw.pending | 0); s.picks = raw.picks | 0;
  s.spent = { power: raw.spent?.power | 0, agility: raw.spent?.agility | 0, resolve: raw.spent?.resolve | 0 }; s.perks = {}; for (const k in (raw.perks || {})) if (RPG_PERK_BY_ID[k]) s.perks[k] = sat(raw.perks[k] | 0, 0, RPG_PERK_BY_ID[k].max);
  s.bag = new Array(BAG_N).fill(null); (raw.bag || []).slice(0, BAG_N).forEach((it, i) => { s.bag[i] = rpgCleanItem(it); }); for (const k of RPG_EQUIP) s.equipped[k] = rpgCleanItem(raw.equipped && raw.equipped[k]);
  s.gems = gemPad((raw.gems || []).map(gemClean), GEM_TUNING.bagN); s.hot = hotClean(raw.hot); s.core = coreClean(raw.core, id); return s;
}
const _rpgCleanItem = rpgCleanItem;
rpgCleanItem = function (it) { // sockets / socketed gems / resocket count ride along with the item
  const o = _rpgCleanItem(it); if (!o) return o;
  if (it.lay && typeof it.lay.c === 'string') o.lay = { c: it.lay.c.replace(/[^RGB]/g, '').slice(0, 4), l: String(it.lay.l || '').replace(/[^01]/g, '').slice(0, 3) };
  if (it.sr) o.sr = sat(it.sr | 0, 0, 20);
  if (Array.isArray(it.gems)) { const g = it.gems.slice(0, 4).map(gemClean); if (g.some(Boolean)) o.gems = g; }
  return o;
};
const _rpgSnapshot = rpgSnapshot;
rpgSnapshot = function () {
  const s = _rpgSnapshot(), slots = {}; for (const id in RP.slots) if (id !== RP.cls) slots[id] = RP.slots[id];
  s.x = { cls: RP.cls, unlocked: RP.unlocked, stash: RP.stash, gn: RP.gn, gems: RP.gems, hot: RP.hot, core: RP.core, slots }; return s;
};
const _rpgApplySnapshot = rpgApplySnapshot;
rpgApplySnapshot = function (s) {
  if (!_rpgApplySnapshot(s)) return false; const x = s.x || null;
  RP.cls = x && CLASSES[x.cls] ? x.cls : 'pip'; RP.unlocked = { pip: 1, lou: 1 }; if (x && x.unlocked) for (const id in x.unlocked) if (CLASSES[id] && x.unlocked[id]) RP.unlocked[id] = 1;
  RP.stash = gemPad(((x && x.stash) || []).map(gemClean), GEM_TUNING.stashN); RP.gn = x ? x.gn | 0 : 0; RP.gems = gemPad(((x && x.gems) || []).map(gemClean), GEM_TUNING.bagN); RP.hot = hotClean(x && x.hot);
  RP.core = x && x.core ? coreClean(x.core, RP.cls) : classStarterCore(classDef(RP.cls), classDef(RP.cls).tree.slot + 1); // a version-1 save (no gem data): the active class gets its starter rig
  if (!x) { const k = (classDef(RP.cls).start || {}).bag || []; k.forEach((gid, i) => { if (!RP.gems[i]) RP.gems[i] = { id: gid, lv: 1, xp: 0, u: gemUid((classDef(RP.cls).tree.slot * 1009 + (i + 1) * 131 + 77) >>> 0) }; }); }
  RP.slots = {}; if (x && x.slots) for (const id in x.slots) if (CLASSES[id] && id !== RP.cls) RP.slots[id] = slotClean(x.slots[id], id);
  GM.dirty = true; GM.prevUids = null; return true;
};

