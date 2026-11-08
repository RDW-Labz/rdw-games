// <craft-core> ==================================================================================================================
// SHATTERWORLD crafting, part 1 of 2: stations (forge / gem bench / alchemy / cook pot), costs + ledger (atomic: nothing is taken unless the whole job is affordable and fits),
// craft gear (rarity-limited by the smith's tier), upgrade an affix tier, reforge, imbue (essence = a forced affix), item-level bump, craft / polish gems.
// Pure: no DOM, no three.js (needs rpg-core, gem-core and food-core). scratchpad/shatter-passB/craft-unit.mjs extracts this block and tests it under node.
// borrowed: DwarfCorp (blecki/dwarfcorp, modified MIT, data only) World/ResourceItems/*.json: Craft_Location (Anvil / Forge / Apothecary / Craft Table), Craft_Ingredients by tag + count,
//   tools that are kept; the recipe graph in food-core already uses the same schema. cleverraven/cataclysm-dda (CC BY-SA 3.0, structure only): requirement lists with any-of components (our tag ingredients).
// concept only (no code / names / values): PathOfBuilding essence = a guaranteed affix -> our Imbue; the existing rpgRerollAffix / RPG_TIER_ILVL tier gating drive Upgrade.
// ==============================================================================================================================
const CRAFT_TUNING = {
  gearMaxRarity: { 0: -1, 1: 1, 2: 2, 3: 2 },                         // smithy tier -> highest rarity index it can craft (common 0, magic 1, rare 2). Legendary gear can never be crafted.
  gearGold: [30, 90, 280], gearScrap: [4, 8, 14], gearEssence: [0, 1, 3], gearOre: [0, 0, 4], gearSlotMat: [0, 1, 2],
  slotMat: { cap: 'silk', gloves: 'hide', boots: 'hide', body: 'silk', charm: 'ore' },
  ilvlBump: 3, upgradeAt: 2, reforgeAt: 3, imbueAt: 3, bumpAt: 2,
  gemTierAt: { 0: 1, 1: 2, 2: 3 },                                    // gem tier -> gem bench tier needed to craft it
  gemSkillLv: [1, 1, 3, 5], polishXp: 0.6, polishMax: 20,
};
// ---- costs + the ledger: L = { gold, dust, sat }; cost = { gold, dust, mats: {id: n}, ing: {id: n} } -------------------------------------------------------------------------------------
function costNorm(c) { return { gold: Math.max(0, Math.round(c.gold || 0)), dust: Math.max(0, Math.round(c.dust || 0)), mats: Object.assign({}, c.mats || {}), ing: Object.assign({}, c.ing || {}) }; }
function costLack(L, c) { const out = []; c = costNorm(c); if (L.gold < c.gold) out.push({ k: 'gold', need: c.gold, have: L.gold | 0 }); if (L.dust < c.dust) out.push({ k: 'dust', need: c.dust, have: L.dust | 0 }); for (const id in c.mats) { const h = satCount(L.sat, 'mat', id); if (h < c.mats[id]) out.push({ k: 'mat', id, need: c.mats[id], have: h }); } for (const id in c.ing) { const h = satCount(L.sat, 'ing', id); if (h < c.ing[id]) out.push({ k: 'ing', id, need: c.ing[id], have: h }); } return out; }
function costCan(L, c) { return costLack(L, c).length === 0; }
function costPay(L, c) { c = costNorm(c); if (!costCan(L, c)) return false; L.gold -= c.gold; L.dust -= c.dust; for (const id in c.mats) if (c.mats[id] > 0) satTake(L.sat, 'mat', id, c.mats[id]); for (const id in c.ing) if (c.ing[id] > 0) satTake(L.sat, 'ing', id, c.ing[id]); return true; }
function costText(c) { c = costNorm(c); const out = []; if (c.gold) out.push(c.gold + ' gold'); if (c.dust) out.push(c.dust + ' shards'); for (const id in c.mats) out.push(c.mats[id] + ' ' + (MATS[id] ? MATS[id].name : id)); for (const id in c.ing) out.push(c.ing[id] + ' ' + (INGS[id] ? INGS[id].name : id)); return out.join(', '); }
function costScale(c, k) { c = costNorm(c); const o = { gold: Math.round(c.gold * k), dust: Math.round(c.dust * k), mats: {}, ing: {} }; for (const id in c.mats) o.mats[id] = Math.max(1, Math.round(c.mats[id] * k)); for (const id in c.ing) o.ing[id] = Math.max(1, Math.round(c.ing[id] * k)); return o; }

