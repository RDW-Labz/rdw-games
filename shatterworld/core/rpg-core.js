// <rpg-core> =================================================================================================================
// SHATTERWORLD RPG layer, part 1 of 2: pure data + deterministic generators. No DOM, no three.js, no game globals.
// scratchpad/shatterworld-rpg/*.mjs extract this block verbatim and run it under node (item-generator unit tests, balance sim).
// Structure (not content) is inspired by the classic prefix/suffix affix tables (min item level gating, ranges rolled per item),
// rarity tiers with currency-style rerolls, monster affixes, and rift tiers. All names, numbers and tables here are original.
// =============================================================================================================================
const RPG_TUNING = {
  levelCap: 30, autoPerLevel: 1, pointsPerLevel: 2,
  // xp to go from level L to L+1 = round(base * L^pow). kill xp = killBase * (1 + perLevel*(mlvl-1)) * type * tier * difficulty * levelGap
  xp: { base: 70, pow: 1.78, killBase: 7, killPerLevel: 0.24,
    type: { walker: 1, shell: 1.2, brute: 3.4, hopper: 1.3, spitter: 1.7 }, tier: { normal: 1, champion: 2.6, elite: 4.6, guardian: 40 },
    obj: { shard: 14, chest: 8, crate: 0.5, qblock: 1.5, act: 30, rift: 70 } },   // objective xp in "kills at that monster level"
  attr: { power: { allDmg: 0.012 }, agility: { runSpd: 0.004, jumpH: 0.006, critChance: 0.002 }, resolve: { maxHp: 7, dmgReduce: 0.002 } },
  hp: { base: 100, perLevel: 9, regen: 0.004 },            // regen = fraction of max HP per second, always on
  dmg: { base: 10, perLevel: 0.16 },                       // hero hit damage at level L = base * (1 + perLevel*(L-1)) before gear / perks
  crit: { base: 0.05, power: 1.5 },
  kind: { punch: 1, dive: 1.35, stomp: 1.25, pound: 1.9, env: 2.6, pulse: 1.1, ring: 0.7, chain: 0.6, burst: 0.5, nova: 1.0, thorn: 1.5, splash: 0.6, afterimage: 1.2, spark: 0.8 },
  rewind: { base: 3, regen: 0.34, cd: 0.4, radius: 7, pull: 7 },   // charges, charges/s, pulse cooldown, pulse radius, pull speed (m/s)
  magnet: { base: 3.6, pickup: 1.45, goldMul: 1 },
  caps: { jumpH: 0.75, runSpd: 0.35, wallGrip: 1, critChance: 0.55, dmgReduce: 0.6, rewindMax: 6, magnet: 2.5, burstSize: 1.5, poundRad: 0.9, strikeRad: 0.9, castSpeed: 0.5, sparkRegen: 1.5, starGain: 1.5 },
  monster: { hp: { walker: 8, shell: 10, brute: 32, hopper: 9, spitter: 11 }, hpPerLevel: 0.22, hpQuad: 0.004,
    dmg: { walker: 33, shell: 33, brute: 50, hopper: 30, spitter: 26 }, dmgPerLevel: 0.105,
    spd: { walker: 1, shell: 1, brute: 1, hopper: 1, spitter: 1 },
    name: { walker: 'Mushling', shell: 'Shellback', brute: 'Brute', hopper: 'Hopper', spitter: 'Spitter' } },
  tiers: {
    normal: { hp: 1, size: 1, aff: [0, 0] }, champion: { hp: 1.8, size: 1.14, aff: [1, 1] }, elite: { hp: 2.8, size: 1.26, aff: [2, 3] }, guardian: { hp: 9, size: 1.9, aff: [3, 3] },
  },
  difficulty: [
    { id: 'normal', name: 'NORMAL', mlvl: 0, ilvlAdd: 0, ilvlFloor: 1, hp: 1, dmg: 1, xp: 1, req: null },
    { id: 'hard', name: 'HARD', mlvl: 10, ilvlAdd: 7, ilvlFloor: 12, hp: 1.25, dmg: 1.2, xp: 1.35, req: 'normal' },
    { id: 'nightmare', name: 'NIGHTMARE', mlvl: 20, ilvlAdd: 14, ilvlFloor: 24, hp: 1.6, dmg: 1.45, xp: 1.8, req: 'hard' },
  ],
  actMlvl: { 1: 1, 2: 6, 3: 11 }, actIlvl: 3,                // monster level at the start of each act; item level gained per act
  campaign: { extraPerAct: { 1: 14, 2: 11, 3: 11 }, champion: 0.18, elite: 0.12, brute: 0.12, hopper: 0.16, spitter: 0.14, chests: { 1: 3, 2: 2, 3: 2 }, crates: { 1: 9, 2: 6, 3: 6 } },
  rift: { maxTier: 15, limit: 210, need: 34, needPerTier: 3.2, alive: 9, alivePerTier: 0.55, every: 1.7, mlvl: 8, mlvlPerTier: 2.5, ilvlPerTier: 2, eliteBase: 0.05, elitePerTier: 0.009, champion: 0.14,
    guardianAffixes: 3, arena: 22, goldMul: 1.4, xpMul: 1 },
  drop: {
    rarityW: [640, 290, 62, 3.4], mfRarity: [0, 1, 1.5, 2.4],
    src: { // chance of any item, [min,max] item count, weights per rarity [common,magic,rare,legendary], gold [chance, scale], dust chance
      normal:   { p: 0.085, n: [1, 1], w: [1, 1, 1, 1], gold: [0.5, 1], dust: 0.05 },
      champion: { p: 0.55, n: [1, 1], w: [0.5, 1.4, 2.4, 2.4], gold: [0.9, 2], dust: 0.25 },
      elite:    { p: 1, n: [1, 2], w: [0.15, 1.2, 2.8, 3.8], gold: [1, 4], dust: 0.6 },
      guardian: { p: 1, n: [3, 3], w: [0, 0.7, 6, 9], gold: [1, 12], dust: 1 },
      crate:    { p: 0.07, n: [1, 1], w: [1.2, 1, 0.6, 0.4], gold: [1, 1.4], dust: 0.08 },
      chest:    { p: 1, n: [2, 3], w: [0, 1.6, 4, 5], gold: [1, 6], dust: 1 },
      actchest: { p: 1, n: [2, 3], w: [0, 0.5, 5, 9], gold: [1, 10], dust: 1 },
      shard:    { p: 1, n: [1, 1], w: [0, 3, 3, 3], gold: [1, 3], dust: 0.5 },
      qblock:   { p: 0.3, n: [1, 1], w: [1, 1.3, 1, 1], gold: [1, 1], dust: 0.1 },
    },
    gold: { base: 3, perLevel: 1.15 }, dust: { base: 1, perLevel: 0.12 },
  },
  salvage: { dust: [1, 3, 8, 30], ilvlScale: 0.025 },
  reroll: { dust: [2, 4, 7, 14], gold: 18, goldPow: 0.95, growth: 0.6 },
  filterGold: 0.35,
};

