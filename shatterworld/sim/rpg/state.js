// <rpg-game> ==================================================================================================================
// SHATTERWORLD RPG layer, part 2 of 2: integration with the game. The original verbs are wrapped from the outside (function re-binding +
// one per-frame hook rpgFrame() in frame()), so the original code paths stay intact. Re-bound: killEnemy, hurtHero, heroVsEnemy, doPound,
// onHeroLand, collectCoin, collectShard, bumpBlock, addEnemy, updateEnemies, setupAct1Entities, setupLevelEntities, clearEntities, killHero,
// victory, retry, restartAll, startRun, toMenu, updateHUD, updateBestLine, resetHero, padMenu, padFire, padPlace.
// Keys while the inventory / perk pick is open (documented in the on-screen footer): d-pad or left stick = move cursor, A = equip / confirm,
// X = salvage (press twice), Y = lock, B = back, LB / RB = previous / next tab, RT = reroll an affix, LT = sort.  Keyboard: arrows or WASD, Space/Enter,
// J, E, Z/Esc, Q, Shift, R, T.  Open with I / Tab / E (when nothing else is interactive) / Y on the pad (or Start -> Y).
// =============================================================================================================================
const RPG_SAVE_KEY = 'swn_rpg', BAG_N = 24, TB = JSON.parse(JSON.stringify(TUNING)); // TB = pristine copy: stat effects are always recomputed from it
const RP = { // persistent progression (saved)
  seed: ((Math.random() * 4294967296) >>> 0) || 0x5EED1E5, n: 0, picks: 0, level: 1, xp: 0, free: 0, spent: { power: 0, agility: 0, resolve: 0 }, perks: {}, pending: 0, gold: 0, dust: 0,
  bag: new Array(BAG_N).fill(null), equipped: { cap: null, gloves: null, boots: null, body: null, charm1: null, charm2: null },
  bestRift: 0, riftUnlocked: false, diff: 0, diffUnlocked: 0, codex: {}, filter: false, totals: { kills: 0, elites: 0, legends: 0, runs: 0, rifts: 0, salvaged: 0, rerolls: 0 }, riftSeed: 0, riftTier: 1, intro: false,
};
const RT = { // runtime (not saved)
  speedK: 1, jumpK: 1, S: null, sheet: null, hp: 100, max: 100, shield: 0, shieldMax: 0, rw: 3, rwMax: 3, pulseCd: 0, t: 0, real: 0, dirty: false, lastFlush: 0, lastHurt: -99, combo: 0, comboT: 0, hitN: 0,
  stompChain: 0, stompT: -9, phoenixT: -999, swT: -999, bellT: 0, buffRun: 0, goldStack: 0, goldT: 0, chill: 0, chillWant: 0, tuneKey: '', prevPlace: false, curEnemy: null, dmgOverride: 0,
  inHVE: false, stompFlag: false, pend: null, runDiff: 0, perkOpenAt: 0, wasBig: false, mirror: 3, bagWarnT: 0, depth: 0, banT: 0, riftCache: null, runFlags: {}, ghost: 0,
};
const RUN = { xp: 0, kills: 0, elites: 0, loot: [0, 0, 0, 0], gold: 0, dust: 0, lvStart: 1, levels: 0, legends: [], salv: 0 };
let RIFT = null;
const rpgDiffIdx = () => RIFT ? 0 : RT.runDiff;
const sat = (v, a, b) => v < a ? a : v > b ? b : v;
function drand() { return rpgRng(rpgHashSeed(RP.seed, RP.n++))(); }                       // deterministic drop stream: (seed, counter) -> [0,1)
const dseed = () => (drand() * 4294967296) >>> 0;
const rfmt = n => n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(Math.round(n));
const hexSeed = s => (s >>> 0).toString(16).toUpperCase().padStart(6, '0').slice(-6);

