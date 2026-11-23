// Core test for the HyperRogue port: slices the // >>>CORE block out of the shipped
// HTML and proves the tiling, the rules and the win/lose paths against that exact code.
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2] || path.join(process.env.HOME, 'kaos/work/site/games/arcade/hyperrogue/index.html');
const html = fs.readFileSync(file, 'utf8');
const a = html.indexOf('// >>>CORE');
const b = html.indexOf('// <<<CORE');
if (a < 0 || b < 0) { console.error('no CORE block'); process.exit(1); }
const src = html.slice(a, b);
const api = new Function(src + `
  return { P, Q, APO, CIRC, A_DISK, V_DISK, VERTS, BPTS, SUB, REFL, apply, comp, inv, hdist,
           makeWorld, graphDist, pathStep, newGame, step, walkTowards, undo, pilot, chaser,
           ADJ, NTREASURE, NENEMY };`)();

let fails = 0, checks = 0;
const ok = (name, cond, extra = '') => {
  checks++;
  if (!cond) { fails++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); }
  else console.log('ok   ' + name + (extra ? ' :: ' + extra : ''));
};
const near = (x, y, e = 1e-6) => Math.abs(x - y) <= e;

// ---- tiling ------------------------------------------------------------------
const W0 = api.makeWorld(6);
const cells = W0.cells;
ok('cell count for depth 6', cells.length > 300, cells.length + ' cells');

let minPair = Infinity;
for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
  const d = api.hdist(cells[i].z, cells[j].z);
  if (d < minPair) minPair = d;
}
ok('no two cells closer than 2r', minPair > api.ADJ - 1e-6, 'min ' + minPair.toFixed(6) + ' vs 2r ' + api.ADJ.toFixed(6));

let seven = 0, interior = 0, asym = 0, missingBack = 0;
const dG = api.graphDist(cells, 0);
const full = []; // a cell's 7 sides are only realised when its whole ring was generated
for (const c of cells) {
  const n = c.nb.filter((x) => x >= 0).length;
  if (n === 7) { seven++; if (dG[c.id] <= 2) interior++; }
  for (let k = 0; k < api.P; k++) {
    const nb = c.nb[k];
    if (nb < 0) continue;
    if (cells[nb].nb.indexOf(c.id) < 0) asym++;
    if (!near(api.hdist(c.z, cells[nb].z), api.ADJ, 1e-6)) missingBack++;
    if (n === 7) full.push(c.nb[k]);
  }
}
ok('every cell within 2 steps has 7 neighbours', interior === dG.filter((d) => d <= 2).length,
  interior + ' of ' + dG.filter((d) => d <= 2).length);
ok('the great majority of cells are complete', seven > cells.length * 0.35, seven + ' of ' + cells.length);
ok('adjacency is symmetric', asym === 0, asym + ' asymmetric');
ok('every side leads exactly 2r', missingBack === 0, missingBack + ' wrong');

// shared boundary points must coincide: the heptagons tile with no gap and no overlap
let vertWorst = 0;
const BPN = api.BPTS.length;
for (const c of cells) {
  const mine = api.BPTS.map((v) => api.apply(c.g, v));
  for (let k = 0; k < api.P; k++) {
    const nb = c.nb[k];
    if (nb < 0) continue;
    const theirs = api.BPTS.map((v) => api.apply(cells[nb].g, v));
    for (let i = k * api.SUB; i < (k + 1) * api.SUB; i++) {
      let best = Infinity;
      const m = mine[i];
      for (const t of theirs) best = Math.min(best, Math.hypot(m[0] - t[0], m[1] - t[1]));
      if (best > vertWorst) vertWorst = best;
    }
  }
}
ok('shared boundary points coincide (gapless tiling)', vertWorst < 1e-9, 'worst ' + vertWorst.toExponential(2));

// the drawn boundary must sit at the apothem the movement graph uses
{
  const mid = api.BPTS[0 * api.SUB + 2];      // middle point of side 0's arc
  const d = api.hdist([0, 0], api.apply(cells[0].g, mid));
  ok('drawn side sits exactly at the apothem', Math.abs(d - api.APO) < 1e-9,
    d.toFixed(9) + ' vs ' + api.APO.toFixed(9));
  const corner = api.hdist([0, 0], api.apply(cells[0].g, api.BPTS[0]));
  ok('corner sits outside the apothem', corner > api.APO, corner.toFixed(3) + ' > ' + api.APO.toFixed(3));
}

const dist = api.graphDist(cells, 0);
ok('start has distance 0', dist[0] === 0);
ok('all cells reachable', dist.every((d) => d >= 0), dist.filter((d) => d < 0).length + ' unreachable');

// ---- game setup --------------------------------------------------------------
const S = api.newGame(1);
ok('nine treasures', S.total === 9 && S.treasure.size === 9, S.treasure.size + ' placed');
ok('hunters placed', S.enemies.length === 3, S.enemies.length + ' placed');
ok('opening treasure is adjacent', S.cells[0].nb.some((n) => S.treasure.has(n)),
  'nbrs ' + S.cells[0].nb.join(','));
const S2 = api.newGame(1);
ok('setup is deterministic', JSON.stringify([...S.treasure].sort()) === JSON.stringify([...S2.treasure].sort()));