const RPG_SLOTS = ['cap', 'gloves', 'boots', 'body', 'charm'];
const RPG_EQUIP = ['cap', 'gloves', 'boots', 'body', 'charm1', 'charm2'];
const RPG_RARITIES = ['common', 'magic', 'rare', 'legendary'];
const RPG_RARITY_COL = ['#e9edf2', '#6aa9ff', '#ffd84a', '#ff8a2a'];
const RPG_RARITY_NAME = ['Common', 'Magic', 'Rare', 'Legendary'];
const RPG_SLOT_LABEL = { cap: 'Cap', gloves: 'Gloves', boots: 'Boots', body: 'Coverall', charm: 'Charm', charm1: 'Charm I', charm2: 'Charm II' };
const RPG_BASES = {
  cap: ['Wool Cap', 'Tin Cap', 'Brass Cap', 'Prism Cap', 'Sunforged Cap'], gloves: ['Cloth Gloves', 'Hide Mitts', 'Brass Gauntlets', 'Prism Grips', 'Sunforged Fists'],
  boots: ['Canvas Boots', 'Hide Boots', 'Brass Stompers', 'Prism Treads', 'Sunforged Soles'], body: ['Work Coverall', 'Canvas Coverall', 'Rivet Coverall', 'Prism Coverall', 'Sunforged Coverall'],
  charm: ['Bone Charm', 'Copper Charm', 'Silver Charm', 'Prism Charm', 'Sunforged Charm'],
};
const RPG_BASE_ILVL = [1, 9, 18, 28, 40];
const RPG_IMPLICIT = { cap: ['maxHp', 5, 1.2], gloves: ['allDmg', 0.01, 0.0025], boots: ['runSpd', 0.01, 0.002], body: ['dmgReduce', 0.01, 0.0016], charm: ['magicFind', 0.01, 0.002] }; // [stat, base, per ilvl]

// stat registry: fmt pct = fraction shown as %, flat = integer, per1 = one decimal
const RPG_STATS = {
  jumpH: { label: 'Jump Height', fmt: 'pct' }, runSpd: { label: 'Run Speed', fmt: 'pct' }, wallGrip: { label: 'Wall Grip', fmt: 'pct' },
  punchDmg: { label: 'Punch Damage', fmt: 'pct' }, diveDmg: { label: 'Dive Damage', fmt: 'pct' }, poundDmg: { label: 'Pound Damage', fmt: 'pct' },
  poundRad: { label: 'Pound Radius', fmt: 'pct' }, strikeRad: { label: 'Punch & Dive Reach', fmt: 'pct' }, allDmg: { label: 'All Damage', fmt: 'pct' },
  maxHp: { label: 'Max Health', fmt: 'flat' }, burstSize: { label: 'Cube Burst Size', fmt: 'pct' }, critChance: { label: 'Crit Chance', fmt: 'pct' },
  critPower: { label: 'Crit Power', fmt: 'pct' }, rewindMax: { label: 'Rewind Charges', fmt: 'flat' }, rewindRegen: { label: 'Rewind Recharge', fmt: 'pct' },
  rewindDmg: { label: 'Rewind Pulse Damage', fmt: 'pct' }, magnet: { label: 'Loot Magnet', fmt: 'pct' }, goldFind: { label: 'Gold Find', fmt: 'pct' },
  magicFind: { label: 'Magic Find', fmt: 'pct' }, hpRegen: { label: 'Health Regen / s', fmt: 'pct1' }, dustFind: { label: 'Shard Find', fmt: 'pct' },
  xpGain: { label: 'Experience Gain', fmt: 'pct' }, dmgReduce: { label: 'Damage Reduction', fmt: 'pct' }, lifeOnKill: { label: 'Health On Kill', fmt: 'pct1' },
  eliteDmg: { label: 'Damage vs Elites', fmt: 'pct' },
  skillDmg: { label: 'Skill Damage', fmt: 'pct' }, sparkMax: { label: 'Max Spark', fmt: 'flat' }, sparkRegen: { label: 'Spark Regeneration', fmt: 'pct' }, castSpeed: { label: 'Cooldown Reduction', fmt: 'pct' },
  gemXp: { label: 'Gem Experience', fmt: 'pct' }, starGain: { label: 'Star Power Gain', fmt: 'pct' }, starDur: { label: 'Star Power Duration', fmt: 'sec' }, starTrail: { label: 'Star Trail Damage', fmt: 'pct' }, starfall: { label: 'Starfall Stars / s', fmt: 'flat' },
};
const RPG_STAT_IDS = Object.keys(RPG_STATS);
function rpgFmtStat(id, v, signed = true) {
  const s = RPG_STATS[id] || { fmt: 'flat' }, sg = signed && v > 0 ? '+' : '';
  if (s.fmt === 'pct') return sg + (Math.round(v * 1000) / 10) + '%';
  if (s.fmt === 'pct1') return sg + (Math.round(v * 1000) / 10) + '%';
  if (s.fmt === 'sec') return sg + (Math.round(v * 10) / 10) + 's';
  return sg + Math.round(v * 10) / 10;
}

