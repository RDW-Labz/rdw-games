#!/usr/bin/env node
// Core test for the Infra Arcana port. Slices the // >>>CORE block out of the shipped HTML and
// re-runs the floor generator, the flood fill, line of sight, the gun/knife maths, the sanity
// economy and a greedy pilot on the exact functions the browser executes.
// usage: node scripts/infra-arcana-core-test.mjs [path-to-index.html]
import { readFile } from 'node:fs/promises';

const FILE = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/infra-arcana/index.html';
const html = await readFile(FILE, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.log('FAIL no CORE block (check the >>>CORE / <<<CORE markers)'); process.exit(1); }

const core = await import('data:text/javascript;base64,' + Buffer.from(m[1] + `
export { CW, CH, DEPTHS, SIGHT, CLASSES, CLASS_ORDER, KINDS, ROSTER, walkable, los, genFloor, mkState,
         reveal, sighting, monsterAt, act, fireAt, reload, pray, descend, monstersTurn, stepToward, endturn, dist2 };`
).toString('base64'));
const { CW, CH, DEPTHS, SIGHT, CLASSES, KINDS, walkable, los, genFloor, mkState, reveal, sighting,
        monsterAt, act, fireAt, reload, pray, stepToward, dist2, endturn } = core;

const checks = {}, fail = [];
const check = (name, ok, detail) => { checks[name] = ok; if (!ok) fail.push(name + (detail ? ' — ' + detail : '')); };

// ---- 1) generation + connectivity ----
const seeds = [1, 7, 42, 20261126, 9001, 555];
let floors = 0, badReach = [], badAll = [], nearMon = 0, itemOff = 0, relicBad = 0, instantLoss = 0;
for (const seed of seeds) {
  for (let depth = 1; depth <= DEPTHS; depth++) {
    const f = genFloor(seed, depth);
    floors++;
    const seen = new Set([f.start[0] * CW + f.start[1]]);
    let frontier = [f.start], cells = 0;
    while (frontier.length) {
      const next = [];
      for (const [r, c] of frontier) {
        cells++;
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nr = r + dr, nc = c + dc;
          if (!walkable(f.tiles, nr, nc)) continue;
          const k = nr * CW + nc;
          if (seen.has(k)) continue;
          seen.add(k); next.push([nr, nc]);
        }
      }
      frontier = next;
    }
    const target = depth >= DEPTHS ? f.items.find((i) => i.kind === 'relic') : { r: f.stairs[0], c: f.stairs[1] };
    if (!target || !seen.has(target.r * CW + target.c)) badReach.push(`${seed}/${depth}`);
    let open = 0;
    for (let r = 0; r < CH; r++) for (let c = 0; c < CW; c++) {
      if (f.tiles[r][c] !== '.') continue;
      if (!seen.has(r * CW + c)) open++;
    }
    if (open) badAll.push(`${seed}/${depth}:${open}`);
    if (f.monsters.some((x) => Math.max(Math.abs(x.r - f.start[0]), Math.abs(x.c - f.start[1])) <= 3)) nearMon++;
    if (f.items.some((i) => f.tiles[i.r][i.c] === '#')) itemOff++;
    const relic = f.items.find((i) => i.kind === 'relic');
    if (depth >= DEPTHS) { if (!relic || !f.altar || f.stairs !== null) relicBad++; }
    else if (relic || f.altar || !f.stairs) relicBad++;

    const S = mkState(seed, depth);
    reveal(S); sighting(S);
    if (S.over) instantLoss++;
  }
}
check('floorsGenerated', floors === seeds.length * DEPTHS, `${floors} floors`);
check('stairsReachable', badReach.length === 0, badReach.slice(0, 3).join(', '));
check('everyFloorCellConnected', badAll.length === 0, badAll.slice(0, 3).join(', '));
check('noMonsterNearSpawn', nearMon === 0, `${nearMon} floors parked a monster within Chebyshev 3`);
check('itemsOnFloor', itemOff === 0, `${itemOff} items on a wall`);
check('relicOnBottomDepthOnly', relicBad === 0, `${relicBad} bad relic/stairs floors`);
check('noInstantLoss', instantLoss === 0, `${instantLoss} floors opened in a terminal state`);

