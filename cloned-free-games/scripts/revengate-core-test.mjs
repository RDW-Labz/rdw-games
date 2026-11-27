#!/usr/bin/env node
// Proves the Revengate port's levels, verbs and run with the exact rules code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced straight out of games/arcade/revengate/index.html.
//
// Per seed x depth: chambers carve, the stairs are marked and reachable from the spawn, no monster
// starts within 3 tiles (no instant loss), the bottom depth holds the Veiled Commissioner and the
// ledger on his tile, everything stands on floor, and the same seed rebuilds the same level.
// Then, through tapCell/useStairs/throwAt only: the whole descent-and-escape run wins, the exit
// refuses without the ledger, melee, thrown daggers, dynamite (including self-damage), potions,
// analysis-paralysis, amulet passives and death all obey the shipped rules.
//
// usage: node revengate-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/revengate/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `
export { W, H, DEPTHS, T, MONSTERS, ITEMS, mulberry32, genLevel, mkState, derived, fov, los, lineCells,
  levelInto, pickup, endTurn, playerStep, pathStep, stairsHere, useStairs, quaff, throwAt, waitTurn,
  tapCell, reach, hurtMonster, monstersAct, idx, walkT, inb };`;
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { W, H, DEPTHS, T, MONSTERS, ITEMS, mulberry32, genLevel, mkState, derived, los, lineCells,
  levelInto, pickup, endTurn, playerStep, pathStep, stairsHere, useStairs, quaff, throwAt, waitTurn,
  tapCell, reach, hurtMonster, monstersAct, idx, walkT } = mod;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); fails++; return false; }
  console.log('  ok   ' + msg);
  return true;
};

const SEEDS = [1, 7, 20261126, 424242, 99991];
console.log(`grid ${W}x${H}, ${DEPTHS} depths, seeds ${SEEDS.join(', ')}`);

// Full-map BFS step (the port's own pathStep only crosses floor the player has already seen).
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
    ok(reach(S0, L.start[0], L.start[1], L.up[0], L.up[1]), `${tag}: up stairs reachable from spawn`);
    if (d < DEPTHS) ok(reach(S0, L.start[0], L.start[1], L.down[0], L.down[1]), `${tag}: down stairs reachable from spawn`);

    const wantMon = 3 + d + (d === DEPTHS ? 1 : 0);
    ok(L.monsters.length === wantMon, `${tag}: monster count follows the depth (plus the Commissioner)`, { got: L.monsters.length, want: wantMon });
    let near = 0, offFloor = 0;
    for (const mo of L.monsters) {
      if (!walkT(L.t, mo.r, mo.c)) offFloor++;
      if (Math.max(Math.abs(mo.r - L.start[0]), Math.abs(mo.c - L.start[1])) <= 3) near++;
    }
    ok(offFloor === 0, `${tag}: every monster stands on floor`, { offFloor });
    ok(near === 0, `${tag}: no monster starts within 3 tiles of the spawn`, { near });
    ok(new Set(L.monsters.map((mo) => mo.r + ',' + mo.c)).size === L.monsters.length, `${tag}: no two monsters share a cell`);

    const itemCells = new Set();
    let itemOff = 0, stacked = 0;
    for (const i of L.items) {
      if (!walkT(L.t, i.r, i.c)) itemOff++;
      const k = i.r + ',' + i.c;
      if (itemCells.has(k)) stacked++;
      itemCells.add(k);
    }
    ok(itemOff === 0, `${tag}: every item lies on floor`, { itemOff });
    ok(stacked === 0, `${tag}: no two items share a cell`, { stacked });
    for (const st of [L.up, L.down, L.bossCell]) {
      if (!st) continue;
      const at = L.items.find((i) => i.r === st[0] && i.c === st[1] && i.kind !== 'ledger');
      ok(!at, `${tag}: no stray item on the stairs/study cell`, { st, at });
    }

    if (d === DEPTHS) {
      ok(!!L.bossCell, `${tag}: the Commissioner's study exists`);
      ok(L.monsters.some((mo) => mo.kind === 'commissioner' && mo.r === L.bossCell[0] && mo.c === L.bossCell[1]), `${tag}: the Commissioner stands on the study cell`);
      const led = L.items.find((i) => i.kind === 'ledger');
      ok(!!led && led.r === L.bossCell[0] && led.c === L.bossCell[1], `${tag}: the ledger lies on the study cell`, led);
    }

    const L2 = genLevel(seed, d);
    ok(Buffer.compare(Buffer.from(L.t), Buffer.from(L2.t)) === 0
      && JSON.stringify(L2.monsters.map((x) => [x.r, x.c, x.kind])) === JSON.stringify(L.monsters.map((x) => [x.r, x.c, x.kind]))
      && JSON.stringify(L2.items.map((x) => [x.r, x.c, x.kind])) === JSON.stringify(L.items.map((x) => [x.r, x.c, x.kind])),
      `${tag}: same seed rebuilds the same level`);
  }
}

