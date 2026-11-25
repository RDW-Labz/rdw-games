#!/usr/bin/env node
// Core test for the Andor's Trail port. Slices the // >>>CORE block out of the shipped page and
// replays the whole quest on the exact functions the browser runs: the world graph, the cave
// generator, the ward on the Ember Stone, combat, and a real pathfinding pilot that must walk the
// quest end to end. A quest you cannot finish is a broken port, so the pilot's win IS the check.
// usage: node scripts/andors-core-test.mjs [path-to-index.html]
import { readFile } from 'node:fs/promises';

const FILE = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/andors-trail/index.html';
const html = await readFile(FILE, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.log('FAIL no CORE block (check the >>>CORE / <<<CORE markers)'); process.exit(1); }

const core = await import('data:text/javascript;base64,' + Buffer.from(m[1] + `
export { WORLD, WW, WH, CAVE_W, CAVE_H, SOLID, START, ELDER, CAVE_MOUTH, KINDS, WORLD_MOBS, WORLD_ITEMS,
  mulberry32, gridOf, walkable, genCave, mkState, reveal, isSeen, mobAt, itemAt, levelUp, killMob, pickUp,
  enterCave, leaveCave, talk, mobsTurn, act, quaff, stepToward, questLine };
`).toString('base64'));
const C = core;

const checks = {};
const fail = [];
const check = (name, ok, detail) => { checks[name] = !!ok; if (!ok) fail.push(name + (detail ? ' — ' + detail : '')); };

// ---------- 1) the authored world is one connected piece ----------
const gridW = C.gridOf(C.WORLD);
const bfsWorld = () => {
  const seen = new Set([C.START[0] * 1000 + C.START[1]]);
  let frontier = [C.START];
  while (frontier.length) {
    const next = [];
    for (const [r, c] of frontier) {
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nr = r + dr, nc = c + dc;
        if (!C.walkable(gridW, nr, nc)) continue;
        const k = nr * 1000 + nc;
        if (seen.has(k)) continue;
        seen.add(k); next.push([nr, nc]);
      }
    }
    frontier = next;
  }
  return seen;
};
const reach = bfsWorld();
let openCells = 0, strays = [];
for (let r = 0; r < C.WH; r++) for (let c = 0; c < C.WW; c++) {
  if (!C.walkable(gridW, r, c)) continue;
  openCells++;
  if (!reach.has(r * 1000 + c)) strays.push([r, c]);
}
check('worldRagged', C.WORLD.every((row) => row.length === C.WW), C.WORLD.map((r) => r.length).join(','));
check('worldConnected', strays.length === 0, `${strays.length} unreachable cells: ${JSON.stringify(strays.slice(0, 4))} open=${openCells}`);
check('elderReachable', reach.has(C.ELDER[0] * 1000 + C.ELDER[1]), JSON.stringify(C.ELDER));
check('caveMouthReachable', reach.has(C.CAVE_MOUTH[0] * 1000 + C.CAVE_MOUTH[1]), JSON.stringify(C.CAVE_MOUTH));

const placedBad = [];
for (const [kind, r, c] of C.WORLD_MOBS) {
  if (!C.walkable(gridW, r, c) || !reach.has(r * 1000 + c)) placedBad.push(`mob ${kind}@${r},${c}`);
}
for (const [kind, r, c] of C.WORLD_ITEMS) {
  if (!C.walkable(gridW, r, c) || !reach.has(r * 1000 + c)) placedBad.push(`item ${kind}@${r},${c}`);
}
check('placementsOnOpenReachableGround', placedBad.length === 0, placedBad.join(' '));

const nearStart = C.WORLD_MOBS.filter(([, r, c]) => Math.abs(r - C.START[0]) + Math.abs(c - C.START[1]) < 4);
check('noAmbushAtBoot', nearStart.length === 0, JSON.stringify(nearStart));
check('worldHasQuestItem', C.WORLD_ITEMS.some((i) => i[0] === 'sword') && C.WORLD_ITEMS.some((i) => i[0] === 'potion'), 'sword+potion placed');

