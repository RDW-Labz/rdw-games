#!/usr/bin/env node
// Core test for the Dungeon Crawl port. Slices // >>>CORE straight out of the shipped HTML and
// re-runs the generator, the line-of-sight, the spells, the Orb run and the combat maths on the
// exact functions the browser executes.
// usage: node scripts/crawl-core-test.mjs [path-to-index.html]
import { readFile } from 'node:fs/promises';

const FILE = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/crawl/index.html';
const html = await readFile(FILE, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.log('FAIL no CORE block (check the >>>CORE / <<<CORE markers)'); process.exit(1); }

const core = await import('data:text/javascript;base64,' + Buffer.from(m[1] + `
export { CW, CH, DEPTHS, mulberry32, KINDS, SPECIES, walkable, los, genFloor, mkState, reveal,
  monsterAt, act, cast, quaff, travel, loadFloor, stepToward, nearestTarget, regen };
`).toString('base64'));
const { CW, CH, DEPTHS, KINDS, walkable, los, genFloor, mkState, reveal, monsterAt, act, cast, quaff, travel, loadFloor, stepToward, nearestTarget } = core;

const checks = {};
const fail = [];
const check = (name, ok, detail) => { checks[name] = ok; if (!ok) fail.push(name + (detail ? ' — ' + detail : '')); };

// ---- 1) generation + connectivity over seeds and every depth ----
const seeds = [1, 7, 42, 20261123, 9001, 555];
let floors = 0;
const badReach = [], badAll = [], badOrb = [], startMon = [], itemOff = [];
for (const seed of seeds) {
  for (let depth = 1; depth <= DEPTHS; depth++) {
    const f = genFloor(seed, depth);
    floors++;
    const seen = new Set([f.start[0] * CW + f.start[1]]);
    let frontier = [f.start.slice()], cells = 0;
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
    const target = depth >= DEPTHS ? (f.orb ? { r: f.orb[0], c: f.orb[1] } : null) : { r: f.stairs[0], c: f.stairs[1] };
    if (!target || !seen.has(target.r * CW + target.c)) badReach.push(`${seed}/${depth}`);
    let open = 0;
    for (let r = 0; r < CH; r++) for (let c = 0; c < CW; c++) {
      if (f.tiles[r][c] !== '.') continue;
      if (!seen.has(r * CW + c)) open++;
    }
    if (open) badAll.push(`${seed}/${depth}:${open}`);
    if (f.monsters.some((x) => x.r === f.start[0] && x.c === f.start[1])) startMon.push(`${seed}/${depth}`);
    if (f.items.some((i) => f.tiles[i.r][i.c] === '#')) itemOff.push(`${seed}/${depth}`);
    const orbItems = f.items.filter((i) => i.kind === 'orb');
    const dragons = f.monsters.filter((x) => x.kind === 'dragon');
    if (depth >= DEPTHS) {
      if (orbItems.length !== 1 || dragons.length !== 1 || f.stairs === null) badOrb.push(`${seed}/${depth} orb=${orbItems.length} dragon=${dragons.length} stairs=${JSON.stringify(f.stairs)}`);
    } else if (orbItems.length || dragons.length || f.stairs === null) {
      badOrb.push(`${seed}/${depth} shallow orb/dragon/stairs`);
    }
  }
}
check('floorsGenerated', floors === seeds.length * DEPTHS, `${floors} floors`);
check('stairsAndOrbReachable', badReach.length === 0, badReach.slice(0, 3).join(', '));
check('everyFloorCellConnected', badAll.length === 0, badAll.slice(0, 3).join(', '));
check('noMonsterOnStart', startMon.length === 0, startMon.slice(0, 3).join(', '));
check('itemsOnFloor', itemOff.length === 0, itemOff.slice(0, 3).join(', '));
check('orbAndDragonOnlyOnDepth5', badOrb.length === 0, badOrb.slice(0, 3).join(', '));

// ---- 2) line of sight: an open corridor sees, a wall between does not ----
{
  const tiles = [];
  for (let r = 0; r < CH; r++) tiles.push(new Array(CW).fill('#'));
  for (let c = 1; c < 9; c++) tiles[5][c] = '.';
  check('losOpenCorridor', los(tiles, 5, 1, 5, 8) === true, 'open line blocked');
  tiles[5][4] = '#';
  check('losBlockedByWall', los(tiles, 5, 1, 5, 8) === false, 'wall did not block the line');
}

