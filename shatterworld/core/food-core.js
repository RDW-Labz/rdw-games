// <food-core> ===================================================================================================================
// SHATTERWORLD food + cooking + potions, part 1 of 2: pure data and deterministic functions. No DOM, no three.js, no game globals (needs rpgRng / rpgHashSeed from rpg-core).
// scratchpad/shatter-passB/food-unit.mjs extracts this block verbatim and runs it under node (recipe resolution by tag, quality, buffs, drops, no item duplication / loss).
// borrowed (structure + numbers, own names and text): blecki/dwarfcorp World/ResourceItems/*.json (modified MIT, data only): a recipe lists its INGREDIENTS BY TAG
//   (Craft_Ingredients: [{Tag, Count}]), a Craft_Location (station) and a base craft time; food items carry a nutrition number (Bread 350 / Meal 500 / Meat 250) and potions a timed effect.
//   tenplus1/farming item_recipes.lua + item_food.lua (MIT code): ingredient groups (group:food_flour ...) = our tags, crop -> ingredient -> dish graph.
//   flareteam/flare-game items/categories/potions.txt + powers/effects.txt (CC BY-SA 3.0, structure only): item -> effect id -> timed buff indirection.
//   cleverraven/cataclysm-dda data/json/items/comestibles (CC BY-SA 3.0, structure only): per-food heal / fun / quench numbers were used as relative sizes only (rescaled, renamed, no text copied).
// A hunger-free design: food is POWER, never a chore. Eating is optional; nothing spoils; there is no hunger bar.
// ==============================================================================================================================
const FOOD_TAGS = ['meat', 'veg', 'fruit', 'grain', 'herb', 'mushroom', 'egg', 'fish', 'spice', 'sweet', 'water'];
const FOOD_TAG_LABEL = { meat: 'Meat', veg: 'Vegetable', fruit: 'Fruit', grain: 'Grain', herb: 'Herb', mushroom: 'Mushroom', egg: 'Egg', fish: 'Shellfish', spice: 'Spice', sweet: 'Sweetener', water: 'Water' };
function ingDef(id, name, tags, tier, glyph, col, o) { return Object.assign({ id, name, tags, tier, glyph, col, kind: 'ing', sell: [3, 9, 24][tier] || 3, desc: '' }, o); }
const INGS = {};
[
  // gathered in the world / grown in the town garden
  ingDef('sunberry', 'Sunberry', ['fruit', 'sweet'], 0, 'berry', '#ff6a7a', { desc: 'Sweet and bright. Grows wild in sunny places.' }),
  ingDef('crunchroot', 'Crunchroot', ['veg'], 0, 'root', '#ffa04a', { desc: 'A fat orange root that snaps when you bite it.' }),
  ingDef('windgrass', 'Windgrass Grain', ['grain'], 0, 'grain', '#e8d27a', { desc: 'Heavy seed heads that rustle in the breeze.' }),
  ingDef('brightleaf', 'Brightleaf', ['herb'], 0, 'leaf', '#6ee08a', { desc: 'A fresh green herb with a clean, sharp smell.' }),
  ingDef('fuzzcap', 'Fuzzcap', ['mushroom'], 0, 'cap', '#c8a0ff', { desc: 'A velvety purple mushroom. Earthy.' }),
  ingDef('dewmelon', 'Dewmelon', ['fruit', 'water'], 1, 'melon', '#7ae0c0', { desc: 'Cool and full of sweet water.' }),
  ingDef('goldcorn', 'Goldcorn', ['grain', 'sweet'], 1, 'corn', '#ffd84a', { desc: 'Sweet golden kernels in a tight cob.' }),
  ingDef('moonmint', 'Moonmint', ['herb', 'spice'], 1, 'mint', '#9fe8ff', { desc: 'Pale leaves with a cooling bite.' }),
  ingDef('emberpepper', 'Ember Pepper', ['spice', 'veg'], 1, 'pepper', '#ff4a2a', { desc: 'Small and furious.' }),
  ingDef('starbean', 'Starbean', ['veg'], 2, 'bean', '#ffe27a', { desc: 'A glowing pod that only ripens in the strangest worlds.' }),
  // bought at the market
  ingDef('springwater', 'Spring Water', ['water'], 0, 'drop', '#8ad0ff', { desc: 'A clean flask of water.' }),
  ingDef('honey', 'Wild Honey', ['sweet'], 1, 'honey', '#ffc23a', { desc: 'Thick and golden.' }),
  ingDef('saltcrystal', 'Salt Crystal', ['spice'], 0, 'salt', '#f0f4ff', { desc: 'A pinch of salt makes everything better.' }),
  // dropped by monsters
  ingDef('mushcap', 'Mushling Cap', ['mushroom'], 0, 'cap', '#c88a50', { desc: 'The cap of a defeated Mushling. Edible, if you insist.' }),
  ingDef('shellmeat', 'Shellback Haunch', ['meat'], 0, 'haunch', '#e8a08a', { desc: 'Tough but tasty.' }),
  ingDef('hopperleg', 'Hopper Leg', ['meat'], 1, 'leg', '#c8e8a0', { desc: 'Lean and springy.' }),
  ingDef('bruteloin', 'Brute Loin', ['meat'], 2, 'chop', '#d86a6a', { desc: 'A thick, marbled cut from something big.' }),
  ingDef('spitgland', 'Spit Gland', ['spice'], 1, 'gland', '#c88cff', { desc: 'Tangy and a little numbing.' }),
  ingDef('scuttleroe', 'Scuttle Roe', ['egg'], 0, 'roe', '#ffb8e0', { desc: 'Tiny pink eggs, salty and bright.' }),
  ingDef('ramchop', 'Ram Chop', ['meat'], 1, 'chop', '#c8906a', { desc: 'A hearty chop with a lot of character.' }),
  ingDef('crabmeat', 'Crab Claw Meat', ['fish', 'meat'], 1, 'claw', '#ffd0b0', { desc: 'Sweet white meat from inside a big shield.' }),
  ingDef('sproutbulb', 'Sprout Bulb', ['herb'], 1, 'bulb', '#9af0a0', { desc: 'Still growing. Smells like spring.' }),
  ingDef('glimmeregg', 'Glimmer Egg', ['egg'], 1, 'egg', '#bff8ff', { desc: 'A light-as-air egg that hums softly.' }),
  ingDef('moletruffle', 'Mole Truffle', ['mushroom', 'veg'], 1, 'cap', '#8a6a50', { desc: 'Dug up from the deep. Rich and savoury.' }),
  ingDef('sporepod', 'Spore Pod', ['mushroom', 'herb'], 1, 'pod', '#c8f070', { desc: 'A puffy pod, best eaten cooked.' }),
  ingDef('sparkpowder', 'Spark Powder', ['spice'], 1, 'powder', '#ffb060', { desc: 'Crackles on the tongue. Handle with care.' }),
].forEach(d => { INGS[d.id] = d; });
const ING_IDS = Object.keys(INGS);

