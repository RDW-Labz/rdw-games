// <gem-core> ===================================================================================================================
// SHATTERWORLD skill gems + supports. Pure data + deterministic functions (no DOM, no three.js, no game globals); needs the rpg-core names above
// (rpgRng, rpgHashSeed, rpgRollRarity, RPG_RARITIES). Structure (not content) is inspired by the classic socket / link / support-gem model:
// gears carry 0-4 coloured sockets, adjacent sockets can be linked, a skill gem is modified by the support gems in its LINK GROUP, gems level by use.
// Every name, number, table and formula here is original. scratchpad/shatter-passA/gem-unit.mjs extracts this block and tests it under node.
// ==============================================================================================================================
const GEM_TUNING = {
  maxLevel: 20, xpBase: 30, xpPow: 1.4,                       // xp to go from level L to L+1 = round(xpBase * L^xpPow)
  xpPerCast: 3, xpPerHit: 1, xpCastCap: 9, supShare: 0.6,       // a cast earns xpPerCast + xpPerHit per enemy hit (capped); linked supports earn supShare of it
  colorBonus: 1,                                              // a gem in a socket of its own colour counts as +1 level
  spark: { base: 100, regen: 7, perKill: 0.035 },              // the Spark resource: pool, regen per second, fraction of the pool refunded by a kill
  star: { max: 100, shard: 45, kill: { normal: 2.2, champion: 5, elite: 10, guardian: 40 }, combo: 0.45, coin: 0.1, dur: 10, grace: 1.2, speed: 1.28, jump: 1.12, trail: 0.9, touch: 6, kb: 13, coins: 3 },
  bagN: 30, stashN: 20, hotN: 4,
  sock: { slotMax: { cap: 3, gloves: 3, boots: 3, body: 4, charm: 2 }, base: [0, 1, 2, 3], more: 0.38, less: 0.2, ilvlMore: 0.2, ilvlAt: 20, link: [0.3, 0.45, 0.62, 0.85],
    bias: { cap: [0.2, 0.3, 0.5], gloves: [0.55, 0.25, 0.2], boots: [0.2, 0.55, 0.25], body: [0.34, 0.33, 0.33], charm: [0.3, 0.2, 0.5] } },  // colour odds [R, G, B] per slot
  drop: { p: { normal: 0.035, champion: 0.16, elite: 0.38, guardian: 1, crate: 0.04, chest: 0.55, actchest: 1, shard: 0.4, qblock: 0.08 }, supportShare: 0.45, lvPer: 0.2, lvMax: 12, extra: { guardian: 2, actchest: 1, chest: 0 } },
  salvage: { dust: [2, 4, 9, 25], lvScale: 0.3 }, resocket: { dust: 6, gold: 40, growth: 0.5 },
  form: { dur: 25, cinderCd: 0.3, cinderDmg: 0.85, glideFall: 3.2 },
};
const GEM_COLORS = { R: { id: 'R', name: 'Power', css: '#ff6a5a' }, G: { id: 'G', name: 'Agility', css: '#6ef08a' }, B: { id: 'B', name: 'Time', css: '#7ab4ff' } };
const GEM_ELEMS = { sun: { id: 'sun', name: 'Sun', css: '#ffd45a' }, ember: { id: 'ember', name: 'Ember', css: '#ff7a3a' }, gust: { id: 'gust', name: 'Gust', css: '#6ff0e0' }, time: { id: 'time', name: 'Time', css: '#a98aff' }, shatter: { id: 'shatter', name: 'Shatter', css: '#9fbbd8' } };
const GEM_TIER_NAME = ['Common', 'Magic', 'Rare', 'Legendary'];