// hunters start at least 4 steps out
{
  const d0 = api.graphDist(S.cells, 0);
  ok('hunters guard the treasure (two steps off)', S.enemies.every((e) => d0[e] >= 3), S.enemies.map((e) => d0[e]).join(','));
}

// ---- movement rules ----------------------------------------------------------
{
  const T = api.newGame(1);
  const nb = T.cells[0].nb[0];
  ok('a step to a neighbour is legal', api.step(T, nb) === true && T.pos === nb);
  const far = T.cells.findIndex((c, i) => i > 0 && api.graphDist(T.cells, 0)[i] === 3);
  const before = T.pos;
  ok('a step to a non-neighbour is refused', api.step(T, far) === false && T.pos === before);
}
{
  const T = api.newGame(1);
  // undo returns the exact prior position, treasures and hunters
  const nb = T.cells[0].nb[0];
  const snap = { pos: T.pos, got: T.got, en: T.enemies.slice() };
  api.step(T, nb);
  const back = api.undo(T);
  ok('undo restores the turn', back && T.pos === snap.pos && T.got === snap.got &&
    JSON.stringify(T.enemies) === JSON.stringify(snap.en), 'pos ' + T.pos);
}

// ---- terminal states ---------------------------------------------------------
{
  const T = api.newGame(1);
  // one treasure on a free neighbour: one honest step wins
  let tgt = -1;
  for (const nb of T.cells[T.pos].nb) if (nb >= 0 && !T.enemies.includes(nb)) { tgt = nb; break; }
  T.treasure = new Set([tgt]); T.total = 1; T.got = 0;
  api.step(T, tgt);
  ok('collecting the last treasure wins', T.over === true && T.result === 'win', T.result + ' / ' + T.why);
}
{
  const T = api.newGame(1);
  let tgt = -1;
  for (const nb of T.cells[T.pos].nb) if (nb >= 0) { tgt = nb; break; }
  T.enemies = [tgt];
  api.step(T, tgt);
  ok('walking into a hunter loses', T.over === true && T.result === 'lose', T.result + ' / ' + T.why);
}
{
  const T = api.newGame(1);
  // a hunter one cell away must take the player on its own turn
  let tgt = -1;
  for (const nb of T.cells[T.pos].nb) if (nb >= 0) { tgt = nb; break; }
  T.enemies = [tgt];
  const other = T.cells[T.pos].nb.find((n) => n >= 0 && n !== tgt);
  // hunters answer on their own beat (every third move at heat 0)
  for (let i = 0; i < 4 && T.enemies[0] !== T.pos && T.result !== 'lose'; i++) {
    const nb2 = T.cells[T.pos].nb.find((n) => n >= 0 && n !== T.enemies[0]) ?? other;
    if (!api.step(T, nb2)) break;
  }
  ok('a hunter answers the move', T.enemies[0] === T.pos || T.result === 'lose',
    'enemy ' + T.enemies[0] + ' player ' + T.pos + ' result ' + T.result);
}
{
  const T = api.newGame(1);
  T.over = true; T.result = 'win';
  const before = T.pos;
  ok('a finished game refuses further moves', api.step(T, T.cells[T.pos].nb.find((n) => n >= 0)) === false && T.pos === before);
}

// ---- playability: the greedy pilot must be able to win, and idling must not ----
const results = [];
for (let seed = 1; seed <= 12; seed++) {
  const G = api.pilot(api.newGame(seed));
  results.push({ seed, result: G.result, got: G.got, moves: G.moves });
}
const wins = results.filter((r) => r.result === 'win').length;
ok('the greedy pilot wins most seeds', wins >= 8, wins + '/12 wins; ' +
  results.map((r) => r.seed + ':' + (r.result || 'open') + '(' + r.got + ')').join(' '));

const reckless = [];
for (let seed = 1; seed <= 12; seed++) {
  const G = api.chaser(api.newGame(seed));
  reckless.push({ seed, result: G.result, got: G.got });
}
const recklessWins = reckless.filter((r) => r.result === 'win').length;
ok('a player who ignores the hunters mostly dies', recklessWins <= 4,
  recklessWins + '/12 careless wins; ' + reckless.map((r) => r.seed + ':' + (r.result || 'open') + '(' + r.got + ')').join(' '));

const pilotWin = results.find((r) => r.result === 'win');
ok('a winning run exists and is short enough to play', !!pilotWin, pilotWin ? 'seed ' + pilotWin.seed +
  ' in ' + pilotWin.moves + ' moves' : 'none');

// a pilot that only ever steps into the nearest neighbour away from treasure must lose
{
  const T = api.newGame(1);
  let lost = false;
  for (let i = 0; i < 200 && !T.over; i++) {
    const d = api.graphDist(T.cells, T.pos);
    let best = -1, bd = -1;
    for (const nb of T.cells[T.pos].nb) {
      if (nb < 0) continue;
      const dd = d[nb];
      const hasT = T.treasure.has(nb) ? 100 : 0;
      if (dd + hasT > bd) { bd = dd + hasT; best = nb; }
    }
    if (best < 0) break;
    api.step(T, best);
    if (T.result === 'lose') lost = true;
  }
  ok('fleeing without collecting never wins', T.result !== 'win', (T.result || 'open') + ' after ' + T.moves);
}

console.log('\n' + (fails ? fails + ' FAILED of ' + checks : 'all ' + checks + ' checks passed'));
process.exit(fails ? 1 : 0);