// ---- materials for crafting: salvage + gathering + cooking leftovers --------------------------------------------------------------------------------
function matDef(id, name, glyph, col, tier, desc) { return { id, name, glyph, col, tier, kind: 'mat', sell: [4, 12, 30][tier] || 4, desc }; }
const MATS = {};
[
  matDef('scrap', 'Scrap', 'scrap', '#b6c2cf', 0, 'Salvaged bits of metal and cloth. The backbone of every repair.'),
  matDef('ore', 'Glintore', 'ore', '#7ab4ff', 1, 'A vein-ore that glints blue. Found in rocks and rift walls.'),
  matDef('hide', 'Tough Hide', 'hide', '#b08a5a', 1, 'Thick hide from big monsters. Good leatherwork.'),
  matDef('silk', 'Weaver Silk', 'silk', '#d8b8ff', 1, 'Strong, shimmering thread.'),
  matDef('timber', 'Timber', 'timber', '#a8743a', 0, 'Planks and beams, mostly from crates.'),
  matDef('essence', 'Essence', 'essence', '#8af7e6', 1, 'Distilled from herbs. Makes gear and gems sing.'),
  matDef('bonemeal', 'Bonemeal', 'bone', '#f2ead2', 0, 'A leftover of cooking. Fertilizer and flux.'),
  matDef('ash', 'Hearth Ash', 'ash', '#9aa0aa', 0, 'A leftover of cooking. Good for polishing and soap.'),
  matDef('crystal', 'Prism Crystal', 'crystal', '#ff9aff', 2, 'A crystal from the heart of a guardian. Gem makers love it.'),
].forEach(d => { MATS[d.id] = d; });
const MAT_IDS = Object.keys(MATS);
const foodItemDef = (id) => INGS[id] || MATS[id] || null;
function foodStackName(kind, id) { const d = kind === 'ing' ? INGS[id] : kind === 'mat' ? MATS[id] : null; return d ? d.name : id; }