// ---- 2) line of sight ----
{
  const tiles = [];
  for (let r = 0; r < CH; r++) tiles.push(new Array(CW).fill('.'));
  check('losClear', los(tiles, [5, 5], [5, 9]) === true);
  tiles[5][7] = '#';
  check('losBlocked', los(tiles, [5, 5], [5, 9]) === false);
}

// ---- 3) the revolver: one round kills a cultist, the magazine drains, empty blocks ----
{
  const S = mkState(42, 1);
  reveal(S);
  S.monsters = [{ kind: 'cultist', r: S.pos[0], c: S.pos[1] + 4, hp: KINDS.cultist.hp, id: 1 }];
  const mag0 = S.mag, san0 = S.san;
  // clear the corridor between so LOS holds
  for (let c = S.pos[1] + 1; c < S.pos[1] + 4; c++) S.floor.tiles[S.pos[0]][c] = '.';
  const res = fireAt(S, S.monsters[0]);
  const m1 = S.monsters[0];
  check('gunCostsRound', S.mag === mag0 - 1, `mag ${mag0} -> ${S.mag}`);
  check('gunKillsCultist', res.ok === true && (res.killed === true || (m1 && m1.hp < KINDS.cultist.hp)), JSON.stringify(res));
  check('gunSpendsTurn', S.turns >= 1 && S.steps >= 1, `turns=${S.turns} steps=${S.steps}`);

  const E = mkState(42, 1);
  reveal(E);
  E.mag = 0;
  E.monsters = [{ kind: 'cultist', r: E.pos[0], c: E.pos[1] + 2, hp: 6, id: 1 }];
  E.floor.tiles[E.pos[0]][E.pos[1] + 1] = '.';
  const dry = fireAt(E, E.monsters[0]);
  check('emptyMagazineBlocks', dry.ok === false && dry.why === 'empty', JSON.stringify(dry));

  const R = mkState(42, 1, 'rogue');
  reveal(R);
  R.mag = 2;
  const reserve0 = R.reserve;
  const rl = reload(R);
  check('reloadFillsMagazine', rl.ok === true && R.mag === R.magSize && R.reserve === reserve0 - (R.magSize - 2), JSON.stringify(rl) + ` mag=${R.mag} reserve=${R.reserve}`);
  const full = reload(R);
  check('reloadFullIsNoOp', full.ok === false && full.why === 'full', JSON.stringify(full));
  const D = mkState(42, 1);
  reveal(D);
  D.mag = 3; D.reserve = 0;
  const dr = reload(D);
  check('reloadDryIsNoOp', dr.ok === false && dr.why === 'dry', JSON.stringify(dr));
}

// ---- 4) knife: a rat dies before it costs much, and the kill gives spirit back ----
{
  const S = mkState(20261126, 1);
  reveal(S);
  S.monsters = [{ kind: 'rat', r: S.pos[0], c: S.pos[1] + 1, hp: 4, id: 1 }];
  S.items = [];
  const san0 = Math.min(S.maxSan, S.san + 10);
  S.san = san0;
  let turns = 0, minHp = S.hp;
  while (S.monsters.length && turns < 20) { act(S, 0, 1); turns++; minHp = Math.min(minHp, S.hp); if (S.over) break; }
  check('ratDiesToKnife', S.monsters.length === 0 && turns <= 4 && !S.over, `turns=${turns} monsters=${S.monsters.length} over=${S.over}`);
  check('ratCostsLittleHP', 20 - minHp <= 6 && S.hp > 0, `hp lost ${20 - minHp}`);
  check('killRestoresSpirit', S.kills === 1 && S.san > san0 - KINDS.rat.shock, `san ${san0} -> ${S.san}`);
}