// ---------- 2) the cave generator: connected, warded stone, no mob on the entry ----------
const seeds = [1, 7, 42, 20261124, 9001, 555, 1234567];
const caveBad = [], exitBad = [], relicBad = [], mobBad = [], entryMob = [];
let caveRooms = 0, caves = 0;
for (const seed of seeds) {
  for (let k = 0; k < 4; k++) {
    const cave = C.genCave(seed + k * 13);
    caves++;
    caveRooms = Math.max(caveRooms, cave.rooms.length);
    const seen = new Set([cave.entry[0] * 1000 + cave.entry[1]]);
    let frontier = [cave.entry];
    while (frontier.length) {
      const next = [];
      for (const [r, c] of frontier) {
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nr = r + dr, nc = c + dc;
          if (!C.walkable(cave.tiles, nr, nc)) continue;
          const kk = nr * 1000 + nc;
          if (seen.has(kk)) continue;
          seen.add(kk); next.push([nr, nc]);
        }
      }
      frontier = next;
    }
    let open = 0;
    for (let r = 0; r < C.CAVE_H; r++) for (let c = 0; c < C.CAVE_W; c++) if (C.walkable(cave.tiles, r, c)) open++;
    if (seen.size !== open) caveBad.push(`${seed + k * 13}:${seen.size}/${open}`);
    const man = Math.abs(cave.exit[0] - cave.entry[0]) + Math.abs(cave.exit[1] - cave.entry[1]);
    // the exit is a deliberate alcove: two steps off the entry, and a dead end so no path inward
    // can cross it (an exit *beside* the entry bounced the player in and out forever)
    let exitOpen = 0;
    for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      if (C.walkable(cave.tiles, cave.exit[0] + dr, cave.exit[1] + dc)) exitOpen++;
    }
    if (man !== 2 || exitOpen !== 1) exitBad.push(`${seed}+${k * 13}:dist${man}/open${exitOpen}`);
    if (!seen.has(cave.relic[0] * 1000 + cave.relic[1])) relicBad.push(String(seed));
    const shade = cave.mobs.filter((mb) => mb.kind === 'shade');
    if (shade.length !== 1 || shade[0].r !== cave.relic[0] || shade[0].c !== cave.relic[1]) relicBad.push(`shade@${seed}`);
    if (cave.mobs.some((mb) => !C.walkable(cave.tiles, mb.r, mb.c))) mobBad.push(String(seed));
    if (cave.mobs.some((mb) => mb.r === cave.entry[0] && mb.c === cave.entry[1])) entryMob.push(String(seed));
    if (!cave.items.some((i) => i.kind === 'stone')) relicBad.push(`stone@${seed}`);
  }
}
check('caveConnected', caveBad.length === 0, caveBad.slice(0, 3).join(' '));
check('caveExitBesideEntry', exitBad.length === 0, exitBad.slice(0, 3).join(' '));
check('caveRelicGuarded', relicBad.length === 0, relicBad.slice(0, 3).join(' '));
check('caveMobsOnFloor', mobBad.length === 0, mobBad.slice(0, 3).join(' '));
check('caveEntryClear', entryMob.length === 0, entryMob.slice(0, 3).join(' '));

// ---------- 3) the rules: attack, ward, quest stages, death ----------
const S0 = C.mkState(20261124);
check('bootState', S0.map === 'world' && S0.hp === 24 && S0.quest === 0 && !S0.stone && !S0.over, JSON.stringify({ m: S0.map, hp: S0.hp, q: S0.quest }));

// the shade's ward: standing on the stone while the shade lives takes nothing
{
  const S = C.mkState(20261124);
  const rel = S.cave.relic;
  S.map = 'cave';
  S.pos = [rel[0], rel[1]];
  const got = C.pickUp(S);
  check('wardHoldsStone', got === null && S.stone === false && /ward/i.test(S.notice), `got=${got} notice=${S.notice}`);
}

// killing the shade and stepping back on takes the stone and advances the quest
{
  const S = C.mkState(20261124);
  const rel = S.cave.relic;
  S.map = 'cave';
  S.pos = [rel[0], rel[1] - 1];
  let guard = 0;
  while (S.mobs.cave.some((m) => m.kind === 'shade') && guard++ < 40) {
    S.hp = S.maxHp;                       // isolate the pickup rule from the combat clock
    C.act(S, 0, 1);
  }
  const dead = !S.mobs.cave.some((m) => m.kind === 'shade');
  C.act(S, 0, 1);
  check('shadeDies', dead, `guard=${guard} hp=${S.hp}`);
  check('stoneTakenAfterWard', S.stone === true && S.quest === 2, `stone=${S.stone} quest=${S.quest}`);
  check('stoneIsQuestItem', /elara|back/i.test(C.questLine(S)), C.questLine(S));
}

