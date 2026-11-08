// BORROWED (same repo) from games/_design/bank/proto/lootroll.mjs, sha256 ac62d63b1a7a65d4, verbatim below this header: the pure port of the drop glue validated by
// games/_design/bank/exp/lootroll-check.mjs (1 M kills per source within 0.84 % of the analytic tables) and hashed identically on node and workerd.
// Part of the rules library (tools/shatter-build/build-rules.mjs -> dist/rules.mjs). Same distribution as the game's rpgDrops, different seed schedule (one seed per kill):
// offline play keeps its drand() stream; see games/DESIGN-server-bank.md 4.2.
// The PURE reward rules of one kill, ported line by line from the game glue so the host (to show the drop at once) and the bank (to mint it) run the same code on the same loot tape.
//   rpgDrops              games/shatterworld-next.html L5598-5603   (gold, shards, items)        rpgDropItem   L5592-5597 (common filter -> gold)
//   gemDropAt             L6944-6948 (gems)                                                      foodRollDrops  food-core L4944 (materials), called by the food-game wrapper L8372
//   rpgOnKilled XP        L5784 (xp = rpgKillXp * xpMul * rift xp)   rpgGainXp L5931-5935 / rpgLevelUp L5936-5937
//   rpgStatState          L5390 + gem-game wrapper L7468 (class weights, class mods) + food-game wrapper L8284 (town + food mods through cmods)
// Everything here takes the loaded rules object R (the pure cores) and a seed; there is no clock, no Math.random and no global.
export const u32 = (x) => x >>> 0;
// loot tape: the k-th kill of source class c in a hosted session has the seed hash(a, b, c, k). (a, b) = 64 bits derived by the bank with HMAC-SHA256 from a bank-only key; the host receives them, a guest never does.
export const TAPE_CLASSES = ['normal', 'champion', 'elite', 'guardian', 'crate', 'chest', 'actchest', 'shard', 'qblock'];
export function tapeSeed(R, a, b, cls, k) { const ci = TAPE_CLASSES.indexOf(cls); return R.rpgHashSeed(u32(a) ^ Math.imul(k + 1, 0x9E3779B1) ^ (ci << 24), u32(b) + Math.imul(k, 0x85EBCA6B) + ci); }

// The identity of the k-th kill of source class `src` in a rift lease is DERIVED, never claimed: monster type from the rift's real spawn mix (mobRiftType L9304: 55 % a mob of the rift's families, else the legacy mix),
// monster level base + (k mod 3) (rpgRiftSpawn: RIFT.mlvl + spawned % 3), guardian = the act boss at base + 3. T = { a, b, rseed, tier }. The host calls the same function to show the drop; the bank calls it to mint.
export function tapeSpec(R, T, src, k) {
  const seed = tapeSeed(R, T.a, T.b, src, k), r0 = R.rpgRng((seed ^ 0x7E57A1) >>> 0), base = R.rpgMonsterLevel({ rift: T.tier });
  if (src === 'guardian') return { src, type: R.MOB_BOSS_BY_ACT[1 + (T.rseed % 3)] || 'g_thorn', tier: 'guardian', lvl: base + 3, xm: 1, seed };
  const fams = R.mobRiftFamilies(T.rseed, T.tier), u0 = r0(), u1 = r0(); let type;
  if (u0 <= 0.55) { const pool = []; for (const f of fams) for (const t of R.MOB_FAMILIES[f].mobs) pool.push(t); type = pool[(u1 * pool.length) | 0]; }
  else type = u1 < 0.32 ? 'walker' : u1 < 0.44 ? 'shell' : u1 < 0.6 ? 'hopper' : u1 < 0.76 ? 'spitter' : 'brute';
  return { src, type, tier: src, lvl: base + (k % 3), xm: 1, seed };
}

export function statStateFor(R, cls, ch, equipped, extraMods) {            // ch: {level, st:{spent, perks}}
  const L = ch.level, d = R.classDef(cls), a = R.RPG_TUNING.autoPerLevel * (L - 1), sp = (ch.st && ch.st.spent) || {};
  const cmods = Object.assign({}, d.mods); if (extraMods) for (const k in extraMods) cmods[k] = (cmods[k] || 0) + extraMods[k];
  return { level: L, alloc: { power: a * d.weights.power + (sp.power | 0), agility: a * d.weights.agility + (sp.agility | 0), resolve: a * d.weights.resolve + (sp.resolve | 0) }, equipped, perks: (ch.st && ch.st.perks) || {}, cmods, cfx: d.fx };
}
export const statSheetFor = (R, cls, ch, equipped, extraMods) => R.rpgComputeStats(statStateFor(R, cls, ch, equipped, extraMods));

