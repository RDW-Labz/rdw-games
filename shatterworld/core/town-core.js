// <town-core> ===================================================================================================================
// SHATTERWORLD home town, part 1 of 2: pure data + deterministic functions. No DOM, no three.js, no game globals (needs rpg-core, gem-core, food-core, craft-core).
// scratchpad/shatter-passB/town-unit.mjs extracts this block verbatim and runs it under node (layout determinism over 200 seeds, upgrades, vendor rotation, quests, dialogue gates, save + migration).
// borrowed (idea, re-implemented, nothing pasted): watabou/TownGeneratorOS (GPL-3.0, Source/com/watabou/towngenerator: Model / Patch / Cutter / wards): a village is a set of PATCHES (Voronoi cells around a market
//   centre), each patch becomes a WARD (market, craftsmen, merchants, farms, gate, homes), streets run along patch borders, and a ward's area is cut into LOTS by recursive bisection with an alley gap (Cutter.bisect).
//   Here it is re-written on a cell grid (the game is made of cubes), with an original ward set and an original placement rule. GPL source was READ, never copied: this file is original code.
// borrowed: flareteam/flare-game (CC BY-SA 3.0, schema only): NPC dialogue gated by status flags (requires_status / requires_not / set_status), vendors that unlock stock by flags (status_stock), quests with
//   requires / complete_status. cleverraven/cataclysm-dda data/json/recipes/basecamps (CC BY-SA 3.0, structure only): a base grows by tiered upgrade recipes that cost materials and unlock a function.
//   cleverraven/cataclysm-dda src/npctrade.cpp (structure): buy price = value x markup, sell price = value x fraction, stock re-rolled on a schedule. dwarfcorp World/Events (modified MIT): events with Likelihood / Difficulty / Cooldown.
// ==============================================================================================================================
const TOWN_VERSION = 1;
const TOWN_ROLES = {
  hall: { id: 'hall', name: 'Town Hall', npc: 'mayor', col: '#ffd66b', start: 1, text: 'The heart of the village. Its tier decides how far every other building can grow.' },
  market: { id: 'market', name: 'Market', npc: 'vendor', col: '#ff8a7a', start: 1, text: 'Buy and sell gear, gems, ingredients and potions. The stock changes every day.' },
  kitchen: { id: 'kitchen', name: 'Kitchen', npc: 'cook', col: '#ffb15e', start: 1, text: 'Cook meals that make you stronger for a while. Food is power, never a chore.' },
  smithy: { id: 'smithy', name: 'Smithy', npc: 'smith', col: '#9fb4c8', start: 1, text: 'Craft gear, upgrade affixes, reforge and imbue.' },
  gems: { id: 'gems', name: 'Gem Workshop', npc: 'gemwright', col: '#c8b0ff', start: 0, text: 'Socket and unsocket gems, polish them, craft new ones.' },
  apothecary: { id: 'apothecary', name: 'Apothecary', npc: 'brewer', col: '#8af7a6', start: 0, text: 'Brew potions and distil essence.' },
  warehouse: { id: 'warehouse', name: 'Warehouse', npc: 'keeper', col: '#d8b080', start: 1, text: 'Store gear and gems. Bigger tiers hold more.' },
  garden: { id: 'garden', name: 'Garden', npc: null, col: '#9af0a0', start: 0, text: 'Beds of herbs and crops that ripen while you play.' },
  board: { id: 'board', name: 'Notice Board', npc: null, col: '#8fd0ff', start: 1, text: 'Bounties, daily and weekly goals, and Shatter Rift contracts.' },
};
const TOWN_ROLE_IDS = Object.keys(TOWN_ROLES);
// upgrade from tier t to t+1: cost, the Town Hall tier it needs, what it unlocks (text) and an optional passive (stat mods)
function tUp(gold, mats, hall, text, perk) { return { cost: { gold, mats }, hall, text, perk: perk || null }; }
const TOWN_UP = {
  hall: [null, tUp(400, { timber: 12, scrap: 15 }, 1, 'Hamlet to Village: the other buildings can reach tier 2.'), tUp(1800, { timber: 30, scrap: 40, essence: 6, ore: 8 }, 2, 'Village to Town: tier 3 buildings. +4% experience.', { xpGain: 0.04 })],
  market: [null, tUp(250, { timber: 6, scrap: 8 }, 1, 'More stalls: 10 offers and ready-made potions.'), tUp(900, { ore: 6, hide: 4, timber: 10 }, 2, 'Grand market: 14 offers, rare gems, +15% sell price.')],
  kitchen: [null, tUp(300, { timber: 8, scrap: 10 }, 1, 'A proper hearth: stews, roasts and pies. Meals last 20% longer.'), tUp(1000, { ore: 5, hide: 3, essence: 3 }, 2, 'Feast hall: feasts and curries. Meals last 40% longer.')],
  smithy: [null, tUp(350, { scrap: 20, ore: 5 }, 1, 'An anvil: craft rare gear, upgrade affixes, raise item level.'), tUp(1400, { scrap: 40, ore: 12, essence: 5 }, 2, 'Master forge: reforge and imbue. +4% damage.', { allDmg: 0.04 })],
  gems: [tUp(200, { timber: 8, scrap: 8 }, 0, 'Built: socket and unsocket gems, polish them.'), tUp(500, { ore: 6, silk: 4 }, 1, 'Craft skill gems.'), tUp(1500, { ore: 10, silk: 8, essence: 6, crystal: 2 }, 2, 'Craft support gems. +10% gem experience.', { gemXp: 0.1 })],
  apothecary: [tUp(220, { timber: 8, scrap: 6 }, 0, 'Built: brew minor potions and essence.'), tUp(450, { silk: 3, essence: 2 }, 1, 'Stronger potions.'), tUp(1200, { essence: 6, crystal: 1 }, 2, 'Elixirs. +0.3% health regeneration per second.', { hpRegen: 0.003 })],
  warehouse: [null, tUp(300, { timber: 15, scrap: 10 }, 1, '48 stash slots.'), tUp(900, { timber: 30, ore: 6 }, 2, '72 stash slots.')],
  garden: [tUp(180, { timber: 10, scrap: 4 }, 0, 'Built: 4 garden beds.'), tUp(400, { timber: 12, hide: 2 }, 1, '6 beds and faster growth.'), tUp(1000, { timber: 20, essence: 4 }, 2, '8 beds, and rare crops.')],
  board: [null, tUp(280, { timber: 6, scrap: 8 }, 1, 'A fourth daily goal, a second weekly goal, +20% rewards.'), tUp(900, { scrap: 20, ore: 5 }, 2, 'Rift contracts with a chosen monster family. +50% rewards.')],
};
const TOWN_STASH = [0, 24, 48, 72], TOWN_BEDS = [0, 4, 6, 8], TOWN_VENDOR_SLOTS = [0, 6, 10, 14], TOWN_STACK = [99, 99, 150, 250];
function townTier(S, role) { return (S.bld && S.bld[role]) | 0; }
function townUpgradeInfo(S, role) { // -> { from, to, cost, hall, text, ok, why } (to = -1 when maxed)
  const t = townTier(S, role), step = (TOWN_UP[role] || [])[t]; if (!step || t >= 3) return { from: t, to: -1, ok: false, why: 'fully upgraded', maxed: true };
  const hall = townTier(S, 'hall'); if (role !== 'hall' && step.hall > hall) return { from: t, to: t + 1, cost: step.cost, hall: step.hall, text: step.text, perk: step.perk, ok: false, why: 'needs Town Hall tier ' + step.hall };
  return { from: t, to: t + 1, cost: step.cost, hall: step.hall, text: step.text, perk: step.perk, ok: true, why: '' };
}
function townDoUpgrade(S, role, L) { const i = townUpgradeInfo(S, role); if (!i.ok) return { ok: false, why: i.why }; if (!costCan(L, i.cost)) return { ok: false, why: 'cannot afford', lack: costLack(L, i.cost) }; costPay(L, i.cost); S.bld[role] = i.to; S.renown = (S.renown | 0) + i.to * 2; return { ok: true, from: i.from, to: i.to, cost: i.cost, text: i.text }; }
function townMods(S) { const m = {}; for (const role of TOWN_ROLE_IDS) { const t = townTier(S, role); for (let k = 0; k < t && k < 3; k++) { const st = (TOWN_UP[role] || [])[k]; if (st && st.perk) for (const s in st.perk) m[s] = (m[s] || 0) + st.perk[s]; } } return m; }
function townSellMul(S) { return townTier(S, 'market') >= 3 ? 0.45 : 0.3; }
function townTiers(S) { return { cook: townTier(S, 'kitchen'), alchemy: townTier(S, 'apothecary'), forge: townTier(S, 'smithy'), gembench: townTier(S, 'gems') }; }