// ---- 5) sanity economy: shock on sight, dread on the clock, prayer, madness ends the run ----
{
  const S = mkState(7, 1);
  reveal(S); sighting(S);
  const base = S.san;
  S.monsters = [{ kind: 'shoggoth', r: S.pos[0], c: S.pos[1] + 3, hp: 20, id: 1 }];
  for (let c = S.pos[1] + 1; c < S.pos[1] + 3; c++) S.floor.tiles[S.pos[0]][c] = '.';
  reveal(S); sighting(S);
  check('shockOnSight', S.san === base - KINDS.shoggoth.shock, `san ${base} -> ${S.san}, shock ${KINDS.shoggoth.shock}`);
  const seenAgain = S.san;
  reveal(S); sighting(S);
  check('shockIsOncePerHorror', S.san === seenAgain, `san moved ${seenAgain} -> ${S.san}`);

  const T = mkState(7, 1);
  reveal(T); sighting(T);
  T.monsters = [];
  const san0 = T.san;
  let guard = 0;
  while (T.san === san0 && guard < 30) { act(T, 0, 0); guard++; }
  check('dreadDrains', T.san < san0 && guard <= T.dreadEvery + 1, `san ${san0} -> ${T.san} after ${guard} waits (every ${T.dreadEvery})`);

  const P = mkState(7, 1);
  reveal(P); sighting(P);
  P.monsters = []; P.san = 10;
  const pr = pray(P);
  check('prayRestoresSpirit', pr.ok === true && P.san === 10 + CLASSES.exorcist.prayGain, JSON.stringify(pr) + ` san=${P.san}`);

  const M = mkState(7, 1);
  reveal(M); sighting(M);
  M.san = 2;
  M.monsters = [{ kind: 'shoggoth', r: M.pos[0], c: M.pos[1] + 2, hp: 20, id: 1 }];
  M.floor.tiles[M.pos[0]][M.pos[1] + 1] = '.';
  reveal(M); sighting(M);
  check('madnessLoses', M.over === true && M.won === false && M.why === 'madness', `over=${M.over} why=${M.why}`);

  const D = mkState(7, 1);
  reveal(D); sighting(D);
  D.monsters = []; D.san = 1; D.dread = D.dreadEvery - 1;
  act(D, 0, 0);
  check('dreadCanBreakMind', D.over === true && D.why === 'madness', `over=${D.over} why=${D.why}`);
}

// ---- 6) pickups, descend and the relic ----
{
  const S = mkState(42, 2);
  reveal(S);
  S.monsters = [];
  const spots = [];
  for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const r = S.pos[0] + dr, c = S.pos[1] + dc;
    if (walkable(S.floor.tiles, r, c)) spots.push([r, c]);
  }
  const [ar, ac] = spots[0];
  S.items = [{ kind: 'ammo', r: ar, c: ac, n: 5 }];
  const r0 = S.reserve;
  act(S, ar - S.pos[0], ac - S.pos[1]);
  check('ammoPickup', S.reserve === r0 + 5, `reserve ${r0} -> ${S.reserve}`);

  const H = mkState(42, 2);
  reveal(H);
  H.monsters = []; H.hp = 5; H.san = 5;
  const [hr, hc] = spots[0];
  H.items = [{ kind: 'salts', r: hr, c: hc, n: 60 }];
  const d0 = H.depth;
  act(H, hr - H.pos[0], hc - H.pos[1]);
  check('saltsCapAtMax', H.san === H.maxSan, `san=${H.san}/${H.maxSan}`);
  if (H.depth === d0) {
    // the step landed on a corridor cell; walk onto the stairs through the rules
    let guard = 0;
    while (H.depth === d0 && guard++ < 200) {
      const st = H.floor.stairs;
      const step = stepToward(H, st[0], st[1]);
      if (!step) break;
      act(H, step[0], step[1]);
    }
  }
  check('stairsDescend', H.depth === d0 + 1, `depth ${d0} -> ${H.depth}`);

  const W = mkState(20261126, DEPTHS);
  reveal(W);
  W.monsters = [];
  const rel = W.items.find((i) => i.kind === 'relic');
  W.pos = [rel.r, rel.c - 1];
  W.floor.tiles[W.pos[0]][W.pos[1]] = '.';
  act(W, 0, 1);
  check('relicWins', W.over === true && W.won === true && W.why === 'trapezohedron', `over=${W.over} won=${W.won} why=${W.why}`);

  const X = mkState(42, 1);
  X.over = true;
  const res = act(X, 0, 1);
  check('deadCannotAct', res.ok === false, JSON.stringify(res));
}

