// ---- gem loot on the ground ----------------------------------------------------------------------------------------------------------------------------------------------------------------
const GEMLOOT_GEO = new THREE.OctahedronGeometry(0.3, 0).scale(0.8, 1.25, 0.8), GEMLOOT_MAT = {}; for (const k in GEM_COLORS) GEMLOOT_MAT[k] = new THREE.MeshStandardMaterial({ color: hexNum(GEM_COLORS[k].css), emissive: hexNum(GEM_COLORS[k].css), emissiveIntensity: 1.0, roughness: 0.25, metalness: 0.2 });
function gemLootBuild(L, g) { // called from spawnLoot (patched): mesh + beam by gem tier
  const d = GEM_BY_ID[g.id]; L.gd = g; L.rar = d.tier; L.val = 0; const m = new THREE.Mesh(GEMLOOT_GEO, GEMLOOT_MAT[d.color]); m.scale.setScalar(1.2 + d.tier * 0.15); m.castShadow = !VR.presenting; L.gem = m; L.g.add(m);
  if (d.tier > 0) { const b = new THREE.Mesh(LOOT_GEO.beam, LOOT_BEAM[d.tier]); b.scale.set(1, BEAM_H[d.tier] * 0.8, 1); b.position.y = -0.2; b.frustumCulled = false; L.g.add(b); L.beam = b; }
}
function gemPickupLoot(L, force) {
  const g = L.gd, d = GEM_BY_ID[g.id], i = gemBagFree();
  if (i < 0) { if (force) { const v = gemSalvageValue(g); RP.dust += v; RUN.dust += v; rpgFree(L); return true; } if (RT.real - GM.bagWarnT > 3) { GM.bagWarnT = RT.real; toast('GEM BAG FULL - open the inventory, GEMS tab'); rsfx('deny'); } L.blocked = true; return false; }
  RP.gems[i] = g; RT.dirty = true; rsfx('pick' + Math.min(3, d.tier + 1)); rpgLogLine('+ Gem: ' + d.name + '  Lv ' + g.lv, RPG_RARITY_COL[d.tier]); sparkBurst(L.x, L.y, L.z, 8, hexNum(GEM_COLORS[d.color].css), 4); rpgFree(L); if (RUI.open && RUI.tab === 5) rpgRenderInv(); return true;
}
function gemDropAt(src, x, y, z, mlvl) {
  const D = GEM_TUNING.drop, p = (D.p[src] || 0) * (1 + ((RT.S && RT.S.magicFind) || 0) * 0.5); if (!(gemRand() < p)) return; const n = 1 + (D.extra[src] || 0);
  for (let i = 0; i < n; i++) { const ilvl = rpgItemLevel({ plvl: RP.level, act: RIFT ? 3 : G.act, diff: rpgDiffIdx(), rift: RIFT ? RIFT.tier : 0 }), seed = (gemRand() * 4294967296) >>> 0; const g = gemGen(seed, { ilvl, source: src, mf: RT.S ? RT.S.magicFind : 0 }); spawnLoot('gem', x, y, z, g); rsfx('drop' + Math.min(3, GEM_BY_ID[g.id].tier + 1)); }
}
const _rpgDrops = rpgDrops;
rpgDrops = function (srcKey, x, y, z, mlvl, extra = {}) { _rpgDrops(srcKey, x, y, z, mlvl, extra); gemDropAt(srcKey, x, y, z, mlvl); gemFormDrop(srcKey, x, y, z); };