// ---- state (versioned + migratable) ------------------------------------------------------------------------------------------------------------------------------------------------------
function townDefault(seed) { const bld = {}; for (const id of TOWN_ROLE_IDS) bld[id] = TOWN_ROLES[id].start; return { v: TOWN_VERSION, seed: (seed >>> 0) || 0x70771, bld, sat: satNew(), stash: new Array(72).fill(null), known: {}, seen: {}, flags: {}, buffs: [], q: { day: -1, week: -1, daily: [], weekly: [], done: 0 }, vend: { day: -1, n: 0, sold: {} }, garden: [], clock: 0, visits: 0, renown: 0, intro: 0, stats: { cooked: 0, brewed: 0, crafted: 0, gathered: 0, quests: 0, upgrades: 0 } }; }
// migration chain: a missing / older version is upgraded step by step; an unknown future version keeps what it can. Every field is validated, nothing is trusted.
function townMigrate(raw) {
  if (!raw || typeof raw !== 'object') return null; let v = raw.v | 0; const s = JSON.parse(JSON.stringify(raw));
  if (v < 1) { /* v0: pre-town saves had no town block at all (or only a seed): start fresh but keep the seed */ return { v: 1, seed: s.seed }; }
  return s;
}
function townClean(raw, cleanItem) {
  const m = townMigrate(raw), S = townDefault(m && m.seed); if (!m) return S; const ci = cleanItem || (it => (it && typeof it === 'object' && it.slot && it.rarity ? it : null));
  if (m.bld) for (const id of TOWN_ROLE_IDS) if (typeof m.bld[id] === 'number') S.bld[id] = Math.max(0, Math.min(3, m.bld[id] | 0));
  S.sat = satClean(m.sat); if (Array.isArray(m.stash)) m.stash.slice(0, 72).forEach((it, i) => { S.stash[i] = ci(it); });
  for (const k in (m.known || {})) if (FOOD_RECIPES[k] && m.known[k]) S.known[k] = 1; for (const k in (m.seen || {})) if ((INGS[k] || MATS[k]) && m.seen[k]) S.seen[k] = 1; for (const k in (m.flags || {})) if (/^[a-z0-9_]{1,32}$/.test(k) && m.flags[k]) S.flags[k] = 1;
  S.buffs = (Array.isArray(m.buffs) ? m.buffs : []).map(foodBuffClean).filter(Boolean).slice(0, 4);
  if (m.q && typeof m.q === 'object') { S.q.day = m.q.day | 0; S.q.week = m.q.week | 0; S.q.done = m.q.done | 0; S.q.daily = questClean(m.q.daily); S.q.weekly = questClean(m.q.weekly); }
  if (m.vend) { S.vend.day = m.vend.day | 0; S.vend.n = Math.max(0, Math.min(99, m.vend.n | 0)); for (const k in (m.vend.sold || {})) if (/^[a-z0-9:_-]{1,40}$/.test(k)) S.vend.sold[k] = 1; }
  S.garden = (Array.isArray(m.garden) ? m.garden : []).slice(0, 12).map(b => b && INGS[b.plant] ? { plant: b.plant, t: Math.max(0, +b.t || 0), n: Math.max(1, Math.min(6, b.n | 0 || 1)) } : null);
  S.clock = Math.max(0, +m.clock || 0); S.visits = Math.max(0, m.visits | 0); S.renown = Math.max(0, m.renown | 0); S.intro = m.intro | 0;
  if (m.stats) for (const k in S.stats) S.stats[k] = Math.max(0, m.stats[k] | 0); return S;
}
function townSnapshot(S) { return JSON.parse(JSON.stringify(S)); }
function townStashFree(S) { const n = TOWN_STASH[townTier(S, 'warehouse')]; for (let i = 0; i < n; i++) if (!S.stash[i]) return i; return -1; }
function townStashCap(S) { return TOWN_STASH[townTier(S, 'warehouse')]; }