// ---- skill gems: dmg = damage multiplier of one hit at level 1 (x the hero's base damage), dmgLv = growth per level, p = skill constants, areaLv = area growth per level --------------
function gemSkill(id, name, color, elem, tags, tier, o) { return Object.assign({ kind: 'skill', id, name, color, elem, tags: tags.concat([elem]), tier, areaLv: 0.012, costLv: 0.02, dmgLv: 0.055 }, o); }
const GEM_SKILLS = [
  gemSkill('cubetoss', 'Cube Toss', 'R', 'shatter', ['projectile', 'ranged'], 0, { wind: 0.09, cd: 0.55, cost: 8, dmg: 1.5, p: { speed: 24, range: 26, rad: 1.25 }, text: 'Hurl a spinning cube. It shatters on impact.' }),
  gemSkill('spinslam', 'Spin Slam', 'R', 'shatter', ['melee', 'aoe'], 0, { wind: 0.3, cd: 1.4, cost: 18, dmg: 2.1, p: { rad: 3.9, kb: 9 }, text: 'Spin up, then slam. Hits everything around you.' }),
  gemSkill('shockclap', 'Shock Clap', 'R', 'sun', ['aoe', 'cone'], 0, { wind: 0.16, cd: 1.0, cost: 14, dmg: 1.7, p: { range: 9.5, arc: 1.3, kb: 11 }, text: 'A thunderous clap sends a golden shockwave in a cone.' }),
  gemSkill('gustdash', 'Gust Dash', 'G', 'gust', ['movement'], 1, { wind: 0.03, cd: 1.6, cost: 16, dmg: 1.35, p: { dist: 8, time: 0.2, width: 1.7, iframes: 0.28 }, text: 'Dash through the air in a cutting gust. Hurts what it passes.' }),
  gemSkill('shardboomerang', 'Shard Boomerang', 'G', 'sun', ['projectile', 'ranged', 'return'], 1, { wind: 0.1, cd: 1.2, cost: 12, dmg: 1.25, p: { range: 13, speed: 20, rad: 1.1, back: 26, magnet: 2.8 }, text: 'A sun shard that returns to you, scooping up loot on the way.' }),
  gemSkill('cinderbloom', 'Cinder Bloom', 'R', 'ember', ['projectile', 'aoe'], 1, { wind: 0.14, cd: 1.9, cost: 22, dmg: 1.15, p: { orbs: 3, speed: 11, bounces: 3, rad: 2.2, life: 3.4 }, text: 'Three fire orbs bounce along the ground and bloom into flame.' }),
  gemSkill('whirlgale', 'Whirl Gale', 'G', 'gust', ['aoe', 'zone'], 1, { wind: 0.18, cd: 4.2, cost: 24, dmg: 0.65, p: { dist: 6.5, rad: 3, life: 2.8, speed: 3.2, pull: 7, tick: 0.4 }, text: 'Raise a tornado that drags enemies in and shreds them.' }),
  gemSkill('rewinddash', 'Rewind Dash', 'B', 'time', ['movement'], 2, { wind: 0.05, cd: 3.2, cost: 20, dmg: 1.6, p: { back: 1.1, width: 1.7, iframes: 0.25 }, text: 'Blink back along the path you just ran, damaging everything in between.' }),
  gemSkill('sunbeam', 'Sunbeam', 'B', 'sun', ['beam', 'ranged'], 2, { wind: 0.38, cd: 2.3, cost: 26, dmg: 2.7, p: { range: 19, width: 1.1 }, text: 'Gather light, then loose a piercing golden beam.' }),
  gemSkill('stasis', 'Stasis Bubble', 'B', 'time', ['aoe', 'zone'], 2, { wind: 0.14, cd: 5.0, cost: 22, dmg: 0.35, p: { dist: 7.5, rad: 4, life: 3.6, slow: 0.65, tick: 0.5 }, text: 'A violet bubble slows everything inside and chips away at it.' }),
  gemSkill('meteorfall', 'Meteor Fall', 'R', 'ember', ['aoe'], 2, { wind: 0.2, cd: 4.6, cost: 30, dmg: 2.4, p: { count: 3, rad: 2.9, delay: 0.85, spread: 4.8, dist: 8 }, text: 'Three meteors crash down around the target after a short warning.' }),
];
// ---- support gems: req = the skill needs at least one of these tags; apply(R, L) edits the resolved skill R for gem level L ------------------------------------------------------
function gemSupport(id, name, color, tier, req, text, apply, o) { return Object.assign({ kind: 'support', id, name, color, tier, req, text, apply }, o); }
const GEM_SUPPORTS = [
  gemSupport('chain', 'Chain', 'G', 1, ['projectile', 'beam'], 'Hits chain on to nearby enemies. Less damage.', (R, L) => { R.chain += 1 + Math.floor((L - 1) / 7); R.more *= 0.8; R.costMul *= 1.25; }, { elem: null }),
  gemSupport('fork', 'Fork', 'G', 1, ['projectile'], 'Projectiles split in two on the first hit. Less damage.', (R, L) => { R.fork += L >= 13 ? 3 : 2; R.more *= 0.8; R.costMul *= 1.2; }),
  gemSupport('pierce', 'Pierce', 'G', 0, ['projectile', 'beam', 'return'], 'Projectiles pass through enemies.', (R, L) => { R.pierce += 2 + Math.floor((L - 1) / 5); R.costMul *= 1.15; }),
  gemSupport('area', 'Area', 'R', 0, ['aoe', 'zone', 'cone'], 'Bigger area of effect.', (R, L) => { R.area *= 1.2 + 0.01 * (L - 1); R.costMul *= 1.2; }),
  gemSupport('echo', 'Echo', 'B', 2, ['melee', 'aoe', 'projectile', 'beam', 'cone', 'zone'], 'The skill repeats itself a moment later. Repeats are weaker.', (R, L) => { R.echo += L >= 15 ? 2 : 1; R.echoMore *= 0.8; R.costMul *= 1.35; }),
  gemSupport('haste', 'Haste', 'B', 0, ['any'], 'Faster wind-up and shorter cooldown.', (R, L) => { R.haste += 0.14 + 0.006 * (L - 1); R.costMul *= 1.1; }),
  gemSupport('lifesteal', 'Lifesteal', 'R', 1, ['any'], 'Each hit restores a little health.', (R, L) => { R.leech += 0.003 + 0.00015 * (L - 1); R.costMul *= 1.1; }),
  gemSupport('multicast', 'Multicast', 'G', 2, ['projectile', 'aoe', 'melee', 'cone', 'beam'], 'Fires two extra copies. Each is weaker.', (R, L) => { R.multi += 2; R.multiMore *= 0.65 + 0.005 * (L - 1); R.costMul *= 1.5; }),
  gemSupport('added_ember', 'Added Ember', 'R', 1, ['any'], 'Adds Ember damage and sets enemies burning.', (R, L) => { R.more *= 1.22 + 0.012 * (L - 1); R.burn += 0.3 + 0.01 * (L - 1); R.costMul *= 1.25; R.addElem('ember'); }, { elem: 'ember' }),
  gemSupport('added_gust', 'Added Gust', 'G', 1, ['any'], 'Adds Gust damage and a pulling, knocking wind.', (R, L) => { R.more *= 1.18 + 0.011 * (L - 1); R.pull += 5; R.kbMul *= 1.4; R.costMul *= 1.2; R.addElem('gust'); }, { elem: 'gust' }),
  gemSupport('added_sun', 'Added Sun', 'B', 1, ['any'], 'Adds Sun damage and a better crit chance.', (R, L) => { R.more *= 1.2 + 0.011 * (L - 1); R.critAdd += 0.08 + 0.002 * (L - 1); R.costMul *= 1.25; R.addElem('sun'); }, { elem: 'sun' }),
  gemSupport('added_time', 'Added Time', 'B', 2, ['any'], 'Adds Time damage and slows what it hits.', (R, L) => { R.more *= 1.15 + 0.01 * (L - 1); R.slow += 0.3 + 0.006 * (L - 1); R.costMul *= 1.2; R.addElem('time'); }, { elem: 'time' }),
  gemSupport('thrifty', 'Thrifty', 'R', 0, ['any'], 'Costs much less Spark. Slightly less damage.', (R, L) => { R.costMul *= 0.7 - 0.004 * (L - 1); R.more *= 0.9 + 0.003 * (L - 1); }),
];
const GEM_DEFS = GEM_SKILLS.concat(GEM_SUPPORTS);
const GEM_BY_ID = {}; GEM_DEFS.forEach(d => { GEM_BY_ID[d.id] = d; });
const gemIsSkill = id => !!GEM_BY_ID[id] && GEM_BY_ID[id].kind === 'skill';
const gemIsSupport = id => !!GEM_BY_ID[id] && GEM_BY_ID[id].kind === 'support';

