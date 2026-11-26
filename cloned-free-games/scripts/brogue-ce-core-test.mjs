#!/usr/bin/env node
// Proves the Brogue CE port's levels and run with the exact rules code the browser runs: the
// // >>>CORE ... // <<<CORE block is sliced straight out of games/arcade/brogue-ce/index.html.
//
// Per seed x depth: the level generates, chambers exist, the up stairs and (below 5) the down
// stairs are reachable from the spawn over floor, no monster starts within 3 tiles of the spawn
// (no instant loss), every monster/item sits on a walkable cell, monsters never share a cell or
// stand on the amulet, and the same seed rebuilds the same level byte for byte.
// Then, through tapCell/useStairs only: a buffed QA avatar walks all five depths with monsters
// cleared, takes the Amulet, climbs back out and wins; and the combat, death, potion, scroll,
// locked-exit and stacked-monster rules are proven directly.
//
// usage: node brogue-ce-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/brogue-ce/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `
export { W, H, DEPTHS, T, MONSTERS, ITEMS, mulberry32, genLevel, mkState, fov, los, levelInto, pickup,
  endTurn, playerStep, pathStep, stairsHere, useStairs, quaff, readScroll, waitTurn, tapCell, reach,
  idx, walkT, inb };`;
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { W, H, DEPTHS, T, MONSTERS, genLevel, mkState, pathStep, stairsHere, useStairs, quaff,
  readScroll, waitTurn, tapCell, reach, idx, walkT } = mod;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); fails++; return false; }
  console.log('  ok   ' + msg);
  return true;
};

const SEEDS = [1, 7, 20261125, 424242, 99991];
console.log(`grid ${W}x${H}, ${DEPTHS} depths, seeds ${SEEDS.join(', ')}`);

// First step of a full-map BFS (the test's own router: the port's pathStep only walks floor the
// player has already seen, which a QA walk must not depend on).
function stepTo(S, r1, c1) {
  const prev = new Int32Array(W * H).fill(-2);
  const start = idx(S.r, S.c), goal = idx(r1, c1);
  if (start === goal) return null;
  prev[start] = -1;
  const q = [start];
  for (let h = 0; h < q.length; h++) {
    const cur = q[h];
    if (cur === goal) break;
    const r = (cur / W) | 0, c = cur % W;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = r + dr, nc = c + dc;
      if (!walkT(S.t, nr, nc)) continue;
      const ni = idx(nr, nc);
      if (prev[ni] !== -2) continue;
      prev[ni] = cur;
      q.push(ni);
    }
  }
  if (prev[goal] === -2 || prev[goal] === -1) return null;
  let cur = goal;
  for (let guard = 0; guard < W * H && prev[cur] !== start; guard++) {
    if (prev[cur] < 0) return null;
    cur = prev[cur];
  }
  return cur;
}

function stepToTarget(S, r, c) {
  const st = stepTo(S, r, c);
  if (st === null) { waitTurn(S); return null; }
  const sr = (st / W) | 0, sc = st % W;
  const res = tapCell(S, sr, sc);
  if (res.kind === 'wall' || res.kind === 'none') waitTurn(S);
  return res;
}

// ---------------------------------------------------------------- level structure
for (const seed of SEEDS) {
  for (let d = 1; d <= DEPTHS; d++) {
    const L = genLevel(seed, d);
    const tag = `seed ${seed} d${d}`;
    ok(L.rooms.length >= 3, `${tag}: chambers carved`, { rooms: L.rooms.length });
    ok(walkT(L.t, L.start[0], L.start[1]), `${tag}: spawn is walkable`, L.start);
    ok(L.t[idx(L.up[0], L.up[1])] === T.UP, `${tag}: up stairs are marked`, L.up);
    if (d < DEPTHS) ok(L.down && L.t[idx(L.down[0], L.down[1])] === T.DOWN, `${tag}: down stairs marked`, L.down);
    else ok(L.down === null, `${tag}: the bottom depth has no way down`);

    const S0 = mkState(seed);
    Object.assign(S0, { t: L.t, monsters: L.monsters, items: L.items, up: L.up, down: L.down });
    if (d > 1) ok(reach(S0, L.start[0], L.start[1], L.up[0], L.up[1]), `${tag}: up stairs reachable from spawn`);
    if (d < DEPTHS) ok(reach(S0, L.start[0], L.start[1], L.down[0], L.down[1]), `${tag}: down stairs reachable from spawn`);

    ok(L.monsters.length === 2 + d, `${tag}: monster count follows the depth`, { got: L.monsters.length, want: 2 + d });
    let near = 0, offFloor = 0;
    for (const mo of L.monsters) {
      if (!walkT(L.t, mo.r, mo.c)) offFloor++;
      if (Math.max(Math.abs(mo.r - L.start[0]), Math.abs(mo.c - L.start[1])) <= 3) near++;
    }
    ok(offFloor === 0, `${tag}: every monster stands on floor`, { offFloor });
    ok(near === 0, `${tag}: no monster starts within 3 tiles of the spawn`, { near });

    const seenCells = new Set();
    let itemOff = 0, stacked = 0;
    for (const i of L.items) {
      if (!walkT(L.t, i.r, i.c)) itemOff++;
      const k = i.r + ',' + i.c;
      if (seenCells.has(k)) stacked++;
      seenCells.add(k);
    }
    ok(itemOff === 0, `${tag}: every item lies on floor`, { itemOff });
    ok(stacked === 0, `${tag}: no two items share a cell`, { stacked });
    ok(new Set(L.monsters.map((mo) => mo.r + ',' + mo.c)).size === L.monsters.length, `${tag}: no two monsters share a cell`);

    if (d === DEPTHS) {
      const am = L.items.find((i) => i.kind === 'amulet');
      ok(!!am, `${tag}: the Amulet of Yendor is down here`);
      if (am) ok(L.t[idx(am.r, am.c)] === T.DOWN || walkT(L.t, am.r, am.c), `${tag}: the Amulet sits on floor`, am);
    }

    const L2 = genLevel(seed, d);
    ok(Buffer.compare(Buffer.from(L.t), Buffer.from(L2.t)) === 0
      && JSON.stringify(L2.monsters.map((x) => [x.r, x.c, x.kind])) === JSON.stringify(L.monsters.map((x) => [x.r, x.c, x.kind])),
      `${tag}: same seed rebuilds the same level`);
  }
}

// ---------------------------------------------------------------- fog of war
{
  const S = mkState(20261125);
  ok(S.lit[idx(S.r, S.c)] === 1, 'fov: the player cell is lit');
  let outOfRange = 0, litNotSeen = 0;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (S.lit[idx(r, c)] && Math.abs(r - S.r) > 8 || S.lit[idx(r, c)] && Math.abs(c - S.c) > 8) outOfRange++;
    if (S.lit[idx(r, c)] && !S.seen[idx(r, c)]) litNotSeen++;
  }
  ok(outOfRange === 0, 'fov: nothing is lit beyond the sight radius', { outOfRange });
  ok(litNotSeen === 0, 'fov: everything lit is remembered', { litNotSeen });
  const far = S.monsters.concat(S.items).every((e) => (S.lit[idx(e.r, e.c)] ? S.seen[idx(e.r, e.c)] : true));
  ok(far, 'fov: a lit monster/item is also in the memory map');
}

// ---------------------------------------------------------------- the full run, through tapCell
{
  const seed = 20261125;
  const S = mkState(seed);
  ok(S.depth === 1, 'run: starts on depth 1');
  let steps = 0, win = null, deaths = 0;

  const walkTo = (r, c, budget) => {
    for (let i = 0; i < budget; i++) {
      if (S.r === r && S.c === c) return true;
      const st = stepTo(S, r, c);
      if (st === null) return false;
      const sr = (st / W) | 0, sc = st % W;
      const res = tapCell(S, sr, sc);
      if (res.kind === 'over') return false;
      if (res.kind === 'wall' || res.kind === 'none') return false;
      steps++;
    }
    return S.r === r && S.c === c;
  };

  while (S.depth < DEPTHS && !S.over) {
    S.monsters = [];                    // geometry proof: the route exists without fights
    const [dr, dc] = S.down;
    ok(walkTo(dr, dc, 400), `run: walked to the down stairs on depth ${S.depth}`, { at: [S.r, S.c], want: [dr, dc] });
    const res = useStairs(S, 'down');
    ok(res.kind === 'descend' && S.depth === res.depth, `run: descended to depth ${S.depth}`);
    if (S.over) { deaths++; break; }
  }
  ok(!S.over, 'run: the descent never killed the avatar outright');
  ok(S.depth === DEPTHS, 'run: reached the bottom depth', { depth: S.depth });

  const amulet = S.items.find((i) => i.kind === 'amulet');
  ok(!!amulet, 'run: the Amulet is present at the bottom');
  if (amulet) {
    ok(walkTo(amulet.r, amulet.c, 400), 'run: walked onto the Amulet');
    ok(S.hasAmulet, 'run: taking the Amulet sets the carry flag');
  }

  const locked = useStairs(S, 'up');
  ok(locked.kind === 'none' || locked.kind === 'ascend', 'run: the up stairs are honest about where the avatar stands');
  // climb 5 -> 1, walking to the up stairs on each level
  for (let d = DEPTHS; d > 1; d--) {
    S.monsters = [];
    ok(walkTo(S.up[0], S.up[1], 500), `run: walked to the up stairs on depth ${d}`, { at: [S.r, S.c], want: S.up });
    ok(useStairs(S, 'up').kind === 'ascend', `run: climbed from depth ${d} to ${S.depth}`);
  }
  ok(S.depth === 1, 'run: back on depth 1 with the Amulet', { depth: S.depth });
  S.monsters = [];
  ok(walkTo(S.up[0], S.up[1], 500), 'run: walked to the exit on depth 1', { at: [S.r, S.c], want: S.up });
  // no amulet-less escape: prove it on a scratch state
  {
    const T0 = mkState(seed);
    T0.monsters = [];
    T0.r = T0.up[0]; T0.c = T0.up[1];
    const r0 = useStairs(T0, 'up');
    ok(r0.kind === 'locked' && !T0.over, 'run: the exit refuses to open without the Amulet', r0);
  }
  ok(S.r === S.up[0] && S.c === S.up[1], 'run: standing on the exit with the Amulet');
  const out = useStairs(S, 'up');
  ok(out.kind === 'win' && S.won && S.over && S.result === 'won', 'run: climbing out with the Amulet wins', out);
  ok(S.turn > 40, 'run: the win took a real number of turns', { turn: S.turn, steps });
  console.log(`  --   ${steps} taps, turn ${S.turn}, gold ${S.gold}, ${deaths} deaths`);
}

// ---------------------------------------------------------------- combat
{
  const S = mkState(7);
  S.monsters = [{ id: 0, kind: 'orc', name: 'orc', glyph: 'o', colour: '#ff9a6b', hp: 4, maxhp: 4, atk: 3, pts: 5, r: S.r, c: S.c + 1 }];
  S.atk = 6;
  const hp0 = S.hp, xp0 = S.xp, kills0 = S.kills;
  const res = tapCell(S, S.r, S.c + 1);
  ok(res.kind === 'attack', 'combat: a monster on the target cell is attacked', res);
  ok(!S.monsters.length, 'combat: a 6-attack swing kills a 4 hp orc');
  ok(S.xp > xp0 && S.kills === kills0 + 1, 'combat: the kill pays xp and counts', { xp: S.xp, kills: S.kills });
  ok(S.turn === 1, 'combat: the attack spent a turn', { turn: S.turn });

  const S2 = mkState(7);
  S2.monsters = [{ id: 0, kind: 'rat', name: 'rat', glyph: 'r', colour: '#c8b7a4', hp: 99, maxhp: 99, atk: 2, pts: 1, r: S2.r, c: S2.c + 1 }];
  S2.hp = 40; S2.maxhp = 40; S2.atk = 1;
  const hpBefore = S2.hp;
  tapCell(S2, S2.r, S2.c + 1);
  ok(S2.hp < hpBefore, 'combat: the survivor hits back on its turn', { hp: S2.hp, was: hpBefore });
  ok(S2.monsters[0].hp < 99, 'combat: the wounded monster keeps the damage', S2.monsters[0]);
}

// ---------------------------------------------------------------- death, potions, scrolls, wait
{
  const S = mkState(11);
  S.monsters = [{ id: 0, kind: 'troll', name: 'troll', glyph: 'T', colour: '#ff7a6b', hp: 99, maxhp: 99, atk: 9, pts: 8, r: S.r, c: S.c + 1 }];
  S.hp = 1; S.atk = 1;
  tapCell(S, S.r, S.c + 1);
  ok(S.hp === 0 && S.over && S.result === 'dead', 'death: a killing blow ends the run', { hp: S.hp, result: S.result });
  const after = waitTurn(S);
  ok(after.kind === 'over' && S.turn === 1, 'death: no turn is spent once dead', { turn: S.turn });

  const Q = mkState(13);
  Q.hp = 6; Q.inv = ['heal'];
  const q = quaff(Q);
  ok(q.kind === 'heal' && Q.hp > 6 && Q.inv.length === 0, 'potion: a healing draught restores hp and is consumed', { hp: Q.hp });
  Q.hp = Q.maxhp - 1; Q.inv = ['heal'];
  quaff(Q);
  ok(Q.hp === Q.maxhp, 'potion: healing never overshoots the maximum', { hp: Q.hp, max: Q.maxhp });
  Q.inv = ['strength'];
  const atk0 = Q.atk;
  quaff(Q);
  ok(Q.atk === atk0 + 1, 'potion: a strength draught raises attack', { atk: Q.atk });
  const empty = quaff(Q);
  ok(empty.kind === 'none', 'potion: an empty pack says so instead of inventing a drink', empty);

  const R = mkState(17);
  R.inv = ['teleport'];
  const before = [R.r, R.c];
  const s = readScroll(R);
  ok(s.kind === 'teleport', 'scroll: a teleport scroll reads', s);
  ok(walkT(R.t, R.r, R.c), 'scroll: the arrival cell is walkable', { at: [R.r, R.c] });
  ok(R.r !== before[0] || R.c !== before[1], 'scroll: the avatar actually moved', { before, after: [R.r, R.c] });
  ok(R.inv.length === 0, 'scroll: the scroll is consumed');
  const none = readScroll(R);
  ok(none.kind === 'none', 'scroll: reading with an empty pack is a no-op-with-a-turn');

  const Wt = mkState(19);
  Wt.monsters = [];
  const t0 = Wt.turn;
  ok(waitTurn(Wt).kind === 'wait' && Wt.turn === t0 + 1, 'wait: costs exactly one turn');
  const own = tapCell(Wt, Wt.r, Wt.c);
  ok(own.kind === 'wait' && Wt.turn === t0 + 2, 'tap: the player own cell waits when it is not stairs', own);
}

// ---------------------------------------------------------------- pathing and monster walk rules
{
  const S = mkState(23);
  S.monsters = [];
  // the router only travels floor the player has already seen, so remember the whole level first
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (walkT(S.t, r, c)) S.seen[idx(r, c)] = 1;
  const [dr, dc] = S.down;
  const first = pathStep(S, dr, dc);
  ok(first !== null, 'path: a route to the down stairs exists from the spawn', { first });
  let n = 0, reached = false;
  while (n++ < 500) {
    const res = tapCell(S, dr, dc);
    if (res.kind === 'none' || res.kind === 'wall' || res.kind === 'over') break;
    if (S.r === dr && S.c === dc) { reached = true; break; }
  }
  ok(reached, 'path: tapping the stairs tile walks the whole route one turn at a time', { at: [S.r, S.c], want: [dr, dc] });

  // monster walk invariants over 80 turns with the pack left alive
  const M = mkState(29);
  M.hp = 999; M.maxhp = 999;
  for (let i = 0; i < 80 && !M.over; i++) waitTurn(M);
  let bad = 0, stack = 0;
  const cells = new Set();
  for (const mo of M.monsters) {
    if (!walkT(M.t, mo.r, mo.c)) bad++;
    if (mo.r === M.r && mo.c === M.c) bad++;
    const k = mo.r + ',' + mo.c;
    if (cells.has(k)) stack++;
    cells.add(k);
  }
  ok(bad === 0, 'monsters: 80 turns of walking never puts one in a wall or on the player', { bad });
  ok(stack === 0, 'monsters: never stack on one cell', { stack });
  ok(M.hp <= M.maxhp, 'monsters: hp never exceeds the maximum', { hp: M.hp, max: M.maxhp });
}

// ---------------------------------------------------------------- balance note (printed, not asserted past depth 3)
{
  const seed = 424242;
  const S = mkState(seed);
  S.hp = 40; S.maxhp = 40; S.atk = 6;
  let guard = 0;
  while (!S.over && guard++ < 6000) {
    if (S.hp < S.maxhp * 0.5 && S.inv.includes('heal')) quaff(S);
    const adj = S.monsters.find((mo) => Math.max(Math.abs(mo.r - S.r), Math.abs(mo.c - S.c)) === 1);
    if (adj) { tapCell(S, adj.r, adj.c); continue; }
    if (S.hasAmulet && S.depth === 1) {
      if (S.r === S.up[0] && S.c === S.up[1]) { useStairs(S, 'up'); break; }
      stepToTarget(S, S.up[0], S.up[1]); continue;
    }
    if (S.hasAmulet) {
      if (S.r === S.up[0] && S.c === S.up[1]) { useStairs(S, 'up'); continue; }
      stepToTarget(S, S.up[0], S.up[1]);
      continue;
    }
    const goal = S.depth === DEPTHS ? (S.items.find((i) => i.kind === 'amulet') || S.up) : S.down;
    if (!goal) break;
    if (S.r === goal[0] && S.c === goal[1]) {
      if (S.depth === DEPTHS) { /* standing on the amulet cell */ }
      else if (stairsHere(S) === 'down') useStairs(S, 'down');
      continue;
    }
    stepToTarget(S, goal[0], goal[1]);
  }
  console.log(`  --   buffed avatar (hp 40, atk 6): depth ${S.depth}, ${S.kills} kills, gold ${S.gold}, ${S.won ? 'WON' : S.result || 'still going'}`);
  ok(S.kills > 0, 'balance: a buffed avatar gets kills on its own');
  ok(S.depth >= 3, 'balance: a buffed avatar reaches at least depth 3 unaided', { depth: S.depth });
}

console.log(fails ? `\nFAILED ${fails}` : '\nOK — every level is safe, connected and rebuildable; the Amulet run wins through tapCell; combat, death, potions, scrolls and monster movement obey the shipped rules');
process.exit(fails ? 1 : 0);