// ---- vendor: stock rotates with the day and with refreshes; prices follow the item ------------------------------------------------------------------------------------------------------------------
const VENDOR_RARITY_W = { 1: [70, 30, 0], 2: [45, 40, 15], 3: [30, 40, 30] };
function itemPrice(it) { const ri = RPG_RARITIES.indexOf(it.rarity), base = [14, 70, 280, 1500][ri] * (1 + (it.ilvl | 0) * 0.07) * (1 + (it.affixes || []).length * 0.06); return Math.max(5, Math.round(base)); }
function gemPrice(g) { const d = GEM_BY_ID[g.id]; return Math.round((24 + d.tier * 70) * (1 + 0.12 * ((g.lv | 0) - 1))); }
function vendorKey(i, kind, id) { return 'r' + i + kind[0] + ':' + id; }
function vendorStock(S, level, ilvlBase, dayIdx) {
  const tier = Math.max(1, townTier(S, 'market')), slots = TOWN_VENDOR_SLOTS[tier] || 6, rot = (dayIdx | 0) * 16 + (S.vend.n | 0), r = rpgRng(rpgHashSeed(S.seed >>> 0, 0xBEE5 + rot)), out = [];
  const nItems = Math.ceil(slots * 0.55), nGems = tier >= 3 ? 3 : tier >= 2 ? 2 : 1, nPot = tier >= 2 ? 2 : 0, rest = slots - nItems - nGems - nPot;
  for (let i = 0; i < nItems; i++) { const w = VENDOR_RARITY_W[tier], u = r() * (w[0] + w[1] + w[2]), ri = u < w[0] ? 0 : u < w[0] + w[1] ? 1 : 2, seed = (r() * 4294967296) >>> 0, ilvl = Math.max(1, (ilvlBase | 0) + Math.floor(r() * 3) - 1); const it = rpgGenItem(seed, { ilvl, rarity: RPG_RARITIES[ri] }); out.push({ key: vendorKey(rot, 'item', seed), kind: 'item', seed, ilvl, rarity: it.rarity, slot: it.slot, price: Math.round(itemPrice(it) * 1.15) }); }
  for (let i = 0; i < nGems; i++) { const seed = (r() * 4294967296) >>> 0, maxT = tier >= 3 ? 2 : tier >= 2 ? 1 : 0; const pool = GEM_DEFS.filter(d => d.tier <= maxT), d = pool[(r() * pool.length) | 0], lv = Math.max(1, Math.min(8, 1 + Math.floor(((level | 0) - 1) / 4))); const g = { id: d.id, lv, xp: 0, u: gemUid(seed) }; out.push({ key: vendorKey(rot, 'gem', seed), kind: 'gem', seed, gem: g, price: Math.round(gemPrice(g) * 1.25) }); }
  const pots = FOOD_RECIPE_IDS.filter(id => FOOD_RECIPES[id].out.type === 'potion' && FOOD_RECIPES[id].tier <= 2); for (let i = 0; i < nPot; i++) { const id = pots[(r() * pots.length) | 0]; out.push({ key: vendorKey(rot, 'pot', id + i), kind: 'pot', recipe: id, q: 1, price: 70 + FOOD_RECIPES[id].tier * 40 }); }
  const bundles = [['mat', 'scrap', 5, 28], ['mat', 'timber', 5, 30], ['ing', 'sunberry', 4, 28], ['ing', 'brightleaf', 4, 30], ['ing', 'crunchroot', 3, 20], ['mat', 'essence', 1, 60], ['ing', 'honey', 2, 56], ['mat', 'ore', 2, 90]];
  for (let i = 0; i < Math.max(0, rest); i++) { const b = bundles[(r() * bundles.length) | 0]; out.push({ key: vendorKey(rot, b[0], b[1] + i), kind: b[0], id: b[1], n: b[2], price: b[3] }); }
  return out;
}
function vendorSellPrice(S, stack) { // stack = {kind:'item', item} | {kind:'gem', gem} | {kind:'mat'|'ing', id, n} | {kind:'dish'|'pot', key, n}
  const m = townSellMul(S); if (stack.kind === 'item') return Math.max(1, Math.round(itemPrice(stack.item) * m)); if (stack.kind === 'gem') return Math.max(1, Math.round(gemPrice(stack.gem) * m));
  if (stack.kind === 'mat') return Math.max(1, Math.round(MATS[stack.id].sell * (stack.n || 1) * 0.7)); if (stack.kind === 'ing') return Math.max(1, Math.round(INGS[stack.id].sell * (stack.n || 1) * 0.7)); return Math.max(1, 12 * (stack.n || 1));
}
function vendorBasics(S) { return FOOD_SHOP_BASICS.map(([id, price]) => ({ key: 'basic:' + id, kind: 'ing', id, n: 1, price })); }

