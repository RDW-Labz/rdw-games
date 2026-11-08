// ---- resolve: every active skill with its linked supports, the hotbar, Spark ----------------------------------------------------------------------------------------------------------------
function gemRebuild() {
  GM.dirty = false; const S = RT.S, d = classDef(RP.cls), eq = Object.assign({}, RP.equipped, { core: RP.core }); GM.active = gemCollect(eq, GEM_ROWS);
  for (const a of GM.active) { a.R = gemFinal(gemResolve(a.gem, a.sups.map(q => q.gem), { aff: d.aff, skillCol: a.skillCol, supCols: a.supCols }), S); a.R.uid = a.gem.u; if (d.fx.gustCheap && a.R.tags.includes('gust')) a.R.cost = Math.max(1, Math.round(a.R.cost * 0.85 * 10) / 10); if (STAR.on && STAR.fx.cdMul) a.R.cd *= STAR.fx.cdMul; }
  const now = new Set(GM.active.map(a => a.gem.u)), prev = GM.prevUids; // skills that just became active take the first free hotbar slot
  if (prev) for (const a of GM.active) if (!prev.has(a.gem.u) && !RP.hot.includes(a.gem.u)) { const i = RP.hot.findIndex(u => !u || !now.has(u)); if (i >= 0) RP.hot[i] = a.gem.u; }
  GM.prevUids = now; for (let i = 0; i < 4; i++) { const a = RP.hot[i] ? gemFindActive(RP.hot[i]) : null; GM.slot[i] = a; GM.cdMax[i] = a ? a.R.cd : 1; if (a) a.R.slotI = i; }
  GM.sparkMax = gemSparkMax(S); GM.spark = Math.min(GM.spark, GM.sparkMax);
}

