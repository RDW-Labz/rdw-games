// <mob-game> ====================================================================================================================
// SHATTERWORLD mob variety, part 2b: integration. The new mobs are ordinary ENEMIES entries (state 'mob'), so the whole RPG layer applies unchanged: level / tier / elite + champion affixes, hero verbs, skills,
// gems, drops, plates, rift kill progress. The pure FSM (mob-core) runs at a fixed 30 Hz per mob; this block moves it through the world (floorAt / walls / edges), draws the TELEGRAPHS (ground decals that fill up
// until the hit lands), enemy projectiles (one InstancedMesh), spore clouds, shockwaves, plays the cues, and spawns them per act, in Rifts (families) and as act guardians.
// Re-bound here: addEnemy, rpgDecorate, rpgOnKilled, killEnemy, rpgDamageEnemy, rpgApplyDamage, heroVsEnemy, rpgEnemiesTick, rpgSpawnAct, rpgFrame, clearEntities, gemOk, rpgHud (boss bar).
// ==============================================================================================================================
const MOBX = { boss: null, hAir: 0, hvx: 0, hvz: 0, t: 0, minions: 0, spawned: 0, kills: {}, ctx: { hx: 0, hz: 0, hy: 0, hAir: 0, alive: true, hvx: 0, hvz: 0, hpf: 1, minions: 0, ally: null, move: null, wallAhead: null }, last: null, log: [] };