// ---- levels ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
function gemXpNext(L) { return L >= GEM_TUNING.maxLevel ? 0 : Math.round(GEM_TUNING.xpBase * Math.pow(L, GEM_TUNING.xpPow)); }
function gemAddXp(g, amount) { // returns the number of levels gained
  if (!g || g.lv >= GEM_TUNING.maxLevel || !(amount > 0)) return 0; let up = 0; g.xp = (g.xp || 0) + amount;
  while (g.lv < GEM_TUNING.maxLevel && g.xp >= gemXpNext(g.lv)) { g.xp -= gemXpNext(g.lv); g.lv++; up++; }
  if (g.lv >= GEM_TUNING.maxLevel) g.xp = 0; return up;
}
function gemCastXp(hits) { return Math.min(GEM_TUNING.xpCastCap, GEM_TUNING.xpPerCast + GEM_TUNING.xpPerHit * Math.max(0, hits | 0)); }
function gemRow(def, L) { // the scaling data table of one gem at level L (what the UI lists); a skill row = per-hit numbers, a support row = its effect numbers
  const o = { lv: L, xpNext: gemXpNext(L) };
  if (def.kind === 'skill') { o.dmg = def.dmg * (1 + def.dmgLv * (L - 1)); o.cost = def.cost * (1 + def.costLv * (L - 1)); o.cd = def.cd; o.area = 1 + def.areaLv * (L - 1); return o; }
  const T = gemBaseR({ id: 'cubetoss', lv: 1 }, {}); def.apply(T, L); o.more = T.more; o.costMul = T.costMul; o.chain = T.chain; o.fork = T.fork; o.pierce = T.pierce; o.area = T.area; o.echo = T.echo; o.haste = T.haste; o.leech = T.leech; o.multi = T.multi; o.multiMore = T.multiMore; o.burn = T.burn; o.slow = T.slow; o.pull = T.pull; o.critAdd = T.critAdd; return o;
}
function gemTable(id) { const d = GEM_BY_ID[id], out = []; for (let L = 1; L <= GEM_TUNING.maxLevel; L++) out.push(gemRow(d, L)); return out; }

