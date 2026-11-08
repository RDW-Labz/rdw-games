// ---- quests from shards / rifts ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
{ const _cs = collectShard; collectShard = function (s) { const had = s.got; _cs(s); if (!had && s.got) { townQuest('shard', {}); if (!RIFT) { const put = []; for (const r of foodRollDrops(rpgRng(rpgHashSeed(TOWN.seed ^ 0x5A8D, FD.n++)), 'shard', null, 'normal', 0)) put.push(fdGive(fdKindOf(r.id), r.id, r.n, true) + ' ' + fdDef(r.id).name); if (put.length) rpgLogLine('Shard bloom: ' + put.join(', '), '#ffe27a'); } } }; }
{ const _re = rpgRiftEnd; rpgRiftEnd = function (win, why) { const was = RIFT && RIFT.done, fams = RIFT ? RIFT.fams : null; _re(win, why); if (win && !was && fams) townQuest('rift', { fams }); }; }
// ---- keys: H = quick potion, B = the pack ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
{ const _k = rpgKeyDown; rpgKeyDown = function (k) { if (!PK.open && !RUI.open && !CSU.open && G.state === 'play') { if (k === 'h') { fdQuickPotion(); return; } if (k === 'b' && typeof suiOpen === 'function') { suiOpen('pack'); return; } } _k(k); }; }
// ---- test / debug API -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
window.__food = {
  state() { return { sat: JSON.parse(JSON.stringify(TOWN.sat)), buffs: JSON.parse(JSON.stringify(TOWN.buffs)), known: Object.keys(TOWN.known), seen: Object.keys(TOWN.seen), hot: foodHot(TOWN.buffs), mods: foodMods(TOWN.buffs), cap: townCap() }; },
  give(kind, id, n = 1) { return fdGive(kind, id, n, true); }, take(kind, id, n = 1) { return satTake(TOWN.sat, kind, id, n); }, count(kind, id) { return satCount(TOWN.sat, kind, id); }, use(kind, key) { const r = fdUse(kind, key, true); return r.ok ? { ok: true, buff: r.buff } : r; }, quickPotion() { return fdQuickPotion(); },
  nodes() { return FD.nodes.map(q => ({ kind: q.kind, id: q.id, n: q.n, on: q.on, x: q.x, y: q.y, z: q.z })); }, spawnNode(kind, id, n, dist = 3) { const x = P.x + Math.sin(P.yaw) * dist, z = P.z + Math.cos(P.yaw) * dist, y = floorAt(x, z, P.y + 3); if (!(y > -1e8)) return null; return !!fdAddNode(kind, x, y, z, id, n); }, nodeDraw() { return FN.built ? { herb: FN.herb.count, ore: FN.ore.count, vis: FN.herb.visible || FN.ore.visible } : null; },
  loot() { return LOOT.filter(L => L.kind === 'ing' || L.kind === 'mat').map(L => ({ kind: L.kind, id: L.id, n: L.n, landed: L.landed })); }, drop(kind, id, n = 1, dist = 2) { return !!spawnLoot(kind, P.x + Math.sin(P.yaw) * dist, P.y, P.z + Math.cos(P.yaw) * dist, { id, n }); },
  recipes() { const ctx = { tiers: townTiers(TOWN), seen: TOWN.seen, known: TOWN.known, level: RP.level }; return FOOD_RECIPE_IDS.filter(id => foodRecipeKnown(FOOD_RECIPES[id], ctx)); }, discover() { return fdDiscover(true); },
  stats() { return { hp: RT.hp, max: RT.max, regen: RT.S.regenHp, dmg: RT.S.dmgMul, run: RT.S.runSpd, fx: Object.assign({}, RT.S.fx) }; }, tick(sec) { foodTick(TOWN.buffs, sec); rpgRecalc(); }, icon: (k, i) => fdIcon(k, i).toDataURL(),
  core: { foodResolve, foodCook, foodMakeBuff, foodApplyBuff, foodRollDrops, foodSalvageMats, FOOD_RECIPES, INGS, MATS },
};
{ const d0 = window.__dbg; window.__dbg = () => { const d = d0(); d.food = { buffs: TOWN.buffs.length, sat: satTotal(TOWN.sat), nodes: FD.nodes.filter(q => q.on).length, loot: LOOT.filter(L => L.kind === 'ing' || L.kind === 'mat').length }; return d; }; }
rpgRecalc();
// </food-game>