// quest stages: ask, then hand over
{
  const S = C.mkState(20261124);
  S.pos = [C.ELDER[0] + 1, C.ELDER[1]];
  const r1 = C.act(S, -1, 0);
  check('talkAcceptsQuest', r1.ok && r1.talk === 'quest' && S.quest === 1, JSON.stringify(r1));
  const r2 = C.act(S, -1, 0);
  check('talkRemindsWithoutStone', r2.talk === 'remind' && S.over === false, JSON.stringify(r2));
  S.stone = true; S.quest = 2;
  const r3 = C.act(S, -1, 0);
  check('stoneWinsQuest', r3.talk === 'done' && S.over === true && S.won === true && S.quest === 3, JSON.stringify({ ...r3, over: S.over, won: S.won }));
  // a dead traveller cannot act
  const before = S.steps;
  const r4 = C.act(S, 0, 1);
  check('deadCannotAct', r4.ok === false && S.steps === before, JSON.stringify(r4));
}

// waiting forever never wins: the win needs the stone
{
  const S = C.mkState(7);
  let t = 0;
  while (!S.over && t < 300) { C.act(S, 0, 0); t++; }
  check('noWinWithoutStone', S.won === false, `turns=${t} over=${S.over} why=${S.why}`);
}

// a wolf parked next to a 3 hp traveller kills them, and the loss names its cause
{
  const S = C.mkState(42, { hp: 3 });
  S.items.world = [];
  S.mobs.world = [{ kind: 'wolf', r: S.pos[0], c: S.pos[1] + 1, hp: 6, id: 1 }];
  let t = 0;
  while (!S.over && t < 20) { C.act(S, 0, 0); t++; }
  check('deathLoses', S.over === true && S.won === false && /slain by a wolf/i.test(S.why), `over=${S.over} why=${S.why}`);
}

// a sword is worth three attack, a kill pays xp, and xp levels the traveller up
{
  const S = C.mkState(20261124);
  const sw = S.items.world.find((i) => i.kind === 'sword');
  check('swordPlaced', !!sw, JSON.stringify(S.items.world.map((i) => i.kind)));
  const atk0 = S.atk;
  S.pos = [sw.r, sw.c];
  C.pickUp(S);
  check('swordRaisesAtk', S.sword === true && S.atk === atk0 + 3, `atk ${atk0} -> ${S.atk}`);
  const xp0 = S.xp, lvl0 = S.level;
  C.killMob(S, { ...S.mobs.world.find((m) => m.kind === 'bandit') });
  check('killPaysXp', S.xp > xp0, `xp ${xp0} -> ${S.xp}`);
  S.xp = 400;
  C.levelUp(S);
  check('xpLevelsUp', S.level > lvl0 && S.atk > atk0 + 3, `level ${lvl0} -> ${S.level} atk ${S.atk}`);
}

// ---------- 4) the pilot: walk the whole quest with the shipped rules ----------
const man = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
const adj = (a, b) => man(a, b) === 1;
const dirTo = (S, t) => [Math.sign(t[0] - S.pos[0]), Math.sign(t[1] - S.pos[1])];

function stepOnce(S, target) {
  if (adj(S.pos, target)) { const r = C.act(S, ...dirTo(S, target)); return r.ok; }
  const s = C.stepToward(S, target[0], target[1]);
  if (!s) return false;
  return C.act(S, s[0], s[1]).ok;
}
// the elder's own cell is not walkable, so approach a neighbour of hers
function nearElder(S) {
  let best = null, bd = 1e9;
  for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const cell = [C.ELDER[0] + dr, C.ELDER[1] + dc];
    if (!C.walkable(C.gridOf(C.WORLD), cell[0], cell[1])) continue;
    const d = man(S.pos, cell);
    if (d < bd) { bd = d; best = cell; }
  }
  return best ? stepOnce(S, best) : false;
}
// nearest adjacent monster, so the pilot fights what is already chipping at it
function adjacentMob(S) {
  return S.mobs[S.map].find((m) => adj(S.pos, [m.r, m.c])) || null;
}