// ---- effects: what a dish / potion does. mods are rpg-core stat ids (so the existing stat sheet / caps apply), hot = heal over time (fraction of max hp per second) -------------------------------
const FOOD_FX = {
  regen: { id: 'regen', name: 'Hearty', col: '#ff8a7a', text: 'Heals over time', hot: 0.008, mods: { hpRegen: 0.002 } },
  haste: { id: 'haste', name: 'Swift', col: '#9fe8ff', text: 'Run speed and jump height', mods: { runSpd: 0.07, jumpH: 0.05 } },
  might: { id: 'might', name: 'Mighty', col: '#ffb15e', text: 'Damage and crit', mods: { allDmg: 0.07, critChance: 0.02 } },
  guard: { id: 'guard', name: 'Sturdy', col: '#9fc6ff', text: 'Damage reduction and health', mods: { dmgReduce: 0.05, maxHp: 12 } },
  fortune: { id: 'fortune', name: 'Lucky', col: '#ffe27a', text: 'Shard find, gold find, magic find', mods: { dustFind: 0.2, goldFind: 0.12, magicFind: 0.05 } },
  focus: { id: 'focus', name: 'Focused', col: '#c8b0ff', text: 'Spark regeneration, cooldowns, skill damage', mods: { sparkRegen: 0.18, castSpeed: 0.04, skillDmg: 0.07 } },
  scholar: { id: 'scholar', name: 'Studious', col: '#8af7a6', text: 'Experience and gem experience', mods: { xpGain: 0.1, gemXp: 0.2 } },
  starlight: { id: 'starlight', name: 'Starlit', col: '#ffd45a', text: 'Star Power gain and duration', mods: { starGain: 0.15, starDur: 0.5 } },
};
const FOOD_Q = [{ name: 'Plain', mul: 1, dur: 1 }, { name: 'Tasty', mul: 1.25, dur: 1.2 }, { name: 'Delicious', mul: 1.5, dur: 1.4 }];
const FOOD_TUNING = { mealDur: 300, potionDur: 150, potionSlots: 2, stackCap: 99, kitchenDur: [1, 1, 1.2, 1.4], healPotion: 0.4 };

