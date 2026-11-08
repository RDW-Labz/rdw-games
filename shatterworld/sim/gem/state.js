// <gem-game> ===================================================================================================================
// Skill gems + Spark + Star Power + forms + character classes, integrated with the game. Everything here is ADDITIVE: the original verbs and the RPG layer are
// wrapped from the outside (function re-binding, like the RPG layer does). Re-bound here: rpgSnapshot, rpgApplySnapshot, rpgStatState, rpgRecalc, rpgDrops, rpgOnKilled,
// rpgHitHooks, rpgPickupLoot (patched), collectShard, collectCoin, victory, rpgRiftEnd, doPunch, onHeroLand, hurtHero, stepHero, updateEnemies, rpgEnemiesTick,
// updateHeroVisual, clearEntities, toMenu, startRun, padMenu, uiMove, uiAct, uiKey, uiTab, rpgRenderInv, sfx.
// Controls (flat): keys 1-4 cast the hotbar; pad / phone pad: hold LB (Q) and press A / B / X / Y = slot 1 / 2 / 3 / 4 (a tap of LB is still "recentre camera");
// Star Power: G, or LB + RB together.  Menu / pause: C or the CHARACTER button (pad: B on the menu) opens the character select.
// ==============================================================================================================================
const GEM_ROWS = ['core', 'cap', 'gloves', 'boots', 'body', 'charm1', 'charm2'], GEM_ROW_LABEL = { core: 'CORE', cap: 'CAP', gloves: 'GLOVES', boots: 'BOOTS', body: 'COVERALL', charm1: 'CHARM I', charm2: 'CHARM II' };
const GEM_FIELDS = ['level', 'xp', 'free', 'spent', 'perks', 'pending', 'picks', 'bag', 'equipped', 'gems', 'hot', 'core'];
const GM = {
  active: [], slot: [null, null, null, null], dirty: true, cd: [0, 0, 0, 0], cdMax: [1, 1, 1, 1], spark: 100, sparkMax: 100, sparkFlash: 0, deny: 0, t: 0, prevUids: null,
  cast: null, queued: -1, pose: { kind: '', t: 0, dur: 0.4, hand: 1 }, hist: new Float32Array(48 * 4), histN: 0, histT: 0, echoes: [], enemyScale: 1, hits: 0, bagWarnT: -9, hudSig: '', slotXp: [0, 0, 0, 0],
  qHeld: false, qUsed: false, qT: 0, stats: { casts: 0, hits: 0, stars: 0, kills: 0 }, lastCast: '', dash: null, flash: 0, castFlash: [0, 0, 0, 0], levelUps: 0,
};
Object.assign(RP, { cls: 'pip', slots: {}, unlocked: { pip: 1, lou: 1 }, gems: new Array(GEM_TUNING.bagN).fill(null), hot: [0, 0, 0, 0], core: classStarterCore(CLASSES.pip, 1), stash: new Array(GEM_TUNING.stashN).fill(null), gn: 0, kit: 1 });
const gemPad = (arr, n) => { const o = new Array(n).fill(null); (arr || []).slice(0, n).forEach((g, i) => { o[i] = g; }); return o; };
const gemRowItem = k => k === 'core' ? RP.core : RP.equipped[k];
const gemRand = () => rpgRng(rpgHashSeed((RP.seed ^ 0x6E3A) >>> 0, RP.gn++))();      // separate drop stream: gems never disturb the item drop sequence