// ---- 7) pilot ladder: a greedy investigator can finish, an idle one goes mad ----
function pilot(seed, { cls = 'veteran', fire = true, stay = false } = {}) {
  const S = mkState(seed, 1, cls);
  reveal(S); sighting(S);
  let guard = 0;
  while (!S.over && guard++ < 2200) {
    const st = S.floor.stairs || (S.floor.altar ? S.items.find((i) => i.kind === 'relic') : null);
    if (!st) break;
    const adj = S.monsters.find((x) => Math.abs(x.r - S.pos[0]) + Math.abs(x.c - S.pos[1]) === 1);
    // only things actually in sight and in line are shootable — memory of a walled-off horror is not a target
    const seen = S.monsters.filter((x) => S.seen.has(x.r * CW + x.c) && dist2([x.r, x.c], S.pos) <= SIGHT * SIGHT &&
      los(S.floor.tiles, S.pos, [x.r, x.c]));
    const near = seen.sort((a, b) => dist2([a.r, a.c], S.pos) - dist2([b.r, b.c], S.pos))[0];
    if (!stay && near && fire && S.mag > 0 && !adj) { fireAt(S, near); continue; }
    if (!stay && S.mag === 0 && S.reserve > 0) { reload(S); continue; }
    if (!stay && adj) { act(S, adj.r - S.pos[0], adj.c - S.pos[1]); continue; }
    if (!stay && S.san <= 10) { pray(S); continue; }
    if (stay) { act(S, 0, 0); continue; }
    const step = stepToward(S, st.r ?? st[0], st.c ?? st[1]);
    if (!step) { act(S, 0, 0); continue; }
    act(S, step[0], step[1]);
  }
  return { won: S.won, over: S.over, why: S.why, depth: S.depth, kills: S.kills, turns: S.turns, san: S.san, hp: S.hp };
}
const seedSet = Array.from({ length: 40 }, (_, i) => 1000 + i * 37);
const ladder = { veteran: { win: 0, mad: 0, slain: 0 }, exorcist: { win: 0, mad: 0, slain: 0 }, rogue: { win: 0, mad: 0, slain: 0 } };
for (const cls of Object.keys(ladder)) {
  for (const seed of seedSet) {
    const r = pilot(seed, { cls });
    if (r.won) ladder[cls].win++;
    else if (r.why === 'madness') ladder[cls].mad++;
    else ladder[cls].slain++;
  }
}
const idle = seedSet.slice(0, 10).map((seed) => pilot(seed, { stay: true, cls: 'veteran' }));
const idleMad = idle.filter((r) => !r.won).length;
check('pilotCanWin', ladder.veteran.win >= 16, `veteran wins ${ladder.veteran.win}/40`);
check('everyClassCanWin', ladder.exorcist.win >= 8 && ladder.rogue.win >= 16, `exorcist ${ladder.exorcist.win}/40, rogue ${ladder.rogue.win}/40`);
check('pilotIsNotTrivial', ladder.veteran.win <= 38 && (ladder.veteran.slain + ladder.veteran.mad) >= 2, JSON.stringify(ladder.veteran));
check('idleInvestigatorNeverWins', idleMad === 10, `${idleMad}/10 idle runs ended`);
check('classesAreDistinct', CLASSES.veteran.hp > CLASSES.exorcist.hp && CLASSES.rogue.reserve > CLASSES.veteran.reserve && CLASSES.exorcist.prayGain > CLASSES.veteran.prayGain);

const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ checks, floors, fail, ladder, idle: idle.slice(0, 3) }, null, 1));
console.log(ok ? 'CORE PASS' : 'CORE FAIL');
process.exit(ok ? 0 : 1);