// ---- recipes: ingredients by TAG ({tag, n}) or by exact id ({id, n}); station = cook | alchemy; tier = station tier needed; out.type = dish | potion | mat ------------------------------------------------
function rec(id, station, name, ing, out, o) { return Object.assign({ id, station, name, ing, out, tier: 1, left: {}, unlock: { type: 'start' }, glyph: 'bowl', desc: '' }, o); }
const FOOD_RECIPES = {};
[
  // ---- cook pot, tier 1 (known from the start)
  rec('fruit_salad', 'cook', 'Sunberry Salad', [{ tag: 'fruit', n: 2 }], { type: 'dish', fx: ['regen'], k: [1] }, { glyph: 'salad', left: {}, desc: 'Sweet, cool and quietly healing.' }),
  rec('flatbread', 'cook', 'Windgrass Flatbread', [{ tag: 'grain', n: 2 }, { tag: 'herb', n: 1 }], { type: 'dish', fx: ['haste'], k: [1] }, { glyph: 'loaf', left: { ash: 1 }, desc: 'Light and quick. You will feel it in your legs.' }),
  rec('skewer', 'cook', 'Fuzzcap Skewer', [{ tag: 'mushroom', n: 2 }], { type: 'dish', fx: ['guard'], k: [1] }, { glyph: 'skewer', left: {}, desc: 'Charred, earthy, and unexpectedly protective.' }),
  rec('toast', 'cook', 'Honeyberry Toast', [{ tag: 'grain', n: 1 }, { tag: 'sweet', n: 1 }], { type: 'dish', fx: ['fortune'], k: [1] }, { glyph: 'loaf', left: { ash: 1 }, desc: 'Sticky and lucky.' }),
  rec('camp_roast', 'cook', 'Camp Roast', [{ tag: 'meat', n: 1 }, { tag: 'herb', n: 1 }], { type: 'dish', fx: ['might'], k: [1] }, { glyph: 'roast', left: { bonemeal: 1 }, desc: 'Meat on a stick. Heroes have eaten worse.' }),
  // ---- tier 2
  rec('stew', 'cook', 'Hearty Stew', [{ tag: 'meat', n: 1 }, { tag: 'veg', n: 2 }, { tag: 'water', n: 1 }], { type: 'dish', fx: ['guard', 'regen'], k: [1, 1] }, { tier: 2, glyph: 'stew', left: { bonemeal: 1 }, desc: 'Thick enough to stand a spoon in.', unlock: { type: 'tier' } }),
  rec('spiced_roast', 'cook', 'Spiced Roast', [{ tag: 'meat', n: 1 }, { tag: 'spice', n: 1 }, { tag: 'veg', n: 1 }], { type: 'dish', fx: ['might'], k: [1.5] }, { tier: 2, glyph: 'roast', left: { bonemeal: 1, ash: 1 }, desc: 'It bites back.', unlock: { type: 'tier' } }),
  rec('glazed_roots', 'cook', 'Glazed Crunchroots', [{ tag: 'veg', n: 2 }, { tag: 'sweet', n: 1 }], { type: 'dish', fx: ['focus'], k: [1] }, { tier: 2, glyph: 'salad', left: {}, desc: 'Shiny, sticky and very good for concentration.', unlock: { type: 'tier' } }),
  rec('mushroom_pie', 'cook', 'Mushroom Pie', [{ tag: 'mushroom', n: 2 }, { tag: 'grain', n: 1 }, { tag: 'egg', n: 1 }], { type: 'dish', fx: ['scholar'], k: [1] }, { tier: 2, glyph: 'pie', left: { ash: 1 }, desc: 'A golden crust and a lot to think about.', unlock: { type: 'seen', id: 'scuttleroe' } }),
  rec('chowder', 'cook', 'Claw Chowder', [{ tag: 'fish', n: 1 }, { tag: 'veg', n: 1 }, { tag: 'water', n: 1 }], { type: 'dish', fx: ['regen', 'haste'], k: [1, 0.7] }, { tier: 2, glyph: 'stew', left: { bonemeal: 1 }, desc: 'Creamy, briny, restoring.', unlock: { type: 'seen', id: 'crabmeat' } }),
  // ---- tier 3
  rec('feast', 'cook', 'Grand Feast Platter', [{ tag: 'meat', n: 1 }, { tag: 'veg', n: 1 }, { tag: 'grain', n: 1 }, { tag: 'fruit', n: 1 }, { tag: 'spice', n: 1 }], { type: 'dish', fx: ['might', 'guard', 'haste', 'fortune', 'regen'], k: [0.7, 0.7, 0.7, 0.7, 0.8] }, { tier: 3, glyph: 'feast', left: { bonemeal: 1, ash: 1 }, desc: 'A little of everything, and all of it good.', unlock: { type: 'tier' } }),
  rec('starcake', 'cook', 'Starlight Cake', [{ tag: 'grain', n: 2 }, { tag: 'sweet', n: 1 }, { tag: 'egg', n: 1 }, { id: 'starbean', n: 1 }], { type: 'dish', fx: ['starlight', 'scholar'], k: [1, 0.8] }, { tier: 3, glyph: 'cake', left: { ash: 1 }, desc: 'It sparkles when you cut it.', unlock: { type: 'seen', id: 'starbean' } }),
  rec('curry', 'cook', 'Emberpepper Curry', [{ tag: 'spice', n: 2 }, { tag: 'meat', n: 1 }, { tag: 'veg', n: 1 }], { type: 'dish', fx: ['might', 'regen'], k: [2, 0.5] }, { tier: 3, glyph: 'stew', left: { bonemeal: 1 }, desc: 'Not for the faint of heart.', unlock: { type: 'seen', id: 'emberpepper' } }),
  // ---- alchemy table: potions (instant heal where noted) and reagents
  rec('essence_brew', 'alchemy', 'Distil Essence', [{ tag: 'herb', n: 3 }, { tag: 'water', n: 1 }], { type: 'mat', id: 'essence', n: 1 }, { glyph: 'flask', left: {}, desc: 'Boil it down until only the shine is left.' }),
  rec('p_heal', 'alchemy', 'Mending Draught', [{ tag: 'herb', n: 2 }, { tag: 'water', n: 1 }], { type: 'potion', fx: ['regen'], k: [1.2], heal: 0.4, name: 'Mending Draught' }, { glyph: 'flask', left: {}, desc: 'Drink it and your wounds close. Heals at once, then keeps healing.' }),
  rec('p_swift', 'alchemy', 'Draught of Swiftness', [{ tag: 'herb', n: 1 }, { tag: 'spice', n: 1 }, { tag: 'water', n: 1 }], { type: 'potion', fx: ['haste'], k: [1.3], name: 'Draught of Swiftness' }, { glyph: 'flask', left: {}, desc: 'Faster feet for a little while.' }),
  rec('p_might', 'alchemy', 'Tonic of Might', [{ tag: 'spice', n: 1 }, { tag: 'mushroom', n: 1 }, { tag: 'water', n: 1 }], { type: 'potion', fx: ['might'], k: [1.3], name: 'Tonic of Might' }, { glyph: 'flask', left: {}, desc: 'Hits harder. Tastes terrible.' }),
  rec('p_fortune', 'alchemy', 'Philtre of Fortune', [{ tag: 'sweet', n: 1 }, { tag: 'herb', n: 1 }, { tag: 'water', n: 1 }], { type: 'potion', fx: ['fortune'], k: [1.4], name: 'Philtre of Fortune' }, { tier: 2, glyph: 'flask', left: {}, desc: 'Everything glitters a little more.', unlock: { type: 'tier' } }),
  rec('p_ward', 'alchemy', 'Ward Elixir', [{ tag: 'mushroom', n: 2 }, { tag: 'herb', n: 1 }, { tag: 'water', n: 1 }], { type: 'potion', fx: ['guard'], k: [1.4], name: 'Ward Elixir' }, { tier: 2, glyph: 'flask', left: {}, desc: 'A skin of calm over your skin.', unlock: { type: 'tier' } }),
  rec('p_focus', 'alchemy', 'Brew of Focus', [{ tag: 'herb', n: 2 }, { id: 'sparkpowder', n: 1 }, { tag: 'water', n: 1 }], { type: 'potion', fx: ['focus'], k: [1.4], name: 'Brew of Focus' }, { tier: 2, glyph: 'flask', left: {}, desc: 'Crackles. Your skills come faster.', unlock: { type: 'seen', id: 'sparkpowder' } }),
  rec('p_greater', 'alchemy', 'Greater Mending', [{ tag: 'herb', n: 3 }, { id: 'sproutbulb', n: 1 }, { tag: 'water', n: 1 }], { type: 'potion', fx: ['regen', 'guard'], k: [2, 0.6], heal: 0.7, name: 'Greater Mending' }, { tier: 3, glyph: 'flask', left: {}, desc: 'The good stuff. Heals most of your health at once.', unlock: { type: 'seen', id: 'sproutbulb' } }),
  rec('p_star', 'alchemy', 'Elixir of Stars', [{ id: 'essence', n: 1 }, { id: 'starbean', n: 1 }, { tag: 'water', n: 1 }], { type: 'potion', fx: ['starlight', 'might'], k: [1.6, 0.6], name: 'Elixir of Stars' }, { tier: 3, glyph: 'flask', left: {}, desc: 'Drink the night sky.', unlock: { type: 'seen', id: 'starbean' } }),
].forEach(r => { FOOD_RECIPES[r.id] = r; });
const FOOD_RECIPE_IDS = Object.keys(FOOD_RECIPES);