// ---- affix table: 12 prefixes + 12 suffixes; tier t (0..4) needs item level >= RPG_TIER_ILVL[t]; ranges scale with RPG_TIER_MUL ------------------------
const RPG_TIER_ILVL = [1, 8, 16, 26, 38], RPG_TIER_MUL = [1, 1.6, 2.3, 3.1, 4.1];
function rpgAffix(id, kind, word, stat, slots, lo, hi, tiers) {
  const t = tiers || RPG_TIER_MUL.map(m => [lo * m, hi * m]);
  return { id, kind, word, stat, slots, tiers: t.map((r, i) => ({ minIlvl: RPG_TIER_ILVL[i], lo: r[0], hi: r[1] })) };
}
const RPG_AFFIXES = [
  rpgAffix('jumpH', 'prefix', 'Springy', 'jumpH', ['cap', 'boots', 'charm'], 0.03, 0.05),
  rpgAffix('runSpd', 'prefix', 'Swift', 'runSpd', ['boots', 'body', 'charm'], 0.02, 0.035),
  rpgAffix('wallGrip', 'prefix', 'Clinging', 'wallGrip', ['gloves', 'boots', 'body'], 0.05, 0.09),
  rpgAffix('punchDmg', 'prefix', 'Brawling', 'punchDmg', ['gloves', 'cap', 'charm'], 0.04, 0.07),
  rpgAffix('diveDmg', 'prefix', 'Plunging', 'diveDmg', ['gloves', 'boots', 'charm'], 0.04, 0.07),
  rpgAffix('poundDmg', 'prefix', 'Quaking', 'poundDmg', ['boots', 'body', 'charm'], 0.04, 0.07),
  rpgAffix('poundRad', 'prefix', 'Sprawling', 'poundRad', ['boots', 'gloves', 'body'], 0.03, 0.05),
  rpgAffix('strikeRad', 'prefix', 'Reaching', 'strikeRad', ['gloves', 'cap', 'charm'], 0.03, 0.05),
  rpgAffix('allDmg', 'prefix', 'Fierce', 'allDmg', ['cap', 'gloves', 'boots', 'body', 'charm'], 0.02, 0.04),
  rpgAffix('maxHp', 'prefix', 'Hearty', 'maxHp', ['body', 'cap', 'boots'], 6, 10),
  rpgAffix('burstSize', 'prefix', 'Bursting', 'burstSize', ['gloves', 'charm', 'cap'], 0.06, 0.1),
  rpgAffix('critChance', 'prefix', 'Keen', 'critChance', ['gloves', 'cap', 'charm'], 0.008, 0.014),
  rpgAffix('critPower', 'suffix', 'of Ruin', 'critPower', ['gloves', 'charm', 'cap'], 0.05, 0.09),
  rpgAffix('rewindMax', 'suffix', 'of the Rewinder', 'rewindMax', ['charm', 'cap', 'body'], 0, 0, [[1, 1], [1, 1], [1, 2], [2, 2], [2, 3]]),
  rpgAffix('rewindRegen', 'suffix', 'of Echoes', 'rewindRegen', ['charm', 'boots', 'cap'], 0.08, 0.14),
  rpgAffix('rewindDmg', 'suffix', 'of Reversal', 'rewindDmg', ['cap', 'charm', 'gloves'], 0.06, 0.1),
  rpgAffix('magnet', 'suffix', 'of the Magpie', 'magnet', ['charm', 'cap', 'boots'], 0.08, 0.14),
  rpgAffix('goldFind', 'suffix', 'of Greed', 'goldFind', ['charm', 'gloves', 'boots'], 0.06, 0.1),
  rpgAffix('magicFind', 'suffix', 'of Fortune', 'magicFind', ['charm', 'cap', 'body'], 0.03, 0.05),
  rpgAffix('hpRegen', 'suffix', 'of Renewal', 'hpRegen', ['body', 'boots', 'charm'], 0.0015, 0.0028),
  rpgAffix('dustFind', 'suffix', 'of Dust', 'dustFind', ['charm', 'gloves', 'cap'], 0.08, 0.14),
  rpgAffix('xpGain', 'suffix', 'of Insight', 'xpGain', ['cap', 'charm', 'body'], 0.03, 0.05),
  rpgAffix('dmgReduce', 'suffix', 'of Warding', 'dmgReduce', ['body', 'cap', 'boots'], 0.015, 0.025),
  rpgAffix('lifeOnKill', 'suffix', 'of Thirst', 'lifeOnKill', ['body', 'gloves', 'charm'], 0.002, 0.0035),
  // ---- skill gem / Star Power affixes (appended: the original 24 keep their order) ----
  rpgAffix('skillDmg', 'prefix', 'Arcane', 'skillDmg', ['cap', 'gloves', 'charm', 'body'], 0.04, 0.07),
  rpgAffix('sparkMax', 'prefix', 'Brimming', 'sparkMax', ['cap', 'charm', 'body'], 6, 10),
  rpgAffix('starTrail', 'prefix', 'Blazing', 'starTrail', ['boots', 'body', 'gloves'], 0.08, 0.14),
  rpgAffix('sparkRegen', 'suffix', 'of Flow', 'sparkRegen', ['boots', 'charm', 'cap'], 0.08, 0.14),
  rpgAffix('castSpeed', 'suffix', 'of the Quick Hand', 'castSpeed', ['gloves', 'boots', 'charm'], 0.03, 0.05),
  rpgAffix('gemXp', 'suffix', 'of Tutelage', 'gemXp', ['cap', 'charm', 'body'], 0.1, 0.18),
  rpgAffix('starGain', 'suffix', 'of the Comet', 'starGain', ['boots', 'charm', 'gloves'], 0.06, 0.1),
  rpgAffix('starDur', 'suffix', 'of Eternity', 'starDur', ['cap', 'body', 'charm'], 0.3, 0.5),
  rpgAffix('starfall', 'suffix', 'of Falling Stars', 'starfall', ['cap', 'charm', 'body'], 0.4, 0.7),
];
const RPG_AFFIX_BY_ID = {}; RPG_AFFIXES.forEach(a => RPG_AFFIX_BY_ID[a.id] = a);