// ---- gear: craft / upgrade / reforge / imbue / ilvl bump ---------------------------------------------------------------------------------------------------------------------------------
function craftGearRarityMax(tier) { return CRAFT_TUNING.gearMaxRarity[Math.max(0, Math.min(3, tier | 0))]; }
function craftGearCost(slot, rarityIdx, ilvl) { const T = CRAFT_TUNING, r = Math.max(0, Math.min(2, rarityIdx | 0)), k = 1 + (ilvl | 0) / 25, mats = { scrap: Math.round(T.gearScrap[r] * k) }; if (T.gearEssence[r]) mats.essence = T.gearEssence[r]; if (T.gearOre[r]) mats.ore = T.gearOre[r]; if (T.gearSlotMat[r]) { const sm = T.slotMat[slot === 'charm1' || slot === 'charm2' ? 'charm' : slot] || 'scrap'; mats[sm] = (mats[sm] || 0) + T.gearSlotMat[r]; } return { gold: Math.round(T.gearGold[r] * k), mats }; }
function craftGearIlvl(playerLevel, smithTier) { return Math.max(1, Math.min(99, (playerLevel | 0) + 1 + (Math.max(1, smithTier | 0) - 1) * 2)); }
function craftGear(seed, slot, rarityIdx, ilvl, weights) { return rpgGenItem(seed >>> 0, { ilvl, slot: slot === 'charm1' || slot === 'charm2' ? 'charm' : slot, rarity: RPG_RARITIES[Math.max(0, Math.min(2, rarityIdx | 0))], w: weights }); }
function craftUpgradeCheck(it, idx) { // -> { ok, why, tier }: raise one affix by a tier (needs the item level for the next tier)
  const a = it && it.affixes && it.affixes[idx]; if (!a) return { ok: false, why: 'no such affix' }; const d = RPG_AFFIX_BY_ID[a.id], nt = a.tier + 1; if (!d || !d.tiers[nt]) return { ok: false, why: 'already at the top tier' };
  if ((it.ilvl | 0) < d.tiers[nt].minIlvl) return { ok: false, why: 'needs item level ' + d.tiers[nt].minIlvl, need: d.tiers[nt].minIlvl }; return { ok: true, tier: nt };
}
function craftUpgradeCost(it, idx) { const a = it.affixes[idx], t = a ? a.tier + 1 : 1; return { gold: Math.round(70 * t * (1 + (it.ilvl | 0) / 30)), mats: { scrap: 4 + 3 * t, ore: t, essence: t } }; }
function craftUpgradeAffix(it, idx) { // keeps the roll's percentile inside the new tier's range
  const chk = craftUpgradeCheck(it, idx); if (!chk.ok) return null; const a = it.affixes[idx], d = RPG_AFFIX_BY_ID[a.id], T0 = d.tiers[a.tier], T1 = d.tiers[chk.tier], u = T0.hi > T0.lo ? (a.value - T0.lo) / (T0.hi - T0.lo) : 0.5;
  const out = JSON.parse(JSON.stringify(it)); out.affixes[idx] = { id: a.id, tier: chk.tier, value: rpgRollValue(d, chk.tier, Math.max(0, Math.min(1, u))) }; out.up = (it.up | 0) + 1; return out;
}
function craftBumpCost(it) { return { gold: 50 + 6 * (it.ilvl | 0), mats: { scrap: 6, ore: 2, essence: 1 } }; }
function craftBump(it) { if ((it.ilvl | 0) >= 99) return null; const out = JSON.parse(JSON.stringify(it)); out.ilvl = Math.min(99, (it.ilvl | 0) + CRAFT_TUNING.ilvlBump); return out; }
function craftReforgeCost(it) { const ri = RPG_RARITIES.indexOf(it.rarity); return { gold: Math.round(120 * (1 + (it.ilvl | 0) / 20)), mats: { scrap: 10, essence: 2 + ri, hide: ri >= 2 ? 1 : 0 } }; }
function craftReforge(it, seed, weights) { // new affixes, same slot / rarity / item level / legendary power; sockets, gems, lock survive (they are not affixes)
  const n = rpgGenItem(seed >>> 0, { ilvl: it.ilvl, slot: it.slot, rarity: it.rarity, legendary: it.legendary, w: weights }); n.seed = seed >>> 0; if (it.locked) n.locked = true; if (it.lay) n.lay = JSON.parse(JSON.stringify(it.lay)); if (it.sr) n.sr = it.sr; if (it.gems) n.gems = it.gems; n.rf = (it.rf | 0) + 1; return n;
}
function craftImbueChoices(it, idx) { // affixes that may replace affix idx: same kind (prefix / suffix), fits the slot, not already on the item, tier available at this item level
  const a = it && it.affixes && it.affixes[idx]; if (!a) return []; const kind = RPG_AFFIX_BY_ID[a.id].kind, used = new Set(it.affixes.map((x, i) => i === idx ? '' : x.id)); return RPG_AFFIXES.filter(d => d.kind === kind && d.slots.includes(it.slot) && !used.has(d.id) && d.id !== a.id && rpgTiersFor(d, it.ilvl).length).map(d => d.id);
}
function craftImbueCost(it) { const ri = RPG_RARITIES.indexOf(it.rarity); return { gold: Math.round(90 * (1 + (it.ilvl | 0) / 25)), mats: { essence: 3 + ri, ore: 2 } }; }
function craftImbue(it, idx, affixId, seed) { if (!craftImbueChoices(it, idx).includes(affixId)) return null; const d = RPG_AFFIX_BY_ID[affixId], r = rpgRng(seed >>> 0), tiers = rpgTiersFor(d, it.ilvl), t = tiers[tiers.length - 1]; const out = JSON.parse(JSON.stringify(it)); out.affixes[idx] = { id: affixId, tier: t, value: rpgRollValue(d, t, r()) }; out.affixes.sort((x, y) => (RPG_AFFIX_BY_ID[x.id].kind === 'prefix' ? 0 : 1) - (RPG_AFFIX_BY_ID[y.id].kind === 'prefix' ? 0 : 1)); out.im = (it.im | 0) + 1; return out; }