// ---- quests: daily + weekly goals generated from (seed, period) so the board is the same all day for everybody on this save ----------------------------------------------------------------------
const QUEST_TPL = [
  { id: 'kill_any', ev: 'kill', n: [20, 40], text: 'Defeat {n} monsters', w: 3, gold: 0.5 },
  { id: 'kill_elite', ev: 'kill', filter: { elite: 1 }, n: [3, 7], text: 'Defeat {n} champions or elites', w: 2, gold: 1.4 },
  { id: 'kill_fam', ev: 'kill', n: [8, 16], text: 'Defeat {n} monsters of the {fam}', w: 2, fam: true, gold: 0.8 },
  { id: 'gather', ev: 'gather', n: [6, 12], text: 'Gather {n} herbs or ores', w: 2, gold: 0.5 },
  { id: 'cook', ev: 'cook', n: [1, 3], text: 'Cook {n} dish(es) at the Kitchen', w: 2, gold: 0.7 },
  { id: 'brew', ev: 'brew', n: [1, 2], text: 'Brew {n} potion(s) at the Apothecary', w: 1, gold: 0.8, need: { apothecary: 1 } },
  { id: 'craft', ev: 'craft', n: [1, 3], text: 'Craft or improve {n} item(s) at a forge or bench', w: 2, gold: 0.9 },
  { id: 'shards', ev: 'shard', n: [3, 5], text: 'Collect {n} Sun Shards', w: 1, gold: 0.9 },
  { id: 'rift', ev: 'rift', n: [1, 2], text: 'Clear {n} Shatter Rift(s)', w: 1, gold: 1.6, need: { rift: 1 } },
  { id: 'rift_fam', ev: 'rift', n: [1, 1], text: 'Clear a Shatter Rift of the {fam}', w: 1, gold: 1.8, fam: true, contract: true, need: { rift: 1 } },
  { id: 'gold', ev: 'gold', n: [300, 900], text: 'Earn {n} gold', w: 1, gold: 0.35 },
  { id: 'loot', ev: 'loot', filter: { rarity: 'rare' }, n: [2, 4], text: 'Find {n} rare or better items', w: 1, gold: 1.2 },
  { id: 'boss', ev: 'boss', n: [1, 1], text: 'Defeat an Act Guardian', w: 1, gold: 2.2, weekly: true },
];
function questClean(list) { const out = []; for (const q of (Array.isArray(list) ? list : []).slice(0, 8)) { const t = QUEST_TPL.find(x => x.id === (q && q.id)); if (!t) continue; out.push({ id: t.id, n: Math.max(1, Math.min(999, q.n | 0 || 1)), p: Math.max(0, Math.min(999, q.p | 0)), fam: MOB_FAMILIES[q.fam] ? q.fam : null, gold: Math.max(0, Math.min(99999, q.gold | 0)), xp: Math.max(0, Math.min(99999, q.xp | 0)), mats: questCleanMats(q.mats), claimed: !!q.claimed, key: String(q.key || '').slice(0, 24), tier: Math.max(1, Math.min(15, q.tier | 0 || 1)), seed: (q.seed >>> 0) || 0 }); } return out; }
function questCleanMats(m) { const o = {}; for (const k in (m || {})) if (MATS[k] && m[k] > 0) o[k] = Math.min(99, m[k] | 0); return o; }
function questDayIdx(ms) { return Math.floor(ms / 86400000); }
function questWeekIdx(ms) { return Math.floor((questDayIdx(ms) + 3) / 7); }
function questGen(seed, kind, idx, boardTier, level, riftOpen, bestRift) {
  const r = rpgRng(rpgHashSeed(seed >>> 0, (kind === 'weekly' ? 0x9E11 : 0xDA11) + idx * 31)), count = kind === 'weekly' ? (boardTier >= 2 ? 2 : 1) : (boardTier >= 2 ? 4 : 3), rewardK = [1, 1, 1.2, 1.5][Math.max(1, Math.min(3, boardTier))] * (kind === 'weekly' ? 3 : 1), out = [];
  const pool = QUEST_TPL.filter(t => (kind === 'weekly' ? true : !t.weekly) && (!t.need || ((!t.need.rift || riftOpen)))); const used = new Set();
  if (kind === 'weekly') { const b = QUEST_TPL.find(t => t.id === 'boss'); out.push(questMake(r, b, level, rewardK, boardTier, bestRift)); used.add('boss'); }
  while (out.length < count) { let tot = 0; for (const t of pool) if (!used.has(t.id)) tot += t.w; if (tot <= 0) break; let x = r() * tot, pick = null; for (const t of pool) { if (used.has(t.id)) continue; x -= t.w; if (x <= 0) { pick = t; break; } } if (!pick) pick = pool.find(t => !used.has(t.id)); used.add(pick.id); out.push(questMake(r, pick, level, rewardK, boardTier, bestRift)); }
  return out;
}
function questMake(r, t, level, rewardK, boardTier, bestRift) {
  const mul = t.weekly || rewardK >= 3 ? 2 : 1, n = t.n[0] + Math.floor(r() * (t.n[1] - t.n[0] + 1)) * (rewardK >= 3 && t.n[1] > 1 ? 2 : 1), fam = t.fam ? MOB_FAMILY_IDS[(r() * MOB_FAMILY_IDS.length) | 0] : null;
  const gold = Math.round((40 + 14 * level) * t.gold * (t.ev === 'gold' ? n / 400 : t.ev === 'kill' ? n / 20 : n) * rewardK * (0.9 + 0.2 * r()) / (t.ev === 'kill' || t.ev === 'gold' ? 1 : 1));
  const mats = {}; const mm = ['scrap', 'timber', 'ore', 'essence', 'hide', 'silk'][(r() * 6) | 0]; mats[mm] = Math.max(1, Math.round((2 + level / 6) * rewardK * (mm === 'essence' || mm === 'ore' ? 0.5 : 1)));
  return { id: t.id, n, p: 0, fam, gold: Math.max(20, gold), xp: Math.round((20 + 7 * level) * t.gold * rewardK), mats, claimed: false, key: t.id + ':' + ((r() * 1e6) | 0), tier: t.contract ? Math.max(1, Math.min(15, (bestRift | 0) || 1)) : 1, seed: t.contract ? ((r() * 16777216) | 0) | 1 : 0 };
}
function questRefresh(S, nowMs, level, riftOpen, bestRift) { // regenerate the board when the day / week changed; returns true when something changed
  const d = questDayIdx(nowMs), w = questWeekIdx(nowMs), bt = Math.max(1, townTier(S, 'board')); let ch = false;
  if (S.q.day !== d || S.q.daily.length === 0) { S.q.day = d; S.q.daily = questGen(S.seed, 'daily', d, bt, level, riftOpen, bestRift); ch = true; }
  if (S.q.week !== w || S.q.weekly.length === 0) { S.q.week = w; S.q.weekly = questGen(S.seed, 'weekly', w, bt, level, riftOpen, bestRift); ch = true; }
  return ch;
}
function questText(q) { const t = QUEST_TPL.find(x => x.id === q.id); return t.text.replace('{n}', q.n).replace('{fam}', q.fam ? MOB_FAMILIES[q.fam].name : ''); }
function questMatches(q, ev, info) {
  const t = QUEST_TPL.find(x => x.id === q.id); if (!t || t.ev !== ev) return 0; info = info || {};
  if (ev === 'kill') { if (t.filter && t.filter.elite && !(info.tier === 'elite' || info.tier === 'champion' || info.tier === 'guardian')) return 0; if (q.fam && !MOB_FAMILIES[q.fam].mobs.includes(info.type)) return 0; return 1; }
  if (ev === 'rift') { if (q.fam && !(info.fams || []).includes(q.fam)) return 0; return 1; }
  if (ev === 'loot') { const ri = RPG_RARITIES.indexOf(info.rarity); return t.filter && ri >= RPG_RARITIES.indexOf(t.filter.rarity) ? 1 : 0; }
  if (ev === 'gold') return Math.max(0, info.n | 0); if (ev === 'gather') return Math.max(1, info.n | 0); return 1;
}
function questEvent(S, ev, info) { // progress every unfinished quest; returns the list of quests that just completed
  const done = []; for (const q of S.q.daily.concat(S.q.weekly)) { if (q.claimed || q.p >= q.n) continue; const add = questMatches(q, ev, info); if (add > 0) { q.p = Math.min(q.n, q.p + add); if (q.p >= q.n) done.push(q); } } return done;
}
function questClaim(S, q) { if (!q || q.claimed || q.p < q.n) return null; q.claimed = true; S.q.done++; S.stats.quests++; S.renown = (S.renown | 0) + (S.q.weekly.includes(q) ? 4 : 1); return { gold: q.gold, xp: q.xp, mats: q.mats }; }