// ---- legendary powers: each changes how a verb works (hooks live in the game block) ----------------------------------------------------------------
const RPG_LEGENDARIES = [
  { id: 'quakewave', slot: 'boots', name: 'Quakeheels', text: 'Ground pound sends a shockwave ring racing out to 15 m for 70% damage.' },
  { id: 'rebound', slot: 'boots', name: 'Rebound Soles', text: 'Each consecutive stomp within 3 s adds +30% damage and bounces higher.' },
  { id: 'chaindive', slot: 'gloves', name: 'Arc Mitts', text: 'Dive hits chain lightning between up to 4 nearby enemies for 60% damage.' },
  { id: 'ricochet', slot: 'gloves', name: 'Ricochet Knuckles', text: 'Punches hurl a cube that ricochets between up to 3 enemies for 80% damage.' },
  { id: 'afterimage', slot: 'cap', name: 'Replay Crown', text: 'Rewind Pulse leaves an afterimage that detonates 1.4 s later for 120% damage.' },
  { id: 'starjump', slot: 'cap', name: 'Starcap', text: 'Triple-jump landings detonate a star nova (100% damage, 6 m) and grant a speed surge.' },
  { id: 'thornweave', slot: 'body', name: 'Thornweave Coverall', text: 'Taking a hit releases a thorn nova for 150% damage.' },
  { id: 'phoenix', slot: 'body', name: 'Phoenix Coverall', text: 'A fatal hit instead restores 50% health and bursts into flame (once per 90 s).' },
  { id: 'magnetcore', slot: 'charm', name: 'Magnet Core', text: 'Loot magnet radius x3 and +50% gold from every source.' },
  { id: 'echobell', slot: 'charm', name: 'Echo Bell', text: 'A free Rewind Pulse rings out every 6 s while enemies are near.' },
  { id: 'vampfang', slot: 'charm', name: 'Vampire Fang', text: 'Kills heal 6% max health; crits heal 2%.' },
  { id: 'goldrush', slot: 'charm', name: 'Midas Knot', text: 'Collecting gold grants +3% run speed for 5 s, stacking to 10 times.' },
];
const RPG_LEG_BY_ID = {}; RPG_LEGENDARIES.forEach(l => RPG_LEG_BY_ID[l.id] = l);