function pilot(seed, { takeSword = true, maxTurns = 1500 } = {}) {
  const S = C.mkState(seed);
  let turns = 0, minHp = S.hp, drank = 0, stuck = 0;
  const trace = [];
  while (!S.over && turns < maxTurns) {
    turns++;
    minHp = Math.min(minHp, S.hp);
    if (S.hp <= 12 && S.potions > 0) { C.quaff(S); drank++; continue; }
    const mob = adjacentMob(S);
    let progressed = false;
    if (S.quest === 0) {
      progressed = adj(S.pos, C.ELDER) ? C.act(S, ...dirTo(S, C.ELDER)).ok : nearElder(S);
    } else if (!S.stone) {
      const sword = takeSword && !S.sword ? S.items.world.find((i) => i.kind === 'sword') : null;
      if (S.map === 'world' && sword) progressed = stepOnce(S, [sword.r, sword.c]);
      else if (S.map === 'world') progressed = stepOnce(S, C.CAVE_MOUTH);
      else {
        const shade = S.mobs.cave.find((mb) => mb.kind === 'shade');
        if (mob) progressed = C.act(S, ...dirTo(S, [mob.r, mob.c])).ok;
        else if (shade) progressed = stepOnce(S, [shade.r, shade.c]);
        else progressed = stepOnce(S, S.cave.relic);
      }
    } else {
      if (S.map === 'cave') progressed = stepOnce(S, S.cave.exit);
      else progressed = adj(S.pos, C.ELDER) ? C.act(S, ...dirTo(S, C.ELDER)).ok : nearElder(S);
    }
    if (!progressed) {
      if (mob) C.act(S, ...dirTo(S, [mob.r, mob.c]));
      else { C.act(S, 0, 0); stuck++; }
    }
    if (turns % 40 === 0) trace.push(`${turns}:${S.map}:q${S.quest}:hp${S.hp}`);
  }
  minHp = Math.min(minHp, S.hp);
  return { S, turns, minHp, drank, stuck, trace };
}

const runs = seeds.map((s) => ({ seed: s, ...pilot(s) }));
const lostRuns = runs.filter((r) => !(r.S.over && r.S.won));
check('pilotWalksTheQuest', lostRuns.length === 0,
  lostRuns.map((r) => `${r.seed}: q${r.S.quest} map${r.S.map} hp${r.S.hp} why${r.S.why || '-'} turns${r.turns}`).join(' | '));
check('pilotFightsTheShade', runs.every((r) => r.S.kills >= 1), runs.map((r) => r.S.kills).join(','));
check('pilotSurvives', runs.every((r) => r.minHp > 0), runs.map((r) => r.minHp).join(','));
check('pilotWithinBudget', runs.every((r) => r.turns < 1400), runs.map((r) => r.turns).join(','));

// the sword is load-bearing: without it the same pilot loses or barely scrapes through
const noSword = seeds.map((s) => pilot(s, { takeSword: false }));
const noSwordWins = noSword.filter((r) => r.S.over && r.S.won).length;
const swordMinHp = Math.min(...runs.map((r) => r.minHp));
const noSwordMinHp = Math.min(...noSword.map((r) => r.minHp));

const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify({
  checks, fail,
  world: { openCells, reachable: reach.size, placements: C.WORLD_MOBS.length + C.WORLD_ITEMS.length },
  cave: { caves, caveRooms },
  runs: runs.map((r) => ({ seed: r.seed, turns: r.turns, hp: r.S.hp, kills: r.S.kills, minHp: r.minHp, drank: r.drank, stuck: r.stuck, gold: r.S.gold, level: r.S.level })),
  noSword: { wins: `${noSwordWins}/${noSword.length}`, minHp: noSwordMinHp, detail: noSword.map((r) => ({ seed: r.seed, won: r.S.won, hp: r.S.hp, why: r.S.why, turns: r.turns })) },
  swordMinHp,
}, null, 1));
console.log(ok ? 'CORE PASS' : 'CORE FAIL');
process.exit(ok ? 0 : 1);