// ---- dialogue: data-driven nodes gated by flags (flare-style requires_status / requires_not / set_status), first match wins ------------------------------------------------------------------------------------
function townFlags(S, ctx) { // derived + stored flags
  const f = Object.assign({}, S.flags); for (const id of TOWN_ROLE_IDS) { const t = townTier(S, id); if (t >= 1) f['built_' + id] = 1; for (let k = 2; k <= 3; k++) if (t >= k) f[id + k] = 1; } ctx = ctx || {}; if (ctx.riftOpen) f.rift_open = 1; if (ctx.level >= 5) f.lv5 = 1; if (ctx.level >= 10) f.lv10 = 1; if (ctx.level >= 20) f.lv20 = 1; if (ctx.act1) f.act1 = 1; if (ctx.won) f.won = 1;
  if (S.stats.cooked > 0) f.cooked = 1; if (S.stats.crafted > 0) f.crafted = 1; if (S.stats.quests > 0) f.quested = 1; if ((S.renown | 0) >= 10) f.renown10 = 1; return f;
}
const TOWN_NPCS = {
  mayor: { id: 'mayor', name: 'Mayor Pennywick', role: 'hall', col: '#ffd66b', then: 'hall', dlg: [
    { id: 'm_first', req: [], not: ['talked_m_first'], once: 1, lines: ['Welcome home! This hamlet was a pile of loose blocks until you started bringing things back.', 'Spend gold and materials on upgrades at the Town Hall: every building grows with it.'] },
    { id: 'm_hall3', req: ['hall3'], not: [], lines: ['A proper town now. I never thought I would see the clock tower finished.'] },
    { id: 'm_hall2', req: ['hall2'], not: ['hall3'], lines: ['Village status! Bring me essence and ore and we can go further.'] },
    { id: 'm_quest', req: ['quested'], not: ['hall2'], lines: ['The notice board is busy because of you. Keep it up.'] },
    { id: 'm_def', req: [], not: [], lines: ['Check the notice board for goals, then see what the Hall can build next.', 'Every building has three tiers. The Hall decides how far the others may go.'] },
  ] },
  vendor: { id: 'vendor', name: 'Maple the Merchant', role: 'market', col: '#ff8a7a', then: 'market', dlg: [
    { id: 'v_first', req: [], not: ['talked_v_first'], once: 1, lines: ['Fresh stock every morning! Sell me what you cannot use, buy what you cannot find.'] },
    { id: 'v_market3', req: ['market3'], not: [], lines: ['Grand market, grand prices... for you, grand discounts. Almost.'] },
    { id: 'v_def', req: [], not: [], lines: ['Browse as long as you like.', 'New stock tomorrow. Or pay a little and I will shuffle the crates.'] },
  ] },
  cook: { id: 'cook', name: 'Chef Brisk', role: 'kitchen', col: '#ffb15e', then: 'cook', dlg: [
    { id: 'c_first', req: [], not: ['talked_c_first'], once: 1, lines: ['Food is power. Bring me ingredients by tag: any fruit, any meat, anything that was alive recently.', 'Better ingredients make a better dish. And a better dish lasts longer.'] },
    { id: 'c_kit3', req: ['kitchen3'], not: [], lines: ['Feast hall at last! Try the Grand Feast Platter.'] },
    { id: 'c_def', req: [], not: [], lines: ['What are we cooking?', 'Herbs from the garden are free. I do not ask where the meat came from.'] },
  ] },
  smith: { id: 'smith', name: 'Tolla the Smith', role: 'smithy', col: '#9fb4c8', then: 'forge', dlg: [
    { id: 's_first', req: [], not: ['talked_s_first'], once: 1, lines: ['Salvage gives me scrap. Scrap gives you gear. That is the whole trade.'] },
    { id: 's_smithy3', req: ['smithy3'], not: [], lines: ['The master forge sings. Bring me something worth reforging.'] },
    { id: 's_def', req: [], not: [], lines: ['Gear, upgrades, reforges. Pick your poison.', 'Legendary gear cannot be forged. Only found.'] },
  ] },
  gemwright: { id: 'gemwright', name: 'Pim the Gemwright', role: 'gems', col: '#c8b0ff', then: 'gembench', dlg: [
    { id: 'g_first', req: [], not: ['talked_g_first'], once: 1, lines: ['Gems love to be polished. And socketed. And shown off.'] },
    { id: 'g_def', req: [], not: [], lines: ['A gem in a socket of its own colour counts for one more level.', 'Craft skills at tier two, supports at tier three.'] },
  ] },
  brewer: { id: 'brewer', name: 'Nell the Brewer', role: 'apothecary', col: '#8af7a6', then: 'alchemy', dlg: [
    { id: 'b_first', req: [], not: ['talked_b_first'], once: 1, lines: ['Potions are just soup you pour carefully. Herbs, water, patience.'] },
    { id: 'b_def', req: [], not: [], lines: ['Two potions at a time. Do not mix them up.', 'Essence is distilled herbs. The forge pays well for it.'] },
  ] },
  keeper: { id: 'keeper', name: 'Otto the Keeper', role: 'warehouse', col: '#d8b080', then: 'stash', dlg: [
    { id: 'k_first', req: [], not: ['talked_k_first'], once: 1, lines: ['I keep it dry and I keep it safe. Hand it over.'] },
    { id: 'k_def', req: [], not: [], lines: ['Bigger warehouse, more shelves. Simple.'] },
  ] },
  walker: { id: 'walker', name: 'Villager', role: null, col: '#cfe0ee', dlg: [
    { id: 'w_won', req: ['won'], not: [], lines: ['They say you put the whole world back together. Thank you.'] },
    { id: 'w_def', req: [], not: [], lines: ['Lovely evening.', 'Have you tried the soup?', 'The lanterns are my favourite part.'] },
  ] },
};
function dlgPick(npc, flags) { for (const n of npc.dlg) { if (n.req.every(f => flags[f]) && !n.not.some(f => flags[f])) return n; } return npc.dlg[npc.dlg.length - 1]; }
function dlgSpeak(S, npc, flags, i) { const n = dlgPick(npc, flags), line = n.lines[Math.max(0, i | 0) % n.lines.length], last = (i | 0) >= n.lines.length - 1; if (last && n.once) S.flags['talked_' + n.id] = 1; return { node: n.id, line, last, then: last ? npc.then || null : null, count: n.lines.length }; }

// ---- day / night: 6 minutes of town time per cycle --------------------------------------------------------------------------------------------------------------------------------------------------------
const TOWN_DAY = 360;
function townClock(t) { const k = ((t % TOWN_DAY) + TOWN_DAY) % TOWN_DAY / TOWN_DAY; // 0 = noon-ish golden afternoon, ends at the next one
  let a, b, f; if (k < 0.42) { a = 'day'; b = 'day'; f = 0; } else if (k < 0.55) { a = 'day'; b = 'dusk'; f = (k - 0.42) / 0.13; } else if (k < 0.62) { a = 'dusk'; b = 'night'; f = (k - 0.55) / 0.07; } else if (k < 0.86) { a = 'night'; b = 'night'; f = 0; } else if (k < 0.94) { a = 'night'; b = 'dusk'; f = (k - 0.86) / 0.08; } else { a = 'dusk'; b = 'day'; f = (k - 0.94) / 0.06; }
  const night = a === 'night' && b === 'night' ? 1 : a === 'night' ? 1 - f : b === 'night' ? f : a === 'dusk' && b === 'dusk' ? 0.3 : (a === 'dusk' || b === 'dusk') ? 0.3 : 0; return { k, a, b, f, night: Math.max(0, Math.min(1, night)) };
}

