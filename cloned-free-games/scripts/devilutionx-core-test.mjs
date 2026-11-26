#!/usr/bin/env node
// Proves the DevilutionX port's dungeons and its run with the exact rules code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced straight out of
// games/arcade/devilutionx/index.html.
//
// Per seed x depth: rooms exist, every floor cell is reachable from the spawn, the down stairs are
// reachable (and absent only on the last depth), monsters and loot sit on floor, no monster starts
// within 4 tiles of the spawn or on the stairs, no two monsters share a cell, and the same seed
// rebuilds the same floor byte for byte.
// Then, through tapCell/drinkPotion/sim only: a buffed QA avatar walks all five depths with real
// taps, kills the Butcher and wins; and the combat, potion, levelling, wall-block and
// unreachable-target rules are proven directly.
//
// usage: node devilutionx-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/devilutionx/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `
export { W, H, DEPTHS, T, MONSTERS, mulberry32, genLevel, mkState, mkMonster, levelInto, populate,
  sim, tapCell, stepDir, drinkPotion, descend, heroAttack, killMonster, hitHero, addXp, bfsPaths,
  pathFrom, pathToAdjacent, reach, walkT, inb, idx, cheb, enemyAt, itemAt, POTION_HEAL, HERO_STEP };`;
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const {
  W, H, DEPTHS, T, genLevel, mkState, sim, tapCell, stepDir, drinkPotion, descend, addXp,
  reach, walkT, idx, cheb, enemyAt, POTION_HEAL,
} = mod;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); fails++; return false; }
  console.log('  ok   ' + msg);
  return true;
};

const SEEDS = [1, 7, 20261125, 424242, 99991];
console.log(`grid ${W}x${H}, ${DEPTHS} depths, seeds ${SEEDS.join(', ')}`);

const pump = (S, sec) => {
  const n = Math.round(sec * 30);
  for (let i = 0; i < n && !S.over; i++) sim(S, 1 / 30);
  return S;
};

// ---------- 1. every depth of every seed generates a connected, safe floor ----------
for (const seed of SEEDS) {
  for (let depth = 1; depth <= DEPTHS; depth++) {
    const S = mkState(seed);
    whereas: {
      // walk down to the depth with real descents so the population is the generated one
      for (let i = 1; i < depth; i++) descend(S);
      const tag = `seed ${seed} depth ${depth}`;
      ok(S.depth === depth, `${tag}: reached depth`, S.depth);
      ok(S.rooms.length >= 2, `${tag}: rooms exist`, S.rooms.length);
      ok(walkT(S.t, S.spawn.r, S.spawn.c), `${tag}: spawn stands on floor`);

      // all floor reachable from the spawn
      let floor = 0, unreachable = 0;
      for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
        if (!walkT(S.t, r, c)) continue;
        floor++;
        if (reach(S, S.spawn.r, S.spawn.c, r, c) < 0) unreachable++;
      }
      ok(unreachable === 0, `${tag}: every floor cell reachable (${floor} cells)`, unreachable);

      if (depth < DEPTHS) {
        ok(S.down && S.t[idx(S.down.r, S.down.c)] === T.DOWN, `${tag}: down stairs carved`);
        ok(reach(S, S.spawn.r, S.spawn.c, S.down.r, S.down.c) > 0, `${tag}: stairs reachable from spawn`);
      } else {
        ok(!S.down, `${tag}: no stairs on the last depth`);
      }

      let bad = [];
      for (const mon of S.monsters) {
        if (!walkT(S.t, mon.r, mon.c)) bad.push({ why: 'off floor', kind: mon.kind, r: mon.r, c: mon.c });
        if (cheb(mon.r, mon.c, S.spawn.r, S.spawn.c) <= 4) bad.push({ why: 'too close to spawn', kind: mon.kind });
        if (S.down && mon.r === S.down.r && mon.c === S.down.c) bad.push({ why: 'on the stairs', kind: mon.kind });
      }
      ok(bad.length === 0, `${tag}: monsters on floor, clear of spawn and stairs`, bad);

      const cells = new Set();
      let dup = 0;
      for (const mon of S.monsters) { const k = mon.r + ',' + mon.c; if (cells.has(k)) dup++; cells.add(k); }
      ok(dup === 0, `${tag}: no two monsters share a cell`, dup);
      for (const it of S.items) if (!walkT(S.t, it.r, it.c)) bad.push({ why: 'loot off floor', kind: it.kind });
      ok(bad.length === 0, `${tag}: loot sits on floor`, bad);

      if (depth === DEPTHS) {
        const boss = S.monsters.filter((x) => x.boss);
        ok(boss.length === 1, `${tag}: exactly one Butcher`, boss.length);
        ok(boss[0] && cheb(boss[0].r, boss[0].c, S.spawn.r, S.spawn.c) > 4, `${tag}: boss away from spawn`);
      } else {
        ok(!S.monsters.some((x) => x.boss), `${tag}: no boss before the last depth`);
      }

      // determinism
      const S2 = mkState(seed);
      while (S2.depth < depth) descend(S2);
      const sameTiles = Buffer.compare(Buffer.from(S.t), Buffer.from(S2.t)) === 0;
      const sameMons = JSON.stringify(S.monsters.map((x) => [x.kind, x.r, x.c])) ===
                       JSON.stringify(S2.monsters.map((x) => [x.kind, x.r, x.c]));
      ok(sameTiles && sameMons, `${tag}: same seed rebuilds the same floor`);
    }
  }
}

// ---------- 2. a buffed QA avatar walks all five depths with real taps and wins ----------
{
  const S = mkState(4242);
  S.atk = 120; S.maxhp = 900; S.hp = 900; S.potions = 9;
  let stuck = 0, killedOnRoute = 0;
  while (S.depth < DEPTHS && !S.over && stuck++ < 40) {
    // a monster on the only route blocks the path: kill it, then carry on
    const res = tapCell(S, S.down.r, S.down.c);
    if (res.kind === 'nopath') {
      const blocker = S.monsters.find((x) => x.hp > 0 && x.kind !== 'butcher');
      if (!blocker) break;
      tapCell(S, blocker.r, blocker.c);
      pump(S, 6);
      killedOnRoute++;
      continue;
    }
    const d0 = S.depth;
    let t = 0;
    while (S.depth === d0 && !S.over && t < 12) { sim(S, 1 / 30); t += 1 / 30; }
    if (S.depth === d0) {
      // the hero was body-blocked next to the stairs; clear the cell beside them
      const nb = S.monsters.find((x) => x.hp > 0 && cheb(x.r, x.c, S.down.r, S.down.c) <= 2);
      if (!nb) break;
      tapCell(S, nb.r, nb.c); pump(S, 5);
    }
  }
  ok(S.depth === DEPTHS, 'QA run reaches depth 5 through real taps', { depth: S.depth, stuck, killedOnRoute });
  ok(!S.over, 'QA run alive on the last depth');

  const boss = S.monsters.find((x) => x.boss);
  ok(!!boss, 'the Butcher stands on depth 5');
  let guard = 0;
  while (boss.hp > 0 && !S.over && guard++ < 40) {
    tapCell(S, boss.r, boss.c);
    pump(S, 2);
  }
  ok(S.over && S.won && S.result === 'win', 'killing the Butcher wins the run', { over: S.over, won: S.won, result: S.result });
  ok(S.kills >= 1, 'the run counted its kills', S.kills);
}

// ---------- 3. combat, death, potions, levelling ----------
{
  const S = mkState(77);
  const p = S.down;
  // a weak monster one tile from the hero: tapping it strikes
  S.monsters = [mod.mkMonster(S, 'fallen', S.r + 1, S.c, 3)];
  S.items = [];
  const hp0 = S.hp;
  const res = tapCell(S, S.r + 1, S.c);
  ok(res.kind === 'strike', 'tapping an adjacent monster strikes it', res);
  pump(S, 1.2);
  ok(S.kills === 1 && !enemyAt(S, S.r + 1, S.c), 'the monster dies and leaves its cell', { kills: S.kills });
  ok(S.xp > 0, 'a kill pays xp at once', { xp: S.xp });
  ok(S.items.some((i) => i.kind === 'gold' && i.r === S.r + 1 && i.c === S.c), 'a kill drops its gold where it fell', S.items);
  ok(S.hp === hp0, 'an adjacent one-shotted monster never gets a swing in');

  // stepping onto the drop picks it up
  const goldBefore = S.gold;
  tapCell(S, S.r + 1, S.c);
  pump(S, 1);
  ok(S.gold > goldBefore, 'walking over the drop collects the gold', { goldBefore, gold: S.gold });

  // walls cost nothing
  const before = { r: S.r, c: S.c, steps: S.steps };
  let wall = null;
  for (let r = 0; r < H && !wall; r++) for (let c = 0; c < W && !wall; c++) {
    if (S.t[idx(r, c)] === T.WALL) wall = [r, c];
  }
  ok(!!wall, 'the floor has rock to bump into');
  const wallRes = tapCell(S, wall[0], wall[1]);
  pump(S, 0.6);
  ok(wallRes.kind === 'blocked', 'a wall tap is refused', wallRes);
  ok(S.steps === before.steps, 'a refused tap does not move the hero', { steps: S.steps });

  // an idle hero takes hits from a monster that can see it
  const S2 = mkState(78);
  S2.monsters = [mod.mkMonster(S2, 'skeleton', S2.r + 3, S2.c)];
  S2.items = [];
  const hpA = S2.hp;
  pump(S2, 3);
  ok(S2.hitsTaken > 0 && S2.hp < hpA, 'a monster that sees an idle hero closes and strikes', { hpA, hp: S2.hp, hits: S2.hitsTaken });

  // death ends the run
  S2.hp = 2; S2.maxhp = 40;
  S2.monsters = [mod.mkMonster(S2, 'overlord', S2.r + 1, S2.c)];
  pump(S2, 3);
  ok(S2.over && !S2.won && S2.result === 'dead' && S2.hp === 0, 'hp to zero ends the run as a death', { over: S2.over, result: S2.result, hp: S2.hp });

  // potions
  const S3 = mkState(79);
  S3.hp = 10; S3.maxhp = 40; S3.potions = 2;
  const drink = drinkPotion(S3);
  ok(drink.kind === 'drink' && S3.hp === 10 + POTION_HEAL && S3.potions === 1, 'a potion heals for its amount and spends one', { drink, hp: S3.hp });
  const fullRes = (() => { S3.hp = S3.maxhp; return drinkPotion(S3); })();
  ok(fullRes.kind === 'full' && S3.potions === 1, 'a potion at full hp is not spent', fullRes);
  S3.potions = 0; S3.hp = 5;
  const none = drinkPotion(S3);
  ok(none.kind === 'empty' && S3.hp === 5, 'no potions means no heal', none);

  // levelling
  const S4 = mkState(80);
  const atk0 = S4.atk, max0 = S4.maxhp;
  addXp(S4, 28);
  ok(S4.level === 2 && S4.atk === atk0 + 1 && S4.maxhp === max0 + 8 && S4.hp === S4.maxhp,
    'xp levels the hero up and heals it', { level: S4.level, atk: S4.atk });

  // stepping with the arrow keys is one tile, and the stairs take a tap to descend
  const S5 = mkState(81);
  S5.monsters = []; S5.items = [];
  const d = S5.down;
  // find a floor neighbour of the stairs and stand there
  let stand = null;
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const r = d.r + dr, c = d.c + dc;
    if (walkT(S5.t, r, c)) { stand = [r, c]; break; }
  }
  ok(!!stand, 'a floor cell beside the stairs exists');
  S5.r = stand[0]; S5.c = stand[1];
  const tapped = tapCell(S5, d.r, d.c);
  ok(tapped.kind === 'walk', 'tapping the stairs walks to them', tapped);
  pump(S5, 1.5);
  ok(S5.depth === 2, 'arriving on the stairs descends a depth', S5.depth);

  // an unreachable target is refused, not silently accepted
  const S6 = mkState(82);
  S6.monsters = []; S6.items = [];
  let wallCell = null;
  for (let r = 0; r < H && !wallCell; r++) for (let c = 0; c < W && !wallCell; c++) {
    if (S6.t[idx(r, c)] !== T.VOID && S6.t[idx(r, c)] !== T.WALL && !walkT(S6.t, r, c)) wallCell = [r, c];
  }
  if (wallCell) {
    const res6 = tapCell(S6, wallCell[0], wallCell[1]);
    ok(res6.kind === 'blocked', 'a non-floor cell is refused', res6);
  }
}

// ---------- 4. a fresh run is not an instant loss ----------
{
  let diedAt = [];
  for (const seed of SEEDS) {
    const S = mkState(seed);
    pump(S, 2);
    if (S.over) diedAt.push({ seed, result: S.result, time: +S.time.toFixed(2) });
  }
  ok(diedAt.length === 0, 'no seed kills an idle hero in the first two seconds', diedAt);
}

console.log(fails === 0 ? '\nPASS — dungeons, run, combat, potions and terminals all measured.' : `\nFAIL — ${fails} assertion(s) failed.`);
process.exit(fails === 0 ? 0 : 1);