// ---- resolving a skill with its supports ---------------------------------------------------------------------------------------------------------------------------------
// sk = {id, lv}, sups = [{id, lv, col?}], ctx = { aff: {elem, lv, dmg}|null, skillCol: socket colour of the skill gem, supCols: [socket colours] }
function gemSupportOk(sup, skill) { const d = GEM_BY_ID[sup.id], s = GEM_BY_ID[skill.id]; if (!d || !s || d.kind !== 'support' || s.kind !== 'skill') return false; return d.req.includes('any') || d.req.some(t => s.tags.includes(t)); }
function gemEffLevel(g, socketCol, aff) { const d = GEM_BY_ID[g.id]; let L = g.lv | 0 || 1; if (socketCol && socketCol === d.color) L += GEM_TUNING.colorBonus; if (aff && gemHasElem(d, aff.elem)) L += aff.lv | 0; return Math.max(1, Math.min(GEM_TUNING.maxLevel + 4, L)); }
function gemHasElem(d, elem) { return !!elem && (d.elem === elem || (!!d.tags && d.tags.includes(elem))); }
function gemBaseR(sk, ctx) {
  const d = GEM_BY_ID[sk.id], aff = ctx.aff || null, L = gemEffLevel(sk, ctx.skillCol, aff);
  return { id: d.id, name: d.name, elem: d.elem, color: d.color, tags: d.tags.slice(), lvl: L, rawLvl: sk.lv | 0 || 1, dmgMult: d.dmg * (1 + d.dmgLv * (L - 1)), more: 1, cost0: d.cost * (1 + d.costLv * (L - 1)), costMul: 1, cd0: d.cd, wind0: d.wind, area: 1 + d.areaLv * (L - 1),
    p: Object.assign({}, d.p), pierce: 0, chain: 0, fork: 0, echo: 0, echoMore: 1, multi: 0, multiMore: 1, haste: 0, leech: 0, burn: 0, slow: 0, pull: 0, kbMul: 1, critAdd: 0, affDmg: 0, sups: [], elems: [d.elem],
    addElem(e) { if (!this.tags.includes(e)) this.tags.push(e); if (!this.elems.includes(e)) this.elems.push(e); } };
}
function gemResolve(sk, sups, ctx = {}) {
  const aff = ctx.aff || null, R = gemBaseR(sk, ctx);
  (sups || []).forEach((s, i) => { const sd = GEM_BY_ID[s.id]; if (!sd) return; const ok = gemSupportOk(s, sk), SL = gemEffLevel(s, ctx.supCols && ctx.supCols[i], aff); R.sups.push({ id: s.id, name: sd.name, lvl: SL, ok }); if (ok) sd.apply(R, SL); });
  if (aff && R.tags.includes(aff.elem)) R.affDmg = aff.dmg || 0;
  R.cost = Math.max(1, Math.round(R.cost0 * R.costMul * 10) / 10); R.windFactor = Math.max(0.35, 1 - 0.8 * R.haste);
  return R;
}
function gemFinal(R, S) { // adds the hero's stats: cooldown reduction (gear), damage numbers. S = the rpg stat sheet (baseDmg, dmgMul, skillDmg, castSpeed, critTotal, critMul)
  const cs = Math.min(0.5, (S.castSpeed || 0));
  R.cd = Math.max(0.12, R.cd0 * (1 - Math.min(0.6, R.haste)) * (1 - cs)); R.wind = R.wind0 * R.windFactor; R.hit = S.baseDmg * R.dmgMult * R.more * S.dmgMul * (1 + (S.skillDmg || 0) + R.affDmg);
  R.crit = Math.min(0.85, (S.critTotal || 0) + R.critAdd); R.dps = R.hit * (1 + R.crit * ((S.critMul || 1.5) - 1)) / Math.max(R.cd, R.wind + 0.05); return R;
}
function gemHitDamage(R, S) { return S.baseDmg * R.dmgMult * R.more * S.dmgMul * (1 + (S.skillDmg || 0) + R.affDmg); }
function gemCompareSupport(sk, curSups, cand, S, ctx = {}) { // damage / cost / cooldown / dps before and after adding (or swapping in) one support gem
  const a = gemFinal(gemResolve(sk, curSups, ctx), S), next = curSups.concat([cand]), b = gemFinal(gemResolve(sk, next, ctx), S), ok = gemSupportOk(cand, sk);
  return { ok, hit: [a.hit, b.hit], cost: [a.cost, b.cost], cd: [a.cd, b.cd], dps: [a.dps, b.dps], proj: [a.multi + 1, b.multi + 1], pierce: [a.pierce, b.pierce], chain: [a.chain, b.chain] };
}