// ---- THE LAYOUT: patches -> wards -> lots -> buildings, on a cell grid (1 cell = 1 cube). Deterministic from the seed. ---------------------------------------------------------------------------------------------------
// result.cells: Int8Array(N*N) kind per cell: 0 outside, 1 ground, 2 road, 3 plaza, 4 building, 5 garden, 6 wall / hedge, 7 gate; result.patch: Int16Array patch id per cell (-1 outside)
const TC = { OUT: 0, GROUND: 1, ROAD: 2, PLAZA: 3, BLDG: 4, GARDEN: 5, WALL: 6, GATE: 7, TRIM: 8 };
const TOWN_SIZES = { hall: [9, 8], market: [9, 7], kitchen: [8, 7], smithy: [8, 7], gems: [7, 7], apothecary: [7, 7], warehouse: [9, 8], garden: [11, 9], board: [3, 2], home: [6, 6] }; // footprint w (across the front) x d (depth)
function townLayout(seed, o) {
  o = o || {}; const R = o.R || 25, N = R * 2 + 7, H = N >> 1, r = rpgRng(rpgHashSeed(seed >>> 0, 0x70F7)), TAU2 = Math.PI * 2;
  const idx = (x, z) => (z + H) * N + (x + H), inb = (x, z) => x >= -H && x < N - H && z >= -H && z < N - H;
  const gateAng = r() * TAU2, phase = r() * 6.28;
  // ---- patches: a plaza site in the middle and 8 outer sites; two Lloyd relaxation steps on the grid so the cells come out roughly even
  const sites = [{ x: 0, z: 0, w: 1.0, kind: 'plaza' }]; for (let i = 0; i < 8; i++) { const a = gateAng + (i + 0.5) / 8 * TAU2 + (r() - 0.5) * 0.36, rr = 12.5 + r() * 3.5; sites.push({ x: Math.cos(a) * rr, z: Math.sin(a) * rr, w: 1, kind: '', ang: a, rr }); }
  const inside = (x, z) => { const d = Math.hypot(x, z) + 1.2 * Math.sin(x * 0.29 + z * 0.17 + phase) + 0.8 * Math.sin(z * 0.41 - x * 0.23 + phase * 2); return d <= R; };
  const label = new Int16Array(N * N).fill(-1); const angDiffS = (a, b) => { let d = (b - a) % TAU2; if (d > Math.PI) d -= TAU2; if (d < -Math.PI) d += TAU2; return d; };
  const assign = () => { for (let z = -H; z < N - H; z++) for (let x = -H; x < N - H; x++) { if (!inside(x, z)) { label[idx(x, z)] = -1; continue; } let best = 0, bd = 1e9; for (let i = 0; i < sites.length; i++) { const s = sites[i], d = Math.hypot(x - s.x, z - s.z) / s.w + 0.9 * Math.sin(x * 0.37 + i + z * 0.11); if (d < bd) { bd = d; best = i; } } label[idx(x, z)] = best; } };
  for (let it = 0; it < 3; it++) { assign(); for (let i = 1; i < sites.length; i++) { let sx = 0, sz = 0, n = 0; for (let z = -H; z < N - H; z++) for (let x = -H; x < N - H; x++) if (label[idx(x, z)] === i) { sx += x; sz += z; n++; } if (n) { const ac = Math.atan2(sz, sx), a0 = Math.atan2(sites[i].z, sites[i].x), aa = a0 + angDiffS(a0, ac) * 0.8; sites[i].x = Math.cos(aa) * sites[i].rr; sites[i].z = Math.sin(aa) * sites[i].rr; } } }
  assign();
  // ---- wards: the patch facing the gate angle is the GATE ward, the one opposite it is FARM; the other six hold the main buildings
  const angDiff2 = (a, b) => { let d = (a - b) % TAU2; if (d > Math.PI) d -= TAU2; if (d < -Math.PI) d += TAU2; return Math.abs(d); };
  const outer = []; for (let i = 1; i < sites.length; i++) outer.push(i); outer.sort((a, b) => angDiff2(Math.atan2(sites[a].z, sites[a].x), gateAng) - angDiff2(Math.atan2(sites[b].z, sites[b].x), gateAng));
  const area = new Int32Array(sites.length); for (let k = 0; k < label.length; k++) if (label[k] >= 0) area[label[k]]++; const gateP = outer[0]; let farmP = -1; for (const i of outer) if (i !== gateP && (farmP < 0 || area[i] > area[farmP])) farmP = i; sites[gateP].kind = 'gate'; sites[farmP].kind = 'farm'; const mainP = outer.filter(i => i !== gateP && i !== farmP);
  // the six main patches get a building each; the order is a seeded shuffle, hall first nearest to the plaza axis facing away from the gate so the plaza reads as hall-fronted
  const roles = ['hall', 'kitchen', 'smithy', 'gems', 'apothecary', 'warehouse']; for (let i = roles.length - 1; i > 0; i--) { const j = (r() * (i + 1)) | 0; [roles[i], roles[j]] = [roles[j], roles[i]]; }
  const mainByAngle = mainP.slice().sort((a, b) => angDiff2(Math.atan2(sites[b].z, sites[b].x), gateAng) - angDiff2(Math.atan2(sites[a].z, sites[a].x), gateAng)); const hallI = roles.indexOf('hall'); [roles[0], roles[hallI]] = [roles[hallI], roles[0]]; // the patch farthest from the gate (angle) hosts the hall
  mainByAngle.forEach((pi, k) => { sites[pi].kind = 'main'; sites[pi].role = roles[k]; });
  // ---- roads: cells next to a patch border (between two outer patches, or outer / plaza), the plaza itself, and a 3-wide main road from the plaza to the gate
  const cells = new Int8Array(N * N); let nOut = 0;
  for (let z = -H; z < N - H; z++) for (let x = -H; x < N - H; x++) { const l = label[idx(x, z)]; if (l < 0) continue; cells[idx(x, z)] = l === 0 ? TC.PLAZA : TC.GROUND; }
  for (let z = -H; z < N - H; z++) for (let x = -H; x < N - H; x++) { const l = label[idx(x, z)]; if (l <= 0) continue; for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) { if (!inb(x + dx, z + dz)) continue; const m = label[idx(x + dx, z + dz)]; if (m >= 0 && m !== l) { cells[idx(x, z)] = TC.ROAD; break; } } }
  const ca = Math.cos(gateAng), sa = Math.sin(gateAng); for (let t = 0; t <= R + 2; t += 0.5) for (let w = -1; w <= 1; w++) { const x = Math.round(ca * t - sa * w), z = Math.round(sa * t + ca * w); if (inb(x, z) && label[idx(x, z)] >= 0 && cells[idx(x, z)] !== TC.PLAZA) cells[idx(x, z)] = TC.ROAD; }
  // rim: hedge / wall ring, with a gap at the gate
  const rim = []; for (let z = -H; z < N - H; z++) for (let x = -H; x < N - H; x++) { if (label[idx(x, z)] < 0) continue; let edge = false; for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) { if (!inb(x + dx, z + dz) || label[idx(x + dx, z + dz)] < 0) edge = true; } if (edge) rim.push([x, z]); }
  const gateCell = (() => { let best = null, bd = -1e9; for (const [x, z] of rim) { const d = (x * ca + z * sa) - Math.abs(x * -sa + z * ca) * 3; if (d > bd) { bd = d; best = [x, z]; } } return best; })();
  for (const [x, z] of rim) { if (Math.hypot(x - gateCell[0], z - gateCell[1]) <= 2.2) cells[idx(x, z)] = TC.GATE; else cells[idx(x, z)] = TC.WALL; }
  // ---- lots: every patch is cut into lots: repeatedly claim the largest free rectangle (<= 9 x 9, >= 5 x 5) and leave a one-cell alley around it (the Cutter idea: bisect, keep an alley gap)
  const free = (x, z, pi) => inb(x, z) && label[idx(x, z)] === pi && cells[idx(x, z)] === TC.GROUND;
  const rectFree = (x0, z0, x1, z1, pi) => { let n = 0, t = 0; for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) { t++; if (free(x, z, pi)) n++; } return t > 0 && n / t >= 0.97; };
  const lots = [];
  for (let pi = 1; pi < sites.length; pi++) {
    if (sites[pi].kind === 'gate') continue; const m = new Uint8Array(N * N); for (let z = -H; z < N - H; z++) for (let x = -H; x < N - H; x++) m[idx(x, z)] = free(x, z, pi) ? 1 : 0;
    for (let k = 0; k < 7; k++) {
      let best = null;
      for (let z = -H; z < N - H; z++) for (let x = -H; x < N - H; x++) { if (!m[idx(x, z)]) continue; let w = 9; for (let d = 1; d <= 9 && z + d <= N - H; d++) { let run = 0; while (run < w && x + run < N - H && m[idx(x + run, z + d - 1)]) run++; w = run; if (w < 5) break; if (d >= 5) { const a = w * d; if (!best || a > best.a) best = { x0: x, z0: z, x1: x + w, z1: z + d, a }; } } }
      if (!best) break; lots.push({ x0: best.x0, z0: best.z0, x1: best.x1, z1: best.z1, patch: pi });
      for (let zz = best.z0 - 1; zz <= best.z1; zz++) for (let xx = best.x0 - 1; xx <= best.x1; xx++) if (inb(xx, zz)) m[idx(xx, zz)] = 0;
    }
  }
  // ---- placement: each main patch's building takes the valid lot closest to the plaza; farm patch -> the garden; leftover lots become homes (some stay empty for trees)
  const buildings = [], used = []; const distPlaza = lt => Math.hypot((lt.x0 + lt.x1) / 2, (lt.z0 + lt.z1) / 2);
  const place = (role, pi, size) => {
    const [fw, fd] = size; let cand = lots.filter(l => l.patch === pi && !l.used).sort((a, b) => distPlaza(a) - distPlaza(b)); let best = null;
    const need = Math.min(fw, fd) - 1; for (const l of cand) { const w = l.x1 - l.x0, d = l.z1 - l.z0; if (Math.min(w, d) >= need) { best = l; break; } } if (!best) for (const l of cand) { if (Math.min(l.x1 - l.x0, l.z1 - l.z0) >= 5) { best = l; break; } }
    let rect = null; if (best) { best.used = true; const cx = (best.x0 + best.x1) / 2, cz = (best.z0 + best.z1) / 2, fdx = -cx, fdz = -cz, alongX = Math.abs(fdx) >= Math.abs(fdz); // the front faces the plaza: depth runs along the facing axis
      const W = alongX ? fd : fw, D = alongX ? fw : fd, ww = Math.min(best.x1 - best.x0, W), dd = Math.min(best.z1 - best.z0, D); const x0 = Math.round(cx - ww / 2), z0 = Math.round(cz - dd / 2); rect = { x0, z0, x1: x0 + ww, z1: z0 + dd }; }
    if (!rect) { // fallback: the largest free rectangle (<= size) around the patch centroid
      const s = sites[pi]; let found = null; for (let rad = 0; rad < 8 && !found; rad++) for (let k = 0; k < 16 && !found; k++) { const a = k / 16 * TAU2, cx = Math.round(s.x + Math.cos(a) * rad), cz = Math.round(s.z + Math.sin(a) * rad); for (const [ww, dd] of [[fw, fd], [fd, fw], [7, 7], [6, 6], [5, 5]]) { const x0 = cx - (ww >> 1), z0 = cz - (dd >> 1); if (rectFree(x0, z0, x0 + ww, z0 + dd, pi)) { found = { x0, z0, x1: x0 + ww, z1: z0 + dd }; break; } } } rect = found; }
    if (!rect) return null;
    const cx = (rect.x0 + rect.x1) / 2, cz = (rect.z0 + rect.z1) / 2, face = Math.abs(cx) >= Math.abs(cz) ? (cx > 0 ? 2 : 0) : (cz > 0 ? 3 : 1); // 0 = +x front, 1 = +z front, 2 = -x front, 3 = -z front (the direction the door looks)
    const door = face === 0 ? [rect.x1, Math.round(cz - 0.5)] : face === 1 ? [Math.round(cx - 0.5), rect.z1] : face === 2 ? [rect.x0 - 1, Math.round(cz - 0.5)] : [Math.round(cx - 0.5), rect.z0 - 1];
    const b = { role, patch: pi, x0: rect.x0, z0: rect.z0, x1: rect.x1, z1: rect.z1, face, door }; buildings.push(b); for (let z = rect.z0; z < rect.z1; z++) for (let x = rect.x0; x < rect.x1; x++) if (inb(x, z)) cells[idx(x, z)] = TC.BLDG; return b;
  };
  for (let i = 1; i < sites.length; i++) if (sites[i].kind === 'main') place(sites[i].role, i, TOWN_SIZES[sites[i].role]);
  // garden: a fenced rectangle in the farm patch; its beds are generated from the patch cells
  let garden = null; { const pi = farmP; const g = place('garden', pi, TOWN_SIZES.garden); if (g) { garden = g; for (let z = g.z0; z < g.z1; z++) for (let x = g.x0; x < g.x1; x++) if (inb(x, z)) cells[idx(x, z)] = TC.GARDEN; } }
  // homes: leftover valid lots in main + farm patches (decorative cottages); at most 8
  const homes = []; for (const l of lots) { if (l.used || homes.length >= 8 || sites[l.patch].kind === 'gate') continue; const w = l.x1 - l.x0, d = l.z1 - l.z0; if (Math.min(w, d) < 5) continue; const hw = Math.min(w, 6 + ((r() * 2) | 0)), hd = Math.min(d, 6); const cx = (l.x0 + l.x1) / 2, cz = (l.z0 + l.z1) / 2, x0 = Math.round(cx - hw / 2), z0 = Math.round(cz - hd / 2); let ok = true; for (let z = z0; z < z0 + hd && ok; z++) for (let x = x0; x < x0 + hw; x++) if (!inb(x, z) || cells[idx(x, z)] !== TC.GROUND) { ok = false; break; } if (!ok) continue;
    const face = Math.abs(cx) >= Math.abs(cz) ? (cx > 0 ? 2 : 0) : (cz > 0 ? 3 : 1); const rect = { x0, z0, x1: x0 + hw, z1: z0 + hd }; const door = face === 0 ? [rect.x1, Math.round(cz - 0.5)] : face === 1 ? [Math.round(cx - 0.5), rect.z1] : face === 2 ? [rect.x0 - 1, Math.round(cz - 0.5)] : [Math.round(cx - 0.5), rect.z0 - 1];
    const b = { role: 'home', patch: l.patch, x0, z0, x1: x0 + hw, z1: z0 + hd, face, door, style: homes.length % 4 }; homes.push(b); buildings.push(b); for (let z = z0; z < z0 + hd; z++) for (let x = x0; x < x0 + hw; x++) cells[idx(x, z)] = TC.BLDG; }
  // ---- plaza features: fountain in the middle, market stalls on the ring, the notice board on the plaza edge nearest the hall
  const hall = buildings.find(b => b.role === 'hall'), pr = (() => { let m = 0; for (let z = -H; z < N - H; z++) for (let x = -H; x < N - H; x++) if (label[idx(x, z)] === 0) m = Math.max(m, Math.hypot(x, z)); return m; })();
  const stalls = []; for (let i = 0; i < 4; i++) { const a = gateAng + Math.PI * 0.5 * (i + 0.5) + 0.3, rr = Math.max(4.5, pr - 2.6); stalls.push({ x: Math.round(Math.cos(a) * rr), z: Math.round(Math.sin(a) * rr), face: Math.abs(Math.cos(a)) >= Math.abs(Math.sin(a)) ? (Math.cos(a) > 0 ? 2 : 0) : (Math.sin(a) > 0 ? 3 : 1) }); }
  const ha = hall ? Math.atan2((hall.z0 + hall.z1) / 2, (hall.x0 + hall.x1) / 2) : gateAng + Math.PI; const board = { x: Math.round(Math.cos(ha + 0.55) * (pr - 1.6)), z: Math.round(Math.sin(ha + 0.55) * (pr - 1.6)), face: 0 }; board.face = Math.abs(board.x) >= Math.abs(board.z) ? (board.x > 0 ? 2 : 0) : (board.z > 0 ? 3 : 1);
  const spawn = { x: Math.round(ca * Math.max(4, pr - 2)), z: Math.round(sa * Math.max(4, pr - 2)) };
  const portal = { x: Math.round(ca * (R - 5)), z: Math.round(sa * (R - 5)), ang: gateAng };
  // ---- lamps along the roads, trees on free ground (dart throwing), garden beds
  const lamps = []; for (let z = -H; z < N - H; z++) for (let x = -H; x < N - H; x++) { if (cells[idx(x, z)] !== TC.ROAD || (x + z * 3) % 7 !== 0) continue; if (lamps.some(l => Math.hypot(l.x - x, l.z - z) < 6)) continue; lamps.push({ x, z }); }
  const trees = []; for (let k = 0; k < 400 && trees.length < 30; k++) { const x = Math.round((r() * 2 - 1) * R), z = Math.round((r() * 2 - 1) * R); if (!inb(x, z) || cells[idx(x, z)] !== TC.GROUND) continue; let near = false; for (let dz = -2; dz <= 2 && !near; dz++) for (let dx = -2; dx <= 2; dx++) { const t = inb(x + dx, z + dz) ? cells[idx(x + dx, z + dz)] : 0; if (t === TC.BLDG || t === TC.ROAD || t === TC.PLAZA || t === TC.GARDEN || t === TC.GATE) { near = true; break; } } if (near || trees.some(t => Math.hypot(t.x - x, t.z - z) < 4.2)) continue; trees.push({ x, z, kind: (r() * 3) | 0, h: 4 + ((r() * 4) | 0) }); }
  const beds = []; if (garden) { const gx0 = garden.x0 + 1, gz0 = garden.z0 + 1, cols = Math.max(1, Math.floor((garden.x1 - garden.x0 - 1) / 3)), rows = Math.max(1, Math.floor((garden.z1 - garden.z0 - 1) / 2)); for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) if (beds.length < 12) beds.push({ x: gx0 + i * 3 + 1, z: gz0 + j * 2 }); }
  // ---- ambient walk loops (waypoints on roads / plaza) + NPC stand points just in front of every door
  const paths = []; { const pp = []; for (let k = 0; k < 10; k++) { const a = k / 10 * TAU2, rr = Math.max(3.5, pr - 3.6); pp.push({ x: Math.cos(a) * rr, z: Math.sin(a) * rr }); } paths.push(pp); paths.push([{ x: spawn.x, z: spawn.z }, { x: ca * (R - 8), z: sa * (R - 8) }, { x: spawn.x, z: spawn.z }, { x: 0, z: 0 }]); }
  const stand = {}; const fdir = [[1, 0], [0, 1], [-1, 0], [0, -1]]; for (const b of buildings) if (b.role !== 'home') { const d = fdir[b.face]; stand[b.role] = { x: b.door[0] + d[0] * 1.5 + 0.5, z: b.door[1] + d[1] * 1.5 + 0.5, face: b.face }; }
  stand.market = { x: stalls[0].x, z: stalls[0].z, face: stalls[0].face }; stand.board = { x: board.x, z: board.z, face: board.face };
  const rolesPlaced = buildings.map(b => b.role).filter(x => x !== 'home');
  return { seed: seed >>> 0, R, N, H, cells, label, patches: sites.map((s, i) => ({ id: i, x: s.x, z: s.z, kind: s.kind, role: s.role || null })), gateAng, gate: { x: gateCell[0], z: gateCell[1] }, portal, spawn, buildings, garden, stalls, board, lamps, trees, beds, paths, stand, plazaR: pr, lots: lots.length, rolesPlaced, idx, inb };
}
function townLayoutHash(L) { let h = 2166136261 >>> 0; const mix = v => { h ^= (v | 0) & 0xffff; h = Math.imul(h, 16777619) >>> 0; }; for (let i = 0; i < L.cells.length; i++) mix(L.cells[i]); for (const b of L.buildings) { mix(b.x0); mix(b.z0); mix(b.x1); mix(b.z1); mix(b.face); mix(b.role.charCodeAt(0) * 131 + b.role.length); } for (const l of L.lamps) { mix(l.x); mix(l.z); } for (const t of L.trees) { mix(t.x); mix(t.z); } mix(L.spawn.x); mix(L.spawn.z); mix(L.portal.x); mix(L.portal.z); return h >>> 0; }
function townReachable(L) { // flood fill over walkable cells (not building / wall / outside) from the spawn: returns the set of building roles whose door cell is reachable
  const { N, H, cells, idx, inb } = L, seen = new Uint8Array(N * N), q = [[L.spawn.x, L.spawn.z]]; seen[idx(L.spawn.x, L.spawn.z)] = 1; const walk = c => c === TC.GROUND || c === TC.ROAD || c === TC.PLAZA || c === TC.GATE || c === TC.GARDEN;
  while (q.length) { const [x, z] = q.pop(); for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) { const nx = x + dx, nz = z + dz; if (!inb(nx, nz)) continue; const k = idx(nx, nz); if (seen[k] || !walk(cells[k])) continue; seen[k] = 1; q.push([nx, nz]); } }
  const ok = {}; for (const b of L.buildings) { const [dx, dz] = b.door; ok[b.role + (b.role === 'home' ? ':' + b.x0 + ',' + b.z0 : '')] = inb(dx, dz) && !!seen[idx(dx, dz)]; } return ok;
}
// </town-core>