// ---- 3) melee: a lone rat dies to a fighter in a few turns, costing little hp ----
{
  const S = mkState(20261123, 1, 'human');
  reveal(S);
  S.monsters = [{ kind: 'rat', r: S.pos[0], c: S.pos[1] + 1, hp: KINDS.rat.hp, id: 1 }];
  S.items = [];
  let turns = 0, minHp = S.hp;
  while (S.monsters.length && turns < 40) { act(S, 0, 1); turns++; minHp = Math.min(minHp, S.hp); }
  check('ratDiesToFighter', S.monsters.length === 0 && turns <= 4, `turns=${turns} monsters=${S.monsters.length}`);
  check('ratCostsLittleHp', S.hp > 0 && 22 - minHp <= 8, `hp ${S.hp}, min ${minHp}`);
  check('killAwardsXpAndGold', S.xp >= KINDS.rat.xp && S.kills === 1 && S.gold >= KINDS.rat.gold, `xp=${S.xp} kills=${S.kills}`);
}

// ---- 4) wall blocks a step ----
{
  const S = mkState(20261123, 1, 'human');
  reveal(S);
  S.monsters = []; S.items = [];
  const walls = [];
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const r = S.pos[0] + dr, c = S.pos[1] + dc;
    if (!walkable(S.floor.tiles, r, c)) walls.push([dr, dc]);
  }
  const [dr, dc] = walls[0] || [0, 0];
  const before = S.pos.join(',');
  const res = walls.length ? act(S, dr, dc) : { ok: false, why: 'n/a' };
  check('wallRefusesStep', walls.length === 0 || (res.ok === false && S.pos.join(',') === before), JSON.stringify(res));
}

// ---- 5) spells: cost mp, hit, respect range/los, and never charge when there is no target ----
{
  const S = mkState(20261123, 1, 'elf');
  reveal(S);
  S.items = [];
  S.monsters = [{ kind: 'gnoll', r: S.pos[0], c: S.pos[1] + 2, hp: KINDS.gnoll.hp, id: 1 }];
  S.floor.tiles[S.pos[0]][S.pos[1] + 1] = '.';
  S.floor.tiles[S.pos[0]][S.pos[1] + 2] = '.';
  const mp0 = S.mp, hp0 = S.monsters[0].hp;
  const t = nearestTarget(S);
  check('casterFindsTarget', !!t && t.kind === 'gnoll', JSON.stringify(t && t.kind));
  const r1 = cast(S);
  check('castSpendsMp', r1.ok === true && S.mp === mp0 - S.spell.cost && S.casts === 1, `mp ${mp0} -> ${S.mp} res=${JSON.stringify(r1)}`);
  check('castDamagesTarget', S.monsters.length === 0 || S.monsters[0].hp < hp0, `hp ${hp0} -> ${S.monsters[0] && S.monsters[0].hp}`);

  const B = mkState(20261123, 1, 'elf');
  reveal(B);
  B.items = [];
  B.monsters = [{ kind: 'gnoll', r: B.pos[0], c: B.pos[1] + 2, hp: KINDS.gnoll.hp, id: 1 }];
  B.floor.tiles[B.pos[0]][B.pos[1] + 1] = '#';      // wall between caster and target
  const mpB = B.mp, stepsB = B.steps;
  const r2 = cast(B);
  check('castRefusedThroughWall', r2.ok === false && r2.why === 'no-target' && B.mp === mpB && B.steps === stepsB, JSON.stringify(r2));

  const C = mkState(20261123, 1, 'elf');
  reveal(C);
  C.items = []; C.monsters = [];
  const mpC = C.mp;
  const r3 = cast(C);
  check('castWithoutTargetFree', r3.ok === false && C.mp === mpC && C.steps === 0, JSON.stringify(r3));

  const W = mkState(20261123, 1, 'minotaur');
  check('berserkerHasNoSpell', W.spell === null && cast(W).why === 'no-spell', JSON.stringify(cast(W)));

  const D = mkState(20261123, 1, 'elf');
  reveal(D);
  D.items = [];
  D.monsters = [{ kind: 'gnoll', r: D.pos[0], c: D.pos[1] + 2, hp: 99, id: 1 }];
  D.floor.tiles[D.pos[0]][D.pos[1] + 1] = '.';
  D.mp = 2;
  const r4 = cast(D);
  check('castNeedsMp', r4.ok === false && r4.why === 'mp' && D.mp === 2, JSON.stringify(r4));
}