// ---- sockets: derived from the item (pure function of seed / slot / rarity / ilvl / resocket count), or an explicit layout it.lay = {c:'RGB', l:'10'} ----------------------------------------------------
function gemSockets(it) {
  if (!it) return { n: 0, colors: [], links: [], groups: [] };
  let colors, links;
  if (it.lay && typeof it.lay.c === 'string') { colors = it.lay.c.split('').filter(c => GEM_COLORS[c]); links = (it.lay.l || '').split('').slice(0, Math.max(0, colors.length - 1)).map(c => c === '1'); }
  else {
    const T = GEM_TUNING.sock, r = rpgRng(rpgHashSeed(it.seed >>> 0, 0x50C + (it.sr | 0) * 977)), ri = Math.max(0, RPG_RARITIES.indexOf(it.rarity)), max = T.slotMax[it.slot] || 0, u1 = r(), u2 = r(), u3 = r();
    let n = T.base[ri] + (u1 < T.more ? 1 : 0) - (u2 < T.less && T.base[ri] > 0 ? 1 : 0) + ((it.ilvl | 0) >= T.ilvlAt && u3 < T.ilvlMore ? 1 : 0); n = Math.max(ri === 3 ? Math.min(3, max) : 0, Math.min(max, n));
    const b = T.bias[it.slot] || T.bias.body; colors = []; links = []; for (let i = 0; i < n; i++) { const u = r(); colors.push(u < b[0] ? 'R' : u < b[0] + b[1] ? 'G' : 'B'); }
    for (let i = 0; i < n - 1; i++) links.push(r() < T.link[ri]);
  }
  while (links.length < colors.length - 1) links.push(false); links.length = Math.max(0, colors.length - 1);
  const groups = []; let cur = []; for (let i = 0; i < colors.length; i++) { cur.push(i); if (i === colors.length - 1 || !links[i]) { groups.push(cur); cur = []; } }
  return { n: colors.length, colors, links, groups };
}
function gemSocketSummary(it) { const s = gemSockets(it); let t = ''; for (let i = 0; i < s.n; i++) { t += s.colors[i]; if (i < s.n - 1) t += s.links[i] ? '-' : ' '; } return t; }
// collect every active skill of a set of equipped items: [{gem, slot, idx, group, sups:[{gem, slot, idx}], skillCol, supCols}]
function gemCollect(equipped, keys) {
  const out = [];
  for (const k of keys) {
    const it = equipped && equipped[k]; if (!it || !it.gems) continue; const L = gemSockets(it);
    for (const grp of L.groups) {
      const skills = [], sups = []; for (const i of grp) { const g = it.gems[i]; if (!g || !GEM_BY_ID[g.id]) continue; (gemIsSkill(g.id) ? skills : sups).push({ gem: g, slot: k, idx: i, col: L.colors[i] }); }
      for (const s of skills) out.push({ gem: s.gem, slot: k, idx: s.idx, group: grp, sups: sups.map(q => q), skillCol: s.col, supCols: sups.map(q => q.col) });
    }
  }
  return out;
}
function gemPlaceTarget(it, gem) { // best empty socket of one item for a gem -> {i, s} (i = -1: none). Prefers the gem's colour; a support prefers a group that already holds a compatible skill
  const L = gemSockets(it), g = it.gems || []; let best = -1, bs = -1;
  for (let i = 0; i < L.n; i++) {
    if (g[i]) continue; let s = 1; if (L.colors[i] === GEM_BY_ID[gem.id].color) s += 2; const grp = L.groups.find(q => q.includes(i));
    if (gemIsSupport(gem.id)) { let ok = false; for (const j of grp) { const o = g[j]; if (o && gemIsSkill(o.id) && gemSupportOk(gem, o)) ok = true; } s += ok ? 4 : 0; } else s += grp.length > 1 ? 1 : 0;
    if (s > bs) { bs = s; best = i; }
  }
  return { i: best, s: bs };
}