// ---- deterministic RNG + item generator -----------------------------------------------------------------------------------------------------------
function rpgRng(seed) { let a = seed | 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function rpgHashSeed(a, b) { let h = (Math.imul((a | 0) ^ 0x9E3779B1, 0x85EBCA6B) ^ Math.imul((b | 0) + 0x7F4A7C15, 0xC2B2AE35)) | 0; h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12; return h >>> 0; }
function rpgTiersFor(a, ilvl) { const out = []; for (let t = 0; t < a.tiers.length; t++) if (ilvl >= a.tiers[t].minIlvl) out.push(t); return out; }
function rpgPickTier(a, ilvl, u) { // eligible tiers, weighted toward the best allowed one (each step down halves the weight)
  const el = rpgTiersFor(a, ilvl); if (!el.length) return -1; const top = el[el.length - 1]; let tot = 0; for (const t of el) tot += Math.pow(0.5, top - t);
  let x = u * tot; for (const t of el) { x -= Math.pow(0.5, top - t); if (x <= 0) return t; } return top;
}
function rpgRollValue(a, tier, u) { const T = a.tiers[tier]; const v = T.lo + u * (T.hi - T.lo); return a.stat === 'maxHp' || a.stat === 'rewindMax' || a.stat === 'sparkMax' ? Math.round(v) : Math.round(v * 100000) / 100000; }
function rpgRollRarity(u, ctx = {}) {
  const T = RPG_TUNING.drop, src = T.src[ctx.source || 'normal'] || T.src.normal, mf = Math.max(0, ctx.mf || 0), min = ctx.minRarity ? RPG_RARITIES.indexOf(ctx.minRarity) : 0;
  const w = T.rarityW.map((b, i) => i < min ? 0 : b * src.w[i] * (1 + mf * T.mfRarity[i])); let tot = 0; for (const x of w) tot += x;
  let x = u * tot; for (let i = 0; i < 4; i++) { x -= w[i]; if (x <= 0 && w[i] > 0) return i; } for (let i = 3; i >= 0; i--) if (w[i] > 0) return i; return 0;
}
function rpgBaseIndex(ilvl) { let b = 0; for (let i = 0; i < RPG_BASE_ILVL.length; i++) if (ilvl >= RPG_BASE_ILVL[i]) b = i; return b; }
function rpgGenItem(seed, ctx = {}) {
  seed = seed >>> 0; const r = rpgRng(seed), ilvl = Math.max(1, Math.min(99, (ctx.ilvl | 0) || 1));
  const uSlot = r(), uRar = r(), uLeg = r(), uCnt = r();                        // fixed draw order: the item is a pure function of (seed, ilvl, ctx)
  let leg = ctx.legendary ? RPG_LEG_BY_ID[ctx.legendary] : null, slot = leg ? leg.slot : (ctx.slot === 'charm1' || ctx.slot === 'charm2' ? 'charm' : ctx.slot) || RPG_SLOTS[(uSlot * RPG_SLOTS.length) | 0];
  let ri = leg ? 3 : ctx.rarity != null ? RPG_RARITIES.indexOf(ctx.rarity) : rpgRollRarity(uRar, ctx); if (ri < 0) ri = 0;
  if (ri === 3 && !leg) { const pool = RPG_LEGENDARIES.filter(l => l.slot === slot); leg = pool[(uLeg * pool.length) | 0]; }
  const rarity = RPG_RARITIES[ri], n = ri === 0 ? 0 : ri === 1 ? (uCnt < 0.5 ? 1 : 2) : ri === 2 ? (uCnt < 0.55 ? 3 : 4) : (uCnt < 0.5 ? 2 : 3), maxK = ri === 1 ? 1 : 2;
  const aff = [], used = new Set(); let np = 0, ns = 0;
  for (let k = 0; k < n; k++) {
    const ua = r(), ut = r(), uv = r();
    const cands = RPG_AFFIXES.filter(a => a.slots.includes(slot) && !used.has(a.id) && (a.kind === 'prefix' ? np < maxK : ns < maxK) && rpgTiersFor(a, ilvl).length);
    if (!cands.length) break; let a = cands[(ua * cands.length) | 0]; if (ctx.w) { let tot = 0; for (const q of cands) tot += ctx.w[q.id] != null ? ctx.w[q.id] : 1; let x = ua * tot; a = cands[cands.length - 1]; for (const q of cands) { x -= ctx.w[q.id] != null ? ctx.w[q.id] : 1; if (x < 0) { a = q; break; } } } /* class-weighted pool: drops lean toward the class, never locked */ const t = rpgPickTier(a, ilvl, ut); used.add(a.id); if (a.kind === 'prefix') np++; else ns++;
    aff.push({ id: a.id, tier: t, value: rpgRollValue(a, t, uv) });
  }
  aff.sort((x, y) => (RPG_AFFIX_BY_ID[x.id].kind === 'prefix' ? 0 : 1) - (RPG_AFFIX_BY_ID[y.id].kind === 'prefix' ? 0 : 1));
  const it = { seed, slot, rarity, ilvl, affixes: aff }; if (leg) it.legendary = leg.id; return it;
}
const RPG_RARE_A = ['Gloom', 'Ember', 'Hollow', 'Rift', 'Prism', 'Static', 'Feral', 'Sunken', 'Gilded', 'Wicked', 'Lunar', 'Frost', 'Storm', 'Rusted', 'Velvet', 'Bright'];
const RPG_RARE_B = { cap: ['Crown', 'Dome', 'Bonnet', 'Visor', 'Halo'], gloves: ['Grips', 'Mitts', 'Fists', 'Claws', 'Knuckles'], boots: ['Treads', 'Stompers', 'Soles', 'Heels', 'Kickers'], body: ['Wrap', 'Rig', 'Plate', 'Shell', 'Harness'], charm: ['Token', 'Sigil', 'Knot', 'Locket', 'Bauble'] };
function rpgItemName(it) {
  const base = RPG_BASES[it.slot][rpgBaseIndex(it.ilvl)];
  if (it.legendary) return RPG_LEG_BY_ID[it.legendary].name;
  if (it.rarity === 'common') return base;
  if (it.rarity === 'magic') { const p = it.affixes.find(a => RPG_AFFIX_BY_ID[a.id].kind === 'prefix'), s = it.affixes.find(a => RPG_AFFIX_BY_ID[a.id].kind === 'suffix'); return [p && RPG_AFFIX_BY_ID[p.id].word, base, s && RPG_AFFIX_BY_ID[s.id].word].filter(Boolean).join(' '); }
  const r = rpgRng(rpgHashSeed(it.seed, 77)); return RPG_RARE_A[(r() * RPG_RARE_A.length) | 0] + ' ' + RPG_RARE_B[it.slot][(r() * 5) | 0];
}
function rpgImplicit(it) { const d = RPG_IMPLICIT[it.slot]; let v = d[1] + d[2] * it.ilvl; if (d[0] === 'maxHp') v = Math.round(v); else v = Math.round(v * 10000) / 10000; return { stat: d[0], value: v }; }
function rpgItemStats(it) { const m = {}; if (!it) return m; const im = rpgImplicit(it); m[im.stat] = (m[im.stat] || 0) + im.value; for (const a of it.affixes) m[RPG_AFFIX_BY_ID[a.id].stat] = (m[RPG_AFFIX_BY_ID[a.id].stat] || 0) + a.value; return m; }
function rpgCompare(nw, old) { const a = rpgItemStats(nw), b = rpgItemStats(old), out = []; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = (a[k] || 0) - (b[k] || 0); if (Math.abs(d) > 1e-9) out.push({ stat: k, delta: d, from: b[k] || 0, to: a[k] || 0 }); } return out; }
function rpgItemScore(it) { // crude power score used for "is this better" arrows and auto-sort
  if (!it) return 0; const m = rpgItemStats(it); let s = 0; for (const k in m) { const w = { maxHp: 0.012, rewindMax: 0.4, hpRegen: 8, lifeOnKill: 8, critChance: 5, critPower: 0.9, wallGrip: 0.25, magnet: 0.35, dustFind: 0.35, goldFind: 0.4, xpGain: 1.1, magicFind: 0.8, sparkMax: 0.012, starDur: 0.2, starfall: 0.3, skillDmg: 1, gemXp: 0.3, starGain: 0.8, starTrail: 0.4, castSpeed: 1.4, sparkRegen: 0.5 }[k]; s += m[k] * (w == null ? 1 : w); } return s + (it.legendary ? 0.25 : 0);
}
function rpgSalvageValue(it, dustFind = 0) { const S = RPG_TUNING.salvage; return Math.max(1, Math.round(S.dust[RPG_RARITIES.indexOf(it.rarity)] * (1 + it.ilvl * S.ilvlScale) * (1 + dustFind))); }
function rpgRerollCost(it) { const R = RPG_TUNING.reroll, k = 1 + R.growth * (it.rr || 0); return { dust: Math.ceil(R.dust[RPG_RARITIES.indexOf(it.rarity)] * k), gold: Math.ceil(R.gold * Math.pow(it.ilvl, R.goldPow) * k) }; }
function rpgRerollAffix(it, index, seed) { // replace one affix with a freshly rolled one of the same kind (never a duplicate); item keeps its seed
  const r = rpgRng(seed >>> 0), old = it.affixes[index]; if (!old) return null; const kind = RPG_AFFIX_BY_ID[old.id].kind, used = new Set(it.affixes.map(a => a.id));
  const cands = RPG_AFFIXES.filter(a => a.kind === kind && a.slots.includes(it.slot) && !used.has(a.id) && rpgTiersFor(a, it.ilvl).length); if (!cands.length) return null;
  const a = cands[(r() * cands.length) | 0], t = rpgPickTier(a, it.ilvl, r()); const out = JSON.parse(JSON.stringify(it)); out.affixes[index] = { id: a.id, tier: t, value: rpgRollValue(a, t, r()) }; out.rr = (it.rr || 0) + 1; return out;
}