// ---- 6) potions: heal and cap, refuse at full or empty ----
{
  const S = mkState(20261123, 1, 'human');
  reveal(S);
  S.monsters = []; S.items = [{ kind: 'potion', r: S.pos[0], c: S.pos[1] + 1 }];
  act(S, 0, 1);
  check('potionPickedUp', S.potions === 1, `potions=${S.potions}`);
  S.hp = 10;
  const r = quaff(S);
  check('quaffHeals', r.ok === true && S.hp === 18 && S.potions === 0, `hp=${S.hp} res=${JSON.stringify(r)}`);
  check('quaffRefusedEmpty', quaff(S).why === 'none', JSON.stringify(quaff(S)));
  S.potions = 1; S.hp = S.maxHp;
  check('quaffRefusedFull', quaff(S).why === 'full', JSON.stringify(quaff(S)));
  S.hp = 20; S.potions = 1;
  quaff(S);
  check('quaffCapsAtMax', S.hp === S.maxHp, `hp=${S.hp}/${S.maxHp}`);
}

// ---- 7) rest regen only when nothing is close, and stairs descend ----
{
  const S = mkState(20261123, 1, 'human');
  reveal(S);
  S.monsters = []; S.items = [];
  S.hp = 10;
  for (let i = 0; i < 8; i++) act(S, 0, 0);
  check('restRegenerates', S.hp > 10, `hp=${S.hp} turns=${S.turns}`);

  const N = mkState(20261123, 1, 'human');
  reveal(N);
  N.items = [];
  N.hp = 10;
  N.monsters = [{ kind: 'rat', r: N.pos[0] + 4, c: N.pos[1], hp: 999, id: 1 }];
  const hp0 = N.hp;
  for (let i = 0; i < 8; i++) { N.monsters[0].hp = 999; act(N, 0, 0); }
  check('noRestWithMonsterNear', N.hp <= hp0, `hp ${hp0} -> ${N.hp}`);

  const T = mkState(20261123, 1, 'human');
  reveal(T);
  T.monsters = []; T.items = [];
  const st = T.floor.stairs;
  const step = stepToward(T, st[0], st[1]);
  check('stepTowardReturnsStep', Array.isArray(step) && Math.abs(step[0]) + Math.abs(step[1]) === 1, JSON.stringify(step));
  T.pos = [st[0], st[1] - 1];
  T.floor.tiles[st[0]][st[1] - 1] = '.';
  act(T, 0, 1);
  check('stairsDescend', T.depth === 2, `depth=${T.depth}`);
}

// ---- 8) the Orb run: take it on depth 5, climb to depth 1, leave = win ----
{
  const S = mkState(20261123, DEPTHS, 'minotaur');
  reveal(S);
  S.monsters = []; S.items = S.items.filter((i) => i.kind === 'orb');
  const orb = S.items.find((i) => i.kind === 'orb');
  S.pos = [orb.r, orb.c - 1];
  S.floor.tiles[orb.r][orb.c - 1] = '.';
  const got = act(S, 0, 1);
  check('orbPickedNotWonYet', got.picked === 'orb' && S.hasOrb === true && S.over === false, JSON.stringify({ picked: got.picked, hasOrb: S.hasOrb, over: S.over }));

  S.hp = 400; S.maxHp = 400; S.atk = 40;
  let guard = 0, escaped = false;
  while (!S.over && guard++ < 60) {
    S.monsters = [];
    const st = S.floor.stairs;
    // stand one step from the stairs and walk on
    let placed = false;
    for (const [dr, dc] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const r = st[0] + dr, c = st[1] + dc;
      if (!walkable(S.floor.tiles, r, c)) continue;
      S.pos = [r, c]; placed = true; break;
    }
    if (!placed) break;
    if (onStairs2(S)) { travel(S); continue; }
    act(S, st[0] - S.pos[0], st[1] - S.pos[1]);
    if (S.depth === 1 && S.over) escaped = true;
  }
  function onStairs2(X) { return X.pos[0] === X.floor.stairs[0] && X.pos[1] === X.floor.stairs[1]; }
  check('orbRunEscapes', S.over === true && S.won === true && S.escaped === true, `over=${S.over} won=${S.won} depth=${S.depth} guard=${guard}`);
}

// ---- 9) death ends the run ----
{
  const D = mkState(20261123, 1, 'human', { hp: 2 });
  reveal(D);
  D.items = [];
  D.monsters = [{ kind: 'orc', r: D.pos[0], c: D.pos[1] + 1, hp: KINDS.orc.hp, id: 1 }];
  let t = 0;
  while (!D.over && t < 20) { act(D, 0, 0); t++; }
  check('deathLoses', D.over === true && D.won === false && /slain/.test(D.why), `over=${D.over} why=${D.why || '-'}`);

  const A = mkState(20261123, 1, 'human');
  A.over = true;
  check('deadCannotAct', act(A, 0, 1).ok === false, 'dead player acted');
}

const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ checks, floors, fail }, null, 1));
console.log(ok ? 'CORE PASS' : 'CORE FAIL');
process.exit(ok ? 0 : 1);