// ---- the satchel (a plain object of four stack tables) -------------------------------------------------------------------------------------------------
function satNew() { return { ing: {}, mat: {}, dish: {}, pot: {} }; }
function satCount(S, kind, id) { return (S[kind] && S[kind][id]) | 0; }
function satKnown(kind, id) { return kind === 'ing' ? !!INGS[id] : kind === 'mat' ? !!MATS[id] : (kind === 'dish' || kind === 'pot') ? !!FOOD_RECIPES[String(id).split(':')[0]] : false; } // an unknown id is never stored (a corrupt satchel entry would break every list that renders it)
function satAdd(S, kind, id, n, cap) { if (!S[kind] || !satKnown(kind, id)) return 0; const c = cap || FOOD_TUNING.stackCap; const have = satCount(S, kind, id), put = Math.max(0, Math.min(n | 0, c - have)); if (put > 0) S[kind][id] = have + put; return put; }
function satTake(S, kind, id, n) { const have = satCount(S, kind, id); if (n > have) return false; if (have - n > 0) S[kind][id] = have - n; else delete S[kind][id]; return true; }
function satTotal(S) { let t = 0; for (const k of ['ing', 'mat', 'dish', 'pot']) for (const id in S[k]) t += S[k][id]; return t; }
function satClean(raw) { const S = satNew(); if (!raw || typeof raw !== 'object') return S; for (const id in (raw.ing || {})) if (INGS[id] && raw.ing[id] > 0) S.ing[id] = Math.min(999, raw.ing[id] | 0); for (const id in (raw.mat || {})) if (MATS[id] && raw.mat[id] > 0) S.mat[id] = Math.min(999, raw.mat[id] | 0);
  for (const k of ['dish', 'pot']) for (const key in (raw[k] || {})) { const [rid, q] = key.split(':'); if (FOOD_RECIPES[rid] && FOOD_RECIPES[rid].out.type === (k === 'dish' ? 'dish' : 'potion') && raw[k][key] > 0) S[k][rid + ':' + Math.max(0, Math.min(2, q | 0))] = Math.min(99, raw[k][key] | 0); } return S; }