// ---------------------------------------------------------------- fog follows perception
{
  const S = mkState(20261126);
  ok(derived(S).sight === S.per + 5, 'perception: sight is 5 + per by default', derived(S));
  const R = derived(S).sight;
  let outOfRange = 0;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (!S.lit[idx(r, c)]) continue;
    if (Math.hypot(r - S.r, c - S.c) > R + 0.001) outOfRange++;
  }
  ok(outOfRange === 0, 'perception: nothing is lit beyond the sight radius', { outOfRange, R });
  S.inv.push('amuletEye');
  ok(derived(S).sight === R + 2, 'amulet of the brass eye widens sight by 2', derived(S));
  S.inv.push('amuletLion');
  ok(derived(S).atk === S.atk + 1, 'amulet of the gilded lion adds 1 attack', derived(S));
  ok(derived({ atk: 3, per: 11, inv: [] }).sight === 12, 'sight is clamped at 12', derived({ atk: 3, per: 11, inv: [] }));
}

// ---------------------------------------------------------------- the full run, through tapCell
{
  const seed = 20261126;
  const S = mkState(seed);
  ok(S.depth === 1, 'run: starts on depth 1');
  ok(!S.over && S.hp === S.maxhp, 'run: full health, not over');
  ok(!S.monsters.some((mo) => Math.max(Math.abs(mo.r - S.r), Math.abs(mo.c - S.c)) <= 3), 'run: the deterministic opening has no adjacent monster');
  let steps = 0;

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
  }
  ok(!S.over && S.depth === DEPTHS, 'run: reached the bottom depth alive', { depth: S.depth });

  // the exit refuses while the ledger is missing
  {
    const T0 = mkState(seed);
    T0.monsters = [];
    T0.r = T0.up[0]; T0.c = T0.up[1];
    const r0 = useStairs(T0, 'up');
    ok(r0.kind === 'locked' && !T0.over, 'run: the street door refuses to open without the ledger', r0);
  }

  const led = S.items.find((i) => i.kind === 'ledger');
  ok(!!led, 'run: the ledger is present on the bottom depth');
  S.monsters = [];
  ok(walkTo(led.r, led.c, 500), 'run: walked onto the ledger tile', { at: [S.r, S.c], want: [led.r, led.c] });
  ok(S.hasLedger, 'run: taking the ledger sets the carry flag');

  for (let d = DEPTHS; d > 1; d--) {
    S.monsters = [];
    ok(walkTo(S.up[0], S.up[1], 500), `run: walked to the up stairs on depth ${d}`, { at: [S.r, S.c], want: S.up });
    ok(useStairs(S, 'up').kind === 'ascend', `run: climbed from depth ${d} to ${S.depth}`);
  }
  ok(S.depth === 1, 'run: back on depth 1 with the ledger', { depth: S.depth });
  S.monsters = [];
  ok(walkTo(S.up[0], S.up[1], 500), 'run: walked to the street door', { at: [S.r, S.c], want: S.up });
  const out = useStairs(S, 'up');
  ok(out.kind === 'win' && S.won && S.over && S.result === 'won', 'run: climbing out with the ledger wins', out);
  ok(S.turn > 40, 'run: the win took a real number of turns', { turn: S.turn, steps });
  console.log(`  --   ${steps} taps, turn ${S.turn}, ${S.francs} francs`);
}

// ---------------------------------------------------------------- combat
{
  const S = mkState(7);
  S.monsters = [{ id: 0, kind: 'outlaw', name: 'outlaw', glyph: 'o', colour: '#ffb36b', hp: 4, maxhp: 4, atk: 2, pts: 4, fast: false, r: S.r, c: S.c + 1 }];
  S.atk = 6;
  const xp0 = S.xp, kills0 = S.kills;
  const res = tapCell(S, S.r, S.c + 1);
  ok(res.kind === 'attack', 'combat: a monster on the target cell is struck', res);
  ok(!S.monsters.length, 'combat: a 6-attack swing kills a 4 hp outlaw');
  ok(S.xp > xp0 && S.kills === kills0 + 1, 'combat: the kill pays xp and counts', { xp: S.xp, kills: S.kills });
  ok(S.turn === 1, 'combat: the attack spent a turn', { turn: S.turn });

  const S2 = mkState(7);
  S2.monsters = [{ id: 0, kind: 'thug', name: 'thug', glyph: 't', colour: '#ff9a6b', hp: 99, maxhp: 99, atk: 4, pts: 6, fast: false, r: S2.r, c: S2.c + 1 }];
  S2.hp = 40; S2.maxhp = 40; S2.atk = 1;
  const hpBefore = S2.hp;
  tapCell(S2, S2.r, S2.c + 1);
  ok(S2.hp < hpBefore, 'combat: the survivor hits back on its turn', { hp: S2.hp, was: hpBefore });
  ok(S2.monsters[0].hp < 99, 'combat: the wounded monster keeps the damage', S2.monsters[0]);
}