// ---- perks (pick 1 of 3 each level): stat perks add into the stat sheet, fx perks switch on mechanics in the game block ------------------------------
function rpgPerk(id, name, glyph, max, mods, fx, desc) { return { id, name, glyph, max, mods: mods || {}, fx: fx || null, desc }; }
const RPG_PERKS = [
  rpgPerk('dive_splash', 'Dive Splash', 'burst', 3, null, 'diveSplash', r => `Dive impacts splash ${(2.4 + 0.8 * r).toFixed(1)} m for ${40 + 15 * r}% damage.`),
  rpgPerk('chain_stomp', 'Chain Stomp', 'chain', 3, null, 'chainStomp', r => `Stomps chain to ${r + 1} nearby enemies for 55% damage.`),
  rpgPerk('coin_rain', 'Coin Rain', 'coin', 3, { goldFind: 0.1 }, 'coinRain', r => `Kills rain ${2 + r * 2} extra coins and add 10% gold find.`),
  rpgPerk('extra_rewind', 'Extra Rewind', 'spiral', 3, { rewindMax: 1 }, null, r => '+1 Rewind charge.'),
  rpgPerk('ricochet_cubes', 'Ricochet Cubes', 'ricochet', 3, null, 'ricochetCubes', r => `Dying enemies burst into cubes that ricochet to ${r} other enem${r === 1 ? 'y' : 'ies'} for 45% damage.`),
  rpgPerk('second_wind', 'Second Wind', 'heart', 3, null, 'secondWind', r => `Below 30% health, heal ${30 + 10 * r}% of max health (every ${Math.max(20, 70 - 15 * r)} s).`),
  rpgPerk('long_legs', 'Long Legs', 'up', 4, { jumpH: 0.08 }, null, r => '+8% jump height.'),
  rpgPerk('quick_feet', 'Quick Feet', 'bolt', 4, { runSpd: 0.05 }, null, r => '+5% run speed.'),
  rpgPerk('wall_cling', 'Wall Cling', 'wall', 3, { wallGrip: 0.25 }, null, r => '+25% wall grip: slower slides, longer wall-kick window.'),
  rpgPerk('heavy_hands', 'Heavy Hands', 'fist', 3, { punchDmg: 0.15, strikeRad: 0.08 }, null, r => '+15% punch damage and +8% reach.'),
  rpgPerk('meteor_drop', 'Meteor Drop', 'meteor', 3, { poundDmg: 0.2, poundRad: 0.12 }, null, r => '+20% pound damage and +12% pound radius.'),
  rpgPerk('lunge', 'Lunge', 'dive', 3, { diveDmg: 0.18 }, null, r => '+18% dive damage.'),
  rpgPerk('vampiric_touch', 'Vampiric Touch', 'drop', 3, { lifeOnKill: 0.012 }, null, r => 'Kills heal +1.2% max health.'),
  rpgPerk('thick_skin', 'Thick Skin', 'shield', 4, { dmgReduce: 0.05 }, null, r => '5% less damage taken.'),
  rpgPerk('lucky_find', 'Lucky Find', 'clover', 3, { magicFind: 0.12 }, null, r => '+12% magic find.'),
  rpgPerk('scavenger', 'Scavenger', 'dust', 3, { dustFind: 0.2, goldFind: 0.08 }, null, r => '+20% shard find, +8% gold find.'),
  rpgPerk('quick_study', 'Quick Study', 'book', 3, { xpGain: 0.08 }, null, r => '+8% experience.'),
  rpgPerk('critical_eye', 'Critical Eye', 'eye', 4, { critChance: 0.04 }, null, r => '+4% crit chance.'),
  rpgPerk('brutal_blows', 'Brutal Blows', 'star', 3, { critPower: 0.2 }, null, r => '+20% crit power.'),
  rpgPerk('big_burst', 'Big Burst', 'burst', 3, { burstSize: 0.25 }, null, r => '+25% cube burst size.'),
  rpgPerk('static_charge', 'Static Charge', 'bolt', 3, null, 'staticCharge', r => `Every ${6 - r}th hit discharges a shock nova (80% damage).`),
  rpgPerk('ghost_step', 'Ghost Step', 'ghost', 2, null, 'ghostStep', r => `+${(0.4 * r).toFixed(1)} s of invulnerability after being hit.`),
  rpgPerk('rewind_echo', 'Rewind Echo', 'spiral', 3, { rewindDmg: 0.35, rewindRegen: 0.2 }, 'rewindPull', r => 'Rewind Pulse: +35% damage, +20% recharge, and it drags enemies inward.'),
  rpgPerk('combo_fiend', 'Combo Fiend', 'chain', 3, null, 'comboFiend', r => `Hits within 2 s stack +${3 * r}% damage each, up to 5 stacks.`),
  rpgPerk('bulwark', 'Bulwark', 'shield', 3, null, 'bulwark', r => `Gain a shield worth ${6 + 4 * r}% max health every ${Math.max(8, 18 - 3 * r)} s.`),
  rpgPerk('spring_heels', 'Spring Heels', 'up', 3, null, 'springHeels', r => `Stomp bounce +${12 * r}% higher and stomp damage +${20 * r}%.`),
  rpgPerk('giant_slayer', 'Giant Slayer', 'crown', 3, { eliteDmg: 0.25 }, null, r => '+25% damage against elites and guardians.'),
  rpgPerk('iron_will', 'Iron Will', 'heart', 3, { maxHp: 25, hpRegen: 0.003 }, null, r => '+25 max health and faster regeneration.'),
  rpgPerk('magnet_hands', 'Magnet Hands', 'magnet', 3, { magnet: 0.4 }, null, r => '+40% loot magnet radius.'),
  rpgPerk('spark_well', 'Spark Well', 'bolt', 3, { sparkMax: 15, sparkRegen: 0.15 }, null, r => '+15 max Spark and 15% faster Spark regeneration.'),
  rpgPerk('skill_mastery', 'Skill Mastery', 'eye', 3, { skillDmg: 0.1 }, null, r => 'Skills deal 10% more damage.'),
  rpgPerk('quick_hands', 'Quick Hands', 'dive', 3, { castSpeed: 0.06 }, null, r => 'Skill cooldowns are 6% shorter.'),
  rpgPerk('gem_scholar', 'Gem Scholar', 'book', 3, { gemXp: 0.3 }, null, r => 'Gems earn 30% more experience.'),
  rpgPerk('star_heart', 'Star Heart', 'star', 3, { starGain: 0.2, starDur: 1 }, null, r => 'Star Power fills 20% faster and lasts 1 s longer.'),
  rpgPerk('comet_trail', 'Comet Trail', 'meteor', 3, { starTrail: 0.35 }, null, r => 'Your Star Power trail hurts 35% more.'),
  rpgPerk('starfall', 'Starfall', 'burst', 3, { starfall: 1 }, null, r => 'Star Power rains 1 mini star per second per rank.'),
];
const RPG_PERK_BY_ID = {}; RPG_PERKS.forEach(p => RPG_PERK_BY_ID[p.id] = p);
function rpgPerkChoices(state, count = 3) { // state: {seed, picks (number taken), perks:{id:rank}}; deterministic for a given history
  const r = rpgRng(rpgHashSeed(state.seed || 1, 1000 + (state.picks || 0) * 31)), pool = RPG_PERKS.filter(p => ((state.perks || {})[p.id] || 0) < p.max), out = [];
  while (out.length < count && pool.length) { const w = pool.map(p => ((state.perks || {})[p.id] ? 0.7 : 1)); let tot = 0; for (const x of w) tot += x; let u = r() * tot, i = 0; for (; i < pool.length - 1; i++) { u -= w[i]; if (u <= 0) break; } out.push(pool.splice(i, 1)[0]); }
  return out;
}