// ---- resolving a recipe by tags: deterministic, cheapest matching ingredient first, exact-id requirements before tag requirements --------------------------------------------------
// stock = satchel.ing + satchel.mat merged as {id: n}; prefs = {reqIndex: id} overrides the automatic choice. Returns { ok, picks: [{req, id, n}], missing: [{req, have, need}], tier (average tier of what was used) }
function foodStock(S) { const o = {}; for (const id in S.ing) o[id] = S.ing[id]; for (const id in S.mat) o[id] = (o[id] || 0) + S.mat[id]; return o; }
function foodCandidates(req, stock) { if (req.id) return [req.id]; return ING_IDS.filter(id => INGS[id].tags.includes(req.tag)); }
function foodResolve(recipe, stock, prefs) {
  prefs = prefs || {}; const left = Object.assign({}, stock), picks = [], missing = []; let tierSum = 0, tierN = 0;
  const order = recipe.ing.map((r, i) => i).sort((a, b) => { const ra = recipe.ing[a], rb = recipe.ing[b]; if (!!ra.id !== !!rb.id) return ra.id ? -1 : 1; const ca = foodCandidates(ra, stock).filter(id => stock[id] > 0).length, cb = foodCandidates(rb, stock).filter(id => stock[id] > 0).length; return ca - cb || a - b; });
  const result = new Array(recipe.ing.length);
  for (const i of order) {
    const req = recipe.ing[i]; let need = req.n; const got = [];
    const cand = foodCandidates(req, stock).filter(id => (left[id] | 0) > 0).sort((a, b) => { const pa = prefs[i] === a ? -1 : 0, pb = prefs[i] === b ? -1 : 0; if (pa !== pb) return pa - pb; const da = INGS[a] || MATS[a], db = INGS[b] || MATS[b]; return (da.tier - db.tier) || (a < b ? -1 : a > b ? 1 : 0); });
    for (const id of cand) { if (need <= 0) break; const take = Math.min(need, left[id]); left[id] -= take; need -= take; got.push({ req: i, id, n: take }); const d = INGS[id] || MATS[id]; tierSum += d.tier * take; tierN += take; }
    if (need > 0) missing.push({ req: i, tag: req.tag || null, id: req.id || null, have: req.n - need, need: req.n }); result[i] = got;
  }
  for (const g of result) if (g) picks.push(...g); picks.sort((a, b) => a.req - b.req);
  return { ok: missing.length === 0, picks, missing, tier: tierN ? tierSum / tierN : 0 };
}
function foodQuality(tierAvg) { return tierAvg < 0.55 ? 0 : tierAvg < 1.25 ? 1 : 2; }
function foodDishKey(rid, q) { return rid + ':' + q; }
function foodDescribeFx(rec, q, kitchenTier) { // the buff this recipe gives at quality q: [{fx, mods, hot}] merged into one {mods, hot}, plus the duration
  const Q = FOOD_Q[q], mods = {}; let hot = 0; const names = [];
  rec.out.fx.forEach((id, i) => { const fx = FOOD_FX[id], k = (rec.out.k[i] || 1) * Q.mul; names.push(fx.name); for (const s in (fx.mods || {})) mods[s] = (mods[s] || 0) + fx.mods[s] * k; if (fx.hot) hot += fx.hot * k; });
  const base = rec.out.type === 'potion' ? FOOD_TUNING.potionDur : FOOD_TUNING.mealDur, dur = Math.round(base * Q.dur * (rec.out.type === 'dish' ? (FOOD_TUNING.kitchenDur[kitchenTier | 0] || 1) : 1));
  return { mods, hot, dur, names, heal: rec.out.heal || 0 };
}
function foodRoundMods(m) { const o = {}; for (const k in m) o[k] = Math.round(m[k] * 100000) / 100000; return o; }
// cook: consumes the picks from the satchel, adds the output (+ leftovers), returns what happened. The satchel is untouched when anything fails (no loss, no duplication).
function foodCook(S, recipe, picks, kitchenTier) {
  const stockNow = foodStock(S); const need = {}; for (const p of picks) need[p.id] = (need[p.id] || 0) + p.n; for (const id in need) if ((stockNow[id] | 0) < need[id]) return { ok: false, why: 'missing ' + id };
  const tot = {}; recipe.ing.forEach((r, i) => { let n = 0; for (const p of picks) if (p.req === i) n += p.n; tot[i] = n; }); for (let i = 0; i < recipe.ing.length; i++) if (tot[i] !== recipe.ing[i].n) return { ok: false, why: 'incomplete picks' };
  for (const p of picks) { const d = INGS[p.id] || MATS[p.id]; if (!d) return { ok: false, why: 'bad pick' }; if (recipe.ing[p.req].tag && !(d.tags || []).includes(recipe.ing[p.req].tag)) return { ok: false, why: 'tag mismatch' }; if (recipe.ing[p.req].id && recipe.ing[p.req].id !== p.id) return { ok: false, why: 'id mismatch' }; }
  let tierSum = 0, tierN = 0; for (const p of picks) { const d = INGS[p.id] || MATS[p.id]; tierSum += d.tier * p.n; tierN += p.n; }
  const q = foodQuality(tierN ? tierSum / tierN : 0), kind = recipe.out.type;
  // capacity: the output must fit before anything is taken
  const outKind = kind === 'dish' ? 'dish' : kind === 'potion' ? 'pot' : 'mat', outId = kind === 'mat' ? recipe.out.id : foodDishKey(recipe.id, q), outN = kind === 'mat' ? recipe.out.n : 1;
  const snap = JSON.parse(JSON.stringify(S));
  for (const id in need) { const kk = INGS[id] ? 'ing' : 'mat'; let want = need[id]; const fromIng = INGS[id] ? satCount(S, 'ing', id) : 0; if (kk === 'ing') { satTake(S, 'ing', id, Math.min(want, fromIng)); want -= Math.min(want, fromIng); } if (want > 0) satTake(S, 'mat', id, want); }
  const put = satAdd(S, outKind, outId, outN); if (put < outN) { for (const k of ['ing', 'mat', 'dish', 'pot']) S[k] = snap[k]; return { ok: false, why: 'satchel full' }; }
  const lo = {}; for (const id in recipe.left) { const p = satAdd(S, 'mat', id, recipe.left[id]); if (p) lo[id] = p; }
  return { ok: true, q, out: { kind: outKind, id: outId, n: outN }, left: lo, used: need };
}

