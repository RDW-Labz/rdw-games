#!/usr/bin/env node
// Core test for the Shattered Descent port. Slices the // >>>CORE block straight out of the
// shipped HTML and re-runs the generator, the flood fill and the combat maths on the same
// functions the browser executes — so "the stairs are reachable" and "a rat dies before it
// kills you" are measured against shipped code, not a copy of it.
// usage: node scripts/shattered-descent-core-test.mjs [path-to-index.html]
import { readFile } from 'node:fs/promises';

const FILE = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/shattered-descent/index.html';
const html = await readFile(FILE, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.log('FAIL no CORE block (check the >>>CORE / <<<CORE markers)'); process.exit(1); }

const core = await import('data:text/javascript;base64,' + Buffer.from(m[1] + `
export { CW, CH, mulberry32, KINDS, walkable, genFloor, mkState, reveal, monsterAt, act, descend, stepToward };`
).toString('base64'));
const { CW, CH, walkable, genFloor, mkState, reveal, monsterAt, act, stepToward } = core;

const checks = {};
const fail = [];
const check = (name, ok, detail) => { checks[name] = ok; if (!ok) fail.push(name + (detail ? ' — ' + detail : '')); };

// ---- 1) generation + connectivity over seeds and depths ----
const seeds = [1, 7, 42, 20261121, 9001, 555];
let floors = 0, badReach = [], badAll = [], startMon = 0, itemOff = 0, amuletBad = 0;
for (const seed of seeds) {
  for (let depth = 1; depth <= 10; depth++) {
    const f = genFloor(seed, depth);
    floors++;
    // flood fill from the start room
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
    const target = depth >= 10 ? f.items.find((i) => i.kind === 'amulet') : { r: f.stairs[0], c: f.stairs[1] };
    if (!target || !seen.has(target.r * CW + target.c)) badReach.push(`${seed}/${depth}`);
    let open = 0;
    for (let r = 0; r < CH; r++) for (let c = 0; c < CW; c++) if (f.tiles[r][c] !== '.') continue; else if (!seen.has(r * CW + c)) open++;
    if (open) badAll.push(`${seed}/${depth}:${open}`);
    if (f.monsters.some((x) => x.r === f.start[0] && x.c === f.start[1])) startMon++;
    if (f.items.some((i) => f.tiles[i.r][i.c] === '#')) itemOff++;
    if (depth >= 10) {
      const am = f.items.find((i) => i.kind === 'amulet');
      if (!am || f.stairs !== null) amuletBad++;
    } else if (f.stairs === null) amuletBad++;
  }
}
check('floorsGenerated', floors === 60, `${floors} floors`);
check('stairsReachable', badReach.length === 0, badReach.slice(0, 3).join(', '));
check('everyFloorCellConnected', badAll.length === 0, badAll.slice(0, 3).join(', '));
check('noMonsterOnStart', startMon === 0, `${startMon} floors opened with a monster on the start cell`);
check('itemsOnFloor', itemOff === 0, `${itemOff} items on a wall`);
check('amuletOnDepth10Only', amuletBad === 0, `${amuletBad} bad amulet/stairs floors`);

// ---- 2) combat: a lone rat must die before it takes more than 6 hp ----
{
  const S = mkState(20261121, 1, { hp: 20, atk: 3 });
  reveal(S);
  S.monsters = [{ kind: 'rat', r: S.pos[0], c: S.pos[1] + 1, hp: 4, id: 1 }];
  S.items = [];
  let turns = 0, minHp = S.hp;
  while (S.monsters.length && turns < 40) { act(S, 0, 1); turns++; minHp = Math.min(minHp, S.hp); }
  const lost = 20 - minHp;
  check('ratDiesToPlayer', S.monsters.length === 0 && turns <= 3, `turns=${turns} monsters=${S.monsters.length}`);
  check('ratCostsLittleHP', lost <= 6 && S.hp > 0, `hp lost ${lost}, hp ${S.hp}`);
  check('killAwardsXP', S.xp >= 2 && S.kills === 1, `xp=${S.xp} kills=${S.kills}`);
}

// ---- 3) potion heals and caps at max ----
{
  const S = mkState(42, 1, { hp: 8, maxHp: 20 });
  reveal(S);
  S.monsters = []; S.items = [{ kind: 'potion', r: S.pos[0], c: S.pos[1] + 1 }];
  const before = S.hp;
  act(S, 0, 1);
  check('potionHeals', S.hp === Math.min(S.maxHp, before + 8) && S.potions === 1, `hp ${before} -> ${S.hp}`);
  const T = mkState(42, 1, { hp: 19, maxHp: 20 });
  reveal(T); T.monsters = []; T.items = [{ kind: 'potion', r: T.pos[0], c: T.pos[1] + 1 }];
  act(T, 0, 1);
  check('potionCapsAtMax', T.hp === T.maxHp, `hp=${T.hp}`);
}

// ---- 4) the amulet wins, death loses ----
{
  const S = mkState(20261121, 10);
  reveal(S);
  S.monsters = [];
  const am = S.items.find((i) => i.kind === 'amulet');
  S.pos = [am.r, am.c - 1];
  S.floor.tiles[S.pos[0]][S.pos[1]] = '.';
  act(S, 0, 1);
  check('amuletWins', S.over === true && S.won === true && S.why === 'amulet', `over=${S.over} won=${S.won} why=${S.why || '-'}`);

  const D = mkState(20261121, 1, { hp: 2 });
  reveal(D);
  D.items = [];
  D.monsters = [{ kind: 'slime', r: D.pos[0], c: D.pos[1] + 1, hp: 11, id: 1 }];
  let t = 0;
  while (!D.over && t < 20) { act(D, 0, 0); t++; }
  check('deathLoses', D.over === true && D.won === false && /slain/.test(D.why), `over=${D.over} why=${D.why || '-'}`);

  const A = mkState(20261121, 1, { hp: 20 });
  A.over = true;
  const res = act(A, 0, 1);
  check('deadCannotAct', res.ok === false, `res=${JSON.stringify(res)}`);
}

// ---- 5) stepping onto the stairs descends a floor ----
{
  const S = mkState(20261121, 1);
  reveal(S);
  S.monsters = [];
  const st = S.floor.stairs;
  const step = stepToward(S, st[0], st[1]);
  check('stepTowardReturnsStep', Array.isArray(step) && Math.abs(step[0]) + Math.abs(step[1]) === 1, JSON.stringify(step));
  S.pos = [st[0], st[1] - 1];
  S.floor.tiles[st[0]][st[1] - 1] = '.';
  const d0 = S.depth;
  act(S, 0, 1);
  check('stairsDescend', S.depth === d0 + 1, `depth ${d0} -> ${S.depth}`);
  check('stairsCostTurns', S.steps >= 1 && S.over === false, `steps=${S.steps}`);
}

const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ checks, floors, fail }, null, 1));
console.log(ok ? 'CORE PASS' : 'CORE FAIL');
process.exit(ok ? 0 : 1);