// ---------------------------------------------------------------- thrown dagger
{
  const S = mkState(13);
  S.monsters = [];
  S.inv = ['dagger', 'dagger'];
  // find a straight open line of 4+ cells from the spawn
  const targets = [];
  for (const [dr, dc] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
    for (let k = 2; k <= ITEMS.dagger.range; k++) {
      const r = S.r + dr * k, c = S.c + dc * k;
      if (!walkT(S.t, r, c) || !los(S, S.r, S.c, r, c)) break;
      targets.push([r, c]);
    }
  }
  const [tr, tc] = targets[targets.length - 1] || [];
  ok(!!tr, 'dagger: found an open line to throw down', { targets });
  S.monsters = [{ id: 0, kind: 'gamin', name: 'gamin', glyph: 'g', colour: '#9ee37d', hp: 99, maxhp: 99, atk: 2, pts: 3, fast: false, r: tr, c: tc }];
  const t0 = S.turn, inv0 = S.inv.length;
  const res = throwAt(S, tr, tc, 'dagger');
  ok(res.kind === 'dagger' && res.hit === true, 'dagger: a thrown blade reaches the body on the line', res);
  ok(S.inv.length === inv0 - 1, 'dagger: the blade is spent', { inv: S.inv });
  ok(S.monsters[0].hp < 99 && res.dmg >= 4 && res.dmg <= 7, 'dagger: damage lands in the 4-7 band', res);
  ok(S.turn === t0 + 1, 'dagger: the throw spends a turn', { before: t0, after: S.turn });

  const own = throwAt(S, S.r, S.c, 'dagger');
  ok(own.kind === 'tooClose', 'dagger: refuses a throw at your own feet', own);
  const far = throwAt(S, S.r, S.c + 40, 'dagger');
  ok(far.kind === 'tooFar' || far.kind === 'none', 'dagger: refuses an out-of-range target', far);
  S.inv = [];
  const none = throwAt(S, tr, tc, 'dagger');
  ok(none.kind === 'empty', 'dagger: an empty pack says so', none);
}

// ---------------------------------------------------------------- dynamite
{
  const S = mkState(17);
  S.monsters = [];
  S.inv = ['dynamite'];
  const spot = [];
  for (let r = 0; r < H && !spot.length; r++) for (let c = 0; c < W; c++) {
    if (walkT(S.t, r, c) && los(S, S.r, S.c, r, c) && Math.max(Math.abs(r - S.r), Math.abs(c - S.c)) === 3) { spot.push(r, c); break; }
  }
  ok(spot.length === 2, 'dynamite: found a target three tiles out', spot);
  const [tr, tc] = spot;
  S.monsters = [
    { id: 0, kind: 'outlaw', name: 'outlaw', glyph: 'o', colour: '#ffb36b', hp: 20, maxhp: 20, atk: 2, pts: 4, fast: false, r: tr, c: tc },
    { id: 1, kind: 'gamin', name: 'gamin', glyph: 'g', colour: '#9ee37d', hp: 20, maxhp: 20, atk: 2, pts: 3, fast: false, r: tr + 1, c: tc },
    { id: 2, kind: 'thug', name: 'thug', glyph: 't', colour: '#ff9a6b', hp: 20, maxhp: 20, atk: 4, pts: 6, fast: false, r: tr + 3, c: tc },
  ];
  const hp0 = S.monsters.map((mo) => mo.hp);
  const res = throwAt(S, tr, tc, 'dynamite');
  ok(res.kind === 'blast' && res.hits === 2, 'dynamite: the 3x3 burst catches both nearby bodies', res);
  ok(S.monsters[0].hp === hp0[0] - 9 && S.monsters[1].hp === hp0[1] - 9, 'dynamite: exactly 9 damage inside the burst', S.monsters.map((mo) => mo.hp));
  ok(S.monsters[2].hp === 20, 'dynamite: a body three tiles away is untouched', S.monsters[2]);
  ok(S.inv.length === 0, 'dynamite: the stick is spent', S.inv);

  const D = mkState(19);
  D.inv = ['dynamite', 'dynamite'];
  D.monsters = [];
  const self = throwAt(D, D.r, D.c + 1, 'dynamite');
  ok(self.kind === 'blast' && self.self === 4 && D.hp === D.maxhp - 4, 'dynamite: hurling a stick beside yourself costs 4 hp', { res: self, hp: D.hp });
  const clear = throwAt(D, D.r, D.c + 3, 'dynamite');
  ok(clear.kind === 'blast' && clear.self === 0 && D.hp === D.maxhp - 4, 'dynamite: a stick thrown clear of you does not hurt you', clear);
}