// ---- stats ------------------------------------------------------------------------------------------------------------------------------------------
function rpgXpNext(L) { return Math.round(RPG_TUNING.xp.base * Math.pow(L, RPG_TUNING.xp.pow)); }
function rpgComputeStats(st) { // st: {level, alloc:{power,agility,resolve}, equipped:{slot:item|null}, perks:{id:rank}}
  const T = RPG_TUNING, lv = Math.max(1, st.level | 0 || 1), al = st.alloc || {}, s = { powers: [], fx: {} };
  for (const k of RPG_STAT_IDS) s[k] = 0;
  const add = (k, v) => { if (RPG_STATS[k]) s[k] += v; };
  for (const slot of RPG_EQUIP) { const it = st.equipped && st.equipped[slot]; if (!it) continue; const m = rpgItemStats(it); for (const k in m) add(k, m[k]); if (it.legendary && !s.powers.includes(it.legendary)) s.powers.push(it.legendary); }
  for (const id in (st.perks || {})) { const p = RPG_PERK_BY_ID[id], rk = st.perks[id]; if (!p || !rk) continue; for (const k in p.mods) add(k, p.mods[k] * rk); if (p.fx) s.fx[p.fx] = rk; }
  if (st.cmods) for (const k in st.cmods) add(k, st.cmods[k]);                                  // class base stats (class-core)
  if (st.cfx) for (const k in st.cfx) s.fx[k] = Math.max(s.fx[k] || 0, st.cfx[k]);              // class passive flags
  for (const a in T.attr) { const pts = al[a] || 0; for (const k in T.attr[a]) add(k, T.attr[a][k] * pts); }
  for (const k in T.caps) if (s[k] > T.caps[k]) s[k] = T.caps[k];
  s.level = lv; s.maxHpTotal = Math.round(T.hp.base + T.hp.perLevel * (lv - 1) + s.maxHp);
  s.baseDmg = T.dmg.base * (1 + T.dmg.perLevel * (lv - 1)); s.critTotal = Math.min(0.75, T.crit.base + s.critChance); s.critMul = T.crit.power + s.critPower;
  s.rewindCharges = Math.min(T.caps.rewindMax + T.rewind.base, T.rewind.base + s.rewindMax); s.rewindRate = T.rewind.regen * (1 + s.rewindRegen);
  s.magnetR = T.magnet.base * (1 + s.magnet) * (s.powers.includes('magnetcore') ? 3 : 1); s.regenHp = (T.hp.regen + s.hpRegen) * s.maxHpTotal;
  s.goldMul = (1 + s.goldFind) * (s.powers.includes('magnetcore') ? 1.5 : 1);
  s.dmgMul = 1 + s.allDmg; s.reduce = Math.min(T.caps.dmgReduce, s.dmgReduce);
  return s;
}
function rpgHitDamage(s, kind, extra = 0) { // average (non-crit) damage of a hit of this kind
  const T = RPG_TUNING, per = { punch: s.punchDmg, dive: s.diveDmg, stomp: 0, pound: s.poundDmg, pulse: s.rewindDmg }[kind] || 0; return s.baseDmg * (T.kind[kind] || 1) * s.dmgMul * (1 + per + extra);
}
function rpgSheetNumbers(s) { // the "DPS-ish" block on the character sheet
  const crit = 1 + s.critTotal * (s.critMul - 1), punch = rpgHitDamage(s, 'punch'), dive = rpgHitDamage(s, 'dive'), pound = rpgHitDamage(s, 'pound'), stomp = rpgHitDamage(s, 'stomp'), pulse = rpgHitDamage(s, 'pulse');
  return { punch, dive, pound, stomp, pulse, crit, dpsPunch: punch * crit * 2.6, dpsStomp: stomp * crit * 1.8, dpsPound: pound * crit / 1.1, avgHit: (punch + stomp) / 2 * crit };
}