// ctx = { plvl, act, diff, rift (tier or 0), S (stat sheet: goldMul, dustFind, magicFind), w (class affix weights), filter (hide commons -> gold), riftGoldMul }
// spec = { src ('normal'|'champion'|'elite'|'guardian'|'chest'|...), type (mob type for materials, XP), tier (monster tier), lvl (monster level), seed }
export function rollKill(R, spec, ctx) {
  const T = R.RPG_TUNING, D = T.drop, s = D.src[spec.src]; if (!s) throw new Error('unknown source ' + spec.src);
  const r = R.rpgRng(spec.seed), out = { gold: 0, dust: 0, items: [], gems: [], mats: [] }, S = ctx.S, mlvl = spec.lvl;
  if (r() < s.gold[0]) out.gold += Math.max(1, Math.round(R.rpgGoldDrop(mlvl, s.gold[1], r()) * S.goldMul * (ctx.rift ? T.rift.goldMul : 1)));
  if (r() < s.dust) out.dust += Math.max(1, Math.round((D.dust.base + D.dust.perLevel * mlvl) * (1 + S.dustFind) * (spec.src === 'guardian' ? 4 : spec.src === 'elite' || spec.src === 'chest' || spec.src === 'actchest' ? 2 : 1)));
  const ilvl = R.rpgItemLevel({ plvl: ctx.plvl, act: ctx.rift ? 3 : ctx.act, diff: ctx.rift ? 0 : ctx.diff, rift: ctx.rift || 0 });
  if (r() < s.p) {
    let n = s.n[0]; if (s.n[1] > n) for (let i = n; i < s.n[1]; i++) if (r() < 0.5) n++;
    for (let i = 0; i < n; i++) {
      const it = R.rpgGenItem(u32(r() * 4294967296), { ilvl, mf: S.magicFind, source: spec.src, w: ctx.w });
      if (ctx.filter && it.rarity === 'common') out.gold += Math.max(1, Math.round(R.rpgGoldDrop(mlvl, T.filterGold, 0.5) * S.goldMul)); else out.items.push(it);
    }
  }
  const G = R.GEM_TUNING.drop, gp = (G.p[spec.src] || 0) * (1 + (S.magicFind || 0) * 0.5);
  if (r() < gp) { const n = 1 + (G.extra[spec.src] || 0); for (let i = 0; i < n; i++) out.gems.push(R.gemGen(u32(r() * 4294967296), { ilvl, source: spec.src, mf: S.magicFind })); }
  for (const d of R.foodRollDrops(r, spec.src, spec.type || null, spec.tier || 'normal', S.magicFind)) out.mats.push(d);
  return out;
}
export function killXp(R, spec, ctx) { return Math.round(R.rpgKillXp(spec.type, spec.lvl, spec.tier, ctx.rift ? 0 : ctx.diff, ctx.plvl) * (spec.xm || 1) * (ctx.rift ? R.RPG_TUNING.rift.xpMul : 1)); }
// rpgGainXp + rpgLevelUp on a plain character record {level, xp, st:{free, pending}}; returns the number of level-ups
export function gainXp(R, ch, amount, S) {
  const cap = R.RPG_TUNING.levelCap; if (ch.level >= cap) return 0; amount = Math.max(1, Math.round(amount * (1 + S.xpGain))); ch.xp += amount; let ups = 0;
  while (ch.level < cap && ch.xp >= R.rpgXpNext(ch.level)) { ch.xp -= R.rpgXpNext(ch.level); ch.level++; ch.st.free = (ch.st.free | 0) + R.RPG_TUNING.pointsPerLevel; ch.st.pending = (ch.st.pending | 0) + 1; ups++; }
  if (ch.level >= cap) ch.xp = 0; return ups;
}

// determinism probe: N rolls over every source class and tier, hashed (FNV-1a over the JSON of the results, the xp curve and the item price). Node and workerd must return the same number (exp/measure-do.mjs).
export function rollHash(R, n) {
  let h = 2166136261 >>> 0; const S = { goldMul: 1.1, dustFind: 0.05, magicFind: 0.3, xpGain: 0 }, srcs = ['normal', 'champion', 'elite', 'guardian', 'chest'];
  const mix = (str) => { for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } };
  for (let k = 0; k < n; k++) {
    const src = srcs[k % srcs.length], tier = 1 + (k % 40), spec = src === 'chest' ? { src, type: null, tier: 'normal', lvl: 8 + Math.round(2.5 * tier), seed: tapeSeed(R, 0x1234abcd, 0x0badf00d, src, k) } : tapeSpec(R, { a: 0x1234abcd, b: 0x0badf00d, rseed: (k * 7919 + 1) >>> 0, tier }, src, k), o = rollKill(R, spec, { plvl: 10 + (k % 30), act: 3, diff: 0, rift: tier, S, w: null, filter: false });
    mix(spec.type + ':' + spec.lvl);
    mix(JSON.stringify(o)); mix(String(R.rpgXpNext(1 + (k % 39)))); mix(String(R.itemPrice(o.items[0] || { rarity: 'common', ilvl: 1, affixes: [] }))); mix(String(R.rpgKillXp('brute', 8 + (k % 60), 'elite', 0, 1 + (k % 30))));
  }
  return h >>> 0;
}
