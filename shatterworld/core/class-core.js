// <class-core> =================================================================================================================
// SHATTERWORLD character classes (pure data + helpers). A class is ONE data entry in CLASSES (+ one model builder entry in the game block's CLASS_MODELS):
// base stats, per-level attribute weights, a passive that changes a core verb (flags in fx are read by the game block), gem affinity, a class-weighted affix pool,
// a starter kit (gear with explicit socket layouts + socketed gems), a Star Power variant, and a reserved passive-tree start node (classId + tree.start).
// Adding a class never needs engine edits: classRegister(def) + CLASS_MODELS[id] = builder.   (gem-unit.mjs registers a 7th class to prove it.)
// ==============================================================================================================================
const CLASS_ORDER = ['pip', 'lou', 'gruntmaw', 'zip', 'petal', 'ember'];
const CLASSES = {
  pip: { id: 'pip', name: 'Pip', role: 'ALL-ROUNDER', blurb: 'The plumber. Does a bit of everything, well.', unlock: { type: 'start', text: 'Unlocked' }, model: 'pip',
    base: { weight: 1.0 }, mods: {}, fx: { stompSpark: 1 }, weights: { power: 1, agility: 1, resolve: 1 },
    passive: { name: 'Plumber\'s Rhythm', text: 'Stomps restore Spark. A landed triple jump quakes the ground around you.' },
    aff: { elem: 'shatter', lv: 1, dmg: 0.1 }, affW: {},
    sig: 'spinslam', tree: { start: 'pip_root', slot: 0 }, sfx: { pitch: 1.0 },
    star: { id: 'rush', name: 'Star Rush', dur: 10, col: 'rainbow', fx: { trailR: 2.4 }, text: 'Invulnerable, rainbow trail, the ground shatters under you and rebuilds behind. Enemies bounce away in coin bursts.' },
    start: { core: { lay: 'RRBG', l: '101', gems: ['spinslam', 'area', 'cubetoss', null] }, hot: ['spinslam', 'cubetoss'], bag: ['shockclap', 'haste'] },
    anim: { run: 1, swing: 1, idle: 'default', jump: 'default', win: 'default' } },
  lou: { id: 'lou', name: 'Lou', role: 'SKY TWIN', blurb: 'The tall twin. Floaty, springy, light on his feet.', unlock: { type: 'start', text: 'Unlocked' }, model: 'lou',
    base: { weight: 0.7 }, mods: { maxHp: -10, runSpd: 0.02, jumpH: 0.22, allDmg: -0.04, punchDmg: -0.25 }, fx: { floatJump: 1 }, weights: { power: 0.7, agility: 1.4, resolve: 0.9 },
    passive: { name: 'Floaty Twin', text: 'Hold jump while falling to float. Triple jumps go higher. Punches are 25% weaker.' },
    aff: { elem: 'sun', lv: 1, dmg: 0.1 }, affW: { jumpH: 3, diveDmg: 2, wallGrip: 1.5, critChance: 1.5 },
    sig: 'shardboomerang', tree: { start: 'lou_root', slot: 1 }, sfx: { pitch: 1.12 },
    star: { id: 'twin', name: 'Twin Leap', dur: 10, col: 'mint', fx: { jumpMul: 1.3, twinStomp: 1 }, text: 'Floaty super-jumps. Every landing releases a twin quake that hurls enemies away.' },
    start: { core: { lay: 'GGBR', l: '101', gems: ['shardboomerang', 'pierce', 'shockclap', null] }, hot: ['shardboomerang', 'shockclap'], bag: ['gustdash', 'haste'] },
    anim: { run: 0.92, swing: 1.1, idle: 'sway', jump: 'float', win: 'spin' } },
  gruntmaw: { id: 'gruntmaw', name: 'Gruntmaw', role: 'BRAWLER', blurb: 'A mountain of green muscle. Slow, armoured, hits like a rockslide.', unlock: { type: 'act', n: 1, text: 'Clear Act I' }, model: 'gruntmaw',
    base: { weight: 1.8 }, mods: { maxHp: 60, runSpd: -0.14, jumpH: -0.12, allDmg: 0.12, dmgReduce: 0.12, punchDmg: 0.25, poundDmg: 0.2 }, fx: { armor: 1, heavyHands: 1 }, weights: { power: 1.3, agility: 0.4, resolve: 1.3 },
    passive: { name: 'Iron Hide', text: 'Cannot be knocked back and takes 12% less damage. Punches shove enemies a huge distance and hit in an arc.' },
    aff: { elem: 'shatter', lv: 2, dmg: 0.2 }, affW: { poundDmg: 3, punchDmg: 3, maxHp: 2.5, dmgReduce: 2.5, strikeRad: 2 },
    sig: 'spinslam', tree: { start: 'grunt_root', slot: 2 }, sfx: { pitch: 0.7 },
    star: { id: 'titan', name: 'Titan Rampage', dur: 9, col: 'gold', fx: { size: 1.7, quake: 1, kbMul: 2, trailR: 3.6 }, text: 'Grow into a titan. Every step quakes the ground, enemies are hurled for miles.' },
    start: { core: { lay: 'RRRB', l: '101', gems: ['spinslam', 'lifesteal', 'shockclap', null] }, hot: ['spinslam', 'shockclap'], bag: ['cubetoss', 'area'] },
    anim: { run: 0.82, swing: 0.8, idle: 'flex', jump: 'default', win: 'flex' } },
  zip: { id: 'zip', name: 'Zip', role: 'SPEEDSTER', blurb: 'Fast, fragile, and never touching the ground for long.', unlock: { type: 'act', n: 2, text: 'Clear Act II' }, model: 'zip',
    base: { weight: 0.6 }, mods: { maxHp: -35, runSpd: 0.2, jumpH: 0.06, wallGrip: 0.6, rewindRegen: 0.2 }, fx: { wallRun: 1 }, weights: { power: 0.8, agility: 1.7, resolve: 0.5 },
    passive: { name: 'Wall Runner', text: 'Wall slides become wall runs: hold forward to climb. Wall kicks launch 25% harder.' },
    aff: { elem: 'time', lv: 2, dmg: 0.2 }, affW: { runSpd: 3, jumpH: 1.5, wallGrip: 2.5, rewindRegen: 2.5, critChance: 2 },
    sig: 'rewinddash', tree: { start: 'zip_root', slot: 3 }, sfx: { pitch: 1.3 },
    star: { id: 'skip', name: 'Time Skip', dur: 8, col: 'violet', fx: { timeScale: 0.35, speedMul: 1.2, ghosts: 1, trailR: 2 }, text: 'Time bends: enemies and bolts crawl at a third of the speed while you blaze through.' },
    start: { core: { lay: 'GBBR', l: '101', gems: ['gustdash', 'haste', 'rewinddash', null] }, hot: ['gustdash', 'rewinddash'], bag: ['added_time', 'shardboomerang'] },
    anim: { run: 1.25, swing: 1.25, idle: 'bounce', jump: 'tuck', win: 'spin' } },
  petal: { id: 'petal', name: 'Petal', role: 'GLIDER', blurb: 'A breeze in a flower hat. Drifts, glides and heals.', unlock: { type: 'win', text: 'Restore the world (clear the finale)' }, model: 'petal',
    base: { weight: 0.55 }, mods: { maxHp: -5, runSpd: -0.04, jumpH: 0.08, hpRegen: 0.0015 }, fx: { glide: 1, gustCheap: 1 }, weights: { power: 0.8, agility: 1.2, resolve: 1.0 },
    passive: { name: 'Petal Glide', text: 'Hold jump in the air to glide: slow fall and forward drift. Gust skills cost 15% less Spark.' },
    aff: { elem: 'gust', lv: 2, dmg: 0.2 }, affW: { jumpH: 2, runSpd: 1.5, hpRegen: 3, lifeOnKill: 2, sparkRegen: 2 },
    sig: 'whirlgale', tree: { start: 'petal_root', slot: 4 }, sfx: { pitch: 1.2 },
    star: { id: 'bloom', name: 'Bloom Burst', dur: 10, col: 'pink', fx: { heal: 0.5, bloom: 1, trailR: 2.6 }, text: 'The world blossoms: a healing burst, flowers in your wake, and petals that slice what they touch.' },
    start: { core: { lay: 'GGRB', l: '101', gems: ['whirlgale', 'added_gust', 'gustdash', null] }, hot: ['whirlgale', 'gustdash'], bag: ['area', 'haste'] },
    anim: { run: 0.95, swing: 0.9, idle: 'sway', jump: 'glide', win: 'bloom' } },
  ember: { id: 'ember', name: 'Ember', role: 'FIRE MAGE', blurb: 'A cinder-hatted caster. Fights from range, weak up close.', unlock: { type: 'rift', n: 1, text: 'Clear a Shatter Rift' }, model: 'ember',
    base: { weight: 0.8 }, mods: { maxHp: -15, runSpd: -0.02, allDmg: 0.1, skillDmg: 0.1, punchDmg: -0.45, sparkRegen: 0.4 }, fx: { boltPunch: 1, sparkWeave: 1 }, weights: { power: 1.6, agility: 0.8, resolve: 0.6 },
    passive: { name: 'Spark Weaver', text: 'Your punch hurls an Ember Bolt instead of a melee hit, and Spark regenerates 40% faster.' },
    aff: { elem: 'ember', lv: 2, dmg: 0.2 }, affW: { skillDmg: 3, sparkMax: 2.5, sparkRegen: 2.5, castSpeed: 2, gemXp: 1.5, starGain: 1.5 },
    sig: 'cinderbloom', tree: { start: 'ember_root', slot: 5 }, sfx: { pitch: 0.95 },
    star: { id: 'inferno', name: 'Inferno Orbit', dur: 10, col: 'ember', fx: { freeCast: 1, cdMul: 0.4, orbit: 1, trailR: 2.2 }, text: 'Fire orbits you and burns what it touches. Skills cost no Spark and recharge in a blink.' },
    start: { core: { lay: 'RRBB', l: '101', gems: ['cinderbloom', 'added_ember', 'cubetoss', null] }, hot: ['cinderbloom', 'cubetoss'], bag: ['shockclap', 'haste'] },
    anim: { run: 0.95, swing: 0.9, idle: 'staff', jump: 'default', win: 'bloom' } },
};
function classDef(id) { return CLASSES[id] || CLASSES.pip; }
function classRegister(def) { // data-driven extension point: one entry here + one model builder entry in the game block (CLASS_MODELS)
  const d = Object.assign({ role: 'CUSTOM', blurb: '', unlock: { type: 'start', text: 'Unlocked' }, model: def.id, base: { weight: 1 }, mods: {}, fx: {}, weights: { power: 1, agility: 1, resolve: 1 }, passive: { name: '-', text: '' }, aff: null, affW: {},
    sig: 'cubetoss', tree: { start: def.id + '_root', slot: CLASS_ORDER.length }, sfx: { pitch: 1 }, star: { id: 'rush', name: 'Star Rush', dur: 10, col: 'rainbow', fx: {}, text: '' }, start: { hot: [], bag: [] }, anim: { run: 1, swing: 1, idle: 'default', jump: 'default', win: 'default' } }, def);
  CLASSES[d.id] = d; if (!CLASS_ORDER.includes(d.id)) CLASS_ORDER.push(d.id); return d;
}
const clamp10 = v => Math.max(1, Math.min(10, Math.round(v)));
function classBars(d) { // the five stat bars of the select screen (1..10)
  const m = d.mods || {};
  return { hp: clamp10((100 + (m.maxHp || 0)) / 18), speed: clamp10(6 * (1 + (m.runSpd || 0))), jump: clamp10(6 * (1 + (m.jumpH || 0) * 1.5)), weight: clamp10((d.base.weight || 1) * 5), power: clamp10(6 * (1 + ((m.allDmg || 0) + (m.skillDmg || 0) * 0.6 + (m.punchDmg || 0) * 0.3) * 2.5)) };
}
function classAffixWeights(d) { return d && d.affW ? d.affW : {}; }
function classUnlocked(d, unlocked) { return !!d && (d.unlock.type === 'start' || !!(unlocked && unlocked[d.id])); }
function classMeetsUnlock(d, ev) { // ev = {type:'act', n}, {type:'win'}, {type:'rift', n}: does this event unlock the class?
  const u = d.unlock; if (!u || u.type === 'start') return false; if (u.type === 'act') return ev.type === 'act' && ev.n >= u.n || ev.type === 'win'; if (u.type === 'win') return ev.type === 'win'; if (u.type === 'rift') return ev.type === 'rift' && ev.n >= (u.n || 1); return false;
}
function classStarterCore(d, slotKey = 0) { // the innate "core" socket rig every class carries (4 sockets, explicit layout) with its starter gems socketed
  const k = (d.start && d.start.core) || { lay: 'RRBG', l: '101', gems: [] }; let n = 0;
  return { slot: 'core', lay: { c: k.lay, l: k.l || '' }, gems: k.lay.split('').map((c, i) => k.gems && k.gems[i] ? { id: k.gems[i], lv: 1, xp: 0, u: gemUid((slotKey * 7919 + 1013 * (i + 1) + 5) >>> 0) } : null) };
}
function classNewSlot(id, bagN = 24, gemN = 30) { // a fresh per-class save slot (level 1 + the starter core rig and gems)
  const d = classDef(id), s = { level: 1, xp: 0, free: 0, spent: { power: 0, agility: 0, resolve: 0 }, perks: {}, pending: 0, picks: 0, bag: new Array(bagN).fill(null), equipped: { cap: null, gloves: null, boots: null, body: null, charm1: null, charm2: null },
    gems: new Array(gemN).fill(null), hot: [0, 0, 0, 0], core: classStarterCore(d, d.tree.slot + 1), tree: { id: d.id, start: d.tree.start, alloc: [] } };
  const k = d.start || {}; let n = 0; for (const gid of (k.bag || [])) { s.gems[n] = { id: gid, lv: 1, xp: 0, u: gemUid((d.tree.slot * 1009 + (n + 1) * 131 + 77) >>> 0) }; n++; }
  const act = gemCollect({ core: s.core }, ['core']); (k.hot || []).forEach((gid, i) => { const a = act.find(q => q.gem.id === gid); if (a && i < 4) s.hot[i] = a.gem.u; });
  return s;
}
// </class-core>