// ---- eating / drinking: buffs ----------------------------------------------------------------------------------------------------------------------------------------------------
// buff = { slot, src, name, col, t (seconds left), dur, mods, hot (heal fraction per second), q }. Slots: 'meal' (one) and 'p0'.. 'p1' (potions, the same potion refreshes its slot).
function foodMakeBuff(rid, q, kitchenTier) { const r = FOOD_RECIPES[rid]; if (!r || r.out.type === 'mat') return null; const e = foodDescribeFx(r, q, kitchenTier); return { slot: r.out.type === 'dish' ? 'meal' : 'pot', src: rid, name: (r.out.type === 'potion' ? r.out.name : FOOD_Q[q].name + ' ' + r.name), col: FOOD_FX[r.out.fx[0]].col, t: e.dur, dur: e.dur, mods: foodRoundMods(e.mods), hot: e.hot, q, heal: e.heal }; }
function foodApplyBuff(buffs, b) { // returns the list after adding b (a meal replaces the meal; a potion refreshes its own slot or takes a free potion slot, else replaces the oldest)
  const out = buffs.filter(x => x); if (b.slot === 'meal') { const i = out.findIndex(x => x.slot === 'meal'); if (i >= 0) out.splice(i, 1); out.push(b); return out; }
  const same = out.findIndex(x => x.slot === 'pot' && x.src === b.src); if (same >= 0) { out[same] = b; return out; } const pots = out.filter(x => x.slot === 'pot'); if (pots.length >= FOOD_TUNING.potionSlots) { let o = 0; for (let i = 1; i < pots.length; i++) if (pots[i].t < pots[o].t) o = i; out.splice(out.indexOf(pots[o]), 1); } out.push(b); return out;
}
function foodTick(buffs, dt) { for (let i = buffs.length - 1; i >= 0; i--) { buffs[i].t -= dt; if (buffs[i].t <= 0) buffs.splice(i, 1); } return buffs; }
function foodMods(buffs) { const m = {}; for (const b of buffs) for (const k in b.mods) m[k] = (m[k] || 0) + b.mods[k]; return m; }
function foodHot(buffs) { let h = 0; for (const b of buffs) h += b.hot || 0; return h; }
const C_STAT_OK = k => typeof RPG_STATS === 'object' && !!RPG_STATS[k];
function foodBuffClean(b) { if (!b || typeof b !== 'object' || !FOOD_RECIPES[b.src]) return null; const r = FOOD_RECIPES[b.src]; if (r.out.type === 'mat') return null; const q = Math.max(0, Math.min(2, b.q | 0)), mk = foodMakeBuff(b.src, q, 3); if (!mk) return null; mk.t = Math.max(0, Math.min(mk.dur * 1.01, +b.t || 0)); if (!(mk.t > 0)) return null; mk.dur = Math.max(mk.t, Math.min(+b.dur || mk.dur, mk.dur * 1.5)); mk.mods = {}; for (const k in (b.mods || {})) if (typeof b.mods[k] === 'number' && Number.isFinite(b.mods[k]) && Math.abs(b.mods[k]) < 200 && C_STAT_OK(k)) mk.mods[k] = b.mods[k]; mk.hot = Math.max(0, Math.min(0.05, +b.hot || 0)); mk.name = String(b.name || mk.name).slice(0, 40); mk.heal = Math.max(0, Math.min(1, +b.heal || 0)); return mk; }

