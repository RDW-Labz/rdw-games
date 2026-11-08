// ---- loot on the ground: items (rarity beams + plates), gold piles, shard dust ------------------------------------------------------------------------------
const LOOT = [], LOOT_MAT = RPG_RARITY_COL.map((c, i) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: i === 0 ? 0.25 : 0.9, roughness: 0.35, metalness: 0.3 }));
const LOOT_BEAM = RPG_RARITY_COL.map((c, i) => { const m = beamMat.clone(); m.uniforms.uTime = U.time; m.uniforms.uCol = { value: new THREE.Color(c).multiplyScalar(i === 3 ? 0.62 : 0.5) }; m.forceSinglePass = true; return m; }); // dimmed: the shader doubles it and additive blending over a bright sky would wash every rarity out to white
const LOOT_GEO = { gem: new THREE.OctahedronGeometry(0.3, 0), box: new THREE.BoxGeometry(0.34, 0.34, 0.34), beam: new THREE.CylinderGeometry(0.2, 0.42, 1, 12, 1, true).translate(0, 0.5, 0), coin: new THREE.CylinderGeometry(0.2, 0.2, 0.06, 14).rotateZ(PI / 2), dust: new THREE.OctahedronGeometry(0.17, 0) };
const GOLD_MAT = new THREE.MeshStandardMaterial({ color: 0xffc830, metalness: 0.85, roughness: 0.28, emissive: 0xffa000, emissiveIntensity: 0.55 }), DUST_MAT = new THREE.MeshStandardMaterial({ color: 0x53e0d0, emissive: 0x53e0d0, emissiveIntensity: 0.9, roughness: 0.3 });
const BEAM_H = [0, 7, 14, 42];
function spawnLoot(kind, x, y, z, payload) {
  const L = { kind, x, y: y + 0.6, z, vx: (Math.random() - 0.5) * 4, vy: 6 + Math.random() * 3, vz: (Math.random() - 0.5) * 4, t: 0, landed: false, g: new THREE.Group(), item: null, val: 0, ph: Math.random() * 6, sp: 0, rar: 0, gy: y };
  if (kind === 'item') {
    L.item = payload; L.rar = RPG_RARITIES.indexOf(payload.rarity); const gem = new THREE.Mesh(L.rar === 0 ? LOOT_GEO.box : LOOT_GEO.gem, LOOT_MAT[L.rar]); gem.scale.setScalar(1 + L.rar * 0.22); gem.castShadow = !VR.presenting; L.gem = gem; L.g.add(gem);
    if (L.rar > 0) { const b = new THREE.Mesh(LOOT_GEO.beam, LOOT_BEAM[L.rar]); b.scale.set(1 + (L.rar === 3 ? 0.7 : 0), BEAM_H[L.rar], 1 + (L.rar === 3 ? 0.7 : 0)); b.position.y = -0.2; b.frustumCulled = false; L.g.add(b); L.beam = b; }
  } else if (kind === 'gold') { L.val = payload; const c = new THREE.Mesh(LOOT_GEO.coin, GOLD_MAT); c.scale.setScalar(1 + Math.min(1.2, payload / 150)); L.gem = c; L.g.add(c); }
  else if (kind === 'gem') { gemLootBuild(L, payload); }
  else { L.val = payload; const c = new THREE.Mesh(LOOT_GEO.dust, DUST_MAT); L.gem = c; L.g.add(c); }
  L.g.position.set(L.x, L.y, L.z); scene.add(L.g); LOOT.push(L);
  if (LOOT.length > 60) { const o = LOOT.find(q => q.kind !== 'item' || q.rar === 0); if (o) rpgPickupLoot(o, true); }
  return L;
}
function rpgFree(L) { scene.remove(L.g); const i = LOOT.indexOf(L); if (i >= 0) LOOT.splice(i, 1); }
function rpgBagFree() { for (let i = 0; i < BAG_N; i++) if (!RP.bag[i]) return i; return -1; }
function rpgAddItem(item) { // bag, or auto-equip into an empty slot, or auto-salvage a common when full; returns where it went
  const empty = item.slot === 'charm' ? (!RP.equipped.charm1 ? 'charm1' : !RP.equipped.charm2 ? 'charm2' : null) : (!RP.equipped[item.slot] ? item.slot : null);
  if (empty) { RP.equipped[empty] = item; rpgRecalc(); return 'equipped'; }
  const i = rpgBagFree(); if (i >= 0) { RP.bag[i] = item; RT.dirty = true; return 'bag'; }
  if (item.rarity === 'common') { const d = rpgSalvageValue(item, RT.S.dustFind); RP.dust += d; RUN.dust += d; return 'salvaged'; }
  return null;
}
function rpgPickupLoot(L, force) {
  if (L.kind === 'gem') return gemPickupLoot(L, force);
  if (L.kind === 'gold') { const g = Math.round(L.val); RP.gold += g; RUN.gold += g; G.coins++; G.runCoins++; sfx('coin', Math.min(8, G.coinCombo++)); G.coinComboT = 0.8; RT.goldT = 5; if (RT.S.powers.includes('goldrush')) { RT.goldStack = Math.min(10, RT.goldStack + 1); RT.buffRun = 0.03 * RT.goldStack; rpgApplyTuning(); } floatText(L.x, L.y + 0.6, L.z, '+' + g, 'gold'); sparkBurst(L.x, L.y, L.z, 4, 0xffd040, 3); updateHUD(); rpgFree(L); RT.dirty = true; return true; }
  if (L.kind === 'dust') { const d = Math.max(1, Math.round(L.val)); RP.dust += d; RUN.dust += d; rsfx('dust'); floatText(L.x, L.y + 0.6, L.z, '+' + d + ' shards', 'xp'); sparkBurst(L.x, L.y, L.z, 4, 0x53e0d0, 3); rpgFree(L); RT.dirty = true; return true; }
  const it = L.item, where = rpgAddItem(it);
  if (!where) { if (!force && RT.real - RT.bagWarnT > 3) { RT.bagWarnT = RT.real; toast(VR.presenting ? 'BAG FULL - hold Y for the inventory and salvage something' : 'BAG FULL - open the inventory (I) and salvage something'); rsfx('deny'); } L.blocked = true; return false; }
  const ri = RPG_RARITIES.indexOf(it.rarity); RUN.loot[ri]++; RT.dirty = true; rsfx('pick' + ri); const nm = rpgItemName(it);
  rpgLogLine((where === 'equipped' ? 'Equipped ' : where === 'salvaged' ? 'Bag full, salvaged ' : '+ ') + nm + '  ilvl ' + it.ilvl, RPG_RARITY_COL[ri]);
  sparkBurst(L.x, L.y, L.z, 6 + ri * 5, new THREE.Color(RPG_RARITY_COL[ri]).getHex(), 4 + ri);
  if (it.legendary) { RUN.legends.push(it.legendary); if (!RP.codex[it.legendary]) { RP.codex[it.legendary] = 1; RP.totals.legends++; rpgBanner('LEGENDARY FOUND', RPG_LEG_BY_ID[it.legendary].name.toUpperCase() + '  ·  ADDED TO THE CODEX', true); G.flash = 0.25; } }
  rpgFree(L); return true;
}
function rpgDropItem(x, y, z, ctx) { // roll + place one item; honours the commons filter
  const ilvl = rpgItemLevel({ plvl: RP.level, act: RIFT ? 3 : G.act, diff: rpgDiffIdx(), rift: RIFT ? RIFT.tier : 0 });
  const it = rpgGenItem(dseed(), { ilvl, mf: RT.S.magicFind, source: ctx.source, minRarity: ctx.minRarity, w: classAffixWeights(classDef(RP.cls)) });
  if (RP.filter && it.rarity === 'common') { const g = Math.max(1, Math.round(rpgGoldDrop(ctx.mlvl || RP.level, RPG_TUNING.filterGold, 0.5) * RT.S.goldMul)); spawnLoot('gold', x, y, z, g); return null; }
  const L = spawnLoot('item', x, y, z, it); if (it.rarity !== 'common') { rsfx('drop' + RPG_RARITIES.indexOf(it.rarity)); if (it.rarity === 'legendary') { fxRing(x, y, z, 0.5, 6, 0.9, 0xff9a3a, 0.9); G.flash = Math.max(G.flash, 0.12); } } return L;
}
function rpgDrops(srcKey, x, y, z, mlvl, extra = {}) {
  const T = RPG_TUNING.drop, src = T.src[srcKey]; if (!src) return;
  if (drand() < src.gold[0]) { const g = Math.max(1, Math.round(rpgGoldDrop(mlvl, src.gold[1], drand()) * RT.S.goldMul * (RIFT ? RPG_TUNING.rift.goldMul : 1))); const n = g > 60 ? 3 : g > 25 ? 2 : 1; for (let i = 0; i < n; i++) spawnLoot('gold', x, y, z, g / n); }
  if (drand() < src.dust) { const d = (T.dust.base + T.dust.perLevel * mlvl) * (1 + RT.S.dustFind) * (srcKey === 'guardian' ? 4 : srcKey === 'elite' || srcKey === 'chest' || srcKey === 'actchest' ? 2 : 1); spawnLoot('dust', x, y, z, d); }
  if (drand() < src.p) { let n = src.n[0]; if (src.n[1] > n) for (let i = n; i < src.n[1]; i++) if (drand() < 0.5) n++; for (let i = 0; i < n; i++) rpgDropItem(x, y, z, { source: srcKey, mlvl, minRarity: extra.minRarity }); }
}
function rpgLootTick(dt) {
  const S = RT.S, magnetR = S.magnetR, bagFree = rpgBagFree() >= 0;
  for (let i = LOOT.length - 1; i >= 0; i--) {
    const L = LOOT[i]; L.t += dt; L.ph += dt * 2.4;
    if (!L.landed) {
      L.vy -= 26 * dt; L.x += L.vx * dt; L.z += L.vz * dt; L.y += L.vy * dt; const f = floorAt(L.x, L.z, L.y + 2.5), gr = f > -1e8 ? f : -1e9; // generous ceiling: loot that lands inside a slope is lifted onto it
      if (gr > -1e8 && L.y <= gr + 0.32 && L.vy < 0) { L.y = gr + 0.32; if (L.vy < -3.5) { L.vy *= -0.38; L.vx *= 0.55; L.vz *= 0.55; } else { L.landed = true; L.vy = 0; L.gy = gr; if (L.kind === 'item') { L.g.position.y = L.y; } } }
      if (L.y < P.y - 45) { L.x = P.x; L.z = P.z; L.y = P.y + 3; L.vy = 0; L.vx = L.vz = 0; }
    } else {
      const bob = L.kind === 'item' ? 0.18 + Math.sin(L.ph) * 0.08 : 0.1 + Math.sin(L.ph) * 0.05; L.y = L.gy + 0.32 + bob;
      const blocked = L.kind === 'item' && L.rar > 0 && !bagFree; // a full bag leaves non-common items where they are
      if (G.state === 'play' && !P.dead && L.t > 0.5 && !blocked) {
        const dx = P.x - L.x, dz = P.z - L.z, dy = P.y + 0.8 - L.y, dh = Math.hypot(dx, dz), d = Math.hypot(dh, dy); // magnet reach is horizontal (loot in a river bed or a pit still comes up); pull is 3D
        if (dh < RPG_TUNING.magnet.pickup && Math.abs(dy) < 2.4 && rpgPickupLoot(L)) continue;
        if (dh < magnetR && Math.abs(dy) < 5) { const sp = (7 + (magnetR - d) * 6) * dt; L.x += dx / d * sp; L.z += dz / d * sp; L.gy += dy / d * sp * 0.9; L.y = L.gy + 0.32; }
      }
    }
    L.g.position.set(L.x, L.y, L.z); L.gem.rotation.y += dt * (L.kind === 'item' ? 1.6 : 3.2); if (L.kind === 'item' && L.rar >= 2) { L.sp -= dt; if (L.sp < 0) { L.sp = 0.22; puff(L.x + (Math.random() - 0.5) * 0.8, L.y + 0.4, L.z + (Math.random() - 0.5) * 0.8, 1, 0.4, RPG_RARITY_COL[L.rar].replace('#', '0x') | 0 || 0xffd84a, 0.4, 1.2, 0.9); } }
  }
}

