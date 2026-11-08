// ---- class slots: the live RP fields mirror the active class; switching stashes them and loads another slot (shared: gold, dust, codex, stash, rifts, difficulty) -------------------------------------
function clsStashLive() { const s = RP.slots[RP.cls] || (RP.slots[RP.cls] = {}); for (const k of GEM_FIELDS) s[k] = RP[k]; s.tree = s.tree || { id: RP.cls, start: classDef(RP.cls).tree.start, alloc: [] }; return s; }
function clsCanSwitch() { return !RIFT && (G.state === 'menu' || G.state === 'pause' || G.state === 'dead' || G.state === 'cls' || G.state === 'inv'); }
function clsSwitch(id, opt = {}) {
  if (!CLASSES[id] || id === RP.cls) return false; if (!classUnlocked(CLASSES[id], RP.unlocked)) { toast('Locked: ' + CLASSES[id].unlock.text); gsfx('gdeny'); return false; }
  if (STAR.on) starEnd(true); gemClearFx(); clsStashLive(); const slot = RP.slots[id] || (RP.slots[id] = classNewSlot(id, BAG_N, GEM_TUNING.bagN)); for (const k of GEM_FIELDS) RP[k] = slot[k];
  RP.cls = id; GM.dirty = true; GM.prevUids = null; GM.cd.fill(0); RT.runFlags = RT.runFlags || {}; rpgRecalc(); rpgHealFull(); GM.spark = GM.sparkMax; heroSetModel(id); P.size = 1; RT.dirty = true; rpgSaveNow(); updateBestLine();
  if (!opt.silent) { gsfx('gcls'); rpgLogLine('Now playing ' + classDef(id).name, '#ffe27a'); } rpgRenderMenu(); return true;
}
function clsUnlockEvent(ev) {
  let any = false; for (const id of CLASS_ORDER) { const d = CLASSES[id]; if (!RP.unlocked[id] && classMeetsUnlock(d, ev)) { RP.unlocked[id] = 1; any = true; rpgBanner('NEW CHARACTER', d.name.toUpperCase() + ' UNLOCKED  ·  ' + d.role, true); rpgLogLine(d.name + ' unlocked!', '#ffe27a'); gsfx('gunlock'); G.flash = Math.max(G.flash, 0.3); } }
  if (any) { RT.dirty = true; rpgSaveNow(); rpgRenderMenu(); } return any;
}