// ---- gems: craft + polish ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function craftGemCraftable(id, benchTier) { const d = GEM_BY_ID[id]; return !!d && (benchTier | 0) >= CRAFT_TUNING.gemTierAt[d.tier]; }
function craftGemCost(id) { const d = GEM_BY_ID[id], t = d ? d.tier : 0, sk = d && d.kind === 'skill'; const mats = {}; if (sk) { mats.essence = 1 + t; if (t >= 1) mats.silk = t; } else { mats.ore = 1 + t; mats.essence = 1; } if (t >= 2) mats.crystal = 1; return { dust: (sk ? 12 : 10) + t * 22, gold: 30 + t * 60, mats }; }
function craftGemMake(id, seed, benchTier) { if (!GEM_BY_ID[id]) return null; return { id, lv: CRAFT_TUNING.gemSkillLv[Math.max(0, Math.min(3, benchTier | 0))], xp: 0, u: gemUid(seed >>> 0) }; }
function craftPolishCost(g) { return { dust: 6 + 3 * (g.lv | 0), gold: 10 * (g.lv | 0), mats: {} }; }
function craftPolish(g) { if (!g || g.lv >= CRAFT_TUNING.polishMax) return null; const out = JSON.parse(JSON.stringify(g)); gemAddXp(out, Math.max(1, Math.round(gemXpNext(g.lv) * CRAFT_TUNING.polishXp))); return out; }

// ---- stations: what each can do at which tier ---------------------------------------------------------------------------------------------------------------------------------------------------
const STATIONS = {
  cook: { id: 'cook', name: 'Kitchen', role: 'kitchen', tabs: ['COOK', 'PANTRY'] },
  alchemy: { id: 'alchemy', name: 'Apothecary', role: 'apothecary', tabs: ['BREW', 'PANTRY'] },
  forge: { id: 'forge', name: 'Smithy', role: 'smithy', tabs: ['CRAFT', 'UPGRADE', 'REFORGE', 'IMBUE'] },
  gembench: { id: 'gembench', name: 'Gem Workshop', role: 'gems', tabs: ['CRAFT GEM', 'SOCKETS', 'POLISH'] },
};
const FORGE_TAB_TIER = { CRAFT: 1, UPGRADE: 2, REFORGE: 3, IMBUE: 3 }, GEM_TAB_TIER = { 'CRAFT GEM': 2, SOCKETS: 1, POLISH: 1 };
// </craft-core>