// ---- generation, cleaning, values ---------------------------------------------------------------------------------------------------------------------------------------------
function gemUid(seed) { return (rpgHashSeed(seed >>> 0, 0x6E3) & 0x7fffffff) || 1; }
function gemGen(seed, ctx = {}) {
  seed = seed >>> 0; const r = rpgRng(seed), uKind = r(), uRar = r(), uPick = r(), uLv = r(), D = GEM_TUNING.drop, ilvl = Math.max(1, ctx.ilvl | 0 || 1);
  const kind = ctx.kind || (uKind < D.supportShare ? 'support' : 'skill'); let id = ctx.id;
  if (!id) { const t = Math.min(2, rpgRollRarity(uRar, { source: ctx.source || 'normal', mf: ctx.mf || 0 })); const pool = GEM_DEFS.filter(d => d.kind === kind); let c = pool.filter(d => d.tier === t); if (!c.length) c = pool.filter(d => d.tier <= t); id = c[(uPick * c.length) | 0].id; }
  const lv = ctx.level ? Math.max(1, Math.min(GEM_TUNING.maxLevel, ctx.level | 0)) : Math.max(1, Math.min(D.lvMax, 1 + Math.floor((ilvl - 1) / 5 + uLv * 2)));
  return { id, lv, xp: 0, u: gemUid(seed) };
}
function gemClean(g) { if (!g || typeof g !== 'object' || !GEM_BY_ID[g.id]) return null; const o = { id: g.id, lv: Math.max(1, Math.min(GEM_TUNING.maxLevel, g.lv | 0 || 1)), xp: Math.max(0, +g.xp || 0), u: (g.u | 0) || 1 }; if (g.lk) o.lk = 1; return o; }
function gemSalvageValue(g) { const d = GEM_BY_ID[g.id], S = GEM_TUNING.salvage; return Math.max(1, Math.round(S.dust[d.tier] * (1 + S.lvScale * (g.lv - 1)))); }
function gemResocketCost(it) { const R = GEM_TUNING.resocket, k = 1 + R.growth * (it.sr | 0); return { dust: Math.ceil(R.dust * k), gold: Math.ceil(R.gold * Math.pow(Math.max(1, it.ilvl | 0), 0.8) * k) }; }
function gemSortKey(g) { const d = GEM_BY_ID[g.id]; return (d.kind === 'skill' ? 0 : 1) * 1e6 + d.tier * -1e4 + g.lv * -10 + (d.id.charCodeAt(0) % 10) * 0.1; }
function gemSparkMax(S) { return GEM_TUNING.spark.base + (S.sparkMax || 0); }
function gemSparkRegen(S) { return GEM_TUNING.spark.regen * (1 + (S.sparkRegen || 0)); }
function gemStarGain(kind, S) { return (GEM_TUNING.star.kill[kind] || 0) * (1 + (S.starGain || 0)); }
function gemStarDur(S, base) { return (base || GEM_TUNING.star.dur) + (S.starDur || 0); }
// </gem-core>