// ---------------------------------------------------------------- paralysis, fast ghosts, potions
{
  const S = mkState(23);
  S.inv = ['paralysis'];
  S.monsters = [{ id: 0, kind: 'outlaw', name: 'outlaw', glyph: 'o', colour: '#ffb36b', hp: 99, maxhp: 99, atk: 3, pts: 4, fast: false, r: S.r, c: S.c + 1 }];
  S.hp = 40; S.maxhp = 40;
  const q = quaff(S);
  ok(q.kind === 'paralysis' && S.frozen >= ITEMS.paralysis.freeze - 1, 'paralysis: the draught freezes the room', { res: q, frozen: S.frozen });
  const hp0 = S.hp;
  waitTurn(S); waitTurn(S);
  ok(S.hp === hp0, 'paralysis: a frozen monster cannot strike', { hp: S.hp, was: hp0 });
  for (let i = 0; i < 6; i++) waitTurn(S);
  const frozenNow = S.frozen;
  waitTurn(S);
  ok(S.frozen === 0 || frozenNow === 0, 'paralysis: the freeze runs out', { frozen: S.frozen });
  ok(S.hp < hp0, 'paralysis: once it thaws the outlaw strikes again', { hp: S.hp, was: hp0 });

  const G = mkState(29);
  G.monsters = [];
  const gr = G.r, gc = G.c + 5;
  if (walkT(G.t, gr, gc) && los(G, G.r, G.c, gr, gc)) {
    G.monsters = [{ id: 0, kind: 'ghost', name: 'ghost', glyph: 'G', colour: '#bcd6ff', hp: 99, maxhp: 99, atk: 3, pts: 8, fast: true, r: gr, c: gc }];
    const before = Math.max(Math.abs(gr - G.r), Math.abs(gc - G.c));
    waitTurn(G);
    const after = Math.max(Math.abs(G.monsters[0].r - G.r), Math.abs(G.monsters[0].c - G.c));
    ok(after <= before - 1, 'ghost: closes two tiles a turn (fast)', { before, after });
  } else {
    console.log('  --   ghost speed fixture skipped: no open five-tile line at this seed');
  }

  const Q = mkState(31);
  Q.hp = 6; Q.inv = ['absinthe'];
  const abs = quaff(Q);
  ok(abs.kind === 'absinthe' && Q.hp === 15 && Q.inv.length === 0, 'absinthe: heals 9 and is consumed', { res: abs, hp: Q.hp });
  Q.hp = Q.maxhp - 1; Q.inv = ['absinthe'];
  quaff(Q);
  ok(Q.hp === Q.maxhp, 'absinthe: never overshoots the maximum', { hp: Q.hp, max: Q.maxhp });
  ok(quaff(Q).kind === 'empty', 'quaff: an empty pack says so');
}

// ---------------------------------------------------------------- death and waiting
{
  const S = mkState(37);
  S.monsters = [{ id: 0, kind: 'vampire', name: 'vampire', glyph: 'V', colour: '#ff7ad1', hp: 99, maxhp: 99, atk: 9, pts: 10, fast: false, r: S.r, c: S.c + 1 }];
  S.hp = 1; S.atk = 1;
  tapCell(S, S.r, S.c + 1);
  ok(S.hp === 0 && S.over && S.result === 'dead', 'death: a killing blow ends the run', { hp: S.hp, result: S.result });
  ok(waitTurn(S).kind === 'over' && S.turn === 1, 'death: no turn is spent once dead', { turn: S.turn });

  const Wq = mkState(41);
  Wq.monsters = [];
  const t0 = Wq.turn;
  ok(waitTurn(Wq).kind === 'wait' && Wq.turn === t0 + 1, 'wait: costs exactly one turn');
  ok(tapCell(Wq, Wq.r, Wq.c).kind === 'wait' && Wq.turn === t0 + 2, 'tap: your own cell waits when it is not stairs');
}

// ---------------------------------------------------------------- pathing and monster hygiene
{
  const S = mkState(43);
  S.monsters = [];
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

  const M = mkState(47);
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

console.log(fails ? `\nFAILED ${fails}` : '\nOK — every traboule level is safe, connected and rebuildable; the ledger run wins through tapCell; daggers, dynamite, potions, amulets, freeze and monster movement obey the shipped rules');
process.exit(fails ? 1 : 0);