// ---- scaling: monsters, items, xp ------------------------------------------------------------------------------------------------------------------
function rpgMonsterLevel(c) { // c: {act, diff, idx, rift}
  const T = RPG_TUNING; if (c.rift) return Math.round(T.rift.mlvl + T.rift.mlvlPerTier * c.rift + (c.idx || 0) % 3);
  return (T.actMlvl[c.act] || 1) + T.difficulty[c.diff | 0].mlvl + ((c.idx || 0) % 4);
}
function rpgMonsterStats(type, mlvl, tier, diff) {
  const T = RPG_TUNING, M = T.monster, D = T.difficulty[diff | 0], tr = T.tiers[tier] || T.tiers.normal, m = mlvl - 1;
  const hp = Math.round(M.hp[type] * (1 + M.hpPerLevel * m + M.hpQuad * m * m) * tr.hp * D.hp * 10) / 10;
  const dmg = Math.round(M.dmg[type] * (1 + M.dmgPerLevel * m) * D.dmg * (tier === 'guardian' ? 1.35 : 1));
  return { hp, dmg };
}
function rpgLevelGap(plvl, mlvl) { const d = mlvl - plvl; return d >= 0 ? 1 + Math.min(0.5, 0.05 * d) : Math.max(0.12, 1 + 0.12 * (d + 3)); } // trivial monsters stop paying
function rpgKillXp(type, mlvl, tier, diff, plvl) {
  const X = RPG_TUNING.xp; return Math.max(1, Math.round(X.killBase * (1 + X.killPerLevel * (mlvl - 1)) * (X.type[type] || 1) * (X.tier[tier] || 1) * RPG_TUNING.difficulty[diff | 0].xp * rpgLevelGap(plvl, mlvl)));
}
function rpgObjectiveXp(kind, mlvl, diff, plvl) { const X = RPG_TUNING.xp; return Math.max(1, Math.round(X.killBase * (1 + X.killPerLevel * (mlvl - 1)) * (X.obj[kind] || 1) * RPG_TUNING.difficulty[diff | 0].xp * Math.max(0.5, rpgLevelGap(plvl, mlvl)))); }
function rpgItemLevel(c) { // c: {plvl, act, diff, rift}: item level = player level + act + difficulty/rift tier
  const T = RPG_TUNING, D = T.difficulty[c.diff | 0 || 0]; let il = (c.plvl || 1) + ((c.act || 1) - 1) * T.actIlvl + D.ilvlAdd + (c.rift ? c.rift * T.rift.ilvlPerTier : 0); return Math.max(D.ilvlFloor, Math.min(99, Math.round(il)));
}
function rpgGoldDrop(mlvl, scale, r) { const G = RPG_TUNING.drop.gold; return Math.max(1, Math.round((G.base + G.perLevel * mlvl) * scale * (0.7 + 0.6 * r))); }

// ---- monster affixes ("elite" and "champion" mods) -----------------------------------------------------------------------------------------------------
const RPG_MAFFIX = {
  swift:      { id: 'swift', adj: 'Fast', col: '#46e6ff', spd: 1.8, text: 'Moves much faster.' },
  shielded:   { id: 'shielded', adj: 'Shielded', col: '#9fc6ff', shield: 0.6, text: 'Absorbs the first big chunk of damage.' },
  volatile:   { id: 'volatile', adj: 'Volatile', col: '#ff8a3c', text: 'Explodes when it dies.' },
  vampiric:   { id: 'vampiric', adj: 'Vampiric', col: '#ff4a6a', text: 'Heals when it hurts you.' },
  summoner:   { id: 'summoner', adj: 'Calling', col: '#c28cff', text: 'Summons minions.' },
  frozen:     { id: 'frozen', adj: 'Frozen', col: '#9cf3ff', text: 'Chills everything near it.' },
  juggernaut: { id: 'juggernaut', adj: 'Titan', col: '#ffb15e', hp: 1.7, size: 1.2, text: 'Huge and hard to stagger.' },
  thorned:    { id: 'thorned', adj: 'Thorned', col: '#8cf06a', text: 'Hurts you when you hit it.' },
};
const RPG_MAFFIX_IDS = Object.keys(RPG_MAFFIX);
function rpgPickMonsterAffixes(r, n) { const pool = RPG_MAFFIX_IDS.slice(), out = []; while (out.length < n && pool.length) out.push(pool.splice((r() * pool.length) | 0, 1)[0]); return out; }
function rpgEliteName(type, ids) { return ids.map(i => RPG_MAFFIX[i].adj).join(' ') + ' ' + RPG_TUNING.monster.name[type]; }

// ---- rift modifiers + seeds ------------------------------------------------------------------------------------------------------------------------------
const RPG_RIFT_MODS = {
  lowgrav: { id: 'lowgrav', name: 'Featherfall', text: 'Gravity is 38%. Jump far, fall slowly.' },
  fragile: { id: 'fragile', name: 'Brittle Ground', text: 'Floor tiles crumble underfoot. Rewind (RMB) restores them.' },
  swarm: { id: 'swarm', name: 'Elite Swarm', text: 'Many more elites, more enemies alive at once.' },
  haste: { id: 'haste', name: 'Quickening', text: 'Enemies move 30% faster.' },
};
function rpgRiftMods(seed, tier) { const r = rpgRng(rpgHashSeed(seed, 31)), ids = Object.keys(RPG_RIFT_MODS), n = tier >= 8 ? 3 : tier >= 3 ? 2 : 1, out = []; while (out.length < n && ids.length) out.push(ids.splice((r() * ids.length) | 0, 1)[0]); return out; }
function rpgRiftSpec(tier, seed) {
  const R = RPG_TUNING.rift, t = Math.max(1, Math.min(R.maxTier, tier | 0));
  return { tier: t, seed: seed >>> 0, mods: rpgRiftMods(seed, t), need: Math.round(R.need + R.needPerTier * t), limit: R.limit, alive: Math.round(R.alive + R.alivePerTier * t), mlvl: rpgMonsterLevel({ rift: t }), ilvlBonus: t * R.ilvlPerTier };
}
// </rpg-core>

