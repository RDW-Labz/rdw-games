// ---- gem inventory operations (bag RP.gems = 30 cells, shared stash RP.stash = 20 cells, sockets on core + equipped gear, hotbar RP.hot = 4 uids) --------------------------------------------------
function gemTouch() { GM.dirty = true; RT.dirty = true; if (RUI.open) rpgRenderInv(); }
function gemBagFree() { return RP.gems.indexOf(null); }
function gemOpSocket(bi, row, idx) { // bag gem -> socket (swaps with an occupied socket)
  const g = RP.gems[bi], it = gemRowItem(row); if (!g || !it) return false; const L = gemSockets(it); if (idx < 0 || idx >= L.n) return false;
  it.gems = it.gems || new Array(L.n).fill(null); const old = it.gems[idx] || null; it.gems[idx] = g; RP.gems[bi] = old; gemTouch(); gsfx('gsocket'); return true;
}
function gemOpAuto(bi) { // best socket anywhere (core first on ties)
  const g = RP.gems[bi]; if (!g) return false; let best = null;
  for (const k of GEM_ROWS) { const it = gemRowItem(k); if (!it) continue; const t = gemPlaceTarget(it, g); if (t.i >= 0 && (!best || t.s > best.s)) best = { k, i: t.i, s: t.s }; }
  if (!best) { toast('No free socket for ' + GEM_BY_ID[g.id].name); gsfx('gdeny'); return false; } const ok = gemOpSocket(bi, best.k, best.i); if (ok) toast(GEM_BY_ID[g.id].name + ' socketed in ' + GEM_ROW_LABEL[best.k]); return ok;
}
function gemOpUnsocket(row, idx) {
  const it = gemRowItem(row); if (!it || !it.gems || !it.gems[idx]) return false; const f = gemBagFree(); if (f < 0) { toast('Gem bag is full'); gsfx('gdeny'); return false; }
  RP.gems[f] = it.gems[idx]; it.gems[idx] = null; if (!it.gems.some(Boolean)) delete it.gems; gemTouch(); gsfx('gunsock'); return true;
}
function gemOpStash(bi) { const g = RP.gems[bi]; if (!g) return false; const f = RP.stash.indexOf(null); if (f < 0) { toast('Stash is full'); gsfx('gdeny'); return false; } RP.stash[f] = g; RP.gems[bi] = null; gemTouch(); gsfx('gsocket'); return true; }
function gemOpUnstash(si) { const g = RP.stash[si]; if (!g) return false; const f = gemBagFree(); if (f < 0) { toast('Gem bag is full'); gsfx('gdeny'); return false; } RP.gems[f] = g; RP.stash[si] = null; gemTouch(); gsfx('gsocket'); return true; }
function gemOpSalvage(bi) { const g = RP.gems[bi]; if (!g) return false; if (g.lk) { toast('Locked: press ' + padTxt('Y') + ' to unlock first'); gsfx('gdeny'); return false; } const d = gemSalvageValue(g); RP.dust += d; RUN.dust += d; RP.gems[bi] = null; gemTouch(); rsfx('salvage'); rpgLogLine('Salvaged ' + GEM_BY_ID[g.id].name + ' (+' + d + ' shards)', '#53e0d0'); return true; }
function gemOpLock(g) { if (!g) return false; if (g.lk) delete g.lk; else g.lk = 1; gemTouch(); rsfx('lock'); return true; }
function gemOpSort() { const a = RP.gems.filter(Boolean).sort((x, y) => gemSortKey(x) - gemSortKey(y)); RP.gems = gemPad(a, GEM_TUNING.bagN); gemTouch(); rsfx('ui'); }
function gemOpResocket(row) { // re-roll an item's socket layout (gems return to the bag). Not for the core rig.
  const it = row === 'core' ? null : gemRowItem(row); if (!it) { toast('Only gear can be resocketed'); gsfx('gdeny'); return false; } const c = gemResocketCost(it), held = (it.gems || []).filter(Boolean).length;
  if (RP.dust < c.dust || RP.gold < c.gold) { toast('Need ' + c.dust + ' shards and ' + c.gold + ' gold'); gsfx('gdeny'); return false; }
  let free = 0; for (const g of RP.gems) if (!g) free++; if (free < held) { toast('Not enough free gem bag cells'); gsfx('gdeny'); return false; }
  for (const g of (it.gems || [])) if (g) RP.gems[gemBagFree()] = g; delete it.gems; delete it.lay; it.sr = (it.sr | 0) + 1; RP.dust -= c.dust; RP.gold -= c.gold; gemTouch(); rsfx('reroll'); toast('Sockets re-rolled: ' + (gemSocketSummary(it) || 'none')); return true;
}
function gemBind(slot, uid) { // hotbar: a gem may sit in one slot only
  if (slot < 0 || slot > 3) return false; for (let i = 0; i < 4; i++) if (RP.hot[i] === uid && uid) RP.hot[i] = RP.hot[slot]; RP.hot[slot] = uid | 0; gemTouch(); return true;
}
function gemFindActive(uid) { for (const a of GM.active) if (a.gem.u === uid) return a; return null; }

function gemLevelFx(g, n) {
  GM.levelUps++; const d = GEM_BY_ID[g.id]; gsfx('glevel'); toast('GEM LEVEL UP  ·  ' + d.name + '  Lv ' + g.lv, 2200); fxRing(P.x, P.y + 0.1, P.z, 0.4, 3.2, 0.7, hexNum(GEM_COLORS[d.color].css), 0.9); sparkBurst(P.x, P.y + 1.2, P.z, 14, hexNum(GEM_COLORS[d.color].css), 5);
}
function gemGainXp(g, amt) { if (!g) return; const up = gemAddXp(g, amt * (1 + ((RT.S && RT.S.gemXp) || 0))); RT.dirty = true; if (up) { GM.dirty = true; gemLevelFx(g, up); if (RUI.open && RUI.tab === 5) rpgRenderInv(); } }