// ---- where ingredients come from -----------------------------------------------------------------------------------------------------------------------------------------------------
// drops: monster type -> [ingredient, base chance, [min, max]]; tier multipliers: elites / champions drop more; source tables for crates, chests and Sun Shards
const FOOD_DROPS = {
  walker: [['mushcap', 0.2]], shell: [['shellmeat', 0.22]], hopper: [['hopperleg', 0.3], ['hide', 0.14]], brute: [['bruteloin', 0.55], ['hide', 0.3]], spitter: [['spitgland', 0.3]],
  slinger: [['sparkpowder', 0.2], ['scrap', 0.2]], rammer: [['ramchop', 0.35], ['hide', 0.3]], scuttler: [['scuttleroe', 0.18], ['silk', 0.08]], mender: [['sproutbulb', 0.5]], weaver: [['silk', 0.5], ['scuttleroe', 0.4]],
  fuse: [['sparkpowder', 0.4]], bulwark: [['crabmeat', 0.45], ['ore', 0.18]], wisp: [['glimmeregg', 0.3], ['essence', 0.1]], mole: [['moletruffle', 0.35], ['ore', 0.25]], puffer: [['sporepod', 0.45]], warden: [['bruteloin', 1], ['hide', 1, [2, 3]], ['ore', 0.6]],
  g_thorn: [['bruteloin', 1, [2, 3]], ['hide', 1, [3, 4]], ['crystal', 0.7], ['starbean', 0.6]], g_storm: [['glimmeregg', 1, [2, 3]], ['essence', 1, [2, 3]], ['crystal', 0.7], ['starbean', 0.6]], g_prism: [['crystal', 1, [1, 2]], ['ore', 1, [3, 4]], ['starbean', 0.8], ['essence', 1, [2, 3]]],
};
const FOOD_SRC = { crate: [['timber', 0.5, [1, 2]], ['scrap', 0.35, [1, 2]]], chest: [['scrap', 0.9, [2, 4]], ['ore', 0.5, [1, 2]], ['sunberry', 0.5, [1, 3]], ['honey', 0.3]], actchest: [['scrap', 1, [4, 7]], ['ore', 0.9, [2, 4]], ['hide', 0.6, [1, 2]], ['essence', 0.6, [1, 2]], ['crystal', 0.35]], shard: [['brightleaf', 0.8, [1, 2]], ['sunberry', 0.6, [1, 2]]], qblock: [['crunchroot', 0.35]] };
function foodRollDrops(r, srcKey, mobType, tier, mf) { // r = rng; returns [{id, n}] (merged). tier: normal / champion / elite / guardian
  const out = {}, tm = tier === 'guardian' ? 1.6 : tier === 'elite' ? 1.8 : tier === 'champion' ? 1.4 : 1, mm = 1 + (mf || 0) * 0.5, add = (id, n) => { out[id] = (out[id] || 0) + n; };
  const tbl = FOOD_DROPS[mobType] && (srcKey === 'normal' || srcKey === 'champion' || srcKey === 'elite' || srcKey === 'guardian') ? FOOD_DROPS[mobType] : FOOD_SRC[srcKey] || [];
  for (const row of tbl) { const p = Math.min(1, row[1] * tm * mm), u = r(), rr = r(); if (u < p) { const rg = row[2] || [1, 1]; add(row[0], rg[0] + Math.floor(rr * (rg[1] - rg[0] + 1))); } }
  return Object.keys(out).sort().map(id => ({ id, n: out[id] }));
}
// salvage: breaking a piece of gear also yields crafting materials (on top of the existing shard dust)
function foodSalvageMats(it) {
  const ri = ['common', 'magic', 'rare', 'legendary'].indexOf(it.rarity), il = it.ilvl | 0, out = {}; out.scrap = Math.max(1, Math.round([1, 2, 4, 9][ri] * (1 + il / 30)));
  if (it.slot === 'boots' || it.slot === 'gloves') out.hide = (ri >= 1 ? 1 : 0) + (ri >= 3 ? 1 : 0); if (it.slot === 'cap' || it.slot === 'body') out.silk = ri >= 2 ? 1 : 0; if (it.slot === 'charm') out.ore = ri >= 1 ? 1 + (ri >= 3 ? 1 : 0) : 0; if (ri >= 2) out.essence = (out.essence || 0) + (ri >= 3 ? 2 : 1);
  for (const k in out) if (!out[k]) delete out[k]; return out;
}
// gathering nodes: kind -> [id weights] per act (1..3); a node gives 1-3 of one ingredient
const GATHER = { herb: { 1: [['sunberry', 3], ['crunchroot', 3], ['windgrass', 3], ['brightleaf', 3], ['fuzzcap', 2]], 2: [['dewmelon', 2], ['goldcorn', 2], ['moonmint', 2], ['sunberry', 1], ['brightleaf', 2], ['fuzzcap', 1]], 3: [['emberpepper', 2], ['starbean', 0.7], ['moonmint', 2], ['fuzzcap', 2], ['dewmelon', 1]] }, ore: { 1: [['ore', 1]], 2: [['ore', 1]], 3: [['ore', 1]] } };
function gatherRoll(r, kind, act) { const tbl = (GATHER[kind] || GATHER.herb)[Math.max(1, Math.min(3, act | 0 || 1))]; let tot = 0; for (const t of tbl) tot += t[1]; let x = r() * tot, id = tbl[tbl.length - 1][0]; for (const t of tbl) { x -= t[1]; if (x <= 0) { id = t[0]; break; } } const n = 1 + Math.floor(r() * (kind === 'ore' ? 3 : 2.6)); return { id, n }; }
// market: always-on basics (the rotating offers come from town-core)
const FOOD_SHOP_BASICS = [['springwater', 6], ['saltcrystal', 8], ['honey', 22], ['brightleaf', 9], ['crunchroot', 7], ['windgrass', 7], ['sunberry', 8], ['fuzzcap', 8]];
// recipe discovery: unlock = start | tier (station tier reached) | seen (you have obtained that ingredient once)
function foodRecipeKnown(rec, ctx) { // ctx = { tiers: {cook, alchemy}, seen: {id: 1}, known: {rid: 1}, level }
  const u = rec.unlock || { type: 'start' }; if (u.type === 'start') return true; if (ctx.known && ctx.known[rec.id]) return true; if (u.type === 'tier') return ((ctx.tiers && ctx.tiers[rec.station]) | 0) >= rec.tier; if (u.type === 'seen') return !!(ctx.seen && ctx.seen[u.id]) && ((ctx.tiers && ctx.tiers[rec.station]) | 0) >= rec.tier; return false;
}
function foodDiscoverNow(ctx) { const out = []; for (const id of FOOD_RECIPE_IDS) { const r = FOOD_RECIPES[id]; if (!(ctx.known && ctx.known[id]) && (r.unlock || {}).type !== 'start' && foodRecipeKnown(r, ctx)) out.push(id); } return out; }
// </food-core>

