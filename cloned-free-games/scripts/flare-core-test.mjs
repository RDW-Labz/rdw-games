#!/usr/bin/env node
// Proves the Ember Depths (Flare / Empyrean Campaign card) port's rules with the exact code the
// browser runs: the // >>>CORE ... // <<<CORE block is sliced out of
// games/arcade/flare-game/index.html.
//
// Checks the arena clamp, click-to-move, the automatic blade, the enemy close-and-strike cycle,
// XP thresholds and what a level grants, shard pickups, potions, the five-wave ladder, both
// terminal states — and then plays the game out on 30 seeds with a kiting bot (must clear the
// floor) and a passive one (must fall), so the balance is measured, not asserted.
//
// usage: node flare-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/Projects/rdw-games/shelf/games/arcade/flare-game/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m || !m[1].trim()) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `
export { ARENA, PLAYER_R, ENEMY_R, KINDS, WAVES, P, LEVELS, rngOf, mkState, byId, dist, clampArena,
  spawnWave, nearestEnemy, addXp, hitEnemy, hurtPlayer, pickUp, checkOver, step, drinkPotion };`;
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const {
  ARENA, PLAYER_R, KINDS, WAVES, P, LEVELS, rngOf, mkState, byId, dist, clampArena, spawnWave,
  nearestEnemy, addXp, hitEnemy, hurtPlayer, pickUp, checkOver, step, drinkPotion,
} = mod;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) { console.log('  ok   ' + msg); return true; }
  fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};

// ---- 1. the arena ----
console.log('arena');
{
  const S = mkState(1);
  ok(S.p.x === 0 && S.p.z === 0, 'the delve opens with the hero at the centre');
  ok(S.p.hp === P.maxHp && S.p.maxHp === P.maxHp, 'full vitality at the start', S.p.hp);
  ok(S.wave === 0 && S.enemies.length === WAVES[0].length, 'wave one is on the floor', { wave: S.wave, n: S.enemies.length });
  ok(S.enemies.every((e) => Math.hypot(e.x, e.z) <= ARENA), 'every enemy spawns inside the rim');
  ok(S.enemies.every((e) => Math.hypot(e.x, e.z) >= ARENA * 0.6), 'the horde starts away from the hero', S.enemies.map((e) => +Math.hypot(e.x, e.z).toFixed(1)));
  ok(!S.over && S.result === null, 'a fresh delve is not over');
  ok(WAVES.length === 5, 'the ladder is five waves', WAVES.length);
  // the clamp really holds a body inside the floor
  const o = { x: 99, z: 0 };
  clampArena(o, PLAYER_R);
  ok(Math.hypot(o.x, o.z) <= ARENA - PLAYER_R + 1e-9, 'the clamp keeps a body off the wall', o);
}

// ---- 2. click-to-move ----
console.log('stride');
{
  const S = mkState(2);
  const before = { x: S.p.x, z: S.p.z };
  S.p.moveTo = { x: 3, z: 0 };
  for (let i = 0; i < 60; i++) step(S, 1 / 60, { moveTo: S.p.moveTo });
  ok(S.p.x > before.x + 2.5, 'the hero strides toward the clicked point', { from: before, to: { x: +S.p.x.toFixed(2), z: +S.p.z.toFixed(2) } });
  ok(Math.abs(S.p.z) < 0.05, 'the stride follows the straight line');
  for (let i = 0; i < 120; i++) step(S, 1 / 60, { moveTo: S.p.moveTo });
  ok(Math.abs(S.p.x - 3) < 0.15, 'the stride stops on the point', +S.p.x.toFixed(3));
  ok(S.p.moveTo === null, 'the order clears on arrival');
  // a click outside the rim is clamped by the rules, not by the wall
  const S2 = mkState(3);
  S2.p.moveTo = { x: 0, z: 40 };
  for (let i = 0; i < 600; i++) step(S2, 1 / 60, { moveTo: S2.p.moveTo });
  ok(Math.hypot(S2.p.x, S2.p.z) <= ARENA - PLAYER_R + 1e-06, 'a stride into the wall stops at the rim', { x: +S2.p.x.toFixed(2), z: +S2.p.z.toFixed(2) });
}

// ---- 3. the blade swings by itself ----
console.log('blade');
{
  const S = mkState(4);
  S.enemies = [{ id: 0, kind: 'skel', x: 1.4, z: 0, hp: 26, maxHp: 26, cd: 99 }];
  S.p.cd = 0;
  const hp0 = S.enemies[0].hp;
  step(S, 1 / 60, { moveTo: null });
  ok(S.enemies[0].hp < hp0, 'an enemy inside reach is struck without a click', { before: hp0, after: S.enemies[0].hp });
  const hp1 = S.enemies[0].hp;
  step(S, 1 / 60, { moveTo: null });
  ok(S.enemies[0].hp === hp1, 'the blade has a cooldown between swings', { hp1, now: S.enemies[0].hp });
  // out of reach: nothing happens
  const S2 = mkState(5);
  S2.enemies = [{ id: 0, kind: 'imp', x: 6.5, z: 0, hp: 14, maxHp: 14, cd: 99 }];
  step(S2, 1 / 60, { moveTo: null });
  ok(S2.enemies[0].hp === 14, 'nothing outside reach is struck', S2.enemies[0].hp);
}

// ---- 4. the horde closes and strikes ----
console.log('horde');
{
  const S = mkState(6);
  S.enemies = [{ id: 0, kind: 'imp', x: 5, z: 0, hp: 14, maxHp: 14, cd: 0 }];
  S.p.cd = 99;                       // keep the hero's blade out of the way
  const d0 = dist(S.enemies[0], { x: S.p.x, z: S.p.z });
  for (let i = 0; i < 30; i++) step(S, 1 / 60, { moveTo: null });
  const d1 = dist(S.enemies[0], { x: S.p.x, z: S.p.z });
  ok(d1 < d0, 'the enemy closes on the hero', { d0: +d0.toFixed(2), d1: +d1.toFixed(2) });
  const hp0 = S.p.hp;
  for (let i = 0; i < 240; i++) step(S, 1 / 60, { moveTo: null });
  ok(S.p.hp < hp0, 'a crowded hero takes contact damage', { before: hp0, after: S.p.hp });
  ok(S.p.hp === hp0 - KINDS.imp.dmg * Math.round((hp0 - S.p.hp) / KINDS.imp.dmg), 'contact damage lands in whole enemy blows');
  // an enemy on its cooldown does not strike again the next tick
  const S2 = mkState(7);
  S2.enemies = [{ id: 0, kind: 'demon', x: 0.95, z: 0, hp: 48, maxHp: 48, cd: 0 }];
  S2.p.cd = 99;
  step(S2, 1 / 60, { moveTo: null });
  const h1 = S2.p.hp;
  step(S2, 1 / 60, { moveTo: null });
  ok(S2.p.hp === h1, 'the enemy strike respects its cooldown', { h1, now: S2.p.hp });
}

// ---- 5. experience, levels, shards, potions ----
console.log('growth');
{
  const S = mkState(8);
  const p = S.p;
  ok(p.level === 0, 'the hero starts at level one');
  addXp(S, LEVELS[1] - 1);
  ok(p.level === 0, 'just under the threshold is still level one', p.xp);
  addXp(S, 1);
  ok(p.level === 1, 'crossing the first threshold levels up', { level: p.level, xp: p.xp });
  ok(p.maxHp > P.maxHp && p.dmg > P.dmg, 'a level raises vitality and damage', { maxHp: p.maxHp, dmg: p.dmg });
  ok(p.potions >= 1, 'a level refills the potion belt', p.potions);
  const big = mkState(9);
  addXp(big, 100000);
  ok(big.p.level === LEVELS.length - 1, 'experience caps at the last rung', big.p.level);

  // a shard is taken by walking over it, and it sharpens the blade
  const S2 = mkState(10);
  S2.shards = [{ x: 0.3, z: 0, id: 99 }];
  const dmg0 = S2.p.dmg, hp0 = S2.p.maxHp;
  step(S2, 1 / 60, { moveTo: null });
  ok(S2.p.shards === 1 && S2.shards.length === 0, 'a shard underfoot is collected', { shards: S2.p.shards, left: S2.shards.length });
  ok(S2.p.dmg > dmg0 && S2.p.maxHp > hp0, 'the shard sharpens the blade and thickens vitality', { dmg: S2.p.dmg, maxHp: S2.p.maxHp });
  // a shard across the floor stays there
  const S3 = mkState(11);
  S3.shards = [{ x: 4, z: 4, id: 98 }];
  step(S3, 1 / 60, { moveTo: null });
  ok(S3.shards.length === 1 && S3.p.shards === 0, 'a distant shard is not collected', S3.shards.length);

  // potions
  const S4 = mkState(12);
  S4.p.hp = 40;
  const r = drinkPotion(S4);
  ok(r.ok && S4.p.hp === 40 + P.heal && S4.p.potions === P.potMax - 1, 'a potion heals and spends a charge', { hp: S4.p.hp, potions: S4.p.potions });
  S4.p.potions = 0;
  const r2 = drinkPotion(S4);
  ok(!r2.ok && r2.why === 'empty', 'an empty belt refuses', r2);
  const S5 = mkState(13);
  const r3 = drinkPotion(S5);
  ok(!r3.ok && r3.why === 'full', 'a full hero wastes no potion', r3);
  S5.p.hp = 20; S5.p.potions = 1;
  drinkPotion(S5);
  ok(S5.p.hp === 60, 'a potion cannot overheal', S5.p.hp);
}

// ---- 6. waves and the two terminal states ----
console.log('waves');
{
  const S = mkState(14);
  S.enemies = [];
  S.wave = 0;
  step(S, 1 / 60, { moveTo: null });
  ok(S.wave === 1 && S.enemies.length === WAVES[1].length, 'an empty floor brings the next wave', { wave: S.wave, n: S.enemies.length });
  ok(!S.over, 'the delve continues while waves remain');

  // win: the last enemy of the last wave dies
  const W = mkState(15);
  W.wave = WAVES.length - 1;
  W.enemies = [{ id: 0, kind: 'imp', x: 1.3, z: 0, hp: 1, maxHp: 14, cd: 99 }];
  W.p.cd = 0;
  step(W, 1 / 60, { moveTo: null });
  ok(W.over && W.result === 'win', 'clearing the fifth wave wins the delve', { over: W.over, result: W.result });
  ok(W.kills === 1, 'the last kill is counted', W.kills);

  // lose: vitality to zero
  const L = mkState(16);
  L.p.hp = 3;
  L.enemies = [{ id: 0, kind: 'demon', x: 0.95, z: 0, hp: 48, maxHp: 48, cd: 0 }];
  L.p.cd = 99;
  step(L, 1 / 60, { moveTo: null });
  ok(L.over && L.result === 'lose', 'a drained hero ends the delve', { over: L.over, result: L.result });
  ok(L.p.hp === 0, 'vitality stops at zero', L.p.hp);
  // nothing happens after the end
  const before = JSON.stringify([L.wave, L.enemies.length, L.p.hp]);
  step(L, 1 / 60, { moveTo: null });
  ok(JSON.stringify([L.wave, L.enemies.length, L.p.hp]) === before, 'a finished delve is frozen');
}

// ---- 7. playouts: a kiting hero clears the floor, a passive one falls ----
console.log('playouts');
{
  // The bot keeps a band around the nearest enemy: back off when it is close, close in when it
  // is far, strafe when it is comfortable. That is exactly the skill the game asks a player for.
  const kite = (S) => {
    const p = S.p;
    const near = nearestEnemy(S, p.x, p.z, 99);
    if (!near) return null;
    const dx = near.e.x - p.x, dz = near.e.z - p.z, d = Math.hypot(dx, dz) || 1e-6;
    const want = KINDS[near.e.kind].reach + P.range * 0.62;
    let tx, tz;
    if (d < want * 0.86) { tx = p.x - (dx / d) * 3; tz = p.z - (dz / d) * 3; }        // back off
    else if (d > want * 1.12) { tx = p.x + (dx / d) * 2; tz = p.z + (dz / d) * 2; }   // close in
    else { tx = p.x - (dz / d) * 2; tz = p.z + (dx / d) * 2; }                        // strafe
    const L = Math.hypot(tx, tz), lim = ARENA - PLAYER_R - 0.1;
    if (L > lim) { tx = tx / L * lim; tz = tz / L * lim; }
    return { x: tx, z: tz };
  };
  const play = (seed, bot) => {
    const S = mkState(seed);
    let guard = 0;
    while (!S.over && guard++ < 60 * 240) step(S, 1 / 60, { moveTo: bot ? bot(S) : null });
    return S;
  };
  let wins = 0, losses = 0, maxT = 0, bad = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const S = play(seed, kite);
    if (S.result === 'win') wins++; else if (S.result === 'lose') losses++; else bad++;
    maxT = Math.max(maxT, S.t);
    if (S.p.hp < 0 || S.p.hp > S.p.maxHp + 1e-6) bad++;
  }
  ok(bad === 0, 'every kiting run ends in one of the two terminal states with vitality in range', bad);
  ok(wins === 30, 'a hero who kites clears all five waves on every seed', { wins, losses });
  ok(maxT < 210, 'a clear takes under three and a half minutes of game time', +maxT.toFixed(1));
  let pWins = 0, pLosses = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const S = play(seed, null);
    if (S.result === 'win') pWins++; else if (S.result === 'lose') pLosses++;
  }
  ok(pLosses === 10, 'a hero who never moves falls on every seed (the horde is a real threat)', { pWins, pLosses });
  console.log(`  (kiting bot: ${wins}/${wins + losses} clears, slowest ${maxT.toFixed(1)}s; passive hero: ${pLosses}/10 falls)`);
}

// ---- 8. the opening is playable ----
console.log('opening');
{
  const S = mkState(20261121);
  ok(!S.over, 'the opening delve is live');
  ok(S.p.hp === P.maxHp, 'the hero opens at full vitality');
  ok(S.p.potions === P.potMax, 'the belt opens full');
  ok(S.enemies.length === 3, 'three imps are on the floor', S.enemies.length);
  const d0 = Math.min(...S.enemies.map((e) => Math.hypot(e.x, e.z)));
  ok(d0 > P.range + 1.5, 'nothing is already inside the blade at boot', +d0.toFixed(2));
  // one second of standing still costs nothing yet
  const hp0 = S.p.hp;
  for (let i = 0; i < 60; i++) step(S, 1 / 60, { moveTo: null });
  ok(S.p.hp === hp0, 'the opening second is not a free hit', { hp0, now: S.p.hp });
}

console.log(fails ? `\nFAIL ${fails} assertion(s)` : '\nALL PASS');
process.exit(fails ? 1 : 0);
