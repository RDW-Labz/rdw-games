// ---- persistence: localStorage (sync) + window.__save (server / Supabase / ib_saves via the shelf bridge) ------------------------------
function rpgCleanItem(it) {
  if (!it || typeof it !== 'object' || !RPG_SLOTS.includes(it.slot) || !RPG_RARITIES.includes(it.rarity)) return null;
  const aff = []; for (const a of (it.affixes || [])) { const d = RPG_AFFIX_BY_ID[a.id]; if (d && d.tiers[a.tier] && Number.isFinite(a.value)) aff.push({ id: a.id, tier: a.tier | 0, value: +a.value }); }
  const o = { seed: it.seed >>> 0, slot: it.slot, rarity: it.rarity, ilvl: sat(it.ilvl | 0, 1, 99), affixes: aff }; if (it.legendary && RPG_LEG_BY_ID[it.legendary]) o.legendary = it.legendary; if (it.locked) o.locked = true; if (it.rr) o.rr = it.rr | 0; return o;
}
function rpgSnapshot() {
  return { v: 1, seed: RP.seed, n: RP.n, picks: RP.picks, level: RP.level, xp: RP.xp, free: RP.free, spent: RP.spent, perks: RP.perks, pending: RP.pending, gold: RP.gold, dust: RP.dust, bag: RP.bag, equipped: RP.equipped,
    bestRift: RP.bestRift, riftUnlocked: RP.riftUnlocked, diff: RP.diff, diffUnlocked: RP.diffUnlocked, codex: RP.codex, filter: RP.filter, totals: RP.totals, riftSeed: RP.riftSeed, riftTier: RP.riftTier, intro: RP.intro };
}
function rpgApplySnapshot(s) {
  if (!s || s.v !== 1) return false;
  RP.seed = s.seed >>> 0 || RP.seed; RP.n = s.n | 0; RP.picks = s.picks | 0; RP.level = sat(s.level | 0 || 1, 1, RPG_TUNING.levelCap); RP.xp = Math.max(0, +s.xp || 0); RP.free = Math.max(0, s.free | 0);
  RP.spent = { power: s.spent?.power | 0, agility: s.spent?.agility | 0, resolve: s.spent?.resolve | 0 }; RP.perks = {}; for (const id in (s.perks || {})) if (RPG_PERK_BY_ID[id]) RP.perks[id] = sat(s.perks[id] | 0, 0, RPG_PERK_BY_ID[id].max);
  RP.pending = Math.max(0, s.pending | 0); RP.gold = Math.max(0, +s.gold || 0); RP.dust = Math.max(0, +s.dust || 0);
  RP.bag = new Array(BAG_N).fill(null); (s.bag || []).slice(0, BAG_N).forEach((it, i) => RP.bag[i] = rpgCleanItem(it)); for (const k of RPG_EQUIP) RP.equipped[k] = rpgCleanItem(s.equipped && s.equipped[k]);
  RP.bestRift = s.bestRift | 0; RP.riftUnlocked = !!s.riftUnlocked; RP.diff = sat(s.diff | 0, 0, 2); RP.diffUnlocked = sat(s.diffUnlocked | 0, 0, 2); RP.diff = Math.min(RP.diff, RP.diffUnlocked); RP.codex = s.codex || {}; RP.filter = !!s.filter;
  Object.assign(RP.totals, s.totals || {}); RP.riftSeed = s.riftSeed >>> 0; RP.riftTier = sat(s.riftTier | 0 || 1, 1, RPG_TUNING.rift.maxTier); RP.intro = !!s.intro;
  return true;
}
function rpgLoad() {
  let s = null; try { const v = localStorage.getItem(RPG_SAVE_KEY); if (v) s = JSON.parse(v); } catch (e) { }
  if (!s) try { const g = (JSON.parse(localStorage.getItem('ib_saves') || '{}') || {})['shatterworld-next']; if (g && g.rpg) s = g.rpg; } catch (e) { } // shelf-bridge fallback copy (this build's own entry only)
  return s ? rpgApplySnapshot(s) : false;
}
function rpgSaveNow(light) { // light = localStorage only (periodic flush); full = also window.__save (server / Supabase / shelf copy), used at milestones
  RT.dirty = false; RT.lastFlush = RT.real; const snap = rpgSnapshot();
  try { localStorage.setItem(RPG_SAVE_KEY, JSON.stringify(snap)); } catch (e) { }
  if (light && RT.real - (RT.lastServer || -99) < 20) return; RT.lastServer = RT.real;
  try { if (window.__save) window.__save({ rpg: snap, level: RP.level, bestRiftTier: RP.bestRift, legendaries: Object.keys(RP.codex).length }); } catch (e) { } // additive keys: existing best/score/time keep their meaning
}
function rpgFlush(force) { if (RT.dirty && (force || RT.real - RT.lastFlush > 2.5)) rpgSaveNow(!force); }

